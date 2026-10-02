import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { sessionActions, type SessionProps } from '../presenters/session.ts';
import type { TerminalHost } from '../runtime/terminals.ts';
import { toolItem } from '../test/items.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { pick } from '../test/pick.ts';
import { SessionScreen } from './SessionScreen.tsx';
import { TabStrip } from './TabStrip.tsx';
import { TerminalHostContext } from './TerminalPane.tsx';

const base: SessionProps = { id: 's1', name: 'name', parent: { label: 'alpha', route: { name: 'project', id: 'p1' } }, live: 'busy', cwd: '/w/alpha', projectName: 'alpha', projectId: 'p1', summary: { title: 'T', oneLiner: 'ONE', body: 'BODY', state: 'in_progress', nextSteps: ['next1'], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: 1, sourceLabel: '自動', stateLabel: '進行中', summarizerLabel: null, generatedAt: '1970-01-01 09:00' }, summaryOpen: false, model: 'fable 5.1', effort: 'high', turns: 2, tokens: '1.2M', prUrl: null, memo: null, started: '2 時間前', lastActivity: '1 分前', hasTranscript: true,
  items: [
    { kind: 'user', seq: 0, text: 'hi', when: '10:00' },
    toolItem(1, 'Agent', { description: 'x' }, { text: 'done', isError: false }, { when: '10:01', subagent: { agentId: 'abc', label: 'Agent x' } }),
    toolItem(2, 'Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }, { text: 'File not found', isError: true }, { when: '10:02' }),
    { kind: 'assistant', seq: 3, text: 'bye', when: '10:03' },
  ], total: 10, loaded: 4, loading: false, hasMore: true, showThinking: false, showRaw: false, follow: true, agentId: null, subagents: ['abc'], notFound: false, loadingSession: false, run: null, tabs: [], selectedTab: null, transcriptOpen: true, trustHint: false, canResume: true, canFork: true,
  contextPercent: null, cost: '', artifacts: [], summaryPending: false, summaryError: null, fromScratch: false, canPromote: false, split: null, canSplit: false, lock: null, remoteOnly: false, canResumeHere: false, outsideOpen: null, liveLabel: null, filesChanged: 3,
  turnRows: [{ seq: 0, when: '10:00', text: 'hi', head: 'hi', tools: 2, open: false, band: [] }], turnsComplete: false, turnsPending: false, openTurnItems: [], turnJump: null, livePane: null, livePaneSplit: 0.5, gone: null, find: null, jump: null, hasNewer: false,
  actions: { primary: { id: 'resume', label: '再開', disabled: null, note: null }, menu: [] }, changedFiles: [], changedMore: 0, changedNote: null, todos: [], transcriptBand: null };

/**
 * 見出しの操作は presenter が事実から決める。
 * 画面の試験でも同じ関数で作り、事実と操作が食い違わないようにする。
 */
const SS = (props: SessionProps) => <SessionScreen {...props} actions={sessionActions(props)} />;
/** 「…」のメニューを開いて、その中の項目を返す。 */
const menu = () => { fireEvent.click(screen.getByRole('button', { name: 'ほかの操作' })); return within(screen.getByRole('menu', { name: 'ほかの操作' })); };
const info = (c: HTMLElement) => c.querySelector('.session-info')!;

describe('SessionScreen（終わった画面）', () => {
  it('見出し、切替、続きの読み込み', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} /></IntentRoot>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('name');
    expect(screen.getByText('ONE')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('思考を表示'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.showThinking', sessionId: 's1', show: true });
    fireEvent.click(screen.getByText('古い行を読み込む（残り 6 件）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.loadMore', sessionId: 's1' });
    fireEvent.click(screen.getByRole('radio', { name: 'abc' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('思考と生の記録は、押した状態を aria-pressed で見せる', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} showThinking showRaw={false} /></IntentRoot>);
    expect(screen.getByRole('button', { name: '思考を表示' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '生の記録を表示' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('サブエージェントが 4 つ以上なら一覧にする', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} subagents={['a1', 'a2', 'a3', 'a4']} /></IntentRoot>);
    expect(screen.queryByRole('radiogroup', { name: 'サブエージェント' })).toBeNull();
    pick('サブエージェント', 'サブエージェント a3');
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'a3' });
  });
  it('ツール呼び出しは畳まれ、エラーは印が付き、サブエージェントへ飛べる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} /></IntentRoot>);
    const edit = screen.getByTitle('/a').closest('.tool')!;
    expect(edit).toHaveAttribute('data-failed', 'true');
    expect(edit.querySelector('.badge')).toHaveAttribute('data-k', 'fail');
    fireEvent.click(screen.getByText('サブエージェント abc を見る'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('見つからないとき', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} notFound /></IntentRoot>);
    expect(screen.getByText('セッションが見つかりません')).toBeInTheDocument();
  });
  it('セッションの情報がまだ届いていないときは読み込み中', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} loadingSession /></IntentRoot>);
    expect(screen.getByText('セッションを読み込んでいます')).toBeInTheDocument();
    expect(screen.queryByText('セッションが見つかりません')).toBeNull();
  });
});

