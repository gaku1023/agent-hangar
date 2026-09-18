import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { oneLineError, probeAuthorized, probeHealth, serverDownMessage, startErrorMessage } from './probe.ts';

/** 使い捨ての受け口。自分で起こしたものだけを閉じる。ポート番号でプロセスを止めることはしない。 */
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise((r) => s.close(r));
  }
});

async function listen(handler: (req: IncomingMessage) => { status: number; body?: string }): Promise<{ port: number; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    const r = handler(req);
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body ?? '{}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** 誰も待ち受けていないポートを 1 つ取る。listen して、すぐ閉じる。 */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise((r) => server.close(r));
  return port;
}

describe('probeHealth', () => {
  it('/health が応えれば真、誰も居なければ偽', async () => {
    const { port } = await listen((req) => ({ status: req.url === '/health' ? 200 : 404 }));
    expect(await probeHealth(port)).toBe(true);
    expect(await probeHealth(await deadPort(), 500)).toBe(false);
  });
});

describe('probeAuthorized', () => {
  const token = 'a'.repeat(64);

  it('書いたトークンで認証の要る経路が通れば ok', async () => {
    const { port, seen } = await listen(() => ({ status: 200, body: '{"fiveHour":null}' }));
    expect(await probeAuthorized(port, token)).toEqual({ ok: true });
    // 認証を通さない /health では確かめない。認証の要る経路を叩く。
    expect(seen[0]!.url).not.toBe('/health');
    expect(seen[0]!.url?.startsWith('/api/')).toBe(true);
  });

  it('トークンは見出しで送り、URL には載せない', async () => {
    const { port, seen } = await listen(() => ({ status: 200 }));
    await probeAuthorized(port, token);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(seen[0]!.url).not.toContain(token);
  });

  it('トークンが食い違えば unauthorized として返る', async () => {
    const { port } = await listen(() => ({ status: 401, body: '{"error":"認証が切れました"}' }));
    expect(await probeAuthorized(port, token)).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
    const forbidden = await listen(() => ({ status: 403 }));
    expect(await probeAuthorized(forbidden.port, token)).toEqual({ ok: false, reason: 'unauthorized', status: 403 });
  });

  it('誰も居ないポートは down として返る', async () => {
    expect(await probeAuthorized(await deadPort(), token, 500)).toEqual({ ok: false, reason: 'down' });
  });

  it('そのほかの応答は status を添えて返る', async () => {
    const { port } = await listen(() => ({ status: 500 }));
    expect(await probeAuthorized(port, token)).toEqual({ ok: false, reason: 'error', status: 500 });
  });
});

describe('serverDownMessage', () => {
  it('サーバが居ないときは hangar start を案内し、鍵は出さない', () => {
    const m = serverDownMessage(4177);
    expect(m).toContain('サーバが動いていません');
    expect(m).toContain('hangar start');
    expect(m).toContain('4177');
    expect(m.split('\n')).toHaveLength(1);
  });
});

describe('startErrorMessage', () => {
  it('EADDRINUSE は日本語の 1 行にして、スタックを出さない', () => {
    const e = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4191'), { code: 'EADDRINUSE' });
    const m = startErrorMessage(e, 4191);
    expect(m).toContain('ポート 4191 は既に使われています');
    expect(m).not.toContain('EADDRINUSE');
    expect(m).not.toContain('at ');
    expect(m.split('\n')).toHaveLength(1);
  });

  it('権限の無いポートも案内にする', () => {
    const e = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:80'), { code: 'EACCES' });
    expect(startErrorMessage(e, 80)).toContain('ポート 80');
    expect(startErrorMessage(e, 80)).toContain('--port');
  });

  it('見覚えの無い失敗も 1 行にたたむ', () => {
    const e = new Error('何かが壊れた\n    at Server.setupListenHandle (node:net:1937:16)\n    at listenInCluster (node:net:1985:12)');
    const m = startErrorMessage(e, 4177);
    expect(m.split('\n')).toHaveLength(1);
    expect(m).toContain('何かが壊れた');
    expect(m).not.toContain('node:net');
  });
});

describe('oneLineError', () => {
  it('スタックの付いた例外も、文字列でない例外も 1 行にする', () => {
    expect(oneLineError(new Error('壊れた\n    at x (y:1:1)'))).toBe('壊れた');
    expect(oneLineError('ただの文字列')).toBe('ただの文字列');
    expect(oneLineError(new Error(''))).toBe('原因の分からない失敗です');
  });
});
