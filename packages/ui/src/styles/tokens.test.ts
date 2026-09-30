import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const base = fs.readFileSync(new URL('./base.css', import.meta.url), 'utf8');

describe('tokens.css', () => {
  it('必要なトークンをライトで定義する', () => {
    for (const t of ['--bg', '--aura-1', '--aura-2', '--surface', '--line', '--ink', '--ink-2', '--ink-3', '--accent', '--accent-hi', '--busy', '--idle', '--waiting', '--ended', '--font-sans', '--font-mono', '--row-h',
      '--dur-fast', '--dur', '--dur-exit', '--ease-out', '--ease-in', '--rise', '--blur-in', '--breathe-period',
      '--glass-bg', '--glass-blur', '--glass-edge', '--glass-drop', '--r', '--r-lg', '--r-xl', '--r-pill', '--float-gap', '--header-h', '--aura-period']) {
      expect(css, t).toContain(`${t}:`);
    }
  });
  it('ダークモードを持たず、トークンは一度だけ定義する', () => {
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toContain('data-theme');
    expect((css.match(/--accent:/g) ?? []).length).toBe(1);
  });
  // ぼかしは base.css などの、浮く部品の規則にだけ書く（glass.test.ts が見張る）。トークンは値だけを持つ。
  it('禁じた効果を使わない', () => {
    for (const bad of ['text-shadow', '@keyframes pulse', '@keyframes shimmer', '@keyframes skeleton', 'backdrop-filter:']) expect(css).not.toContain(bad);
  });
  // ガラスは白 40% を地（--bg）に重ねた色になる。その上に本文と補足の文が載る。
  it('本文と補足の文は、白地とガラスの上の両方で 4.5:1 以上で読める', () => {
    const glass = over(token('--bg'), 0.4);
    expect(glass).toBe('#f5f7fa');
    for (const t of ['--ink', '--ink-2']) {
      expect(contrast(token(t), token('--surface')), `${t} / surface`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(t), glass), `${t} / glass`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('注記の色は白地で 3:1 以上、主ボタンの白い文字は 4.5:1 以上', () => {
    expect(contrast(token('--ink-3'), token('--surface'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('--accent-ink'), token('--accent'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('base.css', () => {
  it('ダイアログは --dur の長さと --ease-out の曲線で開く', () => {
    expect(base).toMatch(/\.dialog \{[^}]*animation: pop var\(--dur\) var\(--ease-out\)/);
  });
});

/** WCAG の相対輝度とコントラスト比。 */
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const token = (name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`))?.[1] ?? '';
/** 白を割合 a で色 hex に重ねた色。ガラスの見かけの地の色を出すのに使う。 */
const over = (hex: string, a: number) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - a) + 255 * a).toString(16).padStart(2, '0')).join('');

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
  it('札は本物のボタンなので、フォーカスの輪は base.css の :focus-visible に任せ、札の側で消さない', () => {
    expect(base).toContain(':focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }');
    const block = base.slice(base.indexOf('/* ステータスの札'), base.indexOf('.st-dot {'));
    expect(block).not.toMatch(/outline/);
    expect(base).not.toContain('.status-face');
    expect(base).not.toContain('.status-select');
  });
  it('base.css は data-status でトークンを引き、色を直書きしない', () => {
    for (const s of statuses) expect(base, s).toContain(`[data-status='${s}']`);
    const block = base.slice(base.indexOf('/* プロジェクトのステータス'));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
