# 実行中のセッションの右ペイン 1 回目 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 実行中のセッションの右ペインを、状態の灯、意図、指揮役の手、サブエージェントのレーン、目次（色帯つき）の 5 段にする。

**Architecture:** 手の種類と手の文の規則を `packages/shared` に置き、サーバと UI の両方で使う。サーバは主線とサブエージェントを読んで「ライブの要約」（意図とレーン）を `GET /api/sessions/:id/live` で返し、UI は本文を読む経路に相乗りして 1 秒に 1 回までそれを取り直す。指揮役の手と目次の色帯は、UI がすでに読み込んでいる主線のイベントから presenter が作る。意図はセッションが新しい MCP ツール `set_turn_intent` で書き、端末ローカルの表に積む。

**Tech Stack:** TypeScript、Hono、better-sqlite3、MCP SDK、React、vitest（UI は jsdom）、@testing-library/react。

**Spec:** `docs/superpowers/specs/2026-10-01-live-explainer-design.md`（この計画は 1 回目。層と作業の居場所は 2 回目、用語の解説は 3 回目で、この計画には入れない）

## Global Constraints

- Node は 22（better-sqlite3 が版に縛られる）。テストは `npx vitest run <path>`、型は `npm run typecheck`。
- UI は常にライト。ダークの規則は足さない。
- 意図の本文は空白を除いて 1 字以上 200 字以下。範囲の外は断る。
- 意図の表は端末ローカル（同期しない）。マイグレーションは version 12。
- 意図の帯は、書いてから 30 手を超えたら薄くする。
- 指揮役の手は最後の 4 行、サブエージェントは 6 行まで。超えた済みは「済 n」に畳む。
- 色帯は 1 ターン最新の 40 手まで。
- 赤（失敗）は結果が `isError` のときだけ。本文の中身（不合格など）で色を変えない。
- 引用符は自己申告（意図、サブエージェントの最後の報告）だけに付ける。手の文には付けない。
- 注入に足す 2 行は仕様書の文言どおり。
- `~/.claude`、`~/.agent-hangar`、利用者の `npm run dev`（4177 と 5173）に触れない。テストは一時ディレクトリだけを使う。
- コミットは `git commit <path>...` のパス指定形で行い、`--amend` と `rebase` は使わない。末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- 何千手も続く指揮役のターン：要約は今のターンの頭から読むので重くなりうる。索引が変わっていなければ同じ要約を返す（Task 5 のキャッシュの試験）。
- 起こした直後でまだ transcript が無いサブエージェント：レーンは「始めたところ」で出て、落ちない（Task 5 の `aaa9`）。
- 最後の利用者の行が中断の知らせ（`[Request interrupted…`）：ターンの頭をそこにせず、その前の指示にする（Task 5）。
- 同じミリ秒に 2 回の `set_turn_intent`：両方残り、後の方が最新になる（Task 3）。
- サブエージェントの transcript を開いている間：指揮役の手にサブエージェントの手を混ぜない（Task 7）。

---

### Task 1: 手の種類と手の文の規則

**Files:**
- Create: `packages/shared/src/steps.ts`
- Create: `packages/shared/src/steps.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/ui/src/presenters/turns.ts`（中断の見分けを shared へ寄せる）

**Interfaces:**
- Produces:
  - `type StepKind = 'read' | 'write' | 'run' | 'git' | 'other'`
  - `type StepCell = StepKind | 'fail'`
  - `commandWords(command: string): string[]`
  - `stepKind(call: ToolCallEvent): StepKind`
  - `stepLine(call: ToolCallEvent): { text: string; mono: boolean }`
  - `isTurnPrompt(text: string): boolean`
  - `type ToolCallEvent = Extract<TranscriptEvent, { kind: 'tool_call' }>`

- [ ] **Step 1: 失敗するテストを書く**

`packages/shared/src/steps.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { commandWords, isTurnPrompt, stepKind, stepLine, type ToolCallEvent } from './steps.ts';

const call = (name: string, input: unknown, summary = name): ToolCallEvent => ({ kind: 'tool_call', seq: 0, toolId: 't', name, input, summary });
const bash = (command: string, description?: string) => call('Bash', description === undefined ? { command } : { command, description });

describe('commandWords', () => {
  it('cd <dir> && と環境変数の代入を読み飛ばす', () => {
    expect(commandWords('cd /w/app && npm test')).toEqual(['npm', 'test']);
    expect(commandWords('LC_ALL=C FOO=1 grep -n x a.ts')).toEqual(['grep', '-n', 'x', 'a.ts']);
    expect(commandWords('cd /w && cd sub && git status')).toEqual(['git', 'status']);
    expect(commandWords('cd /w')).toEqual([]);
  });
});

describe('stepKind', () => {
  it('ツール名で決まるもの', () => {
    expect(stepKind(call('Read', { file_path: '/w/a.ts' }))).toBe('read');
    expect(stepKind(call('Grep', { pattern: 'x' }))).toBe('read');
    expect(stepKind(call('Edit', { file_path: '/w/a.ts' }))).toBe('write');
    expect(stepKind(call('Write', { file_path: '/w/a.ts' }))).toBe('write');
    expect(stepKind(call('Agent', { description: 'd' }))).toBe('other');
  });
  it('Bash はコマンドの頭の語で決める', () => {
    expect(stepKind(bash('sed -n 1,40p a.ts'))).toBe('read');
    expect(stepKind(bash("sed -i '' 's/a/b/' a.ts"))).toBe('write');
    expect(stepKind(bash('cat a.ts | head'))).toBe('read');
    expect(stepKind(bash('mkdir -p out && cp a b'))).toBe('write');
    expect(stepKind(bash('npx vitest run packages/server'))).toBe('run');
    expect(stepKind(bash('cd /w && npm run typecheck'))).toBe('run');
    expect(stepKind(bash('git status --short'))).toBe('read');
    expect(stepKind(bash('git -C /w log --oneline -3'))).toBe('read');
    expect(stepKind(bash('git commit -m x'))).toBe('git');
    expect(stepKind(bash('git push origin b'))).toBe('git');
    expect(stepKind(bash('curl -s http://127.0.0.1:4177/health'))).toBe('other');
    expect(stepKind(call('Bash', {}))).toBe('other');
  });
});

describe('stepLine', () => {
  it('Bash は description を使い、無ければコマンドの 1 行目を等幅で出す', () => {
    expect(stepLine(bash('npx vitest run', 'テストを走らせる'))).toEqual({ text: 'テストを走らせる', mono: false });
    expect(stepLine(bash('ls -la\necho done'))).toEqual({ text: 'ls -la', mono: true });
  });
  it('ファイルを扱うツールはファイル名で書く', () => {
    expect(stepLine(call('Read', { file_path: '/w/packages/server/src/a.ts' }))).toEqual({ text: '読んだ：a.ts', mono: false });
    expect(stepLine(call('Edit', { file_path: '/w/b.ts' }))).toEqual({ text: 'b.ts を書き換えた', mono: false });
    expect(stepLine(call('Write', { file_path: '/w/c.md' }))).toEqual({ text: 'c.md を書いた', mono: false });
    expect(stepLine(call('Grep', { pattern: 'renderInjection' }))).toEqual({ text: '探した：renderInjection', mono: false });
  });
  it('そのほかはツール名と今の summary', () => {
    expect(stepLine(call('WebFetch', { url: 'https://x' }, 'WebFetch https://x'))).toEqual({ text: 'WebFetch https://x', mono: false });
  });
});

describe('isTurnPrompt', () => {
  it('中断の知らせは指示ではない', () => {
    expect(isTurnPrompt('続けて')).toBe(true);
    expect(isTurnPrompt('[Request interrupted by user]')).toBe(false);
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/shared/src/steps.test.ts`
Expected: FAIL（`./steps.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/shared/src/steps.ts`：

```ts
import type { TranscriptEvent } from './transcript.ts';

export type ToolCallEvent = Extract<TranscriptEvent, { kind: 'tool_call' }>;
/** 手の種類。色帯と、2 回目で入れる層のタイルに使う。 */
export type StepKind = 'read' | 'write' | 'run' | 'git' | 'other';
/** 色帯の 1 升。失敗は種類より優先する（結果が isError のとき）。 */
export type StepCell = StepKind | 'fail';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_CMDS = new Set(['cat', 'head', 'tail', 'ls', 'grep', 'rg', 'find', 'jq', 'wc', 'less', 'tree', 'stat', 'file', 'pwd', 'which', 'du', 'diff']);
const WRITE_CMDS = new Set(['tee', 'mkdir', 'cp', 'mv', 'touch', 'ln']);
const RUN_CMDS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'vitest', 'tsc', 'node', 'tsx', 'cargo', 'pytest', 'python', 'python3', 'make', 'go', 'bun', 'deno']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'blame', 'ls-files', 'worktree']);
const GIT_WRITE = new Set(['commit', 'merge', 'push', 'rebase', 'cherry-pick']);

/** コマンドの頭の語の並び。`cd <dir> &&` と、先頭の環境変数の代入を読み飛ばす。 */
export function commandWords(command: string): string[] {
  let words = command.trim().split(/\s+/).filter(Boolean);
  for (;;) {
    if (words[0] === 'cd') {
      const i = words.indexOf('&&');
      if (i < 0) return [];
      words = words.slice(i + 1);
      continue;
    }
    if (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words = words.slice(1); continue; }
    return words;
  }
}

function bashKind(command: string): StepKind {
  const w = commandWords(command.split('\n')[0] ?? '');
  const head = w[0] ?? '';
  if (head === 'git') {
    // `git -C <dir> log` のような大域の引数を読み飛ばして、サブコマンドを取る。
    let i = 1;
    while (w[i]?.startsWith('-')) i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
    const sub = w[i] ?? '';
    if (GIT_WRITE.has(sub)) return 'git';
    if (GIT_READ.has(sub)) return 'read';
    return 'other';
  }
  if (head === 'sed') return w.some((x) => /^-i/.test(x)) ? 'write' : 'read';
  if (READ_CMDS.has(head)) return 'read';
  if (WRITE_CMDS.has(head)) return 'write';
  if (RUN_CMDS.has(head)) return 'run';
  return 'other';
}

/** 手の種類。決めきれないものは other にし、無理に当てはめない。 */
export function stepKind(call: ToolCallEvent): StepKind {
  if (READ_TOOLS.has(call.name)) return 'read';
  if (WRITE_TOOLS.has(call.name)) return 'write';
  if (call.name === 'Bash' && isRec(call.input) && typeof call.input.command === 'string') return bashKind(call.input.command);
  return 'other';
}

const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

/**
 * 手の 1 行の文。Bash は Claude が書いた description を使う。
 * description は 1 手ごとに書かれ、隣に結果があるので、引用符は付けない（自己申告の扱いは仕様書の「意図」の節）。
 * mono はコマンドをそのまま出すときだけ真にする。
 */
export function stepLine(call: ToolCallEvent): { text: string; mono: boolean } {
  const i = isRec(call.input) ? call.input : {};
  const fp = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
  switch (call.name) {
    case 'Bash': {
      const d = str(i.description);
      if (d) return { text: d, mono: false };
      return { text: ((str(i.command) ?? 'Bash').split('\n')[0] ?? '').slice(0, 80), mono: true };
    }
    case 'Read': return { text: fp ? `読んだ：${baseName(fp)}` : '読んだ', mono: false };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { text: fp ? `${baseName(fp)} を書き換えた` : call.name, mono: false };
    case 'Write': return { text: fp ? `${baseName(fp)} を書いた` : call.name, mono: false };
    case 'Grep': case 'Glob': { const p = str(i.pattern); return { text: p ? `探した：${p}` : '探した', mono: false }; }
    case 'Agent': case 'Task': return { text: str(i.description) ?? call.summary, mono: false };
    default: return { text: call.summary, mono: false };
  }
}

/** ターンの区切りになる指示か。中断の知らせは user の行として残るが、利用者の発言ではない。 */
export function isTurnPrompt(text: string): boolean {
  return !text.startsWith('[Request interrupted');
}
```

