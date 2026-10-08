# 段 1 PR 6 Worker の引き算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker を「量を数えない、古い端末に合わせない」形にする。端末に求める互換の版の下限を 1 に上げ、D1 の書き込みの台帳を外し、設定の同期と古い端末のための経路と DELETE を消し、D1 の上限の失敗を 429 で返し、消したものが D1 に残した行を 1 回だけ片付ける。端末の側も、古い Worker のための分岐を消し、Worker に求める下限を 1 に上げる。

**Architecture:** Worker の入口（`packages/cloud/src/index.ts`）は既定の輸出だけにし、組み立ては新しい `app.ts` に移す。
書き込みはすべて素の `db.batch` と `stmt.run()` に戻して `meter.ts` を消す。
後始末は、isolate ごとに 1 度走るスキーマの用意（`ensureSchema`）から呼び、`meta` に済んだ印を置いて 2 度目からは走らせない。
上限の失敗は `onError` で D1 の文から見分けて 429 にする。
端末は Worker の版を 2xx の応答でだけ読み、下限 1 で古い Worker を断るので、`/usage` の 404 の読み替えは要らなくなる。
一時停止中に版で止まったときの切り替えの表示は、同期の状態に一時停止の印を足して直し、見え方は試作で利用者に選んでもらう。

**Tech Stack:** TypeScript、Hono、miniflare と esbuild（Worker の試験）、vitest、React（UI の presenter と view）、wrangler（配備だけ。利用者に聞いてから）。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md`（「消すもの」の D4、D6、使われていない口、古い版のための分岐、「残す境界」、「互換の版番号（D10）」、「上限による失敗で退く（D4）」、「後始末」、「PR の割り方」の PR 6 の行）。
段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md` の D4、D6、D8、D9、D10。
いまの作りは `docs/design.md` の「クラウド同期」の節（構成と setup、同期対象と暗号化、使用量と費用、タイミングと競合、互換の版番号）。
書き方の手本は `docs/superpowers/plans/2026-10-07-stage1-pr3-compat-version.md`。

## 着手の前に確かめること

PR 6 は、段 1 の PR 4（設定の同期を端末から消す）と PR 5（端末の見張りを消し、上限の失敗で退く）の後に入る。
この計画は、PR 4 と 5 が spec の「PR の割り方」の行どおりに入った main から切る前提で書いた。
worktree を切って `npm ci` を打ったら、次の 4 つを確かめる。
1 つでも外れたら手を止め、外れた内容を添えて親に知らせる。

1. PR 5 で端末の見張りが消えている。

   Run: `git grep -n "QuotaCounter\|countingClient\|D1_WRITES_" -- packages`
   Expected: 何も出ない。

2. PR 4 で設定の同期が端末から消えている。

   Run: `git grep -n "sync/claudeConfig" -- packages`
   Expected: 何も出ない。

3. `deleteFile` を使っているのが、この PR で消す所だけである。

   Run: `git grep -ln "deleteFile" -- packages`
   Expected: `packages/server/src/sync/client.ts`、`packages/server/src/sync/client.test.ts`、`packages/server/test/fake-cloud.ts`、`packages/server/test/fake-cloud.test.ts` の 4 つだけ。

4. 端末が Worker の台帳の数を読んでいない。

   Run: `git grep -n "d1RowsToday" -- packages/server/src packages/ui packages/cli`
   Expected: 何も出ない（`packages/cloud`、`packages/shared/src/cloud.ts`、`packages/server/test/fake-cloud*.ts` に残っているのはよい。この PR で消す）。

同期に参加しているすべての端末が PR 3 以降の版（互換の版 1 を名乗る版）であることは、親の申し送りで満たしている（この PC の 1 台だけで、PR 3 の版に入れ替え済み）。

## 決めたこと

spec と親の申し送りが決めていない所を、次のように決めた。
2 と 5 は spec から外れる（報告に書く）。

1. **後始末は、スキーマの用意から 1 回だけ走らせる。**
   Workers には配備の後に 1 度だけ走る処理が無い。
   スキーマの用意（`schema.ts` の `ensureSchema`）は、isolate ごとに最初の要求で 1 度走る。
   そこから `cleanup.ts` の `cleanupStage1` を呼び、`meta` に `stage1_cleanup` の印が無いときだけ消す。
   消す 2 文と印を置く 1 文は 1 つの batch に入れる（D1 の batch は 1 つの取引なので、半端に残らない）。
   印を読む 1 文は、cold start のたびに払う（1 行の読み取り）。
   後始末が落ちても要求は落とさず、次の cold start でまた試す。
   cron の `scheduled` を足す案は、配備の設定（`triggers`）と同梱の束縛の定義が増えるので採らなかった。
   R2 の `config/` の本体は spec どおり孤児の掃除に任せる（索引の行が消えれば、掃除が「索引に無い本体」として 1 時間の猶予の後に消す）。
2. **この PC が Worker に求める下限（`MIN_WORKER_COMPAT`）も 1 に上げる。**
   spec の PR 6 の行は「端末の側の古い Worker のための分岐（`/usage` の 404）も消す」とだけ書き、下限を上げるとは書いていない。
   ただし全体計画の D10 は「古い版のための分岐は、この 1 規則に置き換える」である。
   下限を 0 のまま 404 の読み替えだけを消すと、古い Worker は断られずに `/usage` で失敗し続け、理由がどこにも出ない。
   上げると、配備の順番が決まる（Worker を先に配備し、アプリの入れ替えはその後。Task 12）。
3. **Worker の版は 2xx の応答でだけ読む**（PR 3 の申し送りの 2 つ目）。
   いまは「500 未満で、408 でも 429 でもない応答」で読んでいる。
   Cloudflare の端が Worker を通さずに返す 4xx（WAF の 403、本文が大きすぎるときの 413 など）は見出しを持たないので、下限を 1 にすると「Worker が古い」と読み違える。
   2xx は Worker を通らないと返らないので、2xx だけで読めば読み違えない。
   古い Worker は、どの経路でも最初の 2xx で見分けられる。
4. **Worker の入口から名前付きの輸出を外す**（PR 3 の申し送りの 3 つ目）。
   入口の名前付きの輸出を Workers がどう扱うかは、クラス（Durable Object と WorkerEntrypoint）以外について文書に書かれていない。
   配備で確かめる代わりに、`createApp` を `app.ts` へ移し、入口を PR 3 より前と同じ既定の輸出だけの形に戻して、問いそのものを無くす。
   配備の前には手元の `wrangler deploy --dry-run` でも確かめる（Task 12）。
5. **一時停止の印を同期の状態（`SyncStatusDto.paused`）に足す**（PR 3 の申し送りの 1 つ目）。
   いまは、一時停止中に版で止まると状態が `error` になり、画面は「同期を一時停止」のボタンを出して、動いているように見える。
   画面だけでは一時停止しているかを知る手が無いので、サーバが印を載せる。
   見え方は試作で選んでもらう（Task 1）。
   spec の「消すもの」には無い、項目の追加である。
6. **429 の本文は `{ error: 'limit', limit: 'd1-read' | 'd1-write', resetAt }` にする。**
   `resetAt` は次の UTC の 0 時（epoch のミリ秒）。
   端末（PR 5）は 429 を受けたら次の UTC の 0 時まで退くので、本文は読まなくても動く。
   本文は、記録と、後で画面に種類を出すときのために載せる。
   PR 5 が shared に同じ役の型を置いていれば、その名前と形に合わせる（Task 6 の Step 1 で確かめる）。
7. **長さを名乗らない `PUT` は 411 で断る。**
   長さの無い本文を受ける道（`storeBody` と multipart）は、PR 3 より前の端末のためのもので、下限 1 で要らなくなる。
8. **`config/` の鍵は、Worker が書くのも読むのも 400 で断る。**
   後始末の後は索引に `config` の行が無く、読みに来る端末も無い。
9. **台帳の行は、後始末で全部消す。**
   いまは孤児の掃除が 7 日より古い台帳の行を刈っている。
   台帳を書かなくなるので、その刈り込みは掃除から外す。

## Global Constraints

- Worker の `MIN_DEVICE_COMPAT` は `1`、端末の `MIN_WORKER_COMPAT` は `1`。`COMPAT_VERSION` は `1` のまま上げない。
- 上限として見分ける D1 の文は `free tier daily row read limit` と `free tier daily row write limit`（大文字と小文字は問わない。例外の `cause` の文も見る）。
- 429 の本文は `{ error: 'limit', limit: 'd1-read' | 'd1-write', resetAt: <次の UTC の 0 時の epoch ミリ秒> }`。
- 長さの無い `PUT /files/<key>` は 411 と `{ error: 'length required' }`。
- 後始末の印は `meta` の鍵 `stage1_cleanup`（値は済ませた時刻の文字列）。
- 後始末で消すのは、`files` の `kind = 'config'` の行と、`meta` の鍵が `d1_rows:` で始まる行だけ。R2 には触らない。
- spec の「残す境界」を守る。`files.kind` の列、`sessions.provider`、使用量の表示（`/usage`、`CloudUsagePoller`、`CLOUD_FREE_LIMITS`）、端末の puller と teardown の「kind が transcript でない行を読み飛ばす」分岐、`isSafeRelPath` と `MAX_REL_PATH_CHARS` と `encodeHeaderText` は残す。
- 実物のクラウドに触る手順（`wrangler deploy`、`wrangler d1 execute --remote`、Worker の URL への要求）は、Task 12 で利用者に聞いてから行う。聞かずに打たない。やらなかったときは報告に「実物では未確認」と書く。
- 公開リポジトリである。実在の人名、メール、手元のパス、Worker の URL、アカウントの識別子、使用量や費用の実数を、コード、試験、コメント、コミット、文書に書かない。
- 作業の前に、worktree の根で `npm ci` を打つ。
- 試験は vitest で、リポジトリの根で `npx vitest run <ファイルかディレクトリ>`。型は `npm run typecheck`。
- 各タスクは「試験を書く、落ちるのを見る、実装する、通るのを見る」の順に進める。
- コードのコメントは日本語で、周りと同じ密度にする。
- 文書（design.md、README.md）は日本語で一文一行にし、中黒（U+30FB）と em ダッシュ（U+2014）を使わない。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- git のコマンドはほかのコマンドと 1 行に混ぜず、1 本ずつ打つ。
- 行番号は main `4936a7c`（設計書は `33ca14e`）を読んだ値である。PR 4 と 5 の後でずれているので、編集の前に、書かれた文字列で場所を確かめる。
- 試験でサーバを起こすときは、存在する一時ディレクトリを `TMUX_TMPDIR` に渡す。`tmux kill-server` は呼ばない。

## Review Focus

- **配備した直後の最初の要求（cold start）で後始末が走る**：その要求は普段どおり答え、後始末が落ちても 500 にせず、次の cold start でまた試す（Task 5 の試験で留める）。
- **設定の同期を一度も使っていない箱（`config` の行が 0 件）**：印を残し、2 度目の cold start で消しにいかない（Task 5 の試験で留める）。
- **D1 の上限の文が `cause` の側にだけ載る、または大文字と小文字が違う**：500 にせず 429 にする（Task 6 の試験で留める）。
- **Cloudflare の端が Worker を通さずに返す 403（WAF）や 413**：Worker が古いとは読まず、その状態の `CloudError` にする（Task 8 の試験で留める）。
- **長さを名乗らない `PUT`**：411 で断り、R2 にも索引にも何も残さない（Task 4 の試験で留める）。

---

### Task 1: 試作（一時停止中に版で止まったときの見え方）

画面の見え方が変わるので、実装（Task 10）の前に試作を作って利用者に選んでもらう。
選ぶのを待つ間に Task 2 から Task 9 を進めてよい（画面に触らない）。

**Files:**
- Create: `docs/superpowers/specs/2026-10-08-sync-paused-compat/options.html`

**Interfaces:**
- Consumes: なし。
- Produces: 利用者が選んだ案の記号（`A`、`B`、`C` のどれか）。Task 10 がこれで実装を選ぶ。

- [ ] **Step 1: 試作を書く**

`docs/superpowers/specs/2026-10-08-sync-paused-compat/options.html` を作る。
場面は「利用者が同期を一時停止したまま『今すぐ同期』を押し、クラウドに版が古いと断られた」である。
ヘッダーの同期の一行（`packages/ui/src/views/SyncStatus.tsx`）と、設定の「クラウド同期」の節の状態とボタン（`packages/ui/src/views/SettingsScreen.tsx`）を、いまの姿と 3 つの案で並べる。

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>一時停止中に版で止まったとき</title>
<style>
:root {
  --bg: #eef1f7; --surface: #ffffff; --ink: #1c1b2e; --ink-2: #5f5e78; --ink-3: #6e6d88;
  --accent: #4a63e8; --accent-hi: #6b8cff; --accent-soft: #eef2ff; --error: #b3261e;
  --font-sans: 'Inter Variable', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', sans-serif;
  --font-mono: 'JetBrains Mono Variable', 'SFMono-Regular', Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink); font: 13px/1.5 var(--font-sans); }
