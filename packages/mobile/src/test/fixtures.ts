import { aadFeed, importMobileKey, seal, type MobileFeed, type MobileInboxResponse, type MobileLiveItem } from '@agent-hangar/shared';

/** 試験の「いま」。スマホの日付で 2026-10-17 の 15 時（手元の時間帯）。 */
export const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();
export const MIN = 60_000;

export const randomKeyBytes = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32));
export const makeKey = (bytes: Uint8Array = randomKeyBytes()): Promise<CryptoKey> => importMobileKey(bytes, false);

export function liveItem(p: Partial<MobileLiveItem> & { sessionId: string }): MobileLiveItem {
  return {
    projectId: 'p-a',
    projectName: 'project-a',
    title: `会話 ${p.sessionId}`,
    accountId: 'acc-1',
    status: 'busy',
    statusAt: NOW - 10 * MIN,
    startedAt: NOW - 40 * MIN,
    waiting: null,
    intent: null,
    rcUrl: null,
    ...p,
  };
}

export function feedOf(deviceId: string, deviceName: string, parts: Partial<MobileFeed> = {}): MobileFeed {
  return {
    v: 1,
    deviceId,
    deviceName,
    accounts: [{ id: 'acc-1', name: 'アカウント 1', color: '#4a63e8', fiveHour: 32, sevenDay: 10 }],
    projects: [{ id: 'p-a', name: 'project-a', lastUsedAt: NOW - 60 * MIN }],
    live: [],
    returns: [],
    done: [],
    ...parts,
  };
}

/** feed を key で封じて /m/inbox の応答の形にする。sealedFor に deviceId を渡すと、その PC の分は別の鍵で封じる（開けない）。 */
export async function inboxOf(
  key: CryptoKey,
  feeds: MobileFeed[],
  opts: { now?: number; lastSeen?: Record<string, number | null>; otherKeyFor?: string[]; updatedAt?: Record<string, number> } = {},
): Promise<MobileInboxResponse> {
  const now = opts.now ?? NOW;
  const other = await makeKey();
  const sealed = await Promise.all(
    feeds.map(async (f) => ({
      deviceId: f.deviceId,
      updatedAt: opts.updatedAt?.[f.deviceId] ?? now - MIN,
      sealed: await seal(opts.otherKeyFor?.includes(f.deviceId) ? other : key, aadFeed(f.deviceId), f),
    })),
  );
  return {
    now,
    devices: feeds.map((f) => ({ id: f.deviceId, name: f.deviceName, platform: 'darwin', lastSeenAt: opts.lastSeen && f.deviceId in opts.lastSeen ? opts.lastSeen[f.deviceId]! : now - MIN })),
    feeds: sealed,
  };
}