`packages/shared/src/index.ts` の末尾に足す：

```ts
export * from './steps.ts';
```

`packages/ui/src/presenters/turns.ts` の `promptOf` を shared の規則に寄せる（振る舞いは変えない）：

```ts
import { isTurnPrompt, MAX_JUMP_HEADS, promptHead, type TranscriptEvent } from '@agent-hangar/shared';
```

```ts
function promptOf(e: TranscriptEvent): string | null {
  if (e.kind !== 'user') return null;
  return isTurnPrompt(e.text) ? e.text : null;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/shared/src/steps.test.ts packages/ui/src/presenters/turns.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/shared/src/steps.ts packages/shared/src/steps.test.ts
git commit packages/shared/src/steps.ts packages/shared/src/steps.test.ts packages/shared/src/index.ts packages/ui/src/presenters/turns.ts -m "feat(shared): name a tool call's kind and one-line text for the live pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Agent の結果にサブエージェントの id を残す

**Files:**
- Modify: `packages/shared/src/transcript.ts:6`（tool_result に `agentLaunch?` を足す）
- Modify: `packages/server/src/provider/claude-code/normalize.ts`（user の記録の `toolUseResult` を読む）
- Test: `packages/server/src/provider/claude-code/normalize.test.ts`

**Interfaces:**
- Produces: `tool_result` イベントの `agentLaunch?: { agentId: string; async: boolean }`。Agent の結果の記録（`toolUseResult.agentId`）から付く。`async` は `status === 'async_launched'` のとき真。

実物の記録では、バックグラウンドで起こした Agent の結果は `toolUseResult: { agentId, status: 'async_launched', … }` を持つ。
今の正規化はこの欄を捨てているので、レーンの題名と transcript を結べない。
readEvents は本文ファイルから毎回正規化し直すので、索引の作り直しは要らない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/provider/claude-code/normalize.test.ts` の末尾に足す：

```ts
describe('Agent の結果', () => {
  const rec = (toolUseResult?: unknown) => ({
    type: 'user', timestamp: '2026-10-01T01:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }] },
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
  });
  it('バックグラウンドで起こした Agent の結果に agentId を残す', () => {
    const [ev] = normalizeRecord(rec({ agentId: 'a020716d1a6ca2caa', status: 'async_launched', isAsync: true }), 0, null);
    expect(ev).toMatchObject({ kind: 'tool_result', toolId: 'toolu_1', agentLaunch: { agentId: 'a020716d1a6ca2caa', async: true } });
  });
  it('前面で終わった結果は async を偽にする', () => {
    const [ev] = normalizeRecord(rec({ agentId: 'b1', status: 'completed' }), 0, null);
    expect(ev).toMatchObject({ agentLaunch: { agentId: 'b1', async: false } });
  });
  it('toolUseResult が無い、または agentId を持たない結果には付けない', () => {
    expect(normalizeRecord(rec(), 0, null)[0]).not.toHaveProperty('agentLaunch');
    expect(normalizeRecord(rec({ stdout: 'x' }), 0, null)[0]).not.toHaveProperty('agentLaunch');
    expect(normalizeRecord(rec('text'), 0, null)[0]).not.toHaveProperty('agentLaunch');
  });
});
```

（ファイルの先頭に `describe`、`expect`、`it` と `normalizeRecord` の import が無ければ足す。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/normalize.test.ts`
Expected: FAIL（`agentLaunch` が無い）

- [ ] **Step 3: 実装する**

`packages/shared/src/transcript.ts` の tool_result の行を次に替える：

```ts
  // agentLaunch は Agent の結果にだけ付く。サブエージェントの transcript（subagents/agent-<agentId>.jsonl）と結ぶのに使う。
  | { kind: 'tool_result'; seq: number; ts?: number; toolId: string; text: string; isError: boolean; agentLaunch?: { agentId: string; async: boolean } }
```

`packages/server/src/provider/claude-code/normalize.ts` の `queuedPrompt` の後に足す：

```ts
/** Agent の結果の記録が持つ、起こしたサブエージェントの id。記録の最上位の toolUseResult にある。 */
function agentLaunchOf(raw: Rec): { agentId: string; async: boolean } | undefined {
  const r = raw.toolUseResult;
  if (!isRec(r)) return undefined;
  const agentId = str(r.agentId);
  return agentId ? { agentId, async: r.status === 'async_launched' } : undefined;
}
```

同じファイルの user の枝で、results を積む行を次に替える：

```ts
      else if (b.type === 'tool_result') {
        const r: Omit<Extract<TranscriptEvent, { kind: 'tool_result' }>, 'seq'> = { kind: 'tool_result', ts, toolId: str(b.tool_use_id) ?? '', text: contentText(b.content), isError: b.is_error === true };
        const launch = agentLaunchOf(raw);
        if (launch) r.agentLaunch = launch;
        results.push(r);
      }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code packages/server/src/transcript`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git commit packages/shared/src/transcript.ts packages/server/src/provider/claude-code/normalize.ts packages/server/src/provider/claude-code/normalize.test.ts -m "feat(server): keep the subagent id on an Agent call's result

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 意図の置き場と set_turn_intent

**Files:**
- Modify: `packages/server/src/db/migrations.ts`（末尾に version 12）
- Create: `packages/server/src/live/intents.ts`
- Modify: `packages/server/src/mcp/tools.ts`（`TOOL_NAMES`、`setTurnIntentTool`、`callTool`）
- Modify: `packages/server/src/mcp/app.ts`（`reg`）
- Test: `packages/server/src/mcp/tools.test.ts`

**Interfaces:**
- Produces:
  - `INTENT_MAX = 200`
  - `type TurnIntent = { at: number; text: string }`
  - `addIntent(db: Db, sessionId: string, text: string, now: number): TurnIntent`
  - `latestIntent(db: Db, sessionId: string): TurnIntent | null`
  - MCP ツール `set_turn_intent({ session_id?, text })` → `{ ok: true, session_id, at }`

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/mcp/tools.test.ts` の import に足す：

```ts
import { latestIntent } from '../live/intents.ts';
```

`SESSION_TOOL_CALLS` に 1 行足す：

```ts
  ['set_turn_intent', { text: '意図' }],
```

1 つ目の it の `expect(TOOL_NAMES).toHaveLength(11);` を `toHaveLength(12)` に替える。

`describe('MCP tools'` の中に足す：

```ts
  it('set_turn_intent は意図を積み、最新を返せるようにする', () => {
    const r = call('set_turn_intent', { text: '  抜けたあと、答え終えた会話だけ止める  ' }, { sessionId: alphaId });
    expect(r).toMatchObject({ ok: true, session_id: alphaId });
    expect(latestIntent(db, alphaId)).toEqual({ at: r.at, text: '抜けたあと、答え終えた会話だけ止める' });
  });
  it('set_turn_intent は空と 201 字以上を断る', () => {
    expect(() => call('set_turn_intent', { text: '   ' }, { sessionId: alphaId })).toThrow(ToolError);
    expect(() => call('set_turn_intent', { text: 'あ'.repeat(201) }, { sessionId: alphaId })).toThrow(ToolError);
    expect(call('set_turn_intent', { text: 'あ'.repeat(200) }, { sessionId: alphaId })).toMatchObject({ ok: true });
  });
  it('set_turn_intent はセッション別 URL のほかのセッションを指せない', () => {
    expect(() => call('set_turn_intent', { session_id: 'other', text: 'x' }, { sessionId: alphaId })).toThrow(ToolError);
  });
  it('同じミリ秒に 2 回書いても両方残り、後の方が最新になる', async () => {
    const { addIntent } = await import('../live/intents.ts');
    const a = addIntent(db, alphaId, '一つ目', 5000);
    const b = addIntent(db, alphaId, '二つ目', 5000);
    expect(b.at).toBe(a.at + 1);
    expect(latestIntent(db, alphaId)?.text).toBe('二つ目');
    expect((db.prepare('select count(*) c from turn_intents where session_id = ?').get(alphaId) as { c: number }).c).toBe(2);
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/mcp/tools.test.ts`
Expected: FAIL（`../live/intents.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/server/src/db/migrations.ts` の配列の末尾（version 11 の後）に足す：

```ts
  {
    // セッションが set_turn_intent で書いた「このターンで何のために何をするか」。右ペインの意図の段に出す。
    // そのターンのあいだしか意味を持たないので端末ローカルの表にし、同期しない（D1 の書き込みの枠を使わない）。
    version: 12,
    sql: `
create table turn_intents (
  session_id text not null,
  at integer not null,
  text text not null,
  primary key (session_id, at)
);
`,
  },
```

`packages/server/src/live/intents.ts`：

```ts
import type { Db } from '../db/open.ts';

/** 意図の本文の上限。長い意図は横目で読めない。 */
export const INTENT_MAX = 200;

export type TurnIntent = { at: number; text: string };

/** 意図を積む。同じミリ秒に 2 度来たら、後の方を 1 ミリ秒ずつずらして両方残す。 */
export function addIntent(db: Db, sessionId: string, text: string, now: number): TurnIntent {
  let at = now;
  const taken = db.prepare('select 1 from turn_intents where session_id = ? and at = ?');
  while (taken.get(sessionId, at)) at++;
  db.prepare('insert into turn_intents (session_id, at, text) values (?, ?, ?)').run(sessionId, at, text);
  return { at, text };
}

export function latestIntent(db: Db, sessionId: string): TurnIntent | null {
  return (db.prepare('select at, text from turn_intents where session_id = ? order by at desc limit 1').get(sessionId) as TurnIntent | undefined) ?? null;
}
```

`packages/server/src/mcp/tools.ts`：

import に足す：

```ts
import { addIntent, INTENT_MAX } from '../live/intents.ts';
```

`TOOL_NAMES` の `'set_session_summary',` の後に `'set_turn_intent',` を足す。

`setSessionMemoTool` の前に足す：

