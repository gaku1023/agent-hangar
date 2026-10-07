# 段 1 PR 1 手元だけの引き算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** UI とサーバと CLI の間だけで閉じる、使われていない口と古い版のための分岐を消し、引き継ぎ一式と Provider のインターフェースを消す。

**Architecture:** 機能は足さない。
消すものごとにタスクを分け、まず「消したあとに成り立つこと」を試験に書いて落ちるのを見てから消す。
型を必須にする変更は、vitest の `expectTypeOf` で型の試験を書き、`npm run typecheck` で赤と緑を確かめる。
試験の書けない純粋な削除は、消した後に `npm run typecheck` と該当の試験を回す。
同期で運ぶ表名と列名、DB のスキーマ、Worker には触らない。

**Tech Stack:** TypeScript、React、Hono、vitest（`expectTypeOf` は expect-type 1.x）。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md`（PR 1 の行、「消すもの」「残す境界」）。
段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md`（D7、D8、D10）。

## Global Constraints

- PR 1 は「手元だけの引き算：使われていない口、Provider のインターフェース、引き継ぎ一式、手元だけで閉じる古い版の分岐」で、入れる条件は無い（spec の PR の表）。
- 各 PR は、それ単独でアプリが動く状態で入れる。
- UI とサーバと CLI は同じ束で配るので、この PR の中では版のずれを考えない。
- 永続する識別子（DB の表名と列名、同期で運ぶ payload、DTO と API の鍵）は改名しない（D8）。
- `sessions.provider` の列と一意の制約、`files.kind` の列、SQL の `provider = 'claude-code'` は残す（D8）。
- 知らない列を捨てる仕組み（`sync/apply.ts` の `tableColumns`）は残す。
- `takeover_requests` の表は v1 のマイグレーション（`packages/server/src/db/migrations.ts`）から消さない。
- 触らないもの：`deleteFile` と Worker の DELETE（PR 6）、殻の `_up_/server-dist` と同梱（PR 2）、互換の版番号（PR 3）、設定の同期（PR 4）、無料枠の見張り（PR 5）。
- Worker は配備せず、実物のクラウドには触らない。
- 画面の見た目は変えない（試作は要らない）。
- 行番号はこのブランチの `2cc4400`（コードは main `b408223` と同じ）で数えた。
  着手の前に main の最新へ合わせ、引用した文と `git grep` で場所を探し直す。
  前のタスクで行がずれるので、行番号は目安とし、引用した文で当てる。
- 作業は main から切った新しい worktree で行い、着手の前に `npm ci` を打つ。
- コマンドはリポジトリの根で 1 本ずつ打つ（git と他のコマンドを `&&` でつながない）。
- 試験は `npx vitest run <ファイルかディレクトリ>`、型は `npm run typecheck`（1 つの包みだけなら `npm run typecheck -w packages/<名前>`）。
- 型の試験は `import { expectTypeOf } from 'vitest'` で書き、実行時には何もしないので `npm run typecheck` で確かめる。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける（`git commit -m "<件名>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`）。
- 文書（`docs/design.md`、`README.md`）は日本語の一文一行で書き、中黒と em ダッシュを使わない。
- コードのコメントは日本語で、周りと同じ密度と書き方にする。
- 公開リポジトリなので、実在の人名、メール、手元のパス、使用量を、コード、試験、文書、コミットに書かない。
- 仕組みが変わったら `docs/design.md` の該当の節も同じタスクで直す。

## Review Focus

- **アカウントが 1 件の端末で、statusline から使用率が届く**：`usage.update` を消しても、ヘッダの計器は `accounts.update` で同じように動く（Task 8 のサーバの試験と presenter の試験で留める）。
- **画面の保存（localStorage の `sv:<id>`）に、消した `summaryOpen` が残っている**：読み戻した状態にも、次の保存にも `summaryOpen` が残らない（Task 3 の runtime の試験で留める）。
- **古いエージェントが MCP の `search_sessions` に `provider` を渡す**：断らずに検索の結果を返す（Task 4 の MCP の試験で留める）。
- **古い端末の pull の束に `takeover_requests` の変更が混ざる**：表に書かずに捨て、同期は止まらない（Task 1 の `apply.test.ts` の試験で留める）。
- **`cloud.json` はあるのに DB に床の行が無く、`joinedAt` も無い**：床なし（手元の本文を全部上げる）にならず、今の時刻を床にする（Task 13 の `server.test.ts` の試験で留める）。

---

### Task 1: 引き継ぎ（takeover）一式を消す

**Files:**
- Modify: `packages/shared/src/cloud.ts:2-12`
- Modify: `packages/shared/src/api.ts:176-177`
- Modify: `packages/shared/src/events.ts:1`、`:33`
- Modify: `packages/shared/src/intent.ts:85`、`:87`
- Modify: `packages/ui/src/mediator/transition.ts:20`、`:33-34`、`:73-74`
- Modify: `packages/ui/src/mediator/types.ts:322`
- Modify: `packages/ui/src/mediator/resumeHere.ts:5`
- Modify: `docs/design.md`（102、180-181、200-202、225、384-385、2456-2459、2599、2679 の付近）
- Modify: `README.md:12`、`:324`
- Test: `packages/shared/src/cloud.test.ts:30-36`
- Test: `packages/shared/src/api.test.ts:1`（import）と末尾
- Test: `packages/server/src/sync/apply.test.ts:358-363` の直後
- Test: `packages/ui/src/mediator/transition.test.ts:4`、`:273-277`、`:1230-1235`

**Interfaces:**
- Consumes: なし。
- Produces: `SharedTable` から `'takeover_requests'` が消え、`SHARED_TABLES` と `TABLE_PK` は 12 表になる。
  `TakeoverPhase`、`TakeoverUpdateDto`、ServerEvent の `takeover.update`、Intent の `session.takeover` と `session.takeover.cancel`、UI の `NOT_YET` と `NOT_YET_INTENTS` が消える。
  Worker（`packages/cloud/src/changes.ts:57`）と偽の Worker（`packages/server/test/fake-cloud.ts:43`）は `SHARED_TABLES` を読むので、次に配備した Worker はこの表の push を断る。
  誰も書かない表なので害は無い。

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/cloud.test.ts` の `it('共有テーブルの主キーは session_summaries と session_states と project_memos だけが違う', …)`（30-36 行）を、次に置き換える。

```ts
  it('共有テーブルは 12 で、主キーは session_summaries と session_states と project_memos だけが違う', () => {
    expect(SHARED_TABLES).toHaveLength(12);
    expect(SHARED_TABLES).not.toContain('takeover_requests');
    expect(Object.keys(TABLE_PK).sort()).toEqual([...SHARED_TABLES].sort());
    expect(TABLE_PK.session_summaries).toBe('session_id');
    expect(TABLE_PK.session_states).toBe('session_id');
    expect(TABLE_PK.project_memos).toBe('project_id');
    expect(TABLE_PK.runs).toBe('id');
  });
```

`packages/shared/src/api.test.ts` の 1 行目を次にする。

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
```

同じファイルの末尾に足す。

```ts
describe('引き継ぎを消した後', () => {
  it('引き継ぎの Intent と ServerEvent は無い', () => {
    expectTypeOf<Extract<Intent, { type: 'session.takeover' | 'session.takeover.cancel' }>>().toBeNever();
    expectTypeOf<Extract<ServerEvent, { type: 'takeover.update' }>>().toBeNever();
  });
});
```

`packages/server/src/sync/apply.test.ts` の `it('知らない表の変更は捨て、同じ束のほかの変更は適用する', …)` の直後に足す（Review Focus の 4 つめ）。

```ts
  it('共有テーブルの一覧から外した takeover_requests の変更は、表に書かずに捨てる', () => {
    const db = openDb(':memory:');
    expect(applyRemoteChange(db, { ...ch({ rowId: 'x', updatedAt: 5 }), tableName: 'takeover_requests' as never }, o)).toBe('skipped');
    expect(db.prepare('select count(*) c from takeover_requests').get()).toEqual({ c: 0 });
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/shared/src/cloud.test.ts packages/server/src/sync/apply.test.ts`
Expected: FAIL。
`toHaveLength(12)` が 13 で落ち、takeover の試験は `NOT NULL constraint failed: takeover_requests.run_id` で投げる（一覧にある間は表へ書きに行く）。

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`toBeNever()` の 2 行で型エラーになる）。

- [ ] **Step 3: shared から引き継ぎを消す**

`packages/shared/src/cloud.ts` の 2 行目から 13 行目を次にする。
一覧の説明に、表が残る理由を 1 行足す。

```ts
export type SharedTable = 'devices' | 'projects' | 'project_roots' | 'sessions' | 'runs' | 'run_tabs' | 'session_summaries' | 'session_states' | 'todos' | 'project_memos' | 'artifacts' | 'artifact_versions';

/**
 * 親から子の順。pull の適用はこの順に並べ替えて外部キーの順序違反を避ける。
 * Worker（packages/cloud/src/changes.ts）はこの一覧に無い表の変更を含む push を断るので、表を足したら Worker も配備し直す。
 * takeover_requests は v1 のマイグレーションに表が残るが、誰も書かないので一覧に入れない。
 */
export const SHARED_TABLES: readonly SharedTable[] = ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'session_states', 'todos', 'project_memos', 'artifacts', 'artifact_versions'];

export const TABLE_PK: Record<SharedTable, string> = {
  devices: 'id', projects: 'id', project_roots: 'id', sessions: 'id', runs: 'id', run_tabs: 'id',
  session_summaries: 'session_id', session_states: 'session_id', todos: 'id', project_memos: 'project_id', artifacts: 'id', artifact_versions: 'id',
};
```

`packages/shared/src/api.ts` の 176-177 行（`export type TakeoverPhase = …` と `export type TakeoverUpdateDto = …`）を消す。

`packages/shared/src/events.ts` の 1 行目の import から `TakeoverUpdateDto, ` を消し、33 行目の `| { type: 'takeover.update'; update: TakeoverUpdateDto }` を消す。

`packages/shared/src/intent.ts` の 85 行目の `| { type: 'session.takeover'; id: SessionId; force: boolean }` と、87 行目の `| { type: 'session.takeover.cancel'; id: SessionId }` を消す。

- [ ] **Step 4: UI から未実装の案内を消す**

`packages/ui/src/mediator/transition.ts` の 20 行目を次にする。

```ts
import type { Input, State, Step } from './types.ts';
```

同じファイルの 33-34 行（`/** フェーズ 4 以降に残る操作だけ。…*/` と `const NOT_YET_INTENTS = new Set(['session.takeover']);`）を消す。

同じファイルの `switch (i.type)` の `default:`（73-74 行）を次にする。

```ts
    default: return { state, effects: [] };
```

`packages/ui/src/mediator/types.ts` の 322 行目の `export const NOT_YET = 'この操作は次のフェーズで実装します';` を消す。

`packages/ui/src/mediator/resumeHere.ts` の 5 行目の ` * 引き継ぎ（session.takeover）はこのフェーズでは実装しないので、ここでは扱わない。` を消す。

`packages/ui/src/mediator/transition.test.ts` の 4 行目の `import { NOT_YET } from './types.ts';` を消す。
同じファイルの `it('次のフェーズの操作はトーストで知らせる', …)`（273-277 行）を消す。
同じファイルの `it('同期の操作は未実装の案内を出さないが、引き継ぎは出す', …)`（1230-1235 行）を次に置き換える。

```ts
  it('同期の操作は未実装の案内を出さない', () => {
    expect(run([intent({ type: 'sync.now' })]).effects.some((e) => (e as { kind: string }).kind === 'toast')).toBe(false);
    expect(run([intent({ type: 'sync.pause', paused: false })]).effects.some((e) => (e as { kind: string }).kind === 'toast')).toBe(false);
  });
```

- [ ] **Step 5: 通るのを確かめる**

Run: `npx vitest run packages/shared packages/server/src/sync packages/ui/src/mediator`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

Run: `git grep -n -i takeover -- packages`
Expected: 残るのは `server/src/db/migrations.ts`（表の定義）、`server/src/db/db.test.ts`（表の一覧）、Step 1 で足した 3 つの試験だけ。

- [ ] **Step 6: 文書を直す**

`docs/design.md` を次のように直す。

