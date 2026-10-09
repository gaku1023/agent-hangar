# セッションの状態 第 3 段「提案の入口」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セッションの状態（Done・Paused）の提案が、会話の区切り・claude.zsh で抜けるとき・事後の要約の 3 つの入口から届くようにする。

**Architecture:** 会話の区切りは、`renderInjection` に 3 行を足して Claude に AskUserQuestion で聞かせ、第 1 段の MCP `propose_session_status` に渡させる。claude.zsh は、サーバに足す 2 つの入口（Claude 側の id で引く `GET …/exit-prompt` と `POST …/state`）を curl で呼び、1 打鍵の答えを送る。送り先のポートは書き出すときのサーバのポートを埋め込む。事後の要約は、スキーマに `proposed_*` を足し、`summarizeOne` の upsert の直後に第 1 段の `proposeSessionState(..., source: 'post_hoc')` を呼ぶ。

**Tech Stack:** Node 22、TypeScript、Hono、better-sqlite3、zsh（macOS の /bin/zsh）、curl、vitest。

**Spec:** `docs/superpowers/specs/2026-10-01-session-status-design.md`（「指示の注入」「HTTP」「claude.zsh で抜けるとき」「事後の要約」「試験」）。3 段で共有する名前と型は `docs/superpowers/plans/2026-10-01-session-status-contract.md`。

## Global Constraints

- 作業はすべて worktree `/Users/me/workspace/agent-hangar/.claude/worktrees/session-status`（ブランチ `worktree-session-status`）で行う。元の checkout には触らない。
- worktree の根に `node_modules` が無ければ、最初に worktree の根で `npm ci` を行う（`npm install` は package-lock.json を書き換えるので使わない）。
- 第 1 段（データと入口）が入っている前提で書く。始める前に次の 3 つがあることを確かめる。無ければ第 1 段を先に入れる。
  - `packages/server/src/sessions/states.ts` の `getSessionState`・`setSessionState`・`proposeSessionState`・`rejectSessionState`・`StateInputError`
  - `packages/shared/src/sessionState.ts` の `STATE_NOTE_MAX`・`localDate`・`addDays`（`@agent-hangar/shared` から再輸出）
  - `packages/server/src/http/app.ts` の `PUT /api/sessions/:id/state` と、`packages/server/src/mcp/tools.ts` の `propose_session_status`
- 契約の名前と型（`SessionStateDto`、`SessionStatus`、`CandidateSource`、`proposeSessionState` の引数）は変えない。
- 依存を足さない。zsh の側は macOS に最初からある `curl`・`date`・`pgrep` だけを使う。
- 鍵（token）は curl の argv に載せない。`-H @<ファイル>` で `~/.agent-hangar/statusline-header`（token から作る `Authorization: Bearer …` の 1 行、起動のたびに `ensureStatuslineHeaderFile` が置く）を読ませる。
- by-provider の入口は MCP のツールに出さない。`/mcp` の側には何も足さない。
- 返す文言は日本語の平叙文にする。400・404・409 の本文は `{ error: '<日本語の一文>' }`。
- コードのコメントは日本語で、周りのコードと同じ密度と口調（「〜する」「〜ためである」）にする。
- 試験は worktree の根で `npx vitest run <path>`。型は `npm run typecheck`。zsh の試験は `/bin/zsh` が無ければ飛ばす（既存の `describe.skipIf(!ZSH)` に合わせる）。
- 試験は一時ディレクトリだけを使う。`~/.claude`、`~/.agent-hangar`、利用者の `npm run dev`（4177 と 5173）に触れない。zsh の試験が送る先は 4321 にし、偽の curl を PATH の先頭に置く。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- **鍵のヘッダのファイル（`statusline-header`）が無い**（置き場を消した、サーバを一度も起こしていない）：claude.zsh は curl を呼ばずに問いを飛ばし、後始末だけを済ませる。Task 3 に「鍵のヘッダのファイルが無ければ、curl を呼ばずに飛ばす」を足す。
- **hangar が 4177 以外で動いている**（`HANGAR_PORT`、`port: 0` の試験）、または `hangar shell install` が後から本体を書き直す：claude.zsh は書き出したサーバの実際のポートへ送り、CLI の書き直しでもそのポートを失わない。Task 3 に「ポートを渡さない書き出しは、前のポートを引き継ぐ」と、サーバが待ち受けたポートを埋め込む試験を足す。
- **抜けた直後で、そのセッションが hangar の索引にまだ無い**：`exit-prompt` は 404 を返し、claude.zsh は問わない。`POST …/state` も 404 で、claude.zsh は「hangar に届きませんでした」を 1 行出す。Task 2 に 404 の試験を、Task 3 に「繋がらないときは問わない」「送れなかったら 1 行だけ知らせる」を足す。
- **日本語の理由に引用符・バックスラッシュ・改行が入る**（提案の根拠を Paused の理由に流用する）：`exit-prompt` は改行と制御文字を空白に寄せて行の区切りを守り、claude.zsh は `\` と `"` を逃がして JSON を壊さず、サーバはそのまま保存する。Task 2 と Task 3 に、`"本番"で確かめる\ C:\tmp` のような理由の往復の試験を足す。
- **要約器が `proposed_*` を返さない古いモデル、範囲外の日数、空の根拠**：要約は従来どおり書き、提案は作らないか丸める（日数は 1〜14、根拠が空なら 1 文の要約）。提案の書き込みが検査で落ちても要約は失敗にしない。Task 4 と Task 5 に試験を足す。

---

### Task 1: 区切りで状態を聞く指示の注入

**Files:**
- Modify: `packages/server/src/launch/injection.ts:5-26`
- Test: `packages/server/src/launch/injection.test.ts`（6-17 行の `describe` の中に 1 件足す）

**Interfaces:**
- Consumes: 第 1 段の MCP ツール名 `propose_session_status` と、その引数 `confirmed`（文言の中で名前だけを使う）
- Produces: `renderInjection(i: InjectionInput): string` の戻り値に 3 行が増える（型は変えない）

注記：この指示は hangar が `--append-system-prompt` で起こす会話（新規、`claude -r` での再開、フォーク）にしか渡らない。
次の会話には渡らないので、会話の中での問いは出ない。これらは claude.zsh の問い（Task 3）と事後の要約（Task 5）で拾う。

- `runs/manager.ts` の `attach`（341-354 行のコメントのとおり、`claude attach` は指示も MCP の設定も受け取らない）
- `runs/manager.ts` の `resume` で、バックグラウンドのサービスが持っていたセッションを `claude attach <job>` で起こす場合（311 行）
- claude.zsh が `claude --bg` で起こした会話（hangar の外で起動するため）

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/launch/injection.test.ts` の 1 件目の `it`（7-17 行）の後ろに足す。

```ts
  it('区切りで状態を聞く 3 行を、TODO の 2 行と意図の行の間に置く', () => {
    const t = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: [] });
    expect(t).toContain([
      '完了にするのは利用者です。確かめられていないものは出さないでください。',
      '頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <戻る日>（何を確かめに戻るか）」「まだ続ける」です。',
      '利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。',
      '途中のターンでは聞かないでください。',
      'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
    ].join('\n'));
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/launch/injection.test.ts`
Expected: FAIL（`区切りで状態を聞く 3 行を…` が `toContain` で落ちる）

- [ ] **Step 3: 3 行を足す**

`packages/server/src/launch/injection.ts` の doc コメント（5-8 行）を次に替える。

```ts
/**
 * --append-system-prompt で渡す短い指示。ファイルや設定は書かず、要約の更新、片付いた TODO の候補、セッションの状態の問い、ターンの意図、日本語の手の説明を求める。
 * TODO は ID を添えて渡す。ID が無いと、候補を出す前に get_project を呼んで引く一手が要るためである。
 * 状態は、依頼を終えた区切りでだけ AskUserQuestion で聞かせる。利用者が選んだものは confirmed: true でそのまま状態になり、答えずに進めたものは候補として画面に残る。
 * attach で開く会話と claude.zsh で起こした会話にはこの指示が渡らないので、そちらは claude.zsh の問いと事後の要約で拾う。
 */
```

戻り値の配列の 22 行（`'完了にするのは利用者です。…',`）と 23 行（`'ターンを始めたときと…',`）の間に 3 行を足す。足した後の 22-26 行は次の形になる（前後の 2 行は今のまま）。

```ts
    '完了にするのは利用者です。確かめられていないものは出さないでください。',
    '頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <戻る日>（何を確かめに戻るか）」「まだ続ける」です。',
    '利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。',
    '途中のターンでは聞かないでください。',
    'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/launch packages/server/src/runs/manager.test.ts`
Expected: PASS（既存の 4 件と足した 1 件。manager の試験も注入の文字列の変化で落ちない）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/launch/injection.ts packages/server/src/launch/injection.test.ts
git commit -m "feat(server): ask for the session status at the end of a finished request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: claude.zsh のための by-provider の 2 つの入口

**Files:**
- Create: `packages/server/src/sessions/exitPrompt.ts`
- Test: `packages/server/src/sessions/exitPrompt.test.ts`
- Modify: `packages/server/src/http/app.ts`
  - import（4 行の shared、28 行付近の `../sessions/states.ts`）
  - 296-299 行（`session`・`broadcastSession` の後ろに `sessionIdByProvider` を足す）
  - 第 1 段が足した `api.put('/sessions/:id/state', …)`（`grep -n "sessions/:id/state" packages/server/src/http/app.ts` で位置を確かめる）
  - 720-733 行（`/ingest/statusline` の中の provider id の引き方を `sessionIdByProvider` に寄せる）
- Test: `packages/server/src/http/app.test.ts`（末尾 1211 行の後ろに `describe` を 1 つ足す）

**Interfaces:**
- Consumes（第 1 段）:
  - `getSessionState(db: Db, sessionId: string): SessionStateDto | null`
  - `setSessionState(db, deviceId, sessionId, { status, note?, returnOn?, setBy: 'user' | 'conversation', now? }): SessionStateDto`
  - `proposeSessionState(db, deviceId, sessionId, { status, note, returnOn, source, now? })`（試験だけで使う）
  - `class StateInputError extends Error`
