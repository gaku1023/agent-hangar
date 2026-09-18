import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { Shell } from './Shell.tsx';

const props = { nav: [{ route: { name: 'home' as const }, label: 'Home', current: true }, { route: { name: 'projects' as const }, label: 'Projects', current: false }], crumbs: [{ label: 'Projects', route: { name: 'projects' as const } }, { label: 'alpha' }], searchText: '', connection: 'connected' as const, index: { phase: 'idle' as const, done: 0, total: 0 }, indexLabel: null };

describe('Shell', () => {
  it('ナビと検索が Intent になる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div>body</div></Shell></IntentRoot>);
    // パンくずにも Projects へのリンクがあるので、サイドバーの中だけを探す。
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    fireEvent.click(nav.getByRole('link', { name: 'Projects', current: false }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'projects' } });
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: '動画' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '動画' });
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '新規セッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open' });
  });
  it('切断と索引の進行を表示する', () => {
    render(<IntentRoot onIntent={() => {}}><Shell {...props} connection="disconnected" indexLabel="索引 3 / 9 件" overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByText('再接続中')).toBeInTheDocument();
    expect(screen.getByText('索引 3 / 9 件')).toBeInTheDocument();
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;

describe('Shell のアイコン', () => {
  it('ナビの各項目と新規セッションのボタンにアイコンが付く', () => {
    render(<IntentRoot onIntent={vi.fn()}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const nav = screen.getByRole('navigation');
    expect(iconOf(within(nav).getByRole('link', { name: 'Home' }))).toBe('home');
    expect(iconOf(within(nav).getByRole('link', { name: 'Projects' }))).toBe('projects');
    expect(iconOf(screen.getByRole('button', { name: '新規セッション' }))).toBe('add');
  });
});