.wrap { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
.lead { color: var(--ink-2); margin: 0 0 20px; line-height: 1.6; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); gap: 16px; }
.opt { border-radius: 18px; padding: 12px; background: rgba(255,255,255,0.45); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.8); }
.opt.now { opacity: 0.75; }
.opt-h { display: flex; align-items: baseline; gap: 8px; margin: 2px 4px 10px; }
.letter { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--ink); color: #fff; font-size: 12px; font-weight: 700; }
.d { color: var(--ink-2); font-size: 12px; }
.cap { font-size: 11px; color: var(--ink-3); margin: 8px 4px 4px; }
.bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 12px; background: var(--surface); }
.label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; font: 12px var(--font-mono); color: var(--error); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.label span { overflow: hidden; text-overflow: ellipsis; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); flex: none; }
.btn { flex: none; display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border: 0; border-radius: 99px; font: 560 12px var(--font-sans); color: var(--ink); background: rgba(255,255,255,0.78); box-shadow: inset 0 1px 0 #fff, 0 1px 3px rgba(30,40,90,0.14); }
.settings { padding: 12px 16px; border-radius: 14px; background: var(--surface); }
.meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; }
.btns { display: flex; gap: 8px; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
<h1>一時停止中に、版で止まったとき</h1>
<p class="lead">利用者が同期を一時停止したまま「今すぐ同期」を押し、クラウドに版が古いと断られた場面です。<br>上がヘッダーの同期の一行、下が設定の「クラウド同期」の節です。<br>文は幅が足りないと省略記号で切れ、全文は title で読めます。</p>
<div class="grid">

<div class="opt now">
  <div class="opt-h"><span class="letter">今</span><b>いま</b><span class="d">一時停止しているのに「同期を一時停止」が出て、動いているように見える</span></div>
  <div class="cap">ヘッダー</div>
  <div class="bar"><span class="label" title="同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください"><span class="dot"></span><span>同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください</span></span><button class="btn">今すぐ同期</button><button class="btn">同期を一時停止</button></div>
  <div class="cap">設定</div>
  <div class="settings"><div class="meta"><span>状態 同期エラー</span><span>最後の受信 3 分前</span><span>未送信 2 件</span></div><div class="btns"><button class="btn">今すぐ同期</button><button class="btn">同期を一時停止</button></div></div>
</div>

<div class="opt">
  <div class="opt-h"><span class="letter">A</span><b>ボタンだけ直す（推す）</b><span class="d">文はエラーのまま。切り替えを「同期を再開」にする</span></div>
  <div class="cap">ヘッダー</div>
  <div class="bar"><span class="label" title="同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください"><span class="dot"></span><span>同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください</span></span><button class="btn" title="一時停止のまま、1 回だけ同期する">今すぐ同期</button><button class="btn">同期を再開</button></div>
  <div class="cap">設定</div>
  <div class="settings"><div class="meta"><span>状態 同期エラー</span><span>最後の受信 3 分前</span><span>未送信 2 件</span></div><div class="btns"><button class="btn" title="一時停止のまま、1 回だけ同期する">今すぐ同期</button><button class="btn">同期を再開</button></div></div>
</div>

<div class="opt">
  <div class="opt-h"><span class="letter">B</span><b>文でも一時停止を言う</b><span class="d">文の頭に「一時停止中 · 」を添え、切り替えは「同期を再開」</span></div>
  <div class="cap">ヘッダー</div>
  <div class="bar"><span class="label" title="一時停止中 · 同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください"><span class="dot"></span><span>一時停止中 · 同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください</span></span><button class="btn" title="一時停止のまま、1 回だけ同期する">今すぐ同期</button><button class="btn">同期を再開</button></div>
  <div class="cap">設定</div>
  <div class="settings"><div class="meta"><span>状態 一時停止中 · 同期エラー</span><span>最後の受信 3 分前</span><span>未送信 2 件</span></div><div class="btns"><button class="btn" title="一時停止のまま、1 回だけ同期する">今すぐ同期</button><button class="btn">同期を再開</button></div></div>
</div>

<div class="opt">
  <div class="opt-h"><span class="letter">C</span><b>止まっている間は切り替えを隠す</b><span class="d">再開しても版が合うまで同期できないので、切り替えを出さない</span></div>
  <div class="cap">ヘッダー</div>
  <div class="bar"><span class="label" title="同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください"><span class="dot"></span><span>同期エラー: この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は 1、クラウドが求めるのは 2 以上）。この PC の hangar を新しい版に入れ替えてください</span></span><button class="btn" title="一時停止のまま、1 回だけ同期する">今すぐ同期</button></div>
  <div class="cap">設定</div>
  <div class="settings"><div class="meta"><span>状態 同期エラー</span><span>最後の受信 3 分前</span><span>未送信 2 件</span></div><div class="btns"><button class="btn" title="一時停止のまま、1 回だけ同期する">今すぐ同期</button></div></div>
</div>

</div>
</div>
</body>
</html>
```

- [ ] **Step 2: ブラウザで開いて自分で見る**

WebKit で開いて撮り、4 つの枠が崩れずに並んでいることと、文が省略記号で切れていることを見る（画面の確認は利用者に返さない）。

- [ ] **Step 3: 利用者に選んでもらう**

ファイルの場所を添えて、AskUserQuestion で 1 問だけ聞く。
推す案を先頭に置く。

- 問い：「一時停止中に版で止まったとき、ヘッダーと設定の同期の切り替えをどう見せますか（試作 docs/superpowers/specs/2026-10-08-sync-paused-compat/options.html）」
- 選択肢：「A：ボタンだけ直す（推す）」「B：文でも一時停止を言う」「C：止まっている間は切り替えを隠す」

選んだ記号を控え、Task 10 で使う。
利用者が選ぶまで Task 10 には入らない。

- [ ] **Step 4: コミットする**

```bash
git add docs/superpowers/specs/2026-10-08-sync-paused-compat/options.html
```

```bash
git commit -m "docs: prototype how a paused sync stopped on a compat mismatch should look" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker の入口を既定の輸出だけにする

**Files:**
- Create: `packages/cloud/src/app.ts`
- Modify: `packages/cloud/src/index.ts`（ファイル全体を置き換える）
- Modify: `packages/cloud/test/harness.ts`（`workerScript` の `stdin.contents` の import 先）
- Modify: `packages/cloud/test/build-worker.test.ts`（試験を 1 つ足す）

**Interfaces:**
- Consumes: いまの `createApp`（`packages/cloud/src/index.ts`）。
- Produces:
  - `createApp(o: { minDeviceCompat: number }): AppType` を `packages/cloud/src/app.ts` から輸出する。Task 6 が `onError` を書き換える。
  - `packages/cloud/src/index.ts` は `export default createApp({ minDeviceCompat: MIN_DEVICE_COMPAT })` だけを持つ。

- [ ] **Step 1: 試験を書く**

`packages/cloud/test/build-worker.test.ts` の「束は外への import を持たない 1 本の ESM で…」の試験の次に足す。

```ts
  // 入口の名前付きの輸出を Workers がどう扱うかは、クラス（Durable Object と WorkerEntrypoint）以外について文書に書かれていない。
  // 入口は既定の輸出だけにして、配備で確かめなければならない問いそのものを無くす。組み立ては src/app.ts にある。
  it('入口の束は既定の輸出だけを持つ', async () => {
    const script = await bundleWorker(cloudDir);
    const exported = [...script.matchAll(/^export\s*\{([^}]*)\}/gm)]
      .flatMap((m) => m[1]!.split(','))
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => s.split(/\s+as\s+/).pop()!);
    expect(exported).toEqual(['default']);
    expect(script).not.toMatch(/^export\s+(const|let|var|function|async function|class)\s/m);
  });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/cloud/test/build-worker.test.ts`
Expected: FAIL（いまの束は `createApp` も名前付きで輸出しているので、`exported` が `['createApp', 'default']` になる）。

- [ ] **Step 3: 組み立てを app.ts へ移す**

`packages/cloud/src/app.ts` を作る。
中身は、いまの `packages/cloud/src/index.ts` の `createApp` とその上の `MAX_LOG_LEN` をそのまま移したものである。
移す前に、いまのファイルとこの写しが同じかを見比べ、違えばいまのファイルの方を移す。

```ts
import { Hono } from 'hono';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { authMiddleware } from './auth.ts';
import { changesApp, rowsApp } from './changes.ts';
import { compatMiddleware } from './compat.ts';
import type { AppType, Env, Vars } from './env.ts';
import { filesApp } from './files.ts';
import { joinHandler } from './join.ts';
import { ensureSchema } from './schema.ts';
import { collectUsage } from './usage.ts';
import { VERSION } from './util.ts';

/** 記録に残す文言の上限である。長い SQL や本文の断片を垂れ流さない。 */
const MAX_LOG_LEN = 200;

/**
 * クラウド Worker を組み立てる。端末ごとのトークンで認証し、変更ログとファイルを預かる。中身の暗号化は端末側で行う。
 *
 * 端末に求める互換の版の下限を引数で受けるのは、試験が下限を差し替えた Worker を起こすためである（test/harness.ts）。
 * 配備される Worker は、入口（index.ts）の既定の輸出だけを使う。
 */
export function createApp(o: { minDeviceCompat: number }): AppType {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // 版の関所は最初に通す。断る要求で、スキーマの用意（D1 への問い合わせ）も認証も走らせない。
  app.use('*', compatMiddleware(o.minDeviceCompat));
  app.use('*', async (c, next) => {
    await ensureSchema(c.env);
    await next();
  });
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, compat: COMPAT_VERSION }));

  // 参加だけは端末トークンを持たずに叩ける。中で参加用の秘密のハッシュを検査する。
  app.post('/join', joinHandler);

  // ここから下は端末トークンが要る。経路を足すときは必ずこの一覧にも足す。
  app.use('/changes', authMiddleware());
  app.use('/changes/*', authMiddleware());
  app.use('/rows', authMiddleware());
  app.use('/rows/*', authMiddleware());
  app.use('/files', authMiddleware());
  app.use('/files/*', authMiddleware());
  app.use('/usage', authMiddleware());

  app.route('/changes', changesApp);
  app.route('/rows', rowsApp);
  app.route('/files', filesApp);

  // 使用量と費用。トークンの secret が無ければ外へ出ずに configured: false を返す。D1 には書かない。
  app.get('/usage', async (c) => {
    const token = c.env.USAGE_API_TOKEN?.trim();
    const accountId = c.env.CF_ACCOUNT_ID?.trim();
    if (!token || !accountId) return c.json({ configured: false });
    return c.json(await collectUsage({ token, accountId, fetch: (input, init) => fetch(input, init), now: Date.now() }));
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  /**
   * 想定していない例外である。
   * 外へ返すのは一般化した 1 語だけにする。
   * D1 と R2 の文言には表と列と束縛の様子が出るので、そのまま返すと内側の作りを教えてしまう。
   * 詳しい内容は記録にだけ残す。記録に載るのは方式と経路と例外の名前と 1 行目で、
   * 参加用の秘密も端末トークンも本文も問い合わせ文字列も載せない。
   */
  app.onError((e, c) => {
    const name = e instanceof Error ? e.name : typeof e;
    const line = (e instanceof Error ? e.message : '').split('\n')[0]!.trim().slice(0, MAX_LOG_LEN);
    console.error('worker error', c.req.method, new URL(c.req.url).pathname, name, line);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
```

`packages/cloud/src/index.ts` を次の内容に置き換える。

```ts
import { createApp } from './app.ts';
import { MIN_DEVICE_COMPAT } from './compat.ts';

/**
 * 配備される Worker の入口である。既定の輸出だけを置く。
 * 入口の名前付きの輸出を Workers がどう扱うかは、クラス（Durable Object と WorkerEntrypoint）以外について文書に書かれていない。
 * 組み立ては app.ts に置き、試験は下限を差し替えた Worker を app.ts から組む（test/harness.ts）。
 */
export default createApp({ minDeviceCompat: MIN_DEVICE_COMPAT });
```

`packages/cloud/test/harness.ts` の `workerScript` の中の `contents` を、`./app.ts` から取る形に替える。

```ts
            contents: `import { createApp } from './app.ts';\nexport default createApp({ minDeviceCompat: ${minDeviceCompat} });\n`,
```

同じファイルの `workerScript` の説明の「配備される入口（src/index.ts の既定の輸出）は MIN_DEVICE_COMPAT のままである。」は、そのまま残す。

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/cloud`
Expected: PASS（`build-worker.test.ts` の新しい試験と、下限を差し替えた Worker を使う `compat.test.ts` と `client-e2e.test.ts` を含む）。

- [ ] **Step 5: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: コミットする**

```bash
git add packages/cloud/src/app.ts packages/cloud/src/index.ts packages/cloud/test/harness.ts packages/cloud/test/build-worker.test.ts
```

```bash
git commit -m "refactor(cloud): keep only the default export in the Worker entry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 台帳を外し、書き込みを素の D1 に戻す

**Files:**
- Delete: `packages/cloud/src/meter.ts`
- Delete: `packages/cloud/test/meter.test.ts`
- Modify: `packages/cloud/src/changes.ts`（import、`compact`、`POST /`、`GET /`）
- Modify: `packages/cloud/src/files.ts`（import、`PUT` と `DELETE` の書き込み）
- Modify: `packages/cloud/src/join.ts`（import と upsert）
- Modify: `packages/cloud/src/schema.ts`（import と 2 つの batch）
- Modify: `packages/cloud/src/sweep.ts`（説明、import、当番の取り合い、`sweepOnce`、`sweepEntries`、`LEDGER_KEEP_DAYS`）
- Modify: `packages/shared/src/cloud.ts`（`PushChangesResponse` と `PullChangesResponse`）
- Modify: `packages/cloud/test/changes.test.ts`（応答の形の道具と、試験を 1 つ）
- Modify: `packages/cloud/test/sweep.test.ts`（台帳で測っていた試験を外す）
- Modify（PR 5 の後に残っていれば）: `packages/server/test/fake-cloud.ts`、`packages/server/test/fake-cloud.test.ts`
- Delete（PR 5 の後に残っていれば）: `packages/server/test/fake-cloud-usage.test.ts`

**Interfaces:**
- Consumes: なし。
- Produces:
  - `PushChangesResponse = { seq: number; accepted: number; skipped: number }`
  - `PullChangesResponse = { changes: ChangeOut[]; nextSeq: number; more: boolean }`
  - Worker のどの経路も `meta` に `d1_rows:` の行を書かない。
  - `sweep.ts` から `LEDGER_KEEP_DAYS` が消える。

- [ ] **Step 1: 試験を書く**

`packages/cloud/test/changes.test.ts` の、push と pull の応答の形の道具を次に置き換える（`pushed` の型、`pushResult`、`pullResult` とその説明）。

```ts
const pushed = async (tok: string, changes: unknown): Promise<{ seq: number; accepted: number; skipped: number }> =>
  (await (await push(tok, changes)).json()) as { seq: number; accepted: number; skipped: number };

/** push の応答の形。Worker は量を数えないので、連番と採った数と捨てた数だけを返す。 */
const pushResult = (o: { seq: number; accepted: number; skipped: number }) => o;

/** pull の応答の形。 */
const pullResult = (o: { changes: unknown[]; nextSeq: number; more: boolean }) => o;
```

`describe('POST /changes', …)` の最後に足す。

```ts
  it('量を数えるための行を D1 に書かない', async () => {
    await pushed(tokA, [ch('p1', 1)]);
    await pull(tokB, 0);
    const n = await cloud.env.DB.prepare("select count(*) as n from meta where substr(key, 1, 8) = 'd1_rows:'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/cloud/test/changes.test.ts`
Expected: FAIL（応答に `d1RowsToday` が載っていて `toEqual` が合わず、`meta` に台帳の行がある）。

- [ ] **Step 3: shared の応答の型から台帳の数を外す**

`packages/shared/src/cloud.ts` の `PushChangesResponse` と `PullChangesResponse` とその説明を、次の 3 行に置き換える。

```ts
/** push の応答である。seq はサーバの連番の高水位、accepted は採った行、skipped は新しくなかったので捨てた行の数である。 */
export type PushChangesResponse = { seq: number; accepted: number; skipped: number };
export type PullChangesResponse = { changes: ChangeOut[]; nextSeq: number; more: boolean };
```

- [ ] **Step 4: Worker の書き込みを素の D1 に戻す**

`packages/cloud/src/changes.ts`：

import の `import { d1RowsToday, meteredBatch } from './meter.ts';` の行を消す。

`compact` の最後の `await meteredBatch(db, stmts, now);` を次に置き換える。

```ts
  await db.batch(stmts);
```

`POST /` の `await meteredBatch(db, stmts, now);` から `return c.json(res);` までを次に置き換える。

```ts
  await db.batch(stmts);
  const seq = await maxSeq(db);
  // 連番は 1 回の push で最大 40 飛ぶ。倍数に当たるかで測ると圧縮がほとんど走らないので、前回からの差で測る。
  if (accepted > 0 && seq - (await readMetaInt(db, META_LAST_COMPACT_SEQ)) >= COMPACT_EVERY) await compact(db, now, seq);
  const res: PushChangesResponse = { seq, accepted, skipped };
  return c.json(res);
```

`GET /` の `const now = Date.now();` から `return c.json(res);` までを次に置き換える。

```ts
  const now = Date.now();
  await db.prepare('update devices set last_seen_at = ?, last_pulled_seq = max(last_pulled_seq, ?) where id = ?').bind(now, nextSeq, device.id).run();
  const res: PullChangesResponse = { changes: page.map(toOut), nextSeq, more };
  return c.json(res);
```

`packages/cloud/src/files.ts`：

import の `import { meteredBatch } from './meter.ts';` の行を消す。

`PUT` の `const r = await meteredBatch(c.env.DB, [` から `], now);` までを、次の形に替える（中の 3 文はそのまま）。

```ts
  const r = await c.env.DB.batch([
    c.env.DB.prepare('delete from files where key = ?').bind(key),
    c.env.DB
      .prepare('insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, path, kind, device.id, sha, size, storedSize, mtime, enc === '1' ? 1 : 0, now),
    c.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(now, device.id),
  ]);
```

`DELETE` の `const now = Date.now();` と `await meteredBatch(…);` の 2 行を、次の 1 行に置き換える（経路そのものは Task 4 で消す）。

```ts
  await c.env.DB.prepare('delete from files where key = ?').bind(key).run();
```

`packages/cloud/src/join.ts`：

import の `import { meteredRun } from './meter.ts';` の行を消す。
upsert の前の 2 行のコメント（「端末の upsert は devices の本体と…」「この経路は SyncEngine を通らないので…」）を消し、`await meteredRun(c.env.DB, upsert, now);` を次に置き換える。

```ts
  await upsert.run();
```

`packages/cloud/src/schema.ts`：

import の `import { meteredBatch } from './meter.ts';` の行を消す。
`doEnsure` の「表と索引を作る書き込みも無料枠の rows_written に入る。台帳（meter.ts）を必ず通す。」のコメントと次の行を、次に置き換える。

```ts
  await env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)));
```

同じ関数の最後の `await meteredBatch(env.DB, [` から `], now);` までを、次の形に替える（中の 2 文はそのまま）。

```ts
  await env.DB.batch([
    env.DB.prepare('update join_secrets set revoked_at = ? where revoked_at is null').bind(now),
    // 同時に来た要求どうしがぶつかっても、先に入れた行をそのままにする。
    env.DB
      .prepare('insert into join_secrets (id, secret_hash, created_at, revoked_at) values (?, ?, ?, null) on conflict(secret_hash) do nothing')
      .bind(crypto.randomUUID(), hash, now),
  ]);
```

`packages/cloud/src/sweep.ts`：

import の `import { META_D1_ROWS_PREFIX, meteredBatch } from './meter.ts';` の行を消す。

ファイルの頭の説明の「1 回の掃除が D1 に書くのは、続きの控えと日ごとの台帳で 10 行ほどである。」を次に置き換える。

```ts
 * 1 回の掃除が D1 に書くのは、当番の印と続きの控えと、消した索引の行だけである。
```

`LEDGER_KEEP_DAYS` の定数とその説明の 2 行を消す。

`sweepIfDue` の `const claim = await meteredBatch(` から `);` までを次に置き換える。

```ts
  const claim = await db.batch([
    db
      .prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value where cast(meta.value as integer) <= ?')
      .bind(META_SWEEP_AT, String(now), now - SWEEP_EVERY_MS),
  ]);
```

`sweepOnce` の `const stmts = …` から `await meteredBatch(db, stmts, now);` までを次に置き換える（台帳の刈り込みを外す）。

```ts
  await db.batch([putMeta(db, META_SWEEP_CURSOR, bodies.cursor), putMeta(db, META_SWEEP_SEQ, String(entries.seq))]);
```

`sweepEntries` の `await meteredBatch(` から `);` までを次に置き換える。

```ts
  await db.batch([db.prepare(`delete from files where key in (${doomed.map(() => '?').join(',')}) and uploaded_at < ?`).bind(...doomed, cutoff)]);
```

`sweepOnce` と `sweepEntries` の引数の `now` は、猶予の判定（`cutoff`）にまだ使うので残す。

`packages/cloud/src/meter.ts` と `packages/cloud/test/meter.test.ts` を消す。

```bash
git rm packages/cloud/src/meter.ts packages/cloud/test/meter.test.ts
```

- [ ] **Step 5: 掃除の試験から台帳で測っていた 1 本を外す**

`packages/cloud/test/sweep.test.ts` の 3 行目の `import { d1RowsToday } from '../src/meter.ts';` を消し、`it('掃除そのものが無料枠をほとんど使わない', …)` を丸ごと消す。
掃除の量の上限は、1 回に見る数の区切り（「1 回に見る数を区切り、続きは次の回から読む」）と 6 時間の間隔（「間隔が空くまでは走らない」）の試験で縛られている。

- [ ] **Step 6: 偽のクラウドに台帳が残っていれば外す**

Run: `git grep -n "d1RowsToday\|D1_ROWS\|noteD1" -- packages/server`
Expected: PR 5 で消えていれば何も出ない。そのときはこの Step を飛ばす。

出たら、それが `packages/server/test/fake-cloud.ts`、`packages/server/test/fake-cloud.test.ts`、`packages/server/test/fake-cloud-usage.test.ts` の 3 つだけであることを確かめてから、次を行う。
ほかのファイルが出たら、手を止めて親に知らせる（PR 5 の残りである）。

`packages/server/test/fake-cloud.ts`：

- `FakeCloudStore` から `d1Rows` と `lastSweepAt` の項目とその説明を消す。
- `D1_ROWS` と `SWEEP_EVERY_MS` の定数とその説明を消す。
- constructor の既定のストアから `lastSweepAt: null,` と `d1Rows: new Map(),` を消す。
- `d1RowsToday()`、`day()`、`noteFilePut()`、`noteD1()` の 4 つのメソッドとその説明を消す。
- `pushChanges` の `this.noteD1(…);` の行を消し、`return` を `return { seq: this.store.seq, accepted, skipped };` にする。
- `pullChanges` の `this.noteD1(…);` とその上のコメントを消し、返す値から `d1RowsToday` の行とその上のコメントを消す。
- `seedUnchecked` と `putFile` の `this.noteFilePut(meta.key);` の行を消す。
- `listFiles` の掃除の真似（`const at = …` から `}` まで）とその上のコメントを消す。
- `deleteFile` の中の `if (this.store.files.delete(key)) this.noteD1(…);` を `this.store.files.delete(key);` にする（メソッドそのものは Task 4 で消す）。

`packages/server/test/fake-cloud.test.ts` の `pushResult` とその説明を次に置き換える。

```ts
/** push の応答の形。Worker は量を数えないので、連番と採った数と捨てた数だけを返す。 */
const pushResult = (o: { seq: number; accepted: number; skipped: number }) => o;
```

`packages/server/test/fake-cloud-usage.test.ts` を消す（偽物の台帳を実物のスキーマで縛る試験で、縛る相手が無くなる）。

```bash
git rm packages/server/test/fake-cloud-usage.test.ts
```

- [ ] **Step 7: 通るのを見る**

Run: `npx vitest run packages/cloud packages/server/test packages/server/src/sync`
Expected: PASS。

- [ ] **Step 8: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし（`d1RowsToday` を読む所が残っていれば、ここで型が落ちる。そのときは手を止めて親に知らせる）。

- [ ] **Step 9: 台帳の名残が無いことを見る**

Run: `git grep -n "meter\.ts\|meteredBatch\|meteredRun\|d1RowsToday\|d1_rows" -- packages`
Expected: `packages/cloud/src/usage.ts` の `d1RowsWritten`（使用量の表示で、残す）以外に何も出ない。
`d1_rows` の文字は、Task 5 で後始末の文に書く。

- [ ] **Step 10: コミットする**

```bash
git add -A packages/cloud packages/shared/src/cloud.ts packages/server/test
```

```bash
git commit -m "refactor(cloud): drop the D1 write ledger and write through plain batches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 設定の同期、長さを名乗らない本文、DELETE の経路を消す

**Files:**
- Modify: `packages/cloud/src/files.ts`（`validKey`、`storeBody` とその道具、`PUT`、`DELETE`）
- Modify: `packages/cloud/src/sweep.ts`（頭の説明の DELETE の 1 文）
- Modify: `packages/cloud/test/files.test.ts`
- Modify: `packages/cloud/test/sweep.test.ts`（`put` の道具に長さを足す）
- Modify: `packages/server/src/sync/client.ts`（`CloudClient` と `HttpCloudClient` の `deleteFile`）
- Modify: `packages/server/src/sync/client.test.ts`
- Modify: `packages/server/test/fake-cloud.ts`（`checkKey`、`checkMeta`、`deleteFile`）
- Modify: `packages/server/test/fake-cloud.test.ts`

**Interfaces:**
- Consumes: Task 3 の素の書き込み。
- Produces:
  - `validKey(key: string, deviceId: string, method: 'PUT' | 'GET'): boolean`（`transcripts/` の鍵だけを通す）。
  - `PUT /files/<key>` は `kind` が `transcript` のものだけを受け、`content-length` が無ければ 411 と `{ error: 'length required' }`。
  - `DELETE /files/<key>` の経路は無い（認証の後は 404）。
  - `CloudClient` から `deleteFile` が消える。

- [ ] **Step 1: Worker の試験を書き直す**

`packages/cloud/test/files.test.ts` を次のとおり直す。

`put` の道具に長さを足す。
miniflare の `dispatchFetch` は本文の長さを付けずに流すので、端末と同じく明示する（9 MiB の試験と同じ扱いである）。

```ts
const put = (tok: string, key: string, body: string, headers: Record<string, string> = meta()): Promise<Response> =>
  cloud.SELF.fetch(`https://x/files/${key}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tok}`, 'content-length': String(new TextEncoder().encode(body).length), ...headers },
    body,
  });
