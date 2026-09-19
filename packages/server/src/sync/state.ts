import type { Db } from '../db/open.ts';

/**
 * sync_state に置く鍵。端末ごとの同期の進み具合と、止まっている理由を持つ。
 * quota:<yyyy-MM-dd> は QuotaCounter が日ごとの呼び出し回数を数えるのに使う。
 * skipped:<R2 の鍵> は RemotePuller が降ろすのを諦めた項目の控えである。
 */
export type SyncStateKey =
  | 'lastSeq'
  | 'filesSeq'
  | 'lastPushAt'
  | 'lastPullAt'
  | 'paused'
  | 'lastError'
  | 'configPullConfirmed'
  | 'snapshotDone'
  | `quota:${string}`
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
