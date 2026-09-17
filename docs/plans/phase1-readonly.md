# フェーズ 1 実装計画（サーバ、インデクサ、読み取り専用 UI）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手元の Claude Code セッションをすべて索引化し、プロジェクト、セッション一覧、トランスクリプト、検索、土台の要約をブラウザで読める状態にする。

**Architecture:** npm workspaces のモノレポに `packages/shared`、`packages/server`、`packages/ui`、`packages/cli` を置く。サーバは Hono で HTTP と静的配信を行い、`ws` で WebSocket を張り、better-sqlite3 に索引を持つ。Claude Code の jsonl は読み取り専用で、バイト位置だけを DB に持ち、本文はファイルから読む。UI は Root を頂点とする木で、Passive View に Presenter が props を渡し、操作は Intent として木を上へ伝播し、Root の Mediator（自作の純関数の状態機械）が裁定する。

**Tech Stack:** TypeScript（`~6.0`）、Node 22、npm workspaces、vitest 5、hono 4、@hono/node-server 2、ws 8、better-sqlite3 13（SQLite FTS5 trigram）、uuid 14（UUID v7）、commander 15、React 19、Vite 8、@tanstack/react-virtual 3、@testing-library/react 16、jsdom 30、@fontsource-variable/inter と @fontsource-variable/jetbrains-mono。

**Spec:** `docs/design.md`

## Global Constraints

- `~/.claude/` 配下のファイルを書き換えない。読むだけにする。テストは `HANGAR_CLAUDE_DIR` と `HANGAR_HOME` を一時ディレクトリに向けて行い、実物の `~/.claude` と `~/.agent-hangar` に触れない。
- サーバは `127.0.0.1` のポート `4177` にだけバインドする。データは `~/.agent-hangar/hangar.db`。
- 共有テーブルの行は `id`（UUID v7）、`updated_at`（ミリ秒）、`deleted_at`、`origin_device` を持ち、書き込みは必ず `changes` に 1 行を追記する。
- FTS5 は `tokenize = 'trigram'`。検索語はトークンごとに二重引用符で包む。
- 巨大な jsonl を DB に写さない。`event_index` はバイト位置だけを持ち、`event_fts` には利用者の発言、アシスタントの本文、ツール呼び出しの要約（ファイルパスとコマンド）だけを、1 件 20,000 字まで入れる。ツールの結果本文と `isMeta` の行は入れない。
- UI のコンポーネントは props だけで描く Passive View にし、状態を持たず、`fetch` を呼ばず、他の View を import しない。操作は `useEmit()` で得た `emit` に Intent を渡すことでだけ外へ伝える。
- Mediator と Presenter は DOM に依存しない純関数で、vitest の `node` 環境でテストする。View のテストだけ `jsdom` 環境で行う。
- 見た目はライト主体で OS 設定に従ってダークも持つ。色は `:root` のトークンで定義し、ダークで再定義する。動きは 150 から 250 ミリ秒に限り、グロー、脈動、タイピング風、シマー、スケルトンは使わない。一覧の行高は 28px、識別子とパスと時刻と数値は等幅。
- 日本語の文書とコメントは一文ごとに改行し、地の文でダッシュと中黒を使わない。
- コミットメッセージは英語の Conventional Commits 形式で、末尾に `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` を付ける。パッケージ管理は npm（pnpm は使わない）。
- フェーズ 1 では起動、ターミナル、MCP、TODO、メモ、アーティファクト、使用量、同期を実装しない。`Provider` の `launchCommand` と `resumeCommand` は `not implemented` を投げる。UI の対応する Intent は Mediator が受けてトースト「フェーズ 2 で実装」を出す。

## 前提（この計画で決めたこと）

設計文書が定めていない細部を、この計画で次のように決める。
実装後に `docs/design.md` へ反映する（Task 30）。

- `event_index` の一意制約は `(session_id, ifnull(parent_agent, ''), seq)` にする。サブエージェントの本文は別ファイルで独立に伸びるので、主線と `seq` の空間を分ける。
- 端末ローカルのテーブル `session_stats` を追加する。ターン数、モデル、effort、変更ファイル数、PR の URL、トークン数を索引から導出して持つ。共有しない。
- 土台の要約の `state` は、レジストリに生きた項目があれば `in_progress`、無ければ `done` にする。UI は `source = 'baseline'` の状態を控えめに描く。
- サブエージェントの表示は、サブエージェントファイルの先頭の記録から `subagent` イベントを作り、親の時系列でその直前にある `Agent` か `Task` のツール呼び出しの下にネストする。該当が無ければ独立した項目として出す。
- セッションの表示名は、レジストリの `name`（`nameSource` が `user`）、本文の `custom-title`、`agent-name`、`ai-title`、最初の発言の先頭 40 字、の順に決める。
- 開発時は Vite（ポート 5173）が `/api` と `/ws` をサーバへプロキシし、プロキシがトークンを `Authorization` ヘッダに付ける。本番はサーバが `packages/ui/dist` を配信し、`index.html` の応答で `hangar_token` クッキー（HttpOnly、SameSite=Strict）を渡す。
- 一覧の初期データは `GET /api/bootstrap` で全セッションの軽い行をまとめて返す。手元の規模（数百セッション）では 1MB 未満で、ページングは持たない。

## ファイル構成

```
package.json                      workspaces、共通スクリプト
tsconfig.base.json                strict、ESM、bundler 解決
vitest.config.ts                  projects: packages/*
.github/workflows/ci.yml          typecheck、test、build
packages/shared/src/
  ids.ts                          newId()（UUID v7）、shortId()
  transcript.ts                   TranscriptEvent、Attachment
  intent.ts                       Intent、Route、ProjectStatus、SearchFilter、LaunchParams
  route.ts                        parseRoute()、formatRoute()
  api.ts                          DTO 群（ProjectDto、SessionDto、...）
  events.ts                       ServerEvent
  fts.ts                          toFtsQuery()
  index.ts                        再エクスポート
packages/server/src/
  config/paths.ts                 hangarHome()、claudeDir()、token、deviceId、settings
  db/open.ts                      openDb()、マイグレーション適用
  db/migrations.ts                共有テーブル、changes、端末ローカルのテーブル、FTS の SQL
  db/shared.ts                    upsertShared()、softDeleteShared()
  db/queries.ts                   DTO への問い合わせ
  provider/types.ts               Provider、DiscoveredFile、LiveSession
  provider/claude-code/lines.ts   readNewLines()
  provider/claude-code/normalize.ts  normalizeRecord()、recordFacts()、indexTexts()
  provider/claude-code/discover.ts   listTranscriptFiles()、readHistoryIndex()、mangleCwd()
  provider/claude-code/registry.ts   readRegistry()、RegistryWatcher
  provider/claude-code/index.ts   claudeCodeProvider
  indexer/indexFile.ts            indexFile()
  indexer/baseline.ts             buildBaselineSummary()、writeBaselineIfNeeded()
  indexer/service.ts              IndexerService（全走査、監視、進行）
  projects/registry.ts            syncProjectsFromWorkspace()、assignSessions()、checkProjectRoots()、resolveProject()
  transcript/read.ts              readEvents()
  search/search.ts                searchSessions()
  http/auth.ts                    originCheck()、authMiddleware()
  http/app.ts                     createApp()
  ws/hub.ts                       EventHub
  server.ts                       startServer()
  main.ts                         エントリ
packages/server/test/fixtures/    匿名化した jsonl と registry の見本
packages/cli/src/                 hangar setup | start | status | open
packages/ui/src/
  main.tsx、Root.tsx
  styles/tokens.css、styles/base.css
  intent/chain.tsx                IntentContext、useEmit、IntentBoundary
  store/store.ts                  Store、applyServerEvent()、applyBootstrap()
  mediator/types.ts               State、Input、Effect
  mediator/{screen,overlay,connection,sessionView}.ts
  mediator/transition.ts          transition()、initialState()
  runtime/api.ts                  ApiClient
  runtime/ws.ts                   WsClient
  runtime/runtime.ts              createRuntime()（dispatch、効果の実行、購読）
  presenters/*.ts                 画面ごとの props 計算
  views/primitives/*.tsx          VirtualList、StatusDot、RelativeTime、Mono、Button
  views/*.tsx                     Shell、Sidebar、Header、各 Screen、Overlays
```

## インターフェース一覧

後のタスクが依存する名前と型を先にまとめる。
各タスクの Interfaces はこの一覧の抜粋である。

```ts
// packages/shared/src/transcript.ts
export type Attachment = { kind: 'image' | 'file'; name?: string };
export type TranscriptEvent =
  | { kind: 'user'; seq: number; ts?: number; text: string; attachments?: Attachment[] }
  | { kind: 'assistant'; seq: number; ts?: number; text: string; model?: string }
  | { kind: 'thinking'; seq: number; ts?: number; text: string }
  | { kind: 'tool_call'; seq: number; ts?: number; toolId: string; name: string; input: unknown; summary: string; filePath?: string }
  | { kind: 'tool_result'; seq: number; ts?: number; toolId: string; text: string; isError: boolean }
  | { kind: 'subagent'; seq: number; ts?: number; agentId: string; label: string }
  | { kind: 'system'; seq: number; ts?: number; text: string }
  | { kind: 'meta'; seq: number; ts?: number; name: string; value: unknown };

// packages/shared/src/api.ts
export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type LiveStatus = 'busy' | 'idle' | 'waiting';
export type SummaryState = 'in_progress' | 'done' | 'blocked' | 'abandoned';
export type SummarySource = 'baseline' | 'in_session' | 'post_hoc';
export type ProjectDto = { id: string; name: string; status: ProjectStatus; isScratch: boolean; path: string | null; resolved: boolean; lastActivityAt: number | null; runningCount: number; openTodoCount: number; memoHead: string | null; updatedAt: number };
export type SessionStatsDto = { turns: number; model: string | null; effort: string | null; filesChanged: number; prUrl: string | null; inputTokens: number; outputTokens: number };
export type SessionSummaryDto = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[]; source: SummarySource; sourceModel: string | null; basedOnTurns: number; updatedAt: number };
export type LiveSessionDto = { sessionId: string; status: LiveStatus; name: string | null; nameSource: string | null; cwd: string; pid: number };
export type SessionDto = { id: string; provider: 'claude-code'; providerSessionId: string; projectId: string | null; name: string | null; cwd: string; firstPrompt: string | null; aiTitle: string | null; startedAt: number | null; lastActivityAt: number | null; memo: string | null; hasTranscript: boolean; live: LiveStatus | null; summary: SessionSummaryDto | null; stats: SessionStatsDto };
export type SettingsDto = { workspaceRoot: string; claudeDir: string };
export type IndexProgressDto = { phase: 'idle' | 'scanning' | 'indexing' | 'rebuilding'; done: number; total: number };
export type BootstrapDto = { device: { id: string; name: string }; settings: SettingsDto; projects: ProjectDto[]; sessions: SessionDto[]; live: LiveSessionDto[]; index: IndexProgressDto; version: string };
export type EventsPageDto = { sessionId: string; events: TranscriptEvent[]; total: number; nextSeq: number | null };
export type SearchParamsDto = { q: string; projectId?: string; since?: number; until?: number; running?: boolean; file?: string; limit?: number };
export type SearchHitDto = { sessionId: string; matchCount: number; snippets: { seq: number; role: string; text: string }[] };
export type SearchResultDto = { hits: SearchHitDto[]; total: number };
export type ResolveAction = { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' };

// packages/shared/src/events.ts
export type ServerEvent =
  | { type: 'ready'; version: string }
  | { type: 'project.upsert'; project: ProjectDto }
  | { type: 'project.unresolved'; projectId: string }
  | { type: 'session.upsert'; session: SessionDto }
  | { type: 'live.update'; live: LiveSessionDto[] }
  | { type: 'transcript.appended'; sessionId: string; count: number }
  | { type: 'index.progress'; progress: IndexProgressDto }
  | { type: 'toast'; level: 'info' | 'error'; message: string };

// packages/shared/src/route.ts
export type Route =
  | { name: 'home' } | { name: 'projects' } | { name: 'project'; id: string }
  | { name: 'session'; id: string } | { name: 'sessions'; q?: string } | { name: 'settings' };
export function parseRoute(hash: string): Route;
export function formatRoute(route: Route): string;   // '#/session/<id>' の形

// packages/shared/src/fts.ts
export function toFtsQuery(text: string): string | null;   // 空なら null

// packages/server/src/provider/types.ts
export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null };
export type LiveSession = LiveSessionDto;

// packages/server/src/provider/claude-code/normalize.ts
export type RecordFacts = { cwd?: string; ts?: number; model?: string; effort?: string; usage?: { input: number; output: number }; aiTitle?: string; customTitle?: string; agentName?: string; prUrl?: string; isUserTurn: boolean };
export function normalizeRecord(raw: unknown, seqStart: number, agentId: string | null): TranscriptEvent[];
export function recordFacts(raw: unknown): RecordFacts;
export function indexTexts(events: TranscriptEvent[]): { seq: number; role: 'user' | 'assistant' | 'tool'; text: string }[];

// packages/server/src/provider/claude-code/lines.ts
export function readNewLines(path: string, fromByte: number): { lines: { offset: number; length: number; text: string }[]; nextByte: number };

// packages/server/src/indexer/indexFile.ts
export function indexFile(db: Db, file: DiscoveredFile, opts: { deviceId: string; indexerVersion: number }): { sessionId: string; appended: number; changed: boolean };

// packages/ui/src/mediator/types.ts
export type Input =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent };
export type RuntimeEvent =
  | { type: 'ws.open' } | { type: 'ws.close' } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto };
export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'api.bootstrap' } | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number }
  | { kind: 'api.search'; params: SearchParamsDto }
  | { kind: 'api.setProjectStatus'; projectId: string; status: ProjectStatus }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto> } | { kind: 'api.rebuildIndex' }
  | { kind: 'ws.connect' } | { kind: 'ws.reconnectAfter'; ms: number }
  | { kind: 'focus'; target: 'search' }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  | { kind: 'storage.save'; key: string; value: unknown };
export function transition(state: State, input: Input): { state: State; effects: Effect[] };
```

---

### Task 1: モノレポの土台と CI

**Files:**
- Create: `package.json`、`tsconfig.base.json`、`vitest.config.ts`、`.gitignore`、`.github/workflows/ci.yml`
- Create: `packages/shared/package.json`、`packages/shared/tsconfig.json`、`packages/shared/vitest.config.ts`、`packages/shared/src/ids.ts`、`packages/shared/src/index.ts`
- Test: `packages/shared/src/ids.test.ts`

**Interfaces:**
- Produces: `newId(): string`（UUID v7）、`shortId(id: string): string`（ハイフンを除いた先頭 8 文字）。以後のすべての共有テーブルの `id` はこれで作る。
- Produces: 各パッケージは `"main": "./src/index.ts"` で TypeScript のソースをそのまま公開する。サーバと CLI は `tsx` で動かし、UI は Vite が解決する。ビルド成果物はフェーズ 1 では UI だけである。

- [ ] **Step 1: ルートの設定ファイルを書く**

`package.json`：

```json
{
  "name": "agent-hangar",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "vitest run",
    "build": "npm run build --workspaces --if-present",
    "dev": "npm run dev --workspace packages/server & npm run dev --workspace packages/ui & wait"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "~6.0.3",
    "vitest": "^5.0.1"
  }
}
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: ['packages/*'] } });
```

`.gitignore`：

```
node_modules/
dist/
coverage/
*.tsbuildinfo
.DS_Store
```

`.github/workflows/ci.yml`：

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: shared パッケージの骨格を書く**

`packages/shared/package.json`：

```json
{
  "name": "@agent-hangar/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "typecheck": "tsc -p ." },
  "dependencies": { "uuid": "^14.0.2" }
}
```

`packages/shared/tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'shared', environment: 'node', include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 3: 失敗するテストを書く**

`packages/shared/src/ids.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { newId, shortId } from './ids.ts';

describe('newId', () => {
  it('UUID v7 の形をしている', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('連続して作ると辞書順が時刻順になる', () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
  });
});

describe('shortId', () => {
  it('ハイフンを除いた先頭 8 文字を返す', () => {
    expect(shortId('01926b3c-9d2e-7abc-8def-0123456789ab')).toBe('01926b3c');
  });
});
```

- [ ] **Step 4: 依存を入れてテストが失敗することを確かめる**

Run: `npm install && npx vitest run packages/shared`
Expected: FAIL（`./ids.ts` が見つからない）

- [ ] **Step 5: 実装する**

`packages/shared/src/ids.ts`：

```ts
import { v7 as uuidv7 } from 'uuid';

/** 共有テーブルの行 ID。端末をまたいで衝突せず、時刻順に並ぶ。 */
export function newId(): string {
  return uuidv7();
}

/** 表示用の短い ID。tmux セッション名などに使う。 */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}
```

`packages/shared/src/index.ts`：

```ts
export * from './ids.ts';
```

- [ ] **Step 6: テストと型検査が通ることを確かめる**

Run: `npx vitest run packages/shared && npm run typecheck`
Expected: PASS（3 件）、型エラーなし

- [ ] **Step 7: コミット**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.config.ts .gitignore .github packages/shared
git commit -m "chore: monorepo scaffold with shared package and ci"
```

---

### Task 2: shared の型、ルート、FTS クエリ

**Files:**
- Create: `packages/shared/src/transcript.ts`、`packages/shared/src/api.ts`、`packages/shared/src/events.ts`、`packages/shared/src/intent.ts`、`packages/shared/src/route.ts`、`packages/shared/src/fts.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/route.test.ts`、`packages/shared/src/fts.test.ts`

**Interfaces:**
- Produces: 「インターフェース一覧」の `TranscriptEvent`、DTO 群、`ServerEvent`、`Route`、`parseRoute`、`formatRoute`、`toFtsQuery`、および設計文書の `Intent` 共用体。

- [ ] **Step 1: 型ファイルを書く**

`packages/shared/src/transcript.ts` と `packages/shared/src/api.ts` と `packages/shared/src/events.ts` は「インターフェース一覧」の定義をそのまま書く。

`packages/shared/src/intent.ts`：

```ts
import type { ProjectStatus, ResolveAction, SettingsDto } from './api.ts';
import type { Route } from './route.ts';

export type ProjectId = string;
export type SessionId = string;
export type RunId = string;
export type TabId = string;
export type TodoId = string;
export type ArtifactId = string;

export type SearchFilter = { projectId?: string; since?: number; until?: number; running?: boolean; file?: string };
export type LaunchParams = { projectId?: string; scratch?: boolean; name?: string; prompt?: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[] };
export type PaletteCommand = { id: string; label: string };
export type Settings = SettingsDto;

export type Intent =
  | { type: 'nav.go'; to: Route }
  | { type: 'palette.open' } | { type: 'palette.close' } | { type: 'palette.run'; command: PaletteCommand }
  | { type: 'search.query'; text: string } | { type: 'search.filter'; patch: Partial<SearchFilter> }
  | { type: 'project.open'; id: ProjectId } | { type: 'project.setStatus'; id: ProjectId; status: ProjectStatus }
  | { type: 'project.new.open' } | { type: 'project.new.submit'; name: string; gitInit: boolean; startSession: boolean }
  | { type: 'project.resolve'; id: ProjectId; action: ResolveAction }
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'memo.save'; projectId: ProjectId; markdown: string }
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.add'; projectId: ProjectId; url: string }
  | { type: 'session.open'; id: SessionId } | { type: 'session.setMemo'; id: SessionId; text: string }
  | { type: 'session.new.open'; projectId?: ProjectId; scratch?: boolean } | { type: 'session.new.submit'; params: LaunchParams }
  | { type: 'session.resume'; id: SessionId } | { type: 'session.fork'; id: SessionId } | { type: 'session.kill'; runId: RunId }
  | { type: 'session.openTerminalApp'; runId: RunId } | { type: 'session.openEditor'; sessionId: SessionId }
  | { type: 'session.promote.open'; id: SessionId } | { type: 'session.promote.submit'; id: SessionId; name: string; moveFiles: boolean }
  | { type: 'session.takeover'; id: SessionId; force: boolean }
  | { type: 'summary.toggle'; sessionId: SessionId } | { type: 'summary.regenerate'; sessionId: SessionId }
  | { type: 'tab.open'; sessionId: SessionId; kind: 'agent' | 'shell' } | { type: 'tab.close'; tabId: TabId } | { type: 'tab.select'; tabId: TabId }
  | { type: 'split.toggle' } | { type: 'transcript.toggle' }
  | { type: 'transcript.showThinking'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.showRaw'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.follow'; sessionId: SessionId; follow: boolean }
  | { type: 'transcript.loadMore'; sessionId: SessionId }
  | { type: 'transcript.selectAgent'; sessionId: SessionId; agentId: string | null }
  | { type: 'index.rebuild' }
  | { type: 'overlay.close' }
  | { type: 'toast.dismiss'; id: string }
  | { type: 'sync.now' } | { type: 'sync.pause'; paused: boolean }
  | { type: 'settings.update'; patch: Partial<Settings> };
```

設計文書の一覧に、フェーズ 1 の読み取り専用画面に必要な `transcript.*`（`selectAgent` を含む）、`index.rebuild`、`overlay.close`、`toast.dismiss` を加えている。

- [ ] **Step 2: 失敗するテストを書く**

`packages/shared/src/route.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from './route.ts';

describe('parseRoute', () => {
  it('空と #/ は home', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
  });
  it('各画面を読む', () => {
    expect(parseRoute('#/projects')).toEqual({ name: 'projects' });
    expect(parseRoute('#/project/p1')).toEqual({ name: 'project', id: 'p1' });
    expect(parseRoute('#/session/s1')).toEqual({ name: 'session', id: 's1' });
    expect(parseRoute('#/sessions')).toEqual({ name: 'sessions' });
    expect(parseRoute('#/sessions?q=%E5%8B%95%E7%94%BB%20x')).toEqual({ name: 'sessions', q: '動画 x' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
  });
  it('知らない経路は home', () => {
    expect(parseRoute('#/nope/1')).toEqual({ name: 'home' });
  });
});

describe('formatRoute', () => {
  it('parseRoute と往復する', () => {
    const routes = [
      { name: 'home' }, { name: 'projects' }, { name: 'project', id: 'p1' },
      { name: 'session', id: 's1' }, { name: 'sessions', q: '動画 x' }, { name: 'sessions' }, { name: 'settings' },
    ] as const;
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });
});
```

`packages/shared/src/fts.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { toFtsQuery } from './fts.ts';

describe('toFtsQuery', () => {
  it('トークンごとに二重引用符で包む', () => {
    expect(toFtsQuery('agent-hangar 動画チャンネル')).toBe('"agent-hangar" "動画チャンネル"');
  });
  it('二重引用符は二つ重ねて逃がす', () => {
    expect(toFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });
  it('3 文字未満のトークンは trigram で当たらないので落とす', () => {
    expect(toFtsQuery('ls docs/design.md')).toBe('"docs/design.md"');
  });
  it('残るトークンが無ければ null', () => {
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('  a  b ')).toBeNull();
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/shared`
Expected: FAIL（`route.ts` と `fts.ts` が無い）

- [ ] **Step 4: 実装する**

`packages/shared/src/route.ts`：

```ts
export type Route =
  | { name: 'home' } | { name: 'projects' } | { name: 'project'; id: string }
  | { name: 'session'; id: string } | { name: 'sessions'; q?: string } | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart);
  switch (parts[0]) {
    case undefined: return { name: 'home' };
    case 'projects': return { name: 'projects' };
    case 'project': return parts[1] ? { name: 'project', id: parts[1] } : { name: 'projects' };
    case 'session': return parts[1] ? { name: 'session', id: parts[1] } : { name: 'home' };
    case 'sessions': { const q = params.get('q'); return q ? { name: 'sessions', q } : { name: 'sessions' }; }
    case 'settings': return { name: 'settings' };
    default: return { name: 'home' };
  }
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home': return '#/';
    case 'projects': return '#/projects';
    case 'project': return `#/project/${route.id}`;
    case 'session': return `#/session/${route.id}`;
    case 'sessions': return route.q ? `#/sessions?q=${encodeURIComponent(route.q)}` : '#/sessions';
    case 'settings': return '#/settings';
  }
}
```

`packages/shared/src/fts.ts`：

```ts
/**
 * 利用者の入力を FTS5 の MATCH 式に変える。
 * ハイフンを含む語を素のまま渡すと列指定と解釈されるので、トークンごとに二重引用符で包む。
 * trigram トークナイザは 3 文字未満の語に当たらないので、その語は落とす。
 */
export function toFtsQuery(text: string): string | null {
  const tokens = text.split(/\s+/).map((t) => t.trim()).filter((t) => [...t].length >= 3);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}
```

`packages/shared/src/index.ts`：

```ts
export * from './ids.ts';
export * from './transcript.ts';
export * from './api.ts';
export * from './events.ts';
export * from './intent.ts';
export * from './route.ts';
export * from './fts.ts';
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/shared && npm run typecheck`
Expected: PASS、型エラーなし

- [ ] **Step 6: コミット**

```bash
git add packages/shared
git commit -m "feat(shared): transcript, api, event, intent types with route and fts helpers"
```

---

### Task 3: サーバの設定とパス

**Files:**
- Create: `packages/server/package.json`、`packages/server/tsconfig.json`、`packages/server/vitest.config.ts`、`packages/server/src/config/paths.ts`
- Test: `packages/server/src/config/paths.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function hangarHome(): string;                 // HANGAR_HOME ?? ~/.agent-hangar
  export function defaultClaudeDir(): string;           // HANGAR_CLAUDE_DIR ?? ~/.claude
  export function ensureHome(home: string): void;       // 0o700 で作る
  export function readOrCreateToken(home: string): string;      // <home>/token、0o600、32 バイトの hex
  export type DeviceInfo = { id: string; name: string; platform: string };
  export function readOrCreateDevice(home: string): DeviceInfo; // <home>/device.json
  export type Settings = { workspaceRoot: string; claudeDir: string };
  export function loadSettings(home: string): Settings;         // <home>/settings.json、無ければ既定値
  export function saveSettings(home: string, s: Settings): void;
  export function dbPath(home: string): string;                 // <home>/hangar.db
  ```

- [ ] **Step 1: パッケージの骨格を書く**

`packages/server/package.json`：

```json
{
  "name": "@agent-hangar/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc -p .",
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@agent-hangar/shared": "*",
    "@hono/node-server": "^2.1.1",
    "better-sqlite3": "^13.0.3",
    "hono": "^4.13.8",
    "tsx": "^4.23.13",
    "ws": "^8.21.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/ws": "^8.18.1"
  }
}
```

`packages/server/tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/server/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'server', environment: 'node', include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/server/src/config/paths.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbPath, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings } from './paths.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-')); process.env.HANGAR_HOME = tmp; });
afterEach(() => { delete process.env.HANGAR_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

describe('paths', () => {
  it('HANGAR_HOME を優先する', () => {
    expect(hangarHome()).toBe(tmp);
    expect(dbPath(tmp)).toBe(path.join(tmp, 'hangar.db'));
  });
  it('トークンは一度だけ作り、0600 で保存する', () => {
    ensureHome(tmp);
    const a = readOrCreateToken(tmp);
    const b = readOrCreateToken(tmp);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(path.join(tmp, 'token')).mode & 0o777).toBe(0o600);
  });
  it('端末情報は一度だけ作る', () => {
    ensureHome(tmp);
    const a = readOrCreateDevice(tmp);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.name).toBe(os.hostname());
    expect(readOrCreateDevice(tmp)).toEqual(a);
  });
  it('設定は既定値を持ち、保存すると読める', () => {
    ensureHome(tmp);
    const s = loadSettings(tmp);
    expect(s.workspaceRoot).toBe(path.join(os.homedir(), 'workspace'));
    saveSettings(tmp, { ...s, workspaceRoot: '/tmp/ws' });
    expect(loadSettings(tmp).workspaceRoot).toBe('/tmp/ws');
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npm install && npx vitest run packages/server`
Expected: FAIL（`paths.ts` が無い）

- [ ] **Step 4: 実装する**

`packages/server/src/config/paths.ts`：

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';

export type DeviceInfo = { id: string; name: string; platform: string };
export type Settings = { workspaceRoot: string; claudeDir: string };

export function hangarHome(): string {
  return process.env.HANGAR_HOME ?? path.join(os.homedir(), '.agent-hangar');
}

export function defaultClaudeDir(): string {
  return process.env.HANGAR_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
}

export function dbPath(home: string): string {
  return path.join(home, 'hangar.db');
}

export function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
}

export function readOrCreateToken(home: string): string {
  const file = path.join(home, 'token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function readOrCreateDevice(home: string): DeviceInfo {
  const file = path.join(home, 'device.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as DeviceInfo;
  const info: DeviceInfo = { id: newId(), name: os.hostname(), platform: process.platform };
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  return info;
}

function defaultSettings(): Settings {
  return { workspaceRoot: path.join(os.homedir(), 'workspace'), claudeDir: defaultClaudeDir() };
}

export function loadSettings(home: string): Settings {
  const file = path.join(home, 'settings.json');
  if (!fs.existsSync(file)) return defaultSettings();
  return { ...defaultSettings(), ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>) };
}

export function saveSettings(home: string, s: Settings): void {
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(s, null, 2) + '\n');
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: PASS（4 件）

- [ ] **Step 6: コミット**

```bash
git add package-lock.json packages/server
git commit -m "feat(server): config paths, token, device id and settings"
```

---

### Task 4: SQLite のスキーマと共有テーブルの書き込み

**Files:**
- Create: `packages/server/src/db/open.ts`、`packages/server/src/db/migrations.ts`、`packages/server/src/db/shared.ts`
- Test: `packages/server/src/db/db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Db = import('better-sqlite3').Database;
  export function openDb(file: string): Db;             // ':memory:' も受ける。WAL、外部キー、マイグレーション適用
  export const MIGRATIONS: { version: number; sql: string }[];
  export function upsertShared(db: Db, table: string, row: Record<string, unknown>, deviceId: string, pk?: string): void;
  export function softDeleteShared(db: Db, table: string, id: string, deviceId: string, pk?: string): void;
  ```
- `upsertShared` は `updated_at` と `origin_device` を補い、`insert ... on conflict(pk) do update` で書き、`changes` に `op = 'upsert'` の 1 行を追記する。`softDeleteShared` は `deleted_at` を立て、`op = 'delete'` を追記する。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/db/db.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from './open.ts';
import { softDeleteShared, upsertShared } from './shared.ts';

describe('openDb', () => {
  it('共有テーブル、ローカルテーブル、FTS を作る', () => {
    const db = openDb(':memory:');
    const names = db.prepare("select name from sqlite_master where type in ('table') order by name").all().map((r) => (r as { name: string }).name);
    for (const t of ['devices', 'projects', 'project_roots', 'sessions', 'runs', 'run_tabs', 'session_summaries', 'todos', 'project_memos', 'artifacts', 'artifact_versions', 'takeover_requests', 'changes', 'transcript_files', 'event_index', 'event_fts', 'session_stats', 'usage_snapshots', 'sync_state', 'settings_local', 'schema_migrations']) {
      expect(names, t).toContain(t);
    }
  });
  it('二度開いてもマイグレーションを重ねて適用しない', () => {
    const db = openDb(':memory:');
    const n = () => (db.prepare('select count(*) c from schema_migrations').get() as { c: number }).c;
    expect(n()).toBeGreaterThan(0);
  });
  it('FTS5 trigram で日本語の部分一致ができる', () => {
    const db = openDb(':memory:');
    db.prepare('insert into event_fts (session_id, seq, role, text) values (?,?,?,?)').run('s1', 0, 'user', '動画チャンネルの整理をしたい');
    const rows = db.prepare("select seq from event_fts where text match ?").all('"チャンネル"');
    expect(rows).toHaveLength(1);
  });
});

describe('upsertShared', () => {
  it('行を作り、changes に 1 行を積む', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    const row = db.prepare('select * from projects where id = ?').get('p1') as Record<string, unknown>;
    expect(row.name).toBe('x');
    expect(row.origin_device).toBe('dev1');
    expect(typeof row.updated_at).toBe('number');
    const ch = db.prepare('select * from changes').all() as Record<string, unknown>[];
    expect(ch).toHaveLength(1);
    expect(ch[0]!.table_name).toBe('projects');
    expect(ch[0]!.op).toBe('upsert');
    expect(JSON.parse(ch[0]!.payload as string).name).toBe('x');
  });
  it('同じ id は更新になり、行は増えない', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    upsertShared(db, 'projects', { id: 'p1', name: 'y', status: 'paused', is_scratch: 0 }, 'dev1');
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
    expect((db.prepare('select name, status from projects').get() as { name: string; status: string })).toEqual({ name: 'y', status: 'paused' });
    expect(db.prepare('select count(*) c from changes').get()).toEqual({ c: 2 });
  });
  it('主キーが id でない表も書ける', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'dev1' }, 'dev1');
    upsertShared(db, 'session_summaries', { session_id: 's1', title: 't', one_liner: 'o', body: 'b', state: 'done', next_steps: '[]', source: 'baseline', based_on_turns: 3 }, 'dev1', 'session_id');
    expect(db.prepare('select title from session_summaries where session_id = ?').get('s1')).toEqual({ title: 't' });
  });
  it('softDeleteShared は deleted_at を立てて delete を積む', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'x', status: 'active', is_scratch: 0 }, 'dev1');
    softDeleteShared(db, 'projects', 'p1', 'dev1');
    const row = db.prepare('select deleted_at from projects where id = ?').get('p1') as { deleted_at: number | null };
    expect(row.deleted_at).not.toBeNull();
    expect((db.prepare("select op from changes order by seq desc limit 1").get() as { op: string }).op).toBe('delete');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/db`
Expected: FAIL

- [ ] **Step 3: マイグレーションを書く**

`packages/server/src/db/migrations.ts`：

```ts
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
create table devices (
  id text primary key, name text not null, platform text not null,
  last_seen_at integer, updated_at integer not null, deleted_at integer, origin_device text not null
);
create table projects (
  id text primary key, name text not null,
  status text not null check (status in ('active','paused','done','archived')),
  is_scratch integer not null default 0,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table project_roots (
  id text primary key, project_id text not null references projects(id),
  device_id text not null, path text not null,
  resolved integer not null default 1,
  updated_at integer not null, deleted_at integer, origin_device text not null,
  unique (project_id, device_id)
);
create table sessions (
  id text primary key,
  provider text not null,
  provider_session_id text not null,
  project_id text references projects(id),
  name text,
  cwd text not null,
  first_prompt text, ai_title text,
  started_at integer, last_activity_at integer,
  home_device text not null,
  memo text,
  updated_at integer not null, deleted_at integer, origin_device text not null,
  unique (provider, provider_session_id)
);
create index sessions_project on sessions(project_id, last_activity_at);
create table runs (
  id text primary key, session_id text not null references sessions(id),
  device_id text not null,
  kind text not null check (kind in ('start','resume','fork')),
  tmux_name text not null, pid integer,
  launch_params text not null,
  started_at integer not null, ended_at integer, end_reason text,
  heartbeat_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table run_tabs (
  id text primary key, run_id text not null references runs(id),
  tmux_name text not null, title text, created_at integer not null, closed_at integer,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table session_summaries (
  session_id text primary key references sessions(id),
  title text not null, one_liner text not null, body text not null,
  state text not null check (state in ('in_progress','done','blocked','abandoned')),
  next_steps text not null,
  source text not null check (source in ('baseline','in_session','post_hoc')),
  source_model text, based_on_turns integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table todos (
  id text primary key, project_id text not null references projects(id),
  text text not null, done integer not null default 0, position integer not null,
  session_id text references sessions(id),
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table project_memos (
  project_id text primary key references projects(id),
  markdown text not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table artifacts (
  id text primary key, project_id text references projects(id),
  url text not null unique, title text, description text, favicon text,
  first_published_at integer not null, last_published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table artifact_versions (
  id text primary key, artifact_id text not null references artifacts(id),
  session_id text not null references sessions(id), file_path text, published_at integer not null,
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table takeover_requests (
  id text primary key, run_id text not null references runs(id),
  from_device text not null, requested_at integer not null,
  state text not null check (state in ('requested','acked','forced','cancelled')),
  updated_at integer not null, deleted_at integer, origin_device text not null
);
create table changes (
  seq integer primary key autoincrement,
  table_name text not null, row_id text not null,
  op text not null check (op in ('upsert','delete')),
  payload text not null,
  updated_at integer not null, device_id text not null,
  pushed_at integer
);
`,
  },
  {
    version: 2,
    sql: `
create table transcript_files (
  path text primary key, session_id text not null, agent_id text,
  size integer not null, mtime integer not null, indexed_bytes integer not null,
  indexer_version integer not null, last_error text
);
create index transcript_files_session on transcript_files(session_id);
create table event_index (
  id integer primary key,
  session_id text not null, seq integer not null,
  kind text not null,
  ts integer, byte_offset integer not null, byte_length integer not null,
  file_path_ref text not null,
  parent_agent text,
  tool_name text, file_path text
);
create unique index event_index_pos on event_index(session_id, ifnull(parent_agent, ''), seq);
create index event_index_tool on event_index(session_id, tool_name);
create virtual table event_fts using fts5 (
  session_id unindexed, agent_id unindexed, seq unindexed, role, text,
  tokenize = 'trigram'
);
create table session_stats (
  session_id text primary key,
  turns integer not null default 0,
  model text, effort text,
  files_changed integer not null default 0,
  pr_url text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  first_ts integer, last_ts integer,
  last_prompt text
);
create table usage_snapshots (
  at integer primary key, payload text not null
);
create table sync_state (key text primary key, value text not null);
create table settings_local (key text primary key, value text not null);
`,
  },
];
```

`event_index.file_path_ref` は、そのイベントを読むときに開くファイルのパスである（サブエージェントは別ファイルなので、行ごとに持つ）。
`event_fts.agent_id` はサブエージェントの ID で、主線は null である。`session_stats.last_prompt` は最後の利用者の発言の先頭 200 字で、土台の要約に使う。

- [ ] **Step 4: openDb と shared を書く**

`packages/server/src/db/open.ts`：

```ts
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';

export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists schema_migrations (version integer primary key, applied_at integer not null)');
  const applied = new Set((db.prepare('select version from schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const apply = db.transaction((m: { version: number; sql: string }) => {
    db.exec(m.sql);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(m.version, Date.now());
  });
  for (const m of MIGRATIONS) if (!applied.has(m.version)) apply(m);
  return db;
}
```

`packages/server/src/db/shared.ts`：

```ts
import type { Db } from './open.ts';

/** 共有テーブルへの書き込み。updated_at と origin_device を補い、changes に追記する。 */
export function upsertShared(db: Db, table: string, row: Record<string, unknown>, deviceId: string, pk = 'id'): void {
  const full = { ...row, updated_at: Date.now(), origin_device: deviceId };
  const cols = Object.keys(full);
  const sets = cols.filter((c) => c !== pk).map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')}) on conflict(${pk}) do update set ${sets}`;
  const write = db.transaction(() => {
    db.prepare(sql).run(...cols.map((c) => full[c] as unknown));
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(full[pk]);
    db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, String(full[pk]), 'upsert', JSON.stringify(stored), full.updated_at, deviceId);
  });
  write();
}

export function softDeleteShared(db: Db, table: string, id: string, deviceId: string, pk = 'id'): void {
  const now = Date.now();
  const write = db.transaction(() => {
    db.prepare(`update ${table} set deleted_at = ?, updated_at = ?, origin_device = ? where ${pk} = ?`).run(now, now, deviceId, id);
    const stored = db.prepare(`select * from ${table} where ${pk} = ?`).get(id);
    db.prepare('insert into changes (table_name, row_id, op, payload, updated_at, device_id) values (?,?,?,?,?,?)')
      .run(table, id, 'delete', JSON.stringify(stored), now, deviceId);
  });
  write();
}
```

`table` と `pk` は呼び出し側のコードにだけ現れる定数で、利用者の入力は入らない。

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/db && npm run typecheck`
Expected: PASS（7 件）

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/db
git commit -m "feat(server): sqlite schema, migrations and shared-table writes with change log"
```

---

### Task 5: Claude Code の記録の正規化

**Files:**
- Create: `packages/server/src/provider/types.ts`、`packages/server/src/provider/claude-code/normalize.ts`
- Test: `packages/server/src/provider/claude-code/normalize.test.ts`

**Interfaces:**
- Produces: `normalizeRecord(raw, seqStart, agentId): TranscriptEvent[]`、`recordFacts(raw): RecordFacts`、`indexTexts(events): IndexText[]`（`seq` 付き）、`toolSummary(name, input): string`、`pickFilePath(input): string | undefined`（「インターフェース一覧」を参照）。
- 規則：
  - `user` で `isMeta: true` は `system`。`content` が文字列なら `user`。配列なら `text` を連結して `user` 1 件、`image` と `document` は `attachments`、`tool_result` は 1 件ずつ `tool_result`。`user` が先、`tool_result` が後で `seq` を振る。
  - `assistant` は `content` の各ブロックを `text` は `assistant`、`thinking` は `thinking`、`tool_use` は `tool_call` にする。`model` は `message.model`。
  - `system` は `subtype` を本文にした `system`。
  - それ以外の `type`（`ai-title`、`custom-title`、`agent-name`、`pr-link`、`last-prompt`、`mode`、`attachment`、未知のもの）は `meta` で、`name` に `type`、`value` に `type` と `sessionId` を除いた残りを入れる。
  - 1 記録は 0 件以上のイベントになる。JSON でない、オブジェクトでないものは 0 件。
- `RecordFacts.isUserTurn` は、`isMeta` でない `user` で、文字列か `text` ブロックを持つときだけ `true`。`usage.input` は `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。

- [ ] **Step 1: Provider の型を書く**

`packages/server/src/provider/types.ts`：

```ts
import type { LiveSessionDto, TranscriptEvent } from '@agent-hangar/shared';

export type DiscoveredFile = { path: string; sessionId: string; agentId: string | null };
export type LiveSession = LiveSessionDto;

export interface Provider {
  readonly id: 'claude-code' | 'opencode';
  discover(): DiscoveredFile[];
  watch(onChange: (path: string) => void): () => void;
  readEvents(file: string, fromByte: number): { events: TranscriptEvent[]; offset: number; length: number }[];
  liveStatus(): LiveSession[];
  launchCommand(params: unknown): string[];
  resumeCommand(session: unknown, fork: boolean): string[];
}
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/server/src/provider/claude-code/normalize.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { indexTexts, normalizeRecord, recordFacts, toolSummary } from './normalize.ts';

const base = { uuid: 'u', parentUuid: null, isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: 'aaaa' };

describe('normalizeRecord', () => {
  it('文字列 content の user は user 1 件', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: 'こんにちは' } }, 5, null);
    expect(ev).toEqual([{ kind: 'user', seq: 5, ts: Date.parse(base.timestamp), text: 'こんにちは' }]);
  });
  it('isMeta の user は system', () => {
    const ev = normalizeRecord({ ...base, type: 'user', isMeta: true, message: { role: 'user', content: '<caveat/>' } }, 0, null);
    expect(ev[0]!.kind).toBe('system');
  });
  it('text と image を持つ user は attachments 付きの user 1 件', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'これを見て' }, { type: 'image', source: {} }] } }, 0, null);
    expect(ev).toEqual([{ kind: 'user', seq: 0, ts: Date.parse(base.timestamp), text: 'これを見て', attachments: [{ kind: 'image' }] }]);
  });
  it('tool_result は 1 件ずつ、is_error を写す', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'File not found' }], is_error: true },
    ] } }, 3, null);
    expect(ev).toEqual([
      { kind: 'tool_result', seq: 3, ts: Date.parse(base.timestamp), toolId: 't1', text: 'ok', isError: false },
      { kind: 'tool_result', seq: 4, ts: Date.parse(base.timestamp), toolId: 't2', text: 'File not found', isError: true },
    ]);
  });
  it('assistant のブロックを種別ごとに分ける', () => {
    const ev = normalizeRecord({ ...base, type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-fable-5-1', content: [
      { type: 'thinking', thinking: '考える', signature: 'x' },
      { type: 'text', text: '返事' },
      { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' } },
    ] } }, 0, null);
    expect(ev.map((e) => e.kind)).toEqual(['thinking', 'assistant', 'tool_call']);
    expect(ev[1]).toMatchObject({ text: '返事', model: 'claude-fable-5-1' });
    expect(ev[2]).toMatchObject({ toolId: 'toolu_1', name: 'Edit', summary: 'Edit /a/b.ts', filePath: '/a/b.ts' });
  });
  it('system は subtype を本文にする', () => {
    const ev = normalizeRecord({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 10 }, 0, null);
    expect(ev).toEqual([{ kind: 'system', seq: 0, ts: Date.parse(base.timestamp), text: 'turn_duration' }]);
  });
  it('知らない type は meta として保持する', () => {
    const ev = normalizeRecord({ type: 'ai-title', aiTitle: '題名', sessionId: 'aaaa' }, 7, null);
    expect(ev).toEqual([{ kind: 'meta', seq: 7, ts: undefined, name: 'ai-title', value: { aiTitle: '題名' } }]);
  });
  it('オブジェクトでなければ空', () => {
    expect(normalizeRecord('x', 0, null)).toEqual([]);
    expect(normalizeRecord(null, 0, null)).toEqual([]);
  });
});

describe('toolSummary', () => {
  it('ファイルパス、コマンドの 1 行目、パターン、説明の順で選ぶ', () => {
    expect(toolSummary('Edit', { file_path: '/a.ts' })).toBe('Edit /a.ts');
    expect(toolSummary('Bash', { command: 'ls -la\nwc -l', description: 'List' })).toBe('Bash ls -la');
    expect(toolSummary('Grep', { pattern: 'foo' })).toBe('Grep foo');
    expect(toolSummary('Agent', { description: 'Survey', prompt: '...' })).toBe('Agent Survey');
    expect(toolSummary('Skill', { skill: 'grilling' })).toBe('Skill grilling');
    expect(toolSummary('Nothing', {})).toBe('Nothing');
    expect(toolSummary('Bash', { command: 'x'.repeat(300) })).toHaveLength('Bash '.length + 120);
  });
});

describe('recordFacts', () => {
  it('assistant からモデル、effort、トークンを取る', () => {
    const f = recordFacts({ ...base, type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-fable-5-1', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } } });
    expect(f).toEqual({ cwd: '/Users/me/workspace/alpha', ts: Date.parse(base.timestamp), model: 'claude-fable-5-1', effort: 'high', usage: { input: 1110, output: 20 }, isUserTurn: false });
  });
  it('メタ行から題名と名前と PR を取る', () => {
    expect(recordFacts({ type: 'ai-title', aiTitle: 'A' })).toMatchObject({ aiTitle: 'A' });
    expect(recordFacts({ type: 'custom-title', customTitle: 'B' })).toMatchObject({ customTitle: 'B' });
    expect(recordFacts({ type: 'agent-name', agentName: 'C' })).toMatchObject({ agentName: 'C' });
    expect(recordFacts({ type: 'pr-link', prUrl: 'https://x/pull/1' })).toMatchObject({ prUrl: 'https://x/pull/1' });
  });
  it('isUserTurn は本文のある user だけ', () => {
    expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: 'x' } }).isUserTurn).toBe(true);
    expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }).isUserTurn).toBe(true);
    expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }).isUserTurn).toBe(false);
    expect(recordFacts({ ...base, type: 'user', isMeta: true, message: { role: 'user', content: 'x' } }).isUserTurn).toBe(false);
  });
});

describe('indexTexts', () => {
  it('user と assistant の本文、tool_call の要約とコマンドだけを返す', () => {
    const texts = indexTexts([
      { kind: 'user', seq: 0, text: 'u' },
      { kind: 'assistant', seq: 1, text: 'a' },
      { kind: 'thinking', seq: 2, text: 'th' },
      { kind: 'tool_call', seq: 3, toolId: 't', name: 'Bash', input: { command: 'ls -la\nwc -l' }, summary: 'Bash ls -la' },
      { kind: 'tool_result', seq: 4, toolId: 't', text: 'result', isError: false },
      { kind: 'meta', seq: 5, name: 'ai-title', value: {} },
    ]);
    expect(texts).toEqual([
      { seq: 0, role: 'user', text: 'u' },
      { seq: 1, role: 'assistant', text: 'a' },
      { seq: 3, role: 'tool', text: 'Bash ls -la\nls -la\nwc -l' },
    ]);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/server/src/provider`
Expected: FAIL（`normalize.ts` が無い）

- [ ] **Step 4: 実装する**

`packages/server/src/provider/claude-code/normalize.ts`：

```ts
import type { Attachment, TranscriptEvent } from '@agent-hangar/shared';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export type RecordFacts = {
  cwd?: string; ts?: number; model?: string; effort?: string;
  usage?: { input: number; output: number };
  aiTitle?: string; customTitle?: string; agentName?: string; prUrl?: string;
  isUserTurn: boolean;
};

function parseTs(raw: Rec): number | undefined {
  const t = raw.timestamp;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') { const n = Date.parse(t); return Number.isNaN(n) ? undefined : n; }
  return undefined;
}

/** tool_result などの content（文字列か text ブロックの配列）を本文にする。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isRec).map((b) => (b.type === 'text' ? str(b.text) ?? '' : '')).filter(Boolean).join('\n');
}

export function pickFilePath(input: unknown): string | undefined {
  if (!isRec(input)) return undefined;
  return str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
}

export function toolSummary(name: string, input: unknown): string {
  const fp = pickFilePath(input);
  if (fp) return `${name} ${fp}`;
  if (!isRec(input)) return name;
  const command = str(input.command);
  if (command) return `${name} ${(command.split('\n')[0] ?? '').slice(0, 120)}`;
  const tail = str(input.pattern) ?? str(input.query) ?? str(input.skill) ?? str(input.url) ?? str(input.description);
  return tail ? `${name} ${tail.slice(0, 120)}` : name;
}

export function normalizeRecord(raw: unknown, seqStart: number, _agentId: string | null): TranscriptEvent[] {
  if (!isRec(raw)) return [];
  const type = str(raw.type) ?? 'unknown';
  const ts = parseTs(raw);
  const msg = isRec(raw.message) ? raw.message : null;
  let seq = seqStart;

  if (type === 'user' && msg) {
    const content = msg.content;
    if (raw.isMeta === true) return [{ kind: 'system', seq, ts, text: contentText(content) }];
    if (typeof content === 'string') return [{ kind: 'user', seq, ts, text: content }];
    if (!Array.isArray(content)) return [];
    const texts: string[] = [];
    const attachments: Attachment[] = [];
    const results: Omit<Extract<TranscriptEvent, { kind: 'tool_result' }>, 'seq'>[] = [];
    for (const b of content.filter(isRec)) {
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'image') attachments.push({ kind: 'image' });
      else if (b.type === 'document') attachments.push({ kind: 'file', name: str(b.title) ?? str(b.name) });
      else if (b.type === 'tool_result') results.push({ kind: 'tool_result', ts, toolId: str(b.tool_use_id) ?? '', text: contentText(b.content), isError: b.is_error === true });
    }
    const out: TranscriptEvent[] = [];
    if (texts.length > 0 || attachments.length > 0) {
      const ev: Extract<TranscriptEvent, { kind: 'user' }> = { kind: 'user', seq: seq++, ts, text: texts.join('\n') };
      if (attachments.length > 0) ev.attachments = attachments;
      out.push(ev);
    }
    for (const r of results) out.push({ ...r, seq: seq++ });
    return out;
  }

  if (type === 'assistant' && msg && Array.isArray(msg.content)) {
    const model = str(msg.model);
    const out: TranscriptEvent[] = [];
    for (const b of msg.content.filter(isRec)) {
      if (b.type === 'text') { const ev: Extract<TranscriptEvent, { kind: 'assistant' }> = { kind: 'assistant', seq: seq++, ts, text: str(b.text) ?? '' }; if (model) ev.model = model; out.push(ev); }
      else if (b.type === 'thinking') out.push({ kind: 'thinking', seq: seq++, ts, text: str(b.thinking) ?? '' });
      else if (b.type === 'tool_use') {
        const name = str(b.name) ?? 'tool';
        const ev: Extract<TranscriptEvent, { kind: 'tool_call' }> = { kind: 'tool_call', seq: seq++, ts, toolId: str(b.id) ?? '', name, input: b.input, summary: toolSummary(name, b.input) };
        const fp = pickFilePath(b.input); if (fp) ev.filePath = fp;
        out.push(ev);
      }
    }
    return out;
  }

  if (type === 'system') return [{ kind: 'system', seq, ts, text: str(raw.subtype) ?? 'system' }];

  const { type: _t, sessionId: _s, ...rest } = raw;
  return [{ kind: 'meta', seq, ts, name: type, value: rest }];
}

export function recordFacts(raw: unknown): RecordFacts {
  const facts: RecordFacts = { isUserTurn: false };
  if (!isRec(raw)) return facts;
  const cwd = str(raw.cwd); if (cwd) facts.cwd = cwd;
  const ts = parseTs(raw); if (ts !== undefined) facts.ts = ts;
  const msg = isRec(raw.message) ? raw.message : null;
  switch (raw.type) {
    case 'assistant': {
      const model = str(msg?.model); if (model) facts.model = model;
      const effort = str(raw.effort); if (effort) facts.effort = effort;
      const u = isRec(msg?.usage) ? msg.usage : null;
      if (u) facts.usage = { input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), output: num(u.output_tokens) };
      break;
    }
    case 'user': {
      if (raw.isMeta === true || !msg) break;
      const c = msg.content;
      facts.isUserTurn = typeof c === 'string' || (Array.isArray(c) && c.some((b) => isRec(b) && b.type === 'text'));
      break;
    }
    case 'ai-title': { const v = str(raw.aiTitle); if (v) facts.aiTitle = v; break; }
    case 'custom-title': { const v = str(raw.customTitle); if (v) facts.customTitle = v; break; }
    case 'agent-name': { const v = str(raw.agentName); if (v) facts.agentName = v; break; }
    case 'pr-link': { const v = str(raw.prUrl); if (v) facts.prUrl = v; break; }
  }
  return facts;
}

export type IndexText = { seq: number; role: 'user' | 'assistant' | 'tool'; text: string };

export function indexTexts(events: TranscriptEvent[]): IndexText[] {
  const out: IndexText[] = [];
  for (const e of events) {
    if (e.kind === 'user' && e.text) out.push({ seq: e.seq, role: 'user', text: e.text });
    else if (e.kind === 'assistant' && e.text) out.push({ seq: e.seq, role: 'assistant', text: e.text });
    else if (e.kind === 'tool_call') {
      const command = isRec(e.input) ? str(e.input.command) : undefined;
      out.push({ seq: e.seq, role: 'tool', text: command ? `${e.summary}\n${command}` : e.summary });
    }
  }
  return out;
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/provider && npm run typecheck`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/provider
git commit -m "feat(server): normalize claude code records into transcript events"
```

---

### Task 6: jsonl の追記分だけを読む

**Files:**
- Create: `packages/server/src/provider/claude-code/lines.ts`
- Test: `packages/server/src/provider/claude-code/lines.test.ts`

**Interfaces:**
- Produces: `readNewLines(path: string, fromByte: number): { lines: { offset: number; length: number; text: string }[]; nextByte: number; reset: boolean }`
- 改行で終わらない末尾の断片は返さず、`nextByte` はその断片の先頭に留める。ファイルが `fromByte` より短くなっていたら（作り直された）`reset: true` を返し、先頭から読み直した結果を返す。空行は返さない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/provider/claude-code/lines.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNewLines } from './lines.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readNewLines', () => {
  it('行ごとのバイト位置と長さを返し、末尾の断片は次回に回す', () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":"日本語"}\n{"c":');
    const r = readNewLines(f, 0);
    expect(r.reset).toBe(false);
    expect(r.lines.map((l) => l.text)).toEqual(['{"a":1}', '{"b":"日本語"}']);
    expect(r.lines[0]).toMatchObject({ offset: 0, length: 7 });
    expect(r.lines[1]!.offset).toBe(8);
    expect(r.lines[1]!.length).toBe(Buffer.byteLength('{"b":"日本語"}'));
    expect(r.nextByte).toBe(8 + r.lines[1]!.length + 1);
    // 断片を完成させると、そこから 1 行だけ返る
    fs.appendFileSync(f, '3}\n');
    const r2 = readNewLines(f, r.nextByte);
    expect(r2.lines.map((l) => l.text)).toEqual(['{"c":3}']);
    expect(r2.nextByte).toBe(fs.statSync(f).size);
  });
  it('バイト位置から読み直すと同じ行が得られる', () => {
    const f = path.join(dir, 'b.jsonl');
    fs.writeFileSync(f, 'x\n{"k":"値"}\n');
    const l = readNewLines(f, 0).lines[1]!;
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(l.length);
    fs.readSync(fd, buf, 0, l.length, l.offset);
    fs.closeSync(fd);
    expect(buf.toString('utf8')).toBe('{"k":"値"}');
  });
  it('空行は返さない', () => {
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, '\n\n{"a":1}\n\n');
    expect(readNewLines(f, 0).lines).toHaveLength(1);
  });
  it('ファイルが短くなっていたら reset を立てて先頭から読む', () => {
    const f = path.join(dir, 'd.jsonl');
    fs.writeFileSync(f, '{"a":1}\n');
    const r = readNewLines(f, 100);
    expect(r.reset).toBe(true);
    expect(r.lines).toHaveLength(1);
  });
  it('追記が無ければ空', () => {
    const f = path.join(dir, 'e.jsonl');
    fs.writeFileSync(f, '{"a":1}\n');
    const r = readNewLines(f, 8);
    expect(r.lines).toEqual([]);
    expect(r.nextByte).toBe(8);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/lines`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/provider/claude-code/lines.ts`：

```ts
import fs from 'node:fs';

export type NewLine = { offset: number; length: number; text: string };

/**
 * fromByte 以降の完全な行だけを返す。
 * 改行で終わらない末尾の断片は次回に回し、nextByte をその先頭に留める。
 */
export function readNewLines(path: string, fromByte: number): { lines: NewLine[]; nextByte: number; reset: boolean } {
  const size = fs.statSync(path).size;
  let start = fromByte;
  let reset = false;
  if (size < fromByte) { start = 0; reset = true; }
  if (size === start) return { lines: [], nextByte: start, reset };
  const fd = fs.openSync(path, 'r');
  const buf = Buffer.alloc(size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lines: NewLine[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl === -1) break;
    const length = nl - pos;
    if (length > 0) lines.push({ offset: start + pos, length, text: buf.subarray(pos, nl).toString('utf8') });
    pos = nl + 1;
  }
  return { lines, nextByte: start + pos, reset };
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/provider/claude-code/lines && npm run typecheck`
Expected: PASS（5 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/provider/claude-code/lines.ts packages/server/src/provider/claude-code/lines.test.ts
git commit -m "feat(server): incremental jsonl line reader with byte offsets"
```

---

### Task 7: 保存先の列挙と history.jsonl（匿名化フィクスチャ付き）

**Files:**
- Create: `packages/server/test/fixtures/claude/history.jsonl`
- Create: `packages/server/test/fixtures/claude/projects/-Users-me-workspace-alpha/aaaaaaaa-0000-4000-8000-000000000001.jsonl`
- Create: `packages/server/test/fixtures/claude/projects/-Users-me-workspace-alpha/aaaaaaaa-0000-4000-8000-000000000001/subagents/agent-abc123.jsonl`
- Create: `packages/server/test/fixtures/claude/projects/-Users-me-other/aaaaaaaa-0000-4000-8000-000000000003.jsonl`
- Create: `packages/server/test/fixtures/claude/sessions/12345.json`、`packages/server/test/fixtures/claude/sessions/12345.abc.key`
- Create: `packages/server/test/fixtures.ts`（フィクスチャのパスを返す）
- Create: `packages/server/src/provider/claude-code/discover.ts`
- Test: `packages/server/src/provider/claude-code/discover.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function mangleCwd(cwd: string): string;                       // 英数字以外を '-' に
  export function listTranscriptFiles(claudeDir: string): DiscoveredFile[];   // パス順。サブエージェントは agentId 付き
  export type HistoryEntry = { cwd: string; firstTs: number; lastTs: number; firstDisplay: string; count: number };
  export function readHistoryIndex(claudeDir: string): Map<string, HistoryEntry>;   // sessionId → entry
  // test/fixtures.ts
  export const FIXTURE_CLAUDE_DIR: string;
  export function copyFixtureClaudeDir(): string;   // 一時ディレクトリへ複製して、そのパスを返す
  ```
- フィクスチャは、この後のインデクサ、プロジェクト登録、API、検索のテストがすべて使う。中身は次のとおりで、実在の個人情報を含まない。

- [ ] **Step 1: フィクスチャを書く**

`packages/server/test/fixtures/claude/history.jsonl`：

```
{"display":"動画チャンネルの整理をしたい。まず現状を見て","pastedContents":{},"timestamp":1788256800000,"project":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"display":"b.md も同じように直して","pastedContents":{},"timestamp":1788256980000,"project":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"display":"beta の README を書いて","pastedContents":{},"timestamp":1788343200000,"project":"/Users/me/workspace/beta","sessionId":"aaaaaaaa-0000-4000-8000-000000000002"}
{"display":"hello there","pastedContents":{},"timestamp":1787216400000,"project":"/Users/me/other","sessionId":"aaaaaaaa-0000-4000-8000-000000000003"}
```

`packages/server/test/fixtures/claude/projects/-Users-me-workspace-alpha/aaaaaaaa-0000-4000-8000-000000000001.jsonl`（17 行）：

```
{"type":"user","message":{"role":"user","content":"動画チャンネルの整理をしたい。まず現状を見て"},"uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-09-01T10:00:00.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001","version":"2.1.274","gitBranch":"main"}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5-1","content":[{"type":"thinking","thinking":"まず一覧を取る","signature":"x"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":20}},"uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-09-01T10:00:05.000Z","effort":"high","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5-1","content":[{"type":"text","text":"一覧を確認します。"}],"usage":{"input_tokens":0,"output_tokens":5}},"uuid":"a2","parentUuid":"a1","isSidechain":false,"timestamp":"2026-09-01T10:00:06.000Z","effort":"high","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5-1","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls channels/\nwc -l channels/*.md","description":"List channel files"}}],"usage":{"input_tokens":0,"output_tokens":30}},"uuid":"a3","parentUuid":"a2","isSidechain":false,"timestamp":"2026-09-01T10:00:07.000Z","effort":"high","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a.md\nb.md"}]},"uuid":"u2","parentUuid":"a3","isSidechain":false,"timestamp":"2026-09-01T10:00:08.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001","toolUseResult":{"stdout":"a.md\nb.md"}}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5-1","content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"/Users/me/workspace/alpha/channels/a.md","old_string":"x","new_string":"y"}}],"usage":{"input_tokens":0,"output_tokens":40}},"uuid":"a4","parentUuid":"u2","isSidechain":false,"timestamp":"2026-09-01T10:00:20.000Z","effort":"high","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":[{"type":"text","text":"File not found"}],"is_error":true}]},"uuid":"u3","parentUuid":"a4","isSidechain":false,"timestamp":"2026-09-01T10:00:21.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5-1","content":[{"type":"tool_use","id":"toolu_3","name":"Agent","input":{"description":"Survey channels","prompt":"Read channels and report","subagent_type":"Explore"}}],"usage":{"input_tokens":0,"output_tokens":40}},"uuid":"a5","parentUuid":"u3","isSidechain":false,"timestamp":"2026-09-01T10:00:30.000Z","effort":"high","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_3","content":"2 channels found"}]},"uuid":"u4","parentUuid":"a5","isSidechain":false,"timestamp":"2026-09-01T10:01:00.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>"},"isMeta":true,"uuid":"u5","parentUuid":"u4","isSidechain":false,"timestamp":"2026-09-01T10:02:00.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"b.md も同じように直して"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]},"uuid":"u6","parentUuid":"u5","isSidechain":false,"timestamp":"2026-09-01T10:03:00.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5-1","content":[{"type":"text","text":"直しました。"}],"usage":{"input_tokens":0,"output_tokens":5}},"uuid":"a6","parentUuid":"u6","isSidechain":false,"timestamp":"2026-09-01T10:03:10.000Z","effort":"high","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"system","subtype":"turn_duration","durationMs":2484,"messageCount":12,"uuid":"s1","parentUuid":"a6","isSidechain":false,"isMeta":false,"timestamp":"2026-09-01T10:03:11.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"ai-title","aiTitle":"動画チャンネルの整理","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"custom-title","customTitle":"channels-cleanup","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"pr-link","sessionId":"aaaaaaaa-0000-4000-8000-000000000001","prNumber":12,"prUrl":"https://github.com/me/alpha/pull/12","prRepository":"me/alpha","timestamp":"2026-09-01T10:04:00.000Z"}
{"type":"last-prompt","leafUuid":"a6","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
```

`.../aaaaaaaa-0000-4000-8000-000000000001/subagents/agent-abc123.jsonl`（2 行）：

```
{"type":"user","message":{"role":"user","content":"Read channels and report"},"uuid":"sa1","parentUuid":null,"isSidechain":true,"agentId":"abc123","timestamp":"2026-09-01T10:00:31.000Z","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"2 channels found"}],"usage":{"input_tokens":5,"output_tokens":3}},"uuid":"sa2","parentUuid":"sa1","isSidechain":true,"agentId":"abc123","timestamp":"2026-09-01T10:00:50.000Z","effort":"medium","cwd":"/Users/me/workspace/alpha","sessionId":"aaaaaaaa-0000-4000-8000-000000000001"}
```

`packages/server/test/fixtures/claude/projects/-Users-me-other/aaaaaaaa-0000-4000-8000-000000000003.jsonl`（2 行）：

```
{"type":"user","message":{"role":"user","content":"hello there"},"uuid":"o1","parentUuid":null,"isSidechain":false,"timestamp":"2026-08-20T09:00:00.000Z","cwd":"/Users/me/other","sessionId":"aaaaaaaa-0000-4000-8000-000000000003"}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Hi. What should we do?"}],"usage":{"input_tokens":1,"output_tokens":2}},"uuid":"o2","parentUuid":"o1","isSidechain":false,"timestamp":"2026-08-20T09:00:03.000Z","effort":"medium","cwd":"/Users/me/other","sessionId":"aaaaaaaa-0000-4000-8000-000000000003"}
```

`packages/server/test/fixtures/claude/sessions/12345.json`：

```json
{"pid":12345,"sessionId":"aaaaaaaa-0000-4000-8000-000000000001","cwd":"/Users/me/workspace/alpha","startedAt":1788256790000,"version":"2.1.274","kind":"interactive","entrypoint":"cli","name":"channels-cleanup","nameSource":"user","nameSince":1788256790000,"status":"busy","updatedAt":1788256800000,"statusUpdatedAt":1788256800000}
```

`packages/server/test/fixtures/claude/sessions/12345.abc.key` の中身は `x` の 1 行だけにする（レジストリの読み取りが `.json` 以外を無視することの確認用）。

`packages/server/test/fixtures.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_CLAUDE_DIR = fileURLToPath(new URL('./fixtures/claude', import.meta.url));
export const SESSION_ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001';
export const SESSION_BETA = 'aaaaaaaa-0000-4000-8000-000000000002';
export const SESSION_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';

/** フィクスチャを一時ディレクトリに複製する。追記や削除を試すテストで使う。 */
export function copyFixtureClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fixture-'));
  fs.cpSync(FIXTURE_CLAUDE_DIR, dir, { recursive: true });
  return dir;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/server/src/provider/claude-code/discover.test.ts`：

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CLAUDE_DIR, SESSION_ALPHA, SESSION_BETA, SESSION_OTHER } from '../../../test/fixtures.ts';
import { listTranscriptFiles, mangleCwd, readHistoryIndex } from './discover.ts';

describe('mangleCwd', () => {
  it('英数字以外を 1 文字ずつ - にする', () => {
    expect(mangleCwd('/Users/me/workspace/alpha')).toBe('-Users-me-workspace-alpha');
    expect(mangleCwd('/Users/me/workspace/父店-誕生日制作2025-09')).toBe('-Users-me-workspace---------2025-09');
  });
});

describe('listTranscriptFiles', () => {
  it('本体とサブエージェントの jsonl を列挙する', () => {
    const files = listTranscriptFiles(FIXTURE_CLAUDE_DIR);
    expect(files).toEqual([
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-other', `${SESSION_OTHER}.jsonl`), sessionId: SESSION_OTHER, agentId: null },
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-workspace-alpha', SESSION_ALPHA, 'subagents/agent-abc123.jsonl'), sessionId: SESSION_ALPHA, agentId: 'abc123' },
      { path: path.join(FIXTURE_CLAUDE_DIR, 'projects/-Users-me-workspace-alpha', `${SESSION_ALPHA}.jsonl`), sessionId: SESSION_ALPHA, agentId: null },
    ]);
  });
  it('projects が無ければ空', () => {
    expect(listTranscriptFiles('/nonexistent/dir')).toEqual([]);
  });
});

describe('readHistoryIndex', () => {
  it('セッションごとに cwd、最初と最後の時刻、件数をまとめる', () => {
    const idx = readHistoryIndex(FIXTURE_CLAUDE_DIR);
    expect(idx.size).toBe(3);
    expect(idx.get(SESSION_ALPHA)).toEqual({ cwd: '/Users/me/workspace/alpha', firstTs: 1788256800000, lastTs: 1788256980000, firstDisplay: '動画チャンネルの整理をしたい。まず現状を見て', count: 2 });
    expect(idx.get(SESSION_BETA)?.cwd).toBe('/Users/me/workspace/beta');
  });
  it('history.jsonl が無ければ空の Map', () => {
    expect(readHistoryIndex('/nonexistent/dir').size).toBe(0);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/discover`
Expected: FAIL

- [ ] **Step 4: 実装する**

`packages/server/src/provider/claude-code/discover.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredFile } from '../types.ts';

export function mangleCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

const UUID_RE = /^[0-9a-f-]{36}$/;

/** ~/.claude/projects 配下の本体とサブエージェントの jsonl をパス順に列挙する。 */
export function listTranscriptFiles(claudeDir: string): DiscoveredFile[] {
  const root = path.join(claudeDir, 'projects');
  if (!fs.existsSync(root)) return [];
  const out: DiscoveredFile[] = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pd = path.join(root, proj.name);
    for (const entry of fs.readdirSync(pd, { withFileTypes: true })) {
      const full = path.join(pd, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        if (UUID_RE.test(sessionId)) out.push({ path: full, sessionId, agentId: null });
      } else if (entry.isDirectory() && UUID_RE.test(entry.name)) {
        const sub = path.join(full, 'subagents');
        if (!fs.existsSync(sub)) continue;
        for (const f of fs.readdirSync(sub)) {
          const m = /^agent-([0-9a-zA-Z]+)\.jsonl$/.exec(f);
          if (m) out.push({ path: path.join(sub, f), sessionId: entry.name, agentId: m[1]! });
        }
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type HistoryEntry = { cwd: string; firstTs: number; lastTs: number; firstDisplay: string; count: number };

/** ~/.claude/history.jsonl を読み、セッション ID ごとにまとめる。 */
export function readHistoryIndex(claudeDir: string): Map<string, HistoryEntry> {
  const file = path.join(claudeDir, 'history.jsonl');
  const map = new Map<string, HistoryEntry>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: { sessionId?: string; project?: string; timestamp?: number; display?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.sessionId) continue;
    const ts = typeof rec.timestamp === 'number' ? rec.timestamp : 0;
    const cur = map.get(rec.sessionId);
    if (!cur) map.set(rec.sessionId, { cwd: rec.project ?? '', firstTs: ts, lastTs: ts, firstDisplay: rec.display ?? '', count: 1 });
    else {
      cur.count += 1;
      if (ts < cur.firstTs) { cur.firstTs = ts; cur.firstDisplay = rec.display ?? cur.firstDisplay; }
      if (ts > cur.lastTs) cur.lastTs = ts;
      if (rec.project) cur.cwd = rec.project;
    }
  }
  return map;
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/server/src/provider/claude-code/discover && npm run typecheck`
Expected: PASS（6 件）

- [ ] **Step 6: コミット**

```bash
git add packages/server/test packages/server/src/provider/claude-code/discover.ts packages/server/src/provider/claude-code/discover.test.ts
git commit -m "feat(server): discover transcript files and history index with anonymized fixtures"
```

---

### Task 8: 1 ファイルの索引化（event_index、event_fts、sessions、session_stats）

**Files:**
- Create: `packages/server/src/indexer/indexFile.ts`
- Test: `packages/server/src/indexer/indexFile.test.ts`

**Interfaces:**
- Consumes: `openDb`、`upsertShared`、`readNewLines`、`normalizeRecord`、`recordFacts`、`indexTexts`、`newId`。
- Produces:
  ```ts
  export const INDEXER_VERSION = 1;
  export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
  export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string };
  export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number };
  export function ensureSession(db: Db, providerSessionId: string, cwd: string, deviceId: string): string;   // hangar 側の sessions.id を返す
  export function indexFile(db: Db, file: DiscoveredFile, opts: IndexFileOptions): IndexFileResult;
  ```
- 振る舞い：
  - `transcript_files` の `size`、`mtime`、`indexer_version` が一致すれば何もしない（`changed: false`）。
  - 版が違う、または `readNewLines` が `reset` を返したら、そのファイル（`session_id` と `parent_agent` の組）の `event_index` と `event_fts` の行を消して先頭から作り直す。
  - `seq` は主線とサブエージェントで別に振る（`ifnull(parent_agent, '')` ごとの `max(seq) + 1` から続ける）。
  - `event_fts.text` は 20,000 字で切る。
  - 主線（`agentId` が null）のときだけ `sessions` と `session_stats` を更新する。`sessions` は全列を読んでから差分を重ねて `upsertShared` に渡す（NOT NULL 列を欠かさないため）。
  - `session_stats.files_changed` は `event_index` から `EDIT_TOOLS` の `file_path` を `count(distinct)` で数え直す（サブエージェントの編集も含む）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/indexer/indexFile.test.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { listTranscriptFiles } from '../provider/claude-code/discover.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { indexFile } from './indexFile.ts';

let dir: string;
let db: Db;
const DEV = 'dev-1';
beforeEach(() => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const files = () => listTranscriptFiles(dir);
const alphaMain = () => files().find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
const alphaSub = () => files().find((f) => f.sessionId === SESSION_ALPHA && f.agentId === 'abc123')!;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;

describe('indexFile', () => {
  it('本体ファイルを索引化し、sessions と session_stats を埋める', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ providerSessionId: SESSION_ALPHA, appended: 17, changed: true, badLines: 0 });
    expect(count('select count(*) c from event_index where session_id = ? and parent_agent is null', r.sessionId)).toBe(17);
    const kinds = db.prepare('select kind, count(*) c from event_index where session_id = ? group by kind').all(r.sessionId) as { kind: string; c: number }[];
    expect(Object.fromEntries(kinds.map((k) => [k.kind, k.c]))).toEqual({ user: 2, assistant: 2, thinking: 1, tool_call: 3, tool_result: 3, system: 2, meta: 4 });
    expect(count('select count(*) c from event_fts where session_id = ?', r.sessionId)).toBe(7);
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"チャンネル"')).toBe(1);
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"channels"')).toBe(2);
    const s = db.prepare('select * from sessions where id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(s).toMatchObject({ provider: 'claude-code', provider_session_id: SESSION_ALPHA, cwd: '/Users/me/workspace/alpha', first_prompt: '動画チャンネルの整理をしたい。まず現状を見て', ai_title: '動画チャンネルの整理', name: 'channels-cleanup', home_device: DEV, started_at: Date.parse('2026-09-01T10:00:00.000Z'), last_activity_at: Date.parse('2026-09-01T10:04:00.000Z') });
    const st = db.prepare('select * from session_stats where session_id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(st).toMatchObject({ turns: 2, model: 'claude-fable-5-1', effort: 'high', files_changed: 1, pr_url: 'https://github.com/me/alpha/pull/12', input_tokens: 1110, output_tokens: 140, last_prompt: 'b.md も同じように直して' });
    const tf = db.prepare('select * from transcript_files where path = ?').get(alphaMain().path) as Record<string, unknown>;
    expect(tf).toMatchObject({ session_id: r.sessionId, agent_id: null, indexed_bytes: fs.statSync(alphaMain().path).size, indexer_version: 1 });
  });

  it('変化が無ければ何もしない', () => {
    indexFile(db, alphaMain(), { deviceId: DEV });
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ appended: 0, changed: false });
    expect(count('select count(*) c from changes')).toBe(count('select count(*) c from changes'));
  });

  it('サブエージェントは同じセッションに parent_agent 付きで入り、seq は 0 から', () => {
    const main = indexFile(db, alphaMain(), { deviceId: DEV });
    const sub = indexFile(db, alphaSub(), { deviceId: DEV });
    expect(sub.sessionId).toBe(main.sessionId);
    expect(sub.appended).toBe(2);
    const rows = db.prepare("select seq, kind from event_index where session_id = ? and parent_agent = 'abc123' order by seq").all(main.sessionId);
    expect(rows).toEqual([{ seq: 0, kind: 'user' }, { seq: 1, kind: 'assistant' }]);
    expect(count("select count(*) c from event_fts where session_id = ? and agent_id = 'abc123'", main.sessionId)).toBe(2);
    expect((db.prepare('select turns from session_stats where session_id = ?').get(main.sessionId) as { turns: number }).turns).toBe(2);
  });

  it('サブエージェントを先に索引化してもセッション行ができる', () => {
    const sub = indexFile(db, alphaSub(), { deviceId: DEV });
    expect((db.prepare('select cwd from sessions where id = ?').get(sub.sessionId) as { cwd: string }).cwd).toBe('/Users/me/workspace/alpha');
  });

  it('追記分だけを読み、seq を続ける', () => {
    const first = indexFile(db, alphaMain(), { deviceId: DEV });
    fs.appendFileSync(alphaMain().path, JSON.stringify({ type: 'user', message: { role: 'user', content: '追加の依頼です' }, uuid: 'u9', timestamp: '2026-09-01T11:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA }) + '\n');
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ sessionId: first.sessionId, appended: 1, changed: true });
    expect(db.prepare('select max(seq) m from event_index where session_id = ? and parent_agent is null').get(r.sessionId)).toEqual({ m: 17 });
    expect(count('select count(*) c from event_fts where session_id = ? and text match ?', r.sessionId, '"追加の依頼"')).toBe(1);
    const st = db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(r.sessionId);
    expect(st).toEqual({ turns: 3, last_prompt: '追加の依頼です' });
    expect((db.prepare('select last_activity_at from sessions where id = ?').get(r.sessionId) as { last_activity_at: number }).last_activity_at).toBe(Date.parse('2026-09-01T11:00:00.000Z'));
  });

  it('ファイルが作り直されたら先頭から索引を作り直し、統計を二重に数えない', () => {
    indexFile(db, alphaMain(), { deviceId: DEV });
    const lines = fs.readFileSync(alphaMain().path, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(alphaMain().path, lines.slice(0, 3).join('\n') + '\n');
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r.appended).toBe(3);
    expect(count('select count(*) c from event_index where session_id = ? and parent_agent is null', r.sessionId)).toBe(3);
    expect(count('select count(*) c from event_fts where session_id = ? and agent_id is null', r.sessionId)).toBe(2);
    expect((db.prepare('select turns from session_stats where session_id = ?').get(r.sessionId) as { turns: number }).turns).toBe(1);
  });

  it('版が上がったら作り直す', () => {
    indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: 1 });
    const r = indexFile(db, alphaMain(), { deviceId: DEV, indexerVersion: 2 });
    expect(r.changed).toBe(true);
    expect(count('select count(*) c from event_index where session_id = ?', r.sessionId)).toBe(17);
    expect((db.prepare('select indexer_version v from transcript_files where path = ?').get(alphaMain().path) as { v: number }).v).toBe(2);
  });

  it('壊れた行は数えて飛ばす', () => {
    fs.appendFileSync(alphaMain().path, '{not json\n');
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    expect(r).toMatchObject({ appended: 17, badLines: 1 });
  });

  it('バイト位置から記録を読み戻せる', () => {
    const r = indexFile(db, alphaMain(), { deviceId: DEV });
    const rows = db.prepare('select byte_offset, byte_length, file_path_ref from event_index where session_id = ?').all(r.sessionId) as { byte_offset: number; byte_length: number; file_path_ref: string }[];
    const fd = fs.openSync(alphaMain().path, 'r');
    for (const row of rows) {
      const buf = Buffer.alloc(row.byte_length);
      fs.readSync(fd, buf, 0, row.byte_length, row.byte_offset);
      expect(() => JSON.parse(buf.toString('utf8'))).not.toThrow();
      expect(row.file_path_ref).toBe(alphaMain().path);
    }
    fs.closeSync(fd);
  });

  it('記録に cwd が無ければ cwdFallback を使う', () => {
    const p = path.join(dir, 'projects/-Users-me-workspace-alpha/bbbbbbbb-0000-4000-8000-000000000009.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 'bbbbbbbb-0000-4000-8000-000000000009' }) + '\n');
    const r = indexFile(db, { path: p, sessionId: 'bbbbbbbb-0000-4000-8000-000000000009', agentId: null }, { deviceId: DEV, cwdFallback: '/Users/me/workspace/alpha' });
    expect((db.prepare('select cwd from sessions where id = ?').get(r.sessionId) as { cwd: string }).cwd).toBe('/Users/me/workspace/alpha');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/indexer`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/indexer/indexFile.ts`：

```ts
import fs from 'node:fs';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { readNewLines } from '../provider/claude-code/lines.ts';
import { indexTexts, normalizeRecord, recordFacts } from '../provider/claude-code/normalize.ts';
import type { DiscoveredFile } from '../provider/types.ts';

export const INDEXER_VERSION = 1;
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const FTS_MAX_CHARS = 20000;

export type IndexFileOptions = { deviceId: string; indexerVersion?: number; cwdFallback?: string };
export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number };

type TfRow = { path: string; session_id: string; agent_id: string | null; size: number; mtime: number; indexed_bytes: number; indexer_version: number };

/** 1 ファイル分の事実の積み上げ。主線だけが sessions と session_stats に反映する。 */
type Acc = {
  cwd?: string; firstTs?: number; lastTs?: number; firstPrompt?: string; lastPrompt?: string;
  aiTitle?: string; customTitle?: string; agentName?: string; prUrl?: string; model?: string; effort?: string;
  userTurns: number; input: number; output: number;
};

export function ensureSession(db: Db, providerSessionId: string, cwd: string, deviceId: string): string {
  const row = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(providerSessionId) as { id: string } | undefined;
  if (row) return row.id;
  const id = newId();
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: providerSessionId, cwd, home_device: deviceId }, deviceId);
  return id;
}

export function indexFile(db: Db, file: DiscoveredFile, opts: IndexFileOptions): IndexFileResult {
  const version = opts.indexerVersion ?? INDEXER_VERSION;
  const stat = fs.statSync(file.path);
  const mtime = Math.floor(stat.mtimeMs);
  const tf = db.prepare('select * from transcript_files where path = ?').get(file.path) as TfRow | undefined;
  const sameVersion = tf?.indexer_version === version;
  if (tf && sameVersion && tf.size === stat.size && tf.mtime === mtime) {
    return { sessionId: tf.session_id, providerSessionId: file.sessionId, appended: 0, changed: false, badLines: 0 };
  }
  const from = tf && sameVersion ? tf.indexed_bytes : 0;
  const read = readNewLines(file.path, from);
  const reset = read.reset || from === 0;
  const agentKey = file.agentId ?? '';

  const parsed: { offset: number; length: number; rec: unknown }[] = [];
  let badLines = 0;
  for (const l of read.lines) {
    try { parsed.push({ offset: l.offset, length: l.length, rec: JSON.parse(l.text) }); } catch { badLines++; }
  }

  const insEv = db.prepare('insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, parent_agent, tool_name, file_path) values (?,?,?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)');

  let appended = 0;
  let sessionId = '';
  const run = db.transaction(() => {
    const facts = parsed.map((p) => recordFacts(p.rec));
    const cwd = facts.find((f) => f.cwd)?.cwd ?? opts.cwdFallback ?? '';
    sessionId = tf?.session_id ?? ensureSession(db, file.sessionId, cwd, opts.deviceId);
    if (reset) {
      db.prepare("delete from event_index where session_id = ? and ifnull(parent_agent, '') = ?").run(sessionId, agentKey);
      db.prepare("delete from event_fts where session_id = ? and ifnull(agent_id, '') = ?").run(sessionId, agentKey);
    }
    let seq = reset ? 0 : ((db.prepare("select max(seq) m from event_index where session_id = ? and ifnull(parent_agent, '') = ?").get(sessionId, agentKey) as { m: number | null }).m ?? -1) + 1;
    const acc: Acc = { userTurns: 0, input: 0, output: 0 };
    parsed.forEach((p, i) => {
      const events = normalizeRecord(p.rec, seq, file.agentId);
      for (const ev of events) {
        const toolName = ev.kind === 'tool_call' ? ev.name : null;
        const filePath = ev.kind === 'tool_call' ? ev.filePath ?? null : null;
        insEv.run(sessionId, ev.seq, ev.kind, ev.ts ?? null, p.offset, p.length, file.path, file.agentId, toolName, filePath);
      }
      for (const t of indexTexts(events)) insFts.run(sessionId, file.agentId, t.seq, t.role, t.text.slice(0, FTS_MAX_CHARS));
      seq += events.length;
      appended += events.length;
      const f = facts[i]!;
      if (f.cwd && !acc.cwd) acc.cwd = f.cwd;
      if (f.ts !== undefined) { acc.firstTs = Math.min(acc.firstTs ?? f.ts, f.ts); acc.lastTs = Math.max(acc.lastTs ?? f.ts, f.ts); }
      if (f.isUserTurn) {
        const text = events.find((e) => e.kind === 'user');
        const head = text && text.kind === 'user' ? text.text.slice(0, 200) : '';
        acc.userTurns += 1;
        if (acc.firstPrompt === undefined) acc.firstPrompt = head;
        acc.lastPrompt = head;
      }
      if (f.aiTitle) acc.aiTitle = f.aiTitle;
      if (f.customTitle) acc.customTitle = f.customTitle;
      if (f.agentName) acc.agentName = f.agentName;
      if (f.prUrl) acc.prUrl = f.prUrl;
      if (f.model) acc.model = f.model;
      if (f.effort) acc.effort = f.effort;
      if (f.usage) { acc.input += f.usage.input; acc.output += f.usage.output; }
    });
    db.prepare(`insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, last_error) values (?,?,?,?,?,?,?,null)
      on conflict(path) do update set session_id = excluded.session_id, agent_id = excluded.agent_id, size = excluded.size, mtime = excluded.mtime, indexed_bytes = excluded.indexed_bytes, indexer_version = excluded.indexer_version, last_error = null`)
      .run(file.path, sessionId, file.agentId, stat.size, mtime, read.nextByte, version);
    if (file.agentId === null) applySessionFacts(db, sessionId, acc, reset, opts.deviceId);
    else refreshFilesChanged(db, sessionId);
  });
  run();
  return { sessionId, providerSessionId: file.sessionId, appended, changed: true, badLines };
}

function refreshFilesChanged(db: Db, sessionId: string): void {
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const n = (db.prepare(`select count(distinct file_path) c from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null`).get(sessionId, ...EDIT_TOOLS) as { c: number }).c;
  db.prepare('insert into session_stats (session_id, files_changed) values (?, ?) on conflict(session_id) do update set files_changed = excluded.files_changed').run(sessionId, n);
}

function applySessionFacts(db: Db, sessionId: string, acc: Acc, reset: boolean, deviceId: string): void {
  const cur = db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...cur };
  if (acc.cwd && !cur.cwd) next.cwd = acc.cwd;
  if (acc.firstPrompt !== undefined && (reset || cur.first_prompt == null)) next.first_prompt = acc.firstPrompt;
  if (acc.aiTitle) next.ai_title = acc.aiTitle;
  const name = acc.customTitle ?? acc.agentName;
  if (name) next.name = name;
  if (acc.firstTs !== undefined) next.started_at = reset || cur.started_at == null ? acc.firstTs : Math.min(cur.started_at as number, acc.firstTs);
  if (acc.lastTs !== undefined) next.last_activity_at = reset || cur.last_activity_at == null ? acc.lastTs : Math.max(cur.last_activity_at as number, acc.lastTs);
  delete next.updated_at; delete next.origin_device;
  if (JSON.stringify(next) !== JSON.stringify(Object.fromEntries(Object.entries(cur).filter(([k]) => k !== 'updated_at' && k !== 'origin_device')))) {
    upsertShared(db, 'sessions', next, deviceId);
  }
  const st = db.prepare('select * from session_stats where session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  const base = reset || !st ? { turns: 0, input_tokens: 0, output_tokens: 0 } : { turns: st.turns as number, input_tokens: st.input_tokens as number, output_tokens: st.output_tokens as number };
  db.prepare(`insert into session_stats (session_id, turns, model, effort, pr_url, input_tokens, output_tokens, first_ts, last_ts, last_prompt) values (?,?,?,?,?,?,?,?,?,?)
    on conflict(session_id) do update set turns = excluded.turns, model = excluded.model, effort = excluded.effort, pr_url = excluded.pr_url, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, first_ts = excluded.first_ts, last_ts = excluded.last_ts, last_prompt = excluded.last_prompt`)
    .run(sessionId, base.turns + acc.userTurns, acc.model ?? (reset ? null : st?.model ?? null), acc.effort ?? (reset ? null : st?.effort ?? null), acc.prUrl ?? (reset ? null : st?.pr_url ?? null),
      base.input_tokens + acc.input, base.output_tokens + acc.output,
      acc.firstTs ?? (reset ? null : st?.first_ts ?? null), acc.lastTs ?? (reset ? null : st?.last_ts ?? null),
      acc.lastPrompt ?? (reset ? null : st?.last_prompt ?? null));
  refreshFilesChanged(db, sessionId);
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/indexer && npm run typecheck`
Expected: PASS（10 件）。`appended: 17` は Task 7 のフィクスチャの 17 行がそれぞれ 1 イベントになることに対応する。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/indexer
git commit -m "feat(server): index a transcript file into event index, fts, session row and stats"
```

---

### Task 9: 土台の要約

**Files:**
- Create: `packages/server/src/indexer/baseline.ts`
- Test: `packages/server/src/indexer/baseline.test.ts`

**Interfaces:**
- Consumes: `sessions`、`session_stats`、`event_index`（変更ファイルの一覧）、`upsertShared`。
- Produces:
  ```ts
  export type BaselineInput = { aiTitle: string | null; name: string | null; firstPrompt: string | null; lastPrompt: string | null; files: string[]; turns: number; startedAt: number | null; lastActivityAt: number | null; running: boolean };
  export function formatDuration(ms: number): string;      // '1 分未満' | 'N 分' | 'N 時間 M 分' | 'N 日'
  export function buildBaselineSummary(input: BaselineInput): Omit<SessionSummaryDto, 'updatedAt'>;
  export function writeBaselineIfNeeded(db: Db, sessionId: string, deviceId: string, running: boolean): boolean;   // 書いたら true
  ```
- `writeBaselineIfNeeded` は、`session_summaries` に `source` が `baseline` 以外の行があれば何もしない。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/indexer/baseline.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { listTranscriptFiles } from '../provider/claude-code/discover.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { buildBaselineSummary, formatDuration, writeBaselineIfNeeded } from './baseline.ts';
import { indexFile } from './indexFile.ts';

describe('formatDuration', () => {
  it('粒度を切り替える', () => {
    expect(formatDuration(30_000)).toBe('1 分未満');
    expect(formatDuration(5 * 60_000)).toBe('5 分');
    expect(formatDuration(2 * 3_600_000 + 7 * 60_000)).toBe('2 時間 7 分');
    expect(formatDuration(3 * 86_400_000)).toBe('3 日');
  });
});

describe('buildBaselineSummary', () => {
  const base = { aiTitle: '動画チャンネルの整理', name: 'channels-cleanup', firstPrompt: '動画チャンネルの整理をしたい。まず現状を見て', lastPrompt: 'b.md も同じように直して', files: ['/a/channels/a.md'], turns: 2, startedAt: 0, lastActivityAt: 4 * 60_000, running: false };
  it('題名は ai-title、1 文は最初の発言、本文に最初と最後とファイルと期間を並べる', () => {
    const s = buildBaselineSummary(base);
    expect(s.title).toBe('動画チャンネルの整理');
    expect(s.oneLiner).toBe('動画チャンネルの整理をしたい。まず現状を見て');
    expect(s.body).toBe('最初の依頼：動画チャンネルの整理をしたい。まず現状を見て\n最後の依頼：b.md も同じように直して\n触ったファイル：a.md\n2 ターン、4 分');
    expect(s).toMatchObject({ state: 'done', nextSteps: [], source: 'baseline', sourceModel: null, basedOnTurns: 2 });
  });
  it('ai-title が無ければ名前、それも無ければ最初の発言の先頭 40 字', () => {
    expect(buildBaselineSummary({ ...base, aiTitle: null }).title).toBe('channels-cleanup');
    expect(buildBaselineSummary({ ...base, aiTitle: null, name: null, firstPrompt: 'あ'.repeat(50) }).title).toBe('あ'.repeat(40));
    expect(buildBaselineSummary({ ...base, aiTitle: null, name: null, firstPrompt: null }).title).toBe('題名のないセッション');
  });
  it('実行中なら in_progress、ファイルが多ければ件数を添える', () => {
    const s = buildBaselineSummary({ ...base, running: true, files: ['/a/1.ts', '/a/2.ts', '/a/3.ts', '/a/4.ts', '/a/5.ts', '/a/6.ts', '/a/7.ts'] });
    expect(s.state).toBe('in_progress');
    expect(s.body).toContain('触ったファイル：1.ts, 2.ts, 3.ts, 4.ts, 5.ts ほか 2 件');
  });
  it('最初と最後が同じなら最後を省く', () => {
    expect(buildBaselineSummary({ ...base, lastPrompt: base.firstPrompt, files: [] }).body).toBe('最初の依頼：動画チャンネルの整理をしたい。まず現状を見て\n触ったファイル：なし\n2 ターン、4 分');
  });
});

describe('writeBaselineIfNeeded', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('索引化したセッションに baseline の要約を書く', () => {
    const file = listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const r = indexFile(db, file, { deviceId: 'd' });
    expect(writeBaselineIfNeeded(db, r.sessionId, 'd', false)).toBe(true);
    const row = db.prepare('select * from session_summaries where session_id = ?').get(r.sessionId) as Record<string, unknown>;
    expect(row).toMatchObject({ title: '動画チャンネルの整理', source: 'baseline', state: 'done', based_on_turns: 2 });
    expect(JSON.parse(row.next_steps as string)).toEqual([]);
    expect(row.body).toContain('触ったファイル：a.md');
  });
  it('baseline 以外の要約があれば触らない', () => {
    const file = listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const r = indexFile(db, file, { deviceId: 'd' });
    upsertShared(db, 'session_summaries', { session_id: r.sessionId, title: '手書き', one_liner: 'o', body: 'b', state: 'blocked', next_steps: '[]', source: 'in_session', based_on_turns: 2 }, 'd', 'session_id');
    expect(writeBaselineIfNeeded(db, r.sessionId, 'd', false)).toBe(false);
    expect((db.prepare('select title from session_summaries where session_id = ?').get(r.sessionId) as { title: string }).title).toBe('手書き');
  });
  it('実行中の切り替えで state だけが変わる', () => {
    const file = listTranscriptFiles(dir).find((f) => f.sessionId === SESSION_ALPHA && f.agentId === null)!;
    const r = indexFile(db, file, { deviceId: 'd' });
    writeBaselineIfNeeded(db, r.sessionId, 'd', true);
    expect((db.prepare('select state from session_summaries where session_id = ?').get(r.sessionId) as { state: string }).state).toBe('in_progress');
    writeBaselineIfNeeded(db, r.sessionId, 'd', false);
    expect((db.prepare('select state from session_summaries where session_id = ?').get(r.sessionId) as { state: string }).state).toBe('done');
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/indexer/baseline`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/indexer/baseline.ts`：

```ts
import path from 'node:path';
import type { SessionSummaryDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { EDIT_TOOLS } from './indexFile.ts';

export type BaselineInput = {
  aiTitle: string | null; name: string | null; firstPrompt: string | null; lastPrompt: string | null;
  files: string[]; turns: number; startedAt: number | null; lastActivityAt: number | null; running: boolean;
};

export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '1 分未満';
  if (min < 60) return `${min} 分`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 時間 ${min % 60} 分`;
  return `${Math.floor(hours / 24)} 日`;
}

const head = (s: string | null, n: number): string | null => (s ? [...s].slice(0, n).join('') : null);

/** インデクサが持つ事実だけから機械的に作る要約。モデルは使わない。 */
export function buildBaselineSummary(input: BaselineInput): Omit<SessionSummaryDto, 'updatedAt'> {
  const title = input.aiTitle ?? input.name ?? head(input.firstPrompt, 40) ?? '題名のないセッション';
  const oneLiner = head(input.firstPrompt, 80) ?? '発言のないセッション';
  const lines: string[] = [];
  if (input.firstPrompt) lines.push(`最初の依頼：${head(input.firstPrompt, 200)}`);
  if (input.lastPrompt && input.lastPrompt !== input.firstPrompt) lines.push(`最後の依頼：${head(input.lastPrompt, 200)}`);
  const names = input.files.map((f) => path.basename(f));
  lines.push(names.length === 0 ? '触ったファイル：なし' : `触ったファイル：${names.slice(0, 5).join(', ')}${names.length > 5 ? ` ほか ${names.length - 5} 件` : ''}`);
  const duration = input.startedAt !== null && input.lastActivityAt !== null ? formatDuration(input.lastActivityAt - input.startedAt) : '期間不明';
  lines.push(`${input.turns} ターン、${duration}`);
  return { title, oneLiner, body: lines.join('\n'), state: input.running ? 'in_progress' : 'done', nextSteps: [], source: 'baseline', sourceModel: null, basedOnTurns: input.turns };
}

export function writeBaselineIfNeeded(db: Db, sessionId: string, deviceId: string, running: boolean): boolean {
  const existing = db.prepare('select source from session_summaries where session_id = ?').get(sessionId) as { source: string } | undefined;
  if (existing && existing.source !== 'baseline') return false;
  const s = db.prepare('select ai_title, name, first_prompt, started_at, last_activity_at from sessions where id = ?').get(sessionId) as { ai_title: string | null; name: string | null; first_prompt: string | null; started_at: number | null; last_activity_at: number | null } | undefined;
  if (!s) return false;
  const st = db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(sessionId) as { turns: number; last_prompt: string | null } | undefined;
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const files = (db.prepare(`select distinct file_path f from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null order by seq`).all(sessionId, ...EDIT_TOOLS) as { f: string }[]).map((r) => r.f);
  const sum = buildBaselineSummary({ aiTitle: s.ai_title, name: s.name, firstPrompt: s.first_prompt, lastPrompt: st?.last_prompt ?? null, files, turns: st?.turns ?? 0, startedAt: s.started_at, lastActivityAt: s.last_activity_at, running });
  upsertShared(db, 'session_summaries', { session_id: sessionId, title: sum.title, one_liner: sum.oneLiner, body: sum.body, state: sum.state, next_steps: JSON.stringify(sum.nextSteps), source: sum.source, source_model: null, based_on_turns: sum.basedOnTurns }, deviceId, 'session_id');
  return true;
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/indexer && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/indexer/baseline.ts packages/server/src/indexer/baseline.test.ts
git commit -m "feat(server): baseline session summary from indexed facts"
```

---

### Task 10: プロジェクトの自動登録と解決

**Files:**
- Create: `packages/server/src/projects/registry.ts`
- Test: `packages/server/src/projects/registry.test.ts`

**Interfaces:**
- Consumes: `sessions`、`projects`、`project_roots`、`upsertShared`、`softDeleteShared`、`newId`。
- Produces:
  ```ts
  export function syncProjectsFromWorkspace(db: Db, deviceId: string, workspaceRoot: string): { created: string[] };
  export function assignSessions(db: Db, deviceId: string): number;                  // 未分類のセッションを、この端末の解決済みルートの最長一致で紐づける
  export function checkProjectRoots(db: Db, deviceId: string): { unresolved: string[]; recovered: string[] };
  export function resolveProject(db: Db, deviceId: string, projectId: string, action: ResolveAction): void;
  export function candidateDirs(workspaceRoot: string, name: string): string[];       // 名前が近い直下ディレクトリ
  ```
- 規則：
  - ワークスペースルート直下の、隠しでないディレクトリのうち、`cwd` がそのディレクトリ以下のセッションが 1 つ以上あるものを、`name = basename`、`status = 'active'` のプロジェクトにし、この端末の `project_roots` を `resolved = 1` で作る。同じパスのルートがすでにあれば作らない。
  - `assignSessions` は `project_id` が null のセッションを対象にし、`cwd` が `path` に等しいか `path + '/'` で始まるルートのうち最長のものに紐づける。
  - `checkProjectRoots` はこの端末のルートの存在を見て `resolved` を更新し、0 になったものを `unresolved`、1 に戻ったものを `recovered` に入れる。
  - `resolveProject`：`repoint` はルートの `path` を変えて `resolved = 1` にし、`assignSessions` を呼ぶ。`archive` はプロジェクトの `status` を `archived` にする。`unlink` はプロジェクトとルートを論理削除し、属していたセッションの `project_id` を null にする。
  - `candidateDirs` は、直下ディレクトリのうち、小文字にした名前が互いを含むか、先頭 3 文字が一致するものを名前順に返す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/projects/registry.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { assignSessions, candidateDirs, checkProjectRoots, resolveProject, syncProjectsFromWorkspace } from './registry.ts';

let ws: string;
let db: Db;
const DEV = 'dev-1';
function addSession(id: string, cwd: string) {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: id, cwd, home_device: DEV }, DEV);
}
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  for (const d of ['alpha', 'beta', 'alpha-v2', '.hidden']) fs.mkdirSync(path.join(ws, d));
  db = openDb(':memory:');
  addSession('s-alpha', path.join(ws, 'alpha'));
  addSession('s-alpha-sub', path.join(ws, 'alpha', 'src'));
  addSession('s-other', '/somewhere/else');
});
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

const project = (id: string) => db.prepare('select * from projects where id = ?').get(id) as Record<string, unknown>;
const root = (projectId: string) => db.prepare('select * from project_roots where project_id = ? and device_id = ?').get(projectId, DEV) as Record<string, unknown>;
const sessionProject = (id: string) => (db.prepare('select project_id from sessions where id = ?').get(id) as { project_id: string | null }).project_id;

describe('syncProjectsFromWorkspace', () => {
  it('セッションのある直下ディレクトリだけをプロジェクトにする', () => {
    const r = syncProjectsFromWorkspace(db, DEV, ws);
    expect(r.created).toHaveLength(1);
    expect(project(r.created[0]!)).toMatchObject({ name: 'alpha', status: 'active', is_scratch: 0 });
    expect(root(r.created[0]!)).toMatchObject({ path: path.join(ws, 'alpha'), resolved: 1 });
  });
  it('二度呼んでも増えない', () => {
    syncProjectsFromWorkspace(db, DEV, ws);
    expect(syncProjectsFromWorkspace(db, DEV, ws).created).toEqual([]);
    expect(db.prepare('select count(*) c from projects').get()).toEqual({ c: 1 });
  });
  it('ルートが無ければ何もしない', () => {
    expect(syncProjectsFromWorkspace(db, DEV, path.join(ws, 'nope')).created).toEqual([]);
  });
});

describe('assignSessions', () => {
  it('cwd がルート以下のセッションを紐づけ、外のものは未分類のまま', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    expect(assignSessions(db, DEV)).toBe(2);
    expect(sessionProject('s-alpha')).toBe(pid);
    expect(sessionProject('s-alpha-sub')).toBe(pid);
    expect(sessionProject('s-other')).toBeNull();
  });
  it('最長一致のルートを選ぶ', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    upsertShared(db, 'projects', { id: 'p-src', name: 'src', status: 'active', is_scratch: 0 }, DEV);
    upsertShared(db, 'project_roots', { id: 'r-src', project_id: 'p-src', device_id: DEV, path: path.join(ws, 'alpha', 'src'), resolved: 1 }, DEV);
    assignSessions(db, DEV);
    expect(sessionProject('s-alpha')).toBe(pid);
    expect(sessionProject('s-alpha-sub')).toBe('p-src');
  });
});

describe('checkProjectRoots', () => {
  it('消えたルートを unresolved、戻ったら recovered', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [] });
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [pid], recovered: [] });
    expect(root(pid!).resolved).toBe(0);
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [] });
    fs.renameSync(path.join(ws, 'alpha-moved'), path.join(ws, 'alpha'));
    expect(checkProjectRoots(db, DEV)).toEqual({ unresolved: [], recovered: [pid] });
  });
});

describe('resolveProject', () => {
  it('repoint はパスを変えて再び紐づける', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    fs.renameSync(path.join(ws, 'alpha'), path.join(ws, 'alpha-moved'));
    checkProjectRoots(db, DEV);
    addSession('s-moved', path.join(ws, 'alpha-moved'));
    resolveProject(db, DEV, pid!, { kind: 'repoint', path: path.join(ws, 'alpha-moved') });
    expect(root(pid!)).toMatchObject({ path: path.join(ws, 'alpha-moved'), resolved: 1 });
    expect(sessionProject('s-moved')).toBe(pid);
  });
  it('archive は status を archived にする', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    resolveProject(db, DEV, pid!, { kind: 'archive' });
    expect(project(pid!).status).toBe('archived');
  });
  it('unlink はプロジェクトとルートを論理削除し、セッションを未分類に戻す', () => {
    const [pid] = syncProjectsFromWorkspace(db, DEV, ws).created;
    assignSessions(db, DEV);
    resolveProject(db, DEV, pid!, { kind: 'unlink' });
    expect(project(pid!).deleted_at).not.toBeNull();
    expect(root(pid!).deleted_at).not.toBeNull();
    expect(sessionProject('s-alpha')).toBeNull();
  });
});

describe('candidateDirs', () => {
  it('名前が近い直下ディレクトリを返す', () => {
    expect(candidateDirs(ws, 'alpha')).toEqual([path.join(ws, 'alpha'), path.join(ws, 'alpha-v2')]);
    expect(candidateDirs(ws, 'zzz')).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/projects`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/projects/registry.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { newId, type ResolveAction } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';

type RootRow = { id: string; project_id: string; device_id: string; path: string; resolved: number; deleted_at: number | null };

function childDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => path.join(root, d.name))
    .sort();
}

function hasSessionUnder(db: Db, dir: string): boolean {
  return db.prepare("select 1 from sessions where deleted_at is null and (cwd = ? or cwd like ? escape '\\') limit 1")
    .get(dir, dir.replace(/[%_\\]/g, (c) => '\\' + c) + '/%') !== undefined;
}

export function syncProjectsFromWorkspace(db: Db, deviceId: string, workspaceRoot: string): { created: string[] } {
  const created: string[] = [];
  for (const dir of childDirs(workspaceRoot)) {
    if (!hasSessionUnder(db, dir)) continue;
    const exists = db.prepare('select 1 from project_roots where device_id = ? and path = ? and deleted_at is null').get(deviceId, dir);
    if (exists) continue;
    const id = newId();
    upsertShared(db, 'projects', { id, name: path.basename(dir), status: 'active', is_scratch: 0 }, deviceId);
    upsertShared(db, 'project_roots', { id: newId(), project_id: id, device_id: deviceId, path: dir, resolved: 1 }, deviceId);
    created.push(id);
  }
  return { created };
}

export function assignSessions(db: Db, deviceId: string): number {
  const roots = db.prepare('select * from project_roots where device_id = ? and resolved = 1 and deleted_at is null').all(deviceId) as RootRow[];
  const sessions = db.prepare('select * from sessions where project_id is null and deleted_at is null').all() as Record<string, unknown>[];
  let n = 0;
  for (const s of sessions) {
    const cwd = s.cwd as string;
    const match = roots.filter((r) => cwd === r.path || cwd.startsWith(r.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
    if (!match) continue;
    upsertShared(db, 'sessions', { ...s, project_id: match.project_id }, deviceId);
    n++;
  }
  return n;
}

export function checkProjectRoots(db: Db, deviceId: string): { unresolved: string[]; recovered: string[] } {
  const out = { unresolved: [] as string[], recovered: [] as string[] };
  const roots = db.prepare('select * from project_roots where device_id = ? and deleted_at is null').all(deviceId) as RootRow[];
  for (const r of roots) {
    const exists = fs.existsSync(r.path);
    if (exists && r.resolved === 0) { upsertShared(db, 'project_roots', { ...r, resolved: 1 }, deviceId); out.recovered.push(r.project_id); }
    if (!exists && r.resolved === 1) { upsertShared(db, 'project_roots', { ...r, resolved: 0 }, deviceId); out.unresolved.push(r.project_id); }
  }
  return out;
}

export function resolveProject(db: Db, deviceId: string, projectId: string, action: ResolveAction): void {
  const root = db.prepare('select * from project_roots where project_id = ? and device_id = ? and deleted_at is null').get(projectId, deviceId) as RootRow | undefined;
  const project = db.prepare('select * from projects where id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!project) return;
  switch (action.kind) {
    case 'repoint':
      if (root) upsertShared(db, 'project_roots', { ...root, path: action.path, resolved: 1 }, deviceId);
      else upsertShared(db, 'project_roots', { id: newId(), project_id: projectId, device_id: deviceId, path: action.path, resolved: 1 }, deviceId);
      assignSessions(db, deviceId);
      return;
    case 'archive':
      upsertShared(db, 'projects', { ...project, status: 'archived' }, deviceId);
      return;
    case 'unlink': {
      const sessions = db.prepare('select * from sessions where project_id = ?').all(projectId) as Record<string, unknown>[];
      for (const s of sessions) upsertShared(db, 'sessions', { ...s, project_id: null }, deviceId);
      if (root) softDeleteShared(db, 'project_roots', root.id, deviceId);
      softDeleteShared(db, 'projects', projectId, deviceId);
      return;
    }
  }
}

export function candidateDirs(workspaceRoot: string, name: string): string[] {
  const needle = name.toLowerCase();
  return childDirs(workspaceRoot).filter((dir) => {
    const base = path.basename(dir).toLowerCase();
    return base.includes(needle) || needle.includes(base) || (needle.length >= 3 && base.startsWith(needle.slice(0, 3)));
  });
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/projects && npm run typecheck`
Expected: PASS（10 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/projects
git commit -m "feat(server): project auto-registration, assignment and resolution"
```

---

### Task 11: 実行中レジストリの監視

**Files:**
- Create: `packages/server/src/provider/claude-code/registry.ts`
- Test: `packages/server/src/provider/claude-code/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function readRegistry(claudeDir: string): LiveSession[];     // sessions/*.json を読む。壊れた JSON と .json 以外は無視。sessionId 昇順
  export class RegistryWatcher {
    constructor(claudeDir: string, intervalMs?: number);              // 既定 500ms
    start(): void; stop(): void;
    current(): LiveSession[];
    onChange(cb: (live: LiveSession[]) => void): () => void;         // 内容が変わったときだけ呼ぶ
  }
  ```
- `status` が `busy`、`idle`、`waiting` 以外なら `busy` とみなす。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/provider/claude-code/registry.test.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFixtureClaudeDir, FIXTURE_CLAUDE_DIR, SESSION_ALPHA } from '../../../test/fixtures.ts';
import { readRegistry, RegistryWatcher } from './registry.ts';

describe('readRegistry', () => {
  it('json だけを読み、3 値の status と名前を返す', () => {
    expect(readRegistry(FIXTURE_CLAUDE_DIR)).toEqual([
      { sessionId: SESSION_ALPHA, status: 'busy', name: 'channels-cleanup', nameSource: 'user', cwd: '/Users/me/workspace/alpha', pid: 12345 },
    ]);
  });
  it('ディレクトリが無ければ空', () => {
    expect(readRegistry('/nonexistent')).toEqual([]);
  });
});

describe('RegistryWatcher', () => {
  let dir: string;
  beforeEach(() => { dir = copyFixtureClaudeDir(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('変化したときだけ通知する', () => {
    const w = new RegistryWatcher(dir, 500);
    const seen: unknown[] = [];
    w.onChange((l) => seen.push(l));
    w.start();
    expect(w.current()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(0);
    const file = path.join(dir, 'sessions/12345.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, status: 'idle' }));
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { status: string }[])[0]!.status).toBe('idle');
    fs.rmSync(file);
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([]);
    w.stop();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/provider/claude-code/registry`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/provider/claude-code/registry.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { LiveStatus } from '@agent-hangar/shared';
import type { LiveSession } from '../types.ts';

const STATUSES = new Set<LiveStatus>(['busy', 'idle', 'waiting']);

/** ~/.claude/sessions/<pid>.json を読む。ファイルの出現と消失が起動と終了に対応する。 */
export function readRegistry(claudeDir: string): LiveSession[] {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (typeof rec.sessionId !== 'string') continue;
    const status = STATUSES.has(rec.status as LiveStatus) ? (rec.status as LiveStatus) : 'busy';
    out.push({ sessionId: rec.sessionId, status, name: typeof rec.name === 'string' ? rec.name : null, nameSource: typeof rec.nameSource === 'string' ? rec.nameSource : null, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', pid: typeof rec.pid === 'number' ? rec.pid : 0 });
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export class RegistryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last: LiveSession[] = [];
  private lastKey = '';
  private listeners = new Set<(live: LiveSession[]) => void>();
  constructor(private readonly claudeDir: string, private readonly intervalMs = 500) {}

  start(): void {
    this.poll(false);
    this.timer = setInterval(() => this.poll(true), this.intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  current(): LiveSession[] { return this.last; }
  onChange(cb: (live: LiveSession[]) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  private poll(notify: boolean): void {
    const live = readRegistry(this.claudeDir);
    const key = JSON.stringify(live);
    if (key === this.lastKey) return;
    this.last = live; this.lastKey = key;
    if (notify) for (const cb of this.listeners) cb(live);
  }
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/provider/claude-code/registry && npm run typecheck`
Expected: PASS（3 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/provider/claude-code/registry.ts packages/server/src/provider/claude-code/registry.test.ts
git commit -m "feat(server): poll the claude code live session registry"
```

---

### Task 12: インデクサのサービス（全走査、監視、進行、本文なしセッション）

**Files:**
- Create: `packages/server/src/indexer/service.ts`
- Test: `packages/server/src/indexer/service.test.ts`

**Interfaces:**
- Consumes: `listTranscriptFiles`、`readHistoryIndex`、`indexFile`、`ensureSession`、`writeBaselineIfNeeded`、`upsertShared`。
- Produces:
  ```ts
  export type IndexerListener = {
    progress?: (p: IndexProgressDto) => void;
    sessionChanged?: (e: { sessionId: string; providerSessionId: string; agentId: string | null; appended: number }) => void;
    error?: (e: { path: string; message: string }) => void;
  };
  export class IndexerService {
    constructor(opts: { db: Db; deviceId: string; claudeDir: string; isRunning: (providerSessionId: string) => boolean; pollMs?: number; debounceMs?: number });
    on(listener: IndexerListener): () => void;
    progress(): IndexProgressDto;
    fullScan(): Promise<{ files: number; changed: number }>;   // 20 ファイルごとに setImmediate で譲る
    tick(): { changed: number };                                // 全ファイルを stat 比較で見て、変わったものだけ索引化
    syncHistoryOnly(): number;                                  // history.jsonl にあって本文の無いセッションを sessions に作る
    start(): Promise<void>;                                     // fullScan → fs.watch と定期 tick
    stop(): void;
    rebuild(): Promise<void>;                                   // transcript_files.indexer_version を 0 にして fullScan
  }
  ```
- 振る舞い：
  - `fullScan` は `phase: 'scanning'` で列挙し、`phase: 'indexing'` で `done / total` を進め、終わったら `idle` を出す。`rebuild` 中は `phase: 'rebuilding'`。
  - 索引化して `changed` なら `writeBaselineIfNeeded(db, sessionId, deviceId, isRunning(providerSessionId))` を呼び、`sessionChanged` を通知する。
  - `syncHistoryOnly` は、`history.jsonl` にあって `transcript_files` に主線の無いセッションを `ensureSession` で作り、`first_prompt`、`started_at`、`last_activity_at` を history の値で埋め、土台の要約を書く。既に本文があるセッションは触らない。
  - 監視は `fs.watch(projects, { recursive: true })` で、通知から `debounceMs`（既定 300）後に `tick()` を呼ぶ。`fs.watch` が投げたら諦めて定期 `tick`（既定 `pollMs = 2000`）だけで動く。`history.jsonl` の変化は `fs.watch(claudeDir)` で拾い、`syncHistoryOnly` を呼ぶ。
  - 例外は `error` に流し、他のファイルの索引化を止めない。`transcript_files.last_error` にも書く。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/indexer/service.test.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_BETA } from '../../test/fixtures.ts';
import { IndexerService } from './service.ts';

let dir: string;
let db: Db;
beforeEach(() => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const make = () => new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: (id) => id === SESSION_ALPHA });
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;

describe('IndexerService', () => {
  it('fullScan は全ファイルを索引化し、進行を通知し、本文なしセッションも作る', async () => {
    const svc = make();
    const progress: unknown[] = [];
    const changed: string[] = [];
    svc.on({ progress: (p) => progress.push(p), sessionChanged: (e) => changed.push(e.providerSessionId + ':' + (e.agentId ?? '')) });
    const r = await svc.fullScan();
    expect(r).toEqual({ files: 3, changed: 3 });
    expect(progress[0]).toEqual({ phase: 'scanning', done: 0, total: 0 });
    expect(progress.at(-1)).toEqual({ phase: 'idle', done: 3, total: 3 });
    expect(changed.sort()).toEqual([`${SESSION_ALPHA}:`, `${SESSION_ALPHA}:abc123`, 'aaaaaaaa-0000-4000-8000-000000000003:']);
    expect(count('select count(*) c from sessions')).toBe(3);
    const beta = db.prepare('select * from sessions where provider_session_id = ?').get(SESSION_BETA) as Record<string, unknown>;
    expect(beta).toMatchObject({ cwd: '/Users/me/workspace/beta', first_prompt: 'beta の README を書いて', started_at: 1788343200000, last_activity_at: 1788343200000 });
    expect(count('select count(*) c from session_summaries')).toBe(3);
    const alpha = db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string };
    expect((db.prepare('select state from session_summaries where session_id = ?').get(alpha.id) as { state: string }).state).toBe('in_progress');
  });

  it('tick は変わったファイルだけを索引化する', async () => {
    const svc = make();
    await svc.fullScan();
    const changed: number[] = [];
    svc.on({ sessionChanged: (e) => changed.push(e.appended) });
    expect(svc.tick()).toEqual({ changed: 0 });
    const alpha = path.join(dir, 'projects/-Users-me-workspace-alpha', `${SESSION_ALPHA}.jsonl`);
    fs.appendFileSync(alpha, JSON.stringify({ type: 'user', message: { role: 'user', content: '追加' }, uuid: 'u9', timestamp: '2026-09-01T11:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: SESSION_ALPHA }) + '\n');
    expect(svc.tick()).toEqual({ changed: 1 });
    expect(changed).toEqual([1]);
  });

  it('新しいファイルは tick で拾う', async () => {
    const svc = make();
    await svc.fullScan();
    const p = path.join(dir, 'projects/-Users-me-workspace-beta');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, `${SESSION_BETA}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'beta の README を書いて' }, uuid: 'b1', timestamp: '2026-09-02T10:00:00.000Z', cwd: '/Users/me/workspace/beta', sessionId: SESSION_BETA }) + '\n');
    expect(svc.tick()).toEqual({ changed: 1 });
    expect(count('select count(*) c from sessions')).toBe(3);
    expect(count('select count(*) c from transcript_files where session_id = (select id from sessions where provider_session_id = ?)', SESSION_BETA)).toBe(1);
  });

  it('rebuild は全件を作り直し、行を重複させない', async () => {
    const svc = make();
    await svc.fullScan();
    const before = count('select count(*) c from event_index');
    const phases: string[] = [];
    svc.on({ progress: (p) => phases.push(p.phase) });
    await svc.rebuild();
    expect(phases).toContain('rebuilding');
    expect(count('select count(*) c from event_index')).toBe(before);
    expect(count('select count(*) c from event_fts')).toBe(7 + 2 + 1 + 1);
  });

  it('壊れたファイルは error に流し、他は進む', async () => {
    fs.mkdirSync(path.join(dir, 'projects/-x'));
    const bad = path.join(dir, 'projects/-x', 'cccccccc-0000-4000-8000-000000000001.jsonl');
    fs.mkdirSync(bad);   // ディレクトリを .jsonl の名前にして statSync 後の読み取りを失敗させる
    const svc = make();
    const errors: string[] = [];
    svc.on({ error: (e) => errors.push(e.path) });
    const r = await svc.fullScan();
    expect(errors).toEqual([bad]);
    expect(r.changed).toBe(3);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/indexer/service`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/indexer/service.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { IndexProgressDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { listTranscriptFiles, readHistoryIndex } from '../provider/claude-code/discover.ts';
import type { DiscoveredFile } from '../provider/types.ts';
import { writeBaselineIfNeeded } from './baseline.ts';
import { ensureSession, indexFile } from './indexFile.ts';

export type IndexerListener = {
  progress?: (p: IndexProgressDto) => void;
  sessionChanged?: (e: { sessionId: string; providerSessionId: string; agentId: string | null; appended: number }) => void;
  error?: (e: { path: string; message: string }) => void;
};

type Opts = { db: Db; deviceId: string; claudeDir: string; isRunning: (providerSessionId: string) => boolean; pollMs?: number; debounceMs?: number };

export class IndexerService {
  private listeners = new Set<IndexerListener>();
  private state: IndexProgressDto = { phase: 'idle', done: 0, total: 0 };
  private watchers: fs.FSWatcher[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(private readonly opts: Opts) {}

  on(listener: IndexerListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  progress(): IndexProgressDto { return this.state; }

  private setProgress(p: IndexProgressDto): void { this.state = p; for (const l of this.listeners) l.progress?.(p); }

  private indexOne(file: DiscoveredFile, history: Map<string, { cwd: string }>): boolean {
    try {
      const r = indexFile(this.opts.db, file, { deviceId: this.opts.deviceId, cwdFallback: history.get(file.sessionId)?.cwd });
      if (!r.changed) return false;
      if (file.agentId === null || r.appended > 0) writeBaselineIfNeeded(this.opts.db, r.sessionId, this.opts.deviceId, this.opts.isRunning(file.sessionId));
      for (const l of this.listeners) l.sessionChanged?.({ sessionId: r.sessionId, providerSessionId: file.sessionId, agentId: file.agentId, appended: r.appended });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try { this.opts.db.prepare('update transcript_files set last_error = ? where path = ?').run(message, file.path); } catch { /* 行が無ければ無視 */ }
      for (const l of this.listeners) l.error?.({ path: file.path, message });
      return false;
    }
  }

  async fullScan(phase: 'indexing' | 'rebuilding' = 'indexing'): Promise<{ files: number; changed: number }> {
    if (this.scanning) return { files: 0, changed: 0 };
    this.scanning = true;
    try {
      this.setProgress({ phase: 'scanning', done: 0, total: 0 });
      const files = listTranscriptFiles(this.opts.claudeDir);
      const history = readHistoryIndex(this.opts.claudeDir);
      let changed = 0;
      this.setProgress({ phase, done: 0, total: files.length });
      for (let i = 0; i < files.length; i++) {
        if (this.indexOne(files[i]!, history)) changed++;
        if (i % 20 === 19) { this.setProgress({ phase, done: i + 1, total: files.length }); await new Promise<void>((r) => setImmediate(r)); }
      }
      this.syncHistoryOnly(history);
      this.setProgress({ phase: 'idle', done: files.length, total: files.length });
      return { files: files.length, changed };
    } finally { this.scanning = false; }
  }

  tick(): { changed: number } {
    const history = readHistoryIndex(this.opts.claudeDir);
    let changed = 0;
    for (const f of listTranscriptFiles(this.opts.claudeDir)) if (this.indexOne(f, history)) changed++;
    return { changed };
  }

  /** history.jsonl にあって本文ファイルの無いセッションを「本文なし」として登録する。 */
  syncHistoryOnly(history = readHistoryIndex(this.opts.claudeDir)): number {
    const db = this.opts.db;
    const hasMain = db.prepare('select 1 from transcript_files where session_id = ? and agent_id is null limit 1');
    let n = 0;
    for (const [providerSessionId, h] of history) {
      const sessionId = ensureSession(db, providerSessionId, h.cwd, this.opts.deviceId);
      if (hasMain.get(sessionId)) continue;
      const cur = db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown>;
      const next = { ...cur, first_prompt: cur.first_prompt ?? h.firstDisplay, started_at: cur.started_at ?? h.firstTs, last_activity_at: h.lastTs };
      if (JSON.stringify(next) !== JSON.stringify(cur)) { upsertShared(db, 'sessions', next, this.opts.deviceId); n++; }
      db.prepare('insert into session_stats (session_id, turns, last_prompt) values (?, ?, ?) on conflict(session_id) do update set turns = excluded.turns').run(sessionId, h.count, h.firstDisplay);
      writeBaselineIfNeeded(db, sessionId, this.opts.deviceId, this.opts.isRunning(providerSessionId));
    }
    return n;
  }

  async start(): Promise<void> {
    await this.fullScan();
    const projects = path.join(this.opts.claudeDir, 'projects');
    const schedule = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => { this.debounceTimer = null; this.tick(); }, this.opts.debounceMs ?? 300);
    };
    try {
      if (fs.existsSync(projects)) this.watchers.push(fs.watch(projects, { recursive: true }, schedule));
      this.watchers.push(fs.watch(this.opts.claudeDir, (_e, name) => {
        if (name !== 'history.jsonl') return;
        if (this.historyTimer) clearTimeout(this.historyTimer);
        this.historyTimer = setTimeout(() => { this.historyTimer = null; this.syncHistoryOnly(); }, 1000);
      }));
    } catch (e) {
      for (const l of this.listeners) l.error?.({ path: projects, message: `fs.watch failed, polling only: ${e instanceof Error ? e.message : String(e)}` });
    }
    this.pollTimer = setInterval(() => { if (!this.scanning) this.tick(); }, this.opts.pollMs ?? 2000);
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.pollTimer = this.debounceTimer = this.historyTimer = null;
  }

  async rebuild(): Promise<void> {
    this.opts.db.prepare('update transcript_files set indexer_version = 0').run();
    await this.fullScan('rebuilding');
  }
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/indexer && npm run typecheck`
Expected: PASS。`rebuild` のテストの `7 + 2 + 1 + 1` は、alpha 本体 7 行、サブエージェント 2 行、other 1 行（user）と 1 行（assistant）に対応する。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/indexer/service.ts packages/server/src/indexer/service.test.ts
git commit -m "feat(server): indexer service with full scan, watch, progress and history-only sessions"
```

---

### Task 13: 本文の読み出しと検索

**Files:**
- Create: `packages/server/src/transcript/read.ts`、`packages/server/src/search/search.ts`
- Test: `packages/server/src/transcript/read.test.ts`、`packages/server/src/search/search.test.ts`

**Interfaces:**
- Consumes: `event_index`（`byte_offset`、`byte_length`、`file_path_ref`、`parent_agent`）、`event_fts`、`normalizeRecord`、`toFtsQuery`。
- Produces:
  ```ts
  // transcript/read.ts
  export function readEvents(db: Db, sessionId: string, opts: { fromSeq?: number; limit?: number; agentId?: string | null }): EventsPageDto;
  //   同じバイト位置の行は 1 回だけ読み、normalizeRecord で得たイベントのうち seq が範囲に入るものを返す。
  //   agentId 省略時は主線。limit の既定は 500、最大 2000。nextSeq は残りがあれば次の seq、無ければ null。
  export function subagentIds(db: Db, sessionId: string): string[];
  // search/search.ts
  export function searchSessions(db: Db, params: SearchParamsDto, runningIds?: Set<string>): SearchResultDto;
  //   q が空（toFtsQuery が null）なら hits は空。session_id ごとに件数を集計し、snippet(event_fts, 4, '', '', '…', 12) を最大 3 件添える。
  //   絞り込み：projectId は sessions.project_id、since/until は sessions.last_activity_at。
  //   running は「実行中の provider_session_id の集合」を第三引数で受けて、true なら集合にあるもの、false なら無いものに絞る。
  //   file は event_index.file_path の部分一致（like）。limit の既定は 50。並びは matchCount 降順、last_activity_at 降順。
  ```

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/transcript/read.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { readEvents, subagentIds } from './read.ts';

let dir: string;
let db: Db;
let alphaId: string;
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readEvents', () => {
  it('主線を seq 順に返す', () => {
    const page = readEvents(db, alphaId, {});
    expect(page.total).toBe(17);
    expect(page.nextSeq).toBeNull();
    expect(page.events.map((e) => e.seq)).toEqual([...Array(17).keys()]);
    expect(page.events[0]).toMatchObject({ kind: 'user', text: '動画チャンネルの整理をしたい。まず現状を見て' });
    expect(page.events[6]).toMatchObject({ kind: 'tool_result', isError: true, text: 'File not found' });
    expect(page.events[13]).toMatchObject({ kind: 'meta', name: 'ai-title' });
  });
  it('fromSeq と limit でページを切る', () => {
    const p1 = readEvents(db, alphaId, { fromSeq: 0, limit: 5 });
    expect(p1.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(p1.nextSeq).toBe(5);
    const p2 = readEvents(db, alphaId, { fromSeq: p1.nextSeq!, limit: 100 });
    expect(p2.events[0]!.seq).toBe(5);
    expect(p2.nextSeq).toBeNull();
  });
  it('サブエージェントの本文を agentId で読む', () => {
    expect(subagentIds(db, alphaId)).toEqual(['abc123']);
    const page = readEvents(db, alphaId, { agentId: 'abc123' });
    expect(page.events.map((e) => e.kind)).toEqual(['user', 'assistant']);
  });
  it('知らないセッションは空', () => {
    expect(readEvents(db, 'nope', {})).toEqual({ sessionId: 'nope', events: [], total: 0, nextSeq: null });
  });
});
```

`packages/server/src/search/search.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { searchSessions } from './search.ts';

let dir: string;
let db: Db;
const idOf = (p: string) => (db.prepare('select id from sessions where provider_session_id = ?').get(p) as { id: string }).id;
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('searchSessions', () => {
  it('日本語の部分一致で当たり、抜粋を返す', () => {
    const r = searchSessions(db, { q: 'チャンネル' });
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: idOf(SESSION_ALPHA), matchCount: 1 });
    expect(r.hits[0]!.snippets[0]!.text).toContain('チャンネル');
    expect(r.hits[0]!.snippets[0]!.role).toBe('user');
  });
  it('ハイフン入りの語も落ちない', () => {
    expect(() => searchSessions(db, { q: 'agent-hangar' })).not.toThrow();
  });
  it('複数語は AND', () => {
    expect(searchSessions(db, { q: 'channels hello' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels' }).total).toBe(1);
  });
  it('空の検索語は空の結果', () => {
    expect(searchSessions(db, { q: '' })).toEqual({ hits: [], total: 0 });
  });
  it('プロジェクト、期間、実行中、ファイルで絞る', () => {
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    const alpha = db.prepare('select * from sessions where id = ?').get(idOf(SESSION_ALPHA)) as Record<string, unknown>;
    upsertShared(db, 'sessions', { ...alpha, project_id: 'p1' }, 'd');
    expect(searchSessions(db, { q: 'channels', projectId: 'p1' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', projectId: 'p2' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', since: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', until: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', running: true }, new Set()).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', running: true }, new Set([SESSION_ALPHA])).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', running: false }, new Set([SESSION_ALPHA])).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', file: 'a.md' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', file: 'zzz' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello' }).hits[0]!.sessionId).toBe(idOf(SESSION_OTHER));
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/transcript packages/server/src/search`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/transcript/read.ts`：

```ts
import fs from 'node:fs';
import type { EventsPageDto, TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { normalizeRecord } from '../provider/claude-code/normalize.ts';

type Row = { seq: number; byte_offset: number; byte_length: number; file_path_ref: string };

export function subagentIds(db: Db, sessionId: string): string[] {
  return (db.prepare('select distinct parent_agent a from event_index where session_id = ? and parent_agent is not null order by a').all(sessionId) as { a: string }[]).map((r) => r.a);
}

/** 索引のバイト位置から本文ファイルを読み、正規化イベントを返す。DB には本文が無い。 */
export function readEvents(db: Db, sessionId: string, opts: { fromSeq?: number; limit?: number; agentId?: string | null }): EventsPageDto {
  const agent = opts.agentId ?? null;
  const fromSeq = opts.fromSeq ?? 0;
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const agentKey = agent ?? '';
  const total = (db.prepare("select count(*) c from event_index where session_id = ? and ifnull(parent_agent, '') = ?").get(sessionId, agentKey) as { c: number }).c;
  const rows = db.prepare("select seq, byte_offset, byte_length, file_path_ref from event_index where session_id = ? and ifnull(parent_agent, '') = ? and seq >= ? order by seq limit ?")
    .all(sessionId, agentKey, fromSeq, limit + 1) as Row[];
  const hasMore = rows.length > limit;
  const wanted = rows.slice(0, limit);
  const events: TranscriptEvent[] = [];
  let fd: number | null = null;
  let fdPath = '';
  try {
    // 同じ記録（同じバイト位置）から出た複数のイベントは 1 回の読み取りで得る。
    let i = 0;
    while (i < wanted.length) {
      const r = wanted[i]!;
      if (fdPath !== r.file_path_ref) { if (fd !== null) fs.closeSync(fd); fd = fs.openSync(r.file_path_ref, 'r'); fdPath = r.file_path_ref; }
      const buf = Buffer.alloc(r.byte_length);
      fs.readSync(fd!, buf, 0, r.byte_length, r.byte_offset);
      let rec: unknown;
      try { rec = JSON.parse(buf.toString('utf8')); } catch { rec = null; }
      let j = i;
      while (j < wanted.length && wanted[j]!.byte_offset === r.byte_offset && wanted[j]!.file_path_ref === r.file_path_ref) j++;
      const firstSeq = (db.prepare("select min(seq) s from event_index where session_id = ? and ifnull(parent_agent, '') = ? and byte_offset = ? and file_path_ref = ?").get(sessionId, agentKey, r.byte_offset, r.file_path_ref) as { s: number }).s;
      const all = rec === null ? [] : normalizeRecord(rec, firstSeq, agent);
      const lastSeq = wanted[j - 1]!.seq;
      for (const ev of all) if (ev.seq >= r.seq && ev.seq <= lastSeq) events.push(ev);
      i = j;
    }
  } finally { if (fd !== null) fs.closeSync(fd); }
  return { sessionId, events, total, nextSeq: hasMore ? rows[limit]!.seq : null };
}
```

`packages/server/src/search/search.ts`：

```ts
import { toFtsQuery, type SearchParamsDto, type SearchResultDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

export function searchSessions(db: Db, params: SearchParamsDto, runningIds: Set<string> = new Set()): SearchResultDto {
  const match = toFtsQuery(params.q);
  if (!match) return { hits: [], total: 0 };
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const where: string[] = ['f.text match ?'];
  const args: unknown[] = [match];
  if (params.projectId) { where.push('s.project_id = ?'); args.push(params.projectId); }
  if (params.since !== undefined) { where.push('s.last_activity_at >= ?'); args.push(params.since); }
  if (params.until !== undefined) { where.push('s.last_activity_at < ?'); args.push(params.until); }
  if (params.file) { where.push("exists (select 1 from event_index e where e.session_id = s.id and e.file_path like ? escape '\\')"); args.push('%' + params.file.replace(/[%_\\]/g, (c) => '\\' + c) + '%'); }
  const sql = `select s.id sid, s.provider_session_id psid, count(*) n from event_fts f join sessions s on s.id = f.session_id where ${where.join(' and ')} and s.deleted_at is null group by s.id order by n desc, s.last_activity_at desc`;
  let rows = db.prepare(sql).all(...args) as { sid: string; psid: string; n: number }[];
  if (params.running !== undefined) rows = rows.filter((r) => runningIds.has(r.psid) === params.running);
  const total = rows.length;
  const snip = db.prepare("select seq, role, snippet(event_fts, 4, '', '', '…', 12) text from event_fts where session_id = ? and text match ? limit 3");
  const hits = rows.slice(0, limit).map((r) => ({ sessionId: r.sid, matchCount: r.n, snippets: snip.all(r.sid, match) as { seq: number; role: string; text: string }[] }));
  return { hits, total };
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/transcript packages/server/src/search && npm run typecheck`
Expected: PASS（9 件）

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/transcript packages/server/src/search
git commit -m "feat(server): read transcript events from byte offsets and search sessions via fts"
```

---

### Task 14: DTO の問い合わせ

**Files:**
- Create: `packages/server/src/db/queries.ts`
- Test: `packages/server/src/db/queries.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function listProjects(db: Db, deviceId: string, live: LiveSessionDto[]): ProjectDto[];
  export function getProject(db: Db, deviceId: string, live: LiveSessionDto[], id: string): ProjectDto | null;
  export function listSessions(db: Db, live: LiveSessionDto[], opts?: { projectId?: string; ids?: string[] }): SessionDto[];   // last_activity_at 降順
  export function getSession(db: Db, live: LiveSessionDto[], id: string): SessionDto | null;
  export function displayName(session: { name: string | null; ai_title: string | null; first_prompt: string | null }, live: LiveSessionDto | undefined): string | null;
  ```
- `ProjectDto.path` と `resolved` はこの端末の `project_roots` から。`lastActivityAt` は属するセッションの最大値。`runningCount` は属するセッションのうち `live` にあるもの。`openTodoCount` と `memoHead` はフェーズ 1 では 0 と null。
- `SessionDto.name` は `displayName` の結果。優先順は、`live.nameSource === 'user'` の `live.name`、`sessions.name`、`ai_title`、`first_prompt` の先頭 40 字。`live` はレジストリの `sessionId`（provider の UUID）で引く。
- `hasTranscript` は `transcript_files` に主線があるか。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/db/queries.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './open.ts';
import { upsertShared } from './shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_BETA } from '../../test/fixtures.ts';
import { displayName, getSession, listProjects, listSessions } from './queries.ts';
import type { LiveSessionDto } from '@agent-hangar/shared';

let dir: string;
let db: Db;
const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'waiting', name: 'renamed', nameSource: 'user', cwd: '/Users/me/workspace/alpha', pid: 1 }];
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('listSessions', () => {
  it('新しい順に、要約と統計と実行状態を付けて返す', () => {
    const list = listSessions(db, live);
    expect(list.map((s) => s.providerSessionId)).toEqual([SESSION_BETA, SESSION_ALPHA, 'aaaaaaaa-0000-4000-8000-000000000003']);
    const alpha = list[1]!;
    expect(alpha).toMatchObject({ projectId: 'p1', name: 'renamed', live: 'waiting', hasTranscript: true, cwd: '/Users/me/workspace/alpha' });
    expect(alpha.summary).toMatchObject({ title: '動画チャンネルの整理', source: 'baseline' });
    expect(alpha.stats).toMatchObject({ turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: 'https://github.com/me/alpha/pull/12' });
    const beta = list[0]!;
    expect(beta).toMatchObject({ hasTranscript: false, live: null, name: 'beta の README を書いて' });
  });
  it('projectId と ids で絞る', () => {
    expect(listSessions(db, live, { projectId: 'p1' })).toHaveLength(1);
    const id = listSessions(db, live)[0]!.id;
    expect(listSessions(db, live, { ids: [id] }).map((s) => s.id)).toEqual([id]);
  });
});

describe('getSession', () => {
  it('無ければ null', () => { expect(getSession(db, live, 'nope')).toBeNull(); });
});

describe('displayName', () => {
  it('利用者が付けた名前、hangar の名前、ai-title、最初の発言の順', () => {
    const l = (nameSource: string): LiveSessionDto => ({ sessionId: 'x', status: 'idle', name: 'L', nameSource, cwd: '', pid: 1 });
    expect(displayName({ name: 'N', ai_title: 'T', first_prompt: 'P' }, l('user'))).toBe('L');
    expect(displayName({ name: 'N', ai_title: 'T', first_prompt: 'P' }, l('derived'))).toBe('N');
    expect(displayName({ name: null, ai_title: 'T', first_prompt: 'P' }, undefined)).toBe('T');
    expect(displayName({ name: null, ai_title: null, first_prompt: 'あ'.repeat(50) }, undefined)).toBe('あ'.repeat(40));
    expect(displayName({ name: null, ai_title: null, first_prompt: null }, undefined)).toBeNull();
  });
});

describe('listProjects', () => {
  it('パス、最終活動、実行中の数を付ける', () => {
    const [p] = listProjects(db, 'd', live);
    expect(p).toMatchObject({ id: 'p1', name: 'alpha', path: '/Users/me/workspace/alpha', resolved: true, runningCount: 1, openTodoCount: 0, memoHead: null, lastActivityAt: Date.parse('2026-09-01T10:04:00.000Z') });
  });
  it('ワークスペース登録と組み合わせて動く', () => {
    fs.mkdirSync('/tmp/hangar-ws-test/beta', { recursive: true });
    upsertShared(db, 'sessions', { id: 'x', provider: 'claude-code', provider_session_id: 'x', cwd: '/tmp/hangar-ws-test/beta', home_device: 'd' }, 'd');
    syncProjectsFromWorkspace(db, 'd', '/tmp/hangar-ws-test');
    expect(listProjects(db, 'd', live).map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
    fs.rmSync('/tmp/hangar-ws-test', { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/db/queries`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/db/queries.ts`：

```ts
import type { LiveSessionDto, ProjectDto, SessionDto, SessionStatsDto, SessionSummaryDto } from '@agent-hangar/shared';
import type { Db } from './open.ts';

type SessionRow = { id: string; provider: 'claude-code'; provider_session_id: string; project_id: string | null; name: string | null; cwd: string; first_prompt: string | null; ai_title: string | null; started_at: number | null; last_activity_at: number | null; memo: string | null; has_transcript: number; sum_title: string | null; sum_one: string | null; sum_body: string | null; sum_state: SessionSummaryDto['state'] | null; sum_next: string | null; sum_source: SessionSummaryDto['source'] | null; sum_model: string | null; sum_turns: number | null; sum_updated: number | null; st_turns: number | null; st_model: string | null; st_effort: string | null; st_files: number | null; st_pr: string | null; st_in: number | null; st_out: number | null };

const SESSION_SELECT = `
select s.*, exists(select 1 from transcript_files t where t.session_id = s.id and t.agent_id is null) has_transcript,
  m.title sum_title, m.one_liner sum_one, m.body sum_body, m.state sum_state, m.next_steps sum_next, m.source sum_source, m.source_model sum_model, m.based_on_turns sum_turns, m.updated_at sum_updated,
  st.turns st_turns, st.model st_model, st.effort st_effort, st.files_changed st_files, st.pr_url st_pr, st.input_tokens st_in, st.output_tokens st_out
from sessions s
left join session_summaries m on m.session_id = s.id and m.deleted_at is null
left join session_stats st on st.session_id = s.id
where s.deleted_at is null`;

export function displayName(s: { name: string | null; ai_title: string | null; first_prompt: string | null }, live: LiveSessionDto | undefined): string | null {
  if (live?.nameSource === 'user' && live.name) return live.name;
  if (s.name) return s.name;
  if (s.ai_title) return s.ai_title;
  if (s.first_prompt) return [...s.first_prompt].slice(0, 40).join('');
  return null;
}

function toDto(r: SessionRow, liveMap: Map<string, LiveSessionDto>): SessionDto {
  const live = liveMap.get(r.provider_session_id);
  const summary: SessionSummaryDto | null = r.sum_title !== null ? { title: r.sum_title, oneLiner: r.sum_one ?? '', body: r.sum_body ?? '', state: r.sum_state ?? 'done', nextSteps: JSON.parse(r.sum_next ?? '[]') as string[], source: r.sum_source ?? 'baseline', sourceModel: r.sum_model, basedOnTurns: r.sum_turns ?? 0, updatedAt: r.sum_updated ?? 0 } : null;
  const stats: SessionStatsDto = { turns: r.st_turns ?? 0, model: r.st_model, effort: r.st_effort, filesChanged: r.st_files ?? 0, prUrl: r.st_pr, inputTokens: r.st_in ?? 0, outputTokens: r.st_out ?? 0 };
  return { id: r.id, provider: r.provider, providerSessionId: r.provider_session_id, projectId: r.project_id, name: displayName(r, live), cwd: r.cwd, firstPrompt: r.first_prompt, aiTitle: r.ai_title, startedAt: r.started_at, lastActivityAt: r.last_activity_at, memo: r.memo, hasTranscript: r.has_transcript === 1, live: live?.status ?? null, summary, stats };
}

const liveMapOf = (live: LiveSessionDto[]) => new Map(live.map((l) => [l.sessionId, l]));

export function listSessions(db: Db, live: LiveSessionDto[], opts: { projectId?: string; ids?: string[] } = {}): SessionDto[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.projectId) { where.push('s.project_id = ?'); args.push(opts.projectId); }
  if (opts.ids) { if (opts.ids.length === 0) return []; where.push(`s.id in (${opts.ids.map(() => '?').join(',')})`); args.push(...opts.ids); }
  const sql = `${SESSION_SELECT}${where.length ? ' and ' + where.join(' and ') : ''} order by s.last_activity_at desc nulls last, s.started_at desc`;
  const rows = db.prepare(sql).all(...args) as SessionRow[];
  const lm = liveMapOf(live);
  return rows.map((r) => toDto(r, lm));
}

export function getSession(db: Db, live: LiveSessionDto[], id: string): SessionDto | null {
  const r = db.prepare(`${SESSION_SELECT} and s.id = ?`).get(id) as SessionRow | undefined;
  return r ? toDto(r, liveMapOf(live)) : null;
}

type ProjectRow = { id: string; name: string; status: ProjectDto['status']; is_scratch: number; updated_at: number; path: string | null; resolved: number | null; last_activity_at: number | null };

const PROJECT_SELECT = `
select p.id, p.name, p.status, p.is_scratch, p.updated_at, r.path, r.resolved,
  (select max(last_activity_at) from sessions s where s.project_id = p.id and s.deleted_at is null) last_activity_at
from projects p
left join project_roots r on r.project_id = p.id and r.device_id = ? and r.deleted_at is null
where p.deleted_at is null`;

function toProject(r: ProjectRow, db: Db, liveIds: Set<string>): ProjectDto {
  const psids = (db.prepare('select provider_session_id p from sessions where project_id = ? and deleted_at is null').all(r.id) as { p: string }[]).map((x) => x.p);
  return { id: r.id, name: r.name, status: r.status, isScratch: r.is_scratch === 1, path: r.path, resolved: r.resolved === null ? false : r.resolved === 1, lastActivityAt: r.last_activity_at, runningCount: psids.filter((p) => liveIds.has(p)).length, openTodoCount: 0, memoHead: null, updatedAt: r.updated_at };
}

export function listProjects(db: Db, deviceId: string, live: LiveSessionDto[]): ProjectDto[] {
  const rows = db.prepare(`${PROJECT_SELECT} order by last_activity_at desc nulls last, p.name`).all(deviceId) as ProjectRow[];
  const liveIds = new Set(live.map((l) => l.sessionId));
  return rows.map((r) => toProject(r, db, liveIds));
}

export function getProject(db: Db, deviceId: string, live: LiveSessionDto[], id: string): ProjectDto | null {
  const r = db.prepare(`${PROJECT_SELECT} and p.id = ?`).get(deviceId, id) as ProjectRow | undefined;
  return r ? toProject(r, db, new Set(live.map((l) => l.sessionId))) : null;
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server/src/db && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/db/queries.ts packages/server/src/db/queries.test.ts
git commit -m "feat(server): dto queries for projects and sessions with live state"
```

---

### Task 15: HTTP API、認証、WebSocket ハブ、サーバ起動

**Files:**
- Create: `packages/server/src/http/auth.ts`、`packages/server/src/http/app.ts`、`packages/server/src/ws/hub.ts`、`packages/server/src/server.ts`、`packages/server/src/main.ts`、`packages/server/src/index.ts`
- Test: `packages/server/src/http/app.test.ts`、`packages/server/src/http/auth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // http/auth.ts
  export const ALLOWED_ORIGINS = ['http://localhost:4177', 'http://127.0.0.1:4177', 'http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost'];
  export function originAllowed(origin: string | undefined): boolean;   // 無しは許可（curl と同一オリジンの fetch）、あれば一覧に限る
  export function tokenFromRequest(headers: Headers, cookieHeader: string | undefined): string | null;  // Bearer か hangar_token クッキー
  export function authMiddleware(token: string): MiddlewareHandler;      // 401 と 403 を返す
  // ws/hub.ts
  export class EventHub { attach(server: http.Server, opts: { path: string; token: string }): void; broadcast(ev: ServerEvent): void; clientCount(): number; close(): void; }
  // http/app.ts
  export type AppDeps = { db: Db; deviceId: string; deviceName: string; token: string; home: string; version: string; settings: () => Settings; updateSettings: (patch: Partial<SettingsDto>) => Settings; live: () => LiveSessionDto[]; indexer: { progress(): IndexProgressDto; rebuild(): Promise<void> }; hub: { broadcast(ev: ServerEvent): void }; uiDist?: string };
  export function createApp(deps: AppDeps): Hono;
  // server.ts
  export function startServer(opts?: { port?: number; host?: string; home?: string; uiDist?: string }): Promise<{ close(): Promise<void>; port: number }>;
  ```
- ルート（すべて `/api` 配下は認証必須）：
  - `GET /api/bootstrap` → `BootstrapDto`
  - `GET /api/projects`、`GET /api/projects/:id`、`PATCH /api/projects/:id` `{ status }`、`POST /api/projects/:id/resolve` `ResolveAction`、`GET /api/projects/:id/candidates?name=`
  - `GET /api/sessions?projectId=`、`GET /api/sessions/:id`、`GET /api/sessions/:id/events?fromSeq=&limit=&agentId=`、`GET /api/sessions/:id/subagents`
  - `GET /api/search?q=&projectId=&since=&until=&running=&file=&limit=`
  - `GET /api/settings`、`PATCH /api/settings`
  - `POST /api/index/rebuild`（202 を返し、背景で `rebuild`）
  - `GET /health`（認証なし、`{ ok: true, version }`）
  - `GET /`（`uiDist` があれば `index.html` を返し、`Set-Cookie: hangar_token=<token>; HttpOnly; SameSite=Strict; Path=/`。`/assets/*` も配信）
- `PATCH /api/projects/:id` と `resolve` と `PATCH /api/settings` は、書いた後に `project.upsert` か `toast` を `hub.broadcast` する。

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/http/auth.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { originAllowed, tokenFromRequest } from './auth.ts';

describe('originAllowed', () => {
  it('Origin 無しと一覧のものは許可、他は拒否', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('http://127.0.0.1:4177')).toBe(true);
    expect(originAllowed('tauri://localhost')).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('http://127.0.0.1:4178')).toBe(false);
  });
});

describe('tokenFromRequest', () => {
  it('Bearer を優先し、無ければクッキー', () => {
    expect(tokenFromRequest(new Headers({ authorization: 'Bearer abc' }), 'hangar_token=zzz')).toBe('abc');
    expect(tokenFromRequest(new Headers(), 'a=1; hangar_token=zzz; b=2')).toBe('zzz');
    expect(tokenFromRequest(new Headers(), undefined)).toBeNull();
  });
});
```

`packages/server/src/http/app.test.ts`：

```ts
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { createApp } from './app.ts';

let dir: string;
let db: Db;
let ws: string;
let app: ReturnType<typeof createApp>;
const sent: ServerEvent[] = [];
const TOKEN = 'test-token';
const H = { authorization: `Bearer ${TOKEN}` };
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0;
  ws = fs.mkdtempSync('/tmp/hangar-app-');
  fs.mkdirSync(`${ws}/alpha`);
  const indexer = new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false });
  await indexer.fullScan();
  db.prepare("update sessions set cwd = ? where provider_session_id = ?").run(`${ws}/alpha`, SESSION_ALPHA);
  syncProjectsFromWorkspace(db, 'd', ws); assignSessions(db, 'd');
  let settings = { workspaceRoot: ws, claudeDir: dir };
  app = createApp({ db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, version: '0.0.0-test', settings: () => settings, updateSettings: (p) => (settings = { ...settings, ...p }), live: () => [], indexer, hub: { broadcast: (e) => sent.push(e) } });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });

describe('auth', () => {
  it('トークンが無ければ 401、Origin が違えば 403、/health は素通し', async () => {
    expect((await get('/api/bootstrap', {})).status).toBe(401);
    expect((await get('/api/bootstrap', { ...H, origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/api/bootstrap', { cookie: `hangar_token=${TOKEN}` })).status).toBe(200);
    expect((await get('/health', {})).status).toBe(200);
  });
});

describe('routes', () => {
  it('bootstrap は全部を返す', async () => {
    const { status, body } = await json(await get('/api/bootstrap'));
    expect(status).toBe(200);
    expect(body.device).toEqual({ id: 'd', name: 'mac' });
    expect(body.projects).toHaveLength(1);
    expect(body.sessions).toHaveLength(3);
    expect(body.index.phase).toBe('idle');
    expect(body.version).toBe('0.0.0-test');
  });
  it('プロジェクトの取得、状態変更、候補、解決', async () => {
    const { body: list } = await json(await get('/api/projects'));
    const id = list[0].id;
    expect((await json(await get(`/api/projects/${id}`))).body.name).toBe('alpha');
    const r = await app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'paused' }) });
    expect((await r.json()).status).toBe('paused');
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id, status: 'paused' } });
    expect((await json(await get(`/api/projects/${id}/candidates?name=alp`))).body).toEqual([`${ws}/alpha`]);
    const r2 = await app.request(`/api/projects/${id}/resolve`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'archive' }) });
    expect((await r2.json()).status).toBe('archived');
    expect((await get('/api/projects/nope')).status).toBe(404);
    const bad = await app.request(`/api/projects/${id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }) });
    expect(bad.status).toBe(400);
  });
  it('セッションと本文とサブエージェント', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    expect((await json(await get(`/api/sessions/${alpha.id}`))).body.name).toBe('channels-cleanup');
    const { body: page } = await json(await get(`/api/sessions/${alpha.id}/events?fromSeq=0&limit=5`));
    expect(page.events).toHaveLength(5);
    expect(page.nextSeq).toBe(5);
    expect((await json(await get(`/api/sessions/${alpha.id}/subagents`))).body).toEqual(['abc123']);
    expect((await json(await get(`/api/sessions/${alpha.id}/events?agentId=abc123`))).body.events).toHaveLength(2);
    expect((await get('/api/sessions/nope')).status).toBe(404);
  });
  it('検索', async () => {
    const { body } = await json(await get('/api/search?q=' + encodeURIComponent('チャンネル')));
    expect(body.total).toBe(1);
    expect((await json(await get('/api/search?q='))).body).toEqual({ hits: [], total: 0 });
  });
  it('設定の取得と更新', async () => {
    expect((await json(await get('/api/settings'))).body.workspaceRoot).toBe(ws);
    const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: '/tmp/x' }) });
    expect((await r.json()).workspaceRoot).toBe('/tmp/x');
  });
  it('索引の作り直しは 202', async () => {
    const r = await app.request('/api/index/rebuild', { method: 'POST', headers: H });
    expect(r.status).toBe(202);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/server/src/http`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/server/src/http/auth.ts`：

```ts
import type { MiddlewareHandler } from 'hono';

export const ALLOWED_ORIGINS = ['http://localhost:4177', 'http://127.0.0.1:4177', 'http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost'];

export function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || ALLOWED_ORIGINS.includes(origin);
}

export function tokenFromRequest(headers: Headers, cookieHeader: string | undefined): string | null {
  const auth = headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'hangar_token') return v.join('=');
  }
  return null;
}

/** ブラウザの他サイトからの要求を Origin で拒み、ローカルトークンで認証する。 */
export function authMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!originAllowed(c.req.header('origin'))) return c.json({ error: 'origin not allowed' }, 403);
    const got = tokenFromRequest(c.req.raw.headers, c.req.header('cookie'));
    if (got !== token) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
```

`packages/server/src/ws/hub.ts`：

```ts
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerEvent } from '@agent-hangar/shared';
import { originAllowed, tokenFromRequest } from '../http/auth.ts';

/** UI へのイベント配信。接続時に ready を送り、以後は broadcast を全員に流す。 */
export class EventHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  constructor(private readonly version: string) {}

  attach(server: http.Server, opts: { path: string; token: string }): void {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== opts.path) return;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const token = tokenFromRequest(headers, req.headers.cookie) ?? url.searchParams.get('token');
      if (!originAllowed(req.headers.origin) || token !== opts.token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.send(JSON.stringify({ type: 'ready', version: this.version } satisfies ServerEvent));
      });
    });
  }
  broadcast(ev: ServerEvent): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(data);
  }
  clientCount(): number { return this.clients.size; }
  close(): void { for (const c of this.clients) c.close(); this.clients.clear(); this.wss?.close(); }
}
```

`packages/server/src/http/app.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { BootstrapDto, IndexProgressDto, LiveSessionDto, ResolveAction, ServerEvent, SettingsDto } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listProjects, listSessions } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { candidateDirs, resolveProject } from '../projects/registry.ts';
import { searchSessions } from '../search/search.ts';
import { readEvents, subagentIds } from '../transcript/read.ts';
import { authMiddleware } from './auth.ts';

export type AppDeps = {
  db: Db; deviceId: string; deviceName: string; token: string; home: string; version: string;
  settings: () => Settings; updateSettings: (patch: Partial<SettingsDto>) => Settings;
  live: () => LiveSessionDto[];
  indexer: { progress(): IndexProgressDto; rebuild(): Promise<void> };
  hub: { broadcast(ev: ServerEvent): void };
  uiDist?: string;
};

const STATUSES = new Set(['active', 'paused', 'done', 'archived']);
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { db, deviceId } = deps;

  app.get('/health', (c) => c.json({ ok: true, version: deps.version }));

  const api = new Hono();
  api.use('*', authMiddleware(deps.token));

  api.get('/bootstrap', (c) => {
    const live = deps.live();
    const s = deps.settings();
    const body: BootstrapDto = { device: { id: deviceId, name: deps.deviceName }, settings: { workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir }, projects: listProjects(db, deviceId, live), sessions: listSessions(db, live), live, index: deps.indexer.progress(), version: deps.version };
    return c.json(body);
  });

  api.get('/projects', (c) => c.json(listProjects(db, deviceId, deps.live())));
  api.get('/projects/:id', (c) => { const p = getProject(db, deviceId, deps.live(), c.req.param('id')); return p ? c.json(p) : c.json({ error: 'not found' }, 404); });
  api.patch('/projects/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    if (!body.status || !STATUSES.has(body.status)) return c.json({ error: 'invalid status' }, 400);
    const row = db.prepare('select * from projects where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: 'not found' }, 404);
    upsertShared(db, 'projects', { ...row, status: body.status }, deviceId);
    const p = getProject(db, deviceId, deps.live(), id)!;
    deps.hub.broadcast({ type: 'project.upsert', project: p });
    return c.json(p);
  });
  api.get('/projects/:id/candidates', (c) => c.json(candidateDirs(deps.settings().workspaceRoot, c.req.query('name') ?? '')));
  api.post('/projects/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const action = (await c.req.json().catch(() => null)) as ResolveAction | null;
    if (!action || !['repoint', 'archive', 'unlink'].includes(action.kind)) return c.json({ error: 'invalid action' }, 400);
    if (action.kind === 'repoint' && (typeof action.path !== 'string' || !fs.existsSync(action.path))) return c.json({ error: 'path not found' }, 400);
    if (!getProject(db, deviceId, deps.live(), id)) return c.json({ error: 'not found' }, 404);
    resolveProject(db, deviceId, id, action);
    const p = getProject(db, deviceId, deps.live(), id);
    if (p) deps.hub.broadcast({ type: 'project.upsert', project: p });
    for (const s of listSessions(db, deps.live())) deps.hub.broadcast({ type: 'session.upsert', session: s });
    return c.json(p ?? { id, unlinked: true });
  });

  api.get('/sessions', (c) => c.json(listSessions(db, deps.live(), { projectId: c.req.query('projectId') })));
  api.get('/sessions/:id', (c) => { const s = getSession(db, deps.live(), c.req.param('id')); return s ? c.json(s) : c.json({ error: 'not found' }, 404); });
  api.get('/sessions/:id/events', (c) => {
    const q = c.req.query();
    return c.json(readEvents(db, c.req.param('id'), { fromSeq: q.fromSeq ? Number(q.fromSeq) : undefined, limit: q.limit ? Number(q.limit) : undefined, agentId: q.agentId || null }));
  });
  api.get('/sessions/:id/subagents', (c) => c.json(subagentIds(db, c.req.param('id'))));

  api.get('/search', (c) => {
    const q = c.req.query();
    const running = q.running === undefined ? undefined : q.running === 'true';
    const runningIds = new Set(deps.live().map((l) => l.sessionId));
    return c.json(searchSessions(db, { q: q.q ?? '', projectId: q.projectId || undefined, since: q.since ? Number(q.since) : undefined, until: q.until ? Number(q.until) : undefined, running, file: q.file || undefined, limit: q.limit ? Number(q.limit) : undefined }, runningIds));
  });

  api.get('/settings', (c) => { const s = deps.settings(); return c.json({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir } satisfies SettingsDto); });
  api.patch('/settings', async (c) => {
    const patch = (await c.req.json().catch(() => ({}))) as Partial<SettingsDto>;
    const s = deps.updateSettings(patch);
    deps.hub.broadcast({ type: 'toast', level: 'info', message: '設定を保存しました' });
    return c.json({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir } satisfies SettingsDto);
  });
  api.post('/index/rebuild', (c) => { void deps.indexer.rebuild(); return c.body(null, 202); });

  app.route('/api', api);

  if (deps.uiDist) {
    const dist = deps.uiDist;
    const index = () => fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.get('/', (c) => { c.header('Set-Cookie', `hangar_token=${deps.token}; HttpOnly; SameSite=Strict; Path=/`); return c.html(index()); });
    app.get('/assets/*', (c) => {
      const rel = c.req.path.replace(/^\//, '');
      const file = path.join(dist, rel);
      if (!file.startsWith(dist) || !fs.existsSync(file)) return c.notFound();
      c.header('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(fs.readFileSync(file));
    });
  }
  return app;
}
```

`packages/server/src/server.ts`：

```ts
import { serve } from '@hono/node-server';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultClaudeDir, dbPath, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type Settings } from './config/paths.ts';
import { openDb } from './db/open.ts';
import { getSession, listProjects } from './db/queries.ts';
import { createApp } from './http/app.ts';
import { IndexerService } from './indexer/service.ts';
import { assignSessions, checkProjectRoots, syncProjectsFromWorkspace } from './projects/registry.ts';
import { RegistryWatcher } from './provider/claude-code/registry.ts';
import { EventHub } from './ws/hub.ts';

export const VERSION = '0.1.0';

export async function startServer(opts: { port?: number; host?: string; home?: string; uiDist?: string } = {}): Promise<{ close(): Promise<void>; port: number }> {
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  const token = readOrCreateToken(home);
  const device = readOrCreateDevice(home);
  let settings: Settings = loadSettings(home);
  const db = openDb(dbPath(home));
  const hub = new EventHub(VERSION);
  const registry = new RegistryWatcher(settings.claudeDir || defaultClaudeDir());
  const indexer = new IndexerService({ db, deviceId: device.id, claudeDir: settings.claudeDir, isRunning: (id) => registry.current().some((l) => l.sessionId === id) });

  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    sessionChanged: (e) => { const s = getSession(db, registry.current(), e.sessionId); if (s) { hub.broadcast({ type: 'session.upsert', session: s }); if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended }); } },
    error: (e) => console.error('[indexer]', e.path, e.message),
  });
  registry.onChange((live) => {
    hub.broadcast({ type: 'live.update', live });
    for (const p of listProjects(db, device.id, live)) hub.broadcast({ type: 'project.upsert', project: p });
  });

  const uiDist = opts.uiDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
  const app = createApp({
    db, deviceId: device.id, deviceName: device.name, token, home, version: VERSION,
    settings: () => settings,
    updateSettings: (patch) => { settings = { ...settings, ...patch }; saveSettings(home, settings); return settings; },
    live: () => registry.current(), indexer, hub, uiDist,
  });

  const port = opts.port ?? 4177;
  const host = opts.host ?? '127.0.0.1';
  const server = await new Promise<http.Server>((resolve) => { const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s as http.Server)); });
  hub.attach(server, { path: '/ws', token });

  registry.start();
  await indexer.start();
  syncProjectsFromWorkspace(db, device.id, settings.workspaceRoot);
  assignSessions(db, device.id);
  const roots = checkProjectRoots(db, device.id);
  for (const id of roots.unresolved) hub.broadcast({ type: 'project.unresolved', projectId: id });
  setInterval(() => { for (const id of checkProjectRoots(db, device.id).unresolved) hub.broadcast({ type: 'project.unresolved', projectId: id }); }, 30_000).unref();

  console.log(`agent-hangar listening on http://${host}:${port}`);
  return {
    port,
    close: async () => { indexer.stop(); registry.stop(); hub.close(); await new Promise<void>((r) => server.close(() => r())); db.close(); },
  };
}
```

`packages/server/src/main.ts`：

```ts
import { startServer } from './server.ts';

const port = process.env.HANGAR_PORT ? Number(process.env.HANGAR_PORT) : undefined;
startServer({ port }).then((s) => {
  const stop = () => { s.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Tauri などの親が消えたら自分も終わる。
  if (process.env.HANGAR_PARENT_PID) {
    const ppid = Number(process.env.HANGAR_PARENT_PID);
    setInterval(() => { try { process.kill(ppid, 0); } catch { stop(); } }, 5000).unref();
  }
}).catch((e) => { console.error(e); process.exit(1); });
```

`packages/server/src/index.ts`：

```ts
export { startServer, VERSION } from './server.ts';
export { hangarHome, ensureHome, readOrCreateToken, readOrCreateDevice, loadSettings, saveSettings } from './config/paths.ts';
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/server && npm run typecheck`
Expected: PASS（全件）

- [ ] **Step 5: 実物で起動を確かめる**

Run: `HANGAR_HOME=/tmp/hangar-smoke HANGAR_PORT=4199 npx tsx packages/server/src/main.ts & sleep 8; curl -s -H "Authorization: Bearer $(cat /tmp/hangar-smoke/token)" http://127.0.0.1:4199/api/bootstrap | head -c 600; echo; kill %1; rm -rf /tmp/hangar-smoke`
Expected: 実物の `~/.claude` を読み取り専用で索引化し、`projects` と `sessions` を含む JSON が返る。起動から 8 秒以内に全件索引化が終わる（フェーズ 0 の実測は 7 秒）。

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/http packages/server/src/ws packages/server/src/server.ts packages/server/src/main.ts packages/server/src/index.ts
git commit -m "feat(server): http api with token auth, websocket hub and server bootstrap"
```

---

### Task 16: CLI（setup、start、status、open）

**Files:**
- Create: `packages/cli/package.json`、`packages/cli/tsconfig.json`、`packages/cli/vitest.config.ts`、`packages/cli/src/index.ts`、`packages/cli/src/setup.ts`、`packages/cli/bin/hangar.mjs`
- Test: `packages/cli/src/setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SetupReport = { home: string; deviceId: string; tools: { name: string; found: boolean; path: string | null }[]; workspaceRoot: string; workspaceExists: boolean };
  export function runSetup(opts: { home: string; workspaceRoot?: string; which?: (cmd: string) => string | null }): SetupReport;   // 1 と 2 と 3 の前半（ディレクトリ、トークン、端末 ID、ツール確認、ワークスペース確認）。プロジェクト登録はサーバ起動時に行う
  export function formatSetupReport(r: SetupReport): string;
  ```
- コマンド：`hangar setup [--workspace <dir>]`、`hangar start [--port <n>]`、`hangar status`（`/health` を叩く）、`hangar open`（`open http://127.0.0.1:4177/`）。statusline への追記と `mcp install` はフェーズ 2 と 3 で足す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/cli/src/setup.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSetupReport, runSetup } from './setup.ts';

describe('runSetup', () => {
  it('ホームを作り、ツールとワークスペースを報告する', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const r = runSetup({ home, workspaceRoot: ws, which: (c) => (c === 'tmux' ? '/opt/homebrew/bin/tmux' : null) });
    expect(fs.existsSync(path.join(home, 'token'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'device.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).workspaceRoot).toBe(ws);
    expect(r.tools).toEqual([
      { name: 'tmux', found: true, path: '/opt/homebrew/bin/tmux' },
      { name: 'claude', found: false, path: null },
      { name: 'code', found: false, path: null },
    ]);
    expect(r.workspaceExists).toBe(true);
    const text = formatSetupReport(r);
    expect(text).toContain('tmux: /opt/homebrew/bin/tmux');
    expect(text).toContain('claude: 見つかりません');
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npm install && npx vitest run packages/cli`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/cli/package.json`：

```json
{
  "name": "@agent-hangar/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "hangar": "./bin/hangar.mjs" },
  "scripts": { "typecheck": "tsc -p ." },
  "dependencies": { "@agent-hangar/server": "*", "commander": "^15.0.0", "tsx": "^4.23.13" }
}
```

`packages/cli/tsconfig.json`：`{ "extends": "../../tsconfig.base.json", "include": ["src"] }`

`packages/cli/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'cli', environment: 'node', include: ['src/**/*.test.ts'] } });
```

`packages/cli/bin/hangar.mjs`：

```js
#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
const r = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
```

`packages/cli/src/setup.ts`：

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings } from '@agent-hangar/server';

export type SetupReport = { home: string; deviceId: string; tools: { name: string; found: boolean; path: string | null }[]; workspaceRoot: string; workspaceExists: boolean };

export function whichCmd(cmd: string): string | null {
  try { return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

export function runSetup(opts: { home: string; workspaceRoot?: string; which?: (cmd: string) => string | null }): SetupReport {
  const which = opts.which ?? whichCmd;
  ensureHome(opts.home);
  readOrCreateToken(opts.home);
  const device = readOrCreateDevice(opts.home);
  const settings = loadSettings(opts.home);
  if (opts.workspaceRoot) settings.workspaceRoot = path.resolve(opts.workspaceRoot.replace(/^~/, os.homedir()));
  saveSettings(opts.home, settings);
  const tools = ['tmux', 'claude', 'code'].map((name) => { const p = which(name); return { name, found: p !== null, path: p }; });
  return { home: opts.home, deviceId: device.id, tools, workspaceRoot: settings.workspaceRoot, workspaceExists: fs.existsSync(settings.workspaceRoot) };
}

export function formatSetupReport(r: SetupReport): string {
  const lines = [`データディレクトリ: ${r.home}`, `端末 ID: ${r.deviceId}`];
  for (const t of r.tools) lines.push(`${t.name}: ${t.found ? t.path : '見つかりません'}`);
  lines.push(`ワークスペース: ${r.workspaceRoot}${r.workspaceExists ? '' : '（存在しません。hangar setup --workspace <dir> で変えられます）'}`);
  lines.push('プロジェクトの自動登録は hangar start の起動時に行います。');
  return lines.join('\n');
}
```

`packages/cli/src/index.ts`：

```ts
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { hangarHome, startServer } from '@agent-hangar/server';
import { formatSetupReport, runSetup } from './setup.ts';

const program = new Command().name('hangar').description('agent-hangar のコマンド');
program.command('setup').option('--workspace <dir>', 'ワークスペースのルート').action((o: { workspace?: string }) => {
  console.log(formatSetupReport(runSetup({ home: hangarHome(), workspaceRoot: o.workspace })));
});
program.command('start').option('--port <n>', 'ポート', '4177').action(async (o: { port: string }) => {
  await startServer({ port: Number(o.port) });
});
program.command('status').option('--port <n>', 'ポート', '4177').action(async (o: { port: string }) => {
  try { const r = await fetch(`http://127.0.0.1:${o.port}/health`); console.log(await r.text()); }
  catch { console.log('停止しています'); process.exitCode = 1; }
});
program.command('open').option('--port <n>', 'ポート', '4177').action((o: { port: string }) => {
  spawn('open', [`http://127.0.0.1:${o.port}/`], { stdio: 'ignore', detached: true }).unref();
});
program.parseAsync(process.argv);
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/cli && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add package-lock.json packages/cli
git commit -m "feat(cli): hangar setup, start, status and open commands"
```

---

### Task 17: UI の骨格とデザイントークン

**Files:**
- Create: `packages/ui/package.json`、`packages/ui/tsconfig.json`、`packages/ui/vite.config.ts`、`packages/ui/vitest.config.ts`、`packages/ui/index.html`、`packages/ui/src/main.tsx`、`packages/ui/src/styles/tokens.css`、`packages/ui/src/styles/base.css`、`packages/ui/src/test/setup.ts`
- Test: `packages/ui/src/styles/tokens.test.ts`

**Interfaces:**
- Produces: CSS のカスタムプロパティ（下記）。以後の View はこれだけを使い、色やサイズを直書きしない。
- 設計の要点（`frontend-design` の手順で決めた）：
  - 主題は「格納庫（hangar）」で、並んだ機体を一覧する管制の画面である。面は紙のような白と淡い灰、罫線で区画を作り、影は使わない。
  - 色：`--bg #fbfbfa`、`--surface #ffffff`、`--line #e6e4df`、`--ink #1c1b19`、`--ink-2 #5f5c55`、`--accent #2f5fd0`（一箇所だけ、選択と主ボタン）。状態色は `--busy #c77a1a`、`--idle #3a8f5c`、`--waiting #a2452f`、`--ended #9a968e`。ダークは `--bg #17171a`、`--surface #1e1e22`、`--line #2c2c32`、`--ink #e8e6e1`、`--ink-2 #9a978f`、`--accent #7ea0ee`。
  - 書体：本文は `'Inter Variable', 'Hiragino Sans', sans-serif`、等幅は `'JetBrains Mono Variable', monospace`。サイズは 13px を基準に、11 / 12 / 13 / 15 / 20 の 5 段。
  - 密度：行高 28px、余白の単位 4px、角丸は 4px と 6px の二つだけ、メインの最大幅 1200px。
  - 動き：`--dur-fast 80ms`、`--dur 150ms`、`--dur-slow 250ms`、`--ease cubic-bezier(.2,.7,.2,1)`。`prefers-reduced-motion` で 0 にする。

- [ ] **Step 1: パッケージと設定を書く**

`packages/ui/package.json`：

```json
{
  "name": "@agent-hangar/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p .",
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@agent-hangar/shared": "*",
    "@fontsource-variable/inter": "^5.3.0",
    "@fontsource-variable/jetbrains-mono": "^5.3.0",
    "@tanstack/react-virtual": "^3.14.13",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "jsdom": "^30.1.0",
    "vite": "^8.3.0"
  }
}
```

`packages/ui/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["node", "vite/client", "@testing-library/jest-dom"] },
  "include": ["src"]
}
```

`packages/ui/vite.config.ts`：

```ts
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';

// 開発時はサーバのトークンを読んでプロキシが Authorization を付ける。本番はクッキーで渡る。
function devToken(): string {
  try { return fs.readFileSync(path.join(process.env.HANGAR_HOME ?? path.join(os.homedir(), '.agent-hangar'), 'token'), 'utf8').trim(); } catch { return ''; }
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4177', headers: { Authorization: `Bearer ${devToken()}` } },
      '/ws': { target: 'ws://127.0.0.1:4177', ws: true, headers: { Authorization: `Bearer ${devToken()}` } },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
```

`packages/ui/vitest.config.ts`：

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'ui',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
    environmentMatchGlobs: [['src/views/**', 'jsdom'], ['src/intent/**', 'jsdom'], ['src/Root.test.tsx', 'jsdom']],
  },
});
```

`packages/ui/src/test/setup.ts`：

```ts
import '@testing-library/jest-dom/vitest';
```

`packages/ui/index.html`：

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>agent-hangar</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/ui/src/main.tsx`（Root は Task 26 で差し替える。ここでは骨格だけ）：

```tsx
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';

createRoot(document.getElementById('root')!).render(<div className="app-boot">agent-hangar</div>);
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/ui/src/styles/tokens.test.ts`：

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('tokens.css', () => {
  it('必要なトークンをライトとダークの両方で定義する', () => {
    for (const t of ['--bg', '--surface', '--line', '--ink', '--ink-2', '--accent', '--busy', '--idle', '--waiting', '--ended', '--font-sans', '--font-mono', '--row-h', '--dur', '--ease']) {
      expect(css, t).toContain(`${t}:`);
    }
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect((css.match(/--accent:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('禁じた効果を使わない', () => {
    for (const bad of ['box-shadow: 0 0', 'text-shadow', '@keyframes pulse', '@keyframes shimmer', 'backdrop-filter']) expect(css).not.toContain(bad);
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npm install && npx vitest run packages/ui`
Expected: FAIL（`tokens.css` が無い）

- [ ] **Step 4: トークンと基本スタイルを書く**

`packages/ui/src/styles/tokens.css`：

```css
:root {
  --bg: #fbfbfa;
  --surface: #ffffff;
  --surface-2: #f3f2ee;
  --line: #e6e4df;
  --line-strong: #cfcbc3;
  --ink: #1c1b19;
  --ink-2: #5f5c55;
  --ink-3: #9a968e;
  --accent: #2f5fd0;
  --accent-ink: #ffffff;
  --accent-soft: #e8eefc;
  --busy: #c77a1a;
  --idle: #3a8f5c;
  --waiting: #a2452f;
  --ended: #9a968e;
  --error: #b3261e;
  --font-sans: 'Inter Variable', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', sans-serif;
  --font-mono: 'JetBrains Mono Variable', 'SFMono-Regular', Menlo, monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs: 13px;
  --fs-md: 15px;
  --fs-lg: 20px;
  --row-h: 28px;
  --u: 4px;
  --r: 4px;
  --r-lg: 6px;
  --main-w: 1200px;
  --sidebar-w: 180px;
  --header-h: 44px;
  --dur-fast: 80ms;
  --dur: 150ms;
  --dur-slow: 250ms;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: #17171a;
    --surface: #1e1e22;
    --surface-2: #26262b;
    --line: #2c2c32;
    --line-strong: #3d3d45;
    --ink: #e8e6e1;
    --ink-2: #9a978f;
    --ink-3: #6b6962;
    --accent: #7ea0ee;
    --accent-ink: #101318;
    --accent-soft: #232b3d;
    --busy: #e0a04a;
    --idle: #6cc08a;
    --waiting: #e0785e;
    --ended: #6b6962;
    --error: #ef7a72;
  }
}

:root[data-theme='dark'] {
  --bg: #17171a;
  --surface: #1e1e22;
  --surface-2: #26262b;
  --line: #2c2c32;
  --line-strong: #3d3d45;
  --ink: #e8e6e1;
  --ink-2: #9a978f;
  --ink-3: #6b6962;
  --accent: #7ea0ee;
  --accent-ink: #101318;
  --accent-soft: #232b3d;
  --busy: #e0a04a;
  --idle: #6cc08a;
  --waiting: #e0785e;
  --ended: #6b6962;
  --error: #ef7a72;
}

@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur: 0ms; --dur-slow: 0ms; }
}
```

`packages/ui/src/styles/base.css`：

```css
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--fs);
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
.muted { color: var(--ink-2); }
.faint { color: var(--ink-3); }
.app-boot { display: grid; place-items: center; height: 100%; color: var(--ink-2); }

/* レイアウト */
.shell { display: grid; grid-template-columns: var(--sidebar-w) 1fr; grid-template-rows: var(--header-h) 1fr; height: 100%; }
.sidebar { grid-row: 1 / span 2; border-right: 1px solid var(--line); background: var(--surface); padding: calc(var(--u) * 3) 0; }
.header { grid-column: 2; display: flex; align-items: center; gap: calc(var(--u) * 3); padding: 0 calc(var(--u) * 4); border-bottom: 1px solid var(--line); background: var(--surface); }
.main { grid-column: 2; overflow: auto; }
.main-inner { max-width: var(--main-w); margin: 0 auto; padding: calc(var(--u) * 4); }
.screen { animation: fade var(--dur-fast) var(--ease); }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }

/* ナビ */
.nav-item { display: flex; align-items: center; height: var(--row-h); padding: 0 calc(var(--u) * 4); color: var(--ink-2); border: 0; background: none; width: 100%; text-align: left; cursor: pointer; transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
.nav-item:hover { background: var(--surface-2); }
.nav-item[aria-current='page'] { color: var(--ink); background: var(--accent-soft); }

/* ボタンと入力 */
.btn { height: var(--row-h); padding: 0 calc(var(--u) * 3); border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); cursor: pointer; transition: background var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease); }
.btn:hover { background: var(--surface-2); }
.btn:active { transform: scale(0.98); }
.btn-primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.btn-primary:hover { background: var(--accent); filter: brightness(1.05); }
.btn:disabled { opacity: 0.5; cursor: default; }
.input { height: var(--row-h); padding: 0 calc(var(--u) * 2); border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); }
.input:focus { border-color: var(--accent); outline: none; }
.select { height: var(--row-h); border: 1px solid var(--line-strong); border-radius: var(--r); background: var(--surface); padding: 0 var(--u); }

/* 一覧 */
.list { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); overflow: hidden; }
.list-scroll { overflow: auto; }
.row { display: grid; align-items: center; height: var(--row-h); padding: 0 calc(var(--u) * 3); border-bottom: 1px solid var(--line); gap: calc(var(--u) * 3); cursor: pointer; transition: background var(--dur-fast) var(--ease); white-space: nowrap; }
.row:hover { background: var(--surface-2); }
.row[aria-selected='true'] { background: var(--accent-soft); }
.row-head { font-size: var(--fs-xs); color: var(--ink-3); cursor: default; }
.row-head:hover { background: transparent; }
.cell { overflow: hidden; text-overflow: ellipsis; }
.cell-right { text-align: right; }

/* カード */
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: calc(var(--u) * 3); }
.card { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); padding: calc(var(--u) * 3); display: flex; flex-direction: column; gap: var(--u); cursor: pointer; transition: border-color var(--dur-fast) var(--ease); min-width: 0; }
.card:hover { border-color: var(--line-strong); }
.card-title { font-weight: 600; font-size: var(--fs-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 状態点 */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ended); transition: background var(--dur) var(--ease); vertical-align: middle; }
.dot[data-status='busy'] { background: var(--busy); }
.dot[data-status='idle'] { background: var(--idle); }
.dot[data-status='waiting'] { background: var(--waiting); }

/* 見出しと区画 */
.h1 { font-size: var(--fs-lg); font-weight: 600; margin: 0 0 calc(var(--u) * 3); }
.h2 { font-size: var(--fs-md); font-weight: 600; margin: calc(var(--u) * 5) 0 calc(var(--u) * 2); }
.section-head { display: flex; align-items: baseline; gap: calc(var(--u) * 2); }
.empty { padding: calc(var(--u) * 8); text-align: center; color: var(--ink-2); }

/* 折りたたみ */
.fold { border-bottom: 1px solid var(--line); }
.fold-head { display: flex; align-items: center; gap: var(--u); height: var(--row-h); cursor: pointer; }
.fold-arrow { display: inline-block; transition: transform var(--dur) var(--ease); }
.fold[open] .fold-arrow { transform: rotate(90deg); }

/* トランスクリプト */
.tr { display: flex; flex-direction: column; gap: calc(var(--u) * 2); }
.msg { max-width: 80ch; padding: calc(var(--u) * 2) calc(var(--u) * 3); border-radius: var(--r-lg); white-space: pre-wrap; word-break: break-word; }
.msg-user { background: var(--accent-soft); align-self: flex-end; }
.msg-assistant { background: var(--surface); border: 1px solid var(--line); align-self: flex-start; }
.msg-thinking { color: var(--ink-3); font-style: italic; align-self: flex-start; }
.msg-system { color: var(--ink-3); font-size: var(--fs-xs); align-self: center; }
.tool { border-left: 2px solid var(--line-strong); padding-left: calc(var(--u) * 2); }
.tool-head { display: flex; gap: var(--u); align-items: center; height: var(--row-h); cursor: pointer; color: var(--ink-2); }
.tool-body { white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; background: var(--surface-2); padding: calc(var(--u) * 2); border-radius: var(--r); }
.tool-error { border-left-color: var(--error); }
.sub { margin-left: calc(var(--u) * 4); border-left: 1px dashed var(--line-strong); padding-left: calc(var(--u) * 3); }
.new-banner { position: sticky; bottom: var(--u); align-self: center; }

/* ヘッダーの要素 */
.crumbs { display: flex; gap: var(--u); color: var(--ink-2); white-space: nowrap; }
.crumbs b { color: var(--ink); font-weight: 500; }
.search-box { flex: 1; max-width: 420px; }
.spacer { flex: 1; }
.conn { font-size: var(--fs-xs); color: var(--ink-3); }
.conn[data-state='disconnected'] { color: var(--error); }

/* オーバーレイ */
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--ink) 30%, transparent); display: grid; place-items: center; z-index: 10; }
.dialog { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: calc(var(--u) * 5); width: 480px; max-width: calc(100vw - 32px); animation: pop 120ms var(--ease); display: flex; flex-direction: column; gap: calc(var(--u) * 3); }
@keyframes pop { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: none; } }
.toasts { position: fixed; right: calc(var(--u) * 4); bottom: calc(var(--u) * 4); display: flex; flex-direction: column; gap: var(--u); z-index: 20; }
.toast { background: var(--ink); color: var(--bg); padding: calc(var(--u) * 2) calc(var(--u) * 3); border-radius: var(--r-lg); animation: slide var(--dur-slow) var(--ease); cursor: pointer; }
.toast[data-level='error'] { background: var(--error); color: #fff; }
@keyframes slide { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
.progress { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); }
```

- [ ] **Step 5: テスト、型検査、ビルド**

Run: `npx vitest run packages/ui && npm run typecheck && npm run build --workspace packages/ui`
Expected: PASS、`packages/ui/dist/index.html` ができる

- [ ] **Step 6: コミット**

```bash
git add package-lock.json packages/ui
git commit -m "feat(ui): vite scaffold, design tokens and base styles"
```

---

### Task 18: Intent チェーンと正規化ストア

**Files:**
- Create: `packages/ui/src/intent/chain.tsx`、`packages/ui/src/store/store.ts`
- Test: `packages/ui/src/intent/chain.test.tsx`、`packages/ui/src/store/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // intent/chain.tsx
  export type Handled = { handled: boolean };
  export type IntentHandler = (intent: Intent) => Handled;
  export type Emit = (intent: Intent) => void;
  export const IntentContext: React.Context<Emit>;
  export function useEmit(): Emit;
  export function IntentBoundary(props: { handle: IntentHandler; children: ReactNode }): JSX.Element;
  export function IntentRoot(props: { onIntent: Emit; children: ReactNode }): JSX.Element;   // 木の頂点。Mediator へ渡す
  // store/store.ts
  export type Store = {
    bootstrapped: boolean; version: string; device: { id: string; name: string } | null; settings: SettingsDto | null;
    projects: Record<string, ProjectDto>; sessions: Record<string, SessionDto>; live: LiveSessionDto[];
    events: Record<string, { items: TranscriptEvent[]; total: number; nextSeq: number | null; loading: boolean }>;   // key は `${sessionId}:${agentId ?? ''}`
    subagents: Record<string, string[]>;
    search: { params: SearchParamsDto | null; result: SearchResultDto | null; loading: boolean };
    index: IndexProgressDto;
  };
  export function initialStore(): Store;
  export function applyBootstrap(store: Store, b: BootstrapDto): Store;
  export function applyServerEvent(store: Store, ev: ServerEvent): Store;    // 変わらなければ同じ参照を返す
  export function applyEventsPage(store: Store, key: string, page: EventsPageDto, append: boolean): Store;
  export function setEventsLoading(store: Store, key: string, loading: boolean): Store;
  export function applySearch(store: Store, params: SearchParamsDto, result: SearchResultDto | null, loading: boolean): Store;
  export function applySubagents(store: Store, sessionId: string, ids: string[]): Store;
  export function eventsKey(sessionId: string, agentId: string | null): string;
  ```
- `live.update` は `store.live` を置き換え、各 `SessionDto.live` を `providerSessionId` で引き直す。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/intent/chain.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Intent } from '@agent-hangar/shared';
import { IntentBoundary, IntentRoot, useEmit } from './chain.tsx';

function Button({ intent, label }: { intent: Intent; label: string }) {
  const emit = useEmit();
  return <button onClick={() => emit(intent)}>{label}</button>;
}

describe('Intent chain', () => {
  it('View の Intent は Root に届く', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Button intent={{ type: 'palette.open' }} label="open" /></IntentRoot>);
    fireEvent.click(screen.getByText('open'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
  });
  it('中間層が処理した Intent は上へ渡らず、処理しなかったものは渡る', () => {
    const onIntent = vi.fn();
    const handle = vi.fn((i: Intent) => ({ handled: i.type === 'split.toggle' }));
    render(
      <IntentRoot onIntent={onIntent}>
        <IntentBoundary handle={handle}>
          <Button intent={{ type: 'split.toggle' }} label="split" />
          <Button intent={{ type: 'palette.open' }} label="open" />
        </IntentBoundary>
      </IntentRoot>,
    );
    fireEvent.click(screen.getByText('split'));
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('open'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
    expect(handle).toHaveBeenCalledTimes(2);
  });
  it('Root の外では何も起きない', () => {
    render(<Button intent={{ type: 'palette.open' }} label="open" />);
    expect(() => fireEvent.click(screen.getByText('open'))).not.toThrow();
  });
});
```

`packages/ui/src/store/store.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { BootstrapDto, SessionDto } from '@agent-hangar/shared';
import { applyBootstrap, applyEventsPage, applyServerEvent, eventsKey, initialStore } from './store.ts';

const session = (id: string, psid: string): SessionDto => ({ id, provider: 'claude-code', providerSessionId: psid, projectId: null, name: id, cwd: '/x', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0 } });
const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c' }, projects: [], sessions: [session('s1', 'u1')], live: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0' };

describe('store', () => {
  it('bootstrap を正規化して入れる', () => {
    const s = applyBootstrap(initialStore(), boot);
    expect(s.bootstrapped).toBe(true);
    expect(s.sessions.s1?.name).toBe('s1');
    expect(s.device).toEqual({ id: 'd', name: 'mac' });
  });
  it('session.upsert は差し替え、live.update は各セッションの live を引き直す', () => {
    let s = applyBootstrap(initialStore(), boot);
    s = applyServerEvent(s, { type: 'session.upsert', session: { ...session('s1', 'u1'), name: 'renamed' } });
    expect(s.sessions.s1?.name).toBe('renamed');
    s = applyServerEvent(s, { type: 'live.update', live: [{ sessionId: 'u1', status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 1 }] });
    expect(s.sessions.s1?.live).toBe('busy');
    s = applyServerEvent(s, { type: 'live.update', live: [] });
    expect(s.sessions.s1?.live).toBeNull();
  });
  it('関係ないイベントは同じ参照を返す', () => {
    const s = applyBootstrap(initialStore(), boot);
    expect(applyServerEvent(s, { type: 'toast', level: 'info', message: 'x' })).toBe(s);
  });
  it('events のページを追記できる', () => {
    let s = initialStore();
    const k = eventsKey('s1', null);
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'user', seq: 0, text: 'a' }], total: 2, nextSeq: 1 }, false);
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'assistant', seq: 1, text: 'b' }], total: 2, nextSeq: null }, true);
    expect(s.events[k]?.items.map((e) => e.seq)).toEqual([0, 1]);
    expect(s.events[k]?.nextSeq).toBeNull();
    // 同じ seq が重なって届いても増えない
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'assistant', seq: 1, text: 'b' }], total: 2, nextSeq: null }, true);
    expect(s.events[k]?.items).toHaveLength(2);
  });
  it('transcript.appended は該当セッションの events を再読込対象にする', () => {
    let s = applyEventsPage(initialStore(), eventsKey('s1', null), { sessionId: 's1', events: [], total: 0, nextSeq: null }, false);
    s = applyServerEvent(s, { type: 'transcript.appended', sessionId: 's1', count: 1 });
    expect(s.events[eventsKey('s1', null)]?.total).toBe(1);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/intent/chain.tsx`：

```tsx
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { Intent } from '@agent-hangar/shared';

export type Handled = { handled: boolean };
export type IntentHandler = (intent: Intent) => Handled;
export type Emit = (intent: Intent) => void;

export const IntentContext = createContext<Emit>(() => {});

/** View が Intent を発行するための関数。木を上へ伝播し、途中で処理されなければ Root に届く。 */
export function useEmit(): Emit {
  return useContext(IntentContext);
}

/** 中間層が一部の Intent を横取りする境界。処理しなければ親へ渡す（Chain of Responsibility）。 */
export function IntentBoundary(props: { handle: IntentHandler; children: ReactNode }) {
  const parent = useContext(IntentContext);
  const { handle } = props;
  const dispatch = useCallback<Emit>((intent) => { if (!handle(intent).handled) parent(intent); }, [parent, handle]);
  return <IntentContext.Provider value={dispatch}>{props.children}</IntentContext.Provider>;
}

/** 木の頂点。届いた Intent をすべて Mediator へ渡す。 */
export function IntentRoot(props: { onIntent: Emit; children: ReactNode }) {
  return <IntentContext.Provider value={props.onIntent}>{props.children}</IntentContext.Provider>;
}
```

`packages/ui/src/store/store.ts`：

```ts
import type { BootstrapDto, EventsPageDto, IndexProgressDto, LiveSessionDto, ProjectDto, SearchParamsDto, SearchResultDto, ServerEvent, SessionDto, SettingsDto, TranscriptEvent } from '@agent-hangar/shared';

export type EventsSlice = { items: TranscriptEvent[]; total: number; nextSeq: number | null; loading: boolean };
export type Store = {
  bootstrapped: boolean; version: string; device: { id: string; name: string } | null; settings: SettingsDto | null;
  projects: Record<string, ProjectDto>; sessions: Record<string, SessionDto>; live: LiveSessionDto[];
  events: Record<string, EventsSlice>; subagents: Record<string, string[]>;
  search: { params: SearchParamsDto | null; result: SearchResultDto | null; loading: boolean };
  index: IndexProgressDto;
};

export const eventsKey = (sessionId: string, agentId: string | null): string => `${sessionId}:${agentId ?? ''}`;

export function initialStore(): Store {
  return { bootstrapped: false, version: '', device: null, settings: null, projects: {}, sessions: {}, live: [], events: {}, subagents: {}, search: { params: null, result: null, loading: false }, index: { phase: 'idle', done: 0, total: 0 } };
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]));

export function applyBootstrap(store: Store, b: BootstrapDto): Store {
  return { ...store, bootstrapped: true, version: b.version, device: b.device, settings: b.settings, projects: byId(b.projects), sessions: byId(b.sessions), live: b.live, index: b.index };
}

function relive(sessions: Record<string, SessionDto>, live: LiveSessionDto[]): Record<string, SessionDto> {
  const map = new Map(live.map((l) => [l.sessionId, l]));
  const out: Record<string, SessionDto> = {};
  for (const [id, s] of Object.entries(sessions)) {
    const l = map.get(s.providerSessionId);
    const status = l?.status ?? null;
    const name = l?.nameSource === 'user' && l.name ? l.name : s.name;
    out[id] = status === s.live && name === s.name ? s : { ...s, live: status, name };
  }
  return out;
}

export function applyServerEvent(store: Store, ev: ServerEvent): Store {
  switch (ev.type) {
    case 'ready': return { ...store, version: ev.version };
    case 'project.upsert': return { ...store, projects: { ...store.projects, [ev.project.id]: ev.project } };
    case 'session.upsert': return { ...store, sessions: { ...store.sessions, [ev.session.id]: ev.session } };
    case 'live.update': return { ...store, live: ev.live, sessions: relive(store.sessions, ev.live) };
    case 'index.progress': return { ...store, index: ev.progress };
    case 'transcript.appended': {
      const out = { ...store.events };
      let touched = false;
      for (const [k, v] of Object.entries(store.events)) if (k.startsWith(ev.sessionId + ':')) { out[k] = { ...v, total: v.total + ev.count }; touched = true; }
      return touched ? { ...store, events: out } : store;
    }
    default: return store;
  }
}

export function setEventsLoading(store: Store, key: string, loading: boolean): Store {
  const cur = store.events[key] ?? { items: [], total: 0, nextSeq: null, loading: false };
  return { ...store, events: { ...store.events, [key]: { ...cur, loading } } };
}

export function applyEventsPage(store: Store, key: string, page: EventsPageDto, append: boolean): Store {
  const cur = store.events[key];
  const base = append && cur ? cur.items : [];
  const seen = new Set(base.map((e) => e.seq));
  const items = [...base, ...page.events.filter((e) => !seen.has(e.seq))];
  return { ...store, events: { ...store.events, [key]: { items, total: page.total, nextSeq: page.nextSeq, loading: false } } };
}

export function applySearch(store: Store, params: SearchParamsDto, result: SearchResultDto | null, loading: boolean): Store {
  return { ...store, search: { params, result, loading } };
}

export function applySubagents(store: Store, sessionId: string, ids: string[]): Store {
  return { ...store, subagents: { ...store.subagents, [sessionId]: ids } };
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS（8 件）

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/intent packages/ui/src/store
git commit -m "feat(ui): explicit intent chain and normalized store"
```

---

### Task 19: Mediator の状態機械

**Files:**
- Create: `packages/ui/src/mediator/types.ts`、`packages/ui/src/mediator/screen.ts`、`packages/ui/src/mediator/overlay.ts`、`packages/ui/src/mediator/connection.ts`、`packages/ui/src/mediator/sessionView.ts`、`packages/ui/src/mediator/transition.ts`
- Test: `packages/ui/src/mediator/transition.test.ts`

**Interfaces:**
- Produces（「インターフェース一覧」の `Input`、`RuntimeEvent`、`Effect` に加えて）：
  ```ts
  export type Screen = { name: 'booting' } | Route;
  export type Overlay = { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' } | { kind: 'notYet'; feature: string };
  export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean };
  export type Toast = { id: string; level: 'info' | 'error'; message: string };
  export type State = {
    screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
    sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
    toasts: Toast[]; unresolvedQueue: string[]; nextToastId: number;
  };
  export function initialState(): State;
  export function defaultSessionView(): SessionViewState;
  export function transition(state: State, input: Input): { state: State; effects: Effect[] };
  ```
- 主要な遷移（設計文書の表のフェーズ 1 部分と、この計画で足したもの）：

| 現在 | 入力 | 次 | 効果 |
| --- | --- | --- | --- |
| `booting` | `runtime ws.open` | `connected`、`screen` は `hash.changed` 待ち | `api.bootstrap` |
| 任意 | `server ready` | 変化なし | なし（`ws.open` が起点） |
| 任意 | `runtime hash.changed(route)` | `screen = route` | `session` なら `api.loadEvents(id, 0)`、`sessions` で `q` があれば `api.search` |
| 任意 | `nav.go(to)` | 変化なし | `navigate(to)`（URL が変わると `hash.changed` が来る） |
| 任意 | `project.open(id)` / `session.open(id)` | 変化なし | `navigate` |
| 任意 | `search.query(text)` | `search.text = text` | `navigate(sessions, q)`。空なら `navigate(sessions)` |
| 任意 | `search.filter(patch)` | `search.filter` を更新 | `screen` が `sessions` で `text` があれば `api.search` |
| `connected` | `runtime ws.close` | `disconnected`、`reconnectAttempt + 1` | `ws.reconnectAfter(min(1000 × 2^n, 15000))` |
| `disconnected` | `runtime ws.open` | `connected`、`reconnectAttempt = 0` | `api.bootstrap`（取りこぼしを埋める） |
| `overlay: none` | `server project.unresolved(id)` | `overlay: resolveProject(id)` | なし |
| `overlay: resolveProject` | `server project.unresolved(id2)` | `unresolvedQueue` に積む | なし |
| `overlay: resolveProject(id)` | `project.resolve(id, action)` | 次のキューか `none` | `api.resolveProject` |
| 任意 | `overlay.close` | `none`（キューがあれば次） | なし |
| 任意 | `project.setStatus` | 変化なし | `api.setProjectStatus` |
| 任意 | `settings.update(patch)` | 変化なし | `api.updateSettings` |
| 任意 | `index.rebuild` | 変化なし | `api.rebuildIndex`、`toast` |
| 任意 | `transcript.showThinking / showRaw / follow` | `sessionView[id]` を更新 | `storage.save('sv:' + id)` |
| 任意 | `summary.toggle(id)` | `sessionView[id].summaryOpen` 反転 | `storage.save` |
| 任意 | `transcript.loadMore(id)` | 変化なし | `api.loadEvents(id, fromSeq)`（fromSeq は payload に含めず、ランタイムがストアの `nextSeq` を見る。ここでは `fromSeq: -1` を「次のページ」の印にする） |
| 任意 | `server transcript.appended(id)` | 変化なし | `screen` が `session(id)` なら `api.loadEvents(id, -1)` |
| 任意 | `server toast` / `runtime api.failed` | `toasts` に追加 | なし |
| 任意 | `toast.dismiss(id)` | `toasts` から除く | なし |
| 任意 | `palette.open` | `overlay: palette` | なし（パレットの中身はフェーズ 3） |
| 任意 | フェーズ 2 以降の Intent（`session.new.*`、`session.resume`、`session.fork`、`session.kill`、`session.openTerminalApp`、`session.openEditor`、`session.promote.*`、`session.takeover`、`tab.*`、`split.toggle`、`transcript.toggle`、`todo.*`、`memo.save`、`artifact.*`、`summary.regenerate`、`sync.*`、`project.new.*`、`session.setMemo`、`palette.run`） | 変化なし | `toast('この操作は次のフェーズで実装します')` |

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/mediator/transition.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { Input } from './types.ts';
import { initialState, transition, type State } from './transition.ts';

function run(inputs: Input[], start: State = initialState()) {
  const effects: unknown[] = [];
  let state = start;
  for (const i of inputs) { const r = transition(state, i); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}
const intent = (i: Input extends { kind: 'intent'; intent: infer I } ? I : never): Input => ({ kind: 'intent', intent: i });
const server = (e: Input extends { kind: 'server'; event: infer E } ? E : never): Input => ({ kind: 'server', event: e });
const runtime = (e: Input extends { kind: 'runtime'; event: infer E } ? E : never): Input => ({ kind: 'runtime', event: e });

describe('起動と接続', () => {
  it('ws が開いたら bootstrap を取り、hash で画面が決まる', () => {
    const { state, effects } = run([runtime({ type: 'ws.open' }), runtime({ type: 'hash.changed', route: { name: 'projects' } })]);
    expect(state.connection).toBe('connected');
    expect(state.screen).toEqual({ name: 'projects' });
    expect(effects).toEqual([{ kind: 'api.bootstrap' }]);
  });
  it('切断で指数バックオフ、再接続で bootstrap を取り直す', () => {
    const a = run([runtime({ type: 'ws.open' }), runtime({ type: 'ws.close' })]);
    expect(a.state.connection).toBe('disconnected');
    expect(a.effects.at(-1)).toEqual({ kind: 'ws.reconnectAfter', ms: 2000 });
    const b = run([runtime({ type: 'ws.close' })], a.state);
    expect(b.effects.at(-1)).toEqual({ kind: 'ws.reconnectAfter', ms: 4000 });
    const c = run([runtime({ type: 'ws.open' })], b.state);
    expect(c.state).toMatchObject({ connection: 'connected', reconnectAttempt: 0 });
    expect(c.effects).toEqual([{ kind: 'api.bootstrap' }]);
  });
  it('バックオフは 15 秒で頭打ち', () => {
    let s = initialState();
    for (let i = 0; i < 8; i++) s = transition(s, runtime({ type: 'ws.close' })).state;
    expect(transition(s, runtime({ type: 'ws.close' })).effects).toEqual([{ kind: 'ws.reconnectAfter', ms: 15000 }]);
  });
});

describe('ナビゲーション', () => {
  it('nav.go と project.open と session.open は navigate 効果だけを出す', () => {
    const { state, effects } = run([intent({ type: 'nav.go', to: { name: 'settings' } }), intent({ type: 'project.open', id: 'p1' }), intent({ type: 'session.open', id: 's1' })]);
    expect(state.screen).toEqual({ name: 'booting' });
    expect(effects).toEqual([{ kind: 'navigate', route: { name: 'settings' } }, { kind: 'navigate', route: { name: 'project', id: 'p1' } }, { kind: 'navigate', route: { name: 'session', id: 's1' } }]);
  });
  it('session 画面に入ると本文の先頭ページを読む', () => {
    const { effects } = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]);
    expect(effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0 }]);
  });
  it('検索語は URL に乗り、sessions 画面で検索効果になる', () => {
    const a = run([intent({ type: 'search.query', text: '動画' })]);
    expect(a.state.search.text).toBe('動画');
    expect(a.effects).toEqual([{ kind: 'navigate', route: { name: 'sessions', q: '動画' } }]);
    const b = run([runtime({ type: 'hash.changed', route: { name: 'sessions', q: '動画' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.search', params: { q: '動画' } }]);
    const c = run([intent({ type: 'search.filter', patch: { projectId: 'p1' } })], b.state);
    expect(c.state.search.filter).toEqual({ projectId: 'p1' });
    expect(c.effects).toEqual([{ kind: 'api.search', params: { q: '動画', projectId: 'p1' } }]);
    expect(run([intent({ type: 'search.query', text: '' })]).effects).toEqual([{ kind: 'navigate', route: { name: 'sessions' } }]);
  });
});

describe('オーバーレイ', () => {
  it('未解決プロジェクトはダイアログになり、複数はキューに積む', () => {
    const a = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p2' })]);
    expect(a.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(a.state.unresolvedQueue).toEqual(['p2']);
    const b = run([intent({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } })], a.state);
    expect(b.effects).toEqual([{ kind: 'api.resolveProject', projectId: 'p1', action: { kind: 'archive' } }]);
    expect(b.state.overlay).toEqual({ kind: 'resolveProject', projectId: 'p2' });
    const c = run([intent({ type: 'overlay.close' })], b.state);
    expect(c.state.overlay).toEqual({ kind: 'none' });
  });
  it('同じプロジェクトの重複通知は積まない', () => {
    const { state } = run([server({ type: 'project.unresolved', projectId: 'p1' }), server({ type: 'project.unresolved', projectId: 'p1' })]);
    expect(state.unresolvedQueue).toEqual([]);
  });
});

describe('セッション表示の一時状態', () => {
  it('思考と生 JSON と追従の切り替えを保存する', () => {
    const { state, effects } = run([intent({ type: 'transcript.showThinking', sessionId: 's1', show: true }), intent({ type: 'summary.toggle', sessionId: 's1' })]);
    expect(state.sessionView.s1).toMatchObject({ showThinking: true, summaryOpen: true, showRaw: false, follow: true });
    expect(effects[0]).toMatchObject({ kind: 'storage.save', key: 'sv:s1' });
  });
  it('本文の追記は開いているセッションだけ読み直す', () => {
    const open = run([runtime({ type: 'hash.changed', route: { name: 'session', id: 's1' } })]).state;
    expect(run([server({ type: 'transcript.appended', sessionId: 's1', count: 2 })], open).effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: -1 }]);
    expect(run([server({ type: 'transcript.appended', sessionId: 's2', count: 2 })], open).effects).toEqual([]);
  });
  it('loadMore は次のページを要求する', () => {
    expect(run([intent({ type: 'transcript.loadMore', sessionId: 's1' })]).effects).toEqual([{ kind: 'api.loadEvents', sessionId: 's1', fromSeq: -1 }]);
  });
});

describe('その他', () => {
  it('トーストは追加と消去ができ、失敗は error になる', () => {
    const a = run([server({ type: 'toast', level: 'info', message: 'a' }), runtime({ type: 'api.failed', message: 'b' })]);
    expect(a.state.toasts.map((t) => [t.level, t.message])).toEqual([['info', 'a'], ['error', 'b']]);
    const b = run([intent({ type: 'toast.dismiss', id: a.state.toasts[0]!.id })], a.state);
    expect(b.state.toasts).toHaveLength(1);
  });
  it('設定と状態変更と索引の作り直しは API 効果', () => {
    const { effects } = run([intent({ type: 'project.setStatus', id: 'p1', status: 'paused' }), intent({ type: 'settings.update', patch: { workspaceRoot: '/w' } }), intent({ type: 'index.rebuild' })]);
    expect(effects[0]).toEqual({ kind: 'api.setProjectStatus', projectId: 'p1', status: 'paused' });
    expect(effects[1]).toEqual({ kind: 'api.updateSettings', patch: { workspaceRoot: '/w' } });
    expect(effects[2]).toEqual({ kind: 'api.rebuildIndex' });
  });
  it('次のフェーズの操作はトーストで知らせる', () => {
    const { state, effects } = run([intent({ type: 'session.resume', id: 's1' }), intent({ type: 'tab.open', sessionId: 's1', kind: 'shell' })]);
    expect(effects).toEqual([{ kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }, { kind: 'toast', level: 'info', message: 'この操作は次のフェーズで実装します' }]);
    expect(state).toEqual(initialState());
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/mediator`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/mediator/types.ts`：

```ts
import type { Intent, ProjectStatus, ResolveAction, Route, SearchFilter, SearchParamsDto, ServerEvent, SettingsDto } from '@agent-hangar/shared';

export type RuntimeEvent =
  | { type: 'ws.open' } | { type: 'ws.close' } | { type: 'hash.changed'; route: Route }
  | { type: 'api.failed'; message: string } | { type: 'search.done'; params: SearchParamsDto };

export type Input =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent };

export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'api.bootstrap' }
  | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number }     // -1 は「次のページ」
  | { kind: 'api.search'; params: SearchParamsDto }
  | { kind: 'api.setProjectStatus'; projectId: string; status: ProjectStatus }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto> }
  | { kind: 'api.rebuildIndex' }
  | { kind: 'ws.connect' } | { kind: 'ws.reconnectAfter'; ms: number }
  | { kind: 'focus'; target: 'search' }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  | { kind: 'storage.save'; key: string; value: unknown };

export type Screen = { name: 'booting' } | Route;
export type Overlay = { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' } | { kind: 'notYet'; feature: string };
export type SessionViewState = { agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; summaryOpen: boolean };
export type Toast = { id: string; level: 'info' | 'error'; message: string };
export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  sessionView: Record<string, SessionViewState>; search: { text: string; filter: SearchFilter };
  toasts: Toast[]; unresolvedQueue: string[]; nextToastId: number;
};
export type Step = { state: State; effects: Effect[] };
export const NOT_YET = 'この操作は次のフェーズで実装します';
```

`packages/ui/src/mediator/screen.ts`：

```ts
import type { SearchParamsDto } from '@agent-hangar/shared';
import type { Effect, Input, State, Step } from './types.ts';

export function searchParams(state: State): SearchParamsDto {
  const f = state.search.filter;
  const p: SearchParamsDto = { q: state.search.text };
  if (f.projectId) p.projectId = f.projectId;
  if (f.since !== undefined) p.since = f.since;
  if (f.until !== undefined) p.until = f.until;
  if (f.running !== undefined) p.running = f.running;
  if (f.file) p.file = f.file;
  return p;
}

/** screen 領域：どの画面にいるか。URL のハッシュが正で、Intent は navigate 効果を出すだけ。 */
export function screenStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'hash.changed') {
    const route = input.event.route;
    const effects: Effect[] = [];
    let next: State = { ...state, screen: route };
    if (route.name === 'session') effects.push({ kind: 'api.loadEvents', sessionId: route.id, fromSeq: 0 });
    if (route.name === 'sessions') {
      const text = route.q ?? '';
      next = { ...next, search: { ...state.search, text } };
      if (text) effects.push({ kind: 'api.search', params: searchParams(next) });
    }
    return { state: next, effects };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'nav.go': return { state, effects: [{ kind: 'navigate', route: i.to }] };
    case 'project.open': return { state, effects: [{ kind: 'navigate', route: { name: 'project', id: i.id } }] };
    case 'session.open': return { state, effects: [{ kind: 'navigate', route: { name: 'session', id: i.id } }] };
    case 'search.query': {
      const next = { ...state, search: { ...state.search, text: i.text } };
      return { state: next, effects: [{ kind: 'navigate', route: i.text ? { name: 'sessions', q: i.text } : { name: 'sessions' } }] };
    }
    case 'search.filter': {
      const next = { ...state, search: { ...state.search, filter: { ...state.search.filter, ...i.patch } } };
      const effects: Effect[] = state.screen.name === 'sessions' && next.search.text ? [{ kind: 'api.search', params: searchParams(next) }] : [];
      return { state: next, effects };
    }
    default: return null;
  }
}
```

`packages/ui/src/mediator/overlay.ts`：

```ts
import type { Input, State, Step } from './types.ts';

function popQueue(state: State): State {
  const [next, ...rest] = state.unresolvedQueue;
  return next ? { ...state, overlay: { kind: 'resolveProject', projectId: next }, unresolvedQueue: rest } : { ...state, overlay: { kind: 'none' }, unresolvedQueue: [] };
}

/** overlay 領域：ダイアログとパレット。未解決プロジェクトは一つずつ出す。 */
export function overlayStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'project.unresolved') {
    const id = input.event.projectId;
    if (state.overlay.kind === 'resolveProject' && state.overlay.projectId === id) return { state, effects: [] };
    if (state.unresolvedQueue.includes(id)) return { state, effects: [] };
    if (state.overlay.kind === 'none') return { state: { ...state, overlay: { kind: 'resolveProject', projectId: id } }, effects: [] };
    return { state: { ...state, unresolvedQueue: [...state.unresolvedQueue, id] }, effects: [] };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'project.resolve': return { state: popQueue(state), effects: [{ kind: 'api.resolveProject', projectId: i.id, action: i.action }] };
    case 'overlay.close': return { state: popQueue(state), effects: [] };
    case 'palette.open': return { state: { ...state, overlay: { kind: 'palette' } }, effects: [] };
    case 'palette.close': return { state: { ...state, overlay: { kind: 'none' } }, effects: [] };
    default: return null;
  }
}
```

`packages/ui/src/mediator/connection.ts`：

```ts
import type { Input, State, Step } from './types.ts';

/** connection 領域：WebSocket の状態と再接続。開いたら必ず bootstrap を取り直す。 */
export function connectionStep(state: State, input: Input): Step | null {
  if (input.kind !== 'runtime') return null;
  switch (input.event.type) {
    case 'ws.open': return { state: { ...state, connection: 'connected', reconnectAttempt: 0 }, effects: [{ kind: 'api.bootstrap' }] };
    case 'ws.close': {
      const attempt = state.reconnectAttempt + 1;
      return { state: { ...state, connection: 'disconnected', reconnectAttempt: attempt }, effects: [{ kind: 'ws.reconnectAfter', ms: Math.min(1000 * 2 ** attempt, 15000) }] };
    }
    default: return null;
  }
}
```

`packages/ui/src/mediator/sessionView.ts`：

```ts
import type { Effect, Input, SessionViewState, State, Step } from './types.ts';

export function defaultSessionView(): SessionViewState {
  return { agentId: null, showThinking: false, showRaw: false, follow: true, summaryOpen: false };
}

function patch(state: State, id: string, p: Partial<SessionViewState>): Step {
  const cur = state.sessionView[id] ?? defaultSessionView();
  const next = { ...cur, ...p };
  const effects: Effect[] = [{ kind: 'storage.save', key: `sv:${id}`, value: next }];
  return { state: { ...state, sessionView: { ...state.sessionView, [id]: next } }, effects };
}

/** sessionView 領域：セッション画面の一時状態。localStorage に保存し、同期しない。 */
export function sessionViewStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'transcript.appended') {
    const open = state.screen.name === 'session' && state.screen.id === input.event.sessionId;
    return { state, effects: open ? [{ kind: 'api.loadEvents', sessionId: input.event.sessionId, fromSeq: -1 }] : [] };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'transcript.showThinking': return patch(state, i.sessionId, { showThinking: i.show });
    case 'transcript.showRaw': return patch(state, i.sessionId, { showRaw: i.show });
    case 'transcript.follow': return patch(state, i.sessionId, { follow: i.follow });
    case 'summary.toggle': return patch(state, i.sessionId, { summaryOpen: !(state.sessionView[i.sessionId] ?? defaultSessionView()).summaryOpen });
    case 'transcript.loadMore': return { state, effects: [{ kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: -1 }] };
    default: return null;
  }
}
```

`packages/ui/src/mediator/transition.ts`：

```ts
import { connectionStep } from './connection.ts';
import { overlayStep } from './overlay.ts';
import { screenStep } from './screen.ts';
import { sessionViewStep } from './sessionView.ts';
import { NOT_YET, type Effect, type Input, type State, type Step } from './types.ts';

export type { State, Input, Effect, Step } from './types.ts';
export { defaultSessionView } from './sessionView.ts';

export function initialState(): State {
  return { screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0, sessionView: {}, search: { text: '', filter: {} }, toasts: [], unresolvedQueue: [], nextToastId: 1 };
}

function pushToast(state: State, level: 'info' | 'error', message: string): State {
  return { ...state, toasts: [...state.toasts, { id: String(state.nextToastId), level, message }], nextToastId: state.nextToastId + 1 };
}

const NOT_YET_INTENTS = new Set(['session.new.open', 'session.new.submit', 'session.resume', 'session.fork', 'session.kill', 'session.openTerminalApp', 'session.openEditor', 'session.promote.open', 'session.promote.submit', 'session.takeover', 'session.setMemo', 'tab.open', 'tab.close', 'tab.select', 'split.toggle', 'transcript.toggle', 'todo.add', 'todo.toggle', 'todo.remove', 'memo.save', 'artifact.open', 'artifact.add', 'summary.regenerate', 'sync.now', 'sync.pause', 'project.new.open', 'project.new.submit', 'palette.run']);

/** 直交する領域の状態機械を順に試し、最初に応答した領域の結果を採る。残りは横断的な入力。 */
export function transition(state: State, input: Input): Step {
  for (const step of [connectionStep, screenStep, overlayStep, sessionViewStep]) {
    const r = step(state, input);
    if (r) return r;
  }
  if (input.kind === 'server') {
    if (input.event.type === 'toast') return { state: pushToast(state, input.event.level, input.event.message), effects: [] };
    return { state, effects: [] };
  }
  if (input.kind === 'runtime') {
    if (input.event.type === 'api.failed') return { state: pushToast(state, 'error', input.event.message), effects: [] };
    return { state, effects: [] };
  }
  const i = input.intent;
  switch (i.type) {
    case 'project.setStatus': return { state, effects: [{ kind: 'api.setProjectStatus', projectId: i.id, status: i.status }] };
    case 'settings.update': return { state, effects: [{ kind: 'api.updateSettings', patch: i.patch }] };
    case 'index.rebuild': return { state, effects: [{ kind: 'api.rebuildIndex' }] };
    case 'toast.dismiss': return { state: { ...state, toasts: state.toasts.filter((t) => t.id !== i.id) }, effects: [] };
    default:
      if (NOT_YET_INTENTS.has(i.type)) return { state, effects: [{ kind: 'toast', level: 'info', message: NOT_YET }] };
      return { state, effects: [] };
  }
}
```

`toast` 効果はランタイムが `server toast` と同じ経路で `pushToast` に戻す（Task 20）。テストの最後の項目で `state` が変わらないのはそのためである。

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/mediator && npm run typecheck`
Expected: PASS（14 件）

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/mediator
git commit -m "feat(ui): mediator state machine with screen, overlay, connection and session view regions"
```

---

### Task 20: ランタイム（API クライアント、WebSocket、効果の実行）

**Files:**
- Create: `packages/ui/src/runtime/api.ts`、`packages/ui/src/runtime/ws.ts`、`packages/ui/src/runtime/runtime.ts`
- Test: `packages/ui/src/runtime/runtime.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // runtime/api.ts
  export type ApiClient = {
    bootstrap(): Promise<BootstrapDto>;
    events(sessionId: string, fromSeq: number, agentId: string | null): Promise<EventsPageDto>;
    subagents(sessionId: string): Promise<string[]>;
    search(params: SearchParamsDto): Promise<SearchResultDto>;
    setProjectStatus(id: string, status: ProjectStatus): Promise<ProjectDto>;
    resolveProject(id: string, action: ResolveAction): Promise<unknown>;
    candidates(id: string, name: string): Promise<string[]>;
    updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto>;
    rebuildIndex(): Promise<void>;
  };
  export function createApi(fetchFn?: typeof fetch): ApiClient;    // 相対 URL `/api/...`、失敗は Error(`${status} ${path}`)
  // runtime/ws.ts
  export type WsClient = { connect(): void; close(): void };
  export function createWs(opts: { url: string; onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void; factory?: (url: string) => WebSocket }): WsClient;
  // runtime/runtime.ts
  export type Runtime = {
    dispatch(input: Input): void;
    emit(intent: Intent): void;
    getState(): State; getStore(): Store;
    subscribe(cb: () => void): () => void;
    start(): void; stop(): void;
  };
  export type RuntimeDeps = { api: ApiClient; ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient; location: { getHash(): string; setHash(h: string): void; onHashChange(cb: () => void): () => void }; storage: { get(key: string): unknown; set(key: string, value: unknown): void }; setTimeout: (fn: () => void, ms: number) => unknown; focus?: (target: 'search') => void };
  export function createRuntime(deps: RuntimeDeps): Runtime;
  ```
- 効果の実行：
  - `api.bootstrap` → `applyBootstrap`。その後 `hash.changed` を現在のハッシュで一度流す（画面を決めるため）。
  - `api.loadEvents(id, fromSeq)`：`fromSeq = 0` は先頭から置き換え、`-1` はストアの `nextSeq` から追記（`nextSeq` が null で `total` が items より多ければ `items.length` から）。`agentId` はストアではなく `state.sessionView[id].agentId`。読み込み前に `setEventsLoading`。同じ key の読み込み中は重ねない。
  - `api.search` → `applySearch(loading)` → 結果を `applySearch`。古い応答は捨てる（連番で判定）。
  - `api.setProjectStatus` / `api.resolveProject` / `api.updateSettings` / `api.rebuildIndex`：呼んで、失敗なら `runtime api.failed`。`updateSettings` の成功は `store.settings` に反映。
  - `navigate` → `location.setHash(formatRoute(route))`。同じハッシュなら `hash.changed` を直接流す。
  - `ws.reconnectAfter(ms)` → `setTimeout` 後に `ws.connect()`。
  - `toast` → `dispatch({ kind: 'server', event: { type: 'toast', ... } })`。
  - `storage.save` → `storage.set`。起動時に `sv:` で始まる保存値を `state.sessionView` に読み戻す（`start()` で `storage.get` を使うため、`storage` に `keys(): string[]` も持たせる）。
- `RuntimeDeps.storage` は `{ get, set, keys }` の三つを持つ。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/runtime/runtime.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, EventsPageDto, ServerEvent } from '@agent-hangar/shared';
import type { ApiClient } from './api.ts';
import { createRuntime, type RuntimeDeps } from './runtime.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c' }, projects: [], sessions: [], live: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1' };
const page = (from: number, next: number | null): EventsPageDto => ({ sessionId: 's1', events: [{ kind: 'user', seq: from, text: 'x' }], total: 3, nextSeq: next });

function harness(overrides: Partial<ApiClient> = {}) {
  const api: ApiClient = {
    bootstrap: vi.fn(async () => boot),
    events: vi.fn(async (_s, from) => page(from, from === 0 ? 1 : null)),
    subagents: vi.fn(async () => []),
    search: vi.fn(async () => ({ hits: [], total: 0 })),
    setProjectStatus: vi.fn(async () => { throw new Error('500 /api/projects/p1'); }),
    resolveProject: vi.fn(async () => ({})),
    candidates: vi.fn(async () => []),
    updateSettings: vi.fn(async (p) => ({ workspaceRoot: '/w', claudeDir: '/c', ...p })),
    rebuildIndex: vi.fn(async () => {}),
    ...overrides,
  };
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const wsHandlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const store = new Map<string, unknown>();
  const deps: RuntimeDeps = {
    api,
    ws: (h) => { wsHandlers.push(h); return { connect: vi.fn(), close: vi.fn() }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); } },
    storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), keys: () => [...store.keys()] },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
  const rt = createRuntime(deps);
  return { rt, api, wsHandlers, timers, store, setHash: deps.location.setHash };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createRuntime', () => {
  it('ws が開くと bootstrap を取り、現在のハッシュで画面を決める', async () => {
    const { rt, api, wsHandlers, setHash } = harness();
    rt.start();
    setHash('#/projects');
    wsHandlers[0]!.onOpen();
    await flush();
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(rt.getStore().bootstrapped).toBe(true);
    expect(rt.getState().screen).toEqual({ name: 'projects' });
  });
  it('session 画面で先頭ページを読み、loadMore で次のページを追記する', async () => {
    const { rt, api, setHash } = harness();
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.events).toHaveBeenCalledWith('s1', 0, null);
    expect(rt.getStore().events['s1:']?.items).toHaveLength(1);
    rt.emit({ type: 'transcript.loadMore', sessionId: 's1' });
    await flush();
    expect(api.events).toHaveBeenLastCalledWith('s1', 1, null);
    expect(rt.getStore().events['s1:']?.items.map((e) => e.seq)).toEqual([0, 1]);
  });
  it('API の失敗はトーストになる', async () => {
    const { rt } = harness();
    rt.start();
    rt.emit({ type: 'project.setStatus', id: 'p1', status: 'paused' });
    await flush();
    expect(rt.getState().toasts[0]).toMatchObject({ level: 'error', message: '500 /api/projects/p1' });
  });
  it('切断後は指定の時間で再接続する', () => {
    const { rt, wsHandlers, timers } = harness();
    rt.start();
    wsHandlers[0]!.onClose();
    expect(timers[0]?.ms).toBe(2000);
  });
  it('セッション表示の一時状態を保存し、起動時に読み戻す', () => {
    const a = harness();
    a.rt.start();
    a.rt.emit({ type: 'transcript.showThinking', sessionId: 's1', show: true });
    expect(a.store.get('sv:s1')).toMatchObject({ showThinking: true });
    const b = harness();
    b.store.set('sv:s1', { showThinking: true, showRaw: true });
    b.rt.start();
    expect(b.rt.getState().sessionView.s1).toMatchObject({ showThinking: true, showRaw: true, follow: true });
  });
  it('subscribe は状態かストアが変わるたびに呼ばれる', () => {
    const { rt } = harness();
    const cb = vi.fn();
    rt.subscribe(cb);
    rt.dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message: 'x' } });
    expect(cb).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/runtime`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/runtime/api.ts`：

```ts
import type { BootstrapDto, EventsPageDto, ProjectDto, ProjectStatus, ResolveAction, SearchParamsDto, SearchResultDto, SettingsDto } from '@agent-hangar/shared';

export type ApiClient = {
  bootstrap(): Promise<BootstrapDto>;
  events(sessionId: string, fromSeq: number, agentId: string | null): Promise<EventsPageDto>;
  subagents(sessionId: string): Promise<string[]>;
  search(params: SearchParamsDto): Promise<SearchResultDto>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<ProjectDto>;
  resolveProject(id: string, action: ResolveAction): Promise<unknown>;
  candidates(id: string, name: string): Promise<string[]>;
  updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto>;
  rebuildIndex(): Promise<void>;
};

export function createApi(fetchFn: typeof fetch = (...a) => fetch(...a)): ApiClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetchFn(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    if (r.status === 202 || r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }
  const qs = (o: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
  return {
    bootstrap: () => call('/api/bootstrap'),
    events: (sessionId, fromSeq, agentId) => call(`/api/sessions/${sessionId}/events${qs({ fromSeq, agentId })}`),
    subagents: (sessionId) => call(`/api/sessions/${sessionId}/subagents`),
    search: (params) => call(`/api/search${qs(params)}`),
    setProjectStatus: (id, status) => call(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    resolveProject: (id, action) => call(`/api/projects/${id}/resolve`, { method: 'POST', body: JSON.stringify(action) }),
    candidates: (id, name) => call(`/api/projects/${id}/candidates${qs({ name })}`),
    updateSettings: (patch) => call('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    rebuildIndex: () => call('/api/index/rebuild', { method: 'POST' }),
  };
}
```

`packages/ui/src/runtime/ws.ts`：

```ts
import type { ServerEvent } from '@agent-hangar/shared';

export type WsClient = { connect(): void; close(): void };

export function createWs(opts: { url: string; onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void; factory?: (url: string) => WebSocket }): WsClient {
  let ws: WebSocket | null = null;
  let closed = false;
  return {
    connect() {
      if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) return;
      closed = false;
      ws = (opts.factory ?? ((u) => new WebSocket(u)))(opts.url);
      ws.onopen = () => opts.onOpen();
      ws.onmessage = (m) => { try { opts.onEvent(JSON.parse(String(m.data)) as ServerEvent); } catch { /* 壊れたメッセージは無視 */ } };
      ws.onclose = () => { ws = null; if (!closed) opts.onClose(); };
      ws.onerror = () => { /* onclose が続く */ };
    },
    close() { closed = true; ws?.close(); ws = null; },
  };
}
```

`packages/ui/src/runtime/runtime.ts`：

```ts
import { formatRoute, parseRoute, type Intent, type ServerEvent } from '@agent-hangar/shared';
import { initialState, transition, type Effect, type Input, type State } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { SessionViewState } from '../mediator/types.ts';
import { applyBootstrap, applyEventsPage, applySearch, applyServerEvent, eventsKey, initialStore, setEventsLoading, type Store } from '../store/store.ts';
import type { ApiClient } from './api.ts';
import type { WsClient } from './ws.ts';

export type RuntimeDeps = {
  api: ApiClient;
  ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient;
  location: { getHash(): string; setHash(h: string): void; onHashChange(cb: () => void): () => void };
  storage: { get(key: string): unknown; set(key: string, value: unknown): void; keys(): string[] };
  setTimeout: (fn: () => void, ms: number) => unknown;
  focus?: (target: 'search') => void;
};

export type Runtime = {
  dispatch(input: Input): void; emit(intent: Intent): void;
  getState(): State; getStore(): Store;
  subscribe(cb: () => void): () => void;
  start(): void; stop(): void;
};

/** Mediator の効果を実行し、サーバとブラウザの出来事を入力に変える。 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  let state = initialState();
  let store = initialStore();
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };
  const setStore = (next: Store) => { if (next !== store) { store = next; notify(); } };
  let ws: WsClient | null = null;
  let searchSeq = 0;
  let unsubHash: (() => void) | null = null;

  const fail = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: e instanceof Error ? e.message : String(e) } });

  function runEffect(e: Effect): void {
    switch (e.kind) {
      case 'navigate': {
        const h = formatRoute(e.route);
        if (deps.location.getHash() === h) dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: e.route } });
        else deps.location.setHash(h);
        return;
      }
      case 'api.bootstrap':
        deps.api.bootstrap().then((b) => { setStore(applyBootstrap(store, b)); dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } }); }).catch(fail);
        return;
      case 'api.loadEvents': {
        const view = state.sessionView[e.sessionId] ?? defaultSessionView();
        const key = eventsKey(e.sessionId, view.agentId);
        const cur = store.events[key];
        if (cur?.loading) return;
        let from = e.fromSeq;
        let append = true;
        if (from === 0) append = false;
        else if (from === -1) { from = cur?.nextSeq ?? (cur && cur.total > cur.items.length ? cur.items.length : -1); if (from < 0) return; }
        setStore(setEventsLoading(store, key, true));
        deps.api.events(e.sessionId, from, view.agentId).then((p) => setStore(applyEventsPage(store, key, p, append))).catch((err) => { setStore(setEventsLoading(store, key, false)); fail(err); });
        return;
      }
      case 'api.search': {
        const seq = ++searchSeq;
        setStore(applySearch(store, e.params, store.search.result, true));
        deps.api.search(e.params).then((r) => { if (seq === searchSeq) setStore(applySearch(store, e.params, r, false)); }).catch(fail);
        return;
      }
      case 'api.setProjectStatus': deps.api.setProjectStatus(e.projectId, e.status).catch(fail); return;
      case 'api.resolveProject': deps.api.resolveProject(e.projectId, e.action).catch(fail); return;
      case 'api.updateSettings': deps.api.updateSettings(e.patch).then((s) => setStore({ ...store, settings: s })).catch(fail); return;
      case 'api.rebuildIndex': deps.api.rebuildIndex().catch(fail); return;
      case 'ws.connect': ws?.connect(); return;
      case 'ws.reconnectAfter': deps.setTimeout(() => ws?.connect(), e.ms); return;
      case 'focus': deps.focus?.(e.target); return;
      case 'toast': dispatch({ kind: 'server', event: { type: 'toast', level: e.level, message: e.message } }); return;
      case 'storage.save': deps.storage.set(e.key, e.value); return;
    }
  }

  function dispatch(input: Input): void {
    if (input.kind === 'server') setStore(applyServerEvent(store, input.event));
    const r = transition(state, input);
    if (r.state !== state) { state = r.state; notify(); }
    for (const eff of r.effects) runEffect(eff);
  }

  return {
    dispatch,
    emit: (intent) => dispatch({ kind: 'intent', intent }),
    getState: () => state,
    getStore: () => store,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    start() {
      const sv: Record<string, SessionViewState> = {};
      for (const k of deps.storage.keys()) if (k.startsWith('sv:')) { const v = deps.storage.get(k); if (v && typeof v === 'object') sv[k.slice(3)] = { ...defaultSessionView(), ...(v as Partial<SessionViewState>) }; }
      state = { ...state, sessionView: sv };
      ws = deps.ws({
        onOpen: () => dispatch({ kind: 'runtime', event: { type: 'ws.open' } }),
        onClose: () => dispatch({ kind: 'runtime', event: { type: 'ws.close' } }),
        onEvent: (ev) => dispatch({ kind: 'server', event: ev }),
      });
      unsubHash = deps.location.onHashChange(() => dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } }));
      ws.connect();
    },
    stop() { ws?.close(); unsubHash?.(); },
  };
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/runtime && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/runtime
git commit -m "feat(ui): runtime that executes mediator effects over api and websocket"
```

---

### Task 21: Presenter

**Files:**
- Create: `packages/ui/src/presenters/format.ts`、`packages/ui/src/presenters/row.ts`、`packages/ui/src/presenters/shell.ts`、`packages/ui/src/presenters/home.ts`、`packages/ui/src/presenters/projects.ts`、`packages/ui/src/presenters/project.ts`、`packages/ui/src/presenters/session.ts`、`packages/ui/src/presenters/sessions.ts`、`packages/ui/src/presenters/settings.ts`
- Test: `packages/ui/src/presenters/presenters.test.ts`

**Interfaces:**
- Produces（View の props 型はここで定める。View はこの型だけを受ける）：
  ```ts
  // format.ts
  export function relativeTime(ts: number | null, now: number): string;   // '3 分前' | '2 時間前' | '昨日' | '5 日前' | '2026-09-01' | '不明'
  export function absoluteTime(ts: number | null): string;                // 'YYYY-MM-DD HH:mm'
  export function shortModel(model: string | null): string;              // 'claude-fable-5-1' → 'fable 5.1'、null → ''
  export function tokensLabel(n: number): string;                        // 1234567 → '1.2M'、12345 → '12k'、999 → '999'
  // shell.ts
  export type NavItem = { route: Route; label: string; current: boolean };
  export type ShellProps = { nav: NavItem[]; crumbs: { label: string; route?: Route }[]; searchText: string; connection: State['connection']; index: IndexProgressDto; indexLabel: string | null };
  export function presentShell(state: State, store: Store): ShellProps;
  // 一覧の行
  export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; snippets?: { seq: number; text: string }[] };
  export function presentSessionRow(s: SessionDto, store: Store, now: number, snippets?: { seq: number; text: string }[]): SessionRowProps;
  // home.ts
  export type HomeProps = { running: { id: string; name: string; projectName: string | null; live: LiveStatus; elapsed: string }[]; activeProjects: ProjectCardProps[]; recent: SessionRowProps[] };
  export function presentHome(state: State, store: Store, now: number): HomeProps;
  // projects.ts
  export type ProjectCardProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; lastActivity: string; runningCount: number; openTodoCount: number; memoHead: string | null; lastOneLiner: string | null };
  export type ProjectsProps = { sections: { status: ProjectStatus; label: string; cards: ProjectCardProps[] }[]; archivedCount: number };
  export function presentProjects(state: State, store: Store, now: number, filter: string, showArchived: boolean): ProjectsProps;
  // project.ts
  export type ProjectProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; sessions: SessionRowProps[]; notFound: boolean };
  export function presentProject(state: State, store: Store, now: number, id: string): ProjectProps;
  // session.ts
  export type TranscriptItem =
    | { kind: 'user' | 'assistant' | 'thinking' | 'system'; seq: number; text: string; when: string }
    | { kind: 'tool'; seq: number; summary: string; name: string; inputJson: string; result: { text: string; isError: boolean } | null; when: string; subagent: { agentId: string; label: string } | null }
    | { kind: 'meta'; seq: number; name: string; json: string };
  export type SessionProps = { id: string; name: string; live: LiveStatus | null; cwd: string; projectName: string | null; projectId: string | null; summary: (SessionSummaryDto & { sourceLabel: string; stateLabel: string }) | null; summaryOpen: boolean; model: string; effort: string; turns: number; tokens: string; prUrl: string | null; memo: string | null; started: string; lastActivity: string; hasTranscript: boolean; items: TranscriptItem[]; total: number; loaded: number; loading: boolean; hasMore: boolean; showThinking: boolean; showRaw: boolean; follow: boolean; agentId: string | null; subagents: string[]; notFound: boolean };
  export function presentSession(state: State, store: Store, now: number, id: string): SessionProps;
  // sessions.ts
  export type SessionsProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; total: number; loading: boolean; mode: 'all' | 'search' };
  export function presentSessions(state: State, store: Store, now: number): SessionsProps;
  // settings.ts
  export type SettingsProps = { workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number };
  export function presentSettings(state: State, store: Store): SettingsProps;
  ```
- `presentSession` の `items` は、`tool_call` に後続の同じ `toolId` の `tool_result` を畳み込み、`thinking` は `showThinking` のときだけ、`meta` は `showRaw` のときだけ含める。`Agent` か `Task` の `tool_call` には、`store.subagents[id]` の順に未割り当ての ID を対応づけて `subagent` を付ける。
- `stateLabel` は `in_progress → 進行中`、`done → 完了`、`blocked → 詰まっている`、`abandoned → 中断`。`sourceLabel` は `baseline → 自動`、`in_session → セッション`、`post_hoc → 事後`。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/presenters/presenters.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { applyEventsPage, applySubagents, eventsKey, initialStore, type Store } from '../store/store.ts';
import { relativeTime, shortModel, tokensLabel } from './format.ts';
import { presentHome } from './home.ts';
import { presentProject } from './project.ts';
import { presentProjects } from './projects.ts';
import { presentSession } from './session.ts';
import { presentSessions } from './sessions.ts';
import { presentShell } from './shell.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const project = (id: string, status: ProjectDto['status'] = 'active'): ProjectDto => ({ id, name: id, status, isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - 3_600_000, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: 'name-' + id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null, hasTranscript: true, live: null, summary: { title: 't', oneLiner: 'one', body: 'b', state: 'done', nextSteps: [], source: 'baseline', sourceModel: null, basedOnTurns: 2, updatedAt: 1 }, stats: { turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: null, inputTokens: 1234567, outputTokens: 10 }, ...over });
function storeWith(): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.projects = { alpha: project('alpha'), beta: project('beta', 'paused'), old: project('old', 'archived') };
  s.sessions = { s1: session('s1', { live: 'busy' }), s2: session('s2', { lastActivityAt: NOW - 86_400_000 * 3 }), s3: session('s3', { projectId: null }) };
  return s;
}

describe('format', () => {
  it('相対時刻', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('1 分未満前');
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe('3 分前');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 時間前');
    expect(relativeTime(NOW - 30 * 3_600_000, NOW)).toBe('昨日');
    expect(relativeTime(NOW - 5 * 86_400_000, NOW)).toBe('5 日前');
    expect(relativeTime(NOW - 40 * 86_400_000, NOW)).toBe('2026-07-24');
    expect(relativeTime(null, NOW)).toBe('不明');
  });
  it('モデル名とトークン', () => {
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
    expect(shortModel(null)).toBe('');
    expect(tokensLabel(1234567)).toBe('1.2M');
    expect(tokensLabel(12345)).toBe('12k');
    expect(tokensLabel(999)).toBe('999');
  });
});

describe('presentShell', () => {
  it('現在のナビ項目とパンくずと索引の進行', () => {
    const state = { ...initialState(), screen: { name: 'project' as const, id: 'alpha' } };
    const store = storeWith();
    store.index = { phase: 'indexing', done: 10, total: 40 };
    const p = presentShell(state, store);
    expect(p.nav.find((n) => n.current)?.label).toBe('Projects');
    expect(p.crumbs.map((c) => c.label)).toEqual(['Projects', 'alpha']);
    expect(p.indexLabel).toBe('索引 10 / 40 件');
  });
});

describe('presentHome', () => {
  it('実行中の帯、active のカード、最近のセッション', () => {
    const p = presentHome(initialState(), storeWith(), NOW);
    expect(p.running.map((r) => r.id)).toEqual(['s1']);
    expect(p.running[0]!.elapsed).toBe('2 時間');
    expect(p.activeProjects.map((c) => c.id)).toEqual(['alpha']);
    expect(p.activeProjects[0]!.lastOneLiner).toBe('one');
    expect(p.recent.map((r) => r.id)).toEqual(['s1', 's3', 's2']);
    expect(p.recent[0]).toMatchObject({ name: 'name-s1', projectName: 'alpha', live: 'busy', model: 'fable 5.1', effort: 'high', stateLabel: '完了', when: '1 分前' });
  });
});

describe('presentProjects', () => {
  it('セクション分けと絞り込みとアーカイブ', () => {
    const p = presentProjects(initialState(), storeWith(), NOW, '', false);
    expect(p.sections.map((s) => [s.status, s.cards.length])).toEqual([['active', 1], ['paused', 1], ['done', 0]]);
    expect(p.archivedCount).toBe(1);
    expect(presentProjects(initialState(), storeWith(), NOW, 'bet', false).sections[1]!.cards).toHaveLength(1);
    expect(presentProjects(initialState(), storeWith(), NOW, 'bet', false).sections[0]!.cards).toHaveLength(0);
    expect(presentProjects(initialState(), storeWith(), NOW, '', true).sections.map((s) => s.status)).toEqual(['active', 'paused', 'done', 'archived']);
  });
});

describe('presentProject', () => {
  it('実行中を先頭に、その後を新しい順に', () => {
    const store = storeWith();
    store.sessions.s4 = session('s4', { live: 'idle', lastActivityAt: NOW - 86_400_000 * 9 });
    const p = presentProject(initialState(), store, NOW, 'alpha');
    expect(p.sessions.map((s) => s.id)).toEqual(['s1', 's4', 's2']);
    expect(presentProject(initialState(), store, NOW, 'nope').notFound).toBe(true);
  });
});

describe('presentSession', () => {
  it('ツール結果を呼び出しに畳み込み、思考は既定で隠し、サブエージェントを対応づける', () => {
    let store = storeWith();
    store = applyEventsPage(store, eventsKey('s1', null), { sessionId: 's1', total: 6, nextSeq: null, events: [
      { kind: 'user', seq: 0, ts: NOW, text: 'hi' },
      { kind: 'thinking', seq: 1, text: 'think' },
      { kind: 'tool_call', seq: 2, toolId: 't1', name: 'Agent', input: { description: 'x' }, summary: 'Agent x' },
      { kind: 'tool_result', seq: 3, toolId: 't1', text: 'done', isError: false },
      { kind: 'meta', seq: 4, name: 'ai-title', value: {} },
      { kind: 'assistant', seq: 5, text: 'bye' },
    ] }, false);
    store = applySubagents(store, 's1', ['abc']);
    const p = presentSession(initialState(), store, NOW, 's1');
    expect(p.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(p.items[1]).toMatchObject({ kind: 'tool', summary: 'Agent x', result: { text: 'done', isError: false }, subagent: { agentId: 'abc', label: 'Agent x' } });
    expect(p).toMatchObject({ name: 'name-s1', live: 'busy', tokens: '1.2M', turns: 2, loaded: 6, total: 6, hasMore: false, projectName: 'alpha' });
    expect(p.summary).toMatchObject({ title: 't', sourceLabel: '自動', stateLabel: '完了' });
    const state = { ...initialState(), sessionView: { s1: { agentId: null, showThinking: true, showRaw: true, follow: true, summaryOpen: true } } };
    const q = presentSession(state, store, NOW, 's1');
    expect(q.items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'meta', 'assistant']);
    expect(q.summaryOpen).toBe(true);
  });
  it('無いセッションは notFound', () => {
    expect(presentSession(initialState(), storeWith(), NOW, 'zz').notFound).toBe(true);
  });
});

describe('presentSessions', () => {
  it('検索語が無ければ全件、あれば結果だけを抜粋付きで', () => {
    let store = storeWith();
    const all = presentSessions(initialState(), store, NOW);
    expect(all.mode).toBe('all');
    expect(all.rows).toHaveLength(3);
    expect(all.projects.map((p) => p.name)).toEqual(['alpha', 'beta', 'old']);
    store = { ...store, search: { params: { q: 'hi' }, result: { hits: [{ sessionId: 's2', matchCount: 2, snippets: [{ seq: 1, role: 'user', text: '…hi…' }] }], total: 1 }, loading: false } };
    const state = { ...initialState(), screen: { name: 'sessions' as const, q: 'hi' }, search: { text: 'hi', filter: {} } };
    const r = presentSessions(state, store, NOW);
    expect(r.mode).toBe('search');
    expect(r.rows.map((x) => x.id)).toEqual(['s2']);
    expect(r.rows[0]!.snippets).toEqual([{ seq: 1, text: '…hi…' }]);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/presenters`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/presenters/format.ts`：

```ts
const pad = (n: number) => String(n).padStart(2, '0');

export function absoluteTime(ts: number | null): string {
  if (ts === null) return '不明';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(ts: number | null, now: number): string {
  if (ts === null) return '不明';
  const diff = now - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '1 分未満前';
  if (min < 60) return `${min} 分前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 時間前`;
  const days = Math.floor(hours / 24);
  if (days < 2) return '昨日';
  if (days < 30) return `${days} 日前`;
  return absoluteTime(ts).slice(0, 10);
}

export function durationLabel(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '1 分未満';
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 時間`;
  return `${Math.floor(h / 24)} 日`;
}

export function shortModel(model: string | null): string {
  if (!model) return '';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1]} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export const STATE_LABEL = { in_progress: '進行中', done: '完了', blocked: '詰まっている', abandoned: '中断' } as const;
export const SOURCE_LABEL = { baseline: '自動', in_session: 'セッション', post_hoc: '事後' } as const;
export const STATUS_LABEL = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' } as const;
```

`packages/ui/src/presenters/shell.ts`：

```ts
import type { IndexProgressDto, Route } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type NavItem = { route: Route; label: string; current: boolean };
export type ShellProps = { nav: NavItem[]; crumbs: { label: string; route?: Route }[]; searchText: string; connection: State['connection']; index: IndexProgressDto; indexLabel: string | null };

const NAV: { route: Route; label: string; matches: string[] }[] = [
  { route: { name: 'home' }, label: 'Home', matches: ['home', 'booting'] },
  { route: { name: 'projects' }, label: 'Projects', matches: ['projects', 'project'] },
  { route: { name: 'sessions' }, label: 'Sessions', matches: ['sessions', 'session'] },
  { route: { name: 'settings' }, label: 'Settings', matches: ['settings'] },
];

export function presentShell(state: State, store: Store): ShellProps {
  const s = state.screen;
  const crumbs: ShellProps['crumbs'] = [];
  if (s.name === 'projects') crumbs.push({ label: 'Projects' });
  if (s.name === 'project') crumbs.push({ label: 'Projects', route: { name: 'projects' } }, { label: store.projects[s.id]?.name ?? s.id });
  if (s.name === 'sessions') crumbs.push({ label: 'Sessions' });
  if (s.name === 'session') { const ses = store.sessions[s.id]; const proj = ses?.projectId ? store.projects[ses.projectId] : null; if (proj) crumbs.push({ label: proj.name, route: { name: 'project', id: proj.id } }); crumbs.push({ label: ses?.name ?? s.id }); }
  if (s.name === 'settings') crumbs.push({ label: 'Settings' });
  if (s.name === 'home') crumbs.push({ label: 'Home' });
  const idx = store.index;
  const indexLabel = idx.phase === 'idle' ? null : idx.phase === 'scanning' ? '索引を準備中' : `${idx.phase === 'rebuilding' ? '再構築' : '索引'} ${idx.done} / ${idx.total} 件`;
  return { nav: NAV.map((n) => ({ route: n.route, label: n.label, current: n.matches.includes(s.name) })), crumbs, searchText: state.search.text, connection: state.connection, index: idx, indexLabel };
}
```

`packages/ui/src/presenters/row.ts`（`SessionRowProps` はここに置く）：

```ts
import type { LiveStatus, SessionDto } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { absoluteTime, relativeTime, shortModel, STATE_LABEL } from './format.ts';

export type SessionRowProps = { id: string; name: string; oneLiner: string; projectName: string | null; live: LiveStatus | null; stateLabel: string; model: string; effort: string; when: string; whenAbs: string; filesChanged: number; prUrl: string | null; memo: string | null; hasTranscript: boolean; snippets?: { seq: number; text: string }[] };

export function presentSessionRow(s: SessionDto, store: Store, now: number, snippets?: { seq: number; text: string }[]): SessionRowProps {
  const row: SessionRowProps = {
    id: s.id, name: s.name ?? '（名前なし）', oneLiner: s.summary?.oneLiner ?? s.firstPrompt ?? '',
    projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null,
    live: s.live, stateLabel: s.summary ? STATE_LABEL[s.summary.state] : '', model: shortModel(s.stats.model), effort: s.stats.effort ?? '',
    when: relativeTime(s.lastActivityAt, now), whenAbs: absoluteTime(s.lastActivityAt), filesChanged: s.stats.filesChanged, prUrl: s.stats.prUrl, memo: s.memo, hasTranscript: s.hasTranscript,
  };
  if (snippets) row.snippets = snippets;
  return row;
}

const LIVE_ORDER: Record<string, number> = { waiting: 0, busy: 1, idle: 2 };
/** 実行中を先頭に、その後を新しい順に。 */
export function sortSessions(list: SessionDto[]): SessionDto[] {
  return [...list].sort((a, b) => {
    const la = a.live ? LIVE_ORDER[a.live] ?? 3 : 9;
    const lb = b.live ? LIVE_ORDER[b.live] ?? 3 : 9;
    if ((la < 9) !== (lb < 9)) return la < 9 ? -1 : 1;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}
```

`packages/ui/src/presenters/projects.ts`：

```ts
import type { ProjectDto, ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime, STATUS_LABEL } from './format.ts';

export type ProjectCardProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; lastActivity: string; runningCount: number; openTodoCount: number; memoHead: string | null; lastOneLiner: string | null };
export type ProjectsProps = { sections: { status: ProjectStatus; label: string; cards: ProjectCardProps[] }[]; archivedCount: number };

export function presentProjectCard(p: ProjectDto, store: Store, now: number): ProjectCardProps {
  const last = Object.values(store.sessions).filter((s) => s.projectId === p.id).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
  return { id: p.id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, lastActivity: relativeTime(p.lastActivityAt, now), runningCount: p.runningCount, openTodoCount: p.openTodoCount, memoHead: p.memoHead, lastOneLiner: last?.summary?.oneLiner ?? last?.firstPrompt ?? null };
}

export function presentProjects(_state: State, store: Store, now: number, filter: string, showArchived: boolean): ProjectsProps {
  const needle = filter.trim().toLowerCase();
  const all = Object.values(store.projects).filter((p) => !needle || p.name.toLowerCase().includes(needle)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const statuses: ProjectStatus[] = showArchived ? ['active', 'paused', 'done', 'archived'] : ['active', 'paused', 'done'];
  return { sections: statuses.map((status) => ({ status, label: STATUS_LABEL[status], cards: all.filter((p) => p.status === status).map((p) => presentProjectCard(p, store, now)) })), archivedCount: all.filter((p) => p.status === 'archived').length };
}
```

`packages/ui/src/presenters/home.ts`：

```ts
import type { LiveStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { durationLabel } from './format.ts';
import { presentProjectCard, type ProjectCardProps } from './projects.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type HomeProps = { running: { id: string; name: string; projectName: string | null; live: LiveStatus; elapsed: string }[]; activeProjects: ProjectCardProps[]; recent: SessionRowProps[] };

export function presentHome(_state: State, store: Store, now: number): HomeProps {
  const sessions = Object.values(store.sessions);
  const running = sortSessions(sessions.filter((s) => s.live !== null)).map((s) => ({ id: s.id, name: s.name ?? '（名前なし）', projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null, live: s.live as LiveStatus, elapsed: durationLabel(now - (s.startedAt ?? now)) }));
  const activeProjects = Object.values(store.projects).filter((p) => p.status === 'active').sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p) => presentProjectCard(p, store, now));
  const recent = sortSessions(sessions).slice(0, 30).map((s) => presentSessionRow(s, store, now));
  return { running, activeProjects, recent };
}
```

`packages/ui/src/presenters/project.ts`：

```ts
import type { ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type ProjectProps = { id: string; name: string; path: string | null; resolved: boolean; status: ProjectStatus; sessions: SessionRowProps[]; notFound: boolean };

export function presentProject(_state: State, store: Store, now: number, id: string): ProjectProps {
  const p = store.projects[id];
  if (!p) return { id, name: id, path: null, resolved: false, status: 'active', sessions: [], notFound: true };
  const sessions = sortSessions(Object.values(store.sessions).filter((s) => s.projectId === id)).map((s) => presentSessionRow(s, store, now));
  return { id, name: p.name, path: p.path, resolved: p.resolved, status: p.status, sessions, notFound: false };
}
```

`packages/ui/src/presenters/session.ts`：

```ts
import type { LiveStatus, SessionSummaryDto, TranscriptEvent } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { State } from '../mediator/types.ts';
import { eventsKey, type Store } from '../store/store.ts';
import { absoluteTime, relativeTime, shortModel, SOURCE_LABEL, STATE_LABEL, tokensLabel } from './format.ts';

export type TranscriptItem =
  | { kind: 'user' | 'assistant' | 'thinking' | 'system'; seq: number; text: string; when: string }
  | { kind: 'tool'; seq: number; summary: string; name: string; inputJson: string; result: { text: string; isError: boolean } | null; when: string; subagent: { agentId: string; label: string } | null }
  | { kind: 'meta'; seq: number; name: string; json: string };
export type SessionProps = { id: string; name: string; live: LiveStatus | null; cwd: string; projectName: string | null; projectId: string | null; summary: (SessionSummaryDto & { sourceLabel: string; stateLabel: string }) | null; summaryOpen: boolean; model: string; effort: string; turns: number; tokens: string; prUrl: string | null; memo: string | null; started: string; lastActivity: string; hasTranscript: boolean; items: TranscriptItem[]; total: number; loaded: number; loading: boolean; hasMore: boolean; showThinking: boolean; showRaw: boolean; follow: boolean; agentId: string | null; subagents: string[]; notFound: boolean };

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const when = (ts: number | undefined) => (ts === undefined ? '' : absoluteTime(ts).slice(11));

export function buildItems(events: TranscriptEvent[], opts: { showThinking: boolean; showRaw: boolean; subagents: string[] }): TranscriptItem[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.toolId, { text: e.text, isError: e.isError });
  const items: TranscriptItem[] = [];
  let nextSub = 0;
  for (const e of events) {
    switch (e.kind) {
      case 'user': case 'assistant': case 'system': items.push({ kind: e.kind, seq: e.seq, text: e.text, when: when(e.ts) }); break;
      case 'thinking': if (opts.showThinking) items.push({ kind: 'thinking', seq: e.seq, text: e.text, when: when(e.ts) }); break;
      case 'tool_call': {
        const sub = SUBAGENT_TOOLS.has(e.name) && opts.subagents[nextSub] ? { agentId: opts.subagents[nextSub++]!, label: e.summary } : null;
        items.push({ kind: 'tool', seq: e.seq, summary: e.summary, name: e.name, inputJson: JSON.stringify(e.input, null, 2), result: results.get(e.toolId) ?? null, when: when(e.ts), subagent: sub });
        break;
      }
      case 'tool_result': break;
      case 'subagent': break;
      case 'meta': if (opts.showRaw) items.push({ kind: 'meta', seq: e.seq, name: e.name, json: JSON.stringify(e.value, null, 2) }); break;
    }
  }
  return items;
}

export function presentSession(state: State, store: Store, now: number, id: string): SessionProps {
  const s = store.sessions[id];
  const view = state.sessionView[id] ?? defaultSessionView();
  const base = { id, live: null, cwd: '', projectName: null, projectId: null, summary: null, summaryOpen: view.summaryOpen, model: '', effort: '', turns: 0, tokens: '0', prUrl: null, memo: null, started: '', lastActivity: '', hasTranscript: false, items: [], total: 0, loaded: 0, loading: false, hasMore: false, showThinking: view.showThinking, showRaw: view.showRaw, follow: view.follow, agentId: view.agentId, subagents: store.subagents[id] ?? [] };
  if (!s) return { ...base, name: id, notFound: true };
  const slice = store.events[eventsKey(id, view.agentId)];
  const items = buildItems(slice?.items ?? [], { showThinking: view.showThinking, showRaw: view.showRaw, subagents: store.subagents[id] ?? [] });
  return {
    ...base, name: s.name ?? '（名前なし）', live: s.live, cwd: s.cwd, projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null, projectId: s.projectId,
    summary: s.summary ? { ...s.summary, sourceLabel: SOURCE_LABEL[s.summary.source], stateLabel: STATE_LABEL[s.summary.state] } : null,
    model: shortModel(s.stats.model), effort: s.stats.effort ?? '', turns: s.stats.turns, tokens: tokensLabel(s.stats.inputTokens + s.stats.outputTokens), prUrl: s.stats.prUrl, memo: s.memo,
    started: relativeTime(s.startedAt, now), lastActivity: relativeTime(s.lastActivityAt, now), hasTranscript: s.hasTranscript,
    items, total: slice?.total ?? 0, loaded: slice?.items.length ?? 0, loading: slice?.loading ?? false, hasMore: slice ? slice.nextSeq !== null || slice.total > slice.items.length : false, notFound: false,
  };
}
```

`packages/ui/src/presenters/sessions.ts`：

```ts
import type { SearchFilter } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

export type SessionsProps = { text: string; filter: SearchFilter; projects: { id: string; name: string }[]; rows: SessionRowProps[]; total: number; loading: boolean; mode: 'all' | 'search' };

export function presentSessions(state: State, store: Store, now: number): SessionsProps {
  const projects = Object.values(store.projects).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  const f = state.search.filter;
  if (!state.search.text) {
    let list = Object.values(store.sessions);
    if (f.projectId) list = list.filter((s) => s.projectId === f.projectId);
    if (f.running !== undefined) list = list.filter((s) => (s.live !== null) === f.running);
    if (f.since !== undefined) list = list.filter((s) => (s.lastActivityAt ?? 0) >= f.since!);
    if (f.until !== undefined) list = list.filter((s) => (s.lastActivityAt ?? 0) < f.until!);
    const rows = sortSessions(list).map((s) => presentSessionRow(s, store, now));
    return { text: '', filter: f, projects, rows, total: rows.length, loading: false, mode: 'all' };
  }
  const result = store.search.result;
  const rows: SessionRowProps[] = [];
  for (const h of result?.hits ?? []) { const s = store.sessions[h.sessionId]; if (s) rows.push(presentSessionRow(s, store, now, h.snippets.map((x) => ({ seq: x.seq, text: x.text })))); }
  return { text: state.search.text, filter: f, projects, rows, total: result?.total ?? 0, loading: store.search.loading, mode: 'search' };
}
```

`packages/ui/src/presenters/settings.ts`：

```ts
import type { IndexProgressDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

export type SettingsProps = { workspaceRoot: string; claudeDir: string; device: { id: string; name: string } | null; version: string; index: IndexProgressDto; sessionCount: number; projectCount: number };

export function presentSettings(_state: State, store: Store): SettingsProps {
  return { workspaceRoot: store.settings?.workspaceRoot ?? '', claudeDir: store.settings?.claudeDir ?? '', device: store.device, version: store.version, index: store.index, sessionCount: Object.keys(store.sessions).length, projectCount: Object.keys(store.projects).length };
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/presenters && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/presenters
git commit -m "feat(ui): pure presenters for shell, home, projects, project, session, sessions and settings"
```

---

### Task 22: 共通の View と Shell

**Files:**
- Create: `packages/ui/src/views/primitives/VirtualList.tsx`、`packages/ui/src/views/primitives/StatusDot.tsx`、`packages/ui/src/views/primitives/RelativeTime.tsx`、`packages/ui/src/views/primitives/Fold.tsx`、`packages/ui/src/views/SessionRows.tsx`、`packages/ui/src/views/Shell.tsx`、`packages/ui/src/views/Sidebar.tsx`、`packages/ui/src/views/Header.tsx`
- Test: `packages/ui/src/views/Shell.test.tsx`、`packages/ui/src/views/SessionRows.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export function VirtualList<T>(props: { items: T[]; rowHeight: number; height: number | string; render: (item: T, index: number) => ReactNode; keyOf: (item: T) => string; head?: ReactNode }): JSX.Element;
  export function StatusDot(props: { status: LiveStatus | null; title?: string }): JSX.Element;
  export function RelativeTime(props: { label: string; abs: string }): JSX.Element;     // <time title={abs}> を等幅で
  export function Fold(props: { summary: ReactNode; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; className?: string }): JSX.Element;
  export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; showProject: boolean; showSnippets?: boolean }): JSX.Element;   // クリックで session.open、Enter でも開く
  export function Shell(props: ShellProps & { children: ReactNode; overlays: ReactNode }): JSX.Element;
  export function Sidebar(props: { nav: NavItem[] }): JSX.Element;    // クリックで nav.go
  export function Header(props: { crumbs: ShellProps['crumbs']; searchText: string; connection: ShellProps['connection']; indexLabel: string | null }): JSX.Element;   // 検索欄は Enter で search.query、パンくずは nav.go
  ```
- `SessionRows` の列：状態点、名前、要約の 1 文、プロジェクト（`showProject` のとき）、状態、モデルと effort、変更ファイル数、PR、時刻。`grid-template-columns` は `16px minmax(160px, 1.2fr) minmax(200px, 2fr) [120px] 72px 110px 48px 32px 80px`。抜粋は行の下に等幅で 1 行ずつ出す（`showSnippets` のとき行高を 28 + 20 × 件数 にする）。
- 検索欄の `value` は props の `searchText` を初期値にした非制御入力で、Enter で `search.query`、`/` キーで全体からフォーカスされる（`Root` が `focus` 効果で `#global-search` にフォーカスする）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/Shell.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { Shell } from './Shell.tsx';

const props = { nav: [{ route: { name: 'home' as const }, label: 'Home', current: true }, { route: { name: 'projects' as const }, label: 'Projects', current: false }], crumbs: [{ label: 'Projects', route: { name: 'projects' as const } }, { label: 'alpha' }], searchText: '', connection: 'connected' as const, index: { phase: 'idle' as const, done: 0, total: 0 }, indexLabel: null };

describe('Shell', () => {
  it('ナビと検索が Intent になる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><Shell {...props} overlays={null}><div>body</div></Shell></IntentRoot>);
    fireEvent.click(screen.getByRole('link', { name: 'Projects', current: false }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'projects' } });
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: '動画' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '動画' });
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });
  it('切断と索引の進行を表示する', () => {
    render(<IntentRoot onIntent={() => {}}><Shell {...props} connection="disconnected" indexLabel="索引 3 / 9 件" overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByText('再接続中')).toBeInTheDocument();
    expect(screen.getByText('索引 3 / 9 件')).toBeInTheDocument();
  });
});
```

`packages/ui/src/views/SessionRows.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { SessionRows } from './SessionRows.tsx';

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: id === 'a' ? 'busy' : null, stateLabel: '完了', model: 'fable 5.1', effort: 'high', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 2, prUrl: 'https://x/pull/1', memo: null, hasTranscript: true });

describe('SessionRows', () => {
  it('行のクリックと Enter で session.open', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionRows rows={[row('a'), row('b')]} height={400} showProject /></IntentRoot>);
    fireEvent.click(screen.getByText('na'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'a' });
    fireEvent.keyDown(screen.getByText('nb').closest('[role="row"]')!, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 'b' });
    expect(screen.getByTitle('2026-09-01 10:00')).toBeInTheDocument();
    expect(screen.getAllByText('alpha')).toHaveLength(2);
  });
  it('空なら案内を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} showProject={false} /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/views/primitives/VirtualList.tsx`：

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type ReactNode } from 'react';

/** 高密度の一覧。jsdom では要素の高さが 0 なので、テスト時は全件を素直に描く。 */
export function VirtualList<T>(props: { items: T[]; rowHeight: number; height: number | string; render: (item: T, index: number) => ReactNode; keyOf: (item: T) => string; head?: ReactNode }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: props.items.length, getScrollElement: () => parentRef.current, estimateSize: () => props.rowHeight, overscan: 12 });
  const virtual = v.getVirtualItems();
  const plain = typeof window === 'undefined' || virtual.length === 0;
  return (
    <div className="list">
      {props.head}
      <div ref={parentRef} className="list-scroll" style={{ height: props.height }} role="rowgroup">
        {plain ? props.items.map((it, i) => <div key={props.keyOf(it)}>{props.render(it, i)}</div>) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {virtual.map((row) => (
              <div key={props.keyOf(props.items[row.index]!)} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}>
                {props.render(props.items[row.index]!, row.index)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

`packages/ui/src/views/primitives/StatusDot.tsx`：

```tsx
import type { LiveStatus } from '@agent-hangar/shared';
const LABEL: Record<LiveStatus, string> = { busy: '作業中', idle: '待機', waiting: '入力待ち' };
export function StatusDot(props: { status: LiveStatus | null; title?: string }) {
  return <span className="dot" data-status={props.status ?? 'ended'} title={props.title ?? (props.status ? LABEL[props.status] : '終了')} aria-label={props.status ? LABEL[props.status] : '終了'} />;
}
```

`packages/ui/src/views/primitives/RelativeTime.tsx`：

```tsx
export function RelativeTime(props: { label: string; abs: string }) {
  return <time className="mono muted" title={props.abs}>{props.label}</time>;
}
```

`packages/ui/src/views/primitives/Fold.tsx`：

```tsx
import type { ReactNode } from 'react';
export function Fold(props: { summary: ReactNode; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; className?: string }) {
  return (
    <details className={`fold ${props.className ?? ''}`} open={props.open} onToggle={(e) => props.onToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="fold-head"><span className="fold-arrow">▸</span>{props.summary}</summary>
      {props.children}
    </details>
  );
}
```

`packages/ui/src/views/SessionRows.tsx`：

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { RelativeTime } from './primitives/RelativeTime.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';
import { VirtualList } from './primitives/VirtualList.tsx';

const cols = (showProject: boolean) => `16px minmax(160px, 1.2fr) minmax(200px, 2fr) ${showProject ? '120px ' : ''}72px 110px 48px 32px 80px`;

export function SessionRows(props: { rows: SessionRowProps[]; height: number | string; showProject: boolean; showSnippets?: boolean }) {
  const emit = useEmit();
  if (props.rows.length === 0) return <div className="list"><div className="empty">セッションはまだありません</div></div>;
  const style = { gridTemplateColumns: cols(props.showProject) };
  const head = (
    <div className="row row-head" style={style} role="row">
      <span /><span>名前</span><span>要約</span>{props.showProject && <span>プロジェクト</span>}<span>状態</span><span>モデル</span><span className="cell-right">変更</span><span>PR</span><span className="cell-right">最終活動</span>
    </div>
  );
  const rowHeight = (r: SessionRowProps) => 28 + (props.showSnippets ? (r.snippets?.length ?? 0) * 20 : 0);
  return (
    <VirtualList items={props.rows} rowHeight={28} height={props.height} keyOf={(r) => r.id} head={head} render={(r) => (
      <div style={{ height: rowHeight(r) }}>
        <div className="row" style={style} role="row" tabIndex={0} onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
          <StatusDot status={r.live} />
          <span className="cell">{r.name}</span>
          <span className="cell muted">{r.oneLiner}</span>
          {props.showProject && <span className="cell muted">{r.projectName ?? '未分類'}</span>}
          <span className="cell muted">{r.stateLabel}</span>
          <span className="cell mono">{r.model}{r.effort ? ` · ${r.effort}` : ''}</span>
          <span className="cell mono cell-right">{r.filesChanged || ''}</span>
          <span className="cell">{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR</a> : ''}</span>
          <span className="cell cell-right"><RelativeTime label={r.when} abs={r.whenAbs} /></span>
        </div>
        {props.showSnippets && r.snippets?.map((s) => <div key={s.seq} className="mono faint" style={{ height: 20, padding: '0 12px 0 40px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.text}</div>)}
      </div>
    )} />
  );
}
```

`packages/ui/src/views/Sidebar.tsx`：

```tsx
import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NavItem } from '../presenters/shell.ts';

export function Sidebar(props: { nav: NavItem[] }) {
  const emit = useEmit();
  return (
    <nav className="sidebar" aria-label="主ナビゲーション">
      <div style={{ padding: '0 16px 12px', fontWeight: 600 }}>agent-hangar</div>
      {props.nav.map((n) => (
        <a key={n.label} className="nav-item" href={formatRoute(n.route)} aria-current={n.current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: n.route }); }}>{n.label}</a>
      ))}
    </nav>
  );
}
```

`packages/ui/src/views/Header.tsx`：

```tsx
import { formatRoute } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { ShellProps } from '../presenters/shell.ts';

export function Header(props: { crumbs: ShellProps['crumbs']; searchText: string; connection: ShellProps['connection']; indexLabel: string | null }) {
  const emit = useEmit();
  return (
    <header className="header">
      <div className="crumbs">
        {props.crumbs.map((c, i) => (
          <span key={i}>{i > 0 && <span className="faint"> / </span>}{c.route ? <a href={formatRoute(c.route)} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: c.route! }); }}>{c.label}</a> : <b>{c.label}</b>}</span>
        ))}
      </div>
      <input id="global-search" className="input search-box" type="search" role="searchbox" placeholder="セッションを検索（/）" defaultValue={props.searchText}
        onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'search.query', text: (e.target as HTMLInputElement).value }); }} />
      <span className="spacer" />
      {props.indexLabel && <span className="progress">{props.indexLabel}</span>}
      <span className="conn" data-state={props.connection}>{props.connection === 'connected' ? '接続中' : props.connection === 'connecting' ? '接続しています' : '再接続中'}</span>
    </header>
  );
}
```

`packages/ui/src/views/Shell.tsx`：

```tsx
import type { ReactNode } from 'react';
import type { ShellProps } from '../presenters/shell.ts';
import { Header } from './Header.tsx';
import { Sidebar } from './Sidebar.tsx';

export function Shell(props: ShellProps & { children: ReactNode; overlays: ReactNode }) {
  return (
    <div className="shell">
      <Sidebar nav={props.nav} />
      <Header crumbs={props.crumbs} searchText={props.searchText} connection={props.connection} indexLabel={props.indexLabel} />
      <main className="main"><div className="main-inner">{props.children}</div></main>
      {props.overlays}
    </div>
  );
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/views && npm run typecheck`
Expected: PASS（4 件）

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views
git commit -m "feat(ui): shell, sidebar, header, session rows and list primitives"
```

---

### Task 23: Home、Projects、プロジェクト詳細の画面

**Files:**
- Create: `packages/ui/src/views/HomeScreen.tsx`、`packages/ui/src/views/ProjectsScreen.tsx`、`packages/ui/src/views/ProjectScreen.tsx`、`packages/ui/src/views/ProjectCard.tsx`
- Test: `packages/ui/src/views/screens.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export function HomeScreen(props: HomeProps): JSX.Element;
  export function ProjectsScreen(props: ProjectsProps & { filter: string; showArchived: boolean; onFilter: (s: string) => void; onShowArchived: (b: boolean) => void }): JSX.Element;   // 絞り込みと表示切替は画面内だけの一時状態なので Root が useState で持ち、props で渡す
  export function ProjectCard(props: ProjectCardProps): JSX.Element;      // クリックで project.open。ステータスの select で project.setStatus
  export function ProjectScreen(props: ProjectProps): JSX.Element;         // 右レールは TODO とメモの枠だけ（フェーズ 3 で中身）。ヘッダーの操作は「新規セッション」「VS Code で開く」「ターミナルで開く」で、押すとフェーズ 2 の Intent を出す
  ```

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/screens.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { ProjectCardProps } from '../presenters/projects.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';

const card = (id: string): ProjectCardProps => ({ id, name: id, path: '/w/' + id, resolved: true, status: 'active', lastActivity: '1 時間前', runningCount: 1, openTodoCount: 0, memoHead: null, lastOneLiner: 'last one' });

describe('HomeScreen', () => {
  it('実行中の帯とカードと最近', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><HomeScreen running={[{ id: 's1', name: 'run', projectName: 'alpha', live: 'busy', elapsed: '2 時間' }]} activeProjects={[card('alpha')]} recent={[]} /></IntentRoot>);
    fireEvent.click(screen.getByText('run'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
    fireEvent.click(screen.getByText('last one'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
  });
  it('実行中が無ければ帯を省く', () => {
    render(<IntentRoot onIntent={() => {}}><HomeScreen running={[]} activeProjects={[]} recent={[]} /></IntentRoot>);
    expect(screen.queryByText('実行中')).toBeNull();
  });
});

describe('ProjectsScreen', () => {
  it('セクションとアーカイブ切替とステータス変更', () => {
    const onIntent = vi.fn();
    const onShow = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [card('alpha')] }, { status: 'paused', label: 'Paused', cards: [] }]} archivedCount={2} filter="" showArchived={false} onFilter={() => {}} onShowArchived={onShow} /></IntentRoot>);
    fireEvent.click(screen.getByText('アーカイブを表示（2）'));
    expect(onShow).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByLabelText('alpha のステータス'), { target: { value: 'paused' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.setStatus', id: 'alpha', status: 'paused' });
  });
});

describe('ProjectScreen', () => {
  it('見つからないときの表示と、操作ボタンの Intent', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><ProjectScreen id="x" name="x" path={null} resolved={false} status="active" sessions={[]} notFound /></IntentRoot>);
    expect(screen.getByText('プロジェクトが見つかりません')).toBeInTheDocument();
    rerender(<IntentRoot onIntent={onIntent}><ProjectScreen id="alpha" name="alpha" path="/w/alpha" resolved status="active" sessions={[]} notFound={false} /></IntentRoot>);
    fireEvent.click(screen.getByText('新規セッション'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'alpha' });
    expect(screen.getByText('/w/alpha')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/screens`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/views/ProjectCard.tsx`：

```tsx
import type { ProjectStatus } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { ProjectCardProps } from '../presenters/projects.ts';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

export function ProjectCard(props: ProjectCardProps) {
  const emit = useEmit();
  return (
    <div className="card" role="link" tabIndex={0} onClick={() => emit({ type: 'project.open', id: props.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'project.open', id: props.id }); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="card-title" style={{ flex: 1 }}>{props.name}</span>
        <select className="select" aria-label={`${props.name} のステータス`} value={props.status} onClick={(e) => e.stopPropagation()} onChange={(e) => emit({ type: 'project.setStatus', id: props.id, status: e.target.value as ProjectStatus })}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.path ?? 'この端末にパスがありません'}{!props.resolved && props.path ? '（見つかりません）' : ''}</div>
      <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.lastOneLiner ?? 'セッションはまだありません'}</div>
      <div className="faint" style={{ display: 'flex', gap: 12 }}>
        <span>{props.lastActivity}</span>
        {props.runningCount > 0 && <span>実行中 {props.runningCount}</span>}
        {props.openTodoCount > 0 && <span>TODO {props.openTodoCount}</span>}
      </div>
    </div>
  );
}
```

`packages/ui/src/views/HomeScreen.tsx`：

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { HomeProps } from '../presenters/home.ts';
import { ProjectCard } from './ProjectCard.tsx';
import { SessionRows } from './SessionRows.tsx';
import { StatusDot } from './primitives/StatusDot.tsx';

export function HomeScreen(props: HomeProps) {
  const emit = useEmit();
  return (
    <div className="screen">
      {props.running.length > 0 && (
        <>
          <h2 className="h2" style={{ marginTop: 0 }}>実行中</h2>
          <div className="list">
            {props.running.map((r) => (
              <div key={r.id} className="row" style={{ gridTemplateColumns: '16px 1fr 160px 80px' }} role="row" tabIndex={0} onClick={() => emit({ type: 'session.open', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'session.open', id: r.id }); }}>
                <StatusDot status={r.live} /><span className="cell">{r.name}</span><span className="cell muted">{r.projectName ?? '未分類'}</span><span className="cell mono cell-right">{r.elapsed}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <h2 className="h2">プロジェクト</h2>
      {props.activeProjects.length === 0 ? <div className="empty">active なプロジェクトはありません。Settings でワークスペースを確かめてください。</div> : <div className="cards">{props.activeProjects.map((c) => <ProjectCard key={c.id} {...c} />)}</div>}
      <h2 className="h2">最近のセッション</h2>
      <SessionRows rows={props.recent} height={Math.min(props.recent.length, 15) * 28 + 28} showProject />
    </div>
  );
}
```

`packages/ui/src/views/ProjectsScreen.tsx`：

```tsx
import type { ProjectsProps } from '../presenters/projects.ts';
import { ProjectCard } from './ProjectCard.tsx';

export function ProjectsScreen(props: ProjectsProps & { filter: string; showArchived: boolean; onFilter: (s: string) => void; onShowArchived: (b: boolean) => void }) {
  return (
    <div className="screen">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <h1 className="h1" style={{ margin: 0 }}>Projects</h1>
        <input className="input" placeholder="名前で絞る" value={props.filter} onChange={(e) => props.onFilter(e.target.value)} aria-label="名前で絞る" />
        <span className="spacer" />
        <button className="btn" onClick={() => props.onShowArchived(!props.showArchived)}>{props.showArchived ? 'アーカイブを隠す' : `アーカイブを表示（${props.archivedCount}）`}</button>
      </div>
      {props.sections.map((s) => (
        <section key={s.status}>
          <div className="section-head"><h2 className="h2">{s.label}</h2><span className="faint">{s.cards.length}</span></div>
          {s.cards.length === 0 ? <div className="faint" style={{ padding: '4px 0 8px' }}>なし</div> : <div className="cards">{s.cards.map((c) => <ProjectCard key={c.id} {...c} />)}</div>}
        </section>
      ))}
    </div>
  );
}
```

`packages/ui/src/views/ProjectScreen.tsx`：

```tsx
import type { ProjectStatus } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { SessionRows } from './SessionRows.tsx';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

export function ProjectScreen(props: ProjectProps) {
  const emit = useEmit();
  if (props.notFound) return <div className="screen"><div className="empty">プロジェクトが見つかりません</div></div>;
  return (
    <div className="screen" style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
          <select className="select" aria-label="ステータス" value={props.status} onChange={(e) => emit({ type: 'project.setStatus', id: props.id, status: e.target.value as ProjectStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.id })}>新規セッション</button>
          <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: '' })}>VS Code で開く</button>
          <button className="btn" onClick={() => emit({ type: 'session.openTerminalApp', runId: '' })}>ターミナルで開く</button>
        </div>
        <div className="mono faint" style={{ marginBottom: 12 }}>{props.path ?? 'この端末にパスがありません'}{!props.resolved && props.path ? '（見つかりません）' : ''}</div>
        <SessionRows rows={props.sessions} height="calc(100vh - 200px)" showProject={false} />
      </div>
      <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section><h2 className="h2" style={{ marginTop: 0 }}>TODO</h2><div className="faint">次のフェーズで使えるようになります</div></section>
        <section><h2 className="h2">メモ</h2><div className="faint">次のフェーズで使えるようになります</div></section>
        <section><h2 className="h2">アーティファクト</h2><div className="faint">次のフェーズで使えるようになります</div></section>
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui/src/views && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views
git commit -m "feat(ui): home, projects and project screens"
```

---

### Task 24: セッション詳細（トランスクリプト）

**Files:**
- Create: `packages/ui/src/views/SessionScreen.tsx`、`packages/ui/src/views/Transcript.tsx`
- Test: `packages/ui/src/views/SessionScreen.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export function SessionScreen(props: SessionProps): JSX.Element;
  export function Transcript(props: { sessionId: string; items: TranscriptItem[]; hasMore: boolean; loading: boolean; follow: boolean; live: boolean }): JSX.Element;
  ```
- 振る舞い：
  - ヘッダー：状態点、名前、プロジェクト（リンク）、モデルと effort、ターン数、トークン、PR、開始と最終活動。操作は「再開」「フォーク」「VS Code で開く」（フェーズ 2 の Intent を出す。`hasTranscript` が偽なら再開とフォークを無効にして「本文なし」を添える）。
  - 要約：題名と 1 文を常に出し、「詳細」で `summary.toggle`。開いたら本文、状態、次の一手、出所（`sourceLabel`）を出す。
  - 切替：思考を表示（`transcript.showThinking`）、生 JSON（`transcript.showRaw`）、サブエージェント（`select` で `transcript.selectAgent`。Mediator の `sessionViewStep` で `agentId` を更新し、`api.loadEvents(id, 0)` を出す）。
  - 本文：`Transcript` は `items` を描く。`user` と `assistant` は吹き出し、`thinking` は薄い斜体、`system` は小さく中央、`tool` は `Fold` で 1 行に畳み（要約、時刻、結果の有無、エラーなら赤の縦線）、開くと入力 JSON と結果本文を出す。`subagent` があれば「サブエージェント abc123 を見る」のボタンで `transcript.selectAgent`。
  - 追記の追従：`follow` が真なら末尾へスクロールし、利用者が上へスクロールしたら `transcript.follow(false)` を出して「新着 N 件」のボタンを出す。ボタンで `transcript.follow(true)`。`live` が偽（終了したセッション）なら追従の表示は出さない。
  - 続きの読み込み：`hasMore` なら末尾に「続きを読み込む（残り N 件）」で `transcript.loadMore`。
  - 長い本文は `msg` の `max-height: 60vh; overflow: auto` で収め、スクロールで読める。

- [ ] **Step 1: Mediator に selectAgent を足す**

`transcript.selectAgent` は Task 2 の Intent 共用体にすでにある。
`packages/ui/src/mediator/sessionView.ts` の `switch` に次を加える。

```ts
    case 'transcript.selectAgent': {
      const r = patch(state, i.sessionId, { agentId: i.agentId });
      return { state: r.state, effects: [...r.effects, { kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: 0 }] };
    }
```

`packages/ui/src/mediator/transition.test.ts` に次のテストを加える。

```ts
  it('サブエージェントの切替は agentId を保存して先頭から読み直す', () => {
    const { state, effects } = run([intent({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' })]);
    expect(state.sessionView.s1?.agentId).toBe('abc');
    expect(effects[1]).toEqual({ kind: 'api.loadEvents', sessionId: 's1', fromSeq: 0 });
  });
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/ui/src/views/SessionScreen.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { SessionProps } from '../presenters/session.ts';
import { SessionScreen } from './SessionScreen.tsx';

const base: SessionProps = { id: 's1', name: 'name', live: 'busy', cwd: '/w/alpha', projectName: 'alpha', projectId: 'p1', summary: { title: 'T', oneLiner: 'ONE', body: 'BODY', state: 'in_progress', nextSteps: ['next1'], source: 'baseline', sourceModel: null, basedOnTurns: 2, updatedAt: 1, sourceLabel: '自動', stateLabel: '進行中' }, summaryOpen: false, model: 'fable 5.1', effort: 'high', turns: 2, tokens: '1.2M', prUrl: null, memo: null, started: '2 時間前', lastActivity: '1 分前', hasTranscript: true,
  items: [
    { kind: 'user', seq: 0, text: 'hi', when: '10:00' },
    { kind: 'tool', seq: 1, summary: 'Agent x', name: 'Agent', inputJson: '{}', result: { text: 'done', isError: false }, when: '10:01', subagent: { agentId: 'abc', label: 'Agent x' } },
    { kind: 'tool', seq: 2, summary: 'Edit /a', name: 'Edit', inputJson: '{}', result: { text: 'File not found', isError: true }, when: '10:02', subagent: null },
    { kind: 'assistant', seq: 3, text: 'bye', when: '10:03' },
  ], total: 10, loaded: 4, loading: false, hasMore: true, showThinking: false, showRaw: false, follow: true, agentId: null, subagents: ['abc'], notFound: false };

describe('SessionScreen', () => {
  it('ヘッダー、要約の開閉、切替、続きの読み込み', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} /></IntentRoot>);
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('ONE')).toBeInTheDocument();
    expect(screen.queryByText('BODY')).toBeNull();
    fireEvent.click(screen.getByText('詳細'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'summary.toggle', sessionId: 's1' });
    fireEvent.click(screen.getByLabelText('思考を表示'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.showThinking', sessionId: 's1', show: true });
    fireEvent.click(screen.getByText('続きを読み込む（残り 6 件）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.loadMore', sessionId: 's1' });
    fireEvent.change(screen.getByLabelText('サブエージェント'), { target: { value: 'abc' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('開いた要約は本文と次の一手を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} summaryOpen /></IntentRoot>);
    expect(screen.getByText('BODY')).toBeInTheDocument();
    expect(screen.getByText('next1')).toBeInTheDocument();
    expect(screen.getByText('自動')).toBeInTheDocument();
  });
  it('ツール呼び出しは畳まれ、エラーは印が付き、サブエージェントへ飛べる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} /></IntentRoot>);
    expect(screen.getByText('Edit /a').closest('.tool')).toHaveClass('tool-error');
    fireEvent.click(screen.getByText('サブエージェント abc を見る'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
  });
  it('本文が無いセッションは再開を無効にする', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} hasTranscript={false} items={[]} total={0} loaded={0} hasMore={false} /></IntentRoot>);
    expect(screen.getByText('再開')).toBeDisabled();
    expect(screen.getByText('本文がありません')).toBeInTheDocument();
  });
  it('見つからないとき', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} notFound /></IntentRoot>);
    expect(screen.getByText('セッションが見つかりません')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/SessionScreen packages/ui/src/mediator`
Expected: FAIL（View が無い）

- [ ] **Step 4: 実装する**

`packages/ui/src/views/Transcript.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TranscriptItem } from '../presenters/session.ts';
import { Fold } from './primitives/Fold.tsx';

function ToolItem({ sessionId, item }: { sessionId: string; item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const emit = useEmit();
  return (
    <div className={`tool ${item.result?.isError ? 'tool-error' : ''}`}>
      <Fold summary={<><span className="mono">{item.summary}</span><span className="faint mono" style={{ marginLeft: 'auto' }}>{item.when}</span></>}>
        <div className="tool-body mono">{item.inputJson}</div>
        {item.result && <div className="tool-body mono" style={{ marginTop: 4 }}>{item.result.text || '（出力なし）'}</div>}
      </Fold>
      {item.subagent && <div className="sub"><button className="btn" onClick={() => emit({ type: 'transcript.selectAgent', sessionId, agentId: item.subagent!.agentId })}>サブエージェント {item.subagent.agentId} を見る</button></div>}
    </div>
  );
}

export function Transcript(props: { sessionId: string; items: TranscriptItem[]; hasMore: boolean; loading: boolean; follow: boolean; live: boolean; remaining: number }) {
  const emit = useEmit();
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(props.items.length);

  useEffect(() => {
    const added = props.items.length - lastCount.current;
    lastCount.current = props.items.length;
    if (props.follow) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    else if (added > 0) setUnseen((n) => n + added);
  }, [props.items.length, props.follow]);

  useEffect(() => { if (props.follow) setUnseen(0); }, [props.follow]);

  const onScroll = () => {
    const el = boxRef.current; if (!el || !props.live) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && props.follow) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: false });
    if (atBottom && !props.follow) emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true });
  };

  return (
    <div ref={boxRef} className="tr" onScroll={onScroll} style={{ overflow: 'auto', height: 'calc(100vh - 260px)', padding: '8px 0' }}>
      {props.items.length === 0 && !props.loading && <div className="empty">本文がありません</div>}
      {props.items.map((it) => {
        switch (it.kind) {
          case 'user': return <div key={it.seq} className="msg msg-user" style={{ maxHeight: '60vh', overflow: 'auto' }}>{it.text}</div>;
          case 'assistant': return <div key={it.seq} className="msg msg-assistant" style={{ maxHeight: '60vh', overflow: 'auto' }}>{it.text}</div>;
          case 'thinking': return <div key={it.seq} className="msg msg-thinking">{it.text}</div>;
          case 'system': return <div key={it.seq} className="msg msg-system">{it.text}</div>;
          case 'tool': return <ToolItem key={it.seq} sessionId={props.sessionId} item={it} />;
          case 'meta': return <div key={it.seq} className="msg msg-system mono">{it.name} {it.json}</div>;
        }
      })}
      {props.hasMore && <button className="btn" style={{ alignSelf: 'center' }} disabled={props.loading} onClick={() => emit({ type: 'transcript.loadMore', sessionId: props.sessionId })}>{props.loading ? '読み込んでいます' : `続きを読み込む（残り ${props.remaining} 件）`}</button>}
      {props.live && !props.follow && unseen > 0 && <button className="btn btn-primary new-banner" onClick={() => emit({ type: 'transcript.follow', sessionId: props.sessionId, follow: true })}>新着 {unseen} 件</button>}
      <div ref={endRef} />
    </div>
  );
}
```

`packages/ui/src/views/SessionScreen.tsx`：

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { SessionProps } from '../presenters/session.ts';
import { StatusDot } from './primitives/StatusDot.tsx';
import { Transcript } from './Transcript.tsx';

export function SessionScreen(props: SessionProps) {
  const emit = useEmit();
  if (props.notFound) return <div className="screen"><div className="empty">セッションが見つかりません</div></div>;
  const id = props.id;
  return (
    <div className="screen">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusDot status={props.live} />
        <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
        {props.projectName && <a href="#" onClick={(e) => { e.preventDefault(); if (props.projectId) emit({ type: 'project.open', id: props.projectId }); }}>{props.projectName}</a>}
        <span className="spacer" />
        <button className="btn" disabled={!props.hasTranscript} onClick={() => emit({ type: 'session.resume', id })}>再開</button>
        <button className="btn" disabled={!props.hasTranscript} onClick={() => emit({ type: 'session.fork', id })}>フォーク</button>
        <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: id })}>VS Code で開く</button>
      </div>
      <div className="mono faint" style={{ display: 'flex', gap: 16, margin: '4px 0 8px', flexWrap: 'wrap' }}>
        <span>{props.cwd}</span><span>{props.model}{props.effort ? ` · ${props.effort}` : ''}</span><span>{props.turns} ターン</span><span>{props.tokens} tokens</span>
        {props.prUrl && <a href={props.prUrl} target="_blank" rel="noreferrer">PR</a>}
        <span>開始 {props.started}</span><span>最終 {props.lastActivity}</span>
        {!props.hasTranscript && <span>本文がありません</span>}
      </div>
      {props.summary && (
        <div className="list" style={{ padding: '8px 12px', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
            <b>{props.summary.title}</b><span className="muted">{props.summary.oneLiner}</span><span className="faint">{props.summary.stateLabel}</span>
            <span className="spacer" /><button className="btn" onClick={() => emit({ type: 'summary.toggle', sessionId: id })}>{props.summaryOpen ? '閉じる' : '詳細'}</button>
          </div>
          {props.summaryOpen && (
            <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
              <div>{props.summary.body}</div>
              {props.summary.nextSteps.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>{props.summary.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>}
              <div className="faint" style={{ marginTop: 8 }}>出所 <span>{props.summary.sourceLabel}</span>、{props.summary.basedOnTurns} ターン時点</div>
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 4 }}>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" aria-label="思考を表示" checked={props.showThinking} onChange={(e) => emit({ type: 'transcript.showThinking', sessionId: id, show: e.target.checked })} />思考を表示</label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" aria-label="生の記録を表示" checked={props.showRaw} onChange={(e) => emit({ type: 'transcript.showRaw', sessionId: id, show: e.target.checked })} />生の記録</label>
        {props.subagents.length > 0 && (
          <select className="select" aria-label="サブエージェント" value={props.agentId ?? ''} onChange={(e) => emit({ type: 'transcript.selectAgent', sessionId: id, agentId: e.target.value || null })}>
            <option value="">主線</option>{props.subagents.map((a) => <option key={a} value={a}>サブエージェント {a}</option>)}
          </select>
        )}
        <span className="spacer" /><span className="faint mono">{props.loaded} / {props.total}</span>
      </div>
      <Transcript sessionId={id} items={props.items} hasMore={props.hasMore} loading={props.loading} follow={props.follow} live={props.live !== null} remaining={Math.max(props.total - props.loaded, 0)} />
    </div>
  );
}
```

- [ ] **Step 5: テストと型検査**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/mediator packages/ui/src/views
git commit -m "feat(ui): session screen with folded tool calls, summary panel and follow mode"
```

---

### Task 25: Sessions（検索）、Settings、オーバーレイ

**Files:**
- Create: `packages/ui/src/views/SessionsScreen.tsx`、`packages/ui/src/views/SettingsScreen.tsx`、`packages/ui/src/views/ResolveProjectDialog.tsx`、`packages/ui/src/views/ToastStack.tsx`
- Test: `packages/ui/src/views/misc.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export function SessionsScreen(props: SessionsProps): JSX.Element;    // キーワード欄（Enter で search.query）、絞り込み（プロジェクト select、期間 select、実行中 select、ファイル欄）は変えるたびに search.filter
  export function SettingsScreen(props: SettingsProps): JSX.Element;    // ワークスペースルート欄と保存（settings.update）、索引の作り直し（index.rebuild）、診断（端末 ID、版、件数、索引の進行）
  export function ResolveProjectDialog(props: { projectId: string; name: string; path: string | null; candidates: string[]; onQueryCandidates: (name: string) => void }): JSX.Element;   // 再指定（候補から選ぶか入力）、アーカイブ、紐づけ削除。閉じるで overlay.close
  export function ToastStack(props: { toasts: Toast[] }): JSX.Element;   // クリックで toast.dismiss。5 秒で Root が消す
  ```
- 期間の選択肢は「すべて」「今日」「7 日」「30 日」で、`since` を `now - N 日` にする（`until` は使わない）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/views/misc.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';
import { SessionsScreen } from './SessionsScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { ToastStack } from './ToastStack.tsx';

describe('SessionsScreen', () => {
  it('絞り込みは search.filter、キーワードは search.query', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('プロジェクト'), { target: { value: 'p1' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: 'p1' } });
    fireEvent.change(screen.getByLabelText('実行中'), { target: { value: 'running' } });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { running: true } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: 'x y' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y' });
  });
  it('検索中と件数の表示', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" /></IntentRoot>);
    expect(screen.getByText('検索しています')).toBeInTheDocument();
  });
});

describe('SettingsScreen', () => {
  it('保存と作り直し', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen workspaceRoot="/w" claudeDir="/c" device={{ id: 'd', name: 'mac' }} version="0.1.0" index={{ phase: 'idle', done: 3, total: 3 }} sessionCount={3} projectCount={1} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('ワークスペースのルート'), { target: { value: '/w2' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { workspaceRoot: '/w2' } });
    fireEvent.click(screen.getByText('索引を作り直す'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'index.rebuild' });
    expect(screen.getByText('mac')).toBeInTheDocument();
  });
});

describe('ResolveProjectDialog', () => {
  it('三つの解決と閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={['/w/alpha-moved']} onQueryCandidates={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByText('/w/alpha-moved'));
    fireEvent.click(screen.getByText('この場所にする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'repoint', path: '/w/alpha-moved' } });
    fireEvent.click(screen.getByText('アーカイブにする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } });
    fireEvent.click(screen.getByText('紐づけを削除'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } });
    fireEvent.click(screen.getByText('あとで'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ToastStack', () => {
  it('クリックで消す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ToastStack toasts={[{ id: '1', level: 'error', message: 'oops' }]} /></IntentRoot>);
    fireEvent.click(screen.getByText('oops'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'toast.dismiss', id: '1' });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/views/misc`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/views/SessionsScreen.tsx`：

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { SessionsProps } from '../presenters/sessions.ts';
import { SessionRows } from './SessionRows.tsx';

const DAY = 86_400_000;
const PERIODS = [{ v: '', label: 'すべて' }, { v: '1', label: '今日' }, { v: '7', label: '7 日' }, { v: '30', label: '30 日' }];

export function SessionsScreen(props: SessionsProps) {
  const emit = useEmit();
  const period = props.filter.since ? String(Math.round((Date.now() - props.filter.since) / DAY)) : '';
  return (
    <div className="screen">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input className="input" style={{ flex: 1 }} aria-label="キーワード" placeholder="キーワード（空なら全件）" defaultValue={props.text} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'search.query', text: (e.target as HTMLInputElement).value }); }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select className="select" aria-label="プロジェクト" value={props.filter.projectId ?? ''} onChange={(e) => emit({ type: 'search.filter', patch: { projectId: e.target.value || undefined } })}>
          <option value="">すべてのプロジェクト</option>{props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="select" aria-label="期間" value={PERIODS.some((p) => p.v === period) ? period : ''} onChange={(e) => emit({ type: 'search.filter', patch: { since: e.target.value ? Date.now() - Number(e.target.value) * DAY : undefined } })}>
          {PERIODS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
        </select>
        <select className="select" aria-label="実行中" value={props.filter.running === undefined ? '' : props.filter.running ? 'running' : 'ended'} onChange={(e) => emit({ type: 'search.filter', patch: { running: e.target.value === '' ? undefined : e.target.value === 'running' } })}>
          <option value="">実行中と終了</option><option value="running">実行中</option><option value="ended">終了</option>
        </select>
        <input className="input" aria-label="ファイル" placeholder="触ったファイル" defaultValue={props.filter.file ?? ''} onKeyDown={(e) => { if (e.key === 'Enter') emit({ type: 'search.filter', patch: { file: (e.target as HTMLInputElement).value || undefined } }); }} />
        <span className="spacer" />
        <span className="faint mono">{props.loading ? '検索しています' : `${props.total} 件`}</span>
      </div>
      <SessionRows rows={props.rows} height="calc(100vh - 180px)" showProject showSnippets={props.mode === 'search'} />
    </div>
  );
}
```

`packages/ui/src/views/SettingsScreen.tsx`：

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { SettingsProps } from '../presenters/settings.ts';

export function SettingsScreen(props: SettingsProps) {
  const emit = useEmit();
  const [ws, setWs] = useState(props.workspaceRoot);
  return (
    <div className="screen" style={{ maxWidth: 720 }}>
      <h1 className="h1">Settings</h1>
      <section>
        <h2 className="h2">ワークスペース</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" style={{ flex: 1 }} aria-label="ワークスペースのルート" value={ws} onChange={(e) => setWs(e.target.value)} />
          <button className="btn btn-primary" onClick={() => emit({ type: 'settings.update', patch: { workspaceRoot: ws } })}>保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>直下のディレクトリのうち、Claude のセッションがあるものをプロジェクトとして登録します。</div>
      </section>
      <section>
        <h2 className="h2">索引</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="mono muted">{props.index.phase === 'idle' ? `${props.sessionCount} セッション、${props.projectCount} プロジェクト` : `${props.index.phase} ${props.index.done} / ${props.index.total}`}</span>
          <button className="btn" onClick={() => emit({ type: 'index.rebuild' })}>索引を作り直す</button>
        </div>
        <div className="faint mono" style={{ marginTop: 4 }}>読み取り元 {props.claudeDir}</div>
      </section>
      <section>
        <h2 className="h2">この端末</h2>
        <div className="mono muted">{props.device?.name}<span className="faint"> {props.device?.id}</span></div>
        <div className="faint mono">agent-hangar {props.version}</div>
      </section>
      <section>
        <h2 className="h2">次のフェーズで追加される設定</h2>
        <div className="faint">ターミナルアプリ、VS Code のパス、MCP 登録、statusline への追記、要約器、クラウド同期。</div>
      </section>
    </div>
  );
}
```

`packages/ui/src/views/ResolveProjectDialog.tsx`：

```tsx
import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';

export function ResolveProjectDialog(props: { projectId: string; name: string; path: string | null; candidates: string[]; onQueryCandidates: (name: string) => void }) {
  const emit = useEmit();
  const [path, setPath] = useState('');
  const resolve = (action: { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' }) => emit({ type: 'project.resolve', id: props.projectId, action });
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="プロジェクトの場所を確認">
      <div className="dialog">
        <div><b>{props.name}</b> のディレクトリが見つかりません。</div>
        <div className="mono faint">{props.path ?? '（パスなし）'}</div>
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>ディレクトリを再指定</div>
          {props.candidates.length > 0 && <div className="list" style={{ marginBottom: 8 }}>{props.candidates.map((c) => <div key={c} className="row mono" style={{ gridTemplateColumns: '1fr' }} role="option" aria-selected={c === path} onClick={() => setPath(c)}>{c}</div>)}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" style={{ flex: 1 }} aria-label="新しいパス" value={path} onChange={(e) => { setPath(e.target.value); props.onQueryCandidates(e.target.value.split('/').pop() ?? ''); }} placeholder="/Users/you/workspace/..." />
            <button className="btn btn-primary" disabled={!path} onClick={() => resolve({ kind: 'repoint', path })}>この場所にする</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => resolve({ kind: 'archive' })}>アーカイブにする</button>
          <button className="btn" onClick={() => resolve({ kind: 'unlink' })}>紐づけを削除</button>
          <span className="spacer" />
          <button className="btn" onClick={() => emit({ type: 'overlay.close' })}>あとで</button>
        </div>
      </div>
    </div>
  );
}
```

`packages/ui/src/views/ToastStack.tsx`：

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { Toast } from '../mediator/types.ts';

export function ToastStack(props: { toasts: Toast[] }) {
  const emit = useEmit();
  return <div className="toasts">{props.toasts.map((t) => <div key={t.id} className="toast" data-level={t.level} role="status" onClick={() => emit({ type: 'toast.dismiss', id: t.id })}>{t.message}</div>)}</div>;
}
```

- [ ] **Step 4: テストと型検査**

Run: `npx vitest run packages/ui && npm run typecheck`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views
git commit -m "feat(ui): sessions search screen, settings, resolve dialog and toasts"
```

---

### Task 26: Root の結線、ブラウザでの起動確認

**Files:**
- Create: `packages/ui/src/Root.tsx`、`packages/ui/src/hooks/useRuntime.ts`
- Modify: `packages/ui/src/main.tsx`
- Test: `packages/ui/src/Root.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export function Root(props: { runtime: Runtime }): JSX.Element;
  export function useRuntime(rt: Runtime): { state: State; store: Store };   // useSyncExternalStore
  ```
- `Root` は次を行う。
  - `IntentRoot` に `runtime.emit` を渡す。
  - `screen` ごとに Presenter を呼んで Screen を描く。`booting` と `bootstrapped` が偽のときは「読み込んでいます」。
  - `now` は 30 秒ごとに更新する（相対時刻のため）。
  - Projects 画面の絞り込みとアーカイブ表示は `useState` で持つ。
  - `overlay.resolveProject` のときは `ResolveProjectDialog` を出し、候補は `api.candidates` を直接呼んで `useState` に入れる（この一箇所だけ、View ではなく Root が API を呼ぶ。Presenter に通す値ではなく、ダイアログの中だけで使う一時データだから）。
  - `toasts` は 5 秒後に `toast.dismiss` を出す。
  - キーボード：`/` で検索欄にフォーカス（入力中でなければ）、`⌘K` で `palette.open`（フェーズ 1 では `notYet` トースト）。
- `main.tsx` は `createRuntime` に本物の依存（`createApi()`、`createWs({ url: (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws' })`、`window.location.hash`、`localStorage`）を渡して `start()` し、`Root` を描く。

- [ ] **Step 1: 失敗するテストを書く**

`packages/ui/src/Root.test.tsx`：

```tsx
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, ServerEvent } from '@agent-hangar/shared';
import { Root } from './Root.tsx';
import { createRuntime, type RuntimeDeps } from './runtime/runtime.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c' }, projects: [{ id: 'p1', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: Date.now(), runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }], sessions: [], live: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1' };

function make() {
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  const deps: RuntimeDeps = {
    api: { bootstrap: async () => boot, events: async () => ({ sessionId: '', events: [], total: 0, nextSeq: null }), subagents: async () => [], search: async () => ({ hits: [], total: 0 }), setProjectStatus: async () => boot.projects[0]!, resolveProject: async () => ({}), candidates: async () => ['/w/alpha2'], updateSettings: async (p) => ({ ...boot.settings, ...p }), rebuildIndex: async () => {} },
    ws: (h) => { handlers.push(h); return { connect: () => {}, close: () => {} }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); } },
    storage: { get: () => undefined, set: () => {}, keys: () => [] },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  const rt = createRuntime(deps);
  return { rt, deps, handlers, setHash: deps.location.setHash };
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('Root', () => {
  it('起動から Home、Projects へ遷移、未解決ダイアログ', async () => {
    const { rt, deps, handlers, setHash } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} />);
    expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
    act(() => handlers[0]!.onOpen());
    await flush();
    expect(screen.getByText('プロジェクト')).toBeInTheDocument();
    act(() => setHash('#/projects'));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    act(() => rt.dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: 'p1' } }));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('/w/alpha2')).toBeInTheDocument();
  });
  it('トーストは出て、5 秒で消える', async () => {
    vi.useFakeTimers();
    const { rt, deps } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} />);
    act(() => rt.dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message: 'hello' } }));
    expect(screen.getByText('hello')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.queryByText('hello')).toBeNull();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/ui/src/Root`
Expected: FAIL

- [ ] **Step 3: 実装する**

`packages/ui/src/hooks/useRuntime.ts`：

```ts
import { useSyncExternalStore } from 'react';
import type { State } from '../mediator/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { Store } from '../store/store.ts';

export function useRuntime(rt: Runtime): { state: State; store: Store } {
  const state = useSyncExternalStore(rt.subscribe, rt.getState, rt.getState);
  const store = useSyncExternalStore(rt.subscribe, rt.getStore, rt.getStore);
  return { state, store };
}
```

`packages/ui/src/Root.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { useRuntime } from './hooks/useRuntime.ts';
import { IntentRoot } from './intent/chain.tsx';
import { presentHome } from './presenters/home.ts';
import { presentProject } from './presenters/project.ts';
import { presentProjects } from './presenters/projects.ts';
import { presentSession } from './presenters/session.ts';
import { presentSessions } from './presenters/sessions.ts';
import { presentSettings } from './presenters/settings.ts';
import { presentShell } from './presenters/shell.ts';
import { createApi, type ApiClient } from './runtime/api.ts';
import type { Runtime } from './runtime/runtime.ts';
import { HomeScreen } from './views/HomeScreen.tsx';
import { ProjectScreen } from './views/ProjectScreen.tsx';
import { ProjectsScreen } from './views/ProjectsScreen.tsx';
import { ResolveProjectDialog } from './views/ResolveProjectDialog.tsx';
import { SessionScreen } from './views/SessionScreen.tsx';
import { SessionsScreen } from './views/SessionsScreen.tsx';
import { SettingsScreen } from './views/SettingsScreen.tsx';
import { Shell } from './views/Shell.tsx';
import { ToastStack } from './views/ToastStack.tsx';

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function Root(props: { runtime: Runtime; api?: ApiClient }) {
  const rt = props.runtime;
  const { state, store } = useRuntime(rt);
  const now = useNow();
  const [projectFilter, setProjectFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);

  // トーストは 5 秒で消す。
  useEffect(() => {
    if (state.toasts.length === 0) return;
    const t = setTimeout(() => rt.emit({ type: 'toast.dismiss', id: state.toasts[0]!.id }), 5000);
    return () => clearTimeout(t);
  }, [state.toasts, rt]);

  // 未解決ダイアログの候補は Root が API を直接引く（ダイアログの中だけで使う一時データ）。
  const overlay = state.overlay;
  const unresolvedId = overlay.kind === 'resolveProject' ? overlay.projectId : null;
  const queryCandidates = (name: string) => { if (unresolvedId) (props.api ?? apiFromRuntime(rt)).candidates(unresolvedId, name).then(setCandidates).catch(() => setCandidates([])); };
  useEffect(() => { if (unresolvedId) queryCandidates(store.projects[unresolvedId]?.name ?? ''); else setCandidates([]); }, [unresolvedId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // キーボード：/ で検索、⌘K でパレット。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'SELECT';
      if (e.key === '/' && !typing) { e.preventDefault(); document.getElementById('global-search')?.focus(); }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); rt.emit({ type: 'palette.open' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt]);

  const shell = presentShell(state, store);
  let body: React.ReactNode;
  if (!store.bootstrapped || state.screen.name === 'booting') body = <div className="empty">読み込んでいます</div>;
  else switch (state.screen.name) {
    case 'home': body = <HomeScreen {...presentHome(state, store, now)} />; break;
    case 'projects': body = <ProjectsScreen {...presentProjects(state, store, now, projectFilter, showArchived)} filter={projectFilter} showArchived={showArchived} onFilter={setProjectFilter} onShowArchived={setShowArchived} />; break;
    case 'project': body = <ProjectScreen {...presentProject(state, store, now, state.screen.id)} />; break;
    case 'session': body = <SessionScreen {...presentSession(state, store, now, state.screen.id)} />; break;
    case 'sessions': body = <SessionsScreen {...presentSessions(state, store, now)} />; break;
    case 'settings': body = <SettingsScreen {...presentSettings(state, store)} />; break;
  }

  const overlays = (
    <>
      {unresolvedId && <ResolveProjectDialog projectId={unresolvedId} name={store.projects[unresolvedId]?.name ?? unresolvedId} path={store.projects[unresolvedId]?.path ?? null} candidates={candidates} onQueryCandidates={queryCandidates} />}
      {overlay.kind === 'palette' && <div className="overlay" onClick={() => rt.emit({ type: 'palette.close' })}><div className="dialog" onClick={(e) => e.stopPropagation()}><b>コマンドパレット</b><div className="faint">次のフェーズで使えるようになります。Esc か外側のクリックで閉じます。</div></div></div>}
      <ToastStack toasts={state.toasts} />
    </>
  );

  return <IntentRoot onIntent={rt.emit}><Shell {...shell} overlays={overlays}>{body}</Shell></IntentRoot>;
}

const apiCache = new WeakMap<Runtime, ApiClient>();
function apiFromRuntime(rt: Runtime): ApiClient {
  let a = apiCache.get(rt);
  if (!a) { a = createApi(); apiCache.set(rt, a); }
  return a;
}
```

`packages/ui/src/main.tsx`：

```tsx
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import { Root } from './Root.tsx';
import { createApi } from './runtime/api.ts';
import { createRuntime } from './runtime/runtime.ts';
import { createWs } from './runtime/ws.ts';

const api = createApi();
const runtime = createRuntime({
  api,
  ws: (h) => createWs({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, ...h }),
  location: { getHash: () => location.hash, setHash: (h) => { location.hash = h; }, onHashChange: (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); } },
  storage: {
    get: (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量超過などは無視 */ } },
    keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  focus: (t) => { if (t === 'search') document.getElementById('global-search')?.focus(); },
});
runtime.start();
createRoot(document.getElementById('root')!).render(<Root runtime={runtime} api={api} />);
```

- [ ] **Step 4: テスト、型検査、ビルド**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: 全パッケージ PASS、`packages/ui/dist` ができる

- [ ] **Step 5: 実物で起動し、ブラウザで確かめる**

Run: `HANGAR_HOME=/tmp/hangar-smoke npx tsx packages/server/src/main.ts &`（8 秒待つ）。次に `playwright` スキルのローカル Chrome で `http://127.0.0.1:4177/` を開き、Home、Projects、プロジェクト詳細、セッション詳細（実行中のこのセッションを含む）、Sessions で「動画」を検索、Settings の 6 画面のスクリーンショットを撮って `Read` で確認する。ダークは `document.documentElement.dataset.theme = 'dark'` で切り替えて 1 枚撮る。終わったらサーバを止め、`/tmp/hangar-smoke` を消す。
Expected: すべての画面が描かれ、実行中のセッションの状態点が busy か idle で動く。実物の `~/.claude` には何も書かれていない（`ls -la ~/.claude | head` の mtime が変わらない）。

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src
git commit -m "feat(ui): root wiring, runtime bootstrap and keyboard shortcuts"
```

---

### Task 27: 文書の更新と README

**Files:**
- Create: `README.md`
- Modify: `docs/design.md`（「決めた前提と未決事項」と「フェーズ」）

- [ ] **Step 1: README を書く**

`README.md`：

```markdown
# agent-hangar

Claude Code のセッションをプロジェクト単位で束ね、起動、観察、検索、記録を一箇所で行う個人用のローカルアプリです。
設計は `docs/design.md`、実装計画は `docs/plans/` にあります。

## 使い方（フェーズ 1）

```sh
npm install
npx hangar setup            # ~/.agent-hangar を作り、tmux と claude と code の有無を報告する
npm run dev                 # サーバ（4177）と UI（5173）を起動する
```

ブラウザで `http://127.0.0.1:5173/` を開きます。
本番ビルドは `npm run build` の後に `npx hangar start` で、`http://127.0.0.1:4177/` から UI を配信します。

hangar は `~/.claude/` を読むだけで、書き換えません。
索引は `~/.agent-hangar/hangar.db` に置きます。

## 開発

```sh
npm run typecheck
npm test
```
```

- [ ] **Step 2: 設計文書を更新する**

`docs/design.md` の「決めた前提と未決事項」の箇条書きに、この計画の「前提」節の 8 項目を加える。
「フェーズ」の「フェーズ 1」の行末に「（計画は `docs/plans/phase1-readonly.md`）」を足す。
「Claude Code Provider」の節に、`transcript.selectAgent` によるサブエージェント本文の切替と、`event_index` の一意制約（主線とサブエージェントで `seq` の空間を分ける）を 2 文で足す。

- [ ] **Step 3: コミット**

```bash
git add README.md docs/design.md
git commit -m "docs: readme and design updates for phase 1"
```

---

## 実行の順序と並列化

依存の無いタスクは並列に実装できる。
実装者を同時に走らせるときは、次の組を目安にする。

1. Task 1 → Task 2（shared）。
2. Task 3 → Task 4。並列に Task 5、Task 6（互いに独立）。
3. Task 7（フィクスチャ）→ Task 8 → Task 9。並列に Task 10、Task 11（Task 7 に依存）。
4. Task 12 → Task 13、Task 14（並列）→ Task 15 → Task 16。
5. Task 17 → Task 18 → Task 19 → Task 20。並列に Task 21（Task 18 と 19 に依存）。
6. Task 22 → Task 23、Task 24、Task 25（並列）→ Task 26 → Task 27。

## 自己点検（計画の作成時に確認したこと）

- 設計文書のフェーズ 1 の範囲（サーバ、インデクサ、読み取り専用の UI、Projects、セッション一覧、トランスクリプト、Sessions と検索、土台の要約）に対応するタスクがある。プロジェクトの同定（自動登録、未解決ダイアログ）は Task 10 と 25、実行中の状態は Task 11、Intent チェーンと Mediator と Presenter は Task 18 から 21。
- 設計文書の Intent 一覧に無い `transcript.*`、`index.rebuild`、`overlay.close`、`toast.dismiss` を足した。Task 27 で設計文書に反映する。
- 型の名前が後のタスクで一致していること：`SessionRowProps` は `presenters/row.ts` に置き、`home.ts` と `project.ts` と `sessions.ts` がそこから import する（Task 21 の Files に `row.ts` を含めて読むこと）。
- `searchSessions` の第三引数 `runningIds` は Task 13 で定義し、Task 15 の `/api/search` が渡す。
- 実物の `~/.claude` に書き込むタスクは無い。テストはすべてフィクスチャの複製か一時ディレクトリで行う。