```ts
/**
 * このターンの意図を書く。要約（set_session_summary）とは粒度が違うので、別のツールにしてある。
 * 数え方は Array.from で文字単位にする（サロゲートの字を 2 字と数えない）。
 */
export function setTurnIntentTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, now = Date.now()) {
  const id = sessionIdOf(ctx, args);
  requireSession(deps, id);
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (text.length === 0 || [...text].length > INTENT_MAX) throw new ToolError(`text は空白を除いて 1 字以上 ${INTENT_MAX} 字以下です`);
  const it = addIntent(deps.db, id, text, now);
  return { ok: true, session_id: id, at: it.at };
}
```

`callTool` の switch の `set_session_summary` の後に足す：

```ts
    case 'set_turn_intent': return setTurnIntentTool(deps, ctx, args);
```

`packages/server/src/mcp/app.ts` の `set_session_summary` の `reg` の後に足す：

```ts
  reg('set_turn_intent', D('このターンで何のために何をするかを 1〜2 文（200 字まで）で書く。ターンを始めたときと方針を変えたときに呼ぶ。hangar の右ペインに出る。'), { session_id: z.string().optional(), text: z.string() });
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/mcp packages/server/src/db`
Expected: PASS（`db.test.ts` は最新の版を `MIGRATIONS` の末尾から読むので、数を書き換える所は無い）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/live/intents.ts
git commit packages/server/src/db/migrations.ts packages/server/src/live/intents.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/app.ts packages/server/src/mcp/tools.test.ts -m "feat(server): let a session write its turn intent through MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 注入する指示に 2 行を足す

**Files:**
- Modify: `packages/server/src/launch/injection.ts`
- Test: `packages/server/src/launch/injection.test.ts`

**Interfaces:**
- Consumes: Task 3 の `set_turn_intent`（ツール名だけ）

- [ ] **Step 1: 失敗するテストを書く**

`injection.test.ts` の 1 つ目の it の末尾に足す：

```ts
    expect(t).toContain('ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。\nBash と Agent の description は日本語で 20 字以内にしてください。\n');
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/launch/injection.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`renderInjection` の配列の `'完了にするのは利用者です。確かめられていないものは出さないでください。',` の後、末尾の `''` の前に足す：

```ts
    'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
    'Bash と Agent の description は日本語で 20 字以内にしてください。',
```

関数の JSDoc の 1 行目を「要約の更新、片付いた TODO の候補、ターンの意図、日本語の手の説明を求める。」に替える。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/launch packages/server/src/runs`
Expected: PASS（`manager.test.ts` が注入の全文を照合していて落ちたら、その期待値に同じ 2 行を足す）

- [ ] **Step 5: コミット**

```bash
git commit packages/server/src/launch/injection.ts packages/server/src/launch/injection.test.ts -m "feat(server): ask a hangar session for its turn intent and Japanese step descriptions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（`manager.test.ts` を直したときは、そのパスもコミットに足す。）

---

### Task 5: ライブの要約と GET /api/sessions/:id/live

**Files:**
- Modify: `packages/shared/src/api.ts`（`LiveAgentDto`、`LiveIntentDto`、`LiveDigestDto`）
- Create: `packages/server/src/live/digest.ts`
- Create: `packages/server/src/live/digest.test.ts`
- Modify: `packages/server/src/http/app.ts`（経路）
- Test: `packages/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: Task 1 の `isTurnPrompt`、`stepKind`、`stepLine`、`StepKind`。Task 2 の `agentLaunch`。Task 3 の `latestIntent`。
- Produces:
  - `type LiveAgentDto = { agentId: string; title: string; state: 'running' | 'done' | 'error'; startedAt: number | null; lastAt: number | null; last: { text: string; mono: boolean; kind: StepKind; isError: boolean } | null; report: string | null; linked: boolean }`
  - `type LiveIntentDto = { text: string; at: number; stepsSince: number; inThisTurn: boolean }`
  - `type LiveDigestDto = { sessionId: string; turnStartSeq: number | null; intent: LiveIntentDto | null; agents: LiveAgentDto[] }`
  - `buildLiveDigest(db: Db, sessionId: string): LiveDigestDto`
  - `class LiveDigester { constructor(db: Db); digest(sessionId: string): LiveDigestDto }`
  - `GET /api/sessions/:id/live` → `LiveDigestDto`（無いセッションは 404）

`linked` は、そのレーンがサブエージェントの transcript と結べたか（押して開けるか）である。
結べないレーン（起こしたが結果がエラーで返ったもの）の `agentId` は `tool:<toolId>` にする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/live/digest.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { addIntent } from './intents.ts';
import { buildLiveDigest, LiveDigester } from './digest.ts';

const SID = 'bbbbbbbb-0000-4000-8000-000000000001';
const at = (s: number) => Date.UTC(2026, 9, 1, 1, 0, s);
const T = (s: number) => new Date(at(s)).toISOString();
const base = (s: number) => ({ uuid: `x${s}-${Math.random()}`, timestamp: T(s), cwd: '/w/live', sessionId: SID });
const user = (s: number, content: unknown) => ({ type: 'user', message: { role: 'user', content }, ...base(s) });
const toolUse = (s: number, id: string, name: string, input: unknown) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }] }, ...base(s) });
const result = (s: number, id: string, text: string, extra: Record<string, unknown> = {}, isError = false) => ({ ...user(s, [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }]), ...extra });
const say = (s: number, text: string) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] }, ...base(s) });
const notify = (s: number, agentId: string, status: string) => user(s, `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`);
const launched = (agentId: string) => ({ toolUseResult: { agentId, status: 'async_launched', isAsync: true } });

let dir: string;
let db: Db;
let sid: string;

function write(file: string, rows: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
async function index() {
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  sid = (db.prepare('select id from sessions where provider_session_id = ?').get(SID) as { id: string }).id;
}
const proj = () => path.join(dir, 'projects', '-w-live');
const sub = (agentId: string) => path.join(proj(), SID, 'subagents', `agent-${agentId}.jsonl`);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-live-')); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('buildLiveDigest', () => {
  beforeEach(async () => {
    write(path.join(proj(), `${SID}.jsonl`), [
      user(0, '前の指示'),
      toolUse(0.2, 'toolu_prev', 'Agent', { description: '前のターンの担当', prompt: 'p', run_in_background: true }),
      result(0.3, 'toolu_prev', 'Async agent launched', launched('aaa0')),
      user(1, 'レビューを並べて'),
      toolUse(2, 'toolu_a1', 'Agent', { description: 'クラウドを査読', prompt: 'p', run_in_background: true }),
      result(3, 'toolu_a1', 'Async agent launched', launched('aaa1')),
      toolUse(4, 'toolu_a2', 'Agent', { description: '文書を直す', prompt: 'p', run_in_background: true }),
      result(5, 'toolu_a2', 'Async agent launched', launched('aaa2')),
      toolUse(6, 'toolu_a3', 'Agent', { description: '壊れる担当', prompt: 'p' }),
      result(7, 'toolu_a3', 'Agent type not found', {}, true),
      toolUse(7.5, 'toolu_a9', 'Agent', { description: 'まだ始まらない担当', prompt: 'p', run_in_background: true }),
      result(7.6, 'toolu_a9', 'Async agent launched', launched('aaa9')),
      notify(20, 'aaa2', 'completed'),
      user(21, '[Request interrupted by user]'),
    ]);
    write(sub('aaa0'), [
      user(0.5, '前のターンの担当です。README を見て'),
      toolUse(12, 'toolu_s0', 'Read', { file_path: '/w/live/README.md' }),
    ]);
    write(sub('aaa1'), [
      user(2.5, 'クラウドを査読して'),
      toolUse(10, 'toolu_s1', 'Bash', { command: 'npx vitest run', description: 'テストを走らせる' }),
      result(11, 'toolu_s1', 'ok'),
    ]);
    write(sub('aaa2'), [
      user(4.5, '文書を直して'),
      toolUse(8, 'toolu_s2', 'Read', { file_path: '/w/live/README.md' }),
      result(9, 'toolu_s2', 'x'),
      say(19, '# 済：README を 3 か所直した\n詳細は次のとおり'),
    ]);
    await index();
  });

  it('今のターンの頭は、中断の知らせを除いた最後の指示', () => {
    const d = buildLiveDigest(db, sid);
    const seq = (db.prepare("select seq from event_index where session_id = ? and parent_agent is null and kind = 'user' order by seq").all(sid) as { seq: number }[]).map((r) => r.seq);
    // 3 つの指示（前の指示、レビューを並べて、中断）のうち 2 つ目。
    expect(d.turnStartSeq).toBe(seq[1]);
  });

  it('レーンは今のターンに起こした本と、前のターンから動き続けている本', () => {
    const d = buildLiveDigest(db, sid);
    expect(d.agents.map((a) => [a.agentId, a.title, a.state, a.linked])).toEqual([
      ['aaa1', 'クラウドを査読', 'running', true],
      ['aaa2', '文書を直す', 'done', true],
      ['tool:toolu_a3', '壊れる担当', 'error', false],
      ['aaa9', 'まだ始まらない担当', 'running', true],
      ['aaa0', '前のターンの担当です。README を見て', 'running', true],
    ]);
  });

  it('動いている本は最後の手を、終わった本は最後の報告の 1 行目を持つ', () => {
    const d = buildLiveDigest(db, sid);
    const by = (id: string) => d.agents.find((a) => a.agentId === id)!;
    expect(by('aaa1').last).toEqual({ text: 'テストを走らせる', mono: false, kind: 'run', isError: false });
    expect(by('aaa1').report).toBeNull();
    expect(by('aaa1')).toMatchObject({ startedAt: at(2.5), lastAt: at(11) });
    expect(by('aaa2').report).toBe('済：README を 3 か所直した');
    // まだ transcript の無い本は、起こした時刻だけを持ち、落ちない。
    expect(by('aaa9')).toMatchObject({ last: null, report: null, startedAt: at(7.5), lastAt: at(7.5) });
  });

  it('意図は最新の 1 件と、書いてから呼んだツールの数（主線とサブエージェントの合計）', () => {
    addIntent(db, sid, 'レビューを並べて待つ', at(5));
    const d = buildLiveDigest(db, sid);
    // at(5) より後のツール呼び出し：a3（6）、a9（7.5）、aaa2 の Read（8）、aaa1 の Bash（10）、aaa0 の Read（12）。
    expect(d.intent).toEqual({ text: 'レビューを並べて待つ', at: at(5), stepsSince: 5, inThisTurn: true });
  });

  it('今のターンより前に書かれた意図は inThisTurn が偽', () => {
    addIntent(db, sid, '前のターンの意図', at(0.1));
    expect(buildLiveDigest(db, sid).intent).toMatchObject({ text: '前のターンの意図', inThisTurn: false });
  });

  it('意図が一度も書かれていなければ null', () => {
    expect(buildLiveDigest(db, sid).intent).toBeNull();
  });
});

