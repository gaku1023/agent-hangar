import fs from 'node:fs';
import type { EventsPageDto, TranscriptEvent } from '@agent-hangar/shared';
import type { ReadOpts } from '../agent/types.ts';
import type { Db } from '../db/open.ts';

type Row = { seq: number; byte_offset: number; byte_length: number; file_path_ref: string };

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/** 本文のファイル 1 つを開いた口。offset から length バイトを読む。 */
export type PageBody = { read(offset: number, length: number): Buffer; close(): void };

/**
 * ファイル型のエージェントごとに差し替える 2 つ。
 * normalize は記録 1 件（JSON）を正規化イベントにし、open は索引の file_path_ref（論理パス）を開く。
 * Codex の圧縮された rollout のように、論理パスの実体が別の形のとき、open がそこを展開して返す。
 */
export type FilePageDeps = {
  normalize(rec: unknown, seq: number, agentId: string | null): TranscriptEvent[];
  open(filePathRef: string): PageBody;
};

/** 論理パスをそのまま fs で開く（Claude）。 */
export function openFsBody(filePathRef: string): PageBody {
  const fd = fs.openSync(filePathRef, 'r');
  return {
    read(offset, length) {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      return buf;
    },
    close() { fs.closeSync(fd); },
  };
}

/**
 * ファイル型の会話の 1 ページを読む。索引のバイト位置から本文を読み直し、正規化イベントを返す（Claude も Codex もこの本体を使う）。
 * DB には本文が無いので、ここで file_path_ref を読み直して deps.normalize に通す。
 * agentId を省略すると主線を読む。
 */
export function readFilePage(db: Db, sessionId: string, opts: ReadOpts, deps: FilePageDeps): EventsPageDto {
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
  // 記録の先頭の seq。1 つの記録から出た行は seq が続いているので、ページの中の 2 つ目からの記録は、ページに入った最初の行が先頭である。
  // ページの最初の記録だけは途中から始まることがあるので、索引を 1 行ずつ遡って確かめる。
  // 記録ごとに byte_offset で min(seq) を引くと、byte_offset は索引に無いので、1 回ごとにそのセッションの全行を見に行く。
  const prevOf = db.prepare("select seq, byte_offset, file_path_ref from event_index where session_id = ? and ifnull(parent_agent, '') = ? and seq < ? order by seq desc limit 1");
  const headOf = (r: Row): number => {
    let head = r.seq;
    for (;;) {
      const p = prevOf.get(sessionId, agentKey, head) as Row | undefined;
      if (!p || p.byte_offset !== r.byte_offset || p.file_path_ref !== r.file_path_ref) return head;
      head = p.seq;
    }
  };
  const events: TranscriptEvent[] = [];
  let body: PageBody | null = null;
  let bodyPath = '';
  try {
    // 同じ記録（同じバイト位置）から出た複数のイベントは 1 回の読み取りで得る。
    let i = 0;
    while (i < wanted.length) {
      const r = wanted[i]!;
      if (body === null || bodyPath !== r.file_path_ref) {
        body?.close();
        body = deps.open(r.file_path_ref);
        bodyPath = r.file_path_ref;
      }
      const buf = body.read(r.byte_offset, r.byte_length);
      let rec: unknown;
      try { rec = JSON.parse(buf.toString('utf8')); } catch { rec = null; }
      let j = i;
      while (j < wanted.length && wanted[j]!.byte_offset === r.byte_offset && wanted[j]!.file_path_ref === r.file_path_ref) j++;
      const firstSeq = i === 0 ? headOf(r) : r.seq;
      const all = rec === null ? [] : deps.normalize(rec, firstSeq, agent);
      const lastSeq = wanted[j - 1]!.seq;
      for (const ev of all) if (ev.seq >= r.seq && ev.seq <= lastSeq) events.push(ev);
      i = j;
    }
  } finally {
    body?.close();
  }
  // 末尾から読んだページに「次の前向きのページ」は無いので、nextSeq は付けない。
  return { sessionId, events, total, nextSeq: !backward && hasMore ? rows[take]!.seq : null };
}
