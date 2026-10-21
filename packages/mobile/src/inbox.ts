import type { LiveStatus } from '@agent-hangar/shared/src/api.ts';
import { PEER_STALE_MS, type MobileFeed, type MobileInboxResponse, type MobileWaiting } from '@agent-hangar/shared/src/mobile.ts';
import { aadFeed, open } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { fetchInbox, type InboxFetched } from './api.ts';
import { newestEpoch, type Keyring, type Pairing } from './store.ts';

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
  /** 戻る日（YYYY-MM-DD）。returning の行だけが持つ。 */
  returnOn: string | null;
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
  /** Worker の時刻からスマホの時刻を引いた差（ms）。待った時間や何分前は、スマホの時刻にこれを足して測る。 */
  skewMs: number;
  /** 受信箱の応答の見出しから読んだ Worker の版。分からなければ null（古いとはみなさない）。 */
  workerCompat?: number | null;
};

/**
 * 更新がこれより古い feed は出さない。解除せずに去った PC の素を、「不明」のまま出し続けないためである。
 * 動いている PC は、中身が変わらなくても 1 日に 1 回は書き直す（packages/server の mobile/publisher.ts の FEED_REFRESH_MS）。
 * 同じ長さより前に最後に見た PC は、生存の行にも出さない。
 */
export const FEED_HIDE_AFTER_MS = 7 * 24 * 60 * 60_000;

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** スマホの手元の日付（YYYY-MM-DD）。 */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Candidate = { row: Row; live: boolean; time: number };

/**
 * 名前が分からない PC の代わりの表記。ID の先頭 4 文字を添える（例：PC 3f9c）。
 * ID をまるごと出すと、受信箱の行が横にはみ出す。
 */
export function shortPcName(id: string): string {
  const head = str(id).trim().slice(0, 4);
  return head ? `PC ${head}` : 'PC';
}

