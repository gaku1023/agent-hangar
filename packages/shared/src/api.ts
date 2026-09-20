import type { TranscriptEvent } from './transcript.ts';

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type LiveStatus = 'busy' | 'idle' | 'waiting';
export type SummaryState = 'in_progress' | 'done' | 'blocked' | 'abandoned';
export type SummarySource = 'baseline' | 'in_session' | 'post_hoc';
export type ProjectDto = { id: string; name: string; status: ProjectStatus; isScratch: boolean; path: string | null; resolved: boolean; lastActivityAt: number | null; runningCount: number; openTodoCount: number; memoHead: string | null; updatedAt: number };
export type SessionStatsDto = { turns: number; model: string | null; effort: string | null; filesChanged: number; prUrl: string | null; inputTokens: number; outputTokens: number; contextPercent: number | null; costUsd: number | null };
/** sourceId は書いた要約器の id。source_id を持たない古い行と、要約器を通さない要約では null になる。 */
export type SessionSummaryDto = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[]; source: SummarySource; sourceId: string | null; sourceModel: string | null; basedOnTurns: number; updatedAt: number };
export type LiveSessionDto = { sessionId: string; status: LiveStatus; name: string | null; nameSource: string | null; cwd: string; pid: number };
export type SessionDto = { id: string; provider: 'claude-code'; providerSessionId: string; projectId: string | null; name: string | null; cwd: string; firstPrompt: string | null; aiTitle: string | null; startedAt: number | null; lastActivityAt: number | null; memo: string | null; hasTranscript: boolean; live: LiveStatus | null; summary: SessionSummaryDto | null; stats: SessionStatsDto; fromScratch: boolean; lock: SessionLockDto | null; remoteOnly: boolean };
export type SettingsDto = { workspaceRoot: string; claudeDir: string; tmuxPath: string | null; terminalApp: TerminalApp; codePath: string | null; lmStudioUrl: string; lmStudioModel: string | null; summaryFallback: boolean; summaryHourlyCap: number; allowExternalSummarizer: boolean; syncClaudeConfig: boolean; nodePath: string | null };
export type IndexProgressDto = { phase: 'idle' | 'scanning' | 'indexing' | 'rebuilding'; done: number; total: number };
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; runs: RunDto[]; tabs: TabDto[]; usage: UsageDto; todos: TodoDto[]; artifacts: ArtifactDto[]; summaryPending: string[]; index: IndexProgressDto; version: string; sync: SyncStatusBody; devices: DeviceDto[] };
export type EventsPageDto = { sessionId: string; events: TranscriptEvent[]; total: number; nextSeq: number | null };
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
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number };
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
 * だから websocket の sync.status には載らず、HTTP の応答（bootstrap と /sync/status と /sync/now と /sync/pause）だけが運ぶ。
 * sweepPending は、これから上がる本文の件数である。
 * 消したセッションの本文と、上げるのを諦めた本文は入らない（どちらも上がる予定に無い）。
 * 数えられないときは null になる（同期を設定していない端末と、この口を持たない古いサーバ）。
 */
export type SyncDetailDto = { skipped: SyncSkippedDto[]; sweepPending: number | null };
/** 同期の状態の応答。SyncStatusDto に付録を足したものである。 */
export type SyncStatusBody = SyncStatusDto & SyncDetailDto;
export type TakeoverPhase = 'requested' | 'waiting' | 'acked' | 'copying' | 'resumed' | 'timeout' | 'failed' | 'cancelled';
export type TakeoverUpdateDto = { sessionId: string; requestId: string | null; phase: TakeoverPhase; force: boolean; message: string | null; elapsedMs: number };
export type DeviceDto = { id: string; name: string; platform: string; lastSeenAt: number | null; self: boolean };
export type ConfigPreviewAction = 'create' | 'overwrite' | 'conflict' | 'skip';
export type ConfigPreviewEntryDto = { path: string; action: ConfigPreviewAction; localMtime: number | null; remoteMtime: number; remoteDevice: string; size: number };
export type ConfigPreviewDto = { entries: ConfigPreviewEntryDto[]; confirmed: boolean };
export type ResumeHereConflictDto = { error: 'local_smaller'; localSize: number; remoteSize: number };
