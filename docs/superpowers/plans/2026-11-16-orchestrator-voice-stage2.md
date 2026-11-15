# 統括の音声 段 2（端末の音声の口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mac で、聞き取り・区切り・読み上げを端末の中（Swift の補助プロセス）で行い、押している間・切り替え・呼びかけ語・窓・会議中の休みの合図で、由来つきの文を統括へ自動で送る。

**Architecture:** Swift の補助 `hangar-voice` が、マイク（voice processing の回り込み消し）・Silero VAD・lilfugu の認識・Kokoro の読み上げ・マイクを使うプロセスの見張りを持ち、標準入出力の 1 行 1 JSON でサーバと話す。誰宛てかの判断、作り話の捨て、語彙のヒント、統括への送り、画面への状態の配信はサーバ（TS）が持つ。画面は状態を受けて試作 A（マイクの丸が伸びて字幕になる）で見せ、読み上げはサーバ経由で補助に頼む。

**Tech Stack:** Swift 5.10 / `mlx-audio-swift` 0.1.9（Neywa-Labs、MIT）、AVAudioEngine、CoreAudio、Node（Hono、vitest）、React、Tauri v2。

**Spec:** `docs/superpowers/specs/2026-11-16-orchestrator-voice-design.md`

## Global Constraints

- 認識は端末の中。音声を外へ出さない。Web Speech の聞き取りは、補助が使える Mac では使わない（Windows は段 2 の対象外で、今の動きのまま）。
- 認識の前に必ず VAD を通す。VAD の区間の音量が下限より小さければ捨てる。
- 定番の作り話と、語彙のヒントの一覧が丸ごと出た結果は捨てる。
- 呼びかけ語は語彙のヒントに入れない。呼びかけ語は「ねえ＋名前」。名前は人格の設定から取る。
- voice processing の他のアプリの音の絞りは最小（`voiceProcessingOtherAudioDuckingConfiguration` を `.min`）。
- 窓は、利用者が強い由来で話しかけ、統括が返した直後にだけ開く。統括が自分から話した後には開かない。
- 会議中（自分以外のプロセスがマイクを使っている）は、呼びかけ語と窓を休む。押している間と切り替えは残す。
- 権限と安全の決まりは人格で変えられない。由来はサーバが決め、画面からも補助からも本文の印は受けない（段 1 の `markOrchestratorText` を通す）。
- 補助は macOS 14 以上でだけ動く。それより古い Mac、Windows、補助が無い build では「使えない」を返し、画面は今の動きに戻る。
- モデルは同梱しない。初めて使うときに Hugging Face のキャッシュへ落とす。既定は認識 `holotherapper/lilfugu-8bit`、VAD `mlx-community/silero-vad`。
- 読み上げの声の出どころは `os`（AVSpeechSynthesizer）と `kokoro`（`mlx-community/Kokoro-82M-bf16`）。2026-11-16 の実測で、`mlx-audio-swift` 0.1.9 の Kokoro は日本語を 1 字ずつ byT5 で音にし、13 文とも別の文に聞こえた（scratchpad の kok/）。Task 2b で日本語の読みを自前で作り、往復の一致が平均 0.85 以上になったら既定を `kokoro`・`jf_alpha` にする。それまでの既定は `os`・`com.apple.voice.compact.ja-JP.Kyoko`。
- 画面の文言は追加しない方針（状態は配置と動きで見せる）。どうしても足す文言は Gemini に当てる。
- 試験はサーバと画面は vitest、Swift は XCTest。

## Review Focus

1. 常に聞くで、家族の会話やテレビの音が統括へ送られる → 呼びかけ語で始まらない区間は、窓の外では送らない（Task 5 の試験 `ambient speech is never sent`）。
2. 補助が落ちた・ビルドに無い → サーバは落ちず、状態は `unavailable`、画面は今のマイクの動きのまま（Task 4 の試験 `helper crash marks unavailable and restarts with backoff`）。
3. 読み上げ中の自分の声やほかのアプリの音から作り話が出る → 音量の下限と定番の文で捨てる（Task 3 の試験）。
4. 会議が始まった瞬間に窓が開いていた → 会議に入ったら窓を閉じる（Task 5 の試験 `meeting closes an open window`）。
5. 押している間に複数の区間が出る → 離したときに順に 1 本の文にまとめて 1 回だけ送る（Task 5 の試験 `held joins segments in order and sends once`）。

