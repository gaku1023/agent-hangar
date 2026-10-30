import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { SessionRows } from './SessionRows.tsx';
import { fakeMotionTokens } from '../test/motion.ts';
import { existsSync, readFileSync } from 'node:fs';

// dom の project では import.meta.url が file にならず、?raw も空文字になるので、cwd から辿って読む。
const rowsCssPath = ['packages/ui/src/styles/rows.css', 'src/styles/rows.css'].map((r) => `${process.cwd()}/${r}`).find(existsSync);
const rowsCss = readFileSync(rowsCssPath!, 'utf8');

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: id === 'a' ? 'busy' : null, aside: false, stateLabel: '完了', summaryState: null, model: 'fable 5.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 2, prUrl: 'https://x/pull/1', hasTranscript: true, cost: '', runId: null, transcript: 'present', state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null });

describe('SessionRows', () => {
  it('行のクリックと Enter で session.open', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[row('a'), row('b')]} height={400} variant="search" /></ActionRoot>);
    fireEvent.click(screen.getByText('na'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
    // 行の Enter は、その行にフォーカスがあるときにだけ届く。フォーカスした行がカーソルになる。
    const rb = screen.getByText('nb').closest('[role="row"]') as HTMLElement;
    act(() => rb.focus());
    fireEvent.keyDown(rb, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'b' });
    expect(screen.getAllByTitle('2026-09-01 10:00')).toHaveLength(2);
    expect(screen.getAllByText('alpha')).toHaveLength(2);
  });
  it('検索の結果の行は、抜粋の seq と検索語を持って開く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[{ ...row('a'), jump: { seq: 42, q: 'パスワード' } }]} height={400} variant="search" /></ActionRoot>);
    fireEvent.click(screen.getByText('na'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'a', seq: 42, q: 'パスワード' });
    const ra = screen.getByText('na').closest('[role="row"]') as HTMLElement;
    act(() => ra.focus());
    fireEvent.keyDown(ra, { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a', seq: 42, q: 'パスワード' });
  });
  it('空なら案内を出す', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[]} height={100} variant="project" /></ActionRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
  it('スマホから起動した行は、名前の後ろにラベル「スマホから」。Bypass permissions は「スマホから · Bypass permissions」を赤い枠で出す', () => {
    const phone = (bypass: boolean) => ({ label: bypass ? 'スマホから · Bypass permissions' : 'スマホから', title: 'スマホから起動したセッション', bypass });
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[{ ...row('a'), phone: phone(false) }, { ...row('b'), phone: phone(true) }, row('c')]} height={400} variant="recent" /></ActionRoot>);
    const label = (id: string) => screen.getByText('n' + id).closest('[role="row"]')!.querySelector('.row-phone');
    expect(label('a')).toHaveTextContent('スマホから');
    expect(label('a')).toHaveAttribute('title', 'スマホから起動したセッション');
    expect(label('a')).not.toHaveAttribute('data-bypass');
    expect(label('b')).toHaveTextContent('スマホから · Bypass permissions');
    expect(label('b')).toHaveAttribute('data-bypass', 'true');
    expect(label('c')).toBeNull();
    // 名前の後ろ（プロジェクトの前）に置く。
    expect(label('a')!.parentElement).toBe(screen.getByText('na'));
    expect(label('a')!.nextElementSibling).toHaveClass('row-proj');
    expect(rowsCss).toMatch(/\.row-phone\[data-bypass='true'\]\s*\{[^}]*var\(--error\)/);
  });
  it('行はセッションの id を、広がる元の印に持つ', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SessionRows rows={[row('a'), row('b')]} height={400} variant="recent" /></ActionRoot>);
    expect([...container.querySelectorAll('.row-2')].map((r) => r.getAttribute('data-morph-id'))).toEqual(['a', 'b']);
  });
});

const p3Row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({
  id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, aside: false, stateLabel: '完了', summaryState: null, model: 'opus 4.1', effort: 'high',
  when: '1 時間前', whenAbs: '2026-09-18 11:00', filesChanged: 2, prUrl: null, hasTranscript: true, transcript: 'present', cost: '$0.50', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null,
  menu: { id, name: '名前 ' + id, status: over.state ?? null, resumeHere: null, stop: null, moveBlocked: null }, ...over,
});

