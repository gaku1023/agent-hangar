import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_BUNDLE_MIN_WORKER_COMPAT, type ChangeOut, type ConfigKindKey, type ConfigKindMode } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { openDb, type Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { applyRemoteChange } from '../apply.ts';
import { slugOfPath } from './ids.ts';
import { restoreItem } from './restoreItem.ts';
import { ConfigSyncService } from './service.ts';

/**
 * メモリの索引（MEMORY.md）の競合を、2 台が行の和で自動に解く。
 * 両方の PC が同じ規則で合わせ、送り合った後に MEMORY.md のバイト列が一致し、競合が残らないこと。
 */

const NOW = 1_700_000_000_000;
const ID = 'memory:proj1/MEMORY.md';

type Pc = {
  id: string; db: Db; claudeDir: string; home: string; service: ConfigSyncService; kinds: { v: Partial<Record<ConfigKindKey, ConfigKindMode>> | undefined };
  write(rel: string, text: string): void; read(rel: string): string | null; remove(rel: string): void;
};
let tmp: string;
let pcs: Pc[];
let clock: number;
let shared: FakeCloudClient;

function pc(id: string, root: string): Pc {
  const dir = path.join(tmp, id);
  const claudeDir = path.join(dir, 'claude');
  const home = path.join(dir, 'home');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const db = openDb(':memory:');
  const cloud = shared.asDevice(id);
  void cloud.health();
  const kinds: Pc['kinds'] = { v: undefined };
  const service = new ConfigSyncService({
    db, deviceId: id, deviceName: id, claudeDir, home, cloud, keyring: cloud.keyring,
    enabled: () => true, switchedOn: () => true, configKinds: () => kinds.v, now: () => clock, userHome: tmp,
    targetPaths: { codexHome: path.join(dir, 'codex'), opencodeDir: path.join(dir, 'opencode'), agentsSkillsDir: path.join(dir, 'agents-skills'), claudeJsonPath: path.join(dir, 'claude.json') },
  });
  upsertShared(db, 'projects', { id: 'proj1', name: 'app', status: 'active', is_scratch: 0 }, id);
  upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: 'proj1', device_id: id, path: root, resolved: 1 }, id);
  const mem = (rel: string): string => path.join(claudeDir, 'projects', slugOfPath(root), 'memory', ...rel.split('/'));
  const p: Pc = {
    id, db, claudeDir, home, service, kinds,
    write(rel, text) { fs.mkdirSync(path.dirname(mem(rel)), { recursive: true }); fs.writeFileSync(mem(rel), text); },
    read(rel) { try { return fs.readFileSync(mem(rel), 'utf8'); } catch { return null; } },
    remove(rel) { fs.rmSync(mem(rel), { force: true }); },
  };
  pcs.push(p);
  return p;
}

function deliver(from: Pc, to: Pc): void {
  for (const row of from.db.prepare('select * from config_snapshots').all() as Record<string, unknown>[]) {
    const c: ChangeOut = { tableName: 'config_snapshots', rowId: String(row.device_id), op: 'upsert', payload: row, updatedAt: Number(row.updated_at), seq: 1, deviceId: from.id };
    applyRemoteChange(to.db, c, { ownDeviceId: to.id, skipOwn: true });
  }
}
const advance = (ms: number): void => { clock += ms; vi.setSystemTime(clock); };
const sync = async (from: Pc, to: Pc): Promise<void> => { advance(1000); await from.service.send(); deliver(from, to); await to.service.receive(); };
/** 2 台が同時に送り、互いの束を受け取る 1 周。 */
const round = async (a: Pc, b: Pc): Promise<void> => {
  advance(1000);
  await a.service.send(); await b.service.send();
  deliver(a, b); deliver(b, a);
  await a.service.receive(); await b.service.receive();
};
const addDevices = (): void => { for (const p of pcs) for (const q of pcs) upsertShared(p.db, 'devices', { id: q.id, name: `${q.id}-name`, platform: 'darwin' }, q.id); };
const historyItems = (p: Pc) => (p.db.prepare('select items from config_history order by id').all() as { items: string }[]).flatMap((r) => JSON.parse(r.items) as { id: string; op: string }[]);
const line = (file: string, note = file): string => `- [${file}](${file}.md) — ${note}`;
const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;

