# アカウントの切り替え 2：画面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計画 1 で入ったサーバの口を画面に結び、ヘッダでアカウントを切り替え、新規セッションのダイアログで選び、セッション画面で見て切り替え、設定で追加・変更・削除・ログインができるようにする。

**Architecture:** アカウントの一覧（`AccountsDto`）は Store に 1 つ持ち、bootstrap と `accounts.update` で入れ替える。画面に出す形（名前、色、プラン、メール、計器、注記）は `presenters/accounts.ts` の 1 か所で作り、ヘッダ・ダイアログ・設定が使い回す。操作は shared の Intent → Mediator の新しい領域 `accounts` → Effect → `runtime.ts` → `api.ts` の、既存の道どおりに通す。セッションの切り替えは、既存の確認の overlay（`confirm`）に 1 種足し、結果は起動と同じ道（`launch.done`・`launch.failed`）で戻す。

**Tech Stack:** TypeScript、React、vitest 5、@testing-library/react（views は jsdom）、Hono（サーバの小さな追加）。

**Spec:** `docs/superpowers/specs/2026-10-06-account-switch-design.md`（「決定」の節と、末尾の「画面の計画へ送るもの」）。見た目の原本は同じ階層の `2026-10-06-account-switch/`：ヘッダと開いた先は `model5.html`（流れ）と `model4.html` の「3. 開いた先」、ダイアログの札は `model3.html` の N4 と N3、セッション画面の札は `model.html` の C、設定は `model.html` の F。

## Global Constraints

- 文言は日本語。画面の語は試作と設計書のとおり：「いまのアカウント」「切り替える」「アカウントを追加」「アカウントの設定」「まもなく上限。HH:MM に戻ります」「N 時間前の値」。
- **アカウントが 1 つだけのとき、画面は今までと 1 ピクセルも変わらない。** ヘッダに色の点も名前も出さず、ダイアログに段を出さず、セッション画面に札を出さない。アカウントの節があるのは設定だけ。
- 頭文字の四角い印は作らない。目印は名前の文字と、8px の色の点だけ。
- セッションの一覧（Sessions、ホーム、プロジェクト画面の行）には、アカウントの印を出さない。
- 色はサーバから `#rrggbb` の文字で届く。点は既存の `.st-dot`（`background: currentColor`）と同じ形で、`style={{ color }}` で渡す。色のトークンを増やさない。
- ダークモードを足さない（`prefers-color-scheme`、`data-theme` を書かない）。
- `font-weight` は 400・500・600・700 だけ。`transition`・`animation` の長さはトークン（`--dur-fast` など）だけ。`backdrop-filter` を新しい選択子に書かない（開く面は既存の `.menu-pop` の class を使う）。
- View は lucide を直に import しない（`views/primitives/Icon.tsx` を通す）。View は `fetch` しない（Intent を出すだけ）。
- 上限に当たったときに自動で切り替える画面も、切り替えを勧めて選択を動かす画面も作らない。注記は出すが、選ぶのは利用者。
- hangar はトークンを扱わない。ログインは `POST /api/accounts/:id/login` を叩くだけ。
- `LaunchPrefs`（プロジェクトごとの前回値）に `account` を足さない。
- 試験は実物のサーバ、実物の `claude`、実物の `~/.claude`・`~/.claude-univ`・`~/.agent-hangar` に触らない。メールアドレスは `taro@example.co.jp` と `taro@example.ac.jp` だけ。プロジェクトやセッションの名前は agent-hangar のもの（「アカウントの切り替え」「索引の見直し」など）だけを使い、費用は仮の数字にする。
- コミットは `git commit <path>...` のパス指定形で行い、`--amend` と rebase は使わない。
- 各タスクの終わりに `npx vitest run packages/ui packages/shared packages/server` と `npm run typecheck` が通ること。

## Review Focus

1. **古いサーバ、またはアカウントを知らないサーバにつながった**（bootstrap に `accounts` が無い） → 画面は今までどおり。ヘッダの計器は `store.usage` を出す。落ちない。Task 2 と Task 3 で試験を足す。
2. **アカウントが消えた・一覧に無い id を指している**（`sessions` の対応、いまの id、ダイアログで選んだ id） → 最初のアカウントとして扱い、選択は最初の（またはいまの）アカウントへ戻す。Task 2 と Task 5 で試験を足す。
3. **切り替えを断られた**（本文が無い、バックグラウンド、外で実行中、リンクが壊れている） → サーバの文をそのままトーストに出し、画面は元のセッションのまま、送信中の印が残らない。Task 4 で試験を足す。
4. **認証がまだ読めていない**（`auth` が null）と**未ログイン**（`loggedIn` が false） → 前者はメールとプランを空のまま出し、読めたら埋まる。後者は「未ログイン」と出し、ダイアログの札は選べない（起動しても動かないため）。Task 2・Task 5・Task 6 で試験を足す。
5. **使用量がまだ 1 度も届いていないアカウント**（3 つとも null） → 計器は出さず「まだ値がありません」と書く。注記（まもなく上限、N 時間前）は出さない。Task 2 で試験を足す。

---

### Task 1: サーバの小さな追加（ログインの戻り値と中止、id を shared へ）

**Files:**
- Modify: `packages/shared/src/api.ts`（`AccountsDto` の後ろ）
- Modify: `packages/server/src/config/accounts.ts`（`PRIMARY_ACCOUNT_ID` を shared から取り直して再 export）
- Modify: `packages/server/src/config/accountAuth.ts`（`login` の戻り値、`cancelLogin`、`RunClaude` に中止の口）
- Modify: `packages/server/src/http/accounts.ts`（login の応答、cancel の口、login のリンクの try）
- Modify: `packages/server/src/usage/statusline.ts`、`packages/server/src/db/queries.ts`、`packages/server/src/server.ts`、`packages/server/src/http/app.ts`（`'primary'` の直書きを定数へ）
- Test: `packages/server/src/config/accountAuth.test.ts`、`packages/server/src/http/accounts.test.ts`

