# プロジェクトを直接作る Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新しいセッションのダイアログでは「新しいフォルダ」と「未登録のフォルダ」も始める場所として選べ、起動と同時にプロジェクトになり、プロジェクト画面からは作成のダイアログでプロジェクトを作れるようにする。

**Architecture:** サーバに「フォルダを作る／既存を登録する」処理を 1 か所（`projects/create.ts`）にまとめ、昇格もそれを使う。`POST /api/projects` を 2 つの形にし、未登録フォルダの一覧 `GET /api/workspace/dirs` を足し、起動中に現れたワークスペース直下の新しいフォルダをその場で登録する。UI は Mediator に作成の領域（`projectCreate`）を足し、起動ダイアログは `place` 付きの送信で「作ってから起動」を runtime に頼む。Finder はデスクトップの殻の命令 `pick_folder`（tauri-plugin-dialog）で開く。

**Tech Stack:** TypeScript（Node 22、npm workspaces）、Hono、better-sqlite3、React 19、Vitest（jsdom）、Tauri v2（Rust）、tauri-plugin-dialog 2。

**Spec:** `docs/superpowers/specs/2026-10-01-new-project-ui-design.md`（試作は `docs/superpowers/specs/2026-10-01-new-project-ui/structure.html`）

## Global Constraints

- pnpm は使わない。npm workspaces のみ。worktree には node_modules が無いので、最初に `npm ci` する。
- UI の文言は仕様書のとおりに書く（下の各タスクに文字どおり載せた）。UI は常にライトで、ダークモードを足さない。
- コードのコメントは日本語で、周りの密度と言い回しにそろえる（「〜である」「〜する」）。
- 「hangar は利用者のファイルを消さない」。作った直後の空のフォルダ（と `git init` が作った `.git` だけ）以外は片付けで消さない。
- パスの比較は `normalizeDir`（`path.resolve` ＋ NFC）でそろえる。
- 名前の検証はサーバだけで行う。UI は送る前に止めない。
- テストの実行は `npx vitest run <path>`、型は `npm run typecheck`。
- commit のメッセージは英語の Conventional Commits で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- main へは直接 commit しない。ブランチ `worktree-new-project-ui` で作業する。

## Review Focus

- 一方のダイアログで Finder で選んだ結果が、閉じて別のダイアログを開いたときに勝手に当たらないこと（`pickedFolder` は共有の状態なので、開いた時点の回数より新しいものだけを使う）。→ Task 9 と Task 10 の試験。
- 作れたのに起動だけ失敗したとき、押し直しても二重に作らず、できたプロジェクトで起動し直すこと。→ Task 6 と Task 9 の試験。
- ディスク上の名前が NFD（濁点入りなど）のフォルダが、未登録の一覧に NFC のパスで出て、登録済みと正しく突き合うこと。→ Task 2 の試験。
- プロジェクトを作った直後に、そのフォルダが未登録の一覧に残り続けないこと（presenter が store のプロジェクトのパスで除く）。→ Task 9 の試験。
- 検索の語が既存のプロジェクトや未登録のフォルダの名前と同じときに、「『<語>』を新しいフォルダとして作る」を出さないこと。→ Task 9 の試験。

---

### Task 0: 作業場所の準備

- [ ] **Step 1: 依存を入れる**

Run: `cd /Users/satog/workspace/agent-hangar/.claude/worktrees/new-project-ui && npm ci`
Expected: 終わりに `added N packages`。エラーなし。

- [ ] **Step 2: 現状が緑であることを確かめる**

Run: `npx vitest run packages/server/src/projects packages/ui/src/mediator/transition.test.ts`
Expected: PASS

---

### Task 1: 作る処理をまとめる（`projects/create.ts`）と昇格の付け替え

**Files:**
- Create: `packages/server/src/projects/create.ts`
- Create: `packages/server/src/projects/create.test.ts`
- Modify: `packages/server/src/projects/registry.ts`（`insertProject` を足し、`syncProjectsFromWorkspace` から使う）
- Modify: `packages/server/src/projects/promote.ts`（手順 1 と 2 を `create.ts` の関数で置き換える）

**Interfaces:**
- Produces（registry.ts）: `insertProject(db: Db, deviceId: string, name: string, dir: string): string` — projects 行と、この端末の project_roots 行（resolved 1）を作り、プロジェクトの id を返す。
- Produces（create.ts）:
  - `class ProjectCreateError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) }`
  - `type CreateDeps = { db: Db; deviceId: string; workspaceRoot: string; gitInit?: (dir: string) => void }`
  - `checkDirName(raw: string): string` — 前後の空白を除いた名前を返す。だめなら `ProjectCreateError(400, NAME_RULE)`。
  - `makeProjectDir(workspaceRoot: string, name: string, gitInit: boolean, run?: (dir: string) => void): string` — `<root>/<name>` を作り（既にあれば 409）、`gitInit` なら `run`（既定は `git init`）を呼ぶ。失敗したら作ったものを片付けて 400。作ったディレクトリ（`normalizeDir` 済み）を返す。
  - `createProjectDir(deps: CreateDeps, o: { name: string; gitInit: boolean }): { projectId: string; dir: string }`
  - `registerProjectDir(deps: { db: Db; deviceId: string }, o: { path: string; name?: string }): { projectId: string; created: boolean }`
  - `exists(p: string): boolean`（シンボリックリンクも「ある」と数える。promote.ts と共有）

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/projects/create.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { createProjectDir, ProjectCreateError, registerProjectDir } from './create.ts';

let ws: string;
let db: Db;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-create-'));
  db = openDb(':memory:');
});
afterEach(() => { db.close(); fs.rmSync(ws, { recursive: true, force: true }); });

const deps = (over: { gitInit?: (dir: string) => void } = {}) => ({ db, deviceId: 'd', workspaceRoot: ws, gitInit: vi.fn(), ...over });
const rootOf = (id: string) => db.prepare('select path, resolved from project_roots where project_id = ? and device_id = ?').get(id, 'd');
const projectOf = (id: string) => db.prepare('select name, status, is_scratch from projects where id = ?').get(id);

describe('createProjectDir', () => {
  it('ワークスペースの下にフォルダを作り、git init し、プロジェクトとルートを作る', () => {
    const gitInit = vi.fn();
    const r = createProjectDir(deps({ gitInit }), { name: ' price-watcher ', gitInit: true });
    const dir = path.join(ws, 'price-watcher');
    expect(r.dir).toBe(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(gitInit).toHaveBeenCalledWith(dir);
    expect(projectOf(r.projectId)).toEqual({ name: 'price-watcher', status: 'active', is_scratch: 0 });
    expect(rootOf(r.projectId)).toEqual({ path: dir, resolved: 1 });
  });
  it('gitInit が偽なら git init を呼ばない', () => {
    const gitInit = vi.fn();
    createProjectDir(deps({ gitInit }), { name: 'p', gitInit: false });
    expect(gitInit).not.toHaveBeenCalled();
  });
  it('名前が空、. 、.. 、/ や \\ を含むなら 400 で断り、何も作らない', () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
      expect(() => createProjectDir(deps(), { name, gitInit: false })).toThrow(ProjectCreateError);
    }
    expect(fs.readdirSync(ws)).toEqual([]);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 0 });
  });
  it('同じ名前が既にあれば 409 で断り、既にあるものに触れない', () => {
    fs.mkdirSync(path.join(ws, 'taken'));
    fs.writeFileSync(path.join(ws, 'taken', 'keep.txt'), 'k');
    try {
      createProjectDir(deps(), { name: 'taken', gitInit: false });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectCreateError);
      expect((e as ProjectCreateError).status).toBe(409);
    }
    expect(fs.readFileSync(path.join(ws, 'taken', 'keep.txt'), 'utf8')).toBe('k');
  });
  it('git init に失敗したら作ったフォルダを片付けて 400 にする', () => {
    const gitInit = vi.fn((dir: string) => { fs.mkdirSync(path.join(dir, '.git')); throw new Error('no git'); });
    expect(() => createProjectDir(deps({ gitInit }), { name: 'broken', gitInit: true })).toThrow(/git init に失敗しました: no git/);
    expect(fs.existsSync(path.join(ws, 'broken'))).toBe(false);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 0 });
  });
  it('ワークスペースのルートが無ければ作る', () => {
    const nested = path.join(ws, 'not-yet', 'ws');
    const r = createProjectDir({ db, deviceId: 'd', workspaceRoot: nested, gitInit: vi.fn() }, { name: 'p', gitInit: false });
    expect(r.dir).toBe(path.join(nested, 'p'));
  });
});

