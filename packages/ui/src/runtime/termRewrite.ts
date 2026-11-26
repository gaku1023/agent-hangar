import { findReplyRange, type Keep, type ReplyRange } from './termReplyMatch.ts';

/**
 * ターミナルの英語の返答のマスを、日本語の訳で直に上書きする（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 行の数は変えない。訳を英語と同じ行の数に折り返し、余りは空白にし、はみ出しは末尾を … で切る。
 * 訳は端末の本物の文字になるので、選択もコピーも日本語で取れる。
 * 探す元と書き戻す元は、同じ出力を訳を書かずに読んだ影の端末（英語の本当の画面）にする。
 * 出力を読み終えるたびに、描かれる前に、見えている行をあるべき行に合わせる。英語が一瞬も描かれない。
 */

export type RewriteMarker = { readonly line: number; readonly isDisposed: boolean; dispose(): void };
export type RewriteDecoration = { readonly isDisposed: boolean; onRender(cb: (el: HTMLElement) => void): { dispose(): void }; dispose(): void };

/** 上書きに要る、xterm のうちの一部（runtime/xtermRewrite.ts が作る。試験では偽物を使う）。 */
export type RewriteTerm = {
  readonly cols: number;
  /** いまの画面（使っている方の buffer）の全部の行の文字（右の空白は落とす）。添字は buffer の行の番号。 */
  lines(): readonly string[];
  /** buffer の行の、x 桁目から右の文字（右の空白は落とす）。 */
  cellsFrom(line: number, x: number): string;
  /** buffer の行の、x0 桁目から x1 桁目の手前までの文字。 */
  cellsRange(line: number, x0: number, x1: number): string;
  /** 文字の列が端末で占める桁の数。 */
  width(s: string): number;
  /**
   * buffer の行の x0 桁目から x1 桁目の手前までの、桁ごとの選択の色（背景の色と反転だけの SGR の引数。無ければ空）。
   * truth は影の端末（中のアプリが選択を描いた英語）、view は見えている端末。
   */
  shades(line: number, x0: number, x1: number, from: 'truth' | 'view'): string[];
  /** buffer の行の x 桁目から右を、色と飾りごと書き戻せる列にする（原文に戻すため）。 */
  snapshot(line: number, x: number): string;
  /**
   * buffer の行の x 桁目から右を書き換える。seq は、そのまま端末へ流す列（文字と SGR）。行の残りは消す。
   * 見えていない行と、出力がエスケープの途中で切れているときは書かずに false を返す（次の見回りでやり直す）。
   */
  paint(x: number, rows: readonly { line: number; seq: string; keep?: Keep }[]): boolean;
  /** buffer の行に印を付ける。付けられなければ null。 */
  mark(line: number): RewriteMarker | null;
  /**
   * 印の行の x 桁目から、width 桁、height 行（無ければ 1 行）の板を付ける。
   * 原文に戻すアイコンを置く板と、glow なら訳を待つ段落に重ねる光（押せない）。
   */
  decorate(marker: RewriteMarker, box: { x: number; width: number; height?: number; glow?: boolean }): RewriteDecoration | null;
  /**
   * 端末が OSC 52 で写したもの（Claude Code の選択や tmux のコピーモードの写し）を、クリップボードへ書く前に通す口。null で外す。
   * drag は、写しの直前に端末の上でドラッグした範囲（無ければ null）。
   */
  setCopyMap(map: ((text: string, drag: CopyDrag | null) => string) | null): void;
  /**
   * 中身か寸法が変わったら呼ぶ。出力を読み終えたときは、描かれる前に呼ぶ（そこで書けば英語が一瞬も出ない）。
   * lines と snapshot は英語の本当の画面（訳を書いていない影の端末）を返し、cellsFrom と cellsRange は見えている端末を返す。
   */
  onChange(cb: () => void): { dispose(): void };
};

/** 端末の上でドラッグした範囲。x は桁、y は buffer の行の番号。 */
export type CopyDrag = { start: { x: number; y: number }; end: { x: number; y: number } };

