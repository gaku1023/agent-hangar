import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  CLOUD_HEADERS,
  encodeFileKeyPath,
  encodeHeaderText,
  isSafeRelPath,
  isValidFileKey,
  type ChangeIn,
  type FileMetaIn,
  type ListFilesResponse,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';

/**
 * クラウドの応答が 2xx でなかったときと、そもそも決着しなかったとき（status 0）に投げる。
 * message は応答本文の先頭 200 字なので、Worker の応答本文に秘密を入れてはいけない。
 */
export class CloudError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

const toCloudError = (e: unknown): CloudError => (e instanceof CloudError ? e : new CloudError(0, e instanceof Error ? e.message : String(e)));

/**
 * `GET /changes?since=` が圧縮で消えた区間を指したときの floor を読む。
 * Worker は 410 と `{ error: 'gone', floor }` を返す。
 * それ以外なら null なので、呼び手は全件の再同期に切り替えるかどうかをこれで決める。
 * floor は 0 でありうるので、受け手は `if (floor !== null)` で見ること。
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

/**
 * R2 の鍵として Worker が受け取る形か。
 * 判定の本体は共有（`packages/shared/src/cloud.ts`）にあり、Worker の `validKey` と同じ物差しである。
 * ここで独自に字種を狭めると、日本語や空白を含む `~/.claude` のファイルが端末側だけで止まる。
 */
export { isValidFileKey } from '@agent-hangar/shared';

/** 小さい応答（changes、rows、files の一覧、health）の締め切り。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 本体を運ぶ経路（putFile、getFile）の締め切り。 */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 300_000;

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

export type HttpCloudClientOptions = {
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** 小さい応答の締め切り。既定は 30 秒。 */
  timeoutMs?: number;
  /** 本体を運ぶ経路の締め切り。既定は 5 分。 */
  transferTimeoutMs?: number;
};

/** fetch で Worker を叩く実装。token はヘッダにだけ載せ、URL にもログにも出さない。 */
export class HttpCloudClient implements CloudClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly transferTimeoutMs: number;
  /**
   * 端末トークンは閉じ込めて持つ。
   * 文字列の項目にすると console.log(client) や JSON.stringify(client) で読めてしまう。
   */
  private readonly authorization: () => string;

  constructor(o: HttpCloudClientOptions) {
    this.base = o.url.replace(/\/+$/, '');
    this.fetchFn = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transferTimeoutMs = o.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    const token = o.token;
    this.authorization = () => `Bearer ${token}`;
  }

  /**
   * 要求を投げて応答の見出しまでを受ける。
   * 締め切りは呼び手が本体を読み終えるまで生きているので、Deadline は返して呼び手が clear する。
   */
  private async send(path: string, init: RequestInit & { duplex?: 'half' }, ms: number): Promise<{ res: Response; d: Deadline }> {
    const d = new Deadline(ms);
    let res: Response;
    try {
      // authorization は後ろに置く。呼び手のヘッダで取り違えて外れることがない。
      res = await d.race(
        this.fetchFn(`${this.base}${path}`, {
          ...init,
          signal: d.signal,
          headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), authorization: this.authorization() },
        } as RequestInit),
      );
    } catch (e) {
      d.clear();
      throw toCloudError(e);
    }
    if (!res.ok) {
      const text = await d.race(res.text()).catch(() => '');
      d.clear();
      throw new CloudError(res.status, text.slice(0, 200) || `HTTP ${res.status}`);
    }
    return { res, d };
  }

  /** 応答の本体を JSON として読む。読み取りの失敗も CloudError(0) に揃える。 */
  private async json<T>(path: string, init: RequestInit = {}, ms = this.timeoutMs): Promise<T> {
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

  private requireValidKey(key: string): void {
    if (!isValidFileKey(key)) throw new CloudError(400, JSON.stringify({ error: 'invalid key' }));
  }

  health() { return this.json<{ ok: boolean; version: string }>('/health'); }
  pushChanges(changes: ChangeIn[]) { return this.json<PushChangesResponse>('/changes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) }); }
  pullChanges(since: number, limit: number) { return this.json<PullChangesResponse>(`/changes?since=${since}&limit=${limit}`); }
  snapshot(after: string | null, limit: number) { return this.json<SnapshotResponse>(`/rows?after=${encodeURIComponent(after ?? '')}&limit=${limit}`); }
  listFiles(since: number, limit: number) { return this.json<ListFilesResponse>(`/files?since=${since}&limit=${limit}`); }

  async putFile(meta: FileMetaIn, body: Readable): Promise<{ seq: number }> {
    this.requireValidKey(meta.key);
    // 見出しの値は ByteString しか運べない。
    // 符号化せずに日本語を渡すと undici が送る前に TypeError を投げるので、ここで符号化する。
    // 復号は Worker が同じ共有の関数で行う。
    const wirePath = isSafeRelPath(meta.path) ? encodeHeaderText(meta.path) : null;
    if (wirePath === null) throw new CloudError(400, JSON.stringify({ error: 'invalid headers' }));
    const headers: Record<string, string> = {
      [CLOUD_HEADERS.path]: wirePath,
      [CLOUD_HEADERS.kind]: meta.kind,
      [CLOUD_HEADERS.sha256]: meta.sha256,
      [CLOUD_HEADERS.size]: String(meta.size),
      [CLOUD_HEADERS.mtime]: String(meta.mtime),
      [CLOUD_HEADERS.encrypted]: meta.encrypted ? '1' : '0',
      'content-type': 'application/octet-stream',
    };
    // 本文は貯めずに流す。duplex: 'half' はストリームを body にするときに要る。
    const v = await this.json<{ seq: number }>(
      `/files/${encodeFileKeyPath(meta.key)}`,
      { method: 'PUT', headers, body: Readable.toWeb(body) as unknown as BodyInit, duplex: 'half' } as RequestInit,
      this.transferTimeoutMs,
    );
    return { seq: v.seq };
  }

  async getFile(key: string): Promise<Readable> {
    this.requireValidKey(key);
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

  async deleteFile(key: string): Promise<void> {
    this.requireValidKey(key);
    const { res, d } = await this.send(`/files/${encodeFileKeyPath(key)}`, { method: 'DELETE' }, this.timeoutMs);
    d.clear();
    void res.body?.cancel().catch(() => {});
  }
}
