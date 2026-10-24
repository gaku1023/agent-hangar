import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton, type MenuItem } from './MenuButton.tsx';

const items = (onSelect = vi.fn()): MenuItem[] => [
  { key: 'term', label: 'ターミナルで開く', icon: 'openTerminal', note: '外部ターミナルで同じセッションに接続する', onSelect },
  { key: 'fork', label: 'フォーク', icon: 'fork', disabled: '実行中は押せません。停止すると押せます', onSelect },
  { key: 'sum', label: '要約を作り直す', icon: 'rebuild', onSelect },
  { key: 'stop', label: '停止', icon: 'stop', danger: true, onSelect },
];
const mount = (onSelect = vi.fn()) => {
  render(<MenuButton label="ほかの操作" items={items(onSelect)} />);
  const face = screen.getByRole('button', { name: 'ほかの操作' });
  return { face, onSelect, menuItems: () => screen.getAllByRole('menuitem') };
};

describe('MenuButton', () => {
  it('menu ボタンの作法で開き、最初の項目へフォーカスする', () => {
    const { face, menuItems } = mount();
    expect(face).toHaveAttribute('aria-haspopup', 'menu');
    expect(face).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(face);
    expect(face).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'ほかの操作' });
    expect(face).toHaveAttribute('aria-controls', menu.id);
    expect(document.activeElement).toBe(menuItems()[0]);
  });
  it('↓ ↑ で項目を移り、端では反対の端へ回る。Home と End で端へ', () => {
    const { face, menuItems } = mount();
    fireEvent.click(face);
    const at = () => menuItems().indexOf(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(at()).toBe(1);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(at()).toBe(3);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(at()).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(at()).toBe(3);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(at()).toBe(0);
  });
  it('閉じたボタンの ↓ は最初、↑ は最後の項目を開く', () => {
    const { face, menuItems } = mount();
    fireEvent.keyDown(face, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(menuItems()[3]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.keyDown(face, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuItems()[0]);
  });
  it('Enter で選ぶと閉じてボタンへフォーカスを戻す。Esc も閉じて戻す', () => {
    const { face, onSelect, menuItems } = mount();
    fireEvent.click(face);
    fireEvent.keyDown(menuItems()[2]!, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(face);
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(face);
  });
  it('押せない項目は理由を 1 行添え、選んでも何もしない', () => {
    const onSelect = vi.fn();
    const { face, menuItems } = mount(onSelect);
    fireEvent.click(face);
    const fork = menuItems()[1]!;
    expect(fork).toHaveAttribute('aria-disabled', 'true');
    expect(fork).toHaveTextContent('実行中は押せません。停止すると押せます');
    fireEvent.click(fork);
    fireEvent.keyDown(fork, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // 補足は押せる項目にも添える。
    expect(menuItems()[0]).toHaveTextContent('外部ターミナルで同じセッションに接続する');
  });
  it('title を持つ項目は、補足を画面に出さず title に入れる', () => {
    render(<MenuButton label="ほかの操作" items={[{ key: 'fork', label: 'フォーク', title: 'この会話から分岐した新しいセッション', onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'ほかの操作' }));
    const item = screen.getByRole('menuitem', { name: 'フォーク' });
    expect(item).toHaveAttribute('title', 'この会話から分岐した新しいセッション');
    expect(item.querySelector('small')).toBeNull();
  });
  it('危険な項目は区切りの後ろに危険色で置く', () => {
    const { face, menuItems } = mount();
    fireEvent.click(face);
    expect(menuItems()[3]).toHaveAttribute('data-danger', 'true');
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
  it('押すと選び、外を押すか Tab で離れると閉じる', () => {
    const { face, onSelect, menuItems } = mount();
    fireEvent.click(face);
    fireEvent.click(menuItems()[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(face);
    act(() => { fireEvent.mouseDown(document.body); });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('もう一度押すと閉じる', () => {
    const { face } = mount();
    fireEvent.click(face);
    fireEvent.click(face);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('打鍵の印のある項目は、その 1 字で選ぶ。修飾付きと押せない項目は選ばない', () => {
    const onSelect = vi.fn();
    const off = vi.fn();
    render(<MenuButton label="状態" items={[{ key: 'd', label: 'Done にする', kbd: 'd', onSelect }, { key: 'a', label: 'Archived にする', kbd: 'a', disabled: 'すでに Archived です', onSelect: off }]} />);
    fireEvent.click(screen.getByRole('button', { name: '状態' }));
    expect(screen.getAllByRole('menuitem')[0]!.querySelector('kbd')).toHaveTextContent('d');
    fireEvent.keyDown(document.activeElement!, { key: 'd', metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    expect(off).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('head は項目の前に置く読むだけの段で、フォーカスは最初の項目から始まる', () => {
    render(<MenuButton label="提案" head={<span>根拠の一文</span>} items={[{ key: 'ok', label: '確定', onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button', { name: '提案' }));
    const menu = screen.getByRole('menu', { name: '提案' });
    expect(menu.firstElementChild).toHaveClass('menu-head');
    expect(menu.firstElementChild).toHaveTextContent('根拠の一文');
    expect(document.activeElement).toBe(screen.getByRole('menuitem'));
  });
  it('separatorBefore の項目の前に区切りを置き、最初の危険な項目の前の区切りと重ねない', () => {
    const onSelect = vi.fn();
    render(<MenuButton label="メニュー" items={[
      { key: 'a', label: 'A', onSelect },
      { key: 'b', label: 'B', separatorBefore: true, onSelect },
      { key: 'c', label: 'C', danger: true, separatorBefore: true, onSelect },
      { key: 'd', label: 'D', danger: true, onSelect },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'メニュー' }));
    const menu = screen.getByRole('menu');
    expect([...menu.children].map((el) => (el.getAttribute('role') === 'separator' ? '|' : el.textContent))).toEqual(['A', '|', 'B', '|', 'C', 'D']);
  });
  it('checked を持つ項目は menuitemradio にし、aria-checked と ✓ で選んでいるものを示す。矢印と打鍵の印でも辿れる', () => {
    const onSelect = vi.fn();
    render(<MenuButton label="状態" items={[
      { key: 'x', label: 'X', checked: true, kbd: 'x', onSelect },
      { key: 'y', label: 'Y', checked: false, kbd: 'y', lead: <span className="st-dot" data-status="done" />, onSelect },
      { key: 'z', label: 'Z', separatorBefore: true, onSelect },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: '状態' }));
    const radios = screen.getAllByRole('menuitemradio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(radios[0]!.querySelector('.menu-check [data-icon="check"]')).not.toBeNull();
    expect(radios[1]!.querySelector('.menu-check [data-icon="check"]')).toBeNull();
    expect(radios[1]!.querySelector('.st-dot[data-status="done"]')).not.toBeNull();
    expect(screen.getByRole('menuitem')).toHaveTextContent('Z');
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem'));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
