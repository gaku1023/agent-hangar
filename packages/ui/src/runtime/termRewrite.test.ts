import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReplyRewrites, fitRows, plainOf, REWRITE_DELAY_MS, wrapCells, type CopyDrag, type PlacedReply, type RewriteTerm } from './termRewrite.ts';

const A = 'The build passed on all five jobs, and the branch is ready to merge now.';
const B = 'I changed the width of the sidebar and added a test for the narrow case.';
const JA_A = 'ビルドは5つのジョブすべてで通り、枝はマージできる。';
const JA_B = '横の欄の幅を変え、狭い場合の試験を足した。';

/** 全角を 2 桁に数える偽物の幅。 */
const w = (s: string) => Array.from(s).reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);

type FakeMarker = { line: number; isDisposed: boolean; dispose(): void };
type FakeDeco = { marker: FakeMarker; box: { x: number; width: number }; isDisposed: boolean; el: HTMLElement; render(): void; onRender(cb: (el: HTMLElement) => void): { dispose(): void }; dispose(): void };

/** 行の文字の列だけを持つ偽物の端末。paint は SGR を落として行の x 桁目から右を書き換える（偽物では 1 文字を 1 桁とみなす）。 */
function fakeTerm(initial: string[], cols = 80) {
  let lines = [...initial];
  const change = new Set<() => void>();
  const decos: FakeDeco[] = [];
  let ground = true;
  let copyMap: ((t: string, drag: CopyDrag | null) => string) | null = null;
  const term: RewriteTerm & { set(next: string[]): void; decos: FakeDeco[]; paints: number; setGround(v: boolean): void; copy(t: string, drag?: CopyDrag | null): string; now(): string[] } = {
    cols,
    decos,
    paints: 0,
    lines: () => lines,
    now: () => lines,
    cellsFrom: (line, x) => (lines[line] ?? '').slice(x).trimEnd(),
    cellsRange: (line, x0, x1) => (lines[line] ?? '').slice(x0, x1),
    width: w,
    snapshot: (line, x) => `\x1b[1m${(lines[line] ?? '').slice(x)}\x1b[0m`,
    paint(x, rows) {
      if (!ground) return false;
      term.paints++;
      lines = [...lines];
      for (const r of rows) lines[r.line] = `${(lines[r.line] ?? '').slice(0, x).padEnd(x)}${r.seq.replace(/\x1b\[[0-9;]*m/g, '')}`.trimEnd();
      return true;
    },
    set(next) { lines = [...next]; for (const cb of change) cb(); },
    setGround(v) { ground = v; },
    mark(line) { const m: FakeMarker = { line, isDisposed: false, dispose() { m.isDisposed = true; m.line = -1; } }; return m; },
    decorate(marker, box) {
      const subs = new Set<(el: HTMLElement) => void>();
      const d: FakeDeco = { marker: marker as FakeMarker, box, isDisposed: false, el: {} as HTMLElement, render() { for (const cb of subs) cb(d.el); }, onRender(cb) { subs.add(cb); return { dispose: () => subs.delete(cb) }; }, dispose() { d.isDisposed = true; } };
      decos.push(d);
      return d;
    },
    setCopyMap(m) { copyMap = m; },
    copy: (t, drag = null) => (copyMap ? copyMap(t, drag) : t),
    onChange(cb) { change.add(cb); return { dispose: () => change.delete(cb) }; },
  };
  return term;
}

const screen = (pad: number) => [...Array.from({ length: pad }, () => ''), '⏺ The build passed on all five jobs, and the branch is', '  ready to merge now.', '', '⏺ I changed the width of the sidebar and added a test for', '  the narrow case.', '', '❯ '];

function api(map: Record<string, string | null>, opts: { cached?: boolean } = {}) {
  const pending: { text: string; resolve: (v: string | null) => void }[] = [];
  return {
    pending,
    cached: (text: string) => (opts.cached ? map[text] ?? null : null),
    translate: (text: string) => new Promise<string | null>((resolve) => { pending.push({ text, resolve }); }),
    settle() { for (const p of pending.splice(0)) p.resolve(map[p.text] ?? null); },
  };
}

