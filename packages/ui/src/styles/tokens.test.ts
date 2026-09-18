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

/** WCAG の相対輝度とコントラスト比。 */
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const token = (name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`))?.[1] ?? '';

describe('プロジェクトのステータスの色', () => {
  const statuses = ['active', 'paused', 'done', 'archived'];
  it('ステータスごとに文字色と淡い地色を持つ', () => {
    for (const s of statuses) { expect(token(`--st-${s}`), s).toMatch(/^#/); expect(token(`--st-${s}-soft`), s).toMatch(/^#/); }
  });
  it('淡い地色の上の文字は 4.5:1 以上で読める', () => {
    for (const s of statuses) expect(contrast(token(`--st-${s}`), token(`--st-${s}-soft`)), s).toBeGreaterThanOrEqual(4.5);
  });
  it('色だけで 4 つを見分けられる（互いに違う色である）', () => {
    expect(new Set(statuses.map((s) => token(`--st-${s}`))).size).toBe(4);
  });
  it('フォーカスの輪は外側の 1 本だけにし、透明な select 自身の輪は消して二重にしない', () => {
    expect(base).toContain('.status-pill:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }');
    expect(base).toContain('.status-select:focus-visible { outline: none; }');
  });
  it('base.css は data-status でトークンを引き、色を直書きしない', () => {
    for (const s of statuses) expect(base, s).toContain(`[data-status='${s}']`);
    const block = base.slice(base.indexOf('/* プロジェクトのステータス'));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
