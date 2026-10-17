import type { MobileAccount, MobileFeed, MobileLaunchAnswer, MobileLaunchPayload, MobileProject } from '@agent-hangar/shared/src/mobile.ts';
import { aadAnswer, aadLaunch, open, seal } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { getLaunch, LaunchError, postLaunch } from './api.ts';
import type { Pairing } from './store.ts';

export type LaunchProject = MobileProject & { deviceIds: string[] };

export type LaunchChoices = {
  /** 全 PC のプロジェクトの和。最近使った順。場所を持ち生きている PC が 1 台も無いものは出さない。 */
  projects: LaunchProject[];
  /** 「すぐ始める（フォルダなし）」を受けられる PC。生きている PC ならどれでもよい。 */
  scratchDeviceIds: string[];
  /** その PC のアカウント。知らない PC なら空。 */
  accountsOf: (deviceId: string) => MobileAccount[];
};

const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const newer = (a: number | null, b: number | null): boolean => (a ?? -Infinity) > (b ?? -Infinity);

/**
 * 新しい会話の画面で選べるもの。
 * 起動の依頼を受けられるのは feed を出す PC（v0.8 以降）だけなので、feed のある PC から選ぶ。
 * alive は Worker が最後に見てから PEER_STALE_MS 以内の PC（受信箱と同じ基準）。
 * 同じ id のプロジェクトは、新しく使った方の名前と時刻にする。
 */
