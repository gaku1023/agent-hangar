import type { ConfigApplyOrderEntryIn, ConfigSyncPart, Intent, LaunchParams, ProjectPlace, ResolveAction, RetentionFrom, Route, SearchFilter, SearchParamsDto, ServerEvent, SessionStatus, SettingsDto } from '@agent-hangar/shared';
import type { TableIntent } from '../runtime/intentTable.ts';
import type { ConfigDetailPart } from '../store/store.ts';

/**
 * 検索の問い合わせ。期間を日数のまま持つ。
 * Mediator は時刻を知らないので、since に直すのは送る瞬間の Runtime である（toSearchParams）。
 */
export type SearchQuery = Omit<SearchParamsDto, 'since'> & { days?: number };

export type RuntimeEvent =
  // ws.close は時刻を運ぶ。Mediator は純粋な遷移なので、いつ切れたかを自分では測れない。
  | { type: 'ws.open' } | { type: 'ws.close'; at: number } | { type: 'hash.changed'; route: Route; moved?: number }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto }
  | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string }
  | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null }
  | { type: 'promote.failed'; message: string }
  // 作ってから起動する送信の途中で、プロジェクトができた。params は作ったプロジェクトの id を入れた起動の詳細である。
  | { type: 'project.created'; projectId: string; params: LaunchParams }
  // プロジェクト画面の作成のダイアログの結果。
  | { type: 'project.create.done'; projectId: string; startSession: boolean } | { type: 'project.create.failed'; message: string }
  // 時刻つきの Paused のうち、今日その時刻を過ぎたものの鍵（mediator/returnDue.ts の dueReturnKeys）。
  | { type: 'return.due'; keys: string[] }
  // 同期で、この PC に場所を持ったことが無いプロジェクトが降りてきた（Runtime が project.upsert から見分ける）。ids は降りたプロジェクト。起動の読み込みで入るものは届けない。
  | { type: 'projects.arrived'; ids: string[] }
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
  | { type: 'clipboard.copied'; text: string }
  // 設定の同期の適用（指示書を書き、殻のネイティブの確認を待った）の結果。close が真ならダイアログを閉じる。
  | { type: 'configSync.done'; close: boolean };

/**
 * Mediator が裁定する Intent。
 * API を 1 回呼ぶだけの Intent は Runtime が表で引いて実行する（runtime/intentTable.ts）ので、ここには入らない。
 * 表にある kind を領域の switch に書くと、型が合わなくなる（二重に扱わない）。
 */
export type MediatedIntent = Exclude<Intent, TableIntent>;

export type Input =
  | { kind: 'intent'; intent: MediatedIntent }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent }
  // Store が変わった。中身は運ばない。Mediator は渡された Store を読み、そこから決まる状態（入力待ちの知らせ、サイドバーの「動いている」の並び）を合わせる。
  // Store を変えるのは Runtime なので、変わったことだけは Runtime が知らせる。
  | { kind: 'store' };