describe('registerProjectDir', () => {
  it('既存のディレクトリを登録する。名前を省けば basename にする', () => {
    fs.mkdirSync(path.join(ws, 'old-kadai'));
    const r = registerProjectDir({ db, deviceId: 'd' }, { path: `${ws}/old-kadai/` });
    expect(r.created).toBe(true);
    expect(projectOf(r.projectId)).toMatchObject({ name: 'old-kadai', status: 'active' });
    expect(rootOf(r.projectId)).toEqual({ path: path.join(ws, 'old-kadai'), resolved: 1 });
  });
  it('名前を渡せばその名前にする。空の名前は 400', () => {
    fs.mkdirSync(path.join(ws, 'x'));
    expect(projectOf(registerProjectDir({ db, deviceId: 'd' }, { path: path.join(ws, 'x'), name: ' 表示名 ' }).projectId)).toMatchObject({ name: '表示名' });
    fs.mkdirSync(path.join(ws, 'y'));
    expect(() => registerProjectDir({ db, deviceId: 'd' }, { path: path.join(ws, 'y'), name: ' ' })).toThrow(ProjectCreateError);
  });
  it('無いパスとファイルは 400', () => {
    fs.writeFileSync(path.join(ws, 'file'), '');
    for (const p of ['/nonexistent-hangar', path.join(ws, 'file'), '']) {
      expect(() => registerProjectDir({ db, deviceId: 'd' }, { path: p })).toThrow('path が存在するディレクトリではありません');
    }
  });
  it('登録済みのパスなら既存を返し、.. を含んでも同じものに当てる', () => {
    fs.mkdirSync(path.join(ws, 'b'));
    const a = registerProjectDir({ db, deviceId: 'd' }, { path: path.join(ws, 'b') });
    const again = registerProjectDir({ db, deviceId: 'd' }, { path: `${ws}/b/../b`, name: '別名' });
    expect(again).toEqual({ projectId: a.projectId, created: false });
    expect(projectOf(a.projectId)).toMatchObject({ name: 'b' });
    expect(db.prepare('select count(*) c from project_roots').get()).toEqual({ c: 1 });
  });
  it('登録済みのプロジェクトがアーカイブなら Active に戻す', () => {
    fs.mkdirSync(path.join(ws, 'arch'));
    upsertShared(db, 'projects', { id: 'p-arch', name: 'arch', status: 'archived', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r-arch', project_id: 'p-arch', device_id: 'd', path: path.join(ws, 'arch'), resolved: 1 }, 'd');
    expect(registerProjectDir({ db, deviceId: 'd' }, { path: path.join(ws, 'arch') })).toEqual({ projectId: 'p-arch', created: false });
    expect(projectOf('p-arch')).toMatchObject({ status: 'active' });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/projects/create.test.ts`
Expected: FAIL（`Failed to resolve import "./create.ts"`）

- [ ] **Step 3: registry.ts に `insertProject` を足し、`syncProjectsFromWorkspace` を付け替える**

`packages/server/src/projects/registry.ts` の `syncProjectsFromWorkspace` の上に足す:

```ts
/** プロジェクト行と、この端末のルート（解決済み）を作る。作ったプロジェクトの id を返す。 */
export function insertProject(db: Db, deviceId: string, name: string, dir: string): string {
  const id = newId();
  upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, deviceId);
  upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
  return id;
}
```

`syncProjectsFromWorkspace` のループの中の 3 行（`const id = newId();` から `upsertShared(db, 'project_roots', …)` まで）を次に替える:

```ts
    created.push(insertProject(db, deviceId, path.basename(dir), dir));
```

- [ ] **Step 4: `create.ts` を書く**

`packages/server/src/projects/create.ts`:

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { insertProject, normalizeDir } from './registry.ts';

/** 作れなかった理由。status はそのまま HTTP の状態にする。 */
export class ProjectCreateError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'ProjectCreateError';
  }
}

export type CreateDeps = { db: Db; deviceId: string; workspaceRoot: string; gitInit?: (dir: string) => void };

export const NAME_RULE = '名前はディレクトリ名として使える 1 字以上で、/ を含められません';

const defaultGitInit = (dir: string) => {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
};

/** シンボリックリンクも「ある」と数える。リンク先が壊れていても上書きしないためである。 */
export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ディレクトリ名として使える名前か。前後の空白を除いた名前を返す。 */
export function checkDirName(raw: string): string {
  const name = raw.trim();
  const bad = !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.basename(name) !== name;
  if (bad) throw new ProjectCreateError(400, NAME_RULE);
  return name;
}

/**
 * 作ったばかりのディレクトリを片付ける。
 * 空のときと、git init が作った .git だけが入っているときに限って消す。
 * 見覚えのないものが入っていれば消さずに残す。
 * hangar は利用者のファイルを消さないので、片付けはここまでである。
 */
function removeFreshDir(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  if (entries.length === 0) {
    fs.rmdirSync(dir);
    return;
  }
  if (entries.length === 1 && entries[0] === '.git') {
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    fs.rmdirSync(dir);
  }
}

/** `<root>/<name>` を作り、選ばれていれば git init する。失敗したら作ったものを片付けて断る。 */
export function makeProjectDir(workspaceRoot: string, name: string, gitInit: boolean, run: (dir: string) => void = defaultGitInit): string {
  const dir = normalizeDir(path.join(workspaceRoot, name));
  if (exists(dir)) throw new ProjectCreateError(409, `${dir} は既にあります`);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  try {
    // recursive を付けないので、直前に誰かが作っていれば EEXIST で止まり、既にあるものを取り込まない。
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectCreateError(409, `${dir} は既にあります`);
    throw e;
  }
  try {
    if (gitInit) run(dir);
  } catch (e) {
    removeFreshDir(dir);
    throw new ProjectCreateError(400, `git init に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
  return dir;
}

/** ワークスペースの下に新しいフォルダを作り、プロジェクトにする。 */
export function createProjectDir(deps: CreateDeps, o: { name: string; gitInit: boolean }): { projectId: string; dir: string } {
  const name = checkDirName(o.name);
  const dir = makeProjectDir(deps.workspaceRoot, name, o.gitInit, deps.gitInit);
  const projectId = deps.db.transaction(() => insertProject(deps.db, deps.deviceId, name, dir))();
  return { projectId, dir };
}

/**
 * 既存のディレクトリをプロジェクトにする。
 * 同じパスが登録済みなら既存を返し、アーカイブなら Active に戻す（登録し直すのは、使うという意思の表れなので）。
 */
export function registerProjectDir(deps: { db: Db; deviceId: string }, o: { path: string; name?: string }): { projectId: string; created: boolean } {
  const name = o.name === undefined ? undefined : o.name.trim();
  if (name === '') throw new ProjectCreateError(400, 'name を空にはできません');
  const raw = o.path.trim();
  // `..` や末尾の `/` が残ると project_roots の前方一致に cwd が当たらず、
  // そのプロジェクトには永久にセッションが紐づかない。必ず正規化してから入れる。
  const dir = raw ? normalizeDir(raw) : '';
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new ProjectCreateError(400, 'path が存在するディレクトリではありません');
  const known = deps.db.prepare(`select r.project_id id from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.path = ? and r.deleted_at is null and p.deleted_at is null`).get(deps.deviceId, dir) as { id: string } | undefined;
  if (known) {
    const row = deps.db.prepare('select * from projects where id = ?').get(known.id) as Record<string, unknown>;
    if (row.status === 'archived') upsertShared(deps.db, 'projects', { ...row, status: 'active' }, deps.deviceId);
    return { projectId: known.id, created: false };
  }
  return { projectId: insertProject(deps.db, deps.deviceId, name ?? path.basename(dir), dir), created: true };
}
```

- [ ] **Step 5: promote.ts を付け替える**

`packages/server/src/projects/promote.ts` で:

1. `PromoteError` クラスの定義を消し、次に替える（既存の `import { PromoteError }` と `new PromoteError(…)` と `instanceof PromoteError` はそのまま動く）:

```ts
/** 昇格の失敗。作る処理と同じ型にして、HTTP の側の扱いをそろえる。 */
export const PromoteError = ProjectCreateError;
export type PromoteError = ProjectCreateError;
```

2. 先頭の import を次に替える（`execFileSync`、`newId`、`upsertShared` の import は、ほかで使っていなければ消す）:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { checkDirName, exists, makeProjectDir, ProjectCreateError } from './create.ts';
import { insertProject } from './registry.ts';
import { isUnderScratch, scratchRoot } from './scratch.ts';
```

3. `defaultGitInit`、`exists`、`removeFreshDir` の定義を消す（create.ts に移した）。

4. `promoteSession` の頭から「2. プロジェクトとこの端末のルート」までを次に替える:

```ts
  const s = deps.db.prepare('select id, cwd from sessions where id = ? and deleted_at is null').get(o.sessionId) as { id: string; cwd: string } | undefined;
  if (!s) throw new PromoteError(404, 'セッションが見つかりません');
  const name = checkDirName(o.name);
  if (!isUnderScratch(deps.home, s.cwd)) throw new PromoteError(400, 'このセッションはスクラッチではありません');

  // 1. ディレクトリを作り、必要なら git init。失敗したら作ったものを片付けて終える（create.ts）。
  const dir = makeProjectDir(deps.workspaceRoot, name, o.gitInit, deps.gitInit);

  // 2. プロジェクトとこの端末のルート。3. セッションの紐づけ。
  let projectId = '';
  const write = deps.db.transaction(() => {
    projectId = insertProject(deps.db, deps.deviceId, name, dir);
    const row = deps.db.prepare('select * from sessions where id = ?').get(s.id) as Record<string, unknown>;
    upsertShared(deps.db, 'sessions', { ...row, project_id: projectId }, deps.deviceId);
  });
  write();
```

4 番目の手順（ファイルの移動）は変えない。

- [ ] **Step 6: 試験を回す**

Run: `npx vitest run packages/server/src/projects`
Expected: PASS（create.test.ts、promote.test.ts、registry.test.ts のすべて）。promote.test.ts が `toThrow(PromoteError)` や文言で落ちたら、文言（`NAME_RULE`、`${dir} は既にあります`、`git init に失敗しました: …`）が元と同じかを確かめる。試験の側は変えない。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/projects
git commit -m "refactor(server): share making and registering project folders with promote

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 未登録フォルダの一覧と、直下の新しいフォルダの登録（registry.ts）

**Files:**
- Modify: `packages/server/src/projects/registry.ts`
- Test: `packages/server/src/projects/registry.test.ts`

**Interfaces:**
- Consumes: `insertProject`（Task 1）
- Produces:
  - `type WorkspaceDir = { name: string; path: string }`
  - `listWorkspaceDirs(db: Db, deviceId: string, workspaceRoot: string): WorkspaceDir[]` — 直下の隠しでないディレクトリのうち、この端末の論理削除されていないルートに当たらないもの。名前順。パスは NFC。
  - `registerWorkspaceChildOf(db: Db, deviceId: string, workspaceRoot: string, cwd: string): string | null` — cwd がワークスペース直下のディレクトリ（またはその下）にあり、そのディレクトリが実在し、隠しでなく、未登録なら、プロジェクトにしてその id を返す。ほかは null。

- [ ] **Step 1: 失敗する試験を足す**

`packages/server/src/projects/registry.test.ts` の import に `listWorkspaceDirs, registerWorkspaceChildOf` を足し、末尾に足す（`beforeEach` で `alpha`、`beta`、`alpha-v2`、`.hidden` が作られている）:

```ts
describe('listWorkspaceDirs', () => {
  it('登録済みと隠しを除いた直下のディレクトリを、名前順に返す', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(listWorkspaceDirs(db, DEV, ws)).toEqual([
      { name: 'alpha-v2', path: path.join(ws, 'alpha-v2') },
      { name: 'beta', path: path.join(ws, 'beta') },
    ]);
  });
  it('一覧から削除したプロジェクトのフォルダは、未登録に数える', () => {
    const { created } = syncProjectsFromWorkspace(db, DEV, ws);
    resolveProject(db, DEV, created[0]!, { kind: 'unlink' });
    expect(listWorkspaceDirs(db, DEV, ws).map((d) => d.name)).toContain('alpha');
  });
  it('ディスク上の名前が NFD でも、NFC のパスで返し、NFC で登録済みのものは除く', () => {
    const nfd = 'デ'.normalize('NFD');
    fs.mkdirSync(path.join(ws, nfd));
    fs.mkdirSync(path.join(ws, `ガ${nfd}`.normalize('NFD')));
    upsertShared(db, 'project_roots', { id: 'r-nfc', project_id: 'p-nfc', device_id: DEV, path: path.join(ws, 'デ'), resolved: 1 }, DEV);
    const names = listWorkspaceDirs(db, DEV, ws).map((d) => d.name);
    expect(names).not.toContain('デ');
    expect(names).toContain('ガデ');
    expect(listWorkspaceDirs(db, DEV, ws).every((d) => d.path === d.path.normalize('NFC'))).toBe(true);
  });
  it('ルートが無ければ空', () => {
    expect(listWorkspaceDirs(db, DEV, path.join(ws, 'nope'))).toEqual([]);
  });
});

describe('registerWorkspaceChildOf', () => {
  it('直下の未登録のディレクトリの下の cwd なら、そのディレクトリをプロジェクトにする', () => {
    const id = registerWorkspaceChildOf(db, DEV, ws, path.join(ws, 'beta', 'src', 'deep'));
    expect(id).not.toBeNull();
    expect(project(id!)).toMatchObject({ name: 'beta', status: 'active', is_scratch: 0 });
    expect(root(id!)).toMatchObject({ path: path.join(ws, 'beta'), resolved: 1 });
  });
  it('外、ワークスペースそのもの、隠し、無いディレクトリ、登録済みなら null', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    for (const cwd of ['/somewhere/else', ws, path.join(ws, '.hidden'), path.join(ws, 'gone'), path.join(ws, 'alpha')]) {
      expect(registerWorkspaceChildOf(db, DEV, ws, cwd)).toBeNull();
    }
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
  });
  it('cwd が NFD でも NFC のパスで登録する', () => {
    const nfd = 'ゲーム'.normalize('NFD');
    fs.mkdirSync(path.join(ws, nfd));
    const id = registerWorkspaceChildOf(db, DEV, ws, path.join(ws, nfd));
    expect(root(id!)).toMatchObject({ path: path.join(ws, 'ゲーム') });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/projects/registry.test.ts`
Expected: FAIL（`listWorkspaceDirs is not a function` など）

- [ ] **Step 3: 実装する**

`registry.ts` の `workspaceProjectCount` の上に足す:

```ts
export type WorkspaceDir = { name: string; path: string };

/** この端末の、論理削除されていないルートのパス（NFC）。 */
function knownRoots(db: Db, deviceId: string): Set<string> {
  return new Set((db.prepare('select path from project_roots where device_id = ? and deleted_at is null').all(deviceId) as { path: string }[]).map((r) => r.path.normalize('NFC')));
}

/**
 * ワークスペース直下の、まだプロジェクトになっていないディレクトリ。
 * 新しいセッションのダイアログの検索と、作成のダイアログの一覧に出す。
 * 一覧から削除したプロジェクトのフォルダは、ルートが論理削除されているので未登録に数える。
 */
export function listWorkspaceDirs(db: Db, deviceId: string, workspaceRoot: string): WorkspaceDir[] {
  const known = knownRoots(db, deviceId);
  return childDirs(workspaceRoot).filter((dir) => !known.has(dir)).map((dir) => ({ name: path.basename(dir), path: dir }));
}

/**
 * 起動中に現れた未分類のセッションのための、その場の自動登録。
 * cwd がワークスペース直下のディレクトリ（またはその下）にあり、そのディレクトリが実在し、隠しでなく、未登録なら、
 * 起動時の syncProjectsFromWorkspace と同じ規則でプロジェクトにして id を返す。
 * ワークスペースの外とワークスペースそのものは null（未分類に残し、利用者に知らせる）。
 */
export function registerWorkspaceChildOf(db: Db, deviceId: string, workspaceRoot: string, cwd: string): string | null {
  const root = normalizeDir(workspaceRoot);
  const c = normalizeDir(cwd);
  if (!c.startsWith(root + '/')) return null;
  const head = c.slice(root.length + 1).split('/')[0]!;
  if (head.startsWith('.')) return null;
  const dir = path.join(root, head);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  if (knownRoots(db, deviceId).has(dir)) return null;
  return insertProject(db, deviceId, head, dir);
}
```

`syncProjectsFromWorkspace` の `known` の作り方も `knownRoots(db, deviceId)` に替えてよい（同じ値）。

- [ ] **Step 4: 試験を回す**

Run: `npx vitest run packages/server/src/projects/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/projects/registry.ts packages/server/src/projects/registry.test.ts
git commit -m "feat(server): list unregistered workspace folders and register a new one for a session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: HTTP（`POST /api/projects` の 2 つの形、`GET /api/workspace/dirs`）と shared の型

**Files:**
- Modify: `packages/shared/src/api.ts`（`ProjectPlace`、`WorkspaceDirDto`）
- Modify: `packages/server/src/http/app.ts`
- Test: `packages/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: `createProjectDir`、`registerProjectDir`、`ProjectCreateError`（Task 1）、`listWorkspaceDirs`（Task 2）
- Produces（shared）:
  - `type ProjectPlace = { kind: 'newDir'; name: string; gitInit: boolean } | { kind: 'dir'; path: string; name?: string }`
  - `type WorkspaceDirDto = { name: string; path: string }`
- Produces（HTTP）:
  - `POST /api/projects` 本文 `ProjectPlace`（`kind` を省いた `{ name, path }` は `dir`）→ `ProjectDto`。新しく作ったら 201、登録済みなら 200。どちらも `project.upsert` を配る。失敗は `{ error }` と `ProjectCreateError.status`。
  - `GET /api/workspace/dirs` → `WorkspaceDirDto[]`
- Produces（AppDeps）: `gitInit?: (dir: string) => void`（試験で git を呼ばないため）

- [ ] **Step 1: shared の型を足す**

`packages/shared/src/api.ts` の `PromoteResultDto` の下に足す:

```ts
/** プロジェクトを作る場所。newDir はワークスペースの下に新しく作り、dir は既存のディレクトリを登録する。 */
export type ProjectPlace = { kind: 'newDir'; name: string; gitInit: boolean } | { kind: 'dir'; path: string; name?: string };
/** ワークスペース直下の、まだプロジェクトになっていないディレクトリ。 */
export type WorkspaceDirDto = { name: string; path: string };
```

`packages/shared/src/index.ts` が `api.ts` を丸ごと再輸出していることを確かめる（していなければ足す）。

- [ ] **Step 2: 失敗する試験を書く**

`packages/server/src/http/app.test.ts` の `it('プロジェクトの作成', …)` の後ろに足す（`deps` は beforeEach で作られる。`settings.workspaceRoot` は `ws`）:

```ts
  const postProject = (body: unknown) => app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('新しいフォルダを作ってプロジェクトにする', async () => {
    const gitInit = vi.fn();
    app = createApp({ ...deps, gitInit });
    const r = await postProject({ kind: 'newDir', name: 'fresh', gitInit: true });
    expect(r.status).toBe(201);
    const p = await r.json();
    expect(p).toMatchObject({ name: 'fresh', path: `${ws}/fresh`, resolved: true, status: 'active' });
    expect(gitInit).toHaveBeenCalledWith(`${ws}/fresh`);
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: p.id } });
    expect((await postProject({ kind: 'newDir', name: 'fresh', gitInit: false })).status).toBe(409);
    const bad = await postProject({ kind: 'newDir', name: 'a/b', gitInit: false });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('名前はディレクトリ名として使える 1 字以上で、/ を含められません');
    expect((await postProject({ kind: 'newDir', gitInit: false })).status).toBe(400);
  });
  it('kind が dir なら既存のフォルダを登録し、名前を省けば basename にする', async () => {
    fs.mkdirSync(`${ws}/gamma`);
    const r = await postProject({ kind: 'dir', path: `${ws}/gamma` });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ name: 'gamma', path: `${ws}/gamma` });
    expect((await postProject({ kind: 'other', path: ws })).status).toBe(400);
  });
  it('未登録のフォルダの一覧を返す', async () => {
    fs.mkdirSync(`${ws}/delta`);
    fs.mkdirSync(`${ws}/.secret`);
    const r = await get('/api/workspace/dirs');
    expect(r.status).toBe(200);
    const names = ((await r.json()) as { name: string }[]).map((d) => d.name);
    // alpha は beforeEach で登録済み。bin は exe() で作られることがある。
    expect(names).toContain('delta');
    expect(names).not.toContain('alpha');
    expect(names).not.toContain('.secret');
  });
```

`get` が試験の中で別名なら、ファイルの中の既存の GET の書き方（`await get('/api/projects')` の行、284 行付近）に合わせる。

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts -t "新しいフォルダを作って|kind が dir|未登録のフォルダの一覧"`
Expected: FAIL

- [ ] **Step 4: app.ts を書き換える**

1. import を足す:

```ts
import { createProjectDir, ProjectCreateError, registerProjectDir } from '../projects/create.ts';
```

`registry.ts` の import に `listWorkspaceDirs` を足す。`normalizeDir` を `POST /api/projects` 以外で使っていなければ import から外す。

2. `AppDeps`（77 行付近の `promote:` の隣）に足す:

```ts
  /** 新しいフォルダの git init。試験では差し替えて git を呼ばない。省けば git init を実行する。 */
  gitInit?: (dir: string) => void;
```

3. `api.post('/projects', …)` の本体を次に替える:

```ts
  api.post('/projects', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { kind?: unknown; name?: unknown; path?: unknown; gitInit?: unknown };
    try {
      let projectId: string;
      let created = true;
      if (body.kind === 'newDir') {
        if (typeof body.name !== 'string') return c.json({ error: 'name は必須です' }, 400);
        ({ projectId } = createProjectDir({ db, deviceId, workspaceRoot: deps.settings().workspaceRoot, gitInit: deps.gitInit }, { name: body.name, gitInit: body.gitInit === true }));
      } else {
        // kind を省いた { name, path } は、フェーズ 2 からの既存のディレクトリの登録である。
        if (body.kind !== undefined && body.kind !== 'dir') return c.json({ error: 'kind は newDir か dir です' }, 400);
        if (typeof body.path !== 'string') return c.json({ error: 'path が存在するディレクトリではありません' }, 400);
        ({ projectId, created } = registerProjectDir({ db, deviceId }, { path: body.path, name: typeof body.name === 'string' ? body.name : undefined }));
      }
      const p = getProject(db, deviceId, deps.live(), projectId)!;
      // 登録済みでも配る。アーカイブから戻したときに、ほかの画面の状態も変わるためである。
      deps.hub.broadcast({ type: 'project.upsert', project: p });
      return c.json(p, created ? 201 : 200);
    } catch (e) {
      if (e instanceof ProjectCreateError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  api.get('/workspace/dirs', (c) => c.json(listWorkspaceDirs(db, deviceId, deps.settings().workspaceRoot)));
```

4. `api.post('/sessions/:id/promote', …)` の `catch` の `e instanceof PromoteError` はそのままでよい（同じクラス）。

- [ ] **Step 5: 試験を回す**

Run: `npx vitest run packages/server/src/http/app.test.ts`
Expected: PASS（既存の「プロジェクトの作成」も含む。`{ name: '', path: ws }` は `name を空にはできません` の 400 になる）

- [ ] **Step 6: 型を確かめて Commit**

Run: `npm run typecheck -w packages/shared -w packages/server`
Expected: エラーなし

```bash
git add packages/shared/src packages/server/src/http
git commit -m "feat(server): create a project folder or register one via POST /api/projects and list unregistered folders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 起動中に現れた直下の新しいフォルダを、その場で登録する（server.ts）

**Files:**
- Modify: `packages/server/src/server.ts:500-545`
- Test: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: `registerWorkspaceChildOf`（Task 2）、`assignSession`（既存）

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/server.test.ts` の `it('どのルートにも属さないセッションが現れたら、黙って未割り当てにせず知らせる', …)` の後ろに足す:

```ts
  it('起動後にワークスペース直下の新しいフォルダのセッションが現れたら、その場でプロジェクトにする', async () => {
    const alpha = path.join(ws, 'alpha');
    fs.mkdirSync(alpha);
    writeTranscript(alpha, 'bbbbbbbb-0000-4000-8000-000000000021', 'first');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    const c = collector(s.port, tokenOf());
    try {
      await c.opened;
      // 起動の後で作ったフォルダ。起動時の全走査には載っていない。
      const fresh = path.join(ws, 'fresh');
      fs.mkdirSync(path.join(fresh, 'src'), { recursive: true });
      writeTranscript(path.join(fresh, 'src'), 'bbbbbbbb-0000-4000-8000-000000000022', 'hello');
      const ev = await c.waitFor((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert' && e.session.providerSessionId === 'bbbbbbbb-0000-4000-8000-000000000022' && e.session.projectId !== null);
      const proj = await c.waitFor((e): e is Extract<ServerEvent, { type: 'project.upsert' }> => e.type === 'project.upsert' && e.project.id === ev.session.projectId);
      expect(proj.project).toMatchObject({ name: 'fresh', path: fresh });
      // ワークスペースの中なので、未分類の知らせは出さない。
      expect(c.all().some((e) => e.type === 'toast' && e.message.includes(fresh))).toBe(false);
    } finally {
      c.close();
      await s.close();
    }
  }, 20000);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/server.test.ts -t "その場でプロジェクトにする"`
Expected: FAIL（`event not seen` で時間切れ）

- [ ] **Step 3: 実装する**

`server.ts` の import の `registry.ts` に `registerWorkspaceChildOf` を足す。

`tellUnassigned` の上の注記を次に替える:

```ts
  /**
   * どのルートの配下でもない cwd のセッションは「未分類」に残る（設計どおり）。
   * ただし黙って残ると利用者は気付けないので、セッションごとに 1 度だけ知らせる。
   * ワークスペース直下のフォルダは、sessionChanged がその場でプロジェクトにするので、ここへ来るのはワークスペースの外だけである。
   * 外のフォルダで勝手にプロジェクトを作ることはしない。紐づけは利用者が決める。
   */
```

`sessionChanged` の中の `const assigned = …` の行を次に替える:

```ts
      let assigned = row && row.project_id === null ? assignSession(db, device.id, e.sessionId) : null;
      // 当たるルートが無ければ、ワークスペース直下の新しいフォルダかを見て、起動時と同じ規則でその場でプロジェクトにする。
      // 起動の途中は syncProjectsFromWorkspace が受け持つので行わない。同じセッションで何度も試さない。
      if (row && row.project_id === null && !assigned && started && !triedRegister.has(e.sessionId)) {
        triedRegister.add(e.sessionId);
        const cwd = (db.prepare('select cwd from sessions where id = ?').get(e.sessionId) as { cwd: string }).cwd;
        if (registerWorkspaceChildOf(db, device.id, settings.workspaceRoot, cwd)) assigned = assignSession(db, device.id, e.sessionId);
      }
```

`toldUnassigned` の宣言の下に足す:

```ts
  // その場の自動登録を試したセッション。本文が伸びるたびにディスクを見に行かないために持つ。
  const triedRegister = new Set<string>();
```

`settings` が `sessionChanged` から見える変数か（設定の変更で差し替わる値か）を確かめる。`promote:` の `workspaceRoot: settings.workspaceRoot` と同じ変数を使う。

- [ ] **Step 4: 試験を回す**

Run: `npx vitest run packages/server/src/server.test.ts`
Expected: PASS（「どのルートにも属さないセッションが現れたら」も緑のまま。外の cwd はその場の登録に当たらない）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.test.ts
git commit -m "feat(server): register a new workspace folder as a project when its session appears

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: デスクトップの殻にフォルダの選択（`pick_folder`）を足す

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/build.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/capabilities/remote-pick-folder.json`
- Modify: `apps/desktop/test/config.test.ts`
- Modify: `packages/ui/src/runtime/desktop.ts`
- Test: `packages/ui/src/runtime/desktop.test.ts`

**Interfaces:**
- Produces（殻）: 命令 `pick_folder(default_path: Option<String>) -> Option<String>`。JS からは `invoke('pick_folder', { defaultPath })`。
- Produces（UI）: `DesktopBridge.pickFolder(defaultPath: string | null): Promise<string | null>`、`DESKTOP_COMMANDS.pickFolder = 'pick_folder'`

- [ ] **Step 1: 失敗する試験を書く（UI と設定の突き合わせ）**

`packages/ui/src/runtime/desktop.test.ts` の 2 つ目の `it` を次に替え、1 つ足す:

```ts
  it('殻の中では、決まった命令だけを呼ぶ', async () => {
    const invoke = vi.fn(async () => null);
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    await b.openLog();
    await b.restart();
    expect(invoke.mock.calls).toEqual([['open_log'], ['restart_app']]);
  });
  it('フォルダの選択は既定の場所を渡し、選んだパスか、取り消しなら null を返す', async () => {
    const invoke = vi.fn(async () => '/Users/me/thesis');
    const b = createDesktopBridge({ __TAURI_INTERNALS__: { invoke } })!;
    expect(await b.pickFolder('/Users/me/workspace')).toBe('/Users/me/thesis');
    expect(invoke).toHaveBeenCalledWith('pick_folder', { defaultPath: '/Users/me/workspace' });
    invoke.mockResolvedValueOnce(null);
    expect(await b.pickFolder(null)).toBeNull();
  });
```

`apps/desktop/test/config.test.ts` で:
- `it('殻の命令の名前は、…')` の `expect(listed).toEqual([...])` を `['notify_request', 'notify_status', 'notify_waiting', 'open_log', 'pick_folder', 'restart_app', 'retry_boot']` に替え、`expect(ui).toContain("restart: 'restart_app'");` の下に `expect(ui).toContain("pickFolder: 'pick_folder'");` を足す。
- `describe('capabilities', …)` に足す:

```ts
  // フォルダの選択は、プロジェクトを作るダイアログの「ほかの場所を選ぶ…」だけが使う。プラグインの JS の権限は与えない。
  it('UI の出どころには、フォルダの選択だけを別に与える', () => {
    const c = cap('remote-pick-folder.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toEqual({ urls: ['http://127.0.0.1:4177/*'] });
    expect(c.permissions).toEqual(['allow-pick-folder']);
  });
```

capabilities のファイルの一覧を固定で突き合わせている試験があれば（`fs.readdirSync(dir)` の toEqual など）、そこにも `remote-pick-folder.json` を足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/runtime/desktop.test.ts apps/desktop/test/config.test.ts`
Expected: FAIL（`b.pickFolder is not a function`、`remote-pick-folder.json` が無い、命令の一覧が違う）

- [ ] **Step 3: UI の口を足す**

`packages/ui/src/runtime/desktop.ts`:

```ts
/**
 * デスクトップの殻（Tauri）に頼む口。
 * 殻は頁の読み込みの前に `__TAURI_INTERNALS__` を差し込むので、有無は起動の時に決まる。
 * 頼めるのは、ログを開くこと、アプリの再起動、フォルダの選択の 3 つだけである。
 * どれも殻の capability（apps/desktop/src-tauri/capabilities/remote-shell.json と remote-pick-folder.json）で、この頁の出どころにだけ許してある。
 */
export type DesktopBridge = { openLog(): Promise<void>; restart(): Promise<void>; pickFolder(defaultPath: string | null): Promise<string | null> };

/** 殻の命令の名前。lib.rs の #[tauri::command] と build.rs の一覧にそろえる。 */
export const DESKTOP_COMMANDS = { openLog: 'open_log', restart: 'restart_app', pickFolder: 'pick_folder' } as const;
```

`createDesktopBridge` の返す値に足す:

```ts
    // 取り消したら殻は null を返す。文字列でなければ取り消しと同じに扱う。
    pickFolder: async (defaultPath) => { const r = await invoke(DESKTOP_COMMANDS.pickFolder, { defaultPath }); return typeof r === 'string' ? r : null; },
```

- [ ] **Step 4: 殻を足す**

`apps/desktop/src-tauri/Cargo.toml` の `[dependencies]` に足す:

```toml
# プロジェクトを作るダイアログの「ほかの場所を選ぶ…」で、macOS のフォルダ選択を開く（lib.rs の pick_folder）。
# 頁からは pick_folder の命令だけを呼ばせ、プラグインの JS の権限は与えない。
tauri-plugin-dialog = "2"
```

`apps/desktop/src-tauri/build.rs` の `COMMANDS` に `"pick_folder",` を `"open_log",` の後ろへ足す（名前順）。

`apps/desktop/src-tauri/capabilities/remote-pick-folder.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "remote-pick-folder",
  "description": "サーバの UI（127.0.0.1:4177）から、プロジェクトを作るダイアログの「ほかの場所を選ぶ…」で macOS のフォルダ選択を開くためだけの権限。選んだパスを返すだけで、ほかの殻の機能は与えない。",
  "windows": ["main"],
  "remote": { "urls": ["http://127.0.0.1:4177/*"] },
  "permissions": ["allow-pick-folder"]
}
```

`apps/desktop/src-tauri/src/lib.rs`:
- 697 行付近の注記「どれも引数を受け取らない。」を「`pick_folder` のほかは引数を受け取らない。」に替える。
- `open_log` の上に足す:

```rust
/// フォルダを 1 つ選ぶ macOS のダイアログを開き、選んだパスを返す。取り消したら None を返す。
/// 新しいセッションのダイアログと、プロジェクトを作るダイアログの「ほかの場所を選ぶ…」が呼ぶ。
/// 既定の場所はワークスペースのルートで、`~/` で始まればホームに展開する。ディレクトリでなければ渡さない。
/// ダイアログは選び終えるまで戻らないので、非同期の実行の糸を塞がないよう spawn_blocking で待つ。
#[tauri::command]
async fn pick_folder(app: AppHandle, default_path: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file();
    if let Some(p) = default_path {
        let expanded = match p.strip_prefix("~/") {
            Some(rest) => std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(rest)),
            None => Some(std::path::PathBuf::from(p)),
        };
        if let Some(dir) = expanded.filter(|d| d.is_dir()) {
            builder = builder.set_directory(dir);
        }
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_folder()).await.ok().flatten()?;
    picked.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}
```

- `run()` の `.plugin(tauri_plugin_deep_link::init())` の下に `.plugin(tauri_plugin_dialog::init())` を足す。
- `invoke_handler` の一覧に `pick_folder` を足す。

`FileDialogBuilder` が `Send` でないなどで `spawn_blocking` に渡せないときは、`blocking_pick_folder()` を直に呼ぶ（async の命令は主スレッドの外で走るので、ダイアログは開ける）。その場合は注記の最後の文を消す。

- [ ] **Step 5: 試験と Rust の build を回す**

Run: `npx vitest run packages/ui/src/runtime/desktop.test.ts apps/desktop/test/config.test.ts`
Expected: PASS

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: `Finished`（警告は可、エラーなし）

- [ ] **Step 6: Commit**

```bash
git add apps/desktop packages/ui/src/runtime/desktop.ts packages/ui/src/runtime/desktop.test.ts
git commit -m "feat(desktop): let the server UI open the macOS folder picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mediator（作成の領域、`place` 付きの起動、未登録の一覧と Finder の結果）

**Files:**
- Modify: `packages/shared/src/intent.ts`
- Modify: `packages/ui/src/mediator/types.ts`
- Create: `packages/ui/src/mediator/projectCreate.ts`
- Modify: `packages/ui/src/mediator/launch.ts`
- Modify: `packages/ui/src/mediator/transition.ts`
- Modify: `packages/ui/src/mediator/workbench.ts`（パレットの `cmd:new-project`）
- Test: `packages/ui/src/mediator/transition.test.ts`

**Interfaces:**
- Consumes: `ProjectPlace`、`WorkspaceDirDto`（Task 3）
- Produces（Intent, shared/intent.ts）:
  - `{ type: 'project.new.open' }`
  - `{ type: 'project.new.submit'; place: ProjectPlace; startSession: boolean }`（元の `{ name, gitInit, startSession }` を置き換える）
  - `{ type: 'session.new.submit'; params: LaunchParams; place?: ProjectPlace }`
  - `{ type: 'folder.pick' }`
- Produces（mediator/types.ts）:
  - Overlay に `{ kind: 'newProject' }`
  - `LaunchState = { kind: 'idle' } | { kind: 'submitting'; createdProjectId?: string } | { kind: 'failed'; message: string; createdProjectId?: string }`
  - State に `projectCreate: LaunchState; workspaceDirs: WorkspaceDirDto[] | null; pickedFolder: { path: string; n: number } | null`
  - Effect に `{ kind: 'api.createProject'; place: ProjectPlace; startSession: boolean }`、`{ kind: 'api.createProjectThenLaunch'; place: ProjectPlace; params: LaunchParams }`、`{ kind: 'api.workspaceDirs' }`、`{ kind: 'desktop.pickFolder' }`
  - RuntimeEvent に `{ type: 'project.created'; projectId: string; params: LaunchParams }`、`{ type: 'project.create.done'; projectId: string; startSession: boolean }`、`{ type: 'project.create.failed'; message: string }`、`{ type: 'workspaceDirs.loaded'; dirs: WorkspaceDirDto[] }`、`{ type: 'folder.picked'; path: string }`
  - `projectCreateStep(state: State, input: Input): Step | null`（projectCreate.ts）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/mediator/transition.test.ts` で:

1. `it('次のフェーズの操作はトーストで知らせる', …)` から `project.new.open` を外す:

```ts
  it('次のフェーズの操作はトーストで知らせる', () => {
    const { state, effects } = run([intent({ type: 'session.takeover', id: 's1', force: false })]);
    expect(effects).toEqual([{ kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }]);
    expect(state).toEqual(initialState());
  });
```

2. 末尾に足す:

```ts
describe('プロジェクトを作る', () => {
  const place = { kind: 'newDir' as const, name: 'fresh', gitInit: true };
  it('作成のダイアログを開くと、未登録の一覧を取りに行く', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' })]);
    expect(state.overlay).toEqual({ kind: 'newProject' });
    expect(state.projectCreate).toEqual({ kind: 'idle' });
    expect(effects).toContainEqual({ kind: 'api.workspaceDirs' });
  });
  it('新しいセッションのダイアログを開いたときも、未登録の一覧を取りに行く', () => {
    expect(run([intent({ type: 'session.new.open' })]).effects).toContainEqual({ kind: 'api.workspaceDirs' });
    expect(run([intent({ type: 'palette.run', command: { id: 'cmd:new-session', label: '' } })], run([intent({ type: 'palette.open' })]).state).effects).toContainEqual({ kind: 'api.workspaceDirs' });
  });
  it('送ると作成を頼み、二重には送らない', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), intent({ type: 'project.new.submit', place, startSession: false })]);
    expect(state.projectCreate).toEqual({ kind: 'submitting' });
    expect(effects.filter((e) => (e as { kind: string }).kind === 'api.createProject')).toEqual([{ kind: 'api.createProject', place, startSession: false }]);
  });
  it('作成だけなら閉じてプロジェクトの画面へ移る', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), runtime({ type: 'project.create.done', projectId: 'p9', startSession: false })]);
    expect(state.overlay).toEqual({ kind: 'none' });
    expect(state.projectCreate).toEqual({ kind: 'idle' });
    expect(effects).toContainEqual({ kind: 'navigate', route: { name: 'project', id: 'p9' } });
  });
  it('作成して始めるなら、そのプロジェクトを選んだ新しいセッションのダイアログを開く', () => {
    const { state, effects } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: true }), runtime({ type: 'project.create.done', projectId: 'p9', startSession: true })]);
    expect(state.overlay).toEqual({ kind: 'newSession', projectId: 'p9', scratch: false });
    expect(state.launch).toEqual({ kind: 'idle' });
    expect(effects).toContainEqual({ kind: 'focus', target: 'newSessionName' });
  });
  it('失敗したらダイアログに残して文言を持つ。閉じた後に届いた失敗はトーストにする', () => {
    const a = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), runtime({ type: 'project.create.failed', message: '/w/fresh は既にあります' })]);
    expect(a.state.overlay).toEqual({ kind: 'newProject' });
    expect(a.state.projectCreate).toEqual({ kind: 'failed', message: '/w/fresh は既にあります' });
    const b = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), intent({ type: 'overlay.close' }), runtime({ type: 'project.create.failed', message: 'x' })]);
    expect(b.state.overlay).toEqual({ kind: 'none' });
    expect(b.state.toasts.map((t) => t.message)).toEqual(['x']);
  });
  it('起動のダイアログから place 付きで送ると、作ってから起動するよう頼む', () => {
    const { state, effects } = run([intent({ type: 'session.new.open' }), intent({ type: 'session.new.submit', params: { name: 'n' }, place })]);
    expect(state.launch).toEqual({ kind: 'submitting' });
    expect(effects).toContainEqual({ kind: 'api.createProjectThenLaunch', place, params: { name: 'n' } });
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを失敗の状態に持ち、詳細はそのプロジェクトの前回値にする', () => {
    const { state } = run([
      intent({ type: 'session.new.open' }),
      intent({ type: 'session.new.submit', params: { model: 'opus' }, place }),
      runtime({ type: 'project.created', projectId: 'p9', params: { model: 'opus', projectId: 'p9' } }),
      runtime({ type: 'launch.failed', message: 'tmux が見つかりません' }),
    ]);
    expect(state.launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません', createdProjectId: 'p9' });
    expect(state.overlay).toMatchObject({ kind: 'newSession', projectId: null });
    expect(state.launchPrefs.p9).toEqual({ model: 'opus' });
  });
  it('Finder を頼むと殻に頼み、選ばれたパスは回数を添えて持つ', () => {
    const { state, effects } = run([intent({ type: 'folder.pick' }), runtime({ type: 'folder.picked', path: '/x' }), runtime({ type: 'folder.picked', path: '/x' })]);
    expect(effects).toEqual([{ kind: 'desktop.pickFolder' }]);
    expect(state.pickedFolder).toEqual({ path: '/x', n: 2 });
  });
  it('未登録の一覧が届いたら持つ', () => {
    const dirs = [{ name: 'a', path: '/w/a' }];
    expect(run([runtime({ type: 'workspaceDirs.loaded', dirs })]).state.workspaceDirs).toEqual(dirs);
  });
  it('作成のダイアログは Esc（overlay.close）で閉じ、状態を idle に戻す', () => {
    const { state } = run([intent({ type: 'project.new.open' }), intent({ type: 'project.new.submit', place, startSession: false }), intent({ type: 'overlay.close' })]);
    expect(state.overlay).toEqual({ kind: 'none' });
    expect(state.projectCreate).toEqual({ kind: 'idle' });
  });
  it('パレットの「新しいプロジェクト」で作成のダイアログを開く', () => {
    const { state } = run([intent({ type: 'palette.open' }), intent({ type: 'palette.run', command: { id: 'cmd:new-project', label: '新しいプロジェクト' } })]);
    expect(state.overlay).toEqual({ kind: 'newProject' });
  });
});
```

`palette.run` の試験で使う「開いたパレット」の作り方は、ファイルの中の既存の `opened()` に合わせて書き替えてよい。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/mediator/transition.test.ts`
Expected: FAIL（型エラーや `overlay` が `none` のまま）

