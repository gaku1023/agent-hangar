import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator, type RemoteTabDto, type SessionDto, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { initialState } from '../mediator/transition.ts';
import { PEER_CHAT_TAB } from '../presenters/remoteShell.ts';
import { presentSession, type TabItemProps } from '../presenters/session.ts';
import type { RemoteLink, TerminalHost } from '../runtime/terminals.ts';
import { emptySlice } from '../store/peerChat.ts';
import { initialStore, type Store } from '../store/store.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { sessionDto } from '../test/sessionDto.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { SessionScreen } from './SessionScreen.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';

const t = translator('ja');
const NOW = Date.UTC(2026, 10, 25, 3, 0, 0);

function host(link: RemoteLink | null): TerminalHost {
  return { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => 'connected', fit: vi.fn(), focus: vi.fn(), remote: () => link, retry: vi.fn(), paste: vi.fn(), input: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() } as unknown as TerminalHost;
}
function pane(link: RemoteLink | null, over: { hostName?: string | null } = {}) {
  const actions: UiAction[] = [];
  const h = host(link);
  const r = render(
    <LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)} background={(a) => actions.push(a)}>
      <TerminalHostContext.Provider value={h}>
        <TerminalPane tabId="rt1" hint={null} live={null} remote={{ deviceId: 'd-win', deviceName: 'Win', host: over.hostName ?? null }} />
      </TerminalHostContext.Provider>
    </ActionRoot></LanguageRoot>);
  return { actions, h, ...r };
}

describe('TerminalPane: SSH のシェルタブ', () => {
  it('failed は既存の暗幕を出さず、端末の中央に理由と PC 名の札と 3 つの操作を出す', () => {
    const { container } = pane({ phase: 'failed', reason: 'auth' });
    expect(container.querySelector('.term-veil')).toBeNull();
    expect(container.querySelector('.term-remote-center')).not.toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(t('remoteShell.reason.auth'));
    expect(container.querySelector('.term-remote-host')).toHaveTextContent('Win');
    expect(screen.getByRole('button', { name: /エージェントで/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('remoteShell.action.change') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('remoteShell.action.retry') })).toBeInTheDocument();
  });
  it('「もう一度」は remote.retry を出す', () => {
    const { actions } = pane({ phase: 'failed', reason: 'dropped' });
    fireEvent.click(screen.getByRole('button', { name: t('remoteShell.action.retry') }));
    expect(actions).toContainEqual({ type: 'remote.retry', tabId: 'rt1' });
  });
  it('「住所を変える」で入力欄と「つなぐ」が出て、Enter で remote.sshHost を出す（retryTabId つき）', () => {
    fakeMotionTokens();
    const { actions } = pane({ phase: 'failed', reason: 'unreachable' }, { hostName: 'win-box' });
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('remoteShell.action.change') }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('win-box');
    fireEvent.change(input, { target: { value: 'win-12700k' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions).toContainEqual({ type: 'remote.sshHost', deviceId: 'd-win', host: 'win-12700k', retryTabId: 'rt1' });
  });
  it('空にして「つなぐ」を押すと上書きを解く（host は null）', () => {
    const { actions } = pane({ phase: 'failed', reason: 'unreachable' }, { hostName: 'win-box' });
    fireEvent.click(screen.getByRole('button', { name: t('remoteShell.action.change') }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: t('remoteShell.action.go') }));
    expect(actions).toContainEqual({ type: 'remote.sshHost', deviceId: 'd-win', host: null, retryTabId: 'rt1' });
  });
  it('診断ボタンは investigate.open（op remoteShell）に PC 名と宛先と detail を載せる', () => {
    const { actions } = pane({ phase: 'failed', reason: 'auth', address: '100.1.2.3', detail: 'Permission denied' });
    fireEvent.click(screen.getByRole('button', { name: /エージェントで/ }));
    expect(actions).toContainEqual(expect.objectContaining({ type: 'investigate.open', op: 'remoteShell', code: 'auth', remote: { device: 'Win', address: '100.1.2.3', detail: 'Permission denied' } }));
  });
  it('retrying は暗幕も中央の塊も出さず、端末を薄める（data-dim）', () => {
    const { container } = pane({ phase: 'retrying', attempt: 2 });
    expect(container.querySelector('.term-veil')).toBeNull();
    expect(container.querySelector('.term-remote-center')).toBeNull();
    expect(container.querySelector('.term-pane')).toHaveAttribute('data-dim', 'true');
  });
  it('ready と connecting は薄めず、塊も出さない', () => {
    for (const link of [{ phase: 'ready' as const }, { phase: 'connecting' as const }, null]) {
      const { container, unmount } = pane(link);
      expect(container.querySelector('.term-pane')).not.toHaveAttribute('data-dim');
      expect(container.querySelector('.term-remote-center')).toBeNull();
      unmount();
    }
  });
});

