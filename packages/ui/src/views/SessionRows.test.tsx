import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { SessionRows } from './SessionRows.tsx';
import { existsSync, readFileSync } from 'node:fs';

// dom の project では import.meta.url が file にならず、?raw も空文字になるので、cwd から辿って読む。
const rowsCssPath = ['packages/ui/src/styles/rows.css', 'src/styles/rows.css'].map((r) => `${process.cwd()}/${r}`).find(existsSync);
const rowsCss = readFileSync(rowsCssPath!, 'utf8');

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: id === 'a' ? 'busy' : null, aside: false, stateLabel: '完了', summaryState: null, model: 'fable 5.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 2, prUrl: 'https://x/pull/1', memo: null, hasTranscript: true, cost: '', runId: null, transcript: 'present', state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null });

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
  it('行はセッションの id を、広がる元の印に持つ', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><SessionRows rows={[row('a'), row('b')]} height={400} variant="recent" /></ActionRoot>);
    expect([...container.querySelectorAll('.row-2')].map((r) => r.getAttribute('data-morph-id'))).toEqual(['a', 'b']);
  });
});

const p3Row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({
  id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, aside: false, stateLabel: '完了', summaryState: null, model: 'opus 4.1', effort: 'high',
  when: '1 時間前', whenAbs: '2026-09-18 11:00', filesChanged: 2, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '$0.50', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over,
});

