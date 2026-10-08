# 段 1 PR 4 Claude Code の設定の同期を端末から消す Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code の設定の同期（D6）を、サーバ、画面、CLI、共有の型から消し、古い端末が R2 に残した設定の行を puller と teardown が読み飛ばすようにし、端末に残った名残をマイグレーションで 1 回だけ消す。

**Architecture:** 機能は足さない。
まず消した後も読み続けるもの（puller と teardown の読み飛ばし、控えの世代数と `backups/claude-config/` の刈り込み）を試験で留め、次に画面、サーバ、共有の型の順に外し、最後に端末の後始末のマイグレーションを当てる。
申し送りの 2 つ（`setup cloud` と `join` は DB を先に開く、古い版の DB を作る試験の補助を 1 つに寄せる）も、このブランチで入れる。
Worker（`packages/cloud`）と、Worker が使う共有の型（`FileKind` と `KeyPrefix` の `config`、`splitFileKey`）には触らない。

**Tech Stack:** TypeScript、React、Hono、better-sqlite3、vitest（`expectTypeOf` を含む）。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md`（「消すもの」の 2 項目め、「残す境界」、「後始末」、PR の表の 4 の行）。
段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md` の D6、D8、D10 と「段階的に入れるときの約束」。

## 着手の条件

- 段 0 の DB の自動控え（`packages/server/src/db/backup.ts` と、当てる前に控えを取る `openDb`）は main `33ca14e` に入っている。
  着手のときも `git grep -n "export function backupDb" -- packages/server/src/db/backup.ts` が 1 行を返すことを確かめ、返さなければ着手しない。
- 段 1 の PR 1、2、3 は main に入っている（`33ca14e` で確かめた）。
- マイグレーションの版は、この計画を書いた時点の main で 15 が最後である。
  この PR は次の 16 を使い、PR 5 がその次の 17 を使う。
  着手のときに `git grep -n "version: " -- packages/server/src/db/migrations.ts` の最後の行で数え直し、15 でなければ、この計画の 16 をすべて「最後の版 + 1」に読み替える。

## Global Constraints

- PR 4 の中身は「設定の同期を端末の側から消す。読み飛ばしの分岐と、端末の後始末を入れる」で、入れる条件は「段 0 の DB の自動控えが入っている。写しの DB で 1 日使ってから入れる」である（spec の PR の表）。
- CI が緑になっても、Task 12 の 1 日の試しが終わるまでマージしない。
  CLAUDE.local.md の「CI が緑なら聞かずにマージ」より、spec の入れる条件を先に守る。
- 各 PR は、それ単独でアプリが動く状態で入れる。
- 永続する識別子（DB の表名と列名、同期で運ぶ payload、DTO と API の鍵）は改名しない（D8）。
  消すのは spec が名指ししたものだけである。
- 残す境界：`PausedPass`、`deviceCount`、`CloudUsagePoller` と使用量の表示、`BACKUP_GENERATIONS` と `backups/claude-config/`、パスの検査（`isSafeRelPath`、`MAX_REL_PATH_CHARS`、`encodeHeaderText`）、`sessions.provider` と `files.kind`、`sync/apply.ts` の `tableColumns`、`cloud.json` の床の保険。
- Worker が使う共有の型（`FileKind` の `'config'`、`KeyPrefix` の `'config'`、`splitFileKey`、`isValidFileKey`）は残す。
  狭めると、次に配備した Worker が受け付けるものが変わるので、Worker の側を消す PR 6 で狭める。
- 偽のクラウド（`packages/server/test/fake-cloud.ts`）の `config` の受け入れは、Worker の写しなので残す（PR 6 で Worker と一緒に消す）。
- 消す前に、消すものごとに `git grep` をもう一度回し、使っているのが消す範囲の中だけであることを確かめる（spec の決まり）。
  外で使われていたら、消さずに止めて報告する。
- 画面の見た目が変わる所（Task 7）は、Task 1 の試作で利用者が選ぶまで実装しない。
  ほかのタスクは、選ぶのを待たずに進めてよい。
- Worker を配備しない。
  実物のクラウドに触る確かめは、利用者に聞いてから、使う無料枠の見積もりを添えて行う（Task 12）。
  行わなかったときは、報告に「実物では未確認」と書く。
- 4177 のサーバ、`/Applications/Hangar.app`、実物の `~/.agent-hangar` には、Task 12 で DB と設定を読んで写す以外に触らない。
  `tmux kill-server` は呼ばない。
- 行番号は main `33ca14e` で数えた。
  前のタスクで行がずれるので、行番号は目安とし、引用した文で当てる。
- 作業は main から切った新しい worktree で行い、着手の前に `npm ci` を打つ。
- コマンドはリポジトリの根で 1 本ずつ打つ（git と他のコマンドを `&&` でつながない）。
- 試験は `npx vitest run <ファイルかディレクトリ>`、型は `npm run typecheck`（1 つの包みだけなら `npm run typecheck -w packages/<名前>`）。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける（`git commit -m "<件名>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`）。
- 文書（`docs/design.md`、`README.md`）とコードのコメントは日本語の一文一行で書き、中黒と em ダッシュを使わない。
- 公開リポジトリなので、実在の人名、メール、手元のパス、使用量、Worker の URL、実際のスキル名を、コード、試験、文書、試作、コミットに書かない。

## Review Focus

- **古い端末が上げた設定の行が R2 に残ったまま、他端末の本文と並んで届く**：設定の行は降ろさずに読み飛ばし、`filesSeq` はその行を越えて進み、隣の本文は降りる（Task 4 の試験で留める）。
- **teardown で、R2 に設定の行がある**：設定の行は降ろさないが、R2 からは消すので、バケットが空になって消せる（Task 5 の試験で留める）。
- **`settings.json` に `syncClaudeConfig: true` が残っている端末**：読むときに落ち、次の保存でファイルからも消え、古い画面がその鍵だけを送ってきても 400 で断る（Task 8 の試験で留める）。
- **`skipped:(config)` の控えが残った端末（古い版のサーバが後から書き直した場合を含む）**：画面の「送れなかった本文」に出ず、次の取り込みで消える（Task 4 の試験と Task 9 のマイグレーションの試験で留める）。
- **DB の控えが取れない端末で `setup cloud` か `join` を打つ**：Cloudflare に何も作らず、参加の要求も出さず、`cloud.json` も書かずに止まる（Task 3 の試験で留める）。

---

### Task 1: 試作で、設定の画面から設定の同期を外した姿を選んでもらう

**Files:**
- Create: `docs/superpowers/specs/2026-10-08-stage1-config-sync-removal/settings.html`

**Interfaces:**
- Consumes: なし。
- Produces: 利用者が選んだ案（A か B）。
  Task 7 がこれを読む。

この PR で画面から消えるのは 3 か所である。
設定の「クラウド同期」の節の下にある「Claude Code の設定を同期する」の印、対象と控えの置き場の説明、確認の状態、「取り込み内容を確認」のボタン（押すと開くダイアログも消える）。
設定の「会話の保持」の節の注記の後半「値は設定の同期で他の PC にも届きます。」。
保持期間の確認のダイアログの「他の PC」の行。

- [ ] **Step 1: 試作を作る**

ブラウザで開ける 1 枚の HTML にする。
部品と CSS の変数は、既存の試作 `docs/superpowers/specs/2026-10-02-cloud-usage/usage-merged.html` を写す。
ライトだけにする（ダークは作らない。利用者の決定）。

並べるものは次の 3 列である。

| 列 | 中身 |
| --- | --- |
| いま | 今の画面のとおり。印は切った状態、確認のボタンは押せない状態 |
| 案 A（推す） | 3 か所を消すだけ。クラウド同期の節は、端末の一覧で終わる。保持の注記は「変えるときは、差分を確かめてから書き込みます。」だけになる。ダイアログの「他の PC」の行は無い |
| 案 B | 案 A に、クラウド同期の節の最後の 1 行「Claude Code の設定の同期は、この版でなくなりました。~/.claude を PC の間で揃えるときは、git などを使ってください。」を足す |

それぞれの列に、設定の「クラウド同期」の節の下半分（状態の行、ボタンの段、端末の一覧から下）と、「会話の保持」の節の注記と、保持期間の確認のダイアログの説明の並び（`dt` と `dd`）を描く。
端末の名前は `mac` と `mini`、Worker の URL は `https://example.workers.dev` にする（実物の値を入れない）。

- [ ] **Step 2: 利用者に選んでもらう**

試作をブラウザで開き、AskUserQuestion で 1 問だけ聞く。
問いは「設定の同期を消した後の設定の画面をどうしますか」で、選択肢は「案 A：消すだけ（推奨）」「案 B：なくなったことを 1 行で知らせる」の順に置く。
選ぶまで Task 7 には入らない。

- [ ] **Step 3: 選んだ案を書き残してコミットする**

この計画の Task 7 の冒頭の「選んだ案：」の行に、選ばれた案を書き足す。

```bash
git add docs/superpowers/specs/2026-10-08-stage1-config-sync-removal/settings.html docs/superpowers/plans/2026-10-08-stage1-pr4-config-sync-device.md
```

```bash
git commit -m "docs: add the settings prototype for removing Claude Code config sync" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 古い版の DB を作る試験の補助を 1 つに寄せる

**Files:**
- Create: `packages/server/test/oldDb.ts`
- Create: `packages/server/test/oldDb.test.ts`
- Modify: `packages/server/src/db/db.test.ts:11-22`（`openDbAt` と `LATEST`）
- Modify: `packages/server/src/db/backup.test.ts:11`、`:19-34`（`LATEST`、`seedAt`、`versionOf`）
- Modify: `packages/server/src/indexer/indexFile.test.ts:34-44`（`seedOldDb`）
- Modify: `packages/server/src/server.test.ts`（段 0 で足した「DB の控えが取れなければ、マイグレーションを当てずに起動を止める」）
- Modify: `packages/cli/src/index.test.ts`（段 0 で足した「DB の控えが取れないときは、子のサーバの理由を出して止まり、マイグレーションを当てない」）

**Interfaces:**
- Consumes: `MIGRATIONS`（`packages/server/src/db/migrations.ts`）、`type Db`（`packages/server/src/db/open.ts`）。
- Produces（`packages/server/test/oldDb.ts`）：
  - `LATEST_DB_VERSION: number`（`MIGRATIONS` の最後の版）
  - `seedDbAt(file: string, version: number, seed?: (db: Db) => void): void`
  - `dbVersionOf(file: string): number`

main `33ca14e` には、「version 以下のマイグレーションだけを当てた実物のファイルを作る」同じ数行が 5 か所にある。
`db.test.ts` の `openDbAt`、`backup.test.ts` の `seedAt`、`indexFile.test.ts` の `seedOldDb`、`server.test.ts` と `cli/src/index.test.ts` の中に直に書いた繰り返しである。
この PR の Task 9（版 16 の試験）と PR 5 の版 17 の試験もこれを使うので、先に 1 つに寄せる。

- [ ] **Step 1: 依存を入れる**

worktree に `node_modules` が無ければ、リポジトリの根で打つ。

```bash
npm ci
```

- [ ] **Step 2: 5 か所を数え直す**

Run: `git grep -n "create table if not exists schema_migrations" -- 'packages/*.test.ts'`
Expected: `cli/src/index.test.ts`、`server/src/db/backup.test.ts`、`server/src/db/db.test.ts`、`server/src/indexer/indexFile.test.ts`、`server/src/server.test.ts` の 5 行。
5 行でなければ、増えた所も Step 6 で同じように置き換える。

- [ ] **Step 3: 補助の試験を書く**

`packages/server/test/oldDb.test.ts` を作る。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { dbVersionOf, LATEST_DB_VERSION, seedDbAt } from './oldDb.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-olddb-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('古い版の DB を作る補助', () => {
  it('最新の版はマイグレーションの一覧の最後の版である', () => {
    expect(LATEST_DB_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });

  it('指定した版までだけを当て、閉じる前に仕込みを流す', () => {
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 9, (db) => {
      db.prepare("insert into projects (id, name, status, is_scratch, updated_at, origin_device) values ('p1', 'a', 'active', 0, 1, 'd')").run();
    });
    expect(dbVersionOf(file)).toBe(9);
    const db = new Database(file, { readonly: true });
    try {
      // 版 10 で足す列は、まだ無い。
      const cols = (db.prepare('pragma table_info(todos)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain('candidate_at');
      expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 4: 落ちるのを見る**

Run: `npx vitest run packages/server/test/oldDb.test.ts`
Expected: FAIL（`./oldDb.ts` が無いので読み込めない）。

- [ ] **Step 5: 補助を書く**

`packages/server/test/oldDb.ts` を作る。

```ts
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { Db } from '../src/db/open.ts';

/** いちばん新しいマイグレーションの版。 */
export const LATEST_DB_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * version 以下のマイグレーションだけを当てた実物のファイルの DB を作る。既存の DB からの移行を試すため。
 * openDb を通さないので、段 0 の控えも取らない。
 * seed を渡すと、閉じる前にその DB で中身を仕込む。
 */
export function seedDbAt(file: string, version: number, seed?: (db: Db) => void): void {
  const db = new Database(file);
  try {
    db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
    for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
      db.exec(m.sql);
      db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, 1);
    }
    seed?.(db);
  } finally {
    db.close();
  }
}

