import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import type { AgentKind } from '../agent/types.ts';
import type { FileBatch, FileTranscriptSource, TranscriptFile, TranscriptSink } from '../agent/types.ts';
import { IndexerService } from './service.ts';

// ファイル型のトランスクリプトを 2 つ以上受ける道（段 A の A5）。
// 2 つ目は試験用の偽物で、索引に入る論理パス（.jsonl）と、実際にある物理パス（.jsonl.zst）が違う。
const FAKE_SESSION = 'fake-session-1';
const FAKE_AGENT: AgentKind = 'opencode';
const BODY = '{"fake":"line"}\n';

let dir: string;
let fakeDir: string;
let db: Db;
beforeEach(() => { dir = copyFixtureClaudeDir(); fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fake-files-')); db = openDb(':memory:'); });
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fakeDir, { recursive: true, force: true });
});

type Calls = { sink: TranscriptSink | null; started: number; stopped: number; scans: number; isIndexedSeen: boolean[] };

/** 論理パスは .jsonl、実体は .jsonl.zst（圧縮された rollout を模す）。2 回目以降の読みは 0 行で終わる。 */
function fakeSource(o: { enabled?: () => boolean } = {}): { source: FileTranscriptSource; calls: Calls; logical: string; physical: string } {
  const logical = path.join(fakeDir, 'rollout-1.jsonl');
  const physical = `${logical}.zst`;
  fs.writeFileSync(physical, 'zst-bytes-not-really');
  const file: TranscriptFile = { path: logical, sessionId: FAKE_SESSION, agentId: null, deviceId: null };
  const calls: Calls = { sink: null, started: 0, stopped: 0, scans: 0, isIndexedSeen: [] };
  const stat = (p: string) => { try { const s = fs.statSync(p === logical ? physical : p); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } };
  const source: FileTranscriptSource = {
    agent: FAKE_AGENT,
    start(sink) { calls.sink = sink; calls.started++; },
    stop() { calls.stopped++; },
    readPage: (_db, sessionId) => ({ sessionId, events: [], total: 0, nextSeq: null }),
    ...(o.enabled ? { enabled: o.enabled } : {}),
    read(f, from): FileBatch {
      const first = from === 0;
      return {
        agent: FAKE_AGENT, providerSessionId: f.sessionId, agentId: null, cwd: '/work/fake', reset: first,
        records: first ? [{ events: [{ kind: 'user', seq: 0, ts: 1000, text: 'hello from the fake' }], facts: { isUserTurn: true, cwd: '/work/fake', ts: 1000 }, locator: { kind: 'file', path: f.path, offset: 0, length: BODY.length }, typedPrompt: true }] : [],
        nextByte: first ? BODY.length : from, badLines: 0,
      };
    },
    scan(scanOpts) {
      calls.scans++;
      calls.isIndexedSeen.push(scanOpts.isIndexed?.(logical) ?? false);
      if (o.enabled && !o.enabled()) return { index: [], drop: [], stats: new Map(), seen: null };
      return { index: [file], drop: [], stats: new Map([[logical, stat(logical)]]), seen: new Set([logical]) };
    },
    pick: (f) => ({ index: [f], drop: [], stats: new Map([[f.path, stat(f.path)]]), lost: false }),
    liveFiles: (id) => (id === FAKE_SESSION ? [file] : []),
    stat,
    history: () => ({ index: new Map(), version: 0 }),
    rewatch() {},
    healthy: () => true,
    where: { scan: 'fake-scan', history: 'fake-history' },
  };
  return { source, calls, logical, physical };
}

const make = (sources: FileTranscriptSource[], extra: Partial<ConstructorParameters<typeof IndexerService>[0]> = {}) =>
  new IndexerService({ db, deviceId: 'd', transcripts: sources, isRunning: () => false, ...extra });
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;

