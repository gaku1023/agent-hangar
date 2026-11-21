# 選ぶ部品の作り直し Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ブラウザ標準の `select` と `checkbox` を、ガラスの一覧、切り替えの帯、スイッチ、チップ、意味を添えたカード、増減のボタンに差し替え、新しいセッションの model、effort、permission mode を選べる欄にする。

**Architecture:** 共通の部品を `packages/ui/src/views/primitives/` に 6 つ作り（Listbox、Segmented、Switch、Chip、OptionCard、Stepper）、見た目は新しい `styles/controls.css` にまとめる。
Listbox の並べ方、一致の塗り、置き場所の計算は、DOM を持たない純粋な関数（`listboxModel.ts`）に切り出して単体で試す。
各画面は部品を差し込むだけにし、状態は画面の `useState` か props で持つ（部品は値を持たない）。

**Tech Stack:** React 19、TypeScript、vitest、@testing-library/react、jsdom、lucide-react、CSS（トークンは `styles/tokens.css`）。

**Spec:** `docs/superpowers/specs/2026-09-30-choice-controls-design.md`（試作は `docs/superpowers/specs/2026-09-29-ui-refresh/choice-controls.html`）

## Global Constraints

- 作業はすべて worktree `/Users/me/workspace/agent-hangar-choice-controls`（ブランチ `choice-controls`）で行う。元の `/Users/me/workspace/agent-hangar` には触らない。
- 依存を足さない。見た目のない部品集（React Aria、Radix）は入れない。
- UI は常にライト。ダークモードの指定を書かない。
- `backdrop-filter` は `glass.test.ts` の `GLASS` にある選択子の規則にだけ書き、必ず `-webkit-backdrop-filter` を併記する。
- `transition` と `animation` の長さは `--dur-fast`、`--dur`、`--dur-exit` を通して書き、数値を直書きしない（`motion.test.ts`）。
- View は `lucide-react` を直接 import せず、`views/primitives/Icon.tsx` の名前だけを使う。
- コードのコメントは日本語で、周りのコードと同じ密度と口調（「〜する」「〜ため」）にする。
- 日本語の変換を確定する Enter は `views/ime.ts` の `isComposing` で見分け、決定や送信に使わない。
- テストの実行は `/Users/me/workspace/agent-hangar-choice-controls` で `npx vitest run <path>`。型は `npm run typecheck -w packages/ui`。
- コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## Review Focus

- **開いたまま窓の大きさや画面のスクロールが変わる**：一覧は顔に付いて動く。Task 3 に resize で位置を計り直す試験を足す。
- **開いている間に選択肢が減る**（プロジェクトの一覧がサーバから更新される）：選ばれかけの行が範囲の外に出ても、Enter で落ちず、残った行を選ぶ。Task 3 に試験を足す。
- **開いたまま顔が消える**（起動してダイアログが閉じる）：`document.body` に一覧と外側のクリックの監視が残らない。Task 3 に試験を足す。
- **カードの中の一覧で行を押す**：portal の中の click は React の木で親へ泡立つので、プロジェクトが開いてはいけない。Task 8 に試験を足す。
- **一覧を 2 つ並べて、開いたまま別の顔を押す**：先に開いていたほうが閉じ、開いている一覧は常に 1 つ。Task 3 に試験を足す。

---

## File Structure

新しく作るもの：

| ファイル | 役目 |
|---|---|
| `packages/ui/src/views/primitives/listboxModel.ts` | Listbox の選択肢の型、検索の一致、群への並べ方、一致の塗り分け、置き場所の計算。DOM を持たない |
| `packages/ui/src/views/primitives/Listbox.tsx` | ガラスの一覧の部品 |
| `packages/ui/src/views/primitives/Segmented.tsx` | 切り替えの帯 |
| `packages/ui/src/views/primitives/Switch.tsx` | スイッチ |
| `packages/ui/src/views/primitives/Chip.tsx` | 押すと灯るチップ（`ToggleChip`）と択一のチップ（`ChoiceChips`） |
| `packages/ui/src/views/primitives/OptionCard.tsx` | 択一のカード（`OptionCards`）と複数選択のカード（`CheckCard`） |
| `packages/ui/src/views/primitives/Stepper.tsx` | 増減のボタン |
| `packages/ui/src/styles/controls.css` | 上の部品の見た目 |
| `packages/ui/src/test/pick.ts` | 試験の補助。Listbox を開いて行を選ぶ |

それぞれに `*.test.ts(x)` を並べて置く。

変えるもの：`Icon.tsx`、`tokens.css`、`base.css`（ステータスの札）、`workbench.css`（TODO）、`settings.css`、`main.tsx`（CSS の読み込み）、`glass.test.ts`、`StatusSelect.tsx`、`NewSessionDialog.tsx`、`presenters/newSession.ts`、`Root.tsx`、`SessionsScreen.tsx`、`SessionScreen.tsx`、`SettingsScreen.tsx`、`PromoteDialog.tsx`、`TodoList.tsx`、`docs/design.md`、および各画面の試験。

---

### Task 1: アイコン、controls.css の土台、Switch

**Files:**
- Modify: `packages/ui/src/views/primitives/Icon.tsx`
- Modify: `packages/ui/src/styles/tokens.css`
- Modify: `packages/ui/src/main.tsx`
- Create: `packages/ui/src/styles/controls.css`
- Create: `packages/ui/src/views/primitives/Switch.tsx`
- Test: `packages/ui/src/views/primitives/Switch.test.tsx`

**Interfaces:**
- Produces: アイコンの名前 `check`、`search`、`minus`、`thinking`、`rawLog`、`permissionDefault`、`permissionManual`、`permissionAcceptEdits`、`permissionPlan`、`permissionAuto`、`permissionDontAsk`、`permissionBypass`、`gitInit`、`moveFiles`、`appWindow`。
- Produces: トークン `--glass-bg-menu`。
- Produces: `export function Switch(props: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }): JSX.Element`

- [ ] **Step 1: Switch の試験を書く**

`packages/ui/src/views/primitives/Switch.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch.tsx';

describe('Switch', () => {
  it('switch の役割と、いまの値を aria-checked に出す', () => {
    render(<Switch label="Claude へ切り替える" checked onChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'Claude へ切り替える' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
  it('押すと反転した値を渡す', () => {
    const onChange = vi.fn();
    render(<Switch label="s" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 's' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('押せないときは値を渡さない', () => {
    const onChange = vi.fn();
    render(<Switch label="s" checked={false} disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 's' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Switch.test.tsx`
Expected: FAIL（`./Switch.tsx` が無い）

- [ ] **Step 3: アイコンを足す**

`Icon.tsx` の import に `AppWindow, Ban, Brain, Check, FileJson2, FilePenLine, FolderInput, GitBranch, Map, MessageCircleQuestion, Minus, Search, Settings2, ShieldAlert, Sparkles` を足し（既存の並びに合わせてアルファベット順）、`ICONS` の末尾に次を足す。

```ts
  check: Check,
  search: Search,
  minus: Minus,
  thinking: Brain,
  rawLog: FileJson2,
  permissionDefault: Settings2,
  permissionManual: MessageCircleQuestion,
  permissionAcceptEdits: FilePenLine,
  permissionPlan: Map,
  permissionAuto: Sparkles,
  permissionDontAsk: Ban,
  permissionBypass: ShieldAlert,
  gitInit: GitBranch,
  moveFiles: FolderInput,
  appWindow: AppWindow,
```

`Map` は JavaScript の組み込みの `Map` を隠すので、`import { ..., Map as MapIcon, ... }` として `permissionPlan: MapIcon` にする。

- [ ] **Step 4: トークンと CSS の土台を足す**

`tokens.css` の `--glass-bg-toast` の次の行に足す。

```css
  --glass-bg-menu: rgba(255, 255, 255, 0.82);
```

`packages/ui/src/styles/controls.css` を作る。

```css
/* 選ぶ部品（一覧、切り替えの帯、スイッチ、チップ、カード、増減）。
   形と値は docs/superpowers/specs/2026-09-29-ui-refresh/choice-controls.html の試作に合わせる。 */

/* スイッチ。押している間は玉が少し横に伸びる。 */
.switch { position: relative; flex: none; width: 36px; height: 22px; padding: 0; border: 0; border-radius: var(--r-pill); background: #d5d7e3; box-shadow: inset 0 1px 2px rgba(30, 40, 90, 0.12); cursor: pointer; transition: background var(--dur) var(--ease-out); }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 3px rgba(30, 40, 90, 0.3); transition: transform var(--dur) var(--ease-out), width var(--dur-fast) var(--ease-out); }
.switch:active:not(:disabled)::after { width: 22px; }
.switch[aria-checked='true'] { background: linear-gradient(180deg, var(--accent-hi), var(--accent)); }
.switch[aria-checked='true']::after { transform: translateX(14px); }
.switch[aria-checked='true']:active:not(:disabled)::after { transform: translateX(10px); }
.switch:disabled { opacity: 0.5; cursor: default; }
```

`main.tsx` の `import './styles/sync.css';` の次に `import './styles/controls.css';` を足す。

- [ ] **Step 5: Switch を書く**

`packages/ui/src/views/primitives/Switch.tsx`：

```tsx
/** オン・オフの設定に使うスイッチ。値は持たず、押されたら反転した値を親へ渡す。 */
export function Switch(props: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-label={props.label} aria-checked={props.checked} disabled={props.disabled} onClick={() => props.onChange(!props.checked)} />;
}
```

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives packages/ui/src/styles`
Expected: PASS（Icon の「どの名前も描ける」も新しい名前で通る）

- [ ] **Step 7: コミット**

```bash
git add packages/ui/src/views/primitives/Icon.tsx packages/ui/src/views/primitives/Switch.tsx packages/ui/src/views/primitives/Switch.test.tsx packages/ui/src/styles/tokens.css packages/ui/src/styles/controls.css packages/ui/src/main.tsx
git commit -m "feat(ui): add the switch and the icons the choice controls need"
```

---

### Task 2: Listbox の並べ方と置き場所（listboxModel.ts）

**Files:**
- Create: `packages/ui/src/views/primitives/listboxModel.ts`
- Test: `packages/ui/src/views/primitives/listboxModel.test.ts`

**Interfaces:**
- Consumes: `IconName`（Task 1）、`ProjectStatus`（`@agent-hangar/shared`）。
- Produces:

```ts
export type ListboxOption = { value: string; label: string; sub?: string; subKind?: 'path' | 'prose'; meta?: string; status?: ProjectStatus; icon?: IconName; danger?: boolean };
export type ListboxGroup = { title: string; values: string[] };
export type ListboxSection = { title: string | null; items: { option: ListboxOption; index: number }[] };
export type Segment = { text: string; hit: boolean };
export type Placement = { left: number; width: number; top?: number; bottom?: number; up: boolean };
export const SEARCH_MIN = 8;
export function matches(option: ListboxOption, query: string): boolean;
export function arrangeSections(options: ListboxOption[], groups: ListboxGroup[] | undefined, query: string): ListboxSection[];
export function highlight(text: string, query: string): Segment[];
export function place(face: { top: number; bottom: number; left: number; width: number }, popupHeight: number, viewport: { width: number; height: number }, opts?: { minWidth?: number; align?: 'start' | 'end' }): Placement;
```

- [ ] **Step 1: 試験を書く**

`packages/ui/src/views/primitives/listboxModel.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { arrangeSections, highlight, matches, place, type ListboxOption } from './listboxModel.ts';

const o = (value: string, sub?: string): ListboxOption => ({ value, label: value, sub });
const flat = (s: ReturnType<typeof arrangeSections>) => s.map((x) => [x.title, x.items.map((i) => `${i.index}:${i.option.value}`)]);

describe('matches', () => {
  it('名前か補足に、大文字小文字を区別せずに含まれれば残す', () => {
    expect(matches(o('Agent-Hangar', '~/w/agent-hangar'), 'hang')).toBe(true);
    expect(matches(o('alpha', '~/work/x'), 'WORK')).toBe(true);
    expect(matches(o('alpha', '~/w/x'), 'zzz')).toBe(false);
  });
  it('空白だけの問い合わせは全件に一致する', () => {
    expect(matches(o('alpha'), '  ')).toBe(true);
  });
});

describe('arrangeSections', () => {
  const opts = [o('a'), o('b'), o('c'), o('d')];
  it('群が無ければ見出しなしの 1 節で、通し番号を振る', () => {
    expect(flat(arrangeSections(opts, undefined, ''))).toEqual([[null, ['0:a', '1:b', '2:c', '3:d']]]);
  });
  it('群の順に並べ、通し番号は群をまたいで続く', () => {
    const groups = [{ title: '最近', values: ['c', 'a'] }, { title: 'すべて', values: ['b', 'd'] }];
    expect(flat(arrangeSections(opts, groups, ''))).toEqual([['最近', ['0:c', '1:a']], ['すべて', ['2:b', '3:d']]]);
  });
  it('空の群は出さず、群に入っていない項目は最後に見出しなしで置く', () => {
    const groups = [{ title: '最近', values: [] }, { title: 'すべて', values: ['b'] }];
    expect(flat(arrangeSections(opts, groups, ''))).toEqual([['すべて', ['0:b']], [null, ['1:a', '2:c', '3:d']]]);
  });
  it('検索で絞っている間は群を解き、一致した項目を元の並びで 1 列にする', () => {
    const groups = [{ title: '最近', values: ['c'] }, { title: 'すべて', values: ['a', 'b', 'd'] }];
    const withSub = [o('a', 'x'), o('b', 'hit'), o('c', 'hit'), o('d', 'x')];
    expect(flat(arrangeSections(withSub, groups, 'hit'))).toEqual([[null, ['0:b', '1:c']]]);
  });
  it('一致が無ければ空', () => {
    expect(arrangeSections(opts, undefined, 'zzz')).toEqual([]);
  });
});

describe('highlight', () => {
  it('最初に一致した部分だけを塗る', () => {
    expect(highlight('~/workspace/work', 'WORK')).toEqual([{ text: '~/', hit: false }, { text: 'work', hit: true }, { text: 'space/work', hit: false }]);
  });
  it('問い合わせが空か、一致しなければ 1 片のまま', () => {
    expect(highlight('alpha', '')).toEqual([{ text: 'alpha', hit: false }]);
    expect(highlight('alpha', 'z')).toEqual([{ text: 'alpha', hit: false }]);
  });
});

