import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { CONFIG_BUNDLE_MIN_WORKER_COMPAT, type ChangeOut } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { onRowChange } from '../../db/notify.ts';
import { openDb, type Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { applyRemoteChange } from '../apply.ts';
import { ClaudeConfigSync } from '../claudeConfig.ts';
import { decryptBuffer, deriveFileKey, encryptBuffer, sha256Hex } from '../crypto.ts';
import { SyncStateStore } from '../state.ts';
import { unpackBundle } from './bundle.ts';
import { slugOfPath } from './ids.ts';
import { writeApplyOrder } from './applyOrder.ts';
import { applyOrderPath, BUNDLE_PATH, configBackupsDir } from './paths.ts';
import { ConfigBase } from './base.ts';
import { ConfigSyncError, ConfigSyncService } from './service.ts';

const key = deriveFileKey('join-secret');
const NOW = 1_700_000_000_000;
const SECRET = 'key = sk-ant-api03-AbCdEfGhIjKlMnOpQrSt0123456789';

/** 1 台ぶんの手元。DB、~/.claude、hangar の置き場を一時のディレクトリに持つ。 */
type Pc = { id: string; name: string; db: Db; claudeDir: string; home: string; cloud: FakeCloudClient; service: ConfigSyncService; on: { enabled: boolean; approval: 'each' | 'auto' }; write(rel: string, text: string | Buffer): void; read(rel: string): string | null };
let tmp: string;
let pcs: Pc[];
let clock: number;
let shared: FakeCloudClient;

function pc(id: string, name: string): Pc {
  const dir = path.join(tmp, id);
  const claudeDir = path.join(dir, 'claude');
  const home = path.join(dir, 'home');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const db = openDb(':memory:');
  const cloud = shared.asDevice(id);
  // 本物の同期は、起動のときに Worker と話して版を知る。偽のクラウドにも 1 度話しかけたことにする（呼び出しの記録は空に戻す）。
  void cloud.health();
  cloud.calls.length = 0;
  const on = { enabled: true, approval: 'each' as 'each' | 'auto' };
  const service = new ConfigSyncService({
    db, deviceId: id, deviceName: name, claudeDir, home, cloud, key,
    enabled: () => on.enabled, switchedOn: () => on.enabled, approval: () => on.approval, now: () => clock,
  });
  const p: Pc = {
    id, name, db, claudeDir, home, cloud, service, on,
    write(rel, text) { const abs = path.join(claudeDir, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); },
    read(rel) { try { return fs.readFileSync(path.join(claudeDir, ...rel.split('/')), 'utf8'); } catch { return null; } },
  };
  pcs.push(p);
  return p;
}

/** from の束の行を to の DB へ届ける。本物は changes の push と pull が運ぶ。 */
function deliver(from: Pc, to: Pc): void {
  for (const row of from.db.prepare('select * from config_snapshots').all() as Record<string, unknown>[]) {
    const c: ChangeOut = { tableName: 'config_snapshots', rowId: String(row.device_id), op: 'upsert', payload: row, updatedAt: Number(row.updated_at), seq: 1, deviceId: from.id };
    applyRemoteChange(to.db, c, { ownDeviceId: to.id, skipOwn: true });
  }
}
const addDevices = (): void => { for (const p of pcs) for (const q of pcs) upsertShared(p.db, 'devices', { id: q.id, name: q.name, platform: 'darwin' }, q.id); };
const sync = async (from: Pc, to: Pc): Promise<void> => { await from.service.send(); deliver(from, to); await to.service.receive(); };
const ids = (p: Pc) => p.service.inbox().items.map((i) => `${i.op}:${i.id}`);

/** 時計を進める。共有の表の updated_at は Date.now() で付くので、Date も合わせて進める（同じ時刻の行は、適用で飛ばされる）。 */
const advance = (ms: number): void => { clock += ms; vi.setSystemTime(clock); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-service-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = NOW;
  vi.setSystemTime(clock);
  pcs = [];
  shared = new FakeCloudClient({ deviceId: 'shared', now: () => clock });
  // 束の行を知る Worker。古い Worker の試験だけが、これを下げる。
  shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT;
});
afterEach(() => { vi.useRealTimers(); for (const p of pcs) p.db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('送る一覧', () => {
  it('切のままでも読め、種類ごとの項目と運ばない鍵と送らなかった数を返す', () => {
    const a = pc('dev-a', 'mac');
    a.on.enabled = false;
    a.write('CLAUDE.md', '# rules');
    a.write('settings.json', JSON.stringify({ model: 'opus', env: { X: '1' }, permissions: { allow: ['Bash(ls)', 'Read(//Users/x/**)'] } }));
    a.write('skills/demo/SKILL.md', 'skill');
    a.write('commands/note.md', SECRET);
    const o = a.service.outgoing();
    expect(o.enabled).toBe(false);
    expect(o.items.map((i) => [i.kind, i.id])).toEqual([
      ['claude-md', 'file:CLAUDE.md'], ['skills', 'file:skills/demo/SKILL.md'], ['settings', 'settings:model'], ['settings', 'settings:permissions.allow'],
    ]);
    expect(o.items.find((i) => i.id === 'settings:model')!.value).toBe('"opus"');
    expect(o.items.find((i) => i.id === 'file:CLAUDE.md')!.value).toBeNull();
    expect(o.droppedKeys).toEqual([{ key: 'env', reason: 'execution' }]);
    // 絶対パスの規則 1 件と、秘密らしい文字列の項目 1 件。
    expect(o.unsentCount).toBe(2);
    expect(o.lastSentAt).toBeNull();
    // 読むだけである。
    expect(a.cloud.calls).toEqual([]);
  });
});

describe('束を送る', () => {
  it('切のときは何も送らず、行も作らない', async () => {
    const a = pc('dev-a', 'mac');
    a.on.enabled = false;
    a.write('CLAUDE.md', 'x');
    expect(await a.service.send()).toEqual({ sent: false, items: 0 });
    expect(a.cloud.calls).toEqual([]);
    expect(a.db.prepare('select count(*) n from config_snapshots').get()).toEqual({ n: 0 });
  });

  it('入ったら束を 1 つ上げ、PC ごとの 1 行を共有の表に書く。旧実装の鍵と台帳には触らない', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', '# rules');
    a.write('settings.json', JSON.stringify({ model: 'opus', hooks: { evil: 1 } }));
    a.write('skills/demo/SKILL.md', 'skill');
    a.write('commands/secret.md', SECRET);
    expect(await a.service.send()).toEqual({ sent: true, items: 3 });
    // クラウドには束の 1 オブジェクトだけがある。旧実装の config/<端末>/<相対パス> は作らない。
    expect([...shared.files.keys()]).toEqual([`config/dev-a/${BUNDLE_PATH}`]);
    const stored = shared.files.get(`config/dev-a/${BUNDLE_PATH}`)!;
    expect(stored.entry).toMatchObject({ kind: 'config', path: BUNDLE_PATH, encrypted: true, deviceId: 'dev-a' });
    const tar = gunzipSync(await decryptBuffer(key, stored.body));
    const opened = unpackBundle(tar);
    expect(opened.manifest.deviceId).toBe('dev-a');
    expect(opened.manifest.items.map((i) => i.id)).toEqual(['file:CLAUDE.md', 'file:skills/demo/SKILL.md', 'settings:model']);
    // 運ばない鍵と、秘密らしい文字列の項目は、束のどこにも無い。
    expect(tar.toString('latin1')).not.toContain('evil');
    expect(tar.toString('latin1')).not.toContain('sk-ant-');
    const row = a.db.prepare('select * from config_snapshots').get() as Record<string, unknown>;
    expect(row).toMatchObject({ device_id: 'dev-a', bundle_sha256: sha256Hex(tar), bundle_size: tar.length, item_count: 3, origin_device: 'dev-a' });
    expect(JSON.parse(row.manifest as string)).toHaveLength(3);
    expect(a.db.prepare("select count(*) n from changes where table_name = 'config_snapshots' and pushed_at is null").get()).toEqual({ n: 1 });
    expect(a.db.prepare('select count(*) n from file_sync').get()).toEqual({ n: 0 });
  });

  it('変わっていなければ、2 回目は上げない。変わったら上げ直す', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'one');
    await a.service.send();
    const puts = (): number => a.cloud.calls.filter((c) => c.method === 'putFile').length;
    expect(puts()).toBe(1);
    expect(await a.service.send()).toEqual({ sent: false, items: 1 });
    expect(puts()).toBe(1);
    a.write('CLAUDE.md', 'two');
    advance(1000);
    expect(await a.service.send()).toEqual({ sent: true, items: 1 });
    expect(puts()).toBe(2);
    expect(a.db.prepare('select count(*) n from config_snapshots').get()).toEqual({ n: 1 });
  });

  it('何も運ぶものが無い PC は、束を上げない', async () => {
    const a = pc('dev-a', 'mac');
    expect(await a.service.send()).toEqual({ sent: false, items: 0 });
    expect(a.cloud.calls).toEqual([]);
  });

  it('上げるのに失敗したら行を書かず、投げる', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    a.cloud.offline = true;
    await expect(a.service.send()).rejects.toThrow();
    expect(a.db.prepare('select count(*) n from config_snapshots').get()).toEqual({ n: 0 });
    a.cloud.offline = false;
    expect(await a.service.send()).toEqual({ sent: true, items: 1 });
  });
});

