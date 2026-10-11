import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * インストーラが、同梱の hangar.cmd の置き場（$INSTDIR\server\bin）を利用者単位の PATH に足し、アンインストールで外す。
 * 書き換えは NSIS の文字列（長さに上限がある）を通さず、PowerShell が HKCU\Environment の Path を直に読み書きする。
 * 長い PATH を切り詰めたり、%USERPROFILE% のような展開前の項目を展開して書き戻したりしないためである。
 */
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(app, p), 'utf8');
const win = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const hooks = read(path.join('src-tauri', win.bundle.windows.nsis.installerHooks as string));

/** macro と macroend の間。 */
const macro = (name: string): string => {
  const m = new RegExp(`!macro ${name}( [^\\r\\n]*)?\\r?\\n([\\s\\S]*?)!macroend`).exec(hooks);
  expect(m, `${name} が見つかりません`).not.toBeNull();
  return m![2]!;
};

/** NSIS の define の値（$$ を $ に戻したもの）。 */
const psScript = (): string => {
  const m = /^!define HANGAR_PATH_PS "([^"]*)"\r?$/m.exec(hooks);
  expect(m, 'HANGAR_PATH_PS が見つかりません').not.toBeNull();
  return m![1]!.replaceAll('$$', '$');
};

describe('NSIS のフックで PATH を足し、外す', () => {
  // 同梱サーバは resources で server/ に置かれ、hangar.cmd はその bin に入る（bundle-server.ts）。
  const binDir = `$INSTDIR\\${conf.bundle.resources['../server-dist']}\\bin`;

  it('置き場と、足すか外すかを環境変数で渡して PowerShell を動かし、開いているプログラムに環境が変わったことを知らせる', () => {
    const b = macro('HANGAR_EDIT_USER_PATH');
    expect(b).toContain(`SetEnvironmentVariable(t "HANGAR_PATH_DIR", t "${binDir}")`);
    expect(b).toContain('SetEnvironmentVariable(t "HANGAR_PATH_OP", t "${OP}")');
    expect(b).toContain('${HANGAR_PATH_PS}');
    // HWND_BROADCAST に WM_SETTINGCHANGE。
    expect(b).toContain(`System::Call 'user32::SendMessageTimeoutW(p 0xFFFF, i 0x1A, p 0, w "Environment", i 0x2, i 5000, p 0)'`);
  });

  // NSIS の SendMessage /TIMEOUT は、応答しない窓 1 つごとに上限まで待つ。
  // 実機では応答しない窓が 10 個あり、入れるのも消すのも約 50 秒止まった。
  // SendMessageTimeout に SMTO_ABORTIFHUNG（0x2）を渡し、固まった窓は待たずに飛ばす。
  it('環境の変化の一斉送信は、固まった窓を待たない（SMTO_ABORTIFHUNG）', () => {
    expect(hooks).not.toMatch(/^\s*SendMessage\s/m);
    const m = /SendMessageTimeoutW\(([^)]*)\)/.exec(macro('HANGAR_EDIT_USER_PATH'));
    expect(m).not.toBeNull();
    const args = m![1]!.split(',').map((a) => a.trim());
    // hWnd、Msg、wParam、lParam、fuFlags、uTimeout、lpdwResult の 7 つ。
    expect(args).toHaveLength(7);
    expect(args[4]).toBe('i 0x2');
  });

  it('入れたあと（POSTINSTALL）に足す', () => {
    expect(macro('NSIS_HOOK_POSTINSTALL').trim()).toBe('!insertmacro HANGAR_EDIT_USER_PATH "add"');
  });

  it('消す前（PREUNINSTALL）に外す。ファイルを消す前なので $INSTDIR がまだ入れた場所を指す', () => {
    expect(macro('NSIS_HOOK_PREUNINSTALL').trim().split(/\r?\n/)[0]).toBe('!insertmacro HANGAR_EDIT_USER_PATH "remove"');
  });

  it('PowerShell の 1 行は、NSIS の文字列の上限（1024 字）に収まる', () => {
    const b = macro('HANGAR_EDIT_USER_PATH');
    const line = /nsExec::ExecToLog `([^`]*)`/.exec(b);
    expect(line).not.toBeNull();
    const expanded = line![1]!.replace('$SYSDIR', 'C:\\Windows\\System32').replace('${HANGAR_PATH_PS}', psScript());
    expect(expanded.length).toBeLessThan(1000);
    // -Command の引数は二重引用符で包むので、中に二重引用符を置かない。
    expect(psScript()).not.toContain('"');
  });

  it('ASCII だけで書く（NSIS はインストーラのコードページで読む）', () => {
    expect([...hooks].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
});

/**
 * PowerShell の 1 行を、本物の HKCU\Environment ではなく使い捨てのキーに向けて動かす。
 * 'Environment' を 1 か所だけ置き換えて、試験のキーを指させる。
 */
describe.runIf(process.platform === 'win32')('PATH を書き換える PowerShell の 1 行（Windows）', () => {
  const keys: string[] = [];
  afterEach(() => {
    for (const k of keys.splice(0)) spawnSync('reg.exe', ['delete', `HKCU\\${k}`, '/f'], { windowsHide: true });
  });

  const freshKey = (): string => {
    const k = `Software\\HangarPathTest-${crypto.randomUUID()}`;
    keys.push(k);
    return k;
  };

  const ps = (command: string, env: NodeJS.ProcessEnv = {}): string => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  const scriptFor = (key: string): string => {
    const s = psScript();
    expect(s.split("'Environment'")).toHaveLength(2);
    return s.replace("'Environment'", `'${key}'`);
  };

  const run = (key: string, op: 'add' | 'remove', dir: string) => ps(scriptFor(key), { HANGAR_PATH_DIR: dir, HANGAR_PATH_OP: op });

  /** Path の値（展開前）と種類。値が無ければ null。 */
  const readPath = (key: string): { value: string; kind: string } | null => {
    const out = ps(
      `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); if ($k -and ($k.GetValueNames() -contains 'Path')) { @{ value = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); kind = [string]$k.GetValueKind('Path') } | ConvertTo-Json -Compress } else { 'null' }`,
    );
    return JSON.parse(out) as { value: string; kind: string } | null;
  };

  const writePath = (key: string, value: string, kind: 'ExpandString' | 'String') =>
    ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}'); $k.SetValue('Path', '${value.replaceAll("'", "''")}', '${kind}'); $k.Close()`);

  const bin = 'C:\\Users\\me\\AppData\\Local\\Hangar\\server\\bin';

  it('末尾に足し、展開前の項目（%USERPROFILE%）と種類（REG_EXPAND_SZ）を保つ。外すと元に戻る', () => {
    const key = freshKey();
    writePath(key, '%USERPROFILE%\\bin;C:\\tools', 'ExpandString');
    run(key, 'add', bin);
    expect(readPath(key)).toEqual({ value: `%USERPROFILE%\\bin;C:\\tools;${bin}`, kind: 'ExpandString' });
    run(key, 'remove', bin);
    expect(readPath(key)).toEqual({ value: '%USERPROFILE%\\bin;C:\\tools', kind: 'ExpandString' });
  });

  it('もう入っていれば（大文字小文字や末尾の \\ が違っても）足さない。更新のたびに増えない', () => {
    const key = freshKey();
    writePath(key, `C:\\tools;${bin.toUpperCase()}\\`, 'ExpandString');
    run(key, 'add', bin);
    run(key, 'add', bin);
    expect(readPath(key)).toEqual({ value: `C:\\tools;${bin.toUpperCase()}\\`, kind: 'ExpandString' });
  });

  it('外すときは、書き方の違う重複もまとめて外し、ほかの項目は触らない', () => {
    const key = freshKey();
    writePath(key, `${bin};C:\\tools;${bin}\\;C:\\other`, 'String');
    run(key, 'remove', bin);
    expect(readPath(key)).toEqual({ value: 'C:\\tools;C:\\other', kind: 'String' });
  });

  it('Path が無ければ作り、外して空になれば値ごと消す', () => {
    const key = freshKey();
    ps(`[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}').Close()`);
    run(key, 'add', bin);
    expect(readPath(key)).toEqual({ value: bin, kind: 'ExpandString' });
    run(key, 'remove', bin);
    expect(readPath(key)).toBeNull();
  });

  it('入っていないものを外そうとしても、何も書き換えない', () => {
    const key = freshKey();
    writePath(key, 'C:\\tools;;C:\\other', 'ExpandString');
    run(key, 'remove', bin);
    expect(readPath(key)).toEqual({ value: 'C:\\tools;;C:\\other', kind: 'ExpandString' });
  });

  it('長い PATH（1024 字を超える）を切り詰めない', () => {
    const key = freshKey();
    const long = Array.from({ length: 80 }, (_, i) => `C:\\very\\long\\path\\entry\\number\\${i}`).join(';');
    expect(long.length).toBeGreaterThan(2048);
    writePath(key, long, 'ExpandString');
    run(key, 'add', bin);
    expect(readPath(key)).toEqual({ value: `${long};${bin}`, kind: 'ExpandString' });
    run(key, 'remove', bin);
    expect(readPath(key)).toEqual({ value: long, kind: 'ExpandString' });
  });
});
