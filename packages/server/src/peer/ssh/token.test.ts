import { describe, expect, it } from 'vitest';
import { Keyring } from '../../sync/keyring.ts';
import { testCloudConfig, testKey } from '../../../test/cloudConfig.ts';
import { issuePeerToken, keyringPeerTokenKeys, peerTokenEpoch, verifyPeerToken } from './token.ts';

const ring = async (epochs: Record<string, string>, currentEpoch: number) => keyringPeerTokenKeys(await Keyring.fromConfig(testCloudConfig({ epochs, currentEpoch })));

describe('PC どうしの token', () => {
  it('同じグループの今の世代の token は通る', async () => {
    const a = await ring({ '1': testKey(3) }, 1);
    const b = await ring({ '1': testKey(3) }, 1);
    const tok = await issuePeerToken(a, 'pc-a', 'pc-b');
    expect(tok).toMatch(/^hpeer1\.1\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyPeerToken(b, tok, 'pc-a', 'pc-b')).toBe(true);
  });

  it('別のグループ（別の世代鍵）の token は断る', async () => {
    const other = await ring({ '1': testKey(9) }, 1);
    const b = await ring({ '1': testKey(3) }, 1);
    expect(await verifyPeerToken(b, await issuePeerToken(other, 'pc-a', 'pc-b'), 'pc-a', 'pc-b')).toBe(false);
  });

  it('受ける側の今の世代より古い世代の token は断る（解除で回した後）', async () => {
    const old = await ring({ '1': testKey(3) }, 1);
    const b = await ring({ '1': testKey(3), '2': testKey(4) }, 2);
    expect(await verifyPeerToken(b, await issuePeerToken(old, 'pc-a', 'pc-b'), 'pc-a', 'pc-b')).toBe(false);
  });

  it('受ける側より新しい世代でも、鍵を持っていれば通し、持っていなければ断る', async () => {
    const ahead = await ring({ '1': testKey(3), '2': testKey(4) }, 2);
    const tok = await issuePeerToken(ahead, 'pc-a', 'pc-b');
    expect(await verifyPeerToken(await ring({ '1': testKey(3), '2': testKey(4) }, 1), tok, 'pc-a', 'pc-b')).toBe(true);
    expect(await verifyPeerToken(await ring({ '1': testKey(3) }, 1), tok, 'pc-a', 'pc-b')).toBe(false);
  });

  it('from と to を入れ替えた token や、別の PC 宛ての token は断る', async () => {
    const k = await ring({ '1': testKey(3) }, 1);
    const tok = await issuePeerToken(k, 'pc-a', 'pc-b');
    expect(await verifyPeerToken(k, tok, 'pc-b', 'pc-a')).toBe(false);
    expect(await verifyPeerToken(k, tok, 'pc-a', 'pc-c')).toBe(false);
    expect(await verifyPeerToken(k, tok, 'pc-x', 'pc-b')).toBe(false);
  });

  it('利用者の token（16 進の 64 字）や崩れた形は断る', async () => {
    const k = await ring({ '1': testKey(3) }, 1);
    const tok = (await issuePeerToken(k, 'pc-a', 'pc-b'))!;
    for (const bad of ['a'.repeat(64), '', null, undefined, `${tok}x`, tok.replace('hpeer1', 'hpeer2'), tok.replace('.1.', '.01.'), `${tok.slice(0, -1)}${tok.endsWith('A') ? 'B' : 'A'}`]) {
      expect(await verifyPeerToken(k, bad, 'pc-a', 'pc-b')).toBe(false);
    }
    expect(peerTokenEpoch('a'.repeat(64))).toBeNull();
  });
});
