# 初期プロンプト欄の候補と添付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新しいセッションのダイアログの初期プロンプト欄で、`/` のスキル候補、画像とファイルの添付、`@` のファイル指定を使えるようにする。

**Architecture:** サーバに読むだけの口を 2 つ（スキルの一覧、プロジェクトのファイル）と、`~/.agent-hangar/drops/` に置く・読む口を足す。UI は `PromptComposer` という部品を 1 つ作り、きっかけの判定・並べ方・文の組み立ては画面を持たない `promptComposerModel.ts` に分ける。起動の API は変えず、UI が「本文＋空行＋添付のパス」を初期プロンプトに組み立てる。

**Tech Stack:** TypeScript、Hono（サーバ）、React 19（UI）、vitest＋testing-library、Tauri 2（殻、Rust）。

**Spec:** `docs/superpowers/specs/2026-10-06-prompt-composer-design.md`

## Global Constraints

- UI は常にライト。ダークの定義を足さない。
- 画面の文言は日本語。コメントも周りに合わせて日本語で、理由を書く。
- 画面（views）は fetch を呼ばない。読み書きは `PromptAssistContext` で受け取る関数を通す（`ResolveProjectDialog` の候補と同じく、Root が api を呼ぶ）。
- `~/.claude` は読むだけ。書き込みは `~/.agent-hangar/` の下だけ。
- 添付は 1 件 20 MB まで。置き場は `<hangar home>/drops/`、名前は `<時刻>-<連番>-<直した名前>`。
- 候補に出さない組み込み：`compact`、`clear`、`copy`、`context`、`resume`、`exit`、`login`、`mcp`、`doctor`、`plugins`、`model`、`effort`。組み込みで出すのは `init`、`review`、`code-review`、`security-review`、`loop`、`schedule` だけ。
- 起動の API（`POST /api/runs`）と MCP の `create_session` は変えない。
- 新しい CSS のクラスは `pc-` で始める（`.card` と `.cards` はすでにあるので使わない）。
- 既存の試験を壊さない。各タスクの終わりに `npm run typecheck` と、触ったパッケージの試験を通す。
- tmux を使う確認では `tmux kill-server` を呼ばない。専用のソケットを `-S` で名指しする。
- 利用者の `npm run dev`（4177）をポートで止めない。
- コミットの文は英語で、周りの形（`feat(ui): ...`）に合わせ、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

1. 変換中（IME）の Enter：候補が開いていても確定に使われず、候補も入らない（Task 3）。
2. frontmatter が無い・壊れている・読めないスキル：その 1 件だけ飛ばし、ほかは出る（Task 1）。
3. 置き場の外を指す名前（`../x`、絶対パス、`%2e%2e`）：読むのも書くのも断る（Task 4）。
4. git でないフォルダ、パスの無いプロジェクト、巨大なフォルダ：空か上限つきで返り、落ちない（Task 7）。
5. 下書きを戻したときに置き場から消えていた添付：札から外れ、起動の文にも入らない（Task 5）。
6. 先頭以外の `/`（`src/a` など）と、語の途中の `@`（メールアドレスなど）：候補を出さない（Task 2）。

---

## File Structure

| ファイル | 役目 |
|---|---|
| `packages/shared/src/api.ts`（変更） | `PromptCommandDto`、`PromptCommandSource`、`DropDto` |
| `packages/server/src/prompt/frontmatter.ts`（新規） | SKILL.md とコマンドの frontmatter を読む |
| `packages/server/src/prompt/history.ts`（新規） | `history.jsonl` から最初の一言の回数を数える |
| `packages/server/src/prompt/commands.ts`（新規） | 候補の一覧を組み立てる |
| `packages/server/src/prompt/drops.ts`（新規） | 置き場に置く・読む・消す |
| `packages/server/src/prompt/files.ts`（新規） | プロジェクトのファイルを探す |
| `packages/server/src/http/app.ts`（変更） | 口を 5 つ足す |
| `packages/ui/src/views/primitives/promptComposerModel.ts`（新規） | きっかけ、並べ方、確定、文の組み立て |
| `packages/ui/src/views/primitives/PromptComposer.tsx`（新規） | 欄の箱、道具の段、候補、添付の札 |
| `packages/ui/src/views/primitives/promptAssist.ts`（新規） | `PromptAssist` の型と Context |
| `packages/ui/src/styles/controls.css`（変更） | `pc-` のスタイル |
| `packages/ui/src/runtime/api.ts`（変更） | `promptCommands`、`promptFiles`、`uploadDrop`、`existingDrops` |
| `packages/ui/src/runtime/fileDrop.ts`（変更） | `parseDrop` を外へ出す、ドラッグ中の知らせの名前 |
| `packages/ui/src/Root.tsx`（変更） | `PromptAssistContext` を配る |
| `packages/ui/src/views/NewSessionDialog.tsx`（変更） | textarea を `PromptComposer` に替える |
| `packages/ui/src/mediator/launch.ts`、`types.ts`、`packages/shared/src/intent.ts`（変更） | 下書きに添付を足す |
| `apps/desktop/src-tauri/src/filedrop.rs`、`lib.rs`（変更） | ドラッグ中の知らせ |
| `docs/design.md`（変更） | 欄の説明を足す |

---

### Task 1: スキルの一覧を返す口

**Files:**
- Modify: `packages/shared/src/api.ts`
- Create: `packages/server/src/prompt/frontmatter.ts`、`history.ts`、`commands.ts`
- Test: `packages/server/src/prompt/frontmatter.test.ts`、`history.test.ts`、`commands.test.ts`、`packages/server/src/http/app.test.ts`
- Modify: `packages/server/src/http/app.ts`

**Interfaces:**
- Produces:
  - `type PromptCommandSource = 'project' | 'user' | 'plugin' | 'builtin'`
  - `type PromptCommandDto = { name: string; description: string; argumentHint: string | null; source: PromptCommandSource; uses: number }`
  - `parseFrontmatter(text: string): Record<string, string>`
  - `firstPromptUses(file: string): Map<string, number>`
  - `listPromptCommands(o: { claudeDir: string; projectPath: string | null }): PromptCommandDto[]`
  - `GET /api/prompt/commands?projectId=` → `{ commands: PromptCommandDto[] }`

- [ ] **Step 1: 型を足す**

`packages/shared/src/api.ts` の末尾に足す。

```ts
/** 初期プロンプト欄の `/` の候補の出どころ。 */
export type PromptCommandSource = 'project' | 'user' | 'plugin' | 'builtin';
/** 初期プロンプト欄の `/` の候補。uses は、セッションの最初の一言になった回数。 */
export type PromptCommandDto = { name: string; description: string; argumentHint: string | null; source: PromptCommandSource; uses: number };
/** `~/.agent-hangar/drops/` に置いたファイル。 */
export type DropDto = { path: string; name: string; size: number };
```

- [ ] **Step 2: frontmatter の試験を書く**

`packages/server/src/prompt/frontmatter.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.ts';

describe('parseFrontmatter', () => {
  it('先頭の --- で囲んだ部分の、鍵と値を読む', () => {
    expect(parseFrontmatter('---\nname: goal\ndescription: 長く走る\nargument-hint: "[on|off]"\n---\n本文')).toEqual({ name: 'goal', description: '長く走る', 'argument-hint': '[on|off]' });
  });
  it('折り返しの値（> と |）は、字下げした行を空白でつなぐ', () => {
    expect(parseFrontmatter('---\ndescription: >-\n  一行目\n  二行目\nname: x\n---\n')).toEqual({ description: '一行目 二行目', name: 'x' });
  });
  it('frontmatter が無い、閉じていない文は、空を返す', () => {
    expect(parseFrontmatter('# 見出し\nname: x')).toEqual({});
    expect(parseFrontmatter('---\nname: x\n本文')).toEqual({});
  });
  it('値にコロンが入っていても、最初のコロンで分ける', () => {
    expect(parseFrontmatter('---\ndescription: 例: これ\n---\n')).toEqual({ description: '例: これ' });
  });
});
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/prompt/frontmatter.test.ts`
Expected: FAIL（`./frontmatter.ts` が無い）

- [ ] **Step 4: frontmatter を書く**

`packages/server/src/prompt/frontmatter.ts`

```ts
/**
 * SKILL.md とコマンドの先頭にある frontmatter を、鍵と値の文字の組で返す。
 * YAML の全部は読まない。使うのは name、description、argument-hint、user-invocable だけで、どれも 1 つの文字の値だからである。
 * 折り返しの値（> と |）は、字下げした行を空白でつなぐ。読めない行は飛ばす。
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(v)) {
      const buf: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) buf.push(lines[++i]!.trim());
      v = buf.filter(Boolean).join(' ');
    } else if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[kv[1]!] = v;
  }
  return out;
}
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/server/src/prompt/frontmatter.test.ts`
Expected: PASS（4 件）

- [ ] **Step 6: 回数の試験を書く**

`packages/server/src/prompt/history.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstPromptUses } from './history.ts';

let file: string;
const line = (sessionId: string, display: string) => JSON.stringify({ display, sessionId, timestamp: 1, project: '/p' });
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hist-')), 'history.jsonl'); });

describe('firstPromptUses', () => {
  it('セッションごとの最初の一言だけを数える', () => {
    fs.writeFileSync(file, [line('a', '/goal 速くする'), line('a', '/review'), line('b', 'こんにちは'), line('c', '/goal'), line('d', '  /superpowers:brainstorming x')].join('\n') + '\n');
    expect([...firstPromptUses(file)]).toEqual([['goal', 2], ['superpowers:brainstorming', 1]]);
  });
  it('壊れた行と sessionId の無い行は飛ばす', () => {
    fs.writeFileSync(file, ['{こわれた', JSON.stringify({ display: '/goal' }), line('a', '/toggle on')].join('\n'));
    expect([...firstPromptUses(file)]).toEqual([['toggle', 1]]);
  });
  it('ファイルが無ければ空を返す', () => {
    expect(firstPromptUses(path.join(os.tmpdir(), 'hangar-no-such-history.jsonl')).size).toBe(0);
  });
  it('ファイルが変わったら数え直す', () => {
    fs.writeFileSync(file, line('a', '/goal') + '\n');
    expect(firstPromptUses(file).get('goal')).toBe(1);
    fs.writeFileSync(file, line('a', '/goal') + '\n' + line('b', '/goal') + '\n');
    expect(firstPromptUses(file).get('goal')).toBe(2);
  });
});
```

- [ ] **Step 7: 落ちるのを見る**

Run: `npx vitest run packages/server/src/prompt/history.test.ts`
Expected: FAIL（`./history.ts` が無い）

- [ ] **Step 8: 回数を書く**

`packages/server/src/prompt/history.ts`

```ts
import fs from 'node:fs';

const cache = new Map<string, { key: string; uses: Map<string, number> }>();

/**
 * Claude Code の入力の履歴（history.jsonl）から、セッションの最初の一言になったコマンドの回数を数える。
 * 履歴は古い順に並ぶので、sessionId を初めて見た行がそのセッションの最初の一言である。
 * 途中で打つコマンド（/compact など）と区別するために、最初の一言だけを数える。
 * 読むだけで、ファイルの更新時刻と大きさが変わるまで結果を覚えておく。
 */
export function firstPromptUses(file: string): Map<string, number> {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return new Map(); }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.uses;
  const uses = new Map<string, number>();
  const seen = new Set<string>();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d: { display?: unknown; sessionId?: unknown };
    try { d = JSON.parse(line) as typeof d; } catch { continue; }
    if (typeof d?.sessionId !== 'string' || seen.has(d.sessionId)) continue;
    seen.add(d.sessionId);
    const m = /^\/([\w:.-]+)/.exec(typeof d.display === 'string' ? d.display.trim() : '');
    if (m) uses.set(m[1]!, (uses.get(m[1]!) ?? 0) + 1);
  }
  cache.set(file, { key, uses });
  return uses;
}
```

- [ ] **Step 9: 通るのを見る**

Run: `npx vitest run packages/server/src/prompt/history.test.ts`
Expected: PASS（4 件）

- [ ] **Step 10: 一覧の試験を書く**

`packages/server/src/prompt/commands.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listPromptCommands } from './commands.ts';

let claudeDir: string;
let project: string;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (root: string, dir: string, fm: string) => write(path.join(root, 'skills', dir, 'SKILL.md'), `---\n${fm}\n---\n本文\n`);
const names = (o = { claudeDir, projectPath: project as string | null }) => listPromptCommands(o).map((c) => `${c.source}:${c.name}`);

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cmd-'));
  claudeDir = path.join(tmp, 'claude');
  project = path.join(tmp, 'proj');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});

describe('listPromptCommands', () => {
  it('自分のスキルとコマンドを、説明の 1 行目と引数の形つきで返す', () => {
    skill(claudeDir, 'goal', 'name: goal\ndescription: 長く走る。二文目。');
    write(path.join(claudeDir, 'commands', 'toggle.md'), '---\ndescription: 切り替える\nargument-hint: "[on|off]"\n---\n');
    const list = listPromptCommands({ claudeDir, projectPath: null });
    expect(list.find((c) => c.name === 'goal')).toEqual({ name: 'goal', description: '長く走る。二文目。', argumentHint: null, source: 'user', uses: 0 });
    expect(list.find((c) => c.name === 'toggle')).toEqual({ name: 'toggle', description: '切り替える', argumentHint: '[on|off]', source: 'user', uses: 0 });
  });
  it('フォルダに入ったコマンドは、区切りをコロンにした名前になる', () => {
    write(path.join(claudeDir, 'commands', 'git', 'sync.md'), '---\ndescription: そろえる\n---\n');
    expect(names()).toContain('user:git:sync');
  });
  it('プロジェクトのものは project として出て、同じ名前の自分のものより先に立つ', () => {
    skill(claudeDir, 'deploy', 'name: deploy\ndescription: 自分の');
    skill(path.join(project, '.claude'), 'deploy', 'name: deploy\ndescription: プロジェクトの');
    const hit = listPromptCommands({ claudeDir, projectPath: project }).filter((c) => c.name === 'deploy');
    expect(hit).toEqual([{ name: 'deploy', description: 'プロジェクトの', argumentHint: null, source: 'project', uses: 0 }]);
  });
  it('projectPath が null なら、プロジェクトのものは読まない', () => {
    skill(path.join(project, '.claude'), 'deploy', 'name: deploy\ndescription: x');
    expect(names({ claudeDir, projectPath: null })).not.toContain('project:deploy');
  });
  it('user-invocable: false のスキルは出さない', () => {
    skill(claudeDir, 'hidden', 'name: hidden\ndescription: x\nuser-invocable: false');
    expect(names()).not.toContain('user:hidden');
  });
  it('frontmatter の無いスキルはフォルダの名前で出し、SKILL.md の無いフォルダは飛ばす', () => {
    write(path.join(claudeDir, 'skills', 'plain', 'SKILL.md'), '# 見出しだけ\n');
    fs.mkdirSync(path.join(claudeDir, 'skills', 'empty'), { recursive: true });
    expect(names()).toContain('user:plain');
    expect(names()).not.toContain('user:empty');
  });
  it('有効なプラグインのスキルを プラグイン:名前 で出し、無効なものは出さない', () => {
    const on = path.join(claudeDir, 'plugins', 'cache', 'm', 'sp', '1.0.0');
    const off = path.join(claudeDir, 'plugins', 'cache', 'm', 'off', '1.0.0');
    skill(on, 'brainstorming', 'name: brainstorming\ndescription: 詰める');
    skill(off, 'x', 'name: x\ndescription: y');
    write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'sp@m': [{ scope: 'user', installPath: on }], 'off@m': [{ scope: 'user', installPath: off }] } }));
    write(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'sp@m': true, 'off@m': false } }));
    expect(names()).toContain('plugin:sp:brainstorming');
    expect(names()).not.toContain('plugin:off:x');
  });
  it('組み込みは決めた 6 つだけを出す', () => {
    expect(names().filter((n) => n.startsWith('builtin:')).sort()).toEqual(['builtin:code-review', 'builtin:init', 'builtin:loop', 'builtin:review', 'builtin:schedule', 'builtin:security-review']);
  });
  it('回数は history.jsonl の最初の一言から取る', () => {
    skill(claudeDir, 'goal', 'name: goal\ndescription: x');
    fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), [JSON.stringify({ display: '/goal a', sessionId: 's1' }), JSON.stringify({ display: '/goal b', sessionId: 's2' })].join('\n'));
    expect(listPromptCommands({ claudeDir, projectPath: null }).find((c) => c.name === 'goal')?.uses).toBe(2);
  });
  it('壊れた installed_plugins.json や settings.json があっても、ほかは出る', () => {
    skill(claudeDir, 'goal', 'name: goal\ndescription: x');
    write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), '{こわれた');
    write(path.join(claudeDir, 'settings.json'), '{こわれた');
    expect(names()).toContain('user:goal');
  });
});
```

