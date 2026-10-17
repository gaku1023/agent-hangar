import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  CLOUD_HEADERS,
  COMPAT_HEADER,
  COMPAT_VERSION,
  compatHeaders,
  encodeFileKeyPath,
  isBlobKey,
  isSafeKeyId,
  isSafeRelPath,
  MAX_BLOB_DELETE_KEYS,
  MOBILE_IMAGES_PER_LAUNCH,
  parseCompat,
  readCloudLimit,
  readCompatRefusal,
  REVOKED_ERROR,
  type BlobsDeleteOut,
  type ChangeIn,
  type ChangeOut,
  type CloudLimitKind,
  type CloudUsageBody,
  type DeviceOut,
  type DeviceRevokeOut,
  type DevicesOut,
  type FileMetaIn,
  type JoinCodeCreate,
  type JoinCodeMine,
  type KeyboxesOut,
  type KeyboxesPutOut,
  type KeyboxIn,
  type ListFilesResponse,
  type MobileFeedPut,
  type MobilePairingResponse,
  type MobilePairingsMine,
  type PushChangesResponse,
  type RosterOut,
  type RosterPut,
  type RosterPutOut,
  type SealedChangeIn,
  type SealedFileIn,
  type SealedListFilesResponse,
  type SealedPullChangesResponse,
  type SealedSnapshotResponse,
} from '@agent-hangar/shared';
import { msg, MessageError, type Message } from '../i18n/message.ts';

/**
 * クラウドの応答が 2xx でなかったときと、そもそも決着しなかったとき（status 0）に投げる。
 * message は応答本文の先頭 200 字なので、Worker の応答本文に秘密を入れてはいけない。
 */
export class CloudError extends MessageError {
  /** 利用者に見せる文を持つ失敗（CompatError と LimitError）は、辞書の文を渡す。応答の本文は文字列のまま渡す。 */
  constructor(public readonly status: number, message: Message | string) {
    super(message);
    this.name = 'CloudError';
  }
}

const toCloudError = (e: unknown): CloudError => (e instanceof CloudError ? e : new CloudError(0, e instanceof Error ? e.message : String(e)));

/**
 * この PC が Worker に求める互換の版の下限。
 * 段 1 の PR 6 で 1 に上げた。版の見出しを返さない古い Worker（版 0 として読む）は、最初の 2xx で断る。
 * そのため、古い Worker のための分岐（/usage の 404 を「トークンなし」に読み替える）は持たない。
 * Worker の API を古い Worker と話せない形で変えたら、その版に上げる。上げる前に Worker を配備し直す。
 * 段 2 の PR 11 で 2 に上げた。版 1 の Worker は共有の表の一覧に session_notes を持たず、その行を含む push を丸ごと断る。
 * 同期の版 6 で 6 に上げた（Worker の MIN_DEVICE_COMPAT と同時に上げる例外、docs/design.md「互換の版番号」）。
 * 版 5 までの Worker は pull の応答に peers と now を添えず、他の PC の生存を読めない。変更ログの 410 の取り直しも、この下限で要らなくなった。
 * E2E の作り直しで 9 に上げた（Worker の MIN_DEVICE_COMPAT と同時）。
 * 版 8 までの Worker は封じた行（k と sealed）を知らず、行の中身を平文で持つ形なので、この PC は何も書かない。
 */
export const MIN_WORKER_COMPAT = 9;

/** 上げるべき側。device はこの PC の hangar、worker はクラウドの Worker である。 */
export type CompatUpgrade = 'device' | 'worker';

/**
 * 0.8.x までの Worker の互換の版の上限。
 * 版 8 までの Worker から版 9 へは移行の道が無く、Worker の入れ替え（setup cloud をもう一度）では直らない。
 * そのときは入れ替えではなく、再構築の手順（docs/cloud-sync.md）へ案内する。
 */
const LAST_LEGACY_WORKER_COMPAT = 8;

function compatMessage(upgrade: CompatUpgrade, have: number, need: number | null): Message {
  if (upgrade === 'device') return need === null ? msg('sync.compat.deviceNewer', { have }) : msg('sync.compat.deviceNeed', { have, need });
  if (have <= LAST_LEGACY_WORKER_COMPAT) return msg('sync.compat.workerRebuild', { have });
  return msg('sync.compat.worker', { have, need: need ?? '?' });
}

/**
 * 互換の版が合わないときに投げる。
 * Worker に 426 で断られたら device（この PC を上げる）、Worker の名乗った版がこちらの下限より古ければ worker（Worker を上げる）である。
 * message は CloudError と違って応答の本文ではなく、利用者に見せる文で、どちらを上げればよいかを書く（同期の状態の error に出る）。
 * 辞書の文は text が持つので、出す側（SyncEngine）がそのときの言語の文にする。message は既定の言語（日本語）の文である。
 * status は 426 に揃える。届いた要求として無料枠に数える既存の分岐（status が 0 でない）に、そのまま乗る。
 * 直りようのない 4xx として諦める所（uploader の isPermanentStatus）は、426 を一時の失敗として扱う。
 */
