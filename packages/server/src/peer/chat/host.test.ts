import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveEpochKeys,
  PEER_CHAT_BLOB_MAX_BYTES,
  openPeerChatReply,
  peerChatExpiresAt,
  randomEpochKey,
  sealPeerChat,
  sealPeerChatBlob,
  type PeerChatBellReply,
  type PeerChatOp,
  type PeerChatReply,
  type PeerChatState,
  type PeerKeyring,
} from '@agent-hangar/shared';
import { sanitizeInput } from '../../mcp/screenTools.ts';
import type { PaneKey } from '../../tmux/pane.ts';
import { WIN_BUSY_WITH_DRAFT, WIN_DRAFT, WIN_EMPTY_AFTER_TURN } from './inputBox.fixtures.ts';
import { EDIT_SUBDIR } from './fileDialogs.fixtures.ts';
import { createPeerChatHost, type PeerChatHost } from './host.ts';
import type { HostPane, HostSession, PeerChatHostDeps, PeerChatHostEvent } from './hostTypes.ts';

// ---- 偽の世界 ----

const RULE = '╌'.repeat(44);
const PERMISSION_SCREEN = [' Bash command', ' Tip: x', ' mock desc', RULE, ' rm -rf build', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again", '   3. No', ' Esc to cancel · Tab to amend'].join('\n');
const RUNNING_SCREEN = '● Bash(sleep 100)\n  ⎿  Running…\n\n✻ Working… (3s · esc to interrupt)\n';
const IDLE_PLAIN = '● done\n\n❯ \n';

let n = 0;
const uid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const jl = (o: Record<string, unknown>): string => JSON.stringify({ uuid: uid(), isSidechain: false, timestamp: new Date(Date.now()).toISOString(), ...o });
const userLine = (t: string): string => jl({ type: 'user', message: { role: 'user', content: t } });
const asstLine = (t: string): string => jl({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: t }] } });

class FakePane implements HostPane {
  plain = IDLE_PLAIN;
  styled: string | null = WIN_EMPTY_AFTER_TURN;
  events: string[] = [];
  /** '1' を打ったときの動き。 */
  onText: (t: string) => void = () => {};
  captures = 0;
  capture(): string { this.captures++; return this.plain; }
  async captureStyled(): Promise<string | null> { return this.styled; }
  sendKey(key: PaneKey): void { this.events.push(`key:${key}`); }
  sendText(t: string): void { this.events.push(`text:${t}`); this.onText(t); }
}

type World = {
  session: HostSession | null;
  run: { tmuxName: string } | null;
  pane: FakePane;
  lines: string[];
  sent: string[];
  resumed: number;
  resumeFails: boolean;
  events: PeerChatHostEvent[];
  acceptFromPeers: boolean;
  /** 時計の進み（ミリ秒）。期限を過ぎた後の再送の試験に使う。 */
  skew: number;
  blobs: Map<string, Uint8Array>;
};

