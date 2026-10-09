import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ArtifactDto, Intent, SessionDto, TodoDto } from '@agent-hangar/shared';
import type { MediatedIntent } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';
import type { ApiClient } from './api.ts';
import { FELL_BACK, intentCall, intentTable, isTableIntent, type TableIntent } from './intentTable.ts';

/** 表が使う API だけの偽物。表に無い API を呼べば、型が合わなくなるか、無い関数を呼んで落ちる。 */
function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return { ...fakeApiExtras(), setProjectStatus: vi.fn(async () => { throw new Error('not used in this test'); }), ...over } as ApiClient;
}

/** 表の 1 行を引いて呼び、応答の扱い（Store の更新と知らせ）まで行う。Runtime の runCall と同じ順である。 */
async function runRow(intent: TableIntent, api: ApiClient, store: Store = initialStore()) {
  const call = intentCall(intent, store);
  if (!call) return { called: false as const, store, during: store, toast: null };
  const during = call.before ? call.before(store) : store;
  const done = await call.run(api);
  return { called: true as const, during, store: done.apply ? done.apply(during) : during, toast: done.toast ?? null };
}

describe('表の鍵', () => {
  it('表にある Intent は、型でも実行時でも見分けられる', () => {
    expect(isTableIntent({ type: 'project.setStatus', id: 'p1', status: 'paused' })).toBe(true);
    expect(isTableIntent({ type: 'nav.back' })).toBe(false);
    // Object の持ち物（toString など）を鍵と取り違えない。
    expect(isTableIntent({ type: 'toString' } as unknown as Intent)).toBe(false);
  });
  it('表の鍵は Intent の kind の部分集合で、Mediator の入力の型からは外れている', () => {
    expectTypeOf<TableIntent['type']>().toMatchTypeOf<Intent['type']>();
    expectTypeOf<Extract<MediatedIntent, { type: TableIntent['type'] }>>().toBeNever();
    // 表に無いものは、Mediator の入力に残る。
    expectTypeOf<{ type: 'nav.back' }>().toMatchTypeOf<MediatedIntent>();
  });
  it('表に載っているのは、API を 1 回呼ぶだけの Intent である', () => {
    expect(Object.keys(intentTable).sort()).toEqual([
      'account.choose', 'account.login', 'account.login.cancel', 'account.refresh', 'account.update', 'accounts.load',
      'artifact.add', 'artifact.open', 'artifact.openEditor', 'memo.save',
      'project.openEditor', 'project.openTerminalApp', 'project.rename', 'project.setStatus',
      'session.openEditor', 'session.openFile', 'session.openTerminalApp', 'session.setMemo', 'session.state.reject', 'summarizer.test', 'summary.regenerate',
      'sync.now', 'sync.pause',
      'todo.confirm', 'todo.reject', 'todo.remove', 'todo.toggle',
    ]);
  });
});

describe('プロジェクト', () => {
  it('状態の変更は setProjectStatus を呼び、応答は Store に入れない', async () => {
    const setProjectStatus = vi.fn(async () => ({ id: 'p1' }) as never);
    const r = await runRow({ type: 'project.setStatus', id: 'p1', status: 'paused' }, fakeApi({ setProjectStatus }));
    expect(setProjectStatus.mock.calls).toEqual([['p1', 'paused']]);
    // 画面の正は後から届く project.upsert である。
    expect(r.called).toBe(true);
    expect(r.store).toBe(r.during);
    expect(r.toast).toBeNull();
  });
  it('名前の変更は renameProject を呼び、応答は Store に入れない（画面の正は後から届く project.upsert）', async () => {
    const renameProject = vi.fn(async () => ({}) as never);
    const r = await runRow({ type: 'project.rename', id: 'p1', name: '新しい名前' }, fakeApi({ renameProject }));
    expect(renameProject.mock.calls).toEqual([['p1', '新しい名前']]);
    expect(r.store).toBe(r.during);
  });
  it('エディタで開く', async () => {
    const api = fakeApi();
    await runRow({ type: 'project.openEditor', id: 'p1' }, api);
    expect(vi.mocked(api.projectOpenEditor).mock.calls).toEqual([['p1']]);
  });
  it('ターミナルで開く。iTerm2 から Terminal.app に落ちたときだけ知らせる', async () => {
    const api = fakeApi();
    const a = await runRow({ type: 'project.openTerminalApp', id: 'p1' }, api);
    expect(vi.mocked(api.projectOpenTerminal).mock.calls).toEqual([['p1']]);
    expect(a.toast).toBeNull();
    const b = await runRow({ type: 'project.openTerminalApp', id: 'p1' }, fakeApi({ projectOpenTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) }));
    expect(b.toast).toBe(FELL_BACK);
  });
});

