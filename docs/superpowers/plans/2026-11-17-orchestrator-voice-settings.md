# 統括の声の設定画面と外の声 計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設定画面で統括の聞き方と人格（名前・読み・口調・声・速さ）を編集でき、声は Kokoro・VOICEVOX・AivisSpeech・この Mac から選べるようにする。

**Architecture:** 声の一覧はサーバが集める（VOICEVOX と AivisSpeech はエンジンの HTTP の `/speakers`、この Mac の声は補助の `voices` 命令、Kokoro は固定の一覧）。読み上げは今までどおり補助（hangar-voice）が鳴らし、VOICEVOX と AivisSpeech の声は補助がエンジンへ HTTP で合成を頼んで同じ出力の経路で鳴らす（ダッキングと speaking の事象をそろえるため）。画面は試作 C（行が垂れて開く）と声の欄 X（出どころの切り替え＋話者＋スタイル）。

**Tech Stack:** TypeScript（shared / server / ui、vitest）、Swift（apps/voice-mac、XCTest）。

**Spec:** `docs/superpowers/specs/2026-11-16-orchestrator-voice-design.md`（声の出どころ）、試作は scratchpad の `voice-settings.html`（C）と `voice-sources.html`（X）。

## Global Constraints

- 声の id は `kokoro:<声>`・`os:<識別子>`・`voicevox:<style id>`・`aivis:<style id>`（style id は非負の整数）。
- エンジンの既定の口：VOICEVOX `http://127.0.0.1:50021`、AivisSpeech `http://127.0.0.1:10101`。環境変数 `HANGAR_VOICEVOX_URL`・`HANGAR_AIVIS_URL` で替えられる。127.0.0.1 以外へは繋がない。
- エンジンは同梱しない。起動していなければ、その出どころは `running:false` で、画面は「VOICEVOX を開く」のボタンを出す（`open -a VOICEVOX` / `open -a AivisSpeech`）。
- 行の下の一言は VOICEVOX のクレジットの形（`VOICEVOX:ずんだもん（あまあま）`、スタイルがノーマルなら括弧なし）。
- 人格の決まり（名前 1〜20、読みはひらがな 2〜20 か空、口調 300 字・改行 3 つまで、速さ 0.5〜2）は今のまま。人格は 1〜8 人。
- 設定の voice は同期しない（今のまま）。
- 画面に補助のラベルや説明文を足さない。動きは motionKit（growIn・collapseOut・fadeIn）と usePresence。明るい配色だけ。
- 段 2 の範囲の外（ショートカット、Windows、「今のなし」）は入れない。

## Review Focus

1. エンジンが途中で落ちた／遅い：`/api/voice/voices` は 1 秒で諦め、その出どころだけ running:false にする（全体を待たせない）。読み上げ中に落ちたら補助は `error` を出して speaking の end を返し、止まらない。
2. 保存された声の style id がエンジンから消えた（話者の入れ替え）：設定は捨てず、行の一言は保存した `voiceLabel` を出し、読み上げは失敗を error で知らせる。
3. 人格を全部消そうとする：最後の 1 人は消せない（消すボタンが効かない）。使っている人格を消したら、前の人格が選ばれる。
4. 読みが空の人格を選んで「常に聞く」にする：呼びかけ語が効かない（callable:false）。保存は通す。
5. 127.0.0.1 以外の URL を環境変数に入れる：使わずに既定へ戻す。

---

## Interfaces

- shared `VoicePersona` に `voiceLabel: string`（0〜40 字、制御文字なし。読み込みで合わなければ空）を足す。`isVoiceId` は 4 つの形を受ける。
- shared の型：
  - `VoiceSourceId = 'kokoro' | 'voicevox' | 'aivis' | 'os'`
  - `VoiceCatalog = { sources: Array<{ id: VoiceSourceId; running: boolean; speakers: Array<{ name: string; styles: Array<{ name: string; voice: string }> }> }> }`（並びは kokoro・voicevox・aivis・os。Kokoro は jf_alpha・jf_gongitsune・jf_nezumi・jf_tebukuro・jm_kumo、スタイルは 1 つで name は空）
  - 補助の命令に `{ cmd: 'voices' }`、事象に `{ ev: 'voices'; os: Array<{ id: string; name: string }> }`（ja-JP の AVSpeechSynthesisVoice）。
  - `speak` の命令は今のまま（voice に新しい形が来る）。
