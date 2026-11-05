import type { PeerDeviceStatus, PeerKeyring, PeerLaunchApi } from '@agent-hangar/shared';
import { readPeerStatuses } from '../config/deviceStatus.ts';
import type { Db } from '../db/open.ts';

/**
 * 呼ぶ側（T8）。別の PC へ起こす前の、相手の引き当てと経路の決め方。
 *
 * online の判定は、相手の devices.last_seen_at が PEER_ONLINE_MS 以内かどうかである。
 * last_seen_at は各 PC が 10 分ごとに書いて同期に載るので、その 1.5 倍を鮮度の上限にする。
 * 呼び鈴のつながりは相手の側にあるので、こちらからは見えない。
 */
export const PEER_ONLINE_MS = 15 * 60_000;

/** 経路。cloud は Worker 経由、ssh は予備（T11 が足す）。 */
export type PeerVia = 'cloud' | 'ssh';

/** 送る前に決まる断りの理由（頼みを置く前に呼ぶ側が決めるもの）。 */
export const PEER_CALL_REFUSALS = ['device-unknown', 'device-outdated', 'device-offline', 'depth-exceeded'] as const;
export type PeerCallRefusal = (typeof PEER_CALL_REFUSALS)[number];

/** 呼ぶ側の依存。MCP の道具（mcp/peerTools.ts）が使う。 */
export type PeerCallDeps = {
  /** いまの頼みの口と封の鍵。同期が無い、または Worker の版が足りなければ null。 */
  link(): { api: PeerLaunchApi; ring: () => Promise<PeerKeyring> } | null;
  /** Worker の版が足りるか（SyncParts.canCarryPeer）。 */
  workerOk(): boolean;
  now?: () => number;
  /**
   * この hangar の版。send と stop の頼み（op を読む版にだけ送れる）は、相手の hangar_version がこれ以上のときだけ送る（D16）。
   * 渡さなければ版では断らない。
   */
  version?: string;
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

/**
 * 相手へ送れる経路の一覧。list_devices の via で、choosePeerRoute の元でもある。
 * 様子の欄が無い PC（この機能より前の版）には、どの経路でも送れない。
 * T11 は、ここに ssh の登録を足す。
 */
export function peerVias(p: PeerDeviceStatus, deps: Pick<PeerCallDeps, 'link' | 'workerOk'>): PeerVia[] {
  const out: PeerVia[] = [];
  if (!p.outdated && deps.workerOk() && deps.link() !== null) out.push('cloud');
  return out;
}

export function listPeerDevices(db: Db, selfId: string, deps: Pick<PeerCallDeps, 'link' | 'workerOk'>, now: number): PeerDeviceBrief[] {
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

export type PeerRouteChoice = { via: 'cloud'; api: PeerLaunchApi; ring: () => Promise<PeerKeyring> } | { refuse: Extract<PeerCallRefusal, 'device-outdated' | 'device-offline'> };

/**
 * 送る前に経路を 1 つに決める（D1）。送った後に乗り換えない。
 * 経路を選ぶのはここだけで、T11 が ssh を足すときもこの関数に足す。
 * 版が古いか様子の欄が無ければ device-outdated、last_seen_at が古い、または使える口が無ければ device-offline。
 */
export function choosePeerRoute(peer: PeerDeviceStatus, deps: Pick<PeerCallDeps, 'link' | 'workerOk'>, now: number): PeerRouteChoice {
  if (peer.outdated || !deps.workerOk()) return { refuse: 'device-outdated' };
  if (!isOnline(peer, now)) return { refuse: 'device-offline' };
  const link = deps.link();
  if (!link) return { refuse: 'device-offline' };
  return { via: 'cloud', api: link.api, ring: link.ring };
}