describe('agentId の無い古い記録', () => {
  it('Agent の呼び出しと、今のターンに始まったサブエージェントを順番で突き合わせる', async () => {
    write(path.join(proj(), `${SID}.jsonl`), [
      user(1, '調べて'),
      toolUse(2, 'toolu_o1', 'Task', { description: '古い形の担当', prompt: 'p' }),
      result(9, 'toolu_o1', '報告です'),
    ]);
    write(sub('old1'), [user(3, '古い形の担当です'), say(8, '調べ終えた')]);
    await index();
    expect(buildLiveDigest(db, sid).agents).toEqual([
      expect.objectContaining({ agentId: 'old1', title: '古い形の担当', state: 'done', linked: true, report: '調べ終えた' }),
    ]);
  });
});

describe('LiveDigester', () => {
  it('索引と意図が変わっていなければ、同じ要約をそのまま返す', async () => {
    write(path.join(proj(), `${SID}.jsonl`), [user(1, '見て')]);
    await index();
    const g = new LiveDigester(db);
    const a = g.digest(sid);
    expect(g.digest(sid)).toBe(a);
    addIntent(db, sid, '新しい意図', at(2));
    expect(g.digest(sid)).not.toBe(a);
  });
});
```

`packages/server/src/http/app.test.ts` の `describe` のどれか（`/api/sessions/:id/events` を試している所の近く）に足す：

```ts
  it('GET /api/sessions/:id/live はライブの要約を返し、無いセッションは 404', async () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const r = await json(await get(`/api/sessions/${id}/live`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sessionId: id, intent: null });
    expect(Array.isArray(r.body.agents)).toBe(true);
    expect((await get('/api/sessions/ghost/live')).status).toBe(404);
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/live packages/server/src/http/app.test.ts`
Expected: FAIL（`./digest.ts` が無い、経路が 404）

- [ ] **Step 3: 型を足す**

`packages/shared/src/api.ts` の先頭の import に足す：

```ts
import type { StepKind } from './steps.ts';
```

`EventsPageDto` の行の後に足す：

```ts
/**
 * 実行中のセッションの右ペインに出すライブの要約。サーバが主線とサブエージェントを読んで作る。
 * 指揮役の手と目次の色帯は UI が主線のイベントから作るので、ここには載せない。
 * linked はサブエージェントの transcript と結べたか。結べないレーンの agentId は `tool:<toolId>` である。
 */
export type LiveAgentDto = { agentId: string; title: string; state: 'running' | 'done' | 'error'; startedAt: number | null; lastAt: number | null; last: { text: string; mono: boolean; kind: StepKind; isError: boolean } | null; report: string | null; linked: boolean };
export type LiveIntentDto = { text: string; at: number; stepsSince: number; inThisTurn: boolean };
export type LiveDigestDto = { sessionId: string; turnStartSeq: number | null; intent: LiveIntentDto | null; agents: LiveAgentDto[] };
```

- [ ] **Step 4: 要約を実装する**

`packages/server/src/live/digest.ts`：

```ts
import { isTurnPrompt, stepKind, stepLine, type LiveAgentDto, type LiveDigestDto, type TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readEvents } from '../transcript/read.ts';
import { latestIntent } from './intents.ts';

type Call = Extract<TranscriptEvent, { kind: 'tool_call' }>;
type Result = Extract<TranscriptEvent, { kind: 'tool_result' }>;
type Stat = { agent: string; first: number | null; last: number | null };

const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** 1 ターンで読む主線のイベントの上限。何千手も続く指揮役のターンでも、ここで打ち切る。 */
const MAIN_CAP = 10_000;
/** サブエージェントの末尾から読む数。最後の手と最後の報告が入れば足りる。 */
const AGENT_TAIL = 60;

const isCall = (e: TranscriptEvent): e is Call => e.kind === 'tool_call';
const isResult = (e: TranscriptEvent): e is Result => e.kind === 'tool_result';
const tag = (text: string, name: string): string | null => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** 本文の最初の空でない行。見出しや強調の記号は落とす。 */
function firstLine(text: string, max = 120): string | null {
  const line = text.split('\n').map((l) => l.replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').trim()).find((l) => l !== '');
  return line ? [...line].slice(0, max).join('') : null;
}

/** 今のターンの頭。中断の知らせを除いた、主線の最後の利用者の指示。 */
export function turnStart(db: Db, sessionId: string): { seq: number; ts: number | null } | null {
  const rows = db.prepare("select seq, ts from event_index where session_id = ? and parent_agent is null and kind = 'user' order by seq desc limit 20").all(sessionId) as { seq: number; ts: number | null }[];
  for (const r of rows) {
    const ev = readEvents(db, sessionId, { fromSeq: r.seq, limit: 1 }).events.find((e) => e.seq === r.seq);
    if (ev && ev.kind === 'user' && isTurnPrompt(ev.text)) return r;
  }
  return null;
}

function mainSince(db: Db, sessionId: string, fromSeq: number): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  let seq: number | null = fromSeq;
  while (seq !== null && out.length < MAIN_CAP) {
    const p = readEvents(db, sessionId, { fromSeq: seq, limit: 2000 });
    out.push(...p.events);
    seq = p.nextSeq;
  }
  return out;
}

/** バックグラウンドの本が終わったことを知らせる <task-notification> の、本ごとの最後の status。 */
function notifications(main: TranscriptEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of main) {
    if (e.kind !== 'system' || !e.text.trimStart().startsWith('<task-notification>')) continue;
    const id = tag(e.text, 'task-id');
    const st = tag(e.text, 'status');
    if (id && st) m.set(id, st);
  }
  return m;
}

function stats(db: Db, sessionId: string): Stat[] {
  return db.prepare('select parent_agent agent, min(ts) first, max(ts) last from event_index where session_id = ? and parent_agent is not null group by parent_agent order by min(ts), min(seq)').all(sessionId) as Stat[];
}

/** サブエージェントの末尾から、最後の手と最後の報告を取る。 */
function tail(db: Db, sessionId: string, agentId: string): Pick<LiveAgentDto, 'last'> & { said: string | null } {
  const events = readEvents(db, sessionId, { agentId, latest: true, limit: AGENT_TAIL }).events;
  const results = new Map(events.filter(isResult).map((r) => [r.toolId, r]));
  const call = [...events].reverse().find(isCall) ?? null;
  const last = call ? { ...stepLine(call), kind: stepKind(call), isError: results.get(call.toolId)?.isError === true } : null;
  const said = [...events].reverse().find((e) => e.kind === 'assistant' && e.text.trim() !== '');
  return { last, said: said && said.kind === 'assistant' ? said.text : null };
}

/** 前のターンから動き続けている本の題名。起こした呼び出しが今のターンに無いので、その本が受け取った指示の書き出しにする。 */
function promptTitle(db: Db, sessionId: string, agentId: string): string {
  const first = readEvents(db, sessionId, { agentId, fromSeq: 0, limit: 5 }).events.find((e) => e.kind === 'user');
  return (first && first.kind === 'user' ? firstLine(first.text, 40) : null) ?? agentId;
}

type Seed = { agentId: string; title: string; call: Call | null; result: Result | null; linked: boolean };

function agentsOf(db: Db, sessionId: string, main: TranscriptEvent[], since: number): LiveAgentDto[] {
  const results = new Map(main.filter(isResult).map((r) => [r.toolId, r]));
  const done = notifications(main);
  const st = stats(db, sessionId);
  const statOf = new Map(st.map((s) => [s.agent, s]));
  const seeds: Seed[] = [];
  const unlinked: Seed[] = [];
  for (const c of main.filter(isCall)) {
    if (!AGENT_TOOLS.has(c.name)) continue;
    const r = results.get(c.toolId) ?? null;
    const title = (c.input && typeof c.input === 'object' ? str((c.input as Record<string, unknown>).description) : undefined) ?? c.summary;
    const id = r?.agentLaunch?.agentId;
    if (id) seeds.push({ agentId: id, title, call: c, result: r, linked: true });
    else if (r?.isError) seeds.push({ agentId: `tool:${c.toolId}`, title, call: c, result: r, linked: false });
    else { const s: Seed = { agentId: `tool:${c.toolId}`, title, call: c, result: r, linked: false }; seeds.push(s); unlinked.push(s); }
  }
  // agentId を持たない古い記録は、今のターンに始まったまだ結んでいない本と順番で突き合わせる。
  const taken = new Set(seeds.filter((s) => s.linked).map((s) => s.agentId));
  const fresh = st.filter((s) => !taken.has(s.agent) && (s.first ?? 0) >= since);
  unlinked.forEach((s, i) => { const f = fresh[i]; if (f) { s.agentId = f.agent; s.linked = true; taken.add(f.agent); } });
  // 前のターンに起こし、今のターンにも手を動かしている本。
  for (const s of st) {
    if (taken.has(s.agent) || (s.last ?? 0) < since) continue;
    seeds.push({ agentId: s.agent, title: promptTitle(db, sessionId, s.agent), call: null, result: null, linked: true });
    taken.add(s.agent);
  }
  return seeds.map((s): LiveAgentDto => {
    const stat = s.linked ? statOf.get(s.agentId) : undefined;
    const t = stat ? tail(db, sessionId, s.agentId) : { last: null, said: null };
    const note = done.get(s.agentId);
    const state: LiveAgentDto['state'] = s.result?.isError ? 'error'
      : note !== undefined ? (note === 'completed' ? 'done' : 'error')
      : s.result && !s.result.agentLaunch?.async && s.call ? 'done'
      : 'running';
    const born = s.call?.ts ?? null;
    return {
      agentId: s.agentId, title: s.title, state,
      startedAt: stat?.first ?? born, lastAt: stat?.last ?? born,
      // linked は agentLaunch か順番の突き合わせか前のターンからの本のときだけ真である。
      // 起こした直後でまだ transcript の無い本も、押せば空の transcript が開くだけなので真のままにする。
      last: t.last, report: state === 'running' || t.said === null ? null : firstLine(t.said), linked: s.linked,
    };
  });
}

/** 右ペインのライブの要約。今のターンの頭から読む。 */
export function buildLiveDigest(db: Db, sessionId: string): LiveDigestDto {
  const start = turnStart(db, sessionId);
  const main = start ? mainSince(db, sessionId, start.seq) : [];
  const since = start?.ts ?? 0;
  const agents = start ? agentsOf(db, sessionId, main, since) : [];
  const it = latestIntent(db, sessionId);
  const stepsSince = (at: number) => (db.prepare("select count(*) c from event_index where session_id = ? and kind = 'tool_call' and ts > ?").get(sessionId, at) as { c: number }).c;
  const intent = it ? { text: it.text, at: it.at, stepsSince: stepsSince(it.at), inThisTurn: start?.ts == null || it.at >= start.ts } : null;
  return { sessionId, turnStartSeq: start?.seq ?? null, intent, agents };
}

/**
 * 要約を覚えておく。UI は追記のたびに取り直すので、索引と意図が変わっていなければ読み直さない。
 * 経過時間は UI が今の時刻で数えるので、覚えた要約が古くなることは無い。
 */