describe('束を受け取る', () => {
  it('他の PC の束を hangar の置き場に開く。~/.claude には書かない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    addDevices();
    a.write('CLAUDE.md', '# from a');
    a.write('skills/demo/SKILL.md', 'skill body');
    b.write('keep.txt', 'unrelated');
    await sync(a, b);
    expect(fs.existsSync(path.join(b.home, 'claude-config', 'inbox', 'dev-a', 'meta.json'))).toBe(true);
    expect(fs.readdirSync(b.claudeDir)).toEqual(['keep.txt']);
    expect(b.service.inbox().items.map((i) => [i.op, i.id, i.fromDevice, i.fromDeviceId])).toEqual([
      ['create', 'file:CLAUDE.md', 'mac', 'dev-a'], ['create', 'file:skills/demo/SKILL.md', 'mac', 'dev-a'],
    ]);
  });

  it('自分の行は受け取らない', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    await a.service.send();
    await a.service.receive();
    expect(a.cloud.calls.filter((c) => c.method === 'getFile')).toEqual([]);
    expect(a.service.inbox().items).toEqual([]);
  });

  it('同じ束は 2 回取りに行かない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'x');
    await sync(a, b);
    await b.service.receive();
    expect(b.cloud.calls.filter((c) => c.method === 'getFile')).toHaveLength(1);
  });

  it('切のときは取りに行かない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'x');
    await a.service.send();
    deliver(a, b);
    b.on.enabled = false;
    expect(await b.service.receive()).toEqual({ fetched: 0, failed: 0 });
    expect(b.cloud.calls).toEqual([]);
  });

  it('壊れた束と、他人の名前の束は開かず、inbox を変えない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'x');
    await sync(a, b);
    const before = ids(b);
    // 束を壊し、行の指紋も合わせて「新しい版」に見せる。
    const garbage = await encryptBuffer(key, Buffer.from('not a gzip'));
    const k = `config/dev-a/${BUNDLE_PATH}`;
    shared.files.get(k)!.body = garbage;
    b.db.prepare("update config_snapshots set bundle_sha256 = 'f' || bundle_sha256, updated_at = updated_at + 1 where device_id = 'dev-a'").run();
    const r = await b.service.receive();
    expect(r).toEqual({ fetched: 0, failed: 1 });
    expect(ids(b)).toEqual(before);
  });

  it('開けなかった束は、同じ指紋のまま毎回は取りに行かず、しばらくたつか行が新しくなれば取り直す', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'x');
    await a.service.send();
    deliver(a, b);
    const k = `config/dev-a/${BUNDLE_PATH}`;
    const good = shared.files.get(k)!.body;
    shared.files.get(k)!.body = await encryptBuffer(key, Buffer.from('not a gzip'));
    const gets = (): number => b.cloud.calls.filter((c) => c.method === 'getFile').length;
    expect(await b.service.receive()).toEqual({ fetched: 0, failed: 1 });
    expect(await b.service.receive()).toEqual({ fetched: 0, failed: 0 });
    expect(gets()).toBe(1);
    // 直した束は、待ち時間のあとに取り直す。
    shared.files.get(k)!.body = good;
    advance(11 * 60 * 1000);
    expect(await b.service.receive()).toEqual({ fetched: 1, failed: 0 });
    expect(gets()).toBe(2);
  });

  it('束の中の端末 ID が行の端末と違えば受け取らない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'x');
    await a.service.send();
    // dev-a の束を dev-c の行として見せる。
    const row = a.db.prepare('select * from config_snapshots').get() as Record<string, unknown>;
    applyRemoteChange(b.db, { tableName: 'config_snapshots', rowId: 'dev-c', op: 'upsert', payload: { ...row, device_id: 'dev-c' }, updatedAt: Number(row.updated_at), seq: 1, deviceId: 'dev-c' }, { ownDeviceId: 'dev-b', skipOwn: true });
    await shared.asDevice('dev-c').putFile({ key: `config/dev-c/${BUNDLE_PATH}`, path: BUNDLE_PATH, kind: 'config', sha256: String(row.bundle_sha256), size: Number(row.bundle_size), mtime: 1, encrypted: true }, Readable.from([shared.files.get(`config/dev-a/${BUNDLE_PATH}`)!.body]));
    expect(await b.service.receive()).toEqual({ fetched: 0, failed: 1 });
    expect(b.service.inbox().items).toEqual([]);
  });

  it('消えた行の写しは片付ける', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'x');
    await sync(a, b);
    b.db.prepare("update config_snapshots set deleted_at = 1 where device_id = 'dev-a'").run();
    await b.service.receive();
    expect(fs.existsSync(path.join(b.home, 'claude-config', 'inbox', 'dev-a'))).toBe(false);
    expect(b.service.inbox().items).toEqual([]);
  });

  it('行が changes に積まれ、偽のクラウドの push と pull で他の PC の DB に降りる', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'x');
    await a.service.send();
    const rows = a.db.prepare("select table_name, row_id, op, payload, updated_at from changes where table_name = 'config_snapshots'").all() as { table_name: string; row_id: string; op: 'upsert'; payload: string; updated_at: number }[];
    await a.cloud.pushChanges(rows.map((r) => ({ tableName: 'config_snapshots' as const, rowId: r.row_id, op: r.op, payload: JSON.parse(r.payload) as Record<string, unknown>, updatedAt: r.updated_at })));
    const pulled = await b.cloud.pullChanges(0, 100);
    for (const c of pulled.changes) applyRemoteChange(b.db, c, { ownDeviceId: 'dev-b', skipOwn: true });
    expect(await b.service.receive()).toEqual({ fetched: 1, failed: 0 });
    expect(ids(b)).toEqual(['create:file:CLAUDE.md']);
  });
});

