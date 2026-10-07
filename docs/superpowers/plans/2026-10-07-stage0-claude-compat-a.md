# 段 0 Claude Code との互換の約束（計画 A） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code の形式のずれを 6 つの契約で見張って `~/.agent-hangar/compat.json` に記録し、確認リストへ渡すデータ（`GET /api/compat` と `GET /api/readiness` の要約）までを作る。あわせて、版ごとの見本とその試験、週に 1 度の照合、マイグレーションの前の DB の自動控えを入れる。

**Architecture:** 契約ごとに、記録を受け取って知らない値を `Drift` として返す純粋な関数を `packages/server/src/provider/claude-code/compat/` に置く。
読み取りの側（索引、登録の見張り、statusline、アカウント、CLI の呼び出し、ターンへ跳ぶ処理）は、いまの振る舞いを変えずに、ずれを `CompatSink` へ渡すだけにする。
`CompatLog` が同じ契約と値の組を 1 件にまとめてファイルへ書き、サーバがそれを API に載せる。
自動で直すのは、statusline の `resets_at` の単位と、シェルの包みのサブコマンドの一覧（起動のたびに `claude --help` から作る）だけである。
見本は開発用の道具で本物の claude を動かして採り、試験はすべての版の見本でずれが 0 件であることを確かめる。

**Tech Stack:** TypeScript、Node 22、better-sqlite3、Hono、vitest、tmux、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-07-stage0-claude-compat-design.md`（段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md` の D1 から D11）。

## 範囲

- 計画 A は、spec のうち設定の確認リストの 6 行目の見た目（View、CSS、文言の細部）を除くすべてである。
- 6 行目の見た目は、試作を利用者が選んでから計画 B で書く。
- 計画 A は、その行が読むデータ（`GET /api/compat`、`ReadinessDto.compat`、`CompatDto`、状態を決める `compatState`、UI の `api.compat()`）までを作る。
- PR の切り方の目安は、PR 1 が Task 1、PR 2 が Task 2 から Task 12、PR 3 が Task 13 から Task 16 である。

## Global Constraints

- 対応する版の範囲は決めない。範囲の外の claude を断らない。
- 知っている値の集合で見張り（実行中）、版ごとの見本で確かめる（試験）。
- ずれは、契約、値（たとえば `system.subtype=foo`）、claude の版、回数、最初と最後に見た時刻を持つ。
- 版は、その値を読んだ元（レジストリ、トランスクリプトの行、statusline の JSON）に載っている `version` を使い、無ければ手元の `claude --version` を使う。
- 記録は `~/.agent-hangar/compat.json` に置く。端末ごとのもので、同期しない。DB には入れない。
- 同じ契約と値の組は 1 件にまとめて回数を数える。件数の上限は 100 件で、超えたら最後に見た時刻の古いものから落とす。
- 読む口は `GET /api/compat`（確かめた版、手元の版、ずれの一覧）で、`GET /api/readiness` の `compat` に確かめた版、手元の版、ずれの件数を足す。
- 確かめた版は、見本のうち最も新しい版である。手元の claude がそれより新しいときは「未確認の版」として知らせるが、止めはしない。README に確かめた版を書く。
- 知らない registry の `status` は、いまと同じく作業中として扱う。
- statusline の `resets_at` が 10^11 より大きければミリ秒と見て、秒に直さずにそのまま使う。
- シェルの包みのサブコマンドの一覧は、サーバの起動のたびに `claude --help` から作り直す。読めないときは組み込みの一覧を使う。組み込みとの差を記録する。
- 形式のずれを自動で直すのは、statusline の単位とサブコマンドの一覧だけである。
- ずれを確認リストの外（ヘッダー、知らせの札）に出さない。
- 見本は `packages/server/test/fixtures/claude/<版>/` に置く。手書きの見本は残す。
- 見本を採る道具は CI で動かさない。Claude の使用量を使うので、動かす前に必ず利用者に聞く。
- tmux は専用のソケットを `-S` で名指しし、`kill-server` は決して呼ばない。止めるのは名指しのソケットの名指しのセッションだけである。
- 見本採りの後始末は `claude purge <一時ディレクトリ> -y` で行う。`--all` は決して渡さない。
- 計画にも見本にも、実在の人名、メールアドレス、手元のパス、実際の使用量、実際のスキル名を書かない（公開リポジトリである）。
- DB の控えは、当てていないマイグレーションがあり、かつ DB がすでに 1 本以上のマイグレーションを当てているとき、当てる前に `VACUUM INTO` で `~/.agent-hangar/backups/db/hangar-v<当てた最後の版>-<時刻>.db` に取る。新しい DB と `:memory:` では取らない。新しいものから 5 つまで残す。取れなければマイグレーションを当てず、理由を出して起動を止める。
- 永続する識別子（DB の表名と列名、同期の payload、DTO と API の鍵）は改名しない（D8）。足すだけにする。
- コメントは日本語で、周りと同じ密度にする。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- 試験は `npx vitest run <ファイル>`、型は `npm run typecheck`、どちらもリポジトリの根で打つ。

## Review Focus

- **長い履歴を初めて索引にする（古い版の行が何千行もある）**：昔の形の行でずれが溢れず、手元の版より古い行は記録しない。版の無いメタ行は直前の行の版を継ぐ。Task 4 の試験で留める。
- **レジストリに知らない `status` が出たまま、500 ミリ秒ごとに読み直す**：回数は登録が変わったときだけ増え、`compat.json` は読み直しのたびには書かない。Task 3 と Task 5 の試験で留める。
- **`claude --help` が固まる、または Commands の節を持たない**：起動を待たせず、組み込みの一覧で包みを書き、ずれを 1 件だけ記録する。サブコマンドの名前にシェルの記号が混じっても、包みに書かない。Task 8 の試験で留める。
- **`compat.json` が壊れている、または書けない（置き場がファイル、権限が無い）**：サーバは落ちず、空から記録を始め、書けなくても投げない。Task 3 の試験で留める。
- **登録のファイルの中身が JSON の配列や `null`**：その 1 件だけを読まずにずれとして記録し、ほかのセッションの状態は出し続ける。Task 5 の試験で留める。

## ファイルの地図

| ファイル | 役目 |
| --- | --- |
| `packages/server/src/db/backup.ts`（新規） | DB の控えを取り、5 世代に刈る |
| `packages/server/src/db/open.ts` | 当てる前に控えを取る |
| `packages/shared/src/compat.ts`（新規） | 互換の DTO、版の比べ方、確認リストの状態 |
| `packages/server/src/provider/claude-code/compat/types.ts`（新規） | `Drift`、`CompatSink`、記録の版の読み方 |
| `packages/server/src/provider/claude-code/compat/version.ts`（新規） | 確かめた版 |
| `packages/server/src/provider/claude-code/compat/log.ts`（新規） | `compat.json` の読み書き |
| `packages/server/src/provider/claude-code/compat/transcript.ts`（新規） | トランスクリプトの契約 |
| `packages/server/src/provider/claude-code/compat/registry.ts`（新規） | レジストリの契約 |
| `packages/server/src/provider/claude-code/compat/statusline.ts`（新規） | statusline の契約と `resets_at` の単位 |
| `packages/server/src/provider/claude-code/compat/claudeDir.ts`（新規） | `~/.claude` の項目の契約 |
| `packages/server/src/provider/claude-code/compat/cli.ts`（新規） | CLI の契約、`--help` の読み取り |
| `packages/server/src/provider/claude-code/compat/screen.ts`（新規） | 画面の文字の契約 |
| `packages/server/test/capture/`（新規） | 見本を採る道具の中身（筋書き、伏せ方、動かし方） |
| `scripts/capture-claude-fixtures.ts`（新規） | 見本を採る道具の入口 |
| `packages/server/test/claudeFixtures.ts`、`claudeFixtures.test.ts`、`claudeLive.test.ts`（新規） | 見本の一覧、見本の試験、週ごとの照合 |
| `.github/workflows/claude-compat.yml`（新規） | 週に 1 度と手動の照合 |

---

### Task 1: マイグレーションの前の DB の自動控え

**Files:**
- Create: `packages/server/src/db/backup.ts`
- Modify: `packages/server/src/db/open.ts:1-19`
- Test: `packages/server/src/db/backup.test.ts`
- Modify: `docs/design.md`（「決めた前提と未決事項」のマイグレーションの項と、`backups/` の項）

**Interfaces:**
- Produces: `openDb(file: string, opts?: OpenDbOptions): Db`（`OpenDbOptions = { backupDir?: string; now?: () => Date }`）。既存の呼び手（`openDb(path)`）はそのまま動く。
- Produces: `DbBackupError`、`backupDb(db, dir, lastVersion, now, keep?)`、`pruneDbBackups(dir, keep?)`、`backupStamp(d: Date): string`、`defaultDbBackupDir(dbFile: string): string`、`DB_BACKUP_GENERATIONS = 5`（`db/backup.ts`）。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/db/backup.test.ts` を作る。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectMode } from '../../test/platform.ts';
import { backupStamp, DbBackupError } from './backup.ts';
import { MIGRATIONS } from './migrations.ts';
import { openDb } from './open.ts';

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;
const AT = new Date(Date.UTC(2026, 9, 7, 6, 30, 0, 123));
const STAMP = '20261007T063000123Z';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dbbak-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** version 以下のマイグレーションだけを当てた実物のファイルを作る。既存の DB からの移行を試すため。 */
function seedAt(file: string, version: number): void {
  const db = new Database(file);
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, 1);
  }
  db.close();
}

/** そのファイルが当てた最後の版。 */
function versionOf(file: string): number {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare('select max(version) v from schema_migrations').get() as { v: number }).v; } finally { db.close(); }
}

describe('openDb の控え', () => {
  it('当てていないマイグレーションがあれば、当てる前の DB を backups/db に控える', () => {
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    openDb(file, { now: () => AT }).close();
    const dir = path.join(tmp, 'backups', 'db');
    const name = `hangar-v${LATEST - 1}-${STAMP}.db`;
    expect(fs.readdirSync(dir)).toEqual([name]);
    expect(versionOf(path.join(dir, name))).toBe(LATEST - 1);
    expect(versionOf(file)).toBe(LATEST);
    expectMode(path.join(dir, name), 0o600);
  });
  it('新しい DB、当てるものが無い DB、:memory: では控えない', () => {
    const file = path.join(tmp, 'hangar.db');
    openDb(file).close();
    openDb(file).close();
    openDb(':memory:').close();
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false);
  });
  it('控えが取れなければ、マイグレーションを当てずに理由を投げる', () => {
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x');
    expect(() => openDb(file, { backupDir: path.join(tmp, 'blocker', 'db') })).toThrow(DbBackupError);
    expect(versionOf(file)).toBe(LATEST - 1);
  });
  it('控えは新しいものから 5 つ残し、控えの形でないファイルには触れない', () => {
    const dir = path.join(tmp, 'backups', 'db');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, `hangar-v3-2026010${i}T000000000Z.db`), '');
    fs.writeFileSync(path.join(dir, 'mine.db'), 'keep');
    const file = path.join(tmp, 'hangar.db');
    seedAt(file, LATEST - 1);
    openDb(file, { now: () => AT }).close();
    expect(fs.readdirSync(dir).sort()).toEqual([
      `hangar-v${LATEST - 1}-${STAMP}.db`,
      'hangar-v3-20260103T000000000Z.db', 'hangar-v3-20260104T000000000Z.db', 'hangar-v3-20260105T000000000Z.db', 'hangar-v3-20260106T000000000Z.db',
      'mine.db',
    ].sort());
  });
});

describe('backupStamp', () => {
  it('UTC のミリ秒までを詰めた形で、辞書順がそのまま時刻順になる', () => {
    expect(backupStamp(AT)).toBe(STAMP);
    expect(backupStamp(new Date(Date.UTC(2026, 9, 7, 6, 30, 0, 124))) > STAMP).toBe(true);
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/db/backup.test.ts`
Expected: FAIL。`./backup.ts` が無いので読み込みで落ちる。

- [ ] **Step 3: `db/backup.ts` を作る**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

/** 控えを残す数。新しいものから数える。 */
export const DB_BACKUP_GENERATIONS = 5;
/** 控えの名前。当てた最後の版と、UTC の時刻（ミリ秒まで）を持つ。刈るときはこの形のものだけを見る。 */
const NAME = /^hangar-v(\d+)-(\d{8}T\d{9}Z)\.db$/;

/** 控えが取れなかった。マイグレーションは当てていない。 */
export class DbBackupError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`DB の控えを ${file} に取れなかったので、マイグレーションを当てずに止めました（${cause instanceof Error ? cause.message : String(cause)}）。置き場に書けるか、空きがあるかを確かめてください`);
    this.name = 'DbBackupError';
  }
}

/** 20261007T063000123Z の形。辞書順がそのまま時刻順になる。 */
export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

/** 控えの置き場の既定。hangar.db と同じ置き場の backups/db（~/.agent-hangar/backups/db）である。 */
export function defaultDbBackupDir(dbFile: string): string {
  return path.join(path.dirname(dbFile), 'backups', 'db');
}

/**
 * VACUUM INTO で DB の写しを取り、新しいものから keep 個を残して古いものを消す。
 * VACUUM はトランザクションの中では動かないので、マイグレーションを当てる前に、トランザクションの外で呼ぶ。
 * 写しが取れなければ DbBackupError を投げる。刈り込みの失敗は投げない（控えはもう取れている）。
 */
export function backupDb(db: Database.Database, dir: string, lastVersion: number, now: Date, keep: number = DB_BACKUP_GENERATIONS): string {
  const file = path.join(dir, `hangar-v${lastVersion}-${backupStamp(now)}.db`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    db.prepare('vacuum into ?').run(file);
    // 写しは会話の索引をそのまま持つので、トークンと同じ 0600 にする。
    fs.chmodSync(file, 0o600);
  } catch (e) {
    throw new DbBackupError(file, e);
  }
  try {
    pruneDbBackups(dir, keep);
  } catch (e) {
    console.error('[db] 古い控えを刈れませんでした', e instanceof Error ? e.message : e);
  }
  return file;
}

/**
 * 控えの形の名前のファイルだけを、時刻の新しい順に keep 個残して消す。
 * 置き場に利用者が置いたファイルとリンクには触れない。消せなかったものは次の機会に回す。
 */
export function pruneDbBackups(dir: string, keep: number = DB_BACKUP_GENERATIONS): number {
  const limit = Math.max(1, keep);
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && NAME.test(e.name))
    .map((e) => ({ name: e.name, stamp: NAME.exec(e.name)![2]! }))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.name < b.name ? 1 : -1));
  let removed = 0;
  for (const f of files.slice(limit)) {
    try { fs.rmSync(path.join(dir, f.name)); removed++; } catch { /* 次の機会に消える */ }
  }
  return removed;
}
```

- [ ] **Step 4: `openDb` で当てる前に控えを取る**

`packages/server/src/db/open.ts` を次の内容に置き換える。

```ts
import Database from 'better-sqlite3';
import { backupDb, defaultDbBackupDir } from './backup.ts';
import { MIGRATIONS } from './migrations.ts';

export type Db = Database.Database;
/** backupDir は控えの置き場（既定は DB と同じ置き場の backups/db）、now は控えの名前に使う時刻。どちらも試験が差し替える。 */
export type OpenDbOptions = { backupDir?: string; now?: () => Date };

/**
 * データベースを開き、WAL と外部キーを有効にして、未適用のマイグレーションを順に当てる。
 * すでに 1 本以上当てた DB に未適用のものがあれば、当てる前に VACUUM INTO で控えを取る（db/backup.ts）。
 * 新しい DB と :memory: では取らない。控えが取れなければ、何も当てずに DbBackupError を投げる。
 */
export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  const applied = new Set((db.prepare('select version from schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length > 0 && applied.size > 0 && file !== ':memory:') {
    try {
      backupDb(db, opts.backupDir ?? defaultDbBackupDir(file), Math.max(...applied), (opts.now ?? (() => new Date()))());
    } catch (e) {
      db.close();
      throw e;
    }
  }
  const apply = db.transaction((m: { version: number; sql: string }) => {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, Date.now());
  });
  for (const m of pending) apply(m);
  return db;
}
```

- [ ] **Step 5: 通るのを確かめる**

Run: `npx vitest run packages/server/src/db/backup.test.ts packages/server/src/db/db.test.ts`
Expected: PASS。

- [ ] **Step 6: 設計書を直す**

`docs/design.md` の「決めた前提と未決事項」の項「ID は UUID v7。マイグレーションは…」の中で、次の 2 か所を置き換える。

置き換え前：`版は 8 まで進んでいる（`
置き換え後：`版は 15 まで進んでいる（`

置き換え前：`8 で `transcript_files` に `device_id` と索引を足して `file_sync` を作った）。`
置き換え後：`8 で `transcript_files` に `device_id` と索引を足して `file_sync` を作り、9 で `session_activity` を作り、10 で `todos` に完了の候補の 4 列を足し、11 で `devices.shell_hook` を足し、12 で `turn_intents` を作り、13 で `session_states` を作って生きているセッションをまとめて Done にし、14 で `session_states` に戻る時刻の 2 列を足し、15 で `usage_snapshots.account` と 2 つの索引を足した）。`

同じ節の「`~/.agent-hangar/backups/` の 3 種類…」の項の最後の行（`この置き場の外に残る控え（…）は消さない。`）の直後に、次の項を足す。

```markdown
- `~/.agent-hangar/backups/db/` は DB の控えで、新しい方から 5 世代を残す。
  DB を開く側（サーバと、DB を開く CLI）は、すでに 1 本以上のマイグレーションを当てた DB に当てていないものがあるとき、当てる前に `VACUUM INTO` で `hangar-v<当てた最後の版>-<UTC の時刻>.db` を作る（`packages/server/src/db/backup.ts`）。
  新しい DB と `:memory:` では作らない。
  控えが取れなければマイグレーションを当てず、理由を出して起動を止める。
  「控えが取れなければ書かない」の原則に合わせた。
  刈るのは控えの形の名前のものだけで、置き場に利用者が置いたファイルには触れない。
```

- [ ] **Step 7: 型と全部の試験を通す**

Run: `npm run typecheck`
Expected: エラー無し。

Run: `npx vitest run --project server`
Expected: PASS。

- [ ] **Step 8: コミットする**

```bash
git add packages/server/src/db/backup.ts packages/server/src/db/backup.test.ts packages/server/src/db/open.ts docs/design.md
git commit -m "feat(server): back up the DB before applying migrations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 互換の DTO と版の比べ方（shared）

**Files:**
- Create: `packages/shared/src/compat.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/compat.test.ts`

**Interfaces:**
- Produces: `CompatContract = 'transcript' | 'registry' | 'statusline' | 'claude-dir' | 'cli' | 'screen'`、`COMPAT_CONTRACTS: readonly CompatContract[]`。
- Produces: `CompatDriftDto = { contract: CompatContract; value: string; version: string | null; count: number; firstSeenAt: number; lastSeenAt: number }`。
- Produces: `CompatDto = { verifiedVersion: string; localVersion: string | null; drifts: CompatDriftDto[] }`、`CompatSummaryDto = { verifiedVersion: string; localVersion: string | null; driftCount: number }`。
- Produces: `compareClaudeVersions(a: string, b: string): number`、`CompatState = 'ok' | 'unverified' | 'drift'`、`compatState(s: CompatSummaryDto): CompatState`。計画 B の presenter が `compatState` で 3 つの状態を決める。

- [ ] **Step 1: 落ちる試験を書く**

`packages/shared/src/compat.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import { compareClaudeVersions, compatState } from './compat.ts';

describe('compareClaudeVersions', () => {
  it('区切りごとに数として比べる', () => {
    expect(compareClaudeVersions('2.1.292', '2.1.292')).toBe(0);
    expect(compareClaudeVersions('2.1.9', '2.1.292')).toBeLessThan(0);
    expect(compareClaudeVersions('2.2.0', '2.1.292')).toBeGreaterThan(0);
    expect(compareClaudeVersions('3.0', '2.9.999')).toBeGreaterThan(0);
  });
  it('足りない区切りと、数でない区切りは 0 とみなす', () => {
    expect(compareClaudeVersions('2.1', '2.1.0')).toBe(0);
    expect(compareClaudeVersions('2.1.x', '2.1.0')).toBe(0);
  });
});

describe('compatState', () => {
  const base = { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 };
  it('ずれが 1 件でもあれば drift', () => {
    expect(compatState({ ...base, driftCount: 1 })).toBe('drift');
    expect(compatState({ ...base, localVersion: '2.1.300', driftCount: 2 })).toBe('drift');
  });
  it('手元の版が確かめた版より新しければ unverified', () => {
    expect(compatState({ ...base, localVersion: '2.1.293' })).toBe('unverified');
  });
  it('同じ版、古い版、手元の版が分からないときは ok', () => {
    expect(compatState(base)).toBe('ok');
    expect(compatState({ ...base, localVersion: '2.1.200' })).toBe('ok');
    expect(compatState({ ...base, localVersion: null })).toBe('ok');
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/shared/src/compat.test.ts`
Expected: FAIL。`./compat.ts` が無い。

- [ ] **Step 3: `compat.ts` を作り、index から出す**

`packages/shared/src/compat.ts` を作る。

```ts
/**
 * Claude Code との互換（docs/design.md「Claude Code との互換」）。
 * hangar が頼る Claude Code の形式を 6 つの契約に分け、知らない値に出会ったら「ずれ」として記録する。
 */
export type CompatContract = 'transcript' | 'registry' | 'statusline' | 'claude-dir' | 'cli' | 'screen';
export const COMPAT_CONTRACTS: readonly CompatContract[] = ['transcript', 'registry', 'statusline', 'claude-dir', 'cli', 'screen'];

/**
 * 記録したずれの 1 件。同じ契約と値の組は 1 件にまとめ、回数と最初と最後に見た時刻を持つ。
 * version はその値を最後に読んだ元の版で、分からなければ null。
 */
export type CompatDriftDto = { contract: CompatContract; value: string; version: string | null; count: number; firstSeenAt: number; lastSeenAt: number };
/** GET /api/compat。verifiedVersion は見本のうち最も新しい版、localVersion は手元の claude --version（読めなければ null）。drifts は最後に見た時刻の新しい順。 */
export type CompatDto = { verifiedVersion: string; localVersion: string | null; drifts: CompatDriftDto[] };
/** GET /api/readiness の compat。確認リストの 6 行目が読む。 */
export type CompatSummaryDto = { verifiedVersion: string; localVersion: string | null; driftCount: number };
/** 確認リストの 3 つの状態。drift はずれが 1 件以上、unverified は手元の版が確かめた版より新しい、ok はそれ以外。 */
export type CompatState = 'ok' | 'unverified' | 'drift';

/**
 * claude の版（2.1.292 の形）を比べる。a が古ければ負、同じなら 0、新しければ正。
 * 区切りごとに数として比べ、足りない区切りと数でない区切りは 0 とみなす。
 */
export function compareClaudeVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 確認リストの状態。止めてはいないので、未確認の版はずれより弱い。 */
export function compatState(s: CompatSummaryDto): CompatState {
  if (s.driftCount > 0) return 'drift';
  if (s.localVersion !== null && compareClaudeVersions(s.localVersion, s.verifiedVersion) > 0) return 'unverified';
  return 'ok';
}
```

`packages/shared/src/index.ts` の末尾に足す。

```ts
export * from './compat.ts';
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run packages/shared/src/compat.test.ts`
Expected: PASS。

- [ ] **Step 5: コミットする**

