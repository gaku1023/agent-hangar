import { describe, expect, it, vi } from 'vitest';
import type { CloudDevicesDto, MobilePairingDto } from '@agent-hangar/shared';
import { initialCloudMember, type CloudMemberState } from '../store/cloudMember.ts';
import type { CloudBridge } from './desktop.ts';
import { PAIR_TTL_MS as PAIR_TTL_SHOWN_MS } from '../presenters/cloudMember.ts';
import { CLOUD_RESTART_MS, createCloudMemberRunner, PAIR_POLL_MS } from './cloudMember.ts';

const plan = { url: 'https://h.example', host: 'h.example', current: null, change: 'new' as const };
const devices: CloudDevicesDto = { state: 'ok', devices: [], creator: false, message: null };

function rig(bridge: Partial<CloudBridge> | null = {}) {
  let s: CloudMemberState = initialCloudMember();
  const timers: { fn: () => void; ms: number }[] = [];
  const restart = vi.fn();
  const load = vi.fn(async () => devices);
  const full: CloudBridge | null = bridge === null ? null : {
    joinPlan: async () => ({ ok: true, value: plan }),
    join: async () => ({ ok: true, value: { url: plan.url, host: plan.host } }),
    revoke: async (id) => ({ ok: true, value: { id, kind: 'pc' as const, joinedAt: 1, lastSeenAt: 2, revokedAt: 3, expiresAt: null } }),
    leave: async () => ({ ok: true, value: { revoked: true, revokeError: null, creator: false } }),
    ...bridge,
  };
  const r = createCloudMemberRunner({ bridge: full, load, pair: async () => ({ state: 'not-joined' }), now: () => 0, restart, setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, get: () => s, set: (n) => { s = n; } });
  return { r, get: () => s, timers, restart, load };
}

const NOW = 1_700_000_000_000;
const phone = (id: string, over: Partial<CloudDevicesDto['devices'][number]> = {}): CloudDevicesDto['devices'][number] => ({ id, name: id, platform: null, joinedAt: NOW, lastSeenAt: NOW, revokedAt: null, expiresAt: null, kind: 'mobile', self: false, ...over });
const pc = { ...phone('studio'), platform: 'darwin', kind: 'pc' as const, self: true };
const ready: MobilePairingDto = { state: 'ready', pairUrl: 'https://w.example/app/#pair=PAIRTEXT', pairText: 'PAIRTEXT', expiresAt: NOW + PAIR_TTL_SHOWN_MS };

