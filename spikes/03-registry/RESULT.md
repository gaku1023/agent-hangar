# spike 03: 実行中レジストリの挙動

判定: 合格
実施日: 2026-09-17

## 確かめたこと
- `~/.claude/sessions/<pid>.json` は起動で現れ、終了で消える。`status` は **busy / idle / waiting** の 3 値で、`waiting` は AskUserQuestion などで利用者の入力を待っている状態。
- `-n` で付けた名前は `name` に入り、`nameSource` は `user`。`/rename` で変えると 0.1 秒以内に反映され、`nameSource` は `user` のまま。
- 権限確認の待ちは、auto モードのためこの検証では発生しなかった。AskUserQuestion の待ちが `waiting` になることは確認した。

## 計測値（監視間隔 500 ミリ秒）
- プロンプト送信から `busy` まで：約 0.55 秒。
- 応答完了から `idle` まで：0.5 秒以内（監視間隔の粒度）。
- `/rename` から `NAME` 反映まで：約 0.07 秒。
- AskUserQuestion 表示から `waiting` まで：応答開始の約 4 秒後（ツール呼び出し時点）。回答の Enter から `busy` まで約 0.3 秒。
- `/exit` から `GONE` まで：約 0.4 秒。
- 起動（信頼ダイアログ承認）から `APPEAR` まで：約 0.5 秒。初期プロンプト付き起動では初期 `status` は `busy`。
- `tmux kill-session` からの消え方：下記の実測ログ。

## 設計への影響
- UI の状態点は busy / idle / waiting の 3 値にする。`waiting` は「あなたの入力待ち」として目立たせ、通知トーストの対象にする（他タブのセッションが質問しているのを知る手段になる）。
- 500 ミリ秒の監視で十分に速い。fs.watch が使えればさらに軽くなる。
- 名前は `nameSource: user` のものを hangar 側の名前より優先する、という前提は妥当。`-n` 起動の名前も `user` になるので、hangar が付けた名前と利用者が付け直した名前は区別できない。hangar は自分が付けた名前を覚えておき、レジストリの名前がそれと違えば利用者が変えたとみなす。
- 同時に開いている別プロジェクトの Claude セッション（このインタビュー自身など）も同じディレクトリに並ぶ。hangar は自分が起動した run だけでなく、手動起動のセッションも「実行中」として一覧に出せる。

## 残った疑問
- 権限確認ダイアログの待ちが `waiting` になるか `busy` のままかは、auto モード以外で確かめる必要がある。フェーズ 2 で default モードの起動時に見る。

## 実測ログ（tmux kill-session）

```
2026-09-17T08:55:19.664Z STATUS 20287.json spike-launch busy -> idle
2026-09-17T08:57:59.442Z GONE 20287.json
```
