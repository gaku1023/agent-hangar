# UI 刷新 2 回目 実装計画（Home、2 段の行、実行中のセッションの「いま」）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home を管制盤（要対応、実行中の札、最近とプロジェクト）に作り直し、どのセッション一覧も 44px の 2 段の行にし、そのためにサーバが実行中のセッションの最後のツール呼び出しと、答えを待っている問いを届ける。

**Architecture:** サーバは索引の追記を読む経路（`indexFile`）で、主線の出来事を畳んで「最後のツール呼び出し」と「答えを待っている AskUserQuestion の問い」を端末ローカルの表 `session_activity` に残す。`toSessionDto` は実行中のセッションにだけ、その値を `SessionDto.activity` として載せる。UI は Home の Presenter でそれを札に変え、`SessionRows` は画面の役目（`recent`、`project`、`search`）で右端と 2 段目を変える。

**Tech Stack:** React 19、Vite 8、vitest 5（`ui` の `node` と `dom` の子プロジェクト）、@testing-library/react 16、better-sqlite3（サーバの DB）、Hono、Tauri 2.11、Node 22。

**Spec:** `docs/superpowers/specs/2026-09-29-ui-refresh-design.md`（「3 画面」の Home、データの流れ、一覧の行。試作は `docs/superpowers/specs/2026-09-29-ui-refresh/2-5-assets-screens-motion-tests.html` の 3-b と 3-c）

## Global Constraints

