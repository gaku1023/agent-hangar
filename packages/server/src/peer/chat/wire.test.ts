import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventHub } from '../../ws/hub.ts';
import { attachPeerChatSocket } from './wire.ts';

// 画面の WebSocket と見張りの結び（peerChat.watch、peerChat.unwatch、切断）。実際の EventHub に、見る側の部品の偽物をつなぐ。

let server: http.Server;
let hub: EventHub;
let port: number;
const clients: WebSocket[] = [];
let calls: string[];
let socketOf: Map<string, number>;

const connect = async (): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: 'Bearer tok' } });
  clients.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject); });
  return ws;
};
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise<void>((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

beforeEach(async () => {
  calls = [];
  socketOf = new Map();
  hub = new EventHub('test');
  attachPeerChatSocket(hub, {
    watchFromSocket: (socket, msg) => { socketOf.set(msg.viewer, socket); calls.push(`watch ${msg.sessionId} ${msg.viewer} ${String(msg.after)}`); },
    unwatch: (sessionId, viewer, socket) => { calls.push(`unwatch ${sessionId} ${viewer} ${socket === socketOf.get(viewer) ? 'own' : 'other'}`); },
    dropSocket: (socket) => { calls.push(`drop ${[...socketOf].filter(([, s]) => s === socket).map(([v]) => v).join(',')}`); },
  });
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

describe('attachPeerChatSocket', () => {
  it('peerChat.watch と peerChat.unwatch を見張りへ渡し、形の違う本文は捨てる', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'peerChat.watch', sessionId: 's1', viewer: 'tab-1' }));
    ws.send('garbage');
    ws.send(JSON.stringify({ type: 'something.else' }));
    ws.send(JSON.stringify({ type: 'peerChat.watch', sessionId: 's2', viewer: 'tab-1', after: 'u3' }));
    ws.send(JSON.stringify({ type: 'peerChat.unwatch', sessionId: 's1', viewer: 'tab-1' }));
    await until(() => calls.length === 3);
    expect(calls).toEqual(['watch s1 tab-1 undefined', 'watch s2 tab-1 u3', 'unwatch s1 tab-1 own']);
  });

  it('接続が切れたら、その接続で見始めた人を外す（画面を閉じたら見張りが止まる）', async () => {
    const a = await connect();
    const b = await connect();
    a.send(JSON.stringify({ type: 'peerChat.watch', sessionId: 's1', viewer: 'tabA' }));
    b.send(JSON.stringify({ type: 'peerChat.watch', sessionId: 's1', viewer: 'tabB' }));
    await until(() => calls.length === 2);
    a.close();
    await until(() => calls.some((c) => c.startsWith('drop')));
    expect(calls.filter((c) => c.startsWith('drop'))).toEqual(['drop tabA']);
    b.terminate();
    await until(() => calls.filter((c) => c.startsWith('drop')).length === 2);
    expect(calls.filter((c) => c.startsWith('drop'))[1]).toBe('drop tabB');
  });
});
