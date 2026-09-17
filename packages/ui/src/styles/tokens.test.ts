import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('tokens.css', () => {
  it('必要なトークンをライトとダークの両方で定義する', () => {
    for (const t of ['--bg', '--surface', '--line', '--ink', '--ink-2', '--accent', '--busy', '--idle', '--waiting', '--ended', '--font-sans', '--font-mono', '--row-h', '--dur', '--ease']) {
      expect(css, t).toContain(`${t}:`);
    }
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect((css.match(/--accent:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('禁じた効果を使わない', () => {
    for (const bad of ['box-shadow: 0 0', 'text-shadow', '@keyframes pulse', '@keyframes shimmer', 'backdrop-filter']) expect(css).not.toContain(bad);
  });
});
