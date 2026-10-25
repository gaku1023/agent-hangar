import { MAX_BLOB_DELETE_KEYS, opencodeBlobKey, TRASH_KEEP_MS, transcriptBlobKey } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { trashedLongAgo } from '../sessions/trash.ts';
import { CloudError, type CloudClient } from './client.ts';
import { transcriptLedgerKey } from './ledgerKey.ts';
import type { RowKeyring } from './sealedClient.ts';

/**
 * ゴミ箱の掃除（PC の側。docs/design.md の「同期対象と暗号化」）。
 *
 * 削除の印から 30 日（TRASH_KEEP_MS）たったセッションの、この PC が上げた本文を `DELETE /blobs` で消す。
 * Worker は中身を読めないので、30 日の判定も鍵名の計算も PC が行う。
 * Worker が消させるのは自分の端末 ID の下（`b/<自分>/`）だけなので、ほかの PC が上げた写しはその PC が自分で消す。
 *
 * 鍵名は世代の `/index` の鍵の HMAC なので、世代を回した後に上げ直した本文は世代ごとに別の鍵名で残っている。
 * 上げた世代は blob_uploads（版 32）に控えてあり、控えた世代ごとに鍵名を求め直す（手元の鍵で当て推量の鍵名を作らない）。
 * 消えたと返った鍵（索引に無かったものを含む）は控えから外し、次の回は Worker に送らない。
 * 断られた鍵（置いてから 1 時間たっていない、1 日の上限からあふれた）は控えに残し、次の回に回す。
 * 1 日の上限を使い切った 429 は、黙ってその回を終える。
 *
 * 1 回の要求は MAX_BLOB_DELETE_KEYS 件まで。消すものが無ければ Worker に何も送らない。
 */

/** 掃除の間隔。同期の巡回のついでに 6 時間に 1 回走らせる（boot/sync.ts）。 */
export const TRASH_SWEEP_EVERY_MS = 6 * 3_600_000;

/** この PC が上げた本文の世代を控える。uploader が PUT の成功の後に呼ぶ。その本文をその世代で上げたのが初めてなら true。 */
export function noteBlobUpload(db: Db, ledgerKey: string, epoch: number): boolean {
  return db.prepare('insert or ignore into blob_uploads (ledger_key, epoch) values (?, ?)').run(ledgerKey, epoch).changes > 0;
}

/** LIKE の型の中で、文字どおりに読ませたい文字を逃がす。 */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const AGENT_RE = /\/subagents\/agent-([^/]+)\.jsonl\.gz$/;

export type TrashSweepResult = { deleted: number; refused: number };

type Target = { blobKey: string; ledgerKey: string; epoch: number };

/** 消す鍵名を求める。主線とサブエージェントの本文の、上げた世代ごとの鍵名。手元に鍵の無い世代は飛ばす。 */
async function targets(db: Db, ring: RowKeyring, deviceId: string, now: number): Promise<Target[]> {
  const out: Target[] = [];
  const pick = db.prepare("select ledger_key ledgerKey, epoch from blob_uploads where ledger_key = ? or ledger_key like ? escape '\\' order by ledger_key, epoch");
  for (const s of trashedLongAgo(db, now - TRASH_KEEP_MS)) {
    let main: string;
    try { main = transcriptLedgerKey(deviceId, s.uuid, null); } catch { continue; }
    const head = main.slice(0, -'.jsonl.gz'.length);
    for (const r of pick.all(main, `${escapeLike(head)}/subagents/%`) as { ledgerKey: string; epoch: number }[]) {
      const keys = ring.at(r.epoch);
      if (!keys) continue;
      const agentId = r.ledgerKey === main ? null : (AGENT_RE.exec(r.ledgerKey)?.[1] ?? null);
      if (r.ledgerKey !== main && agentId === null) continue;
      try {
        out.push({ blobKey: await transcriptBlobKey(keys.index, deviceId, deviceId, s.uuid, agentId), ledgerKey: r.ledgerKey, epoch: r.epoch });
      } catch {
        // 形の違う ID は鍵名にならない。上げる側も同じ検査で断るので、控えにも無いはずである。
      }
    }
  }
  return out;
}

/**
 * ゴミ箱に入って 30 日を過ぎた自分のセッションの本文を、Worker から消す。
 * 投げるのは、Worker に届かない、断られた（429 を除く）ときだけで、それまでに消せた分の控えは外してある。
 */
export async function sweepTrashBlobs(o: {
  db: Db;
  client: Pick<CloudClient, 'deleteBlobs'>;
  keyring: RowKeyring | Promise<RowKeyring>;
  deviceId: string;
  now: number;
}): Promise<TrashSweepResult> {
  if (!o.client.deleteBlobs) return { deleted: 0, refused: 0 };
  return deleteTargets(o, await targets(o.db, await o.keyring, o.deviceId, o.now));
}

/**
 * 台帳の鍵から、本文の鍵名を求めるのに要るセッションの UUID とサブエージェントの ID を取り出す。この PC のものでなければ null。
 * opencode の本文（`opencode/<端末>/<会話>.json.gz`）は opencode の印を付けて返す（鍵名の求め方が違う）。
 */
