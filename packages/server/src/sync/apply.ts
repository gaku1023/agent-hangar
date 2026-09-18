import fs from 'node:fs';
import path from 'node:path';
import { SHARED_TABLES, TABLE_PK, type ChangeOut, type SharedTable } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { safeDeviceLabel, timestampLabel } from './copy.ts';

/** 親から子の順。pull の適用はこの順に並べ替える。 */
export const SHARED_APPLY_ORDER: readonly SharedTable[] = SHARED_TABLES;
const ORDER = new Map<string, number>(SHARED_APPLY_ORDER.map((t, i) => [t, i]));

/**
 * 他端末の新しい版に負けた、手元のメモの本文。呼び手がファイルとして隣に残す。
 * `deviceName` は devices の表示名そのままである（トーストに出す用）。
 * **パスに混ぜるときは必ず `writeMemoConflictCopy` を通すこと。**
 * 参加の入口は名前に空白と `.` と日本語を通すので、そのままファイル名にすると扱いにくい名前になる。
 */
export type MemoConflict = { projectId: string; markdown: string; deviceName: string };

/** 同じ秒に作る写しの上限。ここまで当たるのは異常なので、無限に回さずに投げる。 */
const MAX_CONFLICT_COPIES = 100;

/**
 * 負けたメモの本文を、そのプロジェクトのメモの隣に残す。書けた写しのパスを返す。
 *
 * 名前は `memo.conflict-<畳んだ端末名>-<yyyyMMdd-HHmmss>.md` である。
 * 端末名は `safeDeviceLabel` で畳む。畳んだ名前は元と 1 対 1 ではない
 * （「さとうの Mac」と「たなかの Mac」はどちらも `Mac` になる）ので、同じ名前に当たりうる。
 * そのときは `-2`、`-3` と連番を足す。
 *
 * 書き出しは `wx`（無ければ作る、あれば失敗）で開く。
 * `existsSync` で見てから書くと、その隙に割り込まれて写しが写しを潰す。
 * 負けた方を残すのがこの仕組みの目的なので、既にあるファイルは決して上書きしない。
 *
 * 書けなければ投げる。呼び手（`onMemoConflict`）がそのまま投げ返せば、その行は適用されない。
 */
