import { describe, expect, it } from 'vitest';
import type { ProjectDto, SearchFilter, SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import type { ListItem } from './sections.ts';
import { presentSessions } from './sessions.ts';

const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const IMPORT_AT = new Date(2026, 9, 1, 8, 0).getTime();
const project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
const cand = (status: 'paused' | 'done', at: number) => ({ status, note: '直した', returnOn: status === 'paused' ? '2026-10-03' : null, source: 'in_session' as const, at });
const dto = (id: string, hoursAgo: number, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - (hoursAgo + 1) * H, lastActivityAt: NOW - hoursAgo * H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state: null, ...over });
function storeOf(list: SessionDto[]): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha'), beta: project('beta') };
  s.sessions = Object.fromEntries(list.map((x) => [x.id, x]));
  return s;
}
/** sessions-filter.html の ★ と同じ顔ぶれに、プロジェクトの無いセッションを 1 つ足したもの。 */
const scene = () => storeOf([
  dto('newui', 0.05, { live: 'waiting' }),
  dto('status', 0, { live: 'busy' }),
  dto('nfd', 2, { state: st({ candidate: cand('done', NOW - 2 * H) }) }),
  dto('video', 5, { projectId: 'beta', state: st({ candidate: cand('paused', NOW - 5 * H) }) }),
  dto('backspace', 8),
  dto('orphan', 10, { projectId: null }),
  dto('resp', 12, { state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
  dto('sync', 24, { state: st({ status: 'paused', note: 'CPU の数字を見る', returnOn: '2026-10-02', setBy: 'user', setAt: NOW - 24 * H }) }),
  dto('trash', 30, { state: st({ status: 'archived', setBy: 'user', setAt: NOW - 30 * H }) }),
  dto('parkour', 48, { projectId: 'beta', state: st({ status: 'paused', returnOn: '2026-10-09', setBy: 'user', setAt: NOW - 48 * H }) }),
  dto('subs', 216, { state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
]);
const shape = (items: ListItem[] | null) => items?.map((i) => (i.kind === 'head' ? `# ${i.id} ${i.count}` : i.row.id)) ?? null;
const withSearch = (search: State['search']): State => ({ ...initialState(), screen: { name: 'sessions' }, search });
const ids = (filter: SearchFilter, store = scene()) => presentSessions(withSearch({ text: '', filter }), store, NOW).rows.map((r) => r.id);

describe('presentSessions のタブと節（★）', () => {
  it('条件が無ければ節で読み、プロジェクトの無いセッションも印なしに並ぶ', () => {
    const p = presentSessions(initialState(), scene(), NOW);
    expect(shape(p.sections)).toEqual(['# returning 1', 'sync', '# proposed 2', 'nfd', 'video', '# live 2', 'newui', 'status', '# paused 1', 'parkour', '# none 2', 'backspace', 'orphan', '# done 2', 'resp', 'subs', '# archived 1']);
    expect(p.tab).toBe('all');
    expect(p.rows.find((r) => r.id === 'orphan')!.projectName).toBeNull();
  });
  it('タブの件数は条件に関わらず手元の全件を行の持ち物で数え、確かめるが 1 件以上なら灯す', () => {
    const p = presentSessions(withSearch({ text: '', filter: { projectId: 'beta' } }), scene(), NOW);
    expect(p.tabs.map((t) => [t.tab, t.label, t.count, t.hot])).toEqual([
      ['all', 'すべて', '10', false], ['proposed', '確かめる', '2', true], ['paused', 'Paused', '2', false], ['active', 'Active', '2', false],
      ['none', '印なし', '4', false], ['done', 'Done', '2', false], ['archived', 'Archived', '1', false],
    ]);
    expect(presentSessions(initialState(), storeOf([dto('x', 1)]), NOW).tabs.find((t) => t.tab === 'proposed')!.hot).toBe(false);
  });
  it('タブを選ぶと節を消し、その状態の行だけを平らに並べ、条件の行にタブの名前を出す', () => {
    const p = presentSessions(withSearch({ text: '', filter: { status: 'paused' } }), scene(), NOW);
    expect(p.sections).toBeNull();
    expect(p.tab).toBe('paused');
    expect(p.rows.map((r) => r.id)).toEqual(['sync', 'parkour']);
    expect(p.conditions).toEqual(['Paused']);
    expect(ids({ status: 'active' })).toEqual(['newui', 'status']);
    expect(ids({ status: 'proposed' })).toEqual(['nfd', 'video']);
  });
  it('「すべて」のまま条件を入れたら Archived を除き、Archived のタブなら出す', () => {
    expect(ids({ days: 7 })).not.toContain('trash');
    expect(ids({ days: 7 })).toContain('sync');
    expect(ids({ status: 'archived' })).toEqual(['trash']);
  });
  it('プロジェクトで絞ると、プロジェクトの無いセッションは当たらない', () => {
    expect(ids({ projectId: 'alpha' })).not.toContain('orphan');
    expect(ids({ projectId: 'alpha' })).not.toContain('video');
  });
  it('効いている条件を欄のチップにし、読めなかったトークンを知らせる', () => {
    const store = { ...scene(), search: { params: { q: 'is:pasued' }, result: { hits: [], total: 0 }, loading: false } };
    const p = presentSessions(withSearch({ text: 'is:pasued', filter: { status: 'done', projectId: 'alpha', days: 7 } }), store, NOW);
    expect(p.tokens).toEqual([{ key: 'status', token: 'is:done' }, { key: 'days', token: 'since:7d' }, { key: 'projectId', token: 'project:alpha' }]);
    expect(p.conditions).toEqual(['『is:pasued』', 'Done', '7 日', 'alpha']);
    expect(p.hints).toEqual(['「is:pasued」は条件として読めないので、語として本文を探しています。is: の後は paused・done・archived・active・none・proposed・running・waiting のどれかです。']);
    expect(p.sections).toBeNull();
  });
  it('件数は桁を区切り、Done は直近 3 件だけを節に出す', () => {
    const many = Array.from({ length: 1221 }, (_, i) => dto(`d${i}`, 30 + i, { state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }));
    const p = presentSessions(initialState(), storeOf(many), NOW);
    expect(p.tabs.find((t) => t.tab === 'done')!.count).toBe('1,221');
    expect(shape(p.sections)).toEqual(['# done 1221', 'd0', 'd1', 'd2']);
  });
  it('消えたプロジェクトのセッションも節に並び、プロジェクトの名前は無い（未分類と出る）', () => {
    const store = storeOf([dto('gone', 1, { projectId: 'deleted' }), dto('ok', 2)]);
    const p = presentSessions(initialState(), store, NOW);
    expect(shape(p.sections)).toEqual(['# none 2', 'gone', 'ok']);
    expect(p.rows.find((r) => r.id === 'gone')!.projectName).toBeNull();
    expect(ids({ projectId: 'deleted' }, store)).toEqual(['gone']);
    expect(ids({ projectId: 'alpha' }, store)).toEqual(['ok']);
  });
  it('期間の帯に無い値（since:14d）は、チップと条件の行には出て、帯のための値はそのまま 14 日で持つ', () => {
    const p = presentSessions(withSearch({ text: '', filter: { days: 14 } }), scene(), NOW);
    expect(p.tokens).toEqual([{ key: 'days', token: 'since:14d' }]);
    expect(p.conditions).toEqual(['14 日']);
    expect(p.filter.days).toBe(14);
  });
  it('読めなかったトークンは、種類ごとに書き方を添える', () => {
    const hints = (text: string) => presentSessions(withSearch({ text, filter: {} }), scene(), NOW).hints;
    expect(hints('since:abc')[0]).toContain('since: の後は 7d のように日数と d を書きます');
    expect(hints('project:zzz')[0]).toContain('その名前で始まるプロジェクトがありません');
    expect(hints('file:')[0]).toContain('file: の後にパスがありません');
    expect(hints('is:done 動画')).toEqual([]);
  });
});
