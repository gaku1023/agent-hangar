# セッションの状態 第 1 段「データと入口」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セッションに Paused・Done・Archived の状態と Claude の提案を持たせ、表・マイグレーション・状態の移り方・同期・MCP・HTTP と、一覧の行の札・「⋯」の 4 択・Paused の入力・提案のポップまでを入れる。

**Architecture:** 状態は新しい共有テーブル `session_states`（マイグレーション v13）に置き、`sessions` の行には足さない。状態の移り方はサーバの `sessions/states.ts` の純粋な関数群にまとめ、MCP・HTTP・索引はそれを呼ぶだけにする。画面は `SessionDto.state` を `SessionRowProps` に写し、行の右端に札と「⋯」、2 段目の頭に戻る日の札を描く。変更のたびに `session.upsert` を配り、画面の正はその配信にする。

**Tech Stack:** TypeScript、better-sqlite3、Hono、@modelcontextprotocol/sdk と zod、React 19、Vitest 5（node と jsdom）、Cloudflare Workers（miniflare の試験）、Tauri v2。

**Spec:** `docs/superpowers/specs/2026-10-01-session-status-design.md`（3 段で共有する名前と型は `docs/superpowers/plans/2026-10-01-session-status-contract.md`。名前と型はここから変えない）。見た目の試作は `docs/superpowers/specs/2026-10-01-session-status/model-v3.html` と `rest.html`。

コマンドはすべて worktree の根 `/Users/me/workspace/agent-hangar/.claude/worktrees/session-status` で打つ。

## Global Constraints

- 状態は次の 5 つ。印なし（既定）・Active（自動で、持たずに毎回出す）・Paused・Done・Archived。語はプロジェクトの状態と同じ英語にする。
- 削除は作らない。hangar は利用者のファイルを消さない。
- 古いものを自動で Archived にする規則は作らない。推定で状態を付けることはしない。
- resume して利用者が新しく発言したら、状態と提案を外して印なしに戻す。AskUserQuestion への答えはツールの結果なので、状態を外さない。
- 導入のときに、既存のセッションをまとめて Done にする。この行は変更ログ（`changes`）に積まない。
- 戻る日は日付だけで持つ（`YYYY-MM-DD` の形の手元の暦の日付）。「今日の夕方」と「明日の朝」は、それぞれ今日と明日として扱う。
- `note`：Paused の理由（200 字まで）。提案では 1 字以上が必須。
- `rejected_at` は DTO に載せない。判定はサーバの中だけで行う。
- 古いサーバから来た `SessionDto` は `state` を欠くので、印なしとして扱う。
- 同期で届いた行が `status` と `candidate_*` を両方持っていたら、読むときは状態を正とし、提案はないものとする（書き直しはしない）。
- 索引は `session_states` を書かない（新しい発言で外すときだけ書く）。
- HTTP の 3 つ（PUT state・confirm・reject）は MCP からは呼べない。409 と 400 の本文は、トーストにそのまま出せる日本語の一文にする。
- MCP の `propose_session_status` の説明文：「このセッションの状態（Done か Paused）を提案する。利用者が会話の中で選んだときだけ confirmed を true にする。利用者に聞かずに true にしてはいけない。」
- 状態の色は既存のトークン（`--st-*`）を使う。提案は `--cand` を使う。塗りの戻る日の札は地が `--st-paused`、文字が白で、4.5 : 1 を超えることを試験で確かめる。UI は常にライトで、ダークモードは作らない。
- 返答・文書・コメントは日本語、コードの識別子は英語。コメントの密度と書きぶりは周りに合わせる。
- 試験は実物の `~/.claude` と `~/.agent-hangar` に触らない。秘密（トークン、参加の秘密）は argv にもログにも出さない。
- プロセスはポート番号で止めない。止めるのは自分が起こした PID だけ。利用者は自分で `npm run dev` を動かしている。
- 古い Worker は知らない表を含む push の束を丸ごと 400 で断る（`packages/cloud/src/changes.ts:184` の `isChange`）。新しい版を本物の DB と同期で動かす前に、Worker を配備する（Task 16）。
- commit はパスを指定する形（`git commit <path>...`）にする。`git add` は新しく作ったファイルにだけ使う。末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

1. **後から上げた PC の一括 Done が、先に上げた PC で付けた状態を潰さないこと。** 1 台目で v13 に上げて Paused を付けたあと 2 台目を上げると、2 台目の一括 Done の行の方が `updated_at` が新しくなり、届いた Paused を後勝ちで捨てる。一括 Done の行は `updated_at` を 0 にする（Task 3 の試験、Task 7 の試験）。
2. **状態も提案も無いセッションで、発言のたびに `session_states` へ書かないこと。** 書けば発言ごとに D1 の行を使い、無料枠（9/30 に 80% で同期が止まった）を食う（Task 4 と Task 5 の試験）。
3. **索引の作り直し（版上げ、本文の作り直し）で、一括 Done や付けた状態が外れないこと。** 作り直しは前からある発言を全部読み直す（Task 5 の試験）。
4. **理由の字数を文字単位で数えること。** UTF-16 の長さで数えると、絵文字 100 字で 200 字の上限に当たる。改行は 1 つの空白にたたむ（Task 4 と Task 14 の試験）。
5. **Paused の入力で、理由の欄に打った数字や変換中の Enter が、札を切り替えたり送ったりしないこと**（Task 14 の試験）。

---

### Task 1: 利用者が打った発言の見分け

`event_index` の `kind='user'` に、利用者が打った発言以外のものが入っていないかを確かめ、入っていれば除く条件を 1 つの関数にする。
2026-10-01 に手元の直近 10 日の主線 86 本を読んだ結果は次のとおりで、AskUserQuestion の答えは入らないが、要約で続けた会話の頭と中断の印は `kind='user'` に入る。

- AskUserQuestion の答え 327 件は、どれも `tool_result` だけで `text` を持たない（`kind='tool_result'` になる）。
- `isCompactSummary: true` の記録（「This session is being continued from a previous conversation…」）は、本文が文字列なので `kind='user'` になり、`isUserTurn` も真になる。
- `[Request interrupted by user]` と `[Request interrupted by user for tool use]` は `kind='user'` になり、`isUserTurn` も真になる。
- `isMeta` とコマンドの記録（`<command-name>` など）は、すでに `system` になっている。

**Files:**
- Modify: `packages/server/src/provider/claude-code/normalize.ts:148-177`（`recordFacts` の後ろに足す）
- Test: `packages/server/src/provider/claude-code/normalize.test.ts`（末尾に describe を足す）

**Interfaces:**
- Consumes: なし
- Produces: `export function isTypedPrompt(raw: unknown, facts?: RecordFacts): boolean`（Task 5 が索引から使う）

- [ ] **Step 1: 手元の transcript で、kind='user' に入るものを確かめる（読むだけ）**

作業用の一時ディレクトリ（セッションの scratchpad。無ければ `mktemp -d`）に `scan-user.mjs` を書く。

```js
import fs from 'node:fs';
import path from 'node:path';
// 読むだけ。~/.claude/projects の直近 10 日の主線を舐め、user の記録の種類と AskUserQuestion の答えの形を数える。
const root = path.join(process.env.HOME, '.claude', 'projects');
const files = [];
for (const d of fs.readdirSync(root)) {
  const dir = path.join(root, d);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl') && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < 10 * 86400000) files.push(path.join(dir, f));
}
const out = { files: files.length, askCalls: 0, answers: 0, answersWithText: 0, textWithToolResult: 0, compactSummary: 0, interrupt: 0 };
for (const f of files) {
  const ask = new Set();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const c = r.message?.content;
    if (r.type === 'assistant' && Array.isArray(c)) for (const b of c) if (b?.type === 'tool_use' && b.name === 'AskUserQuestion') { ask.add(b.id); out.askCalls++; }
    if (r.type !== 'user' || r.isMeta === true) continue;
    if (r.isCompactSummary === true) out.compactSummary++;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text) : [];
    if (texts.join('\n').trimStart().startsWith('[Request interrupted by user')) out.interrupt++;
    if (!Array.isArray(c)) continue;
    const hasResult = c.some((b) => b?.type === 'tool_result');
    if (hasResult && texts.length > 0) out.textWithToolResult++;
    if (c.some((b) => b?.type === 'tool_result' && ask.has(b.tool_use_id))) { out.answers++; if (texts.length > 0) out.answersWithText++; }
  }
}
console.log(out);
```

Run: `node <一時ディレクトリ>/scan-user.mjs`
Expected: `answersWithText: 0` と `textWithToolResult: 0`。`compactSummary` と `interrupt` は 1 以上（2026-10-01 の実測は 9 と 43）。
`answersWithText` か `textWithToolResult` が 1 以上なら、ここで止めて報告する。そのときは「`tool_result` を含む user の記録は発言に数えない」という条件を足す必要があり、この計画の Step 3 の関数を直してから進める。

- [ ] **Step 2: 失敗する試験を書く**

`packages/server/src/provider/claude-code/normalize.test.ts` の 2 行目の import に `isTypedPrompt` を足す。

```ts
import { indexTexts, isTypedPrompt, normalizeRecord, recordFacts, toolSummary } from './normalize.ts';
```

末尾に足す。

```ts
describe('isTypedPrompt', () => {
  const user = (content: unknown, over: Record<string, unknown> = {}) => ({ ...base, type: 'user', message: { role: 'user', content }, ...over });
  it('打った発言と、作業中に打って積まれた指示は true', () => {
    expect(isTypedPrompt(user('直して'))).toBe(true);
    expect(isTypedPrompt(user([{ type: 'text', text: 'これも' }, { type: 'image', source: {} }]))).toBe(true);
    expect(isTypedPrompt({ ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: '続けて' } })).toBe(true);
  });
  it('AskUserQuestion の答え（ツールの結果）は false', () => {
    expect(isTypedPrompt(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'User has answered your questions: "このセッションをどうしますか"="Done にする".' }]))).toBe(false);
  });
  it('要約で続けた会話の頭、中断の印、meta、コマンドの記録、assistant は false', () => {
    expect(isTypedPrompt(user('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }))).toBe(false);
    expect(isTypedPrompt(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toBe(false);
    expect(isTypedPrompt(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toBe(false);
    expect(isTypedPrompt(user('<caveat/>', { isMeta: true }))).toBe(false);
    expect(isTypedPrompt(user('<command-name>/clear</command-name>'))).toBe(false);
    expect(isTypedPrompt({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'はい' }] } })).toBe(false);
  });
  it('すでに読んだ facts を渡せる。渡した facts を信じる', () => {
    const raw = user('直して');
    expect(isTypedPrompt(raw, recordFacts(raw))).toBe(true);
    expect(isTypedPrompt(raw, { isUserTurn: false })).toBe(false);
  });
});
```

- [ ] **Step 3: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/normalize.test.ts`
Expected: FAIL（`isTypedPrompt is not a function` か、import の解決の失敗）

- [ ] **Step 4: 実装する**

`packages/server/src/provider/claude-code/normalize.ts` の `recordFacts`（148-177 行）の直後に足す。

```ts
/** 中断の印。Esc で止めたとき、Claude Code が user の本文として書く（[Request interrupted by user] と [… for tool use]）。 */
const INTERRUPT_MARK = '[Request interrupted by user';

/**
 * 利用者がいま打った発言か。セッションの状態を外す合図に使う（sessions/states.ts の clearOnNewPrompt）。
 * isUserTurn より狭く、次の 2 つを外す。どちらも Claude Code が本文付きの user として書くが、利用者が打ったものではない。
 * - 要約で続けた会話の頭（isCompactSummary）。自動の要約は作業の途中でも起きる。
 * - 中断の印（[Request interrupted by user …]）。
 * ツールの結果（AskUserQuestion の答えを含む）は text を持たないので、isUserTurn の時点で外れている。
 * これを数え違えると、会話で Done を選んだ直後に状態が外れてしまう。
 */
export function isTypedPrompt(raw: unknown, facts: RecordFacts = recordFacts(raw)): boolean {
  if (!facts.isUserTurn || !isRec(raw)) return false;
  if (raw.isCompactSummary === true) return false;
  // 作業中に打って積まれた指示（queued_command）は本文を attachment に持つ。中断の印はそこには来ない。
  if (raw.type !== 'user') return true;
  const msg = isRec(raw.message) ? raw.message : null;
  return !contentText(msg?.content).trimStart().startsWith(INTERRUPT_MARK);
}
```

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/normalize.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git commit packages/server/src/provider/claude-code/normalize.ts packages/server/src/provider/claude-code/normalize.test.ts -m "feat(server): tell typed prompts from compact summaries and interrupts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: shared の状態の型と日付の関数

**Files:**
- Create: `packages/shared/src/sessionState.ts`
- Create: `packages/shared/src/sessionState.test.ts`
- Modify: `packages/shared/src/index.ts:1-10`（再輸出を足す）
- Modify: `packages/shared/src/api.ts:1-3`（import）、`packages/shared/src/api.ts:22`（`SessionDto` に `state` を足す）

**Interfaces:**
- Consumes: なし
- Produces（契約のまま）:
  - `type SessionStatus = 'paused' | 'done' | 'archived'`
  - `type StateSetBy = 'user' | 'conversation' | 'import'`
  - `type CandidateSource = 'in_session' | 'exit' | 'post_hoc'`
  - `type SessionCandidateDto = { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; at: number }`
  - `type SessionStateDto = { status: SessionStatus | null; note: string | null; returnOn: string | null; setBy: StateSetBy | null; setAt: number | null; candidate: SessionCandidateDto | null }`
  - `const STATE_NOTE_MAX = 200`
  - `isReturnOn(s: string): boolean`、`localDate(now: number): string`、`addDays(date: string, n: number): string`、`overdueDays(returnOn: string, now: number): number | null`
  - `SessionDto.state?: SessionStateDto | null`

- [ ] **Step 1: 失敗する試験を書く**

`packages/shared/src/sessionState.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { addDays, isReturnOn, localDate, overdueDays, STATE_NOTE_MAX } from './sessionState.ts';

/** 手元の暦の時刻。試験を走らせる機械のタイムゾーンによらず、同じ日付になる。 */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('isReturnOn', () => {
  it('YYYY-MM-DD の形で、暦にある日だけを通す', () => {
    expect(isReturnOn('2026-10-02')).toBe(true);
    expect(isReturnOn('2028-02-29')).toBe(true);
    for (const s of ['2026-02-29', '2026-13-01', '2026-10-32', '2026-00-10', '2026-1-2', '2026/10/02', '20261002', ' 2026-10-02', '2026-10-02T00:00', '']) {
      expect(isReturnOn(s), s).toBe(false);
    }
  });
});

