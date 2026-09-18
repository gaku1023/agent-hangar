import type { TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readEvents } from '../transcript/read.ts';
import type { SummaryInput } from './types.ts';

export type CompressOptions = { userMax?: number; assistantMax?: number; totalMax?: number };

const cut = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n).join('') : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * 利用者の発言は 2,000 字、アシスタントの本文は 600 字、ツール呼び出しは要約の 1 行。
 * 全体が上限を超えたら先頭と末尾の 3 割ずつを残し、中盤を省略の 1 行に置き換える。
 */
export function compressEvents(events: TranscriptEvent[], opts: CompressOptions = {}): string {
  const userMax = opts.userMax ?? 2000;
  const assistantMax = opts.assistantMax ?? 600;
  const totalMax = opts.totalMax ?? 12000;
  const items: string[] = [];
  for (const e of events) {
    if (e.kind === 'user' && e.text.trim()) items.push(`[user] ${cut(oneLine(e.text), userMax)}`);
    else if (e.kind === 'assistant' && e.text.trim()) items.push(`[assistant] ${cut(oneLine(e.text), assistantMax)}`);
    else if (e.kind === 'tool_call') items.push(`[tool] ${cut(oneLine(e.summary), 200)}`);
  }
  let text = items.join('\n');
  if (text.length <= totalMax) return text;
  let head = Math.floor(items.length * 0.3);
  let tail = Math.floor(items.length * 0.3);
  // 3 割ずつでも収まらないときは、収まるまで両端を狭める。
  for (;;) {
    const kept = [...items.slice(0, head), `[... ${items.length - head - tail} 件を省略 ...]`, ...items.slice(items.length - tail)];
    text = kept.join('\n');
    if (text.length <= totalMax || (head <= 1 && tail <= 1)) break;
    if (head >= tail) head--; else tail--;
  }
  return text.length <= totalMax ? text : text.slice(0, totalMax);
}

/** 主線の全イベントを読み、圧縮した本文と付帯情報にする。本文が無ければ null。 */
export function buildSummaryInput(db: Db, sessionId: string, running: boolean): SummaryInput | null {
  const s = db.prepare('select ai_title, name from sessions where id = ? and deleted_at is null').get(sessionId) as { ai_title: string | null; name: string | null } | undefined;
  if (!s) return null;
  const total = (db.prepare('select count(*) c from event_index where session_id = ? and parent_agent is null').get(sessionId) as { c: number }).c;
  if (total === 0) return null;
  const events: TranscriptEvent[] = [];
  let from: number | null = 0;
  while (from !== null) {
    const page = readEvents(db, sessionId, { fromSeq: from, limit: 2000, agentId: null });
    events.push(...page.events);
    from = page.nextSeq;
  }
  const turns = (db.prepare('select turns from session_stats where session_id = ?').get(sessionId) as { turns: number } | undefined)?.turns ?? 0;
  const body = compressEvents(events);
  const text = running ? `このセッションは現在も実行中です。\n${body}` : body;
  return { sessionId, text, turns, running, titleHint: s.ai_title ?? s.name };
}

/** 「要約器を試す」に使う決め打ちの入力。DB には書かない。 */
export const CANNED_INPUT: SummaryInput = {
  sessionId: 'canned', turns: 3, running: false, titleHint: null,
  text: [
    '[user] README の導入手順が古いので、Node 22 と npm workspaces 前提に書き直して。',
    '[assistant] 現状の README を読み、setup 節と開発の節を書き直します。',
    '[tool] Read README.md',
    '[tool] Edit README.md',
    '[assistant] 導入手順を Node 22、npm ci、npm run dev の 3 手順にし、pnpm の記述を消しました。CI の節も同じ前提に揃えました。',
    '[user] ありがとう。CONTRIBUTING.md も同じ前提で直しておいて。',
    '[tool] Edit CONTRIBUTING.md',
    '[assistant] CONTRIBUTING.md の開発環境の節を直しました。他に古い記述は見つかりませんでした。',
  ].join('\n'),
};
