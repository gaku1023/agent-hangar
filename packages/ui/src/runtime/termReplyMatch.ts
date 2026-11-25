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
 * - 途中で続かなくなったら、その始まりは捨てる。頭が画面の上に切れたもの、下が切れたものは見つからない。
 * - 同じ返答が何度も見つかったら、いちばん下（新しい）を返す。
 */

/** 返答の印。Claude Code は ⏺ を使う。ほかの印は、ほかのエージェントや版の違いに備える。 */
const BULLETS = new Set(['⏺', '●', '•']);
/** 突き合わせる返答の列の長さの下限。短い返答は取り違えやすいので扱わない。 */
export const MIN_STREAM = 24;
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

/** start の行から返答を読み切れたら、最後の行を返す。 */
function readFrom(lines: readonly string[] /* 行ごとの列（lineStreams） */, start: number, r: string): number | null {
  const budget = Math.max(SKIP_MAX, Math.floor(r.length / 10));
  let pos = 0;
  let skipped = 0;
  for (let k = start; k < lines.length; k++) {
    const s = lines[k]!;
    if (s === '') continue;
    const got = consume(s, r, pos, budget - skipped);
    if (!got) return null;
    pos = got.pos;
    skipped += got.skipped;
    if (pos >= r.length) return k;
  }
  return null;
}

/**
 * 画面の行（lines、上から順）の中で、返答 reply が描かれている行の範囲を返す。両端を含む。
 * 見つからなければ null。
 */
export function findReplyRange(lines: readonly string[], reply: string): { start: number; end: number } | null {
  const r = replyStream(reply);
  if (r.length < MIN_STREAM) return null;
  let streams: string[] | null = null;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!startsReply(lines[k]!)) continue;
    streams ??= lineStreams(lines);
    if (!streams[k]!.startsWith(r.slice(0, 1))) continue;
    const end = readFrom(streams, k, r);
    if (end !== null) return { start: k, end };
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
