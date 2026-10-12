import { describe, expect, it } from 'vitest';
import { customArgv, dirCommandOf, editorSettingOf, previewCommand, splitCommandLine } from './editor.ts';

describe('editorSettingOf', () => {
  it('0.4.0 までの codePath を VS Code の場所に読み替える', () => {
    expect(editorSettingOf(undefined, '/usr/local/bin/code')).toEqual({ id: 'vscode', path: '/usr/local/bin/code', fileCmd: '', dirCmd: '', terminal: 'none' });
    expect(editorSettingOf(undefined, null)).toEqual({ id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' });
    expect(editorSettingOf(undefined, '  ')).toMatchObject({ id: 'vscode', path: null });
  });

  it('editor があれば codePath は見ない', () => {
    expect(editorSettingOf({ id: 'zed', path: null }, '/usr/local/bin/code')).toEqual({ id: 'zed', path: null, fileCmd: '', dirCmd: '', terminal: 'none' });
  });

  it('知らない id と壊れた値は既定に寄せる', () => {
    expect(editorSettingOf({ id: 'emacs', terminal: 'x' })).toMatchObject({ id: 'vscode', terminal: 'none' });
    expect(editorSettingOf('vscode')).toMatchObject({ id: 'vscode', path: null });
    expect(editorSettingOf({ id: 'custom', fileCmd: 'nvim +{line} {path}', terminal: 'shell' })).toEqual({ id: 'custom', path: null, fileCmd: 'nvim +{line} {path}', dirCmd: '', terminal: 'shell' });
  });
});

describe('任意のコマンド', () => {
  it('語に分ける。引用の中の空白は 1 語にする', () => {
    expect(splitCommandLine('subl  {path}:{line}')).toEqual(['subl', '{path}:{line}']);
    expect(splitCommandLine('"/Applications/My Editor.app/bin/ed" -n {path}')).toEqual(['/Applications/My Editor.app/bin/ed', '-n', '{path}']);
    expect(splitCommandLine("emacsclient -n '+{line}' {path}")).toEqual(['emacsclient', '-n', '+{line}', '{path}']);
    expect(splitCommandLine('a ""')).toEqual(['a', '']);
    expect(splitCommandLine('   ')).toEqual([]);
  });

  it('フォルダのコマンドは {line} を含む語を外して作る', () => {
    expect(dirCommandOf('subl {path}:{line}')).toBe('subl {path}');
    expect(dirCommandOf('nvim +{line} {path}')).toBe('nvim {path}');
    expect(dirCommandOf('emacsclient -n +{line} {path}')).toBe('emacsclient -n {path}');
  });

  it('{path} と {line} を差し込む。空白を含むパスも 1 語のまま', () => {
    const o = { fileCmd: 'subl {path}:{line}', dirCmd: '' };
    expect(customArgv(o, { path: '/w/a b/x.ts', line: 42, dir: false })).toEqual(['subl', '/w/a b/x.ts:42']);
    expect(customArgv(o, { path: '/w/a b', line: null, dir: true })).toEqual(['subl', '/w/a b']);
    expect(customArgv({ fileCmd: 'nvim +{line} {path}', dirCmd: 'nvim .' }, { path: '/w', line: null, dir: true })).toBeNull();
    expect(customArgv({ fileCmd: 'nvim +{line} {path}', dirCmd: '' }, { path: '/w/x', line: null, dir: false })).toEqual(['nvim', '+1', '/w/x']);
    expect(customArgv({ fileCmd: 'subl', dirCmd: '' }, { path: '/w/x', line: 1, dir: false })).toBeNull();
  });

  it('見本は空白のある語を包む', () => {
    expect(previewCommand(['subl', '/w/a b/x.ts:42'])).toBe('subl "/w/a b/x.ts:42"');
  });
});
