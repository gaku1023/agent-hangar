import type { CompatSummaryDto } from './claudeCompat.ts';
import type { LiveFilter } from './liveFilter.ts';
import type { StepKind } from './steps.ts';
import type { TranscriptEvent } from './transcript.ts';
import type { SessionStateDto, SessionStatus } from './sessionState.ts';

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type LiveStatus = 'busy' | 'idle' | 'waiting';
export type SummaryState = 'in_progress' | 'done' | 'blocked' | 'abandoned';
export type SummarySource = 'baseline' | 'in_session' | 'post_hoc';
/**
 * この PC で場所が無いプロジェクトの内訳（設計書 2.11.5）。
 * missing は、この PC に場所を持っていたが消えたもの（ルートの行が未解決）で、前のパスはこの PC のものである。ホームの帯の件数に数える。
 * elsewhere は、この PC に場所を持ったことが無いもの（他の PC から届いただけ）で、前のパスと PC の名前は他の PC のものである。帯の件数には数えない。
 * 前のパスと PC の名前は、分からなければ null である。
 */
export type ProjectUnresolvedDto = { kind: 'missing' | 'elsewhere'; previousPath: string | null; deviceName: string | null };
export type ProjectDto = { id: string; name: string; status: ProjectStatus; isScratch: boolean; path: string | null; resolved: boolean; lastActivityAt: number | null; runningCount: number; openTodoCount: number; memoHead: string | null; updatedAt: number; unresolved?: ProjectUnresolvedDto | null };
export type SessionStatsDto = { turns: number; model: string | null; effort: string | null; filesChanged: number; prUrl: string | null; inputTokens: number; outputTokens: number; contextPercent: number | null; costUsd: number | null };
/** sourceId は書いた要約器の id。source_id を持たない古い行と、要約器を通さない要約では null になる。 */
export type SessionSummaryDto = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[]; source: SummarySource; sourceId: string | null; sourceModel: string | null; basedOnTurns: number; updatedAt: number };
/**
 * Claude のレジストリ（~/.claude/sessions/<pid>.json）の 1 件。
 * background は Claude のバックグラウンドのサービスが持つセッションにだけ付く。jobId は `claude attach` に渡す短い id である。
 * procStart はそのプロセスの起動時刻（UTC の ps の lstart の書式）。pid の使い回しを見分けるのに使う。古い Claude は書かない。
 * entrypoint は claude を起こしたもの。ターミナルの CLI は cli、VS Code の拡張は claude-vscode になる。
 * aside は、本体は入力を受け付けていて、裏の作業だけが動いていることの印（LiveAsideDto）。無ければ付かない。
 * statusAt は動きが最後に変わった時刻（登録の statusUpdatedAt、ミリ秒）。裏だけかを決めるのに使う（server の live/aside.ts）。古い Claude は書かない。
 */
export type LiveSessionDto = { sessionId: string; status: LiveStatus; name: string | null; nameSource: string | null; cwd: string; pid: number; background?: { jobId: string }; procStart?: string; entrypoint?: string; aside?: LiveAsideDto; statusAt?: number };
/**
 * 本体（指揮役）は入力を受け付けていて、裏の作業だけが動いていること。
 * status は busy のままにする。Claude も、裏でサブエージェントが動く間は本体が空いていても busy と書く。
 * busy のままなので、自動の停止、引き取りの断り、停止の確認は、作業中と同じに働く。変えるのは見せ方だけである。
 * shell は、裏で Bash が動いていること（Claude の登録の status が shell）。
 * agents は、裏で動いているサブエージェントの本数。登録は busy としか書かないので、server が本文から推す（live/aside.ts）。数えられないときは 0 である。
 */
export type LiveAsideDto = { shell: boolean; agents: number };
/** 実行中のセッションが最後に呼んだツールと、答えを待っている AskUserQuestion の問い。端末ローカルで、同期しない。 */
export type SessionActivityDto = { tool: string; summary: string; question: string | null };
/**
 * state はセッションの状態と提案で、null は Active である。
 * parked は、区切りを付けたのにプロセスが休みのまま残っていること（shared の isParked）。真なら画面では実行中に数えない。
 * stoppedByStatus は、区切りを付けたので hangar が Claude を止め、その印がまだ残っていること。
 * liveAside は登録の aside を写したもの（LiveSessionDto）で、無ければ null である。
 * activity は実行中のときだけ値を持ち、実行中でなければ null である。
 */
