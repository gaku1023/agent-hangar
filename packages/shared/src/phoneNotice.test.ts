import { describe, expect, it } from 'vitest';
import { PHONE_NOTICE_SEALED_MAX, PHONE_NOTICE_TEXT_MAX, type PhoneNotice } from './mobile.ts';
import { MobileOpenError, aadPhoneNotice, importMobileKey, openPhoneNotice, phoneNoticeEpoch, seal, sealPhoneNotice } from './mobileCrypto.ts';
import * as shared from './index.ts';

/** 試験のスマホ用の鍵 M。n で埋めた 32 バイトなので、値ごとに見分けられる。 */
const keyBytes = (n: number): Uint8Array => new Uint8Array(32).fill(n);

const notice: PhoneNotice = { title: '会話 1', pcName: 'pc-a', sessionId: 'sess-1', count: 1 };

describe('スマホの通知の封じ（sealPhoneNotice / openPhoneNotice）', () => {
  it('取り出せない CryptoKey で封じて開くと元に戻る', async () => {
    const key = await importMobileKey(keyBytes(1));
    const sealed = await sealPhoneNotice(key, 3, notice);
    expect(sealed).toMatch(/^3\.[A-Za-z0-9_-]+$/);
    expect(await openPhoneNotice(key, sealed)).toEqual(notice);
  });

  it('生の 32 バイトの鍵でも封じて開ける。CryptoKey と生の鍵は互いに開ける', async () => {
    const raw = keyBytes(2);
    const key = await importMobileKey(raw);
    expect(await openPhoneNotice(key, await sealPhoneNotice(raw, 1, notice))).toEqual(notice);
    expect(await openPhoneNotice(raw, await sealPhoneNotice(key, 1, notice))).toEqual(notice);
  });

  it('封じた文字列の頭に世代があり、phoneNoticeEpoch で読める', async () => {
    const sealed = await sealPhoneNotice(keyBytes(1), 12, notice);
    expect(phoneNoticeEpoch(sealed)).toBe(12);
    for (const bad of ['', 'abc', '0.abc', '-1.abc', '1.', '1.a b', 'x.abc', '01.abc', 1 as unknown as string]) expect(phoneNoticeEpoch(bad)).toBeNull();
  });

  it('別の鍵では開けない', async () => {
    const sealed = await sealPhoneNotice(keyBytes(1), 1, notice);
    await expect(openPhoneNotice(keyBytes(2), sealed)).rejects.toBeInstanceOf(MobileOpenError);
  });

  it('世代を書き換えると開けない（AAD に世代が入る）', async () => {
    const sealed = await sealPhoneNotice(keyBytes(1), 1, notice);
    await expect(openPhoneNotice(keyBytes(1), `2${sealed.slice(1)}`)).rejects.toBeInstanceOf(MobileOpenError);
  });

  it('受信箱の素など別の用途の封じは開けない', async () => {
    const key = await importMobileKey(keyBytes(1));
    const other = await seal(key, 'feed:pc-a', notice);
    await expect(openPhoneNotice(key, `1.${other}`)).rejects.toBeInstanceOf(MobileOpenError);
    expect(aadPhoneNotice(4)).toBe('["phone-notice",4]');
  });

  it('壊れた文字列と、形の違う中身は MobileOpenError', async () => {
    const key = await importMobileKey(keyBytes(1));
    for (const bad of ['', 'x', '1.', '1.abc', 'nope.abcdabcdabcdabcdabcdabcdabcdabcd']) await expect(openPhoneNotice(key, bad)).rejects.toBeInstanceOf(MobileOpenError);
    const wrongShape = `1.${await seal(key, aadPhoneNotice(1), { title: 1, pcName: 'pc-a', sessionId: 's', count: 1 })}`;
    await expect(openPhoneNotice(key, wrongShape)).rejects.toBeInstanceOf(MobileOpenError);
    const zero = `1.${await seal(key, aadPhoneNotice(1), { ...notice, count: 0 })}`;
    await expect(openPhoneNotice(key, zero)).rejects.toBeInstanceOf(MobileOpenError);
  });

  it('長い題と PC の名前は PHONE_NOTICE_TEXT_MAX 字で切り、封じた文字列は上限に収まる', async () => {
    const long = { title: 'あ'.repeat(5000), pcName: 'い'.repeat(5000), sessionId: 's'.repeat(64), count: 3 };
    const sealed = await sealPhoneNotice(keyBytes(1), 1, long);
    expect(sealed.length).toBeLessThanOrEqual(PHONE_NOTICE_SEALED_MAX);
    const back = await openPhoneNotice(keyBytes(1), sealed);
    expect([...back.title]).toHaveLength(PHONE_NOTICE_TEXT_MAX);
    expect([...back.pcName]).toHaveLength(PHONE_NOTICE_TEXT_MAX);
    expect(back.count).toBe(3);
  });

  it('形の違う通知と世代は封じる前に TypeError', async () => {
    await expect(sealPhoneNotice(keyBytes(1), 0, notice)).rejects.toBeInstanceOf(TypeError);
    await expect(sealPhoneNotice(keyBytes(1), 1, { ...notice, count: 0 })).rejects.toBeInstanceOf(TypeError);
    await expect(sealPhoneNotice(new Uint8Array(16), 1, notice)).rejects.toBeInstanceOf(TypeError);
  });

  it('shared の入口から取れる', () => {
    expect(shared.sealPhoneNotice).toBe(sealPhoneNotice);
    expect(shared.openPhoneNotice).toBe(openPhoneNotice);
    expect(shared.phoneNoticeEpoch).toBe(phoneNoticeEpoch);
  });
});