**Interfaces:**
- Produces（shared）: `export const PRIMARY_ACCOUNT_ID = 'primary';`
- Produces（server）:
  - `AccountAuth.login(account): 'started' | 'running' | 'no-claude'`（今の boolean を置き換える）
  - `AccountAuth.cancelLogin(id: string): boolean`（走っていれば止めて true。止めたら `loginRunning` は偽になり、`onChange` が呼ばれ、認証は読み直さない）
  - `RunClaude` の第 5 引数に任意の `signal?: AbortSignal`。`realRun` は `execFile` の `signal` に渡す。中止で終わったときは reject でよい（`login` の鎖が握る）。
  - `POST /api/accounts/:id/login`：始められたら 202 と `AccountsDto`。もう走っていれば 409 `{ error: 'このアカウントのログインは、もう始まっています。ブラウザで承認してください' }`。claude が無ければ 400 `{ error: 'claude が見つかりません。設定の「claude のパス」を入れてください' }`。リンクを張る所で投げたら、その文を 400 で返す。
  - `POST /api/accounts/:id/login/cancel` → 200 と `AccountsDto`（走っていなくても 200）。

- [ ] **Step 1: 失敗する試験を書く**

`accountAuth.test.ts` に足す（既存の `login` の試験の、戻り値を見ている所は `'started'`・`'running'` に直す）：

```ts
  it('login は、claude が無ければ no-claude、走っていれば running を返す', () => {
    const none = new AccountAuth({ claudeBin: () => null, run: vi.fn() });
    expect(none.login(univ)).toBe('no-claude');
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: () => new Promise(() => {}) });
    expect(auth.login(univ)).toBe('started');
    expect(auth.login(univ)).toBe('running');
  });

  it('cancelLogin は走っているログインを止め、認証は読み直さない', async () => {
    const calls: string[][] = [];
    let aborted = false;
    const run: RunClaude = (_bin, args, _env, _ms, signal) => {
      calls.push(args);
      return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); });
    };
    const onChange = vi.fn();
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, onChange });
    auth.login(univ);
    expect(auth.cancelLogin('a1')).toBe(true);
    await vi.waitFor(() => expect(auth.loginRunning('a1')).toBe(false));
    expect(aborted).toBe(true);
    expect(calls).toEqual([['auth', 'login']]);
    expect(onChange).toHaveBeenCalled();
    expect(auth.cancelLogin('a1')).toBe(false);
  });
```

`http/accounts.test.ts` に足す：

```ts
  it('login は、もう走っていれば 409、claude が無ければ 400 で理由を返す', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    expect((await call('POST', `/accounts/${id}/login`)).status).toBe(202);
    // 既存の組み立ての run は login をすぐ終える。走り続ける run に差し替えた deps で 409 を確かめる（下の補助を使う）。
  });
```

この試験ファイルの `beforeEach` は `run` が login をすぐ終える。409 と 400 は、`AccountAuth` を `run: () => new Promise(() => {})`（終わらない）と `claudeBin: () => null` で作った別の `app` を、その試験の中で組んで確かめる（`accountsRoutes(new Hono(), { ...deps, auth })`。`deps` を `beforeEach` の外から参照できるよう、ファイルの変数に持ち上げる）。確かめること：1 回目 202、2 回目 409 で文に「もう始まっています」、cancel が 200 で、その後の `GET /accounts` の `loginRunning` が偽、claude 無しは 400 で文に「claude が見つかりません」。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/accountAuth.test.ts packages/server/src/http/accounts.test.ts 2>&1 | tail -8`
Expected: 新しい試験が FAIL。

- [ ] **Step 3: 実装する**

- shared：`packages/shared/src/api.ts` の `AccountsDto` の定義の後ろに `/** 最初のアカウント（既定の置き場）の id。 */ export const PRIMARY_ACCOUNT_ID = 'primary';` を足す。`packages/server/src/config/accounts.ts` は自分の定義を消し、`import { PRIMARY_ACCOUNT_ID } from '@agent-hangar/shared'; export { PRIMARY_ACCOUNT_ID };` にする（ほかのファイルの import を変えずに済ませる）。
- `'primary'` の直書き（`usage/statusline.ts` の `PRIMARY`、`db/queries.ts` の `sessionAccounts`、`server.ts` の `accountOf`、`http/app.ts` の statusline の分岐）を、shared の定数に置き換える。SQL の文字列の中の `'primary'`（`coalesce(account, 'primary')`）は、値を束縛の引数にするか、定数を埋めた文字列にする。
- `AccountAuth`：ログインごとに `AbortController` を持つ `Map<string, AbortController>` に変える（今の `logins: Set` を置き換える）。`login` は 3 つの文字を返す。`cancelLogin` は `abort()` して、Map から消し、`notify()` する。`login` の鎖の後始末は「Map にまだ自分の controller が居るときだけ」消して `refresh` する（中止されたものは読み直さない）。
- HTTP：`login` の口を上の表のとおりに。`ensureAccountLinks` は try で包む。cancel の口を足す。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server packages/shared 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS、型検査はエラーなし。

- [ ] **Step 5: コミット**

```bash
git commit packages/shared/src/api.ts packages/server/src -m "feat(server): say why a login did not start, let it be cancelled, and share the primary account id"
```

---

### Task 2: 画面の土台（Store、API、Intent、Mediator、presenter）

**Files:**
- Modify: `packages/shared/src/intent.ts`（Intent に 9 種）
- Modify: `packages/ui/src/store/store.ts`（`Store.accounts`、bootstrap、`accounts.update`、引く関数）
- Modify: `packages/ui/src/mediator/types.ts`（Effect、`ConfirmRequest`）
- Create: `packages/ui/src/mediator/accounts.ts`
- Modify: `packages/ui/src/mediator/transition.ts`（領域の並び）
- Modify: `packages/ui/src/runtime/api.ts`、`packages/ui/src/runtime/runtime.ts`、`packages/ui/src/test/fakeApi.ts`
- Create: `packages/ui/src/presenters/accounts.ts`
- Test: `packages/ui/src/store/store.test.ts`、`packages/ui/src/mediator/transition.test.ts`、`packages/ui/src/runtime/api.test.ts`、`packages/ui/src/runtime/runtime.test.ts`、`packages/ui/src/presenters/accounts.test.ts`（新規）

既存の道の手本（必ず読む）：`usage.update` が Store に入る所（`store.ts` の `applyServerEvent`）、設定の保存（`mediator/settings.ts` と `runtime.ts` の `api.updateSettings`）、起動の結果の戻し方（`runtime.ts` の `launched`・`launchFailed`、`mediator/launch.ts` の `session.adopt`）。

**Interfaces:**
- Produces（shared の Intent。`packages/shared/src/intent.ts` の `Intent` に足す）:

```ts
  | { type: 'accounts.load' }
  | { type: 'account.choose'; accountId: string }
  | { type: 'account.switchSession'; sessionId: string; accountId: string; working: boolean; confirmed?: boolean }
  | { type: 'account.add'; name: string }
  | { type: 'account.update'; accountId: string; name?: string; color?: string }
  | { type: 'account.remove'; accountId: string; confirmed?: boolean }
  | { type: 'account.login'; accountId: string }
  | { type: 'account.login.cancel'; accountId: string }
  | { type: 'account.refresh'; accountId: string }
