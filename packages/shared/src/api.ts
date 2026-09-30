import type { StepKind } from './steps.ts';
import type { TranscriptEvent } from './transcript.ts';

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type LiveStatus = 'busy' | 'idle' | 'waiting';
export type SummaryState = 'in_progress' | 'done' | 'blocked' | 'abandoned';
export type SummarySource = 'baseline' | 'in_session' | 'post_hoc';
export type ProjectDto = { id: string; name: string; status: ProjectStatus; isScratch: boolean; path: string | null; resolved: boolean; lastActivityAt: number | null; runningCount: number; openTodoCount: number; memoHead: string | null; updatedAt: number };
export type SessionStatsDto = { turns: number; model: string | null; effort: string | null; filesChanged: number; prUrl: string | null; inputTokens: number; outputTokens: number; contextPercent: number | null; costUsd: number | null };
/** sourceId は書いた要約器の id。source_id を持たない古い行と、要約器を通さない要約では null になる。 */
export type SessionSummaryDto = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[]; source: SummarySource; sourceId: string | null; sourceModel: string | null; basedOnTurns: number; updatedAt: number };
/**
 * Claude のレジストリ（~/.claude/sessions/<pid>.json）の 1 件。
 * background は Claude のバックグラウンドのサービスが持つセッションにだけ付く。jobId は `claude attach` に渡す短い id である。
 * procStart はそのプロセスの起動時刻（UTC の ps の lstart の書式）。pid の使い回しを見分けるのに使う。古い Claude は書かない。
 * entrypoint は claude を起こしたもの。ターミナルの CLI は cli、VS Code の拡張は claude-vscode になる。
 */
export type LiveSessionDto = { sessionId: string; status: LiveStatus; name: string | null; nameSource: string | null; cwd: string; pid: number; background?: { jobId: string }; procStart?: string; entrypoint?: string };
/** 実行中のセッションが最後に呼んだツールと、答えを待っている AskUserQuestion の問い。端末ローカルで、同期しない。 */
export type SessionActivityDto = { tool: string; summary: string; question: string | null };
export type SessionDto = { id: string; provider: 'claude-code'; providerSessionId: string; projectId: string | null; name: string | null; cwd: string; firstPrompt: string | null; aiTitle: string | null; startedAt: number | null; lastActivityAt: number | null; memo: string | null; hasTranscript: boolean; live: LiveStatus | null; summary: SessionSummaryDto | null; stats: SessionStatsDto; fromScratch: boolean; lock: SessionLockDto | null; remoteOnly: boolean; transcriptMtime: number | null; activity?: SessionActivityDto | null };
export type SettingsDto = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean; syncClaudeConfig: boolean; nodePath: string | null; claudePath: string | null };
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
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; runs: RunDto[]; tabs: TabDto[]; usage: UsageDto; todos: TodoDto[]; artifacts: ArtifactDto[]; summaryPending: string[]; index: IndexProgressDto; version: string; sync: SyncStatusBody; devices: DeviceDto[]; retention: RetentionDto | null };
export type EventsPageDto = { sessionId: string; events: TranscriptEvent[]; total: number; nextSeq: number | null };
/**
 * 実行中のセッションの右ペインに出すライブの要約。サーバが主線とサブエージェントを読んで作る。
 * 指揮役の手と目次の色帯は UI が主線のイベントから作るので、ここには載せない。
 * linked はサブエージェントの transcript と結べたか。結べないレーンの agentId は `tool:<toolId>` である。
 */