describe('place', () => {
  const viewport = { width: 1000, height: 800 };
  const face = { top: 100, bottom: 134, left: 200, width: 300 };
  it('下に収まれば、顔の直下に 6px 空けて置き、幅は顔に合わせる', () => {
    expect(place(face, 200, viewport)).toEqual({ left: 200, width: 300, top: 140, up: false });
  });
  it('幅は最小幅と顔の幅の大きいほう', () => {
    expect(place(face, 200, viewport, { minWidth: 420 }).width).toBe(420);
  });
  it('下に収まらず上のほうが広ければ上に開き、bottom で置く', () => {
    const low = { top: 700, bottom: 734, left: 200, width: 300 };
    expect(place(low, 300, viewport)).toEqual({ left: 200, width: 300, bottom: 106, up: true });
  });
  it('end に揃えると右端を顔の右端に合わせる', () => {
    expect(place({ top: 100, bottom: 128, left: 700, width: 90 }, 100, viewport, { minWidth: 220, align: 'end' }).left).toBe(570);
  });
  it('窓からはみ出さないよう、左右に 8px を残して寄せる', () => {
    expect(place({ top: 100, bottom: 128, left: 900, width: 90 }, 100, viewport, { minWidth: 300 }).left).toBe(692);
    expect(place({ top: 100, bottom: 128, left: 2, width: 90 }, 100, viewport, { minWidth: 300, align: 'end' }).left).toBe(8);
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/listboxModel.test.ts`
Expected: FAIL（`./listboxModel.ts` が無い）

- [ ] **Step 3: 書く**

`packages/ui/src/views/primitives/listboxModel.ts`：

```ts
import type { ProjectStatus } from '@agent-hangar/shared';
import type { IconName } from './Icon.tsx';

/** 一覧の 1 行。sub は 2 段目で、パスは mono、説明文（prose）は地の書体で描く。 */
export type ListboxOption = { value: string; label: string; sub?: string; subKind?: 'path' | 'prose'; meta?: string; status?: ProjectStatus; icon?: IconName; danger?: boolean };
export type ListboxGroup = { title: string; values: string[] };
/** 描く単位。index は選ばれかけの行を数える通し番号で、群をまたいで続く。 */
export type ListboxSection = { title: string | null; items: { option: ListboxOption; index: number }[] };
export type Segment = { text: string; hit: boolean };
export type Placement = { left: number; width: number; top?: number; bottom?: number; up: boolean };

/** 検索欄を出す件数の下限。これより少ないと、打つより目で探すほうが速い。 */
export const SEARCH_MIN = 8;
const GAP = 6;
const EDGE = 8;

export function matches(option: ListboxOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return option.label.toLowerCase().includes(q) || (option.sub ?? '').toLowerCase().includes(q);
}

/**
 * 行を節に分けて並べる。
 * 検索で絞っている間は群を解く。一致した行が群ごとに散らばると、どこに当たったかを探し直すことになるため。
 * 群に入っていない行は、取りこぼさないよう最後に見出しなしで置く。
 */
export function arrangeSections(options: ListboxOption[], groups: ListboxGroup[] | undefined, query: string): ListboxSection[] {
  const hit = options.filter((o) => matches(o, query));
  let index = 0;
  const items = (list: ListboxOption[]) => list.map((option) => ({ option, index: index++ }));
  if (!groups || query.trim()) return hit.length ? [{ title: null, items: items(hit) }] : [];
  const byValue = new Map(hit.map((o) => [o.value, o]));
  const placed = new Set<string>();
  const sections: ListboxSection[] = [];
  for (const g of groups) {
    const list = g.values.map((v) => byValue.get(v)).filter((o): o is ListboxOption => o !== undefined && !placed.has(o.value));
    if (!list.length) continue;
    for (const o of list) placed.add(o.value);
    sections.push({ title: g.title, items: items(list) });
  }
  const rest = hit.filter((o) => !placed.has(o.value));
  if (rest.length) sections.push({ title: null, items: items(rest) });
  return sections;
}

/** 最初に一致した部分だけを塗る。空の片は返さない。 */
export function highlight(text: string, query: string): Segment[] {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return [{ text, hit: false }];
  return [{ text: text.slice(0, i), hit: false }, { text: text.slice(i, i + q.length), hit: true }, { text: text.slice(i + q.length), hit: false }].filter((s) => s.text);
}

/**
 * 一覧を置く位置。顔の直下に置き、下に収まらず上のほうが広ければ上に開く。
 * 上に開くときは bottom で置く。一覧の高さが検索で変わっても、顔から離れないようにするため。
 */
export function place(face: { top: number; bottom: number; left: number; width: number }, popupHeight: number, viewport: { width: number; height: number }, opts: { minWidth?: number; align?: 'start' | 'end' } = {}): Placement {
  const width = Math.max(face.width, opts.minWidth ?? 0);
  const want = opts.align === 'end' ? face.left + face.width - width : face.left;
  const left = Math.max(EDGE, Math.min(want, viewport.width - width - EDGE));
  const below = viewport.height - face.bottom - GAP - EDGE;
  const above = face.top - GAP - EDGE;
  const up = popupHeight > below && above > below;
  return up ? { left, width, bottom: viewport.height - face.top + GAP, up } : { left, width, top: face.bottom + GAP, up };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/listboxModel.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/ui/src/views/primitives/listboxModel.ts packages/ui/src/views/primitives/listboxModel.test.ts
git commit -m "feat(ui): arrange, highlight and place listbox rows as pure functions"
```

---

### Task 3: Listbox の部品

**Files:**
- Create: `packages/ui/src/views/primitives/Listbox.tsx`
- Create: `packages/ui/src/test/pick.ts`
- Modify: `packages/ui/src/styles/controls.css`
- Modify: `packages/ui/src/styles/glass.test.ts`
- Test: `packages/ui/src/views/primitives/Listbox.test.tsx`

**Interfaces:**
- Consumes: Task 2 のすべて、`Icon`（Task 1 の `check`、`search`、既存の `chevronDown`）、`isComposing`（`views/ime.ts`）。
- Produces:

```tsx
export type ListboxProps = {
  label: string;                 // 顔と一覧の読み上げの名前
  value: string | null;
  options: ListboxOption[];
  onChange: (value: string) => void;
  groups?: ListboxGroup[];
  placeholder?: string;          // 既定は「選んでください」
  searchPlaceholder?: string;    // 既定は「<label>を探す」
  minWidth?: number;
  align?: 'start' | 'end';
  name?: string;                 // 渡すと hidden input を描く
  id?: string;                   // 顔の id
  showSubInFace?: boolean;       // 顔に 2 段目（パス）も出す
  faceClassName?: string;        // 既定は 'listbox-face'
  faceProps?: Record<`data-${string}`, string>;
  renderFace?: (selected: ListboxOption | undefined) => ReactNode;
};
export function Listbox(props: ListboxProps): JSX.Element;
```

- `packages/ui/src/test/pick.ts`: `export function pick(face: string, option: string | RegExp): void`

- [ ] **Step 1: 試験を書く**

`packages/ui/src/views/primitives/Listbox.test.tsx`：

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Listbox } from './Listbox.tsx';
import type { ListboxOption } from './listboxModel.ts';

const few: ListboxOption[] = [{ value: 'a', label: 'alpha', sub: '~/w/alpha' }, { value: 'b', label: 'beta', sub: '~/w/beta' }, { value: 'c', label: 'gamma', sub: '~/x/gamma' }];
const many: ListboxOption[] = Array.from({ length: 9 }, (_, i) => ({ value: `p${i}`, label: `proj-${i}`, sub: i % 2 ? `~/work/p${i}` : `~/home/p${i}` }));

function Harness(props: { options: ListboxOption[]; initial?: string | null; onChange?: (v: string) => void; groups?: { title: string; values: string[] }[]; name?: string }) {
  const [v, setV] = useState<string | null>(props.initial ?? null);
  return <Listbox label="プロジェクト" value={v} options={props.options} groups={props.groups} name={props.name} onChange={(x) => { setV(x); props.onChange?.(x); }} />;
}
const face = () => screen.getByRole('button', { name: 'プロジェクト' });

describe('Listbox の顔', () => {
  it('何も選んでいなければ置き文字、選べば名前を描く', () => {
    const { rerender } = render(<Listbox label="プロジェクト" value={null} options={few} onChange={() => {}} />);
    expect(face()).toHaveTextContent('選んでください');
    expect(face()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(face()).toHaveAttribute('aria-expanded', 'false');
    rerender(<Listbox label="プロジェクト" value="b" options={few} onChange={() => {}} showSubInFace />);
    expect(face()).toHaveTextContent('beta');
    expect(face()).toHaveTextContent('~/w/beta');
  });
  it('name を渡すと、同じ名前の hidden input に値を入れる', () => {
    const { container } = render(<Harness options={few} initial="c" name="projectId" />);
    expect((container.querySelector('input[type="hidden"][name="projectId"]') as HTMLInputElement).value).toBe('c');
  });
});

describe('Listbox を開く', () => {
  it('押すと一覧が開き、行は名前で引け、選んだ行に aria-selected が付く', () => {
    render(<Harness options={few} initial="b" />);
    fireEvent.click(face());
    expect(face()).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'プロジェクト' });
    expect(list).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'beta' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'alpha' })).toHaveAttribute('aria-selected', 'false');
  });
  it('行を押すと値を渡して閉じ、フォーカスを顔へ返す', () => {
    const onChange = vi.fn();
    render(<Harness options={few} onChange={onChange} />);
    fireEvent.click(face());
    fireEvent.click(screen.getByRole('option', { name: 'gamma' }));
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(face()).toHaveFocus();
  });
  it('同じ行を選び直しても値は渡さない', () => {
    const onChange = vi.fn();
    render(<Harness options={few} initial="a" onChange={onChange} />);
    fireEvent.click(face());
    fireEvent.click(screen.getByRole('option', { name: 'alpha' }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it('一覧の外を押すと閉じる', () => {
    render(<Harness options={few} />);
    fireEvent.click(face());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('開いたまま別の一覧の顔を押すと、先の一覧は閉じる', () => {
    render(<><Listbox label="A" value={null} options={few} onChange={() => {}} /><Listbox label="B" value={null} options={few} onChange={() => {}} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    const b = screen.getByRole('button', { name: 'B' });
    fireEvent.mouseDown(b);
    fireEvent.click(b);
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(screen.getByRole('listbox', { name: 'B' })).toBeInTheDocument();
  });
  it('開いたまま顔が消えても、一覧は body に残らない', () => {
    const { unmount } = render(<Harness options={few} />);
    fireEvent.click(face());
    unmount();
    expect(document.querySelector('.listbox-pop')).toBeNull();
  });
});

describe('Listbox のキーボード', () => {
  it('顔で ↓ を押すと開き、↑ ↓ で移って Enter で決める', () => {
    const onChange = vi.fn();
    render(<Harness options={few} initial="a" onChange={onChange} />);
    fireEvent.keyDown(face(), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    expect(list).toHaveFocus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'gamma' }).id);
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
  });
  it('↓ は末尾から先頭へ回り、Home と End で端へ跳ぶ', () => {
    render(<Harness options={few} initial="c" />);
    fireEvent.keyDown(face(), { key: 'Enter' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'alpha' }).id);
    fireEvent.keyDown(list, { key: 'End' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'gamma' }).id);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'alpha' }).id);
  });
  it('Esc で閉じて顔へフォーカスを返し、Esc と Enter は親へ伝えない', () => {
    const onParent = vi.fn();
    render(<div onKeyDown={onParent}><Harness options={few} /></div>);
    fireEvent.click(face());
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'Enter' });
    fireEvent.click(face());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(face()).toHaveFocus();
    expect(onParent).not.toHaveBeenCalled();
  });
  it('顔で押した Enter と ↓ も親へ伝えない（ダイアログを送らない）', () => {
    const onParent = vi.fn();
    render(<div onKeyDown={onParent}><Harness options={few} /></div>);
    fireEvent.keyDown(face(), { key: 'Enter' });
    expect(onParent).not.toHaveBeenCalled();
  });
  it('Tab で閉じる', () => {
    render(<Harness options={few} />);
    fireEvent.click(face());
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Listbox の検索', () => {
  it('8 件未満では検索欄を出さない', () => {
    render(<Harness options={few} />);
    fireEvent.click(face());
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('8 件以上では検索欄に入力が向き、名前と補足で絞れ、一致を塗る', () => {
    render(<Harness options={many} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox', { name: 'プロジェクトを探す' });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: 'WORK' } });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['proj-1', 'proj-3', 'proj-5', 'proj-7']);
    expect(screen.getAllByRole('option')[0]!.querySelector('mark')!.textContent).toBe('work');
  });
  it('一致が無ければ文で知らせ、Enter でも何も選ばない', () => {
    const onChange = vi.fn();
    render(<Harness options={many} onChange={onChange} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('一致するものはありません')).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
  it('変換中の Enter では決めない', () => {
    const onChange = vi.fn();
    render(<Harness options={many} onChange={onChange} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'proj' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('p0');
  });
  it('検索欄の aria-activedescendant は選ばれかけの行を指す', () => {
    render(<Harness options={many} />);
    fireEvent.click(face());
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'proj-1' }).id);
  });
});

describe('Listbox の群', () => {
  it('群の見出しで行を分け、検索で絞る間は見出しを消す', () => {
    const groups = [{ title: '最近', values: ['p3', 'p1'] }, { title: 'すべて', values: ['p0', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8'] }];
    render(<Harness options={many} groups={groups} />);
    fireEvent.click(face());
    const recent = screen.getByRole('group', { name: '最近' });
    expect([...recent.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('aria-label'))).toEqual(['proj-3', 'proj-1']);
    expect(screen.getByRole('group', { name: 'すべて' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'proj-3' } });
    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe('Listbox の変化への追従', () => {
  it('開いている間に選択肢が減っても、Enter で落ちずに残った行を選ぶ', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Listbox label="プロジェクト" value={null} options={few} onChange={onChange} />);
    fireEvent.click(face());
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'End' });
    rerender(<Listbox label="プロジェクト" value={null} options={few.slice(0, 1)} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a');
  });
  it('窓の大きさが変わると、顔に合わせて置き直す', () => {
    render(<Harness options={few} />);
    const f = face();
    let top = 100;
    f.getBoundingClientRect = () => ({ top, bottom: top + 34, left: 20, width: 300, right: 320, height: 34, x: 20, y: top, toJSON: () => ({}) });
    fireEvent.click(f);
    const pop = document.querySelector('.listbox-pop') as HTMLElement;
    expect(pop.style.top).toBe('140px');
    top = 200;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pop.style.top).toBe('240px');
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Listbox.test.tsx`
Expected: FAIL（`./Listbox.tsx` が無い）

- [ ] **Step 3: Listbox を書く**

`packages/ui/src/views/primitives/Listbox.tsx`：

```tsx
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isComposing } from '../ime.ts';
import { Icon } from './Icon.tsx';
import { arrangeSections, highlight, place, SEARCH_MIN, type ListboxGroup, type ListboxOption, type Placement } from './listboxModel.ts';

export type ListboxProps = {
  label: string;
  value: string | null;
  options: ListboxOption[];
  onChange: (value: string) => void;
  groups?: ListboxGroup[];
  placeholder?: string;
  searchPlaceholder?: string;
  minWidth?: number;
  align?: 'start' | 'end';
  name?: string;
  id?: string;
  showSubInFace?: boolean;
  faceClassName?: string;
  faceProps?: Record<`data-${string}`, string>;
  renderFace?: (selected: ListboxOption | undefined) => ReactNode;
};

/**
 * ガラスの一覧。素の select の代わりに、閉じた顔と、開いたときのガラスの面を自前で描く。
 * 面は document.body への portal に描く。一覧やカードの overflow: hidden で切られないようにするため。
 * portal の中の出来事も React の木では呼び出し側の子として泡立つので、扱ったキーは stopPropagation で止める。
 * 止めないと、起動ダイアログの Enter（起動）と Esc（閉じる）が同時に走る。
 */
export function Listbox(props: ListboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Placement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const face = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const faceValueId = `${uid}-value`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  const searchable = props.options.length >= SEARCH_MIN;
  const sections = arrangeSections(props.options, props.groups, query);
  const items = sections.flatMap((s) => s.items);
  // 開いている間に選択肢が減ると、選ばれかけの行が範囲の外に出る。いちばん近い行に寄せる。
  const current = items.length ? Math.min(active, items.length - 1) : -1;
  const selected = props.options.find((o) => o.value === props.value);

  const show = () => {
    const start = arrangeSections(props.options, props.groups, '').flatMap((s) => s.items).findIndex((i) => i.option.value === props.value);
    setQuery('');
    setScrolled(false);
    setActive(Math.max(start, 0));
    setOpen(true);
  };
  const hide = (refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) face.current?.focus();
  };
  const choose = (o: ListboxOption) => {
    hide(true);
    if (o.value !== props.value) props.onChange(o.value);
  };

  const reposition = useCallback(() => {
    if (!face.current || !pop.current) return;
    const r = face.current.getBoundingClientRect();
    setPos(place({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, pop.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth: props.minWidth, align: props.align }));
  }, [props.minWidth, props.align]);

  // 描いた直後、塗る前に位置を決める。検索で行の数が変わると高さも変わるので、そのたびに計り直す。
  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition, items.length]);

  useEffect(() => {
    if (!open) return;
    (searchable ? input.current : list.current)?.focus();
    // 面の外を押したら閉じる。フォーカスは押した先に任せ、顔へは戻さない。
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || face.current?.contains(t)) return;
      hide(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
    // searchable は開いている間は変わらない。開いた時点の値で監視を張る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reposition]);

  useEffect(() => {
    if (open && current >= 0) document.getElementById(optId(current))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);

  const onFaceKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (!open) show();
  };

  const onPopKey = (e: KeyboardEvent<HTMLElement>) => {
    if (isComposing(e)) return;
    const n = items.length;
    const inInput = e.target === input.current;
    switch (e.key) {
      case 'ArrowDown': if (n) setActive((current + 1) % n); break;
      case 'ArrowUp': if (n) setActive((current - 1 + n) % n); break;
      // 検索欄の Home と End は、文字の先頭と末尾へ動かす打鍵として残す。
      case 'Home': if (inInput) return; setActive(0); break;
      case 'End': if (inInput) return; setActive(Math.max(n - 1, 0)); break;
      case 'Enter': { const hit = items[current]; if (hit) choose(hit.option); break; }
      case 'Escape': case 'Tab': hide(true); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const marks = (text: string) => highlight(text, query).map((s, i) => s.hit ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>);
  const activeId = current >= 0 ? optId(current) : undefined;

  const option = ({ option: o, index }: { option: ListboxOption; index: number }) => (
    <div key={o.value} id={optId(index)} role="option" aria-selected={o.value === props.value} aria-label={o.label} aria-describedby={o.sub ? `${optId(index)}-sub` : undefined}
      className="listbox-opt" data-active={index === current ? 'true' : undefined} data-danger={o.danger ? 'true' : undefined}
      onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => choose(o)}>
      {o.status ? <span className="st-dot" data-status={o.status} aria-hidden="true" /> : o.icon ? <Icon name={o.icon} /> : null}
      <span className="listbox-opt-main">
        <b>{marks(o.label)}</b>
        {o.sub && <small id={`${optId(index)}-sub`} data-kind={o.subKind ?? 'path'}>{o.subKind === 'prose' ? o.sub : marks(o.sub)}</small>}
      </span>
      {o.meta && <span className="listbox-meta">{o.meta}</span>}
      <span className="listbox-check" aria-hidden="true"><Icon name="check" /></span>
    </div>
  );

  const defaultFace = (
    <>
      {selected ? (
        <span id={faceValueId} className="listbox-face-value">
          {selected.status ? <span className="st-dot" data-status={selected.status} aria-hidden="true" /> : selected.icon ? <Icon name={selected.icon} /> : null}
          <span className="listbox-face-label">{selected.label}</span>
          {props.showSubInFace && selected.sub && <span className="listbox-face-sub">{selected.sub}</span>}
        </span>
      ) : <span id={faceValueId} className="listbox-face-placeholder">{props.placeholder ?? '選んでください'}</span>}
      <Icon name="chevronDown" />
    </>
  );

  const style = pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden' as const };

  return (
    <>
      <button ref={face} type="button" id={props.id} className={props.faceClassName ?? 'listbox-face'} {...props.faceProps}
        aria-label={props.label} aria-describedby={props.renderFace ? undefined : faceValueId} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? hide(false) : show())} onKeyDown={onFaceKey}>
        {props.renderFace ? props.renderFace(selected) : defaultFace}
      </button>
      {props.name && <input type="hidden" name={props.name} value={props.value ?? ''} />}
      {open && createPortal(
        <div ref={pop} className="listbox-pop" style={style} data-up={pos?.up ? 'true' : undefined} data-scrolled={scrolled ? 'true' : undefined} onKeyDown={onPopKey}>
          {searchable && (
            <div className="listbox-search">
              <Icon name="search" />
              <input ref={input} role="combobox" aria-label={props.searchPlaceholder ?? `${props.label}を探す`} placeholder={props.searchPlaceholder ?? `${props.label}を探す`}
                aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
                value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
            </div>
          )}
          <div ref={list} id={listId} role="listbox" aria-label={props.label} className="listbox-rows" tabIndex={searchable ? undefined : -1}
            aria-activedescendant={searchable ? undefined : activeId} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
            {sections.map((s, si) => s.title === null
              ? <Fragment key={`s${si}`}>{s.items.map(option)}</Fragment>
              : (
                <div key={`s${si}`} role="group" aria-labelledby={`${uid}-g${si}`}>
                  <div id={`${uid}-g${si}`} className="listbox-group-title">{s.title}</div>
                  {s.items.map(option)}
                </div>
              ))}
            {!items.length && <div className="listbox-empty">一致するものはありません</div>}
          </div>
          {searchable && (
            <div className="listbox-keys" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> 移動</span><span><kbd>Enter</kbd> 決める</span><span><kbd>Esc</kbd> 閉じる</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
```

`react-hooks/exhaustive-deps` の lint をこのリポジトリが使っていなければ、2 つの `eslint-disable-next-line` の行とその上の説明の行は書かない（`grep -rn "exhaustive-deps" packages/ui/src` で確かめる）。

- [ ] **Step 4: 試験の補助を書く**

`packages/ui/src/test/pick.ts`：

```ts
import { fireEvent, screen } from '@testing-library/react';

/** Listbox の顔を押して開き、名前の一致する行を選ぶ。素の select の fireEvent.change の代わりに使う。 */
export function pick(face: string, option: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: face }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}
```

- [ ] **Step 5: 見た目を足す**

`controls.css` の末尾に足す。

```css
/* 一覧の顔。選んだ項目の点、名前、補足、下向きの矢印を描く。 */
.listbox-face { display: flex; align-items: center; gap: calc(var(--u) * 2); width: 100%; min-width: 0; height: 34px; padding: 0 calc(var(--u) * 2.5) 0 calc(var(--u) * 3); border: 0; border-radius: 10px; text-align: left; cursor: pointer; color: var(--ink); background: rgba(255, 255, 255, 0.85); box-shadow: inset 0 0 0 1px var(--line-strong), 0 1px 2px rgba(30, 40, 90, 0.05); transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.listbox-face:hover { background: var(--surface); box-shadow: inset 0 0 0 1px #c9cbe0, 0 3px 10px -4px rgba(30, 40, 90, 0.18); }
.listbox-face[aria-expanded='true'] { background: var(--surface); box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.listbox-face-value { display: flex; align-items: center; gap: calc(var(--u) * 2); flex: 1; min-width: 0; }
.listbox-face-label { font-weight: 560; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.listbox-face-sub { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.listbox-face-placeholder { flex: 1; color: var(--ink-3); }
.listbox-face > .icon:last-child { flex: none; color: var(--ink-3); transition: transform var(--dur-fast) var(--ease-out); }
.listbox-face[aria-expanded='true'] > .icon:last-child { transform: rotate(180deg); }
/* 丸い札の形。一覧の上の絞り込みとサブエージェントで使う。 */
.listbox-face.listbox-pill { width: auto; height: var(--row-h); border-radius: var(--r-pill); }
.listbox-face.listbox-pill .listbox-face-value { flex: none; }

/* 開いたときのガラスの面。上から検索欄、行、キーの案内。検索欄と案内は固定し、行だけがスクロールする。 */
.listbox-pop { position: fixed; z-index: 30; display: flex; flex-direction: column; max-height: 320px; padding: calc(var(--u) * 1.5); border-radius: var(--r-lg); background: var(--glass-bg-menu); -webkit-backdrop-filter: var(--glass-blur-strong); backdrop-filter: var(--glass-blur-strong); box-shadow: var(--glass-edge), var(--glass-drop-lg); transform-origin: top left; animation: listbox-in var(--dur-fast) var(--ease-out); }
.listbox-pop[data-up='true'] { transform-origin: bottom left; animation-name: listbox-in-up; }
@keyframes listbox-in { from { opacity: 0; transform: translateY(calc(var(--rise) * -1)) scale(0.98); filter: blur(var(--blur-in)); } }
@keyframes listbox-in-up { from { opacity: 0; transform: translateY(var(--rise)) scale(0.98); filter: blur(var(--blur-in)); } }
.listbox-search { flex: none; position: relative; z-index: 1; display: flex; align-items: center; gap: calc(var(--u) * 2); height: 34px; padding: 0 calc(var(--u) * 2.5); margin-bottom: var(--u); border-radius: 10px; color: var(--ink-3); background: rgba(255, 255, 255, 0.85); box-shadow: inset 0 0 0 1px var(--line); transition: box-shadow var(--dur-fast) var(--ease-out); }
/* 行が下をくぐり始めたら、検索欄の下に薄い影を落とす。 */
.listbox-pop[data-scrolled='true'] .listbox-search { box-shadow: inset 0 0 0 1px var(--line), 0 6px 12px -8px rgba(30, 40, 90, 0.35); }
.listbox-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--ink); }
.listbox-rows { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; outline: none; }
.listbox-group-title { padding: calc(var(--u) * 1.5) calc(var(--u) * 2.5) 2px; font-size: var(--fs-xs); font-weight: 560; color: var(--ink-3); }
.listbox-opt { display: flex; align-items: center; gap: calc(var(--u) * 2.5); min-height: 32px; padding: var(--u) calc(var(--u) * 2.5); border-radius: 10px; cursor: pointer; white-space: nowrap; }
.listbox-opt[data-active='true'] { background: rgba(255, 255, 255, 0.92); box-shadow: inset 0 1px 0 #ffffff, 0 2px 8px -2px rgba(30, 40, 90, 0.16); }
.listbox-opt-main { display: flex; flex-direction: column; flex: 1; min-width: 0; line-height: 1.3; }
.listbox-opt-main b { font-weight: 560; }
.listbox-opt-main small { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; }
.listbox-opt-main small[data-kind='prose'] { font-family: var(--font-sans); white-space: normal; }
.listbox-opt mark { padding: 0 1px; border-radius: 3px; color: inherit; background: color-mix(in srgb, var(--accent) 16%, transparent); }
.listbox-meta { font-size: var(--fs-xs); color: var(--ink-3); }
.listbox-check { display: inline-flex; color: var(--accent); visibility: hidden; }
.listbox-opt[aria-selected='true'] .listbox-check { visibility: visible; }
.listbox-opt[aria-selected='true'] .listbox-opt-main b { color: var(--accent); }
.listbox-opt[data-danger='true'] .listbox-opt-main b { color: var(--error); }
.listbox-empty { padding: calc(var(--u) * 2.5); color: var(--ink-3); }
.listbox-keys { flex: none; display: flex; gap: calc(var(--u) * 3); padding: calc(var(--u) * 1.5) calc(var(--u) * 2.5) 2px; margin-top: var(--u); border-top: 1px solid rgba(30, 40, 90, 0.06); font-size: var(--fs-xs); color: var(--ink-3); }
.listbox-keys kbd { padding: 0 4px; border-radius: 4px; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; color: var(--ink-2); background: rgba(30, 40, 90, 0.06); }
```

`glass.test.ts` の `GLASS` に `'.listbox-pop'` を足し、その上の「仕様」の注記に「選ぶ部品の一覧」を足す。

```ts
// 仕様：ガラスは浮く部品（ヘッダ、サイドバー、⌘K、ダイアログ、通知と切断の帯、選ぶ部品の一覧）にだけ使う。
const GLASS = ['.sidebar', '.header', '.conn-banner', '.dialog', '.palette', '.toast', '.listbox-pop'];
```

- [ ] **Step 6: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives packages/ui/src/styles`
Expected: PASS
落ちた試験があれば、試験を緩めずに部品を直す。
「窓の大きさが変わる」試験が `offsetHeight` の 0 で上に開いてしまう場合は、jsdom の `window.innerHeight`（既定 768）で下に収まる計算になっているかを確かめる。

- [ ] **Step 7: 型を確かめてコミット**

Run: `npm run typecheck -w packages/ui`
Expected: エラーなし

```bash
git add packages/ui/src/views/primitives/Listbox.tsx packages/ui/src/views/primitives/Listbox.test.tsx packages/ui/src/test/pick.ts packages/ui/src/styles/controls.css packages/ui/src/styles/glass.test.ts
git commit -m "feat(ui): add the glass listbox with a pinned search field"
```

---

### Task 4: Segmented（切り替えの帯）

**Files:**
- Create: `packages/ui/src/views/primitives/Segmented.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Test: `packages/ui/src/views/primitives/Segmented.test.tsx`

**Interfaces:**
- Produces:

```tsx
export type SegmentedOption = { value: string; label: string; lead?: ReactNode };
export function Segmented(props: { label: string; value: string; options: SegmentedOption[]; onChange: (value: string) => void; size?: 'sm' | 'xs' }): JSX.Element;
```

- [ ] **Step 1: 試験を書く**

`packages/ui/src/views/primitives/Segmented.test.tsx`：

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Segmented } from './Segmented.tsx';

const periods = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }];

describe('Segmented', () => {
  it('radiogroup の中に radio を並べ、いまの値に aria-checked を付ける', () => {
    render(<Segmented label="期間" value="1" options={periods} onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: '期間' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['全期間', '今日', '7 日']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });
  it('選んだ項目だけが Tab で届く', () => {
    render(<Segmented label="期間" value="7" options={periods} onChange={() => {}} />);
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });
  it('どれも選ばれていなければ、先頭が Tab で届く', () => {
    render(<Segmented label="期間" value="3" options={periods} onChange={() => {}} />);
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });
  it('押すと値を渡し、同じ値なら渡さない', () => {
    const onChange = vi.fn();
    render(<Segmented label="期間" value="" options={periods} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '全期間' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '7 日' }));
    expect(onChange).toHaveBeenCalledWith('7');
  });
  it('← → で隣へ選び直し、端では反対の端へ回る', () => {
    const onChange = vi.fn();
    render(<Segmented label="期間" value="" options={periods} onChange={onChange} />);
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('1');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('7');
  });
  it('先頭の飾りは読み上げの名前に入れない', () => {
    render(<Segmented label="状態" value="" options={[{ value: '', label: 'すべて' }, { value: 'r', label: '実行中', lead: <span className="st-dot" /> }]} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '実行中' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Segmented.test.tsx`
Expected: FAIL（`./Segmented.tsx` が無い）

- [ ] **Step 3: 書く**

`packages/ui/src/views/primitives/Segmented.tsx`：

```tsx
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type SegmentedOption = { value: string; label: string; lead?: ReactNode };

/**
 * 切り替えの帯。選んだ項目の下に白い玉を置き、選び直すと玉が滑る。
 * 最初の配置で玉が端から滑ってこないよう、1 フレーム置いてから動きを有効にする（data-ready）。
 */
export function Segmented(props: { label: string; value: string; options: SegmentedOption[]; onChange: (value: string) => void; size?: 'sm' | 'xs' }) {
  const box = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const checked = props.options.findIndex((o) => o.value === props.value);

  useLayoutEffect(() => {
    const placeThumb = () => {
      const t = thumb.current;
      const b = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!t) return;
      t.style.left = b ? `${b.offsetLeft}px` : '0px';
      t.style.width = b ? `${b.offsetWidth}px` : '0px';
    };
    placeThumb();
    // 書体が読み込まれると文字の幅が変わるので、帯の大きさの変化にも付いていく。
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(placeThumb);
    if (box.current) ro?.observe(box.current);
    return () => ro?.disconnect();
  }, [props.value, props.options]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const pick = (value: string) => { if (value !== props.value) props.onChange(value); };

  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = props.options.length;
    const next = (Math.max(checked, 0) + step + n) % n;
    pick(props.options[next]!.value);
    box.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <span ref={box} className={`seg seg-${props.size ?? 'sm'}`} role="radiogroup" aria-label={props.label} data-ready={ready ? 'true' : undefined} onKeyDown={onKey}>
      <span ref={thumb} className="seg-thumb" aria-hidden="true" />
      {props.options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={i === checked} tabIndex={i === Math.max(checked, 0) ? 0 : -1} onClick={() => pick(o.value)}>
          {o.lead && <span className="seg-lead" aria-hidden="true">{o.lead}</span>}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </span>
  );
}
```

- [ ] **Step 4: 見た目を足す**

`controls.css` の末尾に足す。

```css
/* 切り替えの帯。白い玉は選んだ項目の下を滑る。 */
.seg { position: relative; display: inline-flex; flex: none; padding: 3px; border-radius: var(--r-pill); background: rgba(30, 40, 90, 0.06); box-shadow: inset 0 1px 2px rgba(30, 40, 90, 0.06); }
.seg > button { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: calc(var(--u) * 1.5); height: 22px; max-width: 160px; padding: 0 calc(var(--u) * 2.5); border: 0; border-radius: var(--r-pill); background: none; color: var(--ink-2); font-size: var(--fs-sm); font-weight: 520; white-space: nowrap; cursor: pointer; transition: color var(--dur-fast) var(--ease-out); }
.seg > button[aria-checked='true'] { color: var(--ink); font-weight: 600; }
.seg-label { overflow: hidden; text-overflow: ellipsis; }
.seg-lead { display: inline-flex; align-items: center; }
.seg-thumb { position: absolute; z-index: 0; top: 3px; bottom: 3px; left: 0; width: 0; border-radius: var(--r-pill); background: var(--surface); box-shadow: inset 0 1px 0 #ffffff, 0 2px 6px rgba(30, 40, 90, 0.14); }
.seg[data-ready='true'] .seg-thumb { transition: left var(--dur) var(--ease-out), width var(--dur) var(--ease-out); }
/* 詰めた形。項目が 6 個ある effort に使う。 */
.seg-xs > button { padding: 0 calc(var(--u) * 1.75); font-size: 11.5px; gap: var(--u); }
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Segmented.test.tsx packages/ui/src/styles`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/views/primitives/Segmented.tsx packages/ui/src/views/primitives/Segmented.test.tsx packages/ui/src/styles/controls.css
git commit -m "feat(ui): add the segmented control with a sliding thumb"
```

---

### Task 5: Chip（押すと灯るチップと、択一のチップ）

**Files:**
- Create: `packages/ui/src/views/primitives/Chip.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Test: `packages/ui/src/views/primitives/Chip.test.tsx`

**Interfaces:**
- Consumes: `Icon`（既存の `edit`）。
- Produces:

```tsx
export function ToggleChip(props: { label: string; text: string; icon?: IconName; pressed: boolean; onChange: (next: boolean) => void }): JSX.Element;
export type ChoiceChip = { value: string; label: string };
export function ChoiceChips(props: { label: string; value: string; options: ChoiceChip[]; onChange: (value: string) => void; other?: { label: string; placeholder: string } }): JSX.Element;
```

- [ ] **Step 1: 試験を書く**

`packages/ui/src/views/primitives/Chip.test.tsx`：

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChoiceChips, ToggleChip } from './Chip.tsx';

const models = [{ value: '', label: '既定' }, { value: 'opus', label: 'opus' }, { value: 'sonnet', label: 'sonnet' }];
function Models(props: { initial?: string; onChange?: (v: string) => void }) {
  const [v, setV] = useState(props.initial ?? '');
  return <ChoiceChips label="model" value={v} options={models} other={{ label: 'ほか', placeholder: 'model の名前' }} onChange={(x) => { setV(x); props.onChange?.(x); }} />;
}

describe('ToggleChip', () => {
  it('読み上げの名前と、押した状態を aria-pressed に出す', () => {
    render(<ToggleChip label="思考を表示" text="思考" pressed={false} onChange={() => {}} />);
    const chip = screen.getByRole('button', { name: '思考を表示' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveTextContent('思考');
  });
  it('押すと反転した値を渡す', () => {
    const onChange = vi.fn();
    render(<ToggleChip label="生の記録を表示" text="生の記録" pressed onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '生の記録を表示' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('ChoiceChips', () => {
  it('radiogroup の中の radio で、いまの値に aria-checked を付ける', () => {
    render(<Models initial="opus" />);
    const group = screen.getByRole('radiogroup', { name: 'model' });
    expect(within(group).getAllByRole('radio').map((r) => `${r.textContent}:${r.getAttribute('aria-checked')}`)).toEqual(['既定:false', 'opus:true', 'sonnet:false']);
  });
  it('押すと値を渡す', () => {
    const onChange = vi.fn();
    render(<Models onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'sonnet' }));
    expect(onChange).toHaveBeenCalledWith('sonnet');
  });
  it('「ほか」を押すと入力欄に変わってフォーカスが入り、打った名前を渡す', () => {
    const onChange = vi.fn();
    render(<Models initial="opus" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    const box = screen.getByRole('textbox', { name: 'model の名前' });
    expect(box).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('');
    fireEvent.change(box, { target: { value: 'claude-opus-5-5' } });
    expect(onChange).toHaveBeenLastCalledWith('claude-opus-5-5');
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });
  it('打った名前を消しても入力欄のまま残り、チップを押すと戻る', () => {
    render(<Models />);
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    const box = screen.getByRole('textbox', { name: 'model の名前' });
    fireEvent.change(box, { target: { value: 'x' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByRole('textbox', { name: 'model の名前' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'opus' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('radio', { name: 'opus' })).toHaveAttribute('aria-checked', 'true');
  });
  it('選択肢に無い値を受け取ったら、最初から入力欄で出す（フォーカスは奪わない）', () => {
    render(<Models initial="claude-haiku-4-5" />);
    const box = screen.getByRole('textbox', { name: 'model の名前' });
    expect(box).toHaveValue('claude-haiku-4-5');
    expect(box).not.toHaveFocus();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Chip.test.tsx`
Expected: FAIL（`./Chip.tsx` が無い）

- [ ] **Step 3: 書く**

`packages/ui/src/views/primitives/Chip.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/** 押すと灯るチップ。表示の切り替えに使う。見える文字は短くし、読み上げの名前は label で渡す。 */
export function ToggleChip(props: { label: string; text: string; icon?: IconName; pressed: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" className="chip" aria-label={props.label} aria-pressed={props.pressed} onClick={() => props.onChange(!props.pressed)}>
      {props.icon && <Icon name={props.icon} />}{props.text}
    </button>
  );
}

export type ChoiceChip = { value: string; label: string };

/**
 * 択一のチップ。other を渡すと末尾に「ほか」を置き、押すとその場で入力欄に変わる。
 * 選択肢に無い値は入力欄で出す。入力欄にいる間はどのチップにも印を付けない。
 */
export function ChoiceChips(props: { label: string; value: string; options: ChoiceChip[]; onChange: (value: string) => void; other?: { label: string; placeholder: string } }) {
  const known = props.options.some((o) => o.value === props.value);
  const [otherOpen, setOtherOpen] = useState(!known);
  const input = useRef<HTMLInputElement>(null);
  // 利用者が「ほか」を押したときだけ入力欄へフォーカスを移す。最初から入力欄で出すときは奪わない。
  const focusNext = useRef(false);
  const inOther = !!props.other && (otherOpen || !known);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    input.current?.focus();
  });
  return (
    <div className="chips" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" role="radio" className="chip" aria-checked={!inOther && o.value === props.value}
          onClick={() => { setOtherOpen(false); if (inOther || o.value !== props.value) props.onChange(o.value); }}>{o.label}</button>
      ))}
      {props.other && (inOther
        ? <span className="chip chip-input" data-on="true"><input ref={input} aria-label={props.other.placeholder} placeholder={props.other.placeholder} value={known ? '' : props.value} onChange={(e) => props.onChange(e.target.value)} /></span>
        : <button type="button" className="chip" onClick={() => { focusNext.current = true; setOtherOpen(true); props.onChange(''); }}><Icon name="edit" />{props.other.label}</button>)}
    </div>
  );
}
```

- [ ] **Step 4: 見た目を足す**

`controls.css` の末尾に足す。

```css
/* チップ。押すと灯るもの（aria-pressed）と、択一のもの（aria-checked）がある。 */
.chips { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 1.5); }
.chip { display: inline-flex; align-items: center; gap: calc(var(--u) * 1.5); height: var(--row-h); padding: 0 calc(var(--u) * 2.75); border: 0; border-radius: var(--r-pill); font-weight: 520; white-space: nowrap; cursor: pointer; color: var(--ink-2); background: rgba(255, 255, 255, 0.75); box-shadow: inset 0 0 0 1px var(--line-strong); transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
.chip:hover { color: var(--ink); background: var(--surface); }
.chip[aria-pressed='true'], .chip[aria-checked='true'], .chip[data-on='true'] { color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 55%, transparent); }
.chip-input input { width: 140px; border: 0; outline: 0; background: none; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink); }
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Chip.test.tsx packages/ui/src/styles`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/views/primitives/Chip.tsx packages/ui/src/views/primitives/Chip.test.tsx packages/ui/src/styles/controls.css
git commit -m "feat(ui): add toggle chips and choice chips with a free-text escape"
```

---

### Task 6: OptionCard（択一のカードと複数選択のカード）

**Files:**
- Create: `packages/ui/src/views/primitives/OptionCard.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Test: `packages/ui/src/views/primitives/OptionCard.test.tsx`

**Interfaces:**
- Consumes: `Icon`（Task 1 の `check` と各アイコン）。
- Produces:

```tsx
export type OptionCardItem = { value: string; label: string; description: string; code?: string; icon: IconName; danger?: boolean };
export function OptionCards(props: { label: string; value: string; options: OptionCardItem[]; onChange: (value: string) => void }): JSX.Element;
export function CheckCard(props: { label: string; description: string; icon: IconName; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }): JSX.Element;
```

- [ ] **Step 1: 試験を書く**

`packages/ui/src/views/primitives/OptionCard.test.tsx`：

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CheckCard, OptionCards, type OptionCardItem } from './OptionCard.tsx';

const perms: OptionCardItem[] = [
  { value: '', label: '既定', description: 'Claude Code の設定に従う', icon: 'permissionDefault' },
  { value: 'plan', label: '計画だけ', description: '読むだけで何も変えない', code: 'plan', icon: 'permissionPlan' },
  { value: 'bypassPermissions', label: '確認なし', description: 'すべて確認せずに実行する', code: 'bypassPermissions', icon: 'permissionBypass', danger: true },
];

describe('OptionCards', () => {
  it('radiogroup の中の radio で、名前は label、説明は aria-describedby で読む', () => {
    render(<OptionCards label="permission mode" value="plan" options={perms} onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'permission mode' });
    const plan = within(group).getByRole('radio', { name: '計画だけ' });
    expect(plan).toHaveAttribute('aria-checked', 'true');
    expect(plan).toHaveAccessibleDescription('読むだけで何も変えない');
    expect(plan).toHaveTextContent('plan');
  });
  it('押すと値を渡し、同じ値なら渡さない', () => {
    const onChange = vi.fn();
    render(<OptionCards label="p" value="" options={perms} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '既定' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '確認なし' }));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
  });
  it('danger のカードに data-danger を付ける', () => {
    render(<OptionCards label="p" value="" options={perms} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '確認なし' })).toHaveAttribute('data-danger', 'true');
    expect(screen.getByRole('radio', { name: '既定' })).not.toHaveAttribute('data-danger');
  });
});

describe('CheckCard', () => {
  it('checkbox の役割で、名前と説明と印の状態を出す', () => {
    render(<CheckCard label="git init する" description="空のリポジトリを作ってから移します" icon="gitInit" checked onChange={() => {}} />);
    const card = screen.getByRole('checkbox', { name: 'git init する' });
    expect(card).toHaveAttribute('aria-checked', 'true');
    expect(card).toHaveAccessibleDescription('空のリポジトリを作ってから移します');
  });
  it('押すと反転した値を渡し、押せないときは渡さない', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CheckCard label="c" description="d" icon="moveFiles" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'c' }));
    expect(onChange).toHaveBeenCalledWith(true);
    onChange.mockClear();
    rerender(<CheckCard label="c" description="d" icon="moveFiles" checked={false} disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'c' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/OptionCard.test.tsx`
Expected: FAIL（`./OptionCard.tsx` が無い）

- [ ] **Step 3: 書く**

`packages/ui/src/views/primitives/OptionCard.tsx`：

```tsx
import { useId } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export type OptionCardItem = { value: string; label: string; description: string; code?: string; icon: IconName; danger?: boolean };

/** 意味を添えた択一のカード。名前は label で読み、説明は aria-describedby で添える。 */
export function OptionCards(props: { label: string; value: string; options: OptionCardItem[]; onChange: (value: string) => void }) {
  const uid = useId();
  return (
    <div className="option-cards" role="radiogroup" aria-label={props.label}>
      {props.options.map((o, i) => (
        <button key={o.value} type="button" role="radio" className="option-card" aria-label={o.label} aria-describedby={`${uid}-${i}`} aria-checked={o.value === props.value} data-danger={o.danger ? 'true' : undefined}
          onClick={() => { if (o.value !== props.value) props.onChange(o.value); }}>
          <Icon name={o.icon} />
          <span className="option-card-text"><b>{o.label}</b><small id={`${uid}-${i}`}>{o.description}</small>{o.code && <code>{o.code}</code>}</span>
        </button>
      ))}
    </div>
  );
}

/** 何が起きるかを 1 行添えた、複数選択のカード。右端の四角い印が満ちてチェックが描かれる。 */
export function CheckCard(props: { label: string; description: string; icon: IconName; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <button type="button" role="checkbox" className="option-card check-card" aria-label={props.label} aria-describedby={id} aria-checked={props.checked} disabled={props.disabled} onClick={() => props.onChange(!props.checked)}>
      <Icon name={props.icon} />
      <span className="option-card-text"><b>{props.label}</b><small id={id}>{props.description}</small></span>
      <span className="check-box" aria-hidden="true"><Icon name="check" /></span>
    </button>
  );
}
```

- [ ] **Step 4: 見た目を足す**

`controls.css` の末尾に足す。

```css
/* 意味を添えたカード。択一は 2 列に並べ、複数選択は右端に四角い印を置く。 */
.option-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(var(--u) * 1.5); }
.option-card { display: flex; align-items: flex-start; gap: calc(var(--u) * 2.5); width: 100%; padding: calc(var(--u) * 2.25) calc(var(--u) * 2.75); border: 0; border-radius: 12px; text-align: left; cursor: pointer; color: var(--ink); background: rgba(255, 255, 255, 0.7); box-shadow: inset 0 0 0 1px var(--line-strong); transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.option-card:hover:not(:disabled) { background: var(--surface); }
.option-card > .icon { margin-top: 2px; color: var(--ink-3); }
.option-card-text { display: flex; flex-direction: column; flex: 1; min-width: 0; line-height: 1.4; }
.option-card-text b { font-size: 12.5px; font-weight: 600; }
.option-card-text small { font-size: 11.5px; color: var(--ink-3); }
.option-card-text code { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-3); }
.option-card[aria-checked='true'] { background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--accent), 0 4px 12px -6px rgba(74, 99, 232, 0.4); }
.option-card[aria-checked='true'] > .icon { color: var(--accent); }
.option-card[data-danger='true'] b { color: var(--error); }
.option-card[data-danger='true'][aria-checked='true'] { box-shadow: inset 0 0 0 1.5px var(--error), 0 4px 12px -6px rgba(179, 38, 30, 0.35); }
.option-card[data-danger='true'][aria-checked='true'] > .icon { color: var(--error); }
.option-card:disabled { opacity: 0.5; cursor: default; }
.check-card { align-items: center; }
.check-box { display: grid; flex: none; place-items: center; width: 20px; height: 20px; border-radius: 6px; color: #ffffff; box-shadow: inset 0 0 0 1.5px var(--line-strong); transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.check-box .icon { width: 14px; height: 14px; stroke-width: 3; opacity: 0; transform: scale(0.5); transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur) var(--ease-out); }
.check-card[aria-checked='true'] .check-box { background: var(--accent); box-shadow: none; }
.check-card[aria-checked='true'] .check-box .icon { opacity: 1; transform: none; }
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/OptionCard.test.tsx packages/ui/src/styles`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/views/primitives/OptionCard.tsx packages/ui/src/views/primitives/OptionCard.test.tsx packages/ui/src/styles/controls.css
git commit -m "feat(ui): add option cards and check cards that explain each choice"
```

---

### Task 7: Stepper（増減のボタン）

**Files:**
- Create: `packages/ui/src/views/primitives/Stepper.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Test: `packages/ui/src/views/primitives/Stepper.test.tsx`

**Interfaces:**
- Consumes: `Icon`（Task 1 の `minus`、既存の `add`）。
- Produces: `export function Stepper(props: { label: string; value: string; onChange: (text: string) => void; min: number; max: number; step?: number }): JSX.Element`

- [ ] **Step 1: 試験を書く**

`packages/ui/src/views/primitives/Stepper.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Stepper } from './Stepper.tsx';

