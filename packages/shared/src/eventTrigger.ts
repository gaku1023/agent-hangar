import type { ScheduleRunDto, ScheduleTarget } from './schedule.ts';

/**
 * 外のできごと（GitHub と外の webhook）で動く結び付け（#563）。
 * 結び付けは作った PC のローカルにだけ置き、同期しない。
 * 受け箱の側の上限は eventInbox.ts にある。
 */

/** GitHub で見るできごと。 */
export type GithubWhen = 'ci_done' | 'ci_failed' | 'review' | 'comment' | 'merged' | 'issue_opened';

export type EventSource =
  | { kind: 'github'; repo: string; when: GithubWhen[]; pr?: number; labels?: string[] }
  | { kind: 'hook' };

/** 動き。new は予定の新しい会話と同じ項目を持つ。 */
export type EventAction =
  | { kind: 'wake'; sessionId: string }
  | { kind: 'send'; sessionId: string }
  | { kind: 'send_pr_owner' }
  | Extract<ScheduleTarget, { kind: 'new' }>;

export type EventBindingState = 'draft' | 'active' | 'held' | 'error';

/**
 * 結び付け。受け箱の秘密鍵と GitHub の webhook の秘密の値は、ここに出さない。
 * hookUrl は一覧では常に null で、URL は専用の道でだけ返す。
 */
export type EventBindingDto = {
  id: string;
  source: EventSource;
  action: EventAction;
  prompt: string;
  passBody: boolean;
  allowAuthors: string[];
  state: EventBindingState;
  hookUrl: null;
  createdAt: number;
  expiresAt: number | null;
  /** 新しい順。 */
  runs: ScheduleRunDto[];
};

/** Paused を起こす条件。propose_session_status の wake_on が、利用者の承認で結び付けになる。 */
export type WakeOn = { repo: string; pr: number; when: 'ci_done' | 'ci_failed' | 'review' | 'merged' };

/** Paused の確定の応答に載る、起こす結び付けの結果。message が other_pc のときは、会話がほかの PC で動いている。 */
export type WakeResultDto = { status: 'created' | 'no_admin' | 'failed'; message?: string };

/** 結び付けに当てる、できごとの事実。本文は passBody のときだけ渡す。 */
export type EventFacts = {
  source: 'github' | 'hook';
  event: string;
  repo?: string;
  number?: number;
  title?: string;
  /** 題名を書いた人（PR か issue の作者）。actor は今回の書き込みの人で、別のことがある。題名を渡してよいかは、こちらで決める。 */
  authorLogin?: string;
  outcome?: 'success' | 'failure' | 'cancelled';
  url?: string;
  actor?: string;
  body?: string;
  /** issue か PR の札の名前。結び付けの札の絞り込みに使う。札が無ければ持たない。 */
  labels?: string[];
  receivedAt: number;
};

/** 持てる結び付けの上限。インジェクションされたエージェントが作り続けても、ここで止まる。 */
export const EVENT_BINDINGS_MAX = 50;
/** MCP で出せる下書きの数の上限（全部で）。下書きは EVENT_BINDINGS_MAX に数えない。 */
export const EVENT_DRAFTS_MAX = 10;
/** 1 つの会話が出せる PR の下書きの上限。 */
export const PR_CLAIM_DRAFTS_MAX = 5;
/** 結び付け 1 つが 1 時間に動ける回数。超えたら止めて知らせる。 */
export const EVENT_HOURLY_MAX = 12;
/** Paused を起こす結び付けの寿命。どのできごとも来なくても、これで消す。 */
export const WAKE_BINDING_TTL_MS = 30 * 24 * 60 * 60_000;
