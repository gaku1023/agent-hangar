// mobile 場面の補助。手元だけで動く偽の Worker。実物のクラウドには何もつながない。
// packages/mobile の PWA（dist/app）をそのまま配り、スマホが叩く /m/ の口だけを持つ。
// 受信箱の素と、起動の依頼の答えは、本物と同じ封（shared の mobileCrypto）で作る。PC 側は撮影の台本が代わりに動かす。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { COMPAT_HEADER, COMPAT_VERSION } from '../../../packages/shared/src/compat.ts';
import type { MobileFeed, MobileLaunchAnswer, MobileLaunchPayload } from '../../../packages/shared/src/mobile.ts';
import { aadAnswer, aadFeed, aadLaunch, importMobileKey, open, seal } from '../../../packages/shared/src/mobileCrypto.ts';
import { REPO } from '../env.ts';

const APP = path.join(REPO, 'packages/mobile/dist/app');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export const PC_ID = 'pc-demo-mac';
export const PHONE_ID = 'phone-demo-1';
export const EPOCH = 1;

type Launch = { id: string; status: 'pending' | 'claimed' | 'started' | 'failed'; sealedAnswer: string | null; prompt: string | null; projectId: string | null };

export type FakeWorker = {
  origin: string;
  /** feed をいま作る関数を差し替える（now を渡す）。 */
  setFeed(make: (now: number) => Omit<MobileFeed, 'v' | 'deviceId' | 'deviceName'>): void;
  /** 届いた起動の依頼（開いた中身つき）。 */
  launches: Map<string, Launch>;
  /** 依頼が届いたときに呼ぶ。 */
  onLaunch(fn: (l: Launch) => void): void;
  /** 依頼を claimed にする。 */
  claim(id: string): void;
  /** 依頼を始まった扱いにして、答えを封じて置く。 */
  answer(id: string, a: MobileLaunchAnswer): Promise<void>;
  close(): Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export async function startFakeWorker(opts: { rawKey: Uint8Array; pcName: string; stageHtml: (origin: string) => string; seedJson: (origin: string) => unknown }): Promise<FakeWorker> {
  const key = await importMobileKey(opts.rawKey, false);
  let make: Parameters<FakeWorker['setFeed']>[0] = () => ({ accounts: [], projects: [], live: [], returns: [], done: [] });
  let launchHook: (l: Launch) => void = () => {};
  const launches = new Map<string, Launch>();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', [COMPAT_HEADER]: String(COMPAT_VERSION), 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const p = url.pathname;
    if (p === '/stage') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(opts.stageHtml(origin));
    }
    if (p === '/seed.json') return json(res, 200, opts.seedJson(origin));
    if (p === '/m/inbox') {
      const now = Date.now();
      const feed: MobileFeed = { v: 1, deviceId: PC_ID, deviceName: opts.pcName, ...make(now) };
      return json(res, 200, {
        now,
        devices: [{ id: PC_ID, name: PC_ID, platform: 'darwin', lastSeenAt: now - 4_000 }],
        feeds: [{ deviceId: PC_ID, updatedAt: now - 3_000, sealed: await seal(key, aadFeed(PC_ID), feed), epoch: EPOCH }],
      });
    }
    if (p === '/m/launches' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { id: string; targetDevice: string; sealed: string; epoch: number };
      let payload: MobileLaunchPayload | null = null;
      try { payload = await open<MobileLaunchPayload>(key, aadLaunch(body.id, body.targetDevice), body.sealed); } catch { /* 開けなければ prompt は null */ }
      const l: Launch = { id: body.id, status: 'pending', sealedAnswer: null, prompt: payload?.prompt ?? null, projectId: payload?.projectId ?? null };
      launches.set(l.id, l);
      queueMicrotask(() => launchHook(l));
      return json(res, 200, { id: l.id, status: l.status, sealedAnswer: null, epoch: EPOCH });
    }
    const m = /^\/m\/launches\/([^/]+)$/.exec(p);
    if (m && req.method === 'GET') {
      const l = launches.get(decodeURIComponent(m[1]!));
      return l ? json(res, 200, { id: l.id, status: l.status, sealedAnswer: l.sealedAnswer, epoch: EPOCH }) : json(res, 404, { error: 'not-found' });
    }
    if (p.startsWith('/m/')) return json(res, 404, { error: 'not-found' });
    if (p === '/app' || p.startsWith('/app/')) {
      const rel = p === '/app' || p === '/app/' ? 'index.html' : p.slice('/app/'.length);
      const file = path.join(APP, rel);
      if (file.startsWith(APP) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
        return void fs.createReadStream(file).pipe(res);
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));

  return {
    origin,
    setFeed: (f) => { make = f; },
    launches,
    onLaunch: (fn) => { launchHook = fn; },
    claim(id) { const l = launches.get(id); if (l && l.status === 'pending') l.status = 'claimed'; },
    async answer(id, a) {
      const l = launches.get(id);
      if (!l) return;
      l.sealedAnswer = await seal(key, aadAnswer(id), a);
      l.status = a.ok ? 'started' : 'failed';
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
