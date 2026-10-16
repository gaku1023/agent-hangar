# スマホ版（PWA）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全 PC・全アカウントの会話の受信箱と、PC を選んで新しい会話を始める画面の 2 枚だけを持つ PWA を Worker から配り、hangar が起こす会話を `/rc` につなぐ。

**Architecture:** 状態は既存の `rows`（同期の表）に載せず、Worker の D1 に専用の表を 3 つ足す（`mobile_feeds`、`launch_requests`、`mobile_pairings`）。各 PC は「受信箱の素」を 1 行（PC ごと）にまとめ、丸ごと暗号化して `mobile_feeds` に書く。スマホは PC の数だけ行を読んで手元で復号・合成する。起動の依頼は `launch_requests` に暗号化して置き、宛先の PC が pull の応答に相乗りで受け取り、取り合いの印（claim）を付けてから起動する。

**Tech Stack:** Hono（Worker）、D1、miniflare（試験）、Web Crypto（HKDF＋AES-256-GCM、PC とブラウザで同じ実装）、better-sqlite3、React 19＋Vite 8（スマホの画面、新しい workspace `packages/mobile`）、vitest 5。

**Spec:** `docs/superpowers/specs/2026-10-17-mobile-pwa-design.md`

## 作り手に任された点の決定（この計画で決める）

設計書の「作り手に任せること」への答え。実装の前提になるので先に書く。

| 項目 | 決定 | 理由 |
|---|---|---|
| 共有の表 | `rows` と `SHARED_TABLES` には足さない。D1 に専用の表 `mobile_feeds`、`launch_requests`、`mobile_pairings` を作る | `rows` に足すと古い Worker が push 全体を 400 で断り、古い PC は知らない表を pull する。専用の表なら古い PC は何も見ない |
| 互換の版 | Worker の `COMPAT_VERSION` を 7 に上げ、`MIN_DEVICE_COMPAT` は 6 のまま。PC 側は `MOBILE_MIN_WORKER_COMPAT = 7` に届くまで書かない | 古い PC を締め出さない |
| 一覧の口 | `GET /m/inbox` は `mobile_feeds`（PC の数の行）と `devices` だけを読む | 1 回の読み取りは PC の数×2 行程度。全走査をしない |
| 書き込みの間引き | 受信箱の素の JSON のハッシュが変わったときだけ書く。変化の後 2 秒待ってまとめ、同じ PC からの書き込みは最短 15 秒あける | 見積もりは Task 13 で docs に書く（1 台 1 日 1,000 行前後、上限でも 5,760 行） |
| 暗号化の範囲 | 受信箱の素は全体を暗号化する（状態と時刻も）。Worker が平文で持つのは PC の ID と更新時刻だけ | 件数は手元で数えられるので平文の状態は要らない |
| 鍵 | `HKDF-SHA256(joinSecret, salt="hangar-salt-v1", info="hangar-mobile-v1", 32 bytes)`、AES-256-GCM、IV 12 バイト乱数、AAD で用途と宛先を縛る | R2 の本文の鍵（info `hangar-file-v1`）とは別の用途の鍵 |
| 起動の依頼の偽造 | 依頼の中身は暗号化されており、PC は復号できたものだけを起こす | スマホの Worker 用トークンだけ漏れても起動はできない |
| スマホに渡すもの | 参加の秘密は渡さない。渡すのはスマホ用の鍵（`HKDF(joinSecret, info="hangar-mobile-v1")` の 32 バイト）と、使い捨てのペアリング券だけ（利用者の決定、2026-10-17） | スマホや QR が漏れても PC として参加できず、R2 の本文も読めない。外せば締め出せる |
| ペアリング券 | PC が `POST /m/pairings` で取る。128 bit の乱数、D1 にはハッシュだけ、5 分で失効、1 回で使い切り | QR の写真や履歴が残っても 5 分で無効 |
| ペアリングの QR | 中身は `<workerUrl>/app/#pair=<base64url(JSON {url, code, key, pcName, expiresAt})>`（`PairingBlob`）。フラグメントはサーバへ送られず、読んだらすぐ `history.replaceState` で消す | |
| スマホのトークン | `devices` に `kind`（`pc`/`mobile`）を足す。スマホのトークンは `/m/` のスマホ用の口だけ通し、PC の口は 403。有効期限なし（外すのは PC の一覧から）。解除したスマホは、券なしでは参加し直せない | 設計書の「受信箱と起動の依頼だけ」 |
| スマホの保存 | 鍵は IndexedDB に取り出せない（non-extractable）`CryptoKey` として、Worker 用トークンは `localStorage` に置く。無いときは「つなぐ文字列を貼る」欄を出す（QR と同じ中身） | 画面に XSS があっても鍵の値は持ち出せない。iOS のホーム画面のアプリは Safari と保存場所が分かれることがある（実物で確かめる） |
| 秘密の作り直し | 参加の秘密を作り直すとスマホ用の鍵も変わる。スマホは開けない受信箱を「つなぎ直してください」と出す | |
| 画面の守り | `_headers` で `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`。外部のスクリプトを読まない。`dangerouslySetInnerHTML` を使わない。`rcUrl` は `https://claude.ai/` で始まるものだけを通す（PC で拾うときとスマホで開くときの両方） | 会話から来た文は攻撃者が操れる（プロンプトインジェクション） |
| 回数の制限 | 起動の依頼は 1 台のスマホから 10 分に 10 件まで（超えたら 429）。ペアリング券は 1 台の PC から 10 分に 5 枚まで | 盗まれたトークンで D1 の無料枠を食い潰されない |
| PC 側の上限 | 設けない（利用者の決定、2026-10-17）。スマホで選んだ権限モードのまま起こす | |
| 依頼の時間切れ | `LAUNCH_TTL_MS = 75_000`。Worker はこれを過ぎた依頼を claim させない。スマホは 3 秒ごとに状態を見て、80 秒で時間切れと言う | PC の pull は 30 秒ごと。2 周分の余裕。スマホが諦めた後に起動されない |
| 依頼の受け取り | Worker は `GET /changes` の応答に、その PC 宛ての未処理の依頼を `launches` として載せる（索引で引く） | 要求を増やさない |
| `/rc` の URL | 起動から 60 秒、2 秒ごとに tmux の画面を `-J` で読み、`https://claude.ai/code/session_…` を拾って手元の表に残す。拾えなければ claude.ai/code を開く | 公式の取得手段が無い。形は Task 0 で実物から確かめた（「画面のメモ」） |
| `/rc` が使えない構成 | アカウントの認証が claude.ai のログインでないとき、または `ANTHROPIC_BASE_URL`・`ANTHROPIC_API_KEY` が設定されているときは `--remote-control` を付けない | 実物では API キーのとき黙って無視されて起動は通ったが、保守的に付けない |
| スマホの画面 | 新しい workspace `packages/mobile`（React＋Vite）。`packages/ui` の部品は使わず、色の値だけ写す | PC の UI は大きく、スマホの 2 枚には重い |
| 配信 | Worker の静的ファイル（wrangler の `assets`）で `/app/` に置く。API は `/m/` | 同じオリジンなので CORS が要らない |
| 自動の読み直し | 画面が見えている間だけ 30 秒ごと。前面に戻ったとき、下に引いたときにも読む | 1 日中開きっぱなしでも 2,880 回×数行 |
| 選べるもの | 権限モードとモデル（effort は出さない） | 設計書の範囲 |

## Global Constraints

- 失敗とみなすもの（設計書）：待っている内容・意図の文の平文が Worker や D1 に置かれる／スマホのトークンで要らない表を書き換えられる／一覧を開くたびに D1 の行を全部読む／状態の共有で無料枠が目に見えて増える／古い版の PC が同期から締め出される／`/rc` が使えない環境で起動が失敗する／一覧の状態が実際とずれたまま残る。
- 配色は PC の hangar と同じ明るい配色だけ。暗い配色を持たない。
- 公開リポジトリ。試験・文書・試作に実際の会話の題、使用量、他プロジェクトの名前を書かない。
- D1 の文は 1 文 1 行で書く（`ensureSchema` の exec が改行で区切る）。
- PC が古い Worker（版 6）に当たったときは、スマホ向けの書き込みも依頼の処理もしない。設定の画面で「Worker を更新すると使えます」と言う。
- PC からほかの PC の生存を見る基準と同じく、Worker が最後に見てから 3 分（`PEER_STALE_MS = 180_000`）を過ぎた PC は「不明」。
- 文は 300 字で切る（`MOBILE_TEXT_MAX = 300`）。受信箱の素は暗号化の前で 48 KiB まで（超えたら done、returns、projects の順に古いものから落とす）。
- 選べる権限モードは PC の新規セッションのダイアログと同じ値（`'' | plan | manual | acceptEdits | auto | dontAsk | bypassPermissions`）。
- 開発の流れは CLAUDE.local.md（試験を先に、typecheck と test、build 3 本、PR、CI 緑でマージ、入れ替え）。実物のクラウドに触る確かめはその都度、無料枠の見積もりを添えて聞く。

