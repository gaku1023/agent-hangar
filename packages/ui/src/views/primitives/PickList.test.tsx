import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PickList, type PickItem } from './PickList.tsx';

const ITEMS: PickItem[] = [{ value: '', label: 'デフォルト' }, { value: 'new', label: 'New' }];
const OLDER: PickItem[] = [{ value: 'old-a', label: 'Old A' }, { value: 'old-b', label: 'Old B' }];

function Host(props: { value?: string; onPick?: (v: string) => void }) {
  const [value, setValue] = useState(props.value ?? '');
  return <PickList label="モデル" value={value} items={ITEMS} more={{ label: '過去のモデル', items: OLDER }} onPick={(v) => { props.onPick?.(v); setValue(v); }} />;
}
const names = () => screen.getAllByRole('option').map((o) => o.textContent);
const list = () => screen.getByRole('listbox', { name: 'モデル' });

describe('PickList の more（畳んだ行）', () => {
  it('はじめは畳んでおき、見出しを押すと開いて選べる', () => {
    const onPick = vi.fn();
    render(<Host onPick={onPick} />);
    const toggle = screen.getByRole('button', { name: '過去のモデル' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(names()).toEqual(['デフォルト', 'New']);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(names()).toEqual(['デフォルト', 'New', 'Old A', 'Old B']);
    fireEvent.click(screen.getByRole('option', { name: 'Old B' }));
    expect(onPick).toHaveBeenCalledWith('old-b');
  });
  it('選んでいる値が畳む側にあれば、開いて始める', () => {
    render(<Host value="old-a" />);
    expect(screen.getByRole('button', { name: '過去のモデル' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: 'Old A' })).toHaveAttribute('aria-selected', 'true');
  });
  it('↓ で見出しまで進み、Enter で開き、さらに ↓ で畳んでいた行へ入る', () => {
    const onPick = vi.fn();
    render(<Host onPick={onPick} />);
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    const toggle = screen.getByRole('button', { name: '過去のモデル' });
    expect(list()).toHaveAttribute('aria-activedescendant', toggle.id);
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('old-a');
  });
  it('見出しから開くと、開いた行が見えるところまで箱を送る（見出しを越えては送らない）', async () => {
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.pickScroll) return rect(0, 200);
      if (this.classList.contains('pick-more')) return rect(150, 180);
      if (this.classList.contains('pick-more-rows')) return rect(180, 400);
      return rect(0, 0);
    });
    render(<div data-pick-scroll="true"><Host /></div>);
    const box = screen.getByRole('listbox').parentElement!;
    box.scrollTo = vi.fn() as typeof box.scrollTo;
    fireEvent.click(screen.getByRole('button', { name: '過去のモデル' }));
    await vi.waitFor(() => expect(box.scrollTo).toHaveBeenCalledWith({ top: 150, behavior: 'smooth' }));
    spy.mockRestore();
  });
  it('畳んでいる間は、↓ が見出しで止まる', () => {
    render(<Host />);
    for (let i = 0; i < 5; i++) fireEvent.keyDown(list(), { key: 'ArrowDown' });
    expect(list()).toHaveAttribute('aria-activedescendant', screen.getByRole('button', { name: '過去のモデル' }).id);
  });
});