- 102 行付近の `   ├─ NewSessionDialog / NewProjectDialog / PromoteDialog / ResolveProjectDialog / TakeoverDialog` から ` / TakeoverDialog` を消す。
- Intent の一覧（180-181 行付近）から `  | { type: 'session.takeover'; id: SessionId; force: boolean }` と `  | { type: 'session.takeover.cancel'; id: SessionId }` の 2 行を消す。
- 200-202 行付近の 3 行（「`session.takeover` と `session.takeover.cancel` は型にあるだけで、…」から「…View からは `session.resumeHere` だけを出す。」まで）を、次の 1 行にする。

```
他端末で動いているセッションに対して View が出すのは `session.resumeHere` だけで、引き継ぎの握手の Intent は持たない（後述）。
```

- 225 行付近の文から「引き継ぎのダイアログは作らなかったので `takeover(sessionId)` は無い。」の 1 文を消す。
- 384-385 行付近の SQL のコメント 2 行を、次の 2 行にする（`create table takeover_requests` 以下は残す）。

```
-- 引き継ぎの握手のために v1 で作った表。握手は作らないと決め、共有テーブルの一覧（SHARED_TABLES）からも外した。
-- 表はマイグレーションに残るが、誰も書かず、同期でも運ばない。
```

- 2456-2459 行付近の 4 行（「**引き継ぎは実装していない。**」から「…誰も書かず誰も出さない。」まで）を、次の 4 行にする。

```
**引き継ぎは作らない。**
2026-09-19 の判断で、ロックの表示と「この PC で再開」までに絞った。
段 1（2026-10-07）で、型、Intent、ServerEvent を消し、`takeover_requests` を共有テーブルの一覧からも外した。
表は v1 のマイグレーションに残るが、誰も書かず、同期でも運ばない。
```

- 2599 行付近の「- 引き継ぎの握手は `takeover_requests` の同期に乗せる設計だが、…」の行を、次にする。

```
- 引き継ぎの握手は作らない。ロックの表示と「この PC で再開」までに絞った（2026-09-19 の判断）。段 1 で型と共有テーブルの一覧からも外した。`EndReason` に `taken_over` は足さない。
```

- 未決事項の「- 引き継ぎの握手。`takeover_requests` を使う設計は…」の行（2679 行付近）を消す。

`README.md` の 12 行目を「実行中のセッションを他端末から奪う「引き継ぎ」は作りません。」にする。
同じファイルの 324 行目を「実行中のまま奪い取る「引き継ぎ」はありません。」にする。

- [ ] **Step 7: コミットする**

```bash
git add packages/shared packages/server/src/sync/apply.test.ts packages/ui/src/mediator docs/design.md README.md
```

```bash
git commit -m "refactor: remove the takeover handshake types and its shared-table entry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Provider のインターフェースを消す

**Files:**
- Modify: `packages/server/src/provider/types.ts:1`、`:26-34`
- Modify: `packages/server/src/provider/claude-code/index.ts:1-9`
- Modify: `docs/design.md`（13-14、47、315、500、518-538、1195、2519、2678 の付近）
- Test: `packages/server/src/provider/claude-code/index.test.ts`（変えずに使う、フォークの UUID の検査を留める既存の試験）

**Interfaces:**
- Consumes: なし。
- Produces: `interface Provider` が消える。
  `DiscoveredFile`、`LiveSession`、`LaunchMode`、`LaunchInput` は同じファイルに残る。
  `claudeCodeProvider` は `launchCommand(bin: string, input: LaunchInput): string[]` と `resumeCommand(bin: string, input: Omit<LaunchInput, 'mode'>, session: { providerSessionId: string }, fork: boolean, newSessionUuid?: string): string[]` だけを持つ（`id` は消える）。

純粋な削除なので、先に書く試験は無い。
フォークで UUID が無いときに投げる検査は、既存の `index.test.ts` が留める。

- [ ] **Step 1: 使われていないことを確かめる**

Run: `git grep -n -w Provider -- packages/server packages/shared packages/cli packages/cloud`
Expected: `provider/types.ts`（定義）と `provider/claude-code/index.ts`（`Pick<Provider, …>`）だけ。

Run: `git grep -n "claudeCodeProvider.id" -- packages`
Expected: 何も出ない。

- [ ] **Step 2: インターフェースを消す**

`packages/server/src/provider/types.ts` の 1 行目を次にする（`TranscriptEvent` はインターフェースでしか使っていない）。

```ts
import type { LiveSessionDto } from '@agent-hangar/shared';
```

同じファイルの 26-34 行（`export interface Provider { … }`）と、その前の空行を消す。

`packages/server/src/provider/claude-code/index.ts` の 1-9 行を次にする（10 行目から下はそのまま）。

```ts
import { buildClaudeArgs } from '../../launch/args.ts';
import type { LaunchInput } from '../types.ts';

/**
 * claude の起動コマンドを組み立てる。
 * 走査や本文の読み出しはサーバが各モジュールを直接呼ぶので、ここには持たせない。
 */