export type SessionDto = { id: string; provider: 'claude-code'; providerSessionId: string; projectId: string | null; name: string | null; cwd: string; firstPrompt: string | null; aiTitle: string | null; startedAt: number | null; lastActivityAt: number | null; memo: string | null; hasTranscript: boolean; live: LiveStatus | null; summary: SessionSummaryDto | null; stats: SessionStatsDto; fromScratch: boolean; lock: SessionLockDto | null; remoteOnly: boolean; transcriptMtime: number | null; activity: SessionActivityDto | null; state: SessionStateDto | null; parked: boolean; stoppedByStatus: boolean; liveAside: LiveAsideDto | null };
export type SettingsDto = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean; /** 他の PC から届いた skills、commands、agents の承諾の仕方。この項目を知らない古いサーバは返さないので、読む側は 'each' に寄せる。 */ configApproval?: ConfigApproval; /** 設定の同期（作り直した実装）のスイッチ。切が既定。この項目を知らない古いサーバは返さないので、読む側は ConfigSyncDto.enabled を見る。 */ configBundleSync?: boolean; nodePath: string | null; claudePath: string | null; /** 画面とサーバの文の言語。この項目を知らない古いサーバは返さないので、読む側は `languageOf` で既定の日本語に寄せる。 */ language?: import('./i18n/language.ts').Language };
/**
 * Claude Code の会話の保持期間。
 * source は値がどこで決まったかで、default はユーザー設定にキーが無い（既定の 30 日）ことを表す。
 * usage は測り終えるまで null である。
 */
export type RetentionSource = 'default' | 'user' | 'managed';
export type RetentionUsageDto = { bytes: number; dailyBytes: number; freeBytes: number; measuredAt: number };
export type RetentionDto = { days: number; source: RetentionSource; userValue: number | null; writable: boolean; unwritableReason: string | null; usage: RetentionUsageDto | null };
export type RetentionPreviewLine = { kind: 'ctx' | 'add' | 'del'; text: string };
/** 書いたらどうなるか。何も書かずに返す。baseSha256 は読んだ時点のファイルの指紋で、無ければ空文字。 */
export type RetentionPreviewDto = { days: number; path: string; lines: RetentionPreviewLine[]; baseSha256: string; backupDir: string; projectedBytes: number | null };
/** 確認をどこから開いたか。帯から開いたときだけ「ほかの期間…」を出す。 */
export type RetentionFrom = 'banner' | 'session' | 'settings';
export type IndexProgressDto = { phase: 'idle' | 'scanning' | 'indexing' | 'rebuilding'; done: number; total: number };
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; runs: RunDto[]; tabs: TabDto[]; todos: TodoDto[]; artifacts: ArtifactDto[]; summaryPending: string[]; index: IndexProgressDto; version: string; sync: SyncStatusBody; devices: DeviceDto[]; retention: RetentionDto | null; cloudUsage: CloudUsageDto | null; accounts: AccountsDto; /** 設定の同期（新しい実装）の状態。この項目を知らない古いサーバは返さない。 */ configSync?: ConfigSyncDto };
export type EventsPageDto = { sessionId: string; events: TranscriptEvent[]; total: number; nextSeq: number | null };
/**
 * 実行中のセッションの右ペインに出すライブの要約。サーバが主線とサブエージェントを読んで作る。
 * 指揮役の手と目次の色帯は UI が主線のイベントから作るので、ここには載せない。
 * endNote は終わりの知らせの status が completed でなかったときのその値（failed、killed など）で、ほかは null。赤にはせず、状態は done のままである。
 * linked はサブエージェントの transcript と結べたか。結べないレーンの agentId は `tool:<toolId>` である。
 */
export type LiveAgentDto = { agentId: string; title: string; state: 'running' | 'done' | 'error'; startedAt: number | null; lastAt: number | null; last: { text: string; mono: boolean; kind: StepKind; isError: boolean } | null; report: string | null; endNote: string | null; linked: boolean };
export type LiveIntentDto = { text: string; at: number; stepsSince: number; inThisTurn: boolean };
export type LiveDigestDto = { sessionId: string; turnStartSeq: number | null; intent: LiveIntentDto | null; agents: LiveAgentDto[] };
/**
 * status はセッションの状態で絞る（session_states を見る）。hideArchived は「すべて」のタブで条件を入れたときに Archived を除く印である。
 * どちらも Home の一覧だけが送り、MCP の search_sessions は送らない。
 */
