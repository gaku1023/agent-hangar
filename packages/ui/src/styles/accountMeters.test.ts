import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// アカウントの札（views/primitives/AccountMeters.tsx）の、5 時間と週の行の列の決め方。
// 戻る時刻の文は「04:10 にリセット」から「10/17 04:00 にリセット」「Resets at 10/17 04:00」まで長さが変わる。
// 文の列を決め打ちの幅にすると、長い文が札の右の枠を越える（2026-10-12 に 92px の列で日付つきの文が 26px はみ出した）。
// そこで、文と % の列は中身の幅で取り、縮むのは棒の列だけにする。
// 2 本の行の列をそろえるため、行は札の中身の格子を subgrid で受け継ぐ。
// jsdom は配置を計算しないので、ここでは規則の形を押さえ、実際に収まるかは WebKit で撮って確かめる。
const css = fs.readFileSync(new URL('./controls.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
const body = (sel: string) => {
  const r = rules.filter((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
  expect(r.length, sel).toBeGreaterThan(0);
  return r.map((x) => x.body).join(';');
};
const decl = (b: string, prop: string) => b.match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`))?.[1]?.trim();
/** 括弧の中の空白で切らずに、格子の列の並びを分ける。 */
const tracks = (v: string) => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

describe('アカウントの札の行', () => {
  const meters = body('.account-meters');
  const cols = tracks(decl(meters, 'grid-template-columns') ?? '');

  it('札の中身は 4 列の格子で、行はその列を subgrid で受け継ぐ', () => {
    expect(decl(meters, 'display')).toBe('grid');
    expect(cols).toHaveLength(4);
    const row = body('.account-row');
    expect(decl(row, 'grid-template-columns')).toBe('subgrid');
    expect(decl(row, 'grid-column')).toMatch(/^1\s*\/\s*-1$/);
  });

  it('行でないもの（名前、メール、注記など）は 4 列をまたいで 1 行に置く', () => {
    expect(decl(body('.account-meters > *'), 'grid-column')).toMatch(/^1\s*\/\s*-1$/);
  });

  it('戻る時刻の文の列は決め打ちの幅にせず、中身の幅で取る', () => {
    expect(cols[3]).toBe('auto');
  });

  it('縮むのは棒の列だけで、読める下限を持つ', () => {
    const m = /^minmax\((\d+)px,\s*1fr\)$/.exec(cols[1] ?? '');
    expect(m, cols[1]).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(40);
  });

  it('% の列は 100% が入る幅を持つ', () => {
    // 11px の等幅で「100%」は 27px ほど。
    const m = /^(\d+)px$/.exec(cols[2] ?? '');
    expect(cols[2] === 'auto' || (m !== null && Number(m[1]) >= 32), cols[2]).toBe(true);
  });

  it('どの列にも決め打ちの幅を足したら、吹き出しの中に収まる', () => {
    // 吹き出しは 380px（AccountSwitcher の WIDTH）で、面の内側の余白と札の内側の余白を引くと、札の中身は 338px。
    // 名前の列、棒の下限、% の列、列の間を引いた残りが、いちばん長い文（英語の「Resets at 12/31 23:59」は 11px で 117px ほど）より広いこと。
    expect(cols).toHaveLength(4);
    const fixed = cols.map((c) => /^(\d+)px$/.exec(c)?.[1] ?? /^minmax\((\d+)px/.exec(c)?.[1] ?? '0').reduce((a, n) => a + Number(n), 0);
    const gap = 8 * (cols.length - 1);
    expect(338 - fixed - gap).toBeGreaterThanOrEqual(130);
  });
});
