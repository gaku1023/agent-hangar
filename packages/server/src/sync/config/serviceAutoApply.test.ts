import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_BUNDLE_MIN_WORKER_COMPAT, type ChangeOut, type ConfigKindKey, type ConfigKindMode } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { openDb, type Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { applyRemoteChange } from '../apply.ts';
import { listAllBackups, runApplyAll } from './applyAll.ts';
import { readApplyOrder, writeApplyOrder } from './applyOrder.ts';
import { ConfigSyncService } from './service.ts';

/**
 * 届いた束を、種類の状態が自動の項目だけ、サーバが自分で適用する（計画の受け入れの試験 1〜4）。
 * 適用は控えを取り、基準を進め、履歴（config_history）に 1 行を書く。
 */

const NOW = 1_700_000_000_000;

type Pc = { id: string; db: Db; claudeDir: string; home: string; service: ConfigSyncService; kinds: { v: Partial<Record<ConfigKindKey, ConfigKindMode>> | undefined }; write(rel: string, text: string): void; read(rel: string): string | null };
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
  const service = new ConfigSyncService({
    db, deviceId: id, deviceName: id, claudeDir, home, cloud, keyring: cloud.keyring,
    enabled: () => true, switchedOn: () => true, configKinds: () => kinds.v, now: () => clock, userHome: tmp,
    targetPaths: { codexHome: path.join(dir, 'codex'), opencodeDir: path.join(dir, 'opencode'), agentsSkillsDir: path.join(dir, 'agents-skills'), claudeJsonPath: path.join(dir, 'claude.json') },
  });
  const p: Pc = {
    id, db, claudeDir, home, service, kinds,
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
const historyRows = (p: Pc) => p.db.prepare('select * from config_history order by id').all() as { id: number; at: number; from_device: string | null; mode: string; items: string; generations: string; undone: string; seen: number }[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-config-auto-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = NOW;
  vi.setSystemTime(clock);
  pcs = [];
  shared = new FakeCloudClient({ deviceId: 'shared', now: () => clock, minWorkerCompat: 1 });
  shared.workerCompat = CONFIG_BUNDLE_MIN_WORKER_COMPAT;
});
afterEach(() => { vi.useRealTimers(); for (const p of pcs) p.db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('自動の適用（受け入れの試験 1）', () => {
  it('既定の設定で skills が届くと、画面を触らずに書かれ、控えの世代と履歴の 1 行ができる', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('skills/demo/SKILL.md', 'skill body');
    await sync(a, b);
    expect(b.read('skills/demo/SKILL.md')).toBe('skill body');
    expect(readApplyOrder(b.home)).toBeNull();
    expect(listAllBackups(b.home).length).toBe(1);
    const rows = historyRows(b);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'auto', from_device: 'dev-a', seen: 0, undone: '[]' });
    expect(JSON.parse(rows[0]!.items)).toEqual([{ id: 'file:skills/demo/SKILL.md', kind: 'skills', label: 'skills/demo/SKILL.md', op: 'create' }]);
    expect(JSON.parse(rows[0]!.generations)).toEqual([{ target: 'claude', name: listAllBackups(b.home)[0]!.name }]);
    // 適用したので、届いた変更としては残らない。
    const dto = b.service.dto();
    expect(dto.incoming).toBe(0);
    expect(dto.autoUnseen).toBe(1);
    expect(dto.askCount).toBe(0);
    expect(dto.history).toEqual([expect.objectContaining({ mode: 'auto', fromDeviceId: 'dev-a', fromDevice: 'dev-a-name', seen: false, undone: [], items: [{ id: 'file:skills/demo/SKILL.md', kind: 'skills', label: 'skills/demo/SKILL.md', op: 'create', restorable: true }] })]);
    // 既読にすると未読の数が消える。
    b.service.markHistorySeen();
    expect(b.service.dto().autoUnseen).toBe(0);
    expect(b.service.dto().history![0]!.seen).toBe(true);
  });

  it('同じ束を受け直しても、もう一度は書かない（履歴は 1 行のまま）', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('skills/demo/SKILL.md', 'skill body');
    await sync(a, b);
    await b.service.receive();
    expect(historyRows(b)).toHaveLength(1);
  });
});

describe('確認の種類と権限の鍵（受け入れの試験 2）', () => {
  it('claude-hooks は既定で書かれず、askCount に数えられる。権限の鍵は自動の settings でも書かれない', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('settings.json', JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    await sync(a, b);
    const settings = JSON.parse(b.read('settings.json') ?? '{}') as Record<string, unknown>;
    expect(settings.model).toBe('opus');
    expect(settings.permissions).toBeUndefined();
    expect(settings.hooks).toBeUndefined();
    const inbox = b.service.inbox().items;
    expect(inbox.map((i) => i.id).sort()).toEqual(['claude-hooks:hooks', 'settings:permissions.allow']);
    expect(inbox.every((i) => i.needsApproval)).toBe(true);
    expect(b.service.dto().askCount).toBe(2);
    expect(JSON.parse(historyRows(b)[0]!.items)).toEqual([{ id: 'settings:model', kind: 'settings', label: 'model', op: 'create' }]);
  });
});

