import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../../db/open.ts';
import { allTargets, collectAll, enabledTargetNames, targetNameOfId, type TargetContext } from './index.ts';
import { defaultTargetPaths } from './paths.ts';

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
  it('v0.12.0 の統合のあとは、枠だけの対象は無い（全部本物）。settings:hooks の持ち主は claude のまま（hooks は claude-hooks:hooks）', () => {
    expect(allTargets().filter((t) => t.placeholder).map((t) => t.name)).toEqual([]);
    expect(targetNameOfId('settings:hooks')).toBe('claude');
  });
  it('項目を集めると、束の targets は有効な対象だけになる', () => {
    fs.writeFileSync(path.join(tmp, 'claude', 'CLAUDE.md'), 'x');
    expect(collectAll(ctx()).items.map((i) => i.id)).toContain('file:CLAUDE.md');
    expect(enabledTargetNames(ctx())).toContain('claude');
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
