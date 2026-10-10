# Hangar.app の署名

Hangar.app は Apple の Developer ID では署名せず、自作の証明書で署名する。
目的は、入れ替えても macOS の許可（ローカルネットワークなど）が外れないようにすることである。
設計の位置づけは `docs/design.md` の「配布と運用」の節にある。

## なぜ署名するのか

macOS のローカルネットワークの許可は、アプリの署名の識別子（signing identifier）で引かれる。
署名しない Tauri の build は、識別子が `hangar_desktop-<ハッシュ>` で build ごとに変わる。
入れ替えるたびに別のアプリとして扱われ、許可が外れていた。
署名の識別子を `tauri.conf.json` の `identifier`（`dev.agent-hangar.hangar`）に固定すると、許可は保たれる。

ファイルなどほかの許可は、designated requirement（DR）で引かれる。
そこで DR も、葉の証明書の指紋（SHA-1）で固定する。

```
designated => certificate leaf = H"<葉の証明書の SHA-1（小文字 40 桁）>"
```

証明書を作り直すと身元が変わり、利用者の許可は一度だけ外れる。
だから証明書は 10 年以上の有効期間で作り、秘密鍵は 2 か所（1Password と CI の secret）にだけ置く。

## 2 つの道

| 道 | 使う場面 | 固定されるもの | 保たれる許可 |
|---|---|---|---|
| 証明書 | 配布物と、証明書を持つ開発者の手元 | 識別子と DR | 全部 |
| ad-hoc（`--adhoc`） | 証明書の無い開発者の手元 | 識別子だけ（DR は build ごとに変わる） | ローカルネットワークだけ（見込み） |

ad-hoc で識別子だけ固定できることは、一時ディレクトリの小さな .app で確かめてある（`codesign -dvv` が `Identifier=dev.agent-hangar.hangar`、`Signature=adhoc` を示し、`--verify --deep --strict` が通る）。
ローカルネットワークの許可が実際に保たれるかは、ad-hoc では実測していない。

## 署名する

build のあと、build の出力の .app に署名する。
`/Applications` の中の .app には直接署名しない（台本が断る）。

```bash
npm run tauri -w apps/desktop -- build
APP=apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app
```

証明書で署名する。

```bash
export HANGAR_SIGN_KEYCHAIN=<秘密鍵の入ったキーチェーンのパス>
export HANGAR_SIGN_CERT_SHA1=<指紋>        # 省略すると apps/desktop/signing/certificate-sha1.txt を読む
npm run sign-macos -w apps/desktop -- "$PWD/$APP"
```

キーチェーンが閉じているときは、`security` が端末でパスワードを尋ねる。
CI のように対話できない場所では、環境変数 `HANGAR_SIGN_KEYCHAIN_PASSWORD` で渡す（`security unlock-keychain -p` は引数に載るので、1 人しか使わない機械でだけそうする）。

ad-hoc で識別子だけ固定する。

```bash
npm run sign-macos -w apps/desktop -- "$PWD/$APP" --adhoc
```

証明書の指紋が無いとき、台本は黙って ad-hoc に落とさず、止まって `--adhoc` を案内する（身元が弱くなるので、明示させる）。

台本は次を行う。

1. 内側の Mach-O（`.node`、`spawn-helper`、主の実行ファイル）を、深いところから先に署名する。`--deep` には頼らない。ハードンドランタイムは付けない（公証をしないので要らない）。
2. 最後に .app を、識別子と DR を指定して署名する。
3. `codesign -dvv` の識別子、`codesign -d -r-` の DR、`codesign --verify --deep --strict` を確かめ、違えば非 0 で終わる。

## 署名する機械の前提（macOS 26 の CI で実測）

自作の証明書は Gatekeeper の信頼の鎖に入らない。
macOS 27 の手元では、そのまま `codesign -s <指紋>` が通った。
macOS 26 の CI のランナーでは、そのままだと `no identity found` で落ちた。
`security find-identity -p codesigning` は識別を出すが、`CSSMERR_TP_NOT_TRUSTED` で「有効な識別」には数えられなかった。