export const claudeCodeProvider = {
```

- [ ] **Step 3: 型と試験を回す**

Run: `npm run typecheck -w packages/server`
Expected: PASS。

Run: `npx vitest run packages/server/src/provider packages/server/src/runs`
Expected: PASS（`フォークで新しい UUID が無ければ投げる` を含む）。

- [ ] **Step 4: 文書を Claude 専用の方針に直す**

`docs/design.md` を次のように直す。

- 13-14 行の 2 行（「Codex や OpenCode などの他のコーディングエージェントは、…」「初版で扱う Provider は Claude Code だけである。」）を、次の 2 行にする。

```
対応するエージェントは Claude Code だけである。
2 つ目のエージェントを足すときに、そのときの実際の必要から共通の形を引き出す。
```

- 47 行の「- **Provider 非依存の表示**：」を「- **正規化した形式で描く**：」にする（続く文はそのまま）。
- 315 行の `provider text not null,                         -- 'claude-code' | 'opencode' | ...` のコメントを `-- いまは 'claude-code' だけ。列と一意の制約は残す（D8）` にする。
- 500 行の「`packages/shared` に、Provider 非依存のイベント型を定義する。」を「`packages/shared` に、jsonl の形式に依らないイベント型を定義する。」にする。
- 518-536 行（`## Provider 抽象` から `interface Provider { … }` のコードの閉じまで）を、次にする。

```
## Claude Code に固有の部分

hangar が対応するのは Claude Code だけである（2026-10-07 の決定 D7）。
Claude Code の保存形式と起動方法を hangar に翻訳する部分は、`packages/server/src/provider/claude-code/` と `packages/server/src/launch/args.ts` にある。
以前は Provider のインターフェースを置いていたが、実装していたのは起動の 2 項目だけで、索引はインターフェースを通らずに jsonl を読んでいたので、段 1 で消した。
jsonl の読み、登録、起動の引数を 1 つの塊に集めるのは、後の段で行う。
`sessions.provider` の列と `(provider, provider_session_id)` の一意の制約は、永続する識別子なので残す（D8）。
```

- 538 行の `### Claude Code Provider` を `### 保存先と読み方` にする。
- 1195 行の「絞り込みはプロジェクト、期間、Provider、状態（…）」から「Provider、」を消す（その絞り込みは画面にも API にも無い）。
- 2519 行の「- Provider の第二弾は OpenCode で、…」の行を消す。
- 2678 行の「- OpenCode Provider の詳細設計。…」の行を消す。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/provider docs/design.md
```

```bash
git commit -m "refactor(server): drop the unused Provider interface" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 画面の使われていない口を消す（要約の開閉、未実装の知らせ、同期の状態と端末の一覧の取得）

**Files:**
- Modify: `packages/shared/src/intent.ts:90`
- Modify: `packages/ui/src/mediator/sessionView.ts:4`、`:155`
- Modify: `packages/ui/src/mediator/types.ts:157`、`:189`
- Modify: `packages/ui/src/mediator/overlay.ts:5`、`:12`
- Modify: `packages/ui/src/presenters/session.ts:36`、`:296`、`:392-393`
- Modify: `packages/ui/src/runtime/runtime.ts:653-654`
- Modify: `packages/ui/src/runtime/api.ts:1`、`:86`、`:98`、`:192`、`:201`
- Modify: `packages/ui/src/test/fakeApi.ts:10`、`:72`、`:83`
- Modify: `docs/design.md`（185、228 の付近）
- Test: `packages/shared/src/api.test.ts` 末尾
- Test: `packages/ui/src/mediator/transition.test.ts:1`、`:3`、`:239-243` と末尾
- Test: `packages/ui/src/presenters/presenters.test.ts:1`、`:17`、`:435-438`、`:1689-1693`
- Test: `packages/ui/src/views/SessionScreen.test.tsx:14`、`:804`
- Test: `packages/ui/src/runtime/runtime.test.ts:35`、`:43`、`:347` の後
- Test: `packages/ui/src/runtime/api.test.ts:1`、`:3`、`:98-116`

**Interfaces:**
- Consumes: なし。
- Produces: Intent の `summary.toggle`、`SessionViewState.summaryOpen`、`SessionProps.summaryOpen`、Overlay の `{ kind: 'notYet'; feature: string }`、`ApiClient.syncStatus` と `ApiClient.devices` が消える。
  サーバの `GET /api/sync/status`（CLI が使う）と `GET /api/devices` は残す。

事前に確かめたこと：`summary.toggle` を出す View は無い。
`SessionScreen.tsx` の要約の欄（`SummaryPanel`）は `summaryOpen` を読まず、いつも出ている。
`notYet` のオーバーレイを開く経路は無く、`overlay.ts:12` の判定でしか読まれていない。
`syncStatus()` と `devices()` を呼ぶのは試験だけで、画面は bootstrap と websocket の `sync.status` と `devices.update` で受け取る。

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/api.test.ts` の vitest の import に `expectTypeOf` が無ければ足し、末尾に足す。

```ts
describe('使われていない Intent を消した後', () => {
  it('要約の開閉の Intent は無い', () => {
    expectTypeOf<Extract<Intent, { type: 'summary.toggle' }>>().toBeNever();
  });
});
```

`packages/ui/src/mediator/transition.test.ts` の 1 行目と 3 行目を次にする。

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
```

```ts
import type { Input, Overlay, SessionViewState } from './types.ts';
```

同じファイルの `it('思考と生 JSON と追従の切り替えを保存する', …)`（239-243 行）を次に置き換える。

```ts
  it('思考と生 JSON と追従の切り替えを保存する', () => {
    const { state, effects } = run([intent({ type: 'transcript.showThinking', sessionId: 's1', show: true }), intent({ type: 'transcript.showRaw', sessionId: 's1', show: true })]);
    expect(state.sessionView.s1).toMatchObject({ showThinking: true, showRaw: true, follow: true });
    expect(effects[0]).toMatchObject({ kind: 'storage.save', key: 'sv:s1' });
  });
```

同じファイルの末尾に足す。

```ts
describe('使われていない口を消した後', () => {
  it('未実装の知らせのオーバーレイと、要約の開閉は持たない', () => {
    expectTypeOf<Extract<Overlay, { kind: 'notYet' }>>().toBeNever();
    expectTypeOf<SessionViewState>().not.toHaveProperty('summaryOpen');
  });
});
```

`packages/ui/src/presenters/presenters.test.ts` の 1 行目を `import { describe, expect, expectTypeOf, it } from 'vitest';` にし、17 行目を次にする。

```ts
import { buildItems, presentSession, sessionActions, type SessionProps } from './session.ts';
```

同じファイルの 435 行の `sessionView: { s1: { ...defaultSessionView(), showThinking: true, showRaw: true, summaryOpen: true } }` から `, summaryOpen: true` を消し、438 行の `expect(q.summaryOpen).toBe(true);` を消す。
同じ `it` の最後に次を足す。

```ts
    expectTypeOf<SessionProps>().not.toHaveProperty('summaryOpen');
```

同じファイルの `it('注記を出し、要約を開き、既定のままなら延ばす手を添える', …)`（1689 行付近）の名前を `'注記を出し、既定のままなら延ばす手を添える'` にし、`expect(p.summaryOpen).toBe(true);` の行を消す。

`packages/ui/src/views/SessionScreen.test.tsx` の 14 行の `base` から `summaryOpen: false, ` を消し、804 行の `props` から `summaryOpen: true, ` を消す。

`packages/ui/src/runtime/runtime.test.ts` の `it('セッション表示の一時状態を保存し、起動時に読み戻す', …)`（339-347 行）の直後に足す（Review Focus の 2 つめ）。

```ts
  it('古い保存に残る summaryOpen は、読み戻すときに捨て、書き戻さない', () => {
    const b = harness();
    b.store.set('sv:s1', { showThinking: true, summaryOpen: true });
    b.rt.start();
    expect(b.rt.getState().sessionView.s1).toMatchObject({ showThinking: true });
    expect(b.rt.getState().sessionView.s1).not.toHaveProperty('summaryOpen');
    b.rt.emit({ type: 'transcript.showRaw', sessionId: 's1', show: true });
    expect(b.store.get('sv:s1')).not.toHaveProperty('summaryOpen');
  });
```

`packages/ui/src/runtime/api.test.ts` の 1 行目と 3 行目を次にする。

```ts
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
```

```ts
import { ApiConflictError, createApi, RetentionConflictApiError, type ApiClient } from './api.ts';
```

同じファイルの `describe('フェーズ 4 の同期の経路', …)` の最初の `it`（99-116 行）を次に置き換える。

```ts
  it('経路とメソッドと本文が合っている', async () => {
    const { api, calls } = harness();
    await api.syncNow();
    await api.syncPause(true);
    await api.resumeHere('s1', false);
    await api.joinToken();
    await api.configPreview();
    await api.configPull();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/sync/now', 'POST /api/sync/pause',
      'POST /api/sessions/s1/resume-here', 'GET /api/sync/joinToken',
      'GET /api/sync/config/preview', 'POST /api/sync/config/pull',
    ]);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({ paused: true });
    expect(JSON.parse(String(calls[2]!.body))).toEqual({ overwrite: false });
  });
  it('同期の状態と端末の一覧は bootstrap と websocket で届くので、取りに行く口を持たない', () => {
    expectTypeOf<ApiClient>().not.toHaveProperty('syncStatus');
    expectTypeOf<ApiClient>().not.toHaveProperty('devices');
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts -t summaryOpen`
Expected: FAIL（`defaultSessionView()` が `summaryOpen` を持っている）。

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`summary.toggle` の `toBeNever()`）。

Run: `npm run typecheck -w packages/ui`
Expected: FAIL（`notYet`、`summaryOpen`、`syncStatus`、`devices` の型の試験の行）。

- [ ] **Step 3: 要約の開閉を消す**

`packages/shared/src/intent.ts` の 90 行目を次にする。

```ts
  | { type: 'summary.regenerate'; sessionId: SessionId }
```

`packages/ui/src/mediator/sessionView.ts` の 4 行目を次にする。

```ts
  return { agentId: null, showThinking: false, showRaw: false, follow: true, selectedTab: null, transcriptOpen: true, split: false, splitTab: null, livePaneSplit: null, openTurn: null, turnJump: null, find: null, jump: null };
```

同じファイルの 155 行目の `case 'summary.toggle': …` を消す。

`packages/ui/src/mediator/types.ts` の 189 行目を次にする。

```ts
  agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null;
```

`packages/ui/src/presenters/session.ts` の 36 行目の `SessionProps` から `summaryOpen: boolean; ` を消す。
同じファイルの 296 行目の `base` から `summaryOpen: view.summaryOpen, ` を消す。
同じファイルの 392-393 行（`// 本文が消えた会話では、残っている要約を最初から開いて見せる。` と `gone, summaryOpen: gone ? true : view.summaryOpen,`）を次の 1 行にする。

```ts
    gone,
```

`packages/ui/src/runtime/runtime.ts` の `start()` の中の 653-654 行を次にする。

```ts
        // follow は残さない決まりだが、古い保存に残っていることがある。読み戻すときに落として既定（真）に戻す。
        // summaryOpen は使われていない欄として消した。古い保存に残っているので、読み戻すときに捨てる（捨てないと次の保存で書き戻る）。
        const { follow: _ignore, summaryOpen: _gone, ...rest } = v as Partial<SessionViewState> & { summaryOpen?: unknown };
```

- [ ] **Step 4: 未実装の知らせのオーバーレイを消す**

`packages/ui/src/mediator/types.ts` の 157 行目を次にする。

```ts
  | { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' }
```

`packages/ui/src/mediator/overlay.ts` の 5 行目と 12 行目を次にする。

```ts
 * 何も出ていないとき、パレット、読むだけのダイアログ（キーの一覧、昇格の完了）である。
```

```ts
  return o.kind === 'none' || o.kind === 'palette' || o.kind === 'shortcuts' || o.kind === 'promoted';
```

- [ ] **Step 5: 同期の状態と端末の一覧の取得を消す**

`packages/ui/src/runtime/api.ts` から次の 4 行を消す。

```ts
  syncStatus(): Promise<SyncStatusBody>;
```

```ts
  devices(): Promise<DeviceDto[]>;
```

```ts
    syncStatus: () => call('/api/sync/status'),
```

```ts
    devices: () => call('/api/devices'),
```

同じファイルの 1 行目の import から `DeviceDto, ` を消す（`SyncStatusBody` は `syncNow` と `syncPause` が使うので残す）。

`packages/ui/src/test/fakeApi.ts` の 10 行目を次にする。

```ts
  | 'syncUsage' | 'syncNow' | 'syncPause' | 'syncFocus' | 'resumeHere' | 'joinToken' | 'configPreview' | 'configPull'
```

同じファイルの `syncStatus: vi.fn(async () => unused()),`（72 行）と `devices: vi.fn(async () => []),`（83 行）を消す。

`packages/ui/src/runtime/runtime.test.ts` の `harness` の中の `syncStatus: vi.fn(async () => syncStatus),`（35 行）と `devices: vi.fn(async () => []),`（43 行）を消す。

- [ ] **Step 6: 通るのを確かめる**

Run: `npx vitest run packages/shared packages/ui`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

Run: `git grep -n -e summaryOpen -e "summary\.toggle" -e notYet -e "api\.syncStatus" -e "api\.devices" -e "syncStatus(): " -e "devices(): " -- packages/ui/src packages/shared/src`
Expected: 出るのは Step 1 で足した試験と、`runtime.ts` の `summaryOpen` を捨てる行だけ。

- [ ] **Step 7: 文書を直す**

`docs/design.md` の Intent の一覧（185 行付近）の `  | { type: 'summary.toggle'; sessionId: SessionId } | { type: 'summary.regenerate'; sessionId: SessionId }` を `  | { type: 'summary.regenerate'; sessionId: SessionId }` にする。
同じファイルの 228 行付近の「- `sessionView(id)`：開いているタブの列、選択タブ、分割の有無、トランスクリプトペーンの開閉、要約パネルの開閉。」から「、要約パネルの開閉」を消す。

- [ ] **Step 8: コミットする**

```bash
git add packages/shared/src packages/ui/src docs/design.md
```

```bash
git commit -m "refactor(ui): remove the summary toggle, the notYet overlay and the unused sync/devices API calls" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: サーバの使われていない口を消す（sync.applied、MCP の provider 引数、parseBackgroundedId）

**Files:**
- Modify: `packages/shared/src/events.ts:2`、`:32`
- Modify: `packages/server/src/server.ts:816`
- Modify: `packages/server/src/mcp/app.ts:40`
- Modify: `packages/server/src/runs/procs.ts:56-64`
- Modify: `packages/server/src/runs/manager.ts:504-505`、`:509`
- Modify: `docs/design.md`（1041 の付近）
- Test: `packages/shared/src/api.test.ts:64-68` と末尾
- Test: `packages/ui/src/mediator/transition.test.ts:1037-1041`
- Test: `packages/ui/src/store/store.test.ts:260`
- Test: `packages/server/src/mcp/app.test.ts:96` の後
- Test: `packages/server/src/runs/procs.test.ts:3`、`:5-11`

**Interfaces:**
- Consumes: なし。
- Produces: ServerEvent の `{ type: 'sync.applied'; table: SharedTable; rowId: string }` が消える。
  pull で入れ替わった行は、今までどおり `session.upsert`、`project.upsert`、`devices.update` で届く（`server.ts` の `engine.on({ applied })` は残す）。
  MCP の `search_sessions` の入力から `provider` が消える。
  `parseBackgroundedId` が消える。

事前に確かめたこと：`sync.applied` を受けて何かをする所は無い（UI の store と Mediator は状態を変えない）。
`searchSessionsTool`（`mcp/tools.ts:249-255`）は `provider` を読まない。
`parseBackgroundedId` を呼ぶのは試験だけである。
MCP の SDK は入力を zod の既定（知らない鍵を捨てる）で読むので、古い呼び手が `provider` を渡しても断らない。

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/api.test.ts` の `it('同期と端末の ServerEvent がある', …)`（64-68 行）の 2 行を次にする（`status` の行はそのまま）。

```ts
    const evs: ServerEvent[] = [{ type: 'sync.status', status }, { type: 'devices.update', devices: [] }];
    expect(evs.map((e) => e.type)).toEqual(['sync.status', 'devices.update']);
```

同じファイルの vitest の import に `expectTypeOf` が無ければ足し、末尾に足す。

```ts
describe('使われていない ServerEvent を消した後', () => {
  it('sync.applied は無い。pull で変わった行は session.upsert などで届く', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'sync.applied' }>>().toBeNever();
  });
});
```

`packages/server/src/mcp/app.test.ts` の `it('propose_session_status の引数には説明が載る', …)` の直後に足す（Review Focus の 3 つめ）。

```ts
  it('search_sessions は provider を引数に持たず、古い呼び手が渡しても断らない', async () => {
    const list = await rpc('/', 'tools/list', {}, 8);
    const tools = list.body.result!.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    expect(Object.keys(tools.find((t) => t.name === 'search_sessions')!.inputSchema.properties).sort()).toEqual(['file', 'limit', 'project_id', 'query', 'since', 'until']);
    const r = await rpc('/', 'tools/call', { name: 'search_sessions', arguments: { query: 'チャンネル', provider: 'claude-code' } }, 9);
    expect(r.body.result!.isError).toBeUndefined();
    const content = r.body.result!.content as { text: string }[];
    expect(JSON.parse(content[0]!.text).hits.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/mcp/app.test.ts`
Expected: FAIL（引数の一覧に `provider` がある）。

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`sync.applied` の `toBeNever()`）。

- [ ] **Step 3: sync.applied を消す**

`packages/shared/src/events.ts` の 32 行目の `| { type: 'sync.applied'; table: SharedTable; rowId: string }` を消し、2 行目の `import type { SharedTable } from './cloud.ts';` を消す。

`packages/server/src/server.ts` の `engine.on({ … applied: (c) => { … } })` の中の 816 行目 `hub.broadcast({ type: 'sync.applied', table: c.tableName, rowId: c.rowId });` を消す（続く配り直しは残す）。

`packages/ui/src/mediator/transition.test.ts` の `it('sync.applied は Mediator の状態を変えない', …)`（1037-1041 行）を消す。
`packages/ui/src/store/store.test.ts` の 260 行目 `expect(applyServerEvent(s, { type: 'sync.applied', table: 'projects', rowId: 'p1' })).toBe(s);` を消す。

- [ ] **Step 4: MCP の provider 引数を消す**

`packages/server/src/mcp/app.ts` の 40 行目を次にする。

```ts
  reg('search_sessions', D('過去のセッションを全文検索する。題名、要約の 1 文、一致箇所の抜粋、再開コマンドを返す。'), { query: z.string(), project_id: z.string().optional(), since: z.number().optional(), until: z.number().optional(), file: z.string().optional(), limit: z.number().int().positive().optional() });
```

- [ ] **Step 5: parseBackgroundedId と古いコメントを消す**

`packages/server/src/runs/procs.ts` の 56-64 行（`/** \`claude --bg\` の出力からバックグラウンドの id を拾う。…*/` から `parseBackgroundedId` の閉じ括弧まで）と、その前の空行を消す。

`packages/server/src/runs/procs.test.ts` の 3 行目を次にし、5-11 行の `describe('parseBackgroundedId', …)` とその後の空行を消す。

```ts
import { parseJobs, parseProcStart, realProcOps, sameStartTime } from './procs.ts';
```

`packages/server/src/runs/manager.ts` の `adopt` の説明（504-509 行）を直す。
いまの `adopt` は止めたあと `this.resume(s.id)` で hangar の tmux の中で再開し、`--bg` には移さない。
504 行を次にし、505 行（`元のターミナルからも \`claude attach <id>\` で同じ画面に戻れる。`）を消す。

```ts
   * そこで元の claude を SIGTERM で終わらせ、レジストリから消えるのを待ってから、同じ id のまま hangar の tmux の中で再開する（resume と同じ run になる）。
```

509 行を次にする。

```ts
   * 止める前に、本文があるか（再開できるか）を確かめる。止めた後で再開できないと、会話はあるのに claude が居ない状態で終わる。
```

- [ ] **Step 6: 通るのを確かめる**

Run: `npx vitest run packages/shared packages/server/src/mcp packages/server/src/runs packages/ui/src/mediator packages/ui/src/store`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

Run: `git grep -n -e "sync\.applied" -e parseBackgroundedId -- packages`
Expected: 出るのは Step 1 で足した型の試験だけ。

- [ ] **Step 7: 文書を直す**

`docs/design.md` の 1041 行付近の `- \`search_sessions({ query, project_id?, since?, until?, provider?, file? })\`` から `provider?, ` を消す。
歴史の記録（2638 行付近の「`ServerEvent` に `sync.status`、`sync.applied`、`devices.update` を足した。」）は、その時点の記録なので残す。

- [ ] **Step 8: コミットする**

```bash
git add packages/shared/src packages/server/src packages/ui/src docs/design.md
```

```bash
git commit -m "refactor(server): remove sync.applied, the MCP provider argument and parseBackgroundedId" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 未参照の CSS クラスを消す

**Files:**
- Modify: `packages/ui/src/styles/base.css:24`、`:485-487`、`:537`
- Modify: `packages/ui/src/styles/split.css:23-26`
- Modify: `packages/ui/src/styles/rows.css:29-41`
- Modify: `packages/ui/src/styles/controls.css:169-173`

**Interfaces:**
- Consumes: なし。
- Produces: なし（画面は変わらない）。

調べた結果：候補の 9 つのうち、`seg-xs` は使われている。
`Segmented.tsx:50` が `seg-${props.size ?? 'sm'}` で組み立て、`NewSessionDialog.tsx:316` の effort が `size="xs"` を渡すので、消すと effort の 6 つの札が詰まらなくなる。
`seg-xs` は残し、残りの 8 つ（`app-boot`、`dialog-form`、`gauge-wrap`、`hint-link`、`memo-cell`、`seg-live`、`seg-waiting`、`term-status-error`）を消す。
純粋な削除なので、先に書く試験は無い。

- [ ] **Step 1: 使われていないことを確かめる**

Run: `git grep -n -w -e app-boot -e dialog-form -e gauge-wrap -e hint-link -e memo-cell -e seg-live -e seg-waiting -e term-status-error -- packages apps ':!*.css'`
Expected: 何も出ない。

Run: `git grep -n -e 'seg-${' -e 'term-status-${' -e 'memo-${' -e 'dialog-${' -- packages/ui/src`
Expected: `Segmented.tsx` の `seg-${props.size ?? 'sm'}` だけ（`seg-sm` と `seg-xs` を作る）。

- [ ] **Step 2: 規則を消す**

`packages/ui/src/styles/base.css` から次を消す。

```css
.app-boot { display: grid; place-items: center; height: 100%; color: var(--ink-2); }
```

```css
/* 起動ダイアログは欄をフォームで包む。フォームも中身の段と同じ隙間で縦に並べる。 */
.dialog-form { display: flex; flex-direction: column; gap: var(--dialog-gap); }
.dialog-form > * { flex-shrink: 0; }
```

```css
.term-status-error { color: var(--error); opacity: 1; }
```

`packages/ui/src/styles/split.css` の 23-26 行を次の 1 行にする（`.tab-action` の行はそのまま残る）。

```css
/* タブ列の分割ボタン。 */
```

`packages/ui/src/styles/rows.css` の `.memo-cell { … }` と `.memo-cell .muted { … }`（30-41 行）と、その前の空行を消す。

`packages/ui/src/styles/controls.css` の 169-173 行（`/* 状態の帯の「実行中」に添える…*/` から `.seg-waiting { background: var(--waiting); }` まで）を消す。

- [ ] **Step 3: 試験とビルドを回す**

Run: `npx vitest run packages/ui/src/styles packages/ui/src/views`
Expected: PASS。

Run: `npm run build -w packages/ui`
Expected: 成功する（CSS が壊れていない）。

- [ ] **Step 4: コミットする**

```bash
git add packages/ui/src/styles
```

```bash
git commit -m "style(ui): delete unreferenced CSS classes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: サーバの組み立てで、アカウントと使用量の口を必須にする

**Files:**
- Modify: `packages/server/src/http/app.ts:89-95`、`:335-336`、`:358-359`、`:670-673`、`:825`
- Test: `packages/server/src/http/app.test.ts:4`、`:141` の後、`:160-168`、`:978`、`:1022`、`:1144-1147`、`:1428-1435`、`:1447-1456`、末尾

**Interfaces:**
- Consumes: なし。
- Produces: `AppDeps.accounts: AccountsDeps` と `AppDeps.cloudUsage: { current(): CloudUsageDto | null; refresh(): Promise<CloudUsageDto | null> }` が必須になる。
  `/api/bootstrap` はいつも `accounts` を載せ、`cloudUsage` は値が無ければ null になる。
  アカウントの経路（`/api/accounts` など）はいつもある。
  MCP の `get_usage` はいつも `accounts` を返す。
  組み立てる側の `server.ts:867-869` は、もう両方を渡しているので変えない。
  Task 7 と Task 8 は、ここで `accounts` がいつも届くことに頼る。

- [ ] **Step 1: 失敗する試験と、組み立ての道具を書く**

`packages/server/src/http/app.test.ts` の 4 行目を次にする。

```ts
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
```

同じファイルの `syncDeps` の定義（130-141 行）の直後に足す。

```ts
/** 使用量の口。値がまだ無い状態（同期を設定していない端末と同じ）を返す。 */
const noCloudUsage = (): AppDeps['cloudUsage'] => ({ current: () => null, refresh: async () => null });
/** 最初のアカウントだけを持つアカウントの口。サーバはいつもアカウントの口を持つので、どの組み立ても渡す。 */
const primaryOnlyAccounts = (tracker: UsageTracker): AccountsDeps => ({
  db, store: new AccountStore({ home: ws, primaryDir: dir, homeDir: ws }), primaryDir: dir, usage: tracker,
  auth: new AccountAuth({ claudeBin: () => null }),
  runs: { switchAccount: vi.fn() } as unknown as AccountsDeps['runs'],
  broadcast: (a) => sent.push({ type: 'accounts.update', accounts: a }),
});
```

`beforeEach` の `deps = { … }`（160-168 行）の `...syncDeps(),` の直前に次の 1 行を足す。

```ts
    accounts: primaryOnlyAccounts(usage), cloudUsage: noCloudUsage(),
```

978 行と 1022 行の `createApp({ db, deviceId: 'd', … })` の中の `...syncDeps(),` の直前に、それぞれ `accounts: primaryOnlyAccounts(usage), cloudUsage: noCloudUsage(), ` を足す。

`it('cloudUsage が無いサーバの /api/sync/usage は null', …)`（1144-1147 行）の名前を `'使用量がまだ無ければ /api/sync/usage と bootstrap の cloudUsage は null'` にする（中身はそのまま）。

`describe('アカウントの取り付け', …)` の `it('/bootstrap に accounts を載せ、渡さない組み立てでは載せない', …)`（1428-1435 行）を次に置き換える。

```ts
  it('/bootstrap はいつも accounts を載せ、アカウントの経路はいつもある', async () => {
    const withAccounts = (await (await accountsApp.request('/api/bootstrap', { headers: H })).json()) as { accounts: { accounts: unknown[] } };
    expect(withAccounts.accounts.accounts).toHaveLength(2);
    const primaryOnly = (await (await get('/api/bootstrap')).json()) as { accounts: { accounts: { id: string }[] } };
    expect(primaryOnly.accounts.accounts.map((a) => a.id)).toEqual(['primary']);
    expect((await accountsApp.request('/api/accounts', { headers: H })).status).toBe(200);
    expect((await get('/api/accounts')).status).toBe(200);
  });
```

`it('MCP の get_usage は、accounts を渡した組み立てでだけ accounts を返す', …)`（1447-1456 行）の名前を `'MCP の get_usage は、いつも accounts を返す'` にし、最後の行を次にする。

```ts
    expect((await usageOver(app)).accounts?.map((a) => [a.name, a.current])).toEqual([['メイン', true]]);
```

ファイルの末尾に足す。

```ts
describe('組み立ての必須の口', () => {
  it('アカウントと使用量の口は、どの組み立ても必ず渡す', () => {
    expectTypeOf<undefined>().not.toExtend<AppDeps['accounts']>();
    expectTypeOf<undefined>().not.toExtend<AppDeps['cloudUsage']>();
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npm run typecheck -w packages/server`
Expected: FAIL（いまは `undefined` を許しているので、`not.toExtend` の 2 行で型エラーになる）。

Run: `npx vitest run packages/server/src/http/app.test.ts`
Expected: PASS（組み立ての道具が両方を渡すので振る舞いの試験は今の実装でも通り、赤は型の試験が受け持つ）。

- [ ] **Step 3: 必須にして、無いときの分岐を消す**

`packages/server/src/http/app.ts` の `AppDeps` の 89-95 行を次にする。

```ts
  /** 設定の「使用量と費用」。同期を設定していない端末では current() が null を返す。 */
  cloudUsage: { current(): CloudUsageDto | null; refresh(): Promise<CloudUsageDto | null> };
  /** アカウントの一覧と切り替え。組み立てる側（server.ts）が 1 か所で作り、起動後の認証の読み直しにも同じものを使う。 */
  accounts: AccountsDeps;
```

同じファイルの 335-336 行を次にする。

```ts
  const accountsDeps: AccountsDeps = { beforeLaunch, ...deps.accounts };
  accountsRoutes(api, accountsDeps);
```

`/bootstrap` の 358-359 行を次にする。

```ts
      cloudUsage: deps.cloudUsage.current(),
      accounts: buildAccountsDto(accountsDeps, { checkLinks: true }),
```

`/sync/usage` の 670-673 行を次にする。

```ts
  api.get('/sync/usage', async (c) => c.json(c.req.query('refresh') === '1' ? await deps.cloudUsage.refresh() : deps.cloudUsage.current()));
```

`/ingest/statusline` の 825 行を次にする。

```ts
      accountsDeps.broadcast(buildAccountsDto(accountsDeps));
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npm run typecheck`
Expected: PASS。

Run: `npx vitest run packages/server`
Expected: PASS。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/http
```

```bash
git commit -m "refactor(server): require the accounts and cloud usage dependencies" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: bootstrap と同期の付録の任意を外す

**Files:**
- Modify: `packages/shared/src/api.ts:56`、`:169-173`
- Modify: `packages/ui/src/store/store.ts:2`、`:60-85`、`:129`
- Modify: `packages/ui/src/runtime/runtime.ts:252-257`、`:502-504`
- Modify: `packages/ui/src/presenters/settings.ts:104`、`:106`
- Modify: `docs/design.md`（2583 の付近）
- Test: `packages/shared/src/api.test.ts:2`、`:22`、`:40`、`:65` と末尾
- Test: `packages/ui/src/Root.test.tsx:14`
- Test: `packages/ui/src/runtime/runtime.test.ts:11-12`、`:855-869`、`:1055-1065`
- Test: `packages/ui/src/store/store.test.ts:7`、`:203-217`、`:256`、`:263`、`:281`、`:288-300`、`:347-351`、`:361-364`
- Test: `packages/ui/src/mediator/transition.test.ts:1001`
- Test: `packages/ui/src/presenters/cloudUsage.test.ts:18`
- Test: `packages/ui/src/presenters/presenters.test.ts:1388`

**Interfaces:**
- Consumes: Task 6 の、サーバがいつも `accounts` と `cloudUsage` を載せること。
- Produces: `BootstrapDto.cloudUsage: CloudUsageDto | null`、`BootstrapDto.accounts: AccountsDto`、`SyncDetailDto.oncePass: boolean` が必須になる。
  `applySyncStatus` が消え、store は届いた `SyncStatusBody` をそのまま持つ。
  `applyBootstrap` は古いサーバの欠けを埋めなくなる。
  設定画面で `GET /api/accounts` が失敗したら、黙らずにトーストを出す。
  `Store.accounts` は bootstrap の前だけ null のまま。

サーバは、`/api/sync/status`、`/api/sync/now`、`/api/sync/pause`、bootstrap、websocket の `sync.status` のどれにも `oncePass` を `false` か `true` で載せている（`http/app.ts:329`、`server.ts:800`）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/api.test.ts` の 2 行目の import に `SyncDetailDto` を足し、vitest の import に `expectTypeOf` が無ければ足す。
末尾に足す。

```ts
describe('古いサーバのための任意をやめた後', () => {
  it('bootstrap と同期の付録は、どの項目も必ず届く', () => {
    expectTypeOf<BootstrapDto>().toEqualTypeOf<Required<BootstrapDto>>();
    expectTypeOf<SyncDetailDto>().toEqualTypeOf<Required<SyncDetailDto>>();
  });
});
```

`packages/ui/src/runtime/runtime.test.ts` の `it('古いサーバでアカウントの口が無く GET /api/accounts が失敗しても、…', …)`（855-869 行）を次に置き換える。

```ts
  it('GET /api/accounts が失敗したらトーストで知らせ、ほかの取得は進む', async () => {
    const accounts = vi.fn(async () => { throw new Error('500 /api/accounts'); });
    const statusline = vi.fn(async () => ({ command: 'bash statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: true }));
    const { rt, wsHandlers, setHash } = harness({ accounts, statusline });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/settings');
    await flush();
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(rt.getState().toasts.map((t) => t.message)).toContain('500 /api/accounts');
    expect(rt.getStore().statusline?.installed).toBe(true);
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`Required<BootstrapDto>` と `Required<SyncDetailDto>` の行）。

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts -t "GET /api/accounts が失敗したら"`
Expected: FAIL（失敗を握って黙るので、トーストが出ない）。

- [ ] **Step 3: 型を必須にする**

`packages/shared/src/api.ts` の 56 行目の `BootstrapDto` の末尾を `cloudUsage: CloudUsageDto | null; accounts: AccountsDto };` にする（`?` を外す）。

同じファイルの 169-173 行を次にする。

```ts
 * 数えられないときは null になる（同期を設定していない端末）。
 * oncePass は、一時停止のまま利用者が「今すぐ同期」で頼んだ 1 巡の最中かどうかである。
 * そのあいだも state は paused のままなので、進んでいることはこの印でしか分からない。
 */
export type SyncDetailDto = { skipped: SyncSkippedDto[]; sweepPending: number | null; oncePass: boolean };
```

- [ ] **Step 4: store と runtime の古いサーバの分岐を消す**

`packages/ui/src/store/store.ts` の 60-85 行（`applySyncStatus` とその説明、`applyBootstrap`）を次にする。

```ts
/** bootstrap を入れる。
 * runs と tabs だけは差し替えずに混ぜる。
 * サーバが返すのは生きた run と開いたシェルタブが残る run だけなので、
 * 差し替えると、終了した run のスクロールバックを見ている最中に画面が変わってしまう。
 */
export function applyBootstrap(store: Store, b: BootstrapDto): Store {
  return { ...store, bootstrapped: true, version: b.version, device: b.device, settings: b.settings, projects: byId(b.projects), sessions: byId(b.sessions), live: b.live, runs: { ...store.runs, ...byId(b.runs) }, tabs: { ...store.tabs, ...byId(b.tabs) }, index: b.index, usage: b.usage, todos: byId(b.todos), artifacts: byId(b.artifacts), summaryPending: Object.fromEntries(b.summaryPending.map((id) => [id, true as const])), sync: b.sync, devices: b.devices, retention: b.retention, cloudUsage: b.cloudUsage, accounts: b.accounts };
}
```

同じファイルの 129 行を次にする。
届いた値をそのまま持つので、片付いた取り残しと回復した失敗は、次の `sync.status` で画面から消える。

```ts
    case 'sync.status': return { ...store, sync: ev.status };
```

同じファイルの 2 行目の import から `SyncDetailDto, ` を消す。

`packages/ui/src/runtime/runtime.ts` の 252-257 行を次にする。

```ts
          // 同期の状態と端末の一覧は Mediator が持つので、読み込み直すたびに入れ直す。
          // ここで流さないと、次の sync.status が届くまでヘッダの同期表示が空になる。
          dispatch({ kind: 'server', event: { type: 'sync.status', status: b.sync } });
          dispatch({ kind: 'server', event: { type: 'devices.update', devices: b.devices } });
```

同じファイルの 502-504 行を次にする。

```ts
        // アカウントの認証は、この呼び出しで読まれる（節に出るメールとプラン）。
        deps.api.accounts().then(accountsUpdated).catch(fail);
```

`BootstrapDto` が `runtime.ts` で使われなくなったら、import から外す。

`packages/ui/src/presenters/settings.ts` の 104 行と 106 行の `sync.oncePass === true` を `sync.oncePass` にする。
`packages/ui/src/presenters/shell.ts:114` の `store.sync?.oncePass === true` は、bootstrap の前の `store.sync` が null なので、そのまま残す。

- [ ] **Step 5: 試験の固定値を合わせ、古いサーバの試験を消す**

型を必須にしたので、次の固定値に項目を足す。
同期の状態（`SyncStatusBody`）の固定値には `oncePass: false` を足す。
`BootstrapDto` の固定値には、`sync` の中の `oncePass: false` に加えて、`cloudUsage: null, accounts: { currentId: 'primary', accounts: [], sessions: {} }` を足す。

- `packages/shared/src/api.test.ts`：22 行と 40 行（`BootstrapDto`）、65 行（`SyncStatusBody`）。
- `packages/ui/src/Root.test.tsx`：14 行（`BootstrapDto`）。
- `packages/ui/src/runtime/runtime.test.ts`：11 行（`BootstrapDto`）、12 行（`SyncStatusBody`）。
- `packages/ui/src/store/store.test.ts`：7 行（`BootstrapDto`）、256 行、263 行、281 行、290 行（`SyncStatusBody`）。
- `packages/ui/src/mediator/transition.test.ts`：1001 行（`status` の組み立て）。
- `packages/ui/src/presenters/cloudUsage.test.ts`：18 行（`sync` の組み立て）。
- `packages/ui/src/presenters/presenters.test.ts`：1388 行（`syncStatus` の組み立て）。

古いサーバの振る舞いを確かめていた試験を消すか直す。

- `packages/ui/src/store/store.test.ts` の `it('フェーズ 3 の項目を返さないサーバでも、既定値で埋めて画面を立てる', …)`（204-215 行）を消す（同じ `describe` のほかの `it` は残す）。
- 同じファイルの `it('付録を持たない古いサーバの sync.status では、件数を引き継がずに落とす', …)` と `it('sync と devices を持たない古いサーバでも壊れない', …)`（288-300 行）を消す。
- 同じファイルの `it('bootstrap の retention を入れ、欠けていれば null', …)`（347-351 行）の名前を `'bootstrap の retention を入れる'` にし、最後の 2 行（`const { retention: _drop, ...old } = boot;` と `expect(…old as BootstrapDto).retention).toBeNull();`）を消す。
- 同じファイルの `it('bootstrap に accounts が無ければ null、あれば入る', …)`（361-364 行）を次に置き換える。

```ts
  it('bootstrap の accounts をそのまま入れる。届く前は null', () => {
    expect(initialStore().accounts).toBeNull();
    expect(applyBootstrap(initialStore(), { ...boot, accounts: accountsFixture }).accounts).toEqual(accountsFixture);
  });
```

- `packages/ui/src/runtime/runtime.test.ts` の `it('sync を持たない古いサーバの bootstrap では何もしない', …)`（1055-1065 行）を消す。
- `packages/ui/src/presenters/presenters.test.ts` の `it('一時停止のまま 1 回だけ同期している最中は、そのことを言う', …)` の中の、コメント「// 終われば元の文に戻る。印を送らない古いサーバも同じ。」を「// 終われば元の文に戻る。」にし、印の無い `paused({ pausedReason: 'user' })` を読む行（1415 行付近）を消す。

- [ ] **Step 6: 通るのを確かめる**

Run: `npm run typecheck`
Expected: PASS。

Run: `npx vitest run packages/shared packages/ui`
Expected: PASS。

- [ ] **Step 7: 文書を直す**

`docs/design.md` の 2583 行付近の「- 古いサーバの `bootstrap`：フェーズ 3 で増えた項目（…）が欠けていても画面は立つ。…」の行を消す。

- [ ] **Step 8: コミットする**

```bash
git add packages/shared/src packages/ui/src docs/design.md
```

```bash
git commit -m "refactor: make bootstrap and sync detail fields required" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 使用率の二重配信をやめる（usage.update を消し、計器を accounts から作る）

**Files:**
- Modify: `packages/shared/src/events.ts:1`、`:16`
- Modify: `packages/shared/src/api.ts:56`
- Modify: `packages/server/src/http/app.ts:4`、`:350`、`:822-826`
- Modify: `packages/ui/src/store/store.ts:2`、`:20`、`:42`、`:50`、`applyBootstrap`、`:118`
- Modify: `packages/ui/src/presenters/shell.ts:1`、`:179-187`
- Modify: `docs/design.md`（1370、2571 の付近）
- Test: `packages/shared/src/api.test.ts:22`、`:30-35`、`:40` と末尾
- Test: `packages/server/src/http/app.test.ts:776`、`:780`、`:802`、`:1465-1475`
- Test: `packages/ui/src/presenters/presenters.test.ts:3`、`:1131-1157`
- Test: `packages/ui/src/store/store.test.ts:4`、`:7`、`:166-172`、`:180-183`、`:366-371`
- Test: `packages/ui/src/Root.test.tsx:14`
- Test: `packages/ui/src/runtime/runtime.test.ts:11`

**Interfaces:**
- Consumes: Task 6 の、サーバがいつもアカウントの口を持ち、statusline の使用率が変わるたびに `accounts.update` を配ること（`http/app.ts:825`）。
  Task 7 の、`BootstrapDto.accounts` が必須であること。
- Produces: ServerEvent の `usage.update`、`BootstrapDto.usage`、`Store.usage`、`emptyUsage` が消える。
  ヘッダの計器は、アカウントが 1 件以下のとき `currentAccount(store)?.usage` から作る（2 件以上のときは今までどおり）。
  `GET /api/usage`（CLI の認証の確かめが使う）と MCP の `get_usage` は残す。

判断の根拠：`usage.update` は最初のアカウントの使用率だけを運び、同じ値は `accounts.update` の最初のアカウントの `usage` にも載る（`http/accounts.ts` の `buildAccountsDto` が `deps.usage.of(a.id)` を入れる）。
`usage.update` を受けるのは `store.ts:118` だけで、読むのは 1 件以下のときのヘッダの計器（`shell.ts:185`）だけである。
Task 6 でアカウントの口が必須になり、使用率が変わるたびに `accounts.update` が必ず配られるので、`accounts.update` だけで足りる。

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/api.test.ts` の vitest の import に `expectTypeOf` が無ければ足し、末尾に足す。

```ts
describe('使用率の二重配信をやめた後', () => {
  it('usage.update は無く、bootstrap も使用率を別に持たない。アカウントごとの値が accounts に載る', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'usage.update' }>>().toBeNever();
    expectTypeOf<BootstrapDto>().not.toHaveProperty('usage');
  });
});
```

`packages/ui/src/presenters/presenters.test.ts` の 3 行目の型の import に `UsageDto` を足す。
同じファイルの `describe('presentShell の使用量', …)`（1131-1138 行）を次に置き換える（Review Focus の 1 つめ）。

```ts
describe('presentShell の使用量', () => {
  const solo = (usage: UsageDto): Store => ({ ...initialStore(), accounts: { currentId: 'primary', accounts: [{ ...accountsFixture.accounts[0]!, usage }], sessions: {} } });
  it('値が無ければ null、あれば最初のアカウントの百分率と最終更新', () => {
    const empty = presentShell(initialState(), initialStore(), NOW);
    expect(empty.usage).toEqual({ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null });
    const p = presentShell(initialState(), solo({ fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: { usedPercent: 7, resetsAt: null }, updatedAt: NOW - 600_000 }), NOW);
    expect(p.usage).toEqual({ fiveHour: 47, sevenDay: 7, fiveHourResets: null, sevenDayResets: null, updatedLabel: '10 分前' });
  });
});
```

同じファイルの `describe('presentShell のアカウント', …)` の `two` の定義（1141 行）から `, usage: { … }` を消し、`({ ...storeWith(), accounts: accountsFixture })` にする。
同じ `describe` の最初の `it`（1143-1155 行）を次に置き換える。

```ts
  it('アカウントが 1 件なら account は null で、計器はそのアカウントの値から作る。store.accounts が null なら計器も空', () => {
    const u = { fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: { usedPercent: 7, resetsAt: null }, updatedAt: NOW - 600_000 };
    const solo = presentShell(initialState(), { ...storeWith(), accounts: { ...accountsFixture, accounts: [{ ...accountsFixture.accounts[0]!, usage: u }] } }, NOW);
    expect(solo.account).toBeNull();
    expect(solo.usage).toEqual({ fiveHour: 47, sevenDay: 7, fiveHourResets: null, sevenDayResets: null, updatedLabel: '10 分前' });
    const none = presentShell(initialState(), storeWith(), NOW);
    expect(none.account).toBeNull();
    expect(none.usage).toEqual({ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null });
    const empty = presentShell(at({ name: 'session', id: 's1' }), { ...storeWith(), accounts: { currentId: '', accounts: [], sessions: {} } }, NOW);
    expect(empty.account).toBeNull();
    expect(empty.usage).toEqual(none.usage);
  });
```

`packages/server/src/http/app.test.ts` の `it('statusline の受け口と使用量', …)` を次のように直す（Review Focus の 1 つめのサーバの側）。

- 776 行を `expect(sent.filter((e) => e.type === 'accounts.update')).toHaveLength(0);` にする（使用率の無い payload では配らない）。
- 780 行を次にする。

```ts
    expect(sent.find((e) => e.type === 'accounts.update')).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 }, sevenDay: { usedPercent: 7 } } }] } });
