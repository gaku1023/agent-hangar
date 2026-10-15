import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SHARED_TABLES, TABLE_PK, type ChangeOut, type SharedTable } from '@agent-hangar/shared';
import { backupsRoot } from '../config/cloud.ts';
import { hangarHome } from '../config/paths.ts';
import { MIGRATED_NOTE_AT } from '../db/migrations.ts';
import { noteApplied } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { alignSessionProject } from '../sessions/move.ts';
import { alignSessionTrash, trashedAtOf } from '../sessions/trash.ts';
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
  return writeWithoutClobbering(dir, `memo.conflict-${safeDeviceLabel(o.deviceName)}-${timestampLabel(now)}`, o.markdown);
}

/**
 * `<dir>/<base>.md` に書く。既にあれば `-2`、`-3` と連番を足す。
 * `wx`（無ければ作る、あれば失敗）で開くので、`existsSync` の後の隙に割り込まれない。
 */
function writeWithoutClobbering(dir: string, base: string, body: string, mode?: number): string {
  for (let i = 1; ; i++) {
    const file = path.join(dir, i === 1 ? `${base}.md` : `${base}-${i}.md`);
    try {
      fs.writeFileSync(file, body, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= MAX_CONFLICT_COPIES) throw e;
    }
  }
}

/** 他端末が寄こした ID の形。ファイル名に混ぜる前に見る。 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 他端末が寄こした ID を、ファイル名に混ぜられる形にする。
 * 想定どおりの形ならそのまま使い、そうでなければ指紋に倒す。
 * `../` を含む ID をそのまま名前にすると、控えが入れ物の外へ出る。
 */
const safeId = (id: string): string => (SAFE_ID_RE.test(id) ? id : `id-${crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)}`);

/**
 * セッションの名前の控えを残したあとの知らせ。ファイルはもう書けているので、トーストに使うだけである。
 * markdown は控えに書いた本文である（「名前：<負けた名前>」の 1 行）。
 * 名前が Memo なのは、ノート（memo）の控えも取っていた頃の名残である。ノートは 0.4.0 で外した。
 */
export type SessionMemoBackup = { sessionId: string; markdown: string; deviceName: string; backupFile: string };