- [ ] **Step 3: 型を足す**

`packages/shared/src/intent.ts`:
- import に `ProjectPlace` を足す（api.ts から）。
- 34 行の `project.new.*` を次に替える:

```ts
  | { type: 'project.new.open' } | { type: 'project.new.submit'; place: ProjectPlace; startSession: boolean }
  // 起動と作成のダイアログの「ほかの場所を選ぶ…」。殻の中だけで出す。
  | { type: 'folder.pick' }
```

- 47 行の `session.new.submit` を `{ type: 'session.new.submit'; params: LaunchParams; place?: ProjectPlace }` にする。`place` は、新しいフォルダと未登録のフォルダで始めるときだけ付ける。

`packages/ui/src/mediator/types.ts`:
- `LaunchState` を次に替える:

```ts
/** createdProjectId は、作ってから起動する送信でプロジェクトができた後の印である。起動だけが失敗しても、押し直しで二重に作らない。 */
export type LaunchState = { kind: 'idle' } | { kind: 'submitting'; createdProjectId?: string } | { kind: 'failed'; message: string; createdProjectId?: string };
```

- `Overlay` に `| { kind: 'newProject' }` を足す。
- `State` に足す（`promote: LaunchState;` の下）:

```ts
  /** プロジェクト画面の作成のダイアログの送信。 */
  projectCreate: LaunchState;
  /** ワークスペース直下の未登録のフォルダ。ダイアログを開くたびに取り直す。未取得は null。 */
  workspaceDirs: WorkspaceDirDto[] | null;
  /** Finder で選んだフォルダ。n は選んだ回数で、同じパスをもう一度選んでも気付けるようにする。 */
  pickedFolder: { path: string; n: number } | null;
```

