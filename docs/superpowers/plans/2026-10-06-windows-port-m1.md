# Windows への移植：最初の区切り Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows（x64）でサーバを起こし、ブラウザで UI を開いて、セッションを起動して端末で claude を操作できるようにする。macOS の動きは変えない。

**Architecture:** OS で変わる判断を `packages/server/src/platform/` の 4 ファイル（paths、exec、secure、proc）に集め、呼ぶ側から `process.platform` の分岐を無くす。tmux の役は psmux に任せ、`Tmux` クラスと DB の列名は変えない。claude を包むスクリプトは Windows だけ Node 版にする。

**Tech Stack:** Node 22、TypeScript、vitest、better-sqlite3、node-pty、psmux 3.3.8（Windows）、tmux（macOS）。

**Spec:** `docs/superpowers/specs/2026-10-05-windows-port-m1-design.md`

## Global Constraints

- macOS の動きを変えない。どのタスクも、macOS で `npm run typecheck` と `npm test` が通ったままであること。
- 対象は Windows 11 の x64 だけ。arm64 は入れない。
- `Tmux` クラスの名前、DB の列名 `tmux_name`、API の型、設定の項目名 `tmuxPath` は変えない。
- **Windows で `kill-server` を呼ばない。** psmux 3.3.8 の `kill-server` は `-L` の別の名前空間のセッションまで全部落とす（2026-10-05 実測）。`-S <パス>` も psmux では無視されて既定の名前空間に入る。Windows で隔離に使えるのは `-L <名前>` だけで、止めるのは `kill-session -t =<名前>` だけである。
- **Windows で `npm test` を走らせる前に、Task 1 を済ませる。** Task 1 の前に tmux の試験が有効になると、利用者の psmux のセッションを落とす。
- 秘密のファイルは、Windows では `%USERPROFILE%\.agent-hangar` に置き、ACL を自分で書き換えない。モードの比較は Windows では行わない。
- この区切りに入れないもの：Tauri の殻、通知、インストーラ、`claude.zsh` に当たる包み、外のターミナルへの受け渡し、statusline の差し込み、OS をまたぐ同期、UI のショートカット。これらの試験は Windows でスキップにし、理由を書く。
- コメントと試験の題は日本語で、まわりのコードと同じ密度で書く。コミットの文は英語の Conventional Commits にする。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Windows の実機

- つなぎ方：`ssh -n -o BatchMode=yes -i ~/.ssh/id_ed25519 12700k@192.168.3.40`。
- リポジトリは `D:\workspace\agent-hangar`。枝 `worktree-windows-port` を GitHub に push し、Windows で `git fetch && git checkout worktree-windows-port && git pull` して使う。
- 依存は、Task 1 で直すまで `npm ci --ignore-scripts` で入れる。
- スクリプトは BOM 付き UTF-8 の `.ps1` を `scp` で `%TEMP%\hangar-spike\` に置き、`powershell -NoProfile -ExecutionPolicy Bypass -File` で走らせる。標準入力で渡すと、子プロセスが標準入力を食って途中で止まる。
- 試験は上限を付けて走らせ、結果は JSON で取る。

```powershell
# %TEMP%\hangar-spike\run-tests.ps1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')
Set-Location D:\workspace\agent-hangar
$out = "$env:TEMP\hangar-spike\vitest.json"; $log = "$env:TEMP\hangar-spike\vitest.log"
Remove-Item $out, $log -ErrorAction SilentlyContinue
$filter = $args -join ' '
$p = Start-Process -FilePath cmd.exe -ArgumentList '/c', "npx vitest run $filter --reporter=json --outputFile=`"$out`" > `"$log`" 2>&1" -PassThru -WindowStyle Hidden
if (-not $p.WaitForExit(480000)) { "TIMEOUT"; taskkill /PID $p.Id /T /F | Out-Null } else { "vitest exit=$($p.ExitCode)" }
```

- 結果を言う前に、通過・失敗・スキップの数を describe ごとに見る。スキップされた試験を「通った」と数えない。
- その PC では利用者の claude のセッションが動いている。自分が起こしたプロセスだけを、PID を名指しして止める。

## Review Focus

仕様が黙っているが、使う人が踏みそうな入力。どれも下のタスクに試験を足してある。

1. **ドライブ文字や大文字小文字が違うだけの同じパス**（`d:\workspace\x` と `D:\Workspace\x`）。同じプロジェクトとして扱う。→ Task 2
2. **ドライブの直下がワークスペース**（`D:\`）。`D:\x` を配下と判定する。区切りを二重に足さない。→ Task 2
3. **空白や日本語を含むパスの道具**（`C:\Program Files\...`、`C:\Users\山田\.local\bin\claude.exe`）。見つけて起動できる。→ Task 3、Task 7
4. **`PATHEXT` が無い、PATH に空の項目や引用符つきの項目がある。** 既定の拡張子で探し、空の項目は飛ばす。→ Task 3
5. **起動時刻を聞く前に相手のプロセスが消えた、PID が別のプロセスに使い回された。** `null` か不一致になり、別のプロセスを止めない。→ Task 5

---

### Task 1: Windows で試験を安全に走らせる土台

**Files:**
- Modify: `packages/server/test/tmux.ts`
- Modify: `packages/server/src/tmux/tmux.ts`（`killServer`）
- Test: `packages/server/src/tmux/tmux.test.ts`
- Create: `packages/server/test/platform.ts`
- Modify: `.gitattributes`
- Modify: `packages/cloud/test/harness.ts:24-25`
- Create: `scripts/dev.mjs`、`packages/server/scripts/dev.mjs`
- Modify: `package.json`（`dev`）、`packages/server/package.json`（`dev`）

**Interfaces:**
- Produces: `packages/server/test/platform.ts` の `isWindows: boolean`、`posixIt`、`posixDescribe`、`expectMode(file: string, mode: number): void`。後のタスクの試験が使う。
- Produces: `TMUX` は Windows では常に `null`。Unix 向けに書かれた実物の tmux の試験は Windows でスキップのままになる。

- [ ] **Step 1: `killServer` の失敗する試験を書く**

`packages/server/src/tmux/tmux.test.ts` の `describe('Tmux.args', ...)` の後ろに足す。

```ts
describe('Tmux.killServer', () => {
  // psmux の kill-server は -L の別の名前空間のセッションまで落とす（2026-10-05 実測）。
  it('Windows では呼ばずに投げる', () => {
    const calls: string[][] = [];
    const t = new Tmux({ tmuxPath: '/x/tmux', socketName: 's', platform: 'win32', exec: (_f, a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; } });
    expect(() => t.killServer()).toThrow(/kill-server/);
    expect(calls).toEqual([]);
  });
  it('macOS と Linux では名指しのサーバへ送る', () => {
    const calls: string[][] = [];
    const t = new Tmux({ tmuxPath: '/x/tmux', socketName: 's', platform: 'darwin', exec: (_f, a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; } });
    t.killServer();
    expect(calls).toEqual([['-L', 's', 'kill-server']]);
  });
});
```

- [ ] **Step 2: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/tmux/tmux.test.ts -t killServer`
Expected: FAIL（`platform` と `exec` を受け取らないので、型の誤りか `calls` が空でない）。

- [ ] **Step 3: `Tmux` に `platform` と `exec` を足す**

`packages/server/src/tmux/tmux.ts` の型とコンストラクタ、`run`、`killServer` を次のようにする。ほかのメソッドは変えない。

```ts
/** tmux を起こす口。試験では差し替える。 */
export type TmuxExec = (file: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

const realExec: TmuxExec = (file, args) => {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

export class Tmux {
  readonly tmuxPath: string;
  private readonly socketName: string | undefined;
  private readonly socketPath: string | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly exec: TmuxExec;

  constructor(opts: { tmuxPath: string; socketName?: string; socketPath?: string; platform?: NodeJS.Platform; exec?: TmuxExec }) {
    this.tmuxPath = opts.tmuxPath;
    this.socketName = opts.socketName;
    this.socketPath = opts.socketPath;
    this.platform = opts.platform ?? process.platform;
    this.exec = opts.exec ?? realExec;
  }

  run(...a: string[]): TmuxResult {
    const r = this.exec(this.tmuxPath, this.args(...a));
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, failed: r.error != null };
  }

  /**
   * サーバごと落とす。試験の後始末にだけ使う。
   * Windows の psmux では呼ばない。psmux の kill-server は名前空間を越えて全部のセッションを落とすからである。
   */
  killServer(): void {
    if (this.platform === 'win32') throw new Error('kill-server は Windows では呼ばない。kill-session で名指しして止める');
    this.run('kill-server');
  }
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/tmux/tmux.test.ts`
Expected: PASS（macOS ではいまと同じ件数に 2 件が加わる）。

- [ ] **Step 5: 試験の補助を足し、`TMUX` を Windows で止める**

`packages/server/test/platform.ts` を作る。

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

export const isWindows = process.platform === 'win32';

/** Unix にしか意味のない試験。Windows では飛ばす。使う所には理由をコメントで書く。 */
export const posixIt = it.skipIf(isWindows);
export const posixDescribe = describe.skipIf(isWindows);

/** ファイルのモードを確かめる。Windows の Node はモードを 0666 か 0444 としか返さないので、そこでは確かめない。 */
export function expectMode(file: string, mode: number): void {
  if (isWindows) return;
  expect(fs.statSync(file).mode & 0o777).toBe(mode);
}
```

`packages/server/test/tmux.ts` の `TMUX` を置き換える。

```ts
/**
 * tmux の絶対パス。無ければ null で、tmux に依存するテストは describe.skipIf(!TMUX) で飛ばす。
 * Windows では常に null にする。ここを使う試験は sh や bash を前提に書いてあり、後始末で kill-server を呼ぶ。
 * psmux の kill-server は利用者のセッションまで落とすので、psmux を相手にする試験は tmux/psmux.win.test.ts に分けてある。
 */