describe('localDate', () => {
  it('手元の暦の日付を返す。夜中の 0 時の前後で日が変わる', () => {
    expect(localDate(at(2026, 10, 1, 23, 59))).toBe('2026-10-01');
    expect(localDate(at(2026, 10, 2, 0, 0))).toBe('2026-10-02');
    expect(localDate(at(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('addDays', () => {
  it('月と年をまたぎ、負の日数も足せる', () => {
    expect(addDays('2026-10-01', 1)).toBe('2026-10-02');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-10-01', 7)).toBe('2026-10-08');
    expect(addDays('2026-10-01', 0)).toBe('2026-10-01');
  });
  it('形の違う日付は投げる', () => {
    expect(() => addDays('2026/10/01', 1)).toThrow();
  });
});

describe('overdueDays', () => {
  it('今日なら 0、過ぎていれば日数、先なら null', () => {
    const now = at(2026, 10, 1, 9);
    expect(overdueDays('2026-10-01', now)).toBe(0);
    expect(overdueDays('2026-09-28', now)).toBe(3);
    expect(overdueDays('2026-10-02', now)).toBeNull();
  });
  it('夏時間のある地域でも、日の数え方が 1 日ずれない', () => {
    // 手元の暦の日付どうしを UTC の 0 時に置いて引くので、23 時間や 25 時間の日があっても割り切れる。
    expect(overdueDays('2026-01-01', at(2026, 7, 1))).toBe(181);
  });
  it('形の違う日付は先の日と同じに扱う（今日戻るに出さない）', () => {
    expect(overdueDays('いつか', at(2026, 10, 1))).toBeNull();
  });
  it('理由の上限は 200 字', () => {
    expect(STATE_NOTE_MAX).toBe(200);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/shared/src/sessionState.test.ts`
Expected: FAIL（`./sessionState.ts` が見つからない）

- [ ] **Step 3: 実装する**

`packages/shared/src/sessionState.ts`

```ts
/**
 * セッションの状態（Paused・Done・Archived）と Claude の提案。
 * 設計は docs/superpowers/specs/2026-10-01-session-status-design.md。サーバと UI が同じ型と日付の数え方を使う。
 * 印なし（既定）は status の null で表す。Active は持たず、動きから毎回出す。
 */
export type SessionStatus = 'paused' | 'done' | 'archived';
/** 誰が付けたか。user は hangar の画面か claude.zsh、conversation は会話の中で利用者が選んだもの、import は導入時の一括。 */
export type StateSetBy = 'user' | 'conversation' | 'import';
/** 提案の出どころ。会話の中、claude.zsh で抜けるとき、事後の要約。 */
export type CandidateSource = 'in_session' | 'exit' | 'post_hoc';
export type SessionCandidateDto = { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; at: number };
export type SessionStateDto = { status: SessionStatus | null; note: string | null; returnOn: string | null; setBy: StateSetBy | null; setAt: number | null; candidate: SessionCandidateDto | null };
/** 理由と根拠の上限。字数は文字単位（Array.from）で数える。 */
export const STATE_NOTE_MAX = 200;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD を UTC の 0 時の時刻にする。形が違えば NaN。 */
function utcOf(date: string): number {
  const m = DATE_RE.exec(date);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
}
const fmtUtc = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** YYYY-MM-DD の形で、暦に実在する日なら true。2 月 30 日のように繰り上がる日は断る。 */
export function isReturnOn(s: string): boolean {
  const t = utcOf(s);
  return Number.isFinite(t) && fmtUtc(t) === s;
}

/** 手元の暦の日付（YYYY-MM-DD）。 */
export function localDate(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD に n 日足した日付。日付どうしの計算なので UTC の 0 時に置いて足し、夏時間の 1 時間に引きずられない。 */
export function addDays(date: string, n: number): string {
  const t = utcOf(date);
  if (!Number.isFinite(t)) throw new Error(`日付の形が違います: ${date}`);
  return fmtUtc(t + n * DAY_MS);
}

/** 戻る日が今日か過ぎていれば、過ぎた日数（今日なら 0）。先なら null。形の違う日付も null にする。 */
export function overdueDays(returnOn: string, now: number): number | null {
  const t = utcOf(returnOn);
  if (!Number.isFinite(t)) return null;
  const days = Math.round((utcOf(localDate(now)) - t) / DAY_MS);
  return days >= 0 ? days : null;
}
```

`packages/shared/src/index.ts` の末尾（10 行目の後ろ）に足す。

```ts
export * from './sessionState.ts';
```

`packages/shared/src/api.ts` の 3 行目の後ろに import を足す。

```ts
import type { SessionStateDto } from './sessionState.ts';
```

`packages/shared/src/api.ts:22` の `SessionDto` の末尾の `activity?: SessionActivityDto | null` の後ろに足す（1 行の型のまま）。

```ts
; state?: SessionStateDto | null
```

つまり 22 行目は `... transcriptMtime: number | null; activity?: SessionActivityDto | null; state?: SessionStateDto | null };` になる。直前の行にコメントを足す。

```ts
/** state はセッションの状態と提案。古いサーバからは欠けるので任意にし、欠けたものと null は印なしとして読む。 */
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/shared/src/sessionState.test.ts && npm run typecheck --workspace packages/shared`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/sessionState.ts packages/shared/src/sessionState.test.ts
git commit packages/shared/src/sessionState.ts packages/shared/src/sessionState.test.ts packages/shared/src/index.ts packages/shared/src/api.ts -m "feat(shared): add session state types and calendar-date helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: マイグレーション v13 と共有テーブルの一覧

**Files:**
- Modify: `packages/server/src/db/migrations.ts:280-293`（version 12 の後ろに version 13 を足す）
- Modify: `packages/shared/src/cloud.ts:2-10`（`SharedTable`、`SHARED_TABLES`、`TABLE_PK`）
- Modify: `packages/shared/src/cloud.test.ts:30-35`
- Test: `packages/server/src/db/db.test.ts:42`（表の一覧）と末尾に describe を足す

**Interfaces:**
- Consumes: なし
- Produces: 表 `session_states`（列は仕様のとおり）。`SHARED_TABLES` の `'session_summaries'` の直後に `'session_states'`、`TABLE_PK.session_states = 'session_id'`。一括 Done の行は `status='done'`、`set_by='import'`、`set_at=<秒の精度の今>`、`updated_at=0`、`origin_device='import'`。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/db/db.test.ts:42` の表の一覧の配列の末尾に `'session_states'` を足す。

```ts
    for (const t of ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'todos', 'project_memos', 'artifacts', 'artifact_versions', 'takeover_requests', 'changes', 'transcript_files', 'event_index', 'event_fts', 'session_stats', 'usage_snapshots', 'sync_state', 'settings_local', 'mcp_secrets', 'schema_migrations', 'session_activity', 'session_states']) {
```

`packages/server/src/db/db.test.ts` の末尾に足す。

```ts
describe('version 13 のセッションの状態', () => {
  it('表を作り、生きているセッションだけを Done にし、changes には積まない', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mig13-'));
    const file = path.join(tmp, 'hangar.db');
    openDbAt(file, 12);
    const old = new Database(file);
    const ins = old.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, deleted_at, origin_device) values (?, 'claude-code', ?, '/w', 'd', 1, ?, 'd')");
    ins.run('s1', 'u1', null);
    ins.run('s2', 'u2', null);
    ins.run('gone', 'u3', 5);
    old.close();
    const before = Math.floor(Date.now() / 1000) * 1000;
    const db = openDb(file);
    const rows = db.prepare('select session_id, status, note, return_on, set_by, set_at, candidate_at, rejected_at, updated_at, deleted_at, origin_device from session_states order by session_id').all() as Record<string, unknown>[];
    // 削除済みのセッションには行を作らない。
    expect(rows.map((r) => r.session_id)).toEqual(['s1', 's2']);
    for (const r of rows) {
      // updated_at を 0 にするのは、先に上げた PC で付けた状態が、後から上げた PC の一括 Done に後勝ちで負けないようにするためである。
      expect(r).toMatchObject({ status: 'done', note: null, return_on: null, set_by: 'import', candidate_at: null, rejected_at: null, updated_at: 0, deleted_at: null, origin_device: 'import' });
      expect(r.set_at as number).toBeGreaterThanOrEqual(before);
      expect(r.set_at as number).toBeLessThanOrEqual(Date.now());
    }
    // 各 PC が自分のマイグレーションで同じ行を作るので、送らない。
    expect(db.prepare("select count(*) c from changes where table_name = 'session_states'").get()).toEqual({ c: 0 });
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it('空の DB から作っても行は無く、状態と書き手の検査が効く', () => {
    const db = openDb(':memory:');
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s1', 'claude-code', 'u1', '/w', 'd', 1, 'd')").run();
    expect(() => db.prepare("insert into session_states (session_id, status, updated_at, origin_device) values ('s1', 'active', 1, 'd')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("insert into session_states (session_id, set_by, updated_at, origin_device) values ('s1', 'claude', 1, 'd')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("insert into session_states (session_id, candidate_status, updated_at, origin_device) values ('s1', 'archived', 1, 'd')").run()).toThrow(/CHECK/);
    // 外部キーで、無いセッションの行は作れない。
    expect(() => db.prepare("insert into session_states (session_id, updated_at, origin_device) values ('nope', 1, 'd')").run()).toThrow(/FOREIGN KEY/);
  });
});
```

`packages/shared/src/cloud.test.ts:30-35` の試験を差し替える。

```ts
  it('共有テーブルの主キーは session_summaries と session_states と project_memos だけが違う', () => {
    expect(SHARED_TABLES).toHaveLength(13);
    expect(TABLE_PK.session_summaries).toBe('session_id');
    expect(TABLE_PK.session_states).toBe('session_id');
    expect(TABLE_PK.project_memos).toBe('project_id');
    expect(TABLE_PK.runs).toBe('id');
  });
  it('session_states は session_summaries の直後に適用する（親の sessions より後）', () => {
    expect(SHARED_TABLES.indexOf('session_states')).toBe(SHARED_TABLES.indexOf('session_summaries') + 1);
    expect(SHARED_TABLES.indexOf('session_states')).toBeGreaterThan(SHARED_TABLES.indexOf('sessions'));
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/db/db.test.ts packages/shared/src/cloud.test.ts`
Expected: FAIL（`no such table: session_states`、`expected 12 to be 13`）

- [ ] **Step 3: 実装する**

`packages/server/src/db/migrations.ts` の version 12 の要素（280-292 行）の閉じ `},` の後ろ、配列の閉じ `];` の前に足す。

```ts
  {
    // セッションの状態（Paused・Done・Archived）と Claude の提案。設計は docs/superpowers/specs/2026-10-01-session-status-design.md。
    // sessions に列を足さないのは、sessions の行が索引のたびに全列で書き直され（indexFile の applySessionFacts）、
    // 同期が行ごとの後勝ちなので、別の PC で付けた状態が、本文を持つ PC の索引で上書きされるからである。
    // 共有テーブルなので同期に載る。D1 は行を JSON のまま持つので、クラウド側のマイグレーションは要らない。
    //
    // 導入のときに、生きているセッションをまとめて Done にする（利用者の決定）。
    // この行は changes に積まない。各 PC が自分のマイグレーションで同じ行を作るので、送る必要が無い。
    // 1,221 行を D1 へ送ると、無料枠の書き込みを無駄に使う。
    // updated_at は 0 にする。先に上げた PC で利用者が付けた状態が、後から上げた PC の一括 Done に後勝ちで負けないようにするためである。
    // origin_device は、端末の id を DB から読めないので（version 8 の注記と同じ）'import' と書く。
    // set_at は秒の精度の今で、これより前の発言では状態を外さない（sessions/states.ts の clearOnNewPrompt）。
    version: 13,
    sql: `
create table session_states (
  session_id text primary key references sessions(id),
  status text check (status in ('paused','done','archived')),
  note text,
  return_on text,
  set_by text check (set_by in ('user','conversation','import')),
  set_at integer,
  candidate_status text check (candidate_status in ('paused','done')),
  candidate_note text,
  candidate_return_on text,
  candidate_source text check (candidate_source in ('in_session','exit','post_hoc')),
  candidate_at integer,
  rejected_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
insert into session_states (session_id, status, set_by, set_at, updated_at, origin_device)
  select id, 'done', 'import', cast(strftime('%s', 'now') as integer) * 1000, 0, 'import' from sessions where deleted_at is null;
`,
  },
```

`packages/shared/src/cloud.ts:2-10` を差し替える。

```ts
export type SharedTable = 'devices' | 'projects' | 'project_roots' | 'sessions' | 'runs' | 'run_tabs' | 'session_summaries' | 'session_states' | 'todos' | 'project_memos' | 'artifacts' | 'artifact_versions' | 'takeover_requests';

/**
 * 親から子の順。pull の適用はこの順に並べ替えて外部キーの順序違反を避ける。
 * Worker（packages/cloud/src/changes.ts）はこの一覧に無い表の変更を含む push を断るので、表を足したら Worker も配備し直す。
 */
export const SHARED_TABLES: readonly SharedTable[] = ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'session_states', 'todos', 'project_memos', 'artifacts', 'artifact_versions', 'takeover_requests'];

export const TABLE_PK: Record<SharedTable, string> = {
  devices: 'id', projects: 'id', project_roots: 'id', sessions: 'id', runs: 'id', run_tabs: 'id',
  session_summaries: 'session_id', session_states: 'session_id', todos: 'id', project_memos: 'project_id', artifacts: 'id', artifact_versions: 'id', takeover_requests: 'id',
};
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/server/src/db/db.test.ts packages/shared/src/cloud.test.ts packages/server/src/sync/apply.test.ts packages/cloud/test/changes.test.ts && npm run typecheck`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git commit packages/server/src/db/migrations.ts packages/server/src/db/db.test.ts packages/shared/src/cloud.ts packages/shared/src/cloud.test.ts -m "feat(server): add session_states (migration 13) with a one-time Done import" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 状態の移り方（sessions/states.ts）

仕様の「状態の移り方」の表の 7 つの操作を、1 つのファイルの関数にする。

**Files:**
- Create: `packages/server/src/sessions/states.ts`
- Create: `packages/server/src/sessions/states.test.ts`

**Interfaces:**
- Consumes: Task 2 の型と `isReturnOn`・`STATE_NOTE_MAX`。Task 3 の表。`upsertShared(db, table, row, deviceId, pk)`（`packages/server/src/db/shared.ts`）
- Produces（契約のまま）:
  - `class StateInputError extends Error`
  - `getSessionState(db: Db, sessionId: string): SessionStateDto | null`
  - `setSessionState(db, deviceId, sessionId, o: { status: SessionStatus | null; note?: string | null; returnOn?: string | null; setBy: 'user' | 'conversation'; now?: number }): SessionStateDto`
  - `type ProposeStateOutcome = 'proposed' | 'set' | 'rejected_before' | 'already_set'`
  - `proposeSessionState(db, deviceId, sessionId, o: { status: 'paused' | 'done'; note: string; returnOn: string | null; source: CandidateSource; now?: number }): { state: SessionStateDto; outcome: Exclude<ProposeStateOutcome, 'set'> }`
  - `confirmSessionState(db, deviceId, sessionId, o?: { returnOn?: string; now?: number }): { state: SessionStateDto; result: 'confirmed' | 'not_candidate' }`
  - `rejectSessionState(db, deviceId, sessionId, now?: number): { state: SessionStateDto; result: 'rejected' | 'not_candidate' }`
  - `clearOnNewPrompt(db, deviceId, sessionId, promptTs: number): boolean`
- Produces（契約に足すもの）:
  - `type StateCols`（DTO に写すのに要る 10 列）と `toStateDto(r: StateCols): SessionStateDto`（Task 6 の `toSessionDto` が使う）
  - `NO_STATE: SessionStateDto`（行の無いセッションの状態）

決めたこと（仕様が書いていない所）:
- 状態が付いているセッションへの提案は、同じ状態でも違う状態でも書かずに `already_set` を返す。読むときに状態を正とするので、書いても見えない提案になるためである。結果の `state` で今の状態が分かる。
- Done と Archived は戻る日を持たない（渡されても捨てる）。
- 印なしに戻しても `rejected_at` は残す（却下は新しい発言まで効く）。
- 理由は前後の空白を落とし、改行を含む空白の並びを 1 つの空白にたたむ（1 行の欄で見せるため）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/sessions/states.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { clearOnNewPrompt, confirmSessionState, getSessionState, NO_STATE, proposeSessionState, rejectSessionState, setSessionState, StateInputError } from './states.ts';

function seed() {
  const db = openDb(':memory:');
  // session_states.session_id は sessions(id) への外部キーなので、紐付ける先を実際に作っておく。
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'd' }, 'd');
  return db;
}
type Db = ReturnType<typeof seed>;
const row = (db: Db) => db.prepare('select status, note, return_on, set_by, set_at, candidate_status, candidate_note, candidate_return_on, candidate_source, candidate_at, rejected_at from session_states where session_id = ?').get('s1');
/**
 * 最後に積んだ変更の連番。書いたかどうかはこれで見る。
 * 件数では見られない。未送信の差分は同じ行ごとに 1 つへまとまる（db/shared.ts の dropUnpushed）ので、書き直しても件数は変わらない。
 */
const lastSeq = (db: Db) => (db.prepare("select max(seq) s from changes where table_name = 'session_states'").get() as { s: number | null }).s;
const paused = { status: 'paused' as const, note: '明日の朝 CPU の数字を見る', returnOn: '2026-10-02', source: 'in_session' as const };

describe('提案する', () => {
  it('提案も却下も無ければ候補を埋め、状態は書かない', () => {
    const db = seed();
    expect(getSessionState(db, 's1')).toBeNull();
    const r = proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    expect(r).toEqual({ outcome: 'proposed', state: { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: { status: 'paused', note: '明日の朝 CPU の数字を見る', returnOn: '2026-10-02', source: 'in_session', at: 100 } } });
    expect(row(db)).toEqual({ status: null, note: null, return_on: null, set_by: null, set_at: null, candidate_status: 'paused', candidate_note: '明日の朝 CPU の数字を見る', candidate_return_on: '2026-10-02', candidate_source: 'in_session', candidate_at: 100, rejected_at: null });
    expect(lastSeq(db)).not.toBeNull();
  });
  it('提案があるところへの提案は上書きする。Done の提案は戻る日を持たない', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const r = proposeSessionState(db, 'd', 's1', { status: 'done', note: '直して main に入れた', returnOn: '2026-10-02', source: 'post_hoc', now: 200 });
    expect(r.outcome).toBe('proposed');
    expect(r.state.candidate).toEqual({ status: 'done', note: '直して main に入れた', returnOn: null, source: 'post_hoc', at: 200 });
  });
  it('状態が付いていれば、同じでも違っても提案は書かずに already_set', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 50 });
    const before = lastSeq(db);
    expect(proposeSessionState(db, 'd', 's1', { status: 'done', note: 'n', returnOn: null, source: 'in_session' }).outcome).toBe('already_set');
    const r = proposeSessionState(db, 'd', 's1', { ...paused });
    expect(r).toEqual({ outcome: 'already_set', state: expect.objectContaining({ status: 'done', candidate: null }) });
    expect(lastSeq(db)).toBe(before);
  });
  it('却下したセッションは、新しい発言まで rejected_before', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    rejectSessionState(db, 'd', 's1', 200);
    expect(proposeSessionState(db, 'd', 's1', { ...paused, now: 300 }).outcome).toBe('rejected_before');
    expect(clearOnNewPrompt(db, 'd', 's1', 400)).toBe(true);
    expect(proposeSessionState(db, 'd', 's1', { ...paused, now: 500 }).outcome).toBe('proposed');
  });
});

describe('会話で選ぶ・手で選ぶ', () => {
  it('会話で選ぶ：どれでも状態を書き、set_by を conversation にし、提案を消す', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const s = setSessionState(db, 'd', 's1', { status: 'done', note: '直した', setBy: 'conversation', now: 150 });
    expect(s).toEqual({ status: 'done', note: '直した', returnOn: null, setBy: 'conversation', setAt: 150, candidate: null });
  });
  it('手で選ぶ：Done と Archived は戻る日を持たず、Paused は戻る日が要る', () => {
    const db = seed();
    expect(setSessionState(db, 'd', 's1', { status: 'done', returnOn: '2026-10-02', setBy: 'user', now: 1 })).toMatchObject({ status: 'done', returnOn: null, setBy: 'user' });
    expect(setSessionState(db, 'd', 's1', { status: 'archived', setBy: 'user', now: 2 })).toMatchObject({ status: 'archived', returnOn: null });
    expect(setSessionState(db, 'd', 's1', { status: 'paused', note: '', returnOn: '2026-10-02', setBy: 'user', now: 3 })).toEqual({ status: 'paused', note: null, returnOn: '2026-10-02', setBy: 'user', setAt: 3, candidate: null });
    expect(() => setSessionState(db, 'd', 's1', { status: 'paused', setBy: 'user' })).toThrow(new StateInputError('Paused には戻る日が要ります'));
  });
  it('印なしに戻す：状態・理由・戻る日・提案を消し、rejected_at は残す', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    rejectSessionState(db, 'd', 's1', 200);
    setSessionState(db, 'd', 's1', { status: 'paused', note: '見る', returnOn: '2026-10-02', setBy: 'user', now: 300 });
    expect(setSessionState(db, 'd', 's1', { status: null, setBy: 'user', now: 400 })).toEqual({ status: null, note: null, returnOn: null, setBy: 'user', setAt: 400, candidate: null });
    expect(row(db)).toMatchObject({ rejected_at: 200, candidate_at: null });
  });
});

describe('確定と却下', () => {
  it('確定：提案の中身を写し、日を変えればその日にする', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const r = confirmSessionState(db, 'd', 's1', { returnOn: '2026-10-05', now: 200 });
    expect(r).toEqual({ result: 'confirmed', state: { status: 'paused', note: '明日の朝 CPU の数字を見る', returnOn: '2026-10-05', setBy: 'user', setAt: 200, candidate: null } });
  });
  it('Done の提案の確定は戻る日を持たない', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { status: 'done', note: '済んだ', returnOn: null, source: 'exit', now: 100 });
    expect(confirmSessionState(db, 'd', 's1', { returnOn: '2026-10-05', now: 200 }).state).toMatchObject({ status: 'done', returnOn: null, note: '済んだ' });
  });
  it('確定のときの日は検査し、誤っていれば何も書かない', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const before = lastSeq(db);
    expect(() => confirmSessionState(db, 'd', 's1', { returnOn: '2026-02-30' })).toThrow(StateInputError);
    expect(lastSeq(db)).toBe(before);
    expect(getSessionState(db, 's1')!.candidate).not.toBeNull();
  });
  it('却下：提案を消して rejected_at を刻む', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    expect(rejectSessionState(db, 'd', 's1', 200)).toEqual({ result: 'rejected', state: { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null } });
    expect(row(db)).toMatchObject({ candidate_at: null, candidate_status: null, rejected_at: 200 });
  });
  it('提案が無ければ、確定も却下も not_candidate で何も書かない', () => {
    const db = seed();
    expect(confirmSessionState(db, 'd', 's1')).toEqual({ result: 'not_candidate', state: NO_STATE });
    expect(rejectSessionState(db, 'd', 's1')).toEqual({ result: 'not_candidate', state: NO_STATE });
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 1 });
    const before = lastSeq(db);
    expect(confirmSessionState(db, 'd', 's1').result).toBe('not_candidate');
    expect(rejectSessionState(db, 'd', 's1').result).toBe('not_candidate');
    expect(lastSeq(db)).toBe(before);
  });
});

describe('新しい発言', () => {
  it('発言の時刻が set_at・candidate_at・rejected_at のどれよりも後なら、全部を消して true', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'paused', note: '見る', returnOn: '2026-10-02', setBy: 'conversation', now: 100 });
    expect(clearOnNewPrompt(db, 'd', 's1', 101)).toBe(true);
    expect(row(db)).toEqual({ status: null, note: null, return_on: null, set_by: null, set_at: null, candidate_status: null, candidate_note: null, candidate_return_on: null, candidate_source: null, candidate_at: null, rejected_at: null });
    expect(getSessionState(db, 's1')).toEqual(NO_STATE);
  });
  it('発言の時刻が付けた時刻と同じか前なら外さない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 100 });
    expect(clearOnNewPrompt(db, 'd', 's1', 100)).toBe(false);
    expect(clearOnNewPrompt(db, 'd', 's1', 99)).toBe(false);
    expect(getSessionState(db, 's1')!.status).toBe('done');
  });
  it('提案だけ、却下だけのときもそれぞれの時刻と比べる', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    expect(clearOnNewPrompt(db, 'd', 's1', 50)).toBe(false);
    expect(clearOnNewPrompt(db, 'd', 's1', 150)).toBe(true);
    proposeSessionState(db, 'd', 's1', { ...paused, now: 200 });
    rejectSessionState(db, 'd', 's1', 300);
    expect(clearOnNewPrompt(db, 'd', 's1', 250)).toBe(false);
    expect(clearOnNewPrompt(db, 'd', 's1', 350)).toBe(true);
  });
  // Review Focus 2：発言は数が多い。状態の無いセッションで毎回書くと、D1 の無料枠を食う。
  it('行が無いか、状態も提案も却下も無ければ書かずに false', () => {
    const db = seed();
    expect(clearOnNewPrompt(db, 'd', 's1', 1_000)).toBe(false);
    expect(lastSeq(db)).toBeNull();
    setSessionState(db, 'd', 's1', { status: null, setBy: 'user', now: 10 });
    const before = lastSeq(db);
    expect(clearOnNewPrompt(db, 'd', 's1', 2_000)).toBe(false);
    expect(lastSeq(db)).toBe(before);
  });
});

describe('検査と読み方', () => {
  // Review Focus 4：UTF-16 の長さで数えると、絵文字 100 字で上限に当たる。
  it('理由は前後の空白と改行をたたみ、文字単位で 200 字まで', () => {
    const db = seed();
    expect(setSessionState(db, 'd', 's1', { status: 'done', note: '  一行目\n\n  二行目  ', setBy: 'user' }).note).toBe('一行目 二行目');
    expect(setSessionState(db, 'd', 's1', { status: 'done', note: '😀'.repeat(200), setBy: 'user' }).note).toBe('😀'.repeat(200));
    expect(() => setSessionState(db, 'd', 's1', { status: 'done', note: '😀'.repeat(201), setBy: 'user' })).toThrow(new StateInputError('理由は 200 字までです'));
  });
  it('提案の根拠は 1 字以上が要る。戻る日は暦にある日だけ。どれも何も書かない', () => {
    const db = seed();
    expect(() => proposeSessionState(db, 'd', 's1', { ...paused, note: '   ' })).toThrow(new StateInputError('根拠の一文が空です'));
    expect(() => proposeSessionState(db, 'd', 's1', { ...paused, returnOn: null })).toThrow(new StateInputError('Paused には戻る日が要ります'));
    expect(() => proposeSessionState(db, 'd', 's1', { ...paused, returnOn: '2026-02-30' })).toThrow(new StateInputError('戻る日は YYYY-MM-DD の形の、暦にある日付です'));
    expect(lastSeq(db)).toBeNull();
  });
  it('同期で状態と提案の両方を持つ行は、状態を正として提案を出さない（書き直しはしない）', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 1 });
    db.prepare("update session_states set candidate_status = 'paused', candidate_note = 'x', candidate_return_on = '2026-10-02', candidate_source = 'exit', candidate_at = 5 where session_id = 's1'").run();
    expect(getSessionState(db, 's1')).toMatchObject({ status: 'done', candidate: null });
    expect(row(db)).toMatchObject({ candidate_at: 5 });
  });
  it('論理削除した行は無いものとして読む', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 1 });
    db.prepare("update session_states set deleted_at = 9 where session_id = 's1'").run();
    expect(getSessionState(db, 's1')).toBeNull();
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/sessions/states.test.ts`
Expected: FAIL（`./states.ts` が見つからない）

- [ ] **Step 3: 実装する**

`packages/server/src/sessions/states.ts`

```ts
import { isReturnOn, STATE_NOTE_MAX, type CandidateSource, type SessionStateDto, type SessionStatus, type StateSetBy } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

/**
 * セッションの状態の移り方。設計は docs/superpowers/specs/2026-10-01-session-status-design.md の「状態の移り方」。
 * 書き手は MCP（提案と、会話で選んだもの）、HTTP（画面と claude.zsh）、索引（新しい発言で外すときだけ）である。
 * 変更のたびに session.upsert を配るのは呼び手の役目にする（TODO の候補と同じ分け方）。
 */

/** 状態の入力の誤り。message はトーストにそのまま出せる日本語の一文である。 */
export class StateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateInputError';
  }
}