describe('IndexerService（ファイル型を複数）', () => {
  it('Claude と偽物の両方の会話が索引に入り、行の provider と transcript_files の agent が分かれる', async () => {
    const fake = fakeSource();
    const svc = make([claudeTranscriptSource({ claudeDir: dir }), fake.source]);
    await svc.fullScan();
    expect(count("select count(*) c from sessions where provider = 'claude-code' and provider_session_id = ?", SESSION_ALPHA)).toBe(1);
    const row = db.prepare('select t.path, t.agent, s.provider from transcript_files t join sessions s on s.id = t.session_id where s.provider_session_id = ?').get(FAKE_SESSION) as { path: string; agent: string; provider: string };
    expect(row).toEqual({ path: fake.logical, agent: FAKE_AGENT, provider: FAKE_AGENT });
    expect(count("select count(*) c from transcript_files where agent = 'claude-code'")).toBe(3);
    expect(count('select count(*) c from event_index e join sessions s on s.id = e.session_id where s.provider_session_id = ? and e.file_path_ref = ?', FAKE_SESSION, fake.logical)).toBe(1);
  });

  it('論理パスと物理パスが違っても、実体が変わって読みが 0 行で終わるとき、索引は変わらず、消されもしない', async () => {
    const fake = fakeSource();
    const svc = make([claudeTranscriptSource({ claudeDir: dir }), fake.source]);
    await svc.fullScan();
    const events = () => count('select count(*) c from event_index where file_path_ref = ?', fake.logical);
    expect(events()).toBe(1);
    // 圧縮し直した（物理の大きさと更新時刻が変わった）。
    fs.writeFileSync(fake.physical, 'zst-bytes-recompressed-longer');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(fake.physical, t, t);
    const before = db.prepare('select size, mtime, indexed_bytes from transcript_files where path = ?').get(fake.logical) as { size: number; mtime: number; indexed_bytes: number };
    await svc.fullScan();
    const after = db.prepare('select size, mtime, indexed_bytes from transcript_files where path = ?').get(fake.logical) as { size: number; mtime: number; indexed_bytes: number };
    expect(events()).toBe(1);
    expect(after.indexed_bytes).toBe(before.indexed_bytes);
    expect(after.size).not.toBe(before.size);
    expect(count('select count(*) c from transcript_files where path = ?', fake.logical)).toBe(1);
  });

  it('論理パスが無く物理パスもなくなれば、その source の行だけが索引から消える（Claude の行は残る）', async () => {
    const fake = fakeSource();
    const svc = make([claudeTranscriptSource({ claudeDir: dir }), fake.source]);
    await svc.fullScan();
    fs.rmSync(fake.physical);
    // 置き場そのものは見える（seen に無い）ものとして、列挙から外れた場合を作る。
    const scan = fake.source.scan.bind(fake.source);
    fake.source.scan = (o) => ({ ...scan(o), index: [], seen: new Set<string>() });
    await svc.fullScan();
    expect(count('select count(*) c from transcript_files where path = ?', fake.logical)).toBe(0);
    expect(count("select count(*) c from transcript_files where agent = 'claude-code'")).toBe(3);
  });

  it('start と stop は全部の source に届き、監視の通知は出どころの source で読まれる', async () => {
    const fake = fakeSource();
    const svc = make([claudeTranscriptSource({ claudeDir: dir }), fake.source], { debounceMs: 0 });
    await svc.start();
    expect(fake.calls.started).toBe(1);
    // 通知は、索引化の前に scan が見ていない新しい論理パスでも、偽物の source の読み手で読む。
    const newFile: TranscriptFile = { path: path.join(fakeDir, 'rollout-2.jsonl'), sessionId: 'fake-session-2', agentId: null, deviceId: null };
    fs.writeFileSync(`${newFile.path}.zst`, 'zst2');
    fake.source.pick = (f) => ({ index: [f], drop: [], stats: new Map([[f.path, fake.source.stat!(f.path)]]), lost: false });
    const origStat = fake.source.stat!;
    fake.source.stat = (p) => origStat(p === newFile.path ? `${p}.zst` : p);
    fake.calls.sink!.named(newFile);
    await new Promise((r) => setTimeout(r, 400));
    await svc.settled();
    svc.stop();
    expect(fake.calls.stopped).toBe(1);
    expect(count("select count(*) c from sessions where provider = ? and provider_session_id = 'fake-session-2'", FAKE_AGENT)).toBe(1);
  });

  it('scan に isIndexed を渡す。索引済みの論理パスには真を返す', async () => {
    const fake = fakeSource();
    const svc = make([fake.source]);
    await svc.fullScan();
    await svc.fullScan();
    expect(fake.calls.isIndexedSeen).toEqual([false, true]);
  });

  it('enabled が偽の source は scan が空で seen が null のとき、既存の索引を消さない', async () => {
    let on = true;
    const fake = fakeSource({ enabled: () => on });
    const svc = make([fake.source]);
    await svc.fullScan();
    expect(count('select count(*) c from transcript_files')).toBe(1);
    on = false;
    await svc.fullScan();
    expect(count('select count(*) c from transcript_files')).toBe(1);
  });

  it('healthy は全部の source が真のときだけ真で、本文なしの登録は source ごとの agent で作る', () => {
    const a = fakeSource();
    const b = fakeSource();
    b.source.healthy = () => false;
    const svc = make([a.source, b.source]);
    expect(svc.healthy()).toBe(false);
    const ok = make([a.source]);
    expect(ok.healthy()).toBe(true);
  });

  it('実行中の会話の本文は、agent が合う source だけが答える', async () => {
    const fake = fakeSource();
    const svc = make([claudeTranscriptSource({ claudeDir: dir }), fake.source], { liveSessions: () => [{ sessionId: FAKE_SESSION, cwd: '/work/fake', agent: FAKE_AGENT }], liveMs: 1 });
    await svc.fullScan();
    fs.writeFileSync(fake.physical, 'zst-bytes-changed-now');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(fake.physical, t, t);
    const before = (db.prepare('select size from transcript_files where path = ?').get(fake.logical) as { size: number }).size;
    // 実行中の会話の見張り（checkLive）を直接 1 回回す。
    (svc as unknown as { checkLive(): void }).checkLive();
    const after = (db.prepare('select size from transcript_files where path = ?').get(fake.logical) as { size: number }).size;
    expect(after).not.toBe(before);
  });
});