/** 2 台が x.md と y.md と、それを指す索引を共有した状態から始める。 */
async function start(): Promise<[Pc, Pc]> {
  const a = pc('dev-a', '/Users/a/work/app'); const b = pc('dev-b', '/Users/b/code/app');
  addDevices();
  a.write('x.md', 'x body'); a.write('y.md', 'y body');
  a.write('MEMORY.md', doc('# Memory', line('x'), line('y')));
  await sync(a, b);
  await sync(b, a);
  expect(b.read('MEMORY.md')).toBe(a.read('MEMORY.md'));
  return [a, b];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-memmerge-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = NOW;
  vi.setSystemTime(clock);
  pcs = [];
  shared = new FakeCloudClient({ deviceId: 'shared', now: () => clock, minWorkerCompat: 1 });
  shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT;
});
afterEach(() => { vi.useRealTimers(); for (const p of pcs) p.db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('メモリの索引の統合', () => {
  it('2 台が同時に行を足すと、両方の行を残した同じバイト列になり、競合が残らない', async () => {
    const [a, b] = await start();
    a.write('a1.md', 'a1'); a.write('MEMORY.md', doc('# Memory', line('x'), line('y'), line('a1')));
    b.write('b1.md', 'b1'); b.write('MEMORY.md', doc('# Memory', line('x'), line('y'), line('b1')));
    await round(a, b);
    await round(a, b);
    const ma = a.read('MEMORY.md');
    expect(ma).toBe(b.read('MEMORY.md'));
    for (const f of ['x', 'y', 'a1', 'b1']) expect(ma).toContain(line(f));
    expect(a.read('b1.md')).toBe('b1');
    expect(b.read('a1.md')).toBe('a1');
    for (const p of [a, b]) {
      expect(p.service.dto()).toMatchObject({ conflicts: 0, incoming: 0 });
      expect(historyItems(p).filter((i) => i.id === ID).map((i) => i.op)).toContain('merge');
    }
    // 落ち着いた後は、何周回しても書き直さない。
    const before = [historyItems(a).length, historyItems(b).length];
    await round(a, b);
    await round(a, b);
    expect([historyItems(a).length, historyItems(b).length]).toEqual(before);
  });

  it('同じファイルの一言が違えば本文が新しい側を採り、消したメモリの行は蘇らない', async () => {
    const [a, b] = await start();
    // a は x の本文と一言を直し、y を消す。b は行を 1 つ足しただけ。
    a.write('x.md', 'x body v2'); a.remove('y.md');
    a.write('MEMORY.md', doc('# Memory', line('x', '直した'), line('a1')));
    a.write('a1.md', 'a1');
    b.write('b1.md', 'b1'); b.write('MEMORY.md', doc('# Memory', line('x'), line('y'), line('b1')));
    await round(a, b);
    await round(a, b);
    const ma = a.read('MEMORY.md');
    expect(ma).toBe(b.read('MEMORY.md'));
    expect(ma).toBe(doc('# Memory', line('x', '直した'), line('a1'), line('b1')));
    expect(b.read('y.md')).toBeNull();
    expect(b.read('x.md')).toBe('x body v2');
    for (const p of [a, b]) expect(p.service.dto().conflicts).toBe(0);
  });

  it('戻すと、合わせる前の手元の索引に戻る', async () => {
    const [a, b] = await start();
    const mine = doc('# Memory', line('x'), line('y'), line('a1'));
    a.write('a1.md', 'a1'); a.write('MEMORY.md', mine);
    b.write('b1.md', 'b1'); b.write('MEMORY.md', doc('# Memory', line('x'), line('y'), line('b1')));
    await sync(b, a);
    expect(a.read('MEMORY.md')).not.toBe(mine);
    const row = a.db.prepare("select id from config_history where items like '%MEMORY.md%' order by id desc").get() as { id: number };
    const h = a.service.dto().history!.find((x) => x.id === row.id)!;
    expect(h.items.find((i) => i.id === ID)).toMatchObject({ op: 'merge', restorable: true });
    restoreItem({ home: a.home, claudeDir: a.claudeDir, db: a.db, now: () => clock, historyId: row.id, itemId: ID });
    expect(a.read('MEMORY.md')).toBe(mine);
  });

  it('種類が確認なら自動では合わせず、競合のまま残す。切なら何もしない', async () => {
    const [a, b] = await start();
    a.kinds.v = { memory: 'confirm' };
    const mine = doc('# Memory', line('x'), line('y'), line('a1'));
    a.write('a1.md', 'a1'); a.write('MEMORY.md', mine);
    b.write('b1.md', 'b1'); b.write('MEMORY.md', doc('# Memory', line('x'), line('y'), line('b1')));
    await sync(b, a);
    expect(a.read('MEMORY.md')).toBe(mine);
    expect(a.service.dto().conflicts).toBe(1);
    a.kinds.v = { memory: 'off' };
    await a.service.receive();
    expect(a.read('MEMORY.md')).toBe(mine);
    expect(a.service.dto().conflicts).toBe(0);
  });

  it('MEMORY.md 以外のメモリのファイルの競合は、合わせない', async () => {
    const [a, b] = await start();
    a.write('x.md', 'x from a');
    b.write('x.md', 'x from b');
    await sync(b, a);
    expect(a.read('x.md')).toBe('x from a');
    expect(a.service.conflicts().map((c) => c.id)).toEqual(['memory:proj1/x.md']);
  });
});
