/**
 * スマホの通知（Web Push）の購読。
 *
 * 「通知を受け取る」で、利用者の操作の中で Notification.requestPermission を呼び、許されたら Worker の VAPID の公開鍵（GET /m/push/key）で PushManager.subscribe し、購読を PUT /m/push/subscription で Worker に置く。
 * 購読と一緒に、鳴らさない夜の時間帯（quiet、既定は 23:00〜7:00、設定の通知のページで変える）と、端末の今の tzOffset を送る。
 * 通知の中身はスマホ用の鍵で封じてあり、開くのはサービスワーカー（public/sw.js）である。
 * 手元には、どの接続で、どの購読を、どの夜の時間帯と tzOffset で置いたかだけを localStorage に持つ。
 * 開くたびに tzOffset が変わっていれば、同じ夜の時間帯のまま送り直す。
 */

import { fromBase64Url } from '@agent-hangar/shared/src/e2e/bytes.ts';
import { PUSH_QUIET_DEFAULT, type PushKeyOut, type PushSubscriptionPut } from '@agent-hangar/shared/src/mobile.ts';
import { mobileHeaders, originOf } from './api.ts';
import { isIos } from './platform.ts';
import type { Pairing } from './store.ts';

/**
 * 通知の状態。
 * - unsupported：このブラウザでは使えない。ios は iPhone か iPad で、ホーム画面に追加した hangar でなら使える。
 * - denied：通知を拒否してある（ブラウザか端末の設定で許可し直すまで、許可を求めても断られる）。
 */
export type PushStatus = { kind: 'unsupported'; ios: boolean } | { kind: 'denied' } | { kind: 'off' } | { kind: 'on' };

/** 購読を置けなかった（Worker に送れなかった、購読を作れなかった）。 */
export class PushError extends Error {
  constructor(readonly reason: 'network' | 'server' | 'subscribe') {
    super(`通知を設定できませんでした（${reason}）`);
    this.name = 'PushError';
  }
}

/** 鳴らさない夜の時間帯（端末の時刻の 0 時からの分、0〜1439）。null は夜も鳴らす。 */
export type Quiet = { start: number; end: number } | null;

type PushRecord = { deviceId: string; endpoint: string; tzOffset: number; quiet: Quiet };
type Options = { tzOffset?: number };

const defaultQuiet = (): Quiet => ({ start: PUSH_QUIET_DEFAULT.start, end: PUSH_QUIET_DEFAULT.end });
const isMinute = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1440;

/** 送る形にそろえる。開始と終了が同じなら、時間帯なし（夜も鳴らす）と同じ扱いにする。 */
export function normalizeQuiet(q: Quiet): Quiet {
  return q && isMinute(q.start) && isMinute(q.end) && q.start !== q.end ? { start: q.start, end: q.end } : null;
}

/** 記録の quiet を読む。前の版の記録（quiet が無い）と形の違う値は、Worker と同じく既定と見る。 */
function quietOfRecord(v: unknown): Quiet {
  if (v === null) return null;
  const o = v as { start?: unknown; end?: unknown } | undefined;
  return o && typeof o === 'object' && isMinute(o.start) && isMinute(o.end) ? normalizeQuiet({ start: o.start, end: o.end }) : defaultQuiet();
}

const RECORD_KEY = 'hangar.mobile.push';

function loadRecord(): PushRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<PushRecord> | null) : null;
    return v && typeof v.deviceId === 'string' && typeof v.endpoint === 'string' && typeof v.tzOffset === 'number'
      ? { deviceId: v.deviceId, endpoint: v.endpoint, tzOffset: v.tzOffset, quiet: quietOfRecord(v.quiet) }
      : null;
  } catch {
    return null;
  }
}

function saveRecord(r: PushRecord): void {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(r));
  } catch {
    // 置けなければ、次に開いたときにオフと見えるだけである（押し直せば置き直す）。
  }
}

function clearRecord(): void {
  try {
    localStorage.removeItem(RECORD_KEY);
  } catch {
    // 消せなくても、購読が無ければオフと見る。
  }
}

const tzNow = (o: Options): number => o.tzOffset ?? new Date().getTimezoneOffset();

