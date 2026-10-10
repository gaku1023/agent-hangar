import { describe, expect, it } from 'vitest';
import { translator, type ProjectDto, type SessionDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { arrivedCount, presentUnresolved, unresolvedKind } from './unresolved.ts';

const ja = translator('ja');
const en = translator('en');

const project = (id: string, over: Partial<ProjectDto> = {}): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: null, ...over });
/** この PC で場所が消えたもの。 */
const missing = (id: string, over: Partial<ProjectDto> = {}) => project(id, { resolved: false, unresolved: { kind: 'missing', previousPath: `/w/${id}`, deviceName: null }, ...over });
/** 他の PC から届いただけで、この PC に場所を持ったことが無いもの。 */
const elsewhere = (id: string, over: Partial<ProjectDto> = {}) => project(id, { path: null, resolved: false, unresolved: { kind: 'elsewhere', previousPath: `/other/${id}`, deviceName: 'Mac mini' }, ...over });
const session = (id: string, projectId: string): SessionDto => ({ id, projectId } as SessionDto);

function storeOf(projects: ProjectDto[], sessions: SessionDto[] = []): Store {
  const s = initialStore();
  s.projects = Object.fromEntries(projects.map((p) => [p.id, p]));
  s.sessions = Object.fromEntries(sessions.map((x) => [x.id, x]));
  return s;
}

describe('unresolvedKind', () => {
  it('DTO の unresolved をそのまま読む。無ければ null', () => {
    expect(unresolvedKind(project('a'))).toBeNull();
    expect(unresolvedKind(missing('a'))).toBe('missing');
    expect(unresolvedKind(elsewhere('a'))).toBe('elsewhere');
  });
  it('unresolved を持たない古いサーバの DTO は、path と resolved から読む', () => {
    const old = (o: Partial<ProjectDto>): ProjectDto => { const p = project('a', o); delete p.unresolved; return p; };
    expect(unresolvedKind(old({}))).toBeNull();
    expect(unresolvedKind(old({ resolved: false }))).toBe('missing');
    expect(unresolvedKind(old({ resolved: false, path: null }))).toBe('elsewhere');
  });
  it('スクラッチは、どちらでもない', () => {
    expect(unresolvedKind(missing('a', { isScratch: true }))).toBeNull();
  });
});

describe('presentUnresolved（帯の 4 つ目の錠剤）', () => {
  it('この PC で場所が消えたものだけを数える。他の PC から届いただけのものは数えない', () => {
    const g = presentUnresolved(storeOf([missing('a'), elsewhere('b'), elsewhere('c'), elsewhere('d'), project('e')]), ja)!;
    expect(g.count).toBe(1);
    expect(g.rows.map((r) => r.key)).toEqual(['unresolved:a']);
  });

  it('届いただけのものしか無いときは、群を出さない（帯が消えなくならない）', () => {
    expect(presentUnresolved(storeOf([elsewhere('a'), elsewhere('b'), elsewhere('c')]), ja)).toBeNull();
    expect(presentUnresolved(storeOf([]), ja)).toBeNull();
  });

  it('Archived にしたものと、スクラッチは数えない', () => {
    expect(presentUnresolved(storeOf([missing('a', { status: 'archived' }), missing('b', { isScratch: true })]), ja)).toBeNull();
    expect(presentUnresolved(storeOf([missing('a', { status: 'paused' }), missing('b', { status: 'done' })]), ja)!.count).toBe(2);
  });

  it('群の形：場所の不明なプロジェクト、警告の色、朝には開かない', () => {
    const g = presentUnresolved(storeOf([missing('a')]), ja)!;
    expect(g).toMatchObject({ id: 'unresolved', label: '場所の不明なプロジェクト', icon: 'folder', tone: 'warn', morning: false, summary: 'この PC にパスがありません' });
    expect(presentUnresolved(storeOf([missing('a')]), en)!.label).toBe('Projects without a folder');
  });

  it('行：名前、セッションの数、前のパス、場所を再指定・Archived にする・一覧から削除', () => {
    const store = storeOf([missing('alpha')], [session('s1', 'alpha'), session('s2', 'alpha'), session('s3', 'other')]);
    const row = presentUnresolved(store, ja)!.rows[0]!;
    expect(row).toMatchObject({ key: 'unresolved:alpha', lead: { kind: 'place' }, name: 'alpha', context: 'セッション 2 件', text: '', detail: '/w/alpha', open: { type: 'project.open', id: 'alpha' } });
    expect(row.actions.map((a) => [a.id, a.label, a.primary, a.ghost, a.send])).toEqual([
      ['relocate', '場所を再指定', true, false, { type: 'project.resolve.open', id: 'alpha' }],
      ['archive', 'Archived にする', false, false, { type: 'project.resolve', id: 'alpha', action: { kind: 'archive' } }],
      ['unlink', '一覧から削除', false, true, { type: 'project.resolve', id: 'alpha', action: { kind: 'unlink' } }],
    ]);
    // 読み上げの名前に、相手のプロジェクトを含める。
    expect(row.actions[0]!.ariaLabel).toBe('場所を再指定、alpha');
  });

  it('前のパスが分からなければ、詳細は出さない', () => {
    const row = presentUnresolved(storeOf([missing('a', { unresolved: { kind: 'missing', previousPath: null, deviceName: null } })]), ja)!.rows[0]!;
    expect(row.detail).toBeNull();
  });

  it('並びは最後に動いた順で、同じなら名前順', () => {
    const g = presentUnresolved(storeOf([missing('b', { lastActivityAt: 5 }), missing('a', { lastActivityAt: 5 }), missing('c', { lastActivityAt: 9 }), missing('d', { lastActivityAt: null })]), ja)!;
    expect(g.rows.map((r) => r.name)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('arrivedCount（他の PC から届いたトーストの件数）', () => {
  it('覚えてある id のうち、いまも他の PC から届いたままのものだけを数える', () => {
    const store = storeOf([elsewhere('a'), elsewhere('b'), project('c'), missing('d')]);
    expect(arrivedCount(store, ['a', 'b', 'c', 'd', 'gone'])).toBe(2);
  });
  it('Archived にしたものは数えない', () => {
    expect(arrivedCount(storeOf([elsewhere('a', { status: 'archived' }), elsewhere('b')]), ['a', 'b'])).toBe(1);
  });
});
