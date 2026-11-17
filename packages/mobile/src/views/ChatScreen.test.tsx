// @vitest-environment jsdom
import type { PeerChatAsk, PeerChatItem, PeerChatOp, PeerChatReply, PeerChatState } from '@agent-hangar/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatError } from '../chat.ts';
import { at1, makeKey } from '../test/fixtures.ts';
import { ChatScreen, type ChatTarget } from './ChatScreen.tsx';

afterEach(cleanup);

const pairing = { url: 'https://hangar.example.workers.dev', token: 't', deviceId: 'phone-1' };
const target = (o: Partial<ChatTarget> = {}): ChatTarget => ({ sessionId: 's-1', deviceId: 'pc-1', deviceName: 'Mac', projectName: 'alpha', title: '会話の題', input: true, ...o });
const as = (uuid: string, text: string): PeerChatItem => ({ uuid, at: 1, kind: 'assistant', text });
const user = (uuid: string, text: string): PeerChatItem => ({ uuid, at: 1, kind: 'user', text });
const permission = (extra: Partial<PeerChatAsk> = {}): PeerChatItem => ({
  uuid: 'a@ask:k1',
  at: 2,
  kind: 'permission',
  text: '',
  ask: { askId: 'k1', kind: 'permission', tool: 'Bash', input: 'npm test', options: [{ key: '1', label: 'はい' }, { key: '2', label: 'いいえ' }], multi: false, allowText: false, ...extra },
});
const state = (items: PeerChatItem[], o: Partial<PeerChatState> = {}): PeerChatState => ({ sessionId: 's-1', status: 'idle', items, queued: [], cursor: items.at(-1)?.uuid ?? null, truncated: false, ...o });

type Call = (op: PeerChatOp) => Promise<PeerChatReply>;

/** tail は state を返し続け（長い待ちの代わりに少し待つ）、ほかの操作は ops に記録して on で答える。 */
function fake(st: PeerChatState | (() => PeerChatState), on: (op: PeerChatOp) => PeerChatReply | Promise<PeerChatReply> = () => ({ ok: true })) {
  const ops: PeerChatOp[] = [];
  const call = vi.fn(async (op: PeerChatOp) => {
    ops.push(op);
    if (op.t === 'tail') {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true as const, state: typeof st === 'function' ? st() : st };
    }
    return on(op);
  }) as unknown as Call;
  return { call, ops };
}

async function show(f: ReturnType<typeof fake>, t: ChatTarget = target(), extra: Partial<Parameters<typeof ChatScreen>[0]> = {}) {
  const key = at1(await makeKey());
  const onClose = vi.fn();
  const onUnpaired = vi.fn();
  const onGone = vi.fn();
  render(<ChatScreen target={t} pairing={pairing} phoneKey={key} onClose={onClose} onUnpaired={onUnpaired} onGone={onGone} deps={{ call: (op) => f.call(op), gapMs: 10 }} {...extra} />);
  return { onClose, onUnpaired, onGone };
}

