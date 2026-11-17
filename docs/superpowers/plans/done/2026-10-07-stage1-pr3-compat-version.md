# 段 1 PR 3 互換の版番号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サーバと Worker が互換の版番号を見出しで交わし、下限より古い相手とは話さずに、どちらを上げればよいかを同期の状態に出して止まる仕組みを入れる（下限はどちらも 0 のまま）。

**Architecture:** shared に整数の `COMPAT_VERSION` と見出しの読み書きを置く。
Worker は最初の middleware で端末の版を下限と比べて 426 を返し、すべての応答に自分の版を載せる。
サーバの `HttpCloudClient` は要求に版を載せ、426 と古い Worker を `CompatError` にし、`SyncEngine` はそれを受けて同期を止めて `error` に上げる側を書く。

**Tech Stack:** TypeScript、Hono（Worker とサーバ）、miniflare と esbuild（Worker の試験）、vitest。

**Spec:** `docs/superpowers/specs/2026-10-07-stage1-subtraction-design.md` の「互換の版番号（D10）」の節と、「PR の割り方」の PR 3 の行。
段をまたぐ決定は `docs/superpowers/specs/2026-10-07-refactor-roadmap-design.md` の D10。
同期の作りは `docs/design.md` の「クラウド同期」の節（構成と setup、タイミングと競合）。

## Global Constraints

- `COMPAT_VERSION` は整数で、はじめは `1`。
- 置き場は新しい `packages/shared/src/compat.ts` にする（殻とサーバの照合の PR 7 でも使うので、クラウドの契約の `cloud.ts` には入れない）。
- 見出しは `X-Hangar-Compat` で、コードでは既存の見出しの定数（`CLOUD_HEADERS`）に合わせて小文字の `x-hangar-compat` で持つ。
- 見出しの無い相手と、整数として読めない値は、版 0 として読む。
- Worker の `MIN_DEVICE_COMPAT` は `0`（本番の値で、上げるのは PR 6）。
- 下限より古い要求には 426 と本文 `{ error: 'upgrade required', minCompat, compat }` を返し、試験では下限を 1 以上にした Worker で確かめる。
- サーバの `MIN_WORKER_COMPAT` は `0`。
- 版が合わなければ同期を止め、`SyncStatusDto` の `state` を `error` にし、`error` に上げる側（この PC の hangar か、Worker か）を書いた文を入れる。
- `SyncStatusDto` の形と UI の見た目は変えない。
- 殻（`apps/desktop/src-tauri`）には触らず、サーバの `/health` が `compat` を返すところまでにする。
- Worker を配備せず、実物のクラウドに触らず、報告には「実物では未確認」と書く。
- 公開リポジトリなので、計画にも試験にもコメントにも、実在の人名、メール、手元のパス、使用量の実数を書かない。
- 試験は vitest で、各タスクは「試験を書く、落ちるのを見る、実装する、通るのを見る」の順に進める。
- 試験はリポジトリの根で `npx vitest run <ファイルかディレクトリ>`、型は `npm run typecheck` で確かめる。
- 依存が入っていない worktree では、最初に `npm ci` を打つ。
- コードのコメントは日本語で、周りと同じ密度にする。
- `docs/design.md` は日本語で一文一行にし、中黒と em ダッシュを使わない。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- git のコマンドはほかのコマンドと 1 行に混ぜず、1 本ずつ打つ。

## Review Focus

- **最初の 426 が来たときに走っていた本文の上げ**：直りようのない 4xx として諦めず、版が合えば上がる（Task 6 の試験で留める）。
- **R2 の本文をそのまま返す `GET /files/<key>` に版の見出しを足す**：本文と `content-length` が崩れない（Task 2 の試験で留める）。
- **この PC の hangar を入れ替えて立て直した直後**：止めた印が DB に残って止まり続けることがない（Task 5 の試験で留める）。
- **一時停止中に「今すぐ同期」を押して 426 が返る**：一時停止の表示に隠れずに上げる側の文が出て、もう一度押せばまた試し直す（Task 5 と Task 7 の試験で留める）。
- **下限を上げた Worker への `/health`**：版を確かめに来る口なので断らず、CLI の status と setup の待ちが版を読める（Task 2 の試験で留める）。

---

### Task 1: shared に互換の版番号の契約を置く

**Files:**
- Create: `packages/shared/src/compat.ts`
- Create: `packages/shared/src/compat.test.ts`
- Modify: `packages/shared/src/index.ts`（末尾に輸出を 1 行足す）

**Interfaces:**
- Consumes: なし。
- Produces（`@agent-hangar/shared` から取れる）:
  - `COMPAT_VERSION: number`（`1`）
  - `COMPAT_HEADER: 'x-hangar-compat'`
  - `compatHeaders(): Record<string, string>`（`{ 'x-hangar-compat': String(COMPAT_VERSION) }`）
  - `parseCompat(v: string | null | undefined): number`（読めなければ 0）
  - `type CompatRefusalBody = { error: 'upgrade required'; minCompat: number; compat: number }`
  - `compatRefusalBody(minCompat: number): CompatRefusalBody`
  - `readCompatRefusal(text: string): number | null`（426 の本文から下限を読む）

- [ ] **Step 1: 依存を入れる**

worktree に `node_modules` が無ければ、リポジトリの根で打つ。

```bash
npm ci
```

- [ ] **Step 2: 試験を書く**

`packages/shared/src/compat.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, compatHeaders, compatRefusalBody, parseCompat, readCompatRefusal } from './compat.ts';
import * as shared from './index.ts';

describe('互換の版番号', () => {
  it('版は 1 から始まる整数で、見出しは小文字の x-hangar-compat で運ぶ', () => {
    expect(COMPAT_VERSION).toBe(1);
    expect(Number.isSafeInteger(COMPAT_VERSION)).toBe(true);
    expect(COMPAT_HEADER).toBe('x-hangar-compat');
    expect(compatHeaders()).toEqual({ 'x-hangar-compat': '1' });
  });

  it('パッケージの入口から取れる', () => {
    expect(shared.COMPAT_VERSION).toBe(COMPAT_VERSION);
    expect(shared.parseCompat).toBe(parseCompat);
    expect(shared.readCompatRefusal).toBe(readCompatRefusal);
  });

  it('相手が名乗った版を整数で読む', () => {
    expect(parseCompat('1')).toBe(1);
    expect(parseCompat('12')).toBe(12);
    expect(parseCompat(' 3 ')).toBe(3);
  });

  it('見出しの無い相手と、整数として読めない値は版 0 として読む', () => {
    for (const v of [null, undefined, '', 'abc', '-1', '1.5', '1e3', '0x10', '99999999999999999999']) {
      expect(parseCompat(v), String(v)).toBe(0);
    }
  });

  it('426 の本文は下限と Worker の版を運び、端末はそこから下限を読む', () => {
    expect(compatRefusalBody(2)).toEqual({ error: 'upgrade required', minCompat: 2, compat: COMPAT_VERSION });
    expect(readCompatRefusal(JSON.stringify(compatRefusalBody(2)))).toBe(2);
    expect(readCompatRefusal(JSON.stringify(compatRefusalBody(0)))).toBe(0);
  });

  it('形の違う本文からは下限を読まない（例外も投げない）', () => {
    for (const t of ['', 'nonsense', 'null', '{"error":"gone","minCompat":1}', '{"error":"upgrade required"}', '{"error":"upgrade required","minCompat":-1}', '{"error":"upgrade required","minCompat":"2"}', '{"error":"upgrade required","minCompat":1.5}']) {
      expect(readCompatRefusal(t), t).toBeNull();
    }
  });
});
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/shared/src/compat.test.ts`
Expected: FAIL（`./compat.ts` が無いので読み込めない）。

- [ ] **Step 4: 実装する**

`packages/shared/src/compat.ts` を作る。

```ts
/**
 * 互換の版番号（作り替えの全体計画の D10）。
 *
 * hangar の部品のうち、別々に上がりうるのは、端末どうし（同期で Worker を挟む）、端末と Worker、殻と 4177 のサーバである。
 * それぞれが 1 つの整数を名乗り、相手に下限を持つ。下限より古い相手とは話さずに、理由を出して止まる。
 * UI とサーバと CLI は同じ束で配るので、この番号を持たない。
 *
 * 上げるのは、同期の形、Worker の API、殻とサーバの合図を、古い相手と話せない形で変えるときだけである。
 * 項目を足すだけで古い相手も読める変更では上げない（docs/design.md「互換の版番号」）。
 */
export const COMPAT_VERSION = 1;

/** 版を運ぶ見出し（X-Hangar-Compat）。端末は要求に、Worker は応答に、自分の版を載せる。 */
export const COMPAT_HEADER = 'x-hangar-compat';

/** 要求に足す見出し。サーバの同期の client、CLI、Worker の試験の道具が同じものを使う。 */
export function compatHeaders(): Record<string, string> {
  return { [COMPAT_HEADER]: String(COMPAT_VERSION) };
}

/**
 * 相手が名乗った版を読む。
 * 見出しが無いのは、版番号を入れる前の古い相手である。版 0 として読む。
 * 整数として読めない値（空、負、小数、指数、16 進、桁あふれ）も版 0 にする。相手の言い分を大きく読む向きには倒さない。
 */
export function parseCompat(v: string | null | undefined): number {
  const t = (v ?? '').trim();
  if (!/^\d+$/.test(t)) return 0;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Worker が、下限より古い端末に 426 で返す本文。minCompat は Worker が求める下限、compat は Worker の版である。 */
export type CompatRefusalBody = { error: 'upgrade required'; minCompat: number; compat: number };

export function compatRefusalBody(minCompat: number): CompatRefusalBody {
  return { error: 'upgrade required', minCompat, compat: COMPAT_VERSION };
}

/** 426 の本文から、相手が求める下限を読む。形が違えば null を返す（例外を投げない）。 */
export function readCompatRefusal(text: string): number | null {
  try {
    const v = JSON.parse(text) as Partial<CompatRefusalBody> | null;
    if (!v || v.error !== 'upgrade required') return null;
    const n = v.minCompat;
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
```

`packages/shared/src/index.ts` の末尾（`export * from './usage.ts';` の次）に 1 行足す。

```ts
export * from './compat.ts';
```

- [ ] **Step 5: 通るのを見る**

Run: `npx vitest run packages/shared`
Expected: PASS（compat.test.ts の 6 件と、既存の shared の試験すべて）。

- [ ] **Step 6: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 7: コミットする**

```bash
git add packages/shared/src/compat.ts packages/shared/src/compat.test.ts packages/shared/src/index.ts
```

