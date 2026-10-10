# 段 1 PR 5 端末の見張りを消し、上限による失敗で退く Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端末が無料枠を数えて 80% で止める見張り（D4）を消し、代わりに Cloudflare の上限による失敗（D1 の上限のメッセージ、Worker の 429、`1027` を含む JSON でない応答）を受けたら次の UTC の 0 時まで退いて、日が変われば自分で戻るようにする。
使用量の見積もりは「数は不明」に替える。

**Architecture:** 共有に上限の失敗を読む約束（`cloudLimit.ts`）を置き、サーバの同期の client がそれを `LimitError` にする。
`SyncEngine` は `LimitError` を受けたら戻る時刻を `sync_state` に置いて push と pull の入口を閉じ、時刻を過ぎた最初の定期実行で自分で戻る。
本文の上げ下ろしは `LimitError` を諦めに数えない。
残っている Claude Code の設定の同期（全体計画の D6）は、`LimitError` を受けたらその回を打ち切り、ファイルごとには知らせない。
同期の状態には `limitedUntil` を載せ、画面は今の「無料枠で停止 · X に戻る」をそのまま出す。
見張り（`QuotaCounter`、`countingClient`、`D1_WRITES_*`、台数割り、`pausedReason`、`quotaPausedDay`）は消し、端末の名残はマイグレーションで 1 回だけ消す。

**Tech Stack:** TypeScript、React、Hono、better-sqlite3、vitest（`expectTypeOf` を含む）。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md`（「消すもの」の 3 項目めのうち端末の分、「残す境界」、「上限による失敗で退く（D4）」、「後始末」、PR の表の 5 の行、「終わりの条件」の 3 つめ）。
段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md` の D4、D8、D10 と「段階的に入れるときの約束」。

## 着手の条件

- 段 1 の PR 4（`docs/superpowers/plans/2026-10-08-stage1-pr4-db-first.md`）が main に入っている。
  この計画の試験は、PR 4 が足す古い版の DB を作る補助（`packages/server/test/oldDb.ts` の `seedDbAt`）を使う。
- Claude Code の設定の同期は残っている（全体計画の D6 を 2026-10-09 に取り消し、PR 4 は設定の同期を消さない形に書き直した）。
  この計画のコードと試験の固定値は、その形（`SyncStatusDto` に `claudeConfig` がある、`RemotePuller.pullNow()` が `{ downloaded, configEntries }` を返す、`ClaudeConfigSync` と `configSyncActive` がある）で書いてある。
  着手のときに `git grep -n "class ClaudeConfigSync" -- packages/server/src/sync/claudeConfig.ts` が 1 行を返すことを確かめ、返さなければ手を止めて親に知らせる。
- 段 0 の DB の自動控え（`packages/server/src/db/backup.ts`）は main `33ca14e` に入っている。
- マイグレーションの版は、この計画を書き直した時点の main で 15 が最後で、PR 4 はマイグレーションを足さないので、この PR は 16 を使う。
  着手のときに `git grep -n "version: " -- packages/server/src/db/migrations.ts` の最後の行で数え直し、15 でなければ、この計画の 16 をすべて「最後の版 + 1」に、15 を「最後の版」に読み替える。

## Global Constraints

- PR 5 の中身は「端末の見張りを消し、上限による失敗で退く処理を入れる。使用量の見積もりを『数は不明』に替える」で、入れる条件は「段 0 の DB の自動控えが入っている。写しの DB で 1 日使ってから入れる」である（spec の PR の表）。
- CI が緑になっても、Task 11 の 1 日の試しが終わるまでマージしない。
  CLAUDE.local.md の「CI が緑なら聞かずにマージ」より、spec の入れる条件を先に守る。
- Worker（`packages/cloud`）には触らない。
  台帳（`meter.ts`、`meteredBatch`、`meteredRun`）、`d1RowsToday` を返すこと、D1 の失敗を 500 で返すことは、PR 6 で直す。
  共有の `PushChangesResponse.d1RowsToday` と `PullChangesResponse.d1RowsToday` は Worker が作るので残し、端末が読まなくなるだけにする。
  偽のクラウドの台帳（`D1_ROWS`、`d1RowsToday()`、`fake-cloud-usage.test.ts`）も Worker の写しなので残す。
- Worker が上限の失敗を 429 で返すのは PR 6 からである。
  いまの Worker は D1 の失敗をすべて `{"error":"internal error"}` の 500 に包むので、この PR が入ってから PR 6 が配備されるまでのあいだ、D1 の上限は端末に「上限」として届かない（`1027` は Worker を通らないので、この PR から届く）。
  そのあいだの D1 の上限の日は、端末は退かずに `error` を出し、30 秒ごとに試し直す（Free は課金されない）。
- 残す境界：`PausedPass`、`deviceCount`（CLI の `hangar cloud status` が出す）、`CloudUsagePoller` と使用量の表示、Worker の `/usage`、`CLOUD_FREE_LIMITS`、パスの検査、`sessions.provider` と `files.kind`、`tableColumns`、`cloud.json` の床の保険。
- Claude Code の設定の同期は残す（全体計画の D6）。
  `sync/claudeConfig.ts`、`configSyncActive`、puller の config の経路、`SyncStatusDto.claudeConfig` と `SyncEngine.setClaudeConfigStatus`、1 巡（`PausedPass`）の `config` の段を、見張りを消すときに一緒に消さない。
  設定の同期は `isPaused`（`engine.status().state === 'paused'`）を見て止まるので、上限で退いている間（状態は `paused`）も押し出さない。
- 上限は Free のときだけ当たるので、ヘッダーの文は今の「無料枠で停止 · X に戻る」をそのまま使う（spec）。
  X は戻る時刻（次の UTC の 0 時）を端末の時刻で書いたものである。
- 画面の見た目が変わる所（Task 5 と Task 7）は、Task 1 の試作で利用者が選ぶまで実装しない。
  ほかのタスクは、選ぶのを待たずに進めてよい。
- 消す前に、消すものごとに `git grep` をもう一度回し、使っているのが消す範囲の中だけであることを確かめる（spec の決まり）。
- 永続する識別子（DB の表名と列名、同期で運ぶ payload）は改名しない（D8）。
  `SyncStatusDto` と `CloudUsageDto` は画面とサーバの間だけで閉じる型で、同じ束で配るので、spec が名指しした `pausedReason` と `quotaPausedDay` を消し、`limitedUntil` を足す。
- Worker を配備しない。
  実物のクラウドに触る確かめは、利用者に聞いてから、使う無料枠の見積もりを添えて行う（Task 11）。
  行わなかったときは、報告に「実物では未確認」と書く。
- 4177 のサーバ、`/Applications/Hangar.app`、実物の `~/.agent-hangar` には、Task 11 で DB と設定を読んで写す以外に触らない。
  `tmux kill-server` は呼ばない。
- 行番号は main `33ca14e` で数えた。
  PR 4 と前のタスクで行がずれるので、行番号は目安とし、引用した文で当てる。
- 作業は main から切った新しい worktree で行い、着手の前に `npm ci` を打つ。
- コマンドはリポジトリの根で 1 本ずつ打つ（git と他のコマンドを `&&` でつながない）。
- 試験は `npx vitest run <ファイルかディレクトリ>`、型は `npm run typecheck`（1 つの包みだけなら `npm run typecheck -w packages/<名前>`）。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける（`git commit -m "<件名>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`）。
- 文書とコードのコメントは日本語の一文一行で書き、中黒と em ダッシュを使わない。
- 公開リポジトリなので、実在の人名、メール、手元のパス、使用量、Worker の URL、実際のスキル名を、コード、試験、文書、試作、コミットに書かない。

## Review Focus

- **上限で退いている間にサーバを立て直す**：立て直した直後に外へ出ず、戻る時刻までそのまま退き、時刻を過ぎていれば最初の要求から戻る（Task 6 の立て直しの試験で留める）。
- **`1027` の頁が 4xx で、版の見出しを持たずに届く**：版の不一致（Worker が古い）と取り違えず、本文の上げも諦めない（Task 3 と Task 4 の試験で留める）。
- **利用者が一時停止しているあいだに上限に当たり、その後に再開する**：一時停止中は「一時停止中」と見せ（ボタンは「同期を再開」）、再開した後は戻る時刻まで「無料枠で停止」と見せ、ボタンは「今すぐ同期」だけにする（Task 1 の Q4 の案 B。Task 6 と Task 7 の試験で留める）。
- **上限で退いた後に「今すぐ同期」を押す**：1 回だけ試し直し、まだ断られればまた次の 0 時まで退いて知らせ、通れば戻る（Task 6 の試験で留める）。
- **見張りが止めていた端末（`pausedReason` が `quota`）を入れ替える**：マイグレーションで一時停止を解き、利用者が止めていた端末（`user`）は止めたままにする（Task 8 の試験で留める）。
- **設定の同期を入れている端末が、エンジンより先に上限に当たる**：設定の押し出しと取り込みはその回を打ち切り、ファイルの数だけトーストを出さない。取り込めなかった設定は一覧に残り、上限が戻れば次の取り込みで書く（Task 4 の試験で留める）。

---

### Task 1: 試作で、上限で止まったときと「数は不明」の見せ方を選んでもらう

**済み（2026-10-09）。** 試作は docs の PR #35（`docs/superpowers/specs/2026-10-08-stage1-quota-backoff/usage.html`）に入れた。
文言を見直したうえで、利用者が次を選んだ。
Task 5、Task 6、Task 7、Task 9 のコードと文は、この答えに合わせて直してある。

- Q1 **案 A**：札 3 枚とも値の無い印と「トークンが要ります」、今日の棒は描かない、出どころは「数は不明（hangar は数えません） · 今日の枠は 9:00 に戻る」。案内の帯は「Cloudflare の数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。」
- Q2 **案 A（文言を直したもの）**：帯「Cloudflare の無料枠の上限に達したので、同期を止めています。9:00 に枠が戻ると、自動で再開します。」、トースト「Cloudflare の無料枠の上限に達したので、9:00 まで同期を止めます。枠が戻ると自動で再開します」（9:00 は戻る時刻を端末の時刻で書く所）。
- Q3 **案 B**：凡例「あと 13,880 行で無料枠の上限です · 9:00 に戻る」（数と時刻は実際の値）。
- Q4 **案 B**：上限で止まっている間、ヘッダーと設定の節のボタンは「今すぐ同期」だけにし、一時停止の切り替えは出さない。「今すぐ同期」は 1 回だけ試し直し、まだ断られればまた戻る時刻まで退いてトーストで知らせる。
- Q5 **案 A**：設定の「状態」は「無料枠で停止 · 9:00 に戻る」（ヘッダーと同じ）。
- 「版」と区切りの「·」は今のまま使う。

以下の Step は、記録のために残す（この PR では試作をコミットしない。PR #35 に入っている）。

**Files:**
- Create: `docs/superpowers/specs/2026-10-08-stage1-quota-backoff/usage.html`

**Interfaces:**
- Consumes: なし。
- Produces: 利用者が選んだ 5 つの答え（Q1 から Q5）。
  Task 5、Task 6、Task 7 がこれを読む。

この PR で目に見えて変わるのは 3 か所である。
ヘッダーの同期の一行（上限で止まっている間のボタン）、設定の「状態」の語、設定の「使用量と費用」（トークンが無いときの形、止まりそうなときと止まったときの文、目盛り）である。
ヘッダーの文そのもの「無料枠で停止 · 9:00 に戻る」は spec のとおり変えない。
トーストの文も新しく決める。

- [ ] **Step 1: 試作を作る**

ブラウザで開ける 1 枚の HTML にする。
部品と CSS の変数は、既存の試作 `docs/superpowers/specs/2026-10-02-cloud-usage/usage-merged.html` を写す。
ライトだけにする（ダークは作らない。利用者の決定）。
数は作り物にする（D1 は 1 日 10 万行の 23% と 86%、Workers は 4,120 回など）。
実物の使用量、費用、Worker の URL を入れない。

並べるものは次のとおりである。
どれも「いま」と案を横に並べる。

| 問い | いま | 案 A（推す） | 案 B |
| --- | --- | --- | --- |
| Q1 トークンが無いときの「使用量と費用」 | 「約 27%」と「見積もり」の札、「約 26,700 / 100,000 行」の棒、「hangar の見積もり（実際より 1〜4 割多め）」 | 札 3 枚とも値の無い印と「トークンが要ります」、今日の棒は描かない、出どころは「数は不明（hangar は数えません） · 今日の枠は 9:00 に戻る」、案内の帯とコマンドはそのまま | 案 A の札と出どころで、今日の棒を値の無い印のまま 2 本描く |
| Q2 上限で止まったときの帯とトースト | 帯「無料枠の 80% に届いたので同期を止めました。9:00 に枠が戻ります。戻ったあと『同期を再開』で再開できます。」 | 帯「Cloudflare の無料枠の上限に届いたので、同期を止めています。9:00 に枠が戻ると、自分で再開します。」、トースト「Cloudflare の無料枠の上限に届いたので、9:00 まで同期を止めます。枠が戻ると自分で再開します」 | 帯「無料枠の上限に届きました。9:00 に自分で再開します。」、トースト「無料枠の上限に届きました。9:00 に自分で再開します」 |
| Q3 止まりそうなとき（上限の 80% 以上）の凡例 | 「あと 11,880 行で同期を止めます · 9:00 に戻る」（止める線の 75% から） | 「あと 13,880 行で Cloudflare が書き込みを断ります · 9:00 に戻る」 | 「あと 13,880 行で無料枠の上限です · 9:00 に戻る」 |
| Q4 上限で止まっている間のヘッダーのボタン | 「今すぐ同期」と「同期を再開」 | 「今すぐ同期」と「同期を一時停止」（利用者は止めていないので） | 「今すぐ同期」だけ |
| Q5 設定の「状態」の語（上限で止まっている間） | 「一時停止中」 | 「無料枠で停止 · 9:00 に戻る」（ヘッダーと同じ） | 「一時停止中」のまま |

どの案でも、今日の棒の目盛り（止める線の 80%）は消す（止める線が Cloudflare の上限そのものになったため）。
ふだんの凡例は「今日の枠は 9:00 に戻る」だけになる（「目盛りの 80% で同期を止める」を消す）。
これは問いにせず、試作の「いま」と案の両方の列で見せる。

- [ ] **Step 2: 利用者に選んでもらう**

試作をブラウザで開き、AskUserQuestion で Q1 から Q5 を 1 問ずつ聞く。
選択肢は案 A（推奨）、案 B の順に置く。
選ぶまで Task 5 と Task 7 には入らない。

- [ ] **Step 3: 選んだ案を書き残してコミットする**

この計画の Task 5 と Task 7 の冒頭の「選んだ案：」の行に、Q1 から Q5 の答えを書き足す。

```bash
git add docs/superpowers/specs/2026-10-08-stage1-quota-backoff/usage.html docs/superpowers/plans/2026-10-08-stage1-pr5-quota-backoff.md
```

```bash
git commit -m "docs: add the prototype for the quota back-off and unknown usage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 共有に、上限の失敗を読む約束を置く

**Files:**
- Create: `packages/shared/src/cloudLimit.ts`
- Create: `packages/shared/src/cloudLimit.test.ts`
- Modify: `packages/shared/src/index.ts`（末尾に輸出を 1 行足す）

**Interfaces:**
- Consumes: なし。
- Produces（`@agent-hangar/shared` から取れる）：
  - `type CloudLimitKind = 'd1-read' | 'd1-write' | 'requests'`
  - `D1_LIMIT_MESSAGES: { 'd1-read': string; 'd1-write': string }`
  - `type CloudLimitBody = { error: 'limit'; limit: CloudLimitKind; resetAt: number }`（PR 6 の Worker が 429 で返す本文）
  - `nextUtcMidnight(now: number): number`
  - `d1LimitOf(message: string): 'd1-read' | 'd1-write' | null`
  - `readCloudLimit(status: number, text: string): CloudLimitKind | null`

置き場は新しい `cloudLimit.ts` にする。
PR 6 で Worker も `d1LimitOf` と `CloudLimitBody` を使うので、Worker と端末の両方が読む共有に置く。

- [ ] **Step 1: 依存を入れる**

worktree に `node_modules` が無ければ、リポジトリの根で打つ。

```bash
npm ci
```

- [ ] **Step 2: 試験を書く**

`packages/shared/src/cloudLimit.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import { d1LimitOf, D1_LIMIT_MESSAGES, nextUtcMidnight, readCloudLimit } from './cloudLimit.ts';
import * as shared from './index.ts';