export const TMUX: string | null = process.platform === 'win32' ? null : which('tmux');
```

- [ ] **Step 6: 改行コード、cloud の試験のパス、開発用のスクリプトを直す**

`.gitattributes` を次にする。Windows の checkout でも LF で出るので、ファイルの中身を比べる試験（ロゴの SVG）と sh のスクリプトが壊れない。

```
# 改行は LF にそろえる。Windows の checkout でも CRLF にしない。
* text=auto eol=lf
```

`packages/cloud/test/harness.ts` の 24〜25 行を置き換える。`URL.pathname` は Windows で `/D:/...` になり、esbuild が解決できない。

```ts
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const BUNDLE_PATH = fileURLToPath(new URL('../src/index.bundle.js', import.meta.url));
```

`scripts/dev.mjs` を作る。`&` と `wait`、環境変数の前置きはシェルの書き方で、Windows の cmd では動かない。

```js
#!/usr/bin/env node
// サーバと UI の開発用サーバを並べて起こす。片方が終わったら、もう片方も止めて同じ終了コードで終わる。
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = ['packages/server', 'packages/ui'].map((ws) =>
  spawn(npm, ['run', 'dev', '--workspace', ws], { stdio: 'inherit', shell: process.platform === 'win32' }),
);
let done = false;
const stopAll = (code) => {
  if (done) return;
  done = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exitCode = code ?? 0;
};
for (const c of children) c.on('exit', (code) => stopAll(code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
```

`package.json` の `dev` を `"dev": "node scripts/dev.mjs"` にする。

`packages/server/package.json` の `dev` は `HANGAR_DEV=1 tsx watch src/main.ts` で、環境変数の前置きが cmd では動かない。`HANGAR_DEV` は `packages/server/src/http/auth.ts` の `devMode()` が読む。`packages/server/scripts/dev.mjs` を作り、`dev` を `"dev": "node scripts/dev.mjs"` にする。

```js
#!/usr/bin/env node
// 開発用のサーバを起こす。HANGAR_DEV=1 を立てて tsx watch に渡す（http/auth.ts の devMode が読む）。
import { spawn } from 'node:child_process';

const child = spawn('tsx', ['watch', 'src/main.ts'], { stdio: 'inherit', env: { ...process.env, HANGAR_DEV: '1' }, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (child.exitCode === null) child.kill(sig); });
```

`tsx` は npm が `node_modules/.bin` を PATH に足すので名前で引ける。macOS で `npm run dev --workspace packages/server` を起こし、`http://127.0.0.1:5173` からの要求が通る（`devMode()` が真である）ことを、いまと同じ手順で確かめる。

- [ ] **Step 7: 素の `npm ci` が Windows で失敗する原因を確かめて直す**

Windows で次を走らせ、ビルドを始めたパッケージを特定する。

```powershell
Set-Location D:\workspace\agent-hangar
Remove-Item -Recurse -Force node_modules
cmd /c "npm ci --foreground-scripts --no-audit --no-fund > $env:TEMP\hangar-spike\npm-ci3.log 2>&1"
Select-String -Path $env:TEMP\hangar-spike\npm-ci3.log -Pattern 'node-gyp rebuild|> .*install' | Select-Object -First 20
```

2026-10-05 の実行では `node_modules\better-sqlite3` で `node-gyp rebuild` が走って失敗した。`better-sqlite3` は prebuild を同梱していて、install のスクリプトを持たない。

- ログでビルドを始めたのが `better-sqlite3` だけなら、`package-lock.json` のその項目に `"hasInstallScript": true` があるかを見る。あれば、macOS で `npm install --package-lock-only` を走らせて項目を作り直し、差分が `hasInstallScript` の行だけであることを確かめてコミットする。
- 作り直しても Windows でビルドが走るなら、リポジトリの直下に `.npmrc` を作って `ignore-scripts=true` を書く。そのうえで macOS と Windows の両方で `npm ci`、`npm test`、`npm run build` が通ることを確かめる。`node-pty` と `better-sqlite3` は prebuild を直に読むので、スクリプト無しで動く（Windows で確かめ済み）。
- どちらを採ったかと理由を、コミットの文に書く。

- [ ] **Step 8: 両方の OS で確かめる**

macOS：

Run: `npm run typecheck && npm test`
Expected: PASS。件数は直す前より 2 件多い。

Windows（枝を push して pull したあと）：

Run: `npm ci`、続けて `run-tests.ps1 packages/cloud packages/ui/src/brand packages/server/src/tmux`
Expected: `packages/cloud` の 94 件と `logo.test.ts` の 5 件が通る。`Tmux（実物）` の 17 件はスキップのまま。`Tmux.listSessions（偽の tmux）` の 2 件はまだ失敗する（Task 6 で扱う）。

- [ ] **Step 9: コミット**

```bash
git add .gitattributes scripts/dev.mjs package.json package-lock.json packages/server/package.json packages/server/scripts/dev.mjs packages/server/test packages/server/src/tmux packages/cloud/test/harness.ts
git commit -m "test: make the suite safe to run on Windows and fix the cloud harness paths"
```

---

### Task 2: パスの判定を platform/paths.ts に集める

**Files:**
- Create: `packages/server/src/platform/paths.ts`
- Test: `packages/server/src/platform/paths.test.ts`
- Modify: `packages/server/src/projects/registry.ts:30-33,36-44,70-71`
- Modify: `packages/server/src/db/queries.ts:183`
- Modify: `packages/server/src/projects/scratch.ts:50`、`packages/server/src/projects/promote.ts:89`
- Test: `packages/server/src/projects/registry.test.ts`

**Interfaces:**
- Produces:
  - `pathKey(p: string, platform?: NodeJS.Platform): string` 比べるための鍵。Windows では小文字にする。
  - `samePath(a: string, b: string, platform?: NodeJS.Platform): boolean`
  - `isStrictlyUnder(p: string, dir: string, platform?: NodeJS.Platform): boolean` `dir` 自身は含まない。
  - `isUnder(p: string, dir: string, platform?: NodeJS.Platform): boolean` `dir` 自身を含む。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/platform/paths.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { isStrictlyUnder, isUnder, pathKey, samePath } from './paths.ts';

describe('isUnder', () => {
  it('macOS と Linux は / で区切り、大文字小文字を区別する', () => {
    expect(isUnder('/w/alpha', '/w/alpha', 'darwin')).toBe(true);
    expect(isUnder('/w/alpha/src', '/w/alpha', 'darwin')).toBe(true);
    expect(isUnder('/w/alphabet', '/w/alpha', 'darwin')).toBe(false);
    expect(isUnder('/w/Alpha/src', '/w/alpha', 'darwin')).toBe(false);
  });
  it('Windows は \\ で区切り、大文字小文字とドライブ文字の大小を区別しない', () => {
    expect(isUnder('D:\\workspace\\alpha\\src', 'D:\\workspace\\alpha', 'win32')).toBe(true);
    expect(isUnder('d:\\Workspace\\Alpha\\src', 'D:\\workspace\\alpha', 'win32')).toBe(true);
    expect(isUnder('D:\\workspace\\alphabet', 'D:\\workspace\\alpha', 'win32')).toBe(false);
    expect(isUnder('C:\\workspace\\alpha', 'D:\\workspace\\alpha', 'win32')).toBe(false);
  });
  it('ドライブの直下を根にしても、区切りを二重に足さない', () => {
    expect(isUnder('D:\\x', 'D:\\', 'win32')).toBe(true);
    expect(isUnder('D:\\', 'D:\\', 'win32')).toBe(true);
    expect(isUnder('/x', '/', 'darwin')).toBe(true);
  });
});

describe('isStrictlyUnder', () => {
  it('根そのものは含めない', () => {
    expect(isStrictlyUnder('/s', '/s', 'darwin')).toBe(false);
    expect(isStrictlyUnder('/s/20261005-010203', '/s', 'darwin')).toBe(true);
    expect(isStrictlyUnder('C:\\S', 'c:\\s', 'win32')).toBe(false);
    expect(isStrictlyUnder('C:\\s\\20261005-010203', 'c:\\S', 'win32')).toBe(true);
  });
});

describe('samePath と pathKey', () => {
  it('Windows だけ大文字小文字を畳む', () => {
    expect(samePath('D:\\A', 'd:\\a', 'win32')).toBe(true);
    expect(samePath('/A', '/a', 'darwin')).toBe(false);
    expect(pathKey('D:\\Work', 'win32')).toBe('d:\\work');
    expect(pathKey('/Work', 'linux')).toBe('/Work');
  });
});
```

- [ ] **Step 2: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/platform/paths.test.ts`
Expected: FAIL（`./paths.ts` が無い）。

- [ ] **Step 3: 実装する**

`packages/server/src/platform/paths.ts`

```ts
// パスの比べ方。OS で変わるのは、区切りと、大文字小文字を区別するかどうかである。
// 受け取るパスは、呼ぶ側で path.resolve と NFC の正規化を済ませたものとする。

const sepOf = (platform: NodeJS.Platform): string => (platform === 'win32' ? '\\' : '/');

/** 比べるための鍵。Windows のファイルシステムは大文字小文字を区別しないので、小文字にそろえる。 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.toLowerCase() : p;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** p が dir の下にあるか。dir 自身は含めない。 */
export function isStrictlyUnder(p: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const sep = sepOf(platform);
  const d = pathKey(dir, platform);
  // ドライブの直下（D:\）と / は、すでに区切りで終わっている。
  const base = d.endsWith(sep) ? d : d + sep;
  const x = pathKey(p, platform);
  return x.length > base.length && x.startsWith(base);
}

/** p が dir 自身か、その下にあるか。 */
export function isUnder(p: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  return samePath(p, dir, platform) || isStrictlyUnder(p, dir, platform);
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/platform/paths.test.ts`
Expected: PASS。

- [ ] **Step 5: 呼ぶ側を差し替える**

`packages/server/src/projects/registry.ts`：手元の `isUnder`（30〜33 行）を消し、`import { isUnder, pathKey } from '../platform/paths.ts';` を足す。`syncProjectsFromWorkspace` の `known` を鍵で持つ。

```ts
  const known = new Set((db.prepare('select path from project_roots where device_id = ? and deleted_at is null').all(deviceId) as { path: string }[]).map((r) => pathKey(r.path.normalize('NFC'))));
  for (const dir of childDirs(workspaceRoot)) {
    if (!cwds.some((c) => isUnder(c, dir))) continue;
    if (known.has(pathKey(dir))) continue;
```

`packages/server/src/db/queries.ts:183`：`import { isStrictlyUnder } from '../platform/paths.ts';` を足して置き換える。

```ts
  const underScratch = r.scratch_root !== null && isStrictlyUnder(r.cwd, r.scratch_root);
```

`packages/server/src/projects/scratch.ts:50` と `packages/server/src/projects/promote.ts:89` は、`path.sep` を足して `startsWith` している式を、同じ意味の `isStrictlyUnder(a, b)`（根を含める式なら `isUnder(a, b)`）に置き換える。置き換える前に、その式が根自身を含めているかどうかを読んで、合うほうを選ぶ。

- [ ] **Step 6: 試験のパスを OS に合わせる**

`packages/server/src/projects/registry.test.ts` は、`'/w/alpha'` のような文字列をそのまま期待値にしている。`normalizeDir` は `path.resolve` を通すので、Windows では `D:\w\alpha` になる。
ファイルの先頭に補助を足し、期待値とセッションの cwd の両方をこれで作る。

```ts
/** OS の形の絶対パス。Windows では、いまのドライブを付けた \ 区切りになる。 */
const abs = (p: string): string => path.resolve(p);
```

書き換えの例：

```ts
// 前
expect(root.path).toBe('/w/alpha');
// 後
expect(root.path).toBe(abs('/w/alpha'));
```

大文字小文字の試験を 1 件足す。

```ts
// Windows のファイルシステムは大文字小文字を区別しない。Claude が書く cwd とワークスペースの綴りが違っても同じフォルダである。
it.runIf(process.platform === 'win32')('Windows では、綴りの大文字小文字が違う cwd も紐づける', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-'));
  fs.mkdirSync(path.join(root, 'Alpha'));
  insertSession(db, { id: 's1', cwd: path.join(root, 'alpha', 'src').toUpperCase() });
  expect(syncProjectsFromWorkspace(db, 'dev', root).created).toHaveLength(1);
});
```

`insertSession` は、そのファイルで既にセッションの行を入れている補助の名前に合わせる。無ければ、同じファイルの既存の試験が行を入れている書き方をそのまま使う。

- [ ] **Step 7: 両方の OS で確かめる**

macOS：

Run: `npx vitest run packages/server/src/projects packages/server/src/db packages/server/src/platform`
Expected: PASS。

Windows：

Run: `run-tests.ps1 packages/server/src/projects/registry.test.ts packages/server/src/platform`
Expected: `registry.test.ts` の失敗 4 件（52、63、84、141 行）が通る。

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/platform/paths.ts packages/server/src/platform/paths.test.ts packages/server/src/projects packages/server/src/db/queries.ts
git commit -m "fix(server): compare paths through a platform layer so Windows cwds match project roots"
```

---

### Task 3: 道具の探し方を platform/exec.ts に集める

**Files:**
- Create: `packages/server/src/platform/exec.ts`
- Test: `packages/server/src/platform/exec.test.ts`
- Create: `packages/server/test/fake-bin.ts`
- Modify: `packages/server/src/config/tools.ts`
- Modify: `packages/server/src/config/readiness.ts:16-20,23-28,36-52,74-80`
- Test: `packages/server/src/config/tools.test.ts`、`packages/server/src/config/readiness.test.ts`

**Interfaces:**
- Produces（`platform/exec.ts`）:
  - `splitPathEnv(pathEnv: string | undefined, platform?: NodeJS.Platform): string[]`
  - `pathExts(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[]` Windows 以外は `['']`。
  - `isExecutableFile(p: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): boolean`
  - `findInDirs(cmd: string, dirs: string[], env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | null`
  - `knownDirs(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homedir?: string): string[]`
  - `isCommandName(p: string, platform?: NodeJS.Platform): boolean`
  - `needsShell(file: string, platform?: NodeJS.Platform): boolean` `.cmd` と `.bat` のとき真。
  - `MUX_NAMES(platform?: NodeJS.Platform): string[]` Windows は `['psmux', 'tmux']`、ほかは `['tmux']`。
- Produces（`test/fake-bin.ts`）: `writeFakeTool(dir: string, name: string, body: { sh: string; cmd: string }, mode?: number): string` 置いたファイルの絶対パスを返す。Windows では `<name>.cmd` になる。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/platform/exec.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFakeTool } from '../../test/fake-bin.ts';
import { findInDirs, isCommandName, knownDirs, MUX_NAMES, needsShell, pathExts, splitPathEnv } from './exec.ts';

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-exec-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('splitPathEnv', () => {
  it('macOS と Linux は : で分ける', () => {
    expect(splitPathEnv('/a:/b::/c', 'darwin')).toEqual(['/a', '/b', '/c']);
    expect(splitPathEnv(undefined, 'linux')).toEqual([]);
  });
  it('Windows は ; で分け、空の項目を飛ばし、引用符を外す', () => {
    expect(splitPathEnv('C:\\a;;"C:\\Program Files\\x";D:\\b;', 'win32')).toEqual(['C:\\a', 'C:\\Program Files\\x', 'D:\\b']);
  });
});

describe('pathExts', () => {
  it('Windows は PATHEXT を小文字で返し、無ければ既定を使う', () => {
    expect(pathExts({ PATHEXT: '.EXE;.CMD' }, 'win32')).toEqual(['.exe', '.cmd']);
    expect(pathExts({}, 'win32')).toEqual(['.com', '.exe', '.bat', '.cmd']);
    expect(pathExts({ PATHEXT: '  ' }, 'win32')).toEqual(['.com', '.exe', '.bat', '.cmd']);
  });
  it('ほかの OS は拡張子を補わない', () => {
    expect(pathExts({ PATHEXT: '.EXE' }, 'darwin')).toEqual(['']);
  });
});

describe('isCommandName', () => {
  it('区切りを含まず ~ で始まらないものが名前', () => {
    expect(isCommandName('tmux', 'darwin')).toBe(true);
    expect(isCommandName('/usr/bin/tmux', 'darwin')).toBe(false);
    expect(isCommandName('~/bin/tmux', 'darwin')).toBe(false);
    expect(isCommandName('psmux', 'win32')).toBe(true);
    expect(isCommandName('psmux.exe', 'win32')).toBe(true);
    expect(isCommandName('C:\\tools\\psmux.exe', 'win32')).toBe(false);
    expect(isCommandName('tools\\psmux.exe', 'win32')).toBe(false);
    expect(isCommandName('C:psmux.exe', 'win32')).toBe(false);
  });
});

describe('needsShell と MUX_NAMES', () => {
  it('.cmd と .bat だけがシェルを要る', () => {
    expect(needsShell('C:\\x\\code.cmd', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\a.BAT', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\claude.exe', 'win32')).toBe(false);
    expect(needsShell('/x/code.cmd', 'darwin')).toBe(false);
  });
  it('Windows は psmux を先に探す', () => {
    expect(MUX_NAMES('win32')).toEqual(['psmux', 'tmux']);
    expect(MUX_NAMES('darwin')).toEqual(['tmux']);
  });
});

describe('knownDirs', () => {
  it('macOS は Homebrew と手元の置き場', () => {
    expect(knownDirs({ HOME: '/Users/me' }, 'darwin', '/x')).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join('/Users/me', '.local', 'bin'), path.join('/Users/me', '.claude', 'local')]);
  });
  it('Windows は claude の置き場と winget の置き場。LOCALAPPDATA が無ければ足さない', () => {
    expect(knownDirs({ USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\x')).toEqual([
      path.join('C:\\Users\\me', '.local', 'bin'),
      path.join('C:\\Users\\me\\AppData\\Local', 'Microsoft', 'WinGet', 'Links'),
    ]);
    expect(knownDirs({}, 'win32', 'C:\\x')).toEqual([path.join('C:\\x', '.local', 'bin')]);
  });
});

describe('findInDirs（実物のファイル）', () => {
  it('並べた順に探し、実行できるものを返す。無ければ null', () => {
    const a = tmp();
    const b = tmp();
    const tool = writeFakeTool(b, 'mytool', { sh: 'echo ok', cmd: '@echo ok' });
    expect(findInDirs('mytool', [a, b])).toBe(tool);
    expect(findInDirs('nope', [a, b])).toBeNull();
    expect(findInDirs('mytool', [])).toBeNull();
  });
  // 空白と日本語を含む置き場（C:\Program Files、C:\Users\山田）でも見つける。
  it('空白と日本語を含むディレクトリでも見つける', () => {
    const d = path.join(tmp(), 'Program Files 山田');
    fs.mkdirSync(d);
    const tool = writeFakeTool(d, 'mytool', { sh: 'echo ok', cmd: '@echo ok' });
    expect(findInDirs('mytool', [d])).toBe(tool);
  });
  it.runIf(process.platform === 'win32')('Windows では拡張子を付けた名前でも、付けない名前でも見つける', () => {
    const d = tmp();
    const tool = writeFakeTool(d, 'mytool', { sh: 'echo ok', cmd: '@echo ok' });
    expect(findInDirs('mytool.cmd', [d])).toBe(tool);
    expect(findInDirs('MYTOOL', [d])?.toLowerCase()).toBe(tool.toLowerCase());
    fs.writeFileSync(path.join(d, 'readme.txt'), 'x');
    expect(findInDirs('readme.txt', [d])).toBeNull();
  });
});
```

- [ ] **Step 2: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/platform/exec.test.ts`
Expected: FAIL（`./exec.ts` と `fake-bin.ts` が無い）。

- [ ] **Step 3: 試験の補助と実装を書く**

`packages/server/test/fake-bin.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * 偽のコマンドを置く。macOS と Linux は sh のスクリプト、Windows は .cmd である。
 * .cmd は引数の改行や引用符を正しく渡せないので、決まった引数（-V など）で呼ぶ道具の代役にだけ使う。
 */
export function writeFakeTool(dir: string, name: string, body: { sh: string; cmd: string }, mode = 0o755): string {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const p = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(p, `@echo off\r\n${body.cmd}\r\n`);
    return p;
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body.sh}\n`, { mode });
  fs.chmodSync(p, mode);
  return p;
}
```

`packages/server/src/platform/exec.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 道具（tmux、claude、code、node）の探し方。OS で変わるのは、PATH の区切り、実行できるかの見分け方、既知の置き場である。

/** PATH を項目に分ける。空の項目は飛ばす。Windows では項目を囲む引用符を外す。 */
export function splitPathEnv(pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const items = (pathEnv ?? '').split(platform === 'win32' ? ';' : ':');
  return items.map((s) => (platform === 'win32' ? s.trim().replace(/^"(.*)"$/, '$1') : s)).filter(Boolean);
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** 名前に補う拡張子。Windows 以外は補わないので、空文字 1 つを返す。 */
export function pathExts(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [''];
  const raw = env.PATHEXT && env.PATHEXT.trim() !== '' ? env.PATHEXT : DEFAULT_PATHEXT;
  return raw.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 実行できるファイルか。
 * macOS と Linux は実行権を見る。Windows には実行権が無いので、拡張子が PATHEXT にあるかで見る。
 */
export function isExecutableFile(p: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform === 'win32') return pathExts(env, platform).includes(path.extname(p).toLowerCase());
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 並べたディレクトリから、実行できるファイルとしてのコマンドを順に探す。 */
export function findInDirs(cmd: string, dirs: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const exts = pathExts(env, platform);
  // 拡張子まで書かれた名前（psmux.exe）は、そのまま探す。
  const names = platform === 'win32' && !exts.includes(path.extname(cmd).toLowerCase()) ? exts.map((e) => cmd + e) : [cmd];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isExecutableFile(p, env, platform)) return p;
    }
  }
  return null;
}

/**
 * PATH に無くても見に行く置き場。
 * macOS の .app は PATH が /usr/bin:/bin:/usr/sbin:/sbin だけになる。Windows でも、入れた直後の道具は動いているプロセスの PATH に無い。
 * claude のネイティブ版はどの OS でもホームの .local/bin に入る。Windows の winget は Links に別名を置く。
 */
export function knownDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, homedir: string = os.homedir()): string[] {
  if (platform === 'win32') {
    const home = env.USERPROFILE ?? homedir;
    const dirs = [path.join(home, '.local', 'bin')];
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    return dirs;
  }
  const home = env.HOME ?? homedir;
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')];
}

/**
 * 設定の値がコマンドの名前（tmux など）か。
 * 区切りを含まず ~ で始まらないものは、起動のときに PATH から探す。Windows ではドライブの指定（C:）も名前ではない。
 */
export function isCommandName(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (p.startsWith('~') || p.includes('/')) return false;
  if (platform === 'win32' && (p.includes('\\') || /^[A-Za-z]:/.test(p))) return false;
  return true;
}

/** .cmd と .bat は、Node が直には起こせない。cmd.exe を通す必要がある。 */
export function needsShell(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}

/** tmux の役を担う道具の名前。Windows では psmux を先に探す。psmux は tmux という別名でも入る。 */
export function MUX_NAMES(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['psmux', 'tmux'] : ['tmux'];
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/platform/exec.test.ts`
Expected: PASS（macOS では `it.runIf(win32)` の 1 件がスキップ）。

- [ ] **Step 5: `config/tools.ts` を差し替える**

`KNOWN_DIRS`、`homeDirs`、`findIn` を消し、次に置き換える。`resolveToolPaths` の中の `whichFn('tmux')` も変える。

```ts
import type { Settings } from './paths.ts';
import { findInDirs, knownDirs, MUX_NAMES, splitPathEnv } from '../platform/exec.ts';

/** PATH を読む。Windows の環境変数は大文字小文字を区別しないが、試験が渡す素のオブジェクトは区別する。 */
const pathOf = (env: NodeJS.ProcessEnv): string | undefined => env.PATH ?? env.Path;

/**
 * PATH だけからコマンドの絶対パスを探す。
 * 名前だけの設定（tmux など）は、起動のときに子プロセスが PATH から探すので、確かめるときも同じ所だけを見る。
 */
export function findOnPath(cmd: string, pathEnv: string | undefined = pathOf(process.env)): string | null {
  return findInDirs(cmd, splitPathEnv(pathEnv));
}

/** 子プロセスを起こさずにコマンドの絶対パスを探す。GUI 起動の貧弱な PATH でも、既知の置き場を見る。 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return findInDirs(cmd, [...splitPathEnv(pathOf(env)), ...knownDirs(env)], env);
}

/** tmux の役を担う道具を探す。Windows では psmux を先に見る。 */
export function whichMux(whichFn: (cmd: string) => string | null = which): string | null {
  for (const name of MUX_NAMES()) {
    const found = whichFn(name);
    if (found) return found;
  }
  return null;
}
```

`resolveToolPaths` の最後の行：

```ts
  return { ...s, tmuxPath: s.tmuxPath ?? whichMux(whichFn), codePath: s.codePath ?? whichFn('code'), claudePath, toolsResolved: true };
```

`resolveToolPaths` の前のコメント（`探すのは最初の一度だけ` で始まるもの）は残す。

- [ ] **Step 6: `config/readiness.ts` を差し替える**

- 手元の `isCommandName` を消し、`import { isCommandName, isExecutableFile, needsShell } from '../platform/exec.ts';` から使う。ほかのファイルが `readiness.ts` から `isCommandName` を取り込んでいれば、`export { isCommandName } from '../platform/exec.ts';` を残す。
- `expandHome` は Windows の区切りも受ける。

```ts
export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (p === '~') return homeDir;
  return p.startsWith('~/') || p.startsWith('~\\') ? path.join(homeDir, p.slice(2)) : p;
}
```

- `checkToolPath` の実行権の検査を置き換える。

```ts
  if (!st.isFile()) return { path: full, ok: false, problem: 'notFile' };
  if (!isExecutableFile(full)) return { path: full, ok: false, problem: 'notExecutable' };
  return { path: full, ok: true, problem: null };
```

- `ToolVersions.get` の `execFile` の呼び出しを、`.cmd` も起こせる形にする。引数は hangar が決めた固定の語（`-V`、`--version`）だけなので、シェルを通しても引用の心配は無い。

```ts
    const viaShell = needsShell(file);
    const v = await new Promise<string | null>((resolve) => {
      execFile(viaShell ? `"${file}"` : file, args, { timeout: this.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, shell: viaShell, windowsHide: true }, (err, stdout, stderr) => {
```

- [ ] **Step 7: 試験の偽の道具を両方の OS で動く形にする**

`packages/server/src/config/readiness.test.ts` の `fakeTool` を置き換える。

```ts
import { writeFakeTool } from '../../test/fake-bin.ts';

/** 版を 1 行だけ出す偽のコマンドを置く。 */
function fakeTool(name: string, line: string, mode = 0o755): string {
  return writeFakeTool(path.join(tmp, 'bin'), name, { sh: `echo '${line}'`, cmd: `echo ${line}` }, mode);
}
```

同じファイルで、`fs.writeFileSync(p, '#!/bin/sh\n...')` と直に書いている偽の道具（`slow`、`count`、`late`、`grow`、`touch`）も `writeFakeTool` に直す。本体は次のとおり。

| 名前 | sh | cmd |
|---|---|---|
| `slow` | `sleep 5\necho 1.0` | `ping -n 6 127.0.0.1 > nul\r\necho 1.0` |
| `count` | `echo x >> '${log}'\necho 1.0` | `echo x>> "${log}"\r\necho 1.0` |
| `late` | `if [ -f '${flag}' ]; then echo 2.0; fi` | `if exist "${flag}" echo 2.0` |
| 書き直し（`1.10`、`1.2`） | `echo '1.10'` | `echo 1.10` |

`writeFakeTool` は Windows で `.cmd` を付けたパスを返すので、戻り値をそのまま `v.get(p, ...)` に渡す。

期待値を OS の形にする。

```ts
// 前
expect(expandHome('~/workspace', '/Users/me')).toBe('/Users/me/workspace');
// 後
expect(expandHome('~/workspace', '/Users/me')).toBe(path.join('/Users/me', 'workspace'));
```

`'/ を含まない名前は PATH から探す'` の PATH は `path.delimiter` でつなぐ。

```ts
expect(checkToolPath('tmux', tmp, ['/no/such/dir', bin].join(path.delimiter))).toEqual({ path: ok, ok: true, problem: null });
```

実行権の無いファイルを `notExecutable` と見る 2 つの検査（`fakeTool('plain', 'x', 0o644)` を使う行）は、Windows には実行権が無いので `if (process.platform !== 'win32')` で囲む。Windows 向けに、拡張子で見る検査を足す。

```ts
it.runIf(process.platform === 'win32')('Windows では、PATHEXT に無い拡張子のファイルを実行できないと見る', () => {
  const txt = path.join(tmp, 'notes.txt');
  fs.writeFileSync(txt, 'x');
  expect(checkToolPath(txt, tmp)).toMatchObject({ ok: false, problem: 'notExecutable' });
});
```

`packages/server/src/config/tools.test.ts`：

```ts
import { writeFakeTool } from '../../test/fake-bin.ts';
import { isWindows } from '../../test/platform.ts';

it('PATH の順に探し、実行できるものを返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-which-'));
  const tool = writeFakeTool(dir, 'mytool', { sh: '', cmd: '' });
  // 実行できないもの。macOS と Linux は実行権が無いファイル、Windows は PATHEXT に無い拡張子のファイルである。
  fs.writeFileSync(path.join(dir, isWindows ? 'noexec.txt' : 'noexec'), '', { mode: 0o644 });
  expect(which('mytool', { PATH: dir })).toBe(tool);
  expect(which(isWindows ? 'noexec.txt' : 'noexec', { PATH: dir })).toBeNull();
  expect(which('definitely-not-a-command-xyz', { PATH: dir })).toBeNull();
  fs.rmSync(dir, { recursive: true, force: true });
});
// /bin/sh は Unix にしか無い。Windows の既知の置き場は次の試験が見る。
posixIt('PATH に無くても既知の場所を見る', () => {
  expect(['/bin/sh', '/usr/bin/sh']).toContain(which('sh', { PATH: '' }));
});
```

`~/.local/bin` の試験は、`writeFakeTool` で置き、`{ PATH: '', HOME: home, USERPROFILE: home }` を渡す。`~/.claude/local` は Windows の既知の置き場に入れていないので、その 1 行は `if (!isWindows)` で囲む。

`whichMux` の試験を足す。

```ts
describe('whichMux', () => {
  it('その OS の名前を順に探し、最初に見つかったものを返す', () => {
    const asked: string[] = [];
    const found = whichMux((c) => { asked.push(c); return c === 'tmux' ? '/x/tmux' : null; });
    expect(found).toBe('/x/tmux');
    expect(asked).toEqual(process.platform === 'win32' ? ['psmux', 'tmux'] : ['tmux']);
    expect(whichMux(() => null)).toBeNull();
  });
});
```

- [ ] **Step 8: 両方の OS で確かめる**

macOS：

Run: `npx vitest run packages/server/src/config packages/server/src/platform packages/server/src/http`
Expected: PASS。

Windows：

Run: `run-tests.ps1 packages/server/src/config/tools.test.ts packages/server/src/config/readiness.test.ts packages/server/src/platform packages/server/src/http/app.test.ts`
Expected: `tools.test.ts` と `readiness.test.ts` が全部通る。`app.test.ts` は、道具のパスに関わる 404、418、1191 行が通る。残った失敗は一覧にして Task 8 へ回す。

- [ ] **Step 9: コミット**

```bash
git add packages/server/src/platform/exec.ts packages/server/src/platform/exec.test.ts packages/server/test/fake-bin.ts packages/server/src/config/tools.ts packages/server/src/config/tools.test.ts packages/server/src/config/readiness.ts packages/server/src/config/readiness.test.ts
git commit -m "feat(server): find tools on Windows (PATH, PATHEXT, known dirs) and prefer psmux there"
```

---

### Task 4: 秘密のファイルの扱いを platform/secure.ts に集める

**Files:**
- Create: `packages/server/src/platform/secure.ts`
- Test: `packages/server/src/platform/secure.test.ts`
- Modify: `packages/server/src/config/paths.ts:71-78`、`packages/server/src/config/statusline.ts:48-51`、`packages/server/src/config/claudeJson.ts:87-93`、`packages/server/src/launch/wrapper.ts:38-39`
- Modify（試験）: モードを直に比べている試験。下の一覧。

**Interfaces:**
- Consumes: `packages/server/test/platform.ts` の `expectMode`、`posixIt`。
- Produces:
  - `modeOf(file: string, platform?: NodeJS.Platform): number | null` Windows と、無いファイルは `null`。
  - `isLoose(file: string, platform?: NodeJS.Platform): boolean` 本人以外に読める権限か。Windows は常に `false`。
  - `hasMode(file: string, mode: number, platform?: NodeJS.Platform): boolean` Windows は、ファイルがあれば `true`。
  - `ensureMode(file: string, mode: number, platform?: NodeJS.Platform): void` Windows は何もしない。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/platform/secure.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../test/platform.ts';
import { ensureMode, hasMode, isLoose, modeOf } from './secure.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-secure-'));
  file = path.join(dir, 'token');
  fs.writeFileSync(file, 'x', { mode: 0o644 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('Windows の扱い', () => {
  // Node は Windows でモードを 0666 か 0444 としか返さない。比べると常に「緩い」になるので、比べない。
  it('モードを読まず、緩いとも言わず、直しもしない', () => {
    expect(modeOf(file, 'win32')).toBeNull();
    expect(isLoose(file, 'win32')).toBe(false);
    expect(hasMode(file, 0o600, 'win32')).toBe(true);
    const before = fs.statSync(file).mode;
    ensureMode(file, 0o600, 'win32');
    expect(fs.statSync(file).mode).toBe(before);
  });
  it('無いファイルは、モードが合っているとは言わない', () => {
    expect(hasMode(path.join(dir, 'nope'), 0o600, 'win32')).toBe(false);
    expect(modeOf(path.join(dir, 'nope'), 'win32')).toBeNull();
  });
});

describe('macOS と Linux の扱い', () => {
  posixIt('モードを読み、緩ければ直す', () => {
    expect(modeOf(file)).toBe(0o644);
    expect(isLoose(file)).toBe(true);
    expect(hasMode(file, 0o600)).toBe(false);
    ensureMode(file, 0o600);
    expect(modeOf(file)).toBe(0o600);
    expect(isLoose(file)).toBe(false);
    expect(hasMode(file, 0o600)).toBe(true);
  });
  posixIt('無いファイルは null と false を返し、投げない', () => {
    const nope = path.join(dir, 'nope');
    expect(modeOf(nope)).toBeNull();
    expect(isLoose(nope)).toBe(false);
    expect(hasMode(nope, 0o600)).toBe(false);
    expect(() => ensureMode(nope, 0o600)).not.toThrow();
  });
});
```

- [ ] **Step 2: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/platform/secure.test.ts`
Expected: FAIL（`./secure.ts` が無い）。

- [ ] **Step 3: 実装する**

`packages/server/src/platform/secure.ts`

```ts
import fs from 'node:fs';

// 本人だけが読めるファイルの扱い。
// macOS と Linux はモード（0600、0700）で絞る。
// Windows の Node はモードを 0666 か 0444 としか返さず、chmod も読み取り専用の切り替えしかできない。
// Windows では置き場をユーザーのプロファイルの下にして、その権限を受け継ぐことで守る。ここではモードを読まないし、直さない。

/** モードの下 9 ビット。Windows と、無いファイルは null。 */
export function modeOf(file: string, platform: NodeJS.Platform = process.platform): number | null {
  if (platform === 'win32') return null;
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ? st.mode & 0o777 : null;
}

/** 本人以外にも読み書きできる権限か。 */
export function isLoose(file: string, platform: NodeJS.Platform = process.platform): boolean {
  const m = modeOf(file, platform);
  return m !== null && (m & 0o077) !== 0;
}

/** モードが合っているか。Windows は、ファイルがあれば合っているとする。 */
export function hasMode(file: string, mode: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return fs.existsSync(file);
  return modeOf(file, platform) === mode;
}

/** モードが違えば直す。無いファイルと Windows では何もしない。 */
export function ensureMode(file: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  const m = modeOf(file, platform);
  if (m !== null && m !== mode) fs.chmodSync(file, mode);
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/platform/secure.test.ts`
Expected: PASS。

- [ ] **Step 5: モードを比べている 4 か所を差し替える**

`packages/server/src/config/paths.ts` の `ensureHome`：

```ts
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (isLoose(home)) fs.chmodSync(home, 0o700);
```

`packages/server/src/config/statusline.ts` の `ensureStatuslineHeaderFile`：

```ts
    const ok = fs.readFileSync(file, 'utf8') === `Authorization: Bearer ${token}\n` && hasMode(file, 0o600);
```

`packages/server/src/config/claudeJson.ts` の `writeJsonObject`：

```ts
  const exists = fs.existsSync(realFile);
  const cur = exists ? modeOf(realFile) : null;
  // 新しく作るときは 0600。既にあるときは利用者が決めた権限をそのまま使う。
  // ただしここにはトークンを書くので、他人にも読める権限のままでは書かない。
  // Windows ではモードを読めないので、狭めたとは言わない。
  const tightened = exists && isLoose(realFile);
  const mode = cur === null || tightened ? 0o600 : cur;
```

`packages/server/src/launch/wrapper.ts` の `ensureWrapperScript`：

```ts
  ensureMode(file, 0o755);
```

それぞれ `import { ... } from '../platform/secure.ts';` を足す。

- [ ] **Step 6: 試験のモードの比較を `expectMode` に替える**

次のファイルで、`expect(fs.statSync(x).mode & 0o777).toBe(M)` の形を `expectMode(x, M)` に替える。`import { expectMode } from '../../test/platform.ts';`（深さはファイルに合わせる）を足す。cli の試験は `'../../server/test/platform.ts'` から取り込む。

| ファイル | 行（2026-10-05 の失敗の位置） |
|---|---|
| `packages/server/src/config/paths.test.ts` | 21、36 |
| `packages/server/src/config/claudeJson.test.ts` | 35 ほか 3 か所 |
| `packages/server/src/config/cloud.test.ts` | 14、32 |
| `packages/server/src/config/statusline.test.ts` | 89、318 ほか |
| `packages/server/src/config/claudeFileWrite.test.ts` | 23 |
| `packages/server/src/config/retention.test.ts` | 139、155 |
| `packages/server/src/launch/mcpConfig.test.ts` | 25 |
| `packages/server/src/launch/wrapper.test.ts` | 23 |
| `packages/server/src/indexer/service.test.ts` | 213 |
| `packages/server/src/sync/apply.test.ts` | 305 |
| `packages/server/src/sync/puller.test.ts` | 225 |
| `packages/server/src/sync/claudeConfig.test.ts` | 786 |
| `packages/server/src/external/open.test.ts` | 28 |
| `packages/server/src/server.test.ts` | 325 |
| `packages/cli/src/cloud.test.ts` | 142 |
| `packages/cli/src/mcp.test.ts` | 117 |
| `packages/cli/src/statusline.test.ts` | 103 |

モードを比べているのが `stat` の結果を変数に取ってからの式なら、その式を `if (!isWindows)` で囲む。

`packages/server/src/config/statusline.test.ts:126` の「中身と権限が合っていれば書き直さない」は、Step 5 で `hasMode` に替えたので Windows でも通る。通らなければ、`ensureStatuslineHeaderFile` がまだモードを直に比べている。

`packages/cli/src/mcp.test.ts:117` の「0600 へ狭めて告げる」は、Windows では狭めないので `posixIt` にする。理由をコメントで書く。

```ts
// Windows ではモードを読めないので、狭めたとは告げない。
posixIt('他人にも読める設定ファイルは、トークンを書く前に 0600 へ狭めて告げる', () => {
```

- [ ] **Step 7: 両方の OS で確かめる**

macOS：

Run: `npm test`
Expected: PASS。

Windows：

Run: `run-tests.ps1`
Expected: 失敗の文に `expected 438 to be` が 1 件も残らない。次で数える。

```bash
node -e "const r=require('./vitest.json');let n=0;for(const f of r.testResults)for(const a of f.assertionResults)if(a.status==='failed'&&/expected 438 to be/.test(a.failureMessages[0]||''))n++;console.log(n)"
```

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/platform/secure.ts packages/server/src/platform/secure.test.ts packages/server/src packages/cli/src
git commit -m "fix(server): stop comparing file modes on Windows, where Node cannot read them"
```

---

### Task 5: プロセスの照合と止め方を platform/proc.ts に集める

**Files:**
- Create: `packages/server/src/platform/proc.ts`
- Test: `packages/server/src/platform/proc.test.ts`
- Modify: `packages/server/src/runs/procs.ts:21-66`
- Test: `packages/server/src/runs/procs.test.ts`

**Interfaces:**
- Produces:
  - `startTimeOf(pid: number, platform?: NodeJS.Platform, run?: ProcRun): string | null`
  - `parseStartTime(s: string): number | null` epoch のミリ秒。`ps` の lstart と、Windows の 100 ナノ秒単位の整数の両方を読む。
  - `sameStartTime(a: string, b: string): boolean`
  - `isAlive(pid: number): boolean`
  - `terminate(pid: number, timeoutMs: number, platform?: NodeJS.Platform, run?: ProcRun): Promise<boolean>`
  - `type ProcRun = (file: string, args: string[], env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string }`
- `runs/procs.ts` は `sameStartTime` と `parseProcStart` の名前を、同じ意味のまま出し続ける（`parseProcStart` は `parseStartTime` の別名）。

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/platform/proc.test.ts`

```ts
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isAlive, parseStartTime, sameStartTime, startTimeOf, terminate, type ProcRun } from './proc.ts';

describe('parseStartTime', () => {
  it('ps の lstart を UTC として読む', () => {
    expect(parseStartTime('Thu Oct  2 02:30:05 2026')).toBe(Date.UTC(2026, 9, 2, 2, 30, 5));
  });
  // Windows の Claude Code は、1601 年からの 100 ナノ秒単位の整数を文字列で書く（2026-10-05 実測）。
  it('Windows の 100 ナノ秒単位の整数を読む', () => {
    // 2026-10-02T08:40:35.0009738Z
    expect(parseStartTime('134354040350009738')).toBe(Date.UTC(2026, 9, 2, 8, 40, 35, 0));
  });
  it('読めないものは null', () => {
    expect(parseStartTime('')).toBeNull();
    expect(parseStartTime('12345')).toBeNull();
    expect(parseStartTime('Thu Feb 30 02:30:05 2026')).toBeNull();
  });
});

describe('sameStartTime', () => {
  it('空白の並びの違いを吸い、数値は文字列として比べる', () => {
    expect(sameStartTime('Thu Oct  2 02:30:05 2026', 'Thu Oct 2 02:30:05 2026')).toBe(true);
    expect(sameStartTime('134354040350009738', ' 134354040350009738\r\n')).toBe(true);
    expect(sameStartTime('134354040350009738', '134354040350009739')).toBe(false);
  });
});

describe('startTimeOf（偽の実行）', () => {
  it('Windows は PowerShell に聞き、数字だけの答えを返す', () => {
    const calls: { file: string; args: string[] }[] = [];
    const run: ProcRun = (file, args) => { calls.push({ file, args }); return { status: 0, stdout: '134354040350009738\r\n' }; };
    expect(startTimeOf(6196, 'win32', run)).toBe('134354040350009738');
    expect(calls[0]!.file).toBe('powershell.exe');
    expect(calls[0]!.args.join(' ')).toContain('Get-Process -Id 6196');
  });
  // 聞く前に相手が消えたとき。PowerShell は失敗で終わる。
  it('相手が居なければ null', () => {
    expect(startTimeOf(6196, 'win32', () => ({ status: 1, stdout: '' }))).toBeNull();
    expect(startTimeOf(6196, 'win32', () => ({ status: 0, stdout: 'Get-Process : ...' }))).toBeNull();
    expect(startTimeOf(6196, 'darwin', () => ({ status: 1, stdout: '' }))).toBeNull();
  });
  it('整数でない pid は、何も起こさずに null', () => {
    let called = false;
    const run: ProcRun = () => { called = true; return { status: 0, stdout: '1' }; };
    expect(startTimeOf(1.5, 'win32', run)).toBeNull();
    expect(startTimeOf(-1, 'darwin', run)).toBeNull();
    expect(startTimeOf(Number.NaN, 'win32', run)).toBeNull();
    expect(called).toBe(false);
  });
});

describe('実物のプロセス', () => {
  it('起動時刻を読み、止めて終わるまで待つ', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise((r) => child.once('exit', r));
    try {
      const started = startTimeOf(pid);
      expect(started).not.toBeNull();
      expect(Math.abs(parseStartTime(started!)! - Date.now())).toBeLessThan(15_000);
      // 2 回聞いても同じ値。PID の使い回しを見分ける鍵になる。
      expect(sameStartTime(started!, startTimeOf(pid)!)).toBe(true);
      expect(isAlive(pid)).toBe(true);
      const done = terminate(pid, 5000);
      await exited;
      expect(await done).toBe(true);
      expect(isAlive(pid)).toBe(false);
      expect(startTimeOf(pid)).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 20_000);
});
```

- [ ] **Step 2: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/platform/proc.test.ts`
Expected: FAIL（`./proc.ts` が無い）。

- [ ] **Step 3: 実装する**

`packages/server/src/platform/proc.ts`

```ts
import { spawnSync } from 'node:child_process';

// hangar の外で動くプロセスの見分け方と止め方。
// Claude Code は ~/.claude/sessions/<pid>.json に procStart を書く。PID は使い回されるので、起動時刻が合うことで同じプロセスだと確かめる。
// macOS と Linux の procStart は UTC の ps の lstart（Thu Oct  2 02:30:05 2026）、
// Windows は 1601 年からの 100 ナノ秒単位の整数（134354040350009738）である。

export type ProcRun = (file: string, args: string[], env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string };

const realRun: ProcRun = (file, args, env) => {
  const r = spawnSync(file, args, { encoding: 'utf8', env: env ?? process.env, windowsHide: true, timeout: 10_000 });
  return { status: r.status, stdout: r.stdout ?? '' };
};

const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0;

/** pid の起動時刻を、Claude の procStart と同じ書式で返す。居なければ null。 */
export function startTimeOf(pid: number, platform: NodeJS.Platform = process.platform, run: ProcRun = realRun): string | null {
  // pid はコマンドの文に埋めるので、整数であることを先に確かめる。
  if (!validPid(pid)) return null;
  if (platform === 'win32') {
    const script = `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { exit 1 }`;
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const out = r.stdout.trim();
    return r.status === 0 && /^\d+$/.test(out) ? out : null;
  }
  // Claude は procStart を UTC で書く。手元の時刻帯で読むと、同じプロセスでも時刻がずれる。
  const r = run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, TZ: 'UTC', LC_ALL: 'C' });
  const out = r.stdout.trim();
  return r.status === 0 && out !== '' ? out : null;
}

/** 書式の揺れを吸う。ps は 1 桁の日を空白で埋めるので、空白の並びを 1 つにまとめて比べる。 */
export function sameStartTime(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 1601-01-01 から 1970-01-01 までのミリ秒。 */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;

/** 起動時刻を epoch のミリ秒に読む。読めなければ null。秒より細かい精度は持たない。 */
export function parseStartTime(s: string): number | null {
  const t = s.trim();
  // 17 桁から 19 桁の整数は Windows の書式。1970 年より後なら 17 桁以上になる。
  if (/^\d{17,19}$/.test(t)) {
    const ms = BigInt(t) / 10_000n - FILETIME_EPOCH_MS;
    return Number(ms - (ms % 1000n));
  }
  const m = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(t);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  const [day, h, min, sec, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  if (month < 0 || h > 23 || min > 59 || sec > 59) return null;
  const at = Date.UTC(year, month, day, h, min, sec);
  // 2 月 30 日のような暦に無い日は、Date.UTC が翌月へ繰り越すので見分けられる。
  return new Date(at).getUTCDate() === day ? at : null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM は「居るが触れない」。居ないのは ESRCH だけである。
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 止めて、終わるまで待つ。timeoutMs のうちに終われば true。
 * macOS と Linux は SIGTERM を送る。Windows には SIGTERM が無いので、taskkill でプロセスの木ごと止める。
 */
export async function terminate(pid: number, timeoutMs: number, platform: NodeJS.Platform = process.platform, run: ProcRun = realRun): Promise<boolean> {
  if (!validPid(pid)) return false;
  if (platform === 'win32') {
    run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return !isAlive(pid);
    }
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/platform/proc.test.ts`
Expected: PASS。

- [ ] **Step 5: `runs/procs.ts` を差し替える**

`sameStartTime`、`MONTHS`、`parseProcStart`、`alive`、`sleep` の本体を消し、platform の層から出す。

```ts
import { execFile, spawnSync } from 'node:child_process';
import { parseStartTime, sameStartTime, startTimeOf, terminate } from '../platform/proc.ts';

export { sameStartTime };
/** Claude の procStart を epoch のミリ秒に読む。読めなければ null。 */
export const parseProcStart = parseStartTime;
```

`realProcOps` の 2 つを置き換える。`listJobs` と `runClaude` には `windowsHide: true` を足す。

```ts
export const realProcOps: ProcOps = {
  startTimeOf: (pid) => startTimeOf(pid),
  terminate: (pid, timeoutMs) => terminate(pid, timeoutMs),
```

`ProcOps` の型のコメントを直す。

```ts
  /** pid の起動時刻。Claude のレジストリの procStart と同じ書式で返す（macOS と Linux は UTC の ps の lstart、Windows は 100 ナノ秒単位の整数）。居なければ null。 */
  startTimeOf(pid: number): string | null;
  /** 止めて、終わるまで待つ。timeoutMs のうちに終われば true。 */
  terminate(pid: number, timeoutMs: number): Promise<boolean>;
```

- [ ] **Step 6: 既存の試験を OS に合わせる**

`packages/server/src/runs/procs.test.ts:58` の「起動時刻を読み、SIGTERM で止めて終わるまで待つ」は、子を `sh` や `sleep` で起こしていれば、`spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])` に替える。`finally` の `child.kill('SIGKILL')` は `child.kill()` にする（Windows は `SIGKILL` を `kill EINVAL` で断る）。題は「起動時刻を読み、止めて終わるまで待つ」にする。

- [ ] **Step 7: 両方の OS で確かめる**

macOS：

Run: `npx vitest run packages/server/src/runs packages/server/src/platform packages/server/src/sessions packages/server/src/provider`
Expected: PASS。

Windows：

Run: `run-tests.ps1 packages/server/src/runs/procs.test.ts packages/server/src/platform/proc.test.ts`
Expected: PASS。`実物のプロセス` の試験が走って通る（スキップではない）。

Windows で、実物の Claude の登録と突き合わせる。動いている claude の PID を `~/.claude/sessions` から 1 つ選ぶ。

```powershell
Set-Location D:\workspace\agent-hangar
$j = Get-ChildItem "$env:USERPROFILE\.claude\sessions\*.json" | Select-Object -First 1 | Get-Content -Raw | ConvertFrom-Json
node --import tsx -e "import('./packages/server/src/platform/proc.ts').then(m => console.log(m.sameStartTime(m.startTimeOf($($j.pid)), '$($j.procStart)')))"
```

Expected: `true`。

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/platform/proc.ts packages/server/src/platform/proc.test.ts packages/server/src/runs/procs.ts packages/server/src/runs/procs.test.ts
git commit -m "feat(server): read process start times and stop processes on Windows"
```

---

### Task 6: psmux を Tmux クラスで使う

**Files:**
- Modify: `packages/server/src/tmux/tmux.ts`（`ensureTerminalOptions`、`enableClipboard`、`listSessions`）
- Test: `packages/server/src/tmux/tmux.test.ts`
- Create: `packages/server/src/tmux/psmux.win.test.ts`
- Create: `packages/server/test/psmux.ts`

**Interfaces:**
- Consumes: Task 1 の `Tmux` の `platform` と `exec`、Task 3 の `whichMux`。
- Produces: `packages/server/test/psmux.ts` の `PSMUX: string | null`（Windows で psmux があるときだけ値を持つ）と `psmuxNamespace(): string`（試験ごとの `-L` の名前）。Task 7 の試験が使う。

- [ ] **Step 1: psmux の実際の答えを確かめる**

Windows で次を走らせ、出力を控える。Step 3 の実装と Step 2 の試験は、この結果に合わせる。

```powershell
$ns = "hangar-probe-$PID"
"== list-sessions（サーバ無し） =="; psmux -L $ns list-sessions -F "#{session_name}"; "exit=$LASTEXITCODE"
psmux -L $ns new-session -d -s probe -- cmd.exe
foreach ($k in 'copy-command','extended-keys','extended-keys-format','terminal-features','set-clipboard') { "$k = [" + (psmux -L $ns show-options -s -v $k 2>&1) + "] exit=$LASTEXITCODE" }
"== list-keys =="; psmux -L $ns list-keys -T root S-Enter 2>&1; "exit=$LASTEXITCODE"
"== bind-key =="; psmux -L $ns bind-key -n S-Enter send-keys Escape Enter 2>&1; "exit=$LASTEXITCODE"
psmux -L $ns kill-session -t "=probe"
```

2026-10-05 に分かっていること：サーバが無いときの `list-sessions` は、何も出さずに exit 0 で終わる。`show-options -s -v` は `set-clipboard` が `on`、`copy-command`、`extended-keys`、`terminal-features` が空で、どれも exit 0 だった。

- [ ] **Step 2: 失敗する試験を書く**

`packages/server/src/tmux/tmux.test.ts` に足す。

```ts
describe('Tmux.ensureTerminalOptions（偽の実行）', () => {
  const recorder = (answers: Record<string, string>) => {
    const calls: string[][] = [];
    const exec: TmuxExec = (_f, a) => {
      calls.push(a);
      const key = a.join(' ');
      return { status: 0, stdout: answers[key] ?? '', stderr: '' };
    };
    return { calls, exec };
  };
  // pbcopy は macOS のコマンド。extended-keys と S-Enter の割り当ては、iTerm2 などの外の端末から tmux へつなぐための調整である。
  // Windows の psmux には入れない。Windows Terminal から psmux へつないで Shift+Enter が改行になることは、実機で確かめてある。
  it('Windows では、サーバの設定を何も書き換えない', () => {
    const { calls, exec } = recorder({});
    new Tmux({ tmuxPath: 'psmux', platform: 'win32', exec }).ensureTerminalOptions();
    expect(calls.filter((a) => a.includes('set-option') || a.includes('bind-key'))).toEqual([]);
  });
  it('macOS では、空の copy-command に pbcopy を入れる', () => {
    const { calls, exec } = recorder({ 'show-options -s -v extended-keys': 'on' });
    new Tmux({ tmuxPath: 'tmux', platform: 'darwin', exec }).ensureTerminalOptions();
    expect(calls).toContainEqual(['set-option', '-s', 'copy-command', 'LC_CTYPE=UTF-8 pbcopy']);
  });
});
```

`import { Tmux, type TmuxExec } from './tmux.ts';` にする。

Step 1 で、Windows Terminal から psmux の中の claude へ Shift+Enter を打って改行にならなかった場合は、この試験の「何も書き換えない」を外し、Step 1 で通った `bind-key` の形を期待値にする。

- [ ] **Step 3: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/tmux/tmux.test.ts -t ensureTerminalOptions`
Expected: FAIL（Windows でも `set-option` と `bind-key` を呼ぶ）。

- [ ] **Step 4: `ensureTerminalOptions` を OS で分ける**

`packages/server/src/tmux/tmux.ts` の `ensureTerminalOptions` の先頭に足す。コメントも足す。

```ts
  ensureTerminalOptions(): void {
    // ここから下は、macOS の外の端末（iTerm2 など）から tmux へつなぐための調整である。
    // Windows の psmux には入れない。pbcopy は無く、Shift+Enter は Windows Terminal からそのまま通る。
    if (this.platform === 'win32') return;
    const show = (key: string) => this.run('show-options', '-s', '-v', key);
```

その下の `process.platform === 'darwin'` は `this.platform === 'darwin'` に替える。

- [ ] **Step 5: 偽の tmux を使う既存の試験を、偽の実行に替える**

`Tmux.listSessions（偽の tmux）` の 3 件は sh のスクリプトを偽の tmux にしている。Windows では起こせないので、`exec` を差し替える形に書き直す。`fakeTmux` の補助は消す。

```ts
describe('Tmux.listSessions（偽の実行）', () => {
  const tmuxWith = (r: { status: number | null; stdout?: string; stderr?: string; error?: Error }) =>
    new Tmux({ tmuxPath: 'tmux', exec: () => ({ status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }) });
  it('tmux を呼べなければ null を返す', () => {
    expect(tmuxWith({ status: null, error: new Error('ENOENT') }).listSessions()).toBeNull();
  });
  it('サーバが動いていないだけなら空配列を返す', () => {
    expect(tmuxWith({ status: 1, stderr: 'no server running on /tmp/tmux-501/default\n' }).listSessions()).toEqual([]);
  });
  // psmux は、サーバが無いときに何も出さず exit 0 で終わる（2026-10-05 実測）。
  it('何も出さずに成功したら空配列を返す', () => {
    expect(tmuxWith({ status: 0 }).listSessions()).toEqual([]);
  });
  it('それ以外の失敗は null を返す。観測できないことと動いていないことは違う', () => {
    expect(tmuxWith({ status: 1, stderr: 'lost server\n' }).listSessions()).toBeNull();
  });
  it('成功したらセッション名を返す。改行が CRLF でも名前に \\r を残さない', () => {
    expect(tmuxWith({ status: 0, stdout: 'hangar-a\r\nhangar-b\r\n' }).listSessions()).toEqual(['hangar-a', 'hangar-b']);
  });
});
```

`listSessions` の最後の行を、CRLF でも割れる形にする。

```ts
    return r.stdout.split(/\r?\n/).filter(Boolean);
```

`capturePane` は画面の文字をそのまま返すので、行末の `\r` を落とす。

```ts
  capturePane(name: string): string {
    return this.run('capture-pane', '-p', '-t', `=${name}:`).stdout.replace(/\r\n/g, '\n');
  }
```

- [ ] **Step 6: psmux を相手にする試験を書く**

`packages/server/test/psmux.ts`

```ts
import { whichMux } from '../src/config/tools.ts';

/** psmux の絶対パス。Windows で psmux があるときだけ値を持つ。無ければ、psmux を相手にする試験を飛ばす。 */
export const PSMUX: string | null = process.platform === 'win32' ? whichMux() : null;

/**
 * 試験ごとの名前空間。利用者の psmux のセッションに触れないよう、必ず -L で分ける。
 * psmux は -S のパスを無視して既定の名前空間に入る。kill-server は名前空間を越えて全部を落とすので呼ばない。
 * 後始末は、作ったセッションを kill-session で 1 つずつ止める。
 */
export function psmuxNamespace(): string {
  return `hangar-test-${process.pid}-${Date.now().toString(36)}`;
}
```

`packages/server/src/tmux/psmux.win.test.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PSMUX, psmuxNamespace } from '../../test/psmux.ts';
import { waitFor } from '../../test/tmux.ts';
import { nodePtySpawn } from '../pty/nodePty.ts';
import { Tmux } from './tmux.ts';

// Windows の psmux を相手にした確かめ。macOS と Linux、psmux の無い Windows では丸ごと飛ぶ。
describe.skipIf(!PSMUX)('Tmux（実物の psmux）', () => {
  const tmux = new Tmux({ tmuxPath: PSMUX!, socketName: psmuxNamespace() });
  const made: string[] = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-psmux-'));
  const start = (name: string, command: string[], env?: Record<string, string>): void => {
    made.push(name);
    tmux.newSession({ name, cwd, command, env });
  };
  // 止めるのは自分が作ったセッションだけ。kill-server は呼ばない。
  afterEach(() => { while (made.length) tmux.killSession(made.pop()!); });

  it('サーバが無いうちは空の一覧を返す', () => {
    expect(new Tmux({ tmuxPath: PSMUX!, socketName: psmuxNamespace() }).listSessions()).toEqual([]);
  });

  it('切り離して作り、完全一致で見つけ、名指しで止める', async () => {
    start('hangar-a1', ['cmd.exe']);
    start('hangar-a1-t1', ['cmd.exe']);
    expect(tmux.hasSession('hangar-a1')).toBe(true);
    // 前方一致に落ちない。hangar-a は hangar-a1 に当たらない。
    expect(tmux.hasSession('hangar-a')).toBe(false);
    expect(tmux.listSessions()!.sort()).toEqual(['hangar-a1', 'hangar-a1-t1']);
    tmux.killSession('hangar-a1');
    await waitFor(() => !tmux.hasSession('hangar-a1'));
    expect(tmux.hasSession('hangar-a1-t1')).toBe(true);
  });

  it('作業フォルダと環境変数を渡す。日本語の値も壊さない', async () => {
    start('hangar-env', ['cmd.exe', '/k', 'echo [%HANGAR_NOTE%] & cd'], { HANGAR_NOTE: '日本語の値' });
    await waitFor(() => tmux.capturePane('hangar-env').includes('[日本語の値]'), 10_000);
    expect(tmux.capturePane('hangar-env').toLowerCase()).toContain(fs.realpathSync(cwd).toLowerCase());
  });

  it('文字をそのまま送り、画面から読む', async () => {
    start('hangar-keys', ['cmd.exe']);
    await waitFor(() => tmux.capturePane('hangar-keys').includes('>'), 10_000);
    tmux.sendKeys('hangar-keys', '-l', 'echo {q} 日本語');
    tmux.sendKeys('hangar-keys', 'Enter');
    await waitFor(() => tmux.capturePane('hangar-keys').split('\n').some((l) => l.trim() === '{q} 日本語'), 10_000);
  });

  it('無い作業フォルダは、作る前に断る', () => {
    expect(() => tmux.newSession({ name: 'hangar-nocwd', cwd: path.join(cwd, 'nope'), command: ['cmd.exe'] })).toThrow(/cwd not found/);
    expect(tmux.hasSession('hangar-nocwd')).toBe(false);
  });

  // hangar の画面の端末は、接続ごとに node-pty で attach を起こす。2 つのタブで同じセッションを開ける必要がある。
  it('node-pty 越しに 2 つの口からつなぎ、片方が抜けてもセッションは残る', async () => {
    start('hangar-att', ['cmd.exe']);
    const open = () => {
      let out = '';
      const p = nodePtySpawn(tmux.tmuxPath, tmux.attachArgs('hangar-att'), { name: 'xterm-256color', cols: 100, rows: 30, cwd: os.homedir(), env: process.env });
      p.onData((d) => { out += d; });
      return { p, text: () => out };
    };
    const a = open();
    const b = open();
    try {
      await waitFor(() => a.text().length > 0 && b.text().length > 0, 10_000);
      a.p.write('echo from-a\r');
      await waitFor(() => a.text().includes('from-a') && b.text().includes('from-a'), 10_000);
      a.p.kill();
      await new Promise((r) => setTimeout(r, 1000));
      expect(tmux.hasSession('hangar-att')).toBe(true);
      b.p.write('echo from-b\r');
      await waitFor(() => b.text().includes('from-b'), 10_000);
    } finally {
      try { a.p.kill(); } catch { /* 既に終わっている */ }
      try { b.p.kill(); } catch { /* 既に終わっている */ }
    }
  }, 40_000);
});
```

- [ ] **Step 7: 両方の OS で確かめる**

macOS：

Run: `npx vitest run packages/server/src/tmux`
Expected: PASS。`Tmux（実物の psmux）` は丸ごとスキップ。`Tmux（実物）` はいまと同じ件数が通る。

Windows：試験の前後で、利用者の psmux のセッションが変わらないことを見る。

```powershell
"before: " + ((psmux list-sessions 2>&1) -join ',')
# run-tests.ps1 packages/server/src/tmux
"after: " + ((psmux list-sessions 2>&1) -join ',')
Get-ChildItem "$env:USERPROFILE\.psmux" -Filter 'hangar-test-*' | Select-Object -ExpandProperty Name
```

Expected: `Tmux（実物の psmux）` の 6 件が走って通る。`before` と `after` が同じ。`hangar-test-*__hangar-*.port` のような、セッションの名前を含むファイルが残っていない（`__warm__` のファイルは psmux が自分で置くもので、残ってよい）。

node-pty の試験が通らないとき、原因を psmux に帰す前に、`nodePtySpawn` に渡している引数と環境を疑う。`cmd.exe` を直に `nodePtySpawn` で起こして出力が取れるかを先に見る。

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/tmux packages/server/test/psmux.ts
git commit -m "feat(server): drive psmux through the Tmux class on Windows and test it in its own namespace"
```

---

### Task 7: claude を包むスクリプトの Windows 版と、起動のコマンド

**Files:**
- Create: `packages/server/src/launch/hangar-run.mjs`
- Modify: `packages/server/src/launch/wrapper.ts`
- Test: `packages/server/src/launch/wrapper.test.ts`
- Create: `packages/server/src/launch/command.ts`
- Test: `packages/server/src/launch/command.test.ts`
- Modify: `packages/server/src/runs/manager.ts:30-37,194-197,613-615`
- Modify: `apps/desktop/scripts/bundle-server.ts`（`hangar-run.mjs` を同梱に含める。esbuild の束には入らない単独のファイルである）

**Interfaces:**
- Consumes: Task 6 の `PSMUX`、`psmuxNamespace`。
- Produces（`launch/command.ts`）:
  - `runCommand(o: { runId: string; wrapper: string; log: string; command: string[]; platform?: NodeJS.Platform; node?: string }): { command: string[]; env: Record<string, string> }`
  - `shellTabCommand(o: { shell?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string[]`
- Produces（`launch/wrapper.ts`）: `ensureWrapperScript(home: string, platform?: NodeJS.Platform): string` Windows では `<home>\bin\hangar-run.mjs` を返す。

- [ ] **Step 1: 起動のコマンドの失敗する試験を書く**

`packages/server/src/launch/command.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { runCommand, shellTabCommand } from './command.ts';

describe('runCommand', () => {
  it('macOS と Linux は env で HANGAR_RUN_ID を渡し、bash で包みを起こす', () => {
    const r = runCommand({ runId: 'r1', wrapper: '/h/bin/hangar-run.sh', log: '/h/logs/run-r1.log', command: ['/x/claude', '-p', 'やること'], platform: 'darwin' });
    expect(r.command).toEqual(['env', 'HANGAR_RUN_ID=r1', 'bash', '/h/bin/hangar-run.sh', '/h/logs/run-r1.log', '/x/claude', '-p', 'やること']);
    expect(r.env).toEqual({});
  });
  // Windows には env コマンドも bash も無い。包みは Node のスクリプトで、サーバを動かしている Node で起こす。
  it('Windows は Node で包みを起こし、HANGAR_RUN_ID はセッションの環境で渡す', () => {
    const r = runCommand({ runId: 'r1', wrapper: 'C:\\h\\bin\\hangar-run.mjs', log: 'C:\\h\\logs\\run-r1.log', command: ['C:\\Program Files\\x\\claude.exe', '-p', 'やること'], platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe' });
    expect(r.command).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'C:\\h\\bin\\hangar-run.mjs', 'C:\\h\\logs\\run-r1.log', 'C:\\Program Files\\x\\claude.exe', '-p', 'やること']);
    expect(r.env).toEqual({ HANGAR_RUN_ID: 'r1' });
  });
});

describe('shellTabCommand', () => {
  it('macOS と Linux は利用者のログインシェル。無ければ zsh', () => {
    expect(shellTabCommand({ env: { SHELL: '/bin/bash' }, platform: 'darwin' })).toEqual(['/bin/bash', '-l']);
    expect(shellTabCommand({ env: {}, platform: 'darwin' })).toEqual(['/bin/zsh', '-l']);
    expect(shellTabCommand({ shell: '/x/fish', env: { SHELL: '/bin/bash' }, platform: 'linux' })).toEqual(['/x/fish', '-l']);
  });
  it('Windows は PowerShell。-l は付けない', () => {
    expect(shellTabCommand({ env: { SHELL: '/usr/bin/bash' }, platform: 'win32' })).toEqual(['powershell.exe', '-NoLogo']);
    expect(shellTabCommand({ shell: 'pwsh.exe', env: {}, platform: 'win32' })).toEqual(['pwsh.exe', '-NoLogo']);
  });
});
```

- [ ] **Step 2: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/launch/command.test.ts`
Expected: FAIL（`./command.ts` が無い）。

- [ ] **Step 3: `launch/command.ts` を書く**

```ts
// tmux のセッションの中で起こすコマンドの組み立て。OS で変わるのは、包みの起こし方と、シェルのタブの中身である。

/**
 * claude を包みで起こすコマンドと、セッションに足す環境変数。
 * macOS と Linux は bash の包み。プロセス置換を使うので sh ではなく bash で起こし、HANGAR_RUN_ID は env コマンドで渡す。
 * Windows は Node の包み。ペインの中の PATH に頼らないよう、サーバを動かしている Node の絶対パスで起こし、HANGAR_RUN_ID はセッションの環境で渡す。
 */
export function runCommand(o: { runId: string; wrapper: string; log: string; command: string[]; platform?: NodeJS.Platform; node?: string }): { command: string[]; env: Record<string, string> } {
  if ((o.platform ?? process.platform) === 'win32') {
    return { command: [o.node ?? process.execPath, o.wrapper, o.log, ...o.command], env: { HANGAR_RUN_ID: o.runId } };
  }
  return { command: ['env', `HANGAR_RUN_ID=${o.runId}`, 'bash', o.wrapper, o.log, ...o.command], env: {} };
}

/**
 * シェルのタブで起こすコマンド。
 * macOS と Linux は利用者のログインシェル。Windows は PowerShell で、Git Bash が立てる SHELL は見ない。
 */
export function shellTabCommand(o: { shell?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): string[] {
  const env = o.env ?? process.env;
  if ((o.platform ?? process.platform) === 'win32') return [o.shell ?? 'powershell.exe', '-NoLogo'];
  return [o.shell ?? env.SHELL ?? '/bin/zsh', '-l'];
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/launch/command.test.ts`
Expected: PASS。

- [ ] **Step 5: Node の包みの失敗する試験を書く**

`packages/server/src/launch/wrapper.test.ts` に足す。この試験は Node だけで動くので、どの OS でも走らせる。

```ts
import { fileURLToPath } from 'node:url';

const RUN_MJS = fileURLToPath(new URL('./hangar-run.mjs', import.meta.url));

describe('hangar-run.mjs（Node の包み）', () => {
  const run = (log: string, args: string[], input = '') =>
    spawnSync(process.execPath, [RUN_MJS, log, ...args], { encoding: 'utf8', input, env: { ...process.env, HANGAR_RUN_ID: 'run-9' } });
  const child = (code: string) => [process.execPath, '-e', code];

  it('正常に終われば、開始と exit=0 をログに書き、同じ終了コードで終わる', () => {
    const home = tmpHome();
    const log = path.join(home, 'logs 空白', 'run-1.log');
    const r = run(log, child('console.log("出力")'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('出力');
    const text = fs.readFileSync(log, 'utf8');
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ start pid=\d+ cmd=/m);
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ exit=0$/m);
  });

  it('標準エラーを画面にもログにも出す', () => {
    const log = path.join(tmpHome(), 'run-2.log');
    const r = run(log, child('console.error("駄目でした")'));
    expect(r.stderr).toContain('駄目でした');
    expect(fs.readFileSync(log, 'utf8')).toContain('駄目でした');
  });

  it('異常終了なら、理由を出して Enter を待ち、同じ終了コードで終わる', () => {
    const log = path.join(tmpHome(), 'run-3.log');
    const r = run(log, child('process.exit(3)'), '\n');
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('終了コード 3 で終了しました');
    expect(fs.readFileSync(log, 'utf8')).toMatch(/exit=3$/m);
  });

  it('起こせないコマンドは 127 で終わり、理由をログに残す', () => {
    const log = path.join(tmpHome(), 'run-4.log');
    const r = run(log, [path.join(tmpHome(), 'no-such-command.exe')], '\n');
    expect(r.status).toBe(127);
    expect(fs.readFileSync(log, 'utf8')).toMatch(/spawn failed/);
  });

  // 注入するシステムプロンプトは改行と引用符を含む。空白を含むパスの claude（C:\Program Files）も起こせる。
  it('空白、引用符、改行を含む引数を、そのまま渡す', () => {
    const home = tmpHome();
    const out = path.join(home, 'args.json');
    const args = ['--append-system-prompt', '1 行目\n2 行目 "引用" \'単\'', '-p', 'C:\\Program Files\\x y'];
    const r = run(path.join(home, 'run-5.log'), [...child(`require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.argv.slice(1), process.env.HANGAR_RUN_ID]))`), ...args]);
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual([args, 'run-9']);
  });
});
```

`tmpHome` は、そのファイルで既に一時ディレクトリを作っている補助の名前に合わせる。無ければ足す。

```ts
const homes: string[] = [];
const tmpHome = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-wrap-')); homes.push(d); return d; };
afterEach(() => { while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true }); });
```

- [ ] **Step 6: 走らせて、失敗を確かめる**

Run: `npx vitest run packages/server/src/launch/wrapper.test.ts -t hangar-run.mjs`
Expected: FAIL（`hangar-run.mjs` が無い）。

- [ ] **Step 7: `hangar-run.mjs` を書く**

`packages/server/src/launch/hangar-run.mjs`

```js
// agent-hangar: claude を包んで、終了コードと標準エラーをログに残す。hangar-run.sh の Windows 版。
// 使い方: node hangar-run.mjs <logfile> <command> [args...]
// tmux で claude を直に起こすと、異常終了のときの出力がペインごと消える。
// 標準エラーをログに複写し、終了コードを記録し、異常終了のときは Enter を待ってから閉じる。
// 依存を持たない。hangar が置いた 1 ファイルだけで動く。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [log, cmd, ...args] = process.argv.slice(2);
if (!log || !cmd) {
  process.stderr.write('usage: hangar-run.mjs <logfile> <command> [args...]\n');
  process.exit(2);
}

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
fs.mkdirSync(path.dirname(log), { recursive: true });
const append = (text) => {
  try { fs.appendFileSync(log, text); } catch { /* ログに書けなくても claude は止めない */ }
};
append(`${stamp()} start pid=${process.pid} cmd=${cmd}\n`);

const finish = (code) => {
  append(`${stamp()} exit=${code}\n`);
  if (code === 0) process.exit(0);
  process.stdout.write(`\n[agent-hangar] 終了コード ${code} で終了しました。ログ: ${log}\nEnter でこの画面を閉じます。`);
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
  // 入力が閉じている（つなぐ端末が無い）ときは待たずに終わる。
  process.stdin.once('end', () => process.exit(code));
};

// 標準入力と標準出力は端末をそのまま渡す。標準エラーだけ受け取って、画面とログの両方へ流す。
const child = spawn(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'], windowsHide: false });
child.stderr.on('data', (d) => {
  process.stderr.write(d);
  append(d);
});
child.on('error', (e) => {
  append(`${stamp()} spawn failed: ${e.message}\n`);
  process.stderr.write(`[agent-hangar] 起動できませんでした: ${e.message}\n`);
  finish(127);
});
child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
// Ctrl+C は子が受けて自分で終わる。包みが先に死ぬと終了コードを記録できない。
process.on('SIGINT', () => {});
```

- [ ] **Step 8: 通ることを確かめる**

Run: `npx vitest run packages/server/src/launch/wrapper.test.ts -t hangar-run.mjs`
Expected: PASS（5 件）。

- [ ] **Step 9: `ensureWrapperScript` を OS で分ける**

`packages/server/src/launch/wrapper.ts`

```ts
import { fileURLToPath } from 'node:url';
import { ensureMode } from '../platform/secure.ts';

export const WRAPPER_NAME = 'hangar-run.sh';
export const WRAPPER_NAME_WIN = 'hangar-run.mjs';

/** Windows の包みの本体。同じディレクトリの hangar-run.mjs を読む。同梱版でも server.mjs の隣に置く。 */
export function wrapperScriptWin(): string {
  return fs.readFileSync(fileURLToPath(new URL('./hangar-run.mjs', import.meta.url)), 'utf8');
}

/** <home>/bin に包みを置く。macOS と Linux は hangar-run.sh を 0o755 で、Windows は hangar-run.mjs を置く。中身が同じなら書かない。 */
export function ensureWrapperScript(home: string, platform: NodeJS.Platform = process.platform): string {
  const dir = path.join(home, 'bin');
  const win = platform === 'win32';
  const file = path.join(dir, win ? WRAPPER_NAME_WIN : WRAPPER_NAME);
  const body = win ? wrapperScriptWin() : wrapperScript();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o755 });
  ensureMode(file, 0o755, platform);
  return file;
}
```

試験を足す。

```ts
it('Windows では bin/hangar-run.mjs を置き、同じ内容なら書き直さない', () => {
  const home = tmpHome();
  const file = ensureWrapperScript(home, 'win32');
  expect(path.basename(file)).toBe('hangar-run.mjs');
  expect(fs.readFileSync(file, 'utf8')).toBe(wrapperScriptWin());
  const before = fs.statSync(file).mtimeMs;
  ensureWrapperScript(home, 'win32');
  expect(fs.statSync(file).mtimeMs).toBe(before);
});
```

`apps/desktop/scripts/bundle-server.ts` で、`server.mjs` を出したあとに `hangar-run.mjs` を隣へ写す 1 行を足す。`import.meta.url` は束ねたあと `server.mjs` を指すので、隣に無いと Windows の同梱版で読めない。

```ts
  // Windows の包み。束には入らない単独のファイルで、server.mjs が隣から読む。
  fs.copyFileSync(path.join(repo, 'packages/server/src/launch/hangar-run.mjs'), path.join(out, 'hangar-run.mjs'));
```

`repo` と `out` は、そのスクリプトがリポジトリの根と出力先に使っている変数の名前に合わせる。

- [ ] **Step 10: `RunManager` の起動を差し替える**

`packages/server/src/runs/manager.ts` の `launch`（194〜201 行）：

```ts
    const wrapper = ensureWrapperScript(this.deps.home);
    const log = runLogPath(this.deps.home, runId);
    const wrapped = runCommand({ runId, wrapper, log, command: o.command });
    ...
      tmux.newSession({ name: tmuxName, cwd: o.cwd, command: wrapped.command, env: withUtf8Locale({ ...o.env, ...wrapped.env }) });
```

`openTab`（613〜615 行）：

```ts
    const command = shellTabCommand({ shell: this.deps.shell });
    try {
      tmux.newSession({ name: tmuxName, cwd: s.cwd, command, env: withUtf8Locale() });
```

`withUtf8Locale`（35〜38 行）は、Windows では何も足さない。`LC_CTYPE` は Unix のロケールの変数である。

```ts
export function withUtf8Locale(env: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform === 'win32' || env.LC_ALL || env.LC_CTYPE) return env;
  return { LC_CTYPE: 'UTF-8', ...env };
}
```

`import { runCommand, shellTabCommand } from '../launch/command.ts';` を足す。

`RunManager` の文言のうち `tmux が見つかりません。設定の「tmux のパス」を入れてください` は変えない（範囲外）。

- [ ] **Step 11: psmux の上で包みを通す試験を足す**

`packages/server/src/tmux/psmux.win.test.ts` の `describe` の中に足す。

```ts
  // hangar が claude を起こすときと同じ組み立てを、psmux の上で通す。
  it('Node の包み越しにコマンドを起こし、終了コードと HANGAR_RUN_ID を受け取る', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar home 空白-'));
    const out = path.join(home, 'got.json');
    const wrapper = ensureWrapperScript(home);
    const log = runLogPath(home, 'r1');
    const code = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.argv.slice(1), process.env.HANGAR_RUN_ID]))`;
    const wrapped = runCommand({ runId: 'r1', wrapper, log, command: [process.execPath, '-e', code, '1 行目\n2 行目', 'a "b" c'] });
    start('hangar-wrap', wrapped.command, wrapped.env);
    await waitFor(() => fs.existsSync(out), 15_000);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual([['1 行目\n2 行目', 'a "b" c'], 'r1']);
    await waitFor(() => /exit=0/.test(fs.readFileSync(log, 'utf8')), 10_000);
    // 正常に終わった包みは Enter を待たずに閉じ、セッションも消える。
    await waitFor(() => !tmux.hasSession('hangar-wrap'), 10_000);
    made.pop();
  }, 40_000);
```

`import { runCommand } from '../launch/command.ts';` と `import { ensureWrapperScript, runLogPath } from '../launch/wrapper.ts';` を足す。

改行を含む引数が psmux の `new-session` を通らなかった場合は、原因が psmux の引数の渡し方にあるのか、試験の組み立てにあるのかを分ける。包みを直に `spawnSync` で起こす Step 5 の試験は同じ引数で通っているので、違いは psmux を挟むかどうかだけである。psmux の側だと分かったら、hangar が注入するシステムプロンプトを引数ではなくファイルで渡す形（`--append-system-prompt-file` があるかを `claude --help` で確かめる）を別のタスクとして利用者に相談する。迂回を黙って入れない。

- [ ] **Step 12: 両方の OS で確かめる**

macOS：

Run: `npm run typecheck && npm test`
Expected: PASS。`RunManager.start（tmux 上）` などの実物の tmux の試験が、いまと同じ件数で通る（起動のコマンドの形が変わっていないことの確かめ）。

Windows：

Run: `run-tests.ps1 packages/server/src/launch packages/server/src/tmux packages/server/src/runs`
Expected: `hangar-run.mjs（Node の包み）` の 5 件、`command.test.ts`、`Tmux（実物の psmux）` の 7 件が通る。`ラッパーの引用（bash を直接呼ぶ）` の 2 件はまだ失敗する（Task 8 でスキップにする）。

- [ ] **Step 13: コミット**

```bash
git add packages/server/src/launch packages/server/src/runs/manager.ts packages/server/src/tmux/psmux.win.test.ts apps/desktop/scripts/bundle-server.ts
git commit -m "feat(server): launch claude on Windows through a Node wrapper and open PowerShell tabs"
```

---

### Task 8: 残りの失敗を片付ける

**Files:**
- Modify: 下の一覧の試験と、原因がコードにあるもののコード。

**Interfaces:**
- Consumes: `posixIt`、`posixDescribe`、`isWindows`、`writeFakeTool`、`expectMode`。

この時点で Windows に残っている失敗を、直すものと飛ばすものに分ける。飛ばすのは、この区切りの範囲外の機能と、Unix にしか無い仕組みを確かめる試験だけである。飛ばす試験には、理由を 1 行のコメントで書く。

- [ ] **Step 1: いまの失敗の一覧を取る**

Windows で `run-tests.ps1` を走らせ、結果を macOS へ `scp` して、ファイルごとの失敗の題と理由を出す。

```bash
scp -q -i ~/.ssh/id_ed25519 '12700k@192.168.3.40:AppData/Local/Temp/hangar-spike/vitest.json' ./vitest-win.json
node -e "
const r=require('./vitest-win.json');
console.log('passed',r.numPassedTests,'failed',r.numFailedTests,'skipped',r.numPendingTests);
for(const f of r.testResults){const bad=f.assertionResults.filter(a=>a.status==='failed');if(!bad.length)continue;
 console.log('## '+f.name.replace(/\\\\/g,'/').replace(/^.*agent-hangar\//,''));
 for(const a of bad)console.log('  - '+a.title.slice(0,70)+' => '+(a.failureMessages[0]||'').split('\n')[0].slice(0,140));}"
```

`vitest-win.json` はコミットしない。

- [ ] **Step 2: 範囲外の機能の試験を、理由を書いて飛ばす**

| ファイル | 対象 | 理由のコメント |
|---|---|---|
| `packages/server/src/config/shellHook.test.ts` | ファイル全体の `describe` を `posixDescribe` に | `// zsh の包み。Windows の包みは次の区切りで作る。` |
| `packages/cli/src/shell.test.ts` | 同上 | 同上 |
| `packages/server/src/external/open.test.ts` | 同上 | `// Terminal.app と iTerm2 への受け渡し。Windows Terminal への受け渡しは次の区切りで作る。` |
| `packages/server/src/config/statusline.test.ts` | bash の断片を実際に走らせる試験（159、206、229 行）と、断片の差し込みの試験 | `// statusline の断片は bash。Windows 向けの差し込みは次の区切りで作る。` |
| `packages/cli/src/statusline.test.ts` | 断片を入れる試験 | 同上 |
| `packages/server/src/launch/wrapper.test.ts` | `ラッパーの引用（bash を直接呼ぶ）` | `// hangar-run.sh は macOS と Linux の包み。Windows の包みは hangar-run.mjs の試験が見る。` |
| `packages/server/src/tmux/fake-claude.test.ts` | ファイル全体 | `// 偽の claude は sh のスクリプト。これを使う実物の tmux の試験は Windows では走らせない。` |
| `packages/server/src/pty/helper.test.ts` | ファイル全体 | `// spawn-helper は macOS と Linux の node-pty にしか無い。` |
| `packages/cli/src/url.test.ts` | `実測。起こしたプロセスの argv に鍵は現れない`（55 行） | `// ps で argv を読む実測。ブラウザを開く経路の Windows 版は次の区切りで作る。` |
| `apps/desktop/test/bundle-server.test.ts` | `hangar.sh` を起こす試験（243、283 行の仲間） | `// hangar.sh は macOS の起動スクリプト。Windows の起動は殻の区切りで作る。` |

`statusline.test.ts` と `bundle-server.test.ts` は、ファイルの中に Windows でも意味のある試験が混ざっている。`describe` ごとではなく、当たる `it` だけを `posixIt` にする。

- [ ] **Step 3: Unix の仕組みに頼る試験を、理由を書いて飛ばす**

| ファイル | 対象 | 理由のコメント |
|---|---|---|
| `packages/server/src/projects/promote.test.ts` | 120、132 行（`chmod 0o555` で書けないディレクトリを作る） | `// 書けないディレクトリを chmod で作る。Windows の chmod はディレクトリを書けなくできない。` |
| `packages/server/src/config/retention.test.ts` | 105 行（シンボリックリンクと `chmod 0o000`） | `// 読めないディレクトリを chmod で作る。Windows ではできない。` |
| `packages/server/src/indexer/service.test.ts` | 102 行ほか（`chmod 0o000` で読めないファイルを作る） | 同上 |
| `packages/server/src/config/cloud.test.ts` | 70 行（書けなくして失敗させる） | 同上 |
| `packages/server/src/sync/claudeConfig.test.ts` | 751 行（実行権を付ける） | `// 実行権は Windows に無い。` |

飛ばす前に、その試験が確かめている振る舞い（失敗したら元に戻す、読めないものは飛ばす）を、Windows でも起こせる別の失敗の作り方（たとえば、移す先に同じ名前のファイルを先に置く）で書けないかを 1 つずつ見る。書けるものは `it.runIf(isWindows)` の試験として足す。書けないものだけを飛ばす。

- [ ] **Step 4: 原因がコードにあるものを直す**

`apps/desktop/scripts/bundle-server.ts`：`path.relative` の結果を `/` 区切りの正規表現と `startsWith('prebuilds/')` に当てているので、Windows では絞り込みが外れ、`.env` が同梱に入る（414 行の失敗）。相対パスを POSIX の形にしてから当てる。

```ts
/** 相対パスを / 区切りにする。下の正規表現と prebuilds の判定は / を前提に書いてある。 */
const posixRel = (rel: string): string => rel.split(path.sep).join('/');
```

`SKIP_IN_NATIVE`、`SKIP_IN_CLOUD`、`SKIP_IN_UI`、`keepPrebuild` に渡している相対パスを、渡す直前に `posixRel(...)` で包む。`PREBUILD_ARCH` はこの区切りでは変えない（同梱の Windows 版は殻の区切りで作る）。

`packages/server/src/http/app.test.ts`、`packages/server/src/server.test.ts`、`packages/cli/src/index.test.ts`、`packages/cli/src/mcp.test.ts`、`packages/server/src/runs/manager.test.ts` に残った失敗は、Step 1 の一覧で 1 件ずつ理由を読む。

- 期待値が `'/w/alpha'` のような POSIX の文字列なら、Task 2 の `abs()` と同じ補助で OS の形にする。
- sh のスクリプトを偽の道具にしているなら、`writeFakeTool` に替える。
- 文言の比較（`「tmux のパス」に` と `「tmux のパス」の`）は、`checkToolPath` が返す `problem` が OS で変わった結果である。Windows で実行権が無い状態を作れないために起きているなら、その検査を `if (!isWindows)` で囲む。
- 5 秒の時間切れ（`index.test.ts:92`）は、子プロセスが終わらないのが原因かを先に見る。`node-pty` で端末が終わったあとに Node が残る件（仕様書の「分かっている危うさ」）と同じ形なら、Task 10 の Step 3 で扱う。時間を延ばして通すことはしない。
- 理由が上のどれにも当たらないものは、Windows の実際の不具合である。コードを直し、直した振る舞いの試験を足す。

- [ ] **Step 5: 両方の OS で確かめる**

macOS：

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS。スキップの件数が、この枝を切る前（main の `9c1b90f`）より増えていない。

Windows：

Run: `npm run typecheck`、続けて `run-tests.ps1`
Expected: 失敗 0。スキップした試験の一覧を出し、どれも Step 2 と Step 3 の表にあることを確かめる。

```bash
node -e "
const r=require('./vitest-win.json');const by={};
for(const f of r.testResults)for(const a of f.assertionResults)if(a.status!=='passed'&&a.status!=='failed'){const k=f.name.replace(/\\\\/g,'/').replace(/^.*agent-hangar\//,'');by[k]=(by[k]||0)+1}
console.log(by);"
```

- [ ] **Step 6: コミット**

```bash
git add packages apps
git commit -m "test: get the suite green on Windows, skipping only Unix-only checks with reasons"
```

---

### Task 9: CI に Windows のジョブを足し、文書を直す

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/design.md`（配布ターゲットの節）
- Modify: `README.md`
- Modify: `packages/ui/src/presenters/readiness.ts:14`、`packages/ui/src/views/SettingsScreen.tsx:263`

**Interfaces:**
- Consumes: なし。

- [ ] **Step 1: Windows のジョブを足す**

`.github/workflows/ci.yml` の `check` の後ろに足す。

```yaml
  windows:
    runs-on: windows-latest
    # 試験が固まったときの上限。
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      # psmux は入れない。psmux を相手にする試験は describe.skipIf で飛ぶ。
      # ここで見るのは、パス、道具の探し方、権限、プロセスの扱いが Windows で壊れていないことである。
      - run: npm test
```

- [ ] **Step 2: 道具の入れ方の案内を OS で分ける**

`packages/ui/src/presenters/readiness.ts:14` の `fixCommand: 'brew install tmux'` と、`packages/ui/src/views/SettingsScreen.tsx:263` の同じ文言を、サーバが返す機器の `platform`（`DeviceDto.platform`、いまの機器は `self: true` の行）で分ける。先に試験を書く。

`packages/ui/src/presenters/presenters.test.ts` に足す。

```ts
it('tmux の入れ方は、その PC の OS に合わせて案内する', () => {
  expect(muxInstallCommand('darwin')).toBe('brew install tmux');
  expect(muxInstallCommand('linux')).toBe('brew install tmux');
  expect(muxInstallCommand('win32')).toBe('winget install marlocarlo.psmux');
});
```

`packages/ui/src/presenters/readiness.ts` に足し、`fixCommand` と `SettingsScreen.tsx` の文言の両方でこれを使う。

```ts
/** tmux の役を担う道具の入れ方。Windows は psmux を入れる。 */
export function muxInstallCommand(platform: string): string {
  return platform === 'win32' ? 'winget install marlocarlo.psmux' : 'brew install tmux';
}
```

`platform` は、その画面が既に受け取っている機器の一覧から `self` の行のものを渡す。受け取っていない画面なら、いちばん近い親から props で渡す。新しい API は足さない。

Run: `npx vitest run packages/ui/src/presenters`
Expected: PASS。

- [ ] **Step 3: 文書を直す**

`docs/design.md` の「配布ターゲットは Apple silicon の macOS 13 以降だけ。…Intel と Windows は作らない。」の行を、次に置き換える。

```markdown
- 配布ターゲットは Apple silicon の macOS 13 以降である。prebuild も `darwin-arm64` しか入れない。全アーキを入れると `node-pty` の win32 だけで 58MB になる。Intel は作らない。
- Windows（x64）は、サーバと UI をソースから動かせる（`docs/superpowers/specs/2026-10-05-windows-port-m1-design.md`）。tmux の役は psmux が担う。デスクトップのアプリ、通知、インストーラはまだ無い。
```

`README.md` に「Windows で動かす」の節を足す。

```markdown
## Windows で動かす（開発中）

Windows 11（x64）では、サーバと UI をソースから動かせます。デスクトップのアプリはまだありません。

1. Node 22、Git for Windows、Claude Code を入れます。
2. tmux の代わりに psmux を入れます：`winget install marlocarlo.psmux`
3. `npm ci` のあと `npm run dev` で起こし、表示された URL をブラウザで開きます。

止めるときは Ctrl+C です。まだ無いもの：通知、ターミナルで打った `claude` を hangar に載せる包み、外のターミナルへの受け渡し、statusline。
```

- [ ] **Step 4: 確かめてコミットし、push する**

Run: `npm run typecheck && npm test`
Expected: PASS。

```bash
git add .github/workflows/ci.yml docs/design.md README.md packages/ui
git commit -m "ci: run typecheck and tests on Windows, and document how to run hangar there"
git push -u origin worktree-windows-port
```

push は、利用者に確かめてから行う。push したら、GitHub Actions の `windows` のジョブが通ることを `gh run watch` で見る。落ちたら、手元の Windows と何が違うか（psmux が無い、Git Bash が無い、ユーザー名、ドライブ）を先に疑う。

---

### Task 10: Windows の実機で通しの確かめ

**Files:**
- Modify: `docs/superpowers/specs/2026-10-05-windows-port-m1-design.md`（「できあがりの確かめ方」の下に、確かめた結果の節を足す）

**Interfaces:**
- Consumes: Task 1〜9 の全部。

実物の DB と設定に触らないよう、専用の置き場で起こす。

- [ ] **Step 1: 専用の置き場でサーバを起こす**

Windows で、利用者に画面の前に居てもらって行う（ブラウザと日本語入力は SSH 越しでは見られない）。

```powershell
Set-Location D:\workspace\agent-hangar
git fetch; git checkout worktree-windows-port; git pull
npm ci
$env:HANGAR_HOME = "$env:TEMP\hangar-m1-home"
npm run dev
```

psmux の既定の名前空間に hangar のセッション（`hangar-<id>`）ができる。利用者が自分で使っている psmux のセッションがあれば、同じ一覧に並ぶ。hangar はそれらに触らない（`RUN_SESSION_FORMAT` の `^hangar-[0-9a-f]+$` に当たるものだけを見る）。

- [ ] **Step 2: 仕様書の 6 つの操作を確かめる**

利用者にブラウザで操作してもらい、1 つずつ結果を聞く。SSH の側からは、psmux の一覧と claude のプロセスで裏を取る。

| 操作 | 裏の取り方 |
|---|---|
| ワークスペースの下のフォルダがプロジェクトとして並ぶ | `GET /api/bootstrap` の `projects` |
| セッションを起動し、端末で日本語を打って返事が返る | `psmux list-sessions -F "#{session_name}"` に `hangar-<id>` がある。`~/.claude/sessions` に新しい行がある |
| 同じセッションを 2 つのタブで開いて、どちらにも画面が出る | psmux の attach のプロセスが 2 つある |
| シェルのタブを足せる | `hangar-<id>-t1` があり、PowerShell のプロンプトが出る |
| サーバを止めて起こし直し、動いていたセッションにつなぎ直せる | 止めている間も `hangar-<id>` が一覧に残る |
| セッションを止めると、claude のプロセスが残らない | `Get-Process claude` から、その PID が消える |

通らなかった操作は、psmux や Claude Code の限界と決める前に、hangar が渡している引数、環境変数、作業フォルダを先に疑う。1 回の失敗で結論にしない。

- [ ] **Step 3: node-pty のプロセスの残りを数える**

仕様書の「分かっている危うさ」の確かめ。端末のタブを 10 回開いて閉じ、前後で数える。

```powershell
$before = (Get-Process conhost -ErrorAction SilentlyContinue).Count
# ブラウザで、セッションの端末のタブを 10 回開いて閉じる
$after = (Get-Process conhost -ErrorAction SilentlyContinue).Count
"conhost: $before -> $after"
```

Expected: 増えていない。増えていたら、`PtyRelay` が接続を閉じたときの `kill()` の後に残っているのが `conhost.exe` か `psmux.exe`（attach のクライアント）かを `Get-CimInstance Win32_Process` の `ParentProcessId` で見分け、数と再現の手順を仕様書に書いて利用者に報告する。直し方は別のタスクにする。

- [ ] **Step 4: macOS が変わっていないことを確かめる**

macOS で、この枝のサーバを専用の置き場と専用の tmux で起こし、同じ 6 つの操作をする。利用者の `npm run dev`（4177）と本物の tmux には触らない。

```bash
export HANGAR_HOME="$(mktemp -d)/hangar-m1-home"
env -u HANGAR_PARENT_PID -u HANGAR_CLOUD_DIR HANGAR_PORT=4188 npm run dev --workspace packages/server
```

起動のログで、自分が起こしたサーバの PID とポートを確かめる。止めるのはその PID だけである。

- [ ] **Step 5: 結果を仕様書に書いてコミットする**

`docs/superpowers/specs/2026-10-05-windows-port-m1-design.md` の末尾に足す。表の「結果」には、通った、通らなかった（何が起きたか）、確かめていない、のどれかを書く。確かめていないものを通ったと書かない。

```markdown
## 確かめた結果

<日付>、Windows 11 Home build 26200（x64）、psmux <版>、Claude Code <版>、枝 `worktree-windows-port` の <コミット>。

| 操作 | 結果 |
|---|---|
| プロジェクトが並ぶ | |
| セッションを起動して日本語でやりとりする | |
| 2 つのタブで開く | |
| シェルのタブを足す | |
| サーバを起こし直してつなぎ直す | |
| 止めたら claude が残らない | |
| 端末を 10 回開閉したあとの conhost の数 | |
| macOS で同じ操作 | |
```

```bash
git add docs/superpowers/specs/2026-10-05-windows-port-m1-design.md
git commit -m "docs: record what was verified on Windows for the first milestone"
```

- [ ] **Step 6: 後片付け**

Windows で、自分が起こしたサーバを Ctrl+C で止め、試しのセッションを名指しで止め、専用の置き場を消す。

```powershell
psmux list-sessions -F "#{session_name}" | Where-Object { $_ -match '^hangar-[0-9a-f]+(-t\d+)?$' } | ForEach-Object { psmux kill-session -t "=$_" }
Remove-Item -Recurse -Force "$env:TEMP\hangar-m1-home"
```

消す前に、一覧に出た名前を利用者に見せて、消してよいかを確かめる。