- この回で扱うのは、仕様の「届け方」の 2 回目（Home、2 段の行 44px、実行中のセッションの最後のツール呼び出しと問い）と、1 回目で後に回した 2 件（狭い窓での切断の帯の省略、右レールのアーティファクトが光の上にあること）だけである。端末の縁の灯、フォルダの耳のタブ、動きのトークンと動きの一覧、行が広がる動き、起動画面は 3 回目で扱う。
- 動きのトークン（`--dur-fast: 80ms`、`--dur: 150ms`、`--dur-slow: 250ms`、`--dur-pop: 120ms`、`--ease`）はこの回では値も名前も変えない。
- `--row-h: 28px` は 1 段の部品（ボタン、入力欄、ナビ、タブ、切断の帯、TODO）の高さなので変えない。2 段の行の高さは新しいトークン `--session-row-h: 44px` で持つ。
- 常にライトで、ダークモードは持たない。`prefers-color-scheme` と `data-theme` を書かない。
- ぼかし（`backdrop-filter`）は `.sidebar`、`.header`、`.conn-banner`、`.dialog`、`.palette`、`.toast` の規則にだけ書く（`styles/glass.test.ts` が見張る）。Home の札と一覧の行は白い不透明な読む面で、ぼかしを掛けない。
- 本文の色は白地で 4.5 : 1 以上、注記の色（`--ink-3`）は 3 : 1 以上。プロジェクトのステータスの色（`--st-*`）と状態の色（`--busy`、`--idle`、`--waiting`、`--ended`）は変えない。
- アイコンは Lucide の 16px、線幅 1.5 のまま。`views/primitives/Icon.tsx` だけを通す。
- 実行中のセッションの「いま」は、仕様では `live.activity` と `live.question` と書いた。今の `SessionDto.live` は `'busy' | 'idle' | 'waiting' | null` の文字列で欄を足せないので、同じ中身を任意の欄 `SessionDto.activity?: { tool, summary, question } | null` に載せる（Task 1、Task 7 で仕様と design.md の文も直す）。
- `activity` は端末ローカルの表 `session_activity` にだけ置き、共有テーブル（`packages/shared/src/cloud.ts` の `SHARED_TABLES`）にも、`upsertShared` に渡す行にも入れない。クラウド同期の形式を変えない。
- 取り出しは索引の追記を読む経路に載せ、Home を開いたときにトランスクリプトを読み直さない。
- 要対応の札は端末を開いてフォーカスするだけにし、その場で答えさせない。
- キー操作（`j`、`k`、`Enter`、`o`、`e`、`m`）は今のまま使う。
- `palette.css` の `.field-row {`、`.dialog-promote .btn { white-space: nowrap; }`、`.dialog-promote .dialog-foot { flex-wrap: wrap;` と、`base.css` の `animation: pop var(--dur-pop) var(--ease)` の文字列は試験が見ているので、そのまま残す。
- サーバの CSP（`packages/server/src/http/app.ts` の `CSP`）と `apps/desktop/src-tauri/capabilities/*.json` はこの計画では変えない。
- ポート番号でプロセスを止めない。止めてよいのは、ビルドの後に、`apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` から起きたプロセス（パスを `ps -o command= -p <PID>` で確かめたもの）と、LISTEN している利用者の dev サーバ 1 つだけ（`lsof -nP -iTCP:4177 -sTCP:LISTEN -t` で PID を採り、`ps -o command= -p <PID>` で `packages/server` の tsx のサーバだと確かめてから）。`osascript` やアプリ名での終了は使わない。`/Applications` の下には触らない。Vite（5173）には触らない。
- 手元での `tauri build` は、この計画では Task 8 の 1 回だけとする。`cargo check` は回数を制限しない。
- ビルドは `/Applications/Hangar.app` を置き換えない。入れ替えは利用者に確かめてから行う。
- テストは実物の `~/.agent-hangar` と `~/.claude` に触れない。実物の外部サービス（Cloudflare、本番の Worker と D1 と R2、GitHub）に触れない。`git push` をしない。
- 日本語の文書は一文ごとに改行し、地の文でダッシュと中黒を使わない。コードのコメントは周りの書き方に合わせる。
- コミットメッセージは英語の Conventional Commits で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` をそのまま付ける（どのモデルが書いても同じ文字列）。`git add` の後の素の `git commit` ではなく、`git commit <path>...` のパス指定形で入れる（新しいファイルだけは直前に `git add <そのパス>`）。`--amend` と rebase は使わない。パッケージ管理は npm。

## Review Focus

- **AskUserQuestion に答えた後も、Home に古い問いが残る。** 答えが済めば、札は問いを出さずに「入力を待っています」か、実行中の札に戻るべきである。Task 1 の `foldActivity` の試験と、`indexFile` の試験で、その呼び出しへの `tool_result` が来たら問いが消えることを固定する。
- **改行や長い文を含む問いで、要対応の札が崩れる。** 問いは 1 行に畳まれ、長すぎれば切られるべきである。Task 1 の `firstQuestion` の試験で、空白を 1 つにまとめることと 300 字で切ることを固定し、Task 5 の CSS で 1 行の省略にする。
- **セッションが終わっても、実行中の札に残り、最近に出てこない。** 終われば札から消え、最近の先頭に入るべきである。Task 4 の試験で固定する。
- **検索語に正規表現の記号（`a.b(` など）や引用符が入ると、抜粋の印付けが落ちる、あるいは別の語を印す。** 記号はただの文字として扱われるべきである。Task 3 の `markTerms` の試験で固定する。
- **いま見ているセッションの札で「ターミナルで答える」を押すと、何も起きない。** 画面は移らず、端末にフォーカスだけが移るべきである。Task 2 の試験で固定する。

---

## 作るファイルと変えるファイル

| ファイル | 役目 | Task |
|---|---|---|
| `packages/shared/src/api.ts` | `SessionActivityDto` と、`SessionDto.activity` の任意の欄 | 1 |
| `packages/server/src/provider/claude-code/activity.ts`（新） | 出来事を畳んで最後の呼び出しと問いを残す純粋な関数 | 1 |
| `packages/server/src/provider/claude-code/activity.test.ts`（新） | その試験 | 1 |
| `packages/server/src/db/migrations.ts` | version 9 で端末ローカルの表 `session_activity` | 1 |
| `packages/server/src/indexer/indexFile.ts` | 主線の追記を畳んで `session_activity` に書く | 1 |
| `packages/server/src/db/queries.ts` | 実行中のセッションにだけ `activity` を載せる | 1 |
| `packages/server/src/db/db.test.ts`、`indexer/indexFile.test.ts`、`db/queries.test.ts` | 表、書き込み、載せ方の試験 | 1 |
| `packages/shared/src/intent.ts` | `session.open` に任意の `focus: 'terminal'` | 2 |
| `packages/ui/src/mediator/types.ts`、`transition.ts`、`screen.ts` | 開いたら端末にフォーカスする | 2 |
| `packages/ui/src/mediator/transition.test.ts` | その試験 | 2 |
| `packages/ui/src/presenters/highlight.ts`（新）と試験 | 検索語の印付け | 3 |
| `packages/ui/src/presenters/row.ts`、`sessions.ts` | 行の props に抜粋（`excerpt`）を持たせる | 3 |
| `packages/ui/src/views/SessionRows.tsx` | 2 段の行と、画面の役目ごとの右端と 2 段目 | 3 |
| `packages/ui/src/styles/rows.css`、`tokens.css`、`rows.test.ts`（新） | 2 段の行の見た目と高さ | 3 |
| `packages/ui/src/views/ProjectScreen.tsx`、`SessionsScreen.tsx`、`HomeScreen.tsx` | `SessionRows` の呼び方 | 3 |
| `packages/ui/src/views/SessionRows.test.tsx`、`misc.test.tsx`、`presenters/presenters.test.ts` | 行の試験の書き換え | 3 |
| `packages/ui/src/presenters/home.ts` | 要対応、実行中の札、最近、プロジェクトの小さな一覧 | 4 |
| `packages/ui/src/presenters/presenters.test.ts` | その試験 | 4 |
| `packages/ui/src/views/HomeScreen.tsx`、`styles/home.css`（新）、`main.tsx` | Home の画面 | 5 |
| `packages/ui/src/views/screens.test.tsx` | その試験 | 5 |
| `packages/ui/src/styles/base.css`、`workbench.css`、`views/ProjectScreen.tsx`、`styles/glass.test.ts`、`views/screens.test.tsx` | 切断の帯の縮め方と、アーティファクトの白い面 | 6 |
| `docs/design.md`、`docs/superpowers/specs/2026-09-29-ui-refresh-design.md` | Home、行、データの流れの書き換え | 7 |

---

### Task 1: 実行中のセッションの「いま」をサーバが届ける

**Files:**
- Modify: `packages/shared/src/api.ts`（`SessionDto` の行）
- Create: `packages/server/src/provider/claude-code/activity.ts`
- Create: `packages/server/src/provider/claude-code/activity.test.ts`
- Modify: `packages/server/src/db/migrations.ts`（配列の末尾に version 9）
- Modify: `packages/server/src/indexer/indexFile.ts`（`indexFile` の中）
- Modify: `packages/server/src/db/queries.ts`（`SessionRow`、`SESSION_SELECT`、`toSessionDto`）
- Test: `packages/server/src/db/db.test.ts`、`packages/server/src/indexer/indexFile.test.ts`、`packages/server/src/db/queries.test.ts`

**Interfaces:**
- Produces: `export type SessionActivityDto = { tool: string; summary: string; question: string | null }` と `SessionDto.activity?: SessionActivityDto | null`（`@agent-hangar/shared`）。実行中（`live !== null`）のセッションにだけ欄があり、呼び出しがまだ無ければ `null`。実行中でなければ欄そのものが無い。Task 4 がこれを読む。
- Produces: `foldActivity(prev: Activity | null, events: TranscriptEvent[]): Activity | null` と `firstQuestion(input: unknown): string | null`（`provider/claude-code/activity.ts`）。

- [ ] **Step 1: 純粋な関数の、失敗する試験を書く**

`packages/server/src/provider/claude-code/activity.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { firstQuestion, foldActivity } from './activity.ts';

const call = (toolId: string, name: string, input: unknown, summary = name): TranscriptEvent => ({ kind: 'tool_call', seq: 0, toolId, name, input, summary });
const result = (toolId: string): TranscriptEvent => ({ kind: 'tool_result', seq: 0, toolId, text: 'ok', isError: false });
/** AskUserQuestion の入力の形。問いは questions の配列に入る。 */
const ask = (question: unknown) => ({ questions: [{ question, header: 'h', options: [{ label: 'a', description: 'x' }, { label: 'b', description: 'y' }], multiSelect: false }] });

describe('firstQuestion', () => {
  it('最初の問いの文を取り出し、改行と続く空白を 1 つの空白にまとめる', () => {
    expect(firstQuestion(ask('図 3 の凡例は\n右上に  置きますか？'))).toBe('図 3 の凡例は 右上に 置きますか？');
  });
  it('入力の形が崩れていれば null', () => {
    for (const bad of [null, 'x', 3, {}, { questions: [] }, { questions: 'x' }, { questions: [null] }, { questions: [{ question: 3 }] }, ask('   ')]) {
      expect(firstQuestion(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('長すぎる問いは 300 字で切る', () => {
    expect(firstQuestion(ask('あ'.repeat(400)))!.length).toBe(300);
  });
});

describe('foldActivity', () => {
  it('最後のツール呼び出しを残す', () => {
    expect(foldActivity(null, [call('t1', 'Read', {}, 'a.ts'), call('t2', 'Edit', {}, 'b.ts')])).toEqual({ tool: 'Edit', summary: 'b.ts', toolId: 't2', question: null });
  });
  it('呼び出しが無ければ前の値をそのまま返す', () => {
    const prev = { tool: 'Bash', summary: 'ls', toolId: 't0', question: null };
    expect(foldActivity(prev, [{ kind: 'assistant', seq: 0, text: 'hi' }])).toBe(prev);
    expect(foldActivity(null, [])).toBeNull();
  });
  it('AskUserQuestion の問いを持ち、その呼び出しへの答えが来たら問いを消す', () => {
    const asked = foldActivity(null, [call('q1', 'AskUserQuestion', ask('どちらにしますか？'))]);
    expect(asked?.question).toBe('どちらにしますか？');
    expect(foldActivity(asked, [result('other')])?.question).toBe('どちらにしますか？');
    expect(foldActivity(asked, [result('q1')])).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', toolId: 'q1', question: null });
  });
  it('AskUserQuestion でない呼び出しと、入力の崩れた AskUserQuestion は問いを持たない', () => {
    expect(foldActivity(null, [call('t1', 'Bash', ask('x'))])?.question).toBeNull();
    expect(foldActivity(null, [call('q1', 'AskUserQuestion', { nope: 1 })])?.question).toBeNull();
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/activity.test.ts`
Expected: FAIL（`./activity.ts` が無い）。

- [ ] **Step 3: 純粋な関数を書く**

`packages/server/src/provider/claude-code/activity.ts` を作る。

```ts
import type { TranscriptEvent } from '@agent-hangar/shared';

/**
 * 実行中のセッションが最後に何をしたか。Home の札に出す。
 * toolId は、AskUserQuestion の答え（tool_result）がどの呼び出しへのものかを見分けるために持つ。
 */
export type Activity = { tool: string; summary: string; toolId: string; question: string | null };

/** 札の 1 行に収まらない問いは、ここで切っておく。 */
const QUESTION_MAX = 300;

/**
 * AskUserQuestion の入力から、最初の問いの文を取り出す。
 * 入力は { questions: [{ question, header, options, multiSelect }] } の形である。
 * 形が崩れていれば null を返し、札は決まりの文を出す。
 */
export function firstQuestion(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first = questions[0] as { question?: unknown } | null;
  const text = typeof first?.question === 'string' ? first.question.replace(/\s+/g, ' ').trim() : '';
  return text === '' ? null : text.slice(0, QUESTION_MAX);
}

/**
 * 正規化した出来事を順に畳み、最後のツール呼び出しを残す。
 * AskUserQuestion の問いは、その呼び出しへの tool_result が来たら答えが済んだとして消す。
 * 呼び出しが 1 つも無ければ、前の値をそのまま返す。
 */
export function foldActivity(prev: Activity | null, events: TranscriptEvent[]): Activity | null {
  let cur = prev;
  for (const ev of events) {
    if (ev.kind === 'tool_call') {
      cur = { tool: ev.name, summary: ev.summary, toolId: ev.toolId, question: ev.name === 'AskUserQuestion' ? firstQuestion(ev.input) : null };
    } else if (ev.kind === 'tool_result' && cur !== null && cur.question !== null && ev.toolId === cur.toolId) {
      cur = { ...cur, question: null };
    }
  }
  return cur;
}
```

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/activity.test.ts`
Expected: PASS。

- [ ] **Step 5: 表、書き込み、載せ方の、失敗する試験を書く**

`packages/server/src/db/db.test.ts` の `'共有テーブル、ローカルテーブル、FTS を作る'` の表の名前の配列の最後（`'schema_migrations'` の後）に `'session_activity'` を足す。

`packages/server/src/indexer/indexFile.test.ts` の末尾に、次の `describe` を足す。

```ts
describe('最後のツール呼び出し（session_activity）', () => {
  const askCall = (toolId: string, question: string, ts = '2026-09-01T12:10:00.000Z') =>
    ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input: { questions: [{ question, header: 'h', options: [], multiSelect: false }] } }], usage: { input_tokens: 0, output_tokens: 1 } }, uuid: `a-${toolId}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const activity = (sessionId: string) => db.prepare('select tool, summary, tool_id, question from session_activity where session_id = ?').get(sessionId);

  it('主線の追記から最後の呼び出しと待っている問いを残し、答えが来たら問いを消す', () => {
    const first = indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, askCall('q1', 'どちらにしますか？'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(activity(first.sessionId)).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', tool_id: 'q1', question: 'どちらにしますか？' });
    // 答えは次の追記で届く。前の追記で残した呼び出しと突き合わせて消す。
    appendJson(alphaMain().path, artifactResult('q1', '右上に置く'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(activity(first.sessionId)).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', tool_id: 'q1', question: null });
  });

  it('サブエージェントの呼び出しは、主線の「いま」にしない', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    indexFile(db, alphaSub(), { deviceId: DEV });
    const before = activity(r.sessionId);
    appendJson(alphaSub().path, artifactCall('sub-1', { file_path: missing() }));
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(activity(r.sessionId)).toEqual(before);
  });
});
```

`packages/server/src/db/queries.test.ts` の末尾に、次の `describe` を足す（`live` は同じファイルの先頭で `SESSION_ALPHA` を `waiting` にしている）。

```ts
describe('実行中のセッションの activity', () => {
  const put = () => db.prepare('insert or replace into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)');
  it('実行中なら最後の呼び出しと問いを載せ、実行中でなければ欄ごと載せない', () => {
    const all = listSessions(db, live);
    const alpha = all.find((s) => s.providerSessionId === SESSION_ALPHA)!;
    const beta = all.find((s) => s.providerSessionId === SESSION_BETA)!;
    put().run(alpha.id, 'AskUserQuestion', 'AskUserQuestion', 'q1', 'どちらにしますか？', 1);
    put().run(beta.id, 'Edit', 'b.ts', 't1', null, 1);
    const again = listSessions(db, live);
    expect(again.find((s) => s.id === alpha.id)!.activity).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', question: 'どちらにしますか？' });
    expect('activity' in again.find((s) => s.id === beta.id)!).toBe(false);
  });
  it('実行中でも、呼び出しがまだ無ければ null', () => {
    db.prepare('delete from session_activity').run();
    expect(listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!.activity).toBeNull();
  });
});
```

- [ ] **Step 6: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/db/db.test.ts packages/server/src/indexer/indexFile.test.ts packages/server/src/db/queries.test.ts`
Expected: FAIL（`session_activity` の表が無い）。

- [ ] **Step 7: 共有の型に欄を足す**

`packages/shared/src/api.ts` の `export type SessionDto = …` の行の直前に、次の 2 行を足す。

```ts
/** 実行中のセッションが最後に呼んだツールと、答えを待っている AskUserQuestion の問い。端末ローカルで、同期しない。 */
export type SessionActivityDto = { tool: string; summary: string; question: string | null };
```

同じ行の `SessionDto` の型の末尾の `remoteOnly: boolean` を `remoteOnly: boolean; activity?: SessionActivityDto | null` に変える。
欄は任意にする。
古いクライアントと、実行中でないセッションには欄が無い。

- [ ] **Step 8: 表を足す**

`packages/server/src/db/migrations.ts` の `MIGRATIONS` の配列の最後の要素（version 8）の後に、次を足す。

```ts
  {
    // 実行中のセッションが最後に呼んだツールと、答えを待っている AskUserQuestion の問い。Home の札に出す。
    // 端末ローカルの表にする（共有テーブルの列を持たないので、同期の changes にも載らない）。
    // 主線のトランスクリプトの追記を読むたびに書き直し、索引の作り直しでは先頭から積み直す。
    // 既存の索引は作り直さないので、上げた直後は次の追記が来るまで空である。
    version: 9,
    sql: `
create table session_activity (
  session_id text primary key,
  tool text not null,
  summary text not null,
  tool_id text not null,
  question text,
  updated_at integer not null
);
`,
  },
```

- [ ] **Step 9: 索引の追記から書く**

`packages/server/src/indexer/indexFile.ts` の import の並びに、次の 1 行を足す。

```ts
import { foldActivity, type Activity } from '../provider/claude-code/activity.ts';
```

`indexFile` の中の `const agentKey = file.agentId ?? '';` の直後に、次の 2 行を足す。

```ts
  // 「いま何をしているか」は手元の主線だけから取る。サブエージェントと他端末の写しは見ない。
  const mainLocal = file.agentId === null && !remote;
```

`const acc: Acc = { userTurns: 0, input: 0, output: 0, daily: new Map() };` の直後に、次を足す。

```ts
    const loadActivity = db.prepare('select tool, summary, tool_id, question from session_activity where session_id = ?');
    const saved = mainLocal && !reset ? (loadActivity.get(sessionId) as { tool: string; summary: string; tool_id: string; question: string | null } | undefined) : undefined;
    const startActivity: Activity | null = saved ? { tool: saved.tool, summary: saved.summary, toolId: saved.tool_id, question: saved.question } : null;
    let activity = startActivity;
```

`parsed.forEach((p, i) => {` の中の `const events = normalizeRecord(p.rec, seq, file.agentId);` の直後に、次の 1 行を足す。

```ts
      if (mainLocal) activity = foldActivity(activity, events);
```

`parsed.forEach` を閉じた直後（`db.prepare(\`insert into transcript_files …` の前）に、次を足す。

```ts
    if (mainLocal && (reset || activity !== startActivity)) {
      if (activity === null) db.prepare('delete from session_activity where session_id = ?').run(sessionId);
      else db.prepare(`insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)
        on conflict(session_id) do update set tool = excluded.tool, summary = excluded.summary, tool_id = excluded.tool_id, question = excluded.question, updated_at = excluded.updated_at`)
        .run(sessionId, activity.tool, activity.summary, activity.toolId, activity.question, Date.now());
    }
```

- [ ] **Step 10: 実行中のセッションにだけ載せる**

`packages/server/src/db/queries.ts` の `SessionRow` の型の `ls_cost: number | null;` の直後に、次の 3 行を足す。

```ts
  a_tool: string | null;
  a_summary: string | null;
  a_question: string | null;
```

`SESSION_SELECT` の `ls.model ls_model, … ls.cost_usd ls_cost` の行の末尾に `, a.tool a_tool, a.summary a_summary, a.question a_question` を足す。
同じ文字列の `left join session_live_stats ls on ls.provider_session_id = s.provider_session_id` の行の直後に、次の 1 行を足す。

```sql
left join session_activity a on a.session_id = s.id
```

`toSessionDto` の返す値の `remoteOnly: …,` の行の直後に、次を足す。

```ts
    // 最後に呼んだツールと待っている問いは、実行中のときだけ載せる。終わったセッションの古い呼び出しは出さない。
    ...(live ? { activity: r.a_tool !== null ? { tool: r.a_tool, summary: r.a_summary ?? '', question: r.a_question } : null } : {}),
```

- [ ] **Step 11: 試験が通ることを確かめる**

Run: `npx vitest run packages/server packages/shared && npm run typecheck`
Expected: PASS、型検査 0 件。
既存の試験が、実行中のセッションの `SessionDto` を `toEqual` で丸ごと比べていて落ちる場合は、期待値に `activity` の欄を足して直す（`toMatchObject` に緩めない）。

- [ ] **Step 12: コミット**

```bash
git add packages/server/src/provider/claude-code/activity.ts packages/server/src/provider/claude-code/activity.test.ts
git commit packages/shared/src/api.ts packages/server/src/provider/claude-code/activity.ts packages/server/src/provider/claude-code/activity.test.ts packages/server/src/db/migrations.ts packages/server/src/indexer/indexFile.ts packages/server/src/db/queries.ts packages/server/src/db/db.test.ts packages/server/src/indexer/indexFile.test.ts packages/server/src/db/queries.test.ts -m "$(cat <<'EOF'
feat(server): tell the UI what a running session is doing and what it is asking

Fold the main transcript's appended events into the last tool call and
the pending AskUserQuestion prompt, keep them in a device-local table,
and attach them to running sessions only. The question clears as soon as
its tool result arrives, and nothing of it enters cloud sync.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 開いたら端末にフォーカスする

「ターミナルで答える」は、そのセッションの画面を開いて端末にフォーカスする。
画面の移動は URL のハッシュが正なので、`session.open` の時点では覚えておくだけにし、その画面に着いた `hash.changed` でフォーカスの効果を出す。

**Files:**
- Modify: `packages/shared/src/intent.ts:30`
- Modify: `packages/ui/src/mediator/types.ts`（`State`）
- Modify: `packages/ui/src/mediator/transition.ts`（`initialState`）
- Modify: `packages/ui/src/mediator/screen.ts`（`screenStep`）
- Test: `packages/ui/src/mediator/transition.test.ts`

**Interfaces:**
- Produces: Intent `{ type: 'session.open'; id: SessionId; focus?: 'terminal' }`。Task 5 の要対応の札がこれを出す。
- Produces: `State.focusOnOpen: string | null`。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/mediator/transition.test.ts` の末尾に、次の `describe` を足す。

```ts
describe('開いたら端末にフォーカス', () => {
  const focus = { kind: 'focus', target: 'terminal' };
  it('focus: terminal で開くと、その画面に着いたときに端末へフォーカスする', () => {
    const { state, effects } = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' }), runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]);
    expect(effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' } });
    expect(effects).toContainEqual(focus);
    expect(state.focusOnOpen).toBeNull();
  });
  it('ふつうに開いたときと、別の画面に着いたときはフォーカスしない', () => {
    const a = run([intent({ type: 'session.open', id: 's1' }), runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]);
    expect(a.effects).not.toContainEqual(focus);
    const b = run([intent({ type: 'session.open', id: 's1', focus: 'terminal' }), runtime({ type: 'hash.changed', route: { name: 'home' } })]);
    expect(b.effects).not.toContainEqual(focus);
    expect(b.state.focusOnOpen).toBeNull();
  });
  it('もうその画面にいれば、移らずにフォーカスだけする', () => {
    const at = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]).state;
    expect(run([intent({ type: 'session.open', id: 's1', focus: 'terminal' })], at).effects).toEqual([focus]);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/mediator/transition.test.ts`
Expected: FAIL（型の上でも `focus` が無い。`focusOnOpen` が `undefined`）。

- [ ] **Step 3: Intent と状態を足す**

`packages/shared/src/intent.ts` の `| { type: 'session.open'; id: SessionId }` を、次に変える。

```ts
  | { type: 'session.open'; id: SessionId; focus?: 'terminal' }
```

`packages/ui/src/mediator/types.ts` の `State` の `waitingSeen: string[];` の直後に、次を足す。

```ts
  /** focus: terminal で開いたセッション。その画面に着いたら端末にフォーカスし、着いたら忘れる。 */
  focusOnOpen: string | null;
```

`packages/ui/src/mediator/transition.ts` の `initialState` の `waitingSeen: [],` の直後に `focusOnOpen: null,` を足す。

- [ ] **Step 4: 着いたらフォーカスする**

`packages/ui/src/mediator/screen.ts` の `hash.changed` の枝の `let next: State = { ...state, screen: route, overlay: closeTransient(state) };` を、次に変える。

```ts
    let next: State = { ...state, screen: route, overlay: closeTransient(state), focusOnOpen: null };
```

同じ枝の `if (route.name === 'session') effects.push({ kind: 'api.loadEvents', … }, { kind: 'terminal.connect', … });` の直後に、次の 2 行を足す。

```ts
    // 「ターミナルで答える」で開いた画面なら、つないだ端末にそのままフォーカスする。
    if (route.name === 'session' && state.focusOnOpen === route.id) effects.push({ kind: 'focus', target: 'terminal' });
```

`case 'session.open': …` の 1 行を、次に置き換える。

```ts
    case 'session.open': {
      const overlay = closeTransient(state);
      // もうその画面にいればハッシュは変わらないので、フォーカスだけを出す。
      if (i.focus === 'terminal' && state.screen.name === 'session' && state.screen.id === i.id) return { state: { ...state, overlay }, effects: [{ kind: 'focus', target: 'terminal' }] };
      return { state: { ...state, overlay, focusOnOpen: i.focus === 'terminal' ? i.id : null }, effects: [{ kind: 'navigate', route: { name: 'session', id: i.id } }] };
    }
```

端末がまだ開いていないうちのフォーカスは、`runtime/terminals.ts` の `pendingFocus` が開いた後に当て直す（今の仕組みのまま）。

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/mediator && npm run typecheck`
Expected: PASS、型検査 0 件。
`'nav.go と project.open と session.open は navigate 効果だけを出す'` の試験も通る（`focus` の無い `session.open` は今と同じ効果を出す）。

- [ ] **Step 6: コミット**

```bash
git commit packages/shared/src/intent.ts packages/ui/src/mediator/types.ts packages/ui/src/mediator/transition.ts packages/ui/src/mediator/screen.ts packages/ui/src/mediator/transition.test.ts -m "$(cat <<'EOF'
feat(ui): open a session with its terminal focused when asked to

Remember the request until the session screen arrives, and focus at once
when that screen is already open.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 2 段の行（44px）

どのセッション一覧も、1 段目に名前、2 段目に要約の 1 文を置く 2 段の行にする。
右端と 2 段目に何を出すかは、画面の役目（`variant`）で変える。

| variant | 使う画面 | 1 段目 | 2 段目 | 右端 |
|---|---|---|---|---|
| `recent` | Home の最近 | 名前 | 要約の 1 文 | 時刻 |
| `project` | プロジェクト詳細 | 名前 | 要約の 1 文と、あれば `✎ メモ` | モデルと effort、変更数、PR、推定コストの 1 行と、その下に時刻 |
| `search` | Sessions（全件と検索） | 名前とプロジェクト名 | 一致箇所の抜粋（一致した語に淡い印）。抜粋が無ければ要約の 1 文 | 時刻 |

見出しの行（名前、要約、状態 …）は無くす。
検索の抜粋は、最初の 1 つだけを出す（今の、行の下に 3 つまで積む形はやめる）。
`m` のメモの編集は、どの画面でも 2 段目で開く。

**Files:**
- Create: `packages/ui/src/presenters/highlight.ts`、`packages/ui/src/presenters/highlight.test.ts`
- Modify: `packages/ui/src/presenters/row.ts`、`packages/ui/src/presenters/sessions.ts`
- Modify: `packages/ui/src/views/SessionRows.tsx`（全体を置き換える）
- Modify: `packages/ui/src/styles/rows.css`（末尾に足す）、`packages/ui/src/styles/tokens.css`
- Create: `packages/ui/src/styles/rows.test.ts`
- Modify: `packages/ui/src/views/ProjectScreen.tsx:35`、`packages/ui/src/views/SessionsScreen.tsx:33`、`packages/ui/src/views/HomeScreen.tsx:27`
- Test: `packages/ui/src/views/SessionRows.test.tsx`、`packages/ui/src/views/misc.test.tsx`、`packages/ui/src/presenters/presenters.test.ts`

**Interfaces:**
- Produces: `export type Segment = { text: string; hit: boolean }` と `markTerms(text: string, query: string): Segment[]`（`presenters/highlight.ts`）。
- Produces: `SessionRowProps` の `snippets?` を `excerpt?: Segment[]` に置き換える。`presentSessionRow(s, store, now, excerpt?: Segment[])`。
- Produces: `SessionRows(props: { rows: SessionRowProps[]; height: number | string; variant: RowVariant; emptyText?: string })`、`export type RowVariant = 'recent' | 'project' | 'search'`、`export const SESSION_ROW_H = 44`（`views/SessionRows.tsx`）。Task 5 の Home がこれを使う。

- [ ] **Step 1: 印付けの、失敗する試験を書く**

`packages/ui/src/presenters/highlight.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import { markTerms } from './highlight.ts';

describe('markTerms', () => {
  it('検索語を大文字と小文字を問わずに印し、残りはそのまま', () => {
    expect(markTerms('床（transcriptsFrom）を外す', 'TRANSCRIPTSFROM')).toEqual([{ text: '床（', hit: false }, { text: 'transcriptsFrom', hit: true }, { text: '）を外す', hit: false }]);
  });
  it('空白で区切った語をどれも印し、重なるときは長い語を先に当てる', () => {
    expect(markTerms('sync sync-floor', 'sync sync-floor')).toEqual([{ text: 'sync', hit: true }, { text: ' ', hit: false }, { text: 'sync-floor', hit: true }]);
  });
  it('正規表現の記号と引用符は、ただの文字として扱う', () => {
    expect(markTerms('a.b(c) と axb(', '"a.b("')).toEqual([{ text: 'a.b(', hit: true }, { text: 'c) と axb(', hit: false }]);
  });
  it('語が無ければ全体を印のない 1 つの塊にし、本文が空なら空', () => {
    expect(markTerms('本文', '  ')).toEqual([{ text: '本文', hit: false }]);
    expect(markTerms('', 'x')).toEqual([]);
  });
});
```

- [ ] **Step 2: 行の見た目の、失敗する試験を書く**

`packages/ui/src/styles/rows.test.ts` を作る。

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SESSION_ROW_H } from '../views/SessionRows.tsx';

const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

describe('2 段の行', () => {
  // 仮想スクロールの見積もり（SESSION_ROW_H）と、CSS の高さがずれると、スクロールの位置が行の途中で止まる。
  it('行の高さは 44px で、tokens.css と SessionRows の見積もりが揃う', () => {
    expect(SESSION_ROW_H).toBe(44);
    expect(read('./tokens.css')).toContain(`--session-row-h: ${SESSION_ROW_H}px;`);
    expect(read('./rows.css')).toMatch(/\.row-2 \{[^}]*height: var\(--session-row-h\);/);
  });
  it('1 段の部品の高さ（--row-h）は 28px のまま', () => {
    expect(read('./tokens.css')).toContain('--row-h: 28px;');
  });
  it('一致した語の印は淡い地で、文字の色は変えない', () => {
    expect(read('./rows.css')).toMatch(/\.hit \{[^}]*background: var\(--hit\);[^}]*color: inherit;/);
  });
});
```

`packages/ui/src/views/SessionRows.test.tsx` の import の並びに `within` を足し（`@testing-library/react` から）、末尾に次の `describe` を足す。

```tsx
describe('SessionRows（2 段の行）', () => {
  const r = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, stateLabel: '完了', model: 'opus 4.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 6, prUrl: 'https://github.com/x/y/pull/1', memo: 'スワイプは実機で', hasTranscript: true, cost: '$1.82', runId: null, ...over });
  const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;

  it('最近は 2 段目に要約、右は時刻だけ', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a')]} height={400} variant="recent" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('要約 a');
    expect(row).toHaveTextContent('3 分前');
    for (const t of ['opus 4.1', '変更 6', '$1.82', 'スワイプは実機で', 'alpha']) expect(row).not.toHaveTextContent(t);
    expect(within(row).queryByText('PR')).toBeNull();
  });
  it('プロジェクト詳細は右にモデル、変更、PR、コストと時刻、2 段目にメモ', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a')]} height={400} variant="project" /></IntentRoot>);
    const row = rowOf('名前 a');
    for (const t of ['opus 4.1 · high', '変更 6', '$1.82', '3 分前', '要約 a', '✎ スワイプは実機で']) expect(row).toHaveTextContent(t);
    expect(within(row).getByText('PR').closest('a')).toHaveAttribute('href', 'https://github.com/x/y/pull/1');
  });
  it('変更が 0 で PR もコストもメモも無ければ、その印を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a', { filesChanged: 0, prUrl: null, cost: '', memo: null })]} height={400} variant="project" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).not.toHaveTextContent('変更');
    expect(row).not.toHaveTextContent('✎');
    expect(within(row).queryByText('PR')).toBeNull();
  });
  it('検索は 1 段目にプロジェクト名、2 段目に一致箇所を印つきで出す', () => {
    const excerpt = [{ text: '…床（', hit: false }, { text: 'transcriptsFrom', hit: true }, { text: '）を…', hit: false }];
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a', { excerpt })]} height={400} variant="search" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('alpha');
    expect(row.querySelector('mark.hit')).toHaveTextContent('transcriptsFrom');
    expect(row).not.toHaveTextContent('要約 a');
  });
  it('検索でも抜粋が無ければ要約を出し、プロジェクトが無ければ未分類', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[r('a', { projectName: null })]} height={400} variant="search" /></IntentRoot>);
    const row = rowOf('名前 a');
    expect(row).toHaveTextContent('要約 a');
    expect(row).toHaveTextContent('未分類');
  });
  it('m のメモの編集は、プロジェクト詳細でなくても 2 段目で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[r('a')]} height={400} variant="recent" /></IntentRoot>);
    const host = screen.getByTestId('session-rows');
    fireEvent.keyDown(host, { key: 'j' });
    fireEvent.keyDown(host, { key: 'm' });
    const input = screen.getByLabelText('名前 a のメモ');
    fireEvent.change(input, { target: { value: '新' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 'a', text: '新' });
  });
});
```

同じファイルの既存の試験の呼び方を、次のとおり機械的に直す。
- `showProject={false}` は `variant="project"` に変える。
- 値の無い `showProject` は `variant="search"` に変える。
- `'コストとメモの列を出す'` の試験の、見出しの文字（`'コスト'` と `'メモ'`）を探す 2 行を消す（見出しの行を無くすため）。`'$0.50'` を探す行は残し、`screen.getByText('覚書')` は `screen.getByText('✎ 覚書')` に変える（メモは 2 段目に `✎` を添えて 1 つの塊で出るため）。

`packages/ui/src/views/misc.test.tsx` の `describe('SessionRows（空のとき）', …)` の `showProject` を `variant="search"` に変える。
同じファイルの `describe('SessionRows（抜粋つき）', …)` は、全体を消す（行の下に抜粋を積む形を無くし、抜粋は 2 段目の 1 つにするため。代わりの試験は上の `'検索は 1 段目に …'` である）。

`packages/ui/src/presenters/presenters.test.ts` の `expect(r.rows[0]!.snippets).toEqual([{ seq: 1, text: '…hi…' }]);` を、次に変える。

```ts
    expect(r.rows[0]!.excerpt).toEqual([{ text: '…', hit: false }, { text: 'hi', hit: true }, { text: '…', hit: false }]);
