import { describe, expect, it, vi } from 'vitest';
import type { PeerChatClientMsg, PeerChatItem, PeerChatOpIn, PeerChatOpResult, PeerChatQueued, PeerChatUpdate, PeerChatViewDto } from '@agent-hangar/shared';
import { initialStore, applyServerEvent, type Store } from '../store/store.ts';
import type { PeerChatSlice } from '../store/peerChat.ts';
import { createPeerChatRunner } from './peerChat.ts';

const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const user = (uuid: string, text: string): PeerChatItem => ({ uuid, at: 1, kind: 'user', text });
const ai = (uuid: string, text: string): PeerChatItem => ({ uuid, at: 2, kind: 'assistant', text });
const card = (uuid: string, askId: string, answered?: boolean): PeerChatItem => ({
  uuid, at: 3, kind: 'permission', text: 'git push',
  ask: { askId, kind: 'permission', tool: 'Bash', input: 'git push', options: [{ key: '1', label: '許可' }, { key: '2', label: '拒否' }], multi: false, allowText: false, ...(answered ? { answered: { by: MAC, label: 'Mac で許可', at: 9 } } : {}) },
});
const queued = (queueId: string, text: string): PeerChatQueued => ({ queueId, from: { deviceId: 'me', deviceName: 'Win' }, text, images: 0, at: 5, state: 'waiting' });
const update = (over: Partial<PeerChatUpdate> = {}): PeerChatUpdate => ({ sessionId: 's1', link: 'online', replace: false, status: 'busy', items: [], queued: [], cursor: 'c1', ...over });
const view = (over: Partial<PeerChatUpdate> = {}): PeerChatViewDto => ({ ok: true, device: { deviceId: 'd-mac', deviceName: 'Mac' }, startedAfter: null, update: update({ items: [user('u1', '調べて'), ai('a1', '見ます')], ...over }) });

/** Store を 1 つ持つ、runner の試験用の台。WebSocket の更新は applyServerEvent を通して流す。 */
function rig(open: (s: string, v: string, after: string) => Promise<PeerChatViewDto>, op: (s: string, b: PeerChatOpIn) => Promise<PeerChatOpResult> = async () => ({ ok: true })) {
  let store: Store = initialStore();
  const sent: PeerChatClientMsg[] = [];
  const runner = createPeerChatRunner({ open, op, send: (m) => sent.push(m), get: () => store.peerChat, set: (peerChat) => { store = { ...store, peerChat }; } });
  const slice = (id = 's1'): PeerChatSlice => store.peerChat[id]!;
  const push = (u: PeerChatUpdate) => { store = applyServerEvent(store, { type: 'peerChat.update', ...u }); };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { runner, sent, slice, push, tick, all: () => store.peerChat };
}

