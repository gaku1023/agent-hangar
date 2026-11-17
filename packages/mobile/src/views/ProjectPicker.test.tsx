import { fireEvent, render, screen, within } from '@testing-library/react';
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

describe('ProjectPicker（シートの中身）', () => {
  it('クイックセッションが先頭、続けて全件が最近使った順に並ぶ', () => {
    render(<Harness />);
    const radios = within(main()).getAllByRole('radio');
    expect(radios).toHaveLength(9);
    expect(radios[0]).toHaveTextContent(/^クイックセッション$/);
    expect(radios[1]).toHaveTextContent('project-1');
    expect(radios[8]).toHaveTextContent('project-8');
  });

  it('選ぶと、そのプロジェクトの選択を渡す。クイックセッションは scratch', () => {
    const onSel = vi.fn();
    render(<Harness onSel={onSel} />);
    fireEvent.click(within(main()).getByRole('radio', { name: /project-3/ }));
    expect(onSel).toHaveBeenLastCalledWith({ scratch: false, id: 'p-3' });
    expect(within(main()).getByRole('radio', { name: /project-3/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(main()).getByRole('radio', { name: 'クイックセッション' }));
    expect(onSel).toHaveBeenLastCalledWith({ scratch: true });
  });

  it('行に、入っている PC の名前を札で添える', () => {
    render(<Harness />);
    const row = within(main()).getByRole('radio', { name: /project-2/ });
    expect(within(row).getByText('Mac')).toBeInTheDocument();
    expect(within(row).getByText('Mini')).toBeInTheDocument();
  });

  it('6 件以上のときだけ検索欄を出し、名前で絞る。無ければ「見つかりません」', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'プロジェクトを検索' }), { target: { value: 'ject-7' } });
    expect(within(main()).getAllByRole('radio').map((r) => r.textContent)).toEqual(['project-7Mac']);
    fireEvent.change(screen.getByRole('textbox', { name: 'プロジェクトを検索' }), { target: { value: 'zzz' } });
    expect(screen.getByText('見つかりません')).toBeInTheDocument();
  });

  it('5 件以下なら検索欄を出さない', () => {
    render(<Harness list={projects.slice(0, 5)} />);
    expect(screen.queryByRole('textbox', { name: 'プロジェクトを検索' })).toBeNull();
  });
});
