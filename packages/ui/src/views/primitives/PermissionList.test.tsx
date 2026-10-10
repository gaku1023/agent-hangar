import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageRoot } from './language.tsx';
import { PermissionList } from './PermissionList.tsx';
import { PERMISSION_MODES, permissionLabel } from './permissionModel.ts';

const list = () => screen.getByRole('listbox', { name: '権限モード' });
const labels = () => within(list()).getAllByRole('option').map((o) => o.textContent?.replace('前回', '').trim());

describe('PermissionList（権限モードの縦の一覧）', () => {
  it('既定、Plan、Manual、Accept edits、Auto、Don\'t ask、Bypass permissions の順に並べる', () => {
    render(<PermissionList value="" onChange={() => {}} />);
    expect(labels()).toEqual(['既定', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask", 'Bypass permissions']);
    expect(PERMISSION_MODES.map((m) => m.value)).toEqual(['', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
  });
  it('権限モードの名前は English では訳さず、既定だけが言語で替わる', () => {
    render(<LanguageRoot language="en"><PermissionList value="" onChange={() => {}} /></LanguageRoot>);
    const en = screen.getByRole('listbox', { name: 'Permission mode' });
    expect(within(en).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask", 'Bypass permissions']);
  });
  it('Bypass permissions だけ、線の下に、赤の印と警告の印で置く', () => {
    render(<PermissionList value="" onChange={() => {}} />);
    const options = within(list()).getAllByRole('option');
    const bypass = options[options.length - 1]!;
    expect(bypass).toHaveAttribute('data-danger', 'true');
    expect(bypass.querySelector('[data-icon="warning"]')).not.toBeNull();
    expect(options.slice(0, -1).some((o) => o.hasAttribute('data-danger'))).toBe(false);
    // 線は Bypass permissions の直前にだけあり、読み上げには出さない。
    const seps = list().querySelectorAll('.pick-sep');
    expect(seps).toHaveLength(1);
    expect(seps[0]).toHaveAttribute('aria-hidden', 'true');
    expect(seps[0]!.nextElementSibling).toBe(bypass);
  });
  it('選んでいる値に aria-selected を付け、前回の値にだけ「前回」を添える', () => {
    render(<PermissionList value="plan" previous="acceptEdits" onChange={() => {}} />);
    const selected = within(list()).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected.map((o) => o.textContent)).toEqual(['Plan']);
    expect(within(list()).getByRole('option', { name: /Accept edits/ })).toHaveTextContent('前回');
    expect(screen.getAllByText('前回')).toHaveLength(1);
  });
  it('前回が無ければ「前回」は出さない', () => {
    render(<PermissionList value="" onChange={() => {}} />);
    expect(screen.queryByText('前回')).toBeNull();
  });
  it('行を押すとその値を渡す', () => {
    const onChange = vi.fn();
    render(<PermissionList value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('option', { name: 'Auto' }));
    fireEvent.click(screen.getByRole('option', { name: /Bypass permissions/ }));
    fireEvent.click(screen.getByRole('option', { name: '既定' }));
    expect(onChange.mock.calls).toEqual([['auto'], ['bypassPermissions'], ['']]);
  });
  it('↑ ↓ で印を動かし、Enter で選ぶ。動かしただけでは選ばない。端では止まる', () => {
    const onChange = vi.fn();
    render(<PermissionList value="manual" onChange={onChange} />);
    const box = list();
    // 開いた直後の印は、選んでいる値の行にある。
    const active = () => box.querySelector('[data-active="true"]')?.textContent;
    expect(active()).toBe('Manual');
    expect(box.getAttribute('aria-activedescendant')).toBe(box.querySelector('[data-active="true"]')!.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(active()).toBe('Accept edits');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(active()).toBe('Plan');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('plan');
    // 端で止まる（回らない）。
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(active()).toBe('既定');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(active()).toBe('既定');
  });
  it('Home と End で端へ、Space でも選べる。End は Bypass permissions で、赤い行に印が移る', () => {
    const onChange = vi.fn();
    render(<PermissionList value="" onChange={onChange} />);
    const box = list();
    fireEvent.keyDown(box, { key: 'End' });
    expect(box.querySelector('[data-active="true"]')).toHaveAttribute('data-danger', 'true');
    fireEvent.keyDown(box, { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('bypassPermissions');
    fireEvent.keyDown(box, { key: 'Home' });
    expect(box.querySelector('[data-active="true"]')?.textContent).toBe('既定');
  });
  it('Enter と Space は外へ伝えない（起動のダイアログが Enter で起動しないため）', () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><PermissionList value="" onChange={() => {}} /></div>);
    fireEvent.keyDown(list(), { key: 'Enter' });
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    expect(outer).not.toHaveBeenCalled();
    // 扱わない打鍵（Esc、Tab）は外へ通す。Popover が閉じるのに使う。
    fireEvent.keyDown(list(), { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });
  it('選んだ値が変わったら、選んでいる印も付け替わる', () => {
    function Host() {
      const [v, setV] = useState('');
      return <PermissionList value={v} onChange={setV} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('option', { name: "Don't ask" }));
    expect(screen.getByRole('option', { name: "Don't ask" })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '既定' })).toHaveAttribute('aria-selected', 'false');
  });
  it('開いたときに焦点を受けられるよう、data-autofocus を持ち、Tab で入れる', () => {
    render(<PermissionList value="" onChange={() => {}} />);
    expect(list()).toHaveAttribute('data-autofocus');
    expect(list()).toHaveAttribute('tabindex', '0');
  });
});

describe('permissionLabel', () => {
  const t = (key: string) => (key === 'launch.value.default' ? '既定' : key);
  it('値から表示名を引く。空は既定、知らない値はそのまま出す', () => {
    expect(permissionLabel('', t as never)).toBe('既定');
    expect(permissionLabel('acceptEdits', t as never)).toBe('Accept edits');
    expect(permissionLabel('bypassPermissions', t as never)).toBe('Bypass permissions');
    expect(permissionLabel('futureMode', t as never)).toBe('futureMode');
  });
});
