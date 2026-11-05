import type { PeerDeviceStatus, PeerKeyring, PeerLaunchApi } from '@agent-hangar/shared';
import { readPeerStatuses } from '../config/deviceStatus.ts';
import type { Db } from '../db/open.ts';

/**
 * 呼ぶ側（T8、T11）。別の PC へ起こす前の、相手の引き当てと経路の決め方。
 *
 * online の判定は、相手の devices.last_seen_at が PEER_ONLINE_MS 以内かどうかである。
 * last_seen_at は各 PC が 10 分ごとに書いて同期に載るので、その 1.5 倍を鮮度の上限にする。
 * 呼び鈴のつながりは相手の側にあるので、こちらからは見えない。
 */
export const PEER_ONLINE_MS = 15 * 60_000;

/** 経路。cloud は Worker 経由、ssh は予備（相手の 127.0.0.1 の hangar へのトンネル）。 */
export type PeerVia = 'cloud' | 'ssh';

/** 送る前に決まる断りの理由（頼みを置く前に呼ぶ側が決めるもの）。 */
export const PEER_CALL_REFUSALS = ['device-unknown', 'device-outdated', 'device-offline', 'depth-exceeded', 'ssh-host-key-mismatch', 'ssh-unreachable'] as const;
export type PeerCallRefusal = (typeof PEER_CALL_REFUSALS)[number];

/** SSH の予備の経路（D3）。 */
export type PeerSshRouteDeps = {
  /** 設定「ほかの PC」に登録があるか。 */
  registered(deviceId: string): boolean;
  /** 相手ごとの口。トンネルは最初の put で張る（張れなければ PeerSshConnectError）。 */
  api(deviceId: string): PeerLaunchApi;
  /** 封の鍵。クラウドに参加していれば Worker の版が古くても持つ。無ければ null。 */
  ring(): (() => Promise<PeerKeyring>) | null;
  /** PC どうしの token の鍵があるか。 */
  tokensReady(): boolean;
};

/** 呼ぶ側の依存。MCP の道具（mcp/peerTools.ts）が使う。 */
export type PeerCallDeps = {
  /** いまの頼みの口と封の鍵。同期が無い、または Worker の版が足りなければ null。 */
  link(): { api: PeerLaunchApi; ring: () => Promise<PeerKeyring> } | null;
  /** Worker の版が足りるか（SyncParts.canCarryPeer）。 */
  workerOk(): boolean;
  /** SSH の予備。渡さなければ SSH は使わない。 */
  ssh?: PeerSshRouteDeps;
  now?: () => number;
  /** 頼みの ID の作り方。既定は randomUUID。 */
  newId?: () => string;
  /**
   * T9 の口。ほかのプロジェクトやクイックセッションを名指しされたとき、承認待ちの行を作って知らせる。
   * 渡さなければ approval-pending を返すだけで、何も作らない。
   */
  requestApproval?: (o: { requestId: string; to: string; toName: string; callerSessionId: string; projectId: string | null; scratch: boolean }) => void;
};

/** list_devices の 1 行の素。 */
export type PeerDeviceBrief = {
  device_id: string;
  name: string;
  platform: string;
  online: boolean;
  last_seen_at: number | null;
  via: PeerVia[];
  outdated: boolean;
  accounts: { name: string; agent: string; logged_in: boolean | null }[];
  agents: string[];
  hangar_version: string | null;
};

export const isOnline = (p: PeerDeviceStatus, now: number): boolean => p.last_seen_at !== null && now - p.last_seen_at <= PEER_ONLINE_MS;

/** 経路の判定に使う依存。 */
type RouteDeps = Pick<PeerCallDeps, 'link' | 'workerOk'> & Partial<Pick<PeerCallDeps, 'ssh'>>;

const cloudUsable = (p: PeerDeviceStatus, deps: RouteDeps): boolean => !p.outdated && deps.workerOk() && deps.link() !== null;

