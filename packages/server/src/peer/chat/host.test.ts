import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveEpochKeys,
  PEER_CHAT_BLOB_MAX_BYTES,
  PEER_CHAT_COMMAND_DESCRIPTION_MAX,
  PEER_CHAT_COMMANDS_BYTES_MAX,
  PEER_CHAT_COMMANDS_MAX,
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
import { CODEX_EMPTY_AFTER_TURNS, CODEX_TYPED, CODEX_WORKING } from './inputBox.codex.fixtures.ts';
import { OPENCODE_EMPTY_AFTER_TURN, OPENCODE_TYPED } from './inputBox.opencode.fixtures.ts';
import { EDIT_SUBDIR } from './fileDialogs.fixtures.ts';
import { createPeerChatHost, type PeerChatHost } from './host.ts';
import { toPeerChatAsk, type AgentAskPort, type AgentAskQuestion, type AgentAskReply, type AgentPendingAsk } from '../../agent/pendingAsk.ts';
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
  /** スマホからの入力を受けるか（設定 phoneChatAccept）。 */
  acceptFromPhones: boolean;
  /** 時計の進み（ミリ秒）。期限を過ぎた後の再送の試験に使う。 */
  skew: number;
  blobs: Map<string, Uint8Array>;
};

const idleSession = (over: Partial<HostSession> = {}): HostSession => ({ provider: 'claude-code', live: 'idle', aside: false, waitingFor: null, permission: null, activity: null, cwd: '/proj', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false, ...over });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function setup(o: Partial<World> & { deps?: Partial<PeerChatHostDeps> } = {}) {
  const keys = await deriveEpochKeys(1, randomEpochKey());
  const ring: PeerKeyring = { current: () => keys, at: (e) => (e === 1 ? keys : null) };
  const dropsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-host-'));
  dirs.push(dropsDir);
  const w: World = { session: idleSession(), run: { tmuxName: 'hangar-1' }, pane: new FakePane(), lines: [userLine('first'), asstLine('hello')], sent: [], resumed: 0, resumeFails: false, events: [], acceptFromPeers: true, acceptFromPhones: true, skew: 0, blobs: new Map(), ...o };
  const deps: PeerChatHostDeps = {
    deviceId: 'pc-a',
    now: () => Date.now() + w.skew,
    ring: async () => ring,
    acceptFrom: (kind) => (kind === 'phone' ? w.acceptFromPhones : w.acceptFromPeers),
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
    commands: (root) => [{ name: `skill-of:${root}`, description: 'd', argumentHint: null, source: 'project', uses: 0 }],
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
  /** スマホの入口（mobile/chatHost.ts）と同じ道で、開けた頼みを渡す。封は試験では省く（中身をそのまま渡し、答えを JSON で返す）。 */
  async function askPhone(op: PeerChatOp, over: { from?: string; sessionId?: string; id?: string } = {}): Promise<PeerChatReply> {
    const id = over.id ?? `phone-ask-${++seq}`;
    const from = over.from ?? 'phone-1';
    const out = await host.handleRequest({ id: from, kind: 'phone', name: 'iPhone' }, id, async () => ({ v: 1, askId: id, expiresAt: peerChatExpiresAt(Date.now()), sessionId: over.sessionId ?? 's1', op }), async (r) => JSON.stringify(r));
    if (out === null) throw new Error('no reply');
    return JSON.parse(out) as PeerChatReply;
  }
  const state = (r: PeerChatReply): PeerChatState => {
    if (!r.ok || !r.state) throw new Error(`no state: ${JSON.stringify(r)}`);
    return r.state;
  };
  return { w, host, ring, ask, askRaw, askPhone, state, dropsDir, deps };
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

  it('この PC に無い会話は session-unknown、host が受けない provider は not-claude（Codex と opencode は受ける）', async () => {
    const s = await setup({ session: null });
    expect(await s.ask(tailOp())).toEqual({ ok: false, reason: 'session-unknown' });
    s.w.session = idleSession({ provider: 'gemini' as never });
    for (const op of [tailOp(), send('x'), { t: 'interrupt' } as PeerChatOp, { t: 'files', query: '' } as PeerChatOp]) expect(await s.ask(op)).toEqual({ ok: false, reason: 'not-claude' });
  });

  it('設定が切れていれば、送る系は refused-by-setting。tail と files は通る', async () => {
    const s = await setup({ acceptFromPeers: false });
    const sending: PeerChatOp[] = [send('x'), { t: 'answer', askId: 'a', keys: ['1'] }, { t: 'interrupt' }, { t: 'resume-send', text: 'x', images: [] }];
    for (const op of sending) expect(await s.ask(op)).toEqual({ ok: false, reason: 'refused-by-setting' });
    // 取り消しは、送った文を取り戻すだけなので、設定が切れていても断らない（ここでは預かりが無いので queue-expired）。
    expect(await s.ask({ t: 'cancel', queueId: 'q' })).toEqual({ ok: false, reason: 'queue-expired' });
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

describe('PeerChatHost: 古い分と目次', () => {
  it('tail の state に全ターンの数（turnCount）を載せる', async () => {
    const s = await setup({ lines: [userLine('a'), asstLine('x'), userLine('b'), asstLine('y')] });
    expect(s.state(await s.ask(tailOp())).turnCount).toBe(2);
  });

  it('turns は目次の行を、older は指定の前の項目を返す', async () => {
    const lines = [userLine('a'), asstLine('x'), userLine('b'), asstLine('y')];
    const s = await setup({ lines });
    const t = await s.ask({ t: 'turns' });
    expect(t.ok && t.turns?.rows.map((r) => r.text)).toEqual(['a', 'b']);
    const second = t.ok ? t.turns!.rows[1]!.uuid : '';
    const o = await s.ask({ t: 'older', before: second });
    expect(o.ok && o.older?.items.map((i) => i.text)).toEqual(['a', 'x']);
    const f = await s.ask({ t: 'older', before: null, from: second });
    expect(f.ok && f.older?.items.map((i) => i.text)).toEqual(['b', 'y']);
  });

  it('持ち主でない PC では読ませない（session-unknown）', async () => {
    const s = await setup({ session: idleSession({ lock: true } as never) });
    expect(await s.ask({ t: 'turns' })).toEqual({ ok: false, reason: 'session-unknown' });
    expect(await s.ask({ t: 'older', before: 'x' })).toEqual({ ok: false, reason: 'session-unknown' });
  });

  it('設定が切れていても読める（読むだけの頼み）', async () => {
    const s = await setup({ acceptFromPeers: false });
    expect((await s.ask({ t: 'turns' })).ok).toBe(true);
  });
});

describe('PeerChatHost: 会話のアカウント', () => {
  it('state にこの PC での会話のアカウントの名前を載せる（ID は PC ごとに違うので名前）', async () => {
    const s = await setup({ deps: { accountName: (id) => (id === 's1' ? '大学' : null) } });
    expect(s.state(await s.ask(tailOp())).account).toBe('大学');
  });

  it('名前が分からない（Claude でない会話、口の無い組み立て）ときは載せない', async () => {
    const a = await setup({ deps: { accountName: () => null } });
    expect('account' in a.state(await a.ask(tailOp()))).toBe(false);
    const b = await setup();
    expect('account' in b.state(await b.ask(tailOp()))).toBe(false);
  });
});

describe('PeerChatHost: 起動ごとの印', () => {
  it('state に hostId を載せ、同じ host では変わらず、別の host（再起動）では変わる', async () => {
    const a = await setup();
    const b = await setup();
    const ida = a.state(await a.ask(tailOp())).hostId;
    expect(typeof ida).toBe('string');
    expect(a.state(await a.ask(tailOp())).hostId).toBe(ida);
    expect(b.state(await b.ask(tailOp())).hostId).not.toBe(ida);
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

  it('渡している最中に取り消しが間に合わなかったときは、すでに答えがあるとは言わず、queue-expired（もう渡した）で断る', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }), deps: { sendInput: async () => { await new Promise((res) => setTimeout(res, 300)); } } });
    const r = (await s.ask(send('racing cancel'))) as { ok: true; queueId: string };
    s.w.session!.live = 'idle';
    s.host.turnChanged();
    await settle(() => s.host.queued()['s1']?.[0]?.state === 'delivering');
    expect(await s.ask({ t: 'cancel', queueId: r.queueId })).toEqual({ ok: false, reason: 'queue-expired' });
  });

  it('設定を切ったら、預かっていた文は渡さずに捨て、送り主の state.gone に載せる（止まって空いていても渡さない）', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    const r = (await s.ask(send('queued before off'))) as { ok: true; queueId: string };
    s.w.acceptFromPeers = false;
    s.w.session!.live = 'idle';
    s.host.turnChanged();
    await settle(() => s.w.events.some((e) => e.type === 'peerChat.queue' && e.queued.length === 0));
    await new Promise((res) => setTimeout(res, 60));
    expect(s.w.sent).toEqual([]);
    const st = s.state(await s.ask(tailOp()));
    expect(st.queued).toEqual([]);
    expect(st.gone).toEqual([{ queueId: r.queueId, reason: 'queue-expired' }]);
  });

  it('渡す直前（入力欄を読む間）に設定が切れても、渡さない', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    const r = (await s.ask(send('racing'))) as { ok: true; queueId: string };
    s.w.session!.live = 'idle';
    s.w.pane.captureStyled = async () => { s.w.acceptFromPeers = false; return WIN_EMPTY_AFTER_TURN; };
    s.host.turnChanged();
    await settle(() => s.w.events.some((e) => e.type === 'peerChat.queue' && e.queued.length === 0));
    await new Promise((res) => setTimeout(res, 60));
    expect(s.w.sent).toEqual([]);
    expect(s.state(await s.ask(tailOp())).gone).toEqual([{ queueId: r.queueId, reason: 'queue-expired' }]);
  });

  it('設定が切れていても、送り主は預かりを取り消せる（文が戻る）', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }), deps: { queue: { pollMs: 60_000, settleMs: 20 } } });
    const r = (await s.ask(send('mine'))) as { ok: true; queueId: string };
    s.w.acceptFromPeers = false;
    expect(await s.ask({ t: 'cancel', queueId: r.queueId })).toEqual({ ok: true });
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

  it('忙しい会話の見張りを 3 つ（1 分に 90 回、ここでは 1 分に 180 回）続けても、覚えの上限で rate にならない', async () => {
    const s = await setup();
    const reasons = new Set<string>();
    for (let i = 0; i < 300; i++) {
      // 3 件ごとに host の時計が 1 秒進む（100 秒で 300 件）。
      s.w.skew = Math.floor(i / 3) * 1000;
      const r = await s.ask(tailOp(), { id: `busy-${i}`, expiresAt: Date.now() + s.w.skew + 60_000 });
      reasons.add(r.ok ? 'ok' : r.reason);
    }
    expect([...reasons]).toEqual(['ok']);
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

  it('commands は会話の場所の / の候補を返す。設定が切れていても読める', async () => {
    const s = await setup({ acceptFromPeers: false });
    expect(await s.ask({ t: 'commands' })).toEqual({ ok: true, commands: [{ name: 'skill-of:/proj', description: 'd', argumentHint: null, source: 'project', uses: 0 }] });
  });

  it('commands は説明を切り、数とバイト数の上限に収まるまで使った回数の少ないものから落とす（並びは保つ）', async () => {
    const many = Array.from({ length: PEER_CHAT_COMMANDS_MAX + 50 }, (_, i) => ({ name: `s${i}`, description: 'あ'.repeat(500), argumentHint: null, source: 'user' as const, uses: i === 0 ? 0 : i % 7 }));
    const s = await setup({ deps: { commands: () => many } });
    const r = await s.ask({ t: 'commands' });
    if (!r.ok || !r.commands) throw new Error('no commands');
    expect(r.commands.length).toBeGreaterThan(0);
    expect(r.commands.length).toBeLessThanOrEqual(PEER_CHAT_COMMANDS_MAX);
    expect(Buffer.byteLength(JSON.stringify(r.commands))).toBeLessThanOrEqual(PEER_CHAT_COMMANDS_BYTES_MAX);
    expect(r.commands.every((c) => c.description.length <= PEER_CHAT_COMMAND_DESCRIPTION_MAX)).toBe(true);
    const idx = r.commands.map((c) => Number(c.name.slice(1)));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    // 残ったものは、落ちたものより少なく使われていない。
    const kept = new Set(idx);
    const minKept = Math.min(...idx.map((i) => many[i]!.uses));
    expect(many.filter((_, i) => !kept.has(i)).every((c) => c.uses <= minKept)).toBe(true);
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

  // 2 台の頼みが着く順は、暗号の開封の速さで入れ替わる（負荷の高い CI で起きる）。どちらが先でも、打つキーは 1 回だけになる。
  it.each([
    ['pc-b の頼みが先に着く', false],
    ['pc-c の頼みが先に着く', true],
  ])('二重の答え（%s）: 2 台から同じ許可に答えても、キーは 1 回だけ。後の 1 台は already-answered', async (_name, cFirst) => {
    const { s, ask } = await withPermission();
    // どのキーでも札が閉じる（先に着いた方の答えが通る）。
    s.w.pane.onText = (t) => { if ((t === '1' || t === '3') && s.w.pane.plain === PERMISSION_SCREEN) { s.w.pane.plain = RUNNING_SCREEN; s.w.session!.live = 'busy'; } };
    const fromB = (): Promise<PeerChatReply> => s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] });
    const fromC = (): Promise<PeerChatReply> => s.ask({ t: 'answer', askId: ask.askId, keys: ['3'] }, { from: 'pc-c' });
    const [a, b] = cFirst ? await Promise.all([fromC(), fromB()]).then(([c, bb]) => [bb, c] as const) : await Promise.all([fromB(), fromC()]);
    const oks = [a, b].filter((r) => r.ok);
    const lost = [a, b].find((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(lost).toEqual({ ok: false, reason: 'already-answered' });
    expect(s.w.pane.events).toEqual([a.ok ? 'text:1' : 'text:3']);
    const typed = [...s.w.pane.events];
    // 後から来た 3 台目も同じ。
    expect(await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] }, { from: 'pc-c' })).toEqual({ ok: false, reason: 'already-answered' });
    expect(s.w.pane.events).toEqual(typed);
  });

  it('出ている札と askId が違えば ask-mismatch で、何も打たない', async () => {
    const { s } = await withPermission();
    expect(await s.ask({ t: 'answer', askId: 'old-ask', keys: ['1'] })).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(s.w.pane.events).toEqual([]);
  });

  describe('拠り所のない札に tool_use が載って askId が変わったとき', () => {
    const useLine = (): string => jl({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'Bash', input: { command: 'rm -rf build' } }] } });

    it('見る側の画面は札が 1 枚のまま、答えは付かない。言い換え前の askId の答えは、今の札への答えとして受ける', async () => {
      const { s, ask } = await withPermission();
      const first = s.state(await s.ask(tailOp()));
      // tool_use が書かれ、拠り所が見つかって askId が変わる。
      s.w.lines.push(useLine());
      const second = s.state(await s.ask(tailOp(first.cursor)));
      const renewed = second.items.at(-1)!.ask!;
      expect(renewed.askId).not.toBe(ask.askId);
      expect(second.items.filter((i) => i.ask?.answered)).toEqual([]);
      // 見る側が、言い換え前の askId のまま答える。
      expect((await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] })).ok).toBe(true);
      expect(s.w.pane.events).toEqual(['text:1']);
      const done = s.state(await s.ask(tailOp()));
      const cards = done.items.filter((i) => i.ask);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.ask).toMatchObject({ askId: renewed.askId, answered: { by: { deviceId: 'pc-b' }, label: 'Yes' } });
      expect(done.items.at(-1)!.ask?.askId).toBe(renewed.askId);
    });

    it('言い換えを見ていない askId は、今の札があっても ask-mismatch のまま', async () => {
      const { s } = await withPermission();
      const first = s.state(await s.ask(tailOp()));
      s.w.lines.push(useLine());
      await s.ask(tailOp(first.cursor));
      expect(await s.ask({ t: 'answer', askId: 'not-an-old-ask', keys: ['1'] })).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(s.w.pane.events).toEqual([]);
    });

    it('言い換え前の askId でも、札が出ている画面が照合に通らなければ（別の命令の札）打たずに ask-mismatch', async () => {
      const { s, ask } = await withPermission();
      const first = s.state(await s.ask(tailOp()));
      s.w.lines.push(useLine());
      await s.ask(tailOp(first.cursor));
      // 画面にも札は出ているが、命令が登録の許可と違う。
      s.w.pane.plain = PERMISSION_SCREEN.replace('rm -rf build', 'rm -rf other');
      const before = s.w.pane.captures;
      expect(await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] })).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(s.w.pane.captures).toBeGreaterThan(before);
      expect(s.w.pane.events).toEqual([]);
    });

    it('同じ命令の 2 枚目が出る前に 1 枚目が手元で答えられたとき、1 枚目の askId の答えは 2 枚目に入らない', async () => {
      const { s, ask } = await withPermission();
      const first = s.state(await s.ask(tailOp()));
      // 1 枚目の tool_use と結果、同じ命令の 2 回目の tool_use が、観察の間に載る（登録はずっと waiting のまま）。
      s.w.lines.push(useLine());
      s.w.lines.push(jl({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x1', content: 'ok', is_error: false }] } }));
      s.w.lines.push(jl({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_x2', name: 'Bash', input: { command: 'rm -rf build' } }] } }));
      const second = s.state(await s.ask(tailOp(first.cursor)));
      const next = second.items.find((i) => i.ask && !i.ask.answered)!.ask!;
      expect(next.askId).not.toBe(ask.askId);
      expect(await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] })).toEqual({ ok: false, reason: 'already-answered' });
      expect(s.w.pane.events).toEqual([]);
    });
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

  it('この PC の手元で札に答えたら、札を「この PC で答えた」記録にして閉じ、遅れて来た答えは already-answered', async () => {
    const { s, ask, askItemUuid } = await withPermission();
    const before = s.state(await s.ask(tailOp()));
    // 手元の画面で人が答えた（登録も動き出す）。
    s.w.pane.plain = RUNNING_SCREEN;
    s.w.session!.live = 'busy';
    s.host.poke('s1');
    const st = s.state(await s.ask(tailOp(before.cursor, 1000)));
    const closed = st.items.find((i) => i.ask?.askId === ask.askId);
    expect(closed?.uuid).toBe(askItemUuid);
    expect(closed?.ask?.answered).toMatchObject({ by: { deviceId: 'pc-a', deviceName: 'pc-a' }, label: '' });
    // 遅れて来た答えは、札が違うではなく、すでに答えがあると断る。
    expect(await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] }, { from: 'pc-c' })).toEqual({ ok: false, reason: 'already-answered' });
    expect(s.w.pane.events).toEqual([]);
  });

  it('札が出たまま会話が止まった（動いていない）ときは、答えたとは記録しない', async () => {
    const { s, ask } = await withPermission();
    const before = s.state(await s.ask(tailOp()));
    s.w.run = null;
    s.w.session!.live = null;
    s.host.poke('s1');
    const st = s.state(await s.ask(tailOp(before.cursor, 0)));
    expect(st.items.find((i) => i.ask?.askId === ask.askId)?.ask?.answered).toBeUndefined();
  });

  it('画面の読み取りが一度失敗しても（登録はまだ入力待ち）、答えたとは記録しない', async () => {
    const { s, ask } = await withPermission();
    const before = s.state(await s.ask(tailOp()));
    s.w.pane.plain = RUNNING_SCREEN;
    s.host.poke('s1');
    const st = s.state(await s.ask(tailOp(before.cursor, 0)));
    expect(st.items.find((i) => i.ask?.askId === ask.askId)?.ask?.answered).toBeUndefined();
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

describe('PeerChatHost: 裏の作業の間と、中断して渡す', () => {
  it('裏の作業だけが動いている（busy で aside）間は、止まっているときと同じに渡す', async () => {
    const s = await setup({ session: idleSession({ live: 'busy', aside: true }) });
    await s.ask(send('while the shell runs'));
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['while the shell runs']);
  });

  it('rush は Escape を打ってから、ターンを待たずに渡す', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    s.w.pane.plain = RUNNING_SCREEN;
    const r = await s.ask(send('now please'));
    const queueId = (r as { queueId: string }).queueId;
    await new Promise((x) => setTimeout(x, 40));
    expect(s.w.sent).toEqual([]);
    expect(await s.ask({ t: 'rush', queueId })).toEqual({ ok: true });
    expect(s.w.pane.events).toEqual(['key:escape']);
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['now please']);
  });

  it('ほかの PC の預かりの rush は断り、Escape も打たない', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    s.w.pane.plain = RUNNING_SCREEN;
    const r = await s.ask(send('mine'));
    const queueId = (r as { queueId: string }).queueId;
    expect(await s.ask({ t: 'rush', queueId }, { from: 'pc-c' })).toEqual({ ok: false, reason: 'queue-expired' });
    expect(s.w.pane.events).toEqual([]);
    expect(s.w.sent).toEqual([]);
  });

  it('この PC の帯からの rush は、先頭を中断して渡す', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    s.w.pane.plain = RUNNING_SCREEN;
    await s.ask(send('first'));
    await s.ask(send('second'));
    expect(await s.host.rush('s1')).toEqual({ ok: true });
    expect(s.w.pane.events).toEqual(['key:escape']);
    await settle(() => s.w.sent.length === 1);
    await new Promise((x) => setTimeout(x, 60));
    expect(s.w.sent).toEqual(['first']);
    expect(await s.host.rush('nope')).toEqual({ ok: false, reason: 'queue-expired' });
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

  it('画像は再開の前に取る。取れなければ、会話を再開せずに断る', async () => {
    const s = await setup({ run: null, session: idleSession({ live: null }) });
    const r = await s.ask({ t: 'resume-send', text: 'x', images: [{ n: 0, mime: 'image/png', bytes: 3 }] });
    expect(r).toEqual({ ok: false, reason: 'expired' });
    expect(s.w.resumed).toBe(0);
    expect(fs.readdirSync(s.dropsDir)).toEqual([]);
  });

  it('頼み主の待ち（waitMs）を過ぎたら、expired で断り、あとで画面が現れても預からない（二重に渡さない）', async () => {
    const s = await setup({
      run: null,
      session: idleSession({ live: null }),
      deps: {
        resumeWaitMs: 5000,
        resume: async () => {
          setTimeout(() => { s.w.run = { tmuxName: 'hangar-2' }; s.w.session!.live = 'idle'; }, 250);
        },
      },
    });
    const t0 = Date.now();
    const r = await s.ask({ t: 'resume-send', text: 'late', images: [], waitMs: 100 });
    expect(r).toEqual({ ok: false, reason: 'expired' });
    expect(Date.now() - t0).toBeLessThan(240);
    await new Promise((res) => setTimeout(res, 500));
    expect(s.w.sent).toEqual([]);
    expect(s.state(await s.ask(tailOp())).queued).toEqual([]);
  });

  it('画像の取り込みが待ちを過ぎたら、expired で断り、預からず、置いた画像も残さない', async () => {
    const s = await setup({ deps: { fetchBlob: async () => { await new Promise((res) => setTimeout(res, 250)); return sealed; } } });
    const sealed = await sealPeerChatBlob(s.ring, { requestId: 'slow', from: 'pc-b', to: 'pc-a' }, 0, new Uint8Array([1, 2, 3]));
    const r = await s.ask({ t: 'send', text: 'slow image', images: [{ n: 0, mime: 'image/png', bytes: 3 }], waitMs: 100 }, { id: 'slow' });
    expect(r).toEqual({ ok: false, reason: 'expired' });
    await new Promise((res) => setTimeout(res, 500));
    expect(s.w.sent).toEqual([]);
    expect(s.state(await s.ask(tailOp())).queued).toEqual([]);
    expect(fs.readdirSync(s.dropsDir)).toEqual([]);
  });

  it('待ちの中で済めば（waitMs 内）、これまでどおり預かる', async () => {
    const s = await setup({ run: null, session: idleSession({ live: null }) });
    expect((await s.ask({ t: 'resume-send', text: 'in time', images: [], waitMs: 5000 })).ok).toBe(true);
    await settle(() => s.w.sent.length === 1);
  });

  it('動いている会話への resume-send は、再開せずに send と同じ', async () => {
    const s = await setup();
    expect((await s.ask({ t: 'resume-send', text: 'plain', images: [] })).ok).toBe(true);
    expect(s.w.resumed).toBe(0);
    await settle(() => s.w.sent.length === 1);
  });
});

