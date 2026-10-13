import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { indexFile } from './indexFile.ts';
import { IndexerService, type IndexerServiceOptions, type WatchFn } from './service.ts';

// 索引化の回数を数えるため、中身はそのままに indexFile を包む。
vi.mock('./indexFile.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('./indexFile.ts')>();
  return { ...m, indexFile: vi.fn(m.indexFile) };
});

/** fs.watch の代わり。試験から名前を指定して通知を起こす。 */
class FakeWatch {
  readonly listeners = new Map<string, (event: string, filename: string | null) => void>();
  broken = false;
  readonly watch: WatchFn = (dir, _options, listener) => {
    if (this.broken) throw new Error('watch unavailable');
    this.listeners.set(dir, listener);
    return { close: () => { this.listeners.delete(dir); }, on: () => undefined };
  };
  emit(dir: string, name: string | null): void {
    const l = this.listeners.get(dir);
    if (!l) throw new Error(`not watched: ${dir}`);
    l('rename', name);
  }
}

// 待機中の回数を見る試験は、報告のあった規模（数千ファイル）に近づける。
// 振る舞いを見る試験は、件数が判定に効かないので小さい置き場で回す（Windows のランナーではファイルを作るだけで遅い）。
const N_IDLE = 2000;
const N_SMALL = 120;
const sid = (i: number) => `bbbbbbbb-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const projOf = (i: number) => `-w-p${i % 40}`;
const rel = (i: number) => `${projOf(i)}/${sid(i)}.jsonl`;
const line = (i: number, text: string, ts: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: `u-${i}-${ts}`, timestamp: ts, cwd: `/w/p${i % 40}`, sessionId: sid(i) }) + '\n';
const historyLine = (sessionId: string, ts: number, display: string) => JSON.stringify({ display, timestamp: ts, project: '/w/h', sessionId }) + '\n';

let dir: string;
let projects: string;
let db: Db;
let timers: FakeTimers;
let fw: FakeWatch;
let svc: IndexerService | null;
const fileOf = (i: number) => path.join(projects, ...rel(i).split('/'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-idle-'));
  projects = path.join(dir, 'projects');
  db = openDb(':memory:');
  timers = new FakeTimers();
  fw = new FakeWatch();
  svc = null;
});

/** n 個の本文と history.jsonl を置く。 */
function build(n: number): void {
  for (let i = 0; i < n; i++) {
    fs.mkdirSync(path.join(projects, projOf(i)), { recursive: true });
    fs.writeFileSync(fileOf(i), line(i, `hello ${i}`, '2026-09-01T10:00:00.000Z'));
  }
  fs.writeFileSync(path.join(dir, 'history.jsonl'), historyLine(sid(0), 1788256800000, 'hello 0') + historyLine('cccccccc-0000-4000-8000-000000000001', 1788256800000, 'history only'));
}

afterEach(() => {
  svc?.stop();
  vi.restoreAllMocks();
  vi.mocked(indexFile).mockClear();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 起動して全走査を済ませ、そこから先の呼び出しだけを数える。 */
async function boot(extra: Partial<IndexerServiceOptions> = {}, n = N_SMALL) {
  build(n);
  const s = new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false, timers, watch: fw.watch, ...extra });
  svc = s;
  const errors: string[] = [];
  const changed: string[] = [];
  const gone: string[] = [];
  s.on({ error: (e) => errors.push(e.message), sessionChanged: (e) => changed.push(e.path), transcriptGone: (e) => gone.push(e.sessionId) });
  await s.start();
  vi.mocked(indexFile).mockClear();
  changed.length = 0;
  const statSync = vi.spyOn(fs, 'statSync');
  const readdirSync = vi.spyOn(fs, 'readdirSync');
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  const openSync = vi.spyOn(fs, 'openSync');
  const prepare = vi.spyOn(db, 'prepare');
  const syncHistory = vi.spyOn(s, 'syncHistoryOnly');
  // 試験の外（vitest 自身）が fs を使っても数えないよう、置き場の下の呼び出しだけを数える。
  const under = (m: { mock: { calls: unknown[][] } }) => m.mock.calls.filter((c) => String(c[0]).startsWith(dir)).length;
  const counts = () => ({
    indexFile: vi.mocked(indexFile).mock.calls.length,
    statSync: under(statSync),
    readdirSync: under(readdirSync),
    readFileSync: under(readFileSync),
    openSync: under(openSync),
    prepare: prepare.mock.calls.length,
    syncHistory: syncHistory.mock.calls.length,
  });
  const indexedPaths = () => vi.mocked(indexFile).mock.calls.map((c) => c[1].path);
  return { s, errors, changed, gone, counts, indexedPaths };
}

/** 時計を進め、そのあいだに始まった走査が終わるまで待つ。 */
async function advance(ms: number): Promise<void> {
  await timers.advance(ms);
  await svc!.settled();
}

describe('待機中の索引', { timeout: 120_000 }, () => {
  it('何も変わらなければ、旧来の 2 秒周期の 30 回ぶん時計を進めても、ファイルも DB も読まない', async () => {
    const b = await boot({}, N_IDLE);
    await advance(60_000);
    expect(b.counts()).toEqual({ indexFile: 0, statSync: 0, readdirSync: 0, readFileSync: 0, openSync: 0, prepare: 0, syncHistory: 0 });
  });

  it('取りこぼし対策の全件走査は、変わっていないファイルを SQL も読まずに飛ばす', async () => {
    const b = await boot({}, N_IDLE);
    await advance(5 * 60_000);
    const c = b.counts();
    expect(c.indexFile).toBe(0);
    // 1 ファイルにつき stat は 1 回まで。
    expect(c.statSync).toBeGreaterThanOrEqual(N_IDLE);
    expect(c.statSync).toBeLessThanOrEqual(N_IDLE + 5);
    // 索引の行をまとめて 1 回、消えた本文の確かめで 1 回。
    expect(c.prepare).toBeLessThanOrEqual(4);
    // history.jsonl が変わっていないので、本文なしのセッションの登録は回さない。
    expect(c.syncHistory).toBe(0);
    expect(c.readFileSync).toBe(0);
  });

  it('追記の通知は、名指しされたファイルだけを索引化する', async () => {
    const b = await boot();
    fs.appendFileSync(fileOf(7), line(7, 'more', '2026-09-01T11:00:00.000Z'));
    fs.appendFileSync(fileOf(8), line(8, 'more', '2026-09-01T11:00:00.000Z'));
    fw.emit(projects, rel(7));
    fw.emit(projects, rel(7));
    fw.emit(projects, rel(8).split('/').join(path.sep));
    await advance(299);
    expect(b.counts().indexFile).toBe(0);
    await advance(1);
    expect(b.indexedPaths().sort()).toEqual([fileOf(7), fileOf(8)].sort());
    expect(b.changed.sort()).toEqual([fileOf(7), fileOf(8)].sort());
    // 名指しされた 2 ファイルの確かめと新しい行の読み出しで 2 回ずつ、history.jsonl の確かめで 1 回。全件は stat しない。
    expect(b.counts().statSync).toBeLessThanOrEqual(5);
    expect(b.counts().readdirSync).toBe(0);
  });

  it('通知が続いても、最初の通知から debounce の間で 1 度まとめて索引化する', async () => {
    const b = await boot();
    for (let k = 0; k < 5; k++) {
      fs.appendFileSync(fileOf(3), line(3, `more ${k}`, `2026-09-01T11:00:0${k}.000Z`));
      fw.emit(projects, rel(3));
      await advance(100);
    }
    // 100 ミリ秒ごとに通知が来続けても、300 ミリ秒ごとには索引化する（後ろへずらし続けない）。
    expect(b.counts().indexFile).toBeGreaterThanOrEqual(1);
    await advance(300);
    expect(b.indexedPaths().every((p) => p === fileOf(3))).toBe(true);
    expect(db.prepare("select count(*) c from event_index where file_path_ref = ?").get(fileOf(3))).toEqual({ c: 6 });
  });

  it('名前の無い通知は、全件走査を早めに 1 回予約して変化を拾う', async () => {
    const b = await boot();
    fs.appendFileSync(fileOf(9), line(9, 'more', '2026-09-01T11:00:00.000Z'));
    fw.emit(projects, null);
    fw.emit(projects, null);
    await advance(2_000);
    expect(b.indexedPaths()).toEqual([fileOf(9)]);
    expect(b.counts().readdirSync).toBeGreaterThan(0);
  });

  it('ディレクトリの通知も全件走査に回し、中に現れたファイルを拾う', async () => {
    const b = await boot();
    const fresh = path.join(projects, '-w-fresh');
    fs.mkdirSync(fresh);
    const u = 'dddddddd-0000-4000-8000-000000000001';
    fs.writeFileSync(path.join(fresh, `${u}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'new' }, uuid: 'n1', timestamp: '2026-09-01T11:00:00.000Z', cwd: '/w/fresh', sessionId: u }) + '\n');
    fw.emit(projects, '-w-fresh');
    await advance(2_000);
    expect(b.indexedPaths()).toEqual([path.join(fresh, `${u}.jsonl`)]);
  });

  it('本文に関わらない名前の通知では何も読まない', async () => {
    const b = await boot();
    fw.emit(projects, `${projOf(1)}/memory/MEMORY.md`);
    fw.emit(projects, `${projOf(1)}/${sid(1)}/tool-results/x.txt`);
    await advance(60_000);
    expect(b.counts()).toMatchObject({ indexFile: 0, statSync: 0, readdirSync: 0 });
  });

  it('名指しされたファイルが消えていたら、全件走査で索引を片付ける', async () => {
    const b = await boot();
    fs.rmSync(fileOf(5));
    fw.emit(projects, rel(5));
    await advance(2_000);
    expect(b.gone).toHaveLength(1);
    expect(db.prepare('select count(*) c from transcript_files where path = ?').get(fileOf(5))).toEqual({ c: 0 });
    expect(b.errors).toEqual([]);
  });

  it('fs.watch が使えなければ、短めの周期で全件走査して変化を拾う', async () => {
    fw.broken = true;
    const b = await boot();
    expect(b.errors.some((m) => m.includes('polling only'))).toBe(true);
    fs.appendFileSync(fileOf(3), line(3, 'more', '2026-09-01T11:00:00.000Z'));
    await advance(9_000);
    expect(b.counts().indexFile).toBe(0);
    await advance(1_000);
    expect(b.indexedPaths()).toEqual([fileOf(3)]);
  });

  it('全件走査の周期は opts で差し替えられる', async () => {
    fw.broken = true;
    const b = await boot({ pollFallbackMs: 500 });
    fs.appendFileSync(fileOf(4), line(4, 'more', '2026-09-01T11:00:00.000Z'));
    await advance(500);
    expect(b.indexedPaths()).toEqual([fileOf(4)]);
  });

  it('history.jsonl の通知で追記を取り込み、本文なしのセッションを作る', async () => {
    const b = await boot();
    const u = 'eeeeeeee-0000-4000-8000-000000000001';
    fs.appendFileSync(path.join(dir, 'history.jsonl'), historyLine(u, 1788256900000, 'only in history'));
    fw.emit(dir, 'history.jsonl');
    await advance(1_000);
    expect(b.counts().syncHistory).toBe(1);
    // 追記の分だけを読み、頭から読み直さない。
    expect(b.counts().readFileSync).toBe(0);
    expect(db.prepare('select first_prompt from sessions where provider_session_id = ?').get(u)).toEqual({ first_prompt: 'only in history' });
    // 次の全件走査では、history は変わっていないので回さない。
    await advance(5 * 60_000);
    expect(b.counts().syncHistory).toBe(1);
  });

  it('history.jsonl の通知を取りこぼしても、全件走査で変化に気付いて取り込む', async () => {
    const b = await boot();
    const u = 'eeeeeeee-0000-4000-8000-000000000002';
    fs.appendFileSync(path.join(dir, 'history.jsonl'), historyLine(u, 1788256900000, 'missed'));
    await advance(5 * 60_000);
    expect(b.counts().syncHistory).toBe(1);
    expect(db.prepare('select count(*) c from sessions where provider_session_id = ?').get(u)).toEqual({ c: 1 });
  });

  it('他端末の置き場の通知も、名指しされたファイルだけを索引化する', async () => {
    const remote = path.join(dir, 'remote');
    const u = '11111111-1111-4111-8111-111111111111';
    upsertShared(db, 'sessions', { id: 's-remote', provider: 'claude-code', provider_session_id: u, cwd: '/w/r', home_device: 'dev-b' }, 'dev-b');
    const rp = path.join(remote, 'dev-b', 'projects', '-w-r', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(rp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'r' }, uuid: 'r1', timestamp: '2026-09-01T10:00:00.000Z', cwd: '/w/r', sessionId: u }) + '\n');
    const b = await boot({ remoteRoot: remote });
    fs.appendFileSync(rp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'r2' }, uuid: 'r2', timestamp: '2026-09-01T10:01:00.000Z', cwd: '/w/r', sessionId: u }) + '\n');
    fw.emit(remote, `dev-b/projects/-w-r/${u}.jsonl`);
    await advance(300);
    expect(b.indexedPaths()).toEqual([rp]);
    expect(db.prepare('select count(*) c from event_index where session_id = ?').get('s-remote')).toEqual({ c: 2 });
  });

  it('手元の本文が現れたら、通知の処理でも他端末の写しを外して手元を選ぶ', async () => {
    const remote = path.join(dir, 'remote');
    const u = '11111111-1111-4111-8111-111111111112';
    upsertShared(db, 'sessions', { id: 's-both', provider: 'claude-code', provider_session_id: u, cwd: '/w/r', home_device: 'dev-b' }, 'dev-b');
    const rp = path.join(remote, 'dev-b', 'projects', '-w-r', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    const rec = JSON.stringify({ type: 'user', message: { role: 'user', content: 'r' }, uuid: 'r1', timestamp: '2026-09-01T10:00:00.000Z', cwd: '/w/r', sessionId: u }) + '\n';
    fs.writeFileSync(rp, rec);
    await boot({ remoteRoot: remote });
    const lp = path.join(projects, '-w-r', `${u}.jsonl`);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, rec);
    fw.emit(projects, `-w-r/${u}.jsonl`);
    await advance(300);
    expect(db.prepare('select path, device_id from transcript_files where session_id = ?').all('s-both')).toEqual([{ path: lp, device_id: null }]);
  });

  it('実行中のセッションの本文は、通知が無くても 2 秒ごとの stat で追記を拾い、実行中でないファイルは見ない', async () => {
    const b = await boot({ liveSessions: () => [{ sessionId: sid(5), cwd: '/w/p5' }] });
    fs.appendFileSync(fileOf(5), line(5, 'live', '2026-09-01T11:00:00.000Z'));
    fs.appendFileSync(fileOf(6), line(6, 'not live', '2026-09-01T11:00:00.000Z'));
    await advance(2_000);
    expect(b.indexedPaths()).toEqual([fileOf(5)]);
    // 実行中の主線 1 本と、サブエージェントの置き場の確かめだけ。全件は見ない。
    expect(b.counts().statSync).toBeLessThanOrEqual(4);
    // 変わっていなければ、次の周期では索引化しない。
    vi.mocked(indexFile).mockClear();
    await advance(2_000);
    expect(b.counts().indexFile).toBe(0);
    // 途中で現れたサブエージェントも拾う。
    const sub = path.join(projects, projOf(5), sid(5), 'subagents', 'agent-ab1.jsonl');
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, line(5, 'sub', '2026-09-01T11:01:00.000Z'));
    await advance(2_000);
    expect(b.indexedPaths()).toEqual([sub]);
  });

  it('実行中のセッションが 0 本なら、見張りの周期を張らず、stat もしない', async () => {
    let live: { sessionId: string; cwd: string }[] = [];
    const b = await boot({ liveSessions: () => live });
    // 張っているのは 5 分の全件走査だけ。
    expect(timers.pendingCount()).toBe(1);
    await advance(60_000);
    expect(b.counts()).toMatchObject({ indexFile: 0, statSync: 0, readdirSync: 0 });
    // 実行中が現れたと知らされたら張り、いなくなったら外す。
    live = [{ sessionId: sid(2), cwd: '/w/p2' }];
    svc!.noteLiveChanged();
    expect(timers.pendingCount()).toBe(2);
    live = [];
    svc!.noteLiveChanged();
    expect(timers.pendingCount()).toBe(1);
  });

  it('requestSweep は全件走査を 1 回だけ予約し、重ねて呼んでも重ならない', async () => {
    const b = await boot();
    fs.appendFileSync(fileOf(11), line(11, 'more', '2026-09-01T11:00:00.000Z'));
    svc!.requestSweep();
    svc!.requestSweep();
    svc!.requestSweep();
    expect(timers.pendingCount()).toBe(1);
    await advance(1_000);
    expect(b.indexedPaths()).toEqual([fileOf(11)]);
    // 1 回分の全件走査だけが走った（1 ファイル 1 回の stat）。
    expect(b.counts().statSync).toBeLessThanOrEqual(N_SMALL + 5);
  });

  it('stop の後はタイマーを残さない', async () => {
    await boot();
    svc!.stop();
    expect(timers.pendingCount()).toBe(0);
  });
});
