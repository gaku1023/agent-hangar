import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type Intent } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { presentHomeBand, type AttentionCard, type BandGroup, type ConfirmCard, type ReturnCard, type RunningCard } from '../presenters/home.ts';
import { HomeBand } from './HomeBand.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const ja = translator('ja');
const waiting = (id: string): AttentionCard => ({ id, name: `待ち ${id}`, projectName: 'alpha', waited: '12分', question: `問い ${id}`, answer: 'terminal' });
const reminder = (id: string): ReturnCard => ({ id, name: `戻る ${id}`, projectName: 'alpha', reason: '結果を確かめる', returnOn: '2026-10-02', returnTime: null, overdueDays: 0, due: true, pastMin: null });
const running = (id: string): RunningCard => ({ id, name: `動く ${id}`, live: 'busy', aside: false, elapsed: '5分', meta: 'alpha · opus', intent: '上限を足す', activity: { tool: 'Edit', summary: 'a.ts' }, note: null, contextPercent: 40, contextLabel: '40%' });
const todo = (id: string): ConfirmCard => ({ kind: 'todo', id, text: `やる ${id}`, projectId: 'alpha', projectName: 'alpha', sessionName: 'one', ago: '1 時間前', note: '片付いた' });
const none = { attention: [], returning: [], running: [], confirm: [] };
const busy = { attention: [waiting('a'), waiting('b')], returning: [reminder('r')], running: [running('x')], confirm: [todo('t1'), todo('t2')] };

const unresolved: BandGroup = {
  id: 'unresolved', label: '場所の不明なプロジェクト', icon: 'alert', tone: 'default', count: 1, summary: '1 件', morning: false,
  rows: [{ key: 'pj:p1', lead: { kind: 'todo' }, name: 'old-shop', context: null, text: '前のパス /w/old-shop', detail: null, tone: null, trail: [], open: null, actions: [{ id: 'relocate', label: '場所を再指定', ariaLabel: '場所を再指定、old-shop', primary: false, ghost: false, intent: { type: 'nav.go', to: { name: 'projects' } } }] }],
};

function mount(input: Parameters<typeof presentHomeBand>[0], opts: { searching?: boolean; extra?: BandGroup[]; note?: string | null } = {}) {
  const onIntent = vi.fn<(i: Intent) => void>();
  const band = presentHomeBand(input, ja, opts.extra);
  const ui = (b: typeof band, searching?: boolean) => (
    <LanguageRoot language="ja"><IntentRoot onIntent={onIntent}><HomeBand {...b} searching={searching} note={opts.note} /></IntentRoot></LanguageRoot>
  );
  const view = render(ui(band, opts.searching));
  return { onIntent, rerender: (input2: Parameters<typeof presentHomeBand>[0], searching?: boolean) => view.rerender(ui(presentHomeBand(input2, ja, opts.extra), searching)), container: view.container };
}
const pill = (name: string | RegExp) => screen.getByRole('button', { name });

describe('HomeBand の錠剤', () => {
  it('3 つの錠剤を、名前と件数で並べる。要対応は入力待ちとリマインダーの合計', () => {
    mount(busy);
    const band = screen.getByRole('region', { name: 'ホームの件数' });
    expect(within(band).getAllByRole('button', { name: /^(要対応|実行中|確認待ち) \d+$/ }).map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['要対応 3', '実行中 1', '確認待ち 2']);
  });

  it('錠剤は、Enter と Space で開閉できる本物のボタンで、開いているかを aria-expanded に出す', () => {
    mount(busy);
    const att = pill('要対応 3');
    expect(att.tagName).toBe('BUTTON');
    expect(att).toHaveAttribute('type', 'button');
    expect(att).toHaveAttribute('aria-expanded', 'true');
    expect(pill('実行中 1')).toHaveAttribute('aria-expanded', 'false');
  });

  it('0 件の群は押せない（ボタンにせず、薄い札で出す）', () => {
    mount({ ...none, running: [running('x')] });
    expect(screen.queryByRole('button', { name: '要対応 0' })).toBeNull();
    expect(screen.getByText('要対応').closest('.count-chip')).toHaveAttribute('data-zero', 'true');
    expect(screen.getByText('確認待ち').closest('.count-chip')).toHaveAttribute('data-zero', 'true');
  });

  it('全部 0 件のときは何も描かない（「実行中のセッションはありません」の 1 行は画面の側が出す）', () => {
    const { container } = mount(none);
    expect(container).toBeEmptyDOMElement();
  });

  it('4 つ目の群を足すと、4 つ目の錠剤と引き出しが出る', () => {
    mount({ ...none, running: [running('x')] }, { extra: [unresolved] });
    const p = pill('場所の不明なプロジェクト 1');
    fireEvent.click(p);
    const drawer = screen.getByRole('region', { name: '場所の不明なプロジェクト' });
    expect(within(drawer).getByText('old-shop')).toBeInTheDocument();
    expect(p).toHaveAttribute('aria-controls', drawer.id);
  });
});

