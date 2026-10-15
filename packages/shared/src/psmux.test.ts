import { describe, expect, it } from 'vitest';
import { PSMUX_MIN_VERSION, PSMUX_UPGRADE_COMMAND, psmuxTooOld } from './psmux.ts';

describe('psmuxTooOld', () => {
  it('3.4.0 未満を古いとする', () => {
    expect(PSMUX_MIN_VERSION).toBe('3.4.0');
    for (const v of ['3.3.8', '3.3.5', '3.3', '2.9.9', 'v3.3.8']) expect(psmuxTooOld(v), v).toBe(true);
  });
  it('3.4.0 以上は古くない（桁は数で比べる）', () => {
    for (const v of ['3.4.0', '3.4', '3.4.1', '3.10.0', '4.0.0']) expect(psmuxTooOld(v), v).toBe(false);
  });
  // 誤検知を避ける。読めない形は「古い」と言わない。
  it('版が無いか、読めない形なら古いとしない', () => {
    for (const v of [null, '', '3', 'next-3.5a', '3.3.8a', '3.3.8-rc1', 'abc']) expect(psmuxTooOld(v), String(v)).toBe(false);
  });
  it('上げるコマンドは、psmux を止めてから winget で上げ、版を見せる 1 行である', () => {
    expect(PSMUX_UPGRADE_COMMAND).toBe('Get-Process psmux -ErrorAction SilentlyContinue | Stop-Process -Force; winget upgrade marlocarlo.psmux; tmux -V');
  });
});