- `Effect` と `RuntimeEvent` に、上の Interfaces の各行を足す。

`packages/ui/src/mediator/transition.ts` の `initialState()` に `projectCreate: { kind: 'idle' }, workspaceDirs: null, pickedFolder: null` を足す。

- [ ] **Step 4: projectCreate.ts を書く**

`packages/ui/src/mediator/projectCreate.ts`:

```ts
import { overlayReplaceable } from './overlay.ts';
import type { Input, State, Step } from './types.ts';

/**
 * projectCreate 領域：プロジェクト画面の作成のダイアログと、2 つのダイアログが共有する未登録の一覧と Finder の結果。
 * 作成で終えたらそのプロジェクトの画面へ移り、作成して始めるなら新しいセッションのダイアログを開く。
 */
export function projectCreateStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'workspaceDirs.loaded') return { state: { ...state, workspaceDirs: e.dirs }, effects: [] };
    if (e.type === 'folder.picked') return { state: { ...state, pickedFolder: { path: e.path, n: (state.pickedFolder?.n ?? 0) + 1 } }, effects: [] };
    if (e.type !== 'project.create.done' && e.type !== 'project.create.failed') return null;
    // 送信中でなければ（送った直後に閉じた）、結果で画面を動かさない。ただし黙って捨てない。
    if (state.projectCreate.kind !== 'submitting') {
      return { state, effects: [e.type === 'project.create.failed' ? { kind: 'toast', level: 'error', message: e.message } : { kind: 'toast', level: 'info', message: 'プロジェクトを作りました' }] };
    }
    if (e.type === 'project.create.failed') return { state: { ...state, projectCreate: { kind: 'failed', message: e.message } }, effects: [] };
    const done = { ...state, projectCreate: { kind: 'idle' as const } };
    if (e.startSession) return { state: { ...done, overlay: { kind: 'newSession', projectId: e.projectId, scratch: false }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    return { state: { ...done, overlay: { kind: 'none' } }, effects: [{ kind: 'navigate', route: { name: 'project', id: e.projectId } }] };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'project.new.open':
      // 確認や入力のあるダイアログが出ていれば、差し替えない（overlay.ts の overlayReplaceable）。
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'newProject' }, projectCreate: { kind: 'idle' } }, effects: [] };
    case 'project.new.submit':
      if (state.projectCreate.kind === 'submitting') return { state, effects: [] };
      return { state: { ...state, projectCreate: { kind: 'submitting' } }, effects: [{ kind: 'api.createProject', place: i.place, startSession: i.startSession }] };
    case 'folder.pick': return { state, effects: [{ kind: 'desktop.pickFolder' }] };
    case 'overlay.close':
      // overlayStep のキュー処理より先に横取りして、作成の状態も idle に戻す。
      if (state.overlay.kind !== 'newProject') return null;
      return { state: { ...state, overlay: { kind: 'none' }, projectCreate: { kind: 'idle' } }, effects: [] };
    default: return null;
  }
}
```

