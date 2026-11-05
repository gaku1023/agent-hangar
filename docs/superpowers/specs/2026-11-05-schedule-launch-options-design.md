# 予定の起動設定（新規ダイアログの項目を全部）

## 意図

予定（#549）の「新しい会話」では、プロジェクトとエージェントしか選べない。
モデル、effort、アカウント、権限モードなどは既定で起動するため、たとえば「毎晩 sonnet で軽く点検」「仕事のアカウントで毎週の依存の点検」が組めない。
新規ダイアログで選べる起動の項目を、予定でも全部選べるようにする。

## 目標

- 予定の「新しい会話」で、新規ダイアログと同じ項目を選べる。
  - 共通：エージェント、プロジェクト（クイックセッションを含む）、名前
  - Claude Code：アカウント、モデル、effort、権限モード、worktree、追加ディレクトリ
  - Codex：アカウント、モデル、effort、権限（read-only、auto、full-access）
  - opencode：モード、モデル、自動承認
- 札を出す条件は新規ダイアログと同じにする。アカウントの札は 2 件以上あるときだけ出す。エージェントを替えると、そのエージェントの札に入れ替える。Bypass permissions と Codex の full-access は赤い札にする。
- 予定を開いた詳細に、保存した起動設定を読み取り専用の札で並べる。
- MCP の `create_schedule` と `update_schedule` でも同じ項目を渡せる。

## 目標としないこと

- 既存の会話へ送る予定は変えない。その会話の設定のまま動く。
- 添付ファイルは予定に入れない。
- 「前回と同じ設定」の行（prev-line）と下書きは予定のフォームに持ち込まない。
- スマホ版には予定の画面が無いので触らない。

## してはいけないこと

- 保存した値を黙って捨てたり、別の値で起動したりしない。消えたアカウント、使えなくなったエージェント、無いモデルで起動できないときは、その回を失敗にして理由を履歴に出す。
- エージェントに合わない項目（Codex に worktree など）を保存しない。サーバも断る。

## 決まったこと（利用者）

- 見た目は試作の**案 A**：今のフォームの並び（指示 → いつ → 送り先）のまま、送り先が「新しい会話」のときに、select の代わりに新規ダイアログの札の列（`LaunchChips`）を出す。既存の会話を選ぶと札の列が畳まれ、会話の select が開く。試作は `docs/superpowers/specs/2026-11-05-schedule-launch-options/schedule-launch.html`。
- 繰り返す予定で worktree を指定したら、回ごとに名前へ日時を付けて新しく作る（例：`deps-audit-1105-0900`）。札は `deps-audit` の後に淡い `-月日-時分` を添えて、回ごとに変わることを配置で示す（説明文は足さない）。
- プロジェクトの札は新規ダイアログと同じにする（利用者：「プロジェクトの検索とか、細かい部分も、新しいセッションつくるときの UI もおなじでいい」）。検索、まとまり、クイックセッション、ほかの PC の札、新しいフォルダと未登録のフォルダの行もそのまま出す。フォルダを選んだ予定は、保存するときにプロジェクトを登録（新規ダイアログの起動と同じ道筋）してから、その projectId で保存する。登録済みのプロジェクトの下のフォルダ（cwd）は、予定に `cwd` として保存し、起動時に渡す。
- MCP の `create_schedule` と `update_schedule` でも、確認なしに動く設定（Bypass permissions、Codex の full-access、opencode の自動承認）を通す。`create_session` と同じく何でも渡せる。

## 私（設計者）の判断

