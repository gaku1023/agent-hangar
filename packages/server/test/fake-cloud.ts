import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  BLOB_DELETE_DAILY,
  BLOB_DELETE_GRACE_MS,
  COMPAT_VERSION,
  encodeEpochList,
  LAUNCH_TTL_MS,
  MAX_BLOB_DELETE_KEYS,
  MAX_PUSH_BATCH,
  MAX_SEALED_META_CHARS,
  MOBILE_BELL_MIN_WORKER_COMPAT,
  MOBILE_MIN_WORKER_COMPAT,
  NOTICE_RATE,
  PHONE_NOTICE_SEALED_MAX,
  phoneNoticeEpoch,
  PULL_LIMIT,
  ROSTER_MARKER_K,
  SEALED_ROW_K_RE,
  fromBase64Url,
  isBlobKey,
  sealKeybox,
  sealRoster,
  toBase64Url,
  type BlobsDeleteOut,
  type ChangeIn,
  type ChangeOp,
  type ChangeOut,
  type CloudLimitKind,
  type CloudUsageBody,
  type DeviceOut,
  type KeyboxesOut,
  type KeyboxesPutOut,
  type KeyboxIn,
  MAX_KEYBOXES_PER_PUT,
  RECOVERY_RECIPIENT,
  type RosterOut,
  type RosterPut,
  type FileEntry,
  type FileKind,
  type FileMetaIn,
  type KeyPairRaw,
  type ListFilesResponse,
  type KeyboxOut,
  type MobileJoinRequest,
  type MobileJoinResponse,
  type MobileLaunchIn,
  type MobileLaunchOut,
  type MobilePairingResponse,
  type MobilePairingsMine,
  type NoticeOut,
  type PushChangesResponse,
  type Roster,
  type SealedChangeIn,
  type SealedChangeOut,
  type SealedFileEntry,
  type SealedFileIn,
  type SealedListFilesResponse,
  type SealedPullChangesResponse,
  type SealedSnapshotResponse,
} from '@agent-hangar/shared';
import { CloudError, CompatError, LimitError, MIN_WORKER_COMPAT, RevokedError, type CloudClient, type KeyRefresh, type OpenedPullResponse, type OpenedSnapshotResponse, type RosterPutResult, type WireCloudClient } from '../src/sync/client.ts';
import { decryptBuffer, encryptBuffer, fileKeyFrom, sha256Hex } from '../src/sync/crypto.ts';
import { Keyring } from '../src/sync/keyring.ts';
import { blobKeyFor, openSealedFile, openSealedRow, SealedCloudClient } from '../src/sync/sealedClient.ts';
import type { CloudConfig } from '../src/config/cloud.ts';
import { testCloudConfig, testKey } from './cloudConfig.ts';

/** Worker の files の 1 行と R2 の本体。entry は封じたメタのまま（互換の版 9）で、body は暗号化したまま。 */
type StoredFile = { entry: SealedFileEntry; body: Buffer };

/**
 * Worker の rows の 1 行。D1 の列と同じものを持つ（互換の版 9）。
 * sealed は封じたバイト列（D1 の BLOB）で、偽物は開けない。名簿の印の行（`~roster`）だけは空である。
 * 試験は値を書き換えて、行の付け替えを真似てよい。
 */
export type FakeRow = { seq: number; k: string; op: ChangeOp; updatedAt: number; deviceId: string; epoch: number; sealed: Uint8Array };

/** 端末をまたいで共有する中身。asDevice で作った別端末のクライアントも同じものを指す。 */
export type FakeCloudStore = {
  /**
   * 採った push の行を届いた順に積んだ控え。試験が「何を送ったか」を見るためだけのもので、pull は読まない。
   * 実物の Worker は変更ログを持たない（同期の版 6）。行は rows と同じものを指す。
   */
  changes: FakeRow[];
  /** k ごとの今の 1 行。実物の rows と同じく、書き換えると末尾の連番を受け取る。pull はここから引く。 */
  rows: Map<string, FakeRow>;
  files: Map<string, StoredFile>;
  seq: number;
  fileSeq: number;
  offline: boolean;
  unauthorized: boolean;
  /** Worker の互換の版。0 にすると、版の見出しを返さない古い Worker（版番号を入れる前に配備したもの）の真似になる。 */
  workerCompat: number;
  /** Worker が端末に求める下限。実物の原本は packages/cloud/src/compat.ts の MIN_DEVICE_COMPAT。 */
  minDeviceCompat: number;
  /**
   * 当たっている Cloudflare の上限。null なら当たっていない。
   * Workers の要求の上限（requests）は全部の口を、D1 の上限は D1 に触らない /health を除く口を断る。
   * 実物の D1 の上限は 429 で返る。偽物も同じ形で断る。
   */
  limited: CloudLimitKind | null;
  /** 参加している PC の行。要求を受けた端末を、初めて見たときに足す（実物は参加の承認で足す）。 */
  devices: Map<string, DeviceOut>;
  /** 封じた名簿（実物の roster の 1 行）。まだ無ければ null。 */
  roster: RosterOut | null;
  /** keybox。受け手の ID から、世代の番号から封じた箱（base64url）へ。 */
  keyboxes: Map<string, Map<number, string>>;
  /** 次の PUT /roster を受ける直前に 1 度だけ走らせる（ほかの PC の書き換えを割り込ませる試験の口）。 */
  beforeRosterPut: (() => Promise<void>) | null;
  /** この回数だけ、次からの PUT /roster を版の食い違い（409）で断る。 */
  rejectRosterPuts: number;
  /**
   * 参加リクエストを置いた、まだ端末トークンを受け取っていない PC。受け手の ID から、参加コードを発行した PC の ID へ。
   * 実物と同じく、その PC 宛ての keybox は発行した PC だけが置ける（offerJoin と redeemJoin）。
   */
  joinOffers: Map<string, string>;
  /** PC ごとの受信箱の素（PUT /m/feed）。実物の mobile_feeds の表に当たる。epoch は素を封じたスマホ用の鍵の世代（互換の版 9）。 */
  mobileFeeds: Map<string, FakeFeed>;
  /** スマホを接続する券（POST /m/pairings）。券のハッシュから。実物の mobile_pairings の表に当たる。 */
  mobilePairings: Map<string, FakePairing>;
  /** スマホ用の鍵の keybox（PUT /phone-keyboxes）。スマホの ID から、世代の番号から封じた箱（base64url）へ。実物の phone_keyboxes に当たる。 */
  phoneKeyboxes: Map<string, Map<number, string>>;
  /** スマホからの起動の依頼（POST /m/launches）。実物の launch_requests の表に当たる。 */
  launches: Map<string, FakeLaunch>;
  /** スマホが置いた画像（封じたまま）。鍵は `<依頼>/<番号>`。実物の R2 の mobile/<スマホ>/<依頼>/<番号> に当たる。 */
  mobileBlobs: Map<string, Uint8Array>;
  /** DELETE /blobs の 1 日の数え。端末の ID から、UTC の日付とその日に消した数へ（実物の meta の blob_delete:<端末> に当たる）。 */
  blobDeletes: Map<string, { day: string; n: number }>;
  /**
   * 受けた通知（POST /notices）を受けた順に積んだもの。実物は表に置かずに Web Push で送るだけなので、試験が「何を送らせたか」を見るための控えである。
   * 1 分 10 回の上限（実物の isolate の記憶での数え）も、ここから PC ごとに数える。
   */
  notices: FakeNotice[];
  /** 偽にすると、POST /notices を知らない Worker（0.9.1 より前。互換の版は同じ 9）の真似になり、404 で断る。 */
  noticeRoute: boolean;
  now: () => number;
};

/** 偽物の Worker が受けた通知の 1 件。sealed は PC がスマホ用の鍵で封じたままで、偽物は開けない。 */
export type FakeNotice = { deviceId: string; sealed: string; epoch: number; at: number };

