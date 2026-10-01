# 会話の保持期間の周知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code の保持期間（`cleanupPeriodDays`）で会話が消えることを hangar の中で知らせ、確認を挟んで `~/.claude/settings.json` の 1 か所だけを書き換えて延ばせるようにする。本文が消えた会話も、消えたと分かる形で見せる。

**Architecture:** サーバに `config/retention.ts` を置き、保持期間の読み取り、使用量の測定、下見と書き込み、状態の配信を受け持たせる。書き換えは文字列の上で 1 か所だけ行う（`config/jsonTextEdit.ts`）。ロックと一時ファイルの書き込みは `claudeJson.ts` から `config/claudeFileWrite.ts` へ切り出して共有する。
UI は、帯（Shell）、確認のダイアログ、一覧の印、セッション詳細の注記、設定画面の節の 5 か所に出す。状態は `store.retention` と Mediator の `retention` 領域が持ち、期限の計算は `presenters/retention.ts` の純粋な関数にまとめる。
あわせて、本文ファイルが消えても索引の行が残る不具合を索引器で直す。

**Tech Stack:** Node 22、TypeScript、Hono、better-sqlite3、React 19、vitest、@testing-library/react、lucide-react。

**Spec:** `docs/superpowers/specs/2026-10-01-retention-notice-design.md`（試作は `docs/superpowers/specs/2026-10-01-retention-notice/combined.html`）

## Global Constraints

- 作業はすべて worktree `/Users/satog/workspace/agent-hangar/.claude/worktrees/retention-notice`（ブランチ `worktree-retention-notice`）で行う。元の checkout には触らない。
- 依存を足さない。
- `~/.claude` への書き込みは `cleanupPeriodDays` の 1 か所だけとする。ほかのキーと書式（空白、改行、キーの順）には 1 バイトも触れない。
- 書く前に `~/.agent-hangar/backups/claude-config/<yyyyMMdd-HHmmss>/settings.json` へ控えを取る。控えが取れなければ書かない。
- 保持期間は 1 以上 36500 以下の整数だけを受け付ける（Claude Code は 0 を検証で弾く）。
- 選択肢は 30 日、90 日、1 年（365）、10 年（3650）とし、既定の延長先は 365 とする。
- 「まもなく削除」は期限まで 7 日以内とする。「保持期間で消えたとみられる」は、本文が無く、最後に動いてから 30 日を過ぎた会話とする（今の日数ではなく 30 日で判定する）。
- UI は常にライト。ダークモードの指定を書かない。
- `backdrop-filter` は `glass.test.ts` の一覧にある選択子の規則にだけ書き、必ず `-webkit-backdrop-filter` を併記する。
- `transition` と `animation` の長さは `--dur-fast`、`--dur`、`--dur-exit` を通して書き、数値を直書きしない（`motion.test.ts`）。
- View は `lucide-react` を直接 import せず、`views/primitives/Icon.tsx` の名前だけを使う。View は状態を持たず、API を呼ばず、Intent だけを出す。文言はすべて presenter が組み立てる。
- 文言は日本語の平叙文で、数字の前後に空白を入れる（「3 件」「1.5 GB」「1 年」）。
- コードのコメントは日本語で、周りのコードと同じ密度と口調（「〜する」「〜ためである」）にする。
- テストの実行は worktree の根で `npx vitest run <path>`。型は `npm run typecheck`。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- **`~/.claude/projects` そのものが見えない（外付けの置き場が外れた、`HANGAR_CLAUDE_DIR` の誤り）**：索引の片付けが全行を消してはならない。Task 6 に「projects が無ければ何も片付けない」試験を足す。
- **設定ファイルが CRLF の改行や BOM 付きで書かれている**：書き換えた 1 行も同じ改行を使い、BOM を保つ。Task 2 に試験を足す。
- **`cleanupPeriodDays` に文字列や小数など、Claude Code が受け付けない値が入っている**：既定の 30 日として扱い、書き込みはその値を数字で置き換える。Task 2 と Task 4 に試験を足す。
- **projects の下に読めないディレクトリやシンボリックリンクがある**：使用量の測定は、そこを飛ばして続け、投げない。Task 4 に試験を足す。
- **本文が消えた会話を開いたとき**：本文の読み出しを要求せず、404 のトーストを出さない。Task 8 に試験を足す。

---

### Task 1: 共有の型

**Files:**
- Modify: `packages/shared/src/api.ts`（`SessionDto`、`BootstrapDto` の行と、その下に新しい型）
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/intent.ts`
- Modify: 次の試験の SessionDto と BootstrapDto の作り手（`remoteOnly:` と `devices: []` で探す）
  - `packages/shared/src/api.test.ts`
  - `packages/server/src/db/queries.test.ts`
  - `packages/ui/src/Root.test.tsx`
  - `packages/ui/src/runtime/runtime.test.ts`
  - `packages/ui/src/presenters/palette.test.ts`
  - `packages/ui/src/presenters/presenters.test.ts`
  - `packages/ui/src/views/SessionScreen.test.tsx`
  - `packages/ui/src/store/store.test.ts`

**Interfaces:**
- Produces:
  - `RetentionSource`、`RetentionUsageDto`、`RetentionDto`、`RetentionPreviewLine`、`RetentionPreviewDto`、`RetentionFrom`
  - `SessionDto.transcriptMtime: number | null`
  - `BootstrapDto.retention: RetentionDto | null`
  - ServerEvent の `retention.changed`
  - Intent の `retention.*` の 4 つ

- [ ] **Step 1: 型を足す**

`packages/shared/src/api.ts` の `SessionDto` に `transcriptMtime: number | null;` を `remoteOnly: boolean;` の後ろに足す。`BootstrapDto` の末尾（`devices: DeviceDto[]` の後ろ）に `retention: RetentionDto | null` を足す。
`SettingsDto` の行の下に次を足す。

```ts
/**
 * Claude Code の会話の保持期間。
 * source は値がどこで決まったかで、default はユーザー設定にキーが無い（既定の 30 日）ことを表す。
 * usage は測り終えるまで null である。
 */
export type RetentionSource = 'default' | 'user' | 'managed';
export type RetentionUsageDto = { bytes: number; dailyBytes: number; freeBytes: number; measuredAt: number };
export type RetentionDto = { days: number; source: RetentionSource; userValue: number | null; writable: boolean; unwritableReason: string | null; usage: RetentionUsageDto | null };
export type RetentionPreviewLine = { kind: 'ctx' | 'add' | 'del'; text: string };
/** 書いたらどうなるか。何も書かずに返す。baseSha256 は読んだ時点のファイルの指紋で、無ければ空文字。 */
export type RetentionPreviewDto = { days: number; path: string; lines: RetentionPreviewLine[]; baseSha256: string; backupDir: string; projectedBytes: number | null };
/** 確認をどこから開いたか。帯から開いたときだけ「ほかの期間…」を出す。 */
export type RetentionFrom = 'banner' | 'session' | 'settings';
```

`packages/shared/src/events.ts` の import に `RetentionDto` を足し、`ServerEvent` の `toast` の前に `| { type: 'retention.changed'; retention: RetentionDto }` を足す。

`packages/shared/src/intent.ts` の `settings.update` の行の前に次を足す（`RetentionFrom` を import する）。

```ts
  | { type: 'retention.dismiss' }
  | { type: 'retention.edit'; days: number; from: RetentionFrom }
  | { type: 'retention.write' }
  | { type: 'retention.settings' }
```

- [ ] **Step 2: 型を確かめて、落ちる箇所を直す**

Run: `npm run typecheck`
Expected: 上の Files の試験で、`transcriptMtime` と `retention` が足りないというエラーが出る。
各試験の SessionDto の作り手に `transcriptMtime: null` を、BootstrapDto の作り手に `retention: null` を足す。`packages/server/src/db/queries.ts` の `toSessionDto` は Task 6 で埋めるので、ここでは `transcriptMtime: null,` を `remoteOnly` の行の後ろに仮に足す。`packages/server/src/http/app.ts` の bootstrap は Task 7 で埋めるので、ここでは `retention: null,` を足す。

Run: `npm run typecheck && npx vitest run packages/shared`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A packages
git commit -m "feat(shared): add the retention contract and a transcript mtime on sessions"
```

---

### Task 2: 設定ファイルの 1 か所だけを書き換える

**Files:**
- Create: `packages/server/src/config/jsonTextEdit.ts`
- Test: `packages/server/src/config/jsonTextEdit.test.ts`

**Interfaces:**
- Produces:
  - `setTopLevelNumber(text: string, key: string, value: number): string`（書式を読み取れなければ `JsonTextEditError` を投げる）
  - `diffLines(before: string, after: string): RetentionPreviewLine[]`
  - `class JsonTextEditError extends Error`

- [ ] **Step 1: 落ちる試験を書く**

```ts
import { describe, expect, it } from 'vitest';
import { diffLines, JsonTextEditError, setTopLevelNumber } from './jsonTextEdit.ts';

const K = 'cleanupPeriodDays';

describe('setTopLevelNumber', () => {
  it('空とファイルが無いときは、キー 1 つのオブジェクトを書く', () => {
    expect(setTopLevelNumber('', K, 365)).toBe('{\n  "cleanupPeriodDays": 365\n}\n');
    expect(setTopLevelNumber('{}', K, 365)).toBe('{\n  "cleanupPeriodDays": 365\n}\n');
    expect(setTopLevelNumber('  {\n}\n', K, 365)).toBe('{\n  "cleanupPeriodDays": 365\n}\n');
  });
  it('キーがあれば、値の数字だけを置き換える', () => {
    const src = '{\n  "a" : 1,\n  "cleanupPeriodDays" : 3650,\n  "z" : true\n}\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('{\n  "a" : 1,\n  "cleanupPeriodDays" : 365,\n  "z" : true\n}\n');
  });
  it('キーが無ければ、最初のメンバーの前に同じ字下げと区切りで 1 行を差し込む', () => {
    expect(setTopLevelNumber('{\n  "a" : 1\n}\n', K, 365)).toBe('{\n  "cleanupPeriodDays" : 365,\n  "a" : 1\n}\n');
    expect(setTopLevelNumber('{\n    "a": 1\n}', K, 90)).toBe('{\n    "cleanupPeriodDays": 90,\n    "a": 1\n}');
    expect(setTopLevelNumber('{"a":1}', K, 90)).toBe('{"cleanupPeriodDays":90,"a":1}');
  });
  it('入れ子の同じ名前のキーには触れない', () => {
    const src = '{\n  "x": { "cleanupPeriodDays": 5 }\n}\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('{\n  "cleanupPeriodDays": 365,\n  "x": { "cleanupPeriodDays": 5 }\n}\n');
  });
  it('文字列の中の括弧や引用符に惑わされない', () => {
    const src = '{\n  "note": "a { \\"cleanupPeriodDays\\": 1 }",\n  "cleanupPeriodDays": 30\n}\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('{\n  "note": "a { \\"cleanupPeriodDays\\": 1 }",\n  "cleanupPeriodDays": 365\n}\n');
  });
  it('CRLF の改行と BOM を保つ', () => {
    const src = '﻿{\r\n  "a": 1\r\n}\r\n';
    expect(setTopLevelNumber(src, K, 365)).toBe('﻿{\r\n  "cleanupPeriodDays": 365,\r\n  "a": 1\r\n}\r\n');
  });
  it('Claude Code が受け付けない値（文字列、小数）も、数字で置き換える', () => {
    expect(setTopLevelNumber('{ "cleanupPeriodDays": "30" }', K, 365)).toBe('{ "cleanupPeriodDays": 365 }');
    expect(setTopLevelNumber('{ "cleanupPeriodDays": 7.5 }', K, 365)).toBe('{ "cleanupPeriodDays": 365 }');
  });
  it('値がオブジェクトや配列のとき、JSON が壊れているとき、最上位が配列のときは書かない', () => {
    expect(() => setTopLevelNumber('{ "cleanupPeriodDays": {} }', K, 365)).toThrow(JsonTextEditError);
    expect(() => setTopLevelNumber('{ "a": ', K, 365)).toThrow(JsonTextEditError);
    expect(() => setTopLevelNumber('[1]', K, 365)).toThrow(JsonTextEditError);
  });
  it('同じキーが最上位に 2 度あるときは、読み違いを避けて書かない', () => {
    expect(() => setTopLevelNumber('{ "cleanupPeriodDays": 1, "cleanupPeriodDays": 2 }', K, 365)).toThrow(JsonTextEditError);
  });
});

describe('diffLines', () => {
  it('変わった行と前後 1 行ずつを返す', () => {
    const before = '{\n  "a": 1,\n  "cleanupPeriodDays": 30,\n  "b": 2\n}\n';
    const after = '{\n  "a": 1,\n  "cleanupPeriodDays": 365,\n  "b": 2\n}\n';
    expect(diffLines(before, after)).toEqual([
      { kind: 'ctx', text: '  "a": 1,' },
      { kind: 'del', text: '  "cleanupPeriodDays": 30,' },
      { kind: 'add', text: '  "cleanupPeriodDays": 365,' },
      { kind: 'ctx', text: '  "b": 2' },
    ]);
  });
  it('足しただけなら add だけになる。新しく作るときは全行が add', () => {
    expect(diffLines('{\n  "a": 1\n}\n', '{\n  "cleanupPeriodDays": 365,\n  "a": 1\n}\n')).toEqual([
      { kind: 'ctx', text: '{' },
      { kind: 'add', text: '  "cleanupPeriodDays": 365,' },
      { kind: 'ctx', text: '  "a": 1' },
    ]);
    expect(diffLines('', '{\n  "cleanupPeriodDays": 365\n}\n')).toEqual([
      { kind: 'add', text: '{' }, { kind: 'add', text: '  "cleanupPeriodDays": 365' }, { kind: 'add', text: '}' },
    ]);
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/jsonTextEdit.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

```ts
import { isDeepStrictEqual } from 'node:util';
import type { RetentionPreviewLine } from '@agent-hangar/shared';

