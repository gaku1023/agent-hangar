import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type PeerChatItem, type PeerChatQueued, type SessionDto, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentPeerChat, type PeerChatView } from '../presenters/peerChat.ts';
import { initialStore } from '../store/store.ts';
import { emptySlice, type PeerChatSlice } from '../store/peerChat.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { PromptAssistContext, NO_ASSIST, type PromptAssist } from './primitives/promptAssist.ts';
import { PeerChatPane } from './PeerChatPane.tsx';

const ja = translator('ja');
const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const stats = { turns: 3, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: 0 };
const SESSION = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: 'x', cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, lastTurnAt: 1, hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: { deviceId: 'd-mac', deviceName: 'Mac', runId: 'r', heartbeatAt: 1, stale: false }, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null } as unknown as SessionDto;
const user = (uuid: string, text: string, from?: typeof MAC): PeerChatItem => ({ uuid, at: 1, kind: 'user', text, ...(from ? { from } : {}) });
const ai = (uuid: string, text: string): PeerChatItem => ({ uuid, at: 2, kind: 'assistant', text });
const ask = (answered = false, over: Partial<NonNullable<PeerChatItem['ask']>> = {}): PeerChatItem => ({
  uuid: 'k1', at: 4, kind: 'permission', text: 'git push origin fix',
  ask: { askId: 'ask-1', kind: 'permission', tool: 'Bash', input: 'git push origin fix', options: [{ key: '1', label: '許可' }, { key: '2', label: '拒否' }], multi: false, allowText: false, ...over, ...(answered ? { answered: { by: MAC, label: '許可', at: 9 } } : {}) },
});
const queued = (queueId: string, text: string, deviceId = 'me'): PeerChatQueued => ({ queueId, from: { deviceId, deviceName: 'Win' }, text, images: 0, at: 5, state: 'waiting' });

function viewOf(slice: Partial<PeerChatSlice>): PeerChatView {
  const st = initialStore();
  st.device = { id: 'me', name: 'Win' };
  st.sessions = { s1: SESSION };
  st.peerChat = { s1: { ...emptySlice('v1'), phase: 'live', device: MAC, status: 'idle', ...slice } };
  return presentPeerChat(st, 's1', ja)!;
}
function mount(view: PeerChatView, assist: PromptAssist = NO_ASSIST) {
  const actions: UiAction[] = [];
  const tree = (v: PeerChatView) => (
    <LanguageRoot language="ja"><PromptAssistContext.Provider value={assist}><ActionRoot onAction={(a) => actions.push(a)}><PeerChatPane view={v} /></ActionRoot></PromptAssistContext.Provider></LanguageRoot>
  );
  const r = render(tree(view));
  return { actions, ...r, update: (v: PeerChatView) => r.rerender(tree(v)) };
}
const box = () => screen.getByRole('textbox', { name: 'メッセージ' }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text, selectionStart: text.length } });