describe('見出しの段（A1、C1）', () => {
  it('見出しの行に状態の点、名前、要約の 1 文、主の操作、「…」を置く', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} /></IntentRoot>);
    const hero = container.querySelector('.session-hero')!;
    expect(hero.getAttribute('data-morph-hero')).toBe('s1');
    expect(hero.querySelector('.dot')).not.toBeNull();
    expect(hero.querySelector('h1.session-name')).toHaveTextContent('name');
    expect(hero.querySelector('.session-oneliner')).toHaveTextContent('ONE');
    // 1 文は省略記号で切れることがあるので、全文を title に持たせる。
    expect(hero.querySelector('.session-oneliner')).toHaveAttribute('title', 'ONE');
    const buttons = within(hero as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['再開', 'ほかの操作']);
    expect(buttons[0]).toHaveClass('btn-primary');
    expect(screen.getAllByText('ONE')).toHaveLength(1);
  });
  it('名前は見出しにだけ出し、要約の題は出さない（C1）', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} /></IntentRoot>);
    expect(screen.queryByText('T')).toBeNull();
    expect(screen.getAllByText('name')).toHaveLength(1);
  });
  it('実行中は VS Code で開くを主にし、ターミナルで開く、フォーク、要約を作り直す、停止は「…」に入れる', () => {
    const onIntent = withHost(<SS {...running} />);
    fireEvent.click(screen.getByRole('button', { name: 'VS Code で開く' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openEditor', sessionId: 's1' });
    const m = menu();
    expect(m.getAllByRole('menuitem').map((i) => i.querySelector('.menu-item-text > span')!.textContent)).toEqual(['ターミナルで開く', 'フォーク', '要約を作り直す', '停止']);
    // 押せない項目は理由を 1 行添える。
    expect(m.getByRole('menuitem', { name: /フォーク/ })).toHaveAttribute('aria-disabled', 'true');
    expect(m.getByRole('menuitem', { name: /フォーク/ })).toHaveTextContent('実行中は押せません。止めると押せます');
    fireEvent.click(m.getByRole('menuitem', { name: /ターミナルで開く/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openTerminalApp', runId: 'r1', tabId: 'r1' });
    fireEvent.click(menu().getByRole('menuitem', { name: /要約を作り直す/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'summary.regenerate', sessionId: 's1' });
  });
  it('停止は危険色でメニューの最後。作業中か、シェルタブの数を添えて送り、確認は Mediator が出す', () => {
    const onIntent = withHost(<SS {...running} live="waiting" />);
    const stop = menu().getByRole('menuitem', { name: /停止/ });
    expect(stop).toHaveAttribute('data-danger', 'true');
    fireEvent.click(stop);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 1 });
    cleanup();
    const idle = withHost(<SS {...running} live="idle" tabs={[running.tabs[0]!]} />);
    fireEvent.click(menu().getByRole('menuitem', { name: /停止/ }));
    expect(idle).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1', working: false, shellTabs: 0 });
  });
  it('終わったセッションは再開を主にし、フォークと VS Code で開くは「…」から', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.resume', id: 's1' });
    fireEvent.click(menu().getByRole('menuitem', { name: /フォーク/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.fork', id: 's1' });
    fireEvent.click(menu().getByRole('menuitem', { name: /VS Code で開く/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openEditor', sessionId: 's1' });
  });
  // disabled にすると乗せても吹き出しが出ず、キーボードでも届かない。
  // aria-disabled にして、押しても何もしないようにする。
  it('主の操作が押せないときは、理由を title と読み上げに持たせ、押しても何もしない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} hasTranscript={false} canResume={false} canFork={false} items={[]} total={0} loaded={0} hasMore={false} /></IntentRoot>);
    const resume = screen.getByRole('button', { name: '再開' });
    expect(resume).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(resume);
    expect(onIntent).not.toHaveBeenCalled();
    expect(resume).toHaveAttribute('title', '本文がありません');
    expect(resume).toHaveAccessibleDescription('本文がありません');
  });
  it('主の操作の名前は .btn-label に入れ、狭い窓では見出しの行（PageHeading の fitRow）が印だけに縮められる', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} /></IntentRoot>);
    expect(screen.getByRole('button', { name: '再開' }).querySelector(':scope > .btn-label')).toHaveTextContent('再開');
  });
  it('スクラッチの注意書きは線の下に、昇格はメニューに置く', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} fromScratch canPromote /></IntentRoot>);
    expect(within(info(container) as HTMLElement).getByText('スクラッチ')).toHaveAttribute('title', '再開しても作業ディレクトリはスクラッチのままです');
    fireEvent.click(menu().getByRole('menuitem', { name: /プロジェクトに昇格/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.promote.open', id: 's1' });
  });
});

describe('線の下の 1 行（B1）', () => {
  it('状態と経過、モデル、コンテキスト、コスト、変更、ターン、開始、作業ディレクトリを 1 行に並べる', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SS {...base} liveLabel="作業中 12 分" contextPercent={62} cost="$1.82" memo="スワイプは実機で" /></IntentRoot>);
    const items = [...info(container).children].map((c) => c.textContent);
    expect(items).toEqual(['作業中 12 分', 'fable 5.1 · high', 'コンテキスト 62%', '$1.82', '変更 3', '2 ターン · 1.2M トークン', '開始 2 時間前', 'メモ：スワイプは実機で', '/w/alpha']);
    expect(screen.getByLabelText('コンテキストの使用率').getAttribute('aria-valuenow')).toBe('62');
    expect(info(container).lastElementChild).toHaveAttribute('title', '/w/alpha');
    // 今までのチップの列と細かな事実の注記は置かない。
    expect(container.querySelector('.chips')).toBeNull();
    expect(container.querySelector('.session-facts')).toBeNull();
  });
  it('終わったセッションは状態を「終了」と最後の動きで言う。起こし方は title に持つ', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} run={{ id: 'r1', kind: 'start', alive: false, started: '1 分前' }} /></IntentRoot>);
    expect(info(container).firstElementChild).toHaveTextContent('終了 · 1 分前');
    expect(info(container).firstElementChild).toHaveAttribute('title', '起動 1 分前');
  });
  it('コンテキストとコストが未取得なら棒を描かず、設定へ導く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} /></IntentRoot>);
    expect(screen.queryByLabelText('コンテキストの使用率')).toBeNull();
    expect(screen.getByText('コンテキスト 未取得')).toBeInTheDocument();
    expect(screen.getByText('コスト 未取得')).toBeInTheDocument();
    fireEvent.click(screen.getByText('statusline を入れると出ます'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
  });
  it('値があるときは未取得の断りも案内も出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...p3} /></IntentRoot>);
    expect(screen.queryByText(/未取得/)).toBeNull();
    expect(screen.queryByText('statusline を入れると出ます')).toBeNull();
  });
  it('アーティファクトは数を出し、押すと一覧を開いて選んだものを開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...p3} /></IntentRoot>);
    const face = screen.getByRole('button', { name: /アーティファクト 1/ });
    fireEvent.click(face);
    fireEvent.click(within(screen.getByRole('menu', { name: 'アーティファクト' })).getByRole('menuitem', { name: /題名/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.open', id: 'a1' });
  });
  it('本文が無いセッションは、そう添える', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} hasTranscript={false} canResume={false} canFork={false} items={[]} total={0} loaded={0} hasMore={false} /></IntentRoot>);
    expect(within(info(container) as HTMLElement).getByText('本文がありません')).toBeInTheDocument();
  });
});