```bash
git commit -m "feat(shared): add the compat version contract" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker が版を名乗り、下限より古い端末を 426 で断る

**Files:**
- Create: `packages/cloud/src/compat.ts`
- Modify: `packages/cloud/src/index.ts`（ファイル全体を `createApp` に包む）
- Modify: `packages/cloud/test/harness.ts`（`minDeviceCompat` の差し替え、`SELF` が版を足す、`RAW` を足す）
- Create: `packages/cloud/test/compat.test.ts`

**Interfaces:**
- Consumes: Task 1 の `COMPAT_HEADER`、`COMPAT_VERSION`、`compatHeaders`、`compatRefusalBody`、`parseCompat`。
- Produces:
  - `MIN_DEVICE_COMPAT = 0`（`packages/cloud/src/compat.ts`）。
    Task 4 の偽物の試験がこの行を原本の文字列から読むので、`export const MIN_DEVICE_COMPAT = 0;` の形を崩さない。
  - `compatMiddleware(minDeviceCompat: number): MiddlewareHandler<{ Bindings: Env; Variables: Vars }>`
  - `createApp(o: { minDeviceCompat: number }): AppType`（`packages/cloud/src/index.ts`）で、既定の輸出は `createApp({ minDeviceCompat: MIN_DEVICE_COMPAT })`。
  - Worker の `/health` は `{ ok: true, version: VERSION, compat: COMPAT_VERSION }`。
  - 試験の道具：`startCloud({ minDeviceCompat?: number })` と、版の見出しを足さない `CloudHarness.RAW.fetch`（Task 3 の e2e が使う）。
  - `CloudHarness.SELF.fetch` は、呼び手が載せていなければ `x-hangar-compat: COMPAT_VERSION` を足す。

- [ ] **Step 1: 試験を書く**

`packages/cloud/test/compat.test.ts` を作る。

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { MIN_DEVICE_COMPAT } from '../src/compat.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex, VERSION } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-compat';
const device = { id: 'dev-a', name: 'dev-a', platform: 'darwin' };
const joinInit = (headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ secret: SECRET, device }),
});

let cloud: CloudHarness | null = null;

/** Worker を起こし、参加用の秘密を入れる。下限を渡すと、その下限の Worker を起こす。 */
const boot = async (minDeviceCompat?: number): Promise<CloudHarness> => {
  resetSchemaCache();
  const c = await startCloud(minDeviceCompat === undefined ? {} : { minDeviceCompat });
  resetSchemaCache();
  await ensureSchema({ ...c.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  cloud = c;
  return c;
};

afterEach(async () => {
  await cloud?.dispose();
  cloud = null;
});

describe('互換の版（本番の下限）', () => {
  it('本番の下限は 0 である（上げるのは段 1 の PR 6）', () => {
    expect(MIN_DEVICE_COMPAT).toBe(0);
  });

  it('/health は Worker の版を返す', async () => {
    const c = await boot();
    const r = await c.RAW.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: VERSION, compat: COMPAT_VERSION });
  });

  it('どの応答にも、見出しで Worker の版を載せる（断ったもの、無い経路を含む）', async () => {
    const c = await boot();
    const responses = [
      await c.RAW.fetch('https://x/health'),
      await c.RAW.fetch('https://x/changes?since=0'),
      await c.RAW.fetch('https://x/nope'),
      await c.RAW.fetch('https://x/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 404, 400]);
    for (const r of responses) expect(r.headers.get(COMPAT_HEADER), String(r.status)).toBe(String(COMPAT_VERSION));
  });

  it('R2 の本文をそのまま返す応答にも版を載せ、本文と長さは崩さない', async () => {
    const c = await boot();
    const { deviceToken } = (await (await c.SELF.fetch('https://x/join', joinInit())).json()) as { deviceToken: string };
    await c.env.BUCKET.put('transcripts/dev-a/u1.jsonl.gz', 'abc');
    const g = await c.SELF.fetch('https://x/files/transcripts/dev-a/u1.jsonl.gz', { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(g.status).toBe(200);
    expect(g.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    expect(g.headers.get('content-length')).toBe('3');
    expect(await g.text()).toBe('abc');
  });

  it('見出しの無い要求（版 0 の古い端末）も通す', async () => {
    const c = await boot();
    const j = await c.RAW.fetch('https://x/join', joinInit());
    expect(j.status).toBe(201);
    const { deviceToken } = (await j.json()) as { deviceToken: string };
    const r = await c.RAW.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(r.status).toBe(200);
  });
});

describe('互換の版（下限を上げた Worker）', () => {
  it('見出しの無い要求には、認証より先に 426 と下限を返す', async () => {
    const c = await boot(1);
    const r = await c.RAW.fetch('https://x/changes?since=0');
    expect(r.status).toBe(426);
    expect(r.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    expect(await r.json()).toEqual({ error: 'upgrade required', minCompat: 1, compat: COMPAT_VERSION });
  });

  it('参加も、版の古い端末なら断る', async () => {
    const c = await boot(1);
    const r = await c.RAW.fetch('https://x/join', joinInit());
    expect(r.status).toBe(426);
    expect(await r.json()).toMatchObject({ minCompat: 1 });
  });

  it('読めない版の見出しは版 0 として断る', async () => {
    const c = await boot(1);
    for (const v of ['abc', '-1', '1.5', '']) {
      const r = await c.SELF.fetch('https://x/changes?since=0', { headers: { [COMPAT_HEADER]: v } });
      expect(r.status, JSON.stringify(v)).toBe(426);
    }
  });

  it('下限と同じ版を名乗る要求は通し、/health は版を問わずに通す', async () => {
    const c = await boot(1);
    const j = await c.SELF.fetch('https://x/join', joinInit());
    expect(j.status).toBe(201);
    const { deviceToken } = (await j.json()) as { deviceToken: string };
    expect((await c.SELF.fetch('https://x/changes?since=0', { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(200);
    const h = await c.RAW.fetch('https://x/health');
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ compat: COMPAT_VERSION });
  });

  it('断る要求では、スキーマの用意も走らせない（D1 に触らない）', async () => {
    resetSchemaCache();
    const c = await startCloud({ minDeviceCompat: 1 });
    cloud = c;
    expect((await c.RAW.fetch('https://x/changes?since=0')).status).toBe(426);
    const t = await c.env.DB.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'devices'").first<{ n: number }>();
    expect(t?.n).toBe(0);
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/cloud/test/compat.test.ts`
Expected: FAIL（`../src/compat.ts` が無く、`startCloud` も `minDeviceCompat` と `RAW` を知らない）。

- [ ] **Step 3: Worker の関所を書く**

`packages/cloud/src/compat.ts` を作る。

```ts
import type { MiddlewareHandler } from 'hono';
import { COMPAT_HEADER, COMPAT_VERSION, compatRefusalBody, parseCompat } from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

/**
 * 端末に求める互換の版の下限。
 * 0 の間は、版の見出しを持たない古い端末（版 0 として読む）も通す。
 * 上げるのは、同期に参加しているすべての端末が版番号を持つ版に上がってからである（段 1 の PR 6 で 1 にする）。
 * packages/server/test/fake-cloud.test.ts がこの行を文字列で読んで、偽物の写しと突き合わせる。
 */
export const MIN_DEVICE_COMPAT = 0;

/**
 * 互換の版の関所。どの経路よりも先に通す。
 *
 * 下限より古い端末には 426 と下限を返し、スキーマの用意にも認証にも進まない。断った要求で D1 に触らないためである。
 * /health だけは版を問わずに通す。版を確かめに来る口だからである（CLI の status と、setup の反映待ち）。
 * どの応答にも、断ったものを含めて、Worker の版を見出しで載せる。
 */
export function compatMiddleware(minDeviceCompat: number): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    if (c.req.path !== '/health' && parseCompat(c.req.header(COMPAT_HEADER)) < minDeviceCompat) {
      c.header(COMPAT_HEADER, String(COMPAT_VERSION));
      return c.json(compatRefusalBody(minDeviceCompat), 426);
    }
    await next();
    // 経路が自分で組んだ応答（R2 の本文をそのまま返す GET /files/<key>）と、onError と notFound の応答にも載せるため、
    // 出来上がった後で足す。Hono は出来上がった応答の見出しを書き換えるときに、応答を作り直して本文を引き継ぐ。
    c.header(COMPAT_HEADER, String(COMPAT_VERSION));
  };
}
```

- [ ] **Step 4: Worker を createApp に包む**

`packages/cloud/src/index.ts` を次の内容に置き換える。
経路、認証の一覧、`/usage`、`notFound`、`onError` の中身は、いまのファイルのものをそのまま `createApp` の中へ移す（置き換える前に、いまのファイルとこの写しが同じかを見比べ、違えばいまのファイルの方を移す）。
足すのは、関所の 1 行と、`/health` の `compat` と、既定の輸出の形だけである。

```ts
import { Hono } from 'hono';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { authMiddleware } from './auth.ts';
import { changesApp, rowsApp } from './changes.ts';
import { compatMiddleware, MIN_DEVICE_COMPAT } from './compat.ts';
import type { AppType, Env, Vars } from './env.ts';
import { filesApp } from './files.ts';
import { joinHandler } from './join.ts';
import { ensureSchema } from './schema.ts';
import { collectUsage } from './usage.ts';
import { VERSION } from './util.ts';

/** 記録に残す文言の上限である。長い SQL や本文の断片を垂れ流さない。 */
const MAX_LOG_LEN = 200;

/**
 * クラウド Worker を組み立てる。端末ごとのトークンで認証し、変更ログとファイルを預かる。中身の暗号化は端末側で行う。
 *
 * 端末に求める互換の版の下限を引数で受けるのは、試験が下限を上げた Worker を起こすためである（test/harness.ts）。
 * 配備される Worker は、下の既定の輸出だけを使う（下限は MIN_DEVICE_COMPAT）。
 */
export function createApp(o: { minDeviceCompat: number }): AppType {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // 版の関所は最初に通す。断る要求で、スキーマの用意（D1 への問い合わせ）も認証も走らせない。
  app.use('*', compatMiddleware(o.minDeviceCompat));
  app.use('*', async (c, next) => {
    await ensureSchema(c.env);
    await next();
  });
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, compat: COMPAT_VERSION }));

  // 参加だけは端末トークンを持たずに叩ける。中で参加用の秘密のハッシュを検査する。
  app.post('/join', joinHandler);

  // ここから下は端末トークンが要る。経路を足すときは必ずこの一覧にも足す。
  app.use('/changes', authMiddleware());
  app.use('/changes/*', authMiddleware());
  app.use('/rows', authMiddleware());
  app.use('/rows/*', authMiddleware());
  app.use('/files', authMiddleware());
  app.use('/files/*', authMiddleware());
  app.use('/usage', authMiddleware());

  app.route('/changes', changesApp);
  app.route('/rows', rowsApp);
  app.route('/files', filesApp);

  // 使用量と費用。トークンの secret が無ければ外へ出ずに configured: false を返す。D1 には書かない。
  app.get('/usage', async (c) => {
    const token = c.env.USAGE_API_TOKEN?.trim();
    const accountId = c.env.CF_ACCOUNT_ID?.trim();
    if (!token || !accountId) return c.json({ configured: false });
    return c.json(await collectUsage({ token, accountId, fetch: (input, init) => fetch(input, init), now: Date.now() }));
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  /**
   * 想定していない例外である。
   * 外へ返すのは一般化した 1 語だけにする。
   * D1 と R2 の文言には表と列と束縛の様子が出るので、そのまま返すと内側の作りを教えてしまう。
   * 詳しい内容は記録にだけ残す。記録に載るのは方式と経路と例外の名前と 1 行目で、
   * 参加用の秘密も端末トークンも本文も問い合わせ文字列も載せない。
   */
  app.onError((e, c) => {
    const name = e instanceof Error ? e.name : typeof e;
    const line = (e instanceof Error ? e.message : '').split('\n')[0]!.trim().slice(0, MAX_LOG_LEN);
    console.error('worker error', c.req.method, new URL(c.req.url).pathname, name, line);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

/** 配備される Worker である。端末に求める下限は MIN_DEVICE_COMPAT。 */
export default createApp({ minDeviceCompat: MIN_DEVICE_COMPAT });
```

- [ ] **Step 5: 試験の道具を直す**

`packages/cloud/test/harness.ts` を次の内容に置き換える（説明のコメントと `startCloud` の中身は、いまのものに足す形である）。

