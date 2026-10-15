import { describe, expect, it } from 'vitest';
import type { SettingsDto, WorkspaceChildDto, WorkspaceChildrenDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentProjectCandidates } from './projectCandidates.ts';

// まとめて登録の「フォルダの中から」（0.6.1）。親の直下の行に、押すと何が起きるかの 1 行を添える。
const NOW = 1_760_000_000_000;
const settings = (workspaceRoot: string) => ({ workspaceRoot } as SettingsDto);
const open = (source: 'talked' | 'folder' = 'folder'): State => ({ ...initialState(), overlay: { kind: 'projectCandidates', source, submitting: false, error: null } });
const child = (name: string, over: Partial<WorkspaceChildDto> = {}): WorkspaceChildDto => ({
  name, path: `/Users/me/src/${name}`, git: true, worktree: false, remote: null, sessionCount: 0, lastActivityAt: null,
  registered: null, enclosing: null, link: null, children: null, ...over,
});
const withChildren = (data: WorkspaceChildrenDto, over: Partial<Store> = {}): Store => ({
  ...initialStore(), home: '/Users/me', settings: settings('/Users/me/src'),
  workspaceChildren: { status: 'ready', parent: '~/src', data }, ...over,
});
const browse = (store: Store, state: State = open()) => presentProjectCandidates(state, store, NOW)!.browse;

