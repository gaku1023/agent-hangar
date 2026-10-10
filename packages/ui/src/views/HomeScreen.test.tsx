import { fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type UiAction, type ReadinessDto } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentHomeBand, type AttentionCard, type ConfirmCard, type HomeScreenProps, type ReturnCard, type RunningCard } from '../presenters/home.ts';
import { presentReadiness } from '../presenters/readiness.ts';
import { pagerOf } from '../presenters/pager.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { ListItem } from '../presenters/listItem.ts';
import type { SessionListProps, StatusTab, StatusTabProps } from '../presenters/sessions.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const ja = translator('ja');
const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const TABS: StatusTabProps[] = ([['all', 'すべて', '1,236'], ['proposed', '確認待ち', '3'], ['active', 'Active', '5'], ['paused', 'Paused', '4'], ['done', 'Done', '1,221'], ['archived', 'Archived', '5']] as [StatusTab, string, string][]).map(([tab, label, count]) => ({ tab, label, count, hot: tab === 'proposed' }));
const listProps = (over: Partial<SessionListProps> = {}): SessionListProps => ({ text: '', filter: {}, projects: [{ id: 'p1', name: 'agent-hangar' }, { id: 'p4', name: 'my app' }], rows: [row('a'), row('b')], total: 2, loading: false, mode: 'all', conditions: [], tabs: TABS, tab: 'all', pager: null, statusColumn: true, tokens: [], hints: [], allCount: 1241, ...over });

const waiting = (id: string): AttentionCard => ({ id, name: `待ち ${id}`, projectName: 'alpha', waited: '12分', question: `問い ${id}`, answer: 'terminal' });
const reminder = (id: string): ReturnCard => ({ id, name: `戻る ${id}`, projectName: 'alpha', reason: '結果を確かめる', returnOn: '2026-10-02', returnTime: null, overdueDays: 0, due: true, pastMin: null });
const running = (id: string): RunningCard => ({ id, name: `動く ${id}`, live: 'busy', aside: false, elapsed: '5分', meta: 'alpha · opus', intent: '上限を足す', activity: { tool: 'Edit', summary: 'a.ts' }, note: null, contextPercent: 40, contextLabel: '40%' });
const todo = (id: string): ConfirmCard => ({ kind: 'todo', id, text: `やる ${id}`, projectId: 'alpha', projectName: 'alpha', sessionName: 'one', ago: '1 時間前', note: '片付いた' });
const busy = { attention: [waiting('a'), waiting('b')], returning: [reminder('r')], running: [running('x')], confirm: [todo('t1')] };
const none = { attention: [], returning: [], running: [], confirm: [] };
const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash x', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};

const props = (over: Partial<HomeScreenProps> = {}, cards: typeof busy = busy): HomeScreenProps => {
  const band = presentHomeBand(cards, ja);
  return { band, idle: band.groups.every((g) => g.count === 0), searching: false, list: listProps(), allCount: 1241, loadMore: null, note: null, ...over };
};
const mount = (over: Partial<HomeScreenProps> = {}, cards: typeof busy = busy, onAction = vi.fn<(i: UiAction) => void>()) => ({ ...render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeScreen {...props(over, cards)} /></ActionRoot></LanguageRoot>), onAction });
const tabs = () => within(screen.getByRole('group', { name: '状態' }));

describe('HomeScreen の並び（試作 B）', () => {
  it('見出し、帯、一覧の見出し、タブ、欄と絞り込みのボタン、行の順に置く。最近とプロジェクトの 1 行は無い', () => {
    const { container } = mount();
    const root = container.querySelector('.home') as HTMLElement;
    expect(root.className).toContain('screen-fill');
    expect([...root.children].map((c) => c.className.split(' ')[0])).toEqual(['page-head', 'home-band', 'list-head', 'sessions-tabs', 'search-row', 'rows-host']);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ホーム');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^セッション1,241 件$/);
    expect(screen.queryByText('最近')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'プロジェクト' })).toBeNull();
    expect(screen.queryByText('すべて見る')).toBeNull();
  });
  it('実行中の意図とツール呼び出しの札は無い。帯を押して引き出しを開くまで見えない', () => {
    mount();
    expect(document.querySelector('.live-card')).toBeNull();
    expect(screen.queryByText('上限を足す')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '実行中 1' }));
    expect(screen.getByText('上限を足す')).toBeInTheDocument();
  });
});

