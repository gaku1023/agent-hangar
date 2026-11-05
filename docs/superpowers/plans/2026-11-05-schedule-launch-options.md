# 予定の起動設定 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 予定の「新しい会話」で、新規ダイアログと同じ起動の項目（プロジェクトの札、エージェント、アカウント、モデル、effort、権限、worktree、追加ディレクトリ、名前、Codex と opencode の各項目）を選べるようにする。

**Architecture:** `ScheduleTarget.new` に `LaunchParams` と同じ名前の任意の項目を足し、JSON の列にそのまま保存する（マイグレーション無し）。起動は今と同じく `createSessionTool` を通し、足りない口（Codex のアカウント、opencode の自動承認、scratch、cwd）を足す。画面は新規ダイアログの札の組み立てを共有の部品に切り出し、`ScheduleForm` から使う。

**Tech Stack:** TypeScript、React、Hono、better-sqlite3、vitest。

**Spec:** `docs/superpowers/specs/2026-11-05-schedule-launch-options-design.md`（試作は同じ場所の `2026-11-05-schedule-launch-options/schedule-launch.html` の案 A）

## Global Constraints

- 表（schedules）は変えない。古い行（`{ kind: 'new', projectId, agent? }`）はそのまま読めること。
- 項目名は `LaunchParams`（`packages/shared/src/action.ts:64`）にそろえる：`name`、`account`、`model`、`effort`、`permissionMode`、`worktree`、`addDirs`、`mode`、`autoApprove`、`cwd`。クイックセッションは `projectId: null` と `scratch: true`。
- エージェントに合わない項目は、保存（HTTP と MCP）でも起動でも `createSessionTool` と同じ文で断る。黙って捨てない。
- MCP でも Bypass permissions、Codex の full-access、opencode の自動承認を通す（利用者の決定）。
- 画面の新しい文は日本語と英語の両方を足す。文面はオーケストレータが最後に Gemini に当てて差し替えるので、仮の文でよい（キーは決めておく）。
- テストは実物の `~/.claude` と `~/.agent-hangar` に触らない。ポート番号でプロセスを止めない。
- コミットはパスを指定する形（`git commit <path>...`）。`--amend` と rebase は使わない。末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- UI は常に明るい配色。補助の説明文を足さず、配置で分からせる。

## Review Focus

1. 古い形の予定（agent だけ、または何も無い）を開いて保存し直しても、値が増えたり変わったりしない → Task 1 と Task 3 に試験。
2. エージェントを Claude Code から Codex に替えて保存すると、Claude Code だけの値（worktree など）が保存されない → Task 3 に試験。
3. 消えたアカウントの id を持つ予定の回は、いまのアカウントで動かず失敗になり、理由が履歴に残る → Task 2 に試験。
4. 遅れて走った回の worktree の名前が、走った時刻でなく予定時刻で付く → Task 2 に試験。
5. プロジェクトを固定した MCP の URL から scratch の予定を作ろうとすると断る、プロジェクトで絞った一覧にクイックセッションの予定が出ない → Task 1 に試験。

---

### Task 1: 共有の型と保存の検査

**Files:**
- Modify: `packages/shared/src/schedule.ts`
- Modify: `packages/server/src/schedule/store.ts`（dto に `accountName`、project_id null の扱い）
- Modify: `packages/server/src/http/routes/schedules.ts`（`targetOf`）
- Modify: `packages/server/src/mcp/scheduleTools.ts`（`targetArg`、スキーマと説明）
- Create: `packages/server/src/schedule/target.ts`（HTTP と MCP が共有する検査）
- Test: `packages/server/src/schedule/target.test.ts`、既存の `routes/schedules` と `scheduleTools` の試験に追記

**Interfaces:**
- Produces:
  - `type ScheduleLaunch = { name?: string; account?: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[]; mode?: string; autoApprove?: boolean; cwd?: string }`（shared から export）
  - `ScheduleTarget` の new を `{ kind: 'new'; projectId: string | null; scratch?: boolean; agent?: AgentKind } & ScheduleLaunch` に。
  - `ScheduleDto.accountName: string | null`（アカウントを持つ予定で、いまの組から引いた表示名。引けなければ null）。
  - `parseNewTarget(v: unknown, agentEnabled: (a: AgentKind) => boolean): Extract<ScheduleTarget, { kind: 'new' }>`（`schedule/target.ts`）。MessageError で断る。
- MCP の引数名は `create_session` と同じ：`account`、`model`、`effort`、`permission_mode`、`worktree`、`add_dirs`、`mode`、`auto_approve`、`name`、`scratch`。

