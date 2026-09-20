import type { SyncStateKey, SyncStateStore } from './state.ts';

/** Cloudflare の無料枠。Workers の要求と D1 の書き込みが、どちらも 1 日 10 万である。 */
export type QuotaLimits = { d1Writes: number; requests: number };
export const QUOTA_LIMITS: QuotaLimits = { d1Writes: 100_000, requests: 100_000 };

/** この割合に達したら同期を止める。利用者の決定（課金される形にしない）に沿った余白である。 */
export const QUOTA_STOP_RATIO = 0.8;

export type QuotaDay = { rows: number; requests: number };

/**
 * その日の数えの中身である。
 *
 * `rows` はこの端末が自分の要求から見積もった行数、`account` は Worker が返した
 * 「その日にこの箱が D1 へ書いた行数」（アカウント全体）である。
 * `accountAt` はその報告を受け取った時点の `rows` で、報告の後に自分で書いた分を足し直すのに使う。
 */
type QuotaRecord = QuotaDay & { account?: number; accountAt?: number };

/**
 * 無料枠が数えているのは「文の数」ではなく `rows_written`、つまり **索引への書き込みを含む行数**である。
 * 1 文が進める行数は「本体の 1 行 + その文が触れた索引ごとに 1 行」になる。
 * 根拠は `packages/cloud/src/schema.ts` の索引の数で、`quota.test.ts` がスキーマを読んで縛っている。
 *
 * Task 25 の実測（2 台を 1 日）でも、この勘定で `rows_written_24h` の 369 がそのまま再現する。
 * 採られた行 74 と devices を触る要求 73 で、74 * 4 + 73 = 369 である。
 */

/**
 * `changes` への insert 1 行ぶんである。
 * 本体の 1 行と、`changes_device`（`device_id, seq`）の索引で 1 行である。
 * `seq` は `integer primary key` なので rowid そのもので、索引は増えない。
 */
export const D1_WRITES_PER_CHANGE_ROW = 2;

/**
 * 鏡（`rows`）の upsert 1 行ぶんである。
 * 本体の 1 行と、`k text primary key` に SQLite が自分で張る索引で 1 行である。
 * 既にある行を更新するだけなら索引は動かないが、見分けが付かないので入れた方（多い方）で数える。
 */
export const D1_WRITES_PER_MIRROR_ROW = 2;

/**
 * Worker が push の 1 行を受けるたびに D1 へ書く行数である。
 *
 * `packages/cloud/src/changes.ts` は、採った 1 行ごとに `changes` への insert と鏡（`rows`）の upsert を
 * 必ず 2 文積む（240 行から 243 行）。
 * その 2 文が、索引も入れて 4 行を進める。
 */
export const D1_WRITES_PER_CHANGE = D1_WRITES_PER_CHANGE_ROW + D1_WRITES_PER_MIRROR_ROW;

/**
 * 1 要求につき `devices` を 1 行更新する経路ぶんである。
 *
 * `POST /changes` は末尾で `last_seen_at` を書き（245 行）、
 * `GET /changes` も `last_seen_at` と `last_pulled_seq` を書く（270 行）。
 * どちらの列も主キーでも unique でもないので、索引は動かず 1 行のままである。
 * `GET /rows` は読むだけなので 0 である。
 */
export const D1_WRITES_PER_DEVICE_TOUCH = 1;

/**
 * push 1 回で D1 に書かれる行数。
 *
 * 数えるのは Worker が採った行（`accepted`）だけである。
 * 同着で弾かれた行（`skipped`）は 1 行も書かれないので、送った行数で数えると多く見積もる。
 * `accepted` が読めない応答のときだけ、送った行数で代用する。
 */
export function pushD1Writes(accepted: unknown, sent: number): number {
  const a = typeof accepted === 'number' && Number.isFinite(accepted) && accepted >= 0 ? Math.floor(accepted) : sent;
  return a * D1_WRITES_PER_CHANGE + D1_WRITES_PER_DEVICE_TOUCH;
}

/**
 * 無料枠で止めた日を覚える sync_state の鍵である。
 *
 * `SyncStateKey` の `quota:${string}` の枠に収まる形にしてある。
 * 日ごとの数えの鍵は `quota:<yyyy-MM-dd>` なので、この鍵とぶつかることはない。
 * メモリに置くと、立て直した直後に同じ日の 80% の判定をもう一度通って止め直せてしまう。
 */
export const QUOTA_PAUSED_DAY_KEY = 'quota:pausedDay' as const;

/**
 * その日の数えを置く sync_state の鍵。
 * 区切りは UTC の 0 時で、Cloudflare の枠が戻る境目と同じにしてある。
 */
export function quotaDayKey(now: number): string {
  return `quota:${new Date(now).toISOString().slice(0, 10)}`;
}

/** 数として読めない値は 0 にする。手で書き換えられた sync_state で同期が壊れないようにする。 */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * その日に Worker が書いた D1 の行数と、出した要求の回数を数える。
 * 無料枠の 80% に達したら exceeded() が true になり、SyncEngine が自分で同期を止める。
 * 数えは sync_state に置くので、サーバを立て直しても続く。
 *
 * **`rows` は「端末が送った論理行数」ではなく「Worker が D1 へ書いた行数」である。**
 * 比べる相手（`QUOTA_LIMITS.d1Writes`）が D1 の「1 日に書ける行数」なので、単位を揃えないと見張りが効かない。
 * 呼び手は pushD1Writes と D1_WRITES_PER_DEVICE_TOUCH を使って、実際の書き込みに換算してから渡すこと。
 */
