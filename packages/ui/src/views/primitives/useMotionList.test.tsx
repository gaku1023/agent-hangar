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
let restore: (() => void) | null = null;
beforeEach(() => {
  restore = fakeMotionTokens(tokens, { everywhere: true });
  animations = []; finish = [];
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
    animations.push({ el: this, frames });
    const finished = new Promise<void>((r) => finish.push(r));
    return { finished, cancel: vi.fn() };
  };
});
afterEach(() => { restore?.(); restore = null; delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

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
  it('動きの長さが 0 なら、消えた key をすぐ外す', () => {
    restore?.();
    restore = fakeMotionTokens({ ...tokens, '--dur': '0ms', '--dur-fast': '0ms', '--dur-exit': '0ms' }, { everywhere: true });
    const { container, rerender } = render(<List items={['a', 'b']} />);
    rerender(<List items={['a']} />);
    expect(texts(container)).toEqual(['a']);
  });
});
