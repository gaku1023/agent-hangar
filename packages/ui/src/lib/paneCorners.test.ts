import { describe, expect, it } from 'vitest';
import type { PaneNode } from '../mediator/panes.ts';
import { cornerCarriedBy, cornerEqualize, cornerResizes, dominantAxis, findCorners, type PaneRect } from './paneCorners.ts';

const leaf = (id: string): PaneNode => ({ kind: 'pane', id, sessionId: null, toc: false });
const split = (id: string, dir: 'row' | 'col', ratio: number, a: PaneNode, b: PaneNode): PaneNode => ({ kind: 'split', id, dir, ratio, a, b });
const clamp = (r: number, size: number) => { const m = 280 / size; return size >= 560 ? Math.min(1 - m, Math.max(m, r)) : Math.min(0.9, Math.max(0.1, r)); };

describe('findCorners', () => {
  const T = split('n1', 'row', 0.5, leaf('p1'), split('n2', 'col', 0.5, leaf('p2'), leaf('p3')));
  const X = (ra: number, rb: number) => split('n1', 'row', 0.5, split('n2', 'col', ra, leaf('p1'), leaf('p2')), split('n3', 'col', rb, leaf('p3'), leaf('p4')));
  const three = split('n1', 'row', 1 / 3, split('n2', 'col', 0.5, leaf('p1'), leaf('p2')), split('n3', 'row', 0.5, split('n4', 'col', 0.5, leaf('p3'), leaf('p4')), leaf('p5')));
  it.each([
    ['1 枚、角なし', leaf('p1'), []],
    ['左右だけ、角なし', split('n1', 'row', 0.5, leaf('p1'), leaf('p2')), []],
    ['同じ向きの入れ子、角なし', split('n1', 'row', 0.5, leaf('p1'), split('n2', 'row', 0.5, leaf('p2'), leaf('p3'))), []],
    ['T 字（右が上下）', T, [{ node: 'n1', children: [{ id: 'n2', side: 'b' }] }]],
    ['T 字（左が上下）', split('n1', 'row', 0.5, split('n2', 'col', 0.5, leaf('p1'), leaf('p2')), leaf('p3')), [{ node: 'n1', children: [{ id: 'n2', side: 'a' }] }]],
    ['十字（分け目がそろう）は 1 つ', X(0.5, 0.5), [{ node: 'n1', children: [{ id: 'n2', side: 'a' }, { id: 'n3', side: 'b' }] }]],
    ['分け目がずれたら 2 つの T 字', X(0.4, 0.6), [{ node: 'n1', children: [{ id: 'n2', side: 'a' }] }, { node: 'n1', children: [{ id: 'n3', side: 'b' }] }]],
    ['3 列で 2 つの角', three, [{ node: 'n1', children: [{ id: 'n2', side: 'a' }] }, { node: 'n3', children: [{ id: 'n4', side: 'a' }] }]],
  ] as const)('%s', (_name, root, want) => {
    expect(findCorners(root as PaneNode).map((c) => ({ node: c.node, children: c.children }))).toEqual(want);
  });
  it('角の id は一意で、十字は先頭の子の境目が持つ', () => {
    const cs = findCorners(X(0.5, 0.5));
    expect(new Set(findCorners(X(0.4, 0.6)).map((c) => c.id)).size).toBe(2);
    expect(cornerCarriedBy(cs, 'n1', 'n2')).toBe(cs[0]);
    expect(cornerCarriedBy(cs, 'n1', 'n3')).toBeUndefined();
  });
});

describe('cornerResizes', () => {
  const T = split('n1', 'row', 0.5, leaf('p1'), split('n2', 'col', 0.5, leaf('p2'), leaf('p3')));
  const corner = findCorners(T)[0]!;
  const rects: Record<string, PaneRect> = { n1: { left: 0, top: 0, width: 1000, height: 800 }, n2: { left: 500, top: 0, width: 500, height: 800 } };
  const start = { n1: 0.5, n2: 0.5 };
  it('横は親、縦は子の比率になる', () => {
    expect(cornerResizes(corner, rects, { x: 300, y: 300 }, clamp)).toEqual([{ node: 'n1', ratio: 0.3 }, { node: 'n2', ratio: 0.375 }]);
  });
  it('最小の大きさを守る', () => {
    expect(cornerResizes(corner, rects, { x: 10, y: 790 }, clamp)).toEqual([{ node: 'n1', ratio: 0.28 }, { node: 'n2', ratio: 1 - 280 / 800 }]);
  });
  it('⇧ の軸固定は、もう一方を始めの比率に留める', () => {
    expect(cornerResizes(corner, rects, { x: 300, y: 300 }, clamp, 'x', start)).toEqual([{ node: 'n1', ratio: 0.3 }, { node: 'n2', ratio: 0.5 }]);
    expect(cornerResizes(corner, rects, { x: 300, y: 300 }, clamp, 'y', start)).toEqual([{ node: 'n1', ratio: 0.5 }, { node: 'n2', ratio: 0.375 }]);
  });
  it('親が col のときは縦が親、横が子', () => {
    const root = split('n1', 'col', 0.5, split('n2', 'row', 0.5, leaf('p1'), leaf('p2')), leaf('p3'));
    const r = { n1: { left: 0, top: 0, width: 1000, height: 800 }, n2: { left: 0, top: 0, width: 1000, height: 400 } };
    expect(cornerResizes(findCorners(root)[0]!, r, { x: 400, y: 400 }, clamp)).toEqual([{ node: 'n1', ratio: 0.5 }, { node: 'n2', ratio: 0.4 }]);
  });
  it('十字は 3 つの節を動かす', () => {
    const root = split('n1', 'row', 0.5, split('n2', 'col', 0.5, leaf('p1'), leaf('p2')), split('n3', 'col', 0.5, leaf('p3'), leaf('p4')));
    const r = { n1: rects.n1!, n2: { left: 0, top: 0, width: 500, height: 800 }, n3: { left: 500, top: 0, width: 500, height: 800 } };
    expect(cornerResizes(findCorners(root)[0]!, r, { x: 600, y: 400 }, clamp).map((x) => x.node)).toEqual(['n1', 'n2', 'n3']);
  });
  it('軸の判定は動きの大きいほう', () => {
    expect(dominantAxis({ x: 0, y: 0 }, { x: 10, y: 3 })).toBe('x');
    expect(dominantAxis({ x: 0, y: 0 }, { x: 2, y: -9 })).toBe('y');
  });
  it('ダブルクリックは関わる節だけ 0.5', () => {
    expect(cornerEqualize(corner)).toEqual([{ node: 'n1', ratio: 0.5 }, { node: 'n2', ratio: 0.5 }]);
  });
});