```

- 802 行を次にする。

```ts
    expect((await json(await get('/api/bootstrap'))).body).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 } } }] }, todos: [], artifacts: [], summaryPending: ['pending-1'] });
```

同じファイルの `it('使用量は、動かしたアカウントの accounts.update で配り、usage.update は最初のアカウントのときだけ', …)`（1465-1475 行）を次に置き換える。

```ts
  it('使用量は、動かしたアカウントの accounts.update で配る。最初のアカウントも同じ道で届く', async () => {
    sent.length = 0;
    const limits = { rate_limits: { five_hour: { used_percentage: 47, resets_at: 4_000_000_000 }, seven_day: { used_percentage: 7, resets_at: 4_000_100_000 } } };
    expect((await post('/api/ingest/statusline', { session_id: SESSION_ALPHA, ...limits })).status).toBe(204);
    expect(sent.find((e) => e.type === 'accounts.update')).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: null } }, { usage: { fiveHour: { usedPercent: 47 } } }] } });
    sent.length = 0;
    expect((await post('/api/ingest/statusline', { session_id: SESSION_OTHER, ...limits })).status).toBe(204);
    expect(sent.find((e) => e.type === 'accounts.update')).toMatchObject({ accounts: { accounts: [{ id: 'primary', usage: { fiveHour: { usedPercent: 47 } } }, {}] } });
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts -t presentShell`
Expected: FAIL（計器はまだ `store.usage` から作るので、1 件のアカウントの値が出ない）。

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`usage.update` の `toBeNever()` と `not.toHaveProperty('usage')`）。

- [ ] **Step 3: 計器を accounts から作る**

`packages/ui/src/presenters/shell.ts` の 1 行目の import に `type UsageDto` を足す。
同じファイルの 179-187 行（`headerAccount` の説明と、`plain` を作って 1 件以下なら返すまで）を次にする（188 行の `const sessionId = …` から下はそのまま）。

```ts
/** 使用率がまだ届いていないときの値。 */
const NO_USAGE: UsageDto = { fiveHour: null, sevenDay: null, updatedAt: null };