describe('presentProjectCandidates（フォルダの中から）', () => {
  it('開いた時点の親は、作成場所があればそれ、無ければ会話の多い親。どちらも待つ間は決めない', () => {
    expect(browse({ ...initialStore(), home: '/Users/me', settings: settings('/Users/me/src') }).initialParent).toBe('~/src');
    expect(browse({ ...initialStore(), home: '/Users/me' }).initialParent).toBeUndefined();
    const empty = { ...initialStore(), home: '/Users/me', settings: settings('') };
    expect(browse({ ...empty, folderCandidates: { status: 'loading' } }).initialParent).toBeUndefined();
    expect(browse({ ...empty, folderCandidates: { status: 'ready', data: { candidates: [], suggestedRoot: '/Users/me/work' } } }).initialParent).toBe('~/work');
    expect(browse({ ...empty, folderCandidates: { status: 'ready', data: { candidates: [], suggestedRoot: null } } }).initialParent).toBeNull();
    expect(browse({ ...empty, folderCandidates: { status: 'failed' } }).initialParent).toBeNull();
    expect(presentProjectCandidates(open('talked'), empty, NOW)!.source).toBe('talked');
  });
  it('行の数と最後の活動。会話の無いフォルダは「—」で、最後の活動は空にする', () => {
    const b = browse(withChildren({ parent: '/Users/me/src', enclosing: null, children: [child('api', { sessionCount: 24, lastActivityAt: NOW - 3 * 3_600_000 }), child('blog')] }));
    expect(b.status).toBe('ready');
    expect(b.parent).toEqual({ path: '/Users/me/src', label: '~/src' });
    expect(b.rows.map((r) => [r.name, r.count, r.countLabel, r.when, r.sessions])).toEqual([['api', '24', '会話 24 件', '3 時間前', 24], ['blog', '—', '会話 0 件', '', 0]]);
  });
  it('登録済み、worktree、別のプロジェクトの中、git のフォルダを含むものに、押すと何が起きるかを添える', () => {
    const b = browse(withChildren({ parent: '/Users/me/src', enclosing: null, children: [
      child('clients', { git: false, children: [child('a'), child('b'), child('notes', { git: false })] }),
      child('notes-app', { remote: 'github.com/me/notes-app', registered: { projectId: 'p1', name: 'notes-app' } }),
      child('notes-app-hotfix', { remote: 'github.com/me/notes-app', worktree: true }),
      child('orphan-wt', { remote: 'github.com/me/other', worktree: true }),
      child('vendor', { enclosing: { projectId: 'p2', name: 'mono', path: '/Users/me/src/mono' } }),
    ] }));
    expect(b.rows.map((r) => [r.name, r.note])).toEqual([
      ['clients', 'git リポジトリ 2 件を含みます。展開して選択できます'],
      ['notes-app', '登録済みのプロジェクト（notes-app）'],
      ['notes-app-hotfix', 'notes-app の worktree です'],
      ['orphan-wt', 'git の worktree です'],
      ['vendor', 'mono 内のディレクトリです。登録すると、今後の会話は mono から分かれます'],
    ]);
    expect(b.rows[0]!.children!.map((r) => r.name)).toEqual(['a', 'b', 'notes']);
    expect(b.rows.map((r) => [r.registered, r.worktree, r.inside])).toEqual([[false, false, false], [true, false, false], [false, true, false], [false, true, false], [false, false, true]]);
  });
  it('ほかの PC のプロジェクトに結び付く行は、理由（同じリポジトリ、同じ名前）と行き先を言う', () => {
    const link = (match: 'remote' | 'name', deviceName: string | null, previousPath: string | null) => ({ projectId: 'p9', name: 'infra', match, remote: null, deviceName, previousPath });
    const b = browse(withChildren({ parent: '/Users/me/src', enclosing: null, children: [
      child('infra', { link: link('remote', 'work-pc', 'D:\\src\\infra') }),
      child('photos', { link: link('name', 'laptop', '/home/x/photos') }),
      child('lost', { link: link('remote', null, '/Users/me/old/infra') }),
      child('far', { link: link('name', null, null) }),
    ] }));
    expect(b.rows.map((r) => r.link)).toEqual([
      { projectId: 'p9', note: 'work-pc の infra と同じリポジトリです。この PC のパスとして関連付けます' },
      { projectId: 'p9', note: 'laptop の infra と同じ名前です。この PC のパスとして関連付けます' },
      { projectId: 'p9', note: 'この PC でパスが見つからない infra と同じリポジトリです。この PC のパスとして関連付けます' },
      { projectId: 'p9', note: '他の PC の infra と同じ名前です。この PC のパスとして関連付けます' },
    ]);
    expect(b.rows.map((r) => r.note)).toEqual([null, null, null, null]);
  });
  it('親そのものがプロジェクトの中なら、帯で 1 回だけ言い、同じプロジェクトの中の行には添えない', () => {
    const mono = { projectId: 'p2', name: 'agent-hangar', path: '/Users/me/src/agent-hangar' };
    const b = browse(withChildren({ parent: '/Users/me/src/agent-hangar/packages', enclosing: mono, children: [child('ui', { git: false, enclosing: mono })] }));
    expect(b.band).toBe('agent-hangar');
    expect(b.rows[0]).toMatchObject({ inside: true, note: null });
    expect(b.rootable).toBe(false);
  });
  it('作成場所が空のときだけ、読んだ親を作成場所にできる。ホームフォルダと根は除く', () => {
    const data = (parent: string): WorkspaceChildrenDto => ({ parent, enclosing: null, children: [] });
    expect(browse(withChildren(data('/Users/me/src'), { settings: settings('') })).rootable).toBe(true);
    expect(browse(withChildren(data('/Users/me/src'))).rootable).toBe(false);
    expect(browse(withChildren(data('/Users/me'), { settings: settings('') })).rootable).toBe(false);
    expect(browse(withChildren(data('/'), { settings: settings('') })).rootable).toBe(false);
  });
  it('読み込みの進みと、読めなかった理由', () => {
    expect(browse({ ...initialStore(), settings: settings('/w') })).toMatchObject({ status: 'idle', failure: null, rows: [] });
    expect(browse({ ...initialStore(), workspaceChildren: { status: 'loading', parent: '~/src' } })).toMatchObject({ status: 'loading' });
    expect(browse({ ...initialStore(), workspaceChildren: { status: 'failed', parent: '~/x', message: 'path が存在するディレクトリではありません' } })).toMatchObject({ status: 'failed', failure: 'path が存在するディレクトリではありません' });
  });
});