export type ApplyOptions = {
  ownDeviceId: string;
  skipOwn: boolean;
  /** project_memos を上書きする前に呼ばれる。投げたらその行は適用しない（手元の本文を消さない）。 */
  onMemoConflict?: (o: MemoConflict) => void;
  /**
   * session_notes の控えを残した後に呼ばれる。
   * 控えはもうファイルになっているので、ここで投げても適用は止めない（トーストのための口である）。
   */
  onSessionMemoBackup?: (o: SessionMemoBackup) => void;
  /**
   * 束の中でやり直しても当てられなかった行（親の行がまだ無く、外部キーで落ちた行など）を受け取る。
   * 渡すと、その行は記録に出さずに呼び手へ任せる。同期エンジンはこれで行を持ち越し、後で当て直す。
   * 省くと、今までどおり記録に出して捨てる。
   */
  onFailed?: (c: ChangeOut, e: unknown) => void;
  /**
   * 古い形の sessions の payload が名前を持っていたときに呼ばれる。
   * 渡すと、その場では session_notes の行を作らず、呼び手へ任せる。
   * 同期エンジンは、1 巡を読み切ってから `adoptNoteFromOldSession` を呼ぶ。
   * 写しでは session_notes の行が sessions より後に当たるので、その場で作ると、すぐ後に届く本物の行がそれを上書きして、要らない控えが残る。
   * 省くと、その場で作る。
   */
  onOldSessionNote?: (c: ChangeOut) => void;
  /**
   * 控えの置き場の親（hangar の home に当たるもの）。
   * 省くと `hangarHome()` に落ちるが、**呼び手は必ず明に渡すこと。**
   * 環境変数に頼ると、一時置き場で起こしたサーバやテストが実物の home に書いてしまう。
   */
  home?: string;
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

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * セッションの名前（session_notes）が他端末の新しい版に負けるとき、負けた名前を控えの入れ物に残す。
 * 残せたら true、残せなかったら false（呼び手は上書きを見送る）。
 *
 * 控えを取るのは、手元の名前に中身があり、降りてきた行でそれが別の中身になる（または消える）ときだけである。
 * 中身が同じ、手元が空、手元の行が無い（または消してある）ときは取らない。
 * 降りてきた行が古い版の PC のもので memo を持っていても、見るのは名前だけである（ノートは 0.4.0 で外した）。
 * 名前を sessions から分けたので、索引の書き直しが原因の上書きはもう無い。
 * ここへ来るのは、2 台が本当に別々に書いたときである（2 台が同期の収束する前に版 17 へ上がり、写しの中身が違ったときを含む）。
 *
 * 置き場と形は、名前とノートが sessions の列だった頃と同じである。
 * `<home>/backups/memos/session-<セッション ID>-<時刻>.md` に残し、他端末の会話の断片が入るので、入れ物は 0700、控えは 0600 にする。
 * 本文は「名前：<名前>」の 1 行である。
 */
function backupSessionNote(db: Db, c: ChangeOut, row: Record<string, unknown>, o: ApplyOptions): boolean {
  if (c.tableName !== 'session_notes') return true;
  const local = db.prepare('select name, origin_device, deleted_at from session_notes where session_id = ?').get(c.rowId) as { name?: unknown; origin_device?: unknown; deleted_at?: unknown } | undefined;
  if (!local || local.deleted_at != null) return true;
  // payload に列が無ければ、その列は上書きされない（do update set に載らない）。消す変更は、行ごと見えなくなる。
  const loses = filled(local.name) && (c.op === 'delete' || (Object.prototype.hasOwnProperty.call(row, 'name') && row.name !== local.name));
  if (!loses) return true;
  const body = `名前：${local.name as string}\n`;
  const author = typeof local.origin_device === 'string' && local.origin_device.length > 0 ? local.origin_device : o.ownDeviceId;
  let file: string;
  try {
    const dir = path.join(backupsRoot(o.home ?? hangarHome()), 'memos');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    file = writeWithoutClobbering(dir, `session-${safeId(c.rowId)}-${timestampLabel(Date.now())}`, body, 0o600);
  } catch (e) {
    console.error('[sync] セッションの名前の控えを残せなかったので上書きを見送りました', safeId(c.rowId), e instanceof Error ? e.message : e);
    return false;
  }
  // 控えはもうファイルになっている。知らせが失敗しても上書きは止めない。
  try {
    o.onSessionMemoBackup?.({ sessionId: c.rowId, markdown: body, deviceName: deviceName(db, author), backupFile: file });
  } catch (e) {
    console.error('[sync] セッションの名前の控えを知らせられませんでした', safeId(c.rowId), e instanceof Error ? e.message : e);
  }
  return true;
}

/**
 * 写し同士がぶつかったか。手元の行も降りてきた行も、版 17 が sessions から写した名前（時刻が MIGRATED_NOTE_AT）で、中身が違うとき。
 * 古い版の PC の写しが持つ memo は見ない（ノートは 0.4.0 で外した）。
 *
 * このときだけは、同じ時刻でも降りてきた側を採る。「同じ時刻なら手元を残す」だと、2 台が別々の中身を持ったまま食い違う。
 * 降りてきた側を採れば、どの PC も同じ結果に収束する。
 * クラウド（Worker）は同じ時刻の行を先に着いた方で残すので、クラウドにあるのは、先に上がった PC の写し 1 つである。
 * 後から上がったどの PC も、それを受けて自分の写しを置き換える。先に上がった PC には、ほかの PC の写しは降りてこない。
 * `origin_device` の辞書順のように手元で比べる決め方にしないのは、手元が勝った PC の写しをクラウドが採らず、相手に届かないからである。
 * 負けた手元の中身は、控えに残る（backupSessionNote）。
 */
function copiesCollide(db: Db, c: ChangeOut, localUpdatedAt: number): boolean {
  if (c.tableName !== 'session_notes' || c.updatedAt !== MIGRATED_NOTE_AT || localUpdatedAt !== MIGRATED_NOTE_AT) return false;
  const local = db.prepare('select name, deleted_at from session_notes where session_id = ?').get(c.rowId) as { name: unknown; deleted_at: unknown };
  if ((c.op === 'delete') !== (local.deleted_at != null)) return true;
  return Object.prototype.hasOwnProperty.call(c.payload, 'name') && (c.payload.name ?? null) !== (local.name ?? null);
}

/**
 * クラウドに残る古い形の sessions の payload（版 16 までの端末が上げたもの）から、名前を拾う。
 *
 * 古い形の payload は `name` と `memo` を列として持つ。手元の sessions にその列はもう無いので、行としては捨てる。
 * ただ、書いた PC がまだ上がっていなければ、その名前はクラウドのどこにも session_notes の行として無い。
 * 捨てるだけだと、新しく参加した PC には、書いた PC が上がるまで名前が見えない。
 * そこで、手元にそのセッションの session_notes の行が無いときに限り、その名前で行を作る。
 * `memo`（ノート）は拾わない。ノートは 0.4.0 で外した。
 *
 * - 時刻は写しの定数（MIGRATED_NOTE_AT）、書き手は payload の書き手にする。本物の書き込みが届けば、必ずそちらが勝つ。
 * - 手元に行があれば（消した行も含めて）何もしない。手元の方が、古い形の payload より確かである。
 *   同じ 1 巡で本物の session_notes の行が届くこともあるので、同期エンジンは 1 巡を読み切ってからここを呼ぶ（ApplyOptions.onOldSessionNote）。
 * 作ったら true を返す。
 * - changes には積まない（こちらからは上げ直さない）。
 *   上げると、書いた PC より先にクラウドへ着き、写し同士の決着（先に上がった側が勝つ）で、書いた PC の写しに勝ってしまう。
 *   書いた PC は、クラウドへまだ上げていなかった新しい名前を持っていることがある。それを、クラウドに残っていた古い中身で負かさない。
 *   書いた PC が上がれば、その写しが届いて、ここで作った行を置き換える。
 */
export function adoptNoteFromOldSession(db: Db, c: ChangeOut): boolean {
  if (!carriesOldNote(c)) return false;
  const name = c.payload.name as string;
  if (db.prepare('select 1 from session_notes where session_id = ?').get(c.rowId)) return false;
  // セッションの行が、その後に消えていることがある（持ち越している間に）。親が無ければ作らない。
  if (!db.prepare('select 1 from sessions where id = ?').get(c.rowId)) return false;
  const origin = typeof c.payload.origin_device === 'string' && c.payload.origin_device.length > 0 ? c.payload.origin_device : c.deviceId;
  db.prepare('insert into session_notes (session_id, name, updated_at, deleted_at, origin_device) values (?,?,?,?,?)').run(c.rowId, name, MIGRATED_NOTE_AT, null, origin);
  return true;
}

/** 古い形の sessions の payload で、名前に中身があるか。 */
function carriesOldNote(c: ChangeOut): boolean {
  return c.tableName === 'sessions' && c.op === 'upsert' && filled(c.payload.name);
}

/**
 * pull で受けた 1 行を適用する。updated_at の新しい方を採り、changes には追記しない。同じ時刻なら手元を残す。
 * ただし session_notes の写し同士（copiesCollide）だけは、同じ時刻でも降りてきた側を採る。
 * payload はローカルの列だけに絞るので、相手の版が新しくて列が多くても壊れない。
 * クラウドに残る古い形の sessions の payload（name と memo を含む）も、列としてはここで捨てる。
 * 名前は session_notes の行として別に運ばれるので、sessions の行が降りても上書きされない。
 * 古い形の payload の名前は、手元に session_notes の行が無いときだけ拾う（adoptNoteFromOldSession）。memo は拾わない。
 */
export function applyRemoteChange(db: Db, c: ChangeOut, o: ApplyOptions): 'applied' | 'skipped' {
  if (!ORDER.has(c.tableName)) return 'skipped';
  if (o.skipOwn && c.deviceId === o.ownDeviceId) return 'skipped';
  const pk = TABLE_PK[c.tableName];
  const cols = tableColumns(db, c.tableName);
  const cur = db.prepare(`select updated_at from ${c.tableName} where ${pk} = ?`).get(c.rowId) as { updated_at: number } | undefined;
  if (cur && cur.updated_at >= c.updatedAt && !copiesCollide(db, c, cur.updated_at)) return 'skipped';
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
  if (!backupSessionNote(db, c, row, o)) return 'skipped';
  // 削除の印（版 25）の移り変わりを見るため、当てる前の印を控える。印が外れたら、ほかの PC での復元である。
  const trashCols = (c.tableName === 'sessions' || c.tableName === 'session_states') && tableColumns(db, 'session_states').has('trashed_at');
  const prevTrash = trashCols && c.tableName === 'session_states' ? trashedAtOf(db, c.rowId) : null;
  const reraiseTrash = c.op === 'upsert' && c.tableName === 'session_states' && trashCols && mergeTrash(db, c.rowId, row, prevTrash);
  const keys = Object.keys(row);
  const sets = keys.filter((k) => k !== pk).map((k) => `${k} = excluded.${k}`).join(', ');
  db.prepare(`insert into ${c.tableName} (${keys.join(', ')}) values (${keys.map(() => '?').join(', ')}) on conflict(${pk}) do update set ${sets}`).run(...keys.map((k) => bindable(row[k])));
  // 利用者が移したセッションは、届いた行が古い所属を持っていても、移した先に合わせ直す（sessions/move.ts）。
  // 移した印（session_states）が後から届いたときも、その時点で合わせる。どちらも手元の表だけを直し、押し返さない。
  // 版 25 より古い DB（試験）には当てない。session_states に移した先の列が無いからである。
  if (c.op === 'upsert' && (c.tableName === 'sessions' || c.tableName === 'session_states') && tableColumns(db, 'session_states').has('project_id')) alignSessionProject(db, c.rowId);
  // 削除したセッション（sessions/trash.ts）は、古い sessions の upsert が届いても論理削除のまま保つ。印が外れたら論理削除を外す。
  // 手元の表だけを直し、押し返さない。印はどの PC にも届くので、それぞれが自分で合わせる。
  if (trashCols) alignSessionTrash(db, c.rowId, prevTrash);
  // 保った印と外した印は、届いた行より新しい時刻で上げ直し、クラウドとほかの PC もそろえる。
  // 上げ直した行を受け取った PC は、同じ合わせ方で同じ印になるので、そのまま取り込み、上げ返さない。往復はここで止まる。
  if (reraiseTrash) {
    const merged = db.prepare('select * from session_states where session_id = ?').get(c.rowId) as Record<string, unknown>;
    upsertShared(db, 'session_states', merged, o.ownDeviceId, 'session_id', Math.max(Date.now(), c.updatedAt + 1));
  }
  if (carriesOldNote(c)) {
    if (o.onOldSessionNote) o.onOldSessionNote(c);
    else adoptNoteFromOldSession(db, c);
  }
  return 'applied';
}

/**
 * 届いた session_states の行の削除の印を、手元の行と合わせる（docs/design.md の「セッションの削除」の「生き返らない」）。
 * row を書き換え、印が届いた行のものと変わったら true を返す。呼び手はそのとき合わせた行を上げ直す。
 *
 * 印は明示の復元でしか外れず、外れた印は古い行で付き直らない。
 * - restored_at は、手元と届いた行の大きい方にする。復元の事実を、後から届く古い行で消さない。
 * - 届いた行に印が無ければ、手元の印を保つ。印を受け取る前のほかの PC が同じ行を書く（自動の Done、状態の変更）と、印の無い行が後勝ちで届くからである。
 *   版 24 以下の PC の行は印の列を持たないので、これも印の無い行として扱う。
 * - 印が restored_at 以下なら外す。戻したことをまだ受け取っていない PC が、戻す前の印を持つ行を新しい時刻で上げる（印の上げ直し、状態の変更）からである。
 */
function mergeTrash(db: Db, sessionId: string, row: Record<string, unknown>, prevTrash: number | null): boolean {
  const hasRestored = tableColumns(db, 'session_states').has('restored_at');
  const local = hasRestored ? db.prepare('select restored_at from session_states where session_id = ?').get(sessionId) as { restored_at: number | null } | undefined : undefined;
  const incomingTrash = typeof row.trashed_at === 'number' ? row.trashed_at : null;
  const restoredValues = [local?.restored_at, row.restored_at].filter((v): v is number => typeof v === 'number');
  const restored = restoredValues.length > 0 ? Math.max(...restoredValues) : null;
  let trash = incomingTrash ?? prevTrash;
  if (trash !== null && restored !== null && trash <= restored) trash = null;
  // 届いた行に列が無く、手元にも値が無ければ、列を足さない（手元の列をそのまま残す）。
  if (trash !== null || 'trashed_at' in row) row.trashed_at = trash;
  if (hasRestored && (restored !== null || 'restored_at' in row)) row.restored_at = restored;
  return trash !== incomingTrash;
}

/**
 * 1 トランザクションで親から子の順に適用する。失敗した行は最後に 1 度だけ再試行する。
 * 当てた行は、確定の後に行の変化の口へ知らせる。
 *
 * 外部キーは遅延させない（`defer_foreign_keys` を立てない）。
 * 遅延させると違反が commit のときに出るので、1 行の親不明でそのページ全体が巻き戻ってしまう。
 * 即時に検査すれば、親がどこにも無い行だけを飛ばして残りは残せる。
 * SHARED_APPLY_ORDER は親を先に並べてあるので、同じバッチの中の親子は順番で解ける。
 * 親が別の束（写しの後の頁、差分の後の頁）にある行は、ここでは当てられない。`onFailed` で呼び手へ渡す。
 */
export function applyRemoteBatch(db: Db, changes: ChangeOut[], o: ApplyOptions): ChangeOut[] {
  const sorted = [...changes].sort((a, b) => (ORDER.get(a.tableName) ?? 99) - (ORDER.get(b.tableName) ?? 99) || a.seq - b.seq);
  const applied: ChangeOut[] = [];
  const stillFailed: [ChangeOut, unknown][] = [];
  const run = db.transaction(() => {
    const failed: ChangeOut[] = [];
    for (const c of sorted) {
      try { if (applyRemoteChange(db, c, o) === 'applied') applied.push(c); } catch { failed.push(c); }
    }
    for (const c of failed) {
      try { if (applyRemoteChange(db, c, o) === 'applied') applied.push(c); } catch (e) { stillFailed.push([c, e]); }
    }
  });
  run();
  // 当てられなかった行は、確定の後に渡す。巻き戻ったときに、持ち越しだけが残らないようにする。
  for (const [c, e] of stillFailed) {
    if (o.onFailed) o.onFailed(c, e);
    else console.error('[sync] apply failed', c.tableName, c.rowId, e instanceof Error ? e.message : e);
  }
  // 当てた行を、行の変化の口（db/notify.ts）へ知らせる。画面へ配るのは events/publisher.ts である。
  // 出どころは apply なので、同期の push のデバウンスはこれを拾わない（降りた行を push し返さない）。
  // 確定の後に知らせる。確定に失敗すれば run() が投げるので、ここには来ない。
  for (const c of applied) noteApplied(db, c.tableName, c.rowId, c.op);
  return applied;
}
