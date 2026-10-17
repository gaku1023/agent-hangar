import { describe, expect, it, vi } from 'vitest';
import { fromBase64Url, generateKeyPair, generatePhoneKeyPair, openPhoneKeybox, sealPhoneJoinRequest, toBase64Url, type KeyboxIn, type PhoneKeyPair } from '@agent-hangar/shared';
import type { CloudConfig } from '../config/cloud.ts';
import { CloudError } from '../sync/client.ts';
import { Keyring } from '../sync/keyring.ts';
import { RosterStore, type ConfigWriter } from '../sync/roster.ts';
import { seedCloud, type FakeWireClient } from '../../test/fake-cloud.ts';
import { PAIR_POLL_MS, PhonePairer, type PairerTimers, type PairerWire } from './pairer.ts';

// スマホの接続の PC 側（mobile/pairer.ts）の試験。
// 偽の Worker（test/fake-cloud.ts）の上で、スマホの側は shared の関数（generatePhoneKeyPair、sealPhoneJoinRequest、openPhoneKeybox）で動かす。

/** 手で回す時計と周期。fire は待っている周期を 1 回だけ回し、時計を PAIR_POLL_MS 進め、その問い合わせが終わるまで待つ。 */
function manualTimers(clock: { now: number }): PairerTimers & { pending(): boolean; fire(p: PhonePairer): Promise<void> } {
  let next: { fn: () => void; ms: number } | null = null;
  return {
    set(fn, ms) {
      next = { fn, ms };
      return next;
    },
    clear(h) {
      if (next === h) next = null;
    },
    pending: () => next !== null,
    async fire(p) {
      const n = next;
      if (!n) throw new Error('no poll is scheduled');
      expect(n.ms).toBe(PAIR_POLL_MS);
      next = null;
      clock.now += n.ms;
      n.fn();
      await p.settled();
      await new Promise((r) => setImmediate(r));
    },
  };
}

type Pc = { id: string; cfg: () => CloudConfig; keyring: Keyring; roster: RosterStore };

async function world(o: { wire?: (w: FakeWireClient) => PairerWire } = {}) {
  const clock = { now: 1_000_000 };
  const seeded = await seedCloud([
    { id: 'pc-a', name: 'pc-a', keyPair: await generateKeyPair() },
    { id: 'pc-b', name: 'pc-b', keyPair: await generateKeyPair() },
  ]);
  const pcOf = async (id: string): Promise<Pc> => {
    let cfg = seeded.configs[id]!;
    const writer: ConfigWriter = { read: () => cfg, write: (p) => { cfg = { ...cfg, ...p }; } };
    const keyring = await Keyring.fromConfig(cfg);
    const wire = id === 'pc-a' ? seeded.wire : seeded.wire.asDevice(id);
    return { id, cfg: () => cfg, keyring, roster: new RosterStore(wire, keyring, writer, id) };
  };
  const a = await pcOf('pc-a');
  const b = await pcOf('pc-b');
  const wire = seeded.wire;
  const timers = manualTimers(clock);
  const paired: { id: string; name: string }[] = [];
  const pairer = new PhonePairer({ wire: o.wire ? o.wire(wire) : wire, roster: a.roster, timers, now: () => clock.now, onPaired: (p) => paired.push(p) });
  /** スマホが券で接続する（POST /m/join）。鍵ペアはスマホが作る P-256。 */
  const phoneJoins = async (code: string, id = 'phone-1', name = 'phone-1'): Promise<PhoneKeyPair> => {
    const pair = await generatePhoneKeyPair();
    wire.joinPhone({ code, deviceId: id, sealed: await sealPhoneJoinRequest(code, id, { pub: pair.pub, name }) });
    return pair;
  };
  /** QR を出す（POST /api/sync/mobile-pairing と同じく、券を取って pairer に渡す）。 */
  const showQr = async (ttl = 5 * 60_000): Promise<{ code: string; expiresAt: number }> => {
    const t = await wire.createPairing();
    const ticket = { code: t.code, expiresAt: clock.now + ttl };
    await pairer.watch(ticket);
    return ticket;
  };
  /** 名簿を Worker から読み直す。 */
  const rosterNow = async (pc: Pc = a) => {
    pc.roster.invalidate();
    return pc.roster.read();
  };
  return { clock, wire, a, b, timers, pairer, paired, phoneJoins, showQr, rosterNow };
}

