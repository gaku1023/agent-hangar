// 実機の capture-pane -p から、質問の札（AskUserQuestion）とその周りだけを切り出した見本。
// Claude Code 2.1.325 は、折り返す長い問いの各行の頭に「│ 」を付けて描く。1 行に収まる問いには付けない。
// 罫線は画面の幅（200）いっぱいの実線である。

const RULE = '─'.repeat(200);

/** LONG_QUESTION_WIN の札を出したときに hook から届いた問いの文。 */
export const LONG_QUESTION_TEXT = '記録の処理(watch.py)を ops の VM(svcvm01)で動かす形に移しますか。手順は、(1) VM で headless の Chromium から jra.go.jp を開けるか試す(VM に Playwright の Chromium を入れる)、(2) 取得を「手元の Chrome か headless」を選べる形にし、データの置き場を UMA_DATA に合わせる、(3) ops/schedule.toml に土日 08:50 のタスクを足し、main への PR を出す(マージと deploy はあなた)。次の土曜(11/21)に間に合わなければ、その週だけ僕が手で起動';

/** 長い問い（3 行に折り返す）。Claude Code 2.1.325、psmux、Windows、幅 200。 */
export const LONG_QUESTION_WIN = `
${RULE}
 ☐ VM 移行

│ 記録の処理(watch.py)を ops の VM(svcvm01)で動かす形に移しますか。手順は、(1) VM で headless の Chromium から jra.go.jp を開けるか試す(VM に Playwright の Chromium を入れる)、(2) 取得を「手元の
│ Chrome か headless」を選べる形にし、データの置き場を UMA_DATA に合わせる、(3) ops/schedule.toml に土日 08:50 のタスクを足し、main への PR を出す(マージと deploy
│ はあなた)。次の土曜(11/21)に間に合わなければ、その週だけ僕が手で起動

❯ 1. VM へ移す（推奨）
     上記 (1)〜(3) の手順で VM 移行を進める
  2. 今は PC のまま
     移行せず、現状の PC での運用を続ける
  3. 別の案
     別の方法を指示する
  4. Type something.
${RULE}
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

/** 短い問い（1 行）。Claude Code 2.1.325、tmux、macOS、幅 200。縦線は付かない。 */
export const SHORT_QUESTION_MAC = `
${RULE}
 ☐ 選択

どちらにしますか

❯ 1. A
     選択肢 A
  2. B
     選択肢 B
  3. Type something.
${RULE}
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
