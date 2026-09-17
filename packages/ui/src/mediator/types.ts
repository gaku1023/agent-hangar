import type { IndexProgressDto, Intent, ProjectStatus, ResolveAction, Route, SearchFilter, SearchParamsDto, ServerEvent, SettingsDto } from '@agent-hangar/shared';

export type RuntimeEvent =
  | { type: 'ws.open' } | { type: 'ws.close' } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto };

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
  | { kind: 'ws.connect' } | { kind: 'ws.reconnectAfter'; ms: number }
  | { kind: 'focus'; target: 'search' }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  | { kind: 'storage.save'; key: string; value: unknown };

export type Screen = { name: 'booting' } | Route;
export type Overlay = { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' } | { kind: 'notYet'; feature: string };
export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean };
export type Toast = { id: string; level: 'info' | 'error'; message: string };
export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
  toasts: Toast[]; unresolvedQueue: string[]; nextToastId: number;
  /** 直前に受け取った索引の段階。走査が終わった瞬間を見つけるために持つ。 */
  indexPhase: IndexProgressDto['phase'];
};
export type Step = { state: State; effects: Effect[] };
export const NOT_YET = 'この操作は次のフェーズで実装します';