describe('wrapCells と fitRows と plainOf', () => {
  it('全角を 2 桁に数えて折り返す', () => {
    expect(wrapCells('あいうえおかきくけこ', 8, w)).toEqual(['あいうえ', 'おかきく', 'けこ']);
    expect(wrapCells('ab cd ef', 5, w)).toEqual(['ab cd', 'ef']);
  });

  it('続く空行は 1 つにし、頭と末尾の空行は落とす', () => {
    expect(wrapCells('\nあ\n\n\nい\n', 10, w)).toEqual(['あ', '', 'い']);
  });

  it('短ければ下（cut なら上）を空け、長ければ切って … を付ける', () => {
    expect(fitRows(['a', 'b'], 3, false)).toEqual(['a', 'b', '']);
    expect(fitRows(['a', 'b'], 3, true)).toEqual(['', 'a', 'b']);
    expect(fitRows(['aa', 'bb', 'cc'], 2, false)).toEqual(['aa', 'b…']);
    expect(fitRows(['aa', 'bb', 'cc'], 2, true)).toEqual(['…', 'cc']);
  });

  it('Markdown の記号と制御の文字を落とす', () => {
    expect(plainOf('## 見出し\n**太字**と`code`と[リンク](https://x)\x1b[31m')).toBe('見出し\n太字とcodeとリンク[31m');
  });
});