- [ ] **Step 11: 落ちるのを見る**

Run: `npx vitest run packages/server/src/prompt/commands.test.ts`
Expected: FAIL（`./commands.ts` が無い）

- [ ] **Step 12: 一覧を書く**

`packages/server/src/prompt/commands.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { PromptCommandDto, PromptCommandSource } from '@agent-hangar/shared';
import { parseFrontmatter } from './frontmatter.ts';
import { firstPromptUses } from './history.ts';

/**
 * 組み込みのうち、最初の一言になるもの。ファイルから読めないので手で持つ。
 * 会話の途中でしか意味がないもの（compact、clear、copy など）、端末の設定のもの（login、mcp など）、
 * ダイアログの詳細に欄がある model と effort は入れない（docs/superpowers/specs/2026-10-06-prompt-composer-design.md）。
 */
const BUILTIN: { name: string; description: string; argumentHint: string | null }[] = [
  { name: 'init', description: 'CLAUDE.md を作ってコードベースを説明させる', argumentHint: null },
  { name: 'review', description: 'プルリクエストを審査する', argumentHint: '[PR 番号]' },
  { name: 'code-review', description: 'いまの差分の誤りを探す', argumentHint: '[low|medium|high]' },
  { name: 'security-review', description: 'ブランチの変更の安全性を審査する', argumentHint: null },
  { name: 'loop', description: '指示を一定の間隔で繰り返す', argumentHint: '[間隔] <指示>' },
  { name: 'schedule', description: '決まった時刻に動くクラウドのエージェントを作る', argumentHint: null },
];

type Found = Omit<PromptCommandDto, 'uses'>;

const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file: string): unknown => { const t = readText(file); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
const entries = (dir: string): fs.Dirent[] => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
// リンクの先がフォルダかどうかは Dirent では分からないので、stat で見る（~/.claude/skills の下はリンクのことがある）。
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** 1 つの文書を候補にする。読めなければ null。説明は 1 行目だけにする。 */
function fromDoc(file: string, fallbackName: string, source: PromptCommandSource, prefix: string, nameFromFile: boolean): Found | null {
  const text = readText(file);
  if (text === null) return null;
  const fm = parseFrontmatter(text);
  if (fm['user-invocable'] === 'false') return null;
  const base = nameFromFile ? fallbackName : fm.name || fallbackName;
  return { name: prefix + base, description: (fm.description ?? '').split('\n')[0]!.trim(), argumentHint: fm['argument-hint'] || null, source };
}

function skillsIn(dir: string, source: PromptCommandSource, prefix = ''): Found[] {
  const out: Found[] = [];
  for (const e of entries(dir)) {
    const p = path.join(dir, e.name);
    if (!isDir(p)) continue;
    const c = fromDoc(path.join(p, 'SKILL.md'), e.name, source, prefix, false);
    if (c) out.push(c);
  }
  return out;
}

/** コマンドはファイルの名前がそのまま名前になる。フォルダに入ったものは、区切りをコロンにする。 */
function commandsIn(dir: string, source: PromptCommandSource, prefix = '', depth = 0): Found[] {
  const out: Found[] = [];
  if (depth > 4) return out;
  for (const e of entries(dir)) {
    const p = path.join(dir, e.name);
    if (isDir(p)) { out.push(...commandsIn(p, source, `${prefix}${e.name}:`, depth + 1)); continue; }
    if (!e.name.endsWith('.md')) continue;
    const c = fromDoc(p, e.name.slice(0, -3), source, prefix, true);
    if (c) out.push(c);
  }
  return out;
}

/** 有効なプラグインの置き場。enabledPlugins があれば true のものだけ、無ければ入っているもの全部。 */
function pluginRoots(claudeDir: string): { plugin: string; root: string }[] {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, { installPath?: unknown }[]> } | null;
  const settings = readJson(path.join(claudeDir, 'settings.json')) as { enabledPlugins?: Record<string, unknown> } | null;
  const enabled = settings?.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : null;
  const out: { plugin: string; root: string }[] = [];
  if (!installed?.plugins || typeof installed.plugins !== 'object') return out;
  for (const [key, list] of Object.entries(installed.plugins)) {
    if (enabled && enabled[key] !== true) continue;
    const last = Array.isArray(list) ? list[list.length - 1] : null;
    if (typeof last?.installPath === 'string') out.push({ plugin: key.split('@')[0]!, root: last.installPath });
  }
  return out;
}

/**
 * 初期プロンプト欄の `/` の候補。読むだけで、何も書かない。
 * 同じ名前は、プロジェクト、自分の、プラグイン、組み込みの順で先のものを残す。
 */
export function listPromptCommands(o: { claudeDir: string; projectPath: string | null }): PromptCommandDto[] {
  const found: Found[] = [];
  if (o.projectPath) {
    const root = path.join(o.projectPath, '.claude');
    found.push(...skillsIn(path.join(root, 'skills'), 'project'), ...commandsIn(path.join(root, 'commands'), 'project'));
  }
  found.push(...skillsIn(path.join(o.claudeDir, 'skills'), 'user'), ...commandsIn(path.join(o.claudeDir, 'commands'), 'user'));
  for (const { plugin, root } of pluginRoots(o.claudeDir)) {
    found.push(...skillsIn(path.join(root, 'skills'), 'plugin', `${plugin}:`), ...commandsIn(path.join(root, 'commands'), 'plugin', `${plugin}:`));
  }
  found.push(...BUILTIN.map((b) => ({ ...b, source: 'builtin' as const })));
  const uses = firstPromptUses(path.join(o.claudeDir, 'history.jsonl'));
  const seen = new Set<string>();
  const out: PromptCommandDto[] = [];
  for (const c of found) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ ...c, uses: uses.get(c.name) ?? 0 });
  }
  return out;
}
```

- [ ] **Step 13: 通るのを見る**

Run: `npx vitest run packages/server/src/prompt`
Expected: PASS（frontmatter 4、history 4、commands 10）

- [ ] **Step 14: 口の試験を書く**

`packages/server/src/http/app.test.ts` の末尾の `describe` の外に、新しい `describe` を足す。`get`、`json`、`deps`、`list0ProjectId` はこのファイルの既存のものを使う。

```ts
describe('GET /api/prompt/commands', () => {
  it('読み取り元のスキルと組み込みを返す', async () => {
    const dir = path.join(deps.settings().claudeDir, 'skills', 'demo-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 試し\n---\n');
    const r = await json(await get('/api/prompt/commands'));
    expect(r.status).toBe(200);
    const list = (r.body as { commands: { name: string; source: string }[] }).commands;
    expect(list).toContainEqual(expect.objectContaining({ name: 'demo-skill', source: 'user', description: '試し' }));
    expect(list).toContainEqual(expect.objectContaining({ name: 'init', source: 'builtin' }));
  });
  it('projectId を渡すと、そのプロジェクトの .claude の下も読む', async () => {
    const id = list0ProjectId();
    const p = (await json(await get(`/api/projects/${id}`))).body as { path: string };
    const dir = path.join(p.path, '.claude', 'skills', 'proj-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: proj-skill\ndescription: x\n---\n');
    const r = await json(await get(`/api/prompt/commands?projectId=${id}`));
    expect((r.body as { commands: { name: string; source: string }[] }).commands).toContainEqual(expect.objectContaining({ name: 'proj-skill', source: 'project' }));
  });
  it('知らない projectId は 404', async () => {
    expect((await get('/api/prompt/commands?projectId=nope')).status).toBe(404);
  });
  it('トークンが無ければ 401', async () => {
    expect((await get('/api/prompt/commands', {})).status).toBe(401);
  });
});
```

- [ ] **Step 15: 落ちるのを見る**

Run: `npx vitest run packages/server/src/http/app.test.ts -t 'prompt/commands'`
Expected: FAIL（404）

- [ ] **Step 16: 口を足す**

`packages/server/src/http/app.ts` の import に足す。

```ts
import { listPromptCommands } from '../prompt/commands.ts';
```

`api.get('/projects/:id/candidates', ...)` の行の直後に足す。

```ts
  // 初期プロンプト欄の `/` の候補。projectId が無ければ（スクラッチなど）、プロジェクトのものは読まない。
  api.get('/prompt/commands', (c) => {
    const id = c.req.query('projectId');
    const project = id ? requireProject(id) : null;
    if (id && !project) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    return c.json({ commands: listPromptCommands({ claudeDir: deps.settings().claudeDir, projectPath: project?.path ?? null }) });
  });
```

- [ ] **Step 17: 通るのを見て、型も確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts packages/server/src/prompt && npm run typecheck`
Expected: PASS、型の誤りなし

- [ ] **Step 18: コミット**

```bash
git add packages/shared/src/api.ts packages/server/src/prompt packages/server/src/http/app.ts packages/server/src/http/app.test.ts
git commit -m "feat(server): list skills and commands for the initial prompt field"
```

---

### Task 2: きっかけ・並べ方・確定の関数

**Files:**
- Create: `packages/ui/src/views/primitives/promptComposerModel.ts`
- Test: `packages/ui/src/views/primitives/promptComposerModel.test.ts`

**Interfaces:**
- Consumes: `PromptCommandDto`（Task 1）
- Produces:
  - `type Trigger = { kind: '/' | '@'; query: string; start: number }`
  - `triggerAt(text: string, caret: number): Trigger | null`
  - `type CommandSection = { title: string | null; items: PromptCommandDto[] }`
  - `arrangeCommands(commands: PromptCommandDto[], query: string): CommandSection[]`
  - `SOURCE_LABEL: Record<PromptCommandSource, string>`
  - `acceptText(text: string, caret: number, trigger: Trigger, value: string): { text: string; caret: number }`

- [ ] **Step 1: 試験を書く**

`packages/ui/src/views/primitives/promptComposerModel.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { PromptCommandDto } from '@agent-hangar/shared';
import { acceptText, arrangeCommands, triggerAt } from './promptComposerModel.ts';

const cmd = (name: string, source: PromptCommandDto['source'] = 'user', uses = 0, description = ''): PromptCommandDto => ({ name, description, argumentHint: null, source, uses });

describe('triggerAt', () => {
  it('先頭の / から空白までの語にカーソルがあれば、/ のきっかけになる', () => {
    expect(triggerAt('/', 1)).toEqual({ kind: '/', query: '', start: 0 });
    expect(triggerAt('/go', 3)).toEqual({ kind: '/', query: 'go', start: 0 });
    expect(triggerAt('/goal 速く', 2)).toEqual({ kind: '/', query: 'g', start: 0 });
  });
  it('語を過ぎたら / のきっかけではない', () => {
    expect(triggerAt('/goal 速く', 6)).toBeNull();
    expect(triggerAt('/goal\n', 6)).toBeNull();
  });
  it('先頭でない / は、きっかけにしない', () => {
    expect(triggerAt('src/a', 5)).toBeNull();
    expect(triggerAt(' /goal', 6)).toBeNull();
    expect(triggerAt('見て\n/goal', 8)).toBeNull();
  });
  it('先頭か空白の直後の @ は、@ のきっかけになる', () => {
    expect(triggerAt('@', 1)).toEqual({ kind: '@', query: '', start: 0 });
    expect(triggerAt('見て @src/a', 9)).toEqual({ kind: '@', query: 'src/a', start: 3 });
    expect(triggerAt('一行目\n@ab', 7)).toEqual({ kind: '@', query: 'ab', start: 4 });
  });
  it('語の途中の @（メールアドレスなど）は、きっかけにしない', () => {
    expect(triggerAt('a@b.com', 7)).toBeNull();
  });
  it('@ の語を過ぎたら、きっかけではない', () => {
    expect(triggerAt('@src/a を見て', 7)).toBeNull();
  });
  it('/ の語の中でも、@ より / を先に見る', () => {
    expect(triggerAt('/a@b', 4)).toEqual({ kind: '/', query: 'a@b', start: 0 });
  });
});

describe('arrangeCommands', () => {
  const all = [cmd('alpha', 'user', 0), cmd('goal', 'user', 27), cmd('find-session', 'user', 42), cmd('init', 'builtin', 4), cmd('deploy', 'project', 0), cmd('sp:plan', 'plugin', 0), cmd('toggle', 'user', 10), cmd('review', 'builtin', 5), cmd('playwright', 'user', 4), cmd('grill', 'user', 3)];
  it('打つ前は、よく使う 5 つを先頭に、このプロジェクト、自分の、プラグイン、組み込みの順の群にする', () => {
    const s = arrangeCommands(all, '');
    // 組み込みの init と review は「よく使う」に入ったので、組み込みの群は空になり、出ない。
    expect(s.map((x) => x.title)).toEqual(['よく使う', 'このプロジェクト', '自分の', 'プラグイン']);
    expect(s[0]!.items.map((c) => c.name)).toEqual(['find-session', 'goal', 'toggle', 'review', 'init']);
    expect(s[2]!.items.map((c) => c.name)).toEqual(['alpha', 'playwright', 'grill']);
  });
  it('回数が同じなら、もとの並びを保つ', () => {
    expect(arrangeCommands([cmd('a', 'user', 4), cmd('b', 'user', 4)], '')[0]!.items.map((c) => c.name)).toEqual(['a', 'b']);
  });
  it('回数が 0 のものは、よく使うに入れない。空の群は出さない', () => {
    const s = arrangeCommands([cmd('a'), cmd('b', 'builtin')], '');
    expect(s.map((x) => x.title)).toEqual(['自分の', '組み込み']);
  });
  it('打ったら群を解き、名前の頭、名前の途中、説明の順に並べ、同じなら回数の多い順にする', () => {
    const list = [cmd('code-review', 'builtin', 0), cmd('review', 'builtin', 5), cmd('rewind', 'user', 9), cmd('x', 'user', 0, 'review を助ける')];
    const s = arrangeCommands(list, 're');
    expect(s).toHaveLength(1);
    expect(s[0]!.title).toBeNull();
    expect(s[0]!.items.map((c) => c.name)).toEqual(['rewind', 'review', 'code-review', 'x']);
  });
  it('大文字と小文字を区別しない。一致が無ければ空を返す', () => {
    expect(arrangeCommands([cmd('Goal')], 'GO')[0]!.items.map((c) => c.name)).toEqual(['Goal']);
    expect(arrangeCommands([cmd('goal')], 'zzz')).toEqual([]);
  });
});