describe('3 方向の判定と受け取りの一覧', () => {
  it('手元と同じ中身は一覧に出ず、共通の中身として覚える。その後に相手が変えれば overwrite', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    addDevices();
    a.write('commands/x.md', 'v1'); b.write('commands/x.md', 'v1');
    await sync(a, b);
    expect(ids(b)).toEqual([]);
    expect(new ConfigBase(b.db).all().get('file:commands/x.md')).toBe(sha256Hex('v1'));
    advance(1000);
    a.write('commands/x.md', 'v2');
    await sync(a, b);
    expect(ids(b)).toEqual(['overwrite:file:commands/x.md']);
  });

  it('手元だけが変えたら、一覧には出さない（送るだけ）', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('commands/x.md', 'v1'); b.write('commands/x.md', 'v1');
    await sync(a, b);
    await sync(b, a);
    advance(1000);
    b.write('commands/x.md', 'v1-mine');
    expect(ids(b)).toEqual([]);
    // 手元を送れば、相手の側には overwrite が出る。
    await sync(b, a);
    expect(ids(a)).toEqual(['overwrite:file:commands/x.md']);
  });

  it('両方が別々に変えたら conflict。差分を最初から出し、両側の PC と時刻を添える', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    addDevices();
    a.write('CLAUDE.md', 'line1\nline2\n'); b.write('CLAUDE.md', 'line1\nline2\n');
    await sync(a, b);
    advance(1000);
    a.write('CLAUDE.md', 'line1\nfrom a\n');
    b.write('CLAUDE.md', 'line1\nfrom b\n');
    await sync(a, b);
    expect(ids(b)).toEqual(['conflict:file:CLAUDE.md']);
    const [c] = b.service.conflicts();
    expect(c).toMatchObject({ id: 'file:CLAUDE.md', kind: 'claude-md', local: { deviceName: 'mini', size: 13 }, remote: { deviceName: 'mac', at: clock } });
    expect(c!.diff).toEqual([{ kind: 'ctx', text: 'line1' }, { kind: 'del', text: 'from b' }, { kind: 'add', text: 'from a' }]);
  });

  it('相手が消した項目は、手元が前回のままなら delete', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('commands/x.md', 'v1'); a.write('CLAUDE.md', 'keep');
    b.write('commands/x.md', 'v1'); b.write('CLAUDE.md', 'keep');
    await sync(a, b);
    advance(1000);
    fs.rmSync(path.join(a.claudeDir, 'commands', 'x.md'));
    await sync(a, b);
    expect(b.service.inbox().items.map((i) => [i.op, i.id, i.size])).toEqual([['delete', 'file:commands/x.md', 2]]);
  });

  it('受け取る側の書き込み先は、手元の ~/.claude を変えない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'a'); a.write('commands/x.md', 'x'); a.write('settings.json', JSON.stringify({ model: 'opus' }));
    b.write('settings.json', JSON.stringify({ model: 'sonnet', hooks: { keep: 1 } }));
    const beforeSettings = b.read('settings.json');
    await sync(a, b);
    expect(b.read('CLAUDE.md')).toBeNull();
    expect(b.read('commands/x.md')).toBeNull();
    expect(b.read('settings.json')).toBe(beforeSettings);
    expect(ids(b)).toContain('conflict:settings:model');
  });

  it('届いた項目に実行の印と中身の先頭が付く。skills、commands、agents は承諾の仕方で毎回の承諾を求める', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', '# hello');
    a.write('skills/s/SKILL.md', '---\nname: s\nhooks:\n  a: 1\n---\nbody');
    a.write('commands/c.md', 'plain');
    await sync(a, b);
    const by = Object.fromEntries(b.service.inbox().items.map((i) => [i.id, i]));
    expect(by['file:CLAUDE.md']).toMatchObject({ needsApproval: false, marks: [], head: '# hello' });
    expect(by['file:skills/s/SKILL.md']).toMatchObject({ needsApproval: true, marks: ['hooks'] });
    expect(by['file:commands/c.md']).toMatchObject({ needsApproval: true, marks: [] });
    expect(b.service.inbox().approval).toBe('each');
    b.on.approval = 'auto';
    const auto = Object.fromEntries(b.service.inbox().items.map((i) => [i.id, i]));
    expect(auto['file:skills/s/SKILL.md']!.needsApproval).toBe(false);
    expect(b.service.inbox().approval).toBe('auto');
  });

  it('他の PC から届いた settings は、運ぶ鍵だけを受ける（運ばない鍵の項目が束に混ざっても飛ばす）', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('settings.json', JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }));
    await sync(a, b);
    expect(ids(b)).toEqual(['create:settings:model', 'create:settings:permissions.allow']);
    expect(b.service.inbox().items[1]!.head).toBe('["Bash(ls)"]');
  });

  describe('プロジェクトのメモリ', () => {
    it('プロジェクトの id で運び、受け手のパスの slug に当てる。プロジェクトが無い PC では保留にする', async () => {
      const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini'); const c = pc('dev-c', 'air');
      addDevices();
      for (const [p, root] of [[a, '/Users/a/work/app'], [b, '/Users/b/code/app']] as const) {
        upsertShared(p.db, 'projects', { id: 'proj1', name: 'app', status: 'active', is_scratch: 0 }, p.id);
        upsertShared(p.db, 'project_roots', { id: `r-${p.id}`, project_id: 'proj1', device_id: p.id, path: root, resolved: 1 }, p.id);
      }
      a.write(`projects/${slugOfPath('/Users/a/work/app')}/memory/MEMORY.md`, '# memory');
      await sync(a, b);
      const [item] = b.service.inbox().items;
      expect(item).toMatchObject({ id: 'memory:proj1/MEMORY.md', op: 'create', held: null, label: 'app/MEMORY.md' });
      await sync(a, c);
      expect(c.service.inbox().items[0]).toMatchObject({ id: 'memory:proj1/MEMORY.md', held: 'no-project' });
      expect(c.service.dto()).toMatchObject({ incoming: 0, held: 1 });
      expect(b.service.dto()).toMatchObject({ incoming: 1, held: 0 });
    });
  });
});