```

`configMeta` と `del` の道具を消す。
`chunked` の道具を残す（長さの無い本文を断る試験で使う）。

「長さの無い本文（古い端末の chunked）も multipart で預け…」の試験を、次に置き換える。

```ts
  it('長さを名乗らない本文は、411 で断り、R2 にも索引にも残さない', async () => {
    const buf = patterned(256 * 1024);
    const r = await cloud.SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokA}`, ...meta({ [CLOUD_HEADERS.size]: String(buf.length) }) },
      body: chunked(buf),
      duplex: 'half',
    } as RequestInit);
    expect(r.status).toBe(411);
    expect(await r.json()).toEqual({ error: 'length required' });
    expect(await keysInR2()).toEqual([]);
    expect((await list(tokA)).files).toEqual([]);
  });
```

「無い鍵は 404、DELETE は本体と索引を消す」の試験を、次に置き換える。

```ts
  it('無い鍵は 404。本文を消す経路は無い', async () => {
    expect((await get(tokA, 'transcripts/dev-a/nope.gz')).status).toBe(404);
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    const d = await cloud.SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', { method: 'DELETE', headers: { authorization: `Bearer ${tokA}` } });
    expect(d.status).toBe(404);
    expect(await keysInR2()).toEqual(['transcripts/dev-a/u1.jsonl.gz']);
    expect((await list(tokA)).files.map((f) => f.key)).toEqual(['transcripts/dev-a/u1.jsonl.gz']);
  });
```

`describe('validKey', …)` を次に置き換える。

```ts
describe('validKey', () => {
  // 「.」「..」は URL の側で畳まれるので HTTP 越しには届かない。判定そのものはここで見る。
  it('transcripts の接頭辞と相対パスの形を見る', () => {
    expect(validKey('transcripts/dev-a/u1.gz', 'dev-a', 'PUT')).toBe(true);
    for (const k of [
      '',
      'u1.gz',
      'other/u1.gz',
      'transcripts',
      'transcripts/',
      '/transcripts/dev-a/u1.gz',
      'transcripts/dev-a/../dev-b/u1.gz',
      'transcripts/dev-a/./u1.gz',
      'transcripts/dev-a//u1.gz',
      'transcripts/a\u0000b',
      'transcripts/a\u001fb',
      'transcripts/a\u007fb',
      `transcripts/${'a'.repeat(513)}`, // 相対パスの文字数の上限
      `transcripts/${'あ'.repeat(400)}`, // R2 の鍵のバイト数の上限
    ])
      expect([k, validKey(k, 'dev-a', 'GET')]).toEqual([k, false]);
  });

  it('transcripts は自端末の分だけ書ける。読むのは誰でもよい', () => {
    expect(validKey('transcripts/dev-b/u1.gz', 'dev-a', 'GET')).toBe(true);
    expect(validKey('transcripts/dev-a/u1.gz', 'dev-a', 'PUT')).toBe(true);
    expect(validKey('transcripts/dev-b/u1.gz', 'dev-a', 'PUT')).toBe(false);
    expect(validKey('transcripts/dev-ax/u1.gz', 'dev-a', 'PUT')).toBe(false); // 接頭辞の一致だけでは通さない
    // 端末 ID の形も見る。スラッシュが混ざると他端末の接頭辞の下に潜り込める。
    expect(validKey('transcripts/dev-a/evil/u1.gz', 'dev-a/evil', 'PUT')).toBe(false);
    expect(validKey('transcripts/../dev-a/u1.gz', '..', 'PUT')).toBe(false);
  });

  it('config の鍵は、自端末の場所でも書くのも読むのも断る（設定の同期は段 1 で消した）', () => {
    for (const m of ['PUT', 'GET'] as const) {
      expect(validKey('config/dev-a/a.md', 'dev-a', m)).toBe(false);
      expect(validKey('config/dev-b/a.md', 'dev-a', m)).toBe(false);
    }
  });
});
```

`describe('鍵の検査', …)` の中を次のとおり直す。

- 「見出しが欠けていたり形が違えば 400」の `meta({ [CLOUD_HEADERS.kind]: 'config' }), // 接頭辞と種別が食い違う` を、`meta({ [CLOUD_HEADERS.kind]: 'config' }), // 設定の同期は段 1 で消した` にする。
- 「日本語と空白を含む config の鍵を通し、そのまま取り出せる」を次に置き換える。

```ts
  it('日本語と空白を含む鍵を通し、そのまま取り出せる', async () => {
    // 鍵の形の物差しは端末と共有しているので、ASCII に限った検査にすると端末で作れる鍵が黙って 400 になる。
    const key = 'transcripts/dev-b/日本語 メモ/u1.jsonl.gz';
    const r = await put(tokB, key, 'x', meta({ [CLOUD_HEADERS.size]: '1' }));
    expect(r.status).toBe(201);
    expect(await keysInR2()).toEqual([key]);
    expect((await list(tokA)).files.map((f) => f.key)).toEqual([key]);
    expect(await (await get(tokA, key)).text()).toBe('x');
  });
```

- 「見出しは非 ASCII を運べない…」の試験の `put(tokB, 'config/dev-b/a.md', 'x', configMeta('skills/日本語/SKILL.md'))` を、`put(tokB, 'transcripts/dev-b/u1.jsonl.gz', 'x', meta({ [CLOUD_HEADERS.path]: 'projects/-日本語/u1.jsonl' }))` にする。
- 「符号化した見出しを復号して索引に載せ、端から端まで通す」を次に置き換える。

```ts
  it('符号化した見出しを復号して索引に載せ、端から端まで通す', async () => {
    // 非 ASCII は見出しに直接載せられないので、端末が `encodeHeaderText` で符号化して送る。
    // Worker は同じ共有の関数で復号する。片方だけ変えると、索引に百分率のままの文字列が残る。
    const path = 'projects/-Users-x-日本語 メモ/u1.jsonl';
    const key = 'transcripts/dev-b/u1.jsonl.gz';
    const wire = encodeHeaderText(path)!;
    expect(isHeaderSafe(wire)).toBe(true);
    const r = await put(tokB, key, 'x', meta({ [CLOUD_HEADERS.path]: wire, [CLOUD_HEADERS.size]: '1' }));
    expect(r.status).toBe(201);
    const e = (await list(tokA)).files[0]!;
    expect([e.key, e.path]).toEqual([key, path]);
    expect(await (await get(tokA, key)).text()).toBe('x');
    // R2 の customMetadata は見出しのままの形で持つ（値も ByteString しか運べない）。
    expect((await cloud.env.BUCKET.head(key))?.customMetadata?.path).toBe(wire);
  });
```

- 「符号化すると R2 の覚え書きの上限を超える path でも上げられる…」の試験は、`path` を `` `projects/-${'あ'.repeat(300)}/u1.jsonl` `` に、`key` を `'transcripts/dev-b/u1.jsonl.gz'` に、`configMeta(wire)` を `meta({ [CLOUD_HEADERS.path]: wire, [CLOUD_HEADERS.size]: '1' })` にする。
- 「百分率の形が壊れた path の見出しは 400」の試験は、`put(tokB, 'config/dev-b/a.md', 'x', configMeta(wire))` を `put(tokB, 'transcripts/dev-b/u1.jsonl.gz', 'x', meta({ [CLOUD_HEADERS.path]: wire }))` にする。
- 「鍵の形の物差しは端末と 1 つを共有する」を次に置き換える。

```ts
  it('鍵の形の物差しは端末と 1 つを共有する（Worker はその上で transcripts だけを預かる）', () => {
    // `isValidFileKey` は端末側（`packages/server/src/sync/client.ts`）も通る共有の判定である。
    // transcripts の鍵でずれると、端末で作れる鍵が Worker で 400 になる（またはその逆になる）。
    for (const key of ['transcripts/dev-a/u1.jsonl.gz', 'transcripts/dev-a/日本語 メモ/u1.jsonl.gz', 'transcripts/dev-a/a%b.gz']) {
      expect([key, isValidFileKey(key), validKey(key, 'dev-a', 'GET')]).toEqual([key, true, true]);
    }
    for (const key of ['other/u1', 'transcripts', 'transcripts/', 'transcripts/../x', 'transcripts/./x', 'transcripts//x', '/transcripts/x', `transcripts/${'あ'.repeat(400)}`]) {
      expect([key, isValidFileKey(key), validKey(key, 'dev-a', 'GET')]).toEqual([key, false, false]);
    }
    // config の鍵は、端末の物差しが形として通しても、Worker は預からない。
    expect(validKey('config/dev-a/a.md', 'dev-a', 'GET')).toBe(false);
  });
```

- 「長すぎる鍵は 400」の試験は、`put(tokB, `config/dev-b/${rel}`, 'x', configMeta('a.md'))` を `put(tokB, `transcripts/dev-b/${rel}`, 'x')` に、`put(tokB, `config/dev-b/${'a'.repeat(513)}`, 'x', configMeta('a.md'))` を `put(tokB, `transcripts/dev-b/${'a'.repeat(513)}`, 'x')` にする。

`describe('端末の境目', …)` の中を次のとおり直す。

- 「他端末の transcripts には書けず消せず、しかし読める」の `expect((await del(tokB, 'transcripts/dev-a/u1.jsonl.gz')).status).toBe(403);` の行を消し、試験の名前を「他端末の transcripts には書けず、しかし読める」にする。
- 「config も自端末の場所にだけ書ける。2 台が同じ相対パスを上げても潰し合わない」を次に置き換える。

```ts
  it('config の鍵と種別は、自端末の場所でも断る（設定の同期は段 1 で消した）', async () => {
    const rel = 'skills/a/SKILL.md';
    const cfg = meta({ [CLOUD_HEADERS.path]: rel, [CLOUD_HEADERS.kind]: 'config', [CLOUD_HEADERS.size]: '1' });
    expect((await put(tokB, `config/dev-b/${rel}`, 'x', cfg)).status).toBe(400);
    expect((await put(tokB, 'transcripts/dev-b/u1.jsonl.gz', 'x', cfg)).status).toBe(400);
    await cloud.env.BUCKET.put(`config/dev-b/${rel}`, 'x');
    expect((await get(tokA, `config/dev-b/${rel}`)).status).toBe(400);
    expect((await list(tokA)).files).toEqual([]);
  });
```

- 「端末 ID にスラッシュを混ぜた形は…」の試験の、config の 2 行（`validKey('config/dev-a/evil/a.md', …)` と `validKey('config/dev-a/a.md', …)`）とその上のコメントを消す。
- 「認証が無ければ files のどの経路も 401」の試験はそのまま残す（`DELETE` の経路が無くても、認証の関所は `/files/*` のすべての方式の前にある）。

`packages/cloud/test/sweep.test.ts` の `put` の道具の `headers` の先頭に、長さを足す。

```ts
      'content-length': String(new TextEncoder().encode(body).length),
```

- [ ] **Step 2: Worker の試験が落ちるのを見る**

Run: `npx vitest run packages/cloud/test/files.test.ts`
Expected: FAIL（長さの無い本文が 201 で預けられ、`DELETE` が 204 を返し、config の鍵と種別が 201 で通る）。

- [ ] **Step 3: Worker を直す**

`packages/cloud/src/files.ts`：

`validKey` とその説明を次に置き換える。

```ts
/**
 * 鍵の形と権限である。
 * 預かるのは `transcripts/<端末 ID>/...` だけで、自端末の分だけ書ける。
 * `GET` は形さえ合っていれば誰でもよい。他端末の本文を降ろすのが同期の目的だからである。
 * `config/` の鍵（Claude Code の設定の同期）は、段 1 で同期ごと消したので、書くのも読むのも断る。
 */
export function validKey(key: string, deviceId: string, method: 'PUT' | 'GET'): boolean {
  const s = splitFileKey(key);
  if (!s || s.prefix !== 'transcripts') return false;
  if (method === 'GET') return true;
  // 端末 ID にスラッシュが混ざっていると、他端末の接頭辞の下に潜り込める。
  // 参加のときの検査に頼らず、ここでも形を見る。
  if (!isSafeKeyId(deviceId)) return false;
  return s.rel.startsWith(`${deviceId}/`);
}
```

`PART_BYTES`、`concat`、`storeBody` とその説明を消す。

`PUT` の中を次のとおり直す。

- `if (kind !== 'transcript' && kind !== 'config') return c.json({ error: 'invalid headers' }, 400);` と、その次の「種別と接頭辞が食い違うと…」のコメントと `if ((kind === 'config') !== key.startsWith('config/')) …` の行を、次に置き換える。

```ts
  // 預かるのは本文（transcript）だけである。設定の同期（kind が config）は段 1 で消した。
  if (kind !== 'transcript') return c.json({ error: 'invalid headers' }, 400);
```

- `if (kind === 'transcript' && enc !== '1') return c.json({ error: 'unencrypted transcript' }, 400);` を `if (enc !== '1') return c.json({ error: 'unencrypted transcript' }, 400);` にする（上の行で種別は transcript に決まっている）。
- `const declared = toInt(h('content-length'));` から `if (storedSize === null) return c.json({ error: 'too large' }, 413);` までを次に置き換える。

```ts
  // 長さを名乗らない本文は受けない。
  // 長さの分かっている本文は、読まずにそのまま R2 へ渡せるので、workerd が JS を通さずに流し、CPU の時間が本文の大きさに比例しない。
  // 長さを名乗らずに本文を流していたのは互換の版 1 より前の端末で、それは版の関所（compat.ts）で断られている。
  const declared = toInt(h('content-length'));
  if (declared === null) return c.json({ error: 'length required' }, 411);
  if (declared > MAX_BODY_BYTES) return c.json({ error: 'too large' }, 413);
  const obj = await c.env.BUCKET.put(key, body, { customMetadata });
  const storedSize = obj?.size ?? declared;
```

`DELETE` の経路（`filesApp.delete('/:key{.+}', …)` とその説明）を消す。

`packages/cloud/src/sweep.ts` の頭の説明の「`DELETE` は逆に索引から消す。」を消し、「どちらも途中で倒れると、索引に無い本体が R2 に残る。」を次に置き換える。

```ts
 * 途中で倒れると、索引に無い本体が R2 に残る。
 * 段 1 で消した設定の同期の本体（R2 の `config/`）も、後始末（cleanup.ts）が索引の行を消すので、ここで拾って消す。
```

- [ ] **Step 4: Worker の試験が通るのを見る**

Run: `npx vitest run packages/cloud`
Expected: PASS。

- [ ] **Step 5: 端末の試験を書き直す**

`packages/server/src/sync/client.test.ts`：

- 「listFiles と deleteFile」を次に置き換える。

```ts
  it('listFiles', async () => {
    const { fetch, calls } = fakeFetch(() => json({ files: [], nextSeq: 4, more: false }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    expect(await c.listFiles(4, 500)).toEqual({ files: [], nextSeq: 4, more: false });
    expect(calls[0]!.url).toBe('https://h/files?since=4&limit=500');
    expect(bearerIs(calls[0]!, 't')).toBe(true);
  });
```

- 「鍵の形が違えば fetch に出る前に 400 で断る」の `await expect(c.deleteFile('transcripts/d/u\u0000.gz'))…` の行を `await expect(c.getFile('transcripts/d/u\u0000.gz')).rejects.toMatchObject({ status: 400 });` にし、その後ろの「空白と `?` は…」の 3 行を次に置き換える。

```ts
    // 空白と `?` は Worker が通すので、端末も通して URL の側で符号化する。
    await c.getFile('transcripts/d/u 1?x.gz');
    expect(calls[0]!.url).toBe('https://h/files/transcripts/d/u%201%3Fx.gz');
    expect(new URL(calls[0]!.url).search).toBe('');
```

- 「日本語と空白を含む鍵を通し、URL では断片ごとに符号化する」の `fakeFetch` の `c.init.method === 'DELETE' ? new Response(null, { status: 204 }) : ` を消し、末尾近くの `await c.deleteFile(key);` と `expect(calls[2]!.url).toBe(expected);` の 2 行を消す。
- `describe('互換の版', …)` の `anyRoute` から `: c.init.method === 'DELETE' ? new Response(null, { status: 204 })` を消し、「Worker へのすべての要求に…」の `await c.deleteFile('transcripts/d/u.jsonl.gz');` を消して、`expect(calls).toHaveLength(9);` を `expect(calls).toHaveLength(8);` にする。

`packages/server/test/fake-cloud.test.ts`：

- 「config も自分の接頭辞の下だけに書け、置き直すと新しい seq になる」を次に置き換える。

```ts
  it('config の鍵と種別は断る（実物の Worker と同じく、設定の同期は段 1 で消した）', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const body = () => Readable.from([Buffer.from('1')]);
    await expect(a.putFile(meta('config/a/skills/x/SKILL.md', { kind: 'config', path: 'skills/x/SKILL.md', size: 1 }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta('transcripts/a/u.gz', { kind: 'config' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.getFile('config/a/skills/x/SKILL.md')).rejects.toMatchObject({ status: 400 });
    expect(a.files.size).toBe(0);
  });
```

- 「DELETE は自端末の分だけ消せる」を丸ごと消す。
- 「offline は status 0 の CloudError」と、401 の試験（`a.unauthorized = true;` を含む試験）の、`deleteFile` の行をそれぞれ消す。
- 「断りの本文は Worker と同じ JSON の形にする」の `expect(await msg(a.asDevice('b').deleteFile('transcripts/a/u1.gz'))).toBe(JSON.stringify({ error: 'forbidden' }));` を、次に置き換える。

```ts
    expect(await msg(a.asDevice('b').putFile(meta('transcripts/a/u1.gz'), body()))).toBe(JSON.stringify({ error: 'forbidden' }));
```

- 「日本語と空白を含む鍵と path が端から端まで通る」の `key` を `'transcripts/a/日本語 メモ/u1.jsonl.gz'` に、`path` を `'projects/-日本語 メモ/u1.jsonl'` に、`kind: 'config' as const` を `kind: 'transcript' as const` にし、末尾の `await a.deleteFile(key);` と `expect((await a.listFiles(0, 500)).files).toEqual([]);` の 2 行を消す。
- 「暗号化していない transcript は実物と同じ 400 で断る」の、末尾のコメント「config は今までどおり通る…」と次の `expect(await a.putFile({ ...meta('config/a/x.md', …` の行を消す。
- 「その検査は実物の Worker にもある」の `expect(src).toMatch(/kind === 'transcript' && enc !== '1'/);` を、次に置き換える。

```ts
    expect(src).toMatch(/if \(enc !== '1'\) return c\.json\(\{ error: 'unencrypted transcript' \}, 400\)/);
```

- 「でたらめに大きい since を nextSeq にそのまま返さない」の後半（「索引が空なら 0 である。」から最後の `expect` まで）を次に置き換える。

```ts
    // 索引が空なら 0 である。
    expect(await new FakeCloudClient({ deviceId: 'b' }).listFiles(999_999, 500)).toMatchObject({ files: [], nextSeq: 0, more: false });
```

- [ ] **Step 6: 端末の試験が落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/client.test.ts packages/server/test/fake-cloud.test.ts`
Expected: FAIL（偽物が config を預かり、Worker の原本の検査の形が変わっている）。

- [ ] **Step 7: 端末を直す**

`packages/server/src/sync/client.ts`：

- `CloudClient` の `deleteFile(key: string): Promise<void>;` の行を消す。
- `HttpCloudClient` の `async deleteFile(key: string): Promise<void> { … }` を消す。

`packages/server/test/fake-cloud.ts`：

`checkKey` とその説明を次に置き換える。

```ts
  /** 鍵の形と権限。実物の validKey と同じく transcripts/ だけを預かり、書けるのは自端末の分だけ。GET は誰でも。 */
  private checkKey(key: string, write: boolean): void {
    if (!isValidFileKey(key) || !key.startsWith('transcripts/')) throw new CloudError(400, errorBody('invalid key'));
    if (write && !key.startsWith(`transcripts/${this.deviceId}/`)) throw new CloudError(403, errorBody('forbidden'));
  }
```

`checkMeta` の `if (meta.kind !== 'transcript' && meta.kind !== 'config') bad();` を `if (meta.kind !== 'transcript') bad();` に、`if (meta.kind === 'transcript' && meta.encrypted !== true) …` を `if (meta.encrypted !== true) throw new CloudError(400, errorBody('unencrypted transcript'));` にする。

`deleteFile` のメソッドを消す。

- [ ] **Step 8: 通るのを見る**

Run: `npx vitest run packages/cloud packages/server`
Expected: PASS。

- [ ] **Step 9: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 10: 消した口の名残が無いことを見る**

Run: `git grep -n "deleteFile\|storeBody\|filesApp.delete" -- packages`
Expected: 何も出ない。

- [ ] **Step 11: コミットする**

```bash
git add packages/cloud/src/files.ts packages/cloud/src/sweep.ts packages/cloud/test/files.test.ts packages/cloud/test/sweep.test.ts packages/server/src/sync/client.ts packages/server/src/sync/client.test.ts packages/server/test/fake-cloud.ts packages/server/test/fake-cloud.test.ts
```

```bash
git commit -m "refactor(cloud): drop config files, length-less uploads and DELETE from the Worker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Worker の後始末

**Files:**
- Create: `packages/cloud/src/cleanup.ts`
- Modify: `packages/cloud/src/schema.ts`（`doEnsure` から呼ぶ）
- Create: `packages/cloud/test/cleanup.test.ts`

**Interfaces:**
- Consumes: Task 3 の素の書き込み、`sweep.ts` の `sweepIfDue` と `resetSweepThrottle`。
- Produces:
  - `META_STAGE1_CLEANUP = 'stage1_cleanup'`
  - `cleanupStage1(env: Env, now: number): Promise<boolean>`（消したら true、印があって何もしなければ false、落ちたら記録だけ残して false）。例外を投げない。
  - `ensureSchema` は、表を整えた直後に `cleanupStage1` を呼ぶ。

- [ ] **Step 1: 試験を書く**

`packages/cloud/test/cleanup.test.ts` を作る。

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupStage1, META_STAGE1_CLEANUP } from '../src/cleanup.ts';
import type { Env } from '../src/env.ts';
import { ensureSchema, resetSchemaCache, SCHEMA_STATEMENTS } from '../src/schema.ts';
import { resetSweepThrottle, sweepIfDue } from '../src/sweep.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const HOUR = 3_600_000;
let cloud: CloudHarness;

