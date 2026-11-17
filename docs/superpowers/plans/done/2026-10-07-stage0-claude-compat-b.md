# 段 0 Claude Code との互換の約束（計画 B 画面） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計画 A が記録する Claude Code の形式のずれを、設定の「連携」の群の先頭の節「Claude Code との互換」と、初回の確認リストの 6 行目に、試作の A4、B1、C2 のとおりに出す。

**Architecture:** 3 つの状態の文言、止めた機能の表、報告用の写しを 1 つの presenter（`presenters/compat.ts`）にまとめ、設定の節と確認リストの 6 行目が同じ `CompatProps` を読む。
状態は計画 A の `compatState` で決め、止めた機能は DTO に持たせず、presenter が契約と値の頭から引く。
ずれの中身（`GET /api/compat`）は、準備の確かめでずれが 1 件以上あるときにランタイムが続けて取り、store の `compat` に置く。
ずれの細目は `details` で畳み、「報告用に写す」は既存の `clipboard.copy` の意図で写す。

**Tech Stack:** TypeScript、React、vitest、Testing Library（jsdom）、確かめだけに playwright の WebKit。

**Spec:** `docs/superpowers/specs/2026-10-07-stage0-claude-compat-design.md` の「画面」の節である。
見た目と文言の正は、試作 `docs/superpowers/specs/2026-10-07-stage0-claude-compat/checks.html` の A4、B1、C2 である。
型と口は、計画 A（`docs/superpowers/plans/2026-10-07-stage0-claude-compat-a.md`）の Task 2 と Task 11 が作ったものを使う。

## 範囲

- 計画 B は、spec の「画面」の節のうち、計画 A が作らなかった見た目（presenter、View、CSS、文言）と、ずれの中身を取る時機である。
- 計画 A の Task 2（shared の `claudeCompat.ts`。段 1 の PR 3 が `compat.ts` に互換の版番号を置くので名前を分けた）と Task 11（`ReadinessDto.compat`、`GET /api/compat`、`ApiClient.compat`、偽の API と見本の `READY` の `compat`）が済んでいることを前提にする。
- 計画 B は新しい DTO も API も作らない。

## 決めたこと

- **ずれは、群の見出しの「直すもの N 件」に数えない。**
  spec は「ずれがあっても、設定の左の目次の点は灯さない」と言い、範囲外に「設定の目次の点に出すこと」を挙げている。
  試作の「あわせて決めること」は「利用者が直せるものではないので、試作では灯さない。灯すなら「直すもの」とは別の言葉が要る」としている。
  目次の点と群の見出しの札は同じ `todo.link` を読む（`SettingsScreen` の `todoOf`）ので、見出しだけ数えると点も灯ってしまう。
  design.md の「直すもの（無くても動くものを除く ✗）」の定義にも、ずれは当たらない。
  そこで `todo` は変えず、ずれは節の札だけで言う。
- **止めた機能は、契約に加えて値の頭でも引く。**
  計画 A は止めた機能を DTO に持たせず、画面が契約の名前から引く前提である。
  ただし CLI の契約は 4 つの出力（`--help`、`auth status`、`agents --json`、`-p` の JSON）を持ち、止めるものがそれぞれ違う。
  statusline の `resets_at=ms` と CLI の `subcommand.added`、`subcommand.removed` は自動で直すので、止めたものが無い。
  レジストリも、`status` と `pid` と読めない登録とで止めるものが違う。
  契約だけで引くと、止めていない機能を「止めています」と書くことになるので、契約ごとの表の中を値の頭（`=` か `.` の前）で分ける。
  文言は、計画 A の各契約がずれのときに実際にしていることに合わせ、どれも「〜を止めています」か「〜を控えています」で結ぶ（B1）。
- **ずれの中身は、準備の確かめでずれが 1 件以上あれば続けて取る。**
  計画 A は `api.compat()` を「6 行目を開いたときに呼ぶ」と想定していた。
  A4 は止めた機能の一覧を常に出すので、開くのを待てない。
  ずれが 0 件の答えが来たら、前に取った中身を捨てる。
  計画 A が書いた「開いたときに」の doc コメントと設計書の 1 行も、この計画で直す。
- **「報告用に写す」は既存の写し方に合わせる。**
  ボタンは `CopyButton` で、`clipboard.copy` の意図を出し、ランタイムが `navigator.clipboard.writeText` で写す。
  写せなければ、ランタイムが「コピーできませんでした。文字を選んで ⌘C で写してください」のトーストを出す。
  Tauri の WebKit でも同じ経路を使い、新しい道は作らない。
  表は畳んだ中で文字として出ているので、写せないときは選んで写せる。
  写すのは Markdown の表で、画面の表に無い回数と最後に見た時刻も載せる。
- **`compat` の無い古いサーバの答えでは、何も壊さない。**
  実データに UI だけを重ねて撮る確かめ（Task 5）では、サーバが UI より古いことがある。
  そのときは確認リストを 5 行のまま数え、設定の節は「確かめています」のままにし、ずれの中身は取りに行かない。
- **記録の置き場の文は、試作どおり `~/.agent-hangar/compat.json` と書く。**
  `CompatDto` は置き場を持たないので、`HANGAR_HOME` で hangar の置き場を変えたときは、文と実物がずれる。
  `HANGAR_HOME` は開発と試験のための口なので、このために DTO は足さない（計画 A の型をそのまま使う）。
- **試作に無い文言は、次のとおり足す。**
  止めた機能のうち試作に無い 8 つ（下の Task 1 の表。利用者に見せて 3 つを直した。statusline の行は値を出し続けるので「更新を止めています」、レジストリの行は「登録」をやめて節の本文と同じ「状態のファイル」、`--help` の行は設定の画面と同じ「外のターミナルの包み方」に合わせ、表の列も「外のターミナル」にした）、ずれはあっても止めた機能が無いときの「知らない形を記録しましたが、止めた機能はありません」、中身が届く前の「ずれの中身を読み込んでいます」、準備の確かめが届く前の「確かめています」、分からない版の「不明」、読み上げの「ずれはありません」「まだ確かめていない版です」「ずれがあります」である。

## Global Constraints

- 状態は 3 つで、計画 A の `compatState(summary)` で決める。`ok` は問題なし、`unverified` は未確認の版、`drift` はずれ N 件である。
- 問題なしは緑の ✓、未確認の版は灰色の ⓘ（新しい調子 `info`）、ずれは注意の色の !（確認リストは `soft`、設定の札は `warn`）である。
- 「6 つ中 N つ」は、未確認の版を済んだものとして数え、ずれは数えない。
- ずれがあっても、設定の左の目次の点は灯さず、群の見出しの「直すもの N 件」にも数えない。
- ずれを、設定の節と確認リストの外（ヘッダー、知らせの札、設定の目次の点）に出さない。
- 置き場は設定の「連携」の群の先頭の節と、初回の確認リストの 6 行目である（C2）。
- 群の見出しの添えは「Claude Code との互換、MCP、statusline、外のターミナル、通知、アカウント」にする。
- 試作の文言をそのまま使う（見出し「Claude Code との互換」、札「問題なし」「未確認の版」「ずれ N 件」）。
- 6 行目の場所の欄は「ずれなし（2.1.292 で確かめた版）」「2.1.300（確かめた版は 2.1.292）」「ずれ 3 件（2.1.300）」の形（B1）。
- 6 行目の説明は「hangar が読む Claude Code の形を見張っています」「まだ確かめていない版です。動きは止めていません」「知らない形に頼る機能だけを止め、ほかは動かしています」。
- 節の本文は「hangar は Claude Code の会話の記録、状態のファイル、statusline、`~/.claude` の項目、CLI の出力、画面の文字を読んでいます。知らない形に出会ったら、ここに出します。」で、その下に「手元の版」と「確かめた版」を並べる。
- 止めた機能の一覧は常に出し（A4）、契約、値、版、最初に見た、止めた機能の表を「ずれ N 件の中身」で畳む。
- 表で止めた機能の無い行は「なし」と淡く書く。
- 表の下に「記録はこの PC の `~/.agent-hangar/compat.json` にあります」と「報告用に写す」を置く。
- 試作にある止めた機能の文言は「ターンの目次から端末の指示へ跳ぶのを止めています」（表は「目次から跳ぶ」）と「休んでいるセッションを自動で止めるのを控えています」（表は「休みで止める」）である。
- 計画 A の名前と型（`CompatContract`、`CompatDriftDto`、`CompatDto`、`CompatSummaryDto`、`CompatState`、`compatState`、`ReadinessDto.compat`、`ApiClient.compat()`）をそのまま使い、新しく作らない。
- 色はトークンだけで書き、ダークモードは持たない（UI はいつも明るい）。
- 開いているかどうか（`details` の開閉）は画面の中だけの見え方なので、Mediator には置かない。
- 計画にも試験にも、実在の人名、メールアドレス、手元のパス、実際の使用量を書かない（公開リポジトリである）。
- コメントは日本語で、周りと同じ密度にする。
- コミットのメッセージは英語で、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。
- 試験は `npx vitest run <ファイル>`、型は `npm run typecheck`、どちらもリポジトリの根で打つ。
- 撮った画像はリポジトリに入れない。
- 実データに重ねて撮るときは読むだけで、ボタンは押さない。

## Review Focus

- **ずれはあっても、止めた機能が 1 つも無い（新しい claude で `subcommand.added=…` だけ、または statusline の `resets_at=ms` だけ）**：注意の札と件数は出し、止めた機能の一覧は出さず、「知らない形を記録しましたが、止めた機能はありません」と言う。新しい claude を入れるたびに起きうる。Task 1 と Task 4 の試験で留める。
- **同じ止めた機能に当たるずれが何件もある（`status=thinking` と `status=compacting`、`prompt-marker` と `transcript-footer`）**：止めた機能の一覧は機能ごとに 1 行にまとめ、表は 1 件ずつ出す。Task 1 の試験で留める。
- **値に縦棒、改行、バッククォートが入る（Claude Code の知らない値はそのまま記録される）**：「報告用に写す」の Markdown の表が崩れない。Task 1 の試験で留める。
- **手元の claude が見つからない（`localVersion` が null）、版の分からないずれ（`version` が null）**：「手元の版 不明」と「不明」を出し、6 行目は「ずれ N 件」だけにして落ちない。Task 1 の試験で留める。
- **準備の確かめに `compat` の無い古いサーバ（UI だけを重ねて撮るとき）**：確認リストは 5 行で数え、設定の節は「確かめています」のまま、ずれの中身は取りに行かない。Task 2、Task 3、Task 4 の試験で留める。

## ファイルの地図

| ファイル | 役目 |
| --- | --- |
| `packages/ui/src/presenters/compat.ts`（新規） | 3 つの状態の文言、止めた機能の表、報告用の写し |
| `packages/ui/src/store/store.ts` | ずれの中身 `compat` |
| `packages/ui/src/runtime/runtime.ts` | ずれがあれば、準備の確かめに続けて中身を取る |
| `packages/ui/src/presenters/readiness.ts` | 確認リストの 6 行目と、行の調子と読み上げ |
| `packages/ui/src/presenters/onboarding.ts` | 6 行目に中身と hangar の版を渡す |
| `packages/ui/src/views/CompatSection.tsx`（新規） | ずれの中身（A4）と、設定の節（C2） |
| `packages/ui/src/views/Onboarding.tsx` | 行の印を調子で引き、互換の行にずれの中身を出す |
| `packages/ui/src/views/primitives/CommandLine.tsx` | `CopyButton` の読み上げの名前 |
| `packages/ui/src/presenters/settings.ts` | 設定の互換の節 |
| `packages/ui/src/views/SettingsScreen.tsx` | 連携の群の先頭に節を置き、群の添えに足す |
| `packages/ui/src/styles/readiness.css` | `info` の調子と、ずれの中身の見た目 |
| `packages/ui/src/styles/settings.css` | `info` の札、版の並び、群の見出しの折り返し |
| `docs/design.md` | 「Home」「Settings」「Claude Code との互換」の節 |

---

### Task 1: 互換の presenter（文言、止めた機能の表、報告用の写し）

**Files:**
- Create: `packages/ui/src/presenters/compat.ts`
- Test: `packages/ui/src/presenters/compat.test.ts`

**Interfaces:**
- Consumes: `CompatContract`、`CompatDriftDto`、`CompatDto`、`CompatState`、`CompatSummaryDto`、`compatState(s: CompatSummaryDto): CompatState`（計画 A の Task 2、`@agent-hangar/shared`）。`absoluteTime(ts: number | null): string`（`presenters/format.ts`）。
- Produces: `CompatStop = { short: string; line: string }`、`CONTRACT_LABEL: Record<CompatContract, string>`、`stopOf(d: Pick<CompatDriftDto, 'contract' | 'value'>): CompatStop | null`。
- Produces: `CompatRow = { key: string; contract: string; value: string; version: string; firstSeen: string; stop: string | null }`。
- Produces: `CompatProps = { state: CompatState; note: string; lead: string; badge: string; localVersion: string; verifiedVersion: string; count: number; stops: string[] | null; rows: CompatRow[] | null; report: string | null }`。
- Produces: `presentCompat(summary: CompatSummaryDto, full: CompatDto | null, hangarVersion: string): CompatProps`、`compatReport(summary: CompatSummaryDto, drifts: CompatDriftDto[], hangarVersion: string): string`、`seenLabel(ts: number): string`。
  Task 3 と Task 4 が使う。

