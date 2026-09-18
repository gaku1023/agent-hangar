import { cleanup, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { TranscriptItem } from '../presenters/session.ts';
import { Transcript, rowWindow } from './Transcript.tsx';

const items: TranscriptItem[] = [
  { kind: 'user', seq: 0, text: 'hi', when: '10:00' },
  { kind: 'assistant', seq: 1, text: 'bye', when: '10:01' },
];

// jsdom はレイアウトを持たないので、寸法とスクロール位置を定義して流し込む。
function setup(follow: boolean) {
  const onIntent = vi.fn();
  const { container } = render(<IntentRoot onIntent={onIntent}><Transcript sessionId="s1" items={items} hasMore={false} loading={false} follow={follow} live remaining={0} /></IntentRoot>);
  const el = container.querySelector('.tr') as HTMLDivElement;
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  const scrollTo = (top: number) => { Object.defineProperty(el, 'scrollTop', { value: top, configurable: true, writable: true }); fireEvent.scroll(el); };
  return { onIntent, scrollTo };
}

describe('Transcript の追従', () => {
  it('下へ向かう途中のスクロールでは追従を切らない', () => {
    // 追従中の自動スクロールは上から下へ進むので、scrollTop は増え続ける。
    const { onIntent, scrollTo } = setup(true);
    scrollTo(100); scrollTo(300); scrollTo(600);
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('上へ戻ったら追従を切る', () => {
    const { onIntent, scrollTo } = setup(true);
    scrollTo(600); scrollTo(500);
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.follow', sessionId: 's1', follow: false });
  });
  it('追従を切った状態で末尾に着いたら追従に戻す', () => {
    const { onIntent, scrollTo } = setup(false);
    scrollTo(400);
    expect(onIntent).not.toHaveBeenCalled();
    scrollTo(790);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.follow', sessionId: 's1', follow: true });
  });
});

const many = (n: number, from = 0): TranscriptItem[] => Array.from({ length: n }, (_, i) => ({ kind: i % 2 === 0 ? 'user' as const : 'assistant' as const, seq: from + i, text: `行 ${from + i}`, when: '10:00' }));

type Over = Partial<Parameters<typeof Transcript>[0]>;
function draw(over: Over) {
  const onIntent = vi.fn();
  const props = { sessionId: 's1', items: [], hasMore: false, loading: false, follow: true, live: true, remaining: 0, ...over };
  const r = render(<IntentRoot onIntent={onIntent}><Transcript {...props} /></IntentRoot>);
  const el = r.container.querySelector('.tr') as HTMLDivElement;
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: 1_000_000, configurable: true });
  const scrollTo = (top: number) => { Object.defineProperty(el, 'scrollTop', { value: top, configurable: true, writable: true }); fireEvent.scroll(el); };
  const seqs = () => [...r.container.querySelectorAll('.tr-row')].map((x) => Number(x.getAttribute('data-seq')));
  const redraw = (next: Over) => r.rerender(<IntentRoot onIntent={onIntent}><Transcript {...props} {...next} /></IntentRoot>);
  return { ...r, el, scrollTo, seqs, redraw, onIntent };
}

describe('Transcript の仮想スクロール', () => {
  it('500 行でも 5,000 行でも、DOM に載る行の数は変わらない', () => {
    const a = draw({ items: many(500), follow: false });
    a.scrollTo(0);
    const small = a.seqs().length;
    cleanup();
    const b = draw({ items: many(5000), follow: false });
    b.scrollTo(0);
    const big = b.seqs().length;
    expect(small).toBe(big);
    expect(big).toBeGreaterThan(0);
    expect(big).toBeLessThan(80);
  });
  it('追っている間は末尾の行だけを描く', () => {
    const t = draw({ items: many(5000), follow: true });
    t.scrollTo(999_000);
    const seqs = t.seqs();
    expect(seqs.at(-1)).toBe(4999);
    expect(seqs[0]).toBeGreaterThan(4900);
    expect(seqs.length).toBeLessThan(80);
  });
  it('追うのをやめたら、スクロールした位置の行を描く', () => {
    const t = draw({ items: many(5000), follow: false });
    t.scrollTo(0);
    const head = t.seqs();
    expect(head[0]).toBe(0);
    t.scrollTo(10_000);
    const mid = t.seqs();
    expect(mid[0]).toBeGreaterThan(head.at(-1)!);
    expect(mid.length).toBeLessThan(80);
    t.scrollTo(100_000);
    expect(t.seqs()[0]).toBeGreaterThan(mid.at(-1)!);
  });
  it('続きを読み込んで行が増えても、見ている行とスクロール位置は動かない', () => {
    const t = draw({ items: many(500), follow: false, hasMore: true, remaining: 300 });
    t.scrollTo(10_000);
    const before = t.seqs();
    expect(before.length).toBeGreaterThan(0);
    t.redraw({ items: [...many(500), ...many(300, 500)] });
    expect(t.seqs()).toEqual(before);
    expect(t.el.scrollTop).toBe(10_000);
  });
  it('描いた行の高さを測り、次の窓はその高さで決める', () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    // 行の器だけが 200px の高さを持つ jsdom を作る。見積もり（1 行 56px）より十分に高い。
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('tr-row') ? 200 : 0; } });
    try {
      const t = draw({ items: many(5000), follow: false });
      t.scrollTo(0);
      // 窓は 600px と前後 600px ずつ、合わせて 1800px 分。200px の行なら 10 行前後に収まる。
      expect(t.seqs().length).toBeLessThanOrEqual(12);
      expect(t.seqs().length).toBeGreaterThanOrEqual(6);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    }
  });
  it('窓の外に居る行は本文ごと DOM から外れる', () => {
    const t = draw({ items: many(5000), follow: false });
    t.scrollTo(200_000);
    expect(t.container.textContent).not.toContain('行 0');
    expect(t.container.querySelectorAll('.msg').length).toBe(t.seqs().length);
  });
  it('窓に入っているサブエージェントのボタンは今までどおり効く', () => {
    const tail: TranscriptItem[] = [...many(4999), { kind: 'tool', seq: 4999, summary: 'Agent x', name: 'Agent', inputJson: '{}', result: null, when: '10:00', subagent: { agentId: 'abc', label: 'Agent x' } }];
    const t = draw({ items: tail, follow: true });
    t.scrollTo(999_000);
    fireEvent.click(t.getByText('サブエージェント abc を見る'));
    expect(t.onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('続きを読み込むボタンと新着の知らせは仮想化の外に残る', () => {
    const t = draw({ items: many(5000), follow: false, hasMore: true, remaining: 12 });
    t.scrollTo(200_000);
    expect(t.getByText('続きを読み込む（残り 12 件）')).toBeInTheDocument();
    t.redraw({ items: many(5010), hasMore: true, remaining: 12 });
    expect(t.getByText('新着 10 件')).toBeInTheDocument();
  });
});

describe('rowWindow', () => {
  const offsets = [0, 100, 200, 300, 400, 500];
  it('範囲に重なる行だけを返す', () => {
    expect(rowWindow(offsets, 0, 250)).toEqual({ first: 0, last: 2 });
    expect(rowWindow(offsets, 150, 250)).toEqual({ first: 1, last: 2 });
    expect(rowWindow(offsets, 480, 900)).toEqual({ first: 4, last: 4 });
  });
  it('行が無いときは空の範囲', () => {
    expect(rowWindow([0], 0, 100)).toEqual({ first: 0, last: -1 });
  });
});
