import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { FLUSH_AGAIN_MS } from './flushOnRunEnd.ts';
import { answerOf, cancelAsk, pruneTakeoverRows, writeAsk } from './takeoverRows.ts';
import { TakeoverResponder } from './takeoverResponder.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const SELF = 'pc-b';

describe('頼まれた側の応答', () => {
  let db: Db;
  let sessionId: string;
  let calls: string[];
  let notes: [string, string][];
  let runs: Map<string, RunDto>;
  let responder: TakeoverResponder;

  const run = (o: Partial<RunDto> = {}): RunDto => ({
    id: 'r1', sessionId, deviceId: SELF, kind: 'resume', tmuxName: 'hangar-r1', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1, ...o,
  } as RunDto);
  const synced = (sha: string, size: number): void => {
    db.prepare("insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?, 'transcript', 'p', ?, ?, ?, 0, 1, 0)")
      .run(`transcripts/${SELF}/${UUID}.jsonl.gz`, SELF, sha, size);
  };
  const ask = (o: Partial<Parameters<typeof writeAsk>[2]> & { from?: string } = {}) =>
    writeAsk(db, o.from ?? 'pc-a', { sessionId, runId: 'r1', targetDevice: SELF, mode: 'ask', now: 1000, ...o });
  const build = (o: { withNote?: boolean } = {}): TakeoverResponder => new TakeoverResponder({
    db, deviceId: SELF,
    runs: {
      getRun: (id) => runs.get(id) ?? null,
      kill: (id, reason) => {
        calls.push(`kill:${id}:${reason}`);
        const r = runs.get(id)!;
        const ended = { ...r, endedAt: 2, endReason: reason ?? 'killed' } as RunDto;
        runs.set(id, ended);
        return ended;
      },
    },
    flushSession: async (u) => { calls.push(`flush:${u}`); },
    pushNow: async () => { calls.push('push'); },
    ...(o.withNote === false ? {} : { notePane: (n: string, t: string) => { calls.push('note'); notes.push([n, t]); } }),
    deviceName: (id) => id,
    language: () => 'ja',
    sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    now: () => 5000,
  });

  beforeEach(() => {
    db = openDb(':memory:');
    sessionId = ensureSession(db, UUID, '/w', SELF);
    calls = []; notes = [];
    runs = new Map([['r1', run()]]);
    synced('sha-1', 42);
    responder = build();
  });
  afterEach(() => { db.close(); });

  it('宛先の生きた run を止め、2 度上げてから、上げた版で stopped と答える', async () => {
    const a = ask();
    expect(await responder.scan()).toBe(1);
    expect(calls).toEqual(['note', 'kill:r1:taken_over', `flush:${UUID}`, `sleep:${FLUSH_AGAIN_MS}`, `flush:${UUID}`, 'push']);
    expect(FLUSH_AGAIN_MS).toBe(5000);
    expect(answerOf(db, a.id)).toMatchObject({ result: 'stopped', runId: 'r1', transcriptSha256: 'sha-1', transcriptSize: 42, answeredAt: 5000 });
  });

  it('端末に残す 1 行は頼んだ PC の名前を入れる', async () => {
    ask({ from: 'pc-a' });
    await responder.scan();
    expect(notes).toEqual([['hangar-r1', '[hangar] pc-a に引き継がれたため、この PC の claude を停止しました。']]);
  });

  it('端末に知らせる口が無くても止めて答える', async () => {
    responder = build({ withNote: false });
    const a = ask();
    expect(await responder.scan()).toBe(1);
    expect(calls).toContain('kill:r1:taken_over');
    expect(answerOf(db, a.id)?.result).toBe('stopped');
  });

  it('本文を上げていない端末でも stopped と答える（版は null）', async () => {
    db.prepare('delete from file_sync').run();
    const a = ask();
    await responder.scan();
    expect(answerOf(db, a.id)).toMatchObject({ result: 'stopped', transcriptSha256: null, transcriptSize: null });
  });

  it('上げ損ねて台帳が古いままでも、止めたあとの手元の本文の版で答える', async () => {
    // flushSession は上げ損ねても黙って戻る。台帳（sha-1、42）のまま答えると、頼んだ側は最後のターンの欠けた本文で再開する。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-takeover-'));
    try {
      const body = '{"type":"user"}\n{"type":"assistant"}\n';
      const local = path.join(dir, `${UUID}.jsonl`);
      fs.writeFileSync(local, body);
      const remote = path.join(dir, 'remote.jsonl');
      fs.writeFileSync(remote, 'other\n');
      const add = db.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?, ?, null, ?, ?, ?, 0, 1)');
      add.run(local, sessionId, null, 1, 10);
      // 降ろした相手の写しは、新しくても使わない。
      add.run(remote, sessionId, 'pc-a', 6, 99);
      const a = ask();
      await responder.scan();
      expect(answerOf(db, a.id)).toMatchObject({
        result: 'stopped',
        transcriptSha256: createHash('sha256').update(body).digest('hex'),
        transcriptSize: Buffer.byteLength(body),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run がもう終わっていれば止めずに not_running と今の版で答える', async () => {
    runs.set('r1', run({ endedAt: 3, endReason: 'killed' }));
    const a = ask();
    expect(await responder.scan()).toBe(1);
    expect(calls).not.toContain('kill:r1:taken_over');
    expect(calls).not.toContain('note');
    expect(answerOf(db, a.id)).toMatchObject({ result: 'not_running', transcriptSha256: 'sha-1', transcriptSize: 42 });
    expect(calls.at(-1)).toBe('push');
  });

  it('run が無い、またはこの PC の run でなければ止めずに not_running と答える', async () => {
    runs.set('r1', run({ deviceId: 'pc-c' }));
    const a = ask();
    const b = ask({ runId: 'ghost', now: 1100 });
    expect(await responder.scan()).toBe(2);
    expect(calls.some((c) => c.startsWith('kill:'))).toBe(false);
    expect(answerOf(db, a.id)?.result).toBe('not_running');
    expect(answerOf(db, b.id)?.result).toBe('not_running');
  });

  it('同じ会話への 2 つ目の頼みには not_running を返す（先に応答を得た方が引き継ぐ）', async () => {
    const first = ask({ from: 'pc-a', now: 1000 });
    const second = ask({ from: 'pc-c', now: 1100 });
    expect(await responder.scan()).toBe(2);
    expect(calls.filter((c) => c.startsWith('kill:'))).toEqual(['kill:r1:taken_over']);
    expect(answerOf(db, first.id)?.result).toBe('stopped');
    expect(answerOf(db, second.id)).toMatchObject({ result: 'not_running', transcriptSha256: 'sha-1' });
  });

  it('取り下げた頼みとほかの PC あての頼みには答えない', async () => {
    const a = ask();
    cancelAsk(db, 'pc-a', a.id, 1500);
    ask({ targetDevice: 'pc-z', runId: 'r9', now: 1200 });
    expect(await responder.scan()).toBe(0);
    expect(calls).toEqual([]);
    expect(answerOf(db, a.id)).toBeNull();
  });

  it('答えた頼みには二度と答えない', async () => {
    ask();
    expect(await responder.scan()).toBe(1);
    expect(await responder.scan()).toBe(0);
  });

  it('並行して 2 度 scan しても、同じ頼みは 1 度しか止めない', async () => {
    ask();
    await Promise.all([responder.scan(), responder.scan()]);
    expect(calls.filter((c) => c.startsWith('kill:'))).toHaveLength(1);
  });

  it('止められなかった頼みは答えずに残し、次の scan で扱う', async () => {
    const a = ask();
    const failing = new TakeoverResponder({
      db, deviceId: SELF,
      runs: { getRun: (id) => runs.get(id) ?? null, kill: () => { throw new Error('tmux が応えない'); } },
      flushSession: async () => {}, pushNow: async () => {}, deviceName: (id) => id, language: () => 'ja', sleep: async () => {},
    });
    expect(await failing.scan()).toBe(0);
    expect(answerOf(db, a.id)).toBeNull();
    expect(await responder.scan()).toBe(1);
  });

  it('応答は宛先の PC が自分の行として書く', async () => {
    const a = ask();
    await responder.scan();
    const row = db.prepare('select origin_device d from takeover_answers where ask_id = ?').get(a.id) as { d: string };
    expect(row.d).toBe(SELF);
    expect(pruneTakeoverRows(db, SELF, 5000)).toBe(0);
  });
});