止めた機能の表は次のとおりである。
左の 2 列が当てる契約と値の形、右の 2 列が表の列（short）と常に出す一覧の 1 行（line）である。
上から見て、最初に当たった行を使う。

| 契約 | 値の形 | short | line |
| --- | --- | --- | --- |
| トランスクリプト | すべて | （なし） | （なし） |
| レジストリ | `status=` | 休みで止める | 休んでいるセッションを自動で止めるのを控えています |
| レジストリ | `pid=` | 引き取り | 外のターミナルで動いている会話を引き取るのを止めています |
| レジストリ | ほか（`sessionId=`、`entry=`） | 実行中の印 | 状態のファイルが読めない会話を、実行中として出すのを控えています |
| statusline | `….resets_at=ms` | （なし） | （なし） |
| statusline | ほか | 使用率の一部 | 使用率のゲージの欠けた項目の更新を止めています |
| `~/.claude` の項目 | すべて | アカウントの共有 | 新しい ~/.claude の項目をアカウントの間で共有するのを控えています |
| CLI | `help.` | 外のターミナル | 外のターミナルの包み方で、サブコマンドの一覧を claude --help から作るのを止めています |
| CLI | `auth-status` | ログインの状態 | アカウントのログインの状態を読むのを止めています |
| CLI | `agents-json` | attach で再開 | バックグラウンドのセッションを attach で再開するのを止めています |
| CLI | `print-json` | Claude で要約 | Claude で要約するのを止めています |
| CLI | ほか（`subcommand.`） | （なし） | （なし） |
| 画面の文字 | すべて | 目次から跳ぶ | ターンの目次から端末の指示へ跳ぶのを止めています |

根拠は計画 A の各契約である。
トランスクリプトは、知らない行を meta として残し、知らない塊を捨てる（いまの扱いのまま）。
レジストリは、知らない `status` を作業中と読むので休みで止めず、`pid` が無いと引き取りの前にプロセスを確かめられず、`sessionId` の無い登録と配列の登録は読まない。
statusline は、ミリ秒の `resets_at` をそのまま使い、欠けた項目は直前の値を保つ。
CLI は、`--help` が読めなければ組み込みの一覧で包みを書き、ほかの出力は形が違えば読まずに既定へ落とす。

- [ ] **Step 1: 落ちる試験を書く**

`packages/ui/src/presenters/compat.test.ts` を作る。

```ts
import { describe, expect, it } from 'vitest';
import type { CompatDriftDto, CompatDto, CompatSummaryDto } from '@agent-hangar/shared';
import { compatReport, CONTRACT_LABEL, presentCompat, seenLabel, stopOf } from './compat.ts';

// 時刻は端末の時刻帯で組む。表は端末の時刻で書くので、どの時刻帯でも同じ文字になる。
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
const drift = (contract: CompatDriftDto['contract'], value: string, over: Partial<CompatDriftDto> = {}): CompatDriftDto => ({ contract, value, version: '2.1.300', count: 1, firstSeenAt: at(7, 14, 2), lastSeenAt: at(7, 14, 9), ...over });
const SUM: CompatSummaryDto = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 3 };
// 試作の 3 件。2 件が機能を止め、1 件は記録だけである。
const DETAIL: CompatDto = {
  verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
    drift('screen', 'prompt-marker=(missing)', { count: 2 }),
    drift('registry', 'status=compacting', { count: 5, firstSeenAt: at(7, 13, 40), lastSeenAt: at(7, 14, 5) }),
    drift('transcript', 'system.subtype=turn_summary', { version: '2.1.298', count: 9, firstSeenAt: at(6, 22, 15), lastSeenAt: at(7, 14, 1) }),
  ],
};

describe('止めた機能の表（stopOf）', () => {
  it('試作の 3 行：画面の文字は目次から跳ぶ、レジストリの状態は休みで止める、トランスクリプトは記録だけ', () => {
    expect(stopOf(drift('screen', 'prompt-marker=(missing)'))).toEqual({ short: '目次から跳ぶ', line: 'ターンの目次から端末の指示へ跳ぶのを止めています' });
    expect(stopOf(drift('screen', 'transcript-footer=(missing)'))?.short).toBe('目次から跳ぶ');
    expect(stopOf(drift('registry', 'status=compacting'))).toEqual({ short: '休みで止める', line: '休んでいるセッションを自動で止めるのを控えています' });
    expect(stopOf(drift('transcript', 'system.subtype=turn_summary'))).toBeNull();
    expect(stopOf(drift('transcript', 'attachment.type=queued_prompt'))).toBeNull();
  });
  it('レジストリは、pid が無ければ引き取りを、読めない登録は実行中の印を止める', () => {
    expect(stopOf(drift('registry', 'pid=(missing)'))).toEqual({ short: '引き取り', line: '外のターミナルで動いている会話を引き取るのを止めています' });
    expect(stopOf(drift('registry', 'sessionId=(missing)'))).toEqual({ short: '実行中の印', line: '状態のファイルが読めない会話を、実行中として出すのを控えています' });
    expect(stopOf(drift('registry', 'entry=(not-object)'))?.short).toBe('実行中の印');
  });
  it('statusline は、ミリ秒の resets_at は記録だけで、欠けた項目は使用率の一部を止める', () => {
    expect(stopOf(drift('statusline', 'rate_limits.seven_day.resets_at=ms'))).toBeNull();
    expect(stopOf(drift('statusline', 'rate_limits.five_hour.resets_at=(missing)'))).toEqual({ short: '使用率の一部', line: '使用率のゲージの欠けた項目の更新を止めています' });
    expect(stopOf(drift('statusline', 'session_id=(missing)'))?.short).toBe('使用率の一部');
  });
  it('~/.claude の項目は、アカウントの間で共有するのを控える', () => {
    expect(stopOf(drift('claude-dir', 'entry=brand-new'))).toEqual({ short: 'アカウントの共有', line: '新しい ~/.claude の項目をアカウントの間で共有するのを控えています' });
  });
  it('CLI は出力の種類ごとに止めるものが違い、サブコマンドの増減は記録だけ', () => {
    expect(stopOf(drift('cli', 'help.commands=(missing)'))).toEqual({ short: '外のターミナル', line: '外のターミナルの包み方で、サブコマンドの一覧を claude --help から作るのを止めています' });
    expect(stopOf(drift('cli', 'auth-status=(not-json)'))).toEqual({ short: 'ログインの状態', line: 'アカウントのログインの状態を読むのを止めています' });
    expect(stopOf(drift('cli', 'auth-status.loggedIn=(missing)'))?.short).toBe('ログインの状態');
    expect(stopOf(drift('cli', 'agents-json.kind=remote'))).toEqual({ short: 'attach で再開', line: 'バックグラウンドのセッションを attach で再開するのを止めています' });
    expect(stopOf(drift('cli', 'print-json.structured_output=(missing)'))).toEqual({ short: 'Claude で要約', line: 'Claude で要約するのを止めています' });
    expect(stopOf(drift('cli', 'subcommand.added=newcmd'))).toBeNull();
    expect(stopOf(drift('cli', 'subcommand.removed=purge'))).toBeNull();
  });
  it('止めた機能の 1 行は、どれも「〜を止めています」か「〜を控えています」で結ぶ（B1）', () => {
    const cases: [CompatDriftDto['contract'], string][] = [
      ['screen', 'prompt-marker=(missing)'], ['registry', 'status=x'], ['registry', 'pid=(missing)'], ['registry', 'entry=(not-object)'],
      ['statusline', 'model=(missing)'], ['claude-dir', 'entry=x'], ['cli', 'help.commands=(missing)'], ['cli', 'auth-status=(not-json)'],
      ['cli', 'agents-json=(not-json)'], ['cli', 'print-json=(not-json)'],
    ];
    for (const [c, v] of cases) expect(stopOf(drift(c, v))!.line, `${c} ${v}`).toMatch(/(止めています|控えています)$/);
  });
  it('契約の呼び名は spec の 6 つ', () => {
    expect(CONTRACT_LABEL).toEqual({ transcript: 'トランスクリプト', registry: 'レジストリ', statusline: 'statusline', 'claude-dir': '~/.claude の項目', cli: 'CLI', screen: '画面の文字' });
  });
});

describe('seenLabel', () => {
  it('表の時刻は、月と日と時刻だけにする', () => {
    expect(seenLabel(at(7, 9, 5))).toBe('10/07 09:05');
  });
});

describe('presentCompat', () => {
  it('問題なしは、確かめた版だけを添えて、見張っていると言う', () => {
    expect(presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 }, null, '0.3.0')).toEqual({
      state: 'ok', note: 'ずれなし（2.1.292 で確かめた版）', lead: 'hangar が読む Claude Code の形を見張っています', badge: '問題なし',
      localVersion: '2.1.292', verifiedVersion: '2.1.292', count: 0, stops: null, rows: null, report: null,
    });
  });
  it('未確認の版は、手元の版と確かめた版を出し、止めていないと言う', () => {
    expect(presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 0 }, null, '')).toEqual({
      state: 'unverified', note: '2.1.300（確かめた版は 2.1.292）', lead: 'まだ確かめていない版です。動きは止めていません', badge: '未確認の版',
      localVersion: '2.1.300', verifiedVersion: '2.1.292', count: 0, stops: null, rows: null, report: null,
    });
  });
  it('ずれの中身が届く前は、件数だけを出して読み込み中と言う', () => {
    expect(presentCompat(SUM, null, '')).toEqual({
      state: 'drift', note: 'ずれ 3 件（2.1.300）', lead: 'ずれの中身を読み込んでいます', badge: 'ずれ 3 件',
      localVersion: '2.1.300', verifiedVersion: '2.1.292', count: 3, stops: null, rows: null, report: null,
    });
  });
  it('止めた機能は機能ごとに 1 行にまとめて常に出し、表は 1 件ずつ届いた順に並べる', () => {
    const more: CompatDto = { ...DETAIL, drifts: [...DETAIL.drifts, drift('registry', 'status=thinking'), drift('screen', 'transcript-footer=(missing)')] };
    const p = presentCompat({ ...SUM, driftCount: 5 }, more, '0.3.0');
    expect(p.stops).toEqual(['ターンの目次から端末の指示へ跳ぶのを止めています', '休んでいるセッションを自動で止めるのを控えています']);
    expect(p.lead).toBe('知らない形に頼る機能だけを止め、ほかは動かしています');
    expect(p.rows).toHaveLength(5);
    expect(p.rows!.slice(0, 3)).toEqual([
      { key: 'screen:prompt-marker=(missing)', contract: '画面の文字', value: 'prompt-marker=(missing)', version: '2.1.300', firstSeen: '10/07 14:02', stop: '目次から跳ぶ' },
      { key: 'registry:status=compacting', contract: 'レジストリ', value: 'status=compacting', version: '2.1.300', firstSeen: '10/07 13:40', stop: '休みで止める' },
      { key: 'transcript:system.subtype=turn_summary', contract: 'トランスクリプト', value: 'system.subtype=turn_summary', version: '2.1.298', firstSeen: '10/06 22:15', stop: null },
    ]);
  });
  it('中身が届いていれば、件数は中身の数にそろえる', () => {
    expect(presentCompat({ ...SUM, driftCount: 1 }, DETAIL, '')).toMatchObject({ count: 3, note: 'ずれ 3 件（2.1.300）', badge: 'ずれ 3 件' });
  });
  it('ずれはあっても止めた機能が無ければ、一覧を空にして、記録だけだと言う', () => {
    const only: CompatDto = { ...DETAIL, drifts: [drift('cli', 'subcommand.added=newcmd', { version: null }), drift('statusline', 'rate_limits.five_hour.resets_at=ms')] };
    const p = presentCompat({ ...SUM, driftCount: 2 }, only, '');
    expect(p).toMatchObject({ state: 'drift', badge: 'ずれ 2 件', stops: [], lead: '知らない形を記録しましたが、止めた機能はありません' });
    expect(p.rows!.map((r) => [r.version, r.stop])).toEqual([['不明', null], ['2.1.300', null]]);
  });
  it('手元の版が分からなければ「不明」と書き、6 行目の件数には版を添えない', () => {
    expect(presentCompat({ ...SUM, localVersion: null }, DETAIL, '')).toMatchObject({ state: 'drift', note: 'ずれ 3 件', localVersion: '不明' });
    expect(presentCompat({ verifiedVersion: '2.1.292', localVersion: null, driftCount: 0 }, null, '')).toMatchObject({ state: 'ok', localVersion: '不明' });
  });
});

describe('compatReport', () => {
  it('ずれの一覧を、回数と最後に見た時刻も持つ Markdown の表にする', () => {
    expect(compatReport(SUM, DETAIL.drifts, '0.3.0')).toBe([
      'Claude Code との互換のずれ（hangar 0.3.0）',
      '手元の版 2.1.300、確かめた版 2.1.292',
      '',
      '| 契約 | 値 | 版 | 回数 | 最初に見た | 最後に見た | 止めた機能 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 画面の文字 | `prompt-marker=(missing)` | 2.1.300 | 2 | 2026-10-07 14:02 | 2026-10-07 14:09 | 目次から跳ぶ |',
      '| レジストリ | `status=compacting` | 2.1.300 | 5 | 2026-10-07 13:40 | 2026-10-07 14:05 | 休みで止める |',
      '| トランスクリプト | `system.subtype=turn_summary` | 2.1.298 | 9 | 2026-10-06 22:15 | 2026-10-07 14:01 | なし |',
    ].join('\n'));
    expect(presentCompat(SUM, DETAIL, '0.3.0').report).toBe(compatReport(SUM, DETAIL.drifts, '0.3.0'));
  });
  it('値の縦棒と改行で表が崩れず、バッククォートのある値は 2 つで囲む。hangar の版が無ければ頭に書かない', () => {
    const text = compatReport({ ...SUM, localVersion: null }, [drift('transcript', 'type=a|b\nc'), drift('cli', 'subcommand.added=x`y', { version: null })], '');
    const lines = text.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Claude Code との互換のずれ', '手元の版 不明、確かめた版 2.1.292']);
    expect(lines[5]).toBe('| トランスクリプト | `type=a\\|b c` | 2.1.300 | 1 | 2026-10-07 14:02 | 2026-10-07 14:09 | なし |');
    expect(lines[6]).toBe('| CLI | `` subcommand.added=x`y `` | 不明 | 1 | 2026-10-07 14:02 | 2026-10-07 14:09 | なし |');
  });
});
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/compat.test.ts`
Expected: FAIL。`./compat.ts` が無いので読み込みで落ちる。

- [ ] **Step 3: `presenters/compat.ts` を作る**

```ts
import { compatState, type CompatContract, type CompatDriftDto, type CompatDto, type CompatState, type CompatSummaryDto } from '@agent-hangar/shared';
import { absoluteTime } from './format.ts';

