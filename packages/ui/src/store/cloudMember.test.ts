import { describe, expect, it } from 'vitest';
import type { CloudDevicesDto } from '@agent-hangar/shared';
import { initialCloudMember, reduceCloudMember, type JoinPlanView } from './cloudMember.ts';

const plan: JoinPlanView = { url: 'https://h.example', host: 'h.example', current: null, change: 'new' };
const row = (id: string, self = false) => ({ id, kind: 'pc' as const, name: id, platform: 'darwin', joinedAt: 1, lastSeenAt: 2, revokedAt: null, expiresAt: null, self });
const devices: CloudDevicesDto = { state: 'ok', devices: [row('a', true), row('b')], creator: false, message: null };

describe('reduceCloudMember', () => {
  it('参加の段は、確かめる、宛先の確認、参加中、参加済みと進む', () => {
    let s = initialCloudMember();
    s = reduceCloudMember(s, { type: 'join.checking' });
    expect(s.join).toEqual({ kind: 'checking' });
    s = reduceCloudMember(s, { type: 'join.planned', plan });
    expect(s.join).toEqual({ kind: 'confirm', plan });
    s = reduceCloudMember(s, { type: 'join.joining' });
    expect(s.join).toEqual({ kind: 'joining', plan });
    s = reduceCloudMember(s, { type: 'join.joined', host: 'h.example' });
    expect(s.join).toEqual({ kind: 'joined', host: 'h.example' });
  });

  it('参加の失敗は、確かめた宛先を残して理由を持つ。閉じれば最初に戻る', () => {
    let s = reduceCloudMember(initialCloudMember(), { type: 'join.planned', plan });
    s = reduceCloudMember(s, { type: 'join.joining' });
    s = reduceCloudMember(s, { type: 'join.failed', failure: { code: 'network', message: 'x' } });
    expect(s.join).toEqual({ kind: 'failed', plan, failure: { code: 'network', message: 'x' } });
    expect(reduceCloudMember(s, { type: 'join.reset' }).join).toEqual({ kind: 'idle' });
  });

  it('宛先を確かめる前の失敗は、宛先を持たない', () => {
    const s = reduceCloudMember(reduceCloudMember(initialCloudMember(), { type: 'join.checking' }), { type: 'join.failed', failure: { code: 'invalid-token', message: '' } });
    expect(s.join).toEqual({ kind: 'failed', plan: null, failure: { code: 'invalid-token', message: '' } });
  });

  it('PC を解除したら、一覧のその PC に解除日を付け、済んだ印を持つ', () => {
    let s = reduceCloudMember(initialCloudMember(), { type: 'devices.loaded', devices });
    s = reduceCloudMember(s, { type: 'revoke.start', id: 'b' });
    expect(s.revoke).toEqual({ id: 'b', kind: 'busy' });
    s = reduceCloudMember(s, { type: 'revoke.done', device: { id: 'b', kind: 'pc', joinedAt: 1, lastSeenAt: 2, revokedAt: 9, expiresAt: null } });
    expect(s.revoke).toEqual({ id: 'b', kind: 'done', name: 'b' });
    expect(s.devices!.devices.find((d) => d.id === 'b')!.revokedAt).toBe(9);
    expect(s.devices!.devices.find((d) => d.id === 'b')!.self).toBe(false);
  });

  it('解除の失敗は理由を持ち、閉じれば消える', () => {
    let s = reduceCloudMember(initialCloudMember(), { type: 'revoke.start', id: 'b' });
    s = reduceCloudMember(s, { type: 'revoke.failed', id: 'b', failure: { code: 'unreachable', message: 'm' } });
    expect(s.revoke).toEqual({ id: 'b', kind: 'failed', failure: { code: 'unreachable', message: 'm' } });
    expect(reduceCloudMember(s, { type: 'revoke.reset' }).revoke).toBeNull();
  });

  it('この PC の参加の解除は、解除中、解除済み（クラウドでの解除の失敗の理由つき）、失敗と移る', () => {
    let s = reduceCloudMember(initialCloudMember(), { type: 'leave.start' });
    expect(s.leave).toEqual({ kind: 'busy' });
    expect(reduceCloudMember(s, { type: 'leave.done', revokeError: null }).leave).toEqual({ kind: 'left', revokeError: null });
    s = reduceCloudMember(s, { type: 'leave.failed', failure: { code: 'broken-config', message: 'b' } });
    expect(s.leave).toEqual({ kind: 'failed', failure: { code: 'broken-config', message: 'b' } });
    expect(reduceCloudMember(s, { type: 'leave.reset' }).leave).toEqual({ kind: 'idle' });
  });
});