describe('送らなかった項目', () => {
  it('絶対パスの規則と秘密らしい項目を記録し、送らず、本文は載せない', () => {
    const a = pc('dev-a', 'mac');
    a.write('settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Read(//Users/x/**)'] } }));
    a.write('CLAUDE.md', SECRET);
    a.service.outgoing();
    const u = a.service.unsent();
    expect(u.items.map((i) => [i.kind, i.itemId, i.label, i.reason, i.allowed])).toEqual([
      ['permission-rule', 'settings:permissions.allow', 'Read(//Users/x/**)', 'absolute-path', false],
      ['secret', 'file:CLAUDE.md', 'CLAUDE.md', 'secret:sk-ant-', false],
    ]);
    expect(JSON.stringify(u)).not.toContain('AbCdEf');
    expect(a.service.dto().unsent).toBe(2);
  });

  it('「それでも送る」を押すと、その項目を送る。中身が変われば、また止まる', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', SECRET);
    a.write('commands/x.md', 'ok');
    await a.service.send();
    const unsent = a.service.unsent().items[0]!;
    expect(unsent.id).toBe('secret:file:CLAUDE.md');
    const after = await a.service.sendUnsent(unsent.id);
    expect(after.items[0]).toMatchObject({ id: unsent.id, allowed: true });
    deliver(a, b);
    await b.service.receive();
    expect(ids(b)).toEqual(['create:file:CLAUDE.md', 'create:file:commands/x.md']);
    // 中身を変えると、許しは効かない。
    advance(1000);
    a.write('CLAUDE.md', `${SECRET} changed`);
    await a.service.send();
    expect(a.service.unsent().items[0]).toMatchObject({ id: unsent.id, allowed: false });
    deliver(a, b);
    await b.service.receive();
    expect(ids(b)).toEqual(['create:file:commands/x.md']);
  });

  it('絶対パスの規則も「それでも送る」で送れる', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('settings.json', JSON.stringify({ permissions: { allow: ['Read(//Users/x/**)'] } }));
    await a.service.send();
    expect(shared.files.size).toBe(0); // 運ぶものが無い（全部が絶対パスの鍵は運ばない）
    const id = a.service.unsent().items[0]!.id;
    await a.service.sendUnsent(id);
    deliver(a, b);
    await b.service.receive();
    expect(b.service.inbox().items[0]).toMatchObject({ id: 'settings:permissions.allow', head: '["Read(//Users/x/**)"]' });
  });

  it('知らない id は断る', async () => {
    const a = pc('dev-a', 'mac');
    await expect(a.service.sendUnsent('secret:file:nothing')).rejects.toBeInstanceOf(ConfigSyncError);
    await expect(a.service.sendUnsent('secret:file:nothing')).rejects.toMatchObject({ status: 404 });
  });

  it('見つからなくなった項目の記録は消える', () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', SECRET);
    a.service.outgoing();
    expect(a.service.unsent().items).toHaveLength(1);
    a.write('CLAUDE.md', 'clean');
    a.service.outgoing();
    expect(a.service.unsent().items).toEqual([]);
  });
});

