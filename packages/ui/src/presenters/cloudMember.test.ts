import { describe, expect, it } from 'vitest';
import type { CloudDeviceDto, SyncStatusBody } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialCloudMember, type CloudMemberState, type JoinFailReason } from '../store/cloudMember.ts';
import { cloudJoinCommand, presentCloudMember } from './cloudMember.ts';

const NOW = Date.parse('2026-10-12T03:00:00Z');
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: 'https://h.example', lastPushAt: null, lastPullAt: NOW, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false };
const dev = (id: string, over: Partial<CloudDeviceDto> = {}): CloudDeviceDto => ({ id, name: id, platform: 'darwin', joinedAt: Date.parse('2026-09-21T03:00:00Z'), lastSeenAt: NOW - 12 * 60_000, revokedAt: null, expiresAt: null, kind: 'pc', self: false, ...over });
const member = (over: Partial<CloudMemberState> = {}): CloudMemberState => ({ ...initialCloudMember(), ...over });
const store = (over: Partial<Store> = {}): Store => ({ ...initialStore(), sync: SYNC, device: { id: 'a', name: 'studio' }, ...over });

describe('presentCloudMember', () => {
  it('Worker の一覧を、参加している PC と解除した PC に分け、OS は macOS と Windows と言う', () => {
    const devices = [dev('a', { self: true }), dev('b', { platform: 'win32' }), dev('c', { revokedAt: Date.parse('2026-10-10T03:00:00Z') })];
    const p = presentCloudMember(store({ cloudMember: member({ devices: { state: 'ok', devices, creator: false, message: null } }) }), NOW);
    expect(p.pcs.state).toBe('ok');
    expect(p.pcs.rows.map((r) => [r.id, r.os, r.self])).toEqual([['a', 'macOS', true], ['b', 'Windows', false]]);
    expect(p.pcs.rows[1]!.lastSeen).toBe('12 分前');
    expect(p.pcs.rows[0]!.joined).toBe('2026-09-21');
    expect(p.pcs.removed.map((r) => [r.id, r.removedOn])).toEqual([['c', '10-10 に解除']]);
  });

  it('名簿に無い端末（名前と OS が null）は ID で出し、OS の列は空ける', () => {
    const devices = [dev('a'), dev('b', { name: null, platform: null })];
    const p = presentCloudMember(store({ cloudMember: member({ devices: { state: 'ok', devices, creator: false, message: null } }) }), NOW);
    expect(p.pcs.rows.map((r) => [r.name, r.os])).toEqual([['a', 'macOS'], ['b', '—']]);
  });

  it('Worker が古いか繋がらないときは、同期の表の一覧に戻して理由を添える', () => {
    const s = store({
      devices: [{ id: 'a', name: 'studio', platform: 'darwin', lastSeenAt: NOW, self: true, shell: null }],
      cloudMember: member({ devices: { state: 'outdated', devices: [], creator: false, message: 'Worker が古い' } }),
    });
    const p = presentCloudMember(s, NOW);
    expect(p.pcs.state).toBe('fallback');
    expect(p.pcs.note).toBe('Worker が古い');
    expect(p.pcs.rows.map((r) => [r.id, r.joined])).toEqual([['a', null]]);
  });

  it('この PC が解除されていれば revoked で、名前を添える', () => {
    const p = presentCloudMember(store({ sync: { ...SYNC, state: 'error', revoked: true } }), NOW);
    expect(p.revoked).toBe(true);
    expect(p.thisPcName).toBe('studio');
  });

  it('参加が終わった理由ごとに見出しと本文を出し、承認済みの未完了のほかは参加コードを入力し直せる', () => {
    const check = { url: 'https://h.example', host: 'h.example', pcCount: 2, current: null };
    const join = (reason: JoinFailReason) => presentCloudMember(store({ cloudMember: member({ join: { kind: 'failed', reason, message: 'x', check } }) }), NOW).join;
    expect(join('network').failure).toMatchObject({ title: '接続先が応答しません' });
    expect(join('network').failure!.body).toContain('h.example');
    expect(join('other').failure).toMatchObject({ title: '参加できませんでした', body: 'x' });
    expect(join('expired').reenter).toBe(true);
    expect(join('pending').reenter).toBe(false);
  });

  it('接続先の確認の失敗は URL の欄の下の文にし、確認コードは 3 桁ずつ区切る', () => {
    const p = (j: CloudMemberState['join']) => presentCloudMember(store({ cloudMember: member({ join: j }) }), NOW).join;
    expect(p({ kind: 'url', failure: { code: 'invalid-url', message: '' } }).urlError).toBe('接続先の URL は https:// で始まる形で入力してください。');
    expect(p({ kind: 'url', failure: { code: 'outdated', message: '' } }).urlError).toContain('Worker');
    const check = { url: 'https://h.example', host: 'h.example', pcCount: 2, current: null };
    expect(p({ kind: 'waiting', check, sas: '012345', expiresAt: 1 }).sas).toBe('012 345');
  });

  it('別のクラウドに参加済みのときだけ、上書きの警告を出す', () => {
    const check = { url: 'https://n.example', host: 'n.example', pcCount: 1, current: { url: 'https://o.example' } };
    const p = presentCloudMember(store({ cloudMember: member({ join: { kind: 'code', check } }) }), NOW);
    expect(p.join).toMatchObject({ kind: 'code', host: 'n.example', url: 'https://n.example', pcCount: 1, rejoin: { current: 'https://o.example', next: 'https://n.example' } });
    const same = presentCloudMember(store({ cloudMember: member({ join: { kind: 'code', check: { ...check, current: { url: 'https://n.example' } } } }) }), NOW);
    expect(same.join.rejoin).toBeNull();
  });

  it('殻の中か、クラウドを作った PC か、ターミナルのコマンドを渡す', () => {
    const p = presentCloudMember(store({ desktop: true, cloudMember: member({ devices: { state: 'ok', devices: [], creator: true, message: null } }) }), NOW);
    expect(p.desktop).toBe(true);
    expect(p.creator).toBe(true);
    expect(p.commands).toEqual({ leave: 'hangar cloud leave', revoke: 'hangar cloud revoke <ID>', devices: 'hangar cloud devices' });
    expect(cloudJoinCommand(store({}))).toBe('hangar cloud join <URL>');
  });
});
