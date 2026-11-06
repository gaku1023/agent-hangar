/**
 * Claude Code の入力欄が空かを、色付きの画面（capture-pane -e）から読む。
 *
 * ほかの PC から来た文は、元の PC の前で人が打ちかけのときに混ぜてはならない（PeerQueue が渡す前に確かめる）。
 * 空の入力欄にも、薄い字の提案（ghost）や「Try ...」の案内が出る。
 * 色を落とした画面では、この薄字と打った字が見分けられない。
 * 薄字は SGR の 2（faint）で描かれ、打った字には付かない。psmux（0;2）も tmux（2）も同じである。
 * だから色付きの画面で、薄くない字が箱の中にあるかを見る。
 *
 * 入力欄は、最後の 2 本の区切り線（─ だけの行）の間にある。
 * 1 行目は ❯ で始まる。複数行の打ちかけは、箱が伸びて 2 行目以降に続く。
 * 箱が見つからない、1 行目が ❯ で始まらない（許可や質問の札が出ている）画面は、空と言わない。
 * 迷ったら空でないと答える。誤って渡すより、渡さずに待つほうが安全だからである。
 */

const RULE_LINE = /^─{8,}$/;
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
  let dim = false;
  let promptSeen = false;
  for (const line of box) {
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
      if (/\s/.test(ch)) continue;
      if (!promptSeen && ch === '❯') {
        promptSeen = true;
        continue;
      }
      if (!dim) return false;
    }
  }
  return true;
}