/**
 * ヘッダの計器とアカウントの切り替え。
 * アカウントが 2 件以上あるときだけ切り替えを出し、計器は shown の値から作る。
 * 1 件以下のときは、いまのアカウント（最初のアカウント）の値から作る。使用率は accounts.update だけで届く。
 */
function headerAccount(state: State, store: Store, now: number): { account: HeaderAccountProps; usage: UsageProps } {
  if (!hasMultipleAccounts(store)) {
    const u = usageAt(currentAccount(store)?.usage ?? NO_USAGE, now);
    return { account: null, usage: { fiveHour: u.fiveHour?.usedPercent ?? null, sevenDay: u.sevenDay?.usedPercent ?? null, fiveHourResets: resetsLabel(u.fiveHour?.resetsAt ?? null, now), sevenDayResets: resetsLabel(u.sevenDay?.resetsAt ?? null, now), updatedLabel: u.updatedAt === null ? null : relativeTime(u.updatedAt, now) } };
  }
```

- [ ] **Step 4: usage.update と bootstrap の usage を消す**

`packages/shared/src/events.ts` の 16 行目の `| { type: 'usage.update'; usage: UsageDto }` を消し、1 行目の import から `UsageDto` を消す（ほかで使っていなければ）。

`packages/shared/src/api.ts` の 56 行目の `BootstrapDto` から `usage: UsageDto; ` を消す。

`packages/server/src/http/app.ts` の `/bootstrap` の `usage: deps.usage.current(),`（350 行）を消す。
`/ingest/statusline` の 822-826 行を次にする。

```ts
    // 使用率は、動かしたアカウントの値として accounts.update で配る。最初のアカウントも同じ道で届く。
    if (r.usageChanged) accountsDeps.broadcast(buildAccountsDto(accountsDeps));
```

同じファイルの 4 行目の import から `PRIMARY_ACCOUNT_ID, ` を消す（ほかで使っていなければ）。

`packages/ui/src/store/store.ts` を次のように直す。

- `Store` の 20 行目の `usage: UsageDto; ` を消す。
- 42 行目の `export const emptyUsage = …` を消す。
- `initialStore` の 50 行目の `usage: emptyUsage(), ` を消す。
- `applyBootstrap` の `usage: b.usage, ` を消す。
- `applyServerEvent` の 118 行目の `case 'usage.update': …` を消す。
- 2 行目の import から `UsageDto` を消す（ほかで使っていなければ）。

- [ ] **Step 5: 試験の固定値を合わせる**

`BootstrapDto` の固定値から `usage: { fiveHour: null, sevenDay: null, updatedAt: null }, ` を消す：`packages/shared/src/api.test.ts` の 22 行と 40 行、`packages/ui/src/Root.test.tsx` の 14 行、`packages/ui/src/runtime/runtime.test.ts` の 11 行、`packages/ui/src/store/store.test.ts` の 7 行。

`packages/shared/src/api.test.ts` の `it('UsageDto、TodoDto、MemoDto、ArtifactDto が組み立てられる', …)` の `evs` から `{ type: 'usage.update', usage }, ` を消し、`toHaveLength(7)` を `toHaveLength(6)` にし、`expect(usage.fiveHour?.usedPercent).toBe(47);` を足す。

`packages/ui/src/store/store.test.ts` を次のように直す。

- 4 行目の import から `emptyUsage, ` を消す。
- `it('bootstrap は使用量と TODO とアーティファクトと要約の待ちを入れる', …)`（166-172 行）の名前を `'bootstrap は TODO とアーティファクトと要約の待ちを入れる'` にし、入力の `usage: { … }, ` と `expect(s.usage.fiveHour?.usedPercent).toBe(47);` を消す。
- `it('usage、memo、artifact、要約の待ちのイベントを取り込む', …)` の名前を `'memo、artifact、要約の待ちのイベントを取り込む'` にし、182-183 行（`usage.update` を流す行と `expect(s.usage.sevenDay…` の行）を消す。
- `it('accounts.update は丸ごと入れ替え、ほかの項目は変えない', …)`（366-371 行）の入力から `, usage: { … }` を消し、`expect(after.usage).toBe(before.usage);` を消す。

- [ ] **Step 6: 通るのを確かめる**

Run: `npm run typecheck`
Expected: PASS。

Run: `npx vitest run packages/shared packages/server/src/http packages/ui`
Expected: PASS。

Run: `git grep -n -e "usage\.update" -e emptyUsage -e "store\.usage" -- packages`
Expected: 出るのは Step 1 で足した型の試験だけ。

- [ ] **Step 7: 文書を直す**

`docs/design.md` の 1370 行付近の「計器の値も、そのアカウントの値に替える。」の次に、2 行を足す。

```
アカウントが 1 件のときも、計器はそのアカウント（最初のアカウント）の値から作る。
使用率は `accounts.update` だけで配り、最初のアカウントの値だけを運ぶ別の知らせは持たない（段 1 で `usage.update` を消した）。
```

同じファイルの 2571 行付近の「- `GET /api/bootstrap` は `usage`、`todos`（…）…」を、次にする。

```
- `GET /api/bootstrap` は `accounts`（使用率はアカウントごとにここに載る）、`todos`（全プロジェクトの未削除）、`artifacts`（全件）、`summaryPending`（作成中のセッション ID）も返す。メモの全文は含めない。
```

- [ ] **Step 8: コミットする**

```bash
git add packages/shared/src packages/server/src/http packages/ui/src docs/design.md
```

```bash
git commit -m "refactor: stop broadcasting usage.update and read the header gauge from accounts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: SessionDto と TodoDto の任意を外す

**Files:**
- Modify: `packages/shared/src/api.ts:33-40`、`:134-135`
- Modify: `packages/shared/src/aside.ts:12`
- Modify: `packages/server/src/db/queries.ts:245-246`
- Modify: `packages/ui/src/presenters/session.ts:327`
- Modify: `packages/ui/src/presenters/row.ts:46-47`
- Modify: `packages/ui/src/presenters/pause.ts:40`
- Modify: `packages/ui/src/presenters/project.ts:21-24`
- Modify: `packages/ui/src/store/store.ts:97`、`:225`
- Test: `packages/shared/src/api.test.ts` 末尾、`:31`、`:39`
- Test: `packages/shared/src/aside.test.ts:9`
- Test: `packages/server/src/db/queries.test.ts:299-307`
- Test: SessionDto と TodoDto の固定値（Step 5 の一覧）

**Interfaces:**
- Consumes: なし。
- Produces: `SessionDto` の `activity: SessionActivityDto | null`、`state: SessionStateDto | null`、`parked: boolean`、`stoppedByStatus: boolean`、`liveAside: LiveAsideDto | null` が必須になる（`| null` は残す）。
  `TodoDto.candidate: TodoCandidateDto | null` が必須になる。
  サーバは、実行中でないセッションの `activity` を、欄ごと省かずに `null` で返す。
  `asideOf(live, aside: LiveAsideDto | null)` は `undefined` を受けなくなる。

サーバの側で調べたこと：`SessionDto` を作るのは `db/queries.ts` の `toSessionDto` だけである。
`state`、`parked`、`stoppedByStatus`、`liveAside` はいつも埋めているが、`activity` だけは実行中でないと欄ごと省いている（`...(live ? { activity: … } : {})`）。
`TodoDto` を作るのは `projects/todos.ts` の `toDto` だけで、`candidate` はいつも埋めている。
読む側の `s.state?.status` や `s.activity?.question` の `?.` は、`null` があるので残す。

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/api.test.ts` の vitest の import に `expectTypeOf` が無ければ足し、末尾に足す。

```ts
describe('セッションと TODO の任意をやめた後', () => {
  it('SessionDto と TodoDto は、どの項目も必ず届く', () => {
    expectTypeOf<SessionDto>().toEqualTypeOf<Required<SessionDto>>();
    expectTypeOf<TodoDto>().toEqualTypeOf<Required<TodoDto>>();
  });
});
```

`packages/server/src/db/queries.test.ts` の `it('実行中なら最後の呼び出しと問いを載せ、実行中でなければ欄ごと載せない', …)`（299-308 行）の名前を `'実行中なら最後の呼び出しと問いを載せ、実行中でなければ null'` にし、307 行を次にする。

```ts
    expect(again.find((s) => s.id === beta.id)!.activity).toBeNull();
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/db/queries.test.ts -t activity`
Expected: FAIL（実行中でないセッションの `activity` が `undefined`）。

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`Required<SessionDto>` と `Required<TodoDto>` の行）。

- [ ] **Step 3: サーバがいつも activity を埋める**

`packages/server/src/db/queries.ts` の `toSessionDto` の 245-246 行を次にする。

```ts
    // 最後に呼んだツールと待っている問いは、実行中のときだけ載せる。終わったセッションの古い呼び出しは出さず、null にする。
    activity: live && r.a_tool !== null ? { tool: r.a_tool, summary: r.a_summary ?? '', question: r.a_question } : null,
```

- [ ] **Step 4: 型を必須にし、読む側の欠けの扱いを消す**

`packages/shared/src/api.ts` の 33-40 行を次にする（`SessionDto` の前半の項目はそのまま、末尾の 5 つだけ `?` を外す）。

```ts
/**
 * state はセッションの状態と提案で、null は Active である。
 * parked は、区切りを付けたのにプロセスが休みのまま残っていること（shared の isParked）。真なら画面では実行中に数えない。
 * stoppedByStatus は、区切りを付けたので hangar が Claude を止め、その印がまだ残っていること。
 * liveAside は登録の aside を写したもの（LiveSessionDto）で、無ければ null である。
 * activity は実行中のときだけ値を持ち、実行中でなければ null である。
 */
export type SessionDto = { id: string; provider: 'claude-code'; providerSessionId: string; projectId: string | null; name: string | null; cwd: string; firstPrompt: string | null; aiTitle: string | null; startedAt: number | null; lastActivityAt: number | null; memo: string | null; hasTranscript: boolean; live: LiveStatus | null; summary: SessionSummaryDto | null; stats: SessionStatsDto; fromScratch: boolean; lock: SessionLockDto | null; remoteOnly: boolean; transcriptMtime: number | null; activity: SessionActivityDto | null; state: SessionStateDto | null; parked: boolean; stoppedByStatus: boolean; liveAside: LiveAsideDto | null };
```

同じファイルの 134-135 行を次にする。

```ts
/** candidate は完了の候補で、候補でなければ null。完了の行では必ず null である（サーバが読むときにそろえる）。 */
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number; candidate: TodoCandidateDto | null };
```

`packages/shared/src/aside.ts` の 12 行目を次にする。

```ts
export function asideOf(live: LiveStatus | null, aside: LiveAsideDto | null): LiveAsideDto | null {
```

`packages/shared/src/aside.test.ts` の 9 行目 `expect(asideOf('busy', undefined)).toBeNull();` を消す。

UI の読む側を直す。

- `packages/ui/src/presenters/session.ts:327` の `activity: s.activity ?? null` を `activity: s.activity` にする。
- `packages/ui/src/presenters/row.ts:46-47` を次の 2 行にする。

```ts
  // state が null なら Active として読む。
  const st = s.state;
```

- `packages/ui/src/presenters/pause.ts:40` の `const st = s.state ?? null;` を `const st = s.state;` にする。
- `packages/ui/src/store/store.ts:97` の `sameAside(aside, s.liveAside ?? null)` を `sameAside(aside, s.liveAside)` にする。
- `packages/ui/src/store/store.ts:225` の `session.parked === true` を `session.parked` にする。
- `packages/ui/src/presenters/project.ts` の 24 行目（「完了の行は候補を持たないものとして扱う。サーバは null にして返すが、古いサーバの値でも Home に出さないためである。」）を次にする。
  `if (!c || t.done)` の判定は、同期の競り合いへの守りとして残す（`presenters.test.ts:218` が留めている）。

```ts
 * 完了の行は候補を持たないものとして扱う。サーバも null にして返すが、同期の競り合いで食い違っても Home に出さない。
```

- [ ] **Step 5: 試験の固定値を合わせる**

`SessionDto` の固定値には、無い項目を `transcriptMtime: …,` の直後に足す。
足す値は `activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null` のうち、その固定値に無いものである。
`...over` で上書きする形の固定値も、`...over` より前に入るので上書きは今までどおり効く。

| ファイル:行 | 足すもの |
| --- | --- |
| `packages/shared/src/api.test.ts:39` | 5 つとも |
| `packages/ui/src/Root.test.tsx:19` | 5 つとも |
| `packages/ui/src/presenters/aside.test.ts:14` | 5 つとも |
| `packages/ui/src/presenters/excerpt.test.ts:6` | 5 つとも |
| `packages/ui/src/presenters/homeReturn.test.ts:13` | `state` 以外の 4 つ |
| `packages/ui/src/presenters/palette.test.ts:10` | 5 つとも |
| `packages/ui/src/presenters/pause.test.ts:11` | `state` 以外の 4 つ |
| `packages/ui/src/presenters/presenters.test.ts:28` | 5 つとも |
| `packages/ui/src/presenters/returnTime.test.ts:17` | `state` 以外の 4 つ |
| `packages/ui/src/presenters/sections.test.ts:27`、`:163`、`:183` | `state` 以外の 4 つ |
| `packages/ui/src/presenters/sessionsTabs.test.ts:15` | `state` 以外の 4 つ |
| `packages/ui/src/runtime/runtime.test.ts:672`、`:1140`、`:1208` | 5 つとも |
| `packages/ui/src/store/store.test.ts:6` | 5 つとも |
| `packages/ui/src/views/sidebarLive.test.tsx:15` | 5 つとも |

`TodoDto` の固定値には、`updatedAt: 1` の直後に `candidate: null` を足す。

- `packages/shared/src/api.test.ts:31`
- `packages/ui/src/presenters/presenters.test.ts:840`
- `packages/ui/src/runtime/runtime.test.ts:673`（`p3Todo`）、`:679`（`addTodo` の偽物の戻り値）
- `packages/ui/src/store/store.test.ts:147`
- `packages/ui/src/test/fakeApi.ts:53`、`:54`、`:55`

一覧に無い固定値が型で落ちたら、同じ決まりで足す。

古いサーバの行（項目が欠けた DTO）を確かめていた試験を直す。

- `packages/ui/src/presenters/sessionsTabs.test.ts` の `it('state が欠けた古いサーバの行は Active の節とタブに入る', …)`（74-80 行）を消す（欠けた DTO はもう届かない）。
- `packages/ui/src/presenters/presenters.test.ts` の `it('止めていないセッションと、古いサーバの行（印が欠ける）では出さない', …)`（1816 行付近）の名前を `'止めていないセッションでは出さない'` にする（中身はそのまま通る）。
- 同じファイルの `it('state が欠けた古いサーバの行と null は、Active として読む', …)`（1831 行付近）の名前を `'state が null なら Active として読む'` にする（中身はそのまま通る）。
- 同じファイルの 217 行付近のコメント「…古いサーバや手で作った値でも数えない。」を「…同期の競り合いで食い違っても数えない。」にする。

- [ ] **Step 6: 通るのを確かめる**

Run: `npm run typecheck`
Expected: PASS。

Run: `npx vitest run packages/shared packages/server/src/db packages/server/src/mcp packages/ui`
Expected: PASS。

- [ ] **Step 7: コミットする**

```bash
git add packages/shared/src packages/server/src/db packages/ui/src
```

```bash
git commit -m "refactor: make SessionDto and TodoDto fields required" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: POST /api/projects の kind を必須にする

**Files:**
- Modify: `packages/server/src/http/app.ts:784-792`
- Modify: `docs/design.md`（2557 の付近）
- Test: `packages/server/src/http/app.test.ts:206`、`:226`、`:250`、`:264`、`:689`、`:694`、`:695`、`:697`、`:719-725` の後、`:753`

**Interfaces:**
- Consumes: なし。
- Produces: `POST /api/projects` は `{ kind: 'newDir', name, gitInit }` か `{ kind: 'dir', path, name? }` だけを受け、`kind` の無い本文は 400（`kind は newDir か dir です`）で断る。
  UI の `createProject(place: ProjectPlace)` はいつも `kind` を送っているので変えない。
  ほかに `POST /api/projects` を呼ぶ所（CLI、MCP）は無い。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/http/app.test.ts` の `it('kind が dir なら既存のフォルダを登録し、名前を省けば basename にする', …)` の直後に足す。

```ts
  it('kind の無い本文は断る', async () => {
    fs.mkdirSync(`${ws}/gamma`);
    const r = await postProject({ name: 'gamma', path: `${ws}/gamma` });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('kind は newDir か dir です');
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts -t "kind の無い本文"`
Expected: FAIL（いまは `dir` として受けて 201 を返す）。

- [ ] **Step 3: kind の無い本文を断る**

`packages/server/src/http/app.ts` の `api.post('/projects', …)` の分岐（784-792 行）を次にする。

```ts
      if (body.kind === 'newDir') {
        if (typeof body.name !== 'string') return c.json({ error: 'name は必須です' }, 400);
        ({ projectId } = createProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot, gitInit: deps.gitInit }, { name: body.name, gitInit: body.gitInit === true }));
      } else if (body.kind === 'dir') {
        if (typeof body.path !== 'string') return c.json({ error: 'path が存在するディレクトリではありません' }, 400);
        ({ projectId, created } = registerProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot }, { path: body.path, name: typeof body.name === 'string' ? body.name : undefined }));
      } else {
        return c.json({ error: 'kind は newDir か dir です' }, 400);
      }
