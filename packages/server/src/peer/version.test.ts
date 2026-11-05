import { describe, expect, it } from 'vitest';
import { versionAtLeast } from './version.ts';

describe('versionAtLeast', () => {
  it('major、minor、patch の順に比べ、rc の前置きは見ない', () => {
    expect(versionAtLeast('0.19.0', '0.19.0')).toBe(true);
    expect(versionAtLeast('0.19.0-rc.1', '0.19.0')).toBe(true);
    expect(versionAtLeast('0.18.9', '0.19.0')).toBe(false);
    expect(versionAtLeast('1.0.0', '0.19.3')).toBe(true);
    expect(versionAtLeast('0.19.10', '0.19.9')).toBe(true);
  });
  it('相手の版が無いか読めなければ false', () => {
    expect(versionAtLeast(null, '0.19.0')).toBe(false);
    expect(versionAtLeast('dev', '0.19.0')).toBe(false);
  });
});