/** スマホの接続の段の試験台。時計は now で進め、予約は timers に積む（走らせるのは試験が選ぶ）。 */
function phoneRig(o: { pair?: () => Promise<MobilePairingDto>; lists?: CloudDevicesDto[] } = {}) {
  let s: CloudMemberState = { ...initialCloudMember(), devices: { state: 'ok', devices: [pc], creator: false, message: null } };
  let now = NOW;
  const timers: { fn: () => void; ms: number }[] = [];
  const lists = [...(o.lists ?? [])];
  const load = vi.fn(async () => lists.shift() ?? s.devices!);
  const pair = vi.fn(o.pair ?? (async () => ready));
  const r = createCloudMemberRunner({ bridge: null, load, pair, now: () => now, restart: () => {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, get: () => s, set: (n) => { s = n; } });
  /** いちばん古い、ms の長さの予約を 1 つ走らせる。 */
  const fire = async (ms: number) => {
    const i = timers.findIndex((t) => t.ms === ms);
    if (i < 0) throw new Error(`no timer of ${ms}ms`);
    const [t] = timers.splice(i, 1);
    t!.fn();
    await flush();
  };
  return { r, get: () => s, timers, load, pair, fire, tick: (ms: number) => { now += ms; } };
}

describe('スマホの接続の QR', () => {
  it('QR を出すと券を取り、ready の間は 3 秒ごとに端末の一覧を再読み込みする', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    expect(x.get().phone).toEqual({ kind: 'loading' });
    await flush();
    expect(x.get().phone).toMatchObject({ kind: 'ready', pairText: 'PAIRTEXT', expiresAt: NOW + PAIR_TTL_SHOWN_MS });
    expect(x.timers.map((t) => t.ms).sort()).toEqual([PAIR_POLL_MS, PAIR_TTL_SHOWN_MS].sort());
    await x.fire(PAIR_POLL_MS);
    await x.fire(PAIR_POLL_MS);
    expect(x.load).toHaveBeenCalledTimes(2);
    expect(x.timers.filter((t) => t.ms === PAIR_POLL_MS)).toHaveLength(1);
  });

  it('QR を出している間に kind=mobile の新しい行が現れたら paired にし、再読み込みを止める。前からあったスマホは数えない', async () => {
    const old = phone('old-phone');
    const base: CloudDevicesDto = { state: 'ok', devices: [pc, old], creator: false, message: null };
    const x = phoneRig({ lists: [base, base, { ...base, devices: [pc, old, phone('p1', { name: 'iPhone' })] }] });
    x.r.run({ op: 'load' });
    await flush();
    x.r.run({ op: 'pair' });
    await flush();
    await x.fire(PAIR_POLL_MS);
    expect(x.get().phone.kind).toBe('ready');
    await x.fire(PAIR_POLL_MS);
    expect(x.get().phone).toEqual({ kind: 'paired', id: 'p1', name: 'iPhone' });
    expect(x.get().devices?.devices.map((d) => d.id)).toEqual(['studio', 'old-phone', 'p1']);
    // paired になったら、残っていた予約が走っても読み直さない。
    const before = x.load.mock.calls.length;
    while (x.timers.some((t) => t.ms === PAIR_POLL_MS)) await x.fire(PAIR_POLL_MS);
    expect(x.load).toHaveBeenCalledTimes(before);
  });

  it('QR を閉じたら 3 秒ごとの読み直しが止まり、QR の中身も状態から消える', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    await flush();
    x.r.run({ op: 'pairClose' });
    expect(x.get().phone).toEqual({ kind: 'idle' });
    expect(JSON.stringify(x.get())).not.toContain('PAIRTEXT');
    await x.fire(PAIR_POLL_MS);
    expect(x.load).not.toHaveBeenCalled();
    expect(x.timers.some((t) => t.ms === PAIR_POLL_MS)).toBe(false);
  });

  it('5 分たったら expired にして QR の中身を捨て、読み直しも止める', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    await flush();
    x.tick(PAIR_TTL_SHOWN_MS);
    await x.fire(PAIR_TTL_SHOWN_MS);
    expect(x.get().phone).toEqual({ kind: 'expired' });
    expect(JSON.stringify(x.get())).not.toContain('PAIRTEXT');
    await x.fire(PAIR_POLL_MS);
    expect(x.load).not.toHaveBeenCalled();
  });

  it('QR の段を開いたまま新しい QR を頼むと renew つきの loading にし（段を畳まない）、届いたら ready に戻る', async () => {
    const x = phoneRig();
    x.r.run({ op: 'pair' });
    await flush();
    x.tick(PAIR_TTL_SHOWN_MS);
    await x.fire(PAIR_TTL_SHOWN_MS);
    x.r.run({ op: 'pair' });
    expect(x.get().phone).toEqual({ kind: 'loading', renew: true });
    await flush();
    expect(x.get().phone.kind).toBe('ready');
  });

  it('新しい QR を出すと、前の QR の予約は効かなくなる', async () => {
    let n = 0;
    const x = phoneRig({ pair: async () => ({ ...ready, pairText: `T${++n}`, expiresAt: NOW + PAIR_TTL_SHOWN_MS }) });
    x.r.run({ op: 'pair' });
    await flush();
    x.r.run({ op: 'pair' });
    await flush();
    expect(x.get().phone).toMatchObject({ kind: 'ready', pairText: 'T2' });
    // 前の QR の期限の予約が走っても、新しい QR は残る。
    await x.fire(PAIR_TTL_SHOWN_MS);
    expect(x.get().phone).toMatchObject({ kind: 'ready', pairText: 'T2' });
  });

  it('Worker が古い、券の取りすぎ、参加していない、失敗は、それぞれの段にして読み直さない', async () => {
    for (const [answer, stage] of [
      [{ state: 'worker-too-old', compat: 6 }, { kind: 'old', compat: 6 }],
      [{ state: 'rate-limited' }, { kind: 'limited' }],
      [{ state: 'not-joined' }, { kind: 'notJoined' }],
    ] as const) {
      const x = phoneRig({ pair: async () => answer as MobilePairingDto });
      x.r.run({ op: 'pair' });
      await flush();
      expect(x.get().phone).toEqual(stage);
      expect(x.timers).toEqual([]);
    }
    const y = phoneRig({ pair: async () => { throw new Error('接続できません'); } });
    y.r.run({ op: 'pair' });
    await flush();
    expect(y.get().phone).toEqual({ kind: 'failed', message: '接続できません' });
  });
});

const flush = () => new Promise((res) => setTimeout(res, 0));

