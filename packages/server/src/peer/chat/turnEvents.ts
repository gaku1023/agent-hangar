import { PEER_CHAT_CARD_CALLS_MAX, type TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { readEvents } from '../../transcript/read.ts';

/**
 * 現在の札の材料に載せる、今のターンの主線の行を索引から読む（PeerChatHostDeps.turnEvents）。
 * 頭の発言と、直近 PEER_CHAT_CARD_CALLS_MAX 回の呼び出しから後ろだけを読み、それより前の手の数は dropped に数える。
 * 長いポーリングが 1 秒ごとに呼ぶので、主線の最後の seq が変わらない間は前の結果を使い回す。
 */
export function turnEventsReader(db: Db): (sessionId: string, fromSeq: number | null) => { events: TranscriptEvent[]; dropped: number } {
  const last = db.prepare("select max(seq) m from event_index where session_id = ? and ifnull(parent_agent, '') = ''");
  const calls = db.prepare("select seq from event_index where session_id = ? and ifnull(parent_agent, '') = '' and kind = 'tool_call' and seq >= ? order by seq desc limit ?");
  const total = db.prepare("select count(*) c from event_index where session_id = ? and ifnull(parent_agent, '') = '' and kind = 'tool_call' and seq >= ?");
  const memo = new Map<string, { key: string; value: { events: TranscriptEvent[]; dropped: number } }>();
  return (sessionId, fromSeq) => {
    if (fromSeq === null) return { events: [], dropped: 0 };
    const key = `${fromSeq}:${(last.get(sessionId) as { m: number | null }).m ?? ''}`;
    const hit = memo.get(sessionId);
    if (hit && hit.key === key) return hit.value;
    const recent = (calls.all(sessionId, fromSeq, PEER_CHAT_CARD_CALLS_MAX) as { seq: number }[]).map((r) => r.seq);
    const dropped = Math.max(0, (total.get(sessionId, fromSeq) as { c: number }).c - recent.length);
    const events: TranscriptEvent[] = [];
    const head = readEvents(db, sessionId, { fromSeq, limit: 1 }).events.find((e) => e.seq === fromSeq);
    if (head) events.push(head);
    let seq: number | null = recent.length > 0 ? Math.min(...recent) : null;
    while (seq !== null) {
      const p = readEvents(db, sessionId, { fromSeq: seq, limit: 2000 });
      events.push(...p.events.filter((e) => e.seq !== fromSeq));
      seq = p.nextSeq;
    }
    const value = { events, dropped };
    memo.set(sessionId, { key, value });
    if (memo.size > 32) memo.delete(memo.keys().next().value!);
    return value;
  };
}
