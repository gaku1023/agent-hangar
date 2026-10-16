import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TAKEOVER_TIMEOUT_MS, type TakeoverDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { resumeHereAllowed, TAKEOVER_POLL_MS, TakeoverService } from './takeover.ts';
import { askOf, cancelAsk, writeAnswer, writeAsk, type TakeoverAsk } from './takeoverRows.ts';

// 頼む側の流れ。時計とタイマーは偽物、同期の口（pushNow、pull、canCarry）は差し替える。
// PC 名は pc-a（この PC）と pc-b（相手）で、実際の名前は使わない。

const SELF = 'pc-a';
const OTHER = 'pc-b';
const UUID = 'u1';
const LEDGER_KEY = `transcripts/${OTHER}/${UUID}.jsonl.gz`;

let db: Db;
let timers: FakeTimers;
let canCarry: boolean;
let pulls: number;
let pushes: number;
let broadcasts: TakeoverDto[];
let svc: TakeoverService;
let T0: number;

const now = () => timers.now;
const count = (table: string): number => (db.prepare(`select count(*) c from ${table} where deleted_at is null`).get() as { c: number }).c;
const asks = (): TakeoverAsk[] => (db.prepare('select id from takeovers where deleted_at is null order by requested_at, id').all() as { id: string }[]).map((r) => askOf(db, r.id)!);
const onlyAsk = (): TakeoverAsk => { const a = asks(); expect(a).toHaveLength(1); return a[0]!; };
const lastBroadcast = (): TakeoverDto => broadcasts[broadcasts.length - 1]!;
/** 約束を 1 周流す。 */
const flush = async (): Promise<void> => { await timers.advance(0); await Promise.resolve(); await Promise.resolve(); };
/** 時計を進める。進めた時刻で書かれる行の updated_at を、直前の書き込みと分けるためにも使う。 */
const advance = async (ms: number): Promise<void> => { await timers.advance(ms); await Promise.resolve(); await Promise.resolve(); };

function addRun(id: string, heartbeat: number): void {
  upsertShared(db, 'runs', { id, session_id: 's1', device_id: OTHER, kind: 'start', tmux_name: `hangar-${id}`, pid: null, launch_params: '{}', started_at: T0 - 60_000, ended_at: null, end_reason: null, heartbeat_at: heartbeat }, OTHER);
}
function setLedger(sha256: string, size: number): void {
  db.prepare('insert or replace into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)')
    .run(LEDGER_KEY, 'transcript', `remote/${OTHER}/${UUID}.jsonl`, OTHER, sha256, size, 1, 1, 1);
}
const answerStopped = (askId: string, o: { sha: string | null; size: number | null; result?: 'stopped' | 'not_running' } = { sha: 'v1', size: 10 }): void =>
  writeAnswer(db, OTHER, { askId, runId: 'r1', result: o.result ?? 'stopped', answeredAt: now(), transcriptSha256: o.sha, transcriptSize: o.size });

beforeEach(() => {
  db = openDb(':memory:');
  timers = new FakeTimers();
  T0 = timers.now;
  canCarry = true;
  pulls = 0;
  pushes = 0;
  broadcasts = [];
  upsertShared(db, 'devices', { id: SELF, name: 'pc-a', platform: 'darwin', last_seen_at: T0 }, SELF);
  upsertShared(db, 'devices', { id: OTHER, name: 'pc-b', platform: 'darwin', last_seen_at: T0 }, OTHER);
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: UUID, cwd: '/w/a', home_device: OTHER }, OTHER);
  svc = new TakeoverService({
    db, deviceId: SELF, canCarry: () => canCarry,
    pushNow: async () => { pushes++; },
    pull: async () => { pulls++; },
    broadcast: (d) => { broadcasts.push(d); },
    now, timers,
  });
});
afterEach(() => { svc.stop(); db.close(); });