const calls = (w: FakeWireClient, method: string): number => w.calls.filter((c) => c.method === method).length;

describe('PhonePairer', () => {
  it('スマホの接続で名簿にスマホが増え（kind phone）、M[1] が名簿に入り、M の keybox が置かれる', async () => {
    const w = await world();
    const t = await w.showQr();
    const pair = await w.phoneJoins(t.code, 'phone-1', 'iPhone 1');
    await w.timers.fire(w.pairer);
    const r = await w.rosterNow();
    const phone = r.roster.entries.find((e) => e.id === 'phone-1');
    expect(phone).toMatchObject({ id: 'phone-1', kind: 'phone', name: 'iPhone 1', pub: pair.pub });
    expect(r.roster.entries.filter((e) => e.kind === 'pc').map((e) => e.id).sort()).toEqual(['pc-a', 'pc-b']);
    expect(r.roster.phoneKey?.epoch).toBe(1);
    // スマホは自分宛ての keybox を秘密鍵で開き、名簿と同じ M を得る。
    const box = w.wire.phoneKeybox('phone-1');
    expect(box?.epoch).toBe(1);
    const m = await openPhoneKeybox(pair.key, pair.pub, 'phone-1', box!);
    expect(Array.from(m)).toEqual(Array.from(fromBase64Url(r.roster.phoneKey!.key)!));
    // 発行した PC は M を Keyring と cloud.json に持つ。
    expect(w.a.keyring.phoneKey()?.epoch).toBe(1);
    expect(w.a.cfg().phoneKey).toEqual(r.roster.phoneKey);
    // keybox を置いたので、Worker は参加リクエストを消した。
    expect((await w.wire.getPairingsMine()).pairings).toEqual([]);
    expect(w.paired).toEqual([{ id: 'phone-1', name: 'iPhone 1' }]);
  });

  it('他の PC も名簿を読めば同じ M を Keyring と cloud.json に持つ', async () => {
    const w = await world();
    const t = await w.showQr();
    await w.phoneJoins(t.code);
    await w.timers.fire(w.pairer);
    expect(w.b.keyring.phoneKey()).toBeNull();
    const r = await w.rosterNow(w.b);
    expect(w.b.keyring.phoneKey()?.epoch).toBe(1);
    expect(w.b.cfg().phoneKey).toEqual(r.roster.phoneKey);
  });

  it('名簿に phoneKey があれば M[1] を作り直さず、2 台目のスマホにも同じ M を封じる', async () => {
    const w = await world();
    const p1 = await w.phoneJoins((await w.showQr()).code, 'phone-1');
    await w.timers.fire(w.pairer);
    const first = (await w.rosterNow()).roster.phoneKey;
    const p2 = await w.phoneJoins((await w.showQr()).code, 'phone-2');
    await w.timers.fire(w.pairer);
    const r = await w.rosterNow();
    expect(r.roster.phoneKey).toEqual(first);
    expect(r.roster.entries.filter((e) => e.kind === 'phone').map((e) => e.id).sort()).toEqual(['phone-1', 'phone-2']);
    const m1 = await openPhoneKeybox(p1.key, p1.pub, 'phone-1', w.wire.phoneKeybox('phone-1')!);
    const m2 = await openPhoneKeybox(p2.key, p2.pub, 'phone-2', w.wire.phoneKeybox('phone-2')!);
    expect(Array.from(m2)).toEqual(Array.from(m1));
  });

  it('名簿を先に書き、keybox を置けなかったら次の問い合わせで置き直す（M は変えない）', async () => {
    let fail = true;
    const w = await world({
      wire: (wire) => ({
        getPairingsMine: () => wire.getPairingsMine(),
        putPhoneKeyboxes: async (boxes: KeyboxIn[]) => {
          if (fail) { fail = false; throw new CloudError(0, 'offline'); }
          return wire.putPhoneKeyboxes(boxes);
        },
      }),
    });
    const pair = await w.phoneJoins((await w.showQr()).code);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.timers.fire(w.pairer);
    quiet.mockRestore();
    // 名簿にはもうスマホがいて、keybox はまだ無く、参加リクエストは残っている。
    const r1 = await w.rosterNow();
    expect(r1.roster.entries.some((e) => e.id === 'phone-1')).toBe(true);
    expect(w.wire.phoneKeybox('phone-1')).toBeNull();
    expect((await w.wire.getPairingsMine()).pairings).toHaveLength(1);
    await w.timers.fire(w.pairer);
    const r2 = await w.rosterNow();
    expect(r2.roster.phoneKey).toEqual(r1.roster.phoneKey);
    // 同じ行のままなので、名簿は書き直さない。
    expect(r2.version).toBe(r1.version);
    const m = await openPhoneKeybox(pair.key, pair.pub, 'phone-1', w.wire.phoneKeybox('phone-1')!);
    expect(Array.from(m)).toEqual(Array.from(fromBase64Url(r2.roster.phoneKey!.key)!));
  });

  it('失敗が続く参加リクエストは、3 回までは問い合わせごとに、その後は 30 秒おきにだけ試し、名簿を読む回数を増やさない', async () => {
    let fail = true;
    let tries = 0;
    const w = await world({
      wire: (wire) => ({
        getPairingsMine: () => wire.getPairingsMine(),
        putPhoneKeyboxes: async (boxes: KeyboxIn[]) => {
          tries++;
          if (fail) throw new CloudError(0, 'offline');
          return wire.putPhoneKeyboxes(boxes);
        },
      }),
    });
    await w.phoneJoins((await w.showQr()).code);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rosterReads = () => calls(w.wire, 'getRoster');
    const before = rosterReads();
    // 60 秒（問い合わせ 20 回）。3 秒おきの 3 回と、その 30 秒後の 1 回だけ試す。
    for (let i = 0; i < 20; i++) await w.timers.fire(w.pairer);
    quiet.mockRestore();
    expect(tries).toBe(4);
    expect(rosterReads() - before).toBeLessThanOrEqual(8);
    // 失敗が止めば、次の試しの時刻に接続を終える。
    fail = false;
    for (let i = 0; i < 10 && w.wire.phoneKeybox('phone-1') === null; i++) await w.timers.fire(w.pairer);
    expect(w.wire.phoneKeybox('phone-1')).not.toBeNull();
  });

  it('PUT /phone-keyboxes が 400 の unknown recipient（解除されたスマホ）なら、その券を捨てる', async () => {
    const w = await world();
    await w.phoneJoins((await w.showQr()).code);
    w.wire.revoke('phone-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await w.timers.fire(w.pairer);
    await w.timers.fire(w.pairer);
    warn.mockRestore();
    expect(calls(w.wire, 'putPhoneKeyboxes')).toBe(1);
    expect(w.wire.phoneKeybox('phone-1')).toBeNull();
    expect(w.paired).toEqual([]);
    // 接続の直後に解除されたスマホの行は、名簿からも外す。
    expect((await w.rosterNow()).roster.entries.some((e) => e.id === 'phone-1')).toBe(false);
  });

  it('名簿の写しを読み直してから扱う。他の PC がスマホを解除して M を回していれば、新しい世代の M を封じる', async () => {
    let fail = true;
    const w = await world({
      wire: (wire) => ({
        getPairingsMine: () => wire.getPairingsMine(),
        putPhoneKeyboxes: async (boxes: KeyboxIn[]) => {
          if (fail) { fail = false; throw new CloudError(0, 'offline'); }
          return wire.putPhoneKeyboxes(boxes);
        },
      }),
    });
    const pair = await w.phoneJoins((await w.showQr()).code);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.timers.fire(w.pairer);
    quiet.mockRestore();
    // pc-b が M を次の世代にする（スマホの解除）。pc-a の名簿の写しは古いまま。
    const next = { epoch: 2, key: toBase64Url(new Uint8Array(32).fill(7)) };
    await w.b.roster.update((r) => ({ ...r, phoneKey: next }));
    await w.timers.fire(w.pairer);
    const box = w.wire.phoneKeybox('phone-1');
    expect(box?.epoch).toBe(2);
    expect(Array.from(await openPhoneKeybox(pair.key, pair.pub, 'phone-1', box!))).toEqual(Array.from(new Uint8Array(32).fill(7)));
  });

  it('watch が返す券の印で、keybox を置き終えたスマホを引ける（置く前は null）', async () => {
    const w = await world();
    const t = await w.wire.createPairing();
    const pairId = await w.pairer.watch({ code: t.code, expiresAt: w.clock.now + 5 * 60_000 });
    expect(typeof pairId).toBe('string');
    expect(w.pairer.pairedFor(pairId)).toBeNull();
    await w.phoneJoins(t.code, 'phone-1', 'iPhone 1');
    expect(w.pairer.pairedFor(pairId)).toBeNull();
    await w.timers.fire(w.pairer);
    expect(w.pairer.pairedFor(pairId)).toEqual({ id: 'phone-1', name: 'iPhone 1' });
    expect(w.pairer.pairedFor('unknown')).toBeNull();
  });

  it('期限まで 3 秒ごとに問い合わせ、期限の後に 1 回だけ問い合わせて止まる。端末の一覧は読まない', async () => {
    const w = await world();
    await w.showQr(9_000);
    let n = 0;
    while (w.timers.pending()) {
      await w.timers.fire(w.pairer);
      n++;
    }
    // 3、6、9 秒（期限ちょうど）と、期限の後の 12 秒。
    expect(n).toBe(4);
    expect(calls(w.wire, 'getPairingsMine')).toBe(4);
    expect(calls(w.wire, 'listDevices')).toBe(0);
  });

  it('QR を出し直したときも、前の券の開いたままの参加リクエストを処理する（スマホの「もう一度待つ」）', async () => {
    const w = await world();
    const t1 = await w.showQr(6_000);
    while (w.timers.pending()) await w.timers.fire(w.pairer);
    // QR の期限が過ぎて問い合わせが止まった後に、スマホが前の券で接続していた（Worker の券は 5 分生きている）。
    const pair = await w.phoneJoins(t1.code);
    expect(w.wire.phoneKeybox('phone-1')).toBeNull();
    await w.showQr();
    await w.timers.fire(w.pairer);
    expect(await openPhoneKeybox(pair.key, pair.pub, 'phone-1', w.wire.phoneKeybox('phone-1')!)).toHaveLength(32);
  });

  it('券で開けない参加リクエストは名簿に足さず、二度と試さない', async () => {
    const w = await world();
    const t = await w.showQr();
    const pair = await generatePhoneKeyPair();
    // 別の券で封じた（Worker が付け替えた）リクエスト。
    w.wire.joinPhone({ code: t.code, deviceId: 'phone-1', sealed: await sealPhoneJoinRequest('another-ticket', 'phone-1', { pub: pair.pub, name: 'x' }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await w.timers.fire(w.pairer);
    await w.timers.fire(w.pairer);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect((await w.rosterNow()).roster.entries.some((e) => e.id === 'phone-1')).toBe(false);
    expect(calls(w.wire, 'putPhoneKeyboxes')).toBe(0);
  });

  it('名前の制御文字を除き、長い名前を切る。空なら ID で呼ぶ', async () => {
    const w = await world();
    await w.phoneJoins((await w.showQr()).code, 'phone-1', `\u0007  ${'あ'.repeat(80)}  `);
    await w.phoneJoins((await w.showQr()).code, 'phone-2', '\u0001\u0002');
    await w.timers.fire(w.pairer);
    const r = await w.rosterNow();
    expect(r.roster.entries.find((e) => e.id === 'phone-1')!.name).toBe('あ'.repeat(64));
    expect(r.roster.entries.find((e) => e.id === 'phone-2')!.name).toBe('phone-2');
  });

  it('stop の後は問い合わせない', async () => {
    const w = await world();
    await w.showQr();
    w.pairer.stop();
    expect(w.timers.pending()).toBe(false);
    await w.pairer.pollOnce();
    expect(calls(w.wire, 'getPairingsMine')).toBe(0);
  });
});
