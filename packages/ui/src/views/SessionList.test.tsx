import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { pagerOf } from '../presenters/pager.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SessionListProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { LoadMore, panelConditionCount, SessionList, StatusTabs } from './SessionList.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const TABS: StatusTabProps[] = ([['all', 'すべて', '12'], ['proposed', '確認待ち', '1'], ['active', 'Active', '5'], ['paused', 'Paused', '2'], ['done', 'Done', '4'], ['archived', 'Archived', '0']] as [StatusTab, string, string][]).map(([tab, label, count]) => ({ tab, label, count, hot: tab === 'proposed' }));
const listProps = (over: Partial<SessionListProps> = {}): SessionListProps => ({ text: '', filter: {}, projects: [{ id: 'p1', name: 'alpha' }, { id: 'p2', name: 'beta' }], rows: [row('a'), row('b')], total: 2, loading: false, mode: 'all', conditions: [], tabs: TABS, tab: 'all', pager: null, statusColumn: true, tokens: [], hints: [], allCount: 12, ...over });
const mountList = (over: Partial<SessionListProps> = {}, extra: Partial<Parameters<typeof SessionList>[0]> = {}, onAction = vi.fn()) => ({ ...render(<ActionRoot onAction={onAction}><div className="host"><SessionList {...listProps(over)} {...extra} /></div></ActionRoot>), onAction });