describe('適用の指示書', () => {
  async function inboxed(): Promise<{ a: Pc; b: Pc }> {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    addDevices();
    a.write('CLAUDE.md', 'rules'); a.write('commands/x.md', 'cmd'); a.write('settings.json', JSON.stringify({ model: 'opus' }));
    b.write('settings.json', JSON.stringify({ model: 'sonnet' }));
    await sync(a, b);
    return { a, b };
  }
  const file = (p: Pc): string => path.join(p.home, 'claude-config', 'apply-order.json');

  it('選んだ項目を hangar の置き場の指示書に書く。~/.claude には書かない', async () => {
    const { b } = await inboxed();
    const claudeBefore = fs.readdirSync(b.claudeDir).sort();
    const order = b.service.putApplyOrder([{ id: 'file:commands/x.md' }, { id: 'file:CLAUDE.md' }]);
    expect(order.createdAt).toBe(clock);
    expect(order.items).toEqual([
      { id: 'file:commands/x.md', kind: 'commands', op: 'create', take: 'remote', fromDeviceId: 'dev-a', sha256: sha256Hex('cmd'), target: 'commands/x.md' },
      { id: 'file:CLAUDE.md', kind: 'claude-md', op: 'create', take: 'remote', fromDeviceId: 'dev-a', sha256: sha256Hex('rules'), target: 'CLAUDE.md' },
    ]);
    expect(JSON.parse(fs.readFileSync(file(b), 'utf8'))).toMatchObject({ version: 1, deviceId: 'dev-b', items: expect.any(Array) });
    // Windows のファイルには POSIX の権限が無い（読み書きできるものは 0o666 と出る）。
    if (process.platform !== 'win32') expect(fs.statSync(file(b)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(b.claudeDir).sort()).toEqual(claudeBefore);
    expect(b.service.applyOrder()).toEqual(order);
    expect(b.service.dto().applyOrder).toEqual({ count: 2, createdAt: clock });
  });

  it('競合は、相手を採るか手元を採るかを選べる。settings の書き込み先は鍵である', async () => {
    const { b } = await inboxed();
    const order = b.service.putApplyOrder([{ id: 'settings:model', take: 'mine' }]);
    expect(order.items[0]).toMatchObject({ id: 'settings:model', op: 'conflict', take: 'mine', target: 'settings.json#model' });
    const remote = b.service.putApplyOrder([{ id: 'settings:model', take: 'remote' }]);
    expect(remote.items[0]!.take).toBe('remote');
  });

  it('新しい指示書は前の指示書を置き換える。取り消すと消える', async () => {
    const { b } = await inboxed();
    b.service.putApplyOrder([{ id: 'file:CLAUDE.md' }]);
    b.service.putApplyOrder([{ id: 'file:commands/x.md' }]);
    expect(b.service.applyOrder()!.items.map((i) => i.id)).toEqual(['file:commands/x.md']);
    b.service.deleteApplyOrder();
    expect(fs.existsSync(file(b))).toBe(false);
    expect(b.service.applyOrder()).toBeNull();
    expect(b.service.dto().applyOrder).toBeNull();
    // 無いものを消しても失敗しない。
    expect(() => b.service.deleteApplyOrder()).not.toThrow();
  });

  it('届いていない項目、重なり、空、競合でないものを手元で採る指定は断り、指示書を書かない', async () => {
    const { b } = await inboxed();
    const bad = (entries: Parameters<ConfigSyncService['putApplyOrder']>[0], status: number) => {
      let err: unknown;
      try { b.service.putApplyOrder(entries); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ConfigSyncError);
      expect((err as ConfigSyncError).status).toBe(status);
    };
    bad([{ id: 'file:commands/none.md' }], 404);
    bad([{ id: 'file:CLAUDE.md' }, { id: 'file:CLAUDE.md' }], 400);
    bad([], 400);
    bad([{ id: 'file:CLAUDE.md', take: 'mine' }], 400);
    expect(fs.existsSync(file(b))).toBe(false);
  });

  it('保留の項目は指示書に入れられない', async () => {
    const a = pc('dev-a', 'mac'); const c = pc('dev-c', 'air');
    upsertShared(a.db, 'projects', { id: 'proj1', name: 'app', status: 'active', is_scratch: 0 }, 'dev-a');
    upsertShared(a.db, 'project_roots', { id: 'r1', project_id: 'proj1', device_id: 'dev-a', path: '/Users/a/app', resolved: 1 }, 'dev-a');
    a.write(`projects/${slugOfPath('/Users/a/app')}/memory/MEMORY.md`, 'm');
    await sync(a, c);
    expect(() => c.service.putApplyOrder([{ id: 'memory:proj1/MEMORY.md' }])).toThrow(ConfigSyncError);
  });

  it('メモリの書き込み先は、受け手のパスの slug である', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    for (const [p, root] of [[a, '/Users/a/app'], [b, '/Users/b/app2']] as const) {
      upsertShared(p.db, 'projects', { id: 'proj1', name: 'app', status: 'active', is_scratch: 0 }, p.id);
      upsertShared(p.db, 'project_roots', { id: `r-${p.id}`, project_id: 'proj1', device_id: p.id, path: root, resolved: 1 }, p.id);
    }
    a.write(`projects/${slugOfPath('/Users/a/app')}/memory/sub/n.md`, 'm');
    await sync(a, b);
    const order = b.service.putApplyOrder([{ id: 'memory:proj1/sub/n.md' }]);
    expect(order.items[0]!.target).toBe(`projects/${slugOfPath('/Users/b/app2')}/memory/sub/n.md`);
  });

  it('手で書き換えられた指示書は読まない', async () => {
    const { b } = await inboxed();
    b.service.putApplyOrder([{ id: 'file:CLAUDE.md' }]);
    const body = JSON.parse(fs.readFileSync(file(b), 'utf8')) as { items: { id: string }[] };
    body.items[0]!.id = 'file:../../etc/passwd';
    fs.writeFileSync(file(b), JSON.stringify(body));
    expect(b.service.applyOrder()).toBeNull();
  });
});

