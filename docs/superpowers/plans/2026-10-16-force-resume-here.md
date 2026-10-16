# ほかの PC から引き継ぐ「この PC で再開」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ほかの PC で動いている会話を、この PC から止めてもらい（返事がなければ確認のうえ奪い）、最後のトランスクリプトを降ろしてから再開できるようにする。

**Architecture:** 頼みは新しい共有表 2 つで運ぶ。`takeovers`（頼む側だけが書く）と `takeover_answers`（頼まれた側だけが書く）で、1 行の書き手を 1 台に限って後勝ちの消し合いを避ける。
頼まれた側のサーバは届いた頼みを見て、自分の run を `kill(runId, 'taken_over')` で止め、本文を 2 度上げてから、上げた版（sha256 と大きさ）を応答に書く。
頼む側のサーバは `TakeoverService` が頼みを書き、待つ間だけ 5 秒ごとに取りに行き、応答と台帳（`file_sync`）がそろったら `ready` を配る。画面は `ready` を受けて今までの `POST /resume-here` に入る。

**Tech Stack:** TypeScript、Hono（サーバと Worker）、better-sqlite3、React（UI）、vitest、Rust（殻の版の写しだけ）。

**Spec:** `docs/superpowers/specs/2026-10-16-force-resume-here-design.md`（全部読むこと）。
今の作りは `docs/design.md` の「他端末セッションのロックと『この PC で再開』」と「互換の版番号」。

## Global Constraints

- 共有表を足すと Worker（`packages/cloud/src/changes.ts`）が古い版では push を丸ごと 400 で断る。端末は、Worker が名乗る版が `TAKEOVER_MIN_WORKER_COMPAT`（`6`）に届くまで `takeovers` と `takeover_answers` の行を書かない（`config_snapshots` の先例）。
- `COMPAT_VERSION` は 5 から `6` に上げ、殻の `apps/desktop/src-tauri/src/health.rs` の `COMPAT_VERSION` も同じコミットで `6` にする。`MIN_DEVICE_COMPAT`（Worker）と `MIN_WORKER_COMPAT`（端末）は上げない。
- 相手の pull の周期（`PULL_INTERVAL_MS` 30 秒）は変えない。待つ側だけ、待つ間は `TAKEOVER_POLL_MS`（`5_000`）ごとに取りに行く。
- 打ち切りは `TAKEOVER_TIMEOUT_MS`（`90_000`）。「もう少し待つ」はその時点から同じ長さを足す。
- ほかの PC の `runs` の行には書かない（持ち主が 30 秒ごとに行全体で書き直すので消える）。
- 相手を止めるのは `RunManager.kill`。止めた理由は `end_reason = 'taken_over'`（`EndReason` に足す）。
- 作業中の判定は run の状態で、`LiveStatus` の `busy` を「作業中」、`waiting` と `idle` と不明を「実行中」と読む。
- 画面の日本語は仕様の「画面」の節を写す（下の各タスクに写してある）。英語は作り手が訳す。i18n は `packages/shared/src/i18n/keys/`、`ja/`、`en/` の 3 か所に同じ鍵を足す。
- 実物のクラウド（Worker の配備、2 台をまたぐ確かめ）には触らない。報告に「実物では未確認」と書く。
- 公開リポジトリなので、試験、文書、コメントに実際の PC 名、利用者名、利用の実数を書かない（PC 名は `pc-a`、`pc-b` などにする）。
- 試験は vitest。リポジトリの根で `npx vitest run <ファイル>`、型は `npm run typecheck`、最後に `npm test`。worktree に `node_modules` が無ければ先に `npm ci`。
- 各タスクは「試験を書く → 落ちるのを見る → 実装する → 通るのを見る → コミット」。
- コードのコメントは日本語で周りと同じ密度。`docs/design.md` は一文一行、中黒と em ダッシュを使わない。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。git はほかのコマンドと 1 行に混ぜない。

## Review Focus

- **応答と取り下げの行き違い**：頼む側が取り下げた直後に相手が止めて応答を書いても、頼む側の画面は閉じたまま、再開もしない。行は書き手が別なので消し合わない（Task 4 の試験で留める）。
- **同じ会話に 2 台が同時に頼む**：先に止めた頼みに `stopped`、後の頼みに `not_running` が返り、後の方もふつうの再開に進む（Task 3 の試験で留める）。
- **Worker が版 5 のまま、または同期が一時停止中**：行を書かず、待たずに「返事がありません」へ落ちる。他の表の同期は止まらない（Task 1 と Task 4 の試験で留める）。
- **相手が止まった後、本文が上がり切る前に応答が届く**：台帳の sha256 と大きさが応答と合うまで `receiving` のまま待ち、古い本文で再開しない（Task 4 の試験で留める）。
- **引き継がれた側の Hangar を再起動したとき、tmux に claude が残っている**：起動時の走査で止め、`revive` は奪われた run を生き返らせない（Task 2 と Task 3 の試験で留める）。

---

### Task 1: 頼みを運ぶ共有表と互換の版 6

**Files:**
- Modify: `packages/shared/src/cloud.ts`（`SharedTable`、`SHARED_TABLES` の末尾、`TABLE_PK`、上の説明）
- Modify: `packages/shared/src/compat.ts`（`COMPAT_VERSION = 6`、版 6 の説明、`TAKEOVER_MIN_WORKER_COMPAT`）
- Modify: `apps/desktop/src-tauri/src/health.rs`（`pub const COMPAT_VERSION: u64 = 6;`）
- Modify: `packages/server/src/db/migrations.ts`（`V28_TAKEOVER_SQL` と `{ version: 28, ... }`）
- Create: `packages/server/src/sync/takeoverRows.ts`
- Test: `packages/shared/src/cloud.test.ts`、`packages/shared/src/compat.test.ts`、`packages/cloud/test/takeover.test.ts`（新規）、`packages/server/src/db/db.test.ts`、`packages/server/src/sync/takeoverRows.test.ts`（新規）

