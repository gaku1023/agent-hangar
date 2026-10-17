import { describe, expect, it, vi } from 'vitest';
import {
  aadFeed,
  generatePhoneKeyPair,
  importMobileKey,
  open,
  openPhoneKeybox,
  sealPhoneJoinRequest,
  type MobileFeed,
  type PhoneKeyPair,
  decodeEpochList,
  deriveEpochKeys,
  E2eOpenError,
  encodeEpochList,
  fromBase64Url,
  generateKeyPair,
  importPrivate,
  deriveJoinSecrets,
  openKeybox,
  openRoster,
  openRow,
  RECOVERY_RECIPIENT,
  sealJoinRequest,
  sealKeybox,
  sealRow,
  toBase64Url,
  type JoinSecrets,
  type KeyPairRaw,
  type RowAad,
} from '@agent-hangar/shared';
import { testKey } from '../../test/cloudConfig.ts';
import { FakeCloudClient, seedCloud, type FakeWireClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { openDb } from '../db/open.ts';
import { PhonePairer } from '../mobile/pairer.ts';
import { MobileFeedPublisher } from '../mobile/publisher.ts';
import { RevokedError } from './client.ts';
import { JoinApprover, type JoinTimers, type JoinWire } from './joinApprover.ts';
import { Keyring } from './keyring.ts';
import { phoneKeysOf } from './phoneKeys.ts';
import { RosterStore, type ConfigWriter } from './roster.ts';
import {
  DELIVER_RETRIES,
  readPhoneRevoke,
  readRotation,
  revokePhone,
  RevokeNotFoundError,
  RevokeSelfError,
  resumeRotation,
  retriesRotation,
  ROTATION_RETRY_MS,
  rotationRetrier,
  revokeMember,
  revokePc,
  type RotateWire,
} from './rotate.ts';
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
const CLOUD = 'cloud-test-1';

async function setup(ids = ['pc-a', 'pc-b', 'pc-c']) {
  const pairs: Record<string, KeyPairRaw> = {};
  for (const id of ids) pairs[id] = await generateKeyPair();
  const recovery = await generateKeyPair();
  const seeded = await seedCloud(ids.map((id) => ({ id, name: `${id}-name`, keyPair: pairs[id]! })), { epochs: { ...EPOCHS }, recoveryPub: recovery.pub });
  const pcOf = async (id: string, cloud: CloudConfig, s?: SyncStateStore): Promise<Pc> => {
    const cfg = { current: cloud, read: () => cfg.current, write: (patch: Partial<CloudConfig>) => { cfg.current = { ...cfg.current, ...patch }; } };
    const keyring = await Keyring.fromConfig(cloud);
    const wire = seeded.wire.asDevice(id);
    return { id, wire, cfg, keyring, roster: new RosterStore(wire, keyring, cfg, id), state: s ?? new SyncStateStore(openDb(':memory:')) };
  };
  const a = await pcOf(ids[0]!, seeded.configs[ids[0]!]!);
  /** 落ちた後の起動の真似。同じ DB と、cloud.json の写しから作り直す。 */
  const restart = (pc: Pc) => pcOf(pc.id, pc.cfg.current, pc.state);
  return { seeded, wire: seeded.wire, a, pcOf, restart, pairs, recovery };
}

/** 試し直しの間を待たない（次の周回へ譲るだけ）。 */
const quick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

const opts = (pc: Pc, wire: RotateWire = pc.wire, more: { sleep?: (ms: number) => Promise<void>; roster?: RosterStore } = {}) => ({
  client: wire,
  roster: more.roster ?? pc.roster,
  keyring: pc.keyring,
  state: pc.state,
  cfg: pc.cfg,
  deviceId: pc.id,
  sleep: more.sleep ?? quick,
});

const rotation = (pc: Pc) => readRotation(pc.state, pc.cfg.current.cloudId);

/** その受け手宛ての、その世代の keybox を開いて世代鍵の一覧を返す。無ければ null。 */
async function boxFor(wire: FakeWireClient, recipient: string, epoch: number, pair: KeyPairRaw): Promise<Record<string, string> | null> {
  const sealed = wire.storeForScan().keyboxes.get(recipient)?.get(epoch);
  if (!sealed) return null;
  return decodeEpochList(await openKeybox(await importPrivate(pair.priv), pair.pub, { epoch, recipient }, fromBase64Url(sealed)!)).epochs;
}

/** 受け手がいま GET /keyboxes で受け取る箱（いちばん新しい 1 つ）の世代と一覧。 */
async function newestBox(wire: FakeWireClient, recipient: string, pair: KeyPairRaw): Promise<{ epoch: number; epochs: Record<string, string> }> {
  const mine = wire.storeForScan().keyboxes.get(recipient)!;
  const epoch = Math.max(...mine.keys());
  return { epoch, epochs: (await boxFor(wire, recipient, epoch, pair))! };
}

/** 書く側の世代鍵で封じた行を、読む側の世代鍵で開けるか。 */
async function opens(writerKey: string, readerKey: string | undefined, epoch: number): Promise<boolean> {
  if (readerKey === undefined) return false;
  const aad: RowAad = { k: 'k-1', deviceId: 'pc-x', updatedAt: 1, op: 'upsert', epoch };
  const sealed = await sealRow((await deriveEpochKeys(epoch, writerKey)).row, aad, { tableName: 't', rowId: 'r', payload: { v: 1 } });
  try {
    await openRow((await deriveEpochKeys(epoch, readerKey)).row, aad, sealed);
    return true;
  } catch (e) {
    if (e instanceof E2eOpenError) return false;
    throw e;
  }
}

/** 1 つの口だけ、nth 回目に呼ぶと落ちる線（アプリが途中で落ちた真似）。ほかの口と、ほかの回は元の線へ渡す。 */
function crashingAt<W extends object>(w: W, method: keyof W & string, nth = 1): W {
  let n = 0;
  const orig = (w[method] as (...a: unknown[]) => Promise<unknown>).bind(w);
  return Object.assign(Object.create(w) as W, {
    [method]: async (...args: unknown[]) => {
      if (++n === nth) throw new Error('crashed');
      return orig(...args);
    },
  });
}

/** 1 つの口の前に、1 回だけ割り込む線。 */
function before<W extends object>(w: W, method: keyof W & string, hook: () => Promise<void>): W {
  let done = false;
  const orig = (w[method] as (...a: unknown[]) => Promise<unknown>).bind(w);
  return Object.assign(Object.create(w) as W, {
    [method]: async (...args: unknown[]) => {
      if (!done) {
        done = true;
        await hook();
      }
      return orig(...args);
    },
  });
}

describe('revokeMember（設定の解除の口）', () => {
  it('PC なら世代を回し、スマホなら端末トークンだけを無効にし、知らない端末と自分自身は断る', async () => {
    const { wire, a } = await setup();
    wire.storeForScan().devices.set('phone-1', { id: 'phone-1', kind: 'mobile', joinedAt: 1, lastSeenAt: null, revokedAt: null, expiresAt: null });
    const phone = await revokeMember({ id: 'phone-1', ...opts(a) });
    expect(phone.revokedAt).not.toBeNull();
    expect(a.keyring.current().epoch).toBe(2);
    expect(a.wire.calls.some((c) => c.method === 'putKeyboxes')).toBe(false);

    await expect(revokeMember({ id: 'pc-z', ...opts(a) })).rejects.toBeInstanceOf(RevokeNotFoundError);
    await expect(revokeMember({ id: 'pc-a', ...opts(a) })).rejects.toBeInstanceOf(RevokeSelfError);

    const pc = await revokeMember({ id: 'pc-c', ...opts(a) });
    expect(pc.id).toBe('pc-c');
    expect(pc.revokedAt).not.toBeNull();
    expect(a.keyring.current().epoch).toBe(3);
  });

  it('すでに解除した端末には何もせず、今の行を返す（世代を空回りさせない）', async () => {
    const { a } = await setup();
    await revokeMember({ id: 'pc-c', ...opts(a) });
    const calls = a.wire.calls.length;
    const again = await revokeMember({ id: 'pc-c', ...opts(a) });
    expect(again.revokedAt).not.toBeNull();
    expect(a.keyring.current().epoch).toBe(3);
    expect(a.wire.calls.slice(calls).map((c) => c.method)).toEqual(['listDevices']);
    // revokePc を直に呼んでも同じ。
    expect((await revokePc({ id: 'pc-c', ...opts(a) }))?.revokedAt).not.toBeNull();
    expect(a.keyring.current().epoch).toBe(3);
  });

  it('途中の回しの続きで終えたときも、解除の後の行を返す（解除の前の行を返さない）', async () => {
    const { a, restart } = await setup();
    await expect(revokePc({ id: 'pc-c', ...opts(a, crashingAt(a.wire, 'putKeyboxes')) })).rejects.toThrow('crashed');
    const again = await restart(a);
    const row = await revokeMember({ id: 'pc-c', ...opts(again) });
    expect(row.revokedAt).not.toBeNull();
    expect(again.keyring.current().epoch).toBe(3);
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
    expect(rotation(a)).toBeNull();

    // 残りの PC（自分を含む）とリカバリーキーは、世代 1〜3 の全部を受け取る。
    const all = { ...EPOCHS, '3': k3 };
    expect(await boxFor(wire, 'pc-a', 3, pairs['pc-a']!)).toEqual(all);
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).toEqual(all);
    expect(await boxFor(wire, RECOVERY_RECIPIENT, 3, recovery)).toEqual(all);
    // 解除した PC には新しい世代の箱が無い。
    expect(wire.storeForScan().keyboxes.get('pc-c')?.has(3)).toBe(false);

    // 名簿から外れ、世代 3 を pc-a が確保したと書いてあり、名簿は新しい世代で封じ直してある（古い世代の鍵では開けない）。
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    expect(await b.roster.refreshKeyboxes()).toBe(true);
    const read = (await b.roster.read()).roster;
    expect(read.entries.map((e) => e.id)).toEqual(['pc-a', 'pc-b']);
    expect(read.epochClaim).toEqual({ epoch: 3, by: 'pc-a' });
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
    expect(rotation(a)).toMatchObject({ id: 'pc-c', newEpoch: 3, step: 'boxes', cloudId: CLOUD });
    const k3 = a.cfg.current.epochs['3']!;
    // 配り終えるまでは、書き込みに新しい世代を使わない（他の PC が開けない行を作らない）。
    expect(a.cfg.current.currentEpoch).toBe(2);
    expect(a.keyring.current().epoch).toBe(2);
    expect(wire.storeForScan().keyboxes.get('pc-b')?.has(3)).toBe(false);

    const again = await restart(a);
    expect(again.keyring.current().epoch).toBe(2);
    expect(await resumeRotation(opts(again))).toBe(true);
    // 解除はやり直さない。
    expect(again.wire.calls.filter((c) => c.method === 'revokeDevice').length).toBe(0);
    expect(again.cfg.current.epochs['3']).toBe(k3);
    expect(again.keyring.current().epoch).toBe(3);
    expect(rotation(again)).toBeNull();
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).toEqual({ ...EPOCHS, '3': k3 });
    // 続けて起動しても、もう何もしない。
    expect(await resumeRotation(opts(await restart(again)))).toBe(false);
  });

  it('解除の口に届かずに落ちても、次の起動で解除からやり直す', async () => {
    const { wire, a, restart } = await setup();
    await expect(revokePc({ id: 'pc-c', ...opts(a, crashingAt(a.wire, 'revokeDevice')) })).rejects.toThrow('crashed');
    expect(rotation(a)).toMatchObject({ id: 'pc-c', newEpoch: 3, step: 'revoke' });
    expect(wire.storeForScan().devices.get('pc-c')?.revokedAt).toBeNull();
    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(wire.storeForScan().devices.get('pc-c')?.revokedAt).not.toBeNull();
    expect(again.keyring.current().epoch).toBe(3);
  });

  it('(3) で鍵を cloud.json に書いた直後に落ちても、次の起動でその鍵のまま続ける', async () => {
    const { wire, a, pairs, restart } = await setup();
    const write = a.cfg.write;
    let crashed = false;
    a.cfg.write = (patch) => {
      write(patch);
      if (!crashed && patch.epochs?.['3'] !== undefined) {
        crashed = true;
        throw new Error('crashed');
      }
    };
    await expect(revokePc({ id: 'pc-c', ...opts(a) })).rejects.toThrow('crashed');
    expect(rotation(a)).toMatchObject({ id: 'pc-c', newEpoch: 3, step: 'key' });
    const k3 = a.cfg.current.epochs['3']!;
    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(again.cfg.current.epochs['3']).toBe(k3);
    expect(again.keyring.current().epoch).toBe(3);
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).toEqual({ ...EPOCHS, '3': k3 });
  });

  it('(6) の名簿の封じ直しで落ちても、次の起動で (6) から終え、配った箱は配り直さない', async () => {
    const { wire, a, restart, seeded } = await setup();
    // 名簿の PUT の 2 回目（(6) の封じ直し）で落ちる。
    const roster = new RosterStore(crashingAt(a.wire, 'putRoster', 2), a.keyring, a.cfg, 'pc-a');
    await expect(revokePc({ id: 'pc-c', ...opts(a, a.wire, { roster }) })).rejects.toThrow('crashed');
    expect(rotation(a)).toMatchObject({ id: 'pc-c', newEpoch: 3, step: 'switch', sent: ['pc-a', 'pc-b'] });
    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(rotation(again)).toBeNull();
    expect(again.keyring.current().epoch).toBe(3);
    expect(again.wire.calls.filter((c) => c.method === 'putKeyboxes').length).toBe(0);
    const got = wire.roster!;
    const old = await Keyring.fromConfig(seeded.configs['pc-c']!);
    await expect(openRoster(old.at(2)!.roster, got.version, fromBase64Url(got.sealed)!)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('(5) の塊の途中で落ちても、次の起動で全部の受け手に配り終える', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `pc-${String(i).padStart(2, '0')}`);
    const { wire, pairs, recovery, pcOf, a } = await setup(ids);
    // 残りの 22 台とリカバリーキーで 23 個。20 個の塊の 2 つ目で落ちる。
    await expect(revokePc({ id: 'pc-22', ...opts(a, crashingAt(a.wire, 'putKeyboxes', 2)) })).rejects.toThrow('crashed');
    expect(rotation(a)).toMatchObject({ step: 'boxes' });
    const placed = ids.slice(0, 22).filter((id) => wire.storeForScan().keyboxes.get(id)?.has(3));
    expect(placed.length).toBe(20);
    const again = await pcOf('pc-00', a.cfg.current, a.state);
    expect(await resumeRotation(opts(again))).toBe(true);
    const k3 = again.cfg.current.epochs['3']!;
    for (const id of ids.slice(0, 22)) expect(await boxFor(wire, id, 3, pairs[id]!)).toEqual({ ...EPOCHS, '3': k3 });
    expect(await boxFor(wire, RECOVERY_RECIPIENT, 3, recovery)).toEqual({ ...EPOCHS, '3': k3 });
    expect(wire.storeForScan().keyboxes.get('pc-22')?.has(3)).toBe(false);
  });

  it('名簿の書き換えが断られ続けて止まっても、次の起動で (3) で書いた鍵のまま (4) から続ける', async () => {
    const { wire, a, pairs, restart, pcOf, seeded } = await setup();
    wire.rejectRosterPuts = 3;
    await expect(revokePc({ id: 'pc-c', ...opts(a) })).rejects.toThrow();
    expect(rotation(a)).toMatchObject({ id: 'pc-c', newEpoch: 3, step: 'roster' });
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
    const { a } = await setup();
    await expect(revokePc({ id: 'pc-a', ...opts(a) })).rejects.toBeInstanceOf(RevokeSelfError);
    expect(rotation(a)).toBeNull();
    expect(a.wire.calls.some((c) => c.method === 'revokeDevice')).toBe(false);
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

  it('記録が別のクラウドのもの（作り直しの前の名残）なら、捨てて再開しない', async () => {
    const { a } = await setup();
    a.state.set('rotation', JSON.stringify({ id: 'pc-c', newEpoch: 3, step: 'boxes', cloudId: 'cloud-before' }));
    expect(await resumeRotation(opts(a))).toBe(false);
    expect(a.state.get('rotation')).toBeNull();
    expect(a.wire.calls.length).toBe(0);
  });

  it('解除済みの自分（RevokedError）では再開を試し直さない。ほかの失敗は試し直す', () => {
    expect(retriesRotation(new RevokedError())).toBe(false);
    expect(retriesRotation(new Error('offline'))).toBe(true);
  });

  it('続きの試し直しは、起動の失敗と動いている間の解除の失敗のどちらでも 5 分後に 1 つだけ予約し、解除済みの自分と記録の無いときは予約しない', async () => {
    const queued: { fn: () => void; ms: number }[] = [];
    const timers = { set: (fn: () => void, ms: number) => { const h = { fn, ms }; queued.push(h); return h; }, clear: (h: unknown) => { queued.splice(queued.indexOf(h as never), 1); } };
    let fails: unknown[] = [new Error('offline')];
    let resumed = 0;
    let pending = true;
    const r = rotationRetrier({ resume: async () => { resumed++; const e = fails.shift(); if (e) throw e; return true; }, pending: () => pending, timers });
    r.start();
    await quick();
    expect(resumed).toBe(1);
    expect(queued.map((q) => q.ms)).toEqual([ROTATION_RETRY_MS]);
    queued.shift()!.fn();
    await quick();
    expect(resumed).toBe(2);
    expect(queued).toHaveLength(0);
    // 動いている間の解除が失敗して記録が残ったら、同じ間で予約する。重ねては予約しない。
    r.failed(new Error('offline'));
    r.failed(new Error('offline'));
    expect(queued).toHaveLength(1);
    queued.shift()!.fn();
    await quick();
    expect(resumed).toBe(3);
    r.failed(new RevokedError());
    expect(queued).toHaveLength(0);
    pending = false;
    r.failed(new Error('offline'));
    expect(queued).toHaveLength(0);
    // 試し直しが解除済みで落ちたら、それ以上は予約しない。
    pending = true;
    fails = [new RevokedError()];
    r.failed(new Error('offline'));
    queued.shift()!.fn();
    await quick();
    expect(queued).toHaveLength(0);
    r.failed(new Error('offline'));
    r.stop();
    expect(queued).toHaveLength(0);
  });

  it('Worker が解除済みとする PC が名簿に残っていても、その PC には keybox を置かずに配り切る', async () => {
    const { wire, a, pairs } = await setup(['pc-a', 'pc-b', 'pc-c', 'pc-d']);
    // pc-d は前の解除で Worker では無効だが、名簿に残っている（名簿の書き換えの前に止まった名残）。
    wire.revoke('pc-d');
    await revokePc({ id: 'pc-c', ...opts(a) });
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).not.toBeNull();
    expect(wire.storeForScan().keyboxes.get('pc-d')?.has(3)).toBe(false);
  });

  it('Worker が知らず、参加の期限も過ぎた PC が名簿にあれば（承認の途中で止まった名残）、Worker がいるとする PC だけで置き直す', async () => {
    const { wire, a, pairs, recovery } = await setup(['pc-a', 'pc-b', 'pc-c', 'pc-d']);
    // pc-d は名簿にあるが Worker の devices に無い。名簿の joinedAt は昔のまま。PUT /keyboxes は 400 で全部を断る。
    wire.storeForScan().devices.delete('pc-d');
    let slept = 0;
    await revokePc({ id: 'pc-c', ...opts(a, a.wire, { sleep: async () => { slept++; } }) });
    expect(slept).toBe(0);
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).not.toBeNull();
    expect(await boxFor(wire, RECOVERY_RECIPIENT, 3, recovery)).not.toBeNull();
    expect(wire.storeForScan().keyboxes.get('pc-d')?.has(3)).toBe(false);
    expect(a.keyring.current().epoch).toBe(3);
  });

  it('名簿に足したばかりで Worker にまだいない PC（承認の途中）は捨てずに試し直し、端末になれば置く', async () => {
    const { wire, a, pairs } = await setup(['pc-a', 'pc-b', 'pc-c', 'pc-d']);
    wire.storeForScan().devices.delete('pc-d');
    await a.roster.update((r) => ({ ...r, entries: r.entries.map((e) => (e.id === 'pc-d' ? { ...e, joinedAt: Date.now() } : e)) }));
    let slept = 0;
    const sleep = async (): Promise<void> => {
      // 2 回目の間に、承認された pc-d が端末トークンを受け取る。
      if (++slept === 2) wire.redeemJoin('pc-d');
    };
    await revokePc({ id: 'pc-c', ...opts(a, a.wire, { sleep }) });
    expect(slept).toBe(2);
    const k3 = a.cfg.current.epochs['3']!;
    expect(await boxFor(wire, 'pc-d', 3, pairs['pc-d']!)).toEqual({ ...EPOCHS, '3': k3 });
    expect(rotation(a)).toBeNull();
  });

  it('承認の途中の PC にいつまでも置けなければ、(5) の段に残して投げ、次の再開で置く', async () => {
    const { wire, a, pairs, restart } = await setup(['pc-a', 'pc-b', 'pc-c', 'pc-d']);
    wire.storeForScan().devices.delete('pc-d');
    await a.roster.update((r) => ({ ...r, entries: r.entries.map((e) => (e.id === 'pc-d' ? { ...e, joinedAt: Date.now() } : e)) }));
    let slept = 0;
    await expect(revokePc({ id: 'pc-c', ...opts(a, a.wire, { sleep: async () => { slept++; } }) })).rejects.toThrow(/not ready/);
    expect(slept).toBe(DELIVER_RETRIES);
    expect(rotation(a)).toMatchObject({ step: 'boxes' });
    expect(a.keyring.current().epoch).toBe(2);
    // 他の PC には先に置いてある。
    expect(await boxFor(wire, 'pc-b', 3, pairs['pc-b']!)).not.toBeNull();
    wire.redeemJoin('pc-d');
    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(await boxFor(wire, 'pc-d', 3, pairs['pc-d']!)).toEqual({ ...EPOCHS, '3': again.cfg.current.epochs['3']! });
    expect(again.keyring.current().epoch).toBe(3);
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

describe('2 台が同時に別の PC を解除する', () => {
  it('名簿の更新が交互に 409 になっても、2 つの世代は別の番号になり、残りの PC はどちらの世代の行も開ける', async () => {
    const ids = ['pc-a', 'pc-b', 'pc-c', 'pc-d', 'pc-e'];
    const { wire, a, pcOf, seeded } = await setup(ids);
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    // 最初の PUT /roster を、2 台がそろうまで待たせる。どちらも同じ版を読んでから書くので、後の方が 409 を受ける。
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = (pc: Pc): RosterStore =>
      new RosterStore(before(pc.wire, 'putRoster', async () => { if (++arrived === 2) release(); await gate; }), pc.keyring, pc.cfg, pc.id);
    const conflicts = (): number => [...a.wire.calls, ...b.wire.calls].filter((c) => c.method === 'putRoster').length - (wire.roster!.version - 1);
    // 番号を付け替えた側は、越えた世代の鍵を待つ。その間は、もう片方の回しが終わるのを待つ（実時間に依らない）。
    // 先に番号を取った側は待たないので、互いに待ち合うことはない。
    let doneA!: () => void;
    let doneB!: () => void;
    const aDone = new Promise<void>((r) => { doneA = r; });
    const bDone = new Promise<void>((r) => { doneB = r; });
    await Promise.all([
      revokePc({ id: 'pc-c', ...opts(a, a.wire, { roster: gated(a), sleep: () => bDone }) }).finally(doneA),
      revokePc({ id: 'pc-d', ...opts(b, b.wire, { roster: gated(b), sleep: () => aDone }) }).finally(doneB),
    ]);
    expect(conflicts()).toBeGreaterThanOrEqual(2);

    const ea = a.keyring.current().epoch;
    const eb = b.keyring.current().epoch;
    expect([ea, eb].sort()).toEqual([3, 4]);
    expect(rotation(a)).toBeNull();
    expect(rotation(b)).toBeNull();
    const ka = a.cfg.current.epochs[String(ea)]!;
    const kb = b.cfg.current.epochs[String(eb)]!;
    expect(ka).not.toBe(kb);

    // 残りの PC（回した 2 台と pc-e）は、keybox を読み直せば両方の世代の鍵を持つ。解除した 2 台はどちらも持たない。
    const e = await pcOf('pc-e', seeded.configs['pc-e']!);
    for (const pc of [a, b, e]) {
      await pc.roster.refreshKeyboxes();
      expect(await opens(ka, pc.cfg.current.epochs[String(ea)], ea)).toBe(true);
      expect(await opens(kb, pc.cfg.current.epochs[String(eb)], eb)).toBe(true);
      expect(pc.keyring.current().epoch).toBe(4);
    }
    for (const id of ['pc-c', 'pc-d']) {
      const got = wire.storeForScan().keyboxes.get(id)!;
      expect(got.has(3) || got.has(4)).toBe(false);
    }
    const roster = (await e.roster.read()).roster;
    expect(roster.entries.map((x) => x.id)).toEqual(['pc-a', 'pc-b', 'pc-e']);
    expect(roster.epochClaim?.epoch).toBe(4);
  });
});

describe('回しかけの記録が、世代を確保した PC の鍵を待って止まっている', () => {
  /** pc-b が pc-d を解除して世代 3 を確保し、配る前に落ちたまま戻らない。pc-a の pc-c の解除は、世代 4 に付け替えて世代 3 を待ち、止まる。 */
  async function stuck(ids: string[]) {
    const s = await setup(ids);
    const b = await s.pcOf('pc-b', s.seeded.configs['pc-b']!);
    await expect(revokePc({ id: 'pc-d', ...opts(b, crashingAt(b.wire, 'putKeyboxes')) })).rejects.toThrow('crashed');
    await expect(revokePc({ id: 'pc-c', ...opts(s.a) })).rejects.toThrow(/has not arrived/);
    expect(rotation(s.a)).toMatchObject({ id: 'pc-c', newEpoch: 4, step: 'boxes', after: { epoch: 3, by: 'pc-b' } });
    return s;
  }

  /** 残りの PC が、keybox を読み直して各世代の行を開けるか。 */
  async function remainingOpens(s: Awaited<ReturnType<typeof setup>>, id: string, epochs: number[]) {
    const pc = await s.pcOf(id, s.seeded.configs[id]!);
    await pc.roster.refreshKeyboxes();
    for (const n of epochs) expect(await opens(s.a.cfg.current.epochs[String(n)]!, pc.cfg.current.epochs[String(n)], n)).toBe(true);
    expect(pc.keyring.current().epoch).toBe(Math.max(...epochs));
    return pc;
  }

  it('その確保した PC を解除すると、先に端末トークンを無効にして待ちを抜け、両方の回しを終える。残りの PC はどちらの世代の行も開ける', async () => {
    const s = await stuck(['pc-a', 'pc-b', 'pc-c', 'pc-d', 'pc-e']);
    const row = await revokePc({ id: 'pc-b', ...opts(s.a) });
    expect(row?.id).toBe('pc-b');
    expect(row?.revokedAt).not.toBeNull();
    expect(rotation(s.a)).toBeNull();
    expect(s.a.keyring.current().epoch).toBe(5);
    const e = await remainingOpens(s, 'pc-e', [4, 5]);
    for (const id of ['pc-b', 'pc-c', 'pc-d']) {
      const got = s.wire.storeForScan().keyboxes.get(id);
      expect(Boolean(got?.has(4) || got?.has(5))).toBe(false);
    }
    expect((await e.roster.read()).roster.entries.map((x) => x.id)).toEqual(['pc-a', 'pc-e']);
  });

  it('別の PC を解除したときは、端末トークンを無効にして記録に積み、待ちは投げる。確保した PC を解除すれば、積んだ分まで回し終える', async () => {
    const s = await stuck(['pc-a', 'pc-b', 'pc-c', 'pc-d', 'pc-e', 'pc-f']);
    await expect(revokePc({ id: 'pc-f', ...opts(s.a) })).rejects.toThrow(/has not arrived/);
    expect(s.wire.storeForScan().devices.get('pc-f')?.revokedAt).not.toBeNull();
    expect(rotation(s.a)).toMatchObject({ id: 'pc-c', step: 'boxes', next: ['pc-f'] });
    // 積んだ PC をもう一度解除しても、二重には積まない。
    await expect(revokePc({ id: 'pc-f', ...opts(s.a) })).rejects.toThrow(/has not arrived/);
    expect(rotation(s.a)).toMatchObject({ next: ['pc-f'] });

    expect((await revokePc({ id: 'pc-b', ...opts(s.a) }))?.id).toBe('pc-b');
    expect(rotation(s.a)).toBeNull();
    expect(s.a.keyring.current().epoch).toBe(6);
    await remainingOpens(s, 'pc-e', [4, 5, 6]);
    for (const id of ['pc-b', 'pc-f']) expect(s.wire.storeForScan().keyboxes.get(id)?.has(6)).toBe(false);
    // 積んだ PC の解除を後で呼んでも、もう回さない。
    expect((await revokePc({ id: 'pc-f', ...opts(s.a) }))?.revokedAt).not.toBeNull();
    expect(s.a.keyring.current().epoch).toBe(6);
  });

  it('記録に積んだ解除は、落ちた後の起動の続きでも行う', async () => {
    const s = await stuck(['pc-a', 'pc-b', 'pc-c', 'pc-d', 'pc-e', 'pc-f']);
    await expect(revokePc({ id: 'pc-f', ...opts(s.a) })).rejects.toThrow(/has not arrived/);
    // 確保した PC が戻らないまま、別の道（他の PC の画面など）で解除された。
    s.wire.revoke('pc-b');
    const again = await s.restart(s.a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(rotation(again)).toBeNull();
    expect(again.keyring.current().epoch).toBe(5);
    expect(s.wire.storeForScan().keyboxes.get('pc-f')?.has(5)).toBe(false);
  });
});

/** 参加の承認（pc-b）の真似。Worker の参加コードの口は手で返し、keybox は偽のクラウドに置く。 */
async function approverOf(pc: Pc, wire: FakeWireClient, joiner: { id: string; pair: KeyPairRaw }) {
  const cloudId = 'cloud-test-1';
  let secrets: JoinSecrets | null = null;
  let tick: (() => void) | null = null;
  const timers: JoinTimers = { set: (fn) => { tick = fn; return fn; }, clear: () => { tick = null; } };
  const join: JoinWire = {
    createJoinCode: async (h) => ({ codeHash: h, expiresAt: Date.now() + 300_000 }),
    joinCodeMine: async () => ({ codeHash: secrets!.codeHash, status: 'requested', deviceId: joiner.id, sealed: await sealJoinRequest(secrets!, { pub: joiner.pair.pub, name: `${joiner.id}-name`, os: 'darwin' }) }),
    approveJoinCode: async () => {},
    rejectJoinCode: async () => {},
    putKeyboxes: (boxes) => pc.wire.putKeyboxes(boxes),
  };
  const approver = new JoinApprover({ wire: join, roster: pc.roster, keyring: pc.keyring, cloudId, language: () => 'ja', timers });
  // 新しい PC の側の導出。参加コードとクラウドの ID が同じなら、発行した PC と同じ値になる。
  secrets = await deriveJoinSecrets((await approver.issue()).code, cloudId);
  wire.asDevice(pc.id).offerJoin(joiner.id);
  const t = tick as (() => void) | null;
  t?.();
  await approver.settled();
  expect(approver.state().kind).toBe('requested');
  return approver;
}

describe('参加の承認と解除が重なる', () => {
  it('解除の (5) の後で名簿に足された新しい PC にも、(6) の後で新しい世代の箱を配る。新しい PC は新しい世代の行を開ける', async () => {
    const { wire, a, pcOf, seeded } = await setup();
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    const n = { id: 'pc-n', pair: await generateKeyPair() };
    const approver = await approverOf(b, wire, n);
    // pc-a が (5) で名簿を読んだ後、keybox を置く前に、pc-b が pc-n を承認し終える（pc-b はまだ世代 3 を知らない）。
    let slept = 0;
    const sleep = async (): Promise<void> => {
      // 承認された pc-n が、問い合わせで端末トークンを受け取る。
      if (++slept === 1) wire.redeemJoin('pc-n');
    };
    const racing = before(a.wire, 'putKeyboxes', async () => {
      await approver.approve();
      expect(approver.state().kind).toBe('done');
    });
    await revokePc({ id: 'pc-c', ...opts(a, racing, { sleep }) });
    expect(slept).toBe(1);
    // pc-b が置いた箱は世代 2 まで。pc-a が (6) の後で世代 3 の箱を置き足した。
    expect(await boxFor(wire, 'pc-n', 2, n.pair)).toEqual(EPOCHS);
    const newest = await newestBox(wire, 'pc-n', n.pair);
    const k3 = a.cfg.current.epochs['3']!;
    expect(newest).toEqual({ epoch: 3, epochs: { ...EPOCHS, '3': k3 } });
    expect(await opens(k3, newest.epochs['3'], 3)).toBe(true);
  });

  it('承認する PC は、箱を置く前に keybox を読み直し、解除で回った新しい世代までを新しい PC に渡す', async () => {
    const { wire, a, pcOf, seeded } = await setup();
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    const n = { id: 'pc-n', pair: await generateKeyPair() };
    const approver = await approverOf(b, wire, n);
    await revokePc({ id: 'pc-c', ...opts(a) });
    // pc-b はまだ世代 3 を読んでいない。
    expect(b.keyring.current().epoch).toBe(2);
    await approver.approve();
    expect(approver.state().kind).toBe('done');
    const k3 = a.cfg.current.epochs['3']!;
    expect(await newestBox(wire, 'pc-n', n.pair)).toEqual({ epoch: 3, epochs: { ...EPOCHS, '3': k3 } });
  });

  it('承認する PC が箱を置いた直後に世代が回ったら、新しい世代の箱を置き直す', async () => {
    const { wire, pcOf, seeded } = await setup();
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    const n = { id: 'pc-n', pair: await generateKeyPair() };
    // pc-b が最初の箱を置いた直後に、pc-a の解除が (5) まで済む（名簿は pc-n を足す前に読んだ形にする）。
    let first = true;
    const put = b.wire.putKeyboxes.bind(b.wire);
    b.wire.putKeyboxes = async (boxes) => {
      const r = await put(boxes);
      if (first) {
        first = false;
        const k3 = testKey(91);
        const all = { ...EPOCHS, '3': k3 };
        for (const id of ['pc-a', 'pc-b']) wire.putKeybox(id, 3, toBase64Url(await sealKeybox(seeded.configs[id]!.keyPair.pub, { epoch: 3, recipient: id }, encodeEpochList({ epochs: all }))));
      }
      return r;
    };
    const approver = await approverOf(b, wire, n);
    await approver.approve();
    expect(approver.state().kind).toBe('done');
    expect(await boxFor(wire, 'pc-n', 2, n.pair)).toEqual(EPOCHS);
    expect(await newestBox(wire, 'pc-n', n.pair)).toEqual({ epoch: 3, epochs: { ...EPOCHS, '3': testKey(91) } });
  });

  it('承認する PC が回しの途中なら、配り終えていない世代の鍵は新しい PC に渡さない', async () => {
    const { wire, pcOf, seeded } = await setup();
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    await b.keyring.addPending(3, testKey(92));
    const n = { id: 'pc-n', pair: await generateKeyPair() };
    const approver = await approverOf(b, wire, n);
    await approver.approve();
    expect(approver.state().kind).toBe('done');
    expect(await newestBox(wire, 'pc-n', n.pair)).toEqual({ epoch: 2, epochs: EPOCHS });
  });
});

const FEED: MobileFeed = { v: 1, deviceId: 'pc-a', deviceName: 'pc-a', accounts: [], projects: [], live: [], returns: [], done: [] };

/** PC が QR を出し、スマホを順に接続する（mobile/pairer.ts）。スマホの鍵ペアを返す。 */
async function pairPhones(pc: Pc, ids: string[]): Promise<Record<string, PhoneKeyPair>> {
  const pairer = new PhonePairer({ wire: pc.wire, roster: pc.roster, timers: { set: () => null, clear: () => {} } });
  const out: Record<string, PhoneKeyPair> = {};
  for (const id of ids) {
    const t = await pc.wire.createPairing();
    await pairer.watch(t);
    const pair = await generatePhoneKeyPair();
    pc.wire.joinPhone({ code: t.code, deviceId: id, sealed: await sealPhoneJoinRequest(t.code, id, { pub: pair.pub, name: id }) });
    await pairer.pollOnce();
    out[id] = pair;
  }
  pairer.stop();
  return out;
}

/** スマホがいま GET /m/keybox で受け取る M の世代と鍵。無ければ null。 */
async function phoneM(wire: FakeWireClient, id: string, pair: PhoneKeyPair): Promise<{ epoch: number; key: CryptoKey } | null> {
  const box = wire.phoneKeybox(id);
  return box ? { epoch: box.epoch, key: await importMobileKey(await openPhoneKeybox(pair.key, pair.pub, id, box)) } : null;
}

const publisherOf = (pc: Pc) => new MobileFeedPublisher({ build: () => FEED, client: new FakeCloudClient({ wire: pc.wire, keyring: pc.keyring }), phoneKeys: phoneKeysOf(pc.keyring, pc.roster), deviceId: pc.id, timers: new FakeTimers(), canWrite: () => true });

async function opensFeed(m: CryptoKey, sealed: string): Promise<boolean> {
  try {
    await open<MobileFeed>(m, aadFeed('pc-a'), sealed);
    return true;
  } catch {
    return false;
  }
}

const phonesIn = async (pc: Pc) => {
  pc.roster.invalidate();
  const r = (await pc.roster.read()).roster;
  return { ids: r.entries.filter((e) => e.kind === 'phone').map((e) => e.id).sort(), phoneKey: r.phoneKey };
};

describe('revokePhone（スマホの解除）', () => {
  it('スマホ A を解除しても、スマホ B は keybox を読み直して受信箱を開ける。A は新しい世代の素を開けず、PC の世代鍵は回さない', async () => {
    const { wire, a, pcOf, seeded } = await setup(['pc-a', 'pc-b']);
    const phones = await pairPhones(a, ['phone-a', 'phone-b']);
    const pub = publisherOf(a);
    expect(await pub.flushNow()).toBe('written');
    const a1 = (await phoneM(wire, 'phone-a', phones['phone-a']!))!;
    expect(a1.epoch).toBe(1);
    const pcEpoch = a.keyring.current().epoch;

    const row = await revokeMember({ id: 'phone-a', ...opts(a) });
    expect(row.revokedAt).not.toBeNull();
    // 名簿から A が抜け、M は次の世代になる。PC の世代鍵は回さない。
    expect(await phonesIn(a)).toMatchObject({ ids: ['phone-b'], phoneKey: { epoch: 2 } });
    expect(a.keyring.phoneKey()?.epoch).toBe(2);
    expect(a.cfg.current.phoneKey?.epoch).toBe(2);
    expect(a.keyring.current().epoch).toBe(pcEpoch);
    expect(a.wire.calls.some((c) => c.method === 'putKeyboxes')).toBe(false);
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toBeNull();

    // 受信箱の書き手は新しい世代で書き直す。
    expect(await pub.flushNow()).toBe('written');
    const feedRow = wire.inboxFeeds().find((f) => f.deviceId === 'pc-a')!;
    expect(feedRow.epoch).toBe(2);
    // B は keybox を読み直して新しい世代の M を得て、素を開ける。
    const b2 = (await phoneM(wire, 'phone-b', phones['phone-b']!))!;
    expect(b2.epoch).toBe(2);
    expect(await opensFeed(b2.key, feedRow.sealed)).toBe(true);
    // A の keybox は古い世代のままで、端末トークンも無効。手元の M では新しい世代の素を開けない。
    expect(wire.phoneKeybox('phone-a')?.epoch).toBe(1);
    expect(await opensFeed(a1.key, feedRow.sealed)).toBe(false);
    await expect(wire.asDevice('phone-a').listDevices()).rejects.toBeInstanceOf(RevokedError);

    // 他の PC も名簿を読めば新しい M を持つ。
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    await b.roster.read();
    expect(b.keyring.phoneKey()?.epoch).toBe(2);
  });

  it('M の keybox を置く前に落ちても、次の起動の続きで残りのスマホに新しい世代の M を置く（M は 2 度回さない）', async () => {
    const { wire, a, restart } = await setup(['pc-a', 'pc-b']);
    const phones = await pairPhones(a, ['phone-a', 'phone-b']);
    await expect(revokePhone({ id: 'phone-a', ...opts(a, crashingAt(a.wire, 'putPhoneKeyboxes')) })).rejects.toThrow('crashed');
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toEqual({ id: 'phone-a' });
    expect(wire.phoneKeybox('phone-b')?.epoch).toBe(1);

    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect((await phoneM(wire, 'phone-b', phones['phone-b']!))?.epoch).toBe(2);
    expect(await phonesIn(again)).toMatchObject({ ids: ['phone-b'], phoneKey: { epoch: 2 } });
    expect(readPhoneRevoke(again.state, again.cfg.current.cloudId)).toBeNull();
    expect(await resumeRotation(opts(again))).toBe(false);
  });

  it('解除の口に届かずに落ちても、次の起動で解除してから M を回す', async () => {
    const { wire, a, restart } = await setup(['pc-a', 'pc-b']);
    const phones = await pairPhones(a, ['phone-a', 'phone-b']);
    await expect(revokePhone({ id: 'phone-a', ...opts(a, crashingAt(a.wire, 'revokeDevice')) })).rejects.toThrow('crashed');
    expect(wire.storeForScan().devices.get('phone-a')?.revokedAt).toBeNull();
    expect((await phonesIn(a)).phoneKey?.epoch).toBe(1);

    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(wire.storeForScan().devices.get('phone-a')?.revokedAt).not.toBeNull();
    expect(await phonesIn(again)).toMatchObject({ ids: ['phone-b'], phoneKey: { epoch: 2 } });
    expect((await phoneM(wire, 'phone-b', phones['phone-b']!))?.epoch).toBe(2);
  });

  it('配る直前に別のスマホも解除されていたら、Worker がいるとするスマホだけに置き直す', async () => {
    const { wire, a } = await setup(['pc-a', 'pc-b']);
    const phones = await pairPhones(a, ['phone-a', 'phone-b', 'phone-c']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await revokePhone({ id: 'phone-a', ...opts(a, before(a.wire, 'putPhoneKeyboxes', async () => wire.revoke('phone-c'))) });
    warn.mockRestore();
    expect((await phoneM(wire, 'phone-b', phones['phone-b']!))?.epoch).toBe(2);
    expect(wire.phoneKeybox('phone-c')?.epoch).toBe(1);
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toBeNull();
  });

  it('前のスマホの解除が (2) の後で落ちて記録が残ったまま別のスマホを解除すると、先に前の解除を終え、両方が名簿から外れて M が回る', async () => {
    const { wire, a } = await setup(['pc-a', 'pc-b']);
    const phones = await pairPhones(a, ['phone-a', 'phone-b', 'phone-c']);
    const crashing = new RosterStore(crashingAt(a.wire, 'putRoster'), a.keyring, a.cfg, 'pc-a');
    await expect(revokePhone({ id: 'phone-a', ...opts(a, a.wire, { roster: crashing }) })).rejects.toThrow('crashed');
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toEqual({ id: 'phone-a' });
    expect(wire.storeForScan().devices.get('phone-a')?.revokedAt).not.toBeNull();
    expect((await phonesIn(a)).ids).toEqual(['phone-a', 'phone-b', 'phone-c']);

    await revokePhone({ id: 'phone-b', ...opts(a) });
    expect(await phonesIn(a)).toMatchObject({ ids: ['phone-c'], phoneKey: { epoch: 3 } });
    expect(wire.storeForScan().devices.get('phone-b')?.revokedAt).not.toBeNull();
    expect((await phoneM(wire, 'phone-c', phones['phone-c']!))?.epoch).toBe(3);
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toBeNull();
  });

  it('名簿にいないスマホ（接続の途中で解除された）なら、端末トークンだけを無効にし、M も名簿も書き換えない', async () => {
    const { wire, a } = await setup(['pc-a', 'pc-b']);
    await pairPhones(a, ['phone-b']);
    wire.storeForScan().devices.set('phone-x', { id: 'phone-x', kind: 'mobile', joinedAt: 1, lastSeenAt: null, revokedAt: null, expiresAt: null });
    const version = wire.roster!.version;
    const row = await revokeMember({ id: 'phone-x', ...opts(a) });
    expect(row.revokedAt).not.toBeNull();
    expect(wire.roster!.version).toBe(version);
    expect((await phonesIn(a)).phoneKey?.epoch).toBe(1);
    expect(wire.phoneKeybox('phone-b')?.epoch).toBe(1);
  });

  it('他の PC が世代を回した直後でも、keybox を読み直してから名簿を読み、スマホを解除できる', async () => {
    const { wire, a, pcOf, seeded } = await setup();
    const phones = await pairPhones(a, ['phone-a', 'phone-b']);
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    // pc-b が pc-c を解除して世代 3 に回し、名簿を世代 3 で封じ直した。pc-a はまだ世代 3 の鍵を持たない。
    await revokePc({ id: 'pc-c', ...opts(b) });
    expect(a.keyring.at(3)).toBeNull();
    const row = await revokeMember({ id: 'phone-a', ...opts(a) });
    expect(row.revokedAt).not.toBeNull();
    expect(a.keyring.at(3)).not.toBeNull();
    const after = await phonesIn(a);
    expect(after.ids).toEqual(['phone-b']);
    expect((await phoneM(wire, 'phone-b', phones['phone-b']!))?.epoch).toBe(after.phoneKey?.epoch);
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toBeNull();
  });
});

/** putRoster に渡った封じた名簿を、順に控える線。 */
function recordingRoster<W extends FakeWireClient>(w: W): { wire: W; puts: { version: number; sealed: string }[] } {
  const puts: { version: number; sealed: string }[] = [];
  const orig = w.putRoster.bind(w);
  const wire = Object.assign(Object.create(w) as W, {
    putRoster: async (body: Parameters<W['putRoster']>[0]) => {
      const r = await orig(body);
      if (r.ok) puts.push({ version: body.ifVersion + 1, sealed: body.sealed });
      return r;
    },
  });
  return { wire, puts };
}

/** 解除した PC の手元の世代鍵で開ける名簿のうち、スマホ用の鍵 M の世代の一覧。 */
async function phoneEpochsOpenableBy(old: Keyring, puts: { version: number; sealed: string }[]): Promise<number[]> {
  const out: number[] = [];
  for (const p of puts) {
    for (const n of old.epochs()) {
      try {
        const r = await openRoster(old.at(n)!.roster, p.version, fromBase64Url(p.sealed)!);
        out.push(r.phoneKey?.epoch ?? 0);
        break;
      } catch (e) {
        if (!(e instanceof E2eOpenError)) throw e;
      }
    }
  }
  return out;
}

describe('PC の解除とスマホ用の鍵 M', () => {
  it('PC を解除すると M も次の世代になり、残りのスマホに置く。解除した PC は新しい M を持たず、新しい M の入った名簿を開けない', async () => {
    const { wire, a, pcOf, seeded } = await setup();
    const phones = await pairPhones(a, ['phone-a', 'phone-b']);
    // 解除する PC も、解除の前に名簿を読んで M[1] を持っている。
    const c = await pcOf('pc-c', seeded.configs['pc-c']!);
    await c.roster.read();
    expect(c.keyring.phoneKey()?.epoch).toBe(1);
    const m1 = (await phoneM(wire, 'phone-a', phones['phone-a']!))!;

    const { wire: rec, puts } = recordingRoster(a.wire);
    const roster = new RosterStore(rec, a.keyring, a.cfg, 'pc-a');
    await revokePc({ id: 'pc-c', ...opts(a, a.wire, { roster }) });
    expect(rotation(a)).toBeNull();

    // 名簿の M は次の世代になり、この PC の手元にも写り、残りのスマホに置いてある。
    expect(await phonesIn(a)).toMatchObject({ ids: ['phone-a', 'phone-b'], phoneKey: { epoch: 2 } });
    expect(a.keyring.phoneKey()?.epoch).toBe(2);
    expect(a.cfg.current.phoneKey?.epoch).toBe(2);
    const m2a = (await phoneM(wire, 'phone-a', phones['phone-a']!))!;
    const m2b = (await phoneM(wire, 'phone-b', phones['phone-b']!))!;
    expect([m2a.epoch, m2b.epoch]).toEqual([2, 2]);

    // 受信箱は新しい M で書き直り、スマホは開けて、解除の前の M では開けない。
    const pub = publisherOf(a);
    expect(await pub.flushNow()).toBe('written');
    const feedRow = wire.inboxFeeds().find((f) => f.deviceId === 'pc-a')!;
    expect(feedRow.epoch).toBe(2);
    expect(await opensFeed(m2b.key, feedRow.sealed)).toBe(true);
    expect(await opensFeed(m1.key, feedRow.sealed)).toBe(false);

    // 解除した PC は新しい M を持たない。手元の世代鍵で開ける名簿（D1 の写しを含む）に、新しい M は入っていない。
    expect(c.keyring.phoneKey()?.epoch).toBe(1);
    expect(puts.length).toBeGreaterThan(0);
    const openable = await phoneEpochsOpenableBy(c.keyring, puts);
    expect(openable.every((n) => n <= 1)).toBe(true);
  });

  it('M を回した名簿を書いた後、スマホに置く前に落ちても、再開で M を 1 度だけ回して置き終える', async () => {
    const { wire, a, restart } = await setup();
    const phones = await pairPhones(a, ['phone-a', 'phone-b']);
    await expect(revokePc({ id: 'pc-c', ...opts(a, crashingAt(a.wire, 'putPhoneKeyboxes')) })).rejects.toThrow('crashed');
    expect(rotation(a)).toMatchObject({ id: 'pc-c', step: 'switch' });
    expect((await phonesIn(a)).phoneKey?.epoch).toBe(2);
    expect(wire.phoneKeybox('phone-b')?.epoch).toBe(1);
    // PC の回しは、スマホの解除の記録を書かない。
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toBeNull();

    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect(rotation(again)).toBeNull();
    expect((await phonesIn(again)).phoneKey?.epoch).toBe(2);
    expect((await phoneM(wire, 'phone-a', phones['phone-a']!))?.epoch).toBe(2);
    expect((await phoneM(wire, 'phone-b', phones['phone-b']!))?.epoch).toBe(2);
  });

  it('(6) の名簿の封じ直しで落ちても、再開で M を 1 度だけ回す', async () => {
    const { wire, a, restart } = await setup();
    const phones = await pairPhones(a, ['phone-a']);
    const roster = new RosterStore(crashingAt(a.wire, 'putRoster', 2), a.keyring, a.cfg, 'pc-a');
    await expect(revokePc({ id: 'pc-c', ...opts(a, a.wire, { roster }) })).rejects.toThrow('crashed');
    expect(rotation(a)).toMatchObject({ step: 'switch' });
    expect((await phonesIn(a)).phoneKey?.epoch).toBe(1);

    const again = await restart(a);
    expect(await resumeRotation(opts(again))).toBe(true);
    expect((await phonesIn(again)).phoneKey?.epoch).toBe(2);
    expect((await phoneM(wire, 'phone-a', phones['phone-a']!))?.epoch).toBe(2);
    // もう一度起動しても M は回さない。
    expect(await resumeRotation(opts(await restart(again)))).toBe(false);
    expect((await phonesIn(again)).phoneKey?.epoch).toBe(2);
  });

  it('スマホの解除の記録が残ったまま PC を解除しても、その記録は消さず、続きで両方が終わる', async () => {
    const { wire, a } = await setup();
    const phones = await pairPhones(a, ['phone-a', 'phone-b']);
    await expect(revokePhone({ id: 'phone-a', ...opts(a, crashingAt(a.wire, 'putPhoneKeyboxes')) })).rejects.toThrow('crashed');
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toEqual({ id: 'phone-a' });
    expect((await phonesIn(a)).phoneKey?.epoch).toBe(2);

    await revokePc({ id: 'pc-c', ...opts(a) });
    expect(rotation(a)).toBeNull();
    // PC の回しは M を次の世代にし、残りのスマホに置く。解除したスマホには置かない。
    expect(await phonesIn(a)).toMatchObject({ ids: ['phone-b'], phoneKey: { epoch: 3 } });
    expect((await phoneM(wire, 'phone-b', phones['phone-b']!))?.epoch).toBe(3);
    expect(wire.phoneKeybox('phone-a')?.epoch).toBe(1);
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toEqual({ id: 'phone-a' });

    expect(await resumeRotation(opts(a))).toBe(true);
    expect(readPhoneRevoke(a.state, a.cfg.current.cloudId)).toBeNull();
    expect((await phonesIn(a)).phoneKey?.epoch).toBe(3);
    expect((await phoneM(wire, 'phone-b', phones['phone-b']!))?.epoch).toBe(3);
  });
});

describe('世代の回しとリカバリーキーの再発行が重なる', () => {
  it('(5) で名簿を読んだ後に他の PC が再発行したら、(6) で新しい公開鍵宛てに全世代の recovery の箱を置き直す', async () => {
    const { wire, a, pcOf, seeded, recovery } = await setup();
    const fresh = await generateKeyPair();
    const b = await pcOf('pc-b', seeded.configs['pc-b']!);
    // (5) の箱を置く直前に、pc-b が名簿の recoveryPub を新しい公開鍵にし、世代 1 と 2 の箱を新しい公開鍵宛てに置いた。
    const hooked = before(a.wire, 'putKeyboxes', async () => {
      await b.roster.update((r) => ({ ...r, recoveryPub: fresh.pub }));
      const list = { ...EPOCHS };
      await b.wire.putKeyboxes(await Promise.all([1, 2].map(async (epoch) => ({ epoch, recipient: RECOVERY_RECIPIENT, sealed: toBase64Url(await sealKeybox(fresh.pub, { epoch, recipient: RECOVERY_RECIPIENT }, encodeEpochList({ epochs: Object.fromEntries(Object.entries(list).filter(([n]) => Number(n) <= epoch)) }))) }))));
    });
    await revokePc({ id: 'pc-c', ...opts(a, hooked) });
    const k3 = a.cfg.current.epochs['3']!;
    // いちばん新しい recovery の箱は新しい公開鍵宛てで、世代 1〜3 の全部が入っている。
    expect(await newestBox(wire, RECOVERY_RECIPIENT, fresh)).toEqual({ epoch: 3, epochs: { ...EPOCHS, '3': k3 } });
    expect(await boxFor(wire, RECOVERY_RECIPIENT, 1, fresh)).toEqual({ '1': EPOCHS['1'] });
    expect(await boxFor(wire, RECOVERY_RECIPIENT, 2, fresh)).toEqual(EPOCHS);
    await expect(boxFor(wire, RECOVERY_RECIPIENT, 3, recovery)).rejects.toThrow();
    expect(rotation(a)).toBeNull();
  });

  it('再発行と重ならなければ、recovery の箱を置き直さない', async () => {
    const { a } = await setup();
    const spy = recordingKeyboxes(a.wire);
    await revokePc({ id: 'pc-c', ...opts(a, spy.wire) });
    expect(spy.recovery).toEqual([3]);
  });
});

/** putKeyboxes に渡った recovery 宛ての箱の世代を、順に控える線。 */
function recordingKeyboxes<W extends FakeWireClient>(w: W): { wire: W; recovery: number[] } {
  const recovery: number[] = [];
  const orig = w.putKeyboxes.bind(w);
  const wire = Object.assign(Object.create(w) as W, {
    putKeyboxes: async (boxes: Parameters<W['putKeyboxes']>[0]) => {
      const r = await orig(boxes);
      recovery.push(...boxes.filter((x) => x.recipient === RECOVERY_RECIPIENT).map((x) => x.epoch));
      return r;
    },
  });
  return { wire, recovery };
}
