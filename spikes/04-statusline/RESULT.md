# spike 04: statusline の追記

判定: 合格
実施日: 2026-09-17

## 確かめたこと
- `--settings` で起動単位に statusLine コマンドをラッパーへ差し替え、既存スクリプトを触らずに payload を受信サーバへ複製できた。
- payload の最上位キー：`session_id`、`session_name`、`transcript_path`、`cwd`、`scratchpad_dir`、`effort`、`model`、`workspace`、`version`、`output_style`、`cost`、`context_window`、`exceeds_200k_tokens`、`fast_mode`、`thinking`、そして `rate_limits`（`five_hour` と `seven_day` に `used_percentage` と `resets_at`）。
- Enterprise のアカウントでも `rate_limits` は入る（5h 47%、7 日 7%）。
- ラッパーを挟んでもステータス行の見た目は変わらず、受信サーバを止めても表示は続く（`curl -m 0.3` を背景で投げているため）。

## 計測値
- 起動直後の 1 回目は `rate_limits` が無く `context_window.current_usage` も null。応答完了後の 2 回目（12.5 秒後）で両方が入った。
- 更新は定期ではなく、状態の変化（起動、応答完了）のたびに 1 回。待機中に追加の更新は来なかった。

## 設計への影響
- **payload に `session_id` と `session_name` が入る**ので、使用量だけでなく、セッションごとのコンテキスト使用率、モデル、effort、推定コストをここから取れる。設計文書の「付帯情報」の供給源はトランスクリプトの解析ではなく、この payload を第一にする。
- 更新がターンの境目だけなので、ヘッダーのゲージには「最終更新 N 分前」の表示が必要である（設計どおり）。
- 1 回目の payload には `rate_limits` が無い。受信側は欠けている項目を上書きせず、直前の値を保つ。
- 既存スクリプトへの追記（本番の方式）は、この検証のラッパーと同じ 3 行で済む。`hangar setup` は追記前にバックアップを取り、追記済みかを目印のコメント行で判定して二重追記を避ける。

## 残った疑問
- Max や Pro のプランでも同じ形か。別プランの環境が無いので、設定画面に「payload の生 JSON を見る」診断を置いて確認できるようにする。
