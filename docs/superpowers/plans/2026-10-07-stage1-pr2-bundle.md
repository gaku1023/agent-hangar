# 段 1 PR 2 同梱の重複をなくす Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 配布版の `cli.mjs` がサーバ全体を抱えるのをやめ、同梱の `cloud/` を Worker の源の写しから 1 本に束ねた Worker とその束縛の定義に替え、殻がサーバへ渡している使われない `HANGAR_CLOUD_DIR` と予備の置き場 `_up_/server-dist` を消す。

**Architecture:** CLI は、サーバの入口 `index.ts` ではなく、サーバ本体（`server.ts`）をたどらない軽い入口 `packages/server/src/cliEntry.ts` から名前を取る。
CLI の中でサーバ本体を使っていた唯一のコマンド `hangar start` は、`.app` の殻と同じく、サーバを子プロセスとして起こす形に替える（配布版は `cli.mjs` の隣の `server.mjs`、リポジトリでは tsx で `main.ts`）。
Worker の束ね方は `packages/cloud/scripts/build-worker.ts` の 1 か所に置き、試験の miniflare と `bundle-server` が同じ関数を通す。
同梱するのは `cloud/worker.mjs` と `cloud/metadata.json` だけで、PR 2 では置くところまでとし、読むのは段 5 である。

**Tech Stack:** TypeScript、esbuild、miniflare、commander、vitest、Rust（Tauri v2）、cargo test。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md`（「消すもの」の「同梱の重複」、「残す境界」、「PR の割り方」の PR 2 の行）。
全体の位置づけは `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md`（段 1 の最後の項目と、段 5 の「クラウドの準備を REST API で行う」）。

## `hangar start` をどうするか

`hangar start` は、同梱の CLI から外さず、同梱の `server.mjs` を子プロセスで起こす形に替える。
根拠は次の 4 つである。

1. 配布版の `hangar start` は、利用者に案内している道である。
   README は `/usr/local/bin/hangar` へのリンクを張らせ、「配布版だけを入れた人は `npm run hangar --` を `hangar` に読み替えてください」と書き、2 台目の手順で `npm run hangar -- start` を使わせている。
   README の「実物の `.app` で確かめた範囲」には「先に `hangar start` で立てておいたサーバの採用」があり、design.md の「二重起動」も `hangar start` で先に起きているサーバを前提にしている。
   外すと、spec の「消すもの」に無い、利用者に見える引き算になる。
   `hangar` を url、open、status だけに絞るのは、全体計画の段 5 の決定である。
2. 子を起こす相手は必ず隣にある。
   `bundle-server` は `server.mjs` と `cli.mjs` を同じ置き場へ 1 度に出し、`.github/workflows/release.yml` の 56 行目は、その `bundle-server` を `beforeBuildCommand` として通した `server-dist` だけから `.app` を作る。
   `bin/hangar` は `/usr/local/bin/hangar` のリンクを実体まで辿ってから `"$dist/cli.mjs"` を起こすので、`cli.mjs` の `import.meta.url` は同梱の置き場を指し、隣の `server.mjs` が見つかる。
   `bin/hangar` が渡す `HANGAR_UI_DIST` は、子のサーバがそのまま継ぐ。
   release.yml は、ビルドの前に macOS の Apple silicon で `npm test` を回すので、配布版の `hangar start` の試験はリリースの関門にもなる。
3. 起こし方が `.app` と同じになる。
   殻（`server.rs` の `spawn_server`）は `node server.mjs` に `HANGAR_PORT` と `HANGAR_PARENT_PID` を渡して起こしている。
   CLI も同じ 2 つを渡すので、配布物の中でサーバの起こし方は 1 通りになり、CLI が強制終了されても子は `main.ts` の親の見張りで自分から降りる。
4. 外す案は、かえって分岐を増やす。
   同梱の CLI からだけ外すには、CLI の束の入口を開発用（`start` あり）と配布用（`start` なし）の 2 本に分け、`serverDownMessage` と `hangar cloud status` の「`hangar start` で起動」の文も出し分けることになる。
   全体計画が段 5 で減らしたい「開発と配布の食い違い」を、ここで 1 つ増やすことになる。

代わりに払うものは、リポジトリで `npm run hangar -- start` を打ったときに tsx の起動が 1 回増えることである。
段 5 で `start` を消すときは、`start.ts` を消すだけで済む。

## 軽い入口を 1 つ置く理由

依頼は「サーバの入口を経由せず、深いパスから import する」である。
CLI の 6 つのファイルが、それぞれ `config/paths.ts` や `sync/client.ts` を直に指す形も取れる。
ただし `packages/server/src/index.test.ts` には「CLI はこのパッケージの内側へ deep import せず、ここから取る」という決めごとが書かれていて、CLI が使う名前の一覧を検査として持っている。
段 2 でサーバの中の置き場は大きく動くので、CLI がサーバの内側の並びを 9 か所で知っていると、そのたびに CLI が壊れる。
そこで、`index.ts` の輸出のうち `server.ts` から来る 4 つ以外を `cliEntry.ts` へ移し、CLI はその 1 ファイルを深いパス `@agent-hangar/server/src/cliEntry.ts` で指す。
`index.ts` は `server.ts` の 4 つと `export * from './cliEntry.ts'` だけになり、試験と既存の名前はそのまま通る。
2026-10-07 に試しに束ねると、`cliEntry.ts` から届くサーバのコードは約 60KB、`cli.mjs` 全体は約 240KB だった（いまは約 2.3MB で、`server.mjs` は約 2.1MB）。

## Global Constraints

- 公開リポジトリである。実在の人名、メール、手元のパス、使用量や費用の実数を、コード、試験、コメント、コミット、文書に書かない。
- 作業の前に、作業ツリーの根で `npm ci` を打つ。作業ツリーに `node_modules` が無いと、Node の解決が親の checkout の `node_modules` を拾い、`@agent-hangar/*` が別の版のソースを指す。
- 試験は vitest で、リポジトリの根で `npx vitest run <ファイル>` と打つ。型は `npm run typecheck`。
- Rust は `apps/desktop/src-tauri` の `cargo test` で試す。Homebrew の cargo を PATH の先頭に置く（`PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" cargo …`）。古い cargo だと落ちる。
- Rust の変更は `cargo fmt --check` と `cargo clippy --all-targets -- -D warnings` を通す。CI の desktop ジョブがこの 2 つを見る。
- 同梱の CLI は、better-sqlite3 とネイティブモジュールと `manifest.json` を持ったままにする（spec「残す境界」。CLI の `stampTranscriptsFrom` と `readTranscriptsFrom` が DB を開く）。
- CLI の `HANGAR_CLOUD_DIR` は、開発用の上書きとして残す。
- 同梱の `cloud/` は置くだけにする。読む道、デプロイする道は作らない（段 5）。
- 実物の Cloudflare に触らない。Worker の確かめは miniflare で行う。
- 試験でサーバを起こすときは、存在する一時ディレクトリを `TMUX_TMPDIR` に渡す。無い場所を渡すと、tmux は黙って本物のサーバへつなぐ。`tmux kill-server` は呼ばない。
- コメントは日本語で、周りと同じ密度にする。
- 文書（design.md、README.md）は日本語で一文一行にし、中黒と em ダッシュを使わない。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- 行番号は main `b408223` を読み直した値である。編集の前に、書かれた文字列で場所を確かめる。

## Review Focus

- **`hangar start` を止める信号（端末の Ctrl-C、`kill`）**：子のサーバも降り、ポートを掴んだまま残らない。Task 1 の開発の試験（SIGTERM）と配布版の試験（SIGINT）で留める。
- **`/usr/local/bin/hangar` のリンク越しに、配布版の `hangar start` を打つ**：隣の `server.mjs` を見つけ、同梱の UI を鍵付きの URL で配る。Task 1 の配布版の試験で留める。
- **子のサーバが起動の途中で終わる（壊れた設定、DB の失敗、待ち受けの取り合い）**：CLI は待ち続けず、URL も鍵も出さずに 0 以外で終わる。Task 1 の `runStart` の試験で留める。
- **配布版の `hangar setup cloud`**：wrangler を探す前に、clone した場所から実行するよう案内して止まり、`cloud.json` も作らない。Task 5 の配布版の試験で留める。
- **`packages/cloud/wrangler.jsonc` に束縛の種類や vars が足される**：同梱の `metadata.json` が黙って落とさず、束ねる段で止まる。Task 3 の試験で留める。

---

### Task 1: `hangar start` を子プロセスにする

**Files:**
- Create: `packages/cli/src/start.ts`
- Create: `packages/cli/src/start.test.ts`
- Modify: `packages/cli/src/probe.ts`（`probeHealth` の直後、44 行の後ろに関数を 1 つ足す）
- Modify: `packages/cli/src/probe.test.ts:4`、`describe('probeAuthorized'…)` の直前
- Modify: `packages/cli/src/index.ts:2`、`:5`、`:106-130`
- Modify: `packages/cli/src/index.test.ts:1-9`、`:166-177`
- Modify: `apps/desktop/test/bundle-server.test.ts:1-7`、`:30` の後ろ、`:156` の後ろ
- Modify: `docs/design.md:71`、`:947-948`

**Interfaces:**
- Produces: `probeReady(port: number, timeoutMs?: number): Promise<boolean>`（`probe.ts`）。`/health` が 200 で `ok === true` かつ `ready !== false` のとき真。
- Produces: `serverArgs(here?: string): string[]`（`start.ts`）。子の node に渡す引数。
- Produces: `assertPortFree(port: number): Promise<void>`（`start.ts`）。開けなければ Node の errno の例外を投げる。
- Produces: `type StartOptions = { port: number; onReady: () => void; args?: string[] }` と `runStart(o: StartOptions): Promise<number>`（`start.ts`）。返り値は CLI の終了コード。
- Produces: `index.ts` は `startServer` と `installShutdown` を import しなくなる。Task 2 はこれを前提にする。

- [ ] **Step 1: `probeReady` の試験を書く**

`packages/cli/src/probe.test.ts` の 4 行目の import に `probeReady` を足す。

```ts
import { oneLineError, probeAuthorized, probeHealth, probeReady, serverDownMessage, startErrorMessage } from './probe.ts';
```

`describe('probeAuthorized', …)` の直前に足す。

```ts
describe('probeReady', () => {
  it('ok が真で ready が偽でなければ真。ready が偽、ok が無い、200 でない、JSON でない、誰も居ないときは偽', async () => {
    const cases: [body: string, status: number, want: boolean][] = [
      ['{"ok":true,"ready":true}', 200, true],
      // ready を持たない古いサーバは待たない。.app の boot_state と同じ扱いである。
      ['{"ok":true}', 200, true],
      ['{"ok":true,"ready":false}', 200, false],
      ['{"ready":true}', 200, false],
      ['{"ok":true,"ready":true}', 500, false],
      ['not json', 200, false],
    ];
    for (const [body, status, want] of cases) {
      const { port } = await listen(() => ({ status, body }));
      expect(await probeReady(port), `${status} ${body}`).toBe(want);
    }
    expect(await probeReady(await deadPort(), 500)).toBe(false);
  });
});
```

- [ ] **Step 2: `start.ts` の試験を書く**

`packages/cli/src/start.test.ts` を作る。

```ts
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPortFree, runStart, serverArgs } from './start.ts';

const temps: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise((r) => s.close(r));
  }
  vi.restoreAllMocks();
});

const tempDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-start-'));
  temps.push(d);
  return d;
};

/** 自分で待ち受けたままにするポート。閉じるのは afterEach だけである。 */
async function busyPort(): Promise<number> {
  const s = createServer();
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

/** 誰も待ち受けていないポートを 1 つ取る。 */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

const errors = (spy: { mock: { calls: unknown[][] } }): string => spy.mock.calls.flat().join('\n');

describe('serverArgs', () => {
  it('隣に server.mjs があれば（配布版）、それだけを起こす', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'server.mjs'), '');
    expect(serverArgs(dir)).toEqual([path.join(dir, 'server.mjs')]);
  });

  it('隣に無ければ（リポジトリ）、packages/server の main.ts を tsx で起こす', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const args = serverArgs(here);
    expect(args.slice(0, 2)).toEqual(['--import', 'tsx']);
    expect(args[2]).toBe(path.resolve(here, '../../server/src/main.ts'));
    expect(fs.existsSync(args[2]!)).toBe(true);
  });
});