## Review Focus

1. **古い版の PC と新しい Worker、新しい PC と古い Worker。** 古い PC の push/pull が今までどおり通り、新しい PC は版 6 の Worker に何も書かない。→ Task 2 と Task 5 に試験を置く。
2. **止まった PC の行。** hangar を閉じても tmux の会話は動き続けるので、PC の行は消さない。Worker が 3 分見ていない PC の会話は「不明」として出し、「実行中」と言い切らない。→ Task 10 に試験を置く。
3. **同じ依頼の二重起動。** スマホの再送、PC の 2 回の pull、Worker の行の巻き戻しのどれでも 1 回しか起こさない。→ Task 3（claim の原子性）と Task 6（手元の済みの印）に試験を置く。
4. **復号できない行。** 参加の秘密を作り直した後の古い行や壊れた行は、その PC の分だけ「読めない」と出し、画面全体を落とさない。→ Task 10 に試験を置く。
5. **会話から来た文の注入。** 題、待っている内容、意図に `<script>` や `<img onerror>` が、`rcUrl` に `javascript:` やほかのホストが入っていても、文字として出し、リンクは claude.ai/code に落とす。→ Task 8（拾う側）と Task 10（出す側）に試験を置く。
6. **`/rc` の付けられないアカウント。** API キーの認証や `ANTHROPIC_BASE_URL` のあるアカウントでも、設定が入のまま起動できる。→ Task 7 に試験を置く。

---

## ファイルの地図

| 場所 | 役目 |
|---|---|
| `packages/shared/src/mobile.ts`（新） | 受信箱の素と依頼の型、定数、`MOBILE_*` |
| `packages/shared/src/mobileCrypto.ts`（新） | Web Crypto の鍵導出と封／開封。PC とスマホの共通 |
| `packages/shared/src/launchChoices.ts`（新） | 権限モードとモデルの選択肢（`packages/ui` の `PERMISSION_MODES` をここへ移す） |
| `packages/shared/src/compat.ts` | `COMPAT_VERSION = 7`、`MOBILE_MIN_WORKER_COMPAT = 7` |
| `packages/cloud/src/schema.ts` | `mobile_feeds`、`launch_requests`、`mobile_pairings`、`devices.kind` |
| `packages/cloud/src/mobile.ts`（新） | `/m/` の口（参加、受信箱、受信箱の素の書き込み、依頼、claim、応答） |
| `packages/cloud/src/auth.ts` | `requireKind` |
| `packages/cloud/src/changes.ts` | pull の応答に `launches`、peers から `mobile` を外す |
| `packages/server/src/mobile/feed.ts`（新） | DB と生きている状態から受信箱の素を組む（純粋） |
| `packages/server/src/mobile/publisher.ts`（新） | 間引き、暗号化、書き込み |
| `packages/server/src/mobile/launchInbox.ts`（新） | 依頼の受け取り、claim、起動、応答 |
| `packages/server/src/mobile/remoteUrl.ts`（新） | `/rc` の URL を画面から拾う |
| `packages/server/src/boot/mobile.ts`（新） | 上の 3 つの組み立て |
| `packages/mobile/`（新 workspace） | PWA |

---

### Task 0: 実物の下調べと設定の画面の試作

目で見える変更（PC の設定の追加、スマホの参加の画面）は試作を先に選んでもらう（CLAUDE.local.md）。受信箱と新しい会話の 2 枚は Design キャンバス「hangar スマホ版」（`ct/BgTSM7qWoUarkhpmWTq6XK`）の試作が決まった形なので作らない。

**Files:**
- Create: `/private/tmp/.../scratchpad/mobile-settings-proto.html`（リポジトリに入れない）

- [x] **Step 1: `/rc` の URL の形を実物で確かめる。** 専用の tmux（`tmux -S <scratchpad>/rc.sock`、`kill-server` は呼ばない）で `claude --remote-control "rc-probe"` を起こし、20 秒後に `capture-pane -p` を読んで、URL の行の形を記録する。終わったら `/exit` で抜け、ソケットの tmux を `kill-session` で閉じる。API キーで認証したときの振る舞い（警告で続くか、落ちるか）も、手元にその構成があれば見る。無ければ「未確認」として Task 7 の門を保守的に（付けない側に）倒す。
- [x] **Step 2: Design キャンバスの 2 枚を読む**（DesignSync か Artifact の read）。配置、文言、色を Task 10・11 の実装者に渡すメモにまとめ、この計画の末尾「画面のメモ」に追記する。
- [x] **Step 3: 試作を作る。** 1 枚の HTML に次を案ごとに並べる。(a) PC の設定のクラウドの節に「スマホをつなぐ」（ボタン→QR と注意書き→つないだスマホが PC の一覧に「スマホ」の印で並ぶ）を 2〜3 案、(b) 設定の「会話を Claude アプリにつなぐ」の置き場所（一般の節／起動時に効く設定の並び）2 案、(c) スマホの参加の画面（QR から開いた直後の「この端末を参加させる」と、つなぐ文字列を貼る欄）2 案。QR には 5 分の残り時間と「人に見せない」旨を出す。
- [x] **Step 4: 利用者に AskUserQuestion で 1 問ずつ選んでもらう。** 選ばれた案を「画面のメモ」に追記する。選ばれるまで Task 9・10 の画面に入らない（Task 1〜8 は並行して進めてよい）。

---

### Task 1: 共有の型、定数、暗号

**Files:**
- Create: `packages/shared/src/mobile.ts`, `packages/shared/src/mobileCrypto.ts`, `packages/shared/src/launchChoices.ts`
- Modify: `packages/shared/src/compat.ts`, `packages/shared/src/index.ts`（export）, `packages/ui/src/views/primitives/permissionModel.ts`（値を shared から読む）
- Test: `packages/shared/src/mobileCrypto.test.ts`, `packages/shared/src/mobile.test.ts`

