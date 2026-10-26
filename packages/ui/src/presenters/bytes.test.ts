import { describe, expect, it } from 'vitest';
import { byteBase, bytesLabel } from './bytes.ts';

describe('容量の言い方', () => {
  it('Windows は 1024 で、macOS と Linux は 1000 で割る（OS のファイルの画面と同じ数になる）', () => {
    expect([byteBase('win32'), byteBase('darwin'), byteBase('linux')]).toEqual([1024, 1000, 1000]);
    // rc.1 では 3.8e9 バイトを 1024 で割って「3.5 GB」と書いていた。Finder は 3.8 GB と出す。
    expect(bytesLabel(3.8e9, 'darwin')).toBe('3.8 GB');
    expect(bytesLabel(3.8e9, 'win32')).toBe('3.5 GB');
  });

  it('GB は 10 未満なら小数 1 桁、MB と KB は整数', () => {
    expect([1.5e9, 18e9, 50e6, 2000, 0].map((n) => bytesLabel(n, 'darwin'))).toEqual(['1.5 GB', '18 GB', '50 MB', '2 KB', '0 KB']);
    expect([1_610_612_736, 18 * 1024 ** 3, 52_428_800, 2048, 0].map((n) => bytesLabel(n, 'win32'))).toEqual(['1.5 GB', '18 GB', '50 MB', '2 KB', '0 KB']);
  });

  it('足りない量は切り上げる（言った量を空ければ足りる）', () => {
    expect(bytesLabel(5.81e9, 'darwin')).toBe('5.8 GB');
    expect(bytesLabel(5.81e9, 'darwin', 'up')).toBe('5.9 GB');
    expect(bytesLabel(12.1e9, 'darwin', 'up')).toBe('13 GB');
    expect(bytesLabel(400.2e6, 'darwin', 'up')).toBe('401 MB');
    expect(bytesLabel(6e9, 'darwin', 'up')).toBe('6 GB');
  });
});