describe('TabStrip: peer chat のタブ列', () => {
  const tabs: TabItemProps[] = [
    { id: PEER_CHAT_TAB, title: 'Claude', kind: 'agent', selected: true, closable: false },
    { id: 'rt1', title: 'シェル', kind: 'remote', selected: false, closable: true, busy: true },
  ];
  function strip(over: Partial<Parameters<typeof TabStrip>[0]> = {}) {
    const actions: UiAction[] = [];
    const r = render(<LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)} background={() => {}}><TabStrip sessionId="s1" tabs={tabs} canAdd canSplit={false} split={false} showSplit={false} addKind="remote" {...over} /></ActionRoot></LanguageRoot>);
    return { actions, ...r };
  }
  it('分割の札を出さず、busy のタブは印が輪になる', () => {
    const { container } = strip();
    expect(container.querySelector('.tab-action')).toBeNull();
    expect(container.querySelectorAll('[role="tab"]')[1]!.querySelector('.tab-spin')).not.toBeNull();
    expect(container.querySelectorAll('[role="tab"]')[0]!.querySelector('.tab-spin')).toBeNull();
  });
  it('「+」は tab.open の remote、Claude のタブは remote.select の null、remote のタブは tab.select', () => {
    const { actions, container } = strip();
    fireEvent.click(container.querySelector('.tab-add')!);
    expect(actions).toContainEqual({ type: 'tab.open', sessionId: 's1', kind: 'remote' });
    const [chat, shell] = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    fireEvent.click(shell!);
    fireEvent.click(chat!);
    expect(actions).toContainEqual({ type: 'tab.select', tabId: 'rt1' });
    expect(actions).toContainEqual({ type: 'remote.select', tabId: null });
  });
});

describe('SessionScreen: peer chat にタブ列', () => {
  const tabDto: RemoteTabDto = { id: 'rt1', sessionId: 's1', deviceId: 'd-win', title: 'シェル', createdAt: 1 };
  function screenOf(peerTab: string | null) {
    const st: Store = initialStore();
    st.bootstrapped = true;
    st.device = { id: 'me', name: 'Mac' };
    st.sessions = { s1: sessionDto({ name: 'x', cwd: '/w', provider: 'claude-code', remoteOnly: true, hasTranscript: true }) as SessionDto };
    st.peerChat = { s1: { ...emptySlice('v1'), device: { deviceId: 'd-win', deviceName: 'Win' }, phase: 'live', status: 'idle', items: [{ uuid: 'a1', at: 1, kind: 'assistant', text: '終わりました' }] } };
    st.remoteTabs = { rt1: tabDto };
    const state = initialState();
    state.sessionView = { s1: { ...defaultSessionView(), peerTab } };
    const actions: UiAction[] = [];
    const props = presentSession(state, st, NOW, 's1');
    const r = render(<LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)} background={(a) => actions.push(a)}><TerminalHostContext.Provider value={host({ phase: 'ready' })}><SessionScreen {...props} /></TerminalHostContext.Provider></ActionRoot></LanguageRoot>);
    return { actions, ...r };
  }
  it('本体を選んでいる間は、タブ列とチャットを出す', () => {
    const { container } = screenOf(null);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(container.querySelector('.pchat-pane')).not.toBeNull();
    expect(container.querySelector('.term-pane')).toBeNull();
  });
  it('remote のタブを選んでいる間は、チャットの代わりに端末を出す', () => {
    const { container } = screenOf('rt1');
    expect(container.querySelector('.pchat-pane')).toBeNull();
    expect(container.querySelector('[data-testid="term-rt1"]')).not.toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')).toHaveTextContent('シェル');
  });
});