```

- [ ] **Step 3: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/styles packages/ui/src/views`
Expected: FAIL（`highlight.ts` と `SESSION_ROW_H` が無い、`variant` が効かない、`excerpt` が無い）。

- [ ] **Step 4: 印付けを書く**

`packages/ui/src/presenters/highlight.ts` を作る。

```ts
/** 抜粋を、一致した語とそれ以外の塊に分けたもの。hit の塊に淡い印を付けて描く。 */
export type Segment = { text: string; hit: boolean };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 検索語（空白区切り）に一致する所を、大文字と小文字を問わずに印す。
 * 引用符は検索の構文なので外し、正規表現の記号はただの文字として扱う。
 * 語が重なるときは長い語を先に当てる。
 */
export function markTerms(text: string, query: string): Segment[] {
  if (text === '') return [];
  const terms = [...new Set(query.replace(/"/g, ' ').split(/\s+/).filter((t) => t !== ''))].sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [{ text, hit: false }];
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
```

- [ ] **Step 5: 行の props を抜粋に変える**

`packages/ui/src/presenters/row.ts` の先頭の import の並びに、次の 1 行を足す。

```ts
import type { Segment } from './highlight.ts';
```

同じファイルの `SessionRowProps` の型の末尾の `snippets?: { seq: number; text: string }[]` を `excerpt?: Segment[]` に変える。
`presentSessionRow` の引数の `snippets?: { seq: number; text: string }[]` を `excerpt?: Segment[]` に変え、`if (snippets) row.snippets = snippets;` を `if (excerpt) row.excerpt = excerpt;` に変える。

