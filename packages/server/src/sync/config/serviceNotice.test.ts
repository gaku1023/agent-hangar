import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_BUNDLE_MIN_WORKER_COMPAT, type ChangeOut, type ConfigKindKey, type ConfigKindMode } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { openDb, type Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { applyRemoteChange } from '../apply.ts';
import { ConfigSyncService } from './service.ts';

/**
 * 設定の同期は、人の目が要るものが新しく出たときだけ onAttention を呼ぶ（計画の受け入れの試験 11 の同期側）。
 * 数えるのは新しく出た分で、前に知らせた集合に入っているものは数えない。
 */

type Attention = { asks: number; conflicts: number; autoFailed: boolean };
const NOW = 1_700_000_000_000;

type Pc = { id: string; db: Db; claudeDir: string; home: string; service: ConfigSyncService; attention: Attention[]; kinds: { v: Partial<Record<ConfigKindKey, ConfigKindMode>> | undefined }; write(rel: string, text: string): void; read(rel: string): string | null };
let tmp: string;
let pcs: Pc[];
let clock: number;
let shared: FakeCloudClient;

function pc(id: string): Pc {
  const dir = path.join(tmp, id);
  const claudeDir = path.join(dir, 'claude');
  const home = path.join(dir, 'home');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const db = openDb(':memory:');
  const cloud = shared.asDevice(id);
  void cloud.health();
  const kinds: Pc['kinds'] = { v: undefined };
  const attention: Attention[] = [];
  const service = new ConfigSyncService({
    db, deviceId: id, deviceName: id, claudeDir, home, cloud, keyring: cloud.keyring,
    enabled: () => true, switchedOn: () => true, configKinds: () => kinds.v, now: () => clock, userHome: tmp, onAttention: (e) => attention.push(e),
    targetPaths: { codexHome: path.join(dir, 'codex'), opencodeDir: path.join(dir, 'opencode'), agentsSkillsDir: path.join(dir, 'agents-skills'), claudeJsonPath: path.join(dir, 'claude.json') },
  });
  const p: Pc = {
    id, db, claudeDir, home, service, attention, kinds,
    write(rel, text) { const abs = path.join(claudeDir, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); },
    read(rel) { try { return fs.readFileSync(path.join(claudeDir, ...rel.split('/')), 'utf8'); } catch { return null; } },
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
const addDevices = (): void => { for (const p of pcs) for (const q of pcs) upsertShared(p.db, 'devices', { id: q.id, name: `${q.id}-name`, platform: 'darwin' }, q.id); };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-notice-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = NOW;
  vi.setSystemTime(clock);
  pcs = [];
  shared = new FakeCloudClient({ deviceId: 'shared', now: () => clock, minWorkerCompat: 1 });
  shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT;
});
afterEach(() => { vi.useRealTimers(); for (const p of pcs) p.db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const hooks = (command: string): string => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });

describe('設定の同期の知らせ', () => {
  it('confirm の項目が新しく届くと、その件数で 1 回呼ぶ', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('settings.json', hooks('echo hi'));
    await sync(a, b);
    expect(b.service.dto().askCount).toBe(1);
    expect(b.attention).toEqual([{ asks: 1, conflicts: 0, autoFailed: false }]);
  });

  it('自動で入ったものだけなら呼ばない', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('skills/demo/SKILL.md', 'skill body');
    await sync(a, b);
    expect(b.read('skills/demo/SKILL.md')).toBe('skill body');
    expect(b.attention).toEqual([]);
  });

  it('同じものは 2 度呼ばない。増えたときは増えた分だけ', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('settings.json', hooks('echo hi'));
    await sync(a, b);
    await b.service.receive();
    await b.service.receive();
    expect(b.attention).toHaveLength(1);
    a.write('settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, permissions: { allow: ['Bash(ls)'] } }));
    await sync(a, b);
    expect(b.attention).toEqual([{ asks: 1, conflicts: 0, autoFailed: false }, { asks: 1, conflicts: 0, autoFailed: false }]);
  });

  it('競合が新しく出ると呼ぶ。自動で入る分は数えない', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('CLAUDE.md', 'base');
    await sync(a, b);
    await sync(b, a);
    expect(b.attention).toEqual([]);
    a.write('CLAUDE.md', 'from a');
    b.write('CLAUDE.md', 'from b');
    a.write('commands/c.md', 'cmd');
    await sync(a, b);
    expect(b.service.dto().conflicts).toBe(1);
    expect(b.attention).toEqual([{ asks: 0, conflicts: 1, autoFailed: false }]);
    await b.service.receive();
    expect(b.attention).toHaveLength(1);
  });

  it('自動の適用の失敗は、at が変わるたびに 1 回呼ぶ', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('skills/demo/SKILL.md', 'skill body');
    fs.writeFileSync(path.join(b.home, 'backups'), 'not a dir');
    await sync(a, b);
    expect(b.attention).toEqual([{ asks: 0, conflicts: 0, autoFailed: true }]);
    // 間を置く前の受け取りは試し直さず、at も変わらない。
    await b.service.receive();
    expect(b.attention).toHaveLength(1);
    // 間を置いて、また失敗すると at が変わる。
    advance(11 * 60 * 1000);
    await b.service.receive();
    expect(b.attention).toHaveLength(2);
    expect(b.attention[1]).toEqual({ asks: 0, conflicts: 0, autoFailed: true });
  });
});
