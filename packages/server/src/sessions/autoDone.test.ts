import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { AutoDoneWatch, autoDoneCandidates, AUTO_DONE_SETTLE_MS, summaryCandidates } from './autoDone.ts';
import { getSessionState, markAutoDone, proposeSessionState, rejectSessionState, setSessionState } from './states.ts';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const MIN = 60_000;

type Db = ReturnType<typeof openDb>;
function seed() {
  return openDb(':memory:');
}
/** セッションを 1 つ足す。既定はこの端末（d）のもので、10 分前に最後に動いた。 */
function session(db: Db, id: string, o: { device?: string; lastActivityAt?: number | null; turns?: number | null } = {}) {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, cwd: '/w', home_device: o.device ?? 'd', last_activity_at: o.lastActivityAt === undefined ? NOW - 10 * MIN : o.lastActivityAt }, 'd');
  if (o.turns !== null) db.prepare('insert into session_stats (session_id, turns) values (?, ?)').run(id, o.turns ?? 1);
}
function run(db: Db, sessionId: string, o: { endedAt?: number | null } = {}) {
  upsertShared(db, 'runs', { id: `r-${sessionId}-${Math.random()}`, session_id: sessionId, device_id: 'd', kind: 'start', tmux_name: 't', pid: null, launch_params: '{}', started_at: NOW - 60 * MIN, ended_at: o.endedAt === undefined ? NOW - 5 * MIN : o.endedAt, end_reason: 'exited', heartbeat_at: NOW }, 'd');
}
function summary(db: Db, sessionId: string, state: 'in_progress' | 'done' | 'blocked' | 'abandoned', source: 'baseline' | 'in_session' | 'post_hoc' = 'in_session') {
  upsertShared(db, 'session_summaries', { session_id: sessionId, title: 't', one_liner: 'o', body: 'b', state, next_steps: '[]', source, based_on_turns: 1 }, 'd', 'session_id');
}
const cands = (db: Db, o: { live?: string[]; pending?: string[]; idleDays?: number } = {}) =>
  autoDoneCandidates(db, 'd', { liveProviderIds: new Set(o.live ?? []), pending: new Set(o.pending ?? []), now: NOW, idleDays: o.idleDays ?? 0 });
const DAY = 24 * 60 * MIN;

describe('autoDoneCandidates：長く動いていない', () => {
  it('止まって選んだ日数たったものは、ターン数や要約や run に関係なく対象', () => {
    const db = seed();
    session(db, 'old', { turns: 40, lastActivityAt: NOW - 7 * DAY });
    run(db, 'old');
    summary(db, 'old', 'in_progress');
    session(db, 'fresh', { turns: 40, lastActivityAt: NOW - 7 * DAY + MIN });
    expect(cands(db, { idleDays: 7 })).toEqual([{ id: 'old', reason: 'idle' }]);
  });
  it('使い捨てと要約が完了の理由が先に立つ', () => {
    const db = seed();
    session(db, 'short', { turns: 2, lastActivityAt: NOW - 30 * DAY });
    expect(cands(db, { idleDays: 7 })).toEqual([{ id: 'short', reason: 'disposable' }]);
  });
  it('0 日（しない）なら対象にしない', () => {
    const db = seed();
    session(db, 'old', { turns: 40, lastActivityAt: NOW - 300 * DAY });
    expect(cands(db, { idleDays: 0 })).toEqual([]);
  });
  it('最後の動きの時刻が無いものは対象にしない', () => {
    const db = seed();
    session(db, 'unknown', { turns: 40, lastActivityAt: null });
    expect(cands(db, { idleDays: 3 })).toEqual([]);
  });
  it('動いているもの、Paused の提案があるもの、「Active に戻す」の後に動きが無いもの、他の端末のものは除く', () => {
    const db = seed();
    for (const id of ['reg', 'alive', 'prop', 'back']) session(db, id, { turns: 40, lastActivityAt: NOW - 10 * DAY });
    run(db, 'alive', { endedAt: null });
    proposeSessionState(db, 'd', 'prop', { status: 'paused', note: '見る', returnOn: '2026-10-12', source: 'post_hoc', now: NOW - 30 * MIN });
    setSessionState(db, 'd', 'back', { status: null, setBy: 'user', now: NOW - 5 * DAY });
    session(db, 'other', { device: 'd2', turns: 40, lastActivityAt: NOW - 10 * DAY });
    expect(cands(db, { live: ['u-reg'], idleDays: 7 })).toEqual([]);
  });
});