const idleSession = (over: Partial<HostSession> = {}): HostSession => ({ provider: 'claude-code', live: 'idle', waitingFor: null, permission: null, activity: null, cwd: '/proj', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false, ...over });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function setup(o: Partial<World> & { deps?: Partial<PeerChatHostDeps> } = {}) {
  const keys = await deriveEpochKeys(1, randomEpochKey());
  const ring: PeerKeyring = { current: () => keys, at: (e) => (e === 1 ? keys : null) };
  const dropsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-host-'));
  dirs.push(dropsDir);
  const w: World = { session: idleSession(), run: { tmuxName: 'hangar-1' }, pane: new FakePane(), lines: [userLine('first'), asstLine('hello')], sent: [], resumed: 0, resumeFails: false, events: [], acceptFromPeers: true, skew: 0, blobs: new Map(), ...o };
  const deps: PeerChatHostDeps = {
    deviceId: 'pc-a',
    now: () => Date.now() + w.skew,
    ring: async () => ring,
    acceptFromPeers: () => w.acceptFromPeers,
    deviceName: (id) => (id === 'pc-b' ? 'Mac' : id === 'pc-c' ? 'Linux' : id),
    session: () => w.session,
    run: () => w.run,
    pane: () => w.pane,
    readTranscript: () => ({ key: String(w.lines.length), read: () => Buffer.from(w.lines.join('\n') + '\n') }),
    sendInput: async (_sid, _tmux, text) => {
      w.sent.push(text);
      // 入れたら、ターンが走り出す。
      w.pane.plain = RUNNING_SCREEN;
      w.pane.styled = WIN_BUSY_WITH_DRAFT;
      if (w.session) w.session.live = 'busy';
    },
    resume: async () => {
      w.resumed++;
      if (w.resumeFails) throw new Error('boom');
      w.run = { tmuxName: 'hangar-2' };
      if (w.session) w.session.live = 'idle';
    },
    fetchBlob: async (askId, _from, i) => {
      const b = w.blobs.get(`${askId}/${i}`);
      if (!b) throw new Error('404');
      return b;
    },
    dropsDir,
    files: async (root, q) => [{ path: `${root}:${q}`, changed: false }],
    emit: (ev) => { w.events.push(ev); },
    queue: { pollMs: 5, settleMs: 20 },
    recheckMs: 20,
    ...o.deps,
  };
  const host = createPeerChatHost(deps);
  cleanups.push(() => host.dispose());
  let seq = 0;
  /** 封じた頼みを呼び鈴の枠で渡し、答えを開いて返す。 */
  async function ask(op: PeerChatOp, over: { from?: string; expiresAt?: number; sessionId?: string; id?: string } = {}): Promise<PeerChatReply> {
    const r = await askRaw(op, over);
    if (!r) throw new Error('no reply');
    return r.reply;
  }
  async function askRaw(op: PeerChatOp, over: { from?: string; expiresAt?: number; sessionId?: string; id?: string } = {}): Promise<{ frame: PeerChatBellReply; reply: PeerChatReply } | null> {
    const id = over.id ?? `ask-${++seq}`;
    const from = over.from ?? 'pc-b';
    const route = { requestId: id, from, to: 'pc-a' };
    const sealed = await sealPeerChat(ring, route, { v: 1, askId: id, expiresAt: over.expiresAt ?? peerChatExpiresAt(Date.now()), sessionId: over.sessionId ?? 's1', op });
    const frame = await host.handle({ t: 'chat', id, from, epoch: 1, sealed });
    if (!frame) return null;
    expect(frame).toMatchObject({ t: 'chat-reply', id, from });
    return { frame, reply: await openPeerChatReply(ring, route, frame.sealed) };
  }
  const state = (r: PeerChatReply): PeerChatState => {
    if (!r.ok || !r.state) throw new Error(`no state: ${JSON.stringify(r)}`);
    return r.state;
  };
  return { w, host, ring, ask, askRaw, state, dropsDir, deps };
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
const settle = (cond: () => boolean): Promise<void> => vi.waitFor(() => { if (!cond()) throw new Error('not yet'); }, { timeout: 3000, interval: 5 });
const send = (text: string, images: Extract<PeerChatOp, { t: 'send' }>['images'] = []): PeerChatOp => ({ t: 'send', text, images });
const tailOp = (after: string | null = null, waitMs = 0): PeerChatOp => ({ t: 'tail', after, waitMs });

// ---- 試験 ----

describe('PeerChatHost: 入口と断り', () => {
  it('開けない頼み（別の宛先、壊れた封、別の世代）には答えない。', async () => {
    const s = await setup();
    expect(await s.host.handle({ t: 'chat', id: 'x', from: 'pc-b', epoch: 1, sealed: 'garbage' })).toBeNull();
    const other = await deriveEpochKeys(1, randomEpochKey());
    const sealed = await sealPeerChat({ current: () => other, at: () => other }, { requestId: 'y', from: 'pc-b', to: 'pc-a' }, { v: 1, askId: 'y', expiresAt: peerChatExpiresAt(Date.now()), sessionId: 's1', op: tailOp() });
    expect(await s.host.handle({ t: 'chat', id: 'y', from: 'pc-b', epoch: 1, sealed })).toBeNull();
  });

  it('同期の鍵が無ければ答えない', async () => {
    const s = await setup({ deps: { ring: async () => null } });
    expect(await s.host.handle({ t: 'chat', id: 'x', from: 'pc-b', epoch: 1, sealed: 'x.y' })).toBeNull();
  });

  it('期限切れは expired で断り、何もしない（預かりも入力も無い）', async () => {
    const s = await setup();
    const r = await s.ask(send('late'), { expiresAt: Date.now() - 1 });
    expect(r).toEqual({ ok: false, reason: 'expired' });
    expect(await s.ask(tailOp(), { expiresAt: Date.now() - 1 })).toEqual({ ok: false, reason: 'expired' });
    expect(s.w.sent).toEqual([]);
    expect(s.w.events).toEqual([]);
  });

  it('この PC に無い会話は session-unknown、Claude Code 以外は not-claude', async () => {
    const s = await setup({ session: null });
    expect(await s.ask(tailOp())).toEqual({ ok: false, reason: 'session-unknown' });
    s.w.session = idleSession({ provider: 'codex' });
    for (const op of [tailOp(), send('x'), { t: 'interrupt' } as PeerChatOp, { t: 'files', query: '' } as PeerChatOp]) expect(await s.ask(op)).toEqual({ ok: false, reason: 'not-claude' });
  });

  it('設定が切れていれば、送る系は refused-by-setting。tail と files は通る', async () => {
    const s = await setup({ acceptFromPeers: false });
    const sending: PeerChatOp[] = [send('x'), { t: 'answer', askId: 'a', keys: ['1'] }, { t: 'interrupt' }, { t: 'resume-send', text: 'x', images: [] }, { t: 'cancel', queueId: 'q' }];
    for (const op of sending) expect(await s.ask(op)).toEqual({ ok: false, reason: 'refused-by-setting' });
    expect((await s.ask(tailOp())).ok).toBe(true);
    expect(await s.ask({ t: 'files', query: 'a' })).toEqual({ ok: true, files: [{ path: '/proj:a', changed: false }] });
    expect(s.w.sent).toEqual([]);
    expect(s.w.pane.events).toEqual([]);
    expect(s.w.resumed).toBe(0);
  });

  it('開けた頼みには必ず 1 つ答える。同じ askId の再送は同じ答えを返し、効果は 1 回', async () => {
    const s = await setup();
    const a = await s.askRaw(send('once'), { id: 'dup' });
    const b = await s.askRaw(send('once'), { id: 'dup' });
    expect(b!.frame.sealed).toBe(a!.frame.sealed);
    await settle(() => s.w.sent.length === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.w.sent).toHaveLength(1);
  });
});

describe('PeerChatHost: tail', () => {
  it('項目があればすぐ返す。状態と cursor を持つ', async () => {
    const s = await setup();
    const st = s.state(await s.ask(tailOp(null, 1000)));
    expect(st.sessionId).toBe('s1');
    expect(st.status).toBe('idle');
    expect(st.items.map((i) => [i.kind, i.text])).toEqual([['user', 'first'], ['assistant', 'hello']]);
    expect(st.cursor).toBe(st.items.at(-1)!.uuid);
    expect(st.queued).toEqual([]);
  });

  it('新しい項目が出るまで待ち、出たら返す', async () => {
    const s = await setup();
    const first = s.state(await s.ask(tailOp()));
    const t0 = Date.now();
    const p = s.ask(tailOp(first.cursor, 3000));
    await new Promise((r) => setTimeout(r, 80));
    s.w.lines.push(asstLine('more'));
    const st = s.state(await p);
    expect(st.items.map((i) => i.text)).toEqual(['more']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('変わらなければ waitMs で空のまま返る', async () => {
    const s = await setup();
    const first = s.state(await s.ask(tailOp()));
    const t0 = Date.now();
    const st = s.state(await s.ask(tailOp(first.cursor, 150)));
    expect(st.items).toEqual([]);
    expect(st.cursor).toBe(first.cursor);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
  });

  it('状態（status）が変われば、項目が無くても返す', async () => {
    const s = await setup();
    const first = s.state(await s.ask(tailOp()));
    const p = s.ask(tailOp(first.cursor, 3000));
    await new Promise((r) => setTimeout(r, 50));
    s.w.session!.live = 'busy';
    s.host.poke('s1');
    const st = s.state(await p);
    expect(st.status).toBe('busy');
    expect(st.items).toEqual([]);
  });

  it('動いている run が無ければ stopped', async () => {
    const s = await setup({ run: null, session: idleSession({ live: null }) });
    expect(s.state(await s.ask(tailOp())).status).toBe('stopped');
  });

  it('出ている許可を札の項目にして返す（画面の選択肢の文で）', async () => {
    const s = await setup({ session: idleSession({ live: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf build', description: 'd' } }) });
    s.w.pane.plain = PERMISSION_SCREEN;
    const st = s.state(await s.ask(tailOp()));
    expect(st.status).toBe('waiting');
    const ask = st.items.at(-1)!.ask!;
    expect(ask.kind).toBe('permission');
    expect(ask.options.map((o) => o.label)).toEqual(['Yes', "Yes, and don't ask again", 'No']);
    expect(ask.tool).toBe('Bash');
    expect(ask.input).toBe('rm -rf build');
  });
});

describe('PeerChatHost: send と預かり', () => {
  it('作業中の send は預かり、止まって入力欄が空なら渡す。渡した文に送り主が付く', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    s.w.pane.plain = RUNNING_SCREEN;
    const r = await s.ask(send('from the mac'));
    expect(r.ok && r.queueId).toBeTruthy();
    await new Promise((x) => setTimeout(x, 60));
    expect(s.w.sent).toEqual([]);
    const queued = s.state(await s.ask(tailOp())).queued;
    expect(queued).toMatchObject([{ queueId: (r as { queueId: string }).queueId, from: { deviceId: 'pc-b', deviceName: 'Mac' }, text: 'from the mac', images: 0, state: 'waiting' }]);
    expect(s.w.events.at(-1)).toMatchObject({ type: 'peerChat.queue', sessionId: 's1' });
    // 画面を開き直したときの最初の状態（bootstrap）は、同じ預かりを会話の id ごとに返す。
    expect(s.host.queued()).toMatchObject({ s1: [{ text: 'from the mac', from: { deviceName: 'Mac' } }] });
    // ターンが止まる。
    s.w.session!.live = 'idle';
    s.w.pane.plain = IDLE_PLAIN;
    s.w.pane.styled = WIN_EMPTY_AFTER_TURN;
    s.host.turnChanged();
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['from the mac']);
    expect(s.w.events.find((e) => e.type === 'peerChat.delivered')).toMatchObject({ sessionId: 's1', from: { deviceId: 'pc-b', deviceName: 'Mac' } });
    expect(s.w.events.filter((e) => e.type === 'peerChat.queue').at(-1)).toMatchObject({ queued: [] });
    expect(s.host.queued()).toEqual({});
    // 本文に出た利用者の行に、送り主が付く。
    s.w.lines.push(userLine('from the mac'));
    const st = s.state(await s.ask(tailOp(null)));
    expect(st.items.filter((i) => i.kind === 'user').map((i) => [i.text, i.from?.deviceName])).toEqual([['first', undefined], ['from the mac', 'Mac']]);
  });

  it('止まって入力欄が空なら、すぐ渡す（預かりを通る）', async () => {
    const s = await setup();
    const r = await s.ask(send('now'));
    expect(r.ok).toBe(true);
    await settle(() => s.w.sent.length === 1);
  });

  it('打ちかけがあれば渡さない。消えたら渡す', async () => {
    const s = await setup();
    s.w.pane.styled = WIN_DRAFT;
    await s.ask(send('do not mix'));
    await new Promise((x) => setTimeout(x, 100));
    expect(s.w.sent).toEqual([]);
    expect(s.state(await s.ask(tailOp())).queued).toHaveLength(1);
    s.w.pane.styled = WIN_EMPTY_AFTER_TURN;
    await settle(() => s.w.sent.length === 1);
  });

  it('止まってから 10 分（ここでは短縮）渡せなければ捨て、送り主の state.gone に queue-expired を載せる', async () => {
    const s = await setup({ deps: { queue: { pollMs: 5, settleMs: 20, expireMs: 60 } } });
    s.w.pane.styled = WIN_DRAFT;
    const r = (await s.ask(send('stale'))) as { ok: true; queueId: string };
    await settle(() => s.w.events.some((e) => e.type === 'peerChat.queue' && e.queued.length === 0));
    const st = s.state(await s.ask(tailOp()));
    expect(st.queued).toEqual([]);
    expect(st.gone).toEqual([{ queueId: r.queueId, reason: 'queue-expired' }]);
    // ほかの PC には載せない。
    expect(s.state(await s.ask(tailOp(), { from: 'pc-c' })).gone).toBeUndefined();
    expect(s.w.sent).toEqual([]);
  });

  it('cancel は送り主だけができる', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    const r = (await s.ask(send('mine'))) as { ok: true; queueId: string };
    expect(await s.ask({ t: 'cancel', queueId: r.queueId }, { from: 'pc-c' })).toEqual({ ok: false, reason: 'queue-expired' });
    expect(await s.ask({ t: 'cancel', queueId: r.queueId })).toEqual({ ok: true });
    expect(s.state(await s.ask(tailOp())).queued).toEqual([]);
    expect(await s.ask({ t: 'cancel', queueId: r.queueId })).toEqual({ ok: false, reason: 'queue-expired' });
  });

  it('預かりが上限なら rate', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    for (let i = 0; i < 20; i++) expect((await s.ask(send(`m${i}`))).ok).toBe(true);
    expect(await s.ask(send('one more'))).toEqual({ ok: false, reason: 'rate' });
  });

  it('止まった会話への send は session-unknown（再開して送るは resume-send）', async () => {
    const s = await setup({ run: null, session: idleSession({ live: null }) });
    expect(await s.ask(send('x'))).toEqual({ ok: false, reason: 'session-unknown' });
  });

  it('会話が消えたら預かりを捨て、送り主に session-unknown を載せる', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    const r = (await s.ask(send('x'))) as { ok: true; queueId: string };
    s.host.dropSession('s1');
    const st = s.state(await s.ask(tailOp()));
    expect(st.queued).toEqual([]);
    expect(st.gone).toEqual([{ queueId: r.queueId, reason: 'session-unknown' }]);
  });

  it('画像は封を開いて drops に置き、パスを文の末尾に足して渡す', async () => {
    const s = await setup();
    // 画像の封は頼みと同じ鍵の束で封じる。
    s.w.blobs.set('img-ask/0', await sealPeerChatBlob(s.ring, { requestId: 'img-ask', from: 'pc-b', to: 'pc-a' }, 0, new Uint8Array([1, 2, 3])));
    const r = await s.ask(send('see this', [{ n: 0, mime: 'image/png', bytes: 3 }]), { id: 'img-ask' });
    expect(r.ok).toBe(true);
    await settle(() => s.w.sent.length === 1);
    const files = fs.readdirSync(s.dropsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/phone-1\.png$|peer-1\.png$/);
    expect(s.w.sent[0]).toContain('see this');
    expect(s.w.sent[0]).toContain(path.join(s.dropsDir, files[0]!));
    expect(Array.from(fs.readFileSync(path.join(s.dropsDir, files[0]!)))).toEqual([1, 2, 3]);
  });

  it('画像が取れなければ、何も預からずに断る', async () => {
    const s = await setup();
    const r = await s.ask(send('see', [{ n: 0, mime: 'image/png', bytes: 3 }]));
    expect(r).toEqual({ ok: false, reason: 'expired' });
    expect(s.w.sent).toEqual([]);
    expect(s.state(await s.ask(tailOp())).queued).toEqual([]);
  });

  it('画像の封が上限を超えていれば too-large で断り、置いた分も残さない', async () => {
    const s = await setup();
    s.w.blobs.set('big/0', new Uint8Array(PEER_CHAT_BLOB_MAX_BYTES + 1));
    const r = await s.ask(send('big', [{ n: 0, mime: 'image/png', bytes: 3 }]), { id: 'big' });
    expect(r).toEqual({ ok: false, reason: 'too-large' });
    expect(fs.readdirSync(s.dropsDir)).toEqual([]);
    expect(s.w.sent).toEqual([]);
  });

  it('複数行の文（タブと日本語を含む）は、そのまま入力欄へ渡す。制御文字だけを落とす', async () => {
    const s = await setup();
    const text = '一行目\n\t字下げ\n三行目 ```code```';
    expect(sanitizeInput(text)).toBe(text);
    expect(sanitizeInput('a\r\nb\u001b[31m')).toBe('a\nb[31m');
    await s.ask(send(text));
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual([text]);
  });

  it('預かりに入れた画像は、預かりの ID で結び付く（別の文の画像を取り違えない）', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    const route = (id: string) => ({ requestId: id, from: 'pc-b', to: 'pc-a' });
    s.w.blobs.set('a1/0', await sealPeerChatBlob(s.ring, route('a1'), 0, new Uint8Array([1])));
    s.w.blobs.set('a2/0', await sealPeerChatBlob(s.ring, route('a2'), 0, new Uint8Array([2])));
    await s.ask(send('first', [{ n: 0, mime: 'image/png', bytes: 1 }]), { id: 'a1' });
    await s.ask(send('plain'), { id: 'a-plain' });
    await s.ask(send('second', [{ n: 0, mime: 'image/png', bytes: 1 }]), { id: 'a2' });
    s.w.session!.live = 'idle';
    s.w.pane.plain = IDLE_PLAIN;
    s.w.pane.styled = WIN_EMPTY_AFTER_TURN;
    // 1 件渡すたびにターンが走り出すので、止めながら 3 件を順に渡させる。
    for (let i = 1; i <= 3; i++) {
      s.host.turnChanged();
      await settle(() => s.w.sent.length === i);
      s.w.session!.live = 'idle';
      s.w.pane.plain = IDLE_PLAIN;
      s.w.pane.styled = WIN_EMPTY_AFTER_TURN;
    }
    expect(s.w.sent[0]).toMatch(/^first\n\n.*peer-1\.png/);
    expect(s.w.sent[1]).toBe('plain');
    expect(s.w.sent[2]).toMatch(/^second\n\n.*peer-1\.png/);
    expect(s.w.sent[0]).not.toBe(s.w.sent[2]);
  });
});

describe('PeerChatHost: この PC の会話でないもの', () => {
  const flags = ['lock', 'newerElsewhere', 'remoteOnly', 'takenOver'] as const;
  for (const flag of flags) {
    it(`${flag} が真なら、読む系も送る系も session-unknown、resume-send は resume-failed で、何もしない`, async () => {
      const s = await setup({ run: null, session: idleSession({ live: null, [flag]: true }) });
      const others: PeerChatOp[] = [tailOp(), send('x'), { t: 'answer', askId: 'a', keys: ['1'] }, { t: 'interrupt' }, { t: 'cancel', queueId: 'q' }, { t: 'files', query: '' }];
      for (const op of others) expect(await s.ask(op)).toEqual({ ok: false, reason: 'session-unknown' });
      expect(await s.ask({ t: 'resume-send', text: 'x', images: [] })).toEqual({ ok: false, reason: 'resume-failed' });
      expect(s.w.resumed).toBe(0);
      expect(s.w.sent).toEqual([]);
      expect(s.w.pane.events).toEqual([]);
    });
  }
});

describe('PeerChatHost: 再送と想定外の失敗', () => {
  it('開けない枠を大量に送っても、生きている頼みの覚えは消えない（捕まえた封は再送できない）', async () => {
    const s = await setup();
    const a = await s.askRaw(send('once'), { id: 'cap' });
    for (let i = 0; i < 600; i++) expect(await s.host.handle({ t: 'chat', id: `junk-${i}`, from: 'pc-b', epoch: 1, sealed: 'junk' })).toBeNull();
    const b = await s.askRaw(send('once'), { id: 'cap' });
    expect(b!.frame.sealed).toBe(a!.frame.sealed);
    await settle(() => s.w.sent.length === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.w.sent).toHaveLength(1);
  });

  it('覚えが頼み主ごとの上限に達したら、その頼み主の新しい頼みを rate で断る。生きている覚えは追い出さず、ほかの頼み主は通り、断った頼みの再送も実行しない', async () => {
    const s = await setup();
    const first = await s.askRaw(send('once'), { id: 'first' });
    for (let i = 0; i < 159; i++) await s.ask(tailOp(), { id: `fill-${i}` });
    const over = await s.askRaw(send('overflow'), { id: 'overflow' });
    expect(over!.reply).toEqual({ ok: false, reason: 'rate' });
    expect((await s.ask(tailOp(), { id: 'other-sender', from: 'pc-c' })).ok).toBe(true);
    const replay = await s.askRaw(send('overflow'), { id: 'overflow' });
    expect(replay!.frame.sealed).toBe(over!.frame.sealed);
    expect(s.w.sent).not.toContain('overflow');
    const again = await s.askRaw(send('once'), { id: 'first' });
    expect(again!.frame.sealed).toBe(first!.frame.sealed);
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toHaveLength(1);
  });

  it('期限を過ぎてからの再送は expired で断り、もう一度は実行しない', async () => {
    const s = await setup();
    const id = 'late';
    const route = { requestId: id, from: 'pc-b', to: 'pc-a' };
    const sealed = await sealPeerChat(s.ring, route, { v: 1, askId: id, expiresAt: peerChatExpiresAt(Date.now()), sessionId: 's1', op: send('once') });
    const frame = { t: 'chat' as const, id, from: 'pc-b', epoch: 1, sealed };
    const first = await s.host.handle(frame);
    expect(await openPeerChatReply(s.ring, route, first!.sealed)).toMatchObject({ ok: true });
    await settle(() => s.w.sent.length === 1);
    // 期限と時計のずれの幅を過ぎる。覚えは時間で消えるが、再送は期限切れで断られる。
    s.w.skew = 5 * 60_000;
    const replay = await s.host.handle(frame);
    expect(await openPeerChatReply(s.ring, route, replay!.sealed)).toEqual({ ok: false, reason: 'expired' });
    expect(s.w.sent).toHaveLength(1);
  });

  it('期限が遠い未来の頼みは expired で断り、時がたって通る時刻になってからの再送も、実行せずに同じ断りを返す', async () => {
    const s = await setup();
    const id = 'future';
    const route = { requestId: id, from: 'pc-b', to: 'pc-a' };
    const sealed = await sealPeerChat(s.ring, route, { v: 1, askId: id, expiresAt: Date.now() + 10 * 60_000, sessionId: 's1', op: send('later') });
    const frame = { t: 'chat' as const, id, from: 'pc-b', epoch: 1, sealed };
    const first = await s.host.handle(frame);
    expect(await openPeerChatReply(s.ring, route, first!.sealed)).toEqual({ ok: false, reason: 'expired' });
    // 9 分半進む。期限は窓の中に入り、覚えが無ければ通ってしまう時刻。
    s.w.skew = 9.5 * 60_000;
    const replay = await s.host.handle(frame);
    expect(replay!.sealed).toBe(first!.sealed);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.w.sent).toEqual([]);
  });

  it('host の中の想定外の失敗は host-error で返す（offline と取り違えない）', async () => {
    const s = await setup({ deps: { files: async () => { throw new Error('disk'); } } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await s.ask({ t: 'files', query: '' })).toEqual({ ok: false, reason: 'host-error' });
    expect(spy).toHaveBeenCalledWith('[peer-chat] request failed inside the host', 'files', 'Error');
    spy.mockRestore();
  });
});

describe('PeerChatHost: 札が出ている間の画面の取り込み', () => {
  it('長いポーリングは、登録の状態が同じなら画面を取り込み直さない。答えるときは必ず取り込み直す', async () => {
    const s = await setup({ session: idleSession({ live: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf build', description: 'd' } }), deps: { recheckMs: 60_000 } });
    s.w.pane.plain = PERMISSION_SCREEN;
    const st = s.state(await s.ask(tailOp()));
    const ask = st.items.at(-1)!.ask!;
    const base = s.w.pane.captures;
    for (let i = 0; i < 5; i++) await s.ask(tailOp(st.cursor, 0));
    expect(s.w.pane.captures).toBe(base);
    s.w.pane.onText = (t) => { if (t === '1') { s.w.pane.plain = RUNNING_SCREEN; s.w.session!.live = 'busy'; } };
    expect((await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] })).ok).toBe(true);
    expect(s.w.pane.captures).toBeGreaterThan(base);
  });

  it('待っている間、確かめ直しの間隔が何度来ても、変わらなければ取り込みは 1 回。poke で取り込み直す', async () => {
    const s = await setup({ session: idleSession({ live: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf build', description: 'd' } }), deps: { recheckMs: 10 } });
    s.w.pane.plain = PERMISSION_SCREEN;
    const st = s.state(await s.ask(tailOp()));
    const base = s.w.pane.captures;
    // 10 ms ごとに確かめ直す長いポーリングを 300 ms 待たせる（確かめ直しは 20 回ほど）。
    const idle = s.state(await s.ask(tailOp(st.cursor, 300)));
    expect(idle.items).toEqual([]);
    expect(s.w.pane.captures).toBe(base);
    s.host.poke('s1');
    await s.ask(tailOp(st.cursor, 0));
    expect(s.w.pane.captures).toBe(base + 1);
  });
});

describe('PeerChatHost: answer と interrupt', () => {
  const permSession = (): HostSession => idleSession({ live: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf build', description: 'd' } });
  async function withPermission() {
    const s = await setup({ session: permSession() });
    s.w.pane.plain = PERMISSION_SCREEN;
    // '1' を打てば札が閉じ、ターンが走る。
    s.w.pane.onText = (t) => {
      if (t === '1' && s.w.pane.plain === PERMISSION_SCREEN) { s.w.pane.plain = RUNNING_SCREEN; s.w.session!.live = 'busy'; }
    };
    const st = s.state(await s.ask(tailOp()));
    const ask = st.items.at(-1)!.ask!;
    return { s, ask, askItemUuid: st.items.at(-1)!.uuid };
  }

  it('札が合えばキーを 1 回打ち、答えた PC を記録する。両方の PC の tail に「Mac で許可」が出る', async () => {
    const { s, ask, askItemUuid } = await withPermission();
    const r = await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] });
    expect(r.ok).toBe(true);
    expect(s.w.pane.events).toEqual(['text:1']);
    const st = s.state(await s.ask(tailOp()));
    const answered = st.items.find((i) => i.ask?.askId === ask.askId);
    expect(answered?.uuid).toBe(askItemUuid);
    expect(answered?.ask?.answered).toMatchObject({ by: { deviceId: 'pc-b', deviceName: 'Mac' }, label: 'Yes' });
    // 答えた記録は cursor を動かさず、待っていた tail を空振りで起こし続けない。
    const again = s.state(await s.ask(tailOp(st.cursor, 120)));
    expect(again.items.filter((i) => !i.ask)).toEqual([]);
  });

  it('ファイルの道具の札（Edit）も、hook の絶対パスと cwd で相対の画面のパスを突き合わせて答える', async () => {
    const cwd = 'C:\\Users\\dev\\work\\proj';
    const s = await setup({ session: idleSession({ cwd, live: 'waiting', waitingFor: 'permission', permission: { tool: 'Edit', input: `${cwd}\\sub\\m.txt`, description: null } }) });
    s.w.pane.plain = EDIT_SUBDIR;
    s.w.pane.onText = (t) => { if (t === '1' && s.w.pane.plain === EDIT_SUBDIR) { s.w.pane.plain = RUNNING_SCREEN; s.w.session!.live = 'busy'; } };
    const ask = s.state(await s.ask(tailOp())).items.at(-1)!.ask!;
    expect(ask).toMatchObject({ kind: 'permission', tool: 'Edit', input: `${cwd}\\sub\\m.txt` });
    expect((await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] })).ok).toBe(true);
    expect(s.w.pane.events).toEqual(['text:1']);
  });

  it('ファイルの道具の札で、hook のパスと画面のパスが違えば、何も打たずに断る', async () => {
    const cwd = 'C:\\Users\\dev\\work\\proj';
    const s = await setup({ session: idleSession({ cwd, live: 'waiting', waitingFor: 'permission', permission: { tool: 'Edit', input: `${cwd}\\sub\\other.txt`, description: null } }) });
    s.w.pane.plain = EDIT_SUBDIR;
    const ask = s.state(await s.ask(tailOp())).items.at(-1)!.ask!;
    expect(await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] })).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(s.w.pane.events).toEqual([]);
  });

  it('二重の答え: 2 台から同じ許可に答えても、キーは 1 回だけ。2 台目は already-answered', async () => {
    const { s, ask } = await withPermission();
    const [a, b] = await Promise.all([s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] }), s.ask({ t: 'answer', askId: ask.askId, keys: ['3'] }, { from: 'pc-c' })]);
    const oks = [a, b].filter((r) => r.ok);
    const lost = [a, b].find((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(lost).toEqual({ ok: false, reason: 'already-answered' });
    expect(s.w.pane.events).toEqual(['text:1']);
    // 後から来た 3 台目も同じ。
    expect(await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] }, { from: 'pc-c' })).toEqual({ ok: false, reason: 'already-answered' });
    expect(s.w.pane.events).toEqual(['text:1']);
  });

  it('出ている札と askId が違えば ask-mismatch で、何も打たない', async () => {
    const { s } = await withPermission();
    expect(await s.ask({ t: 'answer', askId: 'old-ask', keys: ['1'] })).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(s.w.pane.events).toEqual([]);
  });

  it('札が出ていなければ ask-mismatch', async () => {
    const s = await setup();
    expect(await s.ask({ t: 'answer', askId: 'x', keys: ['1'] })).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(s.w.pane.events).toEqual([]);
  });

  it('画面の札が替わっていたら（人が手元で先に答えた）打たずに断る', async () => {
    const { s, ask } = await withPermission();
    // 登録はまだ waiting のまま、画面だけが閉じた。
    s.w.pane.plain = RUNNING_SCREEN;
    const r = await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] });
    expect(r.ok).toBe(false);
    expect(s.w.pane.events).toEqual([]);
  });

  it('interrupt は走っているターンに Escape を打つ', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    s.w.pane.plain = RUNNING_SCREEN;
    expect(await s.ask({ t: 'interrupt' })).toEqual({ ok: true });
    expect(s.w.pane.events).toEqual(['key:escape']);
  });

  it('札が出ているときの interrupt は断る（Escape は断りになる）', async () => {
    const { s } = await withPermission();
    expect(await s.ask({ t: 'interrupt' })).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(s.w.pane.events).toEqual([]);
  });
});

