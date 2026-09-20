import { Readable } from 'node:stream';
import {
  MAX_PUSH_BATCH,
  PULL_LIMIT,
  SHARED_TABLES,
  decodeHeaderText,
  encodeHeaderText,
  isHeaderSafe,
  isSafeRelPath,
  type ChangeIn,
  type ChangeOut,
  type FileEntry,
  type FileMetaIn,
  type ListFilesResponse,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
import { CloudError, isValidFileKey, type CloudClient } from '../src/sync/client.ts';

type StoredFile = { entry: FileEntry; body: Buffer };

/** 端末をまたいで共有する中身。asDevice で作った別端末のクライアントも同じものを指す。 */
export type FakeCloudStore = {
  changes: ChangeOut[];
  rows: Map<string, ChangeOut>;
  files: Map<string, StoredFile>;
  seq: number;
  fileSeq: number;
  /** 圧縮で削り終えた連番。since がこれより小さい pull には 410 を返す。 */
  changesFloor: number;
  offline: boolean;
  unauthorized: boolean;
  /** その日（UTC で区切る）に D1 へ書いた行数。実物の Worker の台帳（packages/cloud/src/meter.ts）に当たる。 */
  d1Rows: Map<string, number>;
  now: () => number;
};

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

/**
 * 実物の Worker が D1 へ書く行数の写しである。
 *
 * 実物は見積もらない。D1 が申告する `rows_written` をそのまま積む（`packages/cloud/src/meter.ts`）。
 * 偽物には申告してくれる D1 がいないので、実測の表を持つ。
 * 数は `packages/cloud/test/meter.test.ts` が実物の Worker に対して測ったもので、
 * スキーマとの辻褄は `fake-cloud-usage.test.ts` が原本（`packages/cloud/src/schema.ts`）を読んで縛る。
 *
 * **insert は autoincrement の連番（`sqlite_sequence`）の 1 行も数える。**
 * `changes` も `files` も `seq integer primary key autoincrement` なので、どちらも同じ扱いにする。
 * delete では連番も索引も動かないので 1 行である（これも実測である）。
 */
export const D1_ROWS = {
  /** changes への insert（本体 + changes_device の索引 + 連番）。 */
  changeInsert: 3,
  /** 鏡（rows）の upsert（本体 + k の主キーの索引）。 */
  mirrorUpsert: 2,
  /** devices の last_seen_at と last_pulled_seq の更新。どの索引にも載らない列なので 1 行である。 */
  deviceTouch: 1,
  /** files への insert（本体 + key の unique + files_kind + 連番）。 */
  fileInsert: 4,
  /** files からの delete。索引の分は D1 が数えない。 */
  fileDelete: 1,
  /** 台帳の 1 文（`packages/cloud/src/meter.ts` の META_ROWS_PER_NOTE）。書き込みのある要求ごとに 1 回。 */
  note: 2,
} as const;

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
 * Worker と同じ規則（入力の検査、LWW、自端末の除外、鍵の権限、seq、圧縮の floor）をメモリ上で再現する偽物。
 * asDevice で同じストアを別端末として使えるので、2 端末の同期をそのまま書ける。
 * 本物の fetch は一切呼ばない。
 */
export class FakeCloudClient implements CloudClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly store: FakeCloudStore;
  readonly deviceId: string;

  constructor(o: { deviceId?: string; store?: FakeCloudStore; now?: () => number } = {}) {
    this.deviceId = o.deviceId ?? 'self';
    this.store = o.store ?? {
      changes: [],
      rows: new Map(),
      files: new Map(),
      seq: 0,
      fileSeq: 0,
      changesFloor: 0,
      offline: false,
      unauthorized: false,
      d1Rows: new Map(),
      now: o.now ?? (() => Date.now()),
    };
    if (o.store && o.now) this.store.now = o.now;
  }

  get offline(): boolean { return this.store.offline; }
  set offline(v: boolean) { this.store.offline = v; }
  /** true の間、全メソッドが 401 を投げる。参加用の秘密を回した後と端末の行を消した後の筋を書くために使う。 */
  get unauthorized(): boolean { return this.store.unauthorized; }
  set unauthorized(v: boolean) { this.store.unauthorized = v; }
  get changes(): ChangeOut[] { return this.store.changes; }
  get rows(): Map<string, ChangeOut> { return this.store.rows; }
  get files(): Map<string, StoredFile> { return this.store.files; }
  get changesFloor(): number { return this.store.changesFloor; }

  /** その日に D1 へ書いた行数。実物の Worker が push の応答に載せて返す数である。 */
  d1RowsToday(): number { return this.store.d1Rows.get(this.day()) ?? 0; }

  private day(): string { return new Date(this.store.now()).toISOString().slice(0, 10); }

  /**
   * PUT /files の 1 回ぶん。
   * 置き直しのときだけ古い索引の delete が当たるので、鍵が既にあるかどうかで分ける（実物と同じである）。
   */
  private noteFilePut(key: string): void {
    this.noteD1((this.store.files.has(key) ? D1_ROWS.fileDelete : 0) + D1_ROWS.fileInsert + D1_ROWS.deviceTouch + D1_ROWS.note);
  }

  /** 書いた行数を台帳へ積む。書き込みのある経路は必ずここを通す（通さないと見張りが甘くなる）。 */
  private noteD1(rows: number): void {
    const day = this.day();
    this.store.d1Rows.set(day, (this.store.d1Rows.get(day) ?? 0) + rows);
  }

  /** 同じストアを別の端末として使うクライアント。2 端末の同期のテストはこれで書く。 */
  asDevice(deviceId: string): FakeCloudClient {
    return new FakeCloudClient({ deviceId, store: this.store });
  }

  /**
   * Worker の圧縮を真似る。floor までの changes を消し、floor を残す。
   * これ以降、since が floor より小さい pull は 410 と { error: 'gone', floor } になる。
   */
  compact(floor: number): void {
    this.store.changesFloor = Math.max(this.store.changesFloor, floor);
    this.store.changes = this.store.changes.filter((c) => c.seq > this.store.changesFloor);
  }

  private guard(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    // 繋がらなければ認証にも辿り着かないので、offline を先に見る。
    if (this.store.offline) throw new CloudError(0, 'offline');
    if (this.store.unauthorized) throw new CloudError(401, errorBody('unauthorized'));
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
    this.noteD1(accepted * (D1_ROWS.changeInsert + D1_ROWS.mirrorUpsert) + D1_ROWS.deviceTouch + D1_ROWS.note);
    return { seq: this.store.seq, accepted, skipped, d1RowsToday: this.d1RowsToday() };
  }

  async pullChanges(since: number, limit: number): Promise<PullChangesResponse> {
    this.guard('pullChanges', since, limit);
    if (since < this.store.changesFloor) throw new CloudError(410, JSON.stringify({ error: 'gone', floor: this.store.changesFloor }));
    // GET /changes は devices の last_seen_at と last_pulled_seq を 1 行書く。
    this.noteD1(D1_ROWS.deviceTouch + D1_ROWS.note);
    const n = clampLimit(limit);
    const all = this.store.changes.filter((c) => c.seq > since && c.deviceId !== this.deviceId);
    const page = all.slice(0, n);
    const more = all.length > n;
    return {
      changes: page.map((c) => structuredClone(c)),
      nextSeq: more ? page[page.length - 1]!.seq : Math.max(this.store.seq, since),
      more,
      // 実物の Worker は pull の応答にもその日の行数を載せる（押すものが無い日でも端末へ届くように）。
      d1RowsToday: this.d1RowsToday(),
    };
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

  /** 鍵の形と権限。transcripts は自端末の分にだけ書ける。config は誰でも書ける。GET は誰でも。 */
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
    this.noteFilePut(meta.key);
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
    this.noteFilePut(meta.key);
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

  async deleteFile(key: string): Promise<void> {
    this.guard('deleteFile', key);
    this.checkKey(key, true);
    if (this.store.files.delete(key)) this.noteD1(D1_ROWS.fileDelete + D1_ROWS.note);
  }
}