function idsOfLedgerKey(deviceId: string, ledgerKey: string): { uuid: string; agentId: string | null; opencode?: true } | null {
  const oc = /^opencode\/([^/]+)\/([^/]+)\.json\.gz$/.exec(ledgerKey);
  if (oc) return oc[1] === deviceId ? { uuid: oc[2]!, agentId: null, opencode: true } : null;
  const head = `transcripts/${deviceId}/`;
  if (!ledgerKey.startsWith(head)) return null;
  const rest = ledgerKey.slice(head.length);
  const agent = /^([^/]+)\/subagents\/agent-([^/]+)\.jsonl\.gz$/.exec(rest);
  if (agent) return { uuid: agent[1]!, agentId: agent[2]! };
  const main = /^([^/]+)\.jsonl\.gz$/.exec(rest);
  return main ? { uuid: main[1]!, agentId: null } : null;
}

/**
 * 世代を回した後に上げ直した本文の、古い世代の鍵名を消す（sync/rotate.ts の回しの後始末）。
 *
 * 鍵名は世代の `/index` の鍵の HMAC なので、新しい世代で上げ直すと別の鍵名になり、古い本文が R2 に残る。
 * blob_uploads に同じ本文のより新しい世代があるものだけを消す（新しい世代で PUT できた後なので、本文は失われない）。
 * 書き直していない本文は、古い世代の鍵名のまま残す（R2 の既存のファイルは上げ直さない）。
 *
 * ledgerKey を渡せば、その本文だけを見る（uploader が PUT の直後に呼ぶ）。渡さなければ全部を見る（6 時間ごとの掃除）。
 * 置いてから 1 時間たっていないものは Worker に断られるので、控えに残して次の回に回す。
 */
export async function sweepSupersededBlobs(o: {
  db: Db;
  client: Pick<CloudClient, 'deleteBlobs'>;
  keyring: RowKeyring | Promise<RowKeyring>;
  deviceId: string;
  ledgerKey?: string;
}): Promise<TrashSweepResult> {
  if (!o.client.deleteBlobs) return { deleted: 0, refused: 0 };
  const only = o.ledgerKey === undefined ? '' : ' and b.ledger_key = @key';
  const rows = o.db
    .prepare(`select b.ledger_key ledgerKey, b.epoch from blob_uploads b where b.epoch < (select max(m.epoch) from blob_uploads m where m.ledger_key = b.ledger_key)${only} order by b.ledger_key, b.epoch`)
    .all(o.ledgerKey === undefined ? {} : { key: o.ledgerKey }) as { ledgerKey: string; epoch: number }[];
  if (rows.length === 0) return { deleted: 0, refused: 0 };
  const ring = await o.keyring;
  const all: Target[] = [];
  for (const r of rows) {
    const keys = ring.at(r.epoch);
    const ids = idsOfLedgerKey(o.deviceId, r.ledgerKey);
    if (!keys || !ids) continue;
    try {
      const blobKey = ids.opencode
        ? await opencodeBlobKey(keys.index, o.deviceId, o.deviceId, ids.uuid)
        : await transcriptBlobKey(keys.index, o.deviceId, o.deviceId, ids.uuid, ids.agentId);
      all.push({ blobKey, ledgerKey: r.ledgerKey, epoch: r.epoch });
    } catch {
      // 形の違う ID は鍵名にならない。上げる側も同じ検査で断るので、控えにも無いはずである。
    }
  }
  return deleteTargets(o, all);
}

/**
 * 鍵名を MAX_BLOB_DELETE_KEYS 件ずつ `DELETE /blobs` に渡し、消えたものを控えから外す。
 * 1 日の上限を使い切った 429 は、黙ってその回を終える。ほかの失敗は投げる（それまでに消せた分の控えは外してある）。
 */
async function deleteTargets(o: { db: Db; client: Pick<CloudClient, 'deleteBlobs'> }, all: Target[]): Promise<TrashSweepResult> {
  const result: TrashSweepResult = { deleted: 0, refused: 0 };
  if (!o.client.deleteBlobs) return result;
  const forget = o.db.prepare('delete from blob_uploads where ledger_key = ? and epoch = ?');
  for (let i = 0; i < all.length; i += MAX_BLOB_DELETE_KEYS) {
    const chunk = all.slice(i, i + MAX_BLOB_DELETE_KEYS);
    let r;
    try {
      r = await o.client.deleteBlobs(chunk.map((t) => t.blobKey));
    } catch (e) {
      // 1 日の上限を使い切った。残りは次の回（翌日）に回す。
      if (e instanceof CloudError && e.status === 429) return result;
      throw e;
    }
    const gone = new Set(r.deleted);
    o.db.transaction(() => {
      for (const t of chunk) if (gone.has(t.blobKey)) forget.run(t.ledgerKey, t.epoch);
    })();
    result.deleted += r.deleted.length;
    result.refused += r.refused.length;
  }
  return result;
}
