import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { fuzzyScore, presentPalette } from './palette.ts';
import { presentPromote, presentPromoted } from './promote.ts';

const project = (id: string, name: string, isScratch = false): ProjectDto => ({ id, name, status: 'active', isScratch, path: '/w/' + name, resolved: true, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, name: string, oneLiner: string | null): SessionDto => ({
  id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p1', name, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null,
  summary: oneLiner ? { title: name, oneLiner, body: '', state: 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 1, updatedAt: 1 } : null,
  fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null,
});

const withPalette = () => ({ ...initialState(), overlay: { kind: 'palette' as const } });
const store = (): Store => ({ ...initialStore(), projects: { p1: project('p1', 'alpha'), sc: project('sc', 'スクラッチ', true) }, sessions: { s1: session('s1', '動画の変換', '動画を mp4 に変換した'), s2: session('s2', 'ログの整理', null) } });

describe('fuzzyScore', () => {
  it('部分列で一致し、前で連続するほど高い', () => {
    expect(fuzzyScore('abc', 'xyz')).toBe(0);
    expect(fuzzyScore('abc', 'abcdef')).toBeGreaterThan(fuzzyScore('abc', 'a1b2c3'));
    expect(fuzzyScore('abc', 'abcdef')).toBeGreaterThan(fuzzyScore('abc', 'zzzzabcdef'));
    expect(fuzzyScore('ABC', 'abcdef')).toBeGreaterThan(0);
    expect(fuzzyScore('', 'なんでも')).toBe(1);
    expect(fuzzyScore('abcd', 'abc')).toBe(0);
  });
});

const NOW = 10_000_000;
const MIN = 60_000;
const at = (s: SessionDto, patch: Partial<SessionDto>): SessionDto => ({ ...s, ...patch });
/** 入力待ち 1 件、実行中 1 件、終わったもの 7 件、プロジェクト 6 件の手元。 */
const busy = (): Store => {
  const base = store();
  const projects: Record<string, ProjectDto> = { ...base.projects };
  for (let i = 0; i < 5; i++) projects[`q${i}`] = { ...project(`q${i}`, `proj-${i}`), lastActivityAt: 100 + i };
  const sessions: Record<string, SessionDto> = {
    w1: at(session('w1', '認証の期限切れを直す', null), { live: 'waiting', lastActivityAt: NOW - 4 * MIN }),
    b1: at(session('b1', '検索の索引を分ける', null), { live: 'busy', startedAt: NOW - 7 * MIN, lastActivityAt: NOW }),
    i1: at(session('i1', '差分表示の色を直す', null), { live: 'idle', lastActivityAt: NOW - 12 * MIN }),
  };
  for (let i = 0; i < 7; i++) sessions[`e${i}`] = at(session(`e${i}`, `終わった ${i}`, null), { lastActivityAt: NOW - (i + 1) * 60 * MIN });
  return { ...base, projects, sessions };
};
const titles = (p: ReturnType<typeof presentPalette>) => p!.sections.map((x) => x.title);
const ids = (p: ReturnType<typeof presentPalette>, title: string) => p!.sections.find((x) => x.title === title)!.items.map((i) => i.id);
const item = (p: ReturnType<typeof presentPalette>, id: string) => p!.sections.flatMap((x) => x.items).find((i) => i.id === id)!;

describe('presentPalette（何も打っていないとき）', () => {
  it('パレットが開いていなければ null', () => {
    expect(presentPalette(initialState(), store(), '', NOW)).toBeNull();
  });
  it('入力待ち、最近、操作、設定の 4 群に並べる。実行中とプロジェクトの群は出さない', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(p.query).toBe('');
    expect(p.noMatch).toBe(false);
    expect(titles(p)).toEqual(['入力待ち', '最近', '操作', '設定']);
    expect(ids(p, '入力待ち')).toEqual(['session:w1']);
    // 作業中とアイドルの名前はサイドバーの「実行中」にあるので、ここには出さない。
    const all = p.sections.flatMap((x) => x.items.map((i) => i.id));
    expect(all).not.toContain('session:b1');
    expect(all).not.toContain('session:i1');
    expect(all.some((id) => id.startsWith('project:'))).toBe(false);
  });
  it('空白だけの入力も、何も打っていないのと同じに扱う', () => {
    expect(titles(presentPalette(withPalette(), busy(), '  ', NOW))).toEqual(titles(presentPalette(withPalette(), busy(), '', NOW)));
  });
  it('入力待ちが 4 本の朝でも、操作と設定の群まで 16 行前後に収まる', () => {
    const st = busy();
    for (const id of ['w2', 'w3', 'w4']) st.sessions[id] = at(session(id, `待ち ${id}`, null), { live: 'waiting', lastActivityAt: NOW - 9 * MIN });
    const p = presentPalette(withPalette(), st, '', NOW)!;
    const rows = p.sections.reduce((n, x) => n + x.items.length, 0);
    expect(ids(p, '入力待ち')).toHaveLength(4);
    expect(rows).toBe(16);
  });
  it('セッションの行には状態の点とプロジェクト名、右に待った長さや経った時間を添える', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(item(p, 'session:w1')).toMatchObject({ label: '認証の期限切れを直す', kind: 'session', lead: { kind: 'dot', live: 'waiting' }, sub: 'alpha', meta: '4 分待っている' });
    expect(item(p, 'session:e0')).toMatchObject({ lead: { kind: 'dot', live: null }, meta: '1 時間前' });
  });
  it('区切りを付けて休みのまま残っているものは、実行中ではなく最近に、終わったものと同じ見た目で置く', () => {
    const st = busy();
    st.sessions.i1 = at(st.sessions.i1!, { parked: true, state: { status: 'paused', note: '明日見る', returnOn: '2026-10-03', returnTime: null, setBy: 'conversation', setAt: NOW - MIN, candidate: null } });
    const p = presentPalette(withPalette(), st, '', NOW)!;
    expect(ids(p, '最近')[0]).toBe('session:i1');
    expect(item(p, 'session:i1')).toMatchObject({ lead: { kind: 'dot', live: null }, meta: '12 分前' });
  });
  it('最近は終わったものを新しい順に 3 件まで。切ったら「上位 3」だけを添え、全件の数は出さない', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    const recent = p.sections.find((x) => x.title === '最近')!;
    expect(recent.items.map((i) => i.id)).toEqual(['session:e0', 'session:e1', 'session:e2']);
    expect(recent.count).toBeNull();
    expect(recent.limit).toBe('上位 3');
    // 切っていない群には上限の印を付けない。
    const waiting = p.sections.find((x) => x.title === '入力待ち')!;
    expect(waiting).toMatchObject({ count: 1, limit: null });
  });
  it('操作の群は、新しいセッション、スクラッチ、次の入力待ち、新しいプロジェクト、キーの一覧で、打鍵はキーの表から引く', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(ids(p, '操作')).toEqual(['cmd:new-session', 'cmd:new-scratch', 'cmd:next-waiting', 'cmd:new-project', 'cmd:shortcuts']);
    expect(item(p, 'cmd:new-session')).toMatchObject({ label: '新しいセッション', keys: '⌘N', kind: 'command', lead: { kind: 'icon', icon: 'add' } });
    expect(item(p, 'cmd:new-scratch').keys).toBe('⌘⇧N');
    expect(item(p, 'cmd:next-waiting').keys).toBe('⌘I');
    expect(item(p, 'cmd:shortcuts').keys).toBe('? / ⌘/');
    // 次の入力待ちへは、移る先のセッションの名前を添える。
    expect(item(p, 'cmd:next-waiting').sub).toBe('認証の期限切れを直す');
    expect(item(presentPalette(withPalette(), store(), '', NOW), 'cmd:next-waiting').sub).toBe('');
  });
  it('「セッション一覧へ」の行は無い。ホームへ移る行は、打ったときだけ出る', () => {
    const empty = presentPalette(withPalette(), busy(), '', NOW)!;
    const all = empty.sections.flatMap((x) => x.items);
    expect(all.some((i) => i.id === 'go:sessions' || i.label === 'セッション一覧へ')).toBe(false);
    expect(all.some((i) => i.id === 'go:home')).toBe(false);
    expect(ids(presentPalette(withPalette(), busy(), 'ホーム', NOW), '操作')).toContain('go:home');
  });
  it('設定の群は節への行き先で、設定の添え書きを付ける。保持は一般の節へ移る', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(ids(p, '設定')).toEqual(['settings:general', 'settings:cloud', 'settings:integrations', 'settings:retention']);
    expect(p.sections.find((x) => x.title === '設定')!.items.map((i) => i.label)).toEqual(['一般', 'クラウド同期', '連携', 'トランスクリプトの保持']);
    expect(item(p, 'settings:cloud')).toMatchObject({ kind: 'command', sub: '設定', lead: { kind: 'icon', icon: 'cloud' } });
  });
  it('新しいセッションは、いまの画面のプロジェクトを最初から選ぶ', () => {
    const onProject = { ...withPalette(), screen: { name: 'project' as const, id: 'p1' } };
    expect(ids(presentPalette(onProject, busy(), '', NOW), '操作')[0]).toBe('cmd:new-session:project:p1');
    const onSession = { ...withPalette(), screen: { name: 'session' as const, id: 'w1' } };
    expect(ids(presentPalette(onSession, busy(), '', NOW), '操作')[0]).toBe('cmd:new-session:project:p1');
    const onScratch = { ...withPalette(), screen: { name: 'project' as const, id: 'sc' } };
    expect(ids(presentPalette(onScratch, busy(), '', NOW), '操作')[0]).toBe('cmd:new-session:scratch');
  });
  it('空の群は出さない', () => {
    expect(titles(presentPalette(withPalette(), { ...store(), sessions: {} }, '', NOW))).toEqual(['操作', '設定']);
  });
  it('後から届いた新しいセッションが最近の先頭に来る', () => {
    // session.upsert は辞書の末尾に鍵を足すので、積んだ順のままだと新しいセッションが枠の外に出てしまう。
    const many: Record<string, SessionDto> = {};
    for (let i = 0; i < 60; i++) many[`x${i}`] = { ...session(`x${i}`, `セッション ${i}`, null), lastActivityAt: 1000 + i };
    const fresh = { ...session('fresh', 'いま起こしたセッション', null), lastActivityAt: 9999 };
    const p = presentPalette(withPalette(), { ...store(), sessions: { ...many, fresh } }, '', NOW)!;
    expect(ids(p, '最近')[0]).toBe('session:fresh');
  });
});

