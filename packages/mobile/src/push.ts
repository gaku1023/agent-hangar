/**
 * スマホの通知（Web Push）の購読。
 *
 * 「通知を受け取る」で、利用者の操作の中で Notification.requestPermission を呼び、許されたら Worker の VAPID の公開鍵（GET /m/push/key）で PushManager.subscribe し、購読を PUT /m/push/subscription で Worker に置く。
 * 夜の時間帯は既定（23:00〜7:00）のままにするので quiet は送らない。tzOffset は端末の今の値を送る。
 * 通知の中身はスマホ用の鍵で封じてあり、開くのはサービスワーカー（public/sw.js）である。
 * 手元には、どの接続で、どの購読を、どの tzOffset で置いたかだけを localStorage に持つ（開くたびに tzOffset が変わっていれば送り直すため）。
 */

import { fromBase64Url } from '@agent-hangar/shared/src/e2e/bytes.ts';
import type { PushKeyOut, PushSubscriptionPut } from '@agent-hangar/shared/src/mobile.ts';
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

type PushRecord = { deviceId: string; endpoint: string; tzOffset: number };
type Options = { tzOffset?: number };

const RECORD_KEY = 'hangar.mobile.push';

function loadRecord(): PushRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<PushRecord> | null) : null;
    return v && typeof v.deviceId === 'string' && typeof v.endpoint === 'string' && typeof v.tzOffset === 'number' ? { deviceId: v.deviceId, endpoint: v.endpoint, tzOffset: v.tzOffset } : null;
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

/** 購読を Worker に置き、手元に記録する。 */
async function put(p: Pairing, sub: PushSubscription, tzOffset: number): Promise<void> {
  const j = sub.toJSON();
  const keys = j.keys as { p256dh?: string; auth?: string } | undefined;
  if (!j.endpoint || !keys?.p256dh || !keys.auth) throw new PushError('subscribe');
  await send(p, 'PUT', { endpoint: j.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, tzOffset });
  saveRecord({ deviceId: p.deviceId, endpoint: j.endpoint, tzOffset });
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
  if (rec.endpoint !== sub.endpoint || rec.tzOffset !== tz) await put(p, sub, tz).catch(() => undefined);
  return { kind: 'on' };
}

/**
 * 「通知を受け取る」。押したときの操作の中で呼ぶ（iOS は利用者の操作の外で requestPermission を呼ぶと断る）。
 * 許可を求める前には網に出ない。前の購読が別の鍵（別の接続先）のものなら外してから購読し直す。
 * Worker に置けなければ購読を外して PushError を投げる。
 */
export async function turnOnPush(p: Pairing, o: Options = {}): Promise<PushStatus> {
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
    await put(p, sub, tzNow(o));
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
