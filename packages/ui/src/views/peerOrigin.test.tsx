import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator, type PeerChatQueued, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import { PEER_FLASH_MS, presentPeerOrigin, type PeerOriginProps } from '../presenters/peerOrigin.ts';
import { presentSettings, type SettingsProps } from '../presenters/settings.ts';
import type { SideLiveGroup, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import type { SessionMenuProps } from '../presenters/sessionMenu.ts';
import { applyServerEvent, initialStore } from '../store/store.ts';
import { Sidebar } from './Sidebar.tsx';
import { TerminalHostContext, TerminalPane } from './TerminalPane.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const t = translator('ja');
const mac = { deviceId: 'pc-mac', deviceName: 'Mac' };
const q = (id: string): PeerChatQueued => ({ queueId: id, from: mac, text: 'x', images: 0, at: 1, state: 'waiting' });
const origin = (events: Parameters<typeof applyServerEvent>[1][]): PeerOriginProps | null => presentPeerOrigin(events.reduce(applyServerEvent, initialStore()), 's1', t);

const host = { connect() {}, disconnect() {}, mount() {}, status: () => null, fit() {}, focus() {}, paste() {}, input() {}, zoom() {}, fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose() {}, link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect() {} } as never;
const pane = (peer: PeerOriginProps | null) => (
  <LanguageRoot language="ja"><TerminalHostContext.Provider value={host}><TerminalPane tabId="t1" hint={null} live="busy" agent peer={peer} /></TerminalHostContext.Provider></LanguageRoot>
);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('端末の下の預かりの帯', () => {
  it('預かりが入ると帯が出て、空になると畳む', () => {
    const { rerender } = render(pane(null));
    expect(screen.queryByTestId('peer-band')).toBeNull();
    rerender(pane(origin([{ type: 'peerChat.queue', sessionId: 's1', queued: [q('a'), q('b')] }])));
    const band = screen.getByTestId('peer-band');
    expect(band).toHaveTextContent('Mac から 2 件を預かっています。止まったら渡します');
    expect(band).toHaveAttribute('role', 'status');
    // 端末の本体より後ろ（下）に置く。
    const host = document.querySelector('.term-host')!;
    expect(host.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(pane(origin([{ type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] }, { type: 'peerChat.queue', sessionId: 's1', queued: [] }])));
    expect(screen.queryByTestId('peer-band')).toBeNull();
  });

  it('件数が変わったら、帯の文が替わる', () => {
    const { rerender } = render(pane(origin([{ type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] }])));
    expect(screen.getByTestId('peer-band')).toHaveTextContent('1 件');
    rerender(pane(origin([{ type: 'peerChat.queue', sessionId: 's1', queued: [q('a'), q('b'), q('c')] }])));
    expect(screen.getByTestId('peer-band')).toHaveTextContent('3 件');
  });
});

describe('「{device} から送信しました」の札', () => {
  const delivered = (at: number) => origin([{ type: 'peerChat.delivered', sessionId: 's1', from: mac, at }]);

  it('渡した知らせで出て、3 秒で消える', () => {
    const { rerender } = render(pane(null));
    rerender(pane(delivered(100)));
    expect(screen.getByTestId('peer-badge')).toHaveTextContent('Mac から送信しました');
    act(() => { vi.advanceTimersByTime(PEER_FLASH_MS - 1); });
    expect(screen.getByTestId('peer-badge')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId('peer-badge')).toBeNull();
  });

  it('開いた時点で残っている札は出さない（開き直した画面で古い札を見せない）', () => {
    render(pane(delivered(100)));
    expect(screen.queryByTestId('peer-badge')).toBeNull();
  });

  it('続けて渡したら、3 秒を数え直す', () => {
    const { rerender } = render(pane(null));
    rerender(pane(delivered(100)));
    act(() => { vi.advanceTimersByTime(2000); });
    rerender(pane(delivered(200)));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId('peer-badge')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByTestId('peer-badge')).toBeNull();
  });

  it('消える前に外れたら、数えていた時計を残さない（アンマウントと、会話を替えて札が無くなったとき）', () => {
    const idle = vi.getTimerCount();
    const a = render(pane(null));
    const base = vi.getTimerCount();
    a.rerender(pane(delivered(100)));
    expect(vi.getTimerCount()).toBeGreaterThan(base);
    // 会話を替えて、新しい会話には札が無い。
    a.rerender(pane(null));
    expect(screen.queryByTestId('peer-badge')).toBeNull();
    expect(vi.getTimerCount()).toBe(base);
    a.rerender(pane(delivered(200)));
    a.unmount();
    expect(vi.getTimerCount()).toBe(idle);
  });

  it('預かりの帯と札は同時に出せる（渡した直後に次の預かりが入った）', () => {
    const { rerender } = render(pane(null));
    const both: PeerOriginProps = { band: 'Mac から 1 件を預かっています。止まったら渡します', flash: { text: 'Mac から送信しました', key: 5 } };
    rerender(pane(both));
    expect(screen.getByTestId('peer-badge')).toBeInTheDocument();
    expect(screen.getByTestId('peer-band')).toBeInTheDocument();
  });
});

