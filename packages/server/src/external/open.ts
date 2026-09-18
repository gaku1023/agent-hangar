// Terminal.app と iTerm2 と VS Code への受け渡し。
// AppleEvent を避けられる経路（.command ファイル）を既定にして、自動化の許可を要らなくする。
import { execFile as execFileCb } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TerminalApp } from '@agent-hangar/shared';

export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** child_process.execFile の Promise 版。失敗でも投げず code を返す。 */
export const execFile: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFileCb(cmd, args, { timeout: opts?.timeoutMs ?? 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
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

/** tmux attach を書いた .command。AppleEvent を使わないので macOS の自動化の許可が要らない。 */
export function writeAttachCommand(home: string, tmuxPath: string, tmuxName: string): string {
  return writeCommand(path.join(cmdDir(home), `attach-${fileSafe(tmuxName)}.command`), `${sq(tmuxPath)} attach -t ${sq(tmuxName)}`);
}

/** ディレクトリに cd する .command。ファイル名はパスのハッシュにして、どんな文字でも安全に置ける。 */
export function writeCdCommand(home: string, dir: string): string {
  return writeCommand(path.join(cmdDir(home), `open-${hash8(dir)}.command`), `cd ${sq(dir)} && exec "\${SHELL:-/bin/zsh}" -l`);
}

/** -g はウィンドウを前面に出さない指定で、利用者の作業を奪わないために要る。 */
async function openWithTerminalApp(file: string, exec: Exec): Promise<void> {
  const r = await exec('open', ['-g', '-a', 'Terminal', file]);
  if (r.code !== 0) throw new Error(`Terminal.app で開けませんでした: ${r.stderr.trim() || `exit ${r.code}`}`);
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

export function openInTerminalApp(o: { home: string; tmuxPath: string; tmuxName: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  return openCommand({
    app: o.app,
    command: `${sq(o.tmuxPath)} attach -t ${sq(o.tmuxName)}`,
    file: () => writeAttachCommand(o.home, o.tmuxPath, o.tmuxName),
    exec: o.exec ?? execFile,
  });
}

export function openDirInTerminalApp(o: { home: string; dir: string; app: TerminalApp; exec?: Exec }): Promise<{ app: TerminalApp; fellBack: boolean }> {
  return openCommand({
    app: o.app,
    command: `cd ${sq(o.dir)} && exec $SHELL -l`,
    file: () => writeCdCommand(o.home, o.dir),
    exec: o.exec ?? execFile,
  });
}

export async function openInEditor(o: { codePath: string | null; target: string; exec?: Exec }): Promise<void> {
  if (!o.codePath) throw new Error('VS Code の code コマンドが見つかりません。Settings の codePath を設定してください');
  const r = await (o.exec ?? execFile)(o.codePath, [o.target]);
  if (r.code !== 0) throw new Error(`VS Code を起動できませんでした: ${r.stderr.trim() || `exit ${r.code}`}`);
}