- サーバの口：
  - `GET /api/voice/voices` → `VoiceCatalog`（補助が無ければ 409）。
  - `POST /api/voice/preview { voice: string; speed: number; text?: string }` → 補助へ speak（id は `preview-<連番>`）。text が無ければ人格の名前を入れた決まった一文。
  - `POST /api/voice/engine { source: 'voicevox' | 'aivis' }` → `open -a` でエンジンを起こす。

## Task 1: shared とサーバ（声の一覧・試し聞き・エンジンを開く）

**Files:** `packages/shared/src/voice.ts`(+test)、`packages/server/src/voice/catalog.ts`(新)・`service.ts`・`packages/server/src/http/routes/voice.ts`(+tests)、`docs/design.md`

- [ ] 試験：`isVoiceId` が `voicevox:3`・`aivis:888753760` を受け、`voicevox:x`・`voicevox:` を断る。`voiceLabel` の読み込みと strict の検査。
- [ ] 試験：catalog はエンジンの `/speakers` の応答（`[{name, styles:[{name,id}]}]`）を `VoiceCatalog` に変える。エンジンが応答しない・1 秒を超える・壊れた JSON なら running:false で speakers は空。URL の環境変数が 127.0.0.1 以外なら既定。
- [ ] 試験：routes の voices・preview・engine（不正な本文は 400、補助なしは 409、engine は source の検査）。
- [ ] 実装、`npm run typecheck`・`npm test`、コミット。

## Task 2: 補助（VOICEVOX と AivisSpeech の読み上げ、OS の声の一覧）

**Files:** `apps/voice-mac/Sources/VoiceCore/HelperParts.swift`（VoiceSpec）・`Protocol.swift`、`apps/voice-mac/Sources/hangar-voice/Speaker.swift`・`main.swift`、試験、README

- [ ] 試験：`VoiceSpec("voicevox:3")` と `VoiceSpec("aivis:888753760")` を読み、`voicevox:x` は nil。合成の要求（`POST /audio_query?speaker=N&text=…` → 応答の `speedScale` を速さで上書き → `POST /synthesis?speaker=N`）を作る純粋な関数の試験。
- [ ] 実装：Speaker は合成した WAV を Kokoro と同じ出力の経路で鳴らし、speaking の start/end/stopped を出す。合成の失敗は `error`（code `engine`）を出して end。`voices` 命令に `voices` 事象で ja-JP の声を返す。
- [ ] `swift test`（apps/voice-mac）、コミット。

## Task 3: 画面（設定の「統括の声」）

**Files:** `packages/ui/src/views/VoiceSettings.tsx`(新)+test、`SettingsScreen.tsx`、`runtime/api.ts`・`test/fakeApi.ts`、`styles/`、i18n の文言、`docs/design.md`

- [ ] 試作 C と X のとおり：聞き方の切り替え（押している間だけ＝off／押して切り替え＝toggle／常に聞く＝always、常に聞くのとき「ねえ、<読み>」が伸びて出る）、人格の行（丸で選ぶ、行を押すと垂れて開く、開くのは 1 つ）、中身（名前・読み・口調・声・速さ・試し聞き・消す）、「+ 足す」。
- [ ] 声の欄：出どころの切り替え（4 つ、止まっている出どころは薄く）、話者の選択、スタイルが 2 つ以上なら 2 つ目の選択、止まっていれば「<名前> を開く」のボタン（押したら engine を呼び、一覧を読み直す）。選んだら `voiceLabel` も書く。
- [ ] 保存は設定の PATCH（voice の全体）。入力は打ち終わり（blur か 600ms の間）で保存。
- [ ] 試験を先に（選ぶ・足す・消す・最後の 1 人は消せない・出どころの切り替え・止まった出どころ）。
- [ ] 動いているアプリに重ねて WebKit で撮って確かめる。`npm run readme-shots -- --stale`。コミット。

Task 1 と Task 2 は並行。Task 3 は Task 1 のマージ後。
