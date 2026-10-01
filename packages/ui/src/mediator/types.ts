import type { IndexProgressDto, Intent, LaunchParams, ProjectStatus, ResolveAction, RetentionFrom, Route, SearchFilter, SearchParamsDto, ServerEvent, SettingsDto } from '@agent-hangar/shared';

/**
 * 検索の問い合わせ。期間を日数のまま持つ。
 * Mediator は時刻を知らないので、since に直すのは送る瞬間の Runtime である（toSearchParams）。
 */
export type SearchQuery = Omit<SearchParamsDto, 'since'> & { days?: number };

export type RuntimeEvent =
  // ws.close は時刻を運ぶ。Mediator は純粋な遷移なので、いつ切れたかを自分では測れない。
  | { type: 'ws.open' } | { type: 'ws.close'; at: number } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto }
  | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string }
  | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null }
  | { type: 'promote.failed'; message: string }
  // 分割の右に置くタブはストアを見ないと決まらないので、ランタイムが決めて返す。
  | { type: 'split.resolved'; sessionId: string; tabId: string | null }
  // 「次の入力待ちへ」の行き先。入力待ちが無ければ null。これもストアを見ないと決まらないので、ランタイムが決めて返す。
  | { type: 'waiting.resolved'; sessionId: string | null }
  // 入力待ちのセッションの一覧（hangar のセッションの id）。
  // 変わったときだけランタイムが届ける。
  // live.update はプロバイダの id で届き、hangar のセッションに引き当てるにはストアが要るからである。
  | { type: 'waiting.changed'; ids: string[] }
  // 通知を出せるか、受け取るか。
  // 起動時と、許可を求めた結果が出たときにランタイムが届ける。
  // blocked は OS（デスクトップならシステム設定）で通知が切られていること。省けば切られていない。
  | { type: 'notify.changed'; available: boolean; on: boolean; blocked?: boolean }
  // 窓が前面に戻ったら、寝ていた間の変更をすぐ取りに行く。
  | { type: 'window.focus' }
  // 目次から左のターミナルを跳ばした結果。
  | { type: 'turnJump.done'; sessionId: string; seq: number; status: TurnJumpStatus }
  // サーバが 409 で断ったときに、ランタイムがこの形に直して返す。
  | { type: 'api.conflict'; kind: 'resumeHere'; sessionId: string; localSize: number; remoteSize: number }
  // 保持期間を書き込んだ結果。409 は下見の後にファイルが変わったことを表す。
  | { type: 'retention.written'; days: number } | { type: 'retention.conflict'; days: number } | { type: 'retention.failed'; message: string }
  | { type: 'retention.previewFailed'; days: number; message: string }
  // 欄ごとの保存の結果。失敗はトーストにせず、その欄の下に理由を出す。
  | { type: 'settings.saved'; field: string } | { type: 'settings.failed'; field: string; message: string }
  // クリップボードに写せた。写せなかったときはランタイムがトーストで知らせ、これは届かない。
  | { type: 'clipboard.copied'; text: string };

export type Input =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent };

export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'history.go'; delta: number }
  | { kind: 'api.bootstrap' }
  // fromSeq の 0 は「開いた（最新側）」、-1 は「過去へ遡る」、-2 は「追記の取り込み（後ろを読み足す）」。
  // aroundSeq は検索の結果から開いたときの跳び先で、開いたときに最新の側ではなくその周りを読む。
  | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number; aroundSeq?: number }
  | { kind: 'api.search'; params: SearchQuery }
  | { kind: 'api.setProjectStatus'; projectId: string; status: ProjectStatus }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto>; field?: string }
  | { kind: 'api.readiness' }
  | { kind: 'shell.openLog' } | { kind: 'shell.restart' } | { kind: 'clipboard.copy'; text: string }
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
  // 入力待ちになったセッションを通知で知らせる。
  // 受け取る設定か、窓が背面かはランタイムが見る。
  | { kind: 'notify.waiting'; sessionId: string }
  // 通知の許可を求める。
  // 利用者の操作の中で出すので、ブラウザの許可ダイアログも出せる。
  | { kind: 'notify.request' }
  // Dock（ブラウザならアプリ）のバッジに入力待ちの数を出す。
  // 0 で消す。
  | { kind: 'badge'; count: number }
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
  | { kind: 'waiting.next'; from: string | null }
  | { kind: 'api.syncNow' } | { kind: 'api.syncPause'; paused: boolean } | { kind: 'api.syncFocus' }
  | { kind: 'api.resumeHere'; sessionId: string; overwrite: boolean }
  | { kind: 'api.configPreview' } | { kind: 'api.configPull' } | { kind: 'api.joinToken' }
  | { kind: 'api.retentionPreview'; days: number } | { kind: 'api.writeRetention'; days: number };

export type Screen = { name: 'booting' } | Route;
/** results はセッションの一覧の画面の結果の一覧である。 */
export type FocusTarget = 'search' | 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput' | 'results';
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
  | { kind: 'configPreview' }
  | { kind: 'retention'; days: number; from: RetentionFrom; reloaded: boolean; writing: boolean; previewError: string | null };
