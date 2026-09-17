# spike 01: tmux + node-pty + xterm.js

判定: 合格（条件付き）
実施日: 2026-09-17

## 確かめたこと
- tmux セッション 2 つ（Claude の TUI と zsh）を node-pty 経由で xterm.js に中継し、ブラウザで並べて描けた。片方の操作がもう片方に影響しない。
- 日本語の入力と出力（`echo こんにちは`）が欠けない。
- ビューポートを 1600px から 1100px に変えると、両ペーンが再計算され（68 列 46 行）、Claude の fullscreen TUI も崩れずに再配置された。
- 2 つ目のブラウザタブを開くと tmux のクライアントが 4 つになり、同時 attach できる。
- 中継サーバを kill しても tmux 内の Claude は生きており、再起動後に再接続できる。

## 計測値
- node-pty 1.1.0、@xterm/xterm、ws。attach から描画まで体感で即時（1 秒未満）。

## 設計への影響
- **node-pty の prebuild は `spawn-helper` に実行権限が無い状態で展開される**（`-rw-r--r--`）。そのままでは `posix_spawnp failed` で落ちる。本体では postinstall で `chmod +x` するか、起動時に権限を確認して直す。spawn 失敗は必ず捕まえて WebSocket を閉じ、サーバを落とさない。
- tmux は絶対パス（`which tmux` の結果を設定に保存）で spawn する。GUI 起動時の PATH に依存しない。
- **新しいディレクトリで Claude を起動すると、信頼確認ダイアログで止まる**（「Yes, I trust this folder」を選ぶまで進まない）。hangar が新規プロジェクトやスクラッチで起動する場合、利用者が埋め込みターミナルで答える必要がある。起動直後はターミナルを前面に出し、ダイアログが出ている旨を表示する。
- tmux のステータス行（緑の帯）がペーンの最下段に出る。hangar のセッションでは `tmux set-option -t <name> status off` で隠す。
- WebSocket のメッセージは JSON 1 行（`{"t":"data"}` と `{"t":"resize"}`）で問題なく、制御文字の区切りは不要。
- この環境の Claude は「Claude Enterprise」表示だった。statusline の `rate_limits` が Enterprise でも入るかは Task 4 で確かめる。

## 残った疑問
- 長時間 attach したままの WebSocket の切断と再接続（スリープ復帰）の挙動。フェーズ 2 で扱う。
