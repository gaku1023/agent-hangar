import { SCHEDULE_PROMPT_MAX, type EventSource, type GithubWhen, type WakeOn } from '@agent-hangar/shared';
import { MessageError, msg } from '../i18n/message.ts';

/**
 * 結び付けの入力の検査。HTTP の道（routes/events.ts）と MCP の道具（mcp/eventTools.ts）と状態の保存（sessions/states.ts）が共有する。
 * 誤りは MessageError にして、何も書かない。
 */

/** owner/name の形の repo。 */
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const GITHUB_WHEN: readonly GithubWhen[] = ['ci_done', 'ci_failed', 'review', 'comment', 'merged', 'issue_opened'];
export const WAKE_WHEN: readonly WakeOn['when'][] = ['ci_done', 'ci_failed', 'review', 'merged'];

const bad = (): MessageError => new MessageError(msg('schedules.event.error.invalid'));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPr = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).map((x) => x.trim()).filter(Boolean) : null);

/** Paused を起こす条件。形が違えば断る。 */
export function parseWakeOn(v: unknown): WakeOn {
  if (!isObj(v)) throw bad();
  const { repo, pr, when } = v;
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || !isPr(pr) || !WAKE_WHEN.includes(when as WakeOn['when'])) throw bad();
  return { repo, pr, when: when as WakeOn['when'] };
}

/** 保存してある条件を読む。壊れていれば null（無いものとして読む）。 */
export function readWakeOn(json: string | null): WakeOn | null {
  if (!json) return null;
  try {
    return parseWakeOn(JSON.parse(json));
  } catch {
    return null;
  }
}

/** できごとの元。GitHub は repo と条件を 1 つ以上、外の webhook は kind だけ。 */
export function parseSource(v: unknown): EventSource {
  if (!isObj(v)) throw bad();
  if (v.kind === 'hook') return { kind: 'hook' };
  if (v.kind !== 'github') throw bad();
  if (typeof v.repo !== 'string' || !REPO_RE.test(v.repo)) throw bad();
  if (!Array.isArray(v.when) || v.when.length === 0 || v.when.some((w) => !GITHUB_WHEN.includes(w as GithubWhen))) throw bad();
  const when = [...new Set(v.when as GithubWhen[])];
  if (v.pr !== undefined && !isPr(v.pr)) throw bad();
  const labels = v.labels === undefined ? undefined : strList(v.labels);
  if (labels === null) throw bad();
  return { kind: 'github', repo: v.repo, when, ...(v.pr !== undefined ? { pr: v.pr as number } : {}), ...(labels && labels.length > 0 ? { labels } : {}) };
}

/** 指示の検査。予定と同じ文で断る。 */
export function parsePrompt(v: unknown): string {
  const p = typeof v === 'string' ? v : '';
  if (!p.trim()) throw new MessageError(msg('schedules.error.promptRequired'));
  if (p.length > SCHEDULE_PROMPT_MAX) throw new MessageError(msg('schedules.error.promptTooLong', { max: SCHEDULE_PROMPT_MAX }));
  return p;
}

export function parseAllowAuthors(v: unknown): string[] {
  if (v === undefined) return [];
  const l = strList(v);
  if (l === null) throw bad();
  return l;
}

export function parsePassBody(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw bad();
  return v;
}