/**
 * JSON の文字列を、最上位の 1 つのキーの値だけ書き換える。
 *
 * Claude Code の settings.json は `"key" : value` のように、JSON.stringify と違う書式で書かれていることがある。
 * 書き直すと全行が変わり、利用者は差分を読めず、設定の同期も全体を送り直す。
 * そこで文字列の上で値の範囲だけを差し替え、ほかの空白、改行、キーの順には触れない。
 * 書き換えた後に JSON として読み直し、狙ったキー以外が変わっていないことを確かめる。
 */
export class JsonTextEditError extends Error {
  constructor() { super('設定ファイルの書式を読み取れなかったので書き換えませんでした'); this.name = 'JsonTextEditError'; }
}

type Member = { keyStart: number; key: string; valueStart: number; valueEnd: number; scalar: boolean; sep: string };

const WS = new Set([' ', '\t', '\n', '\r']);

/** 最上位のオブジェクトのメンバーを、位置つきで拾う。形が読めなければ投げる。 */
function scanTopLevel(text: string, from: number): { open: number; close: number; members: Member[] } {
  let i = from;
  const skipWs = () => { while (i < text.length && WS.has(text[i]!)) i++; };
  const readString = (): string => {
    if (text[i] !== '"') throw new JsonTextEditError();
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new JsonTextEditError();
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  // 値を 1 つ飛ばす。入れ子は深さを数えるだけで、中身は見ない（文字列だけは括弧を数えないように読む）。
  const skipValue = (): boolean => {
    const c = text[i];
    if (c === '"') { readString(); return true; }
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < text.length) {
        const d = text[i]!;
        if (d === '"') { readString(); continue; }
        if (d === '{' || d === '[') depth++;
        else if (d === '}' || d === ']') { depth--; if (depth === 0) { i++; return false; } }
        i++;
      }
      throw new JsonTextEditError();
    }
    const start = i;
    while (i < text.length && !WS.has(text[i]!) && text[i] !== ',' && text[i] !== '}') i++;
    if (i === start) throw new JsonTextEditError();
    return true;
  };
  skipWs();
  if (text[i] !== '{') throw new JsonTextEditError();
  const open = i;
  i++;
  const members: Member[] = [];
  skipWs();
  if (text[i] === '}') return { open, close: i, members };
  for (;;) {
    skipWs();
    const keyStart = i;
    const key = readString();
    const sepStart = i;
    skipWs();
    if (text[i] !== ':') throw new JsonTextEditError();
    i++;
    skipWs();
    const sep = text.slice(sepStart, i);
    const valueStart = i;
    const scalar = skipValue();
    members.push({ keyStart, key, valueStart, valueEnd: i, scalar, sep });
    skipWs();
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '}') return { open, close: i, members };
    throw new JsonTextEditError();
  }
}

export function setTopLevelNumber(text: string, key: string, value: number): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const fresh = `${bom}{${eol}  ${JSON.stringify(key)}: ${value}${eol}}${eol}`;
  if (body.trim() === '') return fresh;
  let before: unknown;
  try { before = JSON.parse(body); } catch { throw new JsonTextEditError(); }
  if (!before || typeof before !== 'object' || Array.isArray(before)) throw new JsonTextEditError();
  const { open, members } = scanTopLevel(body, 0);
  if (members.length === 0) return fresh;
  const hits = members.filter((m) => m.key === key);
  if (hits.length > 1) throw new JsonTextEditError();
  let out: string;
  if (hits.length === 1) {
    const m = hits[0]!;
    if (!m.scalar) throw new JsonTextEditError();
    out = body.slice(0, m.valueStart) + String(value) + body.slice(m.valueEnd);
  } else {
    const first = members[0]!;
    // 最初のメンバーの前にある空白（改行と字下げ）を、そのまま新しい行の後ろにも置く。
    const lead = body.slice(open + 1, first.keyStart);
    out = body.slice(0, first.keyStart) + `${JSON.stringify(key)}${first.sep}${value},` + lead + body.slice(first.keyStart);
  }
  let after: unknown;
  try { after = JSON.parse(out); } catch { throw new JsonTextEditError(); }
  if (!isDeepStrictEqual(after, { ...(before as Record<string, unknown>), [key]: value })) throw new JsonTextEditError();
  return bom + out;
}

/** 変わった行と、その前後 1 行ずつ。設定ファイルは小さいので、頭と尻から一致を削るだけで足りる。 */
export function diffLines(before: string, after: string): RetentionPreviewLine[] {
  const split = (s: string) => (s === '' ? [] : s.replace(/^﻿/, '').replace(/\r?\n$/, '').split(/\r?\n/));
  const a = split(before);
  const b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: RetentionPreviewLine[] = [];
  if (head > 0) out.push({ kind: 'ctx', text: a[head - 1]! });
  for (const t of a.slice(head, a.length - tail)) out.push({ kind: 'del', text: t });
  for (const t of b.slice(head, b.length - tail)) out.push({ kind: 'add', text: t });
  if (tail > 0) out.push({ kind: 'ctx', text: a[a.length - tail]! });
  return out;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config/jsonTextEdit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config/jsonTextEdit.ts packages/server/src/config/jsonTextEdit.test.ts
git commit -m "feat(server): rewrite one top-level key of a JSON file without touching its formatting"
```

---

### Task 3: ロックと一時ファイルの書き込みを切り出す

**Files:**
- Create: `packages/server/src/config/claudeFileWrite.ts`
- Modify: `packages/server/src/config/claudeJson.ts`（`resolveRealFile`、`sleepSync`、`acquireLock`、`writeJsonObject` の中身）
- Test: `packages/server/src/config/claudeFileWrite.test.ts`
- Test（そのまま通ること）: `packages/server/src/config/claudeJson.test.ts`

**Interfaces:**
- Produces:
  - `resolveRealFile(file: string): string`（`claudeJson.ts` からも同じ名前で re-export する）
  - `acquireFileLock(realFile: string, waitMs: number, staleMs: number): () => void`
  - `writeFileAtomically(realFile: string, content: string, mode: number): void`
  - `LOCK_BUSY_MESSAGE: string`

- [ ] **Step 1: 落ちる試験を書く**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireFileLock, LOCK_BUSY_MESSAGE, resolveRealFile, writeFileAtomically } from './claudeFileWrite.ts';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cfw-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('claudeFileWrite', () => {
  it('リンクを実体まで解く', () => {
    const real = path.join(root, 'real.json');
    fs.writeFileSync(real, '{}');
    const link = path.join(root, 'link.json');
    fs.symlinkSync(real, link);
    expect(resolveRealFile(link)).toBe(fs.realpathSync(real));
  });
  it('一時ファイルから rename し、渡した権限で置く。一時ファイルは残さない', () => {
    const f = path.join(root, 's.json');
    writeFileAtomically(f, '{"a":1}\n', 0o640);
    expect(fs.readFileSync(f, 'utf8')).toBe('{"a":1}\n');
    expect(fs.statSync(f).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(root)).toEqual(['s.json']);
  });
  it('ロックは同時に 1 つだけ取れ、放すとまた取れる', () => {
    const f = path.join(root, 's.json');
    const release = acquireFileLock(f, 50, 10_000);
    expect(() => acquireFileLock(f, 50, 10_000)).toThrow(LOCK_BUSY_MESSAGE);
    release();
    acquireFileLock(f, 50, 10_000)();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/claudeFileWrite.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 切り出す**

`claudeJson.ts` の `resolveRealFile`、`sleepSync`、`acquireLock` と、定数の `BUSY`、`LOCK_SUFFIX`、`TMP_SUFFIX` を、中身を変えずに `claudeFileWrite.ts` へ移す。そのとき `acquireLock` は `acquireFileLock`、`BUSY` は `LOCK_BUSY_MESSAGE` に改名し、どちらも export する。
ファイルの頭には次のコメントを置く。「Claude Code の設定ファイルを書き換えるときの共通の作法。ロックを取り、リンクは実体まで解き、同じディレクトリの一時ファイルから rename する。`~/.claude.json`（claudeJson.ts）と `settings.json` の保持期間（retention.ts）が使う。」
`writeJsonObject` の書き込み部分は、次の関数として切り出す。

```ts
/** 実体と同じディレクトリに書いてから rename する。途中で落ちても元のファイルが壊れない。 */
export function writeFileAtomically(realFile: string, content: string, mode: number): void {
  const tmp = `${realFile}${TMP_SUFFIX}`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, realFile);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 一時ファイルが作られる前に落ちた。
    }
    throw e;
  }
}
```

`claudeJson.ts` の `writeJsonObject` は、権限を決める部分（`tightened` と `mode`）を残し、書き込みを `writeFileAtomically(realFile, \`${JSON.stringify(value, null, 2)}\n\`, mode)` に置き換える。
`claudeJson.ts` の先頭に `import { acquireFileLock, resolveRealFile, writeFileAtomically } from './claudeFileWrite.ts';` と `export { resolveRealFile } from './claudeFileWrite.ts';` を足し、`upsertUserMcpServer` の `acquireLock` を `acquireFileLock` に替える。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config`
Expected: PASS（`claudeJson.test.ts` も変えずに通る）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config
git commit -m "refactor(server): share the lock and atomic write used for Claude Code's settings files"
```

---

### Task 4: 保持期間を読み、使用量を測る

**Files:**
- Create: `packages/server/src/config/retention.ts`
- Test: `packages/server/src/config/retention.test.ts`

**Interfaces:**
- Consumes: `RetentionDto`、`RetentionUsageDto`（Task 1）
- Produces:
  - `DEFAULT_RETENTION_DAYS = 30`
  - `type RetentionState = Omit<RetentionDto, 'usage'>`
  - `readRetention(o: { claudeDir: string; managedDir: string | null }): RetentionState`
  - `defaultManagedDir(): string | null`
  - `measureUsage(o: { claudeDir: string; now: number }): Promise<RetentionUsageDto>`

- [ ] **Step 1: 落ちる試験を書く**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureUsage, readRetention } from './retention.ts';

let root: string;
let claudeDir: string;
let managedDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ret-'));
  claudeDir = path.join(root, '.claude');
  managedDir = path.join(root, 'managed');
  fs.mkdirSync(claudeDir);
});
afterEach(() => {
  try { fs.chmodSync(path.join(claudeDir, 'projects', 'locked'), 0o700); } catch { /* 無ければよい */ }
  fs.rmSync(root, { recursive: true, force: true });
});
const settings = (s: string) => fs.writeFileSync(path.join(claudeDir, 'settings.json'), s);

describe('readRetention', () => {
  it('ファイルもキーも無ければ既定の 30 日で、書ける', () => {
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null });
    settings('{ "a": 1 }');
    expect(readRetention({ claudeDir, managedDir }).source).toBe('default');
  });
  it('1 以上の整数ならユーザーの値として読む', () => {
    settings('{ "cleanupPeriodDays" : 3650 }');
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 3650, source: 'user', userValue: 3650, writable: true, unwritableReason: null });
  });
  it('Claude Code が受け付けない値は、既定として扱う', () => {
    for (const v of ['0', '-1', '7.5', '"30"', 'null']) {
      settings(`{ "cleanupPeriodDays": ${v} }`);
      expect(readRetention({ claudeDir, managedDir })).toMatchObject({ days: 30, source: 'default', userValue: null, writable: true });
    }
  });
  it('JSON として読めなければ、書けない', () => {
    settings('{ "a": ');
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 30, source: 'default', userValue: null, writable: false, unwritableReason: '設定ファイルを読み取れないので書き換えません' });
  });
  it('組織の設定があればそれが効き、書けない。drop-in は名前の順で後が勝つ', () => {
    settings('{ "cleanupPeriodDays": 365 }');
    fs.mkdirSync(path.join(managedDir, 'managed-settings.d'), { recursive: true });
    fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), '{ "cleanupPeriodDays": 14 }');
    expect(readRetention({ claudeDir, managedDir })).toEqual({ days: 14, source: 'managed', userValue: 365, writable: false, unwritableReason: '組織の設定で決まっています' });
    fs.writeFileSync(path.join(managedDir, 'managed-settings.d', '20-b.json'), '{ "cleanupPeriodDays": 60 }');
    fs.writeFileSync(path.join(managedDir, 'managed-settings.d', '10-a.json'), '{ "cleanupPeriodDays": 7 }');
    expect(readRetention({ claudeDir, managedDir }).days).toBe(60);
  });
});

describe('measureUsage', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-10-01T00:00:00Z');
  const put = (rel: string, bytes: number, ageDays: number) => {
    const p = path.join(claudeDir, 'projects', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes));
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(p, t, t);
  };
  it('合計と、直近 30 日のぶんを 30 で割った増え方を返す', async () => {
    put('p/a.jsonl', 3000, 1);
    put('p/a/tool-results/x.txt', 3000, 10);
    put('p/old.jsonl', 9000, 40);
    const u = await measureUsage({ claudeDir, now: NOW });
    expect(u.bytes).toBe(15_000);
    expect(u.dailyBytes).toBe(200);
    expect(u.freeBytes).toBeGreaterThan(0);
    expect(u.measuredAt).toBe(NOW);
  });
  it('シンボリックリンクはたどらず、読めないディレクトリは飛ばす', async () => {
    put('p/a.jsonl', 1000, 1);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'big'), Buffer.alloc(50_000));
    fs.symlinkSync(outside, path.join(claudeDir, 'projects', 'link'));
    fs.mkdirSync(path.join(claudeDir, 'projects', 'locked'));
    fs.writeFileSync(path.join(claudeDir, 'projects', 'locked', 'x'), Buffer.alloc(10));
    fs.chmodSync(path.join(claudeDir, 'projects', 'locked'), 0o000);
    expect((await measureUsage({ claudeDir, now: NOW })).bytes).toBe(1000);
  });
  it('projects が無ければ 0', async () => {
    expect((await measureUsage({ claudeDir, now: NOW })).bytes).toBe(0);
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/retention.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { RetentionDto, RetentionUsageDto } from '@agent-hangar/shared';

/**
 * Claude Code の会話の保持期間（cleanupPeriodDays）。
 * Claude Code は期間を過ぎた本文を、セッションを始めたあとの掃除で黙って消す（settings-reference）。
 * hangar はユーザー設定と組織の設定だけを読む。プロジェクトの設定と --settings は見ない（spec の範囲の外）。
 */
export const DEFAULT_RETENTION_DAYS = 30;
export const RETENTION_KEY = 'cleanupPeriodDays';
export type RetentionState = Omit<RetentionDto, 'usage'>;

const UNREADABLE = '設定ファイルを読み取れないので書き換えません';
const MANAGED = '組織の設定で決まっています';
const DAY = 86_400_000;
/** 増え方を見積もる窓。既定の保持期間と同じ長さにする。 */
const RATE_WINDOW_DAYS = 30;

/** Claude Code が受け付ける値か。1 以上の整数だけである（0 は検証で弾かれる）。 */
const validDays = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** 組織の設定の置き場。macOS と Linux のファイルだけを読む。MDM とコンソールから配る設定は読まない。 */
export function defaultManagedDir(): string | null {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (process.platform === 'linux') return '/etc/claude-code';
  return null;
}

/** JSON のオブジェクトとして読む。無ければ null、壊れていれば 'broken'。 */
function readObject(file: string): Record<string, unknown> | null | 'broken' {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'broken'; }
  try {
    const v = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : 'broken';
  } catch {
    return 'broken';
  }
}

/** 組織の設定の値。managed-settings.json の後に managed-settings.d を名前の順に読み、後の値が勝つ。 */
function managedDays(dir: string | null): number | null {
  if (!dir) return null;
  const files = [path.join(dir, 'managed-settings.json')];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'managed-settings.d')).filter((n) => n.endsWith('.json')).sort()) files.push(path.join(dir, 'managed-settings.d', f));
  } catch {
    // drop-in の置き場が無いのは普通である。
  }
  let days: number | null = null;
  for (const f of files) {
    const o = readObject(f);
    if (o && o !== 'broken' && validDays(o[RETENTION_KEY])) days = o[RETENTION_KEY];
  }
  return days;
}

