import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveEpochKeys, randomEpochKey, sealPeerAnswer, sealPeerResult, type LiveSessionDto, type PeerKeyring, type PeerLaunchResult, type PeerRoute } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { recordPeerRequest } from '../peer/outbox.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { bootPeer } from './peer.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const route: PeerRoute = { requestId: 'req-1', from: ME, to: PEER };
const NOW = 5_000_000;

let db: Db;
let a: FakeCloudClient;
let b: FakeCloudClient;
let ring: PeerKeyring;
let caller: string;
let live: LiveSessionDto[];
let canCarry: boolean;
let sent: { tmux: string; text: string; submit: boolean }[];
let parts: ReturnType<typeof bootPeer>;

beforeEach(async () => {
  db = openDb(':memory:');
  a = new FakeCloudClient({ deviceId: ME, now: () => NOW });
  b = a.asDevice(PEER);
  await b.pullChanges(0, 10);
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  caller = ensureSession(db, 'u1', '/w', ME);
  db.prepare('insert into runs (id, session_id, device_id, kind, tmux_name, started_at, heartbeat_at, launch_params, updated_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)').run('run-1', caller, ME, 'start', 'hangar-run-1', 1, NOW, '{}', 1, ME);
  live = [{ sessionId: 'u1', status: 'idle', name: null, nameSource: null, cwd: '/w', pid: 1 }];
  canCarry = true;
  sent = [];
  parts = bootPeer({
    home: { db, device: { id: ME, name: 'Win' } as never, settings: { current: {} } as never, language: () => 'ja' },
    runs: { runs: { start: vi.fn(), sendInput: async (tmux: string, text: string, submit: boolean) => { sent.push({ tmux, text, submit }); } } as never, accounts: {} as never, claudeBin: () => null },
    delivery: { live: { current: () => live, onChange: () => () => {} }, hub: { broadcast: () => {} } },
    sync: {
      engine: { on: () => () => {} } as never,
      canCarryPeer: () => canCarry,
      peerLink: () => (canCarry ? { api: a.peerLaunch, ring: async () => ring, reread: async () => {} } : null),
    },
    now: () => NOW,
    setInterval: (() => ({ unref() {} })) as never,
  });
});
afterEach(() => { parts?.stop(); db.close(); });

async function placeAndRespond(): Promise<void> {
  await a.peerLaunch.put({ id: 'req-1', to: PEER, sealed: '1.c2VhbGVk' });
  recordPeerRequest(db, { requestId: 'req-1', to: PEER, callerSessionId: caller, now: NOW });
  await b.peerLaunch.claim('req-1');
  await b.peerLaunch.answer('req-1', true, await sealPeerAnswer(ring, route, { ok: true, sessionId: 'child-1', title: 'worker' }));
  const body: PeerLaunchResult = { v: 1, at: NOW, sessionId: 'child-1', title: 'worker', reason: 'idle', summary: '要約です', status: null, lastReply: '最後の返答です', truncated: false };
  await b.peerLaunch.postResult('req-1', { seq: 1, sealed: await sealPeerResult(ring, route, 1, body) });
}

describe('bootPeer の呼ぶ側', () => {
  it('呼び鈴の result で取得を回し、呼び出し元の画面へ入力として送り込む', async () => {
    await placeAndRespond();
    parts.onBell('result', 'req-1');
    await vi.waitFor(() => { expect(sent).toHaveLength(1); });
    expect(sent[0]).toMatchObject({ tmux: 'hangar-run-1', submit: true });
    expect(sent[0]!.text).toContain('最後の返答です');
  });

  it('頼みが来た知らせ（launch）では取得しない', async () => {
    await placeAndRespond();
    parts.onBell('launch', 'req-1');
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
  });

  it('Worker の版が足りなければ取得しない', async () => {
    await placeAndRespond();
    canCarry = false;
    parts.onBell('result', 'req-1');
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
  });

  it('呼び出し元の run が無ければ入力にせず預かったままにする', async () => {
    await placeAndRespond();
    db.prepare('update runs set ended_at = 1 where id = ?').run('run-1');
    parts.onBell('result', 'req-1');
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
  });
});
