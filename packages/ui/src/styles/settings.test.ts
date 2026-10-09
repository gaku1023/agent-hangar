import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./settings.css', import.meta.url), 'utf8');
/** セレクタがちょうど一致する規則の中身（入れ子の無い規則だけ）。 */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${esc} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
};

describe('設定のアカウントの行', () => {
  // 名前と札は同じ列に入る。名前が min-width: 0 のまま縮められると、札（縮まない）に押されて名前が幅 0 まで消える。
  it('名前は縮めて消さない：縮まず、長すぎるときだけ上限で省略する', () => {
    const name = rule('.account-set-name');
    expect(name).toContain('flex: 0 0 auto;');
    expect(name).not.toMatch(/min-width:\s*0/);
    expect(name).toMatch(/max-width:\s*12em;/);
    expect(name).toContain('text-overflow: ellipsis;');
  });
  it('札は名前より先に縮み、折り返さない', () => {
    const tag = rule('.account-set-tag');
    expect(tag).toMatch(/flex:\s*0 1 auto;/);
    expect(tag).toContain('min-width: 0;');
    expect(tag).toContain('white-space: nowrap;');
    expect(tag).not.toMatch(/flex:\s*none/);
  });
  it('列は一覧が 1 つ持ち、名前の列と置き場の列は全行の中身の幅（fit-content）、状態の列が残りを取る。列の割合で名前の列を決めない', () => {
    const list = rule('.account-set-list');
    expect(list).toContain('display: grid;');
    expect(list).toMatch(/grid-template-columns:\s*calc\(8px \+ var\(--u\) \* 3\) fit-content\(\d+em\) fit-content\(\d+px\) minmax\(0, 1fr\) calc\(116px \+ var\(--u\) \* 3\);/);
    expect(list).toContain('column-gap: calc(var(--u) * 3);');
  });
  // 行ごとに自分の列を持つと、置き場と状態の左端が行ごとにずれる。
  it('li と行は一覧の列を subgrid で受け、全行で列の左端がそろう。行は自分の列を持たない', () => {
    expect(rule('.account-set')).toContain('grid-template-columns: subgrid;');
    expect(rule('.account-set')).toContain('grid-column: 1 / -1;');
    expect(rule('.account-set-row')).toContain('grid-template-columns: subgrid;');
    expect(rule('.account-set-row')).not.toMatch(/fit-content|minmax|\b116px/);
    // 色の帯と注意の行は、li の中で全幅に置く。
    expect(rule('.account-set > *')).toContain('grid-column: 1 / -1;');
  });
  it('狭い窓の 2 行の作りは、一覧の列を 3 列に替え、行は列を持たないまま', () => {
    expect(css).toMatch(/@media \(max-width: 700px\) \{\s*\.account-set-list \{ grid-template-columns: calc\(8px \+ var\(--u\) \* 3\) minmax\(0, 1fr\) auto; \}/);
    expect(css).toMatch(/\.account-set-dir, \.account-set-state \{ grid-column: 2 \/ 4; \}/);
  });
});

describe('Claude Code との互換の節と群の見出し', () => {
  it('未確認の版の札は、印を持たない灰色の地と縁にする', () => {
    expect(rule(".badge[data-tone='info']")).toBe(' color: var(--ink-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-strong); ');
  });
  it('版の並びは、狭い窓で折り返す', () => {
    expect(rule('.cp-vers')).toContain('flex-wrap: wrap;');
  });
  // 連携の群の添えに「Claude Code との互換」が増えたので、狭い窓で見出しがはみ出さないようにする。
  it('群の見出しは折り返し、行の間は空けない', () => {
    const h = rule('.settings-group-h');
    expect(h).toContain('flex-wrap: wrap;');
    expect(h).toContain('gap: 0 calc(var(--u) * 2);');
  });
});
