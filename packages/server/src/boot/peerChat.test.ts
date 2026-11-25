import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveEpochKeys, openPeerChatReply, peerChatExpiresAt, randomEpochKey, sealPeerChat, type LiveSessionDto, type PeerChatOp, type PeerChatReply, type PeerKeyring } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { accountNameOf, agentAskOf, bootPeerChat, interruptApiOf, switchAccountOf, type PeerChatParts } from './peerChat.ts';

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
let screen: { text: string; keys: string[] } | null;
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
  screen = null;
  parts = bootPeerChat({
    home: { db, device: { id: ME, name: 'Win' } as never, settings: { get current() { return { peerChatAcceptFromPeers: accept } as never; } }, home: '/tmp/hangar-home', language: () => 'ja' },
    runs: { runs: { sendInput: async () => {}, resumeWith: async () => { throw new Error('not here'); } } as never, mux: () => (screen ? ({ capturePane: () => screen!.text, captureStyled: async () => null, sendKeys: (_n: string, k: string) => { screen!.keys.push(k); screen!.text = ' > '; }, listSessions: () => [] } as never) : null) },
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

describe('フォルダの信頼の札（手元の画面の札の道）', () => {
  const TRUST = ' Accessing workspace:\n\n /w\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n';
  it('信頼の確認の行（waiting、FolderTrust）の会話で session.ask を流し、札に答えると画面にキーを打つ', async () => {
    screen = { text: TRUST, keys: [] };
    live = [{ sessionId: 'u1', status: 'waiting', name: null, nameSource: null, cwd: '/w', pid: 0, waitingFor: 'permission', permission: { tool: 'FolderTrust', input: '/w', description: null } }];
    parts.asks.checkAll();
    const ev = events.find((e) => (e as { type?: string }).type === 'session.ask') as { sessionId: string; ask: { askId: string; tool: string } };
    expect(ev).toMatchObject({ sessionId: session, ask: { tool: 'FolderTrust', input: '/w' } });
    const r = await parts.host.local.answer(session, ev.ask.askId, ['1']);
    expect(r).toEqual({ ok: true, label: 'Yes, I trust this folder' });
    expect(screen.keys).toContain('Enter');
  });
});

describe('accountNameOf（state.account）', () => {
  const store = { get: (id: string) => ({ primary: { name: '会社' }, 'acc-2': { name: '大学' } } as Record<string, { name: string }>)[id] ?? null } as never;

  it('最後の run のアカウントの名前を返し、記録が無ければメインの名前', () => {
    const fn = accountNameOf(db, ME, () => 'claude-code', { store });
    expect(fn(session)).toBe('会社');
    db.prepare('insert into runs (id, session_id, device_id, kind, tmux_name, started_at, heartbeat_at, launch_params, updated_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)').run('run-2', session, ME, 'resume', 'hangar-run-2', 2, NOW, JSON.stringify({ account: 'acc-2' }), 2, ME);
    expect(fn(session)).toBe('大学');
  });

  it('Claude でない会話は null', () => {
    expect(accountNameOf(db, ME, () => 'codex', { store })(session)).toBeNull();
  });
});

describe('switchAccountOf（ほかの PC からの switch-account）', () => {
  const store = { list: () => [{ id: 'acc-1', name: '会社' }, { id: 'acc-2', name: '個人' }] } as never;
  const authOf = (loggedIn: Record<string, boolean | null>) => ({ get: (id: string) => (id in loggedIn ? { loggedIn: loggedIn[id] } : null), ensureChecked: () => {} }) as never;

  it('名前でこの PC のアカウントを引き、その ID で付け替える', async () => {
    const calls: [string, string][] = [];
    const fn = switchAccountOf({ switchAccount: async (s, a) => { calls.push([s, a]); return {} as never; } }, { store, auth: authOf({ 'acc-2': true }) });
    expect(await fn('s1', '個人')).toBe('ok');
    expect(calls).toEqual([['s1', 'acc-2']]);
  });

  it('無い名前と、ログインしていないアカウントは account-unavailable で、付け替えない', async () => {
    let called = 0;
    const fn = switchAccountOf({ switchAccount: async () => { called++; return {} as never; } }, { store, auth: authOf({ 'acc-1': false }) });
    expect(await fn('s1', '無い')).toBe('account-unavailable');
    expect(await fn('s1', '会社')).toBe('account-unavailable');
    expect(called).toBe(0);
  });

  it('付け替えが投げれば resume-failed', async () => {
    const fn = switchAccountOf({ switchAccount: async () => { throw new Error('same account'); } }, { store, auth: authOf({ 'acc-1': true }) });
    expect(await fn('s1', '会社')).toBe('resume-failed');
  });
});

describe('agentAskOf と interruptApiOf', () => {
  const psid = (id: string): string | null => (id === 's1' ? 'thr-1' : null);

  it('札の口は hangar の会話の ID を provider の会話の ID に引き換える。引き換えられない会話は札が無く、答えは unreachable', async () => {
    const seen: string[] = [];
    const codexLive = { askHandle: (id: string) => { seen.push(id); return { pending: [], rpc: {} as never }; } };
    const a = agentAskOf({ codexLive }, psid)!;
    expect(a.ports.opencode).toBeUndefined();
    expect(a.ports.codex!.current('s1')).toBeNull();
    expect(seen).toEqual(['thr-1']);
    expect(a.ports.codex!.current('nope')).toBeNull();
    expect(await a.ports.codex!.answer('nope', {} as never, { kind: 'permission', choice: 'once' })).toBe('unreachable');
    expect(seen).toEqual(['thr-1']);
    expect(agentAskOf({}, psid)).toBeUndefined();
  });

  it('opencode は client.interrupt を、Codex は今のターンの ID で turn/interrupt を呼ぶ。引けないとき・ターンが無いときは false', async () => {
    const interrupted: string[] = [];
    const requests: unknown[] = [];
    let turnId: string | null = 'turn-1';
    const opencode = { pendingOf: (id: string) => (id === 'thr-1' ? { client: { interrupt: async (x: string) => { interrupted.push(x); } } as never, perms: [], forms: [] } : null) };
    const codexLive = { turnHandle: () => ({ turnId, rpc: { isClosed: false, request: async (...a: unknown[]) => { requests.push(a); } } as never }) };
    const f = interruptApiOf({ opencode, codexLive }, psid);
    expect(await f('s1', 'opencode')).toBe(true);
    expect(interrupted).toEqual(['thr-1']);
    expect(await f('s1', 'codex')).toBe(true);
    expect(requests).toEqual([['turn/interrupt', { threadId: 'thr-1', turnId: 'turn-1' }]]);
    turnId = null;
    expect(await f('s1', 'codex')).toBe(false);
    expect(await f('nope', 'codex')).toBe(false);
    expect(await f('nope', 'opencode')).toBe(false);
    expect(await f('s1', 'claude-code')).toBe(false);
    expect(await interruptApiOf({}, psid)('s1', 'codex')).toBe(false);
  });
});
