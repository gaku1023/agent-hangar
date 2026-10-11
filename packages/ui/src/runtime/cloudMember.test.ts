import { describe, expect, it, vi } from 'vitest';
import type { CloudDevicesDto } from '@agent-hangar/shared';
import { initialCloudMember, type CloudMemberState } from '../store/cloudMember.ts';
import type { CloudBridge } from './desktop.ts';
import { CLOUD_RESTART_MS, createCloudMemberRunner } from './cloudMember.ts';

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
    revoke: async (id) => ({ ok: true, value: { id, name: id, platform: 'darwin', joinedAt: 1, lastSeenAt: 2, revokedAt: 3, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null } }),
    leave: async () => ({ ok: true, value: { revoked: true, revokeError: null, creator: false } }),
    ...bridge,
  };
  const r = createCloudMemberRunner({ bridge: full, load, restart, setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, get: () => s, set: (n) => { s = n; } });
  return { r, get: () => s, timers, restart, load };
}

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
