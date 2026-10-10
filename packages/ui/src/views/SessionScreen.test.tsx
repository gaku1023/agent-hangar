import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator, type SessionDto } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentNowStrip } from '../presenters/live.ts';
import { presentTool } from '../presenters/tools.ts';
import { presentDetails, presentLeadCard, presentSessionBadges, sessionActions, type SessionProps } from '../presenters/session.ts';
import type { TerminalHost } from '../runtime/terminals.ts';
import { toolItem } from '../test/items.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { pick } from '../test/pick.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { SessionScreen } from './SessionScreen.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalHostContext } from './TerminalPane.tsx';

const ja = translator('ja');
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const dto = (over: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u', projectId: 'p1', name: 'name', cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null,
  hasTranscript: true, live: null, stats: { turns: 2, model: 'claude-sonnet-4-5', effort: 'high', filesChanged: 3, prUrl: 'https://github.com/o/r/pull/88', inputTokens: 1_000_000, outputTokens: 200_000, contextPercent: null, costUsd: null },
  summary: { title: 'T', oneLiner: 'ONE', body: 'BODY', state: 'in_progress', nextSteps: ['next1'], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: 1 },
  fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over,
});
const leadOf = (over: Partial<SessionDto> = {}, extra: { summaryPending?: boolean; summaryError?: string | null; gone?: boolean } = {}) =>
  presentLeadCard({ session: dto(over), now: NOW, gone: extra.gone ?? false, summaryPending: extra.summaryPending ?? false, summaryError: extra.summaryError ?? null, artifacts: [], files: null, windowFiles: [] }, ja);
const stripOf = (over: Partial<Parameters<typeof presentNowStrip>[0]> = {}) => presentNowStrip({
  digest: null, events: [], turnFrom: 0, turnNo: 2, live: 'busy', activity: null, now: NOW, viewingAgent: false, clock: () => '10:00', idleFor: '1 分', waited: '1 分',
  contextPercent: 62, cost: '$1.20', turns: 2, tokens: '1.2M', artifacts: [], note: null, ...over,
}, ja);

const base: SessionProps = { id: 's1', name: 'name', parent: { label: 'alpha', route: { name: 'project', id: 'p1' } }, live: null, aside: false, oneLiner: 'ONE', hasTranscript: true,
  items: [
    { kind: 'user', seq: 0, text: 'hi', when: '10:00' },
    toolItem(1, 'Agent', { description: 'x' }, { text: 'done', isError: false }, { when: '10:01', subagent: { agentId: 'abc', label: 'Agent x' } }),
    toolItem(2, 'Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }, { text: 'File not found', isError: true }, { when: '10:02' }),
    { kind: 'assistant', seq: 3, text: 'bye', when: '10:03' },
  ], total: 10, loaded: 4, loading: false, hasMore: true, showThinking: false, showRaw: false, follow: true, agentId: null, subagents: ['abc'], notFound: false, loadingSession: false, run: null, tabs: [], selectedTab: null, transcriptOpen: true, trustHint: false, canResume: true, canFork: true,
  summaryPending: false, summaryError: null, fromScratch: false, canPromote: false, split: null, canSplit: false, lock: null, remoteOnly: false, canResumeHere: false, outsideOpen: null,
  turnRows: [{ seq: 0, when: '10:00', text: 'hi', head: 'hi', tools: 2, open: false, band: [] }], turnsComplete: false, turnsPending: false, openTurnItems: [], turnJump: null, strip: null, lead: leadOf(), badges: [], details: [], gone: null, jump: null, hasNewer: false,
  actions: { primary: { id: 'resume', label: '再開', disabled: null, note: null }, menu: [] }, transcriptBand: null, account: null };

/**
 * 見出しの操作は presenter が事実から決める。
 * 画面の試験でも同じ関数で作り、事実と操作が食い違わないようにする。
 */
const SS = (props: SessionProps) => <SessionScreen {...props} actions={sessionActions(props, ja)} />;
/** 「…」のメニューを開いて、その中の項目を返す。 */
const menu = () => { fireEvent.click(screen.getByRole('button', { name: 'ほかの操作' })); return within(screen.getByRole('menu', { name: 'ほかの操作' })); };
const menuOf = (name: string) => { fireEvent.click(screen.getByRole('button', { name })); return within(screen.getByRole('menu', { name })); };
const tocCols = (c: HTMLElement) => (c.querySelector('.c-body') as HTMLElement).style.gridTemplateColumns;

describe('SessionScreen（終わった画面）', () => {
  it('見出し、切替、続きの読み込み', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} /></ActionRoot>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('name');
    expect(screen.getByText('ONE')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('思考を表示'));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.showThinking', sessionId: 's1', show: true });
    fireEvent.click(screen.getByText('古い行を読み込む（残り 6 件）'));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.loadMore', sessionId: 's1' });
    fireEvent.click(screen.getByRole('radio', { name: 'abc' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('思考と詳細表示は、押した状態を aria-pressed で見せる', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} showThinking showRaw={false} /></ActionRoot>);
    expect(screen.getByRole('button', { name: '思考を表示' })).toHaveAttribute('aria-pressed', 'true');
    // 「生の記録」は用語集で使わない語になった。切り替えの語は「詳細表示」（利用者の決定）。
    const raw = screen.getByRole('button', { name: '詳細を表示' });
    expect(raw).toHaveAttribute('aria-pressed', 'false');
    expect(raw).toHaveTextContent('詳細表示');
    expect(screen.queryByText('生の記録')).toBeNull();
  });
  it('詳細表示を押すと、本文の記録の表示を切り替える', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: '詳細を表示' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.showRaw', sessionId: 's1', show: true });
  });
  it('英語では、切り替えの語は Raw になる', () => {
    render(<ActionRoot onAction={() => {}}><LanguageRoot language="en"><SS {...base} /></LanguageRoot></ActionRoot>);
    const raw = screen.getByRole('button', { name: 'Show raw entries' });
    expect(raw).toHaveTextContent('Raw');
  });
  it('サブエージェントが 4 つ以上なら一覧にする', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} subagents={['a1', 'a2', 'a3', 'a4']} /></ActionRoot>);
    expect(screen.queryByRole('radiogroup', { name: 'サブエージェント' })).toBeNull();
    pick('サブエージェント', 'サブエージェント a3');
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'a3' });
  });
  it('サブエージェントの切り替えの先頭は「メイン会話」で、「主線」の語は出さない', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    expect(screen.getByRole('radio', { name: 'メイン会話' })).toBeInTheDocument();
    expect(screen.queryByText('主線')).toBeNull();
  });
  it('ツール呼び出しは畳まれ、エラーは印が付き、サブエージェントへ飛べる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} /></ActionRoot>);
    const edit = screen.getByTitle('/a').closest('.tool')!;
    expect(edit).toHaveAttribute('data-failed', 'true');
    expect(edit.querySelector('.badge')).toHaveAttribute('data-k', 'fail');
    fireEvent.click(screen.getByText('サブエージェント abc を見る'));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('見つからないとき', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} notFound /></ActionRoot>);
    expect(screen.getByText('セッションが見つかりません')).toBeInTheDocument();
  });
  it('セッションの情報がまだ届いていないときは読み込み中', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} loadingSession /></ActionRoot>);
    expect(screen.getByText('セッションを読み込んでいます')).toBeInTheDocument();
    expect(screen.queryByText('セッションが見つかりません')).toBeNull();
  });
});

