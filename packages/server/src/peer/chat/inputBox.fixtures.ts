// 実機の capture-pane -pe の出力から、入力の箱とその周りだけを切り出した見本。
// WIN_* は Claude Code 2.1.319、psmux 3.4.0（Windows）の実機。行ごとに SGR が付き、薄い字（提案の薄字）は 0;2 で書かれる。
// MAC_* は Mac の tmux 3.8 の同じ場面で、箱の行を実機から写した。tmux は薄い字を 2 で書き、打った字には何も付けない。
// ❯ の後ろは実機でも改行なしの空白（U+00A0）である。ソースでは見えないので、NB として名前を付ける。

const NB = String.fromCharCode(0xa0);
const RULE = `\x1b[0;38;5;244m${'─'.repeat(120)}\x1b[0m`;
const FOOTER = '\x1b[0m  \x1b[0;38;5;246m⏸\x1b[0m \x1b[0;38;5;246mmanual\x1b[0m \x1b[0;38;5;246mmode\x1b[0m \x1b[0;38;5;246mon\x1b[0m';

/** 起動直後。入力欄の薄字の提案だけがある（空）。 */
export const WIN_GHOST_FRESH = [
  '\x1b[0m',
  RULE,
  `\x1b[0m❯${NB}\x1b[0;2mTry\x1b[0m \x1b[0;2m"how\x1b[0m \x1b[0;2mdoes\x1b[0m \x1b[0;2m<filepath>\x1b[0m \x1b[0;2mwork?"\x1b[0m`,
  RULE,
  FOOTER,
].join('\n');

/** 同じ画面に hello draft と打った（打ちかけ）。 */
export const WIN_DRAFT = ['\x1b[0m', RULE, `\x1b[0m❯${NB}hello draft\x1b[0m`, RULE, FOOTER].join('\n');

/** ターンが終わった直後（空）。直前の指示の行は箱の外の上に残る。 */
export const WIN_EMPTY_AFTER_TURN = [
  `\x1b[0;38;5;246;48;5;237m❯${NB}\x1b[0;38;5;231;48;5;237mreply with exactly: ok\x1b[0m`,
  '\x1b[0m',
  '\x1b[0;38;5;246m✻ Cogitated for 1s · done 21:41\x1b[0m',
  '\x1b[0m',
  RULE,
  '\x1b[0m❯\x1b[0m',
  RULE,
  FOOTER,
].join('\n');

/** ターンが終わった画面に、次の指示を打ちかけている。 */
export const WIN_BUSY_WITH_DRAFT = [
  '\x1b[0;38;5;246m✻ Cogitated for 1s · done 21:42\x1b[0m',
  '\x1b[0m',
  RULE,
  `\x1b[0m❯${NB}typing during busy\x1b[0m`,
  RULE,
  FOOTER,
].join('\n');

/** 2 行の打ちかけ（Esc のあとの Enter で改行した）。 */
export const WIN_MULTILINE = ['\x1b[0m', RULE, `\x1b[0m❯${NB}line one\x1b[0m`, '\x1b[0m  line two\x1b[0m', RULE, FOOTER].join('\n');

export const MAC_GHOST = [RULE, `\x1b[39m❯${NB}\x1b[2mTry "fix lint errors"\x1b[0m`, RULE, '  ⏸ manual mode on · ? for shortcuts'].join('\n');
export const MAC_DRAFT = [RULE, `\x1b[39m❯${NB}hello draft`, RULE, '  ⏸ manual mode on'].join('\n');

/** 長い複数行を貼り付けた箱（実機の psmux）。貼り付けの札は薄字ではなく、普通の字で描かれる。 */
export const WIN_CHIP_PASTE = ['\x1b[0m', RULE, `\x1b[0m❯${NB}[Pasted text #1 +29 lines]\x1b[0m`, RULE, '\x1b[0m  \x1b[0;38;5;246mpaste again to expand\x1b[0m'].join('\n');

/** 画像のパスを貼り付けた箱（実機の psmux）。画像の札も普通の字で描かれる。 */
export const WIN_CHIP_IMAGE = ['\x1b[0m', RULE, `\x1b[0m❯${NB}[Image #2]\x1b[0m`, RULE, FOOTER].join('\n');

/** 札が薄字で描かれる版が出たときの備え（実機にはまだ無い作り物）。[ で始まる薄字は、提案ではなく札とみなす。 */
export const SYNTHETIC_FAINT_CHIP = ['\x1b[0m', RULE, `\x1b[0m❯${NB}\x1b[0;2m[Image\x1b[0m \x1b[0;2m#2]\x1b[0m`, RULE, FOOTER].join('\n');

/**
 * 名前の付いた会話（hangar が名前を付けて起動した会話）。箱の上の区切り線の右寄りに名前が入る。
 * Claude Code 2.1.319、psmux 3.4.0（Windows）の実機。区切り線の長さだけ実機より縮めた。
 */
const NAMED_RULE = `\x1b[0;38;5;244m${'─'.repeat(90)} peer-chat check (Windows) ─\x1b[0m`;
export const WIN_NAMED_EMPTY = ['\x1b[0m', NAMED_RULE, '\x1b[0m❯\x1b[0m', RULE, FOOTER].join('\n');
export const WIN_NAMED_DRAFT = ['\x1b[0m', NAMED_RULE, `\x1b[0m❯${NB}hello draft\x1b[0m`, RULE, FOOTER].join('\n');
