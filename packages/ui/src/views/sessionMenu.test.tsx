import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type ProjectDto, type SessionDto, type UiAction } from '@agent-hangar/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { presentConfirm } from '../presenters/confirm.ts';
import type { BandGroup } from '../presenters/home.ts';
import { presentMoveSession } from '../presenters/moveSession.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SessionMenuProps } from '../presenters/sessionMenu.ts';
import { initialStore, type Store } from '../store/store.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { HomeBand } from './HomeBand.tsx';
import { MoveSessionDialog } from './MoveSessionDialog.tsx';
import { SessionRows } from './SessionRows.tsx';

// セッションのメニュー（1A）を、一覧の行とホームの帯の行で出す。サイドバーは sidebarLive.test.tsx で確かめる。
// 移す先のダイアログ（2A）と削除の確認（3A）もここで確かめる。

afterEach(cleanup);

const menuOf = (id: string, over: Partial<SessionMenuProps> = {}): SessionMenuProps => ({ id, name: `n${id}`, status: null, resumeHere: null, stop: null, moveBlocked: null, ...over });
const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, hasTranscript: true, cost: '', runId: null, transcript: 'present', state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, menu: menuOf(id), ...over });
const mountRows = (rows: SessionRowProps[]) => {
  const onAction = vi.fn<(i: UiAction) => void>();
  render(<ActionRoot onAction={onAction}><SessionRows rows={rows} height={400} variant="search" /></ActionRoot>);
  return onAction;
};
const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;

