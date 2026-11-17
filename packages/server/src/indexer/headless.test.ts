import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { getSession, isHeadlessSql, listSessions } from '../db/queries.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { IndexerService } from './service.ts';
import { backfillHeadless, entrypointKind, probeHeadless } from './headless.ts';

// 非対話の会話（claude -p などで走ったバッチ）の印。
// 本文の各行の entrypoint が sdk- で始まるもの（sdk-cli、sdk-ts、sdk-py）だけで、対話の entrypoint（cli など）が 1 つも無い会話に付く。

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-headless-'));
  fs.mkdirSync(path.join(dir, 'projects', '-w-batch'), { recursive: true });
  db = openDb(':memory:');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const PSID_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const PSID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const TS = '2026-11-10T04:49:50.966Z';
const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
const user = (psid: string, text: string, uuid: string, entrypoint?: string) =>
  line({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp: TS, cwd: '/w/batch', sessionId: psid, userType: 'external', ...(entrypoint ? { entrypoint } : {}) });
const owner = (psid: string) => line({ type: 'session-owner', accountUuid: 'x', sessionId: psid });
const fileOf = (psid: string) => path.join(dir, 'projects', '-w-batch', `${psid}.jsonl`);
const write = (psid: string, body: string) => fs.writeFileSync(fileOf(psid), body);
const append = (psid: string, body: string) => fs.appendFileSync(fileOf(psid), body);
const svc = () => new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), isRunning: () => false });
const mark = (psid: string) => (db.prepare('select st.headless h from session_stats st join sessions s on s.id = st.session_id where s.provider_session_id = ?').get(psid) as { h: number | null } | undefined)?.h;
const idOf = (psid: string) => (db.prepare('select id from sessions where provider_session_id = ?').get(psid) as { id: string }).id;

describe('entrypointKind', () => {
  it('sdk- で始まるものは非対話、ほかの値は対話、無ければ分からない', () => {
    expect(entrypointKind('sdk-cli')).toBe('headless');
    expect(entrypointKind('sdk-ts')).toBe('headless');
    expect(entrypointKind('cli')).toBe('interactive');
    expect(entrypointKind('claude-vscode')).toBe('interactive');
    expect(entrypointKind(undefined)).toBeNull();
    expect(entrypointKind('')).toBeNull();
  });
});

describe('索引の印', () => {
  it('sdk-cli だけの会話に 1、cli の会話に 0 を付ける', async () => {
    write(PSID_A, owner(PSID_A) + user(PSID_A, '分類して', 'u1', 'sdk-cli'));
    write(PSID_B, user(PSID_B, 'こんにちは', 'u2', 'cli'));
    await svc().fullScan();
    expect(mark(PSID_A)).toBe(1);
    expect(mark(PSID_B)).toBe(0);
  });

  it('非対話で始まった会話を対話で再開したら、印を 0 に戻す。対話の会話は後から sdk の行が来ても 0 のまま', async () => {
    write(PSID_A, user(PSID_A, '分類して', 'u1', 'sdk-cli'));
    write(PSID_B, user(PSID_B, 'こんにちは', 'u2', 'cli'));
    const s = svc();
    await s.fullScan();
    append(PSID_A, user(PSID_A, '続けて', 'u3', 'cli'));
    append(PSID_B, user(PSID_B, '続けて', 'u4', 'sdk-cli'));
    await s.fullScan();
    expect(mark(PSID_A)).toBe(0);
    expect(mark(PSID_B)).toBe(0);
  });

  it('entrypoint の無い行だけの束では決めず、後の束で決める', async () => {
    write(PSID_A, owner(PSID_A));
    const s = svc();
    await s.fullScan();
    expect(mark(PSID_A) ?? null).toBeNull();
    append(PSID_A, user(PSID_A, '分類して', 'u1', 'sdk-cli'));
    await s.fullScan();
    expect(mark(PSID_A)).toBe(1);
  });
});