- [ ] **Step 5: launch.ts を書き換える**

`launchStep` の `runtime` の分岐に、`launch.done` の前で足す:

```ts
    if (ev.type === 'project.created') {
      // 作ってから起動する送信の途中で、プロジェクトができた。起動だけが失敗しても押し直しで二重に作らないよう印を持ち、
      // 送った詳細をそのプロジェクトの前回値にする（送った時点ではプロジェクトの id が無かったため）。
      if (state.launch.kind !== 'submitting') return { state, effects: [] };
      const r = rememberPrefs(state, ev.params);
      return { state: { ...r.state, launch: { kind: 'submitting', createdProjectId: ev.projectId } }, effects: r.effects };
    }
```

`launch.failed` の分岐の `const next = …` を次に替える:

```ts
      const created = state.launch.kind === 'submitting' ? state.launch.createdProjectId : undefined;
      const next = { ...state, launch: { kind: 'failed' as const, message: ev.message, ...(created ? { createdProjectId: created } : {}) }, newSessionSent: false };
```

`case 'session.new.submit':` の二重送信の判定の直後に足す:

```ts
      // 新しいフォルダと未登録のフォルダは、プロジェクトを作ってから起動する（runtime が 2 つを順に行う）。
      if (i.place) return { state: { ...state, launch: { kind: 'submitting' }, newSessionSent: true }, effects: [{ kind: 'api.createProjectThenLaunch', place: i.place, params: i.params }] };
```

- [ ] **Step 6: transition.ts に組み込み、ダイアログを開いたら一覧を取りに行く**

`transition.ts`:
- `NOT_YET_INTENTS` を `new Set(['session.takeover'])` にする。
- import に `projectCreateStep` を足し、ステップの並びの `promoteStep` の後ろに置く（`overlay.close` を横取りするので `overlayStep` より前）。
- `if (r) { … }` の中を次に替える:

```ts
    if (r) {
      const settled = settleWaiting(settleQueue(r.state));
      const next = settled === r.state ? r : { ...r, state: settled };
      return fetchDirsOnOpen(state, next);
    }
```

- ファイルの下に足す:

```ts
/**
 * 新しいセッションのダイアログか作成のダイアログが開いたら、未登録のフォルダの一覧を取りに行く。
 * 開く経路（⌘N、ヘッダー、カード、パレット、作成して始める）が多いので、開いた瞬間をここで 1 か所で見る。
 */
function fetchDirsOnOpen(prev: State, r: Step): Step {
  const k = r.state.overlay.kind;
  const opened = (k === 'newSession' || k === 'newProject') && prev.overlay.kind !== k;
  return opened ? { ...r, effects: [...r.effects, { kind: 'api.workspaceDirs' }] } : r;
}
```

- [ ] **Step 7: パレットの `cmd:new-project`**

`packages/ui/src/mediator/workbench.ts` の 27 行の `opens` に `|| rest === 'new-project'` を足し、38 行の `case 'new-scratch'` の下に足す:

```ts
      case 'new-project': return { state: { ...closed, overlay: { kind: 'newProject' }, projectCreate: { kind: 'idle' } }, effects: [] };
```

- [ ] **Step 8: 試験を回し、崩れた既存の試験を直す**

Run: `npx vitest run packages/ui/src/mediator`
Expected: 新しい試験は PASS。`session.new.open` や `cmd:new-session` の後の `effects` を `toEqual` で比べている既存の試験は、末尾に `{ kind: 'api.workspaceDirs' }` が増えて落ちる。その試験の期待値に `{ kind: 'api.workspaceDirs' }` を足して直す（振る舞いの変更ではなく、一覧を取りに行く副作用が増えただけである）。

Run: `npm run typecheck -w packages/shared -w packages/ui`
Expected: エラーなし。`Overlay` を網羅で分けている所（`switch (overlay.kind)` など）が `newProject` を求めたら、何もしない分岐を足す。

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/intent.ts packages/ui/src/mediator
git commit -m "feat(ui): add the project creation state and launch-after-create to the mediator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: runtime と API の口

**Files:**
- Modify: `packages/ui/src/runtime/api.ts`
- Modify: `packages/ui/src/runtime/runtime.ts`
- Modify: `packages/ui/src/test/fakeApi.ts`
- Test: `packages/ui/src/runtime/runtime.test.ts`、`packages/ui/src/runtime/api.test.ts`

**Interfaces:**
- Consumes: Task 6 の Effect と RuntimeEvent、Task 5 の `DesktopBridge.pickFolder`
- Produces（ApiClient）:
  - `createProject(place: ProjectPlace): Promise<ProjectDto>` — `POST /api/projects`、本文は `place` そのもの（元の `createProject(name, path)` を置き換える）
  - `workspaceDirs(): Promise<WorkspaceDirDto[]>` — `GET /api/workspace/dirs`

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/runtime/api.test.ts` に、ファイルの既存の `fetch` の差し替えの書き方に合わせて足す:

```ts
  it('プロジェクトの作成は place をそのまま送り、未登録の一覧は GET で取る', async () => {
    // 既存の試験と同じ fetch の差し替えで、送った URL と本文を集める。
    await api.createProject({ kind: 'newDir', name: 'fresh', gitInit: true });
    expect(lastCall()).toMatchObject({ url: '/api/projects', method: 'POST', body: { kind: 'newDir', name: 'fresh', gitInit: true } });
    await api.workspaceDirs();
    expect(lastCall()).toMatchObject({ url: '/api/workspace/dirs', method: 'GET' });
  });
