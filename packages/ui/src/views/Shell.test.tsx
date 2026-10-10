import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { syncFixture } from '../test/syncProps.ts';
import { Shell } from './Shell.tsx';

const props = { live: { count: 0, ids: [], rows: [], more: 0 }, sidebarCollapsed: false, wide: false, nav: [{ route: { name: 'home' as const }, label: 'ホーム', current: true, count: 0 }, { route: { name: 'projects' as const }, label: 'プロジェクト', current: false, count: 0 }], foot: [{ route: { name: 'settings' as const }, label: '設定', current: false, count: 0 }], conn: { visible: false, staleLabel: '', retryLabel: '', hard: false, desktop: false }, index: { phase: 'idle' as const, done: 0, total: 0 }, indexLabel: null, usage: { fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }, sync: syncFixture({ visible: false, state: 'off', label: '' }), notices: { rows: [], unread: 0, keys: [], label: '通知' }, account: null, newSession: {} };

describe('Shell の本文の幅', () => {
  // セッション画面だけ幅の上限を外す（案 b）。
  // CSS は .shell[data-wide] で --main-w を外し、本文に窓の残りの高さを渡す。
  it('wide の画面だけ殻に印を付ける', () => {
    const { container, rerender } = render(<ActionRoot onAction={vi.fn()}><Shell {...props} wide overlays={null}><div>body</div></Shell></ActionRoot>);
    expect(container.querySelector('.shell')).toHaveAttribute('data-wide', 'true');
    rerender(<ActionRoot onAction={vi.fn()}><Shell {...props} overlays={null}><div>body</div></Shell></ActionRoot>);
    expect(container.querySelector('.shell')).not.toHaveAttribute('data-wide');
  });
});

describe('Shell のホームの入力待ちの数', () => {
  const withCount = (n: number) => ({ ...props, nav: [{ ...props.nav[0]!, count: n }, props.nav[1]!] });
  it('入力待ちがあれば、ホームの項目に数を添え、読み上げでは何の数かを言う', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><Shell {...withCount(2)} overlays={null}><div>body</div></Shell></ActionRoot>);
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    const home = nav.getByRole('link', { name: 'ホーム、入力待ち 2' });
    expect(home.querySelector('.nav-count')).toHaveTextContent('2');
    expect(container.querySelectorAll('.nav-count')).toHaveLength(1);
  });
  it('0 のときは添えない', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><Shell {...withCount(0)} overlays={null}><div>body</div></Shell></ActionRoot>);
    expect(container.querySelector('.nav-count')).toBeNull();
  });
  it('畳んだ帯でも同じ印を出す', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><Shell {...withCount(3)} sidebarCollapsed overlays={null}><div>body</div></Shell></ActionRoot>);
    expect(container.querySelector('.shell[data-sidebar="collapsed"] .nav-count')).toHaveTextContent('3');
  });
});