/** そのファイルが当てた最後の版。 */
export function dbVersionOf(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('select max(version) v from schema_migrations').get() as { v: number }).v;
  } finally {
    db.close();
  }
}
```

Run: `npx vitest run packages/server/test/oldDb.test.ts`
Expected: PASS。

- [ ] **Step 6: 5 か所を置き換える**

`packages/server/src/db/db.test.ts` の `function openDbAt(…) { … }`（11-20 行）と `const LATEST = …;`（22 行）を消し、import の並びに次の 1 行を足す。

```ts
import { LATEST_DB_VERSION as LATEST, seedDbAt } from '../../test/oldDb.ts';
```

同じファイルの `openDbAt(` を、すべて `seedDbAt(` にする。
`import { MIGRATIONS } from './migrations.ts';` は、ほかで使っていなければ消す（`git grep -n MIGRATIONS -- packages/server/src/db/db.test.ts` で確かめる）。

`packages/server/src/db/backup.test.ts` の `const LATEST = …;`、`function seedAt(…) { … }`、`function versionOf(…) { … }` を消し、import の並びに次の 1 行を足す。

```ts
import { dbVersionOf as versionOf, LATEST_DB_VERSION as LATEST, seedDbAt as seedAt } from '../../test/oldDb.ts';
```

`MIGRATIONS` と `Database` の import は、ほかで使っていなければ消す。

`packages/server/src/indexer/indexFile.test.ts` の `function seedOldDb(…) { … }` を消し、import の並びに `import { seedDbAt as seedOldDb } from '../../test/oldDb.ts';` を足す。
`MIGRATIONS` と `Database` の import は、ほかで使っていなければ消す。

`packages/server/src/server.test.ts` の「DB の控えが取れなければ、マイグレーションを当てずに起動を止める」の中で、`const latest = …;` から `seed.close();` までと、末尾の `const check = new Database(file, { readonly: true });` から `} finally { check.close(); }` までを、次にする。

```ts
    // 1 つ前の版までの DB を置き、控えの置き場（backups/db）を通常のファイルにして作れなくする。
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION - 1);
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    await expect(startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') })).rejects.toBeInstanceOf(DbBackupError);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);
```

同じファイルの import に `import { dbVersionOf, LATEST_DB_VERSION, seedDbAt } from '../test/oldDb.ts';` を足し、使わなくなった `Database` と `MIGRATIONS` の import を消す。

`packages/cli/src/index.test.ts` の同じ形の試験も、`const latest = …;` から `seed.close();` までを `seedDbAt(file, LATEST_DB_VERSION - 1);`（`file` の宣言は残す）に、末尾の `const check = …` から `finally { check.close(); }` までを `expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);` にする。
import は `import { dbVersionOf, LATEST_DB_VERSION, seedDbAt } from '../../server/test/oldDb.ts';` を足し、`Database` と `MIGRATIONS` を消す。

- [ ] **Step 7: 通るのを見る**

Run: `git grep -n "create table if not exists schema_migrations" -- 'packages/*.test.ts'`
Expected: 何も出ない（`packages/server/test/oldDb.ts` と `db/open.ts` は試験のファイルではないので出ない）。

Run: `npx vitest run packages/server/test/oldDb.test.ts packages/server/src/db packages/server/src/indexer/indexFile.test.ts packages/server/src/server.test.ts packages/cli/src/index.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 8: コミットする**

```bash
git add packages/server/test/oldDb.ts packages/server/test/oldDb.test.ts packages/server/src/db/db.test.ts packages/server/src/db/backup.test.ts packages/server/src/indexer/indexFile.test.ts packages/server/src/server.test.ts packages/cli/src/index.test.ts
```

```bash
git commit -m "test: share one helper that builds an old-version DB" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `setup cloud` と `join` は、DB を処理の先頭で開く

**Files:**
- Modify: `packages/server/src/sync/transcriptsFrom.ts:53-62`（`stampTranscriptsFrom`）
- Modify: `packages/server/src/cliEntry.ts:17`
- Modify: `packages/cli/src/cloud.ts:9`（import）、`:388-479`（`runSetupCloud`）、`:622-677`（`runJoin`）
- Test: `packages/server/src/sync/transcriptsFrom.test.ts`
- Test: `packages/cli/src/cloud.test.ts`

**Interfaces:**
- Consumes: Task 2 の `seedDbAt`、`dbVersionOf`、`LATEST_DB_VERSION`。
  段 0 の `DbBackupError`（文に「マイグレーションを当てずに止めました」を含む）。
- Produces：
  - `openTranscriptsFloor(home: string): { stamp(now: number): number; close(): void }`（`transcriptsFrom.ts`、`cliEntry.ts` から輸出）
  - `stampTranscriptsFrom(home, now)` は残し、中で `openTranscriptsFloor` を使う。

`runSetupCloud` は、Worker を配備し、参加し、`cloud.json` を書いた後で、`stampTranscriptsFrom` を通して初めて DB を開く。
段 0 から、DB を開くと、当てていないマイグレーションがあれば先に控えを取り、取れなければ投げる。
今のままだと、控えが取れない端末では、Cloudflare に資源を作り、参加し、`cloud.json` を書いた後で止まり、参加トークンも出ない。
`runJoin` も、参加の要求と `cloud.json` の後で止まる。
DB を開くのを処理の先頭へ移し、開いた口を最後に床を刻むまで持つ。

- [ ] **Step 1: 試験を書く**

`packages/server/src/sync/transcriptsFrom.test.ts` の import の `stampTranscriptsFrom` の隣に `openTranscriptsFloor` を足し、末尾に足す。

```ts
describe('openTranscriptsFloor', () => {
  it('先に開いておき、後から刻める。既に床があれば動かさない', () => {
    const home = tempHome();
    const floor = openTranscriptsFloor(home);
    try {
      // 開いた時点で DB はできていて、マイグレーションも当たっている。
      expect(fs.existsSync(path.join(home, 'hangar.db'))).toBe(true);
      expect(floor.stamp(JOINED)).toBe(JOINED);
      expect(floor.stamp(JOINED + 1)).toBe(JOINED);
    } finally {
      floor.close();
    }
    expect(readTranscriptsFrom(home)).toBe(JOINED);
  });
});
```

`packages/cli/src/cloud.test.ts` の import に `import { dbVersionOf, LATEST_DB_VERSION, seedDbAt } from '../../server/test/oldDb.ts';` を足し、`describe('runJoin', …)` の前に足す。

```ts
describe('DB の控えが取れないとき', () => {
  /** 1 つ前の版の DB を置き、控えの置き場（backups/db）を通常のファイルにして作れなくする。 */
  const blockBackup = (home: string): string => {
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION - 1);
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    return file;
  };

  it('setup cloud は Cloudflare に何も作らず、cloud.json も書かずに止まる', async () => {
    const { home, cloudDir } = dirs();
    const file = blockBackup(home);
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const ff = fakeFetch(0);
    await expect(
      runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} }),
    ).rejects.toThrow('マイグレーションを当てずに止めました');
    expect(w.calls).toEqual([]);
    expect(w.interactiveCalls).toEqual([]);
    expect(ff.urls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);
  });

  it('join は参加の要求を出さず、cloud.json も書かずに止まる', async () => {
    const { home } = dirs();
    const file = blockBackup(home);
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('{}', { status: 500 }); }) as typeof fetch;
    await expect(
      runJoin({ home, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' }), device, fetch: f, sleep: async () => {}, force: true, log: () => {} }),
    ).rejects.toThrow('マイグレーションを当てずに止めました');
    expect(urls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);
  });

  it('控えが取れれば、setup cloud は先に DB を上げて控え、最後に床を刻む', async () => {
    const { home, cloudDir } = dirs();
    seedDbAt(path.join(home, 'hangar.db'), LATEST_DB_VERSION - 1);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('Deployed hangar\n  https://hangar.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok('Success'),
    });
    await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch(0).fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(fs.readdirSync(path.join(home, 'backups', 'db'))).toHaveLength(1);
    expect(dbVersionOf(path.join(home, 'hangar.db'))).toBe(LATEST_DB_VERSION);
    expect(readTranscriptsFrom(home)).toBeGreaterThan(0);
  });
});
```

`'d1 info hangar --json'` の応答（`ok(JSON.stringify({ uuid: DB_ID }))`）は、同じファイルの既存の試験と同じ形である。

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/transcriptsFrom.test.ts packages/cli/src/cloud.test.ts -t "openTranscriptsFloor|DB の控えが取れないとき"`
Expected: FAIL。
`openTranscriptsFloor` が無く、`setup cloud` の試験は `w.calls` に `whoami` が残り、`join` の試験は `urls` に `/join` が残る。

- [ ] **Step 3: 床の DB を先に開く口を作る**

`packages/server/src/sync/transcriptsFrom.ts` の `stampTranscriptsFrom`（53-62 行）を次にする（上のコメントはそのまま）。

```ts
export function stampTranscriptsFrom(home: string, now: number): number {
  const floor = openTranscriptsFloor(home);
  try {
    return floor.stamp(now);
  } finally {
    floor.close();
  }
}

/**
 * 床を刻むための DB を、先に開いておく。
 *
 * setup cloud と join は、Worker の配備や参加の要求の後で床を刻む。
 * そこで初めて DB を開くと、マイグレーションの前の控え（db/backup.ts）が取れないときに、
 * Cloudflare に資源を作り、参加し、cloud.json を書いた後で止まり、参加トークンも出ない。
 * 処理の先頭でこれを呼べば、控えとマイグレーションは外に何も作らないうちに済む（取れなければここで投げる）。
 * 刻むのは stamp、閉じるのは close で、呼び手は finally で閉じる。
 */
export function openTranscriptsFloor(home: string): { stamp(now: number): number; close(): void } {
  const db = openDb(dbPath(home));
  const state = new SyncStateStore(db);
  return {
    stamp: (now) => {
      markTranscriptsFrom(state, now);
      return transcriptsFrom(state);
    },
    close: () => db.close(),
  };
}
```

`packages/server/src/cliEntry.ts` の 17 行目を次にする。

```ts
export { backfillTranscripts, openTranscriptsFloor, readTranscriptsFrom, stampTranscriptsFrom } from './sync/transcriptsFrom.ts';
```

同じファイルの 14 行目から 16 行目のコメントの「刻むのは CLI の hangar setup cloud と hangar join（cloud.json を書くのと同じ時点）である。」の後ろに、次の 1 行を足す。

```ts
// setup cloud と join は、外に何かを作る前に openTranscriptsFloor で DB を開いておく（控えが取れなければそこで止まる）。
```

- [ ] **Step 4: `runSetupCloud` で先に開く**

`packages/cli/src/cloud.ts` の 9 行目の import の `stampTranscriptsFrom` を `openTranscriptsFloor` に替える（ほかで `stampTranscriptsFrom` を使っていないことを `git grep -n stampTranscriptsFrom -- packages/cli/src/cloud.ts` で確かめる）。

`runSetupCloud` の `const secret = prev && !o.rotateSecret ? prev.joinSecret : randomBytes(32).toString('base64url');` の次に足す。

```ts
  // DB を先に開く。マイグレーションの前の控え（db/backup.ts）が取れなければ、ここで投げて止まる。
  // Cloudflare にはまだ何も作っていないので、直してからもう一度実行すればよい。
  // 後ろで開くと、Worker を配備して参加し cloud.json を書いた後で止まり、参加トークンも出ない。
  const floor = openTranscriptsFloor(o.home);
  try {
```

その下の `// 1. アカウント` の行から `return { url, joinToken };` の行までを、字下げを 1 段下げて `try` の中に入れ、`return { url, joinToken };` の次に次を置いて閉じる。

```ts
  } finally {
    floor.close();
  }
```

中の `stampTranscriptsFrom(o.home, conf.joinedAt);` を次にする（上の 2 行のコメントは残す）。

```ts
    floor.stamp(conf.joinedAt);
```

字下げのほかは、中身を変えない。

- [ ] **Step 5: `runJoin` で先に開く**

`runJoin` の `if (!o.force) { … }` の閉じ括弧の次から関数の終わりまで（`// retryForbidden は渡さない。` から `return conf;` まで）を次にする。

```ts
  // DB を先に開く（setup cloud と同じ理由である）。控えが取れなければ、参加の要求を出す前に止まる。
  const floor = openTranscriptsFloor(o.home);
  try {
    // retryForbidden は渡さない。貼り間違えたトークンで 30 秒待たせない。
    const joined = await joinWorker(url, t.secret, o.device, { fetch: o.fetch ?? realFetch, sleep: o.sleep ?? realSleep, log });
    const conf: CloudConfig = {
      url,
      joinSecret: t.secret,
      deviceToken: joined.deviceToken,
      workerName: null,
      accountId: null,
      dbName: null,
      bucketName: null,
      joinedAt: Date.now(),
    };
    saveCloudConfig(o.home, conf);
    // 本文をどこから上げるかの床を、設定を書くのと同じ時点で刻む（setup cloud と同じ理由である）。
    // 既に床があれば動かさないので、参加し直しても最初の参加の時刻のままである。
    floor.stamp(conf.joinedAt);
    log('');
    log(`参加しました: ${url}`);
    log('hangar を再起動すると同期が始まり、他の端末の本文が ~/.agent-hangar/remote に降りてきます。');
    return conf;
  } finally {
    floor.close();
  }
}
```

- [ ] **Step 6: 通るのを見る**

Run: `npx vitest run packages/server/src/sync/transcriptsFrom.test.ts packages/cli/src/cloud.test.ts`
Expected: PASS（既存の `runSetupCloud` と `runJoin` の試験も通る）。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 7: 文書を直す**

