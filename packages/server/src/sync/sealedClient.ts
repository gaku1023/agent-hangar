import type { Readable } from 'node:stream';
import {
  fromBase64Url,
  openRow,
  ROSTER_MARKER_K,
  rowK,
  sealRow,
  SHARED_TABLES,
  toBase64Url,
  type ChangeIn,
  type ChangeOut,
  type CloudUsageBody,
  type EpochKeys,
  type FileMetaIn,
  type ListFilesResponse,
  type PushChangesResponse,
  type SealedChangeIn,
  type SealedChangeOut,
  type SharedTable,
} from '@agent-hangar/shared';
import { CloudError, type CloudClient, type KeyRefresh, type OpenedPullResponse, type OpenedSnapshotResponse, type Unreadable, type WireCloudClient } from './client.ts';

/**
 * 行を封じて開くのに使う鍵の束。この PC の Keyring（sync/keyring.ts）が満たす。
 * 書くときは今の世代（current）を、読むときは行が名乗る世代（at）を引く。手元に無い世代は null。
 */
export type RowKeyring = { current(): EpochKeys; at(epoch: number): EpochKeys | null };

const TABLES = new Set<string>(SHARED_TABLES);
const errorBody = (error: string): string => JSON.stringify({ error });

/**
 * 封じる前の行の形の検査。
 * Worker は中身を見られないので、版 8 までの Worker が持っていた検査（表の一覧、行 ID、payload、時刻）をここで持つ。
 * 形の違う行は封じずに 400 で断る（今までと同じく、エンジンは送れなかった行として残す）。
 */
