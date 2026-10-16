import { describe, expect, it } from 'vitest';
import { generateKeyPair } from './keys.ts';
import { JOIN_CODE_ALPHABET, JOIN_CODE_LEN, deriveSas, generateJoinCode, joinCodeHash, normalizeJoinCode, openJoinRequest, sealJoinRequest } from './joinCode.ts';
import { E2eOpenError } from './seal.ts';

describe('参加コード', () => {
  it('字種は 30 字で長さは 8', () => {
    expect(JOIN_CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTVWXYZ23456789');
    expect(JOIN_CODE_ALPHABET.length).toBe(30);
    expect(JOIN_CODE_LEN).toBe(8);
  });

  it('generateJoinCode は XXXX-XXXX で、字種の外の文字を含まない', () => {
    const re = new RegExp(`^[${JOIN_CODE_ALPHABET}]{4}-[${JOIN_CODE_ALPHABET}]{4}$`);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const c = generateJoinCode();
      expect(c).toMatch(re);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(990);
  });

  it('normalizeJoinCode', () => {
    expect(normalizeJoinCode('k7qm2xfd')).toBe('K7QM2XFD');
    expect(normalizeJoinCode(' K7QM-2XFD ')).toBe('K7QM2XFD');
    expect(normalizeJoinCode('Ｋ７ＱＭ－２ＸＦＤ')).toBe('K7QM2XFD');
    expect(normalizeJoinCode('K7QM 2XFD')).toBe('K7QM2XFD');
    expect(normalizeJoinCode('K7QM-2XF0')).toBeNull();
    expect(normalizeJoinCode('K7QM2XF')).toBeNull();
    expect(normalizeJoinCode('K7QM2XFDA')).toBeNull();
    expect(normalizeJoinCode('')).toBeNull();
  });

  it('joinCodeHash は正規化したコードの SHA-256 の hex', async () => {
    const h = await joinCodeHash('K7QM-2XFD');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await joinCodeHash('k7qm2xfd')).toBe(h);
    expect(await joinCodeHash('K7QM-2XFE')).not.toBe(h);
    await expect(joinCodeHash('K7QM-2XF0')).rejects.toThrow();
  });

  it('deriveSas は 6 桁の数字で、公開鍵が違えば（ほぼ）別', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const sa = await deriveSas('K7QM-2XFD', a.pub);
    expect(sa).toMatch(/^[0-9]{6}$/);
    expect(await deriveSas('k7qm2xfd', a.pub)).toBe(sa);
    expect(await deriveSas('K7QM-2XFD', b.pub)).not.toBe(sa);
    expect(await deriveSas('K7QM-2XFE', a.pub)).not.toBe(sa);
  });

  it('参加リクエストは同じコードで開け、別のコードでは開けない', async () => {
    const code = generateJoinCode();
    const hash = await joinCodeHash(code);
    const body = { pub: (await generateKeyPair()).pub, name: 'pc-b', os: 'linux' };
    const sealed = await sealJoinRequest(code, hash, body);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed.includes('pc-b')).toBe(false);
    expect(await openJoinRequest(code.toLowerCase(), hash, sealed)).toEqual(body);
    let other = generateJoinCode();
    while (other === code) other = generateJoinCode();
    await expect(openJoinRequest(other, hash, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openJoinRequest(code, await joinCodeHash(other), sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });
});