/** 新しいセッションのダイアログの書きかけ。プロジェクトごとではなく 1 つだけ持つ。 */
export type NewSessionDraft = { name: string; prompt: string };
/** 新しいセッションの詳細の前回値。起動したときの値のうち、既定でないものだけを持つ。 */
export type LaunchPrefs = Pick<LaunchParams, 'model' | 'effort' | 'permissionMode' | 'worktree' | 'addDirs'>;
export type LaunchState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'failed'; message: string };
/** 目次から左のターミナルを跳ばした結果。pending の間は注記を出さない。 */
export type TurnJumpStatus = 'pending' | 'found' | 'notFound' | 'mode' | 'failed';
/**
 * 本文の中の検索（⌘F）の状態。その場の操作なので保存しない。
 * from は語を打ったときに見ていた行の seq で、そこから後ろの最初の一致から数える。step はそこから進めた数。
 * n は ⌘F を押した回数で、押すたびに欄へフォーカスを戻す合図にする。
 */
export type FindState = { query: string; caseSensitive: boolean; from: number | null; step: number; n: number };
/** 検索の結果から開いたときの跳び先（J1）。n は開いた回数で、同じ所をもう一度開いても跳び直す合図にする。 */
export type JumpState = { seq: number; query: string; n: number };
export type SessionViewState = {
  agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null;
  /** 目次で開いているターン（区切りの行の seq）。その場の操作なので保存しない。 */
  openTurn: number | null;
  /** 開いたターンへ左のターミナルを跳ばした結果。これも保存しない。 */
  turnJump: { seq: number; status: TurnJumpStatus } | null;
  /** 本文の中の検索。閉じていれば null。 */
  find: FindState | null;
  /** 検索の結果から開いたときの跳び先。無ければ null。 */
  jump: JumpState | null;
};
export type Toast = { id: string; level: 'info' | 'error'; message: string };
/**
 * available は通知を出せる環境か（ブラウザで拒まれた後は false）、on は利用者が受け取ると決めて許可も得ているか。
 * blocked はデスクトップのシステム設定で切られていること。
 * 受け取るにしても OS が捨てるので on にせず、設定に許可の仕方を出す。
 */
export type NotifyState = { available: boolean; on: boolean; blocked: boolean };
/**
 * 欄ごとの保存の知らせ。
 * saved の n は同じ欄を保存するたびに進み、画面は変わるたびに「✓ 保存しました」を出し直す。
 * error は欄の下に出す理由で、同じ欄をもう一度保存し始めたら消える。
 */
export type SaveMark = { kind: 'saved'; n: number } | { kind: 'error'; message: string };
export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  /** 切れた最初の瞬間。画面がそこで止まっていることを言うために持つ。つながっている間は null。 */
  staleSince: number | null;
  /** 次に自動で試す時刻。待っているのか固まっているのかを見せるために持つ。 */
  nextRetryAt: number | null;
  sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
  /** 起動の進み。ダイアログからの起動も、再開もフォークも同じ状態を共有する。 */
  launch: LaunchState;
  /**
   * すでに知らせた入力待ちのセッション（hangar の id）。
   * 入力待ちが解けたら忘れる。
   */
  waitingSeen: string[];
  /**
   * 右下に積む入力待ちのカードのセッション。
   * 古いものが先。
   * 入力待ちが解けるか、そのセッションを開くまで残す。
   */
  waitingToasts: string[];
  /** 通知の受け取り。 */
  notify: NotifyState;
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
  /** 実行中の右ペインで「いま」の段が取る高さの上限（0.2〜0.8）。境目で変え、端末ごとに localStorage に残す。 */
  livePaneSplit: number;
  /** 保持期間の帯を「このままでよい」で閉じたか。端末ごとに localStorage に残し、起動時に読み戻す。 */
  retentionBannerDismissed: boolean;
  /** 新しいセッションのダイアログの書きかけ。閉じても残し、次に開いたときに戻す。端末ごとに localStorage に残す。 */
  newSessionDraft: NewSessionDraft | null;
  /**
   * 新しいセッションのダイアログから起動を送り、まだ終わっていないか。
   * 送った後にダイアログを閉じても起動は続くので、終わったときに下書きを消す手がかりにする。
   */
  newSessionSent: boolean;
  /**
   * 新しいセッションの詳細の、プロジェクトごとの前回値。鍵はプロジェクトの id で、スクラッチは ':scratch' である。
   * 次にそのプロジェクトでダイアログを開いたときの初期値にする。端末ごとに localStorage に残す。
   */
  launchPrefs: Record<string, LaunchPrefs>;
  /** 直前に受け取った索引の段階。走査が終わった瞬間を見つけるために持つ。 */
  indexPhase: IndexProgressDto['phase'];
  /** クラウド同期の見え方。同期を設定していなければ off のままである。 */
  sync: SyncState;
  /** まだ送れていない変更の件数。ヘッダーの同期表示に出す。 */
  pending: number;
  /** 欄ごとの保存の知らせ。欄の名前（設定の項目名）で引く。 */
  settingsSave: Record<string, SaveMark>;
  /**
   * 最後にクリップボードへ写せた文。
   * n は写せるたびに進み、コピーのボタンは押した後に進んだのを見てから「コピーしました」を出す。
   * 写せなかったときは進まない。
   */
  copied: { text: string; n: number } | null;
};
export type Step = { state: State; effects: Effect[] };
export const NOT_YET = 'この操作は次のフェーズで実装します';
export const ITERM_HINT = 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます';
