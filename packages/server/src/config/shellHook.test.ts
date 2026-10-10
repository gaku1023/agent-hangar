import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureShellScript, installShellHook, SHELL_MARKER, shellHookInstalled, shellHookLine, shellHookState, shellInstallCommand, shellScriptPath, shellWrapSupported, uninstallShellHook, zshrcPath } from './shellHook.ts';
import { posixDescribe } from '../../test/platform.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-shell-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// zsh の包み。Windows の包みは次の区切りで作る。
posixDescribe('~/.zshrc の 1 行', () => {
  it('ホームの下なら $HOME からの相対で、本体が無ければ何もしない形にする', () => {
    expect(shellHookLine('/Users/me/.agent-hangar', '/Users/me')).toBe(`[ -f "$HOME/.agent-hangar/shell/claude.zsh" ] && source "$HOME/.agent-hangar/shell/claude.zsh"  ${SHELL_MARKER}`);
    expect(shellHookLine('/opt/hangar', '/Users/me')).toBe(`[ -f "/opt/hangar/shell/claude.zsh" ] && source "/opt/hangar/shell/claude.zsh"  ${SHELL_MARKER}`);
  });
  it('ZDOTDIR を立てていればそちらの .zshrc を使う', () => {
    expect(zshrcPath({}, '/Users/me')).toBe('/Users/me/.zshrc');
    expect(zshrcPath({ ZDOTDIR: '/Users/me/.config/zsh' }, '/Users/me')).toBe('/Users/me/.config/zsh/.zshrc');
  });
  it('足すときは控えを取り、二度足さず、外すときは目印の行だけを消す', () => {
    const rc = path.join(dir, '.zshrc');
    fs.writeFileSync(rc, 'export A=1\nalias ll="ls -l"\n');
    const line = shellHookLine(path.join(dir, '.agent-hangar'), dir);
    const a = installShellHook(rc, line, new Date(2026, 8, 30, 12, 0, 0));
    expect(a.changed).toBe(true);
    expect(fs.readFileSync(a.backup!, 'utf8')).toBe('export A=1\nalias ll="ls -l"\n');
    expect(fs.readFileSync(rc, 'utf8')).toBe(`export A=1\nalias ll="ls -l"\n${line}\n`);
    expect(shellHookInstalled(rc)).toBe(true);
    expect(installShellHook(rc, line).changed).toBe(false);
    // 置き場が変わったら、古い行を今の行に置き換える。
    const moved = shellHookLine('/opt/hangar', dir);
    installShellHook(rc, moved, new Date(2026, 8, 30, 12, 0, 1));
    expect(fs.readFileSync(rc, 'utf8')).toBe(`export A=1\nalias ll="ls -l"\n${moved}\n`);
    const u = uninstallShellHook(rc, new Date(2026, 8, 30, 12, 0, 2));
    expect(u.changed).toBe(true);
    expect(fs.readFileSync(rc, 'utf8')).toBe('export A=1\nalias ll="ls -l"\n');
    expect(shellHookInstalled(rc)).toBe(false);
    expect(uninstallShellHook(rc).changed).toBe(false);
  });
  it('~/.zshrc が無ければ作り、控えは取らない', () => {
    const rc = path.join(dir, '.zshrc');
    const r = installShellHook(rc, 'x  # agent-hangar');
    expect(r).toEqual({ changed: true, backup: null });
    expect(fs.readFileSync(rc, 'utf8')).toBe('x  # agent-hangar\n');
  });
});

describe('Windows の包み', () => {
  // Windows では包みを作らない（2026-10-10 の決定）。tmux の役の psmux が実行できても、包めないとする。
  it('Windows では、実行できる tmux の役があっても包めない', () => {
    const exe = path.join(dir, 'psmux.exe'); fs.writeFileSync(exe, '', { mode: 0o755 });
    expect(shellWrapSupported(exe, 'win32')).toBe(false);
    expect(shellWrapSupported(null, 'win32')).toBe(false);
  });
});

