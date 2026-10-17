import { toBase64Url } from '@agent-hangar/shared';
import type { CloudConfig } from '../src/config/cloud.ts';

/** 試験用の 32 バイトの鍵。中身が n で埋まっているので、値ごとに見分けられる。 */
export const testKey = (n: number): string => toBase64Url(new Uint8Array(32).fill(n));

/**
 * 試験用の cloud.json（版 2）。
 * 鍵は作り物の決まった値で、実物のクラウドとは何の関係も無い。
 */
export function testCloudConfig(over: Partial<CloudConfig> = {}): CloudConfig {
  return {
    v: 2,
    url: 'https://h.workers.dev',
    cloudId: 'cloud-test-1',
    deviceToken: 'test-device-token',
    keyPair: { pub: testKey(1), priv: testKey(2) },
    epochs: { '1': testKey(3) },
    currentEpoch: 1,
    phoneKey: null,
    rosterVersion: 0,
    workerName: null,
    accountId: null,
    dbName: null,
    bucketName: null,
    joinedAt: 1,
    ...over,
  };
}