```ts
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { Miniflare } from 'miniflare';
import { COMPAT_HEADER, compatHeaders } from '@agent-hangar/shared';
import type { Env } from '../src/env.ts';

/**
 * Worker をローカルの workerd（miniflare）で起こす道具である。
 * 実物の Cloudflare には触らず、D1 と R2 もローカルの実装を使う。
 *
 * 計画は @cloudflare/vitest-pool-workers の `cloudflare:test` を想定していたが、
 * その版はどれも vitest 4 までしか対応しておらず、このリポジトリの vitest 5 では起動しない。
 * 計画が用意していた miniflare への切り替えを採った（`SELF.fetch` は `dispatchFetch`、
 * `env.DB` は `getD1Database` に対応する）。
 */
export type CloudHarness = {
  /** Node 側から D1 と R2 を直に触るための束縛である。Worker の中の束縛と同じ実体を指す。 */
  env: Env;
  /**
   * Worker への要求である。vitest-pool-workers の `SELF` と同じ使い方をする。
   * 本物の端末と同じく、互換の版の見出し（いまの版）を足して送る。呼び手が見出しを載せていれば、そのまま送る。
   */
  SELF: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  /** 版の見出しを足さない要求である。版番号を入れる前の古い端末（版 0）の真似に使う。 */
  RAW: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  /** 逃げ道である。上の 2 つで足りないときだけ使う。 */
  mf: Miniflare;
  dispose: () => Promise<void>;
};

// URL の pathname は Windows で /D:/... になり、esbuild が解決できない。
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const BUNDLE_PATH = fileURLToPath(new URL('../src/index.bundle.js', import.meta.url));

const COMMON: BuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['workerd', 'browser', 'module', 'main'],
  target: 'es2022',
  write: false,
};

const bundles = new Map<string, Promise<string>>();

/**
 * Worker を 1 つの ESM に束ねる。テストのファイルごとに、下限の値ごとに 1 回で足りる。
 * minDeviceCompat を渡すと、端末に求める下限だけを差し替えた Worker を束ねる。
 * 差し替えは試験の中だけにあり、配備される入口（src/index.ts の既定の輸出）は MIN_DEVICE_COMPAT のままである。
 */
function workerScript(minDeviceCompat?: number): Promise<string> {
  const k = minDeviceCompat === undefined ? 'default' : String(minDeviceCompat);
  let p = bundles.get(k);
  if (!p) {
    const opts: BuildOptions = minDeviceCompat === undefined
      ? { ...COMMON, entryPoints: [ENTRY] }
      : {
          ...COMMON,
          stdin: {
            contents: `import { createApp } from './index.ts';\nexport default createApp({ minDeviceCompat: ${minDeviceCompat} });\n`,
            resolveDir: SRC_DIR,
            sourcefile: 'floor-entry.ts',
            loader: 'ts',
          },
        };
    p = build(opts).then((r) => {
      const out = r.outputFiles?.[0];
      if (!out) throw new Error('Worker を束ねられませんでした');
      return out.text;
    });
    bundles.set(k, p);
  }
  return p;
}

/** 本物の端末と同じく、版の見出しを足す。呼び手が載せていれば（古い版や壊れた値を試すとき）そのまま使う。 */
function withCompat(init: RequestInit = {}): RequestInit {
  const given = (init.headers ?? {}) as Record<string, string>;
  if (Object.keys(given).some((k) => k.toLowerCase() === COMPAT_HEADER)) return init;
  return { ...init, headers: { ...given, ...compatHeaders() } };
}

/** Worker を 1 つ起こす。記憶は instance ごとに新しいので、テストごとに呼んでよい（おおよそ 100 ミリ秒）。 */
export async function startCloud(options: { JOIN_SECRET_HASH?: string; bindings?: Record<string, string>; outbound?: (req: Request) => Response | Promise<Response>; minDeviceCompat?: number } = {}): Promise<CloudHarness> {
  const script = await workerScript(options.minDeviceCompat);
  const joinSecretHash = options.JOIN_SECRET_HASH ?? '';
  const mf = new Miniflare({
    modules: true,
    script,
    scriptPath: BUNDLE_PATH,
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['BUCKET'],
    bindings: { JOIN_SECRET_HASH: joinSecretHash, ...options.bindings },
    // Worker から外への fetch を受ける。渡さなければ外へは出ない（試験は実物の Cloudflare に触らない）。
    outboundService: options.outbound ?? (() => new Response('outbound fetch is not allowed in tests', { status: 599 })),
  });
  const env = {
    DB: await mf.getD1Database('DB'),
    BUCKET: await mf.getR2Bucket('BUCKET'),
    JOIN_SECRET_HASH: joinSecretHash,
  } as unknown as Env;
  return {
    env,
    SELF: { fetch: (input, init) => mf.dispatchFetch(input, withCompat(init) as never) as unknown as Promise<Response> },
    RAW: { fetch: (input, init) => mf.dispatchFetch(input, init as never) as unknown as Promise<Response> },
    mf,
    dispose: () => mf.dispose(),
  };
}
```

- [ ] **Step 6: 通るのを見る**

Run: `npx vitest run packages/cloud/test/compat.test.ts`
Expected: PASS（10 件）。

- [ ] **Step 7: Worker の既存の試験が崩れていないかを見る**

Run: `npx vitest run packages/cloud`
Expected: PASS（`SELF` が版を足すようになっても、下限 0 の Worker は今までどおり答える）。

- [ ] **Step 8: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 9: コミットする**

```bash
git add packages/cloud/src/compat.ts packages/cloud/src/index.ts packages/cloud/test/harness.ts packages/cloud/test/compat.test.ts
```

```bash
git commit -m "feat(cloud): stamp the compat version on every response and refuse older devices with 426" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: サーバの同期の client が版を載せ、合わない相手を CompatError にする

**Files:**
- Modify: `packages/server/src/sync/client.ts`（import、`CloudError` の後ろに `MIN_WORKER_COMPAT` と `CompatError`、`HttpCloudClientOptions`、constructor、`send()`）
- Modify: `packages/server/src/sync/client.test.ts`（import と、末尾に describe を 1 つ）
- Modify: `packages/cloud/test/client-e2e.test.ts`（import、beforeEach、末尾に describe を 1 つ）

**Interfaces:**
- Consumes: Task 1 の `COMPAT_HEADER`、`COMPAT_VERSION`、`compatHeaders`、`parseCompat`、`readCompatRefusal` と、Task 2 の `startCloud({ minDeviceCompat })`。
- Produces（`packages/server/src/sync/client.ts`）:
  - `MIN_WORKER_COMPAT = 0`
  - `type CompatUpgrade = 'device' | 'worker'`（上げるべき側で、device はこの PC の hangar、worker はクラウドの Worker）
  - `class CompatError extends CloudError`：`constructor(upgrade: CompatUpgrade, have: number, need: number | null)`、`status` は常に `426`、`name` は `'CompatError'`、`message` は利用者に見せる文。
    device のときの `have` はこの PC の版、`need` は Worker の下限（本文が読めなければ null）である。
    worker のときの `have` は Worker の版、`need` はこの PC の下限である。
  - device の文は「この PC の hangar」と「`<need> 以上`」（need が null なら「それより新しい版」）を含む。
    worker の文は「Worker」と「`<need> 以上`」と「今すぐ同期」を含む。
    Task 5 と Task 7 と Task 8 の試験は、この言葉で探す。
  - `HttpCloudClientOptions.minWorkerCompat?: number`（既定は `MIN_WORKER_COMPAT`）

- [ ] **Step 1: client の試験を書く**

`packages/server/src/sync/client.test.ts` の import を直す。

```ts
import { COMPAT_HEADER, COMPAT_VERSION, decodeHeaderText, isHeaderSafe } from '@agent-hangar/shared';
import { CloudError, CompatError, goneFloor, HttpCloudClient, isValidFileKey, MAX_PUT_BODY_BYTES, MIN_WORKER_COMPAT } from './client.ts';
```

ファイルの末尾に足す。

```ts
describe('互換の版', () => {
  /** どの経路にも、形の合う応答を返す。 */
  const anyRoute = (c: Call): Response =>
    c.init.method === 'PUT' ? json({ seq: 1 }, 201)
      : c.init.method === 'DELETE' ? new Response(null, { status: 204 })
        : /\/files\/./.test(new URL(c.url).pathname) ? new Response('payload')
          : json({ ok: true, version: '1', changes: [], nextAfter: null, seq: 0, nextSeq: 0, more: false, files: [], configured: false });

  it('Worker へのすべての要求に、この PC の版を見出しで載せる', async () => {
    const { fetch, calls } = fakeFetch(anyRoute);
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    await c.health();
    await c.pushChanges([]);
    await c.pullChanges(0, 10);
    await c.snapshot(null, 10);
    await c.listFiles(0, 10);
    await c.putFile({ key: 'transcripts/d/u.jsonl.gz', path: 'projects/-x/u.jsonl', kind: 'transcript', sha256: 'a'.repeat(64), size: 1, mtime: 1, encrypted: true }, Readable.from([Buffer.from('x')]));
    let got = 0;
    for await (const chunk of await c.getFile('transcripts/d/u.jsonl.gz')) got += (chunk as Buffer).length;
    expect(got).toBe('payload'.length);
    await c.deleteFile('transcripts/d/u.jsonl.gz');
    await c.usage();
    expect(calls).toHaveLength(9);
    for (const call of calls) expect(headersOf(call)[COMPAT_HEADER], call.url).toBe(String(COMPAT_VERSION));
    // 端末トークンは変わらず最後に載る。
    expect(bearerIs(calls[0]!, 't')).toBe(true);
  });

  it('426 は CompatError にし、この PC の hangar を上げるよう伝え、本文の下限を載せる', async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: 'upgrade required', minCompat: 2, compat: 2 }), { status: 426, headers: { 'content-type': 'application/json', [COMPAT_HEADER]: '2' } }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CompatError);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ name: 'CompatError', status: 426, upgrade: 'device', have: COMPAT_VERSION, need: 2 });
    expect((e as Error).message).toContain('この PC の hangar');
    expect((e as Error).message).toContain('2 以上');
  });

  it('426 の本文が読めなくても、この PC の hangar を上げるよう伝える', async () => {
    const { fetch } = fakeFetch(() => new Response('upgrade', { status: 426 }));
    const e = await new HttpCloudClient({ url: 'https://h', token: 't', fetch }).listFiles(0, 10).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'CompatError', upgrade: 'device', need: null });
    expect((e as Error).message).toContain('この PC の hangar');
    expect((e as Error).message).toContain('それより新しい版');
  });

  it('Worker の版がこの PC の下限より古ければ、通った応答でも CompatError にして Worker を上げるよう伝える', async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ changes: [], nextSeq: 0, more: false }), { status: 200, headers: { [COMPAT_HEADER]: '1' } }));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 2 });
    const e = await c.pullChanges(0, 10).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'CompatError', status: 426, upgrade: 'worker', have: 1, need: 2 });
    expect((e as Error).message).toContain('Worker');
    expect((e as Error).message).toContain('2 以上');
    expect((e as Error).message).toContain('今すぐ同期');
  });

  it('版の見出しを返さない Worker は版 0 として読み、下限が 0 なら今までどおり話す', async () => {
    expect(MIN_WORKER_COMPAT).toBe(0);
    const { fetch } = fakeFetch(() => json({ changes: [], nextSeq: 4, more: false }));
    expect(await new HttpCloudClient({ url: 'https://h', token: 't', fetch }).pullChanges(0, 10)).toEqual({ changes: [], nextSeq: 4, more: false });
    // 下限を 1 にすると、同じ Worker を古いと読む。
    const strict = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 1 });
    await expect(strict.pullChanges(0, 10)).rejects.toMatchObject({ upgrade: 'worker', have: 0, need: 1 });
  });

  it('古い Worker の 404 は、使用量の「トークンなし」に読み替える前に版の不一致として伝える', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'not found' }, 404));
    const c = new HttpCloudClient({ url: 'https://h', token: 't', fetch, minWorkerCompat: 1 });
    await expect(c.usage()).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker' });
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/client.test.ts`
Expected: FAIL（`CompatError` と `MIN_WORKER_COMPAT` が無い）。

- [ ] **Step 3: 実装する**

`packages/server/src/sync/client.ts` の shared の import に、5 つの名前を足す。

```ts
import {
  CLOUD_HEADERS,
  COMPAT_HEADER,
  COMPAT_VERSION,
  compatHeaders,
  encodeFileKeyPath,
  encodeHeaderText,
  isSafeRelPath,
  isValidFileKey,
  parseCompat,
  readCompatRefusal,
  type ChangeIn,
  type CloudUsageBody,
  type FileMetaIn,
  type ListFilesResponse,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
```

`const toCloudError = ...` の行の直後に足す。

```ts
/**
 * この PC が Worker に求める互換の版の下限。
 * 0 の間は、版の見出しを返さない古い Worker（版 0 として読む）とも話す。
 * Worker の API を古い Worker と話せない形で変えたら、その版に上げる。
 */
export const MIN_WORKER_COMPAT = 0;

/** 上げるべき側。device はこの PC の hangar、worker はクラウドの Worker である。 */
export type CompatUpgrade = 'device' | 'worker';

function compatMessage(upgrade: CompatUpgrade, have: number, need: number | null): string {
  if (upgrade === 'device') {
    const want = need === null ? 'それより新しい版' : `${need} 以上`;
    return `この PC の hangar が古いので、クラウドが同期を断りました（この PC の互換の版は ${have}、クラウドが求めるのは ${want}）。この PC の hangar を新しい版に入れ替えてください`;
  }
  return `クラウドの Worker が古いので、同期を止めました（Worker の互換の版は ${have}、この PC が求めるのは ${need ?? '?'} 以上）。setup した PC で hangar setup cloud をもう一度実行して Worker を入れ替えてから、「今すぐ同期」を押してください`;
}

/**
 * 互換の版が合わないときに投げる。
 * Worker に 426 で断られたら device（この PC を上げる）、Worker の名乗った版がこちらの下限より古ければ worker（Worker を上げる）である。
 * message は CloudError と違って応答の本文ではなく、利用者に見せる文で、どちらを上げればよいかを書く（同期の状態の error にそのまま出る）。
 * status は 426 に揃える。届いた要求として無料枠に数える既存の分岐（status が 0 でない）に、そのまま乗る。
 * 直りようのない 4xx として諦める所（uploader の isPermanentStatus）は、426 を一時の失敗として扱う。
 */
export class CompatError extends CloudError {
  constructor(readonly upgrade: CompatUpgrade, readonly have: number, readonly need: number | null) {
    super(426, compatMessage(upgrade, have, need));
    this.name = 'CompatError';
  }
}
```

`HttpCloudClientOptions` の最後（`maxBodyBytes?: number;` の次）に足す。

```ts
  /** この PC が Worker に求める互換の版の下限。既定は MIN_WORKER_COMPAT。試験が上げるために使う。 */
  minWorkerCompat?: number;
```

`HttpCloudClient` の項目に `private readonly minWorkerCompat: number;` を足し（`private readonly maxBodyBytes: number;` の次）、constructor の `this.maxBodyBytes = ...` の次に足す。

```ts
    this.minWorkerCompat = o.minWorkerCompat ?? MIN_WORKER_COMPAT;
```

`send()` を次に置き換える。

```ts
  /**
   * 要求を投げて応答の見出しまでを受ける。
   * 締め切りは呼び手が本体を読み終えるまで生きているので、Deadline は返して呼び手が clear する。
   *
   * 互換の版は、成否より先に見る。
   * 426 なら Worker がこの PC を断った。Worker の名乗った版が下限より古ければ、こちらが Worker を断る。
   * 古い Worker は要求をもう済ませている（push なら行を受け取っている）が、こちらは失敗として扱う。
   * 行は未送信のまま残り、Worker を上げた後の送り直しは LWW で同じ結果になる。
   */
  private async send(path: string, init: RequestInit & { duplex?: 'half' }, ms: number): Promise<{ res: Response; d: Deadline }> {
    const d = new Deadline(ms);
    let res: Response;
    try {
      // 版と authorization は後ろに置く。呼び手のヘッダで取り違えて外れることがない。
      res = await d.race(
        this.fetchFn(`${this.base}${path}`, {
          ...init,
          signal: d.signal,
          headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), ...compatHeaders(), authorization: this.authorization() },
        } as RequestInit),
      );
    } catch (e) {
      d.clear();
      throw toCloudError(e);
    }
    if (res.status === 426) {
      const text = await d.race(res.text()).catch(() => '');
      d.clear();
      throw new CompatError('device', COMPAT_VERSION, readCompatRefusal(text));
    }
    const workerCompat = parseCompat(res.headers.get(COMPAT_HEADER));
    if (workerCompat < this.minWorkerCompat) {
      void res.body?.cancel().catch(() => {});
      d.clear();
      throw new CompatError('worker', workerCompat, this.minWorkerCompat);
    }
    if (!res.ok) {
      const text = await d.race(res.text()).catch(() => '');
      d.clear();
      throw new CloudError(res.status, text.slice(0, 200) || `HTTP ${res.status}`);
    }
    return { res, d };
  }
