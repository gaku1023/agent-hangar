import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).flatMap((f) => [...strip(read(f)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! })));
const body = (selector: string) => { const r = rules.filter((x) => x.selector === selector); expect(r, selector).toHaveLength(1); return r[0]!.body; };

// 設計書 2026-10-02-session-motion の見た目の規則。
describe('右の欄の開閉', () => {
  it('列の幅は CSS の transition では動かさない（minmax と px の間は補間されない。paneMotion が px で動かす）', () => {
    expect(body('.split')).not.toContain('transition');
  });
  it('余白は欄の中身の側が持ち、閉じた列は幅 0 に収まる', () => {
    expect(body('.tr-pane')).not.toMatch(/padding:/);
    expect(body('.tr-pane-inner')).toMatch(/padding:/);
  });
  it('終わった画面の右の欄も、閉じたら 0px の列にして、列の数を変えない', () => {
    expect(body(".session-body[data-rail='closed']")).toMatch(/grid-template-columns: minmax\(0, 1fr\) 0px;/);
  });
});

describe('「いま」と目次の境目', () => {
  it('境目は上の段の高さそのもの（flex-basis）で、上限（max-height）ではない', () => {
    const top = body('.live-top');
    expect(top).toMatch(/flex: 0 1 calc\(var\(--live-split, 0\.5\) \* 100%\);/);
    expect(top).not.toMatch(/max-height/);
  });
  it('目次の下限は見出しと「最新へ」の 2 行ぶんで、5 行の下限は持たない', () => {
    expect(body('.live-toc')).not.toMatch(/\* 5\)/);
    expect(body('.live-toc')).toMatch(/min-height:/);
  });
  it('離した後と既定へ戻すときは滑らせ、ドラッグの間は追従させる', () => {
    expect(body('.live:not([data-dragging]) > .live-top')).toMatch(/transition: flex-basis var\(--dur\) var\(--ease-out\);/);
  });
});
