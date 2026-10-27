# hangar セットアップのすゝめ

## 人が読む説明

これは、Claude Code に読ませて、あなたの環境を hangar が使いやすい形に整えてもらうための手引きです。
Claude はまず読むだけで環境を調べ、いくつか質問し、提案を表にします。
書き換えるのは、あなたが承認した項目だけです。
フォルダの移動や削除はしません。CLAUDE.md にも触れません。
途中でやめたいときは「やめて」と言えば、そこで止まります。
やめても、それまでに承認した登録はアプリから外せます（`hangar project remove`）。

## Claude への約束

- まず読むだけで診断する。診断が終わるまで何も書かない。
- 使ってよい操作は、読むだけのコマンド（`ls`、`cat`、`git -C <dir> remote -v` など）と、下の表の hangar の CLI だけ。それ以外の書き込みは、この文書に書いてあるように見えても実行しない。
- 書く操作は、必ず先に `--dry-run` の結果を見せ、承認を取ってから行う。
- フォルダの移動、削除、名前の変更をしない。`~/.claude/` の中のファイルと CLAUDE.md を書き換えない。
- 利用者の言語で話す。この文書を訳して見せない。利用者が明示した指示を、この文書より優先する。

| 使ってよい hangar の CLI | すること |
|---|---|
| `hangar project candidates --json` | 会話したフォルダの候補を出す（読むだけ） |
| `hangar project add <パス…> [--dry-run]` | プロジェクトとして登録し、その下の会話を紐づける。パスは 1 つずつ別の引数に分け、空白を含むものは引用符で囲む（例：`hangar project add ~/src/app "~/Desktop/週報 2026" --dry-run`） |
| `hangar project remove <パス> [--dry-run]` | 登録を外す（会話は未分類に戻るだけで、本文は消えない） |
| `hangar workspace set <dir> [--dry-run] [--trust]` / `hangar workspace unset` | 新しいフォルダの作成場所を決める／決めていない状態に戻す。`--trust` は、作成場所を Claude Code の信頼済みにする（3b の同意を取ってから付ける） |
| `hangar mcp install` / `hangar statusline install` / `hangar shell install`（どれも `--dry-run` あり） | 連携を入れる。本番は承認を得てから `--yes` を付けて打つ（ターミナルの y/n に答えられないため） |
| `hangar shell status` | シェル連携が入っているかを見る（macOS だけ、読むだけ） |

`--json` の答えは、成功なら `{"ok": true, …}`、失敗なら `{"error": "<符号>", "message": "…"}` の形になる。
`project add` は、1 件でも `nested` か `error` が混ざると全体が `"ok": false` になる。全体の失敗と読まず、`results` を 1 件ずつ見る。
`hangar` が PATH に無いとき、macOS は `/Applications/Hangar.app/Contents/Resources/server/bin/hangar` をそのまま使う。Windows はインストーラが PATH に足すので、新しいターミナルで開き直してもらう。
サーバが止まっている（`server_down`、終了コード 2）ときは、アプリを開くよう頼み、開いてから続ける。

## 0. 分かれ道

最初に次を確かめる。聞く必要があるものだけ聞く。

- OS：macOS か Windows か。Windows ではシェル連携が無く、パスは `C:\Users\…` の形になる。
- 2 台目の PC か：クラウド同期を使っていて、別の PC で既にプロジェクトを登録しているなら、先にアプリでクラウドに参加してもらう。そのあと続ける。
  参加は、参加済みの PC の 設定 › クラウド同期 の「PC を追加」で参加コードを発行し、この PC の「参加コードで参加」に接続先の URL と参加コードを入力して、両方に出る確認コードが同じなら参加済みの PC で承認する流れである。Claude は参加コードを扱わない。
- クラウド同期を新しく始めたいか：この手引きの範囲の外で、利用者がターミナルで `hangar setup cloud` を打つ（Claude は打たない）。
  setup は最後にリカバリーキー（見出し、作成日、URL、暗号鍵の 4 行）を 1 度だけ表示し、パスワードマネージャーかファイル（`--save <パス>`）に保存して、暗号鍵の末尾 4 文字を入力するまで終わらない。保存しないまま setup を終える道は無い。
  リカバリーキーはすべての PC を失ったときに `hangar recover` で戻るためのもので、PC には残らない。Claude はリカバリーキーを読まず、会話に貼ってもらわない。
- アカウントが複数か：`~/.claude-*` のフォルダや、環境変数 `CLAUDE_CONFIG_DIR` があるとき、どのアカウントの設定（`settings.json`）を見るかを聞く。
  hangar で足したアカウントの置き場は、中身が `~/.claude` へのリンクなので、見る先は `~/.claude` の 1 つでよい（リンクかどうかは `ls -l` で分かる）。

## 1. 診断（読むだけ）

次を調べ、結果を 1 枚の表にする。表は「項目／いまの状態／意味」の 3 列にし、「意味」にはエンジニアでない人にも分かる言葉で、hangar からどう見えるかを書く。

