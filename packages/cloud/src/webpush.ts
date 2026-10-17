/**
 * Web Push の送り手の暗号（0.9.1）。WebCrypto だけで書き、ライブラリを使わない。
 *
 * 本文の暗号は RFC 8291（Message Encryption for Web Push、Content-Encoding: aes128gcm）である。
 * 送るたびに使い捨ての ECDH P-256 の鍵ペアと 16 バイトの salt を作り、購読の公開鍵（p256dh）と auth から内容の鍵と nonce を導く。
 * 本文は RFC 8188 の頭（salt、記録の大きさ、使い捨ての公開鍵）と、1 つの記録（本文 || 0x02 を AES-128-GCM で封じたもの）である。
 *
 * 送り手の名乗りは RFC 8292（VAPID）である。
 * Worker が持つ ECDSA P-256 の鍵で ES256 の JWT に署名し、`Authorization: vapid t=<JWT>, k=<公開鍵>` で送る。
 * aud は endpoint の origin、exp は 12 時間後、sub は Worker の https の URL である（mailto: は使わない。持ち主のメールアドレスを push サービスに渡さない）。
 *
 * 運ぶ本文は PC がスマホ用の鍵で封じた通知（shared の sealPhoneNotice）で、Worker は開けない。
 * ここで掛ける暗号は、その外側にもう 1 枚、push サービスに中身を見せないための封である。
 */

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const ENC = new TextEncoder();

/** 記録の大きさ（RFC 8188 の rs）。本文は 1 つの記録に収める。 */
const RECORD_SIZE = 4096;
/** RFC 8188 の頭の長さ。salt(16) || rs(4) || idlen(1) || 使い捨ての公開鍵(65)。 */
const HEADER_LEN = 16 + 4 + 1 + 65;
const TAG_LEN = 16;
/**
 * 運べる本文の上限（バイト）。
 * push サービスが受ける本文は 4,096 バイトまでなので、頭と区切り（1 バイト）とタグを引いた残りである。
 */
export const PUSH_PAYLOAD_MAX = RECORD_SIZE - HEADER_LEN - 1 - TAG_LEN;

/** push サービスに頼む保持の時間（秒）。スマホの電源が切れていても、1 時間までは届け直してもらう。 */
export const PUSH_TTL_SECONDS = 3600;
/** VAPID の JWT の有効期間（秒）。RFC 8292 の上限は 24 時間で、ここでは 12 時間にする。 */
export const VAPID_EXP_SECONDS = 12 * 3600;

const P256_ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const P256_ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** バイト列を base64url（詰め物なし）にする。 */
export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url を読む。形が違えば null。 */
export function unb64url(s: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const body = s.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  try {
    const bin = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** HKDF-SHA-256 の Extract と Expand を 1 度に行う。 */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const k = await subtle().importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, k, len * 8));
}

/** 購読の公開鍵（p256dh）として読めるか。65 バイトの非圧縮点で、P-256 の上の点であること。 */
export async function isPushPublicKey(raw: Uint8Array | null): Promise<boolean> {
  if (!raw || raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    await subtle().importKey('raw', raw as BufferSource, P256_ECDH, false, []);
    return true;
  } catch {
    return false;
  }
}

/**
 * 本文を RFC 8291 の aes128gcm で封じ、push サービスに送る本文（頭つき）を返す。
 * sender と salt は試験ベクトル（RFC 8291 の付録 A）のためだけに渡す。ふだんは毎回作る。
 */
export async function encryptPushPayload(payload: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, o: { sender?: CryptoKeyPair; salt?: Uint8Array } = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (payload.length > PUSH_PAYLOAD_MAX) throw new RangeError(`push の本文が長すぎます（${PUSH_PAYLOAD_MAX} バイトまで）`);
  const sender = o.sender ?? ((await subtle().generateKey(P256_ECDH, false, ['deriveBits'])) as CryptoKeyPair);
  const salt = o.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await subtle().exportKey('raw', sender.publicKey));
  const ua = await subtle().importKey('raw', uaPublic as BufferSource, P256_ECDH, false, []);
  const ecdh = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: ua }, sender.privateKey, 256));
  // RFC 8291 の 3.3 と 3.4。IKM は auth を salt にして ECDH の共有の値から導き、内容の鍵と nonce は salt から導く。
  const ikm = await hkdf(authSecret, ecdh, cat(ENC.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, ENC.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, ENC.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle().importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  // 記録は 1 つだけなので、区切りは最後の記録の印（0x02）で、詰め物は足さない。
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(payload, Uint8Array.of(0x02))));
  const header = new Uint8Array(HEADER_LEN);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return cat(header, ct);
}

