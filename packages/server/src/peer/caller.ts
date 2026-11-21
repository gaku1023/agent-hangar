import { PEER_LAUNCH_MIN_WORKER_COMPAT, type PeerDeviceStatus, type PeerKeyring, type PeerLaunchApi, type PeerLaunchRequest } from '@agent-hangar/shared';
import { msg, type Message } from '../i18n/message.ts';
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

/** 経路。Worker 経由のクラウドだけである。 */
export type PeerVia = 'cloud';

/**
 * 送る前に決まる断りの理由（頼みを置く前に呼ぶ側が決めるもの）。
 * device-outdated は相手の hangar が古い、worker-outdated はクラウドの Worker の互換値が足りない（PEER_CHAT_VIEW_REFUSALS と同じ名前と考え方）。
 */
export const PEER_CALL_REFUSALS = ['device-unknown', 'device-outdated', 'worker-outdated', 'device-offline', 'depth-exceeded'] as const;
export type PeerCallRefusal = (typeof PEER_CALL_REFUSALS)[number];

/** 呼ぶ側の依存。MCP の道具（mcp/peerTools.ts）が使う。 */
export type PeerCallDeps = {
  /** いまの頼みの口と封の鍵。同期が無い、または Worker の版が足りなければ null。 */
  link(): { api: PeerLaunchApi; ring: () => Promise<PeerKeyring> } | null;
  /** Worker の版が足りるか（SyncParts.canCarryPeer）。 */
  workerOk(): boolean;
  /** Worker が名乗った互換値。まだ話していない、または同期が無ければ null。断りの文に添える（無くても断れる）。 */
  workerCompat?(): number | null;
  /** この PC が Worker を setup した PC か（cloud.json に Worker の名前がある）。worker-outdated の断りの fix を決める。渡さなければ違うとみなす。 */
  creator?(): boolean;
  now?: () => number;
  /**
   * この hangar の版。send と stop の頼み（op を読む版にだけ送れる）は、相手の hangar_version がこれ以上のときだけ送る（D16）。
   * 渡さなければ版では断らない。
   */
  version?: string;
  /** 頼みの ID の作り方。既定は randomUUID。 */
  newId?: () => string;
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
type RouteDeps = Pick<PeerCallDeps, 'link' | 'workerOk' | 'workerCompat'>;

const cloudUsable = (p: PeerDeviceStatus, deps: RouteDeps): boolean => !p.outdated && deps.workerOk() && deps.link() !== null;

/**
 * 相手へ送れる経路の一覧。list_devices の via で、choosePeerRoute の元でもある。
 * 様子の欄が無い PC（この機能より前の版）には、どの経路でも送れない。
 */
export function peerVias(p: PeerDeviceStatus, deps: RouteDeps): PeerVia[] {
  const out: PeerVia[] = [];
  if (cloudUsable(p, deps)) out.push('cloud');
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
  | { refuse: Extract<PeerCallRefusal, 'device-outdated' | 'worker-outdated' | 'device-offline'> };

/**
 * 送る前に経路を決める（D1）。経路はクラウドだけである。
 * - Worker の版が足りないときは worker-outdated。相手の版が古い（様子の欄が無い）ときは device-outdated。
 *   両方のときは Worker を先に言う（Worker を直さない限り何も送れないため）。
 * - 手元に頼みの口が無い、または相手が online でなければ device-offline。
 * 選んだ経路（via）は、呼ぶ側が頼みごとに記録し（recordPeerRequest）、答えと結果の取得もその経路で行う。
 */
export function choosePeerRoute(peer: PeerDeviceStatus, deps: RouteDeps, now: number): PeerRouteChoice {
  if (!deps.workerOk()) return { refuse: 'worker-outdated' };
  if (peer.outdated) return { refuse: 'device-outdated' };
  const link = deps.link();
  if (!link || !isOnline(peer, now)) return { refuse: 'device-offline' };
  return { via: 'cloud', api: link.api, ring: link.ring };
}

/**
 * 断りの理由に対応する文。device は相手の名前。
 * worker-outdated は、Worker の互換値が手に入り、必要な値に届いていないときだけ括弧つきの文にする（同期の停止などで偽のときは括弧を省く）。
 */
export function peerRefusalMessage(reason: Extract<PeerCallRefusal, 'device-outdated' | 'worker-outdated' | 'device-offline'>, device: string, deps: Pick<PeerCallDeps, 'workerCompat'>): Message {
  if (reason === 'device-outdated') return msg('mcp.device.outdated', { device });
  if (reason === 'device-offline') return msg('mcp.device.offline', { device });
  const have = deps.workerCompat?.() ?? null;
  return have !== null && have > 0 && have < PEER_LAUNCH_MIN_WORKER_COMPAT
    ? msg('mcp.device.workerOutdated', { have, need: PEER_LAUNCH_MIN_WORKER_COMPAT })
    : msg('mcp.device.workerOutdatedUnknown');
}
