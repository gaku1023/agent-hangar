import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { pagerOf } from '../presenters/pager.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SessionListProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { LoadMore, SessionList, StatusTabs } from './SessionList.tsx';
import { SessionsScreen } from './SessionsScreen.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const TABS: StatusTabProps[] = ([['all', 'すべて', '12'], ['proposed', '確かめる', '1'], ['active', 'Active', '5'], ['paused', 'Paused', '2'], ['done', 'Done', '4'], ['archived', 'Archived', '0']] as [StatusTab, string, string][]).map(([tab, label, count]) => ({ tab, label, count, hot: tab === 'proposed' }));
const listProps = (over: Partial<SessionListProps> = {}): SessionListProps => ({ text: '', filter: {}, projects: [{ id: 'p1', name: 'alpha' }, { id: 'p2', name: 'beta' }], rows: [row('a'), row('b')], total: 2, loading: false, mode: 'all', conditions: [], tabs: TABS, tab: 'all', sections: null, tokens: [], hints: [], pager: null, statusColumn: true, ...over });
const mountList = (over: Partial<SessionListProps> = {}, extra: Partial<Parameters<typeof SessionList>[0]> = {}, onIntent = vi.fn()) => ({ ...render(<IntentRoot onIntent={onIntent}><div className="host"><SessionList {...listProps(over)} {...extra} /></div></IntentRoot>), onIntent });

describe('SessionList（ホームとプロジェクトの画面が使う部品）', () => {
  it('見出しを持たず、タブ、欄、絞り込み、行を 1 つの組として並べる', () => {
    mountList();
    expect(screen.queryByRole('heading')).toBeNull();
    const host = document.querySelector('.host') as HTMLElement;
    expect([...host.children].map((c) => c.className.split(' ')[0])).toEqual(['sessions-tabs', 'sessions-keyword', 'sessions-filters', 'rows-host']);
  });
  it('セッションの一覧の画面は、見出しの後ろにこの部品と同じ DOM を置く（見た目を変えない）', () => {
    const p = listProps({ rows: [row('a'), row('b', { state: 'done' })], total: 2, conditions: ['7 日'], filter: { days: 7 }, tokens: [{ key: 'days', token: 'since:7d' }], pager: pagerOf(1, 25, 60) });
    const standalone = render(<IntentRoot onIntent={vi.fn()}><div className="host"><SessionList {...p} /></div></IntentRoot>);
    const html = (standalone.container.querySelector('.host') as HTMLElement).innerHTML;
    standalone.unmount();
    const { container } = render(<IntentRoot onIntent={vi.fn()}><SessionsScreen {...p} allCount={12} /></IntentRoot>);
    const screenEl = container.querySelector('.sessions-screen') as HTMLElement;
    expect(screenEl.className).toContain('screen-fill');
    expect(screenEl.firstElementChild?.querySelector('h1')).not.toBeNull();
    const rest = [...screenEl.children].slice(1).map((c) => c.outerHTML).join('');
    // useId の連番は描いた順で変わるので、そろえて比べる。
    const plain = (h: string) => h.replace(/_r_[0-9a-z]+_/g, '_r_');
    expect(plain(rest)).toBe(plain(html));
  });
  it('状態のタブ、欄、絞り込みの語は search.* の意図で出す', () => {
    const { onIntent } = mountList();
    fireEvent.click(within(screen.getByRole('group', { name: '状態' })).getByRole('button', { name: /^Done/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.keyDown(screen.getByLabelText('ファイル'), { key: 'Enter' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { file: undefined } });
  });
  it('プロジェクトを固定するときは、絞り込みにプロジェクトの選択を出さない', () => {
    mountList({}, { projectFixed: true });
    expect(screen.queryByRole('combobox', { name: 'プロジェクト' })).toBeNull();
    expect(screen.queryByRole('button', { name: /プロジェクト/ })).toBeNull();
    expect(screen.getByRole('radiogroup', { name: '期間' })).toBeInTheDocument();
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
    const { onIntent } = mountList({ pager: pagerOf(1, 25, 60) });
    fireEvent.click(screen.getByRole('button', { name: '2 ページ目' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.page', page: 2 });
  });
  it('一致が無い検索は、空の文を出す', () => {
    mountList({ rows: [], total: 0, mode: 'search', conditions: ['『x』'], text: 'x' });
    expect(screen.getByText('一致するセッションはありません')).toBeInTheDocument();
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
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><StatusTabs tabs={TABS} tab="active" /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: /^Paused/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'paused' } });
  });
});
