import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type UiAction, type ProjectDto, type ReadinessDto, type SessionDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentHomeBand, type AttentionCard, type BandGroup, type ConfirmCard, type ReturnCard, type RunningCard } from '../presenters/home.ts';
import { presentReadiness } from '../presenters/readiness.ts';
import { presentUnresolved } from '../presenters/unresolved.ts';
import { initialStore } from '../store/store.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { HomeBand } from './HomeBand.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { CopiedContext } from './primitives/CommandLine.tsx';

const ja = translator('ja');
const waiting = (id: string): AttentionCard => ({ id, name: `待ち ${id}`, projectName: 'alpha', waited: '12分', question: `問い ${id}`, answer: 'terminal' });
const reminder = (id: string): ReturnCard => ({ id, name: `戻る ${id}`, projectName: 'alpha', reason: '結果を確かめる', returnOn: '2026-10-02', returnTime: null, overdueDays: 0, due: true, pastMin: null });
const running = (id: string): RunningCard => ({ id, name: `動く ${id}`, live: 'busy', aside: false, elapsed: '5分', meta: 'alpha', intent: '上限を足す', activity: { tool: 'Edit', summary: 'a.ts' }, note: null, idleFor: null, contextPercent: 40, contextLabel: '40%' });
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

  it('「折りたたむ」で閉じ、焦点は押した錠剤へ戻る。ボタンは記号だけで、名前は読み上げに残す', () => {
    mount(busy);
    const close = within(screen.getByRole('region', { name: '要対応' })).getByRole('button', { name: '折りたたむ' });
    expect(close).toHaveTextContent(/^$/);
    fireEvent.click(close);
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
    // 検索中であることは、件数だけになった錠剤が言う。帯の右端に注記は添えない。
    expect(m.container.querySelector('.band-text')).toBeNull();
    act(() => m.rerender(busy, false));
    expect(screen.getByRole('region', { name: '要対応' })).toBeInTheDocument();
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
    expect(drawer).toHaveTextContent('5分');
    expect(drawer).not.toHaveTextContent('作業中 5分');
    expect(drawer).toHaveTextContent('40%');
  });
});

