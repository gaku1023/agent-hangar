import { describe, expect, it } from 'vitest';
import { neighborPane, type PaneRect } from './paneNeighbor.ts';

const r = (id: string, left: number, top: number, right: number, bottom: number): PaneRect => ({ id, left, top, right, bottom });

describe('隣のペインの求め方（neighborPane）', () => {
  // A | B のあいだに境目の 4px がある横 2 つ。
  const row = [r('a', 0, 0, 400, 600), r('b', 404, 0, 800, 600)];
  it('横に並ぶ 2 つは、右へ押すと右、左へ押すと左へ移る。端では動かない', () => {
    expect(neighborPane(row, 'a', 'right')).toBe('b');
    expect(neighborPane(row, 'b', 'left')).toBe('a');
    expect(neighborPane(row, 'a', 'left')).toBeNull();
    expect(neighborPane(row, 'b', 'right')).toBeNull();
    expect(neighborPane(row, 'a', 'up')).toBeNull();
    expect(neighborPane(row, 'a', 'down')).toBeNull();
  });
  // 左に A（縦いっぱい）、右に上下で B と C。
  const l = [r('a', 0, 0, 400, 600), r('b', 404, 0, 800, 296), r('c', 404, 300, 800, 600)];
  it('右の列が上下に割れているとき、上下の移りと左への戻りが画面の位置どおりになる', () => {
    expect(neighborPane(l, 'b', 'down')).toBe('c');
    expect(neighborPane(l, 'c', 'up')).toBe('b');
    expect(neighborPane(l, 'b', 'left')).toBe('a');
    expect(neighborPane(l, 'c', 'left')).toBe('a');
  });
  it('左の列が上下に割れているとき、右へは同じ高さのペインへ移る', () => {
    const rs = [r('a', 0, 0, 400, 300), r('b', 0, 304, 400, 600), r('c', 404, 0, 800, 600)];
    expect(neighborPane(rs, 'b', 'right')).toBe('c');
    expect(neighborPane(rs, 'c', 'left')).toBe('a');
  });
  it('遠い列は飛び越えない', () => {
    const three = [r('a', 0, 0, 200, 600), r('b', 204, 0, 400, 600), r('c', 404, 0, 600, 600)];
    expect(neighborPane(three, 'a', 'right')).toBe('b');
    expect(neighborPane(three, 'c', 'left')).toBe('b');
  });
  it('近さが同じなら、重なりの長い方を選ぶ', () => {
    const rs = [r('a', 0, 100, 400, 500), r('b', 404, 0, 800, 250), r('c', 404, 254, 800, 600)];
    // a の縦は 100〜500。b とは 150、c とは 246 重なる。
    expect(neighborPane(rs, 'a', 'right')).toBe('c');
  });
  it('重なる相手が無いとき（角どうし）は、向きの先で最も近いものへ移る', () => {
    const rs = [r('a', 0, 0, 400, 300), r('b', 404, 304, 800, 600)];
    expect(neighborPane(rs, 'a', 'right')).toBe('b');
    expect(neighborPane(rs, 'a', 'down')).toBe('b');
  });
  it('知らない id と、ペインが 1 つだけのときは null', () => {
    expect(neighborPane(row, 'zzz', 'right')).toBeNull();
    expect(neighborPane([r('a', 0, 0, 10, 10)], 'a', 'right')).toBeNull();
  });
});