describe('終わった画面の右欄（E1）', () => {
  const files = [{ path: '/w/alpha/src/a.ts', dir: 'src/', base: 'a.ts', added: 18, removed: 3, created: false }, { path: '/w/alpha/src/new.ts', dir: 'src/', base: 'new.ts', added: 56, removed: 0, created: true }];
  const todos = [{ id: 'd1', text: 'push する', done: false, candidate: null }];
  it('本文の右に、要約、TODO、変更したファイルを上から積む', () => {
    const { container } = render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} changedFiles={files} todos={todos} /></IntentRoot>);
    const rail = container.querySelector('.session-rail')!;
    expect([...rail.querySelectorAll('.rail-panel h2')].map((h) => h.firstChild?.textContent)).toEqual(['要約', 'TODO', '変更したファイル']);
    expect(within(rail as HTMLElement).getByText('BODY')).toBeInTheDocument();
    expect(within(rail as HTMLElement).getByText('next1')).toBeInTheDocument();
    expect(within(rail as HTMLElement).getByText('push する')).toBeInTheDocument();
    // 右欄は実行中の画面には出さない（右は live-explainer の欄）。
    cleanup();
    withHost(<SS {...running} changedFiles={files} todos={todos} />);
    expect(document.querySelector('.session-rail')).toBeNull();
  });
  it('要約の欄は見立てと何ターン時点か、出所、要約器、生成の時刻を出し、作り直せる', () => {
    const onIntent = vi.fn();
    const summary = { ...base.summary!, source: 'post_hoc' as const, sourceLabel: '事後', sourceModel: 'gemma-4-26b-a4b-it-heretic', summarizerLabel: 'lmstudio / gemma-4-26b-a4b-it-heretic', generatedAt: '2026-09-19 02:36' };
    render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} summary={summary} /></IntentRoot>);
    expect(screen.getByText('進行中 · 2 ターン時点')).toBeInTheDocument();
    const line = screen.getByTestId('summary-source');
    expect(line).toHaveTextContent('事後');
    expect(line).toHaveTextContent('lmstudio / gemma-4-26b-a4b-it-heretic');
    expect(line).toHaveTextContent('2026-09-19 02:36');
    fireEvent.click(screen.getByRole('button', { name: '要約を作り直す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'summary.regenerate', sessionId: 's1' });
  });
  it('要約の作成中と失敗を出す', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><SS {...p3} live={null} summaryPending /></IntentRoot>);
    expect(screen.getByText('要約を作成しています')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={() => {}}><SS {...p3} live={null} summaryError="LM Studio に繋がりません" /></IntentRoot>);
    expect(screen.getByText('要約を作成できませんでした')).toBeInTheDocument();
  });
  it('変更したファイルは押すと VS Code で開き、出ていない分の数と訳も言う', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} changedFiles={files} changedMore={2} changedNote="ほか 2 件はサブエージェントの変更です" /></IntentRoot>);
    const row = screen.getByRole('button', { name: /new\.ts/ });
    expect(row).toHaveTextContent('新規');
    expect(row).toHaveTextContent('+56');
    expect(screen.getByRole('button', { name: /a\.ts/ })).toHaveTextContent('−3');
    fireEvent.click(row);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.openFile', sessionId: 's1', path: '/w/alpha/src/new.ts' });
    expect(screen.getByText('ほか 2 件はサブエージェントの変更です')).toBeInTheDocument();
  });
  it('右の欄は本文の面の右上のボタンでも開閉でき、閉じると本文が全幅になる', () => {
    const onIntent = vi.fn();
    const { container, rerender } = render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '右の欄を閉じる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    rerender(<IntentRoot onIntent={onIntent}><SS {...base} live={null} transcriptOpen={false} /></IntentRoot>);
    expect(container.querySelector('.session-rail')).toBeNull();
    expect(screen.getByRole('button', { name: '右の欄を開く' })).toBeInTheDocument();
  });
});