```

- Produces（Store）:
  - `Store.accounts: AccountsDto | null`（初期値は null。bootstrap は `b.accounts ?? null`、`accounts.update` は丸ごと入れ替え）
  - `accountList(store: Store): AccountDto[]`（null なら空の配列）
  - `currentAccount(store: Store): AccountDto | null`（`currentId` の指す 1 件。無ければ primary の 1 件。一覧が空なら null）
  - `accountOfSession(store: Store, sessionId: string): AccountDto | null`（`sessions[sessionId]` の指す 1 件。対応に無い、または一覧に無い id なら primary の 1 件。一覧が空なら null）
  - `hasMultipleAccounts(store: Store): boolean`（2 件以上）
- Produces（Effect。`mediator/types.ts`）:
  - `{ kind: 'api.accounts.load' }`
  - `{ kind: 'api.accounts.setCurrent'; accountId: string }`
  - `{ kind: 'api.accounts.switchSession'; sessionId: string; accountId: string }`
  - `{ kind: 'api.accounts.add'; name: string }`
  - `{ kind: 'api.accounts.update'; accountId: string; patch: { name?: string; color?: string } }`
  - `{ kind: 'api.accounts.remove'; accountId: string }`
  - `{ kind: 'api.accounts.login'; accountId: string }`
  - `{ kind: 'api.accounts.cancelLogin'; accountId: string }`
  - `{ kind: 'api.accounts.refresh'; accountId: string }`
- Produces（`ConfirmRequest` に 2 種）:
  - `{ kind: 'switchAccount'; sessionId: string; accountId: string; working: boolean }`
  - `{ kind: 'removeAccount'; accountId: string }`
- Produces（`ApiClient`）:
  - `accounts(): Promise<AccountsDto>`（`GET /api/accounts`）
  - `setCurrentAccount(id): Promise<AccountsDto>`（`PUT /api/accounts/current`、本文 `{ id }`）
  - `switchAccount(sessionId, accountId): Promise<LaunchResultDto>`（`POST /api/sessions/:id/switch-account`、本文 `{ account }`）
  - `addAccount(name): Promise<AccountsDto>`（`POST /api/accounts`、本文 `{ name }`）
  - `updateAccount(id, patch): Promise<AccountsDto>`（`PATCH /api/accounts/:id`）
  - `removeAccount(id): Promise<AccountsDto>`（`DELETE /api/accounts/:id`）
  - `loginAccount(id): Promise<void>`（`POST /api/accounts/:id/login`。202 は本文を捨てる既存の作りのまま）
  - `cancelAccountLogin(id): Promise<AccountsDto>`（`POST /api/accounts/:id/login/cancel`）
  - `refreshAccount(id): Promise<AccountsDto>`（`POST /api/accounts/:id/refresh`）
- Produces（presenter。`packages/ui/src/presenters/accounts.ts`）:

```ts
export type AccountGauge = { percent: number; high: boolean; resets: string | null };
export type AccountView = {
  id: string; name: string; color: string; primary: boolean; current: boolean;
  /** プランの表示。Max、Pro、Team、Enterprise。知らない値はそのまま、認証が未読なら null。 */
  plan: string | null;
  email: string | null;
  /** 未読は 'unknown'、未ログインは 'out'、ログイン済みは 'in'、ログインの途中は 'running'。 */
  auth: 'unknown' | 'out' | 'in' | 'running';
  fiveHour: AccountGauge | null; sevenDay: AccountGauge | null;
  /** 値の時刻の文（「3 分前」）。1 度も届いていなければ null。 */
  updatedLabel: string | null;
  /** 札に添える一言。上限が近い、値が古い、のどちらか 1 つ（上限が近いほうを優先）。無ければ null。 */
  note: { tone: 'warn' | 'stale'; text: string } | null;
  linkProblem: string | null;
  dir: string;
};
export function presentAccount(a: AccountDto, currentId: string, now: number): AccountView;
export function presentAccounts(store: Store, now: number): AccountView[];
```

- 規則（presenter）:
  - `plan`：`max` → `Max`、`pro` → `Pro`、`team` → `Team`、`enterprise` → `Enterprise`。ほかの文字はそのまま。
  - `high`：使用率が 80 以上。既存の計器（`UsageGauge` の `pct >= 80`）と同じ線。
  - `resets`：既存の `resetsLabel(ts, now)`（`presenters/format.ts`）。
  - `updatedLabel`：既存の `relativeTime(updatedAt, now)`。
  - `note`：5 時間の使用率が 80 以上なら `{ tone: 'warn', text: 'まもなく上限。<resets> に戻ります' }`（`resets` が null なら `'まもなく上限'`）。そうでなく、`updatedAt` が 1 時間より古ければ `{ tone: 'stale', text: 'N 時間前の値' }`（N は切り捨て。24 時間以上は「N 日前の値」）。値が 1 度も無ければ null。
  - `auth`：`loginRunning` が真なら `'running'`、`auth` が null なら `'unknown'`、`loggedIn` が偽なら `'out'`、ほかは `'in'`。

- Mediator の規則（`mediator/accounts.ts` の `accountsStep(state, input): Step | null`。Mediator は Store を見ないので、判断に要る値は Intent が運ぶ）:
  - `accounts.load` → `api.accounts.load`
  - `account.choose` → `api.accounts.setCurrent`
  - `account.switchSession`：`confirmed` が無ければ overlay を `{ kind: 'confirm', confirm: { kind: 'switchAccount', sessionId, accountId, working } }` にして止める。`confirmed` があり、`state.launch.kind` が `submitting` でなければ、overlay を閉じ、`launch: { kind: 'submitting' }` にして `api.accounts.switchSession` を出す（手本は `launch.ts` の `session.adopt`）。
  - `account.add` → 名前の前後の空白を落とし、空なら何もしない。そうでなければ `api.accounts.add`
  - `account.update` → `api.accounts.update`
  - `account.remove`：`confirmed` が無ければ確認（`removeAccount`）、あれば overlay を閉じて `api.accounts.remove`
  - `account.login` → `api.accounts.login`、`account.login.cancel` → `api.accounts.cancelLogin`、`account.refresh` → `api.accounts.refresh`
  - 並び：`transition.ts` の領域の並びで、`overlayStep` より前に置く（確認を出す領域なので）。

- Runtime の規則:
  - `AccountsDto` を返す呼び出しの結果は、サーバのイベントの道に載せる：`dispatch({ kind: 'server', event: { type: 'accounts.update', accounts } })`（手本は `syncStatus`）。失敗は既存の `fail(e)`（トースト）。
  - `api.accounts.switchSession` は `api.switchAccount(...).then(launched).catch(launchFailed)`。
  - `api.accounts.add` は、成功したら続けてそのアカウントの `loginAccount` を呼ぶ（追加の直後にログインを始める、設計書の流れ）。新しいアカウントの id は、応答の `accounts` の末尾の 1 件のもの。
  - `api.accounts.login` の失敗（409、400）は、サーバの文をそのままトーストに出す（既存の `fail`）。

- [ ] **Step 1: Store の失敗する試験を書く**（`store.test.ts`）

確かめること（それぞれ `it` を 1 つ）：
1. bootstrap に `accounts` が無ければ `store.accounts` は null、あれば入る。
2. `accounts.update` で丸ごと入れ替わる。ほかの項目（`usage` など）は変わらない。
3. `currentAccount`：`currentId` の指す 1 件。`currentId` が一覧に無ければ primary。一覧が空（null）なら null。
4. `accountOfSession`：対応にあればその 1 件、無ければ primary、対応の id が一覧に無ければ primary。
5. `hasMultipleAccounts`：null と 1 件は偽、2 件は真。

固定データは、このファイルの既存の `boot` に `accounts` を足したものを作る。アカウントは 2 件：`{ id: 'primary', name: '会社', dir: '/h/.claude', color: '#2a57b8', primary: true, auth: { loggedIn: true, email: 'taro@example.co.jp', plan: 'max', orgName: null, checkedAt: 1 }, usage: { fiveHour: { usedPercent: 82, resetsAt: 1000 }, sevenDay: { usedPercent: 41, resetsAt: 2000 }, updatedAt: 500 }, loginRunning: false, linkProblem: null }` と、`id: 'a1'`・`name: '大学'`・`color: '#7a4a9e'`・`primary: false`・`plan: 'enterprise'`・`email: 'taro@example.ac.jp'`・使用率 12 と 9 のもの。`currentId: 'primary'`、`sessions: { s9: 'a1' }`。同じ固定データを `packages/ui/src/test/accounts.ts`（新規）に `export const accountsFixture: AccountsDto` として置き、以後の試験で使い回す。

- [ ] **Step 2: 落ちることを確かめ、Store を実装し、通す**

Run: `npx vitest run packages/ui/src/store/store.test.ts 2>&1 | tail -6`

- [ ] **Step 3: presenter の失敗する試験を書く**（`presenters/accounts.test.ts`）

`now` を固定し、次を 1 件ずつ：
1. プランの表示（`max` → `Max`、`enterprise` → `Enterprise`、知らない `edu` はそのまま、認証が null なら null）。
2. `auth` の 4 通り（null、`loggedIn: false`、`loggedIn: true`、`loginRunning: true` が最優先）。
3. 計器：82% は `high: true`、41% は偽。`resets` は `resetsLabel` の文。値が無い窓は null。
4. `note`：5 時間が 80 以上なら warn で「まもなく上限。… に戻ります」、戻る時刻が無ければ「まもなく上限」。
5. `note`：5 時間が 79 で、値が 3 時間 10 分前なら stale で「3 時間前の値」。59 分前なら null。26 時間前は「1 日前の値」。
6. `note`：5 時間が 85 で値も古いときは warn（上限が近いほうを優先）。
7. 値が 1 度も無い（3 つとも null）なら、計器は 2 つとも null、`updatedLabel` は null、`note` は null。
8. `current`：`currentId` と一致する 1 件だけ真。`presentAccounts(store, now)` は、`store.accounts` が null なら空の配列。

- [ ] **Step 4: 落ちることを確かめ、presenter を実装し、通す**

Run: `npx vitest run packages/ui/src/presenters/accounts.test.ts 2>&1 | tail -6`

- [ ] **Step 5: API クライアントの失敗する試験を書き、実装する**（`runtime/api.test.ts`、`runtime/api.ts`、`test/fakeApi.ts`）

9 つの呼び出しそれぞれについて、経路・メソッド・本文を確かめる（このファイルの既存の `harness(status, body)` の流儀）。`fakeApi.ts` の型と偽物にも 9 つを足す（既定は `accountsFixture` を返し、`switchAccount` は起動の結果の偽物、`loginAccount` は `undefined`）。

- [ ] **Step 6: Mediator の失敗する試験を書き、実装する**（`mediator/transition.test.ts`、`mediator/accounts.ts`、`mediator/types.ts`、`mediator/transition.ts`）

確かめること：
1. `accounts.load`・`account.choose`・`account.update`・`account.login`・`account.login.cancel`・`account.refresh` が、それぞれの Effect を 1 つ出す。
2. `account.add`：名前の空白を落とす。空白だけなら何も出さない。
3. `account.switchSession`：`confirmed` 無しは overlay が confirm（`working` を運ぶ）で、Effect は無い。`confirmed` ありは overlay が閉じ、`launch` が submitting、Effect が 1 つ。
4. 送信中（`launch.kind === 'submitting'`）の `account.switchSession`（confirmed）は何もしない。
5. `account.remove`：`confirmed` 無しは確認、ありは Effect。
6. 切り替えの結果：`launch.done` で画面はそのセッションへ（既存の動き）、`launch.failed` でトーストが出て `launch` が failed になる（既存の動きが、確認の overlay が閉じた後でも成り立つこと）。

- [ ] **Step 7: Runtime の失敗する試験を書き、実装する**（`runtime/runtime.test.ts`、`runtime/runtime.ts`）

確かめること（このファイルの `harness` を使う）：
1. bootstrap の `accounts` が Store に入る。
2. `account.choose` → `setCurrentAccount` が呼ばれ、応答の `AccountsDto` が Store に入る。
3. `account.add` → `addAccount` のあと、応答の末尾のアカウントの id で `loginAccount` が呼ばれる。
4. `account.switchSession`（confirmed）→ `switchAccount` が呼ばれ、成功で `launch.done` の道（Store に run が入り、画面がそのセッション）、失敗でトーストにサーバの文が出て、`rt.getState().launch.kind` が `submitting` のまま残らない。
5. `account.login` が 409 で失敗したら、その文がトーストに出る。
6. `accounts.update` のイベントで Store が入れ替わる。

- [ ] **Step 8: 全体を確かめる**

Run: `npx vitest run packages/ui packages/shared packages/server 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS、型検査はエラーなし。

