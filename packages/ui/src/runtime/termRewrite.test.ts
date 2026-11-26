import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReplyRewrites, FADE_FRAME_MS, fadeCode, FADE_MS, FADE_STAGGER_MS, fitRows, plainOf, REWRITE_DELAY_MS, shadeRow, wrapCells, type CopyDrag, type PlacedReply, type RewriteTerm } from './termRewrite.ts';

const A = 'The build passed on all five jobs, and the branch is ready to merge now.';
const B = 'I changed the width of the sidebar and added a test for the narrow case.';
const JA_A = 'ビルドは5つのジョブすべてで通り、枝はマージできる。';
const JA_B = '横の欄の幅を変え、狭い場合の試験を足した。';

/** SGR の引数から、選択の色（反転と背景）だけを残す。 */
function onlyShade(code: string): string {
  const t = code.split(';').filter((x) => x !== '');
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '38') { i += t[i + 1] === '2' ? 4 : 2; continue; }
    if (t[i] === '48') { const n = t[i + 1] === '2' ? 5 : 3; out.push(t.slice(i, i + n).join(';')); i += n - 1; continue; }
    if (t[i] === '7') out.push('7');
  }
  return out.join(';');
}

/** 全角を 2 桁に数える偽物の幅。 */
const w = (s: string) => Array.from(s).reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);

type FakeMarker = { line: number; isDisposed: boolean; dispose(): void };
type FakeDeco = { marker: FakeMarker; box: { x: number; width: number; height?: number }; glow: boolean; isDisposed: boolean; el: HTMLElement; render(): void; onRender(cb: (el: HTMLElement) => void): { dispose(): void }; dispose(): void };

/**
 * 偽物の端末。英語の本当の画面（影、truth）と、見えている画面（view）の 2 枚を持つ。
 * set は中のアプリが描いたこととして両方を同じにし、paint は見えている画面だけを書き換える（SGR は選択の色だけを桁ごとに覚える）。
 * 文字は 1 文字を 1 つの位置とみなし、選択の色だけは全角を 2 桁に数える。
 */
