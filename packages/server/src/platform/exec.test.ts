import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFakeTool } from '../../test/fake-bin.ts';
import { findInDirs, isCommandName, knownDirs, MUX_NAMES, needsShell, pathExts, splitPathEnv } from './exec.ts';

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-exec-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('splitPathEnv', () => {
  it('macOS と Linux は : で分ける', () => {
    expect(splitPathEnv('/a:/b::/c', 'darwin')).toEqual(['/a', '/b', '/c']);
    expect(splitPathEnv(undefined, 'linux')).toEqual([]);
  });
  it('Windows は ; で分け、空の項目を飛ばし、引用符を外す', () => {
    expect(splitPathEnv('C:\\a;;"C:\\Program Files\\x";D:\\b;', 'win32')).toEqual(['C:\\a', 'C:\\Program Files\\x', 'D:\\b']);
  });
});

describe('pathExts', () => {
  it('Windows は PATHEXT を小文字で返し、無ければ既定を使う', () => {
    expect(pathExts({ PATHEXT: '.EXE;.CMD' }, 'win32')).toEqual(['.exe', '.cmd']);
    expect(pathExts({}, 'win32')).toEqual(['.com', '.exe', '.bat', '.cmd']);
    expect(pathExts({ PATHEXT: '  ' }, 'win32')).toEqual(['.com', '.exe', '.bat', '.cmd']);
  });
  it('ほかの OS は拡張子を補わない', () => {
    expect(pathExts({ PATHEXT: '.EXE' }, 'darwin')).toEqual(['']);
  });
});

describe('isCommandName', () => {
  it('区切りを含まず ~ で始まらないものが名前', () => {
    expect(isCommandName('tmux', 'darwin')).toBe(true);
    expect(isCommandName('/usr/bin/tmux', 'darwin')).toBe(false);
    expect(isCommandName('~/bin/tmux', 'darwin')).toBe(false);
    expect(isCommandName('psmux', 'win32')).toBe(true);
    expect(isCommandName('psmux.exe', 'win32')).toBe(true);
    expect(isCommandName('C:\\tools\\psmux.exe', 'win32')).toBe(false);
    expect(isCommandName('tools\\psmux.exe', 'win32')).toBe(false);
    expect(isCommandName('C:psmux.exe', 'win32')).toBe(false);
  });
});

describe('needsShell と MUX_NAMES', () => {
  it('.cmd と .bat だけがシェルを要る', () => {
    expect(needsShell('C:\\x\\code.cmd', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\a.BAT', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\claude.exe', 'win32')).toBe(false);
    expect(needsShell('/x/code.cmd', 'darwin')).toBe(false);
  });
  it('Windows は psmux を先に探す', () => {
    expect(MUX_NAMES('win32')).toEqual(['psmux', 'tmux']);
    expect(MUX_NAMES('darwin')).toEqual(['tmux']);
  });
});

describe('knownDirs', () => {
  it('macOS は Homebrew と手元の置き場', () => {
    expect(knownDirs({ HOME: '/Users/me' }, 'darwin', '/x')).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join('/Users/me', '.local', 'bin'), path.join('/Users/me', '.claude', 'local')]);
  });
  it('Windows は claude の置き場と winget の置き場。LOCALAPPDATA が無ければ足さない', () => {
    expect(knownDirs({ USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\x')).toEqual([
      path.join('C:\\Users\\me', '.local', 'bin'),
      path.join('C:\\Users\\me\\AppData\\Local', 'Microsoft', 'WinGet', 'Links'),
    ]);
    expect(knownDirs({}, 'win32', 'C:\\x')).toEqual([path.join('C:\\x', '.local', 'bin')]);
  });
});

describe('findInDirs（実物のファイル）', () => {
  it('並べた順に探し、実行できるものを返す。無ければ null', () => {
    const a = tmp();
    const b = tmp();
    const tool = writeFakeTool(b, 'mytool', { sh: 'echo ok', cmd: '@echo ok' });
    expect(findInDirs('mytool', [a, b])).toBe(tool);
    expect(findInDirs('nope', [a, b])).toBeNull();
    expect(findInDirs('mytool', [])).toBeNull();
  });
  // 空白と日本語を含む置き場（C:\Program Files、C:\Users\山田）でも見つける。
  it('空白と日本語を含むディレクトリでも見つける', () => {
    const d = path.join(tmp(), 'Program Files 山田');
    fs.mkdirSync(d);
    const tool = writeFakeTool(d, 'mytool', { sh: 'echo ok', cmd: '@echo ok' });
    expect(findInDirs('mytool', [d])).toBe(tool);
  });
  it.runIf(process.platform === 'win32')('Windows では拡張子を付けた名前でも、付けない名前でも見つける', () => {
    const d = tmp();
    const tool = writeFakeTool(d, 'mytool', { sh: 'echo ok', cmd: '@echo ok' });
    expect(findInDirs('mytool.cmd', [d])).toBe(tool);
    expect(findInDirs('MYTOOL', [d])?.toLowerCase()).toBe(tool.toLowerCase());
    fs.writeFileSync(path.join(d, 'readme.txt'), 'x');
    expect(findInDirs('readme.txt', [d])).toBeNull();
  });
});