- [ ] **Step 1: 失敗する試験を書く**（`target.test.ts`）
  - `parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'codex', worktree: 'w' })` は `createSessionTool` と同じ文（Claude Code だけの項目）で投げる。
  - `parseNewTarget({ kind: 'new', projectId: null })` は scratch が無いので投げる。`{ projectId: null, scratch: true }` は通る。
  - opencode に `account` は投げる。Codex に `account` は通る。Claude Code に `mode` と `autoApprove` は投げる。
  - 古い形 `{ kind: 'new', projectId: 'p1' }` と `{ kind: 'new', projectId: 'p1', agent: 'opencode' }` はそのままの形で返る（余計なキーが増えない）。
  - 空文字の項目は落とす（`model: ''` は保存しない）。
- [ ] **Step 2: 走らせて落ちることを確かめる** — `npx vitest run packages/server/src/schedule/target.test.ts`
- [ ] **Step 3: 型と `parseNewTarget` を実装し、HTTP の `targetOf` と MCP の `targetArg` から使う。** 行の `project_id` は target の projectId（scratch は null）。MCP はプロジェクトを固定した URL で `scratch: true` を断る（新しいキー `schedules.error.scratchScoped`）。`listSchedules(db, deviceId, projectId)` は projectId を渡されたら null の行を出さない（今の挙動を試験で固定する）。
- [ ] **Step 4: 試験を足す** — HTTP で全項目付きの予定を作って GET で同じ値が返る。MCP の `create_schedule` に `model`、`effort`、`auto_approve` を渡した予定の target にその値が入る。プロジェクト固定の URL で scratch は断る。
- [ ] **Step 5: `npx vitest run packages/server packages/shared` と `npm run typecheck` が通る**（UI の型の崩れは Task 3 で直すので、UI のパッケージの型の失敗だけは残ってよい。残したものを報告に書く）
- [ ] **Step 6: コミット**