- Produces:
  - `exitPromptText(state: SessionStateDto | null): string`（`packages/server/src/sessions/exitPrompt.ts`）
  - `GET /api/sessions/by-provider/:providerSessionId/exit-prompt` → 200 `text/plain` の 3 行。404 `{ error: 'セッションが見つかりません' }`
    - 1 行目：`ask` か `skip`（状態が付いていれば `skip` で、この 1 行だけ）
    - 2 行目：問いの頭に出す提案（例：`Claude の提案：Done（直して main に入れた）`、`Claude の提案：Paused · 10/3（本番で確かめる）`）。提案が無ければ空
    - 3 行目：明日の Paused の理由の下書き（提案の根拠）。無ければ空
  - `POST /api/sessions/by-provider/:providerSessionId/state`：本文は PUT と同じ `{ status: SessionStatus | null; note?: string; returnOn?: string }`、setBy は `user`、200 `{ state: SessionStateDto }`、成功後に `session.upsert`。404・400 は PUT と同じ形
  - `createApp` の中の `putSessionState(c: Context, id: string): Promise<Response>`（PUT と by-provider の POST が分け合う）

提案を読む入口を別に足す理由：`GET /api/sessions/:id` は hangar 側の id（`sessions.id`）で引くが、claude.zsh が知っているのは Claude 側の id（`provider_session_id`）だけである。
しかも JSON を zsh で読むには jq などの道具が要り、macOS には最初から無い。
そこで、行で区切った text を返す最小の入口を足し、判定（状態があれば問わない）と文言の組み立てはサーバで済ませる。

- [ ] **Step 1: 3 行を組む関数の落ちる試験を書く**

`packages/server/src/sessions/exitPrompt.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { SessionCandidateDto, SessionStateDto } from '@agent-hangar/shared';
import { exitPromptText } from './exitPrompt.ts';

const state = (o: Partial<SessionStateDto> = {}): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
const cand = (o: Partial<SessionCandidateDto> = {}): SessionCandidateDto => ({ status: 'done', note: null, returnOn: null, source: 'in_session', at: 1, ...o });

describe('exitPromptText', () => {
  it('状態も提案も無ければ、頭も下書きも空で ask', () => {
    expect(exitPromptText(null)).toBe('ask\n\n\n');
    expect(exitPromptText(state())).toBe('ask\n\n\n');
  });
  it('状態がもう付いていれば skip。提案が残っていても状態を正とする', () => {
    expect(exitPromptText(state({ status: 'done', setBy: 'import', setAt: 1 }))).toBe('skip\n');
    // 同期で両方を持つ行が届いたときは、読むときに状態を正とする（仕様の「失敗の扱い」）。
    expect(exitPromptText(state({ status: 'archived', candidate: cand() }))).toBe('skip\n');
  });
  it('提案があれば頭に出し、根拠を Paused の理由の下書きにする', () => {
    expect(exitPromptText(state({ candidate: cand({ note: '直して main に入れた' }) }))).toBe('ask\nClaude の提案：Done（直して main に入れた）\n直して main に入れた\n');
    expect(exitPromptText(state({ candidate: cand({ status: 'paused', returnOn: '2026-10-03', note: '本番で確かめる' }) }))).toBe('ask\nClaude の提案：Paused · 10/3（本番で確かめる）\n本番で確かめる\n');
    expect(exitPromptText(state({ candidate: cand({ note: null }) }))).toBe('ask\nClaude の提案：Done\n\n');
  });
  it('根拠の改行やタブは空白に寄せ、行の区切りを崩さない。引用符と \\ はそのまま渡す', () => {
    const t = exitPromptText(state({ candidate: cand({ note: '1 行目\n2 行目\t"引用"\\' }) }));
    expect(t).toBe('ask\nClaude の提案：Done（1 行目 2 行目 "引用"\\）\n1 行目 2 行目 "引用"\\\n');
    expect(t.split('\n')).toHaveLength(4);
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/sessions/exitPrompt.test.ts`
Expected: FAIL（`Failed to resolve import "./exitPrompt.ts"`）

- [ ] **Step 3: 関数を書く**

`packages/server/src/sessions/exitPrompt.ts` を作る。

```ts
import type { SessionStateDto } from '@agent-hangar/shared';

/** 1 行に収める。改行やタブなどの制御文字は空白 1 つに寄せる。claude.zsh は行で区切って読むためである。 */
const oneLine = (s: string | null): string => (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** YYYY-MM-DD を M/D に。端末の 1 行に収まる短い形にする。 */
const monthDay = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * claude.zsh が抜けるときに読む text。
 * 1 行目は ask か skip。状態がもう付いていれば skip にし、問いを出させない。
 * 2 行目は問いの頭に出す提案（無ければ空）、3 行目は明日の Paused の理由の下書き（提案の根拠、無ければ空）である。
 * 根拠は 1 行に寄せてから渡す。claude.zsh は JSON に入れるときに \ と " だけを逃がすので、制御文字をここで落としておく。
 */
export function exitPromptText(state: SessionStateDto | null): string {
  if (state?.status) return 'skip\n';
  const c = state?.candidate ?? null;
  if (!c) return 'ask\n\n\n';
  const note = oneLine(c.note);
  const label = c.status === 'done' ? 'Done' : `Paused${c.returnOn ? ` · ${monthDay(c.returnOn)}` : ''}`;
  return `ask\nClaude の提案：${label}${note ? `（${note}）` : ''}\n${note}\n`;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/sessions/exitPrompt.test.ts`
Expected: PASS（4 件）

- [ ] **Step 5: 入口の落ちる試験を書く**

`packages/server/src/http/app.test.ts` の import に次を足す。

```ts
import type { SessionStateDto } from '@agent-hangar/shared';
import { TOOL_NAMES } from '../mcp/tools.ts';
import { getSessionState, proposeSessionState, setSessionState } from '../sessions/states.ts';
```

（`SessionStateDto` は 5 行の `@agent-hangar/shared` の型の import に並べてもよい。第 1 段がすでに `../sessions/states.ts` を import していれば、足りない名前だけを足す。）

末尾に足す。

```ts
describe('claude.zsh の入口（by-provider）', () => {
  const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = () => (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  const base = `/api/sessions/by-provider/${SESSION_ALPHA}`;
  const MISSING = '/api/sessions/by-provider/ffffffff-0000-4000-8000-000000000000';

  it('Claude 側の id で引いて状態を書き、setBy は user で、そのセッションの session.upsert を配る', async () => {
    sent.length = 0;
    const r = await post(`${base}/state`, { status: 'done' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { state: SessionStateDto }).state).toMatchObject({ status: 'done', setBy: 'user', candidate: null });
    expect(getSessionState(db, alphaId())).toMatchObject({ status: 'done', setBy: 'user' });
    expect(sent.some((e) => e.type === 'session.upsert' && e.session.id === alphaId())).toBe(true);
  });
  it('paused は戻る日が要り、無ければ 400 で理由を返す。日本語の理由に引用符と \\ が入ってもそのまま残す', async () => {
    const bad = await post(`${base}/state`, { status: 'paused' });
    expect(bad.status).toBe(400);
    expect(typeof ((await bad.json()) as { error: unknown }).error).toBe('string');
    expect((await post(`${base}/state`, { status: 'weird' })).status).toBe(400);
    const note = '「"本番"で確かめる」\\ C:\\tmp';
    const ok = await post(`${base}/state`, { status: 'paused', returnOn: '2026-10-02', note });
    expect(ok.status).toBe(200);
    expect(getSessionState(db, alphaId())).toMatchObject({ status: 'paused', returnOn: '2026-10-02', note });
  });
  it('索引にまだ無い id は、書き込みも問いの text も 404 にする', async () => {
    const w = await post(`${MISSING}/state`, { status: 'done' });
    expect(w.status).toBe(404);
    expect(((await w.json()) as { error: string }).error).toBe('セッションが見つかりません');
    expect((await get(`${MISSING}/exit-prompt`)).status).toBe(404);
  });
  it('鍵が無ければ、どちらも 401', async () => {
    expect((await app.request(`${base}/state`, { method: 'POST', body: '{"status":"done"}' })).status).toBe(401);
    expect((await get(`${base}/exit-prompt`, {})).status).toBe(401);
  });
  it('exit-prompt は 3 行の text を返し、提案を頭に出し、状態が付けば skip にする', async () => {
    const empty = await get(`${base}/exit-prompt`);
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await empty.text()).toBe('ask\n\n\n');
    proposeSessionState(db, 'd', alphaId(), { status: 'done', note: '直して main に入れた', returnOn: null, source: 'in_session' });
    expect(await (await get(`${base}/exit-prompt`)).text()).toBe('ask\nClaude の提案：Done（直して main に入れた）\n直して main に入れた\n');
    setSessionState(db, 'd', alphaId(), { status: 'done', setBy: 'user' });
    expect(await (await get(`${base}/exit-prompt`)).text()).toBe('skip\n');
  });
  it('MCP のツールには状態を書く入口を足さない', () => {
    // by-provider の 2 つは利用者の操作で、/mcp からは呼べない。状態に触るツールは第 1 段の提案の 1 つだけである。
    expect(TOOL_NAMES.filter((n) => /state|status/.test(n))).toEqual(['propose_session_status']);
  });
});
```

- [ ] **Step 6: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts -t "by-provider"`
Expected: FAIL（`/api/sessions/by-provider/…` の経路が無く、200・400・本文の検査が落ちる。401 の 1 件と MCP の 1 件は今でも通る）

- [ ] **Step 7: PUT の本体を分け合える形にし、2 つの入口を足す**

`packages/server/src/http/app.ts` の import に足す（第 1 段で入っている名前は足さない）。

```ts
import { exitPromptText } from '../sessions/exitPrompt.ts';
import { getSessionState, setSessionState, StateInputError } from '../sessions/states.ts';
```

4 行の `@agent-hangar/shared` の型の並びに `type SessionStatus` を足す。

299 行（`broadcastSession`）の直後に足す。

```ts
  /**
   * Claude 側のセッション ID から hangar 側の id を引く。論理削除された行と、まだ索引に無いものは null。
   * statusline の取り込みと claude.zsh の入口が使う。
   */
  const sessionIdByProvider = (providerSessionId: string): string | null =>
    (db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined)?.id ?? null;
