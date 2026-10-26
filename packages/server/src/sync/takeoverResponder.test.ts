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
import { CODEX_ONE_TURN, fixtureBytes } from '../../test/codexFixtures.ts';

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

describe('opencode の会話の引き継ぎ（頼まれた側）', () => {
  const SES = 'ses_e8e86939cffewIeT7kgc690PVE';
  let db: Db;
  let sessionId: string;
  let calls: string[];
  let runs: Map<string, RunDto>;
  let exportDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    sessionId = ensureSession(db, SES, '/w', SELF, 'opencode');
    calls = [];
    runs = new Map([['r1', { id: 'r1', sessionId, deviceId: SELF, kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } as RunDto]]);
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-takeover-'));
  });
  afterEach(() => { db.close(); fs.rmSync(exportDir, { recursive: true, force: true }); });

  const build = (o: { quiesce?: () => Promise<unknown> } = {}): TakeoverResponder => new TakeoverResponder({
    db, deviceId: SELF,
    runs: {
      getRun: (id) => runs.get(id) ?? null,
      kill: (id, reason) => { calls.push(`kill:${id}:${reason}`); const r = { ...runs.get(id)!, endedAt: 2, endReason: reason ?? 'killed' } as RunDto; runs.set(id, r); return r; },
    },
    // 上げる側は opencode の会話を書き出し直してから上げる（sync/uploader.ts の flushSession）。
    flushSession: async (u) => { calls.push(`flush:${u}`); fs.writeFileSync(path.join(exportDir, `${u}.json`), '{"info":{},"messages":["last"]}'); },
    pushNow: async () => { calls.push('push'); },
    notePane: (_n, t) => { calls.push(`note:${t}`); },
    deviceName: (id) => id,
    language: () => 'ja',
    sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    now: () => 5000,
    opencode: {
      quiesce: async (hangarId, providerId) => { calls.push(`quiesce:${hangarId}:${providerId}`); return o.quiesce?.(); },
      exportFile: (id) => path.join(exportDir, `${id}.json`),
    },
  });
  const ask = () => writeAsk(db, 'pc-a', { sessionId, runId: 'r1', targetDevice: SELF, mode: 'ask', now: 1000 });

  it('interrupt して idle を待ち、書き出し直して上げ、それから止める。版は書き出したファイルで答える', async () => {
    const a = ask();
    expect(await build().scan()).toBe(1);
    expect(calls).toEqual([
      'note:[hangar] pc-a に引き継がれたため、この PC の opencode を停止しました。',
      `quiesce:${sessionId}:${SES}`,
      `flush:${SES}`,
      'kill:r1:taken_over',
      'push',
    ]);
    const body = '{"info":{},"messages":["last"]}';
    expect(answerOf(db, a.id)).toMatchObject({ result: 'stopped', transcriptSha256: createHash('sha256').update(body).digest('hex'), transcriptSize: Buffer.byteLength(body) });
  });

  it('止めるのに失敗しても（idle を待てない）、書き出して上げてから止める', async () => {
    ask();
    await build({ quiesce: async () => { throw new Error('serve が応えない'); } }).scan();
    expect(calls.filter((c) => !c.startsWith('note:'))).toEqual([`quiesce:${sessionId}:${SES}`, `flush:${SES}`, 'kill:r1:taken_over', 'push']);
  });

  it('動いていなければ止めずに、opencode の台帳の版で not_running と答える', async () => {
    runs.set('r1', { ...runs.get('r1')!, endedAt: 3, endReason: 'killed' } as RunDto);
    db.prepare("insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?, 'transcript', 'p', ?, 'sha-oc', 7, 0, 1, 0)")
      .run(`opencode/${SELF}/${SES}.json.gz`, SELF);
    const a = ask();
    await build().scan();
    expect(calls).toEqual(['push']);
    expect(answerOf(db, a.id)).toMatchObject({ result: 'not_running', transcriptSha256: 'sha-oc', transcriptSize: 7 });
  });
});

