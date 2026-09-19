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
  it('設定は 0600 で保存し、緩い権限のまま残さない', () => {
    // claudeDir や workspaceRoot は端末の中身を明かすので、token や device.json と同じ扱いにする。
    ensureHome(tmp);
    const file = path.join(tmp, 'settings.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    saveSettings(tmp, loadSettings(tmp));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('古い settings.json に無い項目は既定値で埋める', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c' }));
    const s = loadSettings(tmp);
    expect(s).toEqual({ workspaceRoot: '/old', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, toolsResolved: false, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null });
  });
  it('要約器の設定は既定値で埋まる', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    const s = loadSettings(tmp);
    expect(s).toMatchObject({ workspaceRoot: '/w', lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 });
  });
  it('許しの無い外部の要約器は、読み込みのときに既定へ戻す', () => {
    // 手で書き換えた settings.json や、この制限より前に保存された設定から本文が外へ出ていかないようにする。
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', lmStudioUrl: 'https://attacker.example.com/collect' }));
    expect(loadSettings(tmp).lmStudioUrl).toBe('http://127.0.0.1:1234');
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', lmStudioUrl: 'https://attacker.example.com/collect', allowExternalSummarizer: true }));
    expect(loadSettings(tmp).lmStudioUrl).toBe('https://attacker.example.com/collect');
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', lmStudioUrl: 'http://localhost:4321' }));
    expect(loadSettings(tmp).lmStudioUrl).toBe('http://localhost:4321');
  });
  it('保存した要約器の設定は既定値に上書きされない', () => {
    ensureHome(tmp);
    saveSettings(tmp, { ...loadSettings(tmp), lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 3 });
    expect(loadSettings(tmp)).toMatchObject({ lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 3 });
  });
});
