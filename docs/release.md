# リリースの手順

タグを打つと `.github/workflows/release.yml` が走り、macOS の dmg と zip、Windows のインストーラ、自動更新の目録を GitHub の Release に置く。
ここには、版の決まりと、試しの版（rc）を打って確かめて消すまでの手順、正式な版のリリースノートの書き方と、出す前と出した後に確かめることを書く。
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

## release.yml の流れ

ジョブは plan、macos、windows、windows-upload、publish、channel の順に回る。

- plan は、次のどれかに当たれば何も作らずに止まる。
  - タグと版の在りかの 5 つが食い違う。
  - タグのコミットが `origin/main` の祖先でない（main に入っていないコミットにタグを打った）。
  - そのコミットへの main の push で走った ci（`ci.yml`）のいちばん新しい run が、成功で終わっていない。走っている途中でも止まる。
  - 本家のリポジトリで、署名の secret（`HANGAR_SIGN_P12_BASE64` か `TAURI_SIGNING_PRIVATE_KEY`）が無い。正式な版も試しの版も止まる（`docs/signing.md`）。fork では警告を出して、署名せずに続ける。
  - 正式な版で、Release の本文（`docs/release-notes/<版>.md`）が無いか空である（下の「正式な版を出す」）。
- macos ジョブが Release を下書き（draft）で作り、最新にしない。windows-upload が Windows のインストーラを、publish が更新物と署名と目録（`latest.json`）を、その下書きに添える。
- publish は最後の段で、資産がそろったことを確かめてから Release を公開し、正式な版なら Release の最新にする。
  途中のジョブが落ちたら、Release は下書きのまま残り、利用者には見えない。直してから、Actions の画面で失敗したジョブを Re-run すれば、続きから公開される。
- channel は、公開の後で試しの道の目録を置き換える（下の「試しの版（rc）」）。
  タグの run が重なっても、channel ジョブは 1 本ずつ走る。3 本以上重なると、待っていた古いほうは取り消されるので、そのときは取り消された run の channel ジョブだけを Re-run する。

### 関門で止まったとき

plan が ci の結果で止まったら、次の順で回復する。

1. 止まった理由が `cancelled` か `failure` なら、Actions の ci の画面で、そのコミットへの main の push の run を開き、Re-run する（`failure` なら失敗したジョブだけでよい）。
   揺れる試験で落ちたのでなければ、直す PR を入れてから、その新しいコミットにタグを打ち直す。
2. その run が緑になるのを待つ。関門は同じコミットの run のうち、いちばん新しいもの（回し直したものを含む）を見る。
3. release の run を開き、失敗したジョブ（plan）を Re-run する。plan が通れば、続きのジョブが走る。

`ci.yml` の concurrency は、main への push を 1 つの group（ref ごと）にし、走っている run は打ち切らない（`cancel-in-progress` は `false`）。
GitHub は、`cancel-in-progress` が `false` でも、同じ group で待っている run を新しい run が来たときに取り消すので、続けて入れたコミットのうち、途中のものの ci は `cancelled` になる。
タグは、ci が緑になった main のコミットに打つ。`cancelled` のコミットに打つときは、上の 1 から回す。

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
  正式な版を受け取った時点で試しの道を抜け、以後は rc を受け取らない。

macOS の `Info.plist` の版は `0.2.0-rc.1` のまま入る（2026-10-10 に手元の build で確かめた）。
Windows のインストーラのファイルの版（`VIProductVersion`）は数字の 4 つ組なので `0.2.0.0` になる。
アプリの設定の更新の節と、更新の比べ方は、どちらの OS でも `0.2.0-rc.1` である。

## rc を打つ

1. 版を上げる PR を作る。
   `npm run set-version -w apps/desktop -- 0.2.0-rc.1` を走らせ、5 つのファイルの差分だけをコミットして PR にする。
   CI が緑になったらマージする。
