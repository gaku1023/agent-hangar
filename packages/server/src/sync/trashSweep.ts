import { MAX_BLOB_DELETE_KEYS, TRASH_KEEP_MS, transcriptBlobKey } from '@agent-hangar/shared';
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

/** この PC が上げた本文の世代を控える。uploader が PUT の成功の後に呼ぶ。 */
export function noteBlobUpload(db: Db, ledgerKey: string, epoch: number): void {
  db.prepare('insert or ignore into blob_uploads (ledger_key, epoch) values (?, ?)').run(ledgerKey, epoch);
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
  const result: TrashSweepResult = { deleted: 0, refused: 0 };
  if (!o.client.deleteBlobs) return result;
  const all = await targets(o.db, await o.keyring, o.deviceId, o.now);
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