`docs/design.md` の、段 0 で足した `backups/db/` の箇条（「DB を開く側（サーバと、DB を開く CLI）は、…」で始まる行の段）の末尾に、次の 2 行を足す。

```
`hangar setup cloud` と `hangar join` は、Cloudflare に資源を作る前と参加の要求を出す前に DB を開き、床を刻むまで閉じない（`openTranscriptsFloor`）。
控えが取れなければ、外に何も作らず、`cloud.json` も書かずに止まる。
```

- [ ] **Step 8: コミットする**

```bash
git add packages/server/src/sync/transcriptsFrom.ts packages/server/src/sync/transcriptsFrom.test.ts packages/server/src/cliEntry.ts packages/cli/src/cloud.ts packages/cli/src/cloud.test.ts docs/design.md
```

```bash
git commit -m "fix(cli): open the DB before setup cloud and join touch the cloud" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: puller は本文でない行を読み飛ばす

**Files:**
- Modify: `packages/server/src/sync/puller.ts:12-22`、`:37-38`、`:106-111`、`:121`、`:193-197`、`:222-305`
- Modify: `packages/server/src/server.ts:16`、`:516-524`（`onConfigEntries` の結線）
- Test: `packages/server/src/sync/puller.test.ts`

**Interfaces:**
- Consumes: なし。
- Produces：
  - `PullerDeps` から `onConfigEntries` が消える。
  - `RemotePuller.pullNow(): Promise<{ downloaded: number }>`（`configEntries` が消える）。
  - `skippedEntries()` は本文の控えだけを返す。

spec の「残す境界」のとおり、古い端末が上げた設定の行は R2 と Worker の `files` に残っている。
分岐ごと消すと、設定の行が本文の検査（`checkKeyMatchesPath`）で投げ、3 回数えて控えに残り、画面の「送れなかった本文」に居座る。
`kind` が `transcript` でない行は、降ろさずに読み飛ばす。
`sync_state` の `skipped:(config)` の控えも、試し直さずに消し、画面に出さない。
古い版のサーバが同じ DB で後から書き直しても、ここで消える。

- [ ] **Step 1: 消す前に数え直す**

Run: `git grep -n -e onConfigEntries -e CONFIG_BATCH -e configEntries -- packages`
Expected: `server/src/sync/puller.ts`、`server/src/sync/puller.test.ts`、`server/src/server.ts` の 519 行だけ。

- [ ] **Step 2: 試験を書く**

`packages/server/src/sync/puller.test.ts` の `it('自端末の分は降ろさず、設定は呼び出し側に渡す', …)` を次に置き換える。

```ts
  it('自端末の分と、本文でない行（古い端末が上げた設定）は降ろさずに先へ進む', async () => {
    await putRemote('dev-a', `projects/-w-alpha/${UUID}.jsonl`, 'mine\n');
    await putRemote('dev-b', 'CLAUDE.md', '# hi\n', 'config/dev-b/CLAUDE.md', 'config');
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    expect(await p.pullNow()).toEqual({ downloaded: 1 });
    // 設定の行を越えて進む。止まると、その後ろの本文が一生降りてこない。
    expect(state.getNumber('filesSeq', 0)).toBe(3);
    expect(errors).toEqual([]);
    expect(p.skippedEntries()).toEqual([]);
    expect(cloud.calls.filter((c) => c.method === 'getFile').map((c) => c.args[0])).toEqual([`transcripts/dev-b/${UUID}.jsonl.gz`]);
    expect(db.prepare("select count(*) c from file_sync where kind = 'config'").get()).toEqual({ c: 0 });
    expect(fs.existsSync(path.join(home, 'remote', 'dev-a'))).toBe(false);
  });
```

`it('設定の取り込みが失敗した回は filesSeq を進めない', …)` と `it('設定の取り込みも 3 回で諦めて先に進む', …)` を消す（取り込む口が無くなるので、確かめる相手が無い）。

`it('諦めた設定も起こし直せば渡し直す', …)` を次に置き換える。

```ts
  it('設定の同期の頃に諦めた (config) の控えは、試し直さずに消し、画面にも出さない', async () => {
    const entry: FileEntry = { key: 'config/dev-b/CLAUDE.md', path: 'CLAUDE.md', kind: 'config', sha256: 'x', size: 1, mtime: 1, encrypted: true, seq: 1, deviceId: 'dev-b', uploadedAt: 1, storedSize: 1 };
    state.set('skipped:(config)', JSON.stringify({ entries: [entry], fingerprint: '1', count: 3, message: '書けません', at: 1 }));
    const p = make();
    expect(p.skippedEntries()).toEqual([]);
    expect(await p.pullNow()).toEqual({ downloaded: 0 });
    expect(state.get('skipped:(config)')).toBeNull();
    expect(cloud.calls.some((c) => c.method === 'getFile')).toBe(false);
    expect(errors).toEqual([]);
  });
```

同じファイルの残りの `toEqual({ downloaded: N, configEntries: 0 })` を、すべて `toEqual({ downloaded: N })` にする。

```bash
sed -i '' 's/, configEntries: 0 })/ })/g' packages/server/src/sync/puller.test.ts
```

Run: `git grep -n configEntries -- packages/server/src/sync/puller.test.ts`
Expected: 何も出ない。

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/puller.test.ts`
Expected: FAIL。
返り値に `configEntries` が残っているので `toEqual({ downloaded: N })` が落ち、`(config)` の控えは `skippedEntries()` に出る。

- [ ] **Step 4: puller から設定の経路を外す**

`packages/server/src/sync/puller.ts` を次のように直す。

`PullerDeps` から `onConfigEntries?: (entries: FileEntry[]) => Promise<void>;` の行を消す。

`/** 設定の取り込みの失敗を数えるときの鍵。…*/` と `const CONFIG_BATCH = '(config)';`（37-38 行）を消す。

`SkipRecord` の `entries` のコメント（54 行）を `/** 降ろし直すのに要る項目そのもの。本文 1 件である。 */` にする。

`parseSkip` の下に足す。

```ts
/**
 * 本文 1 件の控えか。
 * 設定の同期（段 1 で消した）は、取り込みに失敗した設定の束を (config) の鍵で同じ形に残していた。
 * 本文でない控えは試し直さず、画面にも出さない（RemotePuller の allSkips で消す）。
 */
const isTranscriptSkip = (rec: SkipRecord): boolean => rec.entries.length === 1 && rec.entries[0]!.kind === 'transcript';
```

クラスの説明（106-110 行）を次にする。

```ts
/**
 * 他端末が上げた本文を降ろして手元に展開する。
 * 本文でない行（古い端末が上げた Claude Code の設定、kind が config）は読み飛ばす。設定の同期は段 1 で消した。
 * 書き込む先は ~/.agent-hangar/remote の下だけで、~/.claude には一切触らない。
 */
```

121 行のコメント「uploader と claudeConfig と同じ作法で 1 本に並べる。」を「uploader と同じ作法で 1 本に並べる。」にする。

`allSkips()` を次にする。

```ts
  /** 本文の控えを全部読む。壊れた行は飛ばし、本文でない控え（設定の同期の頃の (config) など）は消す。 */
  private allSkips(): { key: string; rec: SkipRecord }[] {
    const rows = this.deps.db.prepare('select key, value from sync_state where key like ? order by key').all(`${SKIP_PREFIX}%`) as { key: string; value: string }[];
    const out: { key: string; rec: SkipRecord }[] = [];
    for (const r of rows) {
      const rec = parseSkip(r.value);
      if (!rec) continue;
      const key = r.key.slice(SKIP_PREFIX.length);
      if (!isTranscriptSkip(rec)) { this.clearSkip(key); continue; }
      out.push({ key, rec });
    }
    return out;
  }
```

`retrySkipped()` を次にする。

```ts
  private async retrySkipped(): Promise<number> {
    let downloaded = 0;
    for (const { key, rec } of this.allSkips()) {
      // まだ諦めていないものは filesSeq が手前で止まっているので、通常の経路で取り直される。
      if (rec.count < MAX_ATTEMPTS) continue;
      try {
        if (await this.download(rec.entries[0]!)) downloaded++;
        this.clearSkip(key);
      } catch (err) {
        this.writeSkip(key, { ...rec, count: rec.count + 1, message: errorMessage(err), at: this.now() });
      }
    }
    return downloaded;
  }
```

`pullNow()` と `pullNowInner()` を次にする。

```ts
  async pullNow(): Promise<{ downloaded: number }> {
    return this.enqueue(() => (this.stopped ? Promise.resolve({ downloaded: 0 }) : this.pullNowInner()));
  }

  private async pullNowInner(): Promise<{ downloaded: number }> {
    let downloaded = 0;
    const startedAt = this.now();
    // 諦めた項目を取り戻す機会。起こし直した直後（lastRetryAt が無い）と、間隔が空いたときに試す。
    if (this.lastRetryAt === null || startedAt - this.lastRetryAt >= RETRY_SKIPPED_AFTER_MS) {
      this.lastRetryAt = startedAt;
      downloaded += await this.retrySkipped();
    }
    let since = this.deps.state.getNumber('filesSeq', 0);
    let advanceTo = since;
    let minFailed: number | null = null;
    for (;;) {
      const page = await this.deps.client.listFiles(since, PULL_LIMIT);
      for (const e of page.files) {
        if (e.deviceId === this.deps.deviceId) continue;
        // 本文でない行（古い端末が上げた設定）は降ろさない。
        // 分岐ごと消すと本文の検査で投げ、失敗を数えて控えに居座る。
        if (e.kind !== 'transcript') continue;
        try {
          if (await this.download(e)) { downloaded++; this.clearSkip(e.key); }
        } catch (err) {
          // 版が合わずに断られたのは、この項目のせいではない。諦めに数えずに回ごと止め、filesSeq も進めない。
          if (err instanceof CompatError) throw err;
          if (this.noteFailure(e.key, [e], e.sha256, errorMessage(err))) minFailed = minFailed === null ? e.seq : Math.min(minFailed, e.seq);
        }
      }
      // その回の出発点より下がらないようにする。
      // 壊れた応答（手前を指す nextSeq）で filesSeq を巻き戻すと、降ろし済みの項目を延々と読み直す。
      // 呼び手が意図して filesSeq を 0 に戻す道（全件の取り直し）は、出発点そのものが 0 なので邪魔しない。
      advanceTo = Math.max(advanceTo, page.nextSeq);
      // 進まない応答で回り続けない。
      if (!page.more || page.nextSeq <= since) break;
      since = page.nextSeq;
    }
    // 失敗した項目より手前で止めて、次の pull で取り直す。
    this.deps.state.set('filesSeq', minFailed !== null ? minFailed - 1 : advanceTo);
    return { downloaded };
  }
```

`import { PULL_LIMIT, type FileEntry } from '@agent-hangar/shared';` の `FileEntry` は `SkipRecord` と `noteFailure` がまだ使うので残す。

- [ ] **Step 5: サーバの結線を外す**

`packages/server/src/server.ts` の `new RemotePuller({ … })` の中の `onConfigEntries: async (entries: FileEntry[]) => { await configSync?.applyPull(entries); },` の行を消す。
16 行目の import から `type FileEntry, ` を消す（`git grep -n "FileEntry" -- packages/server/src/server.ts` で、ほかで使っていないことを確かめる）。

- [ ] **Step 6: 通るのを見る**

Run: `npx vitest run packages/server/src/sync/puller.test.ts packages/server/src/server.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 7: コミットする**

```bash
git add packages/server/src/sync/puller.ts packages/server/src/sync/puller.test.ts packages/server/src/server.ts
```

```bash
git commit -m "feat(server): skip non-transcript file rows when pulling" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: teardown は本文でない行を降ろさず、R2 からは消す

**Files:**
- Modify: `packages/cli/src/cloud.ts:12`（import）、`:768-773`（`CONFIG_DIR`）、`:807-821`（`rescueTargetPath`）、`:866-898`（`rescueRemoteBodies`）、`:940-942`（`runTeardown` の知らせ）
- Test: `packages/cli/src/cloud.test.ts:890-900`、`:1008-1021`、`describe('runTeardown')` の末尾

**Interfaces:**
- Consumes: なし。
- Produces: `rescueTargetPath` は本文の形だけを受け、設定の行には「食い違っています」で投げる。
  `rescueRemoteBodies` は本文でない行を数えずに飛ばす。
  `runTeardown` は、本文でない行も R2 から消す（`for (const e of entries)` の削除の並びはそのまま）。

teardown は R2 のオブジェクトを全部消してからバケットを消す。
設定の行を一覧から外すと、オブジェクトが残ってバケットが「空でない」で消せなくなる。
だから外すのは「手元へ降ろす」の側だけで、消す側には残す。

- [ ] **Step 1: 消す前に数え直す**

Run: `git grep -n -e CONFIG_DIR -e configKey -e "kind === 'config'" -- packages/cli`
Expected: `cli/src/cloud.ts` の `CONFIG_DIR` の定義と `rescueTargetPath` の中、`cloud.test.ts` の設定の退避先の試験だけ。

Run: `git grep -n -e isSafeKeyId -e isSafeRelPath -- packages/cli/src/cloud.ts`
Expected: import の行と `rescueTargetPath` の設定の分岐だけ。

- [ ] **Step 2: 試験を書く**