export class LiveDigester {
  private readonly cache = new Map<string, { key: string; digest: LiveDigestDto }>();
  constructor(private readonly db: Db) {}
  digest(sessionId: string): LiveDigestDto {
    const key = this.keyOf(sessionId);
    const hit = this.cache.get(sessionId);
    if (hit && hit.key === key) return hit.digest;
    const digest = buildLiveDigest(this.db, sessionId);
    this.cache.set(sessionId, { key, digest });
    return digest;
  }
  private keyOf(sessionId: string): string {
    const r = this.db.prepare('select max(seq) m, count(*) c, max(ts) t from event_index where session_id = ?').get(sessionId) as { m: number | null; c: number; t: number | null };
    return `${r.m}:${r.c}:${r.t}:${latestIntent(this.db, sessionId)?.at ?? ''}`;
  }
}
```

- [ ] **Step 5: 経路を足す**

`packages/server/src/http/app.ts` の import に足す：

```ts
import { LiveDigester } from '../live/digest.ts';
```

`createApp` の中、`const broadcastSession = …` の行の後に足す：

```ts
  const digester = new LiveDigester(db);
```

`api.get('/sessions/:id/subagents', …)` の行の後に足す：

```ts
  // 実行中のセッションの右ペイン。UI は追記のたびに取り直すが、索引が変わっていなければ覚えた要約を返す。
  api.get('/sessions/:id/live', (c) => {
    const id = c.req.param('id');
    if (!session(id)) return c.json({ error: 'セッションが見つかりません' }, 404);
    try {
      return c.json(digester.digest(id));
    } catch (e) {
      if (isEnoent(e)) return c.json({ error: 'このセッションの本文はこの PC にありません' }, 404);
      throw e;
    }
  });
```

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run packages/server/src/live packages/server/src/http/app.test.ts`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
git add packages/server/src/live/digest.ts packages/server/src/live/digest.test.ts
git commit packages/shared/src/api.ts packages/server/src/live/digest.ts packages/server/src/live/digest.test.ts packages/server/src/http/app.ts packages/server/src/http/app.test.ts -m "feat(server): digest the running turn's intent and subagents for the live pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: UI で要約を取り、store に置く

**Files:**
- Modify: `packages/ui/src/runtime/api.ts`（`ApiClient.live` と実装）
- Modify: `packages/ui/src/store/store.ts`（`liveDigests`、`applyLiveDigest`）
- Modify: `packages/ui/src/runtime/runtime.ts`（`loadLive`）
- Modify: `packages/ui/src/test/fakeApi.ts`（`live` の偽物）
- Test: `packages/ui/src/runtime/runtime.test.ts`

**Interfaces:**
- Consumes: Task 5 の `LiveDigestDto` と経路
- Produces:
  - `ApiClient.live(sessionId: string): Promise<LiveDigestDto>`
  - `Store.liveDigests: Record<string, LiveDigestDto>`
  - `applyLiveDigest(store: Store, d: LiveDigestDto): Store`

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/runtime/runtime.test.ts` の `describe('createRuntime'` の中に足す：

```ts
  const aliveRun = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start' as const, tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
  it('実行中のセッションは本文を読むときに右ペインの要約も取り、1 秒に 1 回までにまとめる', async () => {
    let clock = 10_000;
    const { rt, api, setHash, timers } = harness({}, { now: () => clock });
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: aliveRun } });
    setHash('#/session/s1');
    await flush();
    expect(api.live).toHaveBeenCalledTimes(1);
    expect(rt.getStore().liveDigests.s1).toMatchObject({ sessionId: 's1' });
    const before = timers.length;
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's1', count: 1 } });
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's1', count: 1 } });
    await flush();
    // 1 秒たつまでは取りに行かず、予約は 1 つだけにする。
    expect(api.live).toHaveBeenCalledTimes(1);
    const mine = timers.slice(before).filter((t) => t.ms === 1000);
    expect(mine).toHaveLength(1);
    clock += 1000;
    mine[0]!.fn();
    await flush();
    expect(api.live).toHaveBeenCalledTimes(2);
  });
  it('生きた run の無いセッションでは要約を取らない', async () => {
    const { rt, api, setHash } = harness();
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.live).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts`
Expected: FAIL（`api.live` が無い）

- [ ] **Step 3: 実装する**

`packages/ui/src/runtime/api.ts`：import の型の並びに `LiveDigestDto` を足し、`ApiClient` の `subagents` の行の後に足す：

```ts
  /** 実行中のセッションの右ペインに出すライブの要約。 */
  live(sessionId: string): Promise<LiveDigestDto>;
```

実装の `subagents:` の行の後に足す：

```ts
    live: (sessionId) => call(`/api/sessions/${sessionId}/live`),
```

`packages/ui/src/store/store.ts`：import の型の並びに `LiveDigestDto` を足す。`Store` の `events: …; subagents: …;` の行を次に替える：

```ts
  events: Record<string, EventsSlice>; subagents: Record<string, string[]>;
  /** 実行中のセッションの右ペインに出すライブの要約。開いたセッションの分だけ持つ。 */
  liveDigests: Record<string, LiveDigestDto>;
```

`initialStore` の `subagents: {},` の後に `liveDigests: {},` を足す。`applySubagents` の後に足す：

```ts
export function applyLiveDigest(store: Store, d: LiveDigestDto): Store {
  return { ...store, liveDigests: { ...store.liveDigests, [d.sessionId]: d } };
}
```

`packages/ui/src/runtime/runtime.ts`：store からの import に `aliveRunOf` と `applyLiveDigest` を足す。`loadSubagents` の関数の後に足す：

```ts
  /**
   * 右ペインのライブの要約を取る。追記のたびに呼ばれるので、1 秒に 1 回までにまとめる。
   * 間に来た呼び出しは捨てず、1 秒後に 1 回だけ取り直す予約にまとめる（最後の追記を取りこぼさない）。
   * 右ペインは補助の表示なので、失敗はトーストにしない。
   */
  const LIVE_GAP_MS = 1000;
  const liveNext = new Map<string, number>();
  const liveWaiting = new Set<string>();
  const clock = () => (deps.now ?? Date.now)();
  function loadLive(sessionId: string): void {
    if (aliveRunOf(store, sessionId) === null || liveWaiting.has(sessionId)) return;
    const go = () => {
      liveWaiting.delete(sessionId);
      liveNext.set(sessionId, clock() + LIVE_GAP_MS);
      deps.api.live(sessionId).then((d) => setStore(applyLiveDigest(store, d))).catch(() => {});
    };
    const wait = (liveNext.get(sessionId) ?? 0) - clock();
    if (wait <= 0) go();
    else { liveWaiting.add(sessionId); deps.setTimeout(go, wait); }
  }
```

`case 'api.loadEvents':` の中、`loadSubagents(e.sessionId);` の行の後に足す：

```ts
        loadLive(e.sessionId);
```

`packages/ui/src/test/fakeApi.ts`：`Extras` の `Pick` の並びの最後の行に `| 'live'` を足し、返す object に足す：

```ts
    live: vi.fn(async (sessionId: string) => ({ sessionId, turnStartSeq: null, intent: null, agents: [] })),
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/runtime packages/ui/src/store && npm run typecheck`
Expected: PASS、型の誤り 0 件（`ApiClient` を実装している別の偽物が型で落ちたら、同じ `live` の偽物を足す）

- [ ] **Step 5: コミット**

```bash
git commit packages/ui/src/runtime/api.ts packages/ui/src/store/store.ts packages/ui/src/runtime/runtime.ts packages/ui/src/test/fakeApi.ts packages/ui/src/runtime/runtime.test.ts -m "feat(ui): fetch the live digest alongside the transcript, at most once a second

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 右ペインの presenter

**Files:**
- Create: `packages/ui/src/presenters/live.ts`
- Create: `packages/ui/src/presenters/live.test.ts`
- Modify: `packages/ui/src/presenters/session.ts`（`TurnRowProps.band`、`SessionProps.livePane`、`presentSession`）

**Interfaces:**
- Consumes: Task 1 の `stepKind`、`stepLine`、`StepCell`。Task 5 の `LiveDigestDto`。Task 6 の `store.liveDigests`。`./format.ts` の `durationLabel`。
- Produces:
  - `type LampProps = { tone: 'busy' | 'wait' | 'idle'; head: string; sub: string }`
  - `type IntentProps = { kind: 'said'; text: string; meta: string; stale: boolean } | { kind: 'none'; text: string }`
  - `type StepRowProps = { text: string; mono: boolean; when: string; mark: 'done' | 'now' | 'fail' }`
  - `type LaneProps = { agentId: string; title: string; tone: 'running' | 'done' | 'error'; elapsed: string; line: string; quoted: boolean; selectable: boolean }`
  - `type LivePaneProps = { lamp: LampProps; intent: IntentProps; steps: StepRowProps[]; lanes: LaneProps[]; doneFolded: number }`
  - `bandOf(events: TranscriptEvent[], from: number, to: number): StepCell[]`
  - `presentLivePane(input: LiveInput): LivePaneProps`
  - `TurnRowProps` に `band: StepCell[]`、`SessionProps` に `livePane: LivePaneProps | null`

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/presenters/live.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { LiveAgentDto, LiveDigestDto, TranscriptEvent } from '@agent-hangar/shared';
import { bandOf, presentLivePane, type LiveInput } from './live.ts';

let seq = 0;
const call = (name: string, input: unknown, ts = 0): TranscriptEvent => ({ kind: 'tool_call', seq: seq++, ts, toolId: `t${seq}`, name, input, summary: name });
const res = (c: TranscriptEvent, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq: seq++, toolId: (c as { toolId: string }).toolId, text: '', isError });
const prompt = (text: string): TranscriptEvent => ({ kind: 'user', seq: seq++, text });
const clock = (ts: number) => `t${ts}`;
const digest = (p: Partial<LiveDigestDto> = {}): LiveDigestDto => ({ sessionId: 's1', turnStartSeq: 0, intent: null, agents: [], ...p });
const agent = (p: Partial<LiveAgentDto>): LiveAgentDto => ({ agentId: 'a', title: '担当', state: 'running', startedAt: 0, lastAt: 60_000, last: null, report: null, linked: true, ...p });
const input = (p: Partial<LiveInput> = {}): LiveInput => ({ digest: digest(), events: [], turnFrom: 0, turnNo: 1, live: 'busy', activity: null, now: 120_000, viewingAgent: false, clock, idleFor: '3 分', ...p });