---

## 補助とサーバの約束（1 行 1 JSON）

サーバ → 補助（標準入力）：
- `{"cmd":"listen","on":boolean}` マイクの取り込みを始める・止める。
- `{"cmd":"hints","context":string}` 認識に渡す語彙のヒント（カンマ区切り）。
- `{"cmd":"flush"}` いまの区間をすぐ閉じて出し、続けて `{"ev":"flushed"}` を出す。
- `{"cmd":"speak","id":string,"text":string,"voice":string,"speed":number}` 読み上げる。前の読み上げは止める。
- `{"cmd":"stopSpeaking"}`
- `{"cmd":"prepare"}` 要るモデルを落として読み込む。
- `{"cmd":"quit"}`

補助 → サーバ（標準出力）：
- `{"ev":"ready","version":string}` 起動した。
- `{"ev":"models","state":"missing"|"downloading"|"loading"|"ready"|"failed","progress":number(0..1),"message"?:string}`
- `{"ev":"vad","speech":boolean}` 声の始まりと終わり。
- `{"ev":"segment","id":string,"text":string,"dbfs":number,"ms":number}` 1 区間の認識の結果（`dbfs` は声の区間の平均の音量）。
- `{"ev":"flushed"}`
- `{"ev":"speaking","id":string,"state":"start"|"end"|"stopped"}`
- `{"ev":"micUsers","bundles":string[]}` 自分の PID と `com.apple.CoreSpeech` を除いた、マイクを使っているプロセス（変わったときだけ）。
- `{"ev":"error","code":string,"message":string}`

## 区切りの値（補助の中）

Silero の 1 枠は 16 kHz で 512 サンプル。声の確率 0.5 以上が 2 枠続いたら始まり、前の 300 ms も含める。無音 700 ms で区間を閉じる。1 区間は 30 秒まで。（Smart Turn は使わない。言いかけの扱いはサーバの合図の側で受ける。造り手の判断で、段 2 では入れない。）

## 誰宛てかの決まり（サーバ）

- `voice.mode`：`off`（押している間だけ）、`toggle`（丸を押して入れる。最初の区間は `voice-toggle-first`、次から `voice-toggle-rest`）、`always`（呼びかけ語と窓）。押している間はどのモードでも使え、`voice-held`。
- 呼びかけ語の照合：区間の文をひらがなに寄せ、句読点と空白を除き、頭が「ねえ」＋名前の読み（`ねー`、`ねぇ` も可）なら呼ばれたとみなす。残りが空なら 8 秒の間、次の区間を `voice-called` で送る。残りがあればそれを `voice-called` で送る。
- 窓：強い由来（held、called、toggle-first）で送った後、統括の返答の読み上げが終わった時刻（読まないときは返答が届いた時刻）から 10 秒。窓の中の区間は `voice-window`。窓の区間で送った後の返答では、窓を開かない。
- 「止めて」「ストップ」だけの区間は、読み上げ中なら読み上げを止めて送らない。
- 会議：`micUsers` が空でなければ会議。常に聞くの照合と窓を止め、開いている窓は閉じる。

## 捨てる決まり（サーバ）

- `dbfs < -45` の区間。
- 正規化した文が定番の作り話：`ご視聴ありがとうございました`、`ご清聴ありがとうございました`、`チャンネル登録よろしくお願いします`、`おやすみなさい`（区間全体がそれだけのとき）。
- 常に聞くの窓の区間で、`はい` `うん` `ええ` だけのもの（承認の言葉の作り話を送らない）。
- ヒントの語が 3 つ以上カンマや読点で並び、文の 6 割以上を占めるもの。

---

### Task 1: 補助 `hangar-voice` の芯（モデルなしで試験できる部分）

**Files:**
- Create: `apps/voice-mac/Package.swift`（ターゲット `VoiceCore`（ライブラリ、MLX に依らない）、`hangar-voice`（実行、MLX あり）、`VoiceCoreTests`）
- Create: `apps/voice-mac/Sources/VoiceCore/Protocol.swift`、`Segmenter.swift`
- Create: `apps/voice-mac/Tests/VoiceCoreTests/ProtocolTests.swift`、`SegmenterTests.swift`
- Modify: `.github/workflows/ci.yml`（`voice-mac` ジョブ：macos-latest で `swift test --package-path apps/voice-mac --filter VoiceCoreTests`）

