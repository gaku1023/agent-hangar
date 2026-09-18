import { Readable } from 'node:stream';
import {
  MAX_PUSH_BATCH,
  SHARED_TABLES,
  type ChangeIn,
  type ChangeOut,
  type FileEntry,
  type FileMetaIn,
  type ListFilesResponse,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
import { CloudError, type CloudClient } from '../src/sync/client.ts';

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
  now: () => number;
};

const TABLES = new Set<string>(SHARED_TABLES);
const KEY_RE = /^(transcripts|config)\/[A-Za-z0-9._\-\/]+$/;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Worker と同じ規則（LWW、自端末の除外、鍵の権限、seq、圧縮の floor）をメモリ上で再現する偽物。
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
      now: o.now ?? (() => Date.now()),
    };
    if (o.store && o.now) this.store.now = o.now;
  }

  get offline(): boolean { return this.store.offline; }
  set offline(v: boolean) { this.store.offline = v; }
  get changes(): ChangeOut[] { return this.store.changes; }
  get rows(): Map<string, ChangeOut> { return this.store.rows; }
  get files(): Map<string, StoredFile> { return this.store.files; }
  get changesFloor(): number { return this.store.changesFloor; }

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
    if (this.store.offline) throw new CloudError(0, 'offline');
  }

  async health(): Promise<{ ok: boolean; version: string }> {
    this.guard('health');
    return { ok: true, version: 'fake' };
  }

  async pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse> {
    this.guard('pushChanges', changes);
    if (changes.length > MAX_PUSH_BATCH || !changes.every((c) => TABLES.has(c.tableName) && c.rowId.length > 0)) throw new CloudError(400, 'invalid body');
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

  async pullChanges(since: number, limit: number): Promise<PullChangesResponse> {
    this.guard('pullChanges', since, limit);
    if (since < this.store.changesFloor) throw new CloudError(410, JSON.stringify({ error: 'gone', floor: this.store.changesFloor }));
    const all = this.store.changes.filter((c) => c.seq > since && c.deviceId !== this.deviceId);
    const page = all.slice(0, limit);
    const more = all.length > limit;
    return {
      changes: page.map((c) => structuredClone(c)),
      nextSeq: more ? page[page.length - 1]!.seq : Math.max(this.store.seq, since),
      more,
    };
  }

  async snapshot(after: string | null, limit: number): Promise<SnapshotResponse> {
    this.guard('snapshot', after, limit);
    const keys = [...this.store.rows.keys()].sort().filter((k) => k > (after ?? ''));
    const page = keys.slice(0, limit);
    return {
      changes: page.map((k) => ({ ...structuredClone(this.store.rows.get(k)!), seq: 0 })),
      nextAfter: keys.length > limit ? page[page.length - 1]! : null,
      seq: this.store.seq,
    };
  }

  /** 鍵の形と権限。transcripts は自端末の分にだけ書ける。config は誰でも書ける。GET は誰でも。 */
  private checkKey(key: string, write: boolean): void {
    if (!KEY_RE.test(key) || key.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new CloudError(400, 'invalid key');
    if (write && key.startsWith('transcripts/') && !key.startsWith(`transcripts/${this.deviceId}/`)) throw new CloudError(403, 'forbidden');
  }

  private checkMeta(meta: FileMetaIn): void {
    if (typeof meta.path !== 'string' || meta.path.length === 0) throw new CloudError(400, 'invalid metadata');
    if (meta.kind !== 'transcript' && meta.kind !== 'config') throw new CloudError(400, 'invalid metadata');
    if (!/^[0-9a-f]{64}$/.test(meta.sha256)) throw new CloudError(400, 'invalid metadata');
    if (!isInt(meta.size) || !isInt(meta.mtime)) throw new CloudError(400, 'invalid metadata');
  }

  async putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> {
    this.guard('putFile', meta);
    this.checkKey(meta.key, true);
    this.checkMeta(meta);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    const buf = Buffer.concat(chunks);
    // 置き直すと新しい seq になる（Worker は古い索引を消して入れ直す）。
    const seq = ++this.store.fileSeq;
    this.store.files.set(meta.key, {
      entry: { ...meta, seq, deviceId: this.deviceId, uploadedAt: this.store.now(), storedSize: buf.length },
      body: buf,
    });
    return { seq };
  }

  async getFile(key: string): Promise<Readable> {
    this.guard('getFile', key);
    this.checkKey(key, false);
    const f = this.store.files.get(key);
    if (!f) throw new CloudError(404, 'not found');
    return Readable.from([Buffer.from(f.body)]);
  }

  async listFiles(since: number, limit: number): Promise<ListFilesResponse> {
    this.guard('listFiles', since, limit);
    const all = [...this.store.files.values()].map((f) => f.entry).filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, limit);
    return { files: page.map((e) => ({ ...e })), nextSeq: page.length ? page[page.length - 1]!.seq : since, more: all.length > limit };
  }

  async deleteFile(key: string): Promise<void> {
    this.guard('deleteFile', key);
    this.checkKey(key, true);
    this.store.files.delete(key);
  }
}
