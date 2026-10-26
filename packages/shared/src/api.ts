import type { AgentKind } from './agents.ts';
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
/**
 * sameFolder は、この PC で同じフォルダを場所にしている別のプロジェクト（残す方）。このプロジェクトはそちらへまとめる方である。
 * 直す前の版の「場所を再指定」が重複を見なかった残りで、ホームの帯とプロジェクトの画面から、まとめる確認を開く。無ければ null で、古いサーバは付けない。
 */
export type ProjectSameFolderRef = { projectId: string; name: string };
export type ProjectDto = { id: string; name: string; status: ProjectStatus; isScratch: boolean; path: string | null; resolved: boolean; lastActivityAt: number | null; runningCount: number; openTodoCount: number; memoHead: string | null; updatedAt: number; unresolved?: ProjectUnresolvedDto | null; sameFolder?: ProjectSameFolderRef | null };
export type SessionStatsDto = { turns: number; model: string | null; effort: string | null; filesChanged: number; prUrl: string | null; inputTokens: number; outputTokens: number; contextPercent: number | null; costUsd: number | null;
  /** 文脈の量（トークン、最後の値。session_live_stats.context_used）。右欄の opencode の使用量の札が使う。項目を知らない古いサーバは送らない。 */
  contextTokens?: number | null };
/** sourceId は書いた要約器の id。source_id を持たない古い行と、要約器を通さない要約では null になる。 */
export type SessionSummaryDto = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[]; source: SummarySource; sourceId: string | null; sourceModel: string | null; basedOnTurns: number; updatedAt: number };
/**
 * Claude のレジストリ（~/.claude/sessions/<pid>.json）の 1 件。
 * background は Claude のバックグラウンドのサービスが持つセッションにだけ付く。jobId は `claude attach` に渡す短い id である。
 * procStart はそのプロセスの起動時刻（UTC の ps の lstart の書式）。pid の使い回しを見分けるのに使う。古い Claude は書かない。
 * entrypoint は claude を起こしたもの。ターミナルの CLI は cli、VS Code の拡張は claude-vscode になる。
 * aside は、本体は入力を受け付けていて、裏の作業だけが動いていることの印（LiveAsideDto）。無ければ付かない。
 * statusAt は動きが最後に変わった時刻（登録の statusUpdatedAt、ミリ秒）。裏だけかを決めるのに使う（server の live/aside.ts）。古い Claude は書かない。
 * address は SendMessage の宛先（ListAgents の名前）。名前が重なるときだけ `名前 [ref]` にする。名前の無い登録には付かない。
 * agent は Claude Code 以外のエージェントの行にだけ付く（opencode は serve の出来事の流れから組む。server の provider/opencode/live.ts）。Claude の行には付けないので、無ければ Claude Code である。
 * opencode の行の pid は serve の pid である。
 */
export type LiveSessionDto = { sessionId: string; status: LiveStatus; name: string | null; nameSource: string | null; cwd: string; pid: number; address?: string; background?: { jobId: string }; procStart?: string; entrypoint?: string; aside?: LiveAsideDto; statusAt?: number; waitingFor?: WaitKind; permission?: PermissionAskDto; agent?: Exclude<AgentKind, 'claude-code'> };
/**
 * 入力待ちが何を待っているか（登録の waitingFor を shared の waitKindOf で読み替えたもの）。
 * permission はツールの許可（Bash の確認など）、question は入力（MCP の入力など）、other はダイアログや知らない値である。
 * 入力待ちの間だけ付く。古い Claude は書かないので、無いこともある。
 */
export type WaitKind = 'permission' | 'question' | 'other';
/**
 * Claude が求めている許可の中身。hangar が起こした claude の PermissionRequest の hook から届く（server の hooks/permission.ts）。
 * tool は道具の名前、input は命令やファイルなどの短い形（Bash は命令の全文）、description は Claude が書いた説明（Bash の description）である。
 * hook を持たない run（外のターミナル）では届かない。
 */
export type PermissionAskDto = { tool: string; input: string; description: string | null };
/**
 * 使用制限で止まっていること（本文の合成の assistant 行、error が rate_limit）。
 * kind は枠（5 時間、週、そのほか）、resetsAt はリセットの時刻（ミリ秒）。
 * auto は、Claude Code が自動の続きを予約したと本文に書いたこと。
 * reset は、リセットの時刻から猶予（LIMIT_RESET_GRACE_MS、auto なら LIMIT_RESET_AUTO_GRACE_MS）を過ぎても続きが始まっていないこと。真なら要対応に数える。
 */
export type LimitKind = 'five_hour' | 'weekly' | 'other';
export type SessionLimitDto = { kind: LimitKind; resetsAt: number; auto: boolean; reset: boolean };
/**
 * サーバが組むデスクトップ通知 1 件（`GET /api/notify/feed`、server の sessions/stopNotices.ts）。
 * 殻（デスクトップ）が読み、窓が背面にあるときだけ OS に渡す。頁の JS が背面で止まっていても通知が出るように、きっかけをサーバに置く。
 * kind は通知の枠で、waiting は入力待ち（許可待ちとリセット済みも含む）、limit は使用制限（アカウントごとに 1 通）である。
 * sessionId は押したときに開くセッション（hangar の id）。bare は、問いの文がまだ無い入力待ちで、殻が問いの文を少し待つ印である。
 */
/**
 * join は参加リクエストの受信で、sessionId はいつも JOIN_NOTICE_ID である（押すと設定のクラウド同期を開く）。
 */
export type OsNoticeKind = 'waiting' | 'limit' | 'join';
/** 参加リクエストの OS の通知が sessionId に載せる値。セッションの ID（UUID）とは重ならない。 */
export const JOIN_NOTICE_ID = 'join-request';
/** 参加リクエストの中身のうち、発行した PC の画面に出すもの。sas は区切りの無い 6 桁である。 */
export type JoinRequestView = { name: string; os: string; sas: string };
/**
 * 参加コードを発行した PC の承認の状態（GET /api/sync/join-codes/current）。
 * code は表示の形（`XXXX-XXXX`）で、平文はこの PC のメモリにしか無い。
 * 承認の後は done、拒否と取り消しの後は idle に戻る。
 */
export type JoinApproverState =
  | { kind: 'idle' }
  | { kind: 'open'; code: string; expiresAt: number }
  | { kind: 'requested'; code: string; expiresAt: number; request: JoinRequestView }
  | { kind: 'approving' }
  | { kind: 'done'; name: string }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };
/**
 * 設定の「リカバリーキーを再発行」（POST /api/sync/recovery-key/reissue）の答え。
 * text は 4 行のリカバリーキーで、draftId を末尾 4 文字と一緒に /confirm へ送ると差し替わる。
 * 新しい鍵ペアはサーバーのメモリにだけあり、確認するまで名簿も keybox も変えない。
 */