describe('createCloudMemberRunner', () => {
  it('貼った参加トークンで宛先を確かめ、確認の後に同じトークンで参加し、参加したら再起動を頼む', async () => {
    const joinPlan = vi.fn(async () => ({ ok: true as const, value: plan }));
    const join = vi.fn(async () => ({ ok: true as const, value: { url: plan.url, host: plan.host } }));
    const x = rig({ joinPlan, join });
    x.r.run({ op: 'plan', token: '  tok  ' });
    expect(x.get().join).toEqual({ kind: 'checking' });
    await flush();
    expect(x.get().join).toEqual({ kind: 'confirm', plan });
    x.r.run({ op: 'join', overwrite: false });
    await flush();
    expect(join).toHaveBeenCalledWith('tok', false);
    expect(joinPlan).toHaveBeenCalledWith('tok');
    expect(x.get().join).toEqual({ kind: 'joined', host: 'h.example' });
    expect(x.timers.map((t) => t.ms)).toEqual([CLOUD_RESTART_MS]);
    x.timers[0]!.fn();
    expect(x.restart).toHaveBeenCalledTimes(1);
  });

  it('参加トークンは状態に残さない', async () => {
    const x = rig();
    x.r.run({ op: 'plan', token: 'SECRET-TOKEN' });
    await flush();
    x.r.run({ op: 'join', overwrite: false });
    await flush();
    expect(JSON.stringify(x.get())).not.toContain('SECRET-TOKEN');
  });

  it('段を閉じたら持っていたトークンを捨て、その後の参加は何もしない', async () => {
    const join = vi.fn(async () => ({ ok: true as const, value: { url: plan.url, host: plan.host } }));
    const x = rig({ join });
    x.r.run({ op: 'plan', token: 'tok' });
    await flush();
    x.r.run({ op: 'joinCancel' });
    expect(x.get().join).toEqual({ kind: 'idle' });
    x.r.run({ op: 'join', overwrite: false });
    await flush();
    expect(join).not.toHaveBeenCalled();
  });

  it('参加に失敗したら宛先を残して理由を出し、繋がらないときはもう一度試せる', async () => {
    const join = vi.fn(async () => ({ ok: false as const, failure: { code: 'network', message: 'm' } }));
    const x = rig({ join });
    x.r.run({ op: 'plan', token: 'tok' });
    await flush();
    x.r.run({ op: 'join', overwrite: false });
    await flush();
    expect(x.get().join).toEqual({ kind: 'failed', plan, failure: { code: 'network', message: 'm' } });
    x.r.run({ op: 'join', overwrite: false });
    await flush();
    expect(join).toHaveBeenCalledTimes(2);
    expect(x.restart).not.toHaveBeenCalled();
  });

  it('秘密が違うときと読めないときは、トークンを捨てる（貼り直してもらう）', async () => {
    const join = vi.fn(async () => ({ ok: false as const, failure: { code: 'forbidden', message: '' } }));
    const x = rig({ join });
    x.r.run({ op: 'plan', token: 'tok' });
    await flush();
    x.r.run({ op: 'join', overwrite: false });
    await flush();
    x.r.run({ op: 'join', overwrite: false });
    await flush();
    expect(join).toHaveBeenCalledTimes(1);
  });

  it('空の貼り付けは何もしない', () => {
    const x = rig();
    x.r.run({ op: 'plan', token: '   ' });
    expect(x.get().join).toEqual({ kind: 'idle' });
  });

  it('ほかの PC を解除したら、一覧を取り直す。失敗は理由を持つ', async () => {
    const x = rig();
    x.r.run({ op: 'revoke', id: 'b' });
    expect(x.get().revoke).toEqual({ id: 'b', kind: 'busy' });
    await flush();
    expect(x.get().revoke).toEqual({ id: 'b', kind: 'done', name: 'b' });
    expect(x.load).toHaveBeenCalledTimes(1);
    const y = rig({ revoke: async () => ({ ok: false, failure: { code: 'unreachable', message: 'm' } }) });
    y.r.run({ op: 'revoke', id: 'b' });
    await flush();
    expect(y.get().revoke).toEqual({ id: 'b', kind: 'failed', failure: { code: 'unreachable', message: 'm' } });
  });

  it('この PC の参加を解除したら再起動を頼む。クラウドで解除できなかったときは、理由を読めるよう自動では再起動しない', async () => {
    const x = rig();
    x.r.run({ op: 'leave', revoke: true });
    expect(x.get().leave).toEqual({ kind: 'busy' });
    await flush();
    expect(x.get().leave).toEqual({ kind: 'left', revokeError: null });
    expect(x.timers.map((t) => t.ms)).toEqual([CLOUD_RESTART_MS]);
    const y = rig({ leave: async () => ({ ok: true, value: { revoked: false, revokeError: '繋がりません', creator: false } }) });
    y.r.run({ op: 'leave', revoke: true });
    await flush();
    expect(y.get().leave).toEqual({ kind: 'left', revokeError: '繋がりません' });
    expect(y.timers).toEqual([]);
  });

  it('一覧を取る。殻が無くても取る（ブラウザでも一覧は見せる）', async () => {
    const x = rig(null);
    x.r.run({ op: 'load' });
    await flush();
    expect(x.get().devices).toEqual(devices);
    x.r.run({ op: 'plan', token: 'tok' });
    expect(x.get().join).toEqual({ kind: 'idle' });
  });
});
