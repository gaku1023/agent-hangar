# TODO の完了候補 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セッションが「片付いた」と判断した TODO を完了にせず完了の候補として出し、利用者が右レールと Home で確定か却下をする。

**Architecture:** 共有テーブル `todos` に候補の 4 列を足し（マイグレーション version 10）、移り方はすべて `packages/server/src/projects/todos.ts` の関数に閉じ込める。MCP の `update_project` と HTTP の confirm と reject の入口はその関数を呼ぶだけにし、指示の注入は TODO の ID を渡して候補を出すよう求める。UI は `TodoDto.candidate` を Presenter で表示用の文に直し、右レールの TODO と Home の「確かめる」区画に出す。

**Tech Stack:** Node 22、TypeScript 6、better-sqlite3、Hono、`@modelcontextprotocol/sdk` と zod、React 19、vitest 5（`ui` の `node` と `dom` の子プロジェクト）、@testing-library/react 16、Tauri 2.11。

**Spec:** `docs/superpowers/specs/2026-09-30-todo-candidates-design.md`（試作は `docs/superpowers/specs/2026-09-30-todo-candidates/placement.html` の A1、A2、B1、C1）

## Global Constraints

- 作業はすべて worktree `/Users/satog/workspace/agent-hangar-todo-candidates`（ブランチ `todo-candidates`）で行う。元の作業ツリー `/Users/satog/workspace/agent-hangar` には別のセッションの未コミットの変更があるので、読むことも含めて触らない。
- 共有テーブル `todos` に足す列は `candidate_at integer`、`candidate_session_id text`、`candidate_note text`、`rejected_sessions text not null default '[]'` の 4 つで、マイグレーションは version 10 の 1 つだけにする。D1（`packages/cloud`）は変えない。
- 根拠の一文は空白を除いて 1 字以上 200 字以下（`CANDIDATE_NOTE_MAX = 200`）。
- MCP の `outcome` の綴りは `proposed`、`already_candidate`、`already_done`、`rejected_before`、`reopened` の 5 つだけ。
- MCP からは TODO を完了にできない。完了にするのは HTTP の `POST /api/todos/:id/confirm` と、`PATCH /api/todos/:id` の `done: true`（利用者の操作）だけである。
- 画面の文言は仕様どおりにする：区画の見出し「確かめる」、ボタン「確定」「却下」、根拠が無いとき「根拠は書かれていません」、セッションが分からないとき「不明なセッション」、読み上げの名前「<本文>（<n> 件目、完了の候補）」。
- 候補の色はトークン `--cand: #6a4fd0` と `--cand-soft: #f1edff` だけを通す。CSS に色の直書きをしない。
- 常にライトで、ダークモードは持たない。`prefers-color-scheme` と `data-theme` を書かない。長さは動きのトークンを通し、数値を直書きしない。`text-shadow` と `backdrop-filter` を足さない。
- テストは実物の `~/.agent-hangar` と `~/.claude` に触れない。実物の外部サービス（Cloudflare、本番の Worker と D1 と R2、GitHub）に触れない。`git push` をしない。
- ポート番号でプロセスを止めない。止めてよいのは Task 8 の、LISTEN している利用者の dev サーバ 1 つだけ（`lsof -nP -iTCP:4177 -sTCP:LISTEN -t` で PID を採り、`ps -o command= -p <PID>` で `packages/server` の tsx のサーバだと確かめてから）。`/Applications` の下には触らない。
- 日本語の文書は一文ごとに改行し、地の文でダッシュと中黒を使わない。コードのコメントは周りの書き方（日本語、「なぜ」を書く）に合わせる。
- コミットメッセージは英語の Conventional Commits で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` をそのまま付ける（どのモデルが書いても同じ文字列）。`git add` の後の素の `git commit` ではなく `git commit <path>...` のパス指定形で入れる（新しいファイルだけは直前に `git add <そのパス>`）。`--amend` と rebase は使わない。パッケージ管理は npm。
- 試験はリポジトリの根から `npx vitest run <path>` で走らせる。型検査は根で `npm run typecheck`。

## Review Focus

- **Claude が同じ TODO に 2 回 `propose_done` を投げ、2 回目で根拠を書き換える。** 利用者が読んでいる根拠は差し替わらず、2 回目は `already_candidate` になるべきである。Task 1 と Task 2 の試験で固定する。
- **利用者が候補の行のチェック欄を押す。** 反転（未完のまま `done: false` を送る）ではなく確定になるべきである。Task 5 の Runtime の試験で固定する。
- **候補を出したセッションが手元に無い（削除済み、同期前、セッション別でない URL から出た）。** 名前の代わりに「不明なセッション」を出し、押せるリンクにしないべきである。Task 6 の Presenter と Task 7 の View の試験で固定する。
- **同期で `done = 1` かつ `candidate_at` 非 null の行が届く。** 完了として出し、Home の「確かめる」にも件数にも入れないべきである。Task 1 と Task 6 の試験で固定する。
- **`propose_done` の根拠が空白だけか 201 字、または他の項目と一緒に見つからない ID が混ざる。** 呼び出し全体を断り、どの TODO も書かないべきである。Task 2 の試験で固定する。

---

## 作るファイルと変えるファイル

| ファイル | 役目 | Task |
|---|---|---|
| `packages/server/src/db/migrations.ts`、`db/db.test.ts` | version 10 の 4 列 | 1 |
| `packages/shared/src/api.ts` | `TodoCandidateDto` と `TodoDto.candidate` | 1 |
| `packages/server/src/projects/todos.ts`、`todos.test.ts` | 候補の移り方（出す、確定、却下、付け外しで消す） | 1 |
| `packages/server/src/sync/apply.test.ts` | 候補の列の往復 | 1 |
| `packages/server/src/mcp/tools.ts`、`mcp/app.ts`、`mcp/tools.test.ts` | `propose_done`、`toggle_todos` の意味、`todo_results` | 2 |
| `packages/server/src/launch/injection.ts`、`injection.test.ts`、`runs/manager.ts` | ID つきの TODO と指示の 2 行 | 3 |
| `packages/server/src/http/app.ts`、`http/app.test.ts` | confirm と reject の入口 | 4 |
| `packages/shared/src/intent.ts`、`packages/ui/src/mediator/types.ts`、`mediator/workbench.ts`、`runtime/api.ts`、`runtime/runtime.ts`、`test/fakeApi.ts` と各試験 | Intent と作用と API | 5 |
| `packages/ui/src/presenters/project.ts`、`presenters/home.ts`、`presenters/presenters.test.ts` | 候補の表示用の文、Home の「確かめる」、件数 | 6 |
| `packages/ui/src/views/TodoList.tsx`、`views/HomeScreen.tsx`、`styles/tokens.css`、`styles/workbench.css`、`styles/home.css` と各試験 | 右レールの行と Home の区画 | 7 |
| `docs/design.md` | 本体の設計書への反映 | 8 |

---

### Task 1: 候補のデータと移り方

**Files:**
- Modify: `packages/server/src/db/migrations.ts`（末尾の version 9 の後）
- Modify: `packages/shared/src/api.ts:39`
- Modify: `packages/server/src/projects/todos.ts`
- Test: `packages/server/src/projects/todos.test.ts`、`packages/server/src/db/db.test.ts`、`packages/server/src/sync/apply.test.ts`

**Interfaces:**
- Consumes: `upsertShared(db, table, row, deviceId)`（`db/shared.ts`、`updated_at` と `origin_device` を自分で埋める）
- Produces:
  - `type TodoCandidateDto = { sessionId: string | null; note: string | null; at: number }`（`@agent-hangar/shared`）
  - `TodoDto.candidate?: TodoCandidateDto | null`（古いサーバからは欠けるので省略可にする）
  - `CANDIDATE_NOTE_MAX = 200`
  - `type ProposeOutcome = 'proposed' | 'already_candidate' | 'already_done' | 'rejected_before'`
  - `proposeTodoDone(db, deviceId, id, o: { sessionId: string | null; note: string | null; now?: number }): { todo: TodoDto; outcome: ProposeOutcome } | null`
  - `type ConfirmResult = 'confirmed' | 'already_done' | 'not_candidate'`
  - `confirmTodo(db, deviceId, id): { todo: TodoDto; result: ConfirmResult } | null`
  - `type RejectResult = 'rejected' | 'not_candidate'`
  - `rejectTodo(db, deviceId, id): { todo: TodoDto; result: RejectResult } | null`
  - `setTodoDone` は候補の 3 列も null にする（署名は変えない）

- [ ] **Step 0: worktree に依存を入れる**

Run: `cd /Users/satog/workspace/agent-hangar-todo-candidates && npm ci`
Expected: 終了コード 0。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/projects/todos.test.ts` の import を次に替え、`describe('todos', ...)` の後に足す。

```ts
import { addTodo, confirmTodo, listTodos, proposeTodoDone, rejectTodo, removeTodo, setTodoDone } from './todos.ts';
```

