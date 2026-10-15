import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ArtifactDto, UiAction, SessionDto } from '@agent-hangar/shared';
import type { MediatedAction } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';
import { EditorMissingApiError, type ApiClient } from './api.ts';
import { FELL_BACK, FELL_BACK_WINDOWS, LONG_TOAST_MS, actionCall, actionTable, isTableAction, type TableAction } from './actionTable.ts';

/** 表が使う API だけの偽物。表に無い API を呼べば、型が合わなくなるか、無い関数を呼んで落ちる。 */
function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return { ...fakeApiExtras(), setProjectStatus: vi.fn(async () => { throw new Error('not used in this test'); }), ...over } as ApiClient;
}

/** 表の 1 行を引いて呼び、応答の扱い（Store の更新と知らせ）まで行う。Runtime の runCall と同じ順である。 */
async function runRow(action: TableAction, api: ApiClient, store: Store = initialStore()) {
  const call = actionCall(action, store);
  if (!call) return { called: false as const, store, during: store, toast: null, toastHoldMs: null };
  const during = call.before ? call.before(store) : store;
  try {
    const done = await call.run(api);
    return { called: true as const, during, store: done.apply ? done.apply(during) : during, toast: done.toast ?? null, toastHoldMs: done.toastHoldMs ?? null };
  } catch (e) {
    // 失敗の行き先を持つ行は Store に書く。持たない行は Runtime がトーストにするので、ここでは投げ直す。
    // failed が null を返した失敗も、Runtime がトーストにする。
    const next = call.failed?.(during, e) ?? null;
    if (!next) throw e;
    return { called: true as const, during, store: next, toast: null, toastHoldMs: null };
  }
}

describe('表の鍵', () => {
  it('表にある UiAction は、型でも実行時でも見分けられる', () => {
    expect(isTableAction({ type: 'project.setStatus', id: 'p1', status: 'paused' })).toBe(true);
    expect(isTableAction({ type: 'nav.back' })).toBe(false);
    // Object の持ち物（toString など）を鍵と取り違えない。
    expect(isTableAction({ type: 'toString' } as unknown as UiAction)).toBe(false);
  });
  it('表の鍵は UiAction の kind の部分集合で、Mediator の入力の型からは外れている', () => {
    expectTypeOf<TableAction['type']>().toMatchTypeOf<UiAction['type']>();
    expectTypeOf<Extract<MediatedAction, { type: TableAction['type'] }>>().toBeNever();
    // 表に無いものは、Mediator の入力に残る。
    expectTypeOf<{ type: 'nav.back' }>().toMatchTypeOf<MediatedAction>();
  });
  it('表に載っているのは、API を 1 回呼ぶだけの UiAction である', () => {
    expect(Object.keys(actionTable).sort()).toEqual([
      'account.add.preview', 'account.choose', 'account.login', 'account.login.cancel', 'account.refresh', 'account.update', 'accounts.load',
      'artifact.add', 'artifact.open', 'artifact.openEditor', 'configSync.order.cancel', 'configSync.unsent.send', 'editor.test', 'editors.load', 'folder.inspect', 'git.changes.load', 'git.diff.load', 'git.edits.load', 'instructions.load', 'instructions.openEditor', 'memo.save',
      'overlap.dismiss', 'project.git.load', 'project.openEditor', 'project.openTerminalApp', 'project.rename', 'project.setStatus',
      'session.openEditor', 'session.openFile', 'session.openTerminalApp', 'session.state.reject', 'setupGuide.openEditor', 'summarizer.test', 'summary.regenerate',
      'sync.now', 'sync.pause',
    ]);
  });
});