describe('既存の行の埋め戻し', () => {
  it('印の無い行は本文の先頭と末尾を読んで埋める。読めないファイルや entrypoint の無い本文は 0 にし、二度は読まない', async () => {
    write(PSID_A, owner(PSID_A) + user(PSID_A, '分類して', 'u1', 'sdk-cli'));
    write(PSID_B, user(PSID_B, 'こんにちは', 'u2'));
    await svc().fullScan();
    // 版 61 より前に索引した行を作る。
    db.prepare('update session_stats set headless = null').run();
    expect(backfillHeadless(db, 1)).toBe(1);
    expect(backfillHeadless(db, 10)).toBe(1);
    expect(backfillHeadless(db, 10)).toBe(0);
    expect(mark(PSID_A)).toBe(1);
    expect(mark(PSID_B)).toBe(0);
  });

  it('索引の start が全走査の後に埋め戻しを回す', async () => {
    write(PSID_A, owner(PSID_A) + user(PSID_A, '分類して', 'u1', 'sdk-cli'));
    const first = svc();
    await first.fullScan();
    db.prepare('update session_stats set headless = null').run();
    const s = svc();
    await s.start();
    await s.headlessBackfill;
    s.stop();
    expect(mark(PSID_A)).toBe(1);
  });

  it('probeHeadless は大きな本文でも、末尾で対話に戻った会話を対話と見る', () => {
    const pad = 'x'.repeat(400_000);
    write(PSID_A, user(PSID_A, pad, 'u1', 'sdk-cli') + user(PSID_A, pad, 'u2', 'sdk-cli') + user(PSID_A, '再開', 'u3', 'cli'));
    expect(probeHeadless(fileOf(PSID_A))).toBe(0);
    write(PSID_B, user(PSID_B, pad, 'u1', 'sdk-cli') + user(PSID_B, pad, 'u2', 'sdk-cli'));
    expect(probeHeadless(fileOf(PSID_B))).toBe(1);
    expect(probeHeadless(path.join(dir, 'missing.jsonl'))).toBe(0);
  });
});

describe('一覧から外す', () => {
  beforeEach(async () => {
    write(PSID_A, user(PSID_A, '分類して', 'u1', 'sdk-cli'));
    write(PSID_B, user(PSID_B, 'こんにちは', 'u2', 'cli'));
    await svc().fullScan();
  });

  it('既定の一覧は非対話の会話を外し、includeHeadless と ids の指定では含める。1 件で引けば印が付く', () => {
    const a = idOf(PSID_A);
    expect(listSessions(db, []).map((s) => s.providerSessionId)).toEqual([PSID_B]);
    const all = listSessions(db, [], { includeHeadless: true });
    expect(all.map((s) => s.providerSessionId).sort()).toEqual([PSID_A, PSID_B]);
    expect(all.find((s) => s.id === a)!.headless).toBe(true);
    expect('headless' in all.find((s) => s.id !== a)!).toBe(false);
    expect(listSessions(db, [], { ids: [a] }).map((s) => s.id)).toEqual([a]);
    expect(getSession(db, [], a)!.headless).toBe(true);
  });

  it('hangar の run が付いた会話は、sdk の本文でも一覧に出す', () => {
    const a = idOf(PSID_A);
    upsertShared(db, 'runs', { id: 'r1', session_id: a, device_id: 'd', kind: 'start', tmux_name: 't', launch_params: '{}', started_at: 1, heartbeat_at: 1 }, 'd');
    expect(listSessions(db, []).map((s) => s.providerSessionId).sort()).toEqual([PSID_A, PSID_B]);
    expect('headless' in getSession(db, [], a)!).toBe(false);
  });

  it('isHeadlessSql は件数の集計の条件に足せる', () => {
    const n = (db.prepare(`select count(*) c from sessions s where s.deleted_at is null and not ${isHeadlessSql('s')}`).get() as { c: number }).c;
    expect(n).toBe(1);
  });
});