describe('セッション', () => {
  it('外のターミナルで開く。タブの指定が無ければ null で呼び、落ちたときだけ知らせる', async () => {
    const api = fakeApi();
    const a = await runRow({ type: 'session.openTerminalApp', runId: 'r1', tabId: 't1' }, api);
    const b = await runRow({ type: 'session.openTerminalApp', runId: 'r1' }, api);
    expect(vi.mocked(api.openTerminalApp).mock.calls).toEqual([['r1', 't1'], ['r1', null]]);
    expect([a.toast, b.toast]).toEqual([null, null]);
    const c = await runRow({ type: 'session.openTerminalApp', runId: 'r1' }, fakeApi({ openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) }));
    expect(c.toast).toBe(FELL_BACK);
  });
  it('エディタで開く。変更したファイルを押したときだけ、そのファイルを添える', async () => {
    const openEditor = vi.fn(async (_sessionId: string, _file?: string) => {});
    const api = fakeApi({ openEditor });
    await runRow({ type: 'session.openFile', sessionId: 's1', path: '/w/a.ts' }, api);
    await runRow({ type: 'session.openEditor', sessionId: 's1' }, api);
    // ファイルの無いほうは、引数を 1 つだけで呼ぶ。
    expect(openEditor.mock.calls).toEqual([['s1', '/w/a.ts'], ['s1']]);
  });
  it('提案の却下は rejectSessionState を呼び、応答は Store に入れない', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'session.state.reject', id: 's1' }, api);
    expect(vi.mocked(api.rejectSessionState).mock.calls).toEqual([['s1']]);
    // 画面の正は後から届く session.upsert である。
    expect(r.store).toBe(r.during);
  });
  it('メモの保存は、応答のセッションを Store に入れる', async () => {
    const saved = { id: 's1', memo: '一行' } as SessionDto;
    const setSessionMemo = vi.fn(async () => saved);
    const other = { id: 's2' } as SessionDto;
    const r = await runRow({ type: 'session.setMemo', id: 's1', text: '一行' }, fakeApi({ setSessionMemo }), { ...initialStore(), sessions: { s2: other } });
    expect(setSessionMemo.mock.calls).toEqual([['s1', '一行']]);
    expect(r.store.sessions).toEqual({ s1: saved, s2: other });
  });
  it('要約の作り直しは regenerateSummary を呼ぶだけで、結果は待たない', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'summary.regenerate', sessionId: 's1' }, api);
    expect(vi.mocked(api.regenerateSummary).mock.calls).toEqual([['s1']]);
    expect(r.store).toBe(r.during);
  });
});