describe('同じファイルの編集', () => {
  it('「このファイルでは表示しない」は相手とパスを渡し、応答は Store に入れない（写しは session.upsert で消える）', async () => {
    const dismissOverlap = vi.fn(async () => {});
    const r = await runRow({ type: 'overlap.dismiss', sessionId: 's1', with: 's2', paths: ['/w/a.ts'] }, fakeApi({ dismissOverlap }));
    expect(dismissOverlap.mock.calls).toEqual([['s1', 's2', ['/w/a.ts']]]);
    expect(r.store).toBe(r.during);
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
    expect(vi.mocked(api.projectOpenEditor).mock.calls).toEqual([['p1', undefined]]);
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
  it('Windows Terminal が無く既定のターミナルに落ちたときは、Windows の文で知らせる', async () => {
    const c = await runRow({ type: 'session.openTerminalApp', runId: 'r1' }, fakeApi({ openTerminalApp: vi.fn(async () => ({ app: 'windowsDefault' as const, fellBack: true })) }));
    expect(c.toast).toBe(FELL_BACK_WINDOWS);
    const d = await runRow({ type: 'project.openTerminalApp', id: 'p1' }, fakeApi({ projectOpenTerminal: vi.fn(async () => ({ app: 'windowsDefault' as const, fellBack: true })) }));
    expect(d.toast).toBe(FELL_BACK_WINDOWS);
  });
  it('外部ターミナルが開けず別のもので開いた知らせは、読み切れるよう長く出す。ほかの知らせの長さは変えない', async () => {
    const win = await runRow({ type: 'session.openTerminalApp', runId: 'r1' }, fakeApi({ openTerminalApp: vi.fn(async () => ({ app: 'windowsDefault' as const, fellBack: true })) }));
    expect(win.toastHoldMs).toBe(LONG_TOAST_MS);
    expect(LONG_TOAST_MS).toBeGreaterThanOrEqual(8000);
    const mac = await runRow({ type: 'session.openTerminalApp', runId: 'r1' }, fakeApi({ openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) }));
    expect(mac.toastHoldMs).toBe(LONG_TOAST_MS);
    const none = await runRow({ type: 'session.openTerminalApp', runId: 'r1' }, fakeApi({ openTerminalApp: vi.fn(async () => ({ app: 'windowsTerminal' as const, fellBack: false })) }));
    expect(none.toastHoldMs).toBeNull();
  });
  it('エディタで開く。変更したファイルを押したときだけ、そのファイルを添える', async () => {
    const openEditor = vi.fn(async (_sessionId: string, _file?: string) => {});
    const api = fakeApi({ openEditor });
    await runRow({ type: 'session.openFile', sessionId: 's1', path: '/w/a.ts' }, api);
    await runRow({ type: 'session.openEditor', sessionId: 's1' }, api);
    // ファイルの無いほうは、ファイルを渡さない。行と今回だけのエディタは、あれば添える。
    expect(openEditor.mock.calls).toEqual([['s1', '/w/a.ts', { line: undefined, once: undefined }], ['s1', undefined, { once: undefined }]]);
  });
  it('提案の却下は rejectSessionState を呼び、応答は Store に入れない', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'session.state.reject', id: 's1' }, api);
    expect(vi.mocked(api.rejectSessionState).mock.calls).toEqual([['s1']]);
    // 画面の正は後から届く session.upsert である。
    expect(r.store).toBe(r.during);
  });
  it('要約の作り直しは regenerateSummary を呼ぶだけで、結果は待たない', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'summary.regenerate', sessionId: 's1' }, api);
    expect(vi.mocked(api.regenerateSummary).mock.calls).toEqual([['s1']]);
    expect(r.store).toBe(r.during);
  });
});