describe('HomeBand の引き出し', () => {
  it('朝は、要対応の引き出しだけが開いている', () => {
    mount(busy);
    const drawer = screen.getByRole('region', { name: '要対応' });
    expect(within(drawer).getByText('待ち a')).toBeInTheDocument();
    expect(within(drawer).getByText('戻る r')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '実行中' })).toBeNull();
    expect(screen.queryByRole('region', { name: '確認待ち' })).toBeNull();
    expect(within(drawer).getByText('入力待ち 2、今日のリマインダー 1')).toBeInTheDocument();
  });

  it('要対応が無ければ実行中、それも無ければ確認待ちが開いている', () => {
    mount({ ...none, running: [running('x')], confirm: [todo('t')] });
    expect(screen.getByRole('region', { name: '実行中' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '確認待ち' })).toBeNull();
  });

  it('確認待ちだけのときは確認待ちが開く', () => {
    mount({ ...none, confirm: [todo('t')] });
    expect(screen.getByRole('region', { name: '確認待ち' })).toBeInTheDocument();
  });

  it('押すと、押した群だけが開き、もう一度押すと閉じる', () => {
    mount(busy);
    fireEvent.click(pill('実行中 1'));
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
    expect(screen.getByRole('region', { name: '実行中' })).toBeInTheDocument();
    expect(pill('実行中 1')).toHaveAttribute('aria-expanded', 'true');
    expect(pill('要対応 3')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(pill('実行中 1'));
    expect(screen.queryByRole('region', { name: '実行中' })).toBeNull();
    expect(pill('実行中 1')).toHaveAttribute('aria-expanded', 'false');
  });

  it('「折りたたむ」で閉じ、焦点は押した錠剤へ戻る', () => {
    mount(busy);
    fireEvent.click(within(screen.getByRole('region', { name: '要対応' })).getByRole('button', { name: '折りたたむ' }));
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
    expect(pill('要対応 3')).toHaveFocus();
  });

  it('利用者が閉じた引き出しは、あとから件数が変わっても開き直さない', () => {
    const m = mount(busy);
    fireEvent.click(pill('要対応 3'));
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
    act(() => m.rerender({ ...busy, attention: [waiting('a'), waiting('c')] }));
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
  });

  it('開いている群が 0 件になったら、空の引き出しを残さない', () => {
    const m = mount(busy);
    act(() => m.rerender({ ...busy, attention: [], returning: [] }));
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
  });

  it('検索の最中は、引き出しを閉じて錠剤を件数だけにし、終わると元の開き方へ戻る', () => {
    const m = mount(busy, { searching: true });
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
    expect(screen.queryByRole('button', { name: '要対応 3' })).toBeNull();
    expect(screen.getByText('要対応').closest('.count-chip')).toHaveTextContent('要対応 3');
    expect(screen.getByText('検索中は引き出しを閉じています')).toBeInTheDocument();
    act(() => m.rerender(busy, false));
    expect(screen.getByRole('region', { name: '要対応' })).toBeInTheDocument();
    expect(screen.queryByText('検索中は引き出しを閉じています')).toBeNull();
  });

  it('帯の右端に、画面が渡した 1 行の注記を出せる', () => {
    mount(busy, { note: '始める前の確認：6 つ中 3 つ' });
    expect(screen.getByText('始める前の確認：6 つ中 3 つ')).toBeInTheDocument();
  });
});

describe('HomeBand の行', () => {
  it('行のボタンは、見える語と相手の名前を読み上げの名前にし、押すと Intent を発行する', () => {
    const m = mount(busy);
    const drawer = screen.getByRole('region', { name: '要対応' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'ターミナルで回答、待ち a' }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a', focus: 'terminal' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Done、戻る r' }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 'r', status: 'done' });
  });

  it('名前を押すと、そのセッションかプロジェクトを開く', () => {
    const m = mount(busy);
    fireEvent.click(within(screen.getByRole('region', { name: '要対応' })).getByRole('button', { name: '待ち b' }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'session.open', id: 'b' });
    fireEvent.click(pill('確認待ち 2'));
    fireEvent.click(within(screen.getByRole('region', { name: '確認待ち' })).getByRole('button', { name: 'やる t1' }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'project.open', id: 'alpha' });
  });

  it('開く先の無い行の名前は、ボタンにしない', () => {
    mount({ ...none, running: [running('x')] }, { extra: [unresolved] });
    fireEvent.click(pill('場所の不明なプロジェクト 1'));
    const drawer = screen.getByRole('region', { name: '場所の不明なプロジェクト' });
    expect(within(drawer).queryByRole('button', { name: 'old-shop' })).toBeNull();
    expect(within(drawer).getByRole('button', { name: '場所を再指定、old-shop' })).toBeInTheDocument();
  });

  it('作業中の行は、意図、いまの手、経過とコンテキストを 1 行に出す', () => {
    mount({ ...none, running: [running('x')] });
    const drawer = screen.getByRole('region', { name: '実行中' });
    expect(drawer).toHaveTextContent('動く x');
    expect(drawer).toHaveTextContent('上限を足す');
    expect(drawer).toHaveTextContent('Edit a.ts');
    expect(drawer).toHaveTextContent('作業中 5分');
    expect(drawer).toHaveTextContent('40%');
  });
});
