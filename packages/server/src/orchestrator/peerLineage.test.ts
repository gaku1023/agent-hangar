import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { applyRemoteBatch } from '../sync/apply.ts';
import { orchestratorIdsSource, peerOrchestratorIds } from './peerLineage.ts';

const ME = 'dev-me';
const HOST = 'dev-host';
const status = (ids?: string[]) => JSON.stringify({ accounts: [], agents: ['claude-code'], lan_ips: [], ssh_host_key: null, hangar_version: '1.0.0', ...(ids ? { orchestrator_ids: ids } : {}) });

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

describe('ほかの PC の統括の系譜', () => {
  it('ほかの PC の devices の行に載った id を返す。自分の行と、様子の欄が無い行は見ない', () => {
    upsertShared(db, 'devices', { id: HOST, name: 'host', platform: 'darwin', status: status(['now', 'old']) }, HOST);
    upsertShared(db, 'devices', { id: ME, name: 'me', platform: 'darwin', status: status(['mine']) }, ME);
    upsertShared(db, 'devices', { id: 'dev-old', name: 'old', platform: 'linux' }, 'dev-old');
    upsertShared(db, 'devices', { id: 'dev-broken', name: 'broken', platform: 'linux', status: '{' }, 'dev-broken');
    expect([...peerOrchestratorIds(db, ME)()].sort()).toEqual(['now', 'old']);
  });

  it('解除した PC の行（deleted_at）に残る系譜も見る。前の統括の会話をずっと隠すため', () => {
    upsertShared(db, 'devices', { id: HOST, name: 'host', platform: 'darwin', status: status(['now']) }, HOST);
    softDeleteShared(db, 'devices', HOST, ME);
    expect([...peerOrchestratorIds(db, ME)()]).toEqual(['now']);
  });

  it('同期で devices の行が降りたら、次に読むときから変わる', () => {
    const read = peerOrchestratorIds(db, ME);
    expect([...read()]).toEqual([]);
    const payload = { id: HOST, name: 'host', platform: 'darwin', last_seen_at: 1, shell_hook: null, status: status(['now']), updated_at: 100, deleted_at: null, origin_device: HOST };
    expect(applyRemoteBatch(db, [{ seq: 1, tableName: 'devices', rowId: HOST, op: 'upsert', deviceId: HOST, updatedAt: 100, payload }], { ownDeviceId: ME, skipOwn: true })).toHaveLength(1);
    expect([...read()]).toEqual(['now']);
    const next = { ...payload, status: status(['new', 'now']), updated_at: 200 };
    applyRemoteBatch(db, [{ seq: 2, tableName: 'devices', rowId: HOST, op: 'upsert', deviceId: HOST, updatedAt: 200, payload: next }], { ownDeviceId: ME, skipOwn: true });
    expect([...read()].sort()).toEqual(['new', 'now']);
  });

  it('手元の系譜と合わせる。手元の系譜だけなら今までと同じ並び', () => {
    let local: string[] = ['here', 'before'];
    const ids = orchestratorIdsSource(db, ME, () => local);
    expect(ids()).toEqual(['here', 'before']);
    upsertShared(db, 'devices', { id: HOST, name: 'host', platform: 'darwin', status: status(['now', 'here']) }, HOST);
    expect(ids()).toEqual(['here', 'before', 'now']);
    local = [];
    expect([...ids()].sort()).toEqual(['here', 'now']);
  });
});