/** Web Push を使えるか。iOS ではホーム画面に追加した hangar の中でだけ PushManager がある。 */
export function pushSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.serviceWorker && typeof globalThis.PushManager !== 'undefined' && !!globalThis.PushManager && typeof globalThis.Notification !== 'undefined' && !!globalThis.Notification;
  } catch {
    return false;
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  try {
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

async function send(p: Pairing, method: 'PUT' | 'DELETE', body?: PushSubscriptionPut): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${originOf(p.url)}/m/push/subscription`, {
      method,
      headers: body ? { ...mobileHeaders(p), 'content-type': 'application/json' } : mobileHeaders(p),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new PushError('network');
  }
  if (!res.ok) throw new PushError('server');
}

async function fetchServerKey(p: Pairing): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(`${originOf(p.url)}/m/push/key`, { headers: mobileHeaders(p), cache: 'no-store' });
  } catch {
    throw new PushError('network');
  }
  if (!res.ok) throw new PushError('server');
  const v = (await res.json().catch(() => null)) as Partial<PushKeyOut> | null;
  const key = typeof v?.publicKey === 'string' ? fromBase64Url(v.publicKey) : null;
  if (!key || key.length !== 65 || key[0] !== 4) throw new PushError('server');
  return key;
}

const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
};

/** 購読を Worker に置き、手元に記録する。quiet は省かずに毎回送る（null は夜も鳴らす）。 */
async function put(p: Pairing, sub: PushSubscription, tzOffset: number, quiet: Quiet): Promise<void> {
  const j = sub.toJSON();
  const keys = j.keys as { p256dh?: string; auth?: string } | undefined;
  if (!j.endpoint || !keys?.p256dh || !keys.auth) throw new PushError('subscribe');
  await send(p, 'PUT', { endpoint: j.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, quiet, tzOffset });
  saveRecord({ deviceId: p.deviceId, endpoint: j.endpoint, tzOffset, quiet });
}

/** この接続で置いた夜の時間帯。購読が無いとき（オフ、前の接続の記録）は既定（23:00〜7:00）。 */
export function pushQuiet(p: Pairing): Quiet {
  const rec = loadRecord();
  return rec && rec.deviceId === p.deviceId ? rec.quiet : defaultQuiet();
}

/**
 * 夜の時間帯を変えて、すぐ Worker に送る（PUT /m/push/subscription の quiet）。
 * この接続の購読が無ければ送らずに PushError を投げる。Worker に送れなければ PushError で、覚えている値は変えない。
 */
export async function setPushQuiet(p: Pairing, quiet: Quiet, o: Options = {}): Promise<void> {
  if (!pushSupported()) throw new PushError('subscribe');
  const rec = loadRecord();
  const sub = await currentSubscription();
  if (!sub || !rec || rec.deviceId !== p.deviceId) throw new PushError('subscribe');
  await put(p, sub, tzNow(o), normalizeQuiet(quiet));
}

/**
 * 開いたときの状態を読む。
 * この接続で置いた購読が生きていればオンで、tzOffset か購読の宛先が変わっていれば送り直す（失敗は次に開いたときにまた試す）。
 * 購読が切れていれば（getSubscription が null、許可を外した）オフに戻し、Worker の行も消しにいく。
 */
export async function readPushStatus(p: Pairing, o: Options = {}): Promise<PushStatus> {
  if (!pushSupported()) return { kind: 'unsupported', ios: isIos() };
  const perm = Notification.permission;
  const rec = loadRecord();
  const sub = await currentSubscription();
  if (!sub || perm !== 'granted') {
    if (rec) {
      clearRecord();
      if (rec.deviceId === p.deviceId) void send(p, 'DELETE').catch(() => undefined);
    }
    return perm === 'denied' ? { kind: 'denied' } : { kind: 'off' };
  }
  if (!rec || rec.deviceId !== p.deviceId) return { kind: 'off' };
  const tz = tzNow(o);
  if (rec.endpoint !== sub.endpoint || rec.tzOffset !== tz) await put(p, sub, tz, rec.quiet).catch(() => undefined);
  return { kind: 'on' };
}

/**
 * 「通知を受け取る」。押したときの操作の中で呼ぶ（iOS は利用者の操作の外で requestPermission を呼ぶと断る）。
 * 許可を求める前には網に出ない。前の購読が別の鍵（別の接続先）のものなら外してから購読し直す。
 * Worker に置けなければ購読を外して PushError を投げる。
 * quiet を渡さなければ既定（23:00〜7:00）で置く。
 */
export async function turnOnPush(p: Pairing, o: Options & { quiet?: Quiet } = {}): Promise<PushStatus> {
  if (!pushSupported()) return { kind: 'unsupported', ios: isIos() };
  const perm = await Notification.requestPermission();
  if (perm === 'denied') return { kind: 'denied' };
  if (perm !== 'granted') return { kind: 'off' };
  const reg = await navigator.serviceWorker.ready;
  const key = await fetchServerKey(p);
  let sub = await reg.pushManager.getSubscription().catch(() => null);
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
    } catch {
      throw new PushError('subscribe');
    }
  }
  try {
    await put(p, sub, tzNow(o), normalizeQuiet(o.quiet === undefined ? defaultQuiet() : o.quiet));
  } catch (e) {
    await sub.unsubscribe().catch(() => false);
    clearRecord();
    throw e;
  }
  return { kind: 'on' };
}

/** 「通知を止める」。購読を外し、Worker の行を消す。Worker に送れなくても手元はオフにする（購読が無ければ push サービスが断り、Worker が行を消す）。 */
export async function turnOffPush(p: Pairing): Promise<PushStatus> {
  const sub = await currentSubscription();
  await sub?.unsubscribe().catch(() => false);
  clearRecord();
  await send(p, 'DELETE').catch(() => undefined);
  return pushSupported() && Notification.permission === 'denied' ? { kind: 'denied' } : { kind: 'off' };
}

const OPEN = '#open=';

/**
 * 通知から開かれた URL の #open=<会話の ID> を取り出し、URL から消す（public/sw.js の notificationclick が付ける）。
 * 無ければ null で、URL に触らない。
 */
export function takeOpenFragment(): string | null {
  const hash = location.hash;
  if (!hash.startsWith(OPEN)) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    return decodeURIComponent(hash.slice(OPEN.length)) || null;
  } catch {
    return null;
  }
}

/** サービスワーカーが「この会話を開いて」と渡してきたものを読む。 */
export function openMessageOf(data: unknown): string | null {
  const v = data as { type?: unknown; sessionId?: unknown } | null;
  return v && typeof v === 'object' && v.type === 'hangar-open' && typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : null;
}