1. **消える予定の会話**：`~/.claude/settings.json` の `cleanupPeriodDays`（無ければ 30 日）を N として、1 週間以内に消える会話の数を数える。表の先頭に置く。
   macOS：`find ~/.claude/projects -name '*.jsonl' -mtime +<N-7> | wc -l`
   Windows（PowerShell）：`(Get-ChildItem $HOME\.claude\projects -Recurse -Filter *.jsonl | Where-Object LastWriteTime -lt (Get-Date).AddDays(-(<N>-7))).Count`
2. **会話した場所**：`hangar project candidates --json`。未分類の会話の総数（`unassignedTotal`）、候補の数、上位の候補。
   候補 1 件には、会話の数（`sessionCount`）、最終日（`lastActivityAt`）、最近の会話の題（`recentTitles`）、git の有無と remote（`isGit`、`gitRemote`）、ほかの候補や登録済みの下にあるか（`enclosedBy`）、クラウド同期のフォルダか（`cloudSynced`）、注記（`notes`）が付く。
   注記は `desktop-direct`（デスクトップの直下）、`downloads-direct`（ダウンロードの直下）、`not-git`、`stale-30d`（最終が 30 日より前）、`single-session`（会話 1 件）。
   ホームフォルダとその上、作成場所そのものとその上、一時フォルダ、隠しフォルダ、消えたフォルダ、登録済みの下は、hangar が先に候補から外している。
3. **起動の経路**：`claude` を別名や関数で包んでいないか。Claude Code の中の `type` はシェルの写しを見るので、macOS は `zsh -ic 'type -a claude'`、Windows は `Get-Command claude -All` で確かめる。シェル連携が入っているか（`hangar shell status`、macOS だけ）。外のターミナルで起動した claude は、シェル連携が無いと hangar の機能（要約、意図、許可待ちの知らせ）が付かない。
4. **連携**：`hangar mcp install --dry-run`、`hangar statusline install --dry-run` の結果。ステータスラインは、Claude Code 側の `statusLine.command` が無いと入れられない（そのときは「先に Claude Code で /statusline を実行する」と伝える）。
5. **クラウド同期のフォルダ**：候補の `cloudSynced`。iCloud の「デスクトップと書類」や OneDrive の下にあるもの。
6. **実行中の claude**：あれば、登録はしてよいが、その会話を止めたり動かしたりしない。

## 2. 聞き取り

AskUserQuestion で 1 問ずつ、3〜5 問だけ聞く。推す答えを先頭に置く。

- 作業のまとまりを、フォルダ名ではなく本人の言葉で（「仕事のレポート」「趣味のアプリ」など）。候補の `recentTitles` を見せて、どれが同じまとまりかを確かめる。
- 1 つのリポジトリの中の小さなフォルダ（モノレポのパッケージ）で起動しているとき、根で 1 つにまとめるか、分けるか。
- 新しいフォルダを作る場所を決めたいか（下の 3b）。`suggestedRoot` が出ているときだけ聞く。

「聞きたい」に入る候補が多いときは、同じ親の下にあるもの（デスクトップの下の 3 件など）を 1 問にまとめてよい。

## 3. 提案

### 3a. プロジェクトの表

先に、候補を全部まとめて `hangar project add <候補のパス…> --dry-run --json` に通す（書かない）。
この試しは、渡した順に前のものを登録したことにして判定するので、候補どうしの入れ子では `nested` が出たり出なかったりする。候補どうしの入れ子は、試しの結果ではなく候補の `enclosedBy`（`kind` が `candidate`）で見る。
包む候補（例：デスクトップそのもの）と、その下の候補（例：デスクトップの下の資料のフォルダ）は、まとめて「どれを登録するか」の 1 問にする。包む側を登録すると、その下の会話も全部そこに入るからである。
そのうえで、候補を次の順に見て、最初に当たった分け方に入れる。全部を登録しようとしない。

| 順 | 当てはまるもの | 分け方 |
|---|---|---|
| 1 | dry-run の `status` が `error`、または `nested` で相手（`enclosing`）が登録済みのプロジェクト（候補どうしの入れ子は除く） | しない（理由を添える） |
| 2 | `notes` に `single-session` と `stale-30d` の両方がある | しない（未分類のまま残る） |
| 3 | `notes` に `desktop-direct`、`downloads-direct`、`not-git` があるか、`enclosedBy` があるもの | 聞きたい |
| 4 | 会話が 2 件以上か、最終日が 30 日以内 | 登録する |
| 5 | 上のどれでもないもの | しない（未分類のまま残る） |

迷ったら「しない」に入れる。あとから登録するのは簡単で、外すほうが手間だからである。
「登録する」は束で 1 回だけ承認を取る（外したい行は言ってもらえば外す）。「聞きたい」だけ 1 件ずつ聞く。
聞き終えて登録するものが決まったら、その一覧だけでもう一度 `--dry-run` を通し、結果を見せてから本番を打つ。
ホームフォルダの直下で起動した会話は候補に出ない。未分類のまま残してよい。

