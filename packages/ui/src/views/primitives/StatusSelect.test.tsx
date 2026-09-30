import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pick } from '../../test/pick.ts';
import { ProjectStatusDot, StatusSelect } from './StatusSelect.tsx';

describe('StatusSelect', () => {
  it('押すと 4 つのステータスを、点とひとことの意味つきで開く', () => {
    render(<StatusSelect label="alpha の状態" value="paused" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha の状態' }));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['Active', 'Paused', 'Done', 'Archived']);
    expect(screen.getByRole('option', { name: 'Paused' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Done' })).toHaveAccessibleDescription('やり終えた');
    expect(options.map((o) => o.querySelector('.st-dot')?.getAttribute('data-status'))).toEqual(['active', 'paused', 'done', 'archived']);
  });
  it('選び直すと新しいステータスを渡す', () => {
    const onChange = vi.fn();
    render(<StatusSelect label="s" value="active" onChange={onChange} />);
    pick('s', 'Done');
    expect(onChange).toHaveBeenCalledWith('done');
  });
  it('札でも一覧でも、クリックとキー入力は親へ伝えない（カードを開かせない）', () => {
    const onParent = vi.fn();
    render(<div onClick={onParent} onKeyDown={onParent}><StatusSelect label="s" value="active" onChange={() => {}} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 's' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'Paused' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 's' }), { key: 'Enter' });
    expect(onParent).not.toHaveBeenCalled();
  });
});

describe('StatusSelect の見た目', () => {
  it('札は文字、その右の丸、矢印の順に描き、色は札の data-status から引く', () => {
    render(<StatusSelect label="s" value="paused" onChange={() => {}} />);
    const pill = screen.getByRole('button', { name: 's' });
    expect(pill.classList.contains('status-pill')).toBe(true);
    expect(pill.getAttribute('data-status')).toBe('paused');
    expect([...pill.children].map((c) => c.getAttribute('data-icon') ?? c.getAttribute('class'))).toEqual(['status-text', 'st-dot', 'chevronDown']);
    expect(pill.querySelector('.status-text')!.textContent).toBe('Paused');
  });
  it('読み上げで見つかるのは、名前つきの札 1 つだけ', () => {
    render(<StatusSelect label="alpha の状態" value="done" onChange={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('combobox')).toBeNull();
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