`packages/cli/src/cloud.test.ts` の `it('鍵と相対パスが食い違う本文は、手元に置く先を決めない', …)` の中の設定の 2 行（`kind: 'config', key: 'config/dev-b/CLAUDE.md', path: '../CLAUDE.md'` の行と、`kind: 'config'` で `startsWith(path.join(home, 'remote'))` を見る行）を消し、最後に次を足す。

```ts
    // 設定の行（段 1 で消した設定の同期の分）は、手元に置く先を持たない。
    expect(() => rescueTargetPath(home, { ...base, kind: 'config', key: 'config/dev-b/CLAUDE.md', path: 'CLAUDE.md' })).toThrow(/食い違/);
```

`describe('設定の退避先', …)` を丸ごと消す。

`describe('runTeardown', …)` の最後の `it` の後に足す。

```ts
  it('本文でない行（古い版の設定の同期が上げたもの）は降ろさず、R2 からは消してバケットを空にする', async () => {
    const { home, cloudDir } = dirs();
    const secret = 'join-secret-0000';
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    saveCloudConfig(home, conf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    const theirs = await fileFixture({ secret, deviceId: 'dev-b', uuid: 'u-theirs', text: '{"theirs":1}\n', seq: 1 });
    const config = { entry: { ...theirs.entry, key: 'config/dev-b/CLAUDE.md', path: 'CLAUDE.md', kind: 'config' as const, seq: 2 }, body: Buffer.from('opaque') };
    const cf = cloudFetch([theirs, config], { token: 'dt' });
    const w = fakeWrangler({ 'r2 object delete': () => ok(), 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const lines: string[] = [];
    const done = await runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cf.fetch, confirm: fakeConfirm([true, true]).fn, log: (l) => lines.push(l) });
    expect(done).toBe(true);
    // 本文は降ろし、設定の行は取りに行かない。
    expect(cf.paths).toContain('/files/transcripts/dev-b/u-theirs.jsonl.gz');
    expect(cf.paths).not.toContain('/files/config/dev-b/CLAUDE.md');
    expect(fs.existsSync(path.join(home, 'remote', 'dev-b', '_config'))).toBe(false);
    // 消す側には残る。残さないとバケットが空にならない。
    const cfg = path.join(home, 'cloud', 'wrangler.jsonc');
    expect(w.calls.map((x) => x.args.join(' '))).toContain(`r2 object delete hangar-dev-files/config/dev-b/CLAUDE.md --remote --config ${cfg}`);
    const out = lines.join('\n');
    expect(out).toContain('R2 には本文が 1 件あります');
    expect(out).toContain('本文でないファイル 1 件');
  });
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/cli/src/cloud.test.ts -t "runTeardown|食い違う"`
Expected: FAIL。
設定の行は `_config` の下へ降ろそうとして復号で失敗し、teardown が止まる。
`rescueTargetPath` の設定の分岐はまだ置く先を返す。

- [ ] **Step 4: 降ろす側から設定を外す**

`packages/cli/src/cloud.ts` の `CONFIG_DIR` の定義（768-773 行、`/** 設定ファイルの写しを置く入れ物の名前。…*/` から `const CONFIG_DIR = '_config';` まで）を消す。

`rescueTargetPath` を次にする（上のコメントの 1 行目「R2 の 1 件を手元のどこへ置くか。」は「R2 の本文 1 件を手元のどこへ置くか。」にする）。

```ts
export function rescueTargetPath(home: string, e: FileEntry): string {
  const parts = path.posix.normalize(e.path).split('/');
  const suffix = parts.slice(2).join('/');
  if (e.kind !== 'transcript' || parts[0] !== 'projects' || parts.length < 3 || suffix === '' || e.key !== `transcripts/${e.deviceId}/${suffix}.gz`) {
    throw new Error(`本文の鍵と相対パスが食い違っています: ${e.key}`);
  }
  return remoteTranscriptPath(home, e.deviceId, e.path);
}
```

`rescueRemoteBodies` の `for (const e of o.entries) {` の次に足す。

```ts
    // 本文でない行（古い版の設定の同期が上げた Claude Code の設定）は降ろさない。設定の同期は段 1 で消した。
    // R2 から消す並び（runTeardown の entries）には残るので、バケットは空になる。
    if (e.kind !== 'transcript') continue;
```

`runTeardown` の `log(\`R2 には本文が ${entries.length} 件あります。手元に写しの無いものを先に降ろします。\`);` を次にする。

```ts
  const bodies = entries.filter((e) => e.kind === 'transcript').length;
  log(`R2 には本文が ${bodies} 件あります。手元に写しの無いものを先に降ろします。`);
  if (bodies < entries.length) log(`本文でないファイル ${entries.length - bodies} 件（古い版の設定の同期が上げたもの）は、降ろさずに消します。`);
```

12 行目の import から `configKey, `、`isSafeKeyId, `、`isSafeRelPath, ` を消す（Step 1 で、ほかで使っていないことを確かめてある）。

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/cli/src/cloud.test.ts`
Expected: PASS。

Run: `npm run typecheck -w packages/cli`
Expected: PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/cli/src/cloud.ts packages/cli/src/cloud.test.ts
```

```bash
git commit -m "feat(cli): teardown deletes old config objects without rescuing them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 控えの世代数と `backups/claude-config/` の刈り込みを、設定の同期から移す

**Files:**
- Modify: `packages/server/src/config/cloud.ts:28`（`backupsRoot` の下に定数を足す）
- Modify: `packages/server/src/config/retention.ts:138`、`:178-194`（`backupSettings`）、`:200-220`（`writeRetention`）
- Modify: `packages/server/src/server.ts:46`（import）
- Test: `packages/server/src/config/retention.test.ts`
- Test: `packages/server/src/server.test.ts:27`（import）

**Interfaces:**
- Consumes: なし。
- Produces：
  - `BACKUP_GENERATIONS = 20`（`packages/server/src/config/cloud.ts`）
  - `pruneSettingsBackups(home: string, keep?: number): number`（`packages/server/src/config/retention.ts`）

`BACKUP_GENERATIONS` は今 `sync/claudeConfig.ts` にあり、本文とメモの控えの刈り込み（`server.ts`）が借りている。
`backups/claude-config/<yyyyMMdd-HHmmss>/` を 20 世代に刈っているのも、`claudeConfig.ts` の取り込みの中（`pruneBackups`）だけである。
保持期間の書き込み（`retention.ts`）は同じ置き場に控えを書くが、刈っていない。
`claudeConfig.ts` を消す前に、定数を `backupsRoot` の隣へ移し、刈り込みを保持期間の書き込みへ移す。
こうすれば design.md の「3 種類とも 20 世代」が消した後も成り立つ。

- [ ] **Step 1: 試験を書く**

`packages/server/src/config/retention.test.ts` の import の `writeRetention` の隣に `pruneSettingsBackups` を足し、`it('同じ秒に 2 度書いても、先の控えを潰さない', …)` の後に足す。

```ts
  it('書いた後に backups/claude-config を新しい方から 20 世代に刈り、形の違う名前には触れない', () => {
    settings(SRC);
    const root = path.join(home(), 'backups', 'claude-config');
    for (let d = 1; d <= 22; d++) fs.mkdirSync(path.join(root, `202609${String(d).padStart(2, '0')}-000000`), { recursive: true });
    fs.mkdirSync(path.join(root, 'mine'));
    writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC), now: new Date(2026, 9, 1, 12, 0, 0) });
    const left = fs.readdirSync(root).sort();
    // いま取った控えと、新しい方の 19 世代と、形の違う名前が残る。
    expect(left).toHaveLength(21);
    expect(left).toContain('20261001-120000');
    expect(left).toContain('mine');
    expect(left).not.toContain('20260901-000000');
    expect(left).not.toContain('20260903-000000');
    expect(left).toContain('20260904-000000');
  });

  it('刈り込みは置き場が無くても、リンクでも、何もしない', () => {
    expect(pruneSettingsBackups(home())).toBe(0);
    const real = path.join(root, 'elsewhere');
    for (let d = 1; d <= 22; d++) fs.mkdirSync(path.join(real, `202609${String(d).padStart(2, '0')}-000000`), { recursive: true });
    fs.mkdirSync(path.join(home(), 'backups'), { recursive: true });
    fs.symlinkSync(real, path.join(home(), 'backups', 'claude-config'));
    expect(pruneSettingsBackups(home())).toBe(0);
    expect(fs.readdirSync(real)).toHaveLength(22);
  });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/config/retention.test.ts`
Expected: FAIL（`pruneSettingsBackups` が無い。書いた後も 23 世代が残る）。

- [ ] **Step 3: 定数を移す**

`packages/server/src/config/cloud.ts` の `export function backupsRoot(…)`（28 行）の次に足す。

```ts
/**
 * 控えを残す世代の数。新しい方から数えてこれだけ残し、古いものを消す。
 * 本文（backups/transcripts）とメモ（backups/memos）と、保持期間の書き込み（backups/claude-config）の控えが使う。
 * 設定の同期（段 1 で消した）が持っていた値を、置き場の隣へ移した。
 */
export const BACKUP_GENERATIONS = 20;
```

`packages/server/src/server.ts` の 46 行目 `import { BACKUP_GENERATIONS, ClaudeConfigSync } from './sync/claudeConfig.ts';` を `import { ClaudeConfigSync } from './sync/claudeConfig.ts';` にし、8 行目の import を次にする。

```ts
import { BACKUP_GENERATIONS, backupsRoot, readCloudConfig, remoteRoot } from './config/cloud.ts';
```

`packages/server/src/server.test.ts` の 27 行目 `import { BACKUP_GENERATIONS } from './sync/claudeConfig.ts';` を `import { BACKUP_GENERATIONS } from './config/cloud.ts';` にする。

`packages/server/src/sync/claudeConfig.ts` の `export const BACKUP_GENERATIONS = 20;` は、このタスクでは `import { BACKUP_GENERATIONS } from '../config/cloud.ts';` に替える（Task 8 でファイルごと消す）。

- [ ] **Step 4: 刈り込みを保持期間の書き込みへ移す**

`packages/server/src/config/retention.ts` の import に `BACKUP_GENERATIONS` を足す（`backupsRoot` と同じ `./cloud.ts` から取る）。

`const BACKUP_SUBDIR = 'claude-config';`（138 行）の次に足す。

```ts
/** 控えの世代のディレクトリの名前（timestampLabel と同じ yyyyMMdd-HHmmss の形）。 */
const STAMP_RE = /^\d{8}-\d{6}$/;

/**
 * backups/claude-config の控えを、新しい方から keep 世代に保つ。消した数を返す。
 * 名前が yyyyMMdd-HHmmss なので、辞書順に並べれば古い順になる。
 * いま取った控えは最も新しいので消えない。形の違う名前とリンクには触れない。
 * 置き場そのものがリンクなら何もしない（刈る先がリンクの先に出てしまう。server.ts の pruneBackupFiles と同じ決まり）。
 * 消せなかったものは次の書き込みに回す（控えはもう取れている）。
 */
export function pruneSettingsBackups(home: string, keep: number = BACKUP_GENERATIONS): number {
  const root = path.join(backupsRoot(home), BACKUP_SUBDIR);
  const st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return 0;
  const names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && STAMP_RE.test(e.name)).map((e) => e.name);
  const limit = Math.max(1, keep);
  if (names.length <= limit) return 0;
  let removed = 0;
  for (const n of names.sort().slice(0, names.length - limit)) {
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); removed++; } catch { /* 上のとおり */ }
  }
  return removed;
}
```

`writeRetention` の `writeFileAtomically(file, after, mode);` の次に足す。

```ts
    // 書けた後で刈る。刈るのは控えを取った後だけなので、「控えが取れなければ書かない」には触らない。
    if (backup) {
      try { pruneSettingsBackups(o.home); } catch (e) { console.error('[backups]', e instanceof Error ? e.message : e); }
    }
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/server/src/config/retention.test.ts packages/server/src/server.test.ts`
Expected: PASS。

Run: `npm run typecheck -w packages/server`
Expected: PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/server/src/config/cloud.ts packages/server/src/config/retention.ts packages/server/src/config/retention.test.ts packages/server/src/server.ts packages/server/src/server.test.ts packages/server/src/sync/claudeConfig.ts
```