const host: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => 'connected', fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() };
const running: SessionProps = { ...base, live: 'busy', liveLabel: '作業中 12 分', run: { id: 'r1', kind: 'start', alive: true, started: '1 分前' }, selectedTab: 'r1', canResume: false, canFork: false,
  tabs: [{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }, { id: 't1', title: 'シェル 1', kind: 'shell', selected: false, closable: true }] };
const withHost = (ui: ReactElement, onIntent = vi.fn(), h: TerminalHost = host) => { render(<IntentRoot onIntent={onIntent}><TerminalHostContext.Provider value={h}>{ui}</TerminalHostContext.Provider></IntentRoot>); return onIntent; };

describe('SessionScreen（実行中）', () => {
  it('タブ列、ターミナル、右の欄の開閉', () => {
    const onIntent = withHost(<SS {...running} />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(host.mount).toHaveBeenCalledWith('r1', expect.anything());
    fireEvent.click(screen.getByRole('tab', { name: /シェル 1/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェル 1 を閉じる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't1' });
    fireEvent.click(screen.getByLabelText('シェルタブを追加'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.open', sessionId: 's1', kind: 'shell' });
    fireEvent.click(screen.getByLabelText('右の欄を閉じる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    expect(screen.getByText('hi')).toBeInTheDocument();
  });
  it('実行中の右欄は会話の全文ではなくターンの目次にする', () => {
    withHost(<SS {...running} />);
    expect(document.querySelector('.tr-pane .turn-row')?.textContent).toContain('hi');
    expect(document.querySelector('.tr-pane .tr')).toBeNull();
  });
  it('実行中も終わった後も、画面は窓の残りの高さを受け取る縦の器（session-screen）になる', () => {
    withHost(<SessionScreen {...running} />);
    expect(document.querySelector('.screen')).toHaveClass('session-screen');
    cleanup();
    withHost(<SessionScreen {...base} />);
    expect(document.querySelector('.screen')).toHaveClass('session-screen');
  });
  it('実行中は成果物を右の欄の「いま」に並べ、情報の行には出さない。境目の比率も渡す', () => {
    const artifacts = [{ id: 'a1', title: '速習資料', description: '説明', favicon: '📄', url: 'https://claude.ai/code/artifact/a1', lastPublished: '1 分前', versionCount: 1, canOpenEditor: false }];
    const livePane = { lamp: { tone: 'idle' as const, head: '休み', sub: '' }, intent: { kind: 'none' as const, text: '意図は書かれていない' }, steps: [], lanes: [], doneFolded: 0 };
    withHost(<SessionScreen {...running} artifacts={artifacts} livePane={livePane} livePaneSplit={0.3} />);
    expect(document.querySelector('.live-top')!.textContent).toContain('速習資料');
    expect((document.querySelector('.live') as HTMLElement).style.getPropertyValue('--live-split')).toBe('0.3');
    // 二重に出さない。情報の行のメニューは、右の欄を畳んでいる間だけ出す。
    expect(screen.queryByRole('button', { name: /アーティファクト 1/ })).toBeNull();
    cleanup();
    withHost(<SessionScreen {...running} artifacts={artifacts} livePane={livePane} transcriptOpen={false} />);
    expect(screen.getByRole('button', { name: /アーティファクト 1/ })).toBeInTheDocument();
  });
  it('「いま」が消えても目次は作り直さない（スクロールの位置を保つ）', () => {
    const livePane = { lamp: { tone: 'busy' as const, head: '作業中', sub: '' }, intent: { kind: 'none' as const, text: 'x' }, steps: [], lanes: [], doneFolded: 0 };
    const ui = (lp: typeof livePane | null) => <IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} livePane={lp} /></TerminalHostContext.Provider></IntentRoot>;
    const { rerender } = render(ui(livePane));
    const before = document.querySelector('.turns');
    rerender(ui(null));
    expect(document.querySelector('.live-top')).toBeNull();
    expect(document.querySelector('.turns')).toBe(before);
    rerender(ui(livePane));
    expect(document.querySelector('.live-top')).not.toBeNull();
    expect(document.querySelector('.turns')).toBe(before);
  });
  it('折りたたむとトランスクリプトを描かない', () => {
    withHost(<SS {...running} transcriptOpen={false} />);
    expect(screen.queryByText('hi')).toBeNull();
    expect(screen.getByLabelText('右の欄を開く')).toBeInTheDocument();
  });
  it('右の欄を閉じたら、列ごと消し、開くボタンをタブの帯の右端に出す', () => {
    withHost(<SS {...running} transcriptOpen={false} />);
    const split = document.querySelector('.split') as HTMLElement;
    expect(split.style.gridTemplateColumns).toBe('minmax(0, 1fr) 0px');
    const open = screen.getByRole('button', { name: '右の欄を開く' });
    expect(open.closest('.tabs')).not.toBeNull();
    expect(document.querySelector('.tr-pane .tr-toggle')).toBeNull();
  });
  it('開いている間は、開閉のボタンを欄の中に置き、タブの帯には出さない', () => {
    withHost(<SS {...running} />);
    expect(screen.getByRole('button', { name: '右の欄を閉じる' }).closest('.tr-pane')).not.toBeNull();
    expect(document.querySelector('.tabs .tab-pane-open')).toBeNull();
  });
  describe('動く環境', () => {
    let restore: () => void = () => {};
    afterEach(() => { restore(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });
    it('閉じる動きが終わるまで欄の中身を残し、終わったら外す（列は先に 0px になる）', async () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      let finish: () => void = () => {};
      const finished = new Promise<void>((r) => { finish = r; });
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished, cancel: vi.fn() }; };
      const ui = (open: boolean) => <IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} transcriptOpen={open} /></TerminalHostContext.Provider></IntentRoot>;
      const { rerender } = render(ui(true));
      rerender(ui(false));
      expect(document.querySelector('.tr-pane')).toHaveAttribute('data-leaving', 'true');
      expect(document.querySelector('.tr-pane-inner')).not.toBeNull();
      await act(async () => { finish(); await finished; });
      expect(document.querySelector('.tr-pane-inner')).toBeNull();
      expect(document.querySelector('.tr-pane')).not.toHaveAttribute('data-leaving');
    });
    const livePane = { lamp: { tone: 'busy' as const, head: '作業中', sub: '' }, intent: { kind: 'none' as const, text: '最後の意図' }, steps: [], lanes: [], doneFolded: 0 };
    it('会話が終わったら「いま」を薄れさせ、終わるまで最後の中身を残し、目次は作り直さない', async () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      let finish: () => void = () => {};
      const finished = new Promise<void>((r) => { finish = r; });
      const faded: Element[] = [];
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, f: Keyframe[]) {
        if (f.at(-1)?.opacity === 0) faded.push(this);
        return { finished, cancel: vi.fn() };
      };
      const ui = (lp: typeof livePane | null) => <IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} livePane={lp} /></TerminalHostContext.Provider></IntentRoot>;
      const { rerender } = render(ui(livePane));
      const before = document.querySelector('.turns');
      rerender(ui(null));
      expect(document.querySelector('.live')).toHaveAttribute('data-leaving', 'true');
      expect(document.querySelector('.live-top')).toHaveTextContent('最後の意図');
      expect(faded.map((el) => el.className)).toEqual(expect.arrayContaining(['live-pane-head', 'live-top', 'live-divider']));
      await act(async () => { finish(); await finished; });
      expect(document.querySelector('.live-top')).toBeNull();
      expect(document.querySelector('.live')).not.toHaveAttribute('data-leaving');
      expect(document.querySelector('.turns')).toBe(before);
    });
    it('会話が終わったら、薄れる前にランプを終わりの形（休みの色、「終わりました」）へ替える', () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished: new Promise<void>(() => {}), cancel: vi.fn() }; };
      const ui = (lp: typeof livePane | null) => <IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} livePane={lp} /></TerminalHostContext.Provider></IntentRoot>;
      const { rerender } = render(ui(livePane));
      expect(document.querySelector('.live-lamp')).toHaveAttribute('data-tone', 'busy');
      rerender(ui(null));
      expect(document.querySelector('.live')).toHaveAttribute('data-leaving', 'true');
      const lamp = document.querySelector('.live-lamp')!;
      expect(lamp).toHaveAttribute('data-tone', 'idle');
      expect(lamp.querySelector('.live-dot')).toHaveAttribute('data-tone', 'idle');
      expect(lamp).toHaveTextContent('終わりました');
      expect(lamp).not.toHaveTextContent('作業中');
      // 意図などの中身は最後のまま残す。
      expect(document.querySelector('.live-top')).toHaveTextContent('最後の意図');
    });
    it('別のセッションへ替えたときは、前のセッションの「いま」を薄れさせずにすぐ外す', () => {
      restore = fakeMotionTokens(undefined, { everywhere: true });
      const animate = vi.fn(function () { return { finished: new Promise<void>(() => {}), cancel: vi.fn() }; });
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
      const ui = (id: string, lp: typeof livePane | null) => <IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} id={id} livePane={lp} /></TerminalHostContext.Provider></IntentRoot>;
      const { rerender } = render(ui('s1', livePane));
      animate.mockClear();
      rerender(ui('s2', null));
      expect(document.querySelector('.live-top')).toBeNull();
      expect(document.querySelector('.live-pane-head')).toBeNull();
      expect(document.querySelector('.live')).not.toHaveAttribute('data-leaving');
      expect(screen.queryByText('最後の意図')).toBeNull();
      // 目次も滑らせない（前のセッションの位置から動かさない）。
      expect(animate.mock.calls.length).toBe(0);
    });
  });
  it('情報の行の数（ターン、トークン、コスト）は数の回転で出す', () => {
    withHost(<SS {...running} cost="$1.20" />);
    const info = document.querySelector('.session-info')!;
    expect(info.querySelectorAll('.roll').length).toBeGreaterThanOrEqual(3);
  });
  it('情報の行の数は、セッションが替わったら回さず作り直す', () => {
    const { rerender } = render(<IntentRoot onIntent={vi.fn()}><SS {...base} live={null} cost="$1.20" /></IntentRoot>);
    const before = [...document.querySelectorAll('.session-info .roll')];
    rerender(<IntentRoot onIntent={vi.fn()}><SS {...base} id="s2" live={null} cost="$9.90" /></IntentRoot>);
    const after = [...document.querySelectorAll('.session-info .roll')];
    expect(after.length).toBe(before.length);
    after.forEach((el) => expect(before).not.toContain(el));
  });
  it('要約の一行は、文が替わると作り直す（入る動きをもう一度出す）', () => {
    const { rerender } = render(<IntentRoot onIntent={vi.fn()}><SS {...base} live={null} /></IntentRoot>);
    const first = document.querySelector('.session-oneliner');
    rerender(<IntentRoot onIntent={vi.fn()}><SS {...base} live={null} summary={{ ...base.summary!, oneLiner: 'TWO' }} /></IntentRoot>);
    expect(document.querySelector('.session-oneliner')).not.toBe(first);
  });
  it('信頼ダイアログの案内と終了の表示', () => {
    withHost(<SS {...running} live={null} trustHint />);
    expect(screen.getByRole('status')).toHaveTextContent('信頼確認');
    cleanup();
    withHost(<SS {...running} live={null} run={{ ...running.run!, alive: false }} canResume />);
    expect(screen.getByRole('status')).toHaveTextContent('Claude は終了しました');
    // 終了した run では新しいシェルを開けないので、＋ を出さない。
    expect(screen.queryByLabelText('シェルタブを追加')).toBeNull();
    expect(screen.getByRole('button', { name: '再開' })).toBeEnabled();
    expect(menu().queryByRole('menuitem', { name: /停止/ })).toBeNull();
  });
  it('分割の指定があれば 2 つのターミナルを並べる', () => {
    withHost(<SS {...running} canSplit split={{ left: 'r1', right: 't1' }} />);
    expect(screen.getByTestId('split')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^term-/)).toHaveLength(2);
    expect(host.mount).toHaveBeenCalledWith('t1', expect.anything());
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
    expect(right.getByText(/シェルは動き続けています。5 秒後にもう一度つなぎます。/)).toBeInTheDocument();
    fireEvent.click(right.getByRole('button', { name: '再接続' }));
    expect(h.reconnect).toHaveBeenCalledWith('t1');
  });
  it('目次から跳ばしている間は、Claude の枠の上端に帯と「最新へ戻る」を出す', () => {
    const onIntent = withHost(<SS {...running} canSplit split={{ left: 'r1', right: 't1' }} transcriptBand={{ when: '12:09' }} />);
    const left = within(screen.getByTestId('term-r1'));
    expect(left.getByText('transcript を表示中')).toBeInTheDocument();
    expect(left.getByText('12:09 のターン · Claude は裏で動き続けています')).toBeInTheDocument();
    expect(within(screen.getByTestId('term-t1')).queryByText('transcript を表示中')).toBeNull();
    fireEvent.click(left.getByRole('button', { name: /最新へ戻る/ }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'turn.latest', sessionId: 's1', runId: 'r1' });
  });
  it('帯が出ていても、枠の中の Esc は横取りせずに Claude へ渡す', () => {
    // Esc は Claude の中断に要る。
    // 利用者が xterm で自分で transcript を抜けた後に横取りすると、中断が「最新へ」に化けて失われる。
    const onIntent = withHost(<SS {...running} transcriptBand={{ when: '12:09' }} />);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      const target = screen.getByTestId('term-r1').querySelector('.term-host')!;
      for (const init of [{ key: 'Escape' }, { key: 'Escape', shiftKey: true }, { key: 'Escape', isComposing: true }]) {
        // 既定を止めず、外へも伝わる（Root の器も xterm も受け取れる）。
        expect(fireEvent.keyDown(target, init)).toBe(true);
      }
      expect(outer).toHaveBeenCalledTimes(3);
      expect(onIntent).not.toHaveBeenCalled();
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
    const m = menu();
    expect(iconOf(m.getByRole('menuitem', { name: /ターミナルで開く/ }))).toBe('openTerminal');
    expect(iconOf(m.getByRole('menuitem', { name: /停止/ }))).toBe('stop');
    expect(iconOf(m.getByRole('menuitem', { name: /フォーク/ }))).toBe('fork');
  });
  it('タブは種類ごとのアイコンを持ち、閉じると追加は読み上げ名を保つ', () => {
    withHost(<SS {...running} />);
    expect(iconOf(screen.getByRole('tab', { name: /Claude/ }))).toBe('agent');
    expect(iconOf(screen.getByRole('tab', { name: /シェル 1/ }))).toBe('shell');
    expect(iconOf(screen.getByRole('button', { name: 'シェル 1 を閉じる' }))).toBe('close');
    expect(iconOf(screen.getByRole('button', { name: 'シェルタブを追加' }))).toBe('add');
  });
  it('右の欄の開閉は向きの違うアイコンになる', () => {
    withHost(<SS {...running} />);
    expect(iconOf(screen.getByRole('button', { name: '右の欄を閉じる' }))).toBe('paneClose');
    cleanup();
    withHost(<SS {...running} transcriptOpen={false} />);
    expect(iconOf(screen.getByRole('button', { name: '右の欄を開く' }))).toBe('paneOpen');
  });
  it('ツール呼び出しとサブエージェントと折りたたみの矢印', () => {
    render(<IntentRoot onIntent={vi.fn()}><SS {...base} /></IntentRoot>);
    const tool = screen.getByTitle('/a').closest('.tool')!;
    expect(tool.querySelector('.chev svg')?.getAttribute('data-icon')).toBe('chevron');
    expect(tool.querySelector('.badge')?.textContent).toBe('Edit');
    expect(iconOf(screen.getByRole('button', { name: 'サブエージェント abc を見る' }))).toBe('subagent');
  });
});