```

`lastCall` に当たる道具がファイルに無ければ、近くの試験（`resolveProject` や `setProjectStatus` の試験）が送った要求をどう確かめているかに合わせて書く。

`packages/ui/src/runtime/runtime.test.ts` の `describe('起動とターミナル', …)` に足す:

```ts
  const created = { id: 'p9', name: 'fresh', status: 'active' as const, isScratch: false, path: '/w/fresh', resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 };
  it('place 付きの起動は、作ってから、作ったプロジェクトで起動する', async () => {
    const createProject = vi.fn(async () => created);
    const launch = vi.fn(async () => launched);
    const { rt } = harness({ createProject, launch });
    rt.start();
    rt.emit({ type: 'session.new.open' });
    rt.emit({ type: 'session.new.submit', params: { name: 'n' }, place: { kind: 'newDir', name: 'fresh', gitInit: true } });
    await flush();
    expect(createProject).toHaveBeenCalledWith({ kind: 'newDir', name: 'fresh', gitInit: true });
    expect(launch).toHaveBeenCalledWith({ name: 'n', projectId: 'p9' });
    expect(rt.getStore().projects.p9).toEqual(created);
    expect(rt.getState()).toMatchObject({ launch: { kind: 'idle' }, screen: { name: 'session', id: 's1' } });
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを失敗の状態に持つ', async () => {
    const { rt } = harness({ createProject: vi.fn(async () => created), launch: vi.fn(async () => { throw new Error('tmux が見つかりません'); }) });
    rt.start();
    rt.emit({ type: 'session.new.open' });
    rt.emit({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/fresh' } });
    await flush();
    expect(rt.getState().launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません', createdProjectId: 'p9' });
  });
  it('作れなければ起動せず、失敗の文言を出す', async () => {
    const launch = vi.fn(async () => launched);
    const { rt } = harness({ createProject: vi.fn(async () => { throw new Error('/w/fresh は既にあります'); }), launch });
    rt.start();
    rt.emit({ type: 'session.new.open' });
    rt.emit({ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: 'fresh', gitInit: false } });
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(rt.getState().launch).toEqual({ kind: 'failed', message: '/w/fresh は既にあります' });
  });
  it('ダイアログを開くと未登録の一覧を取り、Finder の結果を持つ', async () => {
    const pickFolder = vi.fn(async () => '/Users/me/thesis');
    const { rt } = harness({ workspaceDirs: vi.fn(async () => [{ name: 'a', path: '/w/a' }]) }, { desktop: { openLog: vi.fn(), restart: vi.fn(), pickFolder } });
    rt.start();
    rt.emit({ type: 'project.new.open' });
    rt.emit({ type: 'folder.pick' });
    await flush();
    expect(rt.getState().workspaceDirs).toEqual([{ name: 'a', path: '/w/a' }]);
    expect(rt.getState().pickedFolder).toEqual({ path: '/Users/me/thesis', n: 1 });
  });
  it('作成のダイアログの送信は、作ってから done を返す', async () => {
    const { rt } = harness({ createProject: vi.fn(async () => created) });
    rt.start();
    rt.emit({ type: 'project.new.open' });
    rt.emit({ type: 'project.new.submit', place: { kind: 'newDir', name: 'fresh', gitInit: true }, startSession: false });
    await flush();
    expect(rt.getStore().projects.p9).toEqual(created);
    expect(rt.getState()).toMatchObject({ overlay: { kind: 'none' }, projectCreate: { kind: 'idle' } });
  });
```

`harness` の `api` の既定に `workspaceDirs: vi.fn(async () => [])` が要る（無いと「開くと取りに行く」で未定義を呼ぶ）。`fakeApiExtras` に入れる（Step 3）。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/runtime`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/runtime/api.ts`:
- import に `ProjectPlace, WorkspaceDirDto` を足す。
- 型の 51 行を次に替え、1 行足す:

```ts
  createProject(place: ProjectPlace): Promise<ProjectDto>;
  workspaceDirs(): Promise<WorkspaceDirDto[]>;
```

- 実装の 136 行を次に替え、1 行足す:

```ts
    createProject: (place) => post('/api/projects', place),
    workspaceDirs: () => call('/api/workspace/dirs'),
```

`packages/ui/src/test/fakeApi.ts`: 6 行の一覧に `'workspaceDirs'` を足し、`createProject: vi.fn(async () => unused()),` の下に `workspaceDirs: vi.fn(async () => []),` を足す。

`packages/ui/src/runtime/runtime.ts` の effect の `switch` に、`case 'api.launch'` の下で足す:

```ts
      case 'api.createProjectThenLaunch':
        // 作ってから起動する。作れたら store に入れて Mediator に知らせ（起動だけが失敗しても二重に作らないため）、そのプロジェクトで起動する。
        deps.api.createProject(e.place)
          .then((p) => {
            setStore({ ...store, projects: { ...store.projects, [p.id]: p } });
            const params = { ...e.params, projectId: p.id };
            dispatch({ kind: 'runtime', event: { type: 'project.created', projectId: p.id, params } });
            return deps.api.launch(params).then(launched);
          })
          .catch(launchFailed);
        return;
      case 'api.createProject':
        deps.api.createProject(e.place)
          .then((p) => {
            setStore({ ...store, projects: { ...store.projects, [p.id]: p } });
            dispatch({ kind: 'runtime', event: { type: 'project.create.done', projectId: p.id, startSession: e.startSession } });
          })
          .catch((err) => dispatch({ kind: 'runtime', event: { type: 'project.create.failed', message: errMsg(err) } }));
        return;
      // 取れなければ空にする。一覧が出ないだけで、作ることもパスで選ぶこともできる。
      case 'api.workspaceDirs': deps.api.workspaceDirs().then((dirs) => dispatch({ kind: 'runtime', event: { type: 'workspaceDirs.loaded', dirs } })).catch(() => dispatch({ kind: 'runtime', event: { type: 'workspaceDirs.loaded', dirs: [] } })); return;
      case 'desktop.pickFolder':
        if (!deps.desktop) return;
        // 取り消したら何もしない。開く場所はワークスペースのルートにする。
        deps.desktop.pickFolder(store.settings?.workspaceRoot ?? null)
          .then((path) => { if (path) dispatch({ kind: 'runtime', event: { type: 'folder.picked', path } }); })
          .catch((err: unknown) => failWith('フォルダを選べませんでした', err));
        return;
```

`setStore` の後で `store` を読み直す必要があるか（`store` が `let` で、`setStore` が書き換えるか）を、`api.promote` の分岐と同じ書き方で確かめる。

- [ ] **Step 4: 試験を回す**

Run: `npx vitest run packages/ui/src/runtime`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/runtime packages/ui/src/test/fakeApi.ts
git commit -m "feat(ui): create a project before launching and fetch unregistered folders and picked ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Listbox に「検索したときだけ出す行」「顔だけの行」「札」「下端の操作」を足す

**Files:**
- Modify: `packages/ui/src/views/primitives/listboxModel.ts`
- Modify: `packages/ui/src/views/primitives/Listbox.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Modify: `packages/ui/src/views/primitives/Icon.tsx`（`folder`、`folderPlus`、`folderOpen`）
- Test: `packages/ui/src/views/primitives/listboxModel.test.ts`、`packages/ui/src/views/primitives/Listbox.test.tsx`

**Interfaces:**
- Produces（listboxModel.ts）:
  - `ListboxOption` に `searchOnly?: boolean`（語があるときだけ並べる）、`hidden?: boolean`（並べず、選んだときの顔にだけ使う）、`tag?: string`（行の右に小さな札）
  - `type ListboxAction = { value: string; label: string; sub?: string; icon: IconName }`
- Produces（Listbox.tsx）: `ListboxProps` に `actions?: (query: string) => ListboxAction[]` と `onAction?: (value: string, query: string) => void`。操作は行の続きとして矢印キーで辿れ、Enter かクリックで `onAction` を呼んで面を閉じる（`onChange` は呼ばない）。一致する行が無いときは最初の操作に印を置く。

- [ ] **Step 1: 失敗する試験を書く**

`listboxModel.test.ts` に足す:

```ts
describe('arrangeSections の searchOnly と hidden', () => {
  const opts = [{ value: 'a', label: 'alpha' }, { value: 'u', label: 'url-short', searchOnly: true }, { value: 'h', label: 'hidden', hidden: true }];
  it('語が無ければ searchOnly と hidden を並べない', () => {
    expect(arrangeSections(opts, undefined, '').flatMap((s) => s.items.map((i) => i.option.value))).toEqual(['a']);
  });
  it('語があれば searchOnly は一致で並べ、hidden は並べない', () => {
    expect(arrangeSections(opts, undefined, 'url').flatMap((s) => s.items.map((i) => i.option.value))).toEqual(['u']);
    expect(arrangeSections(opts, undefined, 'hid').flatMap((s) => s.items.map((i) => i.option.value))).toEqual([]);
  });
});
```

`Listbox.test.tsx` に足す（ファイルの既存の描き方に合わせる。8 件以上で検索欄が出るので、行を 8 件にする）:

```tsx
describe('Listbox の操作', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ value: `p${i}`, label: `proj${i}` }));
  const setup = () => {
    const onChange = vi.fn();
    const onAction = vi.fn();
    render(<Listbox label="場所" value={null} options={[...many, { value: 'u', label: 'url-short', searchOnly: true, tag: '未登録' }]} onChange={onChange}
      actions={(q) => [{ value: 'new', label: q ? `「${q}」を新しいフォルダとして作る` : '新しいフォルダを作る…', icon: 'folderPlus' }]} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '場所' }));
    return { onChange, onAction };
  };
  it('下端に操作を出し、語に合わせて名前を変える', () => {
    setup();
    expect(screen.getByRole('option', { name: '新しいフォルダを作る…' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(screen.getByRole('option', { name: '「zzz」を新しいフォルダとして作る' })).toHaveAttribute('data-active', 'true');
  });
  it('一致する行が無ければ Enter で最初の操作を選び、onChange は呼ばない', () => {
    const { onChange, onAction } = setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('new', 'zzz');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('矢印キーで行の続きとして操作へ進める', () => {
    const { onAction } = setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'url' } });
    expect(screen.getByRole('option', { name: 'url-short' })).toHaveTextContent('未登録');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('new', 'url');
  });
  it('searchOnly の行は語が無いと出ない', () => {
    setup();
    expect(screen.queryByRole('option', { name: 'url-short' })).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/listboxModel.test.ts packages/ui/src/views/primitives/Listbox.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`listboxModel.ts`:
- `ListboxOption` の型に `searchOnly?: boolean; hidden?: boolean; tag?: string` を足し、型の上の注記に 1 文足す:「searchOnly は語があるときだけ並べる行（未登録のフォルダ）、hidden は並べずに選んだときの顔にだけ使う行（作る途中の新しいフォルダ）、tag は行の右の小さな札である。」
- `ListboxAction` を足す（`IconName` は既に import 済み）:

```ts
/** 一覧の下端に置く操作。行ではないので選んでも値にならず、onAction を呼ぶ。 */
export type ListboxAction = { value: string; label: string; sub?: string; icon: IconName };
```

- `arrangeSections` の頭の `const hit = …` を次に替える:

```ts
  const listed = options.filter((o) => !o.hidden && (!o.searchOnly || query.trim() !== ''));
  const hit = listed.filter((o) => matches(o, query));
```

`Listbox.tsx`:
- props の型に `actions?: (query: string) => ListboxAction[]; onAction?: (value: string, query: string) => void;` を足す。
- `items` の下に、操作を行の続きとして数える:

```ts
  const acts = open && props.actions ? props.actions(query) : [];
  const total = items.length + acts.length;
  // 一致する行が無いときは、最初の操作に印を置く。打って Enter で作れるようにするためである。
  const current = total ? Math.min(items.length === 0 && acts.length ? Math.max(active, 0) : active, total - 1) : -1;
```

（元の `const current = …` の行はこれで置き換える。）
- キー操作の `n` を `total` にする（`const n = total;`）。`Enter` の分岐を次に替える:

```ts
      case 'Enter': {
        const hit = items[current];
        if (hit) { choose(hit.option); break; }
        const act = acts[current - items.length];
        if (act) { hide(true); props.onAction?.(act.value, query); }
        break;
      }
```

- 行の描画に札を足す（`{o.meta && …}` の前）:

```tsx
      {o.tag && <span className="listbox-tag">{o.tag}</span>}
```

- `listbox-rows` の閉じタグの後ろ、`listbox-keys` の前に足す:

```tsx
          {acts.length > 0 && (
            <div className="listbox-acts" role="group" aria-label="作る">
              {acts.map((a, j) => {
                const index = items.length + j;
                return (
                  <div key={a.value} id={optId(index)} role="option" aria-selected="false" aria-label={a.label} className="listbox-act" data-active={index === current ? 'true' : undefined}
                    onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => { hide(true); props.onAction?.(a.value, query); }}>
                    <Icon name={a.icon} /><span className="listbox-act-label">{a.label}</span>{a.sub && <small>{a.sub}</small>}
                  </div>
                );
              })}
            </div>
          )}
```

- `!items.length` のときの「一致するものはありません」はそのまま出す（操作はその下に出る）。

`controls.css` の `.listbox-keys` の上に足す:

```css
/* 行の右の小さな札（未登録など）。 */
.listbox-tag { flex: none; padding: 1px 6px; border-radius: 99px; font-size: 10.5px; color: var(--ink-3); background: rgba(30, 40, 90, 0.06); }
/* 一覧の下端の操作。スクロールしても動かない。行と分けるため上に線を引き、名前はアクセントの色にする。 */
.listbox-acts { flex: none; margin-top: var(--u); padding-top: var(--u); border-top: 1px solid rgba(30, 40, 90, 0.06); }
.listbox-act { display: flex; align-items: center; gap: calc(var(--u) * 2.5); min-height: 32px; padding: var(--u) calc(var(--u) * 2.5); border-radius: 10px; cursor: pointer; white-space: nowrap; color: var(--accent); font-weight: 560; }
.listbox-act[data-active='true'] { background: rgba(255, 255, 255, 0.92); box-shadow: inset 0 1px 0 #ffffff, 0 2px 8px -2px rgba(30, 40, 90, 0.16); }
.listbox-act-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.listbox-act small { font-family: var(--font-mono); font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; }
```

`Icon.tsx`: lucide の import に `FolderOpen, FolderPlus` を足し、`ICONS` に `folder: Folder, folderPlus: FolderPlus, folderOpen: FolderOpen,` を足す（`folder` が既にあれば足さない）。`Icon.test.tsx` が名前の一覧を固定で比べていれば、そこにも足す。

- [ ] **Step 4: 試験を回す**

Run: `npx vitest run packages/ui/src/views/primitives`
Expected: PASS（既存の Listbox の試験も緑。`actions` を渡さない Listbox の振る舞いは変わらない）

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/views/primitives packages/ui/src/styles/controls.css
git commit -m "feat(ui): let Listbox show search-only rows, tags, and fixed actions at the bottom

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 新しいセッションのダイアログで「新しいフォルダ」「未登録のフォルダ」「Finder」から始める

**Files:**
- Modify: `packages/ui/src/presenters/newSession.ts`
- Modify: `packages/ui/src/views/NewSessionDialog.tsx`
- Test: `packages/ui/src/views/NewSessionDialog.test.tsx`、`packages/ui/src/presenters/presenters.test.ts`

**Interfaces:**
- Consumes: Task 6（`session.new.submit` の `place`、`folder.pick`、`state.workspaceDirs`、`state.pickedFolder`、`launch.createdProjectId`）、Task 8（`searchOnly`、`hidden`、`tag`、`actions`、`onAction`）
- Produces（NewSessionProps に足す）: `dirs: { name: string; path: string }[]`（登録済みのパスを除いた未登録のフォルダ）、`workspaceRoot: string | null`、`desktop: boolean`、`picked: { path: string; n: number } | null`、`createdProjectId: string | null`

- [ ] **Step 1: 失敗する試験を書く（presenter）**

`presenters.test.ts` の `presentNewSession` の試験の近くに足す（store と state の作り方は近くの試験に合わせる）:

```ts
  it('未登録のフォルダから、store にあるプロジェクトのパスを除く', () => {
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false }, workspaceDirs: [{ name: 'alpha', path: '/w/alpha' }, { name: 'fresh', path: '/w/fresh' }] };
    const props = presentNewSession(state, storeWithProjectAt('/w/alpha'), NOW)!;
    expect(props.dirs).toEqual([{ name: 'fresh', path: '/w/fresh' }]);
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを渡す', () => {
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false }, launch: { kind: 'failed' as const, message: 'x', createdProjectId: 'p9' } };
    expect(presentNewSession(state, storeWithProjectAt('/w/alpha'), NOW)!.createdProjectId).toBe('p9');
  });
```

`storeWithProjectAt(path)` は、`path` をパスに持つ解決済みのプロジェクトを 1 つ入れた store を返す小さな道具として、このファイルの既存の store の作り方で書く。`NOW` も既存の時刻の定数に合わせる。

- [ ] **Step 2: 失敗する試験を書く（ダイアログ）**

`NewSessionDialog.test.tsx` の `base` に `dirs: [{ name: 'url-short', path: '/w/url-short' }], workspaceRoot: '/w', desktop: true, picked: null, createdProjectId: null` を足し、足す:

```tsx
/** 送られた intent をすべて集める。 */
function collect(over: Partial<NewSessionProps> = {}) {
  const out: Intent[] = [];
  const view = render(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} {...over} /></IntentRoot>);
  return { out, view };
}
const openList = () => fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
const typeQuery = (q: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value: q } });

describe('NewSessionDialog から作って始める', () => {
  it('語に一致しなければ「『語』を新しいフォルダとして作る」を選べ、git init 付きの place で送る', () => {
    const { out } = collect();
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '「price」を新しいフォルダとして作る' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいフォルダで始める');
    expect(screen.getByLabelText('フォルダの名前')).toHaveValue('price');
    expect(screen.getByText('/w/price を作り、プロジェクトに登録して起動します')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'git init する' })).toHaveAttribute('aria-checked', 'true');
    start();
    expect(out.filter((i) => i.type === 'session.new.submit')).toEqual([{ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: 'price', gitInit: true } }]);
  });
  it('語が既存のプロジェクトか未登録のフォルダの名前と同じなら、作る操作はその名前にしない', () => {
    collect();
    openList();
    typeQuery('alpha');
    expect(screen.queryByRole('option', { name: '「alpha」を新しいフォルダとして作る' })).toBeNull();
    expect(screen.getByRole('option', { name: '新しいフォルダを作る…' })).toBeInTheDocument();
    typeQuery('url-short');
    expect(screen.queryByRole('option', { name: '「url-short」を新しいフォルダとして作る' })).toBeNull();
  });
  it('未登録のフォルダは語に一致したときだけ「未登録」の札付きで出て、選ぶと登録して始める', () => {
    const { out } = collect();
    openList();
    expect(screen.queryByRole('option', { name: 'url-short' })).toBeNull();
    typeQuery('url');
    fireEvent.click(screen.getByRole('option', { name: 'url-short' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('フォルダを登録して始める');
    expect(screen.getByText('/w/url-short はまだプロジェクトではありません。起動すると登録します')).toBeInTheDocument();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/url-short' } });
  });
  it('「ほかの場所を選ぶ…」は殻の中だけで出て、押すと folder.pick を送る', () => {
    const { out, view } = collect();
    openList();
    fireEvent.click(screen.getByRole('option', { name: 'ほかの場所を選ぶ…' }));
    expect(out).toContainEqual({ type: 'folder.pick' });
    view.unmount();
    collect({ desktop: false });
    openList();
    expect(screen.queryByRole('option', { name: 'ほかの場所を選ぶ…' })).toBeNull();
  });
  it('Finder で選んだワークスペースの外のフォルダは、外である旨を添えて登録して始める', () => {
    const { out, view } = collect();
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/Users/me/thesis', n: 1 }} /></IntentRoot>);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('フォルダを登録して始める');
    expect(screen.getByText('ワークスペースの外のフォルダです。この PC でのパスだけを覚えます。ほかの PC では、開いたときに場所を聞きます')).toBeInTheDocument();
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/Users/me/thesis' } });
  });
  it('Finder で選んだのが登録済みのプロジェクトなら、そのプロジェクトを選ぶ', () => {
    const { out, view } = collect();
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} picked={{ path: '/w/beta', n: 1 }} /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('beta');
    start();
    expect(out.find((i) => i.type === 'session.new.submit')).toEqual({ type: 'session.new.submit', params: { projectId: 'p2' } });
  });
  it('開いたときに既にあった Finder の結果は使わない（別のダイアログで選んだもの）', () => {
    collect({ picked: { path: '/Users/me/old', n: 3 } });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいセッション');
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを選び直し、押し直しでは作らない', () => {
    const projectsWithNew = [...projects, { id: 'p9', name: 'price', path: '/w/price', status: 'active' as const, lastActivity: '' }];
    const { out, view } = collect();
    openList();
    typeQuery('price');
    fireEvent.click(screen.getByRole('option', { name: '「price」を新しいフォルダとして作る' }));
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewSessionDialog {...base} projects={projectsWithNew} error="tmux が見つかりません" createdProjectId="p9" /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('price');
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    start();
    expect(out.filter((i) => i.type === 'session.new.submit').at(-1)).toEqual({ type: 'session.new.submit', params: { projectId: 'p9' } });
  });
});
```

`Intent` は `@agent-hangar/shared` から import する。

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/NewSessionDialog.test.tsx packages/ui/src/presenters/presenters.test.ts`
Expected: FAIL