```ts
describe('完了の候補', () => {
  const row = (db: ReturnType<typeof seed>, id: string) => db.prepare('select done, candidate_at, candidate_session_id, candidate_note, rejected_sessions from todos where id = ?').get(id);

  it('候補を出しても完了にはせず、出したセッションと根拠を持つ', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(a.candidate).toBeNull();
    const r = proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '直して確かめた', now: 500 });
    expect(r).toEqual({ outcome: 'proposed', todo: expect.objectContaining({ id: a.id, done: false, candidate: { sessionId: 's1', note: '直して確かめた', at: 500 } }) });
    expect(row(db, a.id)).toEqual({ done: 0, candidate_at: 500, candidate_session_id: 's1', candidate_note: '直して確かめた', rejected_sessions: '[]' });
    expect(proposeTodoDone(db, 'd', 'nope', { sessionId: 's1', note: 'x' })).toBeNull();
  });

  it('すでに候補なら根拠を上書きせず、完了なら何もしない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '最初の根拠', now: 500 });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '書き換え', now: 900 })?.outcome).toBe('already_candidate');
    expect(row(db, a.id)).toMatchObject({ candidate_at: 500, candidate_note: '最初の根拠' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    setTodoDone(db, 'd', b.id, true);
    expect(proposeTodoDone(db, 'd', b.id, { sessionId: 's1', note: 'x' })?.outcome).toBe('already_done');
    expect(row(db, b.id)).toMatchObject({ done: 1, candidate_at: null });
  });

  it('確定は完了にして候補を消す。完了済みは何もせず、候補でない未完は断る', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('not_candidate');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    expect(confirmTodo(db, 'd', a.id)).toEqual({ result: 'confirmed', todo: expect.objectContaining({ done: true, candidate: null }) });
    expect(row(db, a.id)).toMatchObject({ done: 1, candidate_at: null, candidate_session_id: null, candidate_note: null });
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('already_done');
    expect(confirmTodo(db, 'd', 'nope')).toBeNull();
  });

  it('却下は未完に戻し、出したセッションを一度だけ積み、同じセッションからは出し直せない', () => {
    const db = seed();
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 's2', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(rejectTodo(db, 'd', a.id)?.result).toBe('not_candidate');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    expect(rejectTodo(db, 'd', a.id)).toEqual({ result: 'rejected', todo: expect.objectContaining({ done: false, candidate: null }) });
    expect(row(db, a.id)).toMatchObject({ done: 0, candidate_at: null, rejected_sessions: '["s1"]' });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'もう一度' })?.outcome).toBe('rejected_before');
    // 別のセッションなら出せる。そのセッションを却下すると積み足される。
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's2', note: '別' })?.outcome).toBe('proposed');
    rejectTodo(db, 'd', a.id);
    expect(row(db, a.id)).toMatchObject({ rejected_sessions: '["s1","s2"]' });
    expect(rejectTodo(db, 'd', 'nope')).toBeNull();
  });

  it('セッションの分からない候補は、却下しても積まないので出し直せる', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: null, note: null });
    expect(listTodos(db, 'p1')[0]!.candidate).toMatchObject({ sessionId: null, note: null });
    rejectTodo(db, 'd', a.id);
    expect(row(db, a.id)).toMatchObject({ rejected_sessions: '[]' });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: null, note: null })?.outcome).toBe('proposed');
  });

  it('利用者がチェックを付け外しすると候補は消え、開き直しても却下の記録は残す', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    rejectTodo(db, 'd', a.id);
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 's2', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's2', note: 'n' });
    expect(setTodoDone(db, 'd', a.id, true)).toMatchObject({ done: true, candidate: null });
    expect(setTodoDone(db, 'd', a.id, false)).toMatchObject({ done: false, candidate: null });
    expect(row(db, a.id)).toMatchObject({ candidate_at: null, rejected_sessions: '["s1"]' });
  });

  it('完了かつ候補という矛盾した行は、完了として読み、候補は無いものとする', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    // 同期でしか起きない形を直接作る。
    db.prepare('update todos set done = 1, candidate_at = 5, candidate_session_id = ? where id = ?').run('s1', a.id);
    expect(listTodos(db, 'p1')[0]).toMatchObject({ done: true, candidate: null });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' })?.outcome).toBe('already_done');
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('already_done');
  });

  it('rejected_sessions が壊れていても投げずに空として読む', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    db.prepare("update todos set rejected_sessions = 'not json' where id = ?").run(a.id);
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' })?.outcome).toBe('proposed');
  });
});
```

`packages/server/src/db/db.test.ts` の `describe('openDb', ...)` の中に足す。

```ts
  it('version 10 で todos に候補の列が足され、既存の行の rejected_sessions は [] になる', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mig-'));
    const file = path.join(tmp, 'hangar.db');
    openDbAt(file, 9);
    const old = new Database(file);
    old.prepare("insert into projects (id, name, status, is_scratch, updated_at, origin_device) values ('p1', 'a', 'active', 0, 1, 'd')").run();
    old.prepare("insert into todos (id, project_id, text, done, position, updated_at, origin_device) values ('t1', 'p1', 'x', 0, 1, 1, 'd')").run();
    old.close();
    const db = openDb(file);
    const cols = (db.prepare('pragma table_info(todos)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['candidate_at', 'candidate_session_id', 'candidate_note', 'rejected_sessions']));
    expect(db.prepare("select candidate_at, candidate_session_id, candidate_note, rejected_sessions from todos where id = 't1'").get()).toEqual({ candidate_at: null, candidate_session_id: null, candidate_note: null, rejected_sessions: '[]' });
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
```

`packages/server/src/sync/apply.test.ts` の `describe('applyRemoteChange', ...)` の中に足す。

```ts
  it('TODO の候補の列は同期で往復する', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'a', status: 'active', is_scratch: 0 }, 'a');
    const payload = { id: 't1', project_id: 'p1', text: 'x', done: 0, position: 1, session_id: null, candidate_at: 7, candidate_session_id: 's9', candidate_note: '根拠', rejected_sessions: '["s1"]', updated_at: 100, deleted_at: null, origin_device: 'b' };
    expect(applyRemoteChange(db, { seq: 1, tableName: 'todos', rowId: 't1', op: 'upsert', deviceId: 'b', updatedAt: 100, payload }, o)).toBe('applied');
    expect(db.prepare('select candidate_at, candidate_session_id, candidate_note, rejected_sessions from todos where id = ?').get('t1')).toEqual({ candidate_at: 7, candidate_session_id: 's9', candidate_note: '根拠', rejected_sessions: '["s1"]' });
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/projects/todos.test.ts packages/server/src/db/db.test.ts packages/server/src/sync/apply.test.ts`
Expected: FAIL。`proposeTodoDone` が export されていない、`candidate_at` の列が無い、など。

- [ ] **Step 3: 実装する**

`packages/server/src/db/migrations.ts` の配列の末尾（version 9 の後）に足す。

```ts
  {
    // TODO の完了の候補。セッションが「片付いた」と判断しても完了にはせず、利用者が確かめるまで候補として持つ。
    // 共有テーブルの列なので同期の payload に載る。D1 は行を JSON のまま持つので、クラウド側のマイグレーションは要らない。
    // 列を持たない古い端末は、適用のときに自分の表に無い列を捨てる（sync/apply.ts の tableColumns）。
    // rejected_sessions は、この TODO の候補を却下されたセッション ID の JSON 配列である。
    version: 10,
    sql: `
alter table todos add column candidate_at integer;
alter table todos add column candidate_session_id text;
alter table todos add column candidate_note text;
alter table todos add column rejected_sessions text not null default '[]';
`,
  },
```

`packages/shared/src/api.ts:39` の `TodoDto` を置き換える。

```ts
/** 完了の候補。sessionId はセッション別でない MCP の URL から出たとき null、note は根拠が無いとき null。 */
export type TodoCandidateDto = { sessionId: string | null; note: string | null; at: number };
/** candidate は古いサーバからは欠ける。欠けたものは null として扱う。 */
export type TodoDto = { id: string; projectId: string; text: string; done: boolean; position: number; sessionId: string | null; updatedAt: number; candidate?: TodoCandidateDto | null };
```

`packages/server/src/projects/todos.ts` を次のように変える（`listTodos`、`addTodo`、`removeTodo` の本体はそのまま）。

```ts
import { newId, type TodoDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';

type Row = {
  id: string; project_id: string; text: string; done: number; position: number; session_id: string | null; updated_at: number;
  candidate_at: number | null; candidate_session_id: string | null; candidate_note: string | null; rejected_sessions: string;
};

/** 根拠の一文の上限（空白を除いた字数）。 */
export const CANDIDATE_NOTE_MAX = 200;

// 完了かつ候補という矛盾は同期の競り合いでしか起きない。完了を正とし、候補は無いものとして読む（書き直しはしない）。
const toDto = (r: Row): TodoDto => ({
  id: r.id, projectId: r.project_id, text: r.text, done: r.done === 1, position: r.position, sessionId: r.session_id, updatedAt: r.updated_at,
  candidate: r.candidate_at !== null && r.done !== 1 ? { sessionId: r.candidate_session_id, note: r.candidate_note, at: r.candidate_at } : null,
});

const NO_CANDIDATE = { candidate_at: null, candidate_session_id: null, candidate_note: null };

const liveRow = (db: Db, id: string) => db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined;
const reread = (db: Db, id: string) => toDto(db.prepare('select * from todos where id = ?').get(id) as Row);

/** 却下されたセッションの一覧。壊れた値は空として読む。候補を出す道を投げて止めるより、出せてしまう方が害が小さい。 */
function rejectedOf(r: Row): string[] {
  try {
    const v: unknown = JSON.parse(r.rejected_sessions);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
```