export class CompatError extends CloudError {
  constructor(readonly upgrade: CompatUpgrade, readonly have: number, readonly need: number | null) {
    super(426, compatMessage(upgrade, have, need));
    this.name = 'CompatError';
  }
}

/**
 * この PC が同期から解除されているときに投げる（Worker が端末トークンを 401 の `{ error: 'revoked' }` で断った）。
 * 受け手の SyncEngine は同期を止め、状態に revoked の印を立てる。直す道は、他の PC で発行した参加コードで再参加することだけである。
 * message は応答の本文ではなく、利用者に見せる文である。
 */
export class RevokedError extends CloudError {
  constructor() {
    super(401, msg('sync.revoked.thisPc'));
    this.name = 'RevokedError';
  }
}

/** 401 の本文が解除の印か。本文は Worker のもので、形が違えば解除とは読まない。 */
function isRevokedBody(text: string): boolean {
  try {
    return (JSON.parse(text) as { error?: unknown } | null)?.error === REVOKED_ERROR;
  } catch {
    return false;
  }
}

const LIMIT_LABEL: Record<CloudLimitKind, Message> = {
  'd1-read': msg('sync.limit.d1Read'),
  'd1-write': msg('sync.limit.d1Write'),
  requests: msg('sync.limit.requests'),
};

/**
 * Cloudflare の無料枠の 1 日の上限に当たったときに投げる（共有の readCloudLimit が見分けたもの）。
 * status は応答のもの。message は利用者に見せる文で、応答の本文ではない。
 * 受け手の SyncEngine は、次の UTC の 0 時まで退く。本文の上げ下ろしは、これを諦めに数えない。
 */
export class LimitError extends CloudError {
  constructor(readonly limit: CloudLimitKind, status: number) {
    super(status, LIMIT_LABEL[limit]);
    this.name = 'LimitError';
  }
}

/**
 * GET /files/:key に載せてよい鍵か。
 * 書く鍵は R2 の鍵名（`b/<端末 ID>/<HMAC>`、shared の isBlobKey）だけである。
 * 読む鍵は、それに加えて版 8 までの Worker の鍵名（`transcripts/...` と `config/...`）も通す。
 * hangar cloud teardown が、作り直しの前の Worker から本文を降ろすのに使う（Task 26 で作り直す）。
 * どちらも URL のパスを抜け出す断片（`..`、空の断片、制御文字）は通さない。
 */
export function isFetchableKey(key: string): boolean {
  return isBlobKey(key) || (/^(transcripts|config)\//.test(key) && isSafeRelPath(key));
}

/** 小さい応答（changes、rows、files の一覧、health）の締め切り。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 本体を運ぶ経路（putFile、getFile）の締め切り。 */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 300_000;
/** 1 本の本文の上限。Worker の `MAX_BODY_BYTES`（packages/cloud/src/files.ts）と同じ値で、超えれば Worker も 413 を返す。 */
export const MAX_PUT_BODY_BYTES = 100 * 1024 * 1024;

/**
 * 本文を一時ファイルへ書き出し、長さを決める。上限を超えたら書くのをやめて 413 を投げる。
 *
 * Worker は `content-length` のある本文だけを、JS で読まずに R2 へ渡せる。
 * 長さが無いと、Worker が本文を JS で読んで切り分けるしかなく、CPU の時間が本文の大きさに比例する。
 * 数十 MB の本文で無料プランの 10 ms を何十倍も超え、途中で止められていた（2026-09-30 に 52 件）。
 * 本文は gzip と暗号化を通した後のものなので、送る前に長さを知るには一度書き出すしかない。
 * 記憶に貯めないのは、1 本が 100 MiB までありうるからである。
 */
async function spool(body: Readable, file: string, max: number): Promise<number> {
  let total = 0;
  // 書き込み先も pipeline に入れる。外に置くと、書けなかったときの error を誰も拾わず、プロセスごと落ちる。
  await pipeline(
    body,
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > max) cb(new CloudError(413, JSON.stringify({ error: 'too large' })));
        else cb(null, chunk);
      },
    }),
    fs.createWriteStream(file, { mode: 0o600 }),
  );
  return total;
}

/**
 * 1 回の要求の締め切り。
 * `signal` は fetch にも渡すので、本物の undici なら socket ごと切れる。
 * `race` は手元でも切るためのもので、応答の本体が少しずつ垂れてくる筋を止める。
 * undici の bodyTimeout はバイトが届くたびに振り出しに戻るので、全体の上限はこちらで持つしかない。
 */
class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly ms: number) {
    this.timer = setTimeout(() => this.controller.abort(this.error()), ms);
    this.timer.unref();
  }

  get signal(): AbortSignal { return this.controller.signal; }

  error(): CloudError { return new CloudError(0, `timeout after ${this.ms}ms`); }

  race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        if (this.signal.aborted) reject(this.error());
        else this.signal.addEventListener('abort', () => reject(this.error()), { once: true });
      }),
    ]);
  }

  clear(): void { clearTimeout(this.timer); }
}

