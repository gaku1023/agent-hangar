import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHome, loadSettings, saveSettings } from './paths.ts';
import { KIND_TARGETS, migrateConfigKinds } from '../sync/config/kindMigration.ts';
import { allTargets } from '../sync/config/targets/index.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-kinds-')); ensureHome(tmp); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const write = (o: Record<string, unknown>): void => fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', claudeDir: '/c', ...o }));

describe('configKinds への移行（決定 11、受け入れの試験 7）', () => {
  it('入れていた人は、Codex の対象が切なら Codex の種類が切、承認の要った種類が確認になる', () => {
    write({ configBundleSync: true, configApproval: 'each', configTargets: { codex: false, 'claude-hooks': true, 'claude-plugins': true, 'claude-keys2': true, hangar: true, 'claude-mcp': true } });
    const s = loadSettings(tmp);
    expect(s.configKinds?.['codex-file']).toBe('off');
    expect(s.configKinds?.['codex-config']).toBe('off');
    for (const k of ['skills', 'commands', 'agents', 'settings', 'claude-hooks', 'claude-statusline', 'plugins', 'claude-mcp'] as const) expect(s.configKinds?.[k]).toBe('confirm');
    expect(s.configKinds?.['claude-md']).toBe('auto');
    expect(s.configKinds?.memory).toBe('auto');
    expect(s.configKinds?.transcript).toBe('auto');
    expect(s.configKinds?.['hangar-pref']).toBe('auto');
    // 1 回だけ：書き戻したあとは、書かれた configKinds をそのまま読む（configTargets を変えても読み直さない）。
    saveSettings(tmp, s);
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect((raw.configKinds as Record<string, string>)['codex-file']).toBe('off');
    raw.configTargets = { codex: true };
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(raw));
    expect(loadSettings(tmp).configKinds?.['codex-file']).toBe('off');
  });

  it('configBundleSync が無いか切の設定は変えない', () => {
    write({ configApproval: 'each', configTargets: { codex: false } });
    expect(loadSettings(tmp).configKinds).toBeUndefined();
    expect(loadSettings(tmp).configBundleSync).toBeUndefined();
    write({ configBundleSync: false, configApproval: 'auto' });
    expect(loadSettings(tmp).configKinds).toBeUndefined();
    expect(loadSettings(tmp).configBundleSync).toBe(false);
  });

  it('書かれた configKinds は移行しない', () => {
    write({ configBundleSync: true, configApproval: 'each', configTargets: {}, configKinds: { skills: 'off' } });
    expect(loadSettings(tmp).configKinds).toEqual({ skills: 'off' });
  });

  it('新しく作る設定だけ configBundleSync を入りで始める', () => {
    fs.rmSync(path.join(tmp, 'settings.json'), { force: true });
    expect(loadSettings(tmp).configBundleSync).toBe(true);
    // 殻が先に書いた言語だけのファイルも、新しい利用者として読む。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ language: 'en' }));
    expect(loadSettings(tmp).configBundleSync).toBe(true);
  });
});

describe('移行の表と対象の登録', () => {
  it('KIND_TARGETS は、登録された対象の kinds と食い違わない', () => {
    const fromRegistry: Record<string, string[]> = {};
    for (const t of allTargets()) for (const k of t.kinds) (fromRegistry[k] ??= []).push(t.name);
    for (const [k, ts] of Object.entries(KIND_TARGETS)) expect([...ts].sort(), k).toEqual((fromRegistry[k] ?? []).sort());
    expect(Object.keys(fromRegistry).sort()).toEqual(Object.keys(KIND_TARGETS).sort());
  });
});

describe('migrateConfigKinds', () => {
  it('承認が auto なら、承認の要った種類も自動。configTargets に無い対象の種類は切', () => {
    const k = migrateConfigKinds({ configApproval: 'auto', configTargets: {} });
    expect(k.skills).toBe('auto');
    expect(k.settings).toBe('auto');
    for (const x of ['claude-hooks', 'claude-statusline', 'plugins', 'hangar-pref', 'agents-skills', 'claude-mcp', 'codex-mcp', 'opencode-mcp', 'codex-file', 'opencode-cli'] as const) expect(k[x]).toBe('off');
    // Claude の本体（claude）は入切を持たないので、その種類は切にならない。settings は claude にもまたがるので切にならない。
    expect(k['claude-md']).toBe('auto');
    expect(k.settings).toBe('auto');
  });

  it('承認が無い（each として読む）なら、承認の要った種類は確認', () => {
    const on = { 'claude-hooks': true, 'claude-plugins': true, 'claude-keys2': true, hangar: true, 'claude-mcp': true, 'agents-skills': true, opencode: true, codex: true, 'codex-mcp': true, 'opencode-mcp': true };
    const k = migrateConfigKinds({ configTargets: on });
    for (const x of ['skills', 'commands', 'agents', 'settings', 'claude-hooks', 'claude-statusline', 'plugins', 'claude-mcp', 'codex-mcp', 'opencode-mcp', 'codex-file', 'codex-config', 'opencode-file', 'opencode-config', 'agents-skills'] as const) expect(k[x]).toBe('confirm');
    for (const x of ['claude-md', 'keybindings', 'memory', 'opencode-cli', 'hangar-pref', 'transcript'] as const) expect(k[x]).toBe('auto');
  });
});
