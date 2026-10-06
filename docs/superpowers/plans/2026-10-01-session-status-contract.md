# セッションの状態：3 段の計画で共有する名前と型

仕様書は `docs/superpowers/specs/2026-10-01-session-status-design.md` である。
3 つの計画（`-1-data.md`、`-2-screens.md`、`-3-proposals.md`）は、ここに書いた名前と型を変えずに使う。
変えるときは、この文書と 3 つの計画を同時に直す。

## 段の範囲

- 1 データと入口
  - `session_states` の表、マイグレーション v13（一括 Done を含む）、状態の移り方
  - 新しい発言で印なしに戻すこと
  - DTO、同期（Worker の表の一覧を含む）
  - MCP の `propose_session_status`
  - HTTP の 3 つ（PUT state・confirm・reject）
  - UI：行の札、「⋯」の 4 択、Paused の入力（B1）、提案のポップ（Q3＋Q1）
- 2 画面
  - 節分けの関数、プロジェクト画面（P3）、Sessions 画面（★：タブ・節・トークン）
  - Home（今日戻る・確かめる）
  - Archived の淡い表示
- 3 提案の入口
  - 指示の注入、事後の要約の提案（claude.zsh の問いと by-provider の入口は 2026-10-02 にやめた）

## shared（`packages/shared/src/sessionState.ts`、index から再輸出）

```ts
export type SessionStatus = 'paused' | 'done' | 'archived';
export type StateSetBy = 'user' | 'conversation' | 'import';
export type CandidateSource = 'in_session' | 'exit' | 'post_hoc';
export type SessionCandidateDto = { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; at: number };
export type SessionStateDto = { status: SessionStatus | null; note: string | null; returnOn: string | null; setBy: StateSetBy | null; setAt: number | null; candidate: SessionCandidateDto | null };
export const STATE_NOTE_MAX = 200;
/** YYYY-MM-DD の形で、暦に実在する日なら true。 */
export function isReturnOn(s: string): boolean;
/** 手元の暦の日付（YYYY-MM-DD）。 */
export function localDate(now: number): string;
/** YYYY-MM-DD に n 日足した日付。 */
export function addDays(date: string, n: number): string;
/** 戻る日が今日か過ぎていれば、過ぎた日数（今日なら 0）。先なら null。 */
export function overdueDays(returnOn: string, now: number): number | null;
```

- `SessionDto` に `state?: SessionStateDto | null` を足す（`packages/shared/src/api.ts`）。欠けたもの・null は印なしとして読む。
- `SHARED_TABLES` の `'session_summaries'` の直後に `'session_states'` を足す。`TABLE_PK.session_states = 'session_id'` とする（`packages/shared/src/cloud.ts`）。

## server（`packages/server/src/sessions/states.ts`）

```ts
export class StateInputError extends Error {}   // message はトーストにそのまま出せる日本語の一文
export function getSessionState(db: Db, sessionId: string): SessionStateDto | null;
export function setSessionState(db: Db, deviceId: string, sessionId: string, o: { status: SessionStatus | null; note?: string | null; returnOn?: string | null; setBy: 'user' | 'conversation'; now?: number }): SessionStateDto;
export type ProposeStateOutcome = 'proposed' | 'set' | 'rejected_before' | 'already_set';
export function proposeSessionState(db: Db, deviceId: string, sessionId: string, o: { status: 'paused' | 'done'; note: string; returnOn: string | null; source: CandidateSource; now?: number }): { state: SessionStateDto; outcome: Exclude<ProposeStateOutcome, 'set'> };
export function confirmSessionState(db: Db, deviceId: string, sessionId: string, o?: { returnOn?: string; now?: number }): { state: SessionStateDto; result: 'confirmed' | 'not_candidate' };
export function rejectSessionState(db: Db, deviceId: string, sessionId: string, now?: number): { state: SessionStateDto; result: 'rejected' | 'not_candidate' };
/** 利用者の新しい発言（promptTs）で古くなったものを外し、何か外したら true を返す。提案と却下の印は、発言がそれぞれの時刻より後なら外す。状態は、発言が set_at より後で、かつ processStartOf の返す起動時刻も set_at より後（resume した後の発言）のときだけ外す。 */
export function clearOnNewPrompt(db: Db, deviceId: string, sessionId: string, promptTs: number, processStartOf: () => number | null): boolean;
```

- 検査：paused は returnOn が必須（`isReturnOn`）、note は trim 後 200 字まで（提案では 1 字以上が必須）。違反は `StateInputError` にする。
- 変更のたびに、呼び手が `session.upsert` を配る（既存のセッションを配る手立てに乗る）。

## HTTP（MCP からは呼べない）