/**
 * SSH で送れるか（D3）。設定に登録があり、相手が同期でホスト鍵と宛先を知らせていて、手元に封と token の鍵がある。
 * 相手の様子の欄が無い（この機能より前の版）か、ホスト鍵が無ければ使わない。
 */
const sshUsable = (p: PeerDeviceStatus, deps: RouteDeps): boolean => {
  const s = deps.ssh;
  if (!s || !s.registered(p.device_id) || !s.tokensReady() || s.ring() === null) return false;
  const st = p.status;
  return !!st && !!st.ssh_host_key && st.lan_ips.length > 0;
};

/**
 * 相手へ送れる経路の一覧。list_devices の via で、choosePeerRoute の元でもある。
 * 様子の欄が無い PC（この機能より前の版）には、どの経路でも送れない。
 */
export function peerVias(p: PeerDeviceStatus, deps: RouteDeps): PeerVia[] {
  const out: PeerVia[] = [];
  if (cloudUsable(p, deps)) out.push('cloud');
  if (sshUsable(p, deps)) out.push('ssh');
  return out;
}

export function listPeerDevices(db: Db, selfId: string, deps: RouteDeps, now: number): PeerDeviceBrief[] {
  return readPeerStatuses(db, selfId).map((p) => ({
    device_id: p.device_id,
    name: p.name,
    platform: p.platform,
    online: isOnline(p, now),
    last_seen_at: p.last_seen_at,
    via: peerVias(p, deps),
    outdated: p.outdated,
    accounts: (p.status?.accounts ?? []).map((a) => ({ name: a.name, agent: a.agent, logged_in: a.logged_in })),
    agents: p.status?.agents ?? [],
    hangar_version: p.status?.hangar_version ?? null,
  }));
}

/** 名前か ID から相手を引く。名前は大文字小文字を区別せず、同じ名前が複数あるときは引かない。 */
export function resolvePeer(db: Db, selfId: string, key: string): PeerDeviceStatus | null {
  const all = readPeerStatuses(db, selfId);
  const byId = all.find((p) => p.device_id === key);
  if (byId) return byId;
  const lower = key.trim().toLowerCase();
  const byName = all.filter((p) => p.name.toLowerCase() === lower);
  return byName.length === 1 ? byName[0]! : null;
}

export type PeerRouteChoice =
  | { via: PeerVia; api: PeerLaunchApi; ring: () => Promise<PeerKeyring> }
  | { refuse: Extract<PeerCallRefusal, 'device-outdated' | 'device-offline'> };

/**
 * 送る前に経路を 1 つに決める（D1、D3）。送った後に乗り換えない。経路を選ぶのはここだけである。
 * - 両方の PC がクラウドに参加していて、Worker の版が足りて、相手が online なら cloud。
 * - それが使えず、SSH が使えれば ssh（クラウドの一覧で相手の行が古い、手元が未参加、Worker が古いなど）。
 *   SSH を選んだあとでトンネルが張れなければ、送らずに PeerSshConnectError で断る（クラウドへは乗り換えない）。
 * - どちらも使えなければ、版が古いか様子の欄が無ければ device-outdated、そうでなければ device-offline。
 * 選んだ経路（via）は、呼ぶ側が頼みごとに記録し（recordPeerRequest）、答えと結果の取得もその経路で行う。
 */
export function choosePeerRoute(peer: PeerDeviceStatus, deps: RouteDeps, now: number): PeerRouteChoice {
  if (cloudUsable(peer, deps) && isOnline(peer, now)) {
    const link = deps.link()!;
    return { via: 'cloud', api: link.api, ring: link.ring };
  }
  if (sshUsable(peer, deps)) {
    const s = deps.ssh!;
    return { via: 'ssh', api: s.api(peer.device_id), ring: s.ring()! };
  }
  if (peer.outdated || !deps.workerOk()) return { refuse: 'device-outdated' };
  return { refuse: 'device-offline' };
}
