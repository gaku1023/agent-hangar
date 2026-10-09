import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// 色と動きの値は tokens.css のトークンを通して書く。ここに散らさない。
const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
/** 宣言を（名前、値）の組で取り出す。 */
const decls = (css: string) => [...strip(css).matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({ prop: m[1]!, value: m[2]!.trim() }));

describe('CSS はトークンを通して書く', () => {
  it('transition と animation の長さは、トークンを通して書く', () => {
    for (const f of sheets.filter((f) => f !== 'tokens.css')) {
      for (const d of decls(read(f)).filter((d) => /^(transition|animation)(-duration|-delay)?$/.test(d.prop))) {
        expect(d.value, `${f}: ${d.prop}: ${d.value}`).not.toMatch(/(^|[\s,(])\d+(\.\d+)?m?s\b/);
      }
    }
  });
  it('base.css のステータスの札は、data-status でトークンを引き、色を直書きしない', () => {
    const base = read('base.css');
    for (const s of ['active', 'paused', 'done', 'archived']) expect(base, s).toContain(`[data-status='${s}']`);
    const block = base.slice(base.indexOf('/* プロジェクトのステータス'));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

describe('JS の動きはトークンを通して書く', () => {
  const src = (p: string) => fs.readFileSync(new URL(`../views/primitives/${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  it('FLIP の滑り、サイドバーの開閉、出入りの形は、ミリ秒を直書きしない', () => {
    for (const f of ['flip.ts', 'sidebarMotion.ts', 'motionKit.ts']) expect(src(f), f).not.toMatch(/\d+ms/);
  });
  it('数字の回転は、待ちの長さを直書きしない', () => {
    expect(src('RollingText.tsx')).not.toMatch(/setTimeout\([^)]*,\s*\d+\)/);
  });
});
