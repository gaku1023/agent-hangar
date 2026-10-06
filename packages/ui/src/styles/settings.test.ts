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
  it('名前の列は中身の幅（fit-content）で、状態の列が残りを取る。列の割合で名前の列を決めない', () => {
    const row = rule('.account-set-row');
    expect(row).toMatch(/grid-template-columns:\s*8px fit-content\(\d+em\) fit-content\(\d+px\) minmax\(0, 1fr\) 116px;/);
    expect(row).toContain('gap: calc(var(--u) * 3);');
  });
  it('狭い窓の 2 行の作りは、名前の列を 1fr のまま残す', () => {
    expect(css).toMatch(/@media \(max-width: 700px\) \{\s*\.account-set-row \{ grid-template-columns: 8px minmax\(0, 1fr\) auto;/);
  });
});