**Interfaces:**
- Produces:
  - `compat.ts`: `COMPAT_VERSION = 7`、`MOBILE_MIN_WORKER_COMPAT = 7`
  - `mobile.ts`:
    - `MOBILE_TEXT_MAX = 300`、`MOBILE_FEED_MAX_BYTES = 48 * 1024`、`LAUNCH_TTL_MS = 75_000`、`PEER_STALE_MS = 180_000`
    - `type MobileWaiting = { kind: WaitKind; text: string }`
    - `type MobileLiveItem = { sessionId: string; projectId: string | null; projectName: string; title: string; accountId: string; status: LiveStatus; statusAt: number; startedAt: number; waiting: MobileWaiting | null; intent: string | null; rcUrl: string | null }`
    - `type MobileReturnItem = { sessionId: string; projectName: string; title: string; accountId: string; returnOn: string; returnTime: string | null }`
    - `type MobileDoneItem = { sessionId: string; projectName: string; title: string; oneLiner: string | null; doneAt: number }`
    - `type MobileAccount = { id: string; name: string; color: string; fiveHour: number | null; sevenDay: number | null }`
    - `type MobileProject = { id: string; name: string; lastUsedAt: number | null }`
    - `type MobileFeed = { v: 1; deviceId: string; deviceName: string; accounts: MobileAccount[]; projects: MobileProject[]; live: MobileLiveItem[]; returns: MobileReturnItem[]; done: MobileDoneItem[] }`
    - `type MobileLaunchPayload = { v: 1; createdAt: number; projectId: string | null; scratch: boolean; accountId: string; permissionMode: string; model: string; prompt: string }`（`scratch: true` のとき `projectId` は null。「すぐ始める」）
    - `type MobileLaunchAnswer = { ok: true; sessionId: string; title: string } | { ok: false; reason: 'project-missing' | 'account-missing' | 'bad-payload' | 'expired' | 'launch-failed'; detail?: string }`
    - Worker の口の型：`MobilePairingResponse = { code: string; expiresAt: number }`、`MobileJoinRequest = { code: string; device: { id: string; name: string } }`、`MobileJoinResponse = { token: string; deviceId: string }`、`MobileInboxResponse = { now: number; devices: { id: string; name: string; platform: string; lastSeenAt: number | null }[]; feeds: { deviceId: string; updatedAt: number; sealed: string }[] }`、`MobileLaunchIn = { id: string; targetDevice: string; sealed: string }`、`MobileLaunchOut = { id: string; createdAt: number; sealed: string }`、`MobileLaunchStatus = { id: string; status: 'pending' | 'claimed' | 'started' | 'failed' | 'expired'; sealedAnswer: string | null }`
    - `clampText(s: string | null | undefined, max = MOBILE_TEXT_MAX): string | null`
    - `fitFeed(feed: MobileFeed, maxBytes = MOBILE_FEED_MAX_BYTES): MobileFeed`
  - `mobileCrypto.ts`:
    - `deriveMobileKeyBytes(joinSecret: string): Promise<Uint8Array>`（PC だけが呼ぶ。QR に入れる 32 バイト）
    - `importMobileKey(bytes: Uint8Array, extractable = false): Promise<CryptoKey>`
    - `deriveMobileKey(joinSecret: string): Promise<CryptoKey>`（= 上の 2 つ）
    - `type PairingBlob = { url: string; code: string; key: string; pcName: string; expiresAt: number }`（key は base64url）、`encodePairing(b: PairingBlob): string`、`decodePairing(s: string): PairingBlob`（壊れていれば `MobilePairingError`）
    - `isRemoteControlUrl(u: string): boolean` — `https://claude.ai/` で始まり、URL として解釈できるものだけ true
    - `seal(key: CryptoKey, aad: string, value: unknown): Promise<string>` — 戻りは base64url(`iv(12) || ciphertext||tag`)
    - `open<T>(key: CryptoKey, aad: string, sealed: string): Promise<T>` — 失敗は `MobileOpenError` を投げる
    - AAD の作り方：`aadFeed(deviceId)` = `feed:<deviceId>`、`aadLaunch(id, targetDevice)` = `launch:<id>:<targetDevice>`、`aadAnswer(id)` = `answer:<id>`
  - `launchChoices.ts`: `PERMISSION_MODE_VALUES = ['', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const`、`MODEL_CHOICES` を `summaryEngine.ts` から再 export

- [ ] **Step 1: 落ちる試験を書く**
  - `mobileCrypto.test.ts`
    - `seal→open で元の値に戻る`
    - `AAD が違うと open が MobileOpenError を投げる`（`aadFeed('a')` で封じて `aadFeed('b')` で開く）
    - `別の joinSecret の鍵では開けない`
    - `同じ値を 2 回封じると別の文字列になる`（IV が乱数）
    - `importMobileKey(deriveMobileKeyBytes(s)) で封じたものを deriveMobileKey(s) で開ける`、`既定の import は exportKey できない`
    - `decodePairing(encodePairing(b))` が元に戻る／壊れた文字列は `MobilePairingError`
    - `isRemoteControlUrl`：`https://claude.ai/code/x` は true、`javascript:alert(1)`、`https://claude.ai.evil.example/`、`http://claude.ai/` は false
    - `R2 の鍵と別物である`：`deriveMobileKey(s)` を `exportKey` できないので、代わりに同じ秘密で Node の `deriveFileKey(s)` の生バイトを AES-GCM の鍵として import して開くと失敗することを確かめる（`packages/server/src/sync/crypto.ts` を試験から読む）
  - `mobile.test.ts`
    - `clampText は 300 字で切り、末尾に … を付ける`／`null と空文字は null`
    - `fitFeed は 48 KiB を超えると done、returns、projects の順に古いものから落とし、live は落とさない`
- [ ] **Step 2: 走らせて落ちるのを見る** — `npx vitest run --project shared mobile`（プロジェクト名は `packages/shared/vitest.config.ts` に合わせる）
- [ ] **Step 3: 実装する。** 暗号は `globalThis.crypto.subtle` だけを使う（`node:crypto` を import しない。スマホからも読むため）。base64url は shared に既にあればそれを使う。`permissionModel.ts` は値の並びを `PERMISSION_MODE_VALUES` から作り、表示名の引き方は変えない。
- [ ] **Step 4: 通るのを見る**、`npm run typecheck`
- [ ] **Step 5: コミット** — `feat(shared): mobile feed types and Web Crypto sealing`

---

### Task 2: Worker のスマホの参加と受信箱の口

**Files:**
- Modify: `packages/cloud/src/schema.ts`, `packages/cloud/src/auth.ts`, `packages/cloud/src/app.ts`, `packages/cloud/src/changes.ts`（peers）, `packages/cloud/src/devices.ts`（`kind` を返す）, `packages/shared/src/cloud.ts`（`CloudDeviceOut.kind?: 'pc' | 'mobile'`）
- Create: `packages/cloud/src/mobile.ts`
- Test: `packages/cloud/test/mobile.test.ts`, `packages/cloud/test/compat.test.ts`（追記）

**Interfaces:**
- Consumes: Task 1 の型、`COMPAT_VERSION = 7`
- Produces:
  - D1：
    - `DEVICE_ADDED_COLUMNS` に `kind text not null default 'pc'`
    - `create table if not exists mobile_feeds (device_id text primary key, sealed text not null, updated_at integer not null)`
    - `create table if not exists mobile_pairings (code_hash text primary key, created_by text not null, created_at integer not null, used_at integer)` と `create index if not exists mobile_pairings_by on mobile_pairings(created_by, created_at)`
  - 定数：`PAIRING_TTL_MS = 5 * 60_000`、`PAIRING_RATE = { max: 5, windowMs: 10 * 60_000 }`
  - `requireKind(kind: 'pc' | 'mobile'): MiddlewareHandler` — 違えば 403 `{error:'forbidden'}`
  - 口（`/m/` 以下。参加以外は Bearer）：
    - `POST /m/pairings`（pc だけ）：201 `MobilePairingResponse`。`randomToken(16)` を返し、D1 にはハッシュだけ。同じ PC から 10 分に 5 枚を超えたら 429。ついでに 1 日より古い券の行を消す
    - `POST /m/join`（トークン不要）：`MobileJoinRequest` → 201 `MobileJoinResponse`。`update mobile_pairings set used_at=? where code_hash=? and used_at is null and created_at > ?` の `meta.changes === 1` のときだけ、`devices` に `kind='mobile'`、`platform='mobile'` で insert（新しい ID、既存の行を上書きしない）。それ以外は 401。参加の秘密では参加できない
    - `POST /join`（今の PC の参加）：`device.id` が `kind='mobile'` の行と同じなら 409（スマホの行を PC に付け替えさせない）
    - `PUT /m/feed`（pc だけ）：本文 `{ sealed: string }`、64 KiB を超えたら 413。`insert ... on conflict(device_id) do update`。`touchIfDue` も呼ぶ
    - `GET /m/inbox`（mobile だけ）：`MobileInboxResponse`。`devices` は `kind='pc' and revoked_at is null`、`feeds` は解除されていない PC の分だけ
  - 既存の口（`/changes`、`/rows`、`/files`、`/devices`、`/usage`）は `requireKind('pc')`
  - `GET /changes` の `peers` から `kind='mobile'` を外す

- [ ] **Step 1: 落ちる試験を書く**（`test/harness.ts` の `startCloud` を使う）
  - `PC が取った券でスマホが参加でき、kind=mobile のトークンを受け取る`
  - `同じ券の 2 回目は 401`、`5 分を過ぎた券は 401`、`存在しない券は 401`
  - `参加の秘密を /m/join に渡しても参加できない`
  - `解除したスマホは、前に使った券でも、新しい券なしでも戻れない`（新しい券なら新しい行として参加できる）
  - `スマホのトークンで POST /m/pairings は 403`、`同じ PC が 10 分に 6 枚目を取ると 429`
  - `スマホの行の ID で POST /join すると 409`
  - `スマホのトークンで GET /changes、POST /changes、GET /rows、GET /files、GET /devices は 403`
  - `PC のトークンで GET /m/inbox は 403、スマホのトークンで PUT /m/feed は 403`
  - `PC が PUT /m/feed した行を、スマホの GET /m/inbox が返す。同じ PC の 2 回目は上書きで行は 1 つ`
  - `解除した PC の受信箱の素は GET /m/inbox に出ない`、`解除したスマホは 401`
  - `GET /m/inbox が読む D1 の行は PC の数に比例し、rows の行数に依らない`：`rows` に 2,000 行入れた後、`d1.prepare(...).run()` の `meta.rows_read` を合計する代わりに、口の実装が `rows` 表を参照しないことを、`rows` を `drop` しても `GET /m/inbox` が 200 を返すことで確かめる
  - `peers にスマホが出ない`
  - `compat.test.ts`：`版 6 の PC（x-hangar-compat: 6）の push と pull が通る`、`/health の compat が 7`
