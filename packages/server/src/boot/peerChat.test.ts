import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, openPeerChatReply, peerChatExpiresAt, randomEpochKey, sealPeerChat, type LiveSessionDto, type PeerChatOp, type PeerChatReply, type PeerKeyring } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { bootPeerChat, type PeerChatParts } from './peerChat.ts';

const ME = 'pc-a';
const PEER = 'pc-b';
const NOW = 5_000_000;

let db: Db;
let ring: PeerKeyring;
let live: LiveSessionDto[];
let accept: boolean;
let parts: PeerChatParts;
let session: string;
let events: unknown[];
let seq = 0;

beforeEach(async () => {
  db = openDb(':memory:');
  const keys = await deriveEpochKeys(1, randomEpochKey());
  ring = { current: () => keys, at: (n) => (n === 1 ? keys : null) };
  session = ensureSession(db, 'u1', '/w', ME);
  db.prepare('insert into runs (id, session_id, device_id, kind, tmux_name, started_at, heartbeat_at, launch_params, updated_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)').run('run-1', session, ME, 'start', 'hangar-run-1', 1, NOW, '{}', 1, ME);
  db.prepare("insert into devices (id, name, platform, last_seen_at, updated_at, origin_device) values (?, 'Mac', 'darwin', 1, 1, ?)").run(PEER, PEER);
  live = [{ sessionId: 'u1', status: 'busy', name: null, nameSource: null, cwd: '/w', pid: 1 }];
  accept = true;
  events = [];
  parts = bootPeerChat({
    home: { db, device: { id: ME, name: 'Win' } as never, settings: { get current() { return { peerChatAcceptFromPeers: accept } as never; } }, home: '/tmp/hangar-home' },
    runs: { runs: { sendInput: async () => {}, resumeWith: async () => { throw new Error('not here'); } } as never, mux: () => null },
    delivery: { live: { current: () => live, onChange: () => () => {} }, hub: { broadcast: (ev) => { events.push(ev); } } },
    sync: { peerLink: () => ({ api: {} as never, ring: async () => ring, reread: async () => {} }) },
    now: () => NOW,
  });
  parts.start();
});
afterEach(() => { parts?.stop(); db.close(); });

async function ask(op: PeerChatOp, sessionId = session): Promise<PeerChatReply> {
  const id = `ask-${++seq}`;
  const route = { requestId: id, from: PEER, to: ME };
  const sealed = await sealPeerChat(ring, route, { v: 1, askId: id, expiresAt: peerChatExpiresAt(NOW), sessionId, op });
  const frame = await parts.handle({ t: 'chat', id, from: PEER, epoch: 1, sealed });
  if (!frame) throw new Error('no reply');
  return openPeerChatReply(ring, route, frame.sealed);
}

describe('bootPeerChat', () => {
  it('実際の登録と run から、状態を答える', async () => {
    const r = await ask({ t: 'tail', after: null, waitMs: 0 });
    expect(r).toMatchObject({ ok: true, state: { sessionId: session, status: 'busy', items: [], queued: [] } });
  });

  it('止まった会話（run が無い）は stopped', async () => {
    db.prepare('update runs set ended_at = 2').run();
    live = [];
    const r = await ask({ t: 'tail', after: null, waitMs: 0 });
    expect(r).toMatchObject({ ok: true, state: { status: 'stopped' } });
  });

  it('知らない会話は session-unknown', async () => {
    expect(await ask({ t: 'tail', after: null, waitMs: 0 }, 'nope')).toEqual({ ok: false, reason: 'session-unknown' });
  });

  it('設定が切れていれば、送る系だけ断る（設定は頼みのたびに読み直す）', async () => {
    accept = false;
    expect(await ask({ t: 'send', text: 'x', images: [] })).toEqual({ ok: false, reason: 'refused-by-setting' });
    expect((await ask({ t: 'tail', after: null, waitMs: 0 })).ok).toBe(true);
    accept = true;
    const r = await ask({ t: 'send', text: 'x', images: [] });
    expect(r.ok && r.queueId).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: 'peerChat.queue', sessionId: session, queued: [{ text: 'x', from: { deviceId: PEER, deviceName: 'Mac' } }] });
  });

  it('会話をゴミ箱へ入れたら、預かりを捨てる', async () => {
    const r = (await ask({ t: 'send', text: 'x', images: [] })) as { ok: true; queueId: string };
    expect(r.queueId).toBeTruthy();
    db.prepare('update sessions set deleted_at = 1 where id = ?').run(session);
    const { touchRow } = await import('../db/notify.ts');
    touchRow(db, 'sessions', session);
    expect(events.at(-1)).toMatchObject({ type: 'peerChat.queue', queued: [] });
  });
});