describe('見出しの段（A1、C1）', () => {
  it('見出しの行に状態の点、名前、要約の 1 文、主の操作、「…」、(i) を置く', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    const hero = container.querySelector('.session-hero')!;
    expect(hero.getAttribute('data-morph-hero')).toBe('s1');
    expect(hero.querySelector('.dot')).not.toBeNull();
    expect(hero.querySelector('h1.session-name')).toHaveTextContent('name');
    expect(hero.querySelector('.session-oneliner')).toHaveTextContent('ONE');
    // 1 文は省略記号で切れることがあるので、全文を title に持たせる。
    expect(hero.querySelector('.session-oneliner')).toHaveAttribute('title', 'ONE');
    const buttons = within(hero as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['再開', 'ほかの操作', '詳細']);
    expect(buttons[0]).toHaveClass('btn-primary');
    expect(screen.getAllByText('ONE')).toHaveLength(1);
  });
  it('見出しの下に、情報の行を置かない（属性は (i)、いまの値は帯、終わった後は冒頭の 1 枚へ移った）', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    expect(container.querySelector('.session-info')).toBeNull();
  });
  it('名前は見出しにだけ出し、要約の題は出さない（C1）', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    expect(screen.queryByText('T')).toBeNull();
    expect(screen.getAllByText('name')).toHaveLength(1);
  });
  it('実行中は VS Code で開くを主にし、ターミナルで開く、フォーク、要約を作り直す、停止は「…」に入れる', () => {
    const onAction = withHost(<SS {...running} />);
    fireEvent.click(screen.getByRole('button', { name: 'VS Code で開く' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.openEditor', sessionId: 's1' });
    const m = menu();
    expect(m.getAllByRole('menuitem').map((i) => i.querySelector('.menu-item-text > span')!.textContent)).toEqual(['ターミナルで開く', 'フォーク', '要約を再生成', '停止']);
    // 押せない項目は理由を 1 行添える。
    expect(m.getByRole('menuitem', { name: /フォーク/ })).toHaveAttribute('aria-disabled', 'true');
    expect(m.getByRole('menuitem', { name: /フォーク/ })).toHaveTextContent('実行中は押せません。停止すると押せます');
    fireEvent.click(m.getByRole('menuitem', { name: /ターミナルで開く/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.openTerminalApp', runId: 'r1', tabId: 'r1' });
    fireEvent.click(menu().getByRole('menuitem', { name: /要約を再生成/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'summary.regenerate', sessionId: 's1' });
  });
  it('停止は危険色でメニューの最後。作業中か、シェルタブの数を添えて送り、確認は Mediator が出す', () => {
    const onAction = withHost(<SS {...running} live="waiting" />);
    const stop = menu().getByRole('menuitem', { name: /^停止/ });
    expect(stop).toHaveAttribute('data-danger', 'true');
    fireEvent.click(stop);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1', working: true, aside: false, shellTabs: 1 });
    cleanup();
    const idle = withHost(<SS {...running} live="idle" tabs={[running.tabs[0]!]} />);
    fireEvent.click(menu().getByRole('menuitem', { name: /^停止/ }));
    expect(idle).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1', working: false, aside: false, shellTabs: 0 });
  });
  it('終わったセッションは再開を主にし、フォークと VS Code で開くは「…」から', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: '再開' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.resume', id: 's1' });
    fireEvent.click(menu().getByRole('menuitem', { name: /フォーク/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.fork', id: 's1' });
    fireEvent.click(menu().getByRole('menuitem', { name: /VS Code で開く/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.openEditor', sessionId: 's1' });
  });
  // disabled にすると乗せても吹き出しが出ず、キーボードでも届かない。
  // aria-disabled にして、押しても何もしないようにする。
  it('主の操作が押せないときは、理由を title と読み上げに持たせ、押しても何もしない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} hasTranscript={false} canResume={false} canFork={false} items={[]} total={0} loaded={0} hasMore={false} /></ActionRoot>);
    const resume = screen.getByRole('button', { name: '再開' });
    expect(resume).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(resume);
    expect(onAction).not.toHaveBeenCalled();
    expect(resume).toHaveAttribute('title', 'トランスクリプトがありません');
    expect(resume).toHaveAccessibleDescription('トランスクリプトがありません');
  });
  it('主の操作の名前は .btn-label に入れ、狭い窓では見出しの行（PageHeading の fitRow）が印だけに縮められる', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    expect(screen.getByRole('button', { name: '再開' }).querySelector(':scope > .btn-label')).toHaveTextContent('再開');
  });
  it('クイックセッションの昇格はメニューに置く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} fromScratch canPromote /></ActionRoot>);
    fireEvent.click(menu().getByRole('menuitem', { name: /プロジェクトに昇格/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.promote.open', id: 's1' });
  });
});

describe('見出しの名前の横の札と (i)（設計書 2.3）', () => {
  const lock = { kind: 'lock' as const, label: 'mini で実行中', title: '最終確認 1 分前' };
  it('他の PC で実行中の札を、名前の横（要約の 1 文の前）に出す。最終確認は読み上げにも入る', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} badges={[lock]} /></ActionRoot>);
    const badge = screen.getByText('mini で実行中');
    expect(badge.closest('.session-badge')).toHaveAttribute('data-kind', 'lock');
    expect(badge.closest('.session-badge')).toHaveAttribute('title', '最終確認 1 分前');
    const row = container.querySelector('.session-hero')!;
    const order = [...row.children].map((c) => c.className.split(' ')[0]);
    expect(order.indexOf('session-badges')).toBe(order.indexOf('page-title') + 1);
    expect(order.indexOf('session-badges')).toBeLessThan(order.indexOf('session-oneliner'));
    expect(screen.getByRole('button', { name: '詳細' })).toBeInTheDocument();
  });
  it('札が無ければ何も出さない', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    expect(container.querySelector('.session-badges')).toBeNull();
  });
  it('トランスクリプトが他の PC にあることも、ロックと同じく見出しに出す', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} badges={[{ kind: 'remote', label: 'トランスクリプトは他の PC にあります', title: null }]} /></ActionRoot>);
    expect(screen.getByText('トランスクリプトは他の PC にあります').closest('.session-hero')).not.toBeNull();
  });
  it('(i) を押すと詳細のポップオーバーが開き、行を名前と値で読ませる。Esc で閉じて焦点が戻る', () => {
    const rows = presentDetails(dto(), null, { name: '大学', color: '#7a4a9e' }, ja);
    render(<ActionRoot onAction={() => {}}><SS {...base} details={rows} /></ActionRoot>);
    const i = screen.getByRole('button', { name: '詳細' });
    expect(i).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(i);
    const dialog = screen.getByRole('dialog', { name: '詳細' });
    expect(i).toHaveAttribute('aria-expanded', 'true');
    for (const name of ['モデル', 'effort レベル', '開始', '作業ディレクトリ', 'アカウント', 'ターンとトークン', '変更したファイル', 'PR']) expect(within(dialog).getByText(name)).toBeInTheDocument();
    expect(within(dialog).getByText('/w/alpha')).toBeInTheDocument();
    // アカウントは色の点を添える。
    const dot = within(dialog).getByText('大学').parentElement!.querySelector('.st-dot') as HTMLElement;
    expect(dot).toHaveStyle({ color: '#7a4a9e' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '詳細' })).toBeNull();
    expect(document.activeElement).toBe(i);
  });
  it('バッジの文は presenter が組む（ロックの札と見出しの札の種類）', () => {
    const badges = presentSessionBadges(dto({ lock: { deviceId: 'd', deviceName: 'mini', runId: 'r', heartbeatAt: NOW - 60_000, stale: false } }), NOW, ja);
    render(<ActionRoot onAction={() => {}}><SS {...base} badges={badges} /></ActionRoot>);
    expect(screen.getByText('mini で実行中')).toBeInTheDocument();
  });
});

describe('冒頭の 1 枚と目次（終わった画面）', () => {
  it('冒頭の 1 枚は、トランスクリプトのスクロールの先頭（古い行を読み込むボタンの上）に置く', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    const tr = container.querySelector('.tr-sheet .tr')!;
    expect(tr.firstElementChild).toHaveClass('lead-card');
    expect(within(tr as HTMLElement).getByText('BODY')).toBeInTheDocument();
    expect(within(tr as HTMLElement).getByText('next1')).toBeInTheDocument();
  });
  it('右には、実行中と同じ目次だけを置く（要約、TODO、変更したファイルの箱は無い）', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    const pane = container.querySelector('.toc-pane')!;
    expect(pane).toHaveAccessibleName('目次');
    expect(pane.querySelector('.turn-row')?.textContent).toContain('hi');
    expect(container.querySelector('.session-rail')).toBeNull();
    expect(container.querySelector('.rail-panel')).toBeNull();
    expect(screen.queryByText('TODO')).toBeNull();
  });
  it('ノートは冒頭の 1 枚の中で書く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'ノートを書く' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'ノート' }), { target: { value: '明日 PR を出す' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '明日 PR を出す' });
  });
  it('要約の再生成は冒頭の 1 枚にあり、作成中と失敗を言う', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><SS {...base} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: '要約を再生成' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'summary.regenerate', sessionId: 's1' });
    rerender(<ActionRoot onAction={onAction}><SS {...base} lead={leadOf({}, { summaryPending: true })} /></ActionRoot>);
    expect(screen.getByText('要約を作成しています')).toBeInTheDocument();
    rerender(<ActionRoot onAction={onAction}><SS {...base} lead={leadOf({}, { summaryError: 'LM Studio に繋がりません' })} /></ActionRoot>);
    expect(screen.getByText('要約を作成できませんでした')).toBeInTheDocument();
  });
  it('目次の見出しは「目次」と、ターンの数', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    expect(container.querySelector('.turns-head')).toHaveTextContent('目次');
    expect(container.querySelector('.turns-head')).toHaveTextContent('1+ ターン');
  });
  it('目次は ⌘J と同じ開閉のボタンを持ち、閉じると列が 0px になって、切り替えの行に「目次 N」の札が出る', () => {
    const onAction = vi.fn();
    const { container, rerender } = render(<ActionRoot onAction={onAction}><SS {...base} /></ActionRoot>);
    expect(tocCols(container)).toBe('minmax(0, 1fr) 240px');
    fireEvent.click(screen.getByRole('button', { name: '右パネルを閉じる' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    rerender(<ActionRoot onAction={onAction}><SS {...base} transcriptOpen={false} /></ActionRoot>);
    expect(tocCols(container)).toBe('minmax(0, 1fr) 0px');
    expect(container.querySelector('.toc-pane')).toBeNull();
    const opener = screen.getByRole('button', { name: /目次 1\+/ });
    expect(opener.closest('.transcript-toggles')).not.toBeNull();
    fireEvent.click(opener);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'transcript.toggle' });
  });
  it('トランスクリプトの無いセッションは、目次を持たず、冒頭の 1 枚だけを出す', () => {
    const lead = leadOf({ hasTranscript: false });
    const { container } = render(<ActionRoot onAction={() => {}}><SS {...base} hasTranscript={false} canResume={false} canFork={false} items={[]} total={0} loaded={0} hasMore={false} turnRows={[]} lead={lead} /></ActionRoot>);
    expect(container.querySelector('.toc-pane')).toBeNull();
    expect(screen.getByText('トランスクリプトがありません', { selector: '.lead-facts span' })).toBeInTheDocument();
    expect(container.querySelector('.c-body')).toHaveAttribute('data-toc', 'none');
  });
});