export type RecoveryKeyDraftDto = { text: string; draftId: string };
export type OsNoticeDto = { seq: number; kind: OsNoticeKind; sessionId: string; title: string; body: string; bare: boolean };
/** boot はサーバの起動ごとに変わる値。殻はこれが変わったら、seq を今の値に合わせ直し、前の分は出さない。 */
export type OsNoticeFeedDto = { boot: string; seq: number; items: OsNoticeDto[] };
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
 * waitingFor と permission は登録の同じ欄を写したもので、入力待ちの間だけ付く（LiveSessionDto）。
 * limit は使用制限で止まっていることで、実行中のときだけ値を持つ（SessionLimitDto）。
 * lastTurnAt は最後の入力・返答の時刻（手元の統計）で、終わった会話の見出しの「終了」に使う。統計の無い会話は null。
 * provider は会話を動かすエージェントで、一覧とサイドバーのアイコンを決める（agentIcons.ts）。古いサーバは opencode を知らないので、読む側は agentIconKindOf で読む。
 */
export type SessionDto = { id: string; provider: AgentKind; providerSessionId: string; projectId: string | null; name: string | null; cwd: string; firstPrompt: string | null; aiTitle: string | null; startedAt: number | null; lastActivityAt: number | null; lastTurnAt: number | null; hasTranscript: boolean; live: LiveStatus | null; summary: SessionSummaryDto | null; stats: SessionStatsDto; fromScratch: boolean; lock: SessionLockDto | null; remoteOnly: boolean; transcriptMtime: number | null; activity: SessionActivityDto | null; state: SessionStateDto | null; parked: boolean; stoppedByStatus: boolean; liveAside: LiveAsideDto | null; waitingFor: WaitKind | null; permission: PermissionAskDto | null; limit: SessionLimitDto | null;
  /** 中断（SessionInterruptDto）。ステータスの無いセッションで、最後の run が lost で終わったときだけ値を持つ。 */
  interrupted: SessionInterruptDto | null;
  /** 同じファイルを別のセッションと編集していること（SessionOverlapDto）。実行中のときだけ値を持つ。 */
  overlap: SessionOverlapDto | null;
  /**
   * ほかの PC に、この PC のトランスクリプトより新しい続きがあること（A → B → A と戻ったとき）。
   * 最後の run がほかの PC のもので、手元に降ろしたその写しが手元のトランスクリプトより大きいときだけ真。
   * 真のとき、画面は手元にトランスクリプトがあっても「この PC で再開」を主にする。
   */
  newerElsewhere: boolean;
  /**
   * ほかの PC に引き継がれたこの PC の会話。この PC の最後の run が taken_over で終わっているときだけ値を持ち、ほかは null である。
   * deviceName は引き継いだ PC の名前、at はこの PC の run が終わった時刻。この PC で後から run を起こせば null に戻る。
   */
  takenOver: { deviceName: string; at: number } | null;
  /**
   * この PC がスマホの依頼で起こした会話（試作 F1）。bypass は Bypass permissions で起こしたこと。PC で起こした会話は null。
   * 印は起こした PC の手元の表（mobile_launches）にだけあり、共有の sessions には載せないので、他の PC では null である。
   */
  fromPhone: { bypass: boolean } | null };
/**
 * スマホからの依頼でこの PC が会話を起こした知らせ（ServerEvent の phone.launch、右下の通知、試作 F1）。
 * phone は名簿のスマホの名前で、分からなければ null。projectId は依頼のプロジェクトで、すぐ始める（scratch）では null。
 * permissionMode は依頼の権限モード（空は既定）、title は起こしたときの会話の名前、at はこの PC の時計で起こした時刻。
 */
export type PhoneLaunchDto = { sessionId: string; phone: string | null; projectId: string | null; scratch: boolean; permissionMode: string; title: string; at: number };
/**
 * 中断の原因。
 * restart は、サーバの起動の見回りで tmux（Windows は psmux）のセッションが無かった run（PC の再起動など）である。
 * mux は、hangar が動いている間に tmux のサーバごと消えて、生きた run がまとめて終わったものである。
 */
export type InterruptCause = 'restart' | 'mux';
/** セッションの中断。at は run が閉じた時刻、cause はこの PC で中断を記録していれば原因で、分からなければ null（他の PC の run など）。 */
export type SessionInterruptDto = { at: number; cause: InterruptCause | null };
/**
 * 中断の群の 1 件。lastLive は止まる前の最後の状態で、分からなければ null。endedAt は run が閉じた時刻、account は run を起こしたアカウント（記録が無ければ null）。
 */
export type InterruptedItemDto = { sessionId: string; runId: string; lastLive: LiveStatus | null; endedAt: number; account: string | null };
/**
 * ホームの帯の「前回実行中」の群。この PC で最後に記録した中断の束で、再開しないと決めた行（dismissed）と、その後に起こし直した行は含まない。
 * 群が無ければ null である。
 */
export type InterruptedDto = { at: number; cause: InterruptCause; items: InterruptedItemDto[] };
/**
 * 同じファイルを別のセッションが編集していること（止めない警告）。
 * files の 1 件は、相手（with）と重なったパス、このセッションと相手が最後にそのパスを編集した時刻である。
 * alternating は、交互に書いたこと（このセッション、相手、このセッションの順など）。偽なら、後から書いた側の編集の時点で先の側が作業中だった。
 */
