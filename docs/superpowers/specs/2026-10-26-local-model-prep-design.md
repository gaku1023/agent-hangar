# ローカルモデルの下ごしらえ（opencode × LM Studio）設計メモ

2026-10-26。まだ案の段階で、実装していない。

## 解きたいこと

opencode をローカルのモデル（LM Studio の OpenAI 互換の口）で使うと、次の 2 つで詰まる。

1. **起動したのに最初の一手で落ちる。**
   LM Studio は、呼ばれた時点で載っていないモデルを自動で載せる（JIT）。
   そのときの長さは LM Studio の設定の `defaultContextLength`（`~/.lmstudio/settings.json`）で、既定が 8192 のことがある。
   opencode が最初に送る分（システムプロンプトと道具の定義）は 8k を超えるので、LM Studio が
   `The number of tokens to keep from the initial prompt is greater than the context length` で断る。
   自動の圧縮も削れる会話が無いので失敗し、会話が止まる。
   opencode.json の `provider.<id>.models.<id>.limit.context` は opencode の側の見積もりで、LM Studio が載せる長さは変えない。
2. **モデルをいちいち手で外す。**
   opencode の agent ごとに別のモデル（例：build は大きいモデル、scout・fetcher は別のモデル）を書くと、サブエージェントのたびにもう 1 つ載る。
   16GB 級が 2 つ並ぶとメモリが足りなくなり、利用者が `lms unload` で外してから載せ直すことになる。

補足：LM Studio は 1 つのモデルで同時に複数本（`lms ps` の PARALLEL、既定 4）を返せる。
サブエージェントが同じモデルを指していれば、追加のメモリなしに並列で走る。

## 案の比較

| 案 | 中身 | 利点 | 欠点 | 量 |
|---|---|---|---|---|
| A 落ちたら直し方を出す | opencode の `session.error` を拾い、「LM Studio の既定コンテキストが短い」と札で出す | 小さい。何も触らない | 会話は毎回いったん壊れる。`live.ts` は今 `session.error` を拾っていない | 小 |
| B LM Studio の設定を案内する | `settings.json` を読んで、短ければ設定画面で警告する | 根治に近い。読むだけ | LM Studio が開いている間に書くとぶつかるので、書き換えはしない。手作業は残る | 小 |
| **C 起動前に hangar が整える（推す）** | 起動前に、使うモデル全部が載っているか、長さが足りているかを見て、足りなければ載せ直す | 2 つの困りごとを両方消す。今の配線（options、integration、知らせ）に乗る | LM Studio の REST が版で変わりうる。読み込みに 10〜30 秒かかる | 中 |
| D opencode の plugin で行う | プロバイダーに投げる直前のフックで load | hangar の外でも効く | 2.1.4 の plugin に「送る前に待つ」口があるか未確認。hangar の画面に進みが出ない | 中〜大 |
| E 1 モデルに寄せる | agent ごとの別モデルをやめるよう案内する | メモリの問題が消える | 利用者の意図を奪う。C の補足の案内にとどめる | 小 |

推す案は **C に、A の検出と B・E の案内を足したもの**。

## 推す案の中身

### 起動の前

`runs/manager.ts` の `startMaterialized` の中、`materializeOpencode`（`provider/opencode/launch.ts`）の前に `prepareLocalModels(spec)` を置く。

1. 会話のモデル（`spec.model`）と、`/api/agent` が返す各 agent のモデルを集める。
2. プロバイダーの baseURL を `integration.ts` の `hostOf` で opencode.json から読む。この PC（`where === 'device'`）のときだけ触る。LAN の LM Studio は他人の PC かもしれないので触らない。
3. 各モデルについて、`GET /api/v1/models` の `loaded_instances[].config.context_length` を見る。
   - 載っていない → `POST /api/v1/models/load { model, context_length }`
   - 載っているが短い → `POST /api/v1/models/unload { instance_id }` のあと load
   - 足りている → 何もしない

### 載せる長さ

- 設定に「ローカルモデルのコンテキスト長」を 1 つ置く（既定 65536）。
- `limit.context` がそれより小さければそちらを使い、`max_context_length` を超えない。
- 初版は固定の値でよい。実際のプロンプトの大きさは、のちに `session.error` の数字から学べる。

### 外すかどうか

- hangar が載せたものは、`instance_id` を `<home>/opencode/local-models-loaded.json` に記録しておき、hangar が外してよい。
- 利用者が手で載せたもの（記録に無いもの）は**勝手に外さない**。足りないときだけ、ダイアログで「◯◯を外して載せますか」と 1 問だけ聞く。
- 同じ会話で使うモデルの合計が物理メモリ（`os.totalmem()`）の 8 割を超えるなら、起動前に「このモデルの組は同時に載りません」と知らせる。あわせて E の案内（サブエージェントも同じモデルにすれば、並列で回るので足りる）を出す。

### 画面

- `shared` に `LaunchPrep`（`phase: 'checking' | 'loading' | 'ready' | 'failed'`、モデル名、進み）を足し、`delivery.hub` で配る。
- 新しいセッションのダイアログの送信ボタンの下に 1 行「◯◯ を読み込み中…」を出す。出るときは `growIn`、終わったら `collapseOut`。
- 失敗はダイアログの中の札に、理由と直し方を書く。
- 起動後に落ちたとき（A）：`live.ts` で `session.error` を拾う。本文に `greater than the context length` があれば、右下に札「モデルのコンテキストが足りません」と「整えて再開」を出す。
- 試作を作ってから選ぶ（開発の流れ）。動きも試作に入れる。

### 広げ方

- `provider/opencode/localModels/` に共通の型 `LocalModelHost`（`list`、`load`、`unload`）を置き、`lmstudio.ts` と `ollama.ts` を実装する。
- Ollama は、呼ぶときの `num_ctx` で載せ直されるので、「整える」は暖機（`POST /api/generate { model, keep_alive, options.num_ctx }`）だけでよい。
- REST が 404 を返す古い LM Studio では、黙って飛ばして A の検出だけにする。

### 試験

REST を `fetch` の差し替えで偽装し、次を確かめる。

1. 載っていない → load が呼ばれる
2. 8192 で載っている → unload のあと load
3. 65536 で載っている → 何もしない
4. 手で載せた別のモデルがあり、合計が超える → 問いが返る
5. LAN の baseURL → 触らない
6. REST が 404 → 飛ばす

実物では、`lms ps` の CONTEXT が変わることを目で確かめる。

### docs

`docs/design.md` の opencode の起動の節に「ローカルモデルの下ごしらえ」を足す。

## 確かめていないこと

- REST で載せたモデルが、JIT の自動の入れ替え（Auto-Evict）の対象になるか。`lms ps` の LOAD CONFIG の列を見る。
- Auto-Evict の設定がどこにあるか。`settings.json` には `unloadPreviousJITModelOnLoad`・`jitModelTTL` の項目が無かった。
- メモリが足りないときの HTTP の応答。
- `lms load --estimate-only` の出力の形。
- 認証トークンを有効にした LM Studio のヘッダ。
- REST で `ttl` を渡せるか。渡せなければ、CLI（`lms load --ttl`）に落とす。

## 決まっていないこと

- 利用者が agent ごとに別のモデルを書くのは意図してのことか。意図があるなら、2 つを同時に載せられるかの見積もりが要る。無いなら「1 モデルに寄せる」案内を既定にできる。

参照：LM Studio の REST の文書（`/docs/developer/rest/load`、`/rest/unload`、`/rest/list`、`/core/ttl-and-auto-evict`）。