/** Worker が返す PC の名前。いまの Worker は名前を持たず ID を入れて返すので、ID と同じなら名前として使わない。 */
const workerName = (d: { id: string; name: string }): string => {
  const n = str(d.name).trim();
  return n && n !== d.id ? n : '';
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * /m/inbox の応答を開いて、画面の節に分ける。
 *
 * - 更新が FEED_HIDE_AFTER_MS より古い feed は開かずに捨てる（unreadable にも入れない）。最後に見たのがそれより前の PC は devices に入れない。
 * - 開けない PC の分は unreadable に PC 名を入れ、ほかの PC は続ける。
 * - PC の名前は、開けた feed の deviceName から取る（Worker は名前を持たず、name に ID を入れて返す）。
 *   feed を開けない PC や名前が空の PC は、ID をそのまま出さず shortPcName の表記にする。行の deviceName も devices の name も同じ。
 * - Worker が最後に見てから PEER_STALE_MS を過ぎた PC の live は、状態を unknown にして running の末尾へ置く（waiting に出さない）。
 *   見ていない時間は Worker の時刻（res.now）で測る。lastSeenAt も Worker の時刻なので、スマホの時計のずれに左右されない。
 * - 「今日」はスマホの日付。returns は returnOn が今日か、過ぎた日のもの（戻り忘れも出す）。done は doneAt が今日のもの。
 * - skewMs に Worker とスマホの時計の差を持つ。PC の時刻（statusAt、startedAt）との差は、これで直したスマホの時刻で測る。
 * - 同じ sessionId が複数の PC から来たら、live を優先し、次に新しい時刻のもの（returns は時刻を持たないので最も古い扱い）。
 */
export async function openInbox(res: MobileInboxResponse & { workerCompat?: number | null }, keys: Keyring, now: Date): Promise<InboxView> {
  const workerNow = num(res.now) ?? now.getTime();
  let devices: DeviceAlive[] = arr(res.devices)
    .map((d) => {
      const lastSeenAt = num(d.lastSeenAt);
      return { id: d.id, name: workerName(d), lastSeenAt, alive: lastSeenAt !== null && workerNow - lastSeenAt <= PEER_STALE_MS };
    })
    .filter((d) => d.lastSeenAt === null || workerNow - d.lastSeenAt <= FEED_HIDE_AFTER_MS);
  const byId = new Map(devices.map((d) => [d.id, d]));
  const today = localDay(now);

  const unreadable: string[] = [];
  const feeds: MobileFeed[] = [];
  const feedNames = new Map<string, string>();
  const candidates = new Map<string, Candidate>();
  const offer = (c: Candidate): void => {
    const prev = candidates.get(c.row.sessionId);
    if (!prev || (c.live && !prev.live) || (c.live === prev.live && c.time > prev.time)) candidates.set(c.row.sessionId, c);
  };

  for (const f of arr(res.feeds)) {
    const updatedAt = num(f.updatedAt);
    if (updatedAt !== null && workerNow - updatedAt > FEED_HIDE_AFTER_MS) continue;
    const device = byId.get(f.deviceId);
    let feed: MobileFeed;
    try {
      // 素は、封じたスマホ用の鍵の世代（epoch）の鍵で開く。手元に無い世代なら開けない PC に入れる。
      const key = keys.get(Number(f.epoch));
      if (!key) throw new Error('この世代の鍵がありません');
      feed = await open<MobileFeed>(key, aadFeed(f.deviceId), f.sealed);
      if (!feed || typeof feed !== 'object' || feed.v !== 1 || feed.deviceId !== f.deviceId) throw new Error('feed の形が違います');
    } catch {
      unreadable.push(device?.name || shortPcName(f.deviceId));
      continue;
    }
    feeds.push(feed);
    const deviceName = str(feed.deviceName).trim() || device?.name || shortPcName(f.deviceId);
    feedNames.set(f.deviceId, deviceName);
    const alive = device?.alive ?? false;
    const accounts = new Map(arr(feed.accounts).map((a) => [a.id, a]));
    const base = (s: { sessionId: string; projectName: string; title: string }, accountId: string | null): Omit<Row, 'status' | 'at' | 'startedAt' | 'waiting' | 'intent' | 'oneLiner' | 'returnOn' | 'returnTime' | 'rcUrl'> => {
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
    const empty = { waiting: null, intent: null, oneLiner: null, returnOn: null, returnTime: null, rcUrl: null, startedAt: null };

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
      offer({ live: false, time: -Infinity, row: { ...base(r, r.accountId), ...empty, status: 'returning', at: null, returnOn: str(r.returnOn) || null, returnTime: strOrNull(r.returnTime) } });
    }
    for (const d of arr(feed.done)) {
      if (!d || !str(d.sessionId)) continue;
      const doneAt = num(d.doneAt);
      offer({ live: false, time: doneAt ?? -Infinity, row: { ...base(d, null), ...empty, status: 'done', at: doneAt, oneLiner: strOrNull(d.oneLiner) } });
    }
  }

  devices = devices.map((d) => ({ ...d, name: feedNames.get(d.id) || d.name || shortPcName(d.id) }));

  const rows = [...candidates.values()].map((c) => c.row);
  const waiting = rows.filter((r) => r.status === 'waiting').sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sessionId.localeCompare(b.sessionId));
  const byStart = (a: Row, b: Row): number => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId);
  const running = [
    ...rows.filter((r) => r.status === 'busy' || r.status === 'idle').sort(byStart),
    ...rows.filter((r) => r.status === 'unknown').sort(byStart),
  ];
  // 過ぎた日のもの（戻り忘れ）を先に、同じ日の中は時刻の順（時刻の無いものは後ろ）。
  const returning = rows
    .filter((r) => r.status === 'returning' && r.returnOn !== null && DAY.test(r.returnOn) && r.returnOn <= today)
    .sort((a, b) => a.returnOn!.localeCompare(b.returnOn!) || (a.returnTime ?? '99:99').localeCompare(b.returnTime ?? '99:99') || a.sessionId.localeCompare(b.sessionId));
  const doneToday = rows
    .filter((r) => r.status === 'done' && r.at !== null && localDay(new Date(r.at)) === today)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.sessionId.localeCompare(b.sessionId));

  const skewMs = num(res.now) !== null ? workerNow - now.getTime() : 0;
  return { waiting, running, returning, doneToday, devices, unreadable, feeds, skewMs, workerCompat: res.workerCompat ?? null };
}

/** 受信箱の素のうち、いちばん新しい世代。素が無ければ 0。 */
function newestFeedEpoch(res: MobileInboxResponse): number {
  let n = 0;
  for (const f of arr(res.feeds)) {
    const e = num(f?.epoch);
    if (e !== null && e > n) n = e;
  }
  return n;
}

/**
 * 受信箱を読んで開く。
 * 素の世代が手元のいちばん新しい世代より新しければ（PC がスマホを解除して M を次の世代にした）、reloadKeys で keybox を読み直してから開く。
 * 読み直しても無い世代の素は、開けない PC に入れて続ける。戻りの keys は開くのに使った手元の鍵。
 */
export async function readInbox(
  p: Pairing,
  keys: Keyring,
  o: { reloadKeys: () => Promise<Keyring>; now?: Date; fetch?: (p: Pairing) => Promise<InboxFetched> },
): Promise<{ view: InboxView; keys: Keyring }> {
  const res = await (o.fetch ?? fetchInbox)(p);
  let ring = keys;
  if (newestFeedEpoch(res) > newestEpoch(ring)) ring = await o.reloadKeys();
  return { view: await openInbox(res, ring, o.now ?? new Date()), keys: ring };
}