次の 3 つを合わせると通った（それぞれ単独の効き目までは切り分けていない）。

1. 証明書をコード署名用に信頼する（`sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain <cer>`）。
2. 秘密鍵の入ったキーチェーンをユーザーの検索リストに足す。
3. `codesign -s` に渡す指紋は大文字の 16 進にする（台本が直す）。

1 と 2 は `apps/desktop/scripts/prepare-signing-keychain.sh --cer <cer> --keychain <キーチェーン>` が行う。
1 は機械全体の信頼設定を書き換えるので、使い捨ての CI のランナーで走らせる想定である。
手元の Mac で走らせたときは、Keychain Access でその証明書の信頼設定を「システム既定を使用」に戻すか、証明書をキーチェーンごと消す。
台本は、`no identity found` で落ちたときにこの台本を案内する。

## 証明書を作る（利用者の手元で、一度だけ）

自己署名のコード署名証明書を作る。
有効期間は既定で 20 年（7300 日）で、10 年（3653 日）より短い指定は台本が断る。

```bash
bash apps/desktop/scripts/make-signing-cert.sh --out <リポジトリの外のディレクトリ>
```

出力先がリポジトリの中なら台本が断る（秘密鍵を commit しないため）。
パスワードは引数に取らない。環境変数 `HANGAR_SIGN_P12_PASSWORD` か、端末での入力で渡す。

出力は次の 3 つである。

| ファイル | 中身 | 置き場 |
|---|---|---|
| `hangar-signing.p12` | 秘密鍵と証明書 | 秘密。手順 3 と 4 の 2 か所だけ |
| `hangar-signing.cer` | 公開の証明書（DER） | リポジトリに置いてよい |
| `certificate-sha1.txt` | 葉の証明書の指紋 | リポジトリに置いてよい |

手元で署名するために専用のキーチェーンも作るときは、`--keychain <新しいパス>` を付ける。
検索リストには足さず、ログインのキーチェーンには触らない。

## 手順

1. 上の台本で証明書を作る。
2. 指紋を `apps/desktop/signing/certificate-sha1.txt` に 1 行で書き、公開の証明書（`hangar-signing.cer`）と一緒に PR に入れる。
3. p12 とそのパスワードを、1Password に保管する（p12 は添付、パスワードは別の項目）。
4. 同じ p12 の base64 とパスワードを、GitHub のリポジトリの secret に置く（名前は `HANGAR_SIGN_P12_BASE64` と `HANGAR_SIGN_P12_PASSWORD`）。`base64 -i hangar-signing.p12 | pbcopy` のように、ファイルを画面に出さずに渡す。
5. 作業用のディレクトリから p12 を消す。鍵は 1Password と CI の 2 か所だけが持つ。
6. 手元で署名する開発者は、1Password から p12 を取り出して専用のキーチェーンへ入れる。

公開リポジトリに入れてよいのは、公開の証明書と指紋だけである。
秘密鍵、p12、パスワードは、どのファイルにも、コミットにも、ログにも書かない。

## 状態

本番の証明書は作ってある（自己署名、有効期間 20 年）。
公開の 2 つのファイルをリポジトリに置いている。

- `apps/desktop/signing/certificate-sha1.txt`：葉の証明書の指紋。
- `apps/desktop/signing/hangar-signing.cer`：公開の証明書（DER）。

2 つが食い違わないことは、`apps/desktop/test/signing-cert.test.ts` が確かめる。

秘密鍵（p12）は 2 か所だけにある。

- 1Password の項目「Hangar macOS signing certificate」（p12 は添付、パスワードは別の欄）。
- GitHub のリポジトリの secret `HANGAR_SIGN_P12_BASE64`（p12 の base64）と `HANGAR_SIGN_P12_PASSWORD`（そのパスワード）。

CI の署名（`release.yml`）は PR 5-2 で入れる。そこで上の `prepare-signing-keychain.sh` を呼ぶ。

## 鍵を失ったとき

秘密鍵を 1Password と CI の両方で失ったら、新しい証明書を作り直す。
身元（DR）が変わるので、利用者は許可を一度だけ付け直す。
