import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorSetting } from '@agent-hangar/shared';
import { cmdQuote, EditorMissingError, execFile, openDirInTerminalApp, openInEditor, openInTerminalApp, writeAttachCommand, writeCdCommand, type Exec } from './open.ts';
import type { EditorHost } from './editors.ts';
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
  it('ディレクトリを開くとき、iterm は cd を書いた .command を実行させる（シェルの構文を直に渡さない）', async () => {
    // iTerm2 は command を語に割って起こすだけで、シェルを通さない。
    // 「cd … && exec …」を直に渡すと cd が実行ファイルとして起こされ、窓ごと開かない。
    await openDirInTerminalApp({ home, dir: "/w/al pha/it's", app: 'iterm', exec: exec() });
    const script = calls[0]!.args[1]!;
    const command = JSON.parse(script.split('create window with default profile command ')[1]!.split('\n')[0]!) as string;
    const file = writeCdCommand(home, "/w/al pha/it's");
    expect(command).toBe(`'${file}'`);
    expect(command).not.toContain('&&');
    // .command は Terminal.app の経路と同じもので、shell の決め方も同じ。
    expect(fs.readFileSync(file, 'utf8')).toBe(`#!/usr/bin/env bash\ncd '/w/al pha/it'\\''s' && exec "\${SHELL:-/bin/zsh}" -l\nexit\n`);
  });
  it('iterm が窓を作れなかったとき（osascript が missing value を返す）も Terminal.app に落とす', async () => {
    const failing: Exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: cmd === 'osascript' ? 'missing value\n' : '', stderr: '' };
    };
    const r = await openDirInTerminalApp({ home, dir: '/w/alpha', app: 'iterm', exec: failing });
    expect(r).toEqual({ app: 'terminal', fellBack: true });
    expect(calls.map((c) => c.cmd)).toEqual(['osascript', 'open']);
  });
  it('iterm の窓が作れたとき（window id を返す）は落とさない', async () => {
    const ok: Exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: 'window id 20104\n', stderr: '' };
    };
    const r = await openDirInTerminalApp({ home, dir: '/w/alpha', app: 'iterm', exec: ok });
    expect(r).toEqual({ app: 'iterm', fellBack: false });
    expect(calls.map((c) => c.cmd)).toEqual(['osascript']);
  });
});