**Interfaces:**
- Produces: `enum Command: Decodable`（上の約束の cmd の全部）、`enum Event: Encodable`（ev の全部）、`func encodeLine(_ e: Event) -> String`、`func decodeLine(_ s: String) -> Command?`（知らない cmd は nil）。
- Produces: `struct Segmenter { init(sampleRate: Int = 16000, frame: Int = 512, startProb: Float = 0.5, startFrames: Int = 2, preRollMs: Int = 300, silenceMs: Int = 700, maxMs: Int = 30000); mutating func push(frame: [Float], prob: Float) -> [SegmenterOutput]; mutating func flush() -> [SegmenterOutput] }`、`enum SegmenterOutput { case speechStart; case speechEnd; case segment(samples: [Float], dbfs: Float) }`。

- [ ] 試験：`decodeLine` が約束の各 cmd を読み、知らない cmd と壊れた JSON で nil。`encodeLine` が 1 行（改行を含まない）で ev を書く。
- [ ] 試験：無音だけ → 出力なし。声 1 秒＋無音 1 秒 → speechStart、speechEnd、segment が 1 つで、長さは 1 秒＋前の 300 ms 以上。声の途中で `flush()` → その場で segment。30 秒を超える声 → 30 秒で切れる。声の確率 0.5 以上が 1 枠だけ → 始まらない。
- [ ] 落ちるのを見てから実装し、通す。CI のジョブを足す。
- [ ] Commit `feat(voice-mac): 補助の約束と区切り`

### Task 2: 補助 `hangar-voice` の本体（マイク・VAD・認識・読み上げ・会議の見張り）

**Files:**
- Create: `apps/voice-mac/Sources/hangar-voice/main.swift`、`Capture.swift`、`Recognizer.swift`、`Speaker.swift`、`MicUsers.swift`、`Models.swift`
- Create: `apps/voice-mac/scripts/build.sh`（`xcodebuild -scheme hangar-voice -configuration Release` で作り、実行ファイルと MLX の metallib の束を `apps/voice-mac/dist/` にそろえる）
- Create: `apps/voice-mac/README.md`（作り方と、ファイルを渡して試す手順）

**Interfaces:**
- Consumes: Task 1 の `Command`、`Event`、`Segmenter`。
- Produces: 実行ファイル `hangar-voice`。引数 `--input-file <wav>` のときはマイクの代わりにそのファイルを実時間で流し、終わったら `flush` して終わる（試験と夜間の確かめ用）。`--speak-to-file <dir>` のときは読み上げを鳴らさずに wav を書く。

- [ ] Capture：AVAudioEngine の入力で voice processing を入れ、他のアプリの音の絞りを最小にし、16 kHz の単声に直して 512 サンプルずつ Silero VAD に通し、Segmenter へ渡す。読み上げの再生も同じエンジンの出力から行う（回り込み消しの参照に入れるため。scratchpad の実測で、先に mainMixerNode と outputNode に触れ、接続の形式を nil にしないと -10875 で落ちた）。
- [ ] Recognizer：`Qwen3ASRModel.fromPretrained`、`generate(audio:context:language:"Japanese")`。区間ごとに `segment` を出す。
- [ ] Speaker：`speak` の `voice` が `os:<識別子>` なら AVSpeechSynthesizer の `write` で PCM を得て、`kokoro:<声>` なら `TTS.loadModel(modelRepo: "mlx-community/Kokoro-82M-bf16")`（`KokoroModel.speed`、`language: "ja"`、文の処理は Task 2b の `JapaneseKokoroProcessor`。2b の前は既定の処理）で作る。どちらも Capture と同じエンジンの再生の口で鳴らす。速さは `speed`（OS の声は `rate` に換算）。読み上げ中に新しい `speak` か `stopSpeaking` が来たら止めて `stopped` を出す。
- [ ] MicUsers：`kAudioHardwarePropertyProcessObjectList` と `kAudioProcessPropertyIsRunningInput` を 1 秒ごとに見て、変わったときだけ `micUsers` を出す。
- [ ] Models：`prepare` で 3 つを落とし、進みを `models` で出す。
- [ ] 確かめ：利用者の実声の wav（scratchpad の myvoice/wav）を `--input-file` で流し、29/36 前後になること。無音の wav で segment が出ないこと。`--speak-to-file` で作った音を戻して読めること。
- [ ] Commit `feat(voice-mac): マイク・認識・読み上げ・会議の見張り`