`packages/ui/src/presenters/sessions.ts` の import の並びに `import { markTerms } from './highlight.ts';` を足し、`for (const h of result?.hits ?? []) { … }` の 1 行を、次に置き換える。

```ts
  // 行は 2 段なので、抜粋は最初の 1 つだけを 2 段目に出す。
  for (const h of result?.hits ?? []) {
    const s = store.sessions[h.sessionId];
    if (!s) continue;
    const first = h.snippets[0];
    rows.push(presentSessionRow(s, store, now, first ? markTerms(first.text, state.search.text) : []));
  }
```

- [ ] **Step 6: 行の部品を書き換える**

`packages/ui/src/views/SessionRows.tsx` の全体を、次に置き換える。

```tsx
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { Icon } from './primitives/Icon.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

/** 2 段の行の高さ。tokens.css の --session-row-h と同じ値にする（styles/rows.test.ts が突き合わせる）。 */
export const SESSION_ROW_H = 44;

/**
 * 一覧の役目。右端と 2 段目に何を出すかがこれで決まる。
 * recent は Home の最近（右は時刻だけ）。
 * project はプロジェクト詳細（右にモデル、変更、PR、コストと時刻。2 段目にメモ）。
 * search は Sessions（1 段目にプロジェクト名、2 段目に一致箇所の抜粋）。
 */
export type RowVariant = 'recent' | 'project' | 'search';

/** 行が無いときに出す文言。emptyText で差し替えられる。 */
const DEFAULT_EMPTY_TEXT = 'セッションはまだありません';

export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; variant: RowVariant; emptyText?: string }) {
  const emit = useEmit();
  // カーソルは一覧の中だけの状態なので Mediator には置かない。
  // -1 は未選択で、このとき Enter や o や m は何も起こさない。
  const [cursor, setCursor] = useState(-1);
  // 編集中のセッションの id。null なら編集していない。
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);

  // 仮想リストは画面の外の行を描かないので、カーソルが可視範囲を出たら見える位置まで運ぶ。
  // これをしないと、見えていない行が選ばれたまま Enter で開けてしまう。
  useEffect(() => {
    if (cursor < 0) return;
    const el = hostRef.current?.querySelector('[data-cursor="true"]');
    // jsdom のように scrollIntoView を持たない環境では何もしない。
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const startEdit = (r: SessionRowProps) => { setEditing(r.id); setDraft(r.memo ?? ''); };
  const commit = (id: string) => { emit({ type: 'session.setMemo', id, text: draft }); setEditing(null); };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // 編集中の入力欄から上がってきたキーは横取りしない。
    if (editing !== null) return;
    const max = props.rows.length - 1;
    const cur = props.rows[cursor];
    switch (e.key) {
      case 'j': setCursor((c) => Math.min(max, c + 1)); break;
      case 'k': setCursor((c) => Math.max(0, c - 1)); break;
      case 'Enter': if (cur) emit({ type: 'session.open', id: cur.id }); break;
      case 'o': if (cur?.runId) emit({ type: 'session.openTerminalApp', runId: cur.runId }); break;
      case 'e': if (cur) emit({ type: 'session.openEditor', sessionId: cur.id }); break;
      case 'm': if (cur) startEdit(cur); break;
      default: return;
    }
    e.preventDefault();
  };

  if (props.rows.length === 0) return <div className="list"><div className="empty">{props.emptyText ?? DEFAULT_EMPTY_TEXT}</div></div>;

  const memoEditor = (r: SessionRowProps) => (
    <input className="input memo-input" autoFocus aria-label={`${r.name} のメモ`} value={draft} onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // 入力欄のキーは行にも一覧にも渡さない。
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(r.id); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
        else e.stopPropagation();
      }}
      onBlur={() => setEditing(null)} />
  );

  // 2 段目。検索は一致箇所の抜粋を、ほかは要約の 1 文を出す。プロジェクト詳細はその後ろにメモと鉛筆を置く。
  const sub = (r: SessionRowProps) => {
    if (editing === r.id) return <span className="row-sub">{memoEditor(r)}</span>;
    const excerpt = props.variant === 'search' && r.excerpt && r.excerpt.length > 0 ? r.excerpt : null;
    return (
      <span className="row-sub">
        <span className={excerpt ? 'row-text mono' : 'row-text'}>{excerpt ? excerpt.map((s, i) => (s.hit ? <mark key={i} className="hit">{s.text}</mark> : <span key={i}>{s.text}</span>)) : r.oneLiner}</span>
        {props.variant === 'project' && r.memo && <span className="row-memo">✎ {r.memo}</span>}
        {props.variant === 'project' && <button type="button" className="btn memo-pencil" aria-label={`${r.name} のメモを編集`} onClick={(e) => { e.stopPropagation(); startEdit(r); }}><Icon name="edit" /></button>}
      </span>
    );
  };

  // 右端。プロジェクト詳細はモデル、変更、PR、コストの小さな 1 行を時刻の上に置く。ほかは時刻だけ。
  const side = (r: SessionRowProps) => (
    <span className="row-side">
      {props.variant === 'project' && (
        <span className="row-meta">
          {r.model && <span className="mono">{r.model}{r.effort ? ` · ${r.effort}` : ''}</span>}
          {r.filesChanged > 0 && <span>変更 {r.filesChanged}</span>}
          {r.prUrl && <a href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR</a>}
          {r.cost && <span className="mono">{r.cost}</span>}
        </span>
      )}
      <RelativeTime label={r.when} abs={r.whenAbs} />
    </span>
  );

  return (
    <div className="rows-host" data-testid="session-rows" ref={hostRef} tabIndex={0} onKeyDown={onKeyDown}>
      <VirtualList items={props.rows} rowHeight={SESSION_ROW_H} height={props.height} keyOf={(r) => r.id} render={(r, i) => (
        <div className="row row-2" role="row" tabIndex={0} data-cursor={i === cursor ? 'true' : undefined}
          onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
          <StatusDot status={r.live} />
          <span className="row-main">
            <span className="row-name">{r.name}{props.variant === 'search' && <span className="row-proj">{r.projectName ?? '未分類'}</span>}</span>
            {sub(r)}
          </span>
          {side(r)}
        </div>
      )} />
    </div>
  );
}
```

