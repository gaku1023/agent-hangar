# リリースの手順

タグを打つと `.github/workflows/release.yml` が走り、macOS の dmg と zip、Windows のインストーラ、自動更新の目録を GitHub の Release に置く。
ここには、版の決まりと、試しの版（rc）を打って確かめて消すまでの手順を書く。
署名は `docs/signing.md`、仕組みは `docs/design.md` の「配布と運用」にある。

## 版の決まり

版はリポジトリのファイルで上げ、タグはその版を名指すだけにする。
タグから版を決めて build に渡すことはしない。
版の在りかは次の 5 つで、`apps/desktop/scripts/release-plan.ts` の `VERSION_FILES` が正である。

- `apps/desktop/src-tauri/tauri.conf.json` の `version`（アプリが名乗る版で、更新の比べ方もこれを使う）
- `apps/desktop/package.json` の `version`
- `apps/desktop/src-tauri/Cargo.toml` の `[package]` の `version`
- `apps/desktop/src-tauri/Cargo.lock` の `hangar-desktop` の項
- `package-lock.json` の `apps/desktop` の項

5 つは `npm run set-version -w apps/desktop -- <版>` でまとめて書き換える。
5 つがそろっていなければ、ふだんの試験（`apps/desktop/test/release-plan.test.ts`）が落ちる。
release.yml の最初の plan ジョブが、タグと 5 つを照らし、1 つでも違えば何も作らずに止まる。

タグは `v<semver>` で、ビルドメタデータ（`+`）は付けない。
更新の比べ方（semver）は `+` を見ないので、`+` だけが違う版は更新として見つからないからである。

## 試しの版（rc）

タグに `-` が入っていれば（`v0.2.0-rc.1` など）試しの版である。
プレリリースの部分は `rc.1`、`rc.2` のように点で区切った数にする（`rc.10` が `rc.9` より新しくなる）。

- Release は prerelease で作り、Release の最新（Latest）にしない。
- アプリには、更新の目録の取り先を「試しの道」に替えて焼き込む（`apps/desktop/src-tauri/tauri.prerelease.conf.json`）。
- 試しの道は、固定のタグ `updater-prerelease` の Release（prerelease）に置いた `latest.json` である。
  release.yml は、試しの版でも正式な版でも、その版が今の目録より新しいか同じときだけ、この目録を置き換える。
- 安定版の道は、Release の最新の `latest.json` である。prerelease は Release の最新に入らないので、安定版の利用者に試しの版は届かない。
- 試しの版の利用者は、次の rc も、その後の正式な版も、試しの道から受け取る。
  試しの道を抜けるには、正式な版の dmg かインストーラを手で入れ直す。

macOS の `Info.plist` の版は `0.2.0-rc.1` のまま入る（2026-10-10 に手元の build で確かめた）。
Windows のインストーラのファイルの版（`VIProductVersion`）は数字の 4 つ組なので `0.2.0.0` になる。
アプリの設定の更新の節と、更新の比べ方は、どちらの OS でも `0.2.0-rc.1` である。

## rc を打つ

1. 版を上げる PR を作る。
   `npm run set-version -w apps/desktop -- 0.2.0-rc.1` を走らせ、5 つのファイルの差分だけをコミットして PR にする。
   CI が緑になったらマージする。
2. main のそのコミットにタグを打って push する。

   ```bash
   git fetch origin
   git tag v0.2.0-rc.1 origin/main
   git push origin v0.2.0-rc.1
   ```

3. Actions の release が、plan、macos、windows、windows-upload、updater-manifest のすべてで緑になるのを待つ。
   plan が落ちたら、版を上げる PR が入っていない。タグを消し（下の「消す」）、PR を入れてから打ち直す。

## 確かめる

- Release に Pre-release の印があり、Latest でないこと。
  `gh api repos/<owner>/<repo>/releases/latest -q .tag_name` が、前の正式な版のままであること。
- 資産がそろっていること：`Hangar-v0.2.0-rc.1-macos-arm64.dmg` と `.zip`（それぞれ `.sha256`）、`Hangar-v0.2.0-rc.1-windows-x64-setup.exe`（`.sha256`）。
  署名鍵の secret があれば、`.app.tar.gz` と各 `.sig` と `latest.json` も。
- `updater-prerelease` の Release の `latest.json` の `version` が `0.2.0-rc.1` で、その Release も Pre-release であること。
- 実機で、Mac に dmg を、Windows 11 にインストーラを入れ、設定の更新の節の版が `0.2.0-rc.1` であること。
- 自動更新：rc.1 を入れた機械を残したまま、同じ手順で rc.2 を出す。
  設定の「更新を確認」で `0.2.0-rc.2` が見つかり、ダウンロードしてインストールし、再起動のあとの版が `0.2.0-rc.2` であること。
  tmux（Windows は psmux）の中のセッションが止まっていないことも見る。

## 消す

試しが済んだ rc の Release は、タグと一緒に消す。

```bash
gh release delete v0.2.0-rc.1 --cleanup-tag --yes
```

試しの道の目録が消した rc を指したままだと、試しの版の利用者の更新は取得で失敗する。
rc をすべて消すときは、試しの道の Release も消す（次の release が作り直す）。

```bash
gh release delete updater-prerelease --cleanup-tag --yes
```

手元に残ったタグは `git tag -d v0.2.0-rc.1` で消す。
main の版は rc のままでよく、正式な版を出すときに `npm run set-version -w apps/desktop -- 0.2.0` の PR を入れてから `v0.2.0` を打つ。