describe('HomeScreen の帯と引き出し', () => {
  it('錠剤は 3 つで、朝は要対応の引き出しが開いている', () => {
    mount();
    const band = screen.getByRole('region', { name: 'ホームの件数' });
    expect(within(band).getAllByRole('button', { name: /^(要対応|実行中|確認待ち) \d+$/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: '要対応 3' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: '要対応' })).toBeInTheDocument();
    expect(screen.getByText('問い a')).toBeInTheDocument();
  });
  it('要対応が無ければ、実行中の引き出しが開く', () => {
    mount({}, { ...none, running: [running('x')], confirm: [todo('t1')] });
    expect(screen.getByRole('button', { name: '実行中 1' })).toHaveAttribute('aria-expanded', 'true');
  });
  it('検索の最中は引き出しを閉じ、錠剤を件数だけの札にして、そのことを言う', () => {
    mount({ searching: true });
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^要対応/ })).toBeNull();
    expect(screen.getByText('検索中は引き出しを閉じています')).toBeInTheDocument();
    expect(screen.getByText('要対応').closest('.count-chip')).toHaveTextContent('3');
  });
  it('検索が終われば、元の開き方へ戻る', () => {
    const onAction = vi.fn();
    const { rerender } = render(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeScreen {...props({ searching: true })} /></ActionRoot></LanguageRoot>);
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
    rerender(<LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeScreen {...props({ searching: false })} /></ActionRoot></LanguageRoot>);
    expect(screen.getByRole('region', { name: '要対応' })).toBeInTheDocument();
  });
  it('引き出しのボタンは UiAction を出す（ターミナルで回答）', () => {
    const { onAction } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'ターミナルで回答、待ち a' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'a', focus: 'terminal' });
  });
});

