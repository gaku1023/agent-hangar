import fs from 'node:fs';
import type { Db } from '../../db/open.ts';
import { splitLines } from '../../provider/claude-code/transcript/lines.ts';
import { DROPPED_LINE_TYPES, normalizeRecord } from '../../provider/claude-code/transcript/normalize.ts';
import { readEvents } from '../../transcript/read.ts';
import type { TailRow } from './items.ts';

/**
 * 本文の読み口。provider ごとに「行の並び」と「行の id」を作る層で、項目の組み立て（items.ts）は共通である。
 * codex と opencode の読み口は、索引（readEvents）の seq から id を `s<seq>` にして、ここと同じ形で足す。
 */
export type TailSource = {
  /** 変わったかを見る鍵。読まずに作れること。会話が無ければ null。 */
  key(sessionId: string): string | null;
  /** 全体（または末尾の上限まで）を、id 付きの行にする。 */
  read(sessionId: string): TailRow[];
};

/** 本文のファイルの手がかり。key が合わないとき（初めて、または変わったとき）だけ read が呼ばれる。 */
export type TranscriptHandle = { key: string; read(): Buffer };

/** 本文のファイルを読む大きさの上限。これより大きいファイルは末尾だけを読み、手前の項目は after からも届かない（truncated になる）。 */
export const PEER_CHAT_TAIL_READ_MAX_BYTES = 16 * 1024 * 1024;

// ---- Claude Code（jsonl + uuid） ----

/**
 * 索引（transcript_files）から、この PC にある本体の jsonl の手がかりを作る。
 * 他の端末から降ろした写し（device_id がある）とサブエージェントのファイル（agent_id がある）は使わない。
 * ファイルが PEER_CHAT_TAIL_READ_MAX_BYTES より大きければ末尾だけを読み、最初の改行までを捨てて行の頭に合わせる。
 * 手がかりを作るときに stat だけをして、中身は読まない。
 * copies を真にすると、他の端末から降ろした写しも使う（見る側の PC が、手元の写しの最後の uuid を知るのに使う）。
 * mtime が新しいものを選ぶ。
 */
export function dbTranscriptReader(db: Db, o: { copies?: boolean } = {}): (sessionId: string) => TranscriptHandle | null {
  const find = db.prepare(`select path from transcript_files where session_id = ? and agent_id is null${o.copies ? "" : " and device_id is null"} and agent = 'claude-code' order by mtime desc limit 1`);
  return (sessionId) => {
    const row = find.get(sessionId) as { path: string } | undefined;
    if (!row) return null;
    try {
      const st = fs.statSync(row.path);
      return { key: `${row.path}|${st.size}|${st.mtimeMs}`, read: () => readTail(row.path) };
    } catch { return null; }
  };
}

function readTail(file: string): Buffer {
  const size = fs.statSync(file).size;
  if (size <= PEER_CHAT_TAIL_READ_MAX_BYTES) return fs.readFileSync(file);
  const start = size - PEER_CHAT_TAIL_READ_MAX_BYTES;
  const buf = Buffer.alloc(PEER_CHAT_TAIL_READ_MAX_BYTES);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const nl = buf.indexOf(10);
  return nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1);
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * jsonl の全体を、行（uuid 付き）の並びにする。
 * 同じ uuid の行は先の 1 行だけを読む（再開で行が写されたときは、先に出たものだけを残す）。
 * 重複は行の中身を見る前に落とすので、再開で写された利用者の行が、開いている道具を閉じることはない。
 * サブエージェント（sidechain）、要約の継続の行、落とす種類の行は読まない。
 */
export function claudeRowsOf(buf: Buffer): TailRow[] {
  const rows: TailRow[] = [];
  const seen = new Set<string>();
  for (const l of splitLines(buf, 0).lines) {
    if (l.text.startsWith('{"type":"api-request')) continue;
    let raw: unknown;
    try { raw = JSON.parse(l.text); } catch { continue; }
    if (!isRec(raw)) continue;
    if (typeof raw.type === 'string' && DROPPED_LINE_TYPES.has(raw.type)) continue;
    if (raw.isSidechain === true || raw.isCompactSummary === true) continue;
    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    if (uuid === null || seen.has(uuid)) continue;
    seen.add(uuid);
    rows.push({ id: uuid, isUserLine: raw.type === 'user', events: normalizeRecord(raw, 0, null) });
  }
  return rows;
}