`setTodoDone` を置き換え、その後に 3 つの関数を足す。

```ts
/** 完了の印を付け外しする。利用者の操作なので、候補の印もあわせて消す。見つからないときは null を返す。 */
export function setTodoDone(db: Db, deviceId: string, id: string, done: boolean): TodoDto | null {
  const row = liveRow(db, id);
  if (!row) return null;
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, done: done ? 1 : 0 }, deviceId);
  return reread(db, id);
}

export type ProposeOutcome = 'proposed' | 'already_candidate' | 'already_done' | 'rejected_before';

/**
 * 完了の候補にする。完了にはしない（完了にするのは利用者だけ）。見つからないときは null を返す。
 * すでに候補なら根拠を上書きしない。利用者が読んでいる最中に中身が差し替わらないようにするためである。
 */
export function proposeTodoDone(db: Db, deviceId: string, id: string, o: { sessionId: string | null; note: string | null; now?: number }): { todo: TodoDto; outcome: ProposeOutcome } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.done === 1) return { todo: toDto(row), outcome: 'already_done' };
  if (row.candidate_at !== null) return { todo: toDto(row), outcome: 'already_candidate' };
  if (o.sessionId !== null && rejectedOf(row).includes(o.sessionId)) return { todo: toDto(row), outcome: 'rejected_before' };
  upsertShared(db, 'todos', { ...row, candidate_at: o.now ?? Date.now(), candidate_session_id: o.sessionId, candidate_note: o.note }, deviceId);
  return { todo: reread(db, id), outcome: 'proposed' };
}

export type ConfirmResult = 'confirmed' | 'already_done' | 'not_candidate';

/** 候補を確定して完了にする。すでに完了なら何もしない。見つからないときは null を返す。 */
export function confirmTodo(db: Db, deviceId: string, id: string): { todo: TodoDto; result: ConfirmResult } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.done === 1) return { todo: toDto(row), result: 'already_done' };
  if (row.candidate_at === null) return { todo: toDto(row), result: 'not_candidate' };
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, done: 1 }, deviceId);
  return { todo: reread(db, id), result: 'confirmed' };
}

export type RejectResult = 'rejected' | 'not_candidate';

/**
 * 候補を却下して未完に戻す。出したセッションを rejected_sessions に一度だけ積む。
 * セッションの分からない候補は積まない（積む鍵が無いので、出し直しは止められない）。
 */
export function rejectTodo(db: Db, deviceId: string, id: string): { todo: TodoDto; result: RejectResult } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.done === 1 || row.candidate_at === null) return { todo: toDto(row), result: 'not_candidate' };
  const rejected = rejectedOf(row);
  const sid = row.candidate_session_id;
  const next = sid !== null && !rejected.includes(sid) ? [...rejected, sid] : rejected;
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, rejected_sessions: JSON.stringify(next) }, deviceId);
  return { todo: reread(db, id), result: 'rejected' };
}
```

`addTodo` の末尾の `return toDto(db.prepare('select * from todos where id = ?').get(id) as Row);` は `return reread(db, id);` に、`removeTodo` の `db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined` は `liveRow(db, id)` に置き換える。

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/projects/todos.test.ts packages/server/src/db/db.test.ts packages/server/src/sync/apply.test.ts`
Expected: PASS。

Run: `npx vitest run packages/server && npm run typecheck`
Expected: 既存の試験も含めて PASS、型検査 0 件。

- [ ] **Step 5: コミットする**

```bash
git commit packages/server/src/db/migrations.ts packages/server/src/db/db.test.ts packages/shared/src/api.ts packages/server/src/projects/todos.ts packages/server/src/projects/todos.test.ts packages/server/src/sync/apply.test.ts -m "feat(server): hold TODO completion candidates that only the user can confirm

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: MCP の `update_project`

**Files:**
- Modify: `packages/server/src/mcp/tools.ts:113-117`（`todoBriefs`）、`:152-197`（`updateProjectTool`）
- Modify: `packages/server/src/mcp/app.ts:38`
- Test: `packages/server/src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `proposeTodoDone`、`setTodoDone`、`CANDIDATE_NOTE_MAX`、`ProposeOutcome`（Task 1）
- Produces:
  - `update_project` の引数 `propose_done?: { todo_id: string; note: string }[]`
  - 応答に `todo_results: { todo_id: string; outcome: 'proposed' | 'already_candidate' | 'already_done' | 'rejected_before' | 'reopened' }[]`
  - `todoBriefs` の各行に `candidate: { session_id: string | null; note: string | null } | null`

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/mcp/tools.test.ts` の既存の試験「update_project は status、TODO、メモを書き、イベントを配る」の `r2` の 2 行を、候補になることを確かめる形に替える。

```ts
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [ids[0]!], append_memo: '続き' });
    // toggle_todos は未完を完了にしない。候補にするだけで、未完の数も変わらない。
    expect((r2.todos as { done: boolean; candidate: unknown }[]).map((t) => [t.done, t.candidate])).toEqual([[false, { session_id: null, note: null }], [false, null]]);
    expect(r2.todo_results).toEqual([{ todo_id: ids[0], outcome: 'proposed' }]);
    expect(r2.memo).toBe('## 追記\n\n続き');
    expect((r2.project as { open_todo_count: number }).open_todo_count).toBe(2);
```

同じ `describe('MCP tools', ...)` の中に足す。

```ts
  it('propose_done は根拠つきの候補を出し、TODO ごとの結果を返す', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a', 'b', 'c'] });
    const [a, b, c] = (r.todos as { id: string }[]).map((t) => t.id);
    call('update_project', { project_id: 'p1', toggle_todos: [c!] });
    // c は候補になった。完了にするには利用者の操作が要るので、ここでは DB を直接完了にして already_done を作る。
    db.prepare('update todos set done = 1, candidate_at = null where id = ?').run(c);
    sent.length = 0;
    const r2 = call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: ' 直して試験で確かめた ' }, { todo_id: c, note: '済み' }] }, { sessionId: alphaId });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'proposed' }, { todo_id: c, outcome: 'already_done' }]);
    const briefs = r2.todos as { id: string; done: boolean; candidate: unknown }[];
    expect(briefs.find((t) => t.id === a)).toMatchObject({ done: false, candidate: { session_id: alphaId, note: '直して試験で確かめた' } });
    expect(briefs.find((t) => t.id === b)).toMatchObject({ done: false, candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    // 2 回目は根拠を書き換えない。
    const r3 = call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: '書き換え' }] }, { sessionId: alphaId });
    expect(r3.todo_results).toEqual([{ todo_id: a, outcome: 'already_candidate' }]);
    expect((r3.todos as { id: string; candidate: { note: string } | null }[]).find((t) => t.id === a)!.candidate!.note).toBe('直して試験で確かめた');
  });
  it('却下されたセッションは同じ TODO の候補を出し直せない（propose_done でも toggle_todos でも）', async () => {
    const { rejectTodo } = await import('../projects/todos.ts');
    const r = call('update_project', { project_id: 'p1', add_todos: ['a'] });
    const a = (r.todos as { id: string }[])[0]!.id;
    call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'n' }] }, { sessionId: alphaId });
    rejectTodo(db, 'd', a);
    expect(call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'もう一度' }] }, { sessionId: alphaId }).todo_results).toEqual([{ todo_id: a, outcome: 'rejected_before' }]);
    expect(call('update_project', { project_id: 'p1', toggle_todos: [a] }, { sessionId: alphaId }).todo_results).toEqual([{ todo_id: a, outcome: 'rejected_before' }]);
  });
  it('toggle_todos は完了を開き直し、候補には何もしない', async () => {
    const { setTodoDone } = await import('../projects/todos.ts');
    const r = call('update_project', { project_id: 'p1', add_todos: ['a', 'b'] });
    const [a, b] = (r.todos as { id: string }[]).map((t) => t.id);
    setTodoDone(db, 'd', a!, true);
    call('update_project', { project_id: 'p1', toggle_todos: [b!] });
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [a!, b!] });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'reopened' }, { todo_id: b, outcome: 'already_candidate' }]);
    expect((r2.todos as { done: boolean }[]).map((t) => t.done)).toEqual([false, false]);
  });
  it('propose_done の根拠が空白だけか 200 字を超えるか、見つからない ID があれば、どの TODO も書かない', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a'] });
    const a = (r.todos as { id: string }[])[0]!.id;
    sent.length = 0;
    expect(() => call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: '   ' }] })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'あ'.repeat(201) }] })).toThrow(/200/);
    expect(() => call('update_project', { project_id: 'p1', add_todos: ['b'], propose_done: [{ todo_id: a, note: 'n' }, { todo_id: 'nope', note: 'n' }] })).toThrow(/nope/);
    expect(() => call('update_project', { project_id: 'p1', propose_done: [{ note: 'n' }] })).toThrow(ToolError);
    expect(sent).toEqual([]);
    const p = call('get_project', { project_id: 'p1' });
    expect((p.todos as { text: string; candidate: unknown }[]).map((t) => [t.text, t.candidate])).toEqual([['a', null]]);
    // ちょうど 200 字は通る。
    expect(call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'あ'.repeat(200) }] }).todo_results).toEqual([{ todo_id: a, outcome: 'proposed' }]);
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/mcp/tools.test.ts`
Expected: FAIL。`todo_results` が undefined、toggle で `done` が true になる、など。

