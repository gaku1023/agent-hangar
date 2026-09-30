import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appIconSvg, BRAND_FILES, CURSORS, layout, logoSvg, mix, slots } from './logo.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const count = (s: string) => (s.match(/data-hanger="/g) ?? []).length;

describe('ロゴの原図', () => {
  it('色を混ぜる', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#1c1b2e', '#e2e7ff', 0)).toBe('#1c1b2e');
  });
  // 仕様の「原図」の表：4 本、1 本奥へ 0.85 倍、霞は奥の札で 86%。
  it('札は奥へ 0.85 倍ずつ小さくなり、奥ほど霞む', () => {
    const s = slots(4);
    expect(s.map((p) => Number(p.s.toFixed(4)))).toEqual([1, 0.85, 0.7225, 0.6141]);
    expect(s.map((p) => Number(p.t.toFixed(3)))).toEqual([0, 0.287, 0.573, 0.86]);
    expect(s[1]!.x).toBeGreaterThan(s[0]!.x);
    expect(s[1]!.y).toBeLessThan(s[0]!.y);
  });
  it('原図は 4 本、16px 用の図は先頭の 1 本だけ', () => {
    expect(count(logoSvg())).toBe(4);
    expect(count(logoSvg({ front: true }))).toBe(1);
    expect(logoSvg({ front: true })).not.toContain('hangar-rail');
  });
  it('先頭の札のカーソルは杏のまま、奥の札のカーソルには霞がかかる', () => {
    const svg = logoSvg();
    expect(svg).toContain(`fill="${CURSORS[0]}"`);
    expect(svg).not.toContain(`fill="${CURSORS[1]}"`);
  });
  // 仕様：群れ全体を、枠の中央の幅 70%、高さ 66% に収める。
  it('群れはアイコンの中央の枠（幅 70、高さ 66）に収まる', () => {
    const L = layout();
    for (const p of L.slots) {
      const left = L.tx + L.sc * (p.x - 31 * p.s), right = L.tx + L.sc * (p.x + 31 * p.s);
      const top = L.ty + L.sc * (p.y - 3 * p.s), bottom = L.ty + L.sc * (p.y + 69 * p.s);
      expect(left).toBeGreaterThanOrEqual(14.99);
      expect(right).toBeLessThanOrEqual(85.01);
      expect(top).toBeGreaterThanOrEqual(17.99);
      expect(bottom).toBeLessThanOrEqual(84.01);
    }
  });
  // サイドバーのワードマークは、原図の余白を切り落とした図を使う。竿の右端は群れより上へ伸びるので、それも含めて収める。
  it('余白を切り落とした図は 4 本のままで、竿と札が切り抜いた枠に収まる', () => {
    const svg = logoSvg({ crop: true });
    expect(count(svg)).toBe(4);
    const [x0, y0, w, h] = svg.match(/viewBox="([^"]+)"/)![1]!.split(' ').map(Number) as [number, number, number, number];
    expect(w).toBe(h);
    expect(w).toBeLessThanOrEqual(75);
    const L = layout();
    const inside = (x: number, y: number) => {
      expect(x).toBeGreaterThanOrEqual(x0);
      expect(x).toBeLessThanOrEqual(x0 + w);
      expect(y).toBeGreaterThanOrEqual(y0);
      expect(y).toBeLessThanOrEqual(y0 + h);
    };
    for (const p of L.slots) {
      inside(L.tx + L.sc * (p.x - 31 * p.s), L.ty + L.sc * (p.y - 3 * p.s));
      inside(L.tx + L.sc * (p.x + 31 * p.s), L.ty + L.sc * (p.y + 69 * p.s));
    }
    const rail = svg.match(/<path d="M(\S+) (\S+)L(\S+) (\S+)" stroke="url\(#hangar-rail\)" stroke-width="([\d.]+)"/)!.slice(1).map(Number);
    const pad = (rail[4]! / 2) * L.sc;
    for (const [x, y] of [[rail[0]!, rail[1]!], [rail[2]!, rail[3]!]] as const) {
      inside(L.tx + L.sc * x - pad, L.ty + L.sc * y - pad);
      inside(L.tx + L.sc * x + pad, L.ty + L.sc * y + pad);
    }
  });
  // macOS のアイコンは 1024 の枠の中に、824 の角丸の地を 100px 内側に置く。地の外は透明にする。
  it('アプリアイコンは 1024 の枠に、824 の地と原図の 4 本を置く', () => {
    const svg = appIconSvg();
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>');
    expect(count(svg)).toBe(4);
  });
});

describe('書き出したファイル', () => {
  it.each(BRAND_FILES.map((f) => [f.path, f] as const))('%s は原図の関数の出力と一致する（違えば npm run brand --workspace packages/ui）', (_p, f) => {
    expect(fs.readFileSync(path.join(repo, f.path), 'utf8')).toBe(f.make());
  });
});