```

`/ingest/statusline` の 728-731 行を次に替える（引き方を 1 つにする。振る舞いは変えない）。

```ts
    if (r.providerSessionId) {
      const id = sessionIdByProvider(r.providerSessionId);
      if (id) broadcastSession(id);
    }
```

第 1 段の `api.put('/sessions/:id/state', async (c) => { … })` の本体を、`createApp` の中の関数 `putSessionState` へ移す。
本体の中の `c.req.param('id')` は引数の `id` に置き換え、検査の順と文言は第 1 段のものを残す。
移した後の形は次のとおりで、第 1 段の本体と違うところがあれば第 1 段の振る舞いを正とする（第 1 段の PUT の試験が守りになる）。

```ts
  const STATE_STATUSES = new Set<unknown>(['paused', 'done', 'archived', null]);
  /**
   * 手で状態を変える。PUT /sessions/:id/state と、claude.zsh が使う by-provider の POST が分け合う。
   * 書き手は利用者なので setBy は user に決める。MCP からは呼べない（/mcp には出さない）。
   * 検査に落ちたら何も書かず、トーストにそのまま出せる一文を 400 で返す。
   */
  const putSessionState = async (c: Context, id: string): Promise<Response> => {
    if (!session(id)) return c.json({ error: 'セッションが見つかりません' }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { status?: unknown; note?: unknown; returnOn?: unknown };
    if (!STATE_STATUSES.has(body.status)) return c.json({ error: '状態は paused、done、archived、null のいずれかです' }, 400);
    if (body.note !== undefined && typeof body.note !== 'string') return c.json({ error: '理由は文字列です' }, 400);
    if (body.returnOn !== undefined && typeof body.returnOn !== 'string') return c.json({ error: '戻る日は YYYY-MM-DD の形の文字列です' }, 400);
    try {
      const state = setSessionState(db, deviceId, id, { status: body.status as SessionStatus | null, note: body.note as string | undefined, returnOn: body.returnOn as string | undefined, setBy: 'user' });
      broadcastSession(id);
      return c.json({ state });
    } catch (e) {
      if (e instanceof StateInputError) return c.json({ error: e.message }, 400);
      throw e;
    }
  };
  api.put('/sessions/:id/state', (c) => putSessionState(c, c.req.param('id')));
```

その直後（第 1 段の confirm と reject の入口の後ろでもよい）に 2 つの入口を足す。

```ts
  // claude.zsh が抜けるときに使う 2 つ。Claude 側のセッション ID で引く。どちらも MCP からは呼べない。
  // 問いの text は行で区切って返す。zsh で JSON を読む道具（jq など）は macOS に最初から無いためである。
  api.get('/sessions/by-provider/:providerSessionId/exit-prompt', (c) => {
    const id = sessionIdByProvider(c.req.param('providerSessionId'));
    if (!id) return c.json({ error: 'セッションが見つかりません' }, 404);
    return c.text(exitPromptText(getSessionState(db, id)));
  });
  api.post('/sessions/by-provider/:providerSessionId/state', (c) => {
    const id = sessionIdByProvider(c.req.param('providerSessionId'));
    if (!id) return c.json({ error: 'セッションが見つかりません' }, 404);
    return putSessionState(c, id);
  });
```

- [ ] **Step 8: 通ることを確かめる**

Run: `npx vitest run packages/server/src/http/app.test.ts packages/server/src/sessions`
Expected: PASS（足した 6 件と、第 1 段の PUT・confirm・reject の試験、statusline の取り込みの試験がそのまま通る）

Run: `npm run typecheck`
Expected: エラー 0 件

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/sessions/exitPrompt.ts packages/server/src/sessions/exitPrompt.test.ts packages/server/src/http/app.ts packages/server/src/http/app.test.ts
git commit -m "feat(server): add the by-provider state and exit-prompt routes for claude.zsh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: claude.zsh で抜けるときの状態の問い

**Files:**
- Modify: `packages/server/src/config/shellHook.ts`
  - 1-4 行（import）
  - 6-12 行（定数）
  - 31-45 行（`shellScript` の doc と冒頭）
  - 64-95 行（`__agent_hangar_leave` とその前に足す関数）
  - 148-155 行（`ensureShellScript`）
- Modify: `packages/server/src/server.ts:404-406` と `:579-581`（書き出しを待ち受けの後へ移し、ポートを渡す）
- Test: `packages/server/src/config/shellHook.test.ts`（6 行の import、74-132 行の `runWrapped`、末尾 211 行の後ろ）
- Test: `packages/server/src/server.test.ts`（344 行の `トークンを作り直すと…` の後ろに 1 件）

**Interfaces:**
- Consumes（Task 2）:
  - `GET http://127.0.0.1:<port>/api/sessions/by-provider/<uuid>/exit-prompt` の 3 行（`ask`/`skip`、頭、下書き）
  - `POST http://127.0.0.1:<port>/api/sessions/by-provider/<uuid>/state`、本文 `{"status":"done"}` か `{"status":"paused","returnOn":"YYYY-MM-DD","note":"…"}`
- Consumes（既存）: `statuslineHeaderPath(home: string): string`（`config/statusline.ts`）
- Produces:
  - `shellScript(o: { port: number; headerFile: string }): string`（引数を足す）
  - `ensureShellScript(home: string, port?: number): string`（port を省くと、前に書き出したポートを引き継ぎ、無ければ 4177）
  - `embeddedShellPort(file: string): number | null`
  - `DEFAULT_SHELL_PORT = 4177`
  - zsh の関数 `__agent_hangar_ask_status <Claude 側のセッション ID>`

注記：claude.zsh はサーバの起動のたびに `~/.agent-hangar/shell/claude.zsh` へ書き出される。
新しいサーバで起動し直すまで、問いは出ない。
加えて、すでに開いているターミナルは古い関数を読み込んだままなので、新しいターミナルを開くか `exec zsh` で読み直すまで古い振る舞いが続く。
`hangar shell install`（`cli/src/shell.ts:50`）はポートを渡さずに書き出すので、前のポートを引き継ぐ。CLI の側は変えない。

- [ ] **Step 1: 試験の土台を、偽の curl と画面の出力を拾える形に替える**

`packages/server/src/config/shellHook.test.ts` の 6 行の import に `embeddedShellPort` を足す。

```ts
import { claudeSupportsBackground, embeddedShellPort, ensureShellScript, installShellHook, SHELL_MARKER, shellHookInstalled, shellHookLine, shellHookState, shellInstallCommand, shellScriptPath, uninstallShellHook, zshrcPath } from './shellHook.ts';
```

76-132 行（`runWrapped` の doc コメントから関数の終わりまで）を次に替える。74 行の `const ZSH = …` はそのまま残す。

```ts
/** 試験の zsh が送る先のポート。4177 で動く利用者の hangar に届かないよう、別の番号にする。 */
const TEST_PORT = 4321;

/** 直前の runWrapped の画面の出力と、偽の curl が受けた引数と本文。 */
let last: { out: string; curl: string[]; bodies: string[] } = { out: '', curl: [], bodies: [] };

/**
 * 包み方の本体を、本物の zsh で疑似端末の上に動かす。
 * 偽の claude は受け取った引数を 1 行ずつ記録し、--bg と agents には決まった出力を返す。
 * --bg が返す id は、tmux の上で hangar-run.sh … attach <id> を動かす manager のテストと重ならないものにする。重なると hangar が開いていると見てしまう。
 * 偽の curl は引数と本文を記録する。exitPrompt を渡したときだけ exit-prompt に答え、無ければ繋がらないとき（7）で終わる。
 * 鍵のヘッダは header を true にしたときだけ置く。置かない既定では、状態の問いは curl を呼ぶ前に飛ばされる。
 */
function runWrapped(args: string, o: { bgFails?: boolean; agents?: string; tty?: boolean; input?: string; answer?: string; hangarOpen?: string; transcript?: string; header?: boolean; exitPrompt?: string; postFails?: boolean } = {}): string[] {
  const home = path.join(dir, 'home');
  ensureShellScript(home, TEST_PORT);
  if (o.header) fs.writeFileSync(path.join(home, 'statusline-header'), 'Authorization: Bearer secret-token\n', { mode: 0o600 });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'calls.log');
  const curlLog = path.join(dir, 'curl.log');
  const bodyLog = path.join(dir, 'curl-body.log');
  for (const f of [log, curlLog, bodyLog]) fs.writeFileSync(f, '');
  fs.writeFileSync(path.join(dir, 'agents.json'), o.agents ?? '[]\n');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    `echo "[$*]" >> "${log}"`,
    'case "$1" in',
    `  --bg) ${o.bgFails ? 'echo "Workspace not trusted." >&2; exit 1' : 'echo "Starting background service…" >&2; echo "backgrounded · 5e11600c (idle — send a prompt to start)"; echo "  claude agents             list sessions"'} ;;`,
    `  agents) cat "${path.join(dir, 'agents.json')}" ;;`,
    '  stop) echo "stopped $2" ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const promptFile = path.join(dir, 'exit-prompt.txt');
  fs.rmSync(promptFile, { force: true });
  if (o.exitPrompt !== undefined) fs.writeFileSync(promptFile, o.exitPrompt);
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${curlLog}"`,
    `case "$*" in *--data-binary*) cat >> "${bodyLog}" ;; esac`,
    'case "$*" in',
    `  *exit-prompt*) [ -f "${promptFile}" ] || exit 7; cat "${promptFile}" ;;`,
    `  */state*) ${o.postFails ? 'exit 22' : "echo '{}'"} ;;`,
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const config = path.join(dir, 'claude-config');
  if (o.transcript) {
    fs.mkdirSync(path.join(config, 'projects', '-x'), { recursive: true });
    fs.writeFileSync(path.join(config, 'projects', '-x', `${o.transcript}.jsonl`), '{}\n');
  }
  // hangar が開いているセッションは、hangar-run.sh の下の claude attach <id> として見える。
  let hangar: ChildProcess | null = null;
  if (o.hangarOpen) {
    const runner = path.join(dir, 'hangar-run.sh');
    fs.writeFileSync(runner, 'sleep 30\n');
    hangar = spawn('/bin/sh', [runner, path.join(dir, 'run.log'), '/x/claude', 'attach', o.hangarOpen], { stdio: 'ignore' });
  }
  const inner = `source ${JSON.stringify(shellScriptPath(home))}; claude ${args}`;
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HANGAR_NO_WRAP: '', CLAUDE_CONFIG_DIR: config, HANGAR_TEST_INNER: inner, HANGAR_TEST_INPUT: o.input ?? '', HANGAR_TEST_ANSWER: o.answer ?? '', HANGAR_TEST_LOG: log, HANGAR_TEST_CURL_LOG: curlLog, HANGAR_TEST_ZSH: ZSH! };
  // script(1) が疑似端末を用意するので、包み方は端末の上で動いていると見る。
  // 尋ねられる場面では、attach から抜けた後に状態を引くまで待ってから input を打つ。先に打つと read -q が始まるときに捨てられる。
  // 状態の問いの answer も同じ理由で、curl が exit-prompt を引いた後に打つ。
  // script(1) は node の pipe（ソケット）を標準入力に取れないので、sh のパイプで渡す。
  const typed = [
    '(i=0; until awk \'/^\\[attach/ { a = 1 } a && /^\\[agents --json\\]/ { f = 1 } END { exit !f }\' "$HANGAR_TEST_LOG" || [ $i -ge 100 ]; do sleep 0.05; i=$((i + 1)); done',
    '; sleep 0.3; printf %s "$HANGAR_TEST_INPUT"',
    '; if [ -n "$HANGAR_TEST_ANSWER" ]; then i=0; until grep -q exit-prompt "$HANGAR_TEST_CURL_LOG" || [ $i -ge 100 ]; do sleep 0.05; i=$((i + 1)); done; sleep 0.3; printf %s "$HANGAR_TEST_ANSWER"; fi)',
    ' | /usr/bin/script -q /dev/null "$HANGAR_TEST_ZSH" -f -c "$HANGAR_TEST_INNER"',
  ].join('');
  try {
    const r = o.tty === false
      ? spawnSync(ZSH!, ['-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : o.input !== undefined || o.answer !== undefined
        ? spawnSync('/bin/sh', ['-c', typed], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        : spawnSync('/usr/bin/script', ['-q', '/dev/null', ZSH!, '-f', '-c', inner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) throw r.error;
    const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    last = { out: r.stdout, curl: lines(curlLog), bodies: lines(bodyLog) };
  } finally {
    hangar?.kill();
  }
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.slice(1, -1));
}
```

- [ ] **Step 2: 落ちる試験を書く**

`packages/server/src/config/shellHook.test.ts` の末尾（211 行の後ろ）に足す。

```ts
/** 手元の暦の明日。zsh の date -v+1d と同じ日になる。 */
const tomorrow = (): string => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ASK = 'このセッションをどうしますか？ [d] Done  [p] 明日の Paused  [Enter] そのまま';
const EXIT_URL = `http://127.0.0.1:${TEST_PORT}/api/sessions/by-provider/${NEW_SID}/exit-prompt`;
const STATE_URL = `http://127.0.0.1:${TEST_PORT}/api/sessions/by-provider/${NEW_SID}/state`;

describe('書き出す本体', () => {
  it('ポートと鍵のヘッダの置き場を埋め込み、鍵そのものは書かない', () => {
    const home = path.join(dir, 'home');
    const file = ensureShellScript(home, 4321);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('__agent_hangar_port=4321\n');
    expect(body).toContain(`__agent_hangar_header='${path.join(home, 'statusline-header')}'\n`);
    expect(body).toContain(ASK);
    expect(body).toContain('-m 1');
    expect(body).not.toContain('Bearer');
  });
  it('ポートを渡さない書き出し（hangar shell install）は、前のポートを引き継ぎ、無ければ 4177 にする', () => {
    const home = path.join(dir, 'home');
    ensureShellScript(home, 4321);
    ensureShellScript(home);
    expect(embeddedShellPort(shellScriptPath(home))).toBe(4321);
    const fresh = path.join(dir, 'fresh');
    ensureShellScript(fresh);
    expect(embeddedShellPort(shellScriptPath(fresh))).toBe(4177);
  });
  it.skipIf(!ZSH)('置き場に引用符や空白があっても、zsh が読める形で埋め込む', () => {
    const home = path.join(dir, "it's my home");
    const file = ensureShellScript(home, 4321);
    const r = spawnSync(ZSH!, ['-f', '-c', `source ${JSON.stringify(file)}; print -r -- "$__agent_hangar_header"`], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${path.join(home, 'statusline-header')}\n`);
  });
});

describe.skipIf(!ZSH)('抜けたときの状態の問い（zsh 上）', () => {
  const ask = { transcript: NEW_SID, header: true, exitPrompt: 'ask\n\n\n' };
  it('本文のある会話を止めた後に聞き、d なら Done を送る', () => {
    expect(runWrapped('', { agents: launched('done'), ...ask, answer: 'd' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
    expect(last.out).toContain(ASK);
    expect(last.out).toContain('Done にしました。');
    expect(last.curl[0]).toBe(`-sf -m 1 -H @${path.join(dir, 'home', 'statusline-header')} ${EXIT_URL}`);
    expect(last.curl[1]).toContain(STATE_URL);
    // 鍵は -H @<ファイル> で読ませ、argv には載せない。
    expect(last.curl.join('\n')).not.toContain('secret-token');
    expect(last.bodies.map((b) => JSON.parse(b))).toEqual([{ status: 'done' }]);
  });
  it('p なら明日の Paused を送り、理由には提案の根拠を入れる。引用符と \\ が入っても JSON が壊れない', () => {
    const note = '"本番"で確かめる\\ C:\\tmp';
    runWrapped('', { agents: launched('done'), ...ask, exitPrompt: `ask\nClaude の提案：Paused · 10/3（${note}）\n${note}\n`, answer: 'p' });
    expect(last.out).toContain(`Claude の提案：Paused · 10/3（${note}）`);
    const day = tomorrow();
    expect(last.bodies.map((b) => JSON.parse(b))).toEqual([{ status: 'paused', returnOn: day, note }]);
    expect(last.out).toContain(`${day} に戻る Paused にしました。`);
  });
  it('Enter とほかの打鍵は何も送らない', () => {
    runWrapped('', { agents: launched('done'), ...ask, answer: '\r' });
    expect(last.out).toContain(ASK);
    expect(last.bodies).toEqual([]);
    runWrapped('', { agents: launched('done'), ...ask, answer: 'x' });
    expect(last.bodies).toEqual([]);
  });
  it('作業中で止めるかを尋ねたときは、その答えの後に聞く', () => {
    expect(runWrapped('', { agents: launched('working', 'busy'), ...ask, input: 'n', answer: 'd' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json']);
    expect(last.out.indexOf('止めますか？')).toBeLessThan(last.out.indexOf(ASK));
    expect(last.bodies.map((b) => JSON.parse(b))).toEqual([{ status: 'done' }]);
  });
  it('状態がもう付いているとき（skip）は聞かない', () => {
    runWrapped('', { agents: launched('done'), ...ask, exitPrompt: 'skip\n' });
    expect(last.out).not.toContain(ASK);
    expect(last.bodies).toEqual([]);
  });
  it('hangar に繋がらない、または 1 秒で返らないときは聞かずに後始末を終える', () => {
    // 偽の curl は exit-prompt が無いと 7（繋がらない）で終わる。-m 1 の時間切れ（28）と 404（-f で 22）も同じく失敗として扱う。
    expect(runWrapped('', { agents: launched('done'), transcript: NEW_SID, header: true })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
    expect(last.curl).toHaveLength(1);
    expect(last.out).not.toContain(ASK);
  });
  it('鍵のヘッダのファイルが無ければ、curl を呼ばずに飛ばす', () => {
    runWrapped('', { agents: launched('done'), transcript: NEW_SID, exitPrompt: 'ask\n\n\n' });
    expect(last.curl).toEqual([]);
    expect(last.out).not.toContain(ASK);
  });
  it('本文が無い会話と、hangar が開いている会話には聞かない', () => {
    runWrapped('', { agents: launched('done'), header: true, exitPrompt: 'ask\n\n\n' });
    expect(last.curl).toEqual([]);
    runWrapped('', { agents: launched('done'), ...ask, hangarOpen: '5e11600c' });
    expect(last.curl).toEqual([]);
  });
  it('送れなかったら 1 行だけ知らせ、止める後始末はそのまま済ませる', () => {
    expect(runWrapped('', { agents: launched('blocked'), ...ask, postFails: true, input: 'y', answer: 'd' })).toEqual(['--bg', 'attach 5e11600c', 'agents --json', 'stop 5e11600c']);
    expect(last.out).toContain('hangar に届きませんでした。');
  });
});
```

`packages/server/src/server.test.ts` の 344 行（`トークンを作り直すと…` の `it` の終わり）の後ろに足す。

```ts
  it('claude.zsh に、待ち受けているポートと鍵のヘッダの置き場を埋め込む', async () => {
    // port: 0 で起こすと実際の番号は listen するまで決まらない。抜けるときの問いはこの番号へ送る。
    const s = await startServer({ port: 0, home, claudeDir, uiDist: path.join(home, 'no-dist') });
    try {
      const body = fs.readFileSync(path.join(home, 'shell', 'claude.zsh'), 'utf8');
      expect(body).toContain(`__agent_hangar_port=${s.port}\n`);
      expect(body).toContain(`__agent_hangar_header='${path.join(home, 'statusline-header')}'\n`);
    } finally {
      await s.close();
    }
  });
```

- [ ] **Step 3: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/shellHook.test.ts`
Expected: FAIL（足した試験が落ちる。`embeddedShellPort is not a function`、本体に `__agent_hangar_port=` と問いの文が無い、偽の curl が呼ばれない、など。既存の 20 件は通る）

- [ ] **Step 4: 本体を書く**

`packages/server/src/config/shellHook.ts` の import（1-4 行）の後ろに足す。

```ts
import { statuslineHeaderPath } from './statusline.ts';
```

7 行の `SHELL_MARKER` の後ろに足す。

```ts
/** 書き出したファイルにポートが無いときに使うポート。サーバの既定と同じ。 */
export const DEFAULT_SHELL_PORT = 4177;
```

`shellScript` の doc の末尾（37 行の「包めないとき…」の後ろ）に 2 行を足し、39 行の宣言を替える。

```ts
 * 本文のある会話を抜けたときは、セッションの状態（Done か明日の Paused）を 1 打鍵で聞き、hangar へ送る。
 * 送り先のポートと鍵のヘッダのファイルは、書き出すときに埋め込む。
 */
export function shellScript(o: { port: number; headerFile: string }): string {
```

本体の冒頭の説明（44 行の「1 回だけ包まずに起動するときは…」）の後ろに次を足す。テンプレート文字列の中なので、`${o.port}` と `${zshQuote(o.headerFile)}` は TypeScript が埋め、zsh の `$` はそのまま残る。

```
# 本文のある会話を抜けたときは、そのセッションを Done にするか明日の Paused にするかを 1 打鍵で聞きます。

# 状態を送る hangar のポートと、curl に読ませる鍵のヘッダのファイル。hangar が書き出すときに埋め込む。
__agent_hangar_port=${o.port}
__agent_hangar_header=${zshQuote(o.headerFile)}
```

64 行（`__agent_hangar_state` の終わりの `}`）と 66 行（`# attach から抜けたときの後始末。…`）の間に、次の関数を足す。テンプレート文字列の中なので、zsh の `${` は `\${`、`\` は `\\` と書く（下はそのまま貼る形）。

```
# 抜けた会話の状態を 1 打鍵で聞き、hangar へ送る。引数は Claude 側のセッション ID。
# 鍵のヘッダが無い、hangar が 1 秒で返らない、索引にまだ無い、状態がもう付いている、のどれかなら聞かない。
# 送れなかったときは 1 行だけ知らせる。後始末はこの関数の外で続く。
__agent_hangar_ask_status() {
  local url="http://127.0.0.1:$__agent_hangar_port/api/sessions/by-provider/$1" res key body day note
  [[ -r "$__agent_hangar_header" ]] || return 0
  # 1 行目が ask か skip、2 行目が頭に出す提案、3 行目が Paused の理由の下書き。
  res=$(command curl -sf -m 1 -H @"$__agent_hangar_header" "$url/exit-prompt" 2>/dev/null) || return 0
  local -a l
  l=("\${(@f)res}")
  [[ "$l[1]" == ask ]] || return 0
  [[ -n "$l[2]" ]] && print -r -- "$l[2]"
  read -k 1 "key?このセッションをどうしますか？ [d] Done  [p] 明日の Paused  [Enter] そのまま "
  print
  case "$key" in
    d|D) body='{"status":"done"}' ;;
    p|P)
      # 明日は手元の暦で数える。macOS の date に無ければ GNU の書き方を試す。
      day=$(command date -v+1d +%F 2>/dev/null || command date -d tomorrow +%F 2>/dev/null)
      [[ "$day" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ]] || { print -r -- "明日の日付を作れませんでした。hangar から付けてください。"; return 0; }
      # 理由は JSON の文字列に入れる。サーバが改行と制御文字を除いて渡すので、逃がすのは \\ と " だけでよい。
      note=\${l[3]//\\\\/\\\\\\\\}
      note=\${note//\\"/\\\\\\"}
      body="{\\"status\\":\\"paused\\",\\"returnOn\\":\\"$day\\",\\"note\\":\\"$note\\"}" ;;
    *) return 0 ;;
  esac
  if print -r -- "$body" | command curl -sf -m 2 -X POST -H 'Content-Type: application/json' -H @"$__agent_hangar_header" --data-binary @- "$url/state" >/dev/null 2>&1; then
    [[ -n "$day" ]] && print -r -- "$day に戻る Paused にしました。" || print -r -- "Done にしました。"
  else
    print -r -- "hangar に届きませんでした。状態は hangar の画面から付けられます。"
  fi
}

```

書き出された claude.zsh では、理由の 3 行は次の形になる（Step 6 で目で確かめる）。

```zsh
      note=${l[3]//\\/\\\\}
      note=${note//\"/\\\"}
      body="{\"status\":\"paused\",\"returnOn\":\"$day\",\"note\":\"$note\"}" ;;
```

`__agent_hangar_leave` の 74-82 行（`local -a f t` から `if [[ "$f[1]" == blocked … ]]; then` まで）を次に替える。83 行からの黙って止める本体はそのまま残す。本文の有無を先に見て、止める分岐の後と、尋ねる分岐の後の 2 か所で問いを呼ぶ。

```
  local -a f t
  f=(\${=st})
  # 本文があるかは、状態を聞くかどうかと、入力待ちのまま黙って止めるかどうかの両方に使う。
  t=("\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$f[3]".jsonl(N))
  if [[ "$f[1]" == done && "$f[2]" != busy ]]; then
    command claude stop "$id" >/dev/null 2>&1 && print -r -- "hangar で開いていないので、このセッションを止めました。続きは claude attach $id か hangar から開けます。"
    (( \${#t} )) && __agent_hangar_ask_status "$f[3]"
    return
  fi
  # 何も打たずに抜けたセッションも入力待ちに見える。本文がまだ無ければ、黙って止める。
  if [[ "$f[1]" == blocked && "$f[2]" != busy && \${#t} -eq 0 ]]; then
```

94-95 行（`fi` と関数の終わりの `}`）を次に替える。

```
  fi
  (( \${#t} )) && __agent_hangar_ask_status "$f[3]"
}
```

148-155 行の `ensureShellScript` を次に替え、その前に 2 つの関数を足す。`readText` は 157 行の関数宣言なので、前から呼べる。

```ts
/** zsh の単一引用符で包む。中の ' は '\'' で閉じて開き直す。 */
function zshQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 書き出したファイルに埋め込んだポート。ファイルが無いか読めなければ null。 */
export function embeddedShellPort(file: string): number | null {
  const m = /^__agent_hangar_port=(\d+)$/m.exec(readText(file) ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * <home>/shell/claude.zsh を置く。中身が同じなら書かない。
 * ポートはサーバが待ち受けているものを渡す。
 * 渡さないとき（hangar shell install）は、前に書き出したポートを引き継ぎ、無ければ 4177 にする。
 * CLI が 4177 で上書きすると、別のポートで動くサーバへ次の起動まで届かなくなるためである。
 */
export function ensureShellScript(home: string, port?: number): string {
  const file = shellScriptPath(home);
  const body = shellScript({ port: port ?? embeddedShellPort(file) ?? DEFAULT_SHELL_PORT, headerFile: statuslineHeaderPath(home) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o644 });
  return file;
}
```

`packages/server/src/server.ts` の 405-406 行（`// 包み方の本体は hangar の版と揃える。…` と `ensureShellScript(home);`）を消し、580 行（`const port = addr && …`）の直後に足す。

```ts
  // 包み方の本体は hangar の版と揃える。~/.zshrc の 1 行はこのファイルを読むだけなので、更新はここで行き渡る。
  // 抜けるときの状態の問いはこのサーバへ送るので、待ち受けが決まってから実際のポートを埋め込んで書く（port: 0 と HANGAR_PORT のため）。
  ensureShellScript(home, port);
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config/shellHook.test.ts`
Expected: PASS（既存の 20 件と足した 12 件。zsh の試験を含めて 15 秒ほどかかる）

Run: `npx vitest run packages/server/src/server.test.ts -t "claude.zsh" && npx vitest run packages/cli/src/shell.test.ts`
Expected: PASS

- [ ] **Step 6: 書き出された本体を目と zsh で確かめる**

worktree の根で打つ（根の package.json が `"type": "module"` なので、`-e` の import が ES モジュールとして通る）。

```bash
d=$(mktemp -d) && node --import tsx -e "import('./packages/server/src/config/shellHook.ts').then((m) => console.log(m.ensureShellScript(process.argv[1], 4321)))" "$d" && sed -n '/^__agent_hangar_ask_status/,/^}/p' "$d/shell/claude.zsh" && zsh -n "$d/shell/claude.zsh" && echo SYNTAX_OK; rm -rf "$d"
```

Expected: 関数の中の理由の 3 行が Step 4 の「書き出された claude.zsh では」の形と一致し、最後に `SYNTAX_OK` が出る。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/config/shellHook.ts packages/server/src/config/shellHook.test.ts packages/server/src/server.ts packages/server/src/server.test.ts
git commit -m "feat(server): ask Done or tomorrow's Paused when leaving a session in claude.zsh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 要約のスキーマと読み取りに状態の提案を足す

**Files:**
- Modify: `packages/server/src/summary/types.ts:1-52`
- Test: `packages/server/src/summary/input.test.ts:58-66`（`describe('types', …)` に 2 件足し、既存の required の期待を直す）
- Test: `packages/server/src/summary/lmstudio.test.ts`（末尾 106 行の `});` の前に 1 件）
- Test: `packages/server/src/summary/claude.test.ts`（末尾 49 行の `});` の前に 1 件）

**Interfaces:**
- Consumes: `STATE_NOTE_MAX`（`@agent-hangar/shared`、200）
- Produces:
  - `type SummaryProposal = { status: 'done' | 'paused'; note: string; returnInDays: number | null }`
  - `SummaryOutput` に `proposal?: SummaryProposal`（none と欠けたものは項目ごと付けない）
  - `PROPOSAL_DAYS_MAX = 14`
  - `SUMMARY_SCHEMA.properties` に `proposed_status`・`proposed_note`・`proposed_return_in_days`、`required` にも 3 つ
  - `SUMMARY_SYSTEM_PROMPT` に判定の仕方の 4 行

スキーマの書き方の決めごと：

- 3 つとも `required` に入れる。LM Studio の strict な json_schema では、任意の項目をモデルが黙って省けるので、判定をさせるには必須にするほうが確かである。`none` があるので、提案しないことも選べる。
- 日数は `{ type: 'integer' }` だけにし、`minimum`・`maximum` は書かない。spike 12 と 13 で通ったのは `type`・`enum`・`maxLength`・`maxItems` だけで、数の範囲の指定が両方の要約器で通るかは確かめていない。範囲は読み取りの側で 1〜14 に収める。
- 読み取り（`parseSummaryOutput`）は 3 つを任意として扱う。古いモデルや、スキーマを守らない応答でも要約は読めるようにする。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/summary/input.test.ts` の 8 行の import を替える。

```ts
import { parseSummaryOutput, SUMMARY_SCHEMA, SUMMARY_SYSTEM_PROMPT } from './types.ts';
```

60 行の `expect(SUMMARY_SCHEMA).toMatchObject(…)` を次に替える。

```ts
    expect(SUMMARY_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['title', 'one_liner', 'body', 'state', 'next_steps', 'proposed_status', 'proposed_note', 'proposed_return_in_days'] });
```

66 行（`describe('types'` の 1 件目の `it` の終わり）の後ろに足す。

```ts
  it('状態の提案は任意で読み、none と欠けたものは付けない', () => {
    expect(SUMMARY_SCHEMA).toMatchObject({ properties: { proposed_status: { type: 'string', enum: ['done', 'paused', 'none'] }, proposed_note: { type: 'string', maxLength: 200 }, proposed_return_in_days: { type: 'integer' } } });
    expect(SUMMARY_SYSTEM_PROMPT).toContain('proposed_status の判定：頼まれたことが終わり、確かめることも残っていなければ done。終わったが確かめることが残っていれば paused。まだ途中なら none。');
    const base = { title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: [] };
    expect(parseSummaryOutput({ ...base, proposed_status: 'done', proposed_note: ' 直した ', proposed_return_in_days: 0 })).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [], proposal: { status: 'done', note: '直した', returnInDays: null } });
    expect(parseSummaryOutput({ ...base, proposed_status: 'none', proposed_note: '', proposed_return_in_days: 0 })).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [] });
    // 項目を返さない古いモデルは、要約だけを読む。
    expect(parseSummaryOutput(base)).toEqual({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [] });
    expect(parseSummaryOutput({ ...base, proposed_status: 'maybe' })?.proposal).toBeUndefined();
  });
  it('paused の日数は 1〜14 に収め、根拠が空なら 1 文の要約で埋め、200 字で切る', () => {
    const p = (o: Record<string, unknown>) => parseSummaryOutput({ title: 'T', one_liner: '1 文', body: 'B', state: 'in_progress', next_steps: [], proposed_status: 'paused', ...o })?.proposal;
    expect(p({ proposed_note: 'n', proposed_return_in_days: 3 })).toEqual({ status: 'paused', note: 'n', returnInDays: 3 });
    expect(p({ proposed_note: 'n', proposed_return_in_days: 0 })?.returnInDays).toBe(1);
    expect(p({ proposed_note: 'n', proposed_return_in_days: 30 })?.returnInDays).toBe(14);
    expect(p({ proposed_note: 'n' })?.returnInDays).toBe(1);
    expect(p({ proposed_note: 'n', proposed_return_in_days: '3' })?.returnInDays).toBe(1);
    expect(p({ proposed_note: 'n', proposed_return_in_days: 2.6 })?.returnInDays).toBe(3);
    expect(p({ proposed_note: '  ', proposed_return_in_days: 2 })?.note).toBe('1 文');
    expect(p({ proposed_note: 'あ'.repeat(250), proposed_return_in_days: 2 })?.note).toBe('あ'.repeat(200));
  });
```

`packages/server/src/summary/lmstudio.test.ts` の末尾の `});`（106 行）の前に足す。

```ts
  it('状態の提案を本文から読んで要約に添え、スキーマにも項目を載せて投げる', async () => {
    let schema: { properties: Record<string, unknown> } | null = null;
    const withProposal = JSON.stringify({ ...JSON.parse(good), proposed_status: 'paused', proposed_note: '本番で確かめる', proposed_return_in_days: 2 });
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) return ok(models);
      schema = JSON.parse(String(init!.body)).response_format.json_schema.schema;
      return ok(completion(withProposal));
    }) as unknown as typeof fetch;
    const out = await new LmStudioSummarizer({ baseUrl: 'http://x', model: 'gemma-4-26b', fetch: fetchFn }).summarize(CANNED_INPUT);
    expect(out.proposal).toEqual({ status: 'paused', note: '本番で確かめる', returnInDays: 2 });
    expect(Object.keys(schema!.properties)).toEqual(expect.arrayContaining(['proposed_status', 'proposed_note', 'proposed_return_in_days']));
  });
