import { aadPhoneChat, aadPhoneChatReply, open, parsePeerChatRequest, seal, type MobileFeed, type PeerChatReply, type PeerChatState } from '@agent-hangar/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import * as store from './store.ts';
import { connectPhone, feedOf, inboxOf, liveItem, makeKey, MIN, NOW } from './test/fixtures.ts';
import { json } from './test/pairText.ts';

let key: CryptoKey;
let feeds: MobileFeed[];
let asked: { to: string; sessionId: string; op: string }[];
/** 会話の中身。session が無ければ session-unknown で断る。 */
let sessions: Record<string, PeerChatState>;

const CHAT = { asks: true, images: true, effort: true, chat: { input: true } };
const state = (text: string): PeerChatState => ({ sessionId: 's-1', status: 'waiting', items: [{ uuid: 'a1', at: 1, kind: 'assistant', text }], queued: [], cursor: 'a1', truncated: false });

beforeEach(async () => {
  key = await makeKey();
  await store.clearPairing();
  await connectPhone(key);
  asked = [];
  sessions = { 's-1': state('許可を待っています') };
  feeds = [feedOf('pc-1', 'Mac', { caps: CHAT, live: [liveItem({ sessionId: 's-1', status: 'waiting', statusAt: Date.now() - 5 * MIN, title: '会話の題' })] })];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/m/inbox')) return json(await inboxOf(key, feeds, { now: Date.now() }));
      if (url.endsWith('/m/chat')) {
        const body = JSON.parse(init!.body as string) as { askId: string; to: string; sealed: string };
        const req = parsePeerChatRequest(await open<unknown>(key, aadPhoneChat(body.askId, body.to), body.sealed))!;
        asked.push({ to: body.to, sessionId: req.sessionId, op: req.op.t });
        const st = sessions[req.sessionId];
        const reply: PeerChatReply = st ? { ok: true, state: st } : { ok: false, reason: 'session-unknown' };
        return json({ sealed: await seal(key, aadPhoneChatReply(body.askId), reply) });
      }
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  void NOW;
});

describe('App の会話の頁', () => {
  it('caps.chat のある PC の入力待ちの札を押すと、会話の頁が開き、戻ると閉じる', async () => {
    render(<App pairText={null} />);
    fireEvent.click(await screen.findByText(/会話の題/));
    expect(await screen.findByRole('dialog', { name: '会話の題' })).toBeTruthy();
    expect(await screen.findByText('許可を待っています')).toBeTruthy();
    expect(asked[0]).toMatchObject({ to: 'pc-1', sessionId: 's-1', op: 'tail' });
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '会話の題' })).toBeNull());
  });

  it('通知から開く（deviceId つき）と、受信箱の素に無い会話も、その PC で読んで頁を開く', async () => {
    sessions['s-9'] = { ...state('通知の会話'), sessionId: 's-9' };
    render(<App pairText={null} openSession={{ id: 's-9', deviceId: 'pc-1' }} />);
    expect(await screen.findByText('通知の会話')).toBeTruthy();
    expect(asked.some((a) => a.sessionId === 's-9' && a.to === 'pc-1')).toBe(true);
  });

  it('deviceId が無い通知は、PC の名前で探す', async () => {
    sessions['s-9'] = { ...state('名前で見つけた'), sessionId: 's-9' };
    render(<App pairText={null} openSession={{ id: 's-9', pcName: 'Mac' }} />);
    expect(await screen.findByText('名前で見つけた')).toBeTruthy();
  });

  it('素の行がある会話は、その行から頁を開く（題が出る）', async () => {
    render(<App pairText={null} openSession={{ id: 's-1', deviceId: 'pc-1' }} />);
    expect(await screen.findByRole('dialog', { name: '会話の題' })).toBeTruthy();
  });

  it('宛先の PC が見つからない通知は、頁を開かず受信箱を開いたままにする', async () => {
    render(<App pairText={null} openSession={{ id: 's-9', pcName: 'どこにもない' }} />);
    await screen.findByText(/会話の題/);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('素に無い会話が読めなければ、頁を閉じて受信箱に戻る', async () => {
    render(<App pairText={null} openSession={{ id: 's-gone', deviceId: 'pc-1' }} />);
    await waitFor(() => expect(asked.some((a) => a.sessionId === 's-gone')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/会話の題/)).toBeTruthy();
  });
});
