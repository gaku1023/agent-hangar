# Linux に入れる（サーバーだけ常駐）

Linux には画面のアプリを出していません。
サーバーだけを Linux に置いて常駐させ、Mac やスマホの Hangar から操ります。
VM、クラウドの機械、手元に置いた常時稼働の PC などに向きます。
画面（TUI）はありません。

対象は x64 と arm64 の glibc の Linux です（Debian、Ubuntu、Fedora など）。
Alpine のような musl は対象外です。
Node 22 は同梱しているので、先に入れるものは tmux と、使うエージェントだけです。

## 1. 入れる

root 以外の利用者で実行します。root では断ります。
専用の利用者を作るなら、先に `sudo useradd -m hangar` を打ち、その利用者になってください。

```sh
curl -fsSL https://github.com/gaku1023/agent-hangar/releases/latest/download/install.sh | sh
```

- 入れ先は `~/.local/share/agent-hangar/versions/<タグ>`、`current` がその版を指します。`~/.local/bin/hangar` が入口です（PATH に無ければ足してください）。
- 版を決めるときは `HANGAR_VERSION=v0.23.0` を前に付けます。
- ダウンロードしたファイルは、同じタグの `.sha256` と照合します。

## 2. 常駐させる

```sh
hangar service install
```

- 既定は利用者のユニットです。再起動後もログインなしで起動するよう linger を有効にします（`loginctl enable-linger`）。
- 機械全体のユニットにするなら `hangar service install --system` です（sudo を使います）。
- サーバーは 127.0.0.1 だけで待ちます。外には開きません。
- ユニットは再起動しても、動いている会話（tmux）を残します。
- 解除は `hangar service uninstall`（`--system` で入れたなら同じ印を付けます）。

画面をローカルで見たいときは、トークン付きの URL を `hangar url` で出します。
URL はジャーナルには出ません。

### 再起動で消える使い捨ての機械

`hangar service install --ephemeral` にすると、データの置き場を再起動で消える領域（`/run` 以下）にします。
使い終えたら、機械ごと消す前に `hangar cloud leave` で参加を外してください（外さずに消した機械は、ほかの PC から `hangar cloud revoke <id>` で解除します。id は `hangar cloud devices` で見ます）。

## 3. エージェントを入れてログインする

使うものだけでかまいません。ログインは、その利用者として一度やります。

### Claude Code

入れ方は Claude Code の案内に従います。
ログインは `claude auth login` で、出る URL をブラウザで開き、返ってくるコードを貼ります。

初めて動かすと、色の選び（theme）とフォルダを信頼するかの問いが出ます。
ここで止まると、Hangar から送った会話が進みません。
**一度だけ、手で `claude` を作業のフォルダで起こして、両方に答えてください。**
`~/.claude.json` を Hangar が書き換えることはしません。

### Codex

```sh
codex login --device-auth
```

ChatGPT のセキュリティ設定で、Codex のデバイスコードによるサインインを有効にしていないと、このコマンドは断られます。
先に ChatGPT の設定で有効にしてから、もう一度打ちます。

Hangar 側では、設定の「Enable Codex」を入れます（`~/.agent-hangar/settings.json` の `codexEnabled`）。

### opencode

公式の案内で入れると、古い 1.x が入ることがあります。
Hangar は 2 系で確かめています。入れたあとに上げてください。

```sh
opencode upgrade 2.2.0 --major
```

Hangar 側では、設定の「Enable opencode」を入れます（`opencodeEnabled`）。
モデルは、サインインなしで使える Zen の無料のものから試せます。

どちらの設定も、変えたあとはサーバーを再起動します（`systemctl --user restart hangar`）。

## 4. 動くか確かめる

作業のフォルダで 1 本だけ回します。

```sh
cd ~/work
hangar run --agent claude-code "reply with just: pong"
```

`--agent` は `claude-code`、`codex`、`opencode` から選びます。

## 5. 最後に：クラウドに参加させる

Mac やスマホから操るには、この機械をクラウドの Worker に参加させます。
入れる作業とは分けて、ここで行います。

```sh
hangar cloud join <クラウドの URL>
```

参加コードの入力を求められます。
参加コードは、すでに参加している Mac や Windows の Hangar で発行します。
確認コードが出たら、発行した側で承認します。
仕組みと割り切りは [docs/cloud-sync.md](cloud-sync.md) にあります。

## 更新と削除

```sh
hangar update --check      # 新しい版があるか
hangar update              # 入れ替えて、ユニットを再起動
hangar update --version v0.23.0
```

削除するときは、先に `hangar service uninstall`、そのあと `~/.local/share/agent-hangar` と `~/.local/bin/hangar` を消します。
データは `~/.agent-hangar` にあり、残します。要らなければ、`hangar cloud leave` で参加を外してから消してください。

## 確かめた範囲

Debian 12（arm64、root 以外、Docker 上の systemd）で、次を実物で確かめています。

- 入れる、起動、画面の応答、サーバーだけのメモリ約 190MB。
- ユニットの再起動後も会話が残ること（利用者のユニット、system、ephemeral、root の拒否）。
- Claude Code、Codex、opencode の 3 つで 1 ターンが返ること。

未確認：x64 の実機、実物のクラウドへの参加、機械の再起動後の再開、実際のタグでのリリース。
