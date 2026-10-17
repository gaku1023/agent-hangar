import { describe, expect, it } from 'vitest';
import { concatBytes, fromBase64Url, toBase64Url, toHex, utf8 } from './bytes.ts';
import { generateKeyPair, hkdf, importAesKey } from './keys.ts';
import { sealKeybox } from './keybox.ts';
import { E2eOpenError } from './seal.ts';
import {
  generatePhoneKeyPair,
  isPhonePub,
  openPhoneJoinRequest,
  openPhoneKeybox,
  PHONE_KEY_LEN,
  PHONE_KEYBOX_INFO,
  PHONE_PUB_LEN,
  phoneTicketHash,
  sealPhoneJoinRequest,
  sealPhoneKeybox,
} from './phone.ts';

/** ペアリングの券は 8 字の参加コードとは違う形（Worker の乱数の文字列）である。 */
const TICKET = 'Qm9vcFRpY2tldF8xMjM0NQ';

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

describe('スマホの鍵ペア（ECDH P-256）', () => {
  it('秘密鍵は取り出せない P-256 の CryptoKey で、exportKey できない', async () => {
    const pair = await generatePhoneKeyPair();
    expect(pair.key.extractable).toBe(false);
    expect(pair.key.algorithm).toMatchObject(P256);
    expect(pair.key.usages).toEqual(['deriveBits']);
    for (const f of ['pkcs8', 'jwk', 'raw'] as const) await expect(globalThis.crypto.subtle.exportKey(f, pair.key)).rejects.toThrow();
  });

  it('公開鍵は raw の非圧縮点（65 バイト、先頭 0x04）の base64url', async () => {
    const pair = await generatePhoneKeyPair();
    const raw = fromBase64Url(pair.pub)!;
    expect(raw.length).toBe(PHONE_PUB_LEN);
    expect(raw[0]).toBe(0x04);
    expect(isPhonePub(pair.pub)).toBe(true);
  });

  it('X25519 の公開鍵や形の違う値は、スマホの公開鍵として扱わない', async () => {
    expect(isPhonePub((await generateKeyPair()).pub)).toBe(false);
    expect(isPhonePub(toBase64Url(new Uint8Array(65)))).toBe(false);
    expect(isPhonePub('short')).toBe(false);
    expect(isPhonePub(42)).toBe(false);
  });
});

describe('スマホの参加リクエスト（券で封じる）', () => {
  it('同じ券と ID で開け、中身は公開鍵と名前', async () => {
    const pair = await generatePhoneKeyPair();
    const sealed = await sealPhoneJoinRequest(TICKET, 'phone-1', { pub: pair.pub, name: 'iPhone' });
    expect(fromBase64Url(sealed)).not.toBeNull();
    expect(await openPhoneJoinRequest(TICKET, 'phone-1', sealed)).toEqual({ pub: pair.pub, name: 'iPhone' });
  });

  it('参加コードの正規化を通さない（22 字の券も、小文字や記号の入った券も封じられる）', async () => {
    const pair = await generatePhoneKeyPair();
    for (const t of [TICKET, 'abc-def_0OIl1', 'x']) {
      const sealed = await sealPhoneJoinRequest(t, 'phone-1', { pub: pair.pub, name: 'iPhone' });
      expect((await openPhoneJoinRequest(t, 'phone-1', sealed)).pub).toBe(pair.pub);
    }
  });

  it('券が違う、ID が違う、壊れていると E2eOpenError', async () => {
    const pair = await generatePhoneKeyPair();
    const sealed = await sealPhoneJoinRequest(TICKET, 'phone-1', { pub: pair.pub, name: 'iPhone' });
    await expect(openPhoneJoinRequest(`${TICKET}x`, 'phone-1', sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneJoinRequest(TICKET, 'phone-2', sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneJoinRequest(TICKET, 'phone-1', 'AAAA')).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneJoinRequest(TICKET, 'phone-1', '!!')).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('P-256 の公開鍵でないものは封じない（X25519 の 32 バイト、曲線の上にない 65 バイト）', async () => {
    await expect(sealPhoneJoinRequest(TICKET, 'phone-1', { pub: 'short', name: 'iPhone' })).rejects.toThrow(TypeError);
    await expect(sealPhoneJoinRequest(TICKET, 'phone-1', { pub: (await generateKeyPair()).pub, name: 'iPhone' })).rejects.toThrow(TypeError);
    const offCurve = new Uint8Array(65);
    offCurve[0] = 0x04;
    offCurve[64] = 1;
    await expect(sealPhoneJoinRequest(TICKET, 'phone-1', { pub: toBase64Url(offCurve), name: 'iPhone' })).rejects.toThrow(TypeError);
  });

  it('券のハッシュは Worker の mobile_pairings.code_hash と同じ（UTF-8 の SHA-256 の hex）', async () => {
    const want = toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(TICKET))));
    expect(await phoneTicketHash(TICKET)).toBe(want);
  });
});

