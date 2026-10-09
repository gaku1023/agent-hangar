import type { AccountsDto, Intent, SyncStatusBody } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import type { ApiClient } from './api.ts';

/** iTerm2 で開けず、Terminal.app に落ちたときの知らせ。 */
export const FELL_BACK = 'iTerm2 で開けなかったので Terminal.app で開きました';

/** 応答を受けた後にすること。apply は応答が着いた時点の Store に当てる。toast は情報の知らせである。 */
export type CallDone = { apply?: (store: Store) => Store; toast?: string };
/**
 * API の呼び出し 1 回と、その前後の扱い。
 * before は呼ぶ前に Store に当てる（実行中だと分かるよう、前の結果を消すなど）。
 * 失敗の扱いは行ごとに持たない。どの行も、Runtime がトーストにする。
 */
export type ApiCall = { before?: (store: Store) => Store; run: (api: ApiClient) => Promise<CallDone> };

type After<T> = { before?: (store: Store) => Store; apply?: (store: Store, r: T) => Store; toast?: (r: T) => string | null };

/** 行の共通の形。API を呼び、応答を Store に当て、知らせがあれば添える。応答の型は、ここで閉じる。 */
function call<T>(run: (api: ApiClient) => Promise<T>, after: After<T> = {}): ApiCall {
  const { before, apply, toast } = after;
  return {
    ...(before ? { before } : {}),
    run: (api) => run(api).then((r) => {
      const message = toast?.(r) ?? null;
      return { ...(apply ? { apply: (store: Store) => apply(store, r) } : {}), ...(message !== null ? { toast: message } : {}) };
    }),
  };
}

const withSync = (store: Store, sync: SyncStatusBody): Store => ({ ...store, sync });
const withAccounts = (store: Store, accounts: AccountsDto): Store => ({ ...store, accounts });

type Rows = { [K in Intent['type']]?: (intent: Extract<Intent, { type: K }>, store: Store) => ApiCall | null };

/**
 * API を 1 回呼ぶだけの Intent の表。
 * ここにある Intent は、Mediator も Effect も通らない。Runtime が受けて、この表で引いた呼び出しをそのまま実行する。
 * 行は、Intent の中身と Store（読むだけ）から呼び出しを組む。null を返せば何も呼ばない。
 * State を読むもの、State を変えるもの、応答を Mediator へ戻すもの、API を 2 回以上呼ぶものは、ここへ置かず Mediator に残す。
 */
