import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // 新しい利用者の作成場所は空（決めていない）である。初日はホームの帯から、会話したフォルダを選んでもらう（2026-10-13）。
    expect(s.workspaceRoot).toBe('');
    saveSettings(tmp, { ...s, workspaceRoot: '/tmp/ws' });
    expect(loadSettings(tmp).workspaceRoot).toBe('/tmp/ws');
  });
  it('作成場所の項目が無い古い settings.json は、今までどおり ~/workspace として読む', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ claudeDir: '/c' }));
    expect(loadSettings(tmp).workspaceRoot).toBe(path.join(os.homedir(), 'workspace'));
  });
  it('殻が起動の頭に書く言語だけの settings.json は、新しい利用者として作成場所を空で読む', () => {
    // 殻（bootfail.rs の ensure_language）は、サーバより先に {"language": …} だけのファイルを作る。
    // これを項目の無い古い settings.json と読むと、初日から ~/workspace の直下が自動で登録される（0.6.0-rc.1 の VM、B73）。
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ language: 'en' }) + '\n');
    const s = loadSettings(tmp, process.platform, () => 'ja');
    expect(s.workspaceRoot).toBe('');
    // 殻が決めた言語はそのまま使う。
    expect(s.language).toBe('en');
    // 言語のほかに鍵が 1 つでもあれば、今までどおり既存の利用者として読む。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ language: 'ja', claudeDir: '/c' }));
    expect(loadSettings(tmp).workspaceRoot).toBe(path.join(os.homedir(), 'workspace'));
  });
  it('設定は 0600 で保存し、緩い権限のまま残さない', () => {
    // claudeDir や workspaceRoot は端末の中身を明かすので、token や device.json と同じ扱いにする。
    ensureHome(tmp);
    const file = path.join(tmp, 'settings.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    saveSettings(tmp, loadSettings(tmp));
    expectMode(file, 0o600);
  });
  it('古い settings.json に無い項目は既定値で埋める（言語は OS に合わせる前の日本語）', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c' }));
    const s = loadSettings(tmp, 'darwin');
    expect(s).toEqual({ workspaceRoot: '/old', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, toolsResolved: false, summaryEngine: 'off', summaryClaudeModel: 'haiku', lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryApiKey: null, summaryFallback: false, summaryHourlyCap: 20, allowExternalSummarizer: false, askStatusAtEnd: true, liveHints: true, autoDone: true, autoDoneIdleDays: 7, autoPark: true, remoteControl: true, defaultModel: null, nodePath: null, language: 'ja' });
  });
  it('0.4.0 までの codePath は、VS Code とその場所のエディタに読み替え、古い鍵は持たない', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c', codePath: '/usr/local/bin/code' }));
    const s = loadSettings(tmp, 'darwin');
    expect(s.editor).toEqual({ id: 'vscode', path: '/usr/local/bin/code', fileCmd: '', dirCmd: '', terminal: 'none' });
    expect('codePath' in s).toBe(false);
    // editor を持つ設定は、それをそのまま使う。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/old', claudeDir: '/c', codePath: '/x/code', editor: { id: 'zed', path: null, fileCmd: '', dirCmd: '', terminal: 'none' } }));
    expect(loadSettings(tmp, 'darwin').editor.id).toBe('zed');
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
  it('言語は保存して読め、知らない値は OS に合わせる前の日本語として読む', () => {
    ensureHome(tmp);
    saveSettings(tmp, { ...loadSettings(tmp), language: 'en' });
    expect(loadSettings(tmp, process.platform, () => 'ja').language).toBe('en');
    // 手で書き換えた settings.json の値を、そのまま画面とサーバへ流さない。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', language: 'fr' }));
    expect(loadSettings(tmp, process.platform, () => 'en').language).toBe('ja');
  });
  it('設定が無い（初めての起動）なら OS の表示言語、あって言語が無い（前からの利用者）なら日本語', () => {
    ensureHome(tmp);
    expect(loadSettings(tmp, process.platform, () => 'en').language).toBe('en');
    expect(loadSettings(tmp, process.platform, () => 'ja').language).toBe('ja');
    // OS が読めなければ英語。
    expect(loadSettings(tmp, process.platform, () => undefined).language).toBe('en');
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    expect(loadSettings(tmp, process.platform, () => 'en').language).toBe('ja');
  });
  it('OS の表示言語は、差し替えの変数（HANGAR_OS_LANGUAGE）でも決められる', () => {
    ensureHome(tmp);
    vi.stubEnv('HANGAR_OS_LANGUAGE', 'en');
    try {
      expect(loadSettings(tmp).language).toBe('en');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('起動する claude に足す段のスイッチは、鍵が無ければ入り（今までと同じ）で、保存した切りを読める', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    expect(loadSettings(tmp)).toMatchObject({ askStatusAtEnd: true, liveHints: true });
    saveSettings(tmp, { ...loadSettings(tmp), askStatusAtEnd: false, liveHints: false });
    expect(loadSettings(tmp)).toMatchObject({ askStatusAtEnd: false, liveHints: false });
  });
  it('要約エンジンの鍵が無い設定（0.5.0 まで）は「使わない」で読み、URL とモデルと切り替えの鍵は残す', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', lmStudioUrl: 'http://127.0.0.1:5555', lmStudioModel: 'gemma', summaryFallback: true }));
    expect(loadSettings(tmp)).toMatchObject({ summaryEngine: 'off', lmStudioUrl: 'http://127.0.0.1:5555', lmStudioModel: 'gemma', summaryFallback: true });
    saveSettings(tmp, { ...loadSettings(tmp), summaryEngine: 'openai', summaryClaudeModel: 'sonnet', summaryApiKey: 'sk-local', defaultModel: 'opus' });
    expect(loadSettings(tmp)).toMatchObject({ summaryEngine: 'openai', summaryClaudeModel: 'sonnet', summaryApiKey: 'sk-local', defaultModel: 'opus' });
  });
  it('古い settings.json に remoteControl が無ければ true で、保存した false を読め、真偽値でない値は true に寄せる', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    expect(loadSettings(tmp).remoteControl).toBe(true);
    saveSettings(tmp, { ...loadSettings(tmp), remoteControl: false });
    expect(loadSettings(tmp).remoteControl).toBe(false);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', remoteControl: 'no' }));
    expect(loadSettings(tmp).remoteControl).toBe(true);
  });
  it('手で書き換えた要約エンジンとモデルの値は、既定に寄せる', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', summaryEngine: 'lmstudio', summaryClaudeModel: '--tools', summaryApiKey: 3, defaultModel: '' }));
    expect(loadSettings(tmp)).toMatchObject({ summaryEngine: 'off', summaryClaudeModel: 'haiku', summaryApiKey: null, defaultModel: null });
  });
  it('hangar が自分で行うこと（自動の Done と自動の停止）のスイッチは、鍵が無ければ入り（今までと同じ）で、保存した切りを読める', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    expect(loadSettings(tmp)).toMatchObject({ autoDone: true, autoPark: true });
    saveSettings(tmp, { ...loadSettings(tmp), autoDone: false, autoPark: false });
    expect(loadSettings(tmp)).toMatchObject({ autoDone: false, autoPark: false });
    // 手で書き換えた真偽値でない値は、既定（入り）に寄せる。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', autoDone: 'no', autoPark: 0 }));
    expect(loadSettings(tmp)).toMatchObject({ autoDone: true, autoPark: true });
    // 長く動いていない会話の日数も、選べる値でなければ既定の 7 日に寄せる。
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', autoDoneIdleDays: 5 }));
    expect(loadSettings(tmp)).toMatchObject({ autoDoneIdleDays: 7 });
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', autoDoneIdleDays: 0 }));
    expect(loadSettings(tmp)).toMatchObject({ autoDoneIdleDays: 0 });
  });
  it('要約器の設定は既定値で埋まる', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w' }));
    const s = loadSettings(tmp);
    expect(s).toMatchObject({ workspaceRoot: '/w', summaryEngine: 'off', summaryClaudeModel: 'haiku', lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryApiKey: null, summaryFallback: false, summaryHourlyCap: 20 });
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
