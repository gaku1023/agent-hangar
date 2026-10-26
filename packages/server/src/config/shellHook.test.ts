import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureShellScript, installShellHook, planShellHook, planShellUnhook, SHELL_MARKER, shellHookInstalled, shellHookLine, shellHookState, shellInstallCommand, shellScriptPath, shellWrapSupported, uninstallShellHook, zshrcPath } from './shellHook.ts';
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
function runWrapped(args: string, o: { hangar?: Hangar; tty?: boolean; tmux?: 'none' | 'set'; insideTmux?: 'hangar' | 'default' | 'other'; noWrap?: boolean; subcommands?: string[]; cmd?: 'claude' | 'opencode' | 'codex'; opencode?: boolean; codex?: boolean; env?: Record<string, string>; mkdirs?: string[] } = {}): { calls: string[]; body: { cwd: string; args: string[]; env: Record<string, string>; agent?: string } | null; stderr: string } {
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
  fake('opencode', []);
  fake('codex', []);
  for (const d of o.mkdirs ?? []) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const reply = o.hangar ?? 'ok';
  fake('curl', [
    `cat > "${bodyFile}"`,
    reply === 'ok' ? `echo '{"run":{"id":"r1","tmuxName":"hangar-0123abcd"},"sessionId":"s1","tabs":[],"attached":false}'` :
      reply === 'refused' ? `echo '{"error":"--agent を付けた起動は hangar では開けません"}'; exit 22` : 'echo "curl: (7) Failed to connect" >&2; exit 7',
  ]);
  const tmuxBin = fake('tmux', []);
  ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile, tmuxPath: o.tmux === 'none' ? null : tmuxBin, subcommands: o.subcommands, opencode: o.opencode === false ? null : {}, codex: o.codex ? {} : null });
  const tmpdir = path.join(dir, 'tmux-tmp');
  fs.mkdirSync(path.join(tmpdir, `tmux-${process.getuid!()}`), { recursive: true });
  const sockets = { hangar: 'hangar', default: 'default', other: 'mine' } as const;
  const tmuxEnv = o.insideTmux ? `${tmpdir}/tmux-${process.getuid!()}/${sockets[o.insideTmux]},1,0` : '';
  const inner = `source ${JSON.stringify(shellScriptPath(home))}; cd ${JSON.stringify(dir)}; ${o.cmd ?? 'claude'} ${args}`;
  // 試験を動かす端末の opencode と XDG の置き場の変数は持ち込まない（持ち込むと opencode の包みが素通しになる）。
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENCODE|CODEX|XDG)_/.test(k)));
  const env = { ...base, PATH: `${bin}:/usr/bin:/bin`, HANGAR_NO_WRAP: o.noWrap ? '1' : '', TMUX: tmuxEnv, TMUX_TMPDIR: tmpdir, AGENT_TEST_FROM_SHELL: 'a b', ...o.env };
  // script(1) が疑似端末を用意するので、包み方は端末の上で動いていると見る。
  const r = o.tty === false
    ? spawnSync(ZSH!, ['-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync('/usr/bin/script', ['-q', '/dev/null', ZSH!, '-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  const raw = fs.existsSync(bodyFile) ? JSON.parse(fs.readFileSync(bodyFile, 'utf8')) as { cwd: string; args: string; env: string; agent?: string } : null;
  const text = (b: string) => Buffer.from(b, 'base64').toString('utf8');
  const body = raw ? { cwd: text(raw.cwd), args: raw.args === '' ? [] : text(raw.args).split('\0'), env: raw.env === '' ? {} : Object.fromEntries(text(raw.env).replace(/\0$/, '').split('\0').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])), ...(raw.agent !== undefined ? { agent: raw.agent } : {}) } : null;
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
    // hangar の専用のサーバ（-L hangar）へつなぐ。
    expect(r.calls[1]).toBe('tmux -L hangar attach -t =hangar-0123abcd');
    expect(r.body!.cwd).toBe(fs.realpathSync(dir));
    expect(r.body!.args).toEqual(['--model', 'opus', '直して ください', '']);
    expect(r.body!.env.AGENT_TEST_FROM_SHELL).toBe('a b');
    // claude の本文には agent を足さない。古いサーバも新しいサーバも Claude Code として読む。
    expect(r.body).not.toHaveProperty('agent');
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
  it('hangar の専用の tmux サーバの中では入れ子にせず switch-client で移り、ほかの tmux の中では素の claude にする', () => {
    expect(runWrapped('', { insideTmux: 'hangar' }).calls.at(-1)).toBe('tmux -L hangar switch-client -t =hangar-0123abcd');
    expect(runWrapped('x', { insideTmux: 'other' }).calls).toEqual(['claude x']);
  });
  it('既定の tmux サーバの中は、ほかの tmux と同じく素の claude にする。入れ子で attach しない', () => {
    expect(runWrapped('x', { insideTmux: 'default' }).calls).toEqual(['claude x']);
  });
  it('渡したサブコマンドの一覧だけを素通しにする', () => {
    expect(runWrapped('newcmd x', { subcommands: ['newcmd'] }).calls).toEqual(['claude newcmd x']);
    expect(runWrapped('mcp list', { subcommands: ['newcmd'] }).calls.map((c) => c.split(' ')[0])).toEqual(['curl', 'tmux']);
  });
});