- [ ] **Step 3: 実装する**

`packages/server/src/mcp/tools.ts` の import を替える。

```ts
import { addTodo, CANDIDATE_NOTE_MAX, listTodos, proposeTodoDone, setTodoDone, type ProposeOutcome } from '../projects/todos.ts';
```

`todoBriefs` を置き換える。

```ts
/** プロジェクトの TODO を MCP の綴りで返す。セッションは、自分が出した候補が残っているかをここで確かめる。 */
function todoBriefs(deps: ToolDeps, projectId: string) {
  return listTodos(deps.db, projectId).map((t) => ({ id: t.id, text: t.text, done: t.done, session_id: t.sessionId, candidate: t.candidate ? { session_id: t.candidate.sessionId, note: t.candidate.note } : null }));
}

type TodoOutcome = ProposeOutcome | 'reopened';

/** propose_done の引数を検査して取り出す。1 件でも崩れていれば全体を断る（どの TODO も書かない）。 */
function proposalsOf(v: unknown): { todoId: string; note: string }[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ToolError('propose_done は { todo_id, note } の配列です');
  return v.map((x) => {
    const o = (typeof x === 'object' && x !== null ? x : {}) as { todo_id?: unknown; note?: unknown };
    if (typeof o.todo_id !== 'string' || typeof o.note !== 'string') throw new ToolError('propose_done の各項目には todo_id と note の文字列が要ります');
    const note = o.note.trim();
    if (!note) throw new ToolError('propose_done の note（根拠の一文）が空です');
    if ([...note].length > CANDIDATE_NOTE_MAX) throw new ToolError(`propose_done の note は ${CANDIDATE_NOTE_MAX} 字までです`);
    return { todoId: o.todo_id, note };
  });
}
```

`updateProjectTool` の TODO の書き込みの節（`const adds = ...` から `todos.update` を配るところまで）を置き換える。

```ts
  const adds = strs(args.add_todos) ?? [];
  const toggles = strs(args.toggle_todos) ?? [];
  const proposals = proposalsOf(args.propose_done);
  const results: { todo_id: string; outcome: TodoOutcome }[] = [];
  const todosTouched = adds.length > 0 || toggles.length > 0 || proposals.length > 0;
  if (todosTouched) {
    // 全部成功か全部失敗にする。
    // 途中で失敗して書き込みだけが残ると、todos.update を配らないまま DB が進み、UI と食い違ったまま気付けない。
    // MCP からは完了にしない。完了にするのは利用者だけなので、未完の反転は根拠なしの候補にする。
    deps.db.transaction(() => {
      for (const t of adds) addTodo(deps.db, deps.deviceId, { projectId: id, text: t, sessionId: ctx.sessionId });
      const ofProject = (tid: string) => {
        const cur = deps.db.prepare('select done from todos where id = ? and project_id = ? and deleted_at is null').get(tid, id) as { done: number } | undefined;
        if (!cur) throw new ToolError(`TODO が見つかりません: ${tid}`);
        return cur;
      };
      for (const tid of toggles) {
        if (ofProject(tid).done === 1) {
          setTodoDone(deps.db, deps.deviceId, tid, false);
          results.push({ todo_id: tid, outcome: 'reopened' });
        } else {
          results.push({ todo_id: tid, outcome: proposeTodoDone(deps.db, deps.deviceId, tid, { sessionId: ctx.sessionId, note: null })!.outcome });
        }
      }
      for (const p of proposals) {
        ofProject(p.todoId);
        results.push({ todo_id: p.todoId, outcome: proposeTodoDone(deps.db, deps.deviceId, p.todoId, { sessionId: ctx.sessionId, note: p.note })!.outcome });
      }
    })();
    deps.hub.broadcast({ type: 'todos.update', projectId: id, todos: listTodos(deps.db, id) });
  }
```

続く 2 か所の `adds.length || toggles.length` は `todosTouched` に替える。戻り値に `todo_results` を足す。

```ts
  return {
    project: { id: p.id, name: p.name, status: p.status, open_todo_count: p.openTodoCount },
    todos: todoBriefs(deps, id),
    todo_results: results,
    memo: deps.memos.read(id)?.markdown ?? null,
  };
```

関数の上の注記を `/** status、add_todos、toggle_todos、propose_done、append_memo を受け、変えた表ごとにイベントを配る。 */` に替える。

`packages/server/src/mcp/app.ts:38` を置き換える。

```ts
  reg('update_project', D('プロジェクトのステータスを変え、TODO を足し、片付いた TODO を完了の候補として出し、メモに追記する。完了にするのは利用者である。propose_done には TODO の ID と根拠の一文（200 字まで）を渡す。toggle_todos は完了を開き直すか、未完を根拠なしの候補にする。'), { project_id: z.string(), status: STATUS.optional(), add_todos: z.array(z.string()).optional(), toggle_todos: z.array(z.string()).optional(), propose_done: z.array(z.object({ todo_id: z.string(), note: z.string() })).optional(), append_memo: z.string().optional() });
```

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/mcp`
Expected: PASS（`app.test.ts` を含む）。

Run: `npm run typecheck`
Expected: 0 件。

- [ ] **Step 5: コミットする**

```bash
git commit packages/server/src/mcp/tools.ts packages/server/src/mcp/app.ts packages/server/src/mcp/tools.test.ts -m "feat(mcp): let sessions propose TODOs as done instead of completing them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 指示の注入

**Files:**
- Modify: `packages/server/src/launch/injection.ts`
- Modify: `packages/server/src/runs/manager.ts:133-134`
- Test: `packages/server/src/launch/injection.test.ts`、`packages/server/src/runs/manager.test.ts`（注入の文字列を見ている箇所があれば）

**Interfaces:**
- Consumes: なし
- Produces: `InjectionInput.todos: { id: string; text: string }[]`

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/launch/injection.test.ts` を、TODO を `{ id, text }` で渡す形に書き換える。4 つの試験の `todos` と期待値を次のように直す。

```ts
const todo = (n: number | string) => ({ id: `id${n}`, text: `t${n}` });
```

- 「テンプレートの各要素を埋める」：`todos: [{ id: 'ta', text: 'a' }, { id: 'tb', text: 'b' }]`、期待値は `'未完の TODO：\n- [ta] a\n- [tb] b'`。さらに次の 2 行を足す。

```ts
    expect(t).toContain('TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。\n完了にするのは利用者です。確かめられていないものは出さないでください。');
```

- 「メモは 500 字、TODO は 10 件に切り、無ければ（なし）」：`todos: Array.from({ length: 12 }, (_, i) => todo(i))`、期待値は `'- [id9] t9\n'` を含み `'- [id10] t10'` を含まない。
- 「TODO はちょうど 10 件なら全部、11 件なら 11 件目だけを落とす」：`const items = (n: number) => Array.from({ length: n }, (_, i) => todo(i + 1));`、期待値の行は `` `- [${t.id}] ${t.text}` ``、11 件目は `'- [id11] t11'` を含まない。
- 「メモはちょうど 500 字なら…」は `todos: []` のままでよい。

`packages/server/src/runs/manager.test.ts` で注入文の `- <本文>` を見ている箇所があれば、`grep -n "未完の TODO" packages/server/src/runs/manager.test.ts` で探し、`- [<id>] <本文>` の形に直す。

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/launch/injection.test.ts packages/server/src/runs/manager.test.ts`
Expected: FAIL（型か文字列が合わない）。

- [ ] **Step 3: 実装する**

`packages/server/src/launch/injection.ts` を置き換える。

```ts
export type InjectionInput = { projectName: string; projectPath: string; memo: string | null; todos: { id: string; text: string }[] };

const NONE = '（なし）';

/**
 * --append-system-prompt で渡す短い指示。ファイルや設定は書かず、要約の更新と、片付いた TODO の候補を求める。
 * TODO は ID を添えて渡す。ID が無いと、候補を出す前に get_project を呼んで引く一手が要るためである。
 */
export function renderInjection(i: InjectionInput): string {
  const memo = i.memo?.trim() ? [...i.memo.trim()].slice(0, 500).join('') : NONE;
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((t) => `- [${t.id}] ${t.text}`).join('\n') : NONE;
  return [
    'あなたは agent-hangar から起動されたセッションです。',
    `プロジェクト：${i.projectName}（${i.projectPath}）`,
    `プロジェクトのメモの要約：${memo}`,
    `未完の TODO：${todoText}`,
    '過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。',
    '依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、',
    'set_session_summary で題名、2〜3 文の要約、状態、次の一手を更新してください。',
    'TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。',
    '完了にするのは利用者です。確かめられていないものは出さないでください。',
    '',
  ].join('\n');
}
```

`packages/server/src/runs/manager.ts:133` を置き換える。

```ts
    const todos = projectId ? (this.db.prepare('select id, text from todos where project_id = ? and done = 0 and deleted_at is null order by position limit 10').all(projectId) as { id: string; text: string }[]) : [];
```

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/launch packages/server/src/runs && npm run typecheck`
Expected: PASS、型検査 0 件。

- [ ] **Step 5: コミットする**

```bash
git commit packages/server/src/launch/injection.ts packages/server/src/launch/injection.test.ts packages/server/src/runs/manager.ts packages/server/src/runs/manager.test.ts -m "feat(server): hand launched sessions TODO ids and ask them to propose finished ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（`manager.test.ts` を変えなかったときは、そのパスをコミットから外す。）