/** 偽物の Worker が持つ起動の依頼の 1 行。状態の進み方は実物（packages/cloud/src/mobile.ts）と同じ。 */
/** fromDevice は依頼を置いた端末（postLaunch を呼んだクライアントの ID）。pull の launches の from に返す。 */
export type FakeLaunch = { id: string; targetDevice: string; fromDevice: string; createdAt: number; sealed: string; status: 'pending' | 'claimed' | 'started' | 'failed'; sealedAnswer: string | null; epoch: number };
/** 偽物の Worker が持つ受信箱の素の 1 行（実物の mobile_feeds）。 */
export type FakeFeed = { sealed: string; updatedAt: number; epoch: number };
/**
 * 偽物の Worker が持つ券の 1 行（実物の mobile_pairings）。
 * deviceId と request は接続したスマホの ID と封じた参加リクエストで、keybox を置くと request を null にする。
 */
export type FakePairing = { codeHash: string; createdBy: string; createdAt: number; usedAt: number | null; deviceId: string | null; request: string | null };

/** 券の有効期間（packages/cloud/src/mobile.ts の PAIRING_TTL_MS の写し）。 */
export const PAIRING_TTL_MS = 5 * 60_000;
/** 1 回の PUT /phone-keyboxes で置ける数（packages/cloud の MAX_KEYBOXES_PER_PUT と同じ）。 */
const MAX_PHONE_KEYBOXES_PER_PUT = MAX_KEYBOXES_PER_PUT;

const ENC = new TextEncoder();

/**
 * 実物の Worker が持つ大きさの上限である。
 * 原本は `packages/cloud/src/changes.ts` と `packages/cloud/src/files.ts` にあり、
 * `packages/server` はそのパッケージに依存しないので、ここに写しを置く。
 * 数が実物とずれていないことは `fake-cloud.test.ts` の「上限は実物の Worker と同じ数である」が
 * 原本を読んで縛る。偽物が実物より甘いと、本番でだけ 413 で断られる行と本文ができる。
 * MAX_ROW_BYTES は封じた sealed（base64url）の字数で測る。
 */
export const MAX_ROW_BYTES = 180 * 1024;
/** 1 頁（pull と写し）に載せる sealed の合計の字数の上限。超えた行を入れたところで頁を切る。 */
export const MAX_PAGE_SEALED_CHARS = 8 * 1024 * 1024;
export const MAX_BODY_BYTES = 100 * 1024 * 1024;
/** PUT /m/feed の本文の上限（packages/cloud/src/mobile.ts の MAX_FEED_BODY_BYTES の写し）。 */
export const MAX_FEED_BODY_BYTES = 96 * 1024;
/** 起動の依頼の本文の上限（packages/cloud/src/mobile.ts の MAX_LAUNCH_BODY_BYTES の写し）。 */
export const MAX_LAUNCH_BODY_BYTES = 48 * 1024;
/** 応答の本文の上限（packages/cloud/src/mobile.ts の MAX_ANSWER_BODY_BYTES の写し）。 */
export const MAX_ANSWER_BODY_BYTES = 16 * 1024;
/** POST /notices の本文の上限（packages/cloud/src/push.ts の MAX_NOTICE_BODY_BYTES の写し）。 */
export const MAX_NOTICE_BODY_BYTES = 8 * 1024;
/** 1 回の pull に載せる起動の依頼の数（packages/cloud/src/changes.ts の PULL_LAUNCH_LIMIT の写し）。 */
export const PULL_LAUNCH_LIMIT = 50;

/**
 * 実物の Worker が端末に求める互換の版の下限（packages/cloud/src/compat.ts の写し）。
 * ずれていないことは fake-cloud.test.ts の「端末に求める下限は実物の Worker の写し」が原本を読んで縛る。
 */
export const MIN_DEVICE_COMPAT = 9;

/**
 * 実物の Worker が最終確認（devices.last_seen_at）を書き直す間隔（packages/cloud/src/seen.ts の写し）。
 * ずれていないことは fake-cloud.test.ts の「上限は実物の Worker と同じ数である」が原本を読んで縛る。
 */
export const TOUCH_EVERY_MS = 60_000;

/** 断りの本文は Worker と同じ JSON にする。CloudError.message がそのまま実物と揃う。 */
const errorBody = (error: string): string => JSON.stringify({ error });

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** 初めて見た PC の行（実物の版 9 の devices の列）。 */
const newDevice = (id: string, now: number): DeviceOut => ({ id, kind: 'pc', joinedAt: now, lastSeenAt: null, revokedAt: null, expiresAt: null });

/**
 * Worker の isChange（packages/cloud/src/changes.ts）と同じ検査。
 * ここを甘くすると、実物なら 400 で塊ごと断られる行を偽物が受け取ってしまう。
 * push は失敗しても行を残して再送するので、甘い偽物は本番で「同じ 40 行を永久に送り続ける」を作る。
 */
function isChange(v: unknown): v is SealedChangeIn {
  const c = v as Partial<SealedChangeIn> | null;
  return (
    !!c &&
    typeof c.k === 'string' &&
    SEALED_ROW_K_RE.test(c.k) &&
    (c.op === 'upsert' || c.op === 'delete') &&
    typeof c.updatedAt === 'number' &&
    Number.isSafeInteger(c.updatedAt) &&
    c.updatedAt >= 0 &&
    isEpoch(c.epoch) &&
    typeof c.sealed === 'string' &&
    c.sealed.length > 0
  );
}

/** Worker の isSealedText と同じ字の形（詰め物の無い base64url）。 */
const isSealedText = (v: string, max: number): boolean => v.length > 0 && v.length <= max && v.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(v);

/** Worker の clampLimit と同じ丸め。0 と NaN は既定、負の数は 1、上限は PULL_LIMIT。 */
const clampLimit = (v: number): number => Math.min(Math.max(Number(v) || PULL_LIMIT, 1), PULL_LIMIT);

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

const toOut = (r: FakeRow): SealedChangeOut => ({ seq: r.seq, k: r.k, op: r.op, updatedAt: r.updatedAt, epoch: r.epoch, sealed: toBase64Url(r.sealed), deviceId: r.deviceId });

/**
 * Worker の cutPage と同じ頁の切り方。limit 行に達するか、sealed の合計の字数が上限を超えた行を入れたところで止める。先頭の 1 行は必ず入れる。
 */
function cutPage(rows: FakeRow[], limit: number): { page: FakeRow[]; more: boolean } {
  const page: FakeRow[] = [];
  let chars = 0;
  for (const r of rows) {
    if (page.length >= limit || (page.length > 0 && chars > MAX_PAGE_SEALED_CHARS)) break;
    page.push(r);
    chars += Math.ceil((r.sealed.length * 4) / 3);
  }
  return { page, more: rows.length > page.length };
}

type FakeWireOptions = { deviceId?: string; store?: FakeCloudStore; now?: () => number; minWorkerCompat?: number };

/**
 * Worker と同じ規則（入力の検査、LWW、自端末の除外、鍵の権限、rows の連番、生存の知らせ）をメモリ上で再現する偽物。
 * 行は封じた形（互換の版 9）のまま持ち、開けない。asDevice で同じストアを別端末として使えるので、2 端末の同期をそのまま書ける。
 * 本物の fetch は一切呼ばない。開いた形で話す試験は、これを SealedCloudClient で包んだ FakeCloudClient を使う。
 */