export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'history.go'; delta: number }
  | { kind: 'api.bootstrap' }
  // fromSeq の 0 は「開いた（最新側）」、-1 は「過去へ遡る」、-2 は「追記の取り込み（後ろを読み足す）」。
  // aroundSeq は検索の結果から開いたときの跳び先で、開いたときに最新の側ではなくその周りを読む。
  | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number; aroundSeq?: number }
  // append が真なら、届いた行を持っている結果の後ろに足す（「さらに読み込む」）。偽か無ければ置き換える。
  | { kind: 'api.search'; params: SearchQuery; append?: boolean }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto>; field?: string }
  | { kind: 'api.readiness' }
  | { kind: 'shell.openLog' } | { kind: 'shell.restart' } | { kind: 'clipboard.copy'; text: string }
  | { kind: 'api.rebuildIndex' }
  | { kind: 'api.launch'; params: LaunchParams } | { kind: 'api.resume'; sessionId: string } | { kind: 'api.fork'; sessionId: string }
  | { kind: 'api.attach'; sessionId: string } | { kind: 'api.adopt'; sessionId: string }
  | { kind: 'api.killRun'; runId: string } | { kind: 'api.openTab'; sessionId: string } | { kind: 'api.closeTab'; tabId: string }
  | { kind: 'api.jumpToPrompt'; sessionId: string; runId: string; seq: number; heads: string[]; index: number; from: 'top' | 'bottom' }
  | { kind: 'api.leaveTranscript'; runId: string }
  | { kind: 'terminal.connect'; sessionId: string; tabId: string | null } | { kind: 'terminal.disconnect'; tabId: string }
  | { kind: 'terminal.disconnectSession'; sessionId: string }
  | { kind: 'ws.connect' } | { kind: 'ws.reconnectAfter'; ms: number }
  | { kind: 'focus'; target: FocusTarget }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  // 入力待ちになったセッションを通知で知らせる。
  // 受け取る設定か、窓が背面かはランタイムが見る。
  | { kind: 'notify.waiting'; sessionId: string }
  // 戻る時刻を過ぎた Paused を通知で知らせる。出すかどうかは notify.waiting と同じくランタイムが見る。
  | { kind: 'notify.return'; sessionId: string }
  // 通知の許可を求める。
  // 利用者の操作の中で出すので、ブラウザの許可ダイアログも出せる。
  | { kind: 'notify.request' }
  // 通知を受け取らないにする。Runtime がその場で切り替えて覚える。
  | { kind: 'notify.off' }
  // Dock（ブラウザならアプリ）のバッジに入力待ちの数を出す。
  // 0 で消す。
  | { kind: 'badge'; count: number }
  | { kind: 'storage.save'; key: string; value: unknown }
  | { kind: 'api.addTodo'; projectId: string; text: string }
  // セッションの状態。本文には渡されたものだけを載せる。
  | { kind: 'api.setSessionState'; id: string; body: { status: SessionStatus | null; note?: string; returnOn?: string; returnTime?: string } }
  | { kind: 'api.confirmSessionState'; id: string; body: { returnOn?: string; returnTime?: string } }
  | { kind: 'api.loadMemo'; projectId: string }
  | { kind: 'api.promote'; sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }
  | { kind: 'api.createProject'; place: ProjectPlace; startSession: boolean }
  | { kind: 'api.createProjectThenLaunch'; place: ProjectPlace; params: LaunchParams }
  | { kind: 'api.workspaceDirs' }
  | { kind: 'desktop.pickFolder' }
  | { kind: 'api.loadSettingsExtras' }
  | { kind: 'api.syncFocus' }
  | { kind: 'api.resumeHere'; sessionId: string; overwrite: boolean }
  | { kind: 'api.configPreview' } | { kind: 'api.configPull' } | { kind: 'api.joinToken' }
  // 設定の同期（作り直した実装）。Load は中身を取る。Apply は指示書を書き（entries が null なら、いまある指示書を使い）、殻のネイティブの確認へ進む。Restore は控えの世代へ戻す。
  | { kind: 'api.configSyncLoad'; parts: ConfigDetailPart[] }
  | { kind: 'api.configSyncApply'; entries: ConfigApplyOrderEntryIn[] | null }
  | { kind: 'api.configSyncRestore'; name: string }
  | { kind: 'api.retentionPreview'; days: number } | { kind: 'api.writeRetention'; days: number }
  // Claude Code のアカウント。
  | { kind: 'api.accounts.switchSession'; sessionId: string; accountId: string }
  | { kind: 'api.accounts.add'; name: string }
  | { kind: 'api.accounts.remove'; accountId: string };

export type Screen = { name: 'booting' } | Route;
/** results はセッションの一覧の画面の結果の一覧である。 */
export type FocusTarget = 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput' | 'results';
/**
 * 押し切る前に一言聞く必要があるもの。
 * 他端末の本文で手元を上書きする場面、外のターミナルの claude を引き取る場面、作業中かシェルタブのあるランを止める場面、
 * 見つからないプロジェクトを一覧から削除する場面である。
 */
export type ConfirmRequest =
  | { kind: 'overwriteTranscript'; sessionId: string; localSize: number; remoteSize: number }
  | { kind: 'adoptSession'; sessionId: string }
  | { kind: 'killRun'; runId: string; working: boolean; aside?: boolean; shellTabs: number }
  // fromDialog は、未解決のプロジェクトのダイアログから来たこと。やめるとそのダイアログへ戻る。
  | { kind: 'unlinkProject'; projectId: string; fromDialog?: true }
  // 別のアカウントで再開する場面と、アカウントを一覧から外す場面。
  | { kind: 'switchAccount'; sessionId: string; accountId: string; working: boolean }
  | { kind: 'removeAccount'; accountId: string };
