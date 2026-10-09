import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeOut } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { openDb, type Db } from '../../db/open.ts';
import { applyRemoteChange } from '../../sync/apply.ts';
import { deriveFileKey } from '../../sync/crypto.ts';
import { ConfigSyncService } from '../../sync/config/service.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 設定の同期（作り直した実装）の経路の試験。経路は routes/sync.ts にある。
// 相手の PC は、別の DB と別の ~/.claude を持つもう 1 つのサービスで作り、偽のクラウドで束を渡す。

const key = deriveFileKey('join-secret');
const SECRET = 'key = sk-ant-api03-AbCdEfGhIjKlMnOpQrSt0123456789';
let t: TestWorld;
let tmp: string;
let app: ReturnType<typeof createApp>;
let service: ConfigSyncService;
let myClaude: string;
let myHome: string;
let peer: { db: Db; claudeDir: string; service: ConfigSyncService };
let cloud: FakeCloudClient;
const state = { approval: 'each' as 'each' | 'auto' };

const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const send = (method: string, p: string, body?: unknown) => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const write = (dir: string, rel: string, text: string): void => { const abs = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };

beforeEach(async () => {
  t = await testDeps();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-routes-'));
  myClaude = path.join(tmp, 'my-claude');
  myHome = path.join(tmp, 'my-home');
  fs.mkdirSync(myClaude); fs.mkdirSync(myHome);
  cloud = new FakeCloudClient({ deviceId: 'shared' });
  service = new ConfigSyncService({ db: t.db, deviceId: 'd', deviceName: 'mac', claudeDir: myClaude, home: myHome, cloud: cloud.asDevice('d'), key, enabled: () => true, switchedOn: () => true, approval: () => state.approval });
  state.approval = 'each';
  const peerDb = openDb(':memory:');
  const peerClaude = path.join(tmp, 'peer-claude');
  fs.mkdirSync(peerClaude);
  peer = {
    db: peerDb, claudeDir: peerClaude,
    service: new ConfigSyncService({ db: peerDb, deviceId: 'peer', deviceName: 'mini', claudeDir: peerClaude, home: path.join(tmp, 'peer-home'), cloud: cloud.asDevice('peer'), key, enabled: () => true, switchedOn: () => true, approval: () => 'each' }),
  };
  app = createApp({ ...t.deps, configBundle: service });
});
afterEach(() => { peer.db.close(); t.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** 相手の PC の束を、この PC の inbox まで届ける。 */
async function peerSends(): Promise<void> {
  await peer.service.send();
  for (const row of peer.db.prepare('select * from config_snapshots').all() as Record<string, unknown>[]) {
    const c: ChangeOut = { tableName: 'config_snapshots', rowId: String(row.device_id), op: 'upsert', payload: row, updatedAt: Number(row.updated_at), seq: 1, deviceId: 'peer' };
    applyRemoteChange(t.db, c, { ownDeviceId: 'd', skipOwn: true });
  }
  await service.receive();
}

const PATHS = ['/api/config-sync', '/api/config-sync/outgoing', '/api/config-sync/inbox', '/api/config-sync/conflicts', '/api/config-sync/unsent', '/api/config-sync/backups', '/api/config-sync/apply-order'];

describe('設定の同期の経路（作り直した実装）', () => {
  it('どれも認証の下にある', async () => {
    for (const p of PATHS) {
      expect([p, (await get(p, {})).status]).toEqual([p, 401]);
      expect([p, (await get(p, { ...H, origin: 'https://evil.example' })).status]).toEqual([p, 403]);
    }
    for (const [m, p] of [['POST', '/api/config-sync/unsent/x/send'], ['PUT', '/api/config-sync/apply-order'], ['DELETE', '/api/config-sync/apply-order']] as const) {
      expect([p, (await app.request(p, { method: m })).status]).toEqual([p, 401]);
    }
  });

  it('作っていない端末（クラウドに参加していない）では 404 で、旧実装の経路は別である', async () => {
    const bare = createApp({ ...t.deps, configBundle: null });
    for (const p of PATHS) expect([p, (await bare.request(p, { headers: H })).status]).toEqual([p, 404]);
    expect((await bare.request('/api/config-sync/apply-order', { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: '{"items":[]}' })).status).toBe(404);
    expect(((await (await bare.request('/api/config-sync/inbox', { headers: H })).json()) as { error: string }).error).toBe('クラウド同期が設定されていません');
    // 旧実装の経路は、この依存に関わらず今までの形のまま（testDeps の configSync）。
    expect((await bare.request('/api/sync/config/preview', { headers: H })).status).toBe(200);
  });

  it('状態と、送る一覧と、送らなかった項目', async () => {
    write(myClaude, 'CLAUDE.md', '# hi');
    write(myClaude, 'settings.json', JSON.stringify({ model: 'opus', hooks: { x: 1 }, permissions: { allow: ['Read(//Users/x/**)'] } }));
    write(myClaude, 'commands/leak.md', SECRET);
    const out = (await json(await get('/api/config-sync/outgoing'))).body;
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(['file:CLAUDE.md', 'settings:model']);
    expect(out.droppedKeys).toEqual([{ key: 'hooks', reason: 'execution' }]);
    expect(out.unsentCount).toBe(2);
    const un = (await json(await get('/api/config-sync/unsent'))).body;
    expect(un.items.map((i: { kind: string }) => i.kind)).toEqual(['permission-rule', 'secret']);
    expect((await json(await get('/api/config-sync'))).body).toMatchObject({ enabled: true, approval: 'each', unsent: 2, incoming: 0, conflicts: 0, applyOrder: null });
  });

  it('「それでも送る」は、送って項目を許した一覧を返す。知らない id は 404', async () => {
    write(myClaude, 'commands/leak.md', SECRET);
    write(myClaude, 'CLAUDE.md', 'x');
    await get('/api/config-sync/outgoing');
    const id = ((await json(await get('/api/config-sync/unsent'))).body.items[0] as { id: string }).id;
    const r = await json(await send('POST', `/api/config-sync/unsent/${encodeURIComponent(id)}/send`));
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ id, allowed: true });
    expect(cloud.files.size).toBe(1);
    const missing = await json(await send('POST', '/api/config-sync/unsent/nope/send'));
    expect(missing).toEqual({ status: 404, body: { error: '送らなかった項目「nope」が見つかりません' } });
  });

  it('届いた変更の一覧と、競合の差分と、バックアップの世代', async () => {
    write(peer.claudeDir, 'CLAUDE.md', 'a\nfrom peer\n');
    write(peer.claudeDir, 'skills/s/SKILL.md', 'skill');
    write(myClaude, 'CLAUDE.md', 'a\nfrom me\n');
    // 競合にするには、共通の祖先が要る。基準に入れておく。
    t.db.prepare('insert into config_base (item_id, sha256, synced_at) values (?,?,?)').run('file:CLAUDE.md', 'f'.repeat(64), 1);
    await peerSends();
    const inbox = (await json(await get('/api/config-sync/inbox'))).body;
    expect(inbox.approval).toBe('each');
    expect(inbox.items.map((i: { op: string; id: string; needsApproval: boolean }) => [i.op, i.id, i.needsApproval])).toEqual([['conflict', 'file:CLAUDE.md', false], ['create', 'file:skills/s/SKILL.md', true]]);
    const conflicts = (await json(await get('/api/config-sync/conflicts'))).body;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].diff).toEqual([{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'from me' }, { kind: 'add', text: 'from peer' }]);
    expect((await json(await get('/api/config-sync/backups'))).body).toEqual({ generations: [] });
    expect((await json(await get('/api/config-sync'))).body).toMatchObject({ incoming: 1, conflicts: 1 });
  });

  it('適用の指示書は、書いて、読んで、取り消せる。~/.claude には何も書かない', async () => {
    write(peer.claudeDir, 'commands/c.md', 'cmd');
    write(peer.claudeDir, 'CLAUDE.md', 'rules');
    await peerSends();
    expect((await json(await get('/api/config-sync/apply-order'))).body).toBeNull();
    const put = await json(await send('PUT', '/api/config-sync/apply-order', { items: [{ id: 'file:commands/c.md' }] }));
    expect(put.status).toBe(200);
    expect(put.body.items).toMatchObject([{ id: 'file:commands/c.md', op: 'create', take: 'remote', fromDeviceId: 'peer', target: 'commands/c.md' }]);
    expect((await json(await get('/api/config-sync/apply-order'))).body).toEqual(put.body);
    expect(fs.existsSync(path.join(myHome, 'claude-config', 'apply-order.json'))).toBe(true);
    expect((await json(await get('/api/config-sync'))).body.applyOrder).toMatchObject({ count: 1 });
    expect(fs.readdirSync(myClaude)).toEqual([]);
    const del = await send('DELETE', '/api/config-sync/apply-order');
    expect(del.status).toBe(204);
    expect(fs.existsSync(path.join(myHome, 'claude-config', 'apply-order.json'))).toBe(false);
    expect((await json(await get('/api/config-sync/apply-order'))).body).toBeNull();
    // 無いものを取り消しても 204。
    expect((await send('DELETE', '/api/config-sync/apply-order')).status).toBe(204);
  });

  it('指示書の入力を検査する', async () => {
    write(peer.claudeDir, 'CLAUDE.md', 'rules');
    await peerSends();
    const put = async (body: unknown) => json(await send('PUT', '/api/config-sync/apply-order', body));
    expect(await put({ items: [{ id: 'file:nothing.md' }] })).toEqual({ status: 404, body: { error: '「file:nothing.md」は、届いている変更にありません' } });
    expect((await put({ items: [] })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ items: 'x' })).status).toBe(400);
    expect((await put({ items: [{ id: 1 }] })).status).toBe(400);
    expect((await put({ items: [{ id: 'file:CLAUDE.md', take: 'mine' }] })).status).toBe(400);
    expect((await put({ items: [{ id: 'file:CLAUDE.md' }, { id: 'file:CLAUDE.md' }] })).status).toBe(400);
    expect((await send('PUT', '/api/config-sync/apply-order', undefined)).status).toBe(400);
    // 大きすぎる本文は読む前に断る。
    const big = await app.request('/api/config-sync/apply-order', { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: 'x'.repeat(600 * 1024) }] }) });
    expect(big.status).toBe(413);
    expect(fs.existsSync(path.join(myHome, 'claude-config', 'apply-order.json'))).toBe(false);
  });

  it('断りの文は、いまの言語で返る', async () => {
    await t.deps.updateSettings({ language: 'en' });
    expect(await json(await send('POST', '/api/config-sync/unsent/nope/send'))).toEqual({ status: 404, body: { error: 'The unsent item "nope" was not found' } });
    expect((await send('PUT', '/api/config-sync/apply-order', { items: [] })).status).toBe(400);
    expect(((await (await send('PUT', '/api/config-sync/apply-order', { items: [] })).json()) as { error: string }).error).toBe('No items were selected to apply');
  });

  it('bootstrap に、同期の状態が乗る。作っていない端末では乗らない', async () => {
    expect((await json(await get('/api/bootstrap'))).body.configSync).toMatchObject({ enabled: true, approval: 'each' });
    const bare = createApp({ ...t.deps, configBundle: null });
    expect('configSync' in (await (await bare.request('/api/bootstrap', { headers: H })).json())).toBe(false);
  });
});