- [ ] **Step 9: コミット**

```bash
git add packages/ui/src/mediator/accounts.ts packages/ui/src/presenters/accounts.ts packages/ui/src/presenters/accounts.test.ts packages/ui/src/test/accounts.ts
git commit packages/shared/src/intent.ts packages/ui/src -m "feat(ui): carry accounts from the server into the store and send account actions back"
```

---

### Task 3: ヘッダの切り替え

**Files:**
- Create: `packages/ui/src/views/AccountSwitcher.tsx`、`packages/ui/src/views/AccountSwitcher.test.tsx`
- Create: `packages/ui/src/views/primitives/AccountMeters.tsx`（色の点・名前・プラン・メール・計器 2 本を描く、開いた先とダイアログの札で使い回す部品）とその試験
- Modify: `packages/ui/src/presenters/shell.ts`（`ShellProps` に `account`）
- Modify: `packages/ui/src/views/Header.tsx`、`packages/ui/src/views/Shell.tsx`
- Modify: `packages/ui/src/views/headerFold.ts`、`packages/ui/src/views/headerFold.test.tsx`
- Modify: `packages/ui/src/styles/base.css`（ヘッダの中）と `packages/ui/src/styles/controls.css`（開いた先）
- Test: `packages/ui/src/presenters/presenters.test.ts`、固定データ（`Shell.test.tsx`、`headerFold.test.tsx`、`workbench.test.tsx`、`misc.test.tsx`）

