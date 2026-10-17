/**
 * スマホの接続の封（互換の版 9）。
 *
 * スマホは QR の券（ペアリングの券、`mobile_pairings` の行）から導いた鍵で、自分の公開鍵と名前を封じて `POST /m/join` に添える。
 * 券は 8 字の参加コードとは形が違うので、参加コードの正規化（joinCode.ts）を通さず、券の文字列の UTF-8 をそのまま HKDF に入れる。
 * AAD はスマホが名乗った ID で、Worker が封を別の ID の行に付け替えると PC は開けない。
 *
 * QR を表示している PC は券を知っているので、同じ関数で開き、スマホ用の鍵 `M[m]` をスマホの公開鍵に keybox で封じる。
 *
 * スマホの鍵ペアは、PC の鍵ペア（X25519）と違い ECDH P-256 である。
 * WebKit は X25519 の CryptoKey を IndexedDB から読み戻すと null にする（WebKit bug 312279）ので、iPhone ではアプリを開き直すと鍵ペアを失う。
 * P-256 の取り出せない CryptoKey は WebKit でも IndexedDB の往復に耐える。
 * 公開鍵は raw の非圧縮点（65 バイト、先頭 0x04）の base64url で持つ。
 *
 * スマホ宛ての keybox は PC の keybox（keybox.ts）と同じ ephemeral-static の形で、曲線だけが P-256 である。
 * `sealed = 使い捨ての公開鍵(65) || iv(12) || AES-256-GCM(M)`、
 * 鍵は `HKDF(ECDH, salt = 使い捨ての公開鍵 || スマホの公開鍵, info = PHONE_KEYBOX_INFO)`、
 * AAD は `["phone-keybox", "P-256", 世代, スマホの ID]` で、中身は M の生の 32 バイトである。
 * info と AAD の両方が PC の keybox と違うので、PC どうしの keybox と取り違えて開くことは無い。
 *
 * PC とスマホの両方から読むので、`globalThis.crypto.subtle` だけを使う。
 */

import { concatBytes, fromBase64Url, toBase64Url, toHex, utf8 } from './bytes.ts';
import { hkdf, importAesKey } from './keys.ts';
import { E2eOpenError } from './seal.ts';

const IV_LEN = 12;
const TAG_LEN = 16;

const JOIN_SALT = 'hangar-phone-join-v1';
const JOIN_INFO = 'hangar-phone-join-req-v1';

/** スマホ宛ての keybox の HKDF の info。PC の keybox（`hangar-keybox-v1`）と区別する。 */
export const PHONE_KEYBOX_INFO = 'hangar-phone-keybox-p256-v1';

/** スマホ用の鍵 M の長さ（バイト）。 */
export const PHONE_KEY_LEN = 32;

/** スマホの公開鍵（P-256 の raw の非圧縮点）の長さ（バイト）。 */
export const PHONE_PUB_LEN = 65;

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** スマホの参加リクエストの中身。P-256 の公開鍵（raw の非圧縮点 65 バイトの base64url）と、PC の一覧に出す名前。 */
export type PhoneJoinBody = { pub: string; name: string };

/** スマホの鍵ペア。pub は P-256 の raw の非圧縮点の base64url、key は取り出せない秘密鍵。 */
export type PhoneKeyPair = { pub: string; key: CryptoKey };

/** スマホの鍵ペアを作る（スマホが呼ぶ）。秘密鍵は取り出せない CryptoKey で、IndexedDB にそのまま置ける。 */
export async function generatePhoneKeyPair(): Promise<PhoneKeyPair> {
  const pair = (await subtle().generateKey(P256, false, ['deriveBits'])) as CryptoKeyPair;
  return { pub: toBase64Url(new Uint8Array(await subtle().exportKey('raw', pair.publicKey))), key: pair.privateKey };
}

/** 形だけを見る（65 バイトで先頭が 0x04）。曲線の上の点かどうかは見ない（名簿を開くときの同期の確かめ用）。 */
export function isPhonePub(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const raw = fromBase64Url(s);
  return raw?.length === PHONE_PUB_LEN && raw[0] === 0x04;
}

/** スマホの公開鍵を CryptoKey にする。形が違う、曲線の上にない点なら TypeError を投げる。 */
async function importPhonePub(raw: Uint8Array | null, what: string): Promise<CryptoKey> {
  if (!raw || raw.length !== PHONE_PUB_LEN || raw[0] !== 0x04) throw new TypeError(`${what}の形が違います（P-256 の非圧縮点 ${PHONE_PUB_LEN} バイト）`);
  try {
    return await subtle().importKey('raw', raw as BufferSource, P256, true, []);
  } catch {
    throw new TypeError(`${what}が P-256 の点ではありません`);
  }
}

