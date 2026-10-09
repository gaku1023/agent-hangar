import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeOut, ServerEvent } from '@agent-hangar/shared';
import { addManualArtifact } from '../artifacts/queries.ts';
import { noteApplied, touchRow } from '../db/notify.ts';
import { openDb, type Db } from '../db/open.ts';
import { getProject, getSession, listDevices } from '../db/queries.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { applyRemoteBatch } from '../sync/apply.ts';
import { Publisher } from './publisher.ts';

const ME = 'dev-me';
const OTHER = 'dev-other';

const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

/** 実物の DB と偽の hub で配る層を組む。届いたイベントを貯める。 */
function setup(opts: { active?: () => boolean } = {}) {
  const db = openDb(':memory:');
  const sent: ServerEvent[] = [];
  const publisher = new Publisher({ db, deviceId: ME, live: () => [], hub: { broadcast: (ev) => { sent.push(ev); } }, active: opts.active });
  stops.push(() => publisher.stop());
  const types = () => sent.map((e) => e.type);
  /** 貯めた分を捨てて、次の確かめを新しく始める。 */
  const reset = () => { publisher.flush(); sent.length = 0; };
  return { db, sent, publisher, types, reset };
}

function seedProject(db: Db, id = 'p1', dir = '/work/p1'): void {
  upsertShared(db, 'projects', { id, name: id, status: 'active', is_scratch: 0 }, ME);
  upsertShared(db, 'project_roots', { id: `root-${id}`, project_id: id, device_id: ME, path: dir, resolved: 1 }, ME);
}
function seedSession(db: Db, id = 's1', projectId: string | null = null): void {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `uuid-${id}`, project_id: projectId, cwd: '/work/p1', home_device: ME }, ME);
}
/** 他端末で生きている run。SessionDto のロックの元になる。 */
function seedOtherRun(db: Db, id = 'r1', sessionId = 's1'): void {
  upsertShared(db, 'devices', { id: OTHER, name: 'もう 1 台', platform: 'darwin', last_seen_at: 1 }, OTHER);
  upsertShared(db, 'runs', { id, session_id: sessionId, device_id: OTHER, kind: 'start', tmux_name: 't', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: Date.now() }, OTHER);
}
const upserts = (sent: ServerEvent[]) => sent.filter((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert');

describe('表から DTO とイベントへ', () => {
  it('sessions の行が変わると、その行を読み直した session.upsert を 1 つ配る', () => {
    const t = setup();
    seedSession(t.db);
    t.publisher.flush();
    expect(t.sent).toEqual([{ type: 'session.upsert', session: getSession(t.db, [], 's1', { deviceId: ME }) }]);
  });

  it('知らせを受けた時点では配らず、同じ tick の終わり（マイクロタスク）で配る', async () => {
    const t = setup();
    seedSession(t.db);
    expect(t.sent).toEqual([]);
    await Promise.resolve();
    expect(t.types()).toEqual(['session.upsert']);
  });

  it('同じ tick の中で同じ行が何度変わっても、配るのは 1 回で、中身は最後の状態である', () => {
    const t = setup();
    seedSession(t.db);
    const row = t.db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
    upsertShared(t.db, 'sessions', { ...row, memo: '1 回目' }, ME);
    upsertShared(t.db, 'sessions', { ...row, memo: '2 回目' }, ME);
    touchRow(t.db, 'sessions', 's1');
    t.publisher.flush();
    expect(upserts(t.sent)).toHaveLength(1);
    expect(upserts(t.sent)[0]!.session.memo).toBe('2 回目');
  });

  it('tick が分かれれば、それぞれで配る', () => {
    const t = setup();
    seedSession(t.db);
    t.publisher.flush();
    touchRow(t.db, 'sessions', 's1');
    t.publisher.flush();
    expect(t.types()).toEqual(['session.upsert', 'session.upsert']);
  });

  it('ロックの判定に要る端末の ID は、この層が渡す。呼び手は何も渡さない', () => {
    const t = setup();
    seedSession(t.db);
    seedOtherRun(t.db);
    t.reset();
    touchRow(t.db, 'sessions', 's1');
    t.publisher.flush();
    expect(upserts(t.sent)[0]!.session.lock).toMatchObject({ deviceId: OTHER, deviceName: 'もう 1 台', runId: 'r1' });
  });

  it('session_summaries と session_states の行は、そのセッションの session.upsert になる', () => {
    const t = setup();
    seedSession(t.db);
    t.reset();
    upsertShared(t.db, 'session_summaries', { session_id: 's1', title: '題', one_liner: '一行', body: '本文', state: 'done', next_steps: '[]', source: 'in_session', source_id: null, source_model: null, based_on_turns: 1 }, ME, 'session_id');
    t.publisher.flush();
    expect(upserts(t.sent).map((e) => e.session.summary?.title)).toEqual(['題']);
    t.reset();
    noteApplied(t.db, 'session_states', 's1', 'upsert');
    t.publisher.flush();
    expect(upserts(t.sent).map((e) => e.session.id)).toEqual(['s1']);
  });

  it('runs の行は、同期で降りたときだけ持ち主のセッションを配る。手元の run の変化は run.* の明示のイベントが運ぶ', () => {
    const t = setup();
    seedSession(t.db);
    t.reset();
    seedOtherRun(t.db);
    t.publisher.flush();
    // devices の行は devices.update になる。runs の手元の書き込みは何も配らない。
    expect(t.types()).toEqual(['devices.update']);
    t.reset();
    noteApplied(t.db, 'runs', 'r1', 'upsert');
    t.publisher.flush();
    expect(upserts(t.sent).map((e) => e.session.id)).toEqual(['s1']);
    expect(upserts(t.sent)[0]!.session.lock?.runId).toBe('r1');
    // 行が見つからない run は、配る先が無い。
    t.reset();
    noteApplied(t.db, 'runs', 'nope', 'upsert');
    t.publisher.flush();
    expect(t.sent).toEqual([]);
  });

  it('projects と project_roots の行は、そのプロジェクトの project.upsert になる', () => {
    const t = setup();
    seedProject(t.db);
    t.publisher.flush();
    expect(t.sent).toEqual([{ type: 'project.upsert', project: getProject(t.db, ME, [], 'p1') }]);
  });

  it('この端末のルートが消えた書き込みでは、何も配らない。遷移を知っている checkRoots が project.unresolved を手で渡す', () => {
    const t = setup();
    seedProject(t.db);
    t.reset();
    const root = t.db.prepare('select * from project_roots where id = ?').get('root-p1') as Record<string, unknown>;
    upsertShared(t.db, 'project_roots', { ...root, resolved: 0 }, ME);
    t.publisher.flush();
    expect(t.sent).toEqual([]);
    upsertShared(t.db, 'project_roots', { ...root, resolved: 1 }, ME);
    t.publisher.flush();
    expect(t.types()).toEqual(['project.upsert']);
  });

  it('未解決のままのこの端末のルートが同期で降りても名指しされても、project.unresolved は出さず project.upsert にする', () => {
    // project.unresolved は画面で置き場の選び直しを開く。解決済みから未解決へ移ったときだけ出すものである。
    const t = setup();
    seedProject(t.db);
    const root = t.db.prepare('select * from project_roots where id = ?').get('root-p1') as Record<string, unknown>;
    upsertShared(t.db, 'project_roots', { ...root, resolved: 0 }, ME);
    t.reset();
    noteApplied(t.db, 'project_roots', 'root-p1', 'upsert');
    t.publisher.flush();
    expect(t.types()).toEqual(['project.upsert']);
    t.reset();
    touchRow(t.db, 'project_roots', 'root-p1');
    t.publisher.flush();
    expect(t.types()).toEqual(['project.upsert']);
  });

  it('他端末のルートは、解決していなくても project.upsert である', () => {
    const t = setup();
    seedProject(t.db);
    t.reset();
    upsertShared(t.db, 'project_roots', { id: 'root-other', project_id: 'p1', device_id: OTHER, path: '/elsewhere', resolved: 0 }, OTHER);
    t.publisher.flush();
    expect(t.types()).toEqual(['project.upsert']);
  });

  it('devices の行は、一覧ごとの devices.update になる', () => {
    const t = setup();
    upsertShared(t.db, 'devices', { id: ME, name: 'この PC', platform: 'darwin', last_seen_at: 2 }, ME);
    upsertShared(t.db, 'devices', { id: OTHER, name: 'もう 1 台', platform: 'darwin', last_seen_at: 1 }, OTHER);
    t.publisher.flush();
    expect(t.sent).toEqual([{ type: 'devices.update', devices: listDevices(t.db, ME) }]);
  });

  it('project_memos の行は memo.update と、メモの頭を載せるプロジェクトの project.upsert になる', () => {
    const t = setup();
    seedProject(t.db);
    t.reset();
    upsertShared(t.db, 'project_memos', { project_id: 'p1', markdown: '# メモ', deleted_at: null }, ME, 'project_id');
    t.publisher.flush();
    expect(t.types()).toEqual(['memo.update', 'project.upsert']);
    expect(t.sent[0]).toMatchObject({ type: 'memo.update', memo: { projectId: 'p1', markdown: '# メモ' } });
    expect(t.sent[1]).toMatchObject({ type: 'project.upsert', project: { id: 'p1', memoHead: '# メモ' } });
  });

  it('artifacts の行は artifact.upsert になる', () => {
    const t = setup();
    seedProject(t.db);
    t.reset();
    const a = addManualArtifact(t.db, ME, 'p1', 'https://claude.ai/code/artifact/abc123');
    t.publisher.flush();
    expect(t.sent).toEqual([{ type: 'artifact.upsert', artifact: a }]);
  });

  it('メモとアーティファクトは、同期で降りた行では配らない（今の画面と同じ）', () => {
    const t = setup();
    seedProject(t.db);
    upsertShared(t.db, 'project_memos', { project_id: 'p1', markdown: 'm', deleted_at: null }, ME, 'project_id');
    const a = addManualArtifact(t.db, ME, 'p1', 'https://claude.ai/code/artifact/abc123');
    t.reset();
    noteApplied(t.db, 'project_memos', 'p1', 'upsert');
    noteApplied(t.db, 'artifacts', a.id, 'upsert');
    t.publisher.flush();
    expect(t.sent).toEqual([]);
  });

  it('todos の行は、そのプロジェクトの一覧ごとの todos.update と、未完の数を載せる project.upsert になる', () => {
    const t = setup();
    seedProject(t.db);
    t.reset();
    upsertShared(t.db, 'todos', { id: 't1', project_id: 'p1', text: 'やる', done: 0, position: 1, session_id: null }, ME);
    upsertShared(t.db, 'todos', { id: 't2', project_id: 'p1', text: 'もう 1 つ', done: 0, position: 2, session_id: null }, ME);
    t.publisher.flush();
    expect(t.types()).toEqual(['todos.update', 'project.upsert']);
    expect(t.sent[0]).toMatchObject({ type: 'todos.update', projectId: 'p1', todos: [{ id: 't1' }, { id: 't2' }] });
    expect(t.sent[1]).toMatchObject({ type: 'project.upsert', project: { id: 'p1', openTodoCount: 2 } });
  });

  it('消した TODO も、残りの一覧を配る', () => {
    const t = setup();
    seedProject(t.db);
    upsertShared(t.db, 'todos', { id: 't1', project_id: 'p1', text: 'やる', done: 0, position: 1, session_id: null }, ME);
    t.reset();
    softDeleteShared(t.db, 'todos', 't1', ME);
    t.publisher.flush();
    expect(t.sent[0]).toEqual({ type: 'todos.update', projectId: 'p1', todos: [] });
    expect(t.sent[1]).toMatchObject({ type: 'project.upsert', project: { openTodoCount: 0 } });
  });

  it('TODO は、同期で降りた行では配らない（今の画面と同じ）', () => {
    const t = setup();
    seedProject(t.db);
    upsertShared(t.db, 'todos', { id: 't1', project_id: 'p1', text: 'やる', done: 0, position: 1, session_id: null }, ME);
    t.reset();
    noteApplied(t.db, 'todos', 't1', 'upsert');
    t.publisher.flush();
    expect(t.sent).toEqual([]);
  });

  it('対応の無い表と、知らない表は無視する', () => {
    const t = setup();
    seedProject(t.db);
    t.reset();
    touchRow(t.db, 'no_such_table', 'x');
    noteApplied(t.db, 'run_tabs', 'tab1', 'upsert');
    t.publisher.flush();
    expect(t.sent).toEqual([]);
  });

  it('消えた行は配らない（読み直して無ければ何も送らない）', () => {
    const t = setup();
    seedProject(t.db);
    seedSession(t.db);
    t.reset();
    softDeleteShared(t.db, 'sessions', 's1', ME);
    softDeleteShared(t.db, 'projects', 'p1', ME);
    touchRow(t.db, 'sessions', 'never-existed');
    t.publisher.flush();
    expect(t.sent).toEqual([]);
  });

  it('別の DB の知らせは拾わない', () => {
    const t = setup();
    const other = openDb(':memory:');
    seedSession(other);
    t.publisher.flush();
    expect(t.sent).toEqual([]);
  });

  it('1 つの組み立てが失敗しても、残りは配る', () => {
    const t = setup();
    seedSession(t.db, 's1');
    seedSession(t.db, 's2');
    t.reset();
    let first = true;
    const failing = new Publisher({ db: t.db, deviceId: ME, live: () => { if (first) { first = false; throw new Error('読めない'); } return []; }, hub: { broadcast: (ev) => { t.sent.push(ev); } } });
    stops.push(() => failing.stop());
    t.publisher.stop();
    touchRow(t.db, 'sessions', 's1');
    touchRow(t.db, 'sessions', 's2');
    failing.flush();
    expect(upserts(t.sent).map((e) => e.session.id)).toEqual(['s2']);
  });
});

describe('明示のイベントとの畳み込み', () => {
  const toast = (message: string): ServerEvent => ({ type: 'toast', level: 'info', message });

  it('明示のイベントも同じ列に並び、呼んだ順に届く', () => {
    const t = setup();
    t.publisher.broadcast(toast('1'));
    seedSession(t.db);
    t.publisher.broadcast(toast('2'));
    expect(t.sent).toEqual([]);
    t.publisher.flush();
    expect(t.types()).toEqual(['toast', 'session.upsert', 'toast']);
  });

  it('同じ行を後からもう一度知らせると、並びは最後に知らせた位置になる', () => {
    const t = setup();
    seedSession(t.db);
    t.publisher.broadcast(toast('間'));
    touchRow(t.db, 'sessions', 's1');
    t.publisher.flush();
    expect(t.types()).toEqual(['toast', 'session.upsert']);
  });

  it('呼び手が同じ行のイベントを手で配った tick では、この層は重ねて配らない。届くのは呼び手の 1 つである', () => {
    const t = setup();
    seedSession(t.db);
    const mine = { ...getSession(t.db, [], 's1', { deviceId: ME })!, memo: '呼び手が組んだもの' };
    t.publisher.broadcast({ type: 'session.upsert', session: mine });
    t.publisher.flush();
    expect(t.sent).toEqual([{ type: 'session.upsert', session: mine }]);
  });

  it('書いた後に手で配れば、トランザクションの中の書き込みでも 1 つにまとまり、届く中身は最新である', async () => {
    const t = setup();
    seedProject(t.db);
    t.reset();
    const row = t.db.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>;
    t.db.transaction(() => { upsertShared(t.db, 'projects', { ...row, status: 'paused' }, ME); })();
    // 確定を待つ知らせはまだ届いていない。書いた後に組んだ手の配りが先に並ぶ。
    const p = getProject(t.db, ME, [], 'p1')!;
    t.publisher.broadcast({ type: 'project.upsert', project: p });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sent).toEqual([{ type: 'project.upsert', project: p }]);
    expect(p.status).toBe('paused');
  });

  it('手で配った後に同じ行がまた書かれたら、最後に届くのは最新の中身である', () => {
    const t = setup();
    seedSession(t.db);
    t.reset();
    const row = t.db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
    upsertShared(t.db, 'sessions', { ...row, memo: 'v1' }, ME);
    t.publisher.broadcast({ type: 'session.upsert', session: getSession(t.db, [], 's1', { deviceId: ME })! });
    upsertShared(t.db, 'sessions', { ...row, memo: 'v2' }, ME);
    t.publisher.flush();
    expect(upserts(t.sent).at(-1)!.session.memo).toBe('v2');
  });

  it('手の配りの後、配る前に別の流れ（先に並んでいたマイクロタスク）が同じ行を書いても、最新の中身が届く', async () => {
    const t = setup();
    seedSession(t.db);
    t.reset();
    const row = t.db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
    // 準備で並んだこの層の番を先に済ませ、ここからの並びだけにする。
    await Promise.resolve();
    // 索引の続きのように、この層の番より前に並んでいた仕事。
    queueMicrotask(() => { upsertShared(t.db, 'sessions', { ...row, memo: 'v2' }, ME); });
    upsertShared(t.db, 'sessions', { ...row, memo: 'v1' }, ME);
    t.publisher.broadcast({ type: 'session.upsert', session: getSession(t.db, [], 's1', { deviceId: ME })! });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(upserts(t.sent).at(-1)!.session.memo).toBe('v2');
  });

  it('手で配った後にトランザクションの中でまた書かれても、最新の中身が届く', async () => {
    const t = setup();
    seedSession(t.db);
    t.reset();
    const row = t.db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
    t.publisher.broadcast({ type: 'session.upsert', session: getSession(t.db, [], 's1', { deviceId: ME })! });
    t.db.transaction(() => { upsertShared(t.db, 'sessions', { ...row, memo: 'v2' }, ME); })();
    await Promise.resolve();
    await Promise.resolve();
    expect(upserts(t.sent).at(-1)!.session.memo).toBe('v2');
  });

  it('呼び手が同じイベントを 2 回手で配れば、今までどおり 2 回届く', () => {
    const t = setup();
    seedSession(t.db);
    const s = getSession(t.db, [], 's1', { deviceId: ME })!;
    t.publisher.broadcast({ type: 'session.upsert', session: s });
    t.publisher.broadcast({ type: 'session.upsert', session: s });
    t.publisher.flush();
    expect(t.types()).toEqual(['session.upsert', 'session.upsert']);
  });

  it('手で配ったのが別の行なら、この層の分は残る', () => {
    const t = setup();
    seedSession(t.db, 's1');
    seedSession(t.db, 's2');
    t.reset();
    touchRow(t.db, 'sessions', 's1');
    t.publisher.broadcast({ type: 'session.upsert', session: getSession(t.db, [], 's2', { deviceId: ME })! });
    t.publisher.flush();
    expect(upserts(t.sent).map((e) => e.session.id)).toEqual(['s1', 's2']);
  });

  it('受け手がいなければ行を読み直さない。明示のイベントはそのまま渡す', () => {
    let active = false;
    let reads = 0;
    const db = openDb(':memory:');
    const sent: ServerEvent[] = [];
    const publisher = new Publisher({ db, deviceId: ME, live: () => { reads++; return []; }, hub: { broadcast: (ev) => { sent.push(ev); } }, active: () => active });
    stops.push(() => publisher.stop());
    seedSession(db);
    publisher.broadcast(toast('x'));
    publisher.flush();
    expect(sent.map((e) => e.type)).toEqual(['toast']);
    expect(reads).toBe(0);
    active = true;
    touchRow(db, 'sessions', 's1');
    publisher.flush();
    expect(sent.map((e) => e.type)).toEqual(['toast', 'session.upsert']);
  });

  it('止めた後は、溜まっていた分も新しい知らせも配らない', async () => {
    const t = setup();
    seedSession(t.db);
    t.publisher.broadcast(toast('x'));
    t.publisher.stop();
    touchRow(t.db, 'sessions', 's1');
    t.publisher.broadcast(toast('y'));
    t.publisher.flush();
    await Promise.resolve();
    expect(t.sent).toEqual([]);
  });
});

describe('同期で降りた行', () => {
  const change = (seq: number, tableName: ChangeOut['tableName'], rowId: string, payload: Record<string, unknown>, updatedAt = Date.now() + 60_000): ChangeOut =>
    ({ seq, tableName, rowId, op: 'upsert', deviceId: OTHER, updatedAt, payload });

  it('1 回の適用で同じセッションの行がいくつ降りても session.upsert は 1 つで、他端末の run のロックが載る', () => {
    const t = setup();
    seedProject(t.db);
    seedSession(t.db, 's1', 'p1');
    t.reset();
    const applied = applyRemoteBatch(t.db, [
      change(1, 'devices', OTHER, { name: 'もう 1 台', platform: 'darwin', last_seen_at: 5 }),
      change(2, 'projects', 'p1', { name: '改名', status: 'active', is_scratch: 0 }),
      change(3, 'sessions', 's1', { provider: 'claude-code', provider_session_id: 'uuid-s1', project_id: 'p1', cwd: '/work/p1', home_device: ME, memo: '向こうで書いた' }),
      change(4, 'runs', 'r9', { session_id: 's1', device_id: OTHER, kind: 'resume', tmux_name: 't', pid: null, launch_params: '{}', started_at: 1, ended_at: null, end_reason: null, heartbeat_at: Date.now() }),
      change(5, 'session_states', 's1', { status: 'paused', note: '明日', return_on: '2099-01-01', set_by: 'user', set_at: 1 }),
    ], { ownDeviceId: ME, skipOwn: true, home: '/nonexistent-home' });
    expect(applied).toHaveLength(5);
    t.publisher.flush();
    expect(t.types().sort()).toEqual(['devices.update', 'project.upsert', 'session.upsert']);
    const s = upserts(t.sent)[0]!.session;
    expect(s).toEqual(getSession(t.db, [], 's1', { deviceId: ME }));
    expect(s.memo).toBe('向こうで書いた');
    expect(s.state?.status).toBe('paused');
    expect(s.lock).toMatchObject({ deviceId: OTHER, runId: 'r9' });
    expect(t.sent.find((e) => e.type === 'project.upsert')).toEqual({ type: 'project.upsert', project: getProject(t.db, ME, [], 'p1') });
    expect(t.sent.find((e) => e.type === 'devices.update')).toEqual({ type: 'devices.update', devices: listDevices(t.db, ME) });
  });

  it('採らなかった行（手元の方が新しい）は配らない', () => {
    const t = setup();
    seedSession(t.db);
    t.reset();
    expect(applyRemoteBatch(t.db, [change(1, 'sessions', 's1', { memo: '古い' }, 1)], { ownDeviceId: ME, skipOwn: true, home: '/nonexistent-home' })).toEqual([]);
    t.publisher.flush();
    expect(t.sent).toEqual([]);
  });
});