export type Overlay =
  | { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' }
  | { kind: 'shortcuts' }
  | { kind: 'newSession'; projectId: string | null; scratch: boolean }
  | { kind: 'promote'; sessionId: string }
  | { kind: 'newProject' }
  | { kind: 'promoted'; projectId: string; moved: boolean; reason: string | null }
  | { kind: 'confirm'; confirm: ConfirmRequest }
  | { kind: 'configPreview' }
  // 設定の同期（作り直した実装）。part が顔を決める。working は、適用の返事（指示書を書き、ネイティブの確認を経る）を待っているあいだ。
  | { kind: 'configSync'; part: ConfigSyncPart; working: boolean }
  | { kind: 'retention'; days: number; from: RetentionFrom; reloaded: boolean; writing: boolean; previewError: string | null }
  // Paused の入力（B1）。from は開いた入口（「⋯」か提案の「日を変える」）。
  | { kind: 'pause'; sessionId: string; from: 'menu' | 'candidate' };
/**
 * 新しいセッションのダイアログの書きかけ。プロジェクトごとではなく 1 つだけ持つ。
 * 添付は、置き場（~/.agent-hangar/drops/）のパスで覚える。
 * mediator から views の型を import しないよう、形をここに書く（promptComposerModel.ts の Attachment と同じ形）。
 */
export type NewSessionDraft = { name: string; prompt: string; attachments: { path: string; name: string; size: number | null }[] };
/** 新しいセッションの詳細の前回値。起動したときの値のうち、既定でないものだけを持つ。 */
export type LaunchPrefs = Pick<LaunchParams, 'model' | 'effort' | 'permissionMode' | 'worktree' | 'addDirs'>;
/** createdProjectId は、作ってから起動する送信でプロジェクトができた後の印である。起動だけが失敗しても、押し直しで二重に作らない。 */
export type LaunchState = { kind: 'idle' } | { kind: 'submitting'; createdProjectId?: string } | { kind: 'failed'; message: string; createdProjectId?: string };
/** 目次から左のターミナルを跳ばした結果。pending の間は注記を出さない。 */
export type TurnJumpStatus = 'pending' | 'found' | 'notFound' | 'mode' | 'failed';
/** 検索の結果から開いたときの跳び先（J1）。n は開いた回数で、同じ所をもう一度開いても跳び直す合図にする。 */
export type JumpState = { seq: number; query: string; n: number };
export type SessionViewState = {
  agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null;
  /** 目次で開いているターン（区切りの行の seq）。その場の操作なので保存しない。 */
  openTurn: number | null;
  /**
   * 開いたターンへ左のターミナルを跳ばした結果。
   * これも保存しない。
   * runId は跳ばした Claude の run で、ターンを閉じたときと画面を離れたときに transcript から抜けさせる先である。
   */
  turnJump: { seq: number; status: TurnJumpStatus; runId: string } | null;
  /** 検索の結果から開いたときの跳び先。無ければ null。 */
  jump: JumpState | null;
};
export type Toast = { id: string; level: 'info' | 'error'; message: string };
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
  sessionView: Record<string, SessionViewState>;
  /**
   * 一覧の語と絞り込み、平らな一覧のいまのページ（1 から）。ページは条件を変えるか画面に入り直すと 1 に戻る。
   * ホームと 1 つのプロジェクトの画面が同じものを使う。プロジェクトの画面では、そのプロジェクトに絞る（絞り込みには projectId を入れない。mediator/screen.ts の listProjectId）。
   * 別の画面から入ると、持ち込まずに空から始める。
   */
  search: { text: string; filter: SearchFilter; page: number };
  /** 一覧の 1 ページの件数（PAGE_SIZES のどれか）。どの一覧も同じ件数を使う。端末ごとに localStorage に残し、起動時に読み戻す。 */
  pageSize: number;
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
  /**
   * 同期で他の PC から降りてきたプロジェクトで、まだ札を下げていないもの（降りた順）。
   * 右下に「他の PC のプロジェクト N 件が届きました」の札を 1 枚だけ出す（設計書 2.11.5）。N は、いまも他の PC から届いたままのものを数える。
   * 「プロジェクトで見る」か「あとで決める」で空にする。帯の件数には入らない。
   */
  arrivedProjects: string[];
  /** 戻る時刻を過ぎたと OS の通知で知らせ終えた鍵（id|日 時刻）。同じ時点を 2 度知らせないために覚え、localStorage にも残す。 */
  returnSeen: string[];
  /** focus: terminal で開いたセッション。その画面に着いたら端末にフォーカスし、着いたら忘れる。 */
  focusOnOpen: string | null;
  /**
   * 昇格ダイアログの進み。
   * 起動と同じ形の状態を使う。
   */
  promote: LaunchState;
  /** プロジェクト画面の作成のダイアログの送信。 */
  projectCreate: LaunchState;
  toasts: Toast[]; nextToastId: number;
  /** サイドバーを図とアイコンだけの帯に縮めているか。開閉のたびに保存し、起動時に読み戻す。 */
  sidebarCollapsed: boolean;
  /**
   * サイドバーの「動いている」の行を、利用者が並べた順（セッションの id）。端末ごとに localStorage に残し、起動時に読み戻す。
   * ここに無いセッション（新しく動き始めたもの）は、並べた行の上に入る（presenters/shell.ts）。
   */
  sidebarOrder: string[];
  /**
   * ベルの一覧で既読にした行の鍵（種類、対象、事実の版）。新しいものが後ろ。端末ごとに localStorage に残し、起動時に読み戻す。
   * 一覧の行は事実から Presenter が組み、ここは既読の鍵だけを持つ（mediator/notices.ts）。
   */
  noticesRead: string[];
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
export const ITERM_HINT = 'iTerm2 で開くとき、初回に macOS の自動化の許可ダイアログが出ます';