/** 返答ごとの様子。wait は訳を待っている、ja は訳を書いた、orig は利用者が原文に戻した。 */
export type ReplyState = 'wait' | 'ja' | 'orig';
/** アイコンを置いた返答。el は xterm が板を描くまで null。 */
export type PlacedReply = { text: string; state: ReplyState; el: HTMLElement | null };

/**
 * 訳が届いたときのにじみ（2026-11-26 の試作で利用者が「にじみ」の「ゆっくり」を選んだ）。
 * 待っていた段落に訳が届いたら、訳を暗い色で書き、FADE_MS かけてふつうの文字の色まで明るくする。下の行ほど FADE_STAGGER_MS ずつ遅らせる。
 * 文字は最初から訳のままで、色だけを書き直す。動く間は FADE_FRAME_MS ごとに見回る。
 */
export const FADE_MS = 480;
export const FADE_STAGGER_MS = 60;
export const FADE_FRAME_MS = 16;
/** にじみの始まりの明るさ（背景の色から文字の色までのうちの割合）。 */
const FADE_START = 0.25;

/** にじみの色。端末の背景の色と文字の色（#rrggbb）。null ならにじませない（動きを減らす設定）。 */
export type RewriteFade = { from: string; to: string } | null;
export type RewriteOptions = { fade?: RewriteFade; now?: () => number };

const rgbOf = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null;
};

/** にじみの経過 ms から、文字の色の SGR の引数を返す。終わっていれば空（ふつうの色）。 */
export function fadeCode(fade: RewriteFade, elapsed: number): string {
  if (!fade || elapsed >= FADE_MS) return '';
  const a = rgbOf(fade.from);
  const b = rgbOf(fade.to);
  if (!a || !b) return '';
  const t = Math.max(0, elapsed) / FADE_MS;
  const k = FADE_START + (1 - FADE_START) * (1 - (1 - t) ** 3);
  const c = a.map((x, i) => Math.round(x + (b[i]! - x) * k));
  return `38;2;${c[0]};${c[1]};${c[2]}`;
}

/** 出力が流れ続けるときに、最初の変化から見回りまで待つ上限。 */
export const REWRITE_DELAY_MS = 120;
/** 書き込みの最中で書けなかったときに、もう一度見るまでの間。 */
const RETRY_MS = 16;
/** 書き換える左端。Claude Code は返答の印（⏺）を 1 桁目に置き、本文を 2 桁字下げする。印は残し、本文だけを書き換える。 */
export const INDENT = 2;
/** アイコンの板の幅（桁）。 */
const BUTTON_COLS = 2;

