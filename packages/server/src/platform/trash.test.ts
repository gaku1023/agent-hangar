import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveToTrash, trashCommand, TrashError, type TrashRun } from './trash.ts';

/**
 * OS のゴミ箱へ移す部品（platform/trash.ts）。
 * 打つコマンドの組み立てと、失敗を rm に倒さずに投げることを、偽の実行で確かめる。
 * macOS と Windows では、本物のゴミ箱へ一時ファイルを移す試験も走らせる（Windows は CI の windows のジョブが実機の代わり）。
 * 試験で作るファイルの名前には `hangar-trash-test-` を付け、ゴミ箱に残っても何のものか分かるようにする。移した後はゴミ箱から消して片付ける。
 */

const TEST_PREFIX = 'hangar-trash-test-';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** 呼ばれた引数を控え、決めた結果を返す偽の実行。removes が真なら、本物と同じく元のファイルを消す。 */
function fakeRun(result: { code: number | null; stdout?: string; stderr?: string }, removes = true): { run: TrashRun; calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] } {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: TrashRun = async (file, args, env) => {
    calls.push({ file, args, env });
    if (removes && result.code === 0) {
      const target = env.HANGAR_TRASH_PATH ?? args[args.length - 1]!;
      fs.rmSync(target, { recursive: true, force: true });
    }
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { run, calls };
}

describe('trashCommand（OS ごとのコマンド）', () => {
  it('macOS は osascript の JavaScript で NSFileManager の trashItemAtURL を呼び、パスは引数で渡す', () => {
    const c = trashCommand('/Users/a/x y.jsonl', 'darwin');
    expect(c.file).toBe('/usr/bin/osascript');
    expect(c.args[0]).toBe('-l');
    expect(c.args[1]).toBe('JavaScript');
    expect(c.args[2]).toBe('-e');
    expect(c.args[3]).toContain('trashItemAtURLResultingItemURLError');
    // パスは台本に埋めず、run(argv) の引数で渡す。引用符や空白を含むパスで台本が壊れないようにするためである。
    expect(c.args[3]).not.toContain('x y.jsonl');
    expect(c.args.at(-1)).toBe('/Users/a/x y.jsonl');
  });
  it('Windows は PowerShell で Microsoft.VisualBasic の SendToRecycleBin を呼び、パスは環境変数で渡す', () => {
    const c = trashCommand('C:\\Users\\a\\x\'y.jsonl', 'win32');
    expect(c.file).toBe('powershell.exe');
    const script = c.args.at(-1)!;
    expect(script).toContain('Microsoft.VisualBasic');
    expect(script).toContain('SendToRecycleBin');
    expect(script).toContain('DeleteFile');
    expect(script).toContain('DeleteDirectory');
    expect(script).not.toContain('x\'y.jsonl');
    expect(c.env.HANGAR_TRASH_PATH).toBe('C:\\Users\\a\\x\'y.jsonl');
  });
  it('Linux は gio trash を打つ', () => {
    const c = trashCommand('/home/a/x.jsonl', 'linux');
    expect(c.file).toBe('gio');
    expect(c.args).toEqual(['trash', '--', '/home/a/x.jsonl']);
  });
});

describe('moveToTrash（偽の実行）', () => {
  it('成功して元のパスが無くなれば、そのまま返る', async () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, 'x');
    const { run, calls } = fakeRun({ code: 0 });
    await moveToTrash(f, { platform: 'darwin', run });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(f)).toBe(false);
  });
  it('失敗したら TrashError を投げ、元のファイルは消さない（rm に倒さない）', async () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, 'x');
    const { run } = fakeRun({ code: 1, stderr: 'no trash' });
    await expect(moveToTrash(f, { platform: 'linux', run })).rejects.toThrow(TrashError);
    expect(fs.existsSync(f)).toBe(true);
  });
  it('コマンドが成功を返しても元のファイルが残っていれば、移せなかったとして投げる', async () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, 'x');
    const { run } = fakeRun({ code: 0 }, false);
    await expect(moveToTrash(f, { platform: 'win32', run })).rejects.toThrow(TrashError);
    expect(fs.existsSync(f)).toBe(true);
  });
  it('無いパスはコマンドを打たずに投げる', async () => {
    const { run, calls } = fakeRun({ code: 0 });
    await expect(moveToTrash(path.join(dir, 'nope.jsonl'), { platform: 'darwin', run })).rejects.toThrow(TrashError);
    expect(calls).toHaveLength(0);
  });
  it('起こせなかった（コマンドが無い）ときも TrashError にする', async () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, 'x');
    const run: TrashRun = async () => ({ code: null, stdout: '', stderr: '', error: new Error('spawn gio ENOENT') });
    await expect(moveToTrash(f, { platform: 'linux', run })).rejects.toThrow(/gio ENOENT/);
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe.runIf(process.platform === 'darwin')('moveToTrash（macOS の本物のゴミ箱）', () => {
  // ゴミ箱（~/.Trash）は、端末の権限（フルディスクアクセス）が無いと一覧も読めない。
  // そのため、入ったことは「元の場所から消え、例外が出なかった」ことで見る。
  // 移したものは試験の名前で ~/.Trash に残る。読めれば片付け、読めなければ残す（名前で試験のものと分かる）。
  it('一時ファイルとフォルダをゴミ箱へ移す', async () => {
    const name = `${TEST_PREFIX}${process.pid}-${Date.now()}`;
    const f = path.join(dir, `${name}.jsonl`);
    const sub = path.join(dir, name);
    fs.writeFileSync(f, '{"type":"user"}\n');
    fs.mkdirSync(path.join(sub, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'subagents', 'agent-a.jsonl'), 'x');
    try {
      await moveToTrash(f);
      await moveToTrash(sub);
      expect(fs.existsSync(f)).toBe(false);
      expect(fs.existsSync(sub)).toBe(false);
    } finally {
      const trash = path.join(os.homedir(), '.Trash');
      try {
        for (const e of fs.readdirSync(trash)) if (e.startsWith(name)) fs.rmSync(path.join(trash, e), { recursive: true, force: true });
      } catch {
        // 読めなければ残す。
      }
    }
  }, 30_000);
});