```

`packages/server/src/summary/claude.test.ts` の末尾の `});`（49 行）の前に足す。

```ts
  it('structured_output の状態の提案を要約に添え、--json-schema にも項目を載せる', async () => {
    const so = { ...good.structured_output, proposed_status: 'done', proposed_note: '直して main に入れた', proposed_return_in_days: 0 };
    const spawnWith: SpawnText = async () => ({ code: 0, stdout: JSON.stringify({ ...good, structured_output: so }), stderr: '' });
    const spawn = vi.fn(spawnWith);
    const out = await new ClaudeHeadlessSummarizer({ claudeBin: '/c', hourlyCap: 20, usage: () => usage(null), spawn }).summarize(CANNED_INPUT);
    expect(out.proposal).toEqual({ status: 'done', note: '直して main に入れた', returnInDays: null });
    expect(JSON.parse(spawn.mock.calls[0]![1][6]!).required).toEqual(expect.arrayContaining(['proposed_status', 'proposed_note', 'proposed_return_in_days']));
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/summary/input.test.ts packages/server/src/summary/lmstudio.test.ts packages/server/src/summary/claude.test.ts`
Expected: FAIL（required の期待、`proposal` が undefined、スキーマに項目が無い）

- [ ] **Step 3: 型、スキーマ、プロンプト、読み取りを書く**

`packages/server/src/summary/types.ts` を次のように替える。1 行の import、3-5 行の型、18-37 行のスキーマとプロンプト、41-52 行の読み取りが変わる。`Summarizer` と `SummarizerError`（7-16 行）はそのまま残す。

```ts
import { STATE_NOTE_MAX, type SummarizerId, type SummaryState } from '@agent-hangar/shared';

export type SummaryInput = { sessionId: string; text: string; turns: number; running: boolean; titleHint: string | null };
/**
 * 要約が添えるセッションの状態の提案。proposed_status が none か、項目が無いときは付けない。
 * returnInDays は paused のときだけ持ち、1〜14 に収めてある。
 */
export type SummaryProposal = { status: 'done' | 'paused'; note: string; returnInDays: number | null };
/** model は実際に使ったモデルの名前。要約器が入れる（本文の JSON には無い）。 */
export type SummaryOutput = { title: string; oneLiner: string; body: string; state: SummaryState; nextSteps: string[]; proposal?: SummaryProposal; model?: string };
```

```ts
/**
 * フェーズ 0 の spike 12 と 13 で安定した JSON スキーマに、セッションの状態の提案の 3 つを足したもの。
 * 3 つは必須にする。strict な json_schema では任意の項目をモデルが省けるので、判定をさせるには必須のほうが確かである。
 * 日数の範囲（1〜14）はスキーマに書かず、読むときに収める。spike で通したのは type、enum、maxLength、maxItems だけである。
 */
export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 40 },
    one_liner: { type: 'string', maxLength: 80 },
    body: { type: 'string' },
    state: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'abandoned'] },
    next_steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    proposed_status: { type: 'string', enum: ['done', 'paused', 'none'] },
    proposed_note: { type: 'string', maxLength: 200 },
    proposed_return_in_days: { type: 'integer' },
  },
  required: ['title', 'one_liner', 'body', 'state', 'next_steps', 'proposed_status', 'proposed_note', 'proposed_return_in_days'],
};