### Task 2b: Kokoro の日本語の読み

**Files:**
- Create: `apps/voice-mac/Sources/VoiceCore/KanaPhonemes.swift`（かな → Kokoro の音素。misaki（Apache 2.0）の `ja.py` の表を移す。出どころを頭に書く）
- Create: `apps/voice-mac/Sources/hangar-voice/JapaneseKokoroProcessor.swift`（`TextProcessor` を満たす。CFStringTokenizer の日本語で語に分け、読みをかなにし、助詞の「は」「へ」を「わ」「え」に直し、`KanaPhonemes` で音素にし、語を空白でつなぐ。句読点は misaki の `PUNCT_MAP` のとおり。英字の語はそのまま渡す）
- Test: `apps/voice-mac/Tests/VoiceCoreTests/KanaPhonemesTests.swift`

**Interfaces:**
- Produces: `func kanaToPhonemes(_ kana: String) -> String`、`final class JapaneseKokoroProcessor: TextProcessor`。

- [ ] 試験：`りょうかい` → `ɾʲoːkai`、`きっぷ` → `kʲiʔpɯ`、`かんぱい` → `kampai`、`さんぽ` → `sampo`、`まんが` → `maŋɡa`、`コンピューター` → `kompʲɨːtaː`、`ちょっと` → `ʨoʔto`、`ふぁいる` → `ɸaiɾɯ`、`しんぶん` → `ɕimbɯɴ`（misaki の出力から取った値）。
- [ ] 確かめ：scratchpad の `kok_lines.txt` の 13 文を `--speak-to-file` で作り、lilfugu で戻して、文字の一致（句読点と空白を除いた編集距離から）が平均 0.85 以上。届けば既定の声を `kokoro:jf_alpha` にする（Task 6 の既定の人格）。届かなければ値を報告し、既定は `os` のまま。
- [ ] Commit `feat(voice-mac): Kokoro の日本語の読み`

### Task 3: サーバの捨てる決まりとヒント（純粋な関数）

**Files:**
- Create: `packages/server/src/voice/filters.ts`、`filters.test.ts`、`hints.ts`、`hints.test.ts`
- Create: `packages/shared/src/speechText.ts`、`speechText.test.ts`（読み上げ用の整形。Markdown の記号、URL、コードの塊を読まない）

**Interfaces:**
- Produces: `dropReason(seg: { text: string; dbfs: number }, ctx: { hints: string[]; inWindow: boolean }): null | 'quiet' | 'hallucination' | 'ack' | 'hintEcho'`
- Produces: `buildHints(input: { sessionTitles: string[]; projectNames: string[]; callName: string }): string[]`（固定の語＋一覧。呼びかけ語の名前と読みは除く。重複を除き 60 語まで）、`hintContext(hints: string[]): string`
- Produces: `speechText(markdown: string): string`