describe('Stepper', () => {
  it('数の入力欄を残し、範囲と刻みをそのまま持つ', () => {
    render(<Stepper label="1 時間の上限" value="20" min={1} max={200} onChange={() => {}} />);
    const box = screen.getByLabelText('1 時間の上限') as HTMLInputElement;
    expect(box.type).toBe('number');
    expect([box.min, box.max, box.step]).toEqual(['1', '200', '1']);
  });
  it('− と ＋ で 1 ずつ動かす', () => {
    const onChange = vi.fn();
    render(<Stepper label="上限" value="20" min={1} max={200} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '上限を減らす' }));
    expect(onChange).toHaveBeenLastCalledWith('19');
    fireEvent.click(screen.getByRole('button', { name: '上限を増やす' }));
    expect(onChange).toHaveBeenLastCalledWith('21');
  });
  it('端では止まり、止まった側は押せない', () => {
    const { rerender } = render(<Stepper label="上限" value="1" min={1} max={200} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '上限を減らす' })).toBeDisabled();
    rerender(<Stepper label="上限" value="200" min={1} max={200} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '上限を増やす' })).toBeDisabled();
  });
  it('読めない値からは最小値を起点に動かし、範囲の外からは範囲へ戻す', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Stepper label="上限" value="" min={1} max={200} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '上限を増やす' }));
    expect(onChange).toHaveBeenLastCalledWith('2');
    rerender(<Stepper label="上限" value="500" min={1} max={200} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '上限を減らす' }));
    expect(onChange).toHaveBeenLastCalledWith('199');
  });
  it('打った文字列はそのまま渡す（検め方は呼び出し側が持つ）', () => {
    const onChange = vi.fn();
    render(<Stepper label="上限" value="20" min={1} max={200} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('上限'), { target: { value: '1.5' } });
    expect(onChange).toHaveBeenCalledWith('1.5');
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Stepper.test.tsx`
Expected: FAIL（`./Stepper.tsx` が無い）

- [ ] **Step 3: 書く**

`packages/ui/src/views/primitives/Stepper.tsx`：

```tsx
import { Icon } from './Icon.tsx';

/**
 * 数の入力欄を − と ＋ で挟む。入力欄はそのまま打てる number として残す。
 * 値は文字列で受け渡し、範囲の外や小数を打ったときの扱い（保存の前の案内）は呼び出し側に任せる。
 */
export function Stepper(props: { label: string; value: string; onChange: (text: string) => void; min: number; max: number; step?: number }) {
  const step = props.step ?? 1;
  const n = Number(props.value);
  const readable = props.value.trim() !== '' && Number.isFinite(n);
  const clamp = (x: number) => Math.min(props.max, Math.max(props.min, x));
  const bump = (d: number) => props.onChange(String(clamp(Math.round(readable ? clamp(n) : props.min) + d)));
  return (
    <span className="stepper">
      <button type="button" aria-label={`${props.label}を減らす`} disabled={readable && n <= props.min} onClick={() => bump(-step)}><Icon name="minus" /></button>
      <input className="stepper-input" type="number" min={props.min} max={props.max} step={step} aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <button type="button" aria-label={`${props.label}を増やす`} disabled={readable && n >= props.max} onClick={() => bump(step)}><Icon name="add" /></button>
    </span>
  );
}
```

範囲の外（500）から − を押すと、`clamp(500) = 200` を起点に 199 になる。

- [ ] **Step 4: 見た目を足す**

`controls.css` の末尾に足す。

```css
/* 増減のボタン。素の number の小さな矢印は隠す。 */
.stepper { display: inline-flex; flex: none; align-items: center; height: 30px; border-radius: var(--r-pill); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-strong); }
.stepper > button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--ink-2); cursor: pointer; transition: background var(--dur-fast) var(--ease-out); }
.stepper > button:hover:not(:disabled) { color: var(--ink); background: var(--surface-2); }
.stepper > button:disabled { opacity: 0.4; cursor: default; }
.stepper-input { width: 44px; border: 0; outline: 0; background: none; text-align: center; font-family: var(--font-mono); font-size: var(--fs); font-weight: 600; color: var(--ink); -moz-appearance: textfield; }
.stepper-input::-webkit-inner-spin-button, .stepper-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/Stepper.test.tsx packages/ui/src/styles`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/ui/src/views/primitives/Stepper.tsx packages/ui/src/views/primitives/Stepper.test.tsx packages/ui/src/styles/controls.css
git commit -m "feat(ui): add a stepper that keeps the number field typeable"
```

