import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { Shell } from './Shell.tsx';

const props = { sidebarCollapsed: false, nav: [{ route: { name: 'home' as const }, label: 'ホーム', current: true }, { route: { name: 'projects' as const }, label: 'プロジェクト', current: false }], crumbs: [{ label: 'プロジェクト', route: { name: 'projects' as const } }, { label: 'alpha' }], searchText: '', conn: { visible: false, staleLabel: '', retryLabel: '' }, index: { phase: 'idle' as const, done: 0, total: 0 }, indexLabel: null, usage: { fiveHour: null, sevenDay: null, updatedLabel: null }, sync: { visible: false, state: 'off' as const, label: '', pending: 0, sweepPending: 0, skipped: 0, paused: false }, newSession: {} };

describe('Shell', () => {
  it('ナビと検索が Intent になる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div>body</div></Shell></IntentRoot>);
    // パンくずにも Projects へのリンクがあるので、サイドバーの中だけを探す。
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    fireEvent.click(nav.getByRole('link', { name: 'プロジェクト', current: false }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'projects' } });
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: '動画' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '動画' });
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ホーム' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '新規セッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open' });
  });
  it('ヘッダーの新規ボタンは、今の画面のプロジェクトを選んだ状態で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} newSession={{ projectId: 'p1' }} overlays={null}><div /></Shell></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '新規セッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'p1' });
  });
  // 開閉のボタンはサイドバーが自分で持つ。開いた帯ではワードマークの右、畳んだ帯ではワードマークがあった一番上に置く。ヘッダには置かない。
  it('サイドバーの中のボタンで開閉し、閉じてもナビの名前は残る', () => {
    const onIntent = vi.fn();
    const { container, rerender } = render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const side = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: /サイドバー/ })).toBeNull();
    const toggle = side.getByRole('button', { name: 'サイドバーを閉じる' });
    expect(toggle.previousElementSibling).toHaveClass('brand');
    // 乗せたときの吹き出しは、今押すと何が起きるかを短く言う。読み上げは aria-label に任せる。
    expect(toggle.querySelector('.toggle-tip')).toHaveTextContent('閉じる⌘B');
    expect(toggle.querySelector('.toggle-tip')).toHaveAttribute('aria-hidden', 'true');
    expect(toggle).not.toHaveAttribute('title');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.shell')).not.toHaveAttribute('data-sidebar', 'collapsed');
    fireEvent.click(toggle);
    expect(onIntent).toHaveBeenCalledWith({ type: 'sidebar.toggle' });
    rerender(<IntentRoot onIntent={onIntent}><Shell {...props} sidebarCollapsed overlays={null}><div /></Shell></IntentRoot>);
    expect(side.getByRole('button', { name: 'サイドバーを開く' })).toHaveAttribute('aria-expanded', 'false');
    expect(side.getByRole('button', { name: 'サイドバーを開く' }).querySelector('.toggle-tip')).toHaveTextContent('開く⌘B');
    expect(container.querySelector('.shell')).toHaveAttribute('data-sidebar', 'collapsed');
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    expect(nav.getByRole('link', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(nav.getByRole('link', { name: 'Hangar' })).toBeInTheDocument();
  });
  it('ワードマークを押すと Home へ行く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    const brand = nav.getByRole('link', { name: 'Hangar' });
    expect(brand).toHaveAttribute('href', nav.getByRole('link', { name: 'ホーム' }).getAttribute('href'));
    fireEvent.click(brand);
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'home' } });
  });
  it('切断の帯と索引の進行を表示する', () => {
    const onIntent = vi.fn();
    const conn = { visible: true, staleLabel: '画面は 2 分前のまま止まっています', retryLabel: '8 秒後に再接続します' };
    render(<IntentRoot onIntent={onIntent}><Shell {...props} conn={conn} indexLabel="索引 3 / 9 件" overlays={null}><div /></Shell></IntentRoot>);
    const banner = within(screen.getByRole('status'));
    expect(banner.getByText('画面は 2 分前のまま止まっています')).toBeInTheDocument();
    expect(banner.getByText('8 秒後に再接続します')).toBeInTheDocument();
    fireEvent.click(banner.getByRole('button', { name: 'いますぐ再接続' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'conn.retry' });
    expect(screen.getByText('索引 3 / 9 件')).toBeInTheDocument();
  });
  it('つながっている間は帯を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('同期の状態と操作を出し、off では出さない', () => {
    const onIntent = vi.fn();
    const sync = { visible: true, state: 'idle' as const, label: '同期 1 分前', pending: 2, sweepPending: 0, skipped: 0, paused: false };
    const { rerender } = render(<IntentRoot onIntent={onIntent}><Shell {...props} sync={sync} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByText('同期 1 分前')).toBeInTheDocument();
    expect(screen.getByText('未送信 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '今すぐ同期' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.now' });
    fireEvent.click(screen.getByRole('button', { name: '同期を一時停止' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.pause', paused: true });
    rerender(<IntentRoot onIntent={onIntent}><Shell {...props} sync={{ ...sync, state: 'paused', label: '一時停止中', paused: true }} overlays={null}><div /></Shell></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '同期を再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.pause', paused: false });
    rerender(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.queryByRole('button', { name: '今すぐ同期' })).toBeNull();
  });
  it('取り残しと送れなかった本文は、溜まっているときだけ出す', () => {
    const sync = { visible: true, state: 'idle' as const, label: '同期 1 分前', pending: 0, sweepPending: 1500, skipped: 2, paused: false };
    const { rerender } = render(<IntentRoot onIntent={() => {}}><Shell {...props} sync={sync} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByText('未送信の本文 1500')).toBeInTheDocument();
    expect(screen.getByText('送れなかった本文 2')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={() => {}}><Shell {...props} sync={{ ...sync, sweepPending: 0, skipped: 0 }} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.queryByText('未送信の本文 0')).toBeNull();
    expect(screen.queryByText('送れなかった本文 0')).toBeNull();
  });
  // 未送信が無いときに「未送信 0」と出すと、止まっているように見える。
  it('未送信が 0 なら件数を出さず、使用量ゲージも残る', () => {
    render(<IntentRoot onIntent={() => {}}><Shell {...props} sync={{ visible: true, state: 'pushing', label: '送信中', pending: 0, sweepPending: 0, skipped: 0, paused: false }} usage={{ fiveHour: 12, sevenDay: 34, updatedLabel: '3 分前' }} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByText('送信中')).toBeInTheDocument();
    expect(screen.queryByText('未送信 0')).toBeNull();
    expect(screen.getByRole('meter', { name: '5 時間の使用率' })).toBeInTheDocument();
    expect(screen.getByText('最終更新 3 分前')).toBeInTheDocument();
  });
  // .app ではヘッダの空いた所を掴んで窓を動かす。操作する部品に印が付くと、押しても窓が動くだけになる。
  it('ヘッダ本体と余白だけを、窓を掴む場所にする', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const header = container.querySelector('header.header')!;
    expect(header).toHaveAttribute('data-tauri-drag-region');
    expect(header.querySelector('.spacer')).toHaveAttribute('data-tauri-drag-region');
    const controls = header.querySelectorAll('button, input, a');
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) expect(el).not.toHaveAttribute('data-tauri-drag-region');
  });
  it('検索欄に ⌘K の印を添え、読み上げからは外す', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const kbd = container.querySelector('header.header kbd.search-kbd')!;
    expect(kbd).toHaveTextContent('⌘K');
    expect(kbd).toHaveAttribute('aria-hidden', 'true');
    expect(kbd.previousElementSibling).toBe(screen.getByRole('searchbox'));
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;

describe('Shell のアイコン', () => {
  it('ナビの各項目と新規セッションのボタンにアイコンが付く', () => {
    render(<IntentRoot onIntent={vi.fn()}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const nav = screen.getByRole('navigation');
    expect(iconOf(within(nav).getByRole('link', { name: 'ホーム' }))).toBe('home');
    expect(iconOf(within(nav).getByRole('link', { name: 'プロジェクト' }))).toBe('projects');
    expect(iconOf(screen.getByRole('button', { name: '新規セッション' }))).toBe('add');
  });
});
