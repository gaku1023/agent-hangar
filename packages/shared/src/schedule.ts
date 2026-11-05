import type { AgentKind } from './agents.ts';

/**
 * 定期の実行（#549）。予定は作った PC のローカルにだけ置き、同期しない。
 * days は Date.getDay() と同じ数え方で、0 が日曜である。time は手元の時刻の HH:MM。
 */
export type ScheduleSpec =
  | { kind: 'once'; at: number }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'every'; minutes: number };

/**
 * 新しい会話の起動の項目。名前は LaunchParams（action.ts）にそろえる。
 * 未指定は既定のまま起動する（アカウントだけは、実行するときにいま選んでいるものになる）。
 */
export type ScheduleLaunch = {
  name?: string; account?: string; model?: string; effort?: string; permissionMode?: string; worktree?: string;
  addDirs?: string[]; mode?: string; autoApprove?: boolean;
  /** 登録済みのプロジェクトの下のフォルダ。 */
  cwd?: string;
};

export type ScheduleTarget =
  /** projectId が null のものはクイックセッション（scratch が真）。 */
  | ({ kind: 'new'; projectId: string | null; scratch?: boolean; agent?: AgentKind } & ScheduleLaunch)
  | { kind: 'session'; sessionId: string };

export type ScheduleRunResult = 'running' | 'finished' | 'waiting' | 'failed' | 'skipped';

export type ScheduleRunDto = {
  id: string;
  plannedAt: number;
  startedAt: number;
  endedAt: number | null;
  result: ScheduleRunResult;
  sessionId: string | null;
  sessionTitle: string | null;
  error: string | null;
};

export type ScheduleDto = {
  id: string;
  prompt: string;
  spec: ScheduleSpec;
  target: ScheduleTarget;
  projectId: string | null;
  projectName: string | null;
  /** 新しい会話の予定が持つアカウントの表示名。いまのアカウントの組から引き、引けなければ null。 */
  accountName: string | null;
  sessionTitle: string | null;
  enabled: boolean;
  nextAt: number | null;
  /** 新しい順。 */
  runs: ScheduleRunDto[];
};

export type ScheduleInput = { prompt: string; spec: ScheduleSpec; target: ScheduleTarget };
export type SchedulePatch = Partial<ScheduleInput> & { enabled?: boolean };

/** 残す履歴の件数。 */
export const SCHEDULE_RUNS_KEPT = 5;
/** N 分おきの下限。短すぎる間隔で使用枠を食い切らないようにする。 */
export const SCHEDULE_MIN_EVERY_MINUTES = 5;
/** N 分おきの上限（7 日）。 */
export const SCHEDULE_MAX_EVERY_MINUTES = 10_080;
/** 指示の上限（文字数）。既存の会話へ送る口の上限（send_to_session）と同じ。 */
export const SCHEDULE_PROMPT_MAX = 8000;
/** 持てる予定の上限。インジェクションされたエージェントが作り続けても、ここで止まる。 */
export const SCHEDULES_MAX = 50;
