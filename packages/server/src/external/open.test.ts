import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, openDirInTerminalApp, openInEditor, openInTerminalApp, writeAttachCommand, writeCdCommand, type Exec } from './open.ts';

let home: string;
let calls: { cmd: string; args: string[] }[];
const exec =
  (results: Record<string, number> = {}): Exec =>
  async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: results[cmd] ?? 0, stdout: '', stderr: '' };
  };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ext-'));
  calls = [];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('.command ファイル', () => {
  it('attach 用と cd 用を実行可能で書く', () => {
    const a = writeAttachCommand(home, '/opt/homebrew/bin/tmux', 'hangar-ab12cd34');
    expect(a).toBe(path.join(home, 'cmd', 'attach-hangar-ab12cd34.command'));
    expect(fs.statSync(a).mode & 0o777).toBe(0o755);
    // target は完全一致にする。素の名前だと tmux が前方一致で別のセッションに繋ぐ。
    expect(fs.readFileSync(a, 'utf8')).toBe("#!/usr/bin/env bash\n'/opt/homebrew/bin/tmux' attach -t '=hangar-ab12cd34'\nexit\n");
    const c = writeCdCommand(home, "/Users/me/work space/it's");
    expect(fs.readFileSync(c, 'utf8')).toBe('#!/usr/bin/env bash\ncd \'/Users/me/work space/it\'\\\'\'s\' && exec "${SHELL:-/bin/zsh}" -l\nexit\n');
  });
});

describe('openInTerminalApp', () => {
  it('terminal は open -g -a Terminal で .command を開く', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'terminal', exec: exec() });
    expect(r).toEqual({ app: 'terminal', fellBack: false });
    expect(calls).toEqual([{ cmd: 'open', args: ['-g', '-a', 'Terminal', path.join(home, 'cmd', 'attach-hangar-x.command')] }]);
  });
  it('iterm は osascript を 10 秒のタイムアウト付きで呼ぶ', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'iterm', exec: exec() });
    expect(r).toEqual({ app: 'iterm', fellBack: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('osascript');
    const script = calls[0]!.args[1]!;
    expect(script).toContain('with timeout of 10 seconds');
    expect(script).toContain('tell application "iTerm"');
    expect(script).toContain(`create window with default profile command "'/t/tmux' attach -t '=hangar-x'"`);
  });
  it('iterm に渡すコマンドも tmux のパスと名前を引用符で包む', async () => {
    // 設定から来る tmuxPath にスペースや ; や $() が混じっても、シェルの意味を持たせない。
    const tmuxPath = "/o p t/tmux; echo pwned $(id) `id`";
    const tmuxName = "hangar-x'; echo pwned #";
    await openInTerminalApp({ home, tmuxPath, tmuxName, app: 'iterm', exec: exec() });
    const script = calls[0]!.args[1]!;
    const command = JSON.parse(script.split('create window with default profile command ')[1]!.split('\n')[0]!) as string;
    expect(command).toBe("'/o p t/tmux; echo pwned $(id) `id`' attach -t '=hangar-x'\\''; echo pwned #'");
    // 実際のシェルに語へ分けさせ、置換も追加のコマンドも起きないことを確かめる。
    const words = execFileSync('/bin/bash', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
    expect(words.split('\n').slice(0, -1)).toEqual([tmuxPath, 'attach', '-t', `=${tmuxName}`]);
  });
  it('iterm が失敗したら Terminal.app に落とす', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'iterm', exec: exec({ osascript: 1 }) });
    expect(r).toEqual({ app: 'terminal', fellBack: true });
    expect(calls.map((c) => c.cmd)).toEqual(['osascript', 'open']);
  });
  it('open が失敗したら投げる', async () => {
    await expect(openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', app: 'terminal', exec: exec({ open: 1 }) })).rejects.toThrow(/Terminal/);
  });
  it('ディレクトリを開く経路も同じ', async () => {
    const r = await openDirInTerminalApp({ home, dir: '/w/alpha', app: 'terminal', exec: exec() });
    expect(r.app).toBe('terminal');
    expect(fs.readFileSync(calls[0]!.args[3]!, 'utf8')).toContain("cd '/w/alpha'");
  });
});

describe('writeAttachCommand のファイル名', () => {
  it('ファイル名に使えない名前はハッシュにして cmd/ の外に出さない', () => {
    const f = writeAttachCommand(home, '/t/tmux', '../../evil');
    expect(path.dirname(f)).toBe(path.join(home, 'cmd'));
    expect(path.basename(f)).toMatch(/^attach-[0-9a-f]{8}\.command$/);
    expect(fs.readFileSync(f, 'utf8')).toBe("#!/usr/bin/env bash\n'/t/tmux' attach -t '=../../evil'\nexit\n");
  });
});

describe('execFile', () => {
  it('終了コードを返し、投げない', async () => {
    expect(await execFile(process.execPath, ['-e', 'process.stdout.write("o"); process.stderr.write("e")'])).toEqual({ code: 0, stdout: 'o', stderr: 'e' });
    expect((await execFile(process.execPath, ['-e', 'process.exit(3)'])).code).toBe(3);
  });
  it('起動できないときとタイムアウトは code 1 にする', async () => {
    expect((await execFile(path.join(home, 'no-such-command'), [])).code).toBe(1);
    expect((await execFile(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 500 })).code).toBe(1);
  });
});

describe('openInEditor', () => {
  it('code <target> を呼ぶ。codePath が無ければ投げる', async () => {
    await openInEditor({ codePath: '/usr/local/bin/code', target: '/w/alpha', exec: exec() });
    expect(calls).toEqual([{ cmd: '/usr/local/bin/code', args: ['/w/alpha'] }]);
    await expect(openInEditor({ codePath: null, target: '/w', exec: exec() })).rejects.toThrow(/codePath/);
    await expect(openInEditor({ codePath: '/x/code', target: '/w', exec: exec({ '/x/code': 2 }) })).rejects.toThrow(/VS Code/);
  });
});
