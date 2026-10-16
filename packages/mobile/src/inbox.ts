import type { LiveStatus } from '@agent-hangar/shared/src/api.ts';
import { PEER_STALE_MS, type MobileFeed, type MobileInboxResponse, type MobileWaiting } from '@agent-hangar/shared/src/mobile.ts';
import { aadFeed, open } from '@agent-hangar/shared/src/mobileCrypto.ts';

/** 受信箱の 1 行。待っている会話、動いている会話、今日戻る会話、今日終わった会話の共通の形。 */
export type Row = {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  projectName: string;
  title: string;
  accountName: string | null;
  /** アカウントの色。#rgb〜#rrggbbaa の形だけを通し、それ以外は null（PC から来た値も信じない）。 */
  accountColor: string | null;
  /** live の状態。PC を 3 分見ていなければ unknown。戻る、終わったは returning、done。 */
  status: LiveStatus | 'unknown' | 'returning' | 'done';
  /** live なら statusAt、done なら doneAt。 */
  at: number | null;
  startedAt: number | null;
  waiting: MobileWaiting | null;
  intent: string | null;
  oneLiner: string | null;
  returnTime: string | null;
  rcUrl: string | null;
};

export type DeviceAlive = { id: string; name: string; lastSeenAt: number | null; alive: boolean };

export type InboxView = {
  waiting: Row[];
  running: Row[];
  returning: Row[];
  doneToday: Row[];
  devices: DeviceAlive[];
  /** 開けなかった PC の名前（秘密の作り直しの後など）。 */
  unreadable: string[];
  /** 開けた feed そのもの（新しい会話の画面が、PC ごとのプロジェクトとアカウントを読む）。 */
  feeds: MobileFeed[];
};

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** スマホの手元の日付（YYYY-MM-DD）。 */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Candidate = { row: Row; live: boolean; time: number; returnOn?: string };

/**
 * /m/inbox の応答を開いて、画面の節に分ける。
 *
 * - 開けない PC の分は unreadable に PC 名を入れ、ほかの PC は続ける。
 * - Worker が最後に見てから PEER_STALE_MS を過ぎた PC の live は、状態を unknown にして running の末尾へ置く（waiting に出さない）。
 *   見ていない時間は Worker の時刻（res.now）で測る。lastSeenAt も Worker の時刻なので、スマホの時計のずれに左右されない。
 * - 「今日」はスマホの日付。returns は returnOn が今日のもの、done は doneAt が今日のもの。
 * - 同じ sessionId が複数の PC から来たら、live を優先し、次に新しい時刻のもの（returns は時刻を持たないので最も古い扱い）。
 */
export async function openInbox(res: MobileInboxResponse, key: CryptoKey, now: Date): Promise<InboxView> {
  const workerNow = num(res.now) ?? now.getTime();
  const devices: DeviceAlive[] = arr(res.devices).map((d) => {
    const lastSeenAt = num(d.lastSeenAt);
    return { id: d.id, name: d.name, lastSeenAt, alive: lastSeenAt !== null && workerNow - lastSeenAt <= PEER_STALE_MS };
  });
  const byId = new Map(devices.map((d) => [d.id, d]));
  const today = localDay(now);

  const unreadable: string[] = [];
  const feeds: MobileFeed[] = [];
  const candidates = new Map<string, Candidate>();
  const offer = (c: Candidate): void => {
    const prev = candidates.get(c.row.sessionId);
    if (!prev || (c.live && !prev.live) || (c.live === prev.live && c.time > prev.time)) candidates.set(c.row.sessionId, c);
  };

  for (const f of arr(res.feeds)) {
    const device = byId.get(f.deviceId);
    let feed: MobileFeed;
    try {
      feed = await open<MobileFeed>(key, aadFeed(f.deviceId), f.sealed);
      if (!feed || typeof feed !== 'object' || feed.v !== 1 || feed.deviceId !== f.deviceId) throw new Error('feed の形が違います');
    } catch {
      unreadable.push(device?.name ?? f.deviceId);
      continue;
    }
    feeds.push(feed);
    const deviceName = device?.name ?? str(feed.deviceName);
    const alive = device?.alive ?? false;
    const accounts = new Map(arr(feed.accounts).map((a) => [a.id, a]));
    const base = (s: { sessionId: string; projectName: string; title: string }, accountId: string | null): Omit<Row, 'status' | 'at' | 'startedAt' | 'waiting' | 'intent' | 'oneLiner' | 'returnTime' | 'rcUrl'> => {
      const acc = accountId ? accounts.get(accountId) : undefined;
      return {
        sessionId: str(s.sessionId),
        deviceId: f.deviceId,
        deviceName,
        projectName: str(s.projectName),
        title: str(s.title),
        accountName: acc ? str(acc.name) || null : null,
        accountColor: acc && COLOR.test(str(acc.color)) ? acc.color : null,
      };
    };
    const empty = { waiting: null, intent: null, oneLiner: null, returnTime: null, rcUrl: null, startedAt: null };

    for (const l of arr(feed.live)) {
      if (!l || !str(l.sessionId)) continue;
      const statusAt = num(l.statusAt);
      const waiting = l.waiting && typeof l.waiting === 'object' ? { kind: l.waiting.kind, text: str(l.waiting.text) } : null;
      offer({
        live: true,
        time: statusAt ?? 0,
        row: {
          ...base(l, l.accountId),
          ...empty,
          status: alive ? l.status : 'unknown',
          at: statusAt,
          startedAt: num(l.startedAt),
          waiting,
          intent: strOrNull(l.intent),
          rcUrl: strOrNull(l.rcUrl),
        },
      });
    }
    for (const r of arr(feed.returns)) {
      if (!r || !str(r.sessionId)) continue;
      offer({ live: false, time: -Infinity, returnOn: str(r.returnOn), row: { ...base(r, r.accountId), ...empty, status: 'returning', at: null, returnTime: strOrNull(r.returnTime) } });
    }
    for (const d of arr(feed.done)) {
      if (!d || !str(d.sessionId)) continue;
      const doneAt = num(d.doneAt);
      offer({ live: false, time: doneAt ?? -Infinity, row: { ...base(d, null), ...empty, status: 'done', at: doneAt, oneLiner: strOrNull(d.oneLiner) } });
    }
  }

  const chosen = [...candidates.values()];
  const rows = chosen.map((c) => c.row);
  const waiting = rows.filter((r) => r.status === 'waiting').sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId));
  const byStart = (a: Row, b: Row): number => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId);
  const running = [
    ...rows.filter((r) => r.status === 'busy' || r.status === 'idle').sort(byStart),
    ...rows.filter((r) => r.status === 'unknown').sort(byStart),
  ];
  const returning = chosen
    .filter((c) => c.row.status === 'returning' && c.returnOn === today)
    .map((c) => c.row)
    .sort((a, b) => (a.returnTime ?? '99:99').localeCompare(b.returnTime ?? '99:99') || a.sessionId.localeCompare(b.sessionId));
  const doneToday = rows
    .filter((r) => r.status === 'done' && r.at !== null && localDay(new Date(r.at)) === today)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.sessionId.localeCompare(b.sessionId));

  return { waiting, running, returning, doneToday, devices, unreadable, feeds };
}