```

- [ ] **Step 4: ほかの試験の本文に kind を足す**

次の行の `JSON.stringify({ name: …, path: … })` の本文の先頭に `kind: 'dir', ` を足す。
足さないと、検査したいこと（Origin、Sec-Fetch-Site、存在しない path、正規化）ではなく `kind` が無いことで 400 になり、試験が理由を取り違える。

- 206 行（許可する Origin の試験の `req`）
- 226 行（`cookieOnlyPost` の `body`）
- 250 行（正しい経路の試験）
- 264 行（開発のときの Vite の試験）
- 689 行、694 行、695 行、697 行（`it('プロジェクトの作成', …)`）
- 753 行（Windows の大文字小文字の試験の `post`）。
  `it.runIf(process.platform === 'win32')` なので手元では走らないが、CI の windows のジョブで 201 と 200 を確かめている。
  足さないと、windows のジョブだけが落ちる。

- [ ] **Step 5: 通るのを確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts`
Expected: PASS。

Run: `npm run typecheck -w packages/server`
Expected: PASS。

- [ ] **Step 6: 文書を直す**

`docs/design.md` の 2557 行付近の段落の最後の文「`kind` の無い `{ name, path }` も `dir` として受ける。」を「`kind` の無い本文は 400 で断る。」にする。

