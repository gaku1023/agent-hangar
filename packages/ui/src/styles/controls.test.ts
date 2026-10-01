import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const controls = fs.readFileSync(new URL('./controls.css', import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...strip(controls).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
const body = (selector: string) => rules.filter((r) => r.selector === selector).map((r) => r.body).join(';');

// 一覧の下端の操作で、長いパスが縮まず、「『url』を新しいフ…」と見出しのほうが切れていた。
describe('一覧の下端の操作', () => {
  it('見出しは中身の幅を保ち、縮めるときはパスから縮める', () => {
    const label = body('.listbox-act-label');
    expect(label).toContain('flex: 0 1 auto;');
    expect(label).toContain('min-width: 0;');
    expect(label).toContain('text-overflow: ellipsis;');
    const sub = body('.listbox-act small');
    expect(sub).toContain('flex: 1 1 0;');
    expect(sub).toContain('min-width: 0;');
    expect(sub).toContain('text-align: right;');
    expect(sub).toContain('white-space: nowrap;');
    expect(sub).toContain('overflow: hidden;');
    expect(sub).toContain('text-overflow: ellipsis;');
  });
});