// 確認待ちの出どころの小札と、見出しのまとめて片付けるボタン（2026-10-13 の決定、知らせの 9d）。
describe('HomeBand の確認待ち（9d）', () => {
  const proposal = (id: string): ConfirmCard => ({ kind: 'session', id, name: `提案 ${id}`, projectName: 'alpha', status: 'done', label: 'Done にする？', note: '直した', ago: '2 時間前', source: 'post_hoc', daysLeft: 3 });
  it('名前を押せる行でも、名前の後ろに出どころの小札を出し、右に自動で確定するまでの日数を出す', () => {
    // 確認待ちだけに件数があるので、朝に開く群として初めから開いている。
    mount({ ...none, confirm: [proposal('s1')] });
    const row = screen.getByRole('button', { name: '提案 s1' }).closest('li')!;
    expect(row.querySelector('.c-badge')).toHaveTextContent('要約から');
    expect(row.querySelector('.c-end')).toHaveTextContent('あと 3 日で確定');
  });
  it('見出しの「すべて確定」「すべて却下」は、いまある提案を全部渡す', () => {
    const { onAction } = mount({ ...none, confirm: [proposal('s1'), todo('t1')] });
    fireEvent.click(screen.getByRole('button', { name: 'すべて確定、確認待ち' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'pending.resolve', accept: true, sessionIds: ['s1'], todoIds: ['t1'] });
    fireEvent.click(screen.getByRole('button', { name: 'すべて却下、確認待ち' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'pending.resolve', accept: false, sessionIds: ['s1'], todoIds: ['t1'] });
  });
});

describe('HomeBand の始める前の確認（2.11.4）', () => {
  const READY: ReadinessDto = {
    tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, git: { path: '/usr/bin/git', ok: true, problem: null, version: '2.51.0' }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
    workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash x', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
    commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install', join: 'hangar cloud join <URL>' },
    compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
  };
  const band = presentReadiness(READY, ja)!;
  const open = () => mount(none, { extra: [band.group], note: band.note });
  const drawer = () => within(screen.getByRole('region', { name: 'セットアップの確認' }));

  it('錠剤は「準備完了 4 / 7」で、進みの棒を添える。確認の群だけのときは引き出しが開いている', () => {
    const { container } = open();
    const chip = pill(/^セットアップの確認 準備完了 4 \/ 7$/);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip.closest('.count-chip')).toHaveAttribute('data-tone', 'warn');
    expect(container.querySelector('.band-prog > span')).toHaveStyle({ width: '57%' });
    // tmux と claude が揃っているので、帯の右端の文は出さない。引き出しの見出しに残りの件数も添えない。
    expect(container.querySelector('.band-text')).toBeNull();
    expect(container.querySelector('.drawer-h')).toHaveTextContent(/^セットアップの確認$/);
  });

  it('足りない道具があれば、帯の右端にその名だけを出す', () => {
    const noClaude: ReadinessDto = { ...READY, tools: { ...READY.tools, claude: { path: null, ok: false, problem: 'unset', version: null } } };
    const b = presentReadiness(noClaude, ja)!;
    const { container } = mount(none, { extra: [b.group], note: b.note });
    expect(pill(/^セットアップの確認 準備完了 3 \/ 7$/)).toBeInTheDocument();
    expect(container.querySelector('.band-text')).toHaveTextContent(/^始めるには claude が必要です$/);
  });

  it('直すものだけを 1 行ずつ出す。任意の行には「任意」の札があり、右端のボタンは 1 つ', () => {
    open();
    const rows = drawer().getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('新しいディレクトリの作成先')).toBeInTheDocument();
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
    expect(within(rows[0]!).getByRole('img', { name: '未完了' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('img', { name: '未設定' })).toBeInTheDocument();
  });

  it('「設定を開く」は設定へ、「コマンドをコピー」は命令を写す', () => {
    const { onAction } = open();
    fireEvent.click(screen.getByRole('button', { name: '設定を開く、新しいディレクトリの作成先' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings', at: 'workspace' } });
    fireEvent.click(screen.getByRole('button', { name: 'コマンドをコピー、MCP サーバー' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'hangar mcp install' });
  });

  it('済んだものは 1 行に畳む。押すと見つかった場所の行が開き、もう一度押すと閉じる', () => {
    open();
    const fold = screen.getByRole('button', { name: 'tmux、claude、git、Claude Code との互換性 は準備完了' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('/opt/homebrew/bin/tmux（3.4）')).toBeNull();
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('/opt/homebrew/bin/tmux（3.4）')).toBeInTheDocument();
    expect(within(drawer().getByText('/opt/homebrew/bin/tmux（3.4）').closest('li')!).getByRole('img', { name: '準備完了' })).toBeInTheDocument();
    fireEvent.click(fold);
    expect(screen.queryByText('/opt/homebrew/bin/tmux（3.4）')).toBeNull();
  });

  it('すゝめの一言があれば、畳んだ行の後ろ（最後）に「仕上げ」の行を置く。押すと一言を写し、写せたら「コピーしました」にする', () => {
    const prompt = '~/.agent-hangar/setup-guide.md（v0.7.0 sha256:3f9a1c2e）を読んで';
    const g = presentReadiness(READY, ja, 'darwin', 'idle', { desktop: false, running: null, guide: prompt })!.group;
    const onAction = vi.fn<(i: UiAction) => void>();
    const ui = (copied: { text: string; n: number } | null) => (
      <LanguageRoot language="ja"><ActionRoot onAction={onAction}><CopiedContext.Provider value={copied}><HomeBand {...presentHomeBand(none, ja, [g])} /></CopiedContext.Provider></ActionRoot></LanguageRoot>
    );
    const view = render(ui(null));
    const items = drawer().getAllByRole('listitem');
    const last = items[items.length - 1]!;
    expect(last).toHaveTextContent('仕上げ：Claude Code で環境を診断');
    expect(last).toHaveTextContent('診断の結果から、会話のディレクトリの登録と連携を提案します');
    // 畳んだ「準備完了」の行より後ろにある。
    const fold = screen.getByRole('button', { name: /は準備完了$/ });
    expect(fold.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(last).getByRole('button', { name: 'プロンプトをコピー、仕上げ：Claude Code で環境を診断' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'clipboard.copy', text: prompt });
    act(() => view.rerender(ui({ text: prompt, n: 1 })));
    expect(within(last).getByRole('button')).toHaveTextContent('コピーしました');
  });

  it('検索の最中は、引き出しを閉じて錠剤を件数だけの札にする', () => {
    mount(none, { extra: [band.group], note: band.note, searching: true });
    expect(screen.queryByRole('region', { name: 'セットアップの確認' })).toBeNull();
    expect(screen.getByText('セットアップの確認').closest('.count-chip')).toHaveTextContent('準備完了 4 / 7');
  });

  it('English では語が替わる', () => {
    const en = translator('en');
    const b = presentReadiness(READY, en)!;
    render(<LanguageRoot language="en"><ActionRoot onAction={() => {}}><HomeBand {...presentHomeBand(none, en, [b.group])} note={b.note} /></ActionRoot></LanguageRoot>);
    expect(screen.getByRole('button', { name: /^Setup check Ready 4 \/ 7$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tmux, claude, git, Claude Code compatibility: ready' })).toBeInTheDocument();
  });
});

describe('HomeBand の場所の不明なプロジェクト（2.11.5）', () => {
  const store = (list: ProjectDto[], sessions: SessionDto[] = []) => ({ ...initialStore(), projects: Object.fromEntries(list.map((p) => [p.id, p])), sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) });
  const lost = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: false, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: { kind: 'missing', previousPath: `/w/${id}`, deviceName: null } });
  const group = (list: ProjectDto[]) => presentUnresolved(store(list, [{ id: 's1', projectId: 'alpha' } as SessionDto]), ja)!;

  it('4 つ目の錠剤として並ぶ。群を足すだけで、View は変えない', () => {
    mount(busy, { extra: [group([lost('alpha'), lost('beta')])] });
    expect(pill('パスが不明なプロジェクト 2')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { name: /^(要対応|実行中|確認待ち|パスが不明なプロジェクト) \d+$/ })).toHaveLength(4);
  });

  it('押すと引き出しが開き、1 件 1 行で、名前、セッションの数、前のパス、3 つのボタンを出す', () => {
    mount(busy, { extra: [group([lost('alpha')])] });
    fireEvent.click(pill('パスが不明なプロジェクト 1'));
    const drawer = screen.getByRole('region', { name: 'パスが不明なプロジェクト' });
    expect(within(drawer).queryByText('この PC でのパスがありません')).toBeNull();
    const row = within(drawer).getByText('alpha').closest('li')!;
    expect(row).toHaveAttribute('data-k', 'place');
    expect(within(row).getByText('セッション 1 件')).toBeInTheDocument();
    expect(within(row).getByText('/w/alpha')).toBeInTheDocument();
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['alpha', 'パスを再指定', 'Archived にする', '一覧から削除']);
  });

  it('「場所を再指定」は project.resolve.open を発行する。ダイアログを開くのは、この UiAction だけである', () => {
    const { onAction } = mount(busy, { extra: [group([lost('alpha')])] });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(pill('パスが不明なプロジェクト 1'));
    fireEvent.click(screen.getByRole('button', { name: 'パスを再指定、alpha' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
  });

  it('「Archived にする」と「一覧から削除」は、それぞれの解決の UiAction を発行する', () => {
    const { onAction } = mount(busy, { extra: [group([lost('alpha')])] });
    fireEvent.click(pill('パスが不明なプロジェクト 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Archived にする、alpha' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve', id: 'alpha', action: { kind: 'archive' } });
    fireEvent.click(screen.getByRole('button', { name: '一覧から削除、alpha' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.resolve', id: 'alpha', action: { kind: 'unlink' } });
  });

  it('朝には開かない（要対応が開いている）', () => {
    mount(busy, { extra: [group([lost('alpha')])] });
    expect(screen.queryByRole('region', { name: 'パスが不明なプロジェクト' })).toBeNull();
    expect(screen.getByRole('region', { name: '要対応' })).toBeInTheDocument();
  });
});

describe('HomeBand の動き', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions }[] = [];
  let finish: (() => void)[] = [];
  const realHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
  const motion = (dur = '420ms') => {
    restore = fakeMotionTokens({ '--dur-fast': dur === '0ms' ? '0ms' : '200ms', '--dur': dur, '--dur-exit': dur === '0ms' ? '0ms' : '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' }, { everywhere: true });
  };
  beforeEach(() => {
    motion();
    animations = []; finish = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      animations.push({ el: this, frames, opts });
      return { finished: new Promise<void>((r) => finish.push(r)), cancel: vi.fn() };
    };
    // jsdom は高さを持たないので、引き出しの高さは行の数で決める。
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('drawer') ? 30 + this.querySelectorAll('li').length * 40 : 0; } });
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realHeight);
  });
  const drawerEl = (c: HTMLElement) => c.querySelector<HTMLElement>('.drawer');
  const on = (el: Element | null) => animations.filter((a) => a.el === el);
  const done = async () => { await act(async () => { finish.forEach((f) => f()); await Promise.resolve(); }); };

  it('はじめの描画では動かさない', () => {
    mount(busy);
    expect(animations).toHaveLength(0);
  });

  it('閉じると、引き出しは畳み終わるまで前の中身のまま残り、終わったら外れる', async () => {
    const { container } = mount(busy);
    const d = drawerEl(container);
    fireEvent.click(pill('要対応 3'));
    expect(drawerEl(container)).toBe(d);
    expect(d).toHaveTextContent('待ち a');
    // 出ている間は役も焦点も持たない。
    expect(d).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('region', { name: '要対応' })).toBeNull();
    expect(on(d).at(-1)!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
    await done();
    expect(drawerEl(container)).toBeNull();
  });

  it('開くと、引き出しは高さを 0 から伸ばして入る', async () => {
    const { container } = mount(busy);
    fireEvent.click(pill('要対応 3'));
    await done();
    animations = [];
    fireEvent.click(pill('実行中 1'));
    const d = drawerEl(container)!;
    expect(on(d)).toHaveLength(1);
    expect(on(d)[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    // 行は引き出しと一緒に入るので、行ごとには動かさない。
    expect(animations.filter((a) => a.el.tagName === 'LI')).toHaveLength(0);
  });

  it('群を替えると、引き出しの高さを補間し、中身を --dur-fast で薄く入れ替える。伸びも畳みもしない', () => {
    const { container } = mount(busy);
    const d = drawerEl(container)!;
    fireEvent.click(pill('実行中 1'));
    expect(drawerEl(container)).toBe(d);
    expect(on(d).map((a) => a.frames)).toEqual([[{ height: '150px' }, { height: '70px' }]]);
    const body = d.querySelector('.drawer-body');
    expect(on(body).map((a) => [a.frames, a.opts.duration])).toEqual([[[{ opacity: 0 }, { opacity: 1 }], 200]]);
    expect(animations.filter((a) => a.el.tagName === 'LI')).toHaveLength(0);
  });

  it('引き出しの行は、来たら伸びて入り、解けたら畳んで出る', async () => {
    const m = mount(busy);
    act(() => m.rerender({ ...busy, attention: [waiting('c'), waiting('a'), waiting('b')] }));
    const c = screen.getByText('待ち c').closest('li')!;
    expect(on(c)).toHaveLength(1);
    expect(on(c)[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    animations = [];
    act(() => m.rerender({ ...busy, attention: [waiting('c'), waiting('b')] }));
    const a = screen.getByText('待ち a').closest('li')!;
    expect(on(a).at(-1)!.frames.at(-1)).toMatchObject({ height: '0px' });
    await done();
    expect(screen.queryByText('待ち a')).toBeNull();
  });

  it('引き出しの行の並びが替わっても滑らせず、上がった行だけに淡い黄の印を付ける', () => {
    const m = mount({ ...none, running: [running('x'), running('y'), running('z')] });
    act(() => m.rerender({ ...none, running: [running('z'), running('x'), running('y')] }));
    const li = (n: string) => screen.getByText(`動く ${n}`).closest('li')!;
    expect(animations.filter((a) => a.el.tagName === 'LI')).toHaveLength(0);
    expect(li('z')).toHaveAttribute('data-hit');
    expect(li('x')).not.toHaveAttribute('data-hit');
    expect(li('y')).not.toHaveAttribute('data-hit');
  });

  it('件数は回して替える（RollingText）', () => {
    const m = mount(busy);
    const count = pill('要対応 3').querySelector('[data-count]')!;
    expect(count.querySelector('.roll')).not.toBeNull();
    act(() => m.rerender({ ...busy, attention: [waiting('a')] }));
    expect(pill('要対応 2').querySelector('.roll')).toHaveAttribute('data-rolling', 'true');
  });

  it('開いている群が 0 件になったら、引き出しは畳んで出る', async () => {
    const m = mount(busy);
    const d = drawerEl(m.container)!;
    act(() => m.rerender({ ...busy, attention: [], returning: [] }));
    expect(drawerEl(m.container)).toBe(d);
    expect(on(d).at(-1)!.frames.at(-1)).toMatchObject({ height: '0px' });
    await done();
    expect(drawerEl(m.container)).toBeNull();
  });

  it('検索に入ると引き出しは畳んで出て、注記は出さない。抜けると引き出しは伸びて戻る', async () => {
    const m = mount(busy);
    const d = drawerEl(m.container)!;
    act(() => m.rerender(busy, true));
    expect(m.container.querySelector('.band-text')).toBeNull();
    expect(on(d).at(-1)!.frames.at(-1)).toMatchObject({ height: '0px' });
    await done();
    animations = [];
    act(() => m.rerender(busy, false));
    expect(on(drawerEl(m.container)).at(-1)!.frames[0]).toMatchObject({ height: '0px' });
    await done();
    expect(m.container.querySelector('.band-text')).toBeNull();
  });

  it('動きが無いとき（reduced motion）は、閉じた描画で引き出しも注記も外し、何も動かさない', () => {
    restore?.();
    motion('0ms');
    const m = mount(busy);
    fireEvent.click(pill('要対応 3'));
    expect(drawerEl(m.container)).toBeNull();
    fireEvent.click(pill('実行中 1'));
    act(() => m.rerender(busy, true));
    act(() => m.rerender(busy, false));
    expect(m.container.querySelector('.band-text')).toBeNull();
    expect(animations).toHaveLength(0);
  });
});