- [ ] **Step 2: 落ちるのを見る** — `npx vitest run --project cloud mobile compat`
- [ ] **Step 3: 実装する。** `kind` の列は既存の `addDeviceColumns` の仕組みで足す。トークンの発行とハッシュの保存は `joinHandler` の中の部分を関数に切り出して共有する（秘密の照合は共有しない）。
- [ ] **Step 4: 通るのを見る**（`--project cloud` 全部）、`npm run typecheck`
- [ ] **Step 5: コミット** — `feat(cloud): mobile join, scoped tokens and the inbox feed`

---

### Task 3: Worker の起動の依頼

**Files:**
- Modify: `packages/cloud/src/schema.ts`, `packages/cloud/src/mobile.ts`, `packages/cloud/src/changes.ts`, `packages/shared/src/cloud.ts`（`PullChangesResponse.launches?: MobileLaunchOut[]`）
- Test: `packages/cloud/test/mobileLaunch.test.ts`

**Interfaces:**
- Consumes: Task 2 の `requireKind`、Task 1 の `MobileLaunchIn/Out/Status`、`LAUNCH_TTL_MS`
- Produces:
  - D1：`create table if not exists launch_requests (id text primary key, target_device text not null, from_device text not null, sealed text not null, status text not null, created_at integer not null, claimed_at integer, answered_at integer, sealed_answer text)` と `create index if not exists launch_requests_target on launch_requests(target_device, status, created_at)`、`create index if not exists launch_requests_from on launch_requests(from_device, created_at)`
  - 定数：`LAUNCH_RATE = { max: 10, windowMs: 10 * 60_000 }`
  - `POST /m/launches`（mobile）：`MobileLaunchIn` → 201 `MobileLaunchStatus`。`insert or ignore`（同じ id の再送は既存の行の状態を返す）。宛先が `kind='pc'` で解除されていない PC でなければ 404。本文 16 KiB 上限。同じスマホの直近 10 分の依頼が 10 件に達していたら 429（`launch_requests_from` の索引で数える）。同じ要求のついでに `created_at < now - 7日` の行を消す
  - `GET /m/launches/:id` と応答の読み取りは、依頼を出したスマホ（`from_device`）だけ。ほかは 404
  - `GET /m/launches/:id`（mobile）：`MobileLaunchStatus`。`pending` で TTL を過ぎていれば `expired` と返す（行も `expired` に書き換える）
  - `GET /changes`（pc）：応答に `launches: MobileLaunchOut[]` を足す。`target_device = 自分 and status = 'pending' and created_at > now - LAUNCH_TTL_MS`、索引で引く
  - `POST /m/launches/:id/claim`（pc）：`update ... set status='claimed', claimed_at=? where id=? and target_device=? and status='pending' and created_at > ?`。`meta.changes === 1` なら 200 `{ok:true}`、それ以外は 409
  - `POST /m/launches/:id/answer`（pc）：本文 `{ ok: boolean; sealedAnswer: string }`。`claimed` の自分宛ての行だけ `started`/`failed` にする。それ以外は 409

- [ ] **Step 1: 落ちる試験を書く**
  - `スマホの依頼が宛先の PC の pull の launches に出て、ほかの PC には出ない`
  - `同じ id の依頼を 2 回出しても行は 1 つ`
  - `claim は 1 回目だけ 200、2 回目は 409`、`宛先でない PC の claim は 409`
  - `TTL を過ぎた依頼は pull に出ず、claim は 409、スマホの GET は expired`（時刻は harness の時計か `Date` の差し替えで進める。harness に時計が無ければ、行の `created_at` を D1 で直接古くする）
  - `answer の後、スマホの GET が started と sealedAnswer を返す`
  - `解除された PC 宛ての依頼は 404`
  - `同じスマホの 11 件目（10 分以内）は 429、同じ id の再送は数えない`
  - `ほかのスマホの依頼の GET は 404`
  - `版 6 の PC の pull でも応答の形は壊れない`（`launches` は余分な欄として無視される）
- [ ] **Step 2: 落ちるのを見る**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通るのを見る**（`--project cloud` 全部）
- [ ] **Step 5: コミット** — `feat(cloud): launch requests for the mobile app`

---

### Task 4: 受信箱の素を組む（サーバ、純粋な関数）

**Files:**
- Create: `packages/server/src/mobile/feed.ts`
- Test: `packages/server/src/mobile/feed.test.ts`

**Interfaces:**
- Consumes: Task 1 の型、`clampText`、`fitFeed`
- Produces:
  - `type FeedSources = { db: Db; deviceId: string; deviceName: string; live: LiveSession[]; accounts: Account[]; usageOf: (accountId: string) => UsageDto | null; now: number; tz?: string }`
  - `buildMobileFeed(src: FeedSources): MobileFeed`
  - 取り出しの規則：
    - `live`：この PC の実行中の run（`runs` の device_id が自分で終わっていない）を、`live` の状態と突き合わせる。`title` は `displayName`（`db/queries.ts`）、`intent` は `latestIntent`、`waiting` は `waitingFor` を `clampText`、`rcUrl` は Task 8 の表から（表がまだ無い段階では null）
    - `returns`：Paused で `return_on` が明日（この PC の日付）以前、かつ最後の run がこの PC のもの
    - `done`：`done_at >= now - 36 時間`、かつ最後の run がこの PC のもの。`oneLiner` は `session_summaries` の一言
    - `projects`：`project_roots` にこの PC の行がある（`deleted_at is null`）プロジェクト。`lastUsedAt` はそのプロジェクトの最後の run の開始時刻
    - `accounts`：`AccountStore.list()` と使用率
  - 「今日」の絞り込みはスマホが自分の日付でする（PC は少し広めに入れる）

- [ ] **Step 1: 落ちる試験を書く**（DB は既存の試験と同じく `openDb(':memory:')` 相当の道具で作る。題やプロジェクト名は `project-a`、`会話 1` のような作り物）
  - `入力待ちの run は waiting に問いの文が入り、300 字で切られる`
  - `ほかの PC の run は live に入らない`
  - `意図は最新の 1 つだけ`
  - `今日戻る Paused は returns に、明後日のものは入らない`
  - `Done は 36 時間以内だけ`、`最後の run がほかの PC の会話は returns と done に入らない`
  - `この PC に場所の無いプロジェクトは projects に入らない`
  - `同じ入力からは同じ JSON になる`（並び順を固定する：live は statusAt 降順、ほかは時刻の降順）
- [ ] **Step 2: 落ちるのを見る** — `npx vitest run --project server mobile/feed`
- [ ] **Step 3: 実装する。** SQL は索引のある列で引き、全表を読まない（`long-session-cpu` の教訓）。
- [ ] **Step 4: 通るのを見る**
- [ ] **Step 5: コミット** — `feat(server): build the mobile inbox feed`

---

### Task 5: 受信箱の素を書く（間引きと暗号化）

**Files:**
- Create: `packages/server/src/mobile/publisher.ts`, `packages/server/src/boot/mobile.ts`
- Modify: `packages/server/src/sync/client.ts`（`CloudClient` に任意の `putMobileFeed?`）, `packages/server/test/fake-cloud.ts`, `packages/server/src/mcp/tools.ts`（`setTurnIntentTool` の後に知らせる）, `packages/server/src/live/intents.ts`（`onIntent` の購読口）, 起動の組み立て（`boot/sync.ts` の隣で `bootMobile` を呼ぶ箇所）
- Test: `packages/server/src/mobile/publisher.test.ts`

