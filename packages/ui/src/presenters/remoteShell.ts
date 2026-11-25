import type { RemoteShellFailure, RemoteShellStatusMsg, RemoteTabDto, Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { remoteTabsOf } from '../store/remoteShell.ts';
import type { TabItemProps } from './session.ts';

/** WS の {t:'remote'} の札から t を除いたもの（runtime/terminals.ts の RemoteLink と同じ形）。 */
export type RemoteLinkState = Omit<RemoteShellStatusMsg, 't'>;

/** peer chat の画面のタブ列で、チャット本体のタブの id。remote のタブの id（サーバが振る）とは重ならない。 */
export const PEER_CHAT_TAB = 'peer-chat';

/** 理由の文の鍵。辞書の鍵は camelCase なので、理由の名前（kebab）から引き直す。 */
export const REASON_KEY = {
  'no-sshd': 'remoteShell.reason.noSshd', unreachable: 'remoteShell.reason.unreachable', auth: 'remoteShell.reason.auth', 'host-key': 'remoteShell.reason.hostKey',
  'no-mux': 'remoteShell.reason.noMux', 'no-client': 'remoteShell.reason.noClient', outdated: 'remoteShell.reason.outdated', dropped: 'remoteShell.reason.dropped', 'bad-cwd': 'remoteShell.reason.badCwd',
} as const satisfies Record<RemoteShellFailure, string>;

/** 輪を出す間か。札がまだ届いていない間は、つないでいる途中として扱う。 */
export const remoteBusy = (link: RemoteLinkState | null): boolean => link === null || link.phase === 'connecting' || link.phase === 'retrying';

export type RemoteShellFace = {
  phase: RemoteShellStatusMsg['phase'];
  /** タブの印を輪にする間。 */
  busy: boolean;
  /** 再接続の間、端末を薄める。 */
  dim: boolean;
  /** failed のときの理由の文と、その種類。 */
  why: string | null;
  reason: RemoteShellFailure | null;
  detail: string | null;
  address: string | null;
};

/** 札から、画面が決めること（輪、薄め、理由の文）を引く。device は相手の PC の名前。 */
export function presentRemoteShell(link: RemoteLinkState | null, device: string, t: Translate): RemoteShellFace {
  const phase = link?.phase ?? 'connecting';
  const reason: RemoteShellFailure | null = phase === 'failed' ? link?.reason ?? 'dropped' : null;
  return {
    phase, busy: remoteBusy(link), dim: phase === 'retrying',
    why: reason ? t(REASON_KEY[reason], { device }) : null,
    reason, detail: link?.detail ?? null, address: link?.address ?? null,
  };
}

/** peer chat の画面の SSH のシェルタブの組み立て。 */
export type PeerShellProps = {
  /** 先頭がチャット本体、続いて remote のタブ（開いた順）。 */
  tabs: TabItemProps[];
  /** いま選んでいる remote のタブ。本体を選んでいる間は null。 */
  shell: { tabId: string; deviceId: string; deviceName: string; host: string | null } | null;
};

/**
 * peerTab は保存されたまま、タブが閉じていることがある。store.remoteTabs にあるものだけを選んだとみなし、無ければ本体を出す。
 * deviceName は、store.devices になければ会話の相手の PC（peerChat の device）、それも無ければ id にする。
 */
export function presentPeerShell(store: Store, sessionId: string, peerTab: string | null, chatTitle: string, t: Translate): PeerShellProps {
  const list = remoteTabsOf(store, sessionId);
  const sel: RemoteTabDto | null = peerTab ? list.find((x) => x.id === peerTab) ?? null : null;
  const nameOf = (deviceId: string) => store.devices.find((d) => d.id === deviceId)?.name ?? (store.peerChat[sessionId]?.device?.deviceId === deviceId ? store.peerChat[sessionId]!.device!.deviceName : deviceId);
  return {
    tabs: [
      { id: PEER_CHAT_TAB, title: chatTitle, kind: 'agent', selected: sel === null, closable: false },
      ...list.map((x): TabItemProps => ({ id: x.id, title: x.title || t('remoteShell.tab.title'), kind: 'remote', selected: x.id === sel?.id, closable: true })),
    ],
    shell: sel ? { tabId: sel.id, deviceId: sel.deviceId, deviceName: nameOf(sel.deviceId), host: store.remoteHosts[sel.deviceId] ?? null } : null,
  };
}