- [ ] **Step 7: コミットする**

```bash
git add packages/server/src/http docs/design.md
```

```bash
git commit -m "refactor(server): require kind on POST /api/projects" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 要約の受け付けの真偽値をやめる

**Files:**
- Modify: `packages/server/src/http/app.ts:48-52`
- Modify: `packages/server/src/summary/job.ts:81-83`
- Test: `packages/server/src/summary/job.test.ts:2`、`:9` の後、`:61`、`:80`、`:83`、`:90`、`:91`、`:118`、`:125`、`:144` と末尾

**Interfaces:**
- Consumes: なし。
- Produces: `SummaryEnqueueOpts = { force?: boolean; ignoreLive?: boolean }`。
  `SummaryJob.enqueue(sessionId: string, opts: { force?: boolean; ignoreLive?: boolean } = {}): boolean`。
  呼び手は `http/app.ts:458`（引数なし）、`http/app.ts:1036`（`{ force: true }`）、`server.ts:775`（`RUN_ENDED_SUMMARY_OPTS`）で、どれも変えない。

真偽値で呼ぶのは `job.test.ts` だけで、61、80、83、90、91、118、125（2 か所）、144 行の 9 か所ある。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/summary/job.test.ts` の 2 行目を次にし、9 行目の import の後に 1 行足す。

```ts
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
```

```ts
import type { SummaryEnqueueOpts } from '../http/app.ts';
```

同じファイルの末尾に足す。

```ts
describe('要約の受け付け方', () => {
  it('force は { force: true } で渡し、真偽値は受けない', () => {
    expectTypeOf<SummaryEnqueueOpts>().toEqualTypeOf<{ force?: boolean; ignoreLive?: boolean }>();
    expectTypeOf<Parameters<SummaryJob['enqueue']>[1]>().toEqualTypeOf<{ force?: boolean; ignoreLive?: boolean } | undefined>();
  });
});
```

同じファイルの 9 か所の `job.enqueue(<id>, true)` を `job.enqueue(<id>, { force: true })` にする（61、80、83、90、91、118、125 の 2 つ、144 行）。

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npm run typecheck -w packages/server`
Expected: FAIL（いまは `boolean` を含むので、2 つの `toEqualTypeOf` の行で型エラーになる）。

Run: `npx vitest run packages/server/src/summary/job.test.ts`
Expected: PASS（`{ force: true }` は今も受けるので振る舞いの試験は通り、赤は型の試験が受け持つ）。

- [ ] **Step 3: 真偽値をやめる**

`packages/server/src/http/app.ts` の 48-52 行を次にする。

```ts
/**
 * 要約の受け付け方。
 * force は条件をすべて飛ばす（手動の作り直し）。
 * ignoreLive はレジストリの生存判定だけを飛ばす。土台かどうかと 5 ターンの判定は残る。
 */
