/**
 * ターミナルの画面の行から、AI の返答が描かれている行の範囲を探す（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 *
 * Claude Code は返答の頭の行に ⏺ を付け、Markdown を整形して（見出しの #、強調の **、コードの ` を落とし、箇条書きの記号と番号を残して）、2 桁字下げして折り返す。
 * そこで、返答の本文と画面の行の両方を、文字と数字だけの列（replyStream）にして突き合わせる。
 * 空白、記号、折り返しの位置、Markdown の記号の違いは、この列では消える。
 *
 * 規則：
 * - 始まりは、最初の文字が返答の印（⏺、●、•）の行に限る。入力欄（❯）やツールの行からは始めない。
 * - そこから下へ 1 行ずつ、行の列が返答の列の続きになっているかを見る。空の行（空行、罫線だけの行）は飛ばす。
 * - 返答の列を最後まで読み切った行で終わる。その行の後ろに付いた飾り（「 · summary」など）は許す。
 * - 画面で落ちた短いかけら（リンクの URL など）は、返答の列の側で SKIP_MAX 字まで飛ばしてよい。飛ばした合計は、SKIP_MAX 字か返答の 1 割の多い方まで。
 * - 表は、セルが列の中で折り返すので、罫線で区切られた行の塊ごとに列の順へ並べ直してから読む（lineStreams）。
 * - 途中で続かなくなったら、その始まりは捨てる。下が切れたものは見つからない。
 * - 頭が画面の上に切れたもの（cut）は、画面のいちばん上の文字のある行を、返答の列の途中（その行の列が現れる所）から読み始め、返答の終わりまで読み切れたら見えている範囲を返す。見えている部分の列が MIN_CUT 字に満たないものは扱わない。
 * - 同じ返答が何度も見つかったら、いちばん下（新しい）を返す。
 */

/** 返答の印。Claude Code は ⏺ を使う。ほかの印は、ほかのエージェントや版の違いに備える。 */
const BULLETS = new Set(['⏺', '●', '•']);
/** 突き合わせる返答の列の長さの下限。短い返答は取り違えやすいので扱わない。 */
export const MIN_STREAM = 24;
/** 頭が切れた返答で、見えている部分の列の長さの下限。返答の途中のどこからでも合いうるので、MIN_STREAM より厳しくする。 */
export const MIN_CUT = 40;
/** 札の重なった頭の 1 行だけが見えているとき、札より左で合わせる字数の下限。 */
const MIN_PILL = 12;
/** 画面の上の端に残った段落の終わりのかけらを、段落の終わりと合わせる字数の下限（空の行が続くことも条件にする）。 */
const MIN_TAIL = 6;
/** 画面で落ちたかけらとして飛ばしてよい長さ（返答の列の字数）。 */
const SKIP_MAX = 120;
/** 飛ばした先を探すときに合わせる字数。 */
const SKIP_PROBE = 6;