describe('acceptText', () => {
  it('/ の語を、選んだ名前と空白 1 つに置き換える', () => {
    expect(acceptText('/go', 3, { kind: '/', query: 'go', start: 0 }, 'goal')).toEqual({ text: '/goal ', caret: 6 });
  });
  it('語の途中にカーソルがあっても、語の末尾まで置き換える', () => {
    expect(acceptText('/goxx 速く', 3, { kind: '/', query: 'go', start: 0 }, 'goal')).toEqual({ text: '/goal 速く', caret: 6 });
  });
  it('@ の語を、選んだパスと空白 1 つに置き換える', () => {
    expect(acceptText('見て @sr', 6, { kind: '@', query: 'sr', start: 3 }, 'src/a.ts')).toEqual({ text: '見て @src/a.ts ', caret: 13 });
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/promptComposerModel.test.ts`
Expected: FAIL（`./promptComposerModel.ts` が無い）

- [ ] **Step 3: 関数を書く**

`packages/ui/src/views/primitives/promptComposerModel.ts`

```ts
import type { PromptCommandDto, PromptCommandSource } from '@agent-hangar/shared';

/** 候補を出すきっかけ。start は、きっかけの記号（/ か @）の位置。 */
export type Trigger = { kind: '/' | '@'; query: string; start: number };

/**
 * カーソルの位置で、候補を出すきっかけがあるかを見る。
 * / は欄の先頭だけ。Claude Code がコマンドとして読むのは先頭だけだからである。
 * @ は先頭か空白の直後だけ。語の途中の @（メールアドレスなど）で候補を出さないためである。
 * どちらも、記号から空白までの語にカーソルがある間だけきっかけになる。
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: '/', query: slash[1]!, start: 0 };
  const at = /(?:^|\s)@(\S*)$/.exec(before);
  if (at) return { kind: '@', query: at[1]!, start: before.length - at[1]!.length - 1 };
  return null;
}

export const SOURCE_LABEL: Record<PromptCommandSource, string> = { project: 'プロジェクト', user: '自分の', plugin: 'プラグイン', builtin: '組み込み' };
const GROUP_TITLE: Record<PromptCommandSource, string> = { project: 'このプロジェクト', user: '自分の', plugin: 'プラグイン', builtin: '組み込み' };
const GROUP_ORDER: PromptCommandSource[] = ['project', 'user', 'plugin', 'builtin'];
/** 「よく使う」に置く件数。 */
export const FREQUENT_COUNT = 5;

export type CommandSection = { title: string | null; items: PromptCommandDto[] };

/**
 * 候補を並べる。
 * 打つ前は群にする。自分では打たないスキルが多いので、最初の一言になった回数の多いものを先頭の「よく使う」に出す。
 * 打ったら群を解く。一致した行が群ごとに散らばると、探し直すことになるためである（Listbox と同じ）。
 */
export function arrangeCommands(commands: PromptCommandDto[], query: string): CommandSection[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    // sort は安定なので、回数が同じものはもとの並びを保つ。
    const frequent = commands.filter((c) => c.uses > 0).sort((a, b) => b.uses - a.uses).slice(0, FREQUENT_COUNT);
    const taken = new Set(frequent.map((c) => c.name));
    const sections: CommandSection[] = [{ title: 'よく使う', items: frequent }, ...GROUP_ORDER.map((s) => ({ title: GROUP_TITLE[s], items: commands.filter((c) => c.source === s && !taken.has(c.name)) }))];
    return sections.filter((s) => s.items.length > 0);
  }
  const rank = (c: PromptCommandDto): number => { const n = c.name.toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : 3; };
  const hit = commands.map((c) => ({ c, r: rank(c) })).filter((x) => x.r < 3).sort((a, b) => a.r - b.r || b.c.uses - a.c.uses).map((x) => x.c);
  return hit.length ? [{ title: null, items: hit }] : [];
}

/** 候補を確定したときの文とカーソル。きっかけの語を末尾まで置き換え、後ろに空白を 1 つ置く。 */
export function acceptText(text: string, caret: number, trigger: Trigger, value: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  // カーソルが語の途中にあるときは、語の残りも置き換える。
  const tail = rest.replace(/^\S*/, '');
  const head = `${text.slice(0, trigger.start)}${trigger.kind}${value}`;
  const sep = tail.startsWith(' ') ? '' : ' ';
  const next = head + sep + tail;
  return { text: next, caret: head.length + 1 };
}
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/promptComposerModel.test.ts`
Expected: PASS（15 件）

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views/primitives/promptComposerModel.ts packages/ui/src/views/primitives/promptComposerModel.test.ts
git commit -m "feat(ui): detect prompt triggers and rank skill suggestions"
```

---

### Task 3: PromptComposer（`/` の候補と道具の段）

**Files:**
- Create: `packages/ui/src/views/primitives/promptAssist.ts`、`packages/ui/src/views/primitives/PromptComposer.tsx`
- Test: `packages/ui/src/views/primitives/PromptComposer.test.tsx`
- Modify: `packages/ui/src/runtime/api.ts`、`packages/ui/src/test/fakeApi.ts`、`packages/ui/src/Root.tsx`、`packages/ui/src/views/NewSessionDialog.tsx`、`packages/ui/src/styles/controls.css`

**Interfaces:**
- Consumes: `triggerAt`、`arrangeCommands`、`acceptText`、`SOURCE_LABEL`（Task 2）、`highlight`、`place`（`listboxModel.ts`）、`isComposing`（`views/ime.ts`）
- Produces:
  - `type PromptAssist = { commands(projectId: string | null): Promise<PromptCommandDto[]>; files(projectId: string, query: string): Promise<string[]>; upload(file: File): Promise<DropDto>; existing(paths: string[]): Promise<string[]>; notify(message: string): void }`
  - `PromptAssistContext`（既定は何も返さない `NO_ASSIST`）
  - `<PromptComposer id value onChange projectId />`（Task 5 で `attachments`、`onAttachmentsChange` を、Task 8 で `fileMentions` を足す）
  - `ApiClient.promptCommands(projectId: string | null): Promise<PromptCommandDto[]>`

- [ ] **Step 1: 先に読む**

`packages/ui/src/views/primitives/Listbox.tsx` を通して読む。候補の一覧は、この部品の次の 3 点をそのまま真似る。

1. `createPortal(..., document.body)` で `.dialog` の外に出す（ダイアログは `backdrop-filter` を持つので、中に置いた `position: fixed` はダイアログ基準になってしまう）。
2. `place()` で置き場所を決め、`resize` と `scroll`（capture）で置き直す。
3. 選んでいる行を `scrollIntoView?.({ block: 'nearest' })` で見える所へ出す。

`packages/ui/src/views/NewSessionDialog.test.tsx` の先頭も読み、tsx の試験が jsdom で動く設定（`vitest.config.ts`）と、`IntentRoot` での包み方を確かめる。

- [ ] **Step 2: PromptAssist を書く**

`packages/ui/src/views/primitives/promptAssist.ts`

```ts
import { createContext } from 'react';
import type { DropDto, PromptCommandDto } from '@agent-hangar/shared';

/**
 * 初期プロンプト欄がサーバに頼むこと。画面は fetch を呼ばないので、Root が api をつないで Context で配る。
 * notify は右下の知らせを出す。
 */
export type PromptAssist = {
  commands(projectId: string | null): Promise<PromptCommandDto[]>;
  files(projectId: string, query: string): Promise<string[]>;
  upload(file: File): Promise<DropDto>;
  existing(paths: string[]): Promise<string[]>;
  notify(message: string): void;
};

/** Context が無い場所（部品だけの試験など）で使う、何も返さない既定。 */
export const NO_ASSIST: PromptAssist = {
  commands: () => Promise.resolve([]),
  files: () => Promise.resolve([]),
  upload: () => Promise.reject(new Error('添付は使えません')),
  existing: (paths) => Promise.resolve(paths),
  notify: () => {},
};

export const PromptAssistContext = createContext<PromptAssist>(NO_ASSIST);
```

- [ ] **Step 3: 部品の試験を書く**

`packages/ui/src/views/primitives/PromptComposer.test.tsx`（先頭の環境の指定は `NewSessionDialog.test.tsx` に合わせる）

```tsx
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PromptCommandDto } from '@agent-hangar/shared';
import { NO_ASSIST, PromptAssistContext, type PromptAssist } from './promptAssist.ts';
import { PromptComposer } from './PromptComposer.tsx';

const cmd = (name: string, uses = 0, source: PromptCommandDto['source'] = 'user', argumentHint: string | null = null): PromptCommandDto => ({ name, description: `${name} の説明`, argumentHint, source, uses });
const COMMANDS = [cmd('goal', 27, 'user', '<ゴール>'), cmd('find-session', 42), cmd('init', 0, 'builtin'), cmd('grill', 0)];

function Host(props: { projectId?: string | null; onValue?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return <PromptComposer id="p" value={value} onChange={(v) => { setValue(v); props.onValue?.(v); }} projectId={props.projectId ?? null} />;
}
async function mount(assist: Partial<PromptAssist> = {}, host: Parameters<typeof Host>[0] = {}) {
  const full: PromptAssist = { ...NO_ASSIST, commands: vi.fn(() => Promise.resolve(COMMANDS)), ...assist };
  const onKeyDown = vi.fn();
  render(<PromptAssistContext.Provider value={full}><div onKeyDown={onKeyDown}><label htmlFor="p">初期プロンプト（任意）</label><Host {...host} /></div></PromptAssistContext.Provider>);
  await act(async () => {});
  return { assist: full, outerKeyDown: onKeyDown, ta: screen.getByLabelText('初期プロンプト（任意）') as HTMLTextAreaElement };
}
const type = (ta: HTMLTextAreaElement, value: string) => { fireEvent.focus(ta); fireEvent.change(ta, { target: { value, selectionStart: value.length, selectionEnd: value.length } }); };
const options = () => screen.queryAllByRole('option').map((o) => o.getAttribute('data-value'));

describe('PromptComposer の / の候補', () => {
  it('開いたときに、選んだプロジェクトの候補を読む', async () => {
    const { assist } = await mount({}, { projectId: 'p1' });
    expect(assist.commands).toHaveBeenCalledWith('p1');
  });
  it('先頭で / を打つと、よく使うものを先頭にした候補が出る', async () => {
    const { ta } = await mount();
    type(ta, '/');
    expect(within(screen.getByRole('group', { name: 'よく使う' })).getAllByRole('option').map((o) => o.getAttribute('data-value'))).toEqual(['find-session', 'goal']);
    expect(screen.getByRole('option', { name: /\/goal/ })).toHaveTextContent('<ゴール>');
    expect(screen.getByRole('option', { name: /\/goal/ })).toHaveTextContent('goal の説明');
  });
  it('打ち進めると絞り込む。一致が無ければ、その旨を出す', async () => {
    const { ta } = await mount();
    type(ta, '/g');
    expect(options()).toEqual(['goal', 'grill']);
    type(ta, '/zzz');
    expect(screen.getByText('一致するものはありません')).toBeInTheDocument();
  });
  it('↓ で選び、Enter で入れて、候補を閉じる', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith('/grill ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('Tab でも入る。行を押しても入る', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onValue).toHaveBeenLastCalledWith('/goal ');
    type(ta, '/gr');
    fireEvent.mouseDown(screen.getByRole('option', { name: /\/grill/ }));
    expect(onValue).toHaveBeenLastCalledWith('/grill ');
  });
  it('Esc は候補だけを閉じ、外へ伝えない。同じ語では開き直さず、打ち進めたら開く', async () => {
    const { ta, outerKeyDown } = await mount();
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outerKeyDown).not.toHaveBeenCalled();
    fireEvent.keyUp(ta, { key: 'Shift' });
    expect(screen.queryByRole('listbox')).toBeNull();
    type(ta, '/go');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('変換中の Enter では入れない', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(onValue).toHaveBeenLastCalledWith('/g');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('候補が閉じている間の Enter と Esc は、外へ伝える', async () => {
    const { ta, outerKeyDown } = await mount();
    type(ta, 'こんにちは');
    fireEvent.keyDown(ta, { key: 'Escape' });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(outerKeyDown).toHaveBeenCalledTimes(2);
  });
  it('先頭でない / では出さない', async () => {
    const { ta } = await mount();
    type(ta, 'src/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('道具の段の「スキル」を押すと、先頭に / を入れて候補を開く', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '速くする');
    fireEvent.click(screen.getByRole('button', { name: 'スキル' }));
    expect(onValue).toHaveBeenLastCalledWith('/速くする');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('候補が読めなければ、候補の中にその旨を出し、欄は打てる', async () => {
    const { ta } = await mount({ commands: () => Promise.reject(new Error('x')) });
    type(ta, '/');
    expect(screen.getByText('読めませんでした')).toBeInTheDocument();
    type(ta, '/goal やる');
    expect(ta.value).toBe('/goal やる');
  });
});
```

- [ ] **Step 4: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/PromptComposer.test.tsx`
Expected: FAIL（`./PromptComposer.tsx` が無い）

- [ ] **Step 5: 部品を書く**

`packages/ui/src/views/primitives/PromptComposer.tsx`

```tsx
import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PromptCommandDto } from '@agent-hangar/shared';
import { isComposing } from '../ime.ts';
import { Icon } from './Icon.tsx';
import { highlight, place, type Placement } from './listboxModel.ts';
import { PromptAssistContext } from './promptAssist.ts';
import { acceptText, arrangeCommands, SOURCE_LABEL, triggerAt, type Trigger } from './promptComposerModel.ts';

/** 欄が伸びる高さの上限（px）。超えたら中で送る。 */
const MAX_HEIGHT = 240;
const keyOf = (t: Trigger) => `${t.kind}${t.start}:${t.query}`;

function Marked(props: { text: string; query: string }) {
  return <>{highlight(props.text, props.query).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}</>;
}

/**
 * 初期プロンプトの欄。先頭の / でスキルとコマンドの候補を出す。
 * 候補が開いている間だけ、↑↓・Enter・Tab・Esc をここで受けて外へ伝えない。
 * 閉じている間の打鍵は外（起動ダイアログ）へそのまま流す。Enter の改行と ⌘Enter の起動を変えないためである。
 * 候補はダイアログの外（body）に描く。ダイアログは backdrop-filter を持ち、中の fixed はダイアログ基準になるからである（Listbox と同じ）。
 */
export function PromptComposer(props: { id: string; value: string; onChange: (value: string) => void; projectId: string | null }) {
  const assist = useContext(PromptAssistContext);
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [commands, setCommands] = useState<PromptCommandDto[] | 'failed' | null>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // Esc で閉じたきっかけ。同じ語のままなら開き直さない。
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Placement | null>(null);
  // 確定の後に置くカーソルの位置。値が描かれてから置く。
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setCommands(null);
    assist.commands(props.projectId).then((c) => { if (live) setCommands(c); }, () => { if (live) setCommands('failed'); });
    return () => { live = false; };
  }, [assist, props.projectId]);

  const trigger = focused ? triggerAt(props.value, caret) : null;
  const open = trigger !== null && trigger.kind === '/' && dismissed !== keyOf(trigger);
  const sections = open && Array.isArray(commands) ? arrangeCommands(commands, trigger.query) : [];
  const flat = sections.flatMap((s) => s.items);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  const syncCaret = () => { const el = ta.current; if (el) setCaret(el.selectionStart ?? el.value.length); };

  // 行数に合わせて伸ばす。上限を超えたら中で送る。
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [props.value]);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !ta.current) return;
    pendingCaret.current = null;
    ta.current.setSelectionRange(at, at);
    setCaret(at);
  }, [props.value]);

  const reposition = () => {
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    setPos(place({ top: b.top, bottom: b.bottom, left: b.left, width: b.width }, pop.current?.offsetHeight ?? 0, { width: window.innerWidth, height: window.innerHeight }));
  };
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
    // 行の数が変わると高さが変わるので、置き直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flat.length, props.value]);

  useEffect(() => { setActive(0); }, [trigger?.kind, trigger?.query]);
  useEffect(() => {
    if (open) pop.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, current]);

  const accept = (name: string) => {
    if (!trigger) return;
    const next = acceptText(props.value, caret, trigger, name);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    props.onChange(next.text);
    ta.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (isComposing(e)) {
      // 変換の確定と取り消しは IME に任せるが、外（起動ダイアログの Esc と Enter）へは漏らさない。
      if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
      return;
    }
    const n = flat.length;
    switch (e.key) {
      case 'ArrowDown': if (n) setActive((current + 1) % n); break;
      case 'ArrowUp': if (n) setActive((current - 1 + n) % n); break;
      case 'Enter':
        // ⌘Enter は起動なので、候補が開いていても外へ流す。
        if (e.metaKey || e.ctrlKey) return;
        if (!n) return;
        accept(flat[current]!.name);
        break;
      case 'Tab': if (!n) return; accept(flat[current]!.name); break;
      case 'Escape': setDismissed(keyOf(trigger!)); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const startSlash = () => {
    const el = ta.current;
    if (!el) return;
    const next = props.value.startsWith('/') ? props.value : `/${props.value}`;
    pendingCaret.current = 1;
    setCaret(1);
    setDismissed(null);
    setFocused(true);
    if (next !== props.value) props.onChange(next); else el.setSelectionRange(1, 1);
    el.focus();
  };

  const listId = `${props.id}-suggest`;
  let index = 0;
  return (
    <div ref={box} className="pc-box">
      <textarea
        ref={ta} id={props.id} className="pc-input" rows={4} value={props.value}
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && flat.length ? `${listId}-${current}` : undefined}
        onChange={(e) => { setCaret(e.target.selectionStart ?? e.target.value.length); props.onChange(e.target.value); }}
        onSelect={syncCaret} onKeyUp={syncCaret} onClick={syncCaret}
        onFocus={() => { setFocused(true); syncCaret(); }} onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      <div className="pc-tools">
        <button type="button" className="pc-tool" onMouseDown={(e) => e.preventDefault()} onClick={startSlash}><span className="pc-tool-key" aria-hidden="true">/</span>スキル</button>
      </div>
      {open && createPortal(
        <div ref={pop} className="listbox-pop pc-pop" data-up={pos?.up ? 'true' : undefined}
          style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden' }}>
          <div id={listId} role="listbox" aria-label="スキルとコマンド" className="listbox-rows">
            {commands === null && <div className="listbox-empty">読み込んでいます</div>}
            {commands === 'failed' && <div className="listbox-empty">読めませんでした</div>}
            {Array.isArray(commands) && !flat.length && <div className="listbox-empty">一致するものはありません</div>}
            {sections.map((s, si) => (
              <div key={s.title ?? 'hit'} role={s.title ? 'group' : undefined} aria-labelledby={s.title ? `${listId}-g${si}` : undefined}>
                {s.title && <div id={`${listId}-g${si}`} className="listbox-group-title">{s.title}</div>}
                {s.items.map((c) => {
                  const i = index++;
                  return (
                    // 欄のフォーカスを奪わないよう、押した時点で確定する。
                    <div key={c.name} id={`${listId}-${i}`} role="option" aria-selected={i === current} aria-label={`/${c.name}`} data-value={c.name} data-active={i === current ? 'true' : undefined}
                      className="listbox-opt" onMouseDown={(e) => { e.preventDefault(); accept(c.name); }} onMouseMove={() => { if (i !== current) setActive(i); }}>
                      <span className="listbox-opt-main">
                        <span className="pc-cmd">/<Marked text={c.name} query={trigger!.query} />{c.argumentHint && <span className="pc-arg">{c.argumentHint}</span>}</span>
                        {c.description && <small data-kind="prose" className="pc-desc">{c.description}</small>}
                      </span>
                      <span className="pc-src" data-source={c.source}>{SOURCE_LABEL[c.source]}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
```

`Icon` はこのタスクではまだ使わない。import して使っていなければ外す（Task 5 で添付ボタンに使う）。`.listbox-empty` が無ければ `controls.css` の Listbox の節を見て、同じ見た目のクラスを使う。

- [ ] **Step 6: 通るのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/PromptComposer.test.tsx`
Expected: PASS（11 件）。`role="combobox"` を付けたことで `getByLabelText` が取れなくなる場合は、試験の取り方ではなく部品の側を直す（label の `htmlFor` は textarea の id を指している）。

- [ ] **Step 7: スタイルを足す**

`packages/ui/src/styles/controls.css` の Listbox の節の後に足す。

```css
/* 初期プロンプトの欄（PromptComposer）。枠は箱が持ち、中の textarea は枠なしにする。 */
.pc-box { position: relative; display: flex; flex-direction: column; border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.pc-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.pc-input { display: block; width: 100%; box-sizing: border-box; min-height: 84px; padding: var(--u) calc(var(--u) * 2); border: 0; outline: 0; resize: none; background: none; color: var(--ink); font: inherit; }
.pc-tools { display: flex; align-items: center; gap: var(--u); padding: var(--u) calc(var(--u) * 1.5); border-top: 1px solid var(--line); }
.pc-tool { display: inline-flex; align-items: center; gap: var(--u); height: 24px; padding: 0 calc(var(--u) * 2); border: 0; border-radius: var(--r-pill); background: none; color: var(--ink-2); font: 600 var(--fs-xs) var(--font-sans); cursor: pointer; }
.pc-tool:hover:not(:disabled) { background: var(--surface-2); color: var(--ink); }
.pc-tool:disabled { opacity: 0.5; cursor: default; }
.pc-tool .icon { width: 13px; height: 13px; }
.pc-tool-key { font: 600 12px var(--font-mono); color: var(--accent); }
.pc-tools-hint { margin-left: auto; color: var(--ink-3); font-size: var(--fs-xs); }
.pc-pop { max-height: 300px; }
.pc-pop .listbox-opt[data-active='true'] { background: var(--accent-soft); }
.pc-cmd { font-family: var(--font-mono); font-weight: 600; font-size: var(--fs-sm); color: var(--ink); }
.pc-cmd mark, .pc-file mark { background: var(--hit); color: inherit; border-radius: 2px; }
.pc-arg { margin-left: calc(var(--u) * 1.5); font-weight: 400; font-size: var(--fs-xs); color: var(--ink-3); }
.pc-desc { white-space: nowrap; }
.pc-src { flex: none; padding: 0 calc(var(--u) * 1.5); border-radius: var(--r-pill); font-size: 10px; font-weight: 600; color: var(--ink-2); background: var(--surface-2); }
.pc-src[data-source='project'] { color: var(--st-active); background: var(--st-active-soft); }
.pc-src[data-source='plugin'] { color: var(--cand); background: var(--cand-soft); }
```

`.listbox-opt` の選ばれかけの見た目が `[data-active]` ですでに決まっていれば、`.pc-pop .listbox-opt[data-active='true']` の行は足さない。`packages/ui/src/styles/*.test.ts` に、字の太さや色の決まりを見る試験がある。足した CSS で落ちたら、決まりの側に合わせる（太さは 400・600・700 だけ、など）。

- [ ] **Step 8: api の口を足す**

`packages/ui/src/runtime/api.ts`。型の import に `DropDto`、`PromptCommandDto` を足し、`ApiClient` に足す。

```ts
  // 初期プロンプト欄の候補と添付。
  promptCommands(projectId: string | null): Promise<PromptCommandDto[]>;
```

`createApi` の返す物に足す。

```ts
    promptCommands: (projectId) => call<{ commands: PromptCommandDto[] }>(`/api/prompt/commands${qs({ projectId })}`).then((r) => r.commands),
```

`packages/ui/src/test/fakeApi.ts` にも同じ名前で足す（既定は `[]` を返す）。`packages/ui/src/runtime/api.test.ts` に 1 件足す。

```ts
  it('promptCommands は projectId を付けて読み、commands を取り出す', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ commands: [{ name: 'goal', description: '', argumentHint: null, source: 'user', uses: 1 }] })));
    const api = createApi(fetchFn as unknown as typeof fetch);
    expect(await api.promptCommands('p1')).toEqual([{ name: 'goal', description: '', argumentHint: null, source: 'user', uses: 1 }]);
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/prompt/commands?projectId=p1');
    await api.promptCommands(null);
    expect(fetchFn.mock.calls[1]![0]).toBe('/api/prompt/commands');
  });
```

- [ ] **Step 9: Root で配る**

`packages/ui/src/Root.tsx`。`queryCandidates` の近くで作り、全体を `PromptAssistContext.Provider` で包む。

```tsx
  // 初期プロンプト欄がサーバに頼むこと。画面は fetch を呼ばないので、ここで api をつなぐ。
  const promptAssist = useMemo<PromptAssist>(() => {
    const api = props.api ?? apiFromRuntime(rt);
    return {
      commands: (projectId) => api.promptCommands(projectId),
      files: () => Promise.resolve([]),
      upload: () => Promise.reject(new Error('添付は使えません')),
      existing: (paths) => Promise.resolve(paths),
      notify: (message) => emit({ type: 'toast.show', level: 'error', message }),
    };
  }, [props.api, rt]);
```

`notify` は、Root がいま右下の知らせを出すのに使っている手（Intent か runtime の関数）をそのまま使う。`toast.show` という Intent が無ければ、`packages/shared/src/intent.ts` と `mediator/notify.ts` を読んで、失敗の知らせを出す既存の手に合わせる。新しい Intent が要るなら `{ type: 'toast.show'; level: 'info' | 'error'; message: string }` を足し、`notify.ts` で `{ kind: 'toast', level, message }` の Effect にする（試験を 1 件足す）。

- [ ] **Step 10: ダイアログに入れる**

`packages/ui/src/views/NewSessionDialog.tsx`。import を足す。

```tsx
import { PromptComposer } from './primitives/PromptComposer.tsx';
```

初期プロンプトの `label` を次に替える。textarea が箱に入るので、label は欄の外に置く。

```tsx
      <div className="field">
        <label htmlFor="new-session-prompt">初期プロンプト（任意）</label>
        <PromptComposer id="new-session-prompt" value={prompt} onChange={setPrompt} projectId={scratch || !choice ? null : choice} />
      </div>
```

`onKeyDown` の `tagName === 'TEXTAREA'` の分岐はそのまま効く（候補が開いている間の Enter は部品が止める）。

- [ ] **Step 11: ダイアログの試験を足す**

`packages/ui/src/views/NewSessionDialog.test.tsx` に足す。

```tsx
  it('初期プロンプトで / の候補から選ぶと、その文で起動する', async () => {
    const out: LaunchParams[] = [];
    const assist = { ...NO_ASSIST, commands: () => Promise.resolve([{ name: 'goal', description: '長く走る', argumentHint: null, source: 'user' as const, uses: 3 }]) };
    render(<PromptAssistContext.Provider value={assist}><IntentRoot onIntent={(i) => { if (i.type === 'session.new.submit') out.push(i.params); }}><NewSessionDialog {...base} projectId="p1" /></IntentRoot></PromptAssistContext.Provider>);
    await act(async () => {});
    const ta = screen.getByLabelText('初期プロンプト（任意）');
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: '/g', selectionStart: 2, selectionEnd: 2 } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(out).toEqual([]);
    start();
    expect(out).toEqual([{ projectId: 'p1', prompt: '/goal' }]);
  });
  it('候補が開いている間の Esc は、ダイアログを閉じない', async () => {
    const closed = vi.fn();
    const assist = { ...NO_ASSIST, commands: () => Promise.resolve([{ name: 'goal', description: '', argumentHint: null, source: 'user' as const, uses: 0 }]) };
    render(<PromptAssistContext.Provider value={assist}><IntentRoot onIntent={(i) => { if (i.type === 'overlay.close') closed(); }}><NewSessionDialog {...base} projectId="p1" /></IntentRoot></PromptAssistContext.Provider>);
    await act(async () => {});
    const ta = screen.getByLabelText('初期プロンプト（任意）');
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: '/', selectionStart: 1, selectionEnd: 1 } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'スキルとコマンド' })).toBeNull();
  });
```

`act`、`NO_ASSIST`、`PromptAssistContext` の import を足す。

- [ ] **Step 12: 全部通す**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS。既存の「初期プロンプト（任意）」を `getByLabelText` で取る試験が、label の付け替えの後も通ること。

- [ ] **Step 13: コミット**

```bash
git add packages/ui
git commit -m "feat(ui): suggest skills and commands when the initial prompt starts with a slash"
```

---

### Task 4: 置き場に置く・読む口

**Files:**
- Create: `packages/server/src/prompt/drops.ts`
- Test: `packages/server/src/prompt/drops.test.ts`、`packages/server/src/http/app.test.ts`
- Modify: `packages/server/src/http/app.ts`

**Interfaces:**
- Consumes: `DropDto`（Task 1）
- Produces:
  - `MAX_DROP_BYTES = 20 * 1024 * 1024`
  - `sanitizeDropName(name: string): string`
  - `saveDrop(dir: string, name: string, bytes: Uint8Array, now?: number): DropDto`
  - `resolveDrop(dir: string, name: string): string | null`
  - `pruneDrops(dir: string, now: number): void`
  - `POST /api/drops?name=`（本文はそのままのバイト列）→ 201 `DropDto`、大きすぎれば 413
  - `GET /api/drops/:name` → ファイル、無ければ 404
  - `POST /api/drops/existing`（`{ paths: string[] }`）→ `{ paths: string[] }`（いまある物だけ）

- [ ] **Step 1: 試験を書く**

`packages/server/src/prompt/drops.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pruneDrops, resolveDrop, sanitizeDropName, saveDrop } from './drops.ts';

let dir: string;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-drops-')), 'drops'); });

describe('sanitizeDropName', () => {
  it('殻（filedrop.rs）と同じく、空白と引用符とシェルの記号を _ にし、日本語は残す', () => {
    expect(sanitizeDropName('スクリーンショット 2026-09-30 19.51.52.png')).toBe('スクリーンショット_2026-09-30_19.51.52.png');
    expect(sanitizeDropName('a\'b"c$d`e\\f.png')).toBe('a_b_c_d_e_f.png');
    expect(sanitizeDropName('../../etc/passwd')).toBe('.._.._etc_passwd');
  });
  it('空と、点だけの名前は file にする', () => {
    expect(sanitizeDropName('')).toBe('file');
    expect(sanitizeDropName('..')).toBe('file');
  });
});

describe('saveDrop', () => {
  it('置き場を作り、<時刻>-<連番>-<名前> で置いて、パスと大きさを返す', () => {
    const d = saveDrop(dir, 'a b.png', new Uint8Array([1, 2, 3]), 1000);
    expect(d).toEqual({ path: path.join(dir, '1000-0-a_b.png'), name: 'a b.png', size: 3 });
    expect([...fs.readFileSync(d.path)]).toEqual([1, 2, 3]);
  });
  it('同じ時刻に同じ名前を置いても、上書きせず連番を進める', () => {
    const a = saveDrop(dir, 'x.png', new Uint8Array([1]), 1000);
    const b = saveDrop(dir, 'x.png', new Uint8Array([2]), 1000);
    expect(path.basename(b.path)).toBe('1000-1-x.png');
    expect([...fs.readFileSync(a.path)]).toEqual([1]);
  });
  it('名前が空なら file にする', () => {
    expect(saveDrop(dir, '', new Uint8Array([1]), 5).name).toBe('file');
  });
});

describe('resolveDrop', () => {
  it('置き場にあるファイルの名前だけを、その絶対パスにする', () => {
    const d = saveDrop(dir, 'x.png', new Uint8Array([1]), 1000);
    expect(resolveDrop(dir, '1000-0-x.png')).toBe(d.path);
  });
  it('外へ抜ける名前、区切りを含む名前、無いファイル、フォルダは null', () => {
    saveDrop(dir, 'x.png', new Uint8Array([1]), 1000);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, '..', 'secret'), 's');
    for (const n of ['../secret', '..', '.', '', 'sub', 'sub/../1000-0-x.png', '/etc/passwd', 'nope.png', '..\\secret']) expect(resolveDrop(dir, n)).toBeNull();
  });
});

describe('pruneDrops', () => {
  it('7 日より古いファイルだけを消す', () => {
    const old = saveDrop(dir, 'old.png', new Uint8Array([1]), 1);
    const fresh = saveDrop(dir, 'new.png', new Uint8Array([1]), 2);
    const now = Date.now();
    fs.utimesSync(old.path, new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000));
    pruneDrops(dir, now);
    expect(fs.existsSync(old.path)).toBe(false);
    expect(fs.existsSync(fresh.path)).toBe(true);
  });
  it('置き場が無くても落ちない', () => {
    expect(() => pruneDrops(path.join(dir, 'none'), Date.now())).not.toThrow();
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/prompt/drops.test.ts`
Expected: FAIL（`./drops.ts` が無い）

- [ ] **Step 3: 書く**

`packages/server/src/prompt/drops.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { DropDto } from '@agent-hangar/shared';

/** 添付 1 件の上限。 */
export const MAX_DROP_BYTES = 20 * 1024 * 1024;
/** 置いたファイルを残す期間。殻（filedrop.rs の KEEP_FOR）と同じ 7 日。 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const UNSAFE = new Set([...'\'"\\`$!*?;&|<>(){}[]#~/']);

/**
 * 置く先の名前に使えない文字を _ にする。殻の filedrop.rs の sanitize と同じ規則である。
 * 空白や引用符を落としておくと、起動の文にパスをそのまま書ける。日本語は残す。
 */
export function sanitizeDropName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = [...name].map((c) => (/\s/.test(c) || /[\u0000-\u001f\u007f]/.test(c) || UNSAFE.has(c) ? '_' : c)).join('');
  return s === '' || [...s].every((c) => c === '.') ? 'file' : s;
}

/** 置き場に 1 件置く。同じ名前があれば連番を進め、上書きしない。 */
export function saveDrop(dir: string, name: string, bytes: Uint8Array, now = Date.now()): DropDto {
  fs.mkdirSync(dir, { recursive: true });
  const safe = sanitizeDropName(name);
  for (let i = 0; ; i++) {
    const dest = path.join(dir, `${now}-${i}-${safe}`);
    try {
      // wx：すでにあれば失敗させる。別の添付を上書きしないためである。
      fs.writeFileSync(dest, bytes, { flag: 'wx' });
      return { path: dest, name: name || 'file', size: bytes.byteLength };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 999) throw e;
    }
  }
}

/** 置き場の中のファイルの名前を絶対パスにする。区切りを含む名前、外へ抜ける名前、無いもの、フォルダは null。 */
export function resolveDrop(dir: string, name: string): string | null {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const file = path.join(dir, name);
  if (path.dirname(file) !== path.resolve(dir)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

/** 残す期間を過ぎたファイルを消す。 */
export function pruneDrops(dir: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    try { const st = fs.statSync(p); if (st.isFile() && now - st.mtimeMs > KEEP_MS) fs.unlinkSync(p); } catch { /* 消せなかったものは次の回に任せる */ }
  }
}
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/server/src/prompt/drops.test.ts`
Expected: PASS（9 件）

- [ ] **Step 5: 口の試験を書く**

`packages/server/src/http/app.test.ts` に足す。`deps.home` は hangar の置き場（試験では一時フォルダ）である。

```ts
describe('/api/drops', () => {
  const post = (name: string, body: BodyInit, headers: Record<string, string> = {}) => app.request(`/api/drops?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { ...H, 'content-type': 'application/octet-stream', ...headers } });

  it('本文を置き場に置き、パスと名前と大きさを返す', async () => {
    const r = await json(await post('画面 1.png', new Uint8Array([1, 2, 3])));
    expect(r.status).toBe(201);
    const d = r.body as { path: string; name: string; size: number };
    expect(d.name).toBe('画面 1.png');
    expect(d.size).toBe(3);
    expect(path.dirname(d.path)).toBe(path.join(deps.home, 'drops'));
    expect(path.basename(d.path)).toMatch(/^\d+-0-画面_1\.png$/);
    expect([...fs.readFileSync(d.path)]).toEqual([1, 2, 3]);
  });
  it('置いたファイルを名前で読める。画像は種類を付け、中身を勝手に解釈させない', async () => {
    const d = (await json(await post('a.png', new Uint8Array([9, 8])))).body as { path: string };
    const r = await get(`/api/drops/${encodeURIComponent(path.basename(d.path))}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([9, 8]);
  });
  it('画像でないものは、開かせずに落とす種類で返す', async () => {
    const d = (await json(await post('a.html', '<script>1</script>'))).body as { path: string };
    const r = await get(`/api/drops/${encodeURIComponent(path.basename(d.path))}`);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
  });
  it('置き場の外を指す名前は 404', async () => {
    fs.writeFileSync(path.join(deps.home, 'secret'), 's');
    for (const n of ['..%2Fsecret', '%2e%2e%2fsecret', '..', 'nope.png']) expect((await get(`/api/drops/${n}`)).status).toBe(404);
  });
  it('20 MB を超える本文は 413 で、何も置かない', async () => {
    const r = await post('big.bin', new Uint8Array(20 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(deps.home, 'drops')) ? fs.readdirSync(path.join(deps.home, 'drops')).filter((n) => n.endsWith('big.bin')) : []).toEqual([]);
  });
  it('空の本文は 400', async () => {
    expect((await post('empty.png', new Uint8Array(0))).status).toBe(400);
  });
  it('existing は、渡したパスのうち、いまあるファイルだけを返す', async () => {
    const d = (await json(await post('a.png', new Uint8Array([1])))).body as { path: string };
    const r = await json(await app.request('/api/drops/existing', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ paths: [d.path, path.join(deps.home, 'drops', 'gone.png'), 42] }) }));
    expect(r.body).toEqual({ paths: [d.path] });
  });
  it('トークンが無ければ 401', async () => {
    expect((await app.request('/api/drops?name=a.png', { method: 'POST', body: new Uint8Array([1]) })).status).toBe(401);
  });
});
```

- [ ] **Step 6: 落ちるのを見る**

Run: `npx vitest run packages/server/src/http/app.test.ts -t 'api/drops'`
Expected: FAIL（404）

- [ ] **Step 7: 口を足す**

`packages/server/src/http/app.ts`。import を足す。

```ts
import { MAX_DROP_BYTES, pruneDrops, resolveDrop, saveDrop } from '../prompt/drops.ts';
```

`/prompt/commands` の口の後に足す。`tooLargeResult` と `readJson` はこのファイルの既存のものを使う（413 の応答の形をそろえる）。

```ts
  // 初期プロンプト欄の添付。端末へのドロップ（殻の filedrop.rs）と同じ置き場に置く。
  const dropsDir = path.join(deps.home, 'drops');
  const DROP_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  api.post('/drops/existing', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const paths = (b.value as { paths?: unknown } | null)?.paths;
    if (!Array.isArray(paths)) return c.json({ error: 'paths が要ります' }, 400);
    // フォルダを落としたときは元のパスがそのまま添付になるので、ファイルに限らず「ある」かだけを見る。
    return c.json({ paths: paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) });
  });
  api.post('/drops', async (c) => {
    // 先に長さの申告で断り、読んだ後にも実際の大きさで断る（申告は偽れる）。
    if (Number(c.req.header('content-length') ?? 0) > MAX_DROP_BYTES) return tooLargeResult(c, MAX_DROP_BYTES);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_DROP_BYTES) return tooLargeResult(c, MAX_DROP_BYTES);
    if (bytes.byteLength === 0) return c.json({ error: '中身がありません' }, 400);
    pruneDrops(dropsDir, Date.now());
    return c.json(saveDrop(dropsDir, c.req.query('name') ?? '', bytes), 201);
  });
  api.get('/drops/:name', (c) => {
    const file = resolveDrop(dropsDir, c.req.param('name'));
    if (!file) return c.notFound();
    // 画像だけを画像として返す。ほかは開かせない。置いたものを頁として解釈させないためである。
    c.header('Content-Type', DROP_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(fs.readFileSync(file));
  });
```

`tooLargeResult` の引数や名前が違えば、このファイルの定義に合わせる。`fs` と `path` の import はすでにある。`/drops/existing` を `/drops/:name` より前に置く（`existing` という名前のファイルとして読まれないようにする。POST と GET で分かれているが、順を守っておく）。

- [ ] **Step 8: 通るのを見る**

Run: `npx vitest run packages/server/src/http/app.test.ts packages/server/src/prompt && npm run typecheck`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add packages/server
git commit -m "feat(server): store and serve attachments for the initial prompt under drops"
```

---

### Task 5: 添付（札、貼り付け、ドロップ、ボタン、下書き）

**Files:**
- Modify: `packages/ui/src/views/primitives/promptComposerModel.ts`、`PromptComposer.tsx`、`packages/ui/src/runtime/fileDrop.ts`、`packages/ui/src/runtime/api.ts`、`packages/ui/src/test/fakeApi.ts`、`packages/ui/src/Root.tsx`、`packages/ui/src/views/NewSessionDialog.tsx`、`packages/ui/src/mediator/launch.ts`、`packages/ui/src/mediator/types.ts`、`packages/shared/src/intent.ts`、`packages/ui/src/styles/controls.css`
- Test: それぞれの `.test.ts(x)`

**Interfaces:**
- Consumes: `DropDto`、`POST /api/drops`、`GET /api/drops/:name`、`POST /api/drops/existing`（Task 4）、`FILE_DROP_EVENT`（`fileDrop.ts`）
- Produces:
  - `type Attachment = { path: string; name: string; size: number | null }`
  - `composePrompt(body: string, attachments: Attachment[]): string`
  - `dropFileName(path: string): string | null`（置き場のファイルなら、その名前）
  - `attachmentFromPath(path: string): Attachment`
  - `isImageName(name: string): boolean`、`formatSize(bytes: number): string`
  - `parseDrop(detail: unknown): { paths: string[]; x: number; y: number } | null`（`fileDrop.ts` から外へ出す）
  - `PromptComposer` の props に `attachments: Attachment[]`、`onAttachmentsChange: (next: Attachment[]) => void`
  - `NewSessionDraft = { name: string; prompt: string; attachments: Attachment[] }`
  - Intent `{ type: 'session.new.draft'; name: string; prompt: string; attachments?: Attachment[] }`
  - `ApiClient.uploadDrop(file: Blob, name: string): Promise<DropDto>`、`ApiClient.existingDrops(paths: string[]): Promise<string[]>`

- [ ] **Step 1: 関数の試験を足す**

`promptComposerModel.test.ts` に足す。

```ts
describe('composePrompt', () => {
  const a = (path: string): Attachment => ({ path, name: 'x', size: 1 });
  it('添付が無ければ、本文の前後の空白を落としただけにする', () => {
    expect(composePrompt('  やって\n', [])).toBe('やって');
  });
  it('本文の後に空行を 1 つ置き、添付のパスを 1 行ずつ足す', () => {
    expect(composePrompt('見て', [a('/h/drops/1-0-a.png'), a('/h/drops/1-1-b.log')])).toBe('見て\n\n/h/drops/1-0-a.png\n/h/drops/1-1-b.log');
  });
  it('本文が空なら、パスだけにする', () => {
    expect(composePrompt('  ', [a('/h/drops/1-0-a.png')])).toBe('/h/drops/1-0-a.png');
  });
  it('空白を含むパス（フォルダを落としたときの元のパス）は、単引用符で囲む', () => {
    expect(composePrompt('', [a('/Users/a/my dir')])).toBe("'/Users/a/my dir'");
  });
});

describe('添付の小さな関数', () => {
  it('dropFileName は、置き場のファイルだけ名前を返す', () => {
    expect(dropFileName('/Users/a/.agent-hangar/drops/1700-0-画面.png')).toBe('1700-0-画面.png');
    expect(dropFileName('/Users/a/Desktop/画面.png')).toBeNull();
    expect(dropFileName('/Users/a/.agent-hangar/drops/sub/x.png')).toBeNull();
  });
  it('attachmentFromPath は、置き場の接頭辞（時刻と連番）を名前から落とす', () => {
    expect(attachmentFromPath('/Users/a/.agent-hangar/drops/1700-0-画面_1.png')).toEqual({ path: '/Users/a/.agent-hangar/drops/1700-0-画面_1.png', name: '画面_1.png', size: null });
    expect(attachmentFromPath('/Users/a/work/proj')).toEqual({ path: '/Users/a/work/proj', name: 'proj', size: null });
  });
  it('isImageName は拡張子で見る', () => {
    expect(['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp'].every(isImageName)).toBe(true);
    expect(['a.svg', 'a.log', 'png'].some(isImageName)).toBe(false);
  });
  it('formatSize は KB と MB で出す', () => {
    expect(formatSize(1)).toBe('1 KB');
    expect(formatSize(4000)).toBe('4 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
```

import に `attachmentFromPath, composePrompt, dropFileName, formatSize, isImageName, type Attachment` を足す。

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/promptComposerModel.test.ts`
Expected: FAIL（関数が無い）

- [ ] **Step 3: 関数を足す**

`promptComposerModel.ts` の末尾に足す。先頭の import に `import { quotePath } from '../../runtime/fileDrop.ts';` を足す。

```ts
/** 初期プロンプトに添えるファイル。size は、殻から届いたもの（大きさが分からない）では null。 */
export type Attachment = { path: string; name: string; size: number | null };

/**
 * 起動のときに claude へ渡す文。本文の後に空行を置き、添付のパスを 1 行ずつ足す。
 * 起動の API は変えず、パスを文に書く。Claude はパスを見てファイルを読む（仕様書の「確かめたこと」）。
 * 置き場の名前は空白を含まないが、フォルダを落としたときは元のパスがそのまま来るので、端末へのドロップと同じ規則で囲む。
 */
export function composePrompt(body: string, attachments: Attachment[]): string {
  const text = body.trim();
  if (!attachments.length) return text;
  const paths = attachments.map((a) => quotePath(a.path)).join('\n');
  return text ? `${text}\n\n${paths}` : paths;
}

const DROPS_MARK = '/.agent-hangar/drops/';
/** 置き場のファイルなら、その名前（GET /api/drops/:name に渡す）。置き場の外や、さらに下のフォルダは null。 */
export function dropFileName(path: string): string | null {
  const i = path.lastIndexOf(DROPS_MARK);
  if (i < 0) return null;
  const rest = path.slice(i + DROPS_MARK.length);
  return rest && !rest.includes('/') ? rest : null;
}

/** 殻から届いたパスを添付にする。置き場の名前の頭（時刻と連番）は、札に出す名前から落とす。 */
export function attachmentFromPath(path: string): Attachment {
  const base = path.replace(/\/+$/, '').split('/').pop() ?? path;
  const name = dropFileName(path) ? base.replace(/^\d+-\d+-/, '') : base;
  return { path, name: name || base, size: null };
}

export const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);