describe('PeerChatPane の状態ごとの描き分け', () => {
  it('アイドルは「送る」。打って Enter で送り、欄が空になる（Shift+Enter は改行）', () => {
    const { actions } = mount(viewOf({ status: 'idle', items: [ai('a1', '終わりました')] }));
    expect(screen.getByText('終わりました')).toBeInTheDocument();
    expect(screen.getByText('アイドル')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /中断/ })).toBeNull();
    type('続けて');
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(actions).toEqual([]);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(actions).toEqual([{ type: 'peerChat.send', sessionId: 's1', body: { t: 'send', text: '続けて' } }]);
    expect(box().value).toBe('');
  });

  it('変換中の Enter では送らない', () => {
    const { actions } = mount(viewOf({ status: 'idle' }));
    type('えんたー');
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    expect(actions).toEqual([]);
  });

  it('空の文は送れない', () => {
    mount(viewOf({ status: 'idle' }));
    expect(screen.getByRole('button', { name: /^送る/ })).toBeDisabled();
  });

  it('作業中は「預ける」と中断を出し、中断で interrupt を送る', () => {
    const { actions } = mount(viewOf({ status: 'busy' }));
    expect(screen.getByText('作業中に送ると、停止してから渡します')).toBeInTheDocument();
    type('あとで');
    fireEvent.click(screen.getByRole('button', { name: /^預ける/ }));
    expect(actions[0]).toEqual({ type: 'peerChat.send', sessionId: 's1', body: { t: 'send', text: 'あとで' } });
    fireEvent.click(screen.getByRole('button', { name: /中断/ }));
    expect(actions[1]).toEqual({ type: 'peerChat.send', sessionId: 's1', body: { t: 'interrupt' } });
  });

  it('預かりは会話の末尾の点線の吹き出しで、取り消すと cancel を送る（ほかの PC の預かりには取り消しが無い）', () => {
    const { actions, container } = mount(viewOf({ status: 'busy', items: [ai('a1', '見ます')], queued: [queued('q1', 'あとで'), queued('q2', 'ほかの文', 'phone')] }));
    const bubbles = container.querySelectorAll('.pchat-queued');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toHaveTextContent('あとで');
    expect(bubbles[0]).toHaveTextContent('停止したら渡す');
    expect(bubbles[1]!.querySelector('.pchat-link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    expect(actions).toEqual([{ type: 'peerChat.send', sessionId: 's1', body: { t: 'cancel', queueId: 'q1' } }]);
  });

  it('停止中は「Mac で再開して送る」で、resume-send を送る', () => {
    const { actions } = mount(viewOf({ status: 'stopped' }));
    expect(screen.getByText('停止中')).toBeInTheDocument();
    type('再開して');
    fireEvent.click(screen.getByRole('button', { name: /Mac で再開して送る/ }));
    expect(actions).toEqual([{ type: 'peerChat.send', sessionId: 's1', body: { t: 'resume-send', text: '再開して' } }]);
  });

  it('接続が切れていると、入力欄を閉じ、「この PC で再開」を出す', () => {
    const { actions } = mount(viewOf({ link: 'offline', status: 'busy', items: [ai('a1', '見ます')] }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Mac に接続できません', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('見ます')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'この PC で再開' }));
    expect(actions).toEqual([{ type: 'session.resumeHere.open', id: 's1' }]);
  });

  it('元の PC の中の失敗（host-error）は、再試行を伝え、送れない。引き継ぎは出さない', () => {
    mount(viewOf({ link: 'host-error', status: 'busy' }));
    expect(screen.getAllByText('再試行中').length).toBeGreaterThan(0);
    expect(box()).toBeDisabled();
    expect(screen.getByText('今は送れません。再試行しています')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'この PC で再開' })).toBeNull();
  });

  it('読み込み中は、列に読み込み中を出す', () => {
    mount(viewOf({ phase: 'loading', status: null }));
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('読み込み中', { selector: '.pchat-empty' })).toBeInTheDocument();
  });
});