/** 文字と数字だけを小文字で残した列。 */
export function replyStream(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 行の頭が返答の印か（字下げは許さない。Claude Code は印を 1 桁目に置く）。 */
function startsReply(line: string): boolean {
  return BULLETS.has(Array.from(line)[0] ?? '');
}

/**
 * 行の列 line を、返答の列 r の pos から読み進める。
 * 読み進めた先の位置と飛ばした字数を返す。続かなければ null。
 * r を読み切ったら、行の残り（飾り）は見ない。
 */
function consume(line: string, r: string, pos: number, budget: number): { pos: number; skipped: number } | null {
  let i = 0;
  let j = pos;
  let skipped = 0;
  while (i < line.length) {
    if (j >= r.length) return { pos: j, skipped };
    if (line[i] === r[j]) { i++; j++; continue; }
    const probe = line.slice(i, i + SKIP_PROBE);
    if (probe.length < SKIP_PROBE) return null;
    const at = r.indexOf(probe, j + 1);
    if (at < 0 || at - j > SKIP_MAX || skipped + (at - j) > budget) return null;
    skipped += at - j;
    j = at;
  }
  return { pos: j, skipped };
}

/**
 * start の行から、返答の列の from 字目から読み始める。
 * 読み切れたら最後の行と done: true を返す。読み切る前に続かない行か画面の終わりに来たら、そこまでに読めた最後の行と読めた位置を返す。
 */
function readFrom(lines: readonly string[] /* 行ごとの列（lineStreams） */, start: number, r: string, from = 0): { end: number; pos: number; done: boolean } | null {
  const budget = Math.max(SKIP_MAX, Math.floor(r.length / 10));
  let pos = from;
  let skipped = 0;
  let last: number | null = null;
  for (let k = start; k < lines.length; k++) {
    const s = lines[k]!;
    if (s === '') continue;
    const got = consume(s, r, pos, budget - skipped);
    if (!got) break;
    pos = got.pos;
    skipped += got.skipped;
    last = k;
    if (pos >= r.length) return { end: k, pos, done: true };
  }
  return last === null ? null : { end: last, pos, done: false };
}

/** end の行の後ろで、返答がそれ以上見えないか（画面の終わり、または次の文字のある行が字下げの本文でない、か「Jump to bottom」の行）。 */
function stopsAtEdge(lines: readonly string[], streams: readonly string[], end: number): boolean {
  for (let k = end + 1; k < lines.length; k++) {
    if (streams[k] === '') continue;
    const line = lines[k]!;
    return /Jump to bottom/.test(line) || !/^ {2}/.test(line);
  }
  return true;
}

/** 段落の頭になりうる行か。返答の頭（head）は印の行、続きの段落は空の行の次の字下げした行。 */
function startsBlock(lines: readonly string[], k: number, head: boolean): boolean {
  if (head) return startsReply(lines[k]!);
  return /^ {2}\S/.test(lines[k]!) && (k === 0 || lines[k - 1]!.trim() === '');
}

/**
 * 画面の行（lines、上から順）の中で、返答 reply が描かれている行の範囲を返す。両端を含む。
 * 頭が画面の上に切れて、下の部分だけが見えているときは cut を真にする。
 * 見つからなければ null。
 */
/** 最後の行に重なった Claude Code の札（Jump to bottom）の桁の範囲。from から to の手前までが札。 */
export type Keep = { from: number; to: number };
export type ReplyRange = { start: number; end: number; cut?: true; cutEnd?: true; keep?: Keep };

/** 行に重なった「Jump to bottom」の札の桁。無ければ null（札の行は英語なので、文字の位置と桁は同じ）。 */
export function pillOf(line: string): Keep | null {
  const at = line.indexOf('Jump to bottom');
  if (at < 3) return null;
  const arrow = line.indexOf('↓', at);
  return { from: at - 1, to: arrow < 0 ? line.length : Math.min(line.length, arrow + 2) };
}


export function findReplyRange(lines: readonly string[], reply: string, opts: { head?: boolean } = {}): ReplyRange | null {
  const head = opts.head ?? true;
  const r = replyStream(reply);
  if (r.length < MIN_STREAM) return null;
  const streams = lineStreams(lines);
  let partial: ReplyRange | null = null;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!startsBlock(lines, k, head)) continue;
    if (!streams[k]!.startsWith(r.slice(0, 1))) continue;
    const got = readFrom(streams, k, r);
    if (got?.done) return { start: k, end: got.end };
    // 下が切れたもの（スクロールの途中で、終わりが画面の下か「Jump to bottom」の行に隠れた）。見えている頭の部分を返す。
    // 続かなかった行が返答の続きらしい字下げの行なら、中身が食い違っている（描き直しで変わった）ので扱わない。画面の終わり、区切りの罫線、入力欄、「Jump to bottom」の行で止まったときだけにする。
    if (got && !partial && got.pos >= MIN_CUT && stopsAtEdge(lines, streams, got.end)) {
      partial = { start: k, end: got.end, cutEnd: true };
      // すぐ下の行に「Jump to bottom」の札が重なっているなら、その行も範囲に入れ、札より左だけを書き換える（英語のかけらを残さない）。keep は札の左端の桁。
      const next = lines[got.end + 1] ?? '';
      const pill = pillOf(next);
      if (pill && /^ {2,}\S/.test(next)) partial = { ...partial, end: got.end + 1, keep: pill };
    }
    // 頭の行そのものに札が重なっている（見えているのは頭の 1 行の左だけ）。札より左の文字が返答の頭と合えば、その 1 行を返す。
    if (!partial) {
      const pill = pillOf(lines[k]!);
      const left = pill ? replyStream(Array.from(lines[k]!).slice(0, pill.from).join('')) : '';
      if (pill && left.length >= MIN_PILL && r.startsWith(left) && stopsAtEdge(lines, streams, k)) partial = { start: k, end: k, cutEnd: true, keep: pill };
    }
  }
  if (partial) return partial;
  // 頭が画面の上に切れたもの。上から数行（Claude Code が上に貼り付ける指示の行 ❯ は飛ばす）のどれかが、返答の途中から終わりまで続いていれば、見えている範囲を返す。
  let tried = 0;
  for (let top = 0; top < lines.length && tried < 1; top++) {
    if (streams[top] === '' || lines[top]!.startsWith('❯')) continue;
    tried++;
    // 返答の頭の印の行なら、上の通しの照合で見つかっているはずなので扱わない。続きの段落の頭は、画面の 1 行目に来ると段落の頭と見分けがつかないので、ここでも試す。
    if (head && startsReply(lines[top]!)) continue;
    const first = streams[top]!;
    for (let at = r.indexOf(first); at >= 0 && r.length - at >= MIN_CUT; at = r.indexOf(first, at + 1)) {
      const got = readFrom(streams, top, r, at);
      if (got?.done) return { start: top, end: got.end, cut: true };
    }
    // 画面のいちばん上に、段落の終わりの短いかけら（1 行）だけが残ったもの。英語のかけらを残さないよう、その 1 行を返す（訳は … になる）。
    if (first.length >= MIN_TAIL && first.length < MIN_CUT && r.endsWith(first) && (lines[top + 1] ?? '').trim() === '') return { start: top, end: top, cut: true };
  }
  return null;
}