// ---- codex と opencode（索引 event_index と readEvents） ----

/**
 * 索引から読む本文の事象の数の上限（主線）。
 * Claude の読み口は大きさ（PEER_CHAT_TAIL_READ_MAX_BYTES）で末尾を切るが、索引の側は事象の数で切る。
 * 末尾からこの数だけを読み、手前は読まない（項目の組み立ては全件の走査なので、大きな会話で全部は読まない）。
 * 手前の項目は after からも届かず、after が見つからないときと同じ truncated になる。
 */
export const PEER_CHAT_INDEX_READ_MAX_EVENTS = 20_000;

/** readEvents の 1 ページの大きさ（stored.ts の MAX_LIMIT 以下）。 */
const INDEX_PAGE = 2000;

/**
 * codex と opencode の読み口。本文は索引の読み手（transcript/read.ts の readEvents。Codex は readCodexPage、opencode は readStoredPage）で読む。
 * 行の id は `s<seq>`、1 つの事象が 1 行で、利用者の発言（user）の行だけが isUserLine である。
 * key は主線（parent_agent が空）の `max(seq)|件数` で、SQL 1 本で作る（本文は読まない）。主線の行が無ければ null。
 * 読む範囲は末尾の maxEvents 件。窓の頭の seq は、seq の降順で maxEvents 番目の行から引く（seq に抜けがあっても件数で切れる）。
 * そこから fromSeq でページをたどる。
 */
export function indexTailSource(db: Db, o: { maxEvents?: number } = {}): TailSource {
  const max = o.maxEvents ?? PEER_CHAT_INDEX_READ_MAX_EVENTS;
  const keyOf = db.prepare('select max(seq) m, count(*) c from event_index where session_id = ? and parent_agent is null');
  const startOf = db.prepare('select seq from event_index where session_id = ? and parent_agent is null order by seq desc limit 1 offset ?');
  return {
    key: (sessionId) => {
      const r = keyOf.get(sessionId) as { m: number | null; c: number };
      return r.c === 0 || r.m === null ? null : `${r.m}|${r.c}`;
    },
    read: (sessionId) => {
      const head = startOf.get(sessionId, max - 1) as { seq: number } | undefined;
      let fromSeq: number | null = head?.seq ?? 0;
      const rows: TailRow[] = [];
      while (fromSeq !== null) {
        const page = readEvents(db, sessionId, { fromSeq, limit: INDEX_PAGE });
        for (const ev of page.events) rows.push({ id: `s${ev.seq}`, isUserLine: ev.kind === 'user', events: [ev] });
        fromSeq = page.nextSeq;
      }
      return rows;
    },
  };
}

/**
 * 会話の provider（sessions.provider）で読み口を選ぶ。codex と opencode は index、それ以外は claude。
 * 会話の記録が無ければ claude の道に落とす（今までと同じ）。
 */
export function routedTailSource(db: Db, claude: TailSource, index: TailSource): TailSource {
  const find = db.prepare('select provider from sessions where id = ?');
  const pick = (sessionId: string): TailSource => {
    const p = (find.get(sessionId) as { provider: string } | undefined)?.provider;
    return p === 'codex' || p === 'opencode' ? index : claude;
  };
  return { key: (sessionId) => pick(sessionId).key(sessionId), read: (sessionId) => pick(sessionId).read(sessionId) };
}

/**
 * 手がかりの読み手（dbTranscriptReader など）から、Claude Code の読み口を作る。
 * key は手がかりの key（経路、大きさ、更新時刻）、read は jsonl を行にしたもの。
 */
export function claudeTailSource(readTranscript: (sessionId: string) => TranscriptHandle | null): TailSource {
  return {
    key: (sessionId) => readTranscript(sessionId)?.key ?? null,
    read: (sessionId) => {
      const handle = readTranscript(sessionId);
      return handle ? claudeRowsOf(handle.read()) : [];
    },
  };
}
