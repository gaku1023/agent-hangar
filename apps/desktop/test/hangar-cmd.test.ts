import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Windows の同梱 CLI の入口 bin\hangar.cmd の振る舞い。
 * cmd の作りは、Ctrl+C のあとに「バッチ ジョブを終了しますか (Y/N)?」を出さないことと、node の終了コードと引数をそのまま通すことを縛る。
 */
const source = fileURLToPath(new URL('../scripts/hangar.cmd', import.meta.url));
const onWindows = process.platform === 'win32';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 実行する行（空行、rem、label、@echo off を除いた行）。 */
const commandLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^rem\b/i.test(l) && !l.startsWith(':') && !/^@echo off$/i.test(l));

describe('hangar.cmd の作り', () => {
  const text = fs.readFileSync(source, 'utf8');

  it('ASCII だけで書く（cmd は OEM のコードページで読む）', () => {
    expect([...text].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it('node を起こす前にバッチを終える。node の行が最後に実行する行で、その前に endlocal と、無い label への goto を置く', () => {
    const lines = commandLines(text);
    const last = lines.at(-1)!;
    expect(last).toMatch(/^endlocal & goto #\S+# 2>nul \|\| /i);
    expect(last).toMatch(/& "%HANGAR_NODE%" "%dp0%\.\.\\launch-cli\.mjs" %\*$/);
    // 跳び先の label は無いこと（あれば goto が成り立ち、バッチが終わらない）。
    const label = /goto (#\S+#)/i.exec(last)![1]!;
    expect(text.toLowerCase()).not.toContain(`:${label.toLowerCase()}`);
    // node の行は 1 つだけ。
    expect(lines.filter((l) => l.includes('launch-cli.mjs'))).toHaveLength(1);
  });
});

/** 一時の束の形（bin\hangar.cmd と、束の根の launch-cli.mjs）を作る。launch-cli.mjs は試験ごとの中身に替える。 */
function fakeBundle(launcher: string): { root: string; cmd: string } {
  // 空白の無い場所に作る。Start-Process に渡す引数の引用符の揺れを避けるためである。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangarcmd-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'bin'));
  const cmd = path.join(root, 'bin', 'hangar.cmd');
  // 束に入れるときと同じく CRLF にそろえる（bundle-server.ts）。
  fs.writeFileSync(cmd, fs.readFileSync(source, 'utf8').replace(/\r?\n/g, '\r\n'));
  fs.writeFileSync(path.join(root, 'launch-cli.mjs'), launcher);
  return { root, cmd };
}

describe.runIf(onWindows)('hangar.cmd を Windows で動かす', () => {
  const echo = [
    'console.log(JSON.stringify({ args: process.argv.slice(2), hangarNode: process.env.HANGAR_NODE ?? null }));',
    'process.exitCode = Number(process.env.FAKE_EXIT ?? 0);',
    '',
  ].join('\n');

  it('引数をそのまま渡し、node の終了コードを cmd の終了コードとして返す', () => {
    const { cmd } = fakeBundle(echo);
    const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmd, 'status', '--port', '4231'], {
      encoding: 'utf8',
      env: { ...process.env, HANGAR_NODE: process.execPath, FAKE_EXIT: '7' },
      windowsHide: true,
    });
    expect(r.status, r.stderr).toBe(7);
    expect(JSON.parse(r.stdout.trim()).args).toEqual(['status', '--port', '4231']);
  });

  it('PowerShell から打っても、$LASTEXITCODE に node の終了コードが入る', () => {
    const { cmd } = fakeBundle(echo);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${cmd}' url; exit $LASTEXITCODE`], {
      encoding: 'utf8',
      env: { ...process.env, HANGAR_NODE: process.execPath, FAKE_EXIT: '3' },
      windowsHide: true,
    });
    expect(r.status, r.stderr).toBe(3);
    expect(JSON.parse(r.stdout.trim()).args).toEqual(['url']);
  });

  it('PATH で見つけた node を使うとき、cmd の中で決めた HANGAR_NODE を node へ持ち込まない', () => {
    const { cmd } = fakeBundle(echo);
    const env: NodeJS.ProcessEnv = { ...process.env, FAKE_EXIT: '0' };
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'HANGAR_NODE') delete env[k];
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
    env[pathKey] = `${path.dirname(process.execPath)};${env[pathKey] ?? ''}`;
    const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmd], { encoding: 'utf8', env, windowsHide: true });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim()).hangarNode).toBeNull();
  });

  /**
   * Ctrl+C の確かめ。
   * 隠した新しいコンソールで cmd /c <バッチ> を起こし、バッチが起こした node が、同じコンソールの全員へ Ctrl+C を送る。
   * 「バッチ ジョブを終了しますか (Y/N)?」が出ると、cmd は答えを待って止まったままになる（隠したコンソールなので誰も答えない）。
   * 出なければ、node が Ctrl+C で終わったところで cmd も終わる。
   * 試しの仕掛けが本当に Ctrl+C を届けていることは、古い作りのバッチ（node の後に行が続く）が止まったままになることで確かめる。
   */
  const ctrlC =
    "Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'; " +
    '[void][W.K]::GenerateConsoleCtrlEvent(0, 0); Start-Sleep -Seconds 5';
  const sendCtrlC = [
    "import { spawnSync } from 'node:child_process';",
    // 引用符の揺れを避けるため、PowerShell には UTF-16LE の base64 で渡す。
    `spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', ${JSON.stringify(Buffer.from(ctrlC, 'utf16le').toString('base64'))}], { stdio: 'ignore' });`,
    // Ctrl+C が届かなかったときだけ、ここまで来る。少し待ってから普通に終える。
    'setTimeout(() => {}, 10000);',
    '',
  ].join('\n');

  const harness = [
    'param([string]$Bat, [int]$TimeoutMs)',
    "$p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $Bat) -WindowStyle Hidden -PassThru",
    '$null = $p.Handle',
    'if ($p.WaitForExit($TimeoutMs)) { "exited $($p.ExitCode)" } else { & taskkill.exe /T /F /PID $p.Id | Out-Null; "hung" }',
    '',
  ].join('\r\n');

  const underCtrlC = (bat: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangarps-'));
    dirs.push(dir);
    const ps1 = path.join(dir, 'harness.ps1');
    fs.writeFileSync(ps1, harness);
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Bat', bat, '-TimeoutMs', '20000'], {
      encoding: 'utf8',
      env: { ...process.env, HANGAR_NODE: process.execPath },
      windowsHide: true,
      timeout: 60_000,
    });
    return `${r.stdout}`.trim() + (r.stderr ? `\n${r.stderr}` : '');
  };

  it('Ctrl+C で node が終わると、cmd も問わずに終わる', { timeout: 120_000 }, () => {
    const { root, cmd } = fakeBundle(sendCtrlC);
    // 対照：node の後に行が続く古い作り。Ctrl+C が届いていれば、ここで問いが出て止まる。
    const naive = path.join(root, 'bin', 'naive.cmd');
    fs.writeFileSync(naive, ['@echo off', 'setlocal', '"%HANGAR_NODE%" "%~dp0..\\launch-cli.mjs" %*', 'exit /b %ERRORLEVEL%', ''].join('\r\n'));
    expect(underCtrlC(naive), '対照のバッチが止まらない。試しの仕掛けが Ctrl+C を届けていない').toBe('hung');
    // Ctrl+C で終わった node の終了コード（STATUS_CONTROL_C_EXIT、0xC000013A）が、そのまま cmd の終了コードになる。
    expect(underCtrlC(cmd)).toBe('exited -1073741510');
  });
});
