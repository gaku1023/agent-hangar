# agent-hangar

Claude Code のセッションをプロジェクト単位で束ね、起動、観察、検索、記録を一箇所で行う個人用のローカルアプリです。
設計は `docs/design.md`、実装計画は `docs/plans/` にあります。

## 現状

フェーズ 1（読み取り専用の索引と UI）を実装済みです。
セッションの起動、クラウド同期、デスクトップ配布は後のフェーズで、計画は `docs/plans/` にあります。

## 使い方（フェーズ 1）

```sh
npm install
npx hangar setup            # ~/.agent-hangar を作り、tmux と claude と code の有無を報告する
npm run dev                 # サーバ（4177）と UI の開発サーバ（5173）を起動する
```

開発時はブラウザで `http://127.0.0.1:5173/` を開きます。
本番ビルドは `npm run build` の後に `npx hangar start` で、`http://127.0.0.1:4177/` から UI を配信します。

hangar は `~/.claude/` を読むだけで、書き換えません。
索引は `~/.agent-hangar/hangar.db` に置きます。

## 開発

```sh
npm run typecheck
npm test
```