const p3: SessionProps = { ...base, contextPercent: 62, cost: '$1.20', artifacts: [{ id: 'a1', title: '題名', description: null, favicon: '📊', url: 'https://claude.ai/code/artifact/a1', lastPublished: '1 分前', versionCount: 1, canOpenEditor: false }] };

describe('フェーズ 4 のセッション画面', () => {
  const lock = { deviceName: 'mini', stale: false, heartbeat: '1 分前', label: 'mini で実行中' };
  const staleLock = { deviceName: 'mini', stale: true, heartbeat: '5 分前', label: 'mini から応答がありません' };
  it('他の PC で実行中なら、この PC で再開を主にして理由を添えて止め、再開とフォークもメニューで止める', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} canResume={false} canFork={false} lock={lock} /></IntentRoot>);
    expect(screen.getByText('mini で実行中')).toBeInTheDocument();
    expect(screen.getByText('最終確認 1 分前')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'この PC で再開' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'この PC で再開' })).toHaveAccessibleDescription('mini で実行中です。止まるか応答が無くなると選べます');
    const m = menu();
    expect(m.getByRole('menuitem', { name: /再開/ })).toHaveAttribute('aria-disabled', 'true');
    expect(m.getByRole('menuitem', { name: /フォーク/ })).toHaveAttribute('aria-disabled', 'true');
  });
  // 文言は presenter の lock.label をそのまま出す。View は色だけを変える。
  it('応答が無いロックは警告の色で出す', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} canResume={false} canFork={false} lock={staleLock} /></IntentRoot>);
    expect(screen.getByText('mini から応答がありません')).toHaveClass('warn');
    expect(screen.getByText('最終確認 5 分前')).toBeInTheDocument();
    expect(screen.queryByText('mini で実行中')).toBeNull();
    expect(screen.getByText('mini から応答がありません')).not.toHaveClass('lock');
  });
  it('外で動くセッションには、引き取りと attach を「…」に出す', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SS {...base} live="waiting" canResume={false} canFork={false} outsideOpen="adopt" /></IntentRoot>);
    fireEvent.click(menu().getByRole('menuitem', { name: /hangar で引き取る/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.adopt', id: 's1' });
    rerender(<IntentRoot onIntent={onIntent}><SS {...base} live="waiting" canResume={false} canFork={false} outsideOpen="attach" /></IntentRoot>);
    fireEvent.click(menu().getByRole('menuitem', { name: /hangar でつなぐ/ }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.attach', id: 's1' });
    rerender(<IntentRoot onIntent={onIntent}><SS {...base} live="waiting" canResume={false} canFork={false} /></IntentRoot>);
    const m = menu();
    expect(m.queryByRole('menuitem', { name: /hangar で引き取る/ })).toBeNull();
    expect(m.queryByRole('menuitem', { name: /hangar でつなぐ/ })).toBeNull();
  });
  it('写しだけのセッションはこの PC で再開を主にする', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} canResume={false} canFork={false} remoteOnly canResumeHere /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'この PC で再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1' });
    expect(within(info(container) as HTMLElement).getByText('本文は他の PC にあります')).toBeInTheDocument();
  });
  // Ruling 14。相手が落ちて heartbeat だけ残った状態を行き止まりにしない。
  it('応答の無いロックからもこの PC で再開に逃げられる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SS {...base} live={null} canResume={false} canFork={false} lock={staleLock} canResumeHere /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'この PC で再開' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.resumeHere', id: 's1' });
  });
  it('ロックが無ければこの PC で再開は出ない', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} /></IntentRoot>);
    expect(screen.queryByRole('button', { name: 'この PC で再開' })).toBeNull();
    expect(screen.queryByText('本文は他の PC にあります')).toBeNull();
    expect(screen.getByRole('button', { name: '再開' })).not.toBeDisabled();
  });
  // 引き継ぎはこのフェーズでは作らない（利用者の決定 1）。
  it('引き継ぎの操作は出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...base} live={null} canResume={false} canFork={false} lock={lock} /></IntentRoot>);
    expect(screen.queryByRole('button', { name: /引き継/ })).toBeNull();
    expect(menu().queryByRole('menuitem', { name: /引き継/ })).toBeNull();
  });
});