### Task 2: 起動の経路

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`（`createSessionTool`、`launchAccount`、`ToolDeps`、`create_session` のスキーマと説明）
- Modify: `packages/server/src/schedule/launch.ts`、`packages/server/src/schedule/runner.ts`（`plannedAt` を launch に渡す）
- Modify: ToolDeps を組む所（`boot/` の MCP の配線）に Codex のアカウントの組を足す
- Test: `packages/server/src/schedule/launch.test.ts`、`mcp/tools` の試験に追記

**Interfaces:**
- Consumes: Task 1 の `ScheduleTarget`、`ScheduleLaunch`。
- Produces:
  - `ToolDeps.codexAccounts?: Pick<AccountStore, 'list' | 'get' | 'current'>`
  - `createSessionTool` が `auto_approve`（opencode だけ）、Codex の `account`、`scratch: true` のとき project_id 無し、内部の引数 `cwd` を受ける。`cwd` は MCP のスキーマには出さない（予定から渡すだけ）。
  - `launchScheduled(deps, s: { prompt: string; target: ScheduleTarget; plannedAt: number }, clock?)`
  - `worktreeForRun(base: string, plannedAt: number): string` … 手元の時刻で `${base}-MMDD-HHmm`。
  - 予定からの起動では、アカウントを id だけで引く（`accountById`）。見つからなければ新しいキー `schedules.error.accountGone` で投げる。

- [ ] **Step 1: 失敗する試験を書く**
  - `worktreeForRun('deps-audit', new Date(2026, 10, 5, 9, 0).getTime()) === 'deps-audit-1105-0900'`
  - `launchScheduled` に全項目の Claude Code の target を渡すと、`createSessionTool` の引数に `model`、`effort`、`permission_mode`、`account`、`add_dirs`、`name`、`worktree: 'w-1105-0900'` が入る。name が無ければ今と同じく指示の頭。
  - Codex の target の `account` が Codex の組の id で渡る。opencode の `autoApprove: true` が `runs.start` の `autoApprove: true` になる。
  - 消えた id の account は `schedules.error.accountGone` で投げ、`runs.start` は呼ばれない。account の無い target は、いまのアカウント（`store.current()`）で起きる。
  - 遅れて走った回（runner が planned より 3 時間後に fire）の worktree は planned の時刻で付く。
  - 同名の worktree が既にあるときの失敗は、`runs.start` の失敗がそのまま回の error に残ることを確かめる（新しい検査は足さない）。
  - `create_session` に `auto_approve: true` と opencode は通り、Claude Code に `auto_approve` は断る。
- [ ] **Step 2: 落ちることを確かめる** — `npx vitest run packages/server/src/schedule packages/server/src/mcp`
- [ ] **Step 3: 実装する。** `launchAccount` は agent ごとに組を選ぶ（Claude Code は `deps.accounts.store`、Codex は `deps.codexAccounts`）。名前で引くのは MCP の `create_session` だけで、予定は id だけ。
- [ ] **Step 4: 試験が通る、`npm run typecheck`（server）が通る**
- [ ] **Step 5: コミット**

### Task 3: 予定のフォームを新規ダイアログの札に

**Files:**
- Create: `packages/ui/src/views/useLaunchChoice.ts`（新規ダイアログの札の組み立てを切り出した hook）
- Modify: `packages/ui/src/views/NewSessionDialog.tsx`（切り出した hook を使う。振る舞いは変えない）
- Modify: `packages/ui/src/views/SchedulesScreen.tsx`、`packages/ui/src/presenters/schedules.ts`、`packages/ui/src/styles/schedules.css`
- Modify: 予定の保存の mediator（フォルダを選んだときの登録。`mediator/launch.ts` の `session.new.submit` の place の扱いを共有する）、`packages/shared/src/action.ts` の `schedule.create` / `schedule.update` に `place?: ProjectPlace`
- Modify: i18n（`schedules.form.createBypass`、`schedules.form.saveBypass`、`schedules.quick` ほか。日本語と英語）
- Test: `SchedulesScreen.test.tsx`、`NewSessionDialog` の既存の試験が全部緑のまま

**Interfaces:**
- Consumes: Task 1 の `ScheduleTarget`、`ScheduleDto.accountName`。
- Produces: `useLaunchChoice(opts)` … プロジェクトの札（Listbox、検索、まとまり、操作の行）、エージェント、アカウント、Claude・Codex・opencode の各値と `LaunchChips` に渡す props、そして選んだ値から `{ target: Extract<ScheduleTarget,{kind:'new'}>; place?: ProjectPlace }` と `LaunchParams` を作る関数を返す。opts は初期値（予定の target か前回値）と、下書き・前回値・添付を使うかの別。

- [ ] **Step 1: 失敗する試験を書く**（`SchedulesScreen.test.tsx`）
  - 「新しい会話」でプロジェクトの札、エージェントの札、モデル、effort、権限の札が出る。アカウントが 2 件以上のときだけアカウントの札が出る。
  - 札でモデル `sonnet`、effort `high`、権限 `acceptEdits`、worktree `nightly` を選んで作成すると、`schedule.create` の target にその値が入る。
  - エージェントを Codex に替えて作成すると、target に `worktree` と Claude のモデルが入らない。
  - 権限 Bypass permissions で、作成ボタンが `btn-danger-fill` になり、文言が `schedules.form.createBypass` になる。
  - 既存の予定（全項目付き）を編集で開くと札に値が戻り、何も触らず保存した patch の target が元と同じ。古い形の予定でも同じ。
  - プロジェクトの札でクイックセッションを選ぶと target が `{ projectId: null, scratch: true }`。
  - worktree の札に `-月日-時分` 相当の淡い添えが出る（クラス名で確かめる）。
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: `useLaunchChoice` を切り出し、新規ダイアログの既存の試験を全部緑のまま保つ**
- [ ] **Step 4: `ScheduleForm` を作り替える。** 送り先「新しい会話」で札の列、「既存の会話」で今の select。開け閉めは高さで（既存の `Grow` を使う）。エージェントを替えたときに入れ替わる札をふわっと出す。予定のフォームでは下書き、前回値の行、添付、起動前の準備の箱は出さない。
- [ ] **Step 5: 予定の詳細（`ScheduleRowView`）に、保存した起動設定を読み取り専用の札で並べる。** 未指定の項目は出さない。アカウントは `accountName`。一覧の行でクイックセッションの予定はプロジェクト名の代わりに `schedules.quick`。
- [ ] **Step 6: `npx vitest run packages/ui`、`npm run typecheck`、`npm run build` が通る**
- [ ] **Step 7: コミット**

### Task 4: 文面と実物の確かめ（オーケストレータ）

- [ ] 新しく足した文（i18n のキー、MCP の説明）を Gemini に当てて差し替える。
- [ ] Windows のこの PC で build し、hangar を開き直して、予定の画面を自分で撮る。3 つのエージェントで予定を作り、保存、開き直し、編集を確かめる。
- [ ] 1 回だけの予定を 2 分後にして流し、起きた会話のモデル、effort、アカウント、権限、worktree の名前を確かめる。
- [ ] PR を作り、CI が緑ならマージする。