- アカウントを選んでいない予定は、実行するときにいま選んでいるアカウントで起動する（`store.current()`）。ただし札が出る（2 件以上ある）ときは、新規ダイアログと同じく選んだ id を必ず保存する。
- worktree の日時は、その回の予定時刻（`plannedAt`）の手元の時刻で `MMDD-HHmm`。1 回だけの予定にも付ける（札の見た目をそろえるため）。
- 起動の経路は今と同じ MCP の `createSessionTool` を通す。足りない 2 点（Codex のアカウント、opencode の自動承認）は `createSessionTool` に足し、MCP の `create_session` も同時に受けられるようにする。
- 予定の行の DB は `target` を JSON で持っているので、表は変えない（マイグレーション無し）。古い行は新しい項目が無いだけで、そのまま読める。ただし `ScheduleTarget.new.projectId` を null にできるようにするので、保存・読み出し・画面の `projectName` までは手直しが要る。
- クイックセッションの予定は、行の `project_id` を null にする。一覧で `projectName` の代わりに「クイックセッション」と出す。プロジェクトで絞り込む一覧（`list_schedules` の projectId 付き）には出さない。MCP では共通の URL からだけ作れ（`scratch: true`）、プロジェクトを固定した URL からは断る。
- アカウントは、保存した id で引く（起動時に名前では引かない）。id が無くなっていたら、その回を失敗にする。未指定の予定だけ `store.current()` に落ちる。Codex のアカウントの組を引けるよう `ToolDeps` に Codex の store を足す（`boot/runs.ts` の `codexAccountStore`）。
- 会話の名前は回ごとに変えない（指定があればそのまま、無ければ今と同じく指示の頭）。日時を付けるのは worktree の名前だけ。
- worktree の日時は、遅れて走った回でも元の予定時刻（`schedule_runs.planned_at`）で付ける。名前が既にある worktree と重なったら、その回を失敗にして理由を出す（5 分おきが最短なので、ふつうは重ならない）。
- モデルや effort が実在するかは保存時には調べず、起動時の既存の検査（`runs.start`、opencode の無いモデルの断り）に任せる。保存時に調べるのは、エージェントに合わない項目と、projectId と scratch の矛盾だけ。

## 形

### 共有の型（`packages/shared/src/schedule.ts`）

`ScheduleTarget` の `new` を広げる。項目名は `LaunchParams`（`action.ts`）にそろえる。

- `projectId: string | null` … null はクイックセッション（`scratch`）。
- 任意：`agent`、`name`、`account`、`model`、`effort`、`permissionMode`、`worktree`、`addDirs`、`mode`、`autoApprove`。

`ScheduleDto` には、詳細の札に出すため、アカウントの表示名（`accountName: string | null`）を足す。

### サーバ

- 保存（HTTP の routes/schedules.ts と MCP の scheduleTools.ts）：エージェントに合わない項目は、`createSessionTool` と同じ文で断る。projectId が null で scratch でない、のような矛盾も断る。
- 起動（`schedule/launch.ts`）：target の項目を `createSessionTool` の引数へ写す。worktree には回の日時を付ける（`launchScheduled` に `plannedAt` を渡す）。名前は、指定があればそれ、無ければ今と同じく指示の頭。
- `createSessionTool`：Codex のときも `account` を受ける（Codex のアカウントの組から引く）。opencode のときは `auto_approve` を受け、`runs.start` に `autoApprove` で渡す。MCP の説明文とスキーマも直す。

### 画面

- `SchedulesScreen` の `ScheduleForm`：送り先が「新しい会話」のとき、プロジェクトとエージェントの select を `LaunchChips` に置き換える。札の中身（アカウントの組、Codex と opencode の選択肢の読み込み、opencode の既定モード）は新規ダイアログと同じ出どころ（`presenters/newSession.ts` と、`codex.options`・`opencode.options`・`accounts.load` の各アクション）から取る。新規ダイアログの中の組み立てを関数に切り出して共有してよい。
- 権限モードが Bypass permissions のときは、作成と保存のボタンを赤くし、文言を「Bypass permissions で作成」「Bypass permissions で保存」にする（新規ダイアログと同じ扱い）。
- 予定の詳細（`ScheduleRowView`）：指示の上に、保存した起動設定を読み取り専用の札で並べる。既定のまま（未指定）の項目は出さない。
- 動き：送り先の切り替えで札の列と会話の select を高さで開け閉めする。エージェントを替えたときは、入れ替わる札をふわっと出す（試作の `chipIn`）。既存のトークン（`--dur`、`--ease-out`）を使う。

### 文言

画面に新しく出す文（ボタンの赤い文言、失敗の理由、MCP の説明）は、Gemini に当ててから入れる（決まり）。日本語と英語の両方を足す。

## 受け入れの確かめ

- 3 つのエージェントそれぞれで、全部の項目を選んだ予定を作り、保存、開き直し、編集で値が保たれる。
- 予定を「今すぐ」相当の時刻にして流し、起きた会話のモデル、effort、アカウント、権限、worktree の名前（日時付き）が予定どおりである。Windows の PC で、画面を自分で撮って確かめる。
- 消したアカウントの予定は、その回が失敗になり、履歴に理由が出る。
- MCP の `create_schedule` に model と effort を渡した予定が、その値で起動する。
- 既存の会話へ送る予定と、古い形の予定（agent だけ）が今までどおり動く。

## 作る人に任せること

- `LaunchChips` を予定のフォームに合わせるための props の足し方、共有に切り出す範囲。
- 試験の分け方。
