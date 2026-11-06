import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventHub } from './hub.ts';

// 画面から来る WebSocket の知らせ（onMessage と onClose）。ほかの PC の会話の見張り（peer/chat/viewer.ts）が使う。

let server: http.Server;
let hub: EventHub;
let port: number;
const clients: WebSocket[] = [];

const connect = async (): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: 'Bearer tok' } });
  clients.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('message', () => resolve()); // ready
    ws.once('error', reject);
  });
  return ws;
};
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise<void>((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

beforeEach(async () => {
  hub = new EventHub('test');
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  hub.attach(server, { path: '/ws', token: 'tok', port });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await hub.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('EventHub の受信', () => {
  it('画面からの本文を、接続ごとの番号つきで onMessage に渡す', async () => {
    const got: [number, string][] = [];
    hub.onMessage((client, raw) => got.push([client, raw]));
    const a = await connect();
    const b = await connect();
    a.send('{"x":1}');
    b.send('{"x":2}');
    await until(() => got.length === 2);
    expect(got.map(([, raw]) => raw).sort()).toEqual(['{"x":1}', '{"x":2}']);
    expect(new Set(got.map(([c]) => c)).size).toBe(2);
  });

  it('接続が閉じたら、同じ番号で onClose を呼ぶ', async () => {
    const msgs: number[] = [];
    const closed: number[] = [];
    hub.onMessage((client) => msgs.push(client));
    hub.onClose((client) => closed.push(client));
    const a = await connect();
    a.send('hi');
    await until(() => msgs.length === 1);
    a.close();
    await until(() => closed.length === 1);
    expect(closed[0]).toBe(msgs[0]);
  });

  it('大きすぎる本文を送った接続は切る（受け口を食わせない）', async () => {
    const msgs: string[] = [];
    hub.onMessage((_c, raw) => msgs.push(raw));
    const a = await connect();
    const closed = new Promise<number>((resolve) => a.once('close', (code) => resolve(code)));
    a.send('x'.repeat(64 * 1024));
    expect(await closed).toBe(1009);
    expect(msgs).toEqual([]);
  });

  it('onMessage の中で投げても、サーバと接続は落ちない', async () => {
    let n = 0;
    hub.onMessage(() => { n++; throw new Error('boom'); });
    const a = await connect();
    a.send('1');
    a.send('2');
    await until(() => n === 2);
    expect(a.readyState).toBe(WebSocket.OPEN);
  });
});