describe('サイドバーの印', () => {
  const menu: SessionMenuProps = { id: 's1', name: 'n', status: null, resumeHere: null, stop: { runId: 'r', working: true, aside: false, shellTabs: 0 }, moveBlocked: null };
  const row = (peerIn: PeerOriginProps | null): SideLiveRow => ({ id: 's1', name: 'name-s1', live: 'busy', aside: false, reason: null, waited: null, current: false, menu, peerIn });
  const live = (r: SideLiveRow): SideLiveProps => { const g: SideLiveGroup = { key: 'web', name: 'web', open: true, waiting: 0, rows: [r] }; return { count: 1, ids: [r.id], rows: [r], groups: [g], pins: [] }; };
  const side = (r: SideLiveRow) => (
    <LanguageRoot language="ja"><ActionRoot onAction={vi.fn()}><Sidebar nav={[]} foot={[]} collapsed={false} live={live(r)} /></ActionRoot></LanguageRoot>
  );

  it('預かりがある間は印が出て、無くなると消える。説明は title と読み上げに持つ', () => {
    const queued = origin([{ type: 'peerChat.queue', sessionId: 's1', queued: [q('a')] }]);
    const { rerender, container } = render(side(row(queued)));
    const mark = container.querySelector('.side-live-peer')!;
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveAttribute('title', 'Mac から 1 件を預かっています。止まったら渡します');
    expect(mark.querySelector('.sr-only')).toHaveTextContent('Mac から 1 件を預かっています。止まったら渡します');
    rerender(side(row(null)));
    expect(container.querySelector('.side-live-peer')).toBeNull();
  });

  it('渡した知らせでも印が出て、3 秒で消える', () => {
    const { rerender, container } = render(side(row(null)));
    rerender(side(row(origin([{ type: 'peerChat.delivered', sessionId: 's1', from: mac, at: 1 }]))));
    expect(container.querySelector('.side-live-peer')).toHaveAttribute('title', 'Mac から送信しました');
    act(() => { vi.advanceTimersByTime(PEER_FLASH_MS); });
    expect(container.querySelector('.side-live-peer')).toBeNull();
  });

  it('知らせの無い行には印を出さない', () => {
    const { container } = render(side(row(null)));
    expect(container.querySelector('.side-live-peer')).toBeNull();
  });
});

describe('設定のクラウド同期の「他の PC からの送信を受ける」', () => {
  const cloudProps = (accept: boolean | undefined): SettingsProps => {
    const store = initialStore();
    store.settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', peerChatAcceptFromPeers: accept } as never;
    store.sync = { state: 'idle', url: 'https://x', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 2, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false, diskShort: null } as never;
    return presentSettings(initialState(), store, Date.now());
  };

  it('presenter は設定の値を渡す。未設定は入りとして読む', () => {
    expect(cloudProps(false).cloud.peerChatAccept).toBe(false);
    expect(cloudProps(true).cloud.peerChatAccept).toBe(true);
    expect(cloudProps(undefined).cloud.peerChatAccept).toBe(true);
  });
});