describe('SessionRows のフェーズ 3', () => {
  it('プロジェクトの画面の行は、コストを出さない。ノートの印も無い（ノートは 0.4.0 で外した）', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[p3Row('s1')]} height={400} variant="project" /></ActionRoot>);
    expect(screen.queryByText('$0.50')).toBeNull();
    expect(document.querySelector('.row-note')).toBeNull();
  });
  it('j と k で選び、Enter で開く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'k' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
  });
  it('カーソルの行に印が付く', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    const marked = list.querySelectorAll('[data-cursor="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain('名前 s2');
  });
  it('o はターミナル、e は VS Code', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1', { runId: 'r1' }), p3Row('s2')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'o' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.openTerminalApp', runId: 'r1' });
    fireEvent.keyDown(list, { key: 'e' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.openEditor', sessionId: 's1' });
    onAction.mockClear();
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'o' });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('選んでいなければキー操作は何も出さない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1', { runId: 'r1' })]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'Enter' });
    fireEvent.keyDown(list, { key: 'o' });
    fireEvent.keyDown(list, { key: 'e' });
    expect(onAction).not.toHaveBeenCalled();
  });
  it('m では何も起きない（ノートの入力欄は 0.4.0 で外した）', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('.memo-input')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('一覧のフォーカスの見え方', () => {
  it('一覧そのものには輪郭を描かない（開いた直後に、何も選んでいない一覧を枠が囲まないように）', () => {
    const rule = rowsCss.match(/\.rows-host:focus,\s*\.rows-host:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/outline:\s*none/);
    expect(rowsCss).not.toMatch(/\.rows-host:focus-visible\s*\{[^}]*outline:\s*2px/);
  });
  it('どこに居るかは、カーソルの行の地色で示す', () => {
    expect(rowsCss).toMatch(/\.row\[data-cursor='true'\]\s*\{[^}]*background:\s*var\(--accent-soft\)/);
  });
  it('動いていない行の点は描かず、場所だけ残す', () => {
    expect(rowsCss).toMatch(/\.row-2 > \.dot\[data-status='ended'\],\s*\.palette-item \.dot\[data-status='ended'\]\s*\{[^}]*background:\s*transparent/);
  });
  it('行のフォーカスの輪郭は内側に描き、一覧の枠で切れないようにする', () => {
    const rule = rowsCss.match(/\.row:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('var(--accent)');
    expect(rule).toMatch(/outline-offset:\s*-2px/);
  });
});

describe('カーソルの行を見える位置へ運ぶ', () => {
  let calls: { el: Element; arg: unknown }[] = [];
  beforeEach(() => {
    calls = [];
    // jsdom は scrollIntoView を実装していないので、呼ばれたことだけを見る。
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function (this: Element, arg: unknown) { calls.push({ el: this, arg }); };
  });
  afterEach(() => { delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView; });

  it('j で選んだ行を可視範囲へ寄せる', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.el.textContent).toContain('名前 s1');
    expect(calls[0]!.arg).toEqual({ block: 'nearest' });
    fireEvent.keyDown(list, { key: 'j' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.el.textContent).toContain('名前 s2');
  });
  it('k でも寄せ、選んでいないうちは動かさない', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'x' });
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'k' });
    expect(calls[calls.length - 1]!.el.textContent).toContain('名前 s1');
  });
  it('メモの編集に入っただけでは動かさない', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    const before = calls.length;
    fireEvent.keyDown(list, { key: 'm' });
    expect(calls).toHaveLength(before);
  });
});

