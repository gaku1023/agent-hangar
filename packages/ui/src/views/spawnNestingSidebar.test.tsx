import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionMenuProps } from '../presenters/sessionMenu.ts';
import type { SideLiveGroup, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import { Sidebar } from './Sidebar.tsx';

const menuOf = (id: string): SessionMenuProps => ({ id, name: `name-${id}`, status: null, resumeHere: null, stop: null, moveBlocked: null });
const row = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: `name-${id}`, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: menuOf(id), ...over });
const props = (rows: SideLiveRow[]): SideLiveProps => {
  const g: SideLiveGroup = { key: 'web', name: 'web', open: true, waiting: 0, rows };
  const alive = rows.filter((r) => !r.dim);
  return { count: alive.length, ids: alive.map((r) => r.id), rows, groups: [g] };
};
const mount = (live: SideLiveProps, onAction = vi.fn()) => ({ ...render(<ActionRoot onAction={onAction}><Sidebar nav={[]} foot={[]} collapsed={false} live={live} /></ActionRoot>), onAction });
const family = () => [
  row('p', { nest: { open: true, dots: [{ live: 'busy', aside: false, reason: null }, { live: 'waiting', aside: false, reason: null }] } }),
  row('c', { depth: 1, nest: { open: true, dots: [{ live: 'waiting', aside: false, reason: null }] } }),
  row('g', { depth: 2, live: 'waiting' }),
  row('x'),
];

describe('サイドバーの実行中の入れ子（見た目と開閉）', () => {
  it('子は起動元の li の中の列に入り、孫も入れ子になる', () => {
    mount(props(family()));
    const p = document.querySelector('[data-id="p"]')!.closest('li')!;
    expect(p.querySelector(':scope > .side-live-kids')).not.toBeNull();
    expect(p.querySelector(':scope > .side-live-kids [data-id="c"]')).not.toBeNull();
    expect(p.querySelector(':scope > .side-live-kids .side-live-kids [data-id="g"]')).not.toBeNull();
    expect(document.querySelector('[data-id="x"]')!.closest('li')!.parentElement!.closest('.side-live-kids')).toBeNull();
  });
  it('子を持つ行だけに開閉の席（aria-expanded つきのボタン）がある。押すと開閉して、行は開かない', () => {
    const { onAction } = mount(props(family()));
    expect(document.querySelectorAll('.side-live-fold')).toHaveLength(2);
    const btn = within(document.querySelector('[data-id="p"]') as HTMLElement).getByRole('button', { name: /name-p/ });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.fold', key: 'spawn:p', open: false });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('行の他の所を押したら、今まで通りセッションへ移る', () => {
    const { onAction } = mount(props(family()));
    fireEvent.click(document.querySelector('[data-id="p"]')!);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'p' });
  });
  it('矢印キーでも開閉できる（→ で開き、← で畳む）', () => {
    const { onAction } = mount(props(family()));
    fireEvent.keyDown(document.querySelector('[data-id="p"]')!, { key: 'ArrowLeft' });
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.fold', key: 'spawn:p', open: false });
    onAction.mockClear();
    fireEvent.keyDown(document.querySelector('[data-id="p"]')!, { key: 'ArrowRight' });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('畳んだ起動元には子孫ごとの丸が並び、子の列は隠れる。開いているときは丸を出さない', () => {
    const rows = family();
    rows[0] = row('p', { nest: { open: false, dots: [{ live: 'busy', aside: false, reason: null }, { live: 'waiting', aside: false, reason: null }] } });
    mount(props(rows));
    const dots = document.querySelectorAll('[data-id="p"] .side-live-kidot');
    expect([...dots].map((d) => d.getAttribute('data-status'))).toEqual(['busy', 'waiting']);
    expect(document.querySelector('[data-id="p"]')!.closest('li')!.querySelector(':scope > .side-live-kids')).toHaveAttribute('hidden');
    expect(document.querySelector('[data-id="c"] .side-live-kidot')).toBeNull();
  });
  it('薄い起動元は data-dim を持つ', () => {
    mount(props([row('p', { dim: true, live: null, nest: { open: true, dots: [{ live: 'busy', aside: false, reason: null }] } }), row('c', { depth: 1 })]));
    expect(document.querySelector('[data-id="p"]')).toHaveAttribute('data-dim', 'true');
    expect(document.querySelector('[data-id="c"]')).not.toHaveAttribute('data-dim');
  });
});
