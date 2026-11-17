# 統括の起動の設定 段 1 計画

**Goal:** 設定に独立の「統括」の節を立て、統括の Claude のアカウント・モデル・effort を選べるようにする。動いている間に変えたら同じ会話に当てる。

**Spec:** `docs/superpowers/specs/2026-11-17-orchestrator-launch-settings-design.md` の段 1。試作は `/private/tmp/claude-501/-Users-satog-workspace-agent-hangar/e3b9b273-993d-44a0-aa4f-6573659769ec/scratchpad/orch-settings.html` の案 A（アプリの札は段 2 なので出さない）。

## Global Constraints

- 補助のラベルや説明文を足さない。動きは motionKit（growIn・collapseOut）と usePresence。明るい配色だけ。
- 文言は ja と en の両方に足す（仮の文でよい。最後に Gemini に当てる）。
- 公開リポジトリ。実際のアカウント名やメールを試験や文書に書かない。
- 統括の設定は同期しない（今のまま）。

## Interfaces

- shared `OrchestratorSetting = { enabled; sessionId; model; effort; account: string | null }`。`orchestratorOf` は account が空でない文字列でなければ null。`isOrchestratorPatch` は `account`（空でない文字列か null）も受ける。
- サーバの PATCH は、account が今あるアカウントの id でなければ 400。
- `KeeperRuns.resumeWith(sessionId, o?: { account?: string })`、`startOrchestrator(o?: { account?: string })`。見張りは設定の account を渡す。
- 見張りに「指定が変わった」ときの再開し直しを足す：apply() で前回の起動の指定（account・model・effort）と違い、統括が動いていれば、idle になったときに止めて同じ会話を再開する。この止め方は onRunEnded で利用者の停止と見なさない（入り切りを切にしない、失敗に数えない）。idle の判定に要る口は KeeperDeps に足す。
- `SETTINGS_SECTIONS` に `'orchestrator'`（`sessions` の次）。presenter に `orchestrator?: { on; account; model; effort; accounts: LaunchAccountOption[] }` を足し、今の `orchestratorOn` と `voice` を節へ移す。

## Task 1：shared とサーバ

Files: `packages/shared/src/orchestrator.ts`(+test)、`packages/server/src/http/routes/settings.ts`(+test)、`packages/server/src/orchestrator/keeper.ts`(+test)、`packages/server/src/runs/manager.ts`（startOrchestrator・resume の account）、`packages/server/src/boot/http.ts`、`docs/design.md`「統括」

- [ ] 試験を先に：orchestratorOf・isOrchestratorPatch の account、PATCH の 400、startOrchestrator が指定のアカウントの環境で起こす、見張りが再開に設定の account を渡す、指定が変わったら idle で止めて同じ会話を再開する（入り切りは入りのまま、失敗に数えない）、busy の間は待つ。
- [ ] 実装、`npm run typecheck`・`npm test`、コミット。

## Task 2：画面

Files: `packages/shared/src/route.ts`、`packages/shared/src/i18n/{ja,en}/settings.ts`、`packages/ui/src/presenters/settings.ts`、`packages/ui/src/views/SettingsScreen.tsx`(+test)、必要なら札の薄い包み、`docs/design.md`

- [ ] 試験を先に：目次に「統括」が出る（古いサーバでは出ない）、入り切り、札でアカウント・モデル・effort を選ぶと PATCH が飛ぶ、切ると札の行と声が畳まれる、「Claude Code」の節に統括の欄が無い。
- [ ] 札は新規のダイアログと同じ部品（LaunchChips の SettingChip・PickList、アカウントは LaunchAccountOption）を使う。
- [ ] 実装、typecheck・test、コミット。