export function formatSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
```

置き場が `HANGAR_HOME` で別の場所にあると `dropFileName` は null を返し、札は絵でなく拡張子の印になる。起動の文には影響しない。

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/promptComposerModel.test.ts`
Expected: PASS

- [ ] **Step 5: `parseDrop` を外へ出す**

`packages/ui/src/runtime/fileDrop.ts` の `function parse` を `export function parseDrop` に改名し、`handleFileDrop` の中の呼び出しも替える。`type Drop` も `export` する。`fileDrop.test.ts` に 1 件足す。

```ts
describe('parseDrop', () => {
  it('形の合う知らせだけを返す', () => {
    expect(parseDrop({ paths: ['/a.png'], x: 1, y: 2 })).toEqual({ paths: ['/a.png'], x: 1, y: 2 });
    for (const bad of [null, {}, { paths: [], x: 1, y: 2 }, { paths: [''], x: 1, y: 2 }, { paths: ['/a'], x: NaN, y: 2 }]) expect(parseDrop(bad)).toBeNull();
  });
});
```

Run: `npx vitest run packages/ui/src/runtime/fileDrop.test.ts`
Expected: PASS

- [ ] **Step 6: api の口を足す**

`packages/ui/src/runtime/api.ts`。`ApiClient` に足す。