describe('控えの世代と状態', () => {
  it('控えの世代を新しい順に数える。時刻の名前でないものは世代ではない', () => {
    const a = pc('dev-a', 'mac');
    const root = path.join(a.home, 'backups', 'claude-config');
    for (const [stamp, files] of [['20261001-101500', ['CLAUDE.md']], ['20261003-090000', ['a.md', 'skills/s/SKILL.md']]] as const) {
      for (const f of files) { const p = path.join(root, stamp, ...f.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
    }
    fs.mkdirSync(path.join(root, 'removed'), { recursive: true });
    const { generations } = a.service.backups();
    expect(generations.map((g) => [g.name, g.files])).toEqual([['20261003-090000', 2], ['20261001-101500', 1]]);
    expect(generations[0]!.at).toBe(new Date(2026, 9, 3, 9, 0, 0).getTime());
    expect(a.service.dto().backups).toBe(2);
  });

  it('状態は、切入り、承諾の仕方、届いた数、競合、保留、送らなかった数、最後に送った時刻を持つ', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    expect(a.service.dto()).toEqual({ enabled: true, approval: 'each', workerPending: false, incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null });
    a.write('CLAUDE.md', 'a'); a.write('commands/x.md', 'a');
    b.write('commands/x.md', 'b');
    await sync(a, b);
    advance(5);
    await b.service.send();
    expect(b.service.dto()).toMatchObject({ enabled: true, incoming: 1, conflicts: 1, lastSentAt: clock });
  });
});

describe('旧実装と並んで動く', () => {
  it('新しい束は旧実装が受け取る形ではなく、旧実装の台帳と一覧に何も足さない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('CLAUDE.md', 'from new');
    await a.service.send();
    const entry = shared.files.get(`config/dev-a/${BUNDLE_PATH}`)!.entry;
    const old = new ClaudeConfigSync({
      db: b.db, deviceId: 'dev-b', deviceName: 'mini', claudeDir: b.claudeDir, home: b.home, client: b.cloud, key, state: new SyncStateStore(b.db),
      enabled: () => true, onToast: () => {}, now: () => clock,
    });
    // 旧実装は束を設定ファイルとして数えない。
    expect(old.preview([entry]).entries).toEqual([]);
    expect(await old.applyPull([entry])).toMatchObject({ applied: 0, conflicts: 0 });
    expect(b.read(BUNDLE_PATH)).toBeNull();
    expect(b.db.prepare('select count(*) n from file_sync').get()).toEqual({ n: 0 });
  });

  it('旧実装が上げたファイルの鍵は、新しい束の鍵と重ならない', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    const old = new ClaudeConfigSync({
      db: a.db, deviceId: 'dev-a', deviceName: 'mac', claudeDir: a.claudeDir, home: a.home, client: a.cloud, key, state: new SyncStateStore(a.db),
      enabled: () => true, onToast: () => {}, now: () => clock,
    });
    await old.pushChanged();
    await a.service.send();
    expect([...shared.files.keys()].sort()).toEqual([`config/dev-a/${BUNDLE_PATH}`, 'config/dev-a/CLAUDE.md']);
    // 新しい実装は旧実装の台帳 file_sync に触らない（旧実装の 1 行だけが残る）。
    expect(a.db.prepare('select count(*) n from file_sync').get()).toEqual({ n: 1 });
  });
});