describe('Shell のサイドバーの並び', () => {
  const side = () => screen.getByRole('navigation', { name: '主ナビゲーション' });
  const live = { count: 2, ids: ['a', 'b'], rows: [{ id: 'a', name: 'name-a', live: 'busy' as const, aside: false, waited: null, current: false, stop: null }, { id: 'b', name: 'name-b', live: 'idle' as const, aside: false, waited: null, current: false, stop: null }], more: 0 };
  it('項目は「ホーム」「プロジェクト」の 2 つと「実行中」の節で、設定は下端に置く。「セッション」の項目は無い', () => {
    render(<ActionRoot onAction={vi.fn()}><Shell {...props} live={live} overlays={null}><div>body</div></Shell></ActionRoot>);
    const order = [...side().querySelectorAll('.nav-item, .side-live')].map((e) => (e.classList.contains('side-live') ? '実行中の節' : e.textContent));
    expect(order).toEqual(['ホーム', 'プロジェクト', '実行中の節', '設定']);
    expect(within(side()).queryByRole('link', { name: 'セッション' })).toBeNull();
    expect(side().querySelector('.side-foot')).toContainElement(within(side()).getByRole('link', { name: '設定' }));
  });
  it('設定の項目は押すと設定へ移り、設定の画面にいる間は印が付く', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><Shell {...props} overlays={null}><div>body</div></Shell></ActionRoot>);
    fireEvent.click(within(side()).getByRole('link', { name: '設定' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
    rerender(<ActionRoot onAction={onAction}><Shell {...props} foot={[{ ...props.foot[0]!, current: true }]} overlays={null}><div>body</div></Shell></ActionRoot>);
    expect(within(side()).getByRole('link', { name: '設定' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('Shell', () => {
  it('ナビと検索が UiAction になる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><Shell {...props} overlays={null}><div>body</div></Shell></ActionRoot>);
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    fireEvent.click(nav.getByRole('link', { name: 'プロジェクト', current: false }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'projects' } });
    fireEvent.click(screen.getByRole('button', { name: '移動・操作' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.open' });
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ホーム' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.open' });
  });
  it('ヘッダーの新規ボタンは、今の画面のプロジェクトを選んだ状態で開く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><Shell {...props} newSession={{ projectId: 'p1' }} overlays={null}><div /></Shell></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'p1' });
  });
  // 開閉のボタンはサイドバーが自分で持つ。開いた帯ではホームの行の右端、畳んだ帯では帯の一番上に置く（どちらも同じ DOM で、CSS が並べ替える）。ヘッダには置かない。
  it('サイドバーの中のボタンで開閉し、閉じてもナビの名前は残る', () => {
    const onAction = vi.fn();
    const { container, rerender } = render(<ActionRoot onAction={onAction}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
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
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.toggle' });
    rerender(<ActionRoot onAction={onAction}><Shell {...props} sidebarCollapsed overlays={null}><div /></Shell></ActionRoot>);
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
    render(<ActionRoot onAction={() => {}}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
    const header = within(screen.getByRole('banner'));
    expect(header.queryByText('ホーム')).toBeNull();
    expect(header.queryByText('プロジェクト')).toBeNull();
    expect(screen.getByRole('banner').querySelector('.crumbs')).toBeNull();
    expect(within(screen.getByRole('navigation', { name: '主ナビゲーション' })).queryByRole('link', { name: 'Hangar' })).toBeNull();
  });
  it('ワードマークを押すと Home へ行く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
    const nav = within(screen.getByRole('navigation', { name: '主ナビゲーション' }));
    const brand = within(screen.getByRole('banner')).getByRole('link', { name: 'Hangar' });
    expect(brand).toHaveAttribute('href', nav.getByRole('link', { name: 'ホーム' }).getAttribute('href'));
    fireEvent.click(brand);
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'home' } });
  });
  it('切断の帯と索引の進行を表示する', () => {
    const onAction = vi.fn();
    const conn = { visible: true, staleLabel: '画面は 2 分前のまま止まっています', retryLabel: '8 秒後に再接続します', hard: false, desktop: false };
    render(<ActionRoot onAction={onAction}><Shell {...props} conn={conn} indexLabel="索引 3 / 9 件" overlays={null}><div /></Shell></ActionRoot>);
    const banner = within(screen.getByRole('status', { name: '接続の状態' }));
    expect(banner.getByText('画面は 2 分前のまま止まっています')).toBeInTheDocument();
    expect(banner.getByText('8 秒後に再接続します')).toBeInTheDocument();
    fireEvent.click(banner.getByRole('button', { name: '今すぐ再接続' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'conn.retry' });
    expect(screen.getByText('索引 3 / 9 件')).toBeInTheDocument();
  });
  it('3 回失敗した帯は、同じ帯のまま濃い赤にし、殻の中ではログを開くと再起動を出す', () => {
    const onAction = vi.fn();
    const conn = { visible: true, staleLabel: '画面の更新が止まっています', retryLabel: '再接続しています', hard: true, desktop: true };
    render(<ActionRoot onAction={onAction}><Shell {...props} conn={conn} overlays={null}><div /></Shell></ActionRoot>);
    const el = screen.getByRole('status', { name: '接続の状態' });
    expect(el).toHaveAttribute('data-hard', 'true');
    const banner = within(el);
    expect(banner.getByText('サーバに戻れません')).toBeInTheDocument();
    expect(banner.getByText('アプリを再起動してください')).toBeInTheDocument();
    expect(banner.queryByRole('button', { name: '今すぐ再接続' })).toBeNull();
    fireEvent.click(banner.getByRole('button', { name: 'ログを開く' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'shell.openLog' });
    fireEvent.click(banner.getByRole('button', { name: '再起動' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'shell.restart' });
  });
  it('殻の無いブラウザでは、ログの場所のコピーと、再起動の文に落とす', () => {
    const onAction = vi.fn();
    const conn = { visible: true, staleLabel: '画面の更新が止まっています', retryLabel: '再接続しています', hard: true, desktop: false };
    render(<ActionRoot onAction={onAction}><Shell {...props} conn={conn} overlays={null}><div /></Shell></ActionRoot>);
    const banner = within(screen.getByRole('status', { name: '接続の状態' }));
    expect(banner.getByText('アプリを再起動してください。ログ: ~/.agent-hangar/desktop.log')).toBeInTheDocument();
    expect(banner.queryByRole('button', { name: '再起動' })).toBeNull();
    fireEvent.click(banner.getByRole('button', { name: 'ログの場所 をコピー' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: '~/.agent-hangar/desktop.log' });
  });
  it('ヘッダーにベルを置く。未読の数を札に出し、押すと知らせの一覧が開いて、行の操作を送れる', () => {
    const onAction = vi.fn();
    const row = { key: 'retention|30|rule', kind: 'retention' as const, tone: 'warn' as const, icon: 'retention' as const, kindLabel: '保持期間', title: '会話は 30 日で削除されます', detail: 'hangar の履歴からも消えます', when: null, unread: true, action: { label: '設定を開く', send: { type: 'nav.go' as const, to: { name: 'settings' as const } } } };
    const notices = { rows: [row], unread: 1, keys: [row.key], label: '通知（未読 1 件）' };
    render(<ActionRoot onAction={onAction}><Shell {...props} notices={notices} overlays={null}><div /></Shell></ActionRoot>);
    const bell = screen.getByRole('button', { name: '通知（未読 1 件）' });
    expect(within(bell).getByText('1')).toBeInTheDocument();
    // 保持期間の帯はヘッダーの下に出ない。
    expect(screen.queryByRole('status', { name: '会話の保持期間' })).toBeNull();
    fireEvent.click(bell);
    const list = within(screen.getByRole('dialog', { name: '通知' }));
    expect(list.getByText('会話は 30 日で削除されます')).toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: '設定を開く' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'notices.read', keys: [row.key] });
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
  });
  it('ベルは未読が無くても出す（数の札だけを隠す）', () => {
    render(<ActionRoot onAction={() => {}}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
    expect(within(screen.getByRole('button', { name: '通知' })).queryByText('0')).toBeNull();
  });
  it('つながっている間は帯を出さない', () => {
    render(<ActionRoot onAction={() => {}}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('同期は状態の語と件数だけを出し、操作のボタンは持たない', () => {
    render(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture({ pending: '未送信の変更 2' })} overlays={null}><div /></Shell></ActionRoot>);
    expect(screen.getByText('同期 1 分前')).toBeInTheDocument();
    expect(screen.getByText('未送信の変更 2')).toBeInTheDocument();
    // 今すぐ同期と一時停止は、設定の同期の群にある。
    expect(screen.queryByRole('button', { name: '今すぐ同期' })).toBeNull();
    expect(screen.queryByRole('button', { name: '同期を一時停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '同期を再開' })).toBeNull();
    expect(document.querySelector('.sync button')).toBeNull();
  });
  it('語を押すと、設定の同期の群へ移る', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><Shell {...props} sync={syncFixture()} overlays={null}><div /></Shell></ActionRoot>);
    const link = screen.getByRole('link', { name: '同期 1 分前' });
    expect(link).toHaveAttribute('href', '#/settings?at=sync');
    fireEvent.click(link);
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'sync' } });
  });
  it('同期オフも語で言い、点は灰色の印（data-state=off）で、押せば同期の群へ行く', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><Shell {...props} sync={syncFixture({ state: 'off', label: '同期オフ' })} overlays={null}><div /></Shell></ActionRoot>);
    expect(container.querySelector('.sync')).toHaveAttribute('data-state', 'off');
    fireEvent.click(screen.getByRole('link', { name: '同期オフ' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'sync' } });
  });
  it('一時停止と 1 回だけ同期の最中は、それぞれ印で見分ける', () => {
    const { container, rerender } = render(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture({ state: 'paused', label: '同期を一時停止中', reason: 'user' })} overlays={null}><div /></Shell></ActionRoot>);
    expect(container.querySelector('.sync')).toHaveAttribute('data-state', 'paused');
    expect(container.querySelector('.sync')).toHaveAttribute('data-reason', 'user');
    expect(container.querySelector('.sync-label')).not.toHaveClass('sync-error');
    rerender(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture({ state: 'paused', label: '1 回だけ同期中…', reason: 'user', once: true })} overlays={null}><div /></Shell></ActionRoot>);
    expect(container.querySelector('.sync')).toHaveAttribute('data-once');
  });
  // 無料枠で止まったときは、手で止めたのと見分けがつくよう点と文を赤にする（CSS が data-reason を見る）。
  it('無料枠で止まったときは点に data-reason を付け、文を警告の色にする', () => {
    const base = syncFixture({ state: 'paused', label: '無料枠で停止 · 9:00 にリセット', reason: 'quota' });
    const { container, rerender } = render(<ActionRoot onAction={() => {}}><Shell {...props} sync={base} overlays={null}><div /></Shell></ActionRoot>);
    expect(container.querySelector('.sync')?.getAttribute('data-reason')).toBe('quota');
    expect(container.querySelector('.sync-label')).toHaveClass('sync-error');
    expect(screen.getByText('無料枠で停止 · 9:00 にリセット')).toBeInTheDocument();
    rerender(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture()} overlays={null}><div /></Shell></ActionRoot>);
    expect(container.querySelector('.sync')?.hasAttribute('data-reason')).toBe(false);
  });
  it('エラーは文を警告の色にする。一時停止中に版で止まっているときも同じ', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture({ state: 'error', label: '同期を一時停止中 · 同期エラー: x' })} overlays={null}><div /></Shell></ActionRoot>);
    expect(container.querySelector('.sync-label')).toHaveClass('sync-error');
    expect(container.querySelector('.sync')).toHaveAttribute('data-state', 'error');
  });
  it('件数は溜まっているときだけ出す', () => {
    const sync = syncFixture({ sweepPending: '未送信のトランスクリプト 1500', skipped: '送信に失敗したトランスクリプト 2' });
    const { rerender } = render(<ActionRoot onAction={() => {}}><Shell {...props} sync={sync} overlays={null}><div /></Shell></ActionRoot>);
    expect(screen.getByText('未送信のトランスクリプト 1500')).toBeInTheDocument();
    expect(screen.getByText('送信に失敗したトランスクリプト 2')).toBeInTheDocument();
    rerender(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture()} overlays={null}><div /></Shell></ActionRoot>);
    expect(screen.queryByText(/未送信/)).toBeNull();
    expect(screen.queryByText(/送信に失敗/)).toBeNull();
  });
  it('まだ届いていない間（visible が偽）は、同期の一行を描かない', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture({ visible: false, state: 'off', label: '' })} overlays={null}><div /></Shell></ActionRoot>);
    expect(container.querySelector('.sync')).toBeNull();
  });
  it('件数が無いとき使用量ゲージは残る', () => {
    render(<ActionRoot onAction={() => {}}><Shell {...props} sync={syncFixture({ state: 'pushing', label: '送信中' })} usage={{ fiveHour: 12, sevenDay: 34, fiveHourResets: null, sevenDayResets: null, updatedLabel: '3 分前' }} overlays={null}><div /></Shell></ActionRoot>);
    expect(screen.getByText('送信中')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: '5 時間枠の使用率' })).toBeInTheDocument();
    expect(screen.getByText('最終更新 3 分前')).toBeInTheDocument();
  });
  // .app ではヘッダの空いた所を掴んで窓を動かす。操作する部品に印が付くと、押しても窓が動くだけになる。
  it('ヘッダ本体と余白だけを、窓を掴む場所にする', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
    const header = container.querySelector('header.header')!;
    expect(header).toHaveAttribute('data-tauri-drag-region');
    // 部品を包む箱にも印を付ける。印の無い箱の上では、掴んでも窓が動かない。
    for (const sel of ['.spacer', '.header-brand', '.header-row', '.header-end']) expect(header.querySelector(sel), sel).toHaveAttribute('data-tauri-drag-region');
    const controls = header.querySelectorAll('button, input, a');
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) expect(el).not.toHaveAttribute('data-tauri-drag-region');
  });
  // ヘッダーの入口は打つ欄ではなく、押す錠剤である（A1）。押すとパレットが開き、全文検索はパレットの最後の行から行く。
  it('入口は虫眼鏡と「移動・操作」と ⌘K のキー帽の錠剤で、キー帽は読み上げから外す', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
    expect(screen.queryByRole('searchbox')).toBeNull();
    const pill = screen.getByRole('button', { name: '移動・操作' });
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
    render(<ActionRoot onAction={vi.fn()}><Shell {...props} overlays={null}><div /></Shell></ActionRoot>);
    const nav = screen.getByRole('navigation');
    expect(iconOf(within(nav).getByRole('link', { name: 'ホーム' }))).toBe('home');
    expect(iconOf(within(nav).getByRole('link', { name: 'プロジェクト' }))).toBe('projects');
    expect(iconOf(screen.getByRole('button', { name: '新しいセッション' }))).toBe('add');
  });
});