```bash
git commit -m "refactor(server): move backup generations next to the backups root and prune claude-config on retention writes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 画面から設定の同期を外す

選んだ案：（Task 1 の Step 3 で書き足す）

**Files:**
- Delete: `packages/ui/src/views/ConfigPreviewDialog.tsx`
- Modify: `packages/ui/src/views/SettingsScreen.tsx:454-461`、`:512`
- Modify: `packages/ui/src/views/RetentionDialog.tsx:44`
- Modify: `packages/ui/src/Root.tsx:29`、`:368`
- Modify: `packages/ui/src/presenters/settings.ts:19`、`:36`、`:91`、`:114-115`
- Modify: `packages/ui/src/presenters/retentionDialog.ts:7`、`:43`
- Modify: `packages/ui/src/mediator/sync.ts:16`、`:30-31`
- Modify: `packages/ui/src/mediator/types.ts:125`、`:164`
- Modify: `packages/ui/src/mediator/overlay.ts:6`（コメント）
- Modify: `packages/ui/src/runtime/api.ts:1`、`:95-96`、`:196-197`
- Modify: `packages/ui/src/runtime/runtime.ts:16`、`:538-539`
- Modify: `packages/ui/src/store/store.ts:2`、`:26`、`:29`、`:50`、`:395`
- Modify: `packages/ui/src/test/fakeApi.ts:10`、`:80-81`
- Modify: `packages/shared/src/intent.ts:86`
- Test: `packages/shared/src/api.test.ts:70-73`
- Test: `packages/ui/src/views/misc.test.tsx`、`views/dialogs.test.tsx`、`Root.test.tsx`、`runtime/runtime.test.ts`、`runtime/api.test.ts`、`store/store.test.ts`、`mediator/transition.test.ts`、`presenters/presenters.test.ts`

**Interfaces:**
- Consumes: Task 1 で選んだ案。
- Produces：
  - Intent の `sync.config.preview` と `sync.config.apply`、Effect の `api.configPreview` と `api.configPull`、Overlay の `configPreview`、`ApiClient.configPreview` と `configPull`、`Store.configPreview` と `applyConfigPreview` が消える。
  - `CloudSettingsProps` から `syncClaudeConfig` と `configConfirmed`、`RetentionSettingsProps` から `syncNote`、`RetentionDialogProps` から `otherPcs` が消える。
  - 共有の `SettingsDto.syncClaudeConfig`、`SyncStatusDto.claudeConfig`、`ConfigPreviewDto` は、このタスクでは残す（画面が読まなくなるだけで、Task 8 で消す）。

- [ ] **Step 1: 消す前に数え直す**

Run: `git grep -n -e ConfigPreview -e configPreview -e configPull -e "sync\.config" -e otherPcs -e syncNote -e configConfirmed -- packages/ui packages/shared/src/intent.ts`
Expected: 上の Files の行と、試験の行だけ。
`syncClaudeConfig` は、このタスクでは画面の props と presenter の行だけを消す（DTO の固定値は Task 8）。

- [ ] **Step 2: 試験を書く**

`packages/shared/src/api.test.ts` の `it('この PC で再開と設定の同期の Intent がある', …)` を次に置き換える。

```ts
  it('この PC で再開の Intent があり、設定の同期の Intent は無い', () => {
    const is: Intent[] = [{ type: 'session.resumeHere', id: 's1' }, { type: 'session.resumeHere', id: 's1', overwrite: true }, { type: 'sync.joinToken.show' }];
    expect(is).toHaveLength(3);
    expectTypeOf<Extract<Intent, { type: 'sync.config.preview' | 'sync.config.apply' }>>().toBeNever();
  });
```

`packages/ui/src/views/misc.test.tsx` の `describe('SettingsScreen のクラウド同期', …)` の最初の `it('Settings のクラウド同期の節', …)` を次に置き換える。

```ts
  it('Settings のクラウド同期の節（設定の同期の印と下見のボタンは無い）', () => {
    const onIntent = vi.fn();
    const cloud = cloudProps();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud })} /></IntentRoot>);
    expect(screen.getByText('https://h.workers.dev')).toBeInTheDocument();
    expect(screen.getByText('未送信 2 件')).toBeInTheDocument();
    expect(screen.getByText('mini')).toBeInTheDocument();
    // 同期している PC の一覧で、自分の PC に印を付ける。
    expect(screen.getByText('この PC', { selector: '.list .faint' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Claude Code の設定を同期する')).toBeNull();
    expect(screen.queryByRole('button', { name: '取り込み内容を確認' })).toBeNull();
    expect(screen.queryByText(/backups\/claude-config/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '参加トークンを表示' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'sync.joinToken.show' });
    rerender(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ cloud: cloudProps({ joinToken: 'tok-abc' }) })} /></IntentRoot>);
    expect(screen.getByText('tok-abc')).toBeInTheDocument();
    expect(screen.getByText(/持つ人は全セッションを読み書きできます/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '参加トークン をコピー' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'tok-abc' });
  });
```

同じファイルの `it('設定の同期を切っているあいだは取り込みの確認を押せない', …)` と `it('取り込みの対象と控えの置き場と、確認がまだであることを書く', …)` を消す。

`packages/ui/src/views/dialogs.test.tsx` の保持期間のダイアログの試験に、次の断言を足す（`base` で描いた直後）。

```ts
    // 設定の同期は段 1 で消したので、他の PC へ届くという行は無い。
    expect(screen.queryByText('他の PC')).toBeNull();
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/views/misc.test.tsx packages/ui/src/views/dialogs.test.tsx -t "クラウド同期の節|保持期間"`
Expected: FAIL（印と下見のボタンと「他の PC」の行がまだある）。

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`toBeNever()` の行で型エラーになる）。

- [ ] **Step 4: 画面と部品から外す**

`packages/ui/src/views/SettingsScreen.tsx` の 454 行から 461 行（`<div className="settings-row settings-switch-row"><span>Claude Code の設定を同期する</span>` から `取り込み内容を確認</button>` まで）を消す。
選んだ案が B なら、消した場所に次の 1 行を置く。

```tsx
                  <div className="faint" style={{ marginTop: 8 }}>Claude Code の設定の同期は、この版でなくなりました。~/.claude を PC の間で揃えるときは、git などを使ってください。</div>
```

同じファイルの 512 行を次にする。

```tsx
                <div className="faint" style={{ marginTop: 4 }}>変えるときは、差分を確かめてから書き込みます。</div>
```

`packages/ui/src/views/RetentionDialog.tsx` の 44 行（`{props.otherPcs && <><dt>他の PC</dt>…</>}`）を消す。

`packages/ui/src/views/ConfigPreviewDialog.tsx` を消す。

```bash
git rm packages/ui/src/views/ConfigPreviewDialog.tsx
```

`packages/ui/src/Root.tsx` の 29 行の import と、368 行の `{overlay.kind === 'configPreview' && <ConfigPreviewDialog preview={store.configPreview} />}` を消す。

`packages/ui/src/presenters/settings.ts` を直す。
19 行の `CloudSettingsProps` から `syncClaudeConfig: boolean; configConfirmed: boolean; ` を消す。
36 行の `RetentionSettingsProps` から `; syncNote: boolean` を消す。
`retentionSettings` の `syncNote: store.settings?.syncClaudeConfig ?? false,` を消す。
`presentSettings` の `syncClaudeConfig: s?.syncClaudeConfig ?? false,` と `configConfirmed: sync?.claudeConfig.confirmed ?? false,` を消す。

`packages/ui/src/presenters/retentionDialog.ts` の `RetentionDialogProps` から `otherPcs: boolean; ` を消し、`otherPcs: store.settings?.syncClaudeConfig ?? false,` を消す。

`packages/ui/src/mediator/sync.ts` の 30 行と 31 行（`case 'sync.config.preview'` と `case 'sync.config.apply'`）を消し、16 行のコメントを `/** sync 領域：同期の状態表示と、今すぐ同期、一時停止。 */` にする。

`packages/ui/src/mediator/types.ts` の 125 行を `  | { kind: 'api.joinToken' }` にし、164 行の `  | { kind: 'configPreview' }` を消す。

`packages/ui/src/mediator/overlay.ts` の 6 行のコメントの「、設定の取り込み」を消す。

`packages/ui/src/runtime/api.ts` の import から `ConfigPreviewDto, ` を消し、95 行と 96 行（`configPreview(): …;` と `configPull(): …;`）と、196 行と 197 行（`configPreview: () => call(…)` と `configPull: () => post(…)`）を消す。

`packages/ui/src/runtime/runtime.ts` の 16 行の import から `applyConfigPreview, ` を消し、538 行と 539 行（`case 'api.configPreview'` と `case 'api.configPull'`）を消す。

`packages/ui/src/store/store.ts` の import から `ConfigPreviewDto, ` を消し、26 行のコメントを `  // joinToken は押したときだけ取りに行く値なので、未取得は null である。` にし、29 行の `; configPreview: ConfigPreviewDto | null` を消し、50 行の初期値の `, configPreview: null` を消し、395 行の `applyConfigPreview` を消す。

`packages/ui/src/test/fakeApi.ts` の 10 行の `| 'configPreview' | 'configPull'` を消し、80 行と 81 行の 2 つの `vi.fn` を消す。

`packages/shared/src/intent.ts` の 86 行の `  | { type: 'sync.config.preview' } | { type: 'sync.config.apply' }` を消す。

- [ ] **Step 5: 試験の残りを直す**

Run: `git grep -n -e ConfigPreview -e configPreview -e configPull -e "sync\.config" -e otherPcs -e syncNote -e configConfirmed -e "取り込み内容を確認" -- packages/ui packages/shared/src`
Expected: 試験の行だけが出る。
出た行を次の表のとおりに直す。

| ファイル | 直し方 |
| --- | --- |
| `ui/src/Root.test.tsx` | 「取り込みの下見は…」の `it` を消す |
| `ui/src/runtime/runtime.test.ts` | 偽の API の `configPreview` と `configPull` を消す。「参加トークンと設定の下見と取り込み」の `it` は、参加トークンの部分だけを残して名前を「参加トークン」にする |
| `ui/src/runtime/api.test.ts` | `configPreview` と `configPull` の呼び出しと経路の断言を消す |
| `ui/src/store/store.test.ts` | import の `applyConfigPreview` を消す。「参加トークンと設定の下見を持つ」の `it` は、参加トークンの部分だけを残して名前を「参加トークンを持つ」にする |
| `ui/src/mediator/transition.test.ts` | `sync.config.preview` と `sync.config.apply` の `it` を消し、オーバーレイの一覧の「設定の取り込み」の項目を消す |
| `ui/src/presenters/presenters.test.ts` | 「Settings のクラウドの節」の `syncClaudeConfig` と `configConfirmed` の断言と、`otherPcs` の断言と `it` を消す |
| `ui/src/views/misc.test.tsx` | `settingsProps` と `cloudProps` の固定値の `syncClaudeConfig: false, configConfirmed: false, ` を消し、`retention` の固定値の `, syncNote: true` を消す |
| `ui/src/views/dialogs.test.tsx` | import の `ConfigPreviewDialog` と `describe('ConfigPreviewDialog', …)` を消し、保持期間の固定値と `rerender` の `otherPcs` を消し、「設定の同期で、次の取り込み時に届きます」の断言を消す |

`SettingsDto` と `SyncStatusDto` の固定値にある `syncClaudeConfig: false` と `claudeConfig: { … }` は、型にまだあるので、このタスクでは残す。

- [ ] **Step 6: 通るのを見る**

Run: `npx vitest run packages/ui packages/shared`
Expected: PASS。

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 7: コミットする**

```bash
git add -A packages/ui packages/shared/src/intent.ts packages/shared/src/api.test.ts
```

```bash
git commit -m "refactor(ui): remove the Claude Code config sync switch and preview dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: サーバと共有の型から設定の同期を外す

**Files:**
- Delete: `packages/server/src/sync/claudeConfig.ts`、`packages/server/src/sync/claudeConfig.test.ts`
- Modify: `packages/server/src/server.ts`（72-78、84、160-169、172、284、298-303、466、496、507-513、532、542、893-899、912-913、945-946、1020、1028-1041、1071、1078-1079 の付近）
- Modify: `packages/server/src/http/app.ts:4`、`:58-62`、`:106-107`、`:222`、`:610-616`、`:672-673`
- Modify: `packages/server/src/config/paths.ts:33-37`、`:98`、`:101-109`
- Modify: `packages/server/src/sync/engine.ts:116`、`:126`、`:155`、`:208`、`:215`
- Modify: `packages/server/src/sync/state.ts:17`
- Modify: `packages/shared/src/api.ts:41`、`:154`、`:181-183`
- Modify: `packages/shared/src/cloud.ts:54-55`（コメント）、`:207-219`（`configKey`）
- Modify: コメントだけ：`server/src/sync/copy.ts`（134、198、237）、`sync/uploader.ts:212`、`sync/pausedPass.ts`（5、16）、`config/retention.ts:131-133`、`config/jsonTextEdit.ts:8`、`server/test/fake-cloud.ts:311`
- Test: `packages/server/src/config/paths.test.ts`、`http/app.test.ts`、`server.test.ts`、`sync/engine.test.ts`、`shared/src/api.test.ts`、`shared/src/cloud.test.ts`、ほかの固定値

**Interfaces:**
- Consumes: Task 4（puller の結線が外れている）、Task 6（`BACKUP_GENERATIONS` が `config/cloud.ts` にある）、Task 7（画面が読まなくなっている）。
- Produces：
  - `Settings` と `SettingsDto` から `syncClaudeConfig` が消える。`loadSettings` は古い鍵を読むときに落とす。
  - `SyncStatusDto` から `claudeConfig` が消える。`SyncEngine.setClaudeConfigStatus` が消える。
  - `ConfigPreviewAction`、`ConfigPreviewEntryDto`、`ConfigPreviewDto`、`ConfigSyncApi`、`AppDeps.configSync`、`configSyncActive`、`CONFIG_PUSH_MS`、`configKey`、`SyncStateKey` の `'configPullConfirmed'` が消える。
  - `GET /api/sync/config/preview` と `POST /api/sync/config/pull` が消える（404 になる）。
  - `PATCH /api/settings` は `syncClaudeConfig` を知らない鍵として扱う（それだけなら「更新できる設定が含まれていません」の 400）。

- [ ] **Step 1: 消す前に数え直す**

Run: `git grep -n -e ClaudeConfigSync -e claudeConfig -e syncClaudeConfig -e configSyncActive -e CONFIG_PUSH_MS -e configPullConfirmed -e ConfigPreview -e ConfigSyncApi -e configKey -- packages ':!packages/cloud'`
Expected: 上の Files と、その試験だけ。
`packages/cloud` に `configKey` の使い手が無いことも `git grep -n configKey -- packages/cloud` で確かめる（出たら `configKey` は消さずに残し、報告する）。

- [ ] **Step 2: 試験を書く**

`packages/server/src/config/paths.test.ts` の `it('古い settings.json に無い項目は既定値で埋める', …)` の期待値から `syncClaudeConfig: false, ` を消し、その後に足す。

```ts
  it('設定の同期（段 1 で消した）の鍵は読むときに落とし、次の保存でファイルからも消える', () => {
    ensureHome(tmp);
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ workspaceRoot: '/w', syncClaudeConfig: true }));
    const s = loadSettings(tmp);
    expect(s).not.toHaveProperty('syncClaudeConfig');
    expect(s.workspaceRoot).toBe('/w');
    saveSettings(tmp, s);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'))).not.toHaveProperty('syncClaudeConfig');
  });