/** 表だけを作る。後始末を走らせずに、残っていた行を置くためである。 */
const makeTables = async (): Promise<void> => {
  await cloud.env.DB.batch(SCHEMA_STATEMENTS.map((s) => cloud.env.DB.prepare(s)));
};

/** 段 1 より前の Worker が残した姿を作る。設定の同期の索引と本文の索引、台帳と圧縮の印である。 */
const seedLeftovers = async (): Promise<void> => {
  const file = (key: string, kind: string) =>
    cloud.env.DB.prepare('insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, 'x', kind, 'dev-a', 'a'.repeat(64), 1, 1, 1, 1, 1);
  const meta = (key: string, value: string) => cloud.env.DB.prepare('insert into meta (key, value) values (?, ?)').bind(key, value);
  await cloud.env.DB.batch([
    file('config/dev-a/skills/x/SKILL.md', 'config'),
    file('config/dev-a/CLAUDE.md', 'config'),
    file('transcripts/dev-a/u1.jsonl.gz', 'transcript'),
    meta('d1_rows:2026-10-01', '120'),
    meta('d1_rows:2026-10-02', '80'),
    meta('changes_floor', '3'),
  ]);
};

const fileKeys = async (): Promise<string[]> => (await cloud.env.DB.prepare('select key from files order by key').all<{ key: string }>()).results.map((r) => r.key);
const metaKeys = async (): Promise<string[]> => (await cloud.env.DB.prepare('select key from meta order by key').all<{ key: string }>()).results.map((r) => r.key);

beforeEach(async () => {
  resetSchemaCache();
  resetSweepThrottle();
  cloud = await startCloud();
});

afterEach(async () => {
  await cloud.dispose();
  resetSchemaCache();
});

describe('段 1 の後始末', () => {
  it('設定の同期の索引と台帳の行を消し、ほかは残して、済んだ印を置く', async () => {
    await makeTables();
    await seedLeftovers();
    await ensureSchema(cloud.env);
    expect(await fileKeys()).toEqual(['transcripts/dev-a/u1.jsonl.gz']);
    expect(await metaKeys()).toEqual(['changes_floor', META_STAGE1_CLEANUP]);
  });

  it('印があれば、2 度目の cold start では消しにいかない', async () => {
    await makeTables();
    await ensureSchema(cloud.env);
    // 印を置いた後に入った行は、後始末の相手ではない（試験のための目印である）。
    await cloud.env.DB.prepare('insert into meta (key, value) values (?, ?)').bind('d1_rows:2026-10-03', '1').run();
    resetSchemaCache();
    await ensureSchema(cloud.env);
    expect(await metaKeys()).toContain('d1_rows:2026-10-03');
  });

  it('消すものが 1 行も無い箱でも印を置く', async () => {
    await ensureSchema(cloud.env);
    expect(await metaKeys()).toEqual([META_STAGE1_CLEANUP]);
    expect(await cleanupStage1(cloud.env, Date.now())).toBe(false);
  });

  it('配備の後の最初の要求（/health でも）で走り、その要求は普段どおり答える', async () => {
    await makeTables();
    await seedLeftovers();
    const r = await cloud.SELF.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await fileKeys()).toEqual(['transcripts/dev-a/u1.jsonl.gz']);
    expect(await metaKeys()).toContain(META_STAGE1_CLEANUP);
  });

  it('落ちても例外を投げず、何も消さずに印も置かない。次の回でまた試す', async () => {
    await makeTables();
    await seedLeftovers();
    const failing: Env = {
      ...cloud.env,
      DB: {
        prepare: (q: string) => cloud.env.DB.prepare(q),
        batch: async () => { throw new Error('D1_ERROR: boom'); },
      } as unknown as D1Database,
    };
    expect(await cleanupStage1(failing, Date.now())).toBe(false);
    expect(await fileKeys()).toHaveLength(3);
    expect(await metaKeys()).not.toContain(META_STAGE1_CLEANUP);
    expect(await cleanupStage1(cloud.env, Date.now())).toBe(true);
    expect(await fileKeys()).toEqual(['transcripts/dev-a/u1.jsonl.gz']);
  });

  it('索引から外れた R2 の config/ の本体は、孤児の掃除が拾って消す', async () => {
    await makeTables();
    await seedLeftovers();
    await cloud.env.BUCKET.put('config/dev-a/skills/x/SKILL.md', 'x');
    await cloud.env.BUCKET.put('transcripts/dev-a/u1.jsonl.gz', 'y');
    await ensureSchema(cloud.env);
    const r = await sweepIfDue(cloud.env, Date.now() + 2 * HOUR);
    expect(r?.bodies).toEqual(['config/dev-a/skills/x/SKILL.md']);
    expect((await cloud.env.BUCKET.list()).objects.map((o) => o.key)).toEqual(['transcripts/dev-a/u1.jsonl.gz']);
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/cloud/test/cleanup.test.ts`
Expected: FAIL（`../src/cleanup.ts` が無い）。

- [ ] **Step 3: 後始末を書く**

`packages/cloud/src/cleanup.ts` を作る。

```ts
import type { Env } from './env.ts';

/**
 * 段 1 で消したものが D1 に残した行を、1 回だけ消す。
 *
 * 消すのは 2 つである。
 * files の kind が config の行は、Claude Code の設定の同期の索引である。
 * R2 の config/ の本体には触らない。索引から外れた本体は、孤児の掃除（sweep.ts）が 1 時間の猶予の後に拾って消す。
 * meta の鍵が d1_rows: で始まる行は、Worker が D1 への書き込みを数えていた日ごとの台帳である。
 *
 * Workers には配備の後に 1 度だけ走る処理が無い。
 * そこで、isolate ごとに 1 度走るスキーマの用意（schema.ts の ensureSchema）から呼び、
 * 済んだ印を meta に置いて、2 度目からは印を読むだけで帰る。
 * 消す 2 文と印を置く 1 文は 1 つの batch に入れる。D1 の batch は 1 つの取引なので、途中で倒れても半端に残らない。
 * 2 つの isolate が同時に走っても、どの文も何度流しても同じ結果になる。
 *
 * 落ちても要求は落とさない。
 * 後始末は同期に要らないので、失敗は記録だけ残し、次の cold start でまた試す。
 */
export const META_STAGE1_CLEANUP = 'stage1_cleanup';

/** 消したら true、印があって何もしなかったか、落ちたら false を返す。例外は投げない。 */
export async function cleanupStage1(env: Env, now: number): Promise<boolean> {
  const db = env.DB;
  try {
    const done = await db.prepare('select 1 as x from meta where key = ?').bind(META_STAGE1_CLEANUP).first<{ x: number }>();
    if (done) return false;
    await db.batch([
      db.prepare("delete from files where kind = 'config'"),
      db.prepare("delete from meta where substr(key, 1, 8) = 'd1_rows:'"),
      db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do nothing').bind(META_STAGE1_CLEANUP, String(now)),
    ]);
    return true;
  } catch (e) {
    console.error('cleanup failed', e instanceof Error ? e.name : typeof e);
    return false;
  }
}
```

`packages/cloud/src/schema.ts` の import に足す。

```ts
import { cleanupStage1 } from './cleanup.ts';
```

`doEnsure` の、表を整える `await env.DB.batch(SCHEMA_STATEMENTS.map(…));` の次の行に足す。

```ts
  // 段 1 で消したものが残した行を 1 回だけ片付ける。落ちても例外を投げず、次の cold start でまた試す（cleanup.ts）。
  await cleanupStage1(env, now);
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/cloud`
Expected: PASS（後始末の印が `meta` に入っても、既存の Worker の試験は崩れない）。

- [ ] **Step 5: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: コミットする**

```bash
git add packages/cloud/src/cleanup.ts packages/cloud/src/schema.ts packages/cloud/test/cleanup.test.ts
```

```bash
git commit -m "feat(cloud): clean up config index rows and the write ledger once after deploy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: D1 の上限の失敗を 429 で返す

**Files:**
- Create: `packages/cloud/src/limits.ts`
- Modify: `packages/cloud/src/app.ts`（import と `onError`）
- Create: `packages/cloud/test/limits.test.ts`

**Interfaces:**
- Consumes: Task 2 の `createApp`（`app.ts`）、`schema.ts` の `resetSchemaCache`。
- Produces（`packages/cloud/src/limits.ts`）:
  - `type D1LimitKind = 'd1-read' | 'd1-write'`
  - `type LimitBody = { error: 'limit'; limit: D1LimitKind; resetAt: number }`
  - `d1LimitOf(e: unknown): D1LimitKind | null`
  - `nextUtcMidnight(now: number): number`
  - `limitBody(kind: D1LimitKind, now: number): LimitBody`
  - Worker は、D1 の上限の失敗を 429 と `LimitBody` で返し、ほかの失敗はいままでどおり 500 と `{ error: 'internal error' }` で返す。

- [ ] **Step 1: PR 5 が置いた型を確かめる**

Run: `git grep -n "error: 'limit'\|LimitBody\|resetAt" -- packages/shared packages/server/src`
Expected: PR 5 が 429 の本文の型を shared に置いていなければ、使用量の `resetAt`（`CloudUsageDto` の `today.resetAt`）だけが出る。
429 の本文の型が shared にあれば、下の `LimitBody` はそれを import して使い、名前と形をそちらに合わせる（試験の期待もその形にする）。

- [ ] **Step 2: 試験を書く**

`packages/cloud/test/limits.test.ts` を作る。

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { createApp } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { d1LimitOf, limitBody, nextUtcMidnight } from '../src/limits.ts';
import { resetSchemaCache } from '../src/schema.ts';

afterEach(() => { resetSchemaCache(); });

describe('D1 の上限の見分け', () => {
  it('読んだ行と書いた行の上限を、文から見分ける', () => {
    expect(d1LimitOf(new Error('D1_ERROR: Exceeded free tier daily row read limit'))).toBe('d1-read');
    expect(d1LimitOf(new Error('D1_ERROR: Exceeded free tier daily row write limit'))).toBe('d1-write');
  });

  it('大文字と小文字は問わず、原因（cause）の側の文も見る', () => {
    expect(d1LimitOf(new Error('FREE TIER DAILY ROW WRITE LIMIT'))).toBe('d1-write');
    expect(d1LimitOf(new Error('D1_ERROR', { cause: new Error('free tier daily row read limit exceeded') }))).toBe('d1-read');
  });

  it('ほかの失敗と、Error でない値は上限とみなさない', () => {
    for (const e of [new Error('D1_ERROR: no such table: files'), new Error('free tier'), 'free tier daily row write limit', null, undefined, 42]) {
      expect(d1LimitOf(e), String(e)).toBeNull();
    }
  });

  it('原因が輪になっていても止まる', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(d1LimitOf(a)).toBeNull();
  });

  it('戻る時刻は次の UTC の 0 時である', () => {
    expect(nextUtcMidnight(Date.parse('2026-10-08T06:48:00Z'))).toBe(Date.parse('2026-10-09T00:00:00Z'));
    expect(nextUtcMidnight(Date.parse('2026-10-08T00:00:00Z'))).toBe(Date.parse('2026-10-09T00:00:00Z'));
    expect(nextUtcMidnight(Date.parse('2026-10-08T23:59:59.999Z'))).toBe(Date.parse('2026-10-09T00:00:00Z'));
    expect(nextUtcMidnight(Date.parse('2028-02-28T12:00:00Z'))).toBe(Date.parse('2028-02-29T00:00:00Z'));
    expect(nextUtcMidnight(Date.parse('2026-12-31T12:00:00Z'))).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });

  it('本文は上限の種類と戻る時刻を運ぶ', () => {
    const now = Date.parse('2026-10-08T06:48:00Z');
    expect(limitBody('d1-write', now)).toEqual({ error: 'limit', limit: 'd1-write', resetAt: Date.parse('2026-10-09T00:00:00Z') });
  });
});

describe('Worker の応答', () => {
  /** どの文も throw で返す D1 の立て替え。スキーマの用意（最初の batch）で倒れる。 */
  const failingEnv = (message: string): Env => ({
    DB: {
      prepare: () => { throw new Error(message); },
      batch: async () => { throw new Error(message); },
    } as unknown as D1Database,
    BUCKET: {} as R2Bucket,
  });
  const request = (env: Env) => createApp({ minDeviceCompat: 0 }).request('/changes?since=0', { headers: { [COMPAT_HEADER]: String(COMPAT_VERSION) } }, env);

  it('D1 の上限の失敗は 429 と、上限の種類と戻る時刻で返し、版の見出しも載せる', async () => {
    const before = nextUtcMidnight(Date.now());
    const r = await request(failingEnv('D1_ERROR: Exceeded free tier daily row write limit'));
    const after = nextUtcMidnight(Date.now());
    expect(r.status).toBe(429);
    expect(r.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    const body = (await r.json()) as { error: string; limit: string; resetAt: number };
    expect(body).toMatchObject({ error: 'limit', limit: 'd1-write' });
    expect([before, after]).toContain(body.resetAt);
  });

  it('読んだ行の上限も 429 にする', async () => {
    const r = await request(failingEnv('D1_ERROR: free tier daily row read limit'));
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ limit: 'd1-read' });
  });

  it('ほかの D1 の失敗は、いままでどおり 500 と一般化した 1 語で返す', async () => {
    const r = await request(failingEnv('D1_ERROR: no such table: files'));
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain('files');
  });
});
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/cloud/test/limits.test.ts`
Expected: FAIL（`../src/limits.ts` が無い）。

- [ ] **Step 4: 上限の見分けを書く**

`packages/cloud/src/limits.ts` を作る。

```ts
/**
 * D1 の 1 日の上限に当たった失敗を見分ける（全体計画の D4）。
 *
 * Worker も端末も量を数えない。上限に当たったことは、D1 が返す失敗の文で知る。
 * 上限は日が変われば戻るので、直りようのない 500 ではなく、待てば通る 429 で返し、戻る時刻を添える。
 * 端末（packages/server の同期）は 429 を受けたら次の UTC の 0 時まで退く。
 *
 * Workers の 1 日の要求の上限（error 1027）は Worker を通らずに Cloudflare が返すので、ここでは扱わない。
 */

/** 上限の種類。d1-read は 1 日に読んだ行、d1-write は 1 日に書いた行である。 */
export type D1LimitKind = 'd1-read' | 'd1-write';

/** 上限に当たったときに 429 で返す本文。resetAt は上限が戻る時刻（次の UTC の 0 時、epoch のミリ秒）である。 */
export type LimitBody = { error: 'limit'; limit: D1LimitKind; resetAt: number };

const NEEDLES: readonly [needle: string, kind: D1LimitKind][] = [
  ['free tier daily row read limit', 'd1-read'],
  ['free tier daily row write limit', 'd1-write'],
];

/** cause をたどる段の上限。輪になった cause で止まらないためである。 */
const MAX_CAUSE_DEPTH = 4;

/** 例外の文と、その原因（cause）の文を小文字にしてつなぐ。D1 は原因の側に本当の文を入れることがある。 */
function textsOf(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < MAX_CAUSE_DEPTH && cur instanceof Error; i++) {
    parts.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return parts.join('\n').toLowerCase();
}

/** D1 の上限の失敗なら、その種類を返す。ほかの失敗と Error でない値は null。 */
export function d1LimitOf(e: unknown): D1LimitKind | null {
  const t = textsOf(e);
  for (const [needle, kind] of NEEDLES) if (t.includes(needle)) return kind;
  return null;
}

/** 次の UTC の 0 時。上限が戻る時刻である。ちょうど 0 時なら翌日の 0 時を返す。 */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function limitBody(kind: D1LimitKind, now: number): LimitBody {
  return { error: 'limit', limit: kind, resetAt: nextUtcMidnight(now) };
}
```

`packages/cloud/src/app.ts` の import に足す。

```ts
import { d1LimitOf, limitBody } from './limits.ts';
```

`app.onError` を次に置き換える（説明のコメントの最後に 1 行足し、上限の枝を先に置く）。

```ts
  /**
   * 想定していない例外である。
   * 外へ返すのは一般化した 1 語だけにする。
   * D1 と R2 の文言には表と列と束縛の様子が出るので、そのまま返すと内側の作りを教えてしまう。
   * 詳しい内容は記録にだけ残す。記録に載るのは方式と経路と例外の名前と 1 行目で、
   * 参加用の秘密も端末トークンも本文も問い合わせ文字列も載せない。
   * D1 の 1 日の上限に当たった失敗だけは、待てば通るので 429 で返す（limits.ts）。
   */
  app.onError((e, c) => {
    const limit = d1LimitOf(e);
    if (limit) {
      console.error('worker limit', c.req.method, new URL(c.req.url).pathname, limit);
      return c.json(limitBody(limit, Date.now()), 429);
    }
    const name = e instanceof Error ? e.name : typeof e;
    const line = (e instanceof Error ? e.message : '').split('\n')[0]!.trim().slice(0, MAX_LOG_LEN);
    console.error('worker error', c.req.method, new URL(c.req.url).pathname, name, line);
    return c.json({ error: 'internal error' }, 500);
  });
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/cloud`
Expected: PASS。

- [ ] **Step 6: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 7: コミットする**

```bash
git add packages/cloud/src/limits.ts packages/cloud/src/app.ts packages/cloud/test/limits.test.ts
```

```bash
git commit -m "feat(cloud): answer D1 daily limit failures with 429 and the reset time" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 端末に求める下限を 1 に上げる

**Files:**
- Modify: `packages/cloud/src/compat.ts`（`MIN_DEVICE_COMPAT` とその説明）
- Modify: `packages/cloud/test/compat.test.ts`（`describe('互換の版（本番の下限）', …)`）
- Modify: `packages/cloud/test/client-e2e.test.ts`（`beforeEach` の参加）
- Modify: `packages/server/test/fake-cloud.ts`（`MIN_DEVICE_COMPAT` の写し）

**Interfaces:**
- Consumes: PR 3 の `compatMiddleware` と `CloudHarness.RAW`。
- Produces: `MIN_DEVICE_COMPAT = 1`（Worker と偽物の写しの両方）。見出しの無い要求は、`/health` のほかはすべて 426。

- [ ] **Step 1: 試験を書く**

`packages/cloud/test/compat.test.ts` の `describe('互換の版（本番の下限）', …)` を、次に置き換える。

```ts
describe('互換の版（本番の下限）', () => {
  it('本番の下限は 1 である（段 1 の PR 6 で上げた）', () => {
    expect(MIN_DEVICE_COMPAT).toBe(1);
  });

  it('/health は Worker の版を返し、版を名乗らない相手にも答える', async () => {
    const c = await boot();
    const r = await c.RAW.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: VERSION, compat: COMPAT_VERSION });
  });

  it('どの応答にも、見出しで Worker の版を載せる（断ったもの、無い経路を含む）', async () => {
    const c = await boot();
    const responses = [
      await c.RAW.fetch('https://x/health'),
      await c.SELF.fetch('https://x/changes?since=0'),
      await c.SELF.fetch('https://x/nope'),
      await c.SELF.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      await c.RAW.fetch('https://x/changes?since=0'),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 404, 400, 426]);
    for (const r of responses) expect(r.headers.get(COMPAT_HEADER), String(r.status)).toBe(String(COMPAT_VERSION));
  });

  it('R2 の本文をそのまま返す応答にも版を載せ、本文と長さは崩さない', async () => {
    const c = await boot();
    const { deviceToken } = (await (await c.SELF.fetch('https://x/join', joinInit())).json()) as { deviceToken: string };
    await c.env.BUCKET.put('transcripts/dev-a/u1.jsonl.gz', 'abc');
    const g = await c.SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(g.status).toBe(200);
    expect(g.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    expect(g.headers.get('content-length')).toBe('3');
    expect(await g.text()).toBe('abc');
  });

  it('見出しの無い要求（版 0 の古い端末）は、参加も含めて 426 と下限で断る', async () => {
    const c = await boot();
    const j = await c.RAW.fetch('https://x/join', joinInit());
    expect(j.status).toBe(426);
    expect(await j.json()).toEqual({ error: 'upgrade required', minCompat: 1, compat: COMPAT_VERSION });
    expect((await c.RAW.fetch('https://x/changes?since=0')).status).toBe(426);
  });
});
```

`packages/cloud/test/client-e2e.test.ts` の `beforeEach` の参加を、版を名乗る形に替える。

```ts
  // 参加も版を載せる。本番の下限は 1 なので、載せない参加は 426 で断られる。
  const r = await fetch(`${workerUrl}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [COMPAT_HEADER]: String(COMPAT_VERSION) },
    body: JSON.stringify({ secret: SECRET, device: { id: 'dev-a', name: 'dev-a', platform: 'darwin' } }),
  });