```

- [ ] **Step 4: client の試験が通るのを見る**

Run: `npx vitest run packages/server/src/sync/client.test.ts`
Expected: PASS（既存の偽の応答は版の見出しを持たないので版 0 の古い Worker として読まれ、下限 0 で今までどおり話すので、既存の試験も通る）。

- [ ] **Step 5: 本物の client と本物の Worker の試験を書く**

`packages/cloud/test/client-e2e.test.ts` の import を直す。

```ts
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
import { CompatError, HttpCloudClient } from '../../server/src/sync/client.ts';
```

`let spoolDir = '';` の次に足す。

```ts
let workerUrl = '';
let token = '';
```

`beforeEach` を次に置き換える。

```ts
beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  workerUrl = String(await cloud.mf.ready).replace(/\/+$/, '');
  // 参加は版の見出しを載せない（版 0 の古い端末と同じ）。本番の下限 0 の Worker では通る。
  const r = await fetch(`${workerUrl}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id: 'dev-a', name: 'dev-a', platform: 'darwin' } }),
  });
  token = ((await r.json()) as { deviceToken: string }).deviceToken;
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-e2e-'));
  client = new HttpCloudClient({ url: workerUrl, token, spoolDir });
});
```

ファイルの末尾に足す。

```ts
describe('互換の版（本物の client と本物の Worker）', () => {
  it('要求と応答の両方に版の見出しが載る', async () => {
    const seen: { sent: string | null; got: string | null }[] = [];
    const watched = new HttpCloudClient({
      url: workerUrl,
      token,
      spoolDir,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(input, init);
        seen.push({ sent: (init?.headers as Record<string, string> | undefined)?.[COMPAT_HEADER] ?? null, got: res.headers.get(COMPAT_HEADER) });
        return res;
      }) as typeof fetch,
    });
    await watched.pullChanges(0, 10);
    await watched.listFiles(0, 10);
    const v = String(COMPAT_VERSION);
    expect(seen).toEqual([{ sent: v, got: v }, { sent: v, got: v }]);
  });

  it('この PC の下限より Worker が古ければ、Worker を上げるよう伝える', async () => {
    const strict = new HttpCloudClient({ url: workerUrl, token, spoolDir, minWorkerCompat: COMPAT_VERSION + 1 });
    await expect(strict.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: COMPAT_VERSION, need: COMPAT_VERSION + 1 });
  });

  it('Worker が下限を上げたら、426 を受けてこの PC の hangar を上げるよう伝える', async () => {
    const floor = COMPAT_VERSION + 1;
    resetSchemaCache();
    const strictCloud = await startCloud({ minDeviceCompat: floor });
    try {
      resetSchemaCache();
      await ensureSchema({ ...strictCloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
      const url = String(await strictCloud.mf.ready).replace(/\/+$/, '');
      // 参加は、下限と同じ版を名乗る新しい端末のふりをして通す。
      const r = await fetch(`${url}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [COMPAT_HEADER]: String(floor) },
        body: JSON.stringify({ secret: SECRET, device: { id: 'dev-b', name: 'dev-b', platform: 'darwin' } }),
      });
      expect(r.status).toBe(201);
      const { deviceToken } = (await r.json()) as { deviceToken: string };
      const older = new HttpCloudClient({ url, token: deviceToken, spoolDir });
      const e = await older.pullChanges(0, 10).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CompatError);
      expect(e).toMatchObject({ upgrade: 'device', have: COMPAT_VERSION, need: floor });
    } finally {
      await strictCloud.dispose();
    }
  });
});
```

- [ ] **Step 6: e2e が通るのを見る**

Run: `npx vitest run packages/cloud/test/client-e2e.test.ts`
Expected: PASS（4 件）。

- [ ] **Step 7: 同期と CLI の試験が崩れていないかを見る**

Run: `npx vitest run packages/server/src/sync packages/cli`
Expected: PASS。

- [ ] **Step 8: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 9: コミットする**

```bash
git add packages/server/src/sync/client.ts packages/server/src/sync/client.test.ts packages/cloud/test/client-e2e.test.ts
```

```bash
git commit -m "feat(sync): send the compat version and turn mismatches into CompatError" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 偽のクラウドにも Worker の版と下限を持たせる

**Files:**
- Modify: `packages/server/test/fake-cloud.ts`（import、`FakeCloudStore`、上限の写しの並び、constructor、出入り口、`guard()`）
- Modify: `packages/server/test/fake-cloud.test.ts`（import、`workerConstant` の引数、末尾に describe を 1 つ）

**Interfaces:**
- Consumes: Task 1 の `COMPAT_VERSION`、Task 2 の `packages/cloud/src/compat.ts` の `export const MIN_DEVICE_COMPAT = 0;` の行、Task 3 の `CompatError` と `MIN_WORKER_COMPAT`。
- Produces（`packages/server/test/fake-cloud.ts`）:
  - `MIN_DEVICE_COMPAT = 0`（Worker の写し）
  - `FakeCloudStore.workerCompat: number`（既定 `COMPAT_VERSION`）と `FakeCloudStore.minDeviceCompat: number`（既定 `MIN_DEVICE_COMPAT`）
  - `new FakeCloudClient({ minWorkerCompat?: number })`（既定 `MIN_WORKER_COMPAT`）と `readonly minWorkerCompat: number`
  - 出入り口 `workerCompat` と `minDeviceCompat`（`offline` と同じく、`asDevice` で作った別端末とも共有する）
  - 偽物の端末は常に `COMPAT_VERSION` を名乗る。
    下限が上がれば、`health` 以外のすべての経路が `CompatError('device', COMPAT_VERSION, minDeviceCompat)` を投げる。
    Worker の版がこの端末の下限より古ければ、`CompatError('worker', workerCompat, minWorkerCompat)` を投げる。
    どちらも認証の 401 より先に見る（Task 5 と Task 6 の試験が使う）。

- [ ] **Step 1: 試験を書く**

`packages/server/test/fake-cloud.test.ts` の import を直す。

```ts
import { COMPAT_VERSION, MAX_PUSH_BATCH } from '@agent-hangar/shared';
import { CloudError, CompatError, goneFloor } from '../src/sync/client.ts';
import { FakeCloudClient, MAX_BODY_BYTES, MAX_ROW_BYTES, MAX_ROW_ID_CHARS, MIN_DEVICE_COMPAT } from './fake-cloud.ts';
```

`workerConstant` の引数の型に `'compat.ts'` を足す（本体はそのまま）。

```ts
function workerConstant(file: 'changes.ts' | 'files.ts' | 'compat.ts', name: string): number {
```

ファイルの末尾に足す。