---

### Task 4: HTTP の confirm と reject

**Files:**
- Modify: `packages/server/src/http/app.ts:15`、`:618-633`
- Test: `packages/server/src/http/app.test.ts`（「TODO とメモ」の試験の後）

**Interfaces:**
- Consumes: `confirmTodo`、`rejectTodo`、`proposeTodoDone`（Task 1）
- Produces: `POST /api/todos/:id/confirm` と `POST /api/todos/:id/reject`。どちらも成功で 200 と `TodoDto`、見つからなければ 404、候補でなければ 409（`{ error: '<日本語の一文>' }`）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/http/app.test.ts` の import に `import { proposeTodoDone } from '../projects/todos.ts';` を足し、「TODO とメモ」の試験の後に足す。

```ts
  it('TODO の候補の確定と却下', async () => {
    const pid = list0ProjectId();
    const a = await (await post(`/api/projects/${pid}/todos`, { text: 'a' })).json();
    const b = await (await post(`/api/projects/${pid}/todos`, { text: 'b' })).json();
    // 候補でない未完は、確定も却下も 409 で断る。本文はトーストに出せる一文にする。
    const c409 = await post(`/api/todos/${a.id}/confirm`);
    expect(c409.status).toBe(409);
    expect((await c409.json()).error).toBe('この TODO は完了の候補ではありません');
    expect((await post(`/api/todos/${a.id}/reject`)).status).toBe(409);
    expect((await post('/api/todos/nope/confirm')).status).toBe(404);
    expect((await post('/api/todos/nope/reject')).status).toBe(404);

    proposeTodoDone(db, 'd', a.id, { sessionId: null, note: '直した' });
    proposeTodoDone(db, 'd', b.id, { sessionId: null, note: '直した' });
    sent.length = 0;
    const ok = await post(`/api/todos/${a.id}/confirm`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: a.id, done: true, candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    // すでに完了なら何もせず 200。
    expect((await post(`/api/todos/${a.id}/confirm`)).status).toBe(200);

    const rj = await post(`/api/todos/${b.id}/reject`);
    expect(rj.status).toBe(200);
    expect(await rj.json()).toMatchObject({ id: b.id, done: false, candidate: null });
    expect((await post(`/api/todos/${b.id}/reject`)).status).toBe(409);

    // 利用者のチェックの付け外しは候補を消す。
    proposeTodoDone(db, 'd', b.id, { sessionId: null, note: 'もう一度' });
    expect(await (await post(`/api/todos/${b.id}`, { done: false }, 'PATCH')).json()).toMatchObject({ done: false, candidate: null });
  });
```

`db` と `sent` と `list0ProjectId` はこのファイルに既にある。`deviceId` が `'d'` でなければ、`grep -n "deviceId" packages/server/src/http/app.test.ts | head` で試験の端末 ID を確かめて合わせる。

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts -t "候補"`
Expected: FAIL（404 が返る）。

- [ ] **Step 3: 実装する**

`packages/server/src/http/app.ts:15` の import を替える。

```ts
import { addTodo, confirmTodo, listTodos, rejectTodo, removeTodo, setTodoDone } from '../projects/todos.ts';
```

`api.patch('/todos/:id', ...)` の後に足す。

```ts
  // 完了の候補の確定と却下。どちらも利用者の操作で、MCP からは呼べない。
  const NOT_CANDIDATE = 'この TODO は完了の候補ではありません';
  api.post('/todos/:id/confirm', (c) => {
    const r = confirmTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: 'TODO が見つかりません' }, 404);
    if (r.result === 'not_candidate') return c.json({ error: NOT_CANDIDATE }, 409);
    if (r.result === 'confirmed') todosChanged(r.todo.projectId);
    return c.json(r.todo);
  });
  api.post('/todos/:id/reject', (c) => {
    const r = rejectTodo(db, deviceId, c.req.param('id'));
    if (!r) return c.json({ error: 'TODO が見つかりません' }, 404);
    if (r.result === 'not_candidate') return c.json({ error: NOT_CANDIDATE }, 409);
    todosChanged(r.todo.projectId);
    return c.json(r.todo);
  });
```

`PATCH` は `setTodoDone` が候補の列を消すようになったので、変えなくてよい。

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/http && npm run typecheck`
Expected: PASS、型検査 0 件。

- [ ] **Step 5: コミットする**

```bash
git commit packages/server/src/http/app.ts packages/server/src/http/app.test.ts -m "feat(server): add confirm and reject endpoints for TODO candidates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: UI の Intent と作用と API

**Files:**
- Modify: `packages/shared/src/intent.ts:27`
- Modify: `packages/ui/src/mediator/types.ts:44`、`packages/ui/src/mediator/workbench.ts:45-46`
- Modify: `packages/ui/src/runtime/api.ts:40`、`:110`、`packages/ui/src/runtime/runtime.ts:206-212`
- Modify: `packages/ui/src/test/fakeApi.ts`
- Test: `packages/ui/src/mediator/transition.test.ts`、`packages/ui/src/runtime/runtime.test.ts`、`packages/ui/src/runtime/api.test.ts`

**Interfaces:**
- Consumes: `TodoDto.candidate`（Task 1）、HTTP の confirm と reject（Task 4）
- Produces:
  - Intent `{ type: 'todo.confirm'; id: TodoId }` と `{ type: 'todo.reject'; id: TodoId }`
  - Effect `{ kind: 'api.confirmTodo'; id: string }` と `{ kind: 'api.rejectTodo'; id: string }`
  - `ApiClient.confirmTodo(id: string): Promise<TodoDto>` と `ApiClient.rejectTodo(id: string): Promise<TodoDto>`

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/mediator/transition.test.ts` の「TODO とメモとアーティファクトと要約は api 効果になる」の `run([...])` の `todo.remove` の後に 2 行を足す。

```ts
      intent({ type: 'todo.confirm', id: 't1' }),
      intent({ type: 'todo.reject', id: 't1' }),
```

期待値の配列の `{ kind: 'api.removeTodo', id: 't1' }` の直後に足す。

```ts
      { kind: 'api.confirmTodo', id: 't1' }, { kind: 'api.rejectTodo', id: 't1' },
```

`packages/ui/src/runtime/runtime.test.ts` の「TODO の反転はストアの現在値から done を決める」の後に足す。

```ts
  it('候補の TODO の反転は確定になり、確定と却下はそのまま API へ渡す', async () => {
    const setTodoDone = vi.fn(async (id: string, done: boolean) => p3Todo(id, done));
    const confirmTodo = vi.fn(async (id: string) => p3Todo(id, true));
    const rejectTodo = vi.fn(async (id: string) => p3Todo(id, false));
    const { rt, wsHandlers } = harness({ setTodoDone, confirmTodo, rejectTodo });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    wsHandlers[0]!.onEvent({ type: 'todos.update', projectId: 'p1', todos: [{ ...p3Todo('t1', false), candidate: { sessionId: 's1', note: 'n', at: 1 } }] });
    rt.emit({ type: 'todo.toggle', id: 't1' });
    await flush();
    // 候補の欄を押したのに done: false を送ると、何も起きずに候補だけが消える。確定と同じに扱う。
    expect(confirmTodo).toHaveBeenCalledWith('t1');
    expect(setTodoDone).not.toHaveBeenCalled();
    rt.emit({ type: 'todo.reject', id: 't1' });
    rt.emit({ type: 'todo.confirm', id: 't1' });
    await flush();
    expect(rejectTodo).toHaveBeenCalledWith('t1');
    expect(confirmTodo).toHaveBeenCalledTimes(2);
  });
```

`packages/ui/src/runtime/api.test.ts` の「フェーズ 3 の経路」の `await api.removeTodo('t1');` の後に `await api.confirmTodo('t1');` と `await api.rejectTodo('t1');` を足し、期待値の `'DELETE /api/todos/t1',` の後に `'POST /api/todos/t1/confirm', 'POST /api/todos/t1/reject',` を足す。後ろの `calls[6]` から `calls[9]` の添字は 2 つずつずらして `calls[8]` から `calls[11]` にする。

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/mediator/transition.test.ts packages/ui/src/runtime`
Expected: FAIL。

- [ ] **Step 3: 実装する**

`packages/shared/src/intent.ts:27` の行を置き換える。

```ts
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'todo.confirm'; id: TodoId } | { type: 'todo.reject'; id: TodoId }
```

`packages/ui/src/mediator/types.ts:44` の `api.removeTodo` の行の後に足す。

```ts
  | { kind: 'api.confirmTodo'; id: string }
  | { kind: 'api.rejectTodo'; id: string }
```

`packages/ui/src/mediator/workbench.ts:46` の `todo.remove` の行の後に足す。

```ts
    case 'todo.confirm': return { state, effects: [{ kind: 'api.confirmTodo', id: i.id }] };
    case 'todo.reject': return { state, effects: [{ kind: 'api.rejectTodo', id: i.id }] };
```

`packages/ui/src/runtime/api.ts:40` の `removeTodo` の型の後と、`:110` の実装の後に足す。

```ts
  confirmTodo(id: string): Promise<TodoDto>;
  rejectTodo(id: string): Promise<TodoDto>;
```

```ts
    confirmTodo: (id) => post(`/api/todos/${id}/confirm`),
    rejectTodo: (id) => post(`/api/todos/${id}/reject`),
```

`packages/ui/src/runtime/runtime.ts:206-212` の `api.toggleTodo` の節を置き換え、2 つの作用を足す。

```ts
      case 'api.toggleTodo': {
        // 反転の基準はストアの現在値にする。View は done の値を持たない。
        // 候補の欄を押したときは確定と同じに扱う。候補は未完なので、素直に反転すると done: false を送って何も起きない。
        const t = store.todos[e.id];
        if (!t) return;
        if (t.candidate) deps.api.confirmTodo(e.id).catch(fail);
        else deps.api.setTodoDone(e.id, !t.done).catch(fail);
        return;
      }
      case 'api.confirmTodo': deps.api.confirmTodo(e.id).catch(fail); return;
      case 'api.rejectTodo': deps.api.rejectTodo(e.id).catch(fail); return;
```

`packages/ui/src/test/fakeApi.ts` の `Extras` の `'removeTodo'` の後に `| 'confirmTodo' | 'rejectTodo'` を足し、`removeTodo: vi.fn(...)` の後に足す。

```ts
    confirmTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: true, position: 1, sessionId: null, updatedAt: 1, candidate: null })),
    rejectTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null })),
```

`fakeApiExtras` を使わずに `ApiClient` を丸ごと書いている偽物があれば（`grep -rn "removeTodo:" packages/ui/src --include=*.ts --include=*.tsx`）、同じ 2 行を足す。

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS、型検査 0 件。

- [ ] **Step 5: コミットする**

```bash
git commit packages/shared/src/intent.ts packages/ui/src/mediator/types.ts packages/ui/src/mediator/workbench.ts packages/ui/src/mediator/transition.test.ts packages/ui/src/runtime/api.ts packages/ui/src/runtime/api.test.ts packages/ui/src/runtime/runtime.ts packages/ui/src/runtime/runtime.test.ts packages/ui/src/test/fakeApi.ts -m "feat(ui): route TODO confirm and reject, and confirm when a candidate's box is ticked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Presenter（候補の文、Home の「確かめる」、件数）

**Files:**
- Modify: `packages/ui/src/presenters/project.ts`
- Modify: `packages/ui/src/presenters/home.ts`
- Test: `packages/ui/src/presenters/presenters.test.ts`

**Interfaces:**
- Consumes: `TodoDto.candidate`（Task 1）、`relativeTime(ts, now)`（`presenters/format.ts`、「12 分前」の形）
- Produces:
  - `type TodoCandidateProps = { note: string; sessionId: string | null; sessionName: string; ago: string }`（`sessionId` は手元にあって開けるときだけ非 null）
  - `TodoItemProps = { id: string; text: string; done: boolean; candidate: TodoCandidateProps | null }`
  - `presentTodoCandidate(t: TodoDto, store: Store, now: number): TodoCandidateProps | null`（`project.ts` から export）
  - `type ConfirmCard = { id: string; text: string; projectId: string; projectName: string; sessionName: string; ago: string; note: string }`
  - `HomeProps.confirm: ConfirmCard[]`（`attention` の次）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/presenters/presenters.test.ts` の `todoDto` を、候補を渡せる形に替える。

```ts
const todoDto = (id: string, position: number, done = false, candidate: TodoDto['candidate'] = null, projectId = 'p1'): TodoDto => ({ id, projectId, text: `やる ${id}`, done, position, sessionId: null, updatedAt: 1, candidate });
```

プロジェクトの試験（`expect(p.todos).toEqual(...)`）の期待値に `candidate: null` を足す。

```ts
    expect(p.todos).toEqual([{ id: 't1', text: 'やる t1', done: false, candidate: null }, { id: 't2', text: 'やる t2', done: true, candidate: null }]);
```

その試験の後に足す（`storeWith()`、`session()`、`project()`、`NOW` はこのファイルにある）。

```ts
  it('候補の TODO は根拠とセッションと経過を出し、分からないものは決まりの文にする', () => {
    const store = storeWith();
    store.projects = { p1: { ...project('p1'), name: 'alpha' } };
    store.sessions = { s1: session('s1', { name: '起動画面の作り直し', projectId: 'p1' }) };
    store.todos = {
      t1: todoDto('t1', 1, false, { sessionId: 's1', note: '直して確かめた', at: NOW - 12 * 60_000 }),
      t2: todoDto('t2', 2, false, { sessionId: 'gone', note: null, at: NOW - 60 * 60_000 }),
      t3: todoDto('t3', 3, false, { sessionId: null, note: 'n', at: NOW - 5 * 60_000 }),
      t4: todoDto('t4', 4),
    };
    const p = presentProject(initialState(), store, NOW, 'p1');
    expect(p.todos.map((t) => t.candidate)).toEqual([
      { note: '直して確かめた', sessionId: 's1', sessionName: '起動画面の作り直し', ago: '12 分前' },
      { note: '根拠は書かれていません', sessionId: null, sessionName: '不明なセッション', ago: '1 時間前' },
      { note: 'n', sessionId: null, sessionName: '不明なセッション', ago: '5 分前' },
      null,
    ]);
  });
```

`describe('presentHome', ...)` の中に足す。

```ts
  it('確かめるは全プロジェクトの候補を古い順に並べ、完了と矛盾した行は数えない', () => {
    const store = homeStore();
    store.projects = { ...store.projects, beta: { ...project('beta'), name: 'beta' } };
    store.todos = {
      a: todoDto('a', 1, false, { sessionId: 's1', note: '新しい', at: NOW - 60_000 }, 'alpha'),
      b: todoDto('b', 1, false, { sessionId: null, note: null, at: NOW - 30 * 60_000 }, 'beta'),
      // done かつ candidate は DTO では起きない（サーバが null にする）が、古いサーバや手で作った値でも数えない。
      c: todoDto('c', 2, true, { sessionId: 's1', note: 'x', at: NOW - 90 * 60_000 }, 'alpha'),
      d: todoDto('d', 3, false, null, 'alpha'),
    };
    const h = presentHome(initialState(), store, NOW);
    expect(h.confirm).toEqual([
      { id: 'b', text: 'やる b', projectId: 'beta', projectName: 'beta', sessionName: '不明なセッション', ago: '30 分前', note: '根拠は書かれていません' },
      { id: 'a', text: 'やる a', projectId: 'alpha', projectName: 'alpha', sessionName: 'name-s1', ago: '1 分前', note: '新しい' },
    ]);
    expect(h.projects.find((p) => p.id === 'alpha')!.counts).toContain('確かめる 1');
  });
  it('候補が無ければ確かめるは空で、件数にも出さない', () => {
    const h = presentHome(initialState(), homeStore(), NOW);
    expect(h.confirm).toEqual([]);
    expect(h.projects.every((p) => !p.counts.includes('確かめる'))).toBe(true);
  });
```

`homeStore()` のプロジェクトの ID が `alpha` でなければ、`grep -n "storeWith = \|function storeWith" -A6 packages/ui/src/presenters/presenters.test.ts` で確かめて合わせる（`session()` の既定の `projectId` は `'alpha'`）。

型を変えると画面の試験の値が合わなくなるので、同じ段で直しておく（この Task の終わりで型検査を 0 件にするため）。

- `packages/ui/src/views/screens.test.tsx` の `home()` を `({ attention: [], confirm: [], running: [], recent: [], projects: [], ...over })` にする。
- `packages/ui/src/views/workbench.test.tsx` の `TodoList` の試験 3 つと `ProjectScreen` の試験の `todos` の各要素に `candidate: null` を足す（例：`{ id: 't1', text: '買う', done: false, candidate: null }`）。
- ほかに `TodoItemProps` や `HomeProps` を直に書いている試験があれば、`npm run typecheck` の出力で探して同じように足す。

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts`
Expected: FAIL（`candidate` と `confirm` が無い）。

- [ ] **Step 3: 実装する**

`packages/ui/src/presenters/project.ts` の import と型を替え、関数を足す。

```ts
import type { ArtifactDto, ProjectStatus, TodoDto } from '@agent-hangar/shared';
```

```ts
/** 候補の TODO の表示。sessionId は、そのセッションが手元にあって開けるときだけ入る。 */
export type TodoCandidateProps = { note: string; sessionId: string | null; sessionName: string; ago: string };
export type TodoItemProps = { id: string; text: string; done: boolean; candidate: TodoCandidateProps | null };
```

```ts
const NO_NOTE = '根拠は書かれていません';
const UNKNOWN_SESSION = '不明なセッション';

/**
 * 候補の TODO を表示用の文にする。候補でなければ null。
 * 出したセッションが手元に無い（削除済み、同期前、セッション別でない URL から出た）ときは、開けないので名前の代わりに決まりの文を出す。
 * 完了の行は候補を持たないものとして扱う。サーバは null にして返すが、古いサーバの値でも Home に出さないためである。
 */
export function presentTodoCandidate(t: TodoDto, store: Store, now: number): TodoCandidateProps | null {
  const c = t.candidate;
  if (!c || t.done) return null;
  const s = c.sessionId ? store.sessions[c.sessionId] : undefined;
  return { note: c.note ?? NO_NOTE, sessionId: s ? s.id : null, sessionName: s ? s.name ?? '（名前なし）' : UNKNOWN_SESSION, ago: relativeTime(c.at, now) };
}
```

`presentProject` の `todos:` の行を置き換える。

```ts
    todos: todosOf(store, id).map((t) => ({ id: t.id, text: t.text, done: t.done, candidate: presentTodoCandidate(t, store, now) })),
```

`packages/ui/src/presenters/home.ts` に import と型を足す。

```ts
import { presentTodoCandidate } from './project.ts';
```

```ts
/** 確かめるの行。完了の候補 1 件につき 1 行で、押すとそのプロジェクトへ移る。 */
export type ConfirmCard = { id: string; text: string; projectId: string; projectName: string; sessionName: string; ago: string; note: string };
export type HomeProps = { attention: AttentionCard[]; confirm: ConfirmCard[]; running: RunningCard[]; recent: SessionRowProps[]; projects: ProjectMini[] };
```

`presentHome` の `attention` の後に足す。

```ts
  // 完了の候補。放っておくと溜まるので、長く待っているものほど先に出す。
  const candidates = Object.values(store.todos)
    .map((t) => ({ t, c: presentTodoCandidate(t, store, now) }))
    .filter((x): x is { t: typeof x.t; c: NonNullable<typeof x.c> } => x.c !== null)
    .sort((a, b) => (a.t.candidate!.at - b.t.candidate!.at) || a.t.id.localeCompare(b.t.id));
  const confirm = candidates.map(({ t, c }): ConfirmCard => ({ id: t.id, text: t.text, projectId: t.projectId, projectName: store.projects[t.projectId]?.name ?? '未分類', sessionName: c.sessionName, ago: c.ago, note: c.note }));
```

プロジェクトの件数の配列に「確かめる」を足す。

```ts
    const confirmHere = candidates.filter(({ t }) => t.projectId === p.id).length;
    const counts: [string, number][] = [['実行中', Math.max(0, p.runningCount - waitingHere)], ['TODO', p.openTodoCount], ['要対応', waitingHere], ['確かめる', confirmHere]];
```

戻り値を `return { attention, confirm, running, recent, projects };` にする。

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/presenters`
Expected: PASS。

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS、型検査 0 件（画面の試験の値は Step 1 で直してある）。

- [ ] **Step 5: コミットする**

```bash
git commit packages/ui/src/presenters/project.ts packages/ui/src/presenters/home.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/screens.test.tsx packages/ui/src/views/workbench.test.tsx -m "feat(ui): present TODO candidates for the rail and a confirm list for Home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: View（右レールの行、Home の区画、色のトークン）

**Files:**
- Modify: `packages/ui/src/views/TodoList.tsx`
- Modify: `packages/ui/src/views/HomeScreen.tsx:17-35`
- Modify: `packages/ui/src/styles/tokens.css`、`styles/workbench.css:23-28`、`styles/home.css:13` の後
- Test: `packages/ui/src/views/workbench.test.tsx`、`packages/ui/src/views/screens.test.tsx`、`packages/ui/src/styles/tokens.test.ts`

**Interfaces:**
- Consumes: `TodoItemProps`、`TodoCandidateProps`、`ConfirmCard`、`HomeProps.confirm`（Task 6）、Intent `todo.confirm`、`todo.reject`（Task 5）、既存の `session.open`、`project.open`
- Produces: なし（最後の段）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/styles/tokens.test.ts` の 1 つ目の試験の一覧に `'--cand', '--cand-soft'` を足し、`describe('tokens.css', ...)` の中に足す。

```ts
  it('候補の色の文字は、淡い紫の地と白地の両方で 4.5:1 以上で読める', () => {
    expect(contrast(token('--cand'), token('--cand-soft'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('--cand'), token('--surface'))).toBeGreaterThanOrEqual(4.5);
  });
```

`packages/ui/src/views/workbench.test.tsx` の `describe('TodoList', ...)` の中に足す（既存の試験の `candidate: null` は Task 6 で足してある）。

```ts
  it('候補の行は根拠とセッションと確定と却下を出し、欄を押すと反転の Intent を出す', () => {
    const cand = { note: '直して確かめた', sessionId: 's1', sessionName: '起動画面の作り直し', ago: '12 分前' };
    const onIntent = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '窓を掴める', done: false, candidate: cand }, { id: 't2', text: '影の値', done: false, candidate: { ...cand, sessionId: null, sessionName: '不明なセッション' } }]} />);
    expect(screen.getByText('直して確かめた', { selector: '#todo-why-t1' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目、完了の候補）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't1' });
    fireEvent.click(screen.getByRole('button', { name: '起動画面の作り直し' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目）を確定'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.confirm', id: 't1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目）を却下'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.reject', id: 't1' });
    // 開けないセッションは押せる形にしない。
    expect(screen.queryByRole('button', { name: '不明なセッション' })).toBeNull();
    expect(screen.getByText('不明なセッション')).toBeTruthy();
    // 候補でない行には確定も根拠も出さない。
    const plain = wrap(<TodoList projectId="p1" todos={[{ id: 't3', text: '普通', done: false, candidate: null }]} />);
    expect(plain).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('普通（1 件目）を確定')).toBeNull();
  });
```

`packages/ui/src/views/screens.test.tsx` の `describe('HomeScreen', ...)` の中に足す（`home()` の `confirm: []` は Task 6 で足してある）。

```ts
  it('確かめるの区画は候補を出し、確定と却下と本文の押下で Intent を出し、0 件なら省く', () => {
    const onIntent = vi.fn();
    const c = { id: 't1', text: '窓を掴める', projectId: 'p1', projectName: 'agent-hangar', sessionName: '起動画面の作り直し', ago: '12 分前', note: '直して確かめた' };
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ confirm: [c] })} /></IntentRoot>);
    const section = screen.getByRole('heading', { name: /確かめる/ }).closest('section')!;
    expect(within(section).getByText('直して確かめた')).toBeTruthy();
    expect(within(section).getByText(/agent-hangar · 起動画面の作り直し · 12 分前/)).toBeTruthy();
    fireEvent.click(within(section).getByLabelText('窓を掴めるを確定'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.confirm', id: 't1' });
    fireEvent.click(within(section).getByLabelText('窓を掴めるを却下'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.reject', id: 't1' });
    fireEvent.click(within(section).getByRole('button', { name: '窓を掴める' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'p1' });
    cleanup();
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home()} /></IntentRoot>);
    expect(screen.queryByRole('heading', { name: /確かめる/ })).toBeNull();
  });
  it('確かめるは要対応の後、実行中の前に置く', () => {
    const c = { id: 't1', text: '窓', projectId: 'p1', projectName: 'a', sessionName: 's', ago: '1 分前', note: 'n' };
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ attention: [{ id: 'w1', name: 'w', projectName: 'a', waited: '1 分', question: 'q', canAnswer: true }], confirm: [c], running: [runningCard()] })} /></IntentRoot>);
    const labels = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(labels.slice(0, 3)).toEqual(['要対応1', '確かめる1', '実行中1']);
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/workbench.test.tsx packages/ui/src/views/screens.test.tsx packages/ui/src/styles/tokens.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装する**

`packages/ui/src/styles/tokens.css` の `--st-archived-soft` の行の後に足す。

```css
  /* 完了の候補。セッションが「片付いた」と言ったが、まだ利用者が確かめていない TODO。
     淡い地の上の文字は --cand で、地と白地の両方で 4.5 : 1 を超える（tokens.test.ts が見張る）。 */
  --cand: #6a4fd0;
  --cand-soft: #f1edff;
```

`packages/ui/src/views/TodoList.tsx` を置き換える。

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TodoItemProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';

/**
 * プロジェクトの TODO。並び替えは持たず、完了した項目も同じ並びに打消し線で残す。
 * 完了の候補は、欄を半分塗りにし、根拠と出したセッションと確定と却下を行の下に常に出す（開かずに判断できるように）。
 * 候補の欄を押したときの扱い（確定にする）は Runtime が決める。View は反転の Intent を出すだけにする。
 */
export function TodoList(props: { projectId: string; todos: TodoItemProps[] }) {
  const emit = useEmit();
  const [text, setText] = useState('');
  const add = () => { if (!text.trim()) return; emit({ type: 'todo.add', projectId: props.projectId, text }); setText(''); };
  return (
    <div className="todos">
      {props.todos.length === 0 && <div className="faint">TODO はまだありません</div>}
      <ul className="todo-list">
        {/* 同じ文言の項目が並ぶことがあるので、読み上げの名前に何件目かを混ぜて一意にする。 */}
        {props.todos.map((t, i) => {
          const nth = `${t.text}（${i + 1} 件目）`;
          const c = t.candidate;
          return (
            <li key={t.id} className="todo-item" data-candidate={c ? 'true' : undefined}>
              <div className="todo" data-done={t.done ? 'true' : undefined}>
                <input type="checkbox" className="todo-check" data-candidate={c ? 'true' : undefined} checked={t.done}
                  aria-label={c ? `${t.text}（${i + 1} 件目、完了の候補）` : nth} aria-describedby={c ? `todo-why-${t.id}` : undefined}
                  onChange={() => emit({ type: 'todo.toggle', id: t.id })} />
                <span className="todo-text">{t.text}</span>
                <button className="btn todo-del" aria-label={`${nth}を削除`} onClick={() => emit({ type: 'todo.remove', id: t.id })}><Icon name="close" /></button>
              </div>
              {c && (
                <div className="todo-cand">
                  <div className="todo-why" id={`todo-why-${t.id}`}>{c.note}</div>
                  <div className="todo-src">
                    {c.sessionId
                      ? <button type="button" className="todo-src-link" onClick={() => emit({ type: 'session.open', id: c.sessionId! })}>{c.sessionName}</button>
                      : <span>{c.sessionName}</span>}
                    <span className="faint"> · {c.ago}</span>
                  </div>
                  <div className="todo-acts">
                    <button type="button" className="btn btn-primary" aria-label={`${nth}を確定`} onClick={() => emit({ type: 'todo.confirm', id: t.id })}>確定</button>
                    <button type="button" className="btn" aria-label={`${nth}を却下`} onClick={() => emit({ type: 'todo.reject', id: t.id })}>却下</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="rail-add">
        {/* 変換中の Enter で足すと、確定と同時に書きかけが消える。 */}
        <input id="todo-input" className="input" aria-label="TODO を追加" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) add(); }} />
        <button className="btn" onClick={add}><Icon name="add" />追加</button>
      </div>
    </div>
  );
}
```

`packages/ui/src/styles/workbench.css` の TODO の節（`.todo:hover .todo-del, ...` の行）の後に足す。

```css
/* 完了の候補。行の地を淡い紫にし、欄は半分塗り。根拠と出したセッションと 2 つのボタンを行の下に置く。 */
.todo-item[data-candidate='true'] { margin: 2px calc(var(--u) * -1); padding: var(--u) var(--u) calc(var(--u) * 2); border-radius: var(--r); background: var(--cand-soft); }
.todo-check[data-candidate='true'] { appearance: none; flex: none; width: 13px; height: 13px; margin: 0; border-radius: 3px; border: 1.5px solid var(--cand); background: linear-gradient(135deg, var(--cand) 50%, var(--surface) 50%); cursor: pointer; }
.todo-check[data-candidate='true']:focus-visible { outline: 2px solid var(--cand); outline-offset: 2px; }
.todo-cand { margin-left: calc(13px + var(--u) * 1.5); display: flex; flex-direction: column; gap: var(--u); }
.todo-why { font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.5; }
.todo-src { font-size: var(--fs-xs); color: var(--ink-2); }
.todo-src-link { padding: 0; border: 0; background: none; font: inherit; color: var(--cand); cursor: pointer; }
.todo-src-link:hover { text-decoration: underline; }
.todo-acts { display: flex; gap: var(--u); }
```

`packages/ui/src/views/HomeScreen.tsx` の import に `ConfirmCard` は要らない（`props.confirm` から型が付く）。要対応の `</section>` と `)}` の後、実行中の節の前に足す。

```tsx
      {props.confirm.length > 0 && (
        <section>
          <h2 className="home-label">確かめる<span className="home-count">{props.confirm.length}</span></h2>
          {props.confirm.map((c) => (
            <div key={c.id} className="ask-card confirm-card">
              <span className="cand-mark" aria-hidden="true" />
              <div className="ask-body">
                <div className="ask-title">
                  <button type="button" className="confirm-open" onClick={() => emit({ type: 'project.open', id: c.projectId })}><b>{c.text}</b></button>
                  {' '}<span className="faint">· {c.projectName} · {c.sessionName} · {c.ago}</span>
                </div>
                <div className="ask-q">{c.note}</div>
              </div>
              <button type="button" className="btn btn-primary" aria-label={`${c.text}を確定`} onClick={() => emit({ type: 'todo.confirm', id: c.id })}>確定</button>
              <button type="button" className="btn" aria-label={`${c.text}を却下`} onClick={() => emit({ type: 'todo.reject', id: c.id })}>却下</button>
            </div>
          ))}
        </section>
      )}
```

関数の上の注記の 2 行を「上から要対応、確かめる、実行中、最近とプロジェクトの順に置く。」「要対応と確かめると実行中は、該当が無ければ区画ごと省く。」に替える。

`packages/ui/src/styles/home.css` の `.ask-card .btn { flex: none; }` の後に足す。

```css
/* 確かめるの行。要対応の札と同じ形で、縁の色だけを候補の色にする。 */
.confirm-card { box-shadow: 0 0 0 1px color-mix(in srgb, var(--cand) 22%, transparent), 0 6px 16px -10px color-mix(in srgb, var(--cand) 40%, transparent); }
.cand-mark { flex: none; width: 13px; height: 13px; border-radius: 3px; border: 1.5px solid var(--cand); background: linear-gradient(135deg, var(--cand) 50%, var(--surface) 50%); }
.confirm-open { padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-align: left; }
.confirm-open:hover b { text-decoration: underline; }
```

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui`
Expected: PASS（`styles/*.test.ts` の見張り、`glass.test.ts`、`motion.test.ts` を含む）。

Run: `npm run typecheck`
Expected: 0 件。

- [ ] **Step 5: コミットする**

```bash
git commit packages/ui/src/views/TodoList.tsx packages/ui/src/views/HomeScreen.tsx packages/ui/src/views/workbench.test.tsx packages/ui/src/views/screens.test.tsx packages/ui/src/styles/tokens.css packages/ui/src/styles/tokens.test.ts packages/ui/src/styles/workbench.css packages/ui/src/styles/home.css -m "feat(ui): show TODO candidates in the rail and a confirm list on Home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 設計書への反映、全体の検査、ビルド

**Files:**
- Modify: `docs/design.md`（「指示の注入」、「ツール」、「Home」、「プロジェクト詳細」、「決めた前提と未決事項」）

**Interfaces:**
- Consumes: Task 1 から 7 のすべて
- Produces: なし

- [ ] **Step 1: `docs/design.md` を直す**

次の 5 か所を、仕様 `docs/superpowers/specs/2026-09-30-todo-candidates-design.md` の該当の節に合わせて書き換える。一文ごとに改行する。

1. 「指示の注入」のテンプレートの `未完の TODO：<最大 10 件>` を `未完の TODO：<最大 10 件、各行 - [<id>] <本文>>` にし、末尾に仕様の 2 行を足す。
2. 「ツール」の `update_project(project_id, { status?, add_todos?, toggle_todos?, append_memo? })` を `update_project(project_id, { status?, add_todos?, toggle_todos?, propose_done?, append_memo? })` にし、その下に「MCP からは TODO を完了にできない。`propose_done` と未完への `toggle_todos` は完了の候補を出し、結果を `todo_results` で返す。」と `outcome` の 5 つを書く。
3. 「Home」の区画の並びを「要対応、確かめる、実行中の札、最近とプロジェクト」にし、確かめるの行の中身（仕様の「Home の『確かめる』区画」）を 1 段落で足す。プロジェクトの小さな一覧の件数に「確かめる」を足す。
4. 「プロジェクト詳細」の右レールの TODO に、候補の行の見せ方（仕様の「右レールの TODO」）を 1 段落で足す。
5. 「決めた前提と未決事項」の TODO の項に、候補の 4 列、却下したセッションからは出し直せないこと、`setTodoDone` が候補を消すこと、D1 のマイグレーションが要らない理由を足す。

- [ ] **Step 2: 全体の検査を走らせる**

Run: `npm test && npm run typecheck`
Expected: すべて PASS、型検査 0 件。落ちたものがあれば、直してから先へ進む（期待値を緩めて通さない）。

- [ ] **Step 3: ビルドする**

Run: `npm run build`
Expected: 終了コード 0（UI の vite を含む）。

デスクトップの同梱サーバとアプリをビルドする。コマンドは `apps/desktop/package.json` の `scripts` を読んで、同梱サーバの束ね（`bundle-server`）と `tauri build` に当たるものを使う。

Run: `npm run --workspace apps/desktop bundle-server && npm run --workspace apps/desktop tauri -- build`（スクリプト名が違えば `package.json` のものに合わせる）
Expected: `apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` ができる。`/Applications/Hangar.app` は置き換えない。

- [ ] **Step 4: 利用者の dev サーバを一度落とす**

新しいサーバの版を次の起動で使わせるためである。ポート番号では止めない。

```bash
PID=$(lsof -nP -iTCP:4177 -sTCP:LISTEN -t)
ps -o command= -p "$PID"
```

出力が `packages/server` の tsx のサーバであることを確かめてから `kill "$PID"` する。違うプロセスなら止めずに報告する。LISTEN が無ければ何もしない。

- [ ] **Step 5: 実物での確かめを利用者に渡す**

次の手順を利用者に伝える（`.app` の入れ替えと main への取り込みは、`ui-refresh-3-motion` が済んでから利用者が決める）。

1. worktree で `npm run dev` を起動し、hangar から任意のプロジェクトでセッションを起動する。
2. そのセッションに「TODO の <本文> は片付いたので、propose_done で候補を出して」と頼む。
3. 右レールに半分塗りの候補の行が根拠つきで出ること、Home に「確かめる」区画が出ることを見る。
4. 却下したあと、同じセッションにもう一度頼むと `rejected_before` が返り、候補が出ないことを見る。
5. 別の候補を「確定」し、打消し線の完了になることを見る。

- [ ] **Step 6: コミットする**

```bash
git commit docs/design.md -m "docs: fold TODO completion candidates into the main design

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