describe('定期の呼び出しと止め方', () => {
  it('tick は受けてから送り、失敗は握って onError に渡す', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    const errors: string[] = [];
    const flaky = new ConfigSyncService({
      db: b.db, deviceId: 'dev-b', deviceName: 'mini', claudeDir: b.claudeDir, home: b.home, cloud: b.cloud, key,
      enabled: () => true, switchedOn: () => true, approval: () => 'each', now: () => clock, onError: (m) => errors.push(m),
    });
    a.write('CLAUDE.md', 'x'); b.write('commands/c.md', 'y');
    await a.service.send();
    deliver(a, b);
    await flaky.tick();
    expect(flaky.inbox().items.map((i) => i.id)).toEqual(['file:CLAUDE.md']);
    expect(shared.files.has('config/dev-b/.hangar/config-bundle.hgr')).toBe(true);
    // 繋がらなければ握る。
    b.cloud.offline = true;
    advance(1000);
    b.write('commands/d.md', 'z');
    await expect(flaky.tick()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).not.toContain('commands');
  });

  it('切のときの tick は何もしない', async () => {
    const a = pc('dev-a', 'mac');
    a.on.enabled = false;
    a.write('CLAUDE.md', 'x');
    await a.service.tick();
    expect(a.cloud.calls).toEqual([]);
  });

  it('止めた後は送受信しない', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    a.service.stop();
    expect(await a.service.send()).toEqual({ sent: false, items: 0 });
    expect(await a.service.receive()).toEqual({ fetched: 0, failed: 0 });
    expect(a.cloud.calls).toEqual([]);
  });

  it('送受信は 1 本に並ぶ。同時に send を呼んでも、同じ束は 1 回しか上げない', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    await Promise.all([a.service.send(), a.service.send(), a.service.send()]);
    expect(a.cloud.calls.filter((c) => c.method === 'putFile')).toHaveLength(1);
  });
});

