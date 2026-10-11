import { describe, expect, it } from 'vitest';
import type { CloudDeviceDto, SyncStatusBody } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { initialCloudMember, type CloudMemberState } from '../store/cloudMember.ts';
import { presentCloudMember } from './cloudMember.ts';

const NOW = Date.parse('2026-10-12T03:00:00Z');
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: 'https://h.example', lastPushAt: null, lastPullAt: NOW, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false };
const dev = (id: string, over: Partial<CloudDeviceDto> = {}): CloudDeviceDto => ({ id, name: id, platform: 'darwin', joinedAt: Date.parse('2026-09-21T03:00:00Z'), lastSeenAt: NOW - 12 * 60_000, revokedAt: null, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null, self: false, ...over });
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

  it('最後の IP と、Cloudflare の英語のままの場所を 1 行にする', () => {
    const devices = [dev('a', { lastIp: '192.0.2.10', lastCity: 'Chiba', lastRegion: 'Chiba', lastCountry: 'JP' }), dev('b')];
    const p = presentCloudMember(store({ cloudMember: member({ devices: { state: 'ok', devices, creator: false, message: null } }) }), NOW);
    expect(p.pcs.rows[0]!.where).toBe('192.0.2.10 · Chiba, Chiba, JP');
    expect(p.pcs.rows[1]!.where).toBeNull();
  });

  it('Worker が古いか繋がらないときは、同期の表の一覧に戻して理由を添える', () => {
    const s = store({
      devices: [{ id: 'a', name: 'studio', platform: 'darwin', lastSeenAt: NOW, self: true, shell: null }],
      cloudMember: member({ devices: { state: 'outdated', devices: [], creator: false, message: 'Worker が古い' } }),
    });
    const p = presentCloudMember(s, NOW);
    expect(p.pcs.state).toBe('fallback');
    expect(p.pcs.note).toBe('Worker が古い');
    expect(p.pcs.rows.map((r) => [r.id, r.joined, r.where])).toEqual([['a', null, null]]);
  });

  it('この PC が解除されていれば revoked で、名前を添える', () => {
    const p = presentCloudMember(store({ sync: { ...SYNC, state: 'error', revoked: true } }), NOW);
    expect(p.revoked).toBe(true);
    expect(p.thisPcName).toBe('studio');
  });

  it('参加の段の失敗は、符号ごとの見出しと本文と、もう一度試すか貼り直すかを出す', () => {
    const plan = { url: 'https://h.example', host: 'h.example', current: null, change: 'new' as const };
    const fail = (code: string) => presentCloudMember(store({ cloudMember: member({ join: { kind: 'failed', plan, failure: { code, message: 'x' } } }) }), NOW).join.failure!;
    expect(fail('forbidden')).toMatchObject({ title: 'この参加トークンは使えません', again: 'repaste' });
    expect(fail('invalid-token')).toMatchObject({ title: '参加トークンを読み取れません', again: 'repaste' });
    expect(fail('network')).toMatchObject({ title: '宛先に接続できません', again: 'retry' });
    expect(fail('network').body).toContain('h.example');
    expect(fail('compat').again).toBe('retry');
    expect(fail('something-else')).toMatchObject({ title: '参加できませんでした', again: 'retry' });
    expect(fail('something-else').body).toContain('x');
  });

  it('別のクラウドへの参加し直しと、同じ宛先で秘密が違うときは、上書きの警告を出す', () => {
    const plan = { url: 'https://n.example', host: 'n.example', current: { url: 'https://o.example' }, change: 'other-cloud' as const };
    const p = presentCloudMember(store({ cloudMember: member({ join: { kind: 'confirm', plan } }) }), NOW);
    expect(p.join).toMatchObject({ kind: 'confirm', host: 'n.example', url: 'https://n.example', rejoin: { title: 'この PC は既に別のクラウドに参加しています。', current: 'https://o.example', next: 'https://n.example' } });
    const same = presentCloudMember(store({ cloudMember: member({ join: { kind: 'confirm', plan: { ...plan, change: 'same' } } }) }), NOW);
    expect(same.join.rejoin).toBeNull();
    const secret = presentCloudMember(store({ cloudMember: member({ join: { kind: 'confirm', plan: { ...plan, change: 'new-secret' } } }) }), NOW);
    expect(secret.join.rejoin!.title).toContain('参加用の秘密');
  });

  it('殻の中か、クラウドを作った PC か、ターミナルのコマンドを渡す', () => {
    const p = presentCloudMember(store({ desktop: true, cloudMember: member({ devices: { state: 'ok', devices: [], creator: true, message: null } }) }), NOW);
    expect(p.desktop).toBe(true);
    expect(p.creator).toBe(true);
    expect(p.commands).toEqual({ leave: 'hangar cloud leave', revoke: 'hangar cloud revoke <ID>', devices: 'hangar cloud devices' });
  });
});
