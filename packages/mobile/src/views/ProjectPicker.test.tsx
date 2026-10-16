import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchProject } from '../launch.ts';
import { ProjectPicker, type Sel } from './ProjectPicker.tsx';

const names = new Map([
  ['pc-1', 'Mac'],
  ['pc-2', 'Mini'],
]);
/** 新しい順に project-1 … project-8。project-2 は両方の PC、奇数は Mac、偶数は Mini。 */
const projects: LaunchProject[] = Array.from({ length: 8 }, (_, i) => ({
  id: `p-${i + 1}`,
  name: `project-${i + 1}`,
  lastUsedAt: 1000 - i,
  deviceIds: i === 1 ? ['pc-1', 'pc-2'] : i % 2 === 0 ? ['pc-1'] : ['pc-2'],
}));

function Harness({ list = projects, onSel }: { list?: LaunchProject[]; onSel?: (s: Sel) => void }) {
  const [sel, setSel] = useState<Sel>(null);
  return (
    <ProjectPicker
      projects={list}
      sel={sel}
      names={names}
      onPick={(s) => {
        setSel(s);
        onSel?.(s);
      }}
    />
  );
}

const main = () => screen.getByRole('radiogroup', { name: 'プロジェクト' });

describe('ProjectPicker（B1）', () => {
  it('クイックセッションが先頭、次に最近使った 5 件の札、そして「すべて 8 件」', () => {
    render(<Harness />);
    const radios = within(main()).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([expect.stringContaining('クイックセッション'), 'project-1', 'project-2', 'project-3', 'project-4', 'project-5']);
    expect(radios[0]).toHaveTextContent('どの PC でも');
    expect(screen.getByRole('button', { name: 'すべて 8 件 ›' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'プロジェクトを検索' })).toHaveAttribute('placeholder', 'プロジェクトを検索（8 件）');
  });

  it('札を選ぶと、そのプロジェクトの選択を渡す。クイックセッションは scratch', () => {
    const onSel = vi.fn();
    render(<Harness onSel={onSel} />);
    fireEvent.click(within(main()).getByRole('radio', { name: 'project-3' }));
    expect(onSel).toHaveBeenLastCalledWith({ scratch: false, id: 'p-3' });
    expect(within(main()).getByRole('radio', { name: 'project-3' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(main()).getByRole('radio', { name: /クイックセッション/ }));
    expect(onSel).toHaveBeenLastCalledWith({ scratch: true });
  });

  it('5 件以下なら全部が札で、検索欄と「すべて」は出さない', () => {
    render(<Harness list={projects.slice(0, 3)} />);
    expect(within(main()).getAllByRole('radio')).toHaveLength(4);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /すべて/ })).not.toBeInTheDocument();
  });

  it('検索欄で全部から絞る。結果は 5 件まで、残りは件数で知らせ、PC を添える', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox', { name: 'プロジェクトを検索' });
    fireEvent.change(box, { target: { value: 'PROJECT-' } });
    const results = within(screen.getByRole('radiogroup', { name: '検索結果' }));
    expect(results.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByText('他 3 件（「すべて」で見る）')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'project-2' } });
    const one = within(screen.getByRole('radiogroup', { name: '検索結果' })).getAllByRole('radio');
    expect(one).toHaveLength(1);
    expect(one[0]).toHaveTextContent('Mac');
    expect(one[0]).toHaveTextContent('Mini');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('見つかりません')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.queryByRole('radiogroup', { name: '検索結果' })).not.toBeInTheDocument();
  });

  it('検索から最近の 5 件に無いものを選ぶと、選択中の札として並びに出て、検索は空になる', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'プロジェクトを検索' }), { target: { value: 'project-7' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '検索結果' })).getByRole('radio', { name: /project-7/ }));
    const chosen = within(main()).getByRole('radio', { name: /project-7/ });
    expect(chosen).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: 'プロジェクトを検索' })).toHaveValue('');
    expect(screen.queryByRole('radiogroup', { name: '検索結果' })).not.toBeInTheDocument();
  });

  it('「すべて 8 件」でシートが開き、最近使った順に全部が並ぶ。選ぶと閉じる', () => {
    const onSel = vi.fn();
    render(<Harness onSel={onSel} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'すべて 8 件 ›' }));
    const dlg = screen.getByRole('dialog', { name: 'すべてのプロジェクト' });
    const radios = within(within(dlg).getByRole('radiogroup', { name: 'すべてのプロジェクト' })).getAllByRole('radio');
    expect(radios.map((r) => r.textContent?.match(/project-\d/)?.[0])).toEqual(Array.from({ length: 8 }, (_, i) => `project-${i + 1}`));
    // シートの中の検索でも絞れる。
    fireEvent.change(within(dlg).getByRole('textbox', { name: 'すべてから検索' }), { target: { value: 'project-8' } });
    expect(within(within(dlg).getByRole('radiogroup', { name: 'すべてのプロジェクト' })).getAllByRole('radio')).toHaveLength(1);
    fireEvent.click(within(dlg).getByRole('radio', { name: /project-8/ }));
    expect(onSel).toHaveBeenLastCalledWith({ scratch: false, id: 'p-8' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('シートは閉じるでも背景のタップでも閉じる。動きの長さがあるあいだは畳んで消える', () => {
    vi.useFakeTimers();
    const root = document.documentElement.style;
    root.setProperty('--dur-exit', '250ms');
    root.setProperty('--dur-fast', '200ms');
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'すべて 8 件 ›' }));
      fireEvent.click(screen.getByRole('button', { name: '一覧を閉じる' }));
      expect(screen.getByRole('dialog')).toHaveClass('leaving');
      act(() => void vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'すべて 8 件 ›' }));
      fireEvent.click(screen.getByTestId('sheet-scrim'));
      act(() => void vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      root.removeProperty('--dur-exit');
      root.removeProperty('--dur-fast');
      vi.useRealTimers();
    }
  });
});