---

### Task 8: ステータスの札を Listbox にする

**Files:**
- Modify: `packages/ui/src/views/primitives/StatusSelect.tsx`
- Modify: `packages/ui/src/styles/base.css:234-244`
- Modify: `docs/design.md:1205-1207`
- Test: `packages/ui/src/views/primitives/StatusSelect.test.tsx`（書き直す）
- Test: `packages/ui/src/views/screens.test.tsx:95-110`（ProjectsScreen の 2 つ）

**Interfaces:**
- Consumes: `Listbox`、`ListboxOption`（Task 2、3）、`pick`（Task 3）。
- Produces: `StatusSelect` と `ProjectStatusDot` の props は変えない。

- [ ] **Step 1: StatusSelect の試験を書き直す**

`packages/ui/src/views/primitives/StatusSelect.test.tsx` の `describe('StatusSelect', ...)` と `describe('StatusSelect の見た目', ...)` を次に置き換える（`ProjectStatusDot` の試験は残す）。

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pick } from '../../test/pick.ts';
import { ProjectStatusDot, StatusSelect } from './StatusSelect.tsx';

describe('StatusSelect', () => {
  it('押すと 4 つのステータスを、点とひとことの意味つきで開く', () => {
    render(<StatusSelect label="alpha のステータス" value="paused" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'alpha のステータス' }));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['active', 'paused', 'done', 'archived']);
    expect(screen.getByRole('option', { name: 'paused' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'done' })).toHaveAccessibleDescription('やり終えた');
    expect(options.map((o) => o.querySelector('.st-dot')?.getAttribute('data-status'))).toEqual(['active', 'paused', 'done', 'archived']);
  });
  it('選び直すと新しいステータスを渡す', () => {
    const onChange = vi.fn();
    render(<StatusSelect label="s" value="active" onChange={onChange} />);
    pick('s', 'done');
    expect(onChange).toHaveBeenCalledWith('done');
  });
  it('札でも一覧でも、クリックとキー入力は親へ伝えない（カードを開かせない）', () => {
    const onParent = vi.fn();
    render(<div onClick={onParent} onKeyDown={onParent}><StatusSelect label="s" value="active" onChange={() => {}} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 's' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'paused' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 's' }), { key: 'Enter' });
    expect(onParent).not.toHaveBeenCalled();
  });
});

