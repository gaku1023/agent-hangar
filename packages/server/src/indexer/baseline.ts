import path from 'node:path';
import type { SessionSummaryDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { EDIT_TOOLS } from './indexFile.ts';

export type BaselineInput = {
  aiTitle: string | null; name: string | null; firstPrompt: string | null; lastPrompt: string | null;
  files: string[]; turns: number; startedAt: number | null; lastActivityAt: number | null; running: boolean;
};

export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '1 分未満';
  if (min < 60) return `${min} 分`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 時間 ${min % 60} 分`;
  return `${Math.floor(hours / 24)} 日`;
}

const head = (s: string | null, n: number): string | null => (s ? [...s].slice(0, n).join('') : null);

/** インデクサが持つ事実だけから機械的に作る要約。モデルは使わない。 */
export function buildBaselineSummary(input: BaselineInput): Omit<SessionSummaryDto, 'updatedAt'> {
  const title = input.aiTitle ?? input.name ?? head(input.firstPrompt, 40) ?? '題名のないセッション';
  const oneLiner = head(input.firstPrompt, 80) ?? '発言のないセッション';
  const lines: string[] = [];
  if (input.firstPrompt) lines.push(`最初の依頼：${head(input.firstPrompt, 200)}`);
  if (input.lastPrompt && input.lastPrompt !== input.firstPrompt) lines.push(`最後の依頼：${head(input.lastPrompt, 200)}`);
  const names = input.files.map((f) => path.basename(f));
  lines.push(names.length === 0 ? '触ったファイル：なし' : `触ったファイル：${names.slice(0, 5).join(', ')}${names.length > 5 ? ` ほか ${names.length - 5} 件` : ''}`);
  const duration = input.startedAt !== null && input.lastActivityAt !== null ? formatDuration(input.lastActivityAt - input.startedAt) : '期間不明';
  lines.push(`${input.turns} ターン、${duration}`);
  return { title, oneLiner, body: lines.join('\n'), state: input.running ? 'in_progress' : 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: input.turns };
}

/**
 * baseline 以外の要約が既にあれば何もしない。
 * 中身が前と同じときも書かない。書いたら true を返す。
 */
export function writeBaselineIfNeeded(db: Db, sessionId: string, deviceId: string, running: boolean): boolean {
  const existing = db.prepare('select * from session_summaries where session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (existing && existing.source !== 'baseline') return false;
  const s = db.prepare('select ai_title, name, first_prompt, started_at, last_activity_at from sessions where id = ?').get(sessionId) as { ai_title: string | null; name: string | null; first_prompt: string | null; started_at: number | null; last_activity_at: number | null } | undefined;
  if (!s) return false;
  const st = db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(sessionId) as { turns: number; last_prompt: string | null } | undefined;
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const files = (db.prepare(`select distinct file_path f from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null order by seq`).all(sessionId, ...EDIT_TOOLS) as { f: string }[]).map((r) => r.f);
  const sum = buildBaselineSummary({ aiTitle: s.ai_title, name: s.name, firstPrompt: s.first_prompt, lastPrompt: st?.last_prompt ?? null, files, turns: st?.turns ?? 0, startedAt: s.started_at, lastActivityAt: s.last_activity_at, running });
  const row: Record<string, unknown> = { session_id: sessionId, title: sum.title, one_liner: sum.oneLiner, body: sum.body, state: sum.state, next_steps: JSON.stringify(sum.nextSteps), source: sum.source, source_id: null, source_model: null, based_on_turns: sum.basedOnTurns };
  // 走査のたびに同じ要約を書き直すと changes が増えるので、列がすべて同じなら書かない。
  if (existing && existing.deleted_at === null && Object.entries(row).every(([k, v]) => existing[k] === v)) return false;
  upsertShared(db, 'session_summaries', row, deviceId, 'session_id');
  return true;
}
