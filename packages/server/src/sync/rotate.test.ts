import { describe, expect, it } from 'vitest';
import { decodeEpochList, E2eOpenError, encodeEpochList, fromBase64Url, generateKeyPair, importPrivate, openKeybox, openRoster, RECOVERY_RECIPIENT, sealKeybox, toBase64Url, type KeyPairRaw } from '@agent-hangar/shared';
import { testKey } from '../../test/cloudConfig.ts';
import { seedCloud, type FakeWireClient } from '../../test/fake-cloud.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { openDb } from '../db/open.ts';
import { RevokedError } from './client.ts';
import { Keyring } from './keyring.ts';
import { RosterStore, type ConfigWriter } from './roster.ts';
import { readRotation, RevokeNotFoundError, RevokeSelfError, resumeRotation, revokeMember, revokePc, type RotateWire } from './rotate.ts';
import { SyncStateStore } from './state.ts';

/**
 * PC の解除と世代の回し（sync/rotate.ts）。
 * 偽のクラウドに 3 台（pc-a、pc-b、pc-c）を置き、pc-a が pc-c を解除する。
 * 落ちたときの再開は、同じ DB の sync_state と、cloud.json の写し（cfg.current）から部品を作り直して確かめる。
 */

type Pc = {
  id: string;
  wire: FakeWireClient;
  cfg: ConfigWriter & { current: CloudConfig };
  keyring: Keyring;
  roster: RosterStore;
  state: SyncStateStore;
};

const EPOCHS = { '1': testKey(31), '2': testKey(32) };

async function setup(ids = ['pc-a', 'pc-b', 'pc-c']) {
  const pairs: Record<string, KeyPairRaw> = {};
  for (const id of ids) pairs[id] = await generateKeyPair();
  const recovery = await generateKeyPair();
  const seeded = await seedCloud(ids.map((id) => ({ id, name: `${id}-name`, keyPair: pairs[id]! })), { epochs: { ...EPOCHS }, recoveryPub: recovery.pub });
  const db = openDb(':memory:');
  const state = new SyncStateStore(db);
  const pcOf = async (id: string, cloud: CloudConfig, s = state): Promise<Pc> => {
    const cfg = { current: cloud, read: () => cfg.current, write: (patch: Partial<CloudConfig>) => { cfg.current = { ...cfg.current, ...patch }; } };
    const keyring = await Keyring.fromConfig(cloud);
    const wire = seeded.wire.asDevice(id);
    return { id, wire, cfg, keyring, roster: new RosterStore(wire, keyring, cfg, id), state: s };
  };
  const a = await pcOf('pc-a', seeded.configs['pc-a']!);
  /** 落ちた後の起動の真似。同じ DB と、cloud.json の写しから作り直す。 */
  const restart = (pc: Pc) => pcOf(pc.id, pc.cfg.current, pc.state);
  return { seeded, wire: seeded.wire, a, pcOf, restart, pairs, recovery };
}

const opts = (pc: Pc, wire: RotateWire = pc.wire) => ({ client: wire, roster: pc.roster, keyring: pc.keyring, state: pc.state, cfg: pc.cfg, deviceId: pc.id });

/** その受け手宛ての、その世代の keybox を開いて世代鍵の一覧を返す。無ければ null。 */
async function boxFor(wire: FakeWireClient, recipient: string, epoch: number, pair: KeyPairRaw): Promise<Record<string, string> | null> {
  const sealed = wire.storeForScan().keyboxes.get(recipient)?.get(epoch);
  if (!sealed) return null;
  return decodeEpochList(await openKeybox(await importPrivate(pair.priv), pair.pub, { epoch, recipient }, fromBase64Url(sealed)!)).epochs;
}

/** 1 つの口だけ、呼ぶと落ちる線（アプリが途中で落ちた真似）。ほかの口は元の線へ渡す。 */
function crashingAt(w: FakeWireClient, method: keyof RotateWire): RotateWire {
  return Object.assign(Object.create(w) as FakeWireClient, { [method]: async () => { throw new Error('crashed'); } });
}

describe('revokeMember（設定の解除の口）', () => {
  it('PC なら世代を回し、スマホなら端末トークンだけを無効にし、知らない端末と自分自身は断る', async () => {
    const { wire, a } = await setup();
    wire.storeForScan().devices.set('phone-1', { id: 'phone-1', kind: 'mobile', joinedAt: 1, lastSeenAt: null, revokedAt: null, expiresAt: null });
    const phone = await revokeMember({ id: 'phone-1', ...opts(a) });
    expect(phone.revokedAt).not.toBeNull();
    expect(a.keyring.current().epoch).toBe(2);
    expect(wire.calls.some((c) => c.method === 'putKeyboxes')).toBe(false);

    await expect(revokeMember({ id: 'pc-z', ...opts(a) })).rejects.toBeInstanceOf(RevokeNotFoundError);
    await expect(revokeMember({ id: 'pc-a', ...opts(a) })).rejects.toBeInstanceOf(RevokeSelfError);

    const pc = await revokeMember({ id: 'pc-c', ...opts(a) });
    expect(pc.id).toBe('pc-c');
    expect(pc.revokedAt).not.toBeNull();
    expect(a.keyring.current().epoch).toBe(3);
  });
});