**Interfaces:**
- Consumes: `upsertShared`、`softDeleteShared`（`packages/server/src/db/shared.ts`）、`newId`（shared）。
- Produces:
  - `SharedTable` に `'takeovers' | 'takeover_answers'`。`TABLE_PK.takeovers = 'id'`、`TABLE_PK.takeover_answers = 'ask_id'`。
  - `TAKEOVER_MIN_WORKER_COMPAT = 6`（`@agent-hangar/shared`）。
  - `takeoverRows.ts`：
    - `type TakeoverMode = 'ask' | 'force'`
    - `type TakeoverAsk = { id: string; sessionId: string; runId: string; targetDevice: string; fromDevice: string; requestedAt: number; mode: TakeoverMode; cancelledAt: number | null }`
    - `type TakeoverResult = 'stopped' | 'not_running'`
    - `type TakeoverAnswer = { askId: string; runId: string; result: TakeoverResult; answeredAt: number; transcriptSha256: string | null; transcriptSize: number | null }`
    - `TAKEOVER_ROW_TTL_MS = 30 * 86_400_000`
    - `writeAsk(db: Db, self: string, o: { sessionId: string; runId: string; targetDevice: string; mode: TakeoverMode; now: number }): TakeoverAsk`
    - `setAskForce(db: Db, self: string, askId: string, now: number): void`
    - `cancelAsk(db: Db, self: string, askId: string, now: number): void`
    - `writeAnswer(db: Db, self: string, a: TakeoverAnswer): void`
    - `asksForMe(db: Db, self: string): TakeoverAsk[]`（`target_device = self`、取り下げも削除もされておらず、まだ答えていないもの。古い順）
    - `answerOf(db: Db, askId: string): TakeoverAnswer | null`
    - `askOf(db: Db, askId: string): TakeoverAsk | null`
    - `pruneTakeoverRows(db: Db, self: string, now: number): number`（自分が書いた行のうち `updated_at` が TTL より古いものを論理削除し、数を返す）

V28 の SQL（同期する表には `check` を付けない。後の版が値を足しても古い PC の適用が落ちないようにするため。外部キーも付けない。頼みは相手の行より先に届きうる一時の行だからである）：

```sql
create table takeovers (
  id text primary key, session_id text not null, run_id text not null,
  target_device text not null, from_device text not null, requested_at integer not null,
  mode text not null, cancelled_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create index takeovers_target on takeovers(target_device, run_id);
create table takeover_answers (
  ask_id text primary key, run_id text not null, result text not null, answered_at integer not null,
  transcript_sha256 text, transcript_size integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
alter table runs add column live_status text;
```

`runs.live_status` は Task 2 が書く。古い PC は知らない列を適用で捨てる（`sync/apply.ts` の `tableColumns`）。

- [ ] **Step 1: 試験を書く**

`packages/shared/src/cloud.test.ts` に足す。

```ts
it('引き継ぎの頼みと応答は共有表で運ぶ', () => {
  expect(SHARED_TABLES).toContain('takeovers');
  expect(SHARED_TABLES).toContain('takeover_answers');
  expect(TABLE_PK.takeovers).toBe('id');
  expect(TABLE_PK.takeover_answers).toBe('ask_id');
});
```

`packages/shared/src/compat.test.ts` に足す。

```ts
it('版 6 は引き継ぎの表を知る Worker の版', () => {
  expect(COMPAT_VERSION).toBe(6);
  expect(TAKEOVER_MIN_WORKER_COMPAT).toBe(6);
});
```

`packages/cloud/test/takeover.test.ts` を `packages/cloud/test/config-bundle.test.ts` と同じ道具で作る。

```ts
it('POST /changes は takeovers と takeover_answers の行を受け、GET /changes で相手に渡す', async () => {
  // pc-a が takeovers を 1 行、pc-b が takeover_answers を 1 行 push する
  expect(pushA.status).toBe(200);
  expect(pushB.status).toBe(200);
  expect((await pull(tokB)).changes.map((c) => c.tableName)).toContain('takeovers');
  expect((await pull(tokA)).changes.map((c) => c.tableName)).toContain('takeover_answers');
});
```

`packages/server/src/db/db.test.ts` の表の一覧に `'takeovers'` と `'takeover_answers'` を足し、`runs` に `live_status` の列があることを `pragma table_info(runs)` で確かめる 1 件を足す。

`packages/server/src/sync/takeoverRows.test.ts` を作る。

```ts
it('writeAsk は自分の行を書いて changes に積み、asksForMe は宛先の PC からだけ見える', () => {
  const a = writeAsk(db, 'pc-a', { sessionId: 's1', runId: 'r1', targetDevice: 'pc-b', mode: 'ask', now: 1000 });
  expect(asksForMe(db, 'pc-b').map((x) => x.id)).toEqual([a.id]);
  expect(asksForMe(db, 'pc-a')).toEqual([]);
  expect(pendingChanges(db, 'takeovers')).toBe(1);
});
it('取り下げた頼みと、答えた頼みは asksForMe に出ない', () => { /* cancelAsk と writeAnswer の後に [] */ });
it('setAskForce は同じ行の mode を force にする', () => { expect(askOf(db, a.id)?.mode).toBe('force'); });
it('answerOf は sha256 と大きさを返す', () => {
  writeAnswer(db, 'pc-b', { askId: a.id, runId: 'r1', result: 'stopped', answeredAt: 2000, transcriptSha256: 'abc', transcriptSize: 42 });
  expect(answerOf(db, a.id)).toEqual({ askId: a.id, runId: 'r1', result: 'stopped', answeredAt: 2000, transcriptSha256: 'abc', transcriptSize: 42 });
});
it('pruneTakeoverRows は自分の行のうち 30 日より古いものだけを消す', () => { /* ほかの PC の行は残る、戻り値は 1 */ });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/shared/src/cloud.test.ts packages/shared/src/compat.test.ts packages/cloud/test/takeover.test.ts packages/server/src/db/db.test.ts packages/server/src/sync/takeoverRows.test.ts`
Expected: FAIL（表が無い、`TAKEOVER_MIN_WORKER_COMPAT` が無い、Worker が 400 を返す）

- [ ] **Step 3: 実装する**

表と定数と版を上げ、`compat.ts` に版 6 の段落（引き継ぎの 2 表、Worker の版が 6 に届くまで行を書かない、古い PC には頼みが届かず 90 秒で打ち切る、下限は上げない）を足す。`cloud.ts` の説明にも同じ旨を 1 行足す。`takeoverRows.ts` の各関数は `upsertShared(db, 'takeovers' | 'takeover_answers', row, self, pk, now)` で書く。

- [ ] **Step 4: 通るのを見る**

