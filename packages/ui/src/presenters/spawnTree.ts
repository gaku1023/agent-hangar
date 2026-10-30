import type { LiveStatus, StopReason } from '@agent-hangar/shared';

/**
 * MCP の create_session で起こしたセッションを、起動元の下に入れ子で並べるための道具（サイドバーの実行中と一覧が使う）。
 * 起動元は SessionDto.spawnedBy で、古いサーバは返さないので undefined は null と読む。
 */

/** 起動元ごとの開閉を覚える鍵。サイドバーのグループの畳み（state.sidebarFolded）に同居させるので、プロジェクトの id とぶつからない前置きを付ける。 */
export const spawnFoldKey = (id: string): string => `spawn:${id}`;

/** 畳んだ起動元の行に並べる、子孫ごとの小さな状態の丸。 */
export type NestDot = { live: LiveStatus | null; aside: boolean; reason: StopReason | null };

/** 起動元。自分自身を指すものと、無いものは null。 */
export function spawnParentOf(sessions: Record<string, { spawnedBy?: string | null } | undefined>, id: string): string | null {
  const p = sessions[id]?.spawnedBy;
  return typeof p === 'string' && p !== '' && p !== id && sessions[p] !== undefined ? p : null;
}

/**
 * ids を深さ優先の入れ子の並びにする。起動元が ids の中に無いものは根（深さ 0）で、兄弟は ids の順を保つ。
 * 起動元をたどって輪になるものは、先に出てきた方を根として切る。深さに上限は無い。
 */
export function nestOrder(ids: string[], parentOf: (id: string) => string | null): { id: string; depth: number }[] {
  const set = new Set(ids);
  const kids = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const id of ids) {
    const p = parentOf(id);
    if (p === null || p === id || !set.has(p)) continue;
    hasParent.add(id);
    kids.set(p, [...kids.get(p) ?? [], id]);
  }
  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, depth });
    for (const k of kids.get(id) ?? []) walk(k, depth + 1);
  };
  for (const id of ids) if (!hasParent.has(id)) walk(id, 0);
  for (const id of ids) walk(id, 0);
  return out;
}

/** nestOrder の並びで、i 番目の行の子孫（直後の、より深い行）の添字の範囲の終わり（含まない）。 */
export function descendantsEnd(order: { depth: number }[], i: number): number {
  let j = i + 1;
  while (j < order.length && order[j]!.depth > order[i]!.depth) j++;
  return j;
}