export class QuotaCounter {
  private readonly state: SyncStateStore;
  private readonly nowFn: () => number;
  private readonly deviceCountFn: () => number;
  readonly limits: QuotaLimits;
  readonly ratio: number;
  /** 最後に書いた日の鍵。日付が変わったら、この行を消して sync_state を溜めない。 */
  private lastKey: string | null = null;

  constructor(o: { state: SyncStateStore; now?: () => number; limits?: QuotaLimits; ratio?: number; deviceCount?: () => number }) {
    this.state = o.state;
    this.nowFn = o.now ?? (() => Date.now());
    this.limits = o.limits ?? QUOTA_LIMITS;
    this.ratio = o.ratio ?? QUOTA_STOP_RATIO;
    this.deviceCountFn = o.deviceCount ?? (() => 1);
  }

  /**
   * 枠を分け合う端末の数。
   * 読めない値（0 以下、数でない、小数）は 1 台として扱う。
   * 少なく見積もると割り当てが増えて止まるのが遅れるので、迷ったら 1 に倒さずに切り捨てる。
   */
  private devices(): number {
    const n = this.deviceCountFn();
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  /**
   * この端末が止まる水準である。
   *
   * **無料枠はアカウントごとで、端末ごとではない。**
   * 端末が自分の書き込みだけを見て 80% で止めると、2 台ではアカウント全体で 160% まで走ってしまう。
   * そこで割り当てを端末の数で割り、全員が使い切っても合計が 80% に収まるようにする。
   *
   * 代償は、動いているのが 1 台だけの日に、使えるはずの枠の半分で止まることである。
   * 決定 4 は「遅れるより早い方がまし」なので、この倒し方を選んだ（止まっても利用者が再開できる）。
   */
  stopAt(): QuotaLimits {
    const n = this.devices();
    return { d1Writes: (this.limits.d1Writes * this.ratio) / n, requests: (this.limits.requests * this.ratio) / n };
  }

  /** その日の鍵。`quota:<yyyy-MM-dd>` は SyncStateKey の一覧には無いので、包みに渡すときだけ被せる。 */
  private key(): string { return quotaDayKey(this.nowFn()); }

  private read(key: string): QuotaRecord {
    const raw = this.state.get(key as SyncStateKey);
    if (raw === null) return { rows: 0, requests: 0 };
    try {
      const v = JSON.parse(raw) as { rows?: unknown; requests?: unknown; account?: unknown; accountAt?: unknown };
      const rec: QuotaRecord = { rows: count(v?.rows), requests: count(v?.requests) };
      if (typeof v?.account === 'number' && Number.isFinite(v.account) && v.account >= 0) {
        rec.account = Math.floor(v.account);
        rec.accountAt = count(v?.accountAt);
      }
      return rec;
    } catch {
      return { rows: 0, requests: 0 };
    }
  }

  /** 今日の数え。日付が変わっていれば 0 から始まる。 */
  today(): QuotaDay { const t = this.read(this.key()); return { rows: t.rows, requests: t.requests }; }

  /**
   * push 1 回ぶんを足す。
   * rows は自分の要求から見積もった行数、requests は出した要求の回数である。
   * account は Worker が返した「その日にこの箱が D1 へ書いた行数」で、あれば正として使う。
   */
  note(o: { rows?: number; requests?: number; account?: number }): void {
    const key = this.key();
    if (this.lastKey !== null && this.lastKey !== key) this.state.set(this.lastKey as SyncStateKey, null);
    this.lastKey = key;
    const cur = this.read(key);
    const next: QuotaRecord = { rows: cur.rows + count(o.rows), requests: cur.requests + count(o.requests) };
    if (cur.account !== undefined) { next.account = cur.account; next.accountAt = cur.accountAt ?? 0; }
    // 報告は単調にしか上がらない。後から届いた古い応答で数えを下げると、止まるべき日に止まらない。
    const reported = typeof o.account === 'number' && Number.isFinite(o.account) && o.account >= 0 ? Math.floor(o.account) : null;
    if (reported !== null && reported >= (next.account ?? 0)) { next.account = reported; next.accountAt = next.rows; }
    this.state.set(key as SyncStateKey, JSON.stringify(next));
  }

  /**
   * 見張りに使う「その日に D1 へ書かれた行数」と、その止め水準である。
   *
   * Worker の報告があるときは、それがアカウント全体の数なので端末の数で割らない。
   * 割らないと 2 台で 160% まで走るのは、端末が自分の書き込みしか見ていないからである。
   * 全員ぶんが入った 1 つの数で見られるなら、割り当てを分ける理由がそもそも無い。
   *
   * 報告の後に自分で書いた分（ファイルの出し入れと pull）は、次の報告が来るまで見積もりで足す。
   * 報告が無い（古い Worker の）ときだけ、今までどおり見積もりを端末の数で割った水準で見る。
   */
  d1(): { rows: number; stop: number; authoritative: boolean } {
    const t = this.read(this.key());
    const full = this.limits.d1Writes * this.ratio;
    if (t.account === undefined) return { rows: t.rows, stop: full / this.devices(), authoritative: false };
    return { rows: t.account + Math.max(0, t.rows - (t.accountAt ?? 0)), stop: full, authoritative: true };
  }

  /** 行数と要求の回数のどちらかが、この端末の割り当てに達したか。 */
  exceeded(): boolean {
    if (this.today().requests >= this.stopAt().requests) return true;
    const d = this.d1();
    return d.rows >= d.stop;
  }

  /**
   * 無料枠で止めた日（`quotaDayKey` の形）。止めていなければ null である。
   * 数えと同じ sync_state に置くので、サーバを立て直してもその日はもう止め直さない。
   */
  pausedDay(): string | null { return this.state.get(QUOTA_PAUSED_DAY_KEY); }

  setPausedDay(day: string | null): void { this.state.set(QUOTA_PAUSED_DAY_KEY, day); }
}
