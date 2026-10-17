import { describe, expect, it } from 'vitest';
import { appendPaths, isWindowsPath, quotePath } from './promptPaths.ts';

describe('isWindowsPath', () => {
  it('ドライブ、UNC、バックスラッシュを含む相対パスを Windows の形とみる', () => {
    for (const p of ['C:\\a\\b', 'c:', 'D:/a/b', '\\\\server\\share\\x', '~\\work', 'src\\a.ts']) expect(isWindowsPath(p), p).toBe(true);
  });
  it('/ で始まるものと ~/ は Windows の形ではない', () => {
    for (const p of ['/Users/a/b', '~/work', 'a.ts', '/Users/a/b\\c']) expect(isWindowsPath(p), p).toBe(false);
  });
});

describe('quotePath', () => {
  it('安全な字だけなら囲まない', () => {
    expect(quotePath('/h/drops/1-0-a.png')).toBe('/h/drops/1-0-a.png');
    expect(quotePath('C:\\h\\drops\\1-0-a.png')).toBe('C:\\h\\drops\\1-0-a.png');
  });
  it('空白を含めば囲む（POSIX は単引用符、Windows は二重引用符）', () => {
    expect(quotePath("/tmp/it's a.png")).toBe("'/tmp/it'\\''s a.png'");
    expect(quotePath('C:\\Users\\Taro Yamada\\a.png')).toBe('"C:\\Users\\Taro Yamada\\a.png"');
  });
});

describe('appendPaths', () => {
  it('パスが無ければ本文を整えて返す', () => {
    expect(appendPaths('  やって\n', [])).toBe('やって');
  });
  it('本文の後に空行を置き、パスを 1 行ずつ足す', () => {
    expect(appendPaths('見て', ['/h/drops/1-0-a.png', '/h/drops/1-1-b.log'])).toBe('見て\n\n/h/drops/1-0-a.png\n/h/drops/1-1-b.log');
  });
  it('本文が空ならパスだけ', () => {
    expect(appendPaths('  ', ['/h/drops/1-0-a.png'])).toBe('/h/drops/1-0-a.png');
  });
  it('空白を含むパスは囲む', () => {
    expect(appendPaths('見て', ['/h/my drops/a.png'])).toBe("見て\n\n'/h/my drops/a.png'");
  });
});
