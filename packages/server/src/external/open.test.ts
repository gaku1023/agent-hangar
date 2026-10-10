import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdQuote, execFile, openDirInTerminalApp, openInEditor, openInTerminalApp, writeAttachCommand, writeCdCommand, type Exec } from './open.ts';
import { expectMode, posixIt } from '../../test/platform.ts';

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
    expectMode(a, 0o755);
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
  // bash で引用を確かめる。Windows Terminal への受け渡しは次の区切りで作る。
  posixIt('iterm に渡すコマンドも tmux のパスと名前を引用符で包む', async () => {
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
  it('ディレクトリを開くとき、iterm と .command は同じ shell の決め方を使う', async () => {
    // 同じ操作なのに経路で違う shell が立ち上がらないようにする。
    // $SHELL を見て、無ければ同じ既定に落ちる。引用符で包んでパスの空白でも割れないようにする。
    await openDirInTerminalApp({ home, dir: '/w/alpha', app: 'iterm', exec: exec() });
    const script = calls[0]!.args[1]!;
    const command = JSON.parse(script.split('create window with default profile command ')[1]!.split('\n')[0]!) as string;
    expect(command).toBe(`cd '/w/alpha' && exec "\${SHELL:-/bin/zsh}" -l`);
    expect(fs.readFileSync(writeCdCommand(home, '/w/alpha'), 'utf8')).toBe(`#!/usr/bin/env bash\n${command}\nexit\n`);
  });
});

