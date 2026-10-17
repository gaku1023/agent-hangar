import { describe, expect, it } from 'vitest';
import { aadFeed, generateKeyPair, open, seal } from '@agent-hangar/shared';
import type { CloudConfig } from '../config/cloud.ts';
import { seedCloud } from '../../test/fake-cloud.ts';
import { PHONE_KEY_1, PHONE_KEY_2, phoneCryptoKey } from '../../test/phoneKeys.ts';
import { Keyring } from './keyring.ts';
import { phoneKeysOf } from './phoneKeys.ts';
import { RosterStore, type ConfigWriter } from './roster.ts';

// スマホ用の鍵の引き口（sync/phoneKeys.ts）と、名簿の phoneKey を Keyring と cloud.json に写すこと（sync/roster.ts）の試験。

async function world() {
  const seeded = await seedCloud([
    { id: 'pc-a', name: 'pc-a', keyPair: await generateKeyPair() },
    { id: 'pc-b', name: 'pc-b', keyPair: await generateKeyPair() },
  ]);
  const pcOf = async (id: string) => {
    let cfg: CloudConfig = seeded.configs[id]!;
    const writer: ConfigWriter = { read: () => cfg, write: (p) => { cfg = { ...cfg, ...p }; } };
    const keyring = await Keyring.fromConfig(cfg);
    const wire = id === 'pc-a' ? seeded.wire : seeded.wire.asDevice(id);
    return { keyring, roster: new RosterStore(wire, keyring, writer, id), cfg: () => cfg, wire };
  };
  return { wire: seeded.wire, a: await pcOf('pc-a'), b: await pcOf('pc-b') };
}

const getRosters = (w: { calls: { method: string }[] }): number => w.calls.filter((c) => c.method === 'getRoster').length;

describe('phoneKeysOf', () => {
  it('名簿に phoneKey が無ければ current は null で、名簿に入ると読んだ PC の Keyring と cloud.json に写る', async () => {
    const w = await world();
    const keys = phoneKeysOf(w.a.keyring, w.a.roster);
    expect(await keys.current()).toBeNull();
    await w.b.roster.update((r) => ({ ...r, phoneKey: { epoch: 1, key: PHONE_KEY_1 } }));
    // 書いた PC には、書いた時点で写る。
    expect(w.b.keyring.phoneKey()?.epoch).toBe(1);
    expect(w.b.cfg().phoneKey).toEqual({ epoch: 1, key: PHONE_KEY_1 });
    w.a.roster.invalidate();
    await w.a.roster.read();
    const cur = await keys.current();
    expect(cur?.epoch).toBe(1);
    expect(w.a.cfg().phoneKey).toEqual({ epoch: 1, key: PHONE_KEY_1 });
    // 写した鍵で封じたものは M[1] で開ける。
    const sealed = await seal(cur!.key, aadFeed('pc-a'), { x: 1 });
    expect(await open(await phoneCryptoKey(PHONE_KEY_1), aadFeed('pc-a'), sealed)).toEqual({ x: 1 });
  });

  it('手元より新しい世代を聞かれたら名簿を読み直し、古い世代と読み直しても無い世代は null（名簿を読まない、または 1 回だけ）', async () => {
    const w = await world();
    await w.a.roster.update((r) => ({ ...r, phoneKey: { epoch: 1, key: PHONE_KEY_1 } }));
    const keys = phoneKeysOf(w.a.keyring, w.a.roster);
    expect((await keys.at(1))?.epoch).toBe(1);
    // 他の PC がスマホを解除して M を次の世代にした。
    w.b.roster.invalidate();
    await w.b.roster.update((r) => ({ ...r, phoneKey: { epoch: 2, key: PHONE_KEY_2 } }));
    const before = getRosters(w.a.wire);
    const k2 = await keys.at(2);
    expect(k2?.epoch).toBe(2);
    expect(getRosters(w.a.wire)).toBe(before + 1);
    expect((await keys.current())?.epoch).toBe(2);
    // 手元より古い世代は持たないので null で、名簿も読まない。
    expect(await keys.at(1)).toBeNull();
    expect(getRosters(w.a.wire)).toBe(before + 1);
    // 名簿にも無い世代は、読み直しても null。
    expect(await keys.at(3)).toBeNull();
    expect(getRosters(w.a.wire)).toBe(before + 2);
  });

  it('名簿にも無い新しい世代を同じ世代で聞き直されても、最後の読み直しから 10 秒は名簿を読み直さない', async () => {
    const w = await world();
    await w.a.roster.update((r) => ({ ...r, phoneKey: { epoch: 1, key: PHONE_KEY_1 } }));
    const clock = { now: 1_000_000 };
    const keys = phoneKeysOf(w.a.keyring, w.a.roster, () => clock.now);
    const before = getRosters(w.a.wire);
    expect(await keys.at(3)).toBeNull();
    expect(getRosters(w.a.wire)).toBe(before + 1);
    clock.now += 9_999;
    expect(await keys.at(3)).toBeNull();
    expect(getRosters(w.a.wire)).toBe(before + 1);
    // 別の世代なら読み直す。
    expect(await keys.at(4)).toBeNull();
    expect(getRosters(w.a.wire)).toBe(before + 2);
    // 10 秒たてば、同じ世代でも読み直す。その間に他の PC が回していれば見つかる。
    w.b.roster.invalidate();
    await w.b.roster.update((r) => ({ ...r, phoneKey: { epoch: 3, key: PHONE_KEY_2 } }));
    clock.now += 10_001;
    expect((await keys.at(3))?.epoch).toBe(3);
    expect(getRosters(w.a.wire)).toBe(before + 3);
  });

  it('名簿の phoneKey より新しい世代を手元に持っていれば、古い世代に戻さない', async () => {
    const w = await world();
    await w.a.keyring.setPhoneKey({ epoch: 2, key: PHONE_KEY_2 });
    await w.b.roster.update((r) => ({ ...r, phoneKey: { epoch: 1, key: PHONE_KEY_1 } }));
    w.a.roster.invalidate();
    await w.a.roster.read();
    expect(w.a.keyring.phoneKey()?.epoch).toBe(2);
  });
});
