import type { IndexProgressDto, Intent, LaunchParams, ProjectStatus, ResolveAction, Route, SearchFilter, SearchParamsDto, ServerEvent, SettingsDto } from '@agent-hangar/shared';

export type RuntimeEvent =
  | { type: 'ws.open' } | { type: 'ws.close' } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto }
  | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string }
  | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null }
  | { type: 'promote.failed'; message: string }
  // 分割の右に置くタブはストアを見ないと決まらないので、ランタイムが決めて返す。
  | { type: 'split.resolved'; sessionId: string; tabId: string | null };

export type Input =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent };

export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'api.bootstrap' }
  | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number }     // -1 は「次のページ」
  | { kind: 'api.search'; params: SearchParamsDto }
  | { kind: 'api.setProjectStatus'; projectId: string; status: ProjectStatus }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto> }
  | { kind: 'api.rebuildIndex' }
  | { kind: 'api.launch'; params: LaunchParams } | { kind: 'api.resume'; sessionId: string } | { kind: 'api.fork'; sessionId: string }
  | { kind: 'api.killRun'; runId: string } | { kind: 'api.openTab'; sessionId: string } | { kind: 'api.closeTab'; tabId: string }
  | { kind: 'api.openTerminalApp'; runId: string; tabId: string | null } | { kind: 'api.openEditor'; sessionId: string }
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
  | { kind: 'split.resolve'; sessionId: string };

export type Screen = { name: 'booting' } | Route;
export type FocusTarget = 'search' | 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput';
export type Overlay =
  | { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' } | { kind: 'notYet'; feature: string }
  | { kind: 'newSession'; projectId: string | null; scratch: boolean }
  | { kind: 'promote'; sessionId: string }
  | { kind: 'promoted'; projectId: string; moved: boolean; reason: string | null };
export type LaunchState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'failed'; message: string };
export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null };
export type Toast = { id: string; level: 'info' | 'error'; message: string };
export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
  /** 起動の進み。ダイアログからの起動も、再開もフォークも同じ状態を共有する。 */
  launch: LaunchState;
  /** すでにトーストで知らせた waiting のセッション。busy に戻ったら忘れる。 */
  waitingSeen: string[];
  /** 昇格ダイアログの進み。起動と同じ形の状態を使う。 */
  promote: LaunchState;
  /** 事後要約に失敗したセッション。ヘッダーの要約の横に出す。 */
  summaryFailed: Record<string, string>;
  toasts: Toast[]; unresolvedQueue: string[]; nextToastId: number;
  /** 直前に受け取った索引の段階。走査が終わった瞬間を見つけるために持つ。 */
  indexPhase: IndexProgressDto['phase'];
};
export type Step = { state: State; effects: Effect[] };
export const NOT_YET = 'この操作は次のフェーズで実装します';
export const ITERM_HINT = 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます';