- [ ] **Step 7: 2 段の行の見た目を書く**

`packages/ui/src/styles/tokens.css` の `--row-h: 28px;` の行の直後に、次の 2 行を足す。

```css
  --session-row-h: 44px;
  --hit: #fff3c4;
```

`packages/ui/src/styles/rows.css` の末尾に、次を足す。

```css
/* 2 段の行（UI 刷新 2 回目）。1 段目に名前、2 段目に要約か抜粋。右端は画面の役目で変える（SessionRows の variant）。
   高さは --session-row-h で持ち、SessionRows の SESSION_ROW_H と揃える（rows.test.ts）。
   1 段の部品の --row-h（28px）とは別の値である。 */
.row-2 { grid-template-columns: 16px minmax(0, 1fr) auto; height: var(--session-row-h); }
.row-main { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; }
.row-name { overflow: hidden; text-overflow: ellipsis; font-weight: 560; }
.row-proj { margin-left: calc(var(--u) * 1.5); font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); }
.row-sub { display: flex; align-items: center; gap: calc(var(--u) * 2); min-width: 0; font-size: var(--fs-sm); color: var(--ink-2); }
.row-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.row-memo { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; color: var(--ink-3); }
.row-sub .memo-input { flex: 1; }
.row-side { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 2px; font-size: var(--fs-xs); color: var(--ink-3); }
.row-meta { display: flex; align-items: center; gap: calc(var(--u) * 2.5); }
/* 一致した語の印。淡い黄の地だけを敷き、文字の色は周りのまま（読みやすさを落とさない）。 */
.hit { background: var(--hit); color: inherit; border-radius: 3px; padding: 0 2px; }
```

- [ ] **Step 8: 呼び出し側を直す**

`packages/ui/src/views/ProjectScreen.tsx` の `<SessionRows rows={props.sessions} height="calc(100vh - 200px)" showProject={false} />` を、次に変える。

```tsx
<SessionRows rows={props.sessions} height="calc(100vh - 200px)" variant="project" />
```

`packages/ui/src/views/SessionsScreen.tsx` の `<SessionRows … showProject showSnippets={props.mode === 'search'} … />` の `showProject showSnippets={props.mode === 'search'}` を `variant="search"` に変える（ほかの属性はそのまま）。

`packages/ui/src/views/HomeScreen.tsx` の import を `import { SESSION_ROW_H, SessionRows } from './SessionRows.tsx';` に変え、`<SessionRows rows={props.recent} height={Math.min(props.recent.length, 15) * 28 + 28} showProject />` を、次に変える（Home そのものは Task 5 で作り直す。ここでは型と高さだけを合わせる）。

```tsx
<SessionRows rows={props.recent} height={Math.min(props.recent.length, 10) * SESSION_ROW_H} variant="recent" />
```

- [ ] **Step 9: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: PASS、型検査 0 件。
ほかに `snippets`、`showProject`、`showSnippets` を使っている所が残っていれば、`grep -rn "snippets\|showProject\|showSnippets" packages/ui/src` で探して同じ規則で直す（サーバの `SearchHitDto.snippets` はそのまま）。

- [ ] **Step 10: コミット**

```bash
git add packages/ui/src/presenters/highlight.ts packages/ui/src/presenters/highlight.test.ts packages/ui/src/styles/rows.test.ts
git commit packages/ui/src/presenters/highlight.ts packages/ui/src/presenters/highlight.test.ts packages/ui/src/presenters/row.ts packages/ui/src/presenters/sessions.ts packages/ui/src/views/SessionRows.tsx packages/ui/src/styles/rows.css packages/ui/src/styles/tokens.css packages/ui/src/styles/rows.test.ts packages/ui/src/views/ProjectScreen.tsx packages/ui/src/views/SessionsScreen.tsx packages/ui/src/views/HomeScreen.tsx packages/ui/src/views/SessionRows.test.tsx packages/ui/src/views/misc.test.tsx packages/ui/src/presenters/presenters.test.ts -m "$(cat <<'EOF'
feat(ui): show session lists as two-line rows chosen by the screen's role

Put the name over the summary at 44px, show only the time on Home,
the model, changes, PR, and cost on a project, and a marked excerpt with
the project name in search. The memo still opens in place with m.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Home の Presenter（要対応、実行中の札、最近、プロジェクト）

**Files:**
- Modify: `packages/ui/src/presenters/home.ts`（全体を置き換える）
- Test: `packages/ui/src/presenters/presenters.test.ts`

**Interfaces:**
- Consumes: Task 1 の `SessionDto.activity?: { tool; summary; question } | null`。Task 3 の `presentSessionRow` と `SessionRowProps`。
- Produces（Task 5 が使う）：

```ts
export type AttentionCard = { id: string; name: string; projectName: string | null; waited: string; question: string };
export type RunningCard = { id: string; name: string; live: LiveStatus | null; elapsed: string; meta: string; activity: { tool: string; summary: string } | null; note: string | null; contextPercent: number | null; contextLabel: string };
export type ProjectMini = { id: string; name: string; status: ProjectStatus; counts: string };
export type HomeProps = { attention: AttentionCard[]; running: RunningCard[]; recent: SessionRowProps[]; projects: ProjectMini[] };
```

決まり（仕様の Home と、試作の 3-b）：

- 要対応は `live === 'waiting'` のセッションで、長く待っている順（`lastActivityAt` の古い順）に並べる。問いは `activity.question`、無ければ「入力を待っています」。待っている時間は `lastActivityAt` からの長さ。
- 実行中は `live` が `busy` か `idle` のセッションと、Claude のレジストリに載る前の run（`runningSessionIds`）のセッション。入力待ちは要対応にだけ出す。並びは今の `sortSessions` のまま。
- 実行中の札の 1 行は、`busy` で呼び出しがあればツールと対象、`busy` で呼び出しが無ければ「作業中」、`idle` は「休み。最後の返答から N 分」、レジストリに載る前は「起動しています」。
- 最近は、要対応と実行中に出したものを除き、`lastActivityAt` の新しい順に 30 件。
- プロジェクトは、active でスクラッチでないプロジェクトを `lastActivityAt` の新しい順に並べ、`実行中 N · TODO N · 要対応 N` のうち 0 でない数だけを並べる。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/presenters/presenters.test.ts` の `describe('presentHome', …)` の全体を、次に置き換える。

```ts
describe('presentHome', () => {
  // 入力待ちが 2 件（w1 は 12 分、w2 は 3 分）、作業中が 1 件（s1）、休みが 1 件（i1）。
  const homeStore = () => {
    const s = storeWith();
    s.sessions = {
      ...s.sessions,
      w1: session('w1', { live: 'waiting', lastActivityAt: NOW - 12 * 60_000, activity: { tool: 'AskUserQuestion', summary: 'AskUserQuestion', question: 'どちらにしますか？' } }),
      w2: session('w2', { live: 'waiting', lastActivityAt: NOW - 3 * 60_000, activity: null }),
      i1: session('i1', { live: 'idle', lastActivityAt: NOW - 8 * 60_000, stats: { ...session('i1').stats, contextPercent: 22 } }),
    };
    s.sessions.s1 = { ...s.sessions.s1!, activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts', question: null }, stats: { ...s.sessions.s1!.stats, contextPercent: 38.4 } };
    return s;
  };
  it('要対応は入力待ちを長く待っている順に拾い、問いが無ければ決まりの文を出す', () => {
    expect(presentHome(initialState(), homeStore(), NOW).attention).toEqual([
      { id: 'w1', name: 'name-w1', projectName: 'alpha', waited: '12 分', question: 'どちらにしますか？' },
      { id: 'w2', name: 'name-w2', projectName: 'alpha', waited: '3 分', question: '入力を待っています' },
    ]);
  });
  it('実行中は作業中と休みを拾い、入力待ちは要対応だけに出す', () => {
    const p = presentHome(initialState(), homeStore(), NOW);
    expect(p.running.map((r) => r.id)).toEqual(['s1', 'i1']);
    expect(p.running[0]).toEqual({ id: 's1', name: 'name-s1', live: 'busy', elapsed: '2 時間', meta: 'alpha · fable 5.1 · high', activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts' }, note: null, contextPercent: 38.4, contextLabel: '38%' });
    expect(p.running[1]).toMatchObject({ live: 'idle', activity: null, note: '休み。最後の返答から 8 分', contextPercent: 22, contextLabel: '22%' });
  });
  it('作業中でも呼び出しがまだ無ければ「作業中」、レジストリに載る前の run は「起動しています」', () => {
    // 信頼確認のダイアログ待ちの run は Claude のレジストリにまだ載らない。
    const store = storeWith();
    store.runs = { r2: runDto('r2', 's2'), r3: runDto('r3', 's3', NOW) };
    const p = presentHome(initialState(), store, NOW);
    expect(p.running.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(p.running[0]).toMatchObject({ activity: null, note: '作業中', contextLabel: '未取得' });
    expect(p.running[1]).toMatchObject({ live: null, activity: null, note: '起動しています' });
  });
  it('最近は要対応と実行中に出したものを除き、新しい順に並べる', () => {
    expect(presentHome(initialState(), homeStore(), NOW).recent.map((r) => r.id)).toEqual(['s3', 's2']);
  });
  it('終わったセッションは札から消えて、最近に入る', () => {
    const store = homeStore();
    store.sessions.s1 = { ...store.sessions.s1!, live: null, lastActivityAt: NOW - 30_000 };
    const p = presentHome(initialState(), store, NOW);
    expect(p.running.map((r) => r.id)).toEqual(['i1']);
    expect(p.recent[0]!.id).toBe('s1');
  });
  it('プロジェクトは active だけを小さな一覧にし、0 の数は出さない', () => {
    const store = homeStore();
    store.projects.alpha = { ...store.projects.alpha!, runningCount: 2, openTodoCount: 3 };
    expect(presentHome(initialState(), store, NOW).projects).toEqual([{ id: 'alpha', name: 'alpha', status: 'active', counts: '実行中 2 · TODO 3 · 要対応 2' }]);
    store.projects.alpha = { ...store.projects.alpha!, runningCount: 0, openTodoCount: 0 };
    store.sessions = { s2: store.sessions.s2! };
    expect(presentHome(initialState(), store, NOW).projects[0]!.counts).toBe('');
  });
});
```