Run: Step 2 と同じコマンドに `apps/desktop/test/config.test.ts packages/server/test/fake-cloud.test.ts packages/server/src/sync/apply.test.ts` を足す。
Expected: PASS（殻の版の突き合わせと偽の Worker の版も通る）

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/cloud.ts packages/shared/src/compat.ts packages/shared/src/cloud.test.ts packages/shared/src/compat.test.ts apps/desktop/src-tauri/src/health.rs packages/server/src/db/migrations.ts packages/server/src/db/db.test.ts packages/server/src/sync/takeoverRows.ts packages/server/src/sync/takeoverRows.test.ts packages/cloud/test/takeover.test.ts
git commit -m "feat(sync): carry takeover asks and answers as shared tables (compat 6)"
```

---

### Task 2: run の側の事実（止めた理由、作業中かどうか、生き返らせない）

**Files:**
- Modify: `packages/shared/src/api.ts`（`EndReason` に `'taken_over'`、`SessionLockDto` に `liveStatus?`）
- Modify: `packages/server/src/runs/manager.ts`（`kill`、`tick` の heartbeat、`revive`）
- Modify: `packages/server/src/db/queries.ts`（`lockMap` の行に `live_status`、`sessionLock` を輸出）
- Test: `packages/server/src/runs/manager.test.ts`、`packages/server/src/db/queries.test.ts`

**Interfaces:**
- Consumes: Task 1 の `runs.live_status`、`takeovers` の表。
- Produces:
  - `EndReason = 'exited' | 'killed' | 'lost' | 'parked' | 'taken_over'`
  - `SessionLockDto = { deviceId; deviceName; runId; heartbeatAt; stale; liveStatus?: LiveStatus | null }`（古いサーバは送らない）
  - `RunManager.kill(runId: string, reason: 'killed' | 'taken_over' = 'killed'): RunDto`
  - `sessionLock(db: Db, selfDeviceId: string, sessionId: string, now: number): SessionLockDto | null`（`lockMap` と同じ規則で 1 件）

- [ ] **Step 1: 試験を書く**

`manager.test.ts` に足す。

```ts
it('kill に taken_over を渡すと、その理由で終わる', () => {
  expect(runs.kill(runId, 'taken_over').endReason).toBe('taken_over');
});
it('heartbeat の書き直しに、最後に見た状態（run_last_live）を live_status として載せる', () => {
  noteLastLive(db, runId, 'busy', t0);
  advance(30_000); runs.tick();
  expect(runRow(runId).live_status).toBe('busy');
});
it('頼みの宛先になった run は、tmux 名が戻ってきても生き返らせない', () => {
  // exited で閉じた run に takeovers の行（取り下げなし）があり、同じ tmux 名が一覧に戻る
  expect(runs.tick().ended).toEqual([]);
  expect(getRun(db, runId)?.endedAt).not.toBeNull();
});
it('ほかの PC がその会話の run を後から始めていれば、手元の古い run を生き返らせない', () => {
  // 別 device_id の runs 行で started_at が手元の run より新しい
  expect(getRun(db, runId)?.endedAt).not.toBeNull();
});
```

`queries.test.ts` に足す。

```ts
it('sessionLock はほかの PC の生きた run を返し、live_status を liveStatus に写す', () => {
  expect(sessionLock(db, 'pc-a', 's1', now)).toMatchObject({ deviceId: 'pc-b', runId: 'r1', stale: false, liveStatus: 'busy' });
});
it('sessionLock は heartbeat が LOCK_STALE_MS より古ければ stale、自分の run なら null', () => { /* ... */ });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/runs/manager.test.ts packages/server/src/db/queries.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`kill` は理由を `end` に渡すだけにする。heartbeat の書き直しは今の 30 秒ごとの 1 回に `live_status` を足すだけで、状態が変わるたびには書かない（無料枠の書き込みを増やさないため）。`revive` の候補の SQL に、取り下げていない `takeovers` が `run_id` を指す行と、別の PC の `started_at` がより新しい `runs` の行を除く条件を足す。`lockMap` を `sessionLock` と共有の行の読み方にする。

- [ ] **Step 4: 通るのを見る**