describe('StatusSelect の見た目', () => {
  it('札は文字、その右の丸、矢印の順に描き、色は札の data-status から引く', () => {
    render(<StatusSelect label="s" value="paused" onChange={() => {}} />);
    const pill = screen.getByRole('button', { name: 's' });
    expect(pill.classList.contains('status-pill')).toBe(true);
    expect(pill.getAttribute('data-status')).toBe('paused');
    expect([...pill.children].map((c) => c.getAttribute('data-icon') ?? c.getAttribute('class'))).toEqual(['status-text', 'st-dot', 'chevronDown']);
    expect(pill.querySelector('.status-text')!.textContent).toBe('paused');
  });
  it('読み上げで見つかるのは、名前つきの札 1 つだけ', () => {
    render(<StatusSelect label="alpha のステータス" value="done" onChange={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/primitives/StatusSelect.test.tsx`
Expected: FAIL（まだ素の select なので `button` の名前で引けない）

- [ ] **Step 3: StatusSelect を書き換える**

`packages/ui/src/views/primitives/StatusSelect.tsx`：

```tsx
import type { ProjectStatus } from '@agent-hangar/shared';
import { Icon } from './Icon.tsx';
import { Listbox } from './Listbox.tsx';
import type { ListboxOption } from './listboxModel.ts';

const STATUS_OPTIONS: ListboxOption[] = [
  { value: 'active', label: 'active', sub: 'いま進めている', subKind: 'prose', status: 'active' },
  { value: 'paused', label: 'paused', sub: 'いったん止めている', subKind: 'prose', status: 'paused' },
  { value: 'done', label: 'done', sub: 'やり終えた', subKind: 'prose', status: 'done' },
  { value: 'archived', label: 'archived', sub: '一覧の奥へしまう', subKind: 'prose', status: 'archived' },
];

/**
 * プロジェクトのステータスを選ぶ部品。
 * 札（文字、その右の丸、矢印）を Listbox の顔にし、開くと色の点とひとことの意味を並べる。色は札の data-status から CSS が引く。
 * カードの中に置かれるので、クリックとキー入力は親へ伝えない。一覧は portal に描くが、React の木では札の子として泡立つので、ここで止まる。
 */
export function StatusSelect(props: { label: string; value: ProjectStatus; onChange: (status: ProjectStatus) => void }) {
  return (
    <span className="status-host" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Listbox label={props.label} value={props.value} options={STATUS_OPTIONS} onChange={(v) => props.onChange(v as ProjectStatus)} minWidth={220} align="end"
        faceClassName="status-pill" faceProps={{ 'data-status': props.value }}
        renderFace={() => <><span className="status-text">{props.value}</span><ProjectStatusDot status={props.value} /><Icon name="chevronDown" /></>} />
    </span>
  );
}

/** ステータスの色の点。隣に文字があるので飾りとして読み上げから外す。 */
export function ProjectStatusDot(props: { status: ProjectStatus }) {
  return <span className="st-dot" data-status={props.status} aria-hidden="true" />;
}
```

- [ ] **Step 4: 札の CSS を直す**

`base.css` の 234〜244 行（`/* 見た目は .status-face が描き…` から `.status-select:focus-visible { outline: none; }` まで）を次に置き換える。

```css
/* ステータスの札。Listbox の顔として、文字、その右の丸、矢印を描く。 */
.status-host { display: inline-flex; flex: none; }
.status-pill { display: inline-flex; align-items: center; gap: calc(var(--u) * 1.5); height: var(--row-h); padding: 0 calc(var(--u) * 2); border: 0; border-radius: var(--r-pill); font: inherit; font-weight: 500; cursor: pointer; color: var(--st-archived); background: var(--st-archived-soft); transition: background var(--dur) var(--ease-out), color var(--dur) var(--ease-out); }
.status-pill[data-status='active'] { color: var(--st-active); background: var(--st-active-soft); }
.status-pill[data-status='paused'] { color: var(--st-paused); background: var(--st-paused-soft); }
.status-pill[data-status='done'] { color: var(--st-done); background: var(--st-done-soft); }
.status-pill[data-status='archived'] { color: var(--st-archived); background: var(--st-archived-soft); }
.status-pill:hover { filter: brightness(0.97); }
.status-pill[aria-expanded='true'] > .icon:last-child { transform: rotate(180deg); }
.status-pill > .icon:last-child { transition: transform var(--dur-fast) var(--ease-out); }
```

`packages/ui/src` の中で `status-face` と `status-select` を grep し、ほかに残っていないことを確かめる（試験の中も含む）。

- [ ] **Step 5: ProjectsScreen の試験を書き直す**

`packages/ui/src/views/screens.test.tsx` の `describe('ProjectsScreen', ...)` の 2 つの試験を次に置き換え、ファイルの先頭に `import { pick } from '../test/pick.ts';` を足す。

```tsx
  it('セクションとアーカイブ切替とステータス変更', () => {
    const onIntent = vi.fn();
    const onShow = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [card('alpha')] }, { status: 'paused', label: 'Paused', cards: [] }]} archivedCount={2} filter="" showArchived={false} onFilter={() => {}} onShowArchived={onShow} /></IntentRoot>);
    fireEvent.click(screen.getByText('アーカイブを表示（2）'));
    expect(onShow).toHaveBeenCalledWith(true);
    pick('alpha のステータス', 'paused');
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.setStatus', id: 'alpha', status: 'paused' });
  });
  it('ステータスの札で Enter を押しても、一覧で行を押しても、カードは開かない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ProjectsScreen sections={[{ status: 'active', label: 'Active', cards: [card('alpha')] }]} archivedCount={0} filter="" showArchived={false} onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'alpha のステータス' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'done' }));
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'project.open', id: 'alpha' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.setStatus', id: 'alpha', status: 'done' });
  });
```

`ProjectScreen`（1 件の画面）も `StatusSelect` を使う。`packages/ui/src` で `のステータス'` や `'ステータス'` を `fireEvent.change` している試験が残っていないかを grep し、残っていれば同じく `pick` に直す。

- [ ] **Step 6: docs/design.md を直す**

`docs/design.md` の 1205〜1207 行を次に置き換える。

```markdown
ステータスの部品は、文字、その右の塗りつぶしの丸、矢印の順に描いた札を、ガラスの一覧（`views/primitives/Listbox.tsx`）の顔にする。
開くと 4 つのステータスを、色の点とひとことの意味（いま進めている、いったん止めている、やり終えた、一覧の奥へしまう）つきで並べる。
この部品は `views/primitives/StatusSelect.tsx` の `StatusSelect`（選べる場所）と `ProjectStatusDot`（読むだけの場所）だけを通して使い、View が一覧を自分で組むことはしない。
```

- [ ] **Step 7: 通ることを確かめてコミット**

Run: `npx vitest run packages/ui/src`
Expected: PASS（ProjectScreen を含むすべて）

```bash
git add packages/ui/src/views/primitives/StatusSelect.tsx packages/ui/src/views/primitives/StatusSelect.test.tsx packages/ui/src/styles/base.css packages/ui/src/views/screens.test.tsx docs/design.md
git commit -m "feat(ui): open the project status as a glass list with what each status means"
```

---

### Task 9: 新しいセッションのダイアログ

**Files:**
- Modify: `packages/ui/src/presenters/newSession.ts`
- Modify: `packages/ui/src/Root.tsx:266`
- Modify: `packages/ui/src/views/NewSessionDialog.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Test: `packages/ui/src/presenters/presenters.test.ts:312-324`
- Test: `packages/ui/src/views/NewSessionDialog.test.tsx`（書き直す）

**Interfaces:**
- Consumes: `Listbox`、`ChoiceChips`、`Segmented`、`OptionCards`、`pick`、`relativeTime`（`presenters/format.ts`）。
- Produces:

```ts
export type NewSessionProject = { id: string; name: string; path: string | null; status: ProjectStatus; lastActivity: string };
export type NewSessionProps = { projects: NewSessionProject[]; recentIds: string[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean };
export const RECENT_COUNT = 5;
export function presentNewSession(state: State, store: Store, now: number): NewSessionProps | null;
```

- [ ] **Step 1: haiku の別名を確かめる**

WebFetch で `https://code.claude.com/docs/en/model-config` を読み、モデルの別名の表に `haiku` があるかを確かめる。
あれば MODELS に残し、なければ Step 5 の `MODELS` から `haiku` の行を外し、仕様書の該当の 3 行（「haiku は Claude Code のモデル設定の別名として…」）を「haiku は別名として挙がっていないので入れない」に直す。
確かめた結果を、この Task のコミットの本文に 1 行で書く。

- [ ] **Step 2: presenter の試験を書く**

`presenters.test.ts` の `describe('presentNewSession', ...)` を次に置き換える。
`storeWith()`、`project()`、`initialState()`、`NOW` は同じファイルに既にある。

```ts
describe('presentNewSession', () => {
  it('オーバーレイが newSession のときだけ、解決済みでアーカイブでないプロジェクトを名前順に出す', () => {
    const store = storeWith();
    store.projects.gone = { ...project('gone'), resolved: false };
    expect(presentNewSession(initialState(), store, NOW)).toBeNull();
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: 'beta', scratch: false }, launch: { kind: 'failed' as const, message: 'x' } };
    const p = presentNewSession(state, store, NOW)!;
    expect(p.projects.map((x) => x.id)).toEqual(['alpha', 'beta']);
    expect(p).toMatchObject({ projectId: 'beta', submitting: false, error: 'x' });
    expect(presentNewSession({ ...state, launch: { kind: 'submitting' } }, store, NOW)!.submitting).toBe(true);
  });
  it('ステータスと最後に使った時期を添え、最近は最後に使った順の上位 5 件', () => {
    const store = storeWith();
    for (const [id, ago] of [['p1', 1], ['p2', 5], ['p3', 3], ['p4', 9], ['p5', 2], ['p6', 7], ['p7', null]] as const) {
      store.projects[id] = { ...project(id), lastActivityAt: ago === null ? null : NOW - ago * 60_000 };
    }
    const state = { ...initialState(), overlay: { kind: 'newSession' as const, projectId: null, scratch: false } };
    const p = presentNewSession(state, store, NOW)!;
    expect(p.recentIds).toEqual(['p1', 'p5', 'p3', 'p2', 'p6']);
    const p1 = p.projects.find((x) => x.id === 'p1')!;
    expect(p1).toMatchObject({ status: store.projects.p1!.status, lastActivity: '1 分前' });
    expect(p.projects.find((x) => x.id === 'p7')!.lastActivity).toBe('');
  });
});
```

`storeWith()` の中の既存のプロジェクト（alpha、beta）の `lastActivityAt` が p1〜p6 より新しいと、最近の並びに混ざる。
混ざるなら、この試験の中で `delete store.projects.alpha; delete store.projects.beta;` を先に置く（`storeWith` の中身を読んで決める）。

- [ ] **Step 3: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts -t presentNewSession`
Expected: FAIL（`recentIds` が無い）

- [ ] **Step 4: presenter を書く**

`packages/ui/src/presenters/newSession.ts`：

```ts
import type { ProjectStatus } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';

export type NewSessionProject = { id: string; name: string; path: string | null; status: ProjectStatus; lastActivity: string };
export type NewSessionProps = { projects: NewSessionProject[]; recentIds: string[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean };

/** 一覧の「最近」に置く件数。 */
export const RECENT_COUNT = 5;

/** 起動ダイアログ。overlay が newSession のときだけ props を作る。 */
export function presentNewSession(state: State, store: Store, now: number): NewSessionProps | null {
  if (state.overlay.kind !== 'newSession') return null;
  // スクラッチの擬似プロジェクトは選ばせない。
  const live = Object.values(store.projects).filter((p) => !p.isScratch && p.resolved && p.status !== 'archived');
  const projects = [...live].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name, path: p.path, status: p.status, lastActivity: p.lastActivityAt === null ? '' : relativeTime(p.lastActivityAt, now) }));
  // 最近は最後に使った時刻の新しい順。使ったことのないプロジェクトは入れない。
  const recentIds = live.filter((p) => p.lastActivityAt !== null).sort((a, b) => b.lastActivityAt! - a.lastActivityAt!).slice(0, RECENT_COUNT).map((p) => p.id);
  return { projects, recentIds, projectId: state.overlay.projectId, submitting: state.launch.kind === 'submitting', error: state.launch.kind === 'failed' ? state.launch.message : null, scratch: state.overlay.scratch };
}
```

`Root.tsx` の 266 行を `const newSession = presentNewSession(state, store, now);` にする。

- [ ] **Step 5: presenter の試験が通ることを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts -t presentNewSession`
Expected: PASS