/**
 * 止めた機能の言い方（B1）。
 * short は「ずれ N 件の中身」の表の列、line は常に出す一覧の 1 行である。
 * hangar が自分で止めたと伝えるため、line は「〜を止めています」か「〜を控えています」で結ぶ。
 */
export type CompatStop = { short: string; line: string };

/** 契約の呼び名。表の「契約」の列と、報告用の写しに使う。 */
export const CONTRACT_LABEL: Record<CompatContract, string> = {
  transcript: 'トランスクリプト', registry: 'レジストリ', statusline: 'statusline', 'claude-dir': '~/.claude の項目', cli: 'CLI', screen: '画面の文字',
};

// 止めた機能。どれも、契約がずれのときに実際にしていること（docs/design.md「Claude Code との互換」）に合わせる。
const JUMP: CompatStop = { short: '目次から跳ぶ', line: 'ターンの目次から端末の指示へ跳ぶのを止めています' };
const PARK: CompatStop = { short: '休みで止める', line: '休んでいるセッションを自動で止めるのを控えています' };
const ADOPT: CompatStop = { short: '引き取り', line: '外のターミナルで動いている会話を引き取るのを止めています' };
const LIVE: CompatStop = { short: '実行中の印', line: '状態のファイルが読めない会話を、実行中として出すのを控えています' };
const USAGE: CompatStop = { short: '使用率の一部', line: '使用率のゲージの欠けた項目の更新を止めています' };
const SHARE: CompatStop = { short: 'アカウントの共有', line: '新しい ~/.claude の項目をアカウントの間で共有するのを控えています' };
const HELP: CompatStop = { short: '外のターミナル', line: '外のターミナルの包み方で、サブコマンドの一覧を claude --help から作るのを止めています' };
const AUTH: CompatStop = { short: 'ログインの状態', line: 'アカウントのログインの状態を読むのを止めています' };
const ATTACH: CompatStop = { short: 'attach で再開', line: 'バックグラウンドのセッションを attach で再開するのを止めています' };
const SUMMARY: CompatStop = { short: 'Claude で要約', line: 'Claude で要約するのを止めています' };

/**
 * 契約ごとに、値の形から止めた機能を引く表。上から見て、最初に当たった行を使う。
 * null は記録だけで、止めた機能が無いことを表す。
 * DTO は止めた機能を持たない。契約だけでは CLI、statusline、レジストリの止めたものが 1 つに決まらないので、値の頭でも分ける。
 */
const STOPS: Record<CompatContract, readonly (readonly [RegExp, CompatStop | null])[]> = {
  // 知らない行は meta として残し、知らない塊は捨てる。いまの扱いのままなので、止めたものは無い。
  transcript: [[/^/, null]],
  // 知らない status は作業中と読むので、休みで止めない。pid が無いと、引き取る前にプロセスを確かめられない。
  // sessionId の無い登録と、オブジェクトでない登録は読まない。
  registry: [[/^status=/, PARK], [/^pid=/, ADOPT], [/^/, LIVE]],
  // ミリ秒の resets_at は秒に直さずにそのまま使う（自動で直す）。欠けた項目は直前の値を保つ。
  statusline: [[/\.resets_at=ms$/, null], [/^/, USAGE]],
  'claude-dir': [[/^/, SHARE]],
  // サブコマンドの増減は、包み方のサブコマンドの一覧を claude --help から作り直して吸収するので、止めたものは無い。
  cli: [[/^help[.=]/, HELP], [/^auth-status[.=]/, AUTH], [/^agents-json[.=]/, ATTACH], [/^print-json[.=]/, SUMMARY], [/^/, null]],
  screen: [[/^/, JUMP]],
};

/** そのずれで止めた機能。止めたものが無ければ null。 */
export function stopOf(d: Pick<CompatDriftDto, 'contract' | 'value'>): CompatStop | null {
  for (const [re, stop] of STOPS[d.contract]) if (re.test(d.value)) return stop;
  return null;
}

/** 「ずれ N 件の中身」の表の 1 行。stop は表の列の短い言い方で、止めたものが無ければ null。 */
export type CompatRow = { key: string; contract: string; value: string; version: string; firstSeen: string; stop: string | null };

/**
 * Claude Code との互換の見せ方（A4、B1、C2）。設定の節と、初回の確認リストの 6 行目が同じこれを読む。
 * note は確認リストの場所の欄に出す「X（Y）」、lead は説明の行、badge は設定の見出しの右端の札である。
 * stops と rows は、ずれがあって中身（GET /api/compat）が届いたときだけ配列になる。届く前は null である。
 * report は「報告用に写す」で写す文で、rows と同じく中身が届いたときだけある。
 */
export type CompatProps = {
  state: CompatState;
  note: string;
  lead: string;
  badge: string;
  localVersion: string;
  verifiedVersion: string;
  count: number;
  stops: string[] | null;
  rows: CompatRow[] | null;
  report: string | null;
};

const UNKNOWN = '不明';

/** 表の時刻。月と日と時刻だけにする（10/07 14:02）。 */
export function seenLabel(ts: number): string {
  return absoluteTime(ts).slice(5).replace('-', '/');
}

/** Markdown の表のセル。改行と縦棒で表が崩れないようにする。 */
const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
/** コードの囲み。値にバッククォートがあれば 2 つで囲む。 */
const code = (s: string): string => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

/**
 * 「報告用に写す」で写す文。Markdown の表にして、そのまま issue に貼れるようにする。
 * 画面の表に無い回数と最後に見た時刻も載せ、時刻は年まで書く。
 * hangarVersion は頭に書く hangar の版で、空なら書かない。
 */
export function compatReport(summary: CompatSummaryDto, drifts: CompatDriftDto[], hangarVersion: string): string {
  return [
    hangarVersion ? `Claude Code との互換のずれ（hangar ${hangarVersion}）` : 'Claude Code との互換のずれ',
    `手元の版 ${summary.localVersion ?? UNKNOWN}、確かめた版 ${summary.verifiedVersion}`,
    '',
    '| 契約 | 値 | 版 | 回数 | 最初に見た | 最後に見た | 止めた機能 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...drifts.map((d) => `| ${CONTRACT_LABEL[d.contract]} | ${cell(code(d.value))} | ${cell(d.version ?? UNKNOWN)} | ${d.count} | ${absoluteTime(d.firstSeenAt)} | ${absoluteTime(d.lastSeenAt)} | ${stopOf(d)?.short ?? 'なし'} |`),
  ].join('\n');
}

/**
 * 準備の確かめの要約（summary）と、ずれの中身（full。ずれがあるときだけ取る）から作る。
 * 中身が届いていれば、件数は中身の数にそろえる。要約より後に読んだ分だけ新しいからである。
 * 6 行目の「ずれ N 件（版）」は手元の版で、分からなければ版を添えない。
 */
export function presentCompat(summary: CompatSummaryDto, full: CompatDto | null, hangarVersion: string): CompatProps {
  const count = full ? full.drifts.length : summary.driftCount;
  const state = compatState({ ...summary, driftCount: count });
  const local = summary.localVersion ?? UNKNOWN;
  const base = { state, localVersion: local, verifiedVersion: summary.verifiedVersion, count, stops: null, rows: null, report: null };
  if (state === 'ok') return { ...base, note: `ずれなし（${summary.verifiedVersion} で確かめた版）`, lead: 'hangar が読む Claude Code の形を見張っています', badge: '問題なし' };
  if (state === 'unverified') return { ...base, note: `${local}（確かめた版は ${summary.verifiedVersion}）`, lead: 'まだ確かめていない版です。動きは止めていません', badge: '未確認の版' };
  const note = summary.localVersion ? `ずれ ${count} 件（${summary.localVersion}）` : `ずれ ${count} 件`;
  const badge = `ずれ ${count} 件`;
  if (!full) return { ...base, note, badge, lead: 'ずれの中身を読み込んでいます' };
  // 同じ機能に当たるずれは、一覧では 1 行にまとめる。並びは中身の順（最後に見た時刻の新しい順）である。
  const stops = [...new Set(full.drifts.map((d) => stopOf(d)?.line).filter((l): l is string => l !== undefined))];
  return {
    ...base, note, badge,
    lead: stops.length > 0 ? '知らない形に頼る機能だけを止め、ほかは動かしています' : '知らない形を記録しましたが、止めた機能はありません',
    stops,
    rows: full.drifts.map((d) => ({ key: `${d.contract}:${d.value}`, contract: CONTRACT_LABEL[d.contract], value: d.value, version: d.version ?? UNKNOWN, firstSeen: seenLabel(d.firstSeenAt), stop: stopOf(d)?.short ?? null })),
    report: compatReport(summary, full.drifts, hangarVersion),
  };
}
```

- [ ] **Step 4: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/compat.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 5: コミットする**

```bash
git add packages/ui/src/presenters/compat.ts packages/ui/src/presenters/compat.test.ts
git commit -m "feat(ui): present Claude Code compat states and the stopped features

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: ずれの中身を取る時機（store とランタイム）

**Files:**
- Modify: `packages/ui/src/store/store.ts`（`Store` の型、`initialStore`）
- Modify: `packages/ui/src/runtime/runtime.ts:1`（import）、`:166-167`（`loadReadiness`）
- Test: `packages/ui/src/runtime/runtime.test.ts`（`describe('設定の欄ごとの保存と準備の確かめ（ランタイム）', …)` の末尾）
- Modify（doc コメントだけ）：`packages/ui/src/runtime/api.ts`、`packages/shared/src/api.ts`、`packages/server/src/http/app.ts`、`packages/server/src/server.ts`

**Interfaces:**
- Consumes: `ApiClient.compat(): Promise<CompatDto>`、`ReadinessDto.compat: CompatSummaryDto`（計画 A の Task 11）。
- Produces: `Store.compat: CompatDto | null`（未取得とずれが無いときは null）。
  Task 3 と Task 4 の presenter が読む。

- [ ] **Step 1: 落ちる試験を書く**

`packages/ui/src/runtime/runtime.test.ts` の `describe('設定の欄ごとの保存と準備の確かめ（ランタイム）', …)` の中、「参加トークンは消える時刻と一緒に置く」の it の前に足す。
この describe の `READY` には、計画 A の Task 11 が `compat`（ずれ 0 件）を足してある。

```ts
  it('互換にずれがあれば、準備の確かめに続けてずれの中身を取る。ずれが無くなれば中身を捨てる', async () => {
    const DETAIL = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry' as const, value: 'status=compacting', version: '2.1.300', count: 1, firstSeenAt: 1, lastSeenAt: 2 }] };
    let driftCount = 1;
    const readiness = vi.fn(async () => ({ ...READY, compat: { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount } }));
    const compat = vi.fn(async () => DETAIL);
    const { rt } = harness({ readiness, compat });
    rt.start();
    rt.emit({ type: 'readiness.check' });
    await flush();
    await flush();
    expect(compat).toHaveBeenCalledTimes(1);
    expect(rt.getStore().compat).toEqual(DETAIL);
    driftCount = 0;
    rt.emit({ type: 'readiness.check' });
    await flush();
    await flush();
    expect(compat).toHaveBeenCalledTimes(1);
    expect(rt.getStore().compat).toBeNull();
  });
  it('ずれが無い答えと、compat の無い古いサーバの答えでは、ずれの中身を取りに行かない', async () => {
    const compat = vi.fn(async () => ({ verifiedVersion: '2.1.292', localVersion: null, drifts: [] }));
    const { compat: _drop, ...older } = READY;
    let answer: unknown = READY;
    const { rt } = harness({ readiness: vi.fn(async () => answer as never), compat });
    rt.start();
    rt.emit({ type: 'readiness.check' });
    await flush();
    answer = older;
    rt.emit({ type: 'readiness.check' });
    await flush();
    await flush();
    expect(compat).not.toHaveBeenCalled();
    expect(rt.getStore().readiness).toEqual(older);
    expect(rt.getStore().compat).toBeNull();
  });
```