export function readRetention(o: { claudeDir: string; managedDir: string | null }): RetentionState {
  const user = readObject(path.join(o.claudeDir, 'settings.json'));
  const userValue = user && user !== 'broken' && validDays(user[RETENTION_KEY]) ? user[RETENTION_KEY] : null;
  const managed = managedDays(o.managedDir);
  if (managed !== null) return { days: managed, source: 'managed', userValue, writable: false, unwritableReason: MANAGED };
  if (user === 'broken') return { days: DEFAULT_RETENTION_DAYS, source: 'default', userValue: null, writable: false, unwritableReason: UNREADABLE };
  if (userValue !== null) return { days: userValue, source: 'user', userValue, writable: true, unwritableReason: null };
  return { days: DEFAULT_RETENTION_DAYS, source: 'default', userValue: null, writable: true, unwritableReason: null };
}

/**
 * <claudeDir>/projects の使用量。lstat でたどり、シンボリックリンクはたどらない。
 * 読めない段は飛ばす。重い走査なので、呼ぶのは起動の後と 1 時間ごとだけにする（RetentionService）。
 */
export async function measureUsage(o: { claudeDir: string; now: number }): Promise<RetentionUsageDto> {
  const since = o.now - RATE_WINDOW_DAYS * DAY;
  let bytes = 0;
  let recent = 0;
  const stack = [path.join(o.claudeDir, 'projects')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try {
        const st = await fs.promises.lstat(p);
        bytes += st.size;
        if (st.mtimeMs >= since) recent += st.size;
      } catch {
        // 数えている間に消えた。
      }
    }
  }
  let freeBytes = 0;
  try {
    const s = fs.statfsSync(fs.existsSync(o.claudeDir) ? o.claudeDir : path.dirname(o.claudeDir));
    freeBytes = s.bavail * s.bsize;
  } catch {
    // 空きを測れない置き場。0 として出し、画面は空きの欄を「分かりません」にする。
  }
  return { bytes, dailyBytes: Math.round(recent / RATE_WINDOW_DAYS), freeBytes, measuredAt: o.now };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config/retention.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config/retention.ts packages/server/src/config/retention.test.ts
git commit -m "feat(server): read Claude Code's transcript retention and measure what it keeps"
```

---

### Task 5: 下見と書き込み

**Files:**
- Modify: `packages/server/src/config/retention.ts`
- Test: `packages/server/src/config/retention.test.ts`

**Interfaces:**
- Consumes:
  - `setTopLevelNumber`、`diffLines`、`JsonTextEditError`（Task 2）
  - `resolveRealFile`、`acquireFileLock`、`writeFileAtomically`（Task 3）
  - `backupsRoot(home)`（`config/cloud.ts`）
  - `timestampLabel(ts)`（`sync/copy.ts`）
- Produces:
  - `previewRetention(o: { claudeDir: string; home: string; days: number; dailyBytes: number | null }): RetentionPreviewDto`
  - `writeRetention(o: WriteRetentionOptions): { file: string; backup: string | null }`
  - `class RetentionConflictError extends Error`
  - `type WriteRetentionOptions = { claudeDir: string; home: string; days: number; baseSha256: string; now?: Date; lockWaitMs?: number; staleLockMs?: number; onBeforeWrite?: () => void }`

`home` は hangar の置き場（`~/.agent-hangar`、`server.ts` の `home`）である。控えは `backupsRoot(home)/claude-config/<時刻>/settings.json` に置き、設定の同期と同じ置き場を使う。

- [ ] **Step 1: 落ちる試験を足す**

`retention.test.ts` の末尾に足す（import に `previewRetention`、`writeRetention`、`RetentionConflictError` を足し、`import crypto from 'node:crypto';` を足す）。

```ts
describe('previewRetention と writeRetention', () => {
  const home = () => path.join(root, 'hangar');
  const file = () => path.join(claudeDir, 'settings.json');
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const SRC = '{\n  "a" : 1,\n  "cleanupPeriodDays" : 3650\n}\n';

  it('下見は何も書かず、変わる行と指紋と見込みを返す', () => {
    settings(SRC);
    const p = previewRetention({ claudeDir, home: home(), days: 365, dailyBytes: 1000 });
    expect(p.lines).toEqual([{ kind: 'ctx', text: '  "a" : 1,' }, { kind: 'del', text: '  "cleanupPeriodDays" : 3650' }, { kind: 'add', text: '  "cleanupPeriodDays" : 365' }, { kind: 'ctx', text: '}' }]);
    expect(p.baseSha256).toBe(sha(SRC));
    expect(p.projectedBytes).toBe(365_000);
    expect(p.path).toBe(fs.realpathSync(file()));
    expect(p.backupDir).toBe(path.join(home(), 'backups', 'claude-config'));
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC);
  });
  it('ファイルが無ければ、指紋は空で、全行が add になる', () => {
    const p = previewRetention({ claudeDir, home: home(), days: 365, dailyBytes: null });
    expect(p.baseSha256).toBe('');
    expect(p.lines.every((l) => l.kind === 'add')).toBe(true);
    expect(p.projectedBytes).toBeNull();
  });
  it('書くと 1 行だけ変わり、控えを取り、権限を保つ', () => {
    settings(SRC);
    fs.chmodSync(file(), 0o644);
    const r = writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC), now: new Date(2026, 9, 1, 12, 0, 0) });
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC.replace('3650', '365'));
    expect(fs.statSync(file()).mode & 0o777).toBe(0o644);
    expect(r.backup).toBe(path.join(home(), 'backups', 'claude-config', '20261001-120000', 'settings.json'));
    expect(fs.readFileSync(r.backup!, 'utf8')).toBe(SRC);
    expect(fs.statSync(r.backup!).mode & 0o777).toBe(0o600);
  });
  it('同じ秒に 2 度書いても、先の控えを潰さない', () => {
    settings(SRC);
    const now = new Date(2026, 9, 1, 12, 0, 0);
    writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC), now });
    const next = fs.readFileSync(file(), 'utf8');
    const r = writeRetention({ claudeDir, home: home(), days: 90, baseSha256: sha(next), now });
    expect(r.backup!.endsWith('settings.json-2')).toBe(true);
  });
  it('ファイルが無ければ 0600 で作り、控えは取らない', () => {
    const r = writeRetention({ claudeDir, home: home(), days: 365, baseSha256: '' });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ cleanupPeriodDays: 365 });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(r.backup).toBeNull();
  });
  it('下見の後に変わっていたら、書かずに RetentionConflictError', () => {
    settings(SRC);
    expect(() => writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha('{}') })).toThrow(RetentionConflictError);
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC);
  });
  it('控えを取った後、書く直前に割り込まれても書かない', () => {
    settings(SRC);
    expect(() => writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC), onBeforeWrite: () => settings('{ "b": 2 }') })).toThrow(RetentionConflictError);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ "b": 2 }');
  });
  it('控えが取れなければ書かない', () => {
    settings(SRC);
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(path.join(home(), 'backups'), 'ディレクトリの代わりのファイル');
    expect(() => writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC) })).toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe(SRC);
  });
  it('リンクなら実体に書き、リンクを保つ', () => {
    const real = path.join(root, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, SRC);
    fs.symlinkSync(real, file());
    writeRetention({ claudeDir, home: home(), days: 365, baseSha256: sha(SRC) });
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(SRC.replace('3650', '365'));
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/retention.test.ts`
Expected: FAIL（`previewRetention` が無い）

- [ ] **Step 3: 実装する**

`retention.ts` に次を足す（import に `crypto`、`backupsRoot`、`timestampLabel`、`acquireFileLock`、`resolveRealFile`、`writeFileAtomically`、`diffLines`、`setTopLevelNumber`、`RetentionPreviewDto` を足す）。

```ts
/** 下見の後に、ほかの PC からの同期や手の編集でファイルが変わった。UI は下見を取り直す。 */
export class RetentionConflictError extends Error {
  constructor() { super('設定ファイルがほかで変わったので、読み直しました'); this.name = 'RetentionConflictError'; }
}

export type WriteRetentionOptions = { claudeDir: string; home: string; days: number; baseSha256: string; now?: Date; lockWaitMs?: number; staleLockMs?: number; onBeforeWrite?: () => void };

const BACKUP_SUBDIR = 'claude-config';
const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const settingsFile = (claudeDir: string): string => resolveRealFile(path.join(claudeDir, 'settings.json'));
/** 今の中身。無ければ null。 */
function readBytes(file: string): Buffer | null {
  try { return fs.readFileSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

export function previewRetention(o: { claudeDir: string; home: string; days: number; dailyBytes: number | null }): RetentionPreviewDto {
  const file = settingsFile(o.claudeDir);
  const bytes = readBytes(file);
  const before = bytes?.toString('utf8') ?? '';
  const after = setTopLevelNumber(before, RETENTION_KEY, o.days);
  return {
    days: o.days, path: file, lines: diffLines(before, after), baseSha256: bytes ? sha256(bytes) : '',
    backupDir: path.join(backupsRoot(o.home), BACKUP_SUBDIR),
    projectedBytes: o.dailyBytes === null ? null : Math.round(o.dailyBytes * o.days),
  };
}

/**
 * 控えを取る。同じ秒の控えがあれば -2、-3 と連番を足し、先の控えを潰さない。
 * 取れなければ投げる。呼び手はそのまま書くのをやめる。
 */
function backupSettings(file: string, home: string, now: Date): string {
  const dir = path.join(backupsRoot(home), BACKUP_SUBDIR, timestampLabel(now.getTime()));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.join(dir, 'settings.json');
  for (let i = 1; i <= 50; i++) {
    const dest = i === 1 ? base : `${base}-${i}`;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    fs.chmodSync(dest, 0o600);
    return dest;
  }
  throw new Error('控えを置く名前が空いていません');
}

/**
 * cleanupPeriodDays の 1 か所だけを書き換える。claudeJson.ts と同じ作法に従う。
 * ロックを取ってから読み、下見の指紋と比べ、控えを取り、書く直前にもう一度読んで比べてから rename する。
 */
export function writeRetention(o: WriteRetentionOptions): { file: string; backup: string | null } {
  const file = settingsFile(o.claudeDir);
  const release = acquireFileLock(file, o.lockWaitMs ?? 2000, o.staleLockMs ?? 10_000);
  try {
    const bytes = readBytes(file);
    const cur = bytes ? sha256(bytes) : '';
    if (cur !== o.baseSha256) throw new RetentionConflictError();
    const after = setTopLevelNumber(bytes?.toString('utf8') ?? '', RETENTION_KEY, o.days);
    const backup = bytes ? backupSettings(file, o.home, o.now ?? new Date()) : null;
    o.onBeforeWrite?.();
    // Claude Code は hangar のロックを知らないので、書く直前にもう一度読んで割り込みを見つける。
    const again = readBytes(file);
    if ((again ? sha256(again) : '') !== cur) throw new RetentionConflictError();
    const mode = bytes ? fs.statSync(file).mode & 0o777 : 0o600;
    writeFileAtomically(file, after, mode);
    return { file, backup };
  } finally {
    release();
  }
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/config/retention.ts packages/server/src/config/retention.test.ts
git commit -m "feat(server): preview and write the retention period with a backup and a conflict check"
```

---

### Task 6: 消えた本文の索引を片付け、本文の更新時刻を配る

**Files:**
- Modify: `packages/server/src/indexer/service.ts`（`IndexerListener`、`targets()`）
- Modify: `packages/server/src/db/queries.ts`（`SESSION_SELECT`、行の型、`toSessionDto`）
- Modify: `packages/server/src/http/app.ts:366`（404 の文言）
- Modify: `packages/server/src/server.ts`（索引器の listener）
- Test: `packages/server/src/indexer/service.test.ts`、`packages/server/src/db/queries.test.ts`、`packages/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: `SessionDto.transcriptMtime`（Task 1）
- Produces:
  - `IndexerListener.transcriptGone?: (e: { sessionId: string }) => void`
  - `SessionDto.transcriptMtime` に、この PC の主線の本文の `transcript_files.mtime`（ミリ秒）が入る

- [ ] **Step 1: 落ちる試験を書く**

`service.test.ts` の既存の作り方（一時の claudeDir に jsonl を置き、`IndexerService` を `scanOnce` か同等の走査で回す）に倣って、次の 3 つを足す。

```ts
it('手元の本文ファイルが消えたら、その索引を片付けて transcriptGone を出す', async () => {
  // 1. projects/<p>/<uuid>.jsonl を置いて走査し、transcript_files に行があることを確かめる。
  // 2. ファイルを消して、もう一度走査する。
  // 3. transcript_files と event_index にそのセッションの行が無く、listener の transcriptGone が { sessionId } で 1 度呼ばれたことを確かめる。
});
it('他の PC の写し（device_id あり）の行は片付けない', async () => {
  // transcript_files に device_id = 'other' の行を直接入れ、そのパスのファイルは作らずに走査する。行が残ることを確かめる。
});
it('projects そのものが見えないときは何も片付けない', async () => {
  // 本文を置いて走査した後、projects ディレクトリごと消して走査する。transcript_files の行が残り、transcriptGone が呼ばれないことを確かめる。
});
```

各試験の中身は、同じファイルにある既存の試験の組み立て（DB を開く関数、jsonl を書く関数、走査の呼び方）をそのまま使って書く。

`queries.test.ts` には、手元の主線の `transcript_files` 行（`mtime = 1234`）と、サブエージェントの行（`mtime = 9999`）と、他の PC の行（`device_id = 'x'`、`mtime = 5555`）を持つセッションで、`getSession(...).transcriptMtime` が `1234` になり、行が無いセッションでは `null` になる試験を足す。

`app.test.ts` の、本文ファイルが消えたときの 404 を確かめている試験の期待する文言を「このセッションの本文はこの PC にありません」に改める（無ければ足す）。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/indexer/service.test.ts packages/server/src/db/queries.test.ts packages/server/src/http/app.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`service.ts` の `IndexerListener` に次を足す。

```ts
  /** 手元の本文ファイルが消え、そのセッションの索引を片付けた。hasTranscript が変わるので配り直す。 */
  transcriptGone?: (e: { sessionId: string }) => void;
```

`targets()` の `for (const d of drop)` の後ろに次を足す。

```ts
    this.forgetVanished(new Set([...local, ...remote].map((f) => f.path)));
```

クラスに次のメソッドを足す（import に `path` は既にある）。

```ts
  /**
   * 索引にはあるのに、手元のファイルがもう無い行を片付ける。
   * Claude Code は保持期間を過ぎた本文を黙って消すので、放っておくと「本文あり」のまま開けない会話が残る。
   * 消すのは DB の行だけで、利用者のファイルには触れない。
   * projects そのものが見えないとき（置き場が外れたなど）は、全部を消してしまわないよう何もしない。
   * 他の PC の写し（device_id あり）は持ち主の同期が扱うので、ここでは見ない。
   */
  private forgetVanished(seen: Set<string>): void {
    if (!fs.existsSync(path.join(this.opts.claudeDir, 'projects'))) return;
    const rows = this.opts.db.prepare('select path, session_id from transcript_files where device_id is null').all() as { path: string; session_id: string }[];
    const gone = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.path)) continue;
      try {
        fs.lstatSync(r.path);
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      try {
        forgetTranscriptFile(this.opts.db, r.path);
        gone.add(r.session_id);
      } catch (e) {
        this.emitError(r.path, errorMessage(e));
      }
    }
    for (const sessionId of gone) for (const l of this.listeners) l.transcriptGone?.({ sessionId });
  }
```

`queries.ts` の `SESSION_SELECT` の `has_local,` の後ろに次を足す。

```sql
  (select max(t.mtime) from transcript_files t where t.session_id = s.id and t.agent_id is null and t.device_id is null) local_mtime,
```

行の型に `local_mtime: number | null;` を足し、`toSessionDto` の Task 1 で仮に置いた `transcriptMtime: null,` を次に替える。

```ts
    // 保持期間の期限を UI が数えるための、この PC の本文の更新時刻。Claude Code もこれで古さを測るとみなす。
    transcriptMtime: r.local_mtime,
```

`app.ts:366` の文言を `'このセッションの本文はこの PC にありません'` に替える。

`server.ts` の索引器の listener（`sessionChanged:` のある `indexer.on({ ... })`）に次を足す。

```ts
    transcriptGone: (e) => {
      const s = getSession(db, registry.current(), e.sessionId, { deviceId: device.id });
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    },
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "fix(server): forget the index of transcripts Claude Code has deleted, and send their mtime"
```

---

### Task 7: HTTP の経路とサーバへの組み込み

**Files:**
- Modify: `packages/server/src/config/retention.ts`（`RetentionService` を足す）
- Modify: `packages/server/src/http/app.ts`（`AppDeps`、bootstrap、経路 3 つ）
- Modify: `packages/server/src/server.ts`（組み立て、タイマー、閉じるとき）
- Test: `packages/server/src/config/retention.test.ts`、`packages/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: Task 4 と Task 5 の関数、`RetentionDto`、`RetentionPreviewDto`（Task 1）
- Produces:
  - `class RetentionService { current(): RetentionDto; refresh(): void; measure(): Promise<void>; preview(days: number): RetentionPreviewDto; write(days: number, baseSha256: string): RetentionDto; start(): void; stop(): void }`
  - `AppDeps.retention: { current(): RetentionDto; preview(days: number): RetentionPreviewDto; write(days: number, baseSha256: string): RetentionDto }`
  - `GET /api/retention` → `RetentionDto`
  - `POST /api/retention/preview`（本文 `{ days }`）→ `RetentionPreviewDto`
  - `PUT /api/retention`（本文 `{ days, baseSha256 }`）→ `RetentionDto`、409 `{ error: 'retention_conflict' }`
  - bootstrap の `retention`

- [ ] **Step 1: 落ちる試験を書く**

`retention.test.ts` に足す。

```ts
describe('RetentionService', () => {
  it('変わったときだけ配り、書いた後は新しい値を返す', async () => {
    const sent: RetentionDto[] = [];
    const svc = new RetentionService({ claudeDir, home: path.join(root, 'hangar'), managedDir, broadcast: (r) => sent.push(r), now: () => NOW });
    svc.refresh();
    expect(sent).toHaveLength(0);
    expect(svc.current()).toMatchObject({ days: 30, source: 'default', usage: null });
    const p = svc.preview(365);
    expect(svc.write(365, p.baseSha256)).toMatchObject({ days: 365, source: 'user' });
    expect(sent.at(-1)).toMatchObject({ days: 365 });
    svc.refresh();
    expect(sent).toHaveLength(1);
    await svc.measure();
    expect(sent.at(-1)!.usage).not.toBeNull();
  });
});
```

（`NOW` は `measureUsage` の describe と同じ値を、ファイルの先頭の定数に上げて共有する。import に `RetentionService` と `type RetentionDto` を足す。）

`app.test.ts` の `deps` に `retention: fakeRetention()` を足し、ファイルの上の方に次の作り手を置く。

```ts
const RET: RetentionDto = { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: null };
function fakeRetention() {
  return {
    current: vi.fn(() => RET),
    preview: vi.fn((days: number) => ({ days, path: '/c/settings.json', lines: [], baseSha256: 'abc', backupDir: '/h/backups/claude-config', projectedBytes: null })),
    write: vi.fn((days: number, sha: string): RetentionDto => { if (sha === 'stale') throw new RetentionConflictError(); return { ...RET, days, source: 'user', userValue: days }; }),
  };
}
```

`createApp({ ... })` を直に書いている 2 か所（`app.test.ts:716` と `:759`）にも `retention: fakeRetention()` を足す。
経路の試験を足す。

```ts
describe('保持期間', () => {
  it('bootstrap に載る', async () => {
    const r = await app.request('/api/bootstrap', { headers: auth });
    expect((await r.json()).retention).toEqual(RET);
  });
  it('下見と書き込みは 1 以上 36500 以下の整数だけを受け付ける', async () => {
    for (const days of [0, -1, 1.5, '30', 36501, null]) {
      const r = await app.request('/api/retention/preview', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ days }) });
      expect(r.status).toBe(400);
    }
    const ok = await app.request('/api/retention/preview', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ days: 365 }) });
    expect((await ok.json()).days).toBe(365);
  });
  it('指紋が古ければ 409 の retention_conflict', async () => {
    const r = await app.request('/api/retention', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ days: 365, baseSha256: 'stale' }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'retention_conflict' });
  });
  it('書けたら新しい値を返す', async () => {
    const r = await app.request('/api/retention', { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ days: 365, baseSha256: 'abc' }) });
    expect(await r.json()).toMatchObject({ days: 365, source: 'user' });
  });
});
```

（`auth` はこのファイルで他の試験が使っている認証のヘッダの変数名に合わせる。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/retention.test.ts packages/server/src/http/app.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`retention.ts` に足す。

```ts
export type RetentionServiceOptions = { claudeDir: string; home: string; managedDir: string | null; broadcast: (r: RetentionDto) => void; now?: () => number };