export type SummaryEnqueueOpts = { force?: boolean; ignoreLive?: boolean };
```

`packages/server/src/summary/job.ts` の 81-83 行を次にする。

```ts
  enqueue(sessionId: string, opts: { force?: boolean; ignoreLive?: boolean } = {}): boolean {
    const force = opts.force === true;
    const ignoreLive = force || opts.ignoreLive === true;
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npm run typecheck -w packages/server`
Expected: PASS。

Run: `npx vitest run packages/server/src/summary packages/server/src/http/app.test.ts`
Expected: PASS。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/http/app.ts packages/server/src/summary
```

```bash
git commit -m "refactor(server): drop the boolean form of the summary enqueue options" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 添付の無い古い下書きを捨てる

**Files:**
- Modify: `packages/ui/src/mediator/launch.ts:23-38`
- Modify: `docs/design.md`（679-680 の付近）
- Test: `packages/ui/src/mediator/transition.test.ts:354-355`
- Test: `packages/ui/src/runtime/runtime.test.ts:392`

**Interfaces:**
- Consumes: なし。
- Produces: `readDraft(v: unknown): NewSessionDraft | null` は、`attachments` が配列でない保存（添付を足す前の形）を `null` として捨てる。

手元の localStorage にだけ残る形なので、互換の版番号は要らない。
添付を足す前の UI で書いたまま触っていない下書きは、1 度だけ捨てられる。
いまの UI は書くたびに `attachments` を付けて保存するので、それ以降は起きない。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/mediator/transition.test.ts` の 354-355 行を次にする（356-358 行はそのまま）。

```ts
  it('readDraft は、添付の配列が無い古い形を捨て、形の違う添付は捨てる', () => {
    expect(readDraft({ name: 'n', prompt: 'p' })).toBeNull();
    expect(readDraft({ name: 'n', prompt: 'p', attachments: 'x' })).toBeNull();
```

`packages/ui/src/runtime/runtime.test.ts` の 392 行を次にする。

```ts
    a.store.set('newSession.draft', { name: 'n', prompt: 'やって', attachments: [] });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/mediator/transition.test.ts -t readDraft`
Expected: FAIL（いまは空の添付として読む）。

- [ ] **Step 3: 古い形を捨てる**

`packages/ui/src/mediator/launch.ts` の 23-38 行を次にする。

```ts
/** localStorage から読んだ下書き。形が違えば（手で書き換えられたなど）捨てる。添付の配列が無いもの（添付を足す前の形）も、形が違うものとして捨てる。 */
export function readDraft(v: unknown): NewSessionDraft | null {
  if (!v || typeof v !== 'object') return null;
  const { name, prompt, attachments } = v as Record<string, unknown>;
  if (typeof name !== 'string' || typeof prompt !== 'string' || !Array.isArray(attachments)) return null;
  const ok = (a: unknown): a is NewSessionDraft['attachments'][number] => {
    if (!a || typeof a !== 'object') return false;
    const r = a as Record<string, unknown>;
    return typeof r.path === 'string' && typeof r.name === 'string' && (r.size === null || typeof r.size === 'number');
  };
  // 空のパスと同じパスの重複は捨てる（手で書き換えられた保存値が、札の key の重複にならないように）。
  const seen = new Set<string>();
  const kept = attachments.filter(ok).filter((a) => a.path !== '' && !seen.has(a.path) && !!seen.add(a.path));
  return { name, prompt, attachments: kept.map((a) => ({ path: a.path, name: a.name, size: a.size })) };
}
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/mediator packages/ui/src/runtime`
Expected: PASS。

Run: `npm run typecheck -w packages/ui`
Expected: PASS。

- [ ] **Step 5: 文書を直す**

`docs/design.md` の 679 行付近の「下書きはプロジェクトごとではなく 1 つだけ持つ。」の次に、1 行を足す。

```
添付の配列が無い保存（添付を足す前の形）は、形が違うものとして読み戻さない。
```

- [ ] **Step 6: コミットする**

```bash
git add packages/ui/src docs/design.md
```

```bash
git commit -m "refactor(ui): discard new-session drafts saved without attachments" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 本文の床の保険は残し、残す理由を書き直す

**Files:**
- Modify: `packages/server/src/server.ts:443-451`（コメントだけ）
- Modify: `packages/server/src/sync/transcriptsFrom.ts:32-34`（コメントだけ）
- Modify: `docs/design.md`（2388-2394 の付近）
- Test: `packages/server/src/server.test.ts:203-215` の後

**Interfaces:**
- Consumes: なし。
- Produces: 振る舞いは変えない。
  `markTranscriptsFrom(syncState, cloud.joinedAt > 0 ? cloud.joinedAt : Date.now())` の 1 行は残る。

判断：spec は「床の無い `cloud.json`」を手元だけで閉じる古い版の分岐として消す側に挙げているが、この PR では消さない。
根拠は 3 つある。

1. この 1 行が効くのは「`cloud.json` はあるのに、DB（`sync_state`）に床の行が無い」ときで、古い版の CLI で参加した端末に限らない。
   DB を作り直した端末や、`cloud.json` だけを写した試しの `HANGAR_HOME` もこれに当たる。
   全体計画は、同期に触る PR 4 と PR 5 で「DB の写しを置いた別の `HANGAR_HOME` で 1 日使う」ことを決めているので、この形はすぐ先で実際に起きる。
2. 消すと、床の行が無いときは 0（床なし）と読み、手元の本文を全部上げる（`sync/transcriptsFrom.ts:22-25`）。
   design.md に記録のある 105 件、148 MB の上げすぎと同じ形の失敗で、Free の枠と R2 の置き場を使う。
3. 残す費用は 1 行で、相手が別の機械や部品でもない。
   互換の版番号（D10）でも置き換えられない（版の問題ではないため）。

`joinedAt` を読めない古い `cloud.json` のときに今の時刻を使う分岐も、同じ理由で残す。
消すと、床に 0 を刻んで床なしになる。

- [ ] **Step 1: いまの振る舞いを留める試験を書く**

`packages/server/src/server.test.ts` の `it('床が無ければ参加した時刻を保険で刻み、古いサーバが先に走った跡では床を消さない', …)` の直後に足す（Review Focus の 5 つめ）。

```ts
  it('joinedAt の無い cloud.json でも、床なし（0）にはせず今の時刻を床にする', async () => {
    // 床の行が無い DB（作り直した DB、cloud.json だけを写した試しの HANGAR_HOME）で床なしにすると、手元の本文を全部上げてしまう。
    // 宛先は誰も待ち受けていないループバックである。実物のクラウドには触らない。
    saveCloudConfig(home, { url: 'http://127.0.0.1:9', joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 0 });
    const before = Date.now();
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      expect(Number(transcriptFloor())).toBeGreaterThanOrEqual(before);
    } finally {
      await s.close();
    }
  });
```

- [ ] **Step 2: 通るのを確かめる**

振る舞いを変えないタスクなので、この試験は初めから通る。
通らなければ、この計画の前提（保険が効いている）が崩れているので、止めて報告する。

Run: `npx vitest run packages/server/src/server.test.ts -t "床"`
Expected: PASS。

- [ ] **Step 3: 残す理由をコメントに書き直す**

`packages/server/src/server.ts` の 443-451 行のコメント（`// 本文をどこから上げるかの床が無ければ、ここで刻む。` から `// メタデータの同期はこの刻みを見ないので、今までどおり全部が揃う。` まで）を次にする（452 行のコードはそのまま）。

```ts
  // 本文をどこから上げるかの床が無ければ、ここで刻む。
  // 本筋は CLI の側で、setup cloud と join が cloud.json を書くのと同じ時点で刻んでいる。
  // ここは、cloud.json はあるのに DB に床の行が無い端末のための保険で、古い版のための分岐ではない。
  // 古い版の CLI で参加した端末のほか、DB を作り直した端末や、cloud.json だけを写した試しの HANGAR_HOME もこれに当たる。
  // 床の行が無いまま走ると 0（床なし）と読み、手元の本文を全部上げてしまう。
  // 床には cloud.json の joinedAt を使い、読めないときは今の時刻にする（0 を刻むと床なしになる）。
  // joinedAt は参加し直しと秘密の作り直しで今の時刻へ書き換わるが、床が無いときにしか読まないので、書き換わった値が使われるのは床の行が無い端末に限られる。
  // 以後、本文の取り残しの走査はこの時刻より後に動いた転記だけを拾う（sync/transcriptsFrom.ts）。
  // メタデータの同期はこの刻みを見ないので、今までどおり全部が揃う。
```

`packages/server/src/sync/transcriptsFrom.ts` の 34 行目（` * もう 1 つはサーバ起動時の保険で、床の無い cloud.json を見つけたときだけ効く。`）を次にする。

```ts
 * もう 1 つはサーバ起動時の保険で、cloud.json があるのに DB に床の行が無いときだけ効く（DB を作り直した端末などで、本文を全部上げないため）。
```

- [ ] **Step 4: 文書を直す**

`docs/design.md` の 2388-2390 行付近の 3 行（「サーバ側の刻みは保険として残す。」「効くのは、区切りの無い `cloud.json` を持つ端末（CLI が刻むようになる前に参加した端末）だけである。」「使う値は `cloud.json` の `joinedAt` で、…」）を、次の 6 行にする（2391 行から下はそのまま）。

```
サーバ側の刻みは保険として残す。
効くのは、`cloud.json` はあるのに DB に区切りの行が無い端末である。
CLI が刻むようになる前に参加した端末のほか、DB を作り直した端末や、`cloud.json` だけを写した試しの `HANGAR_HOME` も当たる。
段 1 で、これは古い版のための分岐ではないと判断して残した。
消すと、区切りの行が無い端末は 0（区切りなし）と読み、手元の本文を全部上げる。
使う値は `cloud.json` の `joinedAt` で、それを読めない古い設定のときだけ今の時刻にする。
```

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/server.ts packages/server/src/sync/transcriptsFrom.ts packages/server/src/server.test.ts docs/design.md
```

```bash
git commit -m "docs(server): explain why the transcript floor safety net stays" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 全体の確かめとビルド

**Files:**
- なし（直しが要ったときだけ、そのファイルを直してコミットする）。

**Interfaces:**
- Consumes: Task 1 から Task 13 のすべて。
- Produces: なし。

- [ ] **Step 1: 消したものが残っていないことを確かめる**

Run: `git grep -n -i takeover -- packages`
Expected: `server/src/db/migrations.ts`、`server/src/db/db.test.ts`、Task 1 の試験だけ。

Run: `git grep -n -e "interface Provider" -e summaryOpen -e notYet -e NOT_YET -e "sync\.applied" -e "usage\.update" -e parseBackgroundedId -e emptyUsage -e applySyncStatus -- packages`
Expected: 出るのは、Task 3、4、8 で足した型の試験と、Task 3 の runtime の試験と、`runtime.ts` の `summaryOpen` を捨てる行だけ。

Run: `git grep -n -e "as Partial<BootstrapDto>" -e "Partial<SyncDetailDto>" -e "古いサーバ" -- packages/ui/src packages/shared/src`
Expected: 何も出ないか、この PR の範囲の外（同期の見張りの `pausedReason` など、PR 5 で消すもの）だけ。

- [ ] **Step 2: 型と試験を全部回す**

Run: `npm run typecheck`
Expected: PASS。

Run: `npm test`
Expected: PASS（全部）。

- [ ] **Step 3: 3 つのビルドを通す**

Run: `npm run build`
Expected: 成功する。

Run: `npm run bundle-server -w apps/desktop`
Expected: 成功する。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`
Expected: 成功し、`.app` ができる（tauri build は Homebrew の cargo を PATH の先頭に置く）。

- [ ] **Step 4: 直しがあればコミットする**

Step 1 から Step 3 で直したものがあれば、直したファイルだけを `git add` し、次でコミットする。

```bash
git commit -m "fix: follow-ups from the stage 1 PR 1 verification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

PR を出し、CI の 3 つのジョブ（check、desktop、windows）を待ってマージし、アプリを入れ替える流れは、この計画の外のいつもの手順で行う。
