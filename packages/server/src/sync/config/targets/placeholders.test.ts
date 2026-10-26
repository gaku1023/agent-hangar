import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../../db/open.ts';
import { allTargets, collectAll, enabledTargetNames, targetNameOfId, type TargetContext } from './index.ts';
import { defaultTargetPaths } from './paths.ts';

const PLACEHOLDERS = ['claude-hooks', 'claude-plugins', 'codex', 'opencode', 'agents-skills', 'hangar'];
let tmp: string;
let db: Db;
const ctx = (o: Partial<TargetContext> = {}): TargetContext => ({
  db, deviceId: 'd', home: tmp, claudeDir: path.join(tmp, 'claude'), allowedUnsent: new Map(),
  codexHome: path.join(tmp, 'codex'), codexEnabled: true, opencodeDir: path.join(tmp, 'opencode'), opencodeEnabled: true,
  agentsSkillsDir: path.join(tmp, 'agents'), claudeJsonPath: path.join(tmp, 'claude.json'), hangarSettingsPath: path.join(tmp, 'settings.json'), ...o,
});

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-')); fs.mkdirSync(path.join(tmp, 'claude')); db = openDb(':memory:'); });
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('枠だけの対象', () => {
  it('登録されていて、claude-hooks と claude-plugins は claude より前', () => {
    const names = allTargets().map((t) => t.name);
    for (const n of PLACEHOLDERS) expect(names).toContain(n);
    expect(names.indexOf('claude-hooks')).toBeLessThan(names.indexOf('claude'));
    expect(names.indexOf('claude-plugins')).toBeLessThan(names.indexOf('claude'));
  });
  it('どの id も持たず、集めるものも無い。settings: の鍵の持ち主は変わらない', () => {
    for (const t of allTargets().filter((x) => PLACEHOLDERS.includes(x.name))) {
      expect(t.owns('settings:hooks')).toBe(false);
      expect(t.owns('codex:file:AGENTS.md')).toBe(false);
      expect(t.collect(ctx()).items).toEqual([]);
    }
    expect(targetNameOfId('settings:hooks')).toBe('claude');
    expect(targetNameOfId('settings:enabledPlugins')).toBe('claude');
  });
  it('全部入にしても、集める項目は変わらず、束の targets にも載らない', () => {
    const all = Object.fromEntries(PLACEHOLDERS.map((n) => [n, true]));
    fs.writeFileSync(path.join(tmp, 'claude', 'CLAUDE.md'), 'x');
    const off = collectAll(ctx());
    const on = collectAll(ctx({ switches: all }));
    expect(on.items.map((i) => i.id)).toEqual(off.items.map((i) => i.id));
    expect(enabledTargetNames(ctx({ switches: all }))).toEqual(enabledTargetNames(ctx()));
    expect(enabledTargetNames(ctx({ switches: all }))).not.toEqual(expect.arrayContaining(PLACEHOLDERS));
  });
  it('codex と opencode は、その PC で有効でなければ入にしても切', () => {
    const find = (n: string) => allTargets().find((t) => t.name === n)!;
    const sw = { codex: true, opencode: true };
    expect(find('codex').enabled(ctx({ switches: sw }))).toBe(true);
    expect(find('codex').enabled(ctx({ switches: sw, codexEnabled: false }))).toBe(false);
    expect(find('codex').enabled(ctx({ codexEnabled: true }))).toBe(false);
    expect(find('opencode').enabled(ctx({ switches: sw }))).toBe(true);
    expect(find('opencode').enabled(ctx({ switches: sw, opencodeEnabled: false }))).toBe(false);
  });
});

describe('defaultTargetPaths', () => {
  it('CODEX_HOME と XDG_CONFIG_HOME を見る。無ければ利用者のホームの下', () => {
    expect(defaultTargetPaths({ CODEX_HOME: '/c', XDG_CONFIG_HOME: '/x' }, '/u')).toEqual({ codexHome: '/c', opencodeDir: path.join('/x', 'opencode'), agentsSkillsDir: path.join('/u', '.agents', 'skills'), claudeJsonPath: path.join('/u', '.claude.json') });
    const d = defaultTargetPaths({}, '/u');
    expect(d.codexHome).toBe(path.join(os.homedir(), '.codex'));
    expect(d.opencodeDir).toBe(path.join('/u', '.config', 'opencode'));
  });
});