- [ ] **Step 6: ダイアログの試験を書き直す**

`packages/ui/src/views/NewSessionDialog.test.tsx` の全体を次に置き換える。

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchParams } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { pick } from '../test/pick.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const projects: NewSessionProps['projects'] = [
  { id: 'p1', name: 'alpha', path: '/w/alpha', status: 'active', lastActivity: '2 分前' },
  { id: 'p2', name: 'beta', path: '/w/beta', status: 'paused', lastActivity: '昨日' },
];
const base: NewSessionProps = { projects, recentIds: ['p1'], projectId: null, submitting: false, error: null, scratch: false };

/** 送られた params だけを集める。キーの有無を見たいので、呼び出しの照合ではなく値そのものを取る。 */
function collectParams(over: Partial<NewSessionProps> = {}): LaunchParams[] {
  const out: LaunchParams[] = [];
  render(<IntentRoot onIntent={(i) => { if (i.type === 'session.new.submit') out.push(i.params); }}><NewSessionDialog {...base} {...over} /></IntentRoot>);
  return out;
}
const start = () => fireEvent.click(screen.getByRole('button', { name: '起動' }));

describe('NewSessionDialog', () => {
  it('選んで起動すると params を出す', () => {
    const params = collectParams();
    pick('プロジェクト', 'alpha');
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: 'やって' } });
    fireEvent.click(screen.getByRole('radio', { name: 'opus' }));
    fireEvent.click(screen.getByRole('radio', { name: 'high' }));
    fireEvent.click(screen.getByRole('radio', { name: '計画だけ' }));
    fireEvent.change(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）'), { target: { value: '/a\n\n/b\n' } });
    start();
    expect(params).toEqual([{ projectId: 'p1', name: 'n', prompt: 'やって', model: 'opus', effort: 'high', permissionMode: 'plan', addDirs: ['/a', '/b'] }]);
  });
  it('プロジェクトの一覧は、最近とすべての群に分かれ、パスと時期を添える', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    expect(within(screen.getByRole('group', { name: '最近' })).getByRole('option', { name: 'alpha' })).toHaveAccessibleDescription('/w/alpha');
    expect(within(screen.getByRole('group', { name: 'すべて' })).getByRole('option', { name: 'beta' })).toHaveTextContent('昨日');
  });
  it('初期プロジェクトが選ばれ、Esc とやめるで閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p2" /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('beta');
    fireEvent.click(screen.getByText('やめる'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledTimes(2);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('一覧を開いている間の Esc は一覧だけを閉じ、Enter は起動しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onIntent).not.toHaveBeenCalled();
  });
  it('プロジェクトを選ばずに押しても起動を出し、projectId は入れない', () => {
    // 未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
    const params = collectParams();
    start();
    expect(params).toHaveLength(1);
    expect(Object.keys(params[0]!)).toEqual([]);
  });
  it('読み上げの名前は可視ラベルと一致する', () => {
    // 「（任意）」を落とすと、読み上げでは必須かどうかが分からなくなる。
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '名前（任意）' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '初期プロンプト（任意）' })).toBeInTheDocument();
    expect(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）')).toHaveAccessibleName('追加ディレクトリ（1 行 1 つ）');
    expect(screen.getByRole('radiogroup', { name: 'model' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'effort' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'permission mode' })).toBeInTheDocument();
  });
  it('既定のままなら model、effort、permission mode はキーごと入れない', () => {
    // undefined を入れると、利用者の Claude Code の設定を上書きしかねない。
    const params = collectParams({ projectId: 'p1' });
    fireEvent.change(screen.getByLabelText('名前（任意）'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('追加ディレクトリ（1 行 1 つ）'), { target: { value: '\n \n' } });
    start();
    expect(Object.keys(params[0]!)).toEqual(['projectId']);
  });
  it('permission mode と effort の選択肢は CLI の値に合わせる', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(within(screen.getByRole('radiogroup', { name: 'effort' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['既定', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(within(screen.getByRole('radiogroup', { name: 'permission mode' })).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['既定', '都度たずねる', '編集は任せる', '計画だけ', '自動', 'たずねずに断る', '確認なし']);
  });
  it('「ほか」で打った model を、前後の空白を落として入れる', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'model の名前' }), { target: { value: ' claude-opus-5-5 ' } });
    start();
    expect(params[0]).toEqual({ projectId: 'p1', model: 'claude-opus-5-5' });
  });
  it('「ほか」に空白だけを打ったら model を入れない', () => {
    const params = collectParams({ projectId: 'p1' });
    fireEvent.click(screen.getByRole('button', { name: 'ほか' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'model の名前' }), { target: { value: '   ' } });
    start();
    expect(Object.keys(params[0]!)).toEqual(['projectId']);
  });
  it('確認なしを選ぶと警告を出し、起動はそのまま押せる', () => {
    const params = collectParams({ projectId: 'p1' });
    expect(screen.queryByText('ファイルの削除やコマンドも、確認せずに実行します')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '確認なし' }));
    expect(screen.getByText('ファイルの削除やコマンドも、確認せずに実行します')).toBeInTheDocument();
    start();
    expect(params[0]).toEqual({ projectId: 'p1', permissionMode: 'bypassPermissions' });
  });
  it('詳細の見出しに、既定以外を選んだ値を並べる', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} /></IntentRoot>);
    expect(screen.getByText('詳細（model、effort、permission mode、worktree、追加ディレクトリ）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'opus' }));
    fireEvent.click(screen.getByRole('radio', { name: 'high' }));
    fireEvent.click(screen.getByRole('radio', { name: '自動' }));
    expect(screen.getByText('詳細（opus、high、自動）')).toBeInTheDocument();
  });
  it('送信中と失敗の表示', () => {
    render(<IntentRoot onIntent={() => {}}><NewSessionDialog {...base} projectId="p1" submitting error="tmux が見つかりません" /></IntentRoot>);
    expect(screen.getByRole('button', { name: '起動しています' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('tmux が見つかりません');
    expect(screen.getByText(/信頼確認/)).toBeInTheDocument();
  });
  it('変換中の Enter では起動しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><NewSessionDialog {...base} projectId="p1" /></IntentRoot>);
    const name = screen.getByLabelText('名前（任意）');
    fireEvent.change(name, { target: { value: 'なまえ' } });
    fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.submit', params: { projectId: 'p1', name: 'なまえ' } });
  });
});
```

- [ ] **Step 7: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/NewSessionDialog.test.tsx`
Expected: FAIL（まだ素の select と自由入力）

- [ ] **Step 8: ダイアログを書き換える**

`packages/ui/src/views/NewSessionDialog.tsx` の全体を次に置き換える。

```tsx
import { useRef, useState, type KeyboardEvent } from 'react';
import type { LaunchParams } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { isComposing } from './ime.ts';
import { ChoiceChips } from './primitives/Chip.tsx';
import { Fold } from './primitives/Fold.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { OptionCards, type OptionCardItem } from './primitives/OptionCard.tsx';
import { Segmented } from './primitives/Segmented.tsx';

// 値は claude --help の --model の別名、--effort と --permission-mode の選択肢に合わせる。
// 空の値は「既定」で、params に含めず利用者の Claude Code の設定に従わせる。
const MODELS = [{ value: '', label: '既定' }, { value: 'fable', label: 'fable' }, { value: 'opus', label: 'opus' }, { value: 'sonnet', label: 'sonnet' }, { value: 'haiku', label: 'haiku' }];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSIONS: OptionCardItem[] = [
  { value: '', label: '既定', description: 'Claude Code の設定に従う', icon: 'permissionDefault' },
  { value: 'manual', label: '都度たずねる', description: '編集もコマンドも確認する', code: 'manual', icon: 'permissionManual' },
  { value: 'acceptEdits', label: '編集は任せる', description: 'ファイルの編集は確認しない', code: 'acceptEdits', icon: 'permissionAcceptEdits' },
  { value: 'plan', label: '計画だけ', description: '読むだけで何も変えない', code: 'plan', icon: 'permissionPlan' },
  { value: 'auto', label: '自動', description: '安全なものは自動で許す', code: 'auto', icon: 'permissionAuto' },
  { value: 'dontAsk', label: 'たずねずに断る', description: '許可済みのもの以外は断る', code: 'dontAsk', icon: 'permissionDontAsk' },
  { value: 'bypassPermissions', label: '確認なし', description: 'すべて確認せずに実行する', code: 'bypassPermissions', icon: 'permissionBypass', danger: true },
];

/** effort の強さを 5 段の棒で添える。既定には付けない。 */
function EffortBars(props: { level: number }) {
  return <span className="effort-bars">{[1, 2, 3, 4, 5].map((i) => <i key={i} data-on={i <= props.level ? 'true' : undefined} />)}</span>;
}
const EFFORT_OPTIONS = EFFORTS.map((e, i) => ({ value: e, label: e || '既定', lead: e ? <EffortBars level={i} /> : undefined }));

/**
 * 起動ダイアログ。必須はプロジェクトだけで、空欄と既定は params に含めない（利用者の Claude Code の設定に従わせるため）。
 * プロジェクト、model、effort、permission mode はここの状態で持つ。詳細の見出しに、選んだ値を送信の前から出すため。
 * 名前、初期プロンプト、worktree、追加ディレクトリは非制御のまま、送信のときにフォームから読む。
 * プロジェクトが未選択のまま送っても止めない。未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const form = useRef<HTMLFormElement>(null);
  const [projectId, setProjectId] = useState(props.projectId ?? '');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');

  const submit = () => {
    if (props.submitting || !form.current) return;
    const data = new FormData(form.current);
    const text = (key: string): string => { const v = data.get(key); return typeof v === 'string' ? v.trim() : ''; };
    const params: LaunchParams = {};
    // スクラッチはプロジェクトを持たず、サーバが使い捨てのディレクトリを作る。
    if (props.scratch) params.scratch = true;
    else if (projectId) params.projectId = projectId;
    for (const key of ['name', 'prompt'] as const) { const v = text(key); if (v) params[key] = v; }
    if (model.trim()) params.model = model.trim();
    if (effort) params.effort = effort;
    if (permissionMode) params.permissionMode = permissionMode;
    const worktree = text('worktree'); if (worktree) params.worktree = worktree;
    const dirs = text('addDirs').split('\n').map((d) => d.trim()).filter(Boolean);
    if (dirs.length) params.addDirs = dirs;
    emit({ type: 'session.new.submit', params });
  };

  // Esc で閉じ、Enter で起動する。
  // 変換中の Enter は確定のための打鍵なので、起動に使わない。
  // 一覧を開いている間の Esc と Enter は、Listbox が止めるのでここまで来ない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { emit({ type: 'overlay.close' }); return; }
    if (e.key !== 'Enter' || isComposing(e)) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    e.preventDefault();
    submit();
  };

  const recent = new Set(props.recentIds);
  const options = props.projects.map((p) => ({ value: p.id, label: p.name, sub: p.path ?? undefined, meta: p.lastActivity || undefined, status: p.status }));
  const groups = [{ title: '最近', values: props.recentIds }, { title: 'すべて', values: props.projects.filter((p) => !recent.has(p.id)).map((p) => p.id) }];
  const chosen = [model.trim(), effort, PERMISSIONS.find((p) => p.value && p.value === permissionMode)?.label].filter(Boolean);
  // 区切りに全角空白を使わない。読み上げと試験の正規化で空白が詰められ、見た目と一致しなくなるため。
  const foldSummary = chosen.length ? `詳細（${chosen.join('、')}）` : '詳細（model、effort、permission mode、worktree、追加ディレクトリ）';

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="新しいセッション" onKeyDown={onKeyDown}>
      <form ref={form} className="dialog dialog-wide" onSubmit={(e) => e.preventDefault()}>
        <b>{props.scratch ? 'スクラッチで始める' : '新しいセッション'}</b>
        {props.scratch
          ? <div className="faint">~/.agent-hangar/scratch/ の下に日時のディレクトリを作って起動します。後からプロジェクトに昇格できます。</div>
          : (
            <div className="field">
              <span aria-hidden="true">プロジェクト</span>
              <Listbox id="new-session-project" label="プロジェクト" value={projectId || null} options={options} groups={groups} onChange={setProjectId} showSubInFace searchPlaceholder="名前かパスで探す" minWidth={360} />
            </div>
          )}
        <label className="field" htmlFor="new-session-name">名前（任意）
          <input id="new-session-name" className="input" name="name" defaultValue="" placeholder="一覧での表示名" />
        </label>
        <label className="field" htmlFor="new-session-prompt">初期プロンプト（任意）
          <textarea id="new-session-prompt" className="input" name="prompt" rows={4} defaultValue="" />
        </label>
        <Fold summary={foldSummary}>
          <div className="launch-options">
            <span className="launch-option-label" aria-hidden="true">model</span>
            <ChoiceChips label="model" value={model} options={MODELS} onChange={setModel} other={{ label: 'ほか', placeholder: 'model の名前' }} />
            <span className="launch-option-label" aria-hidden="true">effort</span>
            <div><Segmented label="effort" value={effort} options={EFFORT_OPTIONS} onChange={setEffort} size="xs" /></div>
            <span className="launch-option-label launch-option-label-top" aria-hidden="true">permission</span>
            <div>
              <OptionCards label="permission mode" value={permissionMode} options={PERMISSIONS} onChange={setPermissionMode} />
              {permissionMode === 'bypassPermissions' && <div className="error launch-danger">ファイルの削除やコマンドも、確認せずに実行します</div>}
            </div>
          </div>
          <label className="field" htmlFor="new-session-worktree">worktree
            <input id="new-session-worktree" className="input mono" name="worktree" defaultValue="" placeholder="空なら通常の作業ディレクトリ" />
          </label>
          <label className="field" htmlFor="new-session-add-dirs">追加ディレクトリ（1 行 1 つ）
            <textarea id="new-session-add-dirs" className="input mono" name="addDirs" rows={2} defaultValue="" />
          </label>
        </Fold>
        <div className="faint">新しいディレクトリでは Claude が信頼確認のダイアログを出します。起動したあとにターミナルで答えてください。</div>
        {props.error && <div className="error" role="alert">{props.error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={props.submitting} onClick={submit}>{props.submitting ? '起動しています' : '起動'}</button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 9: 見た目を足す**

`controls.css` の末尾に足す。

```css
/* 起動ダイアログの詳細。左に値の名前、右に選ぶ部品を並べる。 */
.launch-options { display: grid; grid-template-columns: 84px minmax(0, 1fr); align-items: center; gap: calc(var(--u) * 2.5); margin: calc(var(--u) * 2) 0; }
.launch-option-label { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink-2); }
.launch-option-label-top { align-self: start; padding-top: calc(var(--u) * 2); }
.launch-danger { margin-top: calc(var(--u) * 1.5); }
.effort-bars { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 10px; }
.effort-bars i { width: 2.5px; border-radius: 1px; background: currentColor; opacity: 0.25; }
.effort-bars i[data-on='true'] { opacity: 1; }
.effort-bars i:nth-child(1) { height: 3.6px; }
.effort-bars i:nth-child(2) { height: 5.2px; }
.effort-bars i:nth-child(3) { height: 6.8px; }
.effort-bars i:nth-child(4) { height: 8.4px; }
.effort-bars i:nth-child(5) { height: 10px; }
```

- [ ] **Step 10: 通ることを確かめる**

Run: `npx vitest run packages/ui/src`
Expected: PASS
`Root.test.tsx` に新しいセッションのダイアログで `option` を引く試験（`getByRole('option', { name: /alpha/ })`）がある。
一覧を開かないと行は描かれないので、落ちていればその直前に `fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }))` を足す。

- [ ] **Step 11: 型を確かめてコミット**

Run: `npm run typecheck -w packages/ui`
Expected: エラーなし

```bash
git add packages/ui/src/presenters/newSession.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/Root.tsx packages/ui/src/Root.test.tsx packages/ui/src/views/NewSessionDialog.tsx packages/ui/src/views/NewSessionDialog.test.tsx packages/ui/src/styles/controls.css docs/superpowers/specs/2026-09-30-choice-controls-design.md
git commit -m "feat(ui): pick the project from a searchable list and choose model, effort and permission mode"
```

---

### Task 10: セッション一覧の絞り込み

**Files:**
- Modify: `packages/ui/src/views/SessionsScreen.tsx`
- Modify: `packages/ui/src/styles/controls.css`
- Test: `packages/ui/src/views/misc.test.tsx:12-50`

**Interfaces:**
- Consumes: `Listbox`、`Segmented`、`pick`。

- [ ] **Step 1: 試験を書き直す**

`misc.test.tsx` の `describe('SessionsScreen', ...)` のうち、「絞り込みは search.filter、キーワードは search.query」と「期間は since を now から N 日前にする」を次に置き換え、ファイルの先頭に `import { pick } from '../test/pick.ts';` を足す。
残りの試験（日本語入力、検索中、一致なし）はそのまま残す。

```tsx
  it('絞り込みは search.filter、キーワードは search.query', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    pick('プロジェクト', 'alpha');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: 'p1' } });
    fireEvent.click(screen.getByRole('radio', { name: '実行中' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { running: true } });
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: 'x y' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y' });
  });
  it('絞り込みは、何で絞っているかを帯と札で見せる', () => {
    render(<IntentRoot onIntent={() => {}}><SessionsScreen text="" filter={{ projectId: 'p1', running: false }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('alpha');
    expect(within(screen.getByRole('radiogroup', { name: '状態' })).getByRole('radio', { name: '終了' })).toHaveAttribute('aria-checked', 'true');
    expect(within(screen.getByRole('radiogroup', { name: '期間' })).getByRole('radio', { name: '全期間' })).toHaveAttribute('aria-checked', 'true');
  });
  it('すべてのプロジェクトに戻すと projectId を外す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{ projectId: 'p1' }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    pick('プロジェクト', 'すべてのプロジェクト');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: undefined } });
  });
  it('期間は since を now から N 日前にする', () => {
    const onIntent = vi.fn();
    const before = Date.now();
    render(<IntentRoot onIntent={onIntent}><SessionsScreen text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: '7 日' }));
    const call = onIntent.mock.calls.find((c) => c[0].type === 'search.filter')?.[0];
    expect(call).toBeDefined();
    const since = call.patch.since as number;
    expect(since).toBeGreaterThanOrEqual(before - 7 * 86_400_000);
    expect(since).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    expect(call.patch.until).toBeUndefined();
  });
