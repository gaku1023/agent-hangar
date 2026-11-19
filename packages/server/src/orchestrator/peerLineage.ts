import { parseDeviceStatus } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';

/**
 * ほかの PC が宿主になった統括の系譜（docs/design.md「統括」の、ほかの PC への伝え方）。
 * 統括の設定は PC ごとで同期しないので、宿主は自分の devices の行の様子（status の orchestrator_ids）に系譜を載せる（config/deviceStatus.ts）。
 * ここはそれを読み、手元の系譜と合わせて、一覧の DTO の role（db/queries.ts の setOrchestratorSource）と MCP の orchestrator の印に渡す。
 *
 * 一覧を組むたびに会話の数だけ呼ばれるので、DB は devices の行が変わったときだけ読み直す。
 * 覚えは DB ごとに持ち、devices の行の変化（書き込みも同期で降りた行も）で捨てる。
 */
type Memo = { selfId: string; ids: ReadonlySet<string> };
const memos = new WeakMap<Db, Memo>();
/** devices の行が変わるたびに増える数。手元の系譜と合わせた覚え（orchestratorIdsSource）が、読み直すかを決めるのに使う。 */
const versions = new WeakMap<Db, number>();

onRowChange((c) => {
  if (c.table !== 'devices') return;
  memos.delete(c.db);
  versions.set(c.db, (versions.get(c.db) ?? 0) + 1);
});

/** devices の行の様子から、統括の系譜の id を集める。自分の行は見ない（手元の設定のほうが新しい）。解除した PC の行も見る（前の統括の会話をずっと隠すため）。 */
function readPeerIds(db: Db, selfId: string): ReadonlySet<string> {
  const rows = db.prepare('select status from devices where id <> ? and status is not null').all(selfId) as { status: string }[];
  const ids = new Set<string>();
  for (const r of rows) for (const id of parseDeviceStatus(r.status)?.orchestrator_ids ?? []) ids.add(id);
  return ids;
}

/** ほかの PC の devices の行に載った統括の系譜の id。 */
export function peerOrchestratorIds(db: Db, selfId: string): () => ReadonlySet<string> {
  return () => {
    const m = memos.get(db);
    if (m && m.selfId === selfId) return m.ids;
    const ids = readPeerIds(db, selfId);
    memos.set(db, { selfId, ids });
    return ids;
  };
}

/**
 * 手元の系譜（local）とほかの PC の系譜を合わせた id の並び。手元の分を先に、重なりなしで返す。
 * 手元の系譜と devices の行が変わらない間は、同じ配列を返す（一覧を組むたびに作り直さない）。
 */
export function orchestratorIdsSource(db: Db, selfId: string, local: () => readonly string[]): () => readonly string[] {
  const peers = peerOrchestratorIds(db, selfId);
  let memo: { key: string; version: number; ids: readonly string[] } | null = null;
  return () => {
    const mine = local();
    const key = mine.join('\u0000');
    const version = versions.get(db) ?? 0;
    if (memo && memo.key === key && memo.version === version) return memo.ids;
    const ids = [...new Set([...mine, ...peers()])];
    memo = { key, version, ids };
    return ids;
  };
}