describe('会話の中の札（3A）', () => {
  it('許可の札の選択肢を押すと、そのキーで answer を送り、閉じるまで 2 度送らない', () => {
    const { actions } = mount(viewOf({ status: 'waiting', items: [ask()] }));
    expect(screen.getByText('git push origin fix')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1. 許可' }));
    expect(actions).toEqual([{ type: 'peerChat.send', sessionId: 's1', body: { t: 'answer', askId: 'ask-1', keys: ['1'] } }]);
    expect(screen.getByRole('button', { name: '2. 拒否' })).toBeDisabled();
  });

  it('答えが付くと、札は閉じて答えの行（「Mac で許可」）に変わる', () => {
    const { update, container } = mount(viewOf({ status: 'waiting', items: [ask()] }));
    expect(screen.queryByText('Mac で許可')).toBeNull();
    update(viewOf({ status: 'busy', items: [ask(true)] }));
    expect(screen.getByText('Mac で許可')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1. 許可' })).toBeNull();
    expect(container.querySelector('.pchat-ask')).toHaveAttribute('data-done', 'true');
    expect(container.querySelectorAll('.pchat-ask')).toHaveLength(1);
  });

  it('複数選択は、選んでから「選んだものを送る」で 1 度に送る', () => {
    const { actions } = mount(viewOf({ status: 'waiting', items: [{ ...ask(false, { kind: 'question', multi: true, options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }, { key: '3', label: 'C' }] }), kind: 'question' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.click(screen.getByRole('button', { name: 'C' }));
    fireEvent.click(screen.getByRole('button', { name: '選んだものを送る' }));
    expect(actions).toEqual([{ type: 'peerChat.send', sessionId: 's1', body: { t: 'answer', askId: 'ask-1', keys: ['1', '3'] } }]);
  });

  it('自由入力を許す質問は、書いた答えを text で送る', () => {
    const { actions } = mount(viewOf({ status: 'waiting', items: [{ ...ask(false, { kind: 'question', allowText: true }), kind: 'question' }] }));
    fireEvent.change(screen.getByLabelText('他の答えを書く'), { target: { value: '別の案で' } });
    fireEvent.click(screen.getByRole('button', { name: '答える' }));
    expect(actions).toEqual([{ type: 'peerChat.send', sessionId: 's1', body: { t: 'answer', askId: 'ask-1', keys: [], text: '別の案で' } }]);
  });
});

describe('入力欄へ戻る文（取り消し、渡せなかった、送れなかった）', () => {
  it('restore が届くと欄に文が戻り、断りの理由が出る。打ちかけがあれば前に足す', () => {
    const { update } = mount(viewOf({ status: 'busy' }));
    type('打ちかけ');
    update(viewOf({ status: 'busy', restore: { n: 1, text: '戻った文', images: [] }, notice: { n: 1, reason: 'offline' } }));
    expect(box().value).toBe('戻った文\n打ちかけ');
    expect(screen.getByText('Mac に接続できません', { selector: '.pchat-notice' })).toBeInTheDocument();
  });

  it('同じ restore をもう一度は戻さない（描き直しで文が増えない）', () => {
    const r = { n: 1, text: '戻った文', images: [] };
    const { update } = mount(viewOf({ status: 'idle', restore: r }));
    expect(box().value).toBe('');
    update(viewOf({ status: 'idle', restore: { n: 2, text: '戻った文', images: [] } }));
    expect(box().value).toBe('戻った文');
    update(viewOf({ status: 'idle', restore: { n: 2, text: '戻った文', images: [] } }));
    expect(box().value).toBe('戻った文');
  });

  it('渡せなかった預かりが戻ったときは、その旨を出す', () => {
    mount(viewOf({ status: 'idle', notice: { n: 1, reason: 'gone' }, restore: { n: 1, text: 'x', images: [] } }));
    expect(screen.getByText('渡せませんでした。文を入力欄に戻しました')).toBeInTheDocument();
  });
});

describe('@ と画像', () => {
  const assist = (over: Partial<PromptAssist> = {}): PromptAssist => ({ ...NO_ASSIST, ...over });

  it('@ を打つと元の PC のファイルの候補を出し、Enter で入れる', async () => {
    const peerFiles = vi.fn(async () => ['src/app/main.ts', 'src/app/util.ts']);
    mount(viewOf({ status: 'idle' }), assist({ peerFiles }));
    type('見て @ma');
    const opt = await screen.findByRole('option', { name: /main\.ts/ });
    expect(peerFiles).toHaveBeenCalledWith('s1', 'ma');
    expect(opt).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('見て @src/app/main.ts ');
  });

  it('画像を添付すると置き場へ送り、パスで渡す。形と大きさの決まりに合わないものは断る', async () => {
    const upload = vi.fn(async (f: File) => ({ path: `/h/drops/1-1-${f.name}`, name: f.name, size: f.size }));
    const { actions, container } = mount(viewOf({ status: 'idle' }), assist({ upload }));
    const picker = screen.getByTestId('pchat-picker');
    fireEvent.change(picker, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await waitFor(() => expect(container.querySelectorAll('.pchat-image')).toHaveLength(1));
    type('これ');
    fireEvent.click(screen.getByRole('button', { name: /^送る/ }));
    expect(actions).toEqual([{ type: 'peerChat.send', sessionId: 's1', body: { t: 'send', text: 'これ', images: ['/h/drops/1-1-a.png'] } }]);
    fireEvent.change(picker, { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } });
    expect(await screen.findByText('添付できる画像は PNG、JPEG、WebP です')).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('動き（試作に合わせる）', () => {
  it('開いた直後の項目は動かさず、あとから増えた項目だけ下から入る', () => {
    const { update, container } = mount(viewOf({ status: 'busy', items: [user('u1', '調べて'), ai('a1', '見ます')] }));
    expect(container.querySelectorAll('.pchat-in')).toHaveLength(0);
    update(viewOf({ status: 'busy', items: [user('u1', '調べて'), ai('a1', '見ます'), ai('a2', '直しました')] }));
    const fresh = container.querySelectorAll('.pchat-in');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toHaveTextContent('直しました');
    // 入った項目は、次の更新で動き直さない。
    update(viewOf({ status: 'idle', items: [user('u1', '調べて'), ai('a1', '見ます'), ai('a2', '直しました')] }));
    expect(container.querySelectorAll('.pchat-in')).toHaveLength(1);
  });

  it('預かりが渡ると、会話に入った文が小さく弾む', () => {
    const { update, container } = mount(viewOf({ status: 'busy', items: [ai('a1', '見ます')], queued: [queued('q1', 'あとで')] }));
    expect(container.querySelectorAll('.pchat-deliver')).toHaveLength(0);
    act(() => { update(viewOf({ status: 'busy', items: [ai('a1', '見ます'), user('u9', 'あとで', MAC)], queued: [] })); });
    const bubbles = container.querySelectorAll('.pchat-deliver');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent('あとで');
    expect(container.querySelector('.pchat-queued')).toBeNull();
  });
});