見た目の原本：`docs/superpowers/specs/2026-10-06-account-switch/model5.html`（1 の流れ）と `model4.html`（「3. 開いた先」）。

**Interfaces:**
- Consumes: `AccountView`、`presentAccounts`、`currentAccount`、`accountOfSession`、`hasMultipleAccounts`（Task 2）
- Produces:
  - `HeaderAccountProps = { shown: AccountView; list: AccountView[]; sessionId: string | null; working: boolean } | null`（アカウントが 1 件以下なら null）
  - `ShellProps.account: HeaderAccountProps`
  - `AccountSwitcher(props: { account: NonNullable<HeaderAccountProps>; children: ReactNode })`（`children` は計器。全体が 1 つのボタンになる）
  - `AccountMeters(props: { account: AccountView; showResets: boolean })`

- 規則:
  - `shown`：画面がセッション（`state.screen` がセッションで、id がある）なら、そのセッションのアカウント。ほかは、いまのアカウント。
  - ヘッダの計器（`UsageProps`）：アカウントが 2 件以上なら `shown` の使用量から作る。1 件以下、または `store.accounts` が null なら、今までどおり `store.usage` から作る。
  - `sessionId`：セッション画面ならその id、ほかは null。`working`：そのセッションが動いていて作業中（`live` の状態が busy）なら真。判定は既存の `session.kill` の `working` の作り方（`SessionScreen.tsx` が `session.kill` に付ける値）と同じ出どころを使う。
  - ヘッダの中：計器の前に、色の点と名前（`.gauge-key` と同じ大きさの字、600）。計器の後ろに小さな「▾」。点・名前・計器・▾ の全体が 1 つの `<button>`（`aria-haspopup="dialog"`、`aria-expanded`、名前は `アカウントを切り替える（いまは <名前>）`）。
  - 開いた先：`document.body` への portal、位置は既存の `place()`（`views/primitives/listboxModel.ts`）、面の class は `menu-pop account-pop`。幅 380px。Esc と外側の押下で閉じ、閉じたらボタンへフォーカスを戻す。開いたときに `accounts.load` を 1 回出す（認証を読ませる）。
  - 開いた先の中身：アカウントごとに 1 枚の札（`role="menuitemradio"`、`aria-checked` は `shown` と同じ id のもの）。札の中は `AccountMeters`（戻る時刻つき）。右上に、`shown` の札は「いまのアカウント」（セッション画面では「このセッション」）、ほかは「切り替える」。未ログインの札は押せず、「未ログイン」と出す。下端に「アカウントの設定」（設定の画面のアカウントの節へ移る既存の Intent。設定へ移る Intent は `SyncStatus.tsx` のリンクが使っているもの）。
  - 札を押したとき：`sessionId` が null なら `account.choose`。あれば `account.switchSession`（`working` を添える）。どちらも押したら閉じる。`shown` の札を押しても何も出さず、閉じるだけ。
  - 畳む順：名前を畳む段 `account-name` を `FOLD_STEPS` に足す。「最終更新」の次、計器の棒より前に畳む。畳んでも色の点は残る。`headerFold.test.tsx` の `FOLD_LEVELS`・`ORDER`・`KEPT`・`level <=` の 4 か所を合わせる。アカウントが 1 件以下のときは段が実体を持たないので、既存の畳み方が変わらないこと（既存の試験が通ること）。
  - `AccountMeters`：1 行目に色の点・名前（700）・プランの札（灰の小さな札）、2 行目にメール（等幅、`--ink-3`）。その下に「5 時間」「週」の 2 本（`UsageGauge` と同じ棒。右に `%`、`showResets` のとき「HH:MM に戻る」）。値が無ければ「まだ値がありません」。`note` があれば最後に 1 行（warn は `--st-paused` の 600、stale は `--ink-3`）。`auth` が `out` なら、メールの代わりに「未ログイン」。`unknown` なら空のまま。`running` なら「ブラウザで承認してください…」。

