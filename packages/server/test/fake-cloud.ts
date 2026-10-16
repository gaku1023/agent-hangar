import { Readable } from 'node:stream';
import {
  COMPAT_VERSION,
  LAUNCH_TTL_MS,
  MAX_PUSH_BATCH,
  MOBILE_MIN_WORKER_COMPAT,
  PULL_LIMIT,
  SHARED_TABLES,
  decodeHeaderText,
  encodeHeaderText,
  isHeaderSafe,
  isSafeRelPath,
  type ChangeIn,
  type CloudDeviceOut,
  type CloudLimitKind,
  type CloudUsageBody,
  type ChangeOut,
  type FileEntry,
  type FileMetaIn,
  type ListFilesResponse,
  type MobileLaunchIn,
  type MobileLaunchOut,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
import { CloudError, CompatError, isValidFileKey, LimitError, MIN_WORKER_COMPAT, RevokedError, type CloudClient } from '../src/sync/client.ts';

type StoredFile = { entry: FileEntry; body: Buffer };

/** 端末をまたいで共有する中身。asDevice で作った別端末のクライアントも同じものを指す。 */
export type FakeCloudStore = {
  /**
   * 採った push の行を届いた順に積んだ控え。試験が「何を送ったか」を見るためだけのもので、pull は読まない。
   * 実物の Worker は変更ログを持たない（同期の版 6）。
   */
  changes: ChangeOut[];
  /** 鍵（表:行 ID）ごとの今の 1 行。実物の rows と同じく、書き換えると末尾の連番を受け取る。pull はここから引く。 */
  rows: Map<string, ChangeOut>;
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
  /** 参加している PC の行。要求を受けた端末を、初めて見たときに足す（実物は /join で足す）。 */
  devices: Map<string, CloudDeviceOut>;
  /** PC ごとの受信箱の素（PUT /m/feed）。実物の mobile_feeds の表に当たる。 */
  mobileFeeds: Map<string, { sealed: string; updatedAt: number }>;
  /** スマホからの起動の依頼（POST /m/launches）。実物の launch_requests の表に当たる。 */
  launches: Map<string, FakeLaunch>;
  now: () => number;
};

/** 偽物の Worker が持つ起動の依頼の 1 行。状態の進み方は実物（packages/cloud/src/mobile.ts）と同じ。 */
export type FakeLaunch = { id: string; targetDevice: string; createdAt: number; sealed: string; status: 'pending' | 'claimed' | 'started' | 'failed'; sealedAnswer: string | null };

const ENC = new TextEncoder();
const TABLES = new Set<string>(SHARED_TABLES);

/**
 * 実物の Worker が持つ大きさの上限である。
 * 原本は `packages/cloud/src/changes.ts` と `packages/cloud/src/files.ts` にあり、
 * `packages/server` はそのパッケージに依存しないので、ここに写しを置く。
 * 数が実物とずれていないことは `fake-cloud.test.ts` の「上限は実物の Worker と同じ数である」が
 * 原本を読んで縛る。偽物が実物より甘いと、本番でだけ 413 で断られる行と本文ができる。
 */
export const MAX_ROW_BYTES = 128 * 1024;
export const MAX_ROW_ID_CHARS = 64;
export const MAX_BODY_BYTES = 100 * 1024 * 1024;
/** PUT /m/feed の本文の上限（packages/cloud/src/mobile.ts の MAX_FEED_BODY_BYTES の写し）。 */
export const MAX_FEED_BODY_BYTES = 96 * 1024;
/** 起動の依頼の本文の上限（packages/cloud/src/mobile.ts の MAX_LAUNCH_BODY_BYTES の写し）。 */
export const MAX_LAUNCH_BODY_BYTES = 48 * 1024;
/** 応答の本文の上限（packages/cloud/src/mobile.ts の MAX_ANSWER_BODY_BYTES の写し）。 */
export const MAX_ANSWER_BODY_BYTES = 16 * 1024;
/** 1 回の pull に載せる起動の依頼の数（packages/cloud/src/changes.ts の PULL_LAUNCH_LIMIT の写し）。 */
export const PULL_LAUNCH_LIMIT = 50;

/**
 * 実物の Worker が端末に求める互換の版の下限（packages/cloud/src/compat.ts の写し）。
 * ずれていないことは fake-cloud.test.ts の「端末に求める下限は実物の Worker の写し」が原本を読んで縛る。
 */
export const MIN_DEVICE_COMPAT = 6;

/**
 * 実物の Worker が最終確認（devices.last_seen_at）を書き直す間隔（packages/cloud/src/seen.ts の写し）。
 * ずれていないことは fake-cloud.test.ts の「上限は実物の Worker と同じ数である」が原本を読んで縛る。
 */
export const TOUCH_EVERY_MS = 60_000;

/** 断りの本文は Worker と同じ JSON にする。CloudError.message がそのまま実物と揃う。 */
const errorBody = (error: string): string => JSON.stringify({ error });

/**
 * Worker の isChange（packages/cloud/src/changes.ts）と同じ検査。
 * ここを甘くすると、実物なら 400 で塊ごと断られる行を偽物が受け取ってしまう。
 * push は失敗しても行を残して再送するので、甘い偽物は本番で「同じ 40 行を永久に送り続ける」を作る。
 */
function isChange(v: unknown): v is ChangeIn {
  const c = v as Partial<ChangeIn> | null;
  return (
    !!c &&
    typeof c.tableName === 'string' &&
    TABLES.has(c.tableName) &&
    typeof c.rowId === 'string' &&
    c.rowId.length > 0 &&
    (c.op === 'upsert' || c.op === 'delete') &&
    typeof c.payload === 'object' &&
    c.payload !== null &&
    !Array.isArray(c.payload) &&
    typeof c.updatedAt === 'number' &&
    Number.isFinite(c.updatedAt)
  );
}

/** Worker の clampLimit と同じ丸め。0 と NaN は既定、負の数は 1、上限は PULL_LIMIT。 */
const clampLimit = (v: number): number => Math.min(Math.max(Number(v) || PULL_LIMIT, 1), PULL_LIMIT);

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Worker と同じ規則（入力の検査、LWW、自端末の除外、鍵の権限、rows の連番、生存の知らせ）をメモリ上で再現する偽物。
 * asDevice で同じストアを別端末として使えるので、2 端末の同期をそのまま書ける。
 * 本物の fetch は一切呼ばない。
 */
export class FakeCloudClient implements CloudClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly store: FakeCloudStore;
  readonly deviceId: string;
  /** この端末が Worker に求める互換の版の下限。HttpCloudClient の minWorkerCompat に当たる。 */
  readonly minWorkerCompat: number;
  private seenWorkerCompat: number | null = null;

  constructor(o: { deviceId?: string; store?: FakeCloudStore; now?: () => number; minWorkerCompat?: number } = {}) {
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
      mobileFeeds: new Map(),
      launches: new Map(),
      now: o.now ?? (() => Date.now()),
    };
    if (o.store && o.now) this.store.now = o.now;
  }

  get offline(): boolean { return this.store.offline; }
  set offline(v: boolean) { this.store.offline = v; }
  /** true の間、全メソッドが 401 を投げる。参加用の秘密を回した後と端末の行を消した後の筋を書くために使う。 */
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
  get changes(): ChangeOut[] { return this.store.changes; }
  get rows(): Map<string, ChangeOut> { return this.store.rows; }
  get files(): Map<string, StoredFile> { return this.store.files; }
  get mobileFeeds(): Map<string, { sealed: string; updatedAt: number }> { return this.store.mobileFeeds; }
  get launches(): Map<string, FakeLaunch> { return this.store.launches; }

  /**
   * 同じストアを別の端末として使うクライアント。2 端末の同期のテストはこれで書く。
   * Worker に求める下限（minWorkerCompat）は、作った元のクライアントのものを引き継ぐ。
   */
  asDevice(deviceId: string): FakeCloudClient {
    return new FakeCloudClient({ deviceId, store: this.store, minWorkerCompat: this.minWorkerCompat });
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
    const row = this.store.devices.get(this.deviceId) ?? { id: this.deviceId, name: this.deviceId, platform: 'darwin', joinedAt: now, lastSeenAt: null, revokedAt: null, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null };
    // 解除した PC の端末トークンは、Worker が 401 の revoked で断る。
    if (row.revokedAt !== null) throw new RevokedError();
    // 最終確認は、前回から TOUCH_EVERY_MS たったときだけ書く（実物の touchIfDue）。
    const due = row.lastSeenAt === null || now - row.lastSeenAt >= TOUCH_EVERY_MS;
    this.store.devices.set(this.deviceId, due ? { ...row, lastSeenAt: now } : row);
  }

  /** 端末を解除した状態にする（ほかの PC から解除された筋）。 */
  revoke(deviceId: string): void {
    const now = this.store.now();
    const row = this.store.devices.get(deviceId) ?? { id: deviceId, name: deviceId, platform: 'darwin', joinedAt: now, lastSeenAt: null, revokedAt: null, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null };
    this.store.devices.set(deviceId, { ...row, revokedAt: row.revokedAt ?? now });
  }

  /** 解除を外す（参加し直した筋）。 */
  unrevoke(deviceId: string): void {
    const row = this.store.devices.get(deviceId);
    if (row) this.store.devices.set(deviceId, { ...row, revokedAt: null, joinedAt: this.store.now() });
  }

  async listDevices(): Promise<CloudDeviceOut[]> {
    this.guard('listDevices');
    return [...this.store.devices.values()].map((d) => ({ ...d }));
  }

  async revokeDevice(id: string): Promise<CloudDeviceOut> {
    this.guard('revokeDevice', id);
    if (!this.store.devices.has(id)) throw new CloudError(404, errorBody('not found'));
    this.revoke(id);
    return { ...this.store.devices.get(id)! };
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    this.guard('health');
    return { ok: true, version: 'fake' };
  }

  async pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse> {
    this.guard('pushChanges', changes);
    // 1 行でも形が違えば塊ごと断る。ストアには何も入れない。
    if (!Array.isArray(changes) || changes.length > MAX_PUSH_BATCH || !changes.every(isChange)) throw new CloudError(400, errorBody('invalid body'));
    // 大きすぎる行は名指しで 413 に落とす（Worker と同じく、重複を畳む前に見る）。
    // 名指しは先頭の 1 件だけにする。全部並べると本文が 200 字を超え、CloudError が持てなくなる。
    const oversize = changes
      .map((row) => ({ row, bytes: ENC.encode(JSON.stringify(row.payload)).byteLength }))
      .filter((x) => x.bytes > MAX_ROW_BYTES);
    if (oversize.length) {
      const first = oversize[0]!;
      throw new CloudError(
        413,
        JSON.stringify({
          error: 'payload too large',
          limit: MAX_ROW_BYTES,
          count: oversize.length,
          row: { tableName: first.row.tableName, rowId: first.row.rowId.slice(0, MAX_ROW_ID_CHARS), bytes: first.bytes },
        }),
      );
    }
    let accepted = 0;
    let skipped = 0;
    // 同じ鍵の重複は updatedAt の大きい方だけを見る（Worker と同じ数え方）。
    const latest = new Map<string, ChangeIn>();
    for (const ch of changes) {
      const k = `${ch.tableName}:${ch.rowId}`;
      const cur = latest.get(k);
      if (!cur) latest.set(k, ch);
      else { skipped++; if (ch.updatedAt > cur.updatedAt) latest.set(k, ch); }
    }
    for (const [k, ch] of latest) {
      const prev = this.store.rows.get(k);
      if (prev && prev.updatedAt >= ch.updatedAt) { skipped++; continue; }
      const out: ChangeOut = { ...ch, payload: structuredClone(ch.payload), seq: ++this.store.seq, deviceId: this.deviceId };
      this.store.changes.push(out);
      this.store.rows.set(k, out);
      accepted++;
    }
    return { seq: this.store.seq, accepted, skipped };
  }

  /**
   * 実物の GET /changes と同じく、rows から自端末以外の行を連番の順に引く。
   * 変更ログを持たないので、どれだけ古い since でも断らない。
   * 最後まで返せたときの nextSeq は表の末尾の連番（max(seq)）で、since をそのまま返さない。
   * 解除していない PC の最終確認（peers）と、Worker の時刻（now）を添える。
   */
  async pullChanges(since: number, limit: number): Promise<PullChangesResponse> {
    this.guard('pullChanges', since, limit);
    const n = clampLimit(limit);
    const rows = [...this.store.rows.values()];
    const all = rows.filter((c) => c.seq > since && c.deviceId !== this.deviceId).sort((x, y) => x.seq - y.seq);
    const page = all.slice(0, n);
    const more = all.length > n;
    const peers = [...this.store.devices.values()]
      .filter((d) => d.revokedAt === null)
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((d) => ({ id: d.id, lastSeenAt: d.lastSeenAt }));
    const now = this.store.now();
    const res: PullChangesResponse = {
      changes: page.map((c) => structuredClone(c)),
      nextSeq: more ? page[page.length - 1]!.seq : rows.reduce((m, c) => Math.max(m, c.seq), 0),
      more,
      peers,
      now,
    };
    // 版 7 の Worker は、この PC 宛ての、まだ受け取られていない TTL の内の依頼を、どの頁にも添える。版 6 は載せない。
    if (this.store.workerCompat >= MOBILE_MIN_WORKER_COMPAT) res.launches = this.pendingLaunches(now);
    return res;
  }

  private pendingLaunches(now: number): MobileLaunchOut[] {
    return [...this.store.launches.values()]
      .filter((l) => l.targetDevice === this.deviceId && l.status === 'pending' && l.createdAt > now - LAUNCH_TTL_MS)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, PULL_LAUNCH_LIMIT)
      .map((l) => ({ id: l.id, createdAt: l.createdAt, sealed: l.sealed }));
  }

  /**
   * スマホの POST /m/launches の真似（試験が依頼を置くための口で、CloudClient には無い）。
   * 置いた時刻は Worker の時計で、同じ ID の再送は行を増やさない。
   */
  postLaunch(l: MobileLaunchIn): void {
    if (ENC.encode(JSON.stringify(l)).byteLength > MAX_LAUNCH_BODY_BYTES) throw new CloudError(413, errorBody('payload too large'));
    if (this.store.launches.has(l.id)) return;
    this.store.launches.set(l.id, { id: l.id, targetDevice: l.targetDevice, createdAt: this.store.now(), sealed: l.sealed, status: 'pending', sealedAnswer: null });
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
  }

  async snapshot(after: string | null, limit: number): Promise<SnapshotResponse> {
    this.guard('snapshot', after, limit);
    const n = clampLimit(limit);
    const keys = [...this.store.rows.keys()].sort().filter((k) => k > (after ?? ''));
    const page = keys.slice(0, n);
    return {
      changes: page.map((k) => ({ ...structuredClone(this.store.rows.get(k)!), seq: 0 })),
      nextAfter: keys.length > n ? page[page.length - 1]! : null,
      seq: this.store.seq,
    };
  }

  /** 鍵の形と権限。transcripts も config も、書けるのは自端末の分だけ。GET は誰でも。 */
  private checkKey(key: string, write: boolean): void {
    if (!isValidFileKey(key)) throw new CloudError(400, errorBody('invalid key'));
    // 書けるのは自分の接頭辞の下だけ。config も transcripts と同じ守りである（実物の validKey と揃える）。
    if (write && !key.startsWith(`transcripts/${this.deviceId}/`) && !key.startsWith(`config/${this.deviceId}/`)) throw new CloudError(403, errorBody('forbidden'));
  }

  /**
   * ヘッダで届くメタデータの検査。Worker の PUT /files/<key> と同じところで同じ 400 を出す。
   * path は他端末が本文を降ろすときの置き場所になるので、`..` と絶対パスを通すと下流が防具無しで通る。
   */
  private checkMeta(meta: FileMetaIn): void {
    const bad = (): never => { throw new CloudError(400, errorBody('invalid headers')); };
    if (typeof meta.path !== 'string' || !isSafeRelPath(meta.path)) bad();
    if (meta.kind !== 'transcript' && meta.kind !== 'config') bad();
    if (!/^[0-9a-f]{64}$/.test(meta.sha256)) bad();
    if (!isInt(meta.size) || !isInt(meta.mtime)) bad();
    // 本文は端末で暗号化してから預ける約束である（決定 5）。実物の Worker も同じところで同じ 400 を出す。
    if (meta.kind === 'transcript' && meta.encrypted !== true) throw new CloudError(400, errorBody('unencrypted transcript'));
  }

  /**
   * 見出しに載せて Worker が復号するまでを写す。
   * 符号化できない値と ASCII にならない値は、実物と同じく送る前に落ちる。
   * 往復して元に戻らない値をここで拾うので、符号化と復号が食い違ったまま緑にならない。
   */
  private overTheWire(path: string): string {
    const wire = encodeHeaderText(path);
    if (wire === null || !isHeaderSafe(wire)) {
      throw new CloudError(0, `Cannot convert argument to a ByteString because the character at index 0 has a value greater than 255`);
    }
    const back = decodeHeaderText(wire);
    if (back === null || back !== path) throw new CloudError(400, errorBody('invalid headers'));
    return back;
  }

  /**
   * 検査を通さずに置く。
   * 上げる側の検査（平文の本文を断るなど）を迂回して、受け取る側の守りだけを試すための入口である。
   * 実物の Worker にこの口は無い。
   */
  seedUnchecked(meta: FileMetaIn, body: Buffer): { seq: number } {
    const seq = ++this.store.fileSeq;
    this.store.files.set(meta.key, {
      entry: { ...meta, seq, deviceId: this.deviceId, uploadedAt: this.store.now(), storedSize: body.length },
      body,
    });
    return { seq };
  }

  async putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> {
    this.guard('putFile', meta);
    this.checkKey(meta.key, true);
    this.checkMeta(meta);
    // path は見出しで運ぶので、偽物も同じ符号化を通す。
    // 通らない値は実物では undici が送る前に TypeError を投げる（CloudError(0) になる）。
    const path = this.overTheWire(meta.path);
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
      entry: { ...meta, path, seq, deviceId: this.deviceId, uploadedAt: this.store.now(), storedSize: buf.length },
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

  async listFiles(since: number, limit: number): Promise<ListFilesResponse> {
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
   * PUT /m/feed。版 7 より前の Worker はこの口を知らないので 404 で断る。
   * 本文の上限は実物（packages/cloud/src/mobile.ts の MAX_FEED_BODY_BYTES）と同じ 96 KiB。
   */
  async putMobileFeed(sealed: string): Promise<void> {
    this.guard('putMobileFeed', sealed);
    if (this.store.workerCompat < MOBILE_MIN_WORKER_COMPAT) throw new CloudError(404, errorBody('not found'));
    if (ENC.encode(JSON.stringify({ sealed })).byteLength > MAX_FEED_BODY_BYTES) throw new CloudError(413, errorBody('payload too large'));
    if (sealed.length === 0) throw new CloudError(400, errorBody('invalid body'));
    this.store.mobileFeeds.set(this.deviceId, { sealed, updatedAt: this.store.now() });
  }

  /** GET /usage の応答。試験が差し替える。既定はトークンの無い Worker と同じ。 */
  usageBody: CloudUsageBody = { configured: false };

  async usage(): Promise<CloudUsageBody> {
    this.guard('usage');
    return structuredClone(this.usageBody);
  }
}