describe('autoDoneCandidates：使い捨て', () => {
  it('hangar の run が一度も無く、3 ターン以下で、止まっているものは使い捨て', () => {
    const db = seed();
    session(db, 's1', { turns: 1 });
    session(db, 's3', { turns: 3 });
    session(db, 's0', { turns: null });
    expect(cands(db)).toEqual(expect.arrayContaining([{ id: 's1', reason: 'disposable' }, { id: 's3', reason: 'disposable' }, { id: 's0', reason: 'disposable' }]));
    expect(cands(db)).toHaveLength(3);
  });
  it('4 ターン以上や、run が 1 本でもあるものは使い捨てにしない', () => {
    const db = seed();
    session(db, 'long', { turns: 4 });
    session(db, 'hangar', { turns: 1 });
    run(db, 'hangar');
    expect(cands(db)).toEqual([]);
  });
});

describe('autoDoneCandidates：要約が完了', () => {
  it('会話の中か事後の要約が「完了」か「中止」なら対象。土台の要約や、進行中・ブロック中は対象にしない', () => {
    const db = seed();
    for (const id of ['in', 'post', 'ab', 'base', 'prog', 'blk']) { session(db, id, { turns: 20 }); run(db, id); }
    summary(db, 'in', 'done', 'in_session');
    summary(db, 'post', 'done', 'post_hoc');
    summary(db, 'ab', 'abandoned');
    summary(db, 'base', 'done', 'baseline');
    summary(db, 'prog', 'in_progress');
    summary(db, 'blk', 'blocked');
    expect(cands(db).sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: 'ab', reason: 'summary' }, { id: 'in', reason: 'summary' }, { id: 'post', reason: 'summary' }]);
  });
  it('外で起こした長いものも、要約が完了なら対象', () => {
    const db = seed();
    session(db, 'ext', { turns: 12 });
    summary(db, 'ext', 'done', 'post_hoc');
    expect(cands(db)).toEqual([{ id: 'ext', reason: 'summary' }]);
  });
});

describe('autoDoneCandidates：除くもの', () => {
  it('動いているもの（登録にある、生きた run がある）と、要約を待っているものは除く', () => {
    const db = seed();
    session(db, 'reg');
    session(db, 'alive', { turns: 9 });
    run(db, 'alive', { endedAt: null });
    summary(db, 'alive', 'done');
    session(db, 'pend');
    expect(cands(db, { live: ['u-reg'], pending: ['pend'] })).toEqual([]);
  });
  it('他の端末のセッションは、その端末に任せる', () => {
    const db = seed();
    session(db, 'other', { device: 'd2' });
    expect(cands(db)).toEqual([]);
  });
  it('状態が付いているもの、Paused の提案があるもの、却下したものは除く', () => {
    const db = seed();
    for (const id of ['set', 'prop', 'rej']) session(db, id);
    setSessionState(db, 'd', 'set', { status: 'paused', note: '見る', returnOn: '2026-10-12', setBy: 'user', now: NOW - 30 * MIN });
    proposeSessionState(db, 'd', 'prop', { status: 'paused', note: '見る', returnOn: '2026-10-12', source: 'post_hoc', now: NOW - 30 * MIN });
    proposeSessionState(db, 'd', 'rej', { status: 'done', note: '済んだ', returnOn: null, source: 'post_hoc', now: NOW - 30 * MIN });
    rejectSessionState(db, 'd', 'rej', NOW - 20 * MIN);
    expect(cands(db)).toEqual([]);
  });
  it('Done の提案があるものは対象にする（同じ向きなので確かめるまでもない）', () => {
    const db = seed();
    session(db, 'prop');
    proposeSessionState(db, 'd', 'prop', { status: 'done', note: '済んだ', returnOn: null, source: 'post_hoc', now: NOW - 30 * MIN });
    expect(cands(db)).toEqual([{ id: 'prop', reason: 'disposable' }]);
  });
  it('「Active に戻す」の後に動きが無いものは除く。戻した後に動いていれば対象に戻る', () => {
    const db = seed();
    session(db, 'back', { lastActivityAt: NOW - 30 * MIN });
    setSessionState(db, 'd', 'back', { status: null, setBy: 'user', now: NOW - 20 * MIN });
    expect(cands(db)).toEqual([]);
    session(db, 'back', { lastActivityAt: NOW - 10 * MIN, turns: null });
    expect(cands(db)).toEqual([{ id: 'back', reason: 'disposable' }]);
  });
  it('消したセッションは除く', () => {
    const db = seed();
    session(db, 'gone');
    db.prepare('update sessions set deleted_at = ? where id = ?').run(NOW, 'gone');
    expect(cands(db)).toEqual([]);
  });
});