- [ ] **Step 2: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts -t "ずれの中身"`
Expected: FAIL。
1 つ目の it で `compat` が呼ばれず（0 回）、`rt.getStore().compat` が `undefined` になる。
型の誤り（`Store` に `compat` が無い）でも落ちる。

- [ ] **Step 3: store に `compat` を足す**

`packages/ui/src/store/store.ts` の 2 行目の `import type { … } from '@agent-hangar/shared';` の並びに `CompatDto` を足す（`CloudUsageDto, ` の後ろに `CompatDto, ` を入れる）。

`Store` の型の `readiness: ReadinessDto | null;` の行の後に足す。

```ts
  // Claude Code との互換のずれの中身（GET /api/compat）。準備の確かめでずれが 1 件以上あるときだけ取りに行く。
  // 未取得と、ずれが無いときは null である。
  compat: CompatDto | null;
```

`initialStore` の返り値の `readiness: null, joinTokenExpiresAt: null, desktop: false, accounts: null,` を置き換える。

```ts
    readiness: null, compat: null, joinTokenExpiresAt: null, desktop: false, accounts: null,
```

- [ ] **Step 4: 準備の確かめに続けて中身を取る**

`packages/ui/src/runtime/runtime.ts` の 1 行目の `import { … } from '@agent-hangar/shared';` の並びに `type ReadinessDto` を足す（`type LaunchResultDto, ` の後ろに `type ReadinessDto, ` を入れる）。

`loadReadiness` を doc コメントごと置き換える。

```ts
  /**
   * 準備の確かめを取りに行く。設定画面の検証と、空のホームの確認リストが同じ値を読む。
   * Claude Code との互換にずれがあれば、続けてずれの中身（GET /api/compat）も取る。止めた機能の一覧は常に出すので（A4）、開くのを待たない。
   * ずれが無ければ、前に取った中身を捨てる。compat の無い古いサーバの答えでは取りに行かない。
   */
  const loadReadiness = () => {
    deps.api.readiness().then((r) => {
      setStore({ ...store, readiness: r });
      const drifts = (r as Partial<ReadinessDto>).compat?.driftCount ?? 0;
      if (drifts > 0) deps.api.compat().then((c) => setStore({ ...store, compat: c })).catch(fail);
      else if (store.compat !== null) setStore({ ...store, compat: null });
    }).catch(fail);
  };
```

- [ ] **Step 5: 「開いたときに」と書いた doc コメントを直す**

計画 A は、ずれの中身を「確認リストの 6 行目を開いたときに」取る想定で doc コメントを書いた。
次で 3 か所が出ることを確かめる。

Run: `grep -rn "6 行目を開いたとき" packages`
Expected: `packages/ui/src/runtime/api.ts`、`packages/server/src/http/app.ts`、`packages/server/src/server.ts` の 3 行。

`packages/ui/src/runtime/api.ts` で置き換える。

置き換え前：`  /** Claude Code との互換。確認リストの 6 行目を開いたときに取る（計画 B）。 */`
置き換え後：`  /** Claude Code との互換のずれの中身。準備の確かめでずれが 1 件以上あるときに、続けて取る（止めた機能の一覧を常に出すため）。 */`

`packages/server/src/http/app.ts` で置き換える。

置き換え前：`   * Claude Code との互換（確かめた版、手元の版、記録したずれの一覧）。確認リストの 6 行目を開いたときに読む。`
置き換え後：`   * Claude Code との互換（確かめた版、手元の版、記録したずれの一覧）。準備の確かめでずれがあるとき、画面が続けて読む。`

`packages/server/src/server.ts` で置き換える。

置き換え前：`    // Claude Code との互換の一覧。確認リストの 6 行目を開いたときに読む。`
置き換え後：`    // Claude Code との互換の一覧。準備の確かめでずれがあるとき、画面が続けて読む。`

`packages/shared/src/api.ts` の `ReadinessDto` の doc コメントで置き換える。

置き換え前：` * compat は Claude Code との互換の要約で、確認リストの 6 行目が読む。ずれの中身は GET /api/compat で取る。`
置き換え後：` * compat は Claude Code との互換の要約で、設定の互換の節と確認リストの 6 行目が読む。ずれの中身は GET /api/compat で取る。`

Run: `grep -rn "6 行目を開いたとき" packages`
Expected: 何も出ない。

- [ ] **Step 6: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/runtime/runtime.test.ts packages/ui/src/store/store.test.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 7: コミットする**

```bash
git add packages/ui/src/store/store.ts packages/ui/src/runtime/runtime.ts packages/ui/src/runtime/runtime.test.ts packages/ui/src/runtime/api.ts packages/shared/src/api.ts packages/server/src/http/app.ts packages/server/src/server.ts
git commit -m "feat(ui): fetch the compat drifts whenever readiness reports any

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 初回の確認リストの 6 行目

**Files:**
- Modify: `packages/ui/src/presenters/readiness.ts:1`（import）、`:58-82`（`CheckItem` の doc コメントから末尾まで）
- Modify: `packages/ui/src/presenters/onboarding.ts:17`
- Create: `packages/ui/src/views/CompatSection.tsx`（この Task では `CompatDrifts` だけ）
- Modify: `packages/ui/src/views/Onboarding.tsx:1-25`（import と `CheckRow`）
- Modify: `packages/ui/src/views/primitives/CommandLine.tsx:14-44`（`CopyButton`）
- Modify: `packages/ui/src/styles/readiness.css`（末尾に足す）
- Test: `packages/ui/src/presenters/readiness.test.ts`、`packages/ui/src/views/Onboarding.test.tsx`、`packages/ui/src/styles/readiness.test.ts`（新規）
- Modify: `docs/design.md`（「Home」の節）

**Interfaces:**
- Consumes: `CompatProps`、`presentCompat`（Task 1）、`Store.compat`（Task 2）、`CompatDto`、`CompatState`、`ReadinessDto.compat`（計画 A）。
- Produces: `CheckTone = 'ok' | 'info' | 'soft' | 'ng'`、`CheckItem` に `tone: CheckTone`、`spoken: string`、`compat?: CompatProps` と、`key` の `'compat'`。
- Produces: `presentChecks(r: ReadinessDto, compat?: CompatDto | null, hangarVersion?: string): ChecksProps`（既存の 1 引数の呼び方はそのまま動く）。
- Produces: `CompatDrifts(props: { c: CompatProps })`（`views/CompatSection.tsx`）。
  Task 4 の設定の節が使う。
- Produces: `CopyButton` の `ariaLabel?: string`（読み上げの名前をそのまま決める）。

- [ ] **Step 1: presenter の落ちる試験を書く**

`packages/ui/src/presenters/readiness.test.ts` の `describe('始める前の確認（初回の A1）', …)` の最初の it を置き換える。

```ts
  it('6 つを並べ、揃った数を数える', () => {
    const c = presentChecks(READY);
    expect(c.items.map((i) => [i.key, i.ok])).toEqual([['tmux', true], ['claude', true], ['workspace', false], ['mcp', false], ['statusline', false], ['compat', true]]);
    expect(c.progress).toBe('6 つ中 3 つ');
    expect(c.items[0]).toMatchObject({ label: 'tmux', detail: 'ターミナルを動かすのに使います', path: '/opt/homebrew/bin/tmux（3.4）' });
  });
```

同じ describe の「tmux が無ければ…」の it の `expect(c.progress).toBe('5 つ中 1 つ');` を `expect(c.progress).toBe('6 つ中 2 つ');` に直す。

ファイルの末尾に足す。

```ts
describe('始める前の確認の 6 行目（Claude Code との互換）', () => {
  const withCompat = (over: Partial<ReadinessDto['compat']>): ReadinessDto => ({ ...READY, compat: { ...READY.compat, ...over } });
  it('問題なしは ok の調子で、確かめた版を添えて済んだものに数える', () => {
    const c = presentChecks(READY);
    expect(c.items.at(-1)).toMatchObject({
      key: 'compat', label: 'Claude Code との互換', ok: true, tone: 'ok', spoken: 'ずれはありません',
      path: 'ずれなし（2.1.292 で確かめた版）', detail: 'hangar が読む Claude Code の形を見張っています', command: null, action: null,
    });
  });
  it('未確認の版は info の調子で、止めていないので済んだものに数える', () => {
    const c = presentChecks(withCompat({ localVersion: '2.1.300' }));
    expect(c.items.at(-1)).toMatchObject({ ok: true, tone: 'info', spoken: 'まだ確かめていない版です', path: '2.1.300（確かめた版は 2.1.292）', detail: 'まだ確かめていない版です。動きは止めていません' });
    expect(c.progress).toBe('6 つ中 3 つ');
  });
  it('ずれは soft の調子で、6 つ中には数えない。中身を渡すと止めた機能を持つ', () => {
    const drifting = withCompat({ localVersion: '2.1.300', driftCount: 1 });
    const c = presentChecks(drifting);
    expect(c.items.at(-1)).toMatchObject({ ok: false, tone: 'soft', spoken: 'ずれがあります', path: 'ずれ 1 件（2.1.300）', detail: 'ずれの中身を読み込んでいます' });
    expect(c.progress).toBe('6 つ中 2 つ');
    const full = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'screen' as const, value: 'prompt-marker=(missing)', version: '2.1.300', count: 1, firstSeenAt: 1, lastSeenAt: 2 }] };
    expect(presentChecks(drifting, full, '0.3.0').items.at(-1)!.compat).toMatchObject({ stops: ['ターンの目次から端末の指示へ跳ぶのを止めています'] });
  });
  it('compat の無い古いサーバの答えでは、6 行目を出さずに 5 つで数える', () => {
    const { compat: _drop, ...older } = READY;
    const c = presentChecks(older as ReadinessDto);
    expect(c.items.map((i) => i.key)).not.toContain('compat');
    expect(c.progress).toBe('5 つ中 2 つ');
  });
  it('ほかの 5 行の調子と読み上げは、✓ と ✗ と弱い印から決める', () => {
    const by = Object.fromEntries(presentChecks(READY).items.map((i) => [i.key, i]));
    expect(by.tmux).toMatchObject({ tone: 'ok', spoken: '準備できています' });
    expect(by.workspace).toMatchObject({ tone: 'ng', spoken: 'まだです' });
    expect(by.mcp).toMatchObject({ tone: 'soft', spoken: 'まだです' });
  });
});
```

- [ ] **Step 2: View と CSS の落ちる試験を書く**

`packages/ui/src/views/Onboarding.test.tsx` の 3 行目の import を置き換える。

```ts
import type { CompatDto, ReadinessDto } from '@agent-hangar/shared';
```

既存の数を 6 行に合わせて直す。

- 「セッションもプロジェクトも無いときだけ出す…」の it の `progress: '5 つ中 2 つ'` を `progress: '6 つ中 3 つ'` に直す。
- 「真ん中に 1 枚の札を置き、5 つの ✓ と ✗、揃った数を出す。…」の it の名前の「5 つの」を「6 つの」に直し、`'5 つ中 2 つ'` を `'6 つ中 3 つ'` に、`toHaveLength(5)` を `toHaveLength(6)` に直す。

ファイルの末尾に足す。

```tsx
describe('確認リストの 6 行目（Claude Code との互換）', () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
  const DETAIL: CompatDto = {
    verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
      { contract: 'screen', value: 'prompt-marker=(missing)', version: '2.1.300', count: 2, firstSeenAt: at(7, 14, 2), lastSeenAt: at(7, 14, 9) },
      { contract: 'registry', value: 'status=compacting', version: '2.1.300', count: 5, firstSeenAt: at(7, 13, 40), lastSeenAt: at(7, 14, 5) },
      { contract: 'transcript', value: 'system.subtype=turn_summary', version: '2.1.298', count: 9, firstSeenAt: at(6, 22, 15), lastSeenAt: at(7, 14, 1) },
    ],
  };
  const DRIFT = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 3 };
  const storeWith = (compat: ReadinessDto['compat'], full: CompatDto | null) => ({ ...initialStore(), bootstrapped: true, version: '0.3.0', readiness: { ...READY, compat }, compat: full });
  const renderWith = (compat: ReadinessDto['compat'], full: CompatDto | null = null, onIntent = vi.fn()) => {
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...emptyHome} onboarding={presentOnboarding(storeWith(compat, full))} /></IntentRoot>);
    return onIntent;
  };
  it('問題なしは緑の ✓ で、確かめた版を添え、済んだものに数える', () => {
    renderWith({ verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 });
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれはありません' });
    expect(row).toHaveAttribute('data-tone', 'ok');
    expect(within(row).getByText('ずれなし（2.1.292 で確かめた版）')).toBeInTheDocument();
    expect(within(row).getByText('hangar が読む Claude Code の形を見張っています')).toBeInTheDocument();
    expect(screen.getByText('6 つ中 3 つ')).toBeInTheDocument();
  });
  it('未確認の版は灰色の ⓘ で、止めていないので済んだものに数える', () => {
    renderWith({ verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 0 });
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 まだ確かめていない版です' });
    expect(row).toHaveAttribute('data-tone', 'info');
    // 印は色だけでなく形（ⓘ）でも分ける。
    expect(row.querySelector('[data-icon="info"]')).not.toBeNull();
    expect(within(row).getByText('2.1.300（確かめた版は 2.1.292）')).toBeInTheDocument();
    expect(within(row).getByText('まだ確かめていない版です。動きは止めていません')).toBeInTheDocument();
    expect(screen.getByText('6 つ中 3 つ')).toBeInTheDocument();
  });
  it('ずれは注意の色で、止めた機能を常に出し、細目は「ずれ N 件の中身」で畳む。6 つ中には数えない', () => {
    renderWith(DRIFT, DETAIL);
    expect(screen.getByText('6 つ中 2 つ')).toBeInTheDocument();
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれがあります' });
    expect(row).toHaveAttribute('data-tone', 'soft');
    expect(within(row).getByText('ずれ 3 件（2.1.300）')).toBeInTheDocument();
    expect(within(row).getByText('知らない形に頼る機能だけを止め、ほかは動かしています')).toBeInTheDocument();
    const stops = within(row).getByRole('list', { name: '止めた機能' });
    expect(within(stops).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ターンの目次から端末の指示へ跳ぶのを止めています', '休んでいるセッションを自動で止めるのを控えています']);
    const more = within(row).getByText('ずれ 3 件の中身').closest('details')!;
    expect(more).not.toHaveAttribute('open');
    const rows = within(more).getAllByRole('row').map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
    expect(rows).toEqual([
      ['契約', '値', '版', '最初に見た', '止めた機能'],
      ['画面の文字', 'prompt-marker=(missing)', '2.1.300', '10/07 14:02', '目次から跳ぶ'],
      ['レジストリ', 'status=compacting', '2.1.300', '10/07 13:40', '休みで止める'],
      ['トランスクリプト', 'system.subtype=turn_summary', '2.1.298', '10/06 22:15', 'なし'],
    ]);
  });
  it('表の下に記録の置き場を書き、報告用に写すで、ずれの一覧を写す', () => {
    const onIntent = renderWith(DRIFT, DETAIL);
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれがあります' });
    expect(within(row).getByText('~/.agent-hangar/compat.json')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: '報告用に写す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: presentOnboarding(storeWith(DRIFT, DETAIL))!.checks!.items.at(-1)!.compat!.report });
  });
  it('ずれの中身が届く前は、件数と読み込み中だけを出し、表も写すボタンも出さない', () => {
    renderWith(DRIFT, null);
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれがあります' });
    expect(within(row).getByText('ずれの中身を読み込んでいます')).toBeInTheDocument();
    expect(within(row).queryByRole('table')).toBeNull();
    expect(within(row).queryByRole('button', { name: '報告用に写す' })).toBeNull();
  });
});
```

`packages/ui/src/styles/readiness.test.ts` を作る。

```ts
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./readiness.css', import.meta.url), 'utf8');
/** セレクタがちょうど一致する規則の中身（入れ子の無い規則だけ）。 */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${esc} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
};