describe('SessionRows（2 段の行）', () => {
  const r = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, aside: false, stateLabel: '完了', summaryState: null, model: 'opus 4.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 6, prUrl: 'https://github.com/x/y/pull/1', hasTranscript: true, transcript: 'present', cost: '$1.82', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
  const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;

  it('最近は 1 段目の名前の右にプロジェクト名、2 段目に要約、右は時刻だけ', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[r('a'), r('b', { projectName: null })]} height={400} variant="recent" /></ActionRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('要約 a');
    expect(row).toHaveTextContent('3 分前');
    expect(row.querySelector('.row-name .row-proj')).toHaveTextContent('alpha');
    expect(rowOf('名前 b').querySelector('.row-proj')).toHaveTextContent('未分類');
    for (const t of ['opus 4.1', '変更 6', '$1.82', 'スワイプは実機で']) expect(row).not.toHaveTextContent(t);
    expect(within(row).queryByText('PR')).toBeNull();
  });
  it('2 段目の頭に要約の見立ての札を置き、詰まっているとやめただけに調子を付ける', () => {
    const rows = [r('a', { summaryState: { label: '詰まっている', tone: 'blocked' } }), r('b', { summaryState: { label: '済んだ', tone: null } }), r('c')];
    for (const variant of ['recent', 'project', 'search'] as const) {
      const { unmount } = render(<ActionRoot onAction={() => {}}><SessionRows rows={rows} height={400} variant={variant} /></ActionRoot>);
      const tag = rowOf('名前 a').querySelector('.row-sub > .row-state');
      expect(tag, variant).toHaveTextContent('詰まっている');
      expect(tag, variant).toHaveAttribute('data-tone', 'blocked');
      expect(rowOf('名前 a').querySelector('.row-sub')!.firstElementChild, variant).toBe(tag);
      expect(rowOf('名前 b').querySelector('.row-state'), variant).not.toHaveAttribute('data-tone');
      expect(rowOf('名前 c').querySelector('.row-state'), variant).toBeNull();
      unmount();
    }
  });
  it('プロジェクトの画面の行は、右に時刻、2 段目に要約と PR の番号だけを出す。モデル、変更の数、コストは出さない', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[r('a')]} height={400} variant="project" /></ActionRoot>);
    const row = rowOf('名前 a');
    for (const t of ['3 分前', '要約 a']) expect(row).toHaveTextContent(t);
    for (const t of ['opus', '変更', '$1.82', '✎']) expect(row).not.toHaveTextContent(t);
    expect(row.querySelector('.row-meta')).toBeNull();
    expect(row.querySelector('.row-pr')).toHaveAttribute('href', 'https://github.com/x/y/pull/1');
    expect(row.querySelector('.row-proj')).toBeNull();
  });
  it('検索は 1 段目にプロジェクト名、2 段目に一致箇所を印つきで出す', () => {
    const excerpt = [{ text: '…床（', hit: false }, { text: 'transcriptsFrom', hit: true }, { text: '）を…', hit: false }];
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[r('a', { excerpt })]} height={400} variant="search" /></ActionRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('alpha');
    expect(row.querySelector('mark.hit')).toHaveTextContent('transcriptsFrom');
    expect(row).not.toHaveTextContent('要約 a');
  });
  it('検索でも抜粋が無ければ要約を出し、プロジェクトが無ければ未分類', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[r('a', { projectName: null })]} height={400} variant="search" /></ActionRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('要約 a');
    expect(row).toHaveTextContent('未分類');
  });
});

