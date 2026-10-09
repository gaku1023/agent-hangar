# 段 1 PR 4 古い版の DB を作る試験の補助と、setup cloud と join が DB を先に開くこと Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 古い版の DB を作る試験の補助を 1 つに寄せ、`hangar setup cloud` と `hangar join` が、Cloudflare に資源を作る前と参加の要求を出す前に DB を開くようにする。
DB の控えが取れない端末では、外に何も作らず、`cloud.json` も書かずに止まる。

**Architecture:** 機能は足さない。
まず、5 か所の試験に同じ形で書いてある「指定した版までのマイグレーションだけを当てた DB を作る」数行を、試験の補助 `packages/server/test/oldDb.ts` に寄せる。
次に、床を刻むための DB を先に開く口 `openTranscriptsFloor` を `sync/transcriptsFrom.ts` に作り、`runSetupCloud` と `runJoin` が処理の先頭でそれを開いて、最後に床を刻むまで持つ。
同期の振る舞い、スキーマ、画面、Worker（`packages/cloud`）、Claude Code の設定の同期には触らない。

**Tech Stack:** TypeScript、better-sqlite3、vitest。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md`（PR の表の 4 の行）。
段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md` の D6（設定の同期は残す）と「段階的に入れるときの約束」。

## この計画を書き直した経緯

2026-10-08 に書いたときの PR 4 は「Claude Code の設定の同期を端末から消す」で、ファイル名も `2026-10-08-stage1-pr4-config-sync-device.md` だった。
2026-10-09 に利用者が全体計画の D6 を取り消し、設定の同期は段 1 では消さずに残して、段 4 で狭く作り直すことになった。
そこで、設定の同期を消すタスクを取り下げた。
取り下げたのは次のものである。

- 設定の画面から設定の同期を外す姿の試作（もとの Task 1）
- puller と teardown が、本文でない行を読み飛ばす分岐（もとの Task 4 と Task 5）
- 控えの世代数（`BACKUP_GENERATIONS`）を `config/cloud.ts` へ移し、`backups/claude-config/` の刈り込みを保持期間の書き込みへ移すこと（もとの Task 6）
- 画面、サーバ、共有の型から設定の同期を外すこと（もとの Task 7 と Task 8）
- 設定の同期の名残を消す版 16 のマイグレーション（もとの Task 9）
- design.md と README の、設定の同期の記述の書き換え（もとの Task 10）
- 写しの DB での 1 日の試し（もとの Task 12）

残したのは、同じブランチで入れる予定だった申し送りの 2 つ（Task 1 と Task 2）と、全体の確かめ（Task 3）である。

## 1 日の試しを行わない理由

全体計画の約束では、スキーマか同期に触る PR を、DB の写しを置いた別の `HANGAR_HOME` で 1 日使ってから入れる。
残した 2 つは、どちらにもあたらない。
Task 1 は試験の補助だけを変え、製品のコードに触らない。
Task 2 は、`setup cloud` と `join` が DB を開く時機を処理の先頭へ動かすだけで、当てるマイグレーション、刻む床の値、動いているサーバの同期の振る舞いは変えない。
しかもこの 2 つの命令は利用者が打ったときにだけ走るので、1 日置いても通る道は増えない。
確かめは、控えが取れないときに外へ何も出さないことと、取れるときに先に控えて最後に床を刻むことを、Task 2 の試験で押さえる。

## 着手の条件

- 段 0 の DB の自動控え（`packages/server/src/db/backup.ts` と、当てる前に控えを取る `openDb`）は main に入っている。
  着手のときも `git grep -n "export function backupDb" -- packages/server/src/db/backup.ts` が 1 行を返すことを確かめ、返さなければ着手しない。
- 段 1 の PR 1、2、3 は main に入っている（`33ca14e` で確かめた）。
- この PR はマイグレーションを足さない。
  次の版（この計画を書き直した時点の main では 16）は PR 5 が使う。

## Global Constraints

- PR 4 の中身は「古い版の DB を作る試験の補助を 1 つに寄せ、`hangar setup cloud` と `hangar join` が DB を処理の先頭で開くようにする」で、入れる条件は「段 0 の DB の自動控えが入っている」である（spec の PR の表）。
  1 日の試しは要らない（上の「1 日の試しを行わない理由」）ので、CI が緑なら CLAUDE.local.md の流れのとおりマージしてよい。
- 各 PR は、それ単独でアプリが動く状態で入れる。
- Claude Code の設定の同期（`sync/claudeConfig.ts`、puller の config の経路、Worker の `kind: 'config'` の受け入れ、画面の下見のダイアログ、設定の `syncClaudeConfig`、CLI の teardown の `_config` の退避）には触らない。
  全体計画の D6 を取り消したので、段 1 では残す。
- 永続する識別子（DB の表名と列名、同期で運ぶ payload、DTO と API の鍵）は改名しない（D8）。
- Worker を配備しない。
  実物のクラウドに触らない。
- 4177 のサーバ、`/Applications/Hangar.app`、実物の `~/.agent-hangar` には触らない。
  `tmux kill-server` は呼ばない。
- 行番号は main `33ca14e` で数えた。
  前のタスクで行がずれるので、行番号は目安とし、引用した文で当てる。