/** Windows のごみ箱から、試験の名前の項目を探して消す。見つけた項目の元の名前を返す。 */
function purgeRecycleBin(prefix: string): string[] {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject Shell.Application',
    '$bin = $shell.Namespace(10)',
    '$found = @()',
    `foreach ($i in @($bin.Items())) { if ($i.Name -like '${prefix}*') { $found += $i.Name; Remove-Item -LiteralPath $i.Path -Recurse -Force } }`,
    '$found -join "`n"',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

describe.runIf(process.platform === 'win32')('moveToTrash（Windows の本物のごみ箱）', () => {
  it('一時ファイルとフォルダをごみ箱へ移し、ごみ箱から片付ける', async () => {
    const name = `${TEST_PREFIX}${process.pid}-${Date.now()}`;
    const f = path.join(dir, `${name}.jsonl`);
    const sub = path.join(dir, name);
    fs.writeFileSync(f, '{"type":"user"}\n');
    fs.mkdirSync(path.join(sub, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'subagents', 'agent-a.jsonl'), 'x');
    try {
      await moveToTrash(f);
      await moveToTrash(sub);
      expect(fs.existsSync(f)).toBe(false);
      expect(fs.existsSync(sub)).toBe(false);
    } finally {
      // ごみ箱に入ったことを、ごみ箱の中から試験の名前で見つけて確かめ、そのまま消す。
      // 表示名は拡張子を隠す設定に左右されるので、試験の名前で始まる項目が 2 つあることだけを見る。
      const found = purgeRecycleBin(name);
      expect(found.filter((n) => n.startsWith(name))).toHaveLength(2);
    }
  }, 120_000);
});