describe('スマホ用の鍵の keybox（P-256 の ECDH）', () => {
  const M = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(PHONE_KEY_LEN));

  /** 設計書どおりの形を、phone.ts を通さずに WebCrypto だけで組む（PC 側の実装と取り違えないための見本）。 */
  async function handSeal(phonePub: string, phoneId: string, epoch: number, content: Uint8Array): Promise<string> {
    const recipientRaw = fromBase64Url(phonePub)!;
    const recipient = await globalThis.crypto.subtle.importKey('raw', recipientRaw, P256, true, []);
    const eph = (await globalThis.crypto.subtle.generateKey(P256, false, ['deriveBits'])) as CryptoKeyPair;
    const ephPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', eph.publicKey));
    const shared = new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256));
    const key = await importAesKey(await hkdf(shared, concatBytes(ephPub, recipientRaw), 'hangar-phone-keybox-p256-v1', 32));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const aad = utf8.encode(JSON.stringify(['phone-keybox', 'P-256', epoch, phoneId]));
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, content as BufferSource));
    return toBase64Url(concatBytes(ephPub, iv, ct));
  }

  it('スマホの取り出せない秘密鍵で開け、中身は M の 32 バイト', async () => {
    const pair = await generatePhoneKeyPair();
    const m = M();
    const sealed = await sealPhoneKeybox(pair.pub, 'phone-1', 3, m);
    expect(sealed.length).toBe(PHONE_PUB_LEN + 12 + PHONE_KEY_LEN + 16);
    const got = await openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 3, sealed: toBase64Url(sealed) });
    expect([...got]).toEqual([...m]);
  });

  it('世代、宛先、鍵ペアのどれが違っても開けない', async () => {
    const pair = await generatePhoneKeyPair();
    const other = await generatePhoneKeyPair();
    const sealed = toBase64Url(await sealPhoneKeybox(pair.pub, 'phone-1', 3, M()));
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 4, sealed })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-2', { epoch: 3, sealed })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(other.key, other.pub, 'phone-1', { epoch: 3, sealed })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(other.key, pair.pub, 'phone-1', { epoch: 3, sealed })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 3, sealed: '@@' })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 3, sealed: 'AAAA' })).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('設計書の形（HKDF の info、AAD、使い捨ての公開鍵 65 バイト）で組んだ箱を開ける', async () => {
    expect(PHONE_KEYBOX_INFO).toBe('hangar-phone-keybox-p256-v1');
    const pair = await generatePhoneKeyPair();
    const m = M();
    expect([...(await openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 2, sealed: await handSeal(pair.pub, 'phone-1', 2, m) }))]).toEqual([...m]);
  });

  it('中身が 32 バイトでない keybox は E2eOpenError（PC の世代鍵の一覧と取り違えない）', async () => {
    const pair = await generatePhoneKeyPair();
    const sealed = await handSeal(pair.pub, 'phone-1', 1, utf8.encode('{"epochs":{}}'));
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 1, sealed })).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('PC どうしの X25519 の keybox はスマホの keybox として開けない', async () => {
    const pair = await generatePhoneKeyPair();
    const x = await generateKeyPair();
    const sealed = toBase64Url(await sealKeybox(x.pub,{ epoch: 1, recipient: 'phone-1' }, M()));
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 1, sealed })).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('封じる側は 32 バイトでない鍵と、P-256 でない公開鍵を断る', async () => {
    const pair = await generatePhoneKeyPair();
    await expect(sealPhoneKeybox(pair.pub, 'phone-1', 1, new Uint8Array(16))).rejects.toThrow(TypeError);
    await expect(sealPhoneKeybox((await generateKeyPair()).pub, 'phone-1', 1, M())).rejects.toThrow(TypeError);
  });

  it('封じるたびに使い捨ての鍵ペアが変わる（同じ M でも箱が違う）', async () => {
    const pair = await generatePhoneKeyPair();
    const m = M();
    const a = await sealPhoneKeybox(pair.pub, 'phone-1', 1, m);
    const b = await sealPhoneKeybox(pair.pub, 'phone-1', 1, m);
    expect(toBase64Url(a.slice(0, PHONE_PUB_LEN))).not.toBe(toBase64Url(b.slice(0, PHONE_PUB_LEN)));
  });
});
