import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// サイドバーの実行中の行の丸の席（設計書の「入れ子」）。乗せたときに丸を隠して開閉の印に替えるのは、子を持つ行だけである。
const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('サイドバーの丸の席の CSS', () => {
  it('乗せたときに丸を隠すのは、開閉の印を持つ席（data-fold）だけ', () => {
    const rules = [...read('./base.css').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.side-live-seat[^,{]*> \.dot/.test(m[1]!) && /opacity: 0/.test(m[2]!));
    expect(rules.length).toBeGreaterThan(0);
    for (const m of rules) for (const sel of m[1]!.split(',')) expect(sel.trim()).toMatch(/\.side-live-seat\[data-fold='true'\] > \.dot$/);
  });
});
