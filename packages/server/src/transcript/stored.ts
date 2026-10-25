import type { EventsPageDto, TranscriptEvent } from '@agent-hangar/shared';
import type { ReadOpts } from '../agent/types.ts';
import type { Db } from '../db/open.ts';
import { stmt } from '../indexer/statements.ts';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * 本文を DB に持つエージェント（opencode）の会話の 1 ページを読む。
 * 本文は索引の書き手（indexer/write.ts）が agent_events に 1 行 1 イベントで写してあるので、ファイルは読まない。
 * ページの切り方（fromSeq と limit、末尾から読む latest と beforeSeq、続きの nextSeq）は Claude の読み手（provider/claude-code/transcript/page.ts）と同じにする。
 * agentId を省略すると主線を読む。
 */
export function readStoredPage(db: Db, sessionId: string, opts: ReadOpts): EventsPageDto {
  const agentKey = opts.agentId ?? '';
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const total = (stmt(db, 'select count(*) c from agent_events where session_id = ? and agent_key = ?').get(sessionId, agentKey) as { c: number }).c;
  const backward = opts.latest === true || opts.beforeSeq !== undefined;
  if (backward) {
    // 末尾から読む道。新しい方から limit 件を取り、古い順に並べ直す。「次の前向きのページ」は無いので nextSeq は付けない。
    const rows = (opts.beforeSeq === undefined
      ? stmt(db, 'select body from agent_events where session_id = ? and agent_key = ? order by seq desc limit ?').all(sessionId, agentKey, limit)
      : stmt(db, 'select body from agent_events where session_id = ? and agent_key = ? and seq < ? order by seq desc limit ?').all(sessionId, agentKey, opts.beforeSeq, limit)) as { body: string }[];
    return { sessionId, events: rows.reverse().flatMap(eventOf), total, nextSeq: null };
  }
  // 1 件多めに取って、続きがあるかどうかを判定する。
  const rows = stmt(db, 'select seq, body from agent_events where session_id = ? and agent_key = ? and seq >= ? order by seq limit ?')
    .all(sessionId, agentKey, opts.fromSeq ?? 0, limit + 1) as { seq: number; body: string }[];
  const hasMore = rows.length > limit;
  return { sessionId, events: rows.slice(0, limit).flatMap(eventOf), total, nextSeq: hasMore ? rows[limit]!.seq : null };
}

/** 1 行の本文を読む。読めない行は飛ばす（書き手が JSON で書くので、ふつうは起きない）。 */
function eventOf(r: { body: string }): TranscriptEvent[] {
  try {
    return [JSON.parse(r.body) as TranscriptEvent];
  } catch {
    return [];
  }
}
