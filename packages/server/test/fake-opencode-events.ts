import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { authHeader } from '../src/provider/opencode/serve/spawn.ts';

/**
 * 状態の面（provider/opencode/live.ts）の試験に使う、serve の出来事の流れのふり。
 * 実物の opencode は起こさず、試験の中で HTTP を立てる。basic 認証（ユーザー名は opencode）を見て、合わなければ 401 を返す。
 * - `GET /api/event`：SSE を開き、send で渡した 1 件を書く。開いた直後は実物と同じく `server.connected` だけを書く。
 * - `GET /api/session/active`、`GET /api/permission/request`、`GET /api/form`：state の中身を答える（取り直しの道）。
 * requests は受けた道（クエリ込み）を順に覚える。
 */
export type FakeEventsServe = {
  url: string;
  password: string;
  /** serve の pid のふり。試験の中で生きているかを決めるのに使う。 */
  pid: number;
  state: { active: Set<string>; permissions: unknown[]; forms: unknown[] };
  requests: string[];
  /** いま開いている流れの数。 */
  open(): number;
  /** これまでに開いた流れの数。 */
  opened(): number;
  /** 開いている流れの全部に 1 件を書く。frame は `data: …` の行か `: heartbeat` で、区切りの空行はここで足す。 */
  send(frame: string): void;
  /** 開いている流れを全部閉じる（serve の側から切れたふり）。 */
  drop(): void;
  close(): Promise<void>;
};

export async function startFakeEventsServe(o: { password?: string; pid?: number } = {}): Promise<FakeEventsServe> {
  const password = o.password ?? 'pw';
  const state = { active: new Set<string>(), permissions: [] as unknown[], forms: [] as unknown[] };
  const requests: string[] = [];
  const streams = new Set<http.ServerResponse>();
  let opened = 0;
  const json = (res: http.ServerResponse, body: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== authHeader(password)) { res.writeHead(401); res.end('unauthorized'); return; }
    requests.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/event') {
      opened++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ id: `evt_connected${opened}`, type: 'server.connected', data: {} })}\n\n`);
      streams.add(res);
      req.on('close', () => { streams.delete(res); });
      return;
    }
    if (url.pathname === '/api/session/active') return json(res, { data: Object.fromEntries([...state.active].map((id) => [id, { type: 'running' }])) });
    const directory = url.searchParams.get('location[directory]');
    if (url.pathname === '/api/permission/request') return json(res, { location: { directory }, data: state.permissions });
    if (url.pathname === '/api/form') return json(res, { location: { directory }, data: state.forms });
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, password, pid: o.pid ?? 424242, state, requests,
    open: () => streams.size,
    opened: () => opened,
    send(frame) { for (const s of streams) s.write(`${frame}\n\n`); },
    drop() { for (const s of streams) s.destroy(); streams.clear(); },
    close: () => new Promise<void>((r) => { for (const s of streams) s.destroy(); streams.clear(); server.close(() => r()); server.closeAllConnections(); }),
  };
}

/** 記録した 2.1.4 の流れ（test/fixtures/opencode/2.1.4/*.sse）を、空行で区切った 1 件ずつにする。 */
export function fixtureFrames(name: string): string[] {
  const text = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'opencode', '2.1.4', name), 'utf8');
  return text.split('\n\n').map((f) => f.trim()).filter(Boolean);
}

/** 記録した取り直しの答え（test/fixtures/opencode/2.1.4/rest.json）。 */
export function fixtureRest(): { idle: { data: Record<string, unknown> }; running: { data: Record<string, unknown> }; permission: { data: unknown[] }; form: { data: unknown[] }; noPermission: { data: unknown[] }; noForm: { data: unknown[] } } {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'opencode', '2.1.4', 'rest.json'), 'utf8'));
}

/** 条件が真になるまで短い間隔で待つ。上限を過ぎたら投げる。 */
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