describe('TakeoverService', () => {
  it('ロックが無ければ頼みを書かずに ready', () => {
    expect(svc.start('s1', { force: false }).stage).toBe('ready');
    expect(count('takeovers')).toBe(0);
    expect(lastBroadcast().stage).toBe('ready');
  });

  it('ロックが stale なら force の頼みを書いて ready', () => {
    addRun('r1', T0 - 10 * 60_000);
    expect(svc.start('s1', { force: false }).stage).toBe('ready');
    expect(onlyAsk()).toMatchObject({ mode: 'force', runId: 'r1', targetDevice: OTHER, fromDevice: SELF });
  });

  it('force: true なら生きたロックでも force の頼みを書いて ready', () => {
    addRun('r1', T0 - 1_000);
    expect(svc.start('s1', { force: true }).stage).toBe('ready');
    expect(onlyAsk().mode).toBe('force');
  });

  it('生きたロックなら ask を書き、push の後に waiting にする', async () => {
    addRun('r1', T0 - 1_000);
    expect(svc.start('s1', { force: false })).toMatchObject({ sessionId: 's1', stage: 'asking', deviceName: 'pc-b', startedAt: T0, deadline: T0 + 90_000 });
    expect(onlyAsk()).toMatchObject({ mode: 'ask', runId: 'r1', targetDevice: OTHER, fromDevice: SELF, cancelledAt: null });
    expect(pushes).toBe(1);
    await flush();
    expect(lastBroadcast().stage).toBe('waiting');
    expect(svc.get('s1')?.stage).toBe('waiting');
  });

  it('待つ間は 5 秒ごとに取りに行く', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    expect(pulls).toBe(0);
    await advance(TAKEOVER_POLL_MS);
    expect(pulls).toBe(1);
    await advance(TAKEOVER_POLL_MS);
    expect(pulls).toBe(2);
  });

  it('応答が届けば取りに行くのをやめ、ready の後は取りに行かない', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    answerStopped(onlyAsk().id, { sha: null, size: null, result: 'not_running' });
    await advance(TAKEOVER_POLL_MS);
    expect(lastBroadcast().stage).toBe('ready');
    const before = pulls;
    await advance(20_000);
    expect(pulls).toBe(before);
  });

  it('応答と台帳の版がそろえば ready、合わなければ receiving', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    const id = onlyAsk().id;
    answerStopped(id, { sha: 'v2', size: 20 });
    // 台帳はまだ古い版。
    setLedger('v1', 10);
    svc.noteApplied();
    expect(svc.get('s1')?.stage).toBe('receiving');
    expect(lastBroadcast().stage).toBe('receiving');
    // 大きさだけ合っても、sha256 が違えば待つ。
    setLedger('v1', 20);
    svc.noteApplied();
    expect(svc.get('s1')?.stage).toBe('receiving');
    // 降りきった。
    setLedger('v2', 20);
    await advance(TAKEOVER_POLL_MS);
    expect(svc.get('s1')?.stage).toBe('ready');
    expect(lastBroadcast().stage).toBe('ready');
  });

  it('本文が降りきる前の応答では receiving のまま取りに行き続け、台帳が無くても ready にしない', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    answerStopped(onlyAsk().id, { sha: 'v2', size: 20 });
    svc.noteApplied();
    expect(svc.get('s1')?.stage).toBe('receiving');
    const before = pulls;
    await advance(TAKEOVER_POLL_MS);
    expect(pulls).toBe(before + 1);
    expect(svc.get('s1')?.stage).toBe('receiving');
  });

  it('応答の sha256 が null なら台帳を見ずに ready', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    answerStopped(onlyAsk().id, { sha: null, size: null });
    svc.noteApplied();
    expect(svc.get('s1')?.stage).toBe('ready');
  });

  it('90 秒で timeout にして取りに行くのをやめ、extend で待ち直す', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    await advance(90_000);
    expect(lastBroadcast().stage).toBe('timeout');
    const before = pulls;
    await advance(10_000);
    expect(pulls).toBe(before);
    expect(svc.extend('s1')).toMatchObject({ stage: 'waiting', deadline: T0 + 100_000 + 90_000 });
    expect(lastBroadcast().stage).toBe('waiting');
    await advance(TAKEOVER_POLL_MS);
    expect(pulls).toBe(before + 1);
    // 足した分も使い切れば、また timeout になる。
    await advance(TAKEOVER_TIMEOUT_MS);
    expect(svc.get('s1')?.stage).toBe('timeout');
  });

  it('timeout の後に force で始めると、同じ頼みの行を force にして ready', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    const id = onlyAsk().id;
    await advance(90_000);
    expect(svc.get('s1')?.stage).toBe('timeout');
    expect(svc.start('s1', { force: true }).stage).toBe('ready');
    expect(count('takeovers')).toBe(1);
    expect(onlyAsk()).toMatchObject({ id, mode: 'force' });
  });

  it('extend は始めていない会話には null', () => {
    expect(svc.extend('s1')).toBeNull();
  });

  it('頼みを運べないとき（Worker が版 5、同期の一時停止）は行を書かずにすぐ timeout', async () => {
    addRun('r1', T0 - 1_000);
    canCarry = false;
    expect(svc.start('s1', { force: false }).stage).toBe('timeout');
    expect(count('takeovers')).toBe(0);
    expect(pushes).toBe(0);
    await advance(30_000);
    expect(pulls).toBe(0);
    // 運べないままでは、待ち直しても timeout のまま。
    expect(svc.extend('s1')?.stage).toBe('timeout');
    expect(count('takeovers')).toBe(0);
    // 運べるようになれば、extend が頼みを書いて待ち直す。
    canCarry = true;
    expect(svc.extend('s1')?.stage).toBe('asking');
    expect(onlyAsk().mode).toBe('ask');
    await flush();
    expect(svc.get('s1')?.stage).toBe('waiting');
  });

  it('頼みを運べないとき、応答の無い ask が前からあっても force は ready にして再開を通す印を覚える', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    const id = onlyAsk().id;
    canCarry = false;
    expect(svc.start('s1', { force: true }).stage).toBe('ready');
    // 運べないので行は書き換えない（mode は ask のまま）。再開は印で通す。
    expect(onlyAsk()).toMatchObject({ id, mode: 'ask' });
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
    expect(svc.forcedWithoutRow('s1', 'r1')).toBe(true);
  });

  it('asking の間の extend は段を変えず、期限だけ延ばす', async () => {
    addRun('r1', T0 - 1_000);
    let release: () => void = () => {};
    svc = new TakeoverService({
      db, deviceId: SELF, canCarry: () => true, pushNow: () => new Promise<void>((r) => { release = r; }),
      pull: async () => { pulls++; }, broadcast: (d) => { broadcasts.push(d); }, now, timers,
    });
    svc.start('s1', { force: false });
    await advance(10_000);
    expect(svc.get('s1')?.stage).toBe('asking');
    expect(svc.extend('s1')).toMatchObject({ stage: 'asking', deadline: T0 + 10_000 + 90_000 });
    expect(lastBroadcast()).toMatchObject({ stage: 'asking', deadline: T0 + 100_000 });
    // 送り終えたら、これまでどおり waiting へ進む。
    release();
    await flush();
    expect(svc.get('s1')?.stage).toBe('waiting');
    // 延ばした期限で打ち切られる。
    await advance(95_000);
    expect(svc.get('s1')?.stage).toBe('timeout');
  });

  it('頼みを運べないときの force は行を書かずに ready にし、再開を通す印だけを覚える', () => {
    addRun('r1', T0 - 1_000);
    canCarry = false;
    expect(svc.start('s1', { force: true }).stage).toBe('ready');
    expect(count('takeovers')).toBe(0);
    expect(svc.forcedWithoutRow('s1', 'r1')).toBe(true);
    expect(svc.forcedWithoutRow('s1', 'other-run')).toBe(false);
  });

  it('cancel は頼みに取り下げを書いて送り、cancelled を 1 度配って状態を捨てる', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    await advance(10);
    const pushed = pushes;
    svc.cancel('s1');
    expect(onlyAsk().cancelledAt).not.toBeNull();
    expect(pushes).toBe(pushed + 1);
    expect(broadcasts.filter((d) => d.stage === 'cancelled')).toHaveLength(1);
    expect(svc.get('s1')).toBeNull();
    const n = broadcasts.length;
    svc.cancel('s1');
    expect(broadcasts).toHaveLength(n);
  });

  it('cancel の後に応答が届いても ready を配らず、再開も通さない', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    await advance(10);
    const id = onlyAsk().id;
    svc.cancel('s1');
    // 相手は取り下げを知らずに止めて、応答を書いた。行は書き手が別なので、取り下げは消えない。
    answerStopped(id, { sha: null, size: null });
    svc.noteApplied();
    await advance(TAKEOVER_POLL_MS * 2);
    expect(broadcasts.map((d) => d.stage)).not.toContain('ready');
    expect(svc.get('s1')).toBeNull();
    expect(askOf(db, id)?.cancelledAt).not.toBeNull();
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
    expect(pulls).toBe(0);
  });

  it('サーバを立て直して状態が消えていても、cancel は自分の頼みを取り下げる', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    await advance(10);
    svc.stop();
    const fresh = new TakeoverService({ db, deviceId: SELF, canCarry: () => true, pushNow: async () => { pushes++; }, pull: async () => {}, broadcast: () => {}, now, timers });
    fresh.cancel('s1');
    expect(onlyAsk().cancelledAt).not.toBeNull();
    fresh.stop();
  });

  it('取り下げた後に始め直すと、新しい頼みを書く', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    await advance(10);
    svc.cancel('s1');
    await advance(10);
    expect(svc.start('s1', { force: false }).stage).toBe('asking');
    expect(asks()).toHaveLength(2);
  });

  it('push が転んでも waiting へ進み、待つ', async () => {
    addRun('r1', T0 - 1_000);
    svc = new TakeoverService({ db, deviceId: SELF, canCarry: () => true, pushNow: async () => { throw new Error('offline'); }, pull: async () => { pulls++; }, broadcast: (d) => { broadcasts.push(d); }, now, timers });
    svc.start('s1', { force: false });
    await flush();
    expect(svc.get('s1')?.stage).toBe('waiting');
  });

  it('stop はタイマーを全部外す', async () => {
    addRun('r1', T0 - 1_000);
    svc.start('s1', { force: false });
    await flush();
    svc.stop();
    expect(timers.pendingCount()).toBe(0);
  });
});

