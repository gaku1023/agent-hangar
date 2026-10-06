import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSearchDeps, listProjectFiles, MAX_WALK_DIRS, rankFiles } from './files.ts';

let root: string;
const write = (rel: string, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-files-')); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('rankFiles', () => {
  const files = ['src/views/Dialog.tsx', 'src/dialog/index.ts', 'docs/dialogs.md', 'README.md', 'src/a/b/c/dialog.test.ts'];
  it('ファイル名の頭、ファイル名の途中、パスの途中の順に並べ、同じなら短いパスを先にする', () => {
    expect(rankFiles(files, 'dialog', 10)).toEqual(['docs/dialogs.md', 'src/views/Dialog.tsx', 'src/a/b/c/dialog.test.ts', 'src/dialog/index.ts']);
  });
  it('大文字と小文字を区別しない。上限で切る', () => {
    expect(rankFiles(files, 'READ', 10)).toEqual(['README.md']);
    expect(rankFiles(files, 'dialog', 2)).toHaveLength(2);
  });
  it('区切りを含む問いは、パス全体で探す', () => {
    expect(rankFiles(files, 'views/dia', 10)).toEqual(['src/views/Dialog.tsx']);
  });
});

describe('listProjectFiles', () => {
  it('git のフォルダでは、追跡しているものと、無視していない新しいものを返し、無視したものは返さない', async () => {
    write('src/a.ts'); write('new.ts'); write('.gitignore', 'out/\n'); write('out/big.js');
    git('init', '-q'); git('add', 'src/a.ts', '.gitignore'); git('commit', '-q', '-m', 'init');
    const all = await listProjectFiles(root, '.', 50);
    expect(all).toEqual(expect.arrayContaining(['src/a.ts', 'new.ts']));
    expect(all).not.toContain('out/big.js');
  });
  it('問いが空なら、最近変えたものを新しい順に 20 件まで返す', async () => {
    write('old.ts'); write('mid.ts'); write('fresh.ts');
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(root, 'old.ts'), t - 300, t - 300);
    fs.utimesSync(path.join(root, 'mid.ts'), t - 200, t - 200);
    fs.utimesSync(path.join(root, 'fresh.ts'), t - 100, t - 100);
    expect(await listProjectFiles(root, '', 50)).toEqual(['fresh.ts', 'mid.ts', 'old.ts']);
  });
  it('git でないフォルダは歩いて探し、.git と node_modules と点で始まるフォルダには入らない', async () => {
    write('a.ts'); write('lib/b.ts'); write('node_modules/x/index.js'); write('.cache/y.ts'); write('.env');
    expect((await listProjectFiles(root, '', 50)).sort()).toEqual(['.env', 'a.ts', 'lib/b.ts']);
  });
  it('深すぎる所と、多すぎる分は切る。落ちない', async () => {
    write('1/2/3/4/5/6/7/8/deep.ts');
    for (let i = 0; i < 30; i++) write(`many/f${i}.ts`);
    expect(await listProjectFiles(root, 'deep', 50)).toEqual([]);
    expect(await listProjectFiles(root, 'f', 5)).toHaveLength(5);
  });
  it('無いフォルダは空を返す', async () => {
    expect(await listProjectFiles(path.join(root, 'nope'), 'a', 50)).toEqual([]);
  });
  it('リンクをたどって外へ出ない', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    fs.symlinkSync(outside, path.join(root, 'link'));
    write('a.ts');
    expect(await listProjectFiles(root, 'secret', 50)).toEqual([]);
  });

  it('リポジトリの下のフォルダでも git で探す。.gitignore を守り、フォルダの外は返さない', async () => {
    write('outside.ts'); write('pkg/a.ts'); write('pkg/new.ts'); write('pkg/ignored.txt'); write('pkg/.gitignore', 'ignored.txt\n');
    git('init', '-q'); git('add', 'outside.ts', 'pkg/a.ts', 'pkg/.gitignore'); git('commit', '-q', '-m', 'init');
    const sub = path.join(root, 'pkg');
    const all = await listProjectFiles(sub, '.', 50);
    expect(all).toEqual(expect.arrayContaining(['a.ts', 'new.ts']));
    expect(all).not.toContain('ignored.txt');
    expect(all.some((f) => f.includes('outside') || f.startsWith('..') || f.startsWith('pkg/'))).toBe(false);
  });

  it('git のフォルダで問いが空なら、作業中のもの、続けて最近コミットしたものを返し、無視したものは返さない', async () => {
    write('a.ts'); write('b.ts'); write('.gitignore', 'out.js\n');
    git('init', '-q'); git('add', 'a.ts', 'b.ts', '.gitignore'); git('commit', '-q', '-m', 'one');
    write('c.ts'); git('add', 'c.ts'); git('commit', '-q', '-m', 'two');
    write('b.ts', 'changed'); write('new.ts'); write('out.js');
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(root, 'b.ts'), t - 100, t - 100);
    fs.utimesSync(path.join(root, 'new.ts'), t - 50, t - 50);
    const r = await listProjectFiles(root, '', 50);
    expect(r.slice(0, 3)).toEqual(['new.ts', 'b.ts', 'c.ts']);
    expect(r).toEqual(expect.arrayContaining(['a.ts', '.gitignore']));
    expect(r).not.toContain('out.js');
    expect(new Set(r).size).toBe(r.length);
  });
  it('コミットがまだ無い git のフォルダでも、作業中のものを返す', async () => {
    write('first.ts'); git('init', '-q');
    expect(await listProjectFiles(root, '', 50)).toEqual(['first.ts']);
  });

  it('追跡しているが消したファイルは、問いに合っても返さない', async () => {
    write('keep.ts'); write('gone.ts'); git('init', '-q'); git('add', 'keep.ts', 'gone.ts'); git('commit', '-q', '-m', 'init');
    fs.rmSync(path.join(root, 'gone.ts'));
    expect(await listProjectFiles(root, 'gone', 50)).toEqual([]);
    expect(await listProjectFiles(root, 'keep', 50)).toEqual(['keep.ts']);
  });

  it('同じ根への同時の呼び出しは、git を呼ぶ仕事を 1 度だけにまとめる', async () => {
    write('a.ts'); write('b.ts'); git('init', '-q'); git('add', 'a.ts', 'b.ts'); git('commit', '-q', '-m', 'init');
    const spy = vi.spyOn(fileSearchDeps, 'git');
    const [x, y] = await Promise.all([listProjectFiles(root, 'a', 50), listProjectFiles(root, 'b', 50)]);
    expect(x).toEqual(['a.ts']);
    expect(y).toEqual(['b.ts']);
    expect(spy.mock.calls.filter(([, args]) => args[0] === 'rev-parse')).toHaveLength(1);
    expect(spy.mock.calls.filter(([, args]) => args[0] === 'ls-files')).toHaveLength(1);
  });

  it('git が失敗したら 60 秒は呼び直さず、歩いた結果を返す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    write('a.ts');
    const spy = vi.spyOn(fileSearchDeps, 'git').mockRejectedValue(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }));
    expect(await listProjectFiles(root, 'a', 50)).toEqual(['a.ts']);
    expect(spy).toHaveBeenCalledTimes(1);
    // 一覧を覚えておく 10 秒は過ぎるが、失敗を覚えておく 60 秒の中。
    vi.advanceTimersByTime(11_000);
    expect(await listProjectFiles(root, 'a', 50)).toEqual(['a.ts']);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(await listProjectFiles(root, 'a', 50)).toEqual(['a.ts']);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('git でないフォルダ（終了コード 128）は失敗に数えない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    write('a.ts');
    const spy = vi.spyOn(fileSearchDeps, 'git').mockRejectedValue(Object.assign(new Error('not a git repository'), { code: 128 }));
    await listProjectFiles(root, 'a', 50);
    vi.advanceTimersByTime(11_000);
    await listProjectFiles(root, 'a', 50);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('空のフォルダが山ほどあっても、訪ねるフォルダの数に上限がある', async () => {
    for (let i = 0; i < MAX_WALK_DIRS + 100; i++) fs.mkdirSync(path.join(root, `d${i}`));
    const read = vi.spyOn(fs, 'readdirSync');
    expect(await listProjectFiles(root, 'x', 50)).toEqual([]);
    expect(read.mock.calls.length).toBeLessThanOrEqual(MAX_WALK_DIRS);
  });
});