describe('PeerChatHost: switch-account', () => {
  it('名前を渡して付け替え、通れば ok で答える', async () => {
    const got: [string, string][] = [];
    const s = await setup({ deps: { switchAccount: async (sid, name) => { got.push([sid, name]); return 'ok'; } } });
    expect(await s.ask({ t: 'switch-account', account: '会社' })).toMatchObject({ ok: true });
    expect(got).toEqual([['s1', '会社']]);
  });

  it('付け替えの断り（無い名前、ログインしていない、起こせない）をそのまま返す', async () => {
    for (const reason of ['account-unavailable', 'resume-failed'] as const) {
      const s = await setup({ deps: { switchAccount: async () => reason } });
      expect(await s.ask({ t: 'switch-account', account: 'x' })).toEqual({ ok: false, reason });
    }
  });

  it('付け替えの口が無い組み立てでは resume-failed', async () => {
    const s = await setup();
    expect(await s.ask({ t: 'switch-account', account: 'x' })).toEqual({ ok: false, reason: 'resume-failed' });
  });

  it('送る系として、設定が切れていれば refused-by-setting で、付け替えない', async () => {
    let called = 0;
    const s = await setup({ acceptFromPeers: false, deps: { switchAccount: async () => { called++; return 'ok'; } } });
    expect(await s.ask({ t: 'switch-account', account: 'x' })).toEqual({ ok: false, reason: 'refused-by-setting' });
    expect(called).toBe(0);
  });

  it('この PC の会話でなければ resume-failed で、付け替えない', async () => {
    let called = 0;
    const s = await setup({ session: idleSession({ lock: true }), deps: { switchAccount: async () => { called++; return 'ok'; } } });
    expect(await s.ask({ t: 'switch-account', account: 'x' })).toEqual({ ok: false, reason: 'resume-failed' });
    expect(called).toBe(0);
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

describe('PeerChatHost: この PC の中からの答え（統括の answer_ask の口）', () => {
  const permSession = (): HostSession => idleSession({ live: 'waiting', waitingFor: 'permission', permission: { tool: 'Bash', input: 'rm -rf build', description: 'd' } });
  async function withPermission() {
    const s = await setup({ session: permSession() });
    s.w.pane.plain = PERMISSION_SCREEN;
    s.w.pane.onText = (t) => {
      if (t === '1' && s.w.pane.plain === PERMISSION_SCREEN) { s.w.pane.plain = RUNNING_SCREEN; s.w.session!.live = 'busy'; }
    };
    return s;
  }

  it('いまの札を、ほかの PC に見せるのと同じ askId と選択肢で返す', async () => {
    const s = await withPermission();
    const local = s.host.local.currentAsk('s1');
    const peer = s.state(await s.ask(tailOp())).items.at(-1)!.ask!;
    expect(local).toMatchObject({ askId: peer.askId, kind: 'permission', tool: 'Bash', input: 'rm -rf build' });
    expect(local!.options.map((o) => o.label)).toEqual(peer.options.map((o) => o.label));
  });

  it('札が合えばキーを 1 回打ち、押した行を返す。同じ札に後から来たほかの PC の答えは already-answered', async () => {
    const s = await withPermission();
    const ask = s.host.local.currentAsk('s1')!;
    expect(await s.host.local.answer('s1', ask.askId, ['1'])).toEqual({ ok: true, label: 'Yes' });
    expect(s.w.pane.events).toEqual(['text:1']);
    expect(await s.ask({ t: 'answer', askId: ask.askId, keys: ['1'] })).toEqual({ ok: false, reason: 'already-answered' });
    expect(await s.host.local.answer('s1', ask.askId, ['1'])).toEqual({ ok: false, reason: 'already-answered' });
    expect(s.w.pane.events).toEqual(['text:1']);
  });

  it('札と askId が違えば ask-mismatch で、何も打たない', async () => {
    const s = await withPermission();
    expect(await s.host.local.answer('s1', 'old-ask', ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(s.w.pane.events).toEqual([]);
  });

  it('ほかの PC からの頼みの入り切り（peerChatAcceptFromPeers）には縛られない', async () => {
    const s = await withPermission();
    s.w.acceptFromPeers = false;
    const ask = s.host.local.currentAsk('s1')!;
    expect((await s.host.local.answer('s1', ask.askId, ['1'])).ok).toBe(true);
  });

  it('この PC の会話でない会話には、札を返さず答えない。札の口の無い Codex の会話にも、Claude の画面の札は読まず、打たない', async () => {
    const s1 = await setup({ session: { ...permSession(), lock: true } });
    s1.w.pane.plain = PERMISSION_SCREEN;
    expect(s1.host.local.currentAsk('s1')).toBeNull();
    expect(await s1.host.local.answer('s1', 'x', ['1'])).toEqual({ ok: false, reason: 'session-unknown' });
    const s2 = await setup({ session: { ...permSession(), provider: 'codex' } });
    s2.w.pane.plain = PERMISSION_SCREEN;
    expect(s2.host.local.currentAsk('s1')).toBeNull();
    expect(await s2.host.local.answer('s1', 'x', ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(s1.w.pane.events).toEqual([]);
    expect(s2.w.pane.events).toEqual([]);
  });
});

describe('PeerChatHost: 送り主ごとの入り切り（スマホと PC）', () => {
  const sending: PeerChatOp[] = [send('x'), { t: 'answer', askId: 'a', keys: ['1'] }, { t: 'interrupt' }, { t: 'resume-send', text: 'x', images: [] }, { t: 'rush', queueId: 'q' }];

  it('スマホを切、PC を入にすると、スマホの送る系だけが refused-by-setting。スマホの tail は通る', async () => {
    const s = await setup({ acceptFromPhones: false });
    for (const op of sending) expect(await s.askPhone(op), JSON.stringify(op)).toEqual({ ok: false, reason: 'refused-by-setting' });
    expect((await s.askPhone(tailOp())).ok).toBe(true);
    expect(s.w.sent).toEqual([]);
    expect((await s.ask(send('from pc'))).ok).toBe(true);
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['from pc']);
  });

  it('PC を切、スマホを入にすると、スマホの文は渡り、PC の文は断る。送り主の名前はスマホの名前', async () => {
    const s = await setup({ acceptFromPeers: false });
    expect(await s.ask(send('from pc'))).toEqual({ ok: false, reason: 'refused-by-setting' });
    expect((await s.askPhone(send('from phone'))).ok).toBe(true);
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['from phone']);
    const delivered = s.w.events.find((e) => e.type === 'peerChat.delivered');
    expect(delivered).toMatchObject({ from: { deviceId: 'phone-1', deviceName: 'iPhone' } });
  });

  it('預かりの途中でスマホだけ切ると、スマホの文は捨て、PC の文は渡す', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    const phone = (await s.askPhone(send('phone queued'))) as { ok: true; queueId: string };
    expect(phone.ok).toBe(true);
    expect((await s.ask(send('pc queued'))).ok).toBe(true);
    s.w.acceptFromPhones = false;
    s.w.session!.live = 'idle';
    s.host.turnChanged();
    await settle(() => s.w.sent.length === 1);
    await new Promise((res) => setTimeout(res, 60));
    expect(s.w.sent).toEqual(['pc queued']);
    expect(s.state(await s.askPhone(tailOp())).gone).toEqual([{ queueId: phone.queueId, reason: 'queue-expired' }]);
  });

  it('渡す直前にスマホだけ切れても、スマホの文は渡さない', async () => {
    const s = await setup({ session: idleSession({ live: 'busy' }) });
    expect((await s.askPhone(send('racing'))).ok).toBe(true);
    s.w.session!.live = 'idle';
    s.w.pane.captureStyled = async () => { s.w.acceptFromPhones = false; return WIN_EMPTY_AFTER_TURN; };
    s.host.turnChanged();
    await settle(() => s.w.events.some((e) => e.type === 'peerChat.queue' && e.queued.length === 0));
    await new Promise((res) => setTimeout(res, 60));
    expect(s.w.sent).toEqual([]);
  });

  it('スマホからの画像は受けない（最初は文だけ）', async () => {
    const s = await setup();
    expect(await s.askPhone(send('pic', [{ n: 0, mime: 'image/png', bytes: 10 }]))).toEqual({ ok: false, reason: 'too-large' });
    expect(s.w.sent).toEqual([]);
  });
});


// ---- Codex と opencode ----

describe.each([
  ['codex', CODEX_EMPTY_AFTER_TURNS, CODEX_TYPED],
  ['opencode', OPENCODE_EMPTY_AFTER_TURN, OPENCODE_TYPED],
] as const)('PeerChatHost: %s の会話', (provider, EMPTY, TYPED) => {
  const agentSession = (over: Partial<HostSession> = {}) => idleSession({ provider, ...over });

  it('not-claude を返さない。入力欄が空で札が無ければ、止まっているときにすぐ渡す', async () => {
    const s = await setup({ session: agentSession() });
    s.w.pane.styled = EMPTY;
    expect(await s.ask(send('hello'))).toMatchObject({ ok: true });
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['hello']);
  });

  it('打ちかけがあれば渡さない。消えたら渡す', async () => {
    const s = await setup({ session: agentSession() });
    s.w.pane.styled = TYPED;
    await s.ask(send('later'));
    await new Promise((x) => setTimeout(x, 60));
    expect(s.w.sent).toEqual([]);
    s.w.pane.styled = EMPTY;
    await settle(() => s.w.sent.length === 1);
  });

  it('登録の待ち（waitingFor）か許可の札が出ている間は、入力欄が空でも渡さない。札が閉じたら渡す', async () => {
    const s = await setup({ session: agentSession({ live: 'waiting', waitingFor: 'permission' }) });
    s.w.pane.styled = EMPTY;
    await s.ask(send('not now'));
    await new Promise((x) => setTimeout(x, 60));
    expect(s.w.sent).toEqual([]);
    s.w.session = agentSession({ live: 'idle', waitingFor: null });
    s.host.turnChanged();
    await settle(() => s.w.sent.length === 1);
    expect(s.w.sent).toEqual(['not now']);
  });

  it('rush は API で中断してから渡す。Escape は打たない', async () => {
    const calls: string[] = [];
    const s = await setup({ session: agentSession({ live: 'busy' }), deps: { interruptApi: async (id, p) => { calls.push(`${id}:${p}`); return true; } } });
    s.w.pane.styled = EMPTY;
    const queueId = ((await s.ask(send('now'))) as { queueId: string }).queueId;
    await new Promise((x) => setTimeout(x, 40));
    expect(s.w.sent).toEqual([]);
    expect(await s.ask({ t: 'rush', queueId })).toEqual({ ok: true });
    expect(calls).toEqual([`s1:${provider}`]);
    expect(s.w.pane.events).toEqual([]);
    s.w.session = agentSession({ live: 'idle' });
    await settle(() => s.w.sent.length === 1);
  });

  it('API が使えない（false、投げる、口が無い）ときは Escape に落ちる', async () => {
    for (const interruptApi of [async () => false, async () => { throw new Error('down'); }, undefined]) {
      const s = await setup({ session: agentSession({ live: 'busy' }), deps: interruptApi ? { interruptApi } : {} });
      expect(await s.ask({ t: 'interrupt' })).toEqual({ ok: true });
      expect(s.w.pane.events).toEqual(['key:escape']);
    }
  });

  it('止まっていれば interrupt は何も打たない。札が出ているときは ask-mismatch', async () => {
    const calls: string[] = [];
    const s = await setup({ session: agentSession(), deps: { interruptApi: async () => { calls.push('x'); return true; } } });
    expect(await s.ask({ t: 'interrupt' })).toEqual({ ok: true });
    s.w.session = agentSession({ live: 'busy', waitingFor: 'question' });
    expect(await s.ask({ t: 'interrupt' })).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(calls).toEqual([]);
    expect(s.w.pane.events).toEqual([]);
  });

  it('commands は空の一覧、switch-account は account-unavailable', async () => {
    const s = await setup({ session: agentSession(), deps: { switchAccount: async () => 'ok' } });
    expect(await s.ask({ t: 'commands' })).toEqual({ ok: true, commands: [] });
    expect(await s.ask({ t: 'switch-account', account: 'work' })).toEqual({ ok: false, reason: 'account-unavailable' });
  });

  it('持ち主でない PC は、Claude と同じく session-unknown で断る', async () => {
    const s = await setup({ session: agentSession({ lock: true }) });
    expect(await s.ask(send('x'))).toEqual({ ok: false, reason: 'session-unknown' });
    expect(await s.host.rush('s1')).toEqual({ ok: false, reason: 'session-unknown' });
  });

  it('resume-send は止まった会話を再開（deps.resume）し、画面が使えてから渡す', async () => {
    const s = await setup({ session: agentSession({ live: null }), run: null });
    s.w.pane.styled = EMPTY;
    const r = await s.ask({ t: 'resume-send', text: 'wake up', images: [] });
    expect(r).toMatchObject({ ok: true });
    await settle(() => s.w.sent.length === 1);
    expect(s.w.resumed).toBe(1);
    expect(s.w.sent).toEqual(['wake up']);
  });
});

describe('PeerChatHost: Claude の commands と作業中の Codex', () => {
  it('Codex の作業中（入力欄は出ている）でも、busy の間は預かる', async () => {
    const s = await setup({ session: idleSession({ provider: 'codex', live: 'busy' }) });
    s.w.pane.styled = CODEX_WORKING;
    await s.ask(send('queued'));
    await new Promise((x) => setTimeout(x, 60));
    expect(s.w.sent).toEqual([]);
  });
});

// ---- Codex と opencode の札 ----

const PERM_CHOICES = [
  { key: 'once', label: '今回だけ', scope: 'once' as const },
  { key: 'session', label: '以後も', scope: 'session' as const },
  { key: 'deny', label: '許可しない', scope: 'deny' as const },
];
const permAsk = (provider: 'codex' | 'opencode' = 'codex', over: Partial<AgentPendingAsk> = {}): AgentPendingAsk => ({
  provider, stableId: 'appr-1', api: { requestKey: '7', method: 'item/commandExecution/requestApproval' }, kind: 'permission', tool: 'Bash', input: 'npm test', description: null, choices: PERM_CHOICES, questions: [], ...over,
});
const q = (id: string, over: Partial<AgentAskQuestion> = {}): AgentAskQuestion => ({ id, text: `question ${id}`, kind: 'choice', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], multi: false, allowText: false, required: true, ...over });
const questionAsk = (qs: AgentAskQuestion[], over: Partial<AgentPendingAsk> = {}): AgentPendingAsk => ({ provider: 'codex', stableId: 'req-1', api: { requestKey: '8', method: 'item/tool/requestUserInput' }, kind: 'question', choices: [], questions: qs, ...over });

/** 偽の札の口。cur を差し替えて「いま出ている要求」を動かす。answer の結果は next で決める。 */
type FakePort = { cur: AgentPendingAsk | null; next: 'ok' | 'gone' | 'unreachable'; calls: { ask: AgentPendingAsk; reply: AgentAskReply }[]; port: AgentAskPort };
function fakePort(cur: AgentPendingAsk | null): FakePort {
  const f: FakePort = {
    cur,
    next: 'ok',
    calls: [],
    port: {
      current: () => f.cur,
      answer: async (_sid: string, ask: AgentPendingAsk, reply: AgentAskReply) => {
        f.calls.push({ ask, reply });
        if (f.next === 'ok') f.cur = null;
        return f.next;
      },
    },
  };
  return f;
}

type ScreenAnswer = NonNullable<NonNullable<PeerChatHostDeps['agentAsk']>['screenAnswer']>;

async function agentSetup(provider: 'codex' | 'opencode', cur: AgentPendingAsk | null, o: { screen?: ScreenAnswer } = {}) {
  const port = fakePort(cur);
  const screenCalls: unknown[][] = [];
  const screen = o.screen;
  const s = await setup({
    session: idleSession({ provider, live: 'waiting', waitingFor: 'permission' }),
    deps: { agentAsk: { ports: { [provider]: port.port }, ...(screen ? { screenAnswer: async (...a: Parameters<ScreenAnswer>) => { screenCalls.push(a); return screen(...a); } } : {}) } },
  });
  const askOf = async () => s.state(await s.ask(tailOp())).items.at(-1)!.ask!;
  const answer = (askId: string, keys: string[], text?: string) => s.ask({ t: 'answer', askId, keys, ...(text !== undefined ? { text } : {}) });
  return { s, port, screenCalls, askOf, answer };
}

describe.each(['codex', 'opencode'] as const)('PeerChatHost: %s の札（API で答える）', (provider) => {
  it('許可の札が出て、答えると API に 1 回送り、answered を記録する（画面には何も打たない）', async () => {
    const a = await agentSetup(provider, permAsk(provider));
    const ask = await a.askOf();
    expect(ask).toMatchObject({ askId: toPeerChatAsk(permAsk(provider), {}).askId, kind: 'permission', tool: 'Bash', input: 'npm test' });
    expect(ask.options.map((o) => o.key)).toEqual(['once', 'session', 'deny']);
    expect(await a.answer(ask.askId, ['once'])).toEqual({ ok: true });
    expect(a.port.calls).toEqual([{ ask: permAsk(provider), reply: { kind: 'permission', choice: 'once' } }]);
    expect(a.s.w.pane.events).toEqual([]);
    const after = a.s.state(await a.s.ask(tailOp())).items.filter((i) => i.ask);
    expect(after.at(-1)!.ask!.answered).toMatchObject({ by: { deviceId: 'pc-b' }, label: '今回だけ' });
    expect(await a.answer(ask.askId, ['once'])).toEqual({ ok: false, reason: 'already-answered' });
    expect(a.port.calls.length).toBe(1);
  });

  it('手元の口（local）も同じ札と答えの道を通る', async () => {
    const a = await agentSetup(provider, permAsk(provider));
    const ask = a.s.host.local.currentAsk('s1')!;
    expect(ask.askId).toBe(toPeerChatAsk(permAsk(provider), {}).askId);
    expect(await a.s.host.local.answer('s1', ask.askId, ['deny'])).toEqual({ ok: true, label: '許可しない' });
    expect(a.port.calls[0]!.reply).toEqual({ kind: 'permission', choice: 'deny' });
  });

  it("'gone'（先に別の道で解かれた）は already-answered。札に無い選択肢は ask-mismatch で API に送らない", async () => {
    const a = await agentSetup(provider, permAsk(provider));
    const ask = await a.askOf();
    expect(await a.answer(ask.askId, ['nope'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await a.answer(ask.askId, ['once', 'deny'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await a.answer('old-ask', ['once'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(a.port.calls).toEqual([]);
    a.port.next = 'gone';
    expect(await a.answer(ask.askId, ['once'])).toEqual({ ok: false, reason: 'already-answered' });
  });

  it("'unreachable' なら画面の道の口を呼び、'ok' なら answered を記録する", async () => {
    const a = await agentSetup(provider, permAsk(provider), { screen: async () => 'ok' });
    a.port.next = 'unreachable';
    const ask = await a.askOf();
    expect(await a.answer(ask.askId, ['session'])).toEqual({ ok: true });
    expect(a.screenCalls).toEqual([[provider, 's1', permAsk(provider), { kind: 'permission', choice: 'session' }]]);
    a.port.cur = null; // 画面で答えれば、要求は解かれる。
    expect(a.s.state(await a.s.ask(tailOp())).items.filter((i) => i.ask).at(-1)!.ask!.answered).toMatchObject({ label: '以後も' });
  });

  it("'unreachable' でも、画面の口が 'mismatch' か無ければ ask-mismatch。api が無い札は最初から画面の道へ（口が無ければ answerable: false）", async () => {
    const a = await agentSetup(provider, permAsk(provider), { screen: async () => 'mismatch' });
    a.port.next = 'unreachable';
    const ask = await a.askOf();
    expect(await a.answer(ask.askId, ['once'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    const b = await agentSetup(provider, permAsk(provider));
    b.port.next = 'unreachable';
    expect(await b.answer((await b.askOf()).askId, ['once'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    const c = await agentSetup(provider, permAsk(provider, { api: null }));
    expect((await c.askOf()).answerable).toBe(false);
    expect(await c.answer((await c.askOf()).askId, ['once'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(c.port.calls).toEqual([]);
    const d = await agentSetup(provider, permAsk(provider, { api: null }), { screen: async () => 'ok' });
    expect((await d.askOf()).answerable).toBeUndefined();
    expect(await d.answer((await d.askOf()).askId, ['once'])).toEqual({ ok: true });
    expect(d.port.calls).toEqual([]);
  });

  it('画面の道へ移る直前に要求がもう無ければ、画面の口を呼ばず already-answered', async () => {
    const a = await agentSetup(provider, permAsk(provider), { screen: async () => 'ok' });
    const ask = await a.askOf();
    a.port.port.answer = async () => { a.port.cur = null; return 'unreachable'; };
    expect(await a.answer(ask.askId, ['once'])).toEqual({ ok: false, reason: 'already-answered' });
    expect(a.screenCalls).toEqual([]);
  });

  it('問いが 3 つ。1 問ずつ答え、最後に API を 1 回だけ呼ぶ。step、header、secret が札に載り、secret の答えは label に残さない', async () => {
    const qs = [q('q1', { header: 'First' }), q('q2', { kind: 'text', options: [], allowText: true, secret: true }), q('q3')];
    const a = await agentSetup(provider, questionAsk(qs, { provider }));
    const c1 = await a.askOf();
    expect(c1).toMatchObject({ kind: 'question', header: 'First', step: { index: 1, total: 3 } });
    expect(a.s.state(await a.s.ask(tailOp())).items.at(-1)!.text).toBe('question q1');
    expect(await a.answer(c1.askId, ['b'])).toEqual({ ok: true });
    const c2 = await a.askOf();
    expect(c2).toMatchObject({ secret: true, allowText: true, step: { index: 2, total: 3 } });
    expect(c2.askId).not.toBe(c1.askId);
    expect(await a.answer(c2.askId, [], 'hunter2')).toEqual({ ok: true });
    const c3 = await a.askOf();
    expect(c3.step).toEqual({ index: 3, total: 3, submit: true });
    expect(a.port.calls).toEqual([]);
    expect(await a.answer(c3.askId, ['a'])).toEqual({ ok: true });
    expect(a.port.calls.length).toBe(1);
    expect(a.port.calls[0]!.reply).toEqual({ kind: 'question', answers: { q1: 'b', q2: 'hunter2', q3: 'a' } });
    const items = a.s.state(await a.s.ask(tailOp())).items.filter((i) => i.ask);
    expect(items.map((i) => i.ask!.answered?.label)).toContain('B');
    expect(JSON.stringify(items)).not.toContain('hunter2');
    expect(items.find((i) => i.ask!.askId === c2.askId)!.ask!.answered!.label).toBe('');
  });

  it('検査に通らない答え（選択肢に無い、必須の空）は ask-mismatch で、貯めない', async () => {
    const a = await agentSetup(provider, questionAsk([q('q1'), q('q2')], { provider }));
    const c1 = await a.askOf();
    expect(await a.answer(c1.askId, [])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await a.answer(c1.askId, ['zzz'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect((await a.askOf()).askId).toBe(c1.askId);
  });

  it('途中で要求が消えたら、貯めた答えを捨てる（同じ札がまた出ても 1 問目から）。別の札に替わったときも捨てる', async () => {
    const ask = questionAsk([q('q1'), q('q2')], { provider });
    const a = await agentSetup(provider, ask);
    const c1 = await a.askOf();
    await a.answer(c1.askId, ['a']);
    expect((await a.askOf()).step).toEqual({ index: 2, total: 2, submit: true });
    a.port.cur = null;
    expect((await a.s.ask(tailOp())).ok).toBe(true);
    a.port.cur = ask;
    expect((await a.askOf()).askId).toBe(c1.askId);
    await a.answer(c1.askId, ['a']);
    a.port.cur = { ...ask, stableId: 'req-2' };
    expect((await a.askOf()).step).toEqual({ index: 1, total: 2 });
    expect(a.port.calls).toEqual([]);
  });

  it("最後の問いで 'gone' なら already-answered。'unreachable' で、問いが複数なら画面の道へは落とさない", async () => {
    const a = await agentSetup(provider, questionAsk([q('q1'), q('q2')], { provider }), { screen: async () => 'ok' });
    await a.answer((await a.askOf()).askId, ['a']);
    a.port.next = 'unreachable';
    expect(await a.answer((await a.askOf()).askId, ['b'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(a.screenCalls).toEqual([]);
    a.port.next = 'gone';
    expect(await a.answer((await a.askOf()).askId, ['b'])).toEqual({ ok: false, reason: 'already-answered' });
  });

  it('問い 1 つの選択は、unreachable なら画面の道へ落とせる。複数選択の問いは落とさない', async () => {
    const a = await agentSetup(provider, questionAsk([q('q1')], { provider }), { screen: async () => 'ok' });
    a.port.next = 'unreachable';
    expect(await a.answer((await a.askOf()).askId, ['a'])).toEqual({ ok: true });
    expect(a.screenCalls).toEqual([[provider, 's1', questionAsk([q('q1')], { provider }), { kind: 'question', answers: { q1: 'a' } }]]);
    const m = await agentSetup(provider, questionAsk([q('q1', { multi: true })], { provider }), { screen: async () => 'ok' });
    m.port.next = 'unreachable';
    expect(await m.answer((await m.askOf()).askId, ['a', 'b'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(m.screenCalls).toEqual([]);
  });

  it('必須でない問いは空の答えで飛ばせて、送る答えに入らない（default があれば入る）', async () => {
    const a = await agentSetup(provider, questionAsk([q('q1', { required: false }), q('q2', { required: false, default: 'x', kind: 'text', options: [], allowText: true }), q('q3')], { provider }));
    await a.answer((await a.askOf()).askId, []);
    await a.answer((await a.askOf()).askId, []);
    await a.answer((await a.askOf()).askId, ['b']);
    expect(a.port.calls[0]!.reply).toEqual({ kind: 'question', answers: { q2: 'x', q3: 'b' } });
  });

  it('札が無いときは、tail に札が出ず、答えは ask-mismatch', async () => {
    const a = await agentSetup(provider, null);
    expect(a.s.state(await a.s.ask(tailOp())).items.some((i) => i.ask)).toBe(false);
    expect(await a.answer('x', ['once'])).toEqual({ ok: false, reason: 'ask-mismatch' });
  });
});