- [ ] **Step 4: presenter を書き換える**

`presenters/newSession.ts`:
- `NewSessionProps` に足す:

```ts
  /** ワークスペース直下の未登録のフォルダ。store のプロジェクトのパスは除いてある（作った直後に残らないように）。 */
  dirs: { name: string; path: string }[];
  /** 新しいフォルダの作り先の表示に使う。設定が読めていなければ null。 */
  workspaceRoot: string | null;
  /** 殻の中か。Finder の操作は殻の中だけで出す。 */
  desktop: boolean;
  /** Finder で選んだフォルダ。n は選んだ回数で、開いた時点より新しいものだけをダイアログが使う。 */
  picked: { path: string; n: number } | null;
  /** 作ってから起動する送信で、作れた後に起動だけ失敗したときのプロジェクト。ダイアログはこれを選び直す。 */
  createdProjectId: string | null;
```

- `presentNewSession` の return に足す:

```ts
  const taken = new Set(Object.values(store.projects).map((p) => p.path).filter((p): p is string => !!p));
  const dirs = (state.workspaceDirs ?? []).filter((d) => !taken.has(d.path));
  const createdProjectId = state.launch.kind === 'failed' || state.launch.kind === 'submitting' ? state.launch.createdProjectId ?? null : null;
  // …既存の return のオブジェクトに、次を足す。
  // dirs, workspaceRoot: store.settings?.workspaceRoot ?? null, desktop: store.desktop, picked: state.pickedFolder, createdProjectId,
```

- [ ] **Step 5: ダイアログを書き換える**

`views/NewSessionDialog.tsx`:

1. 値の綴りと、作る操作を足す（`SCRATCH_OPTION` の下）:

```ts
/** 新しいフォルダの行の値。プロジェクトの id ともスクラッチとも重ならない。行は顔にだけ使い、一覧には並べない。 */
const NEW_DIR = ':new';
/** 既存のフォルダ（未登録と Finder）の行の値の頭。後ろにパスを付ける。 */
const DIR = ':dir:';
const isDir = (v: string) => v.startsWith(DIR);
```

2. 状態を足す（`choice` の下）:

```ts
  // 新しいフォルダの名前と git init。名前は「『語』を新しいフォルダとして作る」で選んだときの語を入れる。
  const [newName, setNewName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  // Finder で選んだ、未登録の一覧に無いフォルダ（ワークスペースの外か深い階層）。行を持たないので、ここで覚えて行を足す。
  const [extraDir, setExtraDir] = useState<string | null>(null);
  // 開いた時点の Finder の回数。これより新しい結果だけを使う。別のダイアログで選んだ結果が当たらないようにするためである。
  const pickedAtOpen = useRef(props.picked?.n ?? 0);
```

3. Finder の結果と、作れた後の失敗を当てる（`choose` を呼ぶので、`choose` の定義より下に置く）:

```ts
  useEffect(() => {
    const p = props.picked;
    if (!p || p.n <= pickedAtOpen.current) return;
    pickedAtOpen.current = p.n;
    const known = props.projects.find((x) => x.path === p.path);
    if (known) { choose(known.id); return; }
    if (!props.dirs.some((d) => d.path === p.path)) setExtraDir(p.path);
    choose(DIR + p.path);
  }, [props.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // 作れた後に起動だけが失敗した。押し直しで二重に作らないよう、作ったプロジェクトを選び直す。
    if (props.createdProjectId) setChoice(props.createdProjectId);
  }, [props.createdProjectId]);
```

4. 選択の種類と見出し（`const scratch = choice === SCRATCH;` の下）:

```ts
  const newDir = choice === NEW_DIR;
  const dirPath = isDir(choice) ? choice.slice(DIR.length) : null;
  // 未登録の一覧に載っているのはワークスペース直下のフォルダだけなので、載っていなければ外か深い階層である。
  const outside = dirPath !== null && !props.dirs.some((d) => d.path === dirPath);
  const root = props.workspaceRoot ?? '~/workspace';
  const title = scratch ? 'スクラッチで始める' : newDir ? '新しいフォルダで始める' : dirPath ? 'フォルダを登録して始める' : '新しいセッション';
```

`<Dialog title=…>` を `title={title}` にする。

5. 一覧の行と操作（`const options = …` を置き換える）:

```ts
  const options: ListboxOption[] = [
    SCRATCH_OPTION,
    ...props.projects.map((p) => ({ value: p.id, label: p.name, sub: p.path ?? undefined, meta: p.lastActivity || undefined, status: p.status })),
    ...props.dirs.map((d) => ({ value: DIR + d.path, label: d.name, sub: d.path, icon: 'folder' as const, tag: '未登録', searchOnly: true })),
    ...(extraDir ? [{ value: DIR + extraDir, label: extraDir.split('/').pop() || extraDir, sub: extraDir, icon: 'folder' as const, hidden: true }] : []),
    { value: NEW_DIR, label: newName.trim() || '新しいフォルダ', faceSub: `${root}/${newName.trim()}（新しく作る）`, icon: 'folderPlus', hidden: true },
  ];
  const names = new Set([...props.projects.map((p) => p.name), ...props.dirs.map((d) => d.name)]);
  const actions = (q: string): ListboxAction[] => {
    const t = q.trim();
    const first: ListboxAction = t && !names.has(t)
      ? { value: 'new', label: `「${t}」を新しいフォルダとして作る`, sub: `${root}/${t}`, icon: 'folderPlus' }
      : { value: 'new', label: '新しいフォルダを作る…', icon: 'folderPlus' };
    return props.desktop ? [first, { value: 'finder', label: 'ほかの場所を選ぶ…', sub: 'Finder', icon: 'folderOpen' }] : [first];
  };
  const onAction = (value: string, q: string) => {
    if (value === 'finder') { emit({ type: 'folder.pick' }); return; }
    const t = q.trim();
    if (t && !names.has(t)) setNewName(t);
    choose(NEW_DIR);
  };
```

`Listbox` に `actions={actions} onAction={onAction}` を渡す。

6. 一覧の直下の 1 行（`{scratch && <div className="faint">…</div>}` の下）:

```tsx
      {newDir && (
        <>
          <label className="field" htmlFor="new-session-dir-name">フォルダの名前
            <input id="new-session-dir-name" className="input mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ワークスペースに作るディレクトリの名前" />
          </label>
          <div className="faint">{root}/{newName.trim()} を作り、プロジェクトに登録して起動します</div>
          <CheckCard label="git init する" description="空のリポジトリを作ってから起動します" icon="gitInit" checked={gitInit} onChange={setGitInit} />
        </>
      )}
      {dirPath && <div className="faint">{outside ? 'ワークスペースの外のフォルダです。この PC でのパスだけを覚えます。ほかの PC では、開いたときに場所を聞きます' : `${dirPath} はまだプロジェクトではありません。起動すると登録します`}</div>}
```

`CheckCard` を `./primitives/OptionCard.tsx` から、`ListboxAction` と `ListboxOption` を `./primitives/listboxModel.ts` から import する。

7. 送信（`submit` の中の `if (scratch) …` の 2 行を置き換える）:

```ts
    let place: ProjectPlace | undefined;
    // スクラッチはプロジェクトを持たず、サーバが使い捨てのディレクトリを作る。
    if (scratch) params.scratch = true;
    // 新しいフォルダと未登録のフォルダは、Mediator がプロジェクトを作ってから起動する。
    else if (newDir) place = { kind: 'newDir', name: newName.trim(), gitInit };
    else if (dirPath) place = { kind: 'dir', path: dirPath };
    else if (choice) params.projectId = choice;
```

末尾の `emit` を `emit({ type: 'session.new.submit', params, ...(place ? { place } : {}) });` にする。`ProjectPlace` を `@agent-hangar/shared` から import する。

8. 詳細の初期値は、`props.prefs[choice]` が無いので既定のまま（変更不要）。

- [ ] **Step 6: 試験を回す**

Run: `npx vitest run packages/ui/src/views/NewSessionDialog.test.tsx packages/ui/src/presenters`
Expected: PASS（既存の試験も緑）

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/presenters/newSession.ts packages/ui/src/views/NewSessionDialog.tsx packages/ui/src/views/NewSessionDialog.test.tsx packages/ui/src/presenters/presenters.test.ts
git commit -m "feat(ui): start a session in a new or unregistered folder from the new-session dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: プロジェクト画面の「新しいプロジェクト」と作成のダイアログ、パレット

**Files:**
- Create: `packages/ui/src/presenters/newProject.ts`
- Create: `packages/ui/src/views/NewProjectDialog.tsx`
- Modify: `packages/ui/src/views/ProjectsScreen.tsx`
- Modify: `packages/ui/src/Root.tsx`
- Modify: `packages/ui/src/presenters/palette.ts`
- Test: `packages/ui/src/views/dialogs.test.tsx`、`packages/ui/src/views/screens.test.tsx`、`packages/ui/src/presenters/palette.test.ts`

**Interfaces:**
- Consumes: Task 6（`project.new.open`、`project.new.submit`、`folder.pick`、`state.projectCreate`、`state.workspaceDirs`、`state.pickedFolder`）
- Produces:
  - `type NewProjectProps = { dirs: { name: string; path: string }[]; workspaceRoot: string | null; desktop: boolean; picked: { path: string; n: number } | null; submitting: boolean; error: string | null }`
  - `presentNewProject(state: State, store: Store): NewProjectProps | null`（overlay が `newProject` のときだけ）
  - `NewProjectDialog(props: NewProjectProps)`

- [ ] **Step 1: 失敗する試験を書く**

`dialogs.test.tsx` に足す:

```tsx
describe('NewProjectDialog', () => {
  const base: NewProjectProps = { dirs: [{ name: 'hangar-explainers', path: '/w/hangar-explainers' }, { name: 'RPG2', path: '/w/RPG2' }], workspaceRoot: '/w', desktop: true, picked: null, submitting: false, error: null };
  const collect = (over: Partial<NewProjectProps> = {}) => {
    const out: Intent[] = [];
    const view = render(<IntentRoot onIntent={(i) => out.push(i)}><NewProjectDialog {...base} {...over} /></IntentRoot>);
    return { out, view };
  };
  it('新しいフォルダを作る：名前と git init で「作成」と「作成して始める」を送る', () => {
    const { out } = collect();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新しいプロジェクト');
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: 'price-watcher' } });
    expect(screen.getByText('/w/price-watcher を作ります')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'git init する' }));
    fireEvent.click(screen.getByRole('button', { name: '作成して始める' }));
    expect(out.filter((i) => i.type === 'project.new.submit')).toEqual([
      { type: 'project.new.submit', place: { kind: 'newDir', name: 'price-watcher', gitInit: true }, startSession: false },
      { type: 'project.new.submit', place: { kind: 'newDir', name: 'price-watcher', gitInit: false }, startSession: true },
    ]);
  });
  it('既存のフォルダを登録：一覧から選ぶと名前に basename が入り、直した名前で送る', () => {
    const { out } = collect();
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    fireEvent.click(screen.getByRole('option', { name: 'hangar-explainers' }));
    expect(screen.getByLabelText('プロジェクト名')).toHaveValue('hangar-explainers');
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: 'explainers' } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(out.find((i) => i.type === 'project.new.submit')).toEqual({ type: 'project.new.submit', place: { kind: 'dir', path: '/w/hangar-explainers', name: 'explainers' }, startSession: false });
  });
  it('既存のフォルダを登録：一覧は名前で絞れ、パスを打っても選べる', () => {
    const { out } = collect();
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    fireEvent.change(screen.getByLabelText('未登録のフォルダを探す'), { target: { value: 'rpg' } });
    expect(screen.queryByRole('option', { name: 'hangar-explainers' })).toBeNull();
    fireEvent.change(screen.getByLabelText('フォルダのパス'), { target: { value: '/Users/me/thesis' } });
    expect(screen.getByLabelText('プロジェクト名')).toHaveValue('thesis');
    fireEvent.click(screen.getByRole('button', { name: '作成して始める' }));
    expect(out.find((i) => i.type === 'project.new.submit')).toEqual({ type: 'project.new.submit', place: { kind: 'dir', path: '/Users/me/thesis', name: 'thesis' }, startSession: true });
  });
  it('「ほかの場所を選ぶ…」は殻の中だけ。選ばれたパスをパスの欄に入れる。開いた時点の結果は使わない', () => {
    const { out, view } = collect({ picked: { path: '/old', n: 2 } });
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    expect(screen.getByLabelText('フォルダのパス')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'ほかの場所を選ぶ…' }));
    expect(out).toContainEqual({ type: 'folder.pick' });
    view.rerender(<IntentRoot onIntent={(i) => out.push(i)}><NewProjectDialog {...base} picked={{ path: '/Users/me/thesis', n: 3 }} /></IntentRoot>);
    expect(screen.getByLabelText('フォルダのパス')).toHaveValue('/Users/me/thesis');
    view.unmount();
    collect({ desktop: false });
    fireEvent.click(screen.getByRole('radio', { name: '既存のフォルダを登録' }));
    expect(screen.queryByRole('button', { name: 'ほかの場所を選ぶ…' })).toBeNull();
  });
  it('送信中は両方のボタンを押せず、失敗の文言を出し、背景では閉じない', () => {
    const { out, view } = collect({ submitting: true, error: '/w/price-watcher は既にあります' });
    expect(screen.getByRole('button', { name: '作成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '作成して始める' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('/w/price-watcher は既にあります');
    fireEvent.click(view.container.querySelector('.overlay')!);
    expect(out).toEqual([]);
  });
});
```