describe('ChatScreen', () => {
  it('会話の続きと、題、プロジェクトと PC を出す', async () => {
    await show(fake(state([user('u1', 'こんにちは'), as('a1', '返事です')])));
    expect(await screen.findByText('返事です')).toBeTruthy();
    expect(screen.getByText('こんにちは')).toBeTruthy();
    expect(screen.getByText('会話の題')).toBeTruthy();
    expect(screen.getByText(/alpha · Mac/)).toBeTruthy();
  });

  it('最初の tail は待たず（0）、2 回目からは長く待つ', async () => {
    const f = fake(state([as('a1', 'x')]));
    await show(f);
    await screen.findByText('x');
    await waitFor(() => expect(f.ops.filter((o) => o.t === 'tail').length).toBeGreaterThanOrEqual(2));
    const tails = f.ops.filter((o): o is Extract<PeerChatOp, { t: 'tail' }> => o.t === 'tail');
    expect(tails[0]).toMatchObject({ after: null, waitMs: 0 });
    expect(tails[1]).toMatchObject({ after: 'a1', waitMs: 20_000 });
  });

  it('送ると、仮の行が薄く出て、send を預ける。入力欄は空になる', async () => {
    const f = fake(state([as('a1', 'x')]));
    await show(f);
    await screen.findByText('x');
    const box = screen.getByRole('textbox', { name: 'メッセージ' });
    fireEvent.change(box, { target: { value: '続けて' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る' })));
    expect(f.ops.find((o) => o.t === 'send')).toEqual({ t: 'send', text: '続けて', images: [], waitMs: 10_000 });
    expect(screen.getByText('続けて').className).toContain('pending');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('送れなかったら仮の行を外し、文を入力欄に戻して理由を出す', async () => {
    const f = fake(state([as('a1', 'x')]), () => ({ ok: false, reason: 'refused-by-setting' }));
    await show(f);
    await screen.findByText('x');
    const box = screen.getByRole('textbox', { name: 'メッセージ' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '続けて' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る' })));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('他の PC からの操作を受け付けない'));
    expect(box.value).toBe('続けて');
  });

  it('送った文と同じ項目が届いたら、仮の行を外す', async () => {
    let items = [as('a1', 'x')];
    const f = fake(() => state(items));
    await show(f);
    await screen.findByText('x');
    fireEvent.change(screen.getByRole('textbox', { name: 'メッセージ' }), { target: { value: '続けて' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る' })));
    items = [as('a1', 'x'), user('u2', '続けて')];
    await waitFor(() => expect(document.querySelector('.it-user:not(.pending)')).toBeTruthy());
    expect(document.querySelectorAll('.it-user')).toHaveLength(1);
  });

  it('許可の札の選択肢を押すと answer を送り、選択肢が畳まれて答えが残る', async () => {
    const f = fake(state([as('a1', 'x'), permission()]));
    await show(f);
    await screen.findByText('npm test');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /はい/ })));
    expect(f.ops.find((o) => o.t === 'answer')).toEqual({ t: 'answer', askId: 'k1', keys: ['1'] });
    await waitFor(() => expect(screen.queryByRole('button', { name: /いいえ/ })).toBeNull());
    expect(screen.getByText('はい')).toBeTruthy();
  });

  it('答え済みの札は、答えた PC と選択肢だけを出す', async () => {
    await show(fake(state([permission({ answered: { by: { deviceId: 'd', deviceName: 'Mac' }, label: 'はい', at: 3 } })])));
    expect(await screen.findByText(/· Mac/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /いいえ/ })).toBeNull();
  });

  it('input が偽なら入力欄も中断も出さず、札は答えられない', async () => {
    await show(fake(state([permission()], { status: 'busy' })), target({ input: false }));
    await screen.findByText('npm test');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '中断' })).toBeNull();
    expect(screen.queryByRole('button', { name: /はい/ })).toBeNull();
    expect(screen.getByText('Mac で答えてください')).toBeTruthy();
  });

  it('中断は作業中のときだけ出て、interrupt を送る', async () => {
    const f = fake(() => state([as('a1', 'x')], { status: 'busy' }));
    await show(f);
    const stop = await screen.findByRole('button', { name: '中断' });
    await act(async () => fireEvent.click(stop));
    expect(f.ops.some((o) => o.t === 'interrupt')).toBe(true);
  });

  it('作業中でなければ中断は出ない', async () => {
    await show(fake(state([as('a1', 'x')], { status: 'idle' })));
    await screen.findByText('x');
    expect(screen.queryByRole('button', { name: '中断' })).toBeNull();
  });

  it('戻るで onClose', async () => {
    const { onClose } = await show(fake(state([as('a1', 'x')])));
    await screen.findByText('x');
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('会話が見つからなければ読めない旨を出し、入力欄を出さない', async () => {
    const call: Call = async () => ({ ok: false, reason: 'session-unknown' });
    await show({ call, ops: [] });
    expect(await screen.findByText('Mac にこの会話が見つかりません')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('素に無い会話（speculative）が読めなければ onGone', async () => {
    const call: Call = async () => ({ ok: false, reason: 'session-unknown' });
    const { onGone } = await show({ call, ops: [] }, target({ speculative: true, title: '', projectName: '' }));
    await waitFor(() => expect(onGone).toHaveBeenCalled());
  });

  it('接続が外されたら onUnpaired', async () => {
    const call: Call = async () => {
      throw new ChatError('unpaired', 401, 'revoked');
    };
    const { onUnpaired } = await show({ call, ops: [] });
    await waitFor(() => expect(onUnpaired).toHaveBeenCalledWith('revoked'));
  });


  it('通知から開いたときは、問いの位置まで送る（札に data-open-ask）', async () => {
    await show(fake(state([as('a1', 'x'), permission()])), target({ focusAsk: true }));
    await screen.findByText('npm test');
    expect(document.querySelector('[data-open-ask]')).toBeTruthy();
  });
});