Run: Step 2 と同じ。
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/api.ts packages/server/src/runs/manager.ts packages/server/src/runs/manager.test.ts packages/server/src/db/queries.ts packages/server/src/db/queries.test.ts
git commit -m "feat(runs): end runs as taken_over, publish live status on heartbeat, keep taken runs dead"
```

---

### Task 3: 頼まれた側で止めて応答する

**Files:**
- Create: `packages/server/src/sync/takeoverResponder.ts`
- Create: `packages/server/src/boot/takeover.ts`
- Modify: `packages/server/src/pty/relay.ts`（`note`）
- Modify: `packages/server/src/boot/sync.ts`（`SyncParts` に `pushNow`、`onTakeoversApplied`、`flushSession`）
- Modify: `packages/server/src/boot/http.ts`（`relay` を `takeover.setNotePane` に渡す）
- Modify: `packages/server/src/server.ts`（`bootTakeover` を組み、`sync.start()` の後に `takeover.start()`、停止で `takeover.stop()`）
- Modify: `packages/shared/src/i18n/keys/sync.ts`、`ja/sync.ts`、`en/sync.ts`（`sync.takeover.paneNote`）
- Test: `packages/server/src/sync/takeoverResponder.test.ts`（新規）、`packages/server/src/pty/relay.test.ts`

**Interfaces:**
- Consumes: Task 1 の `asksForMe`、`writeAnswer`、`pruneTakeoverRows`。Task 2 の `kill(runId, 'taken_over')`。`FLUSH_AGAIN_MS`（`sync/flushOnRunEnd.ts`）。
- Produces:
  - `PtyRelay.note(tmuxName: string, text: string): void`（その tmux 名に attach している接続へ `{ t: 'data', d: '\r\n' + text + '\r\n' }` を送る）
  - `SyncParts.pushNow(): Promise<void>`、`SyncParts.flushSession(uuid: string): Promise<void>`（同期していなければ何もしない）、`SyncParts.onTakeoversApplied(cb: () => void): () => void`（`takeovers` か `takeover_answers` の行を当てたとき）
  - `type TakeoverResponderDeps = { db: Db; deviceId: string; runs: Pick<RunManager, 'getRun' | 'kill'>; flushSession(uuid: string): Promise<void>; pushNow(): Promise<void>; notePane?(tmuxName: string, text: string): void; deviceName(id: string): string; language: () => Language; againMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }`
  - `class TakeoverResponder { constructor(deps); scan(): Promise<number> }`（答えた数を返す。同じ頼みを並行して 2 度扱わない）
  - `type TakeoverParts = { responder: TakeoverResponder; start(): void; stop(): void; setNotePane(fn: (tmuxName: string, text: string) => void): void }`（Task 4 が `service` を足す）
  - `bootTakeover(p: { home: HomeParts; runs: RunsParts; sync: SyncParts }): TakeoverParts`

`scan` の 1 件の流れ（この順は試験で留める）：生きた自分の run なら `notePane` → `kill(runId, 'taken_over')` → `flushSession` → `sleep(againMs ?? FLUSH_AGAIN_MS)` → `flushSession` → `file_sync` の自分の主線の鍵 `transcripts/<self>/<uuid>.jsonl.gz` の `sha256` と `size` を読んで `writeAnswer(result: 'stopped')` → `pushNow`。run がもう終わっているか自分のものでなければ、止めずに `not_running` と今の `file_sync` の版（無ければ null）で答える。`start()` は 1 度 `pruneTakeoverRows` と `scan` を回し、`onTakeoversApplied` で以後も回す。

文言（`sync.takeover.paneNote`、引数 `device`）：`[hangar] {device} に引き継がれたため、この PC の claude を止めました。`

- [ ] **Step 1: 試験を書く**

`takeoverResponder.test.ts` を作る。偽の `runs`、`flushSession`、`pushNow`、`sleep` で呼ばれた順を 1 本の配列に記録する。

```ts
it('宛先の生きた run を止め、2 度上げてから、上げた版で stopped と答える', async () => {
  expect(await responder.scan()).toBe(1);
  expect(calls).toEqual(['note', 'kill:r1:taken_over', 'flush:u1', 'sleep:5000', 'flush:u1', 'push']);
  expect(answerOf(db, ask.id)).toMatchObject({ result: 'stopped', transcriptSha256: 'sha-1', transcriptSize: 42 });
});
it('端末に残す 1 行は頼んだ PC の名前を入れる', async () => {
  expect(notes).toEqual([['hangar-r1', '[hangar] pc-a に引き継がれたため、この PC の claude を止めました。']]);
});
it('run がもう終わっていれば止めずに not_running と答える', async () => { expect(calls).not.toContain('kill:r1:taken_over'); });
it('同じ会話への 2 つ目の頼みには not_running と答える（先に応答を得た方が引き継ぐ）', async () => { /* ... */ });
it('取り下げた頼みとほかの PC あての頼みには答えない', async () => { expect(await responder.scan()).toBe(0); });
it('並行して 2 度 scan しても、同じ頼みは 1 度しか止めない', async () => {
  await Promise.all([responder.scan(), responder.scan()]);
  expect(calls.filter((c) => c.startsWith('kill:'))).toHaveLength(1);
});
it('起動前に届いていた頼みは start の最初の scan で止める（tmux に残った claude）', async () => { /* ... */ });
```

`relay.test.ts` に足す。

```ts
it('note はその tmux 名に attach している接続にだけ 1 行を送る', async () => {
  relay.note('t-1', '[hangar] x');
  expect(framesOf(ws1)).toContainEqual({ t: 'data', d: '\r\n[hangar] x\r\n' });
  expect(framesOf(ws2)).not.toContainEqual({ t: 'data', d: '\r\n[hangar] x\r\n' });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/takeoverResponder.test.ts packages/server/src/pty/relay.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`PtyRelay` に接続ごとの tmux 名を持たせて `note` を足す。`TakeoverResponder` と `bootTakeover` を作り、`SyncParts` の 3 つの口を足し（組み直した core を引く今の作りに合わせる）、`server.ts` と `boot/http.ts` に組む。

- [ ] **Step 4: 通るのを見る**

Run: Step 2 と同じコマンドに `packages/server/src/boot` を足す。続けて `npm run typecheck`。
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/sync/takeoverResponder.ts packages/server/src/sync/takeoverResponder.test.ts packages/server/src/boot/takeover.ts packages/server/src/boot/sync.ts packages/server/src/boot/http.ts packages/server/src/server.ts packages/server/src/pty/relay.ts packages/server/src/pty/relay.test.ts packages/shared/src/i18n
git commit -m "feat(sync): stop a run asked to be taken over and answer with the last transcript"
```

---

### Task 4: 頼む側のサーバの流れ

**Files:**
- Create: `packages/server/src/sync/takeover.ts`
- Modify: `packages/shared/src/api.ts`（`TakeoverStage`、`TakeoverDto`、`TAKEOVER_TIMEOUT_MS`、`TakeoverLockedDto`）
- Modify: `packages/shared/src/events.ts`（`{ type: 'takeover.update'; takeover: TakeoverDto }`）
- Modify: `packages/server/src/boot/sync.ts`（`SyncParts.pullForTakeover`、`SyncParts.canCarryTakeover`）
- Modify: `packages/server/src/boot/takeover.ts`（`service` を足す）
- Modify: `packages/server/src/http/deps.ts`、`packages/server/src/http/routes/runs.ts`、`packages/server/src/boot/http.ts`
- Modify: `packages/shared/src/i18n/keys/sync.ts`、`ja/sync.ts`、`en/sync.ts`（`sync.takeover.locked`）
- Test: `packages/server/src/sync/takeover.test.ts`（新規）、`packages/server/src/http/routes/runs.test.ts`、`packages/server/src/boot/sync.test.ts`

**Interfaces:**
- Consumes: Task 1 の `writeAsk`、`setAskForce`、`cancelAsk`、`answerOf`、`TAKEOVER_MIN_WORKER_COMPAT`。Task 2 の `sessionLock`。Task 3 の `SyncParts.pushNow`、`onTakeoversApplied`。
- Produces（shared）：
  - `TAKEOVER_TIMEOUT_MS = 90_000`
  - `type TakeoverStage = 'asking' | 'waiting' | 'receiving' | 'ready' | 'timeout' | 'cancelled'`
  - `type TakeoverDto = { sessionId: string; deviceName: string; stage: TakeoverStage; startedAt: number; deadline: number }`
  - `type TakeoverLockedDto = { error: string; code: 'locked' }`
- Produces（server）：
  - `TAKEOVER_POLL_MS = 5_000`
  - `SyncParts.pullForTakeover(): Promise<void>`（行の pull と本文の写しの pull を 1 回ずつ）
  - `SyncParts.canCarryTakeover(): boolean`（同期が設定済みで、一時停止でも版や解除や上限で止まってもおらず、`lastWorkerCompat()` が `TAKEOVER_MIN_WORKER_COMPAT` 以上）
  - `type TakeoverServiceDeps = { db: Db; deviceId: string; canCarry(): boolean; pushNow(): Promise<void>; pull(): Promise<void>; broadcast(dto: TakeoverDto): void; now?: () => number; timers?: Timers }`（`Timers` は `sync/engine.ts` の差し替え口と同じ形）
  - `class TakeoverService { start(sessionId: string, o: { force: boolean }): TakeoverDto; extend(sessionId: string): TakeoverDto | null; cancel(sessionId: string): void; get(sessionId: string): TakeoverDto | null; noteApplied(): void; stop(): void }`
  - `resumeHereAllowed(db: Db, self: string, sessionId: string, now: number): { ok: true } | { ok: false; deviceName: string }`
  - 経路：`POST /api/sessions/:id/takeover`（本文 `{ force?: boolean }`、200 で `TakeoverDto`、無い会話は 404）、`GET /api/sessions/:id/takeover`（無ければ 404）、`POST /api/sessions/:id/takeover/extend`、`DELETE /api/sessions/:id/takeover`（204）。

段の決め方：

- `start` は会話のロックを `sessionLock` で見直す。ロックが無ければ行を書かずに `ready`。`stale` か `force: true` なら `force` の頼みを書いて（すでに頼みがあれば `setAskForce`）すぐ `ready`。生きたロックなら、`canCarry()` が偽のとき行を書かずにすぐ `timeout`、真のとき `ask` を書いて `asking`、`pushNow` が済んだら `waiting`。
- `waiting` と `receiving` の間だけ `TAKEOVER_POLL_MS` ごとに `pull` し、そのたびと `noteApplied` で確かめる。応答があり、`transcriptSha256` が null か、手元の `file_sync` の `transcripts/<相手>/<uuid>.jsonl.gz` の `sha256` と `size` が応答と同じなら `ready`。応答があって合わなければ `receiving`。
- `deadline`（`startedAt + TAKEOVER_TIMEOUT_MS`）を過ぎたら `timeout` にして取りに行くのをやめる。`extend` は `deadline = now + TAKEOVER_TIMEOUT_MS` で `waiting` に戻す（`canCarry()` が偽なら `timeout` のまま）。
- `cancel` は頼みに `cancelAsk` を書いて `pushNow`、状態を捨てて `cancelled` を 1 度配る。
- 段が変わるたびに `broadcast`（`takeover.update`）。
- `POST /resume-here` は先に `resumeHereAllowed` を見て、偽なら 409 と `TakeoverLockedDto`（文言 `sync.takeover.locked`：`{device} で実行中です。先に止めて引き継いでください。`）。真になるのは、ロックが無い、`stale`、またはこの PC が書いた取り下げていない頼みがロックの run を指し、`force` か応答があるときである。

- [ ] **Step 1: 試験を書く**

`takeover.test.ts` を作る（偽の時計とタイマー、`canCarry`、`pushNow`、`pull`、`broadcast` を差す）。

```ts
it('ロックが無ければ頼みを書かずに ready', () => {
  expect(svc.start('s1', { force: false }).stage).toBe('ready');
  expect(count('takeovers')).toBe(0);
});
it('ロックが stale なら force の頼みを書いて ready', () => {
  expect(svc.start('s1', { force: false }).stage).toBe('ready');
  expect(onlyAsk().mode).toBe('force');
});
it('生きたロックなら ask を書き、push の後に waiting にする', async () => {
  expect(svc.start('s1', { force: false })).toMatchObject({ stage: 'asking', deviceName: 'pc-b', deadline: T0 + 90_000 });
  await flush();
  expect(lastBroadcast().stage).toBe('waiting');
});
it('待つ間は 5 秒ごとに取りに行く', async () => { advance(5_000); expect(pulls).toBe(1); advance(5_000); expect(pulls).toBe(2); });
it('応答と台帳の版がそろえば ready、合わなければ receiving', async () => { /* file_sync の sha を変えて 2 通り */ });
it('応答の sha256 が null なら台帳を見ずに ready', async () => { /* ... */ });
it('90 秒で timeout にして取りに行くのをやめ、extend で待ち直す', async () => {
  advance(90_000); expect(lastBroadcast().stage).toBe('timeout');
  const before = pulls; advance(10_000); expect(pulls).toBe(before);
  expect(svc.extend('s1')).toMatchObject({ stage: 'waiting', deadline: T0 + 100_000 + 90_000 });
});
it('timeout の後に force で始めると、同じ頼みの行を force にして ready', () => { expect(count('takeovers')).toBe(1); expect(onlyAsk().mode).toBe('force'); });
it('頼みを運べないとき（Worker が版 5、同期の一時停止）は行を書かずにすぐ timeout', () => {
  canCarry = false;
  expect(svc.start('s1', { force: false }).stage).toBe('timeout');
  expect(count('takeovers')).toBe(0);
});
it('cancel は頼みに取り下げを書き、その後に応答が届いても ready を配らない', async () => {
  svc.cancel('s1');
  expect(onlyAsk().cancelledAt).not.toBeNull();
  writeAnswer(db, 'pc-b', { /* stopped */ }); svc.noteApplied();
  expect(broadcasts.map((d) => d.stage)).not.toContain('ready');
  expect(svc.get('s1')).toBeNull();
});
describe('resumeHereAllowed', () => {
  it('生きたロックで頼みが無ければ断り、相手の名前を返す', () => { expect(resumeHereAllowed(db, 'pc-a', 's1', now)).toEqual({ ok: false, deviceName: 'pc-b' }); });
  it('stale、force の頼み、応答のある頼みなら通す', () => { /* 3 通りとも { ok: true } */ });
});
```

`runs.test.ts` に足す。

```ts
it('POST /sessions/:id/resume-here は生きたロックのとき 409 と code: locked で断る', async () => {
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'locked' });
});
it('POST /sessions/:id/takeover は TakeoverDto を返し、GET で同じものが読め、DELETE で 404 に戻る', async () => { /* ... */ });
```

`boot/sync.test.ts` に足す。

```ts
it('canCarryTakeover は Worker の版が TAKEOVER_MIN_WORKER_COMPAT に届くまで偽', () => { /* 偽の client の workerCompat を 5 と 6 で */ });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/takeover.test.ts packages/server/src/http/routes/runs.test.ts packages/server/src/boot/sync.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`TakeoverService` は会話ごとの状態をメモリだけに持つ（サーバを再起動したら待ちは消え、画面は取り消しと同じ扱いになる）。`bootTakeover` で `service` を組み、`onTakeoversApplied` で `noteApplied` を呼ぶ。経路を足し、`AppDeps` に `takeover: TakeoverService` を足す。