describe('SessionRows のフェーズ 3', () => {
  it('プロジェクトの画面の行は、コストとメモの本文を出さない（ノートは印だけ。編集は帯とセッションの冒頭にある）', () => {
    render(<ActionRoot onAction={() => {}}><SessionRows rows={[p3Row('s1', { memo: '覚書' })]} height={400} variant="project" /></ActionRoot>);
    expect(screen.queryByText('$0.50')).toBeNull();
    expect(screen.queryByText('✎ 覚書')).toBeNull();
    expect(screen.queryByLabelText('名前 s1 のノートを編集')).toBeNull();
    expect(document.querySelector('.row-note')).not.toBeNull();
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
    expect(screen.queryByLabelText('名前 s1 のノート')).toBeNull();
  });
  it('m でメモの入力欄に変わり、Enter で保存、Esc で捨てる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1', { memo: '前' })]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    const input = screen.getByLabelText('名前 s1 のノート') as HTMLInputElement;
    expect(input.value).toBe('前');
    fireEvent.change(input, { target: { value: '後' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '後' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('名前 s1 のノート')).toBeNull();
    onAction.mockClear();
    fireEvent.keyDown(list, { key: 'm' });
    fireEvent.change(screen.getByLabelText('名前 s1 のノート'), { target: { value: '捨てる' } });
    fireEvent.keyDown(screen.getByLabelText('名前 s1 のノート'), { key: 'Escape' });
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('名前 s1 のノート')).toBeNull();
  });
  it('編集中の入力欄では j と k を横取りしない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1'), p3Row('s2')]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    const input = screen.getByLabelText('名前 s1 のノート') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'jk' } });
    fireEvent.keyDown(input, { key: 'j' });
    fireEvent.keyDown(input, { key: 'k' });
    // カーソルは動かず、入力欄も開いたまま。
    expect(screen.getByLabelText('名前 s1 のノート')).toBe(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: 'jk' });
  });
  it('入力欄から焦点が外れたら編集を閉じ、何も出さない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[p3Row('s1', { memo: '前' })]} height={400} variant="project" /></ActionRoot>);
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    const input = screen.getByLabelText('名前 s1 のノート');
    fireEvent.change(input, { target: { value: '書きかけ' } });
    fireEvent.blur(input);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('名前 s1 のノート')).toBeNull();
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
  const r = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, aside: false, stateLabel: '完了', summaryState: null, model: 'opus 4.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 6, prUrl: 'https://github.com/x/y/pull/1', memo: 'スワイプは実機で', hasTranscript: true, transcript: 'present', cost: '$1.82', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
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
  it('プロジェクトの画面の行は、右に時刻、2 段目に要約と PR の番号とノートの印だけを出す。モデル、変更の数、コストは出さない', () => {
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
  it('m のメモの編集は、プロジェクト詳細でなくても 2 段目で開く', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[r('a')]} height={400} variant="recent" /></ActionRoot>);
    const host = screen.getByTestId('session-rows');
    fireEvent.keyDown(host, { key: 'j' });
    fireEvent.keyDown(host, { key: 'm' });
    const input = screen.getByLabelText('名前 a のノート');
    fireEvent.change(input, { target: { value: '新' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.setMemo', id: 'a', text: '新' });
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
    const more = screen.getByLabelText('名前 s1 のステータス');
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

  it('メモを Enter で保存したら、フォーカスは行に戻る', () => {
    mount();
    const list = screen.getByTestId('session-rows');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'm' });
    fireEvent.keyDown(screen.getByLabelText('名前 s1 のノート'), { key: 'Enter' });
    expect(document.activeElement).toBe(rowsOf()[0]);
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
    expect(screen.getAllByRole('img', { name: '要約のみ。トランスクリプトは Claude Code の保持期間で削除されたとみられます' })).toHaveLength(1);
  });
  it('印は行の高さを持たない', () => {
    for (const sel of ['.row-soon', '.row-gone']) {
      const body = rowsCss.match(new RegExp(`\\${sel} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, sel).not.toMatch(/(^|;)\s*height:/);
    }
  });
});

/** 状態の試験の行。Task 13 の提案の試験も使う。 */
const sr = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
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
      sr('c', { state: 'done', setBy: 'conversation' }),
      sr('d', { state: 'archived', setBy: 'user' }),
      sr('e', { state: 'paused', returnOn: '2026-09-29', overdueDays: 2, returnDue: true, summaryState: { label: '済んだ', tone: null } }),
      sr('f', { state: 'paused', returnOn: '2026-10-02', overdueDays: null }),
    ]);
    expect(screen.getByText('入力待ち')).toHaveClass('row-live');
    expect(screen.getByText('実行中')).toHaveAttribute('data-live', 'busy');
    const status = (name: string) => rowOf(name).querySelector('.row-status')!;
    expect(status('名前 c')).toHaveTextContent('Done');
    expect(screen.getByText('Done')).toHaveAttribute('title', '会話で承認');
    expect(status('名前 d')).toHaveTextContent('Archived');
    expect(screen.getByText('Archived')).not.toHaveAttribute('title');
    expect(status('名前 e')).toHaveTextContent('Paused');
    // 状態の無い行は Active の札を出す。動いている行も止まっている行も同じ札で、動きは点と右の語が言う。
    expect(status('名前 a')).toHaveTextContent('Active');
    expect(status('名前 a').querySelector('.row-sq')).toHaveAttribute('data-s', 'active');
    expect(status('名前 b').querySelector('.row-sq')).toHaveAttribute('data-s', 'active');
    // 戻る日は時刻の列に出し、今日と過ぎたものだけを塗る。最後の活動はポインタを乗せると読める。
    const when = (name: string) => rowOf(name).querySelector('.row-time')!;
    expect(when('名前 e')).toHaveTextContent('2 日過ぎ');
    expect(screen.getByText('2 日過ぎ')).toHaveAttribute('data-due', 'true');
    expect(screen.getByText('10/2（金）')).not.toHaveAttribute('data-due');
    expect(screen.getByText('10/2（金）')).toHaveAttribute('title', 'リマインダーの日付 · 最後の活動 3 分前');
    expect(when('名前 c')).toHaveTextContent('3 分前');
    // Paused の行も 2 段目の頭は要約の見立てになる。
    expect(rowOf('名前 e').querySelector('.row-sub > .row-state')).toHaveTextContent('済んだ');
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
  it('statusColumn が偽なら状態の列を畳む', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[sr('a', { state: 'done' })]} height={400} variant="search" statusColumn={false} /></ActionRoot>);
    expect(screen.getByTestId('session-rows')).toHaveAttribute('data-status-col', 'false');
    expect(rowOf('名前 a').querySelector('.row-status')).toBeNull();
    expect(screen.queryByText('Done')).toBeNull();
  });
  it('状態の列は 62px、時刻の列は 72px の右寄せで、行ごとにずれない', () => {
    expect(rowsCss).toMatch(/\.rows-host\[data-status-col='true'\] \.row-2 \{[^}]*grid-template-columns: 16px 62px minmax\(0, 1fr\) auto;/);
    expect(rowsCss).toMatch(/\.row-time \{[^}]*justify-content: flex-end;[^}]*width: 72px;/);
  });
  it('「⋯」から 4 択を選ぶ。押しても行は開かない', () => {
    const onAction = mount([sr('a')]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a のステータス' }));
    expect(labels()).toEqual(['Paused にする…', 'Done にする', 'Archived にする', 'Active に戻す']);
    expect(screen.getAllByRole('menuitem').map((i) => i.querySelector('kbd')?.textContent)).toEqual(['p', 'd', 'a', 'u']);
    expect(screen.getAllByRole('menuitem')[3]).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getAllByRole('menuitem')[1]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: 'done' });
    expect(opened(onAction)).toEqual([]);
  });
  it('付いている状態は選べず、Active に戻すは選べる。Active の行では「すでに Active です」と添えて押せない', () => {
    const onAction = mount([sr('a', { state: 'done' }), sr('b')]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a のステータス' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    expect(items[1]).toHaveTextContent('すでに Done です');
    fireEvent.click(items[3]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: null });
    fireEvent.click(screen.getByRole('button', { name: '名前 b のステータス' }));
    const last = screen.getAllByRole('menuitem')[3]!;
    expect(last).toHaveAttribute('aria-disabled', 'true');
    expect(last).toHaveTextContent('すでに Active です');
  });
  it('打鍵 . でカーソルの行の「⋯」を開き、印の 1 字で選ぶ', () => {
    const onAction = mount([sr('a'), sr('b', { state: 'done' })]);
    const rb = screen.getByText('名前 b').closest('[role="row"]') as HTMLElement;
    act(() => rb.focus());
    fireEvent.keyDown(rb, { key: '.' });
    expect(screen.getByRole('menu', { name: '名前 b のステータス' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'p' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.pause.open', id: 'b', from: 'menu' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(opened(onAction)).toEqual([]);
  });
  it('メモを書いている欄の . は文字で、メニューを開かない', () => {
    mount([sr('a')]);
    const ra = screen.getByText('名前 a').closest('[role="row"]') as HTMLElement;
    act(() => ra.focus());
    fireEvent.keyDown(ra, { key: 'm' });
    fireEvent.keyDown(screen.getByLabelText('名前 a のノート'), { key: '.' });
    expect(screen.queryByRole('menu')).toBeNull();
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
    expect(screen.getByRole('menu', { name: '名前 a のステータス' })).toBeInTheDocument();
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
    expect(menu).toHaveTextContent('出どころ：抜けるとき · 12 分前');
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
  it('根拠の無い提案は「根拠は書かれていません」と出す', () => {
    mount([sr('a', { candidate: { ...cand, note: null } })]);
    fireEvent.click(screen.getByRole('button', { name: 'Paused？' }));
    expect(screen.getByRole('menu')).toHaveTextContent('根拠は書かれていません');
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
