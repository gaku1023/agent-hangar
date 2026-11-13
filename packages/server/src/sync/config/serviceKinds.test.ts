import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigItemKind, ConfigKindMode, ConfigKindKey } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/open.ts';
import { loadSettings } from '../../config/paths.ts';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { writeInbox } from './inbox.ts';
import { unpackBundle } from './bundle.ts';
import { BUNDLE_PATH } from './paths.ts';
import { ConfigSyncService } from './service.ts';
import { HANGAR_PREF_KEYS, setHangarPrefsApplier } from './targets/hangar.ts';

/** 種類ごとの状態（configKinds）で、送る・受ける・承認が決まる（受け入れの試験 2、5、6）。 */

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const NOW = 1_000_000;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-kinds-')); });
afterEach(() => { setHangarPrefsApplier(null); fs.rmSync(tmp, { recursive: true, force: true }); });

function make(o: { kinds?: Partial<Record<ConfigKindKey, ConfigKindMode>> } = {}) {
  const claudeDir = path.join(tmp, 'claude'); const home = path.join(tmp, 'home');
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const shared = new FakeCloudClient({ deviceId: 'shared', now: () => NOW, minWorkerCompat: 1 });
  shared.workerCompat = 99;
  const cloud = shared.asDevice('d');
  void cloud.health();
  const targetPaths = { codexHome: path.join(tmp, 'codex'), opencodeDir: path.join(tmp, 'opencode'), agentsSkillsDir: path.join(tmp, 'agents-skills'), claudeJsonPath: path.join(tmp, 'claude.json') };
  const box = { kinds: o.kinds };
  const svc = new ConfigSyncService({
    db: openDb(':memory:'), deviceId: 'd', deviceName: 'n', claudeDir, home, cloud, keyring: cloud.keyring,
    enabled: () => true, switchedOn: () => true, now: () => NOW,
    configKinds: () => box.kinds, agentsEnabled: () => ({ codex: false, opencode: false }), targetPaths,
    userHome: tmp, hostOs: 'darwin',
  });
  const write = (rel: string, text: string): void => { const abs = path.join(claudeDir, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
  const bundle = async () => unpackBundle((await shared.openedFile(await cloud.configKey(BUNDLE_PATH)))!.body).manifest;
  return { svc, home, claudeDir, cloud, box, write, bundle };
}

type In = { id: string; kind: ConfigItemKind; content: string };
function arrive(home: string, items: In[], meta: { targets: string[]; offKinds?: ConfigItemKind[] }): void {
  const blobs = new Map(items.map((i) => [sha(i.content), Buffer.from(i.content)]));
  const extra = meta.offKinds ? { offKinds: meta.offKinds } : {};
  writeInbox(home, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: items.map((i) => ({ id: i.id, kind: i.kind, sha256: sha(i.content), size: Buffer.byteLength(i.content), marks: [] })), targets: meta.targets, os: 'darwin', ...extra }, blobs, skipped: 0 },
    { bundleSha256: 'b', forRowSha256: 'r', at: NOW, itemCount: items.length, skipped: 0, targets: meta.targets, os: 'darwin', ...extra });
}

const HOOK = JSON.stringify({ v: 1, value: { type: 'command', command: 'echo hi' }, files: [] });

describe('承認は種類の状態から決まる（試験 2）', () => {
  it('既定では claude-hooks と statusline は確認、skills は確認なし', () => {
    const { svc, home } = make();
    arrive(home, [
      { id: 'claude-hooks:statusline', kind: 'claude-statusline', content: HOOK },
      { id: 'file:skills/s/SKILL.md', kind: 'skills', content: 'S' },
    ], { targets: ['claude', 'claude-hooks'] });
    const need = Object.fromEntries(svc.inbox().items.map((i) => [i.id, i.needsApproval]));
    expect(need).toEqual({ 'claude-hooks:statusline': true, 'file:skills/s/SKILL.md': false });
  });

  it('確認にした種類は承認が要り、自動にした種類は要らない。消去も同じ', () => {
    const { svc, home, box, write } = make({ kinds: { skills: 'confirm', 'claude-statusline': 'auto' } });
    arrive(home, [
      { id: 'claude-hooks:statusline', kind: 'claude-statusline', content: HOOK },
      { id: 'file:skills/s/SKILL.md', kind: 'skills', content: 'S' },
    ], { targets: ['claude', 'claude-hooks'] });
    expect(Object.fromEntries(svc.inbox().items.map((i) => [i.id, i.needsApproval]))).toEqual({ 'claude-hooks:statusline': false, 'file:skills/s/SKILL.md': true });
    box.kinds = { skills: 'auto' };
    expect(svc.inbox().items.find((i) => i.id === 'file:skills/s/SKILL.md')!.needsApproval).toBe(false);
    void write;
  });

  it('settings は対象をまたぐので、状態は id の種類で引く（claude と claude-keys2 の両方）', () => {
    const { svc, home } = make({ kinds: { settings: 'confirm' } });
    arrive(home, [
      { id: 'settings:model', kind: 'settings', content: '"opus"' },
      { id: 'settings:voiceEnabled', kind: 'settings', content: 'true' },
    ], { targets: ['claude', 'claude-keys2'] });
    const items = svc.inbox().items;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.needsApproval).toBe(true);
  });
});