```bash
git add packages/shared/src/compat.ts packages/shared/src/compat.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add the Claude Code compat DTOs and version compare

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ずれの記録（CompatLog）と確かめた版

**Files:**
- Create: `packages/server/src/provider/claude-code/compat/types.ts`
- Create: `packages/server/src/provider/claude-code/compat/version.ts`
- Create: `packages/server/src/provider/claude-code/compat/log.ts`
- Test: `packages/server/src/provider/claude-code/compat/log.test.ts`

**Interfaces:**
- Consumes: `CompatContract`、`CompatDriftDto`、`COMPAT_CONTRACTS`（Task 2）。
- Produces: `Drift = { contract: CompatContract; value: string; version: string | null }`、`CompatSink = { note(d: Drift): void }`、`NO_COMPAT: CompatSink`、`isRec(v): v is Record<string, unknown>`、`versionOfRecord(raw: unknown): string | null`（`compat/types.ts`）。
- Produces: `VERIFIED_CLAUDE_VERSION: string`（`compat/version.ts`、初めは `'2.1.292'`、Task 15 で見本と揃える）。
- Produces: `CompatLog`（`new CompatLog({ file: string | null; localVersion: () => string | null; now?: () => number; max?: number })`、`note(d)`、`list(): CompatDriftDto[]`、`count(): number`、`flush(): void`、`start(intervalMs?)`、`stop(flush?)`）、`compatPath(home: string): string`、`COMPAT_MAX_ENTRIES = 100`、`COMPAT_FLUSH_MS = 5000`（`compat/log.ts`）。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/provider/claude-code/compat/log.test.ts` を作る。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompatLog, compatPath } from './log.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-compat-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('CompatLog', () => {
  it('同じ契約と値は 1 件にまとめ、回数、最初と最後の時刻、最後の版を持つ', () => {
    let t = 10;
    const log = new CompatLog({ file: null, localVersion: () => '2.1.292', now: () => t });
    log.note({ contract: 'registry', value: 'status=thinking', version: '2.1.300' });
    t = 20;
    log.note({ contract: 'registry', value: 'status=thinking', version: '2.1.301' });
    log.note({ contract: 'transcript', value: 'type=x', version: '2.1.301' });
    expect(log.count()).toBe(2);
    expect(log.list()).toEqual([
      { contract: 'registry', value: 'status=thinking', version: '2.1.301', count: 2, firstSeenAt: 10, lastSeenAt: 20 },
      { contract: 'transcript', value: 'type=x', version: '2.1.301', count: 1, firstSeenAt: 20, lastSeenAt: 20 },
    ]);
  });
  it('版の無いずれには手元の版を入れ、手元も分からなければ前の版を残す', () => {
    let local: string | null = '2.1.292';
    const log = new CompatLog({ file: null, localVersion: () => local, now: () => 1 });
    log.note({ contract: 'cli', value: 'help.commands=(missing)', version: null });
    expect(log.list()[0]!.version).toBe('2.1.292');
    local = null;
    log.note({ contract: 'cli', value: 'help.commands=(missing)', version: null });
    expect(log.list()[0]).toMatchObject({ version: '2.1.292', count: 2 });
    log.note({ contract: 'screen', value: 'prompt-marker=(missing)', version: null });
    expect(log.list().find((e) => e.contract === 'screen')!.version).toBeNull();
  });
  it('上限を超えたら、最後に見た時刻の古いものから落とす', () => {
    let t = 0;
    const log = new CompatLog({ file: null, localVersion: () => null, now: () => t, max: 3 });
    for (const v of ['a', 'b', 'c']) { t += 1; log.note({ contract: 'transcript', value: `type=${v}`, version: null }); }
    t += 1; log.note({ contract: 'transcript', value: 'type=a', version: null });
    t += 1; log.note({ contract: 'transcript', value: 'type=d', version: null });
    expect(log.list().map((e) => e.value).sort()).toEqual(['type=a', 'type=c', 'type=d']);
  });
  it('書き出して読み直すと同じ一覧になり、変わっていなければ書かない', () => {
    const file = compatPath(tmp);
    expect(file).toBe(path.join(tmp, 'compat.json'));
    const log = new CompatLog({ file, localVersion: () => '2.1.292', now: () => 5 });
    log.note({ contract: 'statusline', value: 'rate_limits.five_hour.resets_at=ms', version: '2.1.300' });
    log.flush();
    expect(new CompatLog({ file, localVersion: () => null }).list()).toEqual(log.list());
    fs.rmSync(file);
    log.flush();
    expect(fs.existsSync(file)).toBe(false);
  });
  it('壊れたファイルと形の違う項目は捨てて始め、投げない', () => {
    const file = compatPath(tmp);
    fs.writeFileSync(file, '{ broken');
    expect(new CompatLog({ file, localVersion: () => null }).count()).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ contract: 'nope', value: 'x' }, { contract: 'cli', value: 'subcommand.added=x', version: null, count: 1, firstSeenAt: 1, lastSeenAt: 1 }] }));
    expect(new CompatLog({ file, localVersion: () => null }).list().map((e) => e.value)).toEqual(['subcommand.added=x']);
  });
  it('書けない置き場でも投げない', () => {
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x');
    const log = new CompatLog({ file: path.join(tmp, 'blocker', 'compat.json'), localVersion: () => null });
    log.note({ contract: 'cli', value: 'auth-status=(not-json)', version: null });
    expect(() => log.flush()).not.toThrow();
    expect(() => log.stop()).not.toThrow();
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/log.test.ts`
Expected: FAIL。`./log.ts` が無い。

- [ ] **Step 3: `compat/types.ts` と `compat/version.ts` を作る**

`packages/server/src/provider/claude-code/compat/types.ts`

```ts
import type { CompatContract } from '@agent-hangar/shared';

/**
 * ずれの 1 回分。value は「どこが、どう違ったか」（type=foo、status=(missing) など）。
 * version は値を読んだ元に載っていた claude の版で、無ければ null（記録の側で手元の版を入れる）。
 */
export type Drift = { contract: CompatContract; value: string; version: string | null };
/** ずれを受け取る口。CompatLog が実物で、試験は配列に積むだけのものを渡す。 */
export type CompatSink = { note(d: Drift): void };
/** 何もしない口。渡されなかったときの既定である。 */
export const NO_COMPAT: CompatSink = { note: () => {} };

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 記録に載っている claude の版。無いか空なら null。 */
export function versionOfRecord(raw: unknown): string | null {
  return isRec(raw) && typeof raw.version === 'string' && raw.version !== '' ? raw.version : null;
}
```

`packages/server/src/provider/claude-code/compat/version.ts`

```ts
/**
 * 確かめた版。packages/server/test/fixtures/claude/ の見本のうち最も新しい版である。
 * 見本を足したら、ここと README を揃える（見本の試験が突き合わせる）。
 */
export const VERIFIED_CLAUDE_VERSION = '2.1.292';
```

- [ ] **Step 4: `compat/log.ts` を作る**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { COMPAT_CONTRACTS, type CompatContract, type CompatDriftDto } from '@agent-hangar/shared';
import { isRec, type CompatSink, type Drift } from './types.ts';

/** 残す件数の上限。超えたら、最後に見た時刻の古いものから落とす。 */
export const COMPAT_MAX_ENTRIES = 100;
/** 書き出しの間隔。登録は 500 ミリ秒ごとに読み直すので、ずれを受け取るたびには書かない。 */
export const COMPAT_FLUSH_MS = 5_000;
const FILE_VERSION = 1;

/** ずれの記録の置き場。端末ごとのもので、同期しない。 */
export function compatPath(home: string): string {
  return path.join(home, 'compat.json');
}

function isEntry(v: unknown): v is CompatDriftDto {
  return isRec(v) && typeof v.contract === 'string' && COMPAT_CONTRACTS.includes(v.contract as CompatContract)
    && typeof v.value === 'string' && (v.version === null || typeof v.version === 'string')
    && typeof v.count === 'number' && typeof v.firstSeenAt === 'number' && typeof v.lastSeenAt === 'number';
}

/**
 * Claude Code の形式のずれの記録。~/.agent-hangar/compat.json に置く。
 * DB のマイグレーションを要らない形にするためにファイルにした。
 * 同じ契約と値の組は 1 件にまとめて回数を数え、版は最後に見たときのものを持つ。
 * 書き出しは start() の周期と stop() で行う。読めないファイルは空として始め、次の書き出しで置き換える。
 */
export class CompatLog implements CompatSink {
  private readonly entries = new Map<string, CompatDriftDto>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly max: number;

  constructor(private readonly o: { file: string | null; localVersion: () => string | null; now?: () => number; max?: number }) {
    this.now = o.now ?? (() => Date.now());
    this.max = o.max ?? COMPAT_MAX_ENTRIES;
    this.load();
  }

  private key(contract: string, value: string): string {
    return `${contract}\0${value}`;
  }

  private load(): void {
    if (!this.o.file) return;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.o.file, 'utf8')); } catch { return; }
    const list = isRec(raw) && Array.isArray(raw.entries) ? raw.entries.filter(isEntry) : [];
    for (const e of list) this.entries.set(this.key(e.contract, e.value), { ...e });
    this.trim();
  }

  note(d: Drift): void {
    const at = this.now();
    const k = this.key(d.contract, d.value);
    const version = d.version ?? this.o.localVersion();
    const cur = this.entries.get(k);
    if (cur) {
      this.entries.set(k, { ...cur, count: cur.count + 1, lastSeenAt: at, version: version ?? cur.version });
    } else {
      this.entries.set(k, { contract: d.contract, value: d.value, version, count: 1, firstSeenAt: at, lastSeenAt: at });
      this.trim();
    }
    this.dirty = true;
  }

  /** 上限を超えた分を、最後に見た時刻の古いものから落とす。 */
  private trim(): void {
    while (this.entries.size > this.max) {
      let oldest: string | null = null;
      let at = Number.POSITIVE_INFINITY;
      for (const [k, e] of this.entries) if (e.lastSeenAt < at) { at = e.lastSeenAt; oldest = k; }
      if (oldest === null) return;
      this.entries.delete(oldest);
    }
  }

  /** 最後に見た時刻の新しい順。同じ時刻は契約と値の順にする。 */
  list(): CompatDriftDto[] {
    return [...this.entries.values()].map((e) => ({ ...e })).sort((a, b) =>
      b.lastSeenAt - a.lastSeenAt || (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  }

  count(): number {
    return this.entries.size;
  }

  /** 変わっていれば書き出す。一時ファイルに書いてから置き換えるので、途中で切れても半端は残らない。書けなくても投げない。 */
  flush(): void {
    if (!this.dirty || !this.o.file) return;
    const tmp = `${this.o.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries: this.list() }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.o.file);
      this.dirty = false;
    } catch (e) {
      console.error('[compat] ずれの記録を書けませんでした', e instanceof Error ? e.message : e);
    }
  }

  start(intervalMs: number = COMPAT_FLUSH_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  stop(flush = true): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (flush) this.flush();
  }
}
```

- [ ] **Step 5: 通るのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/log.test.ts`
Expected: PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/types.ts packages/server/src/provider/claude-code/compat/version.ts packages/server/src/provider/claude-code/compat/log.ts packages/server/src/provider/claude-code/compat/log.test.ts
git commit -m "feat(server): record Claude Code format drifts in compat.json

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: トランスクリプトの契約

**Files:**
- Create: `packages/server/src/provider/claude-code/compat/transcript.ts`
- Test: `packages/server/src/provider/claude-code/compat/transcript.test.ts`
- Modify: `packages/server/src/indexer/indexFile.ts:23`（`IndexFileOptions`）、`:126-127`、`:170-171`
- Modify: `packages/server/src/indexer/service.ts:19-31`、`:129`
- Test: `packages/server/src/indexer/indexFile.test.ts`（末尾に describe を足す）

**Interfaces:**
- Consumes: `Drift`、`CompatSink`、`isRec`、`versionOfRecord`（Task 3）、`compareClaudeVersions`（Task 2）。
- Produces: `transcriptDrifts(raw: unknown): Drift[]`、`TranscriptCompat = { sink: CompatSink; since: () => string }`、`transcriptWatcher(c: TranscriptCompat): (raw: unknown) => void`、`KNOWN_LINE_TYPES`、`KNOWN_META_TYPES`、`KNOWN_SYSTEM_SUBTYPES`、`KNOWN_USER_BLOCKS`、`KNOWN_ASSISTANT_BLOCKS`（どれも `ReadonlySet<string>`）、`READ_ATTACHMENT_TYPE`。
- Produces: `IndexFileOptions.compat?: TranscriptCompat`、`IndexerServiceOptions.compat?: TranscriptCompat`。Task 12 がサーバで渡す。

- [ ] **Step 1: 契約の落ちる試験を書く**

`packages/server/src/provider/claude-code/compat/transcript.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import { transcriptDrifts, transcriptWatcher } from './transcript.ts';
import type { Drift } from './types.ts';

const t = (value: string): Drift => ({ contract: 'transcript', value, version: null });

describe('transcriptDrifts', () => {
  it('知っている行はずれを出さない', () => {
    for (const r of [
      { type: 'user', message: { role: 'user', content: 'こんにちは' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'document' }, { type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
      { type: 'system', subtype: 'turn_duration' },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'x', commandMode: 'prompt' } },
      { type: 'ai-title', aiTitle: 'x' },
      { type: 'summary', summary: 'x' },
    ]) expect(transcriptDrifts(r), JSON.stringify(r)).toEqual([]);
    expect(transcriptDrifts('x')).toEqual([]);
    expect(transcriptDrifts(null)).toEqual([]);
  });
  it('知らない行の種類と system の種類を返す。添付は、知らない種類が文字の prompt を持つときだけ返す。無いものは (missing) と書く', () => {
    expect(transcriptDrifts({ type: 'brand-new' })).toEqual([t('type=brand-new')]);
    expect(transcriptDrifts({ sessionId: 'x' })).toEqual([t('type=(missing)')]);
    expect(transcriptDrifts({ type: 'system', subtype: 'turn_end' })).toEqual([t('system.subtype=turn_end')]);
    expect(transcriptDrifts({ type: 'system' })).toEqual([t('system.subtype=(missing)')]);
    expect(transcriptDrifts({ type: 'attachment', attachment: { type: 'brand_new' } })).toEqual([]);
    expect(transcriptDrifts({ type: 'attachment', attachment: { type: 'queued_prompt', prompt: 'x' } })).toEqual([t('attachment.type=queued_prompt')]);
    expect(transcriptDrifts({ type: 'attachment' })).toEqual([t('attachment.type=(missing)')]);
  });
  it('知らない本文の塊は、種類ごとに 1 つだけ返す', () => {
    expect(transcriptDrifts({ type: 'assistant', message: { content: [{ type: 'server_tool_use' }, { type: 'server_tool_use' }, { type: 'text', text: '' }, 'loose'] } })).toEqual([
      t('assistant.content=server_tool_use'),
      t('assistant.content=(missing)'),
    ]);
    expect(transcriptDrifts({ type: 'user', message: { content: [{ type: 'audio' }] } })).toEqual([t('user.content=audio')]);
  });
});

describe('transcriptWatcher', () => {
  it('since より古い版の行と、版の分からない行は見ない。版の無い行は直前の行の版を継ぐ', () => {
    const seen: Drift[] = [];
    const watch = transcriptWatcher({ sink: { note: (d) => seen.push(d) }, since: () => '2.1.292' });
    watch({ type: 'old-meta' });
    watch({ type: 'user', message: { content: 'x' }, version: '2.1.100' });
    watch({ type: 'old-meta' });
    watch({ type: 'system', subtype: 'turn_end', version: '2.1.300' });
    watch({ type: 'new-meta' });
    watch({ type: 'system', subtype: 'turn_end2', version: '2.1.292' });
    expect(seen).toEqual([
      { contract: 'transcript', value: 'system.subtype=turn_end', version: '2.1.300' },
      { contract: 'transcript', value: 'type=new-meta', version: '2.1.300' },
      { contract: 'transcript', value: 'system.subtype=turn_end2', version: '2.1.292' },
    ]);
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/transcript.test.ts`
Expected: FAIL。`./transcript.ts` が無い。

- [ ] **Step 3: `compat/transcript.ts` を作る**

```ts
import { compareClaudeVersions } from '@agent-hangar/shared';
import { isRec, versionOfRecord, type CompatSink, type Drift } from './types.ts';

// 知っている値の集合。正規化（normalize.ts）が名前で読む値と、2.1.284 から 2.1.292 の実物の記録で見た値である。
// 集合に足すのは、その値を正規化でどう扱うか（読むか、meta として残すか、捨てるか）を決めたときだけにする。

/** 正規化が中身を読む行の種類。 */
export const KNOWN_LINE_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'attachment']);
/** 中身を読まずに meta として残すと決めた行の種類（「Claude Code Provider」の節）。summary は古い版の要約の行である。 */
export const KNOWN_META_TYPES: ReadonlySet<string> = new Set([
  'last-prompt', 'atis-latch', 'mode', 'permission-mode', 'ai-title', 'custom-title', 'agent-name', 'pr-link',
  'queue-operation', 'file-history-snapshot', 'file-history-delta', 'relocated', 'worktree-state', 'bridge-session',
  'cost-state', 'frame-link', 'started', 'history-suppression', 'failed', 'result', 'artifact-autoreact-ledger',
  'artifact-comment-monitor', 'fork-context-ref', 'continued-in', 'summary',
]);
/** system の行の種類。turn_duration はターンの終わりの印として読む（live/aside.ts）。 */
export const KNOWN_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'turn_duration', 'stop_hook_summary', 'away_summary', 'local_command', 'informational', 'compact_boundary',
  'scheduled_task_fire', 'bridge_status', 'model_refusal_fallback', 'agents_killed',
]);
/** user の本文の塊の種類。 */
export const KNOWN_USER_BLOCKS: ReadonlySet<string> = new Set(['text', 'image', 'document', 'tool_result']);
/** assistant の本文の塊の種類。redacted_thinking は捨てると決めた塊である。 */
export const KNOWN_ASSISTANT_BLOCKS: ReadonlySet<string> = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);
/**
 * 添付で中身を読むのは queued_command だけである。
 * 添付の種類は版ごとに増え（2.1.284 から 2.1.292 の記録で 50 種）、hangar はほかの種類を読まないので、知らない種類を全部ずれにすると、止めた機能の無いずれで記録が埋まる。
 * そこで、知らない種類は、queued_command と同じく文字の prompt を持つときだけずれにする。queued_command の改名を捕まえるためである。
 */
export const READ_ATTACHMENT_TYPE = 'queued_command';

const d = (value: string): Drift => ({ contract: 'transcript', value, version: null });

/**
 * 1 行の記録が、正規化の知っている形かを見て、知らないものを 1 つずつずれとして返す。
 * 振る舞いは変えない（知らない行は meta として残し、知らない塊は捨てる）。
 * 版は入れない。呼び手（transcriptWatcher）が、行の版か同じファイルの直前の行の版を入れる。
 */
export function transcriptDrifts(raw: unknown): Drift[] {
  if (!isRec(raw)) return [];
  const type = typeof raw.type === 'string' ? raw.type : null;
  if (type === null) return [d('type=(missing)')];
  if (!KNOWN_LINE_TYPES.has(type)) return KNOWN_META_TYPES.has(type) ? [] : [d(`type=${type}`)];
  if (type === 'system') {
    const s = typeof raw.subtype === 'string' ? raw.subtype : null;
    if (s === null) return [d('system.subtype=(missing)')];
    return KNOWN_SYSTEM_SUBTYPES.has(s) ? [] : [d(`system.subtype=${s}`)];
  }
  if (type === 'attachment') {
    const a = isRec(raw.attachment) ? raw.attachment : null;
    if (a === null || typeof a.type !== 'string') return [d('attachment.type=(missing)')];
    if (a.type === READ_ATTACHMENT_TYPE) return [];
    return typeof a.prompt === 'string' ? [d(`attachment.type=${a.type}`)] : [];
  }
  const content = isRec(raw.message) ? raw.message.content : undefined;
  if (!Array.isArray(content)) return [];
  const known = type === 'user' ? KNOWN_USER_BLOCKS : KNOWN_ASSISTANT_BLOCKS;
  const out: Drift[] = [];
  const seen = new Set<string>();
  for (const b of content) {
    const bt = isRec(b) && typeof b.type === 'string' ? b.type : '(missing)';
    if (known.has(bt) || seen.has(bt)) continue;
    seen.add(bt);
    out.push(d(`${type}.content=${bt}`));
  }
  return out;
}

/** 索引に渡す見張りの口。since() より古い版の行は昔の形として見ない。 */
export type TranscriptCompat = { sink: CompatSink; since: () => string };

/**
 * 1 つのファイルの行を順に見張る関数を返す。
 * 版の無い行（メタ行の多く）は、同じファイルの直前の行の版を使う。
 * 版が分からない行と since() より古い版の行は見ない。長い履歴を初めて索引にするときに、昔の形の行でずれが溢れないようにするためである。
 */
export function transcriptWatcher(c: TranscriptCompat): (raw: unknown) => void {
  let last: string | null = null;
  const since = c.since();
  return (raw) => {
    const v = versionOfRecord(raw) ?? last;
    last = v;
    if (v === null || compareClaudeVersions(v, since) < 0) return;
    for (const x of transcriptDrifts(raw)) c.sink.note({ ...x, version: v });
  };
}
```