export type SearchParamsDto = { q: string; projectId?: string; since?: number; until?: number; live?: LiveFilter; file?: string; limit?: number; offset?: number; status?: SessionStatus | 'active' | 'proposed'; hideArchived?: boolean };
/**
 * 検索の 1 件。
 * 抜粋の seq は主線とサブエージェントで別々に振るので、agentId でどの線の行かを表す（主線は null）。
 * 抜粋は主線を先に、seq の順に並ぶ。
 * matched は、どこに当たったか（名前、要約、トランスクリプト）で、name、summary、transcript の順に並ぶ。
 * 名前と要約だけで当たった行は matchCount 0、snippets 空である。
 * 語の無いファイルだけの検索の行には付かない。古いサーバも送らないので、受け取る側は無いものとして読む。
 */
export type SearchHitDto = { sessionId: string; matchCount: number; snippets: { seq: number; role: string; text: string; agentId: string | null }[]; matched?: ('name' | 'summary' | 'transcript')[] };
export type SearchResultDto = { hits: SearchHitDto[]; total: number };
export type ResolveAction = { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' };
export type RunKind = 'start' | 'resume' | 'fork';
/** parked は、区切り（Paused・Done・Archived）を付けたセッションが休みになったので hangar が止めたもの。 */
export type EndReason = 'exited' | 'killed' | 'lost' | 'parked';
export type TerminalApp = 'terminal' | 'iterm';
/** 1 回の起動または再開。tmux 上の寿命と一致する。 */
export type RunDto = {
  id: string; sessionId: string; deviceId: string; kind: RunKind; tmuxName: string; pid: number | null; startedAt: number; endedAt: number | null; endReason: EndReason | null; heartbeatAt: number;
  /**
   * 起動のときに選んだ権限モード（`LaunchParams.permissionMode` の値）。サーバが `runs.launch_params` から読んで組む。
   * 選ばなかった起動と、hangar の外で起動したセッション（ターミナルの包み方からの起動）は値が無く、鍵ごと送らない。
   * 起動のあとに Claude の中で切り替えた値は分からない。
   */
  permissionMode?: string | null;
};
/**
 * `GET /api/sessions/:id/files`。そのセッションが編集系のツール（Edit、Write、MultiEdit、NotebookEdit）で変えたファイルの一覧。
 * `event_index` の呼び出しをパスでまとめたもので、読み込んだトランスクリプトの窓には依らない。索引した順に並ぶ。
 * edits はそのパスへの呼び出しの回数。agentId は、メイン会話が一度も触れておらずサブエージェントだけが触ったときの、最初のサブエージェントの id で、それ以外は null。
 * 足した行と消した行の数は `event_index` に無いので持たない。
 */
export type SessionFilesDto = { files: { path: string; edits: number; agentId: string | null }[] };
/** セッション画面のタブ。agent タブの id は run の id と同じ。 */
export type TabDto = { id: string; runId: string; sessionId: string; kind: 'agent' | 'shell'; title: string; tmuxName: string; createdAt: number; closedAt: number | null };
export type LaunchResultDto = { run: RunDto; sessionId: string; tabs: TabDto[] };

/** statusline の payload から得た使用率。窓の値が無いときは null で、updatedAt は使用率が届いた時刻。 */
export type RateWindowDto = { usedPercent: number; resetsAt: number | null };
export type UsageDto = { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null; updatedAt: number | null };
/** `claude auth status --json` から読んだもの。hangar が認証について知るのはこれだけで、トークンは含まない。 */
export type AccountAuthDto = { loggedIn: boolean; email: string | null; plan: string | null; orgName: string | null; checkedAt: number };
/**
 * Claude Code のアカウント。置き場（CLAUDE_CONFIG_DIR）と 1 対 1 で、この PC の中だけにある。
 * primary は最初のアカウント（既定の置き場）で、消せない。
 * linkProblem は置き場のリンクが壊れている理由で、起動できるときは null。
 */
export type AccountDto = { id: string; name: string; dir: string; color: string; primary: boolean; auth: AccountAuthDto | null; usage: UsageDto; loginRunning: boolean; linkProblem: string | null };
/** sessions は、最初のアカウント以外で最後に動かしたセッションだけを載せる（セッションの id → アカウントの id）。載っていないものは最初のアカウントである。 */
export type AccountsDto = { currentId: string; accounts: AccountDto[]; sessions: Record<string, string> };
/** 最初のアカウント（既定の置き場）の id。 */
export const PRIMARY_ACCOUNT_ID = 'primary';
export type UsageDayDto = { day: string; inputTokens: number; outputTokens: number; sessions: number };
export type UsageProjectDto = { projectId: string | null; name: string; inputTokens: number; outputTokens: number; costUsd: number | null; sessions: number };
export type UsageAggregateDto = { days: UsageDayDto[]; projects: UsageProjectDto[] };
export type StatuslineStatusDto = { command: string | null; scriptPath: string | null; installed: boolean };
/**
 * ツールのパスを確かめた結果。
 * problem は動かせない理由で、動かせるときは null。
 * unset は設定が空、missing は無い、notFile はディレクトリなどファイルでない、notExecutable は実行権が無い。
 * version は `--version` などで読んだ版で、読めなかったときは null。
 */
export type ToolProblem = 'unset' | 'missing' | 'notFile' | 'notExecutable';
export type ToolCheckDto = { path: string | null; ok: boolean; problem: ToolProblem | null; version: string | null };
/**
 * 準備の確かめ（GET /api/readiness）。
 * 設定画面の欄の下の検証と、ホームの帯の始める前の確認が、同じこの 1 つを読む。
 * node の auto は、設定が空で、サーバを動かしている Node をそのまま見せていることを表す。
 * workspace の projectCount は、ワークスペースの直下から登録したプロジェクトの数である。
 * mcp は Claude Code の user スコープ（~/.claude.json）に hangar の MCP サーバが載っているか。読むだけで書かない。
 * commands は画面に出すコマンドで、どれも同じ hangar の呼び方にそろえてある。
 * compat は Claude Code との互換の要約で、設定の互換の節と、始める前の確認の互換の行が読む。ずれの中身は GET /api/compat で取る。
 */
export type ReadinessDto = {
  tools: { tmux: ToolCheckDto; claude: ToolCheckDto; code: ToolCheckDto; node: ToolCheckDto & { auto: boolean } };
  workspace: { path: string; exists: boolean; projectCount: number };
  mcp: { registered: boolean; file: string };
  statusline: StatuslineStatusDto;
  commands: { mcp: string; statusline: string; shell: string };
  compat: CompatSummaryDto;
};
/** 完了の候補。sessionId はセッション別でない MCP の URL から出たとき null、note は根拠が無いとき null。 */
export type TodoCandidateDto = { sessionId: string | null; note: string | null; at: number };
/** candidate は完了の候補で、候補でなければ null。完了の行では必ず null である（サーバが読むときにそろえる）。 */
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number; candidate: TodoCandidateDto | null };
export type MemoDto = { projectId: string; markdown: string; updatedAt: number };
export type ArtifactDto = { id: string; projectId: string | null; url: string; title: string | null; description: string | null; favicon: string | null; filePath: string | null; fileExists: boolean; firstPublishedAt: number; lastPublishedAt: number; versionCount: number; sessionIds: string[] };
export type PromoteResultDto = { project: ProjectDto; session: SessionDto; moved: boolean; reason: string | null };
/** プロジェクトを作る場所。newDir はワークスペースの下に新しく作り、dir は既存のディレクトリを登録する。 */
export type ProjectPlace = { kind: 'newDir'; name: string; gitInit: boolean } | { kind: 'dir'; path: string; name?: string };
/** ワークスペース直下の、まだプロジェクトになっていないディレクトリ。 */
export type WorkspaceDirDto = { name: string; path: string };
export type SummarizerId = 'lmstudio' | 'claude-headless';
export type SummarizerTestDto = { ok: true; id: SummarizerId; ms: number; summary: Omit<SessionSummaryDto, 'updatedAt'> } | { ok: false; tried: { id: SummarizerId; message: string }[] };