**Interfaces:**
- Consumes: Task 4 の `buildMobileFeed`、Task 1 の `deriveMobileKey`・`seal`・`aadFeed`、`MOBILE_MIN_WORKER_COMPAT`
- Produces:
  - `CloudClient.putMobileFeed?(sealed: string): Promise<void>`（`PUT /m/feed`）
  - `onIntent(cb: (sessionId: string) => void): () => void`（`live/intents.ts`、`addIntent` の後に呼ぶ）
  - `class MobileFeedPublisher { constructor(deps: { build: () => MobileFeed; client: CloudClient; joinSecret: string; deviceId: string; timers: Timers; canWrite: () => boolean }); nudge(): void; start(): void; stop(): void; flushNow(): Promise<'written' | 'unchanged' | 'skipped'> }`
  - 定数：`FEED_DEBOUNCE_MS = 2_000`、`FEED_MIN_GAP_MS = 15_000`、`FEED_SAFETY_MS = 60_000`
  - `canWrite` は「同期が動いていて、`client.lastWorkerCompat() >= MOBILE_MIN_WORKER_COMPAT`、一時停止・解除・上限でない」（`canCarryTakeover` と同じ形の関数を `boot/sync.ts` に `canCarryMobile` として足す）
  - きっかけ：`RegistryWatcher.onChange`、`onIntent`、`onRowChange` のうち `sessions`・`session_states`・`session_summaries`・`runs`・`project_roots` の表、使用率の更新、60 秒の安全網

- [ ] **Step 1: 落ちる試験を書く**（`FakeTimers`、偽の client）
  - `nudge を 2 秒の間に 10 回呼んでも書き込みは 1 回`
  - `前の書き込みから 15 秒たつまで次を書かない`
  - `中身が同じなら書かない（unchanged）`
  - `canWrite が false（版 6 の Worker）なら書かない`
  - `書いた sealed は deriveMobileKey(joinSecret) と aadFeed(deviceId) で開ける`
  - `書き込みが失敗したら、次のきっかけでもう一度書く`（ハッシュを覚えない）
  - `stop の後は書かない`
- [ ] **Step 2: 落ちるのを見る**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通るのを見る**、`npm run typecheck`
- [ ] **Step 5: コミット** — `feat(server): publish the sealed mobile feed with throttling`

---

### Task 6: 起動の依頼を受けて起こす

**Files:**
- Create: `packages/server/src/mobile/launchInbox.ts`
- Modify: `packages/server/src/db/migrations.ts`（v29）, `packages/server/src/sync/engine.ts`（pull の応答の `launches` を受け手へ渡す）, `packages/server/src/sync/client.ts`（`claimLaunch?`、`answerLaunch?`）, `packages/server/test/fake-cloud.ts`, `packages/server/src/boot/mobile.ts`
- Test: `packages/server/src/mobile/launchInbox.test.ts`

**Interfaces:**
- Consumes: Task 3 の口、Task 1 の `open`・`seal`・`aadLaunch`・`aadAnswer`・`LAUNCH_TTL_MS`、`RunManager.start(params: LaunchParams): LaunchResult`
- Produces:
  - v29：`create table mobile_launches (id text primary key, handled_at integer not null, result text not null)`（同期しない）
  - `SyncListener.launches?(l: MobileLaunchOut[]): void`（engine が pull ごとに、`launches` が空でなければ呼ぶ）
  - `CloudClient.claimLaunch?(id: string): Promise<boolean>`（409 は false）、`CloudClient.answerLaunch?(id: string, ok: boolean, sealedAnswer: string): Promise<void>`
  - `class MobileLaunchInbox { constructor(deps: { db: Db; client: CloudClient; joinSecret: string; deviceId: string; start: (p: LaunchParams) => LaunchResult; hasProjectHere: (projectId: string) => boolean; hasAccount: (id: string) => boolean; now: () => number }); receive(l: MobileLaunchOut[]): Promise<void> }`
  - 1 件の扱いの順：手元の `mobile_launches` にあれば何もしない → `claimLaunch` が false なら何もしない → 開封（失敗は `bad-payload`）→ `createdAt` が `now - LAUNCH_TTL_MS - 5分` より古ければ `expired` → プロジェクト・アカウントの確かめ（`scratch` ならプロジェクトは見ない）→ `start({ projectId, scratch, account, permissionMode, model, prompt })` → `mobile_launches` に記録 → `answerLaunch`。応答の前に記録する（応答が失敗しても二度起こさない）
  - `receive` は直列化する（`TakeoverResponder.scan` と同じ鎖の作り）

- [ ] **Step 1: 落ちる試験を書く**
  - `正しい依頼で start が 1 回呼ばれ、答えに sessionId が入る`
  - `同じ依頼を 2 回 receive しても start は 1 回`（並行に 2 回呼んでも 1 回）
  - `claim が 409 なら start を呼ばない`
  - `別の秘密で封じた依頼は bad-payload と答え、start を呼ばない`
  - `AAD の宛先が自分でない依頼は bad-payload`（ほかの PC 宛てを付け替えたもの）
  - `この PC に場所の無いプロジェクトは project-missing`、`無いアカウントは account-missing`
  - `start が投げたら launch-failed と答え、mobile_launches に記録される`
  - `answerLaunch が失敗しても、次の receive で同じ依頼を起こさない`
  - `engine は pull の応答の launches を listener に渡す`（`engine.test.ts` に 1 本）
- [ ] **Step 2: 落ちるのを見る**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通るのを見る**、`npm run typecheck`
- [ ] **Step 5: コミット** — `feat(server): pick up launch requests from the phone`

---

### Task 7: 設定「会話を Claude アプリにつなぐ」と `--remote-control`

**Files:**
- Modify: `packages/server/src/config/paths.ts`（`Settings.remoteControl: boolean`、既定 true）, `packages/shared/src/api.ts`（`SettingsDto`）, `packages/server/src/http/routes/settings.ts`（DTO と PATCH の真偽のループ）, `packages/server/src/provider/claude-code/types.ts`（`LaunchInput.remoteControl?: string | null`）, `packages/server/src/provider/claude-code/launch/args.ts`, `packages/server/src/runs/manager.ts`（`baseInput`）, `packages/server/src/boot/runs.ts`（`injection` に `remoteControl`）
- Create: `packages/server/src/provider/claude-code/launch/remoteControl.ts`
- Test: `args.test.ts`、`paths.test.ts`、`routes/settings.test.ts`、`remoteControl.test.ts`

**Interfaces:**
- Produces:
  - `remoteControlName(o: { name?: string; prompt?: string; projectName?: string | null }): string` — 名前があればそれ、無ければ指示の先頭 40 字、それも無ければプロジェクト名（一覧の題の決め方 `displayName` と同じ順）
  - `remoteControlAllowed(o: { enabled: boolean; auth: AccountAuthDto | null; env: Record<string, string | undefined> }): boolean` — 設定が入、認証が claude.ai のログイン（`auth` の方式の欄。値は `accountAuth.ts` の読み取りに合わせる）、`ANTHROPIC_BASE_URL` と `ANTHROPIC_API_KEY` が空、のすべてで true
  - `buildClaudeArgs` は `remoteControl` が文字列なら `--remote-control <name>` を足す。start、resume、fork のどれでも付ける
- [ ] **Step 1: 落ちる試験を書く**
  - `args.test.ts`：`remoteControl が文字列なら --remote-control と名前が続く`、`null なら付かない`、`resume でも付く`
  - `remoteControl.test.ts`：`API キーの認証では false`、`ANTHROPIC_BASE_URL があれば false`、`auth が null（読めない）なら false`、`設定が切なら false`、`名前は name → 指示の先頭 40 字 → プロジェクト名`
  - `paths.test.ts`：`古い settings.json に remoteControl が無ければ true`
  - `routes/settings.test.ts`：`PATCH で remoteControl を false にできる、真偽以外は 400`
- [ ] **Step 2: 落ちるのを見る**
- [ ] **Step 3: 実装する。** アカウントの環境は起動の環境（`CLAUDE_CONFIG_DIR` を足した後）で判定する。
- [ ] **Step 4: 通るのを見る**、`npm run typecheck`
- [ ] **Step 5: コミット** — `feat(server): connect launched sessions to Remote Control`

---

### Task 8: `/rc` の URL を拾う

**Files:**
- Create: `packages/server/src/mobile/remoteUrl.ts`
- Modify: `packages/server/src/db/migrations.ts`（v30）, `packages/server/src/runs/manager.ts`（`--remote-control` を付けて起こした run で見張りを始める）, `packages/server/src/mobile/feed.ts`（`rcUrl` を読む）
- Test: `packages/server/src/mobile/remoteUrl.test.ts`

