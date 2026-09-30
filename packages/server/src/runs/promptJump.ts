/**
 * fullscreen の Claude Code を外から操作して、会話の中の指示へ画面を跳ばす。
 *
 * fullscreen の Claude Code は代替画面に描くので、会話は tmux の履歴に残らない。
 * 遡れるのは Claude Code 自身の画面だけで、transcript（ctrl+o）の `{` が 1 つ前の指示へ跳ぶ。
 * そこで「transcript に入る → G で末尾へ → `{` を N 回」で目的の指示の近くまで行く。
 *
 * hangar の数えた指示と、Claude Code が指示として描くものは完全には揃わない（描かれない指示がある）。
 * ずれは古い指示ほど溜まるので、着いた先で画面に見えている指示を一覧と突き合わせ、差の分だけ動き直す。
 *
 * 外から送ったキーは、モードの読み違いがあれば入力欄にそのまま入る。
 * 実際に、transcript のつもりで送った検索語と Enter が指示として送信されたことがある。
 * だから送るのは ctrl+o、G、{、}、q だけにして、文字と Enter は送らない。
 * ctrl+o 以外は、送る直前に画面の最下行で transcript にいることを確かめる。
 */
import { promptHead } from '@agent-hangar/shared';

/** tmux のペインとのやりとり。テストは偽物を渡す。 */
export type PaneIo = { capture(): string; send(key: string): void; sleep(ms: number): Promise<void> };
export type JumpResult = { found: true } | { found: false; reason: 'mode' | 'notFound' };

/** transcript の最下行。Claude Code 2.1 系の文言である。変わったら跳べなくなるだけで、文字は送らない。 */
const TRANSCRIPT_FOOTER = /Showing detailed transcript/;
/** キーを 1 つ送ってから描き直されるまでの待ち。短すぎると続けて送ったキーが貼り付けとして読まれうる。 */
const STEP_MS = 20;
/** ctrl+o のあと transcript に切り替わるまで待つ回数と間隔。 */
const ENTER_TRIES = 10;
const ENTER_WAIT_MS = 100;
/** 画面が落ち着いたとみなすまでに読み直す回数と間隔。 */
const SETTLE_TRIES = 8;
const SETTLE_MS = 60;
/** 見えている指示から位置を割り出して動き直す回数の上限。 */
const CORRECTIONS = 6;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function footer(screen: string): string {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() !== '') return lines[i]!;
  return '';
}

const inTranscript = (io: PaneIo) => TRANSCRIPT_FOOTER.test(footer(io.capture()));

/** 画面に見えている指示の行（❯ で始まる）の中身を、上から順に返す。 */
function visiblePrompts(screen: string): string[] {
  const out: string[] = [];
  for (const l of screen.split('\n')) {
    const m = /^\s*❯\s?(.*)$/.exec(l);
    if (m && m[1]!.trim() !== '') out.push(squash(m[1]!));
  }
  return out;
}

/** 指示の書き出しが、画面のどこかの指示の行に出ているか。返答の中の同じ文は数えない。 */
export function promptVisible(screen: string, text: string): boolean {
  const head = promptHead(text);
  return head !== '' && visiblePrompts(screen).some((p) => p.startsWith(head));
}

/**
 * 見えている指示を一覧の番号に当てる。同じ書き出しの指示が複数あるときは、いま居るはずの位置に近いものを取る。
 * 当てられなければ null。
 */
function locate(screen: string, heads: string[], guess: number): number | null {
  let best: number | null = null;
  for (const p of visiblePrompts(screen)) {
    for (let k = 0; k < heads.length; k++) {
      if (heads[k] === '' || !p.startsWith(heads[k]!)) continue;
      if (best === null || Math.abs(k - guess) < Math.abs(best - guess)) best = k;
    }
  }
  return best;
}

/** transcript にいることを確かめて 1 キー送る。いなければ送らずに偽を返す。 */
async function sendInTranscript(io: PaneIo, key: string): Promise<boolean> {
  if (!inTranscript(io)) return false;
  io.send(key);
  await io.sleep(STEP_MS);
  return true;
}

/**
 * 描き直しが落ち着いた画面を返す。続けて 2 回読んで同じになるまで待つ。
 * 送った直後の画面は古いことがあり、それで位置を割り出すと見当違いの側へ動いてしまう。
 */
async function settled(io: PaneIo): Promise<string> {
  let prev = io.capture();
  for (let i = 0; i < SETTLE_TRIES; i++) {
    await io.sleep(SETTLE_MS);
    const cur = io.capture();
    if (cur === prev) return cur;
    prev = cur;
  }
  return prev;
}

async function repeat(io: PaneIo, key: string, n: number): Promise<boolean> {
  for (let i = 0; i < n; i++) if (!(await sendInTranscript(io, key))) return false;
  return true;
}

/**
 * 数え始める端。1 キーごとに描き直しを待つので、数百の指示を渡るには秒単位かかる。呼び手が近い端を選ぶ。
 * top のときは heads の先頭が会話の最初の指示、bottom のときは heads の末尾が最後の指示である。
 */
export type JumpFrom = 'top' | 'bottom';

/**
 * heads は hangar が数えた指示の書き出しを古い順に並べたもの、index はその中の目的の指示。
 * 会話の途中から始まる（あるいは途中で終わる）切り出しでよい。どちらの端が会話の端かを from で言う。
 * 着けなかったときも transcript は開いたままにする。どこまで来たかは利用者が画面で見られる。
 */
export async function jumpToPrompt(io: PaneIo, heads: string[], index: number, from: JumpFrom): Promise<JumpResult> {
  const target = heads[index] ?? '';
  if (!inTranscript(io)) {
    io.send('C-o');
    let entered = false;
    for (let i = 0; i < ENTER_TRIES && !entered; i++) { await io.sleep(ENTER_WAIT_MS); entered = inTranscript(io); }
    if (!entered) return { found: false, reason: 'mode' };
  }
  // G は最後の指示より下へ行くので、そこから { を 1 回押すと最後の指示に着く。g は最初の指示が見える位置へ行く。
  const fromTop = from === 'top';
  const ok = fromTop
    ? (await sendInTranscript(io, 'g')) && (await repeat(io, '}', index))
    : (await sendInTranscript(io, 'G')) && (await repeat(io, '{', heads.length - index));
  if (!ok) return { found: false, reason: 'mode' };
  for (let i = 0; i <= CORRECTIONS; i++) {
    const screen = await settled(io);
    if (target !== '' && visiblePrompts(screen).some((p) => p.startsWith(target))) return { found: true };
    if (i === CORRECTIONS) break;
    const at = locate(screen, heads, index);
    // 見えている指示が一覧に無いときは、来た向きにもう 1 つ進めて手がかりを探す。
    const moved = at === null ? await repeat(io, fromTop ? '}' : '{', 1) : at > index ? await repeat(io, '{', at - index) : await repeat(io, '}', index - at);
    if (!moved) return { found: false, reason: 'mode' };
  }
  return { found: false, reason: 'notFound' };
}

/** transcript にいれば q で通常の画面へ戻す。戻したら真。 */
export async function leaveTranscript(io: PaneIo): Promise<boolean> {
  return sendInTranscript(io, 'q');
}