export type OverlapFileDto = { path: string; with: string; mineAt: number; theirsAt: number; alternating: boolean };
export type SessionOverlapDto = { with: string[]; files: OverlapFileDto[] };
export type SettingsDto = { workspaceRoot: string; /** 利用者がフォルダの信頼に同意した作業フォルダ（hangar workspace set --trust）。いまの workspaceRoot と同じときだけ効く。作業フォルダを変えると空に戻る。この項目を知らない古いサーバは返さない。 */ trustedWorkspaceRoot?: string | null; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; /** エディタの選択（editor.ts）。0.4.0 までの codePath は、サーバが読むときに editor へ読み替える。 */ editor: import('./editor.ts').EditorSetting; /** 事後の要約を作るもの（0.6.0）。この項目を知らない古いサーバは返さないので、読む側は 'off' に寄せる。 */ summaryEngine?: import('./summaryEngine.ts').SummaryEngine; /** 要約に claude -p を使うときのモデル。既定は haiku。 */ summaryClaudeModel?: string; /** OpenAI 互換の要約器の URL（鍵の名前は LM Studio だけだった頃のまま）。 */ lmStudioUrl: string; lmStudioModel: string | null; /** OpenAI 互換の要約器の API キーを保存しているか。キーそのものはサーバから返さない。 */ summaryApiKeySet?: boolean; /** 書くときだけ使う API キー（PATCH）。空文字と null は消す。サーバはこの項目を返さない。 */ summaryApiKey?: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean; /** 他の PC から届いた skills、commands、agents の承諾の仕方。この項目を知らない古いサーバは返さないので、読む側は 'each' に寄せる。 */ configApproval?: ConfigApproval; /** 設定の同期（作り直した実装）のスイッチ。切が既定。この項目を知らない古いサーバは返さないので、読む側は ConfigSyncDto.enabled を見る。 */ configBundleSync?: boolean; /** hangar が起動する claude に、区切りで Done か Paused を聞く段を足すか（既定は入り）。この項目を知らない古いサーバは返さないので、読む側は入りとして読む。 */ askStatusAtEnd?: boolean; /** 同じく、ターンの意図と短い手の説明を求める段を足すか（既定は入り）。読み方は askStatusAtEnd と同じ。 */ liveHints?: boolean; /** 新しいセッションのモデルの札の初めの値。null は Claude Code の既定。プロジェクトの前回の値があれば、画面はそちらを先に使う。 */ defaultModel?: string | null; /** hangar が止まった会話を自動で Done にするか（既定は入り）。読み方は askStatusAtEnd と同じ。 */ autoDone?: boolean; /** 止まってから何日動きが無ければ Done にするか。0 はしない。この項目を知らない古いサーバは返さないので、読む側は 7 に寄せる。 */ autoDoneIdleDays?: import('./sessionState.ts').AutoDoneIdleDays; /** hangar が Done か Archived にした会話の Claude を、休みが続いたら止めるか（既定は入り）。読み方は askStatusAtEnd と同じ。 */ autoPark?: boolean; /** hangar が起動する claude を、スマホの Claude アプリや claude.ai/code から開けるようにするか（--remote-control、既定は入り）。claude.ai のログインのアカウントだけで効く。この項目を知らない古いサーバは返さないので、読む側は入りとして読む。 */ remoteControl?: boolean; nodePath: string | null; claudePath: string | null; /** 画面とサーバの文の言語。この項目を知らない古いサーバは返さないので、読む側は `languageOf` で既定の日本語に寄せる。 */ language?: import('./i18n/language.ts').Language; /** opencode を有効にするか（ベータ）。既定は切で、切のままなら opencode の入口はどこにも出さない。この項目を知らない古いサーバは返さないので、読む側は `opencodeEnabledOf` で切に寄せる。 */ opencodeEnabled?: boolean; /** hangar が起動する opencode のシステムプロンプトへの追記（既定は最小限）。読む側は `opencodeInjectionOf` で既定に寄せる。 */ opencodeInjection?: import('./opencodeCompat.ts').OpencodeInjection; /** シェルで打った opencode を hangar のセッションとして起こすか（既定は切、macOS と Linux だけ）。opencodeEnabled と両方が入りのときだけ、包みの本体に opencode() を書く。読む側は `opencodeInterceptOf` で切に寄せる。 */ opencodeIntercept?: boolean; /** hangar が起動する opencode に、許可のひな形（読むだけのコマンドのほかは shell を確認する）を重ねるか（既定は入り）。利用者の opencode.json に許可の規則があれば、入りでも重ねない。読む側は `opencodePermissionPresetOf` で入りに寄せる。 */ opencodePermissionPreset?: boolean; /** 起動前に LM Studio のモデルを載せる長さ（launchPrep.ts の LOCAL_CONTEXT_CHOICES）。読む側は `localContextOf` で既定の 64K に寄せる。 */ opencodeLocalContext?: number; /** 使っていないローカルのモデルを外すまでの分（launchPrep.ts の IDLE_UNLOAD_CHOICES、0 は外さない）。読む側は `idleUnloadOf` で既定の 5 分に寄せる。 */ opencodeIdleUnload?: number; /** opencode の接続先ごとの準備のコマンド（providerPrep.ts）。この PC だけの設定で、同期しない。PATCH は届いた接続先だけを替え、null で外す。この項目を知らない古いサーバは返さない。 */ opencodeProviderPrep?: Record<string, import('./providerPrep.ts').ProviderPrep | null>; /** Codex を有効にするか（ベータ）。既定は切で、切のままなら Codex の入口はどこにも出さない。この項目を知らない古いサーバは返さないので、読む側は `codexEnabledOf` で切に寄せる。 */ codexEnabled?: boolean; /** シェルで打った codex を hangar のセッションとして起こすか（既定は切、macOS と Linux だけ）。codexEnabled と両方が入りのときだけ、包みの本体に codex() を書く。読む側は `codexInterceptOf` で切に寄せる。 */ codexIntercept?: boolean; /** hangar が起動する codex のシステムプロンプトへの追記（既定は最小限）。読む側は `codexInjectionOf` で既定に寄せる。 */ codexInjection?: import('./codexCompat.ts').CodexInjection };
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
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; runs: RunDto[]; tabs: TabDto[]; todos: TodoDto[]; artifacts: ArtifactDto[]; summaryPending: string[]; index: IndexProgressDto; version: string; sync: SyncStatusBody; devices: DeviceDto[]; retention: RetentionDto | null; cloudUsage: CloudUsageDto | null; accounts: AccountsDto; /** 設定の同期（新しい実装）の状態。この項目を知らない古いサーバは返さない。 */ configSync?: ConfigSyncDto; /** サーバのホーム（os.homedir()）。画面はホームの下の置き場を ~ に縮めるときにだけ使う。 */ home: string; /** 中断の群（InterruptedDto）。 */ interrupted: InterruptedDto | null };
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
export type SearchParamsDto = { q: string; projectId?: string; since?: number; until?: number; live?: LiveFilter; stop?: import('./action.ts').StopFilter; file?: string; limit?: number; offset?: number; status?: SessionStatus | 'active' | 'proposed'; hideArchived?: boolean };
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
/**
 * 場所の無いプロジェクトの扱い。
 * repoint の merge は、選んだフォルダがこの PC で別のプロジェクトの置き場になっているときに、そのプロジェクトへまとめること。
 * 付けずに送ると、サーバは 409（ProjectSameFolderDto）で相手を返す。
 */
export type ResolveAction = { kind: 'repoint'; path: string; merge?: boolean } | { kind: 'archive' } | { kind: 'unlink' };
export type RunKind = 'start' | 'resume' | 'fork';
/** parked は、区切り（Done・Archived。0.5.0 までは Paused も）を付けたセッションが休みになったので hangar が止めたもの。 */
export type EndReason = 'exited' | 'killed' | 'lost' | 'parked' | 'taken_over';
/** 「ターミナルで開く」で使う外部ターミナル。macOS は Terminal.app と iTerm2、Windows は Windows Terminal と既定のターミナル（terminal.ts）。 */
export type TerminalApp = 'terminal' | 'iterm' | 'windowsTerminal' | 'windowsDefault';
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
/**
 * Claude 以外のエージェントの枠（ChatGPT のプランの 5 時間と週）。形は UsageDto に plan を足したもの。
 * 窓の長さで決める（5 時間は 300 分、週は 10080 分）。plan は planType の文字（plus、pro など）で、分からなければ null。
 * 画面の切り替え（開いている会話のエージェントの枠を出す）はこの値を読む。
 */
export type AgentUsageDto = UsageDto & { plan: string | null };
/** エージェントごとの枠。値が 1 度も届いていないエージェントと、設定で切のエージェントは持たない。Claude の枠は AccountDto.usage のまま変えない。 */
export type AgentUsagesDto = { codex?: AgentUsageDto };
/** `claude auth status --json` から読んだもの。hangar が認証について知るのはこれだけで、トークンは含まない。 */
export type AccountAuthDto = { loggedIn: boolean; email: string | null; plan: string | null; orgName: string | null; checkedAt: number };
/**
 * Claude Code のアカウント。置き場（CLAUDE_CONFIG_DIR）と 1 対 1 で、この PC の中だけにある。
 * primary は最初のアカウント（既定の置き場）で、消せない。
 * linkProblem は置き場のリンクが壊れている理由で、起動できるときは null。
 */