```ts
  uploadDrop(file: Blob, name: string): Promise<DropDto>;
  existingDrops(paths: string[]): Promise<string[]>;
```

`createApi` に足す。`call` は headers を後勝ちで混ぜるので、種類だけ上書きする。

```ts
    uploadDrop: (file, name) => call(`/api/drops${qs({ name })}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } }),
    existingDrops: (paths) => post<{ paths: string[] }>('/api/drops/existing', { paths }).then((r) => r.paths),
```

`fakeApi.ts` にも足す。`api.test.ts` に足す。

```ts
  it('uploadDrop は本文をそのまま送り、名前を問い合わせに付ける', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ path: '/h/drops/1-0-a.png', name: 'a b.png', size: 3 }), { status: 201 }));
    const api = createApi(fetchFn as unknown as typeof fetch);
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    expect(await api.uploadDrop(blob, 'a b.png')).toEqual({ path: '/h/drops/1-0-a.png', name: 'a b.png', size: 3 });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('/api/drops?name=a+b.png');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
  });
```

`Root.tsx` の `promptAssist` の `upload` と `existing` を本物に替える。

```tsx
      upload: (file) => api.uploadDrop(file, file.name),
      existing: (paths) => api.existingDrops(paths),
```

- [ ] **Step 7: 部品の試験を足す**

`PromptComposer.test.tsx`。`Host` を、添付も持つ形に替える。

```tsx
function Host(props: { projectId?: string | null; onValue?: (v: string) => void; initial?: Attachment[]; onAttachments?: (a: Attachment[]) => void }) {
  const [value, setValue] = useState('');
  const [atts, setAtts] = useState<Attachment[]>(props.initial ?? []);
  return <PromptComposer id="p" value={value} onChange={(v) => { setValue(v); props.onValue?.(v); }} projectId={props.projectId ?? null} attachments={atts} onAttachmentsChange={(a) => { setAtts(a); props.onAttachments?.(a); }} />;
}
```

試験を足す。

```tsx
describe('PromptComposer の添付', () => {
  const png = () => new File([new Uint8Array([1, 2, 3])], '画面 1.png', { type: 'image/png' });
  const upload = () => vi.fn((f: File) => Promise.resolve({ path: `/Users/a/.agent-hangar/drops/1700-0-${f.name.replaceAll(' ', '_')}`, name: f.name, size: f.size }));

  it('貼り付けたファイルを置き場に送り、絵の札で出す', async () => {
    const up = upload();
    const onAttachments = vi.fn();
    const { ta } = await mount({ upload: up }, { onAttachments });
    fireEvent.paste(ta, { clipboardData: { files: [png()] } });
    await act(async () => {});
    expect(up).toHaveBeenCalledTimes(1);
    expect(onAttachments).toHaveBeenLastCalledWith([{ path: '/Users/a/.agent-hangar/drops/1700-0-画面_1.png', name: '画面 1.png', size: 3 }]);
    const card = screen.getByRole('listitem', { name: '画面 1.png' });
    // 絵は飾り（alt が空）なので、役割では取れない。
    expect(card.querySelector('img')).toHaveAttribute('src', '/api/drops/1700-0-%E7%94%BB%E9%9D%A2_1.png');
    expect(card).toHaveTextContent('1 KB');
  });
  it('ファイルの無い貼り付け（文字だけ）は、そのまま欄に任せる', async () => {
    const up = upload();
    const { ta } = await mount({ upload: up });
    const ev = fireEvent.paste(ta, { clipboardData: { files: [] } });
    expect(ev).toBe(true);
    expect(up).not.toHaveBeenCalled();
  });
  it('画像でないものは、拡張子の印の札にする', async () => {
    const { ta } = await mount({ upload: upload() });
    fireEvent.paste(ta, { clipboardData: { files: [new File(['x'], 'server.log')] } });
    await act(async () => {});
    expect(screen.getByRole('listitem', { name: 'server.log' })).toHaveTextContent('LOG');
  });
  it('× で外す', async () => {
    const onAttachments = vi.fn();
    await mount({}, { initial: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 10 }], onAttachments });
    fireEvent.click(screen.getByRole('button', { name: 'a.png を外す' }));
    expect(onAttachments).toHaveBeenLastCalledWith([]);
  });
  it('添付ボタンで選んだファイルも同じ道を通る', async () => {
    const up = upload();
    await mount({ upload: up });
    fireEvent.change(screen.getByTestId('pc-picker'), { target: { files: [png()] } });
    await act(async () => {});
    expect(up).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('listitem', { name: '画面 1.png' })).toBeInTheDocument();
  });
  it('20 MB を超えるものは送らず、知らせを出す', async () => {
    const up = upload();
    const notify = vi.fn();
    const { ta } = await mount({ upload: up, notify });
    const big = new File([new Uint8Array(1)], 'big.bin');
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    fireEvent.paste(ta, { clipboardData: { files: [big] } });
    await act(async () => {});
    expect(up).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('big.bin は 20 MB を超えているので添付できません');
  });
  it('送るのに失敗したら知らせを出し、札は足さない', async () => {
    const notify = vi.fn();
    const { ta } = await mount({ upload: () => Promise.reject(new Error('だめ')), notify });
    fireEvent.paste(ta, { clipboardData: { files: [png()] } });
    await act(async () => {});
    expect(notify).toHaveBeenCalledWith('画面 1.png を添付できませんでした（だめ）');
    expect(screen.queryByRole('listitem')).toBeNull();
  });
  it('ブラウザで欄に落としたファイルも送る', async () => {
    const up = upload();
    const { ta } = await mount({ upload: up });
    fireEvent.drop(ta, { dataTransfer: { files: [png()] } });
    await act(async () => {});
    expect(up).toHaveBeenCalledTimes(1);
  });
  it('殻からのドロップは、落とした位置が欄のときだけ、届いたパスを添付にする', async () => {
    const onAttachments = vi.fn();
    const { ta } = await mount({}, { onAttachments });
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: ['/Users/a/.agent-hangar/drops/1700-0-shot.png'], x: 5, y: 6 } })); });
    expect(onAttachments).toHaveBeenLastCalledWith([{ path: '/Users/a/.agent-hangar/drops/1700-0-shot.png', name: 'shot.png', size: null }]);
    hit.mockReturnValue(document.body);
    onAttachments.mockClear();
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: ['/x.png'], x: 5, y: 6 } })); });
    expect(onAttachments).not.toHaveBeenCalled();
    hit.mockRestore();
  });
  it('同じパスは 2 度足さない', async () => {
    const onAttachments = vi.fn();
    const { ta } = await mount({}, { initial: [{ path: '/x.png', name: 'x.png', size: null }], onAttachments });
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: ['/x.png'], x: 1, y: 1 } })); });
    expect(onAttachments).not.toHaveBeenCalled();
    hit.mockRestore();
  });
  it('開いたときに置き場から消えていた添付は、札から外す', async () => {
    const onAttachments = vi.fn();
    await mount({ existing: (paths) => Promise.resolve(paths.filter((p) => p.endsWith('b.png'))) }, { initial: [{ path: '/d/a.png', name: 'a.png', size: 1 }, { path: '/d/b.png', name: 'b.png', size: 1 }], onAttachments });
    expect(onAttachments).toHaveBeenLastCalledWith([{ path: '/d/b.png', name: 'b.png', size: 1 }]);
  });
  it('あるかどうかを確かめられなかったら、添付はそのまま残す', async () => {
    const onAttachments = vi.fn();
    await mount({ existing: () => Promise.reject(new Error('x')) }, { initial: [{ path: '/d/a.png', name: 'a.png', size: 1 }], onAttachments });
    expect(onAttachments).not.toHaveBeenCalled();
    expect(screen.getByRole('listitem', { name: 'a.png' })).toBeInTheDocument();
  });
});
```

import に `type Attachment`（`./promptComposerModel.ts`）を足す。Task 3 の試験の `Host` も新しい形で通ること。

- [ ] **Step 8: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/PromptComposer.test.tsx`
Expected: FAIL（props と札が無い）