describe('resumeHereAllowed', () => {
  beforeEach(() => { addRun('r1', T0 - 1_000); });

  it('ロックが無ければ通す', () => {
    db.prepare("update runs set ended_at = ?, end_reason = 'exited'").run(T0);
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: true });
  });

  it('生きたロックで頼みが無ければ断り、相手の名前を返す', () => {
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
  });

  it('stale なら通す', () => {
    expect(resumeHereAllowed(db, SELF, 's1', now() + 10 * 60_000)).toEqual({ ok: true });
  });

  it('force の頼みなら通す', () => {
    writeAsk(db, SELF, { sessionId: 's1', runId: 'r1', targetDevice: OTHER, mode: 'force', now: now() });
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: true });
  });

  it('応答のある ask なら通し、応答の無い ask は断る', () => {
    const a = writeAsk(db, SELF, { sessionId: 's1', runId: 'r1', targetDevice: OTHER, mode: 'ask', now: now() });
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
    answerStopped(a.id, { sha: null, size: null });
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: true });
  });

  it('応答の本文の版が台帳に降りきるまでは通さない（receiving の間に直に叩かれても古い本文で再開しない）', () => {
    const a = writeAsk(db, SELF, { sessionId: 's1', runId: 'r1', targetDevice: OTHER, mode: 'ask', now: now() });
    answerStopped(a.id, { sha: 'v2', size: 20 });
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
    setLedger('v1', 20);
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
    setLedger('v2', 10);
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
    setLedger('v2', 20);
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: true });
  });

  it('取り下げた頼み、ほかの run への頼み、ほかの PC が書いた頼みでは通さない', () => {
    const a = writeAsk(db, SELF, { sessionId: 's1', runId: 'r1', targetDevice: OTHER, mode: 'force', now: now() });
    cancelAsk(db, SELF, a.id, now() + 1);
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
    writeAsk(db, SELF, { sessionId: 's1', runId: 'r-old', targetDevice: OTHER, mode: 'force', now: now() + 2 });
    writeAsk(db, 'pc-c', { sessionId: 's1', runId: 'r1', targetDevice: OTHER, mode: 'force', now: now() + 3 });
    expect(resumeHereAllowed(db, SELF, 's1', now())).toEqual({ ok: false, deviceName: 'pc-b' });
  });
});