export function writeMemoConflictCopy(memoFile: string, o: MemoConflict, now = Date.now()): string {
  const dir = path.dirname(memoFile);
  fs.mkdirSync(dir, { recursive: true });
  const base = `memo.conflict-${safeDeviceLabel(o.deviceName)}-${timestampLabel(now)}`;
  for (let i = 1; ; i++) {
    const file = path.join(dir, i === 1 ? `${base}.md` : `${base}-${i}.md`);
    try {
      fs.writeFileSync(file, o.markdown, { flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= MAX_CONFLICT_COPIES) throw e;
    }
  }
}

export type ApplyOptions = {
  ownDeviceId: string;
  skipOwn: boolean;
  /** project_memos を上書きする前に呼ばれる。投げたらその行は適用しない（手元の本文を消さない）。 */
  onMemoConflict?: (o: MemoConflict) => void;
};

const colCache = new WeakMap<Db, Map<string, Set<string>>>();
function tableColumns(db: Db, table: SharedTable): Set<string> {
  let m = colCache.get(db);
  if (!m) { m = new Map(); colCache.set(db, m); }
  let s = m.get(table);
  if (!s) { s = new Set((db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name)); m.set(table, s); }
  return s;
}

/** SQLite に渡せる値に揃える。真偽は 0 と 1、オブジェクトは JSON、undefined は null。 */
const bindable = (v: unknown): unknown => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

/** 端末 ID から表示名を引く。まだ devices の行が届いていなければ ID をそのまま使う。 */
function deviceName(db: Db, id: string): string {
  const r = db.prepare('select name from devices where id = ?').get(id) as { name?: unknown } | undefined;
  return r && typeof r.name === 'string' && r.name.length > 0 ? r.name : id;
}

/**
 * project_memos を上書きする前に、負ける手元の本文を呼び手へ渡す。
 * 渡せたら true、渡す途中で失敗したら false（呼び手は上書きを見送る）。
 *
 * メモは利用者が手で書いた文章なので、控えを残せないまま消してはいけない。
 * 行の採り方（updated_at の新しい方）そのものは変えない。
 */
function noteMemoConflict(db: Db, c: ChangeOut, row: Record<string, unknown>, o: ApplyOptions): boolean {
  if (c.tableName !== 'project_memos' || !o.onMemoConflict) return true;
  const local = db.prepare('select markdown, origin_device from project_memos where project_id = ?').get(c.rowId) as { markdown?: unknown; origin_device?: unknown } | undefined;
  if (!local || typeof local.markdown !== 'string' || local.markdown.length === 0) return true;
  if (typeof row.markdown !== 'string' || row.markdown === local.markdown) return true;
  const author = typeof local.origin_device === 'string' && local.origin_device.length > 0 ? local.origin_device : o.ownDeviceId;
  try {
    o.onMemoConflict({ projectId: c.rowId, markdown: local.markdown, deviceName: deviceName(db, author) });
    return true;
  } catch (e) {
    // 控えが残せないなら上書きしない。次にどちらかがメモを書けば LWW で揃い直す。
    console.error('[sync] メモの控えを残せなかったので上書きを見送りました', c.rowId, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * pull で受けた 1 行を適用する。updated_at の新しい方を採り、changes には追記しない。
 * payload はローカルの列だけに絞るので、相手の版が新しくて列が多くても壊れない。
 */
export function applyRemoteChange(db: Db, c: ChangeOut, o: ApplyOptions): 'applied' | 'skipped' {
  if (!ORDER.has(c.tableName)) return 'skipped';
  if (o.skipOwn && c.deviceId === o.ownDeviceId) return 'skipped';
  const pk = TABLE_PK[c.tableName];
  const cols = tableColumns(db, c.tableName);
  const cur = db.prepare(`select updated_at from ${c.tableName} where ${pk} = ?`).get(c.rowId) as { updated_at: number } | undefined;
  if (cur && cur.updated_at >= c.updatedAt) return 'skipped';
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.payload)) if (cols.has(k)) row[k] = v;
  row[pk] = c.rowId;
  row.updated_at = c.updatedAt;
  // upsertShared は conflict で渡された列しか書かないので、適用の側で deleted_at を必ず書いて生き返らせる。
  if (c.op === 'upsert' && row.deleted_at === undefined) row.deleted_at = null;
  if (c.op === 'delete' && (row.deleted_at === undefined || row.deleted_at === null)) row.deleted_at = c.updatedAt;
  if (typeof row.origin_device !== 'string') row.origin_device = c.deviceId;
  // project_roots は (project_id, device_id) が一意で deleted_at を除いていない。
  // 別の id で同じ組が届いたら、updated_at の新しい方を残して古い行を物理削除する。
  if (c.tableName === 'project_roots' && typeof row.project_id === 'string' && typeof row.device_id === 'string') {
    const dup = db.prepare('select id, updated_at from project_roots where project_id = ? and device_id = ? and id <> ?').get(row.project_id, row.device_id, c.rowId) as { id: string; updated_at: number } | undefined;
    if (dup) {
      if (dup.updated_at >= c.updatedAt) return 'skipped';
      db.prepare('delete from project_roots where id = ?').run(dup.id);
    }
  }
  if (!noteMemoConflict(db, c, row, o)) return 'skipped';
  const keys = Object.keys(row);
  const sets = keys.filter((k) => k !== pk).map((k) => `${k} = excluded.${k}`).join(', ');
  db.prepare(`insert into ${c.tableName} (${keys.join(', ')}) values (${keys.map(() => '?').join(', ')}) on conflict(${pk}) do update set ${sets}`).run(...keys.map((k) => bindable(row[k])));
  return 'applied';
}

/**
 * 1 トランザクションで親から子の順に適用する。失敗した行は最後に 1 度だけ再試行する。
 *
 * 外部キーは遅延させない（`defer_foreign_keys` を立てない）。
 * 遅延させると違反が commit のときに出るので、1 行の親不明でそのページ全体が巻き戻ってしまう。
 * 即時に検査すれば、親がどこにも無い行だけを飛ばして残りは残せる。
 * SHARED_APPLY_ORDER は親を先に並べてあるので、同じバッチの中の親子は順番で解ける。
 */
export function applyRemoteBatch(db: Db, changes: ChangeOut[], o: ApplyOptions): ChangeOut[] {
  const sorted = [...changes].sort((a, b) => (ORDER.get(a.tableName) ?? 99) - (ORDER.get(b.tableName) ?? 99) || a.seq - b.seq);
  const applied: ChangeOut[] = [];
  const run = db.transaction(() => {
    const failed: ChangeOut[] = [];
    for (const c of sorted) {
      try { if (applyRemoteChange(db, c, o) === 'applied') applied.push(c); } catch { failed.push(c); }
    }
    for (const c of failed) {
      try { if (applyRemoteChange(db, c, o) === 'applied') applied.push(c); } catch (e) { console.error('[sync] apply failed', c.tableName, c.rowId, e instanceof Error ? e.message : e); }
    }
  });
  run();
  return applied;
}