describe('Codex の会話の引き継ぎ（頼まれた側）', () => {
  const THREAD = '0198a7c2-0000-7000-8000-00000000c0de';
  let db: Db;
  let sessionId: string;
  let calls: string[];
  let runs: Map<string, RunDto>;
  let dir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    sessionId = ensureSession(db, THREAD, '/w', SELF, 'codex');
    calls = [];
    runs = new Map([['r1', { id: 'r1', sessionId, deviceId: SELF, kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } as RunDto]]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cx-takeover-'));
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const build = (): TakeoverResponder => new TakeoverResponder({
    db, deviceId: SELF,
    runs: {
      getRun: (id) => runs.get(id) ?? null,
      kill: (id, reason) => { calls.push(`kill:${id}:${reason}`); const r = { ...runs.get(id)!, endedAt: 2, endReason: reason ?? 'killed' } as RunDto; runs.set(id, r); return r; },
    },
    flushSession: async (u) => { calls.push(`flush:${u}`); },
    pushNow: async () => { calls.push('push'); },
    notePane: (_n, t) => { calls.push(`note:${t}`); },
    deviceName: (id) => id,
    language: () => 'ja',
    sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    now: () => 5000,
  });
  const ask = () => writeAsk(db, 'pc-a', { sessionId, runId: 'r1', targetDevice: SELF, mode: 'ask', now: 1000 });

  it('止める前にも上げる（開始直後でまだ上がっていない会話も、止めたときの版の前に上がっている）。止めたあと 2 度上げる', async () => {
    ask();
    expect(await build().scan()).toBe(1);
    expect(calls).toEqual([
      'note:[hangar] pc-a に引き継がれたため、この PC の codex を停止しました。',
      `flush:${THREAD}`,
      'kill:r1:taken_over',
      `flush:${THREAD}`,
      `sleep:${FLUSH_AGAIN_MS}`,
      `flush:${THREAD}`,
      'push',
    ]);
  });

  it('版は止めたあとの rollout の中身で答える。.jsonl.zst なら展開した jsonl の版（上げる側の台帳と同じ形）', async () => {
    const body = fixtureBytes(CODEX_ONE_TURN.file);
    const logical = path.join(dir, `rollout-2026-10-26T14-00-00-${THREAD}.jsonl`);
    fs.writeFileSync(logical, body);
    db.prepare('insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version) values (?, ?, null, null, 1, 1, 0, 1)').run(logical, sessionId);
    const a = ask();
    await build().scan();
    const want = { result: 'stopped', transcriptSha256: createHash('sha256').update(body).digest('hex'), transcriptSize: body.length };
    expect(answerOf(db, a.id)).toMatchObject(want);
    // 圧縮された実体でも、展開した中身の版で答える。
    fs.rmSync(logical);
    fs.writeFileSync(`${logical}.zst`, fixtureBytes(`${CODEX_ONE_TURN.file}.zst`));
    runs.set('r2', { ...runs.get('r1')!, id: 'r2', endedAt: null } as RunDto);
    const b = writeAsk(db, 'pc-a', { sessionId, runId: 'r2', targetDevice: SELF, mode: 'ask', now: 2000 });
    await build().scan();
    expect(answerOf(db, b.id)).toMatchObject(want);
  });

  it('動いていなければ止めずに、Codex の台帳の版で not_running と答える', async () => {
    runs.set('r1', { ...runs.get('r1')!, endedAt: 3, endReason: 'killed' } as RunDto);
    db.prepare("insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?, 'transcript', 'p', ?, 'sha-cx', 9, 0, 1, 0)")
      .run(`codex/${SELF}/${THREAD}.jsonl.gz`, SELF);
    const a = ask();
    await build().scan();
    expect(calls).toEqual(['push']);
    expect(answerOf(db, a.id)).toMatchObject({ result: 'not_running', transcriptSha256: 'sha-cx', transcriptSize: 9 });
  });
});