/** ここから下はクラウド同期（フェーズ 4）の DTO である。 */
/** 他端末がそのセッションを実行中であることの印。stale は heartbeat が途切れていることを示す。 */
export type SessionLockDto = { deviceId: string; deviceName: string; runId: string; heartbeatAt: number; stale: boolean };
export type SyncStateKind = 'off' | 'idle' | 'pushing' | 'pulling' | 'paused' | 'error';
/**
 * limitedUntil は、Cloudflare の無料枠の上限に当たって退いている間の戻る時刻である。
 * ふつうは次の UTC の 0 時で、UTC の 0 時から 10 分の間に断られたときは断られた 5 分後である。
 * 退いている間の state は paused で、利用者が一時停止しているときと、退いていないときは null である。
 * paused は利用者が同期を一時停止しているか（sync_state の paused の印）である。
 * 版で止まって state が error のときも、一時停止していれば true になる。
 */
export type SyncStatusDto = { state: SyncStateKind; paused: boolean; url: string | null; lastPushAt: number | null; lastPullAt: number | null; pending: number; error: string | null; deviceCount: number; limitedUntil: number | null };
/**
 * 降ろすのを諦めた本文。key は雲の中の鍵、attempts は試した回数、message は最後の理由。
 * 載るのは降ろす側（RemotePuller）の諦めだけである。
 * 上げる側の諦めは TranscriptUploader が sync_state に残していて、ここには出てこない。
 */
