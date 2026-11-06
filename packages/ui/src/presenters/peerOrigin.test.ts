import { describe, expect, it } from 'vitest';
import { translator, type PeerChatQueued } from '@agent-hangar/shared';
import { applyServerEvent, initialStore, applyBootstrap } from '../store/store.ts';
import { presentPeerOrigin } from './peerOrigin.ts';

const t = translator('ja');
const mac = { deviceId: 'pc-mac', deviceName: 'Mac' };
const win = { deviceId: 'pc-win', deviceName: 'Win' };
const q = (id: string, from = mac, over: Partial<PeerChatQueued> = {}): PeerChatQueued => ({ queueId: id, from, text: 'x', images: 0, at: 1, state: 'waiting', ...over });

describe('元の PC の側の表示（presentPeerOrigin）', () => {
  it('預かりが無ければ null', () => {
    expect(presentPeerOrigin(initialStore(), 's1', t)).toBeNull();
  });

  it('peerChat.queue で帯の文が出て、空の知らせで畳む', () => {
    let s = applyServerEvent(initialStore(), { type: 'peerChat.queue', sessionId: 's1', queued: [q('a'), q('b')] });
    expect(presentPeerOrigin(s, 's1', t)).toEqual({ band: 'Mac から 2 件を預かっています。止まったら渡します', flash: null });
    s = applyServerEvent(s, { type: 'peerChat.queue', sessionId: 's1', queued: [] });
    expect(presentPeerOrigin(s, 's1', t)).toBeNull();
    expect(s.peerQueued).toEqual({});
  });

  it('預かりは会話ごとに持ち、ほかの会話には出ない', () => {
    const s = applyServerEvent(initialStore(), { type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] });
    expect(presentPeerOrigin(s, 's2', t)).toBeNull();
  });

  it('送り主が複数なら、名前を並べる（同じ PC は 1 回）', () => {
    const s = applyServerEvent(initialStore(), { type: 'peerChat.queue', sessionId: 's1', queued: [q('a', mac), q('b', win), q('c', mac)] });
    expect(presentPeerOrigin(s, 's1', t)!.band).toBe('Mac、Win から 3 件を預かっています。止まったら渡します');
  });

  it('peerChat.delivered で札の文と鍵を持つ。預かりが空でも札は残る', () => {
    let s = applyServerEvent(initialStore(), { type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] });
    s = applyServerEvent(s, { type: 'peerChat.queue', sessionId: 's1', queued: [] });
    s = applyServerEvent(s, { type: 'peerChat.delivered', sessionId: 's1', from: mac, at: 1234 });
    expect(presentPeerOrigin(s, 's1', t)).toEqual({ band: null, flash: { text: 'Mac から送信しました', key: 1234 } });
  });

  it('英語でも出る', () => {
    const en = translator('en');
    const s = applyServerEvent(initialStore(), { type: 'peerChat.delivered', sessionId: 's1', from: mac, at: 9 });
    expect(presentPeerOrigin(s, 's1', en)!.flash!.text).toBe('Sent from Mac');
  });

  it('会話が消えたら、預かりも札も捨てる', () => {
    let s = applyServerEvent(initialStore(), { type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] });
    s = applyServerEvent(s, { type: 'peerChat.delivered', sessionId: 's1', from: mac, at: 5 });
    s = applyServerEvent(s, { type: 'session.removed', id: 's1' });
    expect(s.peerQueued).toEqual({});
    expect(s.peerDelivered).toEqual({});
  });

  it('同じ預かりの配り直しでは Store を作り直さない', () => {
    const a = applyServerEvent(initialStore(), { type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] });
    const b = applyServerEvent(a, { type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] });
    expect(b).toBe(a);
  });

  it('bootstrap が預かりを運べば、帯の元が戻る。運ばなければ（古いサーバ）空になる', () => {
    const a = applyServerEvent(initialStore(), { type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] });
    const empty = { device: { id: 'd', name: 'm' }, settings: {}, projects: [], sessions: [], live: [], runs: [], tabs: [], todos: [], artifacts: [], summaryPending: [], deleteApprovals: [], peerApprovals: [], schedules: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0', sync: null, devices: [], retention: null, cloudUsage: null, accounts: null, home: '/h', interrupted: null };
    // 取りこぼした空の知らせで古い帯が残らないよう、bootstrap の値で置き換える。
    expect(applyBootstrap(a, empty as never).peerQueued).toEqual({});
    const b = applyBootstrap(initialStore(), { ...empty, peerQueued: { s1: [q('a'), q('b')] } } as never);
    expect(presentPeerOrigin(b, 's1', t)).toEqual({ band: 'Mac から 2 件を預かっています。止まったら渡します', flash: null });
    expect(presentPeerOrigin(b, 's2', t)).toBeNull();
  });
});
