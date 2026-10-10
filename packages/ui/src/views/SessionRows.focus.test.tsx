import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { SessionRows } from './SessionRows.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const ROWS = [row('a'), row('b'), row('c'), row('d')];
const mount = (rows: SessionRowProps[] = ROWS, onAction = vi.fn()) => ({ ...render(<ActionRoot onAction={onAction}><SessionRows rows={rows} height={400} variant="project" /></ActionRoot>), onAction });
const rowsOf = () => [...screen.getByTestId('session-rows').querySelectorAll<HTMLElement>('[role="row"]')];
const list = () => screen.getByTestId('session-rows');

describe('SessionRows の打鍵と行の印', () => {
  it('j と k は行を動き、Enter でカーソルの行を開く', () => {
    const { onAction } = mount();
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'b' });
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'd' });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(list(), { key: 'k' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a' });
  });
  it('Tab で止まるのは先頭の行だけ', () => {
    mount();
    expect(rowsOf().map((x) => x.tabIndex)).toEqual([0, -1, -1, -1]);
  });
  // 選んでいた行が絞り込みで消えると、見えない行が Enter で開いてしまう。
  it('選んでいた行が一覧から消えたら、未選択に戻る', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><SessionRows rows={ROWS} height={400} variant="project" /></ActionRoot>);
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'j' });
    rerender(<ActionRoot onAction={onAction}><SessionRows rows={[row('a'), row('c'), row('d')]} height={400} variant="project" /></ActionRoot>);
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.keyDown(list(), { key: 'j' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 'a' });
  });
  it('見出しは持たない。行だけを並べる', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[row('x')]} height={400} variant="recent" /></ActionRoot>);
    expect(rowsOf()).toHaveLength(1);
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('Archived の行に印を付ける', () => {
    mount([row('z', { state: 'archived' }), row('y')]);
    expect(rowsOf().map((x) => x.getAttribute('data-archived'))).toEqual(['true', null]);
  });
  it('project の変種は、行にプロジェクト名とモデルとコストと鉛筆を出さず、PR の番号とノートの印は出す', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[row('p', { model: 'opus', cost: '$1.00', filesChanged: 3, prUrl: 'https://github.com/o/r/pull/88', memo: '覚書' })]} height={400} variant="project" /></ActionRoot>);
    const r = rowsOf()[0]!;
    expect(r.querySelector('.row-proj')).toBeNull();
    expect(r.querySelector('.row-meta')).toBeNull();
    expect(r.querySelector('.memo-pencil')).toBeNull();
    expect(r).not.toHaveTextContent('$1.00');
    expect(r.querySelector('.row-pr')).toHaveTextContent('88');
    expect(r.querySelector('.row-note')).not.toBeNull();
  });
});

describe('SessionRows の状態の札（★ の E）', () => {
  it('badgeAction があれば、状態の札がそのタブへ移るボタンになり、行は開かない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[row('d1', { state: 'done' }), row('a1', { state: 'archived' }), row('p1', { state: 'paused', returnOn: '2026-10-09' })]} height={400} variant="search" badgeAction={(status) => ({ type: 'search.filter', patch: { status } })} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'Done のセッションだけを見る' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Archived のセッションだけを見る' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'archived' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paused のセッションだけを見る' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'paused' } });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('badgeAction が無ければ札は押せない', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[row('d1', { state: 'done' })]} height={400} variant="project" /></ActionRoot>);
    expect(screen.queryByRole('button', { name: /のセッションだけを見る$/ })).toBeNull();
  });
  // F1：Paused も状態の列に語の札で出すので、その札がタブへ移るボタンになる（戻る日は時刻の列で、ボタンではない）。
  it('Paused の札も、Paused のタブへ移るボタンになる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><SessionRows rows={[row('p1', { state: 'paused', returnOn: null })]} height={400} variant="search" badgeAction={(status) => ({ type: 'search.filter', patch: { status } })} /></ActionRoot>);
    const b = screen.getByRole('button', { name: 'Paused のセッションだけを見る' });
    expect(b).toHaveTextContent('Paused');
    fireEvent.click(b);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'search.filter', patch: { status: 'paused' } });
  });
});

