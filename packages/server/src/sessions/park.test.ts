import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { LiveSession } from '../provider/claude-code/types.ts';
import { hasMarkedIdle, ParkWatch, parkedSessionIds, statusChanged } from './park.ts';
import { setSessionState } from './states.ts';

const T = (iso: string) => Date.parse(iso);
const PROC_START = 'Fri Oct  2 02:30:05 2026';
const SET_AT = T('2026-10-02T03:00:00.000Z');

function seed() {
  const db = openDb(':memory:');
  for (const n of [1, 2, 3]) upsertShared(db, 'sessions', { id: `s${n}`, provider: 'claude-code', provider_session_id: `u${n}`, cwd: '/w', home_device: 'd' }, 'd');
  return db;
}
const live = (sessionId: string, status: LiveSession['status'] = 'idle', procStart: string | null = PROC_START): LiveSession =>
  ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 42, ...(procStart ? { procStart } : {}) });

// 待機中の休みの見張りを軽くする（2026-10-14、0.6.1）。
// 区切り（Done、Archived）の付いた休みの会話が 1 つも無ければ、登録を読み直さず、セッションの行も組まない。
describe('hasMarkedIdle', () => {
  it('Done か Archived の付いた休みの会話があるときだけ真', () => {
    const db = seed();
    expect(hasMarkedIdle(db, [live('u1'), live('u2'), live('u3')])).toBe(false);
    setSessionState(db, 'd', 's1', { status: 'paused', note: 'あとで', setBy: 'user', now: SET_AT });
    expect(hasMarkedIdle(db, [live('u1')])).toBe(false);
    setSessionState(db, 'd', 's2', { status: 'done', setBy: 'user', now: SET_AT });
    expect(hasMarkedIdle(db, [live('u1'), live('u2', 'busy')])).toBe(false);
    expect(hasMarkedIdle(db, [live('u1'), live('u2')])).toBe(true);
    setSessionState(db, 'd', 's3', { status: 'archived', setBy: 'conversation', now: SET_AT });
    expect(hasMarkedIdle(db, [live('u3')])).toBe(true);
    expect(hasMarkedIdle(db, [])).toBe(false);
  });
});

describe('parkedSessionIds', () => {
  it('印が付いていて休みのまま残っている会話の、hangar のセッションの id を返す', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'archived', setBy: 'conversation', now: SET_AT });
    setSessionState(db, 'd', 's2', { status: 'done', setBy: 'user', now: SET_AT });
    // s1 は休み、s2 は作業中、s3 は印なし。
    expect(parkedSessionIds(db, [live('u1'), live('u2', 'busy'), live('u3')])).toEqual(['s1']);
  });
  it('裏だけ動いている会話（本体は空いていて、裏で Bash が動いている）は返さない。止めると裏の作業も消える', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'archived', setBy: 'conversation', now: SET_AT });
    expect(parkedSessionIds(db, [{ ...live('u1', 'busy'), aside: { shell: true, agents: 0 } }])).toEqual([]);
  });
  it('再開して開いたもの（印より後に起動）と、hangar が知らない会話は返さない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'archived', setBy: 'user', now: T('2026-10-02T02:00:00.000Z') });
    expect(parkedSessionIds(db, [live('u1'), live('u-unknown')])).toEqual([]);
  });
  it('同じ会話に登録が 2 つあるとき（hangar の run と外のターミナルなど）は返さない。どのプロセスが休みなのか決められない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'archived', setBy: 'conversation', now: SET_AT });
    expect(parkedSessionIds(db, [live('u1'), live('u1', 'busy')])).toEqual([]);
    expect(parkedSessionIds(db, [live('u1', 'busy'), live('u1')])).toEqual([]);
    expect(parkedSessionIds(db, [live('u1'), live('u1')])).toEqual([]);
  });
  it('使用制限でリセットを待っている会話は返さない。止めると Claude Code が予約した自動の続きごと消える', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'archived', setBy: 'conversation', now: SET_AT });
    setSessionState(db, 'd', 's2', { status: 'done', setBy: 'user', now: SET_AT });
    const resetsAt = Date.now() + 3_600_000;
    for (const id of ['s1', 's2']) db.prepare('insert into session_limits (session_id, kind, resets_at, auto, hit_at) values (?,?,?,?,?)').run(id, 'five_hour', resetsAt, 1, SET_AT);
    expect(parkedSessionIds(db, [live('u1'), live('u2')])).toEqual([]);
    // リセットから猶予を過ぎても続きが始まらなければ、ふつうに止める。
    db.prepare('update session_limits set resets_at = ?').run(Date.now() - 600_000);
    expect(parkedSessionIds(db, [live('u1'), live('u2')])).toEqual(['s1', 's2']);
  });
  it('Paused の会話は、休みのまま残っていても返さない。戻ってくる会話なので止めない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'conversation', now: SET_AT });
    setSessionState(db, 'd', 's2', { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'user', now: SET_AT });
    setSessionState(db, 'd', 's3', { status: 'done', setBy: 'user', now: SET_AT });
    expect(parkedSessionIds(db, [live('u1'), live('u2'), live('u3')])).toEqual(['s3']);
  });
  it('動いているものが無ければ空', () => {
    expect(parkedSessionIds(seed(), [])).toEqual([]);
  });
  it('opencode の会話にも効く。起動時刻は hangar の生きた run の始まりで見て、provider の違う同じ ID の会話とは取り違えない', () => {
    const db = seed();
    upsertShared(db, 'sessions', { id: 'o1', provider: 'opencode', provider_session_id: 'ses_1', cwd: '/w', home_device: 'd' }, 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: 'o1', device_id: 'd', kind: 'start', tmux_name: 'hangar-r1', pid: null, launch_params: '{}', started_at: T('2026-10-02T02:30:00.000Z'), ended_at: null, end_reason: null, heartbeat_at: T('2026-10-02T02:30:00.000Z') }, 'd');
    setSessionState(db, 'd', 'o1', { status: 'done', setBy: 'user', now: SET_AT });
    const oc = (sessionId: string, status: LiveSession['status'] = 'idle'): LiveSession => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 99, agent: 'opencode' });
    expect(hasMarkedIdle(db, [oc('ses_1')])).toBe(true);
    expect(parkedSessionIds(db, [oc('ses_1')], 'd')).toEqual(['o1']);
    expect(parkedSessionIds(db, [oc('ses_1', 'busy')], 'd')).toEqual([]);
    // Claude の会話の ID と同じ値の opencode の行は、Claude の会話を止めない（逆も同じ）。
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: SET_AT });
    expect(parkedSessionIds(db, [oc('u1')], 'd')).toEqual([]);
    expect(hasMarkedIdle(db, [oc('u1')])).toBe(false);
    expect(parkedSessionIds(db, [live('ses_1')], 'd')).toEqual([]);
  });
});