function isPlainChange(v: unknown): v is ChangeIn {
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

/**
 * 封じた行を 1 行開く。開けなければ null を返す。
 * 世代の鍵が手元に無い、AAD（k、device_id、updated_at、op、epoch）が合わない、中身の k が名乗る k と違う、のどれでも開けない。
 * 表の一覧に無い表の行（この PC より新しい版の PC が書いた行）は、開けた行として返す。当てる側（apply.ts）が飛ばす。
 */
export async function openSealedRow(ring: RowKeyring, r: SealedChangeOut): Promise<ChangeOut | null> {
  const keys = ring.at(r.epoch);
  if (!keys) return null;
  const bytes = fromBase64Url(r.sealed);
  if (!bytes) return null;
  try {
    const body = await openRow(keys.row, { k: r.k, deviceId: r.deviceId, updatedAt: r.updatedAt, op: r.op, epoch: r.epoch }, bytes);
    // 鍵を持つ PC どうしでも、中身と違う k に置いた行は信じない。
    if ((await rowK(keys.index, body.tableName, body.rowId)) !== r.k) return null;
    return { tableName: body.tableName as SharedTable, rowId: body.rowId, op: r.op, payload: body.payload, updatedAt: r.updatedAt, seq: r.seq, deviceId: r.deviceId };
  } catch {
    return null;
  }
}

export type SealedCloudClientOptions = {
  /**
   * 名簿か keybox が変わったときに呼ぶ（pull で名簿の印の行を見たとき、知らない世代の行を受けたとき）。
   * 名簿と keybox を読み直し、届いた世代鍵を Keyring に足す。投げると、その pull も倒れる。
   * 名簿の読み書き（RosterStore）が入るまで、既定は何もしない。
   */
  onRoster?: () => Promise<void>;
};

/**
 * 行を封じて送り、受けた行を開く client。線の client（WireCloudClient）を包み、行のほかの口はそのまま渡す。
 *
 * push は各行を今の世代の鍵で封じる。k は `/index` の鍵で表名と行 ID から求め、AAD に k、この PC の ID、updated_at、op、世代を入れる。
 * Worker は認証した端末の ID を device_id に書くので、deviceId はこの PC の端末トークンの ID と同じでなければならない。
 * pull と写しは、名簿の印の行（`~roster`）を開かずに onRoster に回し、ほかを行が名乗る世代の鍵で開く。
 * 開けなかった行は unreadable に入れる。印の行の epoch は後戻りしうるので、「名簿が変わったかもしれない」以上の意味に使わない。
 *
 * Keyring は待たずに渡せる（boot/sync.ts の組み立ては同期で走る）。読めなければ、行の口はどれもその失敗で倒れる。
 */
export class SealedCloudClient implements CloudClient {
  private readonly ring: Promise<RowKeyring>;
  private readonly onRoster: () => Promise<void>;
  /** 走らせ終えた名簿の印の行の連番。写しと読み直しで同じ印を見ても、2 度走らせない。印の行は書き換えのたびに末尾の連番で入り直す。 */
  private rosterSeenSeq = 0;

  listDevices?: CloudClient['listDevices'];
  revokeDevice?: CloudClient['revokeDevice'];
  lastWorkerCompat?: CloudClient['lastWorkerCompat'];
  putMobileFeed?: CloudClient['putMobileFeed'];
  createPairing?: CloudClient['createPairing'];
  claimLaunch?: CloudClient['claimLaunch'];
  answerLaunch?: CloudClient['answerLaunch'];
  bellTarget?: CloudClient['bellTarget'];
  getMobileBlob?: CloudClient['getMobileBlob'];
  deleteMobileFeed?: CloudClient['deleteMobileFeed'];

  constructor(
    readonly wire: WireCloudClient,
    keyring: RowKeyring | Promise<RowKeyring>,
    private readonly deviceId: string,
    o: SealedCloudClientOptions = {},
  ) {
    this.ring = Promise.resolve(keyring);
    // 読めない Keyring は、行の口を呼んだときにその失敗で倒す。作っただけで未処理の拒否にしない。
    this.ring.catch(() => {});
    this.onRoster = o.onRoster ?? (async () => {});
    // 線の client が持つ口だけを持つ（無い口は、呼び手が「この Worker には無い」と読む）。
    const w = wire;
    if (w.listDevices) this.listDevices = () => w.listDevices!();
    if (w.revokeDevice) this.revokeDevice = (id) => w.revokeDevice!(id);
    if (w.lastWorkerCompat) this.lastWorkerCompat = () => w.lastWorkerCompat!();
    if (w.putMobileFeed) this.putMobileFeed = (sealed) => w.putMobileFeed!(sealed);
    if (w.createPairing) this.createPairing = () => w.createPairing!();
    if (w.claimLaunch) this.claimLaunch = (id) => w.claimLaunch!(id);
    if (w.answerLaunch) this.answerLaunch = (id, ok, sealedAnswer) => w.answerLaunch!(id, ok, sealedAnswer);
    if (w.bellTarget) this.bellTarget = () => w.bellTarget!();
    if (w.getMobileBlob) this.getMobileBlob = (launchId, n) => w.getMobileBlob!(launchId, n);
    if (w.deleteMobileFeed) this.deleteMobileFeed = () => w.deleteMobileFeed!();
  }

  health(): Promise<{ ok: boolean; version: string }> { return this.wire.health(); }
  putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> { return this.wire.putFile(meta, body); }
  getFile(key: string): Promise<Readable> { return this.wire.getFile(key); }
  listFiles(since: number, limit: number): Promise<ListFilesResponse> { return this.wire.listFiles(since, limit); }
  usage(): Promise<CloudUsageBody> { return this.wire.usage(); }

  async pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse> {
    if (!Array.isArray(changes) || !changes.every(isPlainChange)) throw new CloudError(400, errorBody('invalid body'));
    const cur = (await this.ring).current();
    const byK = new Map<string, ChangeIn>();
    const sealed = await Promise.all(
      changes.map(async (c): Promise<SealedChangeIn> => {
        const k = await rowK(cur.index, c.tableName, c.rowId);
        byK.set(k, c);
        const bytes = await sealRow(cur.row, { k, deviceId: this.deviceId, updatedAt: c.updatedAt, op: c.op, epoch: cur.epoch }, { tableName: c.tableName, rowId: c.rowId, payload: c.payload });
        return { k, op: c.op, updatedAt: c.updatedAt, epoch: cur.epoch, sealed: toBase64Url(bytes) };
      }),
    );
    try {
      return await this.wire.pushChanges(sealed);
    } catch (e) {
      throw nameOversize(e, byK);
    }
  }

  async pullChanges(since: number, limit: number): Promise<OpenedPullResponse> {
    const ring = await this.ring;
    const page = await this.wire.pullChanges(since, limit);
    return { ...page, ...(await this.openPage(ring, page.changes)) };
  }

  async snapshot(after: string | null, limit: number): Promise<OpenedSnapshotResponse> {
    const ring = await this.ring;
    const page = await this.wire.snapshot(after, limit);
    return { ...page, ...(await this.openPage(ring, page.changes)) };
  }

  async refreshKeys(epochs: number[]): Promise<KeyRefresh> {
    const ring = await this.ring;
    const missing = [...new Set(epochs)].filter((n) => ring.at(n) === null);
    if (missing.length === 0) return 'not-needed';
    await this.onRoster();
    return missing.some((n) => ring.at(n) !== null) ? 'gained' : 'missing';
  }

  /**
   * 頁の行を開く。
   * 名簿の印の行があれば、先に onRoster を走らせる。新しい世代の鍵が届けば、同じ頁のその世代の行も開ける。
   */
  private async openPage(ring: RowKeyring, rows: SealedChangeOut[]): Promise<{ changes: ChangeOut[]; unreadable: Unreadable[] }> {
    const marker = rows.filter((r) => r.k === ROSTER_MARKER_K).reduce((m, r) => Math.max(m, r.seq), 0);
    if (marker > this.rosterSeenSeq) {
      await this.onRoster();
      this.rosterSeenSeq = marker;
    }
    const sealed = rows.filter((r) => r.k !== ROSTER_MARKER_K);
    const opened = await Promise.all(sealed.map((r) => openSealedRow(ring, r)));
    const changes: ChangeOut[] = [];
    const unreadable: Unreadable[] = [];
    opened.forEach((c, i) => {
      if (c) changes.push(c);
      else unreadable.push({ seq: sealed[i]!.seq, epoch: sealed[i]!.epoch });
    });
    return { changes, unreadable };
  }
}

/**
 * Worker の 413 は封じた行を k で名指しする。エンジンが諦める行を選べるよう、送った塊から表名と行 ID に戻す。
 * 戻せなければそのまま返す（エンジンは名指しの無い失敗として扱う）。
 */
function nameOversize(e: unknown, byK: Map<string, ChangeIn>): unknown {
  if (!(e instanceof CloudError) || e.status !== 413) return e;
  try {
    const v = JSON.parse(e.message) as { error?: unknown; limit?: unknown; count?: unknown; row?: { k?: unknown; bytes?: unknown } };
    const hit = typeof v?.row?.k === 'string' ? byK.get(v.row.k) : undefined;
    if (!hit) return e;
    return new CloudError(413, JSON.stringify({ error: v.error, limit: v.limit, count: v.count, row: { tableName: hit.tableName, rowId: hit.rowId, bytes: v.row!.bytes } }));
  } catch {
    return e;
  }
}