```

`packages/server/src/http/app.test.ts` の `it('Claude Code 設定の同期は、入れて、切って、また入れられる', …)` と `it('真偽値でない syncClaudeConfig は 400 で断る', …)` を次の 1 つに置き換える。

```ts
  it('設定の同期（段 1 で消した）の鍵だけを送ってきた古い画面は、更新できる設定が無いとして断る', async () => {
    const r = await patch({ syncClaudeConfig: true });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('更新できる設定が含まれていません');
    expect((await json(await get('/api/bootstrap'))).body.settings).not.toHaveProperty('syncClaudeConfig');
  });
```

同じファイルの `it('同期が未設定なら設定の経路は 404 で、参加トークンは null', …)` を次にする。

```ts
  it('設定の同期の経路は無く（404）、同期が未設定なら参加トークンは null', async () => {
    app = createApp({ ...deps, joinToken: () => null });
    expect((await get('/api/sync/config/preview')).status).toBe(404);
    expect((await post('/api/sync/config/pull')).status).toBe(404);
    expect((await json(await get('/api/sync/joinToken'))).body).toEqual({ token: null });
  });
```

`packages/shared/src/api.test.ts` の import の後ろに足す（`describe` の外）。

```ts
describe('設定の同期を消した後', () => {
  it('設定と同期の状態に、設定の同期の項目は無い', () => {
    expectTypeOf<SettingsDto>().not.toHaveProperty('syncClaudeConfig');
    expectTypeOf<SyncStatusDto>().not.toHaveProperty('claudeConfig');
  });
});
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/config/paths.test.ts packages/server/src/http/app.test.ts -t "設定の同期"`
Expected: FAIL（鍵が残り、PATCH は 200 を返し、経路は 404 でない）。

Run: `npm run typecheck -w packages/shared`
Expected: FAIL（`not.toHaveProperty` の 2 行）。

- [ ] **Step 4: サーバの結線を外す**

`packages/server/src/server.ts` を次のように直す。

- 46 行の `import { ClaudeConfigSync } from './sync/claudeConfig.ts';` を消す。
- 72 行から 78 行の `CONFIG_PUSH_MS`（コメントを含む）を消す。
- 81 行から 85 行の `UPLOAD_SWEEP_MS` のコメントのうち「設定の定期 push と同じ役目なので、間隔も揃えてある。」の 1 文を消す。
- 160 行から 169 行の `configSyncActive`（コメントを含む）を消す。
- 172 行のコメント「本文と設定の出し入れ、他端末の本文の取り込み、使用量の取りに行きを止めるか。」を「本文の出し入れ、他端末の本文の取り込み、使用量の取りに行きを止めるか。」にする。
- 284 行のコメント「設定の同期（ClaudeConfigSync）とメタデータの同期（SyncEngine）が、どちらもこの形である。」を「メタデータの同期（SyncEngine）と本文の降ろし（RemotePuller）が、この形である。」にする。
- 298 行から 303 行の `pruneBackupFiles` のコメントの「設定の控え（`claudeConfig.ts` の `pruneBackups`）は名前が `yyyyMMdd-HHmmss` のディレクトリなので辞書順がそのまま時刻順になるが、」を「保持期間の書き込みの控え（`retention.ts` の `pruneSettingsBackups`）は名前が `yyyyMMdd-HHmmss` のディレクトリなので辞書順がそのまま時刻順になるが、」にする。
- 466 行のコメント「本文と設定の出し入れはどれもここを見るので、その 1 巡だけ通る。」を「本文の出し入れはどれもここを見るので、その 1 巡だけ通る。」にする。
- 496 行のコメント「本文と設定の出し入れは engine を通らないので、」の「と設定」を消す。
- 507 行から 513 行の `const configSync = client ? new ClaudeConfigSync({ … }) : null;` を消す。
- 532 行のコメントの「他端末の本文と設定の受け取り、設定の押し出し、」を「他端末の本文の受け取り、」にする。
- 542 行の `await passStep('config', async () => { await configSync?.pushChanged(); });` を消す。
- `updateSettings` の `const wasSyncingConfig = settings.syncClaudeConfig;`、それに続く設定の同期のコメント 3 行と `if (wasSyncingConfig && !settings.syncClaudeConfig) configSync?.unconfirm();`、`// Claude Code 設定の同期の入り切りは、ヘッダと Settings の表示に載せる。` と `engine.setClaudeConfigStatus(…);` を消す。
- `createApp` に渡す `configSync: configSync ? { … } : null,` とその上のコメント 1 行を消す。
- 1020 行の `engine.setClaudeConfigStatus(…);` を消す。
- 1028 行の `configSync?.start();` を消す。
- 1030 行から 1041 行（`// 監視だけに頼らず、定期の push も足しておく。` から `configTimer?.unref();` まで）を消す。
- `close` の `if (configTimer) clearInterval(configTimer);` と `await stopAfterIdle(configSync, 'config', left());` を消し、その上のコメント「走っている押し出しを待ってから止める。待たずに止めると putFile と pushChanges が途中で切れる。」は、続く `stopUploader` の上に残す。

`packages/server/src/http/app.ts` を次のように直す。

- 4 行の import から `type ConfigPreviewDto, ` を消す。
- 58 行から 62 行の `ConfigSyncApi`（コメントを含む）を消す。
- 106 行と 107 行の `AppDeps.configSync`（コメントを含む）を消す。
- 222 行の `toSettingsDto` から `syncClaudeConfig: s.syncClaudeConfig, ` を消す。
- 610 行から 616 行（`// Claude Code 設定の同期の入り切り。` から `}` まで）を消す。
- 672 行と 673 行（`api.get('/sync/config/preview', …)` と `api.post('/sync/config/pull', …)`）を消す。

`packages/server/src/config/paths.ts` を次のように直す。

- 33 行から 37 行の `syncClaudeConfig: boolean;`（コメントを含む）を消す。
- 98 行の `defaultSettings` から `syncClaudeConfig: false, ` を消す。
- `loadSettings` を次にする。

```ts
export function loadSettings(home: string): Settings {
  const file = path.join(home, 'settings.json');
  if (!fs.existsSync(file)) return defaultSettings();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings> & { syncClaudeConfig?: unknown };
  // Claude Code の設定の同期（段 1 で消した）の入り切り。古い版が書いた鍵は読むときに落とし、次の保存でファイルからも消える。
  delete raw.syncClaudeConfig;
  const s = { ...defaultSettings(), ...raw };
  // 許しの無い外部の宛先は、読み込みのときに既定へ戻す。
  // 手で書き換えた settings.json や、この制限より前に保存された設定から、会話の本文が外へ出ていかないようにする。
  if (!s.allowExternalSummarizer && !isLoopbackSummarizerUrl(s.lmStudioUrl)) s.lmStudioUrl = defaultSettings().lmStudioUrl;
  return s;
}
```

`packages/server/src/sync/engine.ts` を次のように直す。

- 116 行の `private claudeConfig = { enabled: false, confirmed: false };` を消す。
- 126 行のコメント「（sync/claudeConfig.ts の押し出しが実際にそうなった）」を「（消した設定の同期の押し出しが実際にそうなった）」にする。
- 155 行のコメント「本文と設定の出し入れと使用量も、」を「本文の出し入れと使用量も、」にする。
- `status()` の `claudeConfig: { ...this.claudeConfig },` を消す。
- 215 行の `setClaudeConfigStatus` を消す。

`packages/server/src/sync/state.ts` の 17 行の `  | 'configPullConfirmed'` を消す。

- [ ] **Step 5: 共有の型から外す**

`packages/shared/src/api.ts` の 41 行の `SettingsDto` から `syncClaudeConfig: boolean; ` を消す。
154 行の `SyncStatusDto` から `claudeConfig: { enabled: boolean; confirmed: boolean }; ` を消す。
181 行から 183 行の `ConfigPreviewAction`、`ConfigPreviewEntryDto`、`ConfigPreviewDto` を消す。

`packages/shared/src/cloud.ts` の 54 行のコメント「config の相対パスの文字数の上限。」を「R2 に置くファイルの相対パスの文字数の上限（本文の上げ下ろしと Worker の検査が使う）。」にする。
207 行から 219 行の `configKey`（コメントを含む）を消す（Step 1 で Worker に使い手が無いことを確かめた場合だけ）。

- [ ] **Step 6: ファイルを消す**

```bash
git rm packages/server/src/sync/claudeConfig.ts packages/server/src/sync/claudeConfig.test.ts
```

- [ ] **Step 7: コメントを直す**

次のコメントから、消した設定の同期への言及を直す（中身の決まりは変えない）。

| 場所 | 直し方 |
| --- | --- |
| `server/src/sync/copy.ts` の 134 行 | 「形は claudeConfig.ts の `resolveUnder` と揃えてある（あちらは設定の取り込みの側で同じ穴を塞いだ）。」を消す |
| 同 198 行 | 「この形は claudeConfig.ts の `backupBeforeWrite` と apply.ts の `writeMemoConflictCopy` と揃えてある。」を「この形は apply.ts の `writeMemoConflictCopy` と揃えてある。」にする |
| 同 237 行 | `claudeConfig.ts` を名指しする句を消す |
| `server/src/sync/uploader.ts:212` | 設定の同期を引き合いに出す句を消す |
| `server/src/sync/pausedPass.ts` の 5 行と 16 行 | 「設定の押し出し」「設定の受け取り」を消す |
| `server/src/config/retention.ts:131` | 「他の PC からの同期や手の編集で」を「Claude Code や手の編集で」にする |
| `server/src/config/jsonTextEdit.ts:8` | 設定の同期を引き合いに出す句を消す |
| `server/test/fake-cloud.ts:311` | 「config は誰でも書ける」を「config は自分の接頭辞の下だけに書ける（Worker の写し。段 1 の PR 6 で Worker と一緒に消す）」にする |

Run: `git grep -n -e claudeConfig -e "設定の同期" -- packages ':!packages/cloud'`
Expected: Task 4、5、6、9 で足した「段 1 で消した」の説明と、試験の名前だけ。

- [ ] **Step 8: 試験の残りを直す**

Run: `git grep -n -e syncClaudeConfig -e "claudeConfig: {" -e configSyncActive -e "sync/config/" -e ConfigPreviewDto -e ConfigSyncApi -e fakeConfigSync -e setClaudeConfigStatus -- packages ':!packages/cloud'`
Expected: 試験の行だけが出る。
出た行を次の表のとおりに直す。

| ファイル | 直し方 |
| --- | --- |
| 固定値（`SettingsDto`、`Settings`、`SyncStatusDto`、`SyncStatusBody` を作る行） | `syncClaudeConfig: false, ` と `claudeConfig: { enabled: …, confirmed: … }, ` を消す。`shared/src/api.test.ts`、`server/src/config/readiness.test.ts`、`config/tools.test.ts`、`http/app.test.ts`、`cli/src/cloud.test.ts`、`ui` の固定値がこれにあたる |
| `shared/src/api.test.ts` の「ロック、同期の状態、端末、設定の下見が組み立てられる」 | `preview` と、その断言と、`status.claudeConfig` の断言を消し、名前を「ロック、同期の状態、端末が組み立てられる」にする。import の `ConfigPreviewDto` を消す |
| `shared/src/cloud.test.ts` | import の `configKey` と、`configKey` の断言と「設定の鍵も端末ごとに分ける」の `it` を消す。`isSafeRelPath` の断言と `config/` の鍵の形の試験は残す（`KeyPrefix` に `config` が残るため） |
| `server/src/http/app.test.ts` | import の `ConfigSyncApi`、`fakeConfigSync`、`syncDeps` の `configSync`、認証の一覧の `/api/sync/config/preview`、「参加トークンと端末一覧と設定の下見」の下見の 3 行と `expect(calls)` を消し、名前を「参加トークンと端末一覧」にする。設定の往復の試験の `syncClaudeConfig` を消す |
| `server/src/server.test.ts` | import の `configSyncActive` を消す。起動の試験の `/api/sync/config/preview` と `/pull` の断言は、「設定の同期の経路は無い」として 404 を見るまま残す。「cloud.json があれば部品が組み上がり…」の設定の同期の下見の 3 行を消す。「設定の同期を切って入れ直すと、取り込みの確認をもう一度求める」と「設定の同期は、切っているときと一時停止のあいだは押し出さない」の `it` を消す。「走査の間隔は設定の同期と揃えてある」は名前を「走査の間隔は 60 秒」にし、コメントを消す |
| `server/src/sync/engine.test.ts` | `setClaudeConfigStatus` の `it` を消す |