describe('一覧の行のメニュー（SessionRows）', () => {
  it('「⋯」で 1A のメニューを開く。状態の 4 つ（いまの状態に ✓）、プロジェクトを変更、削除の順', () => {
    mountRows([row('a', { state: 'done', menu: menuOf('a', { status: 'done' }) })]);
    fireEvent.click(screen.getByRole('button', { name: 'na のメニュー' }));
    const menu = screen.getByRole('menu', { name: 'na のメニュー' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
    expect([...menu.children].map((el) => (el.getAttribute('role') === 'separator' ? '|' : el.textContent))).toEqual(['Activeu', 'Pausedp', 'Doned', 'Archiveda', '|', 'プロジェクトを変更…m', 'セッション ID をコピー', '|', '削除…']);
  });
  it('行を右クリックすると、押した点に同じメニューを出し、ブラウザのメニューは出さない。選ぶと送って閉じ、フォーカスを行へ戻す', () => {
    const onAction = mountRows([row('a'), row('b')]);
    const rb = rowOf('nb');
    const ev = createEvent.contextMenu(rb, { clientX: 300, clientY: 80 });
    fireEvent(rb, ev);
    expect(ev.defaultPrevented).toBe(true);
    const menu = screen.getByRole('menu', { name: 'nb のメニュー' });
    expect(within(menu).getByRole('menuitem', { name: /プロジェクトを変更/ })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 'b', status: 'archived' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(rowOf('nb'));
    // 行は開かない。
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('打鍵 . でカーソルの行のメニューを開き、m で移す先のダイアログ、削除…で削除の確認を開く', () => {
    const onAction = mountRows([row('a'), row('b')]);
    const rb = rowOf('nb');
    act(() => rb.focus());
    fireEvent.keyDown(rb, { key: '.' });
    expect(screen.getByRole('menu', { name: 'nb のメニュー' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'm' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.move.open', id: 'b' });
    fireEvent.keyDown(rowOf('nb'), { key: '.' });
    fireEvent.click(screen.getByRole('menuitem', { name: '削除…' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.delete.open', id: 'b' });
  });
  it('実行中の行は停止を危険色で出し、削除は出さない', () => {
    const onAction = mountRows([row('a', { live: 'busy', runId: 'r1', menu: menuOf('a', { stop: { runId: 'r1', working: true, aside: false, shellTabs: 0 } }) })]);
    fireEvent.contextMenu(rowOf('na'));
    const stop = screen.getByRole('menuitem', { name: /^停止/ });
    expect(stop).toHaveAttribute('data-danger', 'true');
    expect(screen.queryByRole('menuitem', { name: /^削除…/ })).toBeNull();
    fireEvent.click(stop);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.kill', runId: 'r1', working: true, aside: false, shellTabs: 0 });
  });
  it('いまの状態を選び直しても何も送らない。Paused は戻る日のダイアログを開く', () => {
    const onAction = mountRows([row('a', { state: 'paused', menu: menuOf('a', { status: 'paused' }) }), row('b', { state: 'done', menu: menuOf('b', { status: 'done' }) })]);
    fireEvent.contextMenu(rowOf('nb'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Done/ }));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.contextMenu(rowOf('na'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Paused/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.pause.open', id: 'a', from: 'menu' });
  });
});

describe('ホームの帯の行のメニュー（BandRowView）', () => {
  const group: BandGroup = {
    id: 'running', label: '実行中', icon: 'tool', tone: 'default', count: 2, summary: '', morning: true,
    rows: [
      { key: 'run:s1', lead: { kind: 'dot', live: 'busy', aside: false }, name: '動く s1', context: null, text: '', detail: null, tone: null, trail: [], open: { type: 'session.open', id: 's1' }, actions: [], menu: menuOf('s1', { name: '動く s1' }) },
      { key: 'todo:t1', lead: { kind: 'todo' }, name: 'やる t1', context: null, text: '', detail: null, tone: null, trail: [], open: { type: 'project.open', id: 'p1' }, actions: [] },
    ],
  };
  const mountBand = () => {
    const onAction = vi.fn<(i: UiAction) => void>();
    render(<ActionRoot onAction={onAction}><HomeBand groups={[group]} morning="running" /></ActionRoot>);
    return onAction;
  };
  it('セッションの行を右クリックすると 1A のメニューを出す。セッションでない行では出さない', () => {
    const onAction = mountBand();
    const li = screen.getByRole('button', { name: '動く s1' }).closest('li')!;
    const ev = createEvent.contextMenu(li, { clientX: 10, clientY: 20 });
    fireEvent(li, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.getByRole('menu', { name: '動く s1 のメニュー' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'done' });
    expect(screen.queryByRole('menu')).toBeNull();
    const other = screen.getByRole('button', { name: 'やる t1' }).closest('li')!;
    const ev2 = createEvent.contextMenu(other);
    fireEvent(other, ev2);
    expect(ev2.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('行の中にフォーカスがあるときの . で開き、Esc で閉じてフォーカスを元の部品へ戻す', () => {
    mountBand();
    const name = screen.getByRole('button', { name: '動く s1' });
    act(() => name.focus());
    fireEvent.keyDown(name, { key: '.' });
    const first = screen.getAllByRole('menuitemradio')[0]!;
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(name).toHaveFocus();
    // 修飾の付いた . では開かない。
    fireEvent.keyDown(name, { key: '.', metaKey: true });
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('開いたメニューの上での右クリックは、行の右クリックとして扱わない（メニューを動かさず、既定のメニューも抑えない）', () => {
    mountBand();
    const li = screen.getByRole('button', { name: '動く s1' }).closest('li')!;
    fireEvent(li, createEvent.contextMenu(li, { clientX: 10, clientY: 20 }));
    const menu = screen.getByRole('menu', { name: '動く s1 のメニュー' });
    const before = menu.getAttribute('style');
    const item = within(menu).getAllByRole('menuitemradio')[0]!;
    const ev = createEvent.contextMenu(item, { clientX: 400, clientY: 300 });
    fireEvent(item, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.getByRole('menu', { name: '動く s1 のメニュー' })).toBe(menu);
    expect(menu.getAttribute('style')).toBe(before);
  });
});

const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const session = (over: Partial<SessionDto> = {}): SessionDto => ({ id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'ログイン画面の直し', cwd: '/Users/me/src/app', firstPrompt: null, aiTitle: null, startedAt: NOW, lastActivityAt: NOW, hasTranscript: true, live: null, summary: null, stats: { turns: 12, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, ...over });
const project = (id: string, name: string, over: Partial<ProjectDto> = {}): ProjectDto => ({ id, name, status: 'active', isScratch: false, path: `/Users/me/src/${name}`, resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: null, ...over });
const store = (): Store => ({
  ...initialStore(), home: '/Users/me', sessions: { s1: session() },
  projects: {
    p1: project('p1', 'app', { lastActivityAt: NOW }), p2: project('p2', 'paper', { lastActivityAt: NOW - 1000 }), p3: project('p3', 'home-lab', { status: 'paused' }),
    p4: project('p4', 'old', { status: 'archived' }), q: project('q', 'quick', { isScratch: true, path: '/Users/me/.agent-hangar/quick-sessions' }),
  },
} as Store);

describe('移す先のダイアログ（2A）', () => {
  const mountMove = () => {
    const onAction = vi.fn<(i: UiAction) => void>();
    const state: State = { ...initialState(), overlay: { kind: 'moveSession', sessionId: 's1' } };
    const props = presentMoveSession(state, store())!;
    render(<ActionRoot onAction={onAction}><MoveSessionDialog {...props} /></ActionRoot>);
    return onAction;
  };
  it('見出し、本文、検索の欄、最近とすべての区切り、注意書きを出す。しまったものは並べず、全 PC で 1 つのクイックセッションを並べる', () => {
    mountMove();
    const dialog = screen.getByRole('dialog', { name: 'プロジェクトの変更' });
    expect(dialog).toHaveTextContent('「ログイン画面の直し」の移動先を選択してください。');
    expect(screen.getByRole('combobox', { name: 'プロジェクトを検索' })).toHaveAttribute('placeholder', 'プロジェクトを検索');
    expect(screen.getByRole('group', { name: '最近' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'すべて' })).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['app', 'paper', 'home-lab', 'クイックセッション']);
    expect(dialog).toHaveTextContent('変わるのは hangar での分類だけです。トランスクリプトと、再開するディレクトリ（~/src/app）はそのままです。');
    // 開いたときのフォーカスは検索の欄。
    expect(screen.getByRole('combobox')).toHaveFocus();
  });
  it('いまの所属は押せず「現在のプロジェクト」を添える。選ぶまで移すボタンは押せない', () => {
    const onAction = mountMove();
    const cur = screen.getByRole('option', { name: 'app' });
    expect(cur).toHaveAttribute('aria-disabled', 'true');
    expect(cur).toHaveTextContent('現在のプロジェクト');
    fireEvent.click(cur);
    expect(cur).toHaveAttribute('aria-selected', 'false');
    const go = screen.getByRole('button', { name: '移動' });
    expect(go).toBeDisabled();
    fireEvent.click(go);
    expect(onAction).not.toHaveBeenCalled();
  });
  it('検索で絞り込み、選ぶと「{project} へ移動」で移して閉じる', () => {
    const onAction = mountMove();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lab' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['home-lab']);
    expect(screen.queryByRole('group', { name: '最近' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'home-lab' }));
    fireEvent.click(screen.getByRole('button', { name: 'home-lab へ移動' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([{ type: 'overlay.close' }, { type: 'session.move', id: 's1', projectId: 'p3' }]);
  });
  it('↑ ↓ はいまの所属を飛ばして動き、Enter で選ぶ', () => {
    mountMove();
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('option', { name: 'paper' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'paper へ移動' })).toBeEnabled();
  });
  it('選んだ行の上でもう一度 Enter を押すと移す。押せない行では確定しない', () => {
    const onAction = mountMove();
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([{ type: 'overlay.close' }, { type: 'session.move', id: 's1', projectId: 'p2' }]);
  });
  it('選んだあと、行に印が無いときの検索欄での Enter でも移す', () => {
    const onAction = mountMove();
    fireEvent.click(screen.getByRole('option', { name: 'home-lab' }));
    const box = screen.getByRole('combobox');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([{ type: 'overlay.close' }, { type: 'session.move', id: 's1', projectId: 'p3' }]);
  });
  it('何も選んでいないとき、またはいまの所属だけのときの Enter では移さない', () => {
    const onAction = mountMove();
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'app' }));
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'app' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['app']);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '移動' })).toBeDisabled();
  });
  it('選んだ行が絞り込みで一覧から消えたら、選択を外す。検索を戻しても選び直さない', () => {
    const onAction = mountMove();
    fireEvent.click(screen.getByRole('option', { name: 'paper' }));
    expect(screen.getByRole('button', { name: 'paper へ移動' })).toBeEnabled();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'lab' } });
    expect(screen.getByRole('button', { name: '移動' })).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByRole('option', { name: 'paper' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('button', { name: '移動' })).toBeDisabled();
  });
});

describe('削除の確認（3A）', () => {
  const mountDelete = () => {
    const onAction = vi.fn<(i: UiAction) => void>();
    const state: State = { ...initialState(), overlay: { kind: 'confirm', confirm: { kind: 'deleteSession', sessionId: 's1' } } };
    render(<ActionRoot onAction={onAction}><ConfirmDialog {...presentConfirm(state, store(), Date.now())!} /></ActionRoot>);
    return onAction;
  };
  it('見出し、所属とターンの 1 行、本文を出し、初めのフォーカスはキャンセル', () => {
    mountDelete();
    const dialog = screen.getByRole('dialog', { name: '「ログイン画面の直し」を削除しますか？' });
    expect(dialog).toHaveTextContent('app・12 ターン');
    expect(dialog).toHaveTextContent('トランスクリプトをゴミ箱へ移動し、hangar から削除します。同期している他の PC からも削除されます。ゴミ箱から戻すと、hangar にも戻ります。');
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'ゴミ箱へ移動' })).toHaveClass('btn-danger');
  });
  it('「ゴミ箱へ移動」で閉じてから session.delete を送る。キャンセルは閉じるだけ', () => {
    const onAction = mountDelete();
    fireEvent.click(screen.getByRole('button', { name: 'ゴミ箱へ移動' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([{ type: 'overlay.close' }, { type: 'session.delete', id: 's1' }]);
    onAction.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([{ type: 'overlay.close' }]);
  });
  it('英語の画面では英語の文にする', () => {
    const state: State = { ...initialState(), overlay: { kind: 'confirm', confirm: { kind: 'deleteSession', sessionId: 's1' } } };
    const p = presentConfirm(state, { ...store(), settings: { language: 'en' } } as unknown as Store, Date.now());
    expect(p?.deleteSession).toEqual({ name: 'ログイン画面の直し', project: 'app', turns: 12 });
    expect(translator('en')('confirm.deleteSession.facts', { project: 'app', n: 12 })).toBe('app · 12 turns');
  });
});