describe('Claude Code との互換の見た目（確認リストとずれの中身）', () => {
  it('未確認の版の印は、色を持たない灰色（--ink-3）にする', () => {
    expect(rule(".ck[data-tone='info'] > .icon")).toContain('color: var(--ink-3);');
  });
  it('止めた機能の点は注意の色にする', () => {
    expect(rule('.cp-stops li::before')).toContain('background: var(--st-paused);');
  });
  it('畳む印はブラウザの三角を消し、開くと矢印が 90 度回る', () => {
    expect(rule('.cp-more > summary')).toContain('list-style: none;');
    expect(rule('.cp-more > summary::-webkit-details-marker')).toContain('display: none;');
    expect(rule('.cp-more[open] > summary .icon')).toContain('transform: rotate(90deg);');
  });
  it('細目の表は列の幅を固定し、長い値は折り返して札からはみ出さない', () => {
    expect(rule('.cp-tab')).toContain('table-layout: fixed;');
    expect(rule('.cp-tab td')).toContain('overflow-wrap: anywhere;');
    expect(rule('.cp-tab td.cp-n')).toContain('white-space: nowrap;');
  });
});
```

- [ ] **Step 3: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/readiness.test.ts packages/ui/src/views/Onboarding.test.tsx packages/ui/src/styles/readiness.test.ts`
Expected: FAIL。
presenter は 6 行目が無く（`'5 つ中 2 つ'`）、`tone` と `spoken` も無い。
View は 6 行目の listitem が見つからない。
CSS は規則が無く、空文字になる。

- [ ] **Step 4: `presentChecks` に 6 行目を足す**

`packages/ui/src/presenters/readiness.ts` の 1 行目を置き換え、import を 1 行足す。

```ts
import type { CompatDto, CompatState, ReadinessDto, ToolCheckDto } from '@agent-hangar/shared';
import { presentCompat, type CompatProps } from './compat.ts';
```

`/** 始める前の確認の 1 行。` の doc コメントから、ファイルの末尾（`presentChecks` の閉じ括弧）までを置き換える。

```ts
/** 確認の行の調子。info は止めていない知らせ（未確認の版）で、灰色の ⓘ にする。 */
export type CheckTone = 'ok' | 'info' | 'soft' | 'ng';

/**
 * 始める前の確認の 1 行。
 * path は ✓ のときに添える見つかった場所（互換の行は「X（Y）」）、detail は何のためのものか、または ✗ の理由。
 * command はターミナルで打つ直し方、action は設定で直すための道。
 * tone は印と色、spoken は読み上げの名前に添える状態の語である。
 * compat は互換の行だけが持ち、ずれのときに止めた機能と細目を出す（A4）。
 */
export type CheckItem = { key: 'tmux' | 'claude' | 'workspace' | 'mcp' | 'statusline' | 'compat'; label: string; ok: boolean; soft: boolean; tone: CheckTone; spoken: string; path: string | null; detail: string; command: string | null; action: 'settings' | null; compat?: CompatProps };
export type ChecksProps = { items: CheckItem[]; progress: string };

const withNote = (l: VerifyLine) => (l.note ? `${l.text}（${l.note}）` : l.text);
/** 互換の行の調子。ずれは、MCP と statusline の ✗ と同じ注意の色にする。 */
const COMPAT_TONE: Record<CompatState, CheckTone> = { ok: 'ok', unverified: 'info', drift: 'soft' };
/** 互換の行の読み上げ。準備の語（準備できています、まだです）に寄せず、状態をそのまま言う。 */
const COMPAT_SPOKEN: Record<CompatState, string> = { ok: 'ずれはありません', unverified: 'まだ確かめていない版です', drift: 'ずれがあります' };

/**
 * 確認リストの 6 つ。設定画面の検証と同じ判定（toolLine、workspaceLine、presentCompat）を使う。
 * 「6 つ中 N つ」は ok の行を数える。互換の行は、未確認の版を済んだものとして数え、ずれは数えない。
 * compat はずれの中身（届いていなければ null）、hangarVersion は報告用の写しに書く hangar の版である。
 * compat の無い古いサーバの答えでは、互換の行を出さずに 5 つで数える。
 */
export function presentChecks(r: ReadinessDto, compat: CompatDto | null = null, hangarVersion = ''): ChecksProps {
  const tmux = toolLine('tmux', r.tools.tmux);
  const claude = toolLine('claude', r.tools.claude);
  const ws = workspaceLine(r.workspace);
  const sl = r.statusline;
  const rows: Omit<CheckItem, 'tone' | 'spoken'>[] = [
    { key: 'tmux', label: 'tmux', ok: tmux.ok, soft: false, path: tmux.ok ? withNote(tmux) : null, detail: tmux.ok ? 'ターミナルを動かすのに使います' : `tmux が${tmux.text === '見つかりません' ? '見つかりません' : `使えません。${tmux.text}`}`, command: tmux.ok ? null : 'brew install tmux', action: tmux.ok ? null : 'settings' },
    { key: 'claude', label: 'claude', ok: claude.ok, soft: false, path: claude.ok ? withNote(claude) : null, detail: claude.ok ? 'Claude Code' : `claude が${claude.text === '見つかりません' ? '見つかりません' : `使えません。${claude.text}`}`, command: null, action: claude.ok ? null : 'settings' },
    { key: 'workspace', label: 'ワークスペース', ok: ws.ok, soft: false, path: ws.ok ? withNote(ws) : null, detail: ws.ok ? '直下のディレクトリをプロジェクトとして登録しています' : r.workspace.exists ? `${r.workspace.path} の${ws.text}` : ws.text, command: null, action: ws.ok ? null : 'settings' },
    { key: 'mcp', label: 'MCP', ok: r.mcp.registered, soft: true, path: r.mcp.registered ? '登録済み' : null, detail: 'どのセッションからも hangar の検索と要約を使えるようにします', command: r.mcp.registered ? null : r.commands.mcp, action: null },
    { key: 'statusline', label: 'statusline', ok: sl.installed, soft: true, path: sl.installed ? '追記済み' : null, detail: sl.installed || sl.scriptPath ? 'ヘッダーの使用率ゲージの供給源です' : 'Claude Code の /statusline でスクリプトを作ってから、次を実行してください', command: sl.installed ? null : r.commands.statusline, action: null },
  ];
  const items = rows.map((i): CheckItem => ({ ...i, tone: i.ok ? 'ok' : i.soft ? 'soft' : 'ng', spoken: i.ok ? '準備できています' : 'まだです' }));
  // 古いサーバは compat を返さない。そのときは 6 行目を出さない。
  const summary = (r as Partial<ReadinessDto>).compat;
  if (summary) {
    const c = presentCompat(summary, compat, hangarVersion);
    items.push({ key: 'compat', label: 'Claude Code との互換', ok: c.state !== 'drift', soft: c.state === 'drift', tone: COMPAT_TONE[c.state], spoken: COMPAT_SPOKEN[c.state], path: c.note, detail: c.lead, command: null, action: null, compat: c });
  }
  return { items, progress: `${items.length} つ中 ${items.filter((i) => i.ok).length} つ` };
}
```

`packages/ui/src/presenters/onboarding.ts` の返り値の行を置き換える。

```ts
  return { checks: store.readiness ? presentChecks(store.readiness, store.compat, store.version) : null };
```

- [ ] **Step 5: `CopyButton` に読み上げの名前を渡せるようにする**

`packages/ui/src/views/primitives/CommandLine.tsx` の `CopyButton` の doc コメントの最後の行（` * label が無ければアイコンだけにし、読み上げの名前は「〜をコピー」にする。`）の後に足す。

```ts
 * ariaLabel は読み上げの名前をそのまま決める。見えている文がコピーの語でないとき（報告用に写す）に使う。
```

`export function CopyButton(props: { text: string; name?: string; label?: string }) {` を置き換える。

```tsx
export function CopyButton(props: { text: string; name?: string; label?: string; ariaLabel?: string }) {
```

`aria-label={`${props.name ?? props.text} をコピー`}` を置き換える。

```tsx
aria-label={props.ariaLabel ?? `${props.name ?? props.text} をコピー`}
```

- [ ] **Step 6: ずれの中身の View を作る**

`packages/ui/src/views/CompatSection.tsx` を作る。

```tsx
import type { CompatProps } from '../presenters/compat.ts';
import { CopyButton } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';

/**
 * ずれの中身（A4）。止めた機能は常に出し、契約、値、版、最初に見た時刻、止めた機能の表は「ずれ N 件の中身」で畳む。
 * 表の下に記録の置き場と「報告用に写す」を置く。設定の互換の節と、初回の確認リストの 6 行目が使う。
 * 開いているかどうかは画面の中だけの見え方なので、details に任せて Mediator には置かない。
 * 中身が届く前（rows が null）は何も出さない。
 */
export function CompatDrifts(props: { c: CompatProps }) {
  const c = props.c;
  if (c.state !== 'drift' || c.rows === null) return null;
  return (
    <>
      {c.stops && c.stops.length > 0 && (
        <ul className="cp-stops" aria-label="止めた機能">
          {c.stops.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}
      <details className="cp-more">
        <summary><Icon name="chevron" />{`ずれ ${c.count} 件の中身`}</summary>
        <div className="cp-more-body">
          <table className="cp-tab">
            <colgroup><col className="c-k" /><col /><col className="c-v" /><col className="c-t" /><col className="c-f" /></colgroup>
            <thead><tr><th>契約</th><th>値</th><th>版</th><th>最初に見た</th><th>止めた機能</th></tr></thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.contract}</td>
                  <td><code>{r.value}</code></td>
                  <td className="cp-n">{r.version}</td>
                  <td className="cp-n">{r.firstSeen}</td>
                  <td>{r.stop ?? <span className="faint">なし</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cp-foot">
            <span className="faint">記録はこの PC の <code>~/.agent-hangar/compat.json</code> にあります</span>
            {c.report && <CopyButton text={c.report} ariaLabel="報告用に写す" label="報告用に写す" />}
          </div>
        </div>
      </details>
    </>
  );
}
```

- [ ] **Step 7: `CheckRow` を調子で描き、互換の行に中身を出す**

`packages/ui/src/views/Onboarding.tsx` の import を置き換える。

```tsx
import { useEmit } from '../intent/chain.tsx';
import type { OnboardingProps } from '../presenters/onboarding.ts';
import type { CheckItem, CheckTone } from '../presenters/readiness.ts';
import { CompatDrifts } from './CompatSection.tsx';
import { PageHeading } from './PageHeading.tsx';
import { CommandLine } from './primitives/CommandLine.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
```

`CheckRow` を doc コメントごと置き換える。

