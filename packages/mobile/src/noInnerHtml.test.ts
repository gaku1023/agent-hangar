import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const self = path.join(src, 'noInnerHtml.test.ts');

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return filesUnder(p);
    return /\.(ts|tsx)$/.test(e.name) && p !== self ? [p] : [];
  });
}

describe('画面の守り', () => {
  it('src/ の中に dangerouslySetInnerHTML と innerHTML の代入が無い', () => {
    const files = filesUnder(src);
    expect(files.length).toBeGreaterThan(5);
    const bad = files.filter((f) => {
      const s = fs.readFileSync(f, 'utf8');
      return /dangerouslySetInnerHTML/.test(s) || /\.(inner|outer)HTML\s*(\+?=)(?!=)/.test(s) || /insertAdjacentHTML|document\.write\(/.test(s);
    });
    expect(bad.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('index.html の script はどれも src を持つ（インラインの script が無い）', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toMatch(/\ssrc=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('styles.css に暗い配色の指定が無い', () => {
    const css = fs.readFileSync(path.join(src, 'styles.css'), 'utf8');
    expect(css).not.toMatch(/prefers-color-scheme/);
  });
});