```

`within` を `@testing-library/react` の import に足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/misc.test.tsx -t SessionsScreen`
Expected: FAIL

- [ ] **Step 3: 書き換える**

`SessionsScreen.tsx` の `PERIODS` と、プロジェクト、期間、実行中の 3 つの `select` を置き換える。

```tsx
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';

const DAY = 86_400_000;
/** 期間の選択肢。値は「今から何日前まで」を表し、空は絞り込みなし。 */
const PERIODS = [{ value: '', label: '全期間' }, { value: '1', label: '今日' }, { value: '7', label: '7 日' }, { value: '30', label: '30 日' }];
// 帯の名前を「状態」にする。「実行中」という名前の帯の中に「実行中」の項目があると、読み上げで区別しにくいため。
const RUNNING = [{ value: '', label: 'すべて' }, { value: 'running', label: '実行中', lead: <span className="st-dot seg-live" /> }, { value: 'ended', label: '終了' }];
```

3 つの `select` の代わりに次を置く（`<input ... aria-label="ファイル" ...>` から後はそのまま）。

```tsx
        <Listbox label="プロジェクト" value={props.filter.projectId ?? ''} options={[{ value: '', label: 'すべてのプロジェクト' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={(v) => emit({ type: 'search.filter', patch: { projectId: v || undefined } })} faceClassName="listbox-face listbox-pill" minWidth={280} searchPlaceholder="プロジェクトを探す" />
        <Segmented label="期間" value={PERIODS.some((p) => p.value === period) ? period : ''} options={PERIODS}
          onChange={(v) => emit({ type: 'search.filter', patch: { since: v ? Date.now() - Number(v) * DAY : undefined } })} />
        <Segmented label="状態" value={props.filter.running === undefined ? '' : props.filter.running ? 'running' : 'ended'} options={RUNNING}
          onChange={(v) => emit({ type: 'search.filter', patch: { running: v === '' ? undefined : v === 'running' } })} />
```

- [ ] **Step 4: 見た目を足す**

`controls.css` の末尾に足す。

```css
/* 状態の帯の「実行中」に添える、動いていることを示す緑の点。 */
.seg-live { background: var(--idle); }
```

- [ ] **Step 5: 通ることを確かめてコミット**

Run: `npx vitest run packages/ui/src`
Expected: PASS

```bash
git add packages/ui/src/views/SessionsScreen.tsx packages/ui/src/views/misc.test.tsx packages/ui/src/styles/controls.css
git commit -m "feat(ui): filter sessions with segmented period and state and a searchable project list"
```

---

### Task 11: セッション画面の表示切り替え

**Files:**
- Modify: `packages/ui/src/views/SessionScreen.tsx:107-117`
- Test: `packages/ui/src/views/SessionScreen.test.tsx:22-37`
- Test: `packages/ui/src/Root.test.tsx:124-136`

**Interfaces:**
- Consumes: `ToggleChip`、`Segmented`、`Listbox`、`pick`。

- [ ] **Step 1: 試験を書き直す**

`SessionScreen.test.tsx` の「ヘッダー、要約の開閉、切替、続きの読み込み」の最後の 2 行（`fireEvent.change(screen.getByLabelText('サブエージェント'), ...)` とその `expect`）を次に置き換える。
`base` の `subagents` が 3 つ以下で `'abc'` を含むことを確かめる（含まなければ、この試験の render に `subagents={['abc']}` を足す）。

```tsx
    fireEvent.click(screen.getByRole('radio', { name: 'abc' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
    fireEvent.click(screen.getByRole('radio', { name: '主線' }));
```

同じ試験の `fireEvent.click(screen.getByLabelText('思考を表示'))` はそのまま通る（チップの読み上げの名前を残すため）。
同じ `describe` に次の 2 つを足す。

```tsx
  it('思考と生の記録は、押した状態を aria-pressed で見せる', () => {
    render(<IntentRoot onIntent={() => {}}><SessionScreen {...base} terminalStatus={null} showThinking showRaw={false} /></IntentRoot>);
    expect(screen.getByRole('button', { name: '思考を表示' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '生の記録を表示' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('サブエージェントが 4 つ以上なら一覧にする', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SessionScreen {...base} terminalStatus={null} subagents={['a1', 'a2', 'a3', 'a4']} /></IntentRoot>);
    expect(screen.queryByRole('radiogroup', { name: 'サブエージェント' })).toBeNull();
    pick('サブエージェント', 'サブエージェント a3');
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'a3' });
  });
```

ファイルの先頭に `import { pick } from '../test/pick.ts';` を足す。

`Root.test.tsx` の「セッションを開くとサブエージェントの一覧が届き、選択欄が出る」の最後の 2 行を次に置き換え、`within` を import に足す。

```tsx
    const group = screen.getByRole('radiogroup', { name: 'サブエージェント' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['主線', 'agent-1']);
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/Root.test.tsx`
Expected: FAIL

- [ ] **Step 3: 書き換える**

`SessionScreen.tsx` の `toggles` を次に置き換え、`ToggleChip`、`Segmented`、`Listbox`、`Icon` を import する（`Icon` が既に import されていれば足さない）。

```tsx
  // サブエージェントは、主線と 3 つまでなら帯に並べ、それより多ければ一覧にする。帯が横にあふれないようにするため。
  const agentOptions = [{ value: '', label: '主線' }, ...props.subagents.map((a) => ({ value: a, label: a }))];
  const selectAgent = (v: string) => emit({ type: 'transcript.selectAgent', sessionId: id, agentId: v || null });
  const toggles = (
    <div className="transcript-toggles">
      <ToggleChip label="思考を表示" text="思考" icon="thinking" pressed={props.showThinking} onChange={(show) => emit({ type: 'transcript.showThinking', sessionId: id, show })} />
      <ToggleChip label="生の記録を表示" text="生の記録" icon="rawLog" pressed={props.showRaw} onChange={(show) => emit({ type: 'transcript.showRaw', sessionId: id, show })} />
      {props.subagents.length > 0 && <span className="transcript-toggles-sep" aria-hidden="true" />}
      {props.subagents.length > 0 && (props.subagents.length <= 3
        ? <Segmented label="サブエージェント" value={props.agentId ?? ''} options={agentOptions.map((o) => (o.value ? { ...o, lead: <Icon name="agent" /> } : o))} onChange={selectAgent} />
        : <Listbox label="サブエージェント" value={props.agentId ?? ''} options={agentOptions.map((o) => (o.value ? { ...o, label: `サブエージェント ${o.value}`, icon: 'agent' as const } : o))} onChange={selectAgent} faceClassName="listbox-face listbox-pill" minWidth={260} />)}
      <span className="spacer" /><span className="faint mono">{props.loaded} / {props.total}</span>
    </div>
  );
```

`controls.css` の末尾に足す。

```css
/* セッション画面の、本文の上の表示切り替え。 */
.transcript-toggles { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--u) * 2); margin-bottom: var(--u); }
.transcript-toggles-sep { width: 1px; height: 18px; background: var(--line-strong); }
```

- [ ] **Step 4: 通ることを確かめてコミット**

Run: `npx vitest run packages/ui/src`
Expected: PASS

```bash
git add packages/ui/src/views/SessionScreen.tsx packages/ui/src/views/SessionScreen.test.tsx packages/ui/src/Root.test.tsx packages/ui/src/styles/controls.css
git commit -m "feat(ui): toggle thinking and raw log with chips and switch subagents on a segmented control"
```

---

### Task 12: 設定画面

**Files:**
- Modify: `packages/ui/src/views/SettingsScreen.tsx`
- Modify: `packages/ui/src/styles/settings.css`
- Test: `packages/ui/src/views/misc.test.tsx`（SettingsScreen の試験）

**Interfaces:**
- Consumes: `Switch`、`Segmented`、`Listbox`、`Stepper`、`pick`。

- [ ] **Step 1: 試験を書き直す**

`misc.test.tsx` の SettingsScreen の試験のうち、次を置き換える。
名前はいまの試験名で探す。

「チェックボックスと上限だけを変えても要約器の保存は押せる」を次に置き換える。

```tsx
  it('上限だけを変えても要約器の保存は押せる。スイッチは保存の対象に入らない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const save = screen.getByText('要約器の設定を保存');
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Claude へ切り替える' }));
    expect(save).toBeDisabled();
    // 読めない上限も「変えた」に入れる。押せないと案内を出す道が無くなる。
    fireEvent.change(screen.getByLabelText('1 時間の上限'), { target: { value: '' } });
    expect(save).toBeEnabled();
  });
  it('スイッチは切り替えた時点で、その 1 項目だけを保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByRole('switch', { name: 'Claude へ切り替える' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { summaryFallback: false } });
  });
  it('1 時間の上限は − と ＋ でも変えられる', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '1 時間の上限を増やす' }));
    expect(screen.getByLabelText('1 時間の上限')).toHaveValue(21);
  });
```

「ツールのパスとターミナルアプリを保存する」を次に置き換える。
`settingsProps()` の既定の `terminalApp` が `'terminal'` であることを先に確かめる（`'iterm'` なら、押す radio を `Terminal.app` に、patch を `{ terminalApp: 'terminal' }` に入れ替える）。

```tsx
  it('ターミナルアプリは切り替えた時点で保存し、ツールの保存はパスだけを送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ version: '0.2.0', index: { phase: 'idle', done: 3, total: 3 }, projectCount: 1 })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: 'iTerm2' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { terminalApp: 'iterm' } });
    expect(screen.getByText('ツールの設定を保存')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('code のパス'), { target: { value: '/usr/local/bin/code' } });
    fireEvent.click(screen.getByText('ツールの設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { codePath: '/usr/local/bin/code' } });
    expect(screen.getByText('npm run hangar -- mcp install')).toBeInTheDocument();
  });
```

「サーバが正規化した値に入力欄が追従する」の `expect(screen.getByLabelText('ターミナルアプリ')).toHaveValue('iterm');` を次に置き換える。

```tsx
    expect(screen.getByRole('radio', { name: 'iTerm2' })).toHaveAttribute('aria-checked', 'true');
```

「要約器の URL とモデルとフォールバックを保存する」を次に置き換える。

```tsx
  it('要約器の URL とモデルと上限を保存する', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ summarizerModels: ['qwen', 'gemma'] })} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('LM Studio の URL'), { target: { value: 'http://127.0.0.1:2345' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: null, summaryHourlyCap: 20 } });
    pick('モデル', 'qwen');
    fireEvent.change(screen.getByLabelText('1 時間の上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('要約器の設定を保存'));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'settings.update', patch: { lmStudioUrl: 'http://127.0.0.1:2345', lmStudioModel: 'qwen', summaryHourlyCap: 5 } });
  });
```

「外部の要約器を許すときは、本文が送られることを書く」を次に置き換える。

```tsx
  it('外部の要約器をオンにするときは、保存済みの宛先を示して確かめる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ lmStudioUrl: 'https://summarizer.example.com' })} /></IntentRoot>);
    const sw = screen.getByRole('switch', { name: '外部の要約器を許す' });
    fireEvent.click(sw);
    // まだ保存しない。スイッチもオフのまま。
    expect(onIntent).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/https:\/\/summarizer\.example\.com へ送られます/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByText(/へ送られます/)).toBeNull();
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: '許す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { allowExternalSummarizer: true } });
  });
  it('確かめの宛先は、書きかけの URL ではなく保存済みの URL', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ lmStudioUrl: 'http://127.0.0.1:1234' })} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('LM Studio の URL'), { target: { value: 'https://other.example.com' } });
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約器を許す' }));
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:1234 へ送られます/)).toBeInTheDocument();
  });
  it('外部の要約器をオフにするときは確かめずに保存し、オンの間は警告を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ allowExternalSummarizer: true, lmStudioUrl: 'https://summarizer.example.com' })} /></IntentRoot>);
    expect(screen.getByRole('switch', { name: '外部の要約器を許す' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('会話の本文');
    fireEvent.click(screen.getByRole('switch', { name: '外部の要約器を許す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'settings.update', patch: { allowExternalSummarizer: false } });
  });
```