export const SUMMARY_SYSTEM_PROMPT = [
  '以下はコーディングエージェントのセッションログの抜粋です。日本語で、指定の JSON だけを返してください。',
  'title は名詞句（40 字まで）、one_liner は 1 文（80 字まで）、body は 2〜3 文、next_steps は具体的な行動（5 件まで）。',
  'state の判定：最後の発言がアシスタントの問いかけや確認で終わっていれば in_progress。依頼が果たされていれば done。',
  'エラーや権限や情報の不足で進めなくなっていれば blocked。途中で打ち切られていれば abandoned。',
  '先頭に「このセッションは現在も実行中」とあれば、完了と断定せず in_progress を選ぶ。',
  'proposed_status の判定：頼まれたことが終わり、確かめることも残っていなければ done。終わったが確かめることが残っていれば paused。まだ途中なら none。',
  'proposed_note は判定の根拠を 1 文で（200 字まで）。paused なら何を確かめに戻るかを書く。none なら空文字にする。',
  'proposed_return_in_days は paused のとき戻るまでの日数（1〜14）。paused でなければ 0。',
  '先頭に「このセッションは現在も実行中」とあれば、proposed_status は none を選ぶ。',
].join('\n');
```

```ts
const STATES: SummaryState[] = ['in_progress', 'done', 'blocked', 'abandoned'];

