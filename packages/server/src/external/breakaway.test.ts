import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BREAKAWAY_FLAG, breakawayExec, quoteWindowsArg } from './breakaway.ts';
import { execFile, type Exec } from './open.ts';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-breakaway-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('quoteWindowsArg', () => {
  it('空白も引用符も無い語はそのまま、空は "" にする', () => {
    expect(quoteWindowsArg('wt.exe')).toBe('wt.exe');
    expect(quoteWindowsArg('C:\\a\\b')).toBe('C:\\a\\b');
    expect(quoteWindowsArg('')).toBe('""');
  });
  it('空白を含む語は引用符で包み、末尾の \\ は倍にする', () => {
    expect(quoteWindowsArg('a b')).toBe('"a b"');
    expect(quoteWindowsArg('C:\\work space\\')).toBe('"C:\\work space\\\\"');
  });
  it('引用符は \\" にし、その前の \\ は倍にする', () => {
    expect(quoteWindowsArg('a"b')).toBe('"a\\"b"');
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
  });
});

describe('breakawayExec', () => {
  const seen: { cmd: string; args: string[]; opts: unknown }[] = [];
  const inner: Exec = async (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { code: 7, stdout: 'o', stderr: 'e' }; };
  beforeEach(() => { seen.length = 0; });
  const launcher = 'C:\\Users\\me\\AppData\\Local\\Hangar\\Hangar.exe';

  it('起こしたいものと引数を、殻の起こし役に 1 行で渡し、結果はそのまま返す', async () => {
    const exec = breakawayExec(inner, launcher);
    expect(await exec('wt.exe', ['-w', '0', 'new-tab', '-d', 'D:\\work space'], { timeoutMs: 5000 })).toEqual({ code: 7, stdout: 'o', stderr: 'e' });
    expect(seen).toEqual([{ cmd: launcher, args: [BREAKAWAY_FLAG, 'wt.exe', '-w 0 new-tab -d "D:\\work space"'], opts: { timeoutMs: 5000 } }]);
  });

  it('verbatim の引数は引用せずに並べる（cmd.exe へ自前で組んだ 1 行）', async () => {
    await breakawayExec(inner, launcher)('cmd.exe', ['/d', '/v:off', '/s', '/c', '"start "" "C:\\p s\\psmux.exe" attach"'], { verbatim: true });
    expect(seen[0]!.args).toEqual([BREAKAWAY_FLAG, 'cmd.exe', '/d /v:off /s /c "start "" "C:\\p s\\psmux.exe" attach"']);
  });

  it('shell の指定は、Node と同じく cmd.exe /d /s /c "…" に組み直す', async () => {
    await breakawayExec(inner, launcher, { comspec: 'C:\\Windows\\system32\\cmd.exe' })('"C:\\VS Code\\bin\\code.cmd"', ['"D:\\a b"'], { shell: true });
    expect(seen[0]!.args).toEqual([BREAKAWAY_FLAG, 'C:\\Windows\\system32\\cmd.exe', '/d /s /c ""C:\\VS Code\\bin\\code.cmd" "D:\\a b""']);
  });
});

// 引用の組み立てを、実物の Windows の規則で読み戻して確かめる。殻の起こし役（Rust）は、受け取った 1 行をそのまま子のコマンド行の後ろに付ける。
describe.skipIf(process.platform !== 'win32')('quoteWindowsArg（実物）', () => {
  it('並べた 1 行を、子は元の語の並びとして受け取る', async () => {
    const script = path.join(home, 'argv.cjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const words = ['=日本語 の セッション', 'a"b', 'C:\\work space\\', '', 'x\\\\"y', 'tab\there', 'semi;colon'];
    const r = await execFile(process.execPath, [script, ...words].map(quoteWindowsArg), { verbatim: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(words);
  });
});
