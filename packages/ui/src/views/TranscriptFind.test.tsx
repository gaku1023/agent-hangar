import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { findIn } from '../presenters/find.ts';
import type { TranscriptItem } from '../presenters/session.ts';
import { toolItem } from '../test/items.ts';
import { Transcript, type TranscriptFind } from './Transcript.tsx';

afterEach(cleanup);

const many = (n: number, from = 0): TranscriptItem[] => Array.from({ length: n }, (_, i) => ({ kind: i % 2 === 0 ? 'user' as const : 'assistant' as const, seq: from + i, text: `行 ${from + i}`, when: '10:00' }));

function findOf(items: TranscriptItem[], query: string, step = 0, n = 1): TranscriptFind {
  const state = { query, caseSensitive: false, from: null, step, n };
  return { ...state, ...findIn(items, state) };
}

function draw(items: TranscriptItem[], find: TranscriptFind | null, follow = false) {
  const onIntent = vi.fn();
  const props: Parameters<typeof Transcript>[0] = { sessionId: 's1', items, hasMore: false, loading: false, follow, live: false, remaining: 0, find };
  const r = render(<IntentRoot onIntent={onIntent}><Transcript {...props} /></IntentRoot>);
  const el = r.container.querySelector('.tr') as HTMLDivElement;
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: 1_000_000, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true, writable: true });
  const redraw = (next: Partial<typeof props>) => r.rerender(<IntentRoot onIntent={onIntent}><Transcript {...props} {...next} /></IntentRoot>);
  const seqs = () => [...r.container.querySelectorAll('.tr-row')].map((x) => Number(x.getAttribute('data-seq')));
  return { ...r, el, onIntent, redraw, seqs };
}

const items: TranscriptItem[] = [
  { kind: 'user', seq: 0, text: 'バリデーションを足して', when: '' },
  { kind: 'assistant', seq: 1, text: '入力の**バリデーション**を足します', when: '' },
  toolItem(2, 'Bash', { command: 'npm test' }, { text: 'バリデーション ok\nバリデーション ok', isError: false }),
  { kind: 'assistant', seq: 3, text: 'バリデーションは済みました', when: '' },
];

describe('本文の中の検索の欄（S1）', () => {
  it('右上に浮く欄に、件数と前へ次へと大文字小文字と閉じるを並べる', () => {
    draw(items, findOf(items, 'バリデーション', 1));
    const box = screen.getByRole('searchbox', { name: '本文の中を探す' });
    expect(box).toHaveValue('バリデーション');
    expect(box.closest('.tr-find')).not.toBeNull();
    expect(screen.getByText('2 / 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前の一致（⇧⏎）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '次の一致（⏎）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '大文字と小文字を区別' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '閉じる（esc）' })).toBeInTheDocument();
  });
  it('打つと語と見ていた行を送り、⏎ で次、⇧⏎ で前、esc で閉じる', () => {
    const t = draw(items, findOf(items, ''));
    const box = screen.getByRole('searchbox', { name: '本文の中を探す' });
    fireEvent.change(box, { target: { value: 'バリ' } });
    expect(t.onIntent).toHaveBeenCalledWith({ type: 'transcript.findQuery', sessionId: 's1', query: 'バリ', caseSensitive: false, from: 0 });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(t.onIntent).toHaveBeenLastCalledWith({ type: 'transcript.findStep', sessionId: 's1', delta: 1 });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(t.onIntent).toHaveBeenLastCalledWith({ type: 'transcript.findStep', sessionId: 's1', delta: -1 });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(t.onIntent).toHaveBeenLastCalledWith({ type: 'transcript.find', sessionId: 's1', open: false });
  });
  it('一致が無ければ 0 件、語が空なら件数を出さない', () => {
    draw(items, findOf(items, 'ない語'));
    expect(screen.getByText('0 件')).toBeInTheDocument();
    cleanup();
    const t = draw(items, findOf(items, ''));
    expect(t.container.querySelector('.tr-find-count')?.textContent).toBe('');
  });
  it('開くたびに欄へフォーカスする', () => {
    const t = draw(items, findOf(items, 'x', 0, 1));
    const box = screen.getByRole('searchbox', { name: '本文の中を探す' });
    expect(box).toHaveFocus();
    box.blur();
    t.redraw({ find: findOf(items, 'x', 0, 2) });
    expect(box).toHaveFocus();
  });
});