/** paused の提案で戻るまでに置ける日数の上限。 */
export const PROPOSAL_DAYS_MAX = 14;

/**
 * 状態の提案を読む。done と paused のほかは提案なしとする。
 * 根拠が空なら 1 文の要約で埋め、200 字で切る。提案の根拠は 1 字以上が要るためである。
 * paused の日数は整数に丸めて 1〜14 に収め、数でなければ 1（明日）にする。
 */
function parseProposal(o: Record<string, unknown>, oneLiner: string): SummaryProposal | null {
  const status = o.proposed_status;
  if (status !== 'done' && status !== 'paused') return null;
  const raw = typeof o.proposed_note === 'string' ? o.proposed_note.trim() : '';
  const note = [...(raw || oneLiner)].slice(0, STATE_NOTE_MAX).join('');
  if (status === 'done') return { status, note, returnInDays: null };
  const n = typeof o.proposed_return_in_days === 'number' && Number.isFinite(o.proposed_return_in_days) ? Math.round(o.proposed_return_in_days) : 1;
  return { status, note, returnInDays: Math.min(PROPOSAL_DAYS_MAX, Math.max(1, n)) };
}

/**
 * スキーマの形を満たす値だけを SummaryOutput に直す。title か one_liner が空なら null。
 * 状態の提案の 3 つは任意として読む。無いか none なら proposal の項目を付けない。
 */
