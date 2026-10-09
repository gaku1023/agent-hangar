import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./readiness.css', import.meta.url), 'utf8');
/** セレクタがちょうど一致する規則の中身（入れ子の無い規則だけ）。 */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${esc} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
};

describe('Claude Code との互換の見た目（確認リストとずれの中身）', () => {
  it('未確認の版の印は、色を持たない灰色（--ink-3）にする', () => {
    expect(rule(".ck[data-tone='info'] > .icon")).toContain('color: var(--ink-3);');
  });
  it('止めた機能の点は注意の色にする', () => {
    expect(rule('.cp-stops li::before')).toContain('background: var(--st-paused);');
  });
  it('畳む印はブラウザの三角を消し、開くと矢印が 90 度回る', () => {
    expect(rule('.cp-more > summary')).toContain('list-style: none;');
    expect(rule('.cp-more > summary::-webkit-details-marker')).toContain('display: none;');
    expect(rule('.cp-more[open] > summary .icon')).toContain('transform: rotate(90deg);');
  });
  it('細目の表は列の幅を固定し、長い値は折り返して札からはみ出さない', () => {
    expect(rule('.cp-tab')).toContain('table-layout: fixed;');
    expect(rule('.cp-tab td')).toContain('overflow-wrap: anywhere;');
    expect(rule('.cp-tab td.cp-n')).toContain('white-space: nowrap;');
  });
});