type StateRow = {
  session_id: string;
  status: SessionStatus | null; note: string | null; return_on: string | null; set_by: StateSetBy | null; set_at: number | null;
  candidate_status: 'paused' | 'done' | null; candidate_note: string | null; candidate_return_on: string | null; candidate_source: CandidateSource | null; candidate_at: number | null;
  rejected_at: number | null;
  updated_at: number; deleted_at: number | null; origin_device: string;
};
/** DTO に写すのに要る列。db/queries.ts の左結合の行も、この形に詰め直して渡す。 */
export type StateCols = Pick<StateRow, 'status' | 'note' | 'return_on' | 'set_by' | 'set_at' | 'candidate_status' | 'candidate_note' | 'candidate_return_on' | 'candidate_source' | 'candidate_at'>;

const NO_CANDIDATE = { candidate_status: null, candidate_note: null, candidate_return_on: null, candidate_source: null, candidate_at: null } as const;
const CLEARED = { status: null, note: null, return_on: null, set_by: null, set_at: null, ...NO_CANDIDATE, rejected_at: null } as const;

/** 行の無いセッションの状態（印なし）。 */
export const NO_STATE: SessionStateDto = { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null };

/**
 * 行の列を DTO に写す。rejected_at は載せない（判定はサーバの中だけで行う）。
 * 状態と提案が両方あるのは同期の競り合いでしか起きない。状態を正とし、提案は無いものとして読む（書き直しはしない）。
 */
export function toStateDto(r: StateCols): SessionStateDto {
  const candidate = r.status === null && r.candidate_at !== null && r.candidate_status !== null && r.candidate_source !== null
    ? { status: r.candidate_status, note: r.candidate_note, returnOn: r.candidate_return_on, source: r.candidate_source, at: r.candidate_at }
    : null;
  return { status: r.status, note: r.note, returnOn: r.return_on, setBy: r.set_by, setAt: r.set_at, candidate };
}

const liveRow = (db: Db, id: string) => db.prepare('select * from session_states where session_id = ? and deleted_at is null').get(id) as StateRow | undefined;

/** 今の行（無ければ空の行）に差分を重ねて書く。updated_at と origin_device は upsertShared が補う。 */
function write(db: Db, deviceId: string, sessionId: string, patch: Partial<StateRow>): SessionStateDto {
  const cur = db.prepare('select * from session_states where session_id = ?').get(sessionId) as StateRow | undefined;
  const base = cur ?? { session_id: sessionId, ...CLEARED };
  upsertShared(db, 'session_states', { ...base, ...patch, session_id: sessionId, deleted_at: null }, deviceId, 'session_id');
  return toStateDto(liveRow(db, sessionId)!);
}

/**
 * 理由と根拠を整える。1 行の欄で見せるので、改行を含む空白の並びは 1 つの空白にたたむ。
 * 字数は文字単位で数える（UTF-16 の長さで数えると、絵文字 100 字で上限に当たる）。
 */
function noteOf(v: string | null | undefined, required: boolean): string | null {
  const s = (v ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!s) {
    if (required) throw new StateInputError('根拠の一文が空です');
    return null;
  }
  if ([...s].length > STATE_NOTE_MAX) throw new StateInputError(`理由は ${STATE_NOTE_MAX} 字までです`);
  return s;
}

/** 戻る日。Paused だけが持ち、ほかの状態では渡されても捨てる。 */
function returnOnOf(status: SessionStatus, v: string | null | undefined): string | null {
  if (status !== 'paused') return null;
  if (v === null || v === undefined || v === '') throw new StateInputError('Paused には戻る日が要ります');
  if (!isReturnOn(v)) throw new StateInputError('戻る日は YYYY-MM-DD の形の、暦にある日付です');
  return v;
}

/** 今の状態。行が無いか論理削除されていれば null（印なし）。 */
export function getSessionState(db: Db, sessionId: string): SessionStateDto | null {
  const r = liveRow(db, sessionId);
  return r ? toStateDto(r) : null;
}

/**
 * 状態を書く（会話で選ぶ・手で選ぶ・印なしに戻す）。提案は消す。
 * 印なしに戻しても rejected_at は残す。却下は、そのセッションに新しい発言があるまで効く。
 * 検査はすべて書く前に済ませ、誤りは StateInputError にして何も書かない。
 */
export function setSessionState(db: Db, deviceId: string, sessionId: string, o: { status: SessionStatus | null; note?: string | null; returnOn?: string | null; setBy: 'user' | 'conversation'; now?: number }): SessionStateDto {
  const now = o.now ?? Date.now();
  if (o.status === null) return write(db, deviceId, sessionId, { status: null, note: null, return_on: null, set_by: o.setBy, set_at: now, ...NO_CANDIDATE });
  const note = noteOf(o.note, false);
  const returnOn = returnOnOf(o.status, o.returnOn);
  return write(db, deviceId, sessionId, { status: o.status, note, return_on: returnOn, set_by: o.setBy, set_at: now, ...NO_CANDIDATE });
}

export type ProposeStateOutcome = 'proposed' | 'set' | 'rejected_before' | 'already_set';

/**
 * 提案する。状態にはしない（状態にするのは利用者か、会話で利用者が選んだときだけ）。
 * 状態が付いていれば、同じでも違っても書かずに already_set を返す。読むときに状態を正とするので、書いても見えない提案になる。
 * 却下されていれば rejected_before を返す。提案があるところへの提案は上書きする（新しい発言の時点で前の提案は消えているので、残るのは同じターンの出し直しだけである）。
 */
export function proposeSessionState(db: Db, deviceId: string, sessionId: string, o: { status: 'paused' | 'done'; note: string; returnOn: string | null; source: CandidateSource; now?: number }): { state: SessionStateDto; outcome: Exclude<ProposeStateOutcome, 'set'> } {
  const note = noteOf(o.note, true);
  const returnOn = returnOnOf(o.status, o.returnOn);
  const cur = liveRow(db, sessionId);
  if (cur && cur.status !== null) return { state: toStateDto(cur), outcome: 'already_set' };
  if (cur && cur.rejected_at !== null) return { state: toStateDto(cur), outcome: 'rejected_before' };
  const state = write(db, deviceId, sessionId, { candidate_status: o.status, candidate_note: note, candidate_return_on: returnOn, candidate_source: o.source, candidate_at: o.now ?? Date.now() });
  return { state, outcome: 'proposed' };
}

/** 読むときに見える提案があるか（状態が付いていれば、提案は無いものとして読む）。 */
const hasCandidate = (r: StateRow | undefined): r is StateRow => !!r && r.status === null && r.candidate_at !== null && r.candidate_status !== null;

/**
 * 提案を確定する。提案の中身を状態に写し、set_by を user にする。
 * 日を変えたときだけ returnOn を渡す。Done の提案では戻る日を持たないので捨てる。
 */
export function confirmSessionState(db: Db, deviceId: string, sessionId: string, o: { returnOn?: string; now?: number } = {}): { state: SessionStateDto; result: 'confirmed' | 'not_candidate' } {
  const cur = liveRow(db, sessionId);
  if (!hasCandidate(cur)) return { state: cur ? toStateDto(cur) : NO_STATE, result: 'not_candidate' };
  const status = cur.candidate_status!;
  const returnOn = returnOnOf(status, o.returnOn ?? cur.candidate_return_on);
  const state = write(db, deviceId, sessionId, { status, note: cur.candidate_note, return_on: returnOn, set_by: 'user', set_at: o.now ?? Date.now(), ...NO_CANDIDATE });
  return { state, result: 'confirmed' };
}

/** 提案を却下する。提案を消して rejected_at に今の時刻を刻む。 */
export function rejectSessionState(db: Db, deviceId: string, sessionId: string, now = Date.now()): { state: SessionStateDto; result: 'rejected' | 'not_candidate' } {
  const cur = liveRow(db, sessionId);
  if (!hasCandidate(cur)) return { state: cur ? toStateDto(cur) : NO_STATE, result: 'not_candidate' };
  return { state: write(db, deviceId, sessionId, { ...NO_CANDIDATE, rejected_at: now }), result: 'rejected' };
}

/**
 * 利用者の新しい発言（promptTs）が set_at・candidate_at・rejected_at のどれより後なら、全部を null にして true を返す。
 * 比べるのは値のある時刻だけである。状態が無いときの set_at（印なしに戻した時刻）は比べない。
 * 外すものが何も無ければ書かない。発言は数が多いので、毎回書くと D1 の無料枠を食う。
 */
export function clearOnNewPrompt(db: Db, deviceId: string, sessionId: string, promptTs: number): boolean {
  const cur = liveRow(db, sessionId);
  if (!cur) return false;
  const marks = [cur.status !== null ? cur.set_at ?? 0 : null, cur.candidate_at, cur.rejected_at].filter((t): t is number => t !== null);
  if (marks.length === 0 || promptTs <= Math.max(...marks)) return false;
  write(db, deviceId, sessionId, { ...CLEARED });
  return true;
}
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/server/src/sessions/states.test.ts && npm run typecheck --workspace packages/server`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/sessions/states.ts packages/server/src/sessions/states.test.ts
git commit packages/server/src/sessions/states.ts packages/server/src/sessions/states.test.ts -m "feat(server): add session state transitions (propose, set, confirm, reject, clear)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 新しい発言で状態を外す（索引から呼ぶ）

**Files:**
- Modify: `packages/server/src/indexer/indexFile.ts:7`（import）、`:23-28`（`Acc`）、`:184-190`（ループの中）、`:215-217`（ループの後ろ）
- Test: `packages/server/src/indexer/indexFile.test.ts`（末尾に describe を足す）

**Interfaces:**
- Consumes: Task 1 の `isTypedPrompt(raw, facts)`、Task 4 の `clearOnNewPrompt(db, deviceId, sessionId, promptTs)` と `setSessionState`
- Produces: 手元の主線の索引だけが、打った発言の最大の時刻で `clearOnNewPrompt` を 1 回呼ぶ。画面への配信は既存の `sessionChanged`（`packages/server/src/server.ts:516-534`）の `session.upsert` に乗る。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/indexer/indexFile.test.ts` の import に足す。

```ts
import { setSessionState } from '../sessions/states.ts';
```

末尾に足す。

```ts
describe('新しい発言で状態を外す', () => {
  /** フィクスチャの主線の最後の記録の時刻。 */
  const ALPHA_END = Date.parse('2026-09-01T10:04:00.000Z');
  const rec = (o: Record<string, unknown>, ts: string) => ({ ...o, uuid: `x-${ts}`, timestamp: ts, cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA });
  const prompt = (text: string, ts: string) => rec({ type: 'user', message: { role: 'user', content: text } }, ts);
  const stateOf = (id: string) => db.prepare('select status, candidate_at, rejected_at from session_states where session_id = ?').get(id);
  /** 最後に積んだ変更の連番。未送信の差分は同じ行ごとに 1 つへまとまるので、書いたかどうかは件数ではなくこれで見る。 */
  const lastSeq = (table = 'session_states') => (db.prepare('select max(seq) s from changes where table_name = ?').get(table) as { s: number | null }).s;

  it('状態を付けた後に打った発言で、状態を外して印なしに戻す', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'user', now: ALPHA_END + 60_000 });
    appendJson(alphaMain().path, prompt('もう一つ直して', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(stateOf(sessionId)).toEqual({ status: null, candidate_at: null, rejected_at: null });
  });
  it('発言の時刻が状態を付けた時刻より前なら外さない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'user', now: Date.parse('2026-09-01T11:00:00.000Z') });
    appendJson(alphaMain().path, prompt('遅れて索引に来た発言', '2026-09-01T10:30:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
  });
  it('AskUserQuestion の答え（ツールの結果）、要約で続けた頭、中断の印では外さない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'conversation', now: ALPHA_END + 60_000 });
    appendJson(alphaMain().path,
      rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'このセッションをどうしますか' }] } }], usage: { input_tokens: 0, output_tokens: 1 } } }, '2026-09-01T10:06:00.000Z'),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'User has answered your questions: "このセッションをどうしますか"="Done にする".' }] } }, '2026-09-01T10:07:00.000Z'),
      rec({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } }, '2026-09-01T10:08:00.000Z'),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, '2026-09-01T10:09:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
  });
  // Review Focus 3：作り直しは前からある発言を全部読み直す。
  it('索引を作り直しても、前からある発言では外れない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: 1 });
    setSessionState(db, DEV, sessionId, { status: 'paused', returnOn: '2026-09-02', setBy: 'user', now: ALPHA_END + 60_000 });
    const before = lastSeq();
    indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: 2 });
    expect(stateOf(sessionId)).toMatchObject({ status: 'paused' });
    expect(lastSeq()).toBe(before);
  });
  // Review Focus 2：状態の無いセッションでは、発言のたびに共有テーブルへ書かない。
  it('状態も提案も無いセッションの発言では、session_states に書かない', () => {
    indexFile(db, alphaMain(), { deviceId: DEV });
    appendJson(alphaMain().path, prompt('続けて', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaMain(), { deviceId: DEV });
    expect(lastSeq()).toBeNull();
    expect(count('select count(*) c from session_states')).toBe(0);
  });
  it('サブエージェントの記録は発言に数えない', () => {
    const { sessionId } = indexFile(db, alphaMain(), { deviceId: DEV });
    setSessionState(db, DEV, sessionId, { status: 'done', setBy: 'user', now: ALPHA_END + 60_000 });
    appendJson(alphaSub().path, prompt('サブエージェントへの指示', '2026-09-01T11:00:00.000Z'));
    indexFile(db, alphaSub(), { deviceId: DEV });
    expect(stateOf(sessionId)).toMatchObject({ status: 'done' });
  });
  it('他端末の写しの発言では外さず、共有テーブルに書かない', () => {
    const u = '22222222-2222-4222-8222-222222222222';
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rem-state-'));
    try {
      upsertShared(db, 'sessions', { id: 's9', provider: 'claude-code', provider_session_id: u, cwd: '/w/alpha', home_device: 'dev-b' }, 'dev-b');
      setSessionState(db, DEV, 's9', { status: 'done', setBy: 'user', now: Date.parse('2026-09-01T00:00:00.000Z') });
      const before = lastSeq();
      const p = path.join(remoteDir, 'dev-b', 'projects', '-w-alpha', `${u}.jsonl`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: '別の PC で続けた' }, cwd: '/w/alpha', timestamp: '2026-09-02T00:00:00.000Z' }) + '\n');
      indexFile(db, { path: p, sessionId: u, agentId: null, deviceId: 'dev-b' }, { deviceId: DEV, remote: true });
      expect(stateOf('s9')).toMatchObject({ status: 'done' });
      expect(lastSeq()).toBe(before);
    } finally {
      fs.rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/indexer/indexFile.test.ts`
Expected: FAIL（「状態を付けた後に打った発言で…」が `status: 'done'` のままで落ちる）

- [ ] **Step 3: 実装する**

`packages/server/src/indexer/indexFile.ts:7` を差し替え、その後ろに import を足す。

```ts
import { indexTexts, isTypedPrompt, normalizeRecord, recordFacts } from '../provider/claude-code/normalize.ts';
import { clearOnNewPrompt } from '../sessions/states.ts';
```

`Acc`（23-28 行）の `userTurns: number; input: number; output: number;` の前に足す。

```ts
  /** 利用者が打った発言（isTypedPrompt）のうち、最も新しい時刻。状態を外す合図に使う。 */
  lastTypedPromptTs?: number;
```

ループの中、`if (f.isUserTurn) { ... }`（184-190 行）の直後に足す。

```ts
      if (f.ts !== undefined && isTypedPrompt(p.rec, f)) acc.lastTypedPromptTs = Math.max(acc.lastTypedPromptTs ?? f.ts, f.ts);
```

ループの後ろ、`else applySessionFacts(db, sessionId, acc, reset, opts.deviceId);`（217 行）の直後に足す。

```ts
    // resume して利用者が新しく打った発言があれば、状態と提案を外して印なしに戻す。
    // 手元の主線だけが書く。他端末の写しから外すと、持ち主の PC と同じ書き込みを二重に D1 へ送る。
    // 作り直しで前からある発言を読み直しても、状態を付けた時刻より前なので外れない。
    if (mainLocal && acc.lastTypedPromptTs !== undefined) clearOnNewPrompt(db, opts.deviceId, sessionId, acc.lastTypedPromptTs);
```

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx vitest run packages/server/src/indexer/ packages/server/src/provider/claude-code/normalize.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit packages/server/src/indexer/indexFile.ts packages/server/src/indexer/indexFile.test.ts -m "feat(server): clear a session's state when the user types a new prompt" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: SessionDto に状態を載せる

**Files:**
- Modify: `packages/server/src/db/queries.ts:1`（import）、`:5-47`（`SessionRow`）、`:49-64`（`SESSION_SELECT`）、`:167-191`（`toSessionDto` の返り値）
- Test: `packages/server/src/db/queries.test.ts`（末尾に describe を足す）

