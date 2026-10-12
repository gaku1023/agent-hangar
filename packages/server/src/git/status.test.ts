import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asDifferentOwner, git, hasGit, makeRepo } from '../../test/git.ts';
import { diffFile, locateTree, numstatOf, parsePorcelainV2, readTreeStatus, spawnGit, unsafeDirOf, type GitExec } from './status.ts';

describe('parsePorcelainV2', () => {
  it('ブランチ、上流との差、行の種類を読む', () => {
    const out = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head fix/login',
      '# branch.upstream origin/fix/login',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa aaa src/a.ts',
      '1 A. N... 000000 100644 100644 000 bbb src/new.ts',
      '1 .D N... 100644 100644 000000 ccc ccc gone.ts',
      '2 R. N... 100644 100644 100644 ddd ddd R100 src/b.ts', 'src/old-b.ts',
      'u UU N... 100644 100644 100644 100644 e1 e2 e3 conflict.ts',
      '? notes/新しい メモ.md',
      '',
    ].join('\0');
    expect(parsePorcelainV2(out)).toEqual({
      branch: 'fix/login', head: '0123456', ahead: 2, behind: 1,
      entries: [
        { status: 'M', rel: 'src/a.ts' }, { status: 'A', rel: 'src/new.ts' }, { status: 'D', rel: 'gone.ts' },
        { status: 'R', rel: 'src/b.ts' }, { status: 'M', rel: 'conflict.ts' }, { status: 'U', rel: 'notes/新しい メモ.md' },
      ],
    });
  });
  it('切り離した HEAD と、上流の無いブランチと、最初のコミットの前', () => {
    expect(parsePorcelainV2('# branch.oid 0123456789abcdef\0# branch.head (detached)\0')).toMatchObject({ branch: null, head: '0123456', ahead: null, behind: null });
    expect(parsePorcelainV2('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ branch: 'main', head: null });
  });
});

describe('unsafeDirOf', () => {
  it('git が勧める safe.directory の場所を読む（macOS と Windows の形）', () => {
    const mac = "fatal: detected dubious ownership in repository at '/Users/you/work/a b'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '/Users/you/work/a b'\n";
    expect(unsafeDirOf(mac)).toBe('/Users/you/work/a b');
    const win = [
      "fatal: detected dubious ownership in repository at 'C:/Users/you/work/alpha'",
      "'C:/Users/you/work/alpha' is owned by:",
      '\tBUILTIN/Administrators (S-1-5-32-544)',
      'but the current user is:',
      '\tPC/you (S-1-5-21-1)',
      'To add an exception for this directory, call:',
      '',
      '\tgit config --global --add safe.directory C:/Users/you/work/alpha',
      '',
    ].join('\r\n');
    expect(unsafeDirOf(win)).toBe('C:/Users/you/work/alpha');
  });
  it('safe.directory の行が無ければ、断った場所を読む。持ち主の話でなければ null', () => {
    expect(unsafeDirOf("fatal: detected dubious ownership in repository at '/w/alpha'\n")).toBe('/w/alpha');
    expect(unsafeDirOf('fatal: not a git repository (or any of the parent directories): .git\n')).toBeNull();
    expect(unsafeDirOf('')).toBeNull();
  });
});

describe.skipIf(!hasGit)('実物の git', () => {
  let tmp: string;
  let exec: GitExec;
  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-git-')));
    exec = spawnGit('git');
  });
  // Windows では、止めた git が掴んだフォルダが少し遅れて放されるので、消すのを何度か試す。
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('作業ツリーの根と、worktree の名前と元の根を見つける', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'));
    fs.mkdirSync(path.join(repo, 'src'));
    expect(await locateTree(path.join(repo, 'src'), exec)).toEqual({ root: repo, worktree: null, mainRoot: null });
    const wt = path.join(repo, '.claude', 'worktrees', 'fix-a');
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-fix-a', wt);
    expect(await locateTree(wt, exec)).toEqual({ root: wt, worktree: 'fix-a', mainRoot: repo });
    expect(await locateTree(tmp, exec)).toBeNull();
  });

  it('持ち主の違いで git が断ったら、git でないとせず、断った場所を返す', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'));
    const r = await asDifferentOwner(tmp, () => locateTree(repo, exec));
    expect(r).toEqual({ unsafe: expect.any(String) });
    const same = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    expect(same((r as { unsafe: string }).unsafe)).toBe(same(repo));
  });

  it('未コミットの件数とブランチを読む。数えるのは git status の行の数', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'one\n', 'b.txt': 'two\n' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nmore\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
    fs.rmSync(path.join(repo, 'b.txt'));
    const r = await readTreeStatus(repo, exec, { now: 5 });
    expect(r.tree).toEqual({ root: repo, branch: 'main', head: expect.any(String), worktree: null, mainRoot: null, dirty: 3, capped: false, slow: false, ahead: null, behind: null, at: 5 });
    expect(r.entries).toEqual([{ status: 'M', rel: 'a.txt' }, { status: 'D', rel: 'b.txt' }, { status: 'U', rel: 'new.txt' }]);
  });

  it('上限を超えたら数えるのをやめ、capped を立てる', async () => {
    const repo = makeRepo(path.join(tmp, 'big'));
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), 'x');
    const r = await readTreeStatus(repo, exec, { now: 1, cap: 10 });
    expect(r.tree.dirty).toBe(10);
    expect(r.tree.capped).toBe(true);
    expect(r.tree.branch).toBe('main');
  });

  it('時間内に答えなければ slow にして件数を持たない', async () => {
    const slow: GitExec = async () => ({ code: 1, stdout: '', timedOut: true, capped: false });
    const r = await readTreeStatus('/w', slow, { now: 1 });
    expect(r.tree).toMatchObject({ root: '/w', dirty: null, slow: true });
  });

  it('行の増減は numstat から、未追跡は行を数え、バイナリは数えない', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'one\ntwo\nthree\n' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
    const n = await numstatOf(repo, exec, [{ status: 'M', rel: 'a.txt' }, { status: 'U', rel: 'new.txt' }, { status: 'U', rel: 'bin.dat' }]);
    expect(n.get('a.txt')).toEqual({ added: 2, deleted: 1, binary: false });
    expect(n.get('new.txt')).toEqual({ added: 2, deleted: 0, binary: false });
    expect(n.get('bin.dat')).toEqual({ added: null, deleted: null, binary: true });
  });

  it('1 つのファイルの作業ツリーとの差。未追跡は全部足した形にする', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'src/a.txt': 'one\ntwo\nthree\n' });
    fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\nTWO\nthree\n');
    const d = await diffFile(repo, 'src/a.txt', 'M', exec);
    expect(d.binary).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.text).toContain('@@ -1,3 +1,3 @@');
    expect(d.text).toContain('-two\n+TWO\n');
    fs.writeFileSync(path.join(repo, 'n.txt'), 'x\ny\n');
    const u = await diffFile(repo, 'n.txt', 'U', exec);
    expect(u.text).toBe('@@ -0,0 +1,2 @@\n+x\n+y\n');
    const c = await diffFile(repo, 'src/a.txt', 'C', exec);
    expect(c.text).toBe('');
  });

  it('差分は上限で切る', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'x\n' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'y\n'.repeat(5000));
    const d = await diffFile(repo, 'a.txt', 'M', exec, 1024);
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.text)).toBeLessThanOrEqual(1024);
  });
});