export function parseSummaryOutput(v: unknown): SummaryOutput | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const oneLiner = typeof o.one_liner === 'string' ? o.one_liner.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  const state = typeof o.state === 'string' && STATES.includes(o.state as SummaryState) ? (o.state as SummaryState) : null;
  if (!title || !oneLiner || !state) return null;
  const nextSteps = Array.isArray(o.next_steps) ? o.next_steps.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  const proposal = parseProposal(o, oneLiner);
  return { title, oneLiner, body, state, nextSteps, ...(proposal ? { proposal } : {}) };
}
```

`summary/lmstudio.ts:78-82` と `summary/claude.ts:74-76` は `parseSummaryOutput` の結果を `{ ...out, model }` で返すので、`proposal` はそのまま通る。2 つのファイルは変えない。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/summary`
Expected: PASS（`job.test.ts` を含めて全件。`job.test.ts` の偽の要約器は `proposal` を返さないので、振る舞いは変わらない）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/summary/types.ts packages/server/src/summary/input.test.ts packages/server/src/summary/lmstudio.test.ts packages/server/src/summary/claude.test.ts
git commit -m "feat(server): let the post-hoc summary propose a session status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 事後の要約の提案を候補として書く

**Files:**
- Modify: `packages/server/src/summary/job.ts:1-6`（import）と `:132-152`（`summarizeOne`、その前に 1 つ足す）
- Test: `packages/server/src/summary/job.test.ts`（1-9 行の import、末尾 135 行の後ろに `describe` を 1 つ）

**Interfaces:**
- Consumes（Task 4）: `SummaryOutput.proposal?: SummaryProposal`
- Consumes（第 1 段）:
  - `getSessionState(db, sessionId): SessionStateDto | null`
  - `proposeSessionState(db, deviceId, sessionId, { status: 'paused' | 'done'; note: string; returnOn: string | null; source: CandidateSource; now?: number })`
  - `StateInputError`
  - `localDate(now: number): string`、`addDays(date: string, n: number): string`（`@agent-hangar/shared`）
- Produces: なし（`SummaryJob` の公開の形は変えない）

書く条件の決めごと：

- 書くのは、状態も提案も無いときだけである。却下済み（`rejected_at` が null でない）は、第 1 段の `proposeSessionState` が `rejected_before` で断り、何も書かない。`rejected_at` は DTO に載らないので、ここでは読まない。
- 「セッションが止まっている」は、書く直前に `isLive` で見直す。`input.running` は要約を始めたときの値で、run の終了直後は 500 ミリ秒周期のキャッシュのせいで「生きている」と出ることがある（`enqueue` の `ignoreLive` の注記）。要約には数秒〜40 秒かかるので、書く直前のほうが確かである。
- 戻る日は、書く時点の手元の暦の日付に日数を足す（`addDays(localDate(now), n)`）。
- 提案の検査で落ちても（`StateInputError`）、要約は失敗にしない。1 行だけ記録して進める。
- `session.upsert` は今の 1 回のままにし、提案を書いてから配る。画面は要約と提案を同じ 1 回で受け取る。

- [ ] **Step 1: 落ちる試験を書く**

`packages/server/src/summary/job.test.ts` の import に足す。

```ts
import { getSessionState, proposeSessionState, rejectSessionState, setSessionState } from '../sessions/states.ts';
```

9 行の `./types.ts` の import に `type SummaryProposal` を足す。

```ts
import { SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput, type SummaryProposal } from './types.ts';
```

末尾（135 行の後ろ）に足す。

```ts
describe('事後の要約からの状態の提案', () => {
  // 手元の暦で 10 月 1 日の 23 時 30 分。日をまたぐ直前でも、戻る日は書いた日から数える。
  const NOW = new Date(2026, 9, 1, 23, 30).getTime();
  const proposing = (proposal?: SummaryProposal): Summarizer => ({ id: 'lmstudio', available: async () => true, summarize: async () => (proposal ? { ...out, proposal } : out) });
  const runWith = async (s: Summarizer, live: LiveSessionDto[] = []) => {
    const job = new SummaryJob({ db, deviceId: 'd', summarizers: () => [s], live: () => live, hub: { broadcast: (e) => sent.push(e) }, now: () => NOW });
    expect(job.enqueue(alphaId, true)).toBe(true);
    await job.idle();
  };

  it('done の提案を post_hoc の候補として書き、要約と同じ 1 回の session.upsert に載せる', async () => {
    await runWith(proposing({ status: 'done', note: '直して main に入れた', returnInDays: null }));
    expect(getSessionState(db, alphaId)?.candidate).toEqual({ status: 'done', note: '直して main に入れた', returnOn: null, source: 'post_hoc', at: NOW });
    const upserts = sent.filter((e) => e.type === 'session.upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.type === 'session.upsert' && upserts[0]!.session.state?.candidate?.status).toBe('done');
    expect(sent.map((e) => e.type)).toEqual(['summary.pending', 'session.upsert', 'summary.updated']);
  });
  it('paused の戻る日は、書いたときの手元の暦から数える', async () => {
    await runWith(proposing({ status: 'paused', note: '本番で確かめる', returnInDays: 3 }));
    expect(getSessionState(db, alphaId)?.candidate).toMatchObject({ status: 'paused', note: '本番で確かめる', returnOn: '2026-10-04', source: 'post_hoc' });
  });
  it('状態がもう付いていれば書かない', async () => {
    setSessionState(db, 'd', alphaId, { status: 'done', setBy: 'user', now: NOW - 1000 });
    await runWith(proposing({ status: 'paused', note: '本番で確かめる', returnInDays: 1 }));
    expect(getSessionState(db, alphaId)).toMatchObject({ status: 'done', candidate: null });
  });
  it('会話の提案がもうあれば上書きしない', async () => {
    proposeSessionState(db, 'd', alphaId, { status: 'paused', note: '会話の提案', returnOn: '2026-10-05', source: 'in_session', now: NOW - 1000 });
    await runWith(proposing({ status: 'done', note: '直した', returnInDays: null }));
    expect(getSessionState(db, alphaId)?.candidate).toMatchObject({ status: 'paused', note: '会話の提案', source: 'in_session' });
  });
  it('却下した後は書かない', async () => {
    proposeSessionState(db, 'd', alphaId, { status: 'done', note: '直した', returnOn: null, source: 'in_session', now: NOW - 2000 });
    rejectSessionState(db, 'd', alphaId, NOW - 1000);
    await runWith(proposing({ status: 'done', note: '直した', returnInDays: null }));
    expect(getSessionState(db, alphaId)?.candidate ?? null).toBeNull();
  });
  it('動いているセッションには書かない', async () => {
    const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'idle', name: null, nameSource: null, cwd: '/x', pid: 1 }];
    await runWith(proposing({ status: 'done', note: '直した', returnInDays: null }), live);
    expect(getSessionState(db, alphaId)?.candidate ?? null).toBeNull();
    expect((db.prepare('select source from session_summaries where session_id = ?').get(alphaId) as { source: string }).source).toBe('post_hoc');
  });
  it('提案を返さない古いモデルでは、要約だけを書く', async () => {
    await runWith(proposing(undefined));
    expect(getSessionState(db, alphaId)?.candidate ?? null).toBeNull();
    expect((db.prepare('select title from session_summaries where session_id = ?').get(alphaId) as { title: string }).title).toBe('T');
  });
  it('提案が検査で落ちても、要約は失敗にしない', async () => {
    // 読み取りを通らない偽物で、根拠が空の提案を直接渡す。proposeSessionState は StateInputError を投げる。
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runWith(proposing({ status: 'done', note: '', returnInDays: null }));
    expect(sent.some((e) => e.type === 'summary.failed')).toBe(false);
    expect(sent.at(-1)).toEqual({ type: 'summary.updated', sessionId: alphaId });
    expect(getSessionState(db, alphaId)?.candidate ?? null).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/summary/job.test.ts -t "事後の要約からの状態の提案"`
Expected: FAIL（1 件目と 2 件目で candidate が null。残りは書かないことを見るので通るものがある）

- [ ] **Step 3: 提案を書く**

`packages/server/src/summary/job.ts` の 1 行と 6 行の import を替え、1 行を足す。

```ts
import { addDays, localDate, type LiveSessionDto, type ServerEvent, type SummarizerTestDto } from '@agent-hangar/shared';
```

```ts
import { getSessionState, proposeSessionState, StateInputError } from '../sessions/states.ts';
```

```ts
import type { Summarizer, SummaryInput, SummaryOutput, SummaryProposal } from './types.ts';
```

132 行（`private async summarizeOne`）の前に足す。

```ts
  /**
   * 要約が添えた状態の提案を、セッションの候補として書く。
   * 書くのは、状態も提案も無いときだけである。却下済みは proposeSessionState が rejected_before で断る。
   * 動いているセッションには書かない。止まっているかは書く直前に見直す。
   * run を止めた直後は生存のキャッシュが「生きている」と出るが、要約には数秒以上かかるので、書くころには落ち着いている。
   * 戻る日は書くときの手元の暦から数える。
   * 提案の検査で落ちても要約は失敗にしない。要約が本筋で、提案は添え物だからである。
   */
  private proposeFrom(sessionId: string, p: SummaryProposal | undefined): void {
    if (!p || this.isLive(sessionId)) return;
    const cur = getSessionState(this.deps.db, sessionId);
    if (cur && (cur.status !== null || cur.candidate !== null)) return;
    const now = this.now();
    try {
      proposeSessionState(this.deps.db, this.deps.deviceId, sessionId, {
        status: p.status,
        note: p.note,
        returnOn: p.status === 'paused' ? addDays(localDate(now), p.returnInDays ?? 1) : null,
        source: 'post_hoc',
        now,
      });
    } catch (e) {
      if (!(e instanceof StateInputError)) throw e;
      console.error(`[summary] 状態の提案を書けませんでした: ${e.message}`);
    }
  }
```

`summarizeOne` の upsert（137-148 行）の直後、149 行の `const s = getSession(…)` の前に 1 行を足す。

```ts
    this.proposeFrom(sessionId, r.out.proposal);
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/summary`
Expected: PASS（足した 8 件と既存の全件）

Run: `npm run typecheck`
Expected: エラー 0 件

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/summary/job.ts packages/server/src/summary/job.test.ts
git commit -m "feat(server): write the post-hoc proposal as a session candidate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 設計書、全体の確認とビルド、実物での確認

**Files:**
- Modify: `docs/design.md:679-700`（指示の注入）、`:734-746`（セッション要約）、`:1555-1567`（外のターミナルのセッション）

**Interfaces:**
- Consumes: Task 1〜5 のすべて
- Produces: なし

- [ ] **Step 1: 設計書を書き足す**