describe('ParkWatch', () => {
  const setup = (o: { stoppable?: boolean } = {}) => {
    const s = { now: 0, parked: [] as string[], stopped: [] as string[], on: true, read: 0 };
    const watch = new ParkWatch({ parkedIds: () => { s.read++; return s.parked; }, stop: (id) => { s.stopped.push(id); return o.stoppable ?? true; }, now: () => s.now, settleMs: 10_000, enabled: () => s.on });
    return { s, watch };
  };

  it('設定で切っている間は止めない。休みの一覧も読まず、入れ直したら休みを数え直す', () => {
    const { s, watch } = setup();
    s.parked = ['s1'];
    s.on = false;
    watch.tick();
    s.now = 60_000;
    expect(watch.tick()).toEqual([]);
    expect(s.stopped).toEqual([]);
    expect(s.read).toBe(0);
    s.on = true;
    expect(watch.tick()).toEqual([]);
    s.now = 70_000;
    expect(watch.tick()).toEqual(['s1']);
  });

  it('休みが settleMs 続いたら止める。それより前は止めない', () => {
    const { s, watch } = setup();
    s.parked = ['s1'];
    expect(watch.tick()).toEqual([]);
    s.now = 9_999;
    expect(watch.tick()).toEqual([]);
    s.now = 10_000;
    expect(watch.tick()).toEqual(['s1']);
    expect(s.stopped).toEqual(['s1']);
  });

  it('途中で作業中に戻ったら、休みの数え直しになる', () => {
    const { s, watch } = setup();
    s.parked = ['s1'];
    watch.tick();
    s.now = 8_000;
    s.parked = [];
    watch.tick();
    s.now = 9_000;
    s.parked = ['s1'];
    watch.tick();
    s.now = 12_000;
    expect(watch.tick()).toEqual([]);
    s.now = 19_000;
    expect(watch.tick()).toEqual(['s1']);
  });

  it('止めにいくのは、休みが続く間に 1 回だけ。止められない外の会話に何度も手を出さない', () => {
    const { s, watch } = setup({ stoppable: false });
    s.parked = ['s1'];
    watch.tick();
    s.now = 10_000;
    // 止められなかったものは、止めたものとして返さない。
    expect(watch.tick()).toEqual([]);
    s.now = 60_000;
    expect(watch.tick()).toEqual([]);
    expect(s.stopped).toEqual(['s1']);
  });

  it('いちど休みを抜けて、また休みに入ったら、もう一度止めにいく', () => {
    const { s, watch } = setup({ stoppable: false });
    s.parked = ['s1'];
    watch.tick();
    s.now = 10_000;
    watch.tick();
    s.parked = [];
    s.now = 11_000;
    watch.tick();
    s.parked = ['s1'];
    s.now = 12_000;
    watch.tick();
    s.now = 22_000;
    watch.tick();
    expect(s.stopped).toEqual(['s1', 's1']);
  });

  it('動きが変わったと知らされたら、休みの数え直しになる。見回りの合間の一瞬の作業中を見逃さない', () => {
    const { s, watch } = setup();
    s.parked = ['s1'];
    watch.tick();
    s.now = 9_000;
    watch.reset('s1');
    watch.tick();
    s.now = 12_000;
    expect(watch.tick()).toEqual([]);
    s.now = 19_000;
    expect(watch.tick()).toEqual(['s1']);
  });

  it('止める処理が投げても、ほかの会話は止める', () => {
    const s = { now: 0, stopped: [] as string[] };
    const watch = new ParkWatch({ parkedIds: () => ['s1', 's2'], stop: (id) => { if (id === 's1') throw new Error('boom'); s.stopped.push(id); return true; }, now: () => s.now, settleMs: 10_000, log: () => {} });
    watch.tick();
    s.now = 10_000;
    expect(watch.tick()).toEqual(['s2']);
  });
});

describe('statusChanged', () => {
  const prev = new Map<string, LiveSession['status']>([['u1', 'busy'], ['u2', 'idle'], ['u3', 'idle']]);
  it('動きが変わった会話だけを返す。出入りしたものは含めない', () => {
    expect(statusChanged(prev, [live('u1', 'idle'), live('u2', 'idle'), live('u4', 'idle')])).toEqual(['u1']);
  });
});
