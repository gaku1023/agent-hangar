import fs from 'node:fs';
import type { EventsPageDto, TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { normalizeRecord } from '../provider/claude-code/normalize.ts';

type Row = { seq: number; byte_offset: number; byte_length: number; file_path_ref: string };

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * セッションに属するサブエージェントの id を、始まった順に返す。
 * 呼び出し側は「Agent の N 番目の呼び出し」と「N 番目の id」を突き合わせるので、名前順ではなく時刻順でなければならない。
 */
export function subagentIds(db: Db, sessionId: string): string[] {
  const rows = db.prepare('select parent_agent a from event_index where session_id = ? and parent_agent is not null group by parent_agent order by min(ts), min(seq)').all(sessionId) as { a: string }[];
  return rows.map((r) => r.a);
}

/**
 * 索引のバイト位置から本文ファイルを読み、正規化イベントを返す。
 * DB には本文が無いので、ここで file_path_ref を読み直して normalizeRecord に通す。
 * agentId を省略すると主線を読む。
 */
export function readEvents(db: Db, sessionId: string, opts: { fromSeq?: number; limit?: number; agentId?: string | null; latest?: boolean; beforeSeq?: number }): EventsPageDto {
  const agent = opts.agentId ?? null;
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const agentKey = agent ?? '';
  const total = (db.prepare("select count(*) c from event_index where session_id = ? and ifnull(parent_agent, '') = ?").get(sessionId, agentKey) as { c: number }).c;
  // 末尾から読む道。索引を 1 回引いて開始の seq を決め、あとは前向きの本体にそのまま渡す。
  // 本文の読み方（バイト位置、記録の途中から始まるページの扱い）は前向きと変わらない。
  const backward = opts.latest === true || opts.beforeSeq !== undefined;
  let fromSeq = opts.fromSeq ?? 0;
  let take = limit;
  if (backward) {
    const before = opts.beforeSeq;
    const tail = (before === undefined
      ? db.prepare("select seq from event_index where session_id = ? and ifnull(parent_agent, '') = ? order by seq desc limit ?").all(sessionId, agentKey, limit)
      : db.prepare("select seq from event_index where session_id = ? and ifnull(parent_agent, '') = ? and seq < ? order by seq desc limit ?").all(sessionId, agentKey, before, limit)) as { seq: number }[];
    if (tail.length === 0) return { sessionId, events: [], total, nextSeq: null };
    fromSeq = tail[tail.length - 1]!.seq;
    take = tail.length;
  }
  // 1 件多めに取って、続きがあるかどうかを判定する。
  const rows = db.prepare("select seq, byte_offset, byte_length, file_path_ref from event_index where session_id = ? and ifnull(parent_agent, '') = ? and seq >= ? order by seq limit ?")
    .all(sessionId, agentKey, fromSeq, take + 1) as Row[];
  const hasMore = rows.length > take;
  const wanted = rows.slice(0, take);
  const firstSeqOf = db.prepare("select min(seq) s from event_index where session_id = ? and ifnull(parent_agent, '') = ? and byte_offset = ? and file_path_ref = ?");
  const events: TranscriptEvent[] = [];
  let fd: number | null = null;
  let fdPath = '';
  try {
    // 同じ記録（同じバイト位置）から出た複数のイベントは 1 回の読み取りで得る。
    let i = 0;
    while (i < wanted.length) {
      const r = wanted[i]!;
      if (fd === null || fdPath !== r.file_path_ref) {
        if (fd !== null) fs.closeSync(fd);
        fd = fs.openSync(r.file_path_ref, 'r');
        fdPath = r.file_path_ref;
      }
      const buf = Buffer.alloc(r.byte_length);
      fs.readSync(fd, buf, 0, r.byte_length, r.byte_offset);
      let rec: unknown;
      try { rec = JSON.parse(buf.toString('utf8')); } catch { rec = null; }
      let j = i;
      while (j < wanted.length && wanted[j]!.byte_offset === r.byte_offset && wanted[j]!.file_path_ref === r.file_path_ref) j++;
      // ページの先頭が記録の途中から始まることがあるので、記録の先頭 seq は索引から引く。
      const firstSeq = (firstSeqOf.get(sessionId, agentKey, r.byte_offset, r.file_path_ref) as { s: number }).s;
      const all = rec === null ? [] : normalizeRecord(rec, firstSeq, agent);
      const lastSeq = wanted[j - 1]!.seq;
      for (const ev of all) if (ev.seq >= r.seq && ev.seq <= lastSeq) events.push(ev);
      i = j;
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  // 末尾から読んだページに「次の前向きのページ」は無いので、nextSeq は付けない。
  return { sessionId, events, total, nextSeq: !backward && hasMore ? rows[take]!.seq : null };
}