describe('一覧のキー操作（C1）', () => {
  const rowsOf = () => [...screen.getByTestId('session-rows').querySelectorAll<HTMLElement>('[role="row"]')];
  const mount = (onAction = vi.fn(), over: { autoFocus?: boolean; rows?: SessionRowProps[] } = {}) => {
    const r = render(<ActionRoot onAction={onAction}><SessionRows rows={over.rows ?? [p3Row('s1'), p3Row('s2'), p3Row('s3')]} height={400} variant="project" autoFocus={over.autoFocus} /></ActionRoot>);
    return { ...r, onAction };
  };

  it('↑ と ↓ も j と k と同じに動く', () => {
    const { onAction } = mount();
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's2' });
  });

  it('矢印は既定の動き（一覧のスクロール）を止める', () => {
    mount();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    act(() => { screen.getByTestId('session-rows').dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Tab で止まる行は 1 つだけで、カーソルの行へフォーカスが移る', () => {
    mount();
    expect(rowsOf().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'j' });
    expect(rowsOf().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(document.activeElement).toBe(rowsOf()[1]);
  });

  it('フォーカスした行がカーソルになり、Enter はその行を 1 度だけ開く', () => {
    const { onAction } = mount();
    const list = screen.getByTestId('session-rows');
    // カーソルを 1 行目に置いてから、Tab やクリックで 3 行目にフォーカスを移す。
    fireEvent.keyDown(list, { key: 'j' });
    act(() => rowsOf()[2]!.focus());
    expect(rowsOf()[2]).toHaveAttribute('data-cursor', 'true');
    expect(list.querySelectorAll('[data-cursor="true"]')).toHaveLength(1);
    fireEvent.keyDown(rowsOf()[2]!, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 's3' });
  });

  it('行の中のボタンで押した Enter は行を開かない', () => {
    const { onAction } = mount();
    const more = screen.getByLabelText('名前 s1 のメニュー');
    act(() => more.focus());
    fireEvent.keyDown(more, { key: 'Enter' });
    // 行は開かない（「⋯」の Enter はメニューを開く）。
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });

  it('⌘ や Ctrl の付いた打鍵は一覧で使わない', () => {
    mount();
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j', metaKey: true });
    fireEvent.keyDown(list, { key: 'k', ctrlKey: true });
    expect(list.querySelectorAll('[data-cursor="true"]')).toHaveLength(0);
  });

  it('autoFocus なら、描いた時点で一覧にフォーカスする。行はまだ選ばない', () => {
    mount(vi.fn(), { autoFocus: true });
    const list = screen.getByTestId('session-rows');
    expect(document.activeElement).toBe(list);
    expect(list.querySelectorAll('[data-cursor="true"]')).toHaveLength(0);
    fireEvent.keyDown(list, { key: 'j' });
    expect(document.activeElement).toBe(rowsOf()[0]);
  });

  it('autoFocus でも、入力欄で打っている最中ならフォーカスを奪わない', () => {
    const box = document.createElement('input');
    document.body.appendChild(box);
    box.focus();
    mount(vi.fn(), { autoFocus: true });
    expect(document.activeElement).toBe(box);
    box.remove();
  });

  it('並びが変わっても、フォーカスした行とカーソルと Enter で開く行は同じ', () => {
    const onAction = vi.fn();
    const rows = [p3Row('a'), p3Row('b'), p3Row('c')];
    const { rerender } = render(<ActionRoot onAction={onAction}><SessionRows rows={rows} height={400} variant="project" /></ActionRoot>);
    const rowB = screen.getByText('名前 b').closest('[role="row"]') as HTMLElement;
    act(() => rowB.focus());
    rerender(<ActionRoot onAction={onAction}><SessionRows rows={[rows[1]!, rows[0]!, rows[2]!]} height={400} variant="project" /></ActionRoot>);
    const focused = document.activeElement as HTMLElement;
    expect(focused.textContent).toContain('名前 b');
    const marked = screen.getByTestId('session-rows').querySelectorAll('[data-cursor="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(focused);
    fireEvent.keyDown(focused, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.open', id: 'b' });
    expect(onAction).toHaveBeenCalledTimes(1);
    // 並び替えの後の j は、いまの並びで次の行へ進む。
    fireEvent.keyDown(focused, { key: 'j' });
    expect((document.activeElement as HTMLElement).textContent).toContain('名前 a');
  });

  it('autoFocus でも、モーダルのダイアログが開いていればフォーカスを奪わない', () => {
    // 起動時の未解決ダイアログのように、フォーカスがまだダイアログの外（body）にあっても奪わない。
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try {
      mount(vi.fn(), { autoFocus: true });
      expect(document.activeElement).toBe(document.body);
    } finally {
      modal.remove();
    }
  });

  it('autoFocus は、行が後から届いたときに 1 度だけ当てる', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><SessionRows rows={[]} height={400} variant="search" autoFocus /></ActionRoot>);
    expect(document.activeElement).toBe(document.body);
    rerender(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1')]} height={400} variant="search" autoFocus /></ActionRoot>);
    expect(document.activeElement).toBe(screen.getByTestId('session-rows'));
    act(() => (document.activeElement as HTMLElement).blur());
    rerender(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="search" autoFocus /></ActionRoot>);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('SessionRows の本文の期限', () => {
  it('消えかけにはチップ、消えた会話には文字の無い印を出す', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[{ ...row('a'), transcript: 'expiring' }, { ...row('b'), transcript: 'gone' }, { ...row('c'), transcript: 'none' }]} height={400} variant="recent" /></ActionRoot>);
    expect(screen.getByText('まもなく削除')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: '要約のみ。トランスクリプトは Claude Code の保持期間で削除された可能性があります' })).toHaveLength(1);
  });
  it('印は行の高さを持たない', () => {
    for (const sel of ['.row-soon', '.row-gone']) {
      const body = rowsCss.match(new RegExp(`\\${sel} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, sel).not.toMatch(/(^|;)\s*height:/);
    }
  });
});

/** 状態の試験の行。Task 13 の提案の試験も使う。 */
const sr = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null,
  menu: { id, name: '名前 ' + id, status: over.state ?? null, resumeHere: over.resumeHere ?? null, stop: null, moveBlocked: null }, ...over });
const radios = () => screen.getAllByRole('menuitemradio').map((i) => i.querySelector('.menu-item-text > span')?.textContent);
const mount = (rows: SessionRowProps[], onAction = vi.fn()) => {
  render(<ActionRoot onAction={onAction}><SessionRows rows={rows} height={400} variant="project" /></ActionRoot>);
  return onAction;
};
/** 行が開いたか。押した操作の器がクリックを止め損ねると、ここに session.open が積まれる。 */
const opened = (onAction: ReturnType<typeof vi.fn>) => onAction.mock.calls.filter(([i]) => (i as { type: string }).type === 'session.open');
const labels = () => screen.getAllByRole('menuitem').map((i) => i.querySelector('.menu-item-text > span')?.textContent);

describe('セッションの状態の札と「⋯」', () => {
  const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;
  // F1：状態は点の右の固定幅の列に語だけで出し、戻る日は右端の時刻の列に出す。
  it('状態の列に語の札、動きの語は右端、戻る日は時刻の列に描き分ける', () => {
    mount([
      sr('a', { live: 'waiting' }),
      sr('b', { live: 'idle' }),
      sr('c', { state: 'done', setBy: 'conversation', statusTitle: '完了したもの · 会話で承認' }),
      sr('d', { state: 'archived', setBy: 'user' }),
      sr('e', { state: 'paused', returnOn: '2026-09-29', overdueDays: 2, returnDue: true, summaryState: { label: '済んだ', tone: null } }),
      sr('f', { state: 'paused', returnOn: '2026-10-02', overdueDays: null }),
    ]);
    expect(screen.getByText('入力待ち')).toHaveClass('row-live');
    // 「実行中」の語は出さない。動いていることは札の中の点が言う。
    expect(screen.queryByText('実行中')).toBeNull();
    expect(rowOf('名前 b').querySelector('.row-status > .dot')).toHaveAttribute('data-status', 'idle');
    const status = (name: string) => rowOf(name).querySelector('.row-status')!;
    expect(status('名前 c')).toHaveTextContent('Done');
    // 札の説明（と会話で承認したこと）はツールチップで添える。説明は Presenter が決める（statusMark）。
    expect(screen.getByText('Done')).toHaveAttribute('title', '完了したもの · 会話で承認');
    expect(status('名前 d')).toHaveTextContent('Archived');
    expect(screen.getByText('Archived')).not.toHaveAttribute('title');
    expect(status('名前 e')).toHaveTextContent('Paused');
    // 状態の無い行は Active の札を出す。動いている行も止まっている行も同じ札で、動きは札の中の点（と入力待ちの語）が言う。
    expect(status('名前 a')).toHaveTextContent('Active');
    expect(status('名前 a').querySelector('.row-sq')).toHaveAttribute('data-s', 'active');
    expect(status('名前 b').querySelector('.row-sq')).toHaveAttribute('data-s', 'active');
    // 戻る日は時刻の列に出し、今日と過ぎたものだけを塗る。最後の活動はポインタを乗せると読める。
    const when = (name: string) => rowOf(name).querySelector('.row-time')!;
    expect(when('名前 e')).toHaveTextContent('2 日過ぎ');
    expect(screen.getByText('2 日過ぎ')).toHaveAttribute('data-due', 'true');
    expect(screen.getByText('10/2（金）')).not.toHaveAttribute('data-due');
    expect(screen.getByText('10/2（金）')).toHaveAttribute('title', 'リマインダーの日付 · 最終アクティビティ 3 分前');
    expect(when('名前 c')).toHaveTextContent('3 分前');
    // Paused の行も 2 段目の頭は要約の見立てになる。
    expect(rowOf('名前 e').querySelector('.row-sub > .row-state')).toHaveTextContent('済んだ');
  });
  // 自動で付いた Done は、札の頭に ✦ を置き、枠を点線にし、理由はツールチップで言う（2026-10-13 の決定、4a、試作の A）。
  it('自動で付いた Done の札は印と点線の枠で見分け、手で付けた Done には付けない', () => {
    mount([sr('a', { state: 'done', setBy: 'import', autoDone: true, statusTitle: 'hangar が自動で Done にしました（3 ターン以下で止まった会話）' }), sr('b', { state: 'done', setBy: 'user', statusTitle: '完了したもの' })]);
    const auto = rowOf('名前 a').querySelector('.row-sq')!;
    expect(auto).toHaveAttribute('data-auto', 'true');
    expect(auto).toHaveTextContent('Done');
    expect(auto.querySelector('.icon')).toHaveAttribute('data-icon', 'autoMark');
    expect(auto).toHaveAttribute('title', 'hangar が自動で Done にしました（3 ターン以下で止まった会話）');
    const manual = rowOf('名前 b').querySelector('.row-sq')!;
    expect(manual).not.toHaveAttribute('data-auto');
    expect(manual.querySelector('.icon')).toBeNull();
    expect(rowsCss).toMatch(/\.row-sq\[data-auto\] \{[^}]*dashed/);
  });
  it('戻る日が無い Paused の行は、時刻の列に塗りの「日付なし」を出す', () => {
    mount([sr('a', { state: 'paused', returnOn: null, overdueDays: null, returnDue: true })]);
    expect(rowOf('名前 a').querySelector('.row-time')).toHaveTextContent('日付なし');
    expect(screen.getByText('日付なし')).toHaveAttribute('data-due', 'true');
  });
  it('提案のある行は Active の札ではなく提案の札を出す', () => {
    mount([sr('a', { candidate: { status: 'done', note: '直した', returnOn: null, returnTime: null, source: 'in_session', ago: '1 時間前' } })]);
    const col = rowOf('名前 a').querySelector('.row-status')!;
    expect(col.querySelector('.row-sq')).toBeNull();
    expect(col).toHaveTextContent('Done？');
  });
  it('Active の札はプロジェクトの Active と同じ青で、地を塗る', () => {
    expect(rowsCss).toMatch(/\.row-sq\[data-s='active'\] \{[^}]*color: var\(--st-active\);[^}]*background: var\(--st-active-soft\);/);
  });
  it('statusColumn が偽なら状態の列を畳み、点は行の頭に置く', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[sr('a', { state: 'done', live: 'busy' })]} height={400} variant="search" statusColumn={false} /></ActionRoot>);
    expect(screen.getByTestId('session-rows')).toHaveAttribute('data-status-col', 'false');
    expect(rowOf('名前 a').querySelector('.row-status')).toBeNull();
    expect(screen.queryByText('Done')).toBeNull();
    expect(rowOf('名前 a').querySelector(':scope > .dot')).toHaveAttribute('data-status', 'busy');
  });
  it('状態の列があれば、点は札の中に畳み、動いていない行には点を置かない', () => {
    mount([sr('a', { live: 'busy' }), sr('b', { state: 'done' }), sr('c', { live: 'waiting', candidate: { status: 'done', note: null, returnOn: null, returnTime: null, source: 'post_hoc', ago: '1 分前' } })]);
    for (const name of ['名前 a', '名前 b', '名前 c']) expect(rowOf(name).querySelector(':scope > .dot'), name).toBeNull();
    const a = rowOf('名前 a').querySelector('.row-status')!;
    expect(a).toHaveAttribute('data-live', 'busy');
    expect(a.querySelector('.dot')).toHaveAttribute('data-status', 'busy');
    expect(a).toHaveTextContent('Active');
    expect(rowOf('名前 b').querySelector('.row-status')).not.toHaveAttribute('data-live');
    expect(rowOf('名前 b').querySelector('.row-status .dot')).toBeNull();
    // 提案の札の行も、点は札の中に置く。
    expect(rowOf('名前 c').querySelector('.row-status > .dot')).toHaveAttribute('data-status', 'waiting');
  });
  it('札の中の点は脈打たない（止まらない動きは GPU を動かし続ける）', () => {
    expect(rowsCss).not.toContain('live-pulse');
  });
  it('状態の列は 72px（点はその札の中）、時刻の列は 72px の右寄せで、行ごとにずれない', () => {
    expect(rowsCss).toMatch(/\.rows-host\[data-status-col='true'\] \.row-2 \{[^}]*grid-template-columns: 72px minmax\(0, 1fr\) auto;/);
    expect(rowsCss).toMatch(/\.row-time \{[^}]*justify-content: flex-end;[^}]*width: 72px;/);
  });
  it('「⋯」からセッションのメニュー（1A）を開き、状態を選ぶ。押しても行は開かない', () => {
    const onAction = mount([sr('a')]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a のメニュー' }));
    expect(radios()).toEqual(['Active', 'Paused', 'Done', 'Archived']);
    expect(screen.getAllByRole('menuitemradio').map((i) => i.querySelector('kbd')?.textContent)).toEqual(['u', 'p', 'd', 'a']);
    expect(labels()).toEqual(['右に分割して開く', '下に分割して開く', 'プロジェクトを変更…', 'セッション ID をコピー', '削除…']);
    fireEvent.click(screen.getAllByRole('menuitemradio')[2]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: 'done' });
    expect(opened(onAction)).toEqual([]);
  });
  it('ほかの PC の会話の「⋯」には、先頭に「この PC で再開」を置き、押せないときは理由を添える', () => {
    mount([sr('c')]);
    fireEvent.click(screen.getByRole('button', { name: '名前 c のメニュー' }));
    expect(labels()).not.toContain('この PC で再開');
    cleanup();
    const onAction = mount([sr('a', { resumeHere: { disabled: null } }), sr('b', { resumeHere: { disabled: 'この PC にこのプロジェクトのフォルダがありません。先に場所を指定してください。' } })]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a のメニュー' }));
    expect(labels()).toEqual(['この PC で再開', '右に分割して開く', '下に分割して開く', 'プロジェクトを変更…', 'セッション ID をコピー', '削除…']);
    fireEvent.click(screen.getAllByRole('menuitem')[0]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.resumeHere.open', id: 'a' });
    expect(opened(onAction)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '名前 b のメニュー' }));
    const blocked = screen.getAllByRole('menuitem')[0]!;
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveTextContent('この PC にこのプロジェクトのフォルダがありません。先に場所を指定してください。');
  });
  it('いまの状態に ✓ を付け、選び直しても何も送らない。ほかの状態と Active へは移れる', () => {
    const onAction = mount([sr('a', { state: 'done' }), sr('b')]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a のメニュー' }));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
    fireEvent.click(items[2]!);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '名前 a のメニュー' }));
    fireEvent.click(screen.getAllByRole('menuitemradio')[0]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: null });
    fireEvent.click(screen.getByRole('button', { name: '名前 b のメニュー' }));
    expect(screen.getAllByRole('menuitemradio')[0]).toHaveAttribute('aria-checked', 'true');
  });
  it('打鍵 . でカーソルの行の「⋯」を開き、印の 1 字で選ぶ', () => {
    const onAction = mount([sr('a'), sr('b', { state: 'done' })]);
    const rb = screen.getByText('名前 b').closest('[role="row"]') as HTMLElement;
    act(() => rb.focus());
    fireEvent.keyDown(rb, { key: '.' });
    expect(screen.getByRole('menu', { name: '名前 b のメニュー' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'p' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.pause.open', id: 'b', from: 'menu' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(opened(onAction)).toEqual([]);
  });
  it('「⋯」はポインタを乗せた行、カーソルの行、焦点のある行、開いている間だけ見せる', () => {
    expect(rowsCss).toMatch(/\.row-more \{[^}]*visibility: hidden;/);
    expect(rowsCss).toMatch(/\.row:hover \.row-more, \.row:focus-within \.row-more, \.row\[data-cursor='true'\] \.row-more, \.row-more:has\(\[aria-expanded='true'\]\) \{[^}]*visibility: visible;/);
  });
  // 裁定 B：打鍵 . で開いたメニューを閉じたら、フォーカスを行へ戻す。戻さないと、一覧は行以外から来た打鍵を捨てるので j・Enter・2 回目の . が効かなくなる。
  it('打鍵 . → d のあと、フォーカスが行へ戻り、j でカーソルが動く', () => {
    const onAction = mount([sr('a'), sr('b')]);
    const ra = screen.getByText('名前 a').closest('[role="row"]') as HTMLElement;
    act(() => ra.focus());
    fireEvent.keyDown(ra, { key: '.' });
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: 'done' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(ra);
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(screen.getByText('名前 b').closest('[role="row"]')).toHaveAttribute('data-cursor', 'true');
  });
  it('打鍵 . で開いたメニューを Esc で閉じても、フォーカスは行へ戻る', () => {
    mount([sr('a'), sr('b')]);
    const ra = screen.getByText('名前 a').closest('[role="row"]') as HTMLElement;
    act(() => ra.focus());
    fireEvent.keyDown(ra, { key: '.' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(ra);
    fireEvent.keyDown(ra, { key: '.' });
    expect(screen.getByRole('menu', { name: '名前 a のメニュー' })).toBeInTheDocument();
  });
});

describe('提案の札とポップ（Q3＋Q1）', () => {
  const cand = { status: 'paused' as const, note: '明日の朝、CPU の数字を確かめる', returnOn: '2026-10-02', returnTime: null, source: 'exit' as const, ago: '12 分前' };
  it('枠だけの札を押すと根拠・出どころ・時刻のポップが開き、確定・日を変える・却下を選べる。行は開かない', () => {
    const onAction = mount([sr('a', { candidate: cand })]);
    // 札は状態の列に短い語で置き、言い切りはポインタを乗せると読める（F1）。
    const face = screen.getByRole('button', { name: 'Paused？' });
    expect(face).toHaveClass('row-cand');
    expect(face).toHaveAttribute('title', 'Paused · 10/2（金）？');
    expect(face.closest('.row-status')).not.toBeNull();
    fireEvent.click(face);
    const menu = screen.getByRole('menu', { name: '名前 a への Claude の提案' });
    expect(menu).toHaveTextContent('Paused · 10/2（金） にしますか');
    expect(menu).toHaveTextContent('明日の朝、CPU の数字を確かめる');
    expect(menu).toHaveTextContent('終了時 · 12 分前');
    expect(menu).not.toHaveTextContent('提案元');
    expect(labels()).toEqual(['確定', '日付を変更', '却下']);
    // 頭の段にはフォーカスが止まらず、確定から始まる。
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    fireEvent.click(screen.getAllByRole('menuitem')[1]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.pause.open', id: 'a', from: 'candidate' });
    expect(opened(onAction)).toEqual([]);
  });
  it('Done の提案には「日を変える」が無く、y で確定、n で却下する', () => {
    const onAction = mount([sr('a', { candidate: { ...cand, status: 'done', returnOn: null } })]);
    const face = screen.getByRole('button', { name: 'Done？' });
    fireEvent.click(face);
    expect(labels()).toEqual(['確定', '却下']);
    fireEvent.keyDown(document.activeElement!, { key: 'y' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.confirm', id: 'a' });
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'n' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.reject', id: 'a' });
    expect(opened(onAction)).toEqual([]);
  });
  it('根拠の無い提案は、根拠の行ごと出さない', () => {
    mount([sr('a', { candidate: { ...cand, note: null } })]);
    fireEvent.click(screen.getByRole('button', { name: 'Paused？' }));
    const menu = screen.getByRole('menu');
    expect(menu).not.toHaveTextContent('根拠はありません');
    expect(menu).toHaveTextContent(/にしますか終了時 · 12 分前/);
  });
  it.each([['y', 'session.state.confirm'], ['n', 'session.state.reject']])('札から Enter で開いて %s で選び、札が消えても、フォーカスは行に残る', (key, type) => {
    const onAction = vi.fn();
    const ui = (rows: SessionRowProps[]) => <ActionRoot onAction={onAction}><SessionRows rows={rows} height={400} variant="project" /></ActionRoot>;
    const { rerender } = render(ui([sr('a', { candidate: cand })]));
    const face = screen.getByRole('button', { name: 'Paused？' });
    act(() => face.focus());
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key });
    expect(onAction).toHaveBeenCalledWith({ type, id: 'a' });
    // session.upsert で candidate が消え、札がアンマウントされる。
    rerender(ui([sr('a')]));
    expect(document.activeElement).toBe(screen.getByRole('row'));
  });
});

describe('スマホから起動した新しい行の動き（試作 F1）', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[] }[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens({ '--dur-fast': '200ms', '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' }, { everywhere: true });
    animations = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
      animations.push({ el: this, frames });
      return { finished: new Promise<void>(() => {}), cancel: vi.fn() };
    };
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    cleanup();
  });
  const phone = { label: 'スマホから', title: 'スマホから起動したセッション', bypass: false };
  const ui = (rows: SessionRowProps[]) => <ActionRoot onAction={() => {}}><SessionRows rows={rows} height={400} variant="recent" scope="home" /></ActionRoot>;
  const rowOf = (id: string) => screen.getByText('n' + id).closest('[role="row"]');

  it('一覧に新しく入ったスマホからの行は growIn で伸びて入る。PC で起こした新しい行は今までどおり淡い黄の印だけ', () => {
    const { rerender } = render(ui([row('a'), row('b')]));
    expect(animations).toHaveLength(0);
    rerender(ui([{ ...row('p'), phone }, row('n'), row('a'), row('b')]));
    const grown = animations.filter((x) => x.el === rowOf('p'));
    expect(grown).toHaveLength(1);
    expect(grown[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    expect(rowOf('p')).not.toHaveAttribute('data-hit');
    expect(animations.filter((x) => x.el === rowOf('n'))).toHaveLength(0);
    expect(rowOf('n')).toHaveAttribute('data-hit');
  });

  it('最初の描画と一覧の切替（scope）では、スマホからの行も動かさない', () => {
    render(ui([{ ...row('p'), phone }, row('a')]));
    expect(animations).toHaveLength(0);
  });
});

describe('⌥クリックで右に分割して開く（一覧の行）', () => {
  it('⌥ を押しながら行を押すと pane.open（右）を出し、session.open は出さない。ふつうに押すと session.open', () => {
    const onAction = mount([sr('a')]);
    const row = document.querySelector<HTMLElement>('[role="row"]')!;
    fireEvent.click(row, { altKey: true });
    expect(onAction).toHaveBeenCalledWith({ type: 'pane.open', sessionId: 'a', target: null, side: 'right' });
    expect(opened(onAction)).toEqual([]);
    onAction.mockClear();
    fireEvent.click(row);
    expect(opened(onAction)).toHaveLength(1);
  });
});