export type LiveAgentDto = { agentId: string; title: string; state: 'running' | 'done' | 'error'; startedAt: number | null; lastAt: number | null; last: { text: string; mono: boolean; kind: StepKind; isError: boolean } | null; report: string | null; linked: boolean };
export type LiveIntentDto = { text: string; at: number; stepsSince: number; inThisTurn: boolean };
export type LiveDigestDto = { sessionId: string; turnStartSeq: number | null; intent: LiveIntentDto | null; agents: LiveAgentDto[] };
export type SearchParamsDto = { q: string; projectId?: string; since?: number; until?: number; running?: boolean; file?: string; limit?: number };
export type SearchHitDto = { sessionId: string; matchCount: number; snippets: { seq: number; role: string; text: string }[] };
export type SearchResultDto = { hits: SearchHitDto[]; total: number };
export type ResolveAction = { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' };
export type RunKind = 'start' | 'resume' | 'fork';
export type EndReason = 'exited' | 'killed' | 'lost';
export type TerminalApp = 'terminal' | 'iterm';
/** 1 回の起動または再開。tmux 上の寿命と一致する。 */
export type RunDto = { id: string; sessionId: string; deviceId: string; kind: RunKind; tmuxName: string; pid: number | null; startedAt: number; endedAt: number | null; endReason: EndReason | null; heartbeatAt: number };
/** セッション画面のタブ。agent タブの id は run の id と同じ。 */
export type TabDto = { id: string; runId: string; sessionId: string; kind: 'agent' | 'shell'; title: string; tmuxName: string; createdAt: number; closedAt: number | null };
export type LaunchResultDto = { run: RunDto; sessionId: string; tabs: TabDto[] };

/** statusline の payload から得た使用率。窓の値が無いときは null で、updatedAt は使用率が届いた時刻。 */
export type RateWindowDto = { usedPercent: number; resetsAt: number | null };
export type UsageDto = { fiveHour: RateWindowDto | null; sevenDay: RateWindowDto | null; updatedAt: number | null };
export type UsageDayDto = { day: string; inputTokens: number; outputTokens: number; sessions: number };
export type UsageProjectDto = { projectId: string | null; name: string; inputTokens: number; outputTokens: number; costUsd: number | null; sessions: number };
export type UsageAggregateDto = { days: UsageDayDto[]; projects: UsageProjectDto[] };
export type StatuslineStatusDto = { command: string | null; scriptPath: string | null; installed: boolean };
/** 完了の候補。sessionId はセッション別でない MCP の URL から出たとき null、note は根拠が無いとき null。 */
export type TodoCandidateDto = { sessionId: string | null; note: string | null; at: number };
/** candidate は古いサーバからは欠ける。欠けたものは null として扱う。 */
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number; candidate?: TodoCandidateDto | null };
export type MemoDto = { projectId: string; markdown: string; updatedAt: number };
export type ArtifactDto = { id: string; projectId: string | null; url: string; title: string | null; description: string | null; favicon: string | null; filePath: string | null; fileExists: boolean; firstPublishedAt: number; lastPublishedAt: number; versionCount: number; sessionIds: string[] };
export type PromoteResultDto = { project: ProjectDto; session: SessionDto; moved: boolean; reason: string | null };
export type SummarizerId = 'lmstudio' | 'claude-headless';
export type SummarizerTestDto = { ok: true; id: SummarizerId; ms: number; summary: Omit<SessionSummaryDto, 'updatedAt'> } | { ok: false; tried: { id: SummarizerId; message: string }[] };

/** ここから下はクラウド同期（フェーズ 4）の DTO である。 */
/** 他端末がそのセッションを実行中であることの印。stale は heartbeat が途切れていることを示す。 */
export type SessionLockDto = { deviceId: string; deviceName: string; runId: string; heartbeatAt: number; stale: boolean };
export type SyncStateKind = 'off' | 'idle' | 'pushing' | 'pulling' | 'paused' | 'error';
export type SyncStatusDto = { state: SyncStateKind; url: string | null; lastPushAt: number | null; lastPullAt: number | null; pending: number; error: string | null; deviceCount: number; claudeConfig: { enabled: boolean; confirmed: boolean } };
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
 * 数えられないときは null になる（同期を設定していない端末と、この口を持たない古いサーバ）。
 */
export type SyncDetailDto = { skipped: SyncSkippedDto[]; sweepPending: number | null };
/** 同期の状態の応答。SyncStatusDto に付録を足したものである。 */
export type SyncStatusBody = SyncStatusDto & SyncDetailDto;
export type TakeoverPhase = 'requested' | 'waiting' | 'acked' | 'copying' | 'resumed' | 'timeout' | 'failed' | 'cancelled';
export type TakeoverUpdateDto = { sessionId: string; requestId: string | null; phase: TakeoverPhase; force: boolean; message: string | null; elapsedMs: number };
/** shell はその端末の包み方（hangar shell install）の状態。まだ知らせてこない古い版の端末は null になる。 */
export type DeviceDto = { id: string; name: string; platform: string; lastSeenAt: number | null; self: boolean; shell: ShellHookStateDto | null };
export type ShellHookStateDto = 'on' | 'off' | 'unsupported';
/** Settings の「外のターミナル」。state はこの PC の状態、command は入れるために貼るコマンド。 */
export type ShellHookDto = { state: ShellHookStateDto; zshrc: string; line: string; command: string };
export type ConfigPreviewAction = 'create' | 'overwrite' | 'conflict' | 'skip';
export type ConfigPreviewEntryDto = { path: string; action: ConfigPreviewAction; localMtime: number | null; remoteMtime: number; remoteDevice: string; size: number };
export type ConfigPreviewDto = { entries: ConfigPreviewEntryDto[]; confirmed: boolean };
export type ResumeHereConflictDto = { error: 'local_smaller'; localSize: number; remoteSize: number };