describe('作業台', () => {
  it('メモの保存は、応答のメモを Store に入れる', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'memo.save', projectId: 'p1', markdown: '# m' }, api);
    expect(vi.mocked(api.saveMemo).mock.calls).toEqual([['p1', '# m']]);
    expect(r.store.memos).toEqual({ p1: { projectId: 'p1', markdown: '# m', updatedAt: 2 } });
  });
  it('指示とメモリを読み直すと Store に入れ、エディタで開くは種類を渡すだけ', async () => {
    const api = fakeApi();
    const r = await runRow({ type: 'instructions.load', projectId: 'p1' }, api);
    expect(vi.mocked(api.instructions).mock.calls).toEqual([['p1']]);
    expect(r.store.instructions).toEqual({ p1: { projectId: 'p1', available: true, files: [] } });
    const o = await runRow({ type: 'instructions.openEditor', projectId: 'p1', kind: 'memory' }, api);
    expect(vi.mocked(api.openInstruction).mock.calls).toEqual([['p1', 'memory', undefined]]);
    expect(o.store).toBe(o.during);
  });
  it('アーティファクトを開く、エディタで開く', async () => {
    const api = fakeApi();
    await runRow({ type: 'artifact.open', id: 'a1' }, api);
    await runRow({ type: 'artifact.openEditor', id: 'a2' }, api);
    expect(vi.mocked(api.openArtifact).mock.calls).toEqual([['a1']]);
    expect(vi.mocked(api.openArtifactEditor).mock.calls).toEqual([['a2', undefined]]);
  });
  it('エディタが見つからなければ、トーストにせず面を出し、今回だけのエディタで送り直せる。開けたら面を閉じる', async () => {
    const missing = { code: 'editor_missing' as const, error: 'Cursor が見つかりません', editor: 'cursor' as const, name: 'Cursor', lastPath: '/usr/local/bin/cursor', others: ['vscode' as const] };
    const projectOpenEditor = vi.fn(async (_id: string, once?: string) => { if (!once) throw new EditorMissingApiError(missing); });
    const r = await runRow({ type: 'project.openEditor', id: 'p1' }, fakeApi({ projectOpenEditor }));
    expect(r.store.editorMissing).toEqual({ ...missing, retry: { type: 'project.openEditor', id: 'p1' }, n: 1 });
    const again = await runRow({ type: 'project.openEditor', id: 'p1', once: 'vscode' }, fakeApi({ projectOpenEditor }), r.store);
    expect(projectOpenEditor.mock.calls).toEqual([['p1', undefined], ['p1', 'vscode']]);
    expect(again.store.editorMissing).toBeNull();
    // ほかの失敗は、ふつうどおりトーストにする（投げ直す）。
    await expect(runRow({ type: 'session.openFile', sessionId: 's1', path: '/w/a.ts', line: 3 }, fakeApi({ openEditor: vi.fn(async () => { throw new Error('boom'); }) }))).rejects.toThrow('boom');
  });
  it('セットアップのすゝめの中身を見るは、写した md をエディタで開く。見つからなければ同じ面を出し、今回だけのエディタで送り直せる', async () => {
    const missing = { code: 'editor_missing' as const, error: 'Cursor が見つかりません', editor: 'cursor' as const, name: 'Cursor', lastPath: null, others: ['vscode' as const] };
    const openSetupGuide = vi.fn(async (once?: string) => { if (!once) throw new EditorMissingApiError(missing); });
    const r = await runRow({ type: 'setupGuide.openEditor' }, fakeApi({ openSetupGuide }));
    expect(r.store.editorMissing).toEqual({ ...missing, retry: { type: 'setupGuide.openEditor' }, n: 1 });
    const again = await runRow({ type: 'setupGuide.openEditor', once: 'vscode' }, fakeApi({ openSetupGuide }), r.store);
    expect(openSetupGuide.mock.calls).toEqual([[undefined], ['vscode']]);
    expect(again.store.editorMissing).toBeNull();
  });
  it('アーティファクトの追加は、URL の前後の空白を落として送り、応答を Store に入れる', async () => {
    const added = { id: 'a1', projectId: 'p1' } as ArtifactDto;
    const addArtifact = vi.fn(async () => added);
    const r = await runRow({ type: 'artifact.add', projectId: 'p1', url: '  https://example.test/x ' }, fakeApi({ addArtifact }));
    expect(addArtifact.mock.calls).toEqual([['p1', 'https://example.test/x']]);
    expect(r.store.artifacts).toEqual({ a1: added });
  });
  it('追加が断られたら、理由と入れた URL を Store に残す。次の追加を始めるときと、成功したときに消す', async () => {
    const addArtifact = vi.fn(async () => { throw new Error('すでにプロジェクト「alpha」に付いています'); });
    const r = await runRow({ type: 'artifact.add', projectId: 'p1', url: ' https://claude.ai/code/artifact/x ' }, fakeApi({ addArtifact }));
    expect(r.store.artifactAddError).toEqual({ projectId: 'p1', url: 'https://claude.ai/code/artifact/x', message: 'すでにプロジェクト「alpha」に付いています' });
    const again = await runRow({ type: 'artifact.add', projectId: 'p1', url: 'https://claude.ai/code/artifact/y' }, fakeApi({ addArtifact: vi.fn(async () => ({ id: 'a2', projectId: 'p1' }) as ArtifactDto) }), r.store);
    expect(again.during.artifactAddError).toBeNull();
    expect(again.store.artifactAddError).toBeNull();
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

describe('設定の同期（作り直した実装）', () => {
  it('指示書の取り消しは DELETE を呼ぶだけで、応答は Store に入れない', async () => {
    const configDeleteOrder = vi.fn(async () => {});
    const r = await runRow({ type: 'configSync.order.cancel' }, fakeApi({ configDeleteOrder }));
    expect(configDeleteOrder).toHaveBeenCalledTimes(1);
    expect(r.store).toBe(r.during);
  });
  it('それでも送るは、更新後の送らなかった項目の一覧を Store に入れる', async () => {
    const list = { items: [{ id: 'u', kind: 'secret' as const, itemId: 'i', label: 'x', reason: 'secret:ghp_', allowed: true }] };
    const configSendUnsent = vi.fn(async () => list);
    const r = await runRow({ type: 'configSync.unsent.send', id: 'u' }, fakeApi({ configSendUnsent }));
    expect(configSendUnsent.mock.calls).toEqual([['u']]);
    expect(r.store.configDetail.unsent).toEqual(list);
  });
});

describe('git の表示', () => {
  it('差分の一覧、プロジェクトの git は、答えを Store に入れる', async () => {
    const changes = { state: 'nogit' as const, root: null, tree: null, files: [], others: [], othersCapped: false };
    const api = fakeApi({ sessionChanges: vi.fn(async () => changes), projectGit: vi.fn(async () => ({ root: null, worktrees: [] })) });
    expect((await runRow({ type: 'git.changes.load', sessionId: 's1' }, api)).store.gitChanges).toEqual({ s1: changes });
    expect((await runRow({ type: 'project.git.load', projectId: 'p1' }, api)).store.projectGit).toEqual({ p1: { root: null, worktrees: [] } });
  });
  it('差分と編集は、ファイルの組で入れる。読めなければ理由を入れ、トーストにしない', async () => {
    const diff = { file: '/w/a.ts', rel: 'a.ts', status: 'M' as const, text: '', truncated: false, binary: false };
    const ok = await runRow({ type: 'git.diff.load', sessionId: 's1', file: '/w/a.ts' }, fakeApi({ sessionDiff: vi.fn(async () => diff) }));
    expect(ok.store.gitDiffs).toEqual({ 's1\n/w/a.ts': diff });
    const bad = await runRow({ type: 'git.edits.load', sessionId: 's1', file: '/w/a.ts' }, fakeApi({ sessionEdits: vi.fn(async () => { throw new Error('ありません'); }) }));
    expect(bad.store.gitEdits).toEqual({ 's1\n/w/a.ts': { error: 'ありません' } });
  });
});