同じファイルの `describe('presentProjects と presentHome（スクラッチ）', …)` の `presentHome(initialState(), store, NOW).activeProjects.map((c) => c.id)` を `presentHome(initialState(), store, NOW).projects.map((c) => c.id)` に変える。
同じファイルの `'行を組み立てる画面にもコストと run が乗る'` の `expect(presentHome(initialState(), store, NOW).recent[0]).toMatchObject({ id: 's1', cost: '$3.00', runId: 'r1' });` を、次に変える（実行中の s1 は最近ではなく実行中の札に出るため、行を組み立てる Sessions の画面で確かめる）。

```ts
    expect(presentSessions(initialState(), store, NOW).rows[0]).toMatchObject({ id: 's1', cost: '$3.00', runId: 'r1' });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts`
Expected: FAIL（`attention`、`projects` が無い）。

- [ ] **Step 3: Presenter を書く**

`packages/ui/src/presenters/home.ts` の全体を、次に置き換える。

```ts
import type { LiveStatus, ProjectStatus, SessionDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { runningSessionIds, type Store } from '../store/store.ts';
import { durationLabel, percentLabel, shortModel } from './format.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

/** 要対応の札。入力待ちのセッション 1 件につき 1 枚。 */
export type AttentionCard = { id: string; name: string; projectName: string | null; waited: string; question: string };
/** 実行中の札。activity があれば墨の地にツールと対象を、無ければ note の一言を出す。 */
export type RunningCard = { id: string; name: string; live: LiveStatus | null; elapsed: string; meta: string; activity: { tool: string; summary: string } | null; note: string | null; contextPercent: number | null; contextLabel: string };
/** Home のプロジェクトの小さな一覧の 1 行。counts は 0 でない数だけを並べた文。 */
export type ProjectMini = { id: string; name: string; status: ProjectStatus; counts: string };
export type HomeProps = { attention: AttentionCard[]; running: RunningCard[]; recent: SessionRowProps[]; projects: ProjectMini[] };

/** 問いの文が取れなかった入力待ち（権限の確認など）に出す文。 */
const NO_QUESTION = '入力を待っています';
const RECENT_LIMIT = 30;

export function presentHome(_state: State, store: Store, now: number): HomeProps {
  const sessions = Object.values(store.sessions);
  const projectName = (s: SessionDto) => (s.projectId ? store.projects[s.projectId]?.name ?? null : null);
  const name = (s: SessionDto) => s.name ?? '（名前なし）';

  // 長く待っているものほど先に答えたいので、最後に動いた時刻の古い順に並べる。
  const waiting = sessions.filter((s) => s.live === 'waiting').sort((a, b) => (a.lastActivityAt ?? now) - (b.lastActivityAt ?? now));
  const attention = waiting.map((s) => ({ id: s.id, name: name(s), projectName: projectName(s), waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? NO_QUESTION }));

  // Claude のレジストリに載る前の run も実行中に数える。
  // 信頼確認のダイアログ待ちの run が Home のどこにも出ないと、セッション画面への戻り道がなくなる。
  const alive = runningSessionIds(store);
  const running = sortSessions(sessions.filter((s) => s.live === 'busy' || s.live === 'idle' || (s.live === null && alive.has(s.id)))).map((s): RunningCard => {
    const activity = s.live === 'busy' && s.activity ? { tool: s.activity.tool, summary: s.activity.summary } : null;
    const note = activity ? null : s.live === 'idle' ? `休み。最後の返答から ${durationLabel(now - (s.lastActivityAt ?? now))}` : s.live === 'busy' ? '作業中' : '起動しています';
    const meta = [projectName(s) ?? '未分類', shortModel(s.stats.model), s.stats.effort ?? ''].filter((x) => x !== '').join(' · ');
    return { id: s.id, name: name(s), live: s.live, elapsed: durationLabel(now - (s.startedAt ?? now)), meta, activity, note, contextPercent: s.stats.contextPercent, contextLabel: percentLabel(s.stats.contextPercent) };
  });

  // 札に出したものは最近に重ねない。
  const shown = new Set([...attention.map((c) => c.id), ...running.map((c) => c.id)]);
  const recent = sessions.filter((s) => !shown.has(s.id)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, RECENT_LIMIT).map((s) => presentSessionRow(s, store, now));

  const projects = Object.values(store.projects).filter((p) => p.status === 'active' && !p.isScratch).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p): ProjectMini => {
    const counts: [string, number][] = [['実行中', p.runningCount], ['TODO', p.openTodoCount], ['要対応', waiting.filter((s) => s.projectId === p.id).length]];
    return { id: p.id, name: p.name, status: p.status, counts: counts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(' · ') };
  });

  return { attention, running, recent, projects };
}
```

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/presenters`
Expected: PASS。
`HomeScreen.tsx` はまだ古い props を読むので、型検査はこの時点では落ちる。Task 5 で直す。

- [ ] **Step 5: コミットは Task 5 と一緒にする**

Presenter の型が変わると、Home の画面が同じコミットで直らない限り型検査が落ちる。
この Task の変更は、コミットせずに Task 5 へ進む。

---

### Task 5: Home の画面

**Files:**
- Modify: `packages/ui/src/views/HomeScreen.tsx`（全体を置き換える）
- Create: `packages/ui/src/styles/home.css`
- Modify: `packages/ui/src/main.tsx`（CSS の import）
- Test: `packages/ui/src/views/screens.test.tsx`

**Interfaces:**
- Consumes: Task 4 の `HomeProps`、`RunningCard`。Task 3 の `SessionRows`、`SESSION_ROW_H`。Task 2 の `{ type: 'session.open', id, focus: 'terminal' }`。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/views/screens.test.tsx` の import の並びに `within` を足し（`@testing-library/react` から）、`import type { HomeProps, RunningCard } from '../presenters/home.ts';` を足す。
同じファイルの `describe('HomeScreen', …)` の全体を、次に置き換える（上の `card` の定義は Projects の試験がまだ使うので残す）。

```tsx
describe('HomeScreen', () => {
  const home = (over: Partial<HomeProps> = {}): HomeProps => ({ attention: [], running: [], recent: [], projects: [], ...over });
  const runningCard = (over: Partial<RunningCard> = {}): RunningCard => ({ id: 's1', name: 'キーボード操作の見直し', live: 'busy', elapsed: '12 分', meta: 'agent-hangar · opus 4.1 · high', activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts' }, note: null, contextPercent: 38, contextLabel: '38%', ...over });

  it('要対応の札は問いを出し、「ターミナルで答える」で端末にフォーカスして開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ attention: [{ id: 'w1', name: '論文の図を直す', projectName: 'thesis', waited: '12 分', question: '図 3 の凡例はどこに置きますか？' }] })} /></IntentRoot>);
    expect(screen.getByRole('heading', { name: /要対応/ })).toBeInTheDocument();
    expect(screen.getByText('図 3 の凡例はどこに置きますか？')).toBeInTheDocument();
    expect(screen.getByText(/thesis · 12 分待っている/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ターミナルで答える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'w1', focus: 'terminal' });
  });
  it('実行中の札は、いま何をしているかと文脈の使用率を出し、押すか Enter で開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ running: [runningCard()] })} /></IntentRoot>);
    const card = screen.getByRole('button', { name: /キーボード操作の見直し/ });
    expect(card).toHaveTextContent('Edit packages/ui/src/keys.ts');
    expect(card).toHaveTextContent('agent-hangar · opus 4.1 · high');
    expect(within(card).getByRole('meter', { name: '文脈の使用率' })).toHaveAttribute('aria-valuenow', '38');
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
  });
  it('休みの札は呼び出しの代わりに一言を出し、使用率が無ければゲージを空にする', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen {...home({ running: [runningCard({ live: 'idle', activity: null, note: '休み。最後の返答から 8 分', contextPercent: null, contextLabel: '未取得' })] })} /></IntentRoot>);
    const card = screen.getByRole('button', { name: /キーボード操作の見直し/ });
    expect(card).toHaveTextContent('休み。最後の返答から 8 分');
    expect(card).toHaveTextContent('未取得');
    expect(within(card).getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  });
  it('要対応と実行中が無ければ区画ごと省き、最近とプロジェクトは残す', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen {...home()} /></IntentRoot>);
    expect(screen.queryByRole('heading', { name: /要対応/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /実行中/ })).toBeNull();
    expect(screen.getByRole('heading', { name: '最近' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByText('active なプロジェクトはありません。Settings でワークスペースを確かめてください。')).toBeInTheDocument();
  });
  it('プロジェクトの小さな一覧は数を並べ、押すとプロジェクトを開く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home({ projects: [{ id: 'alpha', name: 'agent-hangar', status: 'active', counts: '実行中 2 · TODO 3' }] })} /></IntentRoot>);
    const row = screen.getByRole('button', { name: /agent-hangar/ });
    expect(row).toHaveTextContent('実行中 2 · TODO 3');
    expect(row.querySelector('.pj-dot')).toHaveAttribute('data-status', 'active');
    fireEvent.click(row);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/screens.test.tsx`
Expected: FAIL（要対応の札、実行中の札、プロジェクトの小さな一覧が無い）。

- [ ] **Step 3: 画面を書く**

`packages/ui/src/views/HomeScreen.tsx` の全体を、次に置き換える。

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { HomeProps, RunningCard } from '../presenters/home.ts';
import { SESSION_ROW_H, SessionRows } from './SessionRows.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

/** Home で一度に見せる最近の行の数。多いときは一覧の中でスクロールする。 */
const RECENT_VISIBLE = 10;

/**
 * Home（管制盤）。
 * 上から要対応、実行中、最近とプロジェクトの順に置く。
 * 要対応と実行中は、該当が無ければ区画ごと省く。
 */