「1 時間の上限が整数でなければ保存せず案内を出す」の最後の `expect` の patch を `{ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryHourlyCap: 12 }` にする。

「Claude Code の設定を同期する」を押す試験（344 行付近）は、`getByLabelText` のまま通る。
その近くで `.checked` を読んでいる行があれば、`toHaveAttribute('aria-checked', ...)` に直す。

ファイルの先頭に `import { pick } from '../test/pick.ts';` を足す（Task 10 で足していれば不要）。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/misc.test.tsx`
Expected: FAIL

- [ ] **Step 3: 状態と保存を組み替える**

`SettingsScreen.tsx` を次のとおりに変える。

import に足す。

```tsx
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { Stepper } from './primitives/Stepper.tsx';
import { Switch } from './primitives/Switch.tsx';
```

`terminalApp`、`fallback`、`allowExternal` の `useState` と、それを props に合わせる 3 つの `useEffect` を消し、代わりに確かめの帯の状態を足す。

```tsx
  // 外部の要約器をオンにする前の確かめの帯。オンにするまでは、スイッチもオフのままにする。
  const [confirmExternal, setConfirmExternal] = useState(false);
  useEffect(() => { if (props.allowExternalSummarizer) setConfirmExternal(false); }, [props.allowExternalSummarizer]);
  const setNow = (patch: Partial<SettingsDto>) => emit({ type: 'settings.update', patch });
```

`saveSummarizer` の `emit` を次にする。

```tsx
    emit({ type: 'settings.update', patch: { lmStudioUrl: lmUrlValue, lmStudioModel: lmModelValue, summaryHourlyCap: capNumber } });
```

`toolsPatch` から `if (terminalApp !== props.terminalApp) toolsPatch.terminalApp = terminalApp;` の行と、その上の terminalApp の注記 2 行を消す。
`summarizerDirty` を次にし、上の注記の「5 項目」を「3 項目」に直す。

```tsx
  const summarizerDirty = lmUrlValue !== props.lmStudioUrl || lmModelValue !== props.lmStudioModel || capNumber !== props.summaryHourlyCap;
```

- [ ] **Step 4: 描画を差し替える**

ターミナルアプリの `<label className="field">…<select>…</select></label>` を次に置き換える。

```tsx
          <div className="field">
            <span aria-hidden="true">ターミナルアプリ</span>
            {/* 切り替えた時点で保存する。iTerm2 は初回に macOS の自動化の許可ダイアログが出る。 */}
            <Segmented label="ターミナルアプリ" value={props.terminalApp} options={[{ value: 'terminal', label: 'Terminal.app', lead: <Icon name="openTerminal" /> }, { value: 'iterm', label: 'iTerm2', lead: <Icon name="appWindow" /> }]} onChange={(v) => setNow({ terminalApp: v as TerminalApp })} />
          </div>
```

`Icon` を import に足す（`import { Icon } from './primitives/Icon.tsx';`）。

要約器のモデルの `<select>` を次に置き換える。

```tsx
          <div className="field"><span aria-hidden="true">モデル</span>
            <Listbox label="モデル" value={lmModel} options={[{ value: '', label: '自動（最初のモデル）' }, ...(props.summarizerModels ?? []).map((m) => ({ value: m, label: m }))]} onChange={setLmModel} searchPlaceholder="モデルを探す" />
          </div>
```

外部の要約器、Claude へ切り替え、1 時間の上限の 3 行（`<label className="settings-row">…`）と、その間の警告を次に置き換える。

```tsx
        <div className="settings-row settings-switch-row"><span>手元の外にある要約器を許す</span>
          <Switch label="外部の要約器を許す" checked={props.allowExternalSummarizer} onChange={(next) => { if (next) setConfirmExternal(true); else setNow({ allowExternalSummarizer: false }); }} />
        </div>
        {confirmExternal && !props.allowExternalSummarizer && (
          <div className="confirm-strip" role="group" aria-label="外部の要約器を許すかの確かめ">
            {/* 送られる先は保存済みの URL。欄を書き換えただけでは宛先は変わらない。 */}
            <span>会話の本文（利用者の発言とアシスタントの応答）が {props.lmStudioUrl} へ送られます。</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setConfirmExternal(false)}>やめる</button>
            <button className="btn btn-primary" onClick={() => { setConfirmExternal(false); setNow({ allowExternalSummarizer: true }); }}>許す</button>
          </div>
        )}
        {props.allowExternalSummarizer && <div className="error" role="alert" style={{ marginTop: 4 }}>会話の本文（利用者の発言とアシスタントの応答）が {props.lmStudioUrl || 'この宛先'} へ送られます。宛先を確かめてください。</div>}
        <div className="settings-row settings-switch-row"><span>LM Studio が使えないとき Claude へ切り替える</span>
          <Switch label="Claude へ切り替える" checked={props.summaryFallback} onChange={(next) => setNow({ summaryFallback: next })} />
        </div>
        <div className="settings-row"><span>1 時間の上限</span>
          <Stepper label="1 時間の上限" value={cap} min={1} max={200} onChange={(v) => { setCap(v); setCapError(false); }} />
          <span className="faint">件。1 から 200 まで。7 日の使用率が 80% を超えたら切り替えません。</span>
        </div>
```

警告の文の宛先は、いまは書きかけの `lmUrl` を出している。
オンの間の警告は保存済みの宛先のことなので、`props.lmStudioUrl` に揃える（試験もそれで書いた）。

「Claude Code の設定を同期する」の `<label className="settings-row">…<input type="checkbox" …/>…</label>` を次に置き換える。

```tsx
            <div className="settings-row settings-switch-row"><span>Claude Code の設定を同期する</span>
              <Switch label="Claude Code の設定を同期する" checked={props.cloud.syncClaudeConfig} onChange={(next) => emit({ type: 'settings.update', patch: { syncClaudeConfig: next } })} />
            </div>
```

`SettingsScreen.tsx` の中で `type="checkbox"` と `<select` を grep し、残っていないことを確かめる。

- [ ] **Step 5: 見た目を足す**

`settings.css` の末尾に足す。

```css
/* スイッチの行は、文を左に、スイッチを右端に置く。 */
.settings-switch-row { justify-content: space-between; max-width: 560px; }
/* 外部の要約器をオンにする前の確かめの帯。 */
.confirm-strip { display: flex; align-items: center; gap: calc(var(--u) * 2); margin-top: calc(var(--u) * 2); padding: calc(var(--u) * 2) calc(var(--u) * 3); border-radius: var(--r-lg); font-size: var(--fs-sm); color: var(--ink); background: color-mix(in srgb, var(--error) 6%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--error) 30%, transparent); }
```

- [ ] **Step 6: 通ることを確かめてコミット**

Run: `npx vitest run packages/ui/src && npm run typecheck -w packages/ui`
Expected: PASS、型のエラーなし

```bash
git add packages/ui/src/views/SettingsScreen.tsx packages/ui/src/views/misc.test.tsx packages/ui/src/styles/settings.css
git commit -m "feat(ui): save settings switches as they flip and confirm before allowing an external summarizer"
```

---

### Task 13: 昇格のダイアログと TODO の印

**Files:**
- Modify: `packages/ui/src/views/PromoteDialog.tsx`
- Modify: `packages/ui/src/views/TodoList.tsx`
- Modify: `packages/ui/src/styles/workbench.css:24-26`
- Test: `packages/ui/src/views/overlays.test.tsx:135-185`
- Test: `packages/ui/src/views/workbench.test.tsx:70-95`

**Interfaces:**
- Consumes: `CheckCard`（Task 6）。

- [ ] **Step 1: 試験を書き直す**

`overlays.test.tsx` の PromoteDialog の試験のうち、「run が生きているとファイルを移動できない」の `(… as HTMLInputElement).disabled` を `toBeDisabled()` に直し、「選択の行は palette.css の .field-row で並ぶ」を次に置き換える。
ほかの試験は `getByLabelText('git init する')` のまま通る。

```tsx
  it('2 つの選択は、何が起きるかを添えたカードで並ぶ', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></IntentRoot>);
    expect(screen.getByRole('checkbox', { name: 'git init する' })).toHaveAccessibleDescription('空のリポジトリを作ってから移します');
    expect(screen.getByRole('checkbox', { name: 'ファイルを移動する' })).toHaveAccessibleDescription('スクラッチのファイルをワークスペースへ移します');
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'true']);
  });
  it('run が生きているとき、ファイルを移動するのカードは印を外して押せない', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></IntentRoot>);
    expect(screen.getByRole('checkbox', { name: 'ファイルを移動する' })).toHaveAttribute('aria-checked', 'false');
  });
```

`paletteCss` を読んでいる行がこの試験だけなら、その import（`readFileSync` で読んでいる箇所）も試験の中で使われなくなる。
使われなくなったら消す（ほかの試験、224 行付近の `.dialog-promote .btn` の確かめで使っていれば残す）。

`workbench.test.tsx` の TodoList の試験に次を足す（ほかの試験は `getByLabelText` のまま通る）。

```tsx
  it('済みの印は checkbox の役割で、状態を aria-checked に出す', () => {
    wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false }, { id: 't2', text: '済んだ', done: true }]} />);
    expect(screen.getByRole('checkbox', { name: '買う（1 件目）' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: '済んだ（2 件目）' })).toHaveAttribute('aria-checked', 'true');
  });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run packages/ui/src/views/overlays.test.tsx packages/ui/src/views/workbench.test.tsx`
Expected: FAIL（説明が無い。TODO の印の aria-checked が無い）

- [ ] **Step 3: 昇格のダイアログを書き換える**

`PromoteDialog.tsx` の 2 つの `<label className="field-row">…</label>` を次に置き換え、`import { CheckCard } from './primitives/OptionCard.tsx';` を足す。

```tsx
        <CheckCard label="git init する" description="空のリポジトリを作ってから移します" icon="gitInit" checked={gitInit} onChange={setGitInit} />
        <CheckCard label="ファイルを移動する" description="スクラッチのファイルをワークスペースへ移します" icon="moveFiles" checked={willMove} disabled={props.runAlive} onChange={setMoveFiles} />
```

- [ ] **Step 4: TODO の印を書き換える**

`TodoList.tsx` の `<input type="checkbox" … />` を次に置き換える。

```tsx
            {/* 押すと緑に満ち、チェックの線が描かれる。線の描画は CSS の stroke-dashoffset で動かす。 */}
            <button type="button" role="checkbox" className="todo-check" aria-checked={t.done} aria-label={`${t.text}（${i + 1} 件目）`} onClick={() => emit({ type: 'todo.toggle', id: t.id })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </button>
```

`workbench.css` の 25〜26 行（`.todo-text` と `.todo[data-done='true'] .todo-text`）を次に置き換える。

```css
.todo-text { position: relative; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color var(--dur) var(--ease-out); }
/* 済んだ項目は、文字に線が左から引かれて薄くなる。 */
.todo-text::after { content: ''; position: absolute; left: 0; top: 50%; width: 0; height: 1px; background: var(--ink-3); transition: width var(--dur) var(--ease-out); }
.todo[data-done='true'] .todo-text { color: var(--ink-3); }
.todo[data-done='true'] .todo-text::after { width: 100%; }
.todo-check { display: grid; flex: none; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; color: #ffffff; background: none; box-shadow: inset 0 0 0 1.5px #c3c5d6; transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.todo-check svg { width: 12px; height: 12px; stroke-width: 3; stroke-dasharray: 24; stroke-dashoffset: 24; transition: stroke-dashoffset var(--dur) var(--ease-out); }
.todo-check:active { transform: scale(0.88); }
.todo-check[aria-checked='true'] { background: var(--st-done); box-shadow: none; }
.todo-check[aria-checked='true'] svg { stroke-dashoffset: 0; }
```

`.todo-text` の線は `overflow: hidden` の中で描くので、長い文言で省略記号が出ても線は枠の中に収まる。

- [ ] **Step 5: 通ることを確かめてコミット**

Run: `npx vitest run packages/ui/src`
Expected: PASS

```bash
git add packages/ui/src/views/PromoteDialog.tsx packages/ui/src/views/TodoList.tsx packages/ui/src/styles/workbench.css packages/ui/src/views/overlays.test.tsx packages/ui/src/views/workbench.test.tsx
git commit -m "feat(ui): explain the promote choices on cards and fill the TODO check as it is done"
```

---

### Task 14: 取りこぼしの確認、設計書、ビルド

**Files:**
- Modify: `docs/design.md`
- Modify: `docs/superpowers/specs/2026-09-30-choice-controls-design.md`（必要なときだけ）

- [ ] **Step 1: 素の部品が残っていないことを確かめる**

Run: `grep -rn "<select\|type=\"checkbox\"" packages/ui/src --include=*.tsx`
Expected: 何も出ない（試験のファイルも含めて）

Run: `grep -rn "HTMLSelectElement\|getByRole('combobox'" packages/ui/src`
Expected: Listbox の検索欄を見る試験（`Listbox.test.tsx`）だけが出る

- [ ] **Step 2: docs/design.md の画面の記述を直す**

`docs/design.md` で、新しいセッションのダイアログ、セッション一覧の絞り込み、設定の保存、昇格のダイアログ（649 行付近の「チェックボックス 2 つ」）を書いている箇所を探し、仕様書の「画面ごとの差し替え」と同じ内容に直す。
649 行は「名前と、何が起きるかを添えた 2 つの選択（`git init` するか、ファイルを移すか）を受け取って次を行う。」にする。
設定の節には、スイッチと帯は切り替えた時点で保存し、外部の要約器をオンにするときだけ確かめの帯を挟むことを足す。

- [ ] **Step 3: 全体の試験と型**

Run: `npx vitest run && npm run typecheck`
Expected: すべて PASS、型のエラーなし

- [ ] **Step 4: ビルド（UI とデスクトップ）**

Run: `npm run build`
Expected: vite build が通る

Run: `npm run bundle-server -w apps/desktop`
Expected: server-dist の作り直しが通る

Run（background で）: `npm run tauri -w apps/desktop -- build`
Expected: `apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app` ができる（数分かかる）

- [ ] **Step 5: 利用者の dev サーバを 1 つだけ落とす**

ビルドした回は、利用者が動かしている `npm run dev` のサーバ（4177 を LISTEN している tsx）を一度落とす。

```bash
lsof -nP -iTCP:4177 -sTCP:LISTEN -t
ps -o command= -p <PID>        # tsx の server だと目で確かめる
kill <PID>                     # その 1 つだけ。Vite（5173）には触らない
```

`lsof -ti :4177` の類は使わない（接続しているだけのプロセスも拾う）。
Hangar.app が走っていれば、`osascript -e 'tell application "Hangar" to quit'` で落とす。
落としたことを報告に 1 行で書く。

- [ ] **Step 6: 画面で確かめる**

利用者の Vite（`lsof -nP -iTCP:5173 -sTCP:LISTEN`）が動いていれば `http://localhost:5173` を読むだけで開き、次を目で確かめる。
Vite は元の作業ツリーを配っているので、この worktree の変更は写らない。
写らないときは、別のポートと一時の `HANGAR_HOME` でこの worktree の dev を立てて確かめ、自分の PID だけを止める。

- 新しいセッションで一覧を開き、スクロールしても検索欄とキーの案内が動かず、検索欄の下に影が出る。
- プロジェクトのカードのステータスを開くと、カードの外へはみ出しても切れない。
- 一覧を開いたまま Esc を押すと、一覧だけが閉じてダイアログは残る。
- 帯の白い玉が滑り、最初の表示では滑ってこない。

- [ ] **Step 7: コミット**

```bash
git add docs/design.md docs/superpowers/specs/2026-09-30-choice-controls-design.md
git commit -m "docs: describe the new choice controls in the design notes"
```