export const intentTable = {
  // 画面の正は後から届く project.upsert なので、返り値は Store に入れない。
  'project.setStatus': (i) => call((api) => api.setProjectStatus(i.id, i.status)),
  'project.rename': (i) => call((api) => api.renameProject(i.id, i.name)),
  'project.openEditor': (i) => call((api) => api.projectOpenEditor(i.id)),
  'project.openTerminalApp': (i) => call((api) => api.projectOpenTerminal(i.id), { toast: (r) => (r.fellBack ? FELL_BACK : null) }),

  'session.openTerminalApp': (i) => call((api) => api.openTerminalApp(i.runId, i.tabId ?? null), { toast: (r) => (r.fellBack ? FELL_BACK : null) }),
  'session.openEditor': (i) => call((api) => api.openEditor(i.sessionId)),
  // 変更したファイルを押したとき。path は本文に出てきた綴りのまま渡す。
  'session.openFile': (i) => call((api) => api.openEditor(i.sessionId, i.path)),
  // 画面の正は後から届く session.upsert なので、返り値は Store に入れない。
  'session.state.reject': (i) => call((api) => api.rejectSessionState(i.id)),
  'session.setMemo': (i) => call((api) => api.setSessionMemo(i.id, i.text), { apply: (store, s) => ({ ...store, sessions: { ...store.sessions, [s.id]: s } }) }),
  // 進みと結果は summary.pending と summary.updated で届くので、ここでは待たない。
  'summary.regenerate': (i) => call((api) => api.regenerateSummary(i.sessionId)),

  // 反転の基準は Store の今の値にする。View は done の値を持たない。
  // 候補の欄を押したときは確定と同じに扱う。候補は未完なので、素直に反転すると done: false を送って何も起きない。
  'todo.toggle': (i, store) => {
    const t = store.todos[i.id];
    if (!t) return null;
    return t.candidate && !t.done ? call((api) => api.confirmTodo(i.id)) : call((api) => api.setTodoDone(i.id, !t.done));
  },
  'todo.remove': (i) => call((api) => api.removeTodo(i.id)),
  'todo.confirm': (i) => call((api) => api.confirmTodo(i.id)),
  'todo.reject': (i) => call((api) => api.rejectTodo(i.id)),
  // 保存した結果はサーバの memo.update より先に入れる。書いた本人の画面が一瞬古い本文に戻らないようにする。
  'memo.save': (i) => call((api) => api.saveMemo(i.projectId, i.markdown), { apply: (store, m) => ({ ...store, memos: { ...store.memos, [m.projectId]: m } }) }),
  'artifact.open': (i) => call((api) => api.openArtifact(i.id)),
  'artifact.openEditor': (i) => call((api) => api.openArtifactEditor(i.id)),
  'artifact.add': (i) => {
    const url = i.url.trim();
    return url ? call((api) => api.addArtifact(i.projectId, url), { apply: (store, a) => ({ ...store, artifacts: { ...store.artifacts, [a.id]: a } }) }) : null;
  },

  // 前回の結果を先に消して、試している最中だと分かるようにする。
  'summarizer.test': () => call((api) => api.testSummarizer(), { before: (store) => ({ ...store, summarizerTest: null }), apply: (store, r) => ({ ...store, summarizerTest: r }) }),

  // 同期。応答の状態は Store に直に当てる（サーバの sync.status と同じ形）。同期の状態は Store だけが持つので、Mediator へは流さない。
  'sync.now': () => call((api) => api.syncNow(), { apply: withSync }),
  'sync.pause': (i) => call((api) => api.syncPause(i.paused), { apply: withSync }),

  // Claude Code のアカウント。一覧を返すものは、応答をそのまま Store に入れる（サーバの accounts.update と同じ形）。
  'accounts.load': () => call((api) => api.accounts(), { apply: withAccounts }),
  'account.choose': (i) => call((api) => api.setCurrentAccount(i.accountId), { apply: withAccounts }),
  'account.update': (i) => {
    // 名前は前後の空白を落とす。空になった名前は送らず、送るものが無ければ何も呼ばない。
    const name = i.name?.trim();
    const patch = { ...(name ? { name } : {}), ...(i.color !== undefined ? { color: i.color } : {}) };
    return Object.keys(patch).length === 0 ? null : call((api) => api.updateAccount(i.accountId, patch), { apply: withAccounts });
  },
  // ログインの進みは accounts.update で届くので、応答は使わない。
  'account.login': (i) => call((api) => api.loginAccount(i.accountId)),
  'account.login.cancel': (i) => call((api) => api.cancelAccountLogin(i.accountId), { apply: withAccounts }),
  'account.refresh': (i) => call((api) => api.refreshAccount(i.accountId), { apply: withAccounts }),
} satisfies Rows;

/** 表にある Intent。Mediator の入力の型からは、これを外す（mediator/types.ts の MediatedIntent）。 */
export type TableIntent = Extract<Intent, { type: keyof typeof intentTable }>;

export function isTableIntent(intent: Intent): intent is TableIntent {
  return Object.hasOwn(intentTable, intent.type);
}

/** 表を引く。行と Intent の型は鍵で対になっているので、ここで 1 度だけ型を合わせる。 */
export function intentCall(intent: TableIntent, store: Store): ApiCall | null {
  const row = intentTable[intent.type] as (intent: TableIntent, store: Store) => ApiCall | null;
  return row(intent, store);
}
