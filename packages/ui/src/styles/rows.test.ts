import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SESSION_ROW_H } from '../views/SessionRows.tsx';

const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

describe('2 段の行', () => {
  // 仮想スクロールの見積もり（SESSION_ROW_H）と、CSS の高さがずれると、スクロールの位置が行の途中で止まる。
  it('行の高さは 44px で、tokens.css と SessionRows の見積もりが揃う', () => {
    expect(SESSION_ROW_H).toBe(44);
    expect(read('./tokens.css')).toContain(`--session-row-h: ${SESSION_ROW_H}px;`);
    expect(read('./rows.css')).toMatch(/\.row-2 \{[^}]*height: var\(--session-row-h\);/);
  });
  it('1 段の部品の高さ（--row-h）は 28px のまま', () => {
    expect(read('./tokens.css')).toContain('--row-h: 28px;');
  });
  it('一致した語の印は淡い地で、文字の色は変えない', () => {
    expect(read('./rows.css')).toMatch(/\.hit \{[^}]*background: var\(--hit\);[^}]*color: inherit;/);
  });
});
