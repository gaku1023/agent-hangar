# 統括の会話の作り直し 計画

設計：`docs/superpowers/specs/2026-11-17-orchestrator-lifecycle-design.md`。PR は段ごとに分け、前の段がマージされてから次に入る。各 PR は TDD、`docs/design.md`「統括」の節も直す。

## 段 1：統括が読める（PR 1）

インタフェース

- `mcp/tools.ts`：読む道具の枠を決める関数を、統括の URL では undefined（全プロジェクト）にする。対象は `search_sessions`、`list_sessions`、`get_transcript`、`list_projects`、`get_project`。書く道具は今の `projectScope` のまま。
- 検索の結果と一覧の項目に `orchestrator: boolean`（今の統括か系譜の id なら真）。系譜は段 2 で入るので、この段は今の `sessionId` だけで判定する。
- 役の文に「前の話を指されたら検索してから答える」を足す（ja と en）。

受け入れの試験

- 統括の URL で、別のプロジェクトの会話の語で `search_sessions` が当たる。`list_sessions` が全プロジェクトを返す。
- 統括の URL で `update_project` は今と同じく断られる。
- プロジェクトのセッションの URL から、統括の会話は検索に出ない。
- 統括の会話の当たりに `orchestrator: true` が付く。

## 段 2：系譜と切り替え（PR 2）

インタフェース

- 設定 `orchestrator.history`（shared の型、`isOrchestratorPatch`、上限 20）。
- 統括専用の MCP の道具 `write_handoff(text)`（`ORCHESTRATOR_TOOL_NAMES` と `toolClasses` に足す）。
- `OrchestratorKeeper.fresh(reason)`：設計の「切り替えの手順」1〜5。待ちの上限（30 秒、90 秒）は deps で差し替えられるようにする。
- 引き継ぎを作る純粋な関数 `buildHandoff(...)`（`orchestrator/handoff.ts`）。
- `involved.ts`：統括の id の集合（今と系譜）で引く。
- `KeeperState` に `switching` と `contextTokens`。
- ローカル API：`POST /api/orchestrator/fresh`、`/stop`、`/wake`。

受け入れの試験

- 切り替えると、前の id が history に移り、新しい id が `sessionId` になる。21 件目で最古が落ちる。
- 古い統括がメモを書けば引き継ぎに入る。90 秒で来なければ、メモ無しで切り替わる。
- 古い統括が busy のまま 30 秒を過ぎても、手動の切り替えは進む。
- 前の統括が起こした会話の turn.done が、新しい統括に届く。
- stop で `stopped: user`、wake で running に戻る。enabled は stop で変わらない。
- 検索の `orchestrator: true` が系譜の id にも付く。

## 段 3：柱のメニュー（PR 3）

インタフェース

- `OrchestratorPillar.tsx`：右上の丸を押すとメニュー（試作 A）。presenter に状態の 1 行と文脈の量。
- 動きは `motionKit` の `growIn`・`collapseOut`・`fadeIn` と `usePresence`。
- 文面は Gemini に当ててから入れる（新しい文：始め直す、起こす、柱を閉じる、状態の 1 行）。

受け入れの試験

- 丸を押すとメニューが開き、外を押すと閉じる。⌥⌘J で柱が閉じる。
- 止まっているときは「起こす」、動いているときは「止める」。
- 切り替えると、前の会話の行が畳まれ、区切りの線の下に新しい会話が積まれる。
- 15 万を超えると棒が `--busy` の色になる。
- WebKit で実データに重ねて撮り、メニュー、止まったとき、切り替えの直後を目で見る。README の `--stale` も見る。

## 段 4：役の文の版と、太ったときの自動（PR 4）

インタフェース

- run に役の文のハッシュを記録し、起動時に違えば次の idle で再開し直す。
- `feed.ts` の `checkCompact`：`/compact` の代わりに `keeper.fresh('auto')` を呼ぶ。閾値と idle は今の値。

受け入れの試験

- 役の文を変えて起動すると、動いている統括が idle で再開し直され、会話の id は変わらない。
- 15 万を超えて idle が 2 分続くと、切り替え（`reason: auto`）が 1 回だけ起きる。

## 実物の確かめ（段 3 と 4 のあと）

- Mac の統括で「新しい会話で始め直す」を押し、前の会話の件を聞いて、検索して答えるか。
- 自動の切り替えが実物で 1 回起きるのを見て、閾値を決め直す。
