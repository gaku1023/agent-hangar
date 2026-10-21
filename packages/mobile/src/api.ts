// shared を入口（index.ts）から読むと PC 向けの表まで束に入るので、使うものだけを直に読む。
import { COMPAT_HEADER, compatHeaders, MOBILE_BELL_MIN_WORKER_COMPAT, parseCompat } from '@agent-hangar/shared/src/compat.ts';
import { EXPIRED_ERROR, type MobileInboxResponse, type MobileJoinRequest, type MobileJoinResponse, type MobileLaunchIn, type MobileLaunchStatus } from '@agent-hangar/shared/src/mobile.ts';
import { decodePairing, MobilePairingError, type PairingBlob } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { generatePhoneKeyPair, sealPhoneJoinRequest } from '@agent-hangar/shared/src/e2e/phone.ts';
import { REVOKED_ERROR } from '@agent-hangar/shared/src/cloud.ts';
import { clearPhoneKeys, loadPhonePair, savePhonePair, type Pairing, type PhonePair } from './store.ts';

/**
 * 401 の理由。
 * - expired：30 日使わなかったか、接続から 90 日たった（Worker の `{ error: 'expired' }`）。
 * - revoked：PC の設定で解除された。
 * - unknown：知らないトークン、ほかの 401。
 */
export type UnpairedReason = 'expired' | 'revoked' | 'unknown';

/** トークンが外された、期限が切れた、または知らないトークン（401）。参加の画面に戻る。 */
export class UnpairedError extends Error {
  constructor(readonly reason: UnpairedReason = 'unknown') {
    super(reason === 'expired' ? 'このスマホの接続は期限が切れています' : 'このスマホの接続は解除されています');
    this.name = 'UnpairedError';
  }
}

/** 401 の応答の本文から理由を読む。読めなければ unknown。 */
export async function unpairedOf(res: Response): Promise<UnpairedError> {
  let error: unknown;
  try {
    error = ((await res.json()) as { error?: unknown } | null)?.error;
  } catch {
    error = undefined;
  }
  return new UnpairedError(unpairedReasonOf(error));
}

/** 401 の本文の error から理由を読む。 */
export function unpairedReasonOf(error: unknown): UnpairedReason {
  return error === EXPIRED_ERROR ? 'expired' : error === REVOKED_ERROR ? 'revoked' : 'unknown';
}

/**
 * 参加の失敗。
 * keybox は、接続はできたが、QR を表示した PC がスマホ用の鍵を置くのを待ちきれなかった（券は使い終えている）。
 */
export type JoinFailure = 'ticket' | 'too-many-phones' | 'upgrade' | 'network' | 'server' | 'storage' | 'keybox';

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
    super(status === null ? '受信箱に接続できませんでした' : `受信箱を読めませんでした（${status}）`);
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

/** 同じ ID のスマホが既にある（409 device-exists）ときに、別の ID で出し直す回数。ID は乱数なので、ふつうは 1 回目で通る。 */
const JOIN_ID_TRIES = 3;

/**
 * QR の中身で接続する（互換の版 9）。
 *
 * 取り出せない鍵ペア（ECDH P-256。理由は shared の e2e/phone.ts）を作り、公開鍵と名前を券から導いた鍵で封じて、券と自分で決めた ID と一緒に `POST /m/join` に送る。
 * 鍵ペアは券を使う前に IndexedDB に置く。置けない端末で券と台数の枠を無駄に使わないため。
 * 接続に失敗したら、前から置いてあった鍵ペアに戻す（前の接続の keybox を開けなくしない）。
 * 同じ ID が既にある（409 device-exists）ときは、券が残っているので別の ID で出し直す。
 * 接続できたら前の接続のスマホ用の鍵を忘れる（接続先が変わると世代の番号が重なるため）。
 * スマホ用の鍵は、QR を表示した PC が keybox に置くので、続けて waitPhoneKeys（keyring.ts）で待つ。
 */
export async function joinPhone(pairText: string, name: string): Promise<{ pairing: Pairing; pair: PhonePair }> {
  const blob = readPairText(pairText);
  const origin = originOf(blob.url);
  const pair = await generatePhoneKeyPair();
  const before = await loadPhonePair();
  try {
    await savePhonePair(pair);
  } catch {
    throw new JoinError('storage');
  }
  try {
    for (let i = 0; ; i++) {
      const deviceId = globalThis.crypto.randomUUID();
      const sealed = await sealPhoneJoinRequest(blob.code, deviceId, { pub: pair.pub, name });
      const got = await postJoin(origin, { code: blob.code, deviceId, sealed });
      if (got === 'device-exists') {
        if (i + 1 < JOIN_ID_TRIES) continue;
        throw new JoinError('server', 409);
      }
      await clearPhoneKeys().catch(() => undefined);
      return { pairing: got, pair };
    }
  } catch (e) {
    if (before) await savePhonePair(before).catch(() => undefined);
    throw e;
  }
}

