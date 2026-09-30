import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Card = { u: number; id: number; ang: number; dy: number; op: number };
type Finish = { cards: Card[]; scale: number; rings: number[]; bloom: number };
type Progress = { phase: 'idle' | 'scanning' | 'indexing' | 'rebuilding'; done: number; total: number };
type BootFrames = {
  CYCLE_MS: number; SLOW_AFTER_MS: number; BEAT_S: number; BLOOM_S: number; FINISH_MS: number;
  frameOf(T: number): Card[]; frameSvg(T: number): string; nearestBoundary(ms: number): number;
  dots(ms: number): string; slowSuffix(ms: number): string; detailText(p: Progress | null, ms: number): string;
  finishOf(Tb: number, tb: number): Finish; finishSvg(Tb: number, tb: number): string;
};
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
  // 失敗の文が出て止めるときは、いちばん近い周の境目の絵にする。
  it('止める絵は、経過にいちばん近い周の境目の時刻にする', () => {
    const C = m.CYCLE_MS;
    expect(m.nearestBoundary(0)).toBe(0);
    expect(m.nearestBoundary(C * 0.4)).toBe(0);
    expect(m.nearestBoundary(C * 0.6)).toBe(C / 1000);
    expect(m.nearestBoundary(3 * C - 20)).toBe(3 * C / 1000);
    expect(m.nearestBoundary(3 * C + 20)).toBe(3 * C / 1000);
    // 境目の絵は、送りを終えた並びである。新しい札はまだ降りてきていない。
    expect(m.frameOf(m.nearestBoundary(3 * C + 20)).filter((c) => c.op > 0.5).map((c) => c.u).sort()).toEqual([1, 2, 3]);
  });
  it('描く SVG は竿のグラデーションと札を持つ', () => {
    const svg = m.frameSvg(1.2);
    expect(svg).toContain('<linearGradient id="RG"');
    expect((svg.match(/<rect x="-30"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

// 仕様：読み込みが終わったら、周のどこからでも合図（K3「波紋が画面に広がる」）を打ち、続けて UI の背景の光を満たす（F4）。
// 周の境目は待たない。送りの途中の札は行き先まで運び切り、降りている途中の札はそのまま掛ける。
describe('読み込みが終わった合図', () => {
  const Tb = 3 * m.CYCLE_MS / 1000;
  const end = m.FINISH_MS / 1000;
  // 周の頭（境目）、札が降りている途中、掛かって揺れている間、送りの途中、送りの終わり際。
  const starts = [0, 0.1, 0.3, 0.45, 0.55, 0.62, 0.7, 0.8, 0.9, 0.97].map((x) => Tb + x * m.CYCLE_MS / 1000);
  const cardsById = (T: number, tb: number) => new Map(m.finishOf(T, tb).cards.map((c) => [c.id, c]));
  it('合図と光が満ちるまでの長さを足すと、殻が待つ長さになる', () => {
    expect(m.BEAT_S).toBe(0.5);
    expect(m.BLOOM_S).toBe(0.4);
    expect(m.FINISH_MS).toBe(Math.round((m.BEAT_S + m.BLOOM_S) * 1000));
  });
  it('始まりの絵は、合図に入った時刻のループの絵と同じ並びである', () => {
    const at = (cs: Card[]) => cs.filter((c) => c.op > 0.02).map((c) => ({ id: c.id, u: c.u.toFixed(4), ang: c.ang.toFixed(3), dy: c.dy.toFixed(3), op: c.op.toFixed(3) })).sort((a, b) => a.id - b.id);
    for (const T of starts) expect(at(m.finishOf(T, 0).cards), `${T}`).toEqual(at(m.frameOf(T)));
  });
  it('どこから合図に入っても、どの札の位置、傾き、縦のずれ、不透明度も途切れない', () => {
    // 最後の一枚は 34 の高さを合図の 35% で降りる。降り始めの速さ（eOut の傾き 3）が 1ms の縦のずれの上限になる。
    const limit = { u: 0.01, ang: 0.2, dy: (34 * 3) / (m.BEAT_S * 0.35) / 1000 + 0.01, op: 0.02 };
    for (const T of starts) {
      let prev = cardsById(T, 0);
      for (let ms = 1; ms <= m.FINISH_MS; ms++) {
        const cur = cardsById(T, ms / 1000);
        for (const [id, c] of cur) {
          const p = prev.get(id);
          if (!p) { expect(c.op, `${T} ${ms}ms に現れた札 ${id}`).toBeLessThan(0.02); continue; }
          for (const k of ['u', 'ang', 'dy', 'op'] as const) expect(Math.abs(c[k] - p[k]), `${T} ${ms}ms の札 ${id} の ${k}`).toBeLessThan(limit[k]);
        }
        for (const [id, p] of prev) if (!cur.has(id)) expect(p.op, `${T} ${ms}ms に消えた札 ${id}`).toBeLessThan(0.02);
        prev = cur;
      }
    }
  });
  it('どこから入っても、最後の一枚が手前に掛かり、静止した原図と同じ 4 枚の並びで締まる', () => {
    for (const T of starts) {
      const f = m.finishOf(T, m.BEAT_S);
      expect(f.cards.filter((c) => c.op > 0.98).map((c) => c.u).sort(), `${T}`).toEqual([0, 1, 2, 3]);
      expect(f.cards.every((c) => c.dy === 0), `${T}`).toBe(true);
      expect(m.finishOf(T, end).cards.map((c) => c.u).sort(), `${T}`).toEqual([0, 1, 2, 3]);
    }
  });
  it('ロゴは小さく一度弾んで、元の大きさに戻る', () => {
    const scales = Array.from({ length: m.FINISH_MS + 1 }, (_, ms) => m.finishOf(Tb, ms / 1000).scale);
    expect(scales[0]).toBe(1);
    expect(Math.max(...scales)).toBeCloseTo(1.07, 2);
    expect(Math.min(...scales)).toBe(1);
    expect(scales.at(-1)).toBe(1);
  });
  it('光の輪は二重に、ずれて広がり、光が満ち切る前に消える', () => {
    const r = (tb: number) => m.finishOf(Tb, tb).rings;
    expect(r(0)).toEqual([0, 0]);
    const mid = r(0.3);
    expect(mid[0]).toBeGreaterThan(mid[1]!);
    expect(mid[1]).toBeGreaterThan(0);
    expect(r(end)).toEqual([1, 1]);
  });
  it('光は合図の後に満ちる', () => {
    expect(m.finishOf(Tb, m.BEAT_S).bloom).toBe(0);
    expect(m.finishOf(Tb, (m.BEAT_S + end) / 2).bloom).toBeCloseTo(0.5, 5);
    expect(m.finishOf(Tb, end).bloom).toBe(1);
    expect(m.finishOf(Tb, end + 1).bloom).toBe(1);
  });
  it('描く SVG は竿と 4 枚の札を持つ', () => {
    const svg = m.finishSvg(Tb, end);
    expect(svg).toContain('<linearGradient id="RG"');
    expect((svg.match(/<rect x="-30"/g) ?? []).length).toBe(4);
  });
});

// 仕様：待っている間は「読み込み中」の後ろの点が 1 つ、2 つ、3 つと増えて戻る。周期はハンガーと同じ 1.6 秒。
// 3 秒を超えたら秒数を添える。最初の周の境目を過ぎてもまだ済んでいなければ、何をしているかを下に添える。
describe('待っている間の文', () => {
  it('点はハンガーの 1 周期で 1 つ、2 つ、3 つと増えて戻る', () => {
    const third = m.CYCLE_MS / 3;
    expect([0, third - 1, third, 2 * third, m.CYCLE_MS - 1, m.CYCLE_MS].map(m.dots)).toEqual(['.', '.', '..', '...', '...', '.']);
  });
  it('3 秒を超えたら「（N 秒）」を添える', () => {
    expect(m.slowSuffix(2999)).toBe('');
    expect(m.slowSuffix(3000)).toBe('（3 秒）');
    expect(m.slowSuffix(12_500)).toBe('（12 秒）');
  });
  it('最初の周の境目までは、何をしているかを出さない', () => {
    expect(m.detailText(null, m.CYCLE_MS - 1)).toBe('');
    expect(m.detailText({ phase: 'indexing', done: 1, total: 9 }, m.CYCLE_MS - 1)).toBe('');
  });
  it('境目を過ぎたら、今している段と件数を出す', () => {
    const late = m.CYCLE_MS;
    expect(m.detailText(null, late)).toBe('サーバを起動中');
    expect(m.detailText({ phase: 'scanning', done: 0, total: 0 }, late)).toBe('セッションを確認中');
    expect(m.detailText({ phase: 'idle', done: 0, total: 0 }, late)).toBe('セッションを確認中');
    expect(m.detailText({ phase: 'indexing', done: 412, total: 1201 }, late)).toBe('セッションを索引中 412 / 1,201 件');
    expect(m.detailText({ phase: 'rebuilding', done: 20, total: 987 }, late)).toBe('索引を作り直し中 20 / 987 件');
  });
});