- [ ] **Step 4: 通るのを見る**

Run: Step 2 と同じコマンドの後に `npm run typecheck`。
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/sync/takeover.ts packages/server/src/sync/takeover.test.ts packages/shared/src/api.ts packages/shared/src/events.ts packages/server/src/boot packages/server/src/http packages/shared/src/i18n
git commit -m "feat(sync): ask the other computer to stop, wait for its last transcript, and check the lock on resume-here"
```

---

### Task 5: 確認の 1 枚（A1 と、もう応答していない相手の 1 枚）

**Files:**
- Modify: `packages/shared/src/api.ts`（`ResumeHerePlanDto.lock?`）
- Modify: `packages/server/src/runs/handover.ts`（`resumeHerePlan` が `lock` を返す）
- Modify: `packages/shared/src/action.ts`（`session.takeover.start`）
- Modify: `packages/ui/src/presenters/resumeHere.ts`（`resumeHereOf`、`presentResumeHere`）
- Modify: `packages/ui/src/presenters/session.ts`（`canResumeHere`、`resumeHereBlocked` の理由を外す）
- Modify: `packages/ui/src/views/ConfirmDialog.tsx`（`ResumeHereConfirm` の赤みの帯と承諾の送り先）
- Modify: `packages/ui/src/styles/sync.css`（`.rh-takeover`）
- Modify: `packages/shared/src/i18n/keys/confirm.ts`、`ja/confirm.ts`、`en/confirm.ts`、`keys/session.ts`、`ja/session.ts`、`en/session.ts`（`session.action.resumeHereBlocked` を消す）
- Test: `packages/server/src/runs/handover.test.ts`、`packages/ui/src/presenters/resumeHere.test.ts`、`packages/ui/src/views/ConfirmDialog.test.tsx`（新規）

**Interfaces:**
- Consumes: Task 2 の `sessionLock`、`liveStatus`。
- Produces:
  - `ResumeHerePlanDto.lock?: { deviceName: string; stale: boolean; working: boolean; heartbeatAt: number } | null`（古いサーバは送らない。`working` は `liveStatus === 'busy'`）
  - `resumeHerePlan(db, selfDeviceId, sessionId, o: { replace?; now?: number })`
  - UiAction `{ type: 'session.takeover.start'; id: SessionId; force: boolean }`
  - `ResumeHereProps` に `mode: 'resume' | 'takeover' | 'stale'` と `takeover: { strong: string; text: string } | null`
  - `presentResumeHere(t: Translate, plan: ResumeHerePlanDto, home: string | null, now: number): ResumeHereProps`

文言（日本語、`confirm.takeover.*`）：

| 鍵 | 引数 | 日本語 |
| --- | --- | --- |
| `confirm.takeover.title` | | ほかの PC で動いている会話を、この PC で引き継ぎますか |
| `confirm.takeover.runningStrong` | device | {device} で実行中です |
| `confirm.takeover.runningText` | device | 引き継ぐと、{device} の claude を止めてから、この PC で再開します。 |
| `confirm.takeover.workingStrong` | device | {device} で作業中です |
| `confirm.takeover.workingText` | | 止めるとそのターンは途中で切れます。そのあと、この PC で再開します。 |
| `confirm.takeover.action` | | 止めて引き継ぐ |
| `confirm.takeover.staleTitle` | device | {device} が応答していません。この PC で引き継ぎますか |
| `confirm.takeover.lastSeen` | when | 最後の応答：{when} |
| `confirm.takeover.forceAction` | | このまま引き継ぐ |

振る舞い：生きたロック（`stale` でない）は `mode: 'takeover'`、題は `confirm.takeover.title`、カードと黄の帯は今のまま、その上に赤みの帯（`working` なら作業中の 2 文、そうでなければ実行中の 2 文）、ボタンは「止めて引き継ぐ」。`stale` のロックは `mode: 'stale'`、題は `confirm.takeover.staleTitle`、前の PC のカードの `at` を `confirm.takeover.lastSeen`（`relativeTime(t, heartbeatAt, now)`）にし、赤みの帯は出さず、ボタンは「このまま引き継ぐ」、取り消しは今の「キャンセル」。ロックが無ければ今のまま（`mode: 'resume'`）。承諾は `mode` が `resume` なら今の `session.resumeHere`、それ以外は `session.takeover.start`（`force` は `mode === 'stale'`）。生きたロックは「この PC で再開」を押せなくする理由にしない（`resumeHereOf` と `canResumeHere`）。

- [ ] **Step 1: 試験を書く**

`handover.test.ts` の `resumeHerePlan` の節に足す。

```ts
it('ほかの PC の生きたロックを lock に載せ、busy なら working', () => {
  expect(resumeHerePlan(db, 'pc-a', 's1', { now })?.lock).toEqual({ deviceName: 'pc-b', stale: false, working: true, heartbeatAt: hb });
});
it('ロックが無ければ lock は null', () => { expect(resumeHerePlan(db, 'pc-a', 's2', { now })?.lock).toBeNull(); });
```

`presenters/resumeHere.test.ts` に足す。

```ts
it('生きたロックは押せる（理由にしない）', () => { expect(resumeHereOf(store, lockedSession, t)?.disabled).toBeNull(); });
it('アイドルの相手には実行中の帯と「止めて引き継ぐ」', () => {
  const p = presentResumeHere(t, planWith({ stale: false, working: false }), null, now);
  expect(p).toMatchObject({ mode: 'takeover', title: 'ほかの PC で動いている会話を、この PC で引き継ぎますか', action: '止めて引き継ぐ' });
  expect(p.takeover).toEqual({ strong: 'pc-b で実行中です', text: '引き継ぐと、pc-b の claude を止めてから、この PC で再開します。' });
});
it('作業中の相手には作業中の帯', () => {
  expect(presentResumeHere(t, planWith({ stale: false, working: true }), null, now).takeover).toEqual({ strong: 'pc-b で作業中です', text: '止めるとそのターンは途中で切れます。そのあと、この PC で再開します。' });
});
it('stale の相手は題を替え、前の PC のカードに最後の応答を出す', () => {
  const p = presentResumeHere(t, planWith({ stale: true, heartbeatAt: now - 5 * 60_000 }), null, now);
  expect(p).toMatchObject({ mode: 'stale', title: 'pc-b が応答していません。この PC で引き継ぎますか', action: 'このまま引き継ぐ', takeover: null });
  expect(p.from.at).toBe('最後の応答：5 分前');
});
```

`views/ConfirmDialog.test.tsx` を作る（ほかの view の試験と同じ描き方で、`emit` を捕まえる）。

```ts
it('takeover の 1 枚は赤みの帯を出し、承諾で session.takeover.start（force: false）を送る', () => {
  expect(screen.getByRole('note', { name: /pc-b で実行中です/ })).toBeTruthy();
  click('止めて引き継ぐ');
  expect(emitted).toEqual([{ type: 'session.takeover.start', id: 's1', force: false }]);
});
it('stale の 1 枚の承諾は force: true', () => { /* ... */ });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/runs/handover.test.ts packages/ui/src/presenters/resumeHere.test.ts packages/ui/src/views/ConfirmDialog.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`resumeHerePlan` に `sessionLock` の結果を足し、経路（`GET /sessions/:id/resume-here`）から `now` を渡す。presenter、view、CSS、i18n を上の表と振る舞いのとおりにする。赤みの帯の色は `styles/sync.css` の既存の警告と危険のトークンから取る（新しい色を足さない）。

