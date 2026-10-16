import type { LiveStatus, WaitKind } from './api.ts';

/** 文は 300 字で切る（待っている内容、意図、要約の 1 行）。 */
export const MOBILE_TEXT_MAX = 300;
/** 受信箱の素（暗号化の前の JSON）の上限。超えたら done、returns、projects の順に古いものから落とす。 */
export const MOBILE_FEED_MAX_BYTES = 48 * 1024;
/** 起動の依頼の有効期間。Worker はこれを過ぎた依頼を claim させない。PC の pull は 30 秒ごとなので 2 周分の余裕を見る。 */
export const LAUNCH_TTL_MS = 75_000;
/** Worker が最後に見てからこの時間を過ぎた PC は「不明」。 */
export const PEER_STALE_MS = 180_000;

export type MobileWaiting = { kind: WaitKind; text: string };

export type MobileLiveItem = {
  sessionId: string;
  projectId: string | null;
  projectName: string;
  title: string;
  accountId: string;
  status: LiveStatus;
  statusAt: number;
  startedAt: number;
  waiting: MobileWaiting | null;
  intent: string | null;
  rcUrl: string | null;
};

export type MobileReturnItem = { sessionId: string; projectName: string; title: string; accountId: string; returnOn: string; returnTime: string | null };
export type MobileDoneItem = { sessionId: string; projectName: string; title: string; oneLiner: string | null; doneAt: number };
export type MobileAccount = { id: string; name: string; color: string; fiveHour: number | null; sevenDay: number | null };
export type MobileProject = { id: string; name: string; lastUsedAt: number | null };

/** 1 台の PC が Worker に預ける受信箱の素。暗号化して置くので、Worker は中身を読めない。 */
export type MobileFeed = {
  v: 1;
  deviceId: string;
  deviceName: string;
  accounts: MobileAccount[];
  projects: MobileProject[];
  live: MobileLiveItem[];
  returns: MobileReturnItem[];
  done: MobileDoneItem[];
};

/** スマホから PC への起動の依頼（暗号化して運ぶ）。scratch が true のとき projectId は null（「すぐ始める」）。 */
export type MobileLaunchPayload = {
  v: 1;
  createdAt: number;
  projectId: string | null;
  scratch: boolean;
  accountId: string;
  permissionMode: string;
  model: string;
  prompt: string;
};

export type MobileLaunchAnswer =
  | { ok: true; sessionId: string; title: string }
  | { ok: false; reason: 'project-missing' | 'account-missing' | 'bad-payload' | 'expired' | 'launch-failed'; detail?: string };

/** Worker の口の型。 */
export type MobilePairingResponse = { code: string; expiresAt: number };
export type MobileJoinRequest = { code: string; device: { id: string; name: string } };
export type MobileJoinResponse = { token: string; deviceId: string };
export type MobileInboxResponse = {
  now: number;
  devices: { id: string; name: string; platform: string; lastSeenAt: number | null }[];
  feeds: { deviceId: string; updatedAt: number; sealed: string }[];
};
export type MobileLaunchIn = { id: string; targetDevice: string; sealed: string };
export type MobileLaunchOut = { id: string; createdAt: number; sealed: string };
export type MobileLaunchStatus = { id: string; status: 'pending' | 'claimed' | 'started' | 'failed' | 'expired'; sealedAnswer: string | null };

/**
 * 文を max 字で切り、切ったときは末尾に … を付ける。前後の空白は落とす。
 * null、undefined、空（空白だけ）は null。サロゲートペアは割らない。
 */
export function clampText(s: string | null | undefined, max: number = MOBILE_TEXT_MAX): string | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  let end = max;
  const c = t.charCodeAt(end - 1);
  if (end > 0 && c >= 0xd800 && c <= 0xdbff) end -= 1;
  return t.slice(0, end) + '…';
}

const sizeOf = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * 受信箱の素を上限に収める。超えたら done、returns、projects の順に、古いものから 1 件ずつ落とす。live は落とさない。
 * done は doneAt が小さいもの、returns は戻る日時が早いもの、projects は lastUsedAt が小さいもの（無いものが最も古い）が古い。
 * 元の feed は変えず、残したものの並びも変えない。
 */
export function fitFeed(feed: MobileFeed, maxBytes: number = MOBILE_FEED_MAX_BYTES): MobileFeed {
  if (sizeOf(feed) <= maxBytes) return feed;
  let out = feed;
  const trim = <K extends 'done' | 'returns' | 'projects'>(key: K, oldestFirst: (a: MobileFeed[K][number], b: MobileFeed[K][number]) => number): void => {
    const list = out[key] as MobileFeed[K][number][];
    const order = list.map((_, i) => i).sort((a, b) => oldestFirst(list[a]!, list[b]!) || a - b);
    for (let n = 1; n <= order.length && sizeOf(out) > maxBytes; n++) {
      const drop = new Set(order.slice(0, n));
      out = { ...feed, ...out, [key]: list.filter((_, i) => !drop.has(i)) };
    }
  };
  trim('done', (a, b) => a.doneAt - b.doneAt);
  trim('returns', (a, b) => (a.returnOn + ' ' + (a.returnTime ?? '')).localeCompare(b.returnOn + ' ' + (b.returnTime ?? '')));
  trim('projects', (a, b) => (a.lastUsedAt ?? -Infinity) - (b.lastUsedAt ?? -Infinity));
  return out;
}