/** D1 の meta に置く VAPID の鍵の形。秘密鍵は JWK で、公開鍵は raw の非圧縮点の base64url。 */
export type StoredVapid = { publicKey: string; privateKey: JsonWebKey };
/** 署名に使う形。秘密鍵は取り出せない CryptoKey にする。 */
export type VapidKeys = { publicKey: string; privateKey: CryptoKey };

/** VAPID の鍵ペア（ECDSA P-256）を作り、meta に置ける形で返す。 */
export async function generateVapidKeys(): Promise<StoredVapid> {
  const pair = (await subtle().generateKey(P256_ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const jwk = (await subtle().exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { publicKey: b64url(pub), privateKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** meta から読んだ値を署名に使える形にする。形が違えば投げる。 */
export async function importVapidKeys(stored: StoredVapid): Promise<VapidKeys> {
  const pub = unb64url(stored?.publicKey);
  if (!pub || pub.length !== 65 || pub[0] !== 0x04 || typeof stored.privateKey !== 'object' || stored.privateKey === null) throw new TypeError('VAPID の鍵の形が違います');
  const privateKey = await subtle().importKey('jwk', { ...stored.privateKey, ext: false, key_ops: ['sign'] }, P256_ECDSA, false, ['sign']);
  return { publicKey: stored.publicKey, privateKey };
}

const jsonPart = (v: unknown): string => b64url(ENC.encode(JSON.stringify(v)));

/**
 * VAPID の Authorization の見出しを作る（RFC 8292 の 2 と 3）。
 * WebCrypto の ECDSA の署名は r || s の 64 バイトで、JWS の ES256 の形と同じなので、そのまま使う。
 */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, sub: string, now: number): Promise<string> {
  const unsigned = `${jsonPart({ typ: 'JWT', alg: 'ES256' })}.${jsonPart({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_EXP_SECONDS, sub })}`;
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, ENC.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** 購読の送り先。`push_subscriptions` の 1 行の、送るのに要る列である。 */
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** 1 つの購読へ送る要求を組み立てる。TTL は 1 時間、Urgency は normal。 */
export async function pushRequest(target: PushTarget, payload: Uint8Array, keys: VapidKeys, sub: string, now: number): Promise<Request> {
  const ua = unb64url(target.p256dh);
  const auth = unb64url(target.auth);
  if (!ua || !auth) throw new TypeError('購読の鍵の形が違います');
  const body = await encryptPushPayload(payload, ua, auth);
  return new Request(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuthorization(keys, target.endpoint, sub, now),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(PUSH_TTL_SECONDS),
      urgency: 'normal',
    },
    body,
  });
}

/** endpoint の URL の字数の上限。実物は数百字である。 */
export const PUSH_ENDPOINT_MAX = 2048;
/** 名前がそのまま一致すれば通す push サービスのホスト。 */
const PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
/** この後ろで終わるホストを通す（Apple の別のホストと、Edge の WNS の `wns2-xxx.notify.windows.com`）。 */
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

/**
 * 購読の endpoint として受けてよいか。
 * Worker はこの URL へ要求を出すので、既知の push サービスの https だけに限る（Worker を踏み台にして任意の宛先を叩かせない）。
 * ポートの指定、利用者の名前とパスワードのある URL も断る。
 */
export function pushEndpointAllowed(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > PUSH_ENDPOINT_MAX) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * 今が鳴らさない時間帯か。
 * start と end は端末の時刻の 0 時からの分で、start が end より後なら日をまたぐ（23:00〜7:00 なら 1380 と 420）。
 * tzOffset は端末の `getTimezoneOffset()`（分）で、端末の時刻は UTC からこれを引いたものである。
 * 時間帯が無い（null）か、start と end が同じなら、いつでも鳴らす。
 */
export function inQuietHours(now: number, start: number | null, end: number | null, tzOffset: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  const local = (((Math.floor(now / 60_000) - (tzOffset ?? 0)) % 1440) + 1440) % 1440;
  return start < end ? local >= start && local < end : local >= start || local < end;
}