```

（いまの「参加は版の見出しを載せない（版 0 の古い端末と同じ）。本番の下限 0 の Worker では通る。」のコメントと `fetch` の呼び出しを、これに置き換える。）

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/cloud/test/compat.test.ts`
Expected: FAIL（下限が 0 なので、見出しの無い要求が通る）。

- [ ] **Step 3: 下限を上げる**

`packages/cloud/src/compat.ts` の `MIN_DEVICE_COMPAT` とその説明を、次に置き換える。

```ts
/**
 * 端末に求める互換の版の下限。
 * 段 1 の PR 6 で 1 に上げた。版の見出しを持たない古い端末（版 0 として読む）は 426 で断る。
 * 上げるのは、同期に参加しているすべての端末が、その版を名乗る版に上がってからである（docs/design.md「互換の版番号」）。
 * packages/server/test/fake-cloud.test.ts がこの行を文字列で読んで、偽物の写しと突き合わせる。
 */
export const MIN_DEVICE_COMPAT = 1;
```

`packages/server/test/fake-cloud.ts` の写しを `export const MIN_DEVICE_COMPAT = 1;` にする。

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/cloud packages/server/test`
Expected: PASS（`fake-cloud.test.ts` の「端末に求める下限は実物の Worker の写し」も、両方が 1 なので通る）。

- [ ] **Step 5: コミットする**

```bash
git add packages/cloud/src/compat.ts packages/cloud/test/compat.test.ts packages/cloud/test/client-e2e.test.ts packages/server/test/fake-cloud.ts
```

```bash
git commit -m "feat(cloud): raise the device compat floor to 1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Worker の版を 2xx の応答でだけ読む