```ts
describe('互換の版', () => {
  it('端末に求める下限は実物の Worker の写しで、既定では今の版どうしなので通る', async () => {
    expect(MIN_DEVICE_COMPAT).toBe(workerConstant('compat.ts', 'MIN_DEVICE_COMPAT'));
    const a = new FakeCloudClient({ deviceId: 'a' });
    expect(a.workerCompat).toBe(COMPAT_VERSION);
    expect(a.minDeviceCompat).toBe(MIN_DEVICE_COMPAT);
    expect(await a.pushChanges([ch('p1', 1)])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 0 }));
  });

  it('Worker が下限を上げたら、どの経路も 426 の CompatError で断って何も預からず、/health だけは通る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    a.minDeviceCompat = COMPAT_VERSION + 1;
    await expect(a.pushChanges([ch('p1', 1)])).rejects.toMatchObject({ name: 'CompatError', status: 426, upgrade: 'device', have: COMPAT_VERSION, need: COMPAT_VERSION + 1 });
    await expect(a.pullChanges(0, 10)).rejects.toBeInstanceOf(CompatError);
    await expect(a.snapshot(null, 10)).rejects.toBeInstanceOf(CompatError);
    await expect(a.listFiles(0, 10)).rejects.toBeInstanceOf(CompatError);
    await expect(a.putFile(meta('transcripts/a/u.jsonl.gz'), Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(CompatError);
    await expect(a.getFile('transcripts/a/u.jsonl.gz')).rejects.toBeInstanceOf(CompatError);
    await expect(a.usage()).rejects.toBeInstanceOf(CompatError);
    expect(a.changes).toHaveLength(0);
    expect(a.files.size).toBe(0);
    expect(await a.health()).toEqual({ ok: true, version: 'fake' });
  });

  it('版の関所は認証より先にある（実物の Worker と同じ順）', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    a.unauthorized = true;
    a.minDeviceCompat = COMPAT_VERSION + 1;
    await expect(a.pullChanges(0, 10)).rejects.toMatchObject({ status: 426 });
  });

  it('Worker の版がこの端末の下限より古ければ、Worker を上げるよう断る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a', minWorkerCompat: 1 });
    expect(a.minWorkerCompat).toBe(1);
    a.workerCompat = 0;
    await expect(a.pullChanges(0, 10)).rejects.toMatchObject({ name: 'CompatError', upgrade: 'worker', have: 0, need: 1 });
    expect(a.changes).toHaveLength(0);
  });

  it('版の見出しを返さない古い Worker（版 0）とも、下限が 0 の端末は話す', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    expect(a.minWorkerCompat).toBe(0);
    a.workerCompat = 0;
    expect(await a.pushChanges([ch('p1', 1)])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 0 }));
  });

  it('別の端末も、同じ Worker の版と下限を見る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const b = a.asDevice('b');
    a.minDeviceCompat = COMPAT_VERSION + 1;
    await expect(b.pullChanges(0, 10)).rejects.toBeInstanceOf(CompatError);
    expect(b.minDeviceCompat).toBe(COMPAT_VERSION + 1);
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/test/fake-cloud.test.ts`
Expected: FAIL（`MIN_DEVICE_COMPAT` が fake-cloud.ts に無く、`workerCompat` と `minDeviceCompat` の出入り口も無い）。

- [ ] **Step 3: 実装する**

`packages/server/test/fake-cloud.ts` の import を直す（shared に `COMPAT_VERSION` を足し、client から `CompatError` と `MIN_WORKER_COMPAT` を取る）。

```ts
import {
  COMPAT_VERSION,
  MAX_PUSH_BATCH,
  PULL_LIMIT,
  SHARED_TABLES,
  decodeHeaderText,
  encodeHeaderText,
  isHeaderSafe,
  isSafeRelPath,
  type ChangeIn,
  type CloudUsageBody,
  type ChangeOut,
  type FileEntry,
  type FileMetaIn,
  type ListFilesResponse,
  type PullChangesResponse,
  type PushChangesResponse,
  type SnapshotResponse,
} from '@agent-hangar/shared';
import { CloudError, CompatError, isValidFileKey, MIN_WORKER_COMPAT, type CloudClient } from '../src/sync/client.ts';
```

`FakeCloudStore` の `now: () => number;` の前に足す。

```ts
  /** Worker の互換の版。0 にすると、版の見出しを返さない古い Worker（版番号を入れる前に配備したもの）の真似になる。 */
  workerCompat: number;
  /** Worker が端末に求める下限。実物の原本は packages/cloud/src/compat.ts の MIN_DEVICE_COMPAT。 */
  minDeviceCompat: number;
```

`export const MAX_BODY_BYTES = 100 * 1024 * 1024;` の次に足す。

```ts
/**
 * 実物の Worker が端末に求める互換の版の下限（packages/cloud/src/compat.ts の写し）。
 * ずれていないことは fake-cloud.test.ts の「端末に求める下限は実物の Worker の写し」が原本を読んで縛る。
 */
export const MIN_DEVICE_COMPAT = 0;
```

`FakeCloudClient` の項目と constructor を次に置き換える（`readonly deviceId: string;` までの 3 行と constructor）。

```ts
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly store: FakeCloudStore;
  readonly deviceId: string;
  /** この端末が Worker に求める互換の版の下限。HttpCloudClient の minWorkerCompat に当たる。 */
  readonly minWorkerCompat: number;

  constructor(o: { deviceId?: string; store?: FakeCloudStore; now?: () => number; minWorkerCompat?: number } = {}) {
    this.deviceId = o.deviceId ?? 'self';
    this.minWorkerCompat = o.minWorkerCompat ?? MIN_WORKER_COMPAT;
    this.store = o.store ?? {
      changes: [],
      rows: new Map(),
      files: new Map(),
      seq: 0,
      fileSeq: 0,
      changesFloor: 0,
      lastSweepAt: null,
      offline: false,
      unauthorized: false,
      d1Rows: new Map(),
      workerCompat: COMPAT_VERSION,
      minDeviceCompat: MIN_DEVICE_COMPAT,
      now: o.now ?? (() => Date.now()),
    };
    if (o.store && o.now) this.store.now = o.now;
  }
```

`set unauthorized(v: boolean) { ... }` の行の次に足す。

```ts
  /** Worker の互換の版。下げると、この端末の下限より古い Worker の真似になる。 */
  get workerCompat(): number { return this.store.workerCompat; }
  set workerCompat(v: number) { this.store.workerCompat = v; }
  /** Worker が端末に求める下限。上げると、この端末が古いと断られる。 */
  get minDeviceCompat(): number { return this.store.minDeviceCompat; }
  set minDeviceCompat(v: number) { this.store.minDeviceCompat = v; }
```

`guard()` を次に置き換える。

```ts
  private guard(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    // 繋がらなければ認証にも辿り着かないので、offline を先に見る。
    if (this.store.offline) throw new CloudError(0, 'offline');
    // 版の関所は Worker のどの経路よりも先にある（認証より先）。/health だけは版を問わずに通る。
    // 偽物の端末は常に今の版を名乗る（HttpCloudClient と同じ）。
    if (method !== 'health' && COMPAT_VERSION < this.store.minDeviceCompat) throw new CompatError('device', COMPAT_VERSION, this.store.minDeviceCompat);
    // 応答の版をこの端末の下限と比べる（HttpCloudClient の send と同じく、成否より先に見る）。
    // 実物では古い Worker が要求を済ませてから端末が断るが、偽物は先に断る。
    // どちらでも行は未送信のまま残り、Worker を上げた後の送り直しは LWW で同じ結果になる。
    if (this.store.workerCompat < this.minWorkerCompat) throw new CompatError('worker', this.store.workerCompat, this.minWorkerCompat);
    if (this.store.unauthorized) throw new CloudError(401, errorBody('unauthorized'));
  }
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/server/test/fake-cloud.test.ts`
Expected: PASS。

- [ ] **Step 5: 偽物を使う試験が崩れていないかを見る**

Run: `npx vitest run packages/server`
Expected: PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/server/test/fake-cloud.ts packages/server/test/fake-cloud.test.ts
```

```bash
git commit -m "test(sync): model the compat version and floors in the fake cloud" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 同期のエンジンが版の不一致で止まり、上げる側を error に出す

**Files:**
- Modify: `packages/server/src/sync/engine.ts`（import、項目、`halted`、`failPush` と `failPull`、`status()`、`syncNow()`、`pullBeforeLaunch()`）
- Modify: `packages/server/src/sync/engine.test.ts`（import と、末尾に describe を 1 つ）

**Interfaces:**
- Consumes: Task 3 の `CompatError` と `MIN_WORKER_COMPAT`、Task 4 の `FakeCloudClient` の `minDeviceCompat`、`workerCompat`、`minWorkerCompat`。
- Produces:
  - `SyncEngine.compatBlocked(): boolean`（版で止まっているか、Task 7 の `server.ts` が使う）。
  - 版で止まっている間の `status()` は `state: 'error'` で、`error` は `CompatError` の文（一時停止していても先に出す）。
  - 版で止まっている間は、push、pull、起動前の pull が外へ出ない。
  - `syncNow()` は、実際に送受信を試す回だけ止めた印を外して試し直す（一時停止のまま何も送らない回では外さない）。
  - 止めた印は `sync_state` に残さない（立て直せば消える）。

- [ ] **Step 1: 試験を書く**

`packages/server/src/sync/engine.test.ts` の import を直す。

```ts
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { CloudError, MIN_WORKER_COMPAT } from './client.ts';
```

ファイルの末尾に足す。

```ts
describe('互換の版', () => {
  /** Worker の下限を上げて、書き込みの push を断らせる。push で止まった状態を作る。 */
  const blockOnPush = async (e: SyncEngine): Promise<void> => {
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    project('p1');
    await timers.advance(1_000);
    await e.idle();
  };

  it('Worker に断られたら（426）同期を止め、この PC の hangar を上げるよう error に出す', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    expect(e.compatBlocked()).toBe(true);
    expect(e.status()).toMatchObject({ state: 'error', pending: 1 });
    expect(e.status().error).toContain('この PC の hangar');
    // 止めた後は、書き込みも定期実行も外へ出ない。
    const calls = cloud.calls.length;
    project('p2');
    await timers.advance(5 * 60_000);
    await e.idle();
    expect(cloud.calls.length).toBe(calls);
    expect(unpushed()).toBe(2);
    e.stop();
  });

  it('Worker の版がこの PC の下限より古ければ同期を止め、Worker を上げるよう error に出す', async () => {
    cloud = new FakeCloudClient({ deviceId: 'a', minWorkerCompat: COMPAT_VERSION });
    cloud.workerCompat = COMPAT_VERSION - 1;
    const e = make();
    await e.start();
    expect(e.compatBlocked()).toBe(true);
    expect(e.status().state).toBe('error');
    expect(e.status().error).toContain('Worker');
    expect(e.status().error).toContain('今すぐ同期');
    e.stop();
  });

  it('版の見出しを返さない古い Worker（版 0）でも、この PC の下限が 0 なら同期は動く', async () => {
    expect(MIN_WORKER_COMPAT).toBe(0);
    cloud.workerCompat = 0;
    const e = make();
    await e.start();
    project('p1');
    await timers.advance(1_000);
    await e.idle();
    expect(cloud.changes.map((c) => c.rowId)).toEqual(['p1']);
    expect(e.compatBlocked()).toBe(false);
    expect(e.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e.stop();
  });

  it('止まった後も、利用者の今すぐ同期は 1 度だけ試し直し、直っていれば戻る', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    // まだ合わなければ、試し直しても止まったまま。
    const before = cloud.calls.length;
    await e.syncNow();
    expect(cloud.calls.length).toBeGreaterThan(before);
    expect(e.compatBlocked()).toBe(true);
    // Worker の側が合えば、次の今すぐ同期で戻る。
    cloud.minDeviceCompat = 0;
    await e.syncNow();
    expect(e.compatBlocked()).toBe(false);
    expect(e.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e.stop();
  });

  it('push で止まった後の起動前の pull は、外へ出ずに false を返す', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    const before = cloud.calls.length;
    expect(await e.pullBeforeLaunch()).toBe(false);
    expect(cloud.calls.length).toBe(before);
    e.stop();
  });

  it('止めた印は DB に残さない。立て直したら最初の要求でまた確かめる', async () => {
    const e = make();
    await e.start();
    await blockOnPush(e);
    e.stop();
    // この PC の hangar を入れ替えて立て直した筋（相手とも版が合っている）。
    cloud.minDeviceCompat = 0;
    const e2 = make();
    expect(e2.compatBlocked()).toBe(false);
    await e2.start();
    expect(e2.status()).toMatchObject({ state: 'idle', error: null, pending: 0 });
    e2.stop();
  });

  it('一時停止していても、版で止まったことを error で見せる', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    project('p1');
    await e.syncNow({ evenIfPaused: true });
    expect(e.status().state).toBe('error');
    expect(e.status().error).toContain('この PC の hangar');
    expect(e.status().pausedReason).toBeNull();
    e.stop();
  });

  it('一時停止のまま何も送らない今すぐ同期では、止めた印を外さない', async () => {
    const e = make();
    await e.start();
    e.setPaused(true);
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    project('p1');
    await e.syncNow({ evenIfPaused: true });
    expect(e.compatBlocked()).toBe(true);
    // 一時停止の 1 巡でない今すぐ同期は何も送らないので、表示だけが一時停止に戻ることはない。
    await e.syncNow();
    expect(e.compatBlocked()).toBe(true);
    expect(e.status().state).toBe('error');
    e.stop();
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/engine.test.ts`
Expected: FAIL（`compatBlocked` が無く、一時停止中の 426 は `paused` と出て、push で止まった後の `pullBeforeLaunch` は true を返す）。

