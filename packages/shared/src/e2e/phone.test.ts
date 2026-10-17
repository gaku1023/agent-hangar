import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url, toHex, utf8 } from './bytes.ts';
import { generateKeyPairNonExtractable } from './keys.ts';
import { openKeybox, sealKeybox } from './keybox.ts';
import { E2eOpenError } from './seal.ts';
import { openPhoneJoinRequest, openPhoneKeybox, phoneTicketHash, PHONE_KEY_LEN, sealPhoneJoinRequest, sealPhoneKeybox } from './phone.ts';

/** ペアリングの券は 8 字の参加コードとは違う形（Worker の乱数の文字列）である。 */
const TICKET = 'Qm9vcFRpY2tldF8xMjM0NQ';

describe('スマホの参加リクエスト（券で封じる）', () => {
  it('同じ券と ID で開け、中身は公開鍵と名前', async () => {
    const pair = await generateKeyPairNonExtractable();
    const sealed = await sealPhoneJoinRequest(TICKET, 'phone-1', { pub: pair.pub, name: 'iPhone' });
    expect(fromBase64Url(sealed)).not.toBeNull();
    expect(await openPhoneJoinRequest(TICKET, 'phone-1', sealed)).toEqual({ pub: pair.pub, name: 'iPhone' });
  });

  it('参加コードの正規化を通さない（22 字の券も、小文字や記号の入った券も封じられる）', async () => {
    const pair = await generateKeyPairNonExtractable();
    for (const t of [TICKET, 'abc-def_0OIl1', 'x']) {
      const sealed = await sealPhoneJoinRequest(t, 'phone-1', { pub: pair.pub, name: 'iPhone' });
      expect((await openPhoneJoinRequest(t, 'phone-1', sealed)).pub).toBe(pair.pub);
    }
  });

  it('券が違う、ID が違う、壊れていると E2eOpenError', async () => {
    const pair = await generateKeyPairNonExtractable();
    const sealed = await sealPhoneJoinRequest(TICKET, 'phone-1', { pub: pair.pub, name: 'iPhone' });
    await expect(openPhoneJoinRequest(`${TICKET}x`, 'phone-1', sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneJoinRequest(TICKET, 'phone-2', sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneJoinRequest(TICKET, 'phone-1', 'AAAA')).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneJoinRequest(TICKET, 'phone-1', '!!')).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('公開鍵の形が違うものは封じない', async () => {
    await expect(sealPhoneJoinRequest(TICKET, 'phone-1', { pub: 'short', name: 'iPhone' })).rejects.toThrow(TypeError);
  });

  it('券のハッシュは Worker の mobile_pairings.code_hash と同じ（UTF-8 の SHA-256 の hex）', async () => {
    const want = toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(TICKET))));
    expect(await phoneTicketHash(TICKET)).toBe(want);
  });
});

describe('スマホ用の鍵の keybox', () => {
  const M = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(PHONE_KEY_LEN));

  it('スマホの取り出せない秘密鍵で開け、中身は M の 32 バイト', async () => {
    const pair = await generateKeyPairNonExtractable();
    expect(pair.key.extractable).toBe(false);
    const m = M();
    const sealed = await sealPhoneKeybox(pair.pub, 'phone-1', 3, m);
    const got = await openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 3, sealed: toBase64Url(sealed) });
    expect([...got]).toEqual([...m]);
  });

  it('世代、宛先、鍵ペアのどれが違っても開けない', async () => {
    const pair = await generateKeyPairNonExtractable();
    const other = await generateKeyPairNonExtractable();
    const sealed = toBase64Url(await sealPhoneKeybox(pair.pub, 'phone-1', 3, M()));
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 4, sealed })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-2', { epoch: 3, sealed })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(other.key, other.pub, 'phone-1', { epoch: 3, sealed })).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 3, sealed: '@@' })).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('中身が 32 バイトでない keybox は E2eOpenError（PC の世代鍵の一覧と取り違えない）', async () => {
    const pair = await generateKeyPairNonExtractable();
    const sealed = toBase64Url(await sealKeybox(pair.pub, { epoch: 1, recipient: 'phone-1' }, utf8.encode('{"epochs":{}}')));
    await expect(openPhoneKeybox(pair.key, pair.pub, 'phone-1', { epoch: 1, sealed })).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('封じる側も 32 バイトでない鍵を断る', async () => {
    const pair = await generateKeyPairNonExtractable();
    await expect(sealPhoneKeybox(pair.pub, 'phone-1', 1, new Uint8Array(16))).rejects.toThrow(TypeError);
  });

  it('keybox の形（AAD）は PC の keybox と同じ sealKeybox／openKeybox', async () => {
    const pair = await generateKeyPairNonExtractable();
    const m = M();
    const sealed = await sealPhoneKeybox(pair.pub, 'phone-1', 2, m);
    expect([...(await openKeybox(pair.key, pair.pub, { epoch: 2, recipient: 'phone-1' }, sealed))]).toEqual([...m]);
  });
});