describe('状態の灯', () => {
  it('質問を待っていれば、動いている本があっても答え待ちを出す', () => {
    const p = presentLivePane(input({ live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: 'tmux の既定を変えてよいか' }, digest: digest({ agents: [agent({})] }) }));
    expect(p.lamp).toEqual({ tone: 'wait', head: 'あなたの答え待ち', sub: 'tmux の既定を変えてよいか' });
  });
  it('サブエージェントが動いていれば本数と、失敗と済みの数', () => {
    const p = presentLivePane(input({ digest: digest({ agents: [agent({ agentId: 'a' }), agent({ agentId: 'b' }), agent({ agentId: 'c', state: 'error' }), agent({ agentId: 'd', state: 'done' })] }) }));
    expect(p.lamp).toEqual({ tone: 'busy', head: '2 本動いている', sub: '失敗 1、済 1' });
  });
  it('主線だけが作業中ならターンと手の数', () => {
    seq = 0;
    const c1 = call('Read', { file_path: '/w/a.ts' });
    const p = presentLivePane(input({ events: [prompt('x'), c1, res(c1), call('Bash', { command: 'npm test', description: 'テスト' })], turnNo: 3 }));
    expect(p.lamp).toEqual({ tone: 'busy', head: '作業中', sub: 'ターン 3・2 手目' });
  });
  it('休みは最後の手からの経過', () => {
    expect(presentLivePane(input({ live: 'idle' })).lamp).toEqual({ tone: 'idle', head: '休み', sub: '3 分' });
  });
});

describe('意図', () => {
  it('今のターンの意図は引用符で出し、30 手を超えたら薄くする', () => {
    const at = 0;
    expect(presentLivePane(input({ digest: digest({ intent: { text: '答え終えた会話だけ止める', at, stepsSince: 30, inThisTurn: true } }) })).intent)
      .toEqual({ kind: 'said', text: '答え終えた会話だけ止める', meta: 'Claude いわく・t0・その後 30 手', stale: false });
    expect(presentLivePane(input({ digest: digest({ intent: { text: 'x', at, stepsSince: 31, inThisTurn: true } }) })).intent).toMatchObject({ stale: true });
  });
  it('前のターンの意図は出さず、まだ書かれていないと言う', () => {
    expect(presentLivePane(input({ digest: digest({ intent: { text: '古い', at: 0, stepsSince: 3, inThisTurn: false } }) })).intent).toEqual({ kind: 'none', text: 'このターンの意図はまだ書かれていない' });
  });
  it('一度も書かれていなければそう言う（外で起動したセッションもここに来る）', () => {
    expect(presentLivePane(input()).intent).toEqual({ kind: 'none', text: '意図は書かれていない' });
    expect(presentLivePane(input({ digest: null })).intent).toEqual({ kind: 'none', text: '意図は書かれていない' });
  });
});

describe('指揮役の手', () => {
  it('続けて読んだ手は 1 行に畳み、最後の 4 行を出し、結果の無い最後の手をいまにする', () => {
    seq = 0;
    const r1 = call('Read', { file_path: '/w/a.ts' }, 1); const r2 = call('Read', { file_path: '/w/b.ts' }, 2); const r3 = call('Bash', { command: 'cat c', description: 'c を読む' }, 3);
    const e1 = call('Edit', { file_path: '/w/a.ts' }, 4); const t1 = call('Bash', { command: 'npx vitest', description: 'テストを走らせる' }, 5);
    const w1 = call('Write', { file_path: '/w/d.md' }, 6); const t2 = call('Bash', { command: 'npx vitest', description: 'もう一度走らせる' }, 7);
    const ag = call('Agent', { description: '担当' }, 8); const mcp = call('mcp__hangar__set_turn_intent', { text: 'x' }, 9);
    const events = [prompt('x'), r1, res(r1), r2, res(r2), r3, res(r3), e1, res(e1), t1, res(t1, true), w1, res(w1), ag, res(ag), mcp, res(mcp), t2];
    const p = presentLivePane(input({ events }));
    expect(p.steps).toEqual([
      { text: 'a.ts を書き換えた', mono: false, when: 't4', mark: 'done' },
      { text: 'テストを走らせる', mono: false, when: 't5', mark: 'fail' },
      { text: 'd.md を書いた', mono: false, when: 't6', mark: 'done' },
      { text: 'もう一度走らせる', mono: false, when: 't7', mark: 'now' },
    ]);
    const all = presentLivePane(input({ events: [prompt('x'), r1, res(r1), r2, res(r2), r3, res(r3)] }));
    expect(all.steps).toEqual([{ text: '読んだ：a.ts ほか 2 件', mono: false, when: 't1', mark: 'done' }]);
  });
  it('サブエージェントの transcript を開いている間は、指揮役の手を出さない', () => {
    seq = 0;
    const c = call('Read', { file_path: '/w/a.ts' });
    expect(presentLivePane(input({ events: [prompt('x'), c], viewingAgent: true })).steps).toEqual([]);
  });
});

describe('サブエージェントのレーン', () => {
  it('失敗、動いている、済みの順に 6 本まで並べ、あふれた済みは畳む', () => {
    const agents = [
      agent({ agentId: 'd1', state: 'done', report: '済：直した' }),
      agent({ agentId: 'r1', last: { text: 'テストを走らせる', mono: false, kind: 'run', isError: false } }),
      agent({ agentId: 'tool:t9', state: 'error', linked: false }),
      ...['d2', 'd3', 'd4', 'd5', 'd6'].map((id) => agent({ agentId: id, state: 'done' })),
    ];
    const p = presentLivePane(input({ digest: digest({ agents }) }));
    expect(p.lanes.map((l) => [l.agentId, l.tone])).toEqual([['tool:t9', 'error'], ['r1', 'running'], ['d1', 'done'], ['d2', 'done'], ['d3', 'done'], ['d4', 'done']]);
    expect(p.doneFolded).toBe(2);
    expect(p.lanes[0]).toMatchObject({ selectable: false, line: '失敗した', quoted: false });
    expect(p.lanes[1]).toMatchObject({ line: 'テストを走らせる', quoted: false, elapsed: '2 分' });
    expect(p.lanes[2]).toMatchObject({ line: '済：直した', quoted: true, elapsed: '1 分' });
  });
  it('起こしたばかりで手の無い本は「始めたところ」', () => {
    expect(presentLivePane(input({ digest: digest({ agents: [agent({})] }) })).lanes[0]!.line).toBe('始めたところ');
  });
});

describe('bandOf', () => {
  it('ターンの手の種類を並べ、失敗を優先し、最新の 40 手に切る', () => {
    seq = 0;
    const a = call('Read', { file_path: '/w/a' }); const b = call('Bash', { command: 'npx vitest' }); const g = call('Bash', { command: 'git commit -m x' });
    const events = [prompt('x'), a, res(a), b, res(b, true), g, res(g)];
    expect(bandOf(events, 0, Infinity)).toEqual(['read', 'fail', 'git']);
    const many = Array.from({ length: 45 }, () => call('Read', { file_path: '/w/x' }));
    expect(bandOf(many, 0, Infinity)).toHaveLength(40);
  });
});
```

（`durationLabel` の出力が「2 分」「1 分」の形でなければ、`format.ts` の実際の書式に合わせて期待値を直す。`durationLabel(120_000)` を先に 1 回呼んで確かめる。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/live.test.ts`
Expected: FAIL（`./live.ts` が無い）

- [ ] **Step 3: 実装する**

`packages/ui/src/presenters/live.ts`：

```ts
import { stepKind, stepLine, type LiveDigestDto, type LiveStatus, type SessionActivityDto, type StepCell, type TranscriptEvent } from '@agent-hangar/shared';
import { durationLabel } from './format.ts';

export type LampProps = { tone: 'busy' | 'wait' | 'idle'; head: string; sub: string };
export type IntentProps = { kind: 'said'; text: string; meta: string; stale: boolean } | { kind: 'none'; text: string };
export type StepRowProps = { text: string; mono: boolean; when: string; mark: 'done' | 'now' | 'fail' };
export type LaneProps = { agentId: string; title: string; tone: 'running' | 'done' | 'error'; elapsed: string; line: string; quoted: boolean; selectable: boolean };
export type LivePaneProps = { lamp: LampProps; intent: IntentProps; steps: StepRowProps[]; lanes: LaneProps[]; doneFolded: number };

export type LiveInput = {
  digest: LiveDigestDto | null;
  /** 主線のイベント（seq の昇順）。 */
  events: TranscriptEvent[];
  /** 今のターンの頭の seq。 */
  turnFrom: number;
  turnNo: number;
  live: LiveStatus | null;
  activity: SessionActivityDto | null;
  now: number;
  /** サブエージェントの transcript を開いているか。開いていれば events は主線ではない。 */
  viewingAgent: boolean;
  clock: (ts: number) => string;
  /** 休みのときに出す、最後の手からの経過。 */
  idleFor: string;
};

/** 意図の帯を薄くする手数。仕様書の試作の値で、使ってみて見直す。 */
export const STALE_STEPS = 30;
const MAX_STEPS = 4;
const MAX_LANES = 6;
const BAND_CELLS = 40;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** hangar 自身の MCP は、右ペインを書くための手なので手の一覧に出さない。 */
const OWN_MCP = /^mcp__hangar__/;

type Call = Extract<TranscriptEvent, { kind: 'tool_call' }>;
type Result = Extract<TranscriptEvent, { kind: 'tool_result' }>;
const isCall = (e: TranscriptEvent): e is Call => e.kind === 'tool_call';
const resultsOf = (events: TranscriptEvent[]) => new Map(events.filter((e): e is Result => e.kind === 'tool_result').map((r) => [r.toolId, r]));

/** ターンの手の種類の並び。失敗は種類より優先し、最新の 40 手に切る。 */
export function bandOf(events: TranscriptEvent[], from: number, to: number): StepCell[] {
  const results = resultsOf(events);
  const cells = events.filter((e): e is Call => isCall(e) && e.seq >= from && e.seq < to).map((c): StepCell => (results.get(c.toolId)?.isError ? 'fail' : stepKind(c)));
  return cells.slice(-BAND_CELLS);
}

function mainSteps(i: LiveInput): StepRowProps[] {
  if (i.viewingAgent) return [];
  const results = resultsOf(i.events);
  const calls = i.events.filter((e): e is Call => isCall(e) && e.seq >= i.turnFrom && !AGENT_TOOLS.has(e.name) && !OWN_MCP.test(e.name));
  const rows: (StepRowProps & { reads: number })[] = [];
  calls.forEach((c, n) => {
    const r = results.get(c.toolId);
    const mark: StepRowProps['mark'] = r?.isError ? 'fail' : !r && n === calls.length - 1 && i.live === 'busy' ? 'now' : 'done';
    const line = stepLine(c);
    const prev = rows[rows.length - 1];
    // 続けて読んだ手は 1 行に畳む。失敗と「いま」の手は畳まない。
    if (stepKind(c) === 'read' && mark === 'done' && prev && prev.reads > 0 && prev.mark === 'done') {
      prev.reads++;
      return;
    }
    rows.push({ ...line, when: c.ts === undefined ? '' : i.clock(c.ts), mark, reads: stepKind(c) === 'read' && mark === 'done' ? 1 : 0 });
  });
  return rows.slice(-MAX_STEPS).map(({ reads, ...row }) => (reads > 1 ? { ...row, text: `${row.text} ほか ${reads - 1} 件` } : row));
}

function lampOf(i: LiveInput, steps: number): LampProps {
  const agents = i.digest?.agents ?? [];
  const running = agents.filter((a) => a.state === 'running').length;
  const failed = agents.filter((a) => a.state === 'error').length;
  const done = agents.filter((a) => a.state === 'done').length;
  if (i.live === 'waiting' && i.activity?.question) return { tone: 'wait', head: 'あなたの答え待ち', sub: [...i.activity.question].slice(0, 40).join('') };
  if (i.live === 'waiting') return { tone: 'wait', head: '入力待ち', sub: i.activity?.summary ?? '' };
  if (running > 0) {
    const mainBusy = !i.viewingAgent && i.events.some((e) => isCall(e) && e.seq >= i.turnFrom && !AGENT_TOOLS.has(e.name) && !resultsOf(i.events).has(e.toolId));
    return { tone: 'busy', head: `${running} 本動いている`, sub: [mainBusy ? '指揮役も手を動かしている' : '', failed ? `失敗 ${failed}` : '', done ? `済 ${done}` : ''].filter(Boolean).join('、') };
  }
  if (i.live === 'busy') return { tone: 'busy', head: '作業中', sub: `ターン ${i.turnNo}・${steps} 手目` };
  return { tone: 'idle', head: '休み', sub: i.idleFor };
}

function intentOf(i: LiveInput): IntentProps {
  const it = i.digest?.intent;
  if (!it) return { kind: 'none', text: '意図は書かれていない' };
  if (!it.inThisTurn) return { kind: 'none', text: 'このターンの意図はまだ書かれていない' };
  return { kind: 'said', text: it.text, meta: `Claude いわく・${i.clock(it.at)}・その後 ${it.stepsSince} 手`, stale: it.stepsSince > STALE_STEPS };
}

const TONE_ORDER = { error: 0, running: 1, done: 2 } as const;

function lanesOf(i: LiveInput): { lanes: LaneProps[]; doneFolded: number } {
  const agents = [...(i.digest?.agents ?? [])].sort((a, b) => TONE_ORDER[a.state] - TONE_ORDER[b.state]);
  const all = agents.map((a): LaneProps => {
    const end = a.state === 'running' ? i.now : a.lastAt ?? i.now;
    const elapsed = a.startedAt === null ? '' : durationLabel(Math.max(0, end - a.startedAt));
    const quoted = a.state !== 'running' && a.report !== null;
    const line = quoted ? a.report! : a.last?.text ?? (a.state === 'error' ? '失敗した' : a.state === 'done' ? '終わった' : '始めたところ');
    return { agentId: a.agentId, title: a.title, tone: a.state, elapsed, line, quoted, selectable: a.linked };
  });
  const lanes = all.slice(0, MAX_LANES);
  return { lanes, doneFolded: all.slice(MAX_LANES).filter((l) => l.tone === 'done').length };
}

export function presentLivePane(i: LiveInput): LivePaneProps {
  const steps = i.viewingAgent ? 0 : i.events.filter((e) => isCall(e) && e.seq >= i.turnFrom).length;
  return { lamp: lampOf(i, steps), intent: intentOf(i), steps: mainSteps(i), ...lanesOf(i) };
}
```