const host: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => 'connected', fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() };
const running: SessionProps = { ...base, live: 'busy', run: { id: 'r1', kind: 'start', alive: true, started: '1 分前' }, selectedTab: 'r1', canResume: false, canFork: false, lead: null, strip: stripOf(),
  tabs: [{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't1', title: 'シェル 1', kind: 'shell', selected: false, closable: true }] };
const withHost = (ui: ReactElement, onAction = vi.fn(), h: TerminalHost = host) => { render(<ActionRoot onAction={onAction}><TerminalHostContext.Provider value={h}>{ui}</TerminalHostContext.Provider></ActionRoot>); return onAction; };

describe('SessionScreen（実行中）', () => {
  it('タブ列、ターミナル、目次の開閉', () => {
    const onAction = withHost(<SS {...running} />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(host.mount).toHaveBeenCalledWith('r1', expect.anything());
    fireEvent.click(screen.getByRole('tab', { name: /シェル 1/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェル 1 を閉じる'));
    expect(onAction).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェルタブを追加'));
    expect(onAction).toHaveBeenCalledWith({ type: 'tab.open', sessionId: 's1', kind: 'shell' });
    fireEvent.click(screen.getByLabelText('右パネルを閉じる'));
    expect(onAction).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    expect(screen.getByText('hi')).toBeInTheDocument();
  });
  it('ターミナルの真上に現在の帯を置き、見出しの下には何も挟まない', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} /></TerminalHostContext.Provider></ActionRoot>);
    const main = container.querySelector('.c-main')!;
    expect([...main.children].map((c) => c.className.split(' ')[0])).toEqual(['now-strip', 'term-pane']);
    expect(container.querySelector('.session-info')).toBeNull();
    expect(within(main as HTMLElement).getByRole('region', { name: 'セッションの現在の状態' })).toBeInTheDocument();
  });
  it('帯は生きた run があるときだけで、終わった run のターミナルには出さない', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} strip={null} run={{ ...running.run!, alive: false }} /></TerminalHostContext.Provider></ActionRoot>);
    expect(container.querySelector('.now-strip')).toBeNull();
  });
  it('帯のノートの札から、ポップオーバーでノートを書ける', () => {
    const onAction = withHost(<SS {...running} />);
    fireEvent.click(screen.getByRole('button', { name: 'ノート' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'ノート' }), { target: { value: 'メモ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: 'メモ' });
  });
  it('右は会話の全文ではなくターンの目次にする', () => {
    withHost(<SS {...running} />);
    expect(document.querySelector('.toc-pane .turn-row')?.textContent).toContain('hi');
    expect(document.querySelector('.toc-pane .tr')).toBeNull();
  });
  it('「いま」の段と境目は無い（右パネルは目次だけ）', () => {
    withHost(<SS {...running} />);
    expect(document.querySelector('.live')).toBeNull();
    expect(document.querySelector('.live-divider')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });
  it('実行中も終わった後も、画面は窓の残りの高さを受け取る縦の器（session-screen）になる', () => {
    withHost(<SessionScreen {...running} />);
    expect(document.querySelector('.screen')).toHaveClass('session-screen');
    cleanup();
    withHost(<SessionScreen {...base} />);
    expect(document.querySelector('.screen')).toHaveClass('session-screen');
  });
  it('実行中も終わった後も、目次は同じ器（toc-slot の toc-pane）にあり、同じ幅の列になる', () => {
    const a = render(<ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} /></TerminalHostContext.Provider></ActionRoot>);
    expect(a.container.querySelector('.c-body > .toc-slot .toc-pane')).not.toBeNull();
    expect(tocCols(a.container)).toBe('minmax(0, 1fr) 240px');
    cleanup();
    const b = render(<ActionRoot onAction={vi.fn()}><SS {...base} /></ActionRoot>);
    expect(b.container.querySelector('.c-body > .toc-slot .toc-pane')).not.toBeNull();
    expect(tocCols(b.container)).toBe('minmax(0, 1fr) 240px');
  });
  it('目次を閉じたら、列ごと消し、「目次 N」の札をタブの帯の右端に出す', () => {
    withHost(<SS {...running} transcriptOpen={false} />);
    expect((document.querySelector('.c-body') as HTMLElement).style.gridTemplateColumns).toBe('minmax(0, 1fr) 0px');
    const open = screen.getByRole('button', { name: /目次 1\+/ });
    expect(open.closest('.tabs')).not.toBeNull();
    expect(open).toHaveTextContent('⌘J');
    expect(document.querySelector('.toc-pane')).toBeNull();
  });
  it('開いている間は、開閉のボタンを目次の見出しの行に置き、タブの帯には出さない', () => {
    withHost(<SS {...running} />);
    expect(screen.getByRole('button', { name: '右パネルを閉じる' }).closest('.toc-pane')).not.toBeNull();
    expect(document.querySelector('.tabs .tab-pane-open')).toBeNull();
  });
  it('折りたたむとトランスクリプトを描かない', () => {
    withHost(<SS {...running} transcriptOpen={false} />);
    expect(screen.queryByText('hi')).toBeNull();
  });
  describe('狭い窓（目次を札に畳む）', () => {
    let restore: () => void = () => {};
    beforeEach(() => {
      const original = window.matchMedia;
      window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
      restore = () => { window.matchMedia = original; };
    });
    afterEach(() => restore());
    it('はじめは列を持たず、札は「目次 N」。押すと目次が上に重なって開き、状態機械は動かさない', () => {
      const onAction = withHost(<SS {...running} />);
      const c = document.querySelector('.c-body') as HTMLElement;
      expect(c).toHaveAttribute('data-narrow', 'true');
      expect(c.style.gridTemplateColumns).toBe('');
      expect(document.querySelector('.toc-pane')).toBeNull();
      const opener = screen.getByRole('button', { name: /目次 1\+/ });
      expect(opener.closest('.tabs')).not.toBeNull();
      expect(opener).not.toHaveTextContent('⌘J');
      fireEvent.click(opener);
      expect(document.querySelector('.toc-slot')).toHaveAttribute('data-drawer', 'true');
      expect(document.querySelector('.toc-pane .turn-row')).not.toBeNull();
      expect(onAction).not.toHaveBeenCalled();
      // 見出しの行のボタンで閉じる。
      fireEvent.click(screen.getByRole('button', { name: '右パネルを閉じる' }));
      expect(document.querySelector('.toc-pane')).toBeNull();
      expect(onAction).not.toHaveBeenCalled();
    });
    it('⌘J（transcript.toggle の状態の変化）でも、上に重なる目次を開閉する', () => {
      const ui = (open: boolean) => <ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} transcriptOpen={open} /></TerminalHostContext.Provider></ActionRoot>;
      const { rerender } = render(ui(true));
      expect(document.querySelector('.toc-pane')).toBeNull();
      rerender(ui(false));
      expect(document.querySelector('.toc-pane')).not.toBeNull();
      rerender(ui(true));
      expect(document.querySelector('.toc-pane')).toBeNull();
    });
    it('別のセッションへ替えたときは、開閉の違いを開閉の操作とは見なさず、閉じる', () => {
      const ui = (id: string, open: boolean) => <ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} id={id} transcriptOpen={open} /></TerminalHostContext.Provider></ActionRoot>;
      const { rerender } = render(ui('s1', true));
      fireEvent.click(screen.getByRole('button', { name: /目次 1\+/ }));
      expect(document.querySelector('.toc-pane')).not.toBeNull();
      rerender(ui('s2', false));
      expect(document.querySelector('.toc-pane')).toBeNull();
    });
    it('終わった画面でも、札は切り替えの行にある', () => {
      render(<ActionRoot onAction={vi.fn()}><SS {...base} /></ActionRoot>);
      expect(screen.getByRole('button', { name: /目次 1\+/ }).closest('.transcript-toggles')).not.toBeNull();
      expect(document.querySelector('.toc-pane')).toBeNull();
    });
  });
  describe('動く環境', () => {
    let restore: () => void = () => {};
    afterEach(() => { restore(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });
    it('閉じる動きが終わるまで目次の中身を残し、終わったら外す（列は先に 0px になる）', async () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      let finish: () => void = () => {};
      const finished = new Promise<void>((r) => { finish = r; });
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished, cancel: vi.fn() }; };
      const ui = (open: boolean) => <ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} transcriptOpen={open} /></TerminalHostContext.Provider></ActionRoot>;
      const { rerender } = render(ui(true));
      rerender(ui(false));
      expect(document.querySelector('.toc-slot')).toHaveAttribute('data-leaving', 'true');
      expect(document.querySelector('.toc-slot-inner')).not.toBeNull();
      await act(async () => { finish(); await finished; });
      expect(document.querySelector('.toc-slot-inner')).toBeNull();
      expect(document.querySelector('.toc-slot')).not.toHaveAttribute('data-leaving');
    });
    it('別のセッションへ替えて目次の開閉が替わっても、列を滑らせずにすぐその形にする', () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      const animate = vi.fn(function () { return { finished: new Promise<void>(() => {}), cancel: vi.fn() }; });
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
      const ui = (id: string, open: boolean) => <ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} id={id} transcriptOpen={open} /></TerminalHostContext.Provider></ActionRoot>;
      const { rerender } = render(ui('s1', true));
      animate.mockClear();
      rerender(ui('s2', false));
      expect(document.querySelector('.toc-slot-inner')).toBeNull();
      expect(document.querySelector('[data-leaving]')).toBeNull();
      expect(animate.mock.calls.length).toBe(0);
      rerender(ui('s1', true));
      expect(document.querySelector('.toc-slot-inner')).not.toBeNull();
      expect(animate.mock.calls.length).toBe(0);
      // 同じセッションの中での開閉は、これまでどおり動かす。
      rerender(ui('s1', false));
      expect(document.querySelector('.toc-slot')).toHaveAttribute('data-leaving', 'true');
      expect(animate.mock.calls.length).toBeGreaterThan(0);
    });
  });
  it('要約の一行は、文が替わると作り直す（入る動きをもう一度出す）', () => {
    const { rerender } = render(<ActionRoot onAction={vi.fn()}><SS {...base} /></ActionRoot>);
    const first = document.querySelector('.session-oneliner');
    rerender(<ActionRoot onAction={vi.fn()}><SS {...base} oneLiner="TWO" /></ActionRoot>);
    expect(document.querySelector('.session-oneliner')).not.toBe(first);
  });
  it('信頼ダイアログの案内と終了の表示', () => {
    withHost(<SS {...running} live={null} trustHint />);
    expect(screen.getAllByRole('status').some((e) => e.textContent?.includes('信頼確認'))).toBe(true);
    cleanup();
    withHost(<SS {...running} live={null} strip={null} run={{ ...running.run!, alive: false }} canResume />);
    expect(screen.getByRole('status')).toHaveTextContent('Claude は終了しました');
    // 終了した run では新しいシェルを開けないので、＋ を出さない。
    expect(screen.queryByLabelText('シェルタブを追加')).toBeNull();
    expect(screen.getByRole('button', { name: '再開' })).toBeEnabled();
    expect(menu().queryByRole('menuitem', { name: /^停止/ })).toBeNull();
  });
  it('分割の指定があれば 2 つのターミナルを並べ、帯は 1 つだけ置く', () => {
    withHost(<SS {...running} canSplit split={{ left: 'r1', right: 't1' }} />);
    expect(screen.getByTestId('split')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^term-/)).toHaveLength(2);
    expect(host.mount).toHaveBeenCalledWith('t1', expect.anything());
    expect(document.querySelectorAll('.now-strip')).toHaveLength(1);
  });
  it('分割していなければターミナルは 1 つ', () => {
    withHost(<SS {...running} canSplit />);
    expect(screen.queryByTestId('split')).toBeNull();
    expect(screen.getAllByTestId(/^term-/)).toHaveLength(1);
  });
});