**Interfaces:**
- Consumes: Task 4 の `toStateDto(r: StateCols)`
- Produces: `listSessions` と `getSession` の返す `SessionDto.state`。行が無ければ `null`、あれば `SessionStateDto`（`rejected_at` は載せない）。HTTP・MCP・同期の `session.upsert` はすべてこれを通る。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/db/queries.test.ts` の import に足す。

```ts
import { proposeSessionState, rejectSessionState, setSessionState } from '../sessions/states.ts';
```

末尾に足す。

```ts
describe('セッションの状態', () => {
  const alphaId = () => (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  it('行が無ければ null、あれば状態と提案を載せ、rejected_at は載せない', () => {
    expect(getSession(db, [], alphaId())!.state).toBeNull();
    proposeSessionState(db, 'd', alphaId(), { status: 'paused', note: '明日 CPU を見る', returnOn: '2026-10-02', source: 'exit', now: 500 });
    expect(getSession(db, [], alphaId())!.state).toEqual({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: { status: 'paused', note: '明日 CPU を見る', returnOn: '2026-10-02', source: 'exit', at: 500 } });
    rejectSessionState(db, 'd', alphaId(), 600);
    const rejected = getSession(db, [], alphaId())!.state!;
    expect(rejected.candidate).toBeNull();
    expect(Object.keys(rejected)).not.toContain('rejectedAt');
    setSessionState(db, 'd', alphaId(), { status: 'done', note: '直した', setBy: 'conversation', now: 700 });
    expect(listSessions(db, []).find((s) => s.id === alphaId())!.state).toEqual({ status: 'done', note: '直した', returnOn: null, setBy: 'conversation', setAt: 700, candidate: null });
  });
  it('状態を付けても一覧の件数と並びは変わらない', () => {
    const before = listSessions(db, []).map((s) => s.id);
    setSessionState(db, 'd', alphaId(), { status: 'archived', setBy: 'user' });
    expect(listSessions(db, []).map((s) => s.id)).toEqual(before);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/db/queries.test.ts`
Expected: FAIL（`state` が `undefined`）

- [ ] **Step 3: 実装する**

`packages/server/src/db/queries.ts:1` を差し替え、その後ろに import を足す。

```ts
import type { CandidateSource, DeviceDto, LiveSessionDto, ProjectDto, SessionDto, SessionLockDto, SessionStatsDto, SessionStatus, SessionSummaryDto, StateSetBy } from '@agent-hangar/shared';
import { toStateDto } from '../sessions/states.ts';
```

`SessionRow`（5-47 行）の `local_mtime: number | null;` の後ろに足す。

```ts
  // session_states の左結合。ss_id が null なら行が無い（印なし）。
  ss_id: string | null;
  ss_status: SessionStatus | null;
  ss_note: string | null;
  ss_return_on: string | null;
  ss_set_by: StateSetBy | null;
  ss_set_at: number | null;
  ss_c_status: 'paused' | 'done' | null;
  ss_c_note: string | null;
  ss_c_return_on: string | null;
  ss_c_source: CandidateSource | null;
  ss_c_at: number | null;
```

`SESSION_SELECT`（49-64 行）の 57 行目の末尾 `a.question a_question` の後ろに列を足し、63 行目の `left join session_activity a on a.session_id = s.id` の後ろに結合を足す。

```ts
  ls.model ls_model, ls.effort ls_effort, ls.context_used ls_used, ls.context_size ls_size, ls.cost_usd ls_cost, a.tool a_tool, a.summary a_summary, a.question a_question,
  ss.session_id ss_id, ss.status ss_status, ss.note ss_note, ss.return_on ss_return_on, ss.set_by ss_set_by, ss.set_at ss_set_at,
  ss.candidate_status ss_c_status, ss.candidate_note ss_c_note, ss.candidate_return_on ss_c_return_on, ss.candidate_source ss_c_source, ss.candidate_at ss_c_at
```

```ts
left join session_activity a on a.session_id = s.id
left join session_states ss on ss.session_id = s.id and ss.deleted_at is null
```

`toSessionDto` の返り値の `...(live ? { activity: ... } : {}),`（190 行）の前に足す。

```ts
    // セッションの状態と提案。行が無ければ印なしの null。rejected_at は載せない（toStateDto）。
    state: r.ss_id === null ? null : toStateDto({
      status: r.ss_status, note: r.ss_note, return_on: r.ss_return_on, set_by: r.ss_set_by, set_at: r.ss_set_at,
      candidate_status: r.ss_c_status, candidate_note: r.ss_c_note, candidate_return_on: r.ss_c_return_on, candidate_source: r.ss_c_source, candidate_at: r.ss_c_at,
    }),
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/server/src/db/ packages/server/src/http/app.test.ts packages/server/src/mcp/ && npm run typecheck --workspace packages/server`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git commit packages/server/src/db/queries.ts packages/server/src/db/queries.test.ts -m "feat(server): carry session state on SessionDto" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 同期で状態を往復させる

**Files:**
- Modify: `packages/server/src/sync/apply.ts`（末尾に `sessionIdOfChange` を足す）
- Modify: `packages/server/src/server.ts:39`（import）、`:664-670`（`applied` の配り直し）
- Test: `packages/server/src/sync/apply.test.ts`（末尾に describe を足す）
- Test: `packages/cloud/test/changes.test.ts:116-123`（`it('形の違う本文と 40 行超は 400'` の直後に足す）

**Interfaces:**
- Consumes: Task 3 の `SHARED_TABLES`（Worker の `TABLES` はここから作られる）、Task 4 の `setSessionState`・`getSessionState`
- Produces: `export function sessionIdOfChange(db: Db, c: Pick<ChangeOut, 'tableName' | 'rowId'>): string | null`。pull で `session_states` の行が入ったら、そのセッションの `session.upsert` を配る。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/sync/apply.test.ts` の import を差し替える。

```ts
import { applyRemoteBatch, applyRemoteChange, sessionIdOfChange, writeMemoConflictCopy } from './apply.ts';
import { getSessionState, setSessionState } from '../sessions/states.ts';
```

末尾に足す。

```ts
describe('セッションの状態の同期', () => {
  const seedSession = (db: ReturnType<typeof openDb>) => upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'b' }, 'b');
  const stateChange = (updatedAt: number, payload: Record<string, unknown>): ChangeOut => ({
    seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt,
    payload: { session_id: 's1', status: null, note: null, return_on: null, set_by: null, set_at: null, candidate_status: null, candidate_note: null, candidate_return_on: null, candidate_source: null, candidate_at: null, rejected_at: null, updated_at: updatedAt, deleted_at: null, origin_device: 'b', ...payload },
  });

  it('状態と提案の列は同期で往復する', () => {
    const a = openDb(':memory:');
    seedSession(a);
    setSessionState(a, 'a', 's1', { status: 'paused', note: '明日見る', returnOn: '2026-10-02', setBy: 'user', now: 100 });
    const sent = a.prepare("select payload, updated_at from changes where table_name = 'session_states'").get() as { payload: string; updated_at: number };
    const b = openDb(':memory:');
    seedSession(b);
    expect(applyRemoteChange(b, { seq: 1, tableName: 'session_states', rowId: 's1', op: 'upsert', deviceId: 'a', updatedAt: sent.updated_at, payload: JSON.parse(sent.payload) }, { ownDeviceId: 'b', skipOwn: true })).toBe('applied');
    expect(getSessionState(b, 's1')).toEqual(getSessionState(a, 's1'));
  });
  // Review Focus 1：後から上げた PC の一括 Done（updated_at 0）が、先に上げた PC で付けた状態に勝ってはいけない。
  it('先に上げた PC で付けた状態は、後から上げた PC の一括 Done に負けない', () => {
    const b = openDb(':memory:');
    seedSession(b);
    b.prepare("insert into session_states (session_id, status, set_by, set_at, updated_at, origin_device) values ('s1', 'done', 'import', 900, 0, 'import')").run();
    expect(applyRemoteChange(b, stateChange(50, { status: 'paused', note: '明日', return_on: '2026-10-02', set_by: 'user', set_at: 50 }), o)).toBe('applied');
    expect(getSessionState(b, 's1')).toMatchObject({ status: 'paused', returnOn: '2026-10-02', setBy: 'user' });
  });
  it('同じ束にセッションの行があれば、それを先に適用してから状態を適用する', () => {
    const db = openDb(':memory:');
    const session: ChangeOut = { seq: 2, tableName: 'sessions', rowId: 's1', op: 'upsert', deviceId: 'b', updatedAt: 10, payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'b', updated_at: 10, deleted_at: null, origin_device: 'b' } };
    expect(applyRemoteBatch(db, [stateChange(20, { status: 'done', set_by: 'user', set_at: 20 }), session], o).map((c) => c.tableName)).toEqual(['sessions', 'session_states']);
  });
  // 表を持たない古い端末は、SHARED_TABLES に無い表の変更を捨てる。束のほかの変更は止めない。
  it('知らない表の変更は捨て、同じ束のほかの変更は適用する', () => {
    const db = openDb(':memory:');
    const applied = applyRemoteBatch(db, [{ ...ch({ rowId: 'x', updatedAt: 5 }), tableName: 'future_states' as never }, ch({ rowId: 'p1', updatedAt: 5 })], o);
    expect(applied.map((c) => c.rowId)).toEqual(['p1']);
  });
  it('sessionIdOfChange は、状態・要約・セッションの行ではその id、run ではそのセッション、ほかは null', () => {
    const db = openDb(':memory:');
    seedSession(db);
    upsertShared(db, 'runs', { id: 'r1', session_id: 's1', device_id: 'b', kind: 'start', tmux_name: 'hangar-r1', launch_params: '{}', started_at: 1, heartbeat_at: 1 }, 'b');
    expect(sessionIdOfChange(db, { tableName: 'session_states', rowId: 's1' })).toBe('s1');
    expect(sessionIdOfChange(db, { tableName: 'session_summaries', rowId: 's1' })).toBe('s1');
    expect(sessionIdOfChange(db, { tableName: 'sessions', rowId: 's1' })).toBe('s1');
    expect(sessionIdOfChange(db, { tableName: 'runs', rowId: 'r1' })).toBe('s1');
    expect(sessionIdOfChange(db, { tableName: 'runs', rowId: 'nope' })).toBeNull();
    expect(sessionIdOfChange(db, { tableName: 'todos', rowId: 't1' })).toBeNull();
  });
});
```

`packages/cloud/test/changes.test.ts` の `it('形の違う本文と 40 行超は 400', ...)`（116-123 行）の直後に足す。

```ts
  it('セッションの状態の行を受け取り、ほかの端末へ渡す', async () => {
    const st: ChangeIn = { tableName: 'session_states', rowId: 's1', op: 'upsert', payload: { session_id: 's1', status: 'paused', return_on: '2026-10-02', updated_at: 100, deleted_at: null, origin_device: 'dev-a' }, updatedAt: 100 };
    expect(await pushed(tokA, [st])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 0 }));
    const got = await pull(tokB, 0);
    expect(got.changes.map((c) => [c.tableName, c.rowId, c.payload.status])).toEqual([['session_states', 's1', 'paused']]);
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/sync/apply.test.ts packages/cloud/test/changes.test.ts`
Expected: FAIL（`sessionIdOfChange is not a function`）。cloud の試験は Task 3 で表を足したので通る（通らなければ Task 3 に戻る）。

- [ ] **Step 3: 実装する**

`packages/server/src/sync/apply.ts` の末尾に足す。

```ts
/**
 * pull で入れ替わった行のうち、画面に配り直すセッション。行がセッションに付く表だけで、ほかは null を返す。
 * session_states を足したときに、server.ts の配り直しから外れないよう、ここで 1 か所にまとめる。
 */
export function sessionIdOfChange(db: Db, c: Pick<ChangeOut, 'tableName' | 'rowId'>): string | null {
  if (c.tableName === 'sessions' || c.tableName === 'session_summaries' || c.tableName === 'session_states') return c.rowId;
  if (c.tableName === 'runs') return (db.prepare('select session_id s from runs where id = ?').get(c.rowId) as { s: string } | undefined)?.s ?? null;
  return null;
}
```

`packages/server/src/server.ts:39` を差し替える。

```ts
import { sessionIdOfChange, writeMemoConflictCopy, type SessionMemoBackup } from './sync/apply.ts';
```

`packages/server/src/server.ts:664-670` の次の塊を差し替える。

```ts
      if (c.tableName === 'sessions' || c.tableName === 'runs' || c.tableName === 'session_summaries') {
        const sessionId = c.tableName === 'runs'
          ? (db.prepare('select session_id s from runs where id = ?').get(c.rowId) as { s: string } | undefined)?.s ?? null
          : c.rowId;
        const s = sessionId ? getSession(db, registry.current(), sessionId, { deviceId: device.id }) : null;
        if (s) hub.broadcast({ type: 'session.upsert', session: s });
      }
```

を

```ts
      // セッションに付く表（sessions、runs、session_summaries、session_states）の行なら、そのセッションを配り直す。
      const sessionId = sessionIdOfChange(db, c);
      const s = sessionId ? getSession(db, registry.current(), sessionId, { deviceId: device.id }) : null;
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
```

にする。

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/server/src/sync/ packages/server/src/server.test.ts packages/cloud/ && npm run typecheck`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git commit packages/server/src/sync/apply.ts packages/server/src/sync/apply.test.ts packages/server/src/server.ts packages/cloud/test/changes.test.ts -m "feat(sync): round-trip session_states and rebroadcast the session on pull" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: MCP の propose_session_status

**Files:**
- Modify: `packages/server/src/mcp/tools.ts:1-11`（import）、`:34-37`（`TOOL_NAMES`）、`:318` の後ろ（`setTurnIntentTool` の後ろに関数を足す）、`:349-365`（`callTool`）
- Modify: `packages/server/src/mcp/app.ts:44` の後ろ（`set_turn_intent` の reg の後ろ）
- Test: `packages/server/src/mcp/tools.test.ts:41-48`（`SESSION_TOOL_CALLS`）、`:224`（件数）、末尾に describe
- Test: `packages/server/src/mcp/app.test.ts`（`describe('createMcpApp')` の中に 1 件）

**Interfaces:**
- Consumes: Task 4 の `getSessionState`・`setSessionState`・`proposeSessionState`・`StateInputError`・`ProposeStateOutcome`、Task 2 の `isReturnOn`・`STATE_NOTE_MAX`
- Produces: `proposeSessionStatusTool(deps, ctx, args, now?)` の戻り値 `{ outcome: ProposeStateOutcome; state: SessionStateDto }`。`TOOL_NAMES` に `'propose_session_status'`（13 件）。

決めたこと：`confirmed: true` で、同じ状態（Paused なら戻る日も同じ）がすでに付いていれば `already_set` にして書かない。提案（`confirmed` なし）の出どころは `in_session` にする（`exit` と `post_hoc` は第 3 段が `proposeSessionState` を直に呼ぶ）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/mcp/tools.test.ts:41-48` の `SESSION_TOOL_CALLS` の末尾に足す。

```ts
  ['propose_session_status', { status: 'done', note: '済んだ' }],
```

`packages/server/src/mcp/tools.test.ts:224` を差し替える。

```ts
    expect(TOOL_NAMES).toHaveLength(13);
```

import に足す。

```ts
import { rejectSessionState } from '../sessions/states.ts';
```

末尾に足す。

```ts
describe('propose_session_status', () => {
  const scoped = () => ({ sessionId: alphaId });
  const NONE = { status: null, note: null, returnOn: null, setBy: null, setAt: null };
  it('confirmed なしは提案にし、session.upsert を配る', () => {
    const r = call('propose_session_status', { status: 'paused', note: ' 明日の朝 CPU の数字を確かめる ', return_on: '2026-10-02' }, scoped());
    expect(r).toEqual({ outcome: 'proposed', state: { ...NONE, candidate: { status: 'paused', note: '明日の朝 CPU の数字を確かめる', returnOn: '2026-10-02', source: 'in_session', at: expect.any(Number) } } });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
    expect((sent[0] as Extract<ServerEvent, { type: 'session.upsert' }>).session.state).toEqual(r.state);
  });
  it('confirmed: true は状態にし、会話で承認した印を残す。Done は戻る日を持たない', () => {
    const r = call('propose_session_status', { status: 'done', note: '直して main に入れた', return_on: '2026-10-02', confirmed: true }, scoped());
    expect(r).toEqual({ outcome: 'set', state: { status: 'done', note: '直して main に入れた', returnOn: null, setBy: 'conversation', setAt: expect.any(Number), candidate: null } });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
  });
  it('同じ状態がすでにあれば already_set で何も書かず、何も配らない', () => {
    call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', confirmed: true }, scoped());
    sent.length = 0;
    // 書いたかどうかは連番で見る。未送信の差分は同じ行ごとに 1 つへまとまるので、件数では見えない。
    const lastSeq = () => (db.prepare("select max(seq) s from changes where table_name = 'session_states'").get() as { s: number | null }).s;
    const before = lastSeq();
    expect(call('propose_session_status', { status: 'paused', note: '別の根拠', return_on: '2026-10-02', confirmed: true }, scoped()).outcome).toBe('already_set');
    expect(call('propose_session_status', { status: 'done', note: 'n' }, scoped()).outcome).toBe('already_set');
    expect(sent).toEqual([]);
    expect(lastSeq()).toBe(before);
    // 戻る日が違えば会話で選び直したことになる。
    expect(call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-05', confirmed: true }, scoped()).outcome).toBe('set');
  });
  it('却下された後の提案は rejected_before。会話で選んだものは通る', () => {
    call('propose_session_status', { status: 'done', note: 'n' }, scoped());
    rejectSessionState(db, 'd', alphaId);
    sent.length = 0;
    expect(call('propose_session_status', { status: 'done', note: 'もう一度' }, scoped()).outcome).toBe('rejected_before');
    expect(sent).toEqual([]);
    expect(call('propose_session_status', { status: 'done', note: '選んだ', confirmed: true }, scoped()).outcome).toBe('set');
  });
  it('検査に落ちたら ToolError で何も書かず、何も配らない', () => {
    const bad: Record<string, unknown>[] = [
      { status: 'done', note: '' }, { status: 'done', note: '   ' }, { status: 'done', note: 'あ'.repeat(201) }, { status: 'done' },
      { status: 'paused', note: 'n' }, { status: 'paused', note: 'n', return_on: '2026/10/02' }, { status: 'paused', note: 'n', return_on: '2026-02-30' },
      { status: 'archived', note: 'n' }, { note: 'n' }, { status: 'done', note: 'n', confirmed: 'yes' },
    ];
    for (const args of bad) expect(() => call('propose_session_status', args, scoped()), JSON.stringify(args)).toThrow(ToolError);
    expect(sent).toEqual([]);
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
    // ちょうど 200 字は通る。
    expect(call('propose_session_status', { status: 'done', note: 'あ'.repeat(200) }, scoped()).outcome).toBe('proposed');
  });
  it('共通の URL では session_id が要り、セッション別 URL では別のセッションを指せない', () => {
    expect(() => call('propose_session_status', { status: 'done', note: 'n' })).toThrow(/session_id/);
    expect(call('propose_session_status', { session_id: alphaId, status: 'done', note: 'n' }).outcome).toBe('proposed');
    expect(() => call('propose_session_status', { session_id: 'other', status: 'done', note: 'n' }, scoped())).toThrow(ToolError);
  });
});
```

`packages/server/src/mcp/app.test.ts` の `describe('createMcpApp', ...)` の最後の `it` の後ろに足す。

```ts
  it('propose_session_status の説明文は、聞かずに confirmed を立てないよう求める', async () => {
    const list = await rpc('/', 'tools/list', {}, 6);
    const tools = list.body.result!.tools as { name: string; description: string }[];
    expect(tools.find((t) => t.name === 'propose_session_status')!.description).toBe('agent-hangar: このセッションの状態（Done か Paused）を提案する。利用者が会話の中で選んだときだけ confirmed を true にする。利用者に聞かずに true にしてはいけない。');
  });
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/mcp/`
Expected: FAIL（`知らないツールです: propose_session_status`、件数 12）

- [ ] **Step 3: 実装する**

`packages/server/src/mcp/tools.ts:1` を差し替え、11 行目の後ろに import を足す。

```ts
import { isReturnOn, STATE_NOTE_MAX, type LaunchParams, type LiveSessionDto, type ProjectDto, type ProjectStatus, type ServerEvent, type SessionDto, type SessionStateDto, type SummaryState, type TranscriptEvent, type UsageDto } from '@agent-hangar/shared';
```

```ts
import { getSessionState, proposeSessionState, setSessionState, StateInputError, type ProposeStateOutcome } from '../sessions/states.ts';
```

`TOOL_NAMES`（34-37 行）を差し替える。

```ts
export const TOOL_NAMES = [
  'list_projects', 'get_project', 'update_project', 'list_sessions', 'search_sessions', 'get_transcript',
  'create_session', 'set_session_summary', 'set_turn_intent', 'set_session_memo', 'get_usage', 'open_in_hangar',
  'propose_session_status',
] as const;
```

`setTurnIntentTool`（311-318 行）の後ろに足す。

```ts
/**
 * このセッションの状態（Done か Paused）を提案する。
 * confirmed が true のときだけ状態にする。利用者が会話の中で選んだという申告で、hangar はそれを確かめられない。
 * その余地は利用者の決定（2026-10-01）として受け入れ、代わりに set_by を conversation にして後から分かるようにする。
 * 却下された提案は、そのセッションに新しい発言があるまで受け付けない（rejected_before）。
 * 検査は書く前に全部済ませる。どれかに落ちたら何も書かず、何も配らない。
 */
export function proposeSessionStatusTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const status = args.status;
  if (status !== 'done' && status !== 'paused') throw new ToolError('status は done か paused です');
  const note = typeof args.note === 'string' ? args.note.trim() : '';
  if (!note || [...note].length > STATE_NOTE_MAX) throw new ToolError(`note（根拠の一文）は空白を除いて 1 字以上 ${STATE_NOTE_MAX} 字以下です`);
  if (args.return_on !== undefined && (typeof args.return_on !== 'string' || !isReturnOn(args.return_on))) throw new ToolError('return_on は YYYY-MM-DD の形の、暦にある日付です');
  // Done は戻る日を持たないので、渡されても捨てる。
  const returnOn = status === 'paused' ? (args.return_on as string | undefined) ?? null : null;
  if (status === 'paused' && returnOn === null) throw new ToolError('paused には return_on（戻る日）が要ります');
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new ToolError('confirmed は true か false です');
  try {
    let r: { outcome: ProposeStateOutcome; state: SessionStateDto };
    if (args.confirmed === true) {
      const cur = getSessionState(deps.db, id);
      r = cur && cur.status === status && cur.returnOn === returnOn
        ? { outcome: 'already_set', state: cur }
        : { outcome: 'set', state: setSessionState(deps.db, deps.deviceId, id, { status, note, returnOn, setBy: 'conversation', now }) };
    } else {
      r = proposeSessionState(deps.db, deps.deviceId, id, { status, note, returnOn, source: 'in_session', now });
    }
    if (r.outcome === 'set' || r.outcome === 'proposed') deps.hub.broadcast({ type: 'session.upsert', session: getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId })! });
    return { outcome: r.outcome, state: r.state };
  } catch (e) {
    if (e instanceof StateInputError) throw new ToolError(e.message);
    throw e;
  }
}
```

`callTool` の `case 'open_in_hangar': ...`（362 行）の後ろに足す。

```ts
    case 'propose_session_status': return proposeSessionStatusTool(deps, ctx, args);
```

`packages/server/src/mcp/app.ts:44`（`set_turn_intent` の reg）の後ろに足す。

```ts
  reg('propose_session_status', D('このセッションの状態（Done か Paused）を提案する。利用者が会話の中で選んだときだけ confirmed を true にする。利用者に聞かずに true にしてはいけない。'), { session_id: z.string().optional(), status: z.enum(['done', 'paused']), note: z.string(), return_on: z.string().optional(), confirmed: z.boolean().optional() });
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/server/src/mcp/ && npm run typecheck --workspace packages/server`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git commit packages/server/src/mcp/tools.ts packages/server/src/mcp/app.ts packages/server/src/mcp/tools.test.ts packages/server/src/mcp/app.test.ts -m "feat(mcp): add propose_session_status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: HTTP の 3 つの入口

**Files:**
- Modify: `packages/server/src/http/app.ts:1-28`（import）、`:109-110`（定数）、`:863` の後ろ（`api.patch('/sessions/:id', ...)` の閉じの後ろ、`api.post('/sessions/:id/promote'` の前）
- Test: `packages/server/src/http/app.test.ts:7-16`（import）と末尾に describe

**Interfaces:**
- Consumes: Task 4 の `setSessionState`・`confirmSessionState`・`rejectSessionState`・`StateInputError`、既存の `broadcastSession(id)`（`packages/server/src/http/app.ts:298`）
- Produces（契約のまま）:
  - `PUT /api/sessions/:id/state`：本文 `{ status: SessionStatus | null; note?: string; returnOn?: string }`、setBy は `user`
  - `POST /api/sessions/:id/state/confirm`：本文 `{ returnOn?: string }`、提案が無ければ 409
  - `POST /api/sessions/:id/state/reject`：提案が無ければ 409
  - 成功は 200 で `{ state: SessionStateDto }`。400・404・409 は `{ error: '<日本語の一文>' }`。成功のあとに `session.upsert` を配る。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/http/app.test.ts` の import を直す。8 行目を差し替え、16 行目の後ろに足す。

```ts
import { softDeleteShared, upsertShared } from '../db/shared.ts';
```

```ts
import { TOOL_NAMES } from '../mcp/tools.ts';
import { issueMcpSecret } from '../runs/secrets.ts';
import { proposeSessionState } from '../sessions/states.ts';
```

末尾に足す。

```ts
describe('セッションの状態', () => {
  const send = (p: string, body?: unknown, method = 'POST', headers: Record<string, string> = H) =>
    app.request(p, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = () => (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  const err = async (r: Response) => ((await r.json()) as { error: string }).error;

  it('PUT は手で状態を変え、session.upsert を配る', async () => {
    const id = alphaId();
    const r = await send(`/api/sessions/${id}/state`, { status: 'paused', note: '明日の朝見る', returnOn: '2026-10-02' }, 'PUT');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: { status: 'paused', note: '明日の朝見る', returnOn: '2026-10-02', setBy: 'user', setAt: expect.any(Number), candidate: null } });
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { id, state: { status: 'paused' } } });
    // Done は戻る日を持たない。
    expect((await (await send(`/api/sessions/${id}/state`, { status: 'done', returnOn: '2026-10-02' }, 'PUT')).json()).state).toMatchObject({ status: 'done', returnOn: null });
    // null は印なしに戻す。
    expect((await (await send(`/api/sessions/${id}/state`, { status: null }, 'PUT')).json()).state).toMatchObject({ status: null, note: null, returnOn: null, candidate: null });
  });
  it('PUT の誤りは 400 と 404。本文はトーストに出せる日本語の一文', async () => {
    const id = alphaId();
    const paused = await send(`/api/sessions/${id}/state`, { status: 'paused' }, 'PUT');
    expect(paused.status).toBe(400);
    expect(await err(paused)).toBe('Paused には戻る日が要ります');
    for (const body of [{}, { status: 'active' }, { status: 'done', note: 5 }, { status: 'paused', returnOn: 20261002 }, { status: 'paused', returnOn: '2026-02-30' }, { status: 'done', note: 'あ'.repeat(201) }]) {
      const r = await send(`/api/sessions/${id}/state`, body, 'PUT');
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      expect(await err(r)).toMatch(/[ぁ-んァ-ン一-龥]/);
    }
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
    const missing = await send('/api/sessions/nope/state', { status: 'done' }, 'PUT');
    expect(missing.status).toBe(404);
    expect(await err(missing)).toBe('セッションが見つかりません');
    // 論理削除したセッションも見つからない扱いにする。
    softDeleteShared(db, 'sessions', id, 'd');
    expect((await send(`/api/sessions/${id}/state`, { status: 'done' }, 'PUT')).status).toBe(404);
  });
  it('confirm は提案を状態にし、日を変えればその日にする。提案が無ければ 409', async () => {
    const id = alphaId();
    const none = await send(`/api/sessions/${id}/state/confirm`);
    expect(none.status).toBe(409);
    expect(await err(none)).toBe('このセッションには確かめる提案がありません');
    proposeSessionState(db, 'd', id, { status: 'paused', note: '明日見る', returnOn: '2026-10-02', source: 'in_session' });
    expect((await send(`/api/sessions/${id}/state/confirm`, { returnOn: '2026-02-30' })).status).toBe(400);
    sent.length = 0;
    const ok = await send(`/api/sessions/${id}/state/confirm`, { returnOn: '2026-10-05' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toEqual({ status: 'paused', note: '明日見る', returnOn: '2026-10-05', setBy: 'user', setAt: expect.any(Number), candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
    expect((await send(`/api/sessions/${id}/state/confirm`)).status).toBe(409);
    expect((await send('/api/sessions/nope/state/confirm')).status).toBe(404);
  });
  it('reject は提案を消し、同じセッションから出し直させない。提案が無ければ 409', async () => {
    const id = alphaId();
    expect((await send(`/api/sessions/${id}/state/reject`)).status).toBe(409);
    proposeSessionState(db, 'd', id, { status: 'done', note: '直した', returnOn: null, source: 'post_hoc' });
    sent.length = 0;
    const ok = await send(`/api/sessions/${id}/state/reject`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toMatchObject({ status: null, candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
    expect(proposeSessionState(db, 'd', id, { status: 'done', note: 'もう一度', returnOn: null, source: 'post_hoc' }).outcome).toBe('rejected_before');
    expect((await send('/api/sessions/nope/state/reject')).status).toBe(404);
  });
  it('MCP からは呼べない。run に配る秘密は /api を開けず、MCP のツールにも確定と却下は無い', async () => {
    const id = alphaId();
    const auth = { authorization: `Bearer ${issueMcpSecret(db, id, 1)}` };
    for (const [p, m] of [[`/api/sessions/${id}/state`, 'PUT'], [`/api/sessions/${id}/state/confirm`, 'POST'], [`/api/sessions/${id}/state/reject`, 'POST']] as const) {
      expect([p, (await send(p, { status: 'done' }, m, auth)).status]).toEqual([p, 401]);
    }
    expect(TOOL_NAMES.filter((n) => /state|status/.test(n))).toEqual(['propose_session_status']);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts -t 'セッションの状態'`
Expected: FAIL（PUT が 404 で、本文が JSON でない）

- [ ] **Step 3: 実装する**

`packages/server/src/http/app.ts:4` の shared の import に `type SessionStateDto, type SessionStatus` を足す。28 行目の後ろに import を足す。

```ts
import { confirmSessionState, rejectSessionState, setSessionState, StateInputError } from '../sessions/states.ts';
```

`packages/server/src/http/app.ts:110`（`RESOLVE_KINDS`）の後ろに足す。

```ts
/** セッションの状態として受け付ける値。印なしは null で表す。 */
const SESSION_STATUSES = new Set(['paused', 'done', 'archived']);
```

`api.patch('/sessions/:id', ...)`（851-863 行）の閉じの後ろに足す。

```ts
  // セッションの状態（Paused・Done・Archived）と Claude の提案の確定・却下。どれも利用者の操作で、MCP からは呼べない。
  // run に配る MCP の秘密は /api を開けない（authMiddleware は本体のトークンしか見ない）。
  // 成功したら session.upsert を配る。画面の正はその配信である。
  const NO_STATE_CANDIDATE = 'このセッションには確かめる提案がありません';
  const liveSessionRow = (id: string) => db.prepare('select 1 from sessions where id = ? and deleted_at is null').get(id) !== undefined;
  const stateResult = (c: Context, id: string, fn: () => { state: SessionStateDto; result?: string }) => {
    try {
      const r = fn();
      if (r.result === 'not_candidate') return c.json({ error: NO_STATE_CANDIDATE }, 409);
      broadcastSession(id);
      return c.json({ state: r.state });
    } catch (e) {
      if (e instanceof StateInputError) return c.json({ error: e.message }, 400);
      throw e;
    }
  };
  api.put('/sessions/:id/state', async (c) => {
    const id = c.req.param('id');
    if (!liveSessionRow(id)) return c.json({ error: 'セッションが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo);
    const body = (b.value ?? {}) as { status?: unknown; note?: unknown; returnOn?: unknown };
    if (body.status !== null && !(typeof body.status === 'string' && SESSION_STATUSES.has(body.status))) return c.json({ error: '状態は paused、done、archived か、印なしに戻す null です' }, 400);
    if (body.note !== undefined && typeof body.note !== 'string') return c.json({ error: '理由は文字列です' }, 400);
    if (body.returnOn !== undefined && typeof body.returnOn !== 'string') return c.json({ error: '戻る日は YYYY-MM-DD の形の文字列です' }, 400);
    const status = body.status as SessionStatus | null;
    return stateResult(c, id, () => ({ state: setSessionState(db, deviceId, id, { status, note: body.note as string | undefined, returnOn: body.returnOn as string | undefined, setBy: 'user' }) }));
  });
  api.post('/sessions/:id/state/confirm', async (c) => {
    const id = c.req.param('id');
    if (!liveSessionRow(id)) return c.json({ error: 'セッションが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { returnOn?: unknown };
    if (body.returnOn !== undefined && typeof body.returnOn !== 'string') return c.json({ error: '戻る日は YYYY-MM-DD の形の文字列です' }, 400);
    return stateResult(c, id, () => confirmSessionState(db, deviceId, id, body.returnOn === undefined ? {} : { returnOn: body.returnOn as string }));
  });
  api.post('/sessions/:id/state/reject', (c) => {
    const id = c.req.param('id');
    if (!liveSessionRow(id)) return c.json({ error: 'セッションが見つかりません' }, 404);
    return stateResult(c, id, () => rejectSessionState(db, deviceId, id));
  });
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/server/src/http/ && npm run typecheck --workspace packages/server`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git commit packages/server/src/http/app.ts packages/server/src/http/app.test.ts -m "feat(http): add PUT state, confirm and reject for session state" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: UI の配線（Intent・作用・API・ランタイム・Paused の overlay）

**Files:**
- Modify: `packages/shared/src/intent.ts:1`（import）、`:44` の後ろ（Intent を足す）
- Modify: `packages/ui/src/mediator/types.ts:1`（import）、`:86-87` の後ろ（Effect）、`:120-128`（Overlay）
- Modify: `packages/ui/src/mediator/workbench.ts:1`（import）、`:67-68` の後ろ
- Modify: `packages/ui/src/mediator/overlay.ts:66-73`
- Modify: `packages/ui/src/runtime/api.ts:1`（import）、`:60-61` の後ろ（型）、`:144-145` の後ろ（実装）
- Modify: `packages/ui/src/runtime/runtime.ts:390-391` の後ろ
- Modify: `packages/ui/src/test/fakeApi.ts:7`（`Extras`）、`:48-49` の後ろ
- Test: `packages/ui/src/mediator/transition.test.ts`、`packages/ui/src/runtime/api.test.ts`、`packages/ui/src/runtime/runtime.test.ts`（それぞれ末尾に describe）

**Interfaces:**
- Consumes: Task 2 の `SessionStatus`・`SessionStateDto`、Task 9 の HTTP
- Produces（契約のまま）:
  - Intent：`session.state.set { id, status, note?, returnOn? }`、`session.state.confirm { id, returnOn? }`、`session.state.reject { id }`、`session.pause.open { id, from: 'menu' | 'candidate' }`、`session.pause.close`
  - Effect：`api.setSessionState { id, body }`、`api.confirmSessionState { id, body }`、`api.rejectSessionState { id }`
  - `deps.api.setSessionState(id, body)`・`confirmSessionState(id, body)`・`rejectSessionState(id)`、どれも `Promise<{ state: SessionStateDto }>`
- Produces（契約に足すもの）：Overlay `{ kind: 'pause'; sessionId: string; from: 'menu' | 'candidate' }`（Task 14 の Paused の入力が読む）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/mediator/transition.test.ts` の末尾に足す。

```ts
describe('セッションの状態', () => {
  it('状態の操作は api 効果になる。本文には渡されたものだけを載せる', () => {
    const r = run([
      intent({ type: 'session.state.set', id: 's1', status: 'done' }),
      intent({ type: 'session.state.set', id: 's1', status: 'paused', note: '明日見る', returnOn: '2026-10-02' }),
      intent({ type: 'session.state.set', id: 's1', status: null }),
      intent({ type: 'session.state.confirm', id: 's1' }),
      intent({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05' }),
      intent({ type: 'session.state.reject', id: 's1' }),
    ]);
    expect(r.effects).toEqual([
      { kind: 'api.setSessionState', id: 's1', body: { status: 'done' } },
      { kind: 'api.setSessionState', id: 's1', body: { status: 'paused', note: '明日見る', returnOn: '2026-10-02' } },
      { kind: 'api.setSessionState', id: 's1', body: { status: null } },
      { kind: 'api.confirmSessionState', id: 's1', body: {} },
      { kind: 'api.confirmSessionState', id: 's1', body: { returnOn: '2026-10-05' } },
      { kind: 'api.rejectSessionState', id: 's1' },
    ]);
    expect(r.state).toEqual(initialState());
  });
  it('Paused の入力を開いて閉じる。そのセッションへ送ったら閉じる', () => {
    const opened = run([intent({ type: 'session.pause.open', id: 's1', from: 'candidate' })]);
    expect(opened.state.overlay).toEqual({ kind: 'pause', sessionId: 's1', from: 'candidate' });
    expect(run([intent({ type: 'session.pause.close' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    expect(run([intent({ type: 'overlay.close' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    expect(run([intent({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    expect(run([intent({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-02' })], opened.state).state.overlay).toEqual({ kind: 'none' });
    // 別のセッションへの操作では閉じない。
    expect(run([intent({ type: 'session.state.set', id: 's2', status: 'done' })], opened.state).state.overlay).toEqual({ kind: 'pause', sessionId: 's1', from: 'candidate' });
  });
  it('入力のあるダイアログの上には開かない', () => {
    const busy: State = { ...initialState(), overlay: { kind: 'promote', sessionId: 's9' } };
    expect(run([intent({ type: 'session.pause.open', id: 's1', from: 'menu' })], busy).state.overlay).toEqual({ kind: 'promote', sessionId: 's9' });
  });
});
```

`packages/ui/src/runtime/api.test.ts` の末尾に足す。

```ts
describe('createApi（セッションの状態）', () => {
  it('経路とメソッドと本文', async () => {
    const { api, calls } = harness(200, { state: { status: 'done', note: null, returnOn: null, setBy: 'user', setAt: 1, candidate: null } });
    expect(await api.setSessionState('s1', { status: 'done' })).toMatchObject({ state: { status: 'done' } });
    await api.setSessionState('s1', { status: null });
    await api.confirmSessionState('s1', { returnOn: '2026-10-05' });
    await api.confirmSessionState('s1', {});
    await api.rejectSessionState('s1');
    expect(calls.map((c) => `${c.method} ${c.url} ${c.body ?? ''}`)).toEqual([
      'PUT /api/sessions/s1/state {"status":"done"}',
      'PUT /api/sessions/s1/state {"status":null}',
      'POST /api/sessions/s1/state/confirm {"returnOn":"2026-10-05"}',
      'POST /api/sessions/s1/state/confirm {}',
      'POST /api/sessions/s1/state/reject ',
    ]);
  });
  it('409 の本文の一文をそのまま投げる', async () => {
    const ng = harness(409, { error: 'このセッションには確かめる提案がありません' });
    await expect(ng.api.confirmSessionState('s1', {})).rejects.toThrow('このセッションには確かめる提案がありません');
  });
});
```

`packages/ui/src/runtime/runtime.test.ts` の末尾に足す。

```ts
describe('セッションの状態', () => {
  const NONE = { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null };
  it('状態の操作をそのまま API へ渡し、失敗はトーストにする', async () => {
    const setSessionState = vi.fn(async () => { throw new Error('Paused には戻る日が要ります'); });
    const confirmSessionState = vi.fn(async () => ({ state: NONE }));
    const rejectSessionState = vi.fn(async () => ({ state: NONE }));
    const { rt, wsHandlers } = harness({ setSessionState, confirmSessionState, rejectSessionState });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.state.set', id: 's1', status: 'paused' });
    rt.emit({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05' });
    rt.emit({ type: 'session.state.reject', id: 's1' });
    await flush();
    expect(setSessionState).toHaveBeenCalledWith('s1', { status: 'paused' });
    expect(confirmSessionState).toHaveBeenCalledWith('s1', { returnOn: '2026-10-05' });
    expect(rejectSessionState).toHaveBeenCalledWith('s1');
    expect(rt.getState().toasts.at(-1)).toMatchObject({ level: 'error', message: 'Paused には戻る日が要ります' });
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/mediator/transition.test.ts packages/ui/src/runtime/api.test.ts packages/ui/src/runtime/runtime.test.ts`
Expected: FAIL（効果が空、`api.setSessionState is not a function`）

- [ ] **Step 3: 実装する**

`packages/shared/src/intent.ts:1` の後ろに足す。

```ts
import type { SessionStatus } from './sessionState.ts';
```

`packages/shared/src/intent.ts:44`（`session.open` と `session.setMemo` の行）の後ろに足す。

```ts
  // セッションの状態（Paused・Done・Archived）。status の null は印なしに戻す。画面の正は後から届く session.upsert である。
  | { type: 'session.state.set'; id: SessionId; status: SessionStatus | null; note?: string; returnOn?: string }
  // 提案の確定と却下。確定で日を変えたときだけ returnOn を添える。
  | { type: 'session.state.confirm'; id: SessionId; returnOn?: string } | { type: 'session.state.reject'; id: SessionId }
  // Paused の入力（B1）。from は開いた入口で、提案の「日を変える」から開いたときは根拠を下書きに入れる。
  | { type: 'session.pause.open'; id: SessionId; from: 'menu' | 'candidate' } | { type: 'session.pause.close' }
```

`packages/ui/src/mediator/types.ts:1` の shared の import に `SessionStatus` を足す。

```ts
import type { IndexProgressDto, Intent, LaunchParams, ProjectStatus, ResolveAction, RetentionFrom, Route, SearchFilter, SearchParamsDto, ServerEvent, SessionStatus, SettingsDto } from '@agent-hangar/shared';
```

`packages/ui/src/mediator/types.ts:87`（`api.rejectTodo`）の後ろに足す。

```ts
  // セッションの状態。本文には渡されたものだけを載せる。
  | { kind: 'api.setSessionState'; id: string; body: { status: SessionStatus | null; note?: string; returnOn?: string } }
  | { kind: 'api.confirmSessionState'; id: string; body: { returnOn?: string } }
  | { kind: 'api.rejectSessionState'; id: string }
```

`packages/ui/src/mediator/types.ts:128`（`Overlay` の `retention` の行）の末尾 `;` を外して、後ろに足す。

```ts
  | { kind: 'retention'; days: number; from: RetentionFrom; reloaded: boolean; writing: boolean; previewError: string | null }
  // Paused の入力（B1）。from は開いた入口（「⋯」か提案の「日を変える」）。
  | { kind: 'pause'; sessionId: string; from: 'menu' | 'candidate' };
```

`packages/ui/src/mediator/workbench.ts:1` の import を差し替え、`splitId` の前に足す。

```ts
import type { PaletteCommand, SessionStatus } from '@agent-hangar/shared';
```

```ts
/** Paused の入力をそのセッションへ送ったら閉じる。別のセッションへの操作では閉じない。 */
const closePause = (state: State, id: string): State => (state.overlay.kind === 'pause' && state.overlay.sessionId === id ? { ...state, overlay: { kind: 'none' } } : state);
/** 状態の本文。渡されたものだけを載せる（省いた理由で、サーバの今の理由を消さないため）。 */
const stateBody = (i: { status: SessionStatus | null; note?: string; returnOn?: string }) => ({ status: i.status, ...(i.note !== undefined ? { note: i.note } : {}), ...(i.returnOn !== undefined ? { returnOn: i.returnOn } : {}) });
```

`packages/ui/src/mediator/workbench.ts:68`（`todo.reject`）の後ろに足す。

```ts
    case 'session.state.set': return { state: closePause(state, i.id), effects: [{ kind: 'api.setSessionState', id: i.id, body: stateBody(i) }] };
    case 'session.state.confirm': return { state: closePause(state, i.id), effects: [{ kind: 'api.confirmSessionState', id: i.id, body: i.returnOn !== undefined ? { returnOn: i.returnOn } : {} }] };
    case 'session.state.reject': return { state, effects: [{ kind: 'api.rejectSessionState', id: i.id }] };
```

`packages/ui/src/mediator/overlay.ts:72`（`palette.close`）の後ろに足す。

```ts
    // Paused の入力（B1）。確認や入力のあるダイアログの上には重ねない。閉じるのは overlay.close（Esc）でもよい。
    case 'session.pause.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'pause', sessionId: i.id, from: i.from } }, effects: [] } : { state, effects: [] };
    case 'session.pause.close': return { state: state.overlay.kind === 'pause' ? { ...state, overlay: { kind: 'none' } } : state, effects: [] };
```

`packages/ui/src/runtime/api.ts:1` の import に `SessionStateDto, SessionStatus` を足す。`:61`（`rejectTodo`）の後ろに足す。

```ts
  /** セッションの状態を手で変える。status の null は印なしに戻す。返り値は使わない（画面の正は session.upsert）。 */
  setSessionState(id: string, body: { status: SessionStatus | null; note?: string; returnOn?: string }): Promise<{ state: SessionStateDto }>;
  /** 提案を確定する。日を変えたときだけ returnOn を渡す。提案が無ければ 409 の一文で投げる。 */
  confirmSessionState(id: string, body: { returnOn?: string }): Promise<{ state: SessionStateDto }>;
  rejectSessionState(id: string): Promise<{ state: SessionStateDto }>;
```

`:145`（`rejectTodo` の実装）の後ろに足す。

```ts
    setSessionState: (id, body) => call(`/api/sessions/${id}/state`, { method: 'PUT', body: JSON.stringify(body) }),
    confirmSessionState: (id, body) => post(`/api/sessions/${id}/state/confirm`, body),
    rejectSessionState: (id) => post(`/api/sessions/${id}/state/reject`),
```

`packages/ui/src/runtime/runtime.ts:391`（`api.rejectTodo`）の後ろに足す。

```ts
      // セッションの状態。画面の正は後から届く session.upsert なので、返り値はストアに入れない。失敗の一文はトーストに出す。
      case 'api.setSessionState': deps.api.setSessionState(e.id, e.body).catch(fail); return;
      case 'api.confirmSessionState': deps.api.confirmSessionState(e.id, e.body).catch(fail); return;
      case 'api.rejectSessionState': deps.api.rejectSessionState(e.id).catch(fail); return;
```

`packages/ui/src/test/fakeApi.ts:7` の `| 'confirmTodo' | 'rejectTodo'` の後ろに `| 'setSessionState' | 'confirmSessionState' | 'rejectSessionState'` を足し、`:49`（`rejectTodo` の偽物）の後ろに足す。

```ts
    setSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null } })),
    confirmSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null } })),
    rejectSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null } })),
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui/src/mediator/ packages/ui/src/runtime/ && npm run typecheck`
Expected: PASS、型の誤り 0 件（`runtime.ts:475` の網羅の検査も通る）

- [ ] **Step 5: Commit**

```bash
git commit packages/shared/src/intent.ts packages/ui/src/mediator/types.ts packages/ui/src/mediator/workbench.ts packages/ui/src/mediator/overlay.ts packages/ui/src/runtime/api.ts packages/ui/src/runtime/runtime.ts packages/ui/src/test/fakeApi.ts packages/ui/src/mediator/transition.test.ts packages/ui/src/runtime/api.test.ts packages/ui/src/runtime/runtime.test.ts -m "feat(ui): wire session state intents, effects and API" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 行の Presenter に状態を写す

**Files:**
- Modify: `packages/ui/src/presenters/row.ts:1`（import）、`:14-16`（`SessionRowProps`）、`:29-39`（`presentSessionRow`）、末尾（文言の関数）
- Modify: `packages/ui/src/views/SessionRows.test.tsx:12`、`:48-51`、`:215`（行の作り手に新しい項目を足す）
- Modify: `packages/ui/src/views/misc.test.tsx:13`（同上）
- Test: `packages/ui/src/presenters/presenters.test.ts`（末尾に describe）

**Interfaces:**
- Consumes: Task 2 の `overdueDays`・`SessionStatus`・`StateSetBy`・`CandidateSource`、`SessionDto.state`
- Produces（契約のまま）：`SessionRowProps` に `state: SessionStatus | null`、`returnOn: string | null`、`overdueDays: number | null`、`candidate: { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; ago: string } | null`、`setBy: StateSetBy | null`
- Produces（契約に足すもの、Task 12・13 の View が使う）：
  - `returnOnLabel(returnOn: string, overdue: number | null): string`（今日は「今日」、過ぎたものは「N 日過ぎ」、先は「10/2（金）」）
  - `candidateLabel(c: { status: 'paused' | 'done'; returnOn: string | null }): string`（「Done にする？」「Paused · 10/2（金）？」）
  - `CANDIDATE_SOURCE_LABEL: Record<CandidateSource, string>`（会話・抜けるとき・要約）
  - `STATUS_LABEL: Record<SessionStatus, string>`（Paused・Done・Archived）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/presenters/presenters.test.ts` の 2 行目の shared の import に `addDays, localDate` を足し（値の import に分ける）、13 行目を差し替える。

```ts
import { addDays, localDate } from '@agent-hangar/shared';
```

```ts
import { candidateLabel, presentSessionRow, returnOnLabel } from './row.ts';
```

末尾に足す。

```ts
describe('presentSessionRow のセッションの状態', () => {
  const store = initialStore();
  const today = localDate(NOW);
  const withState = (state: SessionDto['state']) => session('s1', { state });
  const pick = (s: SessionDto) => { const r = presentSessionRow(s, store, NOW); return { state: r.state, returnOn: r.returnOn, overdueDays: r.overdueDays, candidate: r.candidate, setBy: r.setBy }; };
  it('state が欠けた古いサーバの行と null は、印なしとして読む', () => {
    const none = { state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null };
    expect(pick(session('s1'))).toEqual(none);
    expect(pick(withState(null))).toEqual(none);
  });
  it('Paused は戻る日と過ぎた日数を持ち、Done と Archived は戻る日を持たない', () => {
    expect(pick(withState({ status: 'paused', note: '見る', returnOn: addDays(today, -2), setBy: 'user', setAt: 1, candidate: null }))).toEqual({ state: 'paused', returnOn: addDays(today, -2), overdueDays: 2, candidate: null, setBy: 'user' });
    expect(pick(withState({ status: 'paused', note: null, returnOn: addDays(today, 3), setBy: 'user', setAt: 1, candidate: null })).overdueDays).toBeNull();
    expect(pick(withState({ status: 'done', note: null, returnOn: '2026-10-02', setBy: 'conversation', setAt: 1, candidate: null }))).toEqual({ state: 'done', returnOn: null, overdueDays: null, candidate: null, setBy: 'conversation' });
    expect(pick(withState({ status: 'archived', note: null, returnOn: null, setBy: 'import', setAt: 1, candidate: null })).state).toBe('archived');
  });
  it('提案は経過時間を添える', () => {
    const r = pick(withState({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: { status: 'done', note: '直した', returnOn: null, source: 'post_hoc', at: NOW - 12 * 60_000 } }));
    expect(r).toEqual({ state: null, returnOn: null, overdueDays: null, setBy: null, candidate: { status: 'done', note: '直した', returnOn: null, source: 'post_hoc', ago: '12 分前' } });
  });
});

describe('戻る日と提案の札の文言', () => {
  it('今日は「今日」、過ぎたものは「N 日過ぎ」、先のものは月日と曜日', () => {
    expect(returnOnLabel('2026-10-01', 0)).toBe('今日');
    expect(returnOnLabel('2026-09-28', 3)).toBe('3 日過ぎ');
    expect(returnOnLabel('2026-10-02', null)).toBe('10/2（金）');
    expect(returnOnLabel('2026-12-31', null)).toBe('12/31（木）');
  });
  it('提案の札は「Done にする？」か「Paused · 日？」', () => {
    expect(candidateLabel({ status: 'done', returnOn: null })).toBe('Done にする？');
    expect(candidateLabel({ status: 'paused', returnOn: '2026-10-05' })).toBe('Paused · 10/5（月）？');
  });
});
```

`packages/ui/src/views/SessionRows.test.tsx:12` と `:215`、`packages/ui/src/views/misc.test.tsx:13` の行の作り手の `runId: null` の後ろ（`...over` があればその前）に足す。`:48-51` の `p3Row` の `runId: null,` の後ろにも足す。

```ts
state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null,
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts`
Expected: FAIL（`returnOnLabel is not a function`、`state` が `undefined`）

- [ ] **Step 3: 実装する**

`packages/ui/src/presenters/row.ts:1` を差し替える。

```ts
import { overdueDays, type CandidateSource, type LiveStatus, type SessionDto, type SessionStatus, type SessionSummaryDto, type StateSetBy } from '@agent-hangar/shared';
```

`SessionRowProps`（14-16 行）を差し替える。

```ts
export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; summaryState: SummaryStateTag | null; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; transcript: TranscriptMark; cost: string; runId: string | null; excerpt?: Segment[];
  /** 検索の結果の行を開いたときの跳び先（抜粋の seq と検索語）。 */
  jump?: { seq: number; q: string };
  /** セッションの状態。印なしは null。 */
  state: SessionStatus | null;
  /** Paused の戻る日（YYYY-MM-DD）。Paused 以外は null。 */
  returnOn: string | null;
  /** 戻る日が今日か過ぎていれば過ぎた日数（今日は 0）、先なら null。 */
  overdueDays: number | null;
  /** Claude の提案。状態が付いていれば null（サーバの toStateDto が状態を正にしている）。 */
  candidate: { status: 'paused' | 'done'; note: string | null; returnOn: string | null; source: CandidateSource; ago: string } | null;
  /** 状態を誰が付けたか。conversation は会話で利用者が選んだもので、札に「会話で承認」と添える。印なしは null。 */
  setBy: StateSetBy | null };
```

`presentSessionRow`（29-39 行）の `const row: SessionRowProps = {` の前に足し、`cost: ..., runId: ...,` の行の後ろに足す。

```ts
  // 古いサーバは state を送らない。欠けたものは印なしとして読む。
  const st = s.state ?? null;
  const status = st?.status ?? null;
  const returnOn = status === 'paused' ? st!.returnOn : null;
```

```ts
    state: status, returnOn, overdueDays: returnOn ? overdueDays(returnOn, now) : null,
    candidate: st?.candidate ? { status: st.candidate.status, note: st.candidate.note, returnOn: st.candidate.returnOn, source: st.candidate.source, ago: relativeTime(st.candidate.at, now) } : null,
    setBy: status ? st!.setBy : null,
```

`packages/ui/src/presenters/row.ts` の末尾に足す。

```ts
/** 状態の札の語。プロジェクトの状態と同じ英語にする。 */
export const STATUS_LABEL: Record<SessionStatus, string> = { paused: 'Paused', done: 'Done', archived: 'Archived' };
/** 提案の出どころの語。ポップに「出どころ：会話 · 12 分前」と出す。 */
export const CANDIDATE_SOURCE_LABEL: Record<CandidateSource, string> = { in_session: '会話', exit: '抜けるとき', post_hoc: '要約' };

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 戻る日の札の文言。今日は「今日」、過ぎたものは「N 日過ぎ」、先のものは「10/2（金）」。
 * 曜日は日付だけから決まるので、今の時刻は要らない（過ぎたかどうかは overdue で受け取る）。
 */
export function returnOnLabel(returnOn: string, overdue: number | null): string {
  if (overdue === 0) return '今日';
  if (overdue !== null) return `${overdue} 日過ぎ`;
  const [y, m, d] = returnOn.split('-').map(Number);
  return `${m}/${d}（${WEEKDAY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]}）`;
}

/** 提案の札の文言（Q3 の枠だけの札）。 */
export function candidateLabel(c: { status: 'paused' | 'done'; returnOn: string | null }): string {
  return c.status === 'done' ? 'Done にする？' : `Paused · ${c.returnOn ? returnOnLabel(c.returnOn, null) : '日付なし'}？`;
}
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/ packages/ui/src/views/ && npm run typecheck --workspace packages/ui`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git commit packages/ui/src/presenters/row.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/SessionRows.test.tsx packages/ui/src/views/misc.test.tsx -m "feat(ui): present session state on rows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 行の札と「⋯」（A2）

**Files:**
- Modify: `packages/ui/src/views/primitives/MenuButton.tsx:13`（`MenuItem` に `kbd`）、`:101-106`（打鍵）、`:126-132`（描き方）
- Modify: `packages/ui/src/views/SessionRows.tsx:1-7`（import）、`:10` の後ろ（定数と 4 択）、`:135-145`（打鍵 `.`）、`:168`（2 段目の頭）、`:189-193`（右端）
- Modify: `packages/ui/src/keys.ts:12`、`:60` の後ろ
- Modify: `packages/ui/src/styles/rows.css:88` の後ろ、`packages/ui/src/styles/controls.css:138` の後ろ
- Test: `packages/ui/src/views/primitives/MenuButton.test.tsx`、`packages/ui/src/views/SessionRows.test.tsx`、`packages/ui/src/styles/tokens.test.ts`、`packages/ui/src/keys.test.ts`

**Interfaces:**
- Consumes: Task 10 の Intent、Task 11 の `SessionRowProps` の新しい項目と `returnOnLabel`・`STATUS_LABEL`
- Produces:
  - `MenuItem.kbd?: string`（メニューが開いている間、その 1 字で選べる）
  - 行の右端：`[本文の期限の印][動きの語 .row-live][提案の札（Task 13）][状態の札 .row-sq][「⋯」 .row-more] 時刻`。2 段目の頭は Paused なら `.row-return`（`data-due` は当日と過ぎたもの）、ほかは今の `.row-state`。
  - `module` の上の試験の作り手 `sr`・`mount`・`opened`（`SessionRows.test.tsx` の末尾。Task 13 も使う）

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/views/primitives/MenuButton.test.tsx` の `describe('MenuButton')` の最後の `it` の後ろに足す。

```tsx
  it('打鍵の印のある項目は、その 1 字で選ぶ。修飾付きと押せない項目は選ばない', () => {
    const onSelect = vi.fn();
    const off = vi.fn();
    render(<MenuButton label="状態" items={[{ key: 'd', label: 'Done にする', kbd: 'd', onSelect }, { key: 'a', label: 'Archived にする', kbd: 'a', disabled: 'すでに Archived です', onSelect: off }]} />);
    fireEvent.click(screen.getByRole('button', { name: '状態' }));
    expect(screen.getAllByRole('menuitem')[0]!.querySelector('kbd')).toHaveTextContent('d');
    fireEvent.keyDown(document.activeElement!, { key: 'd', metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    expect(off).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
```

`packages/ui/src/views/SessionRows.test.tsx` の末尾に足す。

```tsx
/** 状態の試験の行。Task 13 の提案の試験も使う。 */
const sr = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: '名前 ' + id, oneLiner: '要約 ' + id, projectName: 'alpha', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null, ...over });
const mount = (rows: SessionRowProps[], onIntent = vi.fn()) => {
  render(<IntentRoot onIntent={onIntent}><SessionRows rows={rows} height={400} variant="project" /></IntentRoot>);
  return onIntent;
};
/** 行が開いたか。押した操作の器がクリックを止め損ねると、ここに session.open が積まれる。 */
const opened = (onIntent: ReturnType<typeof vi.fn>) => onIntent.mock.calls.filter(([i]) => (i as { type: string }).type === 'session.open');
const labels = () => screen.getAllByRole('menuitem').map((i) => i.querySelector('.menu-item-text > span')?.textContent);

describe('セッションの状態の札と「⋯」', () => {
  it('動きの語、状態の札、戻る日の札を描き分ける', () => {
    mount([
      sr('a', { live: 'waiting' }),
      sr('b', { live: 'idle' }),
      sr('c', { state: 'done', setBy: 'conversation' }),
      sr('d', { state: 'archived', setBy: 'user' }),
      sr('e', { state: 'paused', returnOn: '2026-09-29', overdueDays: 2, summaryState: { label: '済んだ', tone: null } }),
      sr('f', { state: 'paused', returnOn: '2026-10-02', overdueDays: null }),
    ]);
    expect(screen.getByText('入力待ち')).toHaveClass('row-live');
    expect(screen.getByText('実行中')).toHaveAttribute('data-live', 'busy');
    expect(screen.getByText('Done')).toHaveAttribute('title', '会話で承認');
    expect(screen.getByText('Archived')).not.toHaveAttribute('title');
    expect(screen.getByText('2 日過ぎ')).toHaveAttribute('data-due', 'true');
    // Paused の行の 2 段目の頭は戻る日の札で、要約の見立ての札は出さない。Paused は四角の札を出さない。
    expect(screen.queryByText('済んだ')).toBeNull();
    expect(screen.queryByText('Paused')).toBeNull();
    expect(screen.getByText('10/2（金）')).not.toHaveAttribute('data-due');
  });
  it('「⋯」から 4 択を選ぶ。押しても行は開かない', () => {
    const onIntent = mount([sr('a')]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a の状態' }));
    expect(labels()).toEqual(['Paused にする…', 'Done にする', 'Archived にする', '印なしに戻す']);
    expect(screen.getAllByRole('menuitem').map((i) => i.querySelector('kbd')?.textContent)).toEqual(['p', 'd', 'a', 'u']);
    expect(screen.getAllByRole('menuitem')[3]).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getAllByRole('menuitem')[1]!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: 'done' });
    expect(opened(onIntent)).toEqual([]);
  });
  it('付いている状態は選べず、印なしに戻すは選べる', () => {
    const onIntent = mount([sr('a', { state: 'done' })]);
    fireEvent.click(screen.getByRole('button', { name: '名前 a の状態' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    expect(items[1]).toHaveTextContent('すでに Done です');
    fireEvent.click(items[3]!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 'a', status: null });
  });
  it('打鍵 . でカーソルの行の「⋯」を開き、印の 1 字で選ぶ', () => {
    const onIntent = mount([sr('a'), sr('b', { state: 'done' })]);
    const rb = screen.getByText('名前 b').closest('[role="row"]') as HTMLElement;
    act(() => rb.focus());
    fireEvent.keyDown(rb, { key: '.' });
    expect(screen.getByRole('menu', { name: '名前 b の状態' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'p' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.pause.open', id: 'b', from: 'menu' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(opened(onIntent)).toEqual([]);
  });
  it('メモを書いている欄の . は文字で、メニューを開かない', () => {
    mount([sr('a')]);
    const ra = screen.getByText('名前 a').closest('[role="row"]') as HTMLElement;
    act(() => ra.focus());
    fireEvent.keyDown(ra, { key: 'm' });
    fireEvent.keyDown(screen.getByLabelText('名前 a のメモ'), { key: '.' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('「⋯」はポインタを乗せた行、カーソルの行、焦点のある行、開いている間だけ見せる', () => {
    expect(rowsCss).toMatch(/\.row-more \{[^}]*visibility: hidden;/);
    expect(rowsCss).toMatch(/\.row:hover \.row-more, \.row:focus-within \.row-more, \.row\[data-cursor='true'\] \.row-more, \.row-more:has\(\[aria-expanded='true'\]\) \{[^}]*visibility: visible;/);
  });
});
```

`packages/ui/src/styles/tokens.test.ts` の `describe('tokens.css (候補)', ...)` の直後に足す。

```ts
describe('tokens.css（セッションの状態）', () => {
  const rows = fs.readFileSync(new URL('./rows.css', import.meta.url), 'utf8');
  it('塗りの戻る日の札は、--st-paused の地に白い文字で 4.5:1 を超える', () => {
    expect(rows).toMatch(/\.row-return\[data-due='true'\] \{[^}]*color: #ffffff;[^}]*background: var\(--st-paused\);/);
    expect(contrast('#ffffff', token('--st-paused'))).toBeGreaterThan(4.5);
  });
  it('淡い地の札と枠だけの提案の札の文字も 4.5:1 を超える', () => {
    for (const [fg, bg] of [['--st-paused', '--st-paused-soft'], ['--st-done', '--st-done-soft'], ['--st-archived', '--st-archived-soft'], ['--cand', '--surface'], ['--cand', '--accent-soft']] as const) {
      expect(contrast(token(fg), token(bg)), `${fg} / ${bg}`).toBeGreaterThan(4.5);
    }
  });
});
```

`packages/ui/src/keys.test.ts:88` の後ろに足す。

```ts
    expect(KEYMAP.find((b) => b.id === 'list.state')?.keys).toBe('.');
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/MenuButton.test.tsx packages/ui/src/views/SessionRows.test.tsx packages/ui/src/styles/tokens.test.ts packages/ui/src/keys.test.ts`
Expected: FAIL（`名前 a の状態` のボタンが無い、`kbd` が無い、`.row-return` の規則が無い）

- [ ] **Step 3: MenuButton に打鍵の印を足す**

`packages/ui/src/views/primitives/MenuButton.tsx:13` の上のコメントの末尾に 1 行足し、型を差し替える。

```ts
 * kbd は打鍵の印。メニューが開いている間、その 1 字で選べる（「⋯」の p・d・a・u など）。
 */
export type MenuItem = { key: string; label: string; icon?: IconName; note?: string | null; disabled?: string | null; danger?: boolean; kbd?: string; onSelect: () => void };
```

`onMenuKey` の `default: return;`（105 行）を差し替える。

```ts
      default: {
        // 打鍵の印のある項目は、その 1 字で選ぶ。修飾の付いた打鍵はアプリ全体のものなので使わない。
        const hit = !e.metaKey && !e.ctrlKey && !e.altKey ? props.items.find((it) => it.kbd !== undefined && it.kbd === e.key) : undefined;
        if (!hit) return;
        choose(hit);
        break;
      }
```

項目の描き方（128-131 行）の `</span>`（`menu-item-text` の閉じ）の後ろに足す。

```tsx
                {item.kbd && <kbd className="menu-kbd">{item.kbd}</kbd>}
```

`packages/ui/src/styles/controls.css:138`（`.menu-item-text small`）の後ろに足す。

```css
/* 打鍵の印。開いている間、その 1 字で選べる。 */
.menu-kbd { margin-left: auto; align-self: center; padding: 0 5px; border-radius: 4px; font-family: var(--font-sans); font-size: var(--fs-xs); color: var(--ink-2); background: var(--surface-2); }
```

- [ ] **Step 4: 行の札と「⋯」を描く**

`packages/ui/src/views/SessionRows.tsx:1-7` の import を差し替える。

```tsx
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { SessionStatus } from '@agent-hangar/shared';
import { useEmit, type Emit } from '../intent/chain.tsx';
import { returnOnLabel, STATUS_LABEL, type SessionRowProps } from '../presenters/row.ts';
import { Icon } from './primitives/Icon.tsx';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';
```

`GONE_LABEL`（10 行）の後ろに足す。

```tsx
/** 会話の中で利用者が選んだ状態（set_by が conversation）の札の注記。hangar は会話での承認を確かめられないので、後から分かるようにする。 */
const CONVERSATION_NOTE = '会話で承認';
/**
 * 動きの語。入力待ちと実行中だけを語にし、止まっているものは点だけにする。
 * 休みは実行中に数える（shared の liveFilterOf と同じ）。細かい区別は点が読み上げるので、語は読み上げに重ねない。
 */
const LIVE_WORD = { waiting: '入力待ち', busy: '実行中', idle: '実行中' } as const;

/**
 * 行の中の操作の器のクリックを止める。止めないと、押したときに行も開く。
 * メニューは document.body への portal に描くが、React のイベントは portal の中からも React の木を伝ってここへ上がるので、項目のクリックもここで止まる。
 */
const stopClick = (e: ReactMouseEvent) => e.stopPropagation();

/** 「⋯」の 4 択（A2）。打鍵の印は試作 rest.html の A2 のとおり。付いている状態と、外すものの無い「印なしに戻す」は理由を添えて押せなくする。 */
function stateItems(r: SessionRowProps, emit: Emit): MenuItem[] {
  const set = (status: SessionStatus | null) => () => emit({ type: 'session.state.set', id: r.id, status });
  return [
    { key: 'paused', label: 'Paused にする…', kbd: 'p', onSelect: () => emit({ type: 'session.pause.open', id: r.id, from: 'menu' }) },
    { key: 'done', label: 'Done にする', kbd: 'd', disabled: r.state === 'done' ? 'すでに Done です' : null, onSelect: set('done') },
    { key: 'archived', label: 'Archived にする', kbd: 'a', disabled: r.state === 'archived' ? 'すでに Archived です' : null, onSelect: set('archived') },
    { key: 'none', label: '印なしに戻す', kbd: 'u', disabled: r.state === null && r.candidate === null ? '印は付いていません' : null, onSelect: set(null) },
  ];
}
```

`onKeyDown` の `case 'm': if (cur) startEdit(cur); break;`（143 行）の後ろに足す。

```tsx
      // 状態の 4 択。カーソルの行の「⋯」を押したのと同じにする（見えていなくても押せる）。
      case '.': if (cur) cursorRow()?.querySelector<HTMLButtonElement>('.row-more button')?.click(); break;
```

`sub` の 2 段目の頭（168 行）を差し替える。

```tsx
        {/* Paused は 2 段目の頭に戻る日の札を出す（四角の札は出さない）。当日と過ぎたものは塗る。 */}
        {r.state === 'paused' && r.returnOn
          ? <span className="row-return" data-due={r.overdueDays !== null ? 'true' : undefined} title={r.setBy === 'conversation' ? CONVERSATION_NOTE : undefined}>{returnOnLabel(r.returnOn, r.overdueDays)}</span>
          : r.summaryState && <span className="row-state" data-tone={r.summaryState.tone ?? undefined}>{r.summaryState.label}</span>}
```

`side` の `row-when`（189-193 行）を差し替える。

```tsx
      {/* 本文の期限の印、動きの語、提案の札、状態の札、「⋯」を時刻の左に並べる（設計の「行」の順）。
          消えかけは琥珀のチップで先に知らせ、消えた会話は文字の無い印だけにする。消えた会話は数百件に上るので、文字を並べると一覧が騒がしくなる。 */}
      <span className="row-when">
        {r.transcript === 'expiring' && <span className="row-soon">まもなく削除</span>}
        {r.transcript === 'gone' && <span className="row-gone" title={GONE_LABEL}><Icon name="transcriptGone" label={GONE_LABEL} /></span>}
        {r.live && <span className="row-live" data-live={r.live === 'waiting' ? 'waiting' : 'busy'} aria-hidden="true">{LIVE_WORD[r.live]}</span>}
        {(r.state === 'done' || r.state === 'archived') && <span className="row-sq" data-s={r.state} title={r.setBy === 'conversation' ? CONVERSATION_NOTE : undefined}>{STATUS_LABEL[r.state]}</span>}
        <span className="row-act row-more" onClick={stopClick}>
          <MenuButton label={`${r.name} の状態`} items={stateItems(r, emit)} faceClassName="btn btn-icon row-more-btn" minWidth={220} />
        </span>
        <RelativeTime label={r.when} abs={r.whenAbs} />
      </span>
```

`packages/ui/src/keys.ts:12` の `| 'list.memo'` を `| 'list.memo' | 'list.state'` にし、`:60`（`list.memo`）の後ろに足す。

```ts
  { id: 'list.state', group: 'list', keys: '.', label: '状態を変える（⋯）', chords: [] },
```

`packages/ui/src/styles/rows.css:88`（`.row-meta`）の後ろに足す。

```css
/* セッションの状態（試作 model-v3）。動きは日本語と丸い点、状態は英語と四角の札、提案は紫の枠だけの丸い札、戻る日は黄土の丸い札で描き分ける。 */
.row-live { flex: none; font-size: var(--fs-xs); font-weight: 600; }
.row-live[data-live='waiting'] { color: var(--waiting); }
.row-live[data-live='busy'] { color: var(--busy); }
.row-sq { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px; font-size: var(--fs-xs); font-weight: 600; }
.row-sq[data-s='done'] { color: var(--st-done); background: var(--st-done-soft); }
.row-sq[data-s='archived'] { color: var(--st-archived); background: var(--st-archived-soft); }
/* 戻る日。当日と過ぎたものは塗る（地が --st-paused、文字が白。tokens.test.ts が 4.5 : 1 を見張る）。 */
.row-return { flex: none; display: inline-flex; align-items: center; padding: 1px 7px; border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 600; line-height: 1.4; color: var(--st-paused); background: var(--st-paused-soft); white-space: nowrap; }
.row-return[data-due='true'] { color: #ffffff; background: var(--st-paused); }
/* 行の中の操作の器（提案の札と「⋯」）。押しても行が開かないよう、SessionRows がクリックを止める。 */
.row-act { flex: none; display: inline-flex; }
/* 「⋯」（A2）。ポインタを乗せた行、カーソルの行、焦点のある行、開いている間だけ見せる。隠している間も場所は取り、時刻の位置を動かさない。 */
.row-more { visibility: hidden; }
.row:hover .row-more, .row:focus-within .row-more, .row[data-cursor='true'] .row-more, .row-more:has([aria-expanded='true']) { visibility: visible; }
.row-more .row-more-btn { width: calc(var(--u) * 6); height: calc(var(--u) * 5); padding: 0; }
```

- [ ] **Step 5: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui/ && npm run typecheck --workspace packages/ui`
Expected: PASS、型の誤り 0 件

- [ ] **Step 6: Commit**

```bash
git commit packages/ui/src/views/primitives/MenuButton.tsx packages/ui/src/views/primitives/MenuButton.test.tsx packages/ui/src/views/SessionRows.tsx packages/ui/src/views/SessionRows.test.tsx packages/ui/src/keys.ts packages/ui/src/keys.test.ts packages/ui/src/styles/rows.css packages/ui/src/styles/controls.css packages/ui/src/styles/tokens.test.ts -m "feat(ui): show state chips on rows and a ⋯ menu to change state" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 提案の札とポップ（Q3＋Q1）

**Files:**
- Modify: `packages/ui/src/views/primitives/MenuButton.tsx:25`（props に `head`）、`:121-122`（項目の前に描く）
- Modify: `packages/ui/src/views/SessionRows.tsx`（Task 12 で足した `stateItems` の後ろに `candidatePop`、`row-when` の動きの語の後ろに札）
- Modify: `packages/ui/src/styles/rows.css`（Task 12 で足した `.row-act` の前）、`packages/ui/src/styles/controls.css`（Task 12 で足した `.menu-kbd` の後ろ）
- Test: `packages/ui/src/views/primitives/MenuButton.test.tsx`、`packages/ui/src/views/SessionRows.test.tsx`（末尾）

**Interfaces:**
- Consumes: Task 11 の `candidateLabel`・`returnOnLabel`・`CANDIDATE_SOURCE_LABEL`、Task 12 の `stopClick`・`sr`・`mount`・`opened`・`labels`
- Produces: `MenuButton` の `head?: ReactNode`（項目の前の読むだけの段。フォーカスは止まらない）。提案の札は `.row-cand`。ポップの項目は 確定（`y`）・日を変える（Paused のみ、`c`）・却下（`n`）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/views/primitives/MenuButton.test.tsx` の `describe('MenuButton')` の最後の `it` の後ろに足す。

```tsx
  it('head は項目の前に置く読むだけの段で、フォーカスは最初の項目から始まる', () => {
    render(<MenuButton label="提案" head={<span>根拠の一文</span>} items={[{ key: 'ok', label: '確定', onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button', { name: '提案' }));
    const menu = screen.getByRole('menu', { name: '提案' });
    expect(menu.firstElementChild).toHaveClass('menu-head');
    expect(menu.firstElementChild).toHaveTextContent('根拠の一文');
    expect(document.activeElement).toBe(screen.getByRole('menuitem'));
  });
```

`packages/ui/src/views/SessionRows.test.tsx` の末尾に足す。

```tsx
describe('提案の札とポップ（Q3＋Q1）', () => {
  const cand = { status: 'paused' as const, note: '明日の朝、CPU の数字を確かめる', returnOn: '2026-10-02', source: 'exit' as const, ago: '12 分前' };
  it('枠だけの札を押すと根拠・出どころ・時刻のポップが開き、確定・日を変える・却下を選べる。行は開かない', () => {
    const onIntent = mount([sr('a', { candidate: cand })]);
    const face = screen.getByRole('button', { name: 'Paused · 10/2（金）？' });
    expect(face).toHaveClass('row-cand');
    fireEvent.click(face);
    const menu = screen.getByRole('menu', { name: '名前 a への Claude の提案' });
    expect(menu).toHaveTextContent('Paused · 10/2（金） にしますか');
    expect(menu).toHaveTextContent('明日の朝、CPU の数字を確かめる');
    expect(menu).toHaveTextContent('出どころ：抜けるとき · 12 分前');
    expect(labels()).toEqual(['確定', '日を変える', '却下']);
    // 頭の段にはフォーカスが止まらず、確定から始まる。
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    fireEvent.click(screen.getAllByRole('menuitem')[1]!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.pause.open', id: 'a', from: 'candidate' });
    expect(opened(onIntent)).toEqual([]);
  });
  it('Done の提案には「日を変える」が無く、y で確定、n で却下する', () => {
    const onIntent = mount([sr('a', { candidate: { ...cand, status: 'done', returnOn: null } })]);
    const face = screen.getByRole('button', { name: 'Done にする？' });
    fireEvent.click(face);
    expect(labels()).toEqual(['確定', '却下']);
    fireEvent.keyDown(document.activeElement!, { key: 'y' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.confirm', id: 'a' });
    fireEvent.click(face);
    fireEvent.keyDown(document.activeElement!, { key: 'n' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.reject', id: 'a' });
    expect(opened(onIntent)).toEqual([]);
  });
  it('根拠の無い提案は「根拠は書かれていません」と出す', () => {
    mount([sr('a', { candidate: { ...cand, note: null } })]);
    fireEvent.click(screen.getByRole('button', { name: 'Paused · 10/2（金）？' }));
    expect(screen.getByRole('menu')).toHaveTextContent('根拠は書かれていません');
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/MenuButton.test.tsx packages/ui/src/views/SessionRows.test.tsx`
Expected: FAIL（`Paused · 10/2（金）？` のボタンが無い、`menu-head` が無い）

- [ ] **Step 3: 実装する**

`packages/ui/src/views/primitives/MenuButton.tsx:25` の props の型に `head?: ReactNode;` を足し、その上のコメントの末尾に 1 行足す。

```ts
 * head は項目の前に置く読むだけの段（提案の根拠など）。項目ではないのでフォーカスは止まらない。
 */
export function MenuButton(props: { label: string; items: MenuItem[]; head?: ReactNode; face?: ReactNode; faceClassName?: string; title?: string; minWidth?: number; align?: 'start' | 'end' }) {
```

`role="menu"` の器の中、`{props.items.map((item, i) => (`（122 行）の前に足す。

```tsx
          {props.head && <div className="menu-head">{props.head}</div>}
```

`packages/ui/src/views/SessionRows.tsx` の import の `returnOnLabel, STATUS_LABEL` の行を差し替える。

```tsx
import { CANDIDATE_SOURCE_LABEL, candidateLabel, returnOnLabel, STATUS_LABEL, type SessionRowProps } from '../presenters/row.ts';
```

Task 12 で足した `stateItems` の後ろに足す。

```tsx
/**
 * 提案の札（Q3 の枠だけの札）と、押すと開くポップ（Q1）。
 * ポップの頭に根拠の一文、出どころ、時刻を置き、項目は 確定・日を変える（Paused のみ）・却下。打鍵の印は Q1 の試作のとおり y と n。
 */
function candidatePop(r: SessionRowProps, emit: Emit) {
  const c = r.candidate!;
  const items: MenuItem[] = [
    { key: 'confirm', label: '確定', kbd: 'y', onSelect: () => emit({ type: 'session.state.confirm', id: r.id }) },
    ...(c.status === 'paused' ? [{ key: 'date', label: '日を変える', kbd: 'c', onSelect: () => emit({ type: 'session.pause.open', id: r.id, from: 'candidate' }) }] : []),
    { key: 'reject', label: '却下', kbd: 'n', onSelect: () => emit({ type: 'session.state.reject', id: r.id }) },
  ];
  const head = (
    <>
      <b className="menu-head-q">{c.status === 'done' ? 'Done にしますか' : `Paused · ${c.returnOn ? returnOnLabel(c.returnOn, null) : '日付なし'} にしますか`}</b>
      <span>{c.note ?? '根拠は書かれていません'}</span>
      <small>出どころ：{CANDIDATE_SOURCE_LABEL[c.source]} · {c.ago}</small>
    </>
  );
  return <MenuButton label={`${r.name} への Claude の提案`} face={candidateLabel(c)} faceClassName="row-cand" items={items} head={head} minWidth={260} />;
}
```

`row-when` の中、動きの語（`r.live && ...`）の行の後ろに足す。

```tsx
        {r.candidate && <span className="row-act" onClick={stopClick}>{candidatePop(r, emit)}</span>}
```

`packages/ui/src/styles/rows.css` の Task 12 で足した `.row-act` の行の前に足す。

```css
/* 提案の札（Q3）。枠だけの紫の丸い札で、押すと根拠のポップ（Q1）が開く。 */
.row-cand { flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border: 0; border-radius: var(--r-pill); background: none; box-shadow: inset 0 0 0 1px var(--cand); color: var(--cand); font: inherit; font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; cursor: pointer; }
.row-cand:hover, .row-cand[aria-expanded='true'] { background: var(--cand-soft); }
```

`packages/ui/src/styles/controls.css` の Task 12 で足した `.menu-kbd` の後ろに足す。

```css
/* メニューの頭の読むだけの段（提案の根拠、出どころ、時刻）。項目ではないのでフォーカスは止まらない。 */
.menu-head { display: flex; flex-direction: column; gap: var(--u); padding: calc(var(--u) * 1.5) calc(var(--u) * 2.5) calc(var(--u) * 2); font-size: var(--fs-sm); color: var(--ink-2); }
.menu-head-q { color: var(--ink); font-weight: 600; }
.menu-head small { font-size: var(--fs-xs); color: var(--ink-2); }
```

- [ ] **Step 4: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui/ && npm run typecheck --workspace packages/ui`
Expected: PASS、型の誤り 0 件

- [ ] **Step 5: Commit**

```bash
git commit packages/ui/src/views/primitives/MenuButton.tsx packages/ui/src/views/primitives/MenuButton.test.tsx packages/ui/src/views/SessionRows.tsx packages/ui/src/views/SessionRows.test.tsx packages/ui/src/styles/rows.css packages/ui/src/styles/controls.css -m "feat(ui): show Claude's state proposal as an outlined chip with a reasons popover" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Paused の入力（B1）

**Files:**
- Create: `packages/ui/src/presenters/pause.ts`、`packages/ui/src/presenters/pause.test.ts`
- Create: `packages/ui/src/views/PauseDialog.tsx`、`packages/ui/src/views/PauseDialog.test.tsx`
- Modify: `packages/ui/src/Root.tsx:14` の後ろ（import）、`:34` の後ろ（import）、`:335` の後ろ（Presenter）、`:343` の後ろ（描く）
- Modify: `packages/ui/src/styles/rows.css`（末尾）

**Interfaces:**
- Consumes: Task 10 の Overlay `pause` と Intent、Task 2 の `localDate`・`addDays`・`isReturnOn`・`STATE_NOTE_MAX`
- Produces:
  - `type PauseChoice = { key: 'today' | 'tomorrow' | 'monday' | 'nextWeek' | 'pick'; label: string; returnOn: string | null }`
  - `pauseChoices(now: number): PauseChoice[]`
  - `type PauseProps = { sessionId: string; sessionName: string; from: 'menu' | 'candidate'; draft: string; candidateNote: string | null; initialReturnOn: string; today: string; choices: PauseChoice[] }`
  - `presentPause(state: State, store: Store, now: number): PauseProps | null`
  - 送り方：「⋯」から開いたものは `session.state.set`（Paused）。提案から開いて理由を変えずに送れば `session.state.confirm { returnOn }`、変えたら `session.state.set`（手で選んだことになる）。

決めたこと：入力は試作の行に寄り添うポップではなく、既存の `Dialog` の殻に載せる（フォーカスの閉じ込め、Esc、開いた元へフォーカスを返すことを殻が持つため）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/ui/src/presenters/pause.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { pauseChoices, presentPause } from './pause.ts';

/** 手元の暦の時刻。試験を走らせる機械のタイムゾーンによらず、同じ日付になる。 */
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const THU = at(2026, 10, 1);
const session = (state: SessionDto['state']): SessionDto => ({ id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'Worker の CPU 超過', cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 2, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state });
const open = (from: 'menu' | 'candidate'): State => ({ ...initialState(), overlay: { kind: 'pause', sessionId: 's1', from } });
const storeOf = (s: SessionDto): Store => ({ ...initialStore(), sessions: { [s.id]: s } });

describe('pauseChoices', () => {
  it('今日の夕方・明日・月曜・来週・日付を選ぶ… の 5 つ', () => {
    expect(pauseChoices(THU)).toEqual([
      { key: 'today', label: '今日の夕方', returnOn: '2026-10-01' },
      { key: 'tomorrow', label: '明日', returnOn: '2026-10-02' },
      { key: 'monday', label: '月曜', returnOn: '2026-10-05' },
      { key: 'nextWeek', label: '来週', returnOn: '2026-10-08' },
      { key: 'pick', label: '日付を選ぶ…', returnOn: null },
    ]);
  });
  it('月曜は次の月曜で、今日が月曜なら 7 日後。日曜なら翌日', () => {
    expect(pauseChoices(at(2026, 10, 5)).find((c) => c.key === 'monday')!.returnOn).toBe('2026-10-12');
    expect(pauseChoices(at(2026, 10, 4)).find((c) => c.key === 'monday')!.returnOn).toBe('2026-10-05');
  });
  it('夜中の 0 時の手前は、まだ今日', () => {
    expect(pauseChoices(at(2026, 10, 1, 23, 59))[0]!.returnOn).toBe('2026-10-01');
  });
});

describe('presentPause', () => {
  it('「⋯」から開くと、下書きは空で、戻る日は明日を選んでおく', () => {
    expect(presentPause(open('menu'), storeOf(session(null)), THU)).toMatchObject({ sessionId: 's1', sessionName: 'Worker の CPU 超過', from: 'menu', draft: '', candidateNote: null, initialReturnOn: '2026-10-02', today: '2026-10-01' });
  });
  it('Paused のセッションを開き直すと、今の理由と戻る日を入れておく', () => {
    const s = session({ status: 'paused', note: '数字を見る', returnOn: '2026-10-05', setBy: 'user', setAt: 1, candidate: null });
    expect(presentPause(open('menu'), storeOf(s), THU)).toMatchObject({ draft: '数字を見る', initialReturnOn: '2026-10-05' });
  });
  it('提案から開くと、根拠を下書きに入れ、提案の日を選んでおく', () => {
    const s = session({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: { status: 'paused', note: '明日の朝 CPU を見る', returnOn: '2026-10-02', source: 'exit', at: 1 } });
    expect(presentPause(open('candidate'), storeOf(s), THU)).toMatchObject({ from: 'candidate', draft: '明日の朝 CPU を見る', candidateNote: '明日の朝 CPU を見る', initialReturnOn: '2026-10-02' });
  });
  it('開いていないか、セッションが無ければ null', () => {
    expect(presentPause(initialState(), storeOf(session(null)), THU)).toBeNull();
    expect(presentPause(open('menu'), initialStore(), THU)).toBeNull();
  });
});
```

`packages/ui/src/views/PauseDialog.test.tsx`

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { PauseProps } from '../presenters/pause.ts';
import { PauseDialog } from './PauseDialog.tsx';

const props = (over: Partial<PauseProps> = {}): PauseProps => ({
  sessionId: 's1', sessionName: 'Worker の CPU 超過', from: 'menu', draft: '', candidateNote: null, initialReturnOn: '2026-10-02', today: '2026-10-01',
  choices: [
    { key: 'today', label: '今日の夕方', returnOn: '2026-10-01' }, { key: 'tomorrow', label: '明日', returnOn: '2026-10-02' },
    { key: 'monday', label: '月曜', returnOn: '2026-10-05' }, { key: 'nextWeek', label: '来週', returnOn: '2026-10-08' },
    { key: 'pick', label: '日付を選ぶ…', returnOn: null },
  ],
  ...over,
});
const mount = (p: PauseProps = props(), onIntent = vi.fn()) => {
  const r = render(<IntentRoot onIntent={onIntent}><PauseDialog {...p} /></IntentRoot>);
  return { onIntent, unmount: r.unmount };
};
const radio = (name: RegExp) => screen.getByRole('radio', { name });
const submit = () => screen.getByRole('button', { name: 'Paused にする' });

describe('PauseDialog（B1）', () => {
  it('札を押すか 1〜5 で戻る日を選び、理由を添えて Paused にする', () => {
    const { onIntent } = mount();
    expect(radio(/^明日/)).toHaveAttribute('aria-checked', 'true');
    // 開いたときのフォーカスは選んである札にあるので、数字がそのまま効く。
    expect(document.activeElement).toBe(radio(/^明日/));
    fireEvent.keyDown(document.activeElement!, { key: '4' });
    expect(radio(/^来週/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radio(/^月曜/));
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '  本番の数字を見る ' } });
    fireEvent.click(submit());
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-05', note: '本番の数字を見る' });
  });
  // Review Focus 5：欄で打った数字は欄の文字。変換中の Enter は変換の確定。
  it('理由の欄で打った数字は札を切り替えず、変換中の Enter では送らない', () => {
    const { onIntent } = mount();
    const input = screen.getByLabelText('理由');
    act(() => input.focus());
    fireEvent.keyDown(input, { key: '1' });
    expect(radio(/^明日/)).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(input, { target: { value: '確認' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', note: '確認' });
  });
  it('「日付を選ぶ…」は日付の欄を出し、日を入れるまで送れない', () => {
    const { onIntent } = mount();
    fireEvent.click(radio(/^日付を選ぶ/));
    expect(submit()).toBeDisabled();
    const date = screen.getByLabelText('日付');
    expect(date).toHaveAttribute('min', '2026-10-01');
    fireEvent.change(date, { target: { value: '2026-10-20' } });
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-20' });
  });
  it('札に無い日で開いたら「日付を選ぶ…」にその日を入れておく', () => {
    mount(props({ initialReturnOn: '2026-10-20' }));
    expect(radio(/^日付を選ぶ/)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('日付')).toHaveValue('2026-10-20');
  });
  it('提案から開くと根拠が下書きに入り、変えずに送れば提案の確定に日を添える。変えたら手で選んだことにする', () => {
    const p = props({ from: 'candidate', draft: '明日の朝、CPU の数字を確かめる', candidateNote: '明日の朝、CPU の数字を確かめる' });
    const first = mount(p);
    expect(screen.getByText('Claude の下書き')).toBeInTheDocument();
    expect(screen.getByLabelText('理由')).toHaveValue('明日の朝、CPU の数字を確かめる');
    fireEvent.click(radio(/^月曜/));
    fireEvent.click(submit());
    expect(first.onIntent).toHaveBeenLastCalledWith({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05' });
    first.unmount();
    const second = mount(p);
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '月曜に CPU を見る' } });
    fireEvent.click(submit());
    expect(second.onIntent).toHaveBeenLastCalledWith({ type: 'session.state.set', id: 's1', status: 'paused', returnOn: '2026-10-02', note: '月曜に CPU を見る' });
  });
  // Review Focus 4：字数は文字単位で数える。
  it('理由は文字単位で数え、絵文字の 200 字は送れて 201 字は送れない', () => {
    mount();
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '😀'.repeat(200) } });
    expect(screen.getByText('200 / 200 字')).toBeInTheDocument();
    expect(submit()).toBeEnabled();
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '😀'.repeat(201) } });
    expect(submit()).toBeDisabled();
  });
  it('Esc と「やめる」で閉じる', () => {
    const { onIntent } = mount();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'session.pause.close' });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onIntent).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 試験が落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/pause.test.ts packages/ui/src/views/PauseDialog.test.tsx`
Expected: FAIL（`./pause.ts` と `./PauseDialog.tsx` が見つからない）

- [ ] **Step 3: Presenter を書く**

`packages/ui/src/presenters/pause.ts`

```ts
import { addDays, localDate } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

/** 戻る日の札（B1）。pick（日付を選ぶ…）だけは日を持たず、選んだときに暦の欄を出す。 */
export type PauseChoice = { key: 'today' | 'tomorrow' | 'monday' | 'nextWeek' | 'pick'; label: string; returnOn: string | null };
/**
 * Paused の入力。draft は理由の欄の下書き、candidateNote は提案から開いたときの Claude の根拠（変えたかを見るのに使う）。
 * today は暦の欄の下限で、initialReturnOn は開いたときに選んでおく日である。
 */
export type PauseProps = { sessionId: string; sessionName: string; from: 'menu' | 'candidate'; draft: string; candidateNote: string | null; initialReturnOn: string; today: string; choices: PauseChoice[] };

/**
 * 戻る日の札を今の手元の暦から作る。
 * 戻る日は日付だけで持つので、「今日の夕方」は今日、「明日」は明日として扱う。
 * 月曜は次の月曜で、今日が月曜なら 7 日後にする。来週は 7 日後である。
 */
export function pauseChoices(now: number): PauseChoice[] {
  const today = localDate(now);
  const toMonday = ((8 - new Date(now).getDay()) % 7) || 7;
  return [
    { key: 'today', label: '今日の夕方', returnOn: today },
    { key: 'tomorrow', label: '明日', returnOn: addDays(today, 1) },
    { key: 'monday', label: '月曜', returnOn: addDays(today, toMonday) },
    { key: 'nextWeek', label: '来週', returnOn: addDays(today, 7) },
    { key: 'pick', label: '日付を選ぶ…', returnOn: null },
  ];
}

/**
 * Paused の入力。overlay が pause のときだけ props を作る。
 * 提案から開いたときは根拠を下書きに入れ、提案の日を選んでおく。「⋯」から開いたときは、Paused なら今の理由と日を、ほかは空と明日を入れておく。
 */
export function presentPause(state: State, store: Store, now: number): PauseProps | null {
  if (state.overlay.kind !== 'pause') return null;
  const { sessionId, from } = state.overlay;
  const s = store.sessions[sessionId];
  if (!s) return null;
  const st = s.state ?? null;
  const cand = from === 'candidate' ? st?.candidate ?? null : null;
  const own = st?.status === 'paused' ? st : null;
  const choices = pauseChoices(now);
  return {
    sessionId, sessionName: s.name ?? '（名前なし）', from,
    draft: cand ? cand.note ?? '' : own?.note ?? '',
    candidateNote: cand?.note ?? null,
    initialReturnOn: cand?.returnOn ?? own?.returnOn ?? choices[1]!.returnOn!,
    today: choices[0]!.returnOn!,
    choices,
  };
}
```

- [ ] **Step 4: View を書いて Root につなぐ**

`packages/ui/src/views/PauseDialog.tsx`

```tsx
import { useState, type KeyboardEvent } from 'react';
import { isReturnOn, STATE_NOTE_MAX } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { PauseChoice, PauseProps } from '../presenters/pause.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';

const DIGITS = ['1', '2', '3', '4', '5'];

/**
 * Paused の入力（B1）。戻る日の札を 5 つ並べ、下に理由の 1 行を置く。
 * 札は打鍵 1〜5 でも選べる。理由の欄と日付の欄で打った数字はその欄の文字なので、横取りしない。
 * 入力は送るまで外へ出ないので、Mediator ではなくここに持つ（PromoteDialog と同じ）。
 * 提案から開いて理由を変えずに送れば、提案の確定に日を添える。変えたら手で選んだことにする（set_by は user）。
 */
export function PauseDialog(props: PauseProps) {
  const emit = useEmit();
  const initial: PauseChoice['key'] = props.choices.find((c) => c.returnOn === props.initialReturnOn)?.key ?? 'pick';
  const [choice, setChoice] = useState<PauseChoice['key']>(initial);
  const [picked, setPicked] = useState(initial === 'pick' ? props.initialReturnOn : '');
  const [note, setNote] = useState(props.draft);
  const returnOn = choice === 'pick' ? (isReturnOn(picked) ? picked : null) : props.choices.find((c) => c.key === choice)?.returnOn ?? null;
  // 字数は文字単位で数える。サーバ（sessions/states.ts）と同じ数え方にしないと、通るはずの理由が 400 で返る。
  const length = [...note.trim()].length;
  const canSubmit = returnOn !== null && length <= STATE_NOTE_MAX;

  const close = () => emit({ type: 'session.pause.close' });
  const submit = () => {
    if (!canSubmit || returnOn === null) return;
    const text = note.trim();
    if (props.from === 'candidate' && text === (props.candidateNote ?? '').trim()) {
      emit({ type: 'session.state.confirm', id: props.sessionId, returnOn });
      return;
    }
    emit({ type: 'session.state.set', id: props.sessionId, status: 'paused', returnOn, ...(text ? { note: text } : {}) });
  };

  // 札の打鍵。欄の中の打鍵と、修飾の付いた打鍵は扱わない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    const c = props.choices[DIGITS.indexOf(e.key)];
    if (!c) return;
    e.preventDefault();
    setChoice(c.key);
  };
  // Enter で送る。変換中の Enter は確定のための打鍵なので、送信に使わない。
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit();
  };

  // 理由を打ちかけたまま背景を押し違えても失わないよう、背景では閉じない。
  return (
    <Dialog
      title="Paused にする"
      titleAside={props.from === 'candidate' ? <span className="pause-draft">Claude の下書き</span> : undefined}
      className="dialog-pause"
      onClose={close}
      closeOnBackdrop={false}
      onKeyDown={onKeyDown}
      footer={<><button type="button" className="btn" onClick={close}>やめる</button><span className="spacer" /><button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submit}>Paused にする</button></>}
    >
      <div className="faint">{props.sessionName}</div>
      <div className="pause-chips" role="radiogroup" aria-label="戻る日の候補">
        {props.choices.map((c, i) => (
          <button key={c.key} type="button" role="radio" aria-checked={choice === c.key} className="pause-chip" data-autofocus={c.key === initial ? 'true' : undefined} onClick={() => setChoice(c.key)}>
            {c.label}<kbd>{i + 1}</kbd>
          </button>
        ))}
      </div>
      {choice === 'pick' && (
        <label className="field">日付
          <input type="date" className="input" min={props.today} value={picked} onChange={(e) => setPicked(e.target.value)} onKeyDown={onFieldKey} />
        </label>
      )}
      <label className="field">何を確かめに戻るか
        <input className="input" aria-label="理由" value={note} placeholder="明日の朝、本番の CPU の数字を見る" onChange={(e) => setNote(e.target.value)} onKeyDown={onFieldKey} />
      </label>
      <div className={length > STATE_NOTE_MAX ? 'error' : 'faint'} aria-live="polite">{length} / {STATE_NOTE_MAX} 字</div>
    </Dialog>
  );
}
```

見出しのアイコンは付けない（`packages/ui/src/views/primitives/Icon.tsx` の `IconName` に Paused に合うものが無い。`icon` は任意である）。

`packages/ui/src/Root.tsx:14` の後ろと `:34` の後ろに import を足す。

```tsx
import { presentPause } from './presenters/pause.ts';
```

```tsx
import { PauseDialog } from './views/PauseDialog.tsx';
```

`packages/ui/src/Root.tsx:335`（`const newSession = presentNewSession(...)`）の後ろに足し、`:343`（`ConfirmDialog` の行）の後ろに描く。

```tsx
  // Paused の入力は開くたびに作り直す（札と下書きの初期値を、開いたセッションと入口から取り直すため）。
  const pause = presentPause(state, store, now);
```

```tsx
      {pause && <PauseDialog key={`${pause.sessionId}:${pause.from}`} {...pause} />}
```

`packages/ui/src/styles/rows.css` の末尾に足す。

```css
/* Paused の入力（B1）。戻る日の札を 5 つ並べ、下に理由の 1 行を置く。選んだ札は黄土の地と縁で示す。 */
.pause-chips { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 1.5); }
.pause-chip { display: inline-flex; align-items: center; gap: calc(var(--u) * 1.5); height: 28px; padding: 0 calc(var(--u) * 2.5); border: 0; border-radius: var(--r-pill); background: var(--surface-2); color: var(--ink-2); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
.pause-chip[aria-checked='true'] { color: var(--st-paused); background: var(--st-paused-soft); box-shadow: inset 0 0 0 1px var(--st-paused); font-weight: 600; }
.pause-chip kbd { font: inherit; font-size: var(--fs-xs); color: var(--ink-2); }
.pause-chip[aria-checked='true'] kbd { color: var(--st-paused); }
.pause-draft { font-size: var(--fs-xs); font-weight: 600; color: var(--cand); }
```

- [ ] **Step 5: 試験と型検査が通ることを確かめる**

Run: `npx vitest run packages/ui/ && npm run typecheck --workspace packages/ui`
Expected: PASS、型の誤り 0 件

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/presenters/pause.ts packages/ui/src/presenters/pause.test.ts packages/ui/src/views/PauseDialog.tsx packages/ui/src/views/PauseDialog.test.tsx
git commit packages/ui/src/presenters/pause.ts packages/ui/src/presenters/pause.test.ts packages/ui/src/views/PauseDialog.tsx packages/ui/src/views/PauseDialog.test.tsx packages/ui/src/Root.tsx packages/ui/src/styles/rows.css -m "feat(ui): add the Paused dialog with date chips and a reason field" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 全体の試験とビルド

本物の DB でも同期でもまだ動かさない。ビルドが通ることまでを確かめる。

**Files:**
- なし（作り直されるのは `packages/ui/dist`、`apps/desktop/server-dist`、`apps/desktop/src-tauri/target`）

**Interfaces:**
- Consumes: Task 1〜14 のすべて
- Produces: `apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app`

- [ ] **Step 1: 全体の試験**

Run: `npm test`
Expected: すべて PASS。`statusline` の試験がフィクスチャの日付（2026-09-01）で 30 日の窓から外れて落ちるのは既存の日付依存なので、それだけなら記録して進める（この段で直さない）。ほかが落ちたら直してから進む。

- [ ] **Step 2: 型検査**

Run: `npm run typecheck`
Expected: 全ワークスペースで型の誤り 0 件

- [ ] **Step 3: UI のビルド**

Run: `npm run build`
Expected: `packages/ui` の vite build が通り、`packages/ui/dist/index.html` ができる

- [ ] **Step 4: デスクトップのビルド**

Run: `npm run bundle-server -w apps/desktop`
Expected: `apps/desktop/server-dist` が作り直される（終了コード 0）

Run（数分かかるので background で回し、終わってから結果を見る）: `npm run tauri -w apps/desktop -- build`
Expected: `apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` ができる（終了コード 0）

- [ ] **Step 5: 利用者の dev サーバを一度落とす（承認を得てから）**

ビルドしたら、利用者が自分で動かしている `npm run dev` のサーバ（4177 を LISTEN している tsx のプロセス）を一度落とす必要がある。`tsx watch` だけでは反映されない変更（依存、起動時にしか読まないもの、`server-dist`）があるためである。
ポート番号で止めてはいけない。LISTEN しているものを PID で引き、何のプロセスかを目で確かめてから、利用者に承認を求める。承認が無ければ落とさずに次へ進み、報告にその旨を書く。

```bash
lsof -nP -iTCP:4177 -sTCP:LISTEN -t      # LISTEN しているものだけ。-ti :4177 は接続側も拾うので使わない
ps -o pid=,command= -p <PID>              # tsx の server だと確かめる
```

承認を得たら、その 1 つだけを止める。Vite（5173）には触らない。

```bash
kill <PID>
```

`Hangar.app` が走っていれば、それも止めるかを同じく尋ねる（`osascript -e 'tell application "Hangar" to quit'`、残れば `pgrep -fl 'Hangar.app/Contents/MacOS'` で PID を確かめる）。
止めたら、サーバは戻らないので、利用者が `npm run dev` を立て直すか、こちらで立てるかを報告に添える。

- [ ] **Step 6: ビルドの結果を報告に残す**

コミットするものは無い。試験の件数、型検査、3 つのビルドの結果と、Step 5 で何を止めたか（止めなかったか）を報告に書く。

---

### Task 16: Worker の配備（利用者の承認を得てから）

古い Worker は `SHARED_TABLES` に無い表を含む push の束を丸ごと 400 で断る（`packages/cloud/src/changes.ts:184`）。新しい版が `session_states` の変更を 1 行でも積むと、その束の同期が止まる。だから、新しい版を本物の DB と同期で動かす（Task 17）前に、Worker を配備する。
本番の Worker・D1・R2 の名前は `hangar`。配備は月 5 ドルの上限の中で、D1 のスキーマは変わらない（行を JSON のまま持つ）。

**Files:**
- なし（配備の設定の写しは一時ディレクトリに作り、リポジトリには書かない）

**Interfaces:**
- Consumes: Task 3 の `SHARED_TABLES`、Task 7 の cloud の試験
- Produces: `session_states` を受け付ける本番の Worker

- [ ] **Step 1: 利用者の承認を得る**

「本番の Worker `hangar` を、`session_states` を受け付ける版に配備してよいか」を利用者に尋ねる。承認が無ければこのタスクと Task 17 で止める。

- [ ] **Step 2: cloud の試験を通す**

Run: `npx vitest run packages/cloud/`
Expected: PASS

- [ ] **Step 3: wrangler の認証を確かめる**

Run: `cd packages/cloud && npx wrangler whoami`
Expected: ログイン済みのアカウントが出る。
出なければここで止め、利用者に認証の渡し方を尋ねる（Cloudflare のトークンは 1Password にある。項目の名前は推測しない。トークンを argv にもログにも出さない）。

- [ ] **Step 4: 配備する**

本番の設定 `~/.agent-hangar/cloud/wrangler.jsonc` の `main` はメインの checkout（`/Users/me/workspace/agent-hangar/packages/cloud/src/index.ts`）を指している。この段を main へ入れる前に配備するときは、`main` だけを worktree のソースに差し替えた写しを一時ディレクトリに作って配備する（2026-10-01 の Worker の配備と同じやり方）。
アカウント ID は `~/.agent-hangar/cloud.json` の `accountId` を環境変数で渡す。`cloud.json` は参加の秘密も持つので、`accountId` 以外を出力しない。

```bash
cd /Users/me/workspace/agent-hangar/.claude/worktrees/session-status/packages/cloud
CFG="<一時ディレクトリ>/wrangler.session-status.jsonc"
sed "s#\"main\": \".*\"#\"main\": \"$PWD/src/index.ts\"#" ~/.agent-hangar/cloud/wrangler.jsonc > "$CFG"
grep '"main"' "$CFG"
CLOUDFLARE_ACCOUNT_ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.agent-hangar/cloud.json", "utf8")).accountId)')" npx wrangler deploy --config "$CFG"
```

Expected: `grep` が worktree の `src/index.ts` を指す 1 行を出し、`wrangler deploy` が `https://hangar.<…>.workers.dev` と Version ID を出す。`JOIN_SECRET_HASH` は Worker に残るので入れ直さない。
この段がすでに main に入り、メインの checkout が `git pull` で最新なら、代わりにメインの checkout で `npm run hangar -- setup cloud` を走らせてもよい（設定を書き直して配備し、参加までやり直す）。

- [ ] **Step 5: 配備を確かめる**

```bash
curl -s "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.agent-hangar/cloud.json", "utf8")).url)')/health"
```

Expected: `{"ok":true,...}`。Version ID と配備の時刻を報告に残す。

---

### Task 17: 実物での確かめ（利用者の承認を得てから）

本物の `~/.agent-hangar/hangar.db` に v13 が当たる（全セッションが一括で Done になる）。元へ戻すには控えが要るので、先に控えを取る。

**Files:**
- なし

**Interfaces:**
- Consumes: Task 15 の `Hangar.app`、Task 16 の Worker

- [ ] **Step 1: 利用者の承認を得る**

次の 3 つをまとめて尋ねる。どれかが断られたら、そこで止めて報告する。
- 本物の DB に v13 を当ててよいか（全セッションが Done になる。控えから戻せる）。
- 4177 で動いているサーバ（利用者の dev か `/Applications/Hangar.app`）を止めてよいか（Task 15 の Step 5 と同じ手順で PID を確かめる）。
- 新しい版をどう起動するか：ビルドした `.app` をその場所から開くか、利用者が `/Applications/Hangar.app` を入れ替えるか（`/Applications` の削除は権限の判定で止まるので、利用者に打ってもらう）。

- [ ] **Step 2: DB の控えを取る**

```bash
sqlite3 ~/.agent-hangar/hangar.db ".backup '$HOME/.agent-hangar/backups/hangar-before-v13-$(date +%Y%m%d-%H%M%S).db'"
ls -l ~/.agent-hangar/backups/ | tail -3
```

Expected: 控えのファイルができ、大きさが元の DB と同じくらいである。

- [ ] **Step 3: 新しい版を起こし、起動元を確かめる**

Step 1 で決めたやり方で起こす。ビルドの写しから開くなら `open apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app`。
入れ替えたあとは `sleep 5` 待ってから確かめる（`sleep 2` では新しいアプリが起動しなかったことがある）。

```bash
pgrep -fl 'Hangar.app/Contents/MacOS'
lsof -nP -iTCP:4177 -sTCP:LISTEN -t
ps -o pid=,command= -p <上の PID>
```

Expected: 4177 を握っているのが、いま起こした版のサーバである（古い版がサーバを握ったままだと、新しい版は相乗りして古い画面を出す）。

- [ ] **Step 4: 一括 Done を数で確かめる（読むだけ）**

```bash
sqlite3 -readonly ~/.agent-hangar/hangar.db "select (select count(*) from session_states where set_by = 'import' and status = 'done' and updated_at = 0), (select count(*) from sessions where deleted_at is null), (select count(*) from changes where table_name = 'session_states')"
```

Expected: 1 つ目と 2 つ目が同じ数（v13 の後に同期で届いたセッションがあれば、2 つ目がその分だけ多い）で、3 つ目が 0。

- [ ] **Step 5: 画面で確かめる**

手元の Chrome（`/playwright` の skill）で `http://127.0.0.1:4177/?t=<鍵>` を開く。鍵は `~/.agent-hangar/token` をスクリプトの中で読み、画面にもログにも出さない。窓は 900×600 と 1440×900 の両方で見る。確かめるのは次のとおりである。

- プロジェクト画面と Home の最近の行に、緑の「Done」の四角の札が出ている。
- 行にポインタを乗せる、または j/k でカーソルを当てると「⋯」が出る。打鍵 `.` で 4 択が開き、`d`・`a`・`u` で変わり、行は開かない。変えると `session.upsert` で行がすぐ描き直される。
- `p` で Paused の入力が開く。1〜5 で札が移り、理由の欄で打った数字では移らない。Esc で閉じる。送ると 2 段目の頭に戻る日の札が出る（今日なら塗り）。
- 提案を 1 つ作り、枠だけの紫の札とポップを確かめる。試すセッションは利用者に選んでもらう。セッションの id は画面の URL の `#/session/<id>` から取る。

  ```bash
  curl -s -X POST http://127.0.0.1:4177/mcp \
    -H "authorization: Bearer $(cat ~/.agent-hangar/token)" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"propose_session_status","arguments":{"session_id":"<試すセッションの id>","status":"paused","note":"明日の朝、CPU の数字を確かめる","return_on":"<明日の YYYY-MM-DD>"}}}'
  ```

  その前に、試すセッションを「⋯」の「印なしに戻す」で印なしにしておく（状態が付いていると `already_set` になる）。
  Expected: 結果の text に `"outcome": "proposed"` が入り、行に「Paused · …？」の札が出る。押すと根拠・「出どころ：会話 · …」と 確定・日を変える・却下 が出る。「日を変える」で Paused の入力が根拠の下書き付きで開く。
- 状態を変えたあと、ヘッダーの同期の表示がエラーにならない（Task 16 の Worker が受け付けている）。
- 試したセッションは、最後に「⋯」の「Done にする」で Done に戻す（`set_by` は `import` から `user` に変わる）。

- [ ] **Step 6: 見た目の最終確認を利用者に頼む**

撮った画面（900×600 と 1440×900）を添えて、札の色・大きさ・「⋯」の出方・Paused の入力の見た目の最終確認を利用者に頼む。コミットするものは無い。Step 4 の数、Step 5 で確かめたこと、控えのパスを報告に書く。
