import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { Shell } from './Shell.tsx';

const props = { sidebarCollapsed: false, wide: false, nav: [{ route: { name: 'home' as const }, label: 'ホーム', current: true, count: 0 }, { route: { name: 'projects' as const }, label: 'プロジェクト', current: false, count: 0 }], conn: { visible: false, staleLabel: '', retryLabel: '', hard: false, desktop: false }, index: { phase: 'idle' as const, done: 0, total: 0 }, indexLabel: null, usage: { fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }, sync: { visible: false, state: 'off' as const, label: '', pending: 0, sweepPending: 0, skipped: 0, paused: false }, retention: { visible: false, title: '', detail: '', extendTo: 365 }, newSession: {} };

describe('Shell の本文の幅', () => {
  // セッション画面だけ幅の上限を外す（案 b）。CSS は .shell[data-wide] で --main-w を外し、本文に窓の残りの高さを渡す。
  it('wide の画面だけ殻に印を付ける', () => {
    const { container, rerender } = render(<IntentRoot onIntent={vi.fn()}><Shell {...props} wide overlays={null}><div>body</div></Shell></IntentRoot>);
    expect(container.querySelector('.shell')).toHaveAttribute('data-wide', 'true');
    rerender(<IntentRoot onIntent={vi.fn()}><Shell {...props} overlays={null}><div>body</div></Shell></IntentRoot>);
    expect(container.querySelector('.shell')).not.toHaveAttribute('data-wide');
  });
});

describe('Shell のホームの入力待ちの数', () => {
  const withCount = (n: number) => ({ ...props, nav: [{ ...props.nav[0]!, count: n }, props.nav[1]!] });
  it('入力待ちがあれば、ホームの項目に数を添え、読み上げでは何の数かを言う', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><Shell {...withCount(2)} overlays={null}><div>body</div></Shell></IntentRoot>);
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    const home = nav.getByRole('link', { name: 'ホーム、入力待ち 2' });
    expect(home.querySelector('.nav-count')).toHaveTextContent('2');
    expect(container.querySelectorAll('.nav-count')).toHaveLength(1);
  });
  it('0 のときは添えない', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><Shell {...withCount(0)} overlays={null}><div>body</div></Shell></IntentRoot>);
    expect(container.querySelector('.nav-count')).toBeNull();
  });
  it('畳んだ帯でも同じ印を出す', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><Shell {...withCount(3)} sidebarCollapsed overlays={null}><div>body</div></Shell></IntentRoot>);
    expect(container.querySelector('.shell[data-sidebar="collapsed"] .nav-count')).toHaveTextContent('3');
  });
});