```tsx
/** 調子ごとの印。色だけでなく形（✓、ⓘ、!、✗）でも分ける。 */
const CHECK_ICON: Record<CheckTone, IconName> = { ok: 'ok', info: 'info', soft: 'alert', ng: 'ng' };

/** 確認の 1 行。印は色だけでなく形でも分け、読み上げの名前にも状態を入れる。互換の行はずれの中身を持つ。 */
function CheckRow(props: { item: CheckItem }) {
  const emit = useEmit();
  const c = props.item;
  return (
    <li className="ck" data-tone={c.tone} aria-label={`${c.label} ${c.spoken}`}>
      <Icon name={CHECK_ICON[c.tone]} />
      <div className="ck-t">
        <b>{c.label}</b>{c.path && <> <span className="ck-p">{c.path}</span></>}
        <div className="ck-d">{c.detail}</div>
        {c.command && <CommandLine command={c.command} />}
        {c.compat && <CompatDrifts c={c.compat} />}
      </div>
      <div className="ck-act">
        {c.action === 'settings' && <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'nav.go', to: { name: 'settings' } })}>設定で変える</button>}
      </div>
    </li>
  );
}
```

- [ ] **Step 8: CSS を足す**

`packages/ui/src/styles/readiness.css` の `.ck[data-tone='soft'] > .icon { … }` の行の後に足す。

```css
/* 未確認の版（Claude Code との互換）。止めてはいないので、色を持たない灰色にする。 */
.ck[data-tone='info'] > .icon { color: var(--ink-3); }
```

ファイルの末尾に足す。

```css
/* Claude Code との互換のずれの中身（A4）。止めた機能は常に出し、細目だけ「ずれ N 件の中身」で畳む。 */
/* 確認リストの 6 行目と、設定の互換の節が使う。値の正本は試作 docs/superpowers/specs/2026-10-07-stage0-claude-compat/checks.html。 */
.cp-stops { margin: calc(var(--u) * 1.5) 0 0; padding: 0; list-style: none; display: grid; gap: 2px; font-size: var(--fs-sm); color: var(--ink); }
.cp-stops li { position: relative; padding-left: 14px; }
.cp-stops li::before { content: ''; position: absolute; left: 3px; top: 0.62em; width: 5px; height: 5px; border-radius: 50%; background: var(--st-paused); }
.cp-more { margin-top: calc(var(--u) * 1.5); }
.cp-more > summary { display: inline-flex; align-items: center; gap: 3px; list-style: none; cursor: pointer; font-size: var(--fs-xs); font-weight: 600; color: var(--accent); }
.cp-more > summary::-webkit-details-marker { display: none; }
.cp-more > summary .icon { width: 12px; height: 12px; transition: transform var(--dur-fast) var(--ease-out); }
.cp-more[open] > summary .icon { transform: rotate(90deg); }
.cp-more-body { margin-top: calc(var(--u) * 1.5); }
.cp-tab { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: var(--fs-xs); }
.cp-tab col.c-k { width: 96px; }
.cp-tab col.c-v { width: 52px; }
.cp-tab col.c-t { width: 80px; }
.cp-tab col.c-f { width: 92px; }
.cp-tab th { text-align: left; font-weight: 500; color: var(--ink-3); border-bottom: 1px solid var(--line); padding: 0 4px 2px; }
.cp-tab td { padding: 3px 4px; vertical-align: top; border-bottom: 1px solid var(--line); color: var(--ink-2); overflow-wrap: anywhere; }
.cp-tab td:first-child { color: var(--ink); }
.cp-tab td.cp-n { white-space: nowrap; font-variant-numeric: tabular-nums; }
.cp-tab td code { font: 500 11px var(--font-mono); color: var(--ink); background: var(--surface-2); padding: 0 4px; border-radius: 4px; }
.cp-foot { display: flex; align-items: center; gap: calc(var(--u) * 2); margin-top: var(--u); font-size: var(--fs-xs); }
.cp-foot > .faint { flex: 1; min-width: 0; }
.cp-foot code { font: 500 11px var(--font-mono); }
```

- [ ] **Step 9: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/readiness.test.ts packages/ui/src/views/Onboarding.test.tsx packages/ui/src/styles/readiness.test.ts packages/ui/src/presenters/compat.test.ts`
Expected: PASS。

Run: `npx vitest run packages/ui`
Expected: PASS（動きのトークン、太さ、色の試験も含めて）。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 10: 設計書の「Home」の節を直す**

`docs/design.md` の「Home」の節で、次を置き換える。

置き換え前：`札は「始める前の確認」で、tmux、claude、ワークスペース、MCP、statusline の 5 つに ✓ か ✗ と直し方（設定へ、またはターミナルで打つコマンドとコピー）を並べ、揃った数を「5 つ中 N つ」と出す。`
置き換え後：`札は「始める前の確認」で、tmux、claude、ワークスペース、MCP、statusline、Claude Code との互換の 6 つに ✓ か ✗ と直し方（設定へ、またはターミナルで打つコマンドとコピー）を並べ、揃った数を「6 つ中 N つ」と出す。`

同じ節の `判定は設定画面の欄の下の検証と同じもの（`GET /api/readiness` と `presenters/readiness.ts`）を使う。` の行の後に足す。

```markdown
6 行目の Claude Code との互換は、設定の「連携」の群の節と同じ判定（`compatState` と `presenters/compat.ts` の `presentCompat`）で、3 つの状態を持つ（試作は `docs/superpowers/specs/2026-10-07-stage0-claude-compat/checks.html` の A4、B1、C2）。
問題なしは緑の ✓ と「ずれなし（<確かめた版> で確かめた版）」、未確認の版は灰色の ⓘ と「<手元の版>（確かめた版は <確かめた版>）」、ずれは注意の色の ! と「ずれ N 件（<手元の版>）」である。
未確認の版は止めていないので「6 つ中 N つ」に済んだものとして数え、ずれは数えない。
ずれのときは、止めた機能を「〜を止めています」「〜を控えています」の一覧で常に出し、契約、値、版、最初に見た時刻、止めた機能の表を「ずれ N 件の中身」で畳む。
表の下に記録の置き場と「報告用に写す」を置く。
準備の確かめに `compat` の無い古いサーバの答えでは、6 行目を出さずに 5 つで数える。
```

- [ ] **Step 11: コミットする**

```bash
git add packages/ui/src/presenters/readiness.ts packages/ui/src/presenters/readiness.test.ts packages/ui/src/presenters/onboarding.ts packages/ui/src/views/CompatSection.tsx packages/ui/src/views/Onboarding.tsx packages/ui/src/views/Onboarding.test.tsx packages/ui/src/views/primitives/CommandLine.tsx packages/ui/src/styles/readiness.css packages/ui/src/styles/readiness.test.ts docs/design.md
git commit -m "feat(ui): add the Claude Code compat row to the onboarding checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 設定の「連携」の群の節「Claude Code との互換」

**Files:**
- Modify: `packages/ui/src/presenters/settings.ts:1`（import）、`:9`（import）、`SettingsProps`、`presentSettings`
- Modify: `packages/ui/src/views/CompatSection.tsx`（`CompatSection` を足す）
- Modify: `packages/ui/src/views/SettingsScreen.tsx:23-30`（`SETTINGS_GROUPS`）、import、`<Group id="settings-link" …>` の先頭
- Modify: `packages/ui/src/styles/settings.css:19`（`.settings-group-h`）、`:32` の後（札と版の並び）
- Test: `packages/ui/src/presenters/presenters.test.ts`、`packages/ui/src/views/misc.test.tsx`、`packages/ui/src/styles/settings.test.ts`
- Modify: `docs/design.md`（「Settings」の節と「Claude Code との互換」の節）

**Interfaces:**
- Consumes: `CompatProps`、`presentCompat`（Task 1）、`Store.compat`（Task 2）、`CompatDrifts`（Task 3）、`ReadinessDto.compat`（計画 A）。
- Produces: `SettingsProps.compat: CompatProps | null`（準備の確かめが届く前と、`compat` の無い古いサーバの答えでは null）。
- Produces: `CompatSection(props: { compat: CompatProps | null })`（`views/CompatSection.tsx`）。

- [ ] **Step 1: presenter の落ちる試験を書く**

`packages/ui/src/presenters/presenters.test.ts` の `describe('presentSettings の検証と保存の知らせ（設定の B1 と C1）', …)` の中、「欄ごとの保存の知らせをそのまま渡す」の it の前に足す。
この describe の `READY` には、計画 A の Task 11 が `compat`（ずれ 0 件）を足してある。

```ts
  it('Claude Code との互換は、準備の確かめの要約とずれの中身から作り、ずれは直すものに数えない', () => {
    const r: ReadinessDto = { ...READY, compat: { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 1 } };
    const full = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry' as const, value: 'status=compacting', version: '2.1.300', count: 1, firstSeenAt: 1, lastSeenAt: 2 }] };
    const p = presentSettings(initialState(), { ...initialStore(), version: '0.3.0', readiness: r, compat: full });
    expect(p.compat).toMatchObject({ state: 'drift', badge: 'ずれ 1 件', localVersion: '2.1.300', verifiedVersion: '2.1.292', stops: ['休んでいるセッションを自動で止めるのを控えています'] });
    expect(p.compat!.report!.split('\n')[0]).toBe('Claude Code との互換のずれ（hangar 0.3.0）');
    // 直すもの（目次の点と群の見出しの札）は、ずれの無いときと同じ数のまま。
    expect(p.todo).toEqual(presentSettings(initialState(), { ...initialStore(), readiness: READY }).todo);
    expect(p.todo).toEqual({ must: 1, link: 1 });
  });
  it('準備の確かめが届く前と、compat の無い古いサーバの答えでは、互換の節を null にする', () => {
    expect(presentSettings(initialState(), initialStore()).compat).toBeNull();
    const { compat: _drop, ...older } = READY;
    expect(presentSettings(initialState(), { ...initialStore(), readiness: older as ReadinessDto }).compat).toBeNull();
    expect(presentSettings(initialState(), { ...initialStore(), readiness: READY }).compat).toMatchObject({ state: 'ok', badge: '問題なし' });
  });
```

- [ ] **Step 2: View と CSS の落ちる試験を書く**

`packages/ui/src/views/misc.test.tsx` の import に足す（7 行目の `import { ACCOUNT_COLORS, … } from '../presenters/settings.ts';` の後）。

```ts
import type { CompatDto } from '@agent-hangar/shared';
import { presentCompat } from '../presenters/compat.ts';
```

`settingsProps` の `focus: null,` の後（`...over,` の前）に足す。

```ts
  compat: null,
```

`describe('SettingsScreen の目次（設定の A1）', …)` の後に足す。

```tsx
describe('SettingsScreen の Claude Code との互換（C2）', () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
  const DETAIL: CompatDto = {
    verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
      { contract: 'screen', value: 'prompt-marker=(missing)', version: '2.1.300', count: 2, firstSeenAt: at(7, 14, 2), lastSeenAt: at(7, 14, 9) },
      { contract: 'registry', value: 'status=compacting', version: '2.1.300', count: 5, firstSeenAt: at(7, 13, 40), lastSeenAt: at(7, 14, 5) },
      { contract: 'transcript', value: 'system.subtype=turn_summary', version: '2.1.298', count: 9, firstSeenAt: at(6, 22, 15), lastSeenAt: at(7, 14, 1) },
    ],
  };
  const DRIFT = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 3 };
  /** 互換の節。見出しの名前には右端の札の文も入る。 */
  const section = () => screen.getByRole('heading', { level: 3, name: /^Claude Code との互換/ }).closest('section')!;
  it('連携の群の先頭に節を置き、群の見出しと目次の小見出しにも添える', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps()} /></IntentRoot>);
    const link = screen.getByRole('group', { name: /^連携/ });
    expect(within(link).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent(/^Claude Code との互換/);
    expect(screen.getByRole('heading', { level: 2, name: /^連携/ })).toHaveTextContent('連携Claude Code との互換、MCP、statusline、外のターミナル、通知、アカウント');
    expect(within(screen.getByRole('navigation', { name: '設定の目次' })).getByText('Claude Code との互換')).toBeInTheDocument();
  });
  it('準備の確かめが届く前は、本文の下に「確かめています」と出し、札は出さない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: null })} /></IntentRoot>);
    expect(within(section()).getByText('確かめています')).toBeInTheDocument();
    expect(section()).toHaveTextContent('hangar は Claude Code の会話の記録、状態のファイル、statusline、~/.claude の項目、CLI の出力、画面の文字を読んでいます。知らない形に出会ったら、ここに出します。');
  });
  it('問題なしは緑の札で、手元の版と確かめた版を出す', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 }, null, '') })} /></IntentRoot>);
    expect(within(section()).getByText('問題なし')).toHaveAttribute('data-tone', 'ok');
    expect(section()).toHaveTextContent('手元の版 2.1.292');
    expect(section()).toHaveTextContent('確かめた版 2.1.292');
    expect(within(section()).queryByRole('list', { name: '止めた機能' })).toBeNull();
  });
  it('未確認の版は灰色の札で、版の並びに止めていないことを添える', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 0 }, null, '') })} /></IntentRoot>);
    expect(within(section()).getByText('未確認の版')).toHaveAttribute('data-tone', 'info');
    expect(section()).toHaveTextContent('手元の版 2.1.300');
    expect(within(section()).getByText('まだ確かめていない版です。動きは止めていません')).toBeInTheDocument();
  });
  it('ずれは注意の札で、止めた機能の一覧を常に出し、細目は畳む。表の下に置き場と報告用に写す', () => {
    const onIntent = vi.fn();
    const c = presentCompat(DRIFT, DETAIL, '0.3.0');
    render(<IntentRoot onIntent={onIntent}><SettingsScreen {...settingsProps({ compat: c })} /></IntentRoot>);
    const sec = within(section());
    expect(sec.getByText('ずれ 3 件')).toHaveAttribute('data-tone', 'warn');
    expect(sec.getByText('知らない形に頼る機能だけを止め、ほかは動かしています。')).toBeInTheDocument();
    expect(within(sec.getByRole('list', { name: '止めた機能' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ターンの目次から端末の指示へ跳ぶのを止めています', '休んでいるセッションを自動で止めるのを控えています']);
    const more = sec.getByText('ずれ 3 件の中身').closest('details')!;
    expect(more).not.toHaveAttribute('open');
    expect(within(more).getAllByRole('row')).toHaveLength(4);
    expect(within(more).getByText('~/.agent-hangar/compat.json')).toBeInTheDocument();
    fireEvent.click(within(more).getByRole('button', { name: '報告用に写す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: c.report });
  });
  it('ずれはあっても止めた機能が無ければ、一覧を出さず、記録だけだと言う', () => {
    const only: CompatDto = { ...DETAIL, drifts: [{ contract: 'cli', value: 'subcommand.added=newcmd', version: null, count: 1, firstSeenAt: at(7, 9, 0), lastSeenAt: at(7, 9, 0) }] };
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat({ ...DRIFT, driftCount: 1 }, only, '') })} /></IntentRoot>);
    expect(within(section()).getByText('ずれ 1 件')).toHaveAttribute('data-tone', 'warn');
    expect(within(section()).getByText('知らない形を記録しましたが、止めた機能はありません。')).toBeInTheDocument();
    expect(within(section()).queryByRole('list', { name: '止めた機能' })).toBeNull();
    expect(within(section()).getByText('ずれ 1 件の中身')).toBeInTheDocument();
  });
  it('ずれがあっても、目次の点と群の見出しの「直すもの」は灯さない', () => {
    render(<IntentRoot onIntent={() => {}}><SettingsScreen {...settingsProps({ compat: presentCompat(DRIFT, DETAIL, ''), todo: { must: 0, link: 0 } })} /></IntentRoot>);
    expect(within(screen.getByRole('navigation', { name: '設定の目次' })).queryByRole('img')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: /^連携/ })).not.toHaveTextContent('直すもの');
  });
});
```

