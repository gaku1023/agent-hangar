// 外部ターミナル（macOS は Terminal.app と iTerm2、Windows は Windows Terminal と既定のターミナル）と VS Code への受け渡し。
// macOS は AppleEvent を避けられる経路（.command ファイル）を既定にして、自動化の許可を要らなくする。
import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TerminalApp } from '@agent-hangar/shared';
import { needsShell } from '../platform/exec.ts';
import { MessageError, msg } from '../i18n/message.ts';

/** verbatim は Windows で引数を引用せずそのまま渡す指定で、cmd.exe へ自前で組んだ 1 行を渡すときに使う。 */
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; shell?: boolean; verbatim?: boolean }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** child_process.execFile の Promise 版。失敗でも投げず code を返す。 */
export const execFile: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFileCb(cmd, args, { timeout: opts?.timeoutMs ?? 30_000, encoding: 'utf8', shell: opts?.shell ?? false, windowsHide: true, windowsVerbatimArguments: opts?.verbatim ?? false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** シェルの単一引用符で包む。 */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function cmdDir(home: string): string {
  const d = path.join(home, 'cmd');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 末尾の exit は、detach した後にウィンドウが「[Process completed]」で残らないようにするため。 */
function writeCommand(file: string, line: string): string {
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${line}\nexit\n`, { mode: 0o755 });
  return file;
}

const hash8 = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

/** ファイル名に使える形だけ通し、そうでなければハッシュにする。cmd/ の外に書かせない。 */
const fileSafe = (name: string) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : hash8(name));

/**
 * tmux attach のコマンド行。
 * target は `=` を付けた完全一致にする。素の名前だと tmux が前方一致に落ちて、
 * 終了した run の `hangar-abc12` がそのシェルタブ `hangar-abc12-t1` に繋がってしまう。
 */
const attachLine = (tmuxPath: string, tmuxName: string) => `${sq(tmuxPath)} attach -t ${sq(`=${tmuxName}`)}`;

/** tmux attach を書いた .command。AppleEvent を使わないので macOS の自動化の許可が要らない。 */
export function writeAttachCommand(home: string, tmuxPath: string, tmuxName: string): string {
  return writeCommand(path.join(cmdDir(home), `attach-${fileSafe(tmuxName)}.command`), attachLine(tmuxPath, tmuxName));
}

/**
 * ディレクトリに cd するコマンド行。
 * 既定の shell の決め方は iTerm2 の経路と .command の経路で必ず同じにする。
 * 別々に書くと、同じ操作なのに経路で違う shell が立ち上がる。
 * $SHELL が無い環境（launchd から起きた GUI など）では /bin/zsh に落とし、
 * パスに空白があっても割れないように引用符で包む。
 */
const cdLine = (dir: string) => `cd ${sq(dir)} && exec "\${SHELL:-/bin/zsh}" -l`;

/** ディレクトリに cd する .command。ファイル名はパスのハッシュにして、どんな文字でも安全に置ける。 */
export function writeCdCommand(home: string, dir: string): string {
  return writeCommand(path.join(cmdDir(home), `open-${hash8(dir)}.command`), cdLine(dir));
}

/** -g はウィンドウを前面に出さない指定で、利用者の作業を奪わないために要る。 */
async function openWithTerminalApp(file: string, exec: Exec): Promise<void> {
  const r = await exec('open', ['-g', '-a', 'Terminal', file]);
  if (r.code !== 0) throw new MessageError(msg('external.terminal.openFailed', { reason: r.stderr.trim() || `exit ${r.code}` }));
}

/** iTerm2 は AppleScript でしか新規ウィンドウを開けない。初回は macOS の自動化の許可ダイアログが出る。 */
async function openWithIterm(command: string, exec: Exec): Promise<boolean> {
  const script = [
    'with timeout of 10 seconds',
    '  tell application "iTerm"',
    '    activate',
    `    create window with default profile command ${JSON.stringify(command)}`,
    '  end tell',
    'end timeout',
  ].join('\n');
  const r = await exec('osascript', ['-e', script], { timeoutMs: 12_000 });
  return r.code === 0;
}

async function openCommand(o: { app: TerminalApp; command: string; file: () => string; exec: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  if (o.app === 'iterm' && (await openWithIterm(o.command, o.exec))) return { app: 'iterm', fellBack: false };
  await openWithTerminalApp(o.file(), o.exec);
  return { app: 'terminal', fellBack: o.app === 'iterm' };
}

/**
 * Windows で何を開くか。
 * Windows Terminal には wt.exe へ渡す引数の並びを、既定のターミナルには start へ渡す 1 行（cmd.exe の引用済み）を持たせる。
 */
type WindowsTarget = { wt: string[]; start: string };

/** " と改行は、どちらの経路でも引用を破る。" は Windows のファイル名にも使えない。開けるふりをして別のものを起こさないよう、断る。 */
function assertWindowsSafe(...values: string[]): void {
  for (const v of values) if (/["\r\n]/.test(v)) throw new MessageError(msg('external.terminal.badTarget', { target: v }));
}

/**
 * wt.exe の引数の 1 つ。wt は ; を「次のコマンド」の区切りに読むので、\; にして文字のまま通す。
 * 空白や日本語の引用は、Node が Windows の規則で付ける。
 */
const wtArg = (s: string) => s.replace(/;/g, '\\;');

/**
 * cmd.exe に読ませる 1 つの語を二重引用符で包む。
 * 引用符の中でも cmd.exe は %name% を環境変数に置き換えるので、% だけは引用の外へ出して ^ で文字にする。
 * 受け取る側の C の規則では "a"%"b" は a%b の 1 語になる。" を含む値は assertWindowsSafe が先に断る。
 */
export const cmdQuote = (s: string) => `"${s.replace(/%/g, '"^%"')}"`;

/** cmd.exe /s /c へ渡す 1 行。/s で外側の引用符だけを剥がさせ、/d で AutoRun を、/v:off で ! の置き換えを切る。 */
const cmdArgs = (line: string) => ['/d', '/v:off', '/s', '/c', `"${line}"`];

/** Windows Terminal の新しいタブで開く。-w 0 は直近の窓のタブにする指定で、窓が無ければ新しい窓になる。 */
async function openWithWindowsTerminal(args: string[], exec: Exec): Promise<boolean> {
  const r = await exec('wt.exe', ['-w', '0', 'new-tab', ...args]);
  return r.code === 0;
}

/**
 * 既定のターミナル（Windows の設定の「既定のターミナル アプリ」）の新しい窓で開く。
 * start の最初の引用は窓の題名と読まれるので、空の "" を先に置く。
 * 引数は Node に引用させない。Node は " を \" で逃がすが、cmd.exe はそれを知らない。
 */
async function openWithWindowsDefault(line: string, exec: Exec): Promise<void> {
  const r = await exec('cmd.exe', cmdArgs(`start "" ${line}`), { verbatim: true });
  if (r.code !== 0) throw new MessageError(msg('external.terminal.windowsOpenFailed', { reason: r.stderr.trim() || `exit ${r.code}` }));
}

async function openWindows(o: { app: TerminalApp; target: WindowsTarget; exec: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  if (o.app === 'windowsTerminal' && (await openWithWindowsTerminal(o.target.wt, o.exec))) return { app: 'windowsTerminal', fellBack: false };
  await openWithWindowsDefault(o.target.start, o.exec);
  return { app: 'windowsDefault', fellBack: o.app === 'windowsTerminal' };
}

const isWindowsApp = (app: TerminalApp) => app === 'windowsTerminal' || app === 'windowsDefault';

/** Windows の tmux（psmux）の attach。target は macOS と同じく = を付けた完全一致にする。 */
function windowsAttach(tmuxPath: string, tmuxName: string): WindowsTarget {
  assertWindowsSafe(tmuxPath, tmuxName);
  const target = `=${tmuxName}`;
  return { wt: ['--', wtArg(tmuxPath), 'attach', '-t', wtArg(target)], start: `${cmdQuote(tmuxPath)} attach -t ${cmdQuote(target)}` };
}

/**
 * Windows でフォルダを開く。Windows Terminal は既定のプロファイルをそのフォルダで、既定のターミナルは PowerShell を開く。
 * 末尾の \ は取る（ドライブの直下は残す）。"…\" の \" を引用の終わりと読み違える道具がある。
 */
function windowsDir(dir: string): WindowsTarget {
  assertWindowsSafe(dir);
  const d = /^[A-Za-z]:\\$/.test(dir) ? dir : dir.replace(/[\\/]+$/, '');
  return { wt: ['-d', wtArg(d)], start: `/D ${cmdQuote(d)} powershell.exe -NoLogo` };
}

export function openInTerminalApp(o: { home: string; tmuxPath: string; tmuxName: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  const exec = o.exec ?? execFile;
  if (isWindowsApp(o.app)) return Promise.resolve().then(() => openWindows({ app: o.app, target: windowsAttach(o.tmuxPath, o.tmuxName), exec }));
  return openCommand({
    app: o.app,
    command: attachLine(o.tmuxPath, o.tmuxName),
    file: () => writeAttachCommand(o.home, o.tmuxPath, o.tmuxName),
    exec,
  });
}

export function openDirInTerminalApp(o: { home: string; dir: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  const exec = o.exec ?? execFile;
  if (isWindowsApp(o.app)) return Promise.resolve().then(() => openWindows({ app: o.app, target: windowsDir(o.dir), exec }));
  return openCommand({
    app: o.app,
    command: cdLine(o.dir),
    file: () => writeCdCommand(o.home, o.dir),
    exec,
  });
}

export async function openInEditor(o: { codePath: string | null; target: string; exec?: Exec; platform?: NodeJS.Platform }): Promise<void> {
  if (!o.codePath) throw new MessageError(msg('external.editor.codeMissing', { label: msg('settings.label.codePath') }));
  const exec = o.exec ?? execFile;
  let r: { code: number; stdout: string; stderr: string };
  if (needsShell(o.codePath, o.platform)) {
    // Windows の VS Code の code は code.cmd で、Node は .cmd をシェル無しでは起こせない。cmd.exe 越しに、パスを引用符で包んで渡す。
    // " は Windows のファイル名に使えない文字で、引用を破る。含むものは開かずに断る。
    if (o.codePath.includes('"') || o.target.includes('"')) throw new MessageError(msg('external.editor.badPath', { target: o.target }));
    r = await exec(`"${o.codePath}"`, [`"${o.target}"`], { shell: true });
  } else {
    r = await exec(o.codePath, [o.target]);
  }
  if (r.code !== 0) throw new MessageError(msg('external.editor.launchFailed', { reason: r.stderr.trim() || `exit ${r.code}` }));
}