- [ ] **Step 4: 通るのを見る**

Run: Step 2 と同じコマンドに `packages/ui/src/presenters packages/shared/src/i18n` を足し、続けて `npm run typecheck`。
Expected: PASS（i18n の配置と用語の試験も通る）

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/api.ts packages/shared/src/action.ts packages/server/src/runs/handover.ts packages/server/src/runs/handover.test.ts packages/server/src/http/routes/runs.ts packages/ui/src/presenters packages/ui/src/views/ConfirmDialog.tsx packages/ui/src/views/ConfirmDialog.test.tsx packages/ui/src/styles/sync.css packages/shared/src/i18n
git commit -m "feat(ui): offer to take over a session running on another computer"
```

---

### Task 6: 待っている間と、返事がないとき（B1 と C2）

**Files:**
- Modify: `packages/shared/src/action.ts`（`session.takeover.extend`、`session.takeover.cancel`）
- Modify: `packages/ui/src/mediator/types.ts`（確認の `takeover`、効果 3 つ）
- Modify: `packages/ui/src/mediator/resumeHere.ts`
- Modify: `packages/ui/src/runtime/api.ts`、`packages/ui/src/runtime/runtime.ts`
- Modify: `packages/ui/src/presenters/resumeHere.ts`（`presentTakeover`）
- Modify: `packages/ui/src/presenters/confirm.ts`（確認の `takeover` を props に）
- Modify: `packages/ui/src/views/ConfirmDialog.tsx`（`TakeoverProgress`）
- Modify: `packages/ui/src/styles/sync.css`（`.rh-steps`、`.rh-meter`）
- Modify: `packages/shared/src/i18n/keys/confirm.ts`、`ja/confirm.ts`、`en/confirm.ts`
- Test: `packages/ui/src/mediator/resumeHere.test.ts`（新規）、`packages/ui/src/presenters/resumeHere.test.ts`、`packages/ui/src/views/ConfirmDialog.test.tsx`

**Interfaces:**
- Consumes: Task 4 の `TakeoverDto`、`TAKEOVER_TIMEOUT_MS`、`takeover.update`、4 つの経路。Task 5 の `session.takeover.start`。
- Produces:
  - UiAction `{ type: 'session.takeover.extend'; id: SessionId }`、`{ type: 'session.takeover.cancel'; id: SessionId }`
  - 確認 `{ kind: 'takeover'; sessionId: string; plan: ResumeHerePlanDto; takeover: TakeoverDto | null }`
  - 効果 `{ kind: 'api.takeoverStart'; sessionId: string; force: boolean }`、`{ kind: 'api.takeoverExtend'; sessionId: string }`、`{ kind: 'api.takeoverCancel'; sessionId: string }`
  - `Api.takeoverStart(sessionId, force): Promise<TakeoverDto>`、`takeoverExtend(sessionId): Promise<TakeoverDto>`、`takeoverCancel(sessionId): Promise<void>`。runtime は応答の `TakeoverDto` を `takeover.update` のサーバの知らせと同じ道で流す。
  - `type TakeoverStep = { label: string; state: 'done' | 'active' | 'todo' }`
  - `type TakeoverProps = { sessionId: string; kind: 'progress' | 'timeout'; title: string; lead: string | null; steps: TakeoverStep[]; startedAt: number; deadline: number; hint: string | null; band: { strong: string; text: string } | null }`
  - `presentTakeover(t: Translate, plan: ResumeHerePlanDto, dto: TakeoverDto | null): TakeoverProps`

文言（日本語、`confirm.takeover.*` の続き）：

| 鍵 | 引数 | 日本語 |
| --- | --- | --- |
| `progressTitle` | device | {device} から引き継いでいます |
| `stepAsked` | | 止めるよう頼みました |
| `stepWaiting` | device | {device} が止まるのを待っています |
| `stepReceive` | | 最後のトランスクリプトを受け取る |
| `stepResume` | | この PC で再開する |
| `elapsed` | seconds | {seconds} 秒 |
| `hint` | device | {device} の Hangar がクラウドを見に来るまで、最大 30 秒ほどかかります。 |
| `cancel` | | 取り消す |
| `timeoutTitle` | device | {device} から返事がありません |
| `timeoutLead` | device | {device} の Hangar が閉じているか、ネットにつながっていない可能性があります。 |
| `timeoutStrong` | | このまま引き継ぐと、会話が分かれることがあります |
| `timeoutText` | device | {device} の claude はまだ動いている可能性があります。そちらで続きが書かれると、その分はこの PC の会話に入りません。claude は、次に {device} で Hangar が動いたときに止まります。 |
| `wait` | | もう少し待つ |

段と表示：`asking` は 1 段目が active、`waiting` は 1 段目 done と 2 段目 active（経過秒を添える）、`receiving` は 3 段目 active、`ready` は 4 段目 active。`dto` が null（応答待ち）は `asking` と同じ。`timeout` は `kind: 'timeout'` で、題と文と黄の帯を上の表に替え、ボタンは「取り消す」「もう少し待つ」「このまま引き継ぐ」（`confirm.takeover.forceAction`）。進み具合の細い線は `(now - startedAt) / (deadline - startedAt)` で、経過秒と線は view が 1 秒ごとに描き直す（mediator は時計を持たない）。

mediator の規則：

- `session.takeover.start` は、確認の `resumeHere` が出ていればそれを `takeover`（`takeover: null`）に替え、`timeout` の `takeover` が出ていればそのまま、効果 `api.takeoverStart` を出す。
- `takeover.update` は、同じ会話の `takeover` が出ているときだけ受ける。`ready` なら確認を閉じ、`launch` を `submitting` にして、効果 `api.resumeHere`（`overwrite` は `plan.replace !== null`）。`cancelled` なら閉じる。それ以外は `takeover` を差し替える。
- `session.takeover.cancel` は確認を閉じて `api.takeoverCancel`。`session.takeover.extend` は `api.takeoverExtend`。
- `takeover` の 1 枚の Esc と外側のクリックは、`overlay.close` ではなく `session.takeover.cancel` を送る（view で `close` を差し替える）。サーバに待ちを残さないためである。
- 再開が 409 の `code: 'locked'` で断られたら、今の失敗のトーストに文を出す（`runtime/api.ts` は `local_smaller` と取り違えない）。

- [ ] **Step 1: 試験を書く**

`mediator/resumeHere.test.ts` を作る（`strayResume.test.ts` と同じ道具。サーバの知らせは `{ kind: 'server', event }` の入力で、`server(e)` はその作り手）。

```ts
it('確認から始めると、同じ 1 枚が進み具合に変わり、頼みを送る', () => {
  const r = transition(withResumeHereConfirm, store, action({ type: 'session.takeover.start', id: 's1', force: false }));
  expect(r.state.overlay).toEqual({ kind: 'confirm', confirm: { kind: 'takeover', sessionId: 's1', plan, takeover: null } });
  expect(r.effects).toEqual([{ kind: 'api.takeoverStart', sessionId: 's1', force: false }]);
});
it('ready が届いたら閉じて、今の再開に入る', () => {
  const r = transition(waiting, store, server({ type: 'takeover.update', takeover: { ...dto, stage: 'ready' } }));
  expect(r.state.overlay).toEqual({ kind: 'none' });
  expect(r.state.launch).toEqual({ kind: 'submitting' });
  expect(r.effects).toEqual([{ kind: 'api.resumeHere', sessionId: 's1', overwrite: false }]);
});
it('ほかの会話の知らせと、閉じた後の知らせは無視する', () => { /* state がそのまま、effects は [] */ });
it('取り消すと閉じて取り下げを送る', () => { expect(r.effects).toEqual([{ kind: 'api.takeoverCancel', sessionId: 's1' }]); });
it('返事がない 1 枚の「このまま引き継ぐ」は force: true で送る', () => { expect(r.effects).toEqual([{ kind: 'api.takeoverStart', sessionId: 's1', force: true }]); });
```

`presenters/resumeHere.test.ts` に足す。

```ts
it('waiting は 1 段目が済み、2 段目が進行中で、題と注記を出す', () => {
  const p = presentTakeover(t, plan, { ...dto, stage: 'waiting' });
  expect(p.title).toBe('pc-b から引き継いでいます');
  expect(p.steps.map((s) => s.state)).toEqual(['done', 'active', 'todo', 'todo']);
  expect(p.hint).toBe('pc-b の Hangar がクラウドを見に来るまで、最大 30 秒ほどかかります。');
});
it('timeout は警告の 1 枚にする', () => {
  expect(presentTakeover(t, plan, { ...dto, stage: 'timeout' })).toMatchObject({ kind: 'timeout', title: 'pc-b から返事がありません', band: { strong: 'このまま引き継ぐと、会話が分かれることがあります' } });
});
```

`views/ConfirmDialog.test.tsx` に足す。

```ts
it('返事がない 1 枚は 3 つのボタンを出し、それぞれの UiAction を送る', () => {
  click('取り消す'); click('もう少し待つ'); click('このまま引き継ぐ');
  expect(emitted).toEqual([{ type: 'session.takeover.cancel', id: 's1' }, { type: 'session.takeover.extend', id: 's1' }, { type: 'session.takeover.start', id: 's1', force: true }]);
});
it('待っている間のボタンは「取り消す」だけで、Esc でも取り下げを送る', () => { /* ... */ });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/mediator/resumeHere.test.ts packages/ui/src/presenters/resumeHere.test.ts packages/ui/src/views/ConfirmDialog.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