（レーンの試験で「6 本まで、あふれた済みは畳む」を確かめている。失敗と動いている本が 6 本を超えたときは、それだけで 6 本を埋め、済みは全部「済 n」に入る。）

`packages/ui/src/presenters/session.ts`：

import に足す：

```ts
import type { StepCell } from '@agent-hangar/shared';
import { bandOf, presentLivePane, type LivePaneProps } from './live.ts';
```

`TurnRowProps` を次に替える：

```ts
export type TurnRowProps = { seq: number; when: string; text: string; head: string; tools: number; open: boolean; band: StepCell[] };
```

`SessionProps` の `turnRows: …` の行に `livePane: LivePaneProps | null;` を足す（同じ型の行の末尾、`turnJump` の後）。`base` の object に `livePane: null,` を足す。

`presentSession` の `const turnRows …` の行を次に替える：

```ts
  const turnRows: TurnRowProps[] = turnList.map((t) => ({ seq: t.seq, when: when(t.ts), text: t.text, head: t.head, tools: t.tools, open: t === openTurn, band: bandOf(events, t.from, t.to) }));
```

`const alive = aliveRunOf(store, id) !== null;` の行の後に足す：

```ts
  // 右ペインは実行中だけ。サブエージェントの transcript を開いている間は、events が主線ではない。
  const lastTurn = turnList[turnList.length - 1] ?? null;
  const livePane = alive ? presentLivePane({
    digest: store.liveDigests[id] ?? null, events, turnFrom: lastTurn?.from ?? 0, turnNo: turnList.length,
    live: s.live, activity: s.activity ?? null, now, viewingAgent: view.agentId !== null, clock: (ts) => when(ts).slice(0, 5),
    idleFor: durationLabel(now - (s.lastActivityAt ?? now)),
  }) : null;
```

返り値の `turnRows, turnsComplete: …` の行に `livePane,` を足す。

（`when` は `HH:MM:SS` を返すので、意図と手の時刻は `slice(0, 5)` で `HH:MM` にする。`when` の実際の書式を確かめ、違えば合わせる。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/presenters && npm run typecheck`
Expected: PASS（`TurnRowProps` を組み立てている既存のテストが `band` 無しで型エラーになったら、`band: []` を足す）

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/presenters/live.ts packages/ui/src/presenters/live.test.ts
git commit packages/ui/src/presenters/live.ts packages/ui/src/presenters/live.test.ts packages/ui/src/presenters/session.ts -m "feat(ui): present the live pane's lamp, intent, steps and subagent lanes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（既存のテストに `band: []` を足したときは、そのパスもコミットに足す。）

---

### Task 8: 右ペインの画面

**Files:**
- Create: `packages/ui/src/views/LivePane.tsx`
- Create: `packages/ui/src/views/LivePane.test.tsx`
- Modify: `packages/ui/src/views/TurnIndex.tsx`（行の下の色帯）
- Modify: `packages/ui/src/views/SessionScreen.tsx:153-166`（`TurnIndex` を `LivePane` で包む）
- Modify: `packages/ui/src/styles/base.css`（右ペインの規則）
- Test: `packages/ui/src/views/TurnIndex.test.tsx`

**Interfaces:**
- Consumes: Task 7 の `LivePaneProps`、`TurnRowProps.band`、`SessionProps.livePane`。既存の intent `transcript.selectAgent`。
- Produces: `LivePane({ sessionId, pane, lead, children })`

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/LivePane.test.tsx`（`TurnIndex.test.tsx` と同じく `IntentRoot` に包む。`onIntent` は intent の object をそのまま受け取る）：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { LivePaneProps } from '../presenters/live.ts';
import { LivePane } from './LivePane.tsx';

afterEach(cleanup);

const pane = (p: Partial<LivePaneProps> = {}): LivePaneProps => ({
  lamp: { tone: 'busy', head: '2 本動いている', sub: '失敗 1' },
  intent: { kind: 'said', text: '答え終えた会話だけ止める', meta: 'Claude いわく・01:40・その後 3 手', stale: false },
  steps: [{ text: 'テストを走らせる', mono: false, when: '01:41', mark: 'now' }],
  lanes: [
    { agentId: 'tool:t9', title: '壊れる担当', tone: 'error', elapsed: '1 分', line: '失敗した', quoted: false, selectable: false },
    { agentId: 'a1', title: 'クラウドを査読', tone: 'running', elapsed: '4 分', line: 'テストを走らせる', quoted: false, selectable: true },
    { agentId: 'a2', title: '文書を直す', tone: 'done', elapsed: '6 分', line: '済：README を直した', quoted: true, selectable: true },
  ],
  doneFolded: 2,
  ...p,
});
const mount = (p: LivePaneProps, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}><LivePane sessionId="s1" pane={p}><div>目次</div></LivePane></IntentRoot>); return onIntent; };