/** 開けなかった行。中身は分からないので、連番と封じた世代だけを持つ。 */
export type Unreadable = { seq: number; epoch: number };

/**
 * 開いた pull の応答。行のほかは線の上の形（SealedPullChangesResponse）と同じである。
 * 開けなかった行は changes に入れず unreadable に入れる。名簿の印の行はどちらにも入れない。
 */
export type OpenedPullResponse = Omit<SealedPullChangesResponse, 'changes'> & { changes: ChangeOut[]; unreadable: Unreadable[] };
/** 開いた写しの頁。nextAfter は線の上の k のままで、次の頁にそのまま渡す。 */
export type OpenedSnapshotResponse = Omit<SealedSnapshotResponse, 'changes'> & { changes: ChangeOut[]; unreadable: Unreadable[] };

/**
 * 世代鍵の読み直しの結果。
 * not-needed は、どの世代の鍵も手元にあって読み直さなかった（行が壊れているか書き換えられている）。
 * gained は、読み直して欠けていた世代の鍵が 1 つ以上届いた（頁を読み直せば開ける）。
 * missing は、読み直しても届かなかった。
 */
export type KeyRefresh = 'not-needed' | 'gained' | 'missing';

/** 行と本文のほかの口。線の上（WireCloudClient）と開いた側（CloudClient）で同じ形である。 */
export interface CloudClientBase {
  health(): Promise<{ ok: boolean; version: string }>;
  /** 使用量と費用。 */
  usage(): Promise<CloudUsageBody>;
  /**
   * 同期に参加している端末の一覧（互換の版 5 の Worker から。版 9 で名前、OS、IP、所在地が無くなった）。解除した端末も revokedAt つきで入る。
   * 名前と OS は封じた名簿（sync/roster.ts）にある。版 4 までの Worker は 404 を返す。偽物は実装しなくてよい。
   */
  listDevices?(): Promise<DeviceOut[]>;
  /** 端末を解除する（自分自身も）。解除した端末の行を返す。 */
  revokeDevice?(id: string): Promise<DeviceOut>;
  /**
   * Worker が最後に（2xx の応答で）名乗った互換の版。まだ話していなければ null。
   * 設定の同期が、Worker が束の行を知る版に届くまで行を書かないために読む。実装しない偽物は null を返してよい。
   */
  lastWorkerCompat?(): number | null;
  /**
   * この PC の受信箱の素（封じたもの）を置く（PUT /m/feed、互換の版 7 の Worker から）。
   * epoch は素を封じたスマホ用の鍵の世代で、版 9 の Worker は無いと 400 で断る。
   * 呼ぶのは MobileFeedPublisher で、Worker の版が MOBILE_MIN_WORKER_COMPAT に届いてからにする。偽物は実装しなくてよい。
   */
  putMobileFeed?(sealed: string, epoch: number): Promise<void>;
  /**
   * スマホを接続する使い捨ての券を取る（POST /m/pairings、互換の版 7 の Worker から）。5 分で失効し、1 回で使い切る。
   * 1 台の PC から 10 分に 5 枚までで、超えると Worker は 429 を返す（CloudError(429) で投げる）。偽物は実装しなくてよい。
   */
  createPairing?(): Promise<MobilePairingResponse>;
  /**
   * スマホからの起動の依頼を受け取る（POST /m/launches/:id/claim、互換の版 7 の Worker から）。
   * 自分宛てで、まだ誰も受け取っておらず、時間切れでないときだけ true で、PC は true のときだけ起こす。409 は false。ほかの失敗は投げる。偽物は実装しなくてよい。
   */
  claimLaunch?(id: string): Promise<boolean>;
  /** 受け取った依頼の結果を返す（POST /m/launches/:id/answer）。sealedAnswer はスマホ用の鍵で封じた MobileLaunchAnswer。409 も投げる。 */
  answerLaunch?(id: string, ok: boolean, sealedAnswer: string): Promise<void>;
  /**
   * 呼び鈴（GET /m/bell の WebSocket、互換の版 8 の Worker から）のつなぎ先と見出し。
   * 見出しには端末トークンの Bearer と互換の版が入るので、ログに出さない。トークンを読み直して差し替えたら、新しいものを返す。
   * 呼ぶのは mobile/bell.ts で、Worker の版が MOBILE_BELL_MIN_WORKER_COMPAT に届いてからにする。偽物は実装しなくてよい。
   */
  bellTarget?(): BellTarget;
  /**
   * スマホが置いた画像（封じたままのバイト列）を取る（GET /m/blobs/<依頼>/<番号>、互換の版 8 の Worker から）。
   * 自分宛てで、受け取った（claimed）依頼の画像だけが読める。無いもの、宛先でないものは CloudError(404)。偽物は実装しなくてよい。
   */
  getMobileBlob?(launchId: string, n: number): Promise<Uint8Array>;
  /**
   * この PC の受信箱の素を Worker から消す（DELETE /m/feed、互換の版 8 の Worker から）。行が無くても成功する。
   * 最後のスマホを解除したあとに 1 回呼ぶ。偽物は実装しなくてよい。
   */
  deleteMobileFeed?(): Promise<void>;
  /**
   * 自分の端末 ID の下の本文を消す（DELETE /blobs、互換の版 9）。鍵は 1 回に MAX_BLOB_DELETE_KEYS 件まで。
   * 置いてから 1 時間たっていないもの、ほかの端末の下のもの、1 日の上限からあふれたものは refused で返る。
   * 1 日の上限を使い切っていれば CloudError(429) で投げる。呼ぶのはゴミ箱の掃除（sync/trashSweep.ts）。偽物は実装しなくてよい。
   */
  deleteBlobs?(keys: string[]): Promise<BlobsDeleteOut>;
}