describe('assertPortFree', () => {
  it('空いていれば通り、使われていれば EADDRINUSE で断る', async () => {
    await expect(assertPortFree(await deadPort())).resolves.toBeUndefined();
    await expect(assertPortFree(await busyPort())).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('runStart', () => {
  it('ポートが使われていれば、子を起こさずに日本語の 1 行を出して 1 を返す', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    const marker = path.join(tempDir(), 'spawned');
    const code = await runStart({ port: await busyPort(), onReady, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`] });
    expect(code).toBe(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
    expect(errors(err)).toContain('は既に使われています');
  });

  it('ポートが 1 から 65535 の整数でなければ、子を起こさずに断る。0 で起こすと、子の選んだポートを知る手が無く待ち続けてしまう', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(await runStart({ port, onReady, args: ['-e', 'setTimeout(() => {}, 60000)'] }), String(port)).toBe(1);
    }
    expect(onReady).not.toHaveBeenCalled();
    expect(errors(err)).toContain('1 から 65535');
  });

  it('子が起動の途中で終われば、onReady を呼ばずに子の終了コードを返す', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    const code = await runStart({ port: await deadPort(), onReady, args: ['-e', 'process.exit(3)'] });
    expect(code).toBe(3);
    expect(onReady).not.toHaveBeenCalled();
    expect(errors(err)).toContain('起動の途中で終わりました');
  });

  it('子に HANGAR_PORT と HANGAR_PARENT_PID を渡し、/health が ready を返したら onReady を 1 度だけ呼び、子が終わるまで待つ', async () => {
    const port = await deadPort();
    // サーバの代わりの小さな子。親の PID を受け取れていなければ 4 で終わる。
    // 渡されたポートで ready を返し、少ししてから 0 で終わる。
    const script = [
      "if (process.env.HANGAR_PARENT_PID !== String(process.ppid)) process.exit(4);",
      "const s = require('node:http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }).end('{\"ok\":true,\"ready\":true}'); });",
      "s.listen(Number(process.env.HANGAR_PORT), '127.0.0.1', () => setTimeout(() => process.exit(0), 800));",
    ].join('\n');
    const onReady = vi.fn();
    const code = await runStart({ port, onReady, args: ['-e', script] });
    expect(code).toBe(0);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: CLI 全体で `hangar start` を通す試験を書く**

`packages/cli/src/index.test.ts` の 9 行目（`posixIt` の import）の下に足す。

```ts
import { probeHealth } from './probe.ts';
```

`describe('hangar start', …)` の中、既存の `it` の後ろに足す。

```ts
  // 子を SIGTERM で止める。Windows の信号の扱いは移植の区切りで作る。
  posixIt('子のサーバを起こし、起動が済んでから鍵付きの URL を出し、SIGTERM で子も降りる', async () => {
    const port = await deadPort();
    const root = path.dirname(home);
    const ws = path.join(root, 'ws');
    const tmuxDir = path.join(root, 'tmux');
    fs.mkdirSync(ws);
    fs.mkdirSync(tmuxDir);
    fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    // hangar の中から試験を走らせたときに、外のサーバ向けの値を子へ持ち込まない。
    const { HANGAR_PARENT_PID: _pid, HANGAR_UI_DIST: _ui, HANGAR_PORT: _port, ...base } = process.env;
    const child = spawn(process.execPath, [CLI, 'start', '--port', String(port), '--no-open'], {
      env: {
        ...base,
        HOME: root,
        HANGAR_HOME: home,
        HANGAR_CLAUDE_DIR: claudeDir,
        HANGAR_TEST_MARKER: marker,
        // 存在する場所を渡す。無い場所だと tmux は黙って本物のサーバへつなぐ。
        TMUX_TMPDIR: tmuxDir,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    try {
      const until = Date.now() + 60_000;
      while (!out.includes('?t=') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain(`この URL から開いてください: http://127.0.0.1:${port}/?t=${readToken()}`);
      // URL を出した時点で、サーバは起動を済ませている。
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { ok: boolean; ready: boolean };
      expect(health).toMatchObject({ ok: true, ready: true });
      expect(await waitOpened(400)).toBe('');
    } finally {
      child.kill('SIGTERM');
    }
    expect(await closed).toBe(0);
    // 子のサーバも降りていて、ポートを掴んだまま残らない。
    expect(await probeHealth(port, 500)).toBe(false);
  }, 90_000);
```

- [ ] **Step 4: 配布版の `bin/hangar start` の試験を書く**

`apps/desktop/test/bundle-server.test.ts` の import に `net` を足す（1 行目の `node:child_process` の下）。

```ts
import net from 'node:net';
```

`dirSize` の定義（23-30 行）の後ろに足す。

```ts
/** 誰も待ち受けていないポートを 1 つ取る。 */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}
```

`describe.skipIf(!onAppleSilicon)('bundleServer', …)` の中、2 つめの `it`（「bin/hangar が同梱の Node で cli.mjs を動かし…」、156 行で閉じる）の後ろに足す。

```ts
  it('bin/hangar start がリンク越しでも隣の server.mjs を子で起こし、同梱の UI を配り、SIGINT で子も降りる', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    const claude = tmp('hangar-claude-');
    const ws = tmp('hangar-ws-');
    const link = tmp('hangar link-');
    const tmuxDir = tmp('hangar-tmux-');
    dirs.push(out, ui, home, claude, ws, link, tmuxDir);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    fs.mkdirSync(path.join(claude, 'projects'));
    fs.mkdirSync(path.join(claude, 'sessions'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir: claude }));
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    // README が案内する /usr/local/bin/hangar と同じ形のリンク越しに起こす。
    fs.symlinkSync(path.join(out, 'bin/hangar'), path.join(link, 'hangar'));
    const port = await freePort();
    const { HANGAR_PARENT_PID: _pid, HANGAR_UI_DIST: _ui, HANGAR_PORT: _port, HANGAR_CLOUD_DIR: _cloud, ...base } = process.env;
    const child = spawn(path.join(link, 'hangar'), ['start', '--port', String(port), '--no-open'], {
      env: { ...base, HANGAR_HOME: home, HANGAR_NODE: process.execPath, HANGAR_CLAUDE_DIR: claude, TMUX_TMPDIR: tmuxDir },
    });
    let text = '';
    child.stdout.on('data', (b: Buffer) => { text += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { text += b.toString(); });
    const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    try {
      const until = Date.now() + 30_000;
      while (!text.includes('?t=') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
      expect(text).toContain(`http://127.0.0.1:${port}/?t=${token}`);
      // bin/hangar が渡した HANGAR_UI_DIST を子のサーバが継いでいる。
      const html = await (await fetch(`http://127.0.0.1:${port}/?t=${token}`)).text();
      expect(html).toContain('bundled-ui');
    } finally {
      // bin/hangar は exec で node に替わるので、この PID は cli.mjs の node である。
      child.kill('SIGINT');
    }
    expect(await closed).toBe(0);
    expect(await waitHealth(`http://127.0.0.1:${port}/health`, 500)).toBe(false);
  });
```

- [ ] **Step 5: 試験が落ちるのを見る**

Run: `npx vitest run packages/cli/src/probe.test.ts packages/cli/src/start.test.ts`
Expected: FAIL。`probeReady` が `probe.ts` に無く、`./start.ts` を解決できない。

Run: `npx vitest run packages/cli/src/index.test.ts -t 'hangar start'`
Expected: PASS。
いまの `start` はサーバを同じプロセスで起こすが、URL の出し方と信号で降りることは同じなので、この 2 つは今も満たす。
Step 7 で子プロセスに替えた後も保つべき振る舞いの基準である。

Run: `npx vitest run apps/desktop/test/bundle-server.test.ts -t 'bin/hangar start'`
Expected: Apple silicon で PASS。理由は上と同じで、Step 7 の後も保つべき基準である。

- [ ] **Step 6: `probeReady` を足す**

`packages/cli/src/probe.ts` の `probeHealth`（36-44 行）の後ろに足す。

```ts
/**
 * そのポートの hangar が起動を済ませたか。
 * `/health` は待ち受けた時点で 200 を返し、索引などの起動の残りが済むと `ready` が真になる。
 * `ready` を持たない応答は、済んだものとみなす（.app の health.rs の boot_state と同じ扱い）。
 */
export async function probeReady(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      await drain(r);
      return false;
    }
    const body = (await r.json()) as { ok?: unknown; ready?: unknown };
    return body.ok === true && body.ready !== false;
  } catch {
    return false;
  }
}
```

- [ ] **Step 7: `start.ts` を書き、`index.ts` の `start` を差し替える**

`packages/cli/src/start.ts` を作る。

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLineError, probeReady, startErrorMessage } from './probe.ts';

/**
 * この CLI のファイルの置き場。
 * 配布版では esbuild が CLI を cli.mjs 1 本にまとめるので、ここは cli.mjs の置き場になる。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 起動が済んだかを見に行く間隔。 */
const READY_POLL_MS = 200;

/**
 * サーバを起こす node の引数。
 * 配布版は cli.mjs の隣の server.mjs を起こす。bundle-server が 2 つを同じ置き場へ出すので、隣に必ずある。
 * リポジトリでは packages/server/src/main.ts を tsx で起こす（bin/hangar.mjs が CLI を起こすのと同じ形）。
 * CLI がサーバのコードを import しないのは、cli.mjs にサーバを二重に束ねないためである。
 */
export function serverArgs(here: string = HERE): string[] {
  const bundled = path.join(here, 'server.mjs');
  if (fs.existsSync(bundled)) return [bundled];
  return ['--import', 'tsx', path.resolve(here, '../../server/src/main.ts')];
}

/**
 * そのポートを自分で一度だけ開いて閉じる。
 * 開けなければ、その失敗（EADDRINUSE など）をそのまま投げる。
 * サーバは子プロセスなので、子が待ち受けに転ぶと端末に出るのは子の生のスタックになる。
 * よくある失敗は、子を起こす前にここで拾って日本語の 1 行にする。
 */
export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
  });
}

export type StartOptions = {
  port: number;
  /** 起動が済んだときに 1 度だけ呼ぶ。鍵付きの URL の印字とブラウザを開くことは呼び手が持つ。 */
  onReady: () => void;
  /** 子の node に渡す引数。試験が差し替える。既定は serverArgs()。 */
  args?: string[];
};

/**
 * サーバを子プロセスで起こし、起動が済んだら onReady を呼ぶ。
 * 子が終わるまで戻らず、CLI の終了コードにする数を返す。
 * .app の殻（server.rs の spawn_server）と同じく、HANGAR_PORT と HANGAR_PARENT_PID を渡す。
 * HANGAR_PARENT_PID があるので、CLI が強制終了されても、子は main.ts の見張りで自分から降りる。
 */
export async function runStart(o: StartOptions): Promise<number> {
  // 0 を渡すと子は空いているポートを自分で選ぶが、CLI はその番号を知る手が無く、起動を待ち続けてしまう。
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    console.error('ポートは 1 から 65535 の整数で指定してください。');
    return 1;
  }
  try {
    await assertPortFree(o.port);
  } catch (e) {
    console.error(startErrorMessage(e, o.port));
    return 1;
  }
  const child = spawn(process.execPath, o.args ?? serverArgs(), {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, HANGAR_PORT: String(o.port), HANGAR_PARENT_PID: String(process.pid) },
  });
  let gone = false;
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      gone = true;
      resolve(code ?? 1);
    });
    child.on('error', (e) => {
      gone = true;
      console.error(`サーバを起動できませんでした: ${oneLineError(e)}`);
      resolve(1);
    });
  });
  // 端末の Ctrl-C は process group に届くので子にも直に届くが、kill で CLI だけに送られた信号は子へ渡す。
  // サーバの installShutdown は 2 度目の信号を無視するので、重なっても構わない。
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => [sig, (): void => { if (!gone) child.kill(sig); }] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    let ready = false;
    while (!gone && !ready) {
      ready = await probeReady(o.port);
      if (!ready) await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (ready) o.onReady();
    else console.error('サーバが起動の途中で終わりました。上に出た子のログを見てください。');
    return await exited;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}
```

`packages/cli/src/index.ts` を直す。
2 行目から `installShutdown` と `startServer` を外す。

```ts
import { claudeJsonPath, defaultClaudeDir, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken } from '@agent-hangar/server';
```

5 行目から `startErrorMessage` を外す。

```ts
import { oneLineError, probeHealth, serverDownMessage } from './probe.ts';
```

`./shell.ts` の import（7 行目）と `./statusline.ts` の import（8 行目）の間に、`start.ts` の import を足す。

```ts
import { runStart } from './start.ts';
```

106-130 行の `program.command('start')…` を、次に置き換える。

```ts
program
  .command('start')
  .description('サーバを起動する')
  .option('--port <n>', 'ポート', '4177')
  .option('--no-open', 'ブラウザを開かない')
  .action(async (o: { port: string; open: boolean }) => {
    const port = Number(o.port);
    // サーバは子プロセスで起こす（start.ts）。CLI がサーバのコードを import すると、cli.mjs にサーバが二重に入る。
    process.exitCode = await runStart({
      port,
      onReady: () => {
        // 鍵は端末にだけ印字する。サーバのログには載せない。見直したくなったら hangar url で出せる。
        const url = entryUrl(port, readOrCreateToken(hangarHome()));
        console.log('');
        console.log(`この URL から開いてください: ${url}`);
        console.log('鍵はページを開いた時点でクッキーに変わり、URL からは消えます。以後はブックマークから開けます。');
        console.log('この URL を出し直すには hangar url を実行してください。');
        if (o.open) openInBrowser(url);
      },
    });
  });
```

- [ ] **Step 8: 試験が通るのを見る**

Run: `npx vitest run packages/cli/src/probe.test.ts packages/cli/src/start.test.ts packages/cli/src/index.test.ts`
Expected: PASS（既存の「使われているポートでは、生のスタックではなく日本語の 1 行を出す」も含む）。

Run: `npx vitest run apps/desktop/test/bundle-server.test.ts`
Expected: Apple silicon では PASS、それ以外では Apple silicon の describe が skip。

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 9: design.md を直す**

`docs/design.md` の 71 行「Tauri のシェルは、起動時にサーバの子プロセスを立て、終了時に止める。」の直後に、次の 3 行を足す。

```markdown
`hangar start` も、サーバを子プロセスとして立てる。
配布版は `cli.mjs` の隣の `server.mjs` を、リポジトリでは `packages/server/src/main.ts` を tsx で起こし、`HANGAR_PORT` と `HANGAR_PARENT_PID` を渡す。
`/health` の `ready` が真になってから、鍵付きの URL を印字する。
```

947-948 行（「`hangar start` が待ち受けに失敗したときは…」「使用中のポート、権限の無いポート…」）の直後に、次の 1 行を足す。

```markdown
サーバは子プロセスなので、`hangar start` は子を起こす前にそのポートを自分で一度開いて確かめ、失敗をこの 1 行にする。
```

- [ ] **Step 10: コミットする**

```bash
git add packages/cli/src/start.ts packages/cli/src/start.test.ts packages/cli/src/probe.ts packages/cli/src/probe.test.ts packages/cli/src/index.ts packages/cli/src/index.test.ts apps/desktop/test/bundle-server.test.ts docs/design.md
```

```bash
git commit -m "feat(cli): run hangar start's server as a child process" -m "The CLI no longer imports startServer. It spawns the sibling server.mjs (bundled) or main.ts via tsx (repository), passes HANGAR_PORT and HANGAR_PARENT_PID like the desktop shell, waits for /health ready, then prints the keyed URL." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: CLI の入口を分けて、cli.mjs からサーバ本体を外す

**Files:**
- Create: `packages/server/src/cliEntry.ts`
- Modify: `packages/server/src/index.ts`（全体）
- Modify: `packages/server/src/index.test.ts`（全体）
- Modify: `packages/cli/src/index.ts:2`、`packages/cli/src/cloud.ts:9`、`packages/cli/src/mcp.ts:3`、`packages/cli/src/setup.ts:6`、`packages/cli/src/shell.ts:13`、`packages/cli/src/statusline.ts:13`
- Modify: `apps/desktop/scripts/bundle-server.ts:8-13`
- Modify: `apps/desktop/test/bundle-server.test.ts`（Apple silicon の describe に `it` を 1 つ足す）
- Modify: `docs/design.md:77`

**Interfaces:**
- Consumes: Task 1 で `packages/cli/src/index.ts` が `startServer` と `installShutdown` を import しなくなっていること。
- Produces: `packages/server/src/cliEntry.ts`。いまの `index.ts` の輸出のうち、`server.ts` から来る `installShutdown`、`startServer`、`STOP_WATCHDOG_MS`、`VERSION` を除いたすべて（型も含む）。
- Produces: CLI の試験でないファイルは、`@agent-hangar/server` ではなく `@agent-hangar/server/src/cliEntry.ts` から取る。CLI の試験（`cloud.test.ts`、`shell.test.ts`、`statusline.test.ts`）は束ねないので、`@agent-hangar/server` のままでよい。

- [ ] **Step 1: cli.mjs の試験を書く**

`apps/desktop/test/bundle-server.test.ts` の `describe.skipIf(!onAppleSilicon)('bundleServer', …)` の中、Task 1 で足した `it` の後ろに足す。

```ts
  it('cli.mjs はサーバ本体を抱えない。外に残す import は better-sqlite3 だけで、大きさは 512KB に満たない', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    dirs.push(out, ui);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    const cli = fs.readFileSync(path.join(out, 'cli.mjs'), 'utf8');
    const bare = [...new Set([...cli.matchAll(/^import[^\n]* from "([^"]+)";$/gm)].map((m) => m[1]!))].filter((sp) => !sp.startsWith('node:'));
    // CLI が DB を開くのは本文の床（stampTranscriptsFrom、readTranscriptsFrom）のためで、端末（node-pty）は使わない。
    expect(bare).toEqual(['better-sqlite3']);
    // サーバにしか無い関数。CLI がサーバの入口から import すると、esbuild がこれらを束ねてしまう。
    expect(cli).not.toContain('function startServer(');
    expect(cli).not.toContain('function createApp(');
    // 2026-10-07 の試しでは約 240KB だった。サーバを抱えると 2MB を超える。
    expect(fs.statSync(path.join(out, 'cli.mjs')).size).toBeLessThan(512 * 1024);
  });
```

`packages/server/src/index.test.ts` を、次の内容で置き換える。

```ts
import { describe, expect, it } from 'vitest';
import * as cli from './cliEntry.ts';
import * as api from './index.ts';

/**
 * CLI は、このパッケージの内側を個々にたどらず、cliEntry.ts から取る。
 * index.ts は server.ts（HTTP、MCP、tmux、node-pty）まで抱えるので、CLI がそこから取ると cli.mjs にサーバが二重に入る。
 * 名前が消えると CLI の hangar cloud teardown が「R2 にしか無い本文を降ろす」経路ごと落ちるので、輸出の一覧を検査として置いておく。
 */
describe('パッケージの入口', () => {
  it('CLI の入口が、CLI の使う名前を出している', () => {
    for (const name of ['HttpCloudClient', 'deriveFileKey', 'decryptStream', 'sha256Stream', 'remoteTranscriptPath', 'stampTranscriptsFrom', 'readTranscriptsFrom', 'upsertUserMcpServer', 'statuslineStatus', 'installShellHook'] as const) {
      expect(cli[name], name).toBeTypeOf('function');
    }
  });
  it('CLI の入口は、サーバ本体を出さない', () => {
    for (const name of ['startServer', 'installShutdown', 'STOP_WATCHDOG_MS', 'VERSION']) {
      expect(name in cli, name).toBe(false);
    }
  });
  it('これまでの名前を落としていない', () => {
    for (const name of ['startServer', 'VERSION', 'hangarHome', 'defaultClaudeDir', 'ensureHome', 'readOrCreateToken', 'readOrCreateDevice', 'loadSettings', 'saveSettings', 'STATUSLINE_MARKER', 'appendStatuslineSnippet', 'ensureStatuslineHeaderFile', 'resolveStatuslineScript', 'statuslineHeaderPath', 'statuslineSnippet', 'statuslineSnippetUpToDate', 'statuslineStatus', 'writeStatuslineHeaderFile', 'claudeJsonPath', 'upsertUserMcpServer', 'backupsRoot', 'cloudConfigPath', 'loadCloudConfig', 'readCloudConfig', 'remoteRoot', 'saveCloudConfig', 'SyncStateStore', 'backfillTranscripts', 'readTranscriptsFrom', 'stampTranscriptsFrom', 'onSharedWrite'] as const) {
      expect(api[name], name).toBeDefined();
    }
  });
  it('暗号の対も出している', () => {
    for (const name of ['CloudError', 'goneFloor', 'CHUNK_SIZE', 'encryptStream', 'encryptBuffer', 'decryptBuffer', 'sha256Hex', 'DEFAULT_TIMEOUT_MS', 'DEFAULT_TRANSFER_TIMEOUT_MS'] as const) {
      expect(api[name], name).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: 試験が落ちるのを見る**

Run: `npx vitest run packages/server/src/index.test.ts`
Expected: FAIL。`./cliEntry.ts` を解決できない。

Run: `npx vitest run apps/desktop/test/bundle-server.test.ts -t 'cli.mjs はサーバ本体を抱えない'`
Expected: Apple silicon で FAIL。`bare` が `['better-sqlite3', 'node-pty']` になり、`function startServer(` を含み、大きさが約 2.3MB である。

- [ ] **Step 3: `cliEntry.ts` を作り、`index.ts` をそれに寄せる**

`packages/server/src/cliEntry.ts` を作る。中身は、いまの `index.ts` の 2-17 行（`server.ts` の 1 行を除いたすべて）に、頭の説明を足したものである。

```ts
/**
 * CLI（packages/cli）が使う名前を出す入口。
 * サーバ本体（server.ts）と、その先の HTTP、MCP、tmux、node-pty をたどらない。
 * パッケージの入口（index.ts）から取ると、esbuild がサーバ全体を cli.mjs へ束ね、配布物にサーバが二重に入る。
 * ここに名前を足すときも、server.ts を import しないモジュールから取る。
 * cli.mjs がサーバを抱えていないことは apps/desktop/test/bundle-server.test.ts が確かめる。
 */
export { hangarHome, defaultClaudeDir, ensureHome, readOrCreateToken, readOrCreateDevice, loadSettings, saveSettings } from './config/paths.ts';
export { STATUSLINE_MARKER, appendStatuslineSnippet, ensureStatuslineHeaderFile, resolveStatuslineScript, statuslineHeaderPath, statuslineSnippet, statuslineSnippetUpToDate, statuslineStatus, writeStatuslineHeaderFile } from './config/statusline.ts';
export { claudeJsonPath, upsertUserMcpServer } from './config/claudeJson.ts';
export { SHELL_MARKER, ensureShellScript, installShellHook, shellHookInstalled, shellHookLine, shellHookState, shellHookUpToDate, shellScriptPath, shellWrapSupported, uninstallShellHook, zshrcPath, type ShellHookState, type ShellScriptOptions } from './config/shellHook.ts';
export { backupsRoot, cloudConfigPath, loadCloudConfig, readCloudConfig, remoteRoot, saveCloudConfig, type CloudConfig, type CloudConfigRead } from './config/cloud.ts';
export { SyncStateStore, type SyncStateKey } from './sync/state.ts';
// 本文をどこから上げるかの床。
// 刻むのは CLI の hangar setup cloud と hangar join（cloud.json を書くのと同じ時点）である。
// 読むのは hangar cloud status、0 へ落とすのは hangar cloud backfill である。
export { backfillTranscripts, readTranscriptsFrom, stampTranscriptsFrom } from './sync/transcriptsFrom.ts';
export { onSharedWrite } from './db/shared.ts';
// クラウドの入口。CLI の hangar cloud teardown が、R2 にしか無い本文を先に手元へ降ろすのに使う。
// 鍵の導出とパスの組み立てを写して持つと、片方だけ直されて食い違うので、ここから正面で配る。
export { CloudError, DEFAULT_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS, HttpCloudClient, goneFloor, type CloudClient, type HttpCloudClientOptions } from './sync/client.ts';
export { CHUNK_SIZE, decryptBuffer, decryptStream, deriveFileKey, encryptBuffer, encryptStream, sha256Hex, sha256Stream } from './sync/crypto.ts';
export { remoteTranscriptPath } from './sync/puller.ts';
```

`packages/server/src/index.ts` を、次の内容で置き換える。

```ts
export { installShutdown, startServer, STOP_WATCHDOG_MS, VERSION } from './server.ts';
// CLI が使う名前は cliEntry.ts にまとめてある。CLI はそちらから取る（理由は cliEntry.ts の頭に書いた）。
export * from './cliEntry.ts';
```

- [ ] **Step 4: CLI の 6 つのファイルの import 先を替える**

次の 6 か所で、`from '@agent-hangar/server';` を `from '@agent-hangar/server/src/cliEntry.ts';` に替える。名前の並びは変えない。

- `packages/cli/src/index.ts:2`（`import { claudeJsonPath, …, readOrCreateToken } from '@agent-hangar/server';`）
- `packages/cli/src/cloud.ts:9`（`import { backfillTranscripts, …, stampTranscriptsFrom } from '@agent-hangar/server';`）
- `packages/cli/src/mcp.ts:3`（`import { ensureHome, readOrCreateToken, upsertUserMcpServer } from '@agent-hangar/server';`）
- `packages/cli/src/setup.ts:6`（`import { defaultClaudeDir, …, statuslineStatus } from '@agent-hangar/server';`）
- `packages/cli/src/shell.ts:13`（複数行の import の閉じ `} from '@agent-hangar/server';`）
- `packages/cli/src/statusline.ts:13`（複数行の import の閉じ `} from '@agent-hangar/server';`）

替えた後に、試験でないファイルに入口からの import が残っていないことを確かめる。

Run: `git grep -n "from '@agent-hangar/server'" -- 'packages/cli/src/*.ts' ':!packages/cli/src/*.test.ts'`
Expected: 出力なし。

`apps/desktop/scripts/bundle-server.ts` の 8-13 行の説明を直す。

```ts
/**
 * バンドルに入れず、隣の node_modules から読ませるモジュール。
 * サーバの import から到達するネイティブはこの二つだけである（実測）。
 * CLI（cli.mjs）が使うのは better-sqlite3 だけで、node-pty はサーバだけが使う。
 * どちらも prebuildify 形式で、実体は build/Release ではなく prebuilds の下にある。
 */
```

- [ ] **Step 5: 試験が通るのを見る**

Run: `npx vitest run packages/server/src/index.test.ts packages/cli`
Expected: PASS。

Run: `npx vitest run apps/desktop/test/bundle-server.test.ts`
Expected: Apple silicon で PASS（Task 1 の `bin/hangar start` の試験も、`cli.mjs` が軽くなったまま通る）。

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: design.md を直す**

`docs/design.md` の 77 行「配布する `.app` には、esbuild で単一ファイルにまとめたサーバ（`server.mjs`）を、ネイティブモジュールと UI とともに同梱する。」の直後に、次の 2 行を足す。

```markdown
CLI（`cli.mjs`）は、サーバの入口 `index.ts` ではなく、サーバ本体をたどらない `packages/server/src/cliEntry.ts` から名前を取る。
入口から取ると、esbuild がサーバ全体を `cli.mjs` にも束ね、同梱物にサーバが二重に入るためである。
```

- [ ] **Step 7: コミットする**

```bash
git add packages/server/src/cliEntry.ts packages/server/src/index.ts packages/server/src/index.test.ts packages/cli/src/index.ts packages/cli/src/cloud.ts packages/cli/src/mcp.ts packages/cli/src/setup.ts packages/cli/src/shell.ts packages/cli/src/statusline.ts apps/desktop/scripts/bundle-server.ts apps/desktop/test/bundle-server.test.ts docs/design.md
```

```bash
git commit -m "refactor(cli): import from a server entry that does not reach server.ts" -m "cli.mjs bundled the whole server a second time because the CLI imported the package entry. The CLI now imports packages/server/src/cliEntry.ts, and a bundle test pins that cli.mjs keeps only better-sqlite3 external and stays under 512KB." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Worker を 1 本に束ねる道具と束縛の定義

**Files:**
- Create: `packages/cloud/scripts/build-worker.ts`
- Create: `packages/cloud/test/build-worker.test.ts`
- Modify: `packages/cloud/test/harness.ts:1-61`
- Modify: `packages/cloud/tsconfig.json`
- Modify: `packages/cli/src/cloud.test.ts:1-13`（import）、ファイルの末尾（`describe` を 1 つ足す）

**Interfaces:**
- Produces（`packages/cloud/scripts/build-worker.ts`）:
  - `WORKER_MODULE = 'worker.mjs'`、`WORKER_METADATA = 'metadata.json'`
  - `type WorkerBinding = { type: 'd1'; name: string } | { type: 'r2_bucket'; name: string }`
  - `type WorkerMetadata = { main_module: string; compatibility_date: string; compatibility_flags: string[]; bindings: WorkerBinding[] }`
  - `bundleWorker(cloudDir: string): Promise<string>`。`cloudDir` は `packages/cloud` の場所。外への import を残さない ESM の文字列を返す。
  - `workerMetadata(cloudDir: string): WorkerMetadata`。`cloudDir/wrangler.jsonc` から作る。写し方を決めていない設定があれば投げる。
  - `bindingNames(meta: WorkerMetadata, type: WorkerBinding['type']): string[]`
- Task 4 の `bundle-server.ts` と、その試験がこれらを使う。

- [ ] **Step 1: 試験を書く**

`packages/cloud/test/build-worker.test.ts` を作る。

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { bindingNames, bundleWorker, WORKER_METADATA, WORKER_MODULE, workerMetadata } from '../scripts/build-worker.ts';

const cloudDir = fileURLToPath(new URL('..', import.meta.url));
const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('同梱する Worker の束と束縛の定義', () => {
  it('束縛の定義は、wrangler.jsonc の互換の日付と旗、D1 と R2 の束縛の名前を写し、手元の資源の名前は写さない', () => {
    expect(WORKER_MODULE).toBe('worker.mjs');
    expect(WORKER_METADATA).toBe('metadata.json');
    expect(workerMetadata(cloudDir)).toEqual({
      main_module: 'worker.mjs',
      compatibility_date: '2026-08-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        { type: 'd1', name: 'DB' },
        { type: 'r2_bucket', name: 'BUCKET' },
      ],
    });
    // 手元の開発用の名前（hangar-local）と、ゼロの database_id は運ばない。
    expect(JSON.stringify(workerMetadata(cloudDir))).not.toContain('hangar-local');
    expect(JSON.stringify(workerMetadata(cloudDir))).not.toContain('00000000-0000');
  });

  it('束は外への import を持たない 1 本の ESM で、定義の束縛で起こすと /health が通る', async () => {
    const script = await bundleWorker(cloudDir);
    expect(script).not.toMatch(/^import\s/m);
    expect(script).toMatch(/as default/);
    const meta = workerMetadata(cloudDir);
    const mf = new Miniflare({
      modules: true,
      script,
      // 絶対パスで作業ディレクトリの外を指すと、workerd は .. で抜けられずに起動を断る。名前だけを渡す。
      scriptPath: meta.main_module,
      compatibilityDate: meta.compatibility_date,
      compatibilityFlags: meta.compatibility_flags,
      d1Databases: bindingNames(meta, 'd1'),
      r2Buckets: bindingNames(meta, 'r2_bucket'),
      bindings: { JOIN_SECRET_HASH: '' },
      outboundService: () => new Response('outbound fetch is not allowed in tests', { status: 599 }),
    });
    try {
      const r = await mf.dispatchFetch('http://localhost/health');
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true });
    } finally {
      await mf.dispose();
    }
  });

  it('写し方を決めていない設定（KV、vars の中身）や、行の途中の注釈があれば、黙って落とさずに止める', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-wrangler-'));
    temps.push(dir);
    const file = path.join(dir, 'wrangler.jsonc');
    const base = { name: 'x', main: 'src/index.ts', compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB' }], r2_buckets: [{ binding: 'BUCKET' }], vars: {} };
    fs.writeFileSync(file, `// 行頭の注釈は読み飛ばす。\n${JSON.stringify(base)}\n`);
    expect(bindingNames(workerMetadata(dir), 'd1')).toEqual(['DB']);
    fs.writeFileSync(file, JSON.stringify({ ...base, kv_namespaces: [{ binding: 'KV' }] }));
    expect(() => workerMetadata(dir)).toThrow(/kv_namespaces/);
    fs.writeFileSync(file, JSON.stringify({ ...base, vars: { MODE: 'x' } }));
    expect(() => workerMetadata(dir)).toThrow(/vars/);
    fs.writeFileSync(file, '{ "name": "x", // 行の途中の注釈\n "compatibility_date": "2026-08-01" }\n');
    expect(() => workerMetadata(dir)).toThrow(/wrangler\.jsonc を読めません/);
  });
});
```

- [ ] **Step 2: 試験が落ちるのを見る**

Run: `npx vitest run packages/cloud/test/build-worker.test.ts`
Expected: FAIL。`../scripts/build-worker.ts` を解決できない。

- [ ] **Step 3: `build-worker.ts` を書く**

`packages/cloud/scripts/build-worker.ts` を作る。

```ts
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

/**
 * Worker を 1 本の ESM に束ねる道具と、その束縛の定義。
 * 使うのは 2 か所である。
 * test/harness.ts は、束ねた Worker を miniflare で起こして試す。
 * apps/desktop/scripts/bundle-server.ts は、同じ束を配布版の cloud/worker.mjs に、定義を cloud/metadata.json に置く。
 * 同じ関数を通すので、配布物に入る束は試験で起こした束と同じになる。
 */

/** 同梱する束の名前。metadata.json の main_module もこれを指す。 */
export const WORKER_MODULE = 'worker.mjs';

/** 同梱する束縛の定義の名前。 */
export const WORKER_METADATA = 'metadata.json';

export type WorkerBinding = { type: 'd1'; name: string } | { type: 'r2_bucket'; name: string };

/**
 * 束縛の定義。
 * 形は Cloudflare の REST で Worker のスクリプトを上げるときの metadata に寄せてある（段 5 でそのまま使うため）。
 * 資源ごとの値（D1 の id、R2 の bucket_name）と Worker の名前は利用者ごとに違うので、ここには持たない。
 */
export type WorkerMetadata = {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: WorkerBinding[];
};

/**
 * wrangler.jsonc の鍵のうち、定義へ写すものと、写さずに捨てるもの。
 * name、main、$schema は手元の開発用の値なので捨てる。vars は空であることだけを確かめる。
 * ここに無い鍵があれば止める。束縛の種類が増えたのに定義から黙って落ちると、段 5 で上げた Worker がその束縛を持たない。
 */
const KNOWN_KEYS = ['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'd1_databases', 'r2_buckets', 'vars'];

type WranglerConfig = {
  compatibility_date?: unknown;
  compatibility_flags?: string[];
  d1_databases?: { binding: string }[];
  r2_buckets?: { binding: string }[];
  vars?: Record<string, unknown>;
};

/** Worker を 1 本の ESM に束ねる。外への import を残さない。 */
export async function bundleWorker(cloudDir: string): Promise<string> {
  const r = await build({
    entryPoints: [path.join(cloudDir, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['workerd', 'browser', 'module', 'main'],
    target: 'es2022',
    write: false,
  });
  return r.outputFiles[0]!.text;
}

/**
 * packages/cloud/wrangler.jsonc から束縛の定義を作る。
 * 写すのは互換の日付と旗、D1 と R2 の束縛の名前だけである。
 */
export function workerMetadata(cloudDir: string): WorkerMetadata {
  const file = path.join(cloudDir, 'wrangler.jsonc');
  let w: WranglerConfig;
  try {
    // 行頭が // の行だけを落として JSON として読む。行の途中に注釈を書くと、ここで読めずに止まる。
    const text = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    w = JSON.parse(text) as WranglerConfig;
  } catch (e) {
    throw new Error(`${file} を読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  const unknown = Object.keys(w).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${file} に、同梱の定義への写し方を決めていない設定があります: ${unknown.join(', ')}。packages/cloud/scripts/build-worker.ts に写し方を足してください`);
  }
  if (w.vars && Object.keys(w.vars).length > 0) {
    throw new Error(`${file} の vars が空ではありません。同梱の定義への写し方を packages/cloud/scripts/build-worker.ts に足してください`);
  }
  if (typeof w.compatibility_date !== 'string') throw new Error(`${file} に compatibility_date がありません`);
  return {
    main_module: WORKER_MODULE,
    compatibility_date: w.compatibility_date,
    compatibility_flags: w.compatibility_flags ?? [],
    bindings: [
      ...(w.d1_databases ?? []).map((d): WorkerBinding => ({ type: 'd1', name: d.binding })),
      ...(w.r2_buckets ?? []).map((b): WorkerBinding => ({ type: 'r2_bucket', name: b.binding })),
    ],
  };
}

/** 定義のうち、ある種類の束縛の名前。miniflare の d1Databases と r2Buckets に渡す形である。 */
export function bindingNames(meta: WorkerMetadata, type: WorkerBinding['type']): string[] {
  return meta.bindings.filter((b) => b.type === type).map((b) => b.name);
}
```

`packages/cloud/tsconfig.json` の `include` に `scripts` を足す。

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types", "node"], "lib": ["ES2022", "WebWorker"] },
  "include": ["src", "test", "scripts", "vitest.config.ts"]
}
```

- [ ] **Step 4: harness を同じ道具に寄せる**

`packages/cloud/test/harness.ts` の 1-4 行の import を、次に置き換える（`esbuild` の import を外し、`build-worker.ts` を足す）。

```ts
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { bindingNames, bundleWorker, workerMetadata } from '../scripts/build-worker.ts';
import type { Env } from '../src/env.ts';
```

25-44 行（`ENTRY`、`BUNDLE_PATH`、`bundled`、`workerScript`）を、次に置き換える。

```ts
// URL の pathname は Windows で /D:/... になり、esbuild が解決できない。
const CLOUD_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE_PATH = fileURLToPath(new URL('../src/index.bundle.js', import.meta.url));

let bundled: Promise<string> | null = null;

/** Worker を 1 つの ESM に束ねる。配布版に同梱する cloud/worker.mjs と同じ束である。テストのファイルごとに 1 回で足りる。 */
function workerScript(): Promise<string> {
  bundled ??= bundleWorker(CLOUD_DIR);
  return bundled;
}
```

`startCloud` の中の `new Miniflare({ … })`（50-61 行）で、互換の日付と旗と束縛の名前を定義から取る。

```ts
  const meta = workerMetadata(CLOUD_DIR);
  const mf = new Miniflare({
    modules: true,
    script,
    scriptPath: BUNDLE_PATH,
    // 互換の日付と旗と束縛の名前は、配布版に同梱する metadata.json と同じ定義から取る。
    compatibilityDate: meta.compatibility_date,
    compatibilityFlags: meta.compatibility_flags,
    d1Databases: bindingNames(meta, 'd1'),
    r2Buckets: bindingNames(meta, 'r2_bucket'),
    bindings: { JOIN_SECRET_HASH: joinSecretHash, ...options.bindings },
    // Worker から外への fetch を受ける。渡さなければ外へは出ない（試験は実物の Cloudflare に触らない）。
    outboundService: options.outbound ?? (() => new Response('outbound fetch is not allowed in tests', { status: 599 })),
  });
```

- [ ] **Step 5: setup cloud の書く設定と、同梱の定義がそろっていることを留める**

`packages/cli/src/cloud.test.ts` の import を直す。
`node:url` を足す（4 行目の `node:path` の下）。

```ts
import { fileURLToPath } from 'node:url';
```

10 行目の `./cloud.ts` からの import に `writeWranglerConfig` を足し、その下に `build-worker.ts` の import を足す。

```ts
import { bindingNames, workerMetadata } from '../../cloud/scripts/build-worker.ts';
```

ファイルの末尾に足す。
これは今の値が既にそろっていることを留める試験なので、足した時点で通る。

```ts
describe('setup cloud の書く wrangler の設定', () => {
  it('互換の日付と旗、D1 と R2 の束縛の名前が、同梱する束縛の定義（packages/cloud/wrangler.jsonc から作る）とそろっている', () => {
    // 片方だけ変えると、wrangler で上げた Worker と、段 5 で同梱の定義から上げる Worker が食い違う。
    const { home } = dirs();
    const file = writeWranglerConfig(home, { name: 'hangar', main: '/x/src/index.ts', dbName: 'hangar', dbId: DB_ID, bucketName: 'hangar-files' });
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')) as {
      compatibility_date: string;
      compatibility_flags: string[];
      d1_databases: { binding: string }[];
      r2_buckets: { binding: string }[];
    };
    const meta = workerMetadata(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloud'));
    expect(cfg.compatibility_date).toBe(meta.compatibility_date);
    expect(cfg.compatibility_flags).toEqual(meta.compatibility_flags);
    expect(cfg.d1_databases.map((d) => d.binding)).toEqual(bindingNames(meta, 'd1'));
    expect(cfg.r2_buckets.map((b) => b.binding)).toEqual(bindingNames(meta, 'r2_bucket'));
  });
});
```

- [ ] **Step 6: 試験が通るのを見る**

Run: `npx vitest run packages/cloud packages/cli/src/cloud.test.ts`
Expected: PASS（harness を使う既存の Worker の試験もすべて、同じ束で通る）。

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 7: コミットする**

```bash
git add packages/cloud/scripts/build-worker.ts packages/cloud/test/build-worker.test.ts packages/cloud/test/harness.ts packages/cloud/tsconfig.json packages/cli/src/cloud.test.ts
```

```bash
git commit -m "feat(cloud): one place to bundle the Worker and describe its bindings" -m "bundleWorker and workerMetadata live in packages/cloud/scripts/build-worker.ts. The miniflare harness uses them, so the bundle that tests run is the bundle that will ship. workerMetadata refuses wrangler settings it does not know how to carry." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 同梱の `cloud/` を、源の写しから Worker の束に替える

**Files:**
- Modify: `apps/desktop/scripts/bundle-server.ts:1-4`（import）、`:32-39`、`:44-51`、`:98-104`、`:148-157`
- Modify: `apps/desktop/scripts/hangar.sh:64-67`
- Modify: `apps/desktop/test/bundle-server.test.ts:8`、`:81-84`、`:99-100`、`:183-187`、`:237-251`、`:370`、`:373-380`、`:397-430`
- Modify: `README.md:409`、`docs/design.md:2651`

**Interfaces:**
- Consumes: Task 3 の `bundleWorker(cloudDir)`、`workerMetadata(cloudDir)`、`WORKER_MODULE`、`WORKER_METADATA`。
- Produces: `bundleServer` の出す `cloud/` は `worker.mjs` と `metadata.json` の 2 つだけになる。`copyCloudTree` と `BUNDLED_CLOUD_MARKER` は `bundle-server.ts` から消える。
- Produces: `bin/hangar` は `HANGAR_CLOUD_DIR` を決めなくなる。利用者が自分で決めた値は、そのまま CLI へ届く。

- [ ] **Step 1: 試験を書き換える**

`apps/desktop/test/bundle-server.test.ts` の 8 行目を、次の 2 行に置き換える。

```ts
import { bundleServer, NATIVE_MODULES, PREBUILD_ARCH } from '../scripts/bundle-server.ts';
import { bundleWorker, workerMetadata } from '../../../packages/cloud/scripts/build-worker.ts';
```

最初の `it` の、在るべきファイルの一覧（81-84 行の `'cloud/src/index.ts'`、`'cloud/wrangler.jsonc'`、`'cloud/package.json'`、`` `cloud/${BUNDLED_CLOUD_MARKER}` ``）を、次の 2 行に置き換える。

```ts
      'cloud/worker.mjs',
      'cloud/metadata.json',
```

同じ `it` の、無いべきファイルの一覧から 99-100 行（`'cloud/test'`、`'cloud/node_modules'`）を消す。

Apple silicon の describe の中、Task 2 で足した `it` の後ろに足す。

```ts
  it('cloud/ には Worker を 1 本に束ねた worker.mjs と束縛の定義 metadata.json だけを置き、源の写しを置かない', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    dirs.push(out, ui);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    // 源（src、wrangler.jsonc、package.json）も、手元の秘密や記録（.dev.vars、.env、.wrangler、ログ）も置かない。
    // 束は src/index.ts から届くコードだけでできているので、手元の秘密のファイルは入りようがない。
    expect(fs.readdirSync(path.join(out, 'cloud')).sort()).toEqual(['metadata.json', 'worker.mjs']);
    const cloudSrc = path.join(repoRoot, 'packages/cloud');
    // 置いた束は、packages/cloud の試験が miniflare で起こしているのと同じ束である。
    expect(fs.readFileSync(path.join(out, 'cloud/worker.mjs'), 'utf8')).toBe(await bundleWorker(cloudSrc));
    expect(JSON.parse(fs.readFileSync(path.join(out, 'cloud/metadata.json'), 'utf8'))).toEqual(workerMetadata(cloudSrc));
  });
```

`fakeDist` の探り script（183-187 行）で、`cloud` を `null` で出すようにする。

```ts
  fs.writeFileSync(
    path.join(dist, 'cli.mjs'),
    'console.log(JSON.stringify({ ui: process.env.HANGAR_UI_DIST, cloud: process.env.HANGAR_CLOUD_DIR ?? null, node: process.env.HANGAR_TEST_SHIM ?? null, args: process.argv.slice(2) }));\n',
  );
```

237 行の試験の名前と、245-250 行の期待を直す。

```ts
  ])('settings.json の nodePath が%sパスでも Node を見つけ、UI の置き場を渡し、Worker の置き場は渡さない', async (_label, leaf) => {
```

```ts
    expect(JSON.parse(r.stdout)).toEqual({
      ui: path.join(dist, 'ui'),
      cloud: null,
      node,
      args: ['status', '--port', '4231'],
    });
```

370 行の期待を直す。

```ts
    expect(JSON.parse(r.stdout)).toMatchObject({ ui: path.join(dist, 'ui'), cloud: null });
```

373 行の試験の名前を直す（中身は変えない）。

```ts
  it('利用者が HANGAR_CLOUD_DIR を決めていれば、そのまま CLI へ届く（開発用の上書きを残す）', async () => {
```

397-430 行の `describe('同梱する packages/cloud の写し', …)` を丸ごと消す。
写しをやめるので、写し取りの絞り込みも、目印の名前の突き合わせも、試す相手が無くなる。

- [ ] **Step 2: 試験が落ちるのを見る**

Run: `npx vitest run apps/desktop/test/bundle-server.test.ts`
Expected: FAIL。
`import { bundleServer, NATIVE_MODULES, PREBUILD_ARCH }` は通るが、Apple silicon では `cloud/` に `src` や `package.json` が並び、`cloud/worker.mjs` が無い。
どの環境でも、`bin/hangar の Node 探索` の 2 つの試験が、`cloud` に `<dist>/cloud` を受け取って落ちる。

- [ ] **Step 3: `bundle-server.ts` を直す**

`apps/desktop/scripts/bundle-server.ts` の import（1-4 行）の後ろに足す。

```ts
import { bundleWorker, WORKER_METADATA, WORKER_MODULE, workerMetadata } from '../../../packages/cloud/scripts/build-worker.ts';
```

32-39 行（`SKIP_IN_CLOUD` とその説明）を消す。
44-51 行（`BUNDLED_CLOUD_MARKER` とその説明）を消す。
98-104 行（`copyCloudTree` とその説明）を消す。

148-157 行（「Worker のソースを同梱する。」から目印の `fs.writeFileSync` まで）を、次に置き換える。

```ts
  // Worker を 1 本に束ねたものと、その束縛の定義を同梱する。
  // 源の写しは置かない。wrangler も hono も同梱しないので源からはデプロイできず、手元の秘密を運ぶ道になるだけだった。
  // 段 5 で、利用者の API トークンと Cloudflare の REST でこの束を上げる。いまは置くだけで、誰も読まない。
  const cloudSrc = path.join(opts.repoRoot, 'packages/cloud');
  fs.mkdirSync(path.join(opts.outDir, 'cloud'));
  fs.writeFileSync(path.join(opts.outDir, 'cloud', WORKER_MODULE), await bundleWorker(cloudSrc));
  fs.writeFileSync(path.join(opts.outDir, 'cloud', WORKER_METADATA), JSON.stringify(workerMetadata(cloudSrc), null, 2) + '\n');
```

- [ ] **Step 4: `hangar.sh` を直す**

`apps/desktop/scripts/hangar.sh` の 64-67 行を、次に置き換える。

```sh
    # 同梱した UI の場所を、バンドルの中から渡す。
    # 単一ファイルにまとめた時点で、コードの置き場からの相対では探せなくなる。
    # hangar start が子として起こす server.mjs も、この値を継ぐ。
    export HANGAR_UI_DIST="$dist/ui"
```

（`export HANGAR_CLOUD_DIR=…` の行を消す。同梱の `cloud/` は源ではないので、CLI に指させる先ではない。）

- [ ] **Step 5: 試験が通るのを見る**

Run: `npx vitest run apps/desktop/test/bundle-server.test.ts`
Expected: PASS（Apple silicon 以外では、Apple silicon の describe が skip）。

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: README.md と design.md を直す**

`README.md` の 409 行を、次の 2 行に置き換える。

```markdown
`.app` に入るのは、esbuild でまとめた `server.mjs` と `cli.mjs`、UI、`better-sqlite3` と `node-pty` の darwin-arm64 の prebuild、`bin/hangar`、Worker を 1 本に束ねた `cloud/worker.mjs` とその束縛の定義 `cloud/metadata.json`、`manifest.json` です。
`cloud/` は、後の版でアプリから Cloudflare へ Worker を上げるための下地で、いまはどこからも読んでいません。
```

`docs/design.md` の 2651 行（「- 配布版の同梱形態：…」）を、次に置き換える。
大きさの数は Task 7 で実測に直すので、ここでは元の値のまま残す。

```markdown
- 配布版の同梱形態：サーバと CLI を esbuild で単一ファイル（`server.mjs`、`cli.mjs`）にまとめ、UI、ネイティブモジュール、`bin/hangar`、`cloud/`、`manifest.json` とともに `.app` の `Contents/Resources/server/` へ置く。
  `cloud/` には、Worker を 1 本に束ねた `worker.mjs` と、その束縛の定義 `metadata.json`（互換の日付と旗、D1 と R2 の束縛の名前）だけを置き、源は置かない。
  `cloud/` は段 5 で Cloudflare の REST から Worker を上げるための下地で、いまは誰も読まない。
  UI の sourcemap は入れないので、実測で 7.7MB である。
  Node 本体は同梱しない。
```

- [ ] **Step 7: コミットする**

```bash
git add apps/desktop/scripts/bundle-server.ts apps/desktop/scripts/hangar.sh apps/desktop/test/bundle-server.test.ts README.md docs/design.md
```

```bash
git commit -m "feat(desktop): bundle the Worker as one module instead of copying its source" -m "server-dist/cloud now holds worker.mjs and metadata.json only. bin/hangar stops pointing HANGAR_CLOUD_DIR at it, since it is not a source tree; a value the user sets still passes through." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: CLI の目印の検査をやめ、配布版の `setup cloud` の案内を直す

**Files:**
- Modify: `packages/cli/src/cloud.ts:53-121`
- Modify: `packages/cli/src/cloud.test.ts:10`、`:1041-1046`、`:1048-1069`、`:1084-1095`
- Modify: `apps/desktop/test/bundle-server.test.ts`（Apple silicon の describe に `it` を 1 つ足す）
- Modify: `README.md:95`、`docs/design.md:2666`

**Interfaces:**
- Consumes: Task 4 で、同梱の `cloud/` が源を持たず、`bin/hangar` が `HANGAR_CLOUD_DIR` を決めなくなっていること。
- Produces: `requireCloudDir(): string` は、源（`src/index.ts`、`wrangler.jsonc`、`package.json`）が無いとき、見た場所、決め方、`clone して npm install`、`HANGAR_CLOUD_DIR` を含む 1 行で投げる。`BUNDLED_CLOUD_MARKER` は CLI からも消える。

- [ ] **Step 1: 試験を書き換える**

`packages/cli/src/cloud.test.ts` の 10 行目の import から `BUNDLED_CLOUD_MARKER` を外す。

1041-1046 行の「ソースが無ければ…」の試験に、clone の案内の期待を 1 行足す。

```ts
  it('ソースが無ければ、どこを見たかと何をすればよいかを述べて止まる', () => {
    const { cloudDir } = dirs();
    process.env.HANGAR_CLOUD_DIR = cloudDir;
    expect(() => requireCloudDir()).toThrow(/HANGAR_CLOUD_DIR/);
    expect(() => requireCloudDir()).toThrow(/src\/index\.ts/);
    expect(() => requireCloudDir()).toThrow(/clone して npm install/);
  });
```

1048-1069 行の `fakeCloudTree` を、次に置き換える。
`bundled` は、目印を置く形から、配布版に同梱する形（束と定義だけで源が無い）に変わる。

```ts
  /**
   * packages/cloud の見た目をした一式を作る。
   * 依存は親の node_modules に置くので、createRequire の解決が親をたどる様子をそのまま再現できる。
   * bundled を立てると、配布版に同梱する形（Worker の束と束縛の定義だけで、源が無い）にする。
   */
  function fakeCloudTree(o: { deps: string[]; bundled?: boolean; name?: string }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloudtree-'));
    temps.push(root);
    for (const d of o.deps) {
      const dir = path.join(root, 'node_modules', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: d, version: '0.0.0', main: 'index.js' }));
      fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    }
    // .app の置き場に相当する一段下に、cloud/ を作る。
    const dir = path.join(root, 'app', 'cloud');
    fs.mkdirSync(dir, { recursive: true });
    if (o.bundled) {
      fs.writeFileSync(path.join(dir, 'worker.mjs'), 'export default {};\n');
      fs.writeFileSync(path.join(dir, 'metadata.json'), '{}\n');
      return dir;
    }
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), '{}\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: o.name ?? '@agent-hangar/cloud', version: '0.0.0' }));
    return dir;
  }
```

1084-1095 行の「同梱の写しなら、親から wrangler を拾える置き場でも止まる」を、次に置き換える。

```ts
  it('配布版に同梱した cloud/（Worker の束だけ）を指されたら、親から wrangler を拾える置き場でも、clone を案内して止まる', () => {
    // レビューでの事故の再現。
    // .app を node_modules のあるディレクトリの下に置くと、親をたどった wrangler で依存の検査が素通りし、実物のアカウントに資源を作ってしまった。
    // 同梱の cloud/ は源を持たないので、依存を見る前に源の検査で止まる。
    process.env.HANGAR_CLOUD_DIR = fakeCloudTree({ deps: ALL_DEPS, bundled: true });
    expect(() => requireCloudDir()).toThrow(/src\/index\.ts/);
    expect(() => requireCloudDir()).toThrow(/clone して npm install/);
  });
```

`apps/desktop/test/bundle-server.test.ts` の Apple silicon の describe の中、Task 4 で足した `it` の後ろに足す。

```ts
  it('同梱の hangar の setup cloud は、wrangler を探す前に、clone した場所から実行するよう案内して止まる', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    const userHome = tmp('hangar-userhome-');
    dirs.push(out, ui, home, userHome);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    // runHangar は PATH と LANG のほかは渡さないので、手元の HANGAR_CLOUD_DIR は届かない。
    const r = await runHangar(path.join(out, 'bin/hangar'), ['setup', 'cloud'], { HANGAR_HOME: home, HANGAR_NODE: process.execPath, HOME: userHome });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/index.ts');
    expect(r.stderr).toContain('clone して npm install');
    // 資源を作りに行っていない。参加の記録も書かない。
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
  });
```

- [ ] **Step 2: 試験が落ちるのを見る**

Run: `npx vitest run packages/cli/src/cloud.test.ts -t 'Worker のソースの置き場'`
Expected: FAIL。いまの文は「HANGAR_CLOUD_DIR に packages/cloud の場所を指定してください」で終わり、`clone して npm install` を含まない。

Run: `npx vitest run apps/desktop/test/bundle-server.test.ts -t 'setup cloud'`
Expected: Apple silicon で FAIL。同じ理由である。

- [ ] **Step 3: `cloud.ts` を直す**

`packages/cli/src/cloud.ts` の 53-58 行（`defaultCloudDir` の説明）を、次に置き換える。

```ts
/**
 * packages/cloud の置き場。
 * HANGAR_CLOUD_DIR があればそこを使う（開発で別の写しを指すための上書き）。
 * 無ければ、この CLI の src からの相対で探す。
 * 配布版の cli.mjs では、この相対は .app の中の存在しない場所を指すので、requireCloudDir が clone を案内して止まる。
 * 配布版に同梱した cloud/ は Worker を束ねたもの（worker.mjs と metadata.json）で、源ではないので、ここでは指さない。
 */
```

65-71 行（`BUNDLED_CLOUD_MARKER` とその説明）を消す。

83-92 行（`requireCloudDir` の説明）を、次に置き換える。

```ts
/**
 * Worker のデプロイに要るものが揃っているかを確かめてから場所を返す。
 * 揃っていなければ、何がどこに無いのかを述べて止める。
 * 黙って wrangler を呼ぶと、意味の分からない終了コードだけが残る。
 *
 * 源（src/index.ts、wrangler.jsonc、package.json）を、依存より先に見る。
 * createRequire の解決は親をたどるので、.app をリポジトリの中や node_modules を持つディレクトリの下に置くと、
 * 無関係な wrangler を拾って依存の検査が素通りし、実物のアカウントに資源を作ってしまう。
 * 配布版に同梱した cloud/ は束ねた worker.mjs だけで源を持たないので、依存を見る前にここで止まる。
 */
```

98 行の文を、次に置き換える。

```ts
      throw new Error(`Worker のソース（${rel.join('/')}）が ${dir} にありません（${where}で決めました）。クラウド同期の設定と片付けは、リポジトリを clone して npm install した場所から実行するか、HANGAR_CLOUD_DIR に packages/cloud の場所を指定してください`);
```

110-112 行（目印を見て断る `if`）を消す。

- [ ] **Step 4: 試験が通るのを見る**

Run: `npx vitest run packages/cli apps/desktop/test/bundle-server.test.ts`
Expected: PASS。

Run: `git grep -n "BUNDLED_CLOUD_MARKER\|copyCloudTree\|SKIP_IN_CLOUD" -- ':!docs'`
Expected: 出力なし。

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 5: README.md と design.md を直す**

`README.md` の 95 行「同梱の `hangar` は、wrangler が見つからないことを告げて止まります。」を、次に置き換える。

```markdown
同梱の `hangar` は、Worker の源が無いことを告げ、clone した場所から実行するよう案内して止まります。
```

`docs/design.md` の 2666 行（「- wrangler は同梱しない。…」）を、次に置き換える。

```markdown
- wrangler は同梱しない。
  205MB あり、`.app` の大きさが 20 倍近くになる。
  配布版の `hangar setup cloud` は、Worker の源が無いことを告げ、clone した場所から実行するよう案内して止まる。
  クラウド同期を使う端末は、リポジトリを clone して設定する。
```

- [ ] **Step 6: コミットする**

```bash
git add packages/cli/src/cloud.ts packages/cli/src/cloud.test.ts apps/desktop/test/bundle-server.test.ts README.md docs/design.md
```

```bash
git commit -m "refactor(cli): drop the bundled-copy marker check" -m "The bundled cloud/ no longer holds a source tree, so requireCloudDir stops at the missing src/index.ts before resolving any dependency. The message now points to running from a cloned repository." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 殻の `HANGAR_CLOUD_DIR` と `_up_/server-dist` を消す

**Files:**
- Modify: `apps/desktop/src-tauri/src/server.rs:9-24`、`:70-72`、`:91`、`:217-230`、`:254-257`

**Interfaces:**
- Produces: `server_dir(resource_dir: &Path) -> Option<PathBuf>` は、`HANGAR_SERVER_DIR` が無いとき `resource_dir/server` だけを見る。署名は変えない（`lib.rs:511` の呼び出しはそのまま）。
- Produces: `spawn_server` はサーバへ `HANGAR_CLOUD_DIR` を渡さない。サーバが読むのは `HANGAR_UI_DIST` だけである（`packages/server/src/server.ts:866`）。

- [ ] **Step 1: 試験を書き換える**

`apps/desktop/src-tauri/src/server.rs` の 217-230 行の `server_dir_finds_bundled_layouts` を、次の 2 つに置き換える。

```rust
    #[test]
    fn server_dir_finds_the_bundled_server_only_under_server() {
        let res = tempfile::tempdir().unwrap();
        assert_eq!(server_dir(res.path()), None);
        // 古い置き場所（_up_/server-dist）は見ない。
        std::fs::create_dir_all(res.path().join("_up_/server-dist")).unwrap();
        std::fs::write(res.path().join("_up_/server-dist/server.mjs"), "").unwrap();
        assert_eq!(server_dir(res.path()), None);
        std::fs::create_dir_all(res.path().join("server")).unwrap();
        std::fs::write(res.path().join("server/server.mjs"), "").unwrap();
        assert_eq!(server_dir(res.path()), Some(res.path().join("server")));
    }

    // server_dir が見る置き場所と、バンドルが置く場所を 1 か所でつなぐ。
    // tauri.conf.json の resources を変えたら、ここが落ちる。
    #[test]
    fn the_bundle_puts_the_server_where_server_dir_looks() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["bundle"]["resources"]["../server-dist"], "server");
    }
```

`spawn_passes_env_and_stop_terminates` の 254-257 行（`cloud=` を `dir/cloud` で期待する `assert!`）を、次に置き換える。
239 行の script の `cloud=$HANGAR_CLOUD_DIR` は残し、観測に使う。

```rust
        // サーバは HANGAR_CLOUD_DIR を読まないので渡さない。
        // 試験を走らせる人の環境に残っていることはあるので、同梱の cloud/ を指していないことだけを見る。
        assert!(
            !text.contains(&format!("cloud={}", dir.path().join("cloud").display())),
            "{text}"
        );
```

- [ ] **Step 2: 試験が落ちるのを見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml server::tests`
Expected: FAIL。`server_dir_finds_the_bundled_server_only_under_server` は `_up_/server-dist` を拾って `Some` を返し、`spawn_passes_env_and_stop_terminates` は `cloud=<dir>/cloud` を見つける。`the_bundle_puts_the_server_where_server_dir_looks` は通る。

- [ ] **Step 3: `server.rs` を直す**

9-24 行（`server_dir` とその説明）を、次に置き換える。

```rust
/// 同梱サーバのディレクトリ。開発時は `HANGAR_SERVER_DIR` で差し替える。
/// 置き場所は `tauri.conf.json` の `bundle.resources`（`"../server-dist": "server"`）で `server/` に決めてある。
pub fn server_dir(resource_dir: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HANGAR_SERVER_DIR") {
        let p = PathBuf::from(p);
        return if p.join("server.mjs").is_file() {
            Some(p)
        } else {
            None
        };
    }
    let p = resource_dir.join("server");
    p.join("server.mjs").is_file().then_some(p)
}
```

70-72 行（`spawn_server` の説明）を、次に置き換える。

```rust
/// `node server.mjs` を起動する。標準出力と標準エラーはログファイルに追記する。
/// UI の置き場は、同梱の場所を環境変数で教える。
/// 単一ファイルにまとめた server.mjs からは、相対では届かないためである。
```

91 行の `.env("HANGAR_CLOUD_DIR", dir.join("cloud"))` を消す。

- [ ] **Step 4: 試験と lint が通るのを見る**

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`
Expected: 出力なし。差分が出たら `cargo fmt` を当ててから、もう一度 `--check` を打つ。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: 警告なし。

- [ ] **Step 5: コミットする**

```bash
git add apps/desktop/src-tauri/src/server.rs
```

```bash
git commit -m "refactor(desktop): stop passing HANGAR_CLOUD_DIR and drop the _up_ fallback" -m "The server never read HANGAR_CLOUD_DIR, and tauri.conf.json fixes the resource path to server/. A test now ties server_dir to that config." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 全体の確かめと、同梱物の実測

**Files:**
- Modify: `README.md:412`、`docs/design.md`（Task 4 で書いた「実測で 7.7MB である。」の行）

**Interfaces:**
- Consumes: Task 1 から Task 6 のすべて。

- [ ] **Step 1: 型と試験を全部回す**

Run: `npm run typecheck`
Expected: エラーなし。

Run: `npm test`
Expected: すべて PASS（Apple silicon でない機械では、Apple silicon の describe が skip）。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS。

- [ ] **Step 2: 3 つのビルドを通す**

Run: `npm run build`
Expected: 成功。

Run: `npm run bundle-server -w apps/desktop`
Expected: 最後の行が `server-dist:` で始まり、`.gitkeep`、`bin`、`cli.mjs`、`cloud`、`hangar-run.mjs`、`manifest.json`、`node_modules`、`server.mjs`、`ui` の 9 つが並ぶ（並びの順はファイルシステムによる）。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`
Expected: 成功し、`apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` ができる。

- [ ] **Step 3: 同梱物の中身を確かめる**

Run: `ls -la apps/desktop/server-dist apps/desktop/server-dist/cloud`
Expected: `cloud/` は `metadata.json` と `worker.mjs` の 2 つだけ。`src`、`package.json`、`wrangler.jsonc`、`.bundled` が無い。

Run: `wc -c apps/desktop/server-dist/cli.mjs apps/desktop/server-dist/server.mjs apps/desktop/server-dist/cloud/worker.mjs`
Expected: `cli.mjs` が 524288 バイト未満（試しでは約 240KB）、`server.mjs` が約 2.1MB、`worker.mjs` が約 90KB。

Run: `cat apps/desktop/server-dist/cloud/metadata.json`
Expected: `main_module` が `worker.mjs`、`compatibility_date` が `2026-08-01`、`compatibility_flags` が `["nodejs_compat"]`、`bindings` が D1 の `DB` と R2 の `BUCKET`。

Run: `ls apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app/Contents/Resources/server apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app/Contents/Resources/server/cloud`
Expected: `.app` の中も同じ並びで、`_up_` の置き場は無い。

Run: `apps/desktop/server-dist/bin/hangar --help`
Expected: `start`、`setup`、`url`、`open` などのコマンドの一覧が出る（同梱の Node の探索と `cli.mjs` の起動が通る）。

- [ ] **Step 4: 実測した大きさを文書へ書く**

Run: `du -sk apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app/Contents/Resources/server`
Expected: キロバイトの数が 1 つ出る。

出た数を 1024 で割り、小数第 1 位に丸めた MB の値にする。
`README.md` の 412 行「実測で 7.7MB でした。」と、`docs/design.md` の Task 4 で書いた行「  UI の sourcemap は入れないので、実測で 7.7MB である。」の `7.7MB` を、その値に替える。

- [ ] **Step 5: 作業ツリーに余計なものが残っていないことを確かめる**

Run: `git status --short`
Expected: `README.md` と `docs/design.md` だけが変更として出る。`apps/desktop/server-dist` の中身は `.gitignore` で外れているので出ない。

- [ ] **Step 6: コミットする**

```bash
git add README.md docs/design.md
```

```bash
git commit -m "docs: update the measured size of the bundled server directory" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 自己点検の記録

- spec の PR 2 の行との対応：CLI の import を分ける（Task 1、Task 2）、`cloud/` を Worker 1 本のビルドに替える（Task 3、Task 4、Task 5）、殻の `HANGAR_CLOUD_DIR` と `_up_/server-dist` を消す（Task 6）。終わりの条件の `npm run typecheck`、`npm test`、3 つのビルドは Task 7 で回す。
- spec の「残す境界」の「同梱の CLI は、better-sqlite3 とネイティブモジュールを持ったままにする」は、Task 2 の試験（`cli.mjs` が外に残す import は `better-sqlite3`）と、既存の試験（`node_modules` が `NATIVE_MODULES` と一致する）で留める。`manifest.json` は `bundleServer` が書き続け、既存の試験が見る。
- 名前のそろい：`probeReady`、`serverArgs`、`assertPortFree`、`runStart`、`StartOptions`（Task 1）、`cliEntry.ts`（Task 2）、`bundleWorker`、`workerMetadata`、`bindingNames`、`WORKER_MODULE`、`WORKER_METADATA`、`WorkerMetadata`、`WorkerBinding`（Task 3）を、後のタスクで同じ名前で使っている。
- 試験より先に実装を書くステップは無い。Task 3 の Step 5 と Task 6 の `the_bundle_puts_the_server_where_server_dir_looks` は、今の値が既にそろっていることを留める試験なので、足した時点で通る。