describe('ターミナルの知らせ（F1）', () => {
  it('分割中は枠ごとの接続の様子を出す。切れた枠だけに再接続のカードを出す', () => {
    const h: TerminalHost = { ...host, reconnect: vi.fn(), status: (id) => (id === 't1' ? 'closed' : 'connected'), link: (id) => (id === 't1' ? { retryAt: Date.now() + 5000, dropped: true, gaveUp: false, detached: false } : { retryAt: null, dropped: false, gaveUp: false, detached: false }) };
    withHost(<SS {...running} canSplit split={{ left: 'r1', right: 't1' }} />, vi.fn(), h);
    expect(within(screen.getByTestId('term-r1')).queryByText('ターミナルとの接続が切れました')).toBeNull();
    const right = within(screen.getByTestId('term-t1'));
    expect(right.getByText('ターミナルとの接続が切れました')).toBeInTheDocument();
    expect(right.getByText(/シェルは動き続けています。5 秒後に再接続します。/)).toBeInTheDocument();
    fireEvent.click(right.getByRole('button', { name: '再接続' }));
    expect(h.reconnect).toHaveBeenCalledWith('t1');
  });
  it('目次から跳ばしている間は、Claude の枠の上端に帯と「最新へ戻る」を出す', () => {
    const onAction = withHost(<SS {...running} canSplit split={{ left: 'r1', right: 't1' }} transcriptBand={{ when: '12:09' }} />);
    const left = within(screen.getByTestId('term-r1'));
    expect(left.getByText('transcript を表示中')).toBeInTheDocument();
    expect(left.getByText('12:09 のターン · Claude は裏で動き続けています')).toBeInTheDocument();
    expect(within(screen.getByTestId('term-t1')).queryByText('transcript を表示中')).toBeNull();
    fireEvent.click(left.getByRole('button', { name: /最新へ移動/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'turn.latest', sessionId: 's1', runId: 'r1' });
  });
  it('帯が出ていても、枠の中の Esc は横取りせずに Claude へ渡す', () => {
    // Esc は Claude の中断に要る。
    // 利用者が xterm で自分で transcript を抜けた後に横取りすると、中断が「最新へ」に化けて失われる。
    const onAction = withHost(<SS {...running} transcriptBand={{ when: '12:09' }} />);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      const target = screen.getByTestId('term-r1').querySelector('.term-host')!;
      for (const init of [{ key: 'Escape' }, { key: 'Escape', shiftKey: true }, { key: 'Escape', isComposing: true }]) {
        // 既定を止めず、外へも伝わる（Root の器も xterm も受け取れる）。
        expect(fireEvent.keyDown(target, init)).toBe(true);
      }
      expect(outer).toHaveBeenCalledTimes(3);
      expect(onAction).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });
});

describe('SessionScreen のアイコン', () => {
  it('操作は文字の名前を保ったままアイコンを持つ', () => {
    withHost(<SS {...running} />);
    expect(iconOf(screen.getByRole('button', { name: 'VS Code で開く' }))).toBe('openEditor');
    expect(iconOf(screen.getByRole('button', { name: 'ほかの操作' }))).toBe('more');
    expect(iconOf(screen.getByRole('button', { name: '詳細' }))).toBe('info');
    const m = menu();
    expect(iconOf(m.getByRole('menuitem', { name: /ターミナルで開く/ }))).toBe('openTerminal');
    expect(iconOf(m.getByRole('menuitem', { name: /^停止/ }))).toBe('stop');
    expect(iconOf(m.getByRole('menuitem', { name: /フォーク/ }))).toBe('fork');
  });
  it('タブは種類ごとのアイコンを持ち、閉じると追加は読み上げ名を保つ', () => {
    withHost(<SS {...running} />);
    expect(iconOf(screen.getByRole('tab', { name: /Claude/ }))).toBe('agent');
    expect(iconOf(screen.getByRole('tab', { name: /シェル 1/ }))).toBe('shell');
    expect(iconOf(screen.getByRole('button', { name: 'シェル 1 を閉じる' }))).toBe('close');
    expect(iconOf(screen.getByRole('button', { name: 'シェルタブを追加' }))).toBe('add');
  });
  it('目次の開閉は向きの違うアイコンになる', () => {
    withHost(<SS {...running} />);
    expect(iconOf(screen.getByRole('button', { name: '右パネルを閉じる' }))).toBe('paneClose');
    cleanup();
    withHost(<SS {...running} transcriptOpen={false} />);
    expect(iconOf(screen.getByRole('button', { name: /目次 1\+/ }))).toBe('paneOpen');
  });
  it('ツール呼び出しとサブエージェントと折りたたみの矢印', () => {
    render(<ActionRoot onAction={vi.fn()}><SS {...base} /></ActionRoot>);
    const tool = screen.getByTitle('/a').closest('.tool')!;
    expect(tool.querySelector('.chev svg')?.getAttribute('data-icon')).toBe('chevron');
    expect(tool.querySelector('.badge')?.textContent).toBe('Edit');
    expect(iconOf(screen.getByRole('button', { name: 'サブエージェント abc を見る' }))).toBe('subagent');
  });
});

describe('フェーズ 4 のセッション画面', () => {
  it('他の PC で実行中なら、この PC で再開を主にして理由を添えて止め、再開とフォークもメニューで止める', () => {
    const lock = { deviceName: 'mini', stale: false, heartbeat: '1 分前', label: 'mini で実行中' };
    render(<ActionRoot onAction={() => {}}><SS {...base} canResume={false} canFork={false} lock={lock} badges={[{ kind: 'lock', label: 'mini で実行中', title: '最終確認 1 分前' }]} /></ActionRoot>);
    expect(screen.getByText('mini で実行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'この PC で再開' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'この PC で再開' })).toHaveAccessibleDescription('mini で実行中です。止まるか応答が無くなると選べます');
    const m = menu();
    expect(m.getByRole('menuitem', { name: /再開/ })).toHaveAttribute('aria-disabled', 'true');
    expect(m.getByRole('menuitem', { name: /フォーク/ })).toHaveAttribute('aria-disabled', 'true');
  });
  it('応答が無いロックの札は、別の種類（色）で出る', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} badges={[{ kind: 'stale', label: 'mini から応答がありません', title: '最終確認 5 分前' }]} /></ActionRoot>);
    expect(screen.getByText('mini から応答がありません').closest('.session-badge')).toHaveAttribute('data-kind', 'stale');
  });
  it('外で動くセッションには、引き取りと attach を「…」に出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><SS {...base} live="waiting" canResume={false} canFork={false} outsideOpen="adopt" /></ActionRoot>);
    fireEvent.click(menu().getByRole('menuitem', { name: /hangar に移動/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.adopt', id: 's1' });
    rerender(<ActionRoot onAction={onAction}><SS {...base} live="waiting" canResume={false} canFork={false} outsideOpen="attach" /></ActionRoot>);
    fireEvent.click(menu().getByRole('menuitem', { name: /hangar で接続/ }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.attach', id: 's1' });
    rerender(<ActionRoot onAction={onAction}><SS {...base} live="waiting" canResume={false} canFork={false} /></ActionRoot>);
    const m = menu();
    expect(m.queryByRole('menuitem', { name: /hangar に移動/ })).toBeNull();
    expect(m.queryByRole('menuitem', { name: /hangar で接続/ })).toBeNull();
  });
  it('写しだけのセッションはこの PC で再開を主にする', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SS {...base} canResume={false} canFork={false} remoteOnly canResumeHere badges={[{ kind: 'remote', label: 'トランスクリプトは他の PC にあります', title: null }]} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'この PC で再開' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1' });
    expect(screen.getByText('トランスクリプトは他の PC にあります')).toBeInTheDocument();
  });
  // Ruling 14。相手が落ちて heartbeat だけ残った状態を行き止まりにしない。
  it('応答の無いロックからもこの PC で再開に逃げられる', () => {
    const onAction = vi.fn();
    const staleLock = { deviceName: 'mini', stale: true, heartbeat: '5 分前', label: 'mini から応答がありません' };
    render(<ActionRoot onAction={onAction}><SS {...base} canResume={false} canFork={false} lock={staleLock} canResumeHere /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'この PC で再開' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1' });
  });
  it('ロックが無ければこの PC で再開は出ない', () => {
    render(<ActionRoot onAction={() => {}}><SS {...base} /></ActionRoot>);
    expect(screen.queryByRole('button', { name: 'この PC で再開' })).toBeNull();
    expect(screen.queryByText('トランスクリプトは他の PC にあります')).toBeNull();
    expect(screen.getByRole('button', { name: '再開' })).not.toBeDisabled();
  });
  // 引き継ぎはこのフェーズでは作らない（利用者の決定 1）。
  it('引き継ぎの操作は出さない', () => {
    const lock = { deviceName: 'mini', stale: false, heartbeat: '1 分前', label: 'mini で実行中' };
    render(<ActionRoot onAction={() => {}}><SS {...base} canResume={false} canFork={false} lock={lock} /></ActionRoot>);
    expect(screen.queryByRole('button', { name: /引き継/ })).toBeNull();
    expect(menu().queryByRole('menuitem', { name: /引き継/ })).toBeNull();
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;


describe('TabStrip の横に並べるボタン', () => {
  const one = [{ id: 't1', title: 'Claude', kind: 'agent' as const, selected: true, closable: false }];
  const two = [...one, { id: 't2', title: 'シェル 1', kind: 'shell' as const, selected: false, closable: true }];
  it('タブが 1 つなら押せない', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><TabStrip sessionId="s1" tabs={one} canAdd canSplit={false} split={false} /></ActionRoot>);
    expect(screen.getByLabelText('横に並べる')).toBeDisabled();
    rerender(<ActionRoot onAction={onAction}><TabStrip sessionId="s1" tabs={two} canAdd canSplit split={false} /></ActionRoot>);
    fireEvent.click(screen.getByLabelText('横に並べる'));
    expect(onAction).toHaveBeenCalledWith({ type: 'split.toggle' });
  });
  it('分割中は押された状態にする', () => {
    render(<ActionRoot onAction={() => {}}><TabStrip sessionId="s1" tabs={two} canAdd canSplit split /></ActionRoot>);
    expect(screen.getByLabelText('横に並べる')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('TabStrip の出入り', () => {
  const one = [{ id: 't1', title: 'Claude', kind: 'agent' as const, selected: true, closable: false }];
  const two = [...one, { id: 't2', title: 'シェル 1', kind: 'shell' as const, selected: false, closable: true }];
  let restore: () => void = () => {};
  afterEach(() => { restore(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });
  it('選んでいたタブを閉じても、出ていく影は選択の形を持たない', () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished: new Promise<void>(() => {}), cancel: vi.fn() }; };
    const picked = [{ ...one[0]!, selected: false }, { ...two[1]!, selected: true }];
    const ui = (tabs: typeof two) => <ActionRoot onAction={vi.fn()}><TabStrip sessionId="s1" tabs={tabs} canAdd canSplit split={false} /></ActionRoot>;
    const { rerender } = render(ui(picked));
    rerender(ui(one));
    const ghost = document.querySelector('.tabs [role="presentation"]') as HTMLElement;
    expect(ghost).not.toBeNull();
    expect(ghost).not.toHaveClass('tab-selected');
    expect(document.querySelectorAll('.tab-selected')).toHaveLength(1);
  });
  it('閉じたタブは畳んで出るあいだ、操作できない影として残し、終わったら外す', async () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    let finish: () => void = () => {};
    const finished = new Promise<void>((r) => { finish = r; });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished, cancel: vi.fn() }; };
    const onAction = vi.fn();
    const ui = (tabs: typeof two) => <ActionRoot onAction={onAction}><TabStrip sessionId="s1" tabs={tabs} canAdd canSplit split={false} /></ActionRoot>;
    const { rerender } = render(ui(two));
    rerender(ui(one));
    // 出ていくタブは tab の役を外し、読み上げにも、フォーカスにも、クリックにも出さない。
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    const ghost = document.querySelector('.tabs [role="presentation"]') as HTMLElement;
    expect(ghost).not.toBeNull();
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(ghost).not.toHaveAttribute('tabindex');
    expect(ghost.querySelector('.tab-close')).toBeNull();
    fireEvent.click(ghost);
    expect(onAction).not.toHaveBeenCalled();
    await act(async () => { finish(); await finished; });
    expect(document.querySelector('.tabs [role="presentation"]')).toBeNull();
  });
  it('セッションが替わるときは、前のセッションのタブを畳まず入れ替える', () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished: new Promise<void>(() => {}), cancel: vi.fn() }; };
    const ui = (id: string, tabs: typeof two) => <ActionRoot onAction={vi.fn()}><TabStrip sessionId={id} tabs={tabs} canAdd canSplit split={false} /></ActionRoot>;
    const { rerender } = render(ui('s1', two));
    rerender(ui('s2', [{ ...one[0]!, id: 'u1' }]));
    expect(document.querySelector('.tabs [role="presentation"]')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});

describe('TabStrip のキー操作（C3）', () => {
  const three = [
    { id: 't1', title: 'Claude', kind: 'agent' as const, selected: false, closable: false },
    { id: 't2', title: 'シェル 1', kind: 'shell' as const, selected: true, closable: true },
    { id: 't3', title: 'シェル 2', kind: 'shell' as const, selected: false, closable: true },
  ];
  const mount = () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><TabStrip sessionId="s1" tabs={three} canAdd canSplit split={false} /></ActionRoot>);
    return { onAction, tabs: () => screen.getAllByRole('tab') };
  };

  it('Tab で止まるのは選ばれたタブだけで、選ばれたことを aria-selected で伝える', () => {
    const { tabs } = mount();
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('← と → でフォーカスを隣のタブへ動かし、端では反対の端へ回る。選ぶのは Enter まで待つ', () => {
    const { tabs, onAction } = mount();
    act(() => tabs()[1]!.focus());
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs()[2]);
    fireEvent.keyDown(tabs()[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs()[0]);
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs()[2]);
    fireEvent.keyDown(tabs()[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(tabs()[0]);
    fireEvent.keyDown(tabs()[0]!, { key: 'End' });
    expect(document.activeElement).toBe(tabs()[2]);
    // 選ぶとフォーカスはターミナルへ移るので、矢印で動くたびに選ぶと続けて動けない。
    expect(onAction).not.toHaveBeenCalled();
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(tabs()[2]!, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't3' });
    fireEvent.keyDown(tabs()[2]!, { key: ' ' });
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('⌘← や ⌘→ は戻る進むの打鍵なので、タブでは使わない', () => {
    const { tabs } = mount();
    act(() => tabs()[1]!.focus());
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight', metaKey: true });
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it('各タブの閉じるボタンは Tab で止まらない（⌘W で閉じられる）。追加と分割は止まる', () => {
    mount();
    expect(screen.getByLabelText('シェル 1 を閉じる').tabIndex).toBe(-1);
    expect(screen.getByLabelText('シェル 2 を閉じる').tabIndex).toBe(-1);
    expect(screen.getByLabelText('シェルタブを追加').tabIndex).toBe(0);
    expect(screen.getByLabelText('横に並べる').tabIndex).toBe(0);
  });

  it('閉じるボタンの Enter ではタブを選ばない', () => {
    const { onAction } = mount();
    fireEvent.keyDown(screen.getByLabelText('シェル 2 を閉じる'), { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalledWith({ type: 'tab.select', tabId: 't3' });
  });

  it('タブの列を離れたら、止まり先は選ばれたタブに戻る', () => {
    const { tabs } = mount();
    act(() => tabs()[1]!.focus());
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight' });
    act(() => screen.getByLabelText('横に並べる').focus());
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });
});


// 見た目の規則（base.css、session.css）が掴む印を、画面の側で固定する。印が消えると、規則は黙って効かなくなる。
describe('SessionScreen の読む面の印', () => {
  it('畳んだ目次の列だけが data-collapsed を持つ', () => {
    const { container, rerender } = render(<ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} transcriptOpen={false} /></TerminalHostContext.Provider></ActionRoot>);
    expect(container.querySelector('.toc-slot')).toHaveAttribute('data-collapsed', 'true');
    rerender(<ActionRoot onAction={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} transcriptOpen /></TerminalHostContext.Provider></ActionRoot>);
    expect(container.querySelector('.toc-slot')).not.toHaveAttribute('data-collapsed');
  });
  it('実行していないセッションでは、切替と会話を 1 枚の白い面に載せる', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><SS {...base} /></ActionRoot>);
    const sheet = container.querySelector('.tr-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet!.querySelector('.tr')).not.toBeNull();
    expect(sheet).toContainElement(screen.getByLabelText('思考を表示'));
  });
  // 画面は縦の flex で窓の残りを取る。
  // 本体の段がその残りを受け取る印。
  it('画面の器と、残りの高さを受け取る段に印を付ける', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><SS {...base} /></ActionRoot>);
    expect(container.querySelector('.screen.session-screen > .c-body')).not.toBeNull();
    cleanup();
    withHost(<SS {...running} />);
    expect(document.querySelector('.screen.session-screen > .c-body')).not.toBeNull();
  });
});

describe('SessionScreen（本文が消えた会話）', () => {
  const gone = { note: 'トランスクリプトは、Claude Code の保持期間（30 日）を過ぎたため削除されたとみられます。残っているのは要約だけです。', canExtend: true, extendTo: 365 };
  const props = { ...base, hasTranscript: false, items: [], total: 0, loaded: 0, hasMore: false, turnRows: [], canResume: false, canFork: false, gone, lead: leadOf({ hasTranscript: false }, { gone: true }) };
  it('注記と要約のみの印を出し、延ばす手を添え、本文の欄と目次は出さない', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><SS {...props} /></ActionRoot>);
    expect(screen.getByText('要約のみ')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(gone.note);
    expect(screen.getByText('BODY')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保持期間を延ばす…' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'retention.edit', days: 365, from: 'session' });
    expect(container.querySelector('.tr-sheet')).toBeNull();
    expect(container.querySelector('.toc-pane')).toBeNull();
  });
  it('本文が無いので、冒頭の 1 枚の要約の作り直しは出さない', () => {
    render(<ActionRoot onAction={() => {}}><SS {...props} /></ActionRoot>);
    expect(screen.queryByRole('button', { name: '要約を再生成' })).toBeNull();
    expect(menu().queryByRole('menuitem', { name: /要約を再生成/ })).toBeNull();
  });
  it('延ばせないときは手を出さず、要約も無ければそう言う', () => {
    const lead = leadOf({ summary: null, hasTranscript: false }, { gone: true });
    render(<ActionRoot onAction={() => {}}><SS {...props} lead={lead} oneLiner={null} gone={{ ...gone, canExtend: false }} /></ActionRoot>);
    expect(screen.queryByRole('button', { name: '保持期間を延ばす…' })).toBeNull();
    expect(screen.getByText('要約はありません')).toBeInTheDocument();
  });
});

describe('SessionScreen（英語）', () => {
  const en = translator('en');
  const JAPANESE = /[぀-ヿ㐀-鿿]/;
  const noJapanese = () => expect(document.body.textContent ?? '').not.toMatch(JAPANESE);
  const call = (name: string, input: unknown) => ({ kind: 'tool_call' as const, seq: 1, toolId: 't1', name, input, summary: name });
  const enTool = (name: string, input: unknown, result: { text: string; isError: boolean }) => ({ ...toolItem(1, name, input, result, { subagent: { agentId: 'abc', label: 'x' } }), view: presentTool(call(name, input), result, '/w/app', en) });
  const enProps = (over: Partial<SessionProps> = {}): SessionProps => {
    const props: SessionProps = { ...base, items: [{ kind: 'user', seq: 0, text: 'hi', when: '10:00' }, enTool('Write', { file_path: '/w/app/a.ts', content: 'a\nb' }, { text: 'File created successfully', isError: false })], turnRows: [], lead: null, ...over };
    return { ...props, actions: sessionActions(props, en) };
  };
  it('終わった画面：操作、切り替え、続きの読み込み、ツールの行が英語で出る', () => {
    render(<ActionRoot onAction={() => {}}><LanguageRoot language="en"><SessionScreen {...enProps()} /></LanguageRoot></ActionRoot>);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(menuOf('More actions').getByRole('menuitem', { name: /Fork/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show thinking' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Main conversation' })).toBeInTheDocument();
    expect(screen.getByText('Load older lines (6 left)')).toBeInTheDocument();
    expect(screen.getByText(/New file/)).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();
    expect(screen.getByText('View subagent abc')).toBeInTheDocument();
    noJapanese();
  });
  it('押せない再開の理由と、本文が消えた会話の注記が英語で出る', () => {
    const blocked = enProps({ canResume: false, canFork: false, remoteOnly: true, hasTranscript: false });
    const { unmount } = render(<ActionRoot onAction={() => {}}><LanguageRoot language="en"><SessionScreen {...blocked} /></LanguageRoot></ActionRoot>);
    expect(screen.getAllByText('Running on Another computer. Available once it stops or stops responding').length).toBeGreaterThan(0);
    unmount();
    const gone = { note: en('session.gone.note', { period: '30 days' }), canExtend: true, extendTo: 365 };
    render(<ActionRoot onAction={() => {}}><LanguageRoot language="en"><SessionScreen {...enProps({ gone, hasTranscript: false, items: [] })} /></LanguageRoot></ActionRoot>);
    expect(screen.getByRole('note')).toHaveTextContent('Claude Code retention period (30 days)');
    expect(screen.getByRole('button', { name: 'Extend retention period…' })).toBeInTheDocument();
  });
  it('実行中の画面：タブ、案内、ターミナルの帯と切断のカードが英語で出る', () => {
    const h: TerminalHost = { ...host, status: (id) => (id === 't1' ? 'closed' : 'connected'), link: (id) => (id === 't1' ? { retryAt: Date.now() + 5000, dropped: true, gaveUp: false, detached: false } : { retryAt: null, dropped: false, gaveUp: false, detached: false }) };
    const props = enProps({ live: 'busy', run: { id: 'r1', kind: 'start', alive: true, started: '1 minute ago' }, selectedTab: 'r1', canSplit: true, split: { left: 'r1', right: 't1' }, trustHint: true, transcriptBand: { when: '12:09' },
      tabs: [{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't1', title: 'Shell 1', kind: 'shell', selected: false, closable: true }] });
    render(<ActionRoot onAction={() => {}}><LanguageRoot language="en"><TerminalHostContext.Provider value={h}><SessionScreen {...props} /></TerminalHostContext.Provider></LanguageRoot></ActionRoot>);
    expect(screen.getByLabelText('Close Shell 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Add shell tab')).toBeInTheDocument();
    expect(screen.getByLabelText('Split side by side')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Left and right width' })).toHaveAttribute('aria-valuetext', 'Left 50%');
    expect(screen.getByText('Transcript view')).toBeInTheDocument();
    expect(screen.getByText('Turn from 12:09 · Claude keeps working in the background')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Jump to latest/ }).length).toBeGreaterThan(0);
    const right = within(screen.getByTestId('term-t1'));
    expect(right.getByText('Terminal disconnected')).toBeInTheDocument();
    expect(right.getByText('The shell is still running. Reconnecting in 5 seconds.')).toBeInTheDocument();
    expect(right.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getAllByRole('status').some((e) => (e.textContent ?? '').includes('If a trust dialog appears'))).toBe(true);
  });
});