// zsh の包み。Windows の包みは次の区切りで作る。
posixDescribe('この PC の状態', () => {
  it('包めなければ unsupported、包めれば行の有無で on と off', () => {
    const rc = path.join(dir, '.zshrc');
    expect(shellHookState(rc, false)).toBe('unsupported');
    expect(shellHookState(rc, true)).toBe('off');
    fs.writeFileSync(rc, `x  ${SHELL_MARKER}\n`);
    expect(shellHookState(rc, true)).toBe('on');
  });
  it('包めるかは、tmux を実行できるかで見る。Claude のバックグラウンドは使わない', () => {
    const ok = path.join(dir, 'tmux'); fs.writeFileSync(ok, '#!/bin/sh\n', { mode: 0o755 });
    const plain = path.join(dir, 'not-exec'); fs.writeFileSync(plain, '', { mode: 0o644 });
    expect(shellWrapSupported(ok)).toBe(true);
    expect(shellWrapSupported(plain)).toBe(false);
    expect(shellWrapSupported(path.join(dir, 'gone'))).toBe(false);
    expect(shellWrapSupported(null)).toBe(false);
  });
  it('入れるコマンドは、PATH の hangar、同梱の hangar の絶対パス、リポジトリの順に選ぶ', () => {
    expect(shellInstallCommand({ hangarOnPath: '/usr/local/bin/hangar', bundledHangar: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar', platform: 'darwin' })).toBe('hangar shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar', platform: 'darwin' })).toBe('/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: '/Applications/My Apps/Hangar.app/bin/hangar', platform: 'darwin' })).toBe('"/Applications/My Apps/Hangar.app/bin/hangar" shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: null, platform: 'darwin' })).toBe('npm run hangar -- shell install');
    // npm run dev のサーバは PATH に node_modules/.bin を持つが、利用者のターミナルからは引けない。
    expect(shellInstallCommand({ hangarOnPath: '/w/agent-hangar/node_modules/.bin/hangar', bundledHangar: null, platform: 'darwin' })).toBe('npm run hangar -- shell install');
  });
  it('Windows では、インストーラで入れた hangar.cmd を、PowerShell にそのまま貼れる形で書く', () => {
    const bundled = 'C:\\Users\\me\\AppData\\Local\\Hangar\\server\\bin\\hangar.cmd';
    // PATH に入っていれば（インストーラが足す）、名前だけで呼ぶ。
    expect(shellInstallCommand({ hangarOnPath: bundled, bundledHangar: bundled, platform: 'win32' })).toBe('hangar shell install');
    // 空白が無ければ、そのまま。
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: bundled, platform: 'win32' })).toBe(`${bundled} shell install`);
    // 空白があれば、PowerShell の呼び出し演算子と単引用符で包む。二重引用符の文字列は PowerShell ではコマンドにならない。
    const spaced = 'C:\\Users\\Taro Yamada\\AppData\\Local\\Hangar\\server\\bin\\hangar.cmd';
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: spaced, platform: 'win32' })).toBe(`& '${spaced}' shell install`);
    // 単引用符は 2 つ重ねる。
    const quoted = "C:\\Users\\O'Brien\\AppData\\Local\\Hangar\\server\\bin\\hangar.cmd";
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: quoted, platform: 'win32' })).toBe("& 'C:\\Users\\O''Brien\\AppData\\Local\\Hangar\\server\\bin\\hangar.cmd' shell install");
    // npm run dev のサーバの PATH の node_modules\.bin は、Windows の区切りでも外す。
    expect(shellInstallCommand({ hangarOnPath: 'C:\\w\\agent-hangar\\node_modules\\.bin\\hangar.cmd', bundledHangar: null, platform: 'win32' })).toBe('npm run hangar -- shell install');
  });
});

const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : null;

/** 偽の hangar の応答。ok はつなぐ先の tmux を返し、refused は理由を付けて断り、down はつながらない。 */
type Hangar = 'ok' | 'refused' | 'down';

/**
 * 包み方の本体を、本物の zsh で疑似端末の上に動かす。
 * 偽の claude、curl、tmux は、呼ばれた引数を 1 行ずつ記録する。curl は受け取った本文も残す。
 */
