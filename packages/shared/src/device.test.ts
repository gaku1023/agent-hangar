import { describe, expect, it } from 'vitest';
import { osName } from './device.ts';
import { translator } from './i18n/t.ts';

describe('osName', () => {
  it('知っている platform は OS の名前に、知らない値はそのまま、無ければ null', () => {
    const t = translator('ja');
    expect(osName(t, 'darwin')).toBe('macOS');
    expect(osName(t, 'win32')).toBe('Windows');
    expect(osName(t, 'linux')).toBe('Linux');
    expect(osName(t, 'freebsd')).toBe('freebsd');
    expect(osName(t, null)).toBeNull();
    expect(osName(translator('en'), 'win32')).toBe('Windows');
  });
});