2. main のそのコミットの ci が緑になってから、そのコミットにタグを打って push する。
   ci がまだ走っているうちに打つと plan が止まる。そのときは ci が緑になってから release を Re-run する。

   ```bash
   git fetch origin
   git tag v0.2.0-rc.1 origin/main
   git push origin v0.2.0-rc.1
   ```

3. Actions の release が、plan、macos、windows、windows-upload、publish、channel のすべてで緑になるのを待つ。
   plan が版の食い違いで落ちたら、版を上げる PR が入っていない。
   plan の前に Release は作られないので、`gh release delete` ではなく、リモートのタグを直に消す（`git push origin :refs/tags/v0.2.0-rc.1`。手元のタグは `git tag -d` で消す）。
   PR を入れてから打ち直す。

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
main の版は rc のままでよく、正式な版を出すときに `npm run set-version -w apps/desktop -- 0.2.0` の PR を入れてから `v0.2.0` を打つ（次の節）。

## 正式な版を出す

rc と同じ手順で、版を上げる PR を入れてから `v0.2.0` を打つ。
Release の本文は `docs/release-notes/<版>.md`（`0.2.0.md` など）で、ファイルの中身がそのまま本文になる。
タグを打つ前に、この本文を仕上げて main に入れておく（版を上げる PR に含めてよい）。
macos ジョブが下書きの Release を作るときに、plan が決めたこのファイルを本文にする（`softprops/action-gh-release` の `body_path`）。
GitHub の自動生成の変更の一覧は付けない。
試しの版（rc）の本文は、今までどおり GitHub の自動生成である。

正式な版で、このファイルが無いか空なら、plan が何も作らずに止まる。
自動生成に落とさずに止めるのは、正式な版は公開と同時に Release の最新になり、PR の一覧が本文のまま利用者に見えてしまうからである。
止まったら、本文の PR を入れ、そのコミットにタグを打ち直す（上の「rc を打つ」の 3 と同じく、リモートのタグを直に消してから）。
本文はタグのコミットから読むので、タグを打ち直さずに release を Re-run しても通らない。

同じファイルは、アプリの中の 3 か所にも出る（設計書の「リリースノート」）。

- ビルドのときにアプリへ同梱し、設定の「更新」の節の履歴と、更新したあとの「更新しました」の札に出す。
- publish ジョブが目録（`latest.json`）の `notes` にも入れ、上げる前の「更新あり」の札に出す。

書き方は次の「リリースノートを書く」、タグの前後に見るものは「出す前に確かめること」と「出した後に確かめること」にある。

### 公開した後に直せるもの、直せないもの

- Release の本文は、手で差し替えられる。

  ```bash
  gh release edit v0.2.0 --notes-file docs/release-notes/0.2.0.md
  ```

- アプリに同梱した本文は、その版のアプリの中では直らない。直した md は、次の版のアプリに入る。
- 目録の `notes` は、publish が作った時点のまま残る。差し替えるには、目録を作り直して添え直すしかない。
- だから、注意（下の「更新の前に」）の書き漏れは、公開した後では、上げる前の人に届かない。タグを打つ前に「出す前に確かめること」を通す。

## リリースノートを書く

### 読み手と長さ

- 読み手は、hangar を使っている人であり、開発者ではない。何ができるようになったか、何が直ったか、上げる前に何をするかを、使う側の言葉で書く。
- アプリは、開いた版に注意と要点だけを出し、本文は「全文を読む」で出す。だから、要点だけを読んで分かるように書く。
- 長さの目安は、1 項目が見出しと 2〜3 行、全体で 60 行ほどまでである。0.6.1 は 210 行あり、アプリの中で読むと長すぎた（2026-10-17）。
- 細部（設定の場所の細かい道筋、例の全部、直した仕組みの説明）は、要るものだけにする。仕組みは設計書に書き、ノートには書かない。

### 形

アプリは次の形を前提に、注意と要点を拾う（`packages/ui/src/lib/releaseNotes.ts`）。