/**
 * 線の上の Worker（互換の版 9）。行は封じたまま（SealedChangeIn と SealedChangeOut）で運び、開けない。
 * HttpCloudClient が本物、FakeWireClient（test/fake-cloud.ts）がメモリ上の偽物。
 */
export interface WireCloudClient extends CloudClientBase {
  pushChanges(changes: SealedChangeIn[]): Promise<PushChangesResponse>;
  pullChanges(since: number, limit: number): Promise<SealedPullChangesResponse>;
  snapshot(after: string | null, limit: number): Promise<SealedSnapshotResponse>;
  /** 封じたメタと、暗号化済みの本文を置く（PUT /files/:key）。鍵名は自端末の下（`b/<自分>/`）だけ。 */
  putFile(meta: SealedFileIn, body: Readable): Promise<{ seq: number }>;
  /** 暗号化されたままの本文を取る。 */
  getFile(key: string): Promise<Readable>;
  /** 封じたメタのままの索引。 */
  listFiles(since: number, limit: number): Promise<SealedListFilesResponse>;
  /** 封じた名簿（GET /roster）。まだ無ければ（404）null で、投げない。 */
  getRoster(): Promise<RosterOut | null>;
  /** 名簿を版の番号つきで書き換える（PUT /roster）。版が合わない 409 は投げずに ok: false と今の版で返す。 */
  putRoster(body: RosterPut): Promise<RosterPutResult>;
  /** 自分宛ての keybox（GET /keyboxes）。いちばん新しい世代の 1 つだけで、まだ無ければ空の配列。 */
  getKeyboxes(): Promise<KeyboxesOut>;
}

/** 名簿の書き換えの結果。ok が false なら版が合わずに断られた（409）。version はどちらも Worker の今の版。 */
export type RosterPutResult = { ok: boolean } & RosterPutOut;

/**
 * 端末から見た Worker。行は開いた形（ChangeIn と ChangeOut）で話す。
 * 本物は線の client を包む SealedCloudClient（sync/sealedClient.ts）で、行を封じて送り、受けた行を開く。
 * FakeCloudClient（test/fake-cloud.ts）は偽の Worker を同じ SealedCloudClient で包んだもの。
 */
export interface CloudClient extends CloudClientBase {
  pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse>;
  pullChanges(since: number, limit: number): Promise<OpenedPullResponse>;
  snapshot(after: string | null, limit: number): Promise<OpenedSnapshotResponse>;
  /**
   * 平文の本文を上げる。gzip してから meta.epoch の世代の本文の鍵で暗号化し、メタを封じて置く。
   * 鍵名（meta.key）は呼び手が e2e/names.ts で同じ世代の `/index` の鍵から求める。
   * meta.epoch が今の世代でなければ上げない（世代を回した後に、古い世代の鍵で書かない）。
   */
  putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }>;
  /** 本文を取り、epoch の世代の鍵で復号して gzip を解いた平文の流れを返す。 */
  getFile(key: string, epoch: number): Promise<Readable>;
  /**
   * 索引を開いて返す。
   * 世代の鍵が無い行は unreadable に入れ、宛先や鍵名が中身と合わない行は捨てる。
   */
  listFiles(since: number, limit: number): Promise<ListFilesResponse>;
  /**
   * 開けなかった行の世代（unreadable の epoch）を渡し、手元に無い世代があれば名簿と keybox を読み直す。
   * 同期のエンジンは 1 巡に 1 度だけ呼び、gained なら同じ頁を読み直す。実装しない偽物は読み直さない。
   */
  refreshKeys?(epochs: number[]): Promise<KeyRefresh>;
}

/** 呼び鈴の WebSocket のつなぎ先。url は wss（手元の Worker では ws）で、headers は Bearer と互換の版。 */
export type BellTarget = { url: string; headers: Record<string, string> };

