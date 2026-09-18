import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbPath, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings } from './paths.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-')); process.env.HANGAR_HOME = tmp; });
afterEach(() => { delete process.env.HANGAR_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

describe('paths', () => {
  it('HANGAR_HOME を優先する', () => {
    expect(hangarHome()).toBe(tmp);
    expect(dbPath(tmp)).toBe(path.join(tmp, 'hangar.db'));
  });
  it('トークンは一度だけ作り、0600 で保存する', () => {
    ensureHome(tmp);
    const a = readOrCreateToken(tmp);
    const b = readOrCreateToken(tmp);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(path.join(tmp, 'token')).mode & 0o777).toBe(0o600);
  });
  it('端末情報は一度だけ作る', () => {
    ensureHome(tmp);
    const a = readOrCreateDevice(tmp);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.name).toBe(os.hostname());
    expect(readOrCreateDevice(tmp)).toEqual(a);
  });
  it('設定は既定値を持ち、保存すると読める', () => {
    ensureHome(tmp);
    const s = loadSettings(tmp);
    expect(s.workspaceRoot).toBe(path.join(os.homedir(), 'workspace'));
    saveSettings(tmp, { ...s, workspaceRoot: '/tmp/ws' });
    expect(loadSettings(tmp).workspaceRoot).toBe('/tmp/ws');
  });
  it('古い settings.json に無い項目は既定値で埋める', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c' }));
    const s = loadSettings(tmp);
    expect(s).toEqual({ workspaceRoot: '/old', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null });
  });
});
