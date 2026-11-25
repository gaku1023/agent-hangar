import fs from 'node:fs';
import { readHeadLine, resolvePhysical } from './logical.ts';
import { decompressZstdHeadLine } from './zstd.ts';

// Codex の子（サブエージェント）の rollout は、親とは別のファイルで、先頭の session_meta.payload に parent_thread_id（親の id）を持つ。
// 子の rollout を一覧の独立した会話にせず、Claude の subagents/agent-*.jsonl と同じく、親の会話のサブエージェントとして索引する。
// そのために、発見の段で先頭の 1 行だけを読んで親を知る。先頭は書き換わらないので、読めたものはパスごとに覚える。

/** 先頭から読む上限（圧縮の入力）。session_meta は base_instructions を含むが、数十 KB に収まる。 */
const HEAD_COMPRESSED_BYTES = 1024 * 1024;
const CACHE_MAX = 5000;
const known = new Map<string, string | null>();

/** 先頭の 1 行を読む。圧縮された本文は、先頭の一部だけを展開する。 */
function headOf(logical: string): string | null {
  const p = resolvePhysical(logical);
  if (!p) return null;
  if (!p.compressed) return readHeadLine(logical);
  const fd = fs.openSync(p.path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_COMPRESSED_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return decompressZstdHeadLine(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/** 先頭の 1 行の JSON から親の id。子でなければ null。 */
export function parentOfHead(head: string): string | null {
  let raw: unknown;
  try { raw = JSON.parse(head); } catch { return null; }
  const p = typeof raw === 'object' && raw !== null ? (raw as { payload?: unknown }).payload : undefined;
  if (typeof p !== 'object' || p === null) return null;
  const { parent_thread_id: parent, id } = p as { parent_thread_id?: unknown; id?: unknown };
  return typeof parent === 'string' && parent !== '' && parent !== id ? parent : null;
}

/**
 * rollout（論理パス）が子なら、親の id。主線なら null。
 * known が偽なのは、先頭がまだ読めないとき（作られた直後で 1 行目が書かれていない）。覚えず、次に読み直す。
 */
export function parentThreadOf(logical: string): { known: boolean; parent: string | null; /** 先頭が読めずに例外になった（壊れた圧縮など）。まだ書かれていないのではなく、読んで error に出す対象。 */ broken?: boolean } {
  if (known.has(logical)) return { known: true, parent: known.get(logical) ?? null };
  let head: string | null = null;
  try { head = headOf(logical); } catch { return { known: false, parent: null, broken: true }; }
  if (head === null || head === '') return { known: false, parent: null, broken: resolvePhysical(logical)?.compressed === true };
  const parent = parentOfHead(head);
  if (known.size >= CACHE_MAX) known.clear();
  known.set(logical, parent);
  return { known: true, parent };
}

/** 先頭の 1 行の JSON から、知らせがその子を指す名前（id、agent_path、agent_nickname。thread_spawn の中も）。 */
export function namesOfHead(head: string): string[] {
  let raw: unknown;
  try { raw = JSON.parse(head); } catch { return []; }
  const p = typeof raw === 'object' && raw !== null ? (raw as { payload?: unknown }).payload : undefined;
  if (typeof p !== 'object' || p === null) return [];
  const o = p as { id?: unknown; agent_path?: unknown; agent_nickname?: unknown; source?: { subagent?: { thread_spawn?: { agent_path?: unknown; agent_nickname?: unknown } } } };
  const spawn = o.source?.subagent?.thread_spawn;
  return [o.id, o.agent_path, o.agent_nickname, spawn?.agent_path, spawn?.agent_nickname].filter((v): v is string => typeof v === 'string' && v !== '');
}

/** rollout（論理パス）の先頭の session_meta から、その子の名前を読む。読めなければ空。 */
export function namesOfRollout(logical: string): string[] {
  try {
    const head = headOf(logical);
    return head === null || head === '' ? [] : namesOfHead(head);
  } catch { return []; }
}
