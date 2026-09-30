import type { IndexProgressDto, Intent, LaunchParams, ProjectStatus, ResolveAction, Route, SearchFilter, SearchParamsDto, ServerEvent, SettingsDto } from '@agent-hangar/shared';

export type RuntimeEvent =
  // ws.close は時刻を運ぶ。Mediator は純粋な遷移なので、いつ切れたかを自分では測れない。
  | { type: 'ws.open' } | { type: 'ws.close'; at: number } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto }
  | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string }
  | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null }
  | { type: 'promote.failed'; message: string }
  // 分割の右に置くタブはストアを見ないと決まらないので、ランタイムが決めて返す。
  | { type: 'split.resolved'; sessionId: string; tabId: string | null }
  // 窓が前面に戻ったら、寝ていた間の変更をすぐ取りに行く。
  | { type: 'window.focus' }
  // 目次から左のターミナルを跳ばした結果。
  | { type: 'turnJump.done'; sessionId: string; seq: number; status: TurnJumpStatus }
  // サーバが 409 で断ったときに、ランタイムがこの形に直して返す。
  | { type: 'api.conflict'; kind: 'resumeHere'; sessionId: string; localSize: number; remoteSize: number };

export type Input =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent };

export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'history.go'; delta: number }
  | { kind: 'api.bootstrap' }
  | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number }     // 0 は「開いた（最新側）」、-1 は「過去へ遡る」、-2 は「追記の取り込み」
  | { kind: 'api.search'; params: SearchParamsDto }
  | { kind: 'api.setProjectStatus'; projectId: string; status: ProjectStatus }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto> }
  | { kind: 'api.rebuildIndex' }
  | { kind: 'api.launch'; params: LaunchParams } | { kind: 'api.resume'; sessionId: string } | { kind: 'api.fork'; sessionId: string }
  | { kind: 'api.attach'; sessionId: string } | { kind: 'api.adopt'; sessionId: string }
  | { kind: 'api.killRun'; runId: string } | { kind: 'api.openTab'; sessionId: string } | { kind: 'api.closeTab'; tabId: string }
  | { kind: 'api.openTerminalApp'; runId: string; tabId: string | null } | { kind: 'api.openEditor'; sessionId: string }
  | { kind: 'api.jumpToPrompt'; sessionId: string; runId: string; seq: number; heads: string[]; index: number; from: 'top' | 'bottom' }
  | { kind: 'api.leaveTranscript'; runId: string }
  | { kind: 'api.projectOpenEditor'; projectId: string } | { kind: 'api.projectOpenTerminal'; projectId: string }
  | { kind: 'terminal.connect'; sessionId: string; tabId: string | null } | { kind: 'terminal.disconnect'; tabId: string }
  | { kind: 'terminal.disconnectSession'; sessionId: string }
  | { kind: 'ws.connect' } | { kind: 'ws.reconnectAfter'; ms: number }
  | { kind: 'focus'; target: FocusTarget }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  | { kind: 'storage.save'; key: string; value: unknown }
  | { kind: 'api.addTodo'; projectId: string; text: string }
  | { kind: 'api.toggleTodo'; id: string }
  | { kind: 'api.removeTodo'; id: string }
  | { kind: 'api.confirmTodo'; id: string }
  | { kind: 'api.rejectTodo'; id: string }
  | { kind: 'api.loadMemo'; projectId: string }
  | { kind: 'api.saveMemo'; projectId: string; markdown: string }
  | { kind: 'api.setSessionMemo'; sessionId: string; text: string }
  | { kind: 'api.openArtifact'; id: string }
  | { kind: 'api.openArtifactEditor'; id: string }
  | { kind: 'api.addArtifact'; projectId: string; url: string }
  | { kind: 'api.promote'; sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }
  | { kind: 'api.regenerateSummary'; sessionId: string }
  | { kind: 'api.loadSettingsExtras' }
  | { kind: 'api.testSummarizer' }
  | { kind: 'split.resolve'; sessionId: string }
  | { kind: 'api.syncNow' } | { kind: 'api.syncPause'; paused: boolean } | { kind: 'api.syncFocus' }
  | { kind: 'api.resumeHere'; sessionId: string; overwrite: boolean }
  | { kind: 'api.configPreview' } | { kind: 'api.configPull' } | { kind: 'api.joinToken' };

