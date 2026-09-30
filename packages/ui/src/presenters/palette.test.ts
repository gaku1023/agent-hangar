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
  fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false, transcriptMtime: null,
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
  it('入力待ち、実行中、最近、プロジェクト、移動、コマンドの群に並べる', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(p.query).toBe('');
    expect(p.noMatch).toBe(false);
    expect(titles(p)).toEqual(['入力待ち', '実行中', '最近', 'プロジェクト', '移動', 'コマンド']);
    expect(ids(p, '入力待ち')).toEqual(['session:w1']);
    // 実行中は作業中と休みで、入力待ちを含めない（用語の D1）。
    expect(ids(p, '実行中')).toEqual(['session:b1', 'session:i1']);
  });
  it('空白だけの入力も、何も打っていないのと同じに扱う', () => {
    expect(titles(presentPalette(withPalette(), busy(), '  ', NOW))).toEqual(titles(presentPalette(withPalette(), busy(), '', NOW)));
  });
  it('セッションの行には状態の点とプロジェクト名、右に待った長さや経った時間を添える', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(item(p, 'session:w1')).toMatchObject({ label: '認証の期限切れを直す', kind: 'session', lead: { kind: 'dot', live: 'waiting' }, sub: 'alpha', meta: '4 分待っている' });
    expect(item(p, 'session:b1')).toMatchObject({ lead: { kind: 'dot', live: 'busy' }, meta: '作業中 7 分' });
    expect(item(p, 'session:i1')).toMatchObject({ lead: { kind: 'dot', live: 'idle' }, meta: '休み 12 分' });
    expect(item(p, 'session:e0')).toMatchObject({ lead: { kind: 'dot', live: null }, meta: '1 時間前' });
  });
  it('最近は札に出したものを重ねず、新しい順に 5 件まで。切ったら「上位 5」と全件の数を添える', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    const recent = p.sections.find((x) => x.title === '最近')!;
    expect(recent.items.map((i) => i.id)).toEqual(['session:e0', 'session:e1', 'session:e2', 'session:e3', 'session:e4']);
    expect(recent.count).toBe(7);
    expect(recent.limit).toBe('上位 5');
    // 切っていない群には上限の印を付けない。
    const waiting = p.sections.find((x) => x.title === '入力待ち')!;
    expect(waiting).toMatchObject({ count: 1, limit: null });
  });
  it('プロジェクトは最後の活動が新しい順に 4 件まで。行には状態の点とパスを添える', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    const projects = p.sections.find((x) => x.title === 'プロジェクト')!;
    expect(projects.items.map((i) => i.id)).toEqual(['project:q4', 'project:q3', 'project:q2', 'project:q1']);
    expect(projects).toMatchObject({ count: 7, limit: '上位 4' });
    expect(item(p, 'project:q4')).toMatchObject({ kind: 'project', lead: { kind: 'status', status: 'active' }, meta: '/w/proj-4' });
  });
  it('この PC にパスの無いプロジェクトは、そう添える', () => {
    const s = store();
    s.projects.p1 = { ...s.projects.p1!, path: null, lastActivityAt: 999 };
    expect(item(presentPalette(withPalette(), s, '', NOW), 'project:p1').meta).toBe('この PC にパスがありません');
  });
  it('移動の群は画面を移る行とキーの行で、打鍵はキーの表から引く', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(ids(p, '移動')).toEqual(['go:home', 'go:projects', 'go:sessions', 'cmd:settings', 'cmd:next-waiting', 'cmd:sidebar', 'cmd:shortcuts']);
    expect(p.sections.find((x) => x.title === '移動')!.items.map((i) => i.label)).toEqual(['ホームへ', 'プロジェクトへ', 'セッション一覧へ', '設定', '次の入力待ちへ', 'サイドバーの開閉', 'キーの一覧']);
    expect(item(p, 'cmd:settings').keys).toBe('⌘,');
    expect(item(p, 'cmd:next-waiting').keys).toBe('⌘I');
    expect(item(p, 'cmd:sidebar').keys).toBe('⌘B');
    expect(item(p, 'cmd:shortcuts').keys).toBe('? / ⌘/');
    // 次の入力待ちへは、移る先のセッションの名前を添える。
    expect(item(p, 'cmd:next-waiting').sub).toBe('認証の期限切れを直す');
    expect(item(presentPalette(withPalette(), store(), '', NOW), 'cmd:next-waiting').sub).toBe('');
  });
  it('コマンドの群に、新しいセッション、スクラッチ、索引の作り直しを残す', () => {
    const p = presentPalette(withPalette(), busy(), '', NOW)!;
    expect(ids(p, 'コマンド')).toEqual(['cmd:new-session', 'cmd:new-scratch', 'cmd:rebuild-index']);
    expect(item(p, 'cmd:new-session')).toMatchObject({ label: '新しいセッション', keys: '⌘N', kind: 'command', lead: { kind: 'icon', icon: 'add' } });
    expect(item(p, 'cmd:new-scratch').keys).toBe('⌘⇧N');
  });
  it('新しいセッションは、いまの画面のプロジェクトを最初から選ぶ', () => {
    const onProject = { ...withPalette(), screen: { name: 'project' as const, id: 'p1' } };
    expect(ids(presentPalette(onProject, busy(), '', NOW), 'コマンド')[0]).toBe('cmd:new-session:project:p1');
    const onSession = { ...withPalette(), screen: { name: 'session' as const, id: 'w1' } };
    expect(ids(presentPalette(onSession, busy(), '', NOW), 'コマンド')[0]).toBe('cmd:new-session:project:p1');
    const onScratch = { ...withPalette(), screen: { name: 'project' as const, id: 'sc' } };
    expect(ids(presentPalette(onScratch, busy(), '', NOW), 'コマンド')[0]).toBe('cmd:new-session:scratch');
  });
  it('空の群は出さない', () => {
    expect(titles(presentPalette(withPalette(), store(), '', NOW))).toEqual(['最近', 'プロジェクト', '移動', 'コマンド']);
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
  it('名前で絞り、要約の 1 文でも当たる。最後の行はいつも全文検索', () => {
    const a = presentPalette(withPalette(), store(), 'alpha', NOW)!;
    expect(a.sections[0]!.items[0]!.id).toBe('project:p1');
    const b = presentPalette(withPalette(), store(), 'mp4', NOW)!;
    expect(titles(b)).toEqual(['セッション', '本文']);
    expect(ids(b, 'セッション')).toEqual(['session:s1']);
    expect(b.noMatch).toBe(false);
  });
  it('全文検索の行は語を ID に持ち、セッション一覧で開くと添える', () => {
    const p = presentPalette(withPalette(), store(), ' 索引 ', NOW)!;
    const last = p.sections.at(-1)!;
    expect(last.title).toBe('本文');
    expect(last.items).toEqual([{ id: 'search:索引', label: '『索引』を全文検索', kind: 'search', lead: { kind: 'icon', icon: 'fulltext' }, sub: '', meta: 'セッション一覧で開く', keys: '⌘↵' }]);
  });
  it('名前に一致しなくても全文検索の行は残り、一致しないことを知らせる', () => {
    const p = presentPalette(withPalette(), store(), 'zzzz', NOW)!;
    expect(titles(p)).toEqual(['本文']);
    expect(p.noMatch).toBe(true);
  });
  it('群は、いちばんよく当たった行の点の高い順に並べる', () => {
    // 「設定」の語は、要約に散らばって当たるセッションより、名前の頭から当たるコマンドを先に出す。
    const s = store();
    s.sessions.s3 = session('s3', 'ログ', '設計を見直して定数を足した');
    const p = presentPalette(withPalette(), s, '設定', NOW)!;
    expect(p.sections[0]!.items[0]!.id).toBe('cmd:settings');
  });
  it('入力待ちと実行中は群を分けたまま絞る', () => {
    const p = presentPalette(withPalette(), busy(), '直す', NOW)!;
    expect(ids(p, '入力待ち')).toEqual(['session:w1']);
    expect(ids(p, '実行中')).toEqual(['session:i1']);
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
