// shared を入口（index.ts）から読むと PC 向けの表まで束に入るので、使うものだけを直に読む。
import { compatHeaders } from '@agent-hangar/shared/src/compat.ts';
import type { MobileInboxResponse, MobileJoinResponse } from '@agent-hangar/shared/src/mobile.ts';
import { decodePairing, importMobileKey, MobilePairingError, type PairingBlob } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { loadKey, saveKey, type Pairing } from './store.ts';

/** トークンが外された、または知らないトークン（401）。参加の画面に戻る。 */
export class UnpairedError extends Error {
  constructor() {
    super('このスマホの接続は外されています');
    this.name = 'UnpairedError';
  }
}

export type JoinFailure = 'ticket' | 'too-many-phones' | 'upgrade' | 'network' | 'server' | 'storage';

/** 参加に失敗した。reason で画面の文を分ける。 */
export class JoinError extends Error {
  constructor(
    readonly reason: JoinFailure,
    readonly status: number | null = null,
  ) {
    super(`参加できませんでした（${reason}）`);
    this.name = 'JoinError';
  }
}

/** 受信箱を読めなかった（401 以外）。 */
export class InboxError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? '受信箱に届きませんでした' : `受信箱を読めませんでした（${status}）`);
    this.name = 'InboxError';
  }
}

const PAIR = '#pair=';

/**
 * 開いた URL の #pair= を取り出し、すぐ history.replaceState で URL から消す。
 * フラグメントはサーバへ送られないが、履歴や共有で残らないよう、読んだらすぐ消して手元の変数にだけ持つ。
 */
export function takePairFragment(): string | null {
  const hash = location.hash;
  if (!hash.startsWith(PAIR)) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  const text = hash.slice(PAIR.length);
  return text || null;
}

/** 貼られた文字列（URL まるごと、#pair= から、中身だけのどれでもよい）から中身を取り出して読む。 */
export function readPairText(input: string): PairingBlob {
  const t = input.trim();
  const at = t.indexOf(PAIR);
  const blob = decodePairing(at >= 0 ? t.slice(at + PAIR.length) : t);
  originOf(blob.url);
  return blob;
}

/** 接続先の Worker のオリジン。https（手元で試すときだけ 127.0.0.1 と localhost の http）でなければ読めない文字列として断る。 */
export function originOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new MobilePairingError();
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new MobilePairingError();
  return u.origin;
}

function keyBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new MobilePairingError();
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new MobilePairingError();
  }
  if (bin.length !== 32) throw new MobilePairingError();
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * QR の中身で参加する。鍵は取り出せない CryptoKey にしてから Worker に券だけを送る（鍵は送らない）。
 * 鍵は券を使う前に IndexedDB に置く。置けない端末で券と台数の枠を無駄に使わないため。
 * 参加に失敗したら、前から置いてあった鍵に戻す（前の接続の受信箱を開けなくしない）。
 * Worker は新しい deviceId を割り当てるので、応答の deviceId を持つ。
 */
export async function joinPhone(pairText: string, name: string): Promise<{ pairing: Pairing; key: CryptoKey }> {
  const blob = readPairText(pairText);
  const origin = originOf(blob.url);
  const bytes = keyBytes(blob.key);
  const key = await importMobileKey(bytes, false);
  bytes.fill(0);
  const before = await loadKey();
  try {
    await saveKey(key);
  } catch {
    throw new JoinError('storage');
  }
  try {
    return await postJoin(origin, blob.code, name, key);
  } catch (e) {
    if (before) await saveKey(before).catch(() => undefined);
    throw e;
  }
}

async function postJoin(origin: string, code: string, name: string, key: CryptoKey): Promise<{ pairing: Pairing; key: CryptoKey }> {
  let res: Response;
  try {
    res = await fetch(`${origin}/m/join`, {
      method: 'POST',
      headers: { ...compatHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: { id: globalThis.crypto.randomUUID(), name } }),
    });
  } catch {
    throw new JoinError('network');
  }
  if (res.status === 401) throw new JoinError('ticket', 401);
  if (res.status === 409) throw new JoinError('too-many-phones', 409);
  if (res.status === 426) throw new JoinError('upgrade', 426);
  if (!res.ok) throw new JoinError('server', res.status);
  let body: Partial<MobileJoinResponse>;
  try {
    body = (await res.json()) as Partial<MobileJoinResponse>;
  } catch {
    throw new JoinError('server', res.status);
  }
  if (typeof body.token !== 'string' || !body.token || typeof body.deviceId !== 'string' || !body.deviceId) throw new JoinError('server', res.status);
  return { pairing: { url: origin, token: body.token, deviceId: body.deviceId }, key };
}

/** スマホ用の口に送る見出し。どの /m/ の要求にも互換の版を付ける（無いと Worker は 426 で断る）。 */
export function mobileHeaders(p: Pairing): Record<string, string> {
  return { ...compatHeaders(), authorization: `Bearer ${p.token}` };
}

export async function fetchInbox(p: Pairing): Promise<MobileInboxResponse> {
  let res: Response;
  try {
    res = await fetch(`${originOf(p.url)}/m/inbox`, { headers: mobileHeaders(p), cache: 'no-store' });
  } catch (e) {
    if (e instanceof MobilePairingError) throw new UnpairedError();
    throw new InboxError(null);
  }
  if (res.status === 401) throw new UnpairedError();
  if (!res.ok) throw new InboxError(res.status);
  try {
    return (await res.json()) as MobileInboxResponse;
  } catch {
    throw new InboxError(res.status);
  }
}
