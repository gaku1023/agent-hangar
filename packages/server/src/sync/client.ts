import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  CLOUD_HEADERS,
  type ChangeIn,
  type FileMetaIn,
  type ListFilesResponse,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';

/**
 * クラウドの応答が 2xx でなかったときと、そもそも繋がらなかったとき（status 0）に投げる。
 * message は応答本文の先頭 200 字なので、Worker の応答本文に秘密を入れてはいけない。
 */
export class CloudError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

/**
 * `GET /changes?since=` が圧縮で消えた区間を指したときの floor を読む。
 * Worker は 410 と `{ error: 'gone', floor }` を返す。
 * それ以外なら null なので、呼び手は全件の再同期に切り替えるかどうかをこれで決める。
 */
export function goneFloor(e: unknown): number | null {
  if (!(e instanceof CloudError) || e.status !== 410) return null;
  try {
    const v = JSON.parse(e.message) as { error?: unknown; floor?: unknown };
    return v && v.error === 'gone' && typeof v.floor === 'number' && Number.isFinite(v.floor) ? v.floor : null;
  } catch {
    return null;
  }
}

/** 端末から見た Worker。HttpCloudClient が本物、FakeCloudClient（test/fake-cloud.ts）がメモリ上の偽物。 */
export interface CloudClient {
  health(): Promise<{ ok: boolean; version: string }>;
  pushChanges(changes: ChangeIn[]): Promise<PushChangesResponse>;
  pullChanges(since: number, limit: number): Promise<PullChangesResponse>;
  snapshot(after: string | null, limit: number): Promise<SnapshotResponse>;
  putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }>;
  getFile(key: string): Promise<Readable>;
  listFiles(since: number, limit: number): Promise<ListFilesResponse>;
  deleteFile(key: string): Promise<void>;
}

export type HttpCloudClientOptions = { url: string; token: string; fetch?: typeof fetch };

/** fetch で Worker を叩く実装。token はヘッダにだけ載せ、URL にもログにも出さない。 */
export class HttpCloudClient implements CloudClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  /**
   * 端末トークンは閉じ込めて持つ。
   * 文字列の項目にすると console.log(client) や JSON.stringify(client) で読めてしまう。
   */
  private readonly authorization: () => string;

  constructor(o: HttpCloudClientOptions) {
    this.base = o.url.replace(/\/+$/, '');
    this.fetchFn = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const token = o.token;
    this.authorization = () => `Bearer ${token}`;
  }

  private async raw(path: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<Response> {
    let res: Response;
    try {
      // authorization は後ろに置く。呼び手のヘッダで取り違えて外れることがない。
      res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), authorization: this.authorization() },
      } as RequestInit);
    } catch (e) {
      throw new CloudError(0, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new CloudError(res.status, (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}`);
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.raw(path, { ...init, headers: { 'content-type': 'application/json', ...((init.headers as Record<string, string> | undefined) ?? {}) } });
    return (await res.json()) as T;
  }

  health() { return this.json<{ ok: boolean; version: string }>('/health'); }
  pushChanges(changes: ChangeIn[]) { return this.json<PushChangesResponse>('/changes', { method: 'POST', body: JSON.stringify({ changes }) }); }
  pullChanges(since: number, limit: number) { return this.json<PullChangesResponse>(`/changes?since=${since}&limit=${limit}`); }
  snapshot(after: string | null, limit: number) { return this.json<SnapshotResponse>(`/rows?after=${encodeURIComponent(after ?? '')}&limit=${limit}`); }
  listFiles(since: number, limit: number) { return this.json<ListFilesResponse>(`/files?since=${since}&limit=${limit}`); }

  async putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> {
    const headers: Record<string, string> = {
      [CLOUD_HEADERS.path]: meta.path,
      [CLOUD_HEADERS.kind]: meta.kind,
      [CLOUD_HEADERS.sha256]: meta.sha256,
      [CLOUD_HEADERS.size]: String(meta.size),
      [CLOUD_HEADERS.mtime]: String(meta.mtime),
      [CLOUD_HEADERS.encrypted]: meta.encrypted ? '1' : '0',
      'content-type': 'application/octet-stream',
    };
    // 本文は貯めずに流す。duplex: 'half' はストリームを body にするときに要る。
    const res = await this.raw(`/files/${meta.key}`, { method: 'PUT', headers, body: Readable.toWeb(body) as unknown as BodyInit, duplex: 'half' });
    const v = (await res.json()) as { seq: number };
    return { seq: v.seq };
  }

  async getFile(key: string): Promise<Readable> {
    const res = await this.raw(`/files/${key}`);
    if (!res.body) return Readable.from([]);
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }

  async deleteFile(key: string): Promise<void> {
    await this.raw(`/files/${key}`, { method: 'DELETE' });
  }
}