function runWrapped(args: string, o: { hangar?: Hangar; tty?: boolean; tmux?: 'none' | 'set'; insideTmux?: 'hangar' | 'other'; noWrap?: boolean; subcommands?: string[] } = {}): { calls: string[]; body: { cwd: string; args: string[]; env: Record<string, string> } | null; stderr: string } {
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'calls.log');
  const bodyFile = path.join(dir, 'body.json');
  fs.writeFileSync(log, '');
  fs.rmSync(bodyFile, { force: true });
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'TOKEN-1');
  const fake = (name: string, body: string[]) => { const f = path.join(bin, name); fs.writeFileSync(f, ['#!/bin/sh', `echo "${name} $*" >> "${log}"`, ...body, ''].join('\n'), { mode: 0o755 }); return f; };
  fake('claude', []);
  const reply = o.hangar ?? 'ok';
  fake('curl', [
    `cat > "${bodyFile}"`,
    reply === 'ok' ? `echo '{"run":{"id":"r1","tmuxName":"hangar-0123abcd"},"sessionId":"s1","tabs":[],"attached":false}'` :
      reply === 'refused' ? `echo '{"error":"--agent を付けた起動は hangar では開けません"}'; exit 22` : 'echo "curl: (7) Failed to connect" >&2; exit 7',
  ]);
  const tmuxBin = fake('tmux', []);
  ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile, tmuxPath: o.tmux === 'none' ? null : tmuxBin, subcommands: o.subcommands });
  const tmpdir = path.join(dir, 'tmux-tmp');
  fs.mkdirSync(path.join(tmpdir, `tmux-${process.getuid!()}`), { recursive: true });
  const tmuxEnv = o.insideTmux === 'hangar' ? `${tmpdir}/tmux-${process.getuid!()}/default,1,0` : o.insideTmux === 'other' ? `${tmpdir}/tmux-${process.getuid!()}/mine,1,0` : '';
  const inner = `source ${JSON.stringify(shellScriptPath(home))}; cd ${JSON.stringify(dir)}; claude ${args}`;
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HANGAR_NO_WRAP: o.noWrap ? '1' : '', TMUX: tmuxEnv, TMUX_TMPDIR: tmpdir, AGENT_TEST_FROM_SHELL: 'a b' };
  // script(1) が疑似端末を用意するので、包み方は端末の上で動いていると見る。
  const r = o.tty === false
    ? spawnSync(ZSH!, ['-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync('/usr/bin/script', ['-q', '/dev/null', ZSH!, '-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  const raw = fs.existsSync(bodyFile) ? JSON.parse(fs.readFileSync(bodyFile, 'utf8')) as { cwd: string; args: string; env: string } : null;
  const text = (b: string) => Buffer.from(b, 'base64').toString('utf8');
  const body = raw ? { cwd: text(raw.cwd), args: raw.args === '' ? [] : text(raw.args).split('\0'), env: Object.fromEntries(text(raw.env).replace(/\0$/, '').split('\0').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])) } : null;
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(` ${tmuxBin}`, ' tmux').trimEnd());
  return { calls, body, stderr: (r.stdout ?? '') + (r.stderr ?? '') };
}

const UUID = '480a20da-0b1b-4e20-b8f5-2b5c82124ecb';