describe('作業台', () => {
  const todo = (over: Partial<TodoDto>): TodoDto => ({ id: 't1', projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, ...over });
  const withTodo = (t: TodoDto): Store => ({ ...initialStore(), todos: { [t.id]: t } });
  it('TODO の切り替えは、Store の今の値を反転して送る', async () => {
    const api = fakeApi();
    await runRow({ type: 'todo.toggle', id: 't1' }, api, withTodo(todo({ done: false })));
    await runRow({ type: 'todo.toggle', id: 't1' }, api, withTodo(todo({ done: true })));
    expect(vi.mocked(api.setTodoDone).mock.calls).toEqual([['t1', true], ['t1', false]]);
    expect(api.confirmTodo).not.toHaveBeenCalled();
  });
  it('Store に無い TODO の切り替えは、何も呼ばない', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'todo.toggle', id: 'nope' }, api);
    expect(r.called).toBe(false);
    expect(api.setTodoDone).not.toHaveBeenCalled();
  });
  it('候補の欄を押したら、反転ではなく確定を送る。完了した候補は、ふつうに反転する', async () => {
    const candidate = { sessionId: 's1', reason: 'r', proposedAt: 1 } as unknown as NonNullable<TodoDto['candidate']>;
    const api = fakeApi();
    await runRow({ type: 'todo.toggle', id: 't1' }, api, withTodo(todo({ candidate })));
    expect(vi.mocked(api.confirmTodo).mock.calls).toEqual([['t1']]);
    expect(api.setTodoDone).not.toHaveBeenCalled();
    await runRow({ type: 'todo.toggle', id: 't1' }, api, withTodo(todo({ candidate, done: true })));
    expect(vi.mocked(api.setTodoDone).mock.calls).toEqual([['t1', false]]);
  });
  it('TODO の削除、確定、却下は、それぞれの API を呼び、応答は Store に入れない', async () => {
    const api = fakeApi();
    const a = await runRow({ type: 'todo.remove', id: 't1' }, api);
    const b = await runRow({ type: 'todo.confirm', id: 't2' }, api);
    const c = await runRow({ type: 'todo.reject', id: 't3' }, api);
    expect(vi.mocked(api.removeTodo).mock.calls).toEqual([['t1']]);
    expect(vi.mocked(api.confirmTodo).mock.calls).toEqual([['t2']]);
    expect(vi.mocked(api.rejectTodo).mock.calls).toEqual([['t3']]);
    // 画面の正は後から届く todo.upsert と todo.removed である。
    for (const r of [a, b, c]) expect(r.store).toBe(r.during);
  });
  it('メモの保存は、応答のメモを Store に入れる', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'memo.save', projectId: 'p1', markdown: '# m' }, api);
    expect(vi.mocked(api.saveMemo).mock.calls).toEqual([['p1', '# m']]);
    expect(r.store.memos).toEqual({ p1: { projectId: 'p1', markdown: '# m', updatedAt: 2 } });
  });
  it('アーティファクトを開く、エディタで開く', async () => {
    const api = fakeApi();
    await runRow({ type: 'artifact.open', id: 'a1' }, api);
    await runRow({ type: 'artifact.openEditor', id: 'a2' }, api);
    expect(vi.mocked(api.openArtifact).mock.calls).toEqual([['a1']]);
    expect(vi.mocked(api.openArtifactEditor).mock.calls).toEqual([['a2']]);
  });
  it('アーティファクトの追加は、URL の前後の空白を落として送り、応答を Store に入れる', async () => {
    const added = { id: 'a1', projectId: 'p1' } as ArtifactDto;
    const addArtifact = vi.fn(async () => added);
    const r = await runRow({ type: 'artifact.add', projectId: 'p1', url: '  https://example.test/x ' }, fakeApi({ addArtifact }));
    expect(addArtifact.mock.calls).toEqual([['p1', 'https://example.test/x']]);
    expect(r.store.artifacts).toEqual({ a1: added });
  });
  it('空の URL は、何も呼ばない', async () => {
    const addArtifact = vi.fn(async () => ({}) as ArtifactDto);
    const r = await runRow({ type: 'artifact.add', projectId: 'p1', url: ' ' }, fakeApi({ addArtifact }));
    expect(r.called).toBe(false);
    expect(addArtifact).not.toHaveBeenCalled();
  });
});

describe('設定', () => {
  it('要約の試しは、前の結果を先に消してから呼び、応答を Store に入れる', async () => {
    const result = { ok: true, id: 'lmstudio', ms: 12 } as unknown as NonNullable<Store['summarizerTest']>;
    const testSummarizer = vi.fn(async () => result);
    const old = { ok: false } as unknown as NonNullable<Store['summarizerTest']>;
    const r = await runRow({ type: 'summarizer.test' }, fakeApi({ testSummarizer }), { ...initialStore(), summarizerTest: old });
    expect(testSummarizer).toHaveBeenCalledTimes(1);
    // 試している最中だと分かるように、呼ぶ前に消す。
    expect(r.during.summarizerTest).toBeNull();
    expect(r.store.summarizerTest).toBe(result);
  });
});

