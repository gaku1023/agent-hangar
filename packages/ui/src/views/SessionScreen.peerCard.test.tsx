import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { translator, type PeerChatCard, type SessionDto, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentPeerChat } from '../presenters/peerChat.ts';
import { presentSession } from '../presenters/session.ts';
import { emptySlice, type PeerChatSlice } from '../store/peerChat.ts';
import { initialStore, type Store } from '../store/store.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { SessionScreen } from './SessionScreen.tsx';
import { sessionDto } from '../test/sessionDto.ts';

const ja = translator('ja');
const NOW = Date.UTC(2026, 10, 6, 3, 0, 0);
const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const stats = { turns: 3, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: 0 };
const session = (over: Partial<SessionDto> = {}): SessionDto => (sessionDto({ name: '同期の衝突を調べる', cwd: '/w/app', startedAt: NOW - 3_600_000, lastActivityAt: NOW - 1000, lastTurnAt: NOW - 1000, hasTranscript: true, stats, lock: { deviceId: 'd-mac', deviceName: 'Mac', runId: 'r9', heartbeatAt: NOW, stale: false }, ...over }) as SessionDto);

const agent = (agentId: string, state: 'running' | 'done', title: string) => ({ agentId, title, state, startedAt: NOW - 60_000, lastAt: NOW - 1000, last: state === 'running' ? { text: '読んでいます', mono: false, kind: 'read' as const, isError: false } : null, report: state === 'done' ? '結論は A です' : null, endNote: null, linked: true });
const card = (over: Partial<PeerChatCard> = {}): PeerChatCard => ({
  aside: null, turnFrom: 1,
  digest: { sessionId: 's1', turnStartSeq: 1, intent: { text: '衝突の原因を探す', at: NOW - 30_000, stepsSince: 1, inThisTurn: true }, agents: [agent('a1', 'running', '調査役'), agent('a2', 'done', '確認役')] },
  events: [
    { kind: 'user', seq: 1, ts: NOW - 40_000, text: '調べて' },
    { kind: 'tool_call', seq: 2, ts: NOW - 20_000, toolId: 't2', name: 'Read', input: { file_path: '/w/app/a.ts' } },
    { kind: 'tool_result', seq: 3, toolId: 't2', isError: false },
    { kind: 'tool_call', seq: 4, ts: NOW - 10_000, toolId: 't4', name: 'Grep', input: { pattern: 'parent' } },
  ],
  waitingFor: null, permission: null, limit: null, activity: null, artifacts: 2, hints: true, ...over,
});

function build(slice: Partial<PeerChatSlice>, s: SessionDto = session()) {
  const st: Store = initialStore();
  st.bootstrapped = true;
  st.device = { id: 'me', name: 'Win' };
  st.sessions = { s1: s };
  st.peerChat = { s1: { ...emptySlice('v1'), phase: 'live', device: MAC, status: 'busy', ...slice } };
  return st;
}
function screenOf(slice: Partial<PeerChatSlice>) {
  const actions: UiAction[] = [];
  const props = presentSession(initialState(), build(slice), NOW, 's1');
  const r = render(<LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)} background={(a) => actions.push(a)}><SessionScreen {...props} /></ActionRoot></LanguageRoot>);
  return { actions, props, ...r };
}

