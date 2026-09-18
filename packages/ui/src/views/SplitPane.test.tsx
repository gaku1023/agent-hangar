import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot, useEmit } from '../intent/chain.tsx';
import { SplitPane } from './SplitPane.tsx';

function Emitter() {
  const emit = useEmit();
  return <button onClick={() => emit({ type: 'overlay.close' })}>閉じる</button>;
}

const rect = (width: number) => () => ({ left: 0, top: 0, width, height: 500, right: width, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

describe('SplitPane', () => {
  it('幅の変更は中で処理し、Root には届かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SplitPane left={<div>左</div>} right={<div>右</div>} /></IntentRoot>);
    const host = screen.getByTestId('split');
    host.getBoundingClientRect = rect(1000);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(host.style.gridTemplateColumns.startsWith('0.3fr')).toBe(true);
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('離したあとは動かない', () => {
    render(<IntentRoot onIntent={() => {}}><SplitPane left={<div>左</div>} right={<div>右</div>} /></IntentRoot>);
    const host = screen.getByTestId('split');
    host.getBoundingClientRect = rect(1000);
    fireEvent.pointerDown(screen.getByRole('separator'), { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientX: 700 });
    expect(host.style.gridTemplateColumns.startsWith('0.3fr')).toBe(true);
  });
  it('矢印キーでも動き、0.2 から 0.8 に丸める', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SplitPane left={<div>左</div>} right={<div>右</div>} /></IntentRoot>);
    const host = screen.getByTestId('split');
    const sep = screen.getByRole('separator');
    for (let i = 0; i < 20; i++) fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(host.style.gridTemplateColumns.startsWith('0.2fr')).toBe(true);
    for (let i = 0; i < 40; i++) fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(host.style.gridTemplateColumns.startsWith('0.8fr')).toBe(true);
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('左右の中身をそのまま描く', () => {
    render(<IntentRoot onIntent={() => {}}><SplitPane left={<div>左</div>} right={<div>右</div>} /></IntentRoot>);
    expect(screen.getByText('左')).toBeInTheDocument();
    expect(screen.getByText('右')).toBeInTheDocument();
  });
  it('境界を通らない Intent はそのまま上へ渡す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SplitPane left={<Emitter />} right={<div>右</div>} /></IntentRoot>);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Escape' });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('閉じる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});