describe('ほかの PC の会話を見る（runtime/peerChat）', () => {
  it('開くと見張りを始め、答えの項目と状態が入り、WebSocket で見張りを張る', async () => {
    const t = rig(async () => view());
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    expect(t.slice().phase).toBe('loading');
    await t.tick();
    expect(t.slice()).toMatchObject({ phase: 'live', status: 'busy', link: 'online', device: { deviceName: 'Mac' } });
    expect(t.slice().items.map((i) => i.uuid)).toEqual(['u1', 'a1']);
    expect(t.sent).toEqual([{ type: 'peerChat.watch', sessionId: 's1', viewer: 'v1', after: 'c1' }]);
  });

  it('見張りは頭から取る（after は空文字）', async () => {
    const open = vi.fn(async () => view());
    const t = rig(open);
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    expect(open).toHaveBeenCalledWith('s1', 'v1', '');
  });

  it('同じ画面が開き直しても、見張りは 1 本', async () => {
    const open = vi.fn(async () => view());
    const t = rig(open);
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('断られたら fallback にして、見張りは張らない（相手が古い、会話が Claude Code でない、など）', async () => {
    const t = rig(async () => ({ ok: false, reason: 'device-outdated', device: { deviceId: 'd-mac', deviceName: 'Mac' } }));
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    expect(t.slice()).toMatchObject({ phase: 'fallback', fallback: 'device-outdated' });
    expect(t.sent).toEqual([]);
  });

  it('問い合わせが投げたら、届かなかったとして fallback にする', async () => {
    const t = rig(async () => { throw new Error('boom'); });
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    expect(t.slice()).toMatchObject({ phase: 'fallback', fallback: 'unreachable' });
  });

  it('答えを待つ間に閉じたら、遅れて届いた答えは捨てる', async () => {
    let done!: (v: PeerChatViewDto) => void;
    const t = rig(() => new Promise((r) => { done = r; }));
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    t.runner.run({ op: 'close', sessionId: 's1' });
    done(view());
    await t.tick();
    expect(t.all()).toEqual({});
    expect(t.sent).toEqual([{ type: 'peerChat.unwatch', sessionId: 's1', viewer: 'v1' }]);
  });

  it('閉じたら unwatch を送り、状態を捨てる', async () => {
    const t = rig(async () => view());
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    t.runner.run({ op: 'close', sessionId: 's1' });
    expect(t.all()).toEqual({});
    expect(t.sent.at(-1)).toEqual({ type: 'peerChat.unwatch', sessionId: 's1', viewer: 'v1' });
  });

  it('つながり直したら、見ている会話の見張りを最後の位置から張り直す', async () => {
    const t = rig(async () => view());
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    t.push(update({ items: [ai('a2', '続き')], cursor: 'c2' }));
    t.sent.length = 0;
    t.runner.rewatch();
    expect(t.sent).toEqual([{ type: 'peerChat.watch', sessionId: 's1', viewer: 'v1', after: 'c2' }]);
  });
});

describe('WebSocket の更新（peerChat.update）', () => {
  const opened = async () => {
    const t = rig(async () => view());
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    return t;
  };

  it('新しい項目は末尾に足し、同じ uuid は置き換える', async () => {
    const t = await opened();
    t.push(update({ items: [ai('a1', '見ました'), ai('a2', '直します')] }));
    expect(t.slice().items.map((i) => [i.uuid, i.text])).toEqual([['u1', '調べて'], ['a1', '見ました'], ['a2', '直します']]);
  });

  it('replace なら、手元の項目を捨てて差し替える', async () => {
    const t = await opened();
    t.push(update({ replace: true, items: [ai('z', '取り直し')] }));
    expect(t.slice().items.map((i) => i.uuid)).toEqual(['z']);
  });

  it('許可の札は askId で重ね、答えが付いたら同じ場所で閉じる', async () => {
    const t = await opened();
    t.push(update({ status: 'waiting', items: [card('k1', 'ask-1')] }));
    expect(t.slice().items.at(-1)?.ask?.answered).toBeUndefined();
    t.push(update({ status: 'busy', items: [card('k1b', 'ask-1', true)] }));
    const cards = t.slice().items.filter((i) => i.ask);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.ask!.answered).toMatchObject({ label: 'Mac で許可' });
    expect(t.slice().status).toBe('busy');
  });

  it('状態と預かりは全体の値で置き換える。つながっていない間は link だけが変わる', async () => {
    const t = await opened();
    t.push(update({ status: 'idle', queued: [queued('q1', '次')] }));
    expect(t.slice()).toMatchObject({ status: 'idle', queued: [{ queueId: 'q1' }] });
    t.push(update({ link: 'offline', status: null, queued: [queued('q1', '次')] }));
    expect(t.slice()).toMatchObject({ link: 'offline', status: 'idle', phase: 'live' });
    t.push(update({ link: 'host-error', status: null }));
    expect(t.slice().link).toBe('host-error');
  });

  it('reason が付いたら見続けられないので、読み取り専用の表示に戻す', async () => {
    const t = await opened();
    t.push(update({ reason: 'too-many', link: 'offline', status: null }));
    expect(t.slice()).toMatchObject({ phase: 'fallback', fallback: 'too-many' });
  });

  it('見ていない会話の更新は捨てる', async () => {
    const t = await opened();
    t.push(update({ sessionId: 'other', items: [ai('x', 'x')] }));
    expect(Object.keys(t.all())).toEqual(['s1']);
  });
});

describe('送る・預ける・取り消す', () => {
  const opened = async (op: (s: string, b: PeerChatOpIn) => Promise<PeerChatOpResult>) => {
    const t = rig(async () => view(), op);
    t.runner.run({ op: 'open', sessionId: 's1', viewer: 'v1' });
    await t.tick();
    return t;
  };

  it('送れたら sending を戻し、状態の全体を重ねる', async () => {
    const op = vi.fn(async (): Promise<PeerChatOpResult> => ({ ok: true, state: { sessionId: 's1', status: 'busy', items: [user('u2', 'はい')], queued: [], cursor: 'c3', truncated: false } }));
    const t = await opened(op);
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'send', text: 'はい' } });
    expect(t.slice().sending).toBe(true);
    await t.tick();
    expect(op).toHaveBeenCalledWith('s1', { t: 'send', text: 'はい' });
    expect(t.slice()).toMatchObject({ sending: false, restore: null });
    expect(t.slice().items.map((i) => i.uuid)).toContain('u2');
  });

  it('送れなかったら、文と画像を入力欄へ戻して理由を出す', async () => {
    const t = await opened(async () => ({ ok: false, reason: 'offline' }));
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'send', text: '続けて', images: ['/drops/a.png'] } });
    await t.tick();
    expect(t.slice().restore).toMatchObject({ n: 1, text: '続けて', images: ['/drops/a.png'] });
    expect(t.slice().notice).toMatchObject({ reason: 'offline' });
    expect(t.slice().sending).toBe(false);
  });

  it('再開して送るが断られても、文を戻す', async () => {
    const t = await opened(async () => ({ ok: false, reason: 'resume-failed' }));
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'resume-send', text: '再開して' } });
    await t.tick();
    expect(t.slice().restore?.text).toBe('再開して');
    expect(t.slice().notice?.reason).toBe('resume-failed');
  });

  it('通信が投げても、host-error として文を戻す', async () => {
    const t = await opened(async () => { throw new Error('net'); });
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'send', text: 'こんにちは' } });
    await t.tick();
    expect(t.slice().restore?.text).toBe('こんにちは');
    expect(t.slice().notice?.reason).toBe('host-error');
  });

  it('預かりの取り消しは、預かりの文を入力欄へ戻す', async () => {
    const t = await opened(async (_s, b) => (b.t === 'send' ? { ok: true, queueId: 'q1' } : { ok: true }));
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'send', text: 'あとで' } });
    await t.tick();
    t.push(update({ queued: [queued('q1', 'あとで')] }));
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'cancel', queueId: 'q1' } });
    await t.tick();
    expect(t.slice().restore).toMatchObject({ text: 'あとで' });
    expect(t.slice().queued).toEqual([]);
  });

  it('取り消しが断られたら、文は戻さず理由を出す', async () => {
    const t = await opened(async () => ({ ok: false, reason: 'expired' }));
    t.push(update({ queued: [queued('q1', 'あとで')] }));
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'cancel', queueId: 'q1' } });
    await t.tick();
    expect(t.slice().restore).toBeNull();
    expect(t.slice().notice?.reason).toBe('expired');
  });

  it('渡せずに消えた自分の預かり（gone）は、文を入力欄へ戻し、同じ queueId は 1 度だけ', async () => {
    const t = await opened(async () => ({ ok: true, queueId: 'q9' }));
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'send', text: '預けた文' } });
    await t.tick();
    t.push(update({ gone: [{ queueId: 'q9', reason: 'queue-expired' }] }));
    expect(t.slice().restore).toMatchObject({ n: 1, text: '預けた文' });
    expect(t.slice().notice).toMatchObject({ reason: 'gone' });
    t.push(update({ gone: [{ queueId: 'q9', reason: 'queue-expired' }] }));
    expect(t.slice().restore?.n).toBe(1);
  });

  it('ほかの PC の預かりの gone は、自分の入力欄へは戻さない', async () => {
    const t = await opened(async () => ({ ok: true }));
    t.push(update({ gone: [{ queueId: 'not-mine', reason: 'session-unknown' }] }));
    expect(t.slice().restore).toBeNull();
  });

  it('札への答えが断られたら理由を出す（もう答えられている）', async () => {
    const t = await opened(async () => ({ ok: false, reason: 'already-answered' }));
    t.runner.run({ op: 'send', sessionId: 's1', body: { t: 'answer', askId: 'ask-1', keys: ['1'] } });
    await t.tick();
    expect(t.slice().notice?.reason).toBe('already-answered');
    expect(t.slice().restore).toBeNull();
  });
});
