# hangar-voice

Mac の端末の中で、聞き取り、区切り、読み上げ、会議の見張りを行う補助です。
hangar のサーバが子のプロセスとして起こし、標準入出力の 1 行 1 JSON で話します。
約束（cmd と ev）は `Core/Sources/VoiceCore/Protocol.swift` と、`docs/superpowers/plans/2026-11-16-orchestrator-voice-stage2.md` の「補助とサーバの約束」にあります。

macOS 14 以上の Apple Silicon で動きます。

## 作り方

```bash
xcodebuild -downloadComponent MetalToolchain   # 初回だけ
apps/voice-mac/scripts/build.sh
```

`apps/voice-mac/dist/` に、実行ファイル `hangar-voice` と、隣に要る束（`mlx-swift_Cmlx.bundle` など）がそろいます。
MLX の Metal のシェーダは xcodebuild でしか束に入らないので、`swift build` の実行ファイルでは動きません。
束は実行ファイルと同じフォルダに置いたまま動かします。

build の中間物（DerivedData）は `~/Library/Caches/agent-hangar/voice-mac-xcode` に置き、どの worktree からの build でも使い回します。
MLX をゼロから作ると数分かかるためです。置き場は `HANGAR_VOICE_DERIVED` で変えられます。
xcodebuild はソースの場所が変わると Swift のモジュールを作り直すので、`build.sh` はソースも同じ置き場の `src/` へ写してから作ります。
2 つの build が重なったときは、後の方が先の終わりを待ちます。
Xcode の compilation caching（`COMPILATION_CACHE_ENABLE_CACHING=YES`）も入れています。CI がキャッシュから戻した中間物は inode が変わり、それだけで Swift のモジュールが作り直しになるためです。compilation caching は中身の指紋で引くので、戻した後でも当たります。
CI は、main の push で作った中間物を Actions のキャッシュに保存し、PR とリリースはそれを戻して使います（`.github/workflows/ci.yml` の voice-mac ジョブ）。
PR では、`apps/voice-mac` が変わったときだけ Release の build を回します。

## .app への同梱

Mac の .app では `Contents/Resources/voice/` に入ります（`apps/desktop/src-tauri/tauri.macos.conf.json`）。
tauri build の前に `apps/desktop/scripts/build-voice.sh` が `scripts/build.sh` を呼び、`dist/` の中身を `apps/desktop/voice-dist/` へ写します。
そのため、手元で .app を作るときも Metal Toolchain が要ります。
`HANGAR_SKIP_VOICE=1` を立てると補助を作らず、補助の無い .app になります（CI の .app の試験はこれで作ります）。
殻は `voice/hangar-voice` が在るときだけ、その場所を `HANGAR_VOICE_BIN` でサーバへ渡します。
署名の台本（`apps/desktop/scripts/sign-macos.ts`）は、補助と束も .app と同じ身元で署名します。

芯（VoiceCore）は MLX に依らない別のパッケージ（`Core/`）に分けてあり、試験は MLX を作らずにモデルなしで回ります。

```bash
swift test --package-path apps/voice-mac/Core
```

## モデル

モデルは同梱しません。
初めて使うとき（`prepare`、または聞き取りの始まり）に Hugging Face のキャッシュ（`~/.cache/huggingface/hub/mlx-audio/`）へ落とします。

- 認識：`holotherapper/lilfugu-8bit`（環境変数 `HANGAR_VOICE_ASR` で変えられる）
- VAD：`mlx-community/silero-vad`
- 読み上げ：`mlx-community/Kokoro-82M-bf16`（声が `kokoro:<声>` のとき）

起動したとき、キャッシュに無いモデルがあれば `{"ev":"models","state":"missing"}` を出します。

## 読み上げの声

`speak` の `voice` は次の 4 つの形です（style は非負の整数）。

| voice | 鳴らし方 |
| --- | --- |
| `kokoro:<声>` | Kokoro（モデルは同梱せず初回に落とす） |
| `os:<識別子>` | この Mac の AVSpeechSynthesizer |
| `voicevox:<style>` | VOICEVOX のエンジンへ HTTP で合成を頼む（既定 `http://127.0.0.1:50021`） |
| `aivis:<style>` | AivisSpeech のエンジンへ同じく（既定 `http://127.0.0.1:10101`） |

エンジンの口は環境変数 `HANGAR_VOICEVOX_URL`・`HANGAR_AIVIS_URL` で替えられます。
ホストが 127.0.0.1 か localhost 以外なら使わず、既定へ戻します。
エンジンは同梱しません。
合成は `POST /audio_query` の応答の `speedScale` を速さで上書きし、`POST /synthesis` で WAV を受けます。
HTTP は 10 秒で諦めます。
鳴らすのは Kokoro と同じ出力の経路なので、ダッキングと `speaking` の start・end・stopped は同じ形で出ます。
エンジンが落ちている、遅い、壊れた応答のときは `{"ev":"error","code":"engine","message":"…"}` を出し、`speaking` を end で閉じます。
補助は落ちません。

`{"cmd":"voices"}` を送ると、この Mac の ja-JP の声が返ります。

```json
{"ev":"voices","os":[{"id":"com.apple.voice.compact.ja-JP.Kyoko","name":"Kyoko"}]}
```

## ファイルを渡して試す

マイクとスピーカーを使わずに確かめられます。

```bash
# wav をマイクの代わりに実時間で流す。流し終わると区間を閉じ、flushed を出して終わる。
echo '{"cmd":"hints","context":"hangar,Codex,opencode"}' \
  | apps/voice-mac/dist/hangar-voice --input-file sample.wav

# 読み上げを鳴らさずに <dir>/<id>.wav に書く。
printf '%s\n' '{"cmd":"speak","id":"a1","text":"了解しました。","voice":"os:com.apple.voice.compact.ja-JP.Kyoko","speed":1.0}' \
  | apps/voice-mac/dist/hangar-voice --speak-to-file /tmp/hv-out
```

`speak` は前の読み上げを止めるので、続けて読ませるときは `{"ev":"speaking","state":"end"}` を待ってから次を送ります。
標準入力が閉じると終わります（`--input-file` のときは流し終わりまで待ちます）。

## 決まり

- 標準出力は約束の行だけです。ライブラリの出力と記録は標準エラーに出ます。
- `segment` の `ms` は区間の音の長さ、`dbfs` は声の枠の平均の音量です。認識の文が空の区間は出しません。
- 区切りの値（Silero の 512 サンプルの枠、0.5 以上が 2 枠で始まり、前の 300 ms、無音 700 ms、30 秒まで）は `Core/Sources/VoiceCore/Segmenter.swift` の既定です。
- マイクの取り込みは AVAudioEngine の voice processing を通し、他のアプリの音の絞りは最小にします。読み上げも同じエンジンから鳴らし、回り込み消しの参照に入れます。
- `micUsers` は、自分と `com.apple.CoreSpeech` を除いたマイクを使っているプロセスの束の識別子です（無ければ `pid:<番号>`）。1 秒ごとに見て、変わったときだけ出します。
- Kokoro に渡す文の処理は `Models.kokoroTextProcessor` です。既定は `JapaneseKokoroProcessor` で、CFStringTokenizer で語に分けて読みを取り、かなの表（`Core/Sources/VoiceCore/KanaPhonemes.swift`、misaki の表を移したもの）で音素にします。
- 英字の語は、大文字だけで 4 字までの語を文字の名前で読み（PR → ピーアール）、ほかは英語の G2P（`beshkenadze/kitten-tts-g2p`、Kokoro の読み込みのときに落とす）に回します。落とせないときは英字をそのまま渡します。