export class FakeWireClient implements WireCloudClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly store: FakeCloudStore;
  readonly deviceId: string;
  /** この端末が Worker に求める互換の版の下限。HttpCloudClient の minWorkerCompat に当たる。 */
  readonly minWorkerCompat: number;
  private seenWorkerCompat: number | null = null;

  constructor(o: FakeWireOptions = {}) {
    this.deviceId = o.deviceId ?? 'self';
    this.minWorkerCompat = o.minWorkerCompat ?? MIN_WORKER_COMPAT;
    this.store = o.store ?? {
      changes: [],
      rows: new Map(),
      files: new Map(),
      seq: 0,
      fileSeq: 0,
      offline: false,
      unauthorized: false,
      workerCompat: COMPAT_VERSION,
      minDeviceCompat: MIN_DEVICE_COMPAT,
      limited: null,
      devices: new Map(),
      roster: null,
      keyboxes: new Map(),
      beforeRosterPut: null,
      rejectRosterPuts: 0,
      joinOffers: new Map(),
      mobileFeeds: new Map(),
      mobilePairings: new Map(),
      phoneKeyboxes: new Map(),
      launches: new Map(),
      mobileBlobs: new Map(),
      blobDeletes: new Map(),
      notices: [],
      noticeRoute: true,
      now: o.now ?? (() => Date.now()),
    };
    if (o.store && o.now) this.store.now = o.now;
  }

  get offline(): boolean { return this.store.offline; }
  set offline(v: boolean) { this.store.offline = v; }
  /** true の間、全メソッドが 401 を投げる。端末トークンを入れ替えた後と端末の行を消した後の筋を書くために使う。 */
  get unauthorized(): boolean { return this.store.unauthorized; }
  set unauthorized(v: boolean) { this.store.unauthorized = v; }
  /** Worker の互換の版。下げると、この端末の下限より古い Worker の真似になる。 */
  get workerCompat(): number { return this.store.workerCompat; }
  set workerCompat(v: number) { this.store.workerCompat = v; }
  /** Worker が端末に求める下限。上げると、この端末が古いと断られる。 */
  get minDeviceCompat(): number { return this.store.minDeviceCompat; }
  set minDeviceCompat(v: number) { this.store.minDeviceCompat = v; }
  /** 当たっている Cloudflare の上限。立てると、その上限で断る真似になる。 */
  get limited(): CloudLimitKind | null { return this.store.limited; }
  set limited(v: CloudLimitKind | null) { this.store.limited = v; }
  get changes(): FakeRow[] { return this.store.changes; }
  get rows(): Map<string, FakeRow> { return this.store.rows; }
  get files(): Map<string, StoredFile> { return this.store.files; }
  get mobileFeeds(): Map<string, FakeFeed> { return this.store.mobileFeeds; }
  get mobilePairings(): Map<string, FakePairing> { return this.store.mobilePairings; }
  get phoneKeyboxes(): Map<string, Map<number, string>> { return this.store.phoneKeyboxes; }
  get launches(): Map<string, FakeLaunch> { return this.store.launches; }
  get mobileBlobs(): Map<string, Uint8Array> { return this.store.mobileBlobs; }
  get notices(): FakeNotice[] { return this.store.notices; }
  /** 偽にすると、POST /notices を知らない Worker の真似になる。 */
  get noticeRoute(): boolean { return this.store.noticeRoute; }
  set noticeRoute(v: boolean) { this.store.noticeRoute = v; }

  /**
   * 同じストアを別の端末として使うクライアント。2 端末の同期のテストはこれで書く。
   * Worker に求める下限（minWorkerCompat）は、作った元のクライアントのものを引き継ぐ。
   */
  asDevice(deviceId: string): FakeWireClient {
    return new FakeWireClient({ deviceId, store: this.store, minWorkerCompat: this.minWorkerCompat });
  }

  /** Worker が最後に名乗った版。話すまでは null（HttpCloudClient と同じ）。 */
  lastWorkerCompat(): number | null { return this.seenWorkerCompat; }

  private guard(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    // 繋がらなければ認証にも辿り着かないので、offline を先に見る。
    if (this.store.offline) throw new CloudError(0, 'offline');
    this.seenWorkerCompat = this.store.workerCompat;
    // 上限は Cloudflare の側で断る。Workers の要求の上限は Worker の手前なので、版の関所より先に当たる。
    if (this.store.limited !== null && (method !== 'health' || this.store.limited === 'requests')) throw new LimitError(this.store.limited, 429);
    // 版の関所は Worker のどの経路よりも先にある（認証より先）。/health だけは版を問わずに通る。
    // 偽物の端末は常に今の版を名乗る（HttpCloudClient と同じ）。
    if (method !== 'health' && COMPAT_VERSION < this.store.minDeviceCompat) throw new CompatError('device', COMPAT_VERSION, this.store.minDeviceCompat);
    // 応答の版をこの端末の下限と比べる（HttpCloudClient の send と同じく、成否より先に見る）。
    // 実物では古い Worker が要求を済ませてから端末が断るが、偽物は先に断る。
    // どちらでも行は未送信のまま残り、Worker を上げた後の送り直しは LWW で同じ結果になる。
    if (this.store.workerCompat < this.minWorkerCompat) throw new CompatError('worker', this.store.workerCompat, this.minWorkerCompat);
    if (this.store.unauthorized) throw new CloudError(401, errorBody('unauthorized'));
    const now = this.store.now();
    const row = this.store.devices.get(this.deviceId) ?? newDevice(this.deviceId, now);
    // 解除した PC の端末トークンは、Worker が 401 の revoked で断る。
    if (row.revokedAt !== null) throw new RevokedError();
    // 最終確認は、前回から TOUCH_EVERY_MS たったときだけ書く（実物の touchIfDue）。
    const due = row.lastSeenAt === null || now - row.lastSeenAt >= TOUCH_EVERY_MS;
    this.store.devices.set(this.deviceId, due ? { ...row, lastSeenAt: now } : row);
  }

  /** 端末を解除した状態にする（ほかの PC から解除された筋）。 */
  revoke(deviceId: string): void {
    const now = this.store.now();
    const row = this.store.devices.get(deviceId) ?? newDevice(deviceId, now);
    this.store.devices.set(deviceId, { ...row, revokedAt: row.revokedAt ?? now });
  }

  /** 解除を外す（参加し直した筋）。 */
  unrevoke(deviceId: string): void {
    const row = this.store.devices.get(deviceId);
    if (row) this.store.devices.set(deviceId, { ...row, revokedAt: null, joinedAt: this.store.now() });
  }

  /**
   * 名簿か keybox の書き換え（PUT /roster、PUT /keyboxes）が、同じ要求の中で印の行を進める真似（試験の口で、WireCloudClient には無い）。
   * 印の行は sealed が空で、epoch は書いた PC の今の世代である。書き換えるたびに末尾の連番で入り直す。
   */
  touchRoster(epoch: number): void {
    this.store.rows.delete(ROSTER_MARKER_K);
    this.store.rows.set(ROSTER_MARKER_K, { seq: ++this.store.seq, k: ROSTER_MARKER_K, op: 'upsert', updatedAt: this.store.now(), deviceId: this.deviceId, epoch, sealed: new Uint8Array(0) });
  }

  async listDevices(): Promise<DeviceOut[]> {
    this.guard('listDevices');
    return [...this.store.devices.values()].map((d) => ({ ...d }));
  }

  async revokeDevice(id: string): Promise<DeviceOut> {
    this.guard('revokeDevice', id);
    if (!this.store.devices.has(id)) throw new CloudError(404, errorBody('not found'));
    this.revoke(id);
    return { ...this.store.devices.get(id)! };
  }

  get roster(): RosterOut | null { return this.store.roster; }
  get beforeRosterPut(): (() => Promise<void>) | null { return this.store.beforeRosterPut; }
  set beforeRosterPut(v: (() => Promise<void>) | null) { this.store.beforeRosterPut = v; }
  get rejectRosterPuts(): number { return this.store.rejectRosterPuts; }
  set rejectRosterPuts(v: number) { this.store.rejectRosterPuts = v; }

  async getRoster(): Promise<RosterOut | null> {
    this.guard('getRoster');
    return this.store.roster ? { ...this.store.roster } : null;
  }

  /** 実物（packages/cloud/src/keys.ts）と同じく、版が合えば 1 進め、印の行を進める。合わなければ 409 の代わりに ok: false と今の版。 */
  async putRoster(body: RosterPut): Promise<RosterPutResult> {
    this.guard('putRoster', body);
    if (!isEpoch(body.epoch) || !Number.isSafeInteger(body.ifVersion) || body.ifVersion < 0 || !fromBase64Url(body.sealed)) throw new CloudError(400, errorBody('invalid body'));
    const hook = this.store.beforeRosterPut;
    if (hook) {
      this.store.beforeRosterPut = null;
      await hook();
    }
    const cur = this.store.roster?.version ?? 0;
    if (this.store.rejectRosterPuts > 0) {
      this.store.rejectRosterPuts--;
      return { ok: false, version: cur };
    }
    if (body.ifVersion !== cur) return { ok: false, version: cur };
    this.store.roster = { version: cur + 1, sealed: body.sealed };
    this.touchRoster(body.epoch);
    return { ok: true, version: cur + 1 };
  }

  /** 自分宛ての keybox のうち、いちばん新しい世代の 1 つだけ（実物と同じ）。 */
  async getKeyboxes(): Promise<KeyboxesOut> {
    this.guard('getKeyboxes');
    const mine = this.store.keyboxes.get(this.deviceId);
    if (!mine || mine.size === 0) return { boxes: [] };
    const epoch = Math.max(...mine.keys());
    return { boxes: [{ epoch, sealed: mine.get(epoch)! }] };
  }

  /** keybox を置き、印の行を進める（PUT /keyboxes の真似。試験の口で、WireCloudClient には無い）。 */
  putKeybox(recipient: string, epoch: number, sealed: string): void {
    const mine = this.store.keyboxes.get(recipient) ?? new Map<number, string>();
    mine.set(epoch, sealed);
    this.store.keyboxes.set(recipient, mine);
    this.touchRoster(epoch);
  }

  /**
   * PUT /keyboxes。実物（packages/cloud/src/keys.ts）と同じく、1 回に MAX_KEYBOXES_PER_PUT 件まで。
   * 受け手は解除されていない PC か `recovery` で、ほかが 1 つでも混ざれば何も書かずに 400 で断る。
   * 参加リクエストを置いた PC（承認の前の受け手）は、offerJoin でその PC を置いた発行した PC だけが受け手にできる。
   * 書いたら印の行を、本文のいちばん新しい世代で進める。
   */
  async putKeyboxes(boxes: KeyboxIn[]): Promise<KeyboxesPutOut> {
    this.guard('putKeyboxes', boxes);
    const valid = (b: KeyboxIn): boolean => isEpoch(b?.epoch) && typeof b.recipient === 'string' && b.recipient.length > 0 && typeof b.sealed === 'string' && fromBase64Url(b.sealed) !== null;
    if (!Array.isArray(boxes) || boxes.length === 0 || boxes.length > MAX_KEYBOXES_PER_PUT || !boxes.every(valid)) throw new CloudError(400, errorBody('invalid body'));
    for (const b of boxes) {
      if (b.recipient === RECOVERY_RECIPIENT) continue;
      const d = this.store.devices.get(b.recipient);
      if (this.store.joinOffers.get(b.recipient) === this.deviceId && !d) continue;
      if (!d || d.kind !== 'pc' || d.revokedAt !== null) throw new CloudError(400, errorBody('unknown recipient'));
    }
    for (const b of boxes) {
      const mine = this.store.keyboxes.get(b.recipient) ?? new Map<number, string>();
      mine.set(b.epoch, b.sealed);
      this.store.keyboxes.set(b.recipient, mine);
    }
    this.touchRoster(Math.max(...boxes.map((b) => b.epoch)));
    return { written: boxes.length };
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    this.guard('health');
    return { ok: true, version: 'fake' };
  }

  async pushChanges(changes: SealedChangeIn[]): Promise<PushChangesResponse> {
    this.guard('pushChanges', changes);
    // 1 行でも形が違えば塊ごと断る。ストアには何も入れない。
    if (!Array.isArray(changes) || changes.length > MAX_PUSH_BATCH || !changes.every(isChange)) throw new CloudError(400, errorBody('invalid body'));
    // 大きすぎる行は k で名指しして 413 に落とす（Worker と同じく、重複を畳む前に見る）。
    // 名指しは先頭の 1 件だけにする。全部並べると本文が 200 字を超え、CloudError が持てなくなる。
    const oversize = changes.filter((x) => x.sealed.length > MAX_ROW_BYTES);
    if (oversize.length) {
      const first = oversize[0]!;
      throw new CloudError(413, JSON.stringify({ error: 'payload too large', limit: MAX_ROW_BYTES, count: oversize.length, row: { k: first.k, bytes: first.sealed.length } }));
    }
    if (!changes.every((x) => isSealedText(x.sealed, MAX_ROW_BYTES))) throw new CloudError(400, errorBody('invalid body'));
    let accepted = 0;
    let skipped = 0;
    // 同じ鍵の重複は updatedAt の大きい方だけを見る（Worker と同じ数え方）。
    const latest = new Map<string, SealedChangeIn>();
    for (const ch of changes) {
      const cur = latest.get(ch.k);
      if (!cur) latest.set(ch.k, ch);
      else { skipped++; if (ch.updatedAt > cur.updatedAt) latest.set(ch.k, ch); }
    }
    for (const [k, ch] of latest) {
      const prev = this.store.rows.get(k);
      if (prev && prev.updatedAt >= ch.updatedAt) { skipped++; continue; }
      const row: FakeRow = { seq: ++this.store.seq, k, op: ch.op, updatedAt: ch.updatedAt, deviceId: this.deviceId, epoch: ch.epoch, sealed: fromBase64Url(ch.sealed)! };
      // 書き換えた行は末尾の連番で入り直す（Map の並びも末尾へ移す）。
      this.store.rows.delete(k);
      this.store.rows.set(k, row);
      this.store.changes.push(row);
      accepted++;
    }
    return { seq: this.maxSeq(), accepted, skipped };
  }

  /** 表の連番の高水位（Worker の max(seq)）。 */
  private maxSeq(): number {
    let m = 0;
    for (const r of this.store.rows.values()) m = Math.max(m, r.seq);
    return m;
  }

  /**
   * 実物の GET /changes と同じく、rows から自端末以外の行を連番の順に引く。名簿の印の行もほかの行と同じく返す。
   * 変更ログを持たないので、どれだけ古い since でも断らない。
   * 最後まで返せたときの nextSeq は表の末尾の連番（max(seq)）で、since をそのまま返さない。
   * 解除していない PC の最終確認（peers）と、Worker の時刻（now）を添える。
   */
  async pullChanges(since: number, limit: number): Promise<SealedPullChangesResponse> {
    this.guard('pullChanges', since, limit);
    const n = clampLimit(limit);
    const all = [...this.store.rows.values()].filter((c) => c.seq > since && c.deviceId !== this.deviceId).sort((x, y) => x.seq - y.seq);
    const { page, more } = cutPage(all, n);
    const peers = [...this.store.devices.values()]
      .filter((d) => d.revokedAt === null)
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((d) => ({ id: d.id, lastSeenAt: d.lastSeenAt }));
    const now = this.store.now();
    const res: SealedPullChangesResponse = { changes: page.map(toOut), nextSeq: more ? page[page.length - 1]!.seq : this.maxSeq(), more, peers, now };
    // 版 7 の Worker は、この PC 宛ての、まだ受け取られていない TTL の内の依頼を、どの頁にも添える。版 6 は載せない。
    if (this.store.workerCompat >= MOBILE_MIN_WORKER_COMPAT) res.launches = this.pendingLaunches(now);
    return res;
  }

  private pendingLaunches(now: number): MobileLaunchOut[] {
    return [...this.store.launches.values()]
      .filter((l) => l.targetDevice === this.deviceId && l.status === 'pending' && l.createdAt > now - LAUNCH_TTL_MS)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, PULL_LAUNCH_LIMIT)
      .map((l) => ({ id: l.id, createdAt: l.createdAt, sealed: l.sealed, epoch: l.epoch, from: l.fromDevice }));
  }

  /**
   * スマホの POST /m/launches の真似（試験が依頼を置くための口で、WireCloudClient には無い）。
   * 置いた時刻は Worker の時計で、同じ ID の再送は行を増やさない。
   * 実物どおり、epoch（封じたスマホ用の鍵の世代、互換の版 9）が正の整数でなければ 400 で断る。
   */
  postLaunch(l: MobileLaunchIn): void {
    if (ENC.encode(JSON.stringify(l)).byteLength > MAX_LAUNCH_BODY_BYTES) throw new CloudError(413, errorBody('payload too large'));
    if (!isEpoch(l.epoch)) throw new CloudError(400, errorBody('invalid body'));
    if (this.store.launches.has(l.id)) return;
    this.store.launches.set(l.id, { id: l.id, targetDevice: l.targetDevice, fromDevice: this.deviceId, createdAt: this.store.now(), sealed: l.sealed, status: 'pending', sealedAnswer: null, epoch: l.epoch });
  }

  /**
   * POST /m/launches/:id/claim。自分宛てで、まだ誰も受け取っておらず、TTL の内の行だけを claimed にして true を返す。
   * それ以外（2 回目、宛先でない PC、時間切れ、無い ID）は実物の 409 に当たる false である。版 7 より前の Worker は 404 で断る。
   */
  async claimLaunch(id: string): Promise<boolean> {
    this.guard('claimLaunch', id);
    if (this.store.workerCompat < MOBILE_MIN_WORKER_COMPAT) throw new CloudError(404, errorBody('not found'));
    const l = this.store.launches.get(id);
    if (!l || l.targetDevice !== this.deviceId || l.status !== 'pending' || l.createdAt <= this.store.now() - LAUNCH_TTL_MS) return false;
    l.status = 'claimed';
    return true;
  }

  /** POST /m/launches/:id/answer。自分が受け取った自分宛ての行だけを started か failed にする。それ以外は 409 で断る。 */
  async answerLaunch(id: string, ok: boolean, sealedAnswer: string): Promise<void> {
    this.guard('answerLaunch', id, ok, sealedAnswer);
    if (this.store.workerCompat < MOBILE_MIN_WORKER_COMPAT) throw new CloudError(404, errorBody('not found'));
    if (ENC.encode(JSON.stringify({ ok, sealedAnswer })).byteLength > MAX_ANSWER_BODY_BYTES) throw new CloudError(413, errorBody('payload too large'));
    if (sealedAnswer.length === 0) throw new CloudError(400, errorBody('invalid body'));
    const l = this.store.launches.get(id);
    if (!l || l.targetDevice !== this.deviceId || l.status !== 'claimed') throw new CloudError(409, errorBody('conflict'));
    l.status = ok ? 'started' : 'failed';
    l.sealedAnswer = sealedAnswer;
    // 実物は答えが通ったら、その依頼の画像を消す。
    for (const k of [...this.store.mobileBlobs.keys()]) if (k.startsWith(`${id}/`)) this.store.mobileBlobs.delete(k);
  }

  /** 実物の GET /rows と同じく、rows の写しを k の順に返す。自端末の行も、名簿の印の行も含める。 */
  async snapshot(after: string | null, limit: number): Promise<SealedSnapshotResponse> {
    this.guard('snapshot', after, limit);
    const n = clampLimit(limit);
    const all = [...this.store.rows.values()].filter((r) => r.k > (after ?? '')).sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
    const { page, more } = cutPage(all, n);
    return { changes: page.map(toOut), nextAfter: more ? page[page.length - 1]!.k : null, seq: this.maxSeq() };
  }

  /**
   * 鍵の形と権限（実物の validKey と同じ）。
   * 鍵は `b/<端末 ID>/<HMAC>`（shared の isBlobKey）だけを受け、書けるのは自端末の下（`b/<自分>/`）だけ。GET は誰でも。
   */
  private checkKey(key: string, write: boolean): void {
    if (!isBlobKey(key)) throw new CloudError(400, errorBody('invalid key'));
    if (write && !key.startsWith(`b/${this.deviceId}/`)) throw new CloudError(403, errorBody('forbidden'));
  }

  /**
   * 見出しで届くメタの検査。実物の PUT /files/:key（互換の版 9）と同じところで同じ 400 を出す。
   * パス、平文の SHA-256、mtime は封じたメタの中にあり、Worker も偽物も開けない。
   */
  private checkMeta(meta: SealedFileIn): void {
    const bad = (): never => { throw new CloudError(400, errorBody('invalid headers')); };
    if (meta.kind !== 'transcript' && meta.kind !== 'config') bad();
    if (!isInt(meta.size) || !Number.isSafeInteger(meta.size) || !isEpoch(meta.epoch)) bad();
    if (typeof meta.sealedMeta !== 'string' || !isSealedText(meta.sealedMeta, MAX_SEALED_META_CHARS)) bad();
  }

  /**
   * 検査を通さずに置く。
   * 上げる側の検査を迂回して、受け取る側の守りだけを試すための入口である。
   * 実物の Worker にこの口は無い。
   */
  seedUnchecked(meta: SealedFileIn, body: Buffer): { seq: number } {
    const seq = ++this.store.fileSeq;
    this.store.files.set(meta.key, {
      entry: { ...meta, seq, deviceId: this.deviceId, uploadedAt: this.store.now(), storedSize: body.length },
      body,
    });
    return { seq };
  }

  async putFile(meta: SealedFileIn, body: Readable): Promise<{ seq: number }> {
    this.guard('putFile', meta);
    this.checkKey(meta.key, true);
    this.checkMeta(meta);
    let chunks: Buffer[] = [];
    let total = 0;
    for await (const c of body) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
      total += b.length;
      // 上限を超えたら、抱えていた分を放して断る。Worker も読み取りを畳んで何も残さない。
      if (total > MAX_BODY_BYTES) {
        chunks = [];
        throw new CloudError(413, errorBody('too large'));
      }
      chunks.push(b);
    }
    const buf = Buffer.concat(chunks);
    // 置き直すと新しい seq になる（Worker は古い索引を消して入れ直す）。
    const seq = ++this.store.fileSeq;
    this.store.files.set(meta.key, {
      entry: { key: meta.key, kind: meta.kind, size: meta.size, epoch: meta.epoch, sealedMeta: meta.sealedMeta, seq, deviceId: this.deviceId, uploadedAt: this.store.now(), storedSize: buf.length },
      body: buf,
    });
    return { seq };
  }

  async getFile(key: string): Promise<Readable> {
    this.guard('getFile', key);
    this.checkKey(key, false);
    const f = this.store.files.get(key);
    if (!f) throw new CloudError(404, errorBody('not found'));
    return Readable.from([Buffer.from(f.body)]);
  }

  async listFiles(since: number, limit: number): Promise<SealedListFilesResponse> {
    this.guard('listFiles', since, limit);
    const n = clampLimit(limit);
    const entries = [...this.store.files.values()].map((f) => f.entry);
    const all = entries.filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, n);
    const more = all.length > n;
    // 端末が送ってきた since を返さない（実物の GET /files と同じ形）。
    // 返すと、一度でも壊れた since を控えた端末の一覧が、その値のまま固まって永久に空になる。
    const nextSeq = more ? page[page.length - 1]!.seq : entries.reduce((m, e) => Math.max(m, e.seq), 0);
    return { files: page.map((e) => ({ ...e })), nextSeq, more };
  }

  /**
   * DELETE /blobs。実物（packages/cloud/src/files.ts）と同じ規則で消す。
   * 自分の端末 ID の下だけ、置いてから 1 時間たったものだけ、1 日（UTC）500 件まで。
   * 残りが 0 なら 429、足りなければ残りの分だけ消してあふれた分を refused に入れる。索引に無い自分の鍵は消えたものとして deleted に入れる。
   */
  async deleteBlobs(keys: string[]): Promise<BlobsDeleteOut> {
    this.guard('deleteBlobs', keys);
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_BLOB_DELETE_KEYS || !keys.every((k) => typeof k === 'string' && isBlobKey(k))) {
      throw new CloudError(400, errorBody('invalid body'));
    }
    const now = this.store.now();
    const cutoff = now - BLOB_DELETE_GRACE_MS;
    const own = `b/${this.deviceId}/`;
    const refused: string[] = [];
    const eligible = [...new Set(keys)].filter((k) => {
      const at = this.store.files.get(k)?.entry.uploadedAt;
      const ok = k.startsWith(own) && !(at !== undefined && at >= cutoff);
      if (!ok) refused.push(k);
      return ok;
    });
    if (eligible.length === 0) return { deleted: [], refused };
    const day = new Date(now).toISOString().slice(0, 10);
    const cur = this.store.blobDeletes.get(this.deviceId);
    const used = cur?.day === day ? cur.n : 0;
    const granted = Math.max(0, Math.min(eligible.length, BLOB_DELETE_DAILY - used));
    if (granted === 0) throw new CloudError(429, JSON.stringify({ error: 'too many deletes', limit: BLOB_DELETE_DAILY }));
    this.store.blobDeletes.set(this.deviceId, { day, n: used + granted });
    const taken = eligible.slice(0, granted);
    refused.push(...eligible.slice(granted));
    for (const k of taken) this.store.files.delete(k);
    return { deleted: taken, refused };
  }

  /** この端末が今日（偽の Worker の時計の UTC）消した数。試験が 1 日の上限を使い切った状態を作るのに使う。 */
  get blobDeletesToday(): number {
    const day = new Date(this.store.now()).toISOString().slice(0, 10);
    const cur = this.store.blobDeletes.get(this.deviceId);
    return cur?.day === day ? cur.n : 0;
  }
  set blobDeletesToday(n: number) {
    this.store.blobDeletes.set(this.deviceId, { day: new Date(this.store.now()).toISOString().slice(0, 10), n });
  }

  /** 参加を承認した PC の行を置く（参加の口の真似。試験の口で、WireCloudClient には無い）。 */
  addDevice(id: string): void {
    if (!this.store.devices.has(id)) this.store.devices.set(id, newDevice(id, this.store.now()));
  }

  /** この PC が発行した参加コードに、id の PC がリクエストを置いた（承認の前。試験の口で、WireCloudClient には無い）。 */
  offerJoin(id: string): void {
    this.store.joinOffers.set(id, this.deviceId);
  }

  /** 承認された PC が端末トークンを受け取った（試験の口）。以後はふつうの PC として受け手になれる。 */
  redeemJoin(id: string): void {
    this.store.joinOffers.delete(id);
    this.addDevice(id);
  }

  /** 偽の Worker が保存した値の全部（D1 の表と R2 に当たるもの）。平文が残っていないかを走査する試験が読む。 */
  storeForScan(): Readonly<Pick<FakeCloudStore, 'changes' | 'rows' | 'files' | 'devices' | 'roster' | 'keyboxes' | 'mobileFeeds' | 'mobilePairings' | 'phoneKeyboxes' | 'launches' | 'mobileBlobs' | 'blobDeletes' | 'notices'>> {
    return this.store;
  }

  /**
   * PUT /m/feed。版 7 より前の Worker はこの口を知らないので 404 で断る。
   * 本文の上限は実物（packages/cloud/src/mobile.ts の MAX_FEED_BODY_BYTES）と同じ 96 KiB。
   * epoch（素を封じたスマホ用の鍵の世代）が無いか形が違えば、実物の版 9 と同じく 400 で断る。
   */
  async putMobileFeed(sealed: string, epoch: number): Promise<void> {
    this.guard('putMobileFeed', sealed, epoch);
    if (this.store.workerCompat < MOBILE_MIN_WORKER_COMPAT) throw new CloudError(404, errorBody('not found'));
    if (ENC.encode(JSON.stringify({ sealed, epoch })).byteLength > MAX_FEED_BODY_BYTES) throw new CloudError(413, errorBody('payload too large'));
    if (typeof sealed !== 'string' || sealed.length === 0 || !isEpoch(epoch)) throw new CloudError(400, errorBody('invalid body'));
    this.store.mobileFeeds.set(this.deviceId, { sealed, updatedAt: this.store.now(), epoch });
  }

  /**
   * スマホの GET /m/inbox の feeds の真似（試験の口で、WireCloudClient には無い）。
   * 解除されていない PC の素だけを、端末の ID の順に返す。
   */
  inboxFeeds(): { deviceId: string; updatedAt: number; sealed: string; epoch: number }[] {
    return [...this.store.mobileFeeds.entries()]
      .filter(([id]) => { const d = this.store.devices.get(id); return !d || (d.kind === 'pc' && d.revokedAt === null); })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([deviceId, f]) => ({ deviceId, updatedAt: f.updatedAt, sealed: f.sealed, epoch: f.epoch }));
  }

  /** POST /m/pairings。券（22 字の乱数）を発行し、偽物にはハッシュだけを置く。期限は PAIRING_TTL_MS。 */
  async createPairing(): Promise<MobilePairingResponse> {
    this.guard('createPairing');
    if (this.store.workerCompat < MOBILE_MIN_WORKER_COMPAT) throw new CloudError(404, errorBody('not found'));
    const code = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const now = this.store.now();
    const codeHash = sha256Hex(Buffer.from(code, 'utf8'));
    this.store.mobilePairings.set(codeHash, { codeHash, createdBy: this.deviceId, createdAt: now, usedAt: null, deviceId: null, request: null });
    return { code, expiresAt: now + PAIRING_TTL_MS };
  }

  /**
   * スマホの POST /m/join の真似（試験の口で、WireCloudClient には無い）。トークンは要らない。
   * 無い券、使った券、期限切れの券は 401、既にある ID は 409 `device-exists`（券は残る）。
   * 通れば devices にスマホの行（kind 'mobile'）を足し、券にスマホの ID と封じた参加リクエストを置く。
   */
  joinPhone(body: MobileJoinRequest): MobileJoinResponse {
    if (this.store.offline) throw new CloudError(0, 'offline');
    const now = this.store.now();
    const p = this.store.mobilePairings.get(sha256Hex(Buffer.from(body.code, 'utf8')));
    if (!p || p.usedAt !== null || p.createdAt <= now - PAIRING_TTL_MS) throw new CloudError(401, errorBody('unauthorized'));
    if (this.store.devices.has(body.deviceId)) throw new CloudError(409, errorBody('device-exists'));
    p.usedAt = now;
    p.deviceId = body.deviceId;
    p.request = body.sealed;
    this.store.devices.set(body.deviceId, { id: body.deviceId, kind: 'mobile', joinedAt: now, lastSeenAt: now, revokedAt: null, expiresAt: now + 90 * 86_400_000 });
    return { token: `phone-token-${body.deviceId}`, deviceId: body.deviceId };
  }

  /**
   * GET /m/pairings/mine。自分の券のうち、まだ keybox の置かれていない参加リクエストを、券の発行の古い順に返す。
   * PC だけが呼べる（実物の requireKind('pc')）。
   */
  async getPairingsMine(): Promise<MobilePairingsMine> {
    this.guard('getPairingsMine');
    return {
      pairings: [...this.store.mobilePairings.values()]
        .filter((p) => p.createdBy === this.deviceId && p.request !== null && p.deviceId !== null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((p) => ({ codeHash: p.codeHash, deviceId: p.deviceId!, sealed: p.request!, joinedAt: p.usedAt! })),
    };
  }

  /**
   * PUT /phone-keyboxes。実物（packages/cloud/src/keys.ts）と同じく、受け手は解除されていないスマホだけで、
   * ほかが 1 つでも混ざれば何も書かずに 400 `unknown recipient` で断る。
   * 置いたスマホの参加リクエストを消す。名簿の印の行は進めない。
   */
  async putPhoneKeyboxes(boxes: KeyboxIn[]): Promise<KeyboxesPutOut> {
    this.guard('putPhoneKeyboxes', boxes);
    const valid = (b: KeyboxIn): boolean => isEpoch(b?.epoch) && typeof b.recipient === 'string' && b.recipient.length > 0 && typeof b.sealed === 'string' && fromBase64Url(b.sealed) !== null;
    if (!Array.isArray(boxes) || boxes.length === 0 || boxes.length > MAX_PHONE_KEYBOXES_PER_PUT || !boxes.every(valid)) throw new CloudError(400, errorBody('invalid body'));
    for (const b of boxes) {
      const d = this.store.devices.get(b.recipient);
      if (!d || d.kind !== 'mobile' || d.revokedAt !== null) throw new CloudError(400, errorBody('unknown recipient'));
    }
    for (const b of boxes) {
      const mine = this.store.phoneKeyboxes.get(b.recipient) ?? new Map<number, string>();
      mine.set(b.epoch, b.sealed);
      this.store.phoneKeyboxes.set(b.recipient, mine);
      for (const p of this.store.mobilePairings.values()) if (p.deviceId === b.recipient) p.request = null;
    }
    return { written: boxes.length };
  }

  /** スマホの GET /m/keybox の真似（試験の口で、WireCloudClient には無い）。自分宛てのいちばん新しい世代だけ。無ければ null（実物の 404）。 */
  phoneKeybox(phoneId: string): KeyboxOut | null {
    const mine = this.store.phoneKeyboxes.get(phoneId);
    if (!mine || mine.size === 0) return null;
    const epoch = Math.max(...mine.keys());
    return { epoch, sealed: mine.get(epoch)! };
  }

  /** DELETE /m/feed。自分の受信箱の素の行を消す。行が無くても成功する。版 8 より前の Worker は 404 で断る。 */
  async deleteMobileFeed(): Promise<void> {
    this.guard('deleteMobileFeed');
    if (this.store.workerCompat < MOBILE_BELL_MIN_WORKER_COMPAT) throw new CloudError(404, errorBody('not found'));
    this.store.mobileFeeds.delete(this.deviceId);
  }

  /**
   * POST /notices。実物（packages/cloud/src/push.ts の noticesApp）と同じ順で断る。
   * 本文が 8 KiB を超えれば 413、sealed が文字列でないか PHONE_NOTICE_SEALED_MAX 字を超えるか、頭の世代が epoch と違えば 400、
   * 同じ PC から NOTICE_RATE.windowMs の間に NOTICE_RATE.max 回を超えれば 429 である。
   * 通れば notices に積む。偽物には購読が無いので、送った数は 0 で返す。noticeRoute が偽なら、口を知らない Worker として 404 で断る。
   */
  async postNotice(sealed: string, epoch: number): Promise<NoticeOut> {
    this.guard('postNotice', sealed, epoch);
    if (!this.store.noticeRoute) throw new CloudError(404, errorBody('not found'));
    if (ENC.encode(JSON.stringify({ sealed, epoch })).byteLength > MAX_NOTICE_BODY_BYTES) throw new CloudError(413, errorBody('payload too large'));
    if (typeof sealed !== 'string' || sealed.length > PHONE_NOTICE_SEALED_MAX || !isEpoch(epoch) || phoneNoticeEpoch(sealed) !== epoch) throw new CloudError(400, errorBody('invalid body'));
    const now = this.store.now();
    const recent = this.store.notices.filter((n) => n.deviceId === this.deviceId && now - n.at < NOTICE_RATE.windowMs).length;
    if (recent >= NOTICE_RATE.max) throw new CloudError(429, errorBody('rate limited'));
    this.store.notices.push({ deviceId: this.deviceId, sealed, epoch, at: now });
    return { sent: 0, quiet: 0, removed: 0, failed: 0 };
  }

  /** スマホの PUT /m/blobs の真似（試験が画像を置くための口で、WireCloudClient には無い）。 */
  putBlob(launchId: string, n: number, bytes: Uint8Array): void {
    this.store.mobileBlobs.set(`${launchId}/${n}`, bytes);
  }

  /**
   * GET /m/blobs/<依頼>/<番号>。自分宛てで claimed の依頼の画像だけを返す。それ以外と、無いものは 404。
   * 版 8 より前の Worker は 404 で断る。
   */
  async getMobileBlob(launchId: string, n: number): Promise<Uint8Array> {
    this.guard('getMobileBlob', launchId, n);
    if (this.store.workerCompat < MOBILE_BELL_MIN_WORKER_COMPAT) throw new CloudError(404, errorBody('not found'));
    const l = this.store.launches.get(launchId);
    const b = this.store.mobileBlobs.get(`${launchId}/${n}`);
    if (!l || l.targetDevice !== this.deviceId || l.status !== 'claimed' || !b) throw new CloudError(404, errorBody('not found'));
    return b.slice();
  }

  /** GET /usage の応答。試験が差し替える。既定はトークンの無い Worker と同じ。 */
  usageBody: CloudUsageBody = { configured: false };

  async usage(): Promise<CloudUsageBody> {
    this.guard('usage');
    return structuredClone(this.usageBody);
  }
}