describe('HomeScreen の空の日（idle）', () => {
  it('3 つの群がどれも 0 件なら、帯の代わりに「実行中のセッションはありません」の 1 行と 2 つのボタンを出す', () => {
    const { onAction, container } = mount({}, none);
    expect(container.querySelector('.home-band')).toBeNull();
    const line = container.querySelector('.idle-line') as HTMLElement;
    expect(line).toHaveTextContent('実行中のセッションはありません');
    fireEvent.click(within(line).getByRole('button', { name: '新しいセッション' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.new.open' });
    fireEvent.click(within(line).getByRole('button', { name: 'クイックセッションを開始' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.new.open', scratch: true });
  });
  it('件数のある群があるときは出さない', () => {
    const { container } = mount();
    expect(container.querySelector('.idle-line')).toBeNull();
  });
});

describe('HomeScreen の絞り込みのボタン', () => {
  it('絞り込み（プロジェクト、期間、操作したファイル）は、欄の横のボタンの裏にある。はじめは閉じている', () => {
    mount();
    const btn = screen.getByRole('button', { name: '絞り込み' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn.closest('.search-row')).toContainElement(screen.getByLabelText('キーワード'));
    expect(screen.queryByRole('radiogroup', { name: '期間' })).toBeNull();
    expect(screen.queryByLabelText('操作したファイル')).toBeNull();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radiogroup', { name: '期間' })).toBeInTheDocument();
    expect(screen.getByLabelText('操作したファイル')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole('radiogroup', { name: '期間' })).toBeNull();
  });
  it('効いている条件（プロジェクト、期間、操作したファイル）の数をボタンに印で出す。無ければ印は無い', () => {
    const { unmount } = mount();
    expect(document.querySelector('.filter-n')).toBeNull();
    unmount();
    mount({ list: listProps({ filter: { projectId: 'p1', days: 7, file: 'a.ts' } }) });
    const btn = screen.getByRole('button', { name: '絞り込み、条件 3' });
    expect(btn.querySelector('.filter-n')).toHaveTextContent('3');
  });
  it('語と状態は欄とタブがもう言っているので、ボタンの数には入れない', () => {
    mount({ list: listProps({ filter: { status: 'paused', live: 'waiting' }, text: '動画' }) });
    expect(screen.getByRole('button', { name: '絞り込み' })).toBeInTheDocument();
  });
  it('開いた絞り込みの操作は search.filter になる', () => {
    const { onAction } = mount();
    fireEvent.click(screen.getByRole('button', { name: '絞り込み' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '期間' })).getByRole('radio', { name: '7 日' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { days: 7 } });
    fireEvent.keyDown(screen.getByLabelText('操作したファイル'), { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { file: undefined } });
  });
});

describe('HomeScreen の状態のタブ（★）', () => {
  it('件数つきのタブを並べ、確認待ちの数字だけを灯し、選んでいるタブに印を付ける。タブは常に出す', () => {
    mount({ list: listProps({ tab: 'paused' }) });
    expect(tabs().getAllByRole('button').map((b) => b.textContent)).toEqual(['すべて1,236', '確認待ち3', 'Active5', 'Paused4', 'Done1,221', 'Archived5']);
    expect(tabs().getByRole('button', { name: /^確認待ち/ }).querySelector('[data-hot="true"]')).not.toBeNull();
    expect(tabs().getByRole('button', { name: /^Done/ }).querySelector('[data-hot="true"]')).toBeNull();
    expect(tabs().getByRole('button', { name: /^Paused/ })).toHaveAttribute('aria-pressed', 'true');
  });
  it('検索の最中もタブと欄は出す', () => {
    mount({ searching: true, list: listProps({ text: '動画', mode: 'search' }) });
    expect(screen.getByRole('group', { name: '状態' })).toBeInTheDocument();
    expect(screen.getByLabelText('キーワード')).toHaveValue('動画');
  });
  it('タブを押すと状態で絞り、「すべて」は外し、いまのタブは何も出さない', () => {
    const { onAction } = mount({ list: listProps({ tab: 'paused' }) });
    fireEvent.click(tabs().getByRole('button', { name: /^Done/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(tabs().getByRole('button', { name: /^すべて/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: undefined } });
    onAction.mockClear();
    fireEvent.click(tabs().getByRole('button', { name: /^Paused/ }));
    expect(onAction).not.toHaveBeenCalled();
  });
  it('行の状態の札を押すと、そのタブへ移る', () => {
    const { onAction } = mount({ list: listProps({ rows: [row('a', { state: 'archived' }), row('b')], total: 2, conditions: ['7 日'] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Archived のセッションだけを見る' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'archived' } });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
});

describe('HomeScreen の欄（欄が正）', () => {
  it('欄の案内は、名前、要約、トランスクリプトを探すことと、条件の書き方を言う。「名前はコマンドパレットで」は言わない', () => {
    mount();
    const kw = screen.getByLabelText('キーワード');
    expect(kw.getAttribute('placeholder')).toContain('名前、要約、トランスクリプトを検索');
    expect(kw.getAttribute('placeholder')).toContain('is:paused');
    expect(kw.getAttribute('placeholder')).not.toContain('コマンドパレット');
  });
  it('欄の札は「名前」「要約」「トランスクリプト」の 3 つで、語を打っているあいだだけ色が付く', () => {
    const { unmount } = mount();
    const tags = () => Array.from(document.querySelectorAll('.sessions-keyword-tag'));
    expect(tags().map((x) => x.textContent)).toEqual(['名前', '要約', 'トランスクリプト']);
    expect(tags().some((x) => x.hasAttribute('data-on'))).toBe(false);
    unmount();
    mount({ searching: true, list: listProps({ text: '動画', mode: 'search', conditions: ['『動画』'] }) });
    expect(tags().every((x) => x.hasAttribute('data-on'))).toBe(true);
  });
  it('Enter で欄のトークンを読み、今の条件に重ねて search.query を出し、読めた分は欄から消す', () => {
    const { onAction } = mount({ list: listProps({ filter: { projectId: 'p1' } }) });
    const kw = screen.getByLabelText('キーワード') as HTMLInputElement;
    fireEvent.change(kw, { target: { value: 'is:paused 動画 project:"my app"' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.query', text: '動画', filter: { projectId: 'p4', status: 'paused' } });
    expect(kw.value).toBe('動画');
  });
  it('効いている条件を欄の中のチップにし、× と、空の欄の Backspace で外す', () => {
    const { onAction } = mount({ list: listProps({ tokens: [{ key: 'status', token: 'is:paused' }, { key: 'days', token: 'since:7d' }] }) });
    const box = document.querySelector('.sessions-keyword') as HTMLElement;
    expect(within(box).getByText('is:paused')).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'is:paused を外す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: undefined } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.keyDown(kw, { key: 'Backspace' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { days: undefined } });
    onAction.mockClear();
    fireEvent.change(kw, { target: { value: 'x' } });
    fireEvent.keyDown(kw, { key: 'Backspace' });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('読めなかったトークンは、欄の下で語として探していることを知らせる', () => {
    mount({ list: listProps({ text: 'is:pasued', hints: ['「is:pasued」は条件として読めないので、語として本文を探しています。'] }) });
    expect(screen.getByRole('note')).toHaveTextContent('「is:pasued」は条件として読めないので、語として本文を探しています。');
  });
  it('帯に無い期間（since:14d）では、期間の帯のどれにも印を付けない', () => {
    mount({ list: listProps({ filter: { days: 14 }, tokens: [{ key: 'days', token: 'since:14d' }] }) });
    fireEvent.click(screen.getByRole('button', { name: /^絞り込み/ }));
    expect(within(screen.getByRole('radiogroup', { name: '期間' })).queryAllByRole('radio', { checked: true })).toHaveLength(0);
  });
  it('語が変わったら欄を作り直す（外からの文言のリセットが欄に届く）', () => {
    const onAction = vi.fn();
    const ui = (text: string) => <LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeScreen {...props({ list: listProps({ text }) })} /></ActionRoot></LanguageRoot>;
    const { rerender } = render(ui('動画'));
    expect(screen.getByLabelText('キーワード')).toHaveValue('動画');
    rerender(ui(''));
    expect(screen.getByLabelText('キーワード')).toHaveValue('');
  });
});

describe('HomeScreen の検索の結果（見出しと札）', () => {
  const head = (id: 'nameMatch' | 'transcriptMatch', label: string, count: number | null): ListItem => ({ kind: 'head', id, label, count });
  const rows = [row('a', { name: 'CSV の書き出し', nameMarks: [{ text: 'CSV', hit: true }, { text: ' の書き出し', hit: false }] }), row('b', { summaryMatch: true }), row('c', { excerpt: [{ text: '…', hit: false }, { text: 'CSV', hit: true }, { text: '…', hit: false }] })];
  const items: ListItem[] = [head('nameMatch', '名前に一致', 2), { kind: 'row', row: rows[0]! }, { kind: 'row', row: rows[1]! }, head('transcriptMatch', 'トランスクリプトに一致', 12), { kind: 'row', row: rows[2]! }];
  const found = (over: Partial<SessionListProps> = {}) => mount({ searching: true, list: listProps({ text: 'CSV', mode: 'search', conditions: ['『CSV』'], rows, items, total: 14, ...over }) });

  it('「名前に一致」と「トランスクリプトに一致」の見出しを件数つきで挟む', () => {
    found();
    const heads = screen.getAllByRole('heading', { level: 2 }).filter((h) => h.classList.contains('row-head'));
    expect(heads.map((h) => h.textContent)).toEqual(['名前に一致2', 'トランスクリプトに一致12']);
    expect(heads.map((h) => h.getAttribute('data-section'))).toEqual(['nameMatch', 'transcriptMatch']);
  });
  it('件数を言えない見出しは、件数を出さない', () => {
    mount({ searching: true, list: listProps({ text: 'CSV', mode: 'search', rows: rows.slice(0, 2), items: [head('nameMatch', '名前に一致', null), { kind: 'row', row: rows[0]! }, { kind: 'row', row: rows[1]! }], total: 40 }) });
    const h = screen.getByRole('heading', { name: '名前に一致' });
    expect(h.querySelector('.row-head-count')).toBeNull();
  });
  it('名前の一致は、行の名前の中で印を付け、要約に当たった行には「要約に一致」の札を付ける', () => {
    found();
    const els = screen.getAllByRole('row');
    expect(els[0]!.querySelector('.row-name mark.hit')).toHaveTextContent('CSV');
    expect(within(els[1]!).getByText('要約に一致')).toBeInTheDocument();
    expect(within(els[0]!).queryByText('要約に一致')).toBeNull();
    expect(els[2]!.querySelector('.row-name mark')).toBeNull();
  });
  it('見出しは行ではないので、行の数にも矢印の送りにも入らない', () => {
    const { onAction } = found();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    const host = screen.getByTestId('session-rows');
    fireEvent.keyDown(host, { key: 'j' });
    fireEvent.keyDown(host, { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'session.open', id: 'a' }));
  });
  it('items が無ければ、行だけを平らに並べる', () => {
    mount({ searching: true, list: listProps({ text: 'CSV', mode: 'search', rows, total: 3 }) });
    expect(screen.queryByRole('heading', { name: '名前に一致' })).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('HomeScreen の続きの読み方', () => {
  it('検索の結果の末尾に「さらに 50 件を読み込む」と残りの件数を出し、押すと search.more を出す。ページ送りは出さない', () => {
    const { onAction } = mount({ searching: true, list: listProps({ text: '動画', mode: 'search', conditions: ['『動画』'], total: 132 }), loadMore: { remaining: 82, step: 50, loading: false } });
    expect(screen.getByText('残り 82 件')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'セッションのページ' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'さらに 50 件を読み込む' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.more' });
  });
  it('読み込んでいる間は押せない', () => {
    mount({ searching: true, list: listProps({ text: '動画', mode: 'search', total: 132 }), loadMore: { remaining: 82, step: 50, loading: true } });
    expect(screen.getByRole('button', { name: '読み込んでいます' })).toBeDisabled();
  });
  it('条件の無い一覧はページ送りで、25、50、100、200 の件数を選べる', () => {
    const { onAction } = mount({ list: listProps({ total: 60, pager: pagerOf(1, 25, 60) }) });
    fireEvent.click(screen.getByRole('button', { name: '2 ページ目' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.page', page: 2 });
    expect(screen.queryByRole('button', { name: /さらに/ })).toBeNull();
  });
  it('一致が無い検索は、空の文を出す', () => {
    mount({ searching: true, list: listProps({ rows: [], total: 0, mode: 'search', conditions: ['『x』'], text: 'x' }) });
    expect(screen.getByText('一致するセッションはありません')).toBeInTheDocument();
  });
  it('条件の行は、条件と件数と「条件をクリア」を出す。タブだけの絞り込みでは出さない', () => {
    const { unmount } = mount({ list: listProps({ conditions: ['『動画』', '7 日'], total: 3 }) });
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('3 件');
    fireEvent.click(screen.getByRole('button', { name: '条件をクリア' }));
    unmount();
    mount({ list: listProps({ tab: 'done', filter: { status: 'done' }, conditions: ['Done'], total: 3 }) });
    expect(screen.queryByRole('status', { name: '絞り込みの条件' })).toBeNull();
  });
});

describe('HomeScreen の行（2 段）', () => {
  it('2 段目の右端に、PR の番号とノートの印を出す。どちらも無い行には出さない', () => {
    mount({ list: listProps({ rows: [row('a', { prUrl: 'https://github.com/o/r/pull/88', memo: '覚え書き' }), row('b', { prUrl: 'https://example.com/x' }), row('c')], total: 3 }) });
    const rows = screen.getAllByRole('row');
    expect(within(rows[0]!).getByRole('link', { name: 'PR #88' })).toHaveAttribute('href', 'https://github.com/o/r/pull/88');
    expect(within(rows[0]!).getByRole('img', { name: 'ノートあり' })).toBeInTheDocument();
    // 番号が URL から取れなければ「PR」とだけ出す。
    expect(within(rows[1]!).getByRole('link', { name: 'PR' })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('img', { name: 'ノートあり' })).toBeNull();
    expect(rows[2]!.querySelector('.row-marks')).toBeNull();
  });
  it('PR の番号を押しても、行は開かない', () => {
    const { onAction } = mount({ list: listProps({ rows: [row('a', { prUrl: 'https://github.com/o/r/pull/88' })], total: 1 }) });
    fireEvent.click(screen.getByRole('link', { name: 'PR #88' }));
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
});

describe('HomeScreen の始める前の確認（帯の最後の群）', () => {
  const ready = presentReadiness(READY, ja)!;
  const withReady = (cards: typeof busy) => {
    const base = presentHomeBand(cards, ja, [ready.group]);
    return { band: base, idle: false, note: ready.note };
  };
  it('確認の群は帯の錠剤になり、帯の右端に 1 行の文を出す。ようこその札と確認リストの区画は無い', () => {
    const { container } = mount(withReady(none), none);
    expect(screen.getByRole('button', { name: /^セットアップの確認 6 つ中 3 つ$/ })).toBeInTheDocument();
    expect(container.querySelector('.band-text')).toHaveTextContent('もう始められます。設定の残りは 3 件です');
    expect(container.querySelector('.onboarding')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'ようこそ' })).toBeNull();
    // 一覧の空の札の「クイックセッションを開始」は、初めての人に残す。
    expect(container.querySelector('.home')).not.toBeNull();
  });
  it('セッションがまだ 1 つも無い人には、一覧の空の札に「クイックセッションを開始」を残す。帯の 1 行は重ねない', () => {
    const { onAction } = mount({ ...withReady(none), allCount: 0, list: listProps({ rows: [], total: 0, allCount: 0 }) }, none);
    expect(screen.getByRole('heading', { name: 'セッションはまだありません' })).toBeInTheDocument();
    expect(screen.getByText('セットアップの確認が済んでいなくても、クイックセッションから始められます')).toBeInTheDocument();
    expect(screen.queryByText('実行中のセッションはありません')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'クイックセッションを開始' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.open', scratch: true });
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.open' });
  });
  it('セッションがある人の一覧には、空の札を出さない', () => {
    mount();
    expect(screen.queryByRole('heading', { name: 'セッションはまだありません' })).toBeNull();
  });
  it('確認が無いときは、帯に文を出さない', () => {
    const { container } = mount();
    expect(container.querySelector('.band-text')).toBeNull();
  });
});