export function launchChoices(feeds: MobileFeed[], alive: Set<string>): LaunchChoices {
  const live = feeds.filter((f) => alive.has(f.deviceId));
  const byId = new Map<string, LaunchProject>();
  for (const f of live) {
    for (const p of arr(f.projects)) {
      if (!p || typeof p.id !== 'string' || !p.id) continue;
      const prev = byId.get(p.id);
      if (!prev) {
        byId.set(p.id, { id: p.id, name: typeof p.name === 'string' ? p.name : '', lastUsedAt: p.lastUsedAt ?? null, deviceIds: [f.deviceId] });
        continue;
      }
      if (!prev.deviceIds.includes(f.deviceId)) prev.deviceIds.push(f.deviceId);
      if (newer(p.lastUsedAt, prev.lastUsedAt)) {
        prev.lastUsedAt = p.lastUsedAt;
        if (typeof p.name === 'string') prev.name = p.name;
      }
    }
  }
  const projects = [...byId.values()].sort((a, b) => (b.lastUsedAt ?? -Infinity) - (a.lastUsedAt ?? -Infinity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const accounts = new Map(live.map((f) => [f.deviceId, arr(f.accounts)]));
  return { projects, scratchDeviceIds: live.map((f) => f.deviceId), accountsOf: (deviceId) => accounts.get(deviceId) ?? [] };
}

/**
 * 起動の依頼を封じて Worker に置き、依頼の id を返す。
 * 中身は aadLaunch(id, targetDevice) で封じるので、Worker が宛先を付け替えても PC は開けない。
 * createdAt は Worker の時刻に寄せる（skewMs、受信箱の InboxView.skewMs）。PC はこれで古すぎる依頼を断る。
 * 通信が切れたら同じ id で 1 度だけ送り直す（Worker は同じ id の再送で行を増やさない）。
 * id を渡すと、その id で送る。届いたか分からないまま失敗した依頼を、同じ中身で送り直すときに使う。
 * 前の依頼が Worker に置けていれば、Worker は行を増やさず前の行の状態を返し、PC も同じ id を二度起こさない。
 * 封は毎回作り直すので、前の依頼が置けていなかったときは新しい createdAt で置かれる。
 */
export async function requestLaunch(
  p: Pairing,
  key: CryptoKey,
  o: { targetDevice: string; payload: Omit<MobileLaunchPayload, 'v' | 'createdAt'>; skewMs?: number; id?: string },
): Promise<string> {
  const id = o.id ?? globalThis.crypto.randomUUID();
  const payload: MobileLaunchPayload = { v: 1, createdAt: Date.now() + (o.skewMs ?? 0), ...o.payload };
  const sealed = await seal(key, aadLaunch(id, o.targetDevice), payload);
  // epoch は封じたスマホ用の鍵の世代（互換の版 9）。スマホの鍵ペアと keybox（Task 23）が入るまでは鍵が 1 つだけなので 1 である。
  const body = { id, targetDevice: o.targetDevice, sealed, epoch: 1 };
  try {
    await postLaunch(p, body);
  } catch (e) {
    if (!(e instanceof LaunchError) || e.reason !== 'network') throw e;
    await postLaunch(p, body);
  }
  return id;
}

/**
 * 依頼の行き着いた先。
 * - unreadable：PC の答えが無いか、開けないか、Worker の状態と食い違う。始まったかどうかをスマホは言えない。
 * - unpaired：このスマホの接続が外された（401）。
 * - unanswered：PC は受け取った（claimed を見た）が、諦めるまでに答えが届かなかった。会話が始まっているかもしれない。
 */
export type LaunchStage = 'waiting' | 'started' | 'failed' | 'expired' | 'unreadable' | 'unpaired' | 'unanswered';

/** 既定の読み直しの間隔と、諦めるまでの長さ（LAUNCH_TTL_MS の 75 秒に少し足す）。 */
/** 呼び鈴で数秒のうちに答えが来るので 2 秒ごとに読む。 */
export const LAUNCH_POLL_MS = 2_000;
export const LAUNCH_GIVE_UP_MS = 80_000;

/**
 * 依頼の状態を everyMs ごとに読み、決まるまで待つ。戻り値で待つのをやめる。
 * - 始めは waiting。pending と claimed の間は waiting のまま。
 * - 答えは sealedAnswer を aadAnswer(id) で開いたもの。
 * - started は ok:true の答えを開けたときだけ。ok:false の答えなら failed として答えを渡す。
 * - failed は ok:false の答えを添える。ok:true の答えは食い違いなので unreadable。
 * - 答えが無い、開けないときは、started でも failed でも unreadable。
 * - PC が受け取った（claimed を最初に見た）ときに onClaimed を 1 度呼ぶ。
 * - Worker が expired と言うか、giveUpMs を過ぎたら expired。ただし claimed を一度でも見た後に giveUpMs を過ぎたら unanswered（PC は受け取っている）。
 * - 通信の失敗は待ち続ける。依頼が見つからない（404）ときは failed（答えなし）、接続が外された（401）ときは unpaired。
 */
export function waitLaunch(
  p: Pairing,
  key: CryptoKey,
  id: string,
  o: { everyMs?: number; giveUpMs?: number; onStage: (s: LaunchStage, a?: MobileLaunchAnswer) => void; onClaimed?: () => void },
): () => void {
  const every = o.everyMs ?? LAUNCH_POLL_MS;
  const giveUp = o.giveUpMs ?? LAUNCH_GIVE_UP_MS;
  let done = false;
  let claimed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (s: LaunchStage, a?: MobileLaunchAnswer): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    clearTimeout(limit);
    if (a) o.onStage(s, a);
    else o.onStage(s);
  };
  const answerOf = async (sealed: string | null): Promise<MobileLaunchAnswer | undefined> => {
    if (!sealed) return undefined;
    try {
      const a = await open<MobileLaunchAnswer>(key, aadAnswer(id), sealed);
      return a && typeof a === 'object' && typeof a.ok === 'boolean' ? a : undefined;
    } catch {
      return undefined;
    }
  };
  const tick = async (): Promise<void> => {
    timer = null;
    if (done) return;
    try {
      const st = await getLaunch(p, id);
      if (done) return;
      if (st.status === 'started' || st.status === 'failed') {
        const a = await answerOf(st.sealedAnswer);
        if (!a) finish('unreadable');
        else if (!a.ok) finish('failed', a);
        else if (st.status === 'started') finish('started', a);
        else finish('unreadable');
        return;
      }
      if (st.status === 'expired') {
        finish('expired');
        return;
      }
      if (st.status === 'claimed' && !claimed) {
        claimed = true;
        o.onClaimed?.();
      }
    } catch (e) {
      if (e instanceof LaunchError && e.reason === 'unpaired') {
        finish('unpaired');
        return;
      }
      if (e instanceof LaunchError && e.reason === 'not-found') {
        finish('failed');
        return;
      }
    }
    if (!done) timer = setTimeout(() => void tick(), every);
  };
  const limit = setTimeout(() => finish(claimed ? 'unanswered' : 'expired'), giveUp);
  o.onStage('waiting');
  timer = setTimeout(() => void tick(), every);
  return () => {
    done = true;
    if (timer) clearTimeout(timer);
    clearTimeout(limit);
  };
}
