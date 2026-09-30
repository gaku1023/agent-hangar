# spike 14: 端末の描画方式の見比べ（Claude のロゴが崩れる件）

判定: xterm.js のまま WebGL 描画に替える（`@xterm/addon-webgl` 0.19.0 と `@xterm/addon-unicode11`）。ghostty-web は見送る
実施日: 2026-09-30

## 確かめたこと
- hangar と同じ経路（tmux の中で claude を起動し、`tmux attach` を node-pty で中継する）で Claude Code 2.1.285 の起動画面を記録した（`record.mjs` → `public/capture.json`）。これと文字の見本を 11 通りの組み合わせに流し込み、Chrome と Playwright の WebKit（Safari 26.5 相当）で撮って比べた。
- 崩れの原因は 2 つ重なっている。
  - DOM 描画はブロック文字（`▐▛█▜▌▝▘`）や罫線もフォントで描く。xterm の `customGlyphs`（セルいっぱいに自前で描く仕組み）は DOM 描画では効かない。`lineHeight: 1.2` だと、行の高さのうち字で塗られない 2 割が横縞になる。
  - `@fontsource-variable/jetbrains-mono` は unicode-range で分割されていて、U+2500–259F（罫線とブロック文字）がどの分割にも入っていない。そのためこの範囲だけ Menlo に落ち、字の大きさもずれる。
- 組み合わせごとの結果（ロゴ）

  | 組み合わせ | ロゴ |
  |---|---|
  | DOM / lh 1.2 / fontsource（今） | 崩れる（目がない、横縞） |
  | DOM / lh 1.0 / fontsource | 崩れる（Menlo に落ちるため） |
  | DOM / lh 1.2 / JetBrains Mono 本体 | 崩れる |
  | DOM / lh 1.0 / JetBrains Mono 本体 | ほぼ正しい（セルの継ぎ目がうっすら見える） |
  | DOM / lh 1.2 / Menlo | 崩れる |
  | WebGL / lh 1.2・1.0 / fontsource | 正しい |
  | 対照: WebGL / lh 1.2 / `customGlyphs: false` | 崩れる。直っているのは `customGlyphs` のおかげだとわかる |
  | ghostty-web / fontsource・本体 | 崩れる（目がない、継ぎ目がある）。ghostty-web には行の高さの設定もない |

- WebGL では罫線も途切れず、行間は 1.2 のまま保てる。WebKit でも同じ結果だった。
- 絵文字の幅: xterm の既定（Unicode 6）では絵文字が 1 桁に詰まって重なる。`unicode11` を有効にすると 2 桁になり、右側の文字が揃う。国旗と ZWJ でつないだ絵文字は WebGL でも崩れる（ghostty-web は正しい）。
- 日本語の変換入力（Chrome の `Input.imeSetComposition` と `insertText` で再現し、zsh で `echo`）: DOM、WebGL、ghostty-web のどれも `[日本語テスト]` が 1 回ずつ届いた。ただし ghostty-web は**変換中の文字をまったく表示しない**。xterm はどちらの描画でもカーソルの位置に変換中の文字を出す。
- WebGL の描画文脈は Chrome も WebKit も **同時に 16 個まで**。40 枚開くと古い順に 24 枚が文脈を失い、`onContextLoss` で addon を捨てると DOM 描画に戻った（表示は残るが、ロゴはまた崩れる）。`webglcontextlost` から `onContextLoss` までは約 3 秒かかる。

試作の動かし方: `npm install` のあと、罫線とブロック文字まで入った JetBrains Mono の完全版を `public/fonts/JetBrainsMono-wght.ttf` に置く（`https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/variable/JetBrainsMono%5Bwght%5D.ttf`、OFL のためリポジトリには入れていない）。`node record.mjs public/capture.json` で記録を取り直し、`node server.mjs` で `http://127.0.0.1:4191/` を開く。

## 設計への影響
- `packages/ui/src/runtime/xterm.ts` で `open` のあとに `WebglAddon` を読み込み、`onContextLoss` で `dispose` して DOM に戻す。WebGL が使えない環境でも表示は消えない。
- hangar はタブごとに xterm を持ち続けるので、WebGL は**画面に見えているタブにだけ付け、隠れたら外す**。そうすれば同時 16 個の上限に当たらない。
- `Unicode11Addon` を入れて `unicode.activeVersion = '11'` にする。Claude Code 側の桁の数え方に近づき、絵文字のあとのカーソルずれが減る。
- `lineHeight` は 1.2 のままでよい。
- DOM に戻ったときの見た目も良くしたいなら、罫線とブロック文字を含むフォント（JetBrains Mono 本体など）を別に読み込む。WebGL だけで直るので必須ではない。

## 残った疑問
- 本物の Tauri（WKWebView）での WebGL は、実装したあとにアプリで確かめる。Playwright の WebKit では動いた。
- 本物の macOS の日本語入力（候補ウィンドウの位置、ライブ変換）は人の手で試す。`?live=gl&cmd=claude` で本物の claude につなげる。
- xterm.js で Claude Code のスクロールが跳ねる件（2code #145）は、hangar だと tmux の代替画面の上で動くので当てはまりにくいと見ているが、試していない。