describe('revokePc', () => {
  it('端末トークンを無効にし、名簿から外し、残りの PC とリカバリーキーに世代 1〜n+1 の keybox を置き、以後は新しい世代で書く', async () => {
    const { wire, a, pairs, recovery, pcOf, seeded } = await setup();
    const device = await revokePc({ id: 'pc-c', ...opts(a) });
    expect(device?.id).toBe('pc-c');
    expect(device?.revokedAt).not.toBeNull();

    // 新しい世代は 3 で、cloud.json に書いてあり、今の世代になっている。
    const k3 = a.cfg.current.epochs['3'];
    expect(k3).toBeDefined();
    expect(a.cfg.current.currentEpoch).toBe(3);
    expect(a.keyring.current().epoch).toBe(3);
    expect(readRotation(a.state)).toBeNull();

    // 残りの PC（自分を含む）とリカバリーキーは、世代 1〜3 の全部を受け取る。
    const all = { ...EPOCHS, '3': k3 };
    expect(await boxFor(wire, 'pc-a', 3, pairs['pc-a']!)).toEqual(all);
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).toEqual(all);
    expect(await boxFor(wire, RECOVERY_RECIPIENT, 3, recovery)).toEqual(all);
    // 解除した PC には新しい世代の箱が無い。
    expect(wire.storeForScan().keyboxes.get('pc-c')?.has(3)).toBe(false);

    // 名簿から外れ、名簿は新しい世代で封じ直してある（古い世代の鍵では開けない）。
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    expect(await b.roster.refreshKeyboxes()).toBe(true);
    expect((await b.roster.read()).roster.entries.map((e) => e.id)).toEqual(['pc-a', 'pc-b']);
    const got = wire.roster!;
    const old = await Keyring.fromConfig(seeded.configs['pc-c']!);
    await expect(openRoster(old.at(2)!.roster, got.version, fromBase64Url(got.sealed)!)).rejects.toBeInstanceOf(E2eOpenError);

    // 解除した PC は、手元に新しい世代の鍵が無く、Worker からは 401 で断られる。
    expect(old.at(3)).toBeNull();
    await expect(wire.asDevice('pc-c').getKeyboxes()).rejects.toBeInstanceOf(RevokedError);
  });

  it('(4) の後で落ちても、次の起動で (5) から終わる。新しい世代鍵は (3) で cloud.json に書いたものを使う', async () => {
    const { wire, a, pairs, restart } = await setup();
    await expect(revokePc({ id: 'pc-c', ...opts(a, crashingAt(a.wire, 'putKeyboxes')) })).rejects.toThrow('crashed');
    expect(readRotation(a.state)).toEqual({ id: 'pc-c', newEpoch: 3, step: 'boxes' });
    const k3 = a.cfg.current.epochs['3']!;
    // 配り終えるまでは、書き込みに新しい世代を使わない（他の PC が開けない行を作らない）。
    expect(a.cfg.current.currentEpoch).toBe(2);
    expect(a.keyring.current().epoch).toBe(2);
    expect(wire.storeForScan().keyboxes.get('pc-b')?.has(3)).toBe(false);

    const again = await restart(a);
    expect(again.keyring.current().epoch).toBe(2);
    const before = wire.calls.filter((c) => c.method === 'revokeDevice').length;
    expect(await resumeRotation(opts(again))).toBe(true);
    // 解除はやり直さない。
    expect(wire.calls.filter((c) => c.method === 'revokeDevice').length).toBe(before);
    expect(again.cfg.current.epochs['3']).toBe(k3);
    expect(again.keyring.current().epoch).toBe(3);
    expect(readRotation(again.state)).toBeNull();
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).toEqual({ ...EPOCHS, '3': k3 });
    // 続けて起動しても、もう何もしない。
    expect(await resumeRotation(opts(await restart(again)))).toBe(false);
  });

  it('解除の口に届かずに落ちても、次の起動で解除からやり直す', async () => {
    const { wire, a, restart } = await setup();
    await expect(revokePc({ id: 'pc-c', ...opts(a, crashingAt(a.wire, 'revokeDevice')) })).rejects.toThrow('crashed');
    expect(readRotation(a.state)).toEqual({ id: 'pc-c', newEpoch: 3, step: 'revoke' });
    expect(wire.storeForScan().devices.get('pc-c')?.revokedAt).toBeNull();
    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(wire.storeForScan().devices.get('pc-c')?.revokedAt).not.toBeNull();
    expect(again.keyring.current().epoch).toBe(3);
  });

  it('名簿の書き換えが断られ続けて止まっても、次の起動で (3) で書いた鍵のまま (4) から続ける', async () => {
    const { wire, a, pairs, restart, pcOf, seeded } = await setup();
    wire.rejectRosterPuts = 3;
    await expect(revokePc({ id: 'pc-c', ...opts(a) })).rejects.toThrow();
    expect(readRotation(a.state)).toEqual({ id: 'pc-c', newEpoch: 3, step: 'roster' });
    const k3 = a.cfg.current.epochs['3']!;
    const again = await restart(a);
    await resumeRotation(opts(again));
    expect(again.cfg.current.epochs['3']).toBe(k3);
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).toEqual({ ...EPOCHS, '3': k3 });
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    await b.roster.refreshKeyboxes();
    expect((await b.roster.read()).roster.entries.map((e) => e.id)).toEqual(['pc-a', 'pc-b']);
  });

  it('自分自身は解除せず、何も記録しない', async () => {
    const { wire, a } = await setup();
    await expect(revokePc({ id: 'pc-a', ...opts(a) })).rejects.toBeInstanceOf(RevokeSelfError);
    expect(readRotation(a.state)).toBeNull();
    expect(wire.calls.some((c) => c.method === 'revokeDevice')).toBe(false);
  });

  it('途中の回しが残っていれば、別の PC の解除の前にそれを終わらせ、次の世代で回す', async () => {
    const { wire, a, pairs, restart } = await setup(['pc-a', 'pc-b', 'pc-c', 'pc-d']);
    await expect(revokePc({ id: 'pc-c', ...opts(a, crashingAt(a.wire, 'putKeyboxes')) })).rejects.toThrow('crashed');
    const again = await restart(a);
    await revokePc({ id: 'pc-d', ...opts(again) });
    expect(again.keyring.current().epoch).toBe(4);
    const k3 = again.cfg.current.epochs['3']!;
    const k4 = again.cfg.current.epochs['4']!;
    expect(await boxFor(wire, 'pc-b', 4, pairs['pc-b']!)).toEqual({ ...EPOCHS, '3': k3, '4': k4 });
    expect(wire.storeForScan().keyboxes.get('pc-d')?.has(3)).toBe(true);
    expect(wire.storeForScan().keyboxes.get('pc-d')?.has(4)).toBe(false);
    expect(wire.storeForScan().keyboxes.get('pc-c')?.has(3)).toBe(false);
    for (const id of ['pc-c', 'pc-d']) expect(wire.storeForScan().devices.get(id)?.revokedAt).not.toBeNull();
  });

  it('Worker が解除済みとする PC が名簿に残っていても、その PC には keybox を置かずに配り切る', async () => {
    const { wire, a, pairs } = await setup(['pc-a', 'pc-b', 'pc-c', 'pc-d']);
    // pc-d は前の解除で Worker では無効だが、名簿に残っている（名簿の書き換えの前に止まった名残）。
    wire.revoke('pc-d');
    await revokePc({ id: 'pc-c', ...opts(a) });
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).not.toBeNull();
    expect(wire.storeForScan().keyboxes.get('pc-d')?.has(3)).toBe(false);
  });

  it('Worker が知らない PC が名簿にあって keybox を断られたら、Worker がいるとする PC だけで置き直す', async () => {
    const { wire, a, pairs, recovery } = await setup(['pc-a', 'pc-b', 'pc-c', 'pc-d']);
    // pc-d は名簿にあるが Worker の devices に無い（承認の途中で止まった名残）。PUT /keyboxes は 400 で全部を断る。
    wire.storeForScan().devices.delete('pc-d');
    await revokePc({ id: 'pc-c', ...opts(a) });
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).not.toBeNull();
    expect(await boxFor(wire, RECOVERY_RECIPIENT, 3, recovery)).not.toBeNull();
    expect(wire.storeForScan().keyboxes.get('pc-d')?.has(3)).toBe(false);
    expect(a.keyring.current().epoch).toBe(3);
  });

  it('同じ世代を他の PC が先に配っていたら、その鍵を受け入れ、次の世代で回し直す', async () => {
    const { wire, a, pairs, restart } = await setup();
    await expect(revokePc({ id: 'pc-c', ...opts(a, crashingAt(a.wire, 'putKeyboxes')) })).rejects.toThrow('crashed');
    // 落ちている間に、pc-b が別の解除で世代 3 を作り、pc-a にも配った。
    const theirs = { ...EPOCHS, '3': testKey(77) };
    const box = await sealKeybox(pairs['pc-a']!.pub, { epoch: 3, recipient: 'pc-a' }, encodeEpochList({ epochs: theirs }));
    wire.asDevice('pc-b').putKeybox('pc-a', 3, toBase64Url(box));
    const again = await restart(a);
    let gained = 0;
    await resumeRotation({ ...opts(again), onGained: () => { gained++; } });
    expect(again.cfg.current.epochs['3']).toBe(testKey(77));
    expect(again.keyring.current().epoch).toBe(4);
    expect(gained).toBeGreaterThan(0);
    const k4 = again.cfg.current.epochs['4']!;
    expect(await boxFor(wire, 'pc-b', 4, pairs['pc-b']!)).toEqual({ ...theirs, '4': k4 });
    expect(wire.storeForScan().keyboxes.get('pc-c')?.has(4)).toBe(false);
  });
});
