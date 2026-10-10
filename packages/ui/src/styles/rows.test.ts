import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECTION_HEAD_H, SESSION_ROW_H } from '../views/SessionRows.tsx';

const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

// コードの定数と CSS の寸法を突き合わせる。禁則ではないが、ずれると仮想スクロールの位置が行の途中で止まる。
describe('2 段の行', () => {
  it('行の高さは 56px で、tokens.css と SessionRows の見積もりが揃う', () => {
    expect(SESSION_ROW_H).toBe(56);
    expect(read('./tokens.css')).toContain(`--session-row-h: ${SESSION_ROW_H}px;`);
    expect(read('./rows.css')).toMatch(/\.row-2 \{[^}]*height: var\(--session-row-h\);/);
  });
  it('節の見出しの高さは 32px で、tokens.css と SessionRows の見積もりが揃う', () => {
    expect(SECTION_HEAD_H).toBe(32);
    expect(read('./tokens.css')).toContain(`--section-head-h: ${SECTION_HEAD_H}px;`);
    expect(read('./rows.css')).toMatch(/\.row-head \{[^}]*height: var\(--section-head-h\);/);
  });
});
