import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSupportsBackground, ensureShellScript, installShellHook, SHELL_MARKER, shellHookInstalled, shellHookLine, shellHookState, shellInstallCommand, shellScriptPath, uninstallShellHook, zshrcPath } from './shellHook.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-shell-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('~/.zshrc の 1 行', () => {
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

describe('この PC の状態', () => {
  it('バックグラウンドを使えなければ unsupported、使えれば行の有無で on と off', () => {
    const rc = path.join(dir, '.zshrc');
    expect(shellHookState(rc, false)).toBe('unsupported');
    expect(shellHookState(rc, true)).toBe('off');
    fs.writeFileSync(rc, `x  ${SHELL_MARKER}\n`);
    expect(shellHookState(rc, true)).toBe('on');
  });
  it('claude agents --json が通るかでバックグラウンドを使えるかを見る', () => {
    const ok = path.join(dir, 'ok'); fs.writeFileSync(ok, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
    const off = path.join(dir, 'off'); fs.writeFileSync(off, '#!/bin/sh\necho disabled >&2; exit 1\n', { mode: 0o755 });
    expect(claudeSupportsBackground(ok)).toBe(true);
    expect(claudeSupportsBackground(off)).toBe(false);
    expect(claudeSupportsBackground(null)).toBe(false);
  });
  it('入れるコマンドは、PATH の hangar、同梱の hangar の絶対パス、リポジトリの順に選ぶ', () => {
    expect(shellInstallCommand({ hangarOnPath: '/usr/local/bin/hangar', bundledHangar: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar' })).toBe('hangar shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar' })).toBe('/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: '/Applications/My Apps/Hangar.app/bin/hangar' })).toBe('"/Applications/My Apps/Hangar.app/bin/hangar" shell install');
    expect(shellInstallCommand({ hangarOnPath: null, bundledHangar: null })).toBe('npm run hangar -- shell install');
    // npm run dev のサーバは PATH に node_modules/.bin を持つが、利用者のターミナルからは引けない。
    expect(shellInstallCommand({ hangarOnPath: '/w/agent-hangar/node_modules/.bin/hangar', bundledHangar: null })).toBe('npm run hangar -- shell install');
  });
});

const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : null;

/**
 * 包み方の本体を、本物の zsh で疑似端末の上に動かす。
 * 偽の claude は受け取った引数を 1 行ずつ記録し、--bg と agents には決まった出力を返す。
 * --bg が返す id は、tmux の上で hangar-run.sh … attach <id> を動かす manager のテストと重ならないものにする。重なると hangar が開いていると見てしまう。
 */
function runWrapped(args: string, o: { bgFails?: boolean; agents?: string; tty?: boolean; input?: string; hangarOpen?: string; transcript?: string } = {}): string[] {
  const home = path.join(dir, 'home');
  ensureShellScript(home);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'agents.json'), o.agents ?? '[]\n');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    `echo "[$*]" >> "${log}"`,
    'case "$1" in',
    `  --bg) ${o.bgFails ? 'echo "Workspace not trusted." >&2; exit 1' : 'echo "Starting background service…" >&2; echo "backgrounded · 5e11600c (idle — send a prompt to start)"; echo "  claude agents             list sessions"'} ;;`,
    `  agents) cat "${path.join(dir, 'agents.json')}" ;;`,
    '  stop) echo "stopped $2" ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const config = path.join(dir, 'claude-config');
  if (o.transcript) {
    fs.mkdirSync(path.join(config, 'projects', '-x'), { recursive: true });
    fs.writeFileSync(path.join(config, 'projects', '-x', `${o.transcript}.jsonl`), '{}\n');
  }
  // hangar が開いているセッションは、hangar-run.sh の下の claude attach <id> として見える。
  let hangar: ChildProcess | null = null;
  if (o.hangarOpen) {
    const runner = path.join(dir, 'hangar-run.sh');
    fs.writeFileSync(runner, 'sleep 30\n');
    hangar = spawn('/bin/sh', [runner, path.join(dir, 'run.log'), '/x/claude', 'attach', o.hangarOpen], { stdio: 'ignore' });
  }
  const inner = `source ${JSON.stringify(shellScriptPath(home))}; claude ${args}`;
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HANGAR_NO_WRAP: '', CLAUDE_CONFIG_DIR: config, HANGAR_TEST_INNER: inner, HANGAR_TEST_INPUT: o.input ?? '', HANGAR_TEST_LOG: log, HANGAR_TEST_ZSH: ZSH! };
  // script(1) が疑似端末を用意するので、包み方は端末の上で動いていると見る。
  // 尋ねられる場面では、attach から抜けた後に状態を引くまで待ってから input を打つ。先に打つと read -q が始まるときに捨てられる。
  // script(1) は node の pipe（ソケット）を標準入力に取れないので、sh のパイプで渡す。
  const typed = [
    '(i=0; until awk \'/^\\[attach/ { a = 1 } a && /^\\[agents --json\\]/ { f = 1 } END { exit !f }\' "$HANGAR_TEST_LOG" || [ $i -ge 100 ]; do sleep 0.05; i=$((i + 1)); done',
    '; sleep 0.3; printf %s "$HANGAR_TEST_INPUT")',
    ' | /usr/bin/script -q /dev/null "$HANGAR_TEST_ZSH" -f -c "$HANGAR_TEST_INNER"',
  ].join('');
  try {
    const r = o.tty === false
      ? spawnSync(ZSH!, ['-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : o.input !== undefined
        ? spawnSync('/bin/sh', ['-c', typed], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        : spawnSync('/usr/bin/script', ['-q', '/dev/null', ZSH!, '-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) throw r.error;
  } finally {
    hangar?.kill();
  }
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.slice(1, -1));
}

const UUID = '480a20da-0b1b-4e20-b8f5-2b5c82124ecb';
const agentsWith = (kind: string) => `[\n  {\n    "id": "480a20da",\n    "cwd": "/x",\n    "kind": "${kind}",\n    "sessionId": "${UUID}",\n    "state": "blocked"\n  }\n]\n`;

/** `claude agents --json` の 1 件。動いているものにだけ pid と status が付く。 */
const job = (o: { id: string; sessionId: string; state: string; status?: string; pid?: number; kind?: string }) => [
  '  {',
  ...(o.pid ? [`    "pid": ${o.pid},`] : []),
  `    "id": "${o.id}",`,
  '    "cwd": "/x",',
  `    "kind": "${o.kind ?? 'background'}",`,
  `    "sessionId": "${o.sessionId}",`,
  `    "name": "${o.id}",`,
  ...(o.status ? [`    "status": "${o.status}",`] : []),
  `    "state": "${o.state}"`,
  '  }',
].join('\n');
const agentsOf = (...jobs: string[]) => `[\n${jobs.join(',\n')}\n]\n`;
const NEW_SID = '5e11600c-0000-4000-8000-000000000000';
const launched = (state: string, status = 'idle') => agentsOf(job({ id: '5e11600c', sessionId: NEW_SID, state, status, pid: 42 }));

describe.skipIf(!ZSH)('包み方の本体（zsh 上）', () => {
  it('対話の起動は --bg で起こし、出てきた id に attach する。引数はそのまま渡す', () => {
    expect(runWrapped('')).toEqual(['--bg', 'attach 5e11600c', 'agents --json']);
    expect(runWrapped('--model opus "直して"')).toEqual(['--bg --model opus 直して', 'attach 5e11600c', 'agents --json']);
  });
  it('サブコマンド、-p、-c、--help などは包まない', () => {
    expect(runWrapped('mcp list')).toEqual(['mcp list']);
    expect(runWrapped('-p hello')).toEqual(['-p hello']);
    expect(runWrapped('--model opus -p hello')).toEqual(['--model opus -p hello']);
    expect(runWrapped('-c')).toEqual(['-c']);
    expect(runWrapped('--version')).toEqual(['--version']);
  });
  it('端末でなければ包まない', () => {
    expect(runWrapped('', { tty: false })).toEqual(['']);
  });
  it('--bg が失敗したら素の claude を起こす', () => {
    expect(runWrapped('', { bgFails: true })).toEqual(['--bg', '']);
  });
  it('-r は id があるときだけ包み、バックグラウンドで動いていれば attach だけにする', () => {
    expect(runWrapped('-r')).toEqual(['-r']);
    expect(runWrapped('-r 検索の語')).toEqual(['-r 検索の語']);
    expect(runWrapped(`-r ${UUID}`)).toEqual(['agents --json', `--bg -r ${UUID}`, 'attach 5e11600c', 'agents --json']);
    expect(runWrapped(`--resume ${UUID}`, { agents: agentsWith('background') })).toEqual(['agents --json', 'attach 480a20da', 'agents --json']);
    // 別のターミナルで動く対話の claude は素の claude に任せる。二重に開かないよう Claude が断る。
    expect(runWrapped(`-r ${UUID}`, { agents: agentsWith('interactive') })).toEqual(['agents --json', `-r ${UUID}`]);
  });
});

describe.skipIf(!ZSH)('抜けたときの後始末（zsh 上）', () => {
  it('答え終えて次の指示を待っているセッションは、黙って止める', () => {
    expect(runWrapped('', { agents: launched('done') })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
  });
  it('hangar が同じセッションを開いていれば、状態を見ずに残す', () => {
    expect(runWrapped('', { agents: launched('done'), hangarOpen: '5e11600c' })).toEqual(['--bg', 'attach 5e11600c']);
  });
  it('hangar が開いているのが別のセッションなら、判定に入れない', () => {
    expect(runWrapped('', { agents: launched('done'), hangarOpen: 'ffff0000' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
  });
  it('作業中なら尋ね、y なら止め、それ以外なら残す', () => {
    expect(runWrapped('', { agents: launched('working', 'busy'), input: 'y' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
    expect(runWrapped('', { agents: launched('working', 'busy'), input: 'n' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json']);
    expect(runWrapped('', { agents: launched('working', 'busy'), input: '\r' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json']);
  });
  it('許可や質問への答えを待っているセッションは、作業中と同じく尋ねる', () => {
    expect(runWrapped('', { agents: launched('blocked'), transcript: NEW_SID, input: 'y' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
    expect(runWrapped('', { agents: launched('blocked'), transcript: NEW_SID, input: 'n' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json']);
  });
  it('何も打たずに抜けたセッション（本文がまだ無い）は、入力待ちでも黙って止める', () => {
    expect(runWrapped('', { agents: launched('blocked') })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
  });
  it('もう止まっている（pid が無い）セッションには何もしない', () => {
    expect(runWrapped('', { agents: agentsOf(job({ id: '5e11600c', sessionId: NEW_SID, state: 'done' })) })).toEqual(['--bg', 'attach 5e11600c', 'agents --json']);
  });
  it('-r で attach だけにしたときも、抜けたら同じように後始末する', () => {
    const agents = agentsOf(job({ id: '480a20da', sessionId: UUID, state: 'done', status: 'idle', pid: 7 }));
    expect(runWrapped(`-r ${UUID}`, { agents })).toEqual(['agents --json', 'attach 480a20da', 'agents --json', 'stop 480a20da']);
  });
});
