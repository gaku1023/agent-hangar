# spike 09: Cloudflare の資源作成とデプロイ

判定: 合格
実施日: 2026-09-17

## 確かめたこと
- 個人アカウント（<利用者のアカウント>）に `wrangler login` 済みの状態で、`d1 create`、`r2 bucket create`、`wrangler.jsonc` の生成、`wrangler deploy` が対話なしで通った。
- Worker 経由の D1 への書き込みと読み出し、5MB の R2 アップロードが動いた。
- `wrangler delete`、`r2 object delete`、`r2 bucket delete`、`d1 delete -y` で資源を全部消せた（`delete` の確認は非対話では自動で yes になる）。

## 計測値
- setup（作成 2 つ＋デプロイ）：7〜9 秒。
- デプロイ直後の 5〜10 秒は `error code: 1042` が返り、その後 `{"ok":true}` になった。新しい `workers.dev` サブドメインの反映待ちである。

## 設計への影響
- `hangar setup cloud` はデプロイ後に `/health` を数秒おきに最大 2 分試し、通ってから参加トークンを表示する。
- wrangler はプロジェクト内にローカル依存として入れる（グローバルの 4.6.0 は古く、`npx wrangler@latest` は毎回ダウンロードする）。
- D1 の ID はコマンド出力から UUID を正規表現で拾えばよく、`--json` に依存しない。
- Worker 経由の 5MB は問題なかった。数十 MB 級のトランスクリプトを上げるときは、Worker の本文上限（無料枠で 100MB）に近づく前にチャンク分割か R2 の署名 URL を検討する。
- メタデータの初回投入は sessions 約 900 行、projects 約 60 行、artifacts 約 200 行、runs は起動ごとに 1 行で、1 日 10 万行の無料枠に対して十分小さい。

## 残った疑問
- `workers.dev` を使わずカスタムドメインや Access で守るかは、フェーズ 4 で決める。参加トークンによる認証だけで十分と考えている。