const iconOf = (el: Element | null) => el?.querySelector('svg')?.getAttribute('data-icon') ?? null;


describe('TabStrip の横に並べるボタン', () => {
  const one = [{ id: 't1', title: 'Claude', kind: 'agent' as const, selected: true, closable: false }];
  const two = [...one, { id: 't2', title: 'シェル 1', kind: 'shell' as const, selected: false, closable: true }];
  it('タブが 1 つなら押せない', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><TabStrip sessionId="s1" tabs={one} canAdd canSplit={false} split={false} /></IntentRoot>);
    expect(screen.getByLabelText('横に並べる')).toBeDisabled();
    rerender(<IntentRoot onIntent={onIntent}><TabStrip sessionId="s1" tabs={two} canAdd canSplit split={false} /></IntentRoot>);
    fireEvent.click(screen.getByLabelText('横に並べる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'split.toggle' });
  });
  it('分割中は押された状態にする', () => {
    render(<IntentRoot onIntent={() => {}}><TabStrip sessionId="s1" tabs={two} canAdd canSplit split /></IntentRoot>);
    expect(screen.getByLabelText('横に並べる')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('TabStrip の出入り', () => {
  const one = [{ id: 't1', title: 'Claude', kind: 'agent' as const, selected: true, closable: false }];
  const two = [...one, { id: 't2', title: 'シェル 1', kind: 'shell' as const, selected: false, closable: true }];
  let restore: () => void = () => {};
  afterEach(() => { restore(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });
  it('閉じたタブは畳んで出るあいだ、操作できない影として残し、終わったら外す', async () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    let finish: () => void = () => {};
    const finished = new Promise<void>((r) => { finish = r; });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished, cancel: vi.fn() }; };
    const onIntent = vi.fn();
    const ui = (tabs: typeof two) => <IntentRoot onIntent={onIntent}><TabStrip sessionId="s1" tabs={tabs} canAdd canSplit split={false} /></IntentRoot>;
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
    expect(onIntent).not.toHaveBeenCalled();
    await act(async () => { finish(); await finished; });
    expect(document.querySelector('.tabs [role="presentation"]')).toBeNull();
  });
  it('セッションが替わるときは、前のセッションのタブを畳まず入れ替える', () => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { return { finished: new Promise<void>(() => {}), cancel: vi.fn() }; };
    const ui = (id: string, tabs: typeof two) => <IntentRoot onIntent={vi.fn()}><TabStrip sessionId={id} tabs={tabs} canAdd canSplit split={false} /></IntentRoot>;
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
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><TabStrip sessionId="s1" tabs={three} canAdd canSplit split={false} /></IntentRoot>);
    return { onIntent, tabs: () => screen.getAllByRole('tab') };
  };

  it('Tab で止まるのは選ばれたタブだけで、選ばれたことを aria-selected で伝える', () => {
    const { tabs } = mount();
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('← と → でフォーカスを隣のタブへ動かし、端では反対の端へ回る。選ぶのは Enter まで待つ', () => {
    const { tabs, onIntent } = mount();
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
    expect(onIntent).not.toHaveBeenCalled();
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(tabs()[2]!, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't3' });
    fireEvent.keyDown(tabs()[2]!, { key: ' ' });
    expect(onIntent).toHaveBeenCalledTimes(2);
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
    const { onIntent } = mount();
    fireEvent.keyDown(screen.getByLabelText('シェル 2 を閉じる'), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'tab.select', tabId: 't3' });
  });

  it('タブの列を離れたら、止まり先は選ばれたタブに戻る', () => {
    const { tabs } = mount();
    act(() => tabs()[1]!.focus());
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight' });
    act(() => screen.getByLabelText('横に並べる').focus());
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });
});

// 見た目の規則（base.css）が掴む印を、画面の側で固定する。印が消えると、規則は黙って効かなくなる。
describe('SessionScreen の読む面の印', () => {
  it('畳んだ会話の列だけが data-collapsed を持つ', () => {
    const { container, rerender } = render(<IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} transcriptOpen={false} /></TerminalHostContext.Provider></IntentRoot>);
    expect(container.querySelector('.tr-pane')).toHaveAttribute('data-collapsed', 'true');
    rerender(<IntentRoot onIntent={vi.fn()}><TerminalHostContext.Provider value={host}><SS {...running} transcriptOpen /></TerminalHostContext.Provider></IntentRoot>);
    expect(container.querySelector('.tr-pane')).not.toHaveAttribute('data-collapsed');
  });
  it('実行していないセッションでは、切替と会話を 1 枚の白い面に載せる', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><SS {...base} live={null} /></IntentRoot>);
    const sheet = container.querySelector('.tr-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet!.querySelector('.tr')).not.toBeNull();
    expect(sheet).toContainElement(screen.getByLabelText('思考を表示'));
  });
  // 画面は縦の flex で窓の残りを取る。
  // ターミナルの段と本文の段がその残りを受け取る印。
  it('画面の器と、残りの高さを受け取る段に印を付ける', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><SS {...base} live={null} /></IntentRoot>);
    expect(container.querySelector('.screen.session-screen > .session-body')).not.toBeNull();
    cleanup();
    withHost(<SS {...running} />);
    expect(document.querySelector('.screen.session-screen > .split')).not.toBeNull();
  });
});

