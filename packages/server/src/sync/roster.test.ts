import { describe, expect, it, vi } from 'vitest';
import { encodeEpochList, fromBase64Url, generateKeyPair, openRoster, sealKeybox, toBase64Url, type KeyPairRaw, type Roster, type RosterEntry } from '@agent-hangar/shared';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';
import { FakeWireClient } from '../../test/fake-cloud.ts';
import type { CloudConfig } from '../config/cloud.ts';
import { Keyring } from './keyring.ts';
import { EMPTY_ROSTER, ROSTER_MAX_TRIES, RosterStore, type ConfigWriter } from './roster.ts';

/** cloud.json の代わり。書き戻した分を当てて持つ。 */
function memoryConfig(c: CloudConfig): ConfigWriter & { current: CloudConfig; writes: number } {
  const box = {
    current: c,
    writes: 0,
    read: () => box.current,
    write: (patch: Partial<CloudConfig>) => { box.current = { ...box.current, ...patch }; box.writes++; },
  };
  return box;
}

const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({ id, kind: 'pc', name: id, os: 'darwin', pub: testKey(9), joinedAt: 1, ...over });
const seed: Roster = { v: 1, entries: [entry('pc-a')], recoveryPub: testKey(8), phoneKey: null };

/** 1 台の PC の名簿の読み書き。鍵ペアは本物の X25519（keybox を開くため）。 */
async function pc(wire: FakeWireClient, id: string, o: { epochs?: Record<string, string>; currentEpoch?: number; keyPair?: KeyPairRaw } = {}) {
  const cfg = memoryConfig(testCloudConfig({ keyPair: o.keyPair ?? (await generateKeyPair()), epochs: o.epochs ?? { '1': testKey(3) }, currentEpoch: o.currentEpoch ?? 1 }));
  const ring = await Keyring.fromConfig(cfg.current);
  const w = wire.asDevice(id);
  return { wire: w, cfg, ring, store: new RosterStore(w, ring, cfg, id) };
}

const gets = (w: FakeWireClient) => w.calls.filter((c) => c.method === 'getRoster').length;
const puts = (w: FakeWireClient) => w.calls.filter((c) => c.method === 'putRoster').length;