/** 試験の既定の鍵の束。どの端末も同じ作り物の世代鍵（testCloudConfig の世代 1）を持つ。 */
const defaultKeyring = (): Promise<Keyring> => Keyring.fromConfig(testCloudConfig());

type FakeCloudOptions = FakeWireOptions & {
  /** 包む偽の Worker。省くと新しいストアで作る。 */
  wire?: FakeWireClient;
  /** この端末の鍵の束。省くと既定の世代 1 だけを持つ。 */
  keyring?: Keyring | Promise<Keyring>;
  /** 名簿の印の行と、知らない世代の行を受けたときの読み直し（SealedCloudClient の onRoster）。 */
  onRoster?: () => Promise<void>;
};

/**
 * 開いた形で話す偽物。偽の Worker（FakeWireClient）を本物と同じ SealedCloudClient で包む。
 * 行は封じてから偽の Worker に届くので、ストアには封じた形だけが残る。
 * 偽の Worker の取っ手（offline、workerCompat、calls など）はそのまま見せる。
 * 何を送ったかを開いた形で見るときは opened() を使う。
 */
export class FakeCloudClient implements CloudClient {
  readonly wire: FakeWireClient;
  private readonly sealed: SealedCloudClient;
  /** この端末の鍵の束。本文の鍵名を求める部品（uploader、設定の同期）にも同じものを渡す。 */
  readonly keyring: Promise<Keyring>;