describe('競合と削除（受け入れの試験 3、4）', () => {
  it('競合の項目は書かれず、ほかの項目だけ自動で入る', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('CLAUDE.md', 'base');
    await sync(a, b);
    expect(b.read('CLAUDE.md')).toBe('base');
    await sync(b, a);
    a.write('CLAUDE.md', 'from a');
    b.write('CLAUDE.md', 'from b');
    a.write('commands/c.md', 'cmd');
    await sync(a, b);
    expect(b.read('CLAUDE.md')).toBe('from b');
    expect(b.read('commands/c.md')).toBe('cmd');
    expect(b.service.dto().conflicts).toBe(1);
    expect(b.service.inbox().items.map((i) => `${i.op}:${i.id}`)).toEqual(['conflict:file:CLAUDE.md']);
  });

  it('削除の項目は、控えを取って消される', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('commands/c.md', 'cmd');
    await sync(a, b);
    await sync(b, a);
    expect(b.read('commands/c.md')).toBe('cmd');
    fs.rmSync(path.join(a.claudeDir, 'commands', 'c.md'));
    await sync(a, b);
    expect(b.read('commands/c.md')).toBeNull();
    const last = historyRows(b).at(-1)!;
    expect(JSON.parse(last.items)).toEqual([{ id: 'file:commands/c.md', kind: 'commands', label: 'commands/c.md', op: 'delete' }]);
    // 控えの世代に消す前の中身がある。
    const gen = JSON.parse(last.generations) as { name: string }[];
    expect(gen).toHaveLength(1);
    const files = fs.readdirSync(path.join(b.home, 'backups'), { recursive: true }).map(String);
    expect(files.some((f) => f.includes(gen[0]!.name) && f.endsWith('c.md'))).toBe(true);
  });
});

describe('飛ばすとき', () => {
  it('人の承認待ちの指示書があると、その回は飛ばし、指示書もそのまま残す。消えた次の受け取りで入る', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    writeApplyOrder(b.home, 'dev-b', [], clock);
    a.write('skills/demo/SKILL.md', 'skill body');
    await sync(a, b);
    expect(b.read('skills/demo/SKILL.md')).toBeNull();
    expect(readApplyOrder(b.home)).not.toBeNull();
    expect(historyRows(b)).toHaveLength(0);
    b.service.deleteApplyOrder();
    await b.service.receive();
    expect(b.read('skills/demo/SKILL.md')).toBe('skill body');
  });

  it('種類を確認にすると書かない', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    b.kinds.v = { skills: 'confirm' };
    a.write('skills/demo/SKILL.md', 'skill body');
    await sync(a, b);
    expect(b.read('skills/demo/SKILL.md')).toBeNull();
    expect(b.service.dto().askCount).toBe(1);
  });

  it('書けなければ元に戻し、指示書を消し、失敗を dto に出す。次の成功で消える', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    a.write('skills/demo/SKILL.md', 'skill body');
    // 控えの置き場をファイルで塞ぐ。
    fs.writeFileSync(path.join(b.home, 'backups'), 'not a dir');
    await sync(a, b);
    expect(readApplyOrder(b.home)).toBeNull();
    expect(historyRows(b)).toHaveLength(0);
    expect(b.service.dto().lastAutoError).toMatchObject({ at: clock });
    expect(b.read('skills/demo/SKILL.md')).toBeNull();
    // 同じ組は、間を置くまで試し直さない。
    fs.rmSync(path.join(b.home, 'backups'));
    await b.service.receive();
    expect(b.read('skills/demo/SKILL.md')).toBeNull();
    advance(11 * 60 * 1000);
    await b.service.receive();
    expect(b.read('skills/demo/SKILL.md')).toBe('skill body');
    expect(b.service.dto().lastAutoError).toBeNull();
  });
});

describe('手での適用も履歴に残る', () => {
  it('runApplyAll は source が無ければ manual として既読の 1 行を書く', async () => {
    const a = pc('dev-a'); const b = pc('dev-b'); addDevices();
    b.kinds.v = { skills: 'confirm' };
    a.write('skills/demo/SKILL.md', 'skill body');
    await sync(a, b);
    b.service.putApplyOrder([{ id: 'file:skills/demo/SKILL.md' }]);
    runApplyAll({ home: b.home, claudeDir: b.claudeDir, db: b.db, now: () => clock });
    expect(b.read('skills/demo/SKILL.md')).toBe('skill body');
    expect(historyRows(b)).toEqual([expect.objectContaining({ mode: 'manual', from_device: 'dev-a', seen: 1 })]);
    expect(b.service.dto().autoUnseen).toBe(0);
  });
});
