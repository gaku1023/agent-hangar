/**
 * 試験の中のブラウザ（Web Push の受け手）の役である。
 * 購読の鍵ペア（ECDH P-256）と auth を作り、RFC 8291（aes128gcm）の手順で届いた本文を開く。
 * Worker の実装（src/webpush.ts）を使わずに、RFC の手順をここで別に書く。
 */

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export const unb64u = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, 'base64url'));

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array<ArrayBuffer>> {
  const k = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, k, len * 8));
}

export type PushPeer = { priv: CryptoKey; pub: Uint8Array<ArrayBuffer>; auth: Uint8Array<ArrayBuffer>; p256dh: string; authText: string };

/** 購読の鍵を作る。p256dh と authText は `PushSubscription.toJSON().keys` と同じ形（base64url）。 */
export async function newPeer(): Promise<PushPeer> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return { priv: pair.privateKey, pub, auth, p256dh: b64u(pub), authText: b64u(auth) };
}

/** 秘密鍵（d の base64url）と公開鍵（raw の base64url）から ECDH の秘密鍵を作る。RFC の試験ベクトル用。 */
export async function importEcdhPrivate(d: string, pubRaw: Uint8Array, usages: KeyUsage[] = ['deriveBits']): Promise<CryptoKey> {
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', d, x: b64u(pubRaw.slice(1, 33)), y: b64u(pubRaw.slice(33, 65)), ext: true };
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, usages);
}

/** RFC 8291 の本文（RFC 8188 の頭つき、記録は 1 つ）を受け手の鍵で開き、元の本文を返す。 */
export async function openPush(body: Uint8Array, peer: { priv: CryptoKey; pub: Uint8Array; auth: Uint8Array }): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPub as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, peer.priv, 256));
  const ikm = await hkdf(peer.auth, ecdh, cat(enc.encode('WebPush: info\0'), peer.pub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 0x02) throw new Error('最後の記録の区切り（0x02）がありません');
  return plain.slice(0, end - 1);
}

/** 本文の頭の rs（記録の大きさ）を読む。 */
export const recordSizeOf = (body: Uint8Array): number => new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16);

/**
 * `Authorization: vapid t=<JWT>, k=<公開鍵>` を読み、JWT の署名を k の公開鍵で確かめて、頭と主張を返す。
 * 署名が合わなければ投げる。
 */
export async function verifyVapid(header: string | null): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown>; k: string }> {
  const m = /^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/.exec(header ?? '');
  if (!m) throw new Error(`Authorization の形が違います: ${header}`);
  const [h, c, s] = m[1]!.split('.');
  const pub = await subtle.importKey('raw', unb64u(m[2]!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(s!), enc.encode(`${h}.${c}`));
  if (!ok) throw new Error('VAPID の署名が公開鍵で確かめられません');
  return { header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')), claims: JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')), k: m[2]! };
}
