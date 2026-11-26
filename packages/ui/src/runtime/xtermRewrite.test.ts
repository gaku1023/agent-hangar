import { describe, expect, it } from 'vitest';
import { paletteRgb } from './xtermRewrite.ts';

describe('paletteRgb', () => {
  it('256 色の番号を、16 色・6 段の立方体・灰色の段の RGB にする', () => {
    expect(paletteRgb(1)).toBe(0xcc0000);
    // Claude Code の札の問い（38;5;231）と説明（38;5;246）。
    expect(paletteRgb(231)).toBe(0xffffff);
    expect(paletteRgb(246)).toBe(0x949494);
    expect(paletteRgb(16)).toBe(0x000000);
    expect(paletteRgb(153)).toBe(0xafd7ff);
  });
});