export type Screen = { name: 'booting' } | Route;
export type FocusTarget = 'search' | 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput';
/** 同期の見え方。サーバの SyncStatusDto を UI が描く形に写したもの。 */
export type SyncState = { kind: 'off' } | { kind: 'idle'; lastAt: number | null } | { kind: 'pushing' } | { kind: 'pulling' } | { kind: 'paused' } | { kind: 'error'; message: string };
/**
 * 押し切る前に一言聞く必要があるもの。
 * 他端末の本文で手元を上書きする場面、外のターミナルの claude を引き取る場面、作業中かシェルタブのあるランを止める場面、
 * 見つからないプロジェクトを一覧から削除する場面である。
 */
export type ConfirmRequest =
  | { kind: 'overwriteTranscript'; sessionId: string; localSize: number; remoteSize: number }
  | { kind: 'adoptSession'; sessionId: string }
  | { kind: 'killRun'; runId: string; working: boolean; shellTabs: number }
  | { kind: 'unlinkProject'; projectId: string };
export type Overlay =
  | { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' } | { kind: 'notYet'; feature: string }
  | { kind: 'shortcuts' }
  | { kind: 'newSession'; projectId: string | null; scratch: boolean }
  | { kind: 'promote'; sessionId: string }
  | { kind: 'promoted'; projectId: string; moved: boolean; reason: string | null }
  | { kind: 'confirm'; confirm: ConfirmRequest }
  | { kind: 'configPreview' };
export type LaunchState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'failed'; message: string };
/** 目次から左のターミナルを跳ばした結果。pending の間は注記を出さない。 */
export type TurnJumpStatus = 'pending' | 'found' | 'notFound' | 'mode' | 'failed';
export type SessionViewState = {
  agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null;
  /** 目次で開いているターン（区切りの行の seq）。その場の操作なので保存しない。 */
  openTurn: number | null;
  /** 開いたターンへ左のターミナルを跳ばした結果。これも保存しない。 */
  turnJump: { seq: number; status: TurnJumpStatus } | null;
};
export type Toast = { id: string; level: 'info' | 'error'; message: string };
export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  /** 切れた最初の瞬間。画面がそこで止まっていることを言うために持つ。つながっている間は null。 */
  staleSince: number | null;
  /** 次に自動で試す時刻。待っているのか固まっているのかを見せるために持つ。 */
  nextRetryAt: number | null;
  sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
  /** 起動の進み。ダイアログからの起動も、再開もフォークも同じ状態を共有する。 */
  launch: LaunchState;
  /** すでにトーストで知らせた waiting のセッション。busy に戻ったら忘れる。 */
  waitingSeen: string[];
  /** focus: terminal で開いたセッション。その画面に着いたら端末にフォーカスし、着いたら忘れる。 */
  focusOnOpen: string | null;
  /**
   * 昇格ダイアログの進み。
   * 起動と同じ形の状態を使う。
   */
  promote: LaunchState;
  /**
   * 事後要約に失敗したセッション。
   * ヘッダーの要約の横に出す。
   */
  summaryFailed: Record<string, string>;
  toasts: Toast[]; unresolvedQueue: string[]; nextToastId: number;
  /**
   * 未解決のまま「あとで」を選んだプロジェクト。
   * bootstrap のたびに同じことを聞かれないように覚える。
   * 永続させないので、サーバを立て直せばまた聞く。
   */
  resolveDeferred: string[];
  /** サイドバーを図とアイコンだけの帯に縮めているか。開閉のたびに保存し、起動時に読み戻す。 */
  sidebarCollapsed: boolean;
  /** 直前に受け取った索引の段階。走査が終わった瞬間を見つけるために持つ。 */
  indexPhase: IndexProgressDto['phase'];
  /** クラウド同期の見え方。同期を設定していなければ off のままである。 */
  sync: SyncState;
  /** まだ送れていない変更の件数。ヘッダーの同期表示に出す。 */
  pending: number;
};
export type Step = { state: State; effects: Effect[] };
export const NOT_YET = 'この操作は次のフェーズで実装します';
export const ITERM_HINT = 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます';
