# spike 13: claude -p での要約

判定: 合格
実施日: 2026-09-17

## 確かめたこと
- `claude -p --model haiku --output-format json --json-schema <schema>` に圧縮した本文（5,771 字）をパイプで渡すと、3 回ともスキーマどおりの JSON が返った。
- 出力 JSON の `structured_output` キーに構造化結果が入り、`result` にも同じ JSON 文字列が入る。`total_cost_usd`、`usage`（thinking トークン数を含む）、`session_id`、`duration_ms` も取れる。
- `--no-session-persistence` を付けると `~/.claude/projects` に新しいディレクトリや jsonl は作られなかった。
- 要約の質は 3 回とも妥当で、題名、1 文、本文、状態、次の一手が過不足なく埋まった。

## 計測値
- 所要：29 秒、37 秒、20 秒。
- コスト：0.044、0.033、0.017 ドル（2 回目以降はプロンプトキャッシュが効いた）。出力トークンのうち 2,000〜2,600 が thinking。
- stderr に Enterprise ポリシーの警告が毎回 1 行出る。

## 設計への影響
- 要約器の Claude 実装は `structured_output` を読む。`result` の文字列を再パースする必要はない。
- Haiku でも thinking が走り、出力トークンの大半を占める。`--effort low` を付けて時間とコストを下げられるかをフェーズ 3 で試す。
- 1 件 20〜40 秒なので、run 終了時の事後生成は背景ジョブにし、UI には「要約を作成中」を出す。
- Task 12 の LM Studio（27B）は同じ入力で 31 秒程度で、質も同等だった。既定をローカル、フォールバックを Haiku とする方針は妥当。

## 残った疑問
- 12,000 字の長い入力での安定性は 3 回分しか見ていない。フェーズ 3 で実装後に 20 件程度で再確認する。
