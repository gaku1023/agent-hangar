import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbPath, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings } from './paths.ts';
import { expectMode } from '../../test/platform.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-')); process.env.HANGAR_HOME = tmp; });
afterEach(() => { delete process.env.HANGAR_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

describe('paths', () => {
  it('HANGAR_HOME を優先する', () => {
    expect(hangarHome()).toBe(tmp);
    expect(dbPath(tmp)).toBe(path.join(tmp, 'hangar.db'));
  });
  it('置き場所は 0700 で作り、既にあるものも 0700 に直す', () => {
    // 中の hangar.db と desktop.log は 0644 なので、置き場所が 0755 だと同じ機械の別の利用者に記録が読める。
    // デスクトップの .app が先に作った置き場所が 0755 のままでも、起動のたびにここで直る。
    const home = path.join(tmp, 'home');
    ensureHome(home);
    expectMode(home, 0o700);
    fs.chmodSync(home, 0o755);
    ensureHome(home);
    expectMode(home, 0o700);
    // 利用者がより厳しくした権限は緩めない。
    fs.chmodSync(home, 0o500);
    ensureHome(home);
    expectMode(home, 0o500);
  });
  it('トークンは一度だけ作り、0600 で保存する', () => {
    ensureHome(tmp);
    const a = readOrCreateToken(tmp);
    const b = readOrCreateToken(tmp);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expectMode(path.join(tmp, 'token'), 0o600);
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
    expectMode(file, 0o600);
  });
  it('古い settings.json に無い項目は既定値で埋める', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c' }));
    const s = loadSettings(tmp, 'darwin');
    expect(s).toEqual({ workspaceRoot: '/old', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, toolsResolved: false, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null });
  });
  it('外部ターミナルの既定は OS で決め、別の OS で保存した値はその OS の既定に読み替える', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c' }));
    expect(loadSettings(tmp, 'win32').terminalApp).toBe('windowsTerminal');
    // macOS で iTerm2 を選んだ設定を Windows へ持っていったとき、またはその逆。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c', terminalApp: 'iterm' }));
    expect(loadSettings(tmp, 'darwin').terminalApp).toBe('iterm');
    expect(loadSettings(tmp, 'win32').terminalApp).toBe('windowsTerminal');
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c', terminalApp: 'windowsDefault' }));
    expect(loadSettings(tmp, 'win32').terminalApp).toBe('windowsDefault');
    expect(loadSettings(tmp, 'darwin').terminalApp).toBe('terminal');
  });
  it('旧い設定の同期のスイッチ（syncClaudeConfig）が入った settings.json も読め、未知の鍵として持ち越さない', () => {
    // 設定の同期の作り直し（段 4）で旧実装を消した。旧スイッチを入れていた人の settings.json は、そのまま起動できる。
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c', syncClaudeConfig: true, configBundleSync: true }));
    const s = loadSettings(tmp);
    expect(s.workspaceRoot).toBe('/old');
    expect(s.configBundleSync).toBe(true);
    expect(Object.keys(s)).not.toContain('syncClaudeConfig');
    // 保存し直しても旧い鍵は書かれない（新しい実装のスイッチは残る）。
    saveSettings(tmp, s);
    const written = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(written).not.toHaveProperty('syncClaudeConfig');
    expect(written.configBundleSync).toBe(true);
  });
  it('言語は保存して読め、知らない値は読み込みで落とす', () => {
    ensureHome(tmp);
    // 項目が無いうちは持たない。読む側（languageOf）が既定の日本語として読む。
    expect(loadSettings(tmp).language).toBeUndefined();
    saveSettings(tmp, { ...loadSettings(tmp), language: 'en' });
    expect(loadSettings(tmp).language).toBe('en');
    // 手で書き換えた settings.json の値を、そのまま画面とサーバへ流さない。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', language: 'fr' }));
    expect(loadSettings(tmp).language).toBeUndefined();
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
