import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toHex, utf8 } from './bytes.ts';
import { generateKeyPair } from './keys.ts';
import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LEN,
  JOIN_KDF_ITERATIONS,
  deriveJoinSecrets,
  deriveSas,
  generateJoinCode,
  joinCodeHash,
  normalizeJoinCode,
  openJoinRequest,
  sealJoinRequest,
  setJoinKdfIterationsForTests,
} from './joinCode.ts';
import { E2eOpenError } from './seal.ts';

const CLOUD = 'cloud-a-0123456789';
const OTHER_CLOUD = 'cloud-b-0123456789';
// 本番の回数（1 回 0.3 秒前後）では試験が重いので、ここでは減らす。本番の回数での相互運用は interop.test.ts が見る。
const TEST_ITERATIONS = 1000;
beforeAll(() => setJoinKdfIterationsForTests(TEST_ITERATIONS));
afterAll(() => setJoinKdfIterationsForTests(null));

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

  it('joinCodeHash は hex の 64 字で、正規化したコードとクラウドの ID だけで決まる', async () => {
    const h = await joinCodeHash('K7QM-2XFD', CLOUD);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await joinCodeHash('k7qm2xfd', CLOUD)).toBe(h);
    expect(await joinCodeHash('K7QM-2XFE', CLOUD)).not.toBe(h);
    // 別のクラウドでは別の値になる（クラウドをまたいだ前計算を効かなくする）。
    expect(await joinCodeHash('K7QM-2XFD', OTHER_CLOUD)).not.toBe(h);
    // 素の SHA-256 ではない（1 回の SHA-256 は総当たりに弱い）。
    const sha = toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode('K7QM2XFD'))));
    expect(h).not.toBe(sha);
    await expect(joinCodeHash('K7QM-2XF0', CLOUD)).rejects.toThrow(TypeError);
    await expect(joinCodeHash('K7QM-2XFD', '')).rejects.toThrow(TypeError);
  });

  it('deriveJoinSecrets の codeHash は joinCodeHash と同じ', async () => {
    const s = await deriveJoinSecrets('K7QM-2XFD', CLOUD);
    expect(s.codeHash).toBe(await joinCodeHash('K7QM-2XFD', CLOUD));
  });

  it('重い KDF の回数は 300 万回で、回数を変えれば値も変わり、正の整数でない回数は断る', async () => {
    expect(JOIN_KDF_ITERATIONS).toBe(3_000_000);
    const low = await joinCodeHash('K7QM-2XFD', CLOUD);
    setJoinKdfIterationsForTests(TEST_ITERATIONS + 1);
    try {
      expect(await joinCodeHash('K7QM-2XFD', CLOUD)).not.toBe(low);
    } finally {
      setJoinKdfIterationsForTests(TEST_ITERATIONS);
    }
    expect(() => setJoinKdfIterationsForTests(0)).toThrow(RangeError);
  });

  it('deriveSas は 6 桁の数字で、公開鍵、コード、クラウドのどれが違っても（ほぼ）別', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const sa = await deriveSas(await deriveJoinSecrets('K7QM-2XFD', CLOUD), a.pub);
    expect(sa).toMatch(/^[0-9]{6}$/);
    expect(await deriveSas(await deriveJoinSecrets('k7qm2xfd', CLOUD), a.pub)).toBe(sa);
    expect(await deriveSas(await deriveJoinSecrets('K7QM-2XFD', CLOUD), b.pub)).not.toBe(sa);
    expect(await deriveSas(await deriveJoinSecrets('K7QM-2XFE', CLOUD), a.pub)).not.toBe(sa);
    expect(await deriveSas(await deriveJoinSecrets('K7QM-2XFD', OTHER_CLOUD), a.pub)).not.toBe(sa);
  });

  it('参加リクエストは同じコードとクラウドで開け、別のコードや別のクラウドでは開けない', async () => {
    const code = generateJoinCode();
    const mine = await deriveJoinSecrets(code, CLOUD);
    const body = { pub: (await generateKeyPair()).pub, name: 'pc-b', os: 'linux' };
    const sealed = await sealJoinRequest(mine, body);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed.includes('pc-b')).toBe(false);
    // 新しい PC と発行した PC は、別々に導いても同じ値を出す。
    expect(await openJoinRequest(await deriveJoinSecrets(code.toLowerCase(), CLOUD), sealed)).toEqual(body);
    let other = generateJoinCode();
    while (other === code) other = generateJoinCode();
    await expect(openJoinRequest(await deriveJoinSecrets(other, CLOUD), sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openJoinRequest(await deriveJoinSecrets(code, OTHER_CLOUD), sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });
});
