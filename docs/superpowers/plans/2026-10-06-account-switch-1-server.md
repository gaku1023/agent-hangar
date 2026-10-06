# アカウントの切り替え 1：サーバと契約 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hangar のサーバにアカウント（設定の置き場）の登録・リンク・起動時の切り替え・アカウント別の使用量を入れ、画面が使う HTTP とイベントの形を決める。

**Architecture:** アカウントは `~/.agent-hangar/accounts.json` に持つ（`AccountStore`）。2 つ目以降の置き場は、中身を最初の置き場へのシンボリックリンクにする（`ensureAccountLinks`）。`RunManager` は起動のたびにアカウントを解いて `CLAUDE_CONFIG_DIR` を tmux の環境に足し、run の `launch_params.account` に残す。使用量は `UsageTracker` がアカウントごとに持ち、statusline の `session_id` から run を引いて振り分ける。認証は `claude auth status` と `claude auth login` を子プロセスで呼ぶだけで、hangar はトークンに触れない。

**Tech Stack:** TypeScript、Hono、better-sqlite3、vitest 5、tmux（試験は専用のソケット）。

**Spec:** `docs/superpowers/specs/2026-10-06-account-switch-design.md`（試作は同じ階層の `2026-10-06-account-switch/`）

この計画はサーバと契約までである。画面（ヘッダの切り替え、ダイアログの札、セッション画面の札、設定の節）は、この計画が入ったあとに `2026-10-06-account-switch-2-screens.md` として書く。この計画だけでも、HTTP を叩けばアカウントの追加・切り替え・起動ができる。

## Global Constraints

- 文言は日本語。
- hangar はトークンを読まない、保存しない、ログにも応答にも出さない。Keychain と `.credentials.json` を開くコードを書かない。認証について hangar が知るのは `claude auth status --json` の出力だけである。
- 上限に当たったときに自動でアカウントを切り替えるコードを書かない。
- 最初のアカウントの id は `primary`、置き場は起動時に決まる `claudeDir`。最初のアカウントで起こすときは `CLAUDE_CONFIG_DIR` を足さない（今までと同じ動きを保つ）。
- リンクにする項目は次の 17 個で、順もこのとおり：`CLAUDE.md`、`settings.json`、`statusline-command.sh`、`history.jsonl`、`commands`、`skills`、`plugins`、`memory`、`projects`、`file-history`、`paste-cache`、`plans`、`tasks`、`session-env`、`shell-snapshots`、`sessions`、`jobs`。
- リンクの場所に実ファイルや別の先を指すリンクがあったら、消さずに起動を止めて伝える。
- 共有テーブル（`sessions`、`runs`）に列を足さない。アカウントは `runs.launch_params` の JSON に入れる。
- 試験は実物の `~/.claude`、`~/.claude-univ`、`~/.agent-hangar`、実物の Keychain、実物の `claude` に触らない。置き場は `fs.mkdtempSync`、claude は `packages/server/test/fake-claude.ts`、tmux は `packages/server/test/tmux.ts` の専用ソケットを使う。
- `tmux kill-server` を素で呼ばない。試験の後始末は既存の `tmux?.killServer()`（専用ソケットの `Tmux`）だけを使う。
- コミットは `git commit <path>...` のパス指定形で行い、`--amend` と rebase は使わない。末尾は `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 試験のメールアドレスは `taro@example.co.jp` と `taro@example.ac.jp` だけを使う。

## Review Focus

1. **利用者が自分で `CLAUDE_CONFIG_DIR` を付けてターミナルから起こした** → その値をそのまま渡す。登録済みの置き場ならそのアカウントとして記録し、未登録なら記録しない（いまのアカウントで上書きしない）。Task 4 で試験を足す。
2. **リンクの場所に実ファイルがある（Claude Code がリンクを置き換えた、利用者が手で置いた）** → 起動を 400 で断り、どの項目かを文言に入れる。ファイルは消さない。Task 2 と Task 4 で試験を足す。
3. **`accounts.json` が壊れている、または消したアカウントの id が run や `currentId` に残っている** → 最初のアカウントに落とす。サーバは起動する。Task 1 と Task 4 で試験を足す。
4. **作業中のセッションをアカウントの切り替えで再開し直す** → 元の run を `killed` で閉じ、レジストリから消えるのを待ってから起こす。待ちきれなければ 409 で断り、元の run は閉じたままにする（二重起動より安全）。Task 5 で試験を足す。
5. **`claude auth status` が失敗する（claude が無い、時間切れ、JSON でない）** → そのアカウントの `auth` を null にし、ほかのアカウントと一覧の応答は返す。Task 3 で試験を足す。

---

### Task 0: 土台を確かめる

**Files:** なし

worktree は `/Users/satog/workspace/agent-hangar/.claude/worktrees/account-switch`（ブランチ `worktree-account-switch`）にもうある。以降のコマンドはすべてここで走らせる。

- [ ] **Step 1: 依存を入れる**

Run: `npm ci 2>&1 | tail -3`
Expected: エラーなしで終わる。

- [ ] **Step 2: 土台の試験と型検査が緑であることを確かめる**

Run: `npx vitest run packages/server packages/shared 2>&1 | tail -6 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS、型検査はエラーなし。落ちる試験があれば、名前を控えて既存の不具合として報告し、進む。

---

### Task 1: 契約の型と AccountStore

**Files:**
- Modify: `packages/shared/src/api.ts`（`UsageDto` の定義の後ろに追加、`BootstrapDto` に 1 項目）
- Modify: `packages/shared/src/intent.ts:23`（`LaunchParams`）
- Modify: `packages/shared/src/events.ts`（`usage.update` の行の後ろに 1 行）
- Create: `packages/server/src/config/accounts.ts`
- Test: `packages/server/src/config/accounts.test.ts`

**Interfaces:**
- Produces（shared）:
  - `AccountAuthDto = { loggedIn: boolean; email: string | null; plan: string | null; orgName: string | null; checkedAt: number }`
  - `AccountDto = { id: string; name: string; dir: string; color: string; primary: boolean; auth: AccountAuthDto | null; usage: UsageDto; loginRunning: boolean; linkProblem: string | null }`
  - `AccountsDto = { currentId: string; accounts: AccountDto[]; sessions: Record<string, string> }`（`sessions` は、最初のアカウント以外で最後に動かしたセッションの id → アカウントの id）
  - `LaunchParams.account?: string`
  - `BootstrapDto.accounts?: AccountsDto`
  - イベント `{ type: 'accounts.update'; accounts: AccountsDto }`
- Produces（server）:
  - `PRIMARY_ACCOUNT_ID = 'primary'`
  - `type Account = { id: string; name: string; dir: string; color: string }`
  - `class AccountStore`：`constructor(o: { home: string; primaryDir: string; homeDir?: string })`、`list(): Account[]`、`get(id: string): Account | null`、`primary(): Account`、`current(): Account`、`setCurrent(id: string): void`、`add(input: { name: string; dir?: string }): Account`、`update(id: string, patch: { name?: string; color?: string }): Account`、`remove(id: string): void`、`byDir(dir: string): Account | null`
  - `class AccountError extends Error`（`status: 400 | 404`）

- [ ] **Step 1: shared の型を足す**

`packages/shared/src/api.ts` の `export type UsageDto = ...` の行の直後に足す。

```ts
/** `claude auth status --json` から読んだもの。hangar が認証について知るのはこれだけで、トークンは含まない。 */
export type AccountAuthDto = { loggedIn: boolean; email: string | null; plan: string | null; orgName: string | null; checkedAt: number };
/**
 * Claude Code のアカウント。置き場（CLAUDE_CONFIG_DIR）と 1 対 1 で、この PC の中だけにある。
 * primary は最初のアカウント（既定の置き場）で、消せない。
 * linkProblem は置き場のリンクが壊れている理由で、起動できるときは null。
 */
export type AccountDto = { id: string; name: string; dir: string; color: string; primary: boolean; auth: AccountAuthDto | null; usage: UsageDto; loginRunning: boolean; linkProblem: string | null };
/** sessions は、最初のアカウント以外で最後に動かしたセッションだけを載せる（セッションの id → アカウントの id）。載っていないものは最初のアカウントである。 */
export type AccountsDto = { currentId: string; accounts: AccountDto[]; sessions: Record<string, string> };
```

同じファイルの `BootstrapDto` の末尾の `cloudUsage?: CloudUsageDto | null` の後ろに `; accounts?: AccountsDto` を足す。

`packages/shared/src/intent.ts:23` の `LaunchParams` の末尾に `; account?: string` を足す。

`packages/shared/src/events.ts` の `| { type: 'usage.update'; usage: UsageDto }` の次の行に足し、import に `AccountsDto` を加える。

```ts
  | { type: 'accounts.update'; accounts: AccountsDto }
```

- [ ] **Step 2: 失敗する試験を書く**

`packages/server/src/config/accounts.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountError, AccountStore, PRIMARY_ACCOUNT_ID } from './accounts.ts';

let home: string;
let homeDir: string;
let primaryDir: string;
const make = () => new AccountStore({ home, primaryDir, homeDir });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-acct-home-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-acct-user-'));
  primaryDir = path.join(homeDir, '.claude');
  fs.mkdirSync(primaryDir);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('AccountStore', () => {
  it('ファイルが無ければ、最初のアカウントだけがあり、それがいまのアカウント', () => {
    const s = make();
    expect(s.list().map((a) => [a.id, a.dir])).toEqual([[PRIMARY_ACCOUNT_ID, primaryDir]]);
    expect(s.current().id).toBe(PRIMARY_ACCOUNT_ID);
    expect(fs.existsSync(path.join(home, 'accounts.json'))).toBe(false);
  });

  it('追加すると ~/.claude-2 から空いている連番の置き場を割り当て、色は使っていないものを選び、0600 で保存する', () => {
    fs.mkdirSync(path.join(homeDir, '.claude-2'));
    const s = make();
    const a = s.add({ name: '大学' });
    expect(a.dir).toBe(path.join(homeDir, '.claude-3'));
    expect(a.color).not.toBe(s.primary().color);
    expect(fs.statSync(path.join(home, 'accounts.json')).mode & 0o777).toBe(0o600);
    expect(make().list().map((x) => x.name)).toEqual([s.primary().name, '大学']);
  });

  it('既にある置き場を名指しで登録できる。相対パス、最初の置き場、登録済みの置き場は断る', () => {
    const s = make();
    const dir = path.join(homeDir, '.claude-univ');
    expect(s.add({ name: '大学', dir }).dir).toBe(dir);
    expect(() => s.add({ name: 'x', dir: 'relative' })).toThrow(AccountError);
    expect(() => s.add({ name: 'y', dir: primaryDir })).toThrow(AccountError);
    expect(() => s.add({ name: 'z', dir: dir + '/' })).toThrow(AccountError);
  });

  it('名前は前後の空白を落とし、空・41 字以上・重複を断る', () => {
    const s = make();
    expect(s.add({ name: '  大学  ' }).name).toBe('大学');
    expect(() => s.add({ name: '   ' })).toThrow(AccountError);
    expect(() => s.add({ name: 'あ'.repeat(41) })).toThrow(AccountError);
    expect(() => s.add({ name: '大学' })).toThrow(AccountError);
  });

  it('いまのアカウントを変えて覚える。知らない id は 404', () => {
    const s = make();
    const a = s.add({ name: '大学' });
    s.setCurrent(a.id);
    expect(make().current().id).toBe(a.id);
    expect(() => s.setCurrent('nope')).toThrow(AccountError);
  });

  it('消すと、いまのアカウントだったときは最初のアカウントに戻る。置き場は消さない。最初のアカウントは消せない', () => {
    const s = make();
    const a = s.add({ name: '大学' });
    fs.mkdirSync(a.dir);
    s.setCurrent(a.id);
    s.remove(a.id);
    expect(s.current().id).toBe(PRIMARY_ACCOUNT_ID);
    expect(fs.existsSync(a.dir)).toBe(true);
    expect(() => s.remove(PRIMARY_ACCOUNT_ID)).toThrow(AccountError);
  });

  it('壊れたファイルと、消えた id を指す currentId は、最初のアカウントに落とす', () => {
    fs.writeFileSync(path.join(home, 'accounts.json'), '{ not json');
    expect(make().current().id).toBe(PRIMARY_ACCOUNT_ID);
    fs.writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ currentId: 'gone', accounts: [{ id: 'a1', name: '大学', dir: path.join(homeDir, '.claude-2'), color: '#7a4a9e' }, { id: 5 }] }));
    const s = make();
    expect(s.current().id).toBe(PRIMARY_ACCOUNT_ID);
    expect(s.list().map((a) => a.id)).toEqual([PRIMARY_ACCOUNT_ID, 'a1']);
  });

  it('置き場からアカウントを引く。末尾の / と . は無視する', () => {
    const s = make();
    const a = s.add({ name: '大学' });
    expect(s.byDir(a.dir + '/')?.id).toBe(a.id);
    expect(s.byDir(path.join(primaryDir, '.'))?.id).toBe(PRIMARY_ACCOUNT_ID);
    expect(s.byDir('/nowhere')).toBeNull();
  });

  it('名前と色を変えられる。最初のアカウントの名前も変えられる', () => {
    const s = make();
    expect(s.update(PRIMARY_ACCOUNT_ID, { name: '会社' }).name).toBe('会社');
    expect(make().primary().name).toBe('会社');
    expect(() => s.update(PRIMARY_ACCOUNT_ID, { color: 'red' })).toThrow(AccountError);
  });
});
```