describe('一致の印', () => {
  it('描いた一致に淡い印を付け、今の一致だけ濃くする', () => {
    const t = draw(items, findOf(items, 'バリデーション', 1));
    const marks = [...t.container.querySelectorAll('mark.hit')];
    expect(marks.length).toBeGreaterThanOrEqual(3);
    const cur = t.container.querySelectorAll('mark.cur');
    expect(cur).toHaveLength(1);
    expect(cur[0]!.closest('.tr-row')?.getAttribute('data-seq')).toBe('1');
  });
  it('畳んだツールの中の一致は、行に数を出す', () => {
    const t = draw(items, findOf(items, 'バリデーション', 0));
    expect(t.container.querySelector('.tr-row[data-seq="2"] .hitcount')?.textContent).toBe('一致 2');
    expect(t.container.querySelector('.tr-row[data-seq="2"] .bash')).toBeNull();
  });
  it('今の一致が畳んだツールの中にあれば、そのツールを開いて見せる', () => {
    const t = draw(items, findOf(items, 'バリデーション', 3));
    expect(t.container.querySelector('.tr-row[data-seq="2"] .bash')).not.toBeNull();
    expect(t.container.querySelector('.tr-row[data-seq="2"] mark.cur')?.textContent).toBe('バリデーション');
  });
  it('スクロールバーの脇に、一致のある行の印を並べ、今の一致の印を分ける', () => {
    const t = draw(items, findOf(items, 'バリデーション', 3));
    const ticks = [...t.container.querySelectorAll('.tr-ticks i')];
    expect(ticks).toHaveLength(4);
    expect(ticks.filter((x) => x.getAttribute('data-cur') === 'true')).toHaveLength(1);
  });
  it('閉じると印も消える', () => {
    const t = draw(items, findOf(items, 'バリデーション'));
    t.redraw({ find: null });
    expect(t.container.querySelector('mark')).toBeNull();
    expect(t.container.querySelector('.tr-ticks')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

describe('一致へ跳ぶ', () => {
  it('今の一致が窓の外なら、その行まで送り、追うのをやめる', () => {
    const list: TranscriptItem[] = [{ kind: 'assistant', seq: 0, text: 'ここに目印', when: '' }, ...many(3000, 1)];
    const t = draw(list, null, true);
    expect(t.seqs()).not.toContain(0);
    act(() => t.redraw({ find: findOf(list, '目印') }));
    expect(t.onIntent).toHaveBeenCalledWith({ type: 'transcript.follow', sessionId: 's1', follow: false });
    // 親が追うのをやめた状態を返したら、送った位置の行が出る。
    act(() => t.redraw({ find: findOf(list, '目印'), follow: false }));
    expect(t.seqs()).toContain(0);
    expect(t.container.querySelector('.tr-row[data-seq="0"] mark.cur')).not.toBeNull();
  });
});

describe('検索の結果から開いたとき（J1）', () => {
  it('跳び先の行へ送り、その行だけに語の印を付け、地を一度だけ光らせる', () => {
    const list: TranscriptItem[] = [...many(3000), { kind: 'assistant', seq: 3000, text: 'パスワードの条件は 8 文字以上', when: '' }, { kind: 'user', seq: 3001, text: 'パスワードの条件を変える', when: '' }];
    const t = draw(list, null);
    act(() => t.redraw({ jump: { seq: 3000, query: 'パスワードの条件', n: 1 } }));
    const row = t.container.querySelector('.tr-row[data-seq="3000"]')!;
    expect(row).not.toBeNull();
    expect(row.classList.contains('tr-flash')).toBe(true);
    expect(row.querySelector('mark.hit')?.textContent).toBe('パスワードの条件');
    expect(t.container.querySelector('.tr-row[data-seq="3001"] mark')).toBeNull();
    // 消し終えたら外す。外さないと、窓の外から戻るたびに光り直す。
    fireEvent.animationEnd(row);
    expect(row.classList.contains('tr-flash')).toBe(false);
  });
  it('抜粋の seq が描く行に無ければ、その後ろの最初の行へ跳ぶ', () => {
    const list: TranscriptItem[] = [{ kind: 'user', seq: 0, text: 'a', when: '' }, { kind: 'assistant', seq: 5, text: 'b', when: '' }];
    const t = draw(list, null);
    act(() => t.redraw({ jump: { seq: 3, query: 'b', n: 1 } }));
    expect(t.container.querySelector('.tr-row[data-seq="5"]')?.classList.contains('tr-flash')).toBe(true);
  });
  it('真ん中の頁から開いたときは、下に「新しい行を読み込む」を置く', () => {
    const t = draw(many(3), null);
    act(() => t.redraw({ hasNewer: true }));
    fireEvent.click(screen.getByRole('button', { name: '新しい行を読み込む' }));
    expect(t.onIntent).toHaveBeenCalledWith({ type: 'transcript.loadNewer', sessionId: 's1' });
  });
});