  constructor(o: FakeCloudOptions = {}) {
    this.wire = o.wire ?? new FakeWireClient(o);
    this.keyring = Promise.resolve(o.keyring ?? defaultKeyring());
    this.sealed = new SealedCloudClient(this.wire, this.keyring, this.wire.deviceId, { onRoster: o.onRoster });
  }

  /** 同じストアを別の端末として使う。鍵の束と読み直しは、渡さなければ既定のもの。 */
  asDevice(deviceId: string, o: { keyring?: Keyring | Promise<Keyring>; onRoster?: () => Promise<void> } = {}): FakeCloudClient {
    return new FakeCloudClient({ wire: this.wire.asDevice(deviceId), ...o });
  }

  get deviceId(): string { return this.wire.deviceId; }
  get minWorkerCompat(): number { return this.wire.minWorkerCompat; }
  get calls(): { method: string; args: unknown[] }[] { return this.wire.calls; }
  get offline(): boolean { return this.wire.offline; }
  set offline(v: boolean) { this.wire.offline = v; }
  get unauthorized(): boolean { return this.wire.unauthorized; }
  set unauthorized(v: boolean) { this.wire.unauthorized = v; }
  get workerCompat(): number { return this.wire.workerCompat; }
  set workerCompat(v: number) { this.wire.workerCompat = v; }
  get minDeviceCompat(): number { return this.wire.minDeviceCompat; }
  set minDeviceCompat(v: number) { this.wire.minDeviceCompat = v; }
  get limited(): CloudLimitKind | null { return this.wire.limited; }
  set limited(v: CloudLimitKind | null) { this.wire.limited = v; }
  /** 採った行の控え（封じた形）。 */
  get changes(): FakeRow[] { return this.wire.changes; }
  /** Worker の rows（封じた形）。 */
  get rows(): Map<string, FakeRow> { return this.wire.rows; }
  get files(): Map<string, StoredFile> { return this.wire.files; }
  get mobileFeeds(): Map<string, FakeFeed> { return this.wire.mobileFeeds; }
  get launches(): Map<string, FakeLaunch> { return this.wire.launches; }
  get mobileBlobs(): Map<string, Uint8Array> { return this.wire.mobileBlobs; }
  get notices(): FakeNotice[] { return this.wire.notices; }
  get usageBody(): CloudUsageBody { return this.wire.usageBody; }
  set usageBody(v: CloudUsageBody) { this.wire.usageBody = v; }

