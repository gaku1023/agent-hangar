// 「このフォルダを信頼するか」の画面への答え方。採る道具（run.ts）が使う。
// 2.1.295 の画面は、カーソルの初期位置が「No, exit」にある。そのまま Enter を押すと claude が終わるので、
// 画面を見て、Yes にカーソルがあるときだけ Enter を送り、No にあるときは Down で移す。

/** 信頼する側の選択肢の行（「Yes, I trust this folder」）。行頭のカーソル（❯ か >）と番号は付いていてもよい。 */
const TRUST_OPTION = /^\s*(?:[❯>]\s*)?(?:\d+[.)]\s*)?Yes\b.*\btrust/i;
/** カーソルのある行。 */
const CURSOR_LINE = /^\s*[❯>]\s*\S/;

/**
 * 画面から、次に送るキーを決める。
 * 信頼の選択肢の行が画面になければ null（入力の欄の `❯ Try "…"` などを取り違えない）。
 * カーソルが信頼の選択肢にあれば Enter、それ以外（No, exit など）なら Down、カーソルの行が見つからなければ null。
 */
export function trustKey(screen: string): 'Enter' | 'Down' | null {
  const lines = screen.split('\n');
  if (!lines.some((l) => TRUST_OPTION.test(l))) return null;
  const cursor = lines.filter((l) => CURSOR_LINE.test(l)).at(-1);
  if (cursor === undefined) return null;
  return TRUST_OPTION.test(cursor) ? 'Enter' : 'Down';
}

const CLUE = /❯|trust|Enter to confirm/i;
const CLUE_MAX = 200;

/** 画面のうち、信頼の画面の手がかりになる行（❯、trust、Enter to confirm を含む行）。長い行は切る。 */
export function screenClues(screen: string): string[] {
  return screen.split('\n').filter((l) => CLUE.test(l)).map((l) => l.trim().slice(0, CLUE_MAX));
}

/** 信頼の画面を初めて見てから、最初のキーを送るまで待つ時間。描画の直後は、送ったキーが取りこぼされる。 */
const FIRST_DELAY_MS = 1000;
/** キーとキーの間のあき。 */
const KEY_GAP_MS = 800;
const MAX_DOWN = 4;
const MAX_ENTER = 3;

/**
 * 信頼の画面への答えを、時間をかけて出す。呼ぶたびに画面と時刻を渡すと、いま送るキーか null を返す。
 * 上限（Down 合わせて 4 回、Enter 合わせて 3 回）を越えたら投げる。
 * No にカーソルがあるあいだは Enter を返さない（trustKey が Down を返すため）。
 */
export function createTrustAnswerer(): (screen: string, now: number) => 'Enter' | 'Down' | null {
  let firstSeen: number | null = null;
  let lastSent = -Infinity;
  let downs = 0;
  let enters = 0;
  return (screen, now) => {
    const key = trustKey(screen);
    if (key === null) return null;
    firstSeen ??= now;
    if (now - firstSeen < FIRST_DELAY_MS || now - lastSent < KEY_GAP_MS) return null;
    if (key === 'Down' ? downs >= MAX_DOWN : enters >= MAX_ENTER) {
      throw new Error(`信頼の画面に答えられませんでした（Down ${downs} 回、Enter ${enters} 回を送っても、画面が変わりません）`);
    }
    if (key === 'Down') downs++; else enters++;
    lastSent = now;
    return key;
  };
}
