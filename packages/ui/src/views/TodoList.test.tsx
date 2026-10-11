import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { TodoItemProps, TodoSuggestionProps } from '../presenters/project.ts';
import { TodoList } from './TodoList.tsx';

const item = (id: string, text: string, o: Partial<TodoItemProps> = {}): TodoItemProps => ({ id, text, done: false, position: 1, candidate: null, ...o });
const sugg = (id: string, text: string, o: Partial<TodoSuggestionProps> = {}): TodoSuggestionProps => ({ id, text, note: '理由', sessionId: 's1', sessionName: '計測', ago: '1 分前', ...o });
type Lists = { todos?: TodoItemProps[]; done?: TodoItemProps[]; suggestions?: TodoSuggestionProps[] };
function list(o: Lists = {}, onAction = vi.fn()) {
  const node = (p: Lists) => <ActionRoot onAction={onAction}><TodoList projectId="p1" todos={p.todos ?? []} done={p.done ?? []} suggestions={p.suggestions ?? []} /></ActionRoot>;
  const r = render(node(o));
  return { onAction, rerender: (p: Lists) => r.rerender(node(p)) };
}
const row = (text: string) => screen.getByText(text).closest('li') as HTMLElement;

describe('TodoList', () => {
  it('末尾の「TODO を足す」を押すと入力欄になり、Enter で足して欄に残る。Esc で抜ける', () => {
    const { onAction } = list({ todos: [item('t1', '買う')] });
    fireEvent.click(screen.getByRole('button', { name: 'TODO を足す' }));
    const input = screen.getByLabelText('TODO を追加');
    expect(input.getAttribute('id')).toBe('todo-input');
    fireEvent.change(input, { target: { value: '書く' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.add', projectId: 'p1', text: '書く' });
    expect((screen.getByLabelText('TODO を追加') as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(screen.getByLabelText('TODO を追加'), { key: 'Escape' });
    expect(screen.queryByLabelText('TODO を追加')).toBeNull();
  });

  it('空の入力と、日本語の変換中の Enter では足さない', () => {
    const { onAction } = list();
    fireEvent.click(screen.getByRole('button', { name: 'TODO を足す' }));
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'かう' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('何も無いときは、空であることを書く', () => {
    list();
    expect(screen.getByText('TODO はまだありません')).toBeTruthy();
  });

  it('済みの印は checkbox の役割で、押すと反転の UiAction を出す。同じ文言でもラベルが重ならない', () => {
    const { onAction } = list({ todos: [item('t1', '買う'), item('t2', '買う', { position: 2 })] });
    expect(screen.getByRole('checkbox', { name: '買う（1 件目）' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('checkbox', { name: '買う（2 件目）' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't2' });
  });

  it('完了にした行は、少しの間もとの場所に済みの形で残ってから、下の「完了」へ移る', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = list({ todos: [item('t1', '買う'), item('t2', '書く', { position: 2 })] });
      fireEvent.click(screen.getByRole('checkbox', { name: '買う（1 件目）' }));
      // サーバの知らせで完了の側へ移っても、すぐには動かさない。
      rerender({ todos: [item('t2', '書く', { position: 2 })], done: [item('t1', '買う', { done: true })] });
      expect(screen.getByRole('checkbox', { name: '買う（1 件目）' })).toHaveAttribute('aria-checked', 'true');
      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.queryByText('買う')).toBeNull();
      expect(screen.getByRole('button', { name: /完了/ })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('「完了」は畳んで始まり、押すと開いて、丸で未完に戻せる', () => {
    const { onAction } = list({ done: [item('d1', '済んだ', { done: true })] });
    expect(screen.queryByText('済んだ')).toBeNull();
    const head = screen.getByRole('button', { name: /完了/ });
    expect(head.textContent).toContain('1');
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: '済んだ（1 件目）' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.toggle', id: 'd1' });
  });

  it('ダブルクリックで直す。Enter で確定、Esc で戻す、空にして確定すると消す', () => {
    const { onAction } = list({ todos: [item('t1', '買う')] });
    fireEvent.doubleClick(screen.getByText('買う'));
    let box = screen.getByLabelText('買う（1 件目）を直す');
    fireEvent.change(box, { target: { value: '牛乳を買う' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.edit', id: 't1', text: '牛乳を買う' });
    // サーバの知らせが届くまでは、直した文言を出しておく。
    fireEvent.doubleClick(screen.getByText('牛乳を買う'));
    box = screen.getByLabelText(/を直す/);
    fireEvent.change(box, { target: { value: 'ちがう' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(screen.getByText('牛乳を買う'));
    box = screen.getByLabelText(/を直す/);
    fireEvent.change(box, { target: { value: '  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.remove', id: 't1' });
  });

  it('変換中の Enter では確定しない', () => {
    const { onAction } = list({ todos: [item('t1', '買う')] });
    fireEvent.doubleClick(screen.getByText('買う'));
    const box = screen.getByLabelText('買う（1 件目）を直す');
    fireEvent.change(box, { target: { value: 'かう' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('消すと、その場に「元に戻す」の帯が出て、押すとその TODO の削除を戻す', () => {
    const { onAction, rerender } = list({ todos: [item('t1', '買う'), item('t2', '書く', { position: 2 })] });
    fireEvent.click(screen.getByRole('button', { name: '買う（1 件目）を削除' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.remove', id: 't1' });
    rerender({ todos: [item('t2', '書く', { position: 2 })] });
    expect(screen.getByText('「買う」を消しました')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '「買う」を元に戻す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.undo', projectId: 'p1', todoId: 't1' });
    expect(screen.queryByText('「買う」を消しました')).toBeNull();
  });

  it('消した帯は、しばらくすると畳む', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = list({ todos: [item('t1', '買う')] });
      fireEvent.click(screen.getByRole('button', { name: '買う（1 件目）を削除' }));
      rerender({ todos: [] });
      act(() => { vi.advanceTimersByTime(7000); });
      expect(screen.queryByText('「買う」を消しました')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('キーで選んで、完了、直す、消す、動かす、戻すができる', () => {
    const { onAction } = list({ todos: [item('a', 'あ'), item('b', 'い', { position: 2 }), item('c', 'う', { position: 3 })] });
    fireEvent.click(row('あ'));
    fireEvent.keyDown(row('あ'), { key: 'ArrowDown' });
    expect(row('い')).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(row('い'), { key: 'ArrowUp', altKey: true });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.move', projectId: 'p1', ids: ['b', 'a', 'c'] });
    fireEvent.keyDown(row('い'), { key: 'ArrowDown', altKey: true, metaKey: true });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.move', projectId: 'p1', ids: ['a', 'c', 'b'] });
    fireEvent.keyDown(row('い'), { key: 'z', metaKey: true });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.undo', projectId: 'p1' });
    fireEvent.keyDown(row('い'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('い（3 件目）を直す'), { key: 'Escape' });
    fireEvent.keyDown(row('い'), { key: ' ' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.toggle', id: 'b' });
    // 完了にした行は動かさない（並べ替えるのは未完だけ）。
    const before = onAction.mock.calls.length;
    fireEvent.keyDown(row('い'), { key: 'ArrowUp', altKey: true });
    expect(onAction.mock.calls.length).toBe(before);
    fireEvent.keyDown(row('い'), { key: 'Backspace' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.remove', id: 'b' });
  });

  it('a で足す欄へ移る', () => {
    list({ todos: [item('a', 'あ')] });
    fireEvent.click(row('あ'));
    fireEvent.keyDown(row('あ'), { key: 'a' });
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
  });

  it('完了の提案は「完了？」の札で、押すと根拠と確定・却下が開く。丸を押しても反転の UiAction を出す', () => {
    const cand = { note: '直して確かめた', sessionId: 's1', sessionName: '起動画面の作り直し', ago: '12 分前' };
    const { onAction } = list({ todos: [item('t1', '窓を掴める', { candidate: cand }), item('t2', '影の値', { position: 2, candidate: { ...cand, sessionId: null, sessionName: '不明なセッション' } })] });
    expect(screen.queryByText('直して確かめた')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '窓を掴める（1 件目）の完了の提案' }));
    expect(screen.getByText('直して確かめた')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '起動画面の作り直し' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 's1' });
    fireEvent.click(screen.getByRole('button', { name: '窓を掴める（1 件目）を却下' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.reject', id: 't1' });
    // 却下すると中身は閉じる。開き直して確定する。
    expect(screen.queryByText('直して確かめた')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '窓を掴める（1 件目）の完了の提案' }));
    fireEvent.click(screen.getByRole('button', { name: '窓を掴める（1 件目）を確定' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.confirm', id: 't1' });
    // 開けないセッションは押せる形にしない。
    fireEvent.click(screen.getByRole('button', { name: '影の値（2 件目）の完了の提案' }));
    expect(screen.queryByRole('button', { name: '不明なセッション' })).toBeNull();
    expect(screen.getByText('不明なセッション')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '影の値（2 件目、完了の候補）' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.toggle', id: 't2' });
  });

  it('r で完了の提案を却下する', () => {
    const cand = { note: 'n', sessionId: null, sessionName: 'x', ago: '1 分前' };
    const { onAction } = list({ todos: [item('t1', '窓', { candidate: cand })] });
    fireEvent.click(row('窓'));
    fireEvent.keyDown(row('窓'), { key: 'r' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.reject', id: 't1' });
  });

  it('Claude の提案は上の節に並び、受け入れ・見送り・すべて受け入れができる', () => {
    const { onAction } = list({ todos: [item('t1', '買う')], suggestions: [sugg('s1', '計測を CI で回す'), sugg('s2', '英語版も直す', { sessionId: null, sessionName: '不明なセッション' })] });
    const sec = screen.getByRole('group', { name: /Claude の提案/ });
    expect(sec.textContent).toContain('2');
    fireEvent.click(screen.getByRole('button', { name: '計測を CI で回す（1 件目）を受け入れる' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.accept', id: 's1' });
    fireEvent.click(screen.getByRole('button', { name: '英語版も直す（2 件目）を見送る' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.dismiss', id: 's2' });
    fireEvent.click(screen.getByRole('button', { name: 'すべて受け入れ' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'todo.accept', id: 's2' });
    fireEvent.click(screen.getByRole('button', { name: '計測' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'session.open', id: 's1' });
  });

  it('Claude の提案の行は Enter で受け入れ、⌫ で見送る', () => {
    const { onAction } = list({ suggestions: [sugg('s1', '計測を CI で回す')] });
    fireEvent.click(row('計測を CI で回す'));
    fireEvent.keyDown(row('計測を CI で回す'), { key: 'Enter' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.accept', id: 's1' });
    fireEvent.click(row('計測を CI で回す'));
    fireEvent.keyDown(row('計測を CI で回す'), { key: 'Backspace' });
    expect(onAction).toHaveBeenLastCalledWith({ type: 'todo.dismiss', id: 's1' });
  });

  it('提案が 1 件なら「すべて受け入れ」は出さない', () => {
    list({ suggestions: [sugg('s1', '計測')] });
    expect(screen.queryByRole('button', { name: 'すべて受け入れ' })).toBeNull();
  });
});