- [ ] **Step 3: 実装する**

`packages/server/src/sync/engine.ts` の client の import に `CompatError` を足す。

```ts
import { CloudError, CompatError, goneFloor, type CloudClient } from './client.ts';
```

`private pullError: string | null = null;` の次に足す。

```ts
  /**
   * 互換の版が合わずに止めた理由（CompatError の文）。null なら止めていない。
   *
   * 一時停止（paused）とは別に持ち、sync_state には残さない。
   * 直す道は、この PC の hangar を入れ替える（立て直しで消える）か、Worker を入れ替えて「今すぐ同期」を押す（syncNow で外す）かである。
   * 残すと、直した後も止まり続ける。
   */
  private compatBlock: string | null = null;
```

`halted` を次に置き換える。

```ts
  /** push と pull の入口を閉じているか。版で止まっているとき、または一時停止していて頼まれた 1 巡の最中でもないとき。 */
  private get halted(): boolean { return this.compatBlock !== null || (this.paused && !this.onePass); }

  /** 互換の版が合わずに止まっているか。本文と設定の出し入れと使用量も、これを見て止まる（server.ts の syncHalted）。 */
  compatBlocked(): boolean { return this.compatBlock !== null; }
```

`failPush` と `failPull` を次に置き換え、その後ろに 1 つ足す。

```ts
  protected failPush(e: unknown): void { this.pushError = errorMessage(e); this.noteCompat(e); this.persistError(); }
  protected failPull(e: unknown): void { this.pullError = errorMessage(e); this.noteCompat(e); this.persistError(); }
  /** 版が合わないと分かったら止める。理由の文は CompatError が持っている（どちらを上げればよいか）。 */
  private noteCompat(e: unknown): void { if (e instanceof CompatError) this.compatBlock = e.message; }
```

`status()` の `state` の組み立てと `error` の行を次に置き換える。

```ts
    const state: SyncStateKind = !this.deps.client ? 'off'
      // 版で止まっているときは、一時停止より先に見せる。直す道（どちらを上げるか）が error の文にしか無いからである。
      : this.compatBlock !== null ? 'error'
      : this.paused ? 'paused'
      : this.pushing ? 'pushing'
      : this.pulling ? 'pulling'
      : this.lastError ? 'error'
      : 'idle';
```

```ts
      error: state === 'error' ? (this.compatBlock ?? this.lastError) : null,
```

`syncNow()` の先頭（`if (!o.evenIfPaused || !this.paused || this.onePass) {` の前）に足す。

```ts
    // 版で止まっていても、利用者が押した 1 回は試し直す。Worker を入れ替えた後に戻る道はここだけである。
    // まだ合わなければ、その 1 回の失敗でまた止まる。
    // 一時停止のまま何も送らない回では外さない。外すと、試してもいないのに表示だけが一時停止に戻る。
    if (!this.paused || o.evenIfPaused || this.onePass) this.compatBlock = null;
```

`pullBeforeLaunch()` の 1 行目を次に置き換える。

```ts
    if (!this.deps.client || this.paused || this.compatBlock !== null) return false;
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/server/src/sync/engine.test.ts`
Expected: PASS（既存の試験も通る）。

- [ ] **Step 5: 同期のほかの試験が崩れていないかを見る**

Run: `npx vitest run packages/server/src/sync`
Expected: PASS。

- [ ] **Step 6: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 7: コミットする**

```bash
git add packages/server/src/sync/engine.ts packages/server/src/sync/engine.test.ts
```

```bash
git commit -m "feat(sync): stop syncing on a compat mismatch and say which side to upgrade" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 本文の上げ下ろしは、版で断られても諦めない

**Files:**
- Modify: `packages/server/src/sync/uploader.ts:65`（`isPermanentStatus`）
- Modify: `packages/server/src/sync/uploader.test.ts`（import、`it.each` の一時の失敗の並び、新しい試験を 1 つ）
- Modify: `packages/server/src/sync/puller.ts`（import、`pullNowInner()` の項目ごとの catch）
- Modify: `packages/server/src/sync/puller.test.ts`（import、新しい試験を 1 つ）

**Interfaces:**
- Consumes: Task 1 の `COMPAT_VERSION`、Task 3 の `CompatError`、Task 4 の `FakeCloudClient.minDeviceCompat`。
- Produces: 上げる側は 426 を一時の失敗として待ち行列に残す（諦めの控えに載せない）。
  降ろす側は `CompatError` を受けたら、その項目を諦めに数えずに回ごと投げ、`filesSeq` を進めない。

- [ ] **Step 1: 試験を書く**

`packages/server/src/sync/uploader.test.ts` の import に足す。

```ts
import { COMPAT_VERSION, type FileMetaIn } from '@agent-hangar/shared';
```

（いまの `import type { FileMetaIn } from '@agent-hangar/shared';` を、この 1 行に置き換える。）

一時の失敗の `it.each` の並びに 426 を足す。

```ts
  it.each([500, 503, 408, 429, 426])('%i は一時の失敗として待ち行列に残し、復帰で送る', async (status) => {
```

その `it.each` の直後に足す。

```ts
  it('互換の版で断られた本文は諦めず、版が合えば上げる', async () => {
    const up = make();
    cloud.minDeviceCompat = COMPAT_VERSION + 1;
    up.noteChanged({ path: mainFile(), sessionId: UUID, agentId: null });
    await timers.advance(30_000);
    await up.idle();
    expect(puts()).toBe(1);
    expect(skipRow()).toBeNull();
    expect(up.skippedUploads()).toEqual([]);
    cloud.minDeviceCompat = 0;
    await up.flushAll();
    expect(cloud.files.size).toBe(1);
    up.stop();
  });
```

`packages/server/src/sync/puller.test.ts` の import を直す。

```ts
import { COMPAT_VERSION, transcriptKey, type FileEntry, type FileMetaIn } from '@agent-hangar/shared';
import { CompatError, type CloudClient } from './client.ts';
```

「同じ項目で続けて失敗したら 3 回で諦めて先に進む」の試験の直後に足す。

```ts
  it('互換の版で断られた回は、項目を諦めに数えず、filesSeq も進めない', async () => {
    await putRemote('dev-b', `projects/-w-alpha/${UUID}.jsonl`, '{"a":1}\n');
    const p = make();
    const realGet = cloud.getFile.bind(cloud);
    cloud.getFile = async () => { throw new CompatError('device', COMPAT_VERSION, COMPAT_VERSION + 1); };
    for (let i = 0; i < 3; i++) await expect(p.pullNow()).rejects.toBeInstanceOf(CompatError);
    expect(p.skippedEntries()).toEqual([]);
    expect(errors).toEqual([]);
    expect(state.getNumber('filesSeq', 0)).toBe(0);
    // 版が合えば、同じ項目が降りてくる。
    cloud.getFile = realGet;
    expect(await p.pullNow()).toEqual({ downloaded: 1, configEntries: 0 });
  });
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/server/src/sync/uploader.test.ts packages/server/src/sync/puller.test.ts`
Expected: FAIL（上げる側は 426 を直りようのない失敗として諦めて `skipRow()` が null にならず、降ろす側は 3 回で諦めて `pullNow()` が reject しない）。

- [ ] **Step 3: 実装する**

`packages/server/src/sync/uploader.ts` の `isPermanentStatus` を次に置き換える。

```ts
/**
 * 何度送っても同じ答えが返る 4xx か。
 * 408（時間切れ）と 429（混み合い）は待てば通る。
 * 426 は互換の版が合わないときで、この PC か Worker のどちらかを上げれば通る（client.ts の CompatError）。
 */
const isPermanentStatus = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 426 && status !== 429;
```

`packages/server/src/sync/puller.ts` の client の import を次に置き換える。

```ts
import { CompatError, type CloudClient } from './client.ts';
```

`pullNowInner()` の中の、項目ごとの `catch (err) {` の中身を次に置き換える。

```ts
        } catch (err) {
          // 版が合わずに断られたのは、この項目のせいではない。諦めに数えずに回ごと止め、filesSeq も進めない。
          if (err instanceof CompatError) throw err;
          if (this.noteFailure(e.key, [e], e.sha256, errorMessage(err))) minFailed = minFailed === null ? e.seq : Math.min(minFailed, e.seq);
        }
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/server/src/sync/uploader.test.ts packages/server/src/sync/puller.test.ts`
Expected: PASS。

- [ ] **Step 5: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: コミットする**

```bash
git add packages/server/src/sync/uploader.ts packages/server/src/sync/uploader.test.ts packages/server/src/sync/puller.ts packages/server/src/sync/puller.test.ts
```

```bash
git commit -m "fix(sync): never give up on transcripts refused for a compat mismatch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: サーバの結線と /health の版

**Files:**
- Modify: `packages/server/src/server.ts`（`configSyncActive` の次に `syncHalted` を足す、`startServer` の中の `isPaused` と `syncNow`）
- Modify: `packages/server/src/http/app.ts`（import と `/health`）
- Modify: `packages/server/src/http/app.test.ts`（import と、`/health` の 2 つの試験）
- Modify: `packages/server/src/server.test.ts`（import、`presetPaused` を外へ出す、末尾に describe を 1 つ）

**Interfaces:**
- Consumes: Task 1 の `COMPAT_VERSION` と `COMPAT_HEADER`、Task 5 の `SyncEngine.compatBlocked()`。
- Produces:
  - `syncHalted(o: { paused: boolean; oncePass: boolean; compatBlocked: boolean }): boolean`（`server.ts` から輸出）。
  - サーバの `/health` は `{ ok, version, compat: COMPAT_VERSION, ready, index }` を返し、殻の照合（PR 7）がこれを読む。
  - 版で止まっている間は、本文と設定の出し入れと使用量の取りに行きも止まる。
  - 一時停止していて版で止まっているときの「今すぐ同期」は、一時停止の 1 巡（`PausedPass`）の道を通って試し直す。

- [ ] **Step 1: /health の試験を直す**

`packages/server/src/http/app.test.ts` の import に足す。

```ts
import { COMPAT_VERSION } from '@agent-hangar/shared';
```

「/health は ok と文字列の version に…」の試験の直前のコメントの末尾に 1 行足し、`toEqual` に `compat` を足す。

```ts
  // compat は互換の版番号で、殻が既存のサーバを採る前に自分の同梱するサーバの版と比べる（段 1 の PR 7）。
  it('/health は ok と文字列の version に、互換の版と、起動が済んだかと索引の進み具合を添えて返す', async () => {
    const res = await get('/health', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: unknown };
    const total = deps.indexer.progress().total;
    expect(total).toBeGreaterThan(0);
    expect(body).toEqual({ ok: true, version: '0.0.0-test', compat: COMPAT_VERSION, ready: true, index: { phase: 'idle', done: total, total } });
    expect(typeof body.version).toBe('string');
  });
  it('起動の途中の /health は ready を偽にし、索引の今の件数を返す', async () => {
    const booting = createApp({ ...deps, ready: () => false, indexer: { progress: () => ({ phase: 'indexing', done: 412, total: 987 }), rebuild: async () => {} } });
    const body = await (await booting.request('/health')).json();
    expect(body).toEqual({ ok: true, version: '0.0.0-test', compat: COMPAT_VERSION, ready: false, index: { phase: 'indexing', done: 412, total: 987 } });
  });
```

- [ ] **Step 2: 結線の試験を書く**

`packages/server/src/server.test.ts` の import に足す。

```ts
import { COMPAT_HEADER, COMPAT_VERSION } from '@agent-hangar/shared';
```

`./server.ts` からの import に `syncHalted` を足す。

`describe('一時停止は外と話さない', …)` の中にある `presetPaused` を、そこから消して、モジュールの上の方（`seedOldServerProgress` の次）に移す。

```ts
/** startServer より先に DB を作って、同期を止めた状態にしておく。 */
function presetPaused(): void {
  const db = openDb(dbPath(home));
  try { db.prepare("insert into sync_state (key, value) values ('paused', '1') on conflict(key) do update set value = '1'").run(); } finally { db.close(); }
}
```

ファイルの末尾に足す。

```ts
describe('互換の版', () => {
  type Seen = { method: string; path: string; compat: string | undefined };
  type Answer = { status: number; body: unknown; compat?: string };

  /** 決まった応答を返す立て替えの Worker。受けた要求と、載っていた版の見出しを記録する。実物のクラウドには触らない。 */
  async function fakeWorker(answer: (method: string, path: string) => Answer): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
    const seen: Seen[] = [];
    const srv = http.createServer((req, res) => {
      const p = (req.url ?? '').split('?')[0]!;
      const h = req.headers[COMPAT_HEADER];
      seen.push({ method: req.method ?? '', path: p, compat: Array.isArray(h) ? h[0] : h });
      req.resume();
      const a = answer(req.method ?? '', p);
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.compat === undefined ? {} : { [COMPAT_HEADER]: a.compat }) });
      res.end(JSON.stringify(a.body));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      seen,
      close: async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); },
    };
  }

  /** 下限を上げた Worker の断り。 */
  const refuse = (floor: number): Answer => ({ status: 426, body: { error: 'upgrade required', minCompat: floor, compat: floor }, compat: String(floor) });
  const joinTo = (url: string): void => saveCloudConfig(home, { url, joinSecret: 'test-secret', deviceToken: 'test-device-token', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
  const syncStatus = async (port: number): Promise<SyncStatusBody> => (await (await fetch(`http://127.0.0.1:${port}/api/sync/status`, { headers: { authorization: `Bearer ${tokenOf()}` } })).json()) as SyncStatusBody;
  const pressSyncNow = async (port: number): Promise<SyncStatusBody> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sync/now`, { method: 'POST', headers: { authorization: `Bearer ${tokenOf()}`, origin: `http://127.0.0.1:${port}` } });
    expect(r.status).toBe(200);
    return (await r.json()) as SyncStatusBody;
  };
  const metaCalls = (seen: Seen[]): number => seen.filter((r) => r.path === '/changes' || r.path === '/rows').length;

  it('版で止まっている間は、本文と設定の出し入れも止める。頼まれた 1 巡の最中でも止める', () => {
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: false })).toBe(false);
    expect(syncHalted({ paused: true, oncePass: false, compatBlocked: false })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: false })).toBe(false);
    expect(syncHalted({ paused: false, oncePass: false, compatBlocked: true })).toBe(true);
    expect(syncHalted({ paused: true, oncePass: true, compatBlocked: true })).toBe(true);
  });

  it('Worker に版が古いと断られたら、同期を止めて、この PC の hangar を上げるよう出す', async () => {
    const floor = COMPAT_VERSION + 1;
    const w = await fakeWorker(() => refuse(floor));
    joinTo(w.url);
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const st = await until(async () => { const v = await syncStatus(s.port); return v.state === 'error' ? v : null; });
      expect(st.error).toContain('この PC の hangar');
      expect(st.error).toContain(`${floor} 以上`);
      // 今すぐ同期を押せば 1 度だけ試し直す。まだ合わないので止まったまま。
      const before = metaCalls(w.seen);
      const after = await pressSyncNow(s.port);
      expect(after.state).toBe('error');
      expect(after.error).toContain('この PC の hangar');
      expect(metaCalls(w.seen)).toBeGreaterThan(before);
    } finally {
      await s.close();
      await w.close();
    }
  });

  it('一時停止中に今すぐ同期で断られたら理由を出し、もう一度押せばまた試し直す', async () => {
    const floor = COMPAT_VERSION + 1;
    const w = await fakeWorker(() => refuse(floor));
    joinTo(w.url);
    presetPaused();
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      expect(w.seen).toEqual([]);
      const first = await pressSyncNow(s.port);
      expect(first.state).toBe('error');
      expect(first.error).toContain('この PC の hangar');
      // 1 巡の残り（本文と設定の出し入れ）が終わるまで待つ。
      await until(async () => { const v = await syncStatus(s.port); return v.oncePass ? null : v; });
      const before = metaCalls(w.seen);
      const second = await pressSyncNow(s.port);
      expect(second.state).toBe('error');
      expect(metaCalls(w.seen)).toBeGreaterThan(before);
    } finally {
      await s.close();
      await w.close();
    }
  });

  it('Worker が版の見出しを返さない間（版 0）も同期は動き、要求にはこの PC の版を載せる', async () => {
    const w = await fakeWorker((method, p) => {
      if (p === '/rows') return { status: 200, body: { changes: [], nextAfter: null, seq: 0 } };
      if (p === '/changes' && method === 'GET') return { status: 200, body: { changes: [], nextSeq: 0, more: false } };
      if (p === '/changes') return { status: 200, body: { seq: 0, accepted: 0, skipped: 0 } };
      if (p === '/files') return { status: 200, body: { files: [], nextSeq: 0, more: false } };
      if (p.startsWith('/files/') && method === 'PUT') return { status: 201, body: { seq: 1 } };
      if (p === '/usage') return { status: 200, body: { configured: false } };
      return { status: 404, body: { error: 'not found' } };
    });
    joinTo(w.url);
    const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
    try {
      const st = await until(async () => { const v = await syncStatus(s.port); return v.lastPullAt !== null ? v : null; });
      expect(st.error).toBeNull();
      expect(st.state).not.toBe('error');
      expect(w.seen.length).toBeGreaterThan(0);
      for (const r of w.seen) expect(r.compat, `${r.method} ${r.path}`).toBe(String(COMPAT_VERSION));
    } finally {
      await s.close();
      await w.close();
    }
  });
});
```

- [ ] **Step 3: 落ちるのを見る**

Run: `npx vitest run packages/server/src/http/app.test.ts packages/server/src/server.test.ts`
Expected: FAIL（`/health` に `compat` が無く、`syncHalted` も無く、一時停止中の 2 回目の押下は状態が `error` なので一時停止の 1 巡に回らずに何も送らない）。
「断られたら止めて出す」と「版 0 の Worker でも動く」の 2 つは、Task 3 と Task 5 が入っていれば、ここで既に通る（結線を固定するための試験である）。

- [ ] **Step 4: /health に版を載せる**

`packages/server/src/http/app.ts` の shared の import に `COMPAT_VERSION` を足し、`/health` を次に置き換える。

```ts
  // 鍵の要らない経路なので、起動の進み具合は段階と件数だけを載せる。
  // compat は互換の版番号で、殻が 4177 の既存のサーバを採る前に照合する（照合は段 1 の PR 7 で入れる）。
  app.get('/health', (c) => c.json({ ok: true, version: deps.version, compat: COMPAT_VERSION, ready: deps.ready?.() ?? true, index: deps.indexer.progress() }));