describe('Shell', () => {
  it('ナビと検索が Intent になる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div>body</div></Shell></IntentRoot>);
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    fireEvent.click(nav.getByRole('link', { name: 'プロジェクト', current: false }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'projects' } });
    fireEvent.click(screen.getByRole('button', { name: '探す・移動' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ホーム' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open' });
  });
  it('ヘッダーの新規ボタンは、今の画面のプロジェクトを選んだ状態で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} newSession={{ projectId: 'p1' }} overlays={null}><div /></Shell></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'p1' });
  });
  // 開閉のボタンはサイドバーが自分で持つ。開いた帯ではホームの行の右端、畳んだ帯では帯の一番上に置く（どちらも同じ DOM で、CSS が並べ替える）。ヘッダには置かない。
  it('サイドバーの中のボタンで開閉し、閉じてもナビの名前は残る', () => {
    const onIntent = vi.fn();
    const { container, rerender } = render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const side = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: /サイドバー/ })).toBeNull();
    const toggle = side.getByRole('button', { name: 'サイドバーを閉じる' });
    expect(toggle.parentElement).toHaveClass('nav-row');
    expect(toggle.previousElementSibling).toBe(side.getByRole('link', { name: 'ホーム' }));
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
    // 畳んでも組み立ては変えない。開閉の動きは、印だけを戻して前の形を測るからである（sidebarMotion.ts）。
    expect(side.getByRole('button', { name: 'サイドバーを開く' }).parentElement).toHaveClass('nav-row');
    // ロゴはヘッダにあり、畳んでも残る。
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Hangar' })).toBeInTheDocument();
  });
  // 今いる場所はヘッダでは示さない（各頁の見出しで示す）。頁ごとに幅の変わる文字があると、検索欄が頁ごとに横へずれる。
  it('ヘッダにはロゴと検索欄を置き、今いる場所の文字は置かない', () => {
    render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const header = within(screen.getByRole('banner'));
    expect(header.queryByText('ホーム')).toBeNull();
    expect(header.queryByText('プロジェクト')).toBeNull();
    expect(screen.getByRole('banner').querySelector('.crumbs')).toBeNull();
    expect(within(screen.getByRole('navigation', { name: '主ナビゲーション' })).queryByRole('link', { name: 'Hangar' })).toBeNull();
  });
  it('ワードマークを押すと Home へ行く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    const brand = within(screen.getByRole('banner')).getByRole('link', { name: 'Hangar' });
    expect(brand).toHaveAttribute('href', nav.getByRole('link', { name: 'ホーム' }).getAttribute('href'));
    fireEvent.click(brand);
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'home' } });
  });
  it('切断の帯と索引の進行を表示する', () => {
    const onIntent = vi.fn();
    const conn = { visible: true, staleLabel: '画面は 2 分前のまま止まっています', retryLabel: '8 秒後に再接続します', hard: false, desktop: false };
    render(<IntentRoot onIntent={onIntent}><Shell {...props} conn={conn} indexLabel="索引 3 / 9 件" overlays={null}><div /></Shell></IntentRoot>);
    const banner = within(screen.getByRole('status', { name: '接続の状態' }));
    expect(banner.getByText('画面は 2 分前のまま止まっています')).toBeInTheDocument();
    expect(banner.getByText('8 秒後に再接続します')).toBeInTheDocument();
    fireEvent.click(banner.getByRole('button', { name: '今すぐ再接続' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'conn.retry' });
    expect(screen.getByText('索引 3 / 9 件')).toBeInTheDocument();
  });
  it('3 回失敗した帯は、同じ帯のまま濃い赤にし、殻の中ではログを開くと再起動を出す', () => {
    const onIntent = vi.fn();
    const conn = { visible: true, staleLabel: '画面の更新が止まっています', retryLabel: '再接続しています', hard: true, desktop: true };
    render(<IntentRoot onIntent={onIntent}><Shell {...props} conn={conn} overlays={null}><div /></Shell></IntentRoot>);
    const el = screen.getByRole('status', { name: '接続の状態' });
    expect(el).toHaveAttribute('data-hard', 'true');
    const banner = within(el);
    expect(banner.getByText('サーバに戻れません')).toBeInTheDocument();
    expect(banner.getByText('アプリを再起動してください')).toBeInTheDocument();
    expect(banner.queryByRole('button', { name: '今すぐ再接続' })).toBeNull();
    fireEvent.click(banner.getByRole('button', { name: 'ログを開く' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'shell.openLog' });
    fireEvent.click(banner.getByRole('button', { name: '再起動' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'shell.restart' });
  });
  it('殻の無いブラウザでは、ログの場所のコピーと、再起動の文に落とす', () => {
    const onIntent = vi.fn();
    const conn = { visible: true, staleLabel: '画面の更新が止まっています', retryLabel: '再接続しています', hard: true, desktop: false };
    render(<IntentRoot onIntent={onIntent}><Shell {...props} conn={conn} overlays={null}><div /></Shell></IntentRoot>);
    const banner = within(screen.getByRole('status', { name: '接続の状態' }));
    expect(banner.getByText('アプリを再起動してください。ログ: ~/.agent-hangar/desktop.log')).toBeInTheDocument();
    expect(banner.queryByRole('button', { name: '再起動' })).toBeNull();
    fireEvent.click(banner.getByRole('button', { name: 'ログの場所 をコピー' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: '~/.agent-hangar/desktop.log' });
  });
  it('保持期間の帯を出し、閉じると延ばすの Intent を出す。切断の帯と積める', () => {
    const onIntent = vi.fn();
    const retention = { visible: true, title: '会話は 30 日で削除されます', detail: 'hangar の履歴からも消えます ・ いま 1.5 GB', extendTo: 365 };
    const conn = { visible: true, staleLabel: '画面の更新が止まっています', retryLabel: '再接続しています', hard: false, desktop: false };
    render(<IntentRoot onIntent={onIntent}><Shell {...props} conn={conn} retention={retention} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    const banner = within(screen.getByRole('status', { name: '会話の保持期間' }));
    expect(banner.getByText('会話は 30 日で削除されます')).toBeInTheDocument();
    fireEvent.click(banner.getByRole('button', { name: 'このままでよい' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'retention.dismiss' });
    fireEvent.click(banner.getByRole('button', { name: '保持期間を延ばす…' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'retention.edit', days: 365, from: 'banner' });
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
    render(<IntentRoot onIntent={() => {}}><Shell {...props} sync={{ visible: true, state: 'pushing', label: '送信中', pending: 0, sweepPending: 0, skipped: 0, paused: false }} usage={{ fiveHour: 12, sevenDay: 34, fiveHourResets: null, sevenDayResets: null, updatedLabel: '3 分前' }} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByText('送信中')).toBeInTheDocument();
    expect(screen.queryByText('未送信 0')).toBeNull();
    expect(screen.getByRole('meter', { name: '5 時間枠の使用率' })).toBeInTheDocument();
    expect(screen.getByText('最終更新 3 分前')).toBeInTheDocument();
  });
  // .app ではヘッダの空いた所を掴んで窓を動かす。操作する部品に印が付くと、押しても窓が動くだけになる。
  it('ヘッダ本体と余白だけを、窓を掴む場所にする', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const header = container.querySelector('header.header')!;
    expect(header).toHaveAttribute('data-tauri-drag-region');
    // 部品を包む箱にも印を付ける。印の無い箱の上では、掴んでも窓が動かない。
    for (const sel of ['.spacer', '.header-brand', '.header-row', '.header-end']) expect(header.querySelector(sel), sel).toHaveAttribute('data-tauri-drag-region');
    const controls = header.querySelectorAll('button, input, a');
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) expect(el).not.toHaveAttribute('data-tauri-drag-region');
  });
  // ヘッダーの入口は打つ欄ではなく、押す錠剤である（A1）。押すとパレットが開き、全文検索はパレットの最後の行から行く。
  it('入口は虫眼鏡と「探す・移動」と ⌘K のキー帽の錠剤で、キー帽は読み上げから外す', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.queryByRole('searchbox')).toBeNull();
    const pill = screen.getByRole('button', { name: '探す・移動' });
    expect(pill).toHaveAttribute('id', 'global-search');
    expect(pill.classList.contains('search-pill')).toBe(true);
    expect(pill.querySelector('svg')).toHaveAttribute('data-icon', 'search');
    const kbd = pill.querySelector('kbd')!;
    expect(kbd).toHaveTextContent('⌘K');
    expect(kbd).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('header.header .search-icon')).toBeNull();
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;

describe('Shell のアイコン', () => {
  it('ナビの各項目と新規セッションのボタンにアイコンが付く', () => {
    render(<IntentRoot onIntent={vi.fn()}><Shell {...props} overlays={null}><div /></Shell></IntentRoot>);
    const nav = screen.getByRole('navigation');
    expect(iconOf(within(nav).getByRole('link', { name: 'ホーム' }))).toBe('home');
    expect(iconOf(within(nav).getByRole('link', { name: 'プロジェクト' }))).toBe('projects');
    expect(iconOf(screen.getByRole('button', { name: '新しいセッション' }))).toBe('add');
  });
});