**Interfaces:**
- Consumes: `Tmux.capturePane`（`pane.ts` の `capture(name)`）
- Produces:
  - v30：`create table run_remote_urls (session_id text primary key, url text not null, at integer not null)`（同期しない。会話ごとに最新の 1 つ）
  - `extractRemoteUrl(screen: string): string | null` — 正規表現は `https://claude\.ai/code/session_[A-Za-z0-9]+`（Task 0 の実物。画面は `capture-pane -J` で折り返しをつないで読む。`pane.ts` の `capture` が `-J` を付けていなければ、付けた読み方を足す）。取り出した後に `isRemoteControlUrl` を通らなければ null
  - `watchRemoteUrl(o: { capture: () => string; onFound: (url: string) => void; timers: Timers; everyMs?: number; forMs?: number }): () => void`（既定 2 秒ごと、60 秒まで）
  - 見つけたら `run_remote_urls` に書き、`MobileFeedPublisher.nudge()` を呼ぶ
- [ ] **Step 1: 落ちる試験を書く**
  - `extractRemoteUrl`：Task 0 で記録した画面の行（題などを作り物に置き換えたもの）から URL を取り出す／URL の無い画面は null／`https://claude.ai.evil.example/code/x` のような偽の行は null／折り返しで途中の改行が入った URL は（実物で起きるなら）つなぐ
  - `watchRemoteUrl`：`3 回目の読みで見つかれば onFound が 1 回呼ばれ、以後は読まない`／`60 秒で諦める`／`stop を返す`
  - `feed.test.ts` に追記：`run_remote_urls にある会話は rcUrl が入る`
- [ ] **Step 2〜4: 落ちる→実装→通る**
- [ ] **Step 5: コミット** — `feat(server): capture the Remote Control URL from the pane`

---

### Task 9: PC の設定の画面（スマホをつなぐ、つなぐ設定）

Task 0 で選ばれた案で作る。

**Files:**
- Modify: `packages/server/src/http/routes/sync.ts`（`POST /api/sync/mobile-pairing`）, `packages/server/src/sync/client.ts`（`createPairing?`）, `packages/ui/src/runtime/api.ts`, `packages/ui/src/views/CloudMember.tsx`（A1：スマホの印、スマホの小見出しと QR の段）, `packages/ui/src/presenters/cloudMember.ts`, `packages/ui/src/presenters/settings.ts`, B1 の置き場所（一般の節の、起動に効く設定の並び。`InjectionSettings.tsx` の `askStatusAtEnd`・`liveHints` と同じ並び）, `packages/shared/src/i18n/{keys,ja,en}/settings.ts`, `packages/ui/src/styles/cloudMember.css`, `packages/ui/package.json`（`qrcode-generator@1.4.4`）
- Test: `packages/server/src/http/routes/sync.test.ts`, `packages/ui/src/views/CloudMember.test.tsx`, `packages/ui/src/views/SettingsScreen.test.tsx`

**Interfaces:**
- Produces:
  - `CloudClient.createPairing?(): Promise<MobilePairingResponse>`（`POST /m/pairings`）
  - `POST /api/sync/mobile-pairing` → `{ state: 'ready'; pairUrl: string; pairText: string; expiresAt: number } | { state: 'not-joined' } | { state: 'worker-too-old'; compat: number | null } | { state: 'rate-limited' }`。`pairText = encodePairing({ url, code, key: base64url(deriveMobileKeyBytes(joinSecret)), pcName: この PC の名前, expiresAt })`、`pairUrl = <url>/app/#pair=<pairText>`。押すたびに新しい券を取る（GET にしない）
  - `api.mobilePairing(): Promise<MobilePairingDto>`
- [ ] **Step 1: 落ちる試験を書く**
  - `sync.test.ts`：`参加していなければ not-joined`、`Worker の版が 6 なら worker-too-old`、`ready の pairText を decodePairing すると url と券と鍵が入り、参加の秘密の文字列はどこにも含まれない`、`鍵で封じたものを deriveMobileKey(joinSecret) で開ける`
  - `CloudMember.test.tsx`：`「スマホをつなぐ」を押すと QR（svg）と残り時間（5 分）と「この QR を人に見せない」旨の注意書きが出る`、`5 分たつと QR を薄くして「新しい QR を出す」を出す`、`QR を出している間に cloud-devices に新しい kind=mobile の行が現れたら「〈名前〉がつながりました」を出し、表に行が増える`、`「文字列をコピー」で pairText がクリップボードに入る`、`QR を閉じたら 3 秒ごとの読み直しが止まる`、`kind=mobile の行に「スマホ」の印が出て、解除のボタンがある`、`worker-too-old では QR を出さず、更新を促す文を出す`、`スマホを外す確認に「外したスマホは戻れない。スマホからは選んだ権限モードで全部の PC に会話を起こせるので、なくしたらすぐ外す」旨の文がある`
  - `SettingsScreen.test.tsx`：`「会話を Claude アプリにつなぐ」の切り替えが PATCH { remoteControl } を送る`
- [ ] **Step 2〜4: 落ちる→実装→通る**。文言は ja と en の両方に足す。
- [ ] **Step 5: 画面を撮って自分で見る**（memory の reference-overlay-ui-check の手順。読むだけ、押さない）
- [ ] **Step 6: コミット** — `feat(ui): pair a phone and toggle Remote Control in settings`

---

### Task 10: スマホの PWA の骨組みと受信箱

**Files:**
- Create: `packages/mobile/`（`package.json` 名 `@agent-hangar/mobile`、`vite.config.ts`（`base: '/app/'`、出力 `dist/app`）、`vitest.config.ts`（jsdom）、`index.html`、`public/manifest.webmanifest`、`public/sw.js`、`public/icon-192.png`・`icon-512.png`・`apple-touch-icon.png`、`src/main.tsx`、`src/store.ts`、`src/api.ts`、`src/inbox.ts`、`src/views/JoinScreen.tsx`、`src/views/InboxScreen.tsx`、`src/styles.css`）
- Modify: ルートの `package.json`（workspaces は `packages/*` で自動。`tsconfig` の参照があれば足す）
- Test: `packages/mobile/src/inbox.test.ts`, `packages/mobile/src/store.test.ts`, `packages/mobile/src/views/InboxScreen.test.tsx`, `packages/mobile/src/views/JoinScreen.test.tsx`

**Interfaces:**
- Consumes: Task 1 の型と暗号、Task 2 の `POST /m/join`・`GET /m/inbox`
- Produces:
  - `store.ts`：`type Pairing = { url: string; token: string; deviceId: string }`、`loadPairing(): Pairing | null`、`savePairing(p: Pairing): void`、`clearPairing(): void`（`localStorage`、読み書きは try/catch）。`loadKey(): Promise<CryptoKey | null>`、`saveKey(k: CryptoKey): Promise<void>`（IndexedDB に non-extractable の `CryptoKey` をそのまま入れる）
  - `api.ts`：`joinPhone(pairText: string, name: string): Promise<{ pairing: Pairing; key: CryptoKey }>`（`decodePairing` → `importMobileKey(key, false)` → `POST /m/join`）、`fetchInbox(p: Pairing): Promise<MobileInboxResponse>`（401 は `UnpairedError`）
  - `inbox.ts`：`type InboxView = { waiting: Row[]; running: Row[]; returning: Row[]; doneToday: Row[]; devices: DeviceAlive[]; unreadable: string[] }`、`openInbox(res: MobileInboxResponse, key: CryptoKey, now: Date): Promise<InboxView>`
    - 復号できない PC の分は `unreadable` に PC 名を入れ、ほかは続ける
    - `now - lastSeenAt > PEER_STALE_MS` の PC の live は、状態を `unknown` にして running の末尾へ（waiting にも出さない）
    - 「今日」はスマホの日付。returns は `returnOn` が今日のもの、done は `doneAt` が今日のもの
    - 同じ sessionId が複数の PC から来たら、live を優先し、次に新しい時刻のもの
  - 行を押すと、`rcUrl` が `isRemoteControlUrl` を通ればそれを、通らなければ `https://claude.ai/code` を開く（PC から来た値も信じない）
  - 読み直し：開いたとき、`visibilitychange` で見えたとき、下に引いたとき、見えている間 30 秒ごと
  - `#pair=` 付きで開かれたら、まずフラグメントを `history.replaceState` で消して手元の変数に持ち、JoinScreen で端末名を入れて参加する
  - すべての feed が開けないとき（秘密の作り直しの後）は「つなぎ直してください」と出す
  - 参加の画面は「画面のメモ」の C1 の①〜④。④の「カメラで QR を読む」は `src/scanQr.ts` の `scanQr(video: HTMLVideoElement, signal: AbortSignal): Promise<string>`（`jsqr` で `#pair=` を含む文字列が読めたら返す）。試験は jsQR を偽物に差し替えて、読めた文字列で参加の流れに入ることだけを見る