- [ ] **Step 3: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/accounts.test.ts 2>&1 | tail -5`
Expected: FAIL（`./accounts.ts` が無い）。

- [ ] **Step 4: 実装する**

`packages/server/src/config/accounts.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@agent-hangar/shared';

/** 最初のアカウント（既定の置き場）の id。消せない。 */
export const PRIMARY_ACCOUNT_ID = 'primary';
/** 色の候補。追加のたびに、まだ使っていないものを前から選ぶ。 */
export const ACCOUNT_COLORS = ['#2a57b8', '#7a4a9e', '#2b7048', '#c77a1a', '#a2452f'] as const;
const NAME_MAX = 40;
const COLOR = /^#[0-9a-f]{6}$/;

export type Account = { id: string; name: string; dir: string; color: string };
type FileShape = { currentId: string; primary: { name: string; color: string }; accounts: Account[] };

export class AccountError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}

const isAccount = (v: unknown): v is Account => {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.id === 'string' && a.id !== PRIMARY_ACCOUNT_ID && typeof a.name === 'string' && typeof a.dir === 'string' && path.isAbsolute(a.dir) && typeof a.color === 'string';
};

/**
 * Claude Code のアカウントの一覧と、いまのアカウント。
 * この PC の中だけの設定なので、hangar.db（同期する）ではなく <home>/accounts.json に持つ。
 * 認証の中身は持たない。持つのは名前、置き場、色だけである。
 */
export class AccountStore {
  private state: FileShape;
  private readonly file: string;
  private readonly homeDir: string;

  constructor(private readonly o: { home: string; primaryDir: string; homeDir?: string }) {
    this.file = path.join(o.home, 'accounts.json');
    this.homeDir = o.homeDir ?? os.homedir();
    this.state = this.load();
  }

  /** 読めないファイルや形の違う項目は捨て、最初のアカウントだけの状態に落とす。サーバの起動は止めない。 */
  private load(): FileShape {
    const empty: FileShape = { currentId: PRIMARY_ACCOUNT_ID, primary: { name: 'メイン', color: ACCOUNT_COLORS[0] }, accounts: [] };
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return empty; }
    if (typeof raw !== 'object' || raw === null) return empty;
    const r = raw as Record<string, unknown>;
    const accounts = Array.isArray(r.accounts) ? r.accounts.filter(isAccount) : [];
    const p = (typeof r.primary === 'object' && r.primary !== null ? r.primary : {}) as Record<string, unknown>;
    const primary = { name: typeof p.name === 'string' && p.name.trim() ? p.name : empty.primary.name, color: typeof p.color === 'string' && COLOR.test(p.color) ? p.color : empty.primary.color };
    const currentId = typeof r.currentId === 'string' && (r.currentId === PRIMARY_ACCOUNT_ID || accounts.some((a) => a.id === r.currentId)) ? r.currentId : PRIMARY_ACCOUNT_ID;
    return { currentId, primary, accounts };
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  primary(): Account { return { id: PRIMARY_ACCOUNT_ID, name: this.state.primary.name, dir: this.o.primaryDir, color: this.state.primary.color }; }
  list(): Account[] { return [this.primary(), ...this.state.accounts.map((a) => ({ ...a }))]; }
  get(id: string): Account | null { return this.list().find((a) => a.id === id) ?? null; }
  current(): Account { return this.get(this.state.currentId) ?? this.primary(); }

  private must(id: string): Account {
    const a = this.get(id);
    if (!a) throw new AccountError(404, 'アカウントが見つかりません');
    return a;
  }

  setCurrent(id: string): void {
    this.must(id);
    this.state.currentId = id;
    this.save();
  }

  private cleanName(name: string, exceptId?: string): string {
    const n = name.trim();
    if (!n) throw new AccountError(400, 'アカウントの名前を入れてください');
    if ([...n].length > NAME_MAX) throw new AccountError(400, `アカウントの名前は ${NAME_MAX} 字までです`);
    if (this.list().some((a) => a.id !== exceptId && a.name === n)) throw new AccountError(400, `同じ名前のアカウントがあります: ${n}`);
    return n;
  }

  /** まだ無い ~/.claude-N（N は 2 から）を返す。置き場そのものは作らない。作るのはリンクを張る側である。 */
  private nextDir(): string {
    for (let n = 2; ; n++) {
      const dir = path.join(this.homeDir, `.claude-${n}`);
      if (!fs.existsSync(dir) && !this.byDir(dir)) return dir;
    }
  }

  byDir(dir: string): Account | null {
    const want = path.resolve(dir);
    return this.list().find((a) => path.resolve(a.dir) === want) ?? null;
  }

  add(input: { name: string; dir?: string }): Account {
    const name = this.cleanName(input.name);
    let dir: string;
    if (input.dir === undefined) dir = this.nextDir();
    else {
      if (!path.isAbsolute(input.dir)) throw new AccountError(400, '置き場は絶対パスで指定してください');
      dir = path.resolve(input.dir);
      if (this.byDir(dir)) throw new AccountError(400, `この置き場はもう登録されています: ${dir}`);
    }
    const used = new Set(this.list().map((a) => a.color));
    const color = ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[this.list().length % ACCOUNT_COLORS.length]!;
    const account: Account = { id: newId(), name, dir, color };
    this.state.accounts.push(account);
    this.save();
    return { ...account };
  }

  update(id: string, patch: { name?: string; color?: string }): Account {
    const cur = this.must(id);
    const name = patch.name === undefined ? cur.name : this.cleanName(patch.name, id);
    const color = patch.color === undefined ? cur.color : patch.color;
    if (!COLOR.test(color)) throw new AccountError(400, '色は #rrggbb（小文字）で指定してください');
    if (id === PRIMARY_ACCOUNT_ID) this.state.primary = { name, color };
    else this.state.accounts = this.state.accounts.map((a) => (a.id === id ? { ...a, name, color } : a));
    this.save();
    return this.must(id);
  }

  /** 登録だけを外す。置き場のディレクトリと、その中のログインは残す。 */
  remove(id: string): void {
    if (id === PRIMARY_ACCOUNT_ID) throw new AccountError(400, '最初のアカウントは消せません');
    this.must(id);
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    if (this.state.currentId === id) this.state.currentId = PRIMARY_ACCOUNT_ID;
    this.save();
  }
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config/accounts.test.ts 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`
Expected: 9 件 PASS、型検査はエラーなし。

- [ ] **Step 6: コミット**

```bash
git add packages/server/src/config/accounts.ts packages/server/src/config/accounts.test.ts
git commit packages/shared/src/api.ts packages/shared/src/intent.ts packages/shared/src/events.ts packages/server/src/config/accounts.ts packages/server/src/config/accounts.test.ts -m "feat(server): keep Claude accounts and the current one in accounts.json

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 置き場のリンク

**Files:**
- Create: `packages/server/src/config/accountLinks.ts`
- Test: `packages/server/src/config/accountLinks.test.ts`

**Interfaces:**
- Produces:
  - `LINKED_ENTRIES: readonly string[]`（Global Constraints の 17 個、その順）
  - `ensureAccountLinks(primaryDir: string, dir: string): { created: string[]; conflicts: string[] }`
  - `linkProblem(conflicts: string[]): string | null`

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/config/accountLinks.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LINKED_ENTRIES, ensureAccountLinks, linkProblem } from './accountLinks.ts';