describe('上限の失敗を読む', () => {
  it('パッケージの入口から取れる', () => {
    expect(shared.readCloudLimit).toBe(readCloudLimit);
    expect(shared.nextUtcMidnight).toBe(nextUtcMidnight);
  });

  it('戻る時刻は次の UTC の 0 時で、ちょうど 0 時なら翌日の 0 時', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 9, 8, 23, 59, 59, 999))).toBe(Date.UTC(2026, 9, 9));
    expect(nextUtcMidnight(Date.UTC(2026, 9, 9))).toBe(Date.UTC(2026, 9, 10));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 12))).toBe(Date.UTC(2027, 0, 1));
  });

  it('D1 の失敗のメッセージから、読みと書きの上限を見分ける', () => {
    expect(d1LimitOf(`D1_ERROR: Exceeded ${D1_LIMIT_MESSAGES['d1-read']}`)).toBe('d1-read');
    expect(d1LimitOf(`D1_ERROR: Exceeded ${D1_LIMIT_MESSAGES['d1-write']}`)).toBe('d1-write');
    expect(d1LimitOf('D1_ERROR: no such table')).toBeNull();
  });

  it('Worker の 429 と上限の本文を読む（段 1 の PR 6 から）', () => {
    expect(readCloudLimit(429, JSON.stringify({ error: 'limit', limit: 'd1-write', resetAt: 1 }))).toBe('d1-write');
    expect(readCloudLimit(429, JSON.stringify({ error: 'limit', limit: 'requests', resetAt: 1 }))).toBe('requests');
    // 429 でない、種類が知らないもの、形が違うものは上限として読まない。
    expect(readCloudLimit(500, JSON.stringify({ error: 'limit', limit: 'd1-read', resetAt: 1 }))).toBeNull();
    expect(readCloudLimit(429, JSON.stringify({ error: 'limit', limit: 'other', resetAt: 1 }))).toBeNull();
  });

  it('本文に D1 の上限のメッセージがあれば、状態番号と形を問わずに読む', () => {
    expect(readCloudLimit(500, JSON.stringify({ error: `D1_ERROR: ${D1_LIMIT_MESSAGES['d1-read']}` }))).toBe('d1-read');
    expect(readCloudLimit(503, `D1_ERROR: ${D1_LIMIT_MESSAGES['d1-write']}`)).toBe('d1-write');
  });

  it('JSON でなく 1027 を含む本文は、Workers の 1 日の要求の上限として読む', () => {
    expect(readCloudLimit(429, 'error code: 1027')).toBe('requests');
    expect(readCloudLimit(403, `<html>${'x'.repeat(300)}<p>Error 1027</p></html>`)).toBe('requests');
  });

  it('上限でないものは null（例外も投げない）', () => {
    const cases: [number, string][] = [
      [200, 'error code: 1027'],
      [500, '{"error":"internal error"}'],
      [500, '{"code":1027}'],
      [429, 'too many'],
      [502, 'ray 8a1027f'],
      [500, ''],
      [404, 'nonsense'],
    ];
    for (const [s, t] of cases) expect(readCloudLimit(s, t), `${s} ${t}`).toBeNull();
  });
});
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/shared/src/cloudLimit.test.ts`
Expected: FAIL（`./cloudLimit.ts` が無いので読み込めない）。

- [ ] **Step 4: 実装する**

`packages/shared/src/cloudLimit.ts` を作る。

```ts
/**
 * Cloudflare の無料枠の 1 日の上限に当たったときの約束（作り替えの全体計画の D4）。
 *
 * hangar は量を数えない。
 * 上限に当たると Cloudflare が断るので、その失敗を見分けて、次の UTC の 0 時まで退く。
 * 見分けるのはサーバ（packages/server/src/sync/client.ts）で、Worker（段 1 の PR 6 から）は D1 の上限の失敗を 429 と下の本文で返す。
 */

/** 当たった上限。d1-read と d1-write は D1 の 1 日の行の上限、requests は Workers の 1 日の要求の上限（error 1027）である。 */
export type CloudLimitKind = 'd1-read' | 'd1-write' | 'requests';

const KINDS: readonly CloudLimitKind[] = ['d1-read', 'd1-write', 'requests'];

/**
 * D1 が上限で断ったときのメッセージに含まれる語。
 * Worker もこれを見て、D1 の失敗を 429 に替える（段 1 の PR 6）。
 */
export const D1_LIMIT_MESSAGES = {
  'd1-read': 'free tier daily row read limit',
  'd1-write': 'free tier daily row write limit',
} as const;

/** Worker が上限の失敗を返すときの 429 の本文。resetAt は次の UTC の 0 時（ミリ秒）である。 */
export type CloudLimitBody = { error: 'limit'; limit: CloudLimitKind; resetAt: number };

/** 次の UTC の 0 時。Cloudflare の 1 日の枠はここで戻る。ちょうど 0 時なら翌日の 0 時を返す。 */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** D1 の失敗のメッセージから、当たった上限を読む。上限の失敗でなければ null。 */
export function d1LimitOf(message: string): 'd1-read' | 'd1-write' | null {
  if (message.includes(D1_LIMIT_MESSAGES['d1-read'])) return 'd1-read';
  if (message.includes(D1_LIMIT_MESSAGES['d1-write'])) return 'd1-write';
  return null;
}

/**
 * 2xx でない応答が、上限による失敗かを読む。上限でなければ null を返す（例外を投げない）。
 *
 * 見分けるのは 3 つである。
 * 1. Worker の 429 と CloudLimitBody（段 1 の PR 6 から）。
 * 2. 本文に D1 の上限のメッセージを含むもの。形と状態番号は問わない。
 * 3. JSON でなく、本文に 1027 を含むもの。Workers の 1 日の要求の上限は、Worker を通らずに Cloudflare が返し、
 *    状態番号も本文の形も文書に無い（error 1027）。番号は語の境目で見る（ray ID のような 16 進の中の並びは数えない）。
 */
export function readCloudLimit(status: number, text: string): CloudLimitKind | null {
  if (status < 400) return null;
  let body: unknown;
  let isJson = true;
  try { body = JSON.parse(text); } catch { isJson = false; }
  if (isJson) {
    const b = body as Partial<CloudLimitBody> | null;
    if (status === 429 && b && b.error === 'limit' && KINDS.includes(b.limit as CloudLimitKind)) return b.limit as CloudLimitKind;
    return d1LimitOf(text);
  }
  return d1LimitOf(text) ?? (/\b1027\b/.test(text) ? 'requests' : null);
}
```

`packages/shared/src/index.ts` の末尾に 1 行足す。

```ts
export * from './cloudLimit.ts';
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/shared`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/shared/src/cloudLimit.ts packages/shared/src/cloudLimit.test.ts packages/shared/src/index.ts
```

```bash
git commit -m "feat(shared): add the contract for Cloudflare limit failures" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 同期の client が、上限の失敗を `LimitError` にする

**Files:**
- Modify: `packages/server/src/sync/client.ts:7-25`（import）、`:58-70`（`CompatError` の下に `LimitError` を足す）、`:217-262`（`send`）
- Modify: `packages/server/test/fake-cloud.ts:1-45`（import と `FakeCloudStore`）、`:150-165`（初期値）、`:166-180`（setter）、`:219-231`（`guard`）
- Test: `packages/server/src/sync/client.test.ts`

**Interfaces:**
- Consumes: Task 2 の `readCloudLimit`、`type CloudLimitKind`。
- Produces：
  - `class LimitError extends CloudError { readonly limit: CloudLimitKind }`（`client.ts`）。`status` は応答のもの、`message` は利用者に見せる文で、応答の本文ではない。
  - 偽のクラウドの `FakeCloudClient.limited: CloudLimitKind | null`。立てている間、Workers の要求の上限は全部の口を、D1 の上限は `/health` を除く口を `LimitError(limited, 429)` で断る。

`send` は、上限の検査を版の検査より先に行う。
`1027` の頁は Worker を通らずに届き、版の見出しを持たない。
状態番号が 4xx だと、今は「Worker が名乗った版」の検査に回り、下限を 1 に上げた後で「Worker が古い」と取り違える。
本文は先頭の 200 字に切る前に、全部で上限を読む（HTML の頁では `1027` が 200 字より後ろにありうる）。

- [ ] **Step 1: 試験を書く**

`packages/server/src/sync/client.test.ts` の 8 行目の import に `LimitError` を足し、末尾に足す。

```ts
describe('上限の失敗', () => {
  it('Worker の 429 と上限の本文は LimitError にする', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'limit', limit: 'd1-write', resetAt: 1 }, 429));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.pushChanges([])).rejects.toMatchObject({ name: 'LimitError', limit: 'd1-write', status: 429 });
  });

  it('本文に D1 の上限のメッセージがあれば、状態番号と形を問わずに LimitError にする', async () => {
    const cases = [
      [500, '{"error":"D1_ERROR: free tier daily row read limit"}', 'd1-read'],
      [503, 'D1_ERROR: free tier daily row write limit', 'd1-write'],
    ] as const;
    for (const [status, body, limit] of cases) {
      const { fetch } = fakeFetch(() => new Response(body, { status }));
      const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
      await expect(c.pullChanges(0, 10)).rejects.toMatchObject({ name: 'LimitError', limit, status });
    }
  });

  it('JSON でなく 1027 を含む頁は、200 字より後ろにあっても LimitError にする', async () => {
    const page = `<html>${'x'.repeat(300)}<p>error code: 1027</p></html>`;
    const { fetch } = fakeFetch(() => new Response(page, { status: 429 }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await expect(c.listFiles(0, 10)).rejects.toMatchObject({ name: 'LimitError', limit: 'requests', status: 429 });
  });

  it('上限は版の検査より先に見る。版の見出しの無い 4xx の 1027 を、Worker が古いと取り違えない', async () => {
    const { fetch } = fakeFetch(() => new Response('error code: 1027', { status: 403 }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 1 });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LimitError);
    expect(e).not.toBeInstanceOf(CompatError);
  });

  it('上限でない失敗は今までどおりの CloudError で、本文の先頭 200 字を運ぶ', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'internal error' }, 500));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).not.toBeInstanceOf(LimitError);
    expect(e).toMatchObject({ status: 500, message: '{"error":"internal error"}' });
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/client.test.ts`
Expected: FAIL（`LimitError` が無い）。

- [ ] **Step 3: `LimitError` を足し、`send` で先に見る**

`packages/server/src/sync/client.ts` の共有からの import に `readCloudLimit` と `type CloudLimitKind` を足す。

`CompatError` の定義の次に足す。

```ts
const LIMIT_LABEL: Record<CloudLimitKind, string> = {
  'd1-read': 'Cloudflare の無料枠の上限（D1 の 1 日の読み取り）に達しました',
  'd1-write': 'Cloudflare の無料枠の上限（D1 の 1 日の書き込み）に達しました',
  requests: 'Cloudflare の無料枠の上限（Workers の 1 日の要求）に達しました',
};

/**
 * Cloudflare の無料枠の 1 日の上限に当たったときに投げる（共有の readCloudLimit が見分けたもの）。
 * status は応答のもの。message は利用者に見せる文で、応答の本文ではない。
 * 受け手の SyncEngine は、次の UTC の 0 時まで退く。本文の上げ下ろしは、これを諦めに数えない。
 */
export class LimitError extends CloudError {
  constructor(readonly limit: CloudLimitKind, status: number) {
    super(status, LIMIT_LABEL[limit]);
    this.name = 'LimitError';
  }
}
```

`send` の説明のコメント（217-227 行）の最後に、次の 2 行を足す。

```ts
   * 上限の失敗（共有の readCloudLimit）は、版の検査より先に見る。
   * 端が返す 1027 の頁は版の見出しを持たないので、版の検査に回すと「Worker が古い」と取り違える。本文は 200 字に切る前に全部で読む。
```

`send` の `if (res.status === 426) { … }` の次から `return { res, d };` の前までを次にする。

```ts
    let text: string | null = null;
    if (!res.ok) {
      text = await d.race(res.text()).catch(() => '');
      const limit = readCloudLimit(res.status, text);
      if (limit !== null) {
        d.clear();
        throw new LimitError(limit, res.status);
      }
    }
    const workerCompat = parseCompat(res.headers.get(COMPAT_HEADER));
    const fromWorker = res.status < 500 && res.status !== 408 && res.status !== 429;
    if (fromWorker && workerCompat < this.minWorkerCompat) {
      if (text === null) void res.body?.cancel().catch(() => {});
      d.clear();
      throw new CompatError('worker', workerCompat, this.minWorkerCompat);
    }
    if (!res.ok) {
      d.clear();
      throw new CloudError(res.status, (text ?? '').slice(0, 200) || `HTTP ${res.status}`);
    }
```

- [ ] **Step 4: 偽のクラウドに上限を持たせる**

`packages/server/test/fake-cloud.ts` の共有の import に `type CloudLimitKind` を足し、`../src/sync/client.ts` の import に `LimitError` を足す。

`FakeCloudStore` の `minDeviceCompat: number;` の次に足す。

```ts
  /**
   * 当たっている Cloudflare の上限。null なら当たっていない。
   * Workers の要求の上限（requests）は全部の口を、D1 の上限は D1 に触らない /health を除く口を断る。
   * 実物の D1 の上限は段 1 の PR 6 から 429 で返る。偽物は先にその形で断る。
   */
  limited: CloudLimitKind | null;
```

コンストラクタの初期値の `minDeviceCompat: MIN_DEVICE_COMPAT,` の次に `limited: null,` を足す。

`set minDeviceCompat(v: number) { … }` の次に足す。

```ts
  /** 当たっている Cloudflare の上限。立てると、その上限で断る真似になる。 */
  get limited(): CloudLimitKind | null { return this.store.limited; }
  set limited(v: CloudLimitKind | null) { this.store.limited = v; }
```

`guard` の `if (this.store.offline) throw new CloudError(0, 'offline');` の次に足す。

```ts
    // 上限は Cloudflare の側で断る。Workers の要求の上限は Worker の手前なので、版の関所より先に当たる。
    if (this.store.limited !== null && (method !== 'health' || this.store.limited === 'requests')) throw new LimitError(this.store.limited, 429);
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/server/src/sync/client.test.ts packages/server/test`
Expected: PASS（`it.each([503, 429, 408])` の端の失敗の試験も、本文が `edge` なので上限にならず、そのまま通る）。

Run: `npm run typecheck -w packages/server`
Expected: PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/server/src/sync/client.ts packages/server/src/sync/client.test.ts packages/server/test/fake-cloud.ts
```

```bash
git commit -m "feat(server): turn Cloudflare limit failures into LimitError before the compat check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 本文と設定の上げ下ろしは、上限の失敗を諦めにもファイルごとの知らせにもしない

**Files:**
- Modify: `packages/server/src/sync/uploader.ts:59-66`（`isPermanentStatus` の説明）、`:480-486`（諦める分岐）
- Modify: `packages/server/src/sync/puller.ts`（`pullNowInner` の `if (err instanceof CompatError) throw err;`）
- Modify: `packages/server/src/sync/claudeConfig.ts`（import、`pushChangedNow` の 1 件ごとの `catch`、`applyPull` の 1 件ごとの `catch`）
- Test: `packages/server/src/sync/uploader.test.ts`、`packages/server/src/sync/puller.test.ts`、`packages/server/src/sync/claudeConfig.test.ts`

**Interfaces:**
- Consumes: Task 3 の `LimitError` と、偽のクラウドの `limited`。
- Produces: uploader は `LimitError` を一時の失敗として待ち行列に残す（状態番号が 4xx でも諦めない）。
  puller は `LimitError` を受けたら、項目を諦めに数えず、`filesSeq` も進めずに、その回を投げて終える（`CompatError` と同じ扱い）。
  `ClaudeConfigSync` は、押し出しでも取り込みでも `LimitError` を受けたらその回の残りを打ち切り、ファイルごとの知らせ（`reportOnce`）を出さない。
  取り込めなかった設定は一覧（`configPending`）に残り、上限が戻った後の取り込みで書く。

設定の同期（全体計画の D6 で残すことにした）は、1 件ごとの失敗をファイルの名前つきで 1 度ずつ知らせる。
上限の失敗は、どのファイルも同じ答えになるので、そのまま通すとファイルの数だけトーストが並ぶ。
上限で退いたことは、30 秒ごとの定期実行で同じ上限に当たる `SyncEngine` が 1 度だけ知らせ（Task 6）、その後は状態が `paused` になるので設定の同期は外へ出ない（`configSyncActive` と `isPaused`）。
Worker の pull も端末の行（`devices`）を書くので、D1 の書き込みの上限でもエンジンは同じ上限に当たる。
設定の同期の側は、上限に当たったらその回を黙って打ち切ればよい。

- [ ] **Step 1: 試験を書く**

`packages/server/src/sync/uploader.test.ts` の import の `CloudError` の隣に `LimitError` を足し、`it('互換の版で断られた本文は諦めず、版が合えば上げる', …)` の次に足す。

```ts
  it('上限で断られた本文は、状態番号が 4xx でも諦めず、上限が戻れば上げる', async () => {
    const up = make();
    const realPut = cloud.putFile.bind(cloud);
    cloud.putFile = (meta: FileMetaIn, body: Readable) => {
      cloud.calls.push({ method: 'putFile', args: [meta] });
      body.resume();
      return Promise.reject(new LimitError('requests', 403));
    };
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    expect(skipRow()).toBeNull();
    expect(up.skippedUploads()).toEqual([]);
    cloud.putFile = realPut;
    await up.flushAll();
    expect(cloud.files.size).toBe(1);
    up.stop();
  });
```

`packages/server/src/sync/puller.test.ts` の import の `CompatError` の隣に `LimitError` を足し、`it('互換の版で断られた回は、項目を諦めに数えず、filesSeq も進めない', …)` の次に足す。

```ts
  it('上限で断られた回は、項目を諦めに数えず、filesSeq も進めない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    const realGet = cloud.getFile.bind(cloud);
    cloud.getFile = async () => { throw new LimitError('d1-read', 429); };
    for (let i = 0; i < 3; i++) await expect(p.pullNow()).rejects.toBeInstanceOf(LimitError);
    expect(p.skippedEntries()).toEqual([]);
    expect(errors).toEqual([]);
    expect(state.getNumber('filesSeq', 0)).toBe(0);
    // 上限が戻れば、同じ項目が降りてくる。
    cloud.getFile = realGet;
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
  });
