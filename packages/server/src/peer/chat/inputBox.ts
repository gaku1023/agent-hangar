/**
 * Claude Code の入力欄が空かを、色付きの画面（capture-pane -e）から読む。
 *
 * ほかの PC から来た文は、元の PC の前で人が打ちかけのときに混ぜてはならない（PeerQueue が渡す前に確かめる）。
 * 空の入力欄にも、薄い字の提案（ghost）や「Try ...」の案内が出る。
 * 色を落とした画面では、この薄字と打った字が見分けられない。
 * 薄字は SGR の 2（faint）で描かれ、打った字には付かない。psmux（0;2）も tmux（2）も同じである。
 * だから色付きの画面で、薄くない字が箱の中にあるかを見る。
 *
 * 入力欄は、最後の 2 本の区切り線（─ の行。上の線には会話の名前が入ることがある）の間にある。
 * 1 行目は ❯ で始まる。複数行の打ちかけは、箱が伸びて 2 行目以降に続く。
 * 箱が見つからない、1 行目が ❯ で始まらない（許可や質問の札が出ている）画面は、空と言わない。
 * 薄字でも [ で始まる語は、貼り付けや画像の札かもしれないので、空でないとみなす。
 * 実機の psmux では、札（[Pasted text #1 +29 lines]、[Image #2]）は普通の字で描かれ、薄字ではない。
 * 迷ったら空でないと答える。誤って渡すより、渡さずに待つほうが安全だからである。
 */

import { parseDialog } from './answer.ts';

/**
 * 区切り線。名前の付いた会話では、箱の上の線の右寄りに名前が入る（`──── 名前 ─`）。
 * 名前は空白で挟まれ、線は ─ で終わる。
 */
const RULE_LINE = /^─{8,}(?: \S.*? ─+)?$/;
const CSI = /\x1b\[([0-9;:]*)([ -/]*[@-~])/y;

/** SGR を読んで薄字かどうかを返す。38、48、58 の拡張色の引数は読み飛ばす（38;2;r;g;b の 2 を薄字と取り違えない）。 */
function dimAfter(params: string, dim: boolean): boolean {
  const p = params === '' ? ['0'] : params.split(/[;:]/);
  for (let i = 0; i < p.length; i++) {
    const n = p[i] === '' ? 0 : Number(p[i]);
    if (n === 0) dim = false;
    else if (n === 2) dim = true;
    else if (n === 22) dim = false;
    else if (n === 38 || n === 48 || n === 58) i += p[i + 1] === '5' ? 2 : p[i + 1] === '2' ? 4 : 0;
  }
  return dim;
}

/** 行の飾りを外した文字（区切り線と ❯ の判定に使う）。 */
function plain(line: string): string {
  return line.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '');
}

/** capture は capture-pane -p -e の出力。入力欄が空（薄字の提案だけの場合を含む）なら true。 */
export function inputEmptyFromCapture(capture: string): boolean {
  const lines = capture.replace(/\r\n/g, '\n').split('\n');
  const rules: number[] = [];
  for (let i = 0; i < lines.length; i++) if (RULE_LINE.test(plain(lines[i]!).trim())) rules.push(i);
  if (rules.length < 2) return false;
  const top = rules[rules.length - 2]!;
  const bottom = rules[rules.length - 1]!;
  const box = lines.slice(top + 1, bottom);
  if (box.length === 0 || !plain(box[0]!).replace(/^\s+/, '').startsWith('❯')) return false;
  return !hasTyped(box, '❯');
}

/**
 * 薄くない字が並びにあるか。薄字でも [ で始まる語は、貼り付けや画像の札かもしれないので、薄くない字と同じに扱う。
 * skip は数えない最初の 1 字（入力欄の印 ❯ や ›）。
 */
function hasTyped(lines: readonly string[], skip: string): boolean {
  let dim = false;
  let promptSeen = false;
  let wordStart = true;
  for (const line of lines) {
    for (let i = 0; i < line.length; ) {
      if (line[i] === '\x1b') {
        CSI.lastIndex = i;
        const m = CSI.exec(line);
        if (m) {
          if (m[2] === 'm') dim = dimAfter(m[1]!, dim);
          i += m[0].length;
          continue;
        }
        i++;
        continue;
      }
      const ch = line[i]!;
      i++;
      if (/\s/.test(ch)) {
        wordStart = true;
        continue;
      }
      if (!promptSeen && ch === skip) {
        promptSeen = true;
        wordStart = true;
        continue;
      }
      if (!dim || (wordStart && ch === '[')) return true;
      wordStart = false;
    }
  }
  return false;
}