- [ ] **Step 9: 部品に添付を足す**

`PromptComposer.tsx`。import を足す。

```tsx
import { FILE_DROP_EVENT, parseDrop } from '../../runtime/fileDrop.ts';
import { attachmentFromPath, dropFileName, formatSize, isImageName, type Attachment } from './promptComposerModel.ts';
```

（`acceptText` などの既存の import と同じ行にまとめる。）

props を替える。

```tsx
export function PromptComposer(props: { id: string; value: string; onChange: (value: string) => void; projectId: string | null; attachments: Attachment[]; onAttachmentsChange: (next: Attachment[]) => void }) {
```

部品の中、`accept` の前あたりに足す。

```tsx
  /** 添付 1 件の上限。サーバ（prompt/drops.ts の MAX_DROP_BYTES）と同じ。 */
  const MAX_BYTES = 20 * 1024 * 1024;
  const picker = useRef<HTMLInputElement>(null);
  // 送っている間に次の添付が来ても取りこぼさないよう、いまの一覧は ref で読む。
  const atts = useRef(props.attachments);
  atts.current = props.attachments;
  const add = (more: Attachment[]) => {
    const have = new Set(atts.current.map((a) => a.path));
    const fresh = more.filter((a) => !have.has(a.path));
    if (!fresh.length) return;
    atts.current = [...atts.current, ...fresh];
    props.onAttachmentsChange(atts.current);
  };
  const remove = (path: string) => { atts.current = atts.current.filter((a) => a.path !== path); props.onAttachmentsChange(atts.current); };

  /** 貼り付け、ブラウザでのドロップ、添付ボタンのどれも、ここで置き場へ送る。 */
  const send = (files: File[]) => {
    for (const f of files) {
      if (f.size > MAX_BYTES) { assist.notify(`${f.name} は 20 MB を超えているので添付できません`); continue; }
      assist.upload(f).then(
        (d) => add([{ path: d.path, name: d.name, size: d.size }]),
        (e: unknown) => assist.notify(`${f.name} を添付できませんでした（${e instanceof Error ? e.message : String(e)}）`),
      );
    }
  };

  // 殻（Hangar.app）からのドロップ。殻が置き場に写した先のパスを送ってくるので、落とした位置がこの欄なら添付にする。
  // 端末に落としたときは main.tsx の受け口が貼り付ける。行き先が重ならないよう、ここは欄の中だけを見る。
  useEffect(() => {
    const onDrop = (e: Event) => {
      const d = parseDrop((e as CustomEvent).detail);
      if (!d || !box.current) return;
      const hit = document.elementFromPoint(d.x, d.y);
      if (!hit || !box.current.contains(hit)) return;
      add(d.paths.map(attachmentFromPath));
      ta.current?.focus();
    };
    window.addEventListener(FILE_DROP_EVENT, onDrop);
    return () => window.removeEventListener(FILE_DROP_EVENT, onDrop);
    // add は ref と props の関数しか使わない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 下書きから戻した添付は、置き場の掃除（7 日）で消えていることがある。開いたときに 1 度だけ確かめて外す。
  // 確かめられなかったときは残す。消えたと決めつけて外すより、起動の文に残るほうが害が小さい。
  useEffect(() => {
    const first = atts.current;
    if (!first.length) return;
    let live = true;
    assist.existing(first.map((a) => a.path)).then((alive) => {
      if (!live) return;
      const keep = new Set(alive);
      const next = atts.current.filter((a) => keep.has(a.path) || !first.some((f) => f.path === a.path));
      if (next.length !== atts.current.length) { atts.current = next; props.onAttachmentsChange(next); }
    }, () => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

`MAX_BYTES` は部品の外（`MAX_HEIGHT` の隣）に置く。

textarea に足す。

```tsx
        onPaste={(e) => { const files = [...(e.clipboardData?.files ?? [])]; if (!files.length) return; e.preventDefault(); send(files); }}
        onDragOver={(e) => { if (e.dataTransfer?.types?.includes?.('Files')) e.preventDefault(); }}
        onDrop={(e) => { const files = [...(e.dataTransfer?.files ?? [])]; if (!files.length) return; e.preventDefault(); send(files); }}