```

- [ ] **Step 5: サーバの結線を直す**

`packages/server/src/server.ts` の `configSyncActive` の次に足す。

```ts
/**
 * 本文と設定の出し入れ、他端末の本文の取り込み、使用量の取りに行きを止めるか。
 * 互換の版で止まっているときは、利用者が頼んだ 1 巡の最中でも止める（その 1 巡のメタデータの送受信が先に試し直し、まだ合わなければまた止まっている）。
 * 一時停止のあいだは止めるが、利用者が「今すぐ同期」で頼んだ 1 巡の最中だけは通す（PausedPass）。
 */
export function syncHalted(o: { paused: boolean; oncePass: boolean; compatBlocked: boolean }): boolean {
  return o.compatBlocked || (o.paused && !o.oncePass);
}
```

`startServer` の中の `isPaused` を次に置き換える（上のコメントの 3 行はそのまま残し、1 行足す）。

```ts
  /**
   * 同期が止まっているか。利用者が押した一時停止も、枠の 80% で自分から止まった分もここに出る。
   * 止まっていても、利用者が「今すぐ同期」で頼んだ 1 巡の最中だけは止まっていないと答える（pausedPass）。
   * 互換の版が合わずに止まっているときも止まっていると答える（1 巡の最中でも）。
   * 本文と設定の出し入れはどれもここを見るので、その 1 巡だけ通る。
   */
  const isPaused = (): boolean => syncHalted({ paused: engine.status().state === 'paused', oncePass: pausedPass.active(), compatBlocked: engine.compatBlocked() });
```

`startServer` の中の `syncNow` の 1 行目（`if (engine.status().state !== 'paused') return engine.syncNow();`）を次に置き換える。

```ts
    // 一時停止しているかは、止めた印でも見る。版で止まっている間は、一時停止していても状態が error になるからである。
    // 印で見ないと、一時停止のまま版で止まった後の押下が 1 巡の道に回らず、何も送らない。
    const paused = engine.status().state === 'paused' || (engine.compatBlocked() && engine.state.get('paused') === '1');
    if (!paused) return engine.syncNow();
```

- [ ] **Step 6: 通るのを見る**

Run: `npx vitest run packages/server/src/http/app.test.ts packages/server/src/server.test.ts`
Expected: PASS。

- [ ] **Step 7: サーバの試験全体を見る**

Run: `npx vitest run packages/server`
Expected: PASS。

- [ ] **Step 8: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 9: コミットする**

```bash
git add packages/server/src/server.ts packages/server/src/http/app.ts packages/server/src/http/app.test.ts packages/server/src/server.test.ts
```

```bash
git commit -m "feat(server): report the compat version on /health and halt file sync on a mismatch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: CLI も版を載せ、参加の 426 と status の版を出す

**Files:**
- Modify: `packages/cli/src/cloud.ts`（shared の import、`waitForHealth`、`joinWorker`、`cloudStatus`）
- Modify: `packages/cli/src/cloud.test.ts`（import と、末尾に describe を 1 つ）

**Interfaces:**
- Consumes: Task 1 の `COMPAT_VERSION`、`COMPAT_HEADER`、`compatHeaders`、`parseCompat`、`readCompatRefusal` と、Task 2 の Worker の `/health` の `compat`。
- Produces:
  - `waitForHealth`、`joinWorker`、`cloudStatus` が Worker へ出す要求は、どれも `x-hangar-compat` を載せる（下限が 1 に上がった後も `hangar join` と `hangar setup cloud` の参加が断られない）。
  - `joinWorker` は 426 なら待たずに、この PC の hangar を上げるよう伝えて止める。
  - `hangar cloud status` は `互換の版: この PC <版>、Worker <版>` の 1 行を出す。
    `/health` に `compat` が無い Worker は `0`、届かなければ `不明` と出す。

- [ ] **Step 1: 試験を書く**

`packages/cli/src/cloud.test.ts` の shared の import を直す。

```ts
import { COMPAT_HEADER, COMPAT_VERSION, decodeJoinToken, encodeJoinToken, type FileEntry } from '@agent-hangar/shared';
```

ファイルの末尾に足す。

