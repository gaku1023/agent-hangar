# 包み方を tmux に移す

2026-10-01 の夜、包み方でバックグラウンドになったセッションが利用上限で止まり、上限が戻っても続かなかった。
Claude Code は、バックグラウンドのセッションでは上限の後に自動で続ける予約を入れない。
そこで、ターミナルで打った claude を、バックグラウンドではなく hangar の tmux の中で動かす。
設計は `docs/design.md` の「外のターミナルのセッション」の節に書いた。

ブランチは `worktree-tmux-shell-wrap`。

## 確かめたこと（作る前）

- hangar と同じ起動のしかた（`hangar-run.sh`、`--mcp-config`、`--append-system-prompt`）の claude は、tmux の中で上限の後に自動で続く。バックグラウンドのセッションは続かない。上限は手元の中継で模した。
- 止めた claude は 0.5 秒ほどで終わり、レジストリから消える。同じ id の `claude -r` は写しを作らずに続く。
- tmux の中から `tmux attach` は断られる。`switch-client` なら移れる。
- tmux サーバが動いていると、新しいセッションはシェルの環境変数を継がない。`-e` で渡せば届く。
- tmux は CSI u の Shift+Enter を素の CR に潰す。`S-Enter` を ESC CR に割り当てると改行になる。
- iTerm2 は OSC 52 の書き込みを許していない。`copy-command pbcopy` でドラッグのコピーが届く。
- この設定の tmux に iTerm2 からつなぎ、利用者が Shift+Enter、スクロール、コピーを確かめた。
- いまの起動の入口は、プロジェクトかスクラッチでしか起動できない。

## タスク

1. tmux の層。`newSession` に環境変数を渡せるようにし（`-e`）、端末の設定（`copy-command`、`extended-keys`、`extended-keys-format`、`terminal-features`、hangar の run だけの `S-Enter`）を入れる `ensureTerminalOptions` を足す。run の起動と画面の中継のたびに呼ぶ。
2. ターミナルからの起動の入口。`POST /api/runs/terminal` に作業ディレクトリ、引数、環境変数を受け、作業ディレクトリを含む最も深いプロジェクト（無ければ未分類）で起動する。
   `-r <id>` があれば、動いている run の tmux を返すか、再開する。
   hangar が組み立てる引数と重なる引数（`--session-id`、`--append-system-prompt` など）は断る。
   端末に固有の環境変数（`TMUX`、`TERM` など）は渡さない。
3. 引き取りを、止めて hangar の tmux で再開する形に変える。止めた後、レジストリから消えるのを待つ。
4. 包み方の本体を書き直す。hangar に起動を頼み、返ってきた tmux につなぐ。応答が無ければ素の claude にする。接続先、トークンのファイル、tmux のパスは、hangar が書き出すときに埋め込む。
5. 入れられるかの判定と文言。`hangar shell install` と設定画面の「使えない」を、zsh と tmux の有無で決める。引き取りの確認の文を直す。
6. 実際の zsh から包み方を通して起動し、hangar の run になること、hangar の画面からつなげること、上限を模して自動で続くことを確かめる。

## 確かめたこと（作った後）

2026-10-01 に、作業ブランチのサーバを別の置き場とポートで起こし、tmux も別のサーバに分けて、外側の端末の代わりの tmux の中の zsh から包み方を通して確かめた。

- `claude --model haiku` は hangar の run になり、外側の端末からその tmux につながった。シェルで立てた変数は tmux のセッションまで届き、`TERM_PROGRAM` は渡らなかった。
- 上限を模した中継で、run の中の claude に予約が入り、上限が戻った約 90 秒後に自分で続いた。
- 別の端末からの `claude -r <id>` は、新しく起こさずに同じ run につながった。
- hangar の tmux の中から打った `claude` は、新しい run に `switch-client` で移った。
- hangar を止めると、黙って素の claude を起動した。

## 残ること

- 通知が tmux 越しに iTerm2 へ届くかは確かめていない。
- 素の claude でも上限の後の予約が入らなかった例が 3 件あり、理由は分かっていない。
- 本物の上限で続くかは、作った後に実際に当たったときに確かめる。