- [ ] **Step 1: 落ちる試験を書く**
  - `inbox.test.ts`：`waiting は statusAt の古い順（長く待っているものが上）`、`3 分見ていない PC の会話は unknown で running の末尾、waiting に出ない`、`開けない PC は unreadable に入り、ほかの PC の行は出る`、`今日戻るは returnOn が今日のものだけ`、`同じ会話が 2 つの PC から来たら live の方`
  - `store.test.ts`：`localStorage が投げても loadPairing は null を返す`、`saveKey した鍵を loadKey で取り出して開封に使え、exportKey は失敗する`（jsdom に IndexedDB が無ければ `fake-indexeddb` を dev 依存に足す）
  - `JoinScreen.test.tsx`：`#pair= で開くと参加の前にフラグメントが消える`、`参加すると savePairing と saveKey が呼ばれ、localStorage に鍵の文字列が残らない`、`つなぐ文字列を貼る欄から参加できる`、`使用済み・期限切れの券（401）は「QR を出し直してください」と出す`
  - `InboxScreen.test.tsx`：`見出しが「あなたの番 N」`、`待っている内容の 1 行と PC 名が出る`、`rcUrl の無い行は claude.ai/code へのリンク`、`401 なら参加の画面に戻る`、`題・待っている内容・意図に <img src=x onerror=...> が入っていても img 要素は作られず文字として出る`、`rcUrl が javascript: や別のホストなら claude.ai/code へのリンクになる`、`全部の feed が開けなければ「つなぎ直してください」`
  - `packages/mobile/src/noInnerHtml.test.ts`：`src/ の中に dangerouslySetInnerHTML と innerHTML の代入が無い`（ファイルを読んで grep する試験）
- [ ] **Step 2〜4: 落ちる→実装→通る**。見た目は「画面のメモ」（Task 0）どおり。色の値は `packages/ui/src/styles/tokens.css` から写す。暗い配色の指定を書かない。
- [ ] **Step 5: 端末幅（390×844）で撮って自分で見る**（`npm run dev -w @agent-hangar/mobile` と偽の inbox の応答。Playwright の route で `/m/inbox` を差し替える）
- [ ] **Step 6: コミット** — `feat(mobile): PWA shell, pairing and the inbox`

---

### Task 11: スマホの「新しい会話」

**Files:**
- Create: `packages/mobile/src/launch.ts`, `packages/mobile/src/views/NewSessionScreen.tsx`
- Modify: `packages/mobile/src/api.ts`, `packages/mobile/src/main.tsx`
- Test: `packages/mobile/src/launch.test.ts`, `packages/mobile/src/views/NewSessionScreen.test.tsx`

**Interfaces:**
- Consumes: Task 3 の `POST /m/launches`・`GET /m/launches/:id`、Task 10 の `InboxView` と `openInbox` が読んだ feed、Task 1 の `PERMISSION_MODE_VALUES`・`MODEL_CHOICES`・`aadLaunch`・`aadAnswer`
- Produces:
  - `launchChoices(feeds: MobileFeed[], alive: Set<string>): { projects: (MobileProject & { deviceIds: string[] })[]; scratchDeviceIds: string[]; accountsOf: (deviceId: string) => MobileAccount[] }` — プロジェクトは全 PC の和（同じ id は `lastUsedAt` の新しい方）、最近使った順。PC は場所を持ち生きているものだけ。「すぐ始める（フォルダなし）」はプロジェクトの並びの先頭に置き、生きている PC ならどれでも選べる（`scratchDeviceIds`）
  - `requestLaunch(p: Pairing, key: CryptoKey, o: { targetDevice: string; payload: Omit<MobileLaunchPayload, 'v' | 'createdAt'> }): Promise<string>`（id は `crypto.randomUUID()`）
  - `waitLaunch(p: Pairing, key: CryptoKey, id: string, o: { everyMs?: number; giveUpMs?: number; onStage: (s: 'waiting' | 'started' | 'failed' | 'expired', a?: MobileLaunchAnswer) => void }): () => void`（既定 3 秒ごと、80 秒で expired）
  - 画面の流れ：「〈PC〉で始める」→「〈PC〉が受け取るのを待っています（最大 30 秒ほど）」→「始まりました」→ 受信箱へ戻る。時間切れ・失敗は理由を文で出す
- [ ] **Step 1: 落ちる試験を書く**
  - `launch.test.ts`：`場所の無い PC と 3 分見ていない PC は選べない`、`すぐ始めるは生きている PC ならどれでも選べ、依頼は projectId null・scratch true`、`アカウントは選んだ PC のものだけ`、`requestLaunch の sealed は aadLaunch(id, targetDevice) で開け、createdAt が入る`、`waitLaunch は started で止まり答えを渡す`、`80 秒で expired`
  - `NewSessionScreen.test.tsx`：`4 つを選んで始めると「受け取るのを待っています」→「始まりました」`、`最初の指示が空なら始められない`、`project-missing の答えは「その PC にプロジェクトの場所がありません」と出る`、`権限モードの選択肢が PC のダイアログと同じ 7 つ`
- [ ] **Step 2〜4: 落ちる→実装→通る**
- [ ] **Step 5: 端末幅で撮って自分で見る**
- [ ] **Step 6: コミット** — `feat(mobile): start a session on a chosen PC`

---

### Task 12: 配信（Worker の静的ファイル）と配備

**Files:**
- Modify: `packages/cli/src/cloud.ts`（`writeWranglerConfig` に `assets: { directory: <mobile の dist> }`、`runSetupCloud` が配備の前に `npm run build -w @agent-hangar/mobile` を回す）, `packages/cloud/wrangler.jsonc`（開発用にも同じ `assets`）, `packages/mobile/package.json`（`build`）
- Create: `packages/mobile/public/_headers`（`/app/*` に、決定の表「画面の守り」の CSP と `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`）
- Test: `packages/cli/src/cloud.test.ts`（`writeWranglerConfig` の出力）

**Interfaces:**
- Produces：`writeWranglerConfig(home, { name, main, dbName, dbId, bucketName, assetsDir })` の `assetsDir`。配信は `/app/` 以下、API は `/m/`。Worker のコードは静的ファイルの経路を持たない（`assets` が先に当たる）
- [ ] **Step 1: 落ちる試験を書く** — `書いた wrangler.jsonc の assets.directory が mobile の dist を指す`、`mobile の dist が無いときは build を回してから配備する`（コマンドの呼び出しを記録する偽物で）
- [ ] **Step 2〜4: 落ちる→実装→通る**
- [ ] **Step 5: 手元で `wrangler dev --config packages/cloud/wrangler.jsonc` を起こし、`/app/` が index.html を返し、`/app/manifest.webmanifest` の content-type が manifest であること、`/app/` の応答に CSP の見出しが付くことを curl で確かめる**（ローカルだけ、クラウドに触らない）。build 後の `dist/app/index.html` にインラインの `<script>` が無いこと（CSP で止まるため）も見る
- [ ] **Step 6: コミット** — `feat(cloud): serve the mobile app from the Worker`

---

### Task 13: 文書

**Files:**
- Modify: `docs/design.md`（「クラウド同期」に「スマホ」の節：表 3 つ、トークンの種類、ペアリング券、暗号の鍵と AAD、依頼の握手、回数の制限、CSP、互換の版 7、書き込みと読み取りの見積もり）, `docs/cloud-sync.md`（割り切りに「スマホは参加の秘密を持たず、スマホ用の鍵と券で参加する」「スマホからは承諾なしで、選んだ権限モードの会話を全部の PC に起こせる。なくしたらすぐ外す」「Worker が配る画面の暗号は、Cloudflare のアカウントを取られて画面を差し替えられると守れない」「秘密を作り直すとスマホはつなぎ直し」）, `README`（スマホの使い方の短い節。あれば）