- [ ] **Step 9: 通るのを見る**

Run: `npm run typecheck`
Expected: PASS。

Run: `npx vitest run packages/shared packages/server packages/cli packages/ui`
Expected: PASS。

- [ ] **Step 10: コミットする**

```bash
git add -A packages
```

```bash
git commit -m "refactor: remove Claude Code config sync from the server and the shared types" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 端末の後始末のマイグレーション（版 16）

**Files:**
- Modify: `packages/server/src/db/migrations.ts`（末尾に 1 つ足す）
- Test: `packages/server/src/db/db.test.ts`

**Interfaces:**
- Consumes: Task 2 の `seedDbAt`。段 0 の控え（`openDb` が当てる前に `backups/db/` へ取る）。
- Produces: 版 16。
  `file_sync` の `kind = 'config'` の行と、`sync_state` の `configPullConfirmed`、`configPending`、`skipped:(config)` の 3 つの鍵を消す。

spec の「後始末」のうち、端末の分である。
設定ファイルの `syncClaudeConfig` の鍵は、Task 8 の `loadSettings` が読むときに落とす。
R2 の `config/` と Worker の `files` の行は、Worker の側（PR 6）で消す。

- [ ] **Step 1: 版を数え直す**

Run: `git grep -n "version: " -- packages/server/src/db/migrations.ts`
Expected: 最後が `version: 15,`。
違えば、このタスクの 16 を「最後の版 + 1」に読み替え、`db.test.ts` の試験の名前と `seedDbAt` に渡す版も合わせる。

- [ ] **Step 2: 試験を書く**

`packages/server/src/db/db.test.ts` の `describe('openDb', …)` の最後に足す。

```ts
  it('version 16 で設定の同期の名残を消し、本文の行とほかの鍵は残す', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mig-'));
    const file = path.join(tmp, 'hangar.db');
    seedDbAt(file, 15, (db) => {
      const row = db.prepare('insert into file_sync (key, kind, path, device_id, sha256, size, mtime, remote_seq, synced_at) values (?,?,?,?,?,?,?,?,?)');
      row.run('config/dev-b/CLAUDE.md', 'config', 'CLAUDE.md', 'dev-b', 'a', 1, 1, 1, 1);
      row.run('transcripts/dev-b/u1.jsonl.gz', 'transcript', 'projects/-w/u1.jsonl', 'dev-b', 'b', 1, 1, 2, 1);
      const st = db.prepare('insert into sync_state (key, value) values (?, ?)');
      for (const [k, v] of [['configPullConfirmed', '1'], ['configPending', '[]'], ['skipped:(config)', '{}'], ['skipped:transcripts/dev-b/u2.jsonl.gz', '{}'], ['filesSeq', '7'], ['paused', '1']] as const) st.run(k, v);
    });
    const db = openDb(file);
    try {
      expect(db.prepare('select key from file_sync order by key').all()).toEqual([{ key: 'transcripts/dev-b/u1.jsonl.gz' }]);
      expect(db.prepare('select key from sync_state order by key').all()).toEqual([{ key: 'filesSeq' }, { key: 'paused' }, { key: 'skipped:transcripts/dev-b/u2.jsonl.gz' }]);
    } finally {
      db.close();
    }
    // 当てる前の DB は段 0 の控えに残っている。
    expect(fs.readdirSync(path.join(tmp, 'backups', 'db'))).toEqual([expect.stringMatching(/^hangar-v15-\d{8}T\d{9}Z\.db$/)]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/db/db.test.ts -t "version 16"`
Expected: FAIL（設定の行と 3 つの鍵が残る。版 15 が最後なので控えも取られない）。

- [ ] **Step 4: マイグレーションを足す**

`packages/server/src/db/migrations.ts` の `MIGRATIONS` の最後（版 15 の後）に足す。

```ts
  {
    // 段 1 で消した Claude Code の設定の同期（D6）が端末に残したものを、1 回だけ消す。
    // file_sync の kind が config の行は、上げた設定と取り込んだ設定の指紋である。本文の行（transcript）には触らない。
    // sync_state の 3 つは、取り込みの確認の印（configPullConfirmed）、まだ取り込んでいない相手の設定の一覧（configPending）、
    // 取り込みに失敗した設定の束の控え（skipped:(config)）である。
    // 控えは画面の「送れなかった本文」に出るので、残すと理由の分からない 1 件が居座る。
    // 古い版のサーバが同じ DB で後から書き直した分は、RemotePuller が読むときに消す（sync/puller.ts の allSkips）。
    // R2 の config/ と Worker の files の行は、Worker の側（段 1 の PR 6）で消す。
    version: 16,
    sql: `
delete from file_sync where kind = 'config';
delete from sync_state where key in ('configPullConfirmed', 'configPending', 'skipped:(config)');
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
git commit -m "feat(server): clean up the leftovers of Claude Code config sync in migration 16" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 設計書と README を直す

**Files:**
- Modify: `docs/design.md`（33-37、182-187、486、1799、1844、2233-2255、2415-2420、2431、2469、2552、2563、2572、2655、2692-2704、2751 の付近）
- Modify: `README.md`（10、183-195、296-303、351-354、361、364 の付近）

**Interfaces:**
- Consumes: Task 3 から Task 9 のすべて。
- Produces: なし。

行番号は main `33ca14e` のもので、前のタスク（Task 3 の Step 7）でずれるので、引用した文で探す。

- [ ] **Step 1: design.md を直す**

| 場所（目安の行と引用） | 直し方 |
| --- | --- |
| 33-37「書く例外は 4 つ」の並び | 設定の取り込み（36 行）を消し、数を 3 つにする。保持期間の行（37 行）の `backups/claude-config/` は残す |
| 187 の Intent の並び | `\| { type: 'sync.config.preview' } \| { type: 'sync.config.apply' }` を消す |
| 486 の `file_sync` の `kind` | `-- 'transcript' \| 'config'` を `-- 'transcript'（段 1 の前は 'config' も書いた。版 16 で消した）` にする |
| 1799 の Settings のクラウドの節 | 「設定を同期する印と取り込む内容の下見」を消す |
| 1844 の待つダイアログの並び | 「設定の取り込み」を消す |
| 2233-2255「同期対象と暗号化」 | 「三つ」を「二つ」にし、**Claude Code のユーザー設定** の箇条と、2247-2255 の設定の同期の段を、次の 3 行に置き換える |
| 2415-2420 の設定の押し出しの段 | 消す |
| 2431 の 1 巡の並び | 「他端末の本文と設定の受け取り、設定の押し出し」を「他端末の本文の受け取り」にする |
| 2469 の互換の版の段 | 「本文と設定の出し入れ」を「本文の出し入れ」にする |
| 2552 のフェーズ 4 の並び | 「Claude Code 設定の同期」の後ろに「（段 1 で消した）」を足す |
| 2563 の保持期間の段 | 設定の同期の取り込みの文を消す |
| 2572 の決めた前提の版の数 | 「版は 15 まで」を「版は 16 まで」にし、括弧の並びの末尾に「、16 で設定の同期の名残（`file_sync` の `config` の行と `sync_state` の 3 つの鍵）を消した」を足す |
| 2655 の `config/<端末 ID>` の決定 | 文頭に「段 1 の前の決定。」を足し、文末に「段 1 で設定の同期を消し、端末は `config/` の行を読み飛ばす。」を足す |
| 2692-2695 の削除の同期、リンク、mtime、Intent の決定 | 設定の同期の決定の 3 行を消し、Intent の並びから `sync.config.*` を消す |
| 2699-2700 の既知の限界 | `config/<端末 ID>/` を消す（R2 の `config/` は PR 6 で掃除が拾う、と 1 行で書く） |
| 2701-2704 の控えの段（「`~/.agent-hangar/backups/` のうち 20 世代で刈るのは 3 種類」から「設定の同期の `*.conflict-*`）は消さない。」まで） | 次の 4 行に置き換える。続く `backups/db/` の段（段 0）はそのまま |
| 2751 の未決事項 | `config/<端末 ID>/` を消す |

2233-2255 の置き換え：

```
Claude Code のユーザー設定（`CLAUDE.md`、`settings.json`、skills、memory）は同期しない（段 1 で消した、D6）。
git や dotfiles など外の仕組みに任せる。
古い版の端末が上げた設定の行は R2 と Worker の `files` に残るが、端末は `kind` が `transcript` でない行を降ろさずに読み飛ばし（`sync/puller.ts`）、teardown も降ろさずに R2 から消す。
```

2701-2704 の置き換え：

```
- `~/.agent-hangar/backups/` のうち 20 世代で刈るのは 3 種類（`claude-config/`、`transcripts/`、`memos/`）で、どれも新しい方から 20 世代（`BACKUP_GENERATIONS`、`config/cloud.ts`）を残す。
  `claude-config/` は保持期間の書き込みの控えで、書けた後に刈る（`pruneSettingsBackups`）。`transcripts/` と `memos/` は控えを取った後とサーバを起こしたときに刈る。
  いま取った控えが最も新しいので、「控えを取れなければ書かない」という決まりには触らない。
  この置き場の外に残る控え（プロジェクトのメモの隣の `memo.md.bak-<日時>` と、段 1 の前の設定の同期が残した `*.conflict-*`）は消さない。
```

- [ ] **Step 2: README を直す**

| 場所 | 直し方 |
| --- | --- |
| 10 行 | 「セッションのメタデータと本文と Claude Code の設定を同期できます」を「セッションのメタデータと本文を同期できます」にする |
| 186-194「ファイルの扱い」 | 例外を 2 つにし、3 番を消し、「2 と 3 は」を「2 は」にし、194 行の「`~/.claude/settings.json` は、設定の同期を入れていない限り書き換えません。」を「`~/.claude/settings.json` は、Settings で会話の保持期間を変えたときの 1 行だけを書き換えます（差分を見せ、控えを取ってから書きます）。」にする |
| 300-303「同期するもの」 | Claude Code のユーザー設定の箇条と、対象と待ち時間の 2 行を消し、「Claude Code の設定（`~/.claude`）は同期しません。PC の間で揃えるときは git などを使ってください。」の 1 行を足す |
| 351-354 の割り切りの 4 | 「控えを取るのは、設定の取り込み（`claude-config/`）、」を「控えを取るのは、会話の保持期間の書き込み（`claude-config/`）、」にし、「`claude-config/` は取り込みのたびに刈り、」を「`claude-config/` は書き込みのたびに刈り、」にし、「設定の同期が残す `*.conflict-*`」を「段 1 の前の設定の同期が残した `*.conflict-*`」にする |
| 361 行 | 「`transcripts/<端末 ID>/` と `config/<端末 ID>/`」を「`transcripts/<端末 ID>/`」にする |
| 364 行の割り切りの 8 | 消し、後ろの番号を 1 つずつ詰める |

- [ ] **Step 3: 中黒とダッシュが無いことを確かめる**

Run: `git diff -U0 docs/design.md README.md | grep '^+' | grep -n -e '・' -e '—' -e '――'`
Expected: 何も出ない。

- [ ] **Step 4: コミットする**

```bash
git add docs/design.md README.md
```

```bash
git commit -m "docs: describe the removal of Claude Code config sync" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 全体の確かめとビルド

**Files:**
- なし（直しが要ったときだけ、そのファイルを直してコミットする）。

**Interfaces:**
- Consumes: Task 1 から Task 10 のすべて。
- Produces: なし。

- [ ] **Step 1: 消したものが残っていないことを確かめる**

Run: `git grep -n -e ClaudeConfigSync -e syncClaudeConfig -e configSyncActive -e CONFIG_PUSH_MS -e configPullConfirmed -e ConfigPreview -e configPreview -e configPull -e onConfigEntries -e CONFIG_BATCH -- packages`
Expected: 出るのは、`loadSettings` が古い鍵を落とす 2 行、Task 8 の「鍵だけを送ってきた古い画面」と `paths.test.ts` の試験、Task 9 のマイグレーションと試験、Task 4 の `(config)` の試験だけ。

Run: `git grep -n -e "kind: 'config'" -e "'config'" -- packages/server/src packages/cli/src packages/ui/src packages/shared/src`
Expected: 出るのは、Worker のために残す共有の型（`FileKind`、`KeyPrefix`、`splitFileKey`）、Task 4 と Task 5 と Task 9 の試験だけ。

Run: `git grep -n "古いサーバは送らない"`
Expected: `packages/shared/src/api.ts` の `pausedReason` の説明（PR 5 で消す）と、`docs/superpowers/plans/2026-10-02-cloud-usage.md`（過去の計画で、書き換えない）だけ。
どちらもこの PR の範囲の外なので、触らない。

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

Task 7 で画面が変わったので、動いているアプリ（4177）の実データに worktree の `packages/ui/dist` を重ねて WebKit で撮り、自分の目で見る（手順は memory の reference-overlay-ui-check）。
読むだけにし、ボタンは押さない。
見るのは、設定の「クラウド同期」の節（Task 1 で選んだ案のとおりか）と、「会話の保持」の節の注記である。

- [ ] **Step 5: 直しがあればコミットする**

Step 1 から Step 4 で直したものがあれば、直したファイルだけを `git add` し、次でコミットする。

```bash
git commit -m "fix: follow-ups from the stage 1 PR 4 verification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

PR を出し、CI の 3 つのジョブ（check、desktop、windows）を待つ。
CI が緑でも、Task 12 の 1 日の試しが終わるまでマージしない。

---

### Task 12: 写しの DB で 1 日試す

**Files:**
- なし（試しの置き場は `$HOME/.agent-hangar-trial/` の下に作り、リポジトリには何も足さない）。

**Interfaces:**
- Consumes: Task 11 のビルド（worktree の `packages/ui/dist`）。
- Produces: 試しの記録（報告に書く）。

spec の入れる条件「写しの DB で 1 日使ってから入れる」の手順である。
全体計画の約束のとおり、手元の開発用サーバとアプリは同じ DB を使うので、古い版が先に起きて同期の区切りを壊した前例がある。
写しを別の `HANGAR_HOME` に置き、別のポートで、この PR のサーバを 1 日動かす。

実物のクラウドには触らない。
試しの同期の相手は、手元で動かす Worker（`wrangler dev`、D1 と R2 は手元の写し）にする。
理由は 3 つある。
1 つめに、`device.json` を写すと、同じ端末が 2 台になり、同じ端末トークンで実物の Worker の進み具合（`devices.last_pulled_seq`）と R2 の同じ鍵を取り合う。
2 つめに、`device.json` を写さずに実物へ参加し直すと、実物の D1 に消す口の無い端末の行が 1 つ増え、PR 5 が入るまでの見張りは端末の数で枠を割るので、本物の端末の止まる線が半分になる。
3 つめに、利用者はいま同期を自分で一時停止している（`pausedReason: user`）。

| 置き場のもの | 写すか | 理由 |
| --- | --- | --- |
| `hangar.db` | 写す（SQLite の `.backup` で） | 試す相手である。実物は動いているので、ファイルの複写ではなく SQLite の写しの口で取る |
| `settings.json` | 写す | ワークスペース、`claudeDir`、tmux を同じにする。`syncClaudeConfig` が残っていれば、Task 8 が読むときに落とすことの確かめにもなる |
| `device.json` | 写さない | 写すと同じ端末が 2 台になる。試しのサーバは新しい ID を作る |
| `token` | 写さない | 試しのサーバは自分の token を作る。本物の画面と statusline が試しのサーバに届かない |
| `cloud.json`、`cloud/` | 写さない | 実物の Worker の端末トークンと参加用の秘密と wrangler の設定を持つ |
| `accounts.json` | 写さない | 試しの画面からアカウントを足したり切り替えたりしない |
| `remote/`、`backups/`、`bin/`、`shell/`、`logs/`、`drops/`、`scratch/` | 写さない | 試しのサーバが自分の置き場に作る。`backups/db/` は段 0 の控えの確かめになる |

試しのサーバは、`HANGAR_CLAUDE_BIN` を `/usr/bin/false` にして起こす。
写しの DB の状態の印は実物の画面で変えても追いつかないので、試しのサーバの「区切りで止める」（ParkWatch）が、実物では印を外したバックグラウンドのセッションに `claude stop` を打ちうるからである。
そのため試しの画面では、要約と、会話を起こす操作は動かない。
試しの画面からは、会話を起こさない、「この PC で再開」を押さない、会話の保持期間を書き込まない（どれも `~/.claude` に書くか、本物のアプリが知らない run を作る）。

- [ ] **Step 1: 試しの置き場を作る**

```bash
mkdir -p "$HOME/.agent-hangar-trial/stage1-pr4"
```

```bash
chmod 700 "$HOME/.agent-hangar-trial" "$HOME/.agent-hangar-trial/stage1-pr4"
```

以下、この置き場を `$TRIAL` と書く（打つときは `TRIAL="$HOME/.agent-hangar-trial/stage1-pr4"` を先に置く）。

- [ ] **Step 2: DB と設定を写す**

```bash
sqlite3 "$HOME/.agent-hangar/hangar.db" ".backup '$TRIAL/hangar.db'"
```

```bash
cp "$HOME/.agent-hangar/settings.json" "$TRIAL/settings.json"
```

- [ ] **Step 3: 移行の前の数を控える**

```bash
sqlite3 "$TRIAL/hangar.db" "select max(version) from schema_migrations; select count(*) from file_sync where kind = 'config'; select key from sync_state where key in ('configPullConfirmed','configPending','skipped:(config)');"
```

数を報告の下書きに残す（数そのものは公開の文書に書かない）。

- [ ] **Step 4: マイグレーションだけを先に当てて確かめる**

```bash
F="$TRIAL/hangar.db" npx tsx -e "import('./packages/server/src/db/open.ts').then((m) => m.openDb(process.env.F).close())"
```

```bash
sqlite3 "$TRIAL/hangar.db" "select max(version) from schema_migrations; select count(*) from file_sync where kind = 'config'; select count(*) from sync_state where key in ('configPullConfirmed','configPending','skipped:(config)');"
```

Expected: 版は 16、残りの 2 つは 0。

```bash
ls "$TRIAL/backups/db"
```

Expected: `hangar-v15-<時刻>.db` が 1 つ。

- [ ] **Step 5: 写しの同期の進み具合を消す**

写しには実物の Worker の進み具合と一時停止が入っているので、手元の Worker と始め直せるように消す。
`changes` の未送信の行はそのまま残す（手元の Worker へ送られるだけである）。

```bash
sqlite3 "$TRIAL/hangar.db" "delete from sync_state where key in ('lastSeq','snapshotDone','filesSeq','lastPushAt','lastPullAt','lastError','paused','pausedReason','transcriptsFrom') or key like 'skipped:%' or key like 'quota:%';"
```

- [ ] **Step 6: 手元の Worker を起こす**

参加用の秘密と、その指紋を作る。

```bash
SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
```

```bash
HASH=$(node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$SECRET")
```

Worker を、背面で起こす（Bash の `run_in_background` を使う）。
D1 と R2 の写しは試しの置き場に持つ。

```bash
WRANGLER_SEND_METRICS=false npx wrangler dev --config packages/cloud/wrangler.jsonc --ip 127.0.0.1 --port 8787 --persist-to "$TRIAL/worker-state" --var "JOIN_SECRET_HASH:$HASH"
```

```bash
curl -s http://127.0.0.1:8787/health
```

Expected: `{"ok":true,…}`。

- [ ] **Step 7: 写しを手元の Worker に参加させる**

```bash
TOKEN=$(SECRET="$SECRET" npx tsx -e "import('./packages/shared/src/cloud.ts').then((m) => console.log(m.encodeJoinToken({ url: 'http://127.0.0.1:8787', secret: process.env.SECRET })))")
```

```bash
printf '%s' "$TOKEN" | HANGAR_HOME="$TRIAL" npm run hangar -- join --force
```

Expected: 「参加しました: http://127.0.0.1:8787」。
`device.json` は試しの置き場に新しく作られる。

- [ ] **Step 8: 古い端末の設定の行を、手元の Worker に置く**

別の端末として参加し、その端末トークンで設定の行を 1 つ上げる（PR 6 までは Worker が `kind: config` を受け付ける）。

```bash
OTHER=$(curl -s -X POST http://127.0.0.1:8787/join -H 'content-type: application/json' -d "{\"secret\":\"$SECRET\",\"device\":{\"id\":\"trial-other\",\"name\":\"trial-other\",\"platform\":\"darwin\"}}" | node -e "process.stdin.on('data',(d)=>console.log(JSON.parse(d).deviceToken))")
```

```bash
printf 'x' > "$TRIAL/config-body"
```

```bash
curl -s -X PUT http://127.0.0.1:8787/files/config/trial-other/CLAUDE.md -H "authorization: Bearer $OTHER" -H 'x-hangar-path: CLAUDE.md' -H 'x-hangar-kind: config' -H "x-hangar-sha256: $(shasum -a 256 "$TRIAL/config-body" | cut -d' ' -f1)" -H 'x-hangar-size: 1' -H 'x-hangar-mtime: 1700000000000' -H 'x-hangar-encrypted: 1' -H 'content-type: application/octet-stream' --data-binary @"$TRIAL/config-body"
```

Expected: `{"seq":1}` のような応答。

- [ ] **Step 9: 試しのサーバを起こす**

試しのサーバを起こす小さな台本を、試しの置き場に書く（Write で書く）。

`$TRIAL/start.sh`：

```sh
#!/bin/sh
# 試しのサーバ。本物の hangar から受け継いだ環境を外し、写しの置き場と別のポートで起こす。
# 1 つめの引数は、この PR の worktree の根である。
set -eu
unset HANGAR_PARENT_PID HANGAR_UI_DIST HANGAR_PORT HANGAR_CLOUD_DIR
export HANGAR_HOME="$HOME/.agent-hangar-trial/stage1-pr4"
# 写しの状態の印で、実物の会話を止めないため（ParkWatch の claude stop）。要約と会話の起動は動かない。
export HANGAR_CLAUDE_BIN=/usr/bin/false
cd "$1"
exec npm run hangar -- start --port 4178 --no-open
```

worktree の根で、背面で起こす（`run_in_background`）。
出力は `$TRIAL/server.log` に残す。

```bash
sh "$TRIAL/start.sh" "$PWD" > "$TRIAL/server.log" 2>&1
```

起こしたプロセスの PID を控える（止めるときに自分の PID だけを止めるため）。

```bash
lsof -nP -iTCP:4178 -sTCP:LISTEN
```

Expected: LISTEN しているのは今起こした node だけで、4177 は本物のアプリのまま。

- [ ] **Step 10: 起こした直後に確かめる**

```bash
curl -s -H "authorization: Bearer $(cat "$TRIAL/token")" http://127.0.0.1:4178/api/sync/status
```

Expected: `state` が `idle`（送受信の最中なら `pushing` か `pulling`）、`error` が null、`skipped` が空、`claudeConfig` の項目が無い。

```bash
sqlite3 "$TRIAL/hangar.db" "select value from sync_state where key = 'filesSeq'; select count(*) from file_sync where kind = 'config';"
```

Expected: `filesSeq` は Step 8 の設定の行の seq 以上、設定の行は 0。

```bash
ls "$TRIAL/remote"
```

Expected: `trial-other` が無い（設定の行は降ろしていない）。

```bash
grep -c syncClaudeConfig "$TRIAL/settings.json"
```

Expected: 0。

`server.log` の最初の `?t=` の付いた URL を WebKit で開き、設定の「クラウド同期」の節と「会話の保持」の節を撮って、自分の目で見る（Task 1 で選んだ案のとおりか）。
読むだけにし、押すのは「今すぐ同期」だけにする（相手は手元の Worker である）。

- [ ] **Step 11: 1 日回して確かめる**

起こしたまま 24 時間以上置く。
UTC の 0 時をまたぐようにする。
朝と夕方と、終わりの 3 回、次を見る。

```bash
curl -s -H "authorization: Bearer $(cat "$TRIAL/token")" http://127.0.0.1:4178/api/sync/status
```

```bash
grep -n -e "\[sync\]" -e "\[pull\]" -e "\[upload\]" -e "\[files\]" -e Error "$TRIAL/server.log" | tail -50
```

```bash
lsof -nP -iTCP:4177 -sTCP:LISTEN
```

Expected: 同期の状態に `error` が出続けていない。
ログに、設定の行や `(config)` で繰り返す失敗が無い。
4177 は本物のアプリのまま動いている。

- [ ] **Step 12: 片付ける**

Step 9 で控えた PID の試しのサーバだけを止める（ポートの番号だけを頼りに止めない）。

```bash
kill <試しのサーバの PID>
```

`wrangler dev` を止める（`run_in_background` の task を止める）。

```bash
rm -rf "$HOME/.agent-hangar-trial/stage1-pr4"
```

- [ ] **Step 13: 実物のクラウドで確かめるかを聞く**

実物のクラウドでの確かめは、この試しでは行わない。
入れ替えた後の本物のアプリで、利用者が自分で一時停止を解くか「今すぐ同期」を押したときに、R2 に残る古い設定の行を読み飛ばすことが初めて実物で確かめられる。

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

- [ ] **Step 14: 報告する**

報告には、試した日時の幅、Step 4 と Step 10 と Step 11 の結果、見つけた問題、実物のクラウドで確かめたかどうかを書く。
実際の行数と件数は返事にだけ書き、リポジトリの文書には書かない。
1 日の試しで問題が無ければ、CI が緑の PR をマージし、CLAUDE.local.md の 6 以降（アプリの入れ替え）へ進む。

---

## 自己点検の記録

- spec の「消すもの」の 2 項目めは、`sync/claudeConfig.ts`（Task 8）、puller の config の経路（Task 4）、UI の下見のダイアログと Intent（Task 7）、設定の `syncClaudeConfig`（Task 7 と Task 8）、CLI の teardown の `_config` の退避（Task 5）で尽くした。
  Worker の `kind: 'config'` の受け入れは、spec の PR の表が PR 6 に置くので触らない。
- 「残す境界」の読み飛ばしは Task 4 と Task 5、`BACKUP_GENERATIONS` と `backups/claude-config/` は Task 6、パスの検査は Global Constraints で留めた。
- 「後始末」の端末の分は Task 9（版 16）と Task 8 の `loadSettings` で尽くした。
- spec に無い足し算は 1 つある。
  `backups/claude-config/` の刈り込みを、消える取り込みの中から保持期間の書き込みへ移した（Task 6）。
  移さないと、design.md と README の「3 種類とも 20 世代」が崩れる。
- 親から頼まれた申し送りの 2 つは、Task 2（試験の補助）と Task 3（DB を先に開く）である。
- `git grep -n "古いサーバは送らない"` の 2 件は、どちらもこの PR の範囲の外である（Task 11 の Step 1）。
