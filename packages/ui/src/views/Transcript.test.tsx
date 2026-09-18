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
function setup(follow: boolean, live = true) {
  const onIntent = vi.fn();
  const { container } = render(<IntentRoot onIntent={onIntent}><Transcript sessionId="s1" items={items} hasMore={false} loading={false} follow={follow} live={live} remaining={0} /></IntentRoot>);
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
  it('終了したセッションでも上へ戻ったら追従を切る', () => {
    // live が null のセッションこそ読み返す対象である。追うのをやめられないと遡れない。
    const { onIntent, scrollTo } = setup(true, false);
    scrollTo(600); scrollTo(500);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.follow', sessionId: 's1', follow: false });
  });
  it('終了したセッションでは末尾に着いても追従に戻さない', () => {
    // 新着が届かないので、末尾に貼り付け直す意味がない。
    const { onIntent, scrollTo } = setup(false, false);
    scrollTo(790);
    expect(onIntent).not.toHaveBeenCalled();
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
  it('古い行を読み込むボタンと新着の知らせは仮想化の外に残る', () => {
    const t = draw({ items: many(5000), follow: false, hasMore: true, remaining: 12 });
    t.scrollTo(200_000);
    expect(t.getByText('古い行を読み込む（残り 12 件）')).toBeInTheDocument();
    t.redraw({ items: many(5010), hasMore: true, remaining: 12 });
    expect(t.getByText('新着 10 件')).toBeInTheDocument();
  });
  it('古い行を読み込むボタンは行の上に出る', () => {
    // 押すと過去が前に入るので、ボタンは一覧の上でなければ向きが噛み合わない。
    const t = draw({ items: many(100), follow: false, hasMore: true, remaining: 42 });
    const btn = t.getByText('古い行を読み込む（残り 42 件）');
    const rows = t.container.querySelector('.tr-rows')!;
    expect(btn.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('古い行を前に足しても、見ている行はその場に留まる', () => {
    const t = draw({ items: many(500, 500), follow: false });
    t.scrollTo(10_000);
    const before = t.seqs();
    t.redraw({ items: [...many(500, 0), ...many(500, 500)] });
    // 1 行 56px の見積もりで 500 行が前に入るので、その分だけ位置を送る。
    expect(t.el.scrollTop).toBe(10_000 + 500 * 56);
    expect(t.seqs()).toEqual(before);
  });
  it('古い行を前に足しても、高さを測り直しても、見ていた行は 1px も動かない', () => {
    // 行の器だけが 200px の世界を作る。前に入る 500 行の見積もり（56px）は実寸と食い違う。
    // 窓の外の行は描かれないので測れない。それでも見ていた行は動いてはならない。
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('tr-row') ? 200 : 0; } });
    try {
      const t = draw({ items: many(500, 500), follow: false, hasMore: true, remaining: 500 });
      t.scrollTo(10_000);
      // 窓の真ん中の行が、器の上端から何 px のところに見えているか。
      const at = (seq: number) => {
        const rows = t.container.querySelector('.tr-rows') as HTMLElement;
        let y = parseFloat(rows.style.paddingTop || '0');
        for (const el of t.container.querySelectorAll('.tr-row')) {
          if (Number(el.getAttribute('data-seq')) === seq) return y - t.el.scrollTop;
          y += (el as HTMLElement).offsetHeight || 56;
        }
        return null;
      };
      const seqs = t.seqs();
      const target = seqs[Math.floor(seqs.length / 2)]!;
      const before = at(target);
      expect(before).not.toBeNull();
      t.redraw({ items: [...many(500, 0), ...many(500, 500)] });
      const after = at(target);
      expect(after).not.toBeNull();
      expect(Math.abs(after! - before!)).toBeLessThan(1);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    }
  });
  it('過去へ遡って行が増えても新着の数は動かない', () => {
    const t = draw({ items: many(500, 500), follow: false, live: true, hasMore: true, remaining: 500 });
    t.redraw({ items: [...many(500, 500), ...many(3, 1000)] });
    expect(t.getByText('新着 3 件')).toBeInTheDocument();
    // 古い行を 500 件読み込んでも、新着は 3 件のままである。
    t.redraw({ items: [...many(500, 0), ...many(500, 500), ...many(3, 1000)] });
    expect(t.getByText('新着 3 件')).toBeInTheDocument();
  });
});

describe('終了したセッションのトランスクリプト', () => {
  it('終了したセッションでも遡れて、遡った位置が保たれる', () => {
    const t = draw({ items: many(5000), follow: true, live: false });
    t.scrollTo(999_000);
    t.scrollTo(100_000);
    expect(t.onIntent).toHaveBeenCalledWith({ type: 'transcript.follow', sessionId: 's1', follow: false });
    // 親が追うのをやめた状態を返したら、その位置の行が出て、末尾へ引き戻されない。
    t.redraw({ follow: false });
    const seqs = t.seqs();
    expect(seqs[0]).toBeGreaterThan(0);
    expect(seqs.at(-1)).toBeLessThan(4999);
    expect(t.el.scrollTop).toBe(100_000);
  });
  it('高さを測り直しても、見ている行はその場に留まる', () => {
    // 1 行の見積もりは 56px なので、scrollTop 10,000 は 178 行目の 32px 目にあたる。
    // 測り直しで窓の中の行が 200px になると、178 行目より上では 167 から 177 までの 11 行が 56 から 200 へ変わる。
    // 上に増えた 11 * (200 - 56) = 1,584px だけ scrollTop を足せば、178 行目の 32px 目に留まる。
    const t = draw({ items: many(5000), follow: false, live: false });
    t.scrollTo(10_000);
    const topSeq = () => {
      const rows = t.container.querySelector('.tr-rows') as HTMLElement;
      let y = parseFloat(rows.style.paddingTop || '0');
      for (const el of t.container.querySelectorAll('.tr-row')) {
        const h = (el as HTMLElement).offsetHeight || 56;
        if (y + h > t.el.scrollTop) return Number(el.getAttribute('data-seq'));
        y += h;
      }
      return -1;
    };
    expect(topSeq()).toBe(178);
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('tr-row') ? 200 : 0; } });
    try {
      t.redraw({});
      expect(t.el.scrollTop).toBe(11_584);
      expect(topSeq()).toBe(178);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    }
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