async function p256Bits(priv: CryptoKey, pub: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

/** 券の SHA-256 の hex。Worker の `mobile_pairings.code_hash` と同じ値で、PC は `GET /m/pairings/mine` の行と手元の券をこれで突き合わせる。 */
export async function phoneTicketHash(ticket: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', utf8.encode(ticket))));
}

async function joinKey(ticket: string): Promise<CryptoKey> {
  return importAesKey(await hkdf(utf8.encode(ticket), utf8.encode(JOIN_SALT), JOIN_INFO, 32));
}

const joinAad = (deviceId: string): Uint8Array<ArrayBuffer> => utf8.encode(JSON.stringify(['phone-join', deviceId]));

/**
 * スマホの参加リクエストを券で封じる（スマホが呼ぶ）。
 * 戻りは base64url(iv(12) || AES-256-GCM) で、`MobileJoinRequest.sealed` にそのまま入れる。
 */
export async function sealPhoneJoinRequest(ticket: string, deviceId: string, body: PhoneJoinBody): Promise<string> {
  await importPhonePub(fromBase64Url(body.pub), 'スマホの公開鍵');
  const plain = utf8.encode(JSON.stringify({ pub: body.pub, name: body.name }));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: joinAad(deviceId) }, await joinKey(ticket), plain));
  return toBase64Url(concatBytes(iv, ct));
}

/** スマホの参加リクエストを開く（QR を表示した PC が呼ぶ）。券か ID が違う、壊れている、公開鍵が P-256 の点でないと E2eOpenError を投げる。 */
export async function openPhoneJoinRequest(ticket: string, deviceId: string, sealed: string): Promise<PhoneJoinBody> {
  const raw = fromBase64Url(sealed);
  if (!raw || raw.length < IV_LEN + TAG_LEN) throw new E2eOpenError();
  let v: Record<string, unknown> | null;
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: raw.slice(0, IV_LEN), additionalData: joinAad(deviceId) }, await joinKey(ticket), raw.slice(IV_LEN));
    v = JSON.parse(utf8.decode(new Uint8Array(plain))) as Record<string, unknown> | null;
  } catch {
    throw new E2eOpenError();
  }
  if (typeof v !== 'object' || v === null || typeof v.pub !== 'string' || typeof v.name !== 'string') throw new E2eOpenError();
  try {
    await importPhonePub(fromBase64Url(v.pub), 'スマホの公開鍵');
  } catch {
    throw new E2eOpenError();
  }
  return { pub: v.pub, name: v.name };
}

const keyboxAad = (epoch: number, phoneId: string): Uint8Array<ArrayBuffer> => utf8.encode(JSON.stringify(['phone-keybox', 'P-256', epoch, phoneId]));

async function phoneBoxKey(shared: Uint8Array, ephPub: Uint8Array, phonePub: Uint8Array): Promise<CryptoKey> {
  return importAesKey(await hkdf(shared, concatBytes(ephPub, phonePub), PHONE_KEYBOX_INFO, 32));
}

/**
 * スマホ用の鍵 M[epoch] をスマホの公開鍵に封じる（PC が呼び、戻りを base64url にして `PUT /phone-keyboxes` に置く）。
 * 封じるたびに使い捨ての P-256 の鍵ペアを作る。
 */
export async function sealPhoneKeybox(phonePub: string, phoneId: string, epoch: number, phoneKey: Uint8Array): Promise<Uint8Array> {
  if (!(phoneKey instanceof Uint8Array) || phoneKey.length !== PHONE_KEY_LEN) throw new TypeError(`スマホ用の鍵の形が違います（${PHONE_KEY_LEN} バイト）`);
  const recipientRaw = fromBase64Url(phonePub);
  const recipient = await importPhonePub(recipientRaw, 'スマホの公開鍵');
  const eph = (await subtle().generateKey(P256, false, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const key = await phoneBoxKey(await p256Bits(eph.privateKey, recipient), ephPub, recipientRaw!);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: keyboxAad(epoch, phoneId) }, key, phoneKey as BufferSource));
  return concatBytes(ephPub, iv, ct);
}

/**
 * `GET /m/keybox` の応答（`KeyboxOut`）をスマホの秘密鍵で開き、M の生の 32 バイトを返す（スマホが呼ぶ）。
 * 世代、宛先、鍵ペアのどれが違っても、中身が 32 バイトでなくても E2eOpenError を投げる。
 */
export async function openPhoneKeybox(priv: CryptoKey, pub: string, phoneId: string, box: { epoch: number; sealed: string }): Promise<Uint8Array> {
  const raw = typeof box.sealed === 'string' ? fromBase64Url(box.sealed) : null;
  if (!raw || raw.length < PHONE_PUB_LEN + IV_LEN + TAG_LEN) throw new E2eOpenError();
  let out: Uint8Array;
  try {
    const me = fromBase64Url(pub);
    if (!me || me.length !== PHONE_PUB_LEN) throw new E2eOpenError();
    const ephPub = raw.slice(0, PHONE_PUB_LEN);
    const key = await phoneBoxKey(await p256Bits(priv, await importPhonePub(ephPub, '使い捨ての公開鍵')), ephPub, me);
    const iv = raw.slice(PHONE_PUB_LEN, PHONE_PUB_LEN + IV_LEN);
    out = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: keyboxAad(box.epoch, phoneId) }, key, raw.slice(PHONE_PUB_LEN + IV_LEN)));
  } catch {
    throw new E2eOpenError();
  }
  if (out.length !== PHONE_KEY_LEN) throw new E2eOpenError();
  return out;
}