async function postJoin(origin: string, body: MobileJoinRequest): Promise<Pairing | 'device-exists'> {
  let res: Response;
  try {
    res = await fetch(`${origin}/m/join`, {
      method: 'POST',
      headers: { ...compatHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new JoinError('network');
  }
  if (res.status === 401) throw new JoinError('ticket', 401);
  if (res.status === 409) {
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
    if (error === 'device-exists') return 'device-exists';
    throw new JoinError('too-many-phones', 409);
  }
  if (res.status === 426) throw new JoinError('upgrade', 426);
  if (!res.ok) throw new JoinError('server', res.status);
  let out: Partial<MobileJoinResponse>;
  try {
    out = (await res.json()) as Partial<MobileJoinResponse>;
  } catch {
    throw new JoinError('server', res.status);
  }
  if (typeof out.token !== 'string' || !out.token || out.deviceId !== body.deviceId) throw new JoinError('server', res.status);
  // 接続した時刻はスマホの時計で持つ。設定の接続のページが、接続した日と接続し直す期限（PHONE_MAX_AGE_MS 後）を出す。
  return { url: origin, token: out.token, deviceId: out.deviceId, joinedAt: Date.now() };
}

/**
 * 応答の見出しから読む Worker の版。見出しが無ければ null（Worker の応答ならどれも版を載せるので、手前の層が返した応答である）。
 */
export function workerCompatOf(res: { headers: { get: (k: string) => string | null } } | null): number | null {
  const v = res?.headers.get(COMPAT_HEADER) ?? null;
  return v === null ? null : parseCompat(v);
}

/**
 * Worker が呼び鈴（問い合わせ）と画像の口を持たない古い版か。
 * rc.1 の Worker も知らない口に JSON の 404 を返すので、本文でなく版の見出しで見分ける。版が分からなければ古いとはみなさない。
 */
export function workerTooOld(compat: number | null): boolean {
  return compat !== null && compat < MOBILE_BELL_MIN_WORKER_COMPAT;
}

/** スマホ用の口に送る見出し。どの /m/ の要求にも互換の版を付ける（無いと Worker は 426 で断る）。 */
export function mobileHeaders(p: Pairing): Record<string, string> {
  return { ...compatHeaders(), authorization: `Bearer ${p.token}` };
}

/** このスマホの接続を外せなかった。network は通信の失敗、server はそれ以外の応答（status に番号）。 */
export class LeaveError extends Error {
  constructor(
    readonly reason: 'network' | 'server',
    readonly status: number | null = null,
  ) {
    super(`接続を解除できませんでした（${reason}）`);
    this.name = 'LeaveError';
  }
}

/**
 * このスマホの接続を解除（`POST /m/leave`、スマホのトークン、本文なし、204）。
 * 204 と 401（もう外れている、期限が切れている）は外れたとみなして left を返す。
 * 404 は口の無い古い Worker で old を返す（Worker の行は残るので、PC の設定からも解除してもらう）。
 */
export async function leavePhone(p: Pairing): Promise<'left' | 'old'> {
  let res: Response;
  try {
    res = await fetch(`${originOf(p.url)}/m/leave`, { method: 'POST', headers: mobileHeaders(p), cache: 'no-store' });
  } catch {
    throw new LeaveError('network');
  }
  if (res.status === 204 || res.status === 401 || res.ok) return 'left';
  if (res.status === 404) return 'old';
  throw new LeaveError('server', res.status);
}

/** 受信箱の応答に、応答の見出しから読んだ Worker の版を添えたもの。 */
export type InboxFetched = MobileInboxResponse & { workerCompat: number | null };

export async function fetchInbox(p: Pairing): Promise<InboxFetched> {
  let res: Response;
  try {
    res = await fetch(`${originOf(p.url)}/m/inbox`, { headers: mobileHeaders(p), cache: 'no-store' });
  } catch (e) {
    if (e instanceof MobilePairingError) throw new UnpairedError();
    throw new InboxError(null);
  }
  if (res.status === 401) throw await unpairedOf(res);
  if (!res.ok) throw new InboxError(res.status);
  try {
    return { ...((await res.json()) as MobileInboxResponse), workerCompat: workerCompatOf(res) };
  } catch {
    throw new InboxError(res.status);
  }
}

export type LaunchFailure = 'rate-limited' | 'not-found' | 'conflict' | 'too-large' | 'unpaired' | 'network' | 'server';

/** 起動の依頼を送れなかった、または状態を読めなかった。reason で画面の文を分ける。unpairedReason は 401 の理由。 */
export class LaunchError extends Error {
  constructor(
    readonly reason: LaunchFailure,
    readonly status: number | null = null,
    readonly unpairedReason: UnpairedReason = 'unknown',
  ) {
    super(`起動の依頼が通りませんでした（${reason}）`);
    this.name = 'LaunchError';
  }
}

const launchFailure = (status: number): LaunchFailure =>
  status === 401 ? 'unpaired' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : status === 413 ? 'too-large' : status === 429 ? 'rate-limited' : 'server';

async function launchFetch(p: Pairing, path: string, init: RequestInit): Promise<MobileLaunchStatus> {
  let res: Response;
  try {
    res = await fetch(`${originOf(p.url)}${path}`, { ...init, cache: 'no-store' });
  } catch (e) {
    if (e instanceof MobilePairingError) throw new LaunchError('unpaired');
    throw new LaunchError('network');
  }
  if (res.status === 401) throw new LaunchError('unpaired', 401, (await unpairedOf(res)).reason);
  if (!res.ok) throw new LaunchError(launchFailure(res.status), res.status);
  try {
    return (await res.json()) as MobileLaunchStatus;
  } catch {
    throw new LaunchError('server', res.status);
  }
}

/** 起動の依頼を置く（POST /m/launches）。同じ id の再送は、行を増やさずに今の状態が返る。 */
export function postLaunch(p: Pairing, body: MobileLaunchIn): Promise<MobileLaunchStatus> {
  return launchFetch(p, '/m/launches', { method: 'POST', headers: { ...mobileHeaders(p), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** 自分の依頼の状態を読む（GET /m/launches/:id）。 */
export function getLaunch(p: Pairing, id: string): Promise<MobileLaunchStatus> {
  return launchFetch(p, `/m/launches/${encodeURIComponent(id)}`, { headers: mobileHeaders(p) });
}