- [ ] **Step 4: 契約の試験が通るのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/transcript.test.ts`
Expected: PASS。

- [ ] **Step 5: 索引の落ちる試験を書く**

`packages/server/src/indexer/indexFile.test.ts` の import を直す。

```ts
import { ensureSession, findSession, forgetTranscriptFile, indexFile, INDEXER_VERSION } from './indexFile.ts';
import type { Drift } from '../provider/claude-code/compat/types.ts';
```

（元の行 `import { findSession, forgetTranscriptFile, indexFile, INDEXER_VERSION } from './indexFile.ts';` を上の 1 行目に置き換え、2 行目を足す。）

ファイルの末尾に足す。

```ts
describe('Claude Code との互換の見張り', () => {
  const NEW = 'bbbbbbbb-0000-4000-8000-0000000000c1';
  const lines = (uuid: string) => [
    { type: 'user', message: { role: 'user', content: '古い版の発言' }, uuid: 'c1', timestamp: '2026-10-01T00:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: uuid, version: '2.1.100' },
    { type: 'old-meta', sessionId: uuid },
    { type: 'system', subtype: 'turn_end', content: '', timestamp: '2026-10-01T00:00:01.000Z', sessionId: uuid, version: '2.1.300' },
    { type: 'new-meta', sessionId: uuid },
  ];
  it('手元の本文の行を見張り、版を添えてずれを渡す。索引の中身は変えない', () => {
    const p = path.join(dir, 'projects', '-Users-me-workspace-alpha', `${NEW}.jsonl`);
    appendJson(p, ...lines(NEW));
    const seen: Drift[] = [];
    indexFile(db, { path: p, sessionId: NEW, agentId: null, deviceId: null }, { deviceId: DEV, compat: { sink: { note: (d) => seen.push(d) }, since: () => '2.1.292' } });
    expect(seen).toEqual([
      { contract: 'transcript', value: 'system.subtype=turn_end', version: '2.1.300' },
      { contract: 'transcript', value: 'type=new-meta', version: '2.1.300' },
    ]);
    const sid = findSession(db, NEW)!;
    expect((db.prepare('select kind from event_index where session_id = ? order by seq').all(sid) as { kind: string }[]).map((r) => r.kind)).toEqual(['user', 'meta', 'system', 'meta']);
  });
  it('他端末から降ろした写しは見張らない', () => {
    const p = path.join(dir, 'remote-copy.jsonl');
    appendJson(p, ...lines(NEW));
    ensureSession(db, NEW, '/Users/me/workspace/alpha', DEV);
    const seen: Drift[] = [];
    indexFile(db, { path: p, sessionId: NEW, agentId: null, deviceId: 'other' }, { deviceId: DEV, remote: true, compat: { sink: { note: (d) => seen.push(d) }, since: () => '2.1.292' } });
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 6: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/indexer/indexFile.test.ts`
Expected: FAIL。1 つ目の it で `seen` が空のまま（`compat` を読んでいない）。型の誤りでも落ちる。

- [ ] **Step 7: 索引で見張る**

`packages/server/src/indexer/indexFile.ts` の import に足す。

```ts
import { transcriptWatcher, type TranscriptCompat } from '../provider/claude-code/compat/transcript.ts';
```

`IndexFileOptions` の行を置き換える。

```ts
/**
 * remote が true なら他端末から降ろした写しである。sessions と session_summaries には書かない。
 * compat を渡すと、手元の本文の行を Claude Code との互換の契約で見張る（他端末の写しは見ない）。
 */
export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string; remote?: boolean; processStartOf?: ProcessStartOf; compat?: TranscriptCompat };
```

（元の 2 行、`/** remote が true なら…書かない。 */` と `export type IndexFileOptions = …;` を置き換える。）

`const mainLocal = file.agentId === null && !remote;` の直後に足す。

```ts
  // 形式のずれの見張り。手元の本文だけを見る。他端末の写しは、その端末の claude の版で書かれている。
  const watch = opts.compat && !remote ? transcriptWatcher(opts.compat) : null;
```

`parsed.forEach((p, i) => {` の直後の行（`const events = normalizeRecord(p.rec, seq, file.agentId);`）の前に足す。

```ts
      watch?.(p.rec);
```

`packages/server/src/indexer/service.ts` の import に足す。

```ts
import type { TranscriptCompat } from '../provider/claude-code/compat/transcript.ts';
```

`IndexerServiceOptions` の `processStartOf?: ProcessStartOf;` の後に足す。

```ts
  /** 手元の本文の行を Claude Code との互換の契約で見張る口。渡さなければ見張らない。 */
  compat?: TranscriptCompat;
```

`indexOne` の `indexFile(...)` の呼び出しを置き換える。

```ts
      const r = indexFile(this.opts.db, file, { deviceId: this.opts.deviceId, cwdFallback: history.get(file.sessionId)?.cwd, remote: file.deviceId !== null, processStartOf: this.opts.processStartOf, compat: this.opts.compat });
```

- [ ] **Step 8: 通るのを確かめる**

Run: `npx vitest run packages/server/src/indexer/indexFile.test.ts packages/server/src/indexer/service.test.ts packages/server/src/provider/claude-code/compat/transcript.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 9: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/transcript.ts packages/server/src/provider/claude-code/compat/transcript.test.ts packages/server/src/indexer/indexFile.ts packages/server/src/indexer/indexFile.test.ts packages/server/src/indexer/service.ts
git commit -m "feat(server): watch transcript lines against the known Claude Code formats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: レジストリの契約

**Files:**
- Create: `packages/server/src/provider/claude-code/compat/registry.ts`
- Test: `packages/server/src/provider/claude-code/compat/registry.test.ts`
- Modify: `packages/server/src/provider/claude-code/registry.ts:1-80`
- Test: `packages/server/src/provider/claude-code/registry.test.ts`

**Interfaces:**
- Consumes: `Drift`、`CompatSink`、`NO_COMPAT`、`isRec`、`versionOfRecord`（Task 3）。
- Produces: `registryDrifts(rec: unknown): Drift[]`、`KNOWN_REGISTRY_STATUSES: ReadonlySet<string>`（`compat/registry.ts`）。
- Produces: `readRegistry(claudeDir, isGone?, onDrift?: (d: Drift) => void): LiveSession[]`、`new RegistryWatcher(claudeDir, intervalMs?, isGone?, enrich?, compat?: CompatSink)`。Task 12 が `compat` を渡す。

- [ ] **Step 1: 契約の落ちる試験を書く**

`packages/server/src/provider/claude-code/compat/registry.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import { registryDrifts } from './registry.ts';

describe('registryDrifts', () => {
  it('知っている status と、sessionId と pid があればずれは無い', () => {
    for (const status of ['busy', 'idle', 'waiting', 'shell']) expect(registryDrifts({ pid: 1, sessionId: 's', status, version: '2.1.292' })).toEqual([]);
  });
  it('知らない status、無い項目を、登録の版を添えて返す', () => {
    expect(registryDrifts({ pid: 1, sessionId: 's', status: 'thinking', version: '2.1.300' })).toEqual([{ contract: 'registry', value: 'status=thinking', version: '2.1.300' }]);
    expect(registryDrifts({ version: '2.1.300' })).toEqual([
      { contract: 'registry', value: 'sessionId=(missing)', version: '2.1.300' },
      { contract: 'registry', value: 'pid=(missing)', version: '2.1.300' },
      { contract: 'registry', value: 'status=(missing)', version: '2.1.300' },
    ]);
  });
  it('オブジェクトでない登録は 1 件のずれにする', () => {
    expect(registryDrifts([])).toEqual([{ contract: 'registry', value: 'entry=(not-object)', version: null }]);
    expect(registryDrifts(null)).toEqual([{ contract: 'registry', value: 'entry=(not-object)', version: null }]);
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/registry.test.ts`
Expected: FAIL。`./registry.ts` が無い。

- [ ] **Step 3: `compat/registry.ts` を作る**

```ts
import { isRec, versionOfRecord, type Drift } from './types.ts';

/** ~/.claude/sessions/<pid>.json の status として知っている値。shell は本体が休みで裏の Bash だけが動いていること。 */
export const KNOWN_REGISTRY_STATUSES: ReadonlySet<string> = new Set(['busy', 'idle', 'waiting', 'shell']);

/**
 * 1 件の登録が、hangar の読む形かを見る。
 * 知らない status は、読む側（readRegistry）が作業中として扱う。休んでいるセッションを止める機能があるので、誤って止めるより待たせるほうが害が小さい。
 */
export function registryDrifts(rec: unknown): Drift[] {
  if (!isRec(rec)) return [{ contract: 'registry', value: 'entry=(not-object)', version: null }];
  const version = versionOfRecord(rec);
  const out: Drift[] = [];
  const d = (value: string) => out.push({ contract: 'registry', value, version });
  if (typeof rec.sessionId !== 'string' || rec.sessionId === '') d('sessionId=(missing)');
  if (typeof rec.pid !== 'number') d('pid=(missing)');
  if (typeof rec.status !== 'string') d('status=(missing)');
  else if (!KNOWN_REGISTRY_STATUSES.has(rec.status)) d(`status=${rec.status}`);
  return out;
}
```

- [ ] **Step 4: 読み取りと見張りの落ちる試験を書く**

`packages/server/src/provider/claude-code/registry.test.ts` の import に足す。

```ts
import type { Drift } from './compat/types.ts';
```

`describe('readRegistry', …)` の中の「ディレクトリが無ければ空」の it の後に足す。

```ts
  it('配列や null の登録は読まずにずれとして知らせ、ほかの登録は読み続ける', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.writeFileSync(path.join(sessions, '7.json'), '[]');
      fs.writeFileSync(path.join(sessions, '8.json'), 'null');
      const seen: Drift[] = [];
      expect(readRegistry(dir, ALL_ALIVE, (d) => seen.push(d)).map((l) => l.sessionId)).toEqual([SESSION_ALPHA]);
      expect(seen).toEqual([
        { contract: 'registry', value: 'entry=(not-object)', version: null },
        { contract: 'registry', value: 'entry=(not-object)', version: null },
      ]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('知らない status は作業中として読み、登録の版を添えてずれとして知らせる', () => {
    const dir = copyFixtureClaudeDir();
    try {
      const sessions = path.join(dir, 'sessions');
      fs.rmSync(path.join(sessions, '12345.json'));
      fs.writeFileSync(path.join(sessions, '7.json'), JSON.stringify({ pid: 7, sessionId: 'u-new', cwd: '/x', status: 'thinking', version: '2.1.300' }));
      const seen: Drift[] = [];
      expect(readRegistry(dir, ALL_ALIVE, (d) => seen.push(d))).toEqual([{ sessionId: 'u-new', status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 7 }]);
      expect(seen).toEqual([{ contract: 'registry', value: 'status=thinking', version: '2.1.300' }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
```

`describe('RegistryWatcher', …)` の「変化したときだけ通知する」の it の後に足す。

```ts
  it('ずれは登録が変わったときだけ数え、同じ登録の読み直しでは数えない', () => {
    const file = path.join(dir, 'sessions/12345.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking' }));
    const seen: Drift[] = [];
    const w = new RegistryWatcher(dir, 500, ALL_ALIVE, undefined, { note: (d) => seen.push(d) });
    w.start();
    vi.advanceTimersByTime(1500);
    expect(seen.map((d) => d.value)).toEqual(['status=thinking']);
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'thinking', statusUpdatedAt: rec.statusUpdatedAt + 1 }));
    vi.advanceTimersByTime(500);
    expect(seen.map((d) => d.value)).toEqual(['status=thinking', 'status=thinking']);
    w.stop();
  });
```

- [ ] **Step 5: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/registry.test.ts packages/server/src/provider/claude-code/compat/registry.test.ts`
Expected: FAIL。`null` の登録で `TypeError`（`rec.sessionId` を読む）、`seen` が空。

- [ ] **Step 6: 読み取りと見張りを直す**

`packages/server/src/provider/claude-code/registry.ts` の import に足す。

```ts
import { registryDrifts } from './compat/registry.ts';
import { isRec, NO_COMPAT, type CompatSink, type Drift } from './compat/types.ts';
```

`readRegistry` を doc コメントごと置き換える。

```ts
/**
 * ~/.claude/sessions/<pid>.json を読む。ファイルの出現と消失が起動と終了に対応する。
 * isGone が真を返す pid の項目は、消えたプロセスの残りとして読まない。hangar は ~/.claude のファイルを消さないので、読まないことで扱う。
 * onDrift を渡すと、形が契約と違う登録を知らせる（compat/registry.ts）。読み方はいまのまま変えない。
 * オブジェクトでない登録（配列や null）は読まない。1 件の形が崩れても、ほかのセッションの状態は出し続ける。
 */
export function readRegistry(claudeDir: string, isGone: (pid: number) => boolean = () => false, onDrift?: (d: Drift) => void): LiveSession[] {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let raw: unknown;
    // 書きかけの登録は JSON として読めない。これはずれではないので、黙って次の周期に回す。
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (onDrift) for (const d of registryDrifts(raw)) onDrift(d);
    if (!isRec(raw)) continue;
    const rec = raw;
    if (typeof rec.sessionId !== 'string') continue;
    if (typeof rec.pid === 'number' && isGone(rec.pid)) continue;
    // shell は、本体が休みで裏の Bash だけが動いていること。作業中のまま、裏だけの印を付ける（LiveAsideDto）。
    // 知らない値は作業中と読む。止めてよいかを誤るより、待たせるほうが害が小さい。
    const status = STATUSES.has(rec.status as LiveStatus) ? (rec.status as LiveStatus) : 'busy';
    const l: LiveSession = { sessionId: rec.sessionId, status, name: typeof rec.name === 'string' ? rec.name : null, nameSource: typeof rec.nameSource === 'string' ? rec.nameSource : null, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', pid: typeof rec.pid === 'number' ? rec.pid : 0 };
    if (rec.status === 'shell') l.aside = { shell: true, agents: 0 };
    if (typeof rec.statusUpdatedAt === 'number' && Number.isFinite(rec.statusUpdatedAt)) l.statusAt = rec.statusUpdatedAt;
    // jobId が無いと `claude attach` に渡すものが無いので、bg と書いてあってもバックグラウンドとは扱わない。
    if (rec.kind === 'bg' && typeof rec.jobId === 'string' && rec.jobId !== '') l.background = { jobId: rec.jobId };
    if (typeof rec.procStart === 'string' && rec.procStart !== '') l.procStart = rec.procStart;
    if (typeof rec.entrypoint === 'string' && rec.entrypoint !== '') l.entrypoint = rec.entrypoint;
    out.push(l);
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
```

`RegistryWatcher` の constructor を doc コメントごと置き換える。

```ts
  /**
   * enrich は、読んだ登録に裏だけの印などを足す関数（live/aside.ts）。読み直しのたびに通し、足した後の形で変化を見る。
   * 本文の索引が進んだだけでも印は変わるので、登録のファイルが変わらなくても次の周期で知らせられる。
   * compat は、形が契約と違う登録を受け取る口（provider/claude-code/compat/）。
   */
  constructor(private readonly claudeDir: string, private readonly intervalMs = 500, private readonly isGone: (pid: number) => boolean = goneOn(process.platform), private readonly enrich: (live: LiveSession[]) => LiveSession[] = (l) => l, private readonly compat: CompatSink = NO_COMPAT) {}
```

`poll` を doc コメントごと置き換える。

```ts
  /**
   * 登録ディレクトリを読み直し、変わっていたら知らせる。
   * 読み取りが失敗しても投げない。setInterval の中なので、投げるとプロセスごと落ちる。
   * 次の周期でやり直せばよい。
   * ずれは登録が変わったときだけ数える。500 ミリ秒ごとに同じ登録を読み直すたびに数えると、回数が意味を失う。
   */
  private poll(notify: boolean): void {
    let live: LiveSession[];
    const drifts: Drift[] = [];
    try { live = this.enrich(readRegistry(this.claudeDir, this.isGone, (d) => drifts.push(d))); } catch { return; }
    const key = JSON.stringify(live);
    if (key === this.lastKey) return;
    for (const d of drifts) this.compat.note(d);
    this.last = live; this.lastKey = key;
    if (notify) for (const cb of this.listeners) cb(live);
  }
```

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/registry.test.ts packages/server/src/provider/claude-code/compat/registry.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 8: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/registry.ts packages/server/src/provider/claude-code/compat/registry.test.ts packages/server/src/provider/claude-code/registry.ts packages/server/src/provider/claude-code/registry.test.ts
git commit -m "feat(server): watch the session registry against the known statuses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: statusline の契約と `resets_at` の単位

**Files:**
- Create: `packages/server/src/provider/claude-code/compat/statusline.ts`
- Test: `packages/server/src/provider/claude-code/compat/statusline.test.ts`
- Modify: `packages/server/src/usage/statusline.ts:1-2`、`:18-25`、`:66-78`、`:104-106`
- Test: `packages/server/src/usage/statusline.test.ts`

**Interfaces:**
- Consumes: `Drift`、`CompatSink`、`NO_COMPAT`、`isRec`、`versionOfRecord`（Task 3）。
- Produces: `RESETS_AT_MS_FLOOR = 1e11`、`resetsAtMs(v: number): number`、`statuslineDrifts(raw: unknown): Drift[]`（`compat/statusline.ts`）。
- Produces: `new UsageTracker(db, { now?, keep?, accountOf?, compat?: CompatSink })`。Task 12 が `compat` を渡す。

- [ ] **Step 1: 契約の落ちる試験を書く**

`packages/server/src/provider/claude-code/compat/statusline.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import { resetsAtMs, statuslineDrifts } from './statusline.ts';

const full = { session_id: 'u1', version: '2.1.300', model: { id: 'claude-haiku', display_name: 'Haiku' }, cost: { total_cost_usd: 0.01 }, context_window: { context_window_size: 200_000, current_usage: null }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 3, resets_at: 1_800_500_000 } } };
const s = (value: string) => ({ contract: 'statusline', value, version: '2.1.300' });

describe('resetsAtMs', () => {
  it('秒は 1000 倍し、ミリ秒と見られる値はそのまま使う', () => {
    expect(resetsAtMs(1_760_000_000)).toBe(1_760_000_000_000);
    expect(resetsAtMs(1_760_000_000_000)).toBe(1_760_000_000_000);
  });
});

describe('statuslineDrifts', () => {
  it('読む項目がそろっていればずれは無い。rate_limits が無い 1 回目と null も、ずれではない', () => {
    expect(statuslineDrifts(full)).toEqual([]);
    const { rate_limits: _r, ...first } = full;
    expect(statuslineDrifts(first)).toEqual([]);
    expect(statuslineDrifts({ ...full, rate_limits: null })).toEqual([]);
    expect(statuslineDrifts({ ...full, model: 'Haiku' })).toEqual([]);
    expect(statuslineDrifts('x')).toEqual([]);
  });
  it('欠けた項目を、JSON の版を添えて返す', () => {
    expect(statuslineDrifts({ version: '2.1.300' })).toEqual([
      s('session_id=(missing)'), s('model=(missing)'), s('context_window.context_window_size=(missing)'), s('cost.total_cost_usd=(missing)'),
    ]);
  });
  it('窓の中の欠けた項目と、ミリ秒に見える resets_at を返す', () => {
    expect(statuslineDrifts({ ...full, rate_limits: { five_hour: { resets_at: '2026-10-07T10:00:00Z' }, seven_day: { used_percentage: 3, resets_at: 1_800_500_000_000 } } })).toEqual([
      s('rate_limits.five_hour.used_percentage=(missing)'), s('rate_limits.five_hour.resets_at=(missing)'), s('rate_limits.seven_day.resets_at=ms'),
    ]);
    expect(statuslineDrifts({ ...full, rate_limits: 'x' })).toEqual([s('rate_limits=(missing)')]);
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/statusline.test.ts`
Expected: FAIL。`./statusline.ts` が無い。

- [ ] **Step 3: `compat/statusline.ts` を作る**

```ts
import { isRec, versionOfRecord, type Drift } from './types.ts';

/** これより大きい resets_at はミリ秒と見る。秒の UNIX 時刻が 10^11 に届くのは西暦 5138 年である。 */
export const RESETS_AT_MS_FLOOR = 1e11;

/** resets_at を epoch のミリ秒にする。秒なら 1000 倍し、ミリ秒と見られる値はそのまま使う。 */
export function resetsAtMs(v: number): number {
  return v > RESETS_AT_MS_FLOOR ? v : v * 1000;
}

/**
 * statusLine に渡る JSON が、hangar の読む項目を持っているかを見る。
 * rate_limits は起動直後の 1 回目と API キーで使うときには無いので、あるときだけ中を見る。
 * 欠けた項目は、読む側（usage/statusline.ts）がいまと同じく直前の値を保つ。
 */
export function statuslineDrifts(raw: unknown): Drift[] {
  if (!isRec(raw)) return [];
  const version = versionOfRecord(raw);
  const out: Drift[] = [];
  const d = (value: string) => out.push({ contract: 'statusline', value, version });
  if (typeof raw.session_id !== 'string' || raw.session_id === '') d('session_id=(missing)');
  const m = raw.model;
  if (!(typeof m === 'string' && m !== '') && !(isRec(m) && (typeof m.id === 'string' || typeof m.display_name === 'string'))) d('model=(missing)');
  if (!isRec(raw.context_window) || typeof raw.context_window.context_window_size !== 'number') d('context_window.context_window_size=(missing)');
  if (!isRec(raw.cost) || typeof raw.cost.total_cost_usd !== 'number') d('cost.total_cost_usd=(missing)');
  const rl = raw.rate_limits;
  if (rl !== undefined && rl !== null) {
    if (!isRec(rl)) d('rate_limits=(missing)');
    else for (const k of ['five_hour', 'seven_day']) {
      const w = rl[k];
      if (w === undefined || w === null) continue;
      if (!isRec(w)) { d(`rate_limits.${k}=(missing)`); continue; }
      if (typeof w.used_percentage !== 'number') d(`rate_limits.${k}.used_percentage=(missing)`);
      if (typeof w.resets_at !== 'number') d(`rate_limits.${k}.resets_at=(missing)`);
      else if (w.resets_at > RESETS_AT_MS_FLOOR) d(`rate_limits.${k}.resets_at=ms`);
    }
  }
  return out;
}
```

- [ ] **Step 4: 使用量の落ちる試験を書く**

`packages/server/src/usage/statusline.test.ts` の import に足す。

```ts
import type { Drift } from '../provider/claude-code/compat/types.ts';
```

`describe('UsageTracker', …)` の最初の it の前に足す。

```ts
  it('resets_at がミリ秒に見える値ならそのまま使い、ずれとして知らせる', () => {
    const db = openDb(':memory:');
    const seen: Drift[] = [];
    const tr = new UsageTracker(db, { now: () => 1_000, compat: { note: (d) => seen.push(d) } });
    const r = tr.ingest({ ...second, version: '2.1.300', rate_limits: { five_hour: { used_percentage: 47, resets_at: 1_760_000_000_000 }, seven_day: { used_percentage: 7, resets_at: 1_760_500_000 } } })!;
    expect(r.usage.fiveHour).toEqual({ usedPercent: 47, resetsAt: 1_760_000_000_000 });
    expect(r.usage.sevenDay).toEqual({ usedPercent: 7, resetsAt: 1_760_500_000_000 });
    expect(seen).toEqual([{ contract: 'statusline', value: 'rate_limits.five_hour.resets_at=ms', version: '2.1.300' }]);
  });
```

- [ ] **Step 5: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/usage/statusline.test.ts`
Expected: FAIL。`resetsAt` が `1_760_000_000_000_000`（1000 倍）になり、`seen` が空。

- [ ] **Step 6: 使用量で単位を扱い、ずれを渡す**

`packages/server/src/usage/statusline.ts` の import に足す。

```ts
import { resetsAtMs, statuslineDrifts } from '../provider/claude-code/compat/statusline.ts';
import { NO_COMPAT, type CompatSink } from '../provider/claude-code/compat/types.ts';
```

`window_` の最後の 2 行を置き換える。

```ts
  // resets_at は秒の UNIX 時刻。ミリ秒と見られる値は、秒に直さずにそのまま使う（provider/claude-code/compat/statusline.ts）。
  return { usedPercent: used, resetsAt: resets === null ? null : resetsAtMs(resets) };
```

`UsageTracker` の `private readonly accountOf: …;` の後に足す。

```ts
  private readonly compat: CompatSink;
```

constructor を置き換える。

```ts
  constructor(private readonly db: Db, opts: { now?: () => number; keep?: number; accountOf?: (providerSessionId: string | null) => string; compat?: CompatSink } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.keep = opts.keep ?? 500;
    this.accountOf = opts.accountOf ?? (() => PRIMARY_ACCOUNT_ID);
    this.compat = opts.compat ?? NO_COMPAT;
    this.restore();
  }
```

`ingest` の先頭の 2 行の後（`if (!p) return null;` の次）に足す。restore は昔の payload を読み直すだけなので、ずれは数えない。

```ts
    for (const d of statuslineDrifts(raw)) this.compat.note(d);
```

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run packages/server/src/usage/statusline.test.ts packages/server/src/provider/claude-code/compat/statusline.test.ts`
Expected: PASS（既存の秒の試験も 1000 倍のまま通る）。

- [ ] **Step 8: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/statusline.ts packages/server/src/provider/claude-code/compat/statusline.test.ts packages/server/src/usage/statusline.ts packages/server/src/usage/statusline.test.ts
git commit -m "feat(server): watch the statusline payload and accept resets_at in milliseconds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `~/.claude` の項目の契約

**Files:**
- Create: `packages/server/src/provider/claude-code/compat/claudeDir.ts`
- Test: `packages/server/src/provider/claude-code/compat/claudeDir.test.ts`

**Interfaces:**
- Consumes: `LINKED_ENTRIES`（`config/accountLinks.ts`）、`Drift`、`CompatSink`（Task 3）。
- Produces: `KNOWN_PER_ACCOUNT_ENTRIES: ReadonlySet<string>`、`claudeDirDrifts(dir: string): Drift[]`、`ClaudeDirWatch`（`new ClaudeDirWatch({ dirs: () => string[]; sink: CompatSink })`、`check(): void`）。Task 12 が 2 つ目以降のアカウントの置き場を渡す。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/provider/claude-code/compat/claudeDir.test.ts` を作る。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../../../test/platform.ts';
import { ClaudeDirWatch, claudeDirDrifts } from './claudeDir.ts';
import type { Drift } from './types.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cdir-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const entry = (name: string): Drift => ({ contract: 'claude-dir', value: `entry=${name}`, version: null });

describe('claudeDirDrifts', () => {
  // 共有のリンクは symlink で張る。Windows は権限が要るので、リンクを含む試験は飛ばす。
  posixIt('リンクでも、アカウントごとに持つと知っている項目でもないものだけを、名前の順に返す', () => {
    const primary = path.join(tmp, 'primary');
    const dir = path.join(tmp, 'second');
    fs.mkdirSync(primary);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(primary, 'settings.json'), '{}');
    fs.symlinkSync(path.join(primary, 'settings.json'), path.join(dir, 'settings.json'));
    fs.writeFileSync(path.join(dir, '.claude.json'), '{}');
    fs.mkdirSync(path.join(dir, 'cache'));
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    // 共有のはずの名前が実体なのは、リンクの問題として別に出す（config/accountLinks.ts の linkProblem）。ここでは数えない。
    fs.mkdirSync(path.join(dir, 'skills'));
    fs.mkdirSync(path.join(dir, 'zeta-new'));
    fs.writeFileSync(path.join(dir, 'alpha-new.json'), '{}');
    expect(claudeDirDrifts(dir)).toEqual([entry('alpha-new.json'), entry('zeta-new')]);
  });
  it('読めない置き場は空', () => {
    expect(claudeDirDrifts(path.join(tmp, 'none'))).toEqual([]);
  });
});

describe('ClaudeDirWatch', () => {
  it('同じ名前はサーバの寿命で 1 度だけ知らせる', () => {
    const dir = path.join(tmp, 'second');
    fs.mkdirSync(path.join(dir, 'brand-new'), { recursive: true });
    const seen: Drift[] = [];
    const w = new ClaudeDirWatch({ dirs: () => [dir], sink: { note: (d) => seen.push(d) } });
    w.check();
    w.check();
    expect(seen).toEqual([entry('brand-new')]);
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/claudeDir.test.ts`
Expected: FAIL。`./claudeDir.ts` が無い。

- [ ] **Step 3: `compat/claudeDir.ts` を作る**

```ts
import fs from 'node:fs';
import { LINKED_ENTRIES } from '../../../config/accountLinks.ts';
import type { CompatSink, Drift } from './types.ts';

/**
 * アカウントごとに持つと決めた直下の項目。
 * 認証、組織から配られる設定、キャッシュ、常駐のサービスの状態と、古い版が作った置き場である
 * （docs/superpowers/specs/2026-10-06-account-switch-design.md と、その後に実物の置き場で見たもの）。
 */
export const KNOWN_PER_ACCOUNT_ENTRIES: ReadonlySet<string> = new Set([
  '.claude.json', '.credentials.json', '.last-cleanup', '.last-update-result.json', 'backups', 'cache', 'daemon', 'daemon.log',
  'downloads', 'ide', 'policy-limits.json', 'policy-limits.json.stamp.json', 'remote-settings.json', 'statsig', 'telemetry', 'todos',
]);
/** Claude Code が作るものではないので見ない名前。 */
const IGNORED: ReadonlySet<string> = new Set(['.DS_Store']);

/**
 * 2 つ目以降のアカウントの置き場の直下に、共有のリンクでも、アカウントごとに持つと知っている項目でもないものがあれば、ずれとして返す。
 * Claude Code が新しい項目を足すと、リンクの一覧（LINKED_ENTRIES）に無いので、アカウントごとの実体になる。これがアカウントを切り替えると共有されない項目である。
 * 振る舞いは変えない（アカウントごとのままにする）。
 * 最初の置き場（~/.claude）は見ない。利用者が自分で置いたファイル（dotfiles の git など）と見分けられないためである。
 */
export function claudeDirDrifts(dir: string): Drift[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => !e.isSymbolicLink() && !LINKED_ENTRIES.includes(e.name) && !KNOWN_PER_ACCOUNT_ENTRIES.has(e.name) && !IGNORED.has(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ contract: 'claude-dir' as const, value: `entry=${name}`, version: null }));
}

/**
 * 置き場の見張り。起動のときと、確認リストを開いたときに check() を呼ぶ。
 * 同じ名前はサーバの寿命で 1 度だけ数える。画面を開くたびに読み直すので、回数は意味を持たない。
 */
export class ClaudeDirWatch {
  private readonly seen = new Set<string>();
  constructor(private readonly o: { dirs: () => string[]; sink: CompatSink }) {}

  check(): void {
    for (const dir of this.o.dirs()) {
      for (const d of claudeDirDrifts(dir)) {
        if (this.seen.has(d.value)) continue;
        this.seen.add(d.value);
        this.o.sink.note(d);
      }
    }
  }
}
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/claudeDir.test.ts`
Expected: PASS。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/claudeDir.ts packages/server/src/provider/claude-code/compat/claudeDir.test.ts
git commit -m "feat(server): watch secondary account dirs for unknown Claude Code entries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: CLI の契約 1（`--help` とシェルの包みのサブコマンド）

**Files:**
- Create: `packages/server/src/provider/claude-code/compat/cli.ts`
- Test: `packages/server/src/provider/claude-code/compat/cli.test.ts`
- Modify: `packages/server/src/config/shellHook.ts:1-3`、`:30-38`、`:85-91`
- Test: `packages/server/src/config/shellHook.test.ts`

**Interfaces:**
- Consumes: `Drift`（Task 3）、`needsShell`（`platform/exec.ts`）。
- Produces: `BUILTIN_SUBCOMMANDS: readonly string[]`、`SUBCOMMAND_NAME: RegExp`、`ClaudeHelp = { subcommands: string[]; options: string[] }`、`parseHelp(text: string): ClaudeHelp | null`、`claudeVersionOf(out: string): string | null`、`subcommandsFromHelp(text: string | null): { subcommands: readonly string[]; drifts: Drift[] }`、`readClaudeHelp(bin: string, timeoutMs?: number): Promise<string | null>`。
- Produces: `ShellScriptOptions.subcommands?: readonly string[]`。Task 12 がサーバから渡し、Task 15 が見本の `help.txt` で確かめる。

- [ ] **Step 1: 契約の落ちる試験を書く**

`packages/server/src/provider/claude-code/compat/cli.test.ts` を作る。`HELP` は 2.1.292 の `claude --help` の抜き書きである。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeTool } from '../../../../test/fake-bin.ts';
import { posixIt } from '../../../../test/platform.ts';
import { BUILTIN_SUBCOMMANDS, claudeVersionOf, parseHelp, readClaudeHelp, subcommandsFromHelp } from './cli.ts';

const HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Claude Code - starts an interactive session by default, use -p/--print for',
  'non-interactive output',
  '',
  'Arguments:',
  '  prompt                                Your prompt',
  '',
  'Options:',
  '  --add-dir <directories...>            Additional directories to allow tool',
  '                                        access to',
  '  --allowedTools, --allowed-tools <tools...>',
  '      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)',
  '      Edit")',
  '  -c, --continue                        Continue the most recent conversation in',
  '  --cloud [description|session_id|url]  Create a cloud session with the given',
  '  -p, --print                           Print response and exit (useful for',
  '',
  'Commands:',
  '  agents [options]                      Manage background agents',
  '  attach <id|name>                      Open a background session in this',
  '                                        terminal. <id> is the short id that',
  '  plugin|plugins                        Manage Claude Code plugins',
  '  purge [options] [path]                Delete all Claude Code state for a',
  '  stop|kill <id>                        Stop a background session. Its',
  '  update|upgrade                        Check for updates and install if',
  '',
].join('\n');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('parseHelp', () => {
  it('Commands の節からサブコマンドを、Options の節から引数を読む。別名は両方を入れ、説明の続きの行は読まない', () => {
    expect(parseHelp(HELP)).toEqual({
      subcommands: ['agents', 'attach', 'kill', 'plugin', 'plugins', 'purge', 'stop', 'update', 'upgrade'],
      options: ['--add-dir', '--allowed-tools', '--allowedTools', '--cloud', '--continue', '--print', '-c', '-p'],
    });
  });
  it('Commands の節が無ければ null', () => {
    expect(parseHelp('Usage: claude\n\nOptions:\n  -p, --print  Print\n')).toBeNull();
    expect(parseHelp('')).toBeNull();
  });
  it('CRLF の改行でも読む', () => {
    expect(parseHelp(HELP.replace(/\n/g, '\r\n'))?.subcommands).toContain('purge');
  });
});

describe('claudeVersionOf', () => {
  it('claude --version の出力から版を取り出す', () => {
    expect(claudeVersionOf('2.1.292 (Claude Code)\n')).toBe('2.1.292');
    expect(claudeVersionOf('error')).toBeNull();
  });
});

describe('subcommandsFromHelp', () => {
  it('読めた一覧を使い、組み込みの一覧との差をずれとして返す', () => {
    const r = subcommandsFromHelp('Commands:\n  agents  x\n  newcmd  y\n');
    expect(r.subcommands).toEqual(['agents', 'newcmd']);
    expect(r.drifts).toContainEqual({ contract: 'cli', value: 'subcommand.added=newcmd', version: null });
    expect(r.drifts).toContainEqual({ contract: 'cli', value: 'subcommand.removed=purge', version: null });
    expect(r.drifts.some((d) => d.value === 'subcommand.removed=agents')).toBe(false);
  });
  it('出力が無ければ、ずれ無しで組み込みの一覧を使う', () => {
    expect(subcommandsFromHelp(null)).toEqual({ subcommands: BUILTIN_SUBCOMMANDS, drifts: [] });
    expect(subcommandsFromHelp('  ')).toEqual({ subcommands: BUILTIN_SUBCOMMANDS, drifts: [] });
  });
  it('Commands の節が無い出力は、組み込みの一覧を使い、ずれを 1 件だけ返す', () => {
    expect(subcommandsFromHelp('Usage: claude\nUnknown format\n')).toEqual({ subcommands: BUILTIN_SUBCOMMANDS, drifts: [{ contract: 'cli', value: 'help.commands=(missing)', version: null }] });
  });
  it('組み込みの一覧は 2.1.292 の Commands で、--help に無い daemon と project を持たない', () => {
    expect(BUILTIN_SUBCOMMANDS).toContain('purge');
    expect(BUILTIN_SUBCOMMANDS).not.toContain('daemon');
    expect(BUILTIN_SUBCOMMANDS).not.toContain('project');
  });
});

describe('readClaudeHelp', () => {
  // 偽の claude は sh で書く。Windows の .cmd では固まる claude を真似られないので飛ばす。
  posixIt('出力を返し、固まった claude は時間で切って null を返す。無い claude も null', async () => {
    const ok = writeFakeTool(path.join(tmp, 'ok'), 'claude', { sh: 'echo "Commands:"', cmd: 'echo Commands:' });
    expect(await readClaudeHelp(ok)).toBe('Commands:\n');
    // exec で sleep に入れ替える。sh の子に残すと、切った後も出力の管を握られて戻りが遅れる。
    const slow = writeFakeTool(path.join(tmp, 'slow'), 'claude', { sh: 'exec sleep 10', cmd: '' });
    const t0 = Date.now();
    expect(await readClaudeHelp(slow, 300)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await readClaudeHelp(path.join(tmp, 'missing'))).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/cli.test.ts`
Expected: FAIL。`./cli.ts` が無い。

- [ ] **Step 3: `compat/cli.ts` を作る**

```ts
import { execFile } from 'node:child_process';
import { needsShell } from '../../../platform/exec.ts';
import type { Drift } from './types.ts';

/**
 * --help を読めないときに使う、シェルの包みがそのまま渡すサブコマンド。2.1.292 の `claude --help` の Commands である。
 * 別名（plugin|plugins、stop|kill、update|upgrade）は両方を入れる。
 * 見本を足すときは、最も新しい見本の help.txt と揃える（見本の試験が突き合わせる）。
 */
export const BUILTIN_SUBCOMMANDS: readonly string[] = [
  'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'kill', 'logs', 'mcp',
  'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'ultrareview', 'update', 'upgrade',
];
/** サブコマンドの名前として受け付ける形。シェルの case に書くので、これ以外の文字は通さない。 */
export const SUBCOMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export type ClaudeHelp = { subcommands: string[]; options: string[] };

/**
 * claude --help の出力から、Commands の節のサブコマンドと、Options の節の引数を読む。どちらも並べ替えて返す。
 * 項目の行は 2 つの空白で始まる。説明の続きの行はもっと深く下がっているので読まない。
 * 項目の行の頭（2 つ以上の空白の手前まで）だけを見る。説明の中の語を拾わないためである。
 * Commands の節が無いか、サブコマンドが 1 つも読めなければ null を返す。
 */
export function parseHelp(text: string): ClaudeHelp | null {
  let section: 'options' | 'commands' | null = null;
  const subs = new Set<string>();
  const opts = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^Options:\s*$/.test(line)) { section = 'options'; continue; }
    if (/^Commands:\s*$/.test(line)) { section = 'commands'; continue; }
    if (/^\S/.test(line)) { section = null; continue; }
    const m = /^ {2}(\S.*)$/.exec(line);
    if (!m || section === null) continue;
    const head = m[1]!.split(/\s{2,}/)[0]!;
    if (section === 'commands') {
      for (const n of head.split(/\s/)[0]!.split('|')) if (SUBCOMMAND_NAME.test(n)) subs.add(n);
    } else {
      for (const t of head.matchAll(/(?:^|[\s,])(--?[A-Za-z][\w-]*)/g)) opts.add(t[1]!);
    }
  }
  if (subs.size === 0) return null;
  return { subcommands: [...subs].sort(), options: [...opts].sort() };
}

/** claude --version の出力（`2.1.292 (Claude Code)`）から版を取り出す。 */
export function claudeVersionOf(out: string): string | null {
  return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
}

const cliDrift = (value: string): Drift => ({ contract: 'cli', value, version: null });

/**
 * --help の出力から、シェルの包みに書くサブコマンドの一覧を作る。
 * 出力が無い（claude が無い、時間切れ）ときは、ずれ無しで組み込みの一覧を使う。
 * 出力はあるのに読めない（Commands の節が無い）ときは、組み込みの一覧を使い、ずれを 1 件返す。
 * 読めたときは、組み込みの一覧との差を 1 つずつずれとして返す。
 */
export function subcommandsFromHelp(text: string | null): { subcommands: readonly string[]; drifts: Drift[] } {
  if (text === null || text.trim() === '') return { subcommands: BUILTIN_SUBCOMMANDS, drifts: [] };
  const help = parseHelp(text);
  if (!help) return { subcommands: BUILTIN_SUBCOMMANDS, drifts: [cliDrift('help.commands=(missing)')] };
  const builtin = new Set(BUILTIN_SUBCOMMANDS);
  const got = new Set(help.subcommands);
  return {
    subcommands: help.subcommands,
    drifts: [
      ...help.subcommands.filter((s) => !builtin.has(s)).map((s) => cliDrift(`subcommand.added=${s}`)),
      ...BUILTIN_SUBCOMMANDS.filter((s) => !got.has(s)).map((s) => cliDrift(`subcommand.removed=${s}`)),
    ],
  };
}

/** claude --help を時間を区切って読む。起動できない、時間切れ、0 以外で終わったときは null。 */
export function readClaudeHelp(bin: string, timeoutMs = 5_000): Promise<string | null> {
  // .cmd と .bat は cmd.exe を通さないと起こせない。引数は固定の --help だけなので、引用の心配は無い。
  const viaShell = needsShell(bin);
  return new Promise((resolve) => {
    execFile(viaShell ? `"${bin}"` : bin, ['--help'], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, shell: viaShell, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}
```

- [ ] **Step 4: 契約の試験が通るのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/cli.test.ts`
Expected: PASS。

- [ ] **Step 5: シェルの包みの落ちる試験を書く**

`packages/server/src/config/shellHook.test.ts` の `runWrapped` の引数の型に `subcommands?: string[]` を足す。

```ts
function runWrapped(args: string, o: { hangar?: Hangar; tty?: boolean; tmux?: 'none' | 'set'; insideTmux?: 'hangar' | 'other'; noWrap?: boolean; subcommands?: string[] } = {}): { calls: string[]; body: { cwd: string; args: string[]; env: Record<string, string> } | null; stderr: string } {
```

`runWrapped` の中の `ensureShellScript(...)` の行を置き換える。

```ts
  ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile, tmuxPath: o.tmux === 'none' ? null : tmuxBin, subcommands: o.subcommands });
```

「サブコマンド、-p、-c、--help などは包まない」の it の配列に `'purge /tmp/x -y'` を足す。

```ts
    for (const a of ['mcp list', 'purge /tmp/x -y', '-p hello', '--model opus -p hello', '-c', '--version', '--bg', '--session-id x', '--append-system-prompt x']) {
```

`describe.skipIf(!ZSH)('包み方の本体（zsh 上）', …)` の中の末尾に足す。

```ts
  it('渡したサブコマンドの一覧だけを素通しにする', () => {
    expect(runWrapped('newcmd x', { subcommands: ['newcmd'] }).calls).toEqual(['claude newcmd x']);
    expect(runWrapped('mcp list', { subcommands: ['newcmd'] }).calls.map((c) => c.split(' ')[0])).toEqual(['curl', 'tmux']);
  });
```

ファイルの末尾に足す（zsh の無い OS でも走る）。

```ts
describe('包み方の本体のサブコマンドの一覧', () => {
  const caseLine = (home: string) => fs.readFileSync(shellScriptPath(home), 'utf8').split('\n').find((l) => l.endsWith(') command claude "$@"; return ;;'));
  it('渡さなければ組み込みの一覧を書く。daemon と project は書かない', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: null });
    expect(caseLine(home)).toBe('    agents|attach|auth|auto-mode|doctor|gateway|import|install|kill|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|ultrareview|update|upgrade) command claude "$@"; return ;;');
  });
  it('名前の形でないものは書かない。1 つも残らなければ組み込みの一覧を書く', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: null, subcommands: ['b-c', 'a', 'bad;touch x', 'A'] });
    expect(caseLine(home)).toBe('    b-c|a) command claude "$@"; return ;;');
    ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(dir, 'token'), tmuxPath: null, subcommands: ['$(x)'] });
    expect(caseLine(home)).toContain('    agents|attach|');
  });
});
```

- [ ] **Step 6: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/config/shellHook.test.ts`
Expected: FAIL。`purge /tmp/x -y` が hangar に頼まれる（`curl` が呼ばれる）。`subcommands` の型の誤りと、組み込みの一覧に `daemon` が残っていることでも落ちる。

- [ ] **Step 7: 包みの本体に一覧を書き込む**

`packages/server/src/config/shellHook.ts` の import に足す。

```ts
import { BUILTIN_SUBCOMMANDS, SUBCOMMAND_NAME } from '../provider/claude-code/compat/cli.ts';
```

`ShellScriptOptions` の `tmuxPath: string | null;` の後に足す。

```ts
  /** 包まずにそのまま渡すサブコマンド。サーバが起動のたびに claude --help から作る。渡さなければ組み込みの一覧。 */
  subcommands?: readonly string[];
```

`shellScript` の直前に足す。

```ts
/**
 * case に書くサブコマンドの並び。名前の形（SUBCOMMAND_NAME）に合わないものは書かない。シェルの文として読まれないようにするためである。
 * 1 つも残らなければ組み込みの一覧にする。
 */
function subcommandPattern(list: readonly string[] | undefined): string {
  const ok = (list ?? BUILTIN_SUBCOMMANDS).filter((s) => SUBCOMMAND_NAME.test(s));
  return (ok.length > 0 ? ok : BUILTIN_SUBCOMMANDS).join('|');
}
```

`shellScript` の本体の中の次の 4 行を置き換える。

置き換え前：

```
  # サブコマンドはそのまま渡す。
  case "$1" in
    agents|attach|auth|auto-mode|daemon|doctor|gateway|import|install|kill|logs|mcp|plugin|plugins|project|respawn|rm|setup-token|stop|ultrareview|update|upgrade) command claude "$@"; return ;;
  esac
```

置き換え後：

```
  # サブコマンドはそのまま渡す。一覧は hangar が起動のたびに claude --help から作る。
  case "$1" in
    ${subcommandPattern(o.subcommands)}) command claude "$@"; return ;;
  esac
```

- [ ] **Step 8: 通るのを確かめる**

Run: `npx vitest run packages/server/src/config/shellHook.test.ts packages/server/src/provider/claude-code/compat/cli.test.ts packages/cli/src/shell.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 9: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/cli.ts packages/server/src/provider/claude-code/compat/cli.test.ts packages/server/src/config/shellHook.ts packages/server/src/config/shellHook.test.ts
git commit -m "feat(server): build the shell wrapper's subcommand list from claude --help

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: CLI の契約 2（`auth status`、`agents`、`-p` の JSON）

**Files:**
- Modify: `packages/server/src/provider/claude-code/compat/cli.ts`（末尾に足す）
- Test: `packages/server/src/provider/claude-code/compat/cli.test.ts`（末尾に足す）
- Modify: `packages/server/src/config/accountAuth.ts:1-3`、`:57-63`、`:84-96`
- Test: `packages/server/src/config/accountAuth.test.ts`
- Modify: `packages/server/src/runs/procs.ts:1-44`
- Test: `packages/server/src/runs/procs.test.ts`
- Modify: `packages/server/src/runs/manager.ts:25`、`:59`、`:481-483`
- Modify: `packages/server/src/summary/claude.ts:1-3`、`:36`、`:65-66`
- Test: `packages/server/src/summary/claude.test.ts`

**Interfaces:**
- Consumes: `Drift`、`CompatSink`、`NO_COMPAT`、`isRec`（Task 3）。
- Produces: `authStatusDrifts(stdout: string): Drift[]`、`agentsJsonDrifts(stdout: string): Drift[]`、`printJsonDrifts(stdout: string): Drift[]`、`KNOWN_AGENT_KINDS`（`compat/cli.ts`）。
- Produces: `AccountAuth` の options に `compat?: CompatSink`、`realProcOpsWith(compat: CompatSink): ProcOps`（`realProcOps` は残す）、`RunManagerDeps.compat?: CompatSink`、`ClaudeHeadlessSummarizer` の options に `compat?: CompatSink`。Task 10 が `RunManagerDeps.compat` を使い、Task 12 が全部に渡す。

- [ ] **Step 1: 契約の落ちる試験を書く**

`packages/server/src/provider/claude-code/compat/cli.test.ts` の import を置き換える。

```ts
import { agentsJsonDrifts, authStatusDrifts, BUILTIN_SUBCOMMANDS, claudeVersionOf, parseHelp, printJsonDrifts, readClaudeHelp, subcommandsFromHelp } from './cli.ts';
```

ファイルの末尾に足す。

```ts
const c = (value: string) => ({ contract: 'cli', value, version: null });

describe('authStatusDrifts', () => {
  it('loggedIn があればずれは無い。出力が空なら見ない', () => {
    expect(authStatusDrifts('{"loggedIn":false}')).toEqual([]);
    expect(authStatusDrifts('')).toEqual([]);
  });
  it('JSON でない、オブジェクトでない、loggedIn が無い出力を返す', () => {
    expect(authStatusDrifts('Not logged in')).toEqual([c('auth-status=(not-json)')]);
    expect(authStatusDrifts('[]')).toEqual([c('auth-status=(not-object)')]);
    expect(authStatusDrifts('{"email":"x"}')).toEqual([c('auth-status.loggedIn=(missing)')]);
  });
});

describe('agentsJsonDrifts', () => {
  it('対話とバックグラウンドの行はずれを出さない。バックグラウンドの行だけ id と sessionId を見る', () => {
    expect(agentsJsonDrifts(JSON.stringify([{ kind: 'interactive', sessionId: 's1' }, { kind: 'background', id: 'b1', sessionId: 's2' }]))).toEqual([]);
    expect(agentsJsonDrifts('')).toEqual([]);
  });
  it('形の違いを種類ごとに 1 つだけ返す。知らない種類の行も、バックグラウンドと同じく id と sessionId を見る', () => {
    expect(agentsJsonDrifts('disabled')).toEqual([c('agents-json=(not-json)')]);
    expect(agentsJsonDrifts('{"sessions":[]}')).toEqual([c('agents-json=(not-array)')]);
    expect(agentsJsonDrifts(JSON.stringify([{ kind: 'remote' }, { kind: 'remote' }, { kind: 'background', sessionId: 's' }, 3]))).toEqual([
      c('agents-json.kind=remote'), c('agents-json.id=(missing)'), c('agents-json.sessionId=(missing)'), c('agents-json.row=(not-object)'),
    ]);
  });
});

describe('printJsonDrifts', () => {
  it('structured_output があればずれは無い', () => {
    expect(printJsonDrifts('{"type":"result","structured_output":{}}')).toEqual([]);
  });
  it('JSON でない、オブジェクトでない、structured_output が無い出力を返す', () => {
    expect(printJsonDrifts('oops')).toEqual([c('print-json=(not-json)')]);
    expect(printJsonDrifts('[]')).toEqual([c('print-json=(not-object)')]);
    expect(printJsonDrifts('{"type":"result"}')).toEqual([c('print-json.structured_output=(missing)')]);
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/cli.test.ts`
Expected: FAIL。`authStatusDrifts` などが export されていない。

- [ ] **Step 3: `compat/cli.ts` に足す**

import を置き換える。

```ts
import { execFile } from 'node:child_process';
import { needsShell } from '../../../platform/exec.ts';
import { isRec, type Drift } from './types.ts';
```

ファイルの末尾に足す。

```ts
/** JSON として読む。読めなければ undefined。 */
function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

/**
 * `claude auth status --json` の形。必ずある loggedIn だけを見る（未ログインと API キーでは、ほかの項目が無い）。
 * 出力が空なら見ない（claude を起こせなかったのは形のずれではない）。
 */
export function authStatusDrifts(stdout: string): Drift[] {
  if (stdout.trim() === '') return [];
  const raw = parseJson(stdout);
  if (raw === undefined) return [cliDrift('auth-status=(not-json)')];
  if (!isRec(raw)) return [cliDrift('auth-status=(not-object)')];
  return typeof raw.loggedIn === 'boolean' ? [] : [cliDrift('auth-status.loggedIn=(missing)')];
}

/** `claude agents --json` の行の種類。 */
export const KNOWN_AGENT_KINDS: ReadonlySet<string> = new Set(['interactive', 'background']);

/**
 * `claude agents --json --all` の形。hangar が読むのはバックグラウンドの行の id と sessionId だけなので、そこだけを見る（runs/procs.ts の parseJobs）。
 * 同じ形の違いは 1 つにまとめる。出力が空なら見ない。
 */
export function agentsJsonDrifts(stdout: string): Drift[] {
  if (stdout.trim() === '') return [];
  const raw = parseJson(stdout);
  if (raw === undefined) return [cliDrift('agents-json=(not-json)')];
  if (!Array.isArray(raw)) return [cliDrift('agents-json=(not-array)')];
  const out = new Map<string, Drift>();
  const add = (v: string) => { if (!out.has(v)) out.set(v, cliDrift(v)); };
  for (const r of raw) {
    if (!isRec(r)) { add('agents-json.row=(not-object)'); continue; }
    if (typeof r.kind !== 'string') add('agents-json.kind=(missing)');
    else if (!KNOWN_AGENT_KINDS.has(r.kind)) add(`agents-json.kind=${r.kind}`);
    if (r.kind !== 'interactive') {
      if (typeof r.id !== 'string') add('agents-json.id=(missing)');
      if (typeof r.sessionId !== 'string') add('agents-json.sessionId=(missing)');
    }
  }
  return [...out.values()];
}

/** `claude -p --output-format json` の形。要約が読む structured_output があるか（summary/claude.ts）。 */
export function printJsonDrifts(stdout: string): Drift[] {
  const raw = parseJson(stdout);
  if (raw === undefined) return [cliDrift('print-json=(not-json)')];
  if (!isRec(raw)) return [cliDrift('print-json=(not-object)')];
  return raw.structured_output === undefined ? [cliDrift('print-json.structured_output=(missing)')] : [];
}
```

- [ ] **Step 4: 契約の試験が通るのを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/compat/cli.test.ts`
Expected: PASS。

- [ ] **Step 5: 呼び手の落ちる試験を書く**

`packages/server/src/config/accountAuth.test.ts` の import に足す。

```ts
import type { Drift } from '../provider/claude-code/compat/types.ts';
```

`describe('AccountAuth', …)` の最初の it の後に足す。

```ts
  it('auth status の形が違えば、ずれとして知らせる', async () => {
    const seen: Drift[] = [];
    const run = vi.fn<RunClaude>(async () => ({ code: 0, stdout: 'Not logged in' }));
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, now: () => 9, compat: { note: (d) => seen.push(d) } });
    expect(await auth.refresh(univ)).toBeNull();
    expect(seen).toEqual([{ contract: 'cli', value: 'auth-status=(not-json)', version: null }]);
    run.mockResolvedValueOnce({ code: 0, stdout: OK });
    await auth.refresh(univ);
    expect(seen).toHaveLength(1);
  });
```

`packages/server/src/runs/procs.test.ts` の import を置き換える。

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFakeTool } from '../../test/fake-bin.ts';
import { posixIt } from '../../test/platform.ts';
import type { Drift } from '../provider/claude-code/compat/types.ts';
import { parseJobs, parseProcStart, realProcOps, realProcOpsWith, sameStartTime } from './procs.ts';
```

`parseBackgroundedId` は段 1 の PR 1 で消したので、import に入れない。

`describe('parseJobs', …)` の後に足す。

```ts
describe('realProcOpsWith', () => {
  // 偽の claude は sh で書く。Windows の .cmd は spawnSync で直に起こせないので飛ばす。
  posixIt('agents --json の形が違えば、読まずにずれとして知らせる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-procs-'));
    try {
      const bin = writeFakeTool(dir, 'claude', { sh: `echo '{"sessions":[]}'`, cmd: '' });
      const seen: Drift[] = [];
      expect(realProcOpsWith({ note: (d) => seen.push(d) }).listJobs(bin)).toBeNull();
      expect(seen).toEqual([{ contract: 'cli', value: 'agents-json=(not-array)', version: null }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
```

`packages/server/src/summary/claude.test.ts` の import に足す。

```ts
import type { Drift } from '../provider/claude-code/compat/types.ts';
```

`describe('ClaudeHeadlessSummarizer', …)` の末尾に足す。

```ts
  it('-p の JSON に structured_output が無ければ、ずれとして知らせる。読めたときは知らせない', async () => {
    const seen: Drift[] = [];
    const compat = { note: (d: Drift) => seen.push(d) };
    const bad = new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: async () => ({ code: 0, stdout: '{"type":"result","result":"x"}', stderr: '' }), compat });
    await expect(bad.summarize(CANNED_INPUT)).rejects.toBeInstanceOf(SummarizerError);
    expect(seen).toEqual([{ contract: 'cli', value: 'print-json.structured_output=(missing)', version: null }]);
    await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn: spawnOk, compat }).summarize(CANNED_INPUT);
    expect(seen).toHaveLength(1);
  });
```

- [ ] **Step 6: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/config/accountAuth.test.ts packages/server/src/runs/procs.test.ts packages/server/src/summary/claude.test.ts`
Expected: FAIL。`realProcOpsWith` が無い。`compat` の型の誤りと、`seen` が空のままで落ちる。

- [ ] **Step 7: 呼び手でずれを渡す**

`packages/server/src/config/accountAuth.ts` の import に足す。

```ts
import { authStatusDrifts } from '../provider/claude-code/compat/cli.ts';
import { NO_COMPAT, type CompatSink } from '../provider/claude-code/compat/types.ts';
```

`private readonly now: () => number;` の後に足す。

```ts
  private readonly compat: CompatSink;
```

constructor を置き換える。

```ts
  constructor(private readonly o: { claudeBin: () => string | null; run?: RunClaude; now?: () => number; onChange?: () => void; compat?: CompatSink }) {
    this.onChange = o.onChange;
    this.run = o.run ?? realRun;
    this.now = o.now ?? (() => Date.now());
    this.compat = o.compat ?? NO_COMPAT;
  }
```

`refresh` の中の `if (bin) { … }` を置き換える。

```ts
    if (bin) {
      try {
        const out = await this.run(bin, ['auth', 'status', '--json'], accountEnv(account), STATUS_TIMEOUT_MS);
        // 形が違えば、Claude Code との互換のずれとして記録する。読み方（parseAuthStatus）はいまのまま。
        for (const d of authStatusDrifts(out.stdout)) this.compat.note(d);
        next = parseAuthStatus(out.stdout, this.now());
      } catch { next = null; }
    }
```

`packages/server/src/runs/procs.ts` の import に足す。

```ts
import { agentsJsonDrifts } from '../provider/claude-code/compat/cli.ts';
import { NO_COMPAT, type CompatSink } from '../provider/claude-code/compat/types.ts';
```

`export const realProcOps: ProcOps = { … };` の全体を置き換える。

```ts
/**
 * 本物のプロセスに触る口。compat は `claude agents --json` の形のずれを受け取る（provider/claude-code/compat/cli.ts）。
 */
export function realProcOpsWith(compat: CompatSink): ProcOps {
  return {
    startTimeOf: (pid) => startTimeOf(pid),
    terminate: (pid, timeoutMs) => terminate(pid, timeoutMs),
    listJobs(bin) {
      // 起こせない相手（Windows の .cmd など）で spawnSync が投げても、読めなかったことにして返す。
      try {
        const r = spawnSync(bin, ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (r.status !== 0) return null;
        const out = r.stdout ?? '';
        for (const d of agentsJsonDrifts(out)) compat.note(d);
        return parseJobs(out);
      } catch {
        return null;
      }
    },
    runClaude(bin, args, cwd) {
      return new Promise((resolve, reject) => {
        execFile(bin, args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).trim()));
          else resolve(stdout);
        });
      });
    },
  };
}

/** ずれを記録しない本物の口。試験と、compat を渡さない呼び手が使う。 */
export const realProcOps: ProcOps = realProcOpsWith(NO_COMPAT);
```

`packages/server/src/runs/manager.ts` の 25 行目の import を置き換え、import を 1 行足す。

```ts
import { realProcOpsWith, sameStartTime, type ProcOps } from './procs.ts';
import { NO_COMPAT, type CompatSink } from '../provider/claude-code/compat/types.ts';
```

59 行目の `RunManagerDeps` の末尾の `accounts?: AccountStore };` を置き換える。

```ts
accounts?: AccountStore; /** Claude Code の形式のずれを受け取る口（provider/claude-code/compat/）。 */ compat?: CompatSink };
```

`private parking = new Set<string>();` の後に足す。

```ts
  /** 本物のプロセスに触る口。procs を渡されなかったときに、compat を結んで 1 度だけ作る。 */
  private realProcs: ProcOps | null = null;
```

`procs()` を置き換える。

```ts
  private procs(): ProcOps {
    return this.deps.procs ?? (this.realProcs ??= realProcOpsWith(this.deps.compat ?? NO_COMPAT));
  }
```

`packages/server/src/summary/claude.ts` の import に足す。

```ts
import { printJsonDrifts } from '../provider/claude-code/compat/cli.ts';
import { NO_COMPAT, type CompatSink } from '../provider/claude-code/compat/types.ts';
```

constructor の型に `compat?: CompatSink` を足す。

```ts
  constructor(private readonly o: { claudeBin: string | null; hourlyCap: number; usage: () => UsageDto; spawn?: SpawnText; now?: () => number; compat?: CompatSink }) {
```

`if (r.code !== 0) throw …;` の直後に足す。

```ts
    // 形が違えば、Claude Code との互換のずれとして記録する。失敗の扱いはいまのまま。
    for (const d of printJsonDrifts(r.stdout)) (this.o.compat ?? NO_COMPAT).note(d);
```

- [ ] **Step 8: 通るのを確かめる**

Run: `npx vitest run packages/server/src/config/accountAuth.test.ts packages/server/src/runs/procs.test.ts packages/server/src/summary/claude.test.ts packages/server/src/runs/manager.test.ts packages/server/src/provider/claude-code/compat/cli.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 9: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/cli.ts packages/server/src/provider/claude-code/compat/cli.test.ts packages/server/src/config/accountAuth.ts packages/server/src/config/accountAuth.test.ts packages/server/src/runs/procs.ts packages/server/src/runs/procs.test.ts packages/server/src/runs/manager.ts packages/server/src/summary/claude.ts packages/server/src/summary/claude.test.ts
git commit -m "feat(server): watch claude auth, agents and print JSON outputs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 画面の文字の契約

**Files:**
- Create: `packages/server/src/provider/claude-code/compat/screen.ts`
- Modify: `packages/server/src/runs/promptJump.ts:16`、`:115-139`
- Test: `packages/server/src/runs/promptJump.test.ts`
- Modify: `packages/server/src/runs/manager.ts:813-817`

**Interfaces:**
- Consumes: `Drift`（Task 3）、`RunManagerDeps.compat`（Task 9）。
- Produces: `ScreenMark = 'footer' | 'prompt-marker'`、`screenDrift(mark: ScreenMark): Drift`（`compat/screen.ts`）。
- Produces: `jumpToPrompt(io, heads, index, from, onMissing?: (mark: ScreenMark) => void): Promise<JumpResult>`。`JumpResult` の形は変えない（UI が読む）。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/runs/promptJump.test.ts` の `describe('jumpToPrompt', …)` の末尾に足す。

```ts
  it('ctrl+o の後に最下行の文言が出なければ、footer が見つからないと知らせる', async () => {
    const c = fakeClaude(PROMPTS, { ignoreCtrlO: true });
    const marks: string[] = [];
    expect(await jumpToPrompt(c.io, heads(PROMPTS), 3, 'bottom', (m) => marks.push(m))).toEqual({ found: false, reason: 'mode' });
    expect(marks).toEqual(['footer']);
  });
  it('着けず、最後の画面に指示の行が 1 つも無ければ、指示の行の記号が見つからないと知らせる', async () => {
    let inT = false;
    const io: PaneIo = {
      capture: () => (inT ? ['> 最初の指示です', '', '⏺ 返事', '', TRANSCRIPT_FOOTER].join('\n') : ['⏺ 返事', '', '❯ ', NORMAL_FOOTER, ''].join('\n')),
      send: (k) => { if (k === 'C-o') inT = true; },
      sleep: async () => {},
    };
    const marks: string[] = [];
    expect(await jumpToPrompt(io, heads(PROMPTS), 0, 'top', (m) => marks.push(m))).toEqual({ found: false, reason: 'notFound' });
    expect(marks).toEqual(['prompt-marker']);
  });
  it('指示の行が見えていて着けなかっただけなら、何も知らせない', async () => {
    const c = fakeClaude(PROMPTS);
    const marks: string[] = [];
    expect(await jumpToPrompt(c.io, ['存在しない指示', ...heads(PROMPTS).slice(1)], 0, 'top', (m) => marks.push(m))).toEqual({ found: false, reason: 'notFound' });
    expect(marks).toEqual([]);
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/runs/promptJump.test.ts`
Expected: FAIL。`marks` が空のまま。

- [ ] **Step 3: `compat/screen.ts` を作り、跳ぶ処理で知らせる**

`packages/server/src/provider/claude-code/compat/screen.ts`

```ts
import type { Drift } from './types.ts';

/**
 * ターンへ跳ぶときに読む画面の目印（runs/promptJump.ts）。
 * footer は transcript 表示の最下行の文言、prompt-marker は指示の行の頭の記号である。
 */
export type ScreenMark = 'footer' | 'prompt-marker';

export function screenDrift(mark: ScreenMark): Drift {
  return { contract: 'screen', value: mark === 'footer' ? 'transcript-footer=(missing)' : 'prompt-marker=(missing)', version: null };
}
```

`packages/server/src/runs/promptJump.ts` の import に足す。

```ts
import type { ScreenMark } from '../provider/claude-code/compat/screen.ts';
```

`jumpToPrompt` を doc コメントごと置き換える。

```ts
/**
 * heads は hangar が数えた指示の書き出しを古い順に並べたもの、index はその中の目的の指示。
 * 会話の途中から始まる（あるいは途中で終わる）切り出しでよい。どちらの端が会話の端かを from で言う。
 * 着けなかったときも transcript は開いたままにする。どこまで来たかは利用者が画面で見られる。
 * onMissing は、読む目印が画面に見つからなかったことを受け取る（Claude Code との互換のずれ）。跳び方は変えない。
 */
export async function jumpToPrompt(io: PaneIo, heads: string[], index: number, from: JumpFrom, onMissing?: (mark: ScreenMark) => void): Promise<JumpResult> {
  const target = heads[index] ?? '';
  if (!inTranscript(io)) {
    io.send('C-o');
    let entered = false;
    for (let i = 0; i < ENTER_TRIES && !entered; i++) { await io.sleep(ENTER_WAIT_MS); entered = inTranscript(io); }
    // ctrl+o の後に最下行の文言が一度も出なければ、文言が変わったと見て知らせる。
    if (!entered) { onMissing?.('footer'); return { found: false, reason: 'mode' }; }
  }
  // G は最後の指示より下へ行くので、そこから { を 1 回押すと最後の指示に着く。g は最初の指示が見える位置へ行く。
  const fromTop = from === 'top';
  const ok = fromTop
    ? (await sendInTranscript(io, 'g')) && (await repeat(io, '}', index))
    : (await sendInTranscript(io, 'G')) && (await repeat(io, '{', heads.length - index));
  if (!ok) return { found: false, reason: 'mode' };
  let screen = '';
  for (let i = 0; i <= CORRECTIONS; i++) {
    screen = await settled(io);
    if (target !== '' && visiblePrompts(screen).some((p) => p.startsWith(target))) return { found: true };
    if (i === CORRECTIONS) break;
    const at = locate(screen, heads, index);
    // 見えている指示が一覧に無いときは、来た向きにもう 1 つ進めて手がかりを探す。
    const moved = at === null ? await repeat(io, fromTop ? '}' : '{', 1) : at > index ? await repeat(io, '{', at - index) : await repeat(io, '}', index - at);
    if (!moved) return { found: false, reason: 'mode' };
  }
  // 着けず、最後の画面に指示の行が 1 つも無ければ、行の頭の記号が変わったと見て知らせる。
  if (visiblePrompts(screen).length === 0) onMissing?.('prompt-marker');
  return { found: false, reason: 'notFound' };
}
```

`packages/server/src/runs/manager.ts` の import に足す。

```ts
import { screenDrift } from '../provider/claude-code/compat/screen.ts';
```

`jumpToPrompt` のメソッドを置き換える。

```ts
  /** Claude のタブを transcript の中の指示へ跳ばす。手順と送るキーの制限は promptJump.ts にある。 */
  jumpToPrompt(runId: string, heads: string[], index: number, from: JumpFrom): Promise<JumpResult> {
    const io = this.agentPane(runId);
    // 画面の目印が見つからなかったら、Claude Code との互換のずれとして記録する（provider/claude-code/compat/screen.ts）。
    return this.queuePane(runId, () => jumpToPrompt(io, heads, index, from, (mark) => this.deps.compat?.note(screenDrift(mark))));
  }
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run packages/server/src/runs/promptJump.test.ts packages/server/src/runs/manager.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/src/provider/claude-code/compat/screen.ts packages/server/src/runs/promptJump.ts packages/server/src/runs/promptJump.test.ts packages/server/src/runs/manager.ts
git commit -m "feat(server): report missing screen markers when jumping to a prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 準備の確かめの要約、`GET /api/compat`、UI の口

**Files:**
- Modify: `packages/shared/src/api.ts:1-4`、`:117-131`
- Modify: `packages/server/src/config/readiness.ts:1-11`、`:102-118`、`:141-148`
- Test: `packages/server/src/config/readiness.test.ts`
- Modify: `packages/server/src/http/app.ts:4`、`:118-125`、`:842`
- Test: `packages/server/src/http/app.test.ts:115-119`（READY）と末尾
- Modify: `packages/ui/src/runtime/api.ts:63`、`:173`
- Test: `packages/ui/src/runtime/api.test.ts`
- Modify: `packages/ui/src/test/fakeApi.ts:5-14`、`:47-52`
- Modify（READY に `compat` を足すだけ）：`packages/ui/src/presenters/readiness.test.ts:5-9`、`packages/ui/src/presenters/presenters.test.ts:1017-1021`、`packages/ui/src/views/Onboarding.test.tsx:9-13`、`packages/ui/src/runtime/runtime.test.ts:1566-1570`

**Interfaces:**
- Consumes: `CompatDto`、`CompatSummaryDto`（Task 2）、`VERIFIED_CLAUDE_VERSION`（Task 3）。
- Produces: `ReadinessDto.compat: CompatSummaryDto`。計画 B の presenter が `compatState(r.compat)` で読む。
- Produces: `ReadinessOptions.compatDriftCount?: () => number`、`AppDeps.compat?: () => Promise<CompatDto>`、`GET /api/compat`。Task 12 がサーバで渡す。
- Produces: `ApiClient.compat(): Promise<CompatDto>`。計画 B が確認リストの 6 行目を開いたときに呼ぶ。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/config/readiness.test.ts` の import に足す。

```ts
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
```

`describe('createReadiness', …)`（`createReadiness(` を呼んでいる describe）の末尾に足す。

```ts
  it('Claude Code との互換の要約に、確かめた版、手元の claude の版、ずれの件数を載せる', async () => {
    const claude = fakeTool('claude', '2.1.300 (Claude Code)');
    const read = createReadiness({ settings: () => baseSettings({ claudePath: claude }), claudeDir: path.join(tmp, 'claude'), claudeJson: path.join(tmp, '.claude.json'), homeDir: tmp, db, deviceId: 'd', shellCommand: () => 'hangar shell install', compatDriftCount: () => 3 });
    expect((await read()).compat).toEqual({ verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: '2.1.300', driftCount: 3 });
    const none = createReadiness({ settings: () => baseSettings(), claudeDir: path.join(tmp, 'claude'), claudeJson: path.join(tmp, '.claude.json'), homeDir: tmp, db, deviceId: 'd', shellCommand: () => 'hangar shell install' });
    expect((await none()).compat).toEqual({ verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: null, driftCount: 0 });
  });
```

`packages/server/src/http/app.test.ts` の `READY` の最後の行（`commands: { … },`）の後に足す。

```ts
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
```

同じファイルの import に足す（6 行目の `import type { … } from '@agent-hangar/shared';` の並びに `CompatDto` を足し、次の 1 行を足す）。

```ts
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
```

ファイルの末尾に足す。

```ts
describe('Claude Code との互換', () => {
  it('GET /api/compat は互換の口の答えをそのまま返し、口が無ければ確かめた版だけを返す', async () => {
    const COMPAT: CompatDto = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry', value: 'status=thinking', version: '2.1.300', count: 2, firstSeenAt: 1, lastSeenAt: 2 }] };
    const withCompat = createApp({ ...deps, compat: async () => COMPAT });
    expect(await (await withCompat.request('/api/compat', { headers: H })).json()).toEqual(COMPAT);
    expect((await json(await get('/api/compat'))).body).toEqual({ verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: null, drifts: [] });
  });
});
```

`packages/ui/src/runtime/api.test.ts` の `describe('createApi（フェーズ 2）', …)` の末尾に足す。

```ts
  it('Claude Code との互換は GET /api/compat で取る', async () => {
    const { api, calls } = harness(200, { verifiedVersion: '2.1.292', localVersion: null, drifts: [] });
    expect(await api.compat()).toEqual({ verifiedVersion: '2.1.292', localVersion: null, drifts: [] });
    expect(calls.at(-1)).toMatchObject({ url: '/api/compat', method: 'GET' });
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/config/readiness.test.ts packages/server/src/http/app.test.ts packages/ui/src/runtime/api.test.ts`
Expected: FAIL。`compat` が readiness の答えに無い、`/api/compat` が 404、`api.compat` が無い。

- [ ] **Step 3: DTO に `compat` を足す**

`packages/shared/src/api.ts` の import に足す。

```ts
import type { CompatSummaryDto } from './compat.ts';
```

`ReadinessDto` を doc コメントごと置き換える。

```ts
/**
 * 準備の確かめ（GET /api/readiness）。
 * 設定画面の欄の下の検証と、空のホームの確認リストが、同じこの 1 つを読む。
 * node の auto は、設定が空で、サーバを動かしている Node をそのまま見せていることを表す。
 * workspace の projectCount は、ワークスペースの直下から登録したプロジェクトの数である。
 * mcp は Claude Code の user スコープ（~/.claude.json）に hangar の MCP サーバが載っているか。読むだけで書かない。
 * commands は画面に出すコマンドで、どれも同じ hangar の呼び方にそろえてある。
 * compat は Claude Code との互換の要約で、確認リストの 6 行目が読む。ずれの中身は GET /api/compat で取る。
 */
export type ReadinessDto = {
  tools: { tmux: ToolCheckDto; claude: ToolCheckDto; code: ToolCheckDto; node: ToolCheckDto & { auto: boolean } };
  workspace: { path: string; exists: boolean; projectCount: number };
  mcp: { registered: boolean; file: string };
  statusline: StatuslineStatusDto;
  commands: { mcp: string; statusline: string; shell: string };
  compat: CompatSummaryDto;
};
```

- [ ] **Step 4: 準備の確かめに要約を載せる**

`packages/server/src/config/readiness.ts` の import に足す。

```ts
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
```

`ReadinessOptions` の `timeoutMs?: number;` の後に足す。

```ts
  /** 記録した Claude Code との互換のずれの件数。渡さなければ 0 とする。 */
  compatDriftCount?: () => number;
```

返す値の `commands: { … },` の後に足す。

```ts
      // 手元の版は、上で読んだ claude の版と同じものを使う（同じ claude を 2 度起こさない）。
      compat: { verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: claude.version, driftCount: o.compatDriftCount?.() ?? 0 },
```

- [ ] **Step 5: `GET /api/compat` を足す**

`packages/server/src/http/app.ts` の 4 行目の `import { … } from '@agent-hangar/shared';` の並びに `type CompatDto` を足し、import を 1 行足す。

```ts
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
```

`AppDeps` の `readiness: () => Promise<ReadinessDto>;` の後に足す。

```ts
  /**
   * Claude Code との互換（確かめた版、手元の版、記録したずれの一覧）。確認リストの 6 行目を開いたときに読む。
   * 渡さなければ、確かめた版だけを持つ空の一覧を返す。
   */
  compat?: () => Promise<CompatDto>;
```

`api.get('/readiness', …);` の行の後に足す。

```ts
  api.get('/compat', async (c) => c.json(deps.compat ? await deps.compat() : ({ verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: null, drifts: [] } satisfies CompatDto)));
```

- [ ] **Step 6: UI の口を足し、偽物と見本の READY をそろえる**

`packages/ui/src/runtime/api.ts` の 1 行目の `import type { … } from '@agent-hangar/shared';` の並びに `CompatDto` を足す。`readiness(): Promise<ReadinessDto>;` の後に足す。

```ts
  /** Claude Code との互換。確認リストの 6 行目を開いたときに取る（計画 B）。 */
  compat(): Promise<CompatDto>;
```

`readiness: () => call('/api/readiness'),` の後に足す。

```ts
    compat: () => call('/api/compat'),
```

`packages/ui/src/test/fakeApi.ts` の `Extras` の `| 'usageAggregate' | 'statusline' | 'shellHook' | 'readiness' |` を `| 'usageAggregate' | 'statusline' | 'shellHook' | 'readiness' | 'compat' |` に直す。偽の `readiness` の返り値の `commands: { … },` の後に足す。

```ts
      compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
```

偽の `readiness: vi.fn(…),` の後に足す。

```ts
    compat: vi.fn(async () => ({ verifiedVersion: '2.1.292', localVersion: '2.1.292', drifts: [] })),
```

次の 4 つの試験の `READY` の `commands: { … },` の後に、同じ 1 行を足す。

- `packages/ui/src/presenters/readiness.test.ts`
- `packages/ui/src/presenters/presenters.test.ts`（`describe('presentSettings の検証と保存の知らせ（設定の B1 と C1）', …)` の中の `READY`）
- `packages/ui/src/views/Onboarding.test.tsx`
- `packages/ui/src/runtime/runtime.test.ts`（`describe('設定の欄ごとの保存と準備の確かめ（ランタイム）', …)` の中の `READY`）

```ts
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
```

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run packages/server/src/config/readiness.test.ts packages/server/src/http/app.test.ts packages/ui/src/runtime/api.test.ts packages/ui/src/presenters/readiness.test.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/Onboarding.test.tsx packages/ui/src/runtime/runtime.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 8: コミットする**

```bash
git add packages/shared/src/api.ts packages/server/src/config/readiness.ts packages/server/src/config/readiness.test.ts packages/server/src/http/app.ts packages/server/src/http/app.test.ts packages/ui/src/runtime/api.ts packages/ui/src/runtime/api.test.ts packages/ui/src/test/fakeApi.ts packages/ui/src/presenters/readiness.test.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/Onboarding.test.tsx packages/ui/src/runtime/runtime.test.ts
git commit -m "feat: expose Claude Code compat via GET /api/compat and the readiness summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: サーバの配線と設計書の互換の節

**Files:**
- Modify: `packages/server/src/server.ts`（下の各所）
- Test: `packages/server/src/server.test.ts`
- Modify: `docs/design.md`（「Claude Code Provider」、新しい「Claude Code との互換」、「外のターミナルのセッション」、「使用量」）

**Interfaces:**
- Consumes: Task 3 から Task 11 のすべて（`CompatLog`、`compatPath`、`VERIFIED_CLAUDE_VERSION`、`TranscriptCompat`、`RegistryWatcher` の 5 つめの引数、`UsageTracker` と `AccountAuth` と `RunManager` と `ClaudeHeadlessSummarizer` の `compat`、`ClaudeDirWatch`、`BUILTIN_SUBCOMMANDS`、`readClaudeHelp`、`subcommandsFromHelp`、`ShellScriptOptions.subcommands`、`ToolVersions`、`ReadinessOptions.compatDriftCount`、`AppDeps.compat`）。
- Produces: 起動したサーバが `~/.agent-hangar/compat.json` を 5 秒ごとと閉じるときに書き、`GET /api/compat` と `GET /api/readiness` の `compat` が実物の値を返す。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/server.test.ts` の import を直す。

```ts
import type { CompatDto, ReadinessDto, ServerEvent, SessionDto, SyncStatusBody } from '@agent-hangar/shared';
import { writeFakeTool } from '../test/fake-bin.ts';
import { VERIFIED_CLAUDE_VERSION } from './provider/claude-code/compat/version.ts';
import { expectMode, posixIt } from '../test/platform.ts';
```

（元の `import type { ServerEvent, SessionDto, SyncStatusBody } from '@agent-hangar/shared';` と `import { expectMode } from '../test/platform.ts';` を置き換え、2 行を足す。）

`describe('startServer', …)` の「トークンを作り直すと、ヘッダのファイルも次の起動で揃う」の it の後に足す。

```ts
  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('claude --help のサブコマンドで包みを書き直し、/api/compat と準備の確かめが版とずれを返す。閉じると compat.json に残る', async () => {
    const bin = writeFakeTool(path.join(home, 'bin'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Usage: claude\\n\\nCommands:\\n  agents [options]  Manage background agents\\n  newcmd            Something new\\n" ;; esac',
      cmd: '',
    });
    const prev = process.env.HANGAR_CLAUDE_BIN;
    process.env.HANGAR_CLAUDE_BIN = bin;
    try {
      const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
      try {
        const script = path.join(home, 'shell', 'claude.zsh');
        await until(async () => (fs.readFileSync(script, 'utf8').includes('    agents|newcmd) command claude') ? true : null));
        const res = await fetch(`http://127.0.0.1:${s.port}/api/compat`, { headers: { authorization: `Bearer ${tokenOf()}` } });
        const body = (await res.json()) as CompatDto;
        expect(body.verifiedVersion).toBe(VERIFIED_CLAUDE_VERSION);
        expect(body.localVersion).toBe('9.9.9');
        expect(body.drifts.map((d) => d.value)).toEqual(expect.arrayContaining(['subcommand.added=newcmd', 'subcommand.removed=purge']));
        // 確認リストが読む要約にも、同じずれの件数が載る。
        const ready = (await (await fetch(`http://127.0.0.1:${s.port}/api/readiness`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json()) as ReadinessDto;
        expect(ready.compat.verifiedVersion).toBe(VERIFIED_CLAUDE_VERSION);
        expect(ready.compat.driftCount).toBeGreaterThanOrEqual(body.drifts.length);
      } finally {
        await s.close();
      }
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'compat.json'), 'utf8')) as { entries: { value: string }[] };
      expect(saved.entries.map((e) => e.value)).toContain('subcommand.added=newcmd');
    } finally {
      if (prev === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prev;
    }
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/server/src/server.test.ts -t "claude --help のサブコマンド"`
Expected: FAIL。`until` が時間切れ（包みに `newcmd` が書かれない）。

- [ ] **Step 3: import を足す**

`packages/server/src/server.ts` の 12 行目を置き換える。

```ts
import { createReadiness, ToolVersions } from './config/readiness.ts';
```

`import { readRegistry, RegistryWatcher } from './provider/claude-code/registry.ts';` の後に足す。

```ts
import { BUILTIN_SUBCOMMANDS, readClaudeHelp, subcommandsFromHelp } from './provider/claude-code/compat/cli.ts';
import { ClaudeDirWatch } from './provider/claude-code/compat/claudeDir.ts';
import { CompatLog, compatPath } from './provider/claude-code/compat/log.ts';
import { VERIFIED_CLAUDE_VERSION } from './provider/claude-code/compat/version.ts';
```

- [ ] **Step 4: 記録を作り、登録と索引に渡す**

`const db = openDb(dbPath(home));` から `const registry = new RegistryWatcher(…);` までの 5 行を置き換える。

```ts
  const db = openDb(dbPath(home));
  const hub = new EventHub(VERSION);
  // 閉じたかどうか。閉じた後に届いた裏の読み取り（claude --help と --version）が、消えた置き場に書かないようにする。
  let closed = false;
  // Claude Code の形式のずれの記録（provider/claude-code/compat/）。端末ごとのファイルで、同期しない。
  // 手元の claude の版は listen の後に裏で読む。読めるまでは、版の無いずれを null で記録する。
  let claudeVersion: string | null = null;
  const compatLog = new CompatLog({ file: compatPath(home), localVersion: () => claudeVersion });
  compatLog.start();
  // 裏でサブエージェントだけが動いているものに、読み直しのたびに印を足す（live/aside.ts）。
  const aside = new AsideReader(db);
  const registry = new RegistryWatcher(claudeDir, undefined, opts.registryIsGone, (live) => aside.apply(live, Date.now()), compatLog);
```

`new IndexerService({ … })` の `processStartOf: (q) => …,` の後に足す。

```ts
    // 手元の本文の行を見張る。手元の claude の版より古い行は昔の形として見ない。版が読めるまでは確かめた版を床にする。
    compat: { sink: compatLog, since: () => claudeVersion ?? VERIFIED_CLAUDE_VERSION },
```

- [ ] **Step 5: 版と `--help` を裏で読み、包みに書く**

`const claudeBinOf = …;` の行の後に足す。

```ts
  // 手元の claude の版。ずれの記録の既定の版と、GET /api/compat の手元の版に使う。同じファイルなら起こし直さない。
  const claudeVersions = new ToolVersions();
  const refreshClaudeVersion = async (): Promise<string | null> => {
    const bin = claudeBinOf(settings);
    const v = bin ? await claudeVersions.get(bin, ['--version']) : null;
    if (!closed) claudeVersion = v;
    return v;
  };
  // 包みがそのまま渡すサブコマンド。起動のたびと claude のパスを変えたときに claude --help から作り直す。
  let shellSubcommands: readonly string[] = BUILTIN_SUBCOMMANDS;
```

`writeShellScript` の中の `ensureShellScript(…)` の行を置き換える。

```ts
      ensureShellScript(home, { url: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`, tokenFile: path.join(home, 'token'), tmuxPath: settings.tmuxPath, subcommands: shellSubcommands });
```

`writeShellScript` の定義の後の `writeShellScript();` の行を置き換える。

```ts
  /**
   * 包みがそのまま渡すサブコマンドを claude --help から作り直し、包みを書き直す。
   * 読めなければ組み込みの一覧を使う。組み込みとの差は Claude Code との互換のずれとして記録する。
   * 起動を待たせないよう裏で走らせ、閉じた後に届いたら何もしない。
   */
  const refreshSubcommands = async (): Promise<void> => {
    const bin = claudeBinOf(settings);
    const text = bin ? await readClaudeHelp(bin) : null;
    if (closed) return;
    const r = subcommandsFromHelp(text);
    for (const d of r.drifts) compatLog.note(d);
    shellSubcommands = r.subcommands;
    writeShellScript();
  };
  writeShellScript();
  void refreshSubcommands();
  void refreshClaudeVersion();
```

- [ ] **Step 6: 各部品に口を渡す**

`const accountAuth = new AccountAuth({ claudeBin: () => claudeBinOf(settings) });` を置き換え、続けて足す。

```ts
  const accountAuth = new AccountAuth({ claudeBin: () => claudeBinOf(settings), compat: compatLog });
  // 2 つ目以降のアカウントの置き場に、Claude Code が新しい項目を足していないかを見る。起動のときと、確認リストを開いたときに見る。
  const claudeDirWatch = new ClaudeDirWatch({ dirs: () => accountStore.list().filter((a) => a.id !== PRIMARY_ACCOUNT_ID).map((a) => a.dir), sink: compatLog });
  claudeDirWatch.check();
```

`new RunManager({ … })` の `accounts: accountStore,` の後に足す。

```ts
    compat: compatLog,
```

`new UsageTracker(db, { … })` の `accountOf: … },` の後（閉じ括弧の前）に足す。

```ts
    compat: compatLog,
```

`const claudeSummarizer = () => …;` を置き換える。

```ts
  const claudeSummarizer = () => new ClaudeHeadlessSummarizer({ claudeBin: claudeBinOf(settings), hourlyCap: settings.summaryHourlyCap, usage: () => usage.current(), compat: compatLog });
```

`updateSettings` の中の `if (patch.claudePath !== undefined) { … }` を置き換える。

```ts
      // claudePath が変われば、これから起こす run と要約が新しい場所を使う。包みのサブコマンドと手元の版も読み直す。
      if (patch.claudePath !== undefined) {
        runs.setClaudeBin(claudeBinOf(settings));
        claude = claudeSummarizer();
        void refreshSubcommands();
        void refreshClaudeVersion();
      }
```

`readiness: createReadiness({ … }),` を置き換え、続けて足す。

```ts
    readiness: createReadiness({
      settings: () => settings, claudeDir, claudeJson: claudeJsonPath(), db, deviceId: device.id,
      shellCommand: () => shellInstallCommand({ hangarOnPath: which('hangar'), bundledHangar }),
      compatDriftCount: () => { claudeDirWatch.check(); return compatLog.count(); },
    }),
    // Claude Code との互換の一覧。確認リストの 6 行目を開いたときに読む。
    compat: async () => {
      claudeDirWatch.check();
      return { verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: await refreshClaudeVersion(), drifts: compatLog.list() };
    },
```

`close: async () => {` の次の行に足す。

```ts
      closed = true;
```

`close` の最後の `db.close();` の前に足す。

```ts
      // 記録の残りを書き出す。書けなくても閉じるのは止めない。
      compatLog.stop();
```

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run packages/server/src/server.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 8: 設計書を直す**

`docs/design.md` の「Claude Code Provider」の節で、次を置き換える。

置き換え前：``status`（busy か idle）を持つ。`
置き換え後：``status`（busy、idle、waiting、shell）を持つ。`

同じ節の末尾（`フェーズ 1 の実装では、791 ファイル、40 プロジェクト、1,127 セッションの全件索引化に約 15 秒かかった。` の行）の後、`## セッションの起動と観察` の前に、次の節を足す。

```markdown
### Claude Code との互換

hangar は、Claude Code が公開を約束していない形式に頼っている。
利用者ごとに claude の版が違うので、形式が変わったときに気づけるよう、頼っている形式を 6 つの契約に分けて見張る（`packages/server/src/provider/claude-code/compat/`）。
対応する版の範囲は決めない。
Claude Code はほぼ毎日新しい版が出るので、範囲はすぐ古くなり、範囲の中で形式が変わっても捕まえられないためである。

| 契約 | 見張るもの | ずれたときの振る舞い |
| --- | --- | --- |
| トランスクリプト | 行の `type`、`system.subtype`、本文の塊の種類、`attachment.type`、メタ行の種類が、知っている集合にあるか | 知らない行は meta として残し、知らない塊は捨てる。記録する |
| レジストリ | `status` が busy、idle、waiting、shell のどれかか。`sessionId` と `pid` があるか | 知らない `status` は作業中として扱う。誤って止めるより待たせるほうが害が小さい。配列や `null` の登録はその 1 件だけ読まない。記録する |
| statusline | `session_id`、`model`、`context_window.context_window_size`、`cost.total_cost_usd`、`rate_limits` の各窓の `used_percentage` と `resets_at` があるか。`resets_at` の単位 | `resets_at` が 10^11 より大きければミリ秒と見て、そのまま使う。欠けた項目は直前の値を保つ。記録する |
| `~/.claude` の項目 | 2 つ目以降のアカウントの置き場の直下に、共有のリンクでも、アカウントごとに持つと知っている項目でもないものがあるか | アカウントごとのままにする。記録する |
| CLI | `claude --help` のサブコマンド、`auth status --json`、`agents --json`、`-p --output-format json` の形 | サブコマンドは包みの一覧を作り直す。ほかは形が違えば読まずに既定へ落とす。記録する |
| 画面の文字 | ターンへ跳ぶときに読む、transcript 表示の最下行の文言と、指示の行の頭の記号 | 見つからなければ跳ぶのをやめる。記録する |

トランスクリプトは、手元の claude の版（読めるまでは確かめた版）より古い版の行を見ない。
長い履歴を初めて索引にするときに、昔の形の行でずれが溢れないようにするためである。
版の無い行（メタ行の多く）は、同じファイルの直前の行の版を使う。
他端末から降ろした写しは見ない。

`~/.claude` の項目は、最初の置き場（`~/.claude`）を見ない。
利用者が自分で置いたファイル（dotfiles の git など）と、Claude Code が足した項目を見分けられないためである。
2 つ目以降の置き場は hangar と Claude Code しか書かないので、リンクでない知らない項目は Claude Code が足したものと読める。
アカウントが 1 つなら、共有されない項目は生まれないので、見張らない。

利用者の発言でない行を見分ける目印（本文の頭のタグなど）は自由な文字列で、知っている集合で見張れない。
これは見本の試験で確かめる。

#### ずれの記録

ずれは、契約、値（たとえば `system.subtype=foo`）、claude の版、回数、最初と最後に見た時刻を持つ。
版は、その値を読んだ元（レジストリ、トランスクリプトの行、statusline の JSON）に載っている `version` を使い、無ければ手元の `claude --version` を使う。
記録は `~/.agent-hangar/compat.json` に置く。
端末ごとのもので、同期しない。
DB のマイグレーションを要らない形にするためにファイルにした。
同じ契約と値の組は 1 件にまとめて回数を数え、100 件を超えたら最後に見た時刻の古いものから落とす。
書き出しは 5 秒ごとと、サーバを閉じるときである。
レジストリは 500 ミリ秒ごとに読み直すので、ずれは登録が変わったときだけ数える。
`~/.claude` の項目は、同じ名前をサーバの寿命で 1 度だけ数える。

読む口は `GET /api/compat` で、確かめた版、手元の版、ずれの一覧を返す。
`GET /api/readiness` の応答の `compat` にも、確かめた版、手元の版、ずれの件数を載せる。
画面に出すのは設定の確認リストの 1 行だけで、ヘッダーと知らせの札には出さない。
```

「外のターミナルのセッション」の節の `  サブコマンド、`-p`、`-c`、`--bg`、id の無い `-r` などは包まない。` の行の後に足す。

```markdown
  サブコマンドの一覧は、サーバが起動のたびと claude のパスを変えたときに `claude --help` の Commands の節から作り直し、本体に書き込む。
  読めなければ組み込みの一覧（2.1.292 の Commands）を使い、組み込みとの差を Claude Code との互換のずれとして記録する。
  `hangar shell install` は組み込みの一覧で書き、動いているサーバが次の起動で書き直す。
```

「使用量」の節の `更新は定期ではなく、起動直後と応答完了のたびに 1 回である。起動直後の 1 回目は `rate_limits` が無いので、欠けた項目は直前の値を保つ。` の行の後に足す。

```markdown
`resets_at` は秒の UNIX 時刻として読む。
10^11 より大きい値はミリ秒と見てそのまま使い、Claude Code との互換のずれとして記録する。
```

同じ節の `tmux、claude、code、Node のパスの有無と実行権と版、…画面に出すコマンドを返す。` の行の後に足す。

```markdown
Claude Code との互換の要約（確かめた版、手元の claude の版、ずれの件数）も `compat` に載せる。
```

- [ ] **Step 9: 全部の試験を通す**

Run: `npm test`
Expected: PASS。

- [ ] **Step 10: コミットする**

```bash
git add packages/server/src/server.ts packages/server/src/server.test.ts docs/design.md
git commit -m "feat(server): wire the Claude Code compat watch into the server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 見本を採る道具

**Files:**
- Create: `packages/server/test/capture/scenario.ts`
- Create: `packages/server/test/capture/redact.ts`
- Test: `packages/server/test/capture/redact.test.ts`
- Create: `packages/server/test/capture/run.ts`
- Create: `scripts/capture-claude-fixtures.ts`
- Modify: `package.json`（根の `scripts`）

**Interfaces:**
- Consumes: `mangleCwd`（`provider/claude-code/discover.ts`）、`claudeVersionOf`（Task 8）、`Tmux`（`tmux/tmux.ts`、`socketPath` と `exec` を渡す）、`which`（`config/tools.ts`）。
- Produces: `SCENARIO = { name, first, queued, file, tools }`、`PLACEHOLDER`（`test/capture/scenario.ts`）。Task 15 の見本の試験が読む。
- Produces: `Secrets`、`Pairs`、`replacements(s)`、`redactText(text, pairs)`、`redactDeep(v, pairs)`、`redactTranscriptLine(rec, pairs)`、`redactStatusline(rec, pairs)`、`redactRegistry(rec, pairs)`、`redactAuth(rec, pairs)`、`redactAgents(rows, sessionId, pairs)`、`leaks(text, s): string[]`（`test/capture/redact.ts`）。
- Produces: `main(argv: string[]): Promise<void>`（`test/capture/run.ts`）と `npm run capture-claude-fixtures`。出力は `packages/server/test/fixtures/claude/<版>/` の `transcript.jsonl`、`subagents/agent-<id>.jsonl`、`registry.jsonl`、`statusline.jsonl`、`agents.json`、`auth-status.json`、`help.txt`、`version.txt`、`meta.json`（`{ version, sessionId, capturedAt }`）。

権限の確認で止まらない起動の仕方は、2.1.292 の `claude --help` で確かめた次の組にする。

- `--permission-mode dontAsk`：前もって許した道具のほかは、聞かずに断る。確認の画面で止まらない。
- `--allowedTools Bash Read Write Edit Glob Grep Agent TodoWrite TaskCreate TaskUpdate TaskList`：筋書きで使う道具だけを許す。サブエージェントの中の呼び出しにも効く。
- `--setting-sources project`：利用者の `settings.json`（フック、プラグイン、権限）を読ませない。`--settings` で渡す statusline の写しは読まれる。
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`：利用者の MCP を読ませない。
- `--disable-slash-commands`：スキルを読ませない（見本に実際のスキル名を残さない）。
- 新しいディレクトリでは最初に「このフォルダを信頼するか」を聞かれるので、画面に `trust` が出たら既定の答え（信頼する）で Enter を 1 度だけ押す。

- [ ] **Step 1: 筋書きと置き換えの値を書く**

`packages/server/test/capture/scenario.ts`

```ts
/**
 * 見本を採るときの筋書き。採る道具（run.ts）と見本の試験（../claudeFixtures.test.ts）が同じものを読む。
 * 指示の文には JSON で書き換わる記号（引用符、バックスラッシュ）を入れない。採る道具が本文の中から文字列のまま探すためである。
 */
export const SCENARIO = {
  /** -n で付ける名前。レジストリの name と、トランスクリプトの題名になる。 */
  name: 'hangar-fixture',
  /** 1 つ目の指示。ファイルを書き、タスクの道具を使い、Bash で 20 秒待つ。待っている間に 2 つ目の指示を積む。 */
  first: 'Do these steps in order and keep every reply short. 1) Use your task list tool (TodoWrite or TaskCreate, whichever you have) to record two tasks: write notes.txt, then list the directory. 2) Use the Write tool to create notes.txt containing the single word hello. 3) Use the Bash tool to run exactly: sleep 20 && ls',
  /** 作業中に打って積む 2 つ目の指示。サブエージェントを使わせる。 */
  queued: 'Next, use the Agent tool to start one general-purpose subagent that runs ls with the Bash tool in this directory and reports how many entries it saw. Then reply with that number only.',
  /** 1 つ目の指示で書かせるファイル。 */
  file: 'notes.txt',
  /** 許す道具。--permission-mode dontAsk と組み合わせて、確認の画面で止まらないようにする。 */
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'],
} as const;

/** 置き換えの値。見本には、伏せた値の代わりにこれだけが残る。 */
export const PLACEHOLDER = {
  tmp: '/tmp/hangar-fixture',
  work: '/tmp/hangar-fixture/work',
  home: '/Users/me',
  host: 'fixture-host',
  email: 'user@example.com',
  orgName: 'Example Org',
  orgId: '00000000-0000-4000-8000-000000000000',
  pidDomain: 'fixture',
  subscriptionType: 'max',
  costUsd: 0.01,
  /** 窓ごとの使用率と戻る時刻（秒）。知らない窓は 1% と 1,800,000,000 秒にする。 */
  usedPercent: { five_hour: 12, seven_day: 3 } as Record<string, number>,
  resetsAtSec: { five_hour: 1_800_000_000, seven_day: 1_800_500_000 } as Record<string, number>,
} as const;
```

- [ ] **Step 2: 伏せ方の落ちる試験を書く**

`packages/server/test/capture/redact.test.ts`（値はどれも作り物である）

```ts
import { describe, expect, it } from 'vitest';
import { leaks, redactAgents, redactAuth, redactDeep, redactRegistry, redactStatusline, redactTranscriptLine, replacements, type Secrets } from './redact.ts';

const S: Secrets = {
  tmp: '/var/folders/zz/abc/T/hangar-fixture-Q1',
  tmpReal: '/private/var/folders/zz/abc/T/hangar-fixture-Q1',
  home: '/Users/someone',
  host: 'someones-mac.local',
  email: 'someone@corp.example',
  orgName: 'Corp Example',
  orgId: '11111111-2222-4333-8444-555555555555',
};
const P = replacements(S);

describe('replacements と redactDeep', () => {
  it('一時ディレクトリ、その置き場の名前、ホームを決まった値に置き換える。鍵も置き換える', () => {
    const v = {
      cwd: '/private/var/folders/zz/abc/T/hangar-fixture-Q1/work',
      transcript_path: '/Users/someone/.claude/projects/-private-var-folders-zz-abc-T-hangar-fixture-Q1-work/x.jsonl',
      backups: { '/private/var/folders/zz/abc/T/hangar-fixture-Q1/work/notes.txt': { v: 1 } },
      n: 3,
    };
    expect(redactDeep(v, P)).toEqual({
      cwd: '/tmp/hangar-fixture/work',
      transcript_path: '/Users/me/.claude/projects/-tmp-hangar-fixture-work/x.jsonl',
      backups: { '/tmp/hangar-fixture/work/notes.txt': { v: 1 } },
      n: 3,
    });
  });
});

describe('redactTranscriptLine', () => {
  it('積んだ指示のほかの添付は、種類だけを残す', () => {
    expect(redactTranscriptLine({ type: 'attachment', attachment: { type: 'skill_listing', content: 'a private skill' }, cwd: S.tmpReal }, P)).toEqual({ type: 'attachment', attachment: { type: 'skill_listing' }, cwd: '/tmp/hangar-fixture' });
    const queued = { type: 'attachment', attachment: { type: 'queued_command', prompt: 'next', commandMode: 'prompt' } };
    expect(redactTranscriptLine(queued, P)).toEqual(queued);
  });
  it('利用者の発言でない user の行（isMeta）は、本文を伏せる', () => {
    expect(redactTranscriptLine({ type: 'user', isMeta: true, message: { role: 'user', content: 'Contents of /Users/someone/CLAUDE.md' } }, P)).toEqual({ type: 'user', isMeta: true, message: { role: 'user', content: '(redacted)' } });
  });
});

describe('redactStatusline', () => {
  it('使用率、戻る時刻、費用を決まった値にする。ミリ秒の戻る時刻はミリ秒のまま', () => {
    const raw = { session_id: 's', cost: { total_cost_usd: 0.37, total_duration_ms: 5 }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 1_760_000_000 }, seven_day: { used_percentage: 7, resets_at: 1_760_500_000_000 } }, cwd: S.tmpReal };
    expect(redactStatusline(raw, P)).toEqual({ session_id: 's', cost: { total_cost_usd: 0.01, total_duration_ms: 5 }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 3, resets_at: 1_800_500_000_000 } }, cwd: '/tmp/hangar-fixture' });
  });
});

describe('redactRegistry、redactAuth、redactAgents', () => {
  it('登録の pidDomain とパスを伏せる', () => {
    expect(redactRegistry({ pid: 1, sessionId: 's', cwd: `${S.tmpReal}/work`, pidDomain: 'abc', tmux: `${S.tmpReal}/tmux.sock,1,0` }, P)).toEqual({ pid: 1, sessionId: 's', cwd: '/tmp/hangar-fixture/work', pidDomain: 'fixture', tmux: '/tmp/hangar-fixture/tmux.sock,1,0' });
  });
  it('auth status のメールアドレス、組織、プラン、置き場を伏せる', () => {
    expect(redactAuth({ loggedIn: true, email: S.email, orgName: S.orgName, orgId: S.orgId, subscriptionType: 'enterprise', configDirectory: '/Users/someone/.claude' }, P)).toEqual({ loggedIn: true, email: 'user@example.com', orgName: 'Example Org', orgId: '00000000-0000-4000-8000-000000000000', subscriptionType: 'max', configDirectory: '/Users/me/.claude' });
  });
  it('agents はその会話の行だけを残す', () => {
    expect(redactAgents([{ sessionId: 'a', cwd: S.tmpReal }, { sessionId: 'b', cwd: '/Users/someone/x' }], 'a', P)).toEqual([{ sessionId: 'a', cwd: '/tmp/hangar-fixture' }]);
    expect(redactAgents('x', 'a', P)).toEqual([]);
  });
});

describe('leaks', () => {
  it('伏せたはずの値と、置き換えの値でないメールアドレスを見つける', () => {
    expect(leaks('ok /tmp/hangar-fixture user@example.com', S)).toEqual([]);
    expect(leaks('at /Users/someone/x and someone@corp.example', S)).toEqual(['ホーム', 'メールアドレス', 'メールアドレスらしい文字列']);
    expect(leaks('other@mail.example', S)).toEqual(['メールアドレスらしい文字列']);
  });
});
```

- [ ] **Step 3: 落ちるのを確かめる**

Run: `npx vitest run packages/server/test/capture/redact.test.ts`
Expected: FAIL。`./redact.ts` が無い。

- [ ] **Step 4: `redact.ts` を作る**

```ts
import { mangleCwd } from '../../src/provider/claude-code/discover.ts';
import { PLACEHOLDER } from './scenario.ts';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 伏せる値。採る道具が、その場の環境と auth status から集める。 */
export type Secrets = { tmp: string; tmpReal: string; home: string; host: string; email: string | null; orgName: string | null; orgId: string | null };
export type Pairs = [string, string][];

/**
 * 置き換えの組。長いものから当てる（短いものが長いものの一部を先に崩さないように）。
 * 一時ディレクトリとホームは、そのままの形と、Claude Code がプロジェクトの置き場の名前にする形（英数字以外を - にしたもの）の両方を当てる。
 * 3 文字より短い値は当てない。ありふれた文字列を崩さないためである。
 */
export function replacements(s: Secrets): Pairs {
  const pairs: Pairs = [
    [s.tmpReal, PLACEHOLDER.tmp], [s.tmp, PLACEHOLDER.tmp],
    [mangleCwd(s.tmpReal), mangleCwd(PLACEHOLDER.tmp)], [mangleCwd(s.tmp), mangleCwd(PLACEHOLDER.tmp)],
    [s.home, PLACEHOLDER.home], [mangleCwd(s.home), mangleCwd(PLACEHOLDER.home)],
    [s.host, PLACEHOLDER.host],
  ];
  if (s.email) pairs.push([s.email, PLACEHOLDER.email]);
  if (s.orgName) pairs.push([s.orgName, PLACEHOLDER.orgName]);
  if (s.orgId) pairs.push([s.orgId, PLACEHOLDER.orgId]);
  return pairs.filter(([from]) => from.length >= 3).sort((a, b) => b[0].length - a[0].length);
}

export function redactText(text: string, pairs: Pairs): string {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

/** 値を深く辿り、文字列と鍵に置き換えを当てる。鍵にパスを持つ記録（file-history-snapshot など）があるためである。 */
export function redactDeep(v: unknown, pairs: Pairs): unknown {
  if (typeof v === 'string') return redactText(v, pairs);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, pairs));
  if (isRec(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k, pairs), redactDeep(x, pairs)]));
  return v;
}

/** 中身を残す添付の種類。筋書きが作る、積んだ指示だけである。 */
const KEEP_ATTACHMENTS: ReadonlySet<string> = new Set(['queued_command']);

/**
 * トランスクリプトの 1 行を伏せる。
 * 添付は、積んだ指示のほかは種類だけを残す。添付には利用者の CLAUDE.md、スキルの一覧、MCP の道具、環境が入るためである。
 * 利用者の発言でない user の行（isMeta）も、本文を伏せる。
 */
export function redactTranscriptLine(rec: unknown, pairs: Pairs): unknown {
  if (!isRec(rec)) return rec;
  let r: Rec = rec;
  if (r.type === 'attachment' && isRec(r.attachment) && !KEEP_ATTACHMENTS.has(String(r.attachment.type))) r = { ...r, attachment: { type: r.attachment.type } };
  if (r.type === 'user' && r.isMeta === true && isRec(r.message)) r = { ...r, message: { ...r.message, content: '(redacted)' } };
  return redactDeep(r, pairs);
}

/** statusline の JSON を伏せる。使用率、戻る時刻、費用は実際の使用量なので、決まった値にする。戻る時刻の単位は保つ。 */
export function redactStatusline(rec: unknown, pairs: Pairs): unknown {
  const r = redactDeep(rec, pairs);
  if (!isRec(r)) return r;
  const out: Rec = { ...r };
  if (isRec(out.cost) && typeof out.cost.total_cost_usd === 'number') out.cost = { ...out.cost, total_cost_usd: PLACEHOLDER.costUsd };
  if (isRec(out.rate_limits)) {
    const rl: Rec = { ...out.rate_limits };
    for (const [k, w] of Object.entries(rl)) {
      if (!isRec(w)) continue;
      const next: Rec = { ...w };
      if (typeof w.used_percentage === 'number') next.used_percentage = PLACEHOLDER.usedPercent[k] ?? 1;
      if (typeof w.resets_at === 'number') {
        const sec = PLACEHOLDER.resetsAtSec[k] ?? 1_800_000_000;
        next.resets_at = w.resets_at > 1e11 ? sec * 1000 : sec;
      }
      rl[k] = next;
    }
    out.rate_limits = rl;
  }
  return out;
}

/** 登録を伏せる。pidDomain はその機械を指すので決まった値にする。 */
export function redactRegistry(rec: unknown, pairs: Pairs): unknown {
  const r = redactDeep(rec, pairs);
  return isRec(r) && typeof r.pidDomain === 'string' ? { ...r, pidDomain: PLACEHOLDER.pidDomain } : r;
}

/** auth status を伏せる。メールアドレス、組織名、組織の識別子、プランを決まった値にする。 */
export function redactAuth(rec: unknown, pairs: Pairs): unknown {
  const r = redactDeep(rec, pairs);
  if (!isRec(r)) return r;
  const out: Rec = { ...r };
  if (typeof out.email === 'string') out.email = PLACEHOLDER.email;
  if (typeof out.orgName === 'string') out.orgName = PLACEHOLDER.orgName;
  if (typeof out.orgId === 'string') out.orgId = PLACEHOLDER.orgId;
  if (typeof out.subscriptionType === 'string') out.subscriptionType = PLACEHOLDER.subscriptionType;
  return out;
}

/** agents --json から、その会話の行だけを残して伏せる。ほかの行は利用者の別の会話である。 */
export function redactAgents(rows: unknown, sessionId: string, pairs: Pairs): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => isRec(r) && r.sessionId === sessionId).map((r) => redactDeep(r, pairs));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 伏せ残しの名前（値そのものは出さない）。空なら書き出してよい。 */
export function leaks(text: string, s: Secrets): string[] {
  const named: [string, string | null][] = [
    ['一時ディレクトリ', s.tmp], ['一時ディレクトリの実体', s.tmpReal], ['一時ディレクトリの置き場の名前', mangleCwd(s.tmpReal)],
    ['ホーム', s.home], ['ホームの置き場の名前', mangleCwd(s.home)], ['ホスト名', s.host],
    ['メールアドレス', s.email], ['組織名', s.orgName], ['組織の識別子', s.orgId],
  ];
  const out = named.filter(([, v]) => v !== null && v.length >= 3 && text.includes(v)).map(([label]) => label);
  if ([...text.matchAll(EMAIL)].some((m) => m[0] !== PLACEHOLDER.email)) out.push('メールアドレスらしい文字列');
  return out;
}
```

- [ ] **Step 5: 伏せ方の試験が通るのを確かめる**

Run: `npx vitest run packages/server/test/capture/redact.test.ts`
Expected: PASS。

- [ ] **Step 6: 動かし方（`run.ts`）を書く**

`packages/server/test/capture/run.ts`

```ts
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from '../../src/config/tools.ts';
import { claudeVersionOf } from '../../src/provider/claude-code/compat/cli.ts';
import { mangleCwd } from '../../src/provider/claude-code/discover.ts';
import { Tmux, type TmuxExec } from '../../src/tmux/tmux.ts';
import { leaks, redactAgents, redactAuth, redactRegistry, redactStatusline, redactTranscriptLine, replacements, type Secrets } from './redact.ts';
import { SCENARIO } from './scenario.ts';

// 見本を採る道具。本物の claude を一時ディレクトリで動かすので、Claude の使用量を少し使う。CI では動かさない。
// 動かす前に利用者に聞く。入口は scripts/capture-claude-fixtures.ts（npm run capture-claude-fixtures）。

/** 見本の置き場。版ごとのディレクトリを作る。 */
const FIXTURES = fileURLToPath(new URL('../fixtures/claude', import.meta.url));
/** 専用の tmux サーバの中のセッション名。止めるのはこの名前だけである。 */
const TMUX_SESSION = 'hangar-fixture';
/** 筋書きのどの段も、これより待って進まなければ諦める。 */
const STEP_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const readText = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const jsonl = (text: string): unknown[] => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as unknown);
const toJsonl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * 子の claude と tmux に渡す環境。
 * Claude Code の中から動かしたときの変数（入れ子の起動を断らせるもの）と、外の tmux を指す変数を外す。
 * 自動更新は止める。採っている途中で版が変わると、見本の版がずれる。
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'TMUX', 'TMUX_PANE']) delete env[k];
  return env;
}

async function until(what: string, cond: () => boolean, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > limit) throw new Error(`${what}を待ちきれませんでした`);
    await sleep(250);
  }
}

export async function main(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const env = childEnv();
  const bin = process.env.HANGAR_CLAUDE_BIN ?? which('claude');
  const tmuxPath = which('tmux');
  if (!bin || !tmuxPath) throw new Error('claude と tmux が要ります');
  const claude = (args: string[]): string => spawnSync(bin, args, { encoding: 'utf8', env, timeout: 60_000 }).stdout ?? '';
  const versionText = claude(['--version']);
  const version = claudeVersionOf(versionText);
  if (!version) throw new Error(`claude --version を読めませんでした: ${versionText.trim()}`);
  const outDir = path.join(FIXTURES, version);
  if (fs.existsSync(outDir) && !force) throw new Error(`${outDir} はもうあります。採り直すときは --force を付けてください`);
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fixture-'));
  const tmpReal = fs.realpathSync(tmp);
  const work = path.join(tmpReal, 'work');
  fs.mkdirSync(work);
  // 専用のソケットを -S で名指しする。exec を自分で渡すのは、上の環境（変数を外したもの）で tmux サーバを起こすためである。
  const exec: TmuxExec = (file, args) => {
    const r = spawnSync(file, args, { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
  const tmux = new Tmux({ tmuxPath, socketPath: path.join(tmpReal, 'tmux.sock'), exec });
  const sessionId = crypto.randomUUID();
  const projectDir = path.join(claudeDir, 'projects', mangleCwd(work));
  const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
  const subagentDir = path.join(projectDir, sessionId, 'subagents');
  const statuslineFile = path.join(tmpReal, 'statusline.jsonl');
  const registryDir = path.join(claudeDir, 'sessions');

  // その会話の登録を、変わるたびに写す。
  const registry: unknown[] = [];
  let lastRegistry: string | null = null;
  const readRegistryText = (): string | null => {
    let names: string[] = [];
    try { names = fs.readdirSync(registryDir); } catch { return null; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const text = readText(path.join(registryDir, n));
      try { if ((JSON.parse(text) as { sessionId?: unknown }).sessionId === sessionId) return text; } catch { /* 書きかけ */ }
    }
    return null;
  };
  const statusNow = (): string | null => {
    if (lastRegistry === null) return null;
    try { return str((JSON.parse(lastRegistry) as { status?: unknown }).status); } catch { return null; }
  };
  const poll = setInterval(() => {
    const text = readRegistryText();
    if (text !== null && text !== lastRegistry) registry.push(JSON.parse(text));
    lastRegistry = text;
  }, 200);

  try {
    // statusline に渡る JSON を 1 行ずつ写すスクリプト。利用者の settings.json には触れず、--settings で差し込む。
    const writer = path.join(tmpReal, 'statusline.mjs');
    fs.writeFileSync(writer, [
      "import fs from 'node:fs';",
      "let s = '';",
      "process.stdin.on('data', (d) => { s += d; }).on('end', () => { fs.appendFileSync(process.argv[2], JSON.stringify(JSON.parse(s)) + '\\n'); process.stdout.write('fixture'); });",
      '',
    ].join('\n'));
    const settingsFile = path.join(tmpReal, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: [process.execPath, writer, statuslineFile].map((p) => JSON.stringify(p)).join(' ') } }));

    tmux.newSession({
      name: TMUX_SESSION, cwd: work, width: 200, height: 50,
      // 可変長の引数（--allowedTools、--mcp-config）は次の引数で閉じるように並べ、指示は最後に置く（spike 02）。
      command: [
        bin, '--allowedTools', ...SCENARIO.tools, '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
        '--setting-sources', 'project', '--disable-slash-commands', '--permission-mode', 'dontAsk',
        '--model', 'haiku', '--effort', 'low', '--settings', settingsFile, '--session-id', sessionId, '-n', SCENARIO.name,
        SCENARIO.first,
      ],
    });
    // 新しいディレクトリでは最初にフォルダを信頼するかを聞かれる。既定の答え（信頼する）で Enter を 1 度だけ押す。
    let trusted = false;
    await until('claude の起動', () => {
      if (!tmux.hasSession(TMUX_SESSION)) throw new Error('claude が起動の途中で終わりました。引数が通らなかった可能性があります');
      if (lastRegistry !== null) return true;
      if (!trusted && /trust/i.test(tmux.capturePane(TMUX_SESSION))) { tmux.sendKeys(TMUX_SESSION, 'Enter'); trusted = true; }
      return false;
    }, 60_000);
    // 1 つ目の指示の Bash（sleep 20）が走っている間に、2 つ目の指示を打って積む。
    await until('Bash の sleep', () => readText(transcriptFile).includes('sleep 20'));
    await sleep(2000);
    tmux.sendKeys(TMUX_SESSION, '-l', SCENARIO.queued);
    await sleep(500);
    tmux.sendKeys(TMUX_SESSION, 'Enter');
    // サブエージェントが走り、休みが 5 秒続いたら筋書きは終わり。
    let idleSince: number | null = null;
    await until('サブエージェントと休み', () => {
      const done = readText(transcriptFile).includes('"name":"Agent"') && fs.existsSync(subagentDir);
      idleSince = statusNow() === 'idle' ? (idleSince ?? Date.now()) : null;
      return done && idleSince !== null && Date.now() - idleSince >= 5000;
    }, 300_000);
    // 対話のセッションは動いているあいだだけ agents --json に並ぶので、終える前に読む。
    const agentsText = claude(['agents', '--json', '--all']);
    // 終える。/exit が効かなければ Ctrl+C を 2 回送る。
    tmux.sendKeys(TMUX_SESSION, '-l', '/exit');
    await sleep(300);
    tmux.sendKeys(TMUX_SESSION, 'Enter');
    try {
      await until('終了', () => readRegistryText() === null, 20_000);
    } catch {
      tmux.sendKeys(TMUX_SESSION, 'C-c');
      await sleep(500);
      tmux.sendKeys(TMUX_SESSION, 'C-c');
      await until('終了', () => readRegistryText() === null, 20_000);
    }
    await sleep(2000);

    const transcriptText = readText(transcriptFile);
    const subagents = (fs.existsSync(subagentDir) ? fs.readdirSync(subagentDir) : []).filter((n) => /^agent-[0-9a-zA-Z]+\.jsonl$/.test(n)).sort();
    const statusline = jsonl(readText(statuslineFile));
    const agentsRows: unknown = (() => { try { return JSON.parse(agentsText); } catch { return []; } })();
    const authText = claude(['auth', 'status', '--json']);
    const auth = JSON.parse(authText) as Record<string, unknown>;
    const helpText = claude(['--help']);
    const secrets: Secrets = { tmp, tmpReal, home: os.homedir(), host: os.hostname(), email: str(auth.email), orgName: str(auth.orgName), orgId: str(auth.orgId) };
    const pairs = replacements(secrets);

    // 筋書きが通ったかを確かめる。足りなければ書き出さない。
    const problems: string[] = [];
    if (transcriptText === '') problems.push('トランスクリプトがありません');
    if (subagents.length === 0) problems.push('サブエージェントのトランスクリプトがありません');
    if (!transcriptText.includes(SCENARIO.queued)) problems.push('積んだ指示がトランスクリプトにありません');
    if (registry.length < 2) problems.push('レジストリの写しが 2 つ未満です');
    if (statusline.length === 0) problems.push('statusline の JSON が届いていません（--settings の statusLine が効いていません）');
    if (redactAgents(agentsRows, sessionId, pairs).length === 0) problems.push('agents --json にこの会話がありません');
    if (problems.length > 0) throw new Error(`筋書きが通りませんでした:\n- ${problems.join('\n- ')}`);

    const files: Record<string, string> = {
      'transcript.jsonl': toJsonl(jsonl(transcriptText).map((r) => redactTranscriptLine(r, pairs))),
      'registry.jsonl': toJsonl(registry.map((r) => redactRegistry(r, pairs))),
      'statusline.jsonl': toJsonl(statusline.map((r) => redactStatusline(r, pairs))),
      'agents.json': JSON.stringify(redactAgents(agentsRows, sessionId, pairs), null, 2) + '\n',
      'auth-status.json': JSON.stringify(redactAuth(auth, pairs), null, 2) + '\n',
      'help.txt': helpText,
      'version.txt': versionText,
      'meta.json': JSON.stringify({ version, sessionId, capturedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n',
    };
    for (const n of subagents) files[`subagents/${n}`] = toJsonl(jsonl(readText(path.join(subagentDir, n))).map((r) => redactTranscriptLine(r, pairs)));
    const found = Object.entries(files).flatMap(([name, text]) => leaks(text, secrets).map((what) => `${name}: ${what}`));
    if (found.length > 0) throw new Error(`伏せ残しがあるので書き出しません:\n- ${found.join('\n- ')}`);

    fs.rmSync(outDir, { recursive: true, force: true });
    for (const [name, text] of Object.entries(files)) {
      const f = path.join(outDir, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    console.log(`${outDir} に書き出しました。`);
    for (const name of Object.keys(files).sort()) console.log(`  ${name}`);
    console.log('コミットする前に、伏せ残しが無いかを目で確かめてください。');
  } finally {
    clearInterval(poll);
    // 名指しのソケットの名指しのセッションだけを止める。kill-server は呼ばない。
    if (tmux.hasSession(TMUX_SESSION)) tmux.killSession(TMUX_SESSION);
    // その会話の記録を ~/.claude から消す。--all は決して渡さない。名指しのパスが一時ディレクトリの下であることを確かめてから渡す。
    if (work.startsWith(tmpReal + path.sep)) {
      const r = spawnSync(bin, ['purge', work, '-y'], { encoding: 'utf8', env, timeout: 60_000 });
      if (r.status !== 0) console.error(`claude purge が失敗しました。手で消してください: claude purge ${work} -y\n${r.stderr ?? ''}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
```

`scripts/capture-claude-fixtures.ts`

```ts
// Claude Code の見本を採る（packages/server/test/capture/run.ts）。
// 本物の claude を動かすので、Claude の使用量を少し使う。動かす前に利用者に聞く。CI では動かさない。
// 使い方：npm run capture-claude-fixtures（採り直すときは npm run capture-claude-fixtures -- --force）
import { main } from '../packages/server/test/capture/run.ts';

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

根の `package.json` の `scripts` に足す（`"hangar": "hangar"` の後）。

```json
    "capture-claude-fixtures": "tsx scripts/capture-claude-fixtures.ts"
```

（前の行 `"hangar": "hangar"` の末尾に `,` を足す。）

- [ ] **Step 7: 型と試験を通す**

Run: `npm run typecheck`
Expected: エラー無し（`packages/server/test/capture/run.ts` も server の tsconfig の `test` に含まれる）。

Run: `npx vitest run packages/server/test/capture/redact.test.ts`
Expected: PASS。

この段では道具を動かさない（Claude の使用量を使うため。動かすのは Task 14）。

- [ ] **Step 8: コミットする**

```bash
git add packages/server/test/capture/scenario.ts packages/server/test/capture/redact.ts packages/server/test/capture/redact.test.ts packages/server/test/capture/run.ts scripts/capture-claude-fixtures.ts package.json
git commit -m "feat: add the capture-claude-fixtures tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 最初の見本を採る（Claude の使用量を使うので、動かす前に利用者に聞く）

**Files:**
- Create: `packages/server/test/fixtures/claude/<版>/`（道具が書き出す）

**Interfaces:**
- Consumes: `npm run capture-claude-fixtures`（Task 13）。
- Produces: `packages/server/test/fixtures/claude/<版>/` の見本。Task 15 の試験が読む。`<版>` は採ったときの `claude --version` の版で、2.1.292 とは限らない。

- [ ] **Step 1: 動かす前に利用者に聞く**

AskUserQuestion で 1 問だけ聞く。推す案を先頭に置く。

- 問い：「見本を採るため、本物の claude（haiku、effort low）を一時ディレクトリで 1 回動かします。指示は 2 つ、サブエージェントは 1 回で、トークンは数万ほどの見込みです。動かしてよいですか」
- 選択肢：「動かす（推奨）」「今は動かさない」

「今は動かさない」なら、この計画の Task 14 と Task 15 を止め、報告に「見本は未採取」と書いて終える。

- [ ] **Step 2: 道具を動かす**

リポジトリの根（この worktree）で打つ。

Run: `npm run capture-claude-fixtures`
Expected: `packages/server/test/fixtures/claude/<版>/ に書き出しました。` と、書き出したファイルの一覧（`agents.json`、`auth-status.json`、`help.txt`、`meta.json`、`registry.jsonl`、`statusline.jsonl`、`subagents/agent-<id>.jsonl`、`transcript.jsonl`、`version.txt`）。

「筋書きが通りませんでした」で終わったときは、見本は書き出されていない。理由ごとに次のとおりにし、もう一度動かす前に Step 1 からやり直す（使用量を使うため）。

- `statusline の JSON が届いていません`：`run.ts` の起動の引数から `'--setting-sources', 'project',` を外す（`--settings` の statusLine が読まれていない）。
- `claude が起動の途中で終わりました`：起動の引数のどれかが通っていない。`claude --help` だけを打ち（会話は始めない）、`run.ts` の引数がすべて載っていること、`--effort` と `--permission-mode` の choices に `low` と `dontAsk` があることを確かめる。通らない引数を外したときは、`docs/design.md` の「確かめた版と見本」の段の書き方も同じに直す。
- `積んだ指示がトランスクリプトにありません`、`サブエージェントのトランスクリプトがありません`：トランスクリプトの写しは道具が消しているので、`run.ts` の待ち（`sleep 20` の後の 2 秒、`sendKeys` の間の 500 ミリ秒）を倍にする。

「伏せ残しがあるので書き出しません」で終わったときは、出た名前（ホーム、メールアドレスなど）を伏せる規則を `redact.ts` に足し、伏せ方の試験に同じ形の例を足してから、Step 1 からやり直す。

- [ ] **Step 3: 伏せ残しを目で確かめる**

Run: `grep -rnoE '/(Users|home)/[^/"]+|/var/folders|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' packages/server/test/fixtures/claude/[0-9]* | grep -vE '/Users/me$|user@example\.com$'`
Expected: 何も出ない。

`transcript.jsonl` と `subagents/*.jsonl` を開き、添付の行（`"type":"attachment"`）が積んだ指示のほかは `{"type":"…"}` だけになっていること、アシスタントの本文に手元の名前や組織名が無いことを目で確かめる。
`statusline.jsonl` の `used_percentage` が 12 と 3、`total_cost_usd` が 0.01 になっていることを確かめる。
`auth-status.json` の `email` が `user@example.com`、`orgName` が `Example Org` になっていることを確かめる。

- [ ] **Step 4: 後始末が済んだことを確かめる**

Run: `ls ~/.claude/projects | grep -c hangar-fixture`
Expected: `0`（`claude purge` がその会話の置き場を消した）。

Run: `ls "$(node -p 'require("os").tmpdir()')" | grep -c '^hangar-fixture-'`
Expected: `0`（一時ディレクトリも消えた）。

- [ ] **Step 5: コミットする**

```bash
git add packages/server/test/fixtures/claude
git commit -m "test: add the first captured Claude Code fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 見本の試験、確かめた版、README

**Files:**
- Create: `packages/server/test/claudeFixtures.ts`
- Test: `packages/server/test/claudeFixtures.test.ts`
- Modify: `packages/server/src/provider/claude-code/compat/version.ts`（採った版が 2.1.292 でなければ）
- Modify: `packages/server/src/provider/claude-code/compat/cli.ts`（`BUILTIN_SUBCOMMANDS`、最も新しい見本と違えば）
- Modify: `README.md`（「現状」の節）
- Modify: `docs/design.md`（「Claude Code との互換」の節の末尾）

**Interfaces:**
- Consumes: Task 3 から Task 14 のすべて。
- Produces: `ClaudeFixture = { version: string; dir: string; sessionId: string }`、`claudeFixtures(): ClaudeFixture[]`（版の古い順）、`newestClaudeFixture(): ClaudeFixture | null`、`readFixtureText(f, name)`、`readFixtureJsonl(f, name)`、`fixtureSubagents(f): string[]`（`packages/server/test/claudeFixtures.ts`）。Task 16 の照合が使う。

- [ ] **Step 1: 見本を読む道具を書く**

`packages/server/test/claudeFixtures.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';
import { compareClaudeVersions } from '@agent-hangar/shared';
import { FIXTURE_CLAUDE_DIR } from './fixtures.ts';

/** 採った見本 1 つ。dir は packages/server/test/fixtures/claude/<版>/ である。手書きの見本（同じ置き場の直下）とは別に置く。 */
export type ClaudeFixture = { version: string; dir: string; sessionId: string };
const VERSION_DIR = /^\d+\.\d+\.\d+$/;

/** 採った見本の一覧。版の古い順。 */
export function claudeFixtures(): ClaudeFixture[] {
  return fs.readdirSync(FIXTURE_CLAUDE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
    .map((e) => {
      const dir = path.join(FIXTURE_CLAUDE_DIR, e.name);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { sessionId: string };
      return { version: e.name, dir, sessionId: meta.sessionId };
    })
    .sort((a, b) => compareClaudeVersions(a.version, b.version));
}

export function newestClaudeFixture(): ClaudeFixture | null {
  return claudeFixtures().at(-1) ?? null;
}

export function readFixtureText(f: ClaudeFixture, name: string): string {
  return fs.readFileSync(path.join(f.dir, name), 'utf8');
}

export function readFixtureJsonl(f: ClaudeFixture, name: string): unknown[] {
  return readFixtureText(f, name).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as unknown);
}

/** サブエージェントのトランスクリプトの名前（subagents/agent-<id>.jsonl）。 */
export function fixtureSubagents(f: ClaudeFixture): string[] {
  const d = path.join(f.dir, 'subagents');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort().map((n) => `subagents/${n}`) : [];
}
```

- [ ] **Step 2: 見本の試験を書く**

`packages/server/test/claudeFixtures.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAuthStatus } from '../src/config/accountAuth.ts';
import { ensureShellScript, shellScriptPath } from '../src/config/shellHook.ts';
import { openDb } from '../src/db/open.ts';
import { IndexerService } from '../src/indexer/service.ts';
import { agentsJsonDrifts, authStatusDrifts, BUILTIN_SUBCOMMANDS, claudeVersionOf, parseHelp, subcommandsFromHelp } from '../src/provider/claude-code/compat/cli.ts';
import { registryDrifts } from '../src/provider/claude-code/compat/registry.ts';
import { statuslineDrifts } from '../src/provider/claude-code/compat/statusline.ts';
import { transcriptDrifts } from '../src/provider/claude-code/compat/transcript.ts';
import { VERIFIED_CLAUDE_VERSION } from '../src/provider/claude-code/compat/version.ts';
import { mangleCwd } from '../src/provider/claude-code/discover.ts';
import { readRegistry } from '../src/provider/claude-code/registry.ts';
import { parseJobs } from '../src/runs/procs.ts';
import { readEvents, subagentIds } from '../src/transcript/read.ts';
import { parseStatusline } from '../src/usage/statusline.ts';
import { PLACEHOLDER, SCENARIO } from './capture/scenario.ts';
import { claudeFixtures, fixtureSubagents, newestClaudeFixture, readFixtureJsonl, readFixtureText } from './claudeFixtures.ts';

// 採った見本（packages/server/test/fixtures/claude/<版>/）の試験。
// すべての版の見本について、ずれが 0 件であることと、主な読み取りが筋書き（capture/scenario.ts）どおりに取れることを確かめる。
// 落ちたら、その値を知っている集合に足すか、読み方を変えるかを決める。足すだけで済むか分からなければ、値と版を利用者に報告して止まる。

const fixtures = claudeFixtures();
const tmps: string[] = [];
const tmpDir = (prefix: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

it('採った見本が 1 つ以上ある', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

for (const f of fixtures) {
  describe(`Claude Code ${f.version} の見本`, () => {
    it('version.txt の版が置き場の名前と同じ', () => {
      expect(claudeVersionOf(readFixtureText(f, 'version.txt'))).toBe(f.version);
    });
    it('トランスクリプトのどの行もずれが無い。利用者と Claude の行は版を持つ', () => {
      for (const name of ['transcript.jsonl', ...fixtureSubagents(f)]) {
        const recs = readFixtureJsonl(f, name);
        expect(recs.flatMap((r) => transcriptDrifts(r)), name).toEqual([]);
        for (const r of recs as { type?: string; version?: string }[]) {
          if (r.type === 'user' || r.type === 'assistant') expect(r.version, name).toBe(f.version);
        }
      }
    });
    it('レジストリのどの写しもずれが無く、作業中と休みを通る。最後の写しを読める', () => {
      const recs = readFixtureJsonl(f, 'registry.jsonl');
      expect(recs.flatMap((r) => registryDrifts(r))).toEqual([]);
      const statuses = (recs as { status?: string }[]).map((r) => r.status);
      expect(statuses).toContain('busy');
      expect(statuses).toContain('idle');
      const dir = tmpDir('hangar-fx-reg-');
      fs.mkdirSync(path.join(dir, 'sessions'));
      const last = recs.at(-1) as { pid: number };
      fs.writeFileSync(path.join(dir, 'sessions', `${last.pid}.json`), JSON.stringify(last));
      expect(readRegistry(dir, () => false)).toEqual([expect.objectContaining({ sessionId: f.sessionId, name: SCENARIO.name, cwd: PLACEHOLDER.work })]);
    });
    it('statusline のどの JSON もずれが無く、モデルとコンテキストの大きさを読める。戻る時刻はミリ秒で読める', () => {
      const recs = readFixtureJsonl(f, 'statusline.jsonl');
      expect(recs.flatMap((r) => statuslineDrifts(r))).toEqual([]);
      const parsed = recs.map((r) => parseStatusline(r)!);
      expect(parsed.every((p) => p.providerSessionId === f.sessionId && p.model !== null)).toBe(true);
      expect(parsed.some((p) => p.contextSize !== null && p.contextSize > 0)).toBe(true);
      for (const p of parsed) {
        for (const w of [p.rateLimits?.fiveHour, p.rateLimits?.sevenDay]) if (w && w.resetsAt !== null) expect(w.resetsAt).toBeGreaterThan(1e12);
      }
    });
    it('auth status と agents の JSON にずれが無く、読める', () => {
      const auth = readFixtureText(f, 'auth-status.json');
      expect(authStatusDrifts(auth)).toEqual([]);
      expect(parseAuthStatus(auth, 0)).toMatchObject({ loggedIn: true, email: PLACEHOLDER.email });
      const agents = readFixtureText(f, 'agents.json');
      expect(agentsJsonDrifts(agents)).toEqual([]);
      // 対話のセッションだけなので、バックグラウンドの行は無い。
      expect(parseJobs(agents)).toEqual([]);
      expect(JSON.parse(agents)).toEqual([expect.objectContaining({ sessionId: f.sessionId, kind: 'interactive' })]);
    });
    it('--help からサブコマンドを読み、シェルの包みに書き込む', () => {
      const help = parseHelp(readFixtureText(f, 'help.txt'));
      expect(help).not.toBeNull();
      expect(help!.subcommands.length).toBeGreaterThan(5);
      const home = tmpDir('hangar-fx-shell-');
      ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(home, 'token'), tmuxPath: null, subcommands: subcommandsFromHelp(readFixtureText(f, 'help.txt')).subcommands });
      expect(fs.readFileSync(shellScriptPath(home), 'utf8')).toContain(`    ${help!.subcommands.join('|')}) command claude "$@"; return ;;`);
    });
    it('索引から、筋書きどおりのターン、積んだ指示、道具、サブエージェント、題名、使用量、ターンの終わりが取れる', async () => {
      const claudeDir = tmpDir('hangar-fx-claude-');
      const proj = path.join(claudeDir, 'projects', mangleCwd(PLACEHOLDER.work));
      fs.mkdirSync(path.join(proj, f.sessionId, 'subagents'), { recursive: true });
      fs.copyFileSync(path.join(f.dir, 'transcript.jsonl'), path.join(proj, `${f.sessionId}.jsonl`));
      for (const name of fixtureSubagents(f)) fs.copyFileSync(path.join(f.dir, name), path.join(proj, f.sessionId, name));
      const db = openDb(':memory:');
      try {
        await new IndexerService({ db, deviceId: 'd', claudeDir, isRunning: () => false }).fullScan();
        const s = db.prepare('select id, name from sessions where provider_session_id = ?').get(f.sessionId) as { id: string; name: string | null };
        expect(s.name).toBe(SCENARIO.name);
        const stats = db.prepare('select turns, input_tokens, output_tokens from session_stats where session_id = ?').get(s.id) as { turns: number; input_tokens: number; output_tokens: number };
        expect(stats.turns).toBe(2);
        expect(stats.input_tokens).toBeGreaterThan(0);
        expect(stats.output_tokens).toBeGreaterThan(0);
        const events = readEvents(db, s.id, { limit: 2000 }).events;
        expect(events.flatMap((e) => (e.kind === 'user' ? [e.text] : []))).toEqual(expect.arrayContaining([SCENARIO.first, SCENARIO.queued]));
        const tools = new Set(events.flatMap((e) => (e.kind === 'tool_call' ? [e.name] : [])));
        for (const t of ['Write', 'Bash', 'Agent']) expect(tools, t).toContain(t);
        expect(['TodoWrite', 'TaskCreate'].some((t) => tools.has(t))).toBe(true);
        expect(events.some((e) => e.kind === 'system' && e.subtype === 'turn_duration')).toBe(true);
        expect(subagentIds(db, s.id).length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });
}

// 組み込みの一覧は最も新しい版に合わせる。古い見本とは違ってよいので、最も新しい見本でだけ確かめる。
it('最も新しい見本の --help のサブコマンドは、組み込みの一覧と同じ', () => {
  const f = newestClaudeFixture()!;
  expect(subcommandsFromHelp(readFixtureText(f, 'help.txt'))).toEqual({ subcommands: [...BUILTIN_SUBCOMMANDS], drifts: [] });
});

it('確かめた版は最も新しい見本の版で、README にも書いてある', () => {
  expect(VERIFIED_CLAUDE_VERSION).toBe(newestClaudeFixture()!.version);
  const readme = fs.readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');
  expect(readme).toContain(`確かめた Claude Code の版は \`${VERIFIED_CLAUDE_VERSION}\` です`);
});

it('見本に、伏せたはずの値（手元のパス、一時ディレクトリ、メールアドレス）が残っていない', () => {
  const PRIVATE: [string, RegExp][] = [
    ['ホームのパス', /\/(?:Users|home)\/(?!me\b)[^/\s"\\]+/],
    ['一時ディレクトリのパス', /\/var\/folders\//],
    ['メールアドレス', /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ];
  for (const f of fixtures) {
    const names = fs.readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
    for (const file of names) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [label, re] of PRIVATE) expect(re.test(text), `${path.relative(f.dir, file)} に${label}`).toBe(false);
    }
  }
});
```

- [ ] **Step 3: 落ちるのを確かめる**

Run: `npx vitest run packages/server/test/claudeFixtures.test.ts`
Expected: FAIL。README に「確かめた Claude Code の版は」の行が無い。採った版が 2.1.292 でなければ、`VERIFIED_CLAUDE_VERSION` と、場合によって組み込みの一覧の比べも落ちる。

ほかの it が落ちたら、それは実物の形が契約と違うということである。
落ちた値と版を見て、次のどちらかを決める。

- 知っている集合（`compat/transcript.ts` などの `KNOWN_…`）に足して済む値なら、足す。足した値は正規化でどう扱われるか（読む、meta として残す、捨てる）を、その集合のコメントに書く。
- 読み方を変える必要がある値（`turn_duration` の名前が変わった、`status` の新しい値など）なら、この計画を止め、値と版を利用者に報告する。

- [ ] **Step 4: 確かめた版、組み込みの一覧、README を揃える**

`packages/server/src/provider/claude-code/compat/version.ts` の `VERIFIED_CLAUDE_VERSION` を、採った見本の版（`packages/server/test/fixtures/claude/` の下のディレクトリの名前）にする。

組み込みの一覧の比べが落ちたときは、`packages/server/src/provider/claude-code/compat/cli.ts` の `BUILTIN_SUBCOMMANDS` を、試験の出す `subcommands` と同じ並びにし、コメントの「2.1.292」を採った版にする。
同じ版にそろえて `packages/server/src/provider/claude-code/compat/cli.test.ts` の「組み込みの一覧は 2.1.292 の Commands で…」の it の期待と、`packages/server/src/config/shellHook.test.ts` の「渡さなければ組み込みの一覧を書く」の it の期待も直す。

`README.md` の「## 現状」の節の最初の段落（`フェーズ 5（デスクトップ配布）まで実装済みです。` の行）の後に足す。`2.1.292` は採った版にする。

```markdown
確かめた Claude Code の版は `2.1.292` です（見本は `packages/server/test/fixtures/claude/` にあります）。
より新しい版でも動かしますが、hangar が知らない形式に出会うと、`~/.agent-hangar/compat.json` に記録し、設定の確認リストで知らせます。
```

- [ ] **Step 5: 設計書に見本のことを書く**

`docs/design.md` の「### Claude Code との互換」の節の末尾（`## セッションの起動と観察` の直前）に足す。

```markdown
#### 確かめた版と見本

確かめた版は、見本のうち最も新しい版である（`VERIFIED_CLAUDE_VERSION`、README にも書く）。
手元の claude がそれより新しいときは「未確認の版」として知らせるが、止めはしない。

見本は `packages/server/test/fixtures/claude/<版>/` にあり、`npm run capture-claude-fixtures` で採る。
採る道具は、一時ディレクトリで本物の claude を haiku、effort low で動かし、決めた筋書き（タスクの道具を使う、ファイルを書く、Bash を動かす、作業中に次の指示を積む、サブエージェントを使う、終える）を流す。
権限の確認で止まらないよう、`--permission-mode dontAsk` と `--allowedTools` で、筋書きで使う道具だけを許す。
利用者の設定、MCP、スキルは読ませない（`--setting-sources project`、`--strict-mcp-config`、`--disable-slash-commands`）。
statusline の JSON は、`--settings` で差し込んだスクリプトで写す。
tmux は専用のソケットを `-S` で名指しし、止めるのはそのソケットのそのセッションだけで、`kill-server` は呼ばない。
終えたら、一時ディレクトリのパス、ホームのパス、ホスト名、メールアドレス、組織名、組織の識別子、使用率と費用を決まった値に伏せ、添付の中身を種類だけにしてから書き出す。
伏せ残しがあれば書き出さない。
最後に `claude purge <一時ディレクトリ> -y` で、その会話の記録を `~/.claude` から消す。
Claude の使用量を使うので CI では動かさず、動かす前に利用者に聞く。
採っているあいだ、動いている hangar はこの会話を一覧に出し、後始末の後は消えた会話として扱う。

見本の試験（`packages/server/test/claudeFixtures.test.ts`）は、すべての版の見本について、ずれが 0 件であることと、主な読み取り（ターンの数、積んだ指示、道具、サブエージェント、題名、使用量、ターンの終わり）が筋書きどおりに取れることを確かめる。
`--help` から作ったサブコマンドの一覧が組み込みの一覧と同じであることは、最も新しい見本でだけ確かめる。
組み込みの一覧は最も新しい版に合わせるので、古い見本とは違ってよい。
見本に手元のパスやメールアドレスが残っていないことも、この試験が確かめる。
手書きの見本（同じ置き場の直下）は、見本に現れない端のケースのために残す。
```

- [ ] **Step 6: 通るのを確かめる**

Run: `npx vitest run packages/server/test/claudeFixtures.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

Run: `npm test`
Expected: PASS（手書きの見本を使う試験も、版のディレクトリが増えたことで落ちない）。

- [ ] **Step 7: コミットする**

```bash
git add packages/server/test/claudeFixtures.ts packages/server/test/claudeFixtures.test.ts packages/server/src/provider/claude-code/compat/version.ts packages/server/src/provider/claude-code/compat/cli.ts packages/server/src/provider/claude-code/compat/cli.test.ts packages/server/src/config/shellHook.test.ts README.md docs/design.md
git commit -m "test: check every captured Claude Code fixture for zero drifts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: 週に 1 度の照合

**Files:**
- Create: `packages/server/test/claudeLive.test.ts`
- Create: `.github/workflows/claude-compat.yml`
- Modify: `docs/design.md`（「Claude Code との互換」の節の末尾）

**Interfaces:**
- Consumes: `parseHelp`、`claudeVersionOf`（Task 8）、`newestClaudeFixture`、`readFixtureText`（Task 15）。
- Produces: 環境変数 `HANGAR_LIVE_CLAUDE=1` のときだけ走る試験と、それを週に 1 度と手動で走らせるジョブ `claude-compat`。

claude の入れ方は npm の `@anthropic-ai/claude-code@latest` にする。
2026-10-07 に `npm view` で確かめたところ、`latest` は 2.1.292、`bin` は `claude`、`engines` は Node 22 以上で、`postinstall` が OS ごとの本体（`optionalDependencies` の `@anthropic-ai/claude-code-linux-x64` など）を置く。
いまの workflow と同じ `actions/setup-node@v7` の Node 22 の上で、`npm install -g` だけで入り、`--version` と `--help` に認証は要らない。

- [ ] **Step 1: 照合の試験を書く**

`packages/server/test/claudeLive.test.ts`

```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeVersionOf, parseHelp } from '../src/provider/claude-code/compat/cli.ts';
import { newestClaudeFixture, readFixtureText } from './claudeFixtures.ts';

/**
 * 週に 1 度の照合（.github/workflows/claude-compat.yml）だけが HANGAR_LIVE_CLAUDE=1 を立てる。ふだんの npm test では飛ぶ。
 * サブコマンドか引数が最も新しい見本と違えば落ちる。見本を採り直す合図である。
 * 版が新しいだけなら落とさない（版はほぼ毎日上がる）。
 */
const LIVE = process.env.HANGAR_LIVE_CLAUDE === '1';

describe.skipIf(!LIVE)('いまの claude と最も新しい見本', () => {
  it('サブコマンドと引数が、最も新しい見本の --help と同じ', () => {
    const bin = process.env.HANGAR_CLAUDE_BIN ?? 'claude';
    const version = claudeVersionOf(execFileSync(bin, ['--version'], { encoding: 'utf8' }));
    const now = parseHelp(execFileSync(bin, ['--help'], { encoding: 'utf8' }));
    const f = newestClaudeFixture()!;
    const want = parseHelp(readFixtureText(f, 'help.txt'))!;
    console.log(`claude ${version ?? '(版を読めない)'}、最も新しい見本 ${f.version}`);
    expect(now).not.toBeNull();
    expect(now!.subcommands).toEqual(want.subcommands);
    expect(now!.options).toEqual(want.options);
  });
});
```

- [ ] **Step 2: ふだんは飛び、立てると手元の claude で走ることを確かめる**

Run: `npx vitest run packages/server/test/claudeLive.test.ts`
Expected: 1 件が skipped。

Run: `HANGAR_LIVE_CLAUDE=1 npx vitest run packages/server/test/claudeLive.test.ts`
Expected: 手元の claude が最も新しい見本と同じ版なら PASS。版が違ってサブコマンドか引数が変わっていれば FAIL で、差が出る（これが週ごとのジョブの落ち方である）。`--version` と `--help` だけを打つので、Claude の使用量は使わない。
worktree の隔離で、変数を前に置いたこの形のコマンドが断られたときは、この 2 本目を飛ばし、Step 7 のマージ後の実行で確かめる。

- [ ] **Step 3: ジョブを書く**

`.github/workflows/claude-compat.yml`

```yaml
name: claude-compat
on:
  # 週に 1 度（月曜 0:00 UTC）と、手動で走らせる。
  schedule:
    - cron: '0 0 * * 1'
  workflow_dispatch:
# 既定の権限に頼らず、読み取りだけを渡す。
permissions:
  contents: read
# 手動と定期が重なっても、どちらも最後まで走らせる。照合は外の版を見るだけで、押し合うものが無い。
concurrency:
  group: claude-compat
  cancel-in-progress: false
jobs:
  compare:
    runs-on: ubuntu-latest
    # npm の取得が固まったときの上限。ふつうは数分で終わる。
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      # 最新の Claude Code を npm から入れる。postinstall が Linux の本体を置く。
      # --version と --help に認証は要らない。自動更新は止める。
      - name: 最新の Claude Code を入れる
        run: |
          npm install -g @anthropic-ai/claude-code@latest
          claude --version
        env:
          DISABLE_AUTOUPDATER: '1'
      # 照合の試験は better-sqlite3 も node-pty も読まないので、ネイティブのビルドを飛ばして入れる。
      - run: npm ci --ignore-scripts
      # サブコマンドか引数が最も新しい見本と違えば落ちる。見本を採り直す合図である（npm run capture-claude-fixtures）。
      - name: 最も新しい見本と突き合わせる
        run: npx vitest run --project server packages/server/test/claudeLive.test.ts
        env:
          HANGAR_LIVE_CLAUDE: '1'
          DISABLE_AUTOUPDATER: '1'
```

- [ ] **Step 4: 設計書に照合のことを書く**

`docs/design.md` の「### Claude Code との互換」の節の末尾（`## セッションの起動と観察` の直前）に足す。

```markdown
#### 週に 1 度の照合

GitHub Actions の `claude-compat`（`.github/workflows/claude-compat.yml`）が、週に 1 度と手動で、最新の claude を npm（`@anthropic-ai/claude-code`）から入れ、`claude --help` のサブコマンドと引数を最も新しい見本と突き合わせる（`packages/server/test/claudeLive.test.ts`）。
違っていればジョブを落とし、見本を採り直す合図にする。
版が新しいだけでは落とさない。
認証は要らない。
```

- [ ] **Step 5: 全部を通す**

Run: `npm run typecheck`
Expected: エラー無し。

Run: `npm test`
Expected: PASS（`claudeLive.test.ts` は skipped）。

- [ ] **Step 6: コミットする**

```bash
git add packages/server/test/claudeLive.test.ts .github/workflows/claude-compat.yml docs/design.md
git commit -m "ci: compare the latest claude --help with the newest fixture weekly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: マージの後に 1 度走らせる**

`claude-compat` は既定の枝にあるときだけ手動で走らせられるので、この段は PR をマージした後に行う。

Run: `gh workflow run claude-compat.yml`
Run: `gh run list --workflow claude-compat.yml --limit 1`
Expected: 数分のうちに `completed` と `success`。落ちたら、ログの「claude <版>、最も新しい見本 <版>」と差を見て、見本を採り直すか（Task 14 の手順、使用量を使うので先に利用者に聞く）を利用者に諮る。