  /** 採った行の控えを、この端末の鍵で開いて届いた順に返す。開けない行は入れない。 */
  async opened(): Promise<ChangeOut[]> {
    const ring = await this.keyring;
    const out = await Promise.all(this.wire.changes.map((r) => openSealedRow(ring, toOut(r))));
    return out.filter((c): c is ChangeOut => c !== null);
  }

  /** この端末が今の世代で上げる本文の R2 の鍵名（uploader と同じ求め方）。 */
  async transcriptKey(uuid: string, agentId: string | null = null, origin = this.deviceId): Promise<string> {
    return (await blobKeyFor((await this.keyring).current().index, this.deviceId, 'transcript', origin, agentId === null ? `projects/-x/${uuid}.jsonl` : `projects/-x/${uuid}/subagents/agent-${agentId}.jsonl`))!;
  }

  /** この端末が今の世代で上げる opencode の本文（書き出した JSON）の R2 の鍵名。 */
  async opencodeKey(sessionId: string, origin = this.deviceId): Promise<string> {
    return (await blobKeyFor((await this.keyring).current().index, this.deviceId, 'transcript', origin, `opencode/${sessionId}.json`))!;
  }

  /** この端末が今の世代で上げる Codex の本文（rollout）の R2 の鍵名。鍵名は thread の UUID だけで決まり、置き場と名前に依らない。 */
  async codexKey(threadId: string, origin = this.deviceId): Promise<string> {
    return (await blobKeyFor((await this.keyring).current().index, this.deviceId, 'transcript', origin, `codex/archived_sessions/rollout-2026-01-01T00-00-00-${threadId}.jsonl`))!;
  }