describe.skipIf(!ZSH)('包み方の本体（zsh 上）', () => {
  it('書き出した本体は zsh の構文として読める', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: "http://127.0.0.1:4177", tokenFile: "/x/it's/token", tmuxPath: '/opt/homebrew/bin/tmux' });
    const r = spawnSync(ZSH!, ['-n', shellScriptPath(home)], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
  it('対話の起動は hangar に頼み、返ってきた tmux につなぐ。作業ディレクトリ、引数、環境変数を送る', () => {
    const r = runWrapped(`--model opus "直して ください" ''`);
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['curl', 'tmux']);
    expect(r.calls[0]).toContain('--data-binary @-');
    expect(r.calls[0]).toContain('http://127.0.0.1:4177/api/runs/terminal');
    expect(r.calls[0]).toContain('Authorization: Bearer TOKEN-1');
    expect(r.calls[1]).toBe('tmux attach -t =hangar-0123abcd');
    expect(r.body!.cwd).toBe(fs.realpathSync(dir));
    expect(r.body!.args).toEqual(['--model', 'opus', '直して ください', '']);
    expect(r.body!.env.AGENT_TEST_FROM_SHELL).toBe('a b');
  });
  it('引数が無ければ、空の引数として送る', () => {
    expect(runWrapped('').body!.args).toEqual([]);
  });
  it('hangar がつながらなければ、黙って素の claude を起動する', () => {
    const r = runWrapped('--model opus', { hangar: 'down' });
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toMatch(/^curl /);
    expect(r.calls[1]).toBe('claude --model opus');
    expect(r.stderr).not.toContain('hangar');
  });
  it('hangar が断れば、理由を 1 行見せて素の claude を起動する', () => {
    const r = runWrapped('--agent x', { hangar: 'refused' });
    expect(r.calls.at(-1)).toBe('claude --agent x');
    expect(r.stderr).toContain('--agent を付けた起動は hangar では開けません');
  });
  it('サブコマンド、-p、-c、--help などは包まない', () => {
    for (const a of ['mcp list', 'purge /tmp/x -y', '-p hello', '--model opus -p hello', '-c', '--version', '--bg', '--session-id x', '--append-system-prompt x']) {
      expect(runWrapped(a).calls, a).toEqual([`claude ${a}`]);
    }
  });
  it('-- の後ろは引数として見ない', () => {
    expect(runWrapped('-- -p').calls.map((c) => c.split(' ')[0])).toEqual(['curl', 'tmux']);
  });
  it('端末でないとき、HANGAR_NO_WRAP のとき、tmux が無いときは包まない', () => {
    expect(runWrapped('x', { tty: false }).calls).toEqual(['claude x']);
    expect(runWrapped('x', { noWrap: true }).calls).toEqual(['claude x']);
    expect(runWrapped('x', { tmux: 'none' }).calls).toEqual(['claude x']);
  });
  it('-r は id があるときだけ hangar に頼む。id の無い -r と検索の語は選ぶ画面を出すので包まない', () => {
    expect(runWrapped('-r').calls).toEqual(['claude -r']);
    expect(runWrapped('-r 検索の語').calls).toEqual(['claude -r 検索の語']);
    const r = runWrapped(`-r ${UUID}`);
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['curl', 'tmux']);
    expect(r.body!.args).toEqual(['-r', UUID]);
    expect(runWrapped(`--resume=${UUID}`).body!.args).toEqual([`--resume=${UUID}`]);
  });
  it('hangar の tmux の中では入れ子にせず switch-client で移り、ほかの tmux の中では素の claude にする', () => {
    expect(runWrapped('', { insideTmux: 'hangar' }).calls.at(-1)).toBe('tmux switch-client -t =hangar-0123abcd');
    expect(runWrapped('x', { insideTmux: 'other' }).calls).toEqual(['claude x']);
  });
  it('渡したサブコマンドの一覧だけを素通しにする', () => {
    expect(runWrapped('newcmd x', { subcommands: ['newcmd'] }).calls).toEqual(['claude newcmd x']);
    expect(runWrapped('mcp list', { subcommands: ['newcmd'] }).calls.map((c) => c.split(' ')[0])).toEqual(['curl', 'tmux']);
  });
});

describe('包み方の本体のサブコマンドの一覧', () => {
  const caseLine = (home: string) => fs.readFileSync(shellScriptPath(home), 'utf8').split('\n').find((l) => l.endsWith(') command claude "$@"; return ;;'));
  it('渡さなければ組み込みの一覧を書く。daemon と project は書かない', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: null });
    expect(caseLine(home)).toBe('    agents|attach|auth|auto-mode|doctor|gateway|import|install|kill|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|ultrareview|update|upgrade) command claude "$@"; return ;;');
  });
  it('名前の形でないものは書かない。1 つも残らなければ組み込みの一覧を書く', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: null, subcommands: ['b-c', 'a', 'bad;touch x', 'A'] });
    expect(caseLine(home)).toBe('    b-c|a) command claude "$@"; return ;;');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: null, subcommands: ['$(x)'] });
    expect(caseLine(home)).toContain('    agents|attach|');
  });
});
