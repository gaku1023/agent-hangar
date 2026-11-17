import { isTurnPrompt } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readEvents } from '../transcript/read.ts';

/** 遡って見る利用者の入力の行数。出来事の文が続いても、利用者の言葉に届くようにする。 */
const SCAN_ROWS = 60;
/** 本文の頭の印。`[hangar]` は出来事なので捨て、声の印は剥がして利用者の言葉として残す。 */
const HANGAR_MARK = /^\s*\[hangar\]/i;
const VOICE_MARK = /^\s*\[voice(?::[^\]]*)?\]\s*/i;

/**
 * 会話の利用者の入力の末尾から n 個を、古い順に返す（統括の引き継ぎの「利用者の最近の言葉」、orchestrator/handoff.ts）。
 * 主線の利用者の入力のうち、ターンの頭になる文だけを読む（道具の結果と中断の知らせは除く）。hangar の出来事の文も除く。
 */
export function recentUserWords(db: Db, sessionId: string, n: number): string[] {
  const rows = db.prepare("select seq from event_index where session_id = ? and ifnull(parent_agent, '') = '' and kind = 'user' order by seq desc limit ?").all(sessionId, SCAN_ROWS) as { seq: number }[];
  const out: string[] = [];
  for (const r of rows) {
    if (out.length >= n) break;
    const ev = readEvents(db, sessionId, { fromSeq: r.seq, limit: 1 }).events.find((e) => e.seq === r.seq);
    if (!ev || ev.kind !== 'user' || !isTurnPrompt(ev.text) || HANGAR_MARK.test(ev.text)) continue;
    const text = ev.text.replace(VOICE_MARK, '').trim();
    if (text !== '') out.push(text);
  }
  return out.reverse();
}