```ts
describe('互換の版', () => {
  it('Worker へ出す要求（health の待ち、参加、status）に、この PC の版を載せる', async () => {
    const sent: { url: string; compat: string | undefined }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), compat: (init?.headers as Record<string, string> | undefined)?.[COMPAT_HEADER] });
      if (String(input).endsWith('/join')) return new Response(JSON.stringify({ deviceToken: 't', deviceId: device.id }), { status: 201 });
      return new Response(JSON.stringify({ ok: true, version: '0.4.0', compat: COMPAT_VERSION }), { status: 200 });
    }) as typeof fetch;
    expect(await waitForHealth('https://h', { fetch: f, sleep: async () => {} })).toBe(true);
    await joinWorker('https://h', 's', device, { fetch: f, sleep: async () => {} });
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    await cloudStatus({ home, fetch: f });
    const toWorker = sent.filter((s) => s.url.startsWith('https://h/'));
    expect(toWorker.map((s) => s.url)).toEqual(['https://h/health', 'https://h/join', 'https://h/health']);
    for (const s of toWorker) expect(s.compat, s.url).toBe(String(COMPAT_VERSION));
  });

  it('参加を版が古いと断られたら、待たずに hangar を上げるよう伝える', async () => {
    const need = COMPAT_VERSION + 1;
    const f = (async () => new Response(JSON.stringify({ error: 'upgrade required', minCompat: need, compat: need }), { status: 426 })) as typeof fetch;
    const slept: number[] = [];
    const e: Error = await joinWorker('https://h', 's', device, { fetch: f, sleep: async (ms) => { slept.push(ms); }, retryForbidden: true }).then(
      () => { throw new Error('断られるはずが通った'); },
      (x: unknown) => x as Error,
    );
    expect(e.message).toContain('この PC の hangar が古い');
    expect(e.message).toContain(`${need} 以上`);
    expect(slept).toHaveLength(0);
  });

  it('status は、この PC と Worker の互換の版を 1 行で見せる', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    const health = (body: unknown) => (async (input: string | URL | Request) => {
      if (String(input) === 'https://h/health') return new Response(JSON.stringify(body), { status: 200 });
      throw new TypeError('ECONNREFUSED');
    }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: health({ ok: true, version: '0.5.0', compat: COMPAT_VERSION }) })).toContain(`互換の版: この PC ${COMPAT_VERSION}、Worker ${COMPAT_VERSION}`);
    // 版を返さないのは、版番号を入れる前の古い Worker である。
    expect(await cloudStatus({ home, fetch: health({ ok: true, version: '0.4.0' }) })).toContain(`互換の版: この PC ${COMPAT_VERSION}、Worker 0`);
    const dead = (async () => { throw new TypeError('ECONNREFUSED'); }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: dead })).toContain(`互換の版: この PC ${COMPAT_VERSION}、Worker 不明`);
  });
});
```

- [ ] **Step 2: 落ちるのを見る**

Run: `npx vitest run packages/cli/src/cloud.test.ts`
Expected: FAIL（見出しが載っておらず、426 は「参加に失敗しました（HTTP 426）」になり、status に互換の版の行が無い）。

- [ ] **Step 3: 実装する**

`packages/cli/src/cloud.ts` の shared の import を次に置き換える。

```ts
import { COMPAT_VERSION, compatHeaders, configKey, decodeJoinToken, encodeJoinToken, isSafeKeyId, isSafeRelPath, parseCompat, PULL_LIMIT, readCompatRefusal, type FileEntry, type JoinResponse, type SyncStatusDto } from '@agent-hangar/shared';
```

`waitForHealth` の中の fetch を次に置き換える。

```ts
      const r = await o.fetch(`${url}/health`, { headers: compatHeaders(), signal: AbortSignal.timeout(interval) });
```

`joinWorker` の中の fetch を次に置き換える。

```ts
      r = await o.fetch(`${url}/join`, { method: 'POST', headers: { 'content-type': 'application/json', ...compatHeaders() }, body: JSON.stringify({ secret, device }), signal: ac.signal });
```

`joinWorker` の `if (r.status === 201) return (await r.json()) as JoinResponse;` の次に足す。

```ts
    // 版が古くて断られたときは、待っても変わらない。上げる側を伝えて止める。
    // 本文から読むのは下限の数だけで、本文そのものは出さない。
    if (r.status === 426) {
      const need = readCompatRefusal(await r.text().catch(() => ''));
      const want = need === null ? 'それより新しい版' : `${need} 以上`;
      throw new Error(`この PC の hangar が古いので、Worker が参加を断りました（この PC の互換の版は ${COMPAT_VERSION}、Worker が求めるのは ${want}）。hangar を新しい版に入れ替えてから、もう一度実行してください`);
    }
```

`cloudStatus` の Worker の `/health` を読む `try` を次に置き換え、その直後に 1 行足す。

```ts
  // Worker の互換の版。届かなければ null（不明）である。
  let workerCompat: number | null = null;
  try {
    const r = await fetchFn(`${c.url}/health`, { headers: compatHeaders(), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    const j = r.ok ? ((await r.json()) as { ok?: boolean; version?: string; compat?: unknown }) : null;
    // 版を返さない Worker は、版番号を入れる前の古い Worker である（版 0）。
    if (j?.ok) workerCompat = typeof j.compat === 'number' ? parseCompat(String(j.compat)) : 0;
    lines.push(`Worker: ${c.url}（${j?.ok ? `ok, ${j.version ?? '?'}` : `HTTP ${r.status}`}）`);
  } catch (e) {
    lines.push(`Worker: ${c.url}（接続できません: ${e instanceof Error ? e.message : String(e)}）`);
  }
  lines.push(`互換の版: この PC ${COMPAT_VERSION}、Worker ${workerCompat ?? '不明'}`);
```

- [ ] **Step 4: 通るのを見る**

Run: `npx vitest run packages/cli`
Expected: PASS（既存の status の試験の `Worker: https://h（ok, 0.4.0）` の行も変わらない）。

- [ ] **Step 5: 型を見る**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 6: コミットする**

```bash
git add packages/cli/src/cloud.ts packages/cli/src/cloud.test.ts
```

```bash
git commit -m "feat(cli): send the compat version to the Worker and show it in cloud status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 設計書に約束を書き、全体を確かめる

**Files:**
- Modify: `docs/design.md`（「クラウド同期」の節の「### タイミングと競合」の後ろ、「### 他端末セッションのロックと「この PC で再開」」の前に、節を 1 つ足す）

**Interfaces:**
- Consumes: Task 1 から Task 8 で入れた名前と振る舞い。
- Produces: なし（文書と確かめだけ）。

- [ ] **Step 1: 設計書に節を足す**

`docs/design.md` の「### 他端末セッションのロックと「この PC で再開」」の見出しの直前に、次の節を足す。

```markdown
### 互換の版番号

hangar の部品のうち、別々に上がりうるのは、端末どうし（同期で Worker を挟む）、端末と Worker、殻と 4177 で動いている既存のサーバである。
UI とサーバと CLI は同じ束で配るので、版番号を持たない。
別々に上がる部品は、1 つの整数 `COMPAT_VERSION`（`packages/shared/src/compat.ts`、はじめは 1）を名乗り、相手に下限を持つ。
古い版のための分岐を部品ごとに抱える代わりに、下限より古い相手とは話さずに、理由を出して止まる。

**見出し。**
サーバと CLI は、Worker へ出すすべての要求に、見出し `X-Hangar-Compat` で自分の版を載せる。
Worker は、断ったものも含めたすべての応答に、同じ見出しで自分の版を載せる。
見出しの無い相手は、版番号を入れる前の古い版とみなし、版 0 として読む。
整数として読めない値も版 0 として読む。
Worker の `/health` は `{ ok, version, compat }` を返し、サーバの `/health` も `compat` を返す。

**Worker の下限。**
Worker は、端末に求める下限 `MIN_DEVICE_COMPAT`（`packages/cloud/src/compat.ts`）を持つ。
下限より古い端末の要求には、スキーマの用意にも認証にも進まずに、426 と `{ error: 'upgrade required', minCompat, compat }` を返す。
`/health` だけは版を問わずに通す。
版を確かめに来る口だからである。
いまの下限は 0 で、見出しの無い端末も通す。

**端末の下限。**
サーバは、Worker に求める下限 `MIN_WORKER_COMPAT`（`packages/server/src/sync/client.ts`）を持つ。
いまの下限は 0 で、見出しを返さない Worker とも話す。
Worker から 426 が返るか、応答の見出しの版が下限より古ければ、`HttpCloudClient` は `CompatError` を投げる。
`SyncEngine` はそれを受けたら同期を止め、状態を `error` にして、どちらを上げればよいかを `error` の文に書く。
426 なら「この PC の hangar を新しい版に入れ替える」、Worker が古ければ「setup した PC で `hangar setup cloud` をもう一度実行して Worker を入れ替え、今すぐ同期を押す」である。
止めている間は、メタデータの送受信も、本文と設定の出し入れも、使用量の取りに行きも外へ出ない（`server.ts` の `syncHalted`）。
一時停止していても、版で止まったことを先に見せる。
直す道が `error` の文にしか無いからである。
止めた印は `sync_state` に残さない。
この PC の hangar を入れ替えれば立て直しで消え、Worker を入れ替えたなら、利用者が押した「今すぐ同期」が 1 回だけ試し直して戻る。
本文の上げ下ろしは、426 を直りようのない失敗として諦めない。
どちらかを上げれば通るからである。
`hangar join` と `hangar setup cloud` の参加も版を載せ、426 なら hangar を上げるよう伝えて止める。
`hangar cloud status` は、この PC と Worker の版を 1 行で出す。

**いつ上げるか。**
`COMPAT_VERSION` を上げるのは、次のどれかを、古い相手と話せない形で変えるときだけである。

- 同期の形（共有テーブルの行の運び方、変更ログ、ファイルの鍵と暗号の形式）。
- Worker の API（経路、要求と応答の形、見出し）。
- 殻とサーバの合図（`/health` の形、起動と停止のやりとり）。

項目を足すだけで古い相手も読める変更では上げない。
版を上げても、下限を上げなければ、相手は断られない。
下限を上げるのは、相手がすべて版番号を持つ版に上がってからである。
Worker の `MIN_DEVICE_COMPAT` は、同期に参加しているすべての端末が上がってから上げ、Worker を配備し直す。

殻が 4177 の既存のサーバを採る前に、その `/health` の版を自分が同梱するサーバの版と比べる照合は、まだ入れていない（段 1 の PR 7）。
```

- [ ] **Step 2: 設計書の書き方を確かめる**

足した節だけを取り出し、中黒（U+30FB）と em ダッシュ（U+2014）が無いことを見る。
見出しが見つからないと黙って 0 になるので、先に節があることを確かめる。

Run: `grep -n '^### 互換の版番号' docs/design.md`
Expected: 1 行だけ出る。

Run: `perl -CSD -Mutf8 -ne 'BEGIN { $a = chr(0x30FB); $b = chr(0x2014) } $in = 1 if /^### 互換の版番号/; $in = 0 if /^### 他端末セッションのロック/; $n++ if $in && /$a|$b/; END { print $n + 0, "\n" }' docs/design.md`
Expected: `0`。

- [ ] **Step 3: 型を通す**

Run: `npm run typecheck`
Expected: エラーなし。

- [ ] **Step 4: 試験を全部通す**

Run: `npm test`
Expected: すべて PASS。

- [ ] **Step 5: UI とパッケージをビルドする**

Run: `npm run build`
Expected: 成功する。

- [ ] **Step 6: 同梱のサーバを束ねる**

Run: `npm run bundle-server -w apps/desktop`
Expected: 成功する。

- [ ] **Step 7: デスクトップのアプリをビルドする**

Homebrew の cargo を PATH の先頭に置いて打つ（rustup の古い cargo だと落ちる）。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`
Expected: 成功し、.app ができる。

- [ ] **Step 8: コミットする**

```bash
git add docs/design.md
```

```bash
git commit -m "docs(design): describe the compat version contract for cloud sync" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: 報告に書くことをまとめる**

Worker は配備していないので、実物の Worker はまだ版の見出しを返さない（版 0）。
いまの下限はどちらも 0 なので、配備するまでも同期は動く（Task 3、Task 5、Task 7 の試験で確かめた）。
報告には、入れたもの、確かめたこと（型、試験、3 つのビルド）、確かめていないこと（実物のクラウドでの往復は未確認、Worker の配備は PR 6 で利用者に聞いてから）を分けて書く。