describe('セッション画面: ほかの PC の会話の右の欄（現在の札）', () => {
  it('札の材料があれば、手元と同じ右の欄に現在の札を置く。状態、意図、直近のツール、サブエージェント、アーティファクトの数が出る', () => {
    const { container } = screenOf({ card: card() });
    const slot = container.querySelector('.c-body > .toc-slot') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(container.querySelector('.c-body')).not.toHaveAttribute('data-toc');
    const now = within(slot).getByRole('region', { name: 'セッションの現在の状態' });
    expect(within(now).getByRole('status')).toHaveTextContent('作業中');
    expect(now).toHaveTextContent('衝突の原因を探す');
    expect(within(now).getByLabelText('ツール呼び出し')).toHaveTextContent('a.ts');
    expect(within(now).getByLabelText('ツール呼び出し')).toHaveTextContent('parent');
    expect(now).toHaveTextContent('サブエージェント');
    expect(now).toHaveTextContent('アーティファクト');
    // 本文は左に残る（目次は持たない）。
    expect(container.querySelector('.pchat-pane')).not.toBeNull();
    expect(container.querySelector('.toc-pane')).toBeNull();
  });

  it('context の量は、札があれば手元の会話と同じく札の状態の行の右端に出し、チャットの状態の行には出さない', () => {
    const st = build({ card: card() }, session({ stats: { ...stats, contextTokens: 151_000, contextSize: 200_000 } as never }));
    const props = presentSession(initialState(), st, NOW, 's1');
    const { container } = render(<LanguageRoot language="ja"><ActionRoot onAction={() => {}} background={() => {}}><SessionScreen {...props} /></ActionRoot></LanguageRoot>);
    expect(container.querySelector('.now-card .nc-head .ctx-label')).toHaveTextContent('151K/200K');
    expect(container.querySelector('.pchat-bar .ctx-label')).toBeNull();
  });

  it('札が無い間は、context の量をチャットの状態の行に残す', () => {
    const st = build({ card: null }, session({ stats: { ...stats, contextTokens: 151_000, contextSize: 200_000 } as never }));
    const props = presentSession(initialState(), st, NOW, 's1');
    const { container } = render(<LanguageRoot language="ja"><ActionRoot onAction={() => {}} background={() => {}}><SessionScreen {...props} /></ActionRoot></LanguageRoot>);
    expect(container.querySelector('.pchat-bar .ctx-label')).toHaveTextContent('151K/200K');
  });

  it('札の材料が無い間（古い相手、止まった会話）は、右の欄を出さず、本文が全幅のまま', () => {
    const { container } = screenOf({ card: null });
    expect(container.querySelector('.toc-slot')).toBeNull();
    expect(container.querySelector('.c-body')).toHaveAttribute('data-toc', 'none');
  });

  it('サブエージェントの行は、そのターンに終わった本も「済」で残り、押しても何も起きない（本文は切り替えない）', () => {
    const { actions } = screenOf({ card: card() });
    fireEvent.click(screen.getByRole('button', { name: /サブエージェント/ }));
    const rows = screen.getAllByRole('button').filter((b) => b.classList.contains('nc-lane-row'));
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('調査役'), expect.stringContaining('確認役')]);
    expect(rows[1]).toHaveTextContent('完了');
    for (const r of rows) expect(r).toBeDisabled();
    const before = actions.length;
    for (const r of rows) fireEvent.click(r);
    expect(actions.slice(before)).toEqual([]);
    expect(actions.some((a) => a.type === 'transcript.selectAgent')).toBe(false);
  });

  it('アーティファクトは数だけで、押せない（本文は元の PC のもの）', () => {
    const { container } = screenOf({ card: card() });
    const chip = Array.from(container.querySelectorAll('.nc-chips .count-chip')).find((c) => c.textContent?.includes('アーティファクト'))!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveTextContent('2');
  });

  it('⌘J の開閉（transcript.toggle）で畳める。畳むと状態の行の右端に開く札が出て、押すと同じ操作を出す', () => {
    const { actions, container } = screenOf({ card: card() });
    fireEvent.click(within(container.querySelector('.toc-slot-head') as HTMLElement).getByRole('button'));
    expect(actions).toContainEqual({ type: 'transcript.toggle' });
  });

  it('裏だけ動いているとき（status は busy のまま、札の aside）、本文の頭の状態も札も「バックグラウンドで作業中」で、色は aside。預かりの案内は出さず、そのまま送れる', () => {
    const { container } = screenOf({ card: card({ aside: { shell: false, agents: 1 } }), items: [{ uuid: 'a1', at: 1, kind: 'assistant', text: '調べています' }] });
    const bar = container.querySelector('.pchat-bar')!;
    expect(bar).toHaveTextContent('バックグラウンドで作業中');
    expect(bar.querySelector('.pchat-dot')).toHaveAttribute('data-tone', 'aside');
    const now = container.querySelector('.now-card')!;
    expect(now).toHaveAttribute('data-tone', 'aside');
    expect(within(now as HTMLElement).getByRole('status')).toHaveTextContent('バックグラウンドで作業中');
    expect(container.textContent).not.toContain('止まってから渡します');
    expect(screen.getByRole('button', { name: '送る' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '預ける' })).toBeNull();
  });

  it('作業中（裏でない）は、今までどおり「作業中」で、預かりの案内を出す', () => {
    const { container } = screenOf({ card: card() });
    expect(container.querySelector('.pchat-bar')).toHaveTextContent('作業中');
    expect(container.textContent).toContain('止まってから渡します');
  });
});

describe('presentPeerChat: 裏だけ（aside）', () => {
  it('状態の語、色、送る口、中断が、手元の会話と同じ向きになる', () => {
    const v = presentPeerChat(build({ card: card({ aside: { shell: true, agents: 0 } }) }), 's1', ja)!;
    expect(v).toMatchObject({ status: 'busy', statusLabel: 'バックグラウンドで作業中', tone: 'aside', composer: { kind: 'send', hint: null, canInterrupt: false } });
  });

  it('入力待ちと休みは、札に aside があっても裏だけとは読まない', () => {
    expect(presentPeerChat(build({ status: 'waiting', card: card({ aside: { shell: true, agents: 0 } }) }), 's1', ja)).toMatchObject({ tone: 'waiting', composer: { kind: 'queue' } });
    expect(presentPeerChat(build({ status: 'idle', card: card({ aside: { shell: true, agents: 0 } }) }), 's1', ja)).toMatchObject({ tone: 'idle', composer: { kind: 'send' } });
  });
});
