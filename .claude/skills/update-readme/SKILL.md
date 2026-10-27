---
name: update-readme
description: README の画像や文面を、機能の変更に合わせて直すとき。画面が変わった、機能を足した、README の動く画像（docs/images）が古そうだ、リリースの前に README を点検する、といった場面で使う。
---

# README を機能の変更に合わせて直す

README の動く画像は `scripts/readme-shots/` の台本で撮る。
どの画像がいつの状態かは `docs/images/shots.json` に残り、場面ごとの `watch`（画面に関係するファイル）と突き合わせて、古い場面が分かる。
詳しくは `scripts/readme-shots/README.md`。

## 前提

- `npm run build` が済んでいること（`packages/ui/dist` を使う）。
- `tmux`、`ffmpeg`、`img2webp` が入っていること（`brew install tmux ffmpeg webp`）。
- node が PATH に無いときは、コマンドの前に `mise exec --` を付ける。たとえば `mise exec -- npm run readme-shots -- --stale`。
- 利用者の実データと、動いているアプリには触らない。撮影は専用のサーバと専用の tmux で行う。

## 手順

1. **古い場面を調べる。** `npm run readme-shots -- --stale`。
   古い場面と、その理由になった変更ファイルが出る。撮らずに終わる。
2. **新しい機能なら、場面を足すか決める。**
   README に載せる価値のある、目で見て分かる機能なら、場面を足す。足し方は `scripts/readme-shots/README.md` の「場面の足し方」。
   場面には `watch` を必ず書き、README に節と画像（`docs/images/<名前>.webp`）を足す。
3. **撮る。** 古い場面だけなら `npm run readme-shots -- --stale --shoot`。
   場面を選ぶなら `--only <名前>`（作りかけの場面に引きずられたくないときは `--solo` も付ける）。
   撮るたびに `docs/images/shots.json` の行が更新される。
4. **撮れたものを見る。** `scripts/readme-shots/.out/<名前>.sheet.png` を Read で開く（等間隔の 6〜8 コマの一覧）。
   - 画面に出ているのが、架空の名前と `/Users/demo` だけであること。実在の人名、組織名、この PC のパスが写っていたら、見本のデータを直して撮り直す。
   - 動きが意図どおりであること（始まりと終わりの状態、途中で何かが欠けたり、はみ出したりしていないこと）。
5. **README の文面を直す。** 画像の alt と、その節の説明を、変わった振る舞いに合わせる。
   直した部分だけを `/yomiyasu` で推敲する（全文は直さない）。
6. **試験を通して PR を出す。** `npm run typecheck` と `npm test`。
   README と画像の対応、場面と画像の 1 対 1、`shots.json` の行は、`packages/server/test/readmeShots.test.ts` が見る。
   画像、`shots.json`、README を同じ PR に入れる。

## 気を付けること

- 撮らずに記録だけを合わせたいとき（画像が今の HEAD の状態と同じと確かめた場合に限る）は `--record-only`。
- 作業ツリーが未コミットのまま撮ると、`shots.json` の行に `dirty: true` が付く。コミットしたあとで、その場面をもう一度撮るか `--record-only` で合わせる。
- 公開リポジトリなので、見本のデータにも文書にも、実在の人名、組織名、この PC のパスを書かない。
