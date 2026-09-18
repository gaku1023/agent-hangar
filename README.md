# agent-hangar

Claude Code のセッションをプロジェクト単位で束ね、起動、観察、検索、記録を一箇所で行う個人用のローカルアプリです。
設計は `docs/design.md`、実装計画は `docs/plans/` にあります。

## 現状

フェーズ 3（使用量、アーティファクト、TODO とメモ、スクラッチと昇格、タブの分割、事後要約、コマンドパレット）まで実装済みです。
フェーズ 2 までで入った、tmux でのセッション起動、ブラウザに埋め込んだターミナル、セッション内のシェルタブ、MCP、外部アプリとの連携もそのまま使えます。
クラウド同期とデスクトップ配布は後のフェーズで、計画は `docs/plans/` にあります。

## 使い方

```sh
npm install
npm run hangar -- setup     # ~/.agent-hangar を作り、tmux と claude と code の有無を報告する
npm run dev                 # サーバ（4177）と UI の開発サーバ（5173）を起動する
```

セッションを起動するには tmux が要ります（`brew install tmux`）。
Claude Code から hangar のツールを使うには、一度だけ次を実行します。

```sh
npm run hangar -- mcp install     # claude mcp add で user スコープに hangar を登録する
npm run hangar -- mcp uninstall   # 取り消す
```

これは `~/.claude.json` を hangar が直接書くのではなく、`claude mcp add` に任せます。

開発時はブラウザで `http://127.0.0.1:5173/` を開きます。
本番ビルドは `npm run build` の後に `npm run hangar -- start` で、`http://127.0.0.1:4177/` から UI を配信します。
npm には無関係の `hangar` という別のパッケージがあるので、`npx hangar` は使いません。

hangar は `~/.claude/` を読むだけで、書き換えません。
唯一の例外は次の節の statusline スクリプトへの追記で、これも承諾を求め、追記の前にバックアップを取ります。
`~/.claude/settings.json` と `~/.claude.json` は書き換えません。
索引は `~/.agent-hangar/hangar.db` に置きます。

## 使い方（フェーズ 3）

```sh
npm run hangar -- statusline install   # statusline スクリプトに追記して、使用量ゲージを動かす
```

追記先は `~/.claude/settings.json` の `statusLine.command` が指すスクリプトです。
承諾（`y` の入力、または `--yes`）を求め、追記の前に同じディレクトリにバックアップを取ります。
statusline を設定していない場合は追記せず、貼り付ける内容と手順を印字します。
サーバを 4177 以外で動かしているときは `--port <番号>` を渡します。

ヘッダーに 5 時間と 7 日の使用率のゲージが出ます。
値は Claude Code が statusline に渡す JSON が唯一の供給源なので、Claude が動いている間だけ新しくなります。

プロジェクト詳細の右レールで TODO と Markdown のメモを書けます。
メモは `~/.agent-hangar/projects/<projectId>/memo.md` にも書き出すので、エディタから直接編集できます。
ファイルの方が新しければファイルの内容を採ります。
DB の内容で上書きするときは、消える本文を同じディレクトリに `memo.md.bak-<日時>` として残します。
同じレールに、セッションが claude.ai に公開したアーティファクトのカードが並びます。

⌘⇧N で始めたスクラッチのセッションは、後から「プロジェクトに昇格」でワークスペースの下に移せます。
セッション画面では ⌘\ で 2 つのタブを横に並べられます。

要約は LM Studio（`http://127.0.0.1:1234`）が既定で、繋がらないときだけ `claude -p` に切り替えます。
切り替えの上限は Settings で変えられます。

主なショートカットは、⌘K パレット、⌘N 新規、⌘⇧N スクラッチ、⌘, 設定、⌘1 から ⌘9 でタブ、⌘W でタブを閉じる、⌘\ で分割、⌘J でトランスクリプト、一覧では j と k と Enter と o と e と m です。

## 開発

```sh
npm run typecheck
npm test
```
