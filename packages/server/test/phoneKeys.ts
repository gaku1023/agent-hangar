import { fromBase64UrlLen, importMobileKey } from '@agent-hangar/shared';
import type { PhoneKey } from '../src/sync/keyring.ts';
import type { PhoneKeySource } from '../src/sync/phoneKeys.ts';
import { testKey } from './cloudConfig.ts';

/** 試験のスマホ用の鍵 M[1]（作り物の 32 バイト）。 */
export const PHONE_KEY_1 = testKey(9);
/** 試験のスマホ用の鍵 M[2]。 */
export const PHONE_KEY_2 = testKey(10);

/** base64url の M を AES-GCM の鍵にする。 */
export const phoneCryptoKey = (raw: string): Promise<CryptoKey> => importMobileKey(fromBase64UrlLen(raw, 32, 'phone key'));

/**
 * 決まった世代の M だけを持つ引き口。current はいちばん新しい世代、at は持っている世代だけを返す（名簿は読み直さない）。
 * asked には at で聞かれた世代を積む。
 */
export function fixedPhoneKeys(keys: Record<number, string> = { 1: PHONE_KEY_1 }): PhoneKeySource & { asked: number[] } {
  const cache = new Map<number, Promise<PhoneKey>>();
  const of = (epoch: number): Promise<PhoneKey> | null => {
    const raw = keys[epoch];
    if (raw === undefined) return null;
    if (!cache.has(epoch)) cache.set(epoch, phoneCryptoKey(raw).then((key) => ({ epoch, key })));
    return cache.get(epoch)!;
  };
  const asked: number[] = [];
  return {
    asked,
    current: async () => {
      const epochs = Object.keys(keys).map(Number);
      return epochs.length ? of(Math.max(...epochs)) : null;
    },
    at: async (epoch) => {
      asked.push(epoch);
      return of(epoch);
    },
  };
}