describe('PeerChatHost: resume-send', () => {
  it('止まった会話を再開し、画面が使えるようになってから渡す', async () => {
    const s = await setup({ run: null, session: idleSession({ live: null }) });
    const r = await s.ask({ t: 'resume-send', text: 'wake up', images: [] });
    expect(r.ok).toBe(true);
    expect(s.w.resumed).toBe(1);
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['wake up']);
  });

  it('再開に失敗したら resume-failed で、何も預からない', async () => {
    const s = await setup({ run: null, session: idleSession({ live: null }), resumeFails: true });
    expect(await s.ask({ t: 'resume-send', text: 'x', images: [] })).toEqual({ ok: false, reason: 'resume-failed' });
    expect(s.state(await s.ask(tailOp())).queued).toEqual([]);
    expect(s.w.sent).toEqual([]);
  });

  it('再開しても画面が現れなければ resume-failed', async () => {
    const s = await setup({ run: null, session: idleSession({ live: null }), deps: { resumeWaitMs: 60, resume: async () => undefined } });
    expect(await s.ask({ t: 'resume-send', text: 'x', images: [] })).toEqual({ ok: false, reason: 'resume-failed' });
    expect(s.w.sent).toEqual([]);
  });

  it('動いている会話への resume-send は、再開せずに send と同じ', async () => {
    const s = await setup();
    expect((await s.ask({ t: 'resume-send', text: 'plain', images: [] })).ok).toBe(true);
    expect(s.w.resumed).toBe(0);
    await settle(() => s.w.sent.length === 1);
  });
});

describe('PeerChatHost: 答えの大きさ', () => {
  it('大きな預かりと本文があっても、封じられる大きさに収める', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }), lines: Array.from({ length: 300 }, (_, i) => asstLine(`line ${i} ${'x'.repeat(3000)}`)) });
    for (let i = 0; i < 20; i++) await s.ask(send('q'.repeat(30_000)), { from: 'pc-b' });
    const r = await s.ask(tailOp());
    const st = s.state(r);
    expect(st.queued.length).toBe(20);
    expect(st.items.length).toBeGreaterThan(0);
    expect(st.truncated).toBe(true);
  });
});