- 作業は main から切った新しい worktree で行い、着手の前に `npm ci` を打つ。
- コマンドはリポジトリの根で 1 本ずつ打つ（git と他のコマンドを `&&` でつながない）。
- 試験は `npx vitest run <ファイルかディレクトリ>`、型は `npm run typecheck`（1 つの包みだけなら `npm run typecheck -w packages/<名前>`）。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける（`git commit -m "<件名>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`）。
- 文書（`docs/design.md`）とコードのコメントは日本語の一文一行で書き、中黒と em ダッシュを使わない。
- 公開リポジトリなので、実在の人名、メール、手元のパス、使用量、Worker の URL、実際のスキル名を、コード、試験、文書、コミットに書かない。

## Review Focus

- **DB の控えが取れない端末で `setup cloud` か `join` を打つ**：Cloudflare に何も作らず、参加の要求も出さず、`cloud.json` も書かずに止まる（Task 2 の試験で留める）。
- **控えが取れる端末で `setup cloud` を打つ**：先に DB を上げて控え、最後に床を刻む。床が既にあれば動かさない（Task 2 の試験で留める）。
- **5 か所の試験を補助に置き換える**：各試験が作る DB の版（1 つ前の版、指定した版）と、見ている断言が変わらない（Task 1 の Step 7 で、置き換えた試験を全部回す）。

---

### Task 1: 古い版の DB を作る試験の補助を 1 つに寄せる

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
この PR の Task 2 と、PR 5 の版 16 の試験もこれを使うので、先に 1 つに寄せる。

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

### Task 2: `setup cloud` と `join` は、DB を処理の先頭で開く

**Files:**
- Modify: `packages/server/src/sync/transcriptsFrom.ts:53-62`（`stampTranscriptsFrom`）
- Modify: `packages/server/src/cliEntry.ts:17`
- Modify: `packages/cli/src/cloud.ts:9`（import）、`:388-479`（`runSetupCloud`）、`:622-677`（`runJoin`）
- Test: `packages/server/src/sync/transcriptsFrom.test.ts`
- Test: `packages/cli/src/cloud.test.ts`

**Interfaces:**
- Consumes: Task 1 の `seedDbAt`、`dbVersionOf`、`LATEST_DB_VERSION`。
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

### Task 3: 全体の確かめとビルド

**Files:**
- なし（直しが要ったときだけ、そのファイルを直してコミットする）。

**Interfaces:**
- Consumes: Task 1 と Task 2 のすべて。
- Produces: なし。

- [ ] **Step 1: 寄せ残しと呼び残しが無いことを確かめる**

Run: `git grep -n "create table if not exists schema_migrations" -- 'packages/*.test.ts'`
Expected: 何も出ない。

Run: `git grep -n stampTranscriptsFrom -- packages/cli/src/cloud.ts`
Expected: 何も出ない（`runSetupCloud` と `runJoin` は、先に開いた `openTranscriptsFloor` で床を刻む）。

- [ ] **Step 2: 設定の同期と Worker と画面に触っていないことを確かめる**

Run: `git diff --stat origin/main -- packages/server/src/sync/claudeConfig.ts packages/server/src/sync/puller.ts packages/server/src/db/migrations.ts packages/cloud packages/ui`
Expected: 何も出ない。

- [ ] **Step 3: 型と試験を全部回す**

Run: `npm run typecheck`
Expected: PASS。

Run: `npm test`
Expected: PASS（全部）。

- [ ] **Step 4: 3 つのビルドを通す**

Run: `npm run build`
Expected: 成功する。

Run: `npm run bundle-server -w apps/desktop`
Expected: 成功する。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`
Expected: 成功し、`.app` ができる（tauri build は Homebrew の cargo を PATH の先頭に置く）。

画面は変わらないので、実データに重ねて撮る確かめは行わない。

- [ ] **Step 5: 直しがあればコミットする**

Step 1 から Step 4 で直したものがあれば、直したファイルだけを `git add` し、次でコミットする。

```bash
git commit -m "fix: follow-ups from the stage 1 PR 4 verification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: PR を出してマージする**

PR を出し、CI の 3 つのジョブ（check、desktop、windows）を待つ。
緑になれば、CLAUDE.local.md の 5 のとおりマージし、6 以降（アプリの入れ替え）へ進む。
1 日の試しは行わない（「1 日の試しを行わない理由」）。

---

## 自己点検の記録

- spec の PR の表の 4 の行（試験の補助を 1 つに寄せることと、`setup cloud` と `join` が DB を処理の先頭で開くこと）は、Task 1 と Task 2 で尽くした。
- 設定の同期を消すタスクは、全体計画の D6 を取り消したので取り下げた（「この計画を書き直した経緯」）。
  spec の「消すもの」「残す境界」「後始末」からも、設定の同期を消す項目は外してある。
- この PR はマイグレーションを足さないので、PR 5 の版は 16 になる（PR 5 の計画の着手の条件で数え直す）。
- 1 日の試しを行わないのは、全体計画の約束の対象（スキーマか同期に触る PR）にあたらないためである（「1 日の試しを行わない理由」）。
- 試験の補助は PR 5 の版 16 の試験も使う（PR 5 の計画の Task 8）。
