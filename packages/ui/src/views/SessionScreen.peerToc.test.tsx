import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type PeerChatCard, type PeerChatItem, type PeerChatTurn, type SessionDto, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentSession } from '../presenters/session.ts';
import { emptySlice, type PeerChatSlice } from '../store/peerChat.ts';
import { initialStore, type Store } from '../store/store.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { SessionScreen } from './SessionScreen.tsx';
import { sessionDto } from '../test/sessionDto.ts';

afterEach(cleanup);

const NOW = Date.UTC(2026, 10, 6, 3, 0, 0);
const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const stats = { turns: 3, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: 0 };
const session = (): SessionDto => (sessionDto({ name: '同期の衝突を調べる', cwd: '/w/app', startedAt: NOW - 3_600_000, lastActivityAt: NOW - 1000, lastTurnAt: NOW - 1000, hasTranscript: true, stats, lock: { deviceId: 'd-mac', deviceName: 'Mac', runId: 'r9', heartbeatAt: NOW, stale: false } }) as SessionDto);
const card = (): PeerChatCard => ({
  aside: null, turnFrom: 1,
  digest: { sessionId: 's1', turnStartSeq: 1, intent: { text: '衝突の原因を探す', at: NOW - 30_000, stepsSince: 1, inThisTurn: true }, agents: [] },
  events: [{ kind: 'user', seq: 1, ts: NOW - 40_000, text: '調べて' }],
  waitingFor: null, permission: null, limit: null, activity: null, artifacts: 0, hints: true,
});
const item = (uuid: string): PeerChatItem => ({ uuid, at: 1, kind: 'user', text: `本文 ${uuid}` });
const turn = (uuid: string, at: number): PeerChatTurn => ({ uuid, at, text: `指示 ${uuid}`, tools: 1 });

function screenOf(slice: Partial<PeerChatSlice>) {
  const st: Store = initialStore();
  st.bootstrapped = true;
  st.device = { id: 'me', name: 'Win' };
  st.sessions = { s1: session() };
  st.peerChat = { s1: { ...emptySlice('v1'), phase: 'live', device: MAC, status: 'idle', items: [item('u1'), item('u2')], ...slice } };
  const actions: UiAction[] = [];
  const props = presentSession(initialState(), st, NOW, 's1');
  const r = render(<LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)} background={(a) => actions.push(a)}><SessionScreen {...props} /></ActionRoot></LanguageRoot>);
  return { actions, ...r };
}
const turns = [turn('u1', NOW - 120_000), turn('u2', NOW - 60_000)];

describe('セッション画面: ほかの PC の会話の右の欄（目次）', () => {
  it('札が無くても、目次があれば右の欄を出す（終わった画面は目次だけ）', () => {
    const { container } = screenOf({ card: null, turnCount: 2, turnsLoaded: true, turns });
    expect(container.querySelector('.c-body > .toc-slot')).not.toBeNull();
    expect(container.querySelector('.c-body')).not.toHaveAttribute('data-toc');
    expect(screen.queryByRole('region', { name: 'セッションの現在の状態' })).toBeNull();
    expect(container.querySelectorAll('.toc-pane .turn-row')).toHaveLength(2);
    expect(container.querySelector('.toc-pane')).toHaveTextContent('2 ターン');
  });

  it('札があれば、札の下に目次を置く', () => {
    const { container } = screenOf({ status: 'busy', card: card(), turnCount: 2, turnsLoaded: true, turns });
    const now = screen.getByRole('region', { name: 'セッションの現在の状態' });
    const toc = container.querySelector('.toc-pane')!;
    expect(now.compareDocumentPosition(toc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(now.parentElement).toBe(toc.parentElement);
  });

  it('turnCount が無い（古い相手）ときは目次も札も無く、右の欄を出さない', () => {
    const { container } = screenOf({ card: null, turnCount: null });
    expect(container.querySelector('.toc-slot')).toBeNull();
    expect(container.querySelector('.c-body')).toHaveAttribute('data-toc', 'none');
  });

  it('目次の行を押すと、その項目の uuid で跳ぶ頼みを出す（手元の turn.open は出さない）', () => {
    const { actions } = screenOf({ card: null, turnCount: 2, turnsLoaded: true, turns });
    fireEvent.click(screen.getByRole('button', { name: /指示 u1/ }));
    expect(actions).toContainEqual({ type: 'peerChat.jump', sessionId: 's1', uuid: 'u1' });
    expect(actions.some((a) => a.type === 'turn.open')).toBe(false);
  });

  it('さらに読むは、peerChat.turnsMore を出す', () => {
    const { actions } = screenOf({ card: null, turnCount: 5, turnsLoaded: true, turnsMore: true, turns });
    fireEvent.click(screen.getByRole('button', { name: '古いターンを読み込む' }));
    expect(actions).toContainEqual({ type: 'peerChat.turnsMore', sessionId: 's1' });
  });

  it('古い分を読み足している間は、押した行の番号が明滅する印を持ち、行は押せない', () => {
    const { container } = screenOf({ card: null, turnCount: 2, turnsLoaded: true, turns, jumping: 'u1' });
    const busy = container.querySelectorAll('.turn[data-busy="true"]');
    expect(busy).toHaveLength(1);
    expect(busy[0]).toHaveTextContent('指示 u1');
  });
});