describe('SessionList（ホームとプロジェクトの画面が使う部品）', () => {
  it('見出しを持たず、タブ、欄と絞り込みのボタン、行を 1 つの組として並べる。絞り込みはボタンを押すまで出さない', () => {
    mountList();
    expect(screen.queryByRole('heading')).toBeNull();
    const host = document.querySelector('.host') as HTMLElement;
    expect([...host.children].map((c) => c.className.split(' ')[0])).toEqual(['sessions-tabs', 'search-row', 'rows-host']);
  });
  it('絞り込みのボタンを押すと、欄の下に絞り込みが開く。もう一度押すと閉じる', () => {
    mountList();
    const host = document.querySelector('.host') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: '絞り込み' }));
    expect([...host.children].map((c) => c.className.split(' ')[0])).toEqual(['sessions-tabs', 'search-row', 'sessions-filters', 'rows-host']);
    expect(screen.getByRole('button', { name: '絞り込み' })).toHaveAttribute('aria-controls', host.querySelector('.sessions-filters')!.id);
    fireEvent.click(screen.getByRole('button', { name: '絞り込み' }));
    expect(host.querySelector('.sessions-filters')).toBeNull();
  });
  it('状態のタブ、欄、絞り込みの語は search.* の意図で出す', () => {
    const { onAction } = mountList();
    fireEvent.click(within(screen.getByRole('group', { name: '状態' })).getByRole('button', { name: /^Done/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: '絞り込み' }));
    fireEvent.keyDown(screen.getByLabelText('操作したファイル'), { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { file: undefined } });
  });
  it('プロジェクトを固定するときは、絞り込みにプロジェクトの選択を出さず、ボタンの数にも入れない', () => {
    mountList({ filter: { projectId: 'p1' } }, { projectFixed: true });
    expect(screen.getByRole('button', { name: '絞り込み' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '絞り込み' }));
    expect(screen.queryByRole('button', { name: 'プロジェクト' })).toBeNull();
    expect(screen.getByRole('radiogroup', { name: '期間' })).toBeInTheDocument();
  });
  it('プロジェクトを固定するときは、行にプロジェクト名を出さない。固定しないときは出す', () => {
    const { unmount } = mountList({}, { projectFixed: true });
    expect(document.querySelector('.row-proj')).toBeNull();
    unmount();
    mountList();
    expect(document.querySelectorAll('.row-proj')).toHaveLength(2);
  });
  it('欄の語を消すボタンは、いまの絞り込みを添えて出す（プロジェクトの画面で、画面を移さずに語だけを外すため）', () => {
    const { onAction } = mountList({ text: '動画', filter: { status: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'キーワードをクリア' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.query', text: '', filter: { status: 'done' } });
  });
  it('ボタンの印に数えるのは、絞り込みの中にあるプロジェクト、期間、操作したファイルだけ', () => {
    expect(panelConditionCount({})).toBe(0);
    expect(panelConditionCount({ status: 'done', live: 'waiting' })).toBe(0);
    expect(panelConditionCount({ projectId: 'p1', days: 7, file: 'a.ts' })).toBe(3);
    expect(panelConditionCount({ projectId: 'p1', days: 7 }, true)).toBe(1);
  });
  it('絞り込みの下に、条件の行と件数を出す。タブだけの絞り込みでは出さない', () => {
    const { unmount } = mountList({ conditions: ['『動画』', '7 日'], total: 3 });
    const cond = screen.getByRole('status', { name: '絞り込みの条件' });
    expect(cond).toHaveTextContent('3 件');
    unmount();
    mountList({ tab: 'done', filter: { status: 'done' }, conditions: ['Done'], total: 3 });
    expect(screen.queryByRole('status', { name: '絞り込みの条件' })).toBeNull();
  });
  it('条件の無い一覧はページ送りで、ページの番号と件数を意図で出す', () => {
    const { onAction } = mountList({ pager: pagerOf(1, 25, 60) });
    fireEvent.click(screen.getByRole('button', { name: '2 ページ目' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.page', page: 2 });
  });
  it('一致が無い検索は、空の文を出す', () => {
    mountList({ rows: [], total: 0, mode: 'search', conditions: ['『x』'], text: 'x' });
    expect(screen.getByText('一致するセッションはありません')).toBeInTheDocument();
  });
  it('節の見出しは持たない。条件が無くても行を平らに並べる', () => {
    mountList({ rows: [row('a'), row('b', { state: 'done' }), row('c', { state: 'paused' })], total: 3 });
    expect(document.querySelector('.row-head')).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('LoadMore（検索の「さらに読み込む」）', () => {
  it('残りの件数と、次に読む件数を言い、押すと呼ぶ', () => {
    const onMore = vi.fn();
    render(<LoadMore remaining={120} step={50} onLoad={onMore} />);
    const b = screen.getByRole('button', { name: 'さらに 50 件を読み込む' });
    expect(screen.getByText('残り 120 件')).toBeInTheDocument();
    fireEvent.click(b);
    expect(onMore).toHaveBeenCalledTimes(1);
  });
  it('残りが次の件数に足りないときは、残りの件数だけを読むと言う', () => {
    render(<LoadMore remaining={12} step={50} onLoad={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'さらに 12 件を読み込む' })).toBeInTheDocument();
  });
  it('読み込んでいる間は押せない', () => {
    render(<LoadMore remaining={12} step={50} loading onLoad={vi.fn()} />);
    expect(screen.getByRole('button', { name: '読み込んでいます' })).toBeDisabled();
  });
  it('一覧は、読み込む指定があればページ送りの代わりに末尾へ出す', () => {
    const onLoad = vi.fn();
    mountList({ mode: 'search', conditions: ['『x』'], text: 'x', total: 120 }, { loadMore: { remaining: 118, step: 50, onLoad } });
    expect(screen.queryByRole('navigation', { name: 'セッションのページ' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'さらに 50 件を読み込む' }));
    expect(onLoad).toHaveBeenCalled();
  });
});

describe('StatusTabs（部品としての単独）', () => {
  it('件数つきで並べ、選んだタブを意図で出す', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><StatusTabs tabs={TABS} tab="active" /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: /^Paused/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'paused' } });
  });
});

describe('SessionList の切替の動き（⑤ と ⑥）', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => { restore = fakeMotionTokens(undefined, { everywhere: true }); });
  afterEach(() => { restore?.(); restore = null; });
  const real = { left: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')!, top: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')!, width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!, height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')! };
  let frames: FrameRequestCallback[] = [];
  const ORDER = ['all', 'proposed', 'active', 'paused', 'done', 'archived'];
  beforeEach(() => {
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    // タブは 100px おきに 1 段で並び、幅 90px、高さ 28px とする。
    const tabIndex = (el: HTMLElement) => (el.classList.contains('sessions-tab') ? ORDER.findIndex((k) => el.dataset.tab === k) : -1);
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get(this: HTMLElement) { return Math.max(0, tabIndex(this)) * 100; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return 0; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return tabIndex(this) >= 0 ? 90 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return tabIndex(this) >= 0 ? 28 : 0; } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, d] of Object.entries({ offsetLeft: real.left, offsetTop: real.top, offsetWidth: real.width, offsetHeight: real.height })) Object.defineProperty(HTMLElement.prototype, k, d);
  });
  const flush = () => act(() => { const now = frames; frames = []; now.forEach((f) => f(0)); });
  const ui = (over: Partial<SessionListProps>) => <ActionRoot onAction={vi.fn()}><SessionList {...listProps(over)} /></ActionRoot>;

  it('選んだタブの塗りを 1 つ置き、タブを替えると塗りの位置だけが移る', () => {
    const { container, rerender } = render(ui({ tab: 'all' }));
    const thumb = container.querySelector<HTMLElement>('.sessions-tabs > .sessions-tab-thumb')!;
    expect(thumb).toHaveAttribute('aria-hidden', 'true');
    expect([thumb.style.left, thumb.style.top, thumb.style.width, thumb.style.height]).toEqual(['0px', '0px', '90px', '28px']);
    flush();
    expect(container.querySelector('.sessions-tabs')).toHaveAttribute('data-ready', 'true');
    rerender(ui({ tab: 'done', filter: { status: 'done' } }));
    expect(container.querySelector('.sessions-tab-thumb')).toBe(thumb);
    expect(thumb.style.left).toBe('400px');
  });

  it('タブの件数は回して替える（RollingText）', () => {
    const { container, rerender } = render(ui({ tab: 'all' }));
    const n = () => container.querySelector('[data-tab="active"] .sessions-tab-n .roll');
    expect(n()).toHaveTextContent(/^5$/);
    rerender(ui({ tab: 'all', tabs: TABS.map((x) => (x.tab === 'active' ? { ...x, count: '6' } : x)) }));
    expect(n()).toHaveAttribute('data-rolling', 'true');
  });

  it('一覧の行は滑らせない。同じ条件とページのまま上がった行と新しい行だけに淡い黄の印を付け、タブやページを替えた描画では付けない', () => {
    const { container, rerender } = render(ui({ tab: 'all', rows: [row('a'), row('b'), row('c')] }));
    const hits = () => [...container.querySelectorAll('.row[data-hit]')].map((r) => r.getAttribute('data-morph-id')).sort();
    expect(container.querySelector('.list-scroll')).not.toHaveAttribute('data-glide');
    rerender(ui({ tab: 'all', rows: [row('n'), row('c'), row('a'), row('b')] }));
    expect(hits()).toEqual(['c', 'n']);
    const fresh = render(ui({ tab: 'all', rows: [row('a'), row('b')] }));
    fresh.rerender(ui({ tab: 'done', filter: { status: 'done' }, rows: [row('b'), row('a'), row('z')] }));
    fresh.rerender(ui({ tab: 'done', filter: { status: 'done' }, rows: [row('b'), row('a'), row('z')], total: 200, pager: pagerOf(2, 50, 200) }));
    expect(fresh.container.querySelectorAll('.row[data-hit]')).toHaveLength(0);
  });
});