describe('markAutoDone', () => {
  it('Done にし、利用者が決めたものではないので set_by は import、提案は消す', () => {
    const db = seed();
    session(db, 's1');
    proposeSessionState(db, 'd', 's1', { status: 'done', note: '済んだ', returnOn: null, source: 'post_hoc', now: NOW - 30 * MIN });
    expect(markAutoDone(db, 'd', 's1', NOW)).toBe(true);
    expect(getSessionState(db, 's1')).toEqual({ status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'import', setAt: NOW, candidate: null });
  });
  it('書く直前に状態が付いていたら書かない', () => {
    const db = seed();
    session(db, 's1');
    setSessionState(db, 'd', 's1', { status: 'paused', note: '見る', returnOn: '2026-10-12', setBy: 'user', now: NOW - MIN });
    expect(markAutoDone(db, 'd', 's1', NOW)).toBe(false);
    expect(getSessionState(db, 's1')?.status).toBe('paused');
  });
});

describe('summaryCandidates', () => {
  it('外で起こした 4 ターン以上で、要約が土台のまま、since より後に止まったものを返す', () => {
    const db = seed();
    session(db, 'ext', { turns: 8 });
    summary(db, 'ext', 'done', 'baseline');
    session(db, 'nosum', { turns: 8 });
    session(db, 'short', { turns: 2 });
    session(db, 'old', { turns: 8, lastActivityAt: NOW - 120 * MIN });
    session(db, 'real', { turns: 8 });
    summary(db, 'real', 'in_progress', 'in_session');
    session(db, 'hangar', { turns: 8 });
    run(db, 'hangar');
    session(db, 'live', { turns: 8 });
    const got = summaryCandidates(db, 'd', { liveProviderIds: new Set(['u-live']), since: NOW - 60 * MIN }).sort();
    expect(got).toEqual(['ext', 'nosum']);
  });
});

describe('AutoDoneWatch', () => {
  function watch(o: { cands: () => { id: string; reason: 'disposable' | 'summary' }[]; toSummarize?: () => string[]; enabled?: () => boolean }) {
    let now = NOW;
    const marked: string[] = [];
    const enqueued: string[] = [];
    const w = new AutoDoneWatch({ candidates: o.cands, mark: (id) => { marked.push(id); return true; }, toSummarize: o.toSummarize ?? (() => []), enqueue: (id) => { enqueued.push(id); }, now: () => now, ...(o.enabled ? { enabled: o.enabled } : {}) });
    return { w, marked, enqueued, advance: (ms: number) => { now += ms; } };
  }
  it('続けて対象だったものを、60 秒たってから 1 回だけ Done にする', () => {
    const t = watch({ cands: () => [{ id: 's1', reason: 'disposable' }] });
    expect(t.w.tick()).toEqual([]);
    t.advance(AUTO_DONE_SETTLE_MS - 1);
    expect(t.w.tick()).toEqual([]);
    t.advance(1);
    expect(t.w.tick()).toEqual(['s1']);
    expect(t.marked).toEqual(['s1']);
  });
  it('途中で対象から外れたら数え直す（再起動や hangar への移動の隙）', () => {
    let list = [{ id: 's1', reason: 'disposable' as const }];
    const t = watch({ cands: () => list });
    t.w.tick();
    t.advance(30_000);
    list = [];
    t.w.tick();
    list = [{ id: 's1', reason: 'disposable' }];
    t.advance(30_000);
    expect(t.w.tick()).toEqual([]);
    t.advance(AUTO_DONE_SETTLE_MS);
    expect(t.w.tick()).toEqual(['s1']);
  });
  it('事後要約の候補は、同じセッションを 1 回だけ待ち行列へ入れる', () => {
    const t = watch({ cands: () => [], toSummarize: () => ['e1'] });
    t.w.tick();
    t.w.tick();
    expect(t.enqueued).toEqual(['e1']);
  });
  it('設定で切っている間は、Done にせず、事後要約も入れない。入れ直したら数え始めからやり直す', () => {
    let on = false;
    let cands = 0;
    const t = watch({ cands: () => { cands++; return [{ id: 's1', reason: 'disposable' }]; }, toSummarize: () => ['e1'], enabled: () => on });
    t.w.tick();
    t.advance(AUTO_DONE_SETTLE_MS * 3);
    expect(t.w.tick()).toEqual([]);
    expect(t.marked).toEqual([]);
    expect(t.enqueued).toEqual([]);
    // 切っている間は、候補を引きにも行かない。
    expect(cands).toBe(0);
    on = true;
    expect(t.w.tick()).toEqual([]);
    t.advance(AUTO_DONE_SETTLE_MS);
    expect(t.w.tick()).toEqual(['s1']);
    expect(t.enqueued).toEqual(['e1']);
  });
  it('入りから切りへ替えたら、それまでの数えを捨てる', () => {
    let on = true;
    const t = watch({ cands: () => [{ id: 's1', reason: 'disposable' }], enabled: () => on });
    t.w.tick();
    t.advance(AUTO_DONE_SETTLE_MS - 1);
    on = false;
    t.w.tick();
    on = true;
    t.advance(1);
    expect(t.w.tick()).toEqual([]);
  });
});