describe('createReplyRewrites', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('訳を待つ間は英語のままアイコンを wait で置き、届いたら印を残して 2 桁目から上書きする', async () => {
    const term = fakeTerm(screen(2));
    const seen: PlacedReply[][] = [];
    const t = api({ [A]: JA_A, [B]: JA_B });
    const o = createReplyRewrites(term, t, (l) => seen.push(l));
    o.setReplies([A, B]);
    expect(term.now()[2]).toBe('⏺ The build passed on all five jobs, and the branch is');
    expect(seen.at(-1)!.map((p) => p.state)).toEqual(['wait', 'wait']);
    // アイコンは頭の行の右端の 2 桁に置く。
    expect(term.decos.map((d) => [d.marker.line, d.box])).toEqual([[5, { x: 78, width: 2 }], [2, { x: 78, width: 2 }]]);
    t.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(term.now().slice(2, 7)).toEqual(['⏺ ビルドは5つのジョブすべてで通り、枝はマージできる。', '', '', '⏺ 横の欄の幅を変え、狭い場合の試験を足した。', '']);
    expect(seen.at(-1)!.map((p) => p.state)).toEqual(['ja', 'ja']);
    o.dispose();
  });

  it('描き直しで英語に戻ったら、書き込みのたびに先送りせず、最初の書き込みから決まった間で書き直す', async () => {
    const term = fakeTerm(screen(2));
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    expect(term.now()[2]).toContain('ビルド');
    // 1 行上へずれて英語で描き直された。続けて書き込みが届き続ける（スピナーなど）。
    term.set(screen(1));
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(REWRITE_DELAY_MS / 4); term.set(term.now()); }
    expect(term.now()[1]).toContain('ビルド');
    o.dispose();
  });

  it('出力がエスケープの途中で書けなければ、少し待ってやり直す', async () => {
    const term = fakeTerm(screen(2));
    term.setGround(false);
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    expect(term.now()[2]).toContain('The build');
    term.setGround(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(term.now()[2]).toContain('ビルド');
    o.dispose();
  });

  it('原文に戻すと、取っておいた英語を書き戻し、戻したまま描き直されても訳さない。もう一度押すと訳に戻る', async () => {
    const term = fakeTerm(screen(2));
    const seen: PlacedReply[][] = [];
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), (l) => seen.push(l));
    o.setReplies([A]);
    o.setOriginal(new Set([A]));
    expect(term.now().slice(2, 4)).toEqual(['⏺ The build passed on all five jobs, and the branch is', '  ready to merge now.']);
    expect(seen.at(-1)![0]!.state).toBe('orig');
    term.set(screen(1));
    await vi.advanceTimersByTimeAsync(REWRITE_DELAY_MS);
    expect(term.now()[1]).toContain('The build');
    o.setOriginal(new Set());
    expect(term.now()[1]).toContain('ビルド');
    o.dispose();
  });

  it('訳せなかった返答は英語のまま、アイコンも置かない', async () => {
    const term = fakeTerm(screen(2));
    const t = api({ [A]: null });
    const seen: PlacedReply[][] = [];
    const o = createReplyRewrites(term, t, (l) => seen.push(l));
    o.setReplies([A]);
    t.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(term.now()[2]).toContain('The build');
    expect(seen.at(-1)).toEqual([]);
    o.dispose();
  });

  it('ドラッグの範囲が訳の行にかかっていれば、写し（英語）を画面に見えている訳に取り直す', () => {
    // 訳が 2 行に折り返る返答。
    const LONG = 'ビルドは5つのジョブすべてで通り、枝はマージできる状態になった。続けて横の欄の幅を変えた。';
    const term = fakeTerm(screen(2), 40);
    const o = createReplyRewrites(term, api({ [A]: LONG, [B]: JA_B }, { cached: true }), () => {});
    o.setReplies([A, B]);
    const rows = term.now();
    expect(rows[2]!.startsWith('⏺ ビルド')).toBe(true);
    expect(rows[3]!.startsWith('  ')).toBe(true);
    const english = 'The build passed on all five jobs, and the branch is ready to merge now.';
    // 返答の全体をなぞった。折り返しの行は改行を挟まずにつなぎ、字下げは落とす。
    expect(term.copy(english, { start: { x: 0, y: 2 }, end: { x: 39, y: 3 } })).toBe(`${rows[2]!.slice(2)}${rows[3]!.slice(2)}`);
    // 2 通にまたがると、返答の間は空行で区切る。
    expect(term.copy(english, { start: { x: 0, y: 2 }, end: { x: 39, y: 5 } })).toBe(`${rows[2]!.slice(2)}${rows[3]!.slice(2)}\n\n${rows[5]!.slice(2)}`);
    // 行の途中から途中まで（逆向きのドラッグでも同じ）。
    expect(term.copy(english, { start: { x: 6, y: 2 }, end: { x: 4, y: 2 } })).toBe(rows[2]!.slice(4, 7));
    // 訳の行にかからないドラッグ、ドラッグの無い写し、クリックだけは、写しのまま。
    expect(term.copy('❯', { start: { x: 0, y: 8 }, end: { x: 3, y: 8 } })).toBe('❯');
    expect(term.copy(english, null)).toBe(english);
    expect(term.copy(english, { start: { x: 3, y: 2 }, end: { x: 3, y: 2 } })).toBe(english);
    // 原文に戻した返答は写しのまま。
    o.setOriginal(new Set([A, B]));
    expect(term.copy(english, { start: { x: 0, y: 2 }, end: { x: 39, y: 3 } })).toBe(english);
    o.dispose();
  });

  it('書いた訳が行ごと上へずれたら、書き直さずに付いていく', async () => {
    const term = fakeTerm(screen(2));
    const seen: PlacedReply[][] = [];
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), (l) => seen.push(l));
    o.setReplies([A]);
    const paints = term.paints;
    term.set(term.now().slice(1));
    await vi.advanceTimersByTimeAsync(REWRITE_DELAY_MS);
    expect(term.paints).toBe(paints);
    expect(term.decos.filter((d) => !d.isDisposed).map((d) => d.marker.line)).toEqual([1]);
    o.dispose();
  });

  it('訳も英語も見つからなくなったら（行の一部だけが英語で描き直されて混ざった）、tmux に描き直しを頼む', async () => {
    const term = fakeTerm(screen(2));
    const redraw = vi.fn();
    term.redraw = redraw;
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    const mixed = term.now().slice();
    mixed[2] = '⏺ The build passed on 5つのジョブすべてで通り、枝は';
    term.set(mixed);
    await vi.advanceTimersByTimeAsync(REWRITE_DELAY_MS);
    expect(redraw).toHaveBeenCalledTimes(1);
    // tmux が英語で全部描き直したら、もう一度上書きする。
    term.set(screen(2));
    await vi.advanceTimersByTimeAsync(REWRITE_DELAY_MS);
    expect(term.now()[2]).toContain('ビルド');
    expect(redraw).toHaveBeenCalledTimes(1);
    o.dispose();
  });

  it('外すと訳を英語に戻し、アイコンとコピーの差し替えも外す', () => {
    const term = fakeTerm(screen(2));
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    expect(term.now()[2]).toContain('ビルド');
    o.dispose();
    expect(term.now()[2]).toContain('The build');
    expect(term.decos.every((d) => d.isDisposed)).toBe(true);
    expect(term.copy('⏺ The build passed on all five jobs, and the branch is')).toContain('The build');
  });
});
