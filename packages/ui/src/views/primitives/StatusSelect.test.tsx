import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectStatusDot, StatusSelect } from './StatusSelect.tsx';

describe('StatusSelect', () => {
  it('いまのステータスを data-status に出し、4 つの選択肢を持つ', () => {
    render(<StatusSelect label="alpha のステータス" value="paused" onChange={() => {}} />);
    const sel = screen.getByLabelText('alpha のステータス') as HTMLSelectElement;
    expect(sel.getAttribute('data-status')).toBe('paused');
    expect(sel.value).toBe('paused');
    expect([...sel.options].map((o) => o.value)).toEqual(['active', 'paused', 'done', 'archived']);
  });
  it('選び直すと新しいステータスを渡す', () => {
    const onChange = vi.fn();
    render(<StatusSelect label="s" value="active" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('s'), { target: { value: 'done' } });
    expect(onChange).toHaveBeenCalledWith('done');
  });
  it('クリックとキー入力は親へ伝えない（カードを開かせない）', () => {
    const onParent = vi.fn();
    render(<div onClick={onParent} onKeyDown={onParent}><StatusSelect label="s" value="active" onChange={() => {}} /></div>);
    fireEvent.click(screen.getByLabelText('s'));
    fireEvent.keyDown(screen.getByLabelText('s'), { key: 'Enter' });
    expect(onParent).not.toHaveBeenCalled();
  });
});

describe('StatusSelect の見た目', () => {
  it('文字、その右の丸、矢印の順に描き、色は外側の data-status から引く', () => {
    const { container } = render(<StatusSelect label="s" value="paused" onChange={() => {}} />);
    const pill = container.querySelector('.status-pill')!;
    expect(pill.getAttribute('data-status')).toBe('paused');
    const face = pill.querySelector('.status-face')!;
    expect([...face.children].map((c) => c.getAttribute('data-icon') ?? c.getAttribute('class'))).toEqual(['status-text', 'st-dot', 'chevronDown']);
    expect(face.querySelector('.status-text')!.textContent).toBe('paused');
    expect(face.querySelector('.st-dot')!.getAttribute('data-status')).toBe('paused');
    expect(face.querySelector('svg')!.getAttribute('data-icon')).toBe('chevronDown');
  });
  it('描いた面は飾りで、読み上げと操作は本物の select が受ける', () => {
    const { container } = render(<StatusSelect label="alpha のステータス" value="done" onChange={() => {}} />);
    expect(container.querySelector('.status-face')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'alpha のステータス' })).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });
});

describe('ProjectStatusDot', () => {
  it('飾りの点で、ステータスを data-status に出す', () => {
    const { container } = render(<ProjectStatusDot status="done" />);
    const dot = container.querySelector('.st-dot')!;
    expect(dot.getAttribute('data-status')).toBe('done');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
  });
});
