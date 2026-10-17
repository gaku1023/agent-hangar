import { describe, expect, it } from 'vitest';
import type { CloudDevicesDto } from '@agent-hangar/shared';
import { initialCloudMember, reduceCloudMember, type JoinCheckView } from './cloudMember.ts';

const check: JoinCheckView = { url: 'https://h.example', host: 'h.example', pcCount: 2, current: null };
const row = (id: string, self = false) => ({ id, kind: 'pc' as const, name: id, platform: 'darwin', joinedAt: 1, lastSeenAt: 2, revokedAt: null, expiresAt: null, self });
const devices: CloudDevicesDto = { state: 'ok', devices: [row('a', true), row('b')], creator: false, message: null };

describe('reduceCloudMember', () => {
  it('参加の段は、接続先の URL、確認中、参加コード、送信中、承認待ち、完了と進む', () => {
    let s = initialCloudMember();
    expect(s.join).toEqual({ kind: 'url', failure: null });
    s = reduceCloudMember(s, { type: 'join.checking', url: 'https://h.example' });
    expect(s.join).toEqual({ kind: 'checking', url: 'https://h.example' });
    s = reduceCloudMember(s, { type: 'join.checked', check });
    expect(s.join).toEqual({ kind: 'code', check });
    s = reduceCloudMember(s, { type: 'join.requesting' });
    expect(s.join).toEqual({ kind: 'requesting', check });
    s = reduceCloudMember(s, { type: 'join.waiting', sas: '123456', expiresAt: 9 });
    expect(s.join).toEqual({ kind: 'waiting', check, sas: '123456', expiresAt: 9 });
    s = reduceCloudMember(s, { type: 'join.done' });
    expect(s.join).toEqual({ kind: 'done', host: 'h.example' });
  });

  it('接続先の確認の失敗は、URL の段に理由を持って戻る', () => {
    const s = reduceCloudMember(reduceCloudMember(initialCloudMember(), { type: 'join.checking', url: 'https://x' }), { type: 'join.checkFailed', failure: { code: 'unreachable', message: '' } });
    expect(s.join).toEqual({ kind: 'url', failure: { code: 'unreachable', message: '' } });
  });

  it('参加の失敗は理由と、接続先の確認の結果を持つ。入力し直すと参加コードの段へ、閉じれば最初に戻る', () => {
    let s = reduceCloudMember(initialCloudMember(), { type: 'join.checked', check });
    s = reduceCloudMember(s, { type: 'join.requesting' });
    s = reduceCloudMember(s, { type: 'join.failed', reason: 'expired', message: '' });
    expect(s.join).toEqual({ kind: 'failed', reason: 'expired', message: '', check });
    expect(reduceCloudMember(s, { type: 'join.reenter' }).join).toEqual({ kind: 'code', check });
    expect(reduceCloudMember(s, { type: 'join.reset' }).join).toEqual({ kind: 'url', failure: null });
  });

  it('PC を追加の段は、サーバーの承認の状態の写しを持つ。拒否の後に受信した idle では、拒否の知らせを保持する', () => {
    let s = reduceCloudMember(initialCloudMember(), { type: 'add.issuing' });
    expect(s.add).toEqual({ kind: 'issuing' });
    const open = { kind: 'open' as const, code: 'K7QM-2XFD', expiresAt: 9 };
    s = reduceCloudMember(s, { type: 'add.state', state: open });
    expect(s.add).toEqual(open);
    s = reduceCloudMember(s, { type: 'add.rejected', name: 'pc-b' });
    expect(reduceCloudMember(s, { type: 'add.state', state: { kind: 'idle' } }).add).toEqual({ kind: 'rejected', name: 'pc-b' });
    expect(reduceCloudMember(s, { type: 'add.reset' }).add).toEqual({ kind: 'idle' });
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