export function HomeScreen(props: HomeProps) {
  const emit = useEmit();
  return (
    <div className="screen home">
      {props.attention.length > 0 && (
        <section>
          <h2 className="home-label">要対応<span className="home-count">{props.attention.length}</span></h2>
          {props.attention.map((a) => (
            <div key={a.id} className="ask-card">
              <StatusDot status="waiting" />
              <div className="ask-body">
                <div className="ask-title"><b>{a.name}</b> <span className="faint">· {a.projectName ?? '未分類'} · {a.waited}待っている</span></div>
                <div className="ask-q">{a.question}</div>
              </div>
              {/* その場では答えさせない。端末の TUI を外から操ることになって壊れやすいため、端末を開いてフォーカスする。 */}
              <button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.open', id: a.id, focus: 'terminal' })}>ターミナルで答える</button>
            </div>
          ))}
        </section>
      )}
      {props.running.length > 0 && (
        <section>
          <h2 className="home-label">実行中<span className="home-count">{props.running.length}</span></h2>
          <div className="live-grid">
            {props.running.map((r) => <LiveCard key={r.id} card={r} onOpen={() => emit({ type: 'session.open', id: r.id })} />)}
          </div>
        </section>
      )}
      <div className="home-two">
        <section>
          <h2 className="home-label">最近</h2>
          <SessionRows rows={props.recent} height={Math.min(props.recent.length, RECENT_VISIBLE) * SESSION_ROW_H} variant="recent" />
        </section>
        <section>
          <h2 className="home-label">プロジェクト</h2>
          <div className="list">
            {props.projects.length === 0
              ? <div className="empty">active なプロジェクトはありません。Settings でワークスペースを確かめてください。</div>
              : props.projects.map((p) => (
                <button key={p.id} type="button" className="pj-row" onClick={() => emit({ type: 'project.open', id: p.id })}>
                  <span className="pj-dot" data-status={p.status} />
                  <span className="pj-name">{p.name}</span>
                  <span className="pj-counts">{p.counts}</span>
                </button>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 実行中の札。いま何をしているかを墨の地の 1 行で見せ、文脈の使用率をゲージで出す。 */
function LiveCard(props: { card: RunningCard; onOpen: () => void }) {
  const c = props.card;
  const width = Math.max(0, Math.min(100, c.contextPercent ?? 0));
  return (
    <div className="live-card" role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(e) => { if (e.key === 'Enter') props.onOpen(); }}>
      <div className="live-head"><StatusDot status={c.live} /><span className="live-name">{c.name}</span><span className="live-elapsed mono">{c.elapsed}</span></div>
      <div className="live-meta">{c.meta}</div>
      <div className="live-act mono">{c.activity ? <><i>{c.activity.tool}</i> {c.activity.summary}</> : <span className="live-note">{c.note}</span>}</div>
      <div className="live-ctx">
        文脈
        <span className="gauge-bar" role="meter" aria-label="文脈の使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.contextPercent ?? undefined}>
          <span className="gauge-fill" data-high={c.contextPercent !== null && c.contextPercent >= 80 ? 'true' : undefined} style={{ width: `${width}%` }} />
        </span>
        {c.contextLabel}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 見た目を書く**

`packages/ui/src/styles/home.css` を作る。

```css
/* Home（管制盤）。上から要対応、実行中、最近とプロジェクト（試作の 3-b）。
   どの札も白い不透明な読む面で、ぼかしは掛けない。 */
.home-label { display: flex; align-items: baseline; gap: calc(var(--u) * 1.5); margin: calc(var(--u) * 5) 0 calc(var(--u) * 2) var(--u); font-size: var(--fs-sm); font-weight: 600; color: var(--ink-2); }
.home > section:first-child > .home-label, .home > .home-two:first-child .home-label { margin-top: 0; }
.home-count { font-weight: 500; color: var(--ink-3); }

/* 要対応の札。入力待ちの色を縁に薄く混ぜ、横長に 1 件 1 枚で積む。問いは 1 行に収め、溢れたら省略する。 */
.ask-card { display: flex; align-items: center; gap: calc(var(--u) * 3); padding: calc(var(--u) * 2.5) calc(var(--u) * 3); margin-bottom: calc(var(--u) * 2); border-radius: var(--r-lg); background: var(--surface); box-shadow: 0 0 0 1px color-mix(in srgb, var(--waiting) 22%, transparent), 0 6px 16px -10px color-mix(in srgb, var(--waiting) 40%, transparent); }
.ask-body { flex: 1; min-width: 0; }
.ask-title, .ask-q { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ask-title b { font-weight: 600; }
.ask-q { margin-top: 2px; color: var(--ink-2); }
.ask-card .btn { flex: none; }

/* 実行中の札。3 列に並べ、いま何をしているかを墨の地の 1 行で見せる。 */
.live-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: calc(var(--u) * 2.5); }
.live-card { display: flex; flex-direction: column; gap: calc(var(--u) * 1.5); min-width: 0; padding: calc(var(--u) * 2.5) calc(var(--u) * 3); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--surface-shadow); cursor: pointer; transition: box-shadow var(--dur) var(--ease); }
.live-card:hover { box-shadow: var(--surface-shadow), 0 8px 20px -12px rgba(30, 40, 90, 0.25); }
.live-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.live-head { display: flex; align-items: center; gap: calc(var(--u) * 2); min-width: 0; font-weight: 600; }
.live-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-elapsed { flex: none; font-weight: 500; color: var(--ink-2); }
.live-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--ink-3); }
.live-act { padding: calc(var(--u) * 1.5) calc(var(--u) * 2); border-radius: var(--r); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); background: var(--term-bg); color: var(--term-fg); }
.live-act i { font-style: normal; color: var(--term-tool); }
.live-note { color: color-mix(in srgb, var(--term-fg) 60%, var(--term-bg)); }
.live-ctx { display: flex; align-items: center; gap: calc(var(--u) * 1.5); font-size: var(--fs-xs); color: var(--ink-3); }
.live-ctx .gauge-bar { flex: 1; width: auto; }

/* 最近とプロジェクトを 1.6 対 1 で横に並べる。 */
.home-two { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: calc(var(--u) * 2.5); align-items: start; }
.pj-row { display: flex; align-items: center; gap: calc(var(--u) * 2); width: 100%; height: var(--session-row-h); padding: 0 calc(var(--u) * 3); border: 0; border-bottom: 1px solid var(--line); background: none; text-align: left; cursor: pointer; transition: background var(--dur-fast) var(--ease); }
.pj-row:last-child { border-bottom: 0; }
.pj-row:hover { background: color-mix(in srgb, var(--accent) 4%, var(--surface)); }
.pj-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pj-counts { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
/* 点の色はプロジェクトのステータスの色（--st-*）。 */
.pj-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--st-archived); }
.pj-dot[data-status='active'] { background: var(--st-active); }
.pj-dot[data-status='paused'] { background: var(--st-paused); }
.pj-dot[data-status='done'] { background: var(--st-done); }
```

`packages/ui/src/styles/tokens.css` の `--term-fg: #e8e6f0;` の行の直後に、次の 1 行を足す（墨の地の上のツール名の色。試作と同じ杏色）。

```css
  --term-tool: #ffb86b;
```

`packages/ui/src/main.tsx` の `import './styles/rows.css';` の直後に、次の 1 行を足す。

```ts
import './styles/home.css';
```

- [ ] **Step 5: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: PASS、型検査 0 件。`styles/glass.test.ts` も通る（`home.css` にぼかしは無い）。

- [ ] **Step 6: コミット（Task 4 と一緒に）**

```bash
git add packages/ui/src/styles/home.css
git commit packages/ui/src/presenters/home.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/HomeScreen.tsx packages/ui/src/styles/home.css packages/ui/src/styles/tokens.css packages/ui/src/main.tsx packages/ui/src/views/screens.test.tsx -m "$(cat <<'EOF'
feat(ui): rebuild Home as a control panel of what needs you and what is running

Show waiting sessions first with their question and a button that opens
the terminal focused, then running cards with the current tool call and
context gauge, then recent rows beside a small list of active projects.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 1 回目で後に回した 2 件（切断の帯の縮め方、アーティファクトの白い面）

**Files:**
- Modify: `packages/ui/src/styles/base.css`（切断の帯の省略の規則）
- Modify: `packages/ui/src/views/ProjectScreen.tsx`（アーティファクトの `<section>`）
- Modify: `packages/ui/src/styles/workbench.css`（`.rail-panel` のコメントと、面の中のカード）
- Test: `packages/ui/src/styles/glass.test.ts`、`packages/ui/src/views/screens.test.tsx`

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/styles/glass.test.ts` の `describe('骨格', …)` の中の最後に、次の `it` を足す（`all` は同じファイルの先頭で、全部の CSS の規則を選択子と中身の組にしたもの）。

```ts
  // 狭い窓では、何が起きたかの見出しを最後まで残し、次の再接続までの秒数から先に縮める。
  it('切断の帯は、見出しを縮めず、再接続の秒数から先に縮める', () => {
    expect(all.find((r) => r.selector === '.conn-banner > b')?.body).toMatch(/flex: none;/);
    expect(all.find((r) => r.selector === '.conn-banner > .conn-retry')?.body).toMatch(/flex-shrink: 4;/);
  });
```

`packages/ui/src/views/screens.test.tsx` の `'TODO とメモの節は白い面に載る'` の試験を、次に置き換える（直前のコメント行も一緒に置き換える）。

```tsx
  // アーティファクトの節も白い面に載せ、面の中のカードは淡い地で重ねる（見出しと空のときの文が光の上に出ないように）。
  it('TODO、メモ、アーティファクトの節は白い面に載る', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} {...rail} /></IntentRoot>);
    const panels = [...container.querySelectorAll('.rail > .rail-panel')];
    expect(panels.map((p) => p.querySelector('.h2')?.textContent)).toEqual(['TODO', 'メモ', 'アーティファクト']);
  });
```

`packages/ui/src/styles/glass.test.ts` の、読む面の選択子の一覧（`['workbench.css', '.rail-panel']` のある `it.each`）の後に、次の `it` を足す。

```ts
  it('白い面の中のアーティファクトのカードは、淡い地に落として面を重ねない', () => {
    const body = all.find((r) => r.selector === '.rail-panel .artifact')?.body ?? '';
    expect(body).toMatch(/background: var\(--surface-2\);/);
    expect(body).toMatch(/box-shadow: none;/);
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/styles/glass.test.ts packages/ui/src/views/screens.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 切断の帯を直す**

`packages/ui/src/styles/base.css` の、次の 2 行を

```css
/* 幅が足りないときは、折り返して帯の高さを変える代わりに、文言を省略記号で縮める。 */
.conn-banner > b, .conn-banner > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

次の 5 行に置き換える。

```css
/* 幅が足りないときは、折り返して帯の高さを変える代わりに、文言を省略記号で縮める。
   「接続が切れています」の見出しは縮めず、次の再接続までの秒数から先に縮める。
   再接続のボタン（.btn）は flex: none で、どの幅でも押せる。 */
.conn-banner > b, .conn-banner > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conn-banner > b { flex: none; }
.conn-banner > .conn-retry { flex-shrink: 4; }
```

- [ ] **Step 4: アーティファクトを白い面に載せる**

`packages/ui/src/views/ProjectScreen.tsx` の `<section><h2 className="h2">アーティファクト</h2>` を `<section className="rail-panel"><h2 className="h2">アーティファクト</h2>` に変える。

`packages/ui/src/styles/workbench.css` の、次のコメントの 1 行を

```css
/* 右レールの TODO とメモは、白い読む面に載せる。アーティファクトはカードそのものが読む面なので、面を重ねない。 */
```

次に置き換える。

```css
/* 右レールの TODO、メモ、アーティファクトは、白い読む面に載せる。 */
```

同じファイルの `.rail-panel > .h2:first-child { margin-top: 0; }` の直後に、次を足す。

```css
/* 白い面の中のアーティファクトのカードは、淡い地に落として、面の上に面を重ねない。 */
.rail-panel .artifact { background: var(--surface-2); box-shadow: none; }
.rail-panel .artifact:hover { background: color-mix(in srgb, var(--accent) 5%, var(--surface-2)); box-shadow: none; }
```

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck --workspace packages/ui`
Expected: PASS、型検査 0 件。

- [ ] **Step 6: コミット**

```bash
git commit packages/ui/src/styles/base.css packages/ui/src/views/ProjectScreen.tsx packages/ui/src/styles/workbench.css packages/ui/src/styles/glass.test.ts packages/ui/src/views/screens.test.tsx -m "$(cat <<'EOF'
fix(ui): keep the banner's headline on narrow windows and panel the artifacts

Shrink the retry countdown before the "connection lost" headline, and put
the artifact section on the rail's white surface with flat cards inside.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: design.md と仕様を書き換える

**Files:**
- Modify: `docs/design.md`
- Modify: `docs/superpowers/specs/2026-09-29-ui-refresh-design.md`（「データの流れ（新しく足すもの）」）

- [ ] **Step 1: design.md の一覧の密度の文を直す**

`docs/design.md` の `- 一覧は仮想スクロールで描く。1 行 28px の高密度で、100 件を超えても遅くしない。` を、次に置き換える。

```markdown
- 一覧は仮想スクロールで描く。1 行 44px の 2 段の行（1 段目に名前、2 段目に要約の 1 文）で、100 件を超えても遅くしない。
```

同じファイルの `密度は高く、一覧の行高は 28px、カードは 4 列、メインの最大幅は 1200px 前後で中央に寄せる。` を、次に置き換える。

```markdown
一覧の行は 2 段で 44px（`--session-row-h`）、ボタンや入力欄のような 1 段の部品は 28px（`--row-h`）、カードは 4 列、メインの最大幅は 1200px 前後で中央に寄せる。
```

- [ ] **Step 2: Home の節を書き換える**

`docs/design.md` の `### Home` の直後の 4 行（`上から順に、実行中セッションの帯、…` から `プロジェクトのカードは、最後のセッションの要約の 1 文、…「ここで新規」ボタンを持つ。` まで）を、次に置き換える。

```markdown
上から順に、要対応、実行中の札、最近とプロジェクトを置く（管制盤）。
要対応は入力待ち（`waiting`）のセッションを、長く待っている順に 1 件 1 枚の横長の札で出す。
札には名前、プロジェクト、待っている時間、待っている問いの文（取れなければ「入力を待っています」）、「ターミナルで答える」を置く。
「ターミナルで答える」はそのセッションの画面を開いて端末にフォーカスするだけで、その場では答えさせない（端末の TUI を外から操ることになって壊れやすいため）。
実行中は、作業中と休みのセッションと、Claude のレジストリに載る前の run を 3 列の札で出す。
札には名前、経過時間、プロジェクトとモデルと effort、いま何をしているか（最後のツール呼び出しの 1 行を墨の地に）、文脈の使用率のゲージを置き、押すとセッション画面へ移る。
呼び出しがまだ無いときは「作業中」、休みは「休み。最後の返答から N 分」、レジストリに載る前は「起動しています」と出す。
要対応と実行中は、該当が無ければ区画ごと省く。
その下に、最近（幅 1.6）とプロジェクト（幅 1）を横に並べる。
最近は札に出したものを除いた 2 段の行で、右端は時刻だけにする。
プロジェクトは active なプロジェクトの小さな一覧（ステータスの色の点、名前、実行中と TODO と要対応の数のうち 0 でないもの）で、プロジェクトのカードは Projects 画面だけに置く。
```

- [ ] **Step 3: プロジェクト詳細と Sessions の行の文を直す**

`docs/design.md` の `各行には要約の題名と 1 文、状態、モデルと effort、日時、変更ファイル数と行数、PR リンク、推定コストを出し、1 行メモをその場で編集できる。` を、次に置き換える。

```markdown
各行は 2 段で、1 段目に名前、2 段目に要約の 1 文と、あれば 1 行メモ（✎）を出す。
右端にはモデルと effort、変更ファイル数、PR リンク、推定コストを小さな 1 行にまとめ、その下に日時を置く。
1 行メモは `m` か鉛筆のボタンで、その場で編集できる。
```

同じファイルの `結果の行は、プロジェクト詳細のセッション一覧と同じ列を持ち、加えて一致箇所の抜粋を出す。` を、次に置き換える。

```markdown
結果の行は 2 段で、1 段目に名前とプロジェクト名、2 段目に一致箇所の抜粋（最初の 1 つ。一致した語に淡い印）、右端に日時を出す。
検索語が無いときの全件の一覧も同じ形で、2 段目は要約の 1 文になる。
```

- [ ] **Step 4: 実行中のセッションの「いま」を書く**

`docs/design.md` の `### Home` の節の、Step 2 で書いた段落の直後に、次を足す。

```markdown
札の「いま何をしているか」と「待っている問い」は、サーバが索引の追記を読む経路（`indexFile`）で主線の出来事を畳んで取り出す。
最後の `tool_call` の名前と要約を残し、それが AskUserQuestion なら入力の最初の問いの文も残す。
その呼び出しへの `tool_result` が来たら、答えが済んだとして問いを消す。
値は端末ローカルの表 `session_activity`（マイグレーション version 9）に置き、共有テーブルにも同期の changes にも入れない。
`SessionDto.activity`（`{ tool, summary, question }`）は実行中のセッションにだけ載り、呼び出しがまだ無ければ `null` になる。
Home を開いたときにトランスクリプトを読み直すことはしない。
```

- [ ] **Step 5: 仕様の「データの流れ」を実装に合わせる**

`docs/superpowers/specs/2026-09-29-ui-refresh-design.md` の `そこで、サーバが実行中のセッションごとに、正規化したトランスクリプトの末尾から次の 2 つを取り出し、セッションの \`live\` に欄として載せる。` を、次の 2 行に置き換える。

```markdown
そこで、サーバが実行中のセッションごとに、正規化したトランスクリプトの末尾から次の 2 つを取り出し、セッションに欄として載せる。
今の `SessionDto.live` は状態の文字列で欄を足せないので、実装では同じ中身を `SessionDto.activity`（`{ tool, summary, question }`）に載せた（2 回目の計画 `docs/plans/ui-refresh-2-home.md`）。
```

- [ ] **Step 6: 書式を確かめる**

Run: `grep -n "・\|—" docs/design.md docs/superpowers/specs/2026-09-29-ui-refresh-design.md | head`
Expected: この Task で足した行に中黒とダッシュが無い（既存の行に出るものは、この Task で足したものでなければ触らない）。

- [ ] **Step 7: コミット**

```bash
git commit docs/design.md docs/superpowers/specs/2026-09-29-ui-refresh-design.md -m "$(cat <<'EOF'
docs: describe the control-panel Home, two-line rows, and session activity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 全体を通して、実物で確かめる

**Files:** なし（確かめるだけ。直すところが見つかったら、その規則を持つ Task のファイルを直し、同じ作法でコミットする）

- [ ] **Step 1: 試験と型検査を全部通す**

Run: `npm test && npm run typecheck`
Expected: 全部の試験が PASS、型検査 0 件。
落ちた試験があれば、試験を緩めずに原因を直す。

- [ ] **Step 2: 3 つのビルドを通す**

```bash
npm run build
npm run bundle-server --workspace apps/desktop
npm run tauri --workspace apps/desktop -- build
```

Expected: 3 つとも成功する。
`tauri build` は時間がかかるので background で回し、終わりを待ってから次へ進む。

- [ ] **Step 3: 古い .app と利用者の dev サーバを止める**

`pgrep -fl "target/release/bundle/macos/Hangar.app"` で、ビルドした `.app` から起きたプロセスを探す。
あれば、`ps -o command= -p <PID>` でパスが `/Users/me/workspace/agent-hangar/apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` の下だと確かめてから、その PID だけを止める。
次に `lsof -nP -iTCP:4177 -sTCP:LISTEN -t` で PID を採り、`ps -o command= -p <PID>` で `packages/server` の tsx のサーバだと確かめたときだけ止める。
ほかのもの（`/Applications/Hangar.app` のサーバなど）が 4177 にいれば、止めずに報告する。
止めたものと、利用者が `npm run dev` を立て直す必要があるかを、報告に 1 行で書く。

- [ ] **Step 4: 利用者に確かめてもらう**

画面を目で見る確認は、利用者にお願いする（合成したマウス操作では窓を動かせず、画面の範囲の写しには別の窓が写り込むため）。
次の一覧を報告に載せる。

1. Home：入力待ちのセッションがあるとき、要対応の札に問いの文が出て、「ターミナルで答える」でその端末に入力できる状態で開く。
2. Home：実行中の札に、いま呼んでいるツールと対象が出て、ツールを呼ぶたびに変わる。休みの札は「休み。最後の返答から N 分」になる。
3. Home：AskUserQuestion に端末で答えると、要対応の札が消える（実行中の札に戻る）。
4. Home：最近とプロジェクトが横に並び、プロジェクトの数が合っている。
5. プロジェクト詳細：行が 2 段で、右にモデル、変更、PR、コストと時刻が出る。`m` でメモを直せる。
6. Sessions：検索すると、2 段目に一致箇所が淡い印つきで出る。
7. `j` と `k` で行を選び、Enter で開ける（Home の最近、プロジェクト詳細、Sessions）。
8. 窓を狭くしても、切断の帯の「接続が切れています」と再接続のボタンが残る（切断の帯は、サーバを止めると出る）。
9. プロジェクト詳細の右レールで、アーティファクトの節が白い面に載っている。

`/Applications/Hangar.app` を入れ替えるかどうかは、利用者に確かめてから行う。
`main` に入れるかどうかも、利用者の確認を待つ。

---

## 自己点検の記録

- 仕様の Home（要対応、実行中の札、最近、プロジェクト、区画の省き方）は Task 4 と Task 5。「ターミナルで答える」は Task 2 と Task 5。
- 仕様のデータの流れ（最新のツール呼び出し、待っている問い、取れないとき、追記の経路で取り出す、同期に入れない）は Task 1。欄の置き場所の違い（`live` ではなく `activity`）は Global Constraints に書き、Task 7 で仕様を直す。
- 仕様の一覧の行（44px、画面ごとの右端と 2 段目、`rowHeight` の見積もり、キー操作）は Task 3。Settings の使用量の表は触らない。
- 仕様の「足す試験」のうち、この回の分は、Home の Presenter（Task 4）、サーバの取り出し（Task 1）、行の高さ（Task 3）。
- 1 回目で後に回した、切断の帯の省略と、右レールのアーティファクトは Task 6。
- 名前の一致：`SessionActivityDto`、`activity`、`foldActivity`、`firstQuestion`、`session_activity`、`focusOnOpen`、`markTerms`、`Segment`、`excerpt`、`RowVariant`、`SESSION_ROW_H`、`--session-row-h`、`AttentionCard`、`RunningCard`、`ProjectMini`、`HomeProps` は、定義した Task と使う Task で同じ綴り。
- Task 4 はコミットを Task 5 と一緒にする（Presenter の型が変わると、同じコミットで画面を直さない限り型検査が落ちるため）。