describe('古い Worker のあいだは束の行を書かない', () => {
  it('Worker の版が、束の行を知る版に届くまでは、スイッチが入っていても送らず、行も作らず、状態に更新待ちを出す', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT - 1;
    // Worker の版は、同期の最初の応答で分かる。ここでは偽のクラウドに 1 度話しかけたことにする。
    await a.cloud.health();
    a.cloud.calls.length = 0;
    expect(a.service.dto()).toMatchObject({ enabled: true, workerPending: true });
    expect(await a.service.send()).toEqual({ sent: false, items: 0 });
    await a.service.tick();
    expect(a.cloud.calls).toEqual([]);
    expect(a.db.prepare('select count(*) n from config_snapshots').get()).toEqual({ n: 0 });
    expect(a.db.prepare("select count(*) n from changes where table_name = 'config_snapshots'").get()).toEqual({ n: 0 });
    // 一覧は読める。
    expect(a.service.outgoing().items).toHaveLength(1);
    // Worker が上がれば、次の送信から行を書く。
    shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT;
    await a.cloud.health();
    expect(a.service.dto().workerPending).toBe(false);
    expect(await a.service.send()).toEqual({ sent: true, items: 1 });
  });

  it('スイッチが切のときは、更新待ちと言わない', async () => {
    const a = pc('dev-a', 'mac');
    a.on.enabled = false;
    shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT - 1;
    await a.cloud.health();
    expect(a.service.dto().workerPending).toBe(false);
  });

  it('Worker の版がまだ分からないあいだは、送らないが、更新待ちとも言わない', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    const blind = new ConfigSyncService({
      db: a.db, deviceId: 'dev-a', deviceName: 'mac', claudeDir: a.claudeDir, home: a.home, key, now: () => clock,
      cloud: { putFile: (...args) => a.cloud.putFile(...args), getFile: (k) => a.cloud.getFile(k), lastWorkerCompat: () => null },
      enabled: () => true, switchedOn: () => true, approval: () => 'each',
    });
    expect(await blind.send()).toEqual({ sent: false, items: 0 });
    expect(blind.dto().workerPending).toBe(false);
    expect(a.cloud.calls.filter((c) => c.method === 'putFile')).toEqual([]);
  });

  it('更新待ちが変わったら、画面へ配り直す（config_state の名指し）', async () => {
    const a = pc('dev-a', 'mac');
    a.write('CLAUDE.md', 'x');
    const touched: string[] = [];
    const off = onRowChange((c) => { if (c.db === a.db && c.table === 'config_state') touched.push('t'); });
    try {
      shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT - 1;
      await a.cloud.health();
      await a.service.tick();
      const afterOld = touched.length;
      expect(afterOld).toBeGreaterThan(0);
      await a.service.tick();
      expect(touched.length).toBe(afterOld);
      shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT;
      await a.cloud.health();
      await a.service.tick();
      expect(touched.length).toBeGreaterThan(afterOld);
    } finally { off(); }
  });

  it('殻の命令や hangar config apply が指示書を消し、世代を足したら、画面へ配り直す（サーバの外で起きる変化）', async () => {
    const a = pc('dev-a', 'mac');
    const touched: string[] = [];
    const off = onRowChange((c) => { if (c.db === a.db && c.table === 'config_state') touched.push('t'); });
    try {
      writeApplyOrder(a.home, 'dev-a', [], clock);
      await a.service.tick();
      const first = touched.length;
      await a.service.tick();
      expect(touched.length).toBe(first);
      // 外の処理が、指示書を消して世代を足す。
      fs.rmSync(applyOrderPath(a.home));
      fs.mkdirSync(path.join(configBackupsDir(a.home), '20261010-120000'), { recursive: true });
      await a.service.tick();
      expect(touched.length).toBeGreaterThan(first);
      expect(a.service.dto()).toMatchObject({ applyOrder: null, backups: 1 });
    } finally { off(); }
  });
});

describe('手元にあるが運ばない同名の項目を、相手の項目で上書きさせない', () => {
  const outsideFile = (name: string, text: string): string => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };

  it('手元がリンクのファイル：相手から同名が届いても create にせず、保留にして、指示書に入れられない', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('commands/x.md', 'from a');
    a.write('commands/ok.md', 'ok');
    fs.mkdirSync(path.join(b.claudeDir, 'commands'), { recursive: true });
    const target = outsideFile('b-secret.md', 'b private');
    fs.symlinkSync(target, path.join(b.claudeDir, 'commands', 'x.md'));
    await sync(a, b);
    const by = Object.fromEntries(b.service.inbox().items.map((i) => [i.id, i]));
    expect(by['file:commands/x.md']).toMatchObject({ op: 'create', held: 'local-blocked' });
    expect(by['file:commands/ok.md']).toMatchObject({ op: 'create', held: null });
    expect(b.service.dto()).toMatchObject({ incoming: 1, held: 1, conflicts: 0 });
    expect(() => b.service.putApplyOrder([{ id: 'file:commands/x.md' }])).toThrow(ConfigSyncError);
    expect(() => b.service.putApplyOrder([{ id: 'file:commands/ok.md' }])).not.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('b private');
  });

  it('手元が大きすぎるファイル：保留にする', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('skills/s/SKILL.md', 'small');
    b.write('skills/s/SKILL.md', Buffer.alloc((1 << 20) + 1, 97));
    await sync(a, b);
    expect(b.service.inbox().items).toMatchObject([{ id: 'file:skills/s/SKILL.md', held: 'local-blocked' }]);
  });

  it('手元のディレクトリ全体がリンク：その下の相手の項目は全部保留', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('agents/one.md', '1'); a.write('agents/sub/two.md', '2');
    fs.mkdirSync(path.join(tmp, 'agents-elsewhere'));
    fs.symlinkSync(path.join(tmp, 'agents-elsewhere'), path.join(b.claudeDir, 'agents'));
    await sync(a, b);
    expect(b.service.inbox().items.map((i) => [i.id, i.held])).toEqual([['file:agents/one.md', 'local-blocked'], ['file:agents/sub/two.md', 'local-blocked']]);
  });

  it('手元の settings.json が壊れている：相手の settings の項目は保留', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('settings.json', JSON.stringify({ model: 'opus' }));
    b.write('settings.json', '{ broken');
    await sync(a, b);
    expect(b.service.inbox().items).toMatchObject([{ id: 'settings:model', held: 'local-blocked' }]);
  });

  it('保留は競合の数にも届いた数にも入らず、塞ぎが解ければ通常の判定に戻る', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    a.write('commands/x.md', 'from a');
    fs.mkdirSync(path.join(b.claudeDir, 'commands'), { recursive: true });
    fs.symlinkSync(outsideFile('o.md', 'o'), path.join(b.claudeDir, 'commands', 'x.md'));
    await sync(a, b);
    expect(b.service.dto()).toMatchObject({ incoming: 0, conflicts: 0, held: 1 });
    fs.rmSync(path.join(b.claudeDir, 'commands', 'x.md'));
    expect(b.service.dto()).toMatchObject({ incoming: 1, conflicts: 0, held: 0 });
  });
});