export type SyncSkippedDto = { key: string; attempts: number; message: string };
/**
 * 同期の状態に添える付録。
 * SyncStatusDto を組み立てる SyncEngine は、どちらの値も持っていない。
 * 諦めた本文を覚えているのは RemotePuller で、取り残しを数えられるのは TranscriptUploader だけである。
 * そこで、配るところで添える。HTTP の応答（bootstrap と /sync/status と /sync/now と /sync/pause）も、
 * websocket の sync.status も、同じ付録を運ぶ。片方だけにすると、画面の件数が古いまま貼り付く。
 * sweepPending は、これから上がる本文の件数である。
 * 消したセッションの本文と、上げるのを諦めた本文は入らない（諦めた本文は skipped として別に出るので、入れると二重に数える）。
 * 数えられないときは null になる（同期を設定していない端末）。
 * oncePass は、一時停止のまま利用者が「今すぐ同期」で頼んだ 1 巡の最中かどうかである。
 * そのあいだも state は paused のままなので、進んでいることはこの印でしか分からない。
 */
export type SyncDetailDto = { skipped: SyncSkippedDto[]; sweepPending: number | null; oncePass: boolean };
/** 同期の状態の応答。SyncStatusDto に付録を足したものである。 */
export type SyncStatusBody = SyncStatusDto & SyncDetailDto;
/** shell はその端末の包み方（hangar shell install）の状態。まだ知らせてこない古い版の端末は null になる。 */
export type DeviceDto = { id: string; name: string; platform: string; lastSeenAt: number | null; self: boolean; shell: ShellHookStateDto | null };
export type ShellHookStateDto = 'on' | 'off' | 'unsupported';
/** Settings の「外のターミナル」。state はこの PC の状態、command は入れるために貼るコマンド。 */
export type ShellHookDto = { state: ShellHookStateDto; zshrc: string; line: string; command: string };
/**
 * Claude Code の設定の同期（docs/superpowers/specs/2026-10-09-config-sync-rebuild-design.md）の形。
 */