export type AccountDto = { id: string; name: string; dir: string; color: string; primary: boolean; auth: AccountAuthDto | null; usage: UsageDto; loginRunning: boolean; linkProblem: string | null };
/** sessions は、最初のアカウント以外で最後に動かしたセッションだけを載せる（セッションの id → アカウントの id）。載っていないものは最初のアカウントである。 */
export type AccountsDto = { currentId: string; accounts: AccountDto[]; sessions: Record<string, string>;
  /** Claude 以外のエージェントの枠（AgentUsagesDto）。何も無ければ項目ごと付けない。この項目を知らない古いサーバは送らず、古い画面は読まない。 */
  agents?: AgentUsagesDto };
/** 最初のアカウント（既定の置き場）の id。 */
export const PRIMARY_ACCOUNT_ID = 'primary';
/**
 * アカウントを足す前の確かめ（GET /api/accounts/preview）の答え。name と input は問いの写しで、画面は今の欄と合う答えだけを使う。
 * dir は使う場所の絶対パスで、input が空ならサーバが名前から作った候補（suggested が真）。
 * exists は場所が既にあるか、conflicts はリンクを張る名前に実ファイルや実フォルダがあるもの（触らずに残す）、registeredAs はその場所を使っている登録済みのアカウントの名前。
 */
export type AccountDirPreviewDto = { name: string; input: string; dir: string; suggested: boolean; exists: boolean; conflicts: string[]; registeredAs: string | null };
/**
 * 2 つ目以降のアカウントの場所で、最初の場所へのリンクにする項目を、画面に見せる組に分けたもの。
 * 組の中身を合わせると、サーバのリンクの一覧（accountLinks.ts の LINKED_ENTRIES）とちょうど同じになる（試験で見る）。
 */
export const ACCOUNT_LINK_GROUPS = [
  { key: 'config', entries: ['settings.json', 'CLAUDE.md', 'statusline-command.sh'] },
  { key: 'tools', entries: ['skills', 'commands', 'plugins'] },
  { key: 'memory', entries: ['memory', 'plans', 'tasks'] },
  { key: 'history', entries: ['projects', 'history.jsonl', 'file-history', 'paste-cache', 'session-env', 'shell-snapshots', 'sessions', 'jobs'] },
] as const satisfies readonly { key: string; entries: readonly string[] }[];
export type UsageDayDto = { day: string; inputTokens: number; outputTokens: number; sessions: number };
export type UsageProjectDto = { projectId: string | null; name: string; inputTokens: number; outputTokens: number; costUsd: number | null; sessions: number };
export type UsageAggregateDto = { days: UsageDayDto[]; projects: UsageProjectDto[] };
export type StatuslineStatusDto = { command: string | null; scriptPath: string | null; installed: boolean };
/**
 * ツールのパスを確かめた結果。
 * problem は動かせない理由で、動かせるときは null。
 * unset は設定が空、missing は無い、notFile はディレクトリなどファイルでない、notExecutable は実行権が無い。
 * 残りの 3 つは Node の設定だけのもの。notAbsolute はフルパスでない、notNode は Node として答えない、
 * wrongNode は Node-API が足りないか、アーキテクチャが違う Node（殻はその Node を使わない）。
 * version は `--version` などで読んだ版で、読めなかったときは null。
 * outdated は tmux の行だけのもので、Windows の psmux が下限（PSMUX_MIN_VERSION）より古いときだけ持つ。動かせるので ok は変えない（issue #245）。
 */
export type ToolProblem = 'unset' | 'missing' | 'notFile' | 'notExecutable' | 'notAbsolute' | 'notNode' | 'wrongNode';
export type ToolCheckDto = { path: string | null; ok: boolean; problem: ToolProblem | null; version: string | null; outdated?: { min: string } };
/** 候補の Node の版（v を除いたもの）、Node-API の版（`process.versions.napi`）、アーキテクチャ（`process.arch`）。 */
export type NodeBuildDto = { version: string; napi: number; arch: string };
/**
 * 同梱のサーバが要る Node。manifest.json の nodeApi、nodeMin、arch に当たる。
 * napi 以上の Node-API を持ち、アーキが同じ Node を使う。min は napi を持つ最初の Node の版で、案内に出すだけである。
 */
export type NodeNeedDto = { napi: number; min: string; arch: string };
/**
 * Node の設定の確かめ。auto は設定が空で、サーバを動かしている Node をそのまま見せていること。
 * found と need は problem が wrongNode のときだけ持ち、見つけた Node と、同梱のサーバが要る Node を表す。
 */
export type NodeCheckDto = ToolCheckDto & { auto: boolean; found?: NodeBuildDto; need?: NodeNeedDto };
/**
 * 準備の確かめ（GET /api/readiness）。
 * 設定画面の欄の下の検証と、ホームの帯の始める前の確認が、同じこの 1 つを読む。
 * node の auto は、設定が空で、サーバを動かしている Node をそのまま見せていることを表す。
 * workspace は設定の作成場所（任意。空は決めていない）で、projectCount はその直下から登録したプロジェクトの数である。
 * mcp は Claude Code の user スコープ（~/.claude.json）に hangar の MCP サーバが載っているか。読むだけで書かない。
 * commands は画面に出すコマンドで、どれも同じ hangar の呼び方にそろえてある。join は参加のコマンドで、接続先の所は `<URL>` と書く（参加コードは実行した後に入力する）。
 * compat は Claude Code との互換の要約で、設定の互換の節と、始める前の確認の互換の行が読む。ずれの中身は GET /api/compat で取る。
 */
export type ReadinessDto = {
  tools: { tmux: ToolCheckDto; claude: ToolCheckDto; node: NodeCheckDto; /** git。設定の欄は無く、PATH と既知の置き場（Windows は Git for Windows の場所）から探す。この項目を知らない古いサーバは返さない。 */ git?: ToolCheckDto };
  /** 選んだエディタで開けるか。この項目を知らない古いサーバは返さない。 */
  editor?: { id: import('./editor.ts').EditorId; name: string | null; state: import('./editor.ts').EditorDetectState; path: string | null };
  workspace: { path: string; exists: boolean; projectCount: number };
  /**
   * 始める前の確認の「プロジェクト」の行（2026-10-13）。resolved はこの PC で場所の分かっているプロジェクトの数、
   * candidates は Claude Code と会話したフォルダの候補の数で、resolved が 0 のときだけ数える（ほかは 0）。この項目を知らない古いサーバは返さない。
   */
  projects?: { resolved: number; candidates: number };
  mcp: { registered: boolean; file: string };
  statusline: StatuslineStatusDto;
  commands: { mcp: string; statusline: string; shell: string; join: string };
  compat: CompatSummaryDto;
};
/**
 * psmux（tmux）の再確認（POST /api/readiness/mux）の答え。
 * 探し直して見つかれば設定の tmuxPath を埋めるので、取り直した準備の確かめと一緒に、書いた後の設定も返す。
 */