`screens.test.tsx` の ProjectsScreen の試験の近くに足す:

```tsx
  it('見出しの「新しいプロジェクト」で作成のダイアログを開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.new.open' });
  });
```

`palette.test.ts` に、コマンドの群に `cmd:new-project`（名前は「新しいプロジェクト」）があることの確かめを、既存の `cmd:new-scratch` の確かめと同じ形で足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/dialogs.test.tsx packages/ui/src/views/screens.test.tsx packages/ui/src/presenters/palette.test.ts`
Expected: FAIL

- [ ] **Step 3: presenter を書く**

`packages/ui/src/presenters/newProject.ts`:

```ts
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type NewProjectProps = { dirs: { name: string; path: string }[]; workspaceRoot: string | null; desktop: boolean; picked: { path: string; n: number } | null; submitting: boolean; error: string | null };

/** プロジェクト画面の作成のダイアログ。未登録の一覧からは、store にあるプロジェクトのパスを除く（作った直後に残らないように）。 */
export function presentNewProject(state: State, store: Store): NewProjectProps | null {
  if (state.overlay.kind !== 'newProject') return null;
  const taken = new Set(Object.values(store.projects).map((p) => p.path).filter((p): p is string => !!p));
  return {
    dirs: (state.workspaceDirs ?? []).filter((d) => !taken.has(d.path)),
    workspaceRoot: store.settings?.workspaceRoot ?? null,
    desktop: store.desktop,
    picked: state.pickedFolder,
    submitting: state.projectCreate.kind === 'submitting',
    error: state.projectCreate.kind === 'failed' ? state.projectCreate.message : null,
  };
}
```

- [ ] **Step 4: ダイアログを書く**

`packages/ui/src/views/NewProjectDialog.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectPlace } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NewProjectProps } from '../presenters/newProject.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { CheckCard } from './primitives/OptionCard.tsx';
import { Segmented } from './primitives/Segmented.tsx';

type Mode = 'newDir' | 'dir';
const MODES = [{ value: 'newDir', label: '新しいフォルダを作る' }, { value: 'dir', label: '既存のフォルダを登録' }];
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? '';

/**
 * プロジェクト画面の作成のダイアログ。新しいフォルダを作るか、既存のフォルダを登録する。
 * 入力は送信するまで外へ出ないので、Mediator ではなくここに持つ。名前の検証はサーバが行う。
 * 「作成」はそのプロジェクトの画面へ移り、「作成して始める」は新しいセッションのダイアログを開く（Mediator）。
 */
export function NewProjectDialog(props: NewProjectProps) {
  const emit = useEmit();
  const [mode, setMode] = useState<Mode>('newDir');
  const [name, setName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  // 利用者が名前を自分で直したか。直す前は、選んだフォルダの basename を名前に入れる。
  const [nameTouched, setNameTouched] = useState(false);
  // 開いた時点の Finder の回数。これより新しい結果だけを使う（別のダイアログで選んだ結果を当てない）。
  const pickedAtOpen = useRef(props.picked?.n ?? 0);

  const choosePath = (p: string) => {
    setPath(p);
    if (!nameTouched) setName(baseName(p));
  };
  useEffect(() => {
    const p = props.picked;
    if (!p || p.n <= pickedAtOpen.current) return;
    pickedAtOpen.current = p.n;
    setMode('dir');
    choosePath(p.path);
  }, [props.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (startSession: boolean) => {
    if (props.submitting) return;
    const place: ProjectPlace = mode === 'newDir' ? { kind: 'newDir', name, gitInit } : { kind: 'dir', path, name };
    emit({ type: 'project.new.submit', place, startSession });
  };
  // Enter は「作成して始める」。変換中の Enter は確定のための打鍵なので、送信に使わない。
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit(true);
  };

  const needle = query.trim().toLowerCase();
  const shown = props.dirs.filter((d) => !needle || d.name.toLowerCase().includes(needle));
  const root = props.workspaceRoot ?? '~/workspace';
  const close = () => emit({ type: 'overlay.close' });
  // 名前を打ちかけたまま背景を押し違えても失わないよう、背景では閉じない。
  return (
    <Dialog
      title="新しいプロジェクト"
      icon="folderPlus"
      className="dialog-wide"
      onClose={close}
      closeOnBackdrop={false}
      footer={<>
        <button type="button" className="btn" onClick={close}>やめる</button>
        <span className="spacer" />
        <button type="button" className="btn" disabled={props.submitting} onClick={() => submit(false)}>作成</button>
        <button type="button" className="btn btn-primary" disabled={props.submitting} onClick={() => submit(true)}>作成して始める</button>
      </>}
    >
      <div><Segmented label="作り方" value={mode} options={MODES} onChange={(v) => setMode(v as Mode)} /></div>
      {mode === 'newDir' ? (
        <>
          <label className="field" htmlFor="new-project-name">プロジェクト名
            <input id="new-project-name" className="input mono" data-autofocus value={name} placeholder="ワークスペースに作るディレクトリの名前" onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
          </label>
          <div className="faint">{root}/{name.trim()} を作ります</div>
          <CheckCard label="git init する" description="空のリポジトリを作ります" icon="gitInit" checked={gitInit} onChange={setGitInit} />
        </>
      ) : (
        <>
          <div className="field">フォルダ
            <div className="new-project-dirs">
              <div className="listbox-search"><Icon name="search" /><input aria-label="未登録のフォルダを探す" placeholder="ワークスペースの未登録のフォルダを探す" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
              <div role="listbox" aria-label="ワークスペースの未登録のフォルダ" className="listbox-rows">
                {shown.map((d) => (
                  <div key={d.path} role="option" aria-selected={d.path === path} aria-label={d.name} className="listbox-opt" onClick={() => choosePath(d.path)}>
                    <Icon name="folder" />
                    <span className="listbox-opt-main"><b>{d.name}</b><small>{d.path}</small></span>
                    <span className="listbox-check" aria-hidden="true"><Icon name="check" /></span>
                  </div>
                ))}
                {shown.length === 0 && <div className="listbox-empty">{props.dirs.length ? '一致するものはありません' : '未登録のフォルダはありません'}</div>}
              </div>
            </div>
            <div className="field-row">
              {props.desktop && <><button type="button" className="btn" onClick={() => emit({ type: 'folder.pick' })}><Icon name="folderOpen" />ほかの場所を選ぶ…</button><span className="faint">または</span></>}
              <input className="input mono" style={{ flex: 1 }} aria-label="フォルダのパス" placeholder="/Users/you/…（パスを打つ）" value={path} onChange={(e) => choosePath(e.target.value)} onKeyDown={onEnter} />
            </div>
          </div>
          <label className="field" htmlFor="new-project-reg-name">プロジェクト名
            <input id="new-project-reg-name" className="input" value={name} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} onKeyDown={onEnter} />
          </label>
        </>
      )}
      {props.error && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
```

`Segmented` の props の形（`options` の要素の型、`onChange` の引数）を `primitives/Segmented.tsx` で確かめ、合わなければ合わせる。`Dialog` の `icon` が `IconName` を取るので、Task 8 で足した `folderPlus` を使う。

`controls.css` に足す:

```css
/* 作成のダイアログの、未登録のフォルダの一覧。開いたままの Listbox の面と同じ見た目にする。 */
.new-project-dirs { display: flex; flex-direction: column; max-height: 232px; padding: calc(var(--u) * 1.5); border-radius: var(--r-lg); background: rgba(255, 255, 255, 0.6); box-shadow: inset 0 0 0 1px var(--line); }
```

- [ ] **Step 5: プロジェクト画面、Root、パレットに繋ぐ**

`views/ProjectsScreen.tsx`:
- `import { useEmit } from '../intent/chain.tsx';` と `import { Icon } from './primitives/Icon.tsx';` を足し、関数の頭で `const emit = useEmit();`。
- 見出しの「アーカイブを表示」のボタンの後ろに足す:

```tsx
        <button className="btn btn-primary" onClick={() => emit({ type: 'project.new.open' })}><Icon name="add" /><span className="btn-label">新しいプロジェクト</span></button>
```

`Root.tsx`:
- `import { presentNewProject } from './presenters/newProject.ts';` と `import { NewProjectDialog } from './views/NewProjectDialog.tsx';` を足す。
- `{overlay.kind === 'promote' && …}` の上に足す:

```tsx
      {overlay.kind === 'newProject' && <NewProjectDialog {...presentNewProject(state, store)!} />}
```

`presenters/palette.ts` の 127 行の `cmd('cmd:new-scratch', …)` の下に足す:

```ts
    cmd('cmd:new-project', '新しいプロジェクト', 'add'),
```

- [ ] **Step 6: 試験を回す**

Run: `npx vitest run packages/ui`
Expected: PASS

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src
git commit -m "feat(ui): create a project from the projects screen and the palette

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 設計書を更新し、ビルドして実物で確かめる

**Files:**
- Modify: `docs/design.md`

- [ ] **Step 1: 設計書を更新する**

`docs/design.md` で:
- 158 行付近の Intent の一覧の `project.new.*` を `{ type: 'project.new.open' } | { type: 'project.new.submit'; place: ProjectPlace; startSession: boolean }` に替え、`folder.pick` を足し、`session.new.submit` に `place?: ProjectPlace` を足す。
- 「起動ダイアログ」の節（600 行付近から、713 行のスクラッチの行の後ろ）に、仕様書の「新しいセッションのダイアログ」の「一覧」「選んだ後」「起動の流れ」の要点を移す（未登録は検索したときだけ、下端の 2 つの操作、選んだものごとの見出しと 1 行、作ってから起動と、作れた後の失敗で二重に作らないこと）。
- Projects の節に、見出しの「新しいプロジェクト」と作成のダイアログ（2 つのモード、「作成」「作成して始める」）を足す。パレットのコマンドの行（1180 行付近）に「新しいプロジェクト」を足す。
- 「プロジェクトの同定」の 1083 行「セッションのない直下ディレクトリは『新規プロジェクト』で既存ディレクトリを選ぶときの候補にだけ出す。」を次に替える:「セッションのない直下ディレクトリは、新しいセッションのダイアログの検索と、作成のダイアログの未登録の一覧にだけ出す。起動した後に、直下の新しいディレクトリでセッションが現れたら、起動時と同じ規則でその場でプロジェクトにする。」
- 2144 行の決めた前提の末尾「ここで勝手にプロジェクトを作ることはしない。」を「ワークスペース直下のディレクトリはその場でプロジェクトにし（2026-10-01 に改めた）、ワークスペースの外では勝手にプロジェクトを作らない。」に替える。
- API の一覧（2128 行付近の昇格の行の近く）に `POST /api/projects`（2 つの形）と `GET /api/workspace/dirs` を足す。

- [ ] **Step 2: 全部の試験と型**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 3: ビルドする（UI、サーバの束、殻）**

```bash
npm run build
npm run bundle-server -w apps/desktop
npm run tauri -w apps/desktop -- build
```

Expected: 3 つとも成功。tauri の build は数分かかるので、背景で回して結果を確かめる。

- [ ] **Step 4: 実物で確かめる**

ビルドした `.app`（`apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app`）か dev で、次を確かめる。サーバのポート 4177 は固定なので、利用者の `npm run dev` のサーバを落とす必要があるときは、PID を確かめてその 1 つだけを落とし、報告に書く。

1. ⌘N →「zz-hangar-test」と打つ → 下端の「『zz-hangar-test』を新しいフォルダとして作る」→ Enter → 見出しが「新しいフォルダで始める」、git init がオン → ⌘↵ で起動し、`~/workspace/zz-hangar-test/.git` があり、プロジェクトに出る。
2. ⌘N → 未登録のフォルダの名前の一部を打つ →「未登録」の札の行を選ぶ → 起動すると、そのフォルダがプロジェクトになる。
3. ⌘N →「ほかの場所を選ぶ…」→ Finder でワークスペースの外のフォルダを選ぶ → 外である旨の 1 行が出て、起動すると登録される。
4. プロジェクト画面の「新しいプロジェクト」→ 新しいフォルダで「作成」→ そのプロジェクトの画面へ移る。既存のフォルダで「作成して始める」→ 新しいセッションのダイアログがそのプロジェクトを選んで開く。
5. ターミナルで `mkdir ~/workspace/zz-hangar-live && cd $_ && claude -p hi` → アプリに未分類のトーストが出ず、プロジェクト `zz-hangar-live` が現れる。
6. 確かめに作ったフォルダとプロジェクトは、利用者に消してよいかを聞いてから片付ける（hangar はファイルを消さない。フォルダを消すのは利用者の判断）。

- [ ] **Step 5: Commit と push**

```bash
git add docs/design.md
git commit -m "docs: describe creating projects from the dialogs in the design

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```
