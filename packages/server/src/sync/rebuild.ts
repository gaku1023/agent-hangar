import fs from 'node:fs';
import path from 'node:path';
import { isSafeKeyId, SHARED_TABLES, TABLE_PK } from '@agent-hangar/shared';
import { remoteRoot } from '../config/cloud.ts';
import type { Db } from '../db/open.ts';
import { ledgerKeyOfPath } from './ledgerKey.ts';
import type { SyncStateStore } from './state.ts';

/**
 * 作り直しの 3 つの道（設計書「作り直しの手順」）。
 *
 * 新しいクラウドへ移ると、手元の記録は前のクラウドのものしか残っていない。
 * 台帳（file_sync）は「上げ済み」と言い、区切り（lastSeq、filesSeq）は前のクラウドの連番を指し、送り済みの行は二度と送らない。
 * そのままでは、新しいクラウドには作り直した後に動いたものしか届かない。
 * 接続先の印（cloudId）が前と違えば、ここで記録を戻して全部を送り直す。
 */

/**
 * remote/ の写しを上げ直す印の、台帳（file_sync）の kind。
 * 本文の台帳（kind が transcript）を引く問い合わせ（引き継ぎ、再開の写し、削除）に混ざらないよう、別の kind にする。
 * sha256 が空の行はまだ上げていない写しで、uploader の走査が拾う。
 */
export const RELAY_KIND = 'remote_copy';

/**
 * 作り直しから写しを上げ始めるまでの日数（ミリ秒）。
 * 元の PC が新しいクラウドに参加し直せば、自分の本文を自分で上げる。
 * 各 PC が他の PC の写しをすぐに上げると、同じ本文が PC の台数の 2 乗の数だけ上がる。
 * そこで、元の PC が参加し直す時間を待ち、待っても名簿に居ない PC の写しだけを上げる（sync/uploader.ts の sweepRelays）。
 */
export const RELAY_HOLD_MS = 3 * 86_400_000;

/** remote/ の写しの台帳の鍵。降ろした写しの鍵（transcripts/<元の PC>/...）と重ならないよう、頭に relay: を付ける。 */
export function relayLedgerKey(origin: string, rel: string): string | null {
  const k = ledgerKeyOfPath(origin, rel);
  return k === null ? null : `relay:${k}`;
}

/**
 * 写しの相対パス（projects/ の下）から、セッションの ID とサブエージェントの ID を取り出す。形が違えば null。
 * 主線は projects/<フォルダ>/<uuid>.jsonl、サブエージェントは projects/<フォルダ>/<uuid>/subagents/agent-<id>.jsonl である。
 */
export function relayTargetOf(rel: string): { sessionId: string; agentId: string | null } | null {
  const parts = rel.split('/');
  if (parts[0] !== 'projects' || parts.includes('..') || parts.includes('.') || parts.some((p) => p === '')) return null;
  if (parts.length === 3) {
    const m = /^(.+)\.jsonl$/.exec(parts[2]!);
    return m && isSafeKeyId(m[1]!) ? { sessionId: m[1]!, agentId: null } : null;
  }
  if (parts.length === 5 && parts[3] === 'subagents') {
    const m = /^agent-(.+)\.jsonl$/.exec(parts[4]!);
    return m && isSafeKeyId(parts[2]!) && isSafeKeyId(m[1]!) ? { sessionId: parts[2]!, agentId: m[1]! } : null;
  }
  return null;
}

/** remote/<元の PC>/projects の下の写しを、相対パス（projects/...）で並べる。リンクは辿らない。 */
function listRemoteCopies(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(r);
    }
  };
  walk(path.join(dir, 'projects'), 'projects');
  return out.sort();
}