describe('presentPalette（打ち始めた後）', () => {
  it('実行中と最近の名前で絞る。要約の 1 文は引かない', () => {
    const a = presentPalette(withPalette(), store(), '動画', NOW)!;
    expect(titles(a)).toEqual(['セッション', 'ホーム']);
    expect(ids(a, 'セッション')).toEqual(['session:s1']);
    expect(a.noMatch).toBe(false);
    // 要約の文は、ホームの欄が引く。
    const b = presentPalette(withPalette(), store(), 'mp4', NOW)!;
    expect(b.noMatch).toBe(true);
    expect(b.sections.flatMap((x) => x.items.map((i) => i.id))).toEqual(['search:mp4']);
  });
  it('プロジェクトの名前は引かない', () => {
    const p = presentPalette(withPalette(), store(), 'alpha', NOW)!;
    expect(p.sections.flatMap((x) => x.items.map((i) => i.id)).some((id) => id.startsWith('project:'))).toBe(false);
  });
  it('終わった古いセッションは引かず、新しいほうの 20 件だけを引く', () => {
    const many: Record<string, SessionDto> = {};
    for (let i = 0; i < 30; i++) many[`x${i}`] = { ...session(`x${i}`, `案件 ${i}`, null), lastActivityAt: 1000 + i };
    const p = presentPalette(withPalette(), { ...store(), sessions: many }, '案件', NOW)!;
    expect(p.sections.find((x) => x.title === 'セッション')).toMatchObject({ count: 20, limit: '上位 8' });
    expect(ids(p, 'セッション')[0]).toBe('session:x29');
    // 20 件の外のものは、名前が当たっても出ない。
    const old = presentPalette(withPalette(), { ...store(), sessions: many }, '案件 3', NOW)!;
    expect(old.sections.flatMap((x) => x.items.map((i) => i.id))).not.toContain('session:x3');
  });
  it('入力待ちと実行中は群を分けたまま、名前で絞る', () => {
    const p = presentPalette(withPalette(), busy(), '直す', NOW)!;
    expect(ids(p, '入力待ち')).toEqual(['session:w1']);
    expect(ids(p, '実行中')).toEqual(['session:i1']);
  });
  it('操作と設定の節にも当たる。実行は打ったときだけ出る行を含む', () => {
    const p = presentPalette(withPalette(), store(), 'クラウド', NOW)!;
    expect(ids(p, '設定')).toEqual(['settings:cloud']);
    const side = presentPalette(withPalette(), store(), 'サイドバー', NOW)!;
    expect(ids(side, '操作')).toEqual(['cmd:sidebar']);
    const idx = presentPalette(withPalette(), store(), '索引', NOW)!;
    expect(ids(idx, '操作')).toEqual(['cmd:rebuild-index']);
  });
  it('最後の行は、ホームの欄へ渡す行。語を ID に持ち、トランスクリプトから検索すると書く', () => {
    const p = presentPalette(withPalette(), store(), ' 索引 ', NOW)!;
    const last = p.sections.at(-1)!;
    expect(last.title).toBe('ホーム');
    expect(last.items).toEqual([{ id: 'search:索引', label: 'ホームで『索引』をトランスクリプトから検索', kind: 'search', lead: { kind: 'icon', icon: 'fulltext' }, sub: '', meta: '', keys: '⌘↵' }]);
  });
  it('最後の行に、ホームの欄に出る件数を添える。語が違う件数は添えない', () => {
    const last = (p: ReturnType<typeof presentPalette>) => p!.sections.at(-1)!.items[0]!;
    expect(last(presentPalette(withPalette(), store(), '索引', NOW, { q: '索引', total: 12 })).meta).toBe('12 件');
    expect(last(presentPalette(withPalette(), store(), '索引', NOW, { q: '索引', total: 0 })).meta).toBe('0 件');
    expect(last(presentPalette(withPalette(), store(), '索引', NOW, { q: '索', total: 12 })).meta).toBe('');
    expect(last(presentPalette(withPalette(), store(), '索引', NOW, null)).meta).toBe('');
    expect(last(presentPalette(withPalette(), store(), '1', NOW, { q: '1', total: 1234 })).meta).toBe('1,234 件');
  });
  it('名前に一致しなくても、ホームへ渡す行は残り、一致しないことを知らせる', () => {
    const p = presentPalette(withPalette(), store(), 'zzzz', NOW)!;
    expect(titles(p)).toEqual(['ホーム']);
    expect(p.noMatch).toBe(true);
  });
  it('群は、いちばんよく当たった行の点の高い順に並べる', () => {
    // 「設定」の語は、名前に散らばって当たるセッションより、名前の頭から当たる設定の群を先に出す。
    const s = store();
    s.sessions.s3 = session('s3', '設計を見直して定数を足した', null);
    const p = presentPalette(withPalette(), s, '設定', NOW)!;
    expect(p.sections[0]!.title).toBe('設定');
  });
  it('群ごとに 8 件で切り、全件の数を添える', () => {
    const many: Record<string, SessionDto> = {};
    for (let i = 0; i < 20; i++) many[`x${i}`] = { ...session(`x${i}`, `セッション ${i}`, null), lastActivityAt: 1000 + i };
    const p = presentPalette(withPalette(), { ...store(), sessions: many }, 'セッション', NOW)!;
    expect(p.sections.find((x) => x.title === 'セッション')).toMatchObject({ count: 20, limit: '上位 8' });
    expect(ids(p, 'セッション')).toHaveLength(8);
  });
  it('次の入力待ちへのコマンドがあり、ヒントはキーの表から引く（C5）', () => {
    const p = presentPalette(withPalette(), store(), '入力待ち', NOW)!;
    expect(item(p, 'cmd:next-waiting')).toMatchObject({ label: '次の入力待ちへ', keys: '⌘I', kind: 'command' });
  });
});

describe('presentPromote と presentPromoted', () => {
  it('昇格ダイアログはセッション名と run の生死と送信の状態を出す', () => {
    const s = { ...withPalette(), overlay: { kind: 'promote' as const, sessionId: 's1' }, promote: { kind: 'failed' as const, message: '同じ名前があります' } };
    expect(presentPromote(s, store())).toEqual({ sessionId: 's1', sessionName: '動画の変換', runAlive: false, submitting: false, error: '同じ名前があります' });
    expect(presentPromote(initialState(), store())).toBeNull();
    const alive = { ...initialStore(), ...store(), runs: { r1: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start' as const, tmuxName: 'x', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } } };
    expect(presentPromote({ ...s, promote: { kind: 'submitting' as const } }, alive)).toMatchObject({ runAlive: true, submitting: true, error: null });
  });
  it('完了ダイアログは移動の可否と理由を出す', () => {
    const s = { ...initialState(), overlay: { kind: 'promoted' as const, projectId: 'p1', moved: false, reason: 'run が生きています' } };
    expect(presentPromoted(s, store())).toEqual({ projectId: 'p1', projectName: 'alpha', moved: false, reason: 'run が生きています' });
    expect(presentPromoted(initialState(), store())).toBeNull();
  });
});