**Files:**
- Modify: `packages/server/src/sync/client.ts`（`send()` とその説明）
- Modify: `packages/server/src/sync/client.test.ts`（`describe('互換の版', …)` の 2 つの試験）

**Interfaces:**
- Consumes: PR 3 の `CompatError` と `minWorkerCompat`。
- Produces: `HttpCloudClient` は、応答が 2xx のときだけ Worker の版を下限と比べる。2xx でない応答は、版の見出しが無くても、その状態の `CloudError` にする。

- [ ] **Step 1: 試験を書く**

`packages/server/src/sync/client.test.ts` の `describe('互換の版', …)` の中を次のとおり直す。

`it('古い Worker の 404 は、使用量の「トークンなし」に読み替える前に版の不一致として伝える', …)` を消す（見出しの無い 404 は Worker の版を語らないので、次の試験で普通の失敗として押さえる。使用量の 404 は Task 9 で押さえる）。

`it.each([503, 429, 408])('Worker を通らずに端が返した %i（版の見出しなし）は、…')` を、次に置き換える。

```ts
  // Cloudflare の端は、Worker を通さずに 4xx と 5xx を返すことがある（WAF の 403、本文が大きすぎるときの 413、CPU の超過、日の上限など）。
  // どれも版の見出しを持たないが、Worker の版を語らないので、下限を上げていても版の不一致にはしない。
  it.each([503, 429, 408, 403, 404, 400, 413])('Worker を通らずに端が返した %i（版の見出しなし）は、版の不一致にせず、その status の CloudError にする', async (status) => {
    const { fetch } = fakeFetch(() => new Response('<html>edge</html>', { status, headers: { 'content-type': 'text/html' } }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 1 });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).not.toBeInstanceOf(CompatError);
    expect(e).toMatchObject({ status });
  });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/client.test.ts`
Expected: FAIL（403、404、400、413 が `CompatError` になる）。

- [ ] **Step 3: 実装する**

`packages/server/src/sync/client.ts` の `send()` の説明のうち、「Worker の版は、Worker が自分で作った応答にだけ問う。」と次の 1 行（「端が Worker を通さずに返す 5xx、408、429…」）を、次に置き換える。

```ts
   * Worker の版は 2xx の応答でだけ問う。
   * Cloudflare の端は Worker を通さずに 4xx と 5xx を返すことがある（WAF の 403、本文が大きすぎるときの 413、CPU の超過の 1102、日の上限など）。
   * それらは版の見出しを持たないが、Worker の版を語らないので、版の不一致にせず、これまでどおり CloudError に落とす。
   * 2xx は Worker を通らないと返らないので、古い Worker はどの経路でも最初の 2xx で見分けられる。
```

`send()` の中の次の 2 行を、

```ts
    const fromWorker = res.status < 500 && res.status !== 408 && res.status !== 429;
    if (fromWorker && workerCompat < this.minWorkerCompat) {
```

次の 1 行に置き換える。

```ts
    if (res.ok && workerCompat < this.minWorkerCompat) {
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/server/src/sync packages/cloud/test/client-e2e.test.ts`
Expected: PASS。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/sync/client.ts packages/server/src/sync/client.test.ts
```

```bash
git commit -m "fix(sync): read the Worker compat version only from 2xx responses" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: この PC が Worker に求める下限を 1 に上げ、`/usage` の 404 の読み替えを消す

**Files:**
- Modify: `packages/server/src/sync/client.ts`（`MIN_WORKER_COMPAT`、`CloudClient.usage` の説明、`HttpCloudClient.usage`）
- Modify: `packages/server/src/sync/client.test.ts`（`fakeFetch`、`describe('usage', …)`、`describe('互換の版', …)`）
- Modify: `packages/server/src/sync/engine.test.ts`（`describe('互換の版', …)` の 1 つ）
- Modify: `packages/server/test/fake-cloud.test.ts`（`describe('互換の版', …)` の 1 つ）
- Modify: `packages/server/src/server.test.ts`（`fileSink` と `describe('互換の版', …)` の最後の試験）
- Modify: `packages/cli/src/cloud.test.ts`（`cloudFetch`）

**Interfaces:**
- Consumes: Task 8 の 2xx だけで読む `send()`。
- Produces:
  - `MIN_WORKER_COMPAT = 1`。版の見出しを返さない Worker（版 0）の 2xx は `CompatError('worker', 0, 1)`。
  - `HttpCloudClient.usage()` は `/usage` の失敗をそのまま投げる（404 を `configured: false` に読み替えない）。
  - 試験の道具 `fakeFetch(handler, o?: { stamp?: boolean })`（`client.test.ts` の中だけ）。既定で、版の見出しの無い応答にいまの版を足す。

- [ ] **Step 1: 試験の道具を、いまの Worker の真似にする**

`packages/server/src/sync/client.test.ts` の `fakeFetch` を次に置き換える。

```ts
/**
 * Worker の立て替え。
 * いまの Worker の真似として、版の見出しの無い応答にはこの PC と同じ版を足す（この PC が Worker に求める下限は 1 である）。
 * 版を試す試験は stamp: false を渡し、見出しを足さない（版 0 の古い Worker や、Cloudflare の端の真似）。
 */
function fakeFetch(handler: (c: Call) => Response | Promise<Response>, o: { stamp?: boolean } = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    // undici と同じ検査をここで通す。
    // 見出しの値は ByteString しか運べず、非 ASCII は送る前に TypeError になる。
    // URL も同じで、組み立てた文字列がそのまま要求になるわけではない。
    new Headers(c.init.headers as Record<string, string> | undefined);
    new URL(c.url);
    calls.push(c);
    const res = await handler(c);
    if (o.stamp !== false && !res.headers.has(COMPAT_HEADER)) res.headers.set(COMPAT_HEADER, String(COMPAT_VERSION));
    return res;
  }) as typeof fetch;
  return { fetch: f, calls };
}
```

- [ ] **Step 2: 試験を書く**

`packages/server/src/sync/client.test.ts`：

`describe('usage', …)` の `it('古い Worker の 404 は configured: false として扱う', …)` を、次に置き換える。

```ts
  it('404 は読み替えずに CloudError のまま投げる（/usage の無い古い Worker は、版の下限で先に断る）', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'not found' }, 404));
    const c = new HttpCloudClient({ url: 'https://w.example', token: 't', fetch });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CloudError', status: 404 });
  });
```

`describe('互換の版', …)` の `it('版の見出しを返さない Worker は版 0 として読み、下限が 0 なら今までどおり話す', …)` を、次に置き換える。

```ts
  it('この PC が Worker に求める下限は 1 で、版の見出しを返さない Worker（版 0）の 2xx は Worker を上げるよう断る', async () => {
    expect(MIN_WORKER_COMPAT).toBe(1);
    const { fetch } = fakeFetch(() => json({ changes: [], nextSeq: 4, more: false }), { stamp: false });
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: 0, need: 1 });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker' });
  });
```

`describe('互換の版', …)` の「Worker の版がこの PC の下限より古ければ、通った応答でも…」と「Worker を通らずに端が返した %i」の 2 つの試験の `fakeFetch(…)` に、第 2 引数 `{ stamp: false }` を足す。

`packages/server/src/sync/engine.test.ts` の `it('版の見出しを返さない古い Worker（版 0）でも、この PC の下限が 0 なら同期は動く', …)` を、次に置き換える。

```ts
  it('版の見出しを返さない古い Worker（版 0）は、この PC の下限 1 で断り、Worker を上げるよう error に出す', async () => {
    expect(MIN_WORKER_COMPAT).toBe(1);
    cloud.workerCompat = 0;
    const e = make();
    await e.start();
    project('p1');
    await timers.advance(1_000);
    await e.idle();
    expect(cloud.changes).toEqual([]);
    expect(e.compatBlocked()).toBe(true);
    expect(e.status().state).toBe('error');
    expect(e.status().error).toContain('Worker');
    e.stop();
  });
```

`packages/server/test/fake-cloud.test.ts` の `it('版の見出しを返さない古い Worker（版 0）とも、下限が 0 の端末は話す', …)` を、次に置き換える。

```ts
  it('既定の下限は 1 で、版の見出しを返さない古い Worker（版 0）は Worker を上げるよう断る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    expect(a.minWorkerCompat).toBe(1);
    a.workerCompat = 0;
    await expect(a.pushChanges([ch('p1', 1)])).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: 0, need: 1 });
    expect(a.changes).toHaveLength(0);
  });
```

`packages/server/src/server.test.ts`：

`fileSink` の `send` の `res.writeHead(200, { 'content-type': 'application/json' });` を、次に置き換える（いまの Worker の真似として版を載せる）。

```ts
      const send = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json', [COMPAT_HEADER]: String(COMPAT_VERSION) }); res.end(JSON.stringify(body)); };
```

`describe('互換の版', …)` の最後の試験「Worker が版の見出しを返さない間（版 0）も同期は動き、…」を、次の 2 つに置き換える。

```ts
  /** いまの Worker の真似。どの経路にも、形の合う応答を返す。 */
  const answerAll = (compat: string | undefined) => (method: string, p: string): Answer => {
    const ok = (status: number, body: unknown): Answer => ({ status, body, compat });
    if (p === '/rows') return ok(200, { changes: [], nextAfter: null, seq: 0 });
    if (p === '/changes' && method === 'GET') return ok(200, { changes: [], nextSeq: 0, more: false });
    if (p === '/changes') return ok(200, { seq: 0, accepted: 0, skipped: 0 });
    if (p === '/files') return ok(200, { files: [], nextSeq: 0, more: false });
    if (p.startsWith('/files/') && method === 'PUT') return ok(201, { seq: 1 });
    if (p === '/usage') return ok(200, { configured: false });
    return ok(404, { error: 'not found' });
  };

  it('Worker が版を名乗れば同期は動き、要求にはこの PC の版を載せる', async () => {
    const w = await fakeWorker(answerAll(String(COMPAT_VERSION)));
    joinTo(w.url);
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const st = await until(async () => { const v = await syncStatus(s.port); return v.lastPullAt !== null ? v : null; });
      expect(st.error).toBeNull();
      expect(st.state).not.toBe('error');
      expect(w.seen.length).toBeGreaterThan(0);
      for (const r of w.seen) expect(r.compat, `${r.method} ${r.path}`).toBe(String(COMPAT_VERSION));
    } finally {
      await s.close();
      await w.close();
    }
  });

  it('Worker が版の見出しを返さなければ（版 0）、同期を止めて Worker を上げるよう出す', async () => {
    const w = await fakeWorker(answerAll(undefined));
    joinTo(w.url);
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const st = await until(async () => { const v = await syncStatus(s.port); return v.state === 'error' ? v : null; });
      expect(st.error).toContain('Worker');
      expect(st.error).toContain('今すぐ同期');
    } finally {
      await s.close();
      await w.close();
    }
  });
```

`packages/cli/src/cloud.test.ts` の `cloudFetch` の 2 つの 200 の応答に、いまの Worker の真似として版の見出しを足す。

```ts
    if (u.pathname === '/files') {
      const last = files.length ? files[files.length - 1]!.entry.seq : 0;
      return new Response(JSON.stringify({ files: files.map((x) => x.entry), nextSeq: last, more: false }), { status: 200, headers: { [COMPAT_HEADER]: String(COMPAT_VERSION) } });
    }
```