// Windows の 2 つの経路。フェイクの exec で、起こすコマンドと引数だけを確かめる。
describe('openInTerminalApp（Windows）', () => {
  const PSMUX = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  type Seen = { cmd: string; args: string[]; verbatim: boolean | undefined };
  let seen: Seen[];
  const winExec =
    (results: Record<string, number> = {}): Exec =>
    async (cmd, args, opts) => {
      seen.push({ cmd, args, verbatim: opts?.verbatim });
      return { code: results[cmd] ?? 0, stdout: '', stderr: '' };
    };
  beforeEach(() => { seen = []; });

  it('Windows Terminal は wt.exe の新しいタブで、完全一致の名前に attach する', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-ab12cd34', app: 'windowsTerminal', exec: winExec() });
    expect(r).toEqual({ app: 'windowsTerminal', fellBack: false });
    // 引数は配列のまま渡す。空白や日本語の引用は Node が Windows の規則で付ける。
    expect(seen).toEqual([{ cmd: 'wt.exe', args: ['-w', '0', 'new-tab', '--', PSMUX, 'attach', '-t', '=hangar-ab12cd34'], verbatim: undefined }]);
    // 何もファイルを書かない。
    expect(fs.existsSync(path.join(home, 'cmd'))).toBe(false);
  });
  it('Windows Terminal に渡す空白と日本語の名前は 1 つの引数のまま、; は wt の区切りにならないよう \\; にする', async () => {
    await openInTerminalApp({ home, tmuxPath: 'C:\\Program Files\\psmux\\psmux.exe', tmuxName: '作業 1;2', app: 'windowsTerminal', exec: winExec() });
    expect(seen[0]!.args).toEqual(['-w', '0', 'new-tab', '--', 'C:\\Program Files\\psmux\\psmux.exe', 'attach', '-t', '=作業 1\\;2']);
  });
  it('既定のターミナルは cmd /c start で新しい窓を開き、パスと名前を二重引用符で包む', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: 'C:\\Program Files\\psmux\\psmux.exe', tmuxName: '日本語 の セッション', app: 'windowsDefault', exec: winExec() });
    expect(r).toEqual({ app: 'windowsDefault', fellBack: false });
    // start の最初の引用は窓の題名と読まれるので、空の "" を先に置く。
    // 引数は Node に引用させず、そのまま cmd.exe に渡す（Node の \" は cmd.exe に通じない）。
    expect(seen).toEqual([{
      cmd: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '"start "" "C:\\Program Files\\psmux\\psmux.exe" attach -t "=日本語 の セッション""'],
      verbatim: true,
    }]);
  });
  it('既定のターミナルでは、cmd.exe が引用符の中でも読む % を引用の外へ出して ^ で消す', async () => {
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'a%PATH%b & c', app: 'windowsDefault', exec: winExec() });
    expect(seen[0]!.args[4]).toBe(`"start "" "${PSMUX}" attach -t "=a"^%"PATH"^%"b & c""`);
  });
  it('Windows Terminal が無ければ既定のターミナルに落とし、落ちたことを返す', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', app: 'windowsTerminal', exec: winExec({ 'wt.exe': 1 }) });
    expect(r).toEqual({ app: 'windowsDefault', fellBack: true });
    expect(seen.map((c) => c.cmd)).toEqual(['wt.exe', 'cmd.exe']);
  });
  it('既定のターミナルも開けなければ投げる', async () => {
    await expect(openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', app: 'windowsDefault', exec: winExec({ 'cmd.exe': 1 }) })).rejects.toThrow(/既定のターミナル/);
  });
  // " は Windows のファイル名に使えず、どちらの経路でも引用を破る。開けるふりをして別のものを起こさないよう、断る。
  it('" や改行を含む名前とパスは、起こさずに断る', async () => {
    await expect(openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'a" & calc & "', app: 'windowsDefault', exec: winExec() })).rejects.toThrow(/開けません/);
    await expect(openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'a\nb', app: 'windowsTerminal', exec: winExec() })).rejects.toThrow(/開けません/);
    expect(seen).toEqual([]);
  });
  it('フォルダを開くとき、Windows Terminal は -d でそのフォルダの新しいタブを開く', async () => {
    const r = await openDirInTerminalApp({ home, dir: 'D:\\work space\\日本語', app: 'windowsTerminal', exec: winExec() });
    expect(r).toEqual({ app: 'windowsTerminal', fellBack: false });
    expect(seen).toEqual([{ cmd: 'wt.exe', args: ['-w', '0', 'new-tab', '-d', 'D:\\work space\\日本語'], verbatim: undefined }]);
  });
  it('フォルダを開くとき、既定のターミナルは start /D でそのフォルダの PowerShell を開く', async () => {
    await openDirInTerminalApp({ home, dir: 'D:\\work space\\日本語\\', app: 'windowsDefault', exec: winExec() });
    // 末尾の \ は取る。"…\" の \" を引用の終わりと読み違える道具がある。
    expect(seen).toEqual([{ cmd: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', '"start "" /D "D:\\work space\\日本語" powershell.exe -NoLogo"'], verbatim: true }]);
  });
  it('ドライブの直下は末尾の \\ を残す', async () => {
    await openDirInTerminalApp({ home, dir: 'C:\\', app: 'windowsDefault', exec: winExec() });
    expect(seen[0]!.args[4]).toBe('"start "" /D "C:\\" powershell.exe -NoLogo"');
  });
});

// 引用の組み立てを、実物の cmd.exe に読ませて確かめる。start の代わりに node を起こし、受け取った引数を見る。
describe.skipIf(process.platform !== 'win32')('cmd.exe の引用（実物）', () => {
  it('空白、日本語、%、& を含む引数が、そのままの 1 つの引数として届く', async () => {
    const script = path.join(home, 'argv.cjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const words = ['=日本語 の セッション', 'a%PATH%b & c', 'x^y|z<w>(v)'];
    const r = await execFile('cmd.exe', ['/d', '/v:off', '/s', '/c', `"${[process.execPath, script, ...words].map(cmdQuote).join(' ')}"`], { verbatim: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(words);
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
    await expect(openInEditor({ codePath: null, target: '/w', exec: exec() })).rejects.toThrow('VS Code の code コマンドが見つかりません。設定の「code のパス」を入力してください');
    await expect(openInEditor({ codePath: '/x/code', target: '/w', exec: exec({ '/x/code': 2 }) })).rejects.toThrow(/VS Code/);
  });
});

// Windows の VS Code の code は code.cmd で、Node は .cmd をシェル無しでは起こせない。
describe('openInEditor（Windows の code.cmd）', () => {
  it('.cmd はシェル越しに、パスを引用符で包んで起こす', async () => {
    const seen: { cmd: string; args: string[]; shell: boolean | undefined }[] = [];
    const fake: Exec = async (cmd, args, opts) => { seen.push({ cmd, args, shell: opts?.shell }); return { code: 0, stdout: '', stderr: '' }; };
    await openInEditor({ codePath: 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', target: 'D:\\work space\\a.md', exec: fake, platform: 'win32' });
    expect(seen).toEqual([{ cmd: '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"', args: ['"D:\\work space\\a.md"'], shell: true }]);
  });
  it('.exe と、ほかの OS では、いまのまま直に起こす', async () => {
    const seen: { cmd: string; args: string[]; shell: boolean | undefined }[] = [];
    const fake: Exec = async (cmd, args, opts) => { seen.push({ cmd, args, shell: opts?.shell }); return { code: 0, stdout: '', stderr: '' }; };
    await openInEditor({ codePath: 'C:\\x\\code.exe', target: 'D:\\a.md', exec: fake, platform: 'win32' });
    await openInEditor({ codePath: '/x/code.cmd', target: '/w/a.md', exec: fake, platform: 'darwin' });
    expect(seen).toEqual([{ cmd: 'C:\\x\\code.exe', args: ['D:\\a.md'], shell: undefined }, { cmd: '/x/code.cmd', args: ['/w/a.md'], shell: undefined }]);
  });
  // 引用符の中でも cmd.exe が読む文字。開けるふりをして別のものを起こさないよう、断る。
  it('" を含むパスは起こさずに断る', async () => {
    const fake: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
    await expect(openInEditor({ codePath: 'C:\\x\\code.cmd', target: 'D:\\a" & calc & ".md', exec: fake, platform: 'win32' })).rejects.toThrow(/開けません/);
  });
});