/** 起動の後に 1 度だけ測るまでの待ち。起動の索引づけと重ねない。 */
const FIRST_MEASURE_MS = 30_000;
const MEASURE_EVERY_MS = 3_600_000;
/** 読み直す周期。設定の送信（CONFIG_PUSH_MS）と同じにする。 */
const REFRESH_EVERY_MS = 60_000;

/**
 * 保持期間の今の値と使用量を持ち、変わったときだけ retention.changed を配る。
 * 使用量は重いので周期で測り、要求のたびには測らない。
 */
export class RetentionService {
  private state: RetentionState;
  private usage: RetentionUsageDto | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;

  constructor(private readonly o: RetentionServiceOptions) {
    this.now = o.now ?? Date.now;
    this.state = readRetention(o);
  }

  current(): RetentionDto { return { ...this.state, usage: this.usage }; }

  /** 読み直し、変わっていれば配る。 */
  refresh(): void {
    const next = readRetention(this.o);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.o.broadcast(this.current());
  }

  async measure(): Promise<void> {
    this.usage = await measureUsage({ claudeDir: this.o.claudeDir, now: this.now() });
    this.o.broadcast(this.current());
  }

  preview(days: number): RetentionPreviewDto {
    return previewRetention({ claudeDir: this.o.claudeDir, home: this.o.home, days, dailyBytes: this.usage?.dailyBytes ?? null });
  }

  write(days: number, baseSha256: string): RetentionDto {
    writeRetention({ claudeDir: this.o.claudeDir, home: this.o.home, days, baseSha256 });
    this.refresh();
    return this.current();
  }

  start(): void {
    const measure = () => void this.measure().catch((e: unknown) => console.error('[retention]', e instanceof Error ? e.message : e));
    this.timers.push(setTimeout(measure, FIRST_MEASURE_MS), setInterval(measure, MEASURE_EVERY_MS), setInterval(() => this.refresh(), REFRESH_EVERY_MS));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
```

（`clearTimeout` は Node では setInterval のタイマーも止める。）

`app.ts`:
- `AppDeps` の `shellHook` の後ろに足す。

```ts
  /** Claude Code の保持期間。書き込みは cleanupPeriodDays の 1 か所だけで、原則「読み取り専用」の 4 つめの例外である。 */
  retention: { current(): RetentionDto; preview(days: number): RetentionPreviewDto; write(days: number, baseSha256: string): RetentionDto };
```

- bootstrap の本体に `retention: deps.retention.current(),` を足す（Task 1 の仮の `retention: null` を替える）。
- `api.patch('/settings', ...)` の前に経路を足す。本文は既存の `readJson(c, BODY_LIMITS.default)` と `tooLargeResult` で読む。

```ts
  /** 保持期間として受け付ける値。Claude Code は 1 未満を弾く。上は 100 年で切り、打ち間違いの桁あふれを通さない。 */
  const retentionDays = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 36500 ? v : null);
  const BAD_DAYS = '保持期間は 1 以上 36500 以下の整数で指定してください';