export type MuxRecheckDto = { readiness: ReadinessDto; settings: SettingsDto };
/** 完了の候補。sessionId はセッション別でない MCP の URL から出たとき null、note は根拠が無いとき null。 */
export type TodoCandidateDto = { sessionId: string | null; note: string | null; at: number };
/** Claude が足した TODO の提案。利用者が受け入れるまで一覧の外（「Claude の提案」の節）に置く。出したセッションは TodoDto の sessionId、note は理由が無いとき null。 */
export type TodoSuggestionDto = { note: string | null; at: number };
/**
 * candidate は完了の候補で、候補でなければ null。完了の行では必ず null である（サーバが読むときにそろえる）。
 * suggestion は Claude が足して、まだ受け入れていない提案で、受け入れた行では null である。提案の行は未完の数に入れない。
 */
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number; candidate: TodoCandidateDto | null; suggestion: TodoSuggestionDto | null };
export type MemoDto = { projectId: string; markdown: string; updatedAt: number };
/**
 * Claude Code が起動時に読む指示とメモリのファイルの種類（右パネルの「指示とメモリ」）。
 * project はルートの CLAUDE.md、projectDotClaude は .claude/CLAUDE.md、local は CLAUDE.local.md、agents は AGENTS.md、memory は自動メモリの MEMORY.md である。
 */
export type InstructionFileKind = 'project' | 'projectDotClaude' | 'local' | 'agents' | 'memory';
/**
 * 指示とメモリのファイル 1 つ。あるものだけを返す。
 * read は Claude Code が起動時に読むか（AGENTS.md は CLAUDE.md の類があると既定では読まれない）。
 * markdown は本文で、大きすぎるときは先頭だけを入れて truncated を真にする。読めなければ null。
 */
export type InstructionFileDto = { kind: InstructionFileKind; name: string; size: number; updatedAt: number; read: boolean; markdown: string | null; truncated: boolean };
/** プロジェクトの指示とメモリ。available はこの PC にプロジェクトのフォルダがあるか。無ければ files は空である。 */
export type InstructionsDto = { projectId: string; available: boolean; files: InstructionFileDto[] };
export type ArtifactDto = { id: string; projectId: string | null; url: string; title: string | null; description: string | null; favicon: string | null; filePath: string | null; fileExists: boolean; firstPublishedAt: number; lastPublishedAt: number; versionCount: number; sessionIds: string[] };
export type PromoteResultDto = { project: ProjectDto; session: SessionDto; moved: boolean; reason: string | null };
/**
 * プロジェクトを作る場所。newDir は新しいフォルダを作り、dir は既存のディレクトリを登録する。
 * newDir の parent は作る場所で、省けば設定の作成場所（workspaceRoot）の下に作る。作成場所は任意なので、空のときは画面が Finder で選ばせて parent に入れる。
 * dir の allowNested は、登録済みのプロジェクトの下のフォルダを別のプロジェクトにすることの明示で、無ければサーバは 409（ProjectNestedDto）で断る。
 * dir の linkTo は、ほかの PC から届いたプロジェクトの id で、渡すと新しく作らずにそのプロジェクトのこの PC の場所にする（名前は変えない）。
 */
export type ProjectPlace = { kind: 'newDir'; name: string; gitInit: boolean; parent?: string } | { kind: 'dir'; path: string; name?: string; allowNested?: boolean; linkTo?: string };
/**
 * Claude Code と会話したフォルダの候補の 1 件（GET /api/workspace/candidates）。
 * path は git のリポジトリの根（worktree は元のリポジトリ）で、sessionCount はその下のまだプロジェクトに入っていない会話の数、
 * lastActivityAt はその中の最後の活動、worktreeCount はまとめた worktree の数である。
 */
export type FolderCandidateDto = { path: string; sessionCount: number; lastActivityAt: number | null; worktreeCount: number } & Partial<FolderCandidateHintsDto>;
/**
 * 候補の注記の符号（セットアップのすゝめ、2026-10-15）。
 * desktop-direct と downloads-direct はデスクトップとダウンロードそのものか直下、not-git は git でない、stale-30d は最後の活動が 30 日より前、single-session は会話が 1 件だけである。
 */
export type CandidateNote = 'desktop-direct' | 'downloads-direct' | 'not-git' | 'stale-30d' | 'single-session';
/**
 * クラウドで同期されている場所。
 * icloud は macOS の iCloud Drive（デスクトップと書類を含む）、onedrive は Windows の OneDrive である。
 */
export type CloudSyncedKind = 'icloud' | 'onedrive';
/**
 * 候補に足した項目（2026-10-15、hangar project candidates が読む）。
 * 初日の画面は読まない。
 * 古いサーバは付けない。
 * recentTitles は最近の会話の題（無ければ要約の 1 文、無ければ最初の発言の冒頭）を新しい順に 3 件まで、
 * isGit と gitRemote はリポジトリか、その remote（正規化した形。無ければ null）、
 * enclosedBy はほかの候補（candidate）か登録済みのプロジェクト（project）の下にあるときの、その場所（いちばん深いもの）である。
 */
export type FolderCandidateHintsDto = {
  recentTitles: string[];
  isGit: boolean;
  gitRemote: string | null;
  enclosedBy: { kind: 'candidate' | 'project'; path: string } | null;
  cloudSynced: CloudSyncedKind | null;
  notes: CandidateNote[];
};
/**
 * 候補の一覧。
 * suggestedRoot は、作成場所が空で、過半の候補が同じ親フォルダにあるときの、その親（無ければ null）。
 * unassignedTotal はこの PC の未分類の会話の総数、workspaceRoot はいまの作成場所（空なら null）である。
 * この 2 つは古いサーバは付けない。
 */
export type FolderCandidatesDto = { candidates: FolderCandidateDto[]; suggestedRoot: string | null; unassignedTotal?: number; workspaceRoot?: string | null };
/**
 * まとめて登録の 1 行の結果（2026-10-15）。
 * status は added（新しく登録した。試しなら登録する）、already（登録済み。失敗ではない）、linked（ほかの PC から届いたプロジェクトへ結び付けた）、
 * nested（登録済みのプロジェクトの下なので断った。enclosing が包むプロジェクト）、error（そのほかの理由で断った。error が理由）である。
 * name は登録する名前、sessionCount はその場で紐づく未分類の会話の数、restored はアーカイブから戻すことである。
 */
export type FolderRegisterOutcomeDto = {
  path: string;
  status: 'added' | 'already' | 'linked' | 'nested' | 'error';
  projectId?: string;
  name?: string;
  sessionCount?: number;
  restored?: boolean;
  enclosing?: EnclosingProjectDto;
  error?: string;
};
/**
 * 候補からまとめて登録した結果（POST /api/workspace/register）。failed は登録できなかったパスと理由である。
 * linked は、新しく作らずにほかの PC のプロジェクトへ結び付けたもののプロジェクトの id（projects にも入っている）。古いサーバは付けない。
 * results は行ごとの結果で、本文の並びのままである。
 * 古いサーバは付けない。
 */
export type FolderRegisterResultDto = { projects: ProjectDto[]; failed: { path: string; error: string }[]; linked?: string[]; results?: FolderRegisterOutcomeDto[] };
/**
 * まとめて登録の試し（本文に dryRun: true）。
 * 何も書かずに、行ごとの結果だけを返す。
 */
