import type { Db } from '../db/open.ts';

/**
 * sync_state に置く鍵。端末ごとの同期の進み具合と、止まっている理由を持つ。
 * limitedUntil は、Cloudflare の上限で退いている間の戻る時刻である（sync/engine.ts）。
 * skipped:<R2 の鍵> は RemotePuller が降ろすのを諦めた項目の控えである。
 * filesSkippedFrom は、世代の鍵が無くて開けずに越えた索引の行のうち、いちばん小さい連番である（sync/puller.ts の rewindSkippedFiles が読む）。
 * transcriptsFrom は本文をどこから上げるかの床である（sync/transcriptsFrom.ts）。
 * orphans は、親の行がまだ届かず当てられなかった行の持ち越しである（JSON の配列。sync/engine.ts）。
 * revokedLogged は、この PC が解除されて止まったことをログに残した印である（戻った旨を 1 度だけ残すため。止める印ではない。sync/engine.ts）。
 * peers は、pull の応答で受け取った他の PC の最終接続である（JSON。sync/peers.ts が読み書きする）。
 * rotation は、PC の解除と世代の回しの途中の記録である（JSON の `{ id, newEpoch, step, cloudId }`。sync/rotate.ts）。
 * phoneRevoke は、スマホの解除の途中の記録である（JSON の `{ id, cloudId }`。sync/rotate.ts の revokePhone）。
 * 残っていれば、起動のときに記録の段から続ける。
 * recoveryBoxPending は、リカバリーキーの再発行で名簿を書いた後、recovery 宛ての keybox を置き終えていない印である（sync/recoveryReissue.ts）。
 * cloudId は最後に同期した接続先の印（Worker の `GET /health` が返す `meta.cloud_id`）、rebuiltAt は作り直した時刻（ミリ秒）である（sync/rebuild.ts）。
 */
export type SyncStateKey =
  | 'lastSeq'
  | 'filesSeq'
  | 'filesSkippedFrom'
  | 'rowsSkippedFrom'
  | 'lastPushAt'
  | 'lastPullAt'
  | 'paused'
  | 'lastError'
  | 'snapshotDone'
  | 'transcriptsFrom'
  | 'limitedUntil'
  | 'orphans'
  | 'revokedLogged'
  | 'peers'
  | 'rotation'
  | 'phoneRevoke'
  | 'recoveryBoxPending'
  | 'cloudId'
  | 'rebuiltAt'
  | `skipped:${string}`;

/**
 * sync_state（端末ローカル）の薄い包み。
 * 値は文字列で持ち、真偽は '1' と '0' にする。
 * null を渡すと行を消す。
 */
export class SyncStateStore {
  private readonly getStmt;
  private readonly setStmt;
  private readonly delStmt;

  constructor(db: Db) {
    this.getStmt = db.prepare('select value from sync_state where key = ?');
    this.setStmt = db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value');
    this.delStmt = db.prepare('delete from sync_state where key = ?');
  }

  get(key: SyncStateKey | `yielded:${string}`): string | null {
    const r = this.getStmt.get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  /** 数として読めないときは fallback を返す。手で書き換えた値で同期が壊れないようにする。 */
  getNumber(key: SyncStateKey, fallback: number): number {
    const v = this.get(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  set(key: SyncStateKey | `yielded:${string}`, value: string | number | boolean | null): void {
    if (value === null) { this.delStmt.run(key); return; }
    this.setStmt.run(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }

  /** この PC で再開したセッションを、もとの端末へ譲ったかどうか。 */
  isYielded(sessionUuid: string): boolean { return this.get(`yielded:${sessionUuid}`) === '1'; }

  setYielded(sessionUuid: string, yielded: boolean): void { this.set(`yielded:${sessionUuid}`, yielded ? '1' : null); }
}