const OC = 'ses_0123456789abcdefABCDEF';

describe.skipIf(!ZSH)('opencode の包み（zsh 上）', () => {
  const oc = (args: string, o: Parameters<typeof runWrapped>[1] = {}) => runWrapped(args, { cmd: 'opencode', ...o });
  const wrapped = (r: ReturnType<typeof runWrapped>) => r.calls.map((c) => c.split(' ')[0]);
  it('opencode と横取りを入れていなければ、opencode() を書かない', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: '/opt/homebrew/bin/tmux' });
    expect(fs.readFileSync(shellScriptPath(home), 'utf8')).not.toMatch(/function opencode|__agent_hangar_opencode_env/);
    expect(oc('', { opencode: false }).calls).toEqual(['opencode']);
  });
  it('書き出した本体は zsh の構文として読める', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: '/opt/homebrew/bin/tmux', opencode: {} });
    const r = spawnSync(ZSH!, ['-n', shellScriptPath(home)], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // opencode は下ごしらえを待つので、hangar の答えを待つ上限を長くする（claude は 10 秒のまま）。
    expect(fs.readFileSync(shellScriptPath(home), 'utf8')).toContain(`extra=',"agent":"opencode"'; max=90;`);
  });
  it('対話の起動は agent を opencode にして hangar に頼み、返ってきた tmux につなぐ。端末の環境変数は送らない', () => {
    const r = oc('');
    expect(wrapped(r)).toEqual(['curl', 'tmux']);
    expect(r.calls[1]).toBe('tmux -L hangar attach -t =hangar-0123abcd');
    expect(r.body).toEqual({ cwd: fs.realpathSync(dir), args: [], env: {}, agent: 'opencode' });
  });
  it('--auto、--prompt、ディレクトリは写す。値を取るフラグの値をディレクトリやサブコマンドと取り違えない', () => {
    const r = oc(`--auto --prompt "直して ください" sub`, { mkdirs: ['sub'] });
    expect(wrapped(r)).toEqual(['curl', 'tmux']);
    expect(r.body!.args).toEqual(['--auto', '--prompt', '直して ください', 'sub']);
    expect(oc('--prompt run').body!.args).toEqual(['--prompt', 'run']);
    expect(oc('--prompt -c').body!.args).toEqual(['--prompt', '-c']);
    expect(oc('--prompt=run').body!.args).toEqual(['--prompt=run']);
  });
  it('知らないフラグと素通しのフラグが 1 つでもあれば、そのまま渡す', () => {
    for (const a of ['-c', '--continue', '--server http://127.0.0.1:1', '--standalone', '-h', '--help', '-v', '--model x', '--auto=1', '--auto -c', '-- x', '--print-logs', '--prompt']) {
      expect(oc(a).calls, a).toEqual([`opencode ${a}`]);
    }
  });
  it('サブコマンドはそのまま渡す。mini も最初の版は素通し', () => {
    for (const a of ['run hello', 'serve', 'auth login', 'mini', 'models', '--auto run x']) {
      expect(oc(a).calls, a).toEqual([`opencode ${a}`]);
    }
  });
  it('ディレクトリでない位置引数（知らないサブコマンドなど）と、2 つ目のディレクトリは、そのまま渡す', () => {
    expect(oc('newcmd').calls).toEqual(['opencode newcmd']);
    expect(oc('a b', { mkdirs: ['a', 'b'] }).calls).toEqual(['opencode a b']);
  });
  it('-s は会話の ID の形なら hangar に頼み、形でなければそのまま渡す', () => {
    const r = oc(`-s ${OC}`);
    expect(wrapped(r)).toEqual(['curl', 'tmux']);
    expect(r.body!.args).toEqual(['-s', OC]);
    expect(oc(`--session=${OC} --prompt hi`).body!.args).toEqual([`--session=${OC}`, '--prompt', 'hi']);
    expect(oc('-s さっきの').calls).toEqual(['opencode -s さっきの']);
    expect(oc('-s').calls).toEqual(['opencode -s']);
  });
  it('hangar の会話でない -s は、hangar が断るので、理由を 1 行見せて素の opencode を起動する', () => {
    const r = oc(`-s ${OC}`, { hangar: 'refused' });
    expect(r.calls.at(-1)).toBe(`opencode -s ${OC}`);
    expect(r.stderr).toContain('通常の opencode を起動します');
  });
  it('hangar がつながらなければ、黙って素の opencode を起動する', () => {
    const r = oc('--auto', { hangar: 'down' });
    expect(r.calls.at(-1)).toBe('opencode --auto');
    expect(r.stderr).not.toContain('hangar');
  });
  it('OPENCODE_ で始まる変数が環境にあれば、そのまま渡す', () => {
    expect(oc('', { env: { OPENCODE_CONFIG: '/x/opencode.json' } }).calls).toEqual(['opencode']);
    expect(oc('', { env: { OPENCODE_PASSWORD: '' } }).calls).toEqual(['opencode']);
  });
  it('XDG の置き場を既定と違う場所にしていれば、そのまま渡す。既定と同じ場所と、置き場でない XDG の変数は包む', () => {
    const home = process.env.HOME!;
    expect(oc('', { env: { XDG_DATA_HOME: '/elsewhere/data' } }).calls).toEqual(['opencode']);
    expect(oc('', { env: { XDG_CONFIG_HOME: '/elsewhere/config' } }).calls).toEqual(['opencode']);
    expect(wrapped(oc('', { env: { XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${home}/.local/share` } }))).toEqual(['curl', 'tmux']);
    expect(wrapped(oc('', { env: { XDG_RUNTIME_DIR: '/run/user/1000', XDG_SESSION_TYPE: 'tty' } }))).toEqual(['curl', 'tmux']);
  });
  it('端末でないとき、HANGAR_NO_WRAP のとき、tmux が無いときは包まない', () => {
    expect(oc('x', { tty: false }).calls).toEqual(['opencode x']);
    expect(oc('x', { noWrap: true }).calls).toEqual(['opencode x']);
    expect(oc('x', { tmux: 'none' }).calls).toEqual(['opencode x']);
  });
  it('hangar の専用の tmux サーバの中では switch-client で移り、ほかの tmux の中では素の opencode にする', () => {
    expect(oc('', { insideTmux: 'hangar' }).calls.at(-1)).toBe('tmux -L hangar switch-client -t =hangar-0123abcd');
    expect(oc('', { insideTmux: 'other' }).calls).toEqual(['opencode']);
  });
  it('opencode の包みを書いても、claude の包みは変わらない', () => {
    const r = runWrapped('--model opus');
    expect(wrapped(r)).toEqual(['curl', 'tmux']);
    expect(r.body).not.toHaveProperty('agent');
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

describe('planShellHook と planShellUnhook（書く中身だけを決め、書かない）', () => {
  const line = `[ -f "$HOME/.agent-hangar/shell/claude.zsh" ] && source "$HOME/.agent-hangar/shell/claude.zsh"  ${SHELL_MARKER}`;
  it('末尾に 1 行を足し、古い行は置き換え、今の形なら null', () => {
    expect(planShellHook('export A=1\n', line)).toBe(`export A=1\n${line}\n`);
    expect(planShellHook(null, line)).toBe(`${line}\n`);
    expect(planShellHook(`export A=1\nold ${SHELL_MARKER}\nexport B=2\n`, line)).toBe(`export A=1\nexport B=2\n${line}\n`);
    expect(planShellHook(`export A=1\n${line}\n`, line)).toBeNull();
  });
  it('外すのは目印の行だけで、入っていなければ null', () => {
    expect(planShellUnhook(`export A=1\n${line}\n`)).toBe('export A=1\n');
    expect(planShellUnhook('export A=1\n')).toBeNull();
    expect(planShellUnhook(null)).toBeNull();
  });
});

describe('UTF-8 でない ~/.zshrc', () => {
  it('UTF-16 の ~/.zshrc には足さず、外すときも触らない', () => {
    const zshrc = path.join(dir, '.zshrc');
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`export A=1\n${SHELL_MARKER} x\n`, 'utf16le')]);
    fs.writeFileSync(zshrc, bytes);
    expect(installShellHook(zshrc, `source x ${SHELL_MARKER}`)).toEqual({ changed: false, backup: null });
    expect(uninstallShellHook(zshrc)).toEqual({ changed: false, backup: null });
    expect(fs.readFileSync(zshrc).equals(bytes)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('UTF-8 の BOM 付きは、BOM を先頭に保ったまま末尾に足し、外すと元に戻る', () => {
    const zshrc = path.join(dir, '.zshrc');
    const src = '﻿export A=1\n';
    fs.writeFileSync(zshrc, src);
    const line = `source x ${SHELL_MARKER}`;
    expect(installShellHook(zshrc, line).changed).toBe(true);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe(`${src}${line}\n`);
    expect(uninstallShellHook(zshrc).changed).toBe(true);
    expect(fs.readFileSync(zshrc, 'utf8')).toBe(src);
  });
});

const CX = '01bffff0-0000-7000-8000-00000000e001';

describe.skipIf(!ZSH)('codex の包み（zsh 上）', () => {
  const cx = (args: string, o: Parameters<typeof runWrapped>[1] = {}) => runWrapped(args, { cmd: 'codex', codex: true, ...o });
  const wrapped = (r: ReturnType<typeof runWrapped>) => r.calls.map((c) => c.split(' ')[0]);
  it('codex と横取りを入れていなければ、codex() を書かない', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: '/opt/homebrew/bin/tmux', opencode: {} });
    expect(fs.readFileSync(shellScriptPath(home), 'utf8')).not.toMatch(/function codex|__agent_hangar_codex_env/);
    expect(cx('', { codex: false }).calls).toEqual(['codex']);
  });
  it('書き出した本体は zsh の構文として読め、hangar の答えを待つ上限を長くする', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: '/opt/homebrew/bin/tmux', codex: {} });
    const r = spawnSync(ZSH!, ['-n', shellScriptPath(home)], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(shellScriptPath(home), 'utf8')).toContain(`extra=',"agent":"codex"'; max=90;`);
  });
  it('素通しのサブコマンドの一覧は codex 0.164.0 の --help のとおりで、resume と fork 以外は全部入っている', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: '/opt/homebrew/bin/tmux', codex: {} });
    const body = fs.readFileSync(shellScriptPath(home), 'utf8');
    const line = body.split('\n').find((l) => l.includes(') command codex "$@"; return ;;'))!;
    const subs = line.trim().split(')')[0]!.split('|');
    for (const s of ['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'fork', 'cloud', 'exec-server', 'features', 'help']) expect(subs, s).toContain(s);
    expect(subs).not.toContain('resume');
  });
  it('対話の起動は agent を codex にして hangar に頼み、返ってきた tmux につなぐ。端末の環境変数は送らない', () => {
    const r = cx('');
    expect(wrapped(r)).toEqual(['curl', 'tmux']);
    expect(r.calls[1]).toBe('tmux -L hangar attach -t =hangar-0123abcd');
    expect(r.body).toEqual({ cwd: fs.realpathSync(dir), args: [], env: {}, agent: 'codex' });
  });
  it('プロンプト、-m、-c、-s、-a は写す。値を取るフラグの値をサブコマンドやプロンプトと取り違えない', () => {
    const r = cx(`-m gpt-x -c model_reasoning_effort=high -s read-only -a on-request "直して ください"`);
    expect(wrapped(r)).toEqual(['curl', 'tmux']);
    expect(r.body!.args).toEqual(['-m', 'gpt-x', '-c', 'model_reasoning_effort=high', '-s', 'read-only', '-a', 'on-request', '直して ください']);
    expect(cx('-m exec').body!.args).toEqual(['-m', 'exec']);
    expect(cx('--model=gpt-x --sandbox=read-only').body!.args).toEqual(['--model=gpt-x', '--sandbox=read-only']);
    expect(cx('-m -s').body!.args).toEqual(['-m', '-s']);
  });
  it('サブコマンドはそのまま渡す', () => {
    for (const a of ['exec hello', 'e hello', 'login', 'logout', 'mcp list', 'app-server', 'debug', 'apply', 'cloud', 'completion zsh', 'help', 'fork', '-m x exec y', 'review']) {
      expect(cx(a).calls, a).toEqual([`codex ${a}`]);
    }
  });
  it('知らないフラグ、--version、--help、2 つ目のプロンプトは、そのまま渡す', () => {
    for (const a of ['--version', '-V', '--help', '-h', '--oss', '-C /tmp', '--search', '--no-alt-screen', '-p x', '--dangerously-bypass-approvals-and-sandbox', '-- x', 'a b', '-m', '-c']) {
      expect(cx(a).calls, a).toEqual([`codex ${a}`]);
    }
  });
  it('resume は ID（UUID）が 1 つのときだけ hangar に頼み、ID なし・--last・名前・ほかの語つきはそのまま渡す', () => {
    const r = cx(`resume ${CX}`);
    expect(wrapped(r)).toEqual(['curl', 'tmux']);
    expect(r.body!.args).toEqual(['resume', CX]);
    expect(cx(`-m x resume ${CX} -s read-only`).body!.args).toEqual(['-m', 'x', 'resume', CX, '-s', 'read-only']);
    for (const a of ['resume', 'resume --last', 'resume さっきの', `resume ${CX} もう 1 つ`]) expect(cx(a).calls, a).toEqual([`codex ${a}`]);
  });
  it('hangar が断れば、理由を 1 行見せて素の codex を起動する。つながらなければ黙って素の codex', () => {
    const refused = cx(`resume ${CX}`, { hangar: 'refused' });
    expect(refused.calls.at(-1)).toBe(`codex resume ${CX}`);
    expect(refused.stderr).toContain('通常の codex を起動します');
    const down = cx('-m x', { hangar: 'down' });
    expect(down.calls.at(-1)).toBe('codex -m x');
    expect(down.stderr).not.toContain('hangar');
  });
  it('端末でないとき、HANGAR_NO_WRAP を立てたとき、tmux が無いときは包まない。CODEX_ で始まる変数が環境にあっても包まない', () => {
    expect(cx('', { tty: false }).calls).toEqual(['codex']);
    expect(cx('', { noWrap: true }).calls).toEqual(['codex']);
    expect(cx('', { tmux: 'none' }).calls).toEqual(['codex']);
    expect(cx('', { env: { CODEX_HOME: '/x/codex' } }).calls).toEqual(['codex']);
  });
  it('入れ子の tmux の扱いは claude と同じ。hangar の tmux の中なら switch-client、ほかの tmux の中なら素の codex', () => {
    expect(cx('', { insideTmux: 'hangar' }).calls.at(-1)).toBe('tmux -L hangar switch-client -t =hangar-0123abcd');
    expect(cx('', { insideTmux: 'other' }).calls).toEqual(['codex']);
  });
});