export type FolderRegisterPreviewDto = { dryRun: true; results: FolderRegisterOutcomeDto[] };
/**
 * 一覧から削除（resolve の unlink）の試し（本文に dryRun: true）。
 * sessionCount は未分類に戻る会話の数、syncing はクラウド同期を使っているか（真ならほかの PC の一覧からも消える）である。
 */
export type UnlinkPreviewDto = { dryRun: true; id: string; name: string; path: string | null; sessionCount: number; syncing: boolean };
/**
 * 作成場所を保存する前の試し（PATCH /api/settings に workspaceRoot と dryRun: true）。
 * workspaceRoot は保存する値（~ を展開したもの。空は未設定）、previous はいまの値、unchanged は値が変わらないこと（変わらなければ自動の登録は走らない）、
 * register は保存のときに自動で登録される直下のフォルダ（status は added か linked、会話の数つき）である。
 */
export type WorkspaceRootPreviewDto = { dryRun: true; workspaceRoot: string; previous: string; unchanged: boolean; register: FolderRegisterOutcomeDto[] };
/**
 * 作業フォルダの信頼（POST /api/workspace/trust）の結果。
 * dirs は信頼済みにするフォルダ（作業フォルダと、直下の git のリポジトリ）。
 * files は書く先（登録したアカウントごとの .claude.json）で、added は新しく信頼済みにした（dryRun ならする）鍵、missing はファイル（か置き場のフォルダ）が無くて書かなかったこと、error はそのファイルだけの失敗である。
 * consentRecorded は同意を設定に残したか（本番は書き込みが全部失敗しても残す。以後の起動で書くため）。試しは false。
 * note は、同意を残したときに利用者へ見せる 1 文（書けなかった分も含め、次の書き込みは起動のときに行う）。
 */
export type WorkspaceTrustDto = { dryRun: boolean; workspaceRoot: string; dirs: string[]; files: { file: string; added: string[]; missing: boolean; error?: string }[]; consentRecorded?: boolean; note?: string };
/**
 * まとめて登録の 1 行（POST /api/workspace/register の items）。
 * linkTo はほかの PC から届いたプロジェクトの id で、渡すと新しく作らずにそのプロジェクトのこの PC の場所にする。省けば新しく作る。
 * allowNested は、登録済みのプロジェクトの下のフォルダを別のプロジェクトにすることを明示する。無ければ、その行は失敗に入る。
 */
export type FolderRegisterItem = { path: string; linkTo?: string; allowNested?: boolean };
/** プロジェクトの参照。 */
export type ProjectRefDto = { projectId: string; name: string };
/** フォルダを下に持つ、この PC のプロジェクト（いちばん深いもの）。path はそのプロジェクトのこの PC の場所である。 */
export type EnclosingProjectDto = ProjectRefDto & { path: string };
/**
 * フォルダと結び付く、この PC に場所の無いプロジェクト（ほかの PC から届いたもの、この PC で場所が見つからなくなったもの）。
 * match は一致の強さで、remote は git の remote が同じ（強い一致）、name は名前が同じで remote が食い違わない（弱い一致）。
 * remote はそのプロジェクトの remote（正規化した形、例 `github.com/owner/repo`）。
 * deviceName と previousPath は、そのプロジェクトの場所を持つ PC の名前とそこでのパス。この PC で見つからなくなったものは、deviceName が null で previousPath がこの PC の前のパスである。分からなければ null。
 */
export type LinkCandidateDto = ProjectRefDto & { match: 'remote' | 'name'; remote: string | null; deviceName: string | null; previousPath: string | null };
/**
 * 親フォルダの直下の 1 行（GET /api/workspace/children）。
 * git はフォルダの直下に .git があること（リポジトリの中の下のフォルダは数えない）、worktree はそれがほかのリポジトリの worktree であること。
 * remote はそのリポジトリの remote（正規化した形）。sessionCount と lastActivityAt は、この PC の、作業フォルダがその下にある会話の数と最後の活動。
 * registered はこのフォルダを場所にしているプロジェクト、enclosing はこのフォルダを下に持つプロジェクト（自分は含まない）。
 * link は結び付く候補で、登録済みと worktree の行、同じプロジェクトに結び付くほかの行には付けない。
 * children は、git でなく中に git のフォルダを持つときだけ、その直下の行（さらに下は開かない）。ほかは null。
 */
export type WorkspaceChildDto = {
  name: string; path: string;
  git: boolean; worktree: boolean; remote: string | null;
  sessionCount: number; lastActivityAt: number | null;
  registered: ProjectRefDto | null; enclosing: EnclosingProjectDto | null; link: LinkCandidateDto | null;
  children: WorkspaceChildDto[] | null;
};
/** 親フォルダの直下の一覧。parent は正規化した親、enclosing は親そのものか親を下に持つプロジェクト（まとめて登録の黄の帯）。 */
export type WorkspaceChildrenDto = { parent: string; enclosing: EnclosingProjectDto | null; children: WorkspaceChildDto[] };
/**
 * 選んだ 1 つのフォルダの事前の問い合わせ（GET /api/workspace/inspect）。新しいセッションと新しいプロジェクトのダイアログが使う。
 * registered はそのフォルダを場所にしているプロジェクト。enclosing はそのフォルダを下に持つプロジェクトで、relative はその場所からの相対パスである。
 * link は結び付く候補で、登録済みなら null。
 */
export type FolderInspectDto = {
  path: string; git: boolean; worktree: boolean; remote: string | null;
  registered: ProjectRefDto | null; enclosing: (EnclosingProjectDto & { relative: string }) | null; link: LinkCandidateDto | null;
};
/**
 * 登録しようとしたフォルダが、登録済みのプロジェクトの下にあったときの 409 の本文（POST /api/projects の dir）。
 * 画面は enclosing を添えて「別のプロジェクトにする」を選ばせ、選んだら allowNested を付けて送り直す。
 */
export type ProjectNestedDto = { error: string; code: 'project_nested'; enclosing: EnclosingProjectDto };
/** ワークスペース直下の、まだプロジェクトになっていないディレクトリ。 */
export type WorkspaceDirDto = { name: string; path: string };
export type SummarizerId = 'lmstudio' | 'claude-headless';
export type SummarizerTestDto = { ok: true; id: SummarizerId; ms: number; summary: Omit<SessionSummaryDto, 'updatedAt'> } | { ok: false; tried: { id: SummarizerId; message: string }[] };

/** ここから下はクラウド同期（フェーズ 4）の DTO である。 */
/**
 * 他端末がそのセッションを実行中であることの印。
 * stale は、その PC を Worker が 3 分より前から見ていないこと（または一度も見ていないこと）を示す。
 * heartbeatAt は、同期の版 6 からその PC の最終接続（この PC の時計）で、知らなければ run の行の heartbeat_at である。名前は版 5 までのまま。
 */
export type SessionLockDto = { deviceId: string; deviceName: string; runId: string; heartbeatAt: number; stale: boolean };
/**
 * 「この PC で再開」が、ほかの PC で動いている会話を止めて引き継ぐ流れ（server/src/sync/takeover.ts）。
 * asking は頼みを書いて送っている間、waiting は相手の応答を待っている間、receiving は相手が止まったあと本文が降りきるのを待っている間である。
 * ready は引き継げる、timeout は打ち切り（TAKEOVER_TIMEOUT_MS）または頼みを運べない、cancelled は取り下げである。
 */
