import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StepSlider } from './StepSlider.tsx';

const stops = [
  { value: 1, label: '1 分', tick: '1 分' },
  { value: 5, label: '5 分（推奨）', tick: '5 分' },
  { value: 60, label: '1 時間', tick: '1 時間' },
  { value: 0, label: 'しない', tick: 'しない' },
];

describe('StepSlider', () => {
  it('つまみは slider の役で、aria-valuetext にいまの名前（推奨の印つき）を持つ', () => {
    render(<StepSlider label="アンロード" stops={stops} value={5} onChange={() => {}} />);
    const k = screen.getByRole('slider', { name: 'アンロード' });
    expect(k).toHaveAttribute('aria-valuetext', '5 分（推奨）');
    expect(k).toHaveAttribute('aria-valuenow', '1');
  });

  it('目盛りの下に短い名前を並べ、1 時間としないの名前も出す', () => {
    render(<StepSlider label="x" stops={stops} value={1} onChange={() => {}} />);
    for (const t of ['1 分', '5 分', '1 時間', 'しない']) expect(screen.getByText(t)).toBeInTheDocument();
  });

  it('矢印キーでその場に onChange を呼び、端では動かない', () => {
    const onChange = vi.fn();
    render(<StepSlider label="x" stops={stops} value={5} onChange={onChange} />);
    const k = screen.getByRole('slider');
    fireEvent.keyDown(k, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(60);
    fireEvent.keyDown(k, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(k, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(k, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    onChange.mockClear();
    fireEvent.keyDown(k, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('右端の値でさらに右へ送っても呼ばない', () => {
    const onChange = vi.fn();
    render(<StepSlider label="x" stops={stops} value={0} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('引いている間は onChange を呼ばず、離したときに 1 度だけ呼ぶ', () => {
    const onChange = vi.fn();
    const { container } = render(<StepSlider label="x" stops={stops} value={1} onChange={onChange} />);
    const track = container.querySelector('.step-slider-track') as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, right: 300, bottom: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) });
    track.setPointerCapture = () => {};
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 });
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '5 分（推奨）');
    fireEvent.pointerMove(track, { clientX: 200, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it('引いて元の目盛りで離したときは呼ばない', () => {
    const onChange = vi.fn();
    const { container } = render(<StepSlider label="x" stops={stops} value={1} onChange={onChange} />);
    const track = container.querySelector('.step-slider-track') as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, right: 300, bottom: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) });
    track.setPointerCapture = () => {};
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
