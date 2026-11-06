import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { translator, type SessionDto, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentSession } from '../presenters/session.ts';
import { emptySlice, type PeerChatSlice } from '../store/peerChat.ts';
import { initialStore, type Store } from '../store/store.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { SessionScreen } from './SessionScreen.tsx';

const NOW = Date.UTC(2026, 10, 6, 3, 0, 0);
const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const stats = { turns: 3, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: 0 };
const session = (over: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: '同期の衝突を調べる', cwd: '/w/app', firstPrompt: null, aiTitle: null, startedAt: NOW - 3_600_000, lastActivityAt: NOW - 1000, lastTurnAt: NOW - 1000,
  hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: { deviceId: 'd-mac', deviceName: 'Mac', runId: 'r9', heartbeatAt: NOW, stale: false }, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, ...over,
} as SessionDto);
function screenOf(s: SessionDto, slice: Partial<PeerChatSlice> | null) {
  const st: Store = initialStore();
  st.bootstrapped = true;
  st.device = { id: 'me', name: 'Win' };
  st.sessions = { s1: s };
  if (slice) st.peerChat = { s1: { ...emptySlice('v1'), device: MAC, ...slice } };
  const actions: UiAction[] = [];
  const props = presentSession(initialState(), st, NOW, 's1');
  const r = render(<LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)} background={(a) => actions.push(a)}><SessionScreen {...props} /></ActionRoot></LanguageRoot>);
  return { actions, ...r };
}

describe('セッション画面: ほかの PC の Claude Code の会話', () => {
  it('開くと見張りを頼み（peerChat.open）、閉じると外す（peerChat.close）', () => {
    const { actions, unmount } = screenOf(session(), null);
    expect(actions).toContainEqual({ type: 'peerChat.open', sessionId: 's1', viewer: expect.stringMatching(/^ui-[a-z0-9]+$/) });
    unmount();
    expect(actions).toContainEqual({ type: 'peerChat.close', sessionId: 's1' });
  });

  it('見張りが動いている間は、トランスクリプトの代わりにチャットを出す', () => {
    const { container } = screenOf(session(), { phase: 'live', status: 'idle', items: [{ uuid: 'a1', at: 1, kind: 'assistant', text: '終わりました' }] });
    expect(container.querySelector('.pchat-pane')).not.toBeNull();
    expect(container.querySelector('.tr-wrap')).toBeNull();
    expect(screen.getByText('終わりました')).toBeInTheDocument();
  });

  it('読み込み中は、読み込み中の殻を出す（読み取り専用の画面を一瞬見せない）', () => {
    const { container } = screenOf(session(), { phase: 'loading' });
    expect(container.querySelector('.pchat-pane')).not.toBeNull();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.tr-wrap')).toBeNull();
  });

  it('見続けられなかった（相手の hangar が古い、会話が多すぎる、など）ときは、読み取り専用のトランスクリプトのまま', () => {
    for (const fallback of ['device-outdated', 'too-many', 'worker-outdated', 'not-claude'] as const) {
      const { container, unmount } = screenOf(session(), { phase: 'fallback', fallback });
      expect(container.querySelector('.pchat-pane'), fallback).toBeNull();
      expect(container.querySelector('.session-reason'), fallback).toBeNull();
      unmount();
    }
  });

  it('相手が他の PC からの操作を受け付けない設定のときは、トランスクリプトの上にその理由を 1 行出す', () => {
    const { container } = screenOf(session(), { phase: 'fallback', fallback: 'refused-by-setting' });
    expect(container.querySelector('.pchat-pane')).toBeNull();
    expect(screen.getByText('Mac は、他の PC からの操作を受け付けない設定です。読み取り専用で表示しています')).toBeInTheDocument();
  });

  it('Codex と opencode の会話は、見張りを頼まず、チャットも出さない', () => {
    for (const provider of ['codex', 'opencode'] as const) {
      const { actions, container, unmount } = screenOf(session({ provider }), { phase: 'live', status: 'idle' });
      expect(actions.filter((a) => a.type === 'peerChat.open')).toEqual([]);
      expect(container.querySelector('.pchat-pane')).toBeNull();
      unmount();
    }
  });

  it('この PC の会話は、見張りを頼まない', () => {
    const { actions } = screenOf(session({ lock: null, remoteOnly: false }), null);
    expect(actions.filter((a) => a.type === 'peerChat.open')).toEqual([]);
  });
});