- `PUT /api/sessions/:id/state`：本文は `{ status: SessionStatus | null; note?: string; returnOn?: string }`。setBy は `user`。
- `POST /api/sessions/:id/state/confirm`：本文は `{ returnOn?: string }`。提案がなければ 409。
- `POST /api/sessions/:id/state/reject`：提案がなければ 409。
- 第 3 段で足す：`POST /api/sessions/by-provider/:providerSessionId/state`（本文は PUT と同じ）。
- 第 3 段で足す：`GET /api/sessions/by-provider/:providerSessionId/exit-prompt`。claude.zsh が読む 3 行の text/plain を返す（1 行目 `ask` か `skip`、2 行目は頭に出す提案、3 行目は理由の下書き）。
- 第 3 段で、第 1 段の PUT の本体を `putSessionState(c, id)` に切り出し、by-provider の POST と共用する。
- どれも成功したら 200 で `{ state: SessionStateDto }` を返す。400・404・409 の本文は `{ error: '<日本語の一文>' }`（既存の作法に合わせる）。

## MCP

- `propose_session_status({ session_id?, status: 'done' | 'paused', note, return_on?, confirmed? })`
  - 戻り値は `{ outcome: ProposeStateOutcome; state }`。
  - `confirmed: true` なら `setSessionState(..., setBy: 'conversation')` で、outcome は `set`。

## UI

- Intent（`packages/shared/src/intent.ts`）
  - `{ type: 'session.state.set'; id: string; status: SessionStatus | null; note?: string; returnOn?: string }`
  - `{ type: 'session.state.confirm'; id: string; returnOn?: string }`
  - `{ type: 'session.state.reject'; id: string }`
  - `{ type: 'session.pause.open'; id: string; from: 'menu' | 'candidate' }`
  - `{ type: 'session.pause.close' }`
- 作用：`api.setSessionState`・`api.confirmSessionState`・`api.rejectSessionState`。
- `deps.api` に `setSessionState(id, body)`・`confirmSessionState(id, body)`・`rejectSessionState(id)` を足す。
- `SessionRowProps` に `state: SessionStatus | null`、`returnOn: string | null`、`overdueDays: number | null`、`candidate: { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; ago: string } | null`、`setBy: StateSetBy | null` を足す。
- 第 2 段で足す：
  - `packages/ui/src/presenters/sections.ts` の `sectionRows(rows, kind: 'project' | 'sessions', o: { now: number; doneHead: number; expanded: Set<string> }): ListItem[]`
  - `ListItem = { kind: 'row'; row: SessionRowProps } | { kind: 'head'; id: SectionId; label: string; count: number; more?: { label: string; target: SectionId } }`
  - `SectionId = 'returning' | 'proposed' | 'live' | 'continue' | 'paused' | 'none' | 'done' | 'archived'`
  - `packages/shared/src/searchTokens.ts` の `parseQuery(text): { text: string; filter: Partial<SearchFilter> }` と `formatQuery(text, filter): string`
  - `SearchFilter` に `status?: SessionStatus | 'none' | 'active' | 'proposed'` を足す。

## 計画を書いた後に足したもの（2026-10-01）

- 第 1 段
  - 便利な関数を足した：`states.ts` の `toStateDto`・`StateCols`・`NO_STATE`、`normalize.ts` の `isTypedPrompt`、`apply.ts` の `sessionIdOfChange`、`row.ts` の `returnOnLabel`・`candidateLabel`、`presenters/pause.ts`。
  - `MenuButton` に `kbd` と `head` を、Overlay に `pause` を足した。
  - 状態のあるセッションへの提案は、状態が同じでも違っても `already_set` を返して書かない。
  - 一括 Done の行は `updated_at = 0`、`origin_device = 'import'` にする。後から上げた PC の一括 Done が、手で付けた状態に同期で勝たないためである。
  - 新しい発言に数えないもの：要約で続けた会話の頭（`isCompactSummary`）と、中断の印。
- 第 2 段
  - `parseQuery`／`formatQuery` に省ける第 3 引数 `projects` を足した。`queryTokens` と `badTokens` も足した。
  - `sessions.tab` は作らず、`search.filter { status }` で兼ねる。`search.query` に `filter?` を、Intent に `project.section.toggle` を足した。
  - `SearchParamsDto` に `status` と `hideArchived`、型 `StatusFilter` を足した。
  - Done の節は、Done にした時刻（`setAt`）の新しい順に並べる。確定した行を Done の先頭へ出すためである。
- 第 3 段
  - 上の HTTP の節に書いた、by-provider の GET（exit-prompt）と `putSessionState` の切り出し。
  - `ensureShellScript(home, port?)`。鍵は `statusline-header` を `curl -H @file` で読む（argv に載せない）。
  - `SummaryOutput.proposal?: SummaryProposal` を足した。

## 2026-10-02 にやめたもの

- main の claude.zsh が作り直され、ターミナルの claude も hangar の run（指示と MCP が渡る）になった。
- 利用者の決定で、claude.zsh で抜けるときの問い（第 3 段 Task 3）と、それ用の by-provider の 2 つの入口（第 3 段 Task 2）をやめた。
- 実装した 2 つの commit（45da99c と 136b3c1）は revert した（1ebc165 と db4328c）。
- CandidateSource の 'exit' は型に残るが、書き手はいない。
