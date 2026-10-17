import { describe, expect, it } from 'vitest';
import { deriveEpochKeys, generateKeyPair, randomEpochKey } from './keys.ts';
import { generatePhoneKeyPair } from './phone.ts';
import { openRoster, sealRoster, type Roster } from './roster.ts';
import { E2eOpenError } from './seal.ts';

async function sample(): Promise<Roster> {
  return {
    v: 1,
    entries: [
      { id: 'pc-a', kind: 'pc', name: 'pc-a', os: 'darwin', pub: (await generateKeyPair()).pub, joinedAt: 1_700_000_000_000 },
      { id: 'phone-1', kind: 'phone', name: 'phone-1', os: 'ios', pub: (await generatePhoneKeyPair()).pub, joinedAt: 1_700_000_100_000 },
    ],
    recoveryPub: (await generateKeyPair()).pub,
    phoneKey: { epoch: 1, key: randomEpochKey() },
  };
}

describe('名簿の封', () => {
  it('封じて開けば元に戻る', async () => {
    const key = (await deriveEpochKeys(1, randomEpochKey())).roster;
    const r = await sample();
    expect(await openRoster(key, 4, await sealRoster(key, 4, r))).toEqual(r);
    const noPhone = { ...r, phoneKey: null };
    expect(await openRoster(key, 5, await sealRoster(key, 5, noPhone))).toEqual(noPhone);
  });

  it('公開鍵の形は種類で決まる（PC は X25519 の 32 バイト、スマホは P-256 の 65 バイト）', async () => {
    const key = (await deriveEpochKeys(1, randomEpochKey())).roster;
    const r = await sample();
    const x25519 = (await generateKeyPair()).pub;
    const p256 = (await generatePhoneKeyPair()).pub;
    const phoneWithX = { ...r, entries: [r.entries[0]!, { ...r.entries[1]!, pub: x25519 }] };
    const pcWithP = { ...r, entries: [{ ...r.entries[0]!, pub: p256 }, r.entries[1]!] };
    await expect(openRoster(key, 1, await sealRoster(key, 1, phoneWithX))).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openRoster(key, 1, await sealRoster(key, 1, pcWithP))).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('version が違うと開けない', async () => {
    const key = (await deriveEpochKeys(1, randomEpochKey())).roster;
    const sealed = await sealRoster(key, 4, await sample());
    await expect(openRoster(key, 5, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('世代の番号の確保（epochClaim）も封じて戻る。無い名簿は無いまま開け、形の違う確保は開けない', async () => {
    const key = (await deriveEpochKeys(1, randomEpochKey())).roster;
    const claimed: Roster = { ...(await sample()), epochClaim: { epoch: 3, by: 'pc-a' } };
    expect(await openRoster(key, 2, await sealRoster(key, 2, claimed))).toEqual(claimed);
    const plain = await openRoster(key, 3, await sealRoster(key, 3, await sample()));
    expect('epochClaim' in plain).toBe(false);
    const bad = { ...(await sample()), epochClaim: { epoch: '3', by: 'pc-a' } } as unknown as Roster;
    await expect(openRoster(key, 4, await sealRoster(key, 4, bad))).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('行の鍵では開けない（用途の鍵が別）', async () => {
    const ek = await deriveEpochKeys(1, randomEpochKey());
    const sealed = await sealRoster(ek.roster, 1, await sample());
    await expect(openRoster(ek.row, 1, sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });
});