/** 共有テーブルの全行を、まだ送っていない差分として changes に積み直す。消した行は delete で積む。 */
function requeueSharedRows(db: Db, deviceId: string): number {
  // 送っていない差分は、行の今の中身で積み直すので捨てる。同じ行を 2 度送らない。
  db.prepare('delete from changes where pushed_at is null').run();
  const insert = db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)');
  let n = 0;
  // 親の表から順に積む。changes は連番の順に送るので、受け手は親を先に受け取る。
  for (const table of SHARED_TABLES) {
    const pk = TABLE_PK[table];
    const rows = db.prepare(`select * from ${table} order by ${pk}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const op = row.deleted_at !== null && row.deleted_at !== undefined ? 'delete' : 'upsert';
      const updatedAt = typeof row.updated_at === 'number' ? row.updated_at : 0;
      const origin = typeof row.origin_device === 'string' ? row.origin_device : deviceId;
      insert.run(table, String(row[pk]), op, JSON.stringify(row), updatedAt, origin);
      n++;
    }
  }
  return n;
}

/** remote/ にある他の PC の写しを、上げ直す対象として台帳に置く。自分の ID の下の写しは原本が ~/.claude にあるので置かない。 */
function queueRemoteCopies(db: Db, home: string, deviceId: string): number {
  const root = remoteRoot(home);
  let origins: fs.Dirent[];
  try { origins = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  const insert = db.prepare('insert or ignore into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)');
  let n = 0;
  for (const o of origins) {
    if (!o.isDirectory() || o.name === deviceId || !isSafeKeyId(o.name)) continue;
    for (const rel of listRemoteCopies(path.join(root, o.name))) {
      const key = relayLedgerKey(o.name, rel);
      if (key === null || relayTargetOf(rel) === null) continue;
      insert.run(key, RELAY_KIND, rel, o.name, '', 0, 0, null, 0);
      n++;
    }
  }
  return n;
}

/**
 * 接続先の印（cloudId）が前と違えば、新しいクラウドへ全部を送り直す支度をする。
 *
 * 1. この PC が上げた本文の台帳（file_sync の自分の行）と、諦めた控え（sync_state の skipped:）を消す。走査が全部の本文を積み直す。
 * 2. 区切り（lastSeq、filesSeq、snapshotDone と、飛ばした行の控え）を戻す。新しいクラウドの写しと索引を頭から読む。
 * 3. 共有テーブルの全行を changes に積み直す。前のクラウドへ送り済みの行も、他の PC が書いた行も送る。
 * 4. remote/ にある他の PC の写しを、元の PC の ID を origin にして、自分の device_id の下へ上げる対象に置く。元の PC がもう無くても、本文が新しいクラウドに残る。
 *    上げるのは作り直しから RELAY_HOLD_MS が過ぎ、元の PC が新しいクラウドの名簿に居ないときだけである（sync/uploader.ts）。
 * 5. 新しい cloudId と、作り直した時刻（rebuiltAt、写しの保留の起点）を書く。
 *
 * 他の PC から降ろした写しの台帳（file_sync の他の PC の行）は残す。新しいクラウドに同じ本文が上がっても、指紋が同じなので降ろし直さない。
 * 上げた世代の控え（blob_uploads）は前のクラウドの鍵名なので空にする。
 * 前に cloudId を書いていない（0.9.0 より前から同期していた PC と、初めて参加した PC）ときも、作り直しとみなす。
 * 初めて参加した PC では、送る行が増えるだけで食い違いは生まれない。
 * health.cloudId が空なら何もしない（新しい Worker なら必ず返すので、読めなかったときに記録を捨てない）。
 */
export function rebuildIfCloudChanged(o: { db: Db; state: SyncStateStore; health: { cloudId: string }; home: string; deviceId: string; now?: number }): { rebuilt: boolean } {
  const next = o.health.cloudId;
  if (typeof next !== 'string' || next === '') return { rebuilt: false };
  if (o.state.get('cloudId') === next) return { rebuilt: false };
  o.db.transaction(() => {
    o.db.prepare("delete from file_sync where (kind = 'transcript' and device_id = ?) or kind = ?").run(o.deviceId, RELAY_KIND);
    o.db.prepare("delete from sync_state where key like 'skipped:%'").run();
    o.db.prepare('delete from blob_uploads').run();
    for (const k of ['lastSeq', 'filesSeq', 'snapshotDone', 'rowsSkippedFrom', 'filesSkippedFrom'] as const) o.state.set(k, null);
    requeueSharedRows(o.db, o.deviceId);
    queueRemoteCopies(o.db, o.home, o.deviceId);
    o.state.set('rebuiltAt', o.now ?? Date.now());
    o.state.set('cloudId', next);
  })();
  return { rebuilt: true };
}
