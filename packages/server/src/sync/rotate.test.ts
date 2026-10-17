import { describe, expect, it } from 'vitest';
import {
  decodeEpochList,
  deriveEpochKeys,
  E2eOpenError,
  encodeEpochList,
  fromBase64Url,
  generateKeyPair,
  importPrivate,
  joinCodeHash,
  openKeybox,
  openRoster,
  openRow,
  RECOVERY_RECIPIENT,
  sealJoinRequest,
  sealKeybox,
  sealRow,
  toBase64Url,
  type KeyPairRaw,
  type RowAad,
} from '@agent-hangar/shared';
import { testKey } from '../../test/cloudConfig.ts';
import { seedCloud, type FakeWireClient } from '../../test/fake-cloud.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { openDb } from '../db/open.ts';
import { RevokedError } from './client.ts';
import { JoinApprover, type JoinTimers, type JoinWire } from './joinApprover.ts';
import { Keyring } from './keyring.ts';
import { RosterStore, type ConfigWriter } from './roster.ts';
import {
  DELIVER_RETRIES,
  readRotation,
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
    await Promise.all([
      revokePc({ id: 'pc-c', ...opts(a, a.wire, { roster: gated(a) }) }),
      revokePc({ id: 'pc-d', ...opts(b, b.wire, { roster: gated(b) }) }),
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

/** 参加の承認（pc-b）の真似。Worker の参加コードの口は手で返し、keybox は偽のクラウドに置く。 */
async function approverOf(pc: Pc, wire: FakeWireClient, joiner: { id: string; pair: KeyPairRaw }) {
  let code = '';
  let hash = '';
  let tick: (() => void) | null = null;
  const timers: JoinTimers = { set: (fn) => { tick = fn; return fn; }, clear: () => { tick = null; } };
  const join: JoinWire = {
    createJoinCode: async (h) => ({ codeHash: h, expiresAt: Date.now() + 300_000 }),
    joinCodeMine: async () => ({ codeHash: hash, status: 'requested', deviceId: joiner.id, sealed: await sealJoinRequest(code, hash, { pub: joiner.pair.pub, name: `${joiner.id}-name`, os: 'darwin' }) }),
    approveJoinCode: async () => {},
    rejectJoinCode: async () => {},
    putKeyboxes: (boxes) => pc.wire.putKeyboxes(boxes),
  };
  const approver = new JoinApprover({ wire: join, roster: pc.roster, keyring: pc.keyring, language: () => 'ja', timers });
  code = (await approver.issue()).code;
  hash = await joinCodeHash(code);
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