describe('SessionScreen（本文が消えた会話）', () => {
  const gone = { note: '本文は、Claude Code の保持期間（30 日）を過ぎたため削除されたとみられます。残っているのは要約だけです。', canExtend: true, extendTo: 365 };
  const props = { ...base, live: null, hasTranscript: false, items: [], total: 0, loaded: 0, hasMore: false, summaryOpen: true, canResume: false, canFork: false, gone };
  it('注記と要約のみの印を出し、延ばす手を添え、作り直しと本文の欄は出さない', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><SS {...props} /></IntentRoot>);
    expect(screen.getByText('要約のみ')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(gone.note);
    expect(screen.getByText('BODY')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保持期間を延ばす…' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'retention.edit', days: 365, from: 'session' });
    expect(screen.queryByRole('button', { name: '要約を作り直す' })).toBeNull();
    expect(menu().queryByRole('menuitem', { name: /要約を作り直す/ })).toBeNull();
    expect(container.querySelector('.tr-sheet')).toBeNull();
  });
  it('延ばせないときは手を出さず、要約も無ければそう言う', () => {
    render(<IntentRoot onIntent={() => {}}><SS {...props} summary={null} gone={{ ...gone, canExtend: false }} /></IntentRoot>);
    expect(screen.queryByRole('button', { name: '保持期間を延ばす…' })).toBeNull();
    expect(screen.getByText('要約もありません')).toBeInTheDocument();
  });
});