  api.get('/retention', (c) => c.json(deps.retention.current()));
  api.post('/retention/preview', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const days = retentionDays((b.value as { days?: unknown } | null)?.days);
    if (days === null) return c.json({ error: BAD_DAYS }, 400);
    try {
      return c.json(deps.retention.preview(days));
    } catch (e) {
      if (e instanceof JsonTextEditError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  api.put('/retention', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { days?: unknown; baseSha256?: unknown };
    const days = retentionDays(body.days);
    if (days === null) return c.json({ error: BAD_DAYS }, 400);
    if (typeof body.baseSha256 !== 'string') return c.json({ error: '下見の指紋がありません' }, 400);
    try {
      return c.json(deps.retention.write(days, body.baseSha256));
    } catch (e) {
      if (e instanceof RetentionConflictError) return c.json({ error: 'retention_conflict' }, 409);
      if (e instanceof JsonTextEditError || (e instanceof Error && e.message === LOCK_BUSY_MESSAGE)) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
```

（`JsonTextEditError`、`RetentionConflictError`、`LOCK_BUSY_MESSAGE` と型を import する。）

`server.ts`:
- `configSync` を組み立てた後に次を足す。

```ts
  const retention = new RetentionService({ claudeDir, home, managedDir: defaultManagedDir(), broadcast: (r) => hub.broadcast({ type: 'retention.changed', retention: r }) });
```

- `createApp` に渡す deps に `retention,` を足す。
- `configSync?.start();` の後に `retention.start();` を、`if (configTimer) clearInterval(configTimer);` の後に `retention.stop();` を足す。

（`hub` がこの位置でまだ作られていなければ、`hub` を作った後に置く。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): serve and write the retention period, and push it when it changes"
```

---

### Task 8: UI の配線（store、API、Mediator、ランタイム）

**Files:**
- Modify: `packages/ui/src/runtime/api.ts`
- Modify: `packages/ui/src/store/store.ts`
- Modify: `packages/ui/src/mediator/types.ts`、`packages/ui/src/mediator/transition.ts`
- Create: `packages/ui/src/mediator/retention.ts`
- Modify: `packages/ui/src/runtime/runtime.ts`
- Create: `packages/ui/src/presenters/retention.ts`（日数と大きさの言い方、期限の計算）
- Test: `packages/ui/src/mediator/transition.test.ts`、`packages/ui/src/runtime/runtime.test.ts`、`packages/ui/src/store/store.test.ts`、`packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/runtime/api.test.ts`

**Interfaces:**
- Consumes: Task 1 の型、Task 7 の経路
- Produces:
  - `store.retention: RetentionDto | null`、`store.retentionPreview: RetentionPreviewDto | null`
  - `State.retentionBannerDismissed: boolean`
  - `Overlay` の `{ kind: 'retention'; days: number; from: RetentionFrom; reloaded: boolean; writing: boolean }`
  - Effect の `api.retentionPreview { days }` と `api.writeRetention { days }`
  - RuntimeEvent の `retention.written { days }`、`retention.conflict { days }`、`retention.failed { message }`
  - `RETENTION_BANNER_KEY = 'retention.bannerDismissed'`
  - `ApiClient.retention()`、`retentionPreview(days)`、`writeRetention(days, baseSha256)`、`class RetentionConflictApiError`
  - `presenters/retention.ts`:
    - `DAY_MS`、`SOON_DAYS = 7`、`GONE_AFTER_DAYS = 30`、`RETENTION_CHOICES = [30, 90, 365, 3650]`、`EXTEND_TO = 365`
    - `daysLabel(days: number): string`
    - `bytesLabel(bytes: number): string`
    - `expiresBy(mtime: number, days: number): number`
    - `isExpiringSoon(s: SessionDto, days: number, now: number): boolean`
    - `countExpiring(sessions: SessionDto[], days: number, now: number): number`
    - `transcriptMark(s: SessionDto, days: number, now: number): 'present' | 'expiring' | 'gone' | 'none'`

- [ ] **Step 1: 落ちる試験を書く**

`presenters.test.ts` に足す。

```ts
describe('保持期間の言い方と期限', () => {
  const DAY = 86_400_000;
  it('日数と大きさの言い方', () => {
    expect([30, 90, 365, 3650, 45, 730].map(daysLabel)).toEqual(['30 日', '90 日', '1 年', '10 年', '45 日', '2 年']);
    expect([1_610_612_736, 18 * 1024 ** 3, 52_428_800, 2048, 0].map(bytesLabel)).toEqual(['1.5 GB', '18 GB', '50 MB', '2 KB', '0 KB']);
  });
  it('本文の印は 4 通り', () => {
    expect(transcriptMark(session('a', { transcriptMtime: NOW - 10 * DAY }), 30, NOW)).toBe('present');
    expect(transcriptMark(session('a', { transcriptMtime: NOW - 24 * DAY }), 30, NOW)).toBe('expiring');
    // 期限を過ぎてもまだ消えていなければ、次の起動で消えるので「まもなく」に入れる。
    expect(transcriptMark(session('a', { transcriptMtime: NOW - 31 * DAY }), 30, NOW)).toBe('expiring');
    expect(transcriptMark(session('a', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 31 * DAY }), 365, NOW)).toBe('gone');
    expect(transcriptMark(session('a', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 3 * DAY }), 30, NOW)).toBe('none');
    // 他の PC にしか本文が無い会話は、この PC の期限を持たない。
    expect(transcriptMark(session('a', { remoteOnly: true, transcriptMtime: null }), 30, NOW)).toBe('present');
  });
});
```

（import に `bytesLabel`、`daysLabel`、`transcriptMark` を `./retention.ts` から足す。）

`transition.test.ts` に足す（このファイルの既存の `run(state, inputs)` のような流し方に合わせる）。

```ts
describe('保持期間', () => {
  it('閉じると覚え、保存する', () => {
    const r = transition(initialState(), { kind: 'intent', intent: { type: 'retention.dismiss' } });
    expect(r.state.retentionBannerDismissed).toBe(true);
    expect(r.effects).toEqual([{ kind: 'storage.save', key: 'retention.bannerDismissed', value: true }]);
  });
  it('開くと下見を取り、書くと送信中になり、書けたら閉じる', () => {
    let r = transition(initialState(), { kind: 'intent', intent: { type: 'retention.edit', days: 365, from: 'banner' } });
    expect(r.state.overlay).toEqual({ kind: 'retention', days: 365, from: 'banner', reloaded: false, writing: false });
    expect(r.effects).toEqual([{ kind: 'api.retentionPreview', days: 365 }]);
    r = transition(r.state, { kind: 'intent', intent: { type: 'retention.write' } });
    expect(r.state.overlay).toMatchObject({ kind: 'retention', writing: true });
    expect(r.effects).toEqual([{ kind: 'api.writeRetention', days: 365 }]);
    // 送信中にもう一度押しても二重に書かない。
    expect(transition(r.state, { kind: 'intent', intent: { type: 'retention.write' } }).effects).toEqual([]);
    r = transition(r.state, { kind: 'runtime', event: { type: 'retention.written', days: 365 } });
    expect(r.state.overlay).toEqual({ kind: 'none' });
    expect(r.effects).toEqual([{ kind: 'toast', level: 'info', message: '保持期間を 1 年にしました' }]);
  });
  it('409 なら下見を取り直し、読み直したことを出す', () => {
    const open = transition(initialState(), { kind: 'intent', intent: { type: 'retention.edit', days: 365, from: 'settings' } }).state;
    const writing = transition(open, { kind: 'intent', intent: { type: 'retention.write' } }).state;
    const r = transition(writing, { kind: 'runtime', event: { type: 'retention.conflict', days: 365 } });
    expect(r.state.overlay).toEqual({ kind: 'retention', days: 365, from: 'settings', reloaded: true, writing: false });
    expect(r.effects).toEqual([{ kind: 'api.retentionPreview', days: 365 }]);
  });
  it('失敗したら送信中を解いてトーストを出す。「ほかの期間…」は設定画面へ移る', () => {
    const open = transition(initialState(), { kind: 'intent', intent: { type: 'retention.edit', days: 365, from: 'banner' } }).state;
    const writing = transition(open, { kind: 'intent', intent: { type: 'retention.write' } }).state;
    const f = transition(writing, { kind: 'runtime', event: { type: 'retention.failed', message: 'x' } });
    expect(f.state.overlay).toMatchObject({ writing: false });
    expect(f.effects).toEqual([{ kind: 'toast', level: 'error', message: 'x' }]);
    const s = transition(open, { kind: 'intent', intent: { type: 'retention.settings' } });
    expect(s.state.overlay).toEqual({ kind: 'none' });
    expect(s.effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }]);
  });
});
```

`runtime.test.ts` に足す（既存の `fakeApi` に `retention`、`retentionPreview`、`writeRetention` の `vi.fn` を足し、既存の試験の起動の仕方に合わせる）。

```ts
it('本文の無い会話を開いても、本文を読みに行かない', async () => {
  // bootstrap に hasTranscript: false のセッション s1 を載せ、#/sessions/s1 へ移る。
  // api.events が呼ばれないことを確かめる。
});
it('帯を閉じた覚えを起動時に読み戻す', () => {
  // storage に 'retention.bannerDismissed' = true を入れて start し、getState().retentionBannerDismissed が true であることを確かめる。
});
it('書き込みは下見の指紋を送り、409 なら retention.conflict、成功なら store.retention を入れ替える', async () => {
  // retention.edit → store.retentionPreview に baseSha256: 'abc' が入る → retention.write。
  // api.writeRetention が (365, 'abc') で呼ばれ、store.retention が返り値になり、overlay が none になることを確かめる。
  // writeRetention が RetentionConflictApiError を投げる版では、overlay の reloaded が true になり、retentionPreview がもう一度呼ばれることを確かめる。
});
it('設定画面に入ると保持期間を読み直す', () => {
  // #/settings へ移り、api.retention が呼ばれ、store.retention が返り値になることを確かめる。
});
```

`store.test.ts` に、bootstrap の `retention` が `store.retention` に入ること（欠けていれば null）と、`retention.changed` で差し替わることの試験を足す。
`api.test.ts` に、`PUT /api/retention` が 409 と `{ error: 'retention_conflict' }` を返したら `RetentionConflictApiError` を投げる試験を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/mediator packages/ui/src/runtime packages/ui/src/store packages/ui/src/presenters`
Expected: FAIL

- [ ] **Step 3: 実装する**

`presenters/retention.ts`:

```ts
import type { SessionDto } from '@agent-hangar/shared';

/** 保持期間の周知で使う決まりと言い方。帯、確認、一覧、詳細、設定画面の presenter がここを通す。 */
export const DAY_MS = 86_400_000;
/** 期限までこの日数を切った本文を「まもなく削除」とする。 */
export const SOON_DAYS = 7;
/**
 * 本文が無く、最後に動いてからこの日数を過ぎた会話を「保持期間で消えたとみられる」とする。
 * 今の保持期間ではなく 30 日にするのは、今日延ばしても、過去の本文は既定の 30 日で消えているからである。
 */
export const GONE_AFTER_DAYS = 30;
export const RETENTION_CHOICES = [30, 90, 365, 3650] as const;
/** 帯と詳細から延ばすときの行き先。 */
export const EXTEND_TO = 365;

export const daysLabel = (days: number): string => (days % 365 === 0 ? `${days / 365} 年` : `${days} 日`);

export function bytesLabel(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) { const v = bytes / GB; return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} GB`; }
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export const expiresBy = (mtime: number, days: number): number => mtime + days * DAY_MS;

export const isExpiringSoon = (s: SessionDto, days: number, now: number): boolean => s.transcriptMtime !== null && expiresBy(s.transcriptMtime, days) <= now + SOON_DAYS * DAY_MS;

export const countExpiring = (sessions: SessionDto[], days: number, now: number): number => sessions.filter((s) => isExpiringSoon(s, days, now)).length;

export function transcriptMark(s: SessionDto, days: number, now: number): 'present' | 'expiring' | 'gone' | 'none' {
  if (s.hasTranscript) return isExpiringSoon(s, days, now) ? 'expiring' : 'present';
  if (s.lastActivityAt !== null && now - s.lastActivityAt > GONE_AFTER_DAYS * DAY_MS) return 'gone';
  return 'none';
}
```

`api.ts`:
- import に `RetentionDto`、`RetentionPreviewDto` を足す。
- `ApiConflictError` の下に次を足す。

```ts
/** 保持期間の下見の後に、設定ファイルがほかで変わった。UI は下見を取り直す。 */
export class RetentionConflictApiError extends Error {
  constructor() { super('retention_conflict'); this.name = 'RetentionConflictApiError'; }
}
```

- `call()` の `local_smaller` の行の後に `if (r.status === 409 && body?.error === 'retention_conflict') throw new RetentionConflictApiError();` を足す。
- `ApiClient` に次の 3 つを足し、実装の側にも足す。

```ts
  retention(): Promise<RetentionDto>;
  retentionPreview(days: number): Promise<RetentionPreviewDto>;
  writeRetention(days: number, baseSha256: string): Promise<RetentionDto>;
```

```ts
    retention: () => call('/api/retention'),
    retentionPreview: (days) => post('/api/retention/preview', { days }),
    writeRetention: (days, baseSha256) => call('/api/retention', { method: 'PUT', body: JSON.stringify({ days, baseSha256 }) }),
```

`store.ts`:
- `Store` に `retention: RetentionDto | null; retentionPreview: RetentionPreviewDto | null;` を足す（下見は押したときだけ取る値なので、`configPreview` の並びに置く）。`initialStore()` では両方 null にする。
- `applyBootstrap` に `retention: old.retention ?? null` を足す。
- `applyServerEvent` に `case 'retention.changed': return { ...store, retention: ev.retention };` を足す。

`mediator/types.ts`:
- `RuntimeEvent` に `| { type: 'retention.written'; days: number } | { type: 'retention.conflict'; days: number } | { type: 'retention.failed'; message: string }` を足す。
- `Effect` に `| { kind: 'api.retentionPreview'; days: number } | { kind: 'api.writeRetention'; days: number }` を足す。
- `Overlay` に `| { kind: 'retention'; days: number; from: RetentionFrom; reloaded: boolean; writing: boolean }` を足す。
- `State` の `sidebarCollapsed` の後ろに、次の 2 行を足す。

```ts
  /** 保持期間の帯を「このままでよい」で閉じたか。端末ごとに localStorage に残し、起動時に読み戻す。 */
  retentionBannerDismissed: boolean;
```

`mediator/retention.ts`:

```ts
import { daysLabel } from '../presenters/retention.ts';
import type { Input, State, Step } from './types.ts';

/** 帯を閉じたことを残す localStorage の鍵。値は真偽値そのもの。 */
export const RETENTION_BANNER_KEY = 'retention.bannerDismissed';

/**
 * retention 領域：保持期間の帯と、書き込む前の確認。
 * 確認は開いた時点で下見を取りに行き、書き込みは送信中の間もう一度押しても重ねない。
 * 閉じる（overlay.close）は overlay 領域がまとめて扱う。
 */
export function retentionStep(state: State, input: Input): Step | null {
  const o = state.overlay;
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'retention.written') return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'toast', level: 'info', message: `保持期間を ${daysLabel(e.days)}にしました` }] };
    if (o.kind !== 'retention') return null;
    if (e.type === 'retention.conflict') return { state: { ...state, overlay: { ...o, reloaded: true, writing: false } }, effects: [{ kind: 'api.retentionPreview', days: o.days }] };
    if (e.type === 'retention.failed') return { state: { ...state, overlay: { ...o, writing: false } }, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'retention.dismiss': return { state: { ...state, retentionBannerDismissed: true }, effects: [{ kind: 'storage.save', key: RETENTION_BANNER_KEY, value: true }] };
    case 'retention.edit': return { state: { ...state, overlay: { kind: 'retention', days: i.days, from: i.from, reloaded: false, writing: false } }, effects: [{ kind: 'api.retentionPreview', days: i.days }] };
    case 'retention.write':
      if (o.kind !== 'retention' || o.writing) return { state, effects: [] };
      return { state: { ...state, overlay: { ...o, writing: true } }, effects: [{ kind: 'api.writeRetention', days: o.days }] };
    case 'retention.settings': return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'navigate', route: { name: 'settings' } }] };
    default: return null;
  }
}
```

（`retention.written` の文言は「保持期間を 1 年にしました」になる。`daysLabel` の結果「1 年」の前に空白が入る書き方にする。）

`transition.ts`:
- `initialState()` に `retentionBannerDismissed: false` を足す。
- 領域の並びの `syncStep` の後ろに `retentionStep` を足し、import する。

`runtime.ts`:
- `start()` の `state = { ...state, sessionView: sv, sidebarCollapsed: ... }` に `retentionBannerDismissed: deps.storage.get(RETENTION_BANNER_KEY) === true` を足す。
- `case 'api.loadEvents': {` の先頭に次を足す。

```ts
        // 本文が無いと分かっている会話は読みに行かない。行っても 404 のトーストが出るだけである。
        if (store.sessions[e.sessionId]?.hasTranscript === false) return;
```

- `case 'api.loadSettingsExtras':` の中に `deps.api.retention().then((r) => setStore({ ...store, retention: r })).catch(fail);` を足す。
- 効果を 2 つ足す（import に `RetentionConflictApiError` を足す）。

```ts
      case 'api.retentionPreview':
        // 前の下見を先に消し、取り直している最中に古い差分で書かないようにする。
        setStore({ ...store, retentionPreview: null });
        deps.api.retentionPreview(e.days).then((p) => setStore({ ...store, retentionPreview: p })).catch((err) => dispatch({ kind: 'runtime', event: { type: 'retention.failed', message: errMsg(err) } }));
        return;
      case 'api.writeRetention': {
        const p = store.retentionPreview;
        if (!p || p.days !== e.days) { dispatch({ kind: 'runtime', event: { type: 'retention.failed', message: '差分を読み込んでいます。少し待ってから押してください' } }); return; }
        deps.api.writeRetention(e.days, p.baseSha256)
          .then((r) => { setStore({ ...store, retention: r, retentionPreview: null }); dispatch({ kind: 'runtime', event: { type: 'retention.written', days: e.days } }); })
          .catch((err: unknown) => dispatch({ kind: 'runtime', event: err instanceof RetentionConflictApiError ? { type: 'retention.conflict', days: e.days } : { type: 'retention.failed', message: errMsg(err) } }));
        return;
      }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): wire the retention state, its confirm flow, and skip reading deleted transcripts"
```

---

### Task 9: 帯（A2）

**Files:**
- Modify: `packages/ui/src/presenters/shell.ts`
- Create: `packages/ui/src/views/RetentionBanner.tsx`
- Modify: `packages/ui/src/views/Shell.tsx`、`packages/ui/src/views/ConnectionBanner.tsx`（`aria-label` を足す）
- Modify: `packages/ui/src/views/primitives/Icon.tsx`（`retention: Clock` と `transcriptGone: FileX2`）
- Modify: `packages/ui/src/styles/base.css`（`.banners`、`.retention-banner`、`.main` の上の余白）
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/Shell.test.tsx`、`packages/ui/src/styles/glass.test.ts`

**Interfaces:**
- Consumes: `store.retention`、`State.retentionBannerDismissed`（Task 8）、`countExpiring`、`daysLabel`、`bytesLabel`、`EXTEND_TO`（Task 8）
- Produces:
  - `ShellProps.retention: RetentionBannerProps`
  - `type RetentionBannerProps = { visible: boolean; title: string; detail: string; extendTo: number }`

- [ ] **Step 1: 落ちる試験を書く**

`presenters.test.ts` に足す。

```ts
describe('presentShell の保持期間の帯', () => {
  const DAY = 86_400_000;
  const R = { days: 30, source: 'default' as const, userValue: null, writable: true, unwritableReason: null, usage: { bytes: 1_610_612_736, dailyBytes: 52_428_800, freeBytes: 400 * 1024 ** 3, measuredAt: NOW } };
  const withSessions = (list: SessionDto[], retention: RetentionDto | null = R): Store => ({ ...initialStore(), bootstrapped: true, retention, sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
  it('消えかけが無ければ、30 日で消えることと使用量を言う', () => {
    expect(presentShell(initialState(), withSessions([]), NOW).retention).toEqual({ visible: true, title: '会話は 30 日で削除されます', detail: 'hangar の履歴からも消えます ・ いま 1.5 GB', extendTo: 365 });
  });
  it('消えかけがあれば件数を言う', () => {
    const s = [session('a', { transcriptMtime: NOW - 25 * DAY }), session('b', { transcriptMtime: NOW - 26 * DAY }), session('c', { transcriptMtime: NOW - 2 * DAY })];
    expect(presentShell(initialState(), withSessions(s), NOW).retention).toMatchObject({ title: '2 件の会話が、まもなく削除されます', detail: 'Claude Code は 30 日で本文を消します ・ いま 1.5 GB' });
  });
  it('使用量をまだ測っていなければ、その部分を出さない', () => {
    expect(presentShell(initialState(), withSessions([], { ...R, usage: null }), NOW).retention.detail).toBe('hangar の履歴からも消えます');
  });
  it('自分で値を入れた人、組織の設定、書けないとき、閉じた後には出さない', () => {
    for (const r of [{ ...R, source: 'user' as const, userValue: 30 }, { ...R, source: 'managed' as const, writable: false }, { ...R, writable: false }]) {
      expect(presentShell(initialState(), withSessions([], r), NOW).retention.visible).toBe(false);
    }
    expect(presentShell({ ...initialState(), retentionBannerDismissed: true }, withSessions([]), NOW).retention.visible).toBe(false);
    expect(presentShell(initialState(), withSessions([], null), NOW).retention.visible).toBe(false);
  });
});
```

`Shell.test.tsx` に、`retention.visible` が真のとき「会話は 30 日で削除されます」が出ることと、「このままでよい」と「保持期間を延ばす…」がそれぞれ `retention.dismiss` と `retention.edit { days: 365, from: 'banner' }` を出すことを確かめる試験を足す。接続の帯と同時に出したとき、`getAllByRole('status')` が 2 つになり、名前（`接続の状態`、`会話の保持期間`）で区別できることも確かめる。既存の `getByRole('status')` は `getByRole('status', { name: '接続の状態' })` に改める。
`glass.test.ts` の一覧に `.retention-banner` を足し、`:has(.conn-banner)` の規則の文面を確かめている箇所を、下の新しい規則に合わせて改める。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/views/Shell.test.tsx packages/ui/src/styles`
Expected: FAIL

- [ ] **Step 3: 実装する**

`shell.ts`:

```ts
/** 保持期間の帯。既定の 30 日のままで、書けて、まだ閉じていないときだけ出す。 */
export type RetentionBannerProps = { visible: boolean; title: string; detail: string; extendTo: number };
```

`ShellProps` に `retention: RetentionBannerProps;` を足し、`presentShell` の戻り値に `retention: retentionBanner(state, store, now)` を足す。

```ts
/**
 * 保持期間の帯。値を自分で入れた人（30 日を含む）と、組織の設定で決まっている人には出さない。
 * 消えかけの会話があればその件数を、無ければ「消える」という決まりそのものを言う。
 */
function retentionBanner(state: State, store: Store, now: number): RetentionBannerProps {
  const r = store.retention;
  const hidden: RetentionBannerProps = { visible: false, title: '', detail: '', extendTo: EXTEND_TO };
  if (!store.bootstrapped || !r || r.source !== 'default' || !r.writable || state.retentionBannerDismissed) return hidden;
  const soon = countExpiring(Object.values(store.sessions), r.days, now);
  const usage = r.usage ? ` ・ いま ${bytesLabel(r.usage.bytes)}` : '';
  return soon > 0
    ? { visible: true, title: `${soon} 件の会話が、まもなく削除されます`, detail: `Claude Code は ${daysLabel(r.days)}で本文を消します${usage}`, extendTo: EXTEND_TO }
    : { visible: true, title: `会話は ${daysLabel(r.days)}で削除されます`, detail: `hangar の履歴からも消えます${usage}`, extendTo: EXTEND_TO };
}
```

`RetentionBanner.tsx`:

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { RetentionBannerProps } from '../presenters/shell.ts';
import { Icon } from './primitives/Icon.tsx';

/**
 * Claude Code の保持期間が既定の 30 日のままのあいだだけ降りてくる帯。
 * 接続の帯と同じ形で、色だけを警告の琥珀にする。文言はすべて presenter が組み立てる。
 */
export function RetentionBanner(props: RetentionBannerProps) {
  const emit = useEmit();
  if (!props.visible) return null;
  return (
    <div className="retention-banner" role="status" aria-label="会話の保持期間">
      <Icon name="retention" />
      <b>{props.title}</b>
      <span className="retention-detail">{props.detail}</span>
      <span className="spacer" />
      <button className="btn btn-sm btn-ghost" onClick={() => emit({ type: 'retention.dismiss' })}>このままでよい</button>
      <button className="btn btn-sm btn-primary" onClick={() => emit({ type: 'retention.edit', days: props.extendTo, from: 'banner' })}>保持期間を延ばす…</button>
    </div>
  );
}
```

（`btn-ghost` と `btn-sm` と `btn-primary` の名前は `styles/controls.css` と `base.css` にあるものを使う。無い名前は足さず、ある名前に合わせる。）

`ConnectionBanner.tsx` の `<div className="conn-banner" role="status">` に `aria-label="接続の状態"` を足す。

`Shell.tsx` の `<ConnectionBanner {...props.conn} />` を次に替える（`RetentionBanner` を import する）。

```tsx
      {/* 帯は 2 行目に縦に積む。切断を上に置く。どちらも無いときは箱が空になり、:empty で潰れる。 */}
      <div className="banners"><ConnectionBanner {...props.conn} /><RetentionBanner {...props.retention} /></div>
```

`base.css`:
- `.conn-banner` の規則から `grid-column: 2; grid-row: 2; z-index: 2;` と `margin: ...` を外し、次の箱の規則に移す。

```css
/* 帯の箱。grid の 2 行目に、切断の帯と保持期間の帯を縦に積む。 */
.banners { grid-column: 2; grid-row: 2; z-index: 2; display: flex; flex-direction: column; gap: calc(var(--float-gap) * 0.75); margin: calc(var(--float-gap) * 0.75) var(--float-gap) 0; }
.banners:empty { display: none; }
```

- `.shell:has(.conn-banner) .main` の規則を、帯の数で決める 2 つの規則に替える（コメントの計算の説明も書き直す。1 つなら 86px、2 つなら 44 + 6 + 28 + 6 + 28 + 8 = 120px）。

```css
.shell:has(.banners > :nth-child(1)) .main { padding-top: calc(var(--header-h) + var(--float-gap) * 1.75 + var(--row-h)); scroll-padding-top: calc(var(--header-h) + var(--float-gap) * 1.75 + var(--row-h)); }
.shell:has(.banners > :nth-child(2)) .main { padding-top: calc(var(--header-h) + var(--float-gap) * 2.5 + var(--row-h) * 2); scroll-padding-top: calc(var(--header-h) + var(--float-gap) * 2.5 + var(--row-h) * 2); }
```

- 保持期間の帯を足す（切り詰めの決まりは `.conn-banner` と同じにする）。

```css
/* 保持期間の帯。形は切断の帯と同じで、色だけを警告の琥珀にする。 */
.retention-banner { display: flex; align-items: center; gap: calc(var(--u) * 2); height: var(--row-h); padding: 0 calc(var(--u) * 1.5) 0 calc(var(--u) * 3); border-radius: var(--r-lg); font-size: var(--fs-sm); color: var(--st-paused); background: color-mix(in srgb, var(--busy) 12%, var(--glass-bg-toast)); -webkit-backdrop-filter: var(--glass-blur-toast); backdrop-filter: var(--glass-blur-toast); box-shadow: var(--glass-edge), var(--glass-drop); animation: drop-in var(--dur) var(--ease-out); }
.retention-banner > b, .retention-banner > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.retention-banner > b { flex: none; }
.retention-banner > .retention-detail { flex-shrink: 4; color: color-mix(in srgb, var(--st-paused) 65%, var(--ink-3)); }
.retention-banner .btn { flex: none; }
```

`Icon.tsx` の import に `Clock` と `FileX2` を足し、`ICONS` に `retention: Clock,` と `transcriptGone: FileX2,` を足す。

`design.md` の「見た目と動き」でガラスを許す部品の一覧は Task 14 で直す。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): show a banner while Claude Code keeps conversations for only 30 days"
```

---

### Task 10: 確認のダイアログ（B1）

**Files:**
- Create: `packages/ui/src/presenters/retentionDialog.ts`
- Create: `packages/ui/src/views/RetentionDialog.tsx`
- Create: `packages/ui/src/views/UsageBar.tsx`（設定画面でも使う）
- Modify: `packages/ui/src/Root.tsx`（overlay の描き分け）
- Modify: `packages/ui/src/styles/base.css`（`.diff`、`.usage-bar`）
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/dialogs.test.tsx`

**Interfaces:**
- Consumes: `Overlay` の `retention`、`store.retentionPreview`、`store.retention`、`store.settings.syncClaudeConfig`（Task 8）、`daysLabel`、`bytesLabel`、`expiresBy`（Task 8）
- Produces:
  - `presentRetentionDialog(state: State, store: Store, now: number): RetentionDialogProps | null`
  - `type UsageBarProps = { nowLabel: string; projLabel: string | null; freeLabel: string; nowPct: number; projPct: number; warn: boolean }`
  - `usageBar(usage: RetentionUsageDto | null, projectedBytes: number | null, days: number): UsageBarProps | null`
  - `type RetentionDialogProps = { title: string; lead: string; path: string; lines: RetentionPreviewLine[] | null; bar: UsageBarProps | null; backupDir: string; otherPcs: boolean; shrinkNote: string | null; reloaded: boolean; showOther: boolean; writing: boolean }`

- [ ] **Step 1: 落ちる試験を書く**

`presenters.test.ts` に足す。

```ts
describe('presentRetentionDialog', () => {
  const DAY = 86_400_000;
  const R: RetentionDto = { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: { bytes: 1_610_612_736, dailyBytes: 52_428_800, freeBytes: 400 * 1024 ** 3, measuredAt: NOW } };
  const P: RetentionPreviewDto = { days: 365, path: '/Users/me/.claude/settings.json', lines: [{ kind: 'ctx', text: '{' }, { kind: 'add', text: '  "cleanupPeriodDays" : 365,' }], baseSha256: 'abc', backupDir: '/Users/me/.agent-hangar/backups/claude-config', projectedBytes: 365 * 52_428_800 };
  const open = (days = 365, from: 'banner' | 'settings' = 'banner') => ({ ...initialState(), overlay: { kind: 'retention' as const, days, from, reloaded: false, writing: false } });
  const st = (over: Partial<Store> = {}): Store => ({ ...initialStore(), retention: R, retentionPreview: P, ...over });
  it('延ばすときの題、説明、見込み、控えを出す', () => {
    const p = presentRetentionDialog(open(), st(), NOW)!;
    expect(p).toMatchObject({ title: '会話の保持期間を 1 年にします', lead: 'Claude Code の設定ファイルに、次の 1 行を足します。', path: P.path, backupDir: P.backupDir + '/', otherPcs: false, shrinkNote: null, showOther: true });
    expect(p.bar).toMatchObject({ nowLabel: 'いま 1.5 GB', projLabel: '1 年たつと約 18 GB', freeLabel: '空き 400 GB', warn: false });
  });
  it('値を替えるときは「書き換えます」、同期が有効ならほかの PC の行を出す', () => {
    const lines = [{ kind: 'del' as const, text: '  "cleanupPeriodDays" : 3650' }, { kind: 'add' as const, text: '  "cleanupPeriodDays" : 365' }];
    const p = presentRetentionDialog(open(365, 'settings'), st({ retention: { ...R, days: 3650, source: 'user', userValue: 3650 }, retentionPreview: { ...P, lines }, settings: { ...settingsDto(), syncClaudeConfig: true } }), NOW)!;
    expect(p.lead).toBe('Claude Code の設定ファイルの、次の 1 行を書き換えます。');
    expect(p.otherPcs).toBe(true);
    expect(p.showOther).toBe(false);
  });
  it('縮めるときは題を変え、消える件数を言う', () => {
    const s = { a: session('a', { transcriptMtime: NOW - 40 * DAY }), b: session('b', { transcriptMtime: NOW - 5 * DAY }) };
    const p = presentRetentionDialog(open(30, 'settings'), st({ retention: { ...R, days: 365, source: 'user', userValue: 365 }, retentionPreview: { ...P, days: 30 }, sessions: s }), NOW)!;
    expect(p.title).toBe('会話の保持期間を 30 日に縮めます');
    expect(p.shrinkNote).toBe('次に Claude Code を使い始めたとき、1 件の会話の本文が削除されます。');
  });
  it('見込みが空きの半分を超えたら警告にし、下見が届く前は差分を null にする', () => {
    const big = presentRetentionDialog(open(3650), st({ retentionPreview: { ...P, days: 3650, projectedBytes: 300 * 1024 ** 3 } }), NOW)!;
    expect(big.bar!.warn).toBe(true);
    expect(presentRetentionDialog(open(), st({ retentionPreview: null }), NOW)!.lines).toBeNull();
    expect(presentRetentionDialog(initialState(), st(), NOW)).toBeNull();
  });
});
```

（`settingsDto()` はこのファイルに既にある SettingsDto の作り手の名前に合わせる。無ければ `store.settings` を作る既存の試験の書き方をまねて作る。）

`dialogs.test.tsx` に、`RetentionDialog` が差分の add 行を `+` 付きで、del 行を `-` 付きで描くこと、`writing` のとき「書き込む」が押せないこと、`reloaded` のとき「設定ファイルがほかで変わったので、読み直しました」を出すこと、「書き込む」が `retention.write` を、「ほかの期間…」が `retention.settings` を、「やめる」が `overlay.close` を出すことを確かめる試験を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/views/dialogs.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`presenters/retentionDialog.ts`:

```ts
import type { RetentionPreviewLine, RetentionUsageDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { bytesLabel, daysLabel, expiresBy } from './retention.ts';

export type UsageBarProps = { nowLabel: string; projLabel: string | null; freeLabel: string; nowPct: number; projPct: number; warn: boolean };
export type RetentionDialogProps = { title: string; lead: string; path: string; lines: RetentionPreviewLine[] | null; bar: UsageBarProps | null; backupDir: string; otherPcs: boolean; shrinkNote: string | null; reloaded: boolean; showOther: boolean; writing: boolean };

/**
 * 使用量のバー。幅はいまの使用量と空きの和を 100% にする（本文が使える限りの広さ）。
 * 見込みが空きの半分を超えるときは警告にする。
 */
export function usageBar(usage: RetentionUsageDto | null, projectedBytes: number | null, days: number): UsageBarProps | null {
  if (!usage) return null;
  const total = usage.bytes + usage.freeBytes;
  const pct = (b: number) => (total > 0 ? Math.min(100, (b / total) * 100) : 0);
  return {
    nowLabel: `いま ${bytesLabel(usage.bytes)}`,
    projLabel: projectedBytes === null ? null : `${daysLabel(days)}たつと約 ${bytesLabel(projectedBytes)}`,
    freeLabel: usage.freeBytes > 0 ? `空き ${bytesLabel(usage.freeBytes)}` : '空きは分かりません',
    nowPct: pct(usage.bytes),
    projPct: projectedBytes === null ? 0 : pct(Math.max(projectedBytes, usage.bytes)),
    warn: projectedBytes !== null && usage.freeBytes > 0 && projectedBytes > usage.freeBytes / 2,
  };
}

export function presentRetentionDialog(state: State, store: Store, now: number): RetentionDialogProps | null {
  const o = state.overlay;
  if (o.kind !== 'retention') return null;
  const cur = store.retention?.days ?? 30;
  const p = store.retentionPreview && store.retentionPreview.days === o.days ? store.retentionPreview : null;
  const shrinking = o.days < cur;
  // 縮めると、新しい期限を既に過ぎた本文が次の起動で消える。
  const lost = shrinking ? Object.values(store.sessions).filter((s) => s.transcriptMtime !== null && expiresBy(s.transcriptMtime, o.days) <= now).length : 0;
  const replacing = p?.lines.some((l) => l.kind === 'del') ?? false;
  return {
    title: shrinking ? `会話の保持期間を ${daysLabel(o.days)}に縮めます` : `会話の保持期間を ${daysLabel(o.days)}にします`,
    lead: replacing ? 'Claude Code の設定ファイルの、次の 1 行を書き換えます。' : 'Claude Code の設定ファイルに、次の 1 行を足します。',
    path: p?.path ?? '',
    lines: p?.lines ?? null,
    bar: usageBar(store.retention?.usage ?? null, p?.projectedBytes ?? null, o.days),
    backupDir: p ? `${p.backupDir}/` : '',
    otherPcs: store.settings?.syncClaudeConfig ?? false,
    shrinkNote: lost > 0 ? `次に Claude Code を使い始めたとき、${lost} 件の会話の本文が削除されます。` : null,
    reloaded: o.reloaded,
    showOther: o.from === 'banner',
    writing: o.writing,
  };
}
```

`UsageBar.tsx`:

```tsx
import type { UsageBarProps } from '../presenters/retentionDialog.ts';

/** いまの使用量と、選んだ期間の終わりの見込み。見込みは斜線で塗り、いまの量の後ろに重ねる。 */
export function UsageBar(props: UsageBarProps) {
  return (
    <div className="usage-bar">
      <div className="usage-meter" aria-hidden="true">
        <i className="usage-proj" style={{ width: `${props.projPct}%` }} />
        <i className="usage-now" style={{ width: `${props.nowPct}%` }} />
      </div>
      <div className="usage-legend">
        <span>{props.nowLabel}</span>
        {props.projLabel && <span className={props.warn ? 'usage-warn' : undefined}>{props.projLabel}</span>}
        <span>{props.freeLabel}</span>
      </div>
    </div>
  );
}
```

`RetentionDialog.tsx`:

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { RetentionDialogProps } from '../presenters/retentionDialog.ts';
import { Icon } from './primitives/Icon.tsx';
import { UsageBar } from './UsageBar.tsx';

const MARK = { ctx: ' ', add: '+', del: '-' } as const;

/**
 * Claude Code の設定ファイルに書く前の確認。
 * 書く 1 行をそのまま差分で見せ、控えの置き場と、もう消えた会話は戻らないことを並べる。
 */
export function RetentionDialog(props: RetentionDialogProps) {
  const emit = useEmit();
  const close = () => emit({ type: 'overlay.close' });
  return (
    <div className="overlay" onClick={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="保持期間の確認" onClick={(e) => e.stopPropagation()}>
        <b className="dialog-title"><Icon name="retention" />{props.title}</b>
        {props.reloaded && <div className="error" role="alert">設定ファイルがほかで変わったので、読み直しました。</div>}
        <div className="muted">{props.lead}</div>
        {props.lines === null
          ? <div className="faint">差分を読み込んでいます</div>
          : (
            <div className="diff mono">
              <div className="diff-path">{props.path}</div>
              {props.lines.map((l, i) => <div key={i} className={`diff-${l.kind}`}>{MARK[l.kind]} {l.text}</div>)}
            </div>
          )}
        {props.bar && <UsageBar {...props.bar} />}
        {props.shrinkNote && <div className="error">{props.shrinkNote}</div>}
        <dl className="kv">
          <dt>控え</dt><dd className="mono">{props.backupDir}</dd>
          {props.otherPcs && <><dt>ほかの PC</dt><dd>設定の同期で、次の取り込み時に届きます</dd></>}
          <dt>もう消えた会話</dt><dd>取り戻せません。これから先の会話が残ります</dd>
        </dl>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={close}>やめる</button>
          <span className="spacer" />
          {props.showOther && <button type="button" className="btn" onClick={() => emit({ type: 'retention.settings' })}>ほかの期間…</button>}
          <button type="button" className="btn btn-primary" disabled={props.writing || props.lines === null} onClick={() => emit({ type: 'retention.write' })}>書き込む</button>
        </div>
      </div>
    </div>
  );
}
```

`Root.tsx` の overlay の並びの `configPreview` の行の後ろに次を足す（import を足す）。

```tsx
      {overlay.kind === 'retention' && <RetentionDialog {...presentRetentionDialog(state, store, now)!} />}
```

`base.css` の「オーバーレイ」の節の後ろに足す（`.kv` が既にあれば使い、無ければ足す）。

```css
/* 保持期間の確認の差分。足す行は緑、消す行は赤の淡い地にする。 */
.diff { background: var(--surface-2); border-radius: var(--r); padding: calc(var(--u) * 2) calc(var(--u) * 2.5); font-size: var(--fs-xs); line-height: 1.65; white-space: pre; overflow: auto; }
.diff-path, .diff-ctx { color: var(--ink-3); }
.diff-add { color: var(--st-done); background: var(--st-done-soft); margin: 0 calc(var(--u) * -2.5); padding: 0 calc(var(--u) * 2.5); }
.diff-del { color: var(--error); background: color-mix(in srgb, var(--error) 8%, transparent); margin: 0 calc(var(--u) * -2.5); padding: 0 calc(var(--u) * 2.5); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: var(--u) calc(var(--u) * 3.5); margin: 0; font-size: var(--fs-sm); }
.kv dt { color: var(--ink-2); }
.kv dd { margin: 0; }
/* 使用量のバー。いまの量は藍、見込みは琥珀の斜線で、いまの量の後ろに重ねる。 */
.usage-meter { position: relative; height: 8px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--ink) 8%, transparent); overflow: hidden; }
.usage-meter > i { position: absolute; inset: 0 auto 0 0; border-radius: var(--r-pill); }
.usage-now { background: var(--accent); }
.usage-proj { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--busy) 55%, transparent) 0 4px, color-mix(in srgb, var(--busy) 25%, transparent) 4px 8px); }
.usage-legend { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 3); margin-top: var(--u); font-size: var(--fs-xs); color: var(--ink-2); }
.usage-warn { color: var(--st-paused); font-weight: 600; }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): confirm the retention write with the exact line, a usage bar, and the backup"
```

---

### Task 11: 一覧の印（③a）

**Files:**
- Modify: `packages/ui/src/presenters/row.ts`
- Modify: `packages/ui/src/views/SessionRows.tsx`（`side`）
- Modify: `packages/ui/src/styles/rows.css`
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/SessionRows.test.tsx`

**Interfaces:**
- Consumes: `transcriptMark`（Task 8）、`Icon` の `transcriptGone`（Task 9）
- Produces: `SessionRowProps.transcript: 'present' | 'expiring' | 'gone' | 'none'`

- [ ] **Step 1: 落ちる試験を書く**

`presenters.test.ts` の `presentSessionRow` を確かめている箇所に足す。

```ts
it('行の本文の印は、保持期間（無ければ 30 日）で決める', () => {
  const DAY = 86_400_000;
  const s = session('a', { transcriptMtime: NOW - 25 * DAY });
  expect(presentSessionRow(s, initialStore(), NOW).transcript).toBe('expiring');
  const kept = { ...initialStore(), retention: { days: 365, source: 'user' as const, userValue: 365, writable: true, unwritableReason: null, usage: null } };
  expect(presentSessionRow(s, kept, NOW).transcript).toBe('present');
});
```

`SessionRows.test.tsx` の作り手 `row()` と `p3Row()` に `transcript: 'present'` を足し、次を足す。

```ts
it('消えかけにはチップ、消えた会話には文字の無い印を出し、行の高さは変えない', () => {
  render(<IntentRoot onIntent={vi.fn()}><SessionRows rows={[{ ...row('a'), transcript: 'expiring' }, { ...row('b'), transcript: 'gone' }, { ...row('c'), transcript: 'none' }]} height={400} variant="recent" /></IntentRoot>);
  expect(screen.getByText('まもなく削除')).toBeTruthy();
  expect(screen.getByRole('img', { name: '要約のみ。本文は Claude Code の保持期間で削除されたとみられます' })).toBeTruthy();
  expect(screen.getAllByRole('img', { name: /要約のみ/ })).toHaveLength(1);
});
```

`rows.test.ts` が行の高さの規則を読み比べていれば、`.row-soon` と `.row-gone` が高さを持たないこと（`height` を書かない）を確かめる 1 行を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/views/SessionRows.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`row.ts`:
- `SessionRowProps` に `transcript: TranscriptMark;` を足す（`export type TranscriptMark = ReturnType<typeof transcriptMark>;` を `presenters/retention.ts` に足して import する）。
- `presentSessionRow` の `row` に `transcript: transcriptMark(s, store.retention?.days ?? DEFAULT_DAYS, now),` を足す。`DEFAULT_DAYS` は `presenters/retention.ts` に `export const DEFAULT_DAYS = 30;` として足す。

`SessionRows.tsx` の `side` の `<RelativeTime ... />` の直前に次を足す。

```tsx
      {/* 本文の期限。消えかけは琥珀のチップで先に知らせ、消えた会話は文字の無い印だけにする。
          消えた会話は数百件に上るので、文字を並べると一覧が騒がしくなる。 */}
      {r.transcript === 'expiring' && <span className="row-soon">まもなく削除</span>}
      {r.transcript === 'gone' && <span className="row-gone" title={GONE_LABEL}><Icon name="transcriptGone" label={GONE_LABEL} /></span>}
```

ファイルの上に `const GONE_LABEL = '要約のみ。本文は Claude Code の保持期間で削除されたとみられます';` を置く。
（この文言は View に置く。行ごとに変わらない決まり文句で、`SessionRows` の `DEFAULT_EMPTY_TEXT` と同じ扱いである。）

`rows.css` に足す。

```css
/* 本文の期限の印。行の高さを変えないよう、右端の時刻と同じ行に小さく置く。 */
.row-soon { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: var(--r-pill); font-size: var(--fs-xs); color: var(--st-paused); background: var(--st-paused-soft); white-space: nowrap; }
.row-gone { flex: none; display: inline-flex; color: var(--ink-3); }
.row-gone .icon { width: 13px; height: 13px; }
```

（`.row-side` が縦に並ぶ作りなら、印と時刻を横に並べるため、`.row-side` の中で印と `RelativeTime` を `<span className="row-when">` で包む。`rows.test.ts` の行の高さの試験が通ることで確かめる。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): mark sessions whose transcript is about to be, or has been, deleted"
```

---

### Task 12: 開いたとき（C2）

**Files:**
- Modify: `packages/ui/src/presenters/session.ts`
- Modify: `packages/ui/src/views/SessionScreen.tsx`
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/SessionScreen.test.tsx`

**Interfaces:**
- Consumes: `transcriptMark`、`EXTEND_TO`（Task 8）
- Produces: `SessionProps.gone: { note: string; canExtend: boolean; extendTo: number } | null`

- [ ] **Step 1: 落ちる試験を書く**

`presenters.test.ts` に足す。

```ts
describe('presentSession の本文が消えた会話', () => {
  const DAY = 86_400_000;
  const gone = session('g', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 40 * DAY });
  const R = { days: 30, source: 'default' as const, userValue: null, writable: true, unwritableReason: null, usage: null };
  it('注記を出し、要約を開き、既定のままなら延ばす手を添える', () => {
    const p = presentSession(initialState(), { ...initialStore(), retention: R, sessions: { g: gone } }, NOW, 'g');
    expect(p.gone).toEqual({ note: '本文は、Claude Code の保持期間（30 日）を過ぎたため削除されたとみられます。残っているのは要約だけです。', canExtend: true, extendTo: 365 });
    expect(p.summaryOpen).toBe(true);
  });
  it('自分で値を入れた後は、延ばす手を出さない。まだ 30 日を過ぎていなければ gone は null', () => {
    expect(presentSession(initialState(), { ...initialStore(), retention: { ...R, source: 'user', userValue: 365 }, sessions: { g: gone } }, NOW, 'g').gone!.canExtend).toBe(false);
    const recent = session('r', { hasTranscript: false, transcriptMtime: null, lastActivityAt: NOW - 2 * DAY });
    expect(presentSession(initialState(), { ...initialStore(), sessions: { r: recent } }, NOW, 'r').gone).toBeNull();
  });
});
```

`SessionScreen.test.tsx` に、`gone` を渡したとき、チップ「要約のみ」と注記が出て、「保持期間を延ばす…」が `retention.edit { days: 365, from: 'session' }` を出し、「要約を作り直す」と本文の欄（`.tr-sheet`）が出ないこと、要約が無いときに「要約もありません」が出ることを確かめる試験を足す。`gone: null` の既存の試験の作り手には `gone: null` を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/views/SessionScreen.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`session.ts`:
- `SessionProps` に `gone: { note: string; canExtend: boolean; extendTo: number } | null;` を足し、`base` に `gone: null` を足す。
- 戻り値の組み立ての前に次を置き、戻り値に `gone,` を足し、`summaryOpen` を `gone ? true : view.summaryOpen` にする。

```ts
  // 保持期間で本文が消えたとみられる会話。要約しか残っていないことを、要約の上の一行で伝える。
  const r = store.retention;
  const gone = transcriptMark(s, r?.days ?? DEFAULT_DAYS, now) === 'gone'
    ? { note: `本文は、Claude Code の保持期間（${daysLabel(DEFAULT_DAYS)}）を過ぎたため削除されたとみられます。残っているのは要約だけです。`, canExtend: !!r && r.source === 'default' && r.writable, extendTo: EXTEND_TO }
    : null;
```

`SessionScreen.tsx`:
- チップの並び（`<div className="chips">`）の末尾に `{props.gone && <span className="chip">要約のみ</span>}` を足す。
- `session-facts` の `{!props.hasTranscript && <span>本文がありません</span>}` を `{!props.hasTranscript && !props.gone && <span>本文がありません</span>}` にする。
- 要約の帯（`summary`）の中で、`要約はまだありません` を `props.gone ? '要約もありません' : '要約はまだありません'` に、「要約を作り直す」のボタンを `{!props.gone && ...}` にする。
- `summary` の前に注記を置く。

```tsx
  // 本文が消えた会話では、要約の上に一行で理由を言う。既定の保持期間のままなら、その場で延ばす手を添える。
  const goneNote = props.gone && (
    <div className="note gone-note" role="note">
      {props.gone.note}
      {props.gone.canExtend && <> <button type="button" className="btn-link" onClick={() => emit({ type: 'retention.edit', days: props.gone!.extendTo, from: 'session' })}>保持期間を延ばす…</button></>}
    </div>
  );
```

- 最後の `return` の前に、消えた会話の形を足す。本文の欄とターンの目次は出さない。

```tsx
  if (props.gone) return <div className="screen">{header}{goneNote}{summary}{artifacts}</div>;
```

（`.note` と `.btn-link` は既にある名前を使う。無ければ `session.css` に `.gone-note { margin-bottom: 12px; padding: 8px 12px; border-radius: var(--r); background: var(--surface-2); color: var(--ink-2); font-size: var(--fs-sm); }` と、地と枠の無いボタンの規則を足す。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): say why a session has only its summary when its transcript was deleted"
```

---

### Task 13: 設定画面の節（D2）

**Files:**
- Modify: `packages/ui/src/presenters/settings.ts`
- Modify: `packages/ui/src/views/SettingsScreen.tsx`（「索引」の節の前）
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/screens.test.tsx`

**Interfaces:**
- Consumes: `RETENTION_CHOICES`、`daysLabel`（Task 8）、`usageBar`（Task 10）、`UsageBar`（Task 10）
- Produces:
  - `SettingsProps.retention: RetentionSettingsProps | null`
  - `type RetentionSettingsProps = { days: number; options: { value: string; label: string }[]; writable: boolean; reason: string | null; valueLabel: string; bar: UsageBarProps | null; syncNote: boolean }`

- [ ] **Step 1: 落ちる試験を書く**

`presenters.test.ts` に足す。

```ts
describe('presentSettings の会話の保持', () => {
  const R: RetentionDto = { days: 3650, source: 'user', userValue: 3650, writable: true, unwritableReason: null, usage: { bytes: 1_610_612_736, dailyBytes: 52_428_800, freeBytes: 400 * 1024 ** 3, measuredAt: NOW } };
  it('4 つの選択肢と、今の日数での見込みを出す', () => {
    const p = presentSettings(initialState(), { ...initialStore(), retention: R }, NOW).retention!;
    expect(p.options.map((o) => o.label)).toEqual(['30 日', '90 日', '1 年', '10 年']);
    expect(p.days).toBe(3650);
    expect(p.bar!.projLabel).toBe('10 年たつと約 178 GB');
  });
  it('選択肢に無い値は 5 つめとして順に並べる', () => {
    const p = presentSettings(initialState(), { ...initialStore(), retention: { ...R, days: 45, userValue: 45 } }, NOW).retention!;
    expect(p.options.map((o) => o.value)).toEqual(['30', '45', '90', '365', '3650']);
  });
  it('書けないときは理由と値だけを出す', () => {
    const p = presentSettings(initialState(), { ...initialStore(), retention: { ...R, days: 14, source: 'managed', writable: false, unwritableReason: '組織の設定で決まっています' } }, NOW).retention!;
    expect(p).toMatchObject({ writable: false, reason: '組織の設定で決まっています', valueLabel: '14 日' });
  });
  it('まだ届いていなければ null', () => {
    expect(presentSettings(initialState(), initialStore(), NOW).retention).toBeNull();
  });
});
```

`screens.test.tsx` に、設定画面に「会話の保持」の見出しが出ること、切り替えの帯で「1 年」を押すと `retention.edit { days: 365, from: 'settings' }` を出すこと、今の値と同じものを押しても何も出さないこと、書けないときは帯が無く理由が出ることを確かめる試験を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters packages/ui/src/views/screens.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`settings.ts`:

```ts
/** 会話の保持の節。押しても保存せず、確認（retention.edit）を開く。 */
export type RetentionSettingsProps = { days: number; options: { value: string; label: string }[]; writable: boolean; reason: string | null; valueLabel: string; bar: UsageBarProps | null; syncNote: boolean };
```

`SettingsProps` に `retention: RetentionSettingsProps | null;` を足し、`presentSettings` の戻り値に `retention: retentionSettings(store)` を足す。

```ts
function retentionSettings(store: Store): RetentionSettingsProps | null {
  const r = store.retention;
  if (!r) return null;
  const values = [...new Set<number>([...RETENTION_CHOICES, r.days])].sort((a, b) => a - b);
  const projected = r.usage ? r.usage.dailyBytes * r.days : null;
  return {
    days: r.days,
    options: values.map((d) => ({ value: String(d), label: daysLabel(d) })),
    writable: r.writable,
    reason: r.unwritableReason,
    valueLabel: daysLabel(r.days),
    bar: usageBar(r.usage, projected, r.days),
    syncNote: store.settings?.syncClaudeConfig ?? false,
  };
}
```

`SettingsScreen.tsx` の「索引」の `<section>` の前に足す（`Segmented` と `UsageBar` を import する）。

```tsx
      {props.retention && (
        <section>
          <h2 className="h2">会話の保持</h2>
          <div className="settings-row">
            <div className="settings-label">保持期間<div className="faint">Claude Code の cleanupPeriodDays</div></div>
            {props.retention.writable
              ? <Segmented label="保持期間" value={String(props.retention.days)} options={props.retention.options} onChange={(v) => { if (Number(v) !== props.retention!.days) emit({ type: 'retention.edit', days: Number(v), from: 'settings' }); }} />
              : <span className="muted">{props.retention.valueLabel}<span className="faint">（{props.retention.reason}）</span></span>}
          </div>
          {props.retention.bar && <UsageBar {...props.retention.bar} />}
          <div className="faint" style={{ marginTop: 4 }}>変えるときは、差分を確かめてから書き込みます。{props.retention.syncNote && '値は設定の同期でほかの PC にも届きます。'}</div>
        </section>
      )}
```

（`settings-row` と `settings-label` はこの画面で既に使っている行の名前に合わせる。）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): add a retention section to settings that opens the same confirm"
```

---

### Task 14: 設計書の書き足しと、全体の確認とビルド

**Files:**
- Modify: `docs/design.md`（原則、Settings、見た目と動き、Home、セッション詳細、Sessions）

- [ ] **Step 1: 設計書を書き足す**

- 「原則」の「読み取り専用」の例外に、spec の「原則の書き足し」の文をそのまま 4 つめとして足す。冒頭の「例外は次の 3 つだけである」を「次の 4 つだけである」に改める。
- 「Settings」の節の末尾に次の 2 文を足す。「会話の保持の節は、Claude Code の保持期間と本文の使用量を出す。書き換えるのはこの節だけで、押すと差分を見せる確認を開き、「書き込む」を押して初めて書く。」
- 「見た目と動き」のガラスを許す部品の一覧に「保持期間の帯」を足す。
- Home（骨格）、セッション詳細、Sessions の節に、spec の「帯（A2）」「開いたとき（C2）」「一覧の印（③a）」の要点を 1〜2 文ずつ移す。
- spec の冒頭の「実装が済んだら…」の段落は残す（spec は履歴として残す）。

- [ ] **Step 2: 全体の試験と型**

Run: `npm test && npm run typecheck`
Expected: PASS（失敗があれば、その出力をそのまま添えて直す）

- [ ] **Step 3: ビルド**

```bash
npm run build
npm run bundle-server -w apps/desktop
npm run tauri -w apps/desktop -- build
```

Expected: 3 つとも成功する。

- [ ] **Step 4: 実物で確かめる**

- 一時の `HANGAR_CLAUDE_DIR` を作り、`settings.json` を `cleanupPeriodDays` 無しで置く。その dir を読むサーバで UI を開き、次を確かめる。
  - 帯が出る。
  - 「保持期間を延ばす…」で差分に 1 行の add が出る。
  - 「書き込む」の後、ファイルの差分が 1 行だけになっている。
  - 控えが `~/.agent-hangar/backups/claude-config/` にできている。
  - 帯が消える。
- 利用者の本物の `~/.claude/settings.json` には書かない。
- 手元の DB で、本文ファイルが消えた会話（2026-10-01 の時点で 80 件）が、一覧で印付きになり、開くと注記が出て 404 のトーストが出ないことを確かめる。

- [ ] **Step 5: Commit**

```bash
git add docs/design.md
git commit -m "docs: record the retention notice and the fourth exception to read-only"
```