  /** この端末が今の世代で上げる設定のファイルの R2 の鍵名。 */
  async configKey(rel: string, origin = this.deviceId): Promise<string> {
    return (await blobKeyFor((await this.keyring).current().index, this.deviceId, 'config', origin, rel))!;
  }

  /**
   * この端末として平文の本文を上げる（試験の下ごしらえ）。鍵名は中身のパスから今の世代で求め、key を渡せば差し替える。
   * sha256 と size は、渡さなければ本文から求める。
   */
  async putText(meta: { path: string; kind?: FileKind; mtime?: number; origin?: string; sha256?: string; size?: number; key?: string }, body: string | Buffer): Promise<{ seq: number; key: string }> {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const kind = meta.kind ?? 'transcript';
    const origin = meta.origin ?? this.deviceId;
    const cur = (await this.keyring).current();
    const key = meta.key ?? (await blobKeyFor(cur.index, this.deviceId, kind, origin, meta.path));
    if (key === null) throw new Error(`no blob key for ${meta.path}`);
    const full: FileMetaIn = { key, epoch: cur.epoch, kind, path: meta.path, sha256: meta.sha256 ?? sha256Hex(buf), size: meta.size ?? buf.length, mtime: meta.mtime ?? 1_700_000_000_000, origin };
    const { seq } = await this.sealed.putFile(full, Readable.from([buf]));
    return { seq, key };
  }