describe('RosterStore', () => {
  it('名簿がまだ無ければ（404）、投げずに版 0 の空の名簿を返す', async () => {
    const a = await pc(new FakeWireClient(), 'pc-a');
    expect(await a.store.read()).toEqual({ version: 0, roster: EMPTY_ROSTER });
  });

  it('自分宛ての keybox がまだ無ければ、投げずに何も足さない', async () => {
    const a = await pc(new FakeWireClient(), 'pc-a');
    expect(await a.store.refreshKeyboxes()).toBe(false);
    expect(a.cfg.writes).toBe(0);
  });

  it('書いた名簿は、ほかの PC が版つきで開ける。PUT の epoch は今の世代', async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a', { epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 });
    const r = await a.store.update(() => seed);
    expect(r.version).toBe(1);
    expect(a.cfg.current.rosterVersion).toBe(1);
    const put = a.wire.calls.find((c) => c.method === 'putRoster')!.args[0] as { ifVersion: number; epoch: number };
    expect(put).toMatchObject({ ifVersion: 0, epoch: 2 });
    // Worker は開けない。世代 2 の /roster の鍵と版 1 でだけ開ける。
    expect(wire.roster!.sealed).not.toContain('pc-a');
    expect(await openRoster(a.ring.at(2)!.roster, 1, fromBase64Url(wire.roster!.sealed)!)).toEqual(seed);
    const b = await pc(wire, 'pc-b', { epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 });
    expect(await b.store.read()).toEqual({ version: 1, roster: seed });
  });

  it('版が同じなら GET /roster を呼ばない', async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a');
    await a.store.update(() => seed);
    // 自分で書いた版は手元にある。
    expect(await a.store.read()).toEqual({ version: 1, roster: seed });
    expect(gets(a.wire)).toBe(1);
    const b = await pc(wire, 'pc-b');
    await b.store.read();
    await b.store.read();
    expect(gets(b.wire)).toBe(1);
    // 印の行を見たら読み直す。版が変わっていなければ開き直さない。
    b.store.invalidate();
    expect(await b.store.read()).toEqual({ version: 1, roster: seed });
    expect(gets(b.wire)).toBe(2);
    // cloud.json の版が手元の写しと違えば（ほかの道で書かれた）、読み直す。
    b.cfg.current = { ...b.cfg.current, rosterVersion: 7 };
    await b.store.read();
    expect(gets(b.wire)).toBe(3);
  });

  it('2 台が同時に update すると、両方の変更が名簿に残る', async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a');
    const b = await pc(wire, 'pc-b');
    await a.store.update(() => seed);
    await b.store.read();
    // pc-a の PUT の直前に、pc-b の書き換えが通る。pc-a は 409 を受けて読み直し、当て直す。
    wire.beforeRosterPut = () => b.store.update((r) => ({ ...r, entries: [...r.entries, entry('pc-b')] })).then(() => {});
    const fn = vi.fn((r: Roster) => ({ ...r, entries: [...r.entries, entry('pc-c')] }));
    const r = await a.store.update(fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.version).toBe(3);
    expect(r.roster.entries.map((e) => e.id)).toEqual(['pc-a', 'pc-b', 'pc-c']);
    // pc-a は最初の版、断られた 1 回、通った 1 回。pc-b は 1 回。
    expect([puts(a.wire), puts(b.wire)]).toEqual([3, 1]);
    // どちらの PC から読んでも同じ名簿。
    b.store.invalidate();
    expect((await b.store.read()).roster.entries.map((e) => e.id)).toEqual(['pc-a', 'pc-b', 'pc-c']);
  });

  it(`${ROSTER_MAX_TRIES} 回とも 409 なら投げる`, async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a');
    await a.store.update(() => seed);
    wire.rejectRosterPuts = ROSTER_MAX_TRIES;
    await expect(a.store.update((r) => ({ ...r, entries: [] }))).rejects.toThrow(/roster/);
    expect(puts(a.wire)).toBe(1 + ROSTER_MAX_TRIES);
    // 名簿は変わっていない。
    expect(wire.roster!.version).toBe(1);
  });

  it('通信の失敗は投げる', async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a');
    wire.offline = true;
    await expect(a.store.read()).rejects.toThrow(/offline/);
    await expect(a.store.refreshKeyboxes()).rejects.toThrow(/offline/);
  });

  it('keybox の一覧を足して cloud.json に書き戻し、新しい世代で封じた名簿も開ける', async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a', { epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 });
    await a.store.update(() => seed);
    const b = await pc(wire, 'pc-b');
    // 世代 2 の鍵が無いので、名簿は開けない。
    await expect(b.store.read()).rejects.toThrow();
    wire.putKeybox('pc-b', 2, toBase64Url(await sealKeybox(b.cfg.current.keyPair.pub, { epoch: 2, recipient: 'pc-b' }, encodeEpochList({ epochs: { '1': testKey(3), '2': testKey(4) } }))));
    expect(await b.store.refresh()).toBe(true);
    expect(b.cfg.current).toMatchObject({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2, rosterVersion: 1 });
    expect(b.ring.current().epoch).toBe(2);
    expect(await b.store.read()).toEqual({ version: 1, roster: seed });
    // 同じ keybox をもう 1 度読んでも、足すものは無い。
    const writes = b.cfg.writes;
    expect(await b.store.refreshKeyboxes()).toBe(false);
    expect(b.cfg.writes).toBe(writes);
  });

  it('開けない keybox と名簿は投げずに飛ばす（同期を止めない）', async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a', { epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 });
    await a.store.update(() => seed);
    const b = await pc(wire, 'pc-b');
    // 別の相手宛てに封じた箱。
    wire.putKeybox('pc-b', 2, toBase64Url(await sealKeybox(a.cfg.current.keyPair.pub, { epoch: 2, recipient: 'pc-b' }, encodeEpochList({ epochs: { '2': testKey(4) } }))));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await b.store.refresh()).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain(testKey(4));
    warn.mockRestore();
    expect(b.cfg.writes).toBe(0);
  });

  it('名簿の版を cloud.json に書けなくても、読んだ名簿を返して投げない（pull の区切りを止めない）', async () => {
    const wire = new FakeWireClient();
    const a = await pc(wire, 'pc-a');
    await a.store.update(() => seed);
    const b = await pc(wire, 'pc-b');
    b.cfg.write = () => { throw new Error('EACCES: disk says no'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await b.store.read()).toEqual({ version: 1, roster: seed });
    await expect(b.store.refresh()).resolves.toBe(false);
    expect(err).toHaveBeenCalled();
    expect(err.mock.calls.flat().join(' ')).toMatch(/cloud\.json/);
    err.mockRestore();
  });
});