```

道具の段を替える。

```tsx
      <div className="pc-tools">
        <button type="button" className="pc-tool" onMouseDown={(e) => e.preventDefault()} onClick={startSlash}><span className="pc-tool-key" aria-hidden="true">/</span>スキル</button>
        <button type="button" className="pc-tool" onClick={() => picker.current?.click()}><Icon name="attach" />添付</button>
        <span className="pc-tools-hint">画像は ⌘V でも貼れます</span>
        <input ref={picker} type="file" multiple hidden data-testid="pc-picker" onChange={(e) => { send([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
```

`Icon` に `attach`（クリップ）が無ければ、`packages/ui/src/views/primitives/Icon.tsx` の書き方に合わせて足す。線は次のもの。

```
M21 12.5 12.5 21a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6L15.5 7.6
```

箱（`.pc-box`）の閉じタグの直前、候補の portal の前に、札を足す。箱の外に出したいので、部品の一番外を `<div className="pc">` にして、箱と札を並べる。

```tsx
    <div className="pc">
      <div ref={box} className="pc-box"> … </div>
      {props.attachments.length > 0 && (
        <ul className="pc-cards" aria-label="添付">
          {props.attachments.map((a) => {
            const file = isImageName(a.name) ? dropFileName(a.path) : null;
            const ext = a.name.includes('.') ? a.name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';
            return (
              <li key={a.path} className="pc-card" aria-label={a.name} title={a.path}>
                {file ? <img className="pc-thumb" src={`/api/drops/${encodeURIComponent(file)}`} alt="" /> : <span className="pc-thumb pc-thumb-doc" aria-hidden="true">{ext}</span>}
                <span className="pc-card-text"><b>{a.name}</b>{a.size !== null && <small>{formatSize(a.size)}</small>}</span>
                <button type="button" className="pc-card-x" aria-label={`${a.name} を外す`} onClick={() => remove(a.path)}><Icon name="close" /></button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
```

`Icon` の閉じる印の名前は、`Dialog.tsx` の × が使っているものに合わせる。

- [ ] **Step 10: スタイルを足す**

`controls.css` の `pc-` の節に足す。

```css
.pc { display: flex; flex-direction: column; gap: calc(var(--u) * 2); min-width: 0; }
.pc-cards { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 2); margin: 0; padding: 0; list-style: none; }
.pc-card { position: relative; display: flex; align-items: center; gap: calc(var(--u) * 2); max-width: 220px; padding: var(--u) calc(var(--u) * 7) var(--u) var(--u); border-radius: 10px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-strong); }
.pc-thumb { flex: none; width: 44px; height: 44px; border-radius: 7px; object-fit: cover; background: var(--surface-2); }
.pc-thumb-doc { display: grid; place-items: center; color: var(--ink-3); font: 600 10px var(--font-mono); }
.pc-card-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; color: var(--ink); font-size: var(--fs-sm); }
.pc-card-text b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-card-text small { color: var(--ink-3); font-size: var(--fs-xs); }
.pc-card-x { position: absolute; top: var(--u); right: var(--u); display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--ink-3); cursor: pointer; }
.pc-card-x:hover { background: var(--surface-2); color: var(--ink); }
.pc-card-x .icon { width: 12px; height: 12px; }
```

- [ ] **Step 11: 部品の試験を通す**

Run: `npx vitest run packages/ui/src/views/primitives`
Expected: PASS

- [ ] **Step 12: 下書きに添付を足す（試験）**

`packages/ui/src/mediator/launch.ts` の試験（`launchStep` を見ている既存の試験ファイル。`grep -rn "session.new.draft" packages/ui/src --include='*.test.*'` で探す）に足す。

```ts
  it('下書きは添付も覚える。名前も本文も空でも、添付があれば残す', () => {
    const a = { path: '/h/drops/1-0-a.png', name: 'a.png', size: 3 };
    const r = step(base, { kind: 'intent', intent: { type: 'session.new.draft', name: '', prompt: '', attachments: [a] } });
    expect(r.state.newSessionDraft).toEqual({ name: '', prompt: '', attachments: [a] });
    expect(r.effects).toContainEqual({ kind: 'storage.save', key: 'newSession.draft', value: { name: '', prompt: '', attachments: [a] } });
  });
  it('添付を付けない下書きの Intent は、添付なしとして扱う', () => {
    const r = step(base, { kind: 'intent', intent: { type: 'session.new.draft', name: 'n', prompt: '' } });
    expect(r.state.newSessionDraft).toEqual({ name: 'n', prompt: '', attachments: [] });
  });
  it('readDraft は、古い形（添付なし）を空の添付として読み、形の違う添付は捨てる', () => {
    expect(readDraft({ name: 'n', prompt: 'p' })).toEqual({ name: 'n', prompt: 'p', attachments: [] });
    expect(readDraft({ name: 'n', prompt: 'p', attachments: [{ path: '/a', name: 'a', size: null }, { path: 1 }, 'x', { path: '/b', name: 'b', size: 2 }] })).toEqual({ name: 'n', prompt: 'p', attachments: [{ path: '/a', name: 'a', size: null }, { path: '/b', name: 'b', size: 2 }] });
  });
```

`step` と `base` は、その試験ファイルの既存の呼び方に合わせる。既存の下書きの試験で `{ name, prompt }` と比べている所は、`attachments: []` を足す。

- [ ] **Step 13: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/mediator packages/ui/src/runtime`
Expected: FAIL

- [ ] **Step 14: 下書きを直す**

`packages/shared/src/intent.ts`

```ts
  | { type: 'session.new.draft'; name: string; prompt: string; attachments?: { path: string; name: string; size: number | null }[] }
```

`packages/ui/src/mediator/types.ts`

```ts
/** 新しいセッションのダイアログの書きかけ。添付は、置き場（~/.agent-hangar/drops/）のパスで覚える。 */
export type NewSessionDraft = { name: string; prompt: string; attachments: { path: string; name: string; size: number | null }[] };
```

（mediator から views の型を import しないよう、形をここに書く。`promptComposerModel.ts` の `Attachment` と同じ形である。）

`packages/ui/src/mediator/launch.ts`

```ts
/** localStorage から読んだ下書き。形が違えば（手で書き換えられたなど）捨てる。添付の無い古い形は、空の添付として読む。 */
export function readDraft(v: unknown): NewSessionDraft | null {
  if (!v || typeof v !== 'object') return null;
  const { name, prompt, attachments } = v as Record<string, unknown>;
  if (typeof name !== 'string' || typeof prompt !== 'string') return null;
  const list = Array.isArray(attachments) ? attachments : [];
  const ok = (a: unknown): a is NewSessionDraft['attachments'][number] => {
    if (!a || typeof a !== 'object') return false;
    const r = a as Record<string, unknown>;
    return typeof r.path === 'string' && typeof r.name === 'string' && (r.size === null || typeof r.size === 'number');
  };
  return { name, prompt, attachments: list.filter(ok).map((a) => ({ path: a.path, name: a.name, size: a.size })) };
}
```

`setDraft` の空の判定を替える。

```ts
/** 下書きを書き換える。名前も初期プロンプトも空白だけで、添付も無ければ消す。変わらなければ何もしない。 */
function setDraft(state: State, draft: NewSessionDraft | null): Step {
  const next = draft && (draft.name.trim() || draft.prompt.trim() || draft.attachments.length) ? draft : null;
```

`session.new.draft` の分岐を替える。

```ts
    case 'session.new.draft': return setDraft(state, { name: i.name, prompt: i.prompt, attachments: i.attachments ?? [] });
```

- [ ] **Step 15: ダイアログの試験を足す**

`NewSessionDialog.test.tsx` に足す。

```tsx
  it('添付があると、本文の後に空行とパスを足して起動する', () => {
    const params = collectParams({ projectId: 'p1', draft: { name: '', prompt: '見て', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] } });
    start();
    expect(params).toEqual([{ projectId: 'p1', prompt: '見て\n\n/h/.agent-hangar/drops/1-0-a.png' }]);
  });
  it('本文が空でも、添付だけで起動できる', () => {
    const params = collectParams({ projectId: 'p1', draft: { name: '', prompt: '', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] } });
    start();
    expect(params).toEqual([{ projectId: 'p1', prompt: '/h/.agent-hangar/drops/1-0-a.png' }]);
  });
  it('閉じるときの下書きに、添付も入れる', () => {
    const drafts: unknown[] = [];
    const a = { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 };
    const { unmount } = render(<IntentRoot onIntent={(i) => { if (i.type === 'session.new.draft') drafts.push(i); }}><NewSessionDialog {...base} draft={{ name: 'n', prompt: '', attachments: [a] }} /></IntentRoot>);
    unmount();
    expect(drafts).toEqual([{ type: 'session.new.draft', name: 'n', prompt: '', attachments: [a] }]);
  });
  it('下書きを消すと、添付も消える', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} draft={{ name: 'n', prompt: '', attachments: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 3 }] }} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '下書きを消す' }));
    expect(screen.queryByRole('listitem', { name: 'a.png' })).toBeNull();
  });
```

既存の試験で `draft: { name, prompt }` を渡している所と、`session.new.draft` の Intent を `toEqual` で比べている所は、`attachments: []` を足す。

- [ ] **Step 16: ダイアログを直す**

`NewSessionDialog.tsx`。

```tsx
import { composePrompt, type Attachment } from './primitives/promptComposerModel.ts';
```

状態を足す。

```tsx
  const [attachments, setAttachments] = useState<Attachment[]>(props.draft?.attachments ?? []);
```

`latest` と、閉じるときの送り方を替える。

```tsx
  const latest = useRef({ name, prompt, attachments, submitting: props.submitting, emit });
  latest.current = { name, prompt, attachments, submitting: props.submitting, emit };
  useEffect(() => () => {
    const l = latest.current;
    if (!l.submitting) l.emit({ type: 'session.new.draft', name: l.name, prompt: l.prompt, attachments: l.attachments });
  }, []);
```

`discardDraft` を替える。

```tsx
  const discardDraft = () => {
    setName('');
    setPrompt('');
    setAttachments([]);
    setRestored(false);
    emit({ type: 'session.new.draft', name: '', prompt: '', attachments: [] });
    nameInput.current?.focus();
  };
```

`submit` の中の初期プロンプトの行を替える。

```tsx
    // 添付は、本文の後にパスを足して渡す。起動の API は変えない（promptComposerModel.ts の composePrompt）。
    const text = composePrompt(prompt, attachments);
    if (text) params.prompt = text;
```

部品に渡す。

```tsx
        <PromptComposer id="new-session-prompt" value={prompt} onChange={setPrompt} projectId={scratch || !choice ? null : choice} attachments={attachments} onAttachmentsChange={setAttachments} />
```

ファイルの先頭の説明の「名前と初期プロンプトの書きかけは」を「名前と初期プロンプトと添付の書きかけは」に直す。

- [ ] **Step 17: 全部通す**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 18: コミット**

```bash
git add packages/ui packages/shared
git commit -m "feat(ui): attach images and files to the initial prompt by paste, drop, or picker"
```

---

### Task 6: ドラッグ中に欄の色を変える

**Files:**
- Modify: `apps/desktop/src-tauri/src/filedrop.rs`、`apps/desktop/src-tauri/src/lib.rs`、`packages/ui/src/runtime/fileDrop.ts`、`packages/ui/src/views/primitives/PromptComposer.tsx`、`packages/ui/src/styles/controls.css`
- Test: `filedrop.rs` の中の試験、`fileDrop.test.ts`、`PromptComposer.test.tsx`

**Interfaces:**
- Produces:
  - Rust `filedrop::drag_js(over: Option<(f64, f64)>) -> String`
  - UI `FILE_DRAG_EVENT = 'hangar:drag'`、`parseDrag(detail: unknown): { x: number; y: number } | null`（出たときは `detail` が `null`）
  - `.pc-box[data-drop='true']`

- [ ] **Step 1: Rust の試験を足す**

`filedrop.rs` の `mod tests` に足す。

```rust
    #[test]
    fn drag_js_sends_the_point_while_over_and_null_when_leaving() {
        assert_eq!(
            drag_js(Some((12.5, 30.0))),
            "window.dispatchEvent(new CustomEvent(\"hangar:drag\",{detail:{\"x\":12.5,\"y\":30.0}}));"
        );
        assert_eq!(
            drag_js(None),
            "window.dispatchEvent(new CustomEvent(\"hangar:drag\",{detail:null}));"
        );
    }
```

Run: `cd apps/desktop/src-tauri && cargo test filedrop`
Expected: FAIL（`drag_js` が無い）

- [ ] **Step 2: Rust を書く**

`filedrop.rs` の `drop_js` の後に足す。

```rust
/// UI に `hangar:drag` を投げる式。窓の上をドラッグしている間は位置（CSS の px）を、出たら null を渡す。
/// 殻が Web 側のドラッグのイベントを止めているので、落とせる場所の色を変えるにはここから知らせる。
pub fn drag_js(over: Option<(f64, f64)>) -> String {
    let detail = match over {
        Some((x, y)) => serde_json::json!({ "x": x, "y": y }),
        None => serde_json::Value::Null,
    };
    let lit = serde_json::to_string(&detail).unwrap_or_else(|_| "null".to_string());
    format!("window.dispatchEvent(new CustomEvent(\"hangar:drag\",{{detail:{lit}}}));")
}
```

`serde_json` の出力は鍵を辞書順に並べる（`preserve_order` を入れていなければ `x`、`y` の順）。試験が鍵の順で落ちたら、`format!("{{\"x\":{x:?},\"y\":{y:?}}}")` で直に組む。

`lib.rs`。`file_dropped` の中の位置の換算を関数に出す。

```rust
/// 殻から届く位置を CSS の px にする。
/// wry は macOS で位置を窓のポイント（CSS の px と同じ）で返し、Tauri はそれを物理の型に包むだけで換算しない。
/// 倍率で割ると半分の位置を指してしまうので、macOS では値をそのまま使う。
fn css_point(
    w: &tauri::WebviewWindow,
    position: tauri::PhysicalPosition<f64>,
) -> tauri::LogicalPosition<f64> {
    if cfg!(target_os = "macos") {
        tauri::LogicalPosition::new(position.x, position.y)
    } else {
        position.to_logical::<f64>(w.scale_factor().unwrap_or(1.0))
    }
}
```

`file_dropped` の `let at = if cfg!(...) {...} else {...};` を `let at = css_point(&w, position);` に替え、元の説明のコメントは関数の側に移す。関数を足す。

```rust
/// ドラッグが窓の上にある間の位置を UI へ渡す。出たとき（と落としたとき）は None を渡す。
fn file_dragged(app: &AppHandle, position: Option<tauri::PhysicalPosition<f64>>) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let over = position.map(|p| {
        let at = css_point(&w, p);
        (at.x, at.y)
    });
    let _ = w.eval(filedrop::drag_js(over));
}
```

`run` の `match event` の、`DragDropEvent::Drop` の腕の前後に足す。

```rust
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { position, .. }),
                ..
            } => file_dragged(app, Some(position)),
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Over { position }),
                ..
            } => file_dragged(app, Some(position)),
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave),
                ..
            } => file_dragged(app, None),
```

`Drop` の腕は `{ file_dragged(app, None); file_dropped(app, paths, position) }` にする（落としたら色を戻す）。腕の形（`Enter` の中身の名前など）は、入っている Tauri の版の `DragDropEvent` の定義に合わせる。

- [ ] **Step 3: Rust を通す**

Run: `cd apps/desktop/src-tauri && cargo test filedrop && cargo check`
Expected: PASS、警告なし

- [ ] **Step 4: UI の試験を足す**

`fileDrop.test.ts`

```ts
describe('parseDrag', () => {
  it('位置があればそれを返し、出たとき（null）と形の違うものは null', () => {
    expect(parseDrag({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    for (const bad of [null, undefined, {}, { x: '1', y: 2 }, { x: Infinity, y: 2 }]) expect(parseDrag(bad)).toBeNull();
  });
});
```

`PromptComposer.test.tsx`

```tsx
  it('殻のドラッグが欄の上にある間だけ、落とせる印を付ける', async () => {
    const { ta } = await mount();
    const box = ta.closest('.pc-box')!;
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: { x: 1, y: 1 } })); });
    expect(box).toHaveAttribute('data-drop', 'true');
    hit.mockReturnValue(document.body);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: { x: 900, y: 1 } })); });
    expect(box).not.toHaveAttribute('data-drop');
    hit.mockReturnValue(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: { x: 1, y: 1 } })); });
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: null })); });
    expect(box).not.toHaveAttribute('data-drop');
    hit.mockRestore();
  });
  it('ブラウザでファイルを欄の上へ運んでいる間も、落とせる印を付ける', async () => {
    const { ta } = await mount();
    const box = ta.closest('.pc-box')!;
    fireEvent.dragOver(ta, { dataTransfer: { types: ['Files'], files: [] } });
    expect(box).toHaveAttribute('data-drop', 'true');
    fireEvent.dragLeave(ta);
    expect(box).not.toHaveAttribute('data-drop');
  });
```

Run: `npx vitest run packages/ui/src/runtime/fileDrop.test.ts packages/ui/src/views/primitives/PromptComposer.test.tsx`
Expected: FAIL

- [ ] **Step 5: UI を書く**

`fileDrop.ts` に足す。

```ts
/** Hangar.app の殻から届く、ファイルを窓の上で運んでいる知らせ。detail は位置（CSS の px）で、窓から出たら null。 */
export const FILE_DRAG_EVENT = 'hangar:drag';

export function parseDrag(detail: unknown): { x: number; y: number } | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as { x?: unknown; y?: unknown };
  if (typeof d.x !== 'number' || typeof d.y !== 'number' || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return null;
  return { x: d.x, y: d.y };
}
```

`PromptComposer.tsx`。状態を足す。

```tsx
  const [dropping, setDropping] = useState(false);
```

殻のドロップを聞いている `useEffect` に、ドラッグも足す。

```tsx
    const onDrag = (e: Event) => {
      const d = parseDrag((e as CustomEvent).detail);
      const hit = d && box.current ? document.elementFromPoint(d.x, d.y) : null;
      setDropping(!!hit && !!box.current?.contains(hit));
    };
    window.addEventListener(FILE_DRAG_EVENT, onDrag);
```

後片付けに `window.removeEventListener(FILE_DRAG_EVENT, onDrag);` を足し、`onDrop` の頭で `setDropping(false);` を呼ぶ。

箱に印を付け、ブラウザのドラッグも受ける。textarea の `onDragOver` と `onDrop` を箱へ移す。

```tsx
      <div ref={box} className="pc-box" data-drop={dropping ? 'true' : undefined}
        onDragOver={(e) => { if (!e.dataTransfer?.types?.includes?.('Files')) return; e.preventDefault(); setDropping(true); }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => { setDropping(false); const files = [...(e.dataTransfer?.files ?? [])]; if (!files.length) return; e.preventDefault(); send(files); }}>
```

`controls.css`

```css
.pc-box[data-drop='true'] { border-color: var(--accent); background: var(--accent-soft); }
.pc-box[data-drop='true']::after { content: 'ここに落として添付'; position: absolute; inset: 0; display: grid; place-items: center; border-radius: inherit; font-weight: 600; color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 88%, transparent); pointer-events: none; }
```

- [ ] **Step 6: 通す**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS（Task 5 の「ブラウザで欄に落としたファイルも送る」も、箱へ移した後で通ること）

- [ ] **Step 7: コミット**

```bash
git add apps/desktop/src-tauri/src packages/ui
git commit -m "feat(desktop): tell the UI where a file is being dragged so the prompt field can light up"
```

---

### Task 7: プロジェクトのファイルを探す口

**Files:**
- Create: `packages/server/src/prompt/files.ts`
- Test: `packages/server/src/prompt/files.test.ts`、`packages/server/src/http/app.test.ts`
- Modify: `packages/server/src/http/app.ts`

**Interfaces:**
- Produces:
  - `rankFiles(files: string[], query: string, limit: number): string[]`
  - `listProjectFiles(root: string, query: string, limit?: number): string[]`（既定 50。相対パス、区切りは `/`）
  - `GET /api/prompt/files?projectId=&q=` → `{ files: string[] }`

- [ ] **Step 1: 試験を書く**

`packages/server/src/prompt/files.test.ts`

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listProjectFiles, rankFiles } from './files.ts';

let root: string;
const write = (rel: string, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-files-')); });

describe('rankFiles', () => {
  const files = ['src/views/Dialog.tsx', 'src/dialog/index.ts', 'docs/dialogs.md', 'README.md', 'src/a/b/c/dialog.test.ts'];
  it('ファイル名の頭、ファイル名の途中、パスの途中の順に並べ、同じなら短いパスを先にする', () => {
    expect(rankFiles(files, 'dialog', 10)).toEqual(['docs/dialogs.md', 'src/views/Dialog.tsx', 'src/a/b/c/dialog.test.ts', 'src/dialog/index.ts']);
  });
  it('大文字と小文字を区別しない。上限で切る', () => {
    expect(rankFiles(files, 'READ', 10)).toEqual(['README.md']);
    expect(rankFiles(files, 'dialog', 2)).toHaveLength(2);
  });
  it('区切りを含む問いは、パス全体で探す', () => {
    expect(rankFiles(files, 'views/dia', 10)).toEqual(['src/views/Dialog.tsx']);
  });
});

describe('listProjectFiles', () => {
  it('git のフォルダでは、追跡しているものと、無視していない新しいものを返し、無視したものは返さない', () => {
    write('src/a.ts'); write('new.ts'); write('.gitignore', 'out/\n'); write('out/big.js');
    git('init', '-q'); git('add', 'src/a.ts', '.gitignore'); git('commit', '-q', '-m', 'init');
    const all = listProjectFiles(root, '.', 50);
    expect(all).toEqual(expect.arrayContaining(['src/a.ts', 'new.ts']));
    expect(all).not.toContain('out/big.js');
  });
  it('問いが空なら、最近変えたものを新しい順に 20 件まで返す', () => {
    write('old.ts'); write('mid.ts'); write('fresh.ts');
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(root, 'old.ts'), t - 300, t - 300);
    fs.utimesSync(path.join(root, 'mid.ts'), t - 200, t - 200);
    fs.utimesSync(path.join(root, 'fresh.ts'), t - 100, t - 100);
    expect(listProjectFiles(root, '', 50)).toEqual(['fresh.ts', 'mid.ts', 'old.ts']);
  });
  it('git でないフォルダは歩いて探し、.git と node_modules と点で始まるフォルダには入らない', () => {
    write('a.ts'); write('lib/b.ts'); write('node_modules/x/index.js'); write('.cache/y.ts'); write('.env');
    expect(listProjectFiles(root, '', 50).sort()).toEqual(['.env', 'a.ts', 'lib/b.ts']);
  });
  it('深すぎる所と、多すぎる分は切る。落ちない', () => {
    write('1/2/3/4/5/6/7/8/deep.ts');
    for (let i = 0; i < 30; i++) write(`many/f${i}.ts`);
    expect(listProjectFiles(root, 'deep', 50)).toEqual([]);
    expect(listProjectFiles(root, 'f', 5)).toHaveLength(5);
  });
  it('無いフォルダは空を返す', () => {
    expect(listProjectFiles(path.join(root, 'nope'), 'a', 50)).toEqual([]);
  });
  it('リンクをたどって外へ出ない', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    fs.symlinkSync(outside, path.join(root, 'link'));
    write('a.ts');
    expect(listProjectFiles(root, 'secret', 50)).toEqual([]);
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/prompt/files.test.ts`
Expected: FAIL（`./files.ts` が無い）

- [ ] **Step 3: 書く**

`packages/server/src/prompt/files.ts`

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 歩いて探すときの深さと件数の上限。大きなフォルダで返事を止めないためである。 */
const MAX_DEPTH = 6;
const MAX_FILES = 5000;
/** 問いが空のときに返す、最近変えたものの件数。 */
const RECENT_COUNT = 20;
/** 一覧を覚えておく長さ。打つたびに git を呼ばないためである。 */
const CACHE_MS = 10_000;
const SKIP_DIRS = new Set(['node_modules']);

const cache = new Map<string, { at: number; files: string[] }>();

function gitFiles(root: string): string[] | null {
  try {
    // -c：追跡しているもの、-o と --exclude-standard：追跡していないが無視もしていないもの。-z：改行や日本語の名前を逃がさずに受ける。
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string, depth: number) => {
    if (out.length >= MAX_FILES) return;
    let list: fs.Dirent[];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      // リンクはたどらない。プロジェクトの外へ出ないためである。
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        visit(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) out.push(r);
    }
  };
  visit(root, '', 0);
  return out;
}

function allFiles(root: string): string[] {
  const hit = cache.get(root);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.files;
  let ok = false;
  try { ok = fs.statSync(root).isDirectory(); } catch { /* 無いフォルダ */ }
  const files = ok ? (fs.existsSync(path.join(root, '.git')) ? gitFiles(root) : null) ?? walk(root) : [];
  cache.set(root, { at: now, files });
  return files;
}

/** 問いに合うものを、ファイル名の頭、ファイル名の途中、パスの途中の順に並べる。同じなら短いパスを先にする。 */
export function rankFiles(files: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const inPath = q.includes('/');
  const scored: { f: string; r: number }[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const r = inPath ? (lower.includes(q) ? 2 : 3) : base.startsWith(q) ? 0 : base.includes(q) ? 1 : lower.includes(q) ? 2 : 3;
    if (r < 3) scored.push({ f, r });
  }
  return scored.sort((a, b) => a.r - b.r || a.f.length - b.f.length || a.f.localeCompare(b.f)).slice(0, limit).map((x) => x.f);
}

/**
 * 初期プロンプト欄の `@` の候補。プロジェクトの根からの相対パスを返す。
 * 問いが空のときは、最近変えたものを新しい順に返す。
 */
export function listProjectFiles(root: string, query: string, limit = 50): string[] {
  const files = allFiles(root);
  const q = query.trim();
  if (q) return rankFiles(files, q, limit);
  const withTime: { f: string; t: number }[] = [];
  for (const f of files) {
    try { withTime.push({ f, t: fs.statSync(path.join(root, f)).mtimeMs }); } catch { /* 一覧の後で消えたもの */ }
  }
  return withTime.sort((a, b) => b.t - a.t).slice(0, Math.min(limit, RECENT_COUNT)).map((x) => x.f);
}
```

試験は同じ根で何度も呼ぶので、覚えておく分が邪魔になる。`beforeEach` で毎回新しい一時フォルダを作っているので根が変わり、影響しない（同じ試験の中で書き足してから 2 度呼ぶ形にしないこと）。

「ファイル名の頭…」の試験の期待は、`docs/dialogs.md`（頭、15 字）、`src/views/Dialog.tsx`（頭、20 字）、`src/a/b/c/dialog.test.ts`（頭、25 字）、`src/dialog/index.ts`（パスの途中）の順である。

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/server/src/prompt/files.test.ts`
Expected: PASS（9 件）。問いが空で、何万件もあるフォルダの stat が遅い場合に備え、`withTime` を作る前に `files` が `MAX_FILES` を超えていたら先頭の `MAX_FILES` 件だけを見る 1 行を足す（`const pool = files.length > MAX_FILES ? files.slice(0, MAX_FILES) : files;`）。

- [ ] **Step 5: 口の試験を書く**

`app.test.ts`

```ts
describe('GET /api/prompt/files', () => {
  it('プロジェクトのファイルを問いで探して返す', async () => {
    const id = list0ProjectId();
    const p = (await json(await get(`/api/projects/${id}`))).body as { path: string };
    fs.writeFileSync(path.join(p.path, 'prompt-files-probe.ts'), 'x');
    const r = await json(await get(`/api/prompt/files?projectId=${id}&q=prompt-files-probe`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ files: ['prompt-files-probe.ts'] });
  });
  it('projectId が無ければ 400、知らなければ 404', async () => {
    expect((await get('/api/prompt/files?q=a')).status).toBe(400);
    expect((await get('/api/prompt/files?projectId=nope&q=a')).status).toBe(404);
  });
});
```

Run: `npx vitest run packages/server/src/http/app.test.ts -t 'prompt/files'`
Expected: FAIL（404）

- [ ] **Step 6: 口を足す**

`app.ts`。import に `import { listProjectFiles } from '../prompt/files.ts';` を足し、`/prompt/commands` の後に足す。

```ts
  // 初期プロンプト欄の `@` の候補。パスの無いプロジェクト（まだ場所が決まっていないもの）では空を返す。
  api.get('/prompt/files', (c) => {
    const id = c.req.query('projectId');
    if (!id) return c.json({ error: 'projectId が要ります' }, 400);
    const project = requireProject(id);
    if (!project) return c.json({ error: 'プロジェクトが見つかりません' }, 404);
    return c.json({ files: project.path ? listProjectFiles(project.path, c.req.query('q') ?? '') : [] });
  });
```

- [ ] **Step 7: 通す**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add packages/server
git commit -m "feat(server): search project files for at-mentions in the initial prompt"
```

---

### Task 8: `@` のファイルの候補

**Files:**
- Modify: `packages/ui/src/views/primitives/PromptComposer.tsx`、`packages/ui/src/runtime/api.ts`、`packages/ui/src/test/fakeApi.ts`、`packages/ui/src/Root.tsx`、`packages/ui/src/views/NewSessionDialog.tsx`、`packages/ui/src/styles/controls.css`
- Test: `PromptComposer.test.tsx`、`api.test.ts`

**Interfaces:**
- Consumes: `GET /api/prompt/files`（Task 7）、`triggerAt` の `@`（Task 2）、`acceptText`
- Produces: `ApiClient.promptFiles(projectId: string, query: string): Promise<string[]>`。`PromptComposer` は `projectId` が null のとき `@` を使えなくする。

- [ ] **Step 1: 試験を足す**

`PromptComposer.test.tsx`

```tsx
describe('PromptComposer の @ の候補', () => {
  const files = () => vi.fn((_: string, q: string) => Promise.resolve(q ? ['src/views/Dialog.tsx', 'docs/dialogs.md'].filter((f) => f.toLowerCase().includes(q.toLowerCase())) : ['README.md']));

  it('@ を打つと、プロジェクトのファイルを問いで読み、ファイル名とフォルダを分けて出す', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '見て @dia');
    await act(async () => {});
    expect(f).toHaveBeenLastCalledWith('p1', 'dia');
    const opt = screen.getByRole('option', { name: 'src/views/Dialog.tsx' });
    expect(opt).toHaveTextContent('Dialog.tsx');
    expect(opt).toHaveTextContent('src/views');
  });
  it('Enter で @パス と空白を入れる', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({ files: files() }, { projectId: 'p1', onValue });
    type(ta, '見て @dia');
    await act(async () => {});
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith('見て @src/views/Dialog.tsx ');
  });
  it('古い問いの返事が後から届いても、いまの問いの結果を上書きしない', async () => {
    let slow: (v: string[]) => void = () => {};
    const f = vi.fn((_: string, q: string) => (q === 'd' ? new Promise<string[]>((r) => { slow = r; }) : Promise.resolve(['docs/dialogs.md'])));
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@d');
    type(ta, '@di');
    await act(async () => {});
    await act(async () => { slow(['OLD.md']); });
    expect(options()).toEqual(['docs/dialogs.md']);
  });
  it('プロジェクトが無い（スクラッチ）と、@ では候補を出さず、ボタンも押せない', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: null });
    type(ta, '@a');
    await act(async () => {});
    expect(f).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    const b = screen.getByRole('button', { name: 'ファイル' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('title', 'プロジェクトを選ぶと使えます');
  });
  it('道具の段の「ファイル」は、カーソルの位置に @ を入れて候補を開く。前が空白でなければ空白を挟む', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({ files: files() }, { projectId: 'p1', onValue });
    type(ta, '見て');
    fireEvent.click(screen.getByRole('button', { name: 'ファイル' }));
    await act(async () => {});
    expect(onValue).toHaveBeenLastCalledWith('見て @');
    expect(screen.getByRole('option', { name: 'README.md' })).toBeInTheDocument();
  });
  it('ファイルが読めなければ、候補の中にその旨を出す', async () => {
    const { ta } = await mount({ files: () => Promise.reject(new Error('x')) }, { projectId: 'p1' });
    type(ta, '@a');
    await act(async () => {});
    expect(screen.getByText('読めませんでした')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/ui/src/views/primitives/PromptComposer.test.tsx -t '@ の候補'`
Expected: FAIL

- [ ] **Step 3: 部品に `@` を足す**

`PromptComposer.tsx`。状態を足す。

```tsx
  // @ の候補。問いごとに読み、古い返事は捨てる。
  const [files, setFiles] = useState<{ key: string; list: string[] | 'failed' } | null>(null);
```

`open` の判定を、`@` も含む形に替える。

```tsx
  const trigger = focused ? triggerAt(props.value, caret) : null;
  // @ はプロジェクトのファイルを探すので、プロジェクトが無い（スクラッチ）ときは出さない。
  const usable = trigger !== null && (trigger.kind === '/' || props.projectId !== null);
  const open = usable && dismissed !== keyOf(trigger!);
  const mode = open ? trigger!.kind : null;
  const fileKey = mode === '@' ? `${props.projectId}\n${trigger!.query}` : null;
  const fileList = fileKey !== null && files?.key === fileKey ? files.list : null;
  const sections = mode === '/' && Array.isArray(commands) ? arrangeCommands(commands, trigger!.query) : [];
  const flat: string[] = mode === '/' ? sections.flatMap((s) => s.items.map((c) => c.name)) : Array.isArray(fileList) ? fileList : [];
```

`flat` が名前の配列になったので、`onKeyDown` の `accept(flat[current]!.name)` を `accept(flat[current]!)` に替える。

読み込みを足す。

```tsx
  useEffect(() => {
    if (fileKey === null || props.projectId === null) return;
    let live = true;
    const query = fileKey.slice(fileKey.indexOf('\n') + 1);
    assist.files(props.projectId, query).then(
      (list) => { if (live) setFiles({ key: fileKey, list }); },
      () => { if (live) setFiles({ key: fileKey, list: 'failed' }); },
    );
    // 次の問いに移ったら、この問いの返事は捨てる。
    return () => { live = false; };
  }, [assist, fileKey, props.projectId]);
```

「ファイル」のボタンの処理を足す。

```tsx
  const startAt = () => {
    const el = ta.current;
    if (!el) return;
    const at = el.selectionStart ?? props.value.length;
    const before = props.value.slice(0, at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${pad}@${props.value.slice(at)}`;
    pendingCaret.current = at + pad.length + 1;
    setCaret(pendingCaret.current);
    setDismissed(null);
    setFocused(true);
    props.onChange(next);
    el.focus();
  };
```

道具の段の「スキル」の後に足す。

```tsx
        <button type="button" className="pc-tool" disabled={props.projectId === null} title={props.projectId === null ? 'プロジェクトを選ぶと使えます' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={startAt}><span className="pc-tool-key" aria-hidden="true">@</span>ファイル</button>
```

候補の中身を、種類で描き分ける。`role="listbox"` の `aria-label` を `mode === '@' ? 'ファイル' : 'スキルとコマンド'` にし、`/` の部分（読み込み中・失敗・一致なし・`sections.map`）を `mode === '/' && (<>…</>)` で包んで、その後に足す。

```tsx
            {mode === '@' && (
              <>
                {fileList === null && <div className="listbox-empty">読み込んでいます</div>}
                {fileList === 'failed' && <div className="listbox-empty">読めませんでした</div>}
                {Array.isArray(fileList) && !fileList.length && <div className="listbox-empty">一致するものはありません</div>}
                {Array.isArray(fileList) && fileList.length > 0 && !trigger!.query && <div className="listbox-group-title">最近変えたファイル</div>}
                {Array.isArray(fileList) && fileList.map((f, i) => {
                  const cut = f.lastIndexOf('/');
                  return (
                    <div key={f} id={`${listId}-${i}`} role="option" aria-selected={i === current} aria-label={f} data-value={f} data-active={i === current ? 'true' : undefined}
                      className="listbox-opt pc-file" onMouseDown={(e) => { e.preventDefault(); accept(f); }} onMouseMove={() => { if (i !== current) setActive(i); }}>
                      <span className="pc-file-name"><Marked text={f.slice(cut + 1)} query={trigger!.query.slice(trigger!.query.lastIndexOf('/') + 1)} /></span>
                      {cut >= 0 && <span className="pc-file-dir">{f.slice(0, cut)}</span>}
                    </div>
                  );
                })}
              </>
            )}
```

置き直しの `useLayoutEffect` の依存は `flat.length` のままで足りる。部品の先頭の説明に「`@` でプロジェクトのファイルの候補を出す」を足す。

`controls.css`

```css
.pc-file { gap: calc(var(--u) * 2.5); align-items: baseline; }
.pc-file-name { flex: none; font-weight: 600; }
.pc-file-dir { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 4: api と Root をつなぐ**

`api.ts`

```ts
  promptFiles(projectId: string, query: string): Promise<string[]>;
```

```ts
    promptFiles: (projectId, query) => call<{ files: string[] }>(`/api/prompt/files${qs({ projectId, q: query })}`).then((r) => r.files),
```

`fakeApi.ts` にも足す。`api.test.ts` に足す。

```ts
  it('promptFiles は projectId と問いを付けて読み、files を取り出す', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ files: ['a.ts'] })));
    const api = createApi(fetchFn as unknown as typeof fetch);
    expect(await api.promptFiles('p1', 'a')).toEqual(['a.ts']);
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/prompt/files?projectId=p1&q=a');
    await api.promptFiles('p1', '');
    expect(fetchFn.mock.calls[1]![0]).toBe('/api/prompt/files?projectId=p1');
  });
```

`Root.tsx` の `promptAssist` の `files` を替える。

```tsx
      files: (projectId, query) => api.promptFiles(projectId, query),
```

`NewSessionDialog.tsx` は、パスの無いプロジェクトでも `@` を使えなくするため、`projectId` を次にする。

```tsx
  // @ の候補はプロジェクトのフォルダを探すので、スクラッチとパスの無いプロジェクトでは渡さない。/ の候補は自分のスキルだけになる。
  const assistProject = scratch || !choice ? null : props.projects.find((p) => p.id === choice)?.path ? choice : null;
```

`<PromptComposer ... projectId={assistProject} ... />` にする。

- [ ] **Step 5: 通す**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/ui
git commit -m "feat(ui): mention project files with an at sign in the initial prompt"
```

---

### Task 9: 説明を直し、ビルドして実物で確かめる

**Files:**
- Modify: `docs/design.md`、`docs/superpowers/specs/2026-10-06-prompt-composer-design.md`

- [ ] **Step 1: 設計の説明を直す**

`docs/design.md` で、新しいセッションのダイアログを説明している節を探し（`grep -n '初期プロンプト' docs/design.md`）、次を足す。HTTP の口を並べている節があれば、5 つの口も足す。「読み取り専用」の節には、`~/.claude` から新しく読むもの（`skills`、`commands`、`plugins/installed_plugins.json`、`settings.json` の `enabledPlugins`、`history.jsonl`）を足す。どれも読むだけである。

```markdown
初期プロンプトの欄（PromptComposer）は、Claude Code の入力欄でできる主なことを受ける。

- 先頭の `/` で、スキルとコマンドの候補を出す。自分のもの、選んだプロジェクトのもの、有効なプラグインのもの、組み込みのうち最初の一言になる 6 つ。打つ前は、最初の一言になった回数の多い 5 つを「よく使う」として先頭に置く。
- 先頭か空白の直後の `@` で、選んだプロジェクトのファイルの候補を出す。スクラッチとパスの無いプロジェクトでは使えない。
- 画像とファイルは、貼り付け、欄へのドロップ、添付ボタンで付ける。`~/.agent-hangar/drops/` に置き（1 件 20 MB まで、7 日で消える）、起動のとき本文の後にパスを 1 行ずつ足す。起動の API は変えない。
- 下書きは添付も覚える。開いたときに置き場から消えていた添付は外す。
```

仕様書の「作り」の UI の節の「候補と添付の読み書きは、いまの作りに合わせて Intent と Effect で運ぶ。画面は fetch を呼ばない。」を次に直す。

```markdown
- 候補と添付の読み書きは、`ResolveProjectDialog` の候補と同じく Root が api を呼び、`PromptAssistContext` で部品に配る。画面は fetch を呼ばない。下書きだけは Intent（`session.new.draft`）で運ぶ。
```

- [ ] **Step 2: 全部の試験と型を通す**

Run: `npm run typecheck && npm test && (cd apps/desktop/src-tauri && cargo test)`
Expected: すべて PASS

- [ ] **Step 3: ビルドする**

UI とデスクトップをビルドする。手順は、このリポジトリのいつものもの（UI の vite、`bundle-server`、`tauri build`）で、`package.json` の scripts を見て同じ順に打つ。ビルドの後、利用者の `npm run dev` のサーバ（4177）は**ポートで止めない**。起動ログで自分の PID を確かめ、止めるのは自分が起こしたものだけにする。

- [ ] **Step 4: WebKit で撮って確かめる**

確認用のサーバを、利用者のものと別のポートと別の `HANGAR_HOME` で起こす（`env -u HANGAR_PARENT_PID -u HANGAR_RUN_ID -u HANGAR_CLOUD_DIR …` で、受け継いだ変数を外す）。`~/workspace/hangar-explainers/design-shots.mjs` の `newSession` の撮り方にならい、次を 900×600 と 1512×868 で撮って、目で見る。

1. `/` を打った直後（よく使う、群、札）。
2. `/g` まで打った後（絞り込み、塗り）。
3. 画面の下端近くにダイアログがある窓の高さで `/`（候補が上に開く）。
4. 画像 1 つとログ 1 つを添付した後（絵の札、拡張子の札）。
5. `@` を打った直後と、打ち進めた後。
6. スクラッチを選んだとき（「ファイル」が押せない）。

崩れ（はみ出し、折り返し、重なり）があれば直し、撮り直す。

- [ ] **Step 5: 実際に起動して確かめる**

ビルドしたアプリ（`/Applications` には入れず、ビルドの出力を直に開く。起動元のパスを確かめる）で、新しいセッションのダイアログから次の初期プロンプトで起動する。

- `/` の候補から利用者のスキルを 1 つ選ぶ（例：`/toggle off`）。→ スキルとして実行される。
- スクリーンショットを Finder から欄へ落とす（ドラッグ中に欄の色が変わる）＋「この画像に何が写っている？」。→ Claude が画像を読んで答える。
- `@` の候補からファイルを 1 つ選ぶ＋「このファイルの役目を一言で」。→ 起動と同時に読み込まれる。
- 添付を付けたままダイアログを閉じて開き直す。→ 下書きの札と添付が戻る。

4 つの結果を、見たままに記録する。通らなかったものは、通ったと書かない。

- [ ] **Step 6: コミット**

```bash
git add docs
git commit -m "docs: describe suggestions, mentions, and attachments in the initial prompt field"
```

---

## Self-Review の記録

- 仕様の各節と Task の対応：`/` の候補に出すもの→1、並べ方と行→2・3、きっかけとキー→2・3・8、添付→4・5、`@`→7・8、入口（道具の段、欄が伸びる）→3・5・8、サーバの口→1・4・7、殻のドラッグ→6、失敗のとき→3・5・8、試験と確かめ→各 Task と 9。
- 仕様から変えた点：読み書きの運び方（Intent と Effect → Root が api を呼んで Context で配る）。先例（`ResolveProjectDialog`）に合わせたもので、Task 9 で仕様書も直す。口を 1 つ足した（`POST /api/drops/existing`。下書きの添付が消えていないかを確かめる）。
