import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../../test/motion.ts';
import { useMotionList, type MotionListOpts } from './useMotionList.ts';

function List(props: { items: string[]; opts?: Partial<MotionListOpts> }) {
  const { list, ref } = useMotionList(props.items, (s) => s, { enter: 'rise', ...props.opts });
  return <ul>{list.map((e) => <li key={e.key} ref={ref(e.key)} data-leaving={e.leaving ? 'true' : undefined}>{e.item}</li>)}</ul>;
}
const texts = (c: HTMLElement) => [...c.querySelectorAll('li')].map((li) => `${li.textContent}${li.dataset.leaving ? '*' : ''}`);

// jsdom は子要素へカスタムプロパティを継がせないので、どの要素でもトークンを返す。
const tokens = { '--dur': '420ms', '--dur-fast': '200ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' };
let animations: { el: Element; frames: Keyframe[] }[] = [];
let finish: (() => void)[] = [];
let fakes: { el: Element; cancel: () => void }[] = [];
let tops: Record<string, number> = {};
let restore: (() => void) | null = null;
beforeEach(() => {
  restore = fakeMotionTokens(tokens, { everywhere: true });
  animations = []; finish = []; fakes = []; tops = {};
  // jsdom は レイアウトを持たないので、行の位置は試験が決める。
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) { return new DOMRect(0, tops[this.textContent ?? ''] ?? 0, 10, 10); };
  (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = function (this: Element) { return fakes.filter((f) => f.el === this); };
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
    animations.push({ el: this, frames });
    const finished = new Promise<void>((r) => finish.push(r));
    const cancel = vi.fn();
    fakes.push({ el: this, cancel });
    return { finished, cancel };
  };
});
afterEach(() => {
  restore?.(); restore = null;
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  delete (HTMLElement.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

describe('useMotionList', () => {
  it('最初の描画と、空から埋まった描画では動かさない', () => {
    const { rerender } = render(<List items={[]} />);
    rerender(<List items={['a', 'b']} />);
    expect(animations).toHaveLength(0);
  });
  it('新しい key だけを入れる', () => {
    const { rerender } = render(<List items={['a']} />);
    rerender(<List items={['a', 'b']} />);
    expect(animations.map((a) => a.el.textContent)).toEqual(['b']);
  });
  it('消えた key は、出る動きが終わるまで元の位置に残す', async () => {
    const { container, rerender } = render(<List items={['a', 'b', 'c']} />);
    rerender(<List items={['a', 'c']} />);
    expect(texts(container)).toEqual(['a', 'b*', 'c']);
    await act(async () => { finish.forEach((f) => f()); });
    expect(texts(container)).toEqual(['a', 'c']);
  });
  it('key が全部入れ替わったら、出入りを動かさない（サブエージェントへの切り替えなど）', () => {
    const { container, rerender } = render(<List items={['a', 'b']} />);
    rerender(<List items={['x', 'y']} />);
    expect(texts(container)).toEqual(['x', 'y']);
    expect(animations).toHaveLength(0);
  });
  it('ignorePrepended では、先頭に足された行を動かさない', () => {
    const { rerender } = render(<List items={['b', 'c']} opts={{ ignorePrepended: true }} />);
    rerender(<List items={['a', 'b', 'c', 'd']} opts={{ ignorePrepended: true }} />);
    expect(animations.map((a) => a.el.textContent)).toEqual(['d']);
  });
  it('出る途中で戻った key は、出る動きを取り消して、残す', async () => {
    const { container, rerender } = render(<List items={['a', 'b', 'c']} />);
    rerender(<List items={['a', 'c']} />);
    const exit = fakes.filter((f) => f.el.textContent === 'b');
    expect(exit).toHaveLength(1);
    rerender(<List items={['a', 'b', 'c']} />);
    expect(exit[0]!.cancel).toHaveBeenCalled();
    expect(texts(container)).toEqual(['a', 'b', 'c']);
    // 取り消された出る動きが解決しても、戻った行を落とさない。
    await act(async () => { finish.forEach((f) => f()); });
    expect(texts(container)).toEqual(['a', 'b', 'c']);
  });
  it('並びが替わっていない描画では、位置が動いていても滑らせない', () => {
    tops = { a: 0, b: 20 };
    const { rerender } = render(<List items={['a', 'b']} />);
    tops = { a: 100, b: 120 };
    rerender(<List items={['a', 'b']} />);
    expect(animations).toHaveLength(0);
    // 並びが替わったら、前の位置から滑らせる。
    tops = { b: 0, a: 20 };
    rerender(<List items={['b', 'a']} />);
    expect(animations.map((a) => a.el.textContent).sort()).toEqual(['a', 'b']);
  });
  it('消えた行を外す描画では、残った行を滑らせない', async () => {
    tops = { a: 0, b: 20, c: 40 };
    const { rerender } = render(<List items={['a', 'b', 'c']} />);
    tops = { a: 0, b: 20, c: 20 };
    rerender(<List items={['a', 'c']} />);
    animations = [];
    await act(async () => { finish.forEach((f) => f()); });
    expect(animations).toHaveLength(0);
  });
  it('空になる描画は、消えた行を残さず、空から埋まる次の描画も動かさない（切り替えの途中の空）', () => {
    const { container, rerender } = render(<List items={['a', 'b']} />);
    rerender(<List items={[]} />);
    expect(texts(container)).toEqual([]);
    rerender(<List items={['x', 'y']} />);
    expect(texts(container)).toEqual(['x', 'y']);
    expect(animations).toHaveLength(0);
  });
  it('scope が替わった描画は、同じ key でも出入りも滑りも動かさない', () => {
    tops = { a: 0, b: 20 };
    const { container, rerender } = render(<List items={['a', 'b']} opts={{ scope: 's1' }} />);
    tops = { b: 0, a: 20 };
    rerender(<List items={['b', 'a', 'c']} opts={{ scope: 's2' }} />);
    expect(texts(container)).toEqual(['b', 'a', 'c']);
    expect(animations).toHaveLength(0);
    // scope が替わった描画で消えた行も、残さない。
    rerender(<List items={['b']} opts={{ scope: 's3' }} />);
    expect(texts(container)).toEqual(['b']);
    expect(animations).toHaveLength(0);
  });
  it('grow で先頭に足した行だけが伸びて入り、下の行は滑らせない（押されて動くだけ）', () => {
    tops = { a: 0, b: 20 };
    const { rerender } = render(<List items={['a', 'b']} opts={{ enter: 'grow' }} />);
    tops = { x: 0, a: 20, b: 40 };
    rerender(<List items={['x', 'a', 'b']} opts={{ enter: 'grow' }} />);
    expect(animations.map((a) => a.el.textContent)).toEqual(['x']);
  });
  it('足した行があっても、残った行の並びが替わったら滑らせる', () => {
    tops = { a: 0, b: 20 };
    const { rerender } = render(<List items={['a', 'b']} opts={{ enter: 'grow' }} />);
    tops = { x: 0, b: 10, a: 30 };
    rerender(<List items={['x', 'b', 'a']} opts={{ enter: 'grow' }} />);
    expect(animations.map((a) => a.el.textContent).sort()).toEqual(['a', 'b', 'x']);
  });
  it('消えた行が出始める描画でも、残った行の並びが同じなら滑らせない', () => {
    tops = { a: 0, b: 20, c: 40 };
    const { rerender } = render(<List items={['a', 'b', 'c']} />);
    tops = { a: 0, b: 20, c: 20 };
    rerender(<List items={['a', 'c']} />);
    expect(animations.map((a) => a.el.textContent)).toEqual(['b']);
  });
  it('flip が偽なら、行の位置を測らない（入る行は key だけで見分ける）', () => {
    let measured = 0;
    HTMLElement.prototype.getBoundingClientRect = function () { measured++; return new DOMRect(0, 0, 10, 10); };
    const { rerender } = render(<List items={['a']} opts={{ flip: false }} />);
    rerender(<List items={['a', 'b']} opts={{ flip: false }} />);
    rerender(<List items={['a', 'b']} opts={{ flip: false }} />);
    expect(measured).toBe(0);
    expect(animations.map((a) => a.el.textContent)).toEqual(['b']);
  });
  it('動きの長さが 0 なら、消えた key をすぐ外す', () => {
    restore?.();
    restore = fakeMotionTokens({ ...tokens, '--dur': '0ms', '--dur-fast': '0ms', '--dur-exit': '0ms' }, { everywhere: true });
    const { container, rerender } = render(<List items={['a', 'b']} />);
    rerender(<List items={['a']} />);
    expect(texts(container)).toEqual(['a']);
  });
});
