import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMIT_RESET_AUTO_GRACE_MS, LIMIT_RESET_GRACE_MS, type LiveSessionDto, type OsNoticeDto } from '@agent-hangar/shared';
import { onRowChange } from '../db/notify.ts';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { setSessionName } from './notes.ts';
import { setSessionState } from './states.ts';
import { NOTICE_IDLE_MS, NOTICE_POLL_MS, OsNoticeFeed, paceNotices, StopNoticeWatch } from './stopNotices.ts';

let db: Db;
let live: LiveSessionDto[];
let now: number;
let pushed: Omit<OsNoticeDto, 'seq'>[];
let s1: string;
let s2: string;
let touched: string[];
let off: () => void;
const entry = (sessionId: string, status: LiveSessionDto['status'], over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1, ...over });
const watch = (o: { account?: (id: string) => string } = {}) => new StopNoticeWatch({
  db, deviceId: 'd', live: () => live, language: () => 'ja', feed: { push: (n) => { pushed.push(n); } },
  accountOf: o.account ?? (() => 'primary'), now: () => now, permissionWaitMs: 800,
});
const ask = (q: string | null, sid = s1) => db.prepare('insert or replace into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)').run(sid, 'AskUserQuestion', 'AskUserQuestion', 't1', q, 1);
const limitRow = (sid: string, resetsAt: number, auto = 0, hitAt = now) => db.prepare('insert or replace into session_limits (session_id, kind, resets_at, auto, hit_at) values (?,?,?,?,?)').run(sid, 'five_hour', resetsAt, auto, hitAt);

beforeEach(() => {
  db = openDb(':memory:');
  s1 = ensureSession(db, 'u1', '/w', 'd');
  s2 = ensureSession(db, 'u2', '/w', 'd');
  setSessionName(db, 'd', s1, '請求書の書き出し');
  setSessionName(db, 'd', s2, '依存の更新');
  live = [entry('u1', 'busy'), entry('u2', 'busy')];
  now = new Date(2026, 9, 12, 16, 0).getTime();
  pushed = [];
  touched = [];
  off = onRowChange((c) => { if (c.db === db && c.table === 'sessions' && c.origin === 'touch') touched.push(c.rowId); });
});
afterEach(() => { off(); db.close(); });

