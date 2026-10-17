import { describe, expect, it } from 'vitest';
import { utf8 } from './bytes.ts';
import { generateKeyPair, importPrivate, randomEpochKey } from './keys.ts';
import { E2eOpenError } from './seal.ts';
import { KEYBOX_INFO, decodeEpochList, encodeEpochList, openKeybox, sealKeybox } from './keybox.ts';

const aad = { epoch: 1, recipient: 'pc-b' };
const content = utf8.encode('keybox の中身');

describe('keybox', () => {
  it('info は hangar-keybox-v1', () => {
    expect(KEYBOX_INFO).toBe('hangar-keybox-v1');
  });

  it('相手の秘密鍵で開ける', async () => {
    const b = await generateKeyPair();
    const sealed = await sealKeybox(b.pub, aad, content);
    expect(sealed.length).toBe(32 + 12 + content.length + 16);
    const opened = await openKeybox(await importPrivate(b.priv), b.pub, aad, sealed);
    expect(utf8.decode(opened)).toBe('keybox の中身');
  });

  it('別の相手の秘密鍵では開けない', async () => {
    const b = await generateKeyPair();
    const c = await generateKeyPair();
    const sealed = await sealKeybox(b.pub, aad, content);
    await expect(openKeybox(await importPrivate(c.priv), c.pub, aad, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    // 秘密鍵が別で公開鍵だけ合わせても開けない。
    await expect(openKeybox(await importPrivate(c.priv), b.pub, aad, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('AAD の epoch か recipient が違うと開けない', async () => {
    const b = await generateKeyPair();
    const priv = await importPrivate(b.priv);
    const sealed = await sealKeybox(b.pub, aad, content);
    await expect(openKeybox(priv, b.pub, { ...aad, epoch: 2 }, sealed)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openKeybox(priv, b.pub, { ...aad, recipient: 'recovery' }, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('短すぎる BLOB は E2eOpenError', async () => {
    const b = await generateKeyPair();
    await expect(openKeybox(await importPrivate(b.priv), b.pub, aad, new Uint8Array(40))).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('世代 1〜3 の一覧が往復する', async () => {
    const list = { epochs: { '1': randomEpochKey(), '2': randomEpochKey(), '3': randomEpochKey() } };
    const b = await generateKeyPair();
    const sealed = await sealKeybox(b.pub, { epoch: 3, recipient: 'pc-b' }, encodeEpochList(list));
    const opened = await openKeybox(await importPrivate(b.priv), b.pub, { epoch: 3, recipient: 'pc-b' }, sealed);
    expect(decodeEpochList(opened)).toEqual(list);
  });

  it('形の違う一覧は decodeEpochList で断る', () => {
    expect(() => decodeEpochList(utf8.encode('not json'))).toThrow(E2eOpenError);
    expect(() => decodeEpochList(utf8.encode(JSON.stringify({ epochs: { '1': 'short' } })))).toThrow(E2eOpenError);
    expect(() => decodeEpochList(utf8.encode(JSON.stringify({ epochs: { x: randomEpochKey() } })))).toThrow(E2eOpenError);
    expect(() => decodeEpochList(utf8.encode(JSON.stringify({ epochs: [] })))).toThrow(E2eOpenError);
  });
});