上の規則と表のとおりに mediator、runtime、presenter、view、CSS、i18n を足す。

- [ ] **Step 4: 通るのを見る**

Run: Step 2 と同じコマンドに `packages/ui/src/mediator packages/shared/src/i18n` を足し、続けて `npm run typecheck`。
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/action.ts packages/ui/src/mediator packages/ui/src/runtime/api.ts packages/ui/src/runtime/runtime.ts packages/ui/src/presenters packages/ui/src/views/ConfirmDialog.tsx packages/ui/src/views/ConfirmDialog.test.tsx packages/ui/src/styles/sync.css packages/shared/src/i18n
git commit -m "feat(ui): show takeover progress and the no-reply choice in the same dialog"
```

---

### Task 7: 引き継がれた側の表示（D1）

**Files:**
- Modify: `packages/shared/src/api.ts`（`SessionDto.takenOver?`）
- Modify: `packages/server/src/db/queries.ts`（`takenOverMap`、`toSessionDto`）
- Modify: `packages/ui/src/presenters/session.ts`（`takenOver` の 1 行）
- Modify: `packages/ui/src/views/SessionScreen.tsx`（見出しの下の灰色の 1 行）
- Modify: `packages/shared/src/i18n/keys/session.ts`、`ja/session.ts`、`en/session.ts`
- Test: `packages/server/src/db/queries.test.ts`、`packages/ui/src/presenters/sessionScreen.test.ts`、`packages/ui/src/views/SessionScreen.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `takeovers`、Task 2 の `end_reason = 'taken_over'`。
- Produces:
  - `SessionDto.takenOver?: { deviceName: string; at: number } | null`（古いサーバは送らない）
  - `SessionProps.takenOver: string | null`