export type HttpCloudClientOptions = {
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** 小さい応答の締め切り。既定は 30 秒。 */
  timeoutMs?: number;
  /** 本体を運ぶ経路の締め切り。既定は 5 分。 */
  transferTimeoutMs?: number;
  /** putFile が本文を書き出す場所。既定は OS の一時ディレクトリ。 */
  spoolDir?: string;
  /** putFile の本文の上限。既定は Worker と同じ 100 MiB。 */
  maxBodyBytes?: number;
  /** この PC が Worker に求める互換の版の下限。既定は MIN_WORKER_COMPAT。試験が上げるために使う。 */
  minWorkerCompat?: number;
  /**
   * 解除ではない 401（`{ error: 'unauthorized' }`）を受けたときに、宛先と端末トークンを読み直す口。
   * 返した組が今のものと違えば、それに差し替えて同じ要求を 1 度だけ試し直す。
   * 同じなら、または null を返すか投げれば、試し直さずに今までどおりの CloudError にする。
   * 参加し直す（hangar setup cloud をやり直す、hangar join し直す）と、Worker は同じ端末 ID の token_hash を入れ替え、新しいトークンは cloud.json にだけ書かれる。
   * 動いているサーバがそれを拾う道がこれである（boot/sync.ts）。
   */
  reloadCredentials?: () => { url: string; token: string } | null;
  /**
   * 書き込み（push と putFile）の前に、Worker の版をまだ知らないか下限に届いていなければ、GET /health で確かめる。
   * 版は応答の見出しで初めて分かるので、確かめずに書くと、古い Worker が行や本文を受け取ってから CompatError になる。
   * 既定は切。同期を組む所（boot/sync.ts）が入れる。
   */
  checkWorkerBeforeWrite?: boolean;
};

/**
 * fetch で Worker を叩く実装。token はヘッダにだけ載せ、URL にもログにも出さない。
 * 行は封じた形のまま運ぶ（WireCloudClient）。封じて開くのは包む側の SealedCloudClient である。
 */
export class HttpCloudClient implements WireCloudClient {
  private base!: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly transferTimeoutMs: number;
  private readonly spoolDir: string;
  private readonly maxBodyBytes: number;
  private readonly minWorkerCompat: number;
  private seenWorkerCompat: number | null = null;
  /**
   * 端末トークンは閉じ込めて持つ。
   * 文字列の項目にすると console.log(client) や JSON.stringify(client) で読めてしまう。
   */
  private authorization!: () => string;
  /** 今の宛先とトークンと同じ組か。トークンはここでも閉じ込めたまま比べる。 */
  private holds!: (url: string, token: string) => boolean;
  private readonly reloadCredentials: (() => { url: string; token: string } | null) | null;
  private readonly checkWorkerBeforeWrite: boolean;
  /** 宛先とトークンを差し替えた回数。同時に断られた要求のうち、差し替えの前に出たものを、読み直さずに試し直すために見る。 */
  private credentialGen = 0;
  /** 走っている版の確かめ。同時の書き込みは 1 回を分け合う。 */
  private workerCheck: Promise<void> | null = null;

  constructor(o: HttpCloudClientOptions) {
    this.fetchFn = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transferTimeoutMs = o.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    this.spoolDir = o.spoolDir ?? os.tmpdir();
    this.maxBodyBytes = o.maxBodyBytes ?? MAX_PUT_BODY_BYTES;
    this.minWorkerCompat = o.minWorkerCompat ?? MIN_WORKER_COMPAT;
    this.reloadCredentials = o.reloadCredentials ?? null;
    this.checkWorkerBeforeWrite = o.checkWorkerBeforeWrite === true;
    this.setCredentials(o.url, o.token);
  }

  private setCredentials(url: string, token: string): void {
    const base = url.replace(/\/+$/, '');
    this.base = base;
    this.authorization = () => `Bearer ${token}`;
    this.holds = (u, t) => u.replace(/\/+$/, '') === base && t === token;
    this.credentialGen++;
  }

  /**
   * 解除ではない 401 を受けたときに、宛先とトークンを読み直す。
   * 今と違う組が得られたら差し替えて真を返す。読み直しの口が投げても、同期は今までどおりの失敗で続ける。
   * 要求を出した後で、同時に断られた別の要求が先に差し替えていたら、読み直さずに真を返す（sentGen は出したときの credentialGen）。
   */
  private renewCredentials(sentGen: number): boolean {
    if (sentGen !== this.credentialGen) return true;
    if (!this.reloadCredentials) return false;
    let next: { url: string; token: string } | null;
    try {
      next = this.reloadCredentials();
    } catch {
      return false;
    }
    if (!next || this.holds(next.url, next.token)) return false;
    this.setCredentials(next.url, next.token);
    return true;
  }

  /**
   * 書き込みの前の関所（checkWorkerBeforeWrite）。
   * Worker の版を知っていて下限に届いていれば何もしない。
   * 知らないか届いていなければ GET /health を 1 回打つ。/health は D1 を読まず、版の見出しを返す（packages/cloud/src/app.ts）。
   * 届かなければ send が CompatError('worker') を投げるので、書き込みは出ない。
   * 確かめが他の理由で転んだときも書き込みを出さない。書き込みも同じ理由で転ぶので、要求を 2 倍にしない。
   */
  private async ensureWorkerCompat(): Promise<void> {
    if (!this.checkWorkerBeforeWrite) return;
    if (this.seenWorkerCompat !== null && this.seenWorkerCompat >= this.minWorkerCompat) return;
    this.workerCheck ??= this.json<unknown>('/health').then(() => undefined).finally(() => { this.workerCheck = null; });
    await this.workerCheck;
  }