/**
 * 行ごとの列。
 * 表の行（│ で区切られた行）は、セルが列の中で折り返して次の行へ続く。
 * そこで、区切りの罫線（├ など）までの行をまとめ、列ごとにつないでから左の列から順に並べる。
 * まとめた列はその塊の最後の行に置き、ほかの行は空にする。
 */
export function lineStreams(lines: readonly string[]): string[] {
  const out = lines.map(() => '');
  let k = 0;
  while (k < lines.length) {
    if (!lines[k]!.trimStart().startsWith('│')) { out[k] = replyStream(lines[k]!); k++; continue; }
    const cols: string[] = [];
    let last = k;
    for (; last < lines.length && lines[last]!.trimStart().startsWith('│'); last++) {
      const cells = lines[last]!.trim().split('│').slice(1, -1);
      cells.forEach((c, n) => { cols[n] = (cols[n] ?? '') + replyStream(c); });
    }
    out[last - 1] = cols.join('');
    k = last;
  }
  return out;
}

/** 札の文の範囲。x は文の頭の桁（行の頭の字下げと左の縦線の後ろ）。 */
export type FieldRange = { start: number; end: number; x: number };
/** 札の文の列の長さの下限。頭の桁でも合わせるので、返答より短くてよい。 */
export const MIN_FIELD = 12;
/** 札の問いの左の縦線（Claude Code は │ を 1 桁目に置き、1 桁空けて問いを書く）。 */
const FIELD_PREFIX = /^ *(?:[│┃▏▌] +)? */;

/**
 * 画面の行の中で、質問の札（AskUserQuestion）の文 text が描かれている行の範囲を返す（docs/design.md「英語の返答の翻訳」の質問の札）。
 * 問いは「│ 」の内側から、選択肢の説明は 5 桁の字下げの後ろから描かれる。文の頭は行の頭（字下げと縦線の後ろ）に限り、続く行も同じ桁から始まることを求める。
 * 問いの行は │ で始まるので、表の行と取り違えないよう lineStreams は使わず、行ごとに頭を落として列にする。
 * 同じ文がいくつもあれば、いちばん下（札は画面の下にある）を返す。見つからなければ null。
 */
export function findFieldRange(lines: readonly string[], text: string): FieldRange | null {
  const r = replyStream(text);
  if (r.length < MIN_FIELD) return null;
  const heads = lines.map((l) => FIELD_PREFIX.exec(l)![0].length);
  const streams = lines.map((l, k) => replyStream(l.slice(heads[k])));
  const budget = Math.max(SKIP_MAX, Math.floor(r.length / 10));
  for (let k = lines.length - 1; k >= 0; k--) {
    const first = streams[k]!;
    if (first === '' || !r.startsWith(first.slice(0, Math.min(first.length, SKIP_PROBE)))) continue;
    const x = heads[k]!;
    let pos = 0;
    let skipped = 0;
    for (let j = k; j < lines.length; j++) {
      if (streams[j] === '' || heads[j] !== x) break;
      const got = consume(streams[j]!, r, pos, budget - skipped);
      if (!got) break;
      pos = got.pos;
      skipped += got.skipped;
      if (pos >= r.length) return { start: k, end: j, x };
    }
  }
  return null;
}