function fakeTerm(initial: string[], cols = 80) {
  let truth = [...initial];
  let view = [...initial];
  let tShade = new Map<number, string[]>();
  let vShade = new Map<number, string[]>();
  const change = new Set<() => void>();
  const decos: FakeDeco[] = [];
  let ground = true;
  let copyMap: ((t: string, drag: CopyDrag | null) => string) | null = null;
  const fire = () => { for (const cb of change) cb(); };
  const styles = new Map<string, { sgr: string; rgb: string | null }>();
  const term: RewriteTerm & { setStyle(line: number, x: number, st: { sgr: string; rgb: string | null }): void; set(next: string[], shown?: string[]): void; setView(next: string[]): void; select(line: number, x0: number, x1: number, sh: string): void; viewShade(line: number): string[]; viewCode(line: number): string[]; decos: FakeDeco[]; paints: number; setGround(v: boolean): void; copy(t: string, drag?: CopyDrag | null): string; now(): string[] } = {
    cols,
    decos,
    paints: 0,
    lines: () => truth,
    now: () => view,
    cellsFrom: (line, x) => (view[line] ?? '').slice(x).trimEnd(),
    cellsRange: (line, x0, x1) => (view[line] ?? '').slice(x0, x1),
    width: w,
    shades(line, x0, x1, from) {
      const row = (from === 'truth' ? tShade : vShade).get(line) ?? [];
      // 本物の端末と同じく、選択の色（背景と反転）だけを返す。文字の色と飾りは落とす。
      return Array.from({ length: x1 - x0 }, (_, n) => onlyShade(row[x0 + n] ?? ''));
    },
    style: (line, x) => styles.get(`${line}:${x}`) ?? { sgr: '', rgb: null },
    setStyle(line, x, st) { styles.set(`${line}:${x}`, st); },
    snapshot: (line, x) => `\x1b[1m${(truth[line] ?? '').slice(x)}\x1b[0m`,
    paint(x, rows) {
      if (!ground) return false;
      term.paints++;
      view = [...view];
      for (const r of rows) {
        const sh: string[] = [];
        let col = x;
        let cur = '';
        let text = '';
        for (const part of r.seq.split(/(\x1b\[[0-9;]*m)/)) {
          const m = /^\x1b\[([0-9;]*)m$/.exec(part);
          if (m) { cur = m[1]!.replace(/^0;?/, ''); continue; }
          for (const ch of Array.from(part)) { for (let k = 0; k < w(ch); k++) sh[col++] = cur; text += ch; }
        }
        vShade.set(r.line, sh);
        view[r.line] = `${(view[r.line] ?? '').slice(0, x).padEnd(x)}${text}`.trimEnd();
      }
      return true;
    },
    set(next, shown = next) { truth = [...next]; view = [...shown]; tShade = new Map(); vShade = new Map(); fire(); },
    setView(next) { view = [...next]; fire(); },
    select(line, x0, x1, sh) {
      // 中のアプリが選択の色で英語を描き直した。
      const row = [...(tShade.get(line) ?? [])];
      for (let x = x0; x < x1; x++) row[x] = sh;
      tShade.set(line, row);
      vShade.set(line, [...row]);
      view = [...view];
      view[line] = truth[line]!;
      fire();
    },
    viewShade: (line) => vShade.get(line) ?? [],
    viewCode: (line) => vShade.get(line) ?? [],
    setGround(v) { ground = v; },
    mark(line) { const m: FakeMarker = { line, isDisposed: false, dispose() { m.isDisposed = true; m.line = -1; } }; return m; },
    decorate(marker, box) {
      const subs = new Set<(el: HTMLElement) => void>();
      const d: FakeDeco = { marker: marker as FakeMarker, box, glow: !!box.glow, isDisposed: false, el: {} as HTMLElement, render() { for (const cb of subs) cb(d.el); }, onRender(cb) { subs.add(cb); return { dispose: () => subs.delete(cb) }; }, dispose() { d.isDisposed = true; } };
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
    expect(term.decos.filter((d) => !d.glow).map((d) => [d.marker.line, d.box]).sort()).toEqual([[2, { x: 78, width: 2 }], [5, { x: 78, width: 2 }]]);
    // 訳を待つ段落には、本文の幅いっぱいに光を重ねる。
    expect(term.decos.filter((d) => d.glow && !d.isDisposed).map((d) => [d.marker.line, d.box]).sort()).toEqual([[2, { x: 2, width: 76, height: 2, glow: true }], [5, { x: 2, width: 76, height: 2, glow: true }]]);
    t.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(term.decos.filter((d) => d.glow && !d.isDisposed)).toEqual([]);
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

  it('スクロールで訳ごと行が上へずれただけなら、書き直さずにアイコンを付いていかせる', async () => {
    const term = fakeTerm(screen(2));
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    const paints = term.paints;
    // 影は英語のまま 1 行ずれ、見える端末は訳のまま 1 行ずれた。
    term.set(screen(1), term.now().slice(1));
    expect(term.paints).toBe(paints);
    expect(term.now()[1]).toContain('ビルド');
    expect(term.decos.filter((d) => !d.isDisposed && !d.glow).map((d) => d.marker.line)).toEqual([1]);
    o.dispose();
  });

  it('アプリが英語で描き直すと、描かれる前の突き合わせで訳に戻す（待たない）', () => {
    const term = fakeTerm(screen(2));
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    term.set(screen(1));
    expect(term.now()[1]).toContain('ビルド');
    o.dispose();
  });

  it('行の一部だけが英語で描き直されて訳と混ざっても、影の英語から段落を探して訳に戻す', () => {
    const term = fakeTerm(screen(2));
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    const mixed = term.now().slice();
    mixed[2] = '⏺ The build passed on 5つのジョブすべてで通り、枝は';
    term.setView(mixed);
    expect(term.now()[2]).toBe('⏺ ビルドは5つのジョブすべてで通り、枝はマージできる。');
    o.dispose();
  });

  it('訳の行を中のアプリが選択の色で描いたら、同じ桁の訳の文字に色を移す。選択が外れたら色も外す', () => {
    const term = fakeTerm(screen(2));
    const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {});
    o.setReplies([A]);
    // 2 行目の 4〜9 桁と、3 行目（訳では空いた行）の 2〜12 桁を選んだ。
    term.select(2, 4, 10, '48;5;30');
    expect(term.now()[2]).toContain('ビルド');
    expect(term.viewShade(2).slice(2, 12)).toEqual(['', '', '48;5;30', '48;5;30', '48;5;30', '48;5;30', '48;5;30', '48;5;30', '', '']);
    term.select(3, 2, 12, '7');
    expect(term.now()[3]).toBe('');
    expect(term.viewShade(3).slice(2)).toEqual(Array<string>(10).fill('7'));
    // 選択が外れた（中のアプリが英語を色なしで描き直した）。
    term.set(screen(2));
    expect(term.now()[2]).toContain('ビルド');
    expect(term.viewShade(2).filter(Boolean)).toEqual([]);
    o.dispose();
  });

  it('全角の文字が選択の境にまたがれば、文字の左の桁の色にそろえる', () => {
    expect(shadeRow('あいう', ['', 'x', 'x', 'x', '', ''], (ch) => w(ch))).toEqual({ seq: 'あ\x1b[0;xmい\x1b[0mう', cols: ['', '', 'x', 'x', '', ''] });
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

  describe('訳が届いたときのにじみ', () => {
    const fade = { from: '#000000', to: '#ffffff' };
    const tinted = (sh: readonly string[]) => sh.some((s) => /(^|;)38;2;/.test(s ?? ''));

    it('待っていた段落に訳が届くと、暗い色から書き、時間とともに明るくして、最後はふつうの色に戻す', async () => {
      const term = fakeTerm(screen(2));
      let clock = 0;
      const t = api({ [A]: JA_A });
      const o = createReplyRewrites(term, t, () => {}, { fade, now: () => clock });
      o.setReplies([A]);
      t.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(term.now()[2]).toContain('ビルド');
      const first = term.viewShade(2).find((s) => /38;2;/.test(s ?? ''));
      expect(first).toBeDefined();
      // 途中では、初めより明るい色で書き直す。
      clock = FADE_MS / 2;
      await vi.advanceTimersByTimeAsync(FADE_FRAME_MS);
      const mid = term.viewShade(2).find((s) => /38;2;/.test(s ?? ''));
      expect(mid).toBeDefined();
      expect(mid).not.toBe(first);
      // 終われば色を外す（端末のふつうの文字の色）。文字は訳のまま。
      clock = FADE_MS * 3;
      await vi.advanceTimersByTimeAsync(FADE_FRAME_MS);
      expect(tinted(term.viewShade(2))).toBe(false);
      expect(term.now()[2]).toContain('ビルド');
      // 動きが終われば、見回りを繰り返さない。
      const paints = term.paints;
      await vi.advanceTimersByTimeAsync(500);
      expect(term.paints).toBe(paints);
      o.dispose();
    });

    it('初めて見えた時に訳が手元にあれば（会話を開いた、先に訳しておいた段落へスクロールした）、にじませずに書く', () => {
      const term = fakeTerm(screen(2));
      const o = createReplyRewrites(term, api({ [A]: JA_A }, { cached: true }), () => {}, { fade, now: () => 0 });
      o.setReplies([A]);
      expect(term.now()[2]).toContain('ビルド');
      expect(tinted(term.viewShade(2))).toBe(false);
      o.dispose();
    });

    it('fade が無ければ（動きを減らす設定）、待っていた段落でもにじませない', async () => {
      const term = fakeTerm(screen(2));
      const t = api({ [A]: JA_A });
      const o = createReplyRewrites(term, t, () => {}, { fade: null, now: () => 0 });
      o.setReplies([A]);
      t.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(term.now()[2]).toContain('ビルド');
      expect(tinted(term.viewShade(2))).toBe(false);
      o.dispose();
    });

    it('下の行ほど遅れて明るくなる', async () => {
      const term = fakeTerm(screen(2), 30);
      let clock = 0;
      const t = api({ [A]: `${JA_A}${JA_A}` });
      const o = createReplyRewrites(term, t, () => {}, { fade, now: () => clock });
      o.setReplies([A]);
      t.settle();
      await vi.advanceTimersByTimeAsync(0);
      clock = FADE_MS + FADE_STAGGER_MS / 2;
      await vi.advanceTimersByTimeAsync(FADE_FRAME_MS);
      // 1 行目は明るくなりきり、2 行目はまだ少し暗い。
      expect(tinted(term.viewShade(2))).toBe(false);
      expect(tinted(term.viewShade(3))).toBe(true);
      o.dispose();
    });
  });

  describe('質問の札', () => {
    const Q = 'Both reverse-direction checks passed (answering Windows Codex and opencode cards). What should I do with this session?';
    const D = 'The release is finished. The mobile check stays recorded in memory as unverified.';
    const JQ = '逆向きの確かめは2つとも通りました。このセッションをどうしますか？';
    const JD = 'リリースは済みました。スマホの確かめは未確認として残ります。';
    const card = () => ['──────────', ' ☐ Session', '', '│ Both reverse-direction checks passed (answering Windows Codex and opencode cards).', '│ What should I do with this session?', '', '❯ 1. Done', '     The release is finished. The mobile check stays recorded in memory as unverified.', '  2. Paused', '──────────'];

    it('問いは │ の内側から、説明は字下げの後ろから訳で書き、元の文字の色と飾りを付けて書く。選択肢の名前は触らない', () => {
      const term = fakeTerm(card(), 90);
      term.setStyle(3, 2, { sgr: '1;38;5;231', rgb: '#ffffff' });
      term.setStyle(7, 5, { sgr: '38;5;246', rgb: '#949494' });
      const o = createReplyRewrites(term, api({ [Q]: JQ, [D]: JD }, { cached: true }), () => {});
      o.setReplies([]);
      o.setFields([Q, D]);
      expect(term.now().slice(3, 9)).toEqual([`│ ${JQ}`, '│', '', '❯ 1. Done', `     ${JD}`, '  2. Paused']);
      expect(term.viewCode(3)[2]).toBe('1;38;5;231');
      expect(term.viewCode(7)[5]).toBe('38;5;246');
      // 札にはアイコンを置かない。
      expect(term.decos.filter((d) => !d.glow)).toEqual([]);
      o.dispose();
      expect(term.now()[3]).toContain('Both reverse');
    });

    it('待つ間は札の文の幅に光を重ね、届いたら元の文字の色へ向かってにじませる', async () => {
      const term = fakeTerm(card(), 90);
      term.setStyle(7, 5, { sgr: '38;5;246', rgb: '#949494' });
      let clock = 0;
      const t = api({ [D]: JD });
      const o = createReplyRewrites(term, t, () => {}, { fade: { from: '#000000', to: '#ffffff' }, now: () => clock });
      o.setReplies([]);
      o.setFields([D]);
      expect(term.decos.filter((d) => d.glow && !d.isDisposed).map((d) => [d.marker.line, d.box])).toEqual([[7, { x: 5, width: 84, height: 1, glow: true }]]);
      t.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(term.now()[7]).toBe(`     ${JD}`);
      expect(term.viewCode(7)[5]).toMatch(/^38;5;246;38;2;/);
      clock = FADE_MS * 3;
      await vi.advanceTimersByTimeAsync(FADE_FRAME_MS);
      expect(term.viewCode(7)[5]).toBe('38;5;246');
      // 色が #949494 に収まる（白へは行かない）ことは、終わる直前の色で見る。
      expect(fadeCode({ from: '#000000', to: '#ffffff' }, FADE_MS - 1, '#949494')).toMatch(/^38;2;14[0-9];14[0-9];14[0-9]$/);
      o.dispose();
    });
  });
});