/** 行を width 桁に収め、はみ出すなら末尾を … にし、足りなければ空白で width 桁まで埋める。 */
export function clipCells(row: string, width: number, cellWidth: (ch: string) => number): string {
  if (width <= 0) return '';
  let out = '';
  let w = 0;
  const chars = Array.from(row);
  const total = chars.reduce((n, ch) => n + cellWidth(ch), 0);
  if (total <= width) return row + ' '.repeat(width - total);
  for (const ch of chars) {
    const cw = cellWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…${' '.repeat(Math.max(0, width - w - 1))}`;
}

/**
 * 訳の行に、中のアプリが描いた選択の色を移す。shades は本文の左端からの桁ごとの色（影の端末の同じ桁）。
 * 全角の文字は左の桁の色にそろえる。文字の後ろも、選択の色が続く桁までは空白に色を付けて埋める。
 * seq は端末へ流す列、cols は書いたあとの桁ごとの色（見えている端末と比べるため）。
 */
export function shadeRow(row: string, shades: readonly string[], cellWidth: (ch: string) => number, fg = ''): { seq: string; cols: string[] } {
  let seq = '';
  let cur = '';
  const cols: string[] = shades.map(() => '');
  let c = 0;
  // fg は文字の色（訳が届いたときのにじみ）。選択の色と一緒に毎回付け直す（\x1b[0m で外れるため）。
  const codeOf = (sh: string) => [sh, fg].filter(Boolean).join(';');
  const put = (ch: string, cw: number) => {
    const sh = shades[c] ?? '';
    const code = codeOf(sh);
    if (code !== cur) { seq += code ? `\x1b[0;${code}m` : '\x1b[0m'; cur = code; }
    seq += ch;
    for (let k = 0; k < cw && c + k < cols.length; k++) cols[c + k] = sh;
    c += cw;
  };
  for (const ch of Array.from(row)) put(ch, cellWidth(ch));
  let last = -1;
  shades.forEach((sh, n) => { if (sh) last = n; });
  while (c <= last) put(' ', 1);
  if (cur) seq += '\x1b[0m';
  return { seq, cols };
}

/** Markdown の記号を、Claude Code が画面で落とす分だけ落とす。 */
export function plainOf(md: string): string {
  return md
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    // 端末の制御になる文字は書かない。
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** 幅 width の桁に折り返す。続く空行は 1 つにまとめ、頭と末尾の空行は落とす。 */
export function wrapCells(text: string, width: number, cellWidth: (ch: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    let w = 0;
    for (const ch of Array.from(para.trimEnd())) {
      const cw = cellWidth(ch);
      if (w + cw > width && cur !== '') {
        out.push(cur);
        cur = '';
        w = 0;
        if (ch === ' ') continue;
      }
      cur += ch;
      w += cw;
    }
    out.push(cur);
  }
  const rows = out.filter((l, i) => !(l === '' && out[i - 1] === ''));
  while (rows[0] === '') rows.shift();
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/**
 * 訳の行を height 行に収める。
 * 短ければ下を空ける。cut（返答の頭が画面の上に切れていて、見えているのは英語の下の部分）なら、訳の末尾を下端にそろえて上を空ける。
 * 長ければ、cut でなければ下を切って最後の行の末尾を …、cut なら上を切って最初の行を … にする。
 */
export function fitRows(rows: readonly string[], height: number, cut: boolean): string[] {
  if (height <= 0) return [];
  if (rows.length <= height) {
    const pad = Array<string>(height - rows.length).fill('');
    return cut ? [...pad, ...rows] : [...rows, ...pad];
  }
  if (cut) return ['…', ...rows.slice(rows.length - height + 1)];
  const head = rows.slice(0, height);
  head[height - 1] = `${Array.from(head[height - 1]!).slice(0, -1).join('')}…`;
  return head;
}


/** 書いた訳。text はまとめた段落の鍵をつないだもの、keys はその段落の鍵。 */
type Painted = { text: string; reply: string; keys: string[]; line: number; ja: string[]; enSeq: string[]; keep?: Keep };
/** 訳して書く単位。返答を空の行で段落に分けたもの。head は返答の最初の段落（印の行から始まる）。 */
type Unit = { key: string; reply: string; head: boolean };

/** 段落の列の短い下限。これより短い段落（見出し、短い前置き）は次の段落とまとめる。 */
const MIN_BLOCK = 40;

/**
 * 返答を段落に分ける。スクロールの途中は返答の一部しか見えないので、段落ごとに訳して、見えている段落を書き換える。
 * コードの囲み（```）の中では分けない。短い段落は次とまとめる。
 */
export function splitBlocks(reply: string): string[] {
  const raw: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of reply.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && line.trim() === '') { if (cur.length) raw.push(cur.join('\n')); cur = []; continue; }
    cur.push(line);
  }
  if (cur.length) raw.push(cur.join('\n'));
  const out: string[] = [];
  let carry = '';
  for (const b of raw) {
    const joined = carry ? `${carry}\n\n${b}` : b;
    if (joined.replace(/[^\p{L}\p{N}]+/gu, '').length < MIN_BLOCK) { carry = joined; continue; }
    out.push(joined);
    carry = '';
  }
  if (carry) { if (out.length) out[out.length - 1] = `${out[out.length - 1]}\n\n${carry}`; else out.push(carry); }
  return out;
}
type Spot = { text: string; line: number; state: ReplyState; marker: RewriteMarker; deco: RewriteDecoration; el: HTMLElement | null; sub: { dispose(): void } };

export type TranslateFn = { cached(text: string): string | null; translate(text: string): Promise<string | null> };

export function createReplyRewrites(term: RewriteTerm, api: TranslateFn, onPlaced: (list: PlacedReply[]) => void, opts: RewriteOptions = {}) {
  const fade = opts.fade ?? null;
  const now = opts.now ?? (() => performance.now());
  /** 前の見回りで訳を待っていた段落の鍵。ここから訳を書いたら、にじませる。 */
  let wasWaiting = new Set<string>();
  /** にじませている段落のまとまり（鍵をつないだもの）と、始めた時刻。 */
  const fades = new Map<string, number>();
  /** 行ごとに、いま書いてある文字の色（にじみの途中の色。ふつうの色なら無い）。 */
  let tints = new Map<number, string>();
  let replies: string[] = [];
  let units: Unit[] = [];
  let orig = new Set<string>();
  /** 訳。null は訳せなかったこと。無ければまだ訳していない。 */
  const ja = new Map<string, string | null>();
  const asked = new Set<string>();
  const painted = new Map<string, Painted>();
  const spots = new Map<string, Spot>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 前の突き合わせで訳を書いた行。もう訳を書かないときに英語を書き戻すため。 */
  let touched = new Set<number>();
  /** 同じ英語の画面なら、段落の探し直しを省く。 */
  let lastKey = '';
  let lastRanges = new Map<Unit, ReplyRange | null>();
  let dead = false;

  const kick = (ms = REWRITE_DELAY_MS) => {
    if (dead || timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, ms);
  };

  const translated = (text: string): string | null | undefined => {
    if (ja.has(text)) return ja.get(text);
    const hit = api.cached(text);
    if (hit !== null) { ja.set(text, hit); return hit; }
    if (!asked.has(text)) {
      asked.add(text);
      void api.translate(text).then((out) => { ja.set(text, out); kick(0); }, () => { ja.set(text, null); });
    }
    return undefined;
  };

  const emit = () => {
    if (dead) return;
    onPlaced(replies.flatMap((text) => { const s = spots.get(text); return s ? [{ text, state: s.state, el: s.el }] : []; }));
  };
  /** 訳を待つ段落に重ねた光。鍵は「頭の行:行の数」。 */
  const glows = new Map<string, { marker: RewriteMarker; deco: RewriteDecoration }>();
  const dropGlow = (k: string) => { const g = glows.get(k); if (!g) return; g.deco.dispose(); g.marker.dispose(); glows.delete(k); };
  /** 光を、待つ段落の範囲（spans）にだけ置く。同じ範囲に置いたものはそのまま残す（光の動きを途切れさせない）。 */
  const setGlows = (spans: readonly { start: number; end: number }[], width: number) => {
    const want = new Map(spans.map((r) => [`${r.start}:${r.end - r.start + 1}`, r]));
    for (const [k, g] of [...glows]) if (!want.has(k) || g.marker.isDisposed || g.deco.isDisposed) dropGlow(k);
    for (const [k, r] of want) {
      if (glows.has(k)) continue;
      const marker = term.mark(r.start);
      if (!marker) continue;
      const deco = term.decorate(marker, { x: INDENT, width, height: r.end - r.start + 1, glow: true });
      if (!deco) { marker.dispose(); continue; }
      glows.set(k, { marker, deco });
    }
  };
  const dropSpot = (s: Spot) => { s.sub.dispose(); s.deco.dispose(); s.marker.dispose(); spots.delete(s.text); };
  /** アイコンを返答の頭の行に置く。同じ行に同じ様子で置いてあれば触らない。 */
  const place = (text: string, line: number, state: ReplyState): boolean => {
    const had = spots.get(text);
    if (had && !had.marker.isDisposed && had.marker.line === line) {
      if (had.state === state) return false;
      had.state = state;
      return true;
    }
    if (had) dropSpot(had);
    const marker = term.mark(line);
    if (!marker) return !!had;
    const deco = term.decorate(marker, { x: Math.max(0, term.cols - BUTTON_COLS), width: BUTTON_COLS });
    if (!deco) { marker.dispose(); return !!had; }
    const s: Spot = { text, line, state, marker, deco, el: null, sub: { dispose() {} } };
    s.sub = deco.onRender((el) => { if (s.el === el) return; s.el = el; emit(); });
    spots.set(text, s);
    return true;
  };

  /**
   * 見回り（突き合わせ）。
   * 英語の本当の画面（lines、訳を書いていない影の端末の中身）から返答の段落を探し、同じ返答の続いた段落をまとめて、訳を上から流し込んだ行を「あるべき行」にする。
   * 見えている端末の行があるべき行と違えば書く。前に訳を書いた行で、もう訳を書かない行は、影の端末の英語を色ごと書き戻す。
   * 英語の本当の中身を影に持つので、tmux が差分だけを送って訳と英語が混ざっても、次の突き合わせで直る（tmux に描き直させない）。
   * 出力を読み終えるたびに描かれる前に呼ばれるので（runtime/xterm.ts の afterWrite）、英語が一瞬出ることもない。
   */
  const scan = () => {
    if (dead) return;
    const lines = term.lines();
    // 右端の桁はアイコンのために空けておく（本文に重ねない）。
    const width = Math.max(1, term.cols - INDENT - BUTTON_COLS);
    const cellW = (ch: string) => term.width(ch);
    let changed = false;
    let retry = false;
    const want = new Map<string, { line: number; state: ReplyState }>();
    const put = (reply: string, line: number, state: ReplyState) => { const w = want.get(reply); if (!w || line < w.line) want.set(reply, { line, state }); };

    // 段落を探す。新しい返答から探す（同じ文の取り合いで新しい方を取る）。
    type Found = { u: Unit; idx: number; range: ReplyRange };
    const found: Found[] = [];
    const taken: [number, number][] = [];
    const overlaps = (a: number, b: number) => taken.some(([s0, e0]) => a <= e0 && s0 <= b);
    const idxOf = new Map<Unit, number>();
    for (const r of replies) units.filter((u) => u.reply === r).forEach((u, n) => idxOf.set(u, n));
    const key = lines.join('\n');
    const ranges = key === lastKey ? lastRanges : new Map<Unit, ReplyRange | null>();
    for (const u of [...units].reverse()) {
      let range = ranges.get(u);
      if (range === undefined) { range = findReplyRange(lines, u.key, { head: u.head }); ranges.set(u, range); }
      if (!range || overlaps(range.start, range.end)) continue;
      taken.push([range.start, range.end]);
      found.push({ u, idx: idxOf.get(u)!, range });
    }
    lastKey = key;
    lastRanges = ranges;

    // 同じ返答で、続いた段落（間は空の行だけ）をまとめる。
    found.sort((a, b) => a.range.start - b.range.start);
    const groups: Found[][] = [];
    for (const f of found) {
      const g = groups[groups.length - 1];
      const last = g?.[g.length - 1];
      if (g && last && last.u.reply === f.u.reply && f.idx === last.idx + 1 && f.range.start - last.range.end <= 2 && !last.range.keep) g.push(f);
      else groups.push([f]);
    }

    // あるべき行を決める。
    const desired = new Map<number, { text: string; seq: string; cols: string[]; keep?: Keep; fg: string }>();
    const at = now();
    const nowWaiting = new Set<string>();
    let fading = false;
    const nextPainted = new Map<string, Painted>();
    const waiting: { start: number; end: number }[] = [];
    for (const g of groups) {
      const reply = g[0]!.u.reply;
      const start = g[0]!.range.start;
      const end = g[g.length - 1]!.range.end;
      if (orig.has(reply)) { put(reply, start, 'orig'); continue; }
      const outs = g.map((f) => translated(f.u.key));
      if (outs.some((o) => o === undefined)) { put(reply, start, 'wait'); waiting.push({ start, end }); for (const f of g) nowWaiting.add(f.u.key); continue; }
      if (outs.every((o) => o === null)) continue;
      const body: string[] = [];
      g.forEach((f, n) => {
        if (n > 0) body.push('');
        body.push(...wrapCells(plainOf(outs[n] ?? f.u.key), width, cellW));
      });
      const height = end - start + 1;
      const keep = g[g.length - 1]!.range.keep;
      const rows = fitRows(body, height, g[0]!.range.cut === true);
      // 札（Jump to bottom）の重なった最後の行は、札より左に収まるように切り、空白で札の手前まで埋める。札は残し、札より右は消す。
      if (keep) rows[rows.length - 1] = clipCells(rows[rows.length - 1]!, keep.from - INDENT, cellW);
      const keys = g.map((f) => f.u.key);
      const text = keys.join('\u0000');
      // 待っていた段落に訳が届いた。にじませ始める。
      if (fade && !fades.has(text) && keys.some((k) => wasWaiting.has(k))) fades.set(text, at);
      const t0 = fades.get(text);
      if (t0 !== undefined && at - t0 >= FADE_MS + FADE_STAGGER_MS * (rows.length - 1)) fades.delete(text);
      // 中のアプリが選択を描いていれば（影の端末の同じ桁の背景と反転）、その色を訳の文字に移す。選んだことが見えるように。
      rows.forEach((r, n) => {
        const k = keep && n === rows.length - 1 ? keep : undefined;
        const right = k ? k.from : INDENT + width;
        const fg = t0 === undefined ? '' : fadeCode(fade, at - t0 - n * FADE_STAGGER_MS);
        if (fg) fading = true;
        const { seq, cols } = shadeRow(r, term.shades(start + n, INDENT, right, 'truth'), cellW, fg);
        desired.set(start + n, { text: r, seq, cols, keep: k, fg });
      });
      nextPainted.set(text, { text, reply, keys, line: start, ja: rows, enSeq: [], keep });
      put(reply, start, 'ja');
    }

    // 見えている行を、あるべき行に合わせる。
    const visibleOf = (line: number, keep?: Keep) => (keep ? term.cellsRange(line, INDENT, keep.from) : term.cellsFrom(line, INDENT)).trimEnd();
    const writes: { x: number; line: number; seq: string; keep?: Keep }[] = [];
    const sameShades = (line: number, cols: readonly string[]) => term.shades(line, INDENT, INDENT + cols.length, 'view').every((sh, n) => sh === cols[n]);
    for (const [line, d] of desired) if (visibleOf(line, d.keep) !== d.text.trimEnd() || !sameShades(line, d.cols) || (tints.get(line) ?? '') !== d.fg) writes.push({ x: INDENT, line, seq: d.seq, keep: d.keep });
    // 前に訳を書いた行で、もう訳を書かない行は、英語の本当の中身（影の端末）を行の頭から書き戻す。
    for (const line of touched) if (!desired.has(line) && term.cellsFrom(line, 0) !== (lines[line] ?? '').trimEnd()) writes.push({ x: 0, line, seq: term.snapshot(line, 0) });
    if (writes.length > 0) {
      const ja = writes.filter((w) => w.x === INDENT);
      const en = writes.filter((w) => w.x === 0);
      const jaOk = ja.length === 0 || term.paint(INDENT, ja);
      const ok = jaOk && (en.length === 0 || term.paint(0, en));
      if (!ok) retry = true;
      if (jaOk) for (const w of ja) { const fg = desired.get(w.line)!.fg; if (fg) tints.set(w.line, fg); else tints.delete(w.line); }
    }
    tints = new Map([...tints].filter(([line]) => desired.has(line)));
    wasWaiting = nowWaiting;
    touched = new Set([...desired.keys()].concat(retry ? [...touched] : []));
    painted.clear();
    for (const [k, v] of nextPainted) painted.set(k, v);

    setGlows(waiting, width);
    for (const [reply, w] of want) changed = place(reply, w.line, w.state) || changed;
    for (const s0 of [...spots.values()]) if (!want.has(s0.text)) { dropSpot(s0); changed = true; }
    if (changed) emit();
    if (retry) kick(RETRY_MS);
    else if (fading) kick(FADE_FRAME_MS);
  };

  /**
   * ドラッグで写したもの（OSC 52）を、画面に見えている文字に取り直す。
   * 写しを作るのは中のアプリ（Claude Code の選択、tmux のコピーモード）で、どちらも英語の本文から写す。
   * ドラッグの範囲が訳を書いた行にかかっていれば、その範囲のマスの文字（訳）を写しにする。かかっていなければ写しのまま。
   * 訳の行は折り返しなので、同じ返答の中の続く行は改行を挟まずにつなぎ、字下げ（印の 2 桁）は落とす。
   */
  const mapCopy = (copied: string, drag: CopyDrag | null): string => {
    if (!drag) return copied;
    const [a, b] = drag.start.y < drag.end.y || (drag.start.y === drag.end.y && drag.start.x <= drag.end.x) ? [drag.start, drag.end] : [drag.end, drag.start];
    if (a.y === b.y && a.x === b.x) return copied;
    const owner = (y: number) => [...painted.values()].find((p) => !orig.has(p.reply) && y >= p.line && y < p.line + p.ja.length) ?? null;
    let hit = false;
    for (let y = a.y; y <= b.y && !hit; y++) hit = owner(y) !== null;
    if (!hit) return copied;
    let out = '';
    let prev: { p: Painted | null; text: string } | null = null;
    for (let y = a.y; y <= b.y; y++) {
      const p = owner(y);
      const from = Math.max(y === a.y ? a.x : 0, p ? INDENT : 0);
      const to = y === b.y ? b.x + 1 : term.cols;
      const text = term.cellsRange(y, from, to).trimEnd();
      if (prev) out += prev.p && prev.p === p && prev.text !== '' && text !== '' ? '' : '\n';
      out += text;
      prev = { p, text };
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
  };
  term.setCopyMap(mapCopy);

  // 出力を読み終えるたびに、描かれる前に突き合わせる（runtime/xterm.ts）。
  const change = term.onChange(() => scan());

  return {
    /** 訳を書く返答（古い順）。同じ中身を渡し直しても見直さない。 */
    setReplies(next: readonly string[]) {
      if (next.length === replies.length && next.every((x, n) => x === replies[n])) return;
      replies = [...next];
      units = replies.flatMap((reply) => splitBlocks(reply).map((key, n) => ({ key, reply, head: n === 0 })));
      // 段落の訳を先に頼んでおく。スクロールで初めて見えた段落が、訳の届くまで英語で出るのを避けるため。
      // 翻訳は後から頼んだものを先に訳す（後入れ先出し）ので、古い順に頼み、新しい返答から訳されるようにする。
      for (const u of units) translated(u.key);
      scan();
    },
    /** 原文に戻した返答。 */
    setOriginal(next: ReadonlySet<string>) {
      orig = new Set(next);
      scan();
    },
    dispose() {
      dead = true;
      if (timer) clearTimeout(timer);
      change.dispose();
      term.setCopyMap(null);
      for (const s of [...spots.values()]) dropSpot(s);
      for (const k of [...glows.keys()]) dropGlow(k);
      // 外すとき（設定を切った、タブを閉じた）は、書いた訳を英語に戻しておく。
      term.paint(0, [...touched].map((line) => ({ line, seq: term.snapshot(line, 0) })));
      touched.clear();
      painted.clear();
    },
  };
}
