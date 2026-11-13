import type { ConfigApplyOrderItemDto, ConfigHistoryDto, ConfigHistoryItemDto } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { otherRefLabelTarget, parseItemId } from './ids.ts';

/**
 * 設定の同期の適用の履歴（config_history、版 57）。適用 1 回に 1 行で、手元だけに持つ。
 * 書くのは runApplyAll（applyAll.ts）が成功したときと、サーバが hangar の好みだけを自動で書いたとき。
 * 読むのは ConfigSyncService の dto（新しい順に 20 件、自動で入って未読の数）。
 */

export type HistorySource = { mode: 'auto' | 'manual'; fromDevice?: string | null };

const LIMIT = 20;

/** 指示書に見せる名前を持たない項目の名前。サーバは resolved の label を渡すので、ここは CLI の手での適用の分。 */
export function labelOfId(id: string): string {
  const p = parseItemId(id);
  if (!p) return id;
  const ref = p.ref;
  if (ref.type === 'file') return ref.rel;
  if (ref.type === 'settings') return ref.key;
  if (ref.type === 'memory') return `${ref.projectId}/${ref.rel}`;
  return otherRefLabelTarget(ref).label;
}

export function historyItemsOf(items: readonly ConfigApplyOrderItemDto[], labels?: ReadonlyMap<string, string>): ConfigHistoryItemDto[] {
  return items.map((i) => ({ id: i.id, kind: i.kind, label: labels?.get(i.id) ?? labelOfId(i.id), op: i.op }));
}

/** 項目の元の端末。元が 1 つなら、その端末。 */
export function fromDeviceOf(items: readonly ConfigApplyOrderItemDto[]): string | null {
  const ids = new Set(items.map((i) => i.fromDeviceId));
  return ids.size === 1 ? [...ids][0]! : null;
}

/** 1 行を書く。自動の適用だけ未読で始める。 */
export function recordHistory(db: Db, o: { at: number; source: HistorySource; items: ConfigHistoryItemDto[]; generations: { target: string; name: string }[]; fromDevice: string | null }): void {
  if (o.items.length === 0) return;
  db.prepare('insert into config_history (at, from_device, mode, items, generations, undone, seen) values (?, ?, ?, ?, ?, ?, ?)')
    .run(o.at, o.source.fromDevice ?? o.fromDevice, o.source.mode, JSON.stringify(o.items), JSON.stringify(o.generations), '[]', o.source.mode === 'auto' ? 0 : 1);
}

type Row = { id: number; at: number; from_device: string | null; mode: 'auto' | 'manual'; items: string; generations: string; undone: string; seen: number };

const parse = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };

/** 新しい順に 20 件。端末の名前は devices から引き、無ければ null。 */
export function listHistory(db: Db, nameOf: (id: string) => string | null): ConfigHistoryDto[] {
  const rows = db.prepare('select * from config_history order by at desc, id desc limit ?').all(LIMIT) as Row[];
  return rows.map((r) => ({
    id: r.id, at: r.at, mode: r.mode,
    fromDeviceId: r.from_device, fromDevice: r.from_device === null ? null : nameOf(r.from_device),
    items: parse<ConfigHistoryItemDto[]>(r.items, []),
    generations: parse<{ target: string; name: string }[]>(r.generations, []),
    undone: parse<string[]>(r.undone, []),
    seen: r.seen === 1,
  }));
}

export function autoUnseenCount(db: Db): number {
  return (db.prepare("select count(*) n from config_history where mode = 'auto' and seen = 0").get() as { n: number }).n;
}

/** 全部を既読にする。変えたら true。 */
export function markHistorySeen(db: Db): boolean {
  return db.prepare('update config_history set seen = 1 where seen = 0').run().changes > 0;
}
