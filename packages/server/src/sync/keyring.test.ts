import { describe, expect, it } from 'vitest';
import { deriveEpochKeys } from '@agent-hangar/shared';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';
import { Keyring } from './keyring.ts';

describe('Keyring', () => {
  it('今の世代の鍵を引け、知らない世代には null を返す', async () => {
    const k = await Keyring.fromConfig(testCloudConfig());
    expect(k.current().epoch).toBe(1);
    expect(k.at(1)).toBe(k.current());
    expect(k.at(2)).toBeNull();
    expect(k.at(0)).toBeNull();
    expect(k.phoneKey()).toBeNull();
  });

  it('導いた鍵は shared の deriveEpochKeys と同じ', async () => {
    const k = await Keyring.fromConfig(testCloudConfig());
    const want = await deriveEpochKeys(1, testKey(3));
    expect(k.current().fileBytes).toEqual(want.fileBytes);
  });

  it('addEpochs の後に at で引け、今の世代は一番新しいものに進む', async () => {
    const k = await Keyring.fromConfig(testCloudConfig());
    await k.addEpochs({ epochs: { '1': testKey(3), '2': testKey(4), '3': testKey(5) } });
    expect(k.at(2)?.epoch).toBe(2);
    expect(k.at(3)?.fileBytes).toEqual((await deriveEpochKeys(3, testKey(5))).fileBytes);
    expect(k.current().epoch).toBe(3);
    expect(k.toConfigPatch()).toEqual({ epochs: { '1': testKey(3), '2': testKey(4), '3': testKey(5) }, currentEpoch: 3, phoneKey: null });
  });

  it('手元にある世代の鍵を別の値で書き換えない', async () => {
    // keybox は署名を持たないので、手元にある世代の鍵を差し替える一覧は信じない。
    const k = await Keyring.fromConfig(testCloudConfig());
    const before = k.at(1);
    await k.addEpochs({ epochs: { '1': testKey(7) } });
    expect(k.at(1)).toBe(before);
    expect(k.toConfigPatch().epochs).toEqual({ '1': testKey(3) });
  });

  it('古い世代だけの一覧では今の世代を戻さない', async () => {
    const k = await Keyring.fromConfig(testCloudConfig({ epochs: { '2': testKey(4) }, currentEpoch: 2 }));
    await k.addEpochs({ epochs: { '1': testKey(3) } });
    expect(k.current().epoch).toBe(2);
    expect(k.at(1)?.epoch).toBe(1);
  });

  it('スマホ用の鍵を持ち、cloud.json の形で返す', async () => {
    const k = await Keyring.fromConfig(testCloudConfig({ phoneKey: { epoch: 1, key: testKey(9) } }));
    expect(k.phoneKey()?.epoch).toBe(1);
    expect(k.phoneKey()?.key.algorithm.name).toBe('AES-GCM');
    await k.setPhoneKey({ epoch: 2, key: testKey(10) });
    expect(k.phoneKey()?.epoch).toBe(2);
    expect(k.toConfigPatch().phoneKey).toEqual({ epoch: 2, key: testKey(10) });
    await k.setPhoneKey(null);
    expect(k.phoneKey()).toBeNull();
    expect(k.toConfigPatch().phoneKey).toBeNull();
  });

  it('今の世代の鍵が無い設定からは作らない', async () => {
    await expect(Keyring.fromConfig(testCloudConfig({ currentEpoch: 2 }))).rejects.toThrow();
  });
});