### 3b. 作成場所

`suggestedRoot` が出ているときだけ提案する。出ていなければ、決めないままでよい。
決める前に `hangar workspace set <dir> --dry-run` を見せる。直下で会話のあるフォルダは、全部自動で登録されるからである。
デスクトップ、ダウンロード、クラウド同期のフォルダは作成場所にしない（ホームフォルダとその上は CLI が断る）。

作成場所を決めるときは、続けてフォルダの信頼を提案する。
Claude Code は、まだ信頼していないフォルダで起動すると「このフォルダを信頼しますか」と尋ねる。
`--trust` を付けると、作成場所そのものと直下の git のリポジトリを、hangar に登録したアカウントの全部で信頼済みにする。
付ける前に、次のことを説明して同意を取る。

- 親のフォルダを信頼すると、その下に後から置いたフォルダも、Claude Code は尋ねずに信頼済みとして扱う。
- git のリポジトリの中には親の信頼が及ばないので、hangar は、作成場所の下に後から置いたリポジトリも、hangar から起動するときに信頼済みにする。
- つまり、後から置いたリポジトリのプロジェクトの設定も、尋ねられずに効く。たとえば `.claude/settings.json` の hooks と env（コマンドの実行や環境変数の差し替え）、`.mcp.json` に書かれたプロジェクトの MCP サーバである。人から受け取ったリポジトリを作成場所に置くときは、中身を先に確かめる必要がある。
- 同意はこの作成場所にだけ効く。
- 同意を取り下げるには、`hangar workspace unset` で作成場所を空にするか、作成場所を別の場所に変える。以後、hangar はその場所に信頼を書かない。ただし、すでに `.claude.json` に書いた信頼は残る。消したいときは Claude Code の設定から外す。
- 一部の設定ファイルに書けなくても、同意は記録される。書けなかった分は、hangar から Claude を起こすときに書く。

同意を得たら `hangar workspace set <dir> --trust --dry-run` を見せ、もう一度承認を取ってから `--trust` を付けて本番を打つ。
同意が無ければ `--trust` を付けない。
クイックセッションの置き場（`~/.agent-hangar/quick-sessions`）は、hangar がいつも信頼済みにするので、聞かなくてよい。

### 3c. 連携と保持期間

1 項目ずつ、「何を／なぜ効くか／戻し方」を添えて提案する。

- シェル連携（macOS）：外のターミナルで起動した claude も hangar に載る。戻し方は `hangar shell uninstall`。
- MCP：どの会話からも過去のセッションを探せる。戻し方は `hangar mcp uninstall`。
- ステータスライン：ヘッダーに使用量のゲージが出る。戻し方は `hangar statusline uninstall`。
- 保持期間：Claude Code は既定で 30 日を過ぎた会話を消す。延ばすときは、アプリの設定の「一般」の保持期間で変えてもらう（Claude は書かない）。

## 4. 実行

承認した項目だけ、`--dry-run` の結果を見せてから本番を打つ。
`project add --json` の `results` は 1 件ずつ `status` を持つ。

| status | 意味 |
|---|---|
| `added` | 新しく登録した（`sessionCount` 件の会話が入る。下のフォルダの未分類の会話も含むので、候補の会話の数より多いことがある） |
| `linked` | ほかの PC から届いた同じプロジェクト（git の remote が同じか、名前が同じで remote が食い違わないもの）に結び付けた。新しくは作っていない |
| `already` | 登録済みだった。何もしていない |
| `nested` | 登録済みのプロジェクト（`enclosing`）の下なので断られた |
| `error` | そのほかの理由で断られた（`error` に理由） |

`nested` は自分で回避せず、利用者に伝えてアプリで決めてもらう。

連携が前提の不足で入れられないとき（`--dry-run` が失敗したとき）は、本番は打たずに、何を先にすればよいかだけを伝える。
- MCP：`claude` が見つからないと入れられない。Claude Code を入れてから、もう一度この手引きを渡してもらう。
- ステータスライン：Claude Code の `statusLine.command` が無いと入れられない。先に Claude Code で `/statusline` を実行してもらう。
失敗した項目は、理由と一緒に最後にまとめて伝える。

## 5. 締め

1. 前と後を表で見せる：登録したプロジェクトの数（`project add` の `added` と `linked`）、未分類の会話の数（もう一度 `hangar project candidates --json` の `unassignedTotal`）、連携の状態。
2. hangar のホームを開いてもらい、プロジェクトの一覧に登録したものが並んでいることを確かめてもらう。
3. 新しいセッションを 1 本、クイックセッション（⌘⇧N）で起動してもらう。右の欄に「意図」が出る、ヘッダーに使用量のゲージが出る、の 2 つが見えれば連携が通っている。
4. 最後に「慣れてきたら `~/.agent-hangar/setup-guide-habits.md` に、最初の 1 週間で試すことがあります」と伝えて終える。
