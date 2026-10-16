import http from 'node:http';
import type net from 'node:net';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';

/**
 * 立て替えの Worker。手元のループバックで待ち受けるだけで、実物のクラウドには触らない。
 * 全体を起動する試験（src/server.test.ts）と、同期の組み立ての試験（src/boot/sync.test.ts）が同じものを使う。
 */

/** 受けた要求を記録するだけの立て替えの Worker。/health のほかは 401 で断る。実物のクラウドには触らない。 */
export async function recorder(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0];
    seen.push(`${req.method} ${p}`);
    req.resume();
    // /health は実物と同じく認証を問わずに版を名乗る。同期は書き込みの前にここで Worker の版を確かめる。
    if (p === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', [COMPAT_HEADER]: String(COMPAT_VERSION) });
      res.end(JSON.stringify({ ok: true, version: 'fake', compat: COMPAT_VERSION }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"no"}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
  };
}

/** PUT された鍵を覚えるだけの立て替えの Worker。実物のクラウドには触らない。 */
export async function fileSink(): Promise<{ url: string; puts: string[]; close: () => Promise<void> }> {
  const puts: string[] = [];
  let seq = 0;
  const srv = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const send = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json', [COMPAT_HEADER]: String(COMPAT_VERSION) }); res.end(JSON.stringify(body)); };
    if (req.method === 'PUT' && url.startsWith('/files/')) {
      req.resume();
      req.on('end', () => { puts.push(decodeURIComponent(url.slice('/files/'.length))); send({ seq: ++seq }); });
      return;
    }
    req.resume();
    if (url === '/changes' && req.method === 'POST') return send({ seq: 0, accepted: 0, skipped: 0 });
    if (url === '/changes') return send({ changes: [], nextSeq: 0, more: false });
    if (url === '/rows') return send({ changes: [], nextAfter: null, seq: 0 });
    if (url === '/files') return send({ files: [], nextSeq: 0, more: false });
    return send({ ok: true, version: 'fake' });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    puts,
    close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
  };
}

export type Seen = { method: string; path: string; compat: string | undefined };
/** raw があれば JSON にせずそのまま返す（Cloudflare が Worker の手前で返す error 1027 のような本文）。 */
export type Answer = { status: number; body: unknown; compat?: string; raw?: string };

/** 決まった応答を返す立て替えの Worker。受けた要求と、載っていた版の見出しを記録する。実物のクラウドには触らない。 */
export async function fakeWorker(answer: (method: string, path: string) => Answer): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0]!;
    const h = req.headers[COMPAT_HEADER];
    seen.push({ method: req.method ?? '', path: p, compat: Array.isArray(h) ? h[0] : h });
    req.resume();
    const a = answer(req.method ?? '', p);
    res.writeHead(a.status, { 'content-type': a.raw === undefined ? 'application/json' : 'text/plain', ...(a.compat === undefined ? {} : { [COMPAT_HEADER]: a.compat }) });
    res.end(a.raw ?? JSON.stringify(a.body));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
  };
}

/** 下限を上げた Worker の断り。 */
export const refuse = (floor: number): Answer => ({ status: 426, body: { error: 'upgrade required', minCompat: floor, compat: floor }, compat: String(floor) });

/** いまの Worker の真似。どの経路にも、形の合う応答を返す。 */
export const answerAll = (compat: string | undefined) => (method: string, p: string): Answer => {
  const ok = (status: number, body: unknown): Answer => ({ status, body, compat });
  if (p === '/rows') return ok(200, { changes: [], nextAfter: null, seq: 0 });
  if (p === '/changes' && method === 'GET') return ok(200, { changes: [], nextSeq: 0, more: false });
  if (p === '/changes') return ok(200, { seq: 0, accepted: 0, skipped: 0 });
  if (p === '/files') return ok(200, { files: [], nextSeq: 0, more: false });
  if (p.startsWith('/files/') && method === 'PUT') return ok(201, { seq: 1 });
  if (p === '/usage') return ok(200, { configured: false });
  if (p === '/health') return ok(200, { ok: true, version: 'fake', compat: compat === undefined ? 0 : Number(compat) });
  return ok(404, { error: 'not found' });
};

export type TokenSeen = Seen & { bearer: string | null; status: number };

/**
 * 端末トークンを 1 つだけ受け付ける立て替えの Worker。実物のクラウドには触らない。
 * 違うトークンには、実物の認証（packages/cloud/src/auth.ts）と同じく 401 の `{ error: 'unauthorized' }` を返す。
 * setToken は、参加し直しで Worker の token_hash が入れ替わったことの真似である。
 * 受け付けたら、いまの Worker の真似（answerAll）で答える。
 */
export async function tokenWorker(token: string, compat: string = String(COMPAT_VERSION)): Promise<{ url: string; seen: TokenSeen[]; setToken: (t: string) => void; close: () => Promise<void> }> {
  let current = token;
  const seen: TokenSeen[] = [];
  const answer = answerAll(compat);
  const srv = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0]!;
    const h = req.headers[COMPAT_HEADER];
    const auth = req.headers.authorization;
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    req.resume();
    const a: Answer = p !== '/health' && bearer !== current ? { status: 401, body: { error: 'unauthorized' }, compat } : answer(req.method ?? '', p);
    seen.push({ method: req.method ?? '', path: p, compat: Array.isArray(h) ? h[0] : h, bearer, status: a.status });
    res.writeHead(a.status, { 'content-type': 'application/json', ...(a.compat === undefined ? {} : { [COMPAT_HEADER]: a.compat }) });
    res.end(JSON.stringify(a.body));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    setToken: (t) => { current = t; },
    close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
  };
}
