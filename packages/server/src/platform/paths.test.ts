import { describe, expect, it } from 'vitest';
import { isStrictlyUnder, isUnder, pathKey, samePath } from './paths.ts';

describe('isUnder', () => {
  it('macOS と Linux は / で区切り、大文字小文字を区別する', () => {
    expect(isUnder('/w/alpha', '/w/alpha', 'darwin')).toBe(true);
    expect(isUnder('/w/alpha/src', '/w/alpha', 'darwin')).toBe(true);
    expect(isUnder('/w/alphabet', '/w/alpha', 'darwin')).toBe(false);
    expect(isUnder('/w/Alpha/src', '/w/alpha', 'darwin')).toBe(false);
  });
  it('Windows は \\ で区切り、大文字小文字とドライブ文字の大小を区別しない', () => {
    expect(isUnder('D:\\workspace\\alpha\\src', 'D:\\workspace\\alpha', 'win32')).toBe(true);
    expect(isUnder('d:\\Workspace\\Alpha\\src', 'D:\\workspace\\alpha', 'win32')).toBe(true);
    expect(isUnder('D:\\workspace\\alphabet', 'D:\\workspace\\alpha', 'win32')).toBe(false);
    expect(isUnder('C:\\workspace\\alpha', 'D:\\workspace\\alpha', 'win32')).toBe(false);
  });
  it('ドライブの直下を根にしても、区切りを二重に足さない', () => {
    expect(isUnder('D:\\x', 'D:\\', 'win32')).toBe(true);
    expect(isUnder('D:\\', 'D:\\', 'win32')).toBe(true);
    expect(isUnder('/x', '/', 'darwin')).toBe(true);
  });
});

describe('isStrictlyUnder', () => {
  it('根そのものは含めない', () => {
    expect(isStrictlyUnder('/s', '/s', 'darwin')).toBe(false);
    expect(isStrictlyUnder('/s/20261005-010203', '/s', 'darwin')).toBe(true);
    expect(isStrictlyUnder('C:\\S', 'c:\\s', 'win32')).toBe(false);
    expect(isStrictlyUnder('C:\\s\\20261005-010203', 'c:\\S', 'win32')).toBe(true);
  });
});

describe('samePath と pathKey', () => {
  it('Windows だけ大文字小文字を畳む', () => {
    expect(samePath('D:\\A', 'd:\\a', 'win32')).toBe(true);
    expect(samePath('/A', '/a', 'darwin')).toBe(false);
    expect(pathKey('D:\\Work', 'win32')).toBe('d:\\work');
    expect(pathKey('/Work', 'linux')).toBe('/Work');
  });
});