- [ ] **Step 1: presenter の失敗する試験を書く**（`presenters.test.ts`）

1. アカウントが 1 件、または `store.accounts` が null → `account` は null、`usage` は `store.usage` から。
2. 2 件・ホーム → `shown` はいまのアカウント、`usage` はその値、`sessionId` は null。
3. 2 件・セッション画面（対応が `a1`）→ `shown` は大学、`usage` は大学の値、`sessionId` はその id。
4. 2 件・セッション画面（対応に無い）→ `shown` は primary。
5. `working`：そのセッションが作業中なら真。

- [ ] **Step 2: 落ちることを確かめ、presenter を実装する**

- [ ] **Step 3: `AccountMeters` の試験を書き、実装する**

見ること：名前・プラン・メールが出る、82% の棒が警告の印（`data-high`）を持つ、`showResets` で戻る時刻が出る、値が無いと「まだ値がありません」、`note` の文と tone、`out` で「未ログイン」、`running` で「ブラウザで承認してください…」。

- [ ] **Step 4: `AccountSwitcher` の試験を書き、実装する**（`IntentRoot` で包み `onIntent` を見る。手本は `views/dialogs.test.tsx`）

1. ボタンに色の点と名前が出る。押すと開き、`accounts.load` が 1 回出る。
2. ホーム（`sessionId` null）で「大学」を押すと `account.choose { accountId: 'a1' }` が出て閉じる。
3. セッション画面で「会社」を押すと `account.switchSession { sessionId, accountId: 'primary', working }` が出る。
4. いまの札を押しても Intent は出ず、閉じる。
5. 未ログインの札は `aria-disabled` で、押しても何も出ない。
6. Esc で閉じ、ボタンにフォーカスが戻る。
7. 「アカウントの設定」で設定へ移る Intent が出る。

- [ ] **Step 5: ヘッダに組み込み、畳み方と CSS を直す**

`Header.tsx`：`props.account` が null なら今までの JSX のまま。あれば、計器の `span.gauges` を `AccountSwitcher` の `children` として包む。値が無いとき（`gauges-none` のリンク）も、アカウントがあれば切り替えのボタンを出す（中身は色の点・名前・「まだ値がありません」）。`styles/header.test.ts` の決まり（`min-width: 0`、畳んだ部品を `display: none` にしない）に合わせる。

- [ ] **Step 6: 全体を確かめる**