```ts
    return new Response(new Uint8Array(hit.body), { status: 200, headers: { [COMPAT_HEADER]: String(COMPAT_VERSION) } });
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/client.test.ts packages/server/src/sync/engine.test.ts packages/server/test/fake-cloud.test.ts`
Expected: FAIL（下限が 0 なので版 0 の Worker と話し、`usage()` が 404 を `configured: false` に読み替える）。

- [ ] **Step 4: 実装する**

`packages/server/src/sync/client.ts` の `MIN_WORKER_COMPAT` とその説明を、次に置き換える。

```ts
/**
 * この PC が Worker に求める互換の版の下限。
 * 段 1 の PR 6 で 1 に上げた。版の見出しを返さない古い Worker（版 0 として読む）は、最初の 2xx で断る。
 * そのため、古い Worker のための分岐（/usage の 404 を「トークンなし」に読み替える）は持たない。
 * Worker の API を古い Worker と話せない形で変えたら、その版に上げる。上げる前に Worker を配備し直す。
 */
export const MIN_WORKER_COMPAT = 1;
```

`CloudClient` の `usage` の説明を `/** 使用量と費用。 */` にする。

`HttpCloudClient` の `async usage(): Promise<CloudUsageBody> { … }` を、次に置き換える。

```ts
  usage() { return this.json<CloudUsageBody>('/usage'); }
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/server packages/cli packages/cloud/test/client-e2e.test.ts`
Expected: PASS。
落ちる試験が残ったら、それは Worker の立て替えが版を名乗らない 2xx を返している所である。
いまの Worker の真似なら版の見出しを足し、版 0 の Worker を試す試験なら期待を「Worker を上げるよう断る」に直す。

- [ ] **Step 6: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 7: コミットする**

```bash
git add packages/server/src/sync/client.ts packages/server/src/sync/client.test.ts packages/server/src/sync/engine.test.ts packages/server/test/fake-cloud.test.ts packages/server/src/server.test.ts packages/cli/src/cloud.test.ts
```

```bash
git commit -m "feat(sync): raise the Worker compat floor to 1 and drop the old Worker /usage fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 一時停止の印を同期の状態に載せる（Task 1 で選んだ案）

Task 1 で利用者が選ぶまで、このタスクに入らない。

**Files:**
- Modify: `packages/shared/src/api.ts`（`SyncStatusDto` とその説明）
- Modify: `packages/server/src/sync/engine.ts`（`status()`）
- Modify: `packages/server/src/server.ts`（`syncNow` の一時停止の判定）
- Modify: `packages/ui/src/presenters/shell.ts`（`syncProps`）
- Modify: `packages/ui/src/presenters/settings.ts`（`presentSettings` の `cloud`）
- Modify（案 C のとき）: `packages/ui/src/views/SyncStatus.tsx`、`packages/ui/src/views/SettingsScreen.tsx`
- Modify: `SyncStatusDto` と `SyncStatusBody` の形の値を書いている試験（Step 5 の型の検査で挙がるもの）
- Modify: `packages/server/src/sync/engine.test.ts`、`packages/server/src/server.test.ts`、`packages/ui/src/presenters/presenters.test.ts`

**Interfaces:**
- Consumes: PR 3 の `compatBlock`（engine）と `PausedPass`（server）。Task 1 で選んだ案の記号。
- Produces:
  - `SyncStatusDto.paused: boolean`（`sync_state` の `paused` の印。版で止まって `state` が `error` のときも、一時停止していれば true）。
  - ヘッダーと設定の `paused` は、`state` が `paused` か、`paused` の印が立っているときに true。

- [ ] **Step 1: 試験を書く**

`packages/server/src/sync/engine.test.ts` の `it('一時停止していても、版で止まったことを error で見せる', …)` の `expect(e.status().error).toContain('この PC の hangar');` の次に足す。

```ts
    // 状態は error でも、一時停止していることは印で伝える。画面はこれで切り替えを「同期を再開」にする。
    expect(e.status().paused).toBe(true);
```

同じファイルの `it('Worker に断られたら（426）同期を止め、…')` の `expect(e.status().error).toContain('この PC の hangar');` の次に足す。

```ts
    expect(e.status().paused).toBe(false);
```

`packages/server/src/server.test.ts` の `it('一時停止中に今すぐ同期で断られたら理由を出し、もう一度押せばまた試し直す', …)` の `expect(first.error).toContain('この PC の hangar');` の次に足す。

```ts
      expect(first.paused).toBe(true);
```

`packages/ui/src/presenters/presenters.test.ts` の `syncStatus` の道具の既定に `paused: false` を足す（`state: 'idle'` の次）。
`describe('ヘッダーの無料枠で停止', …)` の中の `paused` の道具が残っていれば、`syncStatus({ state: 'paused', paused: true, ...o })` にする。
`describe('同期の Presenter（フェーズ 4）', …)` の最後に足す（案 A のとき）。

```ts
  it('一時停止中に版で止まったら、状態は error のまま、切り替えは「同期を再開」の側にする', () => {
    const sync = syncStatus({ state: 'error', error: 'この PC の hangar が古いので、クラウドが同期を断りました', paused: true });
    const shell = presentShell({ ...initialState(), sync: toSyncState(sync), pending: 0 }, { ...initialStore(), sync }, NOW).sync;
    expect(shell).toMatchObject({ state: 'error', paused: true, label: '同期エラー: この PC の hangar が古いので、クラウドが同期を断りました' });
    const settings = presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync }, NOW).cloud;
    expect(settings).toMatchObject({ state: 'error', paused: true, stateLabel: '同期エラー' });
  });
```

案 B のときは、期待を次にする（ラベルの頭に「一時停止中 · 」が付く）。

```ts
    expect(shell).toMatchObject({ state: 'error', paused: true, label: '一時停止中 · 同期エラー: この PC の hangar が古いので、クラウドが同期を断りました' });
    expect(settings).toMatchObject({ state: 'error', paused: true, stateLabel: '一時停止中 · 同期エラー' });
```

案 C のときは、presenter の期待は案 A と同じにし、view の試験を足す。
ヘッダーの view の試験のファイル（`packages/ui/src/views/` で `SyncStatus` を描いている試験。`git grep -ln "<SyncStatus\|SyncStatus " -- packages/ui/src/views` で探す）に、次を足す。

```tsx
  it('一時停止中に版で止まっている間は、一時停止の切り替えを出さない（再開しても版が合うまで同期できない）', () => {
    render(<SyncStatus visible state="error" label="同期エラー: x" pending={0} sweepPending={0} skipped={0} paused reason={null} quotaBack={false} once={false} />);
    expect(screen.queryByRole('button', { name: '同期を再開' })).toBeNull();
    expect(screen.queryByRole('button', { name: '同期を一時停止' })).toBeNull();
    expect(screen.getByRole('button', { name: '今すぐ同期' })).toBeDefined();
  });
```

（`SyncStatus` の props は、PR 5 の後の `SyncProps` の形に合わせる。`render` と `screen` は、そのファイルがすでに使っている道具を使う。）

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/engine.test.ts packages/server/src/server.test.ts packages/ui/src/presenters/presenters.test.ts`
Expected: FAIL（`paused` が状態に無く、ヘッダーと設定の `paused` が false になる）。

- [ ] **Step 3: サーバが印を載せる**

`packages/shared/src/api.ts` の `SyncStatusDto` の型の `state: SyncStateKind;` の次に `paused: boolean;` を足し、型の説明の末尾に次の行を足す。

```ts
 * paused は利用者が同期を一時停止しているか（sync_state の paused の印）。版で止まって state が error のときも、一時停止していれば true である。
```

`packages/server/src/sync/engine.ts` の `status()` の返す値の `state,` の次に足す。

```ts
      // 版で止まると state は error になり、一時停止していることが state からは読めなくなる。画面の切り替えのために印を別に載せる。
      paused: this.paused,
```

`packages/server/src/server.ts` の `syncNow` の、一時停止の判定の 3 行（「一時停止しているかは、止めた印でも見る。…」の 2 行のコメントと `const paused = …;`）と、その次の `if (!paused) return engine.syncNow();` を、次に置き換える。

```ts
    // 一時停止しているかは、同期の状態の印でも見る。版で止まっている間は、一時停止していても状態が error になるからである。
    // 印で見ないと、一時停止のまま版で止まった後の押下が 1 巡の道に回らず、何も送らない。
    const s = engine.status();
    if (s.state !== 'paused' && !s.paused) return engine.syncNow();
```

- [ ] **Step 4: 画面が印を読む（案ごと）**

`packages/ui/src/presenters/shell.ts` の `syncProps` で、`return` の前に足す。

```ts
  // 一時停止しているかは印でも見る。版で止まると state は error になり、state だけでは読めないからである。
  const paused = s.kind === 'paused' || store.sync?.paused === true;
```

`return { … paused: s.kind === 'paused', … }` の `paused: s.kind === 'paused'` を `paused` にする。

`packages/ui/src/presenters/settings.ts` の `cloud` の `paused: sync?.state === 'paused',` を、次に置き換える。

```ts
    // 版で止まると state は error になるので、一時停止しているかは印でも見る。
    paused: sync?.state === 'paused' || sync?.paused === true,
```

案 A は、ここまでで終わる。

案 B のときは、さらに次の 2 つを替える。

`packages/ui/src/presenters/shell.ts` の `label` の組み立ての `: s.kind === 'error' ? `${SYNC_STATE_LABEL.error}: ${s.message}`` を、次に置き換える。

```ts
    : s.kind === 'error' ? `${paused ? `${SYNC_STATE_LABEL.paused} · ` : ''}${SYNC_STATE_LABEL.error}: ${s.message}`
```

（`paused` の宣言を `label` より前に置く。）

`packages/ui/src/presenters/settings.ts` の `stateLabel` を、次に置き換える。

```ts
    stateLabel: sync?.state === 'paused' && sync.oncePass ? SYNC_ONCE_LABEL
      : sync?.state === 'error' && sync.paused ? `${SYNC_STATE_LABEL.paused} · ${SYNC_STATE_LABEL.error}`
      : SYNC_STATE_LABEL[sync?.state ?? 'off'],
```

案 C のときは、presenter は案 A のままにし、2 つの view で切り替えを隠す。

`packages/ui/src/views/SyncStatus.tsx` の一時停止の切り替えのボタンを、次で包む。

```tsx
      {/* 一時停止中に版で止まっている間は、切り替えを出さない。再開しても、版が合うまで同期はできないからである。 */}
      {!(props.paused && props.state === 'error') && (
        <button className="btn btn-sm sync-action" data-fold-at={foldAt('sync-actions')} onClick={() => emit({ type: 'sync.pause', paused: !props.paused })}>{props.paused ? '同期を再開' : '同期を一時停止'}</button>
      )}
```

`packages/ui/src/views/SettingsScreen.tsx` の、クラウド同期の節の一時停止の切り替えのボタンを、同じく `{!(props.cloud.paused && props.cloud.state === 'error') && ( … )}` で包む。

- [ ] **Step 5: 状態の形の値を直す**

Run: `npm run typecheck`
Expected: `SyncStatusDto` か `SyncStatusBody` の形の値を書いている試験が、`paused` が無いと言って落ちる。

挙がった値に `paused: false` を足す（`state: 'paused'` の値には `paused: true` を足す）。
2026-10-07 の main では、次の 9 つのファイルにあった（PR 4 と 5 の後で増減している）。
`packages/cli/src/cloud.test.ts`、`packages/server/src/http/app.test.ts`、`packages/shared/src/api.test.ts`、`packages/ui/src/Root.test.tsx`、`packages/ui/src/mediator/transition.test.ts`、`packages/ui/src/presenters/cloudUsage.test.ts`、`packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/runtime/runtime.test.ts`、`packages/ui/src/store/store.test.ts`。

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: 古いサーバのための注記が残っていれば片付ける**

Run: `git grep -n "古いサーバは送らない\|古いサーバは理由を送らない\|古いサーバで理由が無い" -- packages`
Expected: PR 5 で `pausedReason` ごと消えていれば、何も出ない。そのときはこの Step を飛ばす。

出たら、それは `SyncStatusDto` の `pausedReason` を任意（`?`）にしておく注記と、それを受ける UI の分岐と試験である。
UI とサーバは同じ束で配るので、任意にしておく理由が無い（spec「消すもの」の、手元だけで閉じる DTO の任意項目）。
次のとおり直す。

- `packages/shared/src/api.ts` の `pausedReason?:` の `?` を外し、注記の「古いサーバは送らない（undefined）。」を消す。
- `packages/ui/src/presenters/shell.ts` の「古いサーバは理由を送らないので、手で止めたものとして扱う。」の注記を消す（`?? 'user'` は、`store.sync` が届く前の null を受けるので残す）。
- `packages/ui/src/presenters/presenters.test.ts` の `it('古いサーバで理由が無いときは、手で止めたものとして扱う', …)` を消す。
- `npm run typecheck` で挙がる値に `pausedReason: null` を足す。

- [ ] **Step 7: 通るのを見る**

Run: `npx vitest run packages/server packages/ui packages/shared packages/cli`
Expected: PASS。

- [ ] **Step 8: コミットする**

```bash
git add -A packages/shared packages/server packages/ui packages/cli
```

```bash
git commit -m "fix(sync): carry the pause flag so a paused sync stopped on a compat mismatch still offers resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 設計書と README を直し、全体を確かめ、3 つのビルドを通す

**Files:**
- Modify: `docs/design.md`（「クラウド同期」の節の中の 5 か所）
- Modify: `README.md`（「割り切りと限界」の 2 と 5）

**Interfaces:**
- Consumes: Task 2 から Task 10 で入れた名前と振る舞い。
- Produces: なし（文書と確かめだけ）。

- [ ] **Step 1: 設計書を直す**

`docs/design.md` の「## クラウド同期」の節を、次のとおり直す。
PR 4 と 5 で文が変わっている所は、意味が同じ所を探して直す。

「## クラウド同期」の頭の段落の、「ただし、無料枠の数え直し（Worker が数えて push の応答で返す形）と孤児の掃除はその後に入れたもので、」が残っていれば、「ただし、孤児の掃除はその後に入れたもので、」にする。

「### 構成と setup」の「マイグレーションの手順を別に持たず、cold start のたびに `create table if not exists` を通す形である。」の次に、次の 2 段落を足す。

```markdown
Workers には配備の後に 1 度だけ走る処理が無いので、作り替えで消したものが D1 に残した行も、この最初の要求で片付ける（`packages/cloud/src/cleanup.ts`）。
段 1 では、設定の同期の索引（`files` の `kind` が `config` の行）と、Worker が D1 への書き込みを数えていた台帳（`meta` の鍵が `d1_rows:` で始まる行）を消した。
済んだら `meta` に `stage1_cleanup` の印を置き、2 度目からは印を読むだけで帰る。
消す文と印は 1 つの batch に入れるので、途中で倒れても半端に残らない。
後始末が落ちても要求は落とさず、次の cold start でまた試す。
索引から外れた R2 の `config/` の本体は、孤児の掃除が拾って消す。

