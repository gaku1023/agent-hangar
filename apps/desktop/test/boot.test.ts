import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Card = { u: number; id: number; ang: number; dy: number; op: number };
type BootFrames = { CYCLE_MS: number; SLOW_AFTER_MS: number; frameOf(T: number): Card[]; frameSvg(T: number): string; stillBootingText(ms: number): string | null };
// 読み込み画面は依存を持たない素の JS なので、型は試験の側で書く。
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading', 'boot-frames.js');
const m = (await import(pathToFileURL(file).href)) as BootFrames;
const byId = (T: number) => new Map(m.frameOf(T).map((c) => [c.id, c]));

describe('起動画面のハンガー', () => {
  // 仕様：角度と位置は、掛かる前後、送りの前後、周期の境目のどこでも途切れない。
  // 1ms ごとに見て、どの札もその間に動ける量より大きく跳ばないことを確かめる。
  it('どの札の位置、傾き、縦のずれ、不透明度も途切れない', () => {
    const limit = { u: 0.01, ang: 0.2, dy: 0.5, op: 0.02 };
    let prev = byId(2 * m.CYCLE_MS / 1000);
    for (let ms = 2 * m.CYCLE_MS + 1; ms <= 6 * m.CYCLE_MS; ms++) {
      const cur = byId(ms / 1000);
      for (const [id, c] of cur) {
        const p = prev.get(id);
        if (!p) continue;
        for (const k of ['u', 'ang', 'dy', 'op'] as const) expect(Math.abs(c[k] - p[k]), `${ms}ms の札 ${id} の ${k}`).toBeLessThan(limit[k]);
      }
      prev = cur;
    }
  });
  it('新しい札は透明から現れ、奥の札は霞に溶けてから消える', () => {
    for (let ms = 2 * m.CYCLE_MS; ms <= 6 * m.CYCLE_MS; ms++) {
      const T = ms / 1000;
      const before = byId(T - 0.001);
      for (const [id, c] of byId(T)) if (!before.has(id)) expect(c.op, `${ms}ms に現れた札 ${id}`).toBeLessThan(0.02);
      for (const [id, c] of before) if (!byId(T).has(id)) expect(c.op, `${ms}ms に消えた札 ${id}`).toBeLessThan(0.02);
    }
  });
  it('周期の境目では、札が静止した原図と同じ 1 本ずつの位置に並ぶ', () => {
    const us = m.frameOf(3 * m.CYCLE_MS / 1000).filter((c) => c.op > 0.5).map((c) => c.u).sort();
    expect(us).toEqual([1, 2, 3]);
  });
  it('描く SVG は竿のグラデーションと札を持つ', () => {
    const svg = m.frameSvg(1.2);
    expect(svg).toContain('<linearGradient id="RG"');
    expect((svg.match(/<rect x="-30"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('起動が長いときの文', () => {
  it('3 秒を超えたら「まだ起動しています（N 秒）」にする', () => {
    expect(m.stillBootingText(2999)).toBeNull();
    expect(m.stillBootingText(3000)).toBe('まだ起動しています（3 秒）');
    expect(m.stillBootingText(12_500)).toBe('まだ起動しています（12 秒）');
  });
});