規則：この PC の最後の run（`started_at` の降順）が `taken_over` で終わっていれば値を持つ。`deviceName` はその run を指す `takeovers` の `from_device` の PC の名前、無ければその後に始まったほかの PC の run の PC の名前、どちらも無ければ `devices` の行の無い id。`at` はその run の `ended_at`。この PC で後から run を起こせば消える。知らせの札は出さず、一覧の行は今のまま。

文言（`session.takenOver`、引数 `device` と `at`）：`{device} に引き継がれました（{at}）。いまは {device} で動いています。` `at` は `absoluteTime(t, at)`。

- [ ] **Step 1: 試験を書く**

```ts
// queries.test.ts
it('この PC の最後の run が taken_over なら takenOver に頼んだ PC と止めた時刻を載せる', () => {
  expect(getSession(db, [], 's1', { deviceId: 'pc-b' })?.takenOver).toEqual({ deviceName: 'pc-a', at: 5000 });
});
it('この PC で後から run を起こしたら takenOver は null', () => { /* ... */ });
// presenters/sessionScreen.test.ts
it('引き継がれた会話は見出しの下の 1 行を持つ', () => {
  expect(props.takenOver).toBe('pc-a に引き継がれました（2026-10-16 10:00）。いまは pc-a で動いています。');
});
// views/SessionScreen.test.tsx
it('takenOver の 1 行を見出しの下に出す', () => { expect(screen.getByText(/に引き継がれました/)).toBeTruthy(); });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/db/queries.test.ts packages/ui/src/presenters/sessionScreen.test.ts packages/ui/src/views/SessionScreen.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`takenOverMap` は `lockMap` と同じく一覧の 1 回の問い合わせで引く（会話ごとに問い合わせない）。

- [ ] **Step 4: 通るのを見る**

Run: Step 2 と同じコマンドの後に `npm run typecheck`。
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/api.ts packages/server/src/db/queries.ts packages/server/src/db/queries.test.ts packages/ui/src/presenters/session.ts packages/ui/src/presenters/sessionScreen.test.ts packages/ui/src/views/SessionScreen.tsx packages/ui/src/views/SessionScreen.test.tsx packages/shared/src/i18n
git commit -m "feat(ui): tell the taken-over computer where the session went"
```

---

### Task 8: 設計書を書き直し、全体を確かめる

**Files:**
- Modify: `docs/design.md`（「他端末セッションのロックと『この PC で再開』」の節、「互換の版番号」の版の経緯の表と本文）

**Interfaces:**
- Consumes: Task 1〜7 の名前と値。
- Produces: なし。

書くこと：

- ロックの節：「`stale` のときだけ押せる」と「引き継ぎは作らない」の段落を、引き継ぎの流れに置き換える。2 つの表と書き手が 1 台ずつである理由、頼まれた側の止め方と 2 度の上げ、応答の版と台帳の突き合わせ、5 秒の取りに行きと 90 秒の打ち切り、運べないときにすぐ打ち切る、`POST /resume-here` のロックの見直し（409 の `locked`）、`live_status` を heartbeat に載せる（状態が変わるたびには書かない）、`revive` の除外、行を 30 日で消す、引き継がれた側の 2 つの表示。画面の 4 つ（A1、B1、C2、D1）と `TakeoverDto` の段。
- 互換の節：表に版 6 の行（Worker が `takeovers` と `takeover_answers` を受け取る。端末は Worker の版が 6（`TAKEOVER_MIN_WORKER_COMPAT`）に届くまで行を書かない。下限は上げない）。古い PC には頼みが届かず打ち切りの経路に落ちることを 1 行。

- [ ] **Step 1: 書き直す**

上のとおりに書く。名前と値は Task 1〜7 の Interfaces と一字一句そろえる。

- [ ] **Step 2: 全体を確かめる**

Run: `npm run typecheck`
Expected: エラーなし

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 3: コミット**

```bash
git add docs/design.md
git commit -m "docs: describe taking over a session from another computer"
```