let root: string;
let primary: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-links-'));
  primary = path.join(root, '.claude');
  dir = path.join(root, '.claude-2');
  fs.mkdirSync(path.join(primary, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(primary, 'skills'));
  fs.writeFileSync(path.join(primary, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(primary, '.claude.json'), '{}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ensureAccountLinks', () => {
  it('17 個を決まった順で持つ', () => {
    expect(LINKED_ENTRIES).toHaveLength(17);
    expect(LINKED_ENTRIES.slice(0, 4)).toEqual(['CLAUDE.md', 'settings.json', 'statusline-command.sh', 'history.jsonl']);
    expect(LINKED_ENTRIES).not.toContain('.claude.json');
  });

  it('置き場を 0700 で作り、最初の置き場にある項目だけをリンクにする', () => {
    const r = ensureAccountLinks(primary, dir);
    expect(r).toEqual({ created: ['settings.json', 'skills', 'projects'], conflicts: [] });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(primary, 'projects'));
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.claude.json'))).toBe(false);
  });

  it('二度目は何も作らない。あとから最初の置き場に増えた項目は足す', () => {
    ensureAccountLinks(primary, dir);
    expect(ensureAccountLinks(primary, dir)).toEqual({ created: [], conflicts: [] });
    fs.writeFileSync(path.join(primary, 'CLAUDE.md'), '# x');
    expect(ensureAccountLinks(primary, dir).created).toEqual(['CLAUDE.md']);
  });

  it('実ファイル、実ディレクトリ、別の先を指すリンクは、消さずに conflicts に挙げる', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"mine":1}');
    fs.mkdirSync(path.join(dir, 'skills'));
    fs.symlinkSync('/somewhere/else', path.join(dir, 'projects'));
    const r = ensureAccountLinks(primary, dir);
    expect(r).toEqual({ created: [], conflicts: ['settings.json', 'skills', 'projects'] });
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{"mine":1}');
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe('/somewhere/else');
  });

  it('最初の置き場そのものを渡したら何もしない', () => {
    expect(ensureAccountLinks(primary, path.join(primary, '.'))).toEqual({ created: [], conflicts: [] });
    expect(fs.lstatSync(path.join(primary, 'projects')).isSymbolicLink()).toBe(false);
  });

  it('conflicts を文にする', () => {
    expect(linkProblem([])).toBeNull();
    expect(linkProblem(['settings.json', 'skills'])).toBe('置き場の settings.json、skills が共有のリンクではありません。中身を確かめて、要らなければ消してください');
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/accountLinks.test.ts 2>&1 | tail -5`
Expected: FAIL（`./accountLinks.ts` が無い）。

- [ ] **Step 3: 実装する**

`packages/server/src/config/accountLinks.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * 2 つ目以降の置き場で、最初の置き場へのリンクにする項目。
 * 認証（.claude.json と Keychain）と、組織から配られる設定、キャッシュ、常駐のサービスの状態は入れない。
 * 実物で確かめた組である（docs/superpowers/specs/2026-10-06-account-switch-design.md）。
 */
export const LINKED_ENTRIES: readonly string[] = [
  'CLAUDE.md', 'settings.json', 'statusline-command.sh', 'history.jsonl', 'commands', 'skills', 'plugins', 'memory', 'projects',
  'file-history', 'paste-cache', 'plans', 'tasks', 'session-env', 'shell-snapshots', 'sessions', 'jobs',
];

/**
 * 置き場を作り、最初の置き場にある項目へリンクを張る。
 * リンクの場所に別のもの（実ファイル、実ディレクトリ、別の先を指すリンク）があれば、触らずに conflicts へ挙げる。
 * 黙って張り直すと、そこへ書かれた設定や履歴を失うためである。
 */
export function ensureAccountLinks(primaryDir: string, dir: string): { created: string[]; conflicts: string[] } {
  const created: string[] = [];
  const conflicts: string[] = [];
  if (path.resolve(primaryDir) === path.resolve(dir)) return { created, conflicts };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of LINKED_ENTRIES) {
    const target = path.join(primaryDir, name);
    if (!fs.existsSync(target)) continue;
    const link = path.join(dir, name);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(link); } catch { st = null; }
    if (st === null) { fs.symlinkSync(target, link); created.push(name); continue; }
    if (st.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === path.resolve(target)) continue;
    conflicts.push(name);
  }
  return { created, conflicts };
}

export function linkProblem(conflicts: string[]): string | null {
  if (conflicts.length === 0) return null;
  return `置き場の ${conflicts.join('、')} が共有のリンクではありません。中身を確かめて、要らなければ消してください`;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config/accountLinks.test.ts 2>&1 | tail -5`
Expected: 6 件 PASS。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/config/accountLinks.ts packages/server/src/config/accountLinks.test.ts
git commit packages/server/src/config/accountLinks.ts packages/server/src/config/accountLinks.test.ts -m "feat(server): link a second config dir to the first one without touching what is there

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 認証の状態を読む、ログインを起こす

**Files:**
- Create: `packages/server/src/config/accountAuth.ts`
- Test: `packages/server/src/config/accountAuth.test.ts`

**Interfaces:**
- Consumes: `Account`、`PRIMARY_ACCOUNT_ID`（Task 1）、`AccountAuthDto`（Task 1）
- Produces:
  - `type RunClaude = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number | null; stdout: string }>`
  - `accountEnv(account: Account, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`（最初のアカウントは `CLAUDE_CONFIG_DIR` を外し、ほかは置き場を入れる）
  - `parseAuthStatus(stdout: string, now: number): AccountAuthDto | null`
  - `class AccountAuth`：`constructor(o: { claudeBin: () => string | null; run?: RunClaude; now?: () => number; onChange?: () => void })`、`get(id: string): AccountAuthDto | null`、`refresh(account: Account): Promise<AccountAuthDto | null>`、`login(account: Account): boolean`（起こせたら true、もう走っていれば false）、`loginRunning(id: string): boolean`、`forget(id: string): void`

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/config/accountAuth.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { AccountAuth, accountEnv, parseAuthStatus, type RunClaude } from './accountAuth.ts';
import type { Account } from './accounts.ts';

const primary: Account = { id: 'primary', name: '会社', dir: '/h/.claude', color: '#2a57b8' };
const univ: Account = { id: 'a1', name: '大学', dir: '/h/.claude-2', color: '#7a4a9e' };
const OK = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'taro@example.ac.jp', orgName: 'Example University', subscriptionType: 'enterprise' });

describe('accountEnv', () => {
  it('最初のアカウントは CLAUDE_CONFIG_DIR を外し、ほかは置き場を入れる。API キーの類は渡さない', () => {
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/stale', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o' };
    expect(accountEnv(primary, base)).toEqual({ PATH: '/bin' });
    expect(accountEnv(univ, base)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-2' });
  });
});

describe('parseAuthStatus', () => {
  it('必要な 4 つだけを取り出す', () => {
    expect(parseAuthStatus(OK, 5)).toEqual({ loggedIn: true, email: 'taro@example.ac.jp', plan: 'enterprise', orgName: 'Example University', checkedAt: 5 });
  });
  it('未ログインは loggedIn だけ偽で、ほかは null', () => {
    expect(parseAuthStatus('{"loggedIn":false}', 5)).toEqual({ loggedIn: false, email: null, plan: null, orgName: null, checkedAt: 5 });
  });
  it('JSON でない出力、loggedIn の無い出力は null', () => {
    expect(parseAuthStatus('Not logged in', 5)).toBeNull();
    expect(parseAuthStatus('{"email":"x"}', 5)).toBeNull();
  });
});

describe('AccountAuth', () => {
  it('置き場を環境変数で渡して auth status を呼び、結果を覚える', async () => {
    const run = vi.fn<RunClaude>(async () => ({ code: 0, stdout: OK }));
    const onChange = vi.fn();
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, now: () => 9, onChange });
    expect(auth.get('a1')).toBeNull();
    expect((await auth.refresh(univ))?.plan).toBe('enterprise');
    expect(run).toHaveBeenCalledWith('/bin/claude', ['auth', 'status', '--json'], expect.objectContaining({ CLAUDE_CONFIG_DIR: '/h/.claude-2' }), 10_000);
    expect(auth.get('a1')?.email).toBe('taro@example.ac.jp');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('claude が無い、失敗した、JSON でないときは null を覚え、投げない', async () => {
    const none = new AccountAuth({ claudeBin: () => null, run: vi.fn() });
    expect(await none.refresh(univ)).toBeNull();
    const boom = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => { throw new Error('ETIMEDOUT'); } });
    expect(await boom.refresh(univ)).toBeNull();
    const junk = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 1, stdout: 'oops' }) });
    expect(await junk.refresh(univ)).toBeNull();
    expect(junk.get('a1')).toBeNull();
  });

  it('終了コードが 0 でなくても、標準出力が読めれば未ログインとして覚える', async () => {
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 1, stdout: '{"loggedIn":false}' }) });
    expect((await auth.refresh(univ))?.loggedIn).toBe(false);
  });

  it('login は claude auth login を起こし、終わったら状態を読み直す。走っている間の二度目は起こさない', async () => {
    let finish: (v: { code: number | null; stdout: string }) => void = () => {};
    const calls: string[][] = [];
    const run: RunClaude = (_bin, args) => {
      calls.push(args);
      if (args[1] === 'login') return new Promise((r) => { finish = r; });
      return Promise.resolve({ code: 0, stdout: OK });
    };
    const onChange = vi.fn();
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run, onChange });
    expect(auth.login(univ)).toBe(true);
    expect(auth.loginRunning('a1')).toBe(true);
    expect(auth.login(univ)).toBe(false);
    finish({ code: 0, stdout: '' });
    await vi.waitFor(() => expect(auth.get('a1')?.loggedIn).toBe(true));
    expect(auth.loginRunning('a1')).toBe(false);
    expect(calls).toEqual([['auth', 'login'], ['auth', 'status', '--json']]);
    expect(onChange).toHaveBeenCalled();
  });

  it('forget で覚えた状態を捨てる', async () => {
    const auth = new AccountAuth({ claudeBin: () => '/bin/claude', run: async () => ({ code: 0, stdout: OK }) });
    await auth.refresh(univ);
    auth.forget('a1');
    expect(auth.get('a1')).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/config/accountAuth.test.ts 2>&1 | tail -5`
Expected: FAIL（`./accountAuth.ts` が無い）。

- [ ] **Step 3: 実装する**

`packages/server/src/config/accountAuth.ts`：

```ts
import { execFile } from 'node:child_process';
import type { AccountAuthDto } from '@agent-hangar/shared';
import { PRIMARY_ACCOUNT_ID, type Account } from './accounts.ts';

export type RunClaude = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

const STATUS_TIMEOUT_MS = 10_000;
/** ブラウザでの承認を待つ上限。過ぎたら claude を終わらせ、未ログインのままにする。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** 置き場のログインより優先される認証の変数。渡すと、選んだアカウントではないもので動く。 */
const AUTH_OVERRIDES = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

const realRun: RunClaude = (bin, args, env, timeoutMs) => new Promise((resolve, reject) => {
  execFile(bin, args, { env, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
    // 終了コードが 0 でないだけなら、標準出力を読む側に任せる。起動できない、時間切れは失敗にする。
    if (err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code !== 'number') return reject(err);
    resolve({ code: err ? ((err as unknown as { code: number }).code) : 0, stdout: stdout ?? '' });
  });
});

/** アカウントの置き場で claude を起こすときの環境。最初のアカウントは CLAUDE_CONFIG_DIR を付けない。 */
export function accountEnv(account: Account, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!AUTH_OVERRIDES.includes(k) && v !== undefined) env[k] = v;
  if (account.id !== PRIMARY_ACCOUNT_ID) env.CLAUDE_CONFIG_DIR = account.dir;
  return env;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `claude auth status --json` の出力から、画面に出す 4 つだけを取り出す。 */
export function parseAuthStatus(stdout: string, now: number): AccountAuthDto | null {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.loggedIn !== 'boolean') return null;
  return { loggedIn: r.loggedIn, email: text(r.email), plan: text(r.subscriptionType), orgName: text(r.orgName), checkedAt: now };
}

/**
 * アカウントごとの認証の状態。claude 自身に聞くだけで、トークンは読まない。
 * ログインも claude 自身の流れ（ブラウザでの承認）に任せ、hangar は子プロセスを起こして終わるのを待つだけである。
 */
export class AccountAuth {
  private readonly cache = new Map<string, AccountAuthDto>();
  private readonly logins = new Set<string>();
  private readonly run: RunClaude;
  private readonly now: () => number;

  constructor(private readonly o: { claudeBin: () => string | null; run?: RunClaude; now?: () => number; onChange?: () => void }) {
    this.run = o.run ?? realRun;
    this.now = o.now ?? (() => Date.now());
  }

  get(id: string): AccountAuthDto | null { return this.cache.get(id) ?? null; }
  loginRunning(id: string): boolean { return this.logins.has(id); }
  forget(id: string): void { this.cache.delete(id); }

  async refresh(account: Account): Promise<AccountAuthDto | null> {
    const bin = this.o.claudeBin();
    let next: AccountAuthDto | null = null;
    if (bin) {
      try { next = parseAuthStatus((await this.run(bin, ['auth', 'status', '--json'], accountEnv(account), STATUS_TIMEOUT_MS)).stdout, this.now()); } catch { next = null; }
    }
    if (next) this.cache.set(account.id, next); else this.cache.delete(account.id);
    this.o.onChange?.();
    return next;
  }

  /** claude auth login を起こす。ブラウザは claude が開く。終わったら状態を読み直す。 */
  login(account: Account): boolean {
    const bin = this.o.claudeBin();
    if (!bin || this.logins.has(account.id)) return false;
    this.logins.add(account.id);
    this.o.onChange?.();
    void this.run(bin, ['auth', 'login'], accountEnv(account), LOGIN_TIMEOUT_MS)
      .catch(() => null)
      .then(() => { this.logins.delete(account.id); return this.refresh(account); });
    return true;
  }
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/config/accountAuth.test.ts 2>&1 | tail -5 && npm run typecheck 2>&1 | tail -3`
Expected: 9 件 PASS、型検査はエラーなし。

- [ ] **Step 5: コミット**

```bash
git add packages/server/src/config/accountAuth.ts packages/server/src/config/accountAuth.test.ts
git commit packages/server/src/config/accountAuth.ts packages/server/src/config/accountAuth.test.ts -m "feat(server): ask claude itself for each account's login state and start its login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 起動にアカウントを通す

**Files:**
- Modify: `packages/server/src/runs/manager.ts`（`RunManagerDeps`、`launch`、`start`、`resume`、`startFromTerminal`、`fork`）
- Modify: `packages/server/src/db/queries.ts`（末尾に 2 関数を追加）
- Test: `packages/server/src/runs/manager.test.ts`（末尾に describe を追加）
- Test: `packages/server/src/db/accountOf.test.ts`（新規）

**Interfaces:**
- Consumes: `AccountStore`、`AccountError`、`PRIMARY_ACCOUNT_ID`（Task 1）、`ensureAccountLinks`、`linkProblem`（Task 2）
- Produces:
  - `accountOfSession(db: Db, sessionId: string): string | null`（そのセッションの最後の run の `launch_params.account`。無ければ null）
  - `sessionAccounts(db: Db): Record<string, string>`（最後の run のアカウントが `primary` でないセッションだけ）
  - `RunManagerDeps.accounts?: AccountStore`
  - `RunManager.resume(sessionId, extra?: { args?: string[]; env?: Record<string, string>; account?: string })`
  - `RunManager.accountFor(sessionId: string): string`（消えたアカウントは `primary` に落とす）

- [ ] **Step 1: queries の失敗する試験を書く**

`packages/server/src/db/accountOf.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './open.ts';
import { accountOfSession, sessionAccounts } from './queries.ts';
import { upsertShared } from './shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';

let db: Db;
let s1: string;
let s2: string;
const run = (id: string, sessionId: string, startedAt: number, params: unknown) =>
  upsertShared(db, 'runs', { id, session_id: sessionId, device_id: 'd', kind: 'start', tmux_name: `t-${id}`, pid: null, launch_params: typeof params === 'string' ? params : JSON.stringify(params), started_at: startedAt, ended_at: startedAt + 1, end_reason: 'exited', heartbeat_at: startedAt }, 'd');

beforeEach(() => {
  db = openDb(':memory:');
  s1 = ensureSession(db, '11111111-1111-4111-8111-111111111111', '/w', 'd');
  s2 = ensureSession(db, '22222222-2222-4222-8222-222222222222', '/w', 'd');
});

describe('accountOfSession', () => {
  it('run が無ければ null', () => expect(accountOfSession(db, s1)).toBeNull());
  it('最後の run のアカウントを返す。アカウントの無い run は null', () => {
    run('r1', s1, 10, { account: 'a1' });
    expect(accountOfSession(db, s1)).toBe('a1');
    run('r2', s1, 20, { projectId: 'p' });
    expect(accountOfSession(db, s1)).toBeNull();
    run('r3', s1, 30, { account: 'primary' });
    expect(accountOfSession(db, s1)).toBe('primary');
  });
  it('壊れた launch_params は null', () => {
    run('r1', s1, 10, '{ not json');
    expect(accountOfSession(db, s1)).toBeNull();
  });
});

describe('sessionAccounts', () => {
  it('最後の run が primary 以外のセッションだけを載せる', () => {
    run('r1', s1, 10, { account: 'a1' });
    run('r2', s2, 10, { account: 'a1' });
    run('r3', s2, 20, { account: 'primary' });
    expect(sessionAccounts(db)).toEqual({ [s1]: 'a1' });
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/db/accountOf.test.ts 2>&1 | tail -5`
Expected: FAIL（`accountOfSession` が無い）。

- [ ] **Step 3: queries に足す**

`packages/server/src/db/queries.ts` の末尾に足す（`Db` はこのファイルが既に import している）。

```ts
const accountIn = (launchParams: string | null): string | null => {
  if (!launchParams) return null;
  try {
    const a = (JSON.parse(launchParams) as { account?: unknown } | null)?.account;
    return typeof a === 'string' && a ? a : null;
  } catch { return null; }
};

/** そのセッションを最後に動かしたアカウント。run が無い、またはアカウントを記録する前の run なら null。 */
export function accountOfSession(db: Db, sessionId: string): string | null {
  const r = db.prepare('select launch_params from runs where session_id = ? and deleted_at is null order by started_at desc, id desc limit 1').get(sessionId) as { launch_params: string | null } | undefined;
  return accountIn(r?.launch_params ?? null);
}

/** 最初のアカウント以外で最後に動かしたセッションの一覧（セッションの id → アカウントの id）。 */
export function sessionAccounts(db: Db): Record<string, string> {
  const rows = db.prepare(`select r.session_id, r.launch_params from runs r
    where r.deleted_at is null and r.launch_params like '%"account"%'
      and not exists (select 1 from runs n where n.session_id = r.session_id and n.deleted_at is null and (n.started_at > r.started_at or (n.started_at = r.started_at and n.id > r.id)))`).all() as { session_id: string; launch_params: string | null }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    const a = accountIn(r.launch_params);
    if (a && a !== 'primary') out[r.session_id] = a;
  }
  return out;
}
```

Run: `npx vitest run packages/server/src/db/accountOf.test.ts 2>&1 | tail -5`
Expected: 5 件 PASS。

- [ ] **Step 4: RunManager の失敗する試験を書く**

`packages/server/src/runs/manager.test.ts` の末尾に足す。ファイルの先頭の import に `import { AccountStore } from '../config/accounts.ts';` を足す。この describe は tmux を使うので、既存の describe と同じく `TMUX` が無い環境では `describe.skipIf(!TMUX)` にする（既存の書き方に合わせる）。

```ts
describe.skipIf(!TMUX)('アカウント', () => {
  let userHome: string;
  let accounts: AccountStore;
  const envOf = async (runId: string) => {
    await launchedArgs(runId);
    // 偽の claude は起動のたびに 1 行を足すので、最後の行がこの run のものである。
    return fs.readFileSync(fake.envFile, 'utf8').trimEnd().split('\n').at(-1) + '\n';
  };
  beforeEach(() => {
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rm-user-'));
    fake = writeFakeClaude(home, { recordEnv: ['CLAUDE_CONFIG_DIR'] });
    accounts = new AccountStore({ home, primaryDir: claudeDir, homeDir: userHome });
  });
  afterEach(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const params = (runId: string) => JSON.parse((db.prepare('select launch_params from runs where id = ?').get(runId) as { launch_params: string }).launch_params) as { account?: string };

  it('最初のアカウントでは CLAUDE_CONFIG_DIR を足さず、run に primary と残す', async () => {
    const r = make({ accounts }).start({ projectId: 'p1' });
    expect(await envOf(r.run.id)).toBe('CLAUDE_CONFIG_DIR=\n');
    expect(params(r.run.id).account).toBe('primary');
  });

  it('アカウントを指定すると、置き場のリンクを張ってから、その置き場で起こす', async () => {
    const a = accounts.add({ name: '大学' });
    const r = make({ accounts }).start({ projectId: 'p1', account: a.id });
    expect(await envOf(r.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(fs.readlinkSync(path.join(a.dir, 'projects'))).toBe(path.join(claudeDir, 'projects'));
    expect(params(r.run.id).account).toBe(a.id);
  });

  it('指定が無ければ、いまのアカウントで起こす', async () => {
    const a = accounts.add({ name: '大学' });
    accounts.setCurrent(a.id);
    const r = make({ accounts }).start({ projectId: 'p1' });
    expect(await envOf(r.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
  });

  it('知らないアカウントは 400 で断り、セッションの行を作らない', () => {
    const before = (db.prepare('select count(*) n from sessions').get() as { n: number }).n;
    expect(() => make({ accounts }).start({ projectId: 'p1', account: 'nope' })).toThrow('アカウントが見つかりません');
    expect((db.prepare('select count(*) n from sessions').get() as { n: number }).n).toBe(before);
  });

  it('リンクの場所に実ファイルがあれば 400 で断り、ファイルは残す', () => {
    const a = accounts.add({ name: '大学' });
    fs.mkdirSync(a.dir);
    fs.mkdirSync(path.join(a.dir, 'projects'));
    const before = (db.prepare('select count(*) n from sessions').get() as { n: number }).n;
    expect(() => make({ accounts }).start({ projectId: 'p1', account: a.id })).toThrow('置き場の projects が共有のリンクではありません');
    expect(fs.lstatSync(path.join(a.dir, 'projects')).isDirectory()).toBe(true);
    expect((db.prepare('select count(*) n from sessions').get() as { n: number }).n).toBe(before);
  });

  it('再開は最後に動かしたアカウントで起こす。消えたアカウントは最初のアカウントに落とす', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1', account: a.id });
    await envOf(first.run.id);
    m.kill(first.run.id);
    db.prepare("insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_offset) values ('/x.jsonl', ?, null, 1, 1, 1)").run(first.sessionId);
    expect(m.accountFor(first.sessionId)).toBe(a.id);
    const again = m.resume(first.sessionId);
    expect(await envOf(again.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    m.kill(again.run.id);
    accounts.remove(a.id);
    expect(m.accountFor(first.sessionId)).toBe('primary');
  });

  it('ターミナルから：CLAUDE_CONFIG_DIR が無ければいまのアカウント、登録済みの置き場ならそのアカウント、未登録ならそのまま渡して記録しない', async () => {
    const a = accounts.add({ name: '大学' });
    const b = accounts.add({ name: '個人' });
    accounts.setCurrent(a.id);
    const m = make({ accounts });
    const r1 = m.startFromTerminal({ cwd, args: [], env: { PATH: process.env.PATH ?? '' } });
    expect(await envOf(r1.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(params(r1.run.id).account).toBe(a.id);
    const r2 = m.startFromTerminal({ cwd, args: [], env: { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: b.dir + '/' } });
    expect(await envOf(r2.run.id)).toBe(`CLAUDE_CONFIG_DIR=${b.dir}/\n`);
    expect(params(r2.run.id).account).toBe(b.id);
    const r3 = m.startFromTerminal({ cwd, args: [], env: { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: '/elsewhere' } });
    expect(await envOf(r3.run.id)).toBe('CLAUDE_CONFIG_DIR=/elsewhere\n');
    expect(params(r3.run.id).account).toBeUndefined();
  });

  it('accounts を渡さない RunManager は今までどおり動く', async () => {
    const r = make().start({ projectId: 'p1' });
    expect(await envOf(r.run.id)).toBe('CLAUDE_CONFIG_DIR=\n');
    expect(params(r.run.id).account).toBeUndefined();
  });
});
```

`transcript_files` の列は `packages/server/src/db/migrations.ts` の定義に合わせる。上の insert が列の違いで落ちたら、そのファイルの既存の試験（`assertResumable` を通している箇所）が使っている insert をそのまま写す。`startFromTerminal` の引数の型（`TerminalRequest`）も、既存の試験の呼び方に合わせる。

- [ ] **Step 5: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/runs/manager.test.ts -t アカウント 2>&1 | tail -12`
Expected: FAIL（`accounts` という依存が無い、`accountFor` が無い）。

- [ ] **Step 6: RunManager を直す**

`packages/server/src/runs/manager.ts`：

import に足す。

```ts
import { AccountError, PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import { ensureAccountLinks, linkProblem } from '../config/accountLinks.ts';
import { accountOfSession } from '../db/queries.ts';
```

（`../db/queries.ts` からの import が既にあれば、その行に `accountOfSession` を足す。）

`RunManagerDeps` の末尾に `accounts?: AccountStore` を足す。

クラスに次の 3 つを足す（`private precheck` の前）。

```ts
  /**
   * 起動に使うアカウントを解く。id が無ければいまのアカウントで、accounts を持たない RunManager は null を返す。
   * 知らない id は 400 で断る。黙って別のアカウントで起こすと、利用者が選んだものと違う枠を使うためである。
   */
  private account(id: string | undefined): Account | null {
    const store = this.deps.accounts;
    if (!store) return null;
    if (id === undefined) return store.current();
    const a = store.get(id);
    if (!a) throw new RunError(400, 'アカウントが見つかりません');
    return a;
  }

  /** そのセッションを最後に動かしたアカウント。記録が無い、またはアカウントが消えていれば最初のアカウント。 */
  accountFor(sessionId: string): string {
    const id = accountOfSession(this.db, sessionId);
    return id && this.deps.accounts?.get(id) ? id : PRIMARY_ACCOUNT_ID;
  }

  /**
   * アカウントの置き場で起こすための環境変数。最初のアカウントは何も足さない。
   * 起動の前にリンクを確かめる。リンクの場所に別のものがあれば、起こさずに伝える。
   */
  private accountEnvFor(a: Account | null): Record<string, string> {
    if (!a || a.id === PRIMARY_ACCOUNT_ID) return {};
    const problem = linkProblem(ensureAccountLinks(this.deps.claudeDir, a.dir).conflicts);
    if (problem) throw new RunError(400, problem);
    return { CLAUDE_CONFIG_DIR: a.dir };
  }
```

`launch` の引数の型に `account?: Account | null` を足し、本体の頭を次のように変える。

```ts
  private launch(o: { sessionId: string; cwd: string; kind: RunKind; command: string[]; params: LaunchParams; env?: Record<string, string>; account?: Account | null }): LaunchResult {
    const tmux = this.precheck(o.cwd);
    // 利用者が自分で付けた CLAUDE_CONFIG_DIR（o.env）は、アカウントの置き場で上書きしない。
    const env = { ...this.accountEnvFor(o.env?.CLAUDE_CONFIG_DIR ? null : o.account ?? null), ...o.env };
    const params: LaunchParams = o.account ? { ...o.params, account: o.account.id } : o.params;
```

同じ関数の中の `launch_params: JSON.stringify(o.params)` を `launch_params: JSON.stringify(params)` に、`env: withUtf8Locale(o.env)` を `env: withUtf8Locale(env)` に変える。

`start` は、`this.addDirs(params);` の次の行に `const account = this.account(params.account);` と `this.accountEnvFor(account);` を足し、最後の行を `return this.launch({ sessionId, cwd, kind: 'start', command, params, account });` にする。行を作る前にアカウントとリンクを確かめるので、知らないアカウントや壊れたリンクでは、本文の無いセッションの行ができない（リンクの確かめは `launch` でもう一度走るが、二度目は何も作らない）。

`resume` は、引数の型を `extra: { args?: string[]; env?: Record<string, string>; account?: string } = {}` にし、`this.assertResumable(s);` の次の行に足す。

```ts
    const account = this.account(extra.account ?? (this.deps.accounts ? this.accountFor(s.id) : undefined));
```

`resume` の中の 2 つの `this.launch({ ... })` の両方に `account` を足す（`params: { projectId: s.project_id ?? undefined }, env: extra.env, account`）。

`fork` は、`this.assertResumable(s);` の次の行に `const account = this.account(this.deps.accounts ? this.accountFor(s.id) : undefined);` を足し、最後の `this.launch({ ... })` に `account` を足す。

`startFromTerminal` は、`const env = terminalEnv(req.env);` の次の行に足す。

```ts
    // 利用者が自分で置き場を付けたら、それを優先する。登録済みの置き場ならそのアカウントとして記録し、未登録なら記録しない。
    const account = env.CLAUDE_CONFIG_DIR ? this.deps.accounts?.byDir(env.CLAUDE_CONFIG_DIR) ?? null : this.account(undefined);
```

その下の `return { ...this.resume(id, { args: rest, env }), attached: false };` を `return { ...this.resume(id, { args: rest, env, account: env.CLAUDE_CONFIG_DIR ? account?.id : undefined }), attached: false };` に変える（置き場を付けずに `claude -r` と打ったときは、最後に動かしたアカウントで再開する）。最後の `this.launch({ ... })` に `account` を足す。

`AccountError` は import したが使わないなら import から外す（型検査が未使用を弾く設定なら必ず外す）。

- [ ] **Step 7: 通ることを確かめる**

Run: `npx vitest run packages/server/src/runs packages/server/src/db/accountOf.test.ts 2>&1 | tail -6 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS（既存の manager の試験も含む）、型検査はエラーなし。

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/db/accountOf.test.ts
git commit packages/server/src/runs/manager.ts packages/server/src/runs/manager.test.ts packages/server/src/db/queries.ts packages/server/src/db/accountOf.test.ts -m "feat(server): launch each run under its account's config dir and record which one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: セッションを別のアカウントで再開し直す

**Files:**
- Modify: `packages/server/src/runs/manager.ts`（`switchAccount` を追加）
- Test: `packages/server/src/runs/manager.test.ts`（Task 4 の describe の中に追加）

**Interfaces:**
- Consumes: Task 4 の `account`、`accountFor`、`resume`
- Produces: `RunManager.switchAccount(sessionId: string, accountId: string): Promise<LaunchResult>`

- [ ] **Step 1: 失敗する試験を書く**

Task 4 の `describe('アカウント', ...)` の中に足す。

```ts
  const withBody = (sessionId: string) =>
    db.prepare("insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_offset) values (?, ?, null, 1, 1, 1)").run(`/b-${sessionId}.jsonl`, sessionId);

  it('動いているセッションを止め、同じ会話を別のアカウントで再開する', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    withBody(first.sessionId);
    const next = await m.switchAccount(first.sessionId, a.id);
    expect(next.sessionId).toBe(first.sessionId);
    expect(next.run.id).not.toBe(first.run.id);
    expect((db.prepare('select end_reason from runs where id = ?').get(first.run.id) as { end_reason: string }).end_reason).toBe('killed');
    expect(await envOf(next.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
    expect(m.accountFor(first.sessionId)).toBe(a.id);
    const args = readArgs(fake.argsFile);
    expect(args[args.indexOf('-r') + 1]).toBe((db.prepare('select provider_session_id p from sessions where id = ?').get(first.sessionId) as { p: string }).p);
  });

  it('止まっているセッションは、そのまま別のアカウントで再開する', async () => {
    const a = accounts.add({ name: '大学' });
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    m.kill(first.run.id);
    withBody(first.sessionId);
    const next = await m.switchAccount(first.sessionId, a.id);
    expect(await envOf(next.run.id)).toBe(`CLAUDE_CONFIG_DIR=${a.dir}\n`);
  });

  it('知らないアカウントは、セッションを止める前に 400 で断る', async () => {
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    await expect(m.switchAccount(first.sessionId, 'nope')).rejects.toThrow('アカウントが見つかりません');
    expect((db.prepare('select ended_at from runs where id = ?').get(first.run.id) as { ended_at: number | null }).ended_at).toBeNull();
  });

  it('リンクが壊れているアカウントも、止める前に断る', async () => {
    const a = accounts.add({ name: '大学' });
    fs.mkdirSync(a.dir);
    fs.writeFileSync(path.join(a.dir, 'projects'), 'x');
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow('共有のリンクではありません');
    expect((db.prepare('select ended_at from runs where id = ?').get(first.run.id) as { ended_at: number | null }).ended_at).toBeNull();
  });

  it('止めたあともレジストリに残り続けたら 409 で断る。元の run は閉じたまま', async () => {
    const a = accounts.add({ name: '大学' });
    let slept = 0;
    const m = make({ accounts, isLive: () => true, sleep: async (ms) => { slept += ms; } });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    withBody(first.sessionId);
    await expect(m.switchAccount(first.sessionId, a.id)).rejects.toThrow('前の Claude がまだ終わっていません');
    expect(slept).toBeGreaterThanOrEqual(5000);
    expect((db.prepare('select end_reason from runs where id = ?').get(first.run.id) as { end_reason: string }).end_reason).toBe('killed');
  });

  it('同じアカウントへの切り替えは 409 で断り、何も止めない', async () => {
    const m = make({ accounts });
    const first = m.start({ projectId: 'p1' });
    await envOf(first.run.id);
    await expect(m.switchAccount(first.sessionId, 'primary')).rejects.toThrow('このセッションはもうそのアカウントで動いています');
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/runs/manager.test.ts -t アカウント 2>&1 | tail -12`
Expected: 新しい 6 件が FAIL（`switchAccount` が無い）。

- [ ] **Step 3: 実装する**

`packages/server/src/runs/manager.ts` の `fork` の後ろに足す。

```ts
  /**
   * 開いているセッションを、別のアカウントで再開し直す。
   * 動いていれば止め、Claude のレジストリから消えるのを待ってから、同じ会話を選んだアカウントの置き場で起こす。
   * 本文は置き場の間で共有なので写さない。
   * 断る理由（知らないアカウント、壊れたリンク、同じアカウント）は、止める前に確かめる。止めてから断ると、利用者の作業だけが失われる。
   */
  async switchAccount(sessionId: string, accountId: string): Promise<LaunchResult> {
    const s = this.session(sessionId);
    const account = this.account(accountId);
    if (!account) throw new RunError(400, 'アカウントが見つかりません');
    if (this.accountFor(s.id) === account.id) throw new RunError(409, 'このセッションはもうそのアカウントで動いています');
    this.accountEnvFor(account);
    const alive = aliveRunForSession(this.db, s.id);
    if (alive) this.kill(alive.id);
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let waited = 0; this.deps.isLive?.(s.provider_session_id); waited += 250) {
      if (waited >= 5000) throw new RunError(409, '前の Claude がまだ終わっていません。少し待ってから、もう一度切り替えてください');
      await sleep(250);
    }
    return this.resume(s.id, { account: account.id });
  }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/runs 2>&1 | tail -6 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS、型検査はエラーなし。

- [ ] **Step 5: コミット**

```bash
git commit packages/server/src/runs/manager.ts packages/server/src/runs/manager.test.ts -m "feat(server): reopen a session under another account after stopping the old run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 使用量をアカウントごとに持つ

**Files:**
- Modify: `packages/server/src/db/migrations.ts`（末尾に version 15）
- Modify: `packages/server/src/usage/statusline.ts`（`UsageTracker`）
- Test: `packages/server/src/usage/statusline.test.ts`（末尾に describe を追加）

**Interfaces:**
- Consumes: なし（アカウントの id は文字列として受ける）
- Produces:
  - `IngestResult = { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null; accountId: string }`（`usage` はそのアカウントの値）
  - `new UsageTracker(db, { now?, keep?, accountOf?: (providerSessionId: string | null) => string })`（`accountOf` の既定は常に `'primary'`）
  - `UsageTracker.current(): UsageDto`（今までどおり。`primary` の値）
  - `UsageTracker.of(accountId: string): UsageDto`（無ければ 3 つとも null）

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/usage/statusline.test.ts` の末尾に足す（`openDb` と `UsageTracker` はこのファイルが既に import している。していなければ既存の試験と同じ形で足す）。

```ts
describe('アカウントごとの使用量', () => {
  const payload = (sid: string, five: number, seven: number) => ({ session_id: sid, rate_limits: { five_hour: { used_percentage: five, resets_at: 1000 }, seven_day: { used_percentage: seven, resets_at: 2000 } } });
  const accountOf = (sid: string | null) => (sid === 'univ-session' ? 'a1' : 'primary');

  it('セッションのアカウントへ振り分け、互いに上書きしない', () => {
    const db = openDb(':memory:');
    let t = 100;
    const u = new UsageTracker(db, { now: () => t++, accountOf });
    const r1 = u.ingest(payload('work-session', 82, 41))!;
    const r2 = u.ingest(payload('univ-session', 12, 9))!;
    expect([r1.accountId, r2.accountId]).toEqual(['primary', 'a1']);
    expect(r2.usage.fiveHour?.usedPercent).toBe(12);
    expect(u.current().fiveHour?.usedPercent).toBe(82);
    expect(u.of('a1')).toEqual({ fiveHour: { usedPercent: 12, resetsAt: 1_000_000 }, sevenDay: { usedPercent: 9, resetsAt: 2_000_000 }, updatedAt: 101 });
    expect(u.of('unknown')).toEqual({ fiveHour: null, sevenDay: null, updatedAt: null });
  });

  it('起動時に、アカウントごとの直近の値と時刻を復元する', () => {
    const db = openDb(':memory:');
    let t = 100;
    const u = new UsageTracker(db, { now: () => t++, accountOf });
    u.ingest(payload('univ-session', 12, 9));
    u.ingest(payload('work-session', 82, 41));
    const again = new UsageTracker(db, { accountOf });
    expect(again.of('a1').fiveHour?.usedPercent).toBe(12);
    expect(again.of('a1').updatedAt).toBe(100);
    expect(again.current().updatedAt).toBe(101);
  });

  it('keep はアカウントごとに数える。片方が多くても、もう片方の値は押し出されない', () => {
    const db = openDb(':memory:');
    let t = 100;
    const u = new UsageTracker(db, { now: () => t++, keep: 3, accountOf });
    u.ingest(payload('univ-session', 12, 9));
    for (let i = 0; i < 10; i++) u.ingest(payload('work-session', 50 + i, 41));
    expect((db.prepare("select count(*) n from usage_snapshots where account = 'primary'").get() as { n: number }).n).toBe(3);
    expect((db.prepare("select count(*) n from usage_snapshots where account = 'a1'").get() as { n: number }).n).toBe(1);
    expect(new UsageTracker(db, { accountOf }).of('a1').fiveHour?.usedPercent).toBe(12);
  });

  it('v15 より前に積まれた行（account が null）は primary として復元する', () => {
    const db = openDb(':memory:');
    db.prepare('insert into usage_snapshots (at, payload) values (?, ?)').run(50, JSON.stringify(payload('old', 70, 30)));
    expect(new UsageTracker(db).current().fiveHour?.usedPercent).toBe(70);
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/usage/statusline.test.ts 2>&1 | tail -8`
Expected: 新しい 4 件が FAIL（`accountOf` と `of` が無い、`account` の列が無い）。

- [ ] **Step 3: 移行を足す**

`packages/server/src/db/migrations.ts` の `MIGRATIONS` の配列の末尾（version 14 の要素の後ろ）に足す。

```ts
  {
    // 使用量のスナップショットに、どのアカウントのセッションから届いたかを持つ。
    // この表は同期しない（手元だけ）ので、列を足してもほかの PC には影響しない。
    // 既存の行は null のままで、最初のアカウントとして読む。
    version: 15,
    sql: `
alter table usage_snapshots add column account text;
create index usage_snapshots_account_at on usage_snapshots (account, at);
`,
  },
```

- [ ] **Step 4: UsageTracker を直す**

`packages/server/src/usage/statusline.ts` の `IngestResult` の型と `UsageTracker` のクラスを、次で置き換える（ファイルの上半分、`parseStatusline` までは変えない）。

```ts
export type IngestResult = { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null; accountId: string };

const PRIMARY = 'primary';
const EMPTY: UsageDto = { fiveHour: null, sevenDay: null, updatedAt: null };

/**
 * 使用率の現在値をアカウントごとに持ち、payload を積む。
 * 使用率は Claude のセッションが動いている間だけ届くので、値が無い payload では直前の値を保つ。
 * 本文の置き場はアカウントの間で共有なので、どのアカウントの値かは payload からは分からない。
 * 呼び手が渡す accountOf が、セッションの id から run を引いて決める。
 */
export class UsageTracker {
  private readonly state = new Map<string, UsageDto>();
  private lastAt = 0;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly accountOf: (providerSessionId: string | null) => string;

  constructor(private readonly db: Db, opts: { now?: () => number; keep?: number; accountOf?: (providerSessionId: string | null) => string } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.keep = opts.keep ?? 500;
    this.accountOf = opts.accountOf ?? (() => PRIMARY);
    this.restore();
  }

  /** 最初のアカウントの値。事後の要約の止める判定と、古い呼び手が使う。 */
  current(): UsageDto { return this.of(PRIMARY); }
  of(accountId: string): UsageDto { return this.state.get(accountId) ?? EMPTY; }

  /** アカウントごとに新しい順に読み、両方の窓が埋まるか行が尽きるまで辿る。 */
  private restore(): void {
    const accounts = (this.db.prepare("select distinct coalesce(account, 'primary') a from usage_snapshots").all() as { a: string }[]).map((r) => r.a);
    for (const a of accounts) {
      const rows = this.db.prepare("select at, payload from usage_snapshots where coalesce(account, 'primary') = ? order by at desc limit ?").all(a, this.keep) as { at: number; payload: string }[];
      let s: UsageDto = EMPTY;
      for (const r of rows) {
        let p: StatuslinePayload | null = null;
        try { p = parseStatusline(JSON.parse(r.payload)); } catch { continue; }
        if (!p?.rateLimits) continue;
        if (s.fiveHour === null && p.rateLimits.fiveHour) s = { ...s, fiveHour: p.rateLimits.fiveHour, updatedAt: s.updatedAt ?? r.at };
        if (s.sevenDay === null && p.rateLimits.sevenDay) s = { ...s, sevenDay: p.rateLimits.sevenDay, updatedAt: s.updatedAt ?? r.at };
        if (s.fiveHour && s.sevenDay) break;
      }
      if (s !== EMPTY) this.state.set(a, s);
    }
    this.lastAt = (this.db.prepare('select max(at) at from usage_snapshots').get() as { at: number | null }).at ?? 0;
  }

  ingest(raw: unknown): IngestResult | null {
    const p = parseStatusline(raw);
    if (!p) return null;
    const accountId = this.accountOf(p.providerSessionId);
    const at = Math.max(this.now(), this.lastAt + 1);
    this.lastAt = at;
    const write = this.db.transaction(() => {
      this.db.prepare('insert into usage_snapshots (at, payload, account) values (?, ?, ?)').run(at, JSON.stringify(raw), accountId);
      this.db.prepare("delete from usage_snapshots where coalesce(account, 'primary') = ? and at not in (select at from usage_snapshots where coalesce(account, 'primary') = ? order by at desc limit ?)").run(accountId, accountId, this.keep);
      if (p.providerSessionId) {
        // null の項目は既存の値を保つ（1 回目の payload は current_usage が null）。
        this.db.prepare(`insert into session_live_stats (provider_session_id, model, effort, context_used, context_size, cost_usd, updated_at) values (?,?,?,?,?,?,?)
          on conflict(provider_session_id) do update set
            model = coalesce(excluded.model, session_live_stats.model), effort = coalesce(excluded.effort, session_live_stats.effort),
            context_used = coalesce(excluded.context_used, session_live_stats.context_used), context_size = coalesce(excluded.context_size, session_live_stats.context_size),
            cost_usd = coalesce(excluded.cost_usd, session_live_stats.cost_usd), updated_at = excluded.updated_at`)
          .run(p.providerSessionId, p.model, p.effort, p.contextUsed, p.contextSize, p.costUsd, at);
      }
    });
    write();
    const before = this.of(accountId);
    let usageChanged = false;
    if (p.rateLimits) {
      const next: UsageDto = { fiveHour: p.rateLimits.fiveHour ?? before.fiveHour, sevenDay: p.rateLimits.sevenDay ?? before.sevenDay, updatedAt: at };
      usageChanged = !sameWindow(next.fiveHour, before.fiveHour) || !sameWindow(next.sevenDay, before.sevenDay) || before.updatedAt === null;
      this.state.set(accountId, next);
    }
    return { usage: this.of(accountId), usageChanged, providerSessionId: p.providerSessionId, accountId };
  }
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/server/src/usage packages/server/src/db 2>&1 | tail -6 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS（既存の statusline の試験と、移行の版を数える `db.test.ts` も含む）、型検査はエラーなし。`db.test.ts` が版の数字を直書きしていて落ちたら、その数字を 15 に直す。

- [ ] **Step 6: コミット**

```bash
git commit packages/server/src/db/migrations.ts packages/server/src/usage/statusline.ts packages/server/src/usage/statusline.test.ts -m "feat(server): keep rate-limit usage per account instead of one shared value

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（`db.test.ts` を直したなら、パスに足す。）

---

### Task 7: HTTP とイベント、サーバへの組み込み

**Files:**
- Create: `packages/server/src/http/accounts.ts`
- Test: `packages/server/src/http/accounts.test.ts`
- Modify: `packages/server/src/http/app.ts`（依存の型、bootstrap、`/ingest/statusline`、`/sessions/:id/resume` の下に 1 行、ルートの取り付け）
- Modify: `packages/server/src/server.ts`（`AccountStore`・`AccountAuth` の生成、`RunManager` と `UsageTracker` への受け渡し、`createApp` への受け渡し）

**Interfaces:**
- Consumes: Task 1〜6 のすべて
- Produces（HTTP、どれも既存の `/api` の Bearer 認証の内側）:
  - `GET /api/accounts` → `AccountsDto`
  - `POST /api/accounts` `{ name: string; dir?: string }` → 201 `AccountsDto`（置き場を作ってリンクを張る。`dir` を付けると既にある置き場を登録する）
  - `PATCH /api/accounts/:id` `{ name?: string; color?: string }` → `AccountsDto`
  - `DELETE /api/accounts/:id` → `AccountsDto`（登録だけ外す）
  - `PUT /api/accounts/current` `{ id: string }` → `AccountsDto`
  - `POST /api/accounts/:id/login` → 202 `AccountsDto`（`claude auth login` を起こす）
  - `POST /api/accounts/:id/refresh` → `AccountsDto`（`claude auth status` を読み直す）
  - `POST /api/sessions/:id/switch-account` `{ account: string }` → 201 `LaunchResult`（成功したら、いまのアカウントもそれにする）
  - 変わるたびに `{ type: 'accounts.update', accounts }` を配る
- Produces（コード）:
  - `buildAccountsDto(deps: AccountsDeps): AccountsDto`
  - `accountsRoutes(api: Hono, deps: AccountsDeps): void`
  - `type AccountsDeps = { db: Db; store: AccountStore; auth: AccountAuth; usage: UsageTracker; runs: Pick<RunManager, 'switchAccount'>; primaryDir: string; broadcast: (accounts: AccountsDto) => void }`

- [ ] **Step 1: 失敗する試験を書く**

`packages/server/src/http/accounts.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsDto } from '@agent-hangar/shared';
import { AccountAuth, type RunClaude } from '../config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { RunError } from '../runs/manager.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { accountsRoutes, type AccountsDeps } from './accounts.ts';

let db: Db;
let home: string;
let userHome: string;
let primaryDir: string;
let store: AccountStore;
let app: Hono;
let sent: AccountsDto[];
let switchAccount: ReturnType<typeof vi.fn>;
const OK = JSON.stringify({ loggedIn: true, email: 'taro@example.ac.jp', orgName: 'Example University', subscriptionType: 'enterprise' });
const run: RunClaude = async (_b, args) => ({ code: 0, stdout: args[1] === 'status' ? OK : '' });
const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as AccountsDto & { error?: string } };
};

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ah-home-'));
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ah-user-'));
  primaryDir = path.join(userHome, '.claude');
  fs.mkdirSync(path.join(primaryDir, 'projects'), { recursive: true });
  store = new AccountStore({ home, primaryDir, homeDir: userHome });
  sent = [];
  switchAccount = vi.fn(async (sessionId: string) => ({ sessionId, run: { id: 'r9' }, tabs: [] }));
  const deps: AccountsDeps = {
    db, store, primaryDir,
    auth: new AccountAuth({ claudeBin: () => '/bin/claude', run }),
    usage: new UsageTracker(db, { accountOf: () => 'primary' }),
    runs: { switchAccount } as unknown as AccountsDeps['runs'],
    broadcast: (a) => sent.push(a),
  };
  app = new Hono();
  accountsRoutes(app, deps);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(userHome, { recursive: true, force: true });
});

describe('アカウントの HTTP', () => {
  it('はじめは最初のアカウントだけ', async () => {
    const r = await call('GET', '/accounts');
    expect(r.status).toBe(200);
    expect(r.json.currentId).toBe('primary');
    expect(r.json.accounts).toHaveLength(1);
    expect(r.json.accounts[0]).toMatchObject({ id: 'primary', primary: true, dir: primaryDir, loginRunning: false, linkProblem: null });
    expect(r.json.sessions).toEqual({});
  });

  it('追加すると置き場を作ってリンクを張り、認証を読み、配る', async () => {
    const r = await call('POST', '/accounts', { name: '大学' });
    expect(r.status).toBe(201);
    const a = r.json.accounts[1]!;
    expect(a).toMatchObject({ name: '大学', primary: false, dir: path.join(userHome, '.claude-2'), linkProblem: null });
    expect(fs.readlinkSync(path.join(a.dir, 'projects'))).toBe(path.join(primaryDir, 'projects'));
    expect(a.auth).toMatchObject({ loggedIn: true, email: 'taro@example.ac.jp', plan: 'enterprise' });
    expect(sent.at(-1)?.accounts).toHaveLength(2);
  });

  it('既にある置き場を登録するとき、リンクの場所に実物があれば linkProblem に出す（登録は通す）', async () => {
    const dir = path.join(userHome, '.claude-univ');
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const r = await call('POST', '/accounts', { name: '大学', dir });
    expect(r.status).toBe(201);
    expect(r.json.accounts[1]!.linkProblem).toContain('projects');
  });

  it('名前の重複と形の違う本文は 400、知らない id は 404', async () => {
    await call('POST', '/accounts', { name: '大学' });
    expect((await call('POST', '/accounts', { name: '大学' })).status).toBe(400);
    expect((await call('POST', '/accounts', { name: 5 })).status).toBe(400);
    expect((await call('PATCH', '/accounts/nope', { name: 'x' })).status).toBe(404);
    expect((await call('PUT', '/accounts/current', { id: 'nope' })).status).toBe(404);
    expect((await call('DELETE', '/accounts/primary')).status).toBe(400);
  });

  it('いまのアカウントを変え、名前を変え、消す', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    expect((await call('PUT', '/accounts/current', { id })).json.currentId).toBe(id);
    expect((await call('PATCH', `/accounts/${id}`, { name: '学校' })).json.accounts[1]!.name).toBe('学校');
    const r = await call('DELETE', `/accounts/${id}`);
    expect(r.json.accounts).toHaveLength(1);
    expect(r.json.currentId).toBe('primary');
  });

  it('login は 202 で返し、refresh は認証を読み直す', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    expect((await call('POST', `/accounts/${id}/login`)).status).toBe(202);
    expect((await call('POST', `/accounts/${id}/refresh`)).json.accounts[1]!.auth?.loggedIn).toBe(true);
  });

  it('最初のアカウント以外で最後に動かしたセッションを sessions に載せる', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111111', '/w', 'd');
    upsertShared(db, 'runs', { id: 'r1', session_id: s, device_id: 'd', kind: 'start', tmux_name: 't', pid: null, launch_params: JSON.stringify({ account: id }), started_at: 1, ended_at: 2, end_reason: 'exited', heartbeat_at: 1 }, 'd');
    expect((await call('GET', '/accounts')).json.sessions).toEqual({ [s]: id });
  });

  it('セッションの切り替えは RunManager に渡し、成功したらいまのアカウントも変える', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    const res = await app.request('/sessions/s1/switch-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: id }) });
    expect(res.status).toBe(201);
    expect(switchAccount).toHaveBeenCalledWith('s1', id);
    expect(store.current().id).toBe(id);
  });

  it('切り替えを断られたら、その状態と文言を返し、いまのアカウントは変えない', async () => {
    const id = (await call('POST', '/accounts', { name: '大学' })).json.accounts[1]!.id;
    switchAccount.mockRejectedValueOnce(new RunError(409, '前の Claude がまだ終わっていません'));
    const res = await app.request('/sessions/s1/switch-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: id }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('まだ終わっていません');
    expect(store.current().id).toBe('primary');
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/http/accounts.test.ts 2>&1 | tail -5`
Expected: FAIL（`./accounts.ts` が無い）。

- [ ] **Step 3: ルートを実装する**

`packages/server/src/http/accounts.ts`：

```ts
import type { Context, Hono } from 'hono';
import type { AccountsDto } from '@agent-hangar/shared';
import type { AccountAuth } from '../config/accountAuth.ts';
import { ensureAccountLinks, linkProblem } from '../config/accountLinks.ts';
import { AccountError, PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import { sessionAccounts } from '../db/queries.ts';
import { RunError, type RunManager } from '../runs/manager.ts';
import type { UsageTracker } from '../usage/statusline.ts';

export type AccountsDeps = { db: Db; store: AccountStore; auth: AccountAuth; usage: UsageTracker; runs: Pick<RunManager, 'switchAccount'>; primaryDir: string; broadcast: (accounts: AccountsDto) => void };

/** 置き場のリンクの具合。欠けているリンクはここで張り直し、別のものが置かれている項目だけを問題として返す。 */
function problemOf(primaryDir: string, a: Account): string | null {
  if (a.id === PRIMARY_ACCOUNT_ID) return null;
  try { return linkProblem(ensureAccountLinks(primaryDir, a.dir).conflicts); } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export function buildAccountsDto(deps: AccountsDeps): AccountsDto {
  const known = new Set(deps.store.list().map((a) => a.id));
  const sessions: Record<string, string> = {};
  for (const [sid, aid] of Object.entries(sessionAccounts(deps.db))) if (known.has(aid)) sessions[sid] = aid;
  return {
    currentId: deps.store.current().id,
    accounts: deps.store.list().map((a) => ({
      ...a, primary: a.id === PRIMARY_ACCOUNT_ID, auth: deps.auth.get(a.id), usage: deps.usage.of(a.id), loginRunning: deps.auth.loginRunning(a.id), linkProblem: problemOf(deps.primaryDir, a),
    })),
    sessions,
  };
}

const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const v: unknown = await c.req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
};

export function accountsRoutes(api: Hono, deps: AccountsDeps): void {
  const dto = () => buildAccountsDto(deps);
  const changed = () => { const d = dto(); deps.broadcast(d); return d; };
  /** AccountError と RunError を、その状態の JSON にして返す。 */
  const guard = async (c: Context, fn: () => Promise<Response> | Response): Promise<Response> => {
    try { return await fn(); } catch (e) {
      if (e instanceof AccountError || e instanceof RunError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };
  const must = (id: string): Account => {
    const a = deps.store.get(id);
    if (!a) throw new AccountError(404, 'アカウントが見つかりません');
    return a;
  };

  api.get('/accounts', (c) => c.json(dto()));

  api.post('/accounts', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.name !== 'string' || (b.dir !== undefined && typeof b.dir !== 'string')) throw new AccountError(400, 'name（文字列）と、任意で dir（絶対パス）を送ってください');
    const a = deps.store.add({ name: b.name, dir: b.dir as string | undefined });
    // 置き場とリンクはここで作る。リンクの場所に別のものがあっても登録は通し、linkProblem として見せる。
    ensureAccountLinks(deps.primaryDir, a.dir);
    await deps.auth.refresh(a);
    return c.json(changed(), 201);
  }));

  api.put('/accounts/current', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.id !== 'string') throw new AccountError(400, 'id を送ってください');
    deps.store.setCurrent(b.id);
    return c.json(changed());
  }));

  api.patch('/accounts/:id', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    const patch: { name?: string; color?: string } = {};
    if (b.name !== undefined) { if (typeof b.name !== 'string') throw new AccountError(400, 'name は文字列で送ってください'); patch.name = b.name; }
    if (b.color !== undefined) { if (typeof b.color !== 'string') throw new AccountError(400, 'color は文字列で送ってください'); patch.color = b.color; }
    deps.store.update(c.req.param('id'), patch);
    return c.json(changed());
  }));

  api.delete('/accounts/:id', (c) => guard(c, () => {
    const id = c.req.param('id');
    deps.store.remove(id);
    deps.auth.forget(id);
    return c.json(changed());
  }));

  api.post('/accounts/:id/login', (c) => guard(c, () => {
    const a = must(c.req.param('id'));
    ensureAccountLinks(deps.primaryDir, a.dir);
    deps.auth.login(a);
    return c.json(changed(), 202);
  }));

  api.post('/accounts/:id/refresh', (c) => guard(c, async () => {
    await deps.auth.refresh(must(c.req.param('id')));
    return c.json(changed());
  }));

  api.post('/sessions/:id/switch-account', (c) => guard(c, async () => {
    const b = await bodyOf(c);
    if (typeof b.account !== 'string') throw new AccountError(400, 'account を送ってください');
    const result = await deps.runs.switchAccount(c.req.param('id'), b.account);
    // セッション画面で選んだら、新しいセッションの既定もそのアカウントにする（設計書の決定）。
    deps.store.setCurrent(b.account);
    changed();
    return c.json(result as object, 201);
  }));
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server/src/http/accounts.test.ts 2>&1 | tail -5`
Expected: 9 件 PASS。

- [ ] **Step 5: app.ts に取り付ける**

`packages/server/src/http/app.ts`：

1. import に足す。

```ts
import { accountsRoutes, buildAccountsDto, type AccountsDeps } from './accounts.ts';
```

2. `createApp` の依存の型（`deps` の型定義。`cloudUsage?:` を持つもの）に、任意の項目として足す。

```ts
  /** アカウントの一覧と切り替え。渡さなければ、アカウントの口は生えない（古い試験の組み立てのため）。 */
  accounts?: Omit<AccountsDeps, 'db' | 'usage' | 'runs' | 'broadcast'>;
```

3. `const beforeLaunch = ...` の定義の後ろに足す。

```ts
  const accountsDeps: AccountsDeps | null = deps.accounts
    ? { ...deps.accounts, db, usage: deps.usage, runs: deps.runs, broadcast: (accounts) => deps.hub.broadcast({ type: 'accounts.update', accounts }) }
    : null;
  if (accountsDeps) accountsRoutes(api, accountsDeps);
```

4. `/bootstrap` の `body` の `cloudUsage: ...` の次の行に足す。

```ts
      accounts: accountsDeps ? buildAccountsDto(accountsDeps) : undefined,
```

5. `/ingest/statusline` の `if (r.usageChanged) deps.hub.broadcast({ type: 'usage.update', usage: r.usage });` を、次で置き換える。`usage.update` は最初のアカウントの値だけを運ぶ（古い画面がそのまま動くため）。

```ts
    if (r.usageChanged) {
      if (r.accountId === 'primary') deps.hub.broadcast({ type: 'usage.update', usage: r.usage });
      if (accountsDeps) accountsDeps.broadcast(buildAccountsDto(accountsDeps));
    }
```

- [ ] **Step 6: server.ts で組み立てる**

`packages/server/src/server.ts`：

1. import に足す。

```ts
import { AccountAuth } from './config/accountAuth.ts';
import { AccountStore } from './config/accounts.ts';
import { accountOfSession } from './db/queries.ts';
```

（`./db/queries.ts` からの import が既にあれば、その行に足す。）

2. `const runs = new RunManager({` の直前に足す。

```ts
  // Claude Code のアカウント。置き場ごとのログインを切り替えるだけで、認証の中身は持たない。
  const accountStore = new AccountStore({ home, primaryDir: claudeDir });
  const accountAuth = new AccountAuth({ claudeBin: () => claudeBinOf(settings) });
```

3. `new RunManager({ ... })` の引数の末尾に `accounts: accountStore,` を足す。

4. `const usage = new UsageTracker(db);` を、次で置き換える。

```ts
  // statusline の payload からはアカウントが分からない（本文の置き場は共有）ので、セッションの最後の run から引く。
  // hangar の外で起こしたセッションと、消したアカウントの run は、最初のアカウントとして数える。
  const usage = new UsageTracker(db, {
    accountOf: (providerSessionId) => {
      if (!providerSessionId) return 'primary';
      const s = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined;
      const id = s ? accountOfSession(db, s.id) : null;
      return id && accountStore.get(id) ? id : 'primary';
    },
  });
```

5. `createApp({` の引数に足す（`cloudUsage,` の次の行）。

```ts
    accounts: { store: accountStore, auth: accountAuth, primaryDir: claudeDir },
```

6. サーバが listen を始めた後（`started = true` を立てている箇所の近く。起動を遅らせないよう await しない）に足す。

```ts
  // 認証の状態は claude に聞くので数秒かかる。起動は待たせず、読めたら画面へ配る。
  void Promise.all(accountStore.list().map((a) => accountAuth.refresh(a))).then(() => hub.broadcast({ type: 'accounts.update', accounts: buildAccountsDto({ db, store: accountStore, auth: accountAuth, usage, runs, primaryDir: claudeDir, broadcast: () => {} }) }));
```

そのために `import { buildAccountsDto } from './http/accounts.ts';` を足す。

- [ ] **Step 7: 全体を確かめる**

Run: `npx vitest run packages/server packages/shared 2>&1 | tail -6 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS、型検査はエラーなし。UI のパッケージが `ServerEvent` の網羅の検査（`never` への代入など）で `accounts.update` を知らずに型で落ちたら、その switch に `case 'accounts.update': return null;`（その関数の「何もしない」の返し方に合わせる）を足す。画面の扱いは次の計画で入れる。

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/http/accounts.ts packages/server/src/http/accounts.test.ts
git commit packages/server/src/http/accounts.ts packages/server/src/http/accounts.test.ts packages/server/src/http/app.ts packages/server/src/server.ts -m "feat(server): expose accounts over HTTP and route usage to the account that produced it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（UI の switch を直したなら、そのファイルもパスに足す。）

---

### Task 8: MCP と文書、実物の確かめ

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`（`getUsageTool`）
- Test: `packages/server/src/mcp/tools.test.ts`（`get_usage` の試験の近くに追加）
- Modify: `README.md`（「`CLAUDE_CONFIG_DIR` と `HANGAR_CLAUDE_DIR` は別物です」の項の後ろ）
- Modify: `docs/superpowers/specs/2026-10-06-account-switch-design.md`（「アカウントの追加」の 3）

**Interfaces:**
- Consumes: `UsageTracker.of`、`AccountStore`（Task 1、6）
- Produces: MCP の `get_usage` の応答に `accounts: { name: string; current: boolean; five_hour; seven_day; updated_at }[]` が加わる（今までの `five_hour`・`seven_day`・`updated_at` は最初のアカウントの値のまま残す）

- [ ] **Step 1: MCP の失敗する試験を書く**

`packages/server/src/mcp/tools.test.ts` を開き、`get_usage` を呼んでいる既存の試験の組み立て（deps の作り方）を写して、その隣に足す。deps に `accounts`（`AccountStore`）を渡す口が無ければ、`getUsageTool` が読む deps の型に `accounts?: AccountStore` を足す前提で書く。

```ts
  it('get_usage はアカウントごとの値も返す。上の 3 つは最初のアカウントのまま', async () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-user-'));
    const accounts = new AccountStore({ home, primaryDir: path.join(userHome, '.claude'), homeDir: userHome });
    const a = accounts.add({ name: '大学' });
    accounts.setCurrent(a.id);
    const usage = new UsageTracker(db, { accountOf: (sid) => (sid === 'u' ? a.id : 'primary') });
    usage.ingest({ session_id: 'w', rate_limits: { five_hour: { used_percentage: 82, resets_at: 1 }, seven_day: { used_percentage: 41, resets_at: 2 } } });
    usage.ingest({ session_id: 'u', rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 }, seven_day: { used_percentage: 9, resets_at: 2 } } });
    const out = await callGetUsage({ usage, accounts });
    expect(out.five_hour.used_percentage).toBe(82);
    expect(out.accounts.map((x: { name: string; current: boolean; five_hour: { used_percentage: number } }) => [x.name, x.current, x.five_hour.used_percentage])).toEqual([['メイン', false, 82], ['大学', true, 12]]);
    fs.rmSync(userHome, { recursive: true, force: true });
  });
```

`callGetUsage` は、そのファイルの既存の `get_usage` の試験がツールを呼んで JSON を取り出している手順を、`usage` と `accounts` を差し替えられる小さな関数にまとめたものである。既存の試験が使っている呼び方（`callTool(deps, ctx, 'get_usage', {})` など）をそのまま使い、返り値の本文を `JSON.parse` して返す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/server/src/mcp/tools.test.ts -t get_usage 2>&1 | tail -6`
Expected: 新しい 1 件が FAIL（`accounts` が応答に無い）。

- [ ] **Step 3: get_usage を直す**

`packages/server/src/mcp/tools.ts` の `getUsageTool` を開く。今の応答（`five_hour`、`seven_day`、`updated_at`）を作っている部分を、窓 1 つを応答の形にする小さな関数にまとめ、同じ関数で `accounts` を足す。ツールの deps の型に `accounts?: AccountStore` を足し、`packages/server/src/mcp/app.ts` と `server.ts` の MCP の組み立てで `accounts: accountStore` を渡す。

```ts
/** UsageDto を MCP の応答の形にする。 */
const usageBody = (u: UsageDto) => ({
  five_hour: u.fiveHour ? { used_percentage: u.fiveHour.usedPercent, resets_at: u.fiveHour.resetsAt } : null,
  seven_day: u.sevenDay ? { used_percentage: u.sevenDay.usedPercent, resets_at: u.sevenDay.resetsAt } : null,
  updated_at: u.updatedAt,
});
```

`getUsageTool` の返す本文は次の形にする（今の関数が結果を包んでいる書き方に合わせる）。

```ts
  const currentId = deps.accounts?.current().id ?? 'primary';
  const body = {
    ...usageBody(deps.usage.current()),
    accounts: (deps.accounts?.list() ?? []).map((a) => ({ name: a.name, current: a.id === currentId, ...usageBody(deps.usage.of(a.id)) })),
  };
```

今の応答の項目名や null の表し方が上と違っていたら、今の形を正とし、`usageBody` をそれに合わせる（既存の `get_usage` の試験が通ることが条件である）。メールアドレスは応答に入れない。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/server 2>&1 | tail -6 && npm run typecheck 2>&1 | tail -3`
Expected: すべて PASS、型検査はエラーなし。

- [ ] **Step 5: 文書を直す**

`README.md` の「`CLAUDE_CONFIG_DIR` と `HANGAR_CLAUDE_DIR` は別物です」の項の直後に、次の項を足す（番号は前の項の続きにする）。

```markdown
7. **アカウントを足すと、2 つ目以降の置き場（`~/.claude-2` など）の中身は `~/.claude` へのリンクになります。** 設定・スキル・履歴は共有で、別になるのは認証（Keychain の項目と `.claude.json`）だけです。hangar はトークンを読みません。渡すのは `CLAUDE_CONFIG_DIR` だけで、ログインは `claude auth login` に任せます。リンクの場所に実ファイルがあると起動を断ります。中身を確かめて、要らなければ消してください。
```

`docs/superpowers/specs/2026-10-06-account-switch-design.md` の「アカウントの追加」の 3 を、実装に合わせて次で置き換える。

```markdown
3. hangar が `claude auth login` を子プロセスで起こす（環境変数に置き場を入れる）。ブラウザは claude が開き、承認は利用者が行う。ターミナルのタブは開かない。コードを貼る形（ブラウザが手元に戻れないとき）になる環境では、設定に出すコマンドを利用者がターミナルで打つ。
```

- [ ] **Step 6: 実物で確かめる（読むだけ）**

実物の `~/.agent-hangar` と、利用者の動いているサーバ（4177）には触らない。使い捨ての hangar の置き場で確認用のサーバを立て、アカウントの口だけを叩く。Claude は起こさない。

```bash
export CHECK_HOME=$(mktemp -d) CHECK_PORT=4199
env -u HANGAR_PARENT_PID -u HANGAR_RUN_ID -u HANGAR_UI_DIST -u HANGAR_CLOUD_DIR HANGAR_HOME=$CHECK_HOME HANGAR_PORT=$CHECK_PORT npm run dev --workspace packages/server > $CHECK_HOME/server.log 2>&1 &
echo $! > $CHECK_HOME/pid
```

起動のログ（`$CHECK_HOME/server.log`）に 4199 で待ち受けた行が出るのを待つ。別のポートで立ち上がっていたら、その番号を使う。

```bash
TOKEN=$(cat $CHECK_HOME/token)
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:$CHECK_PORT/api/accounts | python3 -m json.tool | sed -E 's/"email": "[^"@]*/"email": "***/'
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"name\":\"大学\",\"dir\":\"$HOME/.claude-univ\"}" http://127.0.0.1:$CHECK_PORT/api/accounts | python3 -m json.tool | sed -E 's/"email": "[^"@]*/"email": "***/'
```

Expected:
- 1 つ目：`primary` のアカウントが 1 つ。数秒後にもう一度叩くと `auth.loggedIn` が true で、`plan` が入っている。
- 2 つ目：201。`大学` のアカウントが増え、`auth.plan` が `enterprise`、`linkProblem` が null。`~/.claude-univ` の中のリンクは増えも減りもしない（`ls -la ~/.claude-univ | grep -c '^l'` が前後で同じ 17）。

後始末は、自分が起こしたプロセスだけを止める。ポートでは止めない。

```bash
kill $(cat $CHECK_HOME/pid)
```

確かめた結果（応答の要点と、リンクの数）を報告に書く。`~/.claude-univ` が無い PC では 2 つ目を飛ばし、その旨を書く。

- [ ] **Step 7: コミット**

```bash
git commit packages/server/src/mcp/tools.ts packages/server/src/mcp/tools.test.ts packages/server/src/mcp/app.ts packages/server/src/server.ts README.md docs/superpowers/specs/2026-10-06-account-switch-design.md -m "feat(server): report usage per account over MCP and document how accounts share one config dir

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（触っていないファイルはパスから外す。）