- [ ] 試験を上の「捨てる決まり」の値で書く（`-46` は quiet、`-44` は通る、`ご視聴ありがとうございました。` は hallucination、窓の `はい。` は ack・窓の外の `はい` は通る、`ねえハンガー, hangar, vitest, Sonnet` で hints がその語なら hintEcho）。`buildHints` が名前「ハンガー」と読み「はんがー」を含めない。`speechText` が ``` の塊と URL を落とし、`**太字**` を `太字` にする。
- [ ] 実装して通す。Commit `feat(voice): 作り話を捨てる決まりと語彙のヒント`

### Task 4: 補助の起動と見張り

**Files:**
- Create: `packages/server/src/voice/helper.ts`、`helper.test.ts`、`packages/server/test/fixtures/fakeVoiceHelper.mjs`（約束どおりに台本で返す偽の補助）

**Interfaces:**
- Produces: `class VoiceHelper extends EventEmitter { constructor(opts: { bin: string | null; spawn?: typeof import('node:child_process').spawn; now?: () => number }); start(): void; send(cmd: VoiceCommand): void; stop(): Promise<void>; get status(): 'unavailable' | 'starting' | 'ready' | 'crashed' }`。`'event'` で補助の ev を流す。
- Produces: `resolveVoiceBin(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null`（`HANGAR_VOICE_BIN`、無ければ開発用の `apps/voice-mac/dist/hangar-voice`。darwin 以外は null）。
- Produces: `VoiceCommand`、`VoiceEvent` の型は `packages/shared/src/voice.ts` に置く（画面も使う）。

- [ ] 試験：bin が null なら `unavailable` で何も起こさない。偽の補助で ready まで進む。偽の補助が落ちたら `crashed` を経て 1 秒・2 秒・4 秒…（上限 30 秒）で起こし直し、5 回続けて落ちたら `unavailable` で止まる（Review Focus 2）。壊れた行は捨てて落ちない。
- [ ] 実装して通す。Commit `feat(voice): 補助の起動と見張り`

### Task 5: 誰宛てかの状態機械（純粋）

**Files:**
- Create: `packages/server/src/voice/addressee.ts`、`addressee.test.ts`

**Interfaces:**
- Produces: `type AddrInput = { kind: 'segment'; text: string; at: number } | { kind: 'holdStart' | 'holdEnd' | 'toggleOn' | 'toggleOff'; at: number } | { kind: 'replied'; at: number } | { kind: 'meeting'; on: boolean; at: number } | { kind: 'tick'; at: number }`
- Produces: `type AddrOutput = { send?: { text: string; origin: OrchestratorOrigin }; stopSpeaking?: boolean; phase: VoicePhase }`、`VoicePhase = 'off' | 'ambient' | 'listening' | 'window' | 'meeting'`（shared の `voice.ts` に置く）
- Produces: `function addressee(state: AddrState, input: AddrInput, cfg: { mode: VoiceMode; callReading: string; speaking: boolean }): [AddrState, AddrOutput]`、`initialAddrState(): AddrState`。値は「誰宛てかの決まり」のとおり（呼ばれた後 8000 ms、窓 10000 ms）。

- [ ] 試験（Review Focus 1、4、5 を含む）：`ambient speech is never sent`、`call word with rest sends voice-called without the call word`、`call word alone opens 8s then next segment is voice-called`、`window opens only after a strong turn reply and lasts 10s`、`no window after a window turn reply`、`meeting closes an open window and ignores call word`、`held joins segments in order and sends once`、`toggle first is strong, rest is weak`、`stop word while speaking stops and does not send`、`ねぇ、はんがー` と `ねーハンガー` も呼ばれたとみなす、`ハンガーにかけといて` は呼ばれない。
- [ ] 実装して通す。Commit `feat(voice): 誰宛てかの状態機械`

### Task 6: 声のサービスと口（つなぎ）

**Files:**
- Create: `packages/server/src/voice/service.ts`、`service.test.ts`、`packages/server/src/http/routes/voice.ts`、`voice.test.ts`
- Modify: `packages/server/src/http/routes/orchestrator.ts`（送る中身を `sendToOrchestrator(deps, text, origin)` に切り出し、route とサービスで使う）
- Modify: `packages/shared/src/events.ts`（`{ type: 'voice.state'; state: VoiceStateDto }`）、`packages/shared/src/voice.ts`
- Modify: 設定（`SettingsDto` に `voice?: { mode: VoiceMode; personaId: string; personas: VoicePersona[]; asrModel?: string }`）。`VoicePersona = { id; name; reading; tone; voice: string; speed: number }`（`voice` は `os:<識別子>` か `kokoro:<声>`）。既定は 1 件 `{ id: 'default', name: 'ハンガー', reading: 'はんがー', tone: '', voice: 'os:com.apple.voice.compact.ja-JP.Kyoko', speed: 1.2 }`（Task 2b が通れば `kokoro:jf_alpha`）。
- Modify: 統括の指示文（`shared/src/i18n/*/launch.ts`）に、人格の名前と口調を足す口（口調が空なら何も足さない）。
- Modify: `docs/design.md`「統括」「机の音声」の節。

**Interfaces:**
- Consumes: Task 3〜5。
- Produces: `GET /api/voice` → `VoiceStateDto = { available: boolean; models: { state; progress }; mode: VoiceMode; phase: VoicePhase; caption: string | null; speakingId: string | null; meeting: boolean }`。`POST /api/voice/hold {on:boolean}`、`POST /api/voice/toggle {on:boolean}`、`POST /api/voice/speak {id,text}`、`POST /api/voice/stop`、`POST /api/voice/prepare`。補助が使えないときは `available:false` で、動かす口は 409。
- 振る舞い：mode が `always` か、hold・toggle が入っている間だけ `listen on`。字幕（caption）は聞き取った区間の文を、送ったら 2 秒で消す。統括の返答の到着は、統括の会話の `transcript.appended` を見て `replied` を入れる。ヒントは会話の一覧が変わったら作り直して送る。

- [ ] 試験：偽の補助と偽の送り先で、呼びかけ語つきの区間が `voice-called` で 1 回送られる。`dbfs -50` の区間は送られない。補助が無い環境で `/api/voice` が `available:false`、`/api/voice/speak` が 409。`speak` が `speechText` を通した文と人格の声・速さで補助に渡る。
- [ ] 実装して通す。`npm run typecheck`、`npm test`。Commit `feat(voice): 声のサービスと口`

### Task 7: 同梱と build

**Files:**
- Create: `apps/desktop/src-tauri/tauri.macos.conf.json`（`bundle.resources` に `"../voice-dist": "voice"` を足す）
- Create: `apps/desktop/scripts/build-voice.sh`（`apps/voice-mac/scripts/build.sh` を呼び、`apps/desktop/voice-dist/` へ写す。`HANGAR_SKIP_VOICE=1` なら空の束（README だけ）を置く）
- Modify: `apps/desktop/package.json` の `build-mac-local` と tauri の `beforeBuildCommand`、`apps/desktop/src-tauri/src/server.rs`（`HANGAR_VOICE_BIN` を `dir.join("voice/hangar-voice")` が在るときだけ渡す）、`apps/desktop/scripts/sign-macos.ts`（入れ子の実行ファイルにも署名する）
- Modify: `.github/workflows/ci.yml`（desktop と update のジョブは `HANGAR_SKIP_VOICE=1`。`voice-mac` ジョブで Metal Toolchain を入れて `build.sh` まで通す）、`.github/workflows/release.yml`（macos ジョブで Metal Toolchain を入れ、本物の補助を作る）
- Modify: `docs/dev-procedures.md`（手元の build に Metal Toolchain が要ること）

- [ ] 確かめ：`build-mac-local` で作った .app の `Contents/Resources/voice/hangar-voice` が起動し、`codesign --verify --deep` が通る。補助の無い build でアプリが起動し、`/api/voice` が `available:false`。
- [ ] Commit `build(voice): 補助を Mac の .app に入れる`

### Task 8: 画面（試作 A）

**Files:**
- Create: `packages/ui/src/voice/hangarVoicePort.ts`、`hangarVoicePort.test.ts`（`VoicePort` をサーバの口で実装。`canListen` は `available`）
- Create: `packages/ui/src/views/primitives/VoicePill.tsx`、`VoicePill.test.tsx`
- Modify: `packages/ui/src/views/OrchestratorPillar.tsx`（補助が使えるときは MicButton の代わりに VoicePill）
- 見本：scratchpad の `proto/voice-states.html` の A（状態は 切・周りの声・呼ばれて聞く・送る直前・窓・会議）。動きは `motionKit.ts` の決まった動きにそろえる。

**Interfaces:**
- Consumes: `voice.state` の事象と `/api/voice/*`。
- 振る舞い：丸を押して離す（350 ms 未満）で toggle、押し続けると hold（離して送る）。字幕は丸が横に伸びて流す。モデルを落としている間は丸の縁を進みで満たす（文字は出さない）。

- [ ] 試験：`available:false` なら今の MicButton が出る。押し続けて離すと `/api/voice/hold` が on→off で呼ばれる。短く押すと toggle。`phase` ごとに `data-phase` が変わる。
- [ ] 実装、試験、`npm run typecheck`、`npm test`、実データに重ねて WebKit で撮って目で見る。Commit `feat(ui): 統括の声の丸（試作 A）`

## 段 2 に入れないもの（次へ回す）

- 設定の人格の欄の画面と、常に聞くの切り替えの画面（試作で選んでから。それまでは `settings.json` の `voice` で変える）。
- VOICEVOX・AivisSpeech の声の出どころ（設定の画面と一緒に）。
- ショートカット（殻の全体のキー）、Windows、「今のなし」。