Run: `npx vitest run packages/ui 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS（`styles/*.test.ts` の決まりも含む）。

- [ ] **Step 7: コミット**

```bash
git add packages/ui/src/views/AccountSwitcher.tsx packages/ui/src/views/AccountSwitcher.test.tsx packages/ui/src/views/primitives/AccountMeters.tsx packages/ui/src/views/primitives/AccountMeters.test.tsx
git commit packages/ui/src -m "feat(ui): switch accounts from the header, showing the account the current screen runs under"
```

---

### Task 4: セッション画面の札と、切り替えの確認

**Files:**
- Modify: `packages/ui/src/presenters/session.ts`（`SessionProps.account`）
- Modify: `packages/ui/src/views/SessionScreen.tsx`（情報の行）
- Modify: `packages/ui/src/presenters/confirm.ts`、`packages/ui/src/views/ConfirmDialog.tsx`
- Modify: `packages/ui/src/styles/session.css`
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/SessionScreen.test.tsx`、`packages/ui/src/views/dialogs.test.tsx`、`packages/ui/src/Root.test.tsx`

**Interfaces:**
- Consumes: Task 2 の `accountOfSession`、`hasMultipleAccounts`、`ConfirmRequest` の 2 種、Task 3 の切り替えの Intent
- Produces:
  - `SessionProps.account: { name: string; color: string } | null`（アカウントが 1 件以下なら null）
  - `ConfirmProps` に、切り替えと削除の確認が要る名前（`accountName: string | null`）

- 規則:
  - 情報の行：状態の次、モデルの前に、色の点と名前の `<span>`（`title` は `このセッションを動かしているアカウント`）。null なら何も足さない。行は 24px の 1 行のまま（`styles/session.test.ts`）。
  - 切り替えの確認（`ConfirmDialog` に `if` を 1 つ。手本は `adoptSession`）：
    - 見出し：`<名前> に切り替えますか？`
    - 本文：動いているとき「このセッションの Claude をいったん止め、同じ会話を <名前> で再開します。」、`working` が真なら続けて「途中の作業が中断されます。」（危険の色ではなく、注意の文として）。止まっているセッションでも同じ文でよい。最後に 1 行「新しいセッションの既定も <名前> になります。」
    - ボタン：「やめる」と「切り替える」（承諾は同じ Intent に `confirmed: true`）。
  - 削除の確認：見出し `<名前> を一覧から外しますか？`、本文「登録を外すだけで、置き場（ログインと設定のリンク）は残ります。このアカウントで動かしたセッションは、次から最初のアカウントで再開します。」、ボタンは「やめる」と「外す」。
  - 断られたとき：サーバの文がトーストに出る（Task 2 の `launchFailed`）。確認は閉じたまま、画面は元のセッション。

- [ ] **Step 1: 失敗する試験を書く**

- `presenters.test.ts`：`presentSession` の `account`（2 件で対応あり → 大学、対応なし → 会社、1 件 → null）。`presentConfirm` の `accountName`（切り替えと削除で、指す id の名前。一覧に無ければ null）。既存の `toEqual` の丸ごとの比較は、足した項目に合わせて直す。
- `SessionScreen.test.tsx`：`account` があると情報の行に名前が出る、null なら出ない。
- `dialogs.test.tsx`：切り替えの確認の文（`working` の有無で「途中の作業が中断されます。」の有無）、承諾で `account.switchSession { …, confirmed: true }`。削除の確認の文、承諾で `account.remove { …, confirmed: true }`。
- `Root.test.tsx`：セッション画面でヘッダから別のアカウントを選ぶ → 確認が出る → 承諾 → `switchAccount` が呼ばれる、を通しで 1 件。断られたとき（`switchAccount` が「このセッションにはまだ本文がありません。…」で reject）にトーストが出て、確認が閉じている、を 1 件。

- [ ] **Step 2: 落ちることを確かめ、実装する**

- [ ] **Step 3: 全体を確かめる**

Run: `npx vitest run packages/ui 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`

- [ ] **Step 4: コミット**

```bash
git commit packages/ui/src -m "feat(ui): show a session's account and confirm before reopening it under another one"
```

---

### Task 5: 新規セッションのダイアログの札

**Files:**
- Create: `packages/ui/src/views/AccountCards.tsx`、`packages/ui/src/views/AccountCards.test.tsx`
- Modify: `packages/ui/src/presenters/newSession.ts`（`NewSessionProps.accounts`）
- Modify: `packages/ui/src/views/NewSessionDialog.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Test: `packages/ui/src/views/NewSessionDialog.test.tsx`、`packages/ui/src/presenters/presenters.test.ts`

見た目の原本：`model3.html` の N4（色の点つきの横並びの札）と N3（注記）。

**Interfaces:**
- Consumes: `AccountView`、`AccountMeters`（Task 3）
- Produces:
  - `NewSessionProps.accounts: { list: AccountView[]; currentId: string } | null`（1 件以下なら null）
  - `AccountCards(props: { label: string; value: string; options: AccountView[]; onChange: (id: string) => void })`

- 規則:
  - 段の場所：プロジェクトの欄の下、名前の欄の上。見出しは「アカウント」。`accounts` が null なら段ごと出さない。
  - 札：`role="radiogroup"` と `role="radio"`、`aria-checked`。矢印キーで移る（既存の `OptionCards` と同じ操作）。2 列の grid、3 件以上は折り返す。中身は `AccountMeters`（`showResets` は偽。注記が戻る時刻を言う）。選んだ札は `.option-card` の選択と同じ見た目（枠 2px のアクセント、淡い地）。
  - 未ログインの札（`auth` が `out`）は `aria-disabled` で選べない。
  - はじめの選択：いまのアカウント（`currentId`）。それが一覧に無い、または未ログインなら、ログイン済みの最初の 1 件。
  - 開いている間に一覧が変わり、選んでいた id が消えたら、いまのアカウントへ戻す。
  - 送るとき：`accounts` が null でなければ、選んだ id を `params.account` に必ず入れる（いまのアカウントと同じでも入れる。開いてから送るまでの間に、いまのアカウントが変わっても選んだとおりに起こすため）。null なら `account` を入れない。
  - ダイアログで選んでも、いまのアカウントは変えない（`account.choose` を出さない）。
  - ダイアログが開いたとき、`accounts` があれば `accounts.load` を 1 回出す。
  - 札の中の Enter は起動に使わない（既存の `[role="radio"]` の扱いのまま）。

- [ ] **Step 1: 失敗する試験を書く**

- `AccountCards.test.tsx`：2 枚出る、選択の `aria-checked`、押すと `onChange`、矢印キーで移る、未ログインは選べない。
- `NewSessionDialog.test.tsx`：
  1. `accounts` が null → 「アカウント」の段が無く、送った params に `account` が無い（既存の試験がそのまま通る）。
  2. 2 件・いまが会社 → はじめは会社。そのまま起動すると `params.account === 'primary'`。
  3. 大学を選んで起動 → `params.account === 'a1'`。`account.choose` は出ない。
  4. いまのアカウントが未ログイン → はじめは、ログイン済みの最初の 1 件。
  5. 開いたときに `accounts.load` が 1 回出る。
  6. 選んでいた id が props から消えたら、いまのアカウントに戻る（`rerender`）。
- `presenters.test.ts`：`presentNewSession` の `accounts`（1 件 → null、2 件 → 一覧といまの id）。

- [ ] **Step 2: 落ちることを確かめ、実装する**

- [ ] **Step 3: 全体を確かめる**

Run: `npx vitest run packages/ui 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`

- [ ] **Step 4: コミット**

```bash
git add packages/ui/src/views/AccountCards.tsx packages/ui/src/views/AccountCards.test.tsx
git commit packages/ui/src -m "feat(ui): pick the account for a new session from cards that show its usage"
```

---

### Task 6: 設定のアカウントの節

**Files:**
- Create: `packages/ui/src/views/AccountSettings.tsx`、`packages/ui/src/views/AccountSettings.test.tsx`
- Modify: `packages/ui/src/presenters/settings.ts`（`SettingsProps.accounts`）
- Modify: `packages/ui/src/views/SettingsScreen.tsx`（「連携」の群に節を足し、`subs` に「アカウント」）
- Modify: `packages/ui/src/mediator/screen.ts` か `packages/ui/src/runtime/runtime.ts`（設定に入ったときに `GET /api/accounts`。既存の `api.loadSettingsExtras` に足す）
- Modify: `packages/ui/src/styles/settings.css`
- Test: `packages/ui/src/views/misc.test.tsx`（固定データ）、`packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/runtime/runtime.test.ts`

見た目の原本：`model.html` の F（一覧と追加）。頭文字の四角い印は使わず、色の点にする。

**Interfaces:**
- Consumes: `AccountView`、`presentAccounts`（Task 2）、Intent 9 種
- Produces:
  - `SettingsProps.accounts: { list: AccountView[]; colors: string[] }`（アカウントが 1 件でも出す。`colors` は選べる 5 色：`#2a57b8`、`#7a4a9e`、`#2b7048`、`#c77a1a`、`#a2452f`）
  - `AccountSettings(props: SettingsProps['accounts'])`

- 規則:
  - 節の見出し「アカウント」。説明の 1 行：「Claude Code のアカウントを足すと、設定・スキル・履歴は共有したまま、ログインだけを切り替えられます。hangar はログインの中身を読みません。」
  - 一覧：アカウントごとに 1 行。左から、色の点、名前、置き場（等幅、`~` で始まる形に縮める。ホームの下でなければそのまま）、右に状態：ログイン済みは「<プラン>・<メール>」、未読は空、未ログインは「未ログイン」、途中は「ブラウザで承認してください…」。いまのアカウントには「いま」の小さな札、最初のアカウントには「最初のアカウント」と小さく添える。
  - 行の操作（右端のメニュー「⋯」。既存の `MenuButton`）：
    - 「名前を変える」→ その行の名前がその場の入力欄になり、Enter か欄を出ると `account.update { name }`、Esc でやめる。
    - 「色を変える」→ 5 色の点が並ぶ小さな帯がその行に出て、押すと `account.update { color }`。
    - 「ログインし直す」（未ログインのときは行に「ログイン」のボタンを直に出す）→ `account.login`。
    - 途中のときは「やめる」のボタン → `account.login.cancel`。
    - 「状態を読み直す」→ `account.refresh`。
    - 「一覧から外す」→ `account.remove`（確認は Task 4 のダイアログ）。最初のアカウントでは押せず、理由「最初のアカウントは外せません」を添える（押せない項目は消さずに理由を出す、既存の流儀）。
  - `linkProblem` があれば、その行の下に注意の色で 1 行出す。
  - 追加：一覧の下に、名前の入力欄（placeholder「名前（例：大学）」）と「追加してログイン」のボタン。Enter でも送る。空なら押せない。押すと `account.add { name }`、欄を空にする。下に小さく「ブラウザが開くので、足したいアカウントで承認してください。終わると、ここにメールアドレスが出ます。」
  - 設定の画面に入ったとき、`GET /api/accounts` を呼ぶ（認証を読ませる）。
  - ヘッダの「アカウントの設定」から来たとき、この節が見える位置へ移る（設定の目次の既存の仕組みで足りるなら使う。無ければ、節の `id` へのスクロールを 1 つ足す）。

- [ ] **Step 1: 失敗する試験を書く**

- `AccountSettings.test.tsx`：
  1. 2 件が並び、いまのアカウントに「いま」、最初のアカウントに「最初のアカウント」。
  2. 状態の 4 通りの文。途中の行に「やめる」があり、押すと `account.login.cancel`。
  3. 未ログインの行の「ログイン」で `account.login`。
  4. 名前を変える：メニューから入力欄になり、Enter で `account.update { accountId, name }`、Esc では出ない。
  5. 色を変える：帯の点を押すと `account.update { accountId, color }`。
  6. 外す：`account.remove { accountId }`（confirmed なし）。最初のアカウントでは押せず、理由が出る。
  7. 追加：空では押せない。名前を入れて Enter で `account.add { name: '大学' }`、欄が空になる。
  8. `linkProblem` の文が出る。
- `misc.test.tsx`：設定の固定データに `accounts` を足す。目次の小見出しに「アカウント」が出ること（群の名前の決め打ちの比較は変えない：既存の群に節を足すだけ）。
- `runtime.test.ts`：設定に入ると `accounts()` が呼ばれ、Store に入る。

- [ ] **Step 2: 落ちることを確かめ、実装する**

- [ ] **Step 3: 全体を確かめる**

Run: `npx vitest run packages/ui packages/shared packages/server 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`

- [ ] **Step 4: コミット**

```bash
git add packages/ui/src/views/AccountSettings.tsx packages/ui/src/views/AccountSettings.test.tsx
git commit packages/ui/src -m "feat(ui): add, rename, recolor, log in and remove accounts from settings"
```

---

### Task 7: 文書と、ビルド

**Files:**
- Modify: `docs/design.md`（画面の節に、アカウントの切り替えを 1 節）
- Modify: `docs/superpowers/specs/2026-10-06-account-switch-design.md`（「画面の計画へ送るもの」の、この計画で片付いた行に印）
- Modify: `README.md`（使い方に、アカウントの追加と切り替えを 3〜5 行）

- [ ] **Step 1: 文書を直す**

`docs/design.md` の既存の節の書き方（短い文、決定とその理由）に合わせ、次を書く：いまのアカウントを 1 つ持つこと、ヘッダが「いま見ているものに効いているアカウント」を出すこと、アカウントが 1 件のときは何も変わらないこと、一覧に印を出さないこと、自動で切り替えないこと。

設計書の「画面の計画へ送るもの」のうち、この計画で片付いたもの（ログインの理由と中止、`primary` を shared へ、`POST /accounts/:id/login` の 500）の行頭に「（済み、計画 2）」を付ける。片付けていないものはそのまま残す。

- [ ] **Step 2: ビルドを通す**

Run: `npm run build 2>&1 | tail -3 && npm run bundle-server -w apps/desktop 2>&1 | tail -2`
Expected: どちらもエラーなし。デスクトップのビルド（tauri）と実物の確かめは、指揮役が別に行う。

- [ ] **Step 3: コミット**

```bash
git commit docs/design.md docs/superpowers/specs/2026-10-06-account-switch-design.md README.md -m "docs: describe account switching in the design notes and the README"
```