  /** 偽の Worker に置いた 1 件を、この端末の鍵で開いて返す。開けなければ null。body は復号して gzip を解いた平文。 */
  async openedFile(key: string): Promise<{ entry: FileEntry; body: Buffer } | null> {
    const f = this.wire.files.get(key);
    if (!f) return null;
    const ring = await this.keyring;
    const entry = await openSealedFile(ring, f.entry);
    if (!entry) return null;
    return { entry, body: gunzipSync(await decryptBuffer(fileKeyFrom(ring.at(entry.epoch)!.fileBytes), f.body)) };
  }

  /** 偽の Worker に置いたものを全部開いて、seq の順に返す。開けないものは入れない。 */
  async openedFiles(): Promise<FileEntry[]> {
    const ring = await this.keyring;
    const out = await Promise.all([...this.wire.files.values()].map((f) => openSealedFile(ring, f.entry)));
    return out.filter((e): e is FileEntry => e !== null).sort((a, b) => a.seq - b.seq);
  }

  /** 平文を gzip して、その世代（省くと今の世代）の本文の鍵で暗号化したバイト列。置いた本体を差し替える試験に使う。 */
  async sealBody(plain: string | Buffer, epoch?: number): Promise<Buffer> {
    const ring = await this.keyring;
    const keys = epoch === undefined ? ring.current() : ring.at(epoch)!;
    return encryptBuffer(fileKeyFrom(keys.fileBytes), gzipSync(Buffer.isBuffer(plain) ? plain : Buffer.from(plain)));
  }

  revoke(deviceId: string): void { this.wire.revoke(deviceId); }
  unrevoke(deviceId: string): void { this.wire.unrevoke(deviceId); }
  touchRoster(epoch: number): void { this.wire.touchRoster(epoch); }
  postLaunch(l: MobileLaunchIn): void { this.wire.postLaunch(l); }
  putBlob(launchId: string, n: number, bytes: Uint8Array): void { this.wire.putBlob(launchId, n, bytes); }
  seedUnchecked(meta: SealedFileIn, body: Buffer): { seq: number } { return this.wire.seedUnchecked(meta, body); }

  health(): Promise<{ ok: boolean; version: string }> { return this.wire.health(); }
  pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse> { return this.sealed.pushChanges(changes); }
  pullChanges(since: number, limit: number): Promise<OpenedPullResponse> { return this.sealed.pullChanges(since, limit); }
  snapshot(after: string | null, limit: number): Promise<OpenedSnapshotResponse> { return this.sealed.snapshot(after, limit); }
  refreshKeys(epochs: number[]): Promise<KeyRefresh> { return this.sealed.refreshKeys(epochs); }
  putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> { return this.sealed.putFile(meta, body); }
  getFile(key: string, epoch: number): Promise<Readable> { return this.sealed.getFile(key, epoch); }
  listFiles(since: number, limit: number): Promise<ListFilesResponse> { return this.sealed.listFiles(since, limit); }
  usage(): Promise<CloudUsageBody> { return this.wire.usage(); }
  listDevices(): Promise<DeviceOut[]> { return this.wire.listDevices(); }
  revokeDevice(id: string): Promise<DeviceOut> { return this.wire.revokeDevice(id); }
  lastWorkerCompat(): number | null { return this.wire.lastWorkerCompat(); }
  putMobileFeed(sealed: string, epoch: number): Promise<void> { return this.wire.putMobileFeed(sealed, epoch); }
  createPairing(): Promise<MobilePairingResponse> { return this.wire.createPairing(); }
  deleteMobileFeed(): Promise<void> { return this.wire.deleteMobileFeed(); }
  postNotice(sealed: string, epoch: number): Promise<NoticeOut> { return this.wire.postNotice(sealed, epoch); }
  claimLaunch(id: string): Promise<boolean> { return this.wire.claimLaunch(id); }
  answerLaunch(id: string, ok: boolean, sealedAnswer: string): Promise<void> { return this.wire.answerLaunch(id, ok, sealedAnswer); }
  getMobileBlob(launchId: string, n: number): Promise<Uint8Array> { return this.wire.getMobileBlob(launchId, n); }
  deleteBlobs(keys: string[]): Promise<BlobsDeleteOut> { return this.wire.deleteBlobs(keys); }
}

/** seedCloud に渡す 1 台の PC。鍵ペアは本物の X25519（keybox を開くため）。 */
export type SeedPc = { id: string; name: string; os?: string; keyPair: KeyPairRaw };
/** seedCloud の結果。configs は各 PC の cloud.json（参加の後に書くはずのもの）。 */
export type SeededCloud = { wire: FakeWireClient; roster: Roster; configs: Record<string, CloudConfig> };

/**
 * 参加を済ませた状態の偽のクラウドを作る（参加の口は Task 14 で入るので、それまでの試験の道具）。
 * PC ごとに devices の行を置き、名簿（名前と OS と公開鍵）を今の世代の `/roster` の鍵で封じて置き、
 * 各 PC 宛ての keybox（世代鍵の一覧）をその PC の公開鍵で封じて置く。
 * 名簿と keybox は Worker の口（PUT /roster と keybox の置き場）を通すので、印の行も進む。
 */
export async function seedCloud(
  pcs: SeedPc[],
  o: { wire?: FakeWireClient; epochs?: Record<string, string>; currentEpoch?: number; recoveryPub?: string } = {},
): Promise<SeededCloud> {
  const epochs = o.epochs ?? { '1': testKey(3) };
  const currentEpoch = o.currentEpoch ?? Math.max(...Object.keys(epochs).map(Number));
  const wire = o.wire ?? new FakeWireClient({ deviceId: pcs[0]?.id ?? 'self' });
  const ring = await Keyring.fromConfig(testCloudConfig({ epochs, currentEpoch }));
  for (const pc of pcs) wire.addDevice(pc.id);
  const roster: Roster = {
    v: 1,
    entries: pcs.map((pc) => ({ id: pc.id, kind: 'pc', name: pc.name, os: pc.os ?? 'darwin', pub: pc.keyPair.pub, joinedAt: 1 })),
    recoveryPub: o.recoveryPub ?? testKey(8),
    phoneKey: null,
  };
  const version = wire.roster?.version ?? 0;
  const put = await wire.putRoster({ ifVersion: version, epoch: currentEpoch, sealed: toBase64Url(await sealRoster(ring.current().roster, version + 1, roster)) });
  if (!put.ok) throw new Error('seedCloud: the roster changed while seeding');
  const configs: Record<string, CloudConfig> = {};
  for (const pc of pcs) {
    const box = await sealKeybox(pc.keyPair.pub, { epoch: currentEpoch, recipient: pc.id }, encodeEpochList({ epochs }));
    wire.putKeybox(pc.id, currentEpoch, toBase64Url(box));
    configs[pc.id] = testCloudConfig({ keyPair: pc.keyPair, epochs: { ...epochs }, currentEpoch, rosterVersion: 0 });
  }
  return { wire, roster, configs };
}