- [ ] **Step 1: 見積もりを書く。** 書き込み：1 台 1 日、受信箱の素は変化のたび（実際には 1 日 1,000 行前後の見込み、15 秒の間隔での上限は 5,760 行）、依頼は 1 回につき 3 行。読み取り：受信箱 1 回で PC の数×2 行程度、30 秒ごとに 1 日開けっぱなしでも 3 万行。pull の依頼の引きは索引で、該当の行の数だけ。無料枠（書き込み 10 万行・読み取り 500 万行／日）との比を書く。実測は Task 14 で埋める欄を残す。
- [ ] **Step 2: コミット** — `docs: mobile inbox and remote launch`

---

### Task 14: 確かめと出荷（CLAUDE.local.md の 3〜6 節）

- [ ] **Step 1:** `npm run typecheck`、`npm test`（全部）
- [ ] **Step 2:** build 3 本（`npm run build`、`npm run bundle-server -w apps/desktop`、Homebrew の cargo を先頭にした tauri build）
- [ ] **Step 3:** PR、CI 3 ジョブ緑でマージ、/Applications の入れ替え（空の環境から起動）
- [ ] **Step 4: 実物のクラウド（利用者に聞いてから）。** Worker の配備（`hangar setup cloud` の再配備。D1 の書き込みは配備で数十行）。見積もりを添えて聞く。
- [ ] **Step 5: 実物で確かめる（利用者と）。** 設計書の「実物で確かめること」の残り 3 つ（2 つ目のアカウントは Task 0 で確かめ済み）：`/rc` の URL をスマホで押して Claude アプリで開くか／iPhone の「ホーム画面に追加」の見え方と、参加が持ち越されるか（持ち越されなければ貼る欄で参加できるか）／入れた翌日の D1 の書き込みと読み取りの実測（`GET /usage` か設定の使用量の画面）を docs の見積もりの欄に書く。

---

## 画面のメモ

試作は `~/workspace/hangar-explainers/mobile-pwa-2026-10-17/mobile-pairing-proto.html`。利用者が 2026-10-17 に選んだもの：

- **A1**：クラウドの節の「参加している端末」の表の下に「スマホ」の小見出しと「スマホをつなぐ」。押すと節の中に QR の段が開く（左に QR、右に 3 つの手順、残り時間の棒、「この QR を人に見せない」の黄色の帯、「文字列をコピー」「閉じる」）。5 分過ぎたら QR を薄くして「新しい QR を出す」。スマホが参加したら QR の上に「〈名前〉がつながりました／この QR はもう使えません」、表に「スマホ」の札つきの行が増える（参加の検知は `cloud-devices` の再読み込み。QR を出している間だけ 3 秒ごと）。スマホも PC と同じ表、同じ「外す」。外す確認の文は試作のとおり。
- **B1**：一般の「会話を起こすとき」の並びに「会話を Claude アプリにつなぐ」（説明「hangar から起こした会話を、スマホの Claude アプリや claude.ai/code から開いて続けられるようにする。claude.ai でログインしたアカウントだけ。API キーのアカウントでは付けずに起こす。」）。スマホの節に「この設定は一般にあります」の 1 行。
- **C1**：①QR を読んだ直後の 1 枚（つなぐ先の Worker のホスト、QR を出した PC と残り時間、スマホの名前（既定 iPhone／Android など UA から）、「つなぐ」）、②「つながりました」とホーム画面に追加の 3 手順と「あとで（このまま受信箱へ）」、③期限切れ・使用済み、④ホーム画面から開いたらつながっていなかった（「カメラで QR を読む」と「つなぐ文字列を貼る」）。

試作から増えたもの：

- `PairingBlob` に `pcName: string` と `expiresAt: number` を足す（Task 1、Task 9）。秘密ではない。
- ④のアプリ内の QR 読み取り（Task 10）：`getUserMedia` と `jsqr@1.4.0`。iOS の Safari には `BarcodeDetector` が無い。CSP に `media-src 'self' blob:` を足す。

### `/rc` の実物（Task 0 の Step 1、2026-10-17、claude 2.1.301）

- `claude --remote-control <名前>` で起こすと、起動直後の見出しの 4 行目に `/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_<英数字 24 字前後>` が出る。見出しの 3 行目の末尾には `· /rc` または `· /rc active`。URL の正規表現は `https://claude\.ai/code/session_[A-Za-z0-9]+`。画面の幅で折り返すので、読むときは `capture-pane -J`（折り返しをつなぐ）で読む。
- 既定のアカウント（`CLAUDE_CONFIG_DIR` なし、Max）と 2 つ目のアカウント（`CLAUDE_CONFIG_DIR=~/.claude-univ`、Enterprise）の両方でつながった。Enterprise の組織の設定で切られている場合は未確認。
- API キーで認証した claude は、`--remote-control` を黙って無視して普通に起動した（`/rc` の表示が出ないだけで、失敗しない）。Task 7 の門は「付けても害は無いが、URL は出ない」ことを踏まえ、そのまま保守的に残す。
- 注意：`CLAUDE_CONFIG_DIR=~/.claude` と既定の場所を明示すると、未ログイン扱いになる（キーチェーンの引き方が変わる）。既定のアカウントには `CLAUDE_CONFIG_DIR` を付けない今の作りを崩さないこと。
- 下調べで、手元の `~/.claude-univ/.claude.json` に偽の API キーの承認が 1 件入ったので外した（`customApiKeyResponses.approved` を空に戻した）。

### Design キャンバスの 2 枚（Task 0 の Step 2）

両方とも 390×844。地は `#eef1f7`、字は `#1c1b2e`、札は白・角 16px・線 `#e2e4ee`。本文は 14px、PC の hangar と同じ色の値。

**受信箱（Main）**
- 頭：大きな見出し「あなたの番 N」（26px・太字）と右に日付（12px・`#5f5e78`）。その下の 1 行に PC ごとの生存「● Mac 1 分前」（緑の丸 `#3a8f5c`。3 分を過ぎた PC は灰色の丸と「不明」）。
- あなたの番の札：上の段にアカウントの色の丸・プロジェクト名（太字）・「· 会話の題」・右寄せで待った時間（`#a2452f`、等幅、例「7時間4分」）。中の段に待っている内容（16px・太字）。下の段に補い（13px・`#5f5e78`）＝ PC 名と、許可待ちならツールの種類。
  - 試作にある「行の中の選択肢で答える」「これまでの流れを見る」は作らない（設計の変更で `/rc` に任せた）。札全体を押すと `/rc` の URL（無ければ claude.ai/code）を開く。札の右下に「Claude アプリで開く ›」。
  - 試作の「片付け」の札（まとめて Done）は作らない（スマホからの状態の変更は目標外）。
- 小見出し（12px・`#6e6d88`・字間 0.04em）で区切った細い行（白・角 12px・高さ 44px 前後）：「動いている」（橙の丸 `#c77a1a`、意図の 1 行、右に「PC · 40 分」）、「今日戻る」（設計にあり試作に無い。しおりの色 `#8a5a0b` の丸、題、右に戻る時刻）、「今日終わった」（緑の丸 `#2b7048`、要約の 1 行、右に終わった時刻）。
- 下に固定の白い帯と黒（`#1c1b2e`）の大きなボタン「＋ 新しい会話」（高さ 48px・角 14px）。
- 何も無いとき（試作の「さばき終わった受信箱」の 1 枚）は、あなたの番の場所に「待っている会話はありません」。

**新しい会話（NewSession）**
- 頭：左に「閉じる」、中央に「新しい会話」。
- 札のボタンの組（高さ 44px・角 12px・選ばれたら線 `#4a63e8` 1.5px と地 `#eef2ff` と太字）を縦に：プロジェクト（色の丸つき）／PC（副題「動いている 1」「空いている」、3 分見ていない PC は出さない）／アカウント（その PC のもの、副題「5時間 32%」）。設計にあり試作に無い「権限モード」「モデル」も同じ札の組で足す（既定は「既定」）。
- 試作のプロジェクトの並びには「すぐ始める（フォルダなし）」がある。これは入れる：依頼の `projectId` を null、`scratch: true` にする（Task 1 の型と Task 6 の受け取りに反映）。
- 最初の指示の欄（4 行、15px）。試作の下の小さな札（「TODO の先頭をやって」など）は作らない。
- 下の白い帯に青の大きなボタン「〈PC〉で始める」（高さ 50px）。押した後は同じ場所に「〈PC〉が受け取るのを待っています（最大 30 秒ほど）」→「〈PC〉で始めた。受信箱の『動いている』に出る」と「受信箱へ ›」。時間切れ・失敗は理由の文。