  /**
   * 要求を投げて応答の見出しまでを受ける。
   * 締め切りは呼び手が本体を読み終えるまで生きているので、Deadline は返して呼び手が clear する。
   *
   * 互換の版は、成否より先に見る。
   * 426 なら Worker がこの PC を断った。Worker の名乗った版が下限より古ければ、こちらが Worker を断る。
   * 古い Worker は要求をもう済ませている（push なら行を受け取っている）が、こちらは失敗として扱う。
   * Worker の版は 2xx の応答でだけ問う。
   * Cloudflare の端は Worker を通さずに 4xx と 5xx を返すことがある（WAF の 403、本文が大きすぎるときの 413、CPU の超過の 1102、日の上限など）。
   * それらは版の見出しを持たないが、Worker の版を語らないので、版の不一致にせず、これまでどおり CloudError に落とす。
   * 2xx は Worker を通らないと返らないので、古い Worker はどの経路でも最初の 2xx で見分けられる。
   * 行は未送信のまま残り、Worker を上げた後の送り直しは LWW で同じ結果になる。
   * 上限の失敗（共有の readCloudLimit）は、版の検査より先に見る。
   * 端が返す 1027 の頁は版の見出しを持たないので、版の検査に回すと「Worker が古い」と取り違える。本文は 200 字に切る前に全部で読む。
   *
   * 解除ではない 401 は、宛先とトークンを読み直し（reloadCredentials）、変わっていれば 1 度だけ試し直す。
   * 本文を流れで送る要求は試し直しで送り直せるよう、init を作る関数で渡す。
   */
  private async send(path: string, initOrMake: RequestInit | (() => RequestInit), ms: number, retried = false): Promise<{ res: Response; d: Deadline }> {
    const init: RequestInit & { duplex?: 'half' } = typeof initOrMake === 'function' ? initOrMake() : initOrMake;
    const sentGen = this.credentialGen;
    const d = new Deadline(ms);
    let res: Response;
    try {
      // 版と authorization は後ろに置く。呼び手のヘッダで取り違えて外れることがない。
      res = await d.race(
        this.fetchFn(`${this.base}${path}`, {
          ...init,
          signal: d.signal,
          headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), ...compatHeaders(), authorization: this.authorization() },
        } as RequestInit),
      );
    } catch (e) {
      d.clear();
      throw toCloudError(e);
    }
    if (res.status === 426) {
      const text = await d.race(res.text()).catch(() => '');
      d.clear();
      throw new CompatError('device', COMPAT_VERSION, readCompatRefusal(text));
    }
    let text: string | null = null;
    if (!res.ok) {
      text = await d.race(res.text()).catch(() => '');
      const limit = readCloudLimit(res.status, text);
      if (limit !== null) {
        d.clear();
        throw new LimitError(limit, res.status);
      }
      if (res.status === 401 && isRevokedBody(text)) {
        d.clear();
        throw new RevokedError();
      }
      if (res.status === 401 && !retried && this.renewCredentials(sentGen)) {
        d.clear();
        return this.send(path, initOrMake, ms, true);
      }
    }
    const workerCompat = parseCompat(res.headers.get(COMPAT_HEADER));
    // 版は 2xx の応答でだけ覚える。Cloudflare の端の応答は Worker の版を語らない。
    if (res.ok) this.seenWorkerCompat = workerCompat;
    if (res.ok && workerCompat < this.minWorkerCompat) {
      if (text === null) void res.body?.cancel().catch(() => {});
      d.clear();
      throw new CompatError('worker', workerCompat, this.minWorkerCompat);
    }
    if (!res.ok) {
      d.clear();
      throw new CloudError(res.status, (text ?? '').slice(0, 200) || `HTTP ${res.status}`);
    }
    return { res, d };
  }

  /** 応答の本体を JSON として読む。読み取りの失敗も CloudError(0) に揃える。 */
  private async json<T>(path: string, init: RequestInit | (() => RequestInit) = {}, ms = this.timeoutMs): Promise<T> {
    const { res, d } = await this.send(path, init, ms);
    try {
      return (await d.race(res.json())) as T;
    } catch (e) {
      void res.body?.cancel().catch(() => {});
      throw toCloudError(e);
    } finally {
      d.clear();
    }
  }

  private requireKey(ok: boolean): void {
    if (!ok) throw new CloudError(400, JSON.stringify({ error: 'invalid key' }));
  }

  lastWorkerCompat(): number | null { return this.seenWorkerCompat; }
  bellTarget(): BellTarget {
    // https を wss に、http（手元の Worker）を ws にする。版と authorization は send と同じ見出しで送る。
    return { url: `${this.base.replace(/^http/i, 'ws')}/m/bell`, headers: { ...compatHeaders(), authorization: this.authorization() } };
  }
  health() { return this.json<{ ok: boolean; version: string }>('/health'); }
  async pushChanges(changes: SealedChangeIn[]): Promise<PushChangesResponse> {
    await this.ensureWorkerCompat();
    return this.json<PushChangesResponse>('/changes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
  }
  pullChanges(since: number, limit: number) { return this.json<SealedPullChangesResponse>(`/changes?since=${since}&limit=${limit}`); }
  snapshot(after: string | null, limit: number) { return this.json<SealedSnapshotResponse>(`/rows?after=${encodeURIComponent(after ?? '')}&limit=${limit}`); }
  listFiles(since: number, limit: number) { return this.json<SealedListFilesResponse>(`/files?since=${since}&limit=${limit}`); }

  usage() { return this.json<CloudUsageBody>('/usage'); }

  async listDevices(): Promise<DeviceOut[]> { return (await this.json<DevicesOut>('/devices')).devices; }

  async revokeDevice(id: string): Promise<DeviceOut> {
    // ID は URL の断片に入る。Worker も入口で断るが、形の違うものは外へ出さない。
    if (!isSafeKeyId(id)) throw new CloudError(400, JSON.stringify({ error: 'invalid id' }));
    return (await this.json<DeviceRevokeOut>(`/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' })).device;
  }

  async getRoster(): Promise<RosterOut | null> {
    try {
      return await this.json<RosterOut>('/roster');
    } catch (e) {
      // 名簿がまだ無いのは、setup の途中か古い参加の名残で、失敗ではない。
      if (e instanceof CloudError && e.status === 404) return null;
      throw e;
    }
  }

  async putRoster(body: RosterPut): Promise<RosterPutResult> {
    await this.ensureWorkerCompat();
    try {
      const r = await this.json<RosterPutOut>('/roster', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { ok: true, version: r.version };
    } catch (e) {
      // 409 の本文は今の版（RosterPutOut）だけで、CloudError の先頭 200 字に収まる。
      if (e instanceof CloudError && e.status === 409) {
        const v = (() => { try { return (JSON.parse(e.message) as Partial<RosterPutOut>).version; } catch { return undefined; } })();
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return { ok: false, version: v };
      }
      throw e;
    }
  }

  getKeyboxes(): Promise<KeyboxesOut> { return this.json<KeyboxesOut>('/keyboxes'); }

  /** keybox を置く（PUT /keyboxes）。参加の承認が、新しい PC 宛ての世代鍵の一覧を置くのに使う。 */
  async putKeyboxes(boxes: KeyboxIn[]): Promise<KeyboxesPutOut> {
    await this.ensureWorkerCompat();
    return this.json<KeyboxesPutOut>('/keyboxes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxes }) });
  }

  /** 参加コードを発行する（POST /join-codes）。Worker に送るのはハッシュだけである。発行の上限は CloudError(429) で投げる。 */
  async createJoinCode(codeHash: string): Promise<JoinCodeCreate> {
    await this.ensureWorkerCompat();
    return this.json<JoinCodeCreate>('/join-codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codeHash }) });
  }

  /** この PC のいちばん新しい参加コードの状態（GET /join-codes/mine）。発行したことが無ければ（404）null。 */
  async joinCodeMine(): Promise<JoinCodeMine | null> {
    try {
      return await this.json<JoinCodeMine>('/join-codes/mine');
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return null;
      throw e;
    }
  }

  /** 参加リクエストを承認する（POST /join-codes/:hash/approve）。期限切れと、承認か拒否の済んだコードは CloudError(409)。 */
  async approveJoinCode(codeHash: string, deviceId: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(codeHash)) throw new CloudError(400, JSON.stringify({ error: 'invalid code' }));
    await this.json<{ ok: boolean }>(`/join-codes/${codeHash}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) });
  }

  /** 参加コードを拒否で閉じる（POST /join-codes/:hash/reject）。リクエストの前のコードも閉じられる。 */
  async rejectJoinCode(codeHash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(codeHash)) throw new CloudError(400, JSON.stringify({ error: 'invalid code' }));
    await this.json<{ ok: boolean }>(`/join-codes/${codeHash}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  }

  async putMobileFeed(sealed: string, epoch: number): Promise<void> {
    await this.ensureWorkerCompat();
    const body: MobileFeedPut = { sealed, epoch };
    await this.json<{ ok: boolean }>('/m/feed', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  /** この PC が発行した券に接続したスマホの、まだ keybox を置いていない参加リクエスト（GET /m/pairings/mine、互換の版 9）。 */
  getPairingsMine(): Promise<MobilePairingsMine> {
    return this.json<MobilePairingsMine>('/m/pairings/mine');
  }

  /** スマホ用の鍵の keybox を置く（PUT /phone-keyboxes、互換の版 9）。受け手に解除されたスマホか知らない ID が混ざれば CloudError(400) の unknown recipient。 */
  async putPhoneKeyboxes(boxes: KeyboxIn[]): Promise<KeyboxesPutOut> {
    await this.ensureWorkerCompat();
    return this.json<KeyboxesPutOut>('/phone-keyboxes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxes }) });
  }

  async deleteMobileFeed(): Promise<void> {
    await this.json<{ ok: boolean }>('/m/feed', { method: 'DELETE' });
  }

  async deleteBlobs(keys: string[]): Promise<BlobsDeleteOut> {
    // Worker も入口で断るが、形の違う鍵と上限を超える数は外へ出さない。
    if (keys.length === 0 || keys.length > MAX_BLOB_DELETE_KEYS || !keys.every(isBlobKey)) throw new CloudError(400, JSON.stringify({ error: 'invalid body' }));
    await this.ensureWorkerCompat();
    return this.json<BlobsDeleteOut>('/blobs', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) });
  }

  async getMobileBlob(launchId: string, n: number): Promise<Uint8Array> {
    // ID は URL の断片に入る。Worker も入口で断るが、形の違うものは外へ出さない。番号は 0 から 1 依頼の上限の手前まで。
    if (!isSafeKeyId(launchId) || !Number.isInteger(n) || n < 0 || n >= MOBILE_IMAGES_PER_LAUNCH) throw new CloudError(400, JSON.stringify({ error: 'invalid id' }));
    const { res, d } = await this.send(`/m/blobs/${encodeURIComponent(launchId)}/${n}`, {}, this.transferTimeoutMs);
    try {
      return new Uint8Array(await d.race(res.arrayBuffer()));
    } catch (e) {
      void res.body?.cancel().catch(() => {});
      throw toCloudError(e);
    } finally {
      d.clear();
    }
  }

  createPairing(): Promise<MobilePairingResponse> {
    return this.json<MobilePairingResponse>('/m/pairings', { method: 'POST' });
  }

  async claimLaunch(id: string): Promise<boolean> {
    try {
      await this.json<{ ok: boolean }>(`/m/launches/${encodeURIComponent(id)}/claim`, { method: 'POST' });
      return true;
    } catch (e) {
      // 2 回目、宛先でない、時間切れ、無い ID。どれも起こさない。
      if (e instanceof CloudError && e.status === 409) return false;
      throw e;
    }
  }

  async answerLaunch(id: string, ok: boolean, sealedAnswer: string): Promise<void> {
    await this.json<{ ok: boolean }>(`/m/launches/${encodeURIComponent(id)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok, sealedAnswer }) });
  }

  async putFile(meta: SealedFileIn, body: Readable): Promise<{ seq: number }> {
    this.requireKey(isBlobKey(meta.key));
    // パス、平文の SHA-256、mtime は封じたメタ（base64url）の中にあり、見出しに平文で載せない。
    const headers: Record<string, string> = {
      [CLOUD_HEADERS.kind]: meta.kind,
      [CLOUD_HEADERS.size]: String(meta.size),
      [CLOUD_HEADERS.epoch]: String(meta.epoch),
      [CLOUD_HEADERS.meta]: meta.sealedMeta,
      'content-type': 'application/octet-stream',
    };
    // 中身は暗号化済みなので、一時ファイルに置いても平文は残らない。通っても倒れても消す。
    let dir: string;
    try {
      dir = await fs.promises.mkdtemp(path.join(this.spoolDir, 'hangar-put-'));
    } catch (e) {
      body.destroy();
      throw toCloudError(e);
    }
    try {
      const file = path.join(dir, 'body');
      // 書き出しにも転送と同じ締め切りを掛ける。
      // 流れが止まったまま決着しないと、上げる仕事の鎖ごと後ろが永久に詰まる。
      const d = new Deadline(this.transferTimeoutMs);
      let length: number;
      try {
        length = await d.race(spool(body, file, this.maxBodyBytes));
      } catch (e) {
        body.destroy();
        throw toCloudError(e);
      } finally {
        d.clear();
      }
      headers['content-length'] = String(length);
      // 書き出しを終えてから確かめる。確かめで止まっても、一時ファイルは下の finally で消える。
      await this.ensureWorkerCompat();
      // undici は content-length があればストリームの本文でもその長さで送る（chunked にしない）。
      // duplex: 'half' はストリームを body にするときに要る。
      // 本文の流れは 1 度しか読めないので、試し直し（解除ではない 401 のあと）のたびに一時ファイルから開き直す。
      const v = await this.json<{ seq: number }>(
        `/files/${encodeFileKeyPath(meta.key)}`,
        () => ({ method: 'PUT', headers, body: Readable.toWeb(fs.createReadStream(file)) as unknown as BodyInit, duplex: 'half' } as RequestInit),
        this.transferTimeoutMs,
      );
      return { seq: v.seq };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  async getFile(key: string): Promise<Readable> {
    this.requireKey(isFetchableKey(key));
    const { res, d } = await this.send(`/files/${encodeFileKeyPath(key)}`, {}, this.transferTimeoutMs);
    if (!res.body) {
      d.clear();
      return Readable.from([]);
    }
    const src = Readable.fromWeb(res.body as unknown as WebReadableStream);
    // 締め切りが来たら本体ごと畳む。垂れ流しのままの応答で呼び手が永久に待たないようにする。
    const onAbort = (): void => { src.destroy(d.error()); };
    d.signal.addEventListener('abort', onAbort, { once: true });
    return Readable.from(
      (async function* () {
        try {
          yield* src;
        } catch (e) {
          throw toCloudError(e);
        } finally {
          d.signal.removeEventListener('abort', onAbort);
          d.clear();
        }
      })(),
    );
  }
}