describe('LivePane', () => {
  it('灯、意図、手、レーン、目次の順に並べる', () => {
    mount(pane());
    const text = document.querySelector('.live')!.textContent!;
    const order = ['2 本動いている', '「答え終えた会話だけ止める」', 'テストを走らせる', '壊れる担当', '済 2', '目次'].map((s) => text.indexOf(s));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('自己申告だけに引用符を付ける', () => {
    mount(pane());
    expect(screen.getByText('「済：README を直した」')).toBeTruthy();
    expect(screen.queryByText('「テストを走らせる」')).toBeNull();
  });
  it('結べたレーンを押すとその本の transcript を開き、結べないレーンは押せない', () => {
    const onIntent = mount(pane());
    fireEvent.click(screen.getByText('クラウドを査読').closest('button')!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'a1' });
    expect((screen.getByText('壊れる担当').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('意図が無いときは言葉だけを出し、古い意図には印を付ける', () => {
    mount(pane({ intent: { kind: 'none', text: '意図は書かれていない' } }));
    expect(screen.getByText('意図は書かれていない')).toBeTruthy();
  });
  it('古い意図は data-stale を持つ', () => {
    mount(pane({ intent: { kind: 'said', text: 'x', meta: 'm', stale: true } }));
    expect(document.querySelector('.live-intent')!.getAttribute('data-stale')).toBe('true');
  });
});
```

`TurnIndex.test.tsx` の先頭の `rows` の 3 行が `band: []` を持っていなければ足し（Task 7 で型が `band` を求めるようになったため）、`describe('TurnIndex'` の中に足す：

```tsx
  it('行の下に手の種類の色帯を出し、手の無いターンには出さない', () => {
    const { container } = setup({ rows: [{ ...rows[0]!, band: ['read', 'fail', 'git'] }, rows[1]!] });
    const bands = [...container.querySelectorAll('.turn')].map((t) => [...t.querySelectorAll('.turn-band i')].map((i) => i.getAttribute('data-k')));
    expect(bands).toEqual([['read', 'fail', 'git'], []]);
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/LivePane.test.tsx packages/ui/src/views/TurnIndex.test.tsx`
Expected: FAIL（`./LivePane.tsx` が無い、色帯が無い）

- [ ] **Step 3: 実装する**

`packages/ui/src/views/LivePane.tsx`：

```tsx
import type { ReactNode } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { LivePaneProps } from '../presenters/live.ts';

/**
 * 実行中のセッションの右ペイン。上の段ほど横目で読む情報で、目次（children）だけがスクロールする。
 * 左のターミナルに映らないもの（何のためか、サブエージェント 1 本ずつの様子）を出す。
 */
export function LivePane({ sessionId, pane, lead, children }: { sessionId: string; pane: LivePaneProps; lead?: ReactNode; children: ReactNode }) {
  const emit = useEmit();
  return (
    <div className="live">
      <div className="live-top">
        <div className="live-head">{lead}<span className="faint">いま</span></div>
        <div className="live-lamp" data-tone={pane.lamp.tone}>
          <span className="live-dot" data-tone={pane.lamp.tone} />
          <span className="live-lamp-head">{pane.lamp.head}</span>
          {pane.lamp.sub && <span className="live-lamp-sub">{pane.lamp.sub}</span>}
        </div>
        {pane.intent.kind === 'said'
          ? <div className="live-intent" data-stale={pane.intent.stale ? 'true' : undefined}>「{pane.intent.text}」<span className="live-intent-meta">{pane.intent.meta}</span></div>
          : <div className="live-intent-none">{pane.intent.text}</div>}
        {pane.steps.length > 0 && (
          <section className="live-sec">
            <div className="live-label">指揮役の手</div>
            {pane.steps.map((s, i) => (
              <div key={i} className="live-step" data-mark={s.mark}>
                <span className="live-step-ic">{s.mark === 'fail' ? '✕' : s.mark === 'now' ? <span className="live-dot" data-tone="busy" /> : '✓'}</span>
                <span className={s.mono ? 'live-step-text mono' : 'live-step-text'}>{s.text}</span>
                <span className="live-step-when mono">{s.when}</span>
              </div>
            ))}
          </section>
        )}
        {pane.lanes.length > 0 && (
          <section className="live-sec">
            <div className="live-label">サブエージェント</div>
            {pane.lanes.map((l) => (
              <button key={l.agentId} className="live-lane" data-tone={l.tone} disabled={!l.selectable} title={l.title}
                onClick={() => emit({ type: 'transcript.selectAgent', sessionId, agentId: l.agentId })}>
                <span className="live-dot" data-tone={l.tone} />
                <span className="live-lane-title">{l.title}</span>
                <span className="live-lane-time mono">{l.elapsed}</span>
                <span className="live-lane-line">{l.quoted ? `「${l.line}」` : l.line}</span>
              </button>
            ))}
            {pane.doneFolded > 0 && <span className="live-chip">済 {pane.doneFolded}</span>}
          </section>
        )}
      </div>
      <div className="live-toc">{children}</div>
    </div>
  );
}
```

`packages/ui/src/views/TurnIndex.tsx`：行の `</button>` の直後（`{r.open && (` の前）に足す：

```tsx
            {r.band.length > 0 && <div className="turn-band" aria-hidden="true">{r.band.map((k, i) => <i key={i} data-k={k} />)}</div>}
```

`packages/ui/src/views/SessionScreen.tsx`：import に `import { LivePane } from './LivePane.tsx';` を足し、`props.transcriptOpen ? <TurnIndex … lead={paneToggle} /> : paneToggle` を次に替える：

```tsx
            {props.transcriptOpen
              ? (() => {
                const toc = <TurnIndex sessionId={id} runId={run.alive ? run.id : null} rows={props.turnRows} complete={props.turnsComplete} openItems={props.openTurnItems} turnJump={props.turnJump} hasMore={props.hasMore} loading={props.loading} remaining={Math.max(props.total - props.loaded, 0)} agentId={props.agentId} lead={props.livePane ? undefined : paneToggle} />;
                // 実行中は右ペインの上に「いま」を出し、目次は一番下に残す。終わった run では今までどおり目次だけ。
                return props.livePane ? <LivePane sessionId={id} pane={props.livePane} lead={paneToggle}>{toc}</LivePane> : toc;
              })()
              : paneToggle}
```

`packages/ui/src/styles/base.css` の「ターンの目次」の規則（`.turns { …` の行）の前に足す：

```css
/* 実行中の右ペイン。上の段は動かさず、下の目次だけがスクロールする。色は端末の縁の灯と同じ語彙（作業中は杏、入力待ちは赤、休みは灰）。 */
.live { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: calc(var(--u) * 2); }
.live-top { display: flex; flex-direction: column; gap: calc(var(--u) * 2); flex: none; }
.live-toc { display: flex; flex-direction: column; flex: 1; min-height: 0; border-top: 1px solid var(--line); padding-top: var(--u); }
.live-head { display: flex; align-items: center; gap: calc(var(--u) * 2); height: var(--row-h); font-size: var(--fs-sm); }
.live-lamp { display: flex; align-items: center; gap: calc(var(--u) * 2); padding: calc(var(--u) * 1.5) calc(var(--u) * 2.5); border-radius: var(--r); font-weight: 600; background: color-mix(in srgb, var(--busy) 12%, var(--surface)); }
.live-lamp[data-tone='wait'] { color: var(--waiting); background: color-mix(in srgb, var(--waiting) 12%, var(--surface)); }
.live-lamp[data-tone='idle'] { color: var(--ink-2); background: var(--surface-2); }
.live-lamp-sub { margin-left: auto; font-size: var(--fs-xs); font-weight: 400; color: var(--ink-2); text-align: right; }
.live-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }
.live-dot[data-tone='busy'], .live-dot[data-tone='running'] { background: var(--busy); animation: live-pulse 1.6s ease-in-out infinite; }
.live-dot[data-tone='wait'] { background: var(--waiting); }
.live-dot[data-tone='done'] { background: var(--idle); }
.live-dot[data-tone='error'] { background: var(--error); }
@keyframes live-pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .live-dot { animation: none !important; } }
.live-intent { padding: calc(var(--u) * 1.25) calc(var(--u) * 2.25); border-left: 3px solid var(--cand); border-radius: 0 var(--r) var(--r) 0; background: var(--cand-soft); font-size: var(--fs); transition: opacity var(--dur-fast) var(--ease-out); }
.live-intent[data-stale='true'] { opacity: 0.55; }
.live-intent-meta { display: block; margin-top: 2px; font-size: var(--fs-xs); color: var(--cand); }
.live-intent-none { font-size: var(--fs-sm); color: var(--ink-3); }
.live-sec { display: flex; flex-direction: column; gap: 2px; }
.live-label { font-size: var(--fs-xs); font-weight: 600; color: var(--ink-3); }
.live-step { display: flex; align-items: center; gap: calc(var(--u) * 2); font-size: var(--fs); }
.live-step[data-mark='now'] { color: var(--busy); font-weight: 560; }
.live-step[data-mark='fail'] .live-step-ic { color: var(--error); }
.live-step-ic { flex: none; width: 14px; text-align: center; font-size: var(--fs-xs); color: var(--idle); }
.live-step-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-step-when { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
.live-lane { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; align-items: center; column-gap: calc(var(--u) * 2); width: 100%; padding: calc(var(--u) * 0.75) calc(var(--u) * 1.75); border: 0; border-radius: var(--r); background: transparent; color: var(--ink); font: inherit; font-size: var(--fs); text-align: left; cursor: pointer; }
.live-lane:hover:not(:disabled) { background: var(--surface-2); }
.live-lane:disabled { cursor: default; }
.live-lane[data-tone='error'] { background: color-mix(in srgb, var(--error) 9%, var(--surface)); }
.live-lane[data-tone='done'] { background: color-mix(in srgb, var(--idle) 9%, var(--surface)); }
.live-lane-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-lane-time { font-size: var(--fs-xs); color: var(--ink-3); }
.live-lane-line { grid-column: 2 / 4; font-size: var(--fs-sm); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-lane[data-tone='error'] .live-lane-line { color: var(--error); }
.live-lane[data-tone='done'] .live-lane-line { color: var(--idle); }
.live-chip { align-self: flex-start; font-size: var(--fs-xs); border: 1px solid var(--line-strong); border-radius: var(--r-pill); padding: 0 calc(var(--u) * 2); }
.turn-band { display: flex; gap: 1px; height: 4px; margin: 0 calc(var(--u) * 2) calc(var(--u) * 1) 52px; overflow: hidden; border-radius: 2px; }
.turn-band i { flex: 0 1 8px; }
.turn-band i[data-k='read'] { background: color-mix(in srgb, var(--ink-3) 55%, var(--surface)); }
.turn-band i[data-k='write'] { background: var(--accent); }
.turn-band i[data-k='run'] { background: var(--busy); }
.turn-band i[data-k='git'] { background: var(--idle); }
.turn-band i[data-k='fail'] { background: var(--error); }
.turn-band i[data-k='other'] { background: var(--line-strong); }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS、型の誤り 0 件（トークンの見張りの試験 `tokens.test.ts` や `glass.test.ts` が落ちたら、落ちた規則の理由を読んで、トークンの使い方をそちらの決まりに合わせる）

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views/LivePane.tsx packages/ui/src/views/LivePane.test.tsx
git commit packages/ui/src/views/LivePane.tsx packages/ui/src/views/LivePane.test.tsx packages/ui/src/views/TurnIndex.tsx packages/ui/src/views/TurnIndex.test.tsx packages/ui/src/views/SessionScreen.tsx packages/ui/src/styles/base.css -m "feat(ui): show what is happening above the turn index in the running session's pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 設計書へ移し、ビルドして実物で確かめる

**Files:**
- Modify: `docs/design.md`（セッション詳細、MCP のツール、指示の注入）

- [ ] **Step 1: 設計書を直す**

`docs/design.md` の次の 3 か所を直す。

- 「指示の注入」のテンプレートの末尾に、Task 4 の 2 行を足す。
- 「ツール」の一覧の `set_session_summary` の後に足す：「`set_turn_intent({ session_id?, text })`：このターンで何のために何をするかを 1〜2 文（200 字まで）で書く。端末ローカルの `turn_intents` に積み、同期しない。右ペインの意図の段に出す。」
- 「セッション詳細」の、実行中の右欄の説明（ターンの目次）を次の要旨に替える：「実行中の右欄は、上から状態の灯、意図、指揮役の手、サブエージェント、目次を並べる。目次だけがスクロールする。目次の行の下には手の種類の色帯を出す。灯とレーンとは、サーバの `GET /api/sessions/:id/live`（今のターンの頭から読んだライブの要約）で作る。詳細は `docs/superpowers/specs/2026-10-01-live-explainer-design.md`。」

- [ ] **Step 2: 全体のテストと型を通す**

Run: `npm test && npm run typecheck`
Expected: 全件 PASS、型の誤り 0 件

- [ ] **Step 3: ビルドする**

利用者の決まり（メモリの「Always build before returning」）に従い、UI の vite と、デスクトップの bundle-server と tauri build を通す。
コマンドはルートの `package.json` と `apps/desktop/package.json` の scripts を見て、今までのビルドと同じものを使う。
利用者の `npm run dev`（4177）を止めるかは、その決まりと「Never kill by port」の両方を読んで、自分が起こした PID だけを扱う。

- [ ] **Step 4: 実物で確かめる**

1. ビルドした `.app` を開き、hangar から新しいセッションを起動する。
2. そのセッションに「サブエージェントを 2 本、バックグラウンドで走らせて、それぞれ README を読んで 1 行で報告させて」と頼む。
3. 右ペインで次を確かめる。
   - 灯が「2 本動いている」になり、済むと「済 2」に変わる。
   - 意図の帯が出る（出なければ、注入の 2 行が効いていない。`set_turn_intent` が呼ばれたかを transcript で確かめる）。
   - レーンの題名が日本語の description になる。押すとその本の transcript が開く。
   - 目次の行の下に色帯が出る。
4. 手元の Chrome（`/playwright`）で `http://127.0.0.1:4177/?t=<鍵>` を開き、右ペインを撮る（鍵はスクリプトの中で読み、画面や記録に出さない）。

- [ ] **Step 5: コミット**

```bash
git commit docs/design.md -m "docs: describe the live pane in the design document

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