// Windows の 2 つの経路。フェイクの exec で、起こすコマンドと引数だけを確かめる。
describe('openInTerminalApp（Windows）', () => {
  const PSMUX = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  type Seen = { cmd: string; args: string[]; verbatim: boolean | undefined; untilExit: boolean | undefined };
  let seen: Seen[];
  const winExec =
    (results: Record<string, number> = {}): Exec =>
    async (cmd, args, opts) => {
      seen.push({ cmd, args, verbatim: opts?.verbatim, untilExit: opts?.untilExit });
      return { code: results[cmd] ?? 0, stdout: '', stderr: '' };
    };
  beforeEach(() => { seen = []; });

  it('Windows Terminal は wt.exe の新しいタブで、完全一致の名前に attach する', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-ab12cd34', app: 'windowsTerminal', exec: winExec() });
    expect(r).toEqual({ app: 'windowsTerminal', fellBack: false });
    // 引数は配列のまま渡す。空白や日本語の引用は Node が Windows の規則で付ける。
    expect(seen).toEqual([{ cmd: 'wt.exe', args: ['-w', '0', 'new-tab', '--title', 'hangar-ab12cd34', '--suppressApplicationTitle', '--', PSMUX, 'attach', '-t', '=hangar-ab12cd34'], verbatim: undefined, untilExit: true }]);
    // 何もファイルを書かない。
    expect(fs.existsSync(path.join(home, 'cmd'))).toBe(false);
  });
  it('Windows Terminal に渡す空白と日本語の名前は 1 つの引数のまま、; は wt の区切りにならないよう \\; にする', async () => {
    await openInTerminalApp({ home, tmuxPath: 'C:\\Program Files\\psmux\\psmux.exe', tmuxName: '作業 1;2', app: 'windowsTerminal', exec: winExec() });
    expect(seen[0]!.args).toEqual(['-w', '0', 'new-tab', '--title', '作業 1\\;2', '--suppressApplicationTitle', '--', 'C:\\Program Files\\psmux\\psmux.exe', 'attach', '-t', '=作業 1\\;2']);
  });
  it('既定のターミナルは cmd /c start で新しい窓を開き、パスと名前を二重引用符で包む', async () => {
    const r = await openInTerminalApp({ home, tmuxPath: 'C:\\Program Files\\psmux\\psmux.exe', tmuxName: '日本語 の セッション', app: 'windowsDefault', exec: winExec() });
    expect(r).toEqual({ app: 'windowsDefault', fellBack: false });
    // start の最初の引用は窓の題名と読まれる。題名を渡さないときは tmux の名前を置く（空にすると窓の題名が実行ファイルのパスになる）。
    // 引数は Node に引用させず、そのまま cmd.exe に渡す（Node の \" は cmd.exe に通じない）。
    expect(seen).toEqual([{
      cmd: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '"start "日本語 の セッション" "C:\\Program Files\\psmux\\psmux.exe" attach -t "=日本語 の セッション""'],
      verbatim: true,
      untilExit: true,
    }]);
  });
  it('既定のターミナルでは、cmd.exe が引用符の中でも読む % を引用の外へ出して ^ で消す', async () => {
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'a%PATH%b & c', app: 'windowsDefault', exec: winExec() });
    expect(seen[0]!.args[4]).toBe(`"start "a"^%"PATH"^%"b & c" "${PSMUX}" attach -t "=a"^%"PATH"^%"b & c""`);
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
  // 題名を付けないと、Windows Terminal のタブも既定のターミナルの窓も、起こした実行ファイルのフルパスが題名になる。
  it('題名を渡すと、Windows Terminal は --title と --suppressApplicationTitle で、既定のターミナルは start の最初の引用で付ける', async () => {
    const tmuxPath = 'C:\\Program Files\\psmux\\psmux.exe';
    await openInTerminalApp({ home, tmuxPath, tmuxName: 'hangar-x', title: '日本語 の 作業 1;2', app: 'windowsTerminal', exec: winExec() });
    expect(seen[0]!.args).toEqual(['-w', '0', 'new-tab', '--title', '日本語 の 作業 1\\;2', '--suppressApplicationTitle', '--', tmuxPath, 'attach', '-t', '=hangar-x']);
    seen = [];
    await openInTerminalApp({ home, tmuxPath, tmuxName: 'hangar-x', title: '日本語 の 作業 1;2', app: 'windowsDefault', exec: winExec() });
    expect(seen[0]!.args[4]).toBe(`"start "日本語 の 作業 1;2" "${tmuxPath}" attach -t "=hangar-x""`);
  });
  it('題名の " と改行と制御文字は断らずに潰し、% は引用の外へ出し、- で始まる題名はオプションと読まれないようにする', async () => {
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', title: 'say "hi"\r\n 50%\tdone', app: 'windowsDefault', exec: winExec() });
    expect(seen[0]!.args[4]).toBe(`"start "say 'hi' 50"^%" done" "${PSMUX}" attach -t "=hangar-x""`);
    seen = [];
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', title: '--help', app: 'windowsTerminal', exec: winExec() });
    expect(seen[0]!.args.slice(3, 5)).toEqual(['--title', ' --help']);
  });
  it('長すぎる題名は切り、空の題名は tmux の名前に落とす', async () => {
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', title: '長'.repeat(200), app: 'windowsTerminal', exec: winExec() });
    expect(seen[0]!.args[4]).toBe('長'.repeat(80));
    seen = [];
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', title: '  \n ', app: 'windowsTerminal', exec: winExec() });
    expect(seen[0]!.args[4]).toBe('hangar-x');
  });
  it('フォルダを開く題名は、末尾の \\ を除いたフォルダ名にする（日本語と空白もそのまま）', async () => {
    await openDirInTerminalApp({ home, dir: 'D:\\work space\\日本語 の 作業\\', app: 'windowsDefault', exec: winExec() });
    expect(seen[0]!.args[4]).toBe('"start "日本語 の 作業" /D "D:\\work space\\日本語 の 作業" powershell.exe -NoLogo"');
  });
  it('フォルダを開くとき、Windows Terminal は -d でそのフォルダの新しいタブを開く', async () => {
    const r = await openDirInTerminalApp({ home, dir: 'D:\\work space\\日本語', app: 'windowsTerminal', exec: winExec() });
    expect(r).toEqual({ app: 'windowsTerminal', fellBack: false });
    expect(seen).toEqual([{ cmd: 'wt.exe', args: ['-w', '0', 'new-tab', '--title', '日本語', '--suppressApplicationTitle', '-d', 'D:\\work space\\日本語'], verbatim: undefined, untilExit: true }]);
  });
  it('フォルダを開くとき、既定のターミナルは start /D でそのフォルダの PowerShell を開く', async () => {
    await openDirInTerminalApp({ home, dir: 'D:\\work space\\日本語\\', app: 'windowsDefault', exec: winExec() });
    // 末尾の \ は取る。"…\" の \" を引用の終わりと読み違える道具がある。
    expect(seen).toEqual([{ cmd: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', '"start "日本語" /D "D:\\work space\\日本語" powershell.exe -NoLogo"'], verbatim: true, untilExit: true }]);
  });
  it('ドライブの直下は末尾の \\ を残す', async () => {
    await openDirInTerminalApp({ home, dir: 'C:\\', app: 'windowsDefault', exec: winExec() });
    expect(seen[0]!.args[4]).toBe('"start "C:\\" /D "C:\\" powershell.exe -NoLogo"');
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

describe('hangar の専用の tmux サーバへつなぐ', () => {
  const PSMUX = 'C:\\Program Files\\psmux\\psmux.exe';
  it('macOS の .command と iTerm2 のコマンドは、サーバの指定（-L hangar）を attach の前に置く', async () => {
    const a = writeAttachCommand(home, '/opt/homebrew/bin/tmux', 'hangar-ab12cd34', ['-L', 'hangar']);
    expect(fs.readFileSync(a, 'utf8')).toBe("#!/usr/bin/env bash\n'/opt/homebrew/bin/tmux' '-L' 'hangar' attach -t '=hangar-ab12cd34'\nexit\n");
    await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', socketArgs: ['-L', 'hangar'], app: 'iterm', exec: exec() });
    expect(calls[0]!.args[1]).toContain(`create window with default profile command "'/t/tmux' '-L' 'hangar' attach -t '=hangar-x'"`);
  });
  it('Windows Terminal と既定のターミナルも、psmux の -L hangar へつなぐ', async () => {
    const seen: string[][] = [];
    const winExec: Exec = async (cmd, args) => { seen.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; };
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', socketArgs: ['-L', 'hangar'], app: 'windowsTerminal', exec: winExec });
    expect(seen[0]!.slice(-7)).toEqual(['--', PSMUX, '-L', 'hangar', 'attach', '-t', '=hangar-x']);
    await openInTerminalApp({ home, tmuxPath: PSMUX, tmuxName: 'hangar-x', socketArgs: ['-L', 'hangar'], app: 'windowsDefault', exec: winExec });
    expect(seen[1]![5]).toBe(`"start "hangar-x" "${PSMUX}" "-L" "hangar" attach -t "=hangar-x""`);
  });
  it('前の版が既定のサーバに作ったセッションは、サーバの指定なしでつなぐ', async () => {
    await openInTerminalApp({ home, tmuxPath: '/t/tmux', tmuxName: 'hangar-x', socketArgs: [], app: 'iterm', exec: exec() });
    expect(calls[0]!.args[1]).toContain(`create window with default profile command "'/t/tmux' attach -t '=hangar-x'"`);
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

// 外のターミナルを起こす経路では、起こしたもの（cmd.exe の start が起こした窓、wt.exe が起こした窓）が、
// 子の出力の管を受け継いで握り続ける。execFile は管が閉じるまで（窓を閉じるか、30 秒のタイムアウトまで）返らない。
// 返らない間は HTTP の応答も返らず、Windows Terminal が無かった知らせ（fellBack）が画面に出ない（rc.6 の Windows の実機で見つけた）。
// untilExit は、子が終われば、孫が管を握っていても返す。sh の & は、管を受け継いだ孫を残して子だけを終わらせる、同じ形を作る。
describe('execFile の untilExit', () => {
  const grandchild = "sleep 2 & echo o; echo e >&2; exit 0";
  posixIt('untilExit を付けないと、子が終わっても、管を握る孫が終わるまで返らない（直す前の形）', async () => {
    const t0 = Date.now();
    expect((await execFile('sh', ['-c', grandchild])).code).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
  });
  posixIt('untilExit を付けると、子が終われば、管を握る孫を待たずに返す', async () => {
    const t0 = Date.now();
    const r = await execFile('sh', ['-c', grandchild], { untilExit: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.code).toBe(0);
  });
  it('孫がいなければ、出力も終了コードも untilExit を付けないときと同じに返す', async () => {
    const script = 'process.stdout.write("o"); process.stderr.write("e"); process.exitCode = 3';
    expect(await execFile(process.execPath, ['-e', script], { untilExit: true })).toEqual({ code: 3, stdout: 'o', stderr: 'e' });
  });
  it('起動できないときとタイムアウトは code 1 にする', async () => {
    expect((await execFile(path.join(home, 'no-such-command'), [], { untilExit: true })).code).toBe(1);
    expect((await execFile(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 500, untilExit: true })).code).toBe(1);
  });
});

// 実物の cmd.exe の start で、窓を開いて残るもの（ping、約 7 秒）を起こす。既定のターミナルで開くときと同じ形である。
describe.skipIf(process.platform !== 'win32')('cmd.exe の start（実物）', () => {
  const line = ['/d', '/v:off', '/s', '/c', '"start "hangar-test" ping -n 8 127.0.0.1"'];
  it('untilExit を付けると、start が起こした窓の終わりを待たずに返す', async () => {
    const t0 = Date.now();
    const r = await execFile('cmd.exe', line, { verbatim: true, untilExit: true });
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
  it('untilExit を付けないと、start が起こした窓が終わるまで返らない（直す前の形）', async () => {
    const t0 = Date.now();
    expect((await execFile('cmd.exe', line, { verbatim: true })).code).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5000);
  });
});

const vscodeAt = (p: string): EditorSetting => ({ id: 'vscode', path: p, fileCmd: '', dirCmd: '', terminal: 'none' });
/** 設定のパスがそのまま動く見せかけの PC。 */
const hostWith = (platform: NodeJS.Platform, files: string[] = []): EditorHost => ({
  platform, env: {}, home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u',
  exists: (f) => files.includes(f), isExec: (f) => files.includes(f), which: () => null, readdir: () => [],
});

describe('openInEditor', () => {
  it('設定のエディタの CLI を、行があれば行の引数で起こす', async () => {
    const h = hostWith('darwin', ['/usr/local/bin/code']);
    expect(await openInEditor({ editor: vscodeAt('/usr/local/bin/code'), target: { path: '/w/alpha', line: null, dir: true }, host: h, exec: exec() })).toBe('cli');
    await openInEditor({ editor: vscodeAt('/usr/local/bin/code'), target: { path: '/w/a.ts', line: 3, dir: false }, host: h, exec: exec() });
    expect(calls).toEqual([{ cmd: '/usr/local/bin/code', args: ['/w/alpha'] }, { cmd: '/usr/local/bin/code', args: ['-g', '/w/a.ts:3'] }]);
  });
  it('見つからなければ EditorMissingError で、名前と最後の場所を持つ', async () => {
    const e = await openInEditor({ editor: vscodeAt('/gone/code'), target: { path: '/w', line: null, dir: true }, host: hostWith('darwin'), exec: exec() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EditorMissingError);
    expect((e as EditorMissingError).message).toBe('VS Code が見つかりません');
    expect((e as EditorMissingError).detail).toEqual({ editor: 'vscode', name: 'VS Code', lastPath: '/gone/code' });
  });
  it('起こして失敗すれば、エディタの名前で言う', async () => {
    const h = hostWith('darwin', ['/x/code']);
    await expect(openInEditor({ editor: vscodeAt('/x/code'), target: { path: '/w', line: null, dir: true }, host: h, exec: exec({ '/x/code': 2 }) })).rejects.toThrow('VS Code を起動できませんでした: exit 2');
  });
  it('{path} の無い任意のコマンドは起こさずに断る', async () => {
    const custom: EditorSetting = { id: 'custom', path: null, fileCmd: 'subl', dirCmd: '', terminal: 'none' };
    await expect(openInEditor({ editor: custom, target: { path: '/w', line: null, dir: true }, host: hostWith('darwin'), exec: exec() })).rejects.toThrow(/\{path\}/);
  });
});

// Windows の VS Code の code は code.cmd で、Node は .cmd をシェル無しでは起こせない。
describe('openInEditor（Windows の code.cmd）', () => {
  // Windows では、起こした VS Code の窓が cmd.exe の出力の管を受け継ぐので、子が終わったら返す（untilExit）。
  it('.cmd はシェル越しに、パスを引用符で包んで起こし、子が終われば返す', async () => {
    const seen: { cmd: string; args: string[]; shell: boolean | undefined; untilExit: boolean | undefined }[] = [];
    const fake: Exec = async (cmd, args, opts) => { seen.push({ cmd, args, shell: opts?.shell, untilExit: opts?.untilExit }); return { code: 0, stdout: '', stderr: '' }; };
    const code = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd';
    await openInEditor({ editor: vscodeAt(code), target: { path: 'D:\\work space\\a.md', line: null, dir: false }, host: hostWith('win32', [code]), exec: fake });
    await openInEditor({ editor: vscodeAt(code), target: { path: 'D:\\w\\100%.md', line: 2, dir: false }, host: hostWith('win32', [code]), exec: fake });
    expect(seen).toEqual([
      { cmd: `"${code}"`, args: ['"D:\\work space\\a.md"'], shell: true, untilExit: true },
      { cmd: `"${code}"`, args: ['"-g"', '"D:\\w\\100"^%".md:2"'], shell: true, untilExit: true },
    ]);
  });
  it('.exe とほかの OS では、シェルを通さず直に起こす。子が終われば返すのは Windows だけ', async () => {
    const seen: { cmd: string; args: string[]; shell: boolean | undefined; untilExit: boolean | undefined }[] = [];
    const fake: Exec = async (cmd, args, opts) => { seen.push({ cmd, args, shell: opts?.shell, untilExit: opts?.untilExit }); return { code: 0, stdout: '', stderr: '' }; };
    await openInEditor({ editor: vscodeAt('C:\\x\\code.exe'), target: { path: 'D:\\a.md', line: null, dir: false }, host: hostWith('win32', ['C:\\x\\code.exe']), exec: fake });
    await openInEditor({ editor: vscodeAt('/x/code.cmd'), target: { path: '/w/a.md', line: null, dir: false }, host: hostWith('darwin', ['/x/code.cmd']), exec: fake });
    expect(seen).toEqual([{ cmd: 'C:\\x\\code.exe', args: ['D:\\a.md'], shell: undefined, untilExit: true }, { cmd: '/x/code.cmd', args: ['/w/a.md'], shell: undefined, untilExit: undefined }]);
  });
  // 引用符の中でも cmd.exe が読む文字。開けるふりをして別のものを起こさないよう、断る。
  it('" を含むパスは起こさずに断る', async () => {
    const fake: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
    await expect(openInEditor({ editor: vscodeAt('C:\\x\\code.cmd'), target: { path: 'D:\\a" & calc & ".md', line: null, dir: false }, host: hostWith('win32', ['C:\\x\\code.cmd']), exec: fake })).rejects.toThrow(/開けません/);
  });
});