/** 運ぶ項目の種類。settings は settings.json の鍵 1 つが 1 項目で、memory はプロジェクトのメモリと ~/.claude/memory の下のファイル。 */
export type ConfigItemKind = 'claude-md' | 'settings' | 'keybindings' | 'skills' | 'commands' | 'agents' | 'memory';
/** 実行の印。hooks はフロントマターの hooks、shell は本文のコマンド実行（`!`）、script は skills の下の本文でないファイル。 */
export type ConfigExecMark = 'hooks' | 'shell' | 'script';
/** 他の PC から届いた skills、commands、agents の承諾の仕方。each は項目ごとに毎回、auto は自動。 */
export type ConfigApproval = 'each' | 'auto';
/** settings.json の鍵を運ばない理由。 */
export type ConfigDropReason = 'execution' | 'path' | 'auth' | 'machine' | 'unknown';
export type ConfigOutgoingItemDto = { id: string; kind: ConfigItemKind; label: string; size: number; marks: ConfigExecMark[]; /** settings の鍵の値（JSON、長いときは切る）。ほかの種類は null。 */ value: string | null };
export type ConfigOutgoingDto = {
  /** 新しい実装を入れているか。切のままでも一覧は読める（入れる前に何が出るかを見せるため）。 */
  enabled: boolean;
  items: ConfigOutgoingItemDto[];
  droppedKeys: { key: string; reason: ConfigDropReason }[];
  /** 送らなかった項目の数（GET /api/config-sync/unsent の長さ）。 */
  unsentCount: number;
  lastSentAt: number | null;
};
/** 届いた変更の操作。conflict は手元と相手の両方が変えた（または片方が消した）もの。 */
export type ConfigInboxOp = 'create' | 'overwrite' | 'delete' | 'conflict';
/** 適用できない理由。no-project は、そのプロジェクトがこの PC に無いメモリ。local-blocked は、手元に同名のものがあるが運べない（リンク、大きすぎる、読めない、件数の上限）ので、黙って上書きしない。 */
export type ConfigHeldReason = 'no-project' | 'local-blocked';
export type ConfigInboxItemDto = {
  id: string; kind: ConfigItemKind; label: string; op: ConfigInboxOp;
  fromDeviceId: string; fromDevice: string; size: number; marks: ConfigExecMark[];
  /** 中身の先頭（本文でないものは空）。 */
  head: string;
  held: ConfigHeldReason | null;
  /** 項目ごとの承諾が要るか（skills、commands、agents で、承諾の仕方が each のとき）。 */
  needsApproval: boolean;
};
export type ConfigInboxDto = { items: ConfigInboxItemDto[]; approval: ConfigApproval };
export type ConfigConflictSideDto = { deviceName: string; at: number | null; size: number };
export type ConfigConflictDto = { id: string; kind: ConfigItemKind; label: string; marks: ConfigExecMark[]; local: ConfigConflictSideDto | null; remote: ConfigConflictSideDto | null; /** 手元から相手への差分。 */ diff: RetentionPreviewLine[] };
export type ConfigUnsentKind = 'permission-rule' | 'secret';
export type ConfigUnsentItemDto = { id: string; kind: ConfigUnsentKind; itemId: string; label: string; reason: string; allowed: boolean };
export type ConfigUnsentDto = { items: ConfigUnsentItemDto[] };
export type ConfigBackupGenerationDto = { name: string; at: number | null; files: number };
export type ConfigBackupsDto = { generations: ConfigBackupGenerationDto[] };
/** 承諾の選択 1 件。take が remote なら相手の中身を採り、mine なら手元を採る（手元は書き換えず、基準だけを進める）。 */
export type ConfigApplyOrderEntryIn = { id: string; take?: 'remote' | 'mine' };
export type ConfigApplyOrderItemDto = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; take: 'remote' | 'mine'; fromDeviceId: string; sha256: string; /** 書き込み先。ファイルは設定の入れ物からの相対パス、settings は `settings.json#<鍵>`。 */ target: string };
/** 適用の指示書。サーバは ~/.claude に書かず、殻の命令と hangar config apply が読む。 */
export type ConfigApplyOrderDto = { createdAt: number; items: ConfigApplyOrderItemDto[] };
export type ConfigSyncDto = {
  enabled: boolean;
  /** スイッチは入っているが、Worker がまだ束の行を知る版に届いていないので、送っていない（Worker の更新待ち）。Worker の版がまだ分からないあいだは偽。 */
  workerPending: boolean;
  approval: ConfigApproval;
  /** 適用できる変更の数（競合と保留を除く）。 */
  incoming: number;
  conflicts: number;
  held: number;
  unsent: number;
  backups: number;
  applyOrder: { count: number; createdAt: number } | null;
  lastSentAt: number | null;
};
export type ResumeHereConflictDto = { error: 'local_smaller'; localSize: number; remoteSize: number };

/**
 * 設定の「使用量と費用」に出す形。端末のサーバが Worker の /usage から作る。
 * source が unknown のときは、Cloudflare の数を取れていない（トークンが無い、一時停止や上限で問い合わせていない、取れないまま失敗した）。
 * そのとき今日の数は null で、plan と month も null である。hangar は量を数えない（段 1、D4）。
 * stale は最後の取得が失敗していること（値は最後に取れたもの）。notice はトークンの失効など、画面に添える 1 行。
 */
export type CloudUsageDto = {
  source: 'cloudflare' | 'unknown';
  fetchedAt: number | null;
  stale: boolean;
  notice: string | null;
  limits: { d1RowsPerDay: number; workersRequestsPerDay: number };
  today: { d1RowsWritten: number | null; workersRequests: number | null; resetAt: number };
  plan: { label: string; workersPaid: boolean } | null;
  month: { periodStart: string; periodEnd: string | null; throughDay: string | null; billedUsd: number; rows: { label: string; consumed: number; unit: string; included: number | null }[] } | null;
};

/** 初期プロンプト欄の `/` の候補の出どころ。 */
export type PromptCommandSource = 'project' | 'user' | 'plugin' | 'builtin';
/** 初期プロンプト欄の `/` の候補。uses は、セッションの最初の一言になった回数。 */
export type PromptCommandDto = { name: string; description: string; argumentHint: string | null; source: PromptCommandSource; uses: number };
/** `~/.agent-hangar/drops/` に置いたファイル。 */
export type DropDto = { path: string; name: string; size: number };
