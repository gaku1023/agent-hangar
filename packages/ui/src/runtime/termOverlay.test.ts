import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReplyOverlays, SCAN_DELAY_MS, type OverlayTerm, type PlacedReply } from './termOverlay.ts';

const A = 'The build passed on all five jobs, and the branch is ready to merge now.';
const B = 'I changed the width of the sidebar and added a test for the narrow case.';

type FakeMarker = { line: number; isDisposed: boolean; dispose(): void };
type FakeDeco = { marker: FakeMarker; box: { x: number; width: number; height: number }; isDisposed: boolean; el: HTMLElement; render(): void; onRender(cb: (el: HTMLElement) => void): { dispose(): void }; dispose(): void };

function fakeTerm(initial: string[]) {
  let lines = initial;
  const change = new Set<() => void>();
  const decos: FakeDeco[] = [];
  const term: OverlayTerm & { set(next: string[]): void; decos: FakeDeco[]; cols: number } = {
    cols: 80,
    decos,
    lines: () => lines,
    set(next) { lines = next; for (const cb of change) cb(); },
    mark(line) { const m: FakeMarker = { line, isDisposed: false, dispose() { m.isDisposed = true; m.line = -1; } }; return m; },
    decorate(marker, box) {
      const subs = new Set<(el: HTMLElement) => void>();
      const d: FakeDeco = { marker: marker as FakeMarker, box, isDisposed: false, el: {} as HTMLElement, render() { for (const cb of subs) cb(d.el); }, onRender(cb) { subs.add(cb); return { dispose: () => subs.delete(cb) }; }, dispose() { d.isDisposed = true; } };
      decos.push(d);
      return d;
    },
    onChange(cb) { change.add(cb); return { dispose: () => change.delete(cb) }; },
  };
  return term;
}

const screenWith = (pad: number) => [...Array.from({ length: pad }, () => ''), '⏺ The build passed on all five jobs, and the branch is', '  ready to merge now.', '', '⏺ I changed the width of the sidebar and added a test for', '  the narrow case.', '', '❯ '];

describe('createReplyOverlays', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('見つけた返答の行に、印の 2 桁目から右端まで、返答の行数の高さで板を付ける', () => {
    const term = fakeTerm(screenWith(2));
    const seen: PlacedReply[][] = [];
    const o = createReplyOverlays(term, (list) => seen.push(list));
    o.setReplies([A, B]);
    expect(term.decos.map((d) => [d.marker.line, d.box])).toEqual([[2, { x: 2, width: 78, height: 2 }], [5, { x: 2, width: 78, height: 2 }]]);
    // 描かれるまでは要素が無い。
    expect(seen.at(-1)!.map((p) => p.el)).toEqual([null, null]);
    term.decos[0]!.render();
    expect(seen.at(-1)!.find((p) => p.text === A)!.el).toBe(term.decos[0]!.el);
    o.dispose();
    expect(term.decos.every((d) => d.isDisposed)).toBe(true);
  });

  it('描き直しで中身が変わったら板を外し、少し待ってから探し直して付け直す', () => {
    const term = fakeTerm(screenWith(2));
    const seen: PlacedReply[][] = [];
    const o = createReplyOverlays(term, (list) => seen.push(list));
    o.setReplies([A]);
    const first = term.decos[0]!;
    // 窓の大きさを変えて Claude Code が描き直した（同じ行番号に別の中身）。
    term.set(['', '', 'something else entirely', '', '', '⏺ The build passed on all five jobs, and the branch is ready to merge now.', '']);
    // 少し待つまでは何もしない。続けて届く描画をまとめる。
    expect(first.isDisposed).toBe(false);
    vi.advanceTimersByTime(SCAN_DELAY_MS);
    expect(first.isDisposed).toBe(true);
    const second = term.decos[1]!;
    expect([second.marker.line, second.box.height]).toEqual([5, 1]);
    expect(seen.at(-1)!.map((p) => p.text)).toEqual([A]);
    o.dispose();
  });

  it('見つからなくなったら板を外し、英語のまま見せる', () => {
    const term = fakeTerm(screenWith(0));
    const seen: PlacedReply[][] = [];
    const o = createReplyOverlays(term, (list) => seen.push(list));
    o.setReplies([A]);
    term.set(['❯ ']);
    vi.advanceTimersByTime(SCAN_DELAY_MS);
    expect(term.decos[0]!.isDisposed).toBe(true);
    expect(seen.at(-1)).toEqual([]);
    o.dispose();
  });

  it('印が外れた（行が画面から押し出された）ら板を外す', () => {
    const term = fakeTerm(screenWith(0));
    const o = createReplyOverlays(term, () => {});
    o.setReplies([A]);
    term.decos[0]!.marker.dispose();
    term.set(['❯ ']);
    vi.advanceTimersByTime(SCAN_DELAY_MS);
    expect(term.decos[0]!.isDisposed).toBe(true);
    o.dispose();
  });

  it('頭が画面の上に切れた返答は、見えている行に板を付け、切れていることを渡す', () => {
    const term = fakeTerm(['  passed on all five jobs, and the branch is', '  ready to merge now.', '', '❯ ']);
    const seen: PlacedReply[][] = [];
    const o = createReplyOverlays(term, (list) => seen.push(list));
    o.setReplies([A]);
    expect([term.decos[0]!.marker.line, term.decos[0]!.box.height]).toEqual([0, 2]);
    expect(seen.at(-1)).toEqual([{ text: A, el: null, rows: 2, cut: true }]);
    o.dispose();
  });

  it('対象から外れた返答の板は外し、同じ対象を渡し直しても付け直さない', () => {
    const term = fakeTerm(screenWith(0));
    const o = createReplyOverlays(term, () => {});
    o.setReplies([A, B]);
    o.setReplies([A, B]);
    expect(term.decos.length).toBe(2);
    o.setReplies([B]);
    expect(term.decos[0]!.isDisposed).toBe(true);
    expect(term.decos[1]!.isDisposed).toBe(false);
    o.dispose();
  });
});