describe('同期', () => {
  const status = { state: 'paused', pending: 4 } as unknown as NonNullable<Store['sync']>;
  it('今すぐ同期は syncNow を呼び、応答の状態を Store に入れる', async () => {
    const syncNow = vi.fn(async () => status);
    const r = await runRow({ type: 'sync.now' }, fakeApi({ syncNow }));
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(r.store.sync).toBe(status);
  });
  it('一時停止と再開は syncPause を呼び、応答の状態を Store に入れる', async () => {
    const syncPause = vi.fn(async () => status);
    const r = await runRow({ type: 'sync.pause', paused: true }, fakeApi({ syncPause }));
    expect(syncPause).toHaveBeenCalledWith(true);
    expect(r.store.sync).toBe(status);
    await runRow({ type: 'sync.pause', paused: false }, fakeApi({ syncPause }));
    expect(syncPause).toHaveBeenLastCalledWith(false);
  });
});

describe('アカウント', () => {
  const next = { ...accountsFixture, accounts: [accountsFixture.accounts[0]!] };
  it('読み込み、選択、ログインの取り消し、取り直しは、それぞれの API を呼び、応答の一覧を Store に入れる', async () => {
    const api = fakeApi({ accounts: vi.fn(async () => next), setCurrentAccount: vi.fn(async () => next), cancelAccountLogin: vi.fn(async () => next), refreshAccount: vi.fn(async () => next) });
    const stores = [
      await runRow({ type: 'accounts.load' }, api),
      await runRow({ type: 'account.choose', accountId: 'a1' }, api),
      await runRow({ type: 'account.login.cancel', accountId: 'a2' }, api),
      await runRow({ type: 'account.refresh', accountId: 'a3' }, api),
    ].map((r) => r.store.accounts);
    expect(vi.mocked(api.accounts).mock.calls).toEqual([[]]);
    expect(vi.mocked(api.setCurrentAccount).mock.calls).toEqual([['a1']]);
    expect(vi.mocked(api.cancelAccountLogin).mock.calls).toEqual([['a2']]);
    expect(vi.mocked(api.refreshAccount).mock.calls).toEqual([['a3']]);
    expect(stores).toEqual([next, next, next, next]);
  });
  it('ログインは loginAccount を呼ぶだけで、進みは後から届く', async () => {
    const loginAccount = vi.fn(async () => {});
    const r = await runRow({ type: 'account.login', accountId: 'a1' }, fakeApi({ loginAccount }));
    expect(loginAccount.mock.calls).toEqual([['a1']]);
    expect(r.store).toBe(r.during);
  });
  it('更新は、渡された項目だけを送り、応答の一覧を Store に入れる', async () => {
    const updateAccount = vi.fn(async () => next);
    const api = fakeApi({ updateAccount });
    const r = await runRow({ type: 'account.update', accountId: 'a1', name: '研究室', color: '#7a4a9e' }, api);
    await runRow({ type: 'account.update', accountId: 'a1', color: '#7a4a9e' }, api);
    expect(updateAccount.mock.calls).toEqual([['a1', { name: '研究室', color: '#7a4a9e' }], ['a1', { color: '#7a4a9e' }]]);
    expect(r.store.accounts).toEqual(next);
  });
  it('更新の名前は前後の空白を落とし、空になれば送らず、送るものが無ければ何も呼ばない', async () => {
    const updateAccount = vi.fn(async () => next);
    const api = fakeApi({ updateAccount });
    await runRow({ type: 'account.update', accountId: 'a1', name: '  研究室 ' }, api);
    await runRow({ type: 'account.update', accountId: 'a1', name: '   ', color: '#7a4a9e' }, api);
    expect(updateAccount.mock.calls).toEqual([['a1', { name: '研究室' }], ['a1', { color: '#7a4a9e' }]]);
    const a = await runRow({ type: 'account.update', accountId: 'a1', name: '   ' }, api);
    const b = await runRow({ type: 'account.update', accountId: 'a1' }, api);
    expect([a.called, b.called]).toEqual([false, false]);
    expect(updateAccount).toHaveBeenCalledTimes(2);
  });
});