describe('StopNoticeWatch：入力待ち', () => {
  it('起動したときに入力待ちだったものは知らせない（起動の前に知らせ終えている）', () => {
    live = [entry('u1', 'waiting')];
    const w = watch();
    w.tick();
    now += 1000;
    w.tick();
    expect(pushed).toEqual([]);
  });

  it('問いの文があれば、入力待ちになったときに 1 回だけ問いの文で知らせる', () => {
    const w = watch();
    w.tick();
    ask('どちらにしますか？');
    live = [entry('u1', 'waiting', { waitingFor: 'question' })];
    w.tick();
    w.tick();
    expect(pushed).toEqual([{ kind: 'waiting', sessionId: s1, title: '請求書の書き出し', body: 'どちらにしますか？', bare: false }]);
  });

  it('問いの文がまだ無ければ印（bare）を付けて知らせ、届いたら問いの文でもう 1 回だけ知らせる', () => {
    const w = watch();
    w.tick();
    live = [entry('u1', 'waiting')];
    w.tick();
    expect(pushed).toEqual([{ kind: 'waiting', sessionId: s1, title: '請求書の書き出し', body: '入力待ちです', bare: true }]);
    ask('向きは？');
    now += 300;
    w.tick();
    w.tick();
    expect(pushed.map((p) => [p.body, p.bare])).toEqual([['入力待ちです', true], ['向きは？', false]]);
  });

  it('許可待ちは預けずに、許可の中身で知らせる', () => {
    const w = watch();
    w.tick();
    live = [entry('u1', 'waiting', { waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf ./build/cache', description: null } })];
    w.tick();
    expect(pushed).toEqual([{ kind: 'waiting', sessionId: s1, title: '請求書の書き出し', body: '許可待ち：Bash rm -rf ./build/cache', bare: false }]);
  });

  it('許可の中身がまだ届いていなければ少しだけ待ち、来なければ中身なしで知らせる', () => {
    const w = watch();
    w.tick();
    live = [entry('u1', 'waiting', { waitingFor: 'permission' })];
    w.tick();
    now += 500;
    w.tick();
    expect(pushed).toEqual([]);
    now += 400;
    w.tick();
    expect(pushed).toEqual([{ kind: 'waiting', sessionId: s1, title: '請求書の書き出し', body: '許可待ちです', bare: false }]);
  });

  it('待つ間に中身が届けば、中身で知らせる', () => {
    const w = watch();
    w.tick();
    live = [entry('u1', 'waiting', { waitingFor: 'permission' })];
    w.tick();
    now += 300;
    live = [entry('u1', 'waiting', { waitingFor: 'permission', permission: { tool: 'Write', input: '/w/a.ts', description: null } })];
    w.tick();
    expect(pushed.map((p) => p.body)).toEqual(['許可待ち：Write /w/a.ts']);
  });

  it('Done と Archived にしたものは知らせない', () => {
    setSessionState(db, 'd', s1, { status: 'done', setBy: 'user' });
    const w = watch();
    w.tick();
    live = [entry('u1', 'waiting')];
    w.tick();
    expect(pushed).toEqual([]);
  });

  it('入力待ちを抜けてまた入ったら、もう 1 回知らせる', () => {
    ask('一つ目？');
    const w = watch();
    w.tick();
    live = [entry('u1', 'waiting')];
    w.tick();
    live = [entry('u1', 'busy')];
    w.tick();
    ask('二つ目？');
    live = [entry('u1', 'waiting')];
    w.tick();
    expect(pushed.map((p) => p.body)).toEqual(['一つ目？', '二つ目？']);
  });
});

describe('StopNoticeWatch：待っているものがあるか（pending）', () => {
  it('問いの文を待つ間と許可の中身を待つ間だけ真で、知らせ終えたら偽に戻る', () => {
    const w = watch();
    w.tick();
    expect(w.pending()).toBe(false);
    live = [entry('u1', 'waiting')];
    w.tick();
    expect(w.pending()).toBe(true);
    ask('向きは？');
    w.tick();
    expect(w.pending()).toBe(false);
    live = [entry('u1', 'busy'), entry('u2', 'waiting', { waitingFor: 'permission' })];
    w.tick();
    expect(w.pending()).toBe(true);
    now += 900;
    w.tick();
    expect(w.pending()).toBe(false);
  });

  it('起動したときに入力待ちだったものは待たない', () => {
    live = [entry('u1', 'waiting')];
    const w = watch();
    w.tick();
    expect(w.pending()).toBe(false);
  });
});

/**
 * 知らせの見張りの周期（2026-10-14、0.6.1）。
 * 待っているもの（問いの文、許可の中身）がある間だけ NOTICE_POLL_MS ごとに見て、無い間は NOTICE_IDLE_MS ごとに見る。
 * 登録が変わったときは、その場で見る。入力待ちになってから知らせるまでの遅れは、登録の見張りの遅れだけで決まる。
 */
describe('paceNotices', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const fake = () => {
    const f = { ticks: 0, waiting: false, tick: () => { f.ticks++; }, pending: () => f.waiting };
    return f;
  };

  it('待っているものが無ければ NOTICE_IDLE_MS ごとにしか見ない', () => {
    const f = fake();
    const p = paceNotices(f);
    p.start();
    vi.advanceTimersByTime(NOTICE_IDLE_MS - 1);
    expect(f.ticks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(f.ticks).toBe(1);
    p.stop();
    expect(NOTICE_IDLE_MS).toBeLessThanOrEqual(5000);
  });

  it('登録が変わったらその場で見て、待つものができたら NOTICE_POLL_MS ごとに見る', () => {
    const f = fake();
    const p = paceNotices(f);
    p.start();
    vi.advanceTimersByTime(1000);
    f.tick = () => { f.ticks++; if (f.ticks === 1) f.waiting = true; };
    p.onLiveChange();
    expect(f.ticks).toBe(1);
    vi.advanceTimersByTime(NOTICE_POLL_MS);
    expect(f.ticks).toBe(2);
    vi.advanceTimersByTime(NOTICE_POLL_MS * 3);
    expect(f.ticks).toBe(5);
    f.waiting = false;
    vi.advanceTimersByTime(NOTICE_POLL_MS);
    expect(f.ticks).toBe(6);
    vi.advanceTimersByTime(NOTICE_IDLE_MS - 1);
    expect(f.ticks).toBe(6);
    p.stop();
  });

  it('tick が投げても周期は止めない', () => {
    const f = fake();
    f.tick = () => { f.ticks++; throw new Error('boom'); };
    const errors: unknown[] = [];
    const p = paceNotices(f, { onError: (e) => errors.push(e) });
    p.start();
    expect(() => p.onLiveChange()).not.toThrow();
    vi.advanceTimersByTime(NOTICE_IDLE_MS * 2);
    expect(f.ticks).toBe(3);
    expect(errors).toHaveLength(3);
    p.stop();
  });
});

describe('StopNoticeWatch：使用制限', () => {
  it('当たったら、アカウントごとに 1 通だけ知らせる', () => {
    live = [entry('u1', 'idle'), entry('u2', 'idle')];
    const w = watch();
    w.tick();
    const resetsAt = new Date(2026, 9, 12, 16, 50).getTime();
    limitRow(s1, resetsAt, 1);
    w.tick();
    limitRow(s2, resetsAt, 1);
    w.tick();
    expect(pushed).toEqual([{ kind: 'limit', sessionId: s1, title: '使用制限（5 時間）', body: '請求書の書き出し が停止しました。16:50 にリセットされます', bare: false }]);
  });

  it('同じ時に当たったものは件数で言う。アカウントが違えば別に知らせる', () => {
    live = [entry('u1', 'idle'), entry('u2', 'idle')];
    const w = watch({ account: (id) => (id === 'u1' ? 'a' : 'b') });
    w.tick();
    const resetsAt = new Date(2026, 9, 12, 16, 50).getTime();
    limitRow(s1, resetsAt);
    limitRow(s2, resetsAt);
    w.tick();
    expect(pushed.map((p) => p.sessionId).sort()).toEqual([s1, s2].sort());
    const w2 = watch();
    pushed = [];
    w2.tick();
    db.prepare('delete from session_limits').run();
    w2.tick();
    limitRow(s1, resetsAt + 60_000);
    limitRow(s2, resetsAt + 60_000);
    w2.tick();
    expect(pushed.map((p) => p.body)).toEqual(['2 件のセッションが停止しました。16:51 にリセットされます']);
  });

  it('起動したときに当たっていたものは知らせない', () => {
    live = [entry('u1', 'idle')];
    limitRow(s1, now + 3_600_000);
    const w = watch();
    w.tick();
    w.tick();
    expect(pushed).toEqual([]);
  });

  it('リセットから猶予を過ぎても続かなければ、行を配り直し、Active のものはリセット済みとして知らせる', () => {
    live = [entry('u1', 'idle'), entry('u2', 'idle')];
    setSessionState(db, 'd', s2, { status: 'paused', note: '明日', returnOn: '2026-10-13', setBy: 'user' });
    const w = watch();
    w.tick();
    const resetsAt = now + 60_000;
    limitRow(s1, resetsAt);
    limitRow(s2, resetsAt);
    w.tick();
    pushed = [];
    touched = [];
    now = resetsAt + LIMIT_RESET_GRACE_MS - 1;
    w.tick();
    expect(pushed).toEqual([]);
    now = resetsAt + LIMIT_RESET_GRACE_MS;
    w.tick();
    w.tick();
    expect(pushed).toEqual([{ kind: 'waiting', sessionId: s1, title: '請求書の書き出し', body: '使用制限がリセットされました。続きを指示してください', bare: false }]);
    expect(touched.sort()).toEqual([s1, s2].sort());
  });

  it('自動で続く予約のあるものは、自動の続きの遅れを見込んで長めに待ってから、リセット済みとして知らせる', () => {
    live = [entry('u1', 'idle')];
    const w = watch();
    w.tick();
    const resetsAt = now + 60_000;
    limitRow(s1, resetsAt, 1);
    w.tick();
    pushed = [];
    touched = [];
    // Claude Code の自動の続きは、リセットから 70 秒から 90 秒ほど遅れて始まる。ふだんの猶予では知らせない。
    now = resetsAt + LIMIT_RESET_GRACE_MS;
    w.tick();
    expect(pushed).toEqual([]);
    expect(touched).toEqual([]);
    now = resetsAt + LIMIT_RESET_AUTO_GRACE_MS;
    w.tick();
    expect(pushed).toEqual([{ kind: 'waiting', sessionId: s1, title: '請求書の書き出し', body: '使用制限がリセットされました。続きを指示してください', bare: false }]);
  });

  it('索引を作り直したときなどに後から見つかった古い使用制限とリセットは、知らせない', () => {
    live = [entry('u1', 'idle'), entry('u2', 'idle')];
    const w = watch();
    w.tick();
    // 1 時間前に当たり、まだリセット前のもの。
    limitRow(s1, now + 3_600_000, 1, now - 3_600_000);
    // 1 日前に当たり、とうにリセットを過ぎたもの。
    limitRow(s2, now - 86_000_000, 0, now - 86_400_000);
    w.tick();
    expect(pushed).toEqual([]);
    // 行は配り直す（リセット済みとして要対応に上がる）。
    expect(touched).toContain(s2);
  });
  it('リセットの後に作業中なら（自動で続いた）、知らせない', () => {
    live = [entry('u1', 'idle')];
    const w = watch();
    w.tick();
    const resetsAt = now + 60_000;
    limitRow(s1, resetsAt, 1);
    w.tick();
    pushed = [];
    live = [entry('u1', 'busy')];
    now = resetsAt + LIMIT_RESET_GRACE_MS;
    w.tick();
    expect(pushed).toEqual([]);
  });
});

describe('OsNoticeFeed', () => {
  it('起動の印と番号で、続きだけを返す。印が違えば今の番号だけを返す', () => {
    const f = new OsNoticeFeed();
    const first = f.read(-1, null);
    expect(first).toEqual({ boot: f.boot, seq: 0, items: [] });
    f.push({ kind: 'waiting', sessionId: 's', title: 't', body: 'b', bare: false });
    expect(f.read(0, f.boot).items.map((i) => i.seq)).toEqual([1]);
    expect(f.read(1, f.boot).items).toEqual([]);
    expect(f.read(0, 'old-boot')).toEqual({ boot: f.boot, seq: 1, items: [] });
  });

  it('待っている読み手は、届いたらすぐ返り、届かなければ時間で返る', async () => {
    const f = new OsNoticeFeed();
    const p = f.wait(0, f.boot, 5000);
    f.push({ kind: 'limit', sessionId: 's', title: 't', body: 'b', bare: false });
    expect((await p).items.length).toBe(1);
    const q = await f.wait(1, f.boot, 10);
    expect(q.items).toEqual([]);
  });

  it('古いものは捨てる', () => {
    const f = new OsNoticeFeed(3);
    for (let i = 0; i < 5; i++) f.push({ kind: 'waiting', sessionId: `s${i}`, title: 't', body: 'b', bare: false });
    expect(f.read(0, f.boot).items.map((i) => i.seq)).toEqual([3, 4, 5]);
  });
});
