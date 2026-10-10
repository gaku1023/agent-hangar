import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type UiAction, type ProjectDto, type ReadinessDto, type SessionDto } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentHomeBand, type AttentionCard, type BandGroup, type ConfirmCard, type ReturnCard, type RunningCard } from '../presenters/home.ts';
import { presentReadiness } from '../presenters/readiness.ts';
import { presentUnresolved } from '../presenters/unresolved.ts';
import { initialStore } from '../store/store.ts';
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
  rows: [{ key: 'pj:p1', lead: { kind: 'todo' }, name: 'old-shop', context: null, text: '前のパス /w/old-shop', detail: null, tone: null, trail: [], open: null, actions: [{ id: 'relocate', label: '場所を再指定', ariaLabel: '場所を再指定、old-shop', primary: false, ghost: false, send: { type: 'nav.go', to: { name: 'projects' } } }] }],
};

function mount(input: Parameters<typeof presentHomeBand>[0], opts: { searching?: boolean; extra?: BandGroup[]; note?: string | null } = {}) {
  const onAction = vi.fn<(i: UiAction) => void>();
  const band = presentHomeBand(input, ja, opts.extra);
  const ui = (b: typeof band, searching?: boolean) => (
    <LanguageRoot language="ja"><ActionRoot onAction={onAction}><HomeBand {...b} searching={searching} note={opts.note} /></ActionRoot></LanguageRoot>
  );
  const view = render(ui(band, opts.searching));
  return { onAction, rerender: (input2: Parameters<typeof presentHomeBand>[0], searching?: boolean) => view.rerender(ui(presentHomeBand(input2, ja, opts.extra), searching)), container: view.container };
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
  it('行のボタンは、見える語と相手の名前を読み上げの名前にし、押すと UiAction を発行する', () => {
    const m = mount(busy);
    const drawer = screen.getByRole('region', { name: '要対応' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'ターミナルで回答、待ち a' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a', focus: 'terminal' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Done、戻る r' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 'r', status: 'done' });
  });

  it('名前を押すと、そのセッションかプロジェクトを開く', () => {
    const m = mount(busy);
    fireEvent.click(within(screen.getByRole('region', { name: '要対応' })).getByRole('button', { name: '待ち b' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'b' });
    fireEvent.click(pill('確認待ち 2'));
    fireEvent.click(within(screen.getByRole('region', { name: '確認待ち' })).getByRole('button', { name: 'やる t1' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'project.open', id: 'alpha' });
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

describe('HomeBand の始める前の確認（2.11.4）', () => {
  const READY: ReadinessDto = {
    tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
    workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash x', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
    commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
    compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
  };
  const band = presentReadiness(READY, ja)!;
  const open = () => mount(none, { extra: [band.group], note: band.note });
  const drawer = () => within(screen.getByRole('region', { name: 'セットアップの確認' }));

  it('錠剤は「6 つ中 3 つ」で、進みの棒と帯の文を添える。確認の群だけのときは引き出しが開いている', () => {
    const { container } = open();
    const chip = pill(/^セットアップの確認 6 つ中 3 つ$/);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip.closest('.count-chip')).toHaveAttribute('data-tone', 'warn');
    expect(container.querySelector('.band-prog > span')).toHaveStyle({ width: '50%' });
    expect(container.querySelector('.band-text')).toHaveTextContent('もう始められます。設定の残りは 3 件です');
  });

  it('直すものだけを 1 行ずつ出す。任意の行には「任意」の札があり、右端のボタンは 1 つ', () => {
    open();
    const rows = drawer().getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('プロジェクトの親フォルダ')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('任意')).toBeNull();
    expect(within(rows[1]!).getByText('MCP サーバー')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('任意')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('任意')).toBeInTheDocument();
    for (const r of rows) expect(within(r).getAllByRole('button')).toHaveLength(1);
    expect(within(rows[1]!).getByText('hangar mcp install')).toBeInTheDocument();
  });

  it('印は色だけでなく読み上げの名前でも状態を言う', () => {
    open();
    const rows = drawer().getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('img', { name: '準備できていません' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('img', { name: '未設定' })).toBeInTheDocument();
  });

  it('「設定を開く」は設定へ、「コマンドをコピー」は命令を写す', () => {
    const { onAction } = open();
    fireEvent.click(screen.getByRole('button', { name: '設定を開く、プロジェクトの親フォルダ' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
    fireEvent.click(screen.getByRole('button', { name: 'コマンドをコピー、MCP サーバー' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'hangar mcp install' });
  });

  it('済んだものは 1 行に畳む。押すと見つかった場所の行が開き、もう一度押すと閉じる', () => {
    open();
    const fold = screen.getByRole('button', { name: 'tmux、claude、Claude Code との互換性は準備完了' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('/opt/homebrew/bin/tmux（3.4）')).toBeNull();
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('/opt/homebrew/bin/tmux（3.4）')).toBeInTheDocument();
    expect(within(drawer().getByText('/opt/homebrew/bin/tmux（3.4）').closest('li')!).getByRole('img', { name: '準備できています' })).toBeInTheDocument();
    fireEvent.click(fold);
    expect(screen.queryByText('/opt/homebrew/bin/tmux（3.4）')).toBeNull();
  });

  it('検索の最中は、引き出しを閉じて錠剤を件数だけの札にする', () => {
    mount(none, { extra: [band.group], note: band.note, searching: true });
    expect(screen.queryByRole('region', { name: 'セットアップの確認' })).toBeNull();
    expect(screen.getByText('セットアップの確認').closest('.count-chip')).toHaveTextContent('6 つ中 3 つ');
  });

  it('English では語が替わる', () => {
    const en = translator('en');
    const b = presentReadiness(READY, en)!;
    render(<LanguageRoot language="en"><ActionRoot onAction={() => {}}><HomeBand {...presentHomeBand(none, en, [b.group])} note={b.note} /></ActionRoot></LanguageRoot>);
    expect(screen.getByRole('button', { name: /^Setup check 3 of 6$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tmux, claude, Claude Code compatibility: ready' })).toBeInTheDocument();
  });
});

describe('HomeBand の場所の不明なプロジェクト（2.11.5）', () => {
  const store = (list: ProjectDto[], sessions: SessionDto[] = []) => ({ ...initialStore(), projects: Object.fromEntries(list.map((p) => [p.id, p])), sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) });
  const lost = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: false, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: { kind: 'missing', previousPath: `/w/${id}`, deviceName: null } });
  const group = (list: ProjectDto[]) => presentUnresolved(store(list, [{ id: 's1', projectId: 'alpha' } as SessionDto]), ja)!;

  it('4 つ目の錠剤として並ぶ。群を足すだけで、View は変えない', () => {
    mount(busy, { extra: [group([lost('alpha'), lost('beta')])] });
    expect(pill('場所の不明なプロジェクト 2')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { name: /^(要対応|実行中|確認待ち|場所の不明なプロジェクト) \d+$/ })).toHaveLength(4);
  });

  it('押すと引き出しが開き、1 件 1 行で、名前、セッションの数、前のパス、3 つのボタンを出す', () => {
    mount(busy, { extra: [group([lost('alpha')])] });
    fireEvent.click(pill('場所の不明なプロジェクト 1'));
    const drawer = screen.getByRole('region', { name: '場所の不明なプロジェクト' });
    expect(within(drawer).getByText('この PC にパスがありません')).toBeInTheDocument();
    const row = within(drawer).getByText('alpha').closest('li')!;
    expect(row).toHaveAttribute('data-k', 'place');
    expect(within(row).getByText('セッション 1 件')).toBeInTheDocument();
    expect(within(row).getByText('/w/alpha')).toBeInTheDocument();
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['alpha', '場所を再指定', 'Archived にする', '一覧から削除']);
  });

  it('「場所を再指定」は project.resolve.open を発行する。ダイアログを開くのは、この UiAction だけである', () => {
    const { onAction } = mount(busy, { extra: [group([lost('alpha')])] });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(pill('場所の不明なプロジェクト 1'));
    fireEvent.click(screen.getByRole('button', { name: '場所を再指定、alpha' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
  });

  it('「Archived にする」と「一覧から削除」は、それぞれの解決の UiAction を発行する', () => {
    const { onAction } = mount(busy, { extra: [group([lost('alpha')])] });
    fireEvent.click(pill('場所の不明なプロジェクト 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Archived にする、alpha' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve', id: 'alpha', action: { kind: 'archive' } });
    fireEvent.click(screen.getByRole('button', { name: '一覧から削除、alpha' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve', id: 'alpha', action: { kind: 'unlink' } });
  });

  it('朝には開かない（要対応が開いている）', () => {
    mount(busy, { extra: [group([lost('alpha')])] });
    expect(screen.queryByRole('region', { name: '場所の不明なプロジェクト' })).toBeNull();
    expect(screen.getByRole('region', { name: '要対応' })).toBeInTheDocument();
  });
});