```md
# Hangar 0.2.0

## 更新の前に

ほかの PC や Worker とそろえる必要があることを、最初の段落に一言で書く。

1. 手順は番号付きで続ける。

## 足したこと

### 一つの機能を、利用者に見える形で一言（見出しが要点になる）

- 細部を 2〜3 行。

## 直したこと

- 何が起きていたかを、最初の 1 文で言い切る。続けて、いまはどうなるか。
```

- 1 行目は `# Hangar <版>`。アプリはこの行を外して出す。
- 注意の節の見出しは `## 更新の前に` にする。札はその最初の段落を黄色い地で先頭に出すので、最初の段落だけで何をすればよいかが分かるようにする。
- 足したことと直したことは `## 足したこと`、`## 直したこと` などの節に分け、項目を `### 見出し` か箇条書きにする。
  札は、小見出しか、箇条書きの各項目の最初の 1 文を、上から 3 つ拾う。大事なものから並べ、各項目の最初の 1 文で言い切る。
  見出しが文になっている節（「〜できるようになりました」）は、見出しそのものが要点になる。
- 最初の見出しより前の段落（前書き）は、要点にも注意にも使わない。前書きは 1〜2 行にとどめる。
- ファイルの頭に、作業のための書き込み（「これは下書きです」など）を残さない。そのまま公開される。

### 「更新の前に」を書くとき

次のどれかに当たる版には、必ず `## 更新の前に` を書く。

- 互換の版番号（`packages/shared/src/compat.ts` の `COMPAT_VERSION`、Worker の `MIN_DEVICE_COMPAT`、端末の `MIN_WORKER_COMPAT`）を上げた。
  下限を上げたなら、古い相手とは同期が止まる。どの順で上げればよいか、止まっている間に何が出るかを書く。
- Worker の入れ替え（clone した場所での `setup cloud` のやり直し）が要る。
  入れ替えなくても PC と同期が動き、スマホの新しい画面など一部が届かないだけなら、注意ではなく別の節（「スマホの新しい画面を使うには」など）に任意として書く（0.9.2 の例）。
- DB の版（`packages/server/src/db/migrations.ts`）が上がる。上げた後は前の版に戻せないことを書く。
- 同期しているすべての PC を同じ版にそろえないと、データの一部がクラウドから落ちることがある（0.7.0 の例）。
- 利用者が手で何かをする必要がある（権限の取り直し、設定の直しなど）。

目録の `notes` には最新の版のノートしか入らないので、版を飛ばして上げる人には、間の版の「更新の前に」が上げる前には届かない。
前の版の注意がまだ効いているなら、新しい版の「更新の前に」にも短く繰り返すか、前の版のノートへのリンクを置く（0.7.2 の例）。

### 書かないもの

- PR の番号、コミット、作業の経緯。使う側には要らない。
- 公開リポジトリなので、手元の環境の名前やパス、実際の使用量や費用、ほかのプロジェクトの名前、個人の統計。

## 出す前に確かめること

タグを打つ前に、版を上げる PR の中で次を確かめる。

- 前の正式な版から入った PR を洗い出し、利用者に見える変更が全部ノートにあること（`git log v<前の版>..origin/main --merges --oneline`）。
- 上の「更新の前に」を書くときに当たる変更が無いか。互換の版、DB の版、Worker の変更は、前の版のタグからの差分で該当のファイルを見る。
- Worker の入れ替えが要るなら、Worker の側の変更も同じタグに入っていること（Worker は `apps/desktop/package.json` の版を名乗る）。
- ノートの形（上の「形」）が守られていて、札に拾わせたい要点が、各節の上から 3 つに入っていること。

## 出した後に確かめること

- Release が Latest で、本文がノートのとおりであること。
- 安定版の道と試しの道の `latest.json` の `version` が新しい版で、`notes` にノートが入っていること。

  ```bash
  gh release download v0.2.0 -p latest.json -O - | node -e 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(m.version, m.notes.split("\n")[0])'
  ```

- 前の版のアプリで「更新を確認」すると、「更新あり」の札に要点と（あれば）注意が出ること。上げたあと初めて開いたときに、「更新しました」の札が出ること。
