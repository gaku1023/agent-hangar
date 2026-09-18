# agent-hangar

Claude Code のセッションをプロジェクト単位で束ね、起動、観察、検索、記録を一箇所で行う個人用のローカルアプリです。
設計は `docs/design.md`、実装計画は `docs/plans/` にあります。

## 現状

フェーズ 2（tmux でのセッション起動、ブラウザに埋め込んだターミナル、セッション内のシェルタブ、MCP、外部アプリとの連携）まで実装済みです。
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
索引は `~/.agent-hangar/hangar.db` に置きます。

## 開発

```sh
npm run typecheck
npm test
```