`packages/ui/src/styles/settings.test.ts` の末尾に足す。

```ts
describe('Claude Code との互換の節と群の見出し', () => {
  it('未確認の版の札は、印を持たない灰色の地と縁にする', () => {
    expect(rule(".badge[data-tone='info']")).toBe(' color: var(--ink-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-strong); ');
  });
  it('版の並びは、狭い窓で折り返す', () => {
    expect(rule('.cp-vers')).toContain('flex-wrap: wrap;');
  });
  // 連携の群の添えに「Claude Code との互換」が増えたので、狭い窓で見出しがはみ出さないようにする。
  it('群の見出しは折り返し、行の間は空けない', () => {
    const h = rule('.settings-group-h');
    expect(h).toContain('flex-wrap: wrap;');
    expect(h).toContain('gap: 0 calc(var(--u) * 2);');
  });
});
```

- [ ] **Step 3: 落ちるのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/misc.test.tsx packages/ui/src/styles/settings.test.ts`
Expected: FAIL。`p.compat` が `undefined`、互換の見出しが見つからない、CSS の規則が無い。

- [ ] **Step 4: `presentSettings` に互換の節を足す**

`packages/ui/src/presenters/settings.ts` の 1 行目の `import type { … } from '@agent-hangar/shared';` の並びに `ReadinessDto` を足す（`import type { IndexProgressDto, ReadinessDto, ShellHookStateDto, …`）。

`import { toolLine, workspaceLine, type VerifyLine } from './readiness.ts';` の前に足す。

```ts
import { presentCompat, type CompatProps } from './compat.ts';
```

`SettingsProps` の `todo` の doc コメントと型の 2 行を置き換え、続けて足す。

```ts
  /**
   * 群ごとの直すものの数。目次に印を付ける。無くても動くものは数えない。
   * Claude Code との互換のずれは、利用者が直せるものではないので数えない（目次の点も灯さない）。
   */
  todo: { must: number; link: number };
  /** Claude Code との互換の節（C2）。準備の確かめが届く前と、compat の無い古いサーバの答えでは null。 */
  compat: CompatProps | null;
```

`presentSettings` の `const hard = (l: VerifyLine | null) => …;` の行の前に足す。

```ts
  // compat の無い古いサーバの答えでは、互換の節を「確かめています」のままにする。
  const compatSummary = r ? (r as Partial<ReadinessDto>).compat : undefined;
```

返り値の `verify, todo,` の行を置き換える。

```ts
    verify, todo,
    compat: compatSummary ? presentCompat(compatSummary, store.compat, store.version) : null,
```

- [ ] **Step 5: 設定の節の View を足す**

`packages/ui/src/views/CompatSection.tsx` の import を置き換える。

```tsx
import type { CompatState } from '@agent-hangar/shared';
import type { CompatProps } from '../presenters/compat.ts';
import { CopyButton } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';
```

ファイルの末尾に足す。

```tsx
/** 見出しの右端の札の調子。未確認の版は止めていないので、印の無い灰色にする。 */
const BADGE_TONE: Record<CompatState, 'ok' | 'info' | 'warn'> = { ok: 'ok', unverified: 'info', drift: 'warn' };

/**
 * 設定の「連携」の群の先頭の節（C2）。
 * MCP と statusline の節と同じく、見出しと右端の札で状態を言い、本文に手元の版と確かめた版を出す。
 * 未確認の版は版の並びに止めていないことを添え、ずれは前置きの下に止めた機能と畳んだ細目（CompatDrifts）を出す。
 * 準備の確かめが届く前は「確かめています」と出す。
 */
export function CompatSection(props: { compat: CompatProps | null }) {
  const c = props.compat;
  return (
    <section className="cp-sec">
      <h3 className="h2">
        Claude Code との互換
        {c && (
          <span className="badge" data-tone={BADGE_TONE[c.state]}>
            {c.state === 'ok' && <Icon name="check" />}
            {c.state === 'drift' && <Icon name="alert" />}
            {c.badge}
          </span>
        )}
      </h3>
      <div className="muted">hangar は Claude Code の会話の記録、状態のファイル、statusline、<code>~/.claude</code> の項目、CLI の出力、画面の文字を読んでいます。知らない形に出会ったら、ここに出します。</div>
      {c === null ? <div className="faint" style={{ marginTop: 4 }}>確かめています</div> : (
        <div className="cp-vers">
          <span>手元の版 <code>{c.localVersion}</code></span>
          <span>確かめた版 <code>{c.verifiedVersion}</code></span>
          {c.state === 'unverified' && <span className="faint">{c.lead}</span>}
        </div>
      )}
      {c !== null && c.state === 'drift' && (
        <>
          <div className="cp-lead">{`${c.lead}。`}</div>
          <CompatDrifts c={c} />
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 6: 連携の群の先頭に節を置く**

`packages/ui/src/views/SettingsScreen.tsx` の import に足す（`import { CloudUsage } from './CloudUsage.tsx';` の後）。

```tsx
import { CompatSection } from './CompatSection.tsx';
```

`SETTINGS_GROUPS` の連携の行を置き換える。

```ts
  { id: 'settings-link', title: '連携', subs: ['Claude Code との互換', 'MCP', 'statusline', '外のターミナル', '通知', 'アカウント'], icon: 'link' },
```

`<Group id="settings-link" todo={props.todo.link}>` の直後（MCP の `<section>` の前）に足す。

```tsx
            {/* 互換のずれは利用者が直せるものではないので、todo には数えない（目次の点も灯さない）。 */}
            <CompatSection compat={props.compat} />
```

- [ ] **Step 7: CSS を足す**

`packages/ui/src/styles/settings.css` の `.settings-group-h` の行を置き換える。

```css
.settings-group-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 calc(var(--u) * 2); margin: 0 0 calc(var(--u) * 2.5) var(--u); font-size: var(--fs-md); font-weight: 700; letter-spacing: -0.01em; }
```

`.badge[data-tone='warn'] { … }` の行の後に足す。

```css
/* 未確認の版（Claude Code との互換）。止めてはいないので、印の無い灰色の地と縁にする。 */
.badge[data-tone='info'] { color: var(--ink-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-strong); }
```

ファイルの末尾に足す。

```css
/* Claude Code との互換の節（C2）。値の正本は試作 docs/superpowers/specs/2026-10-07-stage0-claude-compat/checks.html。 */
.cp-sec code { font: 500 11px var(--font-mono); }
.cp-vers { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px calc(var(--u) * 4); margin-top: calc(var(--u) * 2); font-size: var(--fs-sm); color: var(--ink-2); }
.cp-vers code { font-size: var(--fs-sm); color: var(--ink); }
.cp-lead { margin-top: calc(var(--u) * 2.5); padding-top: calc(var(--u) * 2.5); border-top: 1px solid var(--line); font-size: var(--fs-sm); color: var(--ink-2); }
```

- [ ] **Step 8: 通るのを確かめる**

Run: `npx vitest run packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/misc.test.tsx packages/ui/src/styles/settings.test.ts`
Expected: PASS。

Run: `npx vitest run packages/ui`
Expected: PASS。

Run: `npm run typecheck`
Expected: エラー無し。

- [ ] **Step 9: 設計書の「Settings」と「Claude Code との互換」の節を直す**

`docs/design.md` の「Settings」の節で、次を置き換える。

置き換え前：`群は、必須（ワークスペース、ツール、Node）、連携（MCP、statusline、外のターミナル、通知、アカウント）、要約器、同期（クラウド同期）、情報（使用量、索引、この PC、会話の保持）である。`
置き換え後：`群は、必須（ワークスペース、ツール、Node）、連携（Claude Code との互換、MCP、statusline、外のターミナル、通知、アカウント）、要約器、同期（クラウド同期）、情報（使用量、索引、この PC、会話の保持）である。`

同じ節の `直すもの（無くても動くものを除く ✗）がある群には、目次と群の見出しに印を付ける。` の行の後に足す。

```markdown
Claude Code との互換のずれは、利用者が直せるものではないので直すものに数えず、目次の点も群の見出しの印も灯さない。
「直すもの」は、利用者が手を打てるものだけを指す言葉にしておく。
```

同じ節の `MCP、statusline、外のターミナルの見出しの右には、登録済み、追記済み、この PC は導入済みかどうかの札を置く。` の行の後に足す。

```markdown
連携の群の先頭には「Claude Code との互換」の節を置く（試作は `docs/superpowers/specs/2026-10-07-stage0-claude-compat/checks.html` の A4、B1、C2）。
見出しの右の札で状態を言い、本文に hangar が読む Claude Code の形と、手元の版と確かめた版を出す。
問題なしは緑の「✓ 問題なし」、未確認の版は印の無い灰色の「未確認の版」で、版の並びに「まだ確かめていない版です。動きは止めていません」を添える。
ずれは注意の色の「! ずれ N 件」で、止めた機能を「〜を止めています」「〜を控えています」の一覧で常に出し、契約、値、版、最初に見た時刻、止めた機能の表を「ずれ N 件の中身」で畳む。
表の下に記録の置き場（`~/.agent-hangar/compat.json`）と「報告用に写す」を置く。
写すのはずれの一覧の Markdown の表で、画面の表に無い回数と最後に見た時刻も載せる。
止めた機能の言い方は DTO に持たせず、画面が契約と値の頭から引く（`packages/ui/src/presenters/compat.ts`）。
契約だけでは、CLI の 4 つの出力、statusline の自動で直す単位、レジストリの項目ごとに、止めるものが 1 つに決まらないからである。
判定は初回の確認リストの 6 行目と同じもの（`compatState` と `presentCompat`）を使う。
準備の確かめが届く前と、`compat` の無い古いサーバの答えでは、節の本文の下に「確かめています」と出す。
```

計画 A の Task 12 が「Claude Code との互換」の節（「ずれの記録」の小節の最後）に書いた 1 行を直す。
次で 1 行が出ることを確かめる。

Run: `grep -n "画面に出すのは設定の確認リストの 1 行だけで" docs/design.md`
Expected: 1 行。

置き換え前：`画面に出すのは設定の確認リストの 1 行だけで、ヘッダーと知らせの札には出さない。`
置き換え後（3 行にする）：

```markdown
画面に出すのは、設定の「連携」の群の節と、初回の確認リストの 6 行目だけで、ヘッダー、知らせの札、設定の目次の点には出さない（「Settings」と「Home」の節）。
ずれの中身（`GET /api/compat`）は、準備の確かめでずれが 1 件以上あるときに、画面が続けて取る。
止めた機能の一覧を、開くのを待たずに出すためである。
```

- [ ] **Step 10: コミットする**

```bash
git add packages/ui/src/presenters/settings.ts packages/ui/src/presenters/presenters.test.ts packages/ui/src/views/CompatSection.tsx packages/ui/src/views/SettingsScreen.tsx packages/ui/src/views/misc.test.tsx packages/ui/src/styles/settings.css packages/ui/src/styles/settings.test.ts docs/design.md
git commit -m "feat(ui): add the Claude Code compat section to the settings link group

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 確かめ（全部の試験、型、3 つのビルド、実データに重ねて撮る）

**Files:**
- 変更しない（崩れが見つかったときだけ、該当のファイルを直す）。
- 撮るための道具と画像は、リポジトリの外の作業場に置く。

**Interfaces:**
- Consumes: Task 1 から Task 4 のすべて。
- Produces: 型と全部の試験とビルドが通り、3 つの状態の見た目を設定と初回の確認リストの両方で目で確かめた状態。

ここでの `PW_DIR` は、playwright（と WebKit）を `node_modules` に持つ、リポジトリの外の作業場である。
この計画には手元のパスを書かないので、実行するときに入れる。
playwright がまだ無い作業場なら、`npm i playwright` と `npx playwright install webkit` をその作業場で打つ。

- [ ] **Step 1: 型と全部の試験を通す**

Run: `npm run typecheck`
Expected: エラー無し。

Run: `npm test`
Expected: PASS。

Run: `grep -rnE "6 行目を開いたとき|設定の確認リストの 1 行だけ" packages docs/design.md`
Expected: 何も出ない。

- [ ] **Step 2: UI を含めてビルドする**

Run: `npm run build`
Expected: エラー無し。`packages/ui/dist/index.html` と `packages/ui/dist/assets/index-*.js` ができる。

- [ ] **Step 3: 重ねて撮る道具を書く**

`$PW_DIR/compat-check/overlay.mjs` を作る（リポジトリの外である）。
動いているアプリ（`http://127.0.0.1:4177`）の実データに、worktree の `packages/ui/dist` を重ねる。
互換の 3 つの状態は、準備の確かめの `compat` と `GET /api/compat` の答えだけを差し替えて作り、ほかの値は本物のままにする。
初回の確認リストは、起動データからセッションとプロジェクトを外した空のホームで撮る。
どちらも読むだけで、ボタンは押さない。
畳んだ細目は、`details` の `open` を立てて開く（押さない）。

```js
// 動いているアプリ（127.0.0.1:4177）の実データに、worktree の UI（dist）を重ねて WebKit で撮る。読むだけで、ボタンは押さない。
// 互換の 3 つの状態は、準備の確かめの compat と GET /api/compat だけを差し替えて作る。ほかの値は本物のまま。
// 使い方: node overlay.mjs <dist> <out>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pw from 'playwright';

const [dist, out] = process.argv.slice(2);
if (!dist || !out) throw new Error('使い方: node overlay.mjs <dist> <out>');
fs.mkdirSync(out, { recursive: true });
const ORIGIN = 'http://127.0.0.1:4177';
const token = fs.readFileSync(path.join(os.homedir(), '.agent-hangar', 'token'), 'utf8').trim();
const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const asset = indexHtml.match(/assets\/index-[^"]+\.js/)?.[0];
if (!asset) throw new Error('dist の index.html に assets/index-*.js が無い');

// 試作と同じ見本の値。確かめた版 2.1.292、手元の版 2.1.300、ずれ 3 件（2 件が機能を止め、1 件は記録だけ）。
const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
const V = '2.1.292';
const FIX = {
  ok: { summary: { verifiedVersion: V, localVersion: V, driftCount: 0 }, full: { verifiedVersion: V, localVersion: V, drifts: [] } },
  unverified: { summary: { verifiedVersion: V, localVersion: '2.1.300', driftCount: 0 }, full: { verifiedVersion: V, localVersion: '2.1.300', drifts: [] } },
  drift: {
    summary: { verifiedVersion: V, localVersion: '2.1.300', driftCount: 3 },
    full: {
      verifiedVersion: V, localVersion: '2.1.300', drifts: [
        { contract: 'screen', value: 'prompt-marker=(missing)', version: '2.1.300', count: 2, firstSeenAt: at(7, 14, 2), lastSeenAt: at(7, 14, 9) },
        { contract: 'registry', value: 'status=compacting', version: '2.1.300', count: 5, firstSeenAt: at(7, 13, 40), lastSeenAt: at(7, 14, 5) },
        { contract: 'transcript', value: 'system.subtype=turn_summary', version: '2.1.298', count: 9, firstSeenAt: at(6, 22, 15), lastSeenAt: at(7, 14, 1) },
      ],
    },
  },
};
/** null は本物のまま。ok、unverified、drift は互換の値だけを差し替える。 */
let mode = null;
/** true のあいだは、起動データからセッションとプロジェクトを外し、空のホーム（初回の確認リスト）を出す。 */
let empty = false;

const b = await pw.webkit.launch();
const ctx = await b.newContext({ viewport: { width: 1512, height: 868 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
// 1. 本物の入口で鍵のクッキーを受け取る。差し替えた応答の Set-Cookie は WebKit に入らず、持っていたクッキーまで消えるので、先に受け取る。
await p.goto(`${ORIGIN}/?t=${token}`);
await p.waitForTimeout(1200);

// 2. 経路を付ける。index は pathname で当てる（文字列で当てると ?t= 付きの URL に当たらず、黙って本物の UI が出る）。
await p.route((u) => u.origin === ORIGIN && u.pathname === '/', async (r) => {
  const res = await r.fetch();
  const headers = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => k.toLowerCase() !== 'set-cookie'));
  await r.fulfill({ status: 200, headers, body: indexHtml });
});
await p.route((u) => u.origin === ORIGIN && u.pathname.startsWith('/assets/'), async (r) => {
  const file = path.join(dist, new URL(r.request().url()).pathname);
  if (!fs.existsSync(file)) return r.continue();
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : undefined;
  await r.fulfill({ path: file, ...(type ? { contentType: type } : {}) });
});
await p.route((u) => u.origin === ORIGIN && u.pathname === '/api/readiness', async (r) => {
  const res = await r.fetch();
  if (!mode) return r.fulfill({ response: res });
  await r.fulfill({ response: res, json: { ...(await res.json()), compat: FIX[mode].summary } });
});
await p.route((u) => u.origin === ORIGIN && u.pathname === '/api/compat', async (r) => {
  if (!mode) return r.continue();
  await r.fulfill({ json: FIX[mode].full });
});
await p.route((u) => u.origin === ORIGIN && u.pathname === '/api/bootstrap', async (r) => {
  const res = await r.fetch();
  if (!empty) return r.fulfill({ response: res });
  const body = await res.json();
  await r.fulfill({ response: res, json: { ...body, sessions: [], projects: body.projects.filter((x) => x.isScratch), live: [], runs: [], tabs: [] } });
});
// 端末の WebSocket は塞ぐ（ほかのセッションの端末の大きさを変えないため）。
await ctx.routeWebSocket((u) => u.pathname === '/ws/pty', (ws) => { ws.close(); });
// 知らせの WebSocket は通す。空のホームを撮るあいだだけ、セッションとプロジェクトを足す知らせを落とす。
const DROP = new Set(['session.upsert', 'project.upsert', 'live.update', 'run.started', 'run.upsert', 'tab.upsert']);
await ctx.routeWebSocket((u) => u.pathname === '/ws', (ws) => {
  const server = ws.connectToServer();
  ws.onMessage((m) => server.send(m));
  server.onMessage((m) => {
    if (empty) { try { if (DROP.has(JSON.parse(m).type)) return; } catch { /* 文字でない知らせはそのまま通す */ } }
    ws.send(m);
  });
});

/** その画面を読み直し、差し替えた UI が読まれたかを毎回確かめる。 */
async function reload(hash) {
  await p.goto(`${ORIGIN}/${hash}`);
  await p.reload();
  await p.waitForTimeout(2500);
  const loaded = await p.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => s.includes('/assets/index-')));
  console.log('dist の index:', asset, '／読み込んだもの:', loaded);
  if (!loaded || !loaded.endsWith(asset)) throw new Error('UI が差し替わっていない');
}
/** 連携の群の先頭の節（互換の節）だけを撮る。 */
const shotSettings = (name) => p.locator('#settings-link > section').first().screenshot({ path: path.join(out, `${name}.png`) });
/** 畳んだ細目を開く。details の open を立てるだけで、ボタンは押さない。 */
const openDetails = async () => { await p.evaluate(() => { for (const d of document.querySelectorAll('details.cp-more')) d.open = true; }); await p.waitForTimeout(400); };
/** 目次の点の数と、連携の群の見出し。互換の状態で変わらないことを見る。 */
const marks = async () => ({ dots: await p.locator('.settings-toc-dot').count(), link: (await p.locator('#settings-link-h').innerText()).replace(/\s+/g, ' ') });

// 3. 本物の値のまま、設定の節を撮る。
await reload('#/settings');
console.log('本物の compat:', JSON.stringify(await p.evaluate(async () => (await (await fetch('/api/readiness')).json()).compat ?? null)));
await shotSettings('settings-real');

// 4. 3 つの状態を設定で撮る。
for (const m of ['ok', 'unverified', 'drift']) {
  mode = m;
  await reload('#/settings');
  console.log(m, '目次の点と連携の見出し:', JSON.stringify(await marks()));
  await shotSettings(`settings-${m}`);
  if (m === 'drift') { await openDetails(); await shotSettings('settings-drift-open'); }
}

// 5. 狭い窓（900×600）で、ずれの表が節に収まるかを見る。
await p.setViewportSize({ width: 900, height: 600 });
await reload('#/settings');
await openDetails();
await shotSettings('settings-drift-900');
await p.setViewportSize({ width: 1512, height: 868 });

// 6. 空のホームの確認リストを 3 つの状態で撮る。
empty = true;
for (const m of ['ok', 'unverified', 'drift']) {
  mode = m;
  await reload('#/');
  console.log(m, '確認リスト:', await p.locator('.ck-prog').innerText());
  await p.locator('.ck-card').screenshot({ path: path.join(out, `checks-${m}.png`) });
  if (m === 'drift') { await openDetails(); await p.locator('.ck-card').screenshot({ path: path.join(out, 'checks-drift-open.png') }); }
}
await b.close();
console.log('撮った先:', out);
```

- [ ] **Step 4: 撮る**

Run: `node "$PW_DIR/compat-check/overlay.mjs" "$PWD/packages/ui/dist" "$PW_DIR/compat-check/out"`（リポジトリの根で打つ）
Expected: 読み直すたびに「dist の index」と「読み込んだもの」の名前がそろい、`UI が差し替わっていない` で止まらない。
Expected: `ok`、`unverified`、`drift` の 3 行の「目次の点と連携の見出し」が同じ値である（互換の状態で点の数も「直すもの」も変わらない）。
Expected: 確認リストは `ok` と `unverified` が同じ「6 つ中 N つ」、`drift` が 1 つ少ない。
Expected: 最後に「撮った先」が出て、`settings-real.png`、`settings-ok.png`、`settings-unverified.png`、`settings-drift.png`、`settings-drift-open.png`、`settings-drift-900.png`、`checks-ok.png`、`checks-unverified.png`、`checks-drift.png`、`checks-drift-open.png` の 10 枚ができる。

- [ ] **Step 5: 撮った画像を目で見る**

10 枚を 1 枚ずつ開き、試作の A4、B1、C2 と見比べる。
見るのは次のとおりである。

- `settings-real.png`：本物の値の状態で、節が崩れずに出ている（サーバが `compat` を返さない版なら「確かめています」）。
- `settings-ok.png`：見出しの右端に緑の「✓ 問題なし」、本文、手元の版と確かめた版が 1 行に並ぶ。
- `settings-unverified.png`：灰色の地と縁の「未確認の版」（印なし）、版の並びの右に淡い「まだ確かめていない版です。動きは止めていません」。
- `settings-drift.png`：注意の色の「! ずれ 3 件」、細い線の下の前置き、茶の点の 2 行、青い「› ずれ 3 件の中身」。
- `settings-drift-open.png`：5 列の表で、値は薄い地のコード、版と時刻は折り返さず、記録だけの行は淡い「なし」、表の下の左に置き場、右に「報告用に写す」。
- `settings-drift-900.png`：表と前置きが節の白い面からはみ出さず、横のスクロールが出ない。
- `checks-ok.png`：6 行目が緑の ✓ で「ずれなし（2.1.292 で確かめた版）」、上の 5 行と行の高さと字の並びがそろう。
- `checks-unverified.png`：6 行目が灰色の ⓘ で「2.1.300（確かめた版は 2.1.292）」。
- `checks-drift.png`：6 行目が茶の ! で「ずれ 3 件（2.1.300）」、説明の下に止めた機能の 2 行と「ずれ 3 件の中身」。
- `checks-drift-open.png`：表が 620px の札に収まり、文字が重ならない。

崩れが見つかったら、該当のタスクのファイルを直し、Step 1 からやり直す。
画像はリポジトリに入れない。

- [ ] **Step 6: デスクトップのビルドを通す**

Run: `npm run bundle-server -w apps/desktop`
Expected: エラー無し。

Run: `PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" npm run tauri -w apps/desktop -- build`
Expected: エラー無し。
macOS のアプリの束ができる。

- [ ] **Step 7: 直したものがあればコミットする**

Step 5 で直したものが無ければ、この Step は飛ばす。
直したときは、直したファイルだけを足してコミットする。

```bash
git add packages/ui/src docs/design.md
git commit -m "fix(ui): adjust the compat views after checking them on real data

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
