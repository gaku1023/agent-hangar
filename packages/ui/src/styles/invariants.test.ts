import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// 字の太さ（weights.test.ts）、ガラス（glass.test.ts）、トークンの直書き（tokens.test.ts）のどれにも当たらない、全体の決まり。
const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
const css = read('tokens.css');
const base = read('base.css');

describe('全体の決まり', () => {
  it('ダークモードを持たず、トークンは一度だけ定義する', () => {
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toContain('data-theme');
    expect((css.match(/--accent:/g) ?? []).length).toBe(1);
  });
  it('禁じた効果を使わない', () => {
    for (const bad of ['text-shadow', '@keyframes pulse', '@keyframes shimmer', '@keyframes skeleton', 'backdrop-filter:']) expect(css).not.toContain(bad);
  });
  it('古いトークンの名前は、定義にも参照にも残さない', () => {
    for (const f of sheets) {
      const sheet = strip(read(f));
      for (const old of ['--dur-slow', '--dur-pop', 'var(--ease)', '--ease:']) expect(sheet, `${f}: ${old}`).not.toContain(old);
    }
  });
  it('ヘッダの右の列を、決め打ちの幅のコンテナクエリで畳まない（畳むのは測る仕組みだけ）', () => {
    expect(strip(base)).not.toMatch(/@container header \(max-width/);
  });
  it('窓の高さから決め打ちで引いた高さ（100vh）を、セッション画面の箱に使わない', () => {
    for (const f of sheets) {
      for (const m of strip(read(f)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/\.split\b|\.tr\b|\.tr-sheet|\.session-/.test(m[1]!)) expect(m[2], `${f}: ${m[1]!.trim()}`).not.toMatch(/100vh/);
      }
    }
  });
  it('.shell は overflow: clip で、hidden にしない（どのコードからもスクロールさせない）', () => {
    const b = [...strip(base).matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === '.shell')?.[2] ?? '';
    expect(b).toMatch(/overflow: clip;/);
    expect(b).not.toMatch(/overflow: hidden;/);
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

describe('文字の読める濃さ（WCAG 4.5:1）', () => {
  // ガラスは白 40% を地（--bg）に重ねた色になる。その上に本文と補足の文が載る。
  it('本文と補足の文は、白地とガラスの上の両方で読める', () => {
    const glass = over(token('--bg'), 0.4);
    expect(glass).toBe('#f5f7fa');
    for (const t of ['--ink', '--ink-2']) {
      expect(contrast(token(t), token('--surface')), `${t} / surface`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(t), glass), `${t} / glass`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('注記の色は白地で、主ボタンの白い文字は主の地で読める', () => {
    expect(contrast(token('--ink-3'), token('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--accent-ink'), token('--accent'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--surface'), token('--st-paused'))).toBeGreaterThanOrEqual(4.5);
  });
  it('候補の色の文字は、淡い紫の地、白地、淡い青の地で読める', () => {
    expect(contrast(token('--cand'), token('--cand-soft'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--cand'), token('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--cand'), token('--accent-soft'))).toBeGreaterThan(4.5);
    expect(contrast(token('--ink-2'), token('--cand-soft'))).toBeGreaterThanOrEqual(4.5);
  });
  it('危険の赤は白地で、赤で塗ったボタンの白い文字も読める', () => {
    expect(contrast(token('--error'), token('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('--error'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('--st-paused'))).toBeGreaterThan(4.5);
  });
  it('セッションとプロジェクトの状態の色は、淡い地の上で読める', () => {
    for (const s of ['active', 'paused', 'done', 'archived']) expect(contrast(token(`--st-${s}`), token(`--st-${s}-soft`)), s).toBeGreaterThanOrEqual(4.5);
  });
});