D1 の 1 日の上限（読んだ行、書いた行）に当たった失敗は、500 ではなく 429 で返す（`packages/cloud/src/limits.ts`）。
見分けるのは D1 の文で、`free tier daily row read limit` か `free tier daily row write limit` を含むものである（大文字と小文字は問わず、原因の文も見る）。
本文は `{ error: 'limit', limit: 'd1-read' | 'd1-write', resetAt }` で、`resetAt` は上限が戻る次の UTC の 0 時（epoch のミリ秒）である。
Worker も端末も量を数えないので、上限に当たったことはこの失敗で知る。
```

「### 同期対象と暗号化」：

「Worker も、`kind` が `transcript` で暗号化の申告が `1` でない `PUT` を、R2 に触る前に 400 で断る。」を、次に置き換える。

```markdown
Worker は、`kind` が `transcript` でない `PUT` と、暗号化の申告が `1` でない `PUT` を、R2 に触る前に 400 で断る。
鍵も `transcripts/` の下だけを預かり、`config/` の鍵は書くのも読むのも 400 で断る。
```

「`PUT` は R2 を先に書き、`DELETE` は索引を先に消す。」から「逆の向きで残る「索引にあるのに本体が無い」は、降ろす側が永久に 404 を踏む。」までの 3 行を、次に置き換える。

```markdown
`PUT` は R2 を先に書き、索引を後に書く。
途中で倒れれば、残るのは索引に無い R2 の本体だけである。
逆の向きで残る「索引にあるのに本体が無い」は、降ろす側が永久に 404 を踏む。
本文を消す経路（`DELETE`）は持たない。
使われていなかったので段 1 で消した。
`PUT` は `content-length` のある本文だけを受け、無ければ 411 で断る。
長さが分かれば、Worker は本文を JS で読まずにそのまま R2 へ渡せるので、CPU の時間が本文の大きさに比例しない。
長さを名乗らずに本文を流していたのは互換の版 1 より前の端末で、それは版の下限で断られる。
```

同じ節の、孤児の掃除の段落の最後（「消す索引の行が増えれば、その分だけ増える。」の次）に足す。

```markdown
段 1 で後始末が索引から外した設定の同期の本体（R2 の `config/`）も、この掃除が拾って消す。
1 回に見るのは R2 の 50 件までなので、本体の数によっては消し終えるまで数日かかる。
```

「### 使用量と費用」：

「D1 にも R2 にも 1 行も書かない（書けば、数えている書き込みそのものが増える）。」を「D1 にも R2 にも 1 行も書かない。」にする。
「古い Worker（404）と `configured: false` は「トークンなし」として扱い、」の「古い Worker（404）と 」を消す。

「### タイミングと競合」：

PR 5 の後も「行数を数えるのは Worker の側である。」から「報告を返さない古い Worker が相手のときだけ、見積もりを端末の数で割った水準で見る。」までの文が残っていれば、それを消す。
Worker が量を数えなくなったので、どの文も成り立たない。

「### 互換の版番号」：

「**Worker の下限。**」の段落の「いまの下限は 0 で、見出しの無い端末も通す。」を、次に置き換える。

```markdown
いまの下限は 1 で、見出しの無い端末（版 0）は 426 で断る。
段 1 の PR 6 で、同期に参加する端末がすべて版 1 に上がったのを確かめてから上げた。
```

「**端末の下限。**」の段落の「いまの下限は 0 で、見出しを返さない Worker とも話す。」を、次に置き換える。

```markdown
いまの下限は 1 で、見出しを返さない Worker（版 0）は断る。
そのため、`/usage` の無い古い Worker の 404 を「トークンなし」に読み替える分岐は持たない。
```

同じ段落の「応答の見出しで Worker の版を比べるのは、Worker 自身が作った応答、つまり状態が 500 未満で、408 でも 429 でもないものだけである。」から「それは Worker の版を語らないので、版の不一致にはせず、普通の失敗として扱う。」までの 3 行を、次に置き換える。

```markdown
応答の見出しで Worker の版を比べるのは、2xx の応答だけである。
Cloudflare の端は、Worker を通さずに 4xx と 5xx を返すことがある（WAF の 403、本文が大きすぎるときの 413、CPU の超過、1 日の要求の上限など）。
それらは見出しを持たず、Worker の版を語らないので、版の不一致にはせず、普通の失敗として扱う。
2xx は Worker を通らないと返らないので、古い Worker はどの経路でも最初の 2xx で見分けられる。
```

「一時停止していても、版で止まったことを先に見せる。」の次に足す。

```markdown
そのとき状態は `error` になるので、一時停止していることは `SyncStatusDto` の `paused` の印で画面へ伝える。
```

「**いつ上げるか。**」の段落の最後（「Worker の `MIN_DEVICE_COMPAT` は、同期に参加しているすべての端末が上がってから上げ、Worker を配備し直す。」の次）に足す。

```markdown
端末の `MIN_WORKER_COMPAT` を上げる版は、Worker を先に配備してから端末へ入れる。
逆の順にすると、入れ替えた端末は古い Worker を断って、配備するまで同期が止まる。
```

「## 決めた前提と未決事項」の節（main `33ca14e` で 2655 行目から 2755 行目のあたり）を、次のとおり直す。
PR 5 で消えた項目は飛ばす。

- 「行数は Worker が数え、push の応答（`d1RowsToday`）で返す。」「台帳（`meta` の `d1_rows:<yyyy-MM-dd>`）への書き込みも数に入れる。」「台帳の答え合わせに `wrangler d1 insights` を使わない。」「Worker の報告はアカウント全体の数なので、端末の数では割らない。」の 4 つの項目が残っていれば、それぞれの続きの行ごと消し、その場所に次の 1 項目を置く。

```markdown
- Worker は量を数えない（段 1 の PR 6 で台帳を外した）。
  数えるために D1 へ書けば、その書き込みも枠を使い、Worker は自分のプランも知らないからである（全体計画の D4）。
  上限に当たったことは、D1 の失敗を 429 で返して端末へ伝える。
  台帳の行は、配備の後の最初の要求で後始末が消した。
```

- 「既知の限界：使わなくなった端末の `transcripts/<端末 ID>/` と `config/<端末 ID>/` を畳む口が無い。」の「と `config/<端末 ID>/`」を消す。
- 「既知の限界：無料枠の数え直しと孤児の掃除は、偽のクラウドとローカルの workerd（miniflare）の試験だけで確かめた（2026-09-20）。」の「無料枠の数え直しと」を消す。
- 未決事項の「使わなくなった端末の始末。`transcripts/<端末 ID>/` と `config/<端末 ID>/` と `devices` の行を畳む操作が無い。」の「と `config/<端末 ID>/`」を消す。

- [ ] **Step 2: README を直す**

`README.md` の「割り切りと限界」の 5 の「本文の PUT は R2、D1 の順、DELETE は索引を先に消す順なので、途中で倒れて残るのは索引に無い R2 の本体だけです。」を、「本文の PUT は R2、D1 の順なので、途中で倒れて残るのは索引に無い R2 の本体だけです。」にする。
同じ項目の「使わなくなった端末の `transcripts/<端末 ID>/` と `config/<端末 ID>/` を明示的に畳む操作は、まだありません。」を、次に置き換える。

```markdown
   使わなくなった端末の `transcripts/<端末 ID>/` を明示的に畳む操作は、まだありません。
   設定の同期が残した `config/<端末 ID>/` は、段 1 の後始末で索引から外したので、この掃除が少しずつ消します。
```

「割り切りと限界」の 2 に、PR 5 の後も「D1 の書き込みは Worker が数えます。」から「報告を返さない古い Worker が相手のときと、要求の回数の側は、今までどおり端末の数で割った水準で見ます。」までの文が残っていれば、それを消し、項目の見出しと残りの文が PR 5 の後の振る舞い（上限の失敗を受けたら次の UTC の 0 時まで止まる）と合っているかを読む。
合っていなければ、手を止めて親に知らせる（PR 5 の残りである）。

- [ ] **Step 3: 文書の書き方を確かめる**

Run: `perl -CSD -ne 'BEGIN { $a = chr(0x30FB); $b = chr(0x2014) } $in = 1 if /^## クラウド同期/; $in = 0 if /^## 配布と運用/; $n++ if $in && /$a|$b/; END { print $n + 0, "\n" }' docs/design.md`
Expected: `0`。

Run: `git diff -U0 README.md | perl -CSD -ne 'BEGIN { $a = chr(0x30FB); $b = chr(0x2014) } $n++ if /^\+/ && /$a|$b/; END { print $n + 0, "\n" }'`
Expected: `0`。

- [ ] **Step 4: 型を通す**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 5: 試験を全部通す**

Run: `npm test`
Expected: すべて PASS。

- [ ] **Step 6: 画面を重ねて撮る**

memory の reference-overlay-ui-check の手順で、動いているアプリ（4177）の実データに worktree の `packages/ui/dist` を重ね、WebKit でヘッダーと設定の「クラウド同期」の節を撮って自分の目で見る（読むだけにし、ボタンは押さない）。
普段の同期の一行と設定の節が崩れていないことを見る。
一時停止中に版で止まった状態は実データでは作れないので、Task 10 の試験で押さえたことを報告に書く。

- [ ] **Step 7: UI とパッケージをビルドする**

Run: `npm run build`
Expected: 成功する。

- [ ] **Step 8: 同梱のサーバを束ねる**

Run: `npm run bundle-server -w apps/desktop`
Expected: 成功する。

- [ ] **Step 9: デスクトップのアプリをビルドする**

Homebrew の cargo を PATH の先頭に置いて打つ（rustup の古い cargo だと落ちる）。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`
Expected: 成功し、.app ができる。

- [ ] **Step 10: コミットする**

```bash
git add docs/design.md README.md
```

```bash
git commit -m "docs: describe the stage 1 Worker cleanup, the 429 limit answer and the raised compat floors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: PR を出して CI を待つ**

開発の流れ（CLAUDE.local.md）の 5 のとおり、枝を push して `gh pr create` で PR を出し、check、desktop、windows の 3 つのジョブが緑になるのを待つ。
緑になったら `gh pr merge <番号> --merge` でマージする。
アプリの入れ替え（開発の流れの 6）は、Task 12 の配備の後に行う。
配備を見送ったときは、入れ替えも見送るかを利用者に聞く（入れ替えると、この PC は古い Worker を断って同期が止まる）。

---

### Task 12: Worker の配備（利用者に聞いてから）

このタスクの手順は、どれも実物のクラウドに触る。
Step 1 で利用者に聞き、許されたものだけを行う。
聞かずに打たない。
許されなかった手順は、報告に「実物では未確認」と書く。

ここで扱うアカウント ID、Worker の URL、D1 の名前は、手元の端末でだけ使い、計画、コミット、PR、報告に書かない。

**Files:** なし（手元の設定と実物のクラウドだけを使う）。

**Interfaces:**
- Consumes: Task 11 でマージした main の `packages/cloud`。
- Produces: 実物の Worker が互換の版 1 を名乗り、端末に下限 1 を求める状態。戻すための前の版の識別子（手元の控えにだけ置く）。

- [ ] **Step 1: 見積もりを添えて利用者に聞く**

AskUserQuestion で 1 問だけ聞く。
推す案を先頭に置く。

- 問い：「PR 6 の Worker を実物へ配備してよいですか。配備の後、最初の要求で後始末（設定の同期の索引と台帳の行を消す）が 1 回走ります」
- 選択肢：「配備する（推す）」「いまは見送る（アプリの入れ替えも見送る）」

問いの説明に、使う無料枠の見積もりを添える。

- Workers の要求：確かめの往復で数十回（1 日 10 万回の 0.1% に届かない）。配備と戻しそのものは要求の枠を使わない。
- D1 の書き込み：後始末で「設定の同期の索引の行の数 × 3 ＋ 約 20 行」（`files` の行は本体と 2 つの索引で 3 行）。索引の行が 1,000 行でも約 3,000 行で、1 日 10 万行の 3%。
- D1 の読み取り：設定の同期の索引の行の数と数百行（1 日 500 万行の 0.1% に届かない）。
- R2：後始末は R2 に触らない。その後の掃除が `config/` の本体を消すのは無料の操作で、一覧は今までの 6 時間に 1 回のまま。

- [ ] **Step 2: 手元の束と設定を確かめる（許されたら）**

worktree の根で打つ。
アカウント ID は `~/.agent-hangar/cloud.json` の `accountId` を読んで使う（画面に出た値を、どこにも書き写さない）。

Run: `node -p "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.agent-hangar/cloud.json', 'utf8')).accountId"`
Expected: アカウント ID が 1 行出る。

次の `<アカウント ID>` を、いま読んだ値に置き換えて打つ。

Run: `CLOUDFLARE_ACCOUNT_ID=<アカウント ID> WRANGLER_SEND_METRICS=false npx wrangler deploy packages/cloud/src/index.ts --config ~/.agent-hangar/cloud/wrangler.jsonc --dry-run --outdir <scratchpad>/worker-dry-run`
Expected: 束ねて止まり、上げない。束縛に `DB` と `BUCKET` が並ぶ。

Run: `grep -c "^export" <scratchpad>/worker-dry-run/index.js`
Expected: `1`（既定の輸出だけ。PR 3 の申し送りの 3 つ目）。

環境変数を前に置く形を Bash が断ったら、同じ命令を利用者に打ってもらう。

- [ ] **Step 3: いまの版を控える（許されたら）**

Run: `CLOUDFLARE_ACCOUNT_ID=<アカウント ID> WRANGLER_SEND_METRICS=false npx wrangler deployments status --config ~/.agent-hangar/cloud/wrangler.jsonc`
Expected: いま配備されている版の識別子が出る。

その識別子を、手元の memory（PR 6 の頁）にだけ控える。
戻すときに使う。

- [ ] **Step 4: 配備する（許されたら）**

Run: `CLOUDFLARE_ACCOUNT_ID=<アカウント ID> WRANGLER_SEND_METRICS=false npx wrangler deploy packages/cloud/src/index.ts --config ~/.agent-hangar/cloud/wrangler.jsonc --message "stage 1 PR 6"`
Expected: 配備が済み、Worker の URL が出る。

設定の `main` は `hangar setup cloud` を打った checkout を指しているので、入口は位置の引数で worktree の束を渡す（設定のファイルは書き換えない）。

- [ ] **Step 5: 版と同期の 1 巡を確かめる（許されたら）**

Run: `npm run hangar -- cloud status`
Expected: `互換の版: この PC 1、Worker 1` の行が出て、Worker の行が `ok` である。

いま動いているアプリ（PR 5 までの版）は、30 秒ごとに受け取りにいく。
1 分待ってから、もう一度打つ。

Run: `npm run hangar -- cloud status`
Expected: 同期の行が `idle` で、エラーが無く、最終 pull が 1 分以内である。

- [ ] **Step 6: 後始末が済んだかを見る（許されたら）**

D1 の名前は `~/.agent-hangar/cloud.json` の `dbName` を読んで使う。

Run: `CLOUDFLARE_ACCOUNT_ID=<アカウント ID> WRANGLER_SEND_METRICS=false npx wrangler d1 execute <D1 の名前> --remote --config ~/.agent-hangar/cloud/wrangler.jsonc --command "select (select count(*) from files where kind = 'config') as config_rows, (select count(*) from meta where substr(key, 1, 8) = 'd1_rows:') as ledger_rows, (select count(*) from meta where key = 'stage1_cleanup') as cleaned"`
Expected: `config_rows` が 0、`ledger_rows` が 0、`cleaned` が 1。

- [ ] **Step 7: アプリを入れ替える**

開発の流れの 6（アプリの入れ替えと再起動）を行う。
入れ替えた後、`npm run hangar -- cloud status` で同期の行が `idle` でエラーが無いことを見る（Worker への要求はアプリが普段どおり出すもので、追加の枠は使わない）。

- [ ] **Step 8: 戻し方を控える**

戻すときは、次の 2 つをこの順に行う（どちらも利用者に聞いてから）。

1. Worker を前の版に戻す。

   Run: `CLOUDFLARE_ACCOUNT_ID=<アカウント ID> WRANGLER_SEND_METRICS=false npx wrangler rollback <Step 3 で控えた識別子> --config ~/.agent-hangar/cloud/wrangler.jsonc --message "roll back stage 1 PR 6"`

2. アプリを PR 6 の前の版に戻す。

   前の Worker は版の見出しを返さない（版 0）ので、PR 6 のアプリは同期を止める。
   `~/.agent-hangar/backups/` に退避した前の .app を、開発の流れの 6 と同じ手順で `/Applications` へ戻す。

後始末で消した行（設定の同期の索引と台帳）は、PR 4 と 5 の後の端末も前の Worker も読まないので、戻さなくても動く。
どうしても戻すときだけ、D1 の Time Travel（無料枠で 7 日）で配備の前の時刻へ戻す。
これは DB 全体を戻し、その後の同期の変更も消すので、最後の手段にする。

報告には、配備したか、版と同期の 1 巡と後始末を実物で確かめたか、確かめていないものはどれかを分けて書く。