`docs/design.md` の「指示の注入」のコードブロック（685-699 行）で、`完了にするのは利用者です。確かめられていないものは出さないでください。` の行の後ろに、Task 1 の 3 行をそのまま足す。
コードブロックの後ろ（701 行の「モデルにセッション ID を扱わせる必要はない。」の後ろ）に次の段落を足す。

```
状態の問いは、依頼を終えた区切りでだけ AskUserQuestion で聞かせる。利用者が選んだものは `propose_session_status` の `confirmed: true` でそのまま状態になり、答えずに進めたものは候補として残る。
この指示は hangar が `--append-system-prompt` で起こす会話にしか渡らない。`claude attach` で開く会話（attach、バックグラウンドのセッションの再開）と claude.zsh で起こした会話には渡らないので、そちらは claude.zsh の問いと事後の要約で拾う。
```

「セッション要約」の、「事後生成」の箇条（747 行）の後ろに次の段落を足す。

```
事後生成のスキーマは、要約に加えてセッションの状態の提案（`proposed_status` が done・paused・none、`proposed_note`、`proposed_return_in_days` が paused のとき 1〜14）を返させる。
提案は、要約を書いた直後に、状態も提案も無く、却下もされておらず、セッションが止まっているときだけ `source = 'post_hoc'` の候補として書く。戻る日は書いたときの手元の暦から数える。
読み取りは提案の 3 つを任意として扱い、返さないモデルでも要約は従来どおり書く。
```

「外のターミナルのセッション」の「包み方」の箇条（1564-1566 行）の後ろに、同じ字下げで次の箇条を足す。

```
  本文のある会話を抜けたとき、hangar が同じセッションを開いていなければ、止めるかどうかの問いの後に「このセッションをどうしますか？ [d] Done  [p] 明日の Paused  [Enter] そのまま」を 1 打鍵で聞く。サーバに提案があれば、問いの頭に「Claude の提案：Done（根拠）」の形で出す。
  問いの中身は `GET /api/sessions/by-provider/:providerSessionId/exit-prompt`（行で区切った text）で引き、答えは `POST /api/sessions/by-provider/:providerSessionId/state` に送る。どちらも Claude 側の id で引き、MCP からは呼べない。
  送り先のポートは、本体を書き出すときのサーバのポートを埋め込む。鍵は `statusline-header` を `curl -H @<ファイル>` で読ませ、argv に載せない。
  鍵のファイルが無い、サーバが 1 秒で返らない、索引にまだ無い、状態がもう付いている、のどれかなら問わない。送れなかったときは「hangar に届きませんでした」を 1 行出し、後始末は続ける。
```

- [ ] **Step 2: 全体の試験と型**

Run: `npm test && npm run typecheck`
Expected: 全件 PASS、型の誤り 0 件（落ちたら、その出力をそのまま添えて直す）

- [ ] **Step 3: ビルド**

利用者の決まり（メモリの「Always build before returning」）に従い、UI の vite と、デスクトップの bundle-server と tauri build を通す。

```bash
npm run build
npm run bundle-server -w apps/desktop
npm run tauri -w apps/desktop -- build
```

Expected: 3 つとも成功する（`npm run build` は `packages/ui` の `vite build` を走らせる）。

ビルドはインストールではない。`/Applications` の入れ替えは main へ入れた後に利用者が行うので、この段では触らない。
ビルドした `.app` を開くと、本物の `~/.agent-hangar` の DB にマイグレーションが走り、`~/.agent-hangar/shell/claude.zsh` も新しい中身に書き換わる。開くのは利用者の承認を得てからにする。
`.app` は 4177 にサーバがいればそれを使うので、`.app` で確かめるときは利用者の `npm run dev`（4177）を一度落とす必要がある。次の手順を守る。

1. 利用者に、4177 の dev サーバを一度落としてよいかを尋ね、承認を待つ。
2. 承認を得たら、`ps -ax -o pid,ppid,command | grep -E 'tsx (watch )?src/main.ts' | grep -v grep` で PID と起動元（元の checkout の `packages/server`）を確かめ、その PID にだけ `kill <PID>` を送る。
3. ポートで探して止めない（`lsof -ti:4177 | xargs kill` のような止め方は禁止）。止めるのは確かめた PID だけである。
4. 確かめ終えたら、利用者に dev サーバを起こし直してもらう（利用者が自分で `npm run dev` を動かしている）。

- [ ] **Step 4: 実物で確かめる（hangar から起動したセッション）**

本物の `~/.agent-hangar` を使わず、一時の置き場と別のポートで worktree のサーバを起こす。`~/.claude` は読むだけで、書かない。
同期は `cloud.json` の無い置き場なので切れたままで、D1 と R2 には何も送らない。
ここから Step 6 までは、worktree の根の同じシェルで続けて打つ（`VH` と `states` を使い回す）。

```bash
VH=/private/tmp/claude-501/-Users-me-workspace-agent-hangar/972fecb8-9250-4213-9848-91c1df85b843/scratchpad/verify-home
mkdir -p "$VH"
HANGAR_HOME="$VH" HANGAR_PORT=4199 nohup node --import tsx packages/server/src/main.ts > "$VH/server.log" 2>&1 &
echo $! > "$VH/server.pid"
until curl -sf http://127.0.0.1:4199/health >/dev/null; do sleep 1; done; grep listening "$VH/server.log"
```

Expected: `agent-hangar listening on http://127.0.0.1:4199` が出る。`grep __agent_hangar_port= "$VH/shell/claude.zsh"` が `__agent_hangar_port=4199` を返す。

状態を見る手立て（鍵はファイルから読ませ、画面や記録に出さない）。

```bash
states() { curl -s -H @"$VH/statusline-header" http://127.0.0.1:4199/api/sessions | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{for(const x of JSON.parse(s).filter((x)=>x.state&&(x.state.status||x.state.candidate)).slice(0,5))console.log(x.providerSessionId,JSON.stringify(x.state))})'; }
```

1. `open "http://127.0.0.1:4199/?t=$(cat "$VH/token")"` で画面を開き、新規セッションの「すぐ始める」（スクラッチ）から起動する。
2. 「このフォルダの名前を 1 行で答えて」と頼む。答えのターンの終わりに、AskUserQuestion で「このセッションをどうしますか」が出て、選択肢が「Done にする」「Paused · <日>（…）」「まだ続ける」の 3 つであることを確かめる。
3. 「Done にする」を選ぶ。`states` で、そのセッションが `"status":"done"` と `"setBy":"conversation"` を持つことを確かめる。
4. もう 1 本起動し、同じく頼む。問いが出たら答えずに「README があれば 1 行目を教えて」と打って次の指示へ進む。Claude が `propose_session_status` を `confirmed` なしで呼んだ後、`states` で `"candidate":{"status":…,"source":"in_session",…}` が残っていることを確かめる。画面の行に提案の札（紫の枠）が出ることも見る。
5. どちらかで問いが出なければ、その会話の transcript で `propose_session_status` と AskUserQuestion が呼ばれたかを確かめ、結果を報告する（注入の文言を直す前に、利用者に見せる）。

- [ ] **Step 5: 実物で確かめる（claude.zsh で抜けるとき）**

tmux の上の zsh に、一時の置き場の claude.zsh を読ませて確かめる。利用者のターミナルと `~/.zshrc` には触らない。tmux のセッション名は hangar の `hangar-*` と重ならない名前にする。

```bash
tmux new-session -d -s verify-zsh-status -x 200 -y 50 -c /Users/me/workspace/agent-hangar/.claude/worktrees/session-status 'zsh -f'
tmux send-keys -t verify-zsh-status "source '$VH/shell/claude.zsh'; claude" Enter
```

1. Claude の画面が出たら `tmux send-keys -t verify-zsh-status 'このフォルダの名前を 1 行で答えて' Enter` を送り、答えが出るまで待つ（`tmux capture-pane -p -t verify-zsh-status` で見る）。
2. Claude Code の画面を閉じるいつもの操作（Ctrl-C を 2 回、`tmux send-keys -t verify-zsh-status C-c C-c`）で attach から抜ける。
3. `capture-pane` で「このセッションをどうしますか？ [d] Done  [p] 明日の Paused  [Enter] そのまま」が出ていることを確かめ、`tmux send-keys -t verify-zsh-status p` を送る。
4. 「<明日の日付> に戻る Paused にしました。」が出て、`states` でそのセッションが `"status":"paused"`、`"returnOn":"<明日>"`、`"setBy":"user"` を持つことを確かめる。
5. 問いが出なければ、抜ける操作でセッションそのものが止まっていないか（`claude agents --json` に pid があるか）を確かめる。止まっていれば `__agent_hangar_leave` は状態を引けずに何もしないので、その結果を報告する（設計を変える前に利用者に見せる）。
6. LM Studio が動いていれば、事後の要約の提案も見る。本文があり、止まっていて、状態も提案も無いセッションを 1 つ選び、要約を頼む。

   ```bash
   SID=$(curl -s -H @"$VH/statusline-header" http://127.0.0.1:4199/api/sessions | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const x=JSON.parse(s).find((x)=>x.hasTranscript&&!x.live&&!(x.state&&(x.state.status||x.state.candidate)));console.log(x?x.id:"")})')
   curl -s -X POST -H @"$VH/statusline-header" "http://127.0.0.1:4199/api/sessions/$SID/summarize"
   sleep 30; curl -s -H @"$VH/statusline-header" "http://127.0.0.1:4199/api/sessions/$SID" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const x=JSON.parse(s);console.log(x.summary&&x.summary.source,JSON.stringify(x.state))})'
   ```

   Expected: 1 行目は `{"accepted":true}`。最後は `post_hoc` と、`"source":"post_hoc"` の候補か `null`（要約器が none を選んだとき）。none なら、そのことを結果に書く。

- [ ] **Step 6: 後片付け**

```bash
tmux kill-session -t verify-zsh-status
kill "$(cat "$VH/server.pid")" && sleep 2 && ps -p "$(cat "$VH/server.pid")" || echo stopped
```

Expected: `stopped`。止めるのは自分が起こした PID だけである。
確かめのために作ったセッション（3 本）は `~/.claude` に残る。消さずに、利用者に「hangar の画面で Archived にできる」と伝える。

- [ ] **Step 7: Commit**

```bash
git add docs/design.md
git commit -m "docs: describe the three entry points for session status proposals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