```

`packages/server/src/sync/claudeConfig.test.ts` の末尾に足す。
偽のクラウドの `limited`（Task 3）を立てると、`putFile` と `getFile` は `LimitError` で断られる。
相手の設定は、`limited` を立てる前に `remotePut` で置いておく（立てた後は置く側も断られる）。

```ts
describe('上限で断られたとき', () => {
  it('押し出しはその回を打ち切り、ファイルごとに知らせない。上限が戻れば上げる', async () => {
    write('CLAUDE.md', '# hi\n');
    write('memory/x.md', 'memo\n');
    const c = make();
    cloud.limited = 'd1-write';
    expect(await c.pushChanged()).toBe(0);
    expect(toasts).toEqual([]);
    cloud.limited = null;
    expect(await c.pushChanged()).toBe(2);
    expect(toasts).toEqual([]);
    c.stop();
  });

  it('取り込みはその回を打ち切り、ファイルごとに知らせず、一覧に残して上限が戻ればやり直す', async () => {
    const e1 = await remotePut('CLAUDE.md', '# from mini\n');
    const e2 = await remotePut('memory/x.md', 'memo\n');
    const c = make();
    c.confirm();
    cloud.limited = 'd1-read';
    expect(await c.applyPull([e1, e2])).toEqual({ applied: 0, conflicts: 0, backedUp: 0 });
    expect(toasts).toEqual([]);
    expect(c.pendingRemote().map((x) => x.key).sort()).toEqual(['config/dev-b/CLAUDE.md', 'config/dev-b/memory/x.md']);
    cloud.limited = null;
    expect(await c.applyPull([])).toEqual({ applied: 2, conflicts: 0, backedUp: 0 });
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# from mini\n');
    expect(c.pendingRemote()).toEqual([]);
    c.stop();
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/uploader.test.ts packages/server/src/sync/puller.test.ts packages/server/src/sync/claudeConfig.test.ts -t "上限で断られた"`
Expected: FAIL。
uploader は 403 を直りようのない 4xx として控えに残し、puller は 3 回で項目を諦める。
設定の同期は、ファイルごとに「同期に失敗しました」と「取り込みに失敗しました」を 2 件ずつ知らせる。

- [ ] **Step 3: 実装する**

`packages/server/src/sync/uploader.ts` の import の `CloudError` の隣に `LimitError` を足す（`./client.ts` から）。

`isPermanentStatus` の説明の「426 は互換の版が合わないときで、…（client.ts の CompatError）。」の次に 1 行足す。

```ts
 * 上限の失敗（client.ts の LimitError）は、状態番号に依らず一時の失敗として扱う。端の 1027 は 4xx で届きうる。
```

諦める分岐 `if (e instanceof CloudError && isPermanentStatus(e.status)) {` を次にする（中身はそのまま）。

```ts
      if (e instanceof CloudError && !(e instanceof LimitError) && isPermanentStatus(e.status)) {
```

その上のコメント「4xx（408 と 429 を除く）は何度送っても同じ答えなので、ここで諦めて控えに残す。」を「4xx（408 と 429 と上限の失敗を除く）は何度送っても同じ答えなので、ここで諦めて控えに残す。」にする。

`packages/server/src/sync/puller.ts` の import の `CompatError` の隣に `LimitError` を足し、`pullNowInner` の次の 2 行を直す。

```ts
          // 版が合わずに断られたのと、上限で断られたのは、この項目のせいではない。諦めに数えずに回ごと止め、filesSeq も進めない。
          if (err instanceof CompatError || err instanceof LimitError) throw err;
```

設定の束（`onConfigEntries`）の `catch` には足さない。
取り込み（`ClaudeConfigSync.applyPull`）は 1 件ごとの失敗を中で受け止めて投げないので、上限の失敗はそこまで届かない。

`packages/server/src/sync/claudeConfig.ts` の `import type { CloudClient } from './client.ts';` を `import { LimitError, type CloudClient } from './client.ts';` にする。

`pushChangedNow` の 1 件ごとの `catch (e) {` の、`reportOnce` の上のコメントの前に足す。

```ts
        // 上限で断られたのは、このファイルのせいではない。残りのファイルも同じ答えなので、その回を打ち切り、ファイルごとには鳴らさない。
        // 退いたことは、同じ上限に当たる SyncEngine が 1 度だけ知らせる。その後は状態が paused になり、ここへは来ない（server.ts の configSyncActive）。
        if (e instanceof LimitError) break;
```

`applyPull` の 1 件ごとの `catch (err) {` の、`// 控えに失敗した分もここに落ちる。` の前に足す。

```ts
        // 上限で断られた回は、残りも同じ答えなので打ち切り、ファイルごとには鳴らさない。
        // 片付いていない分は一覧（configPending）に残るので、上限が戻った後の取り込みでやり直す。
        if (err instanceof LimitError) break;
```

`break` の後も、控えの知らせ、`statusLine` の実行の許し、一覧の書き戻しは今までどおり走る（打ち切る前に書けた分だけが片付き、残りは一覧に残る）。

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/server/src/sync/uploader.test.ts packages/server/src/sync/puller.test.ts packages/server/src/sync/claudeConfig.test.ts`
Expected: PASS。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/sync/uploader.ts packages/server/src/sync/uploader.test.ts packages/server/src/sync/puller.ts packages/server/src/sync/puller.test.ts packages/server/src/sync/claudeConfig.ts packages/server/src/sync/claudeConfig.test.ts
```

```bash
git commit -m "feat(server): do not give up on transcripts or flood config toasts when refused by a Cloudflare limit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 使用量の見積もりを「数は不明」に替える

選んだ案：Q1 は案 A、Q2 は案 A（文言を直したもの）、Q3 は案 B（Task 1 の冒頭）。下のコードと試験の文は、この答えに合わせてある。

**Files:**
- Modify: `packages/shared/src/api.ts`（`CloudUsageDto` とその説明）
- Modify: `packages/server/src/sync/usage.ts`（ファイル全体）
- Modify: `packages/server/src/server.ts`（`new CloudUsagePoller({ … })` の 1 行）
- Modify: `packages/ui/src/presenters/cloudUsage.ts`（ファイル全体）
- Modify: `packages/ui/src/views/CloudUsage.tsx:30`（目盛り）
- Modify: `packages/ui/src/styles/settings.css`（`.cu-tick` の規則）
- Test: `packages/server/src/sync/usage.test.ts`、`packages/ui/src/presenters/cloudUsage.test.ts`（ファイル全体）、`packages/ui/src/views/misc.test.tsx`、`packages/ui/src/store/store.test.ts`、`packages/ui/src/runtime/runtime.test.ts`、`packages/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: Task 2 の `nextUtcMidnight`。
- Produces：
  - `CloudUsageDto.source: 'cloudflare' | 'unknown'`（`'estimate'` が消える）。
  - `CloudUsageDto.limits: { d1RowsPerDay: number; workersRequestsPerDay: number }`（`stopRatio` が消える）。
  - `CloudUsageDto.today.d1RowsWritten: number | null`。
  - `toUsageDto(body, o: { now: number; stale: boolean; lastGood: CloudUsageDto | null }): CloudUsageDto`（`quota` が消える）。
  - `CloudUsagePoller` の依存から `quota` が消える。
  - `CloudUsageBar` から `tickPct` が消える。

見積もり（`estimate`）は見張り（`QuotaCounter`）の数を出していた。
見張りを消すので、トークンが無いときと、一時停止や上限で問い合わせていないときの形を「数は不明」にする（spec の「残す境界」）。
このタスクの間は、上限で止まったことの見分けを今の `sync.pausedReason === 'quota'` で行う（Task 6 が上限で退くときにこの値を渡し、Task 7 で `limitedUntil` に替える）。

ここに書く文は、Task 1 で利用者が選んだものである。

| 問い | 選んだ案の文 |
| --- | --- |
| Q1（案 A） | 数が分からないときは今日の棒を描かない（`today` を空にする） |
| Q2 の帯（案 A を直したもの） | `Cloudflare の無料枠の上限に達したので、同期を止めています。${reset} に枠が戻ると、自動で再開します。` |
| Q3（案 B） | `あと ${n(left)} 行で無料枠の上限です · ${reset} に戻る` |

- [ ] **Step 1: 消す前に数え直す**

Run: `git grep -n -e "'estimate'" -e stopRatio -e tickPct -e "quota: QuotaCounter" -e "quota: engine.quota" -- packages`
Expected: 上の Files と、その試験だけ。

- [ ] **Step 2: サーバの試験を書く**

`packages/server/src/sync/usage.test.ts` の import から `QuotaCounter` と `SyncStateStore` と `openDb` を消し、`const quota = () => …;` を消す。
`toUsageDto(…, { quota: …, now: NOW, … })` と `toUsageDto(…, { quota: q, … })` の `quota: …, ` を全部消す。
`new CloudUsagePoller({ … quota: …, … })` の `quota: …, ` を全部消す。
`q.note(…)` の行を消す。

期待値を次のように直す。

- 「Cloudflare の数を、上限と込み量を添えて写す」の `expect(d.limits).toEqual(…)` を `expect(d.limits).toEqual({ d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 });` にする。
- 「configured: false と null は見積もり」を次に置き換える。

```ts
  it('configured: false と null は「数は不明」で、今日の数を持たない', () => {
    for (const body of [{ configured: false } as const, null]) {
      const d = toUsageDto(body, { now: NOW, stale: false, lastGood: null });
      expect(d).toMatchObject({ source: 'unknown', plan: null, month: null, today: { d1RowsWritten: null, workersRequests: null, resetAt: Date.parse('2026-10-03T00:00:00Z') } });
    }
  });
```

- 「トークンの失効は見積もりに落とし、文を添える」の期待値を `{ source: 'unknown', notice: msg }` にし、名前を「トークンの失効は『数は不明』にして、文を添える」にする。
- 「今日の数が取れず、前に取れた今日の数も無ければ、見積もりを Cloudflare の数と偽らない」の期待値を `{ source: 'unknown', stale: true, today: { d1RowsWritten: null, workersRequests: null } }` にする。
- ほかの `source: 'estimate'` の期待値を `source: 'unknown'` にし、見積もりの数（`26700`、`3640` など）を見ていた断言は `d1RowsWritten: null` に替える。

- [ ] **Step 3: 画面の試験を書く**

`packages/ui/src/presenters/cloudUsage.test.ts` を次に置き換える。

```ts
import { describe, expect, it } from 'vitest';
import type { CloudUsageDto, SyncStatusBody } from '@agent-hangar/shared';
import { presentCloudUsage } from './cloudUsage.ts';

const NOW = Date.parse('2026-10-02T06:48:00Z'); // 日本時間 15:48
const TZ = 'Asia/Tokyo';
const RESET = Date.parse('2026-10-03T00:00:00Z');
const base: CloudUsageDto = {
  source: 'cloudflare', fetchedAt: NOW - 120_000, stale: false, notice: null,
  limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 },
  today: { d1RowsWritten: 23480, workersRequests: 4120, resetAt: RESET },
  plan: { label: 'Workers 無料 · R2 従量', workersPaid: false },
  month: { periodStart: '2026-09-05T00:00:00Z', periodEnd: '2026-10-05T00:00:00Z', throughDay: '2026-09-30', billedUsd: 0, rows: [
    { label: 'R2 の保存', consumed: 0.165, unit: 'GB-月', included: 10 },
    { label: 'R2 の書く操作', consumed: 6470, unit: '回', included: 1_000_000 },
    { label: 'R2 Infrequent Access Data Retrieval', consumed: 3, unit: 'GB', included: null },
  ] },
};
const unknown: CloudUsageDto = { ...base, source: 'unknown', fetchedAt: null, plan: null, month: null, today: { d1RowsWritten: null, workersRequests: null, resetAt: RESET } };
const sync = (o: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', url: 'https://w', lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 1, skipped: [], sweepPending: 0, oncePass: false, ...o });
/** 上限で退いている同期の状態。Task 7 で limitedUntil に替える。 */
const limitedSync = (): SyncStatusBody => sync({ state: 'paused', pausedReason: 'quota' });
const TOKEN_COMMAND = 'npm run hangar -- setup cloud --usage-token';

describe('presentCloudUsage', () => {
  it('ふだん：札 3 枚と棒（今日 2、区切り、今月）。目盛りは無い', () => {
    const p = presentCloudUsage(base, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '$0.00', sub: '9/30 分まで', tone: 'ok' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '23%', sub: '23,480 行', tone: 'ok' },
      { key: 'plan', label: 'プラン', value: 'Workers 無料', sub: 'R2 従量', tone: 'ok' },
    ]);
    expect(p.bars.map((b) => [b.label, b.when, b.pct, b.value, b.tone])).toEqual([
      ['D1 の書き込み', '今日', 23.48, '23,480 / 100,000 行', 'ok'],
      ['Workers の要求', '今日', 4.12, '4,120 / 100,000 回', 'ok'],
      ['R2 の保存', '今月', 1.65, '0.17 / 10 GB-月', 'ok'],
      ['R2 の書く操作', '今月', 0.65, '6,470 / 100 万', 'ok'],
      ['R2 Infrequent Access Data Retrieval', '今月', null, '3 GB', 'ok'],
    ]);
    expect(p.bars.every((b) => !('tickPct' in b))).toBe(true);
    expect(p.splitAfter).toBe(2);
    expect(p.legend).toEqual(['今日の枠は 9:00 に戻る', '今月は 9/5〜10/5']);
    expect(p.source).toBe('Cloudflare の数 · 2 分前');
    expect(p.strip).toBeNull();
    expect(p.command).toBeNull();
  });

  it('止まりそう：D1 の上限の 80%（8 万行）以上で注意の色と、上限までの残りの行数', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 86_120 } }, sync(), NOW, TZ)!;
    expect(p.tiles[1]).toMatchObject({ value: '86%', tone: 'warn' });
    expect(p.bars[0]!.tone).toBe('warn');
    expect(p.legend).toEqual(['あと 13,880 行で無料枠の上限です · 9:00 に戻る']);
    expect(presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 79_999 } }, sync(), NOW, TZ)!.tiles[1]!.tone).toBe('ok');
  });

  it('上限で止まっている：止まった色と、自動で再開する帯', () => {
    const p = presentCloudUsage({ ...base, today: { ...base.today, d1RowsWritten: 100_000 } }, limitedSync(), NOW, TZ)!;
    expect(p.tiles[1]!.tone).toBe('stop');
    expect(p.bars[0]!.tone).toBe('stop');
    expect(p.legend).toEqual([]);
    expect(p.strip).toEqual({ tone: 'stop', text: 'Cloudflare の無料枠の上限に達したので、同期を止めています。9:00 に枠が戻ると、自動で再開します。' });
    expect(p.command).toBeNull();
  });

  it('手で止めたときは帯を出さない', () => {
    expect(presentCloudUsage(base, sync({ state: 'paused' }), NOW, TZ)!.strip).toBeNull();
  });

  it('止めている間に数が分からないときは、トークンを求めず、問い合わせていないと言う', () => {
    const p = presentCloudUsage(unknown, sync({ state: 'paused' }), NOW, TZ)!;
    expect(p.tiles.map((t) => [t.key, t.value, t.sub])).toEqual([['bill', '—', '同期の停止中'], ['d1', '—', '同期の停止中'], ['plan', '—', '同期の停止中']]);
    expect(p.bars).toEqual([]);
    expect(p.strip).toEqual({ tone: 'info', text: '同期を止めている間は Cloudflare に問い合わせません。再開すると Cloudflare の数と今月の費用が出ます。' });
    expect(p.command).toBeNull();
    // 上限で止まっているときは、止まった帯を先に出す。
    const q = presentCloudUsage(unknown, limitedSync(), NOW, TZ)!;
    expect(q.strip?.tone).toBe('stop');
    expect(q.tiles[1]).toMatchObject({ value: '—', tone: 'stop' });
    expect(q.command).toBeNull();
  });

  it('トークンなし：数は不明。札は値の無い印、今日の棒は描かず、案内とコマンドを出す', () => {
    const p = presentCloudUsage(unknown, sync(), NOW, TZ)!;
    expect(p.tiles).toEqual([
      { key: 'bill', label: '今月の請求', value: '—', sub: 'トークンが要ります', tone: 'muted' },
      { key: 'd1', label: 'D1 の書き込み（今日）', value: '—', sub: 'トークンが要ります', tone: 'muted' },
      { key: 'plan', label: 'プラン', value: '—', sub: 'トークンが要ります', tone: 'muted' },
    ]);
    expect(p.bars).toEqual([]);
    expect(p.splitAfter).toBe(0);
    expect(p.legend).toEqual([]);
    expect(p.source).toBe('数は不明（hangar は数えません） · 今日の枠は 9:00 に戻る');
    expect(p.strip).toEqual({ tone: 'info', text: 'Cloudflare の数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。' });
    expect(p.command).toBe(TOKEN_COMMAND);
  });

  it('トークンの失効は案内の帯をその文に替える', () => {
    const msg = 'トークンが無効です。setup cloud --usage-token で入れ直してください';
    expect(presentCloudUsage({ ...unknown, notice: msg }, sync(), NOW, TZ)!.strip).toEqual({ tone: 'info', text: msg });
  });

  it('取れなかった：最後の値と時刻と失敗', () => {
    const p = presentCloudUsage({ ...base, stale: true, fetchedAt: Date.parse('2026-10-02T05:02:00Z') }, sync(), NOW, TZ)!;
    expect(p.source).toBe('Cloudflare の数 · 14:02 · 取得に失敗');
  });

  it('Workers Paid：今日の札と棒を出さない', () => {
    const p = presentCloudUsage({ ...base, plan: { label: 'Workers Paid', workersPaid: true } }, sync(), NOW, TZ)!;
    expect(p.tiles.map((t) => t.key)).toEqual(['bill', 'plan']);
    expect(p.bars.every((b) => b.when === '今月')).toBe(true);
    expect(p.splitAfter).toBe(0);
    expect(p.legend).toEqual(['今月は 9/5〜10/5']);
  });

  it('期の初めで請求の行がまだ無い：$0.00 と出し、「分まで」と期の添え書きを出さず、落ちない', () => {
    const p = presentCloudUsage({ ...base, month: { periodStart: '', periodEnd: '2026-11-05T00:00:00Z', throughDay: null, billedUsd: 0, rows: [] } }, sync(), NOW, TZ)!;
    expect(p.tiles[0]).toEqual({ key: 'bill', label: '今月の請求', value: '$0.00', sub: '', tone: 'ok' });
    expect(p.bars.map((b) => b.when)).toEqual(['今日', '今日']);
    expect(p.legend).toEqual(['今日の枠は 9:00 に戻る']);
  });

  it('期の日付は UTC の日で書く（端末の時差で前の日にずれない）', () => {
    expect(presentCloudUsage(base, sync(), NOW, 'America/Los_Angeles')!.legend[1]).toBe('今月は 9/5〜10/5');
  });

  it('期の終わりが読めなければ、終わりは空にする', () => {
    expect(presentCloudUsage({ ...base, month: { ...base.month!, periodEnd: 'not-a-date' } }, sync(), NOW, TZ)!.legend[1]).toBe('今月は 9/5〜');
  });

  it('使用量がまだ届いていなければ null', () => {
    expect(presentCloudUsage(null, sync(), NOW, TZ)).toBeNull();
  });
});
```

- [ ] **Step 4: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/usage.test.ts packages/ui/src/presenters/cloudUsage.test.ts`
Expected: FAIL（`source` が `estimate` のまま、`stopRatio` と目盛りが残り、文が古い）。

- [ ] **Step 5: 型を直す**

`packages/shared/src/api.ts` の `CloudUsageDto` とその説明を次にする。

```ts
/**
 * 設定の「使用量と費用」に出す形。端末のサーバが Worker の /usage から作る。
 * source が unknown のときは、Cloudflare の数を取れていない（トークンが無い、一時停止や上限で問い合わせていない、取れないまま失敗した）。
 * そのとき今日の数は null で、plan と month も null である。hangar は量を数えない（段 1、D4）。
 * stale は最後の取得が失敗していること（値は最後に取れたもの）。notice はトークンの失効など、画面に添える 1 行。
 */
export type CloudUsageDto = {
  source: 'cloudflare' | 'unknown';
  fetchedAt: number | null;
  stale: boolean;
  notice: string | null;
  limits: { d1RowsPerDay: number; workersRequestsPerDay: number };
  today: { d1RowsWritten: number | null; workersRequests: number | null; resetAt: number };
  plan: { label: string; workersPaid: boolean } | null;
  month: { periodStart: string; periodEnd: string | null; throughDay: string | null; billedUsd: number; rows: { label: string; consumed: number; unit: string; included: number | null }[] } | null;
};
```

- [ ] **Step 6: サーバを直す**

`packages/server/src/sync/usage.ts` の import を次にし、`import type { QuotaCounter } from './quota.ts';` と `const nextUtcMidnight = …;` を消す。

```ts
import { CLOUD_FREE_LIMITS, nextUtcMidnight, r2Included, type CloudUsageBody, type CloudUsageDto } from '@agent-hangar/shared';
import type { CloudClient } from './client.ts';
import type { Timers } from './engine.ts';
```

`estimate` を消し、次の `unknown` に替える。

```ts
/**
 * 数の分からない形。トークンが無い端末、古い Worker、一時停止や上限で問い合わせていないとき、一度も取れないまま失敗したときに使う。
 * hangar は量を数えないので（段 1、D4）、今日の数は null にする。
 */
function unknown(o: { now: number; stale: boolean; notice: string | null }): CloudUsageDto {
  return {
    source: 'unknown', fetchedAt: null, stale: o.stale, notice: o.notice,
    limits: { d1RowsPerDay: CLOUD_FREE_LIMITS.d1RowsPerDay, workersRequestsPerDay: CLOUD_FREE_LIMITS.workersRequestsPerDay },
    today: { d1RowsWritten: null, workersRequests: null, resetAt: nextUtcMidnight(o.now) },
    plan: null, month: null,
  };
}
```

`toUsageDto` の型の `quota: QuotaCounter; ` を消し、中の `estimate(` を全部 `unknown(` にする。

`CloudUsagePoller` のコンストラクタの依存から `quota: QuotaCounter; ` を消し、`refresh` と `load` の `toUsageDto(…, { quota: this.o.quota, … })` の `quota: this.o.quota, ` を消す。
`refresh` の説明の後ろに、一時停止と上限の間は外と話さないことを 1 行足す。

```ts
  /** 決して reject しない。呼び手の多くは結果を捨てる（void）ので、落ちればプロセスごと落ちる。一時停止と上限で退いている間は外と話さない（isPaused）。 */
```

`packages/server/src/server.ts` の `new CloudUsagePoller({ client, quota: engine.quota, isPaused, broadcast: … })` から `quota: engine.quota, ` を消し、上のコメント「設定の『使用量と費用』。数える client を通すので、要求は無料枠の勘定に入る。」を「設定の『使用量と費用』。」にする。

- [ ] **Step 7: 画面を直す**

`packages/ui/src/presenters/cloudUsage.ts` の `CloudUsageBar` の型から `tickPct: number | null; ` を消し、`WARN_OF_STOP` の定数を次に替える。

```ts
/** 注意の色にする割合。D1 の 1 日の行の上限に対して見る（段 1 で、止める線は Cloudflare の上限そのものになった）。 */
const WARN_RATIO = 0.8;
```

`presentCloudUsage` を次にする。

```ts
export function presentCloudUsage(u: CloudUsageDto | null, sync: SyncStatusBody | null, now: number, tz?: string): CloudUsageProps | null {
  if (!u) return null;
  const unknown = u.source === 'unknown';
  // 上限で退いているか。Task 7 で sync.limitedUntil に替える。
  const limited = sync?.state === 'paused' && sync.pausedReason === 'quota';
  const limit = u.limits.d1RowsPerDay;
  const d1 = unknown ? null : u.today.d1RowsWritten;
  const d1Pct = d1 === null ? null : pct(d1, limit);
  const tone: CloudUsageTone = limited ? 'stop' : d1 !== null && d1 >= limit * WARN_RATIO ? 'warn' : 'ok';
  const reset = hm(u.today.resetAt, tz);
  const paid = u.plan?.workersPaid ?? false;
  // 一時停止と上限の間はサーバが Cloudflare に問い合わせないので、トークンの有無は分からない。
  // 数が分からなくても「トークンが要ります」とは言わず、止めているからだと言う。トークンの失効の知らせ（notice）はそのまま出す。
  const pausedNoFetch = unknown && sync?.state === 'paused' && !u.notice;
  const missing = pausedNoFetch ? '同期の停止中' : 'トークンが要ります';

  const tiles: CloudUsageTile[] = [
    u.month ? { key: 'bill', label: '今月の請求', value: `$${u.month.billedUsd.toFixed(2)}`, sub: u.month.throughDay ? `${dayMd(u.month.throughDay)} 分まで` : '', tone: 'ok' } : { key: 'bill', label: '今月の請求', value: '—', sub: missing, tone: 'muted' },
    d1 === null || d1Pct === null
      ? { key: 'd1', label: 'D1 の書き込み（今日）', value: '—', sub: missing, tone: limited ? 'stop' : 'muted' }
      : { key: 'd1', label: 'D1 の書き込み（今日）', value: `${Math.round(d1Pct)}%`, sub: `${n(d1)} 行`, tone },
    u.plan ? { key: 'plan', label: 'プラン', value: u.plan.label.split(' · ')[0]!, sub: u.plan.label.split(' · ')[1] ?? '', tone: 'ok' } : { key: 'plan', label: 'プラン', value: '—', sub: missing, tone: 'muted' },
  ];
  // 数が分からないときは今日の棒を描かない（試作の Q1）。
  const req = u.today.workersRequests;
  const today: CloudUsageBar[] = paid || d1 === null ? [] : [
    { label: 'D1 の書き込み', when: '今日', pct: d1Pct, value: `${n(d1)} / ${n(limit)} 行`, tone },
    { label: 'Workers の要求', when: '今日', pct: req === null ? null : pct(req, u.limits.workersRequestsPerDay), value: req === null ? '—' : `${n(req)} / ${n(u.limits.workersRequestsPerDay)} 回`, tone: 'ok' },
  ];
  const month: CloudUsageBar[] = (u.month?.rows ?? []).map((r) => ({ label: r.label, when: '今月', pct: r.included === null ? null : pct(r.consumed, r.included), value: amount(r.consumed, r.unit, r.included), tone: 'ok' }));

  // 期の初めは請求の行がまだ無く、始まりの日が空になる。そのときは期の添え書きを出さない。
  const monthLegend = u.month && md(u.month.periodStart) ? [`今月は ${md(u.month.periodStart)}〜${u.month.periodEnd ? md(u.month.periodEnd) : ''}`] : [];
  // 止まっている間は帯が戻る時刻を言うので出さない。数が分からないときは戻る時刻を出どころの行に添える。
  const legend: string[] = paid ? monthLegend
    : limited || d1 === null ? []
    : tone === 'warn' ? [`あと ${n(Math.max(0, limit - d1))} 行で無料枠の上限です · ${reset} に戻る`]
    : [`今日の枠は ${reset} に戻る`, ...monthLegend];

  const source = unknown ? `数は不明（hangar は数えません）${limited ? '' : ` · 今日の枠は ${reset} に戻る`}`
    : u.stale ? `Cloudflare の数 · ${u.fetchedAt ? hm(u.fetchedAt, tz) : ''} · 取得に失敗`
    : `Cloudflare の数 · ${relativeTime(u.fetchedAt, now)}`;

  let strip: CloudUsageProps['strip'] = null;
  if (limited) {
    strip = { tone: 'stop', text: `Cloudflare の無料枠の上限に達したので、同期を止めています。${reset} に枠が戻ると、自動で再開します。` };
  } else if (pausedNoFetch) {
    strip = { tone: 'info', text: '同期を止めている間は Cloudflare に問い合わせません。再開すると Cloudflare の数と今月の費用が出ます。' };
  } else if (unknown) {
    strip = { tone: 'info', text: u.notice ?? 'Cloudflare の数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。' };
  }

  return { tiles: paid ? tiles.filter((t) => t.key !== 'd1') : tiles, bars: [...today, ...month], splitAfter: today.length, legend, source, strip, command: unknown && !pausedNoFetch && !limited ? TOKEN_COMMAND : null };
}
```

使わなくなった `utcDay` を消す（`git grep -n utcDay -- packages/ui/src/presenters/cloudUsage.ts` で確かめる）。

`packages/ui/src/views/CloudUsage.tsx` の `{b.tickPct !== null && <span className="cu-tick" style={{ left: \`${b.tickPct}%\` }} />}` の行を消す。

`packages/ui/src/styles/settings.css` の `.cu-tick` の規則（`git grep -n "cu-tick" -- packages/ui/src/styles` で出る行）を消す。

- [ ] **Step 8: 固定値を直す**

Run: `git grep -n -e "'estimate'" -e stopRatio -e tickPct -- packages`
Expected: 試験の固定値だけが出る。
出た行の `stopRatio: 0.8` と、`tickPct: …, ` を消し、`source: 'estimate'` を `source: 'unknown'` にする。
`packages/ui/src/views/misc.test.tsx` の使用量の固定値の凡例「あと 11,880 行で同期を止めます · 9:00 に戻る」と帯「無料枠の 80% に届いたので同期を止めました。」は、Step 7 の文（「あと 13,880 行で無料枠の上限です · 9:00 に戻る」と、上限で止まったときの帯）に替える（描く側の試験なので、文は固定値をそのまま描けばよい）。

- [ ] **Step 9: 通るのを見る**

Run: `npx vitest run packages/server/src/sync/usage.test.ts packages/server/test packages/server/src/http/app.test.ts packages/ui`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 10: コミットする**

```bash
git add -A packages/shared/src/api.ts packages/server/src/sync/usage.ts packages/server/src/sync/usage.test.ts packages/server/src/server.ts packages/server/src/http/app.test.ts packages/ui
```

```bash
git commit -m "feat: show usage as unknown instead of the device-side estimate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 同期のエンジンが見張りをやめ、上限で次の UTC の 0 時まで退く

選んだ案：Q2 のトーストは案 A を直したもの（「Cloudflare の無料枠の上限に達したので、9:00 まで同期を止めます。枠が戻ると自動で再開します」）。Q4 は案 B で、「今すぐ同期」は 1 回だけ試し直し、まだ断られればまた戻る時刻まで退いてトーストで知らせる。

**Files:**
- Delete: `packages/server/src/sync/quota.ts`、`packages/server/src/sync/quota.test.ts`、`packages/server/src/sync/quota.account.test.ts`
- Modify: `packages/server/src/sync/engine.ts`（import、`SyncEngineDeps`、定数、`quota`、`halted`、`failPush`、`failPull`、`status`、`start`、`doPush`、`guardQuota`、`setPaused`、`request`、`pullPass`、`doPull`、`syncNow`、`pullBeforeLaunch`）
- Modify: `packages/server/src/sync/state.ts:3-21`
- Modify: `packages/server/src/server.ts`（53、88-150、462-468、496-497、537-563、570-575 の付近）
- Modify: `packages/shared/src/api.ts`（`SyncStatusDto` に `limitedUntil` を足す）
- Test: `packages/server/src/sync/engine.test.ts`、`packages/server/src/sync/engine.restart.test.ts`、`packages/server/src/sync/state.test.ts`、`packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: Task 2 の `nextUtcMidnight`、Task 3 の `LimitError` と偽のクラウドの `limited`。
- Produces：
  - `SyncEngine.limitedUntil(): number | null`（退いている間の戻る時刻）。
  - `SyncEngine.setPaused(paused: boolean): void`（理由の引数が消える）。
  - `SyncEngine.quota` と `SyncEngineDeps.quota`、`quotaLimits` が消える。
  - `limitedMessage(until: number): string`（`engine.ts`、トーストの文）。
  - `SyncStatusDto.limitedUntil: number | null`。退いている間の `state` は `paused` である。利用者が一時停止しているときと、退いていないときは null。
  - `SyncStateKey` から `'pausedReason'` と `` `quota:${string}` `` が消え、`'limitedUntil'` が足される。
  - `server.ts` の `countingClient`、`D1_WRITES_PER_FILE_PUT`、`D1_WRITES_PER_FILE_DELETE` が消える。
  - このタスクの間は、`SyncStatusDto.pausedReason` と `quotaPausedDay` を残し、上限で退いているときに `quota` とその日を渡す（今の画面が「無料枠で停止 · X に戻る」を出せるように）。Task 7 で消す。

- [ ] **Step 1: 消す前に数え直す**

Run: `git grep -n -e QuotaCounter -e "quota\.ts" -e guardQuota -e countingClient -e D1_WRITES_ -e pushD1Writes -e quotaDayKey -e QUOTA_ -- packages ':!packages/cloud'`
Expected: `server/src/sync/quota.ts` とその 2 つの試験、`engine.ts`、`engine.test.ts`、`engine.restart.test.ts`、`server.ts`、`server.test.ts` だけ。
`server/test/fake-cloud.ts` の `D1_ROWS` は Worker の写しなので残す（`D1_WRITES_` に当たらないことを確かめる）。

- [ ] **Step 2: 試験を書く**

`packages/server/src/sync/engine.test.ts` の import から `D1_ROWS` と `import { QUOTA_STOP_RATIO, QuotaCounter } from './quota.ts';` を消し、`CloudError` の隣に `LimitError` を足す。

末尾に足す。

```ts
describe('上限で退く', () => {
  /** UTC の 0 時の 1 分前に時計を合わせる。日をまたぐのを 2 分で試せる。戻る時刻を返す。 */
  const beforeMidnight = (): number => {
    timers.now = Date.UTC(2026, 9, 8, 23, 59, 0);
    return Date.UTC(2026, 9, 9);
  };
  /** 上限に当てたまま書き込みを 1 つ送らせ、退いた状態を作る。 */
  const hitLimit = async (e: SyncEngine, kind: 'd1-write' | 'requests' = 'd1-write'): Promise<void> => {
    cloud.limited = kind;
    project('p1');
    await timers.advance(1_000);
    await e.idle();
  };

  it('上限の失敗を受けたら、次の UTC の 0 時まで外へ出ず、戻る時刻を見せ、1 度だけ知らせる', async () => {
    const midnight = beforeMidnight();
    const toasts: string[] = [];
    const e = make();
    e.on({ toast: (_l, m) => toasts.push(m) });
    await e.start();
    await hitLimit(e);
    expect(e.limitedUntil()).toBe(midnight);
    expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: midnight, error: null, pending: 1 });
    expect(toasts).toEqual([limitedMessage(midnight)]);
    // 退いている間は、書き込みも定期実行も起動前の pull も外へ出ない。
    const calls = cloud.calls.length;
    project('p2');
    await timers.advance(30_000);
    await e.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(await e.pullBeforeLaunch()).toBe(false);
    expect(cloud.calls.length).toBe(calls);
    e.stop();
  });

  it('日が変われば次の定期実行で自分で戻り、溜まった変更を送る', async () => {
    const midnight = beforeMidnight();
    const e = make();
    await e.start();
    await hitLimit(e, 'requests');
    expect(e.limitedUntil()).toBe(midnight);
    cloud.limited = null;
    await timers.advance(120_000);
    await e.idle();
    expect(e.limitedUntil()).toBeNull();
    expect(e.status()).toMatchObject({ state: 'idle', limitedUntil: null, error: null, pending: 0 });
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1']);
    e.stop();
  });

  it('日が変わってもまだ断られたら、また次の 0 時まで退き、もう 1 度知らせる', async () => {
    const midnight = beforeMidnight();
    const toasts: string[] = [];
    const e = make();
    e.on({ toast: (_l, m) => toasts.push(m) });
    await e.start();
    await hitLimit(e);
    await timers.advance(120_000);
    await e.idle();
    expect(e.limitedUntil()).toBe(midnight + 86_400_000);
    expect(toasts).toHaveLength(2);
    e.stop();
  });

  it('利用者の今すぐ同期は 1 度だけ試し直し、まだ断られれば退いたまま知らせ直し、通れば戻る', async () => {
    beforeMidnight();
    const toasts: string[] = [];
    const e = make();
    e.on({ toast: (_l, m) => toasts.push(m) });
    await e.start();
    await hitLimit(e);
    expect(toasts).toHaveLength(1);
    const before = cloud.calls.length;
    await e.syncNow();
    expect(cloud.calls.length).toBeGreaterThan(before);
    expect(e.limitedUntil()).not.toBeNull();
    // まだ断られたので、また戻る時刻まで退いたことを知らせる（Task 1 の Q4）。
    expect(toasts).toHaveLength(2);
    cloud.limited = null;
    await e.syncNow();
    expect(e.limitedUntil()).toBeNull();
    expect(e.status()).toMatchObject({ state: 'idle', pending: 0 });
    e.stop();
  });

  it('利用者が一時停止している間は一時停止として見せ、再開すると戻る時刻まで退いたことを見せる', async () => {
    const midnight = beforeMidnight();
    const e = make();
    await e.start();
    await hitLimit(e);
    e.setPaused(true);
    expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: null });
    const calls = cloud.calls.length;
    e.setPaused(false);
    await e.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(e.status()).toMatchObject({ state: 'paused', limitedUntil: midnight });
    e.stop();
  });

  it('上限でない失敗（500）では退かず、error を出す', async () => {
    const e = make();
    await e.start();
    cloud.pushChanges = async () => { throw new CloudError(500, '{"error":"internal error"}'); };
    project('p1');
    await timers.advance(1_000);
    await e.idle();
    expect(e.limitedUntil()).toBeNull();
    expect(e.status()).toMatchObject({ state: 'error', error: '{"error":"internal error"}', limitedUntil: null });
    e.stop();
  });

  it('このタスクの間は、退いていることを今の画面の形（pausedReason が quota）でも渡す', async () => {
    beforeMidnight();
    const e = make();
    await e.start();
    await hitLimit(e);
    expect(e.status()).toMatchObject({ state: 'paused', pausedReason: 'quota', quotaPausedDay: '2026-10-08' });
    e.setPaused(true);
    expect(e.status()).toMatchObject({ state: 'paused', pausedReason: 'user', quotaPausedDay: null });
    e.stop();
  });
});
```

同じファイルの import に `import { limitedMessage, SyncEngine } from './engine.ts';` の形で `limitedMessage` を足す。

`packages/server/src/sync/engine.restart.test.ts` の import から `import { QuotaCounter, quotaDayKey } from './quota.ts';` を消し、`describe('立て直しても、無料枠で止めた日を忘れない', …)` と `describe('押すものが無い日の見張り', …)`（67 行から 131 行）を次に置き換える。

```ts
describe('立て直しても、上限で退いていることを忘れない', () => {
  it('戻る時刻は sync_state に残り、立て直した直後に外へ出ない。時刻を過ぎていれば最初の要求から戻る', async () => {
    timers.now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const midnight = Date.UTC(2026, 9, 9);
    const a = make();
    await a.start();
    cloud.limited = 'd1-write';
    upsertShared(db, 'projects', { id: 'p1', name: 'p1', status: 'active', is_scratch: 0 }, 'a');
    await timers.advance(1_000);
    await a.idle();
    a.stop();
    expect(new SyncStateStore(db).get('limitedUntil')).toBe(String(midnight));

    // 同じ日のうちに立て直す。起動は利用者の押下ではないので、印を外さずに退いたままでいる。
    const calls = cloud.calls.length;
    const b = make();
    await b.start();
    await b.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(b.status()).toMatchObject({ state: 'paused', limitedUntil: midnight });
    b.stop();

    // 日が変わってから立て直す。
    cloud.limited = null;
    timers.now = midnight + 1;
    const c = make();
    await c.start();
    await c.idle();
    expect(c.status()).toMatchObject({ state: 'idle', limitedUntil: null, pending: 0 });
    expect(new SyncStateStore(db).get('limitedUntil')).toBeNull();
    c.stop();
  });
});
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/engine.test.ts packages/server/src/sync/engine.restart.test.ts -t "上限"`
Expected: FAIL（`limitedUntil` と `limitedMessage` が無い。今は 429 の `LimitError` を ふつうの失敗として `error` に出す）。

- [ ] **Step 4: 状態の鍵を直す**

`packages/server/src/sync/state.ts` の説明の「quota:<yyyy-MM-dd> は QuotaCounter が日ごとの呼び出し回数を数えるのに使う。」を「limitedUntil は、Cloudflare の上限で退いている間の戻る時刻である（sync/engine.ts）。」にし、`SyncStateKey` から `  | 'pausedReason'` と `` | `quota:${string}` `` を消し、`  | 'transcriptsFrom'` の次に `  | 'limitedUntil'` を足す。

`packages/server/src/sync/state.test.ts` の「quota の鍵を受ける」の `it`（41-49 行）を消す。

- [ ] **Step 5: 同期の状態の型に戻る時刻を足す**

`packages/shared/src/api.ts` の `SyncStatusDto` の説明に 2 行足し、型の末尾に `limitedUntil: number | null` を足す。

```ts
 * limitedUntil は、Cloudflare の無料枠の上限に当たって退いている間の戻る時刻（次の UTC の 0 時）である。
 * 退いている間の state は paused で、利用者が一時停止しているときと、退いていないときは null である。
```

- [ ] **Step 6: エンジンを直す**

`packages/server/src/sync/engine.ts` を次のように直す。

import を次にする。

```ts
import { MAX_PUSH_BATCH, nextUtcMidnight, PULL_LIMIT, type ChangeIn, type ChangeOp, type ChangeOut, type PushChangesResponse, type SharedTable, type SnapshotResponse, type SyncStateKind, type SyncStatusDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { onSharedWrite } from '../db/shared.ts';
import { applyRemoteBatch, type MemoConflict, type SessionMemoBackup } from './apply.ts';
import { CloudError, CompatError, goneFloor, LimitError, type CloudClient } from './client.ts';
import { SyncStateStore } from './state.ts';
```

`SyncEngineDeps` から `quota?: QuotaCounter;` と、`quotaLimits` の説明と行を消す。

`PUSH_MIN_GAP_MS` の説明の「これが無いと 2 秒ごとに push が出て無料枠を使い切る。」は残す（数えなくても、枠を使うことに変わりはない）。

`const QUOTA_PAUSED_MESSAGE = …;` を消し、その場所に足す。

```ts
/**
 * 上限で退いたときの知らせ。戻る時刻はこの PC の時刻で書く。
 * 文は試作（docs/superpowers/specs/2026-10-08-stage1-quota-backoff/usage.html）の Q2 で決めた。
 */
export function limitedMessage(until: number): string {
  const at = new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit' }).format(until);
  return `Cloudflare の無料枠の上限に達したので、${at} まで同期を止めます。枠が戻ると自動で再開します`;
}
```

`readonly quota: QuotaCounter;` を消す。
コンストラクタの `// 枠はアカウントごとなので、…` と `this.quota = …;` の 2 行を消す。

`halted` と `compatBlocked` を次にし、その下に `limitedUntil` と `noteLimit` を足す。

```ts
  /** push と pull の入口を閉じているか。版で止まっているとき、上限で退いているとき、一時停止していて頼まれた 1 巡の最中でもないとき。 */
  private get halted(): boolean { return this.compatBlock !== null || this.limitedUntil() !== null || (this.paused && !this.onePass); }

  /** 互換の版が合わずに止まっているか。本文と設定の出し入れと使用量も、これを見て止まる（server.ts の syncHalted）。 */
  compatBlocked(): boolean { return this.compatBlock !== null; }

  /**
   * Cloudflare の上限で退いている間の、戻る時刻。退いていなければ null。
   * 時刻を過ぎていれば印を消して null を返す。日が変われば、次の定期実行（30 秒ごと）から自分で戻る。
   * 印は sync_state に置く。立て直すたびに上限に当たり直して、断られる要求を重ねないためである。
   */
  limitedUntil(): number | null {
    const until = this.state.getNumber('limitedUntil', 0);
    if (until <= 0) return null;
    if (this.now() >= until) { this.state.set('limitedUntil', null); return null; }
    return until;
  }

  /**
   * 上限の失敗（LimitError）を受けたら、次の UTC の 0 時まで退く。上限の失敗なら真を返す。
   * 失敗の理由（error）には残さない。戻る時刻の決まった待ちであって、利用者が直す誤りではないからである。
   * 新しく退いたときだけ 1 度知らせる。
   */
  private noteLimit(e: unknown): boolean {
    if (!(e instanceof LimitError)) return false;
    const was = this.limitedUntil();
    const until = nextUtcMidnight(this.now());
    this.state.set('limitedUntil', until);
    if (was === null) {
      console.warn(`[sync] ${e.message}`);
      this.emit('toast', 'info', limitedMessage(until));
    }
    return true;
  }
```

`failPush` と `failPull` を次にする。

```ts
  protected failPush(e: unknown): void { if (this.noteLimit(e)) return; this.pushError = errorMessage(e); this.noteCompat(e); this.persistError(); }
  protected failPull(e: unknown): void { if (this.noteLimit(e)) return; this.pullError = errorMessage(e); this.noteCompat(e); this.persistError(); }
```

`deviceCount()` の説明を次にする。

```ts
  /**
   * この箱を分け合っている端末の数。CLI の hangar cloud status が出す。
   * 他端末の行は初回の pull（写し）で必ず入る。
   */
```

`status()` を次にする。

```ts
  status(): SyncStatusDto {
    // 上限で退いていることは、利用者が一時停止していないときだけ見せる。一時停止は利用者が選んだ状態なので先に見せる。
    const limitedUntil = this.deps.client && !this.paused ? this.limitedUntil() : null;
    const state: SyncStateKind = !this.deps.client ? 'off'
      // 版で止まっているときは、一時停止より先に見せる。直す道（どちらを上げるか）が error の文にしか無いからである。
      : this.compatBlock !== null ? 'error'
      : this.paused || limitedUntil !== null ? 'paused'
      : this.pushing ? 'pushing'
      : this.pulling ? 'pulling'
      : this.lastError ? 'error'
      : 'idle';
    const num = (k: 'lastPushAt' | 'lastPullAt') => { const v = this.state.get(k); return v === null ? null : Number(v); };
    const shownLimit = state === 'paused' ? limitedUntil : null;
    return {
      state,
      url: this.deps.url ?? null,
      lastPushAt: num('lastPushAt'),
      lastPullAt: num('lastPullAt'),
      pending: this.pending(),
      error: state === 'error' ? (this.compatBlock ?? this.lastError) : null,
      deviceCount: this.deviceCount(),
      claudeConfig: { ...this.claudeConfig },
      limitedUntil: shownLimit,
      // 段 1 の PR 5 の Task 7 で消す。それまで今の画面が「無料枠で停止」を出せるよう、退いているときを quota として渡す。
      pausedReason: state === 'paused' ? (shownLimit !== null ? 'quota' : 'user') : null,
      quotaPausedDay: shownLimit !== null ? new Date(this.now()).toISOString().slice(0, 10) : null,
    };
  }
```

`start()` の `await this.syncNow();` を次にする。

```ts
    // 起動は利用者の押下ではないので、上限で退いた印を外さない（syncNow は外す）。
    await this.pushNow();
    await this.pullNow();
```

`doPush` の `catch (e) { … }` を次にする。

```ts
      } catch (e) {
        // 大きすぎる行は何度送っても同じ答えが返る。諦めて先へ進まないと、この塊で push が永久に止まる。
        if (this.dropOversize(e, rows)) continue;
        this.failPush(e);
        return { pushed };
      }
```

同じ関数の成功の後の、`// Worker が「その日に D1 へ書いた行数」を返したら、…` から `if (this.guardQuota()) return { pushed };` までの 6 行を `pushed += rows.length;` の 1 行だけにする。
`// ここまで来ずに戻った回（失敗と枠での停止）では理由が残るので、…` の「（失敗と枠での停止）」を「（失敗と上限）」にする。

`guardQuota` を、説明ごと消す。

`setPaused` を次にする。

```ts
  /** 利用者が止める、再開する（UI と CLI から）。上限で退いた印には触らない。上限は日が変われば自分で戻る。 */
  setPaused(paused: boolean): void {
    this.state.set('paused', paused);
    if (!paused && this.started && this.deps.client) { this.noteLocalChange(); this.enqueueWhileStarted(() => this.pullNow()); }
    this.emitStatus();
  }
```

`request` を、説明ごと消す。
`pullPass` の `await this.request(() => client.snapshot(cursor, PULL_LIMIT))` を `await client.snapshot(cursor, PULL_LIMIT)` にし、その上のコメント「GET /rows は読むだけで D1 に 1 行も書かない。」を消す。
`const page = await this.request(() => client.pullChanges(at, PULL_LIMIT), D1_WRITES_PER_PULL);` を `const page = await client.pullChanges(at, PULL_LIMIT);` にし、その上のコメントと、下の `d1RowsToday` の 3 行（コメント 2 行と `if (typeof page.d1RowsToday === 'number') …`）を消す。

`doPull` の末尾の `// 途中で止めると写しが半端なまま …` と `this.guardQuota();` の 2 行を消す。

`syncNow` を次にする。

```ts
  /**
   * 利用者が押した「今すぐ同期」。push してから pull する。最小間隔は見ない。
   *
   * evenIfPaused を渡すと、一時停止していてもこの 1 巡だけは通す。
   * 止めた状態には触らないので、終われば元の一時停止に戻っている。
   * 版で止まっていても、上限で退いていても、利用者が押した 1 回は試し直す。
   * Worker を入れ替えた後と、上限が戻ったかを確かめたいときに、戻る道はここだけである。
   * まだ合わなければ、またはまだ上限なら、その 1 回の失敗でまた止まる（上限なら次の 0 時まで退いて知らせる）。
   */
  async syncNow(o: { evenIfPaused?: boolean } = {}): Promise<void> {
    // 一時停止のまま何も送らない回では外さない。外すと、試してもいないのに表示だけが変わる。
    if (!this.paused || o.evenIfPaused || this.onePass) {
      this.compatBlock = null;
      this.state.set('limitedUntil', null);
    }
    if (!o.evenIfPaused || !this.paused || this.onePass) {
      await this.pushNow();
      await this.pullNow();
      return;
    }
    this.onePass = true;
    try {
      await this.pushNow();
      await this.pullNow();
    } finally {
      this.onePass = false;
    }
  }
```

`pullBeforeLaunch` の 1 行目を次にする。

```ts
    if (!this.deps.client || this.paused || this.compatBlock !== null || this.limitedUntil() !== null) return false;
```

- [ ] **Step 7: サーバの結線を直す**

`packages/server/src/server.ts` を次のように直す。

- 53 行の `import { D1_WRITES_PER_DEVICE_TOUCH, D1_WRITES_PER_METER_NOTE, type QuotaCounter } from './sync/quota.ts';` を消す。
- 88 行から 150 行（`FILES_INDEXES`、`D1_WRITES_PER_AUTOINCREMENT`、`D1_WRITES_PER_FILE_PUT`、`D1_WRITES_PER_FILE_DELETE`、`countingClient` とそれぞれの説明）を消す。
- `isPaused` の説明の 1 行目「同期が止まっているか。利用者が押した一時停止も、枠の 80% で自分から止まった分もここに出る。」を「同期が止まっているか。利用者が押した一時停止も、Cloudflare の上限で退いている間もここに出る。」にする。
- `configSyncActive` の説明の「「一時停止」は外と話すのをやめることで、無料枠の 80% で自分から止まったときも同じである（決定 4）。」を「「一時停止」は外と話すのをやめることで、Cloudflare の上限で退いている間も同じである（そのあいだの状態は paused で、isPaused に出る）。」にする。
  関数そのものは残す（Claude Code の設定の同期は残すため。全体計画の D6）。
- `const rawClient = cloud ? new HttpCloudClient(…) : null;` を `const client = cloud ? new HttpCloudClient(…) : null;` にし、`new SyncEngine({ … client: rawClient, … })` を `client` にする。
- `// 本文と設定の出し入れは engine を通らないので、無料枠の勘定に入るように包んでから渡す。` と `const client = rawClient ? countingClient(rawClient, engine.quota) : null;` の 2 行を消す。
  設定の同期（`new ClaudeConfigSync({ … client, … })`）と puller と uploader は、名前を変えた `client` をそのまま受け取る。
- `pausedPass` の説明の「終わりに使用量を取り直す。止まっている間は取りに行かないので、押した分の枠がここでしか見えない。」は残す。
- `pausedPass` の `done` の `if (engine.compatBlocked()) { … }` の次に足す。

```ts
      // 上限で退いた 1 巡は、エンジンが戻る時刻を知らせてある。成功や残りの件数の知らせを重ねない。
      if (engine.limitedUntil() !== null) return;
```

- `syncHalted` に `limited` を足し、互換の版で止まっているときと同じく、利用者が頼んだ 1 巡の最中でも止める。
  一時停止のまま押した 1 巡でメタデータが上限で断られた後に、本文の降ろし、設定の押し出し、本文の上げ（`uploader.sweep(Infinity)` は未送信の本文の数だけ要求を出す）、使用量の取りに行きが、同じ上限に断られる要求を重ねないためである（「今すぐ同期」は 1 回だけ試し直す。Task 1 の Q4）。
  説明のコメントに「上限で退いている間も、利用者が頼んだ 1 巡の最中でも止める（その 1 巡のメタデータの送受信が先に試し直し、まだ上限ならまた退いている）。」を足す。

```ts
export function syncHalted(o: { paused: boolean; oncePass: boolean; compatBlocked: boolean; limited: boolean }): boolean {
  return o.compatBlocked || o.limited || (o.paused && !o.oncePass);
}
```

  `isPaused` は `syncHalted({ paused: engine.status().state === 'paused', oncePass: pausedPass.active(), compatBlocked: engine.compatBlocked(), limited: engine.limitedUntil() !== null })` にする。
  `server.test.ts` の `syncHalted` の試験（`expect(syncHalted({ … }))` の並び）の既存の行に `limited: false` を足し、次の 2 行を足す。

```ts
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: false, limited: true })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: false, limited: true })).toBe(true);
```

- `syncNow` の `const paused = engine.status().state === 'paused' || (engine.compatBlocked() && engine.state.get('paused') === '1');` とその上のコメント 2 行を次にする。

```ts
    // 利用者が一時停止しているかは、止めた印で見る。
    // 状態の paused は上限で退いている間にも出るので、状態では見ない。版で止まっている間は状態が error になるので、なおさら印で見る。
    const paused = engine.state.get('paused') === '1';
```

`packages/server/src/server.test.ts` の 14 行の `import { … } from './sync/quota.ts';` を消し、28 行の import から `countingClient, `、`D1_WRITES_PER_FILE_DELETE, `、`D1_WRITES_PER_FILE_PUT, ` を消す。
`describe('ファイルの出し入れの勘定は Worker のスキーマから出す', …)` と `describe('無料枠の勘定', …)` を丸ごと消し、そこでしか使っていない補助（`stubClient`、`filesIndexes` など）も消す（`git grep -n -e stubClient -e filesIndexes -- packages/server/src/server.test.ts` で確かめる）。

- [ ] **Step 8: 見張りを消す**

```bash
git rm packages/server/src/sync/quota.ts packages/server/src/sync/quota.test.ts packages/server/src/sync/quota.account.test.ts
```

`packages/server/src/sync/engine.test.ts` を次のように直す。

| 試験 | 直し方 |
| --- | --- |
| `countingD1` の補助（25-47 行の付近） | 消す |
| 「一時停止中でも、利用者の syncNow は 1 回だけ送受信して、停止に戻る」 | `e.setPaused(true, 'quota');` を `e.setPaused(true);` にし、`toMatchObject({ state: 'paused', pausedReason: 'quota' })` を `toMatchObject({ state: 'paused', limitedUntil: null })` にし、コメントの「止めた理由も」を消す |
| 「無料枠の 80% に達したら…」「枠で止まった後に利用者が再開したら…」 | 消す |
| 「2 台で使っても、アカウント全体で 80% を超える前に両方が止まる」 | 消す |
| 「pull の要求も無料枠に数える」 | 消す |
| `makeEngine` と `pushEnoughToExceed` の補助、`describe('止めた理由')`、`describe('SyncEngine の無料枠の見張り')` | 消す |

Run: `git grep -n -e quota -e Quota -e d1RowsToday -e "setPaused(true, " -- packages/server/src/sync/engine.test.ts packages/server/src/sync/engine.restart.test.ts`
Expected: Step 2 で足した「このタスクの間は、退いていることを今の画面の形（pausedReason が quota）でも渡す」の試験の行（`pausedReason: 'quota'` と `quotaPausedDay`）だけ。Task 7 で消える（`D1_ROWS` と台帳の試験は偽のクラウドの側にだけ残る）。

- [ ] **Step 9: 通るのを見る**

Run: `npx vitest run packages/server packages/shared`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS（`SyncStatusDto` に `limitedUntil` が増えたので、`SyncStatusDto` と `SyncStatusBody` を手で組む固定値が型エラーになったら、`limitedUntil: null` を足す）。

- [ ] **Step 10: コミットする**

```bash
git add -A packages
```

```bash
git commit -m "feat(server): back off until the next UTC midnight on Cloudflare limit failures and drop the quota watch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: ヘッダーと設定の「無料枠で停止」を戻る時刻から出し、`pausedReason` と `quotaPausedDay` を消す

選んだ案：Q4 は案 B（上限で止まっている間、ヘッダーと設定の節のボタンは「今すぐ同期」だけにし、一時停止の切り替えは出さない）、Q5 は案 A（設定の「状態」も「無料枠で停止 · 9:00 に戻る」）。下のコードと試験は、この答えに合わせてある。

**Files:**
- Modify: `packages/shared/src/api.ts`（`SyncStatusDto` の `pausedReason`、`quotaPausedDay` と説明の 2 行。「古いサーバは送らない」の行を含む）
- Modify: `packages/server/src/sync/engine.ts`（`status()` の 3 行）
- Modify: `packages/ui/src/presenters/format.ts`（`limitedLabel` を足す）
- Modify: `packages/ui/src/presenters/shell.ts:29`、`:89-124`
- Modify: `packages/ui/src/presenters/settings.ts:20`（`CloudSettingsProps` に `limited`）、`:104-106`
- Modify: `packages/ui/src/presenters/cloudUsage.ts`（`limited` の 1 行）
- Modify: `packages/ui/src/views/SyncStatus.tsx:22`、`:26`、`:40`（一時停止の切り替え）
- Modify: `packages/ui/src/views/SettingsScreen.tsx:440`（一時停止の切り替え）
- Modify: `packages/ui/src/styles/sync.css:24-30`
- Modify: `packages/cli/src/cloud.ts:730-734`（`cloudStatus` の同期の行）
- Test: `packages/ui/src/presenters/presenters.test.ts:1391-1445`、`presenters/cloudUsage.test.ts`、`views/Shell.test.tsx`、`views/headerFold.test.tsx`、`views/workbench.test.tsx`、`views/misc.test.tsx`、`packages/server/src/sync/engine.test.ts`、`packages/cli/src/cloud.test.ts`

**Interfaces:**
- Consumes: Task 6 の `SyncStatusDto.limitedUntil`。Task 1 の Q4 と Q5 の答え。
- Produces：
  - `SyncStatusDto` から `pausedReason` と `quotaPausedDay` が消える。
  - `limitedLabel(until: number, tz?: string): string`（`format.ts`）が「無料枠で停止 · X に戻る」を作る。
  - `SyncProps` から `quotaBack` が消える。`reason` は `limitedUntil` から決める（`quota` か `user`）。
  - 上限で退いている間の `SyncProps.paused` と `CloudSettingsProps.paused` は偽（利用者は止めていない）。
  - `CloudSettingsProps.limited: boolean`（上限で退いているか）が足される。
  - 上限で退いている間（ヘッダーは `reason === 'quota'`、設定は `limited`）は、一時停止の切り替えのボタンを描かず、「今すぐ同期」だけを出す（Q4 の案 B）。

このタスクで `git grep -n "古いサーバは送らない"` の 1 件（`packages/shared/src/api.ts` の `pausedReason` の説明）が消える。
もう 1 件の `docs/superpowers/plans/2026-10-02-cloud-usage.md` は過去の計画なので書き換えない。
同じ形の「古いサーバは理由を送らない」（`ui/src/presenters/shell.ts` の 106 行）と「古いサーバで理由が無いときは」（`presenters.test.ts`）も、ここで消える。

Task 1 の答えとコードの対応は次のとおりである。

| 問い | 選んだ案 | コード |
| --- | --- | --- |
| Q4 | 案 B | 退いている間の `paused` は偽。`SyncStatus.tsx` の 2 つめのボタン（一時停止の切り替え）を `{props.reason !== 'quota' && …}` で包んで出さない。設定の側も `{!props.cloud.limited && …}` で包んで出さない |
| Q5 | 案 A | 設定の `stateLabel` も `limitedLabel` |

- [ ] **Step 1: 試験を書く**

`packages/ui/src/presenters/presenters.test.ts` の `describe('ヘッダーの無料枠で停止', …)` を次に置き換える。

```ts
describe('ヘッダーの無料枠で停止', () => {
  const at = (iso: string) => Date.parse(iso);
  const RESET = at('2026-10-03T00:00:00Z');
  const paused = (o: Partial<SyncStatusBody>): SyncStatusBody => syncStatus({ state: 'paused', ...o });
  // store.sync と state.sync（toSyncState(sync)）をそろえて、ヘッダーの同期の一行を返す。
  const shellSync = (sync: SyncStatusBody, now: number, tz?: string) => presentShell({ ...initialState(), sync: toSyncState(sync), pending: sync.pending }, { ...initialStore(), sync }, now, tz).sync;

  it('上限で退いている間は、戻る時刻を端末の時刻で言い、利用者が止めたことにはしない', () => {
    const p = shellSync(paused({ limitedUntil: RESET }), at('2026-10-02T06:48:00Z'), 'Asia/Tokyo');
    expect(p).toMatchObject({ label: '無料枠で停止 · 9:00 に戻る', reason: 'quota', paused: false, state: 'paused' });
    expect(p).not.toHaveProperty('quotaBack');
  });
  it('時差に依らない（ニューヨークでも同じ境目）', () => {
    expect(shellSync(paused({ limitedUntil: RESET }), at('2026-10-02T23:59:00Z'), 'America/New_York').label).toBe('無料枠で停止 · 20:00 に戻る');
  });
  it('一時停止のまま 1 回だけ同期している最中は、そのことを言う', () => {
    expect(shellSync(paused({ oncePass: true }), at('2026-10-02T06:48:00Z'))).toMatchObject({ label: '1 回だけ同期中…', once: true, paused: true });
    // 終われば元の文に戻る。
    expect(shellSync(paused({ oncePass: false }), at('2026-10-02T06:48:00Z'))).toMatchObject({ label: '一時停止中', once: false });
    // 設定の「状態」も同じ語で言う。
    const settings = presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync: paused({ oncePass: true }) }).cloud;
    expect(settings).toMatchObject({ stateLabel: '1 回だけ同期中…', once: true, paused: true });
  });
  it('手で止めたときは今までどおり', () => {
    expect(shellSync(paused({}), at('2026-10-02T06:48:00Z'), 'Asia/Tokyo')).toMatchObject({ label: '一時停止中', reason: 'user', paused: true });
  });
  it('止まっていなければ理由は null で、文も変わらない', () => {
    expect(shellSync(syncStatus({}), NOW, 'Asia/Tokyo')).toMatchObject({ reason: null, label: '同期 1 分前' });
  });
  it('エラーのときも理由は null', () => {
    expect(shellSync(syncStatus({ state: 'error', error: '切れました' }), NOW, 'Asia/Tokyo')).toMatchObject({ reason: null, label: '同期エラー: 切れました' });
  });
  it('設定の状態も同じ語で言い、利用者が止めたことにはせず、上限で退いていることを渡す', () => {
    const settings = presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync: paused({ limitedUntil: RESET }) }, at('2026-10-02T06:48:00Z')).cloud;
    expect(settings.paused).toBe(false);
    expect(settings.limited).toBe(true);
    expect(settings.stateLabel).toMatch(/^無料枠で停止 · \d{1,2}:00 に戻る$/);
    // 手で止めたときは limited ではない。
    expect(presentSettings(initialState(), { ...initialStore(), settings: fullSettings(), sync: paused({}) }).cloud).toMatchObject({ paused: true, limited: false });
  });
});
```

`packages/ui/src/views/Shell.test.tsx` の `it('無料枠で止まったときは点に data-reason を付け、文を警告の色にする', …)` の、最初の `render` の断言の後（`quotaBack: true` で描き直す行の前）に足す（Q4 の案 B）。

```tsx
    // 上限で退いている間は「今すぐ同期」だけを出し、一時停止の切り替えは描かない（試作の Q4 の案 B）。
    expect(screen.getByRole('button', { name: '今すぐ同期' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '同期を一時停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '同期を再開' })).toBeNull();
```

同じ `it` の、`reason: 'user'` で描き直した後の断言に足す。

```tsx
    // 手で止めたときは、再開のボタンを出す。
    expect(screen.getByRole('button', { name: '同期を再開' })).toBeInTheDocument();
```

`packages/ui/src/views/misc.test.tsx` の、設定の同期の節で「同期を一時停止」と「同期を再開」を押す試験（`fireEvent.click(screen.getByRole('button', { name: '同期を一時停止' }))` のある `it`）の次に、同じ描き方で `cloud` に `paused: false, limited: true, state: 'paused', stateLabel: '無料枠で停止 · 9:00 に戻る'` を渡し、「今すぐ同期」はあり、「同期を一時停止」と「同期を再開」は無いことを確かめる `it` を足す（名前は「上限で退いている間は、設定の節も今すぐ同期だけを出す」）。
`CloudSettingsProps` を手で組む固定値には `limited: false` を足す（型が求める）。

同じファイルの `syncStatus` の固定値に `limitedUntil: null` が無ければ足す（Task 6 の Step 9 で足していれば、そのまま）。
`describe('同期の Presenter（フェーズ 4）', …)` の `toEqual({ … reason: null, quotaBack: false, once: false })` から `quotaBack: false, ` を消す。

`packages/ui/src/presenters/cloudUsage.test.ts` の `limitedSync` を次にする（`sync` の固定値の `limitedUntil: null` は Task 6 の Step 9 で足してある。無ければ足す）。

```ts
/** 上限で退いている同期の状態。 */
const limitedSync = (): SyncStatusBody => sync({ state: 'paused', limitedUntil: RESET });
```

`packages/ui/src/views/Shell.test.tsx` の `it('無料枠で止まったときは点に data-reason を付け、文を警告の色にする', …)` の、`quotaBack: true` で描き直す 2 行の `rerender` とその断言（枠が戻った後の 3 行）を消す。
`quotaBack` を含む固定値を直す。

```bash
sed -i '' -e 's/, quotaBack: false//g' -e 's/, quotaBack: true//g' packages/ui/src/views/Shell.test.tsx packages/ui/src/views/headerFold.test.tsx packages/ui/src/views/workbench.test.tsx packages/ui/src/views/misc.test.tsx
```

`packages/server/src/sync/engine.test.ts` の「このタスクの間は、退いていることを今の画面の形（pausedReason が quota）でも渡す」を消し、互換の版の「一時停止していても、版で止まったことを error で見せる」の `expect(e.status().pausedReason).toBeNull();` を `expect(e.status().limitedUntil).toBeNull();` にする。

`packages/cli/src/cloud.test.ts` の `describe('cloudStatus', …)` の最初の `it` の最後に足す。

```ts
    // 上限で退いている間は、戻る時刻を添える。
    const limited = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u === 'https://h/health') return new Response(JSON.stringify({ ok: true, version: '0.4.0' }), { status: 200 });
      return new Response(JSON.stringify({ state: 'paused', pending: 0, lastPullAt: 1000, lastPushAt: 1000, deviceCount: 2, url: 'https://h', error: null, limitedUntil: Date.UTC(2026, 9, 9) }), { status: 200 });
    }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: limited, now: () => 61_000 })).toContain('無料枠の上限で 2026-10-09T00:00:00.000Z まで止めています');
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/views packages/cli/src/cloud.test.ts`
Expected: FAIL（ヘッダーは `pausedReason` を見ていて、`limitedUntil` では「無料枠で停止」にならない。CLI は戻る時刻を出さない）。

- [ ] **Step 3: 型とエンジンから外す**

`packages/shared/src/api.ts` の `SyncStatusDto` の説明の「pausedReason は止めた理由。…古いサーバは送らない（undefined）。」と「quotaPausedDay は見張りが止めた UTC の日（yyyy-MM-dd）。」の 2 行を消し、型から `; pausedReason?: 'quota' | 'user' | null; quotaPausedDay?: string | null` を消す。

`packages/server/src/sync/engine.ts` の `status()` の `// 段 1 の PR 5 の Task 7 で消す。…`、`pausedReason: …,`、`quotaPausedDay: …,` の 3 行を消す。

- [ ] **Step 4: 画面を直す**

`packages/ui/src/presenters/format.ts` の `SYNC_STATE_LABEL` の次に足す。

```ts
/**
 * Cloudflare の上限で退いている間の同期の一行。戻る時刻（次の UTC の 0 時）を端末の時刻で書く。
 * ヘッダーと設定の「状態」が同じ語で言う。tz は試験でだけ決めて渡す。
 */
export function limitedLabel(until: number, tz?: string): string {
  return `無料枠で停止 · ${new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(until)} に戻る`;
}
```

`packages/ui/src/presenters/shell.ts` の `SyncProps` から `quotaBack: boolean; ` を消し、`reason` の型の説明として `/** quota は Cloudflare の上限で退いている、user は利用者が止めた。 */` を `reason` の前に置く。
`resetClockLabel`（89-95 行）を消し、`syncProps` を次にする（説明のコメントも、上限で退く形に合わせて直す）。

```ts
/**
 * ヘッダーに出す同期の一行。
 * 同期を設定していない端末（off）では出さないので、visible を false にする。
 * 一度も往復していない間は時刻が無いので、時刻の代わりに準備中と出す。
 * Cloudflare の上限で退いている間（state は paused で、戻る時刻 limitedUntil がある）は、手で止めたのと分けて、いつ戻るかを言う。
 * 上限で退いているのは利用者が止めたのではないので paused は偽にし、一時停止の切り替えは描かない（試作の Q4 の案 B。view は reason を見る）。
 * tz は端末の時差で、試験でだけ決めて渡す。
 */
function syncProps(state: State, store: Store, now: number, tz?: string): SyncProps {
  const s = state.sync;
  const limitedUntil = s.kind === 'paused' ? (store.sync?.limitedUntil ?? null) : null;
  const reason = s.kind === 'paused' ? (limitedUntil !== null ? 'quota' : 'user') : null;
  // 一時停止のまま押した 1 巡の最中。状態は paused のままなので、付録の印で見分ける。
  const once = s.kind === 'paused' && store.sync?.oncePass === true;
  // 語は設定の「状態」と同じ表から引く。
  const label =
    s.kind === 'off' ? ''
    : once ? SYNC_ONCE_LABEL
    : limitedUntil !== null ? limitedLabel(limitedUntil, tz)
    : s.kind === 'error' ? `${SYNC_STATE_LABEL.error}: ${s.message}`
    : s.kind !== 'idle' ? SYNC_STATE_LABEL[s.kind]
    : s.lastAt === null ? '同期の準備中'
    : `同期 ${relativeTime(s.lastAt, now)}`;
  return { visible: s.kind !== 'off', state: s.kind, label, pending: state.pending, sweepPending: store.sync?.sweepPending ?? 0, skipped: store.sync?.skipped.length ?? 0, paused: s.kind === 'paused' && limitedUntil === null, reason, once };
}
```

`shell.ts` の import に `limitedLabel` を足す（`./format.ts` から）。

`packages/ui/src/presenters/settings.ts` の `CloudSettingsProps` の `paused: boolean;` の次に `/** Cloudflare の上限で退いているか。そのあいだは一時停止の切り替えを出さない（試作の Q4 の案 B）。 */ limited: boolean;` を足す。
`stateLabel` と `paused` の 2 行を次にし、import に `limitedLabel` を足す。

```ts
    stateLabel: sync?.state === 'paused' && sync.oncePass ? SYNC_ONCE_LABEL
      : sync?.state === 'paused' && sync.limitedUntil !== null ? limitedLabel(sync.limitedUntil)
      : SYNC_STATE_LABEL[sync?.state ?? 'off'],
    // 上限で退いているのは利用者が止めたのではないので、一時停止とは言わない。そのあいだは切り替えを出さない（limited）。
    paused: sync?.state === 'paused' && sync.limitedUntil === null,
    limited: sync?.state === 'paused' && sync.limitedUntil !== null,
```

`packages/ui/src/views/SettingsScreen.tsx` の一時停止の切り替え（`<button className="btn" onClick={() => emit({ type: 'sync.pause', paused: !props.cloud.paused })}>…</button>`）を `{!props.cloud.limited && …}` で包み、上に「上限で退いている間は、利用者は止めていないので切り替えを出さず、今すぐ同期だけにする（試作の Q4 の案 B）。」のコメントを置く。

`packages/ui/src/presenters/cloudUsage.ts` の `limited` の 2 行を次にする。

```ts
  // 上限で退いているか。
  const limited = sync?.state === 'paused' && sync.limitedUntil !== null;
```

`packages/ui/src/views/SyncStatus.tsx` の 22 行から `data-quota-back={props.quotaBack ? '' : undefined} ` を消し、26 行の `className` を次にする。

```tsx
      <a className={props.once ? 'mono sync-label faint' : props.state === 'error' || props.reason === 'quota' ? 'mono sync-label sync-error' : 'mono sync-label faint'} href={formatRoute(SETTINGS)} title={`${[props.label, ...counts].join('、')}（押すと同期の設定を開く）`} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: SETTINGS }); }}>
```

同じファイルの 2 つめのボタン（一時停止の切り替え）を `{props.reason !== 'quota' && …}` で包み、上に「上限で退いている間は、利用者は止めていないので切り替えを出さず、今すぐ同期だけにする（試作の Q4 の案 B）。」のコメントを置く。
`SyncStatus` の説明のコメントと、状態の点の上のコメントにある「同期を一時停止」の言い方は、上限の間は出さないことに合わせて直す（設定への道の説明は残す）。

`packages/ui/src/styles/sync.css` の 24 行と 25 行のコメントを「Cloudflare の上限で止まったときは、手で止めたのと見分けがつくよう点を赤にする（2026-10-02 の決定 H1）。」にし、26 行から 28 行（`[data-quota-back]` の規則とそのコメント、`.sync-warn`）を消す。
30 行はそのまま残す。
`.sync-warn` がほかで使われていないことを `git grep -n sync-warn -- packages/ui/src` で確かめる。

- [ ] **Step 5: CLI の状態の行に戻る時刻を添える**

`packages/cli/src/cloud.ts` の `cloudStatus` の同期の行を次にする。

```ts
    const limited = typeof s.limitedUntil === 'number' ? `、無料枠の上限で ${new Date(s.limitedUntil).toISOString()} まで止めています` : '';
    lines.push(
      `同期: ${s.state}${s.error ? `（${s.error}）` : ''}${limited}、未送信 ${s.pending} 件、最終 pull ${relative(s.lastPullAt, t)}、最終 push ${relative(s.lastPushAt, t)}、端末 ${s.deviceCount} 台`,
    );
```

- [ ] **Step 6: 通るのを見る**

Run: `git grep -n -e pausedReason -e quotaPausedDay -e quotaBack -e data-quota-back -- packages`
Expected: 何も出ない（Task 8 のマイグレーションとその試験が `sync_state` の鍵の名前として `pausedReason` を書くのは、このタスクの後である）。

Run: `git grep -n "古いサーバは送らない"`
Expected: `docs/superpowers/plans/2026-10-02-cloud-usage.md` の 1 件だけ。

Run: `npx vitest run packages/shared packages/server packages/ui packages/cli`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 7: コミットする**

```bash
git add -A packages
```

```bash
git commit -m "feat(ui): show the limit back-off from limitedUntil and drop pausedReason and quotaPausedDay" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 端末の後始末のマイグレーション（版 16）

**Files:**
- Modify: `packages/server/src/db/migrations.ts`（末尾に 1 つ足す）
- Test: `packages/server/src/db/db.test.ts`

**Interfaces:**
- Consumes: PR 4 の `seedDbAt`（`packages/server/test/oldDb.ts`）。段 0 の控え。
- Produces: 版 16。
  `sync_state` の `quota:` で始まる鍵（日ごとの数えと `quota:pausedDay`）と `pausedReason` を消す。
  見張りが止めていた端末（`pausedReason` が `quota`）は、`paused` も消して一時停止を解く。

spec の「後始末」のうち、端末の分である。
見張りが止めていた一時停止を残すと、入れ替えた後もその端末は止まったままになり、画面は利用者が止めたもの（「一時停止中」）として見せる。
見張りはもう無く、上限に当たれば Cloudflare が断り、端末は次の 0 時まで退くので、見張りの一時停止は解く。
利用者が自分で止めた一時停止（`pausedReason` が `user`、または理由の無いもの）は、そのまま残す。
`meta` の `d1_rows:*` は Worker の側（PR 6）で消す。
Claude Code の設定の同期の記録（`file_sync` の `kind='config'` の行、`configPullConfirmed`、`configPending`、`skipped:(config)`）は、設定の同期を残すので消さない。

- [ ] **Step 1: 版を数え直す**

Run: `git grep -n "version: " -- packages/server/src/db/migrations.ts`
Expected: 最後が `version: 15,`（PR 4 はマイグレーションを足さない）。
違えば、このタスクの 16 を「最後の版 + 1」に、試験で `seedDbAt` に渡す 15 を「最後の版」に読み替える。

- [ ] **Step 2: 試験を書く**

`packages/server/src/db/db.test.ts` の `describe('openDb', …)` の最後に足す。

```ts
  it('version 16 で見張りの名残を消し、見張りが止めた一時停止だけを解く', () => {
    const seedState = (rows: [string, string][]): string => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mig-'));
      seedDbAt(path.join(tmp, 'hangar.db'), 15, (db) => {
        const st = db.prepare('insert into sync_state (key, value) values (?, ?)');
        for (const [k, v] of rows) st.run(k, v);
      });
      return tmp;
    };
    const keysAfter = (tmp: string): string[] => {
      const db = openDb(path.join(tmp, 'hangar.db'));
      try {
        return (db.prepare('select key from sync_state order by key').all() as { key: string }[]).map((r) => r.key);
      } finally {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };
    const common: [string, string][] = [['quota:2026-10-07', '{"rows":1,"requests":1}'], ['quota:pausedDay', 'quota:2026-10-07'], ['lastSeq', '9'], ['skipped:transcripts/dev-b/u1.jsonl.gz', '{}']];
    // 見張りが止めていた端末は、一時停止も解く。
    expect(keysAfter(seedState([...common, ['paused', '1'], ['pausedReason', 'quota']]))).toEqual(['lastSeq', 'skipped:transcripts/dev-b/u1.jsonl.gz']);
    // 利用者が止めていた端末は、止めたまま。
    expect(keysAfter(seedState([...common, ['paused', '1'], ['pausedReason', 'user']]))).toEqual(['lastSeq', 'paused', 'skipped:transcripts/dev-b/u1.jsonl.gz']);
    // 理由の無い古い一時停止も、利用者が止めたものとして残す。
    expect(keysAfter(seedState([...common, ['paused', '1']]))).toEqual(['lastSeq', 'paused', 'skipped:transcripts/dev-b/u1.jsonl.gz']);
  });
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/db/db.test.ts -t "version 16"`
Expected: FAIL（`quota:` の鍵と `pausedReason` が残り、見張りの一時停止も残る）。

- [ ] **Step 4: マイグレーションを足す**

`packages/server/src/db/migrations.ts` の `MIGRATIONS` の最後（版 15 の後）に足す。

```ts
  {
    // 段 1 で消した端末の無料枠の見張り（D4）が端末に残したものを、1 回だけ消す。
    // quota: で始まる鍵は、日ごとの数え（quota:<yyyy-MM-dd>）と、見張りが止めた日（quota:pausedDay）である。
    // pausedReason は止めた理由で、見張りが止めたとき quota、利用者が止めたとき user だった。
    // 見張りが止めた一時停止は解く。見張りはもう無く、上限に当たれば Cloudflare が断り、端末は次の UTC の 0 時まで退く（sync/engine.ts）。
    // 残すと入れ替えた後も止まったままになり、画面は利用者が止めたものとして見せる。
    // 利用者が止めた一時停止（user と、理由の無い古いもの）はそのまま残す。
    // Worker の meta の d1_rows:* は、Worker の側（段 1 の PR 6）で消す。
    // Claude Code の設定の同期の記録（file_sync の config の行と、configPullConfirmed などの鍵）は、設定の同期を残すので触らない。
    version: 16,
    sql: `
delete from sync_state where key = 'paused' and exists (select 1 from sync_state where key = 'pausedReason' and value = 'quota');
delete from sync_state where key = 'pausedReason';
delete from sync_state where key like 'quota:%';
`,
  },
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/server/src/db`
Expected: PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/server/src/db/migrations.ts packages/server/src/db/db.test.ts
```

```bash
git commit -m "feat(server): clean up the quota watch leftovers in migration 16" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 設計書と README を直す

**Files:**
- Modify: `docs/design.md`（1803-1816、2192、2286-2333、2355-2365、2432、2552、2572、2659-2680、2714 の付近）
- Modify: `README.md`（264、341-349、368 の付近）

**Interfaces:**
- Consumes: Task 2 から Task 8 のすべて。
- Produces: なし。

行番号は main `33ca14e` のもので、その後の PR と PR 4（design.md の `backups/db/` の箇条に 2 行足す）でずれているので、引用した文で探す。
Claude Code の設定の同期の記述（「同期対象と暗号化」の設定の段、設定の押し出しの段など）は、設定の同期を残すので触らない。

- [ ] **Step 1: design.md の Settings の節を直す**

1805 行付近「今日の枠の棒には止める線（上限の 80%）に目盛りを打つ。」を消す。
1806 行付近の添え書きの文を「添え書きは「今日の枠は 9:00 に戻る」と、出どころ（「Cloudflare の数 · 2 分前」か「数は不明（hangar は数えません）」）である。」にする。
1809 行から 1812 行付近（止まりそう、無料枠で止まっている、食い違い、トークンなし）を次の 4 行に置き換える。

```
D1 が上限の 80% 以上なら、札と棒を注意の色にして「あと N 行で無料枠の上限です」と出す。
Cloudflare の上限で退いている間は、札と棒を止まった色にして、枠が戻る時刻と、戻れば自動で再開することを帯で言う。
トークンを入れていない端末では、hangar は数えないので、札を 3 枚とも値の無い印と「トークンが要ります」にし、今日の棒は描かず、案内の帯と `npm run hangar -- setup cloud --usage-token` を出す。
一時停止と上限の間は Cloudflare に問い合わせないので、そのときは「トークンが要ります」の代わりに「同期の停止中」と言う。
```

1815 行付近を「ヘッダーの同期の一行は、Cloudflare の上限で退いている間「無料枠で停止 · 9:00 に戻る」（赤い点）と言い、ボタンは「今すぐ同期」だけにする（利用者は止めていないので、一時停止の切り替えは出さない）。設定の「状態」も同じ語で言う。」にする。
Q1、Q4、Q5 の答え（Task 1 の冒頭）は、上の文にすでに入れてある。

- [ ] **Step 2: design.md のクラウド同期の節を直す**

2192 行付近の「ただし、無料枠の数え直し（Worker が数えて push の応答で返す形）と孤児の掃除はその後に入れたもので、」を「ただし、孤児の掃除はその後に入れたもので、」にする。

「使用量と費用」の節（2286 行付近から）の「**端末のサーバ。**」の段のうち、次の 2 文を直す。

- 「一時停止は「外と話すのをやめる」ことで、無料枠で止まったときも同じだからである。」を「一時停止は「外と話すのをやめる」ことで、Cloudflare の上限で退いている間も同じだからである。」にする。
- 「要求は `countingClient` を通し、…」と「古い Worker（404）と `configured: false` は「トークンなし」として扱い、数は hangar の見積もり（`QuotaCounter`）に切り替える。」の 2 行を、次の 2 行にする。

```
古い Worker（404）と `configured: false` は「トークンなし」として扱い、形は「数は不明」（`source` が `unknown`、今日の数は null）にする。
hangar は量を数えない（段 1、D4）。
```

- 「上限は共有の定数 `CLOUD_FREE_LIMITS`（`packages/shared`）に置き、D1 と Workers の日の枠は `QUOTA_LIMITS` と同じ値を指す。」を「上限は共有の定数 `CLOUD_FREE_LIMITS`（`packages/shared`）に置く。」にする。

「**止めた理由。**」の段（2317-2323 行付近）を次に置き換える。

```
**上限で退く。**
段 1（D4）で、端末が数えて 80% で止める見張り（`QuotaCounter`、`pausedReason`、`quotaPausedDay`）を消した。
代わりに、Cloudflare の上限による失敗を受けたら、次の UTC の 0 時まで同期を止める。
見分けるのは同期の client（`sync/client.ts` の `LimitError`、判定は共有の `cloudLimit.ts` の `readCloudLimit`）で、Worker の 429 と上限の本文、本文に D1 の上限のメッセージを含むもの、JSON でなく `1027` を含むもの（Workers の 1 日の要求の上限）の 3 つである。
上限の検査は版の検査より先に行う。端が返す `1027` の頁は版の見出しを持たないからである。
`SyncEngine` は戻る時刻を `sync_state` の `limitedUntil` に置き、push と pull の入口を閉じる。立て直しても、戻る時刻までは外へ出ない。
時刻を過ぎた最初の定期実行（30 秒ごと）で自分で戻り、まだ断られればまた次の 0 時まで退く。
新しく退いたときだけトーストで 1 度知らせ、同期の状態の `error` には残さない。
利用者の「今すぐ同期」は 1 回だけ試し直す。
同期の状態には `limitedUntil` を載せ、退いている間の `state` は `paused` である。利用者が一時停止しているときは、一時停止を先に見せる。
本文の上げ下ろしは、上限の失敗を諦めに数えない。
いまの Worker は D1 の失敗を 500 で返すので、D1 の上限が 429 で届くのは段 1 の PR 6 からである。
```

「タイミングと競合」の節の 2355 行付近「無料枠の 80% に達したら、同期を自動で一時停止してトーストで知らせる。」から「…その日いっぱい押せないボタンになる。」（2365 行付近）までを、次の 4 行に置き換える。

```
無料枠は数えない（段 1、D4）。
Cloudflare の上限による失敗を受けたら、次の UTC の 0 時まで同期を止めてトーストで知らせ、日が変われば自分で戻る（「使用量と費用」の「上限で退く」）。
Free は上限を超えても課金されず、失敗が返るだけである。
Worker の台帳（`meta` の `d1_rows:<yyyy-MM-dd>` と、push と pull の応答の `d1RowsToday`）は段 1 の PR 6 で消すまで残るが、端末はもう読まない。
```

2432 行付近の「止めた理由（利用者、無料枠）は書き換えず、無料枠で止まっているときも利用者が押した 1 回として通す。」を「止めた状態は書き換えない。上限で退いた印は、利用者が押した 1 回として外して試し直す。」にする。

- [ ] **Step 3: design.md の決めた前提を直す**

2552 行付近のフェーズ 4 の並びの「無料枠の見張り」の後ろに「（段 1 で消し、上限で退く形に替えた）」を足す。

2572 行付近の版の数「版は 15 まで」を「版は 16 まで」にし、括弧の並びの末尾に「、16 で無料枠の見張りの名残（`sync_state` の `quota:*` と `pausedReason`）を消し、見張りが止めた一時停止を解いた」を足す。

2659 行付近「無料枠の 80% で同期を自動で一時停止し、トーストで知らせる。課金される形にはしない。止めるのは 1 日に 1 度だけにする。」を、次にする。

```
- 段 1（D4）で、端末の無料枠の見張りを消した。端末は数えず、Cloudflare の上限による失敗を受けたら次の UTC の 0 時まで退く。下の 2660 行から 2680 行の付近の決定（行数の数え方、Worker の台帳、台数割り）は段 1 の前のもので、Worker の台帳は段 1 の PR 6 で消す。
```

2714 行付近の既知の限界「無料枠の数え直しと孤児の掃除は、偽のクラウドとローカルの workerd（miniflare）の試験だけで確かめた（2026-09-20）。」を「孤児の掃除は、偽のクラウドとローカルの workerd（miniflare）の試験だけで確かめた（2026-09-20）。上限で退く処理も、偽のクラウドと手元の Worker の前に置いた中継（段 1 の PR 5 の試し）でだけ確かめた。」にする。

- [ ] **Step 4: README を直す**

264 行付近の「無料枠（…）に収まる規模で、枠の 80% に達したら同期を自動で止めます。」を「無料枠（…）に収まる規模です。上限に達すると Cloudflare が断るので、そのときは次の UTC の 0 時まで同期を止め、日が変わると自動で再開します。」にする。

割り切りと限界の 2（「**無料枠の 80% に達すると同期が一時停止します。**」から「…先に当たるのは必ず D1 の書き込みの側です。」まで）を、次にする。

```
2. **無料枠の上限に達すると、次の UTC の 0 時まで同期が止まります。**
   hangar は量を数えません。
   上限に達すると Cloudflare が断るので、その失敗を見分けて止め、日が変わると自動で再開します。
   無料プランは上限を超えても課金されず、要求が断られるだけです。
   止まっている間に「今すぐ同期」を押すと、1 回だけ試し直します。
   なお R2 自身の枠は月ごとの別勘定で、この使い方（1 セッションを 1 日走らせて上げ下ろしが 2,880 回ほど）では月の上限に対して桁が 2 つ小さく、先に当たるのは必ず D1 の書き込みの側です。
```

確認の段（368 行付近）の「無料枠の数え方と孤児の掃除はこの確認より後に入れたもので、」を「孤児の掃除と上限で退く処理はこの確認より後に入れたもので、」にする。

- [ ] **Step 5: 中黒とダッシュが無いことを確かめる**

Run: `git diff -U0 docs/design.md README.md | grep '^+' | grep -n -e '・' -e '—' -e '――'`
Expected: 何も出ない（試作の値の無い印はコードの中だけで、文書には書かない）。

- [ ] **Step 6: コミットする**

```bash
git add docs/design.md README.md
```

```bash
git commit -m "docs: describe backing off on Cloudflare limits instead of the quota watch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 全体の確かめとビルド

**Files:**
- なし（直しが要ったときだけ、そのファイルを直してコミットする）。

**Interfaces:**
- Consumes: Task 1 から Task 9 のすべて。
- Produces: なし。

- [ ] **Step 1: 消したものが残っていないことを確かめる**

Run: `git grep -n -e QuotaCounter -e guardQuota -e countingClient -e D1_WRITES_ -e pushD1Writes -e quotaDayKey -e QUOTA_ -e stopRatio -e "'estimate'" -e pausedReason -e quotaPausedDay -e quotaBack -- packages ':!packages/cloud'`
Expected: 出るのは、Task 8 のマイグレーションとその試験の `pausedReason` だけ。

Run: `git grep -n d1RowsToday -- packages ':!packages/cloud'`
Expected: 出るのは、共有の型（Worker が作るので残す）と、偽のクラウドとその試験（Worker の写し）だけ。
`packages/server/src` からは何も出ない。

Run: `git grep -n "古いサーバは送らない"`
Expected: `docs/superpowers/plans/2026-10-02-cloud-usage.md` の 1 件だけ（過去の計画なので書き換えない）。

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

- [ ] **Step 4: 画面を目で確かめる**

動いているアプリ（4177）の実データに worktree の `packages/ui/dist` を重ねて WebKit で撮り、自分の目で見る（手順は memory の reference-overlay-ui-check）。
読むだけにし、ボタンは押さない。
見るのは、設定の「使用量と費用」（いまの実データの形）である。
上限で止まっている姿は実データでは作れないので、Task 11 の試しのサーバで見る。

- [ ] **Step 5: 直しがあればコミットする**

Step 1 から Step 4 で直したものがあれば、直したファイルだけを `git add` し、次でコミットする。

```bash
git commit -m "fix: follow-ups from the stage 1 PR 5 verification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

PR を出し、CI の 3 つのジョブ（check、desktop、windows）を待つ。
CI が緑でも、Task 11 の 1 日の試しが終わるまでマージしない。

---

### Task 11: 写しの DB で 1 日試す

**Files:**
- なし（試しの置き場は `$HOME/.agent-hangar-trial/` の下に作り、リポジトリには何も足さない）。

**Interfaces:**
- Consumes: Task 10 のビルド（worktree の `packages/ui/dist`）。
- Produces: 試しの記録（報告に書く）。

spec の入れる条件「写しの DB で 1 日使ってから入れる」の手順である。
写しを別の `HANGAR_HOME` に置き、別のポートで、この PR のサーバを 1 日動かす。
この PR の要の「上限で退き、日が変われば戻る」は、試しのサーバと手元の Worker の間に小さな中継を置き、中継に上限の失敗を返させて確かめる。
1 日の試しは UTC の 0 時を必ずまたぐので、「日が変われば自分で戻る」を実物の時計で確かめられる。

実物のクラウドには触らない。
理由は 3 つある。
1 つめに、`device.json` を写すと、同じ端末が 2 台になり、同じ端末トークンで実物の Worker の進み具合と R2 の同じ鍵を取り合う。
2 つめに、`device.json` を写さずに実物へ参加し直すと、実物の D1 に消す口の無い端末の行が 1 つ増える。
3 つめに、上限の失敗をわざと実物で起こすことは spec の範囲の外である（「error 1027 を実際に起こして形を確かめること」）。

| 置き場のもの | 写すか | 理由 |
| --- | --- | --- |
| `hangar.db` | 写す（SQLite の `.backup` で） | 試す相手である。実物は動いているので、ファイルの複写ではなく SQLite の写しの口で取る |
| `settings.json` | 写して、`syncClaudeConfig` を切る | ワークスペース、`claudeDir`、tmux を同じにする。Claude Code の設定の同期は残っている（全体計画の D6）ので、入れたままだと試しのサーバが本物の `~/.claude` を見張って上げ、相手の設定を本物の `~/.claude` へ書きうる |
| `device.json` | 写さない | 写すと同じ端末が 2 台になる。試しのサーバは新しい ID を作る |
| `token` | 写さない | 試しのサーバは自分の token を作る。本物の画面と statusline が試しのサーバに届かない |
| `cloud.json`、`cloud/` | 写さない | 実物の Worker の端末トークンと参加用の秘密と wrangler の設定を持つ |
| `accounts.json` | 写さない | 試しの画面からアカウントを足したり切り替えたりしない |
| `remote/`、`backups/`、`bin/`、`shell/`、`logs/`、`drops/`、`scratch/` | 写さない | 試しのサーバが自分の置き場に作る |

試しのサーバは、`HANGAR_CLAUDE_BIN` を `/usr/bin/false` にして起こす。
写しの DB の状態の印は実物の画面で変えても追いつかないので、試しのサーバの「区切りで止める」（ParkWatch）が、実物では印を外したバックグラウンドのセッションに `claude stop` を打ちうるからである。
そのため試しの画面では、要約と、会話を起こす操作は動かない。
試しの画面からは、会話を起こさない、「この PC で再開」を押さない、会話の保持期間を書き込まない、設定の同期を入れない（どれも `~/.claude` に書くか、本物のアプリが知らない run を作る）。
設定の同期と上限の関わり（その回を打ち切り、ファイルごとに知らせない）は Task 4 の試験で押さえ、この試しでは見ない。

- [ ] **Step 1: 試しの置き場を作る**

```bash
mkdir -p "$HOME/.agent-hangar-trial/stage1-pr5"
```

```bash
chmod 700 "$HOME/.agent-hangar-trial" "$HOME/.agent-hangar-trial/stage1-pr5"
```

以下、この置き場を `$TRIAL` と書く（打つときは `TRIAL="$HOME/.agent-hangar-trial/stage1-pr5"` を先に置く）。

- [ ] **Step 2: DB と設定を写す**

```bash
sqlite3 "$HOME/.agent-hangar/hangar.db" ".backup '$TRIAL/hangar.db'"
```

```bash
cp "$HOME/.agent-hangar/settings.json" "$TRIAL/settings.json"
```

写した設定の、Claude Code の設定の同期を切る（上の表の理由）。

```bash
node -e "const fs = require('node:fs'); const f = process.argv[1]; const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.syncClaudeConfig = false; fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');" "$TRIAL/settings.json"
```

```bash
grep -n syncClaudeConfig "$TRIAL/settings.json"
```

Expected: `"syncClaudeConfig": false` の 1 行。

- [ ] **Step 3: 移行の前の数を控える**

```bash
sqlite3 "$TRIAL/hangar.db" "select max(version) from schema_migrations; select count(*) from sync_state where key like 'quota:%'; select key, value from sync_state where key in ('paused','pausedReason');"
```

数を報告の下書きに残す（数そのものは公開の文書に書かない）。

- [ ] **Step 4: マイグレーションだけを先に当てて確かめる**

```bash
F="$TRIAL/hangar.db" npx tsx -e "import('./packages/server/src/db/open.ts').then((m) => m.openDb(process.env.F).close())"
```

```bash
sqlite3 "$TRIAL/hangar.db" "select max(version) from schema_migrations; select count(*) from sync_state where key like 'quota:%' or key = 'pausedReason'; select key, value from sync_state where key = 'paused';"
```

Expected: 版は 16、`quota:` と `pausedReason` は 0。
`paused` は、移行の前の `pausedReason` が `user` なら残り、`quota` なら消えている。

```bash
ls "$TRIAL/backups/db"
```

Expected: `hangar-v15-<時刻>.db` が 1 つ。

- [ ] **Step 5: 写しの同期の進み具合を消す**

写しには実物の Worker の進み具合と一時停止が入っているので、手元の Worker と始め直せるように消す。

```bash
sqlite3 "$TRIAL/hangar.db" "delete from sync_state where key in ('lastSeq','snapshotDone','filesSeq','lastPushAt','lastPullAt','lastError','paused','transcriptsFrom','limitedUntil') or key like 'skipped:%';"
```

- [ ] **Step 6: 手元の Worker と中継を起こす**

参加用の秘密と、その指紋を作る。

```bash
SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
```

```bash
HASH=$(node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$SECRET")
```

Worker を背面で起こす（Bash の `run_in_background` を使う）。

```bash
WRANGLER_SEND_METRICS=false npx wrangler dev --config packages/cloud/wrangler.jsonc --ip 127.0.0.1 --port 8787 --persist-to "$TRIAL/worker-state" --var "JOIN_SECRET_HASH:$HASH"
```

中継を試しの置き場に書く（Write で書く）。
`$TRIAL/limit` に上限の種類を 1 行書いている間だけ、`/health` を除く要求に上限の失敗を返し、それ以外は手元の Worker へ渡す。

`$TRIAL/limit-proxy.mjs`：

```js
// 試しのサーバと手元の Worker の間に立つ中継。
// <置き場>/limit に d1-write か d1-read か requests を書いている間だけ、上限の失敗を返す。
// d1-*：段 1 の PR 6 の Worker が返す形（429 と上限の本文）。
// requests：Cloudflare の error 1027 の真似（JSON でない頁）。
import fs from 'node:fs';
import http from 'node:http';

const [, , trial, upstreamPort, listenPort] = process.argv;
const flag = `${trial}/limit`;
const nextUtcMidnight = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

http.createServer((req, res) => {
  let kind = '';
  try { kind = fs.readFileSync(flag, 'utf8').trim(); } catch { /* 書いていなければ上限は無い */ }
  console.log(new Date().toISOString(), req.method, req.url, kind || '-');
  if (kind && req.url !== '/health') {
    req.resume();
    if (kind === 'requests') {
      res.writeHead(429, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Error 1027</h1><p>error code: 1027</p></body></html>');
      return;
    }
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'limit', limit: kind, resetAt: nextUtcMidnight() }));
    return;
  }
  const up = http.request({ host: '127.0.0.1', port: Number(upstreamPort), method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('upstream'); });
  req.pipe(up);
}).listen(Number(listenPort), '127.0.0.1');
```

中継を背面で起こす（`run_in_background`）。
出力は `$TRIAL/proxy.log` に残す（要求の数を数えるのに使う）。

```bash
node "$TRIAL/limit-proxy.mjs" "$TRIAL" 8787 8788 > "$TRIAL/proxy.log" 2>&1
```

```bash
curl -s http://127.0.0.1:8788/health
```

Expected: `{"ok":true,…}`。

- [ ] **Step 7: 写しを中継の先の Worker に参加させる**

宛先は中継（8788）にする。

```bash
TOKEN=$(SECRET="$SECRET" npx tsx -e "import('./packages/shared/src/cloud.ts').then((m) => console.log(m.encodeJoinToken({ url: 'http://127.0.0.1:8788', secret: process.env.SECRET })))")
```

```bash
printf '%s' "$TOKEN" | HANGAR_HOME="$TRIAL" npm run hangar -- join --force
```

Expected: 「参加しました: http://127.0.0.1:8788」。

- [ ] **Step 8: 試しのサーバを起こす**

試しのサーバを起こす小さな台本を、試しの置き場に書く（Write で書く）。

`$TRIAL/start.sh`：

```sh
#!/bin/sh
# 試しのサーバ。本物の hangar から受け継いだ環境を外し、写しの置き場と別のポートで起こす。
# 1 つめの引数は、この PR の worktree の根である。
set -eu
unset HANGAR_PARENT_PID HANGAR_UI_DIST HANGAR_PORT HANGAR_CLOUD_DIR
export HANGAR_HOME="$HOME/.agent-hangar-trial/stage1-pr5"
# 写しの状態の印で、実物の会話を止めないため（ParkWatch の claude stop）。要約と会話の起動は動かない。
export HANGAR_CLAUDE_BIN=/usr/bin/false
cd "$1"
exec npm run hangar -- start --port 4178 --no-open
```

worktree の根で、背面で起こす（`run_in_background`）。

```bash
sh "$TRIAL/start.sh" "$PWD" > "$TRIAL/server.log" 2>&1
```

起こしたプロセスの PID を控える（止めるときに自分の PID だけを止めるため）。

```bash
lsof -nP -iTCP:4178 -sTCP:LISTEN
```

Expected: LISTEN しているのは今起こした node だけで、4177 は本物のアプリのまま。

- [ ] **Step 9: ふだんの姿を確かめる**

```bash
curl -s -H "authorization: Bearer $(cat "$TRIAL/token")" http://127.0.0.1:4178/api/sync/status
```

Expected: `state` が `idle`（送受信の最中なら `pushing` か `pulling`）、`limitedUntil` が null、`pausedReason` と `quotaPausedDay` の項目が無い。

```bash
curl -s -H "authorization: Bearer $(cat "$TRIAL/token")" http://127.0.0.1:4178/api/sync/usage
```

Expected: `source` が `unknown`、`today.d1RowsWritten` が null、`limits` に `stopRatio` が無い（手元の Worker には使用量のトークンが無い）。

`server.log` の最初の `?t=` の付いた URL を WebKit で開き、ヘッダーと設定の「使用量と費用」を撮って、自分の目で見る（Task 1 で選んだ案のとおりか）。

- [ ] **Step 10: 上限で退くことを確かめる（D1 の形）**

```bash
printf 'd1-write\n' > "$TRIAL/limit"
```

40 秒待ってから（定期実行は 30 秒ごと）、状態を見る。

```bash
curl -s -H "authorization: Bearer $(cat "$TRIAL/token")" http://127.0.0.1:4178/api/sync/status
```

Expected: `state` が `paused`、`limitedUntil` が次の UTC の 0 時、`error` が null。

ヘッダーと設定を撮る。
ヘッダーは「無料枠で停止 · X に戻る」（X は UTC の 0 時を端末の時刻にしたもの）、トーストが 1 度だけ出て、設定の帯は上限で止まった文である。

中継の記録で、退いた後に要求が出ていないことを見る。

```bash
tail -5 "$TRIAL/proxy.log"
```

Expected: 退いた時刻より後に、`/health` 以外の行が増えない（2 分待って見直す）。

試しのサーバを止めて起こし直し（Step 8 の PID だけを止め、同じ台本で起こす）、起こし直した後も要求が出ず、状態が `paused` と同じ `limitedUntil` のままであることを見る。

画面の「今すぐ同期」を 1 回押し、中継の記録に要求が 1 巡だけ増え、また退いて、トーストがもう 1 度出ることを見る。

- [ ] **Step 11: 上限で退くことを確かめる（1027 の形）**

```bash
printf 'requests\n' > "$TRIAL/limit"
```

画面の「今すぐ同期」を 1 回押し、状態が `paused` のまま `limitedUntil` が次の UTC の 0 時であることと、`error` が「Worker が古い」などの版の文になっていないことを見る。

- [ ] **Step 12: 日が変われば自分で戻ることを確かめる**

UTC の 0 時の前に、上限を外す。

```bash
rm "$TRIAL/limit"
```

外しただけでは戻らない（戻る時刻まで外へ出ない）ことを、0 時の前に 1 度見る。
UTC の 0 時を過ぎて 1 分たってから、状態を見る。

```bash
curl -s -H "authorization: Bearer $(cat "$TRIAL/token")" http://127.0.0.1:4178/api/sync/status
```

Expected: `state` が `idle`、`limitedUntil` が null、`pending` が 0（退いている間に溜まった変更が送られた）。
中継の記録に、0 時を過ぎた後の要求が並ぶ。

- [ ] **Step 13: 1 日回して確かめる**

起こしたまま、Step 8 から 24 時間以上置く。
朝と夕方と、終わりの 3 回、次を見る。

```bash
grep -n -e "\[sync\]" -e "\[pull\]" -e "\[upload\]" -e "\[files\]" -e Error "$TRIAL/server.log" | tail -50
```

```bash
lsof -nP -iTCP:4177 -sTCP:LISTEN
```

Expected: 上限を外している間は、同期の状態に `error` が出続けていない。
4177 は本物のアプリのまま動いている。

- [ ] **Step 14: 片付ける**

Step 8 で控えた PID の試しのサーバだけを止める（ポートの番号だけを頼りに止めない）。

```bash
kill <試しのサーバの PID>
```

中継と `wrangler dev` を止める（それぞれの `run_in_background` の task を止める）。

```bash
rm -rf "$HOME/.agent-hangar-trial/stage1-pr5"
```

- [ ] **Step 15: 実物のクラウドで確かめるかを聞く**

上限で退く処理は、実物では起こさない（spec の範囲の外）。
実物で確かめられるのは「見張りを消しても、ふだんの同期が動く」ことで、入れ替えた後の本物のアプリで、利用者が自分で一時停止を解くか「今すぐ同期」を押したときに初めて確かめられる。

利用者がこちらに確かめを頼むかどうかを、AskUserQuestion で聞く。
聞くときは、本物のアプリの「今すぐ同期」を 1 回押した場合に使う無料枠の見積もりを添える。
見積もりは、本物の DB の未送信の数と、同期の状態の「未送信の本文」の数から出す（どちらも読むだけである）。

```bash
sqlite3 "$HOME/.agent-hangar/hangar.db" "select count(*) from changes where pushed_at is null;"
```

未送信のメタデータを N 行、未送信の本文を M 件とすると、1 回の「今すぐ同期」はおよそ次を使う。

- Workers の要求：N / 40 を切り上げた回数 + M + 5 回（1 日の枠は 10 万回）。
- D1 の書き込み：5N + 10M + 20 行（1 日の枠は 10 万行）。
- R2 の書く操作：M 回（月の込み量は 100 万回）。

推す答えは「頼まない（入れ替えた後、利用者が自分で同期を戻したときに確かめる）」である。
頼まれなければ、報告に「実物では未確認」と書く。

- [ ] **Step 16: 報告する**

報告には、試した日時の幅（UTC の 0 時をまたいだ時刻を含む）、Step 4 と Step 9 から Step 13 の結果、見つけた問題、実物のクラウドで確かめたかどうかを書く。
実際の行数と件数は返事にだけ書き、リポジトリの文書には書かない。
1 日の試しで問題が無ければ、CI が緑の PR をマージし、CLAUDE.local.md の 6 以降（アプリの入れ替え）へ進む。

---

## 自己点検の記録

- spec の「消すもの」の 3 項目めのうち端末の分（`sync/quota.ts`、`server.ts` の `D1_WRITES_*` と `countingClient`、`d1RowsToday` を読むこと、台数割り、`pausedReason` と `quotaPausedDay`）は、Task 6 と Task 7 で尽くした。
  Worker の `meter.ts`、`meteredBatch`、`meteredRun` は、spec の PR の表が PR 6 に置くので触らない。
- 「上限による失敗で退く」の 4 つの箇条は、サーバの側を Task 2 から Task 7 で尽くした。
  Worker が 429 を返すこと（1 つめの箇条）は PR 6 である。
  画面の文は spec のとおり「無料枠で停止 · X に戻る」を使う（Task 7）。
- 「残す境界」の `deviceCount` は Task 6 で説明を直して残し、使用量の表示は Task 5 で「数は不明」に替えて残した。
  設定の同期は、`configSyncActive`、`SyncStatusDto.claudeConfig`、puller の config の経路を残し、コメントだけを上限で退く形に合わせた（Task 6）。
- 「後始末」の端末の分は Task 8（版 16）で尽くした。
  spec に無い足し算は、見張りが止めた一時停止を解くこと（Task 8）、CLI の `hangar cloud status` に戻る時刻を添えること（Task 7）、設定の同期が上限の失敗でその回を打ち切り、ファイルごとに知らせないこと（Task 4）である。
- 2026-10-09 に、全体計画の D6 の取り消しに合わせて書き直した。
  PR 4 が設定の同期を消さず、マイグレーションも足さなくなったので、この PR の版を 17 から 16 に下げ、コードと固定値を設定の同期が残る形（`claudeConfig` と `configEntries` がある）に直し、1 日の試しでは写した設定の `syncClaudeConfig` を切るようにした。
- 「終わりの条件」の「上限の失敗（D1 のメッセージ、429、`1027` を含む JSON でない応答）を受けたサーバが、次の UTC の 0 時まで退き、日が変わると戻ることを試験で確かめている」は、Task 2（判定）、Task 3（client）、Task 6（エンジンと立て直し）の試験で留めた。
- `git grep -n "古いサーバは送らない"` の 2 件のうち、`packages/shared/src/api.ts` の 1 件は Task 7 で消える。
  `docs/superpowers/plans/2026-10-02-cloud-usage.md` の 1 件は過去の計画なので書き換えない。
