import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const base = fs.readFileSync(new URL('./base.css', import.meta.url), 'utf8');

describe('tokens.css', () => {
  it('必要なトークンをライトで定義する', () => {
    for (const t of ['--bg', '--surface', '--line', '--ink', '--ink-2', '--accent', '--busy', '--idle', '--waiting', '--ended', '--font-sans', '--font-mono', '--row-h', '--dur', '--dur-pop', '--ease']) {
      expect(css, t).toContain(`${t}:`);
    }
  });
  it('ダークモードを持たず、トークンは一度だけ定義する', () => {
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toContain('data-theme');
    expect((css.match(/--accent:/g) ?? []).length).toBe(1);
  });
  it('禁じた効果を使わない', () => {
    for (const bad of ['box-shadow: 0 0', 'text-shadow', '@keyframes pulse', '@keyframes shimmer', 'backdrop-filter']) expect(css).not.toContain(bad);
  });
});

describe('base.css', () => {
  it('動きの長さを直書きせず、reduced motion で 0 になるトークンだけを使う', () => {
    expect(base).not.toContain('120ms');
    expect(base).toContain('animation: pop var(--dur-pop) var(--ease)');
  });
});
