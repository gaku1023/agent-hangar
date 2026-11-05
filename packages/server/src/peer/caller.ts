import type { PeerDeviceStatus, PeerKeyring, PeerLaunchApi, PeerLaunchRequest } from '@agent-hangar/shared';
import { readPeerStatuses } from '../config/deviceStatus.ts';
import type { Db } from '../db/open.ts';
import { PEER_SSH_ENABLED } from './ssh/enabled.ts';

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
  /**
   * この hangar の版。send と stop の頼み（op を読む版にだけ送れる）は、相手の hangar_version がこれ以上のときだけ送る（D16）。
   * 渡さなければ版では断らない。
   */
  version?: string;
  /** 頼みの ID の作り方。既定は randomUUID。 */
  newId?: () => string;
  /**
   * ほかのプロジェクトやクイックセッションを名指しされたとき、承認待ちの行を作って利用者に知らせる（peer/approvals.ts）。
   * request は封じる前の頼みの中身で、承認されたら封じて置く。渡さなければ approval-pending を返すだけで、何も作らない。
   * 積めなければ false を返す（呼び出し元には launch-failed の入力が入る）。
   */
  requestApproval?: (o: { requestId: string; to: string; toName: string; callerSessionId: string; projectId: string | null; scratch: boolean; request: PeerLaunchRequest }) => boolean | void;
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
 * どちらかの PC がクラウドに未参加か（D3）。SSH に落としてよいのは、このときだけである。
 * 相手は様子の欄が無い（クラウドの一覧に載っていない同然）、手元は Worker の版が足りているのに頼みの口が無い、のどちらか。
 * 両方参加していて相手が online でない、または Worker の版が足りないときは、SSH に落とさない。
 */
const cloudUnjoined = (p: PeerDeviceStatus, deps: RouteDeps): boolean => p.outdated || (deps.workerOk() && deps.link() === null);

/**
 * SSH で送れるか（D3）。設定に登録があり、相手が同期でホスト鍵と宛先を知らせていて、手元に封と token の鍵がある。
 * 相手の様子の欄が無い（この機能より前の版）か、ホスト鍵が無ければ使わない。
 */
const sshUsable = (p: PeerDeviceStatus, deps: RouteDeps): boolean => {
  const s = deps.ssh;
  if (!PEER_SSH_ENABLED || !s || !s.registered(p.device_id) || !s.tokensReady() || s.ring() === null) return false;
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
  if (cloudUnjoined(p, deps) && sshUsable(p, deps)) out.push('ssh');
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
 * - 両方の PC がクラウドに参加しているなら、クラウドだけを使う。相手が online なら cloud、そうでなければ device-offline（SSH に落とさない）。
 *   Worker の版が足りなければ device-outdated（SSH に落とさない）。
 * - どちらかが未参加（手元に頼みの口が無い、相手の様子の欄が無い）で、SSH が使えれば ssh。
 *   SSH を選んだあとでトンネルが張れなければ、送らずに PeerSshConnectError で断る（クラウドへは乗り換えない）。
 * - どちらも使えなければ、版が古いか様子の欄が無ければ device-outdated、そうでなければ device-offline。
 * 選んだ経路（via）は、呼ぶ側が頼みごとに記録し（recordPeerRequest）、答えと結果の取得もその経路で行う。
 */
export function choosePeerRoute(peer: PeerDeviceStatus, deps: RouteDeps, now: number): PeerRouteChoice {
  if (!cloudUnjoined(peer, deps)) {
    if (!deps.workerOk()) return { refuse: 'device-outdated' };
    const link = deps.link();
    if (!link || !isOnline(peer, now)) return { refuse: 'device-offline' };
    return { via: 'cloud', api: link.api, ring: link.ring };
  }
  if (sshUsable(peer, deps)) {
    const s = deps.ssh!;
    return { via: 'ssh', api: s.api(peer.device_id), ring: s.ring()! };
  }
  if (peer.outdated || !deps.workerOk()) return { refuse: 'device-outdated' };
  return { refuse: 'device-offline' };
}