describe('切の種類は送らず、受けても判定に載せない（試験 5）', () => {
  it('skills を切にすると、送る一覧にも束にも skills が入らず、束に切の種類を書く', async () => {
    const { svc, bundle, write } = make({ kinds: { skills: 'off' } });
    write('skills/s/SKILL.md', 'S');
    write('CLAUDE.md', 'C');
    expect(svc.outgoing().items.map((i) => i.id)).toEqual(['file:CLAUDE.md']);
    await svc.send();
    const m = await bundle();
    expect(m.items.map((i) => i.id)).toEqual(['file:CLAUDE.md']);
    expect(m.offKinds).toEqual(['skills']);
  });

  it('手元で skills が切なら、届いた skills は判定に載らない', () => {
    const { svc, home } = make({ kinds: { skills: 'off' } });
    arrive(home, [
      { id: 'file:skills/s/SKILL.md', kind: 'skills', content: 'S' },
      { id: 'file:commands/c.md', kind: 'commands', content: 'C' },
    ], { targets: ['claude'] });
    expect(svc.inbox().items.map((i) => i.id)).toEqual(['file:commands/c.md']);
    expect(svc.dto().incoming).toBe(1);
  });

  it('相手で skills が切なら、相手の束に skills が無くても、手元の skills を消去と読まない', () => {
    const { svc, home, write } = make();
    write('skills/s/SKILL.md', 'S');
    // 前回の共通に載っている（以前は相手も持っていた）。
    arrive(home, [{ id: 'file:skills/s/SKILL.md', kind: 'skills', content: 'S' }], { targets: ['claude'] });
    expect(svc.inbox().items).toEqual([]);
    arrive(home, [], { targets: ['claude'], offKinds: ['skills'] });
    expect(svc.inbox().items).toEqual([]);
    // 切の印が無い束なら、消去になる（比べのため）。
    arrive(home, [], { targets: ['claude'] });
    expect(svc.inbox().items.map((i) => `${i.op}:${i.id}`)).toEqual(['delete:file:skills/s/SKILL.md']);
  });

  it('対象の種類が全部切なら、その対象は束の targets に載らない', async () => {
    const all = { 'claude-hooks': 'off', 'claude-statusline': 'off' } as const;
    const { svc, bundle } = make({ kinds: all });
    fs.writeFileSync(path.join(tmp, 'claude', 'CLAUDE.md'), 'C');
    await svc.send();
    const m = await bundle();
    expect(m.targets).not.toContain('claude-hooks');
    expect(m.targets).toContain('claude');
  });
});

describe('configKinds は hangar の好みで全部の PC に効く（試験 6）', () => {
  it('configKinds を運び、configApproval は運ばない', () => {
    const { svc, home } = make();
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ configKinds: { skills: 'off' }, configApproval: 'auto' }));
    const ids = svc.outgoing().items.map((i) => i.id);
    expect(ids).toContain('hangar:configKinds');
    expect(ids).not.toContain('hangar:configApproval');
    expect(HANGAR_PREF_KEYS).toContain('configKinds');
    expect(HANGAR_PREF_KEYS).not.toContain('configApproval');
  });

  it('届いた configKinds を適用すると、この PC の settings.json に書かれ、次の判定から効く', () => {
    const { svc, home, box } = make();
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    const value = { skills: 'off', 'claude-hooks': 'auto' };
    arrive(home, [{ id: 'hangar:configKinds', kind: 'hangar-pref', content: JSON.stringify(value) }], { targets: ['claude', 'hangar'] });
    expect(svc.inbox().items.map((i) => [i.id, i.needsApproval])).toEqual([['hangar:configKinds', false]]);
    svc.putApplyOrder([{ id: 'hangar:configKinds' }]);
    const s = loadSettings(home);
    expect(s.configKinds).toEqual(value);
    box.kinds = s.configKinds;
    fs.mkdirSync(path.join(tmp, 'claude', 'skills', 's'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'claude', 'skills', 's', 'SKILL.md'), 'S');
    expect(svc.outgoing().items.map((i) => i.id)).not.toContain('file:skills/s/SKILL.md');
  });

  it('形の合わない configKinds は運ばず、塞ぐ', () => {
    const { svc, home } = make();
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ configKinds: { transcript: 'confirm' } }));
    expect(svc.outgoing().items.map((i) => i.id)).not.toContain('hangar:configKinds');
  });
});
