import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * アンインストールのときに、通知センターに残った Hangar のトーストを消す。
 * トーストの履歴はアプリを消しても残る（Windows の実機で、消して入れ直した後も前の版のトーストが並んでいた）。
 * NSIS には WinRT を呼ぶ手が無いので、Windows PowerShell（5.1）の 1 行で ToastNotificationManager の履歴を消す。
 * 登録（AppUserModelId）の名前と食い違わないことは config.test.ts が見る。
 */
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(app, p), 'utf8');
const win = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const hooks = read(path.join('src-tauri', win.bundle.windows.nsis.installerHooks as string));

/** NSIS の define の値（$$ を $ に戻したもの）。 */
const psScript = (): string => {
  const m = /^!define HANGAR_TOAST_CLEAR_PS "([^"]*)"\r?$/m.exec(hooks);
  expect(m, 'HANGAR_TOAST_CLEAR_PS が見つかりません').not.toBeNull();
  return m![1]!.replaceAll('$$', '$');
};

describe('アンインストールでトーストの履歴を消す', () => {
  it('-Command の引数は二重引用符で包むので、中に二重引用符を置かず、NSIS の文字列の上限（1024 字）に収まる', () => {
    expect(psScript()).not.toContain('"');
    expect(psScript().length).toBeLessThan(900);
  });

  it('Windows PowerShell で WinRT の型を読み込んでから、名前を指して消す', () => {
    const s = psScript();
    expect(s).toContain('ContentType = WindowsRuntime');
    expect(s.indexOf('ContentType = WindowsRuntime')).toBeLessThan(s.indexOf('::History.Clear('));
    expect(s).toContain(`::History.Clear('${conf.identifier}')`);
  });
});

/**
 * 1 行を、本物の Hangar の名前ではなく使い捨ての名前に向けて動かす。
 * 名前は登録（HKCU の AppUserModelId）があるものにする。アンインストールのフックも、登録を消す前に動かす。
 */
describe.runIf(process.platform === 'win32')('トーストの履歴を消す PowerShell の 1 行（Windows）', () => {
  const keys: string[] = [];
  afterEach(() => {
    for (const k of keys.splice(0)) spawnSync('reg.exe', ['delete', `HKCU\\${k}`, '/f'], { windowsHide: true });
  });

  it('登録のある名前の履歴を、失敗せずに消す', () => {
    const id = `HangarToastTest.${crypto.randomUUID()}`;
    const key = `Software\\Classes\\AppUserModelId\\${id}`;
    keys.push(key);
    const reg = spawnSync('reg.exe', ['add', `HKCU\\${key}`, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Hangar test', '/f'], { encoding: 'utf8', windowsHide: true });
    expect(reg.status, reg.stderr).toBe(0);
    const s = psScript();
    expect(s.split(`'${conf.identifier}'`)).toHaveLength(2);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', s.replace(`'${conf.identifier}'`, `'${id}'`)], { encoding: 'utf8', windowsHide: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.trim()).toBe('');
  });
});