// 裁定 2B：フォーカスのあった行が一覧から消えたり、DOM が作り直されたりしても、フォーカスを body に落とさない。
// 一覧の打鍵は器が受けるので、body に落ちると j・Enter・. が効かなくなる。
describe('SessionRows のフォーカスの拾い直し（裁定 2B）', () => {
  const ui = (rows: SessionRowProps[], onAction = vi.fn()) => <ActionRoot onAction={onAction}><SessionRows rows={rows} height={400} variant="project" /></ActionRoot>;
  const rowOf = (name: string) => screen.getByText(name).closest<HTMLElement>('[role="row"]')!;
  const without = (id: string) => ROWS.filter((r) => r.id !== id);

  it('打鍵 . → a で行が絞り込みから外れて消えても、j が効く', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(ROWS, onAction));
    act(() => rowOf('nb').focus());
    fireEvent.keyDown(rowOf('nb'), { key: '.' });
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.state.set', id: 'b', status: 'archived' });
    // session.upsert で行が Archived になり、「すべて」の一覧から外れる。
    rerender(ui(without('b'), onAction));
    expect(document.activeElement).toBe(list());
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(rowOf('na')).toHaveAttribute('data-cursor', 'true');
    expect(document.activeElement).toBe(rowOf('na'));
  });

  it('打鍵 . → d で行の状態が変わって DOM が並び替わっても、フォーカスとカーソルはその行に残る', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(ROWS, onAction));
    act(() => rowOf('nb').focus());
    fireEvent.keyDown(rowOf('nb'), { key: '.' });
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    rerender(ui([row('a'), row('c'), row('b', { state: 'done' }), row('d')], onAction));
    expect(document.activeElement).toBe(rowOf('nb'));
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(document.activeElement).toBe(rowOf('nd'));
  });

  it('ダイアログを閉じたときに開いた元の行が消えていたら、一覧がフォーカスを拾う', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(ROWS, onAction));
    act(() => rowOf('nb').focus());
    // Paused のダイアログが開き、フォーカスがその欄へ移る。
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const field = document.createElement('input');
    dialog.appendChild(field);
    document.body.appendChild(dialog);
    act(() => field.focus());
    // ダイアログが開いている間に行が消えても、ダイアログのフォーカスは奪わない。
    rerender(ui(without('b'), onAction));
    expect(document.activeElement).toBe(field);
    // ダイアログが閉じる。開いた元の行は DOM に無いので、Dialog はフォーカスを返せず body に落ちる。
    act(() => dialog.remove());
    expect(document.activeElement).toBe(document.body);
    rerender(ui(without('b'), onAction));
    expect(document.activeElement).toBe(list());
    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(document.activeElement).toBe(rowOf('na'));
  });

  it('利用者が一覧の外へフォーカスを外したら、描き直しでも奪い返さない', () => {
    const { rerender } = render(ui(ROWS));
    act(() => rowOf('nb').focus());
    act(() => rowOf('nb').blur());
    expect(document.activeElement).toBe(document.body);
    rerender(ui(without('b')));
    expect(document.activeElement).toBe(document.body);
  });
  // 外の欄の blur は一覧の React の木の外で起きるので、一覧は 2 段目の外し方を知らない。1 段目で忘れておく。
  it('行から一覧の外の入力欄へ移り、そこから body へ外したら、関係のない描き直しでも奪い返さない', () => {
    const { rerender } = render(ui(ROWS));
    const box = document.createElement('input');
    document.body.appendChild(box);
    try {
      act(() => rowOf('nb').focus());
      act(() => box.focus());
      // Root の Esc（欄を離れる打鍵）が el.blur() で body へ落とす。
      act(() => box.blur());
      expect(document.activeElement).toBe(document.body);
      rerender(ui(ROWS));
      expect(document.activeElement).toBe(document.body);
      rerender(ui(without('b')));
      expect(document.activeElement).toBe(document.body);
    } finally {
      box.remove();
    }
  });
});