export type TakeoverStage = 'asking' | 'waiting' | 'receiving' | 'ready' | 'timeout' | 'cancelled';
export type TakeoverDto = { sessionId: string; deviceName: string; stage: TakeoverStage; startedAt: number; deadline: number };
/** 相手の応答を待つ長さ。「もう少し待つ」はその時点から同じ長さを足す。 */
export const TAKEOVER_TIMEOUT_MS = 90_000;
/** 生きたロックのある会話を、頼まずに「この PC で再開」しようとして断られたときの本文（409）。 */
export type TakeoverLockedDto = { error: string; code: 'locked' };
export type SyncStateKind = 'off' | 'idle' | 'pushing' | 'pulling' | 'paused' | 'error';
/**
 * limitedUntil は、Cloudflare の無料枠の上限に当たって退いている間の戻る時刻である。
 * ふつうは次の UTC の 0 時で、UTC の 0 時から 10 分の間に断られたときは断られた 5 分後である。
 * 退いている間の state は paused で、利用者が一時停止しているときと、退いていないときは null である。
 * paused は利用者が同期を一時停止しているか（sync_state の paused の印）である。
 * 版で止まって state が error のときも、一時停止していれば true になる。
 * pending は、送り先があって送るのを待っている変更の数である。state が off のあいだは送り先が無いので 0 にする。
 * off のあいだの変更も changes に積んであり、同期を有効にした後に送る。
 */
/** revoked は、この PC が同期から解除された（Worker が端末トークンを 401 の revoked で断った）印。そのあいだ state は error である。送らない古いサーバは偽とみなす。 */
/**
 * legacyConfig は、cloud.json が 0.8.x までの古い形式（参加用の秘密を持つ版 1）のため同期を始めていない印。
 * そのあいだ state は off で、設定の画面は未参加と見分けてクラウドの再構築を案内する。
 * 立っているときだけ true で載せ、それ以外は載せない（送らない古いサーバも偽とみなす）。
 */
export type SyncStatusDto = { state: SyncStateKind; paused: boolean; url: string | null; lastPushAt: number | null; lastPullAt: number | null; pending: number; error: string | null; deviceCount: number; limitedUntil: number | null; revoked?: boolean; legacyConfig?: boolean };
/**
 * 降ろすのを諦めた本文。key は雲の中の鍵、attempts は試した回数、message は最後の理由。
 * 載るのは降ろす側（RemotePuller）の諦めだけである。
 * 上げる側の諦めは TranscriptUploader が sync_state に残していて、ここには出てこない。
 */
export type SyncSkippedDto = { key: string; attempts: number; message: string };
/**
 * 空きが足りずに、本文の取得を止めている事実（sync/puller.ts）。
 * sessions は取得していない会話の数、needBytes はその大きさ、freeBytes は止めたときの空き、reserveBytes は残す分（5 GB かディスクの 10% の小さい方）である。
 */
export type SyncDiskShortDto = { sessions: number; needBytes: number; freeBytes: number; reserveBytes: number };
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
export type SyncDetailDto = {
  skipped: SyncSkippedDto[]; sweepPending: number | null; oncePass: boolean;
  /** 空きが足りずに取得を止めているときの事実。止めていなければ null。 */
  diskShort: SyncDiskShortDto | null;
};
/** 同期の状態の応答。SyncStatusDto に付録を足したものである。 */
export type SyncStatusBody = SyncStatusDto & SyncDetailDto;
/**
 * 設定のクラウド同期の節の PC の一覧（GET /api/sync/cloud-devices）。この PC に self の印を付ける。
 * 端末の並びと、参加日、最終接続、解除、トークンの期限は Worker の devices から取る。
 * 名前と OS（platform）は封じた名簿から取り、名簿に無い端末は name と platform が null の「名前のわからない端末」である。
 * IP と所在地は持たない。
 * state は、ok（一覧が取れた）、off（同期していない）、outdated（Worker が版 5 より古く、一覧と解除の口を持たない）、
 * unreachable（Worker に繋がらない、または一覧の問い合わせが失敗した）、revoked（この PC が解除されている）である。
 * creator は、この PC がクラウドを作った PC か（cloud.json に Worker の名前がある）。参加を解除すると teardown できなくなる旨を出すのに使う。
 * message は ok と off のほかで、画面に出す理由の文（サーバの言語）。
 */
export type CloudDeviceDto = {
  id: string;
  kind: 'pc' | 'mobile';
  name: string | null;
  platform: string | null;
  joinedAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** トークンの期限。null なら期限なし。 */
  expiresAt: number | null;
  self: boolean;
};
export type CloudDevicesDto = { state: 'ok' | 'off' | 'outdated' | 'unreachable' | 'revoked'; devices: CloudDeviceDto[]; creator: boolean; message: string | null };
/**
 * スマホを接続する QR（POST /api/sync/mobile-pairing）。押すたびに Worker から新しい券を取る。
 * ready の pairText は PairingBlob（スマホ用の暗号鍵を含む）を base64url にしたもので、pairUrl は `<Worker の URL>/app/#pair=<pairText>`。
 * どちらも QR と「文字列をコピー」にだけ使い、ログや PC が開く URL に載せない。参加の秘密そのものは含まない。
 * not-joined は同期に参加していない、worker-too-old は Worker の版が足りない（compat は名乗った版、分からなければ null）、rate-limited は券の取りすぎ（10 分に 5 枚）。
 * pairId は券の印（券のハッシュで、券の平文ではない）で、GET /api/sync/mobile-pairing/:pairId（MobilePairedDto）に渡す。
 */
export type MobilePairingDto =
  | { state: 'ready'; pairUrl: string; pairText: string; expiresAt: number; pairId: string }
  | { state: 'not-joined' }
  | { state: 'worker-too-old'; compat: number | null }
  | { state: 'rate-limited' };
/**
 * QR を出している間に設定の画面が見る口（GET /api/sync/mobile-pairing/:pairId）。
 * paired は、その券で接続し、PC が keybox を置き終えたスマホ。まだなら null。サーバーは手元の覚えだけを返し、Worker には問い合わせない。
 */
export type MobilePairedDto = { paired: { id: string; name: string } | null };
/** shell はその端末の包み方（hangar shell install）の状態。まだ知らせてこない古い版の端末は null になる。 */
export type DeviceDto = { id: string; name: string; platform: string; lastSeenAt: number | null; self: boolean; shell: ShellHookStateDto | null };
export type ShellHookStateDto = 'on' | 'off' | 'unsupported';
/** Settings の「外のターミナル」。state はこの PC の状態、command は入れるために貼るコマンド。 */
export type ShellHookDto = {
  state: ShellHookStateDto; zshrc: string; line: string; command: string;
  /** この OS で包みを作るか。Windows では偽で、画面はシェル連携の節ごと出さない。送らない古いサーバは真とみなす。 */
  osSupported?: boolean;
};
/**
 * Claude Code の設定の同期（docs/superpowers/specs/2026-10-09-config-sync-rebuild-design.md）の形。
 */
