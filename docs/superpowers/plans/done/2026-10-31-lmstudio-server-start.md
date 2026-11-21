# LM Studio Server Start Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Implement inline with TDD and a final review.

**Goal:** 会話開始時に LM Studio サーバーを自動起動し A 案で進みを表示する。
**Architecture:** ローカルサーバー起動サービスを boot で一つ組み、materialize の準備コマンド後・モデル確認前に呼ぶ。既存 LaunchPrep の段を拡張し UI と辞書で表示する。
**Tech Stack:** TypeScript, Node 22, React, Vitest.
**Spec:** docs/superpowers/specs/2026-10-31-lmstudio-server-start-design.md

## Global Constraints
- 自動起動先とコマンドは spec の制限に従う。標準インストール先も探索する。
- UI は既存の一行＋完了履歴とアニメーションを使う。
- クラウドへの実物アクセスはしない。main を編集しない。

## Review Focus
- 同時開始で一人だけ中止した場合も残りの待機者が成功する。
- 全員中止後の再試行で中止済み処理を再利用しない。
- 認証エラーや別 API の HTTP 応答で既存サーバーを起こし直さない。
- 別プロバイダー・リモート・不正な URL にコマンドを実行しない。
- 再開と既定モデル・singleModel の接続先選択も新規開始と整合する。

### Task 1: 起動サービスと進行表示
**Files:** localModels/serverStart.ts と試験、shared/launchPrep.ts と ja/en 辞書、ui/presenters/launchPrep.ts と試験。
**Interfaces:** LmServerStarter.ensure(provider, prep): Promise<void>。provider は id/baseURL、prep は LaunchPrep。
- [ ] 停止中、起動済み、失敗、取消、同時開始、対象外の試験と表示試験を先に書き失敗を確認。
- [ ] CLI 探索・起動・API 接続待ち・共有起動を実装し試験を通す。
- [ ] server-start の段を既存 UI に接続し辞書と表示試験を通す。

### Task 2: 会話起動への組み込み
**Files:** opencode/launch.ts, driver.ts, boot/agents.ts と既存試験、docs/design.md。
**Interfaces:** MaterializeDeps.localServers に起動サービスを受ける。prepareServers は対象モデルの接続先を解決する。
- [ ] 起動サービスがモデル確認より先に呼ばれる試験を追加し失敗を確認。
- [ ] 新規開始と再開に組み込み、接続失敗の案内を API サーバーに直す。
- [ ] 型検査・全テスト・3 本の build・UI overlay・README stale を実行。
- [ ] 全体レビュー、コミット、PR と CI を確認。マージは利用者が行う恒久ルールに従い手順を報告。