/**
 * Codex の TUI の入力欄が空かを、色付きの画面（capture-pane -e）から読む（見本は inputBox.codex.fixtures.ts）。
 *
 * Codex の入力欄には区切り線が無い。
 * 入力欄は、画面の下から探して最初の、› で始まる行である（その下は空行と、モデルや使用量の行）。
 * 上に残る過去の入力も › で始まるが、入力欄より上にあるので、下から探せば取り違えない。
 * 複数行の打ちかけは、次の行から 2 字下げて続く。空行までを入力欄とみなす。
 * 空の入力欄には薄字（SGR 2）の案内（Ask Codex to do anything）が出る。打った字は薄字でない。
 * 承認の札が出ている間は、選択の › が下にあり、その字は薄字でないので、空と言わない。
 * 作業中も入力欄は出ている。作業中かどうかは、この判定では見ない（Claude の判定と同じ）。
 * 迷ったら空でないと答える。
 */
export function codexInputEmptyFromCapture(capture: string): boolean {
  const lines = capture.replace(/\r\n/g, '\n').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (plain(lines[i]!).startsWith('›')) {
      at = i;
      break;
    }
  }
  if (at < 0) return false;
  const box = [lines[at]!];
  for (let i = at + 1; i < lines.length && plain(lines[i]!).trim() !== ''; i++) box.push(lines[i]!);
  // 色の無い画面では薄字を見分けられない。案内の字が薄字で描かれていなければ空と言わない。
  if (!box.some((l) => /\x1b\[[0-9;:]*m/.test(l))) return false;
  return !hasTyped(box, '›');
}

/**
 * opencode（2.2.0）の画面の capture-pane -p -e の出力で、入力欄が空か。見本は inputBox.opencode.fixtures.ts。
 * 入力欄は、画面の下から探して最初の ╹ の行（囲みの底）の上にある、┃ で始まる行の続きである。
 * 囲みの最後の行は agent とモデルの状態の行（`Build · モデル`）で、その上の行が打つ所である。
 * 上に残る利用者の入力も同じ ┃ の囲みで描かれるが、空行で隔たっているので、底から続く行だけを見れば取り違えない。
 * 空の入力欄に案内の字は出ない。打つ所の行がどれも ┃ のほかに字を持たなければ空とする。
 * 作業中も入力欄は出ている。作業中かどうかは、この判定では見ない（Claude の判定と同じ）。
 * 色の無い画面、状態の行（· を含む）の無い囲みは、入力欄と見分けられないので空と言わない。
 */
export function opencodeInputEmptyFromCapture(capture: string): boolean {
  const lines = capture.replace(/\r\n/g, '\n').split('\n');
  const head = (l: string) => plain(l).trimStart();
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (head(lines[i]!).startsWith('╹')) {
      bottom = i;
      break;
    }
  }
  if (bottom < 2) return false;
  const inBox = (i: number) => i >= 0 && head(lines[i]!).startsWith('┃');
  const status = bottom - 1;
  if (!inBox(status) || !head(lines[status]!).includes('·')) return false;
  let top = status;
  while (inBox(top - 1)) top--;
  if (top === status) return false;
  if (!lines.slice(top, bottom + 1).some((l) => /\x1b\[[0-9;:]*m/.test(l))) return false;
  return lines.slice(top, status).every((l) => head(l).slice(1).trim() === '');
}

/**
 * そのエージェントの画面で、入力欄が空か。Claude Code は ❯ の箱（inputEmptyFromCapture）、Codex は › の行（codexInputEmptyFromCapture）、
 * opencode は ┃ の囲み（opencodeInputEmptyFromCapture）で読む。
 * 判定を持たないエージェントは、空と言わない（渡さずに待つ）。
 */
export function inputEmptyFor(agent: string, capture: string): boolean {
  if (agent === 'claude-code') return inputEmptyFromCapture(capture);
  if (agent === 'codex') return codexInputEmptyFromCapture(capture);
  if (agent === 'opencode') return opencodeInputEmptyFromCapture(capture);
  return false;
}

/**
 * hangar が会話へ知らせ（別の PC の起動の答えや、子の会話の報告）を打ってよい画面か。capture は capture-pane -p -e の出力。
 *
 * 札（許可や AskUserQuestion）が出ている間に打つと、札の「その他」の自由入力に入り、利用者の答えの代わりに確定してしまう。
 * だから、札が読めず（parseDialog が null）、かつ入力欄が空（inputEmptyFromCapture）のときだけ true にする。
 * 札の判定は、ほかの PC からの答え（answer.ts）と同じ parseDialog を使い、規則を二重に持たない。
 * 迷ったら false にする。打たずに待つほうが安全だからである。
 */
export function inputReadyFromCapture(capture: string): boolean {
  if (!inputEmptyFromCapture(capture)) return false;
  return parseDialog(capture.replace(/\r\n/g, '\n').split('\n').map(plain).join('\n')) === null;
}

/**
 * そのエージェントの画面に、hangar が文を打ってよいか（inputReadyFromCapture の provider 版）。
 * Claude Code は札の読み手（parseDialog）も見る。
 * Codex と opencode は、画面から札を読まず、入力欄が空かだけを見る（札が出ているかは、呼び出し側が登録の待ち waitingFor で見る）。
 */
export function inputReadyFor(agent: string, capture: string): boolean {
  if (agent === 'claude-code') return inputReadyFromCapture(capture);
  return inputEmptyFor(agent, capture);
}