/** 運ぶ項目の種類。settings は settings.json の鍵 1 つが 1 項目で、memory はプロジェクトのメモリと ~/.claude/memory の下のファイル。 */
export type ConfigItemKind = 'claude-md' | 'settings' | 'keybindings' | 'skills' | 'commands' | 'agents' | 'memory'
  // 後の対象が使う種類（v0.12.0）。古い版は知らない id と一緒にこの種類も読み飛ばす。
  | 'claude-mcp' | 'claude-hooks' | 'claude-statusline' | 'plugins' | 'codex-file' | 'codex-config' | 'codex-mcp' | 'opencode-file' | 'opencode-config' | 'opencode-cli' | 'opencode-mcp' | 'agents-skills' | 'hangar-pref';
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
export type ConfigUnsentKind = 'permission-rule' | 'secret' | 'unknown-key';
export type ConfigUnsentItemDto = { id: string; kind: ConfigUnsentKind; itemId: string; label: string; reason: string; allowed: boolean };
export type ConfigUnsentDto = { items: ConfigUnsentItemDto[] };
export type ConfigBackupGenerationDto = { name: string; at: number | null; files: number };
export type ConfigBackupsDto = { generations: ConfigBackupGenerationDto[] };
/** 承諾の選択 1 件。take が remote なら相手の中身を採り、mine なら手元を採る（手元は書き換えず、基準だけを進める）。 */
export type ConfigApplyOrderEntryIn = { id: string; take?: 'remote' | 'mine' };
export type ConfigApplyOrderItemDto = { id: string; kind: ConfigItemKind; op: ConfigInboxOp; take: 'remote' | 'mine'; fromDeviceId: string; sha256: string; /** 書き込み先。ファイルは設定の入れ物からの相対パス、settings は `settings.json#<鍵>`。 */ target: string };
/** 適用の指示書。サーバは ~/.claude に書かず、殻の命令と hangar config apply が読む。 */
export type ConfigApplyOrderDto = { createdAt: number; items: ConfigApplyOrderItemDto[] };
/** 設定の入れ物を管理している道具（SPEC 8 章）。表示のためだけで、同期は止めない。 */
export type ConfigVcsTool = 'git' | 'chezmoi' | 'yadm' | 'stow';
/** 入れ物ごとの検出。tools が空の入れ物は載せない。 */
export type ConfigVcsDto = { target: string; tools: ConfigVcsTool[] };
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
  /** 入れ物が git や dotfiles の道具で管理されているか（対象ごと、管理されているものだけ。印が無ければ欄ごと省く）。この項目を知らない古いサーバは返さないので、読む側は空として読む。 */
  vcs?: ConfigVcsDto[];
};
/**
 * 「場所を再指定」で選んだフォルダが、この PC で別のプロジェクトの場所になっているときの 409。
 * from はまとめる方、conflict は残す方で、path は正規化したフォルダである。
 * まとめるときは、from のプロジェクトへ同じ path と merge: true を送り直す（既に両方の場所になっているときは、選んだ方が残す方のこともある）。
 * merged はまとめた後の姿で、roots は PC ごとの場所（here はこの PC、deviceName は分からなければ null）、sessions は残す方の、fromSessions はまとめる方のセッションの数である。
 */
export type ProjectSameFolderDto = {
  error: string;
  code: 'project_same_folder';
  from: ProjectSameFolderRef;
  conflict: ProjectSameFolderRef & { path: string };
  merged: { roots: { deviceName: string | null; path: string; here: boolean }[]; sessions: number; fromSessions: number };
};
export type ResumeHereConflictDto = { error: 'local_smaller'; localSize: number; remoteSize: number };
/**
 * 再開の要求（POST /api/sessions/:id/resume）で、hangar では終わった扱いの run の claude がまだ動いているときにどうするか。
 * stop はその claude を止めてから再開し、ignore は止めずに再開する。付けなければ、残っていれば StrayProcessDto の 409 で断る。
 */
export type ResumeStray = 'stop' | 'ignore';
/** 再開を、終わった扱いの run の claude（pid）が動き続けていることで断った 409。 */
export type StrayProcessDto = { error: string; code: 'stray_process'; pid: number };
/**
 * 「この PC で再開」の確認に出すもの（GET /api/sessions/:id/resume-here）。
 * from は会話を最後に動かした PC（run が無ければ作った PC）と、その作業ディレクトリと、最後に使った日時である。
 * to はこの PC と、再開するときの作業ディレクトリ（前の PC のプロジェクトの場所からの相対を、この PC の場所に継いだもの）。
 * この PC でプロジェクトの場所が決まらなければ to.path は null で、再開はできない。
 * platform は devices.platform（darwin、win32 など）で、画面が辞書で OS の名前にする。
 */
export type ResumeHerePlanDto = {
  sessionId: string;
  from: { deviceName: string | null; platform: string | null; path: string; lastAt: number | null };
  /**
   * path は再開する作業ディレクトリで、場所が決まらなければ null。
   * createsFolder は、そのフォルダを再開の前に作るか（ほかの PC のクイックセッションを quick-sessions/<元のフォルダ名> で再開するとき）。古いサーバは送らない。
   */
  to: { deviceName: string | null; platform: string | null; path: string | null; createsFolder?: boolean };
  /** この PC のトランスクリプトをほかの PC の写しで置き換えるとき（ResumeHereReplaceDto）。手元に無いか、手元の方が大きいか同じなら null。 */
  replace: ResumeHereReplaceDto | null;
  /**
   * ほかの PC の run が生きているとき（応答が途絶えたものを含む）。確認の 1 枚が、停止して引き継ぐか、応答のない相手を引き継ぐかを決める。
   * 相手が作業中かどうかは共有しないので載せない。生きた run が無ければ null。
   */
  lock: { deviceName: string; stale: boolean; heartbeatAt: number } | null;
};
/**
 * 「この PC で再開」で、手元のトランスクリプトを置き換えること（A → B → A と戻ったとき）。
 * ahead は手元がほかの PC の写しの先頭部分（ほかの PC がこの続きを進めた）、diverged は先頭部分でない（この PC でも別の続きを進めた）。
 * どちらも置き換える前に控えを取る。確認の 1 枚が 1 行で言い、承諾は上書きつきで送る。
 */
export type ResumeHereReplaceDto = { kind: 'ahead' | 'diverged'; localSize: number; remoteSize: number };

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
  plan: { workersPaid: boolean; r2Paid: boolean } | null;
  month: { periodStart: string; periodEnd: string | null; throughDay: string | null; billedUsd: number; rows: { label: string; consumed: number; unit: string; included: number | null }[] } | null;
};

/** 初期プロンプト欄の `/` の候補の出どころ。 */
export type PromptCommandSource = 'project' | 'user' | 'plugin' | 'builtin';
/** 初期プロンプト欄の `/` の候補。uses は、セッションの最初の一言になった回数。 */
export type PromptCommandDto = { name: string; description: string; argumentHint: string | null; source: PromptCommandSource; uses: number };
/** `~/.agent-hangar/drops/` に置いたファイル。 */
export type DropDto = { path: string; name: string; size: number };
