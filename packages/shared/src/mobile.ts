import type { LiveStatus, WaitKind } from './api.ts';
import type { ModelCostKind, ModelDataUse } from './modelFacts.ts';
import type { AgentKind } from './agents.ts';
import type { OpencodeModeOption } from './opencodeOptions.ts';

/** 文は 300 字で切る（待っている内容、意図、要約の 1 行）。 */
export const MOBILE_TEXT_MAX = 300;
/** 起動の依頼の最初の指示の上限（字数）。スマホの入力欄と PC の受け取りが同じ値を使う。 */
export const MOBILE_PROMPT_MAX = 8_000;
/** 起動の依頼に入る ID（プロジェクト、アカウント）の上限（字数）。 */
export const MOBILE_LAUNCH_ID_MAX = 128;
/** 受信箱の素（暗号化の前の JSON）の上限。超えたら done、returns、projects の順に古いものから落とす。 */
export const MOBILE_FEED_MAX_BYTES = 48 * 1024;
/** 起動の依頼の有効期間。Worker はこれを過ぎた依頼を claim させない。PC の pull は 30 秒ごとなので 2 周分の余裕を見る。 */
export const LAUNCH_TTL_MS = 75_000;
/** Worker が最後に見てからこの時間を過ぎた PC は「不明」。 */
export const PEER_STALE_MS = 180_000;
/** 画像 1 枚の上限（縮めた後のバイト数）。封の分（28 バイト）は Worker が足して受ける。 */
export const MOBILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** 1 件の起動の依頼に付けられる画像の枚数。 */
export const MOBILE_IMAGES_PER_LAUNCH = 4;
/** 1 台のスマホが R2 に置いたままにできる画像の枚数。 */
export const MOBILE_IMAGES_PER_PHONE = 40;
/** 呼び鈴の問い合わせ（封をした本文）の上限。 */
export const MOBILE_ASK_MAX_BYTES = 4 * 1024;
/** 呼び鈴の答え（封をした本文）の上限。 */
export const MOBILE_REPLY_MAX_BYTES = 64 * 1024;
/** 問い合わせを PC に渡してから答えを待つ時間。超えたら Worker が 504 を返す。 */
export const MOBILE_ASK_TIMEOUT_MS = 5_000;

export type MobileWaiting = { kind: WaitKind; text: string };

/**
 * Claude Code 以外のエージェントの印（opencode の行にだけ付ける）。
 * Claude の行には付けない。古い PC の素と同じ形にし、バイトも節約するためである。古いスマホは読み捨てる。
 */
export type MobileAgent = Exclude<AgentKind, 'claude-code'>;

/**
 * 実行中の opencode の行の使用量（server の session_live_stats から）。
 * ctx はコンテキストの使用率（0 から 100 の整数）で、モデルの上限が分からなければ null。tokens は使ったコンテキストのトークン数。
 * cost は米ドルで、分からなければ null。model は opencode のモデルの ID（provider/model）。
 */
export type MobileUsage = { ctx: number | null; tokens: number; cost: number | null; model: string };

export type MobileLiveItem = {
  sessionId: string;
  projectId: string | null;
  projectName: string;
  title: string;
  accountId: string;
  status: LiveStatus;
  statusAt: number;
  startedAt: number;
  waiting: MobileWaiting | null;
  intent: string | null;
  rcUrl: string | null;
  /** Claude Code 以外のエージェントの行だけに付く。無ければ Claude Code。 */
  agent?: MobileAgent;
  /** 使用量。opencode の行で、使った量が分かるときだけ付く。fitFeed は収まらないときに真っ先に削る。 */
  usage?: MobileUsage;
};

export type MobileReturnItem = { sessionId: string; projectName: string; title: string; accountId: string; returnOn: string; returnTime: string | null; agent?: MobileAgent };
export type MobileDoneItem = { sessionId: string; projectName: string; title: string; oneLiner: string | null; doneAt: number; agent?: MobileAgent };
export type MobileAccount = { id: string; name: string; color: string; fiveHour: number | null; sevenDay: number | null };
export type MobileProject = { id: string; name: string; lastUsedAt: number | null };

/**
 * PC の hangar ができること（rc.2 で足した）。
 * asks は `/` と `@` の問い合わせに答えること、images は起動の依頼の画像を受け取ること、effort は依頼の effort を効かせること。
 * rc.1 の PC は caps を載せず、依頼の images と effort を黙って捨てるので、スマホは caps の無い PC にそれらを出さない。
 *
 * agents は、この PC で起こせるエージェント（0.10.0 で足した）。opencode と Codex は、PC の設定で有効にしているときだけ載せる。
 * 無ければ Claude Code だけの PC である。古い PC は依頼の知らない欄（agent）を断らずに Claude を起こしてしまうので、スマホは agents にそのエージェントのある PC にだけ、そのエージェントの依頼を出す。
 */
export type MobileCaps = { asks: boolean; images: boolean; effort: boolean; agents?: AgentKind[] };

/** 1 台の PC が Worker に預ける受信箱の素。暗号化して置くので、Worker は中身を読めない。 */
export type MobileFeed = {
  v: 1;
  deviceId: string;
  deviceName: string;
  /** この PC ができること。無ければ rc.1 の PC。 */
  caps?: MobileCaps;
  accounts: MobileAccount[];
  projects: MobileProject[];
  live: MobileLiveItem[];
  returns: MobileReturnItem[];
  done: MobileDoneItem[];
};

/** 起動の依頼に付ける画像 1 枚の控え。本体は R2 に封をして置き、番号（0 から 3）で引く。 */
export type MobileImageRef = { n: number; mime: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: number };

/** スマホから PC への起動の依頼（暗号化して運ぶ）。scratch が true のとき projectId は null（「すぐ始める」）。 */
export type MobileLaunchPayload = {
  v: 1;
  createdAt: number;
  projectId: string | null;
  scratch: boolean;
  accountId: string;
  permissionMode: string;
  model: string;
  prompt: string;
  /** EFFORT_VALUES のどれか。無ければ既定。 */
  effort?: string;
  /** 付けた画像。依頼は画像を全部置いてから出す。 */
  images?: MobileImageRef[];
  /**
   * 起こすエージェント（0.10.0 で足した）。無ければ Claude Code。
   * スマホは caps.agents に opencode のある PC にだけ opencode を送る。古い PC は知らない欄を断らずに Claude を起こすからである。
   * opencode のとき、accountId と permissionMode は空、effort は無い。PC はこれが崩れた依頼を断る。
   * codex のとき、accountId は空で、permissionMode は Codex の権限（CODEX_PERMISSIONS。空は自動）、model は Codex のモデルの slug（空は既定）、effort は推論の段階（無ければ既定）。mode と autoApprove は無い。
   */
  agent?: MobileLaunchAgent;
  /** opencode のモード（primary のエージェント。build、plan など）。無ければ opencode の既定。MOBILE_MODE_RE の形だけ。 */
  mode?: string;
  /** opencode の自動承認（--auto）。真なら deny 以外をすべて許可する。 */
  autoApprove?: boolean;
};

/** 起動の依頼で選べるエージェント。 */
export type MobileLaunchAgent = AgentKind;

/** opencode のモードの ID の形。--agent に渡る値なので、引数に読まれる形と空白を断る。 */
export const MOBILE_MODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** モードの ID として通る値か。 */
export const isMobileMode = (v: unknown): v is string => typeof v === 'string' && MOBILE_MODE_RE.test(v);

export type MobileLaunchAnswer =
  | { ok: true; sessionId: string; title: string }
  | { ok: false; reason: 'project-missing' | 'account-missing' | 'agent-missing' | 'bad-payload' | 'expired' | 'launch-failed' | 'images-missing'; detail?: string };

/**
 * スマホから PC への問い合わせ（封の中身。AAD は aadAsk）。`@` のファイル、`/` の候補、opencode の選択肢。
 * commands の agent が opencode なら、accountId は空で、PC は opencode のコマンドとスキルを返す。
 * agent-options は opencode のモードとモデル（0.10.0 で足した）。PC は手元に持った一覧を答え、取りに行かない（呼び鈴は 5 秒しか待てない）。
 */
export type MobileAsk =
  | { v: 1; kind: 'files'; projectId: string; q: string }
  | { v: 1; kind: 'commands'; projectId: string | null; accountId: string; agent?: MobileAgent }
  | { v: 1; kind: 'agent-options'; agent: MobileAgent; projectId: string | null };

/** 答えの opencode のモデルの件数の上限と、名前の字数の上限。 */
export const MOBILE_AGENT_MODELS_MAX = 100;
export const MOBILE_AGENT_LABEL_MAX = 60;
/** 答えの opencode のモードの件数の上限。 */
export const MOBILE_AGENT_MODES_MAX = 20;
/** 答えの Codex のモデルの件数の上限と、モデル 1 つの推論の段階の件数の上限。 */
export const MOBILE_CODEX_MODELS_MAX = 40;
export const MOBILE_CODEX_EFFORTS_MAX = 8;

/**
 * スマホに渡す Codex のモデル 1 つ。id は起動の model に入れる slug、efforts はそのモデルで選べる推論の段階（Codex の並びのまま）、defaultEffort は既定の段階（分からなければ null）。
 * PC の CodexOptionsDto から、説明の文を落として縮めたもの（呼び鈴の答えは 64KB に収める）。
 */
export type MobileCodexModel = { id: string; label: string; efforts: string[]; defaultEffort: string | null };

/** スマホに渡す Codex の選択肢。stale は、PC が最後に取ってから間が空いた一覧であること。権限の 3 段は固定なので載せない（CODEX_PERMISSIONS）。 */
export type MobileCodexOptions = { version: string | null; verified: boolean; models: MobileCodexModel[]; stale: boolean; fetchedAt: number };

/**
 * スマホに渡す opencode のモデル 1 つ。id は `provider/model`、label は opencode の表示名、group はプロバイダーの表示名。
 * cost は費用の型、data はデータの扱い（分からなければ null）で、PC がモデルの小窓と同じ決め方で付ける。ツール呼び出しに対応しないモデルは載せない。
 */
export type MobileModelOption = { id: string; label: string; group: string; cost: ModelCostKind; data: ModelDataUse | null };

/**
 * スマホに渡す opencode の選択肢（PC の OpencodeOptionsDto を縮めたもの）。
 * stale は、PC が最後に取ってから間が空いた一覧であること。fetchedAt は PC が取った時刻（ミリ秒）。
 */
export type MobileAgentOptions = {
  version: string | null;
  verified: boolean;
  modes: OpencodeModeOption[];
  models: MobileModelOption[];
  defaultModel: string | null;
  stale: boolean;
  fetchedAt: number;
};

/**
 * PC の答え（封の中身。AAD は aadReply）。
 * agentOptions と codexOptions が null なのは、PC がまだ一覧を持っていないとき。agent-missing は、PC でそのエージェントを使えない（無効か、見つからない）とき。
 */
export type MobileReply =
  | { files: { path: string; changed: boolean }[] }
  | { commands: { name: string; description: string; kind: 'skill' | 'command' }[] }
  | { agentOptions: MobileAgentOptions | null }
  | { codexOptions: MobileCodexOptions | null }
  | { error: 'project-missing' | 'account-missing' | 'agent-missing' | 'bad-request' };

/**
 * スマホのトークンは、この時間使わないと失効する（互換の版 9）。使うたびに延びる。
 * 判定は Worker の時計と `devices.last_seen_at`（無ければ `joined_at`）で行う。`last_seen_at` は 1 分おきにしか書かないので、最大 1 分早く失効しうる。
 */
export const PHONE_IDLE_MS = 30 * 86_400_000;
/** スマホのトークンは、接続からこの時間で失効し、接続し直しが要る（互換の版 9）。`devices.expires_at` に置く。 */
export const PHONE_MAX_AGE_MS = 90 * 86_400_000;
/** 期限を過ぎたトークン（スマホの 30 日と 90 日）に、Worker が 401 で返す本文の error。トークンが合ったときにだけ返す。 */
export const EXPIRED_ERROR = 'expired';

/**
 * Worker の口の型。
 * `epoch` はスマホ用の鍵 `M[m]` の世代である（互換の版 9）。PC の世代鍵の世代とは別の番号で、1 から数える。
 * 封じた値（`sealed`、`sealedAnswer`）は Worker が読まない。
 */
export type MobilePairingResponse = { code: string; expiresAt: number };
/**
 * スマホの接続（`POST /m/join`、トークンなし、互換の版 9）。
 * `deviceId` はスマホが名乗る ID で、PC はこの ID 宛てにスマホ用の鍵の keybox を封じる。既にある ID（解除した行も）は 409 `device-exists`。
 * `sealed` はペアリングの券から導いた鍵でスマホの `{ pub, name }` を封じたもの（base64url）で、発行した PC だけが開ける。
 * 応答は 201 の `MobileJoinResponse`。トークンの期限は接続から PHONE_MAX_AGE_MS。
 */
export type MobileJoinRequest = { code: string; deviceId: string; sealed: string };
export type MobileJoinResponse = { token: string; deviceId: string };
/**
 * 券を発行した PC が見る、接続してきたスマホの参加リクエスト（`GET /m/pairings/mine`）。
 * 自分の券のうち、まだ keybox の置かれていないリクエストだけを、接続の古い順に返す。無ければ空の配列。
 * `PUT /phone-keyboxes` でそのスマホ宛ての keybox を置くと、リクエストは D1 から消え、ここにも出なくなる。
 */
export type MobilePairingRequest = { codeHash: string; deviceId: string; sealed: string; joinedAt: number };
export type MobilePairingsMine = { pairings: MobilePairingRequest[] };
/** PC が受信箱の素を置く（`PUT /m/feed`）。`epoch` は素を封じたスマホ用の鍵の世代。 */
export type MobileFeedPut = { sealed: string; epoch: number };
export type MobileInboxResponse = {
  now: number;
  devices: { id: string; name: string; platform: string; lastSeenAt: number | null }[];
  feeds: { deviceId: string; updatedAt: number; sealed: string; epoch: number }[];
};
/** スマホの起動の依頼（`POST /m/launches`）。依頼の画像（`/m/blobs`）も同じ世代で封じる。 */
export type MobileLaunchIn = { id: string; targetDevice: string; sealed: string; epoch: number };
/**
 * POST /m/ask の本文と答え。sealed は封をした文字列で、Worker と Durable Object は読まない。
 * Durable Object は PC の WebSocket に `{ t: 'ask', id, sealed, epoch }` で渡し、PC は同じ世代で答えを封じる。
 */
export type MobileAskIn = { id: string; targetDevice: string; sealed: string; epoch: number };
export type MobileAskOut = { sealed: string };
/**
 * PC の pull に添える起動の依頼（`GET /changes` の launches）。
 * from は依頼を置いたスマホの ID で、Worker が端末トークンで知るもの（スマホが名乗るものではない）。
 * PC はこれで名簿のスマホの名前を引き、右下の通知「〈スマホの名前〉から起動」に使う（試作 F1）。from を返さない Worker もあるので省ける。
 */
export type MobileLaunchOut = { id: string; createdAt: number; sealed: string; epoch: number; from?: string };
/** 依頼の状態。答え（`sealedAnswer`）は依頼と同じ世代（`epoch`）で封じる。 */
export type MobileLaunchStatus = { id: string; status: 'pending' | 'claimed' | 'started' | 'failed' | 'expired'; sealedAnswer: string | null; epoch: number };

/**
 * スマホのプッシュ通知の中身（0.9.1）。
 * PC がスマホ用の鍵 `M[m]` で封じ（mobileCrypto.ts の sealPhoneNotice）、Worker は封じたまま Web Push で送る。
 * count は新しく要対応に入った会話の数で、2 以上なら「〈題〉ほか n 件」と出す。題と ID は先頭の 1 件のもの。
 */
export type PhoneNotice = { title: string; pcName: string; sessionId: string; count: number };
/** 通知の題と PC の名前の字数の上限。封じる前に切る。 */
export const PHONE_NOTICE_TEXT_MAX = 120;
/** 通知の会話の ID の字数の上限。 */
export const PHONE_NOTICE_ID_MAX = 128;
/**
 * 封じた通知（`<世代>.<base64url>`）の字数の上限。
 * Web Push の本文は 4,096 バイトまでで、RFC 8291 の頭（86 バイト）と区切りとタグを引いた残りに収める。
 */
export const PHONE_NOTICE_SEALED_MAX = 3000;
/** 夜の時間帯の既定（端末の時刻の 0 時からの分）。23:00 から 7:00 までは鳴らさない。 */
export const PUSH_QUIET_DEFAULT = { start: 23 * 60, end: 7 * 60 } as const;
/** PC が通知を送れる回数（`POST /notices`）。1 台の PC から 1 分に 10 回まで。 */
export const NOTICE_RATE = { max: 10, windowMs: 60_000 } as const;

/**
 * `GET /m/push/key`（スマホ）の応答。
 * publicKey は Worker の VAPID の公開鍵（ECDSA P-256 の raw の非圧縮点 65 バイト）の base64url で、`PushManager.subscribe` の applicationServerKey にそのまま渡せる。
 */
export type PushKeyOut = { publicKey: string };
/**
 * `PUT /m/push/subscription`（スマホ）の本文。スマホ 1 台に購読 1 つで、2 回目からは上書きする。
 * endpoint、keys は `PushSubscription.toJSON()` の同じ名前の値である（p256dh は 65 バイト、auth は 16 バイトの base64url）。
 * quiet は鳴らさない時間帯で、端末の時刻の 0 時からの分（0 から 1439）で持つ。start と end が同じなら時間帯なし。
 * quiet を省くと既定（PUSH_QUIET_DEFAULT）、null なら夜も鳴らす。
 * tzOffset は `new Date().getTimezoneOffset()` の値（分。日本なら -540）で、端末の時刻は UTC からこれを引いたものである。
 */
export type PushSubscriptionPut = { endpoint: string; keys: { p256dh: string; auth: string }; quiet?: { start: number; end: number } | null; tzOffset: number };
/** `POST /notices`（PC）の本文。sealed は sealPhoneNotice の戻りで、epoch はその世代（sealed の頭の数と同じ）。 */
export type NoticeIn = { sealed: string; epoch: number };
/** `POST /notices` の応答。sent は push サービスが受けた数、quiet は夜の時間帯で送らなかった数、removed は 404 か 410 で消した購読の数。 */
export type NoticeOut = { sent: number; quiet: number; removed: number; failed: number };

/**
 * 文を max 字で切り、切ったときは末尾に … を付ける。前後の空白は落とす。
 * null、undefined、空（空白だけ）は null。サロゲートペアは割らない。
 */
export function clampText(s: string | null | undefined, max: number = MOBILE_TEXT_MAX): string | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  let end = max;
  const c = t.charCodeAt(end - 1);
  if (end > 0 && c >= 0xd800 && c <= 0xdbff) end -= 1;
  return t.slice(0, end) + '…';
}

const sizeOf = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** 収まらないときに、live の文を詰める長さ（字数）。 */
const SHORT_TEXT_MAX = 60;

/**
 * 受信箱の素を上限に収める。超えたら次の順に、収まったところでやめる。
 *
 * 0. live の使用量（usage）を全部消す。飾りの数字なので、行を落とすより先に消す。
 * 1. done、returns、projects の順に、古いものから 1 件ずつ落とす。
 * 2. 待っていない live（status が waiting でないもの）を、idle、busy の順に、statusAt の古いものから落とす。
 * 3. live の意図を SHORT_TEXT_MAX 字に詰め、それでも収まらなければ意図を消す。
 * 4. live の題、プロジェクト名、待っている内容を SHORT_TEXT_MAX 字に詰める。
 * 5. 残った（待っている）live を、statusAt の古いものから落とす。
 *
 * これで暗号化の前の JSON は必ず maxBytes 以下になり、封じた本文（base64 で 4/3 倍と少し）は Worker の 96 KiB に収まる。
 * done は doneAt が小さいもの、returns は戻る日時が早いもの、projects は lastUsedAt が小さいもの（無いものが最も古い）が古い。
 * 元の feed は変えず、残したものの並びも変えない。
 */
export function fitFeed(feed: MobileFeed, maxBytes: number = MOBILE_FEED_MAX_BYTES): MobileFeed {
  if (sizeOf(feed) <= maxBytes) return feed;
  let out = feed;
  const over = (): boolean => sizeOf(out) > maxBytes;
  const trim = <K extends 'done' | 'returns' | 'projects' | 'live'>(key: K, oldestFirst: (a: MobileFeed[K][number], b: MobileFeed[K][number]) => number, droppable: (x: MobileFeed[K][number]) => boolean = () => true): void => {
    const list = out[key] as MobileFeed[K][number][];
    const order = list.map((_, i) => i).filter((i) => droppable(list[i]!)).sort((a, b) => oldestFirst(list[a]!, list[b]!) || a - b);
    for (let n = 1; n <= order.length && over(); n++) {
      const drop = new Set(order.slice(0, n));
      out = { ...out, [key]: list.filter((_, i) => !drop.has(i)) };
    }
  };
  const mapLive = (f: (l: MobileLiveItem) => MobileLiveItem): void => { out = { ...out, live: out.live.map(f) }; };
  if (out.live.some((l) => l.usage !== undefined)) mapLive(({ usage: _usage, ...l }) => l);
  trim('done', (a, b) => a.doneAt - b.doneAt);
  trim('returns', (a, b) => (a.returnOn + ' ' + (a.returnTime ?? '')).localeCompare(b.returnOn + ' ' + (b.returnTime ?? '')));
  trim('projects', (a, b) => (a.lastUsedAt ?? -Infinity) - (b.lastUsedAt ?? -Infinity));
  const idleFirst = (l: MobileLiveItem): number => (l.status === 'idle' ? 0 : 1);
  trim('live', (a, b) => idleFirst(a) - idleFirst(b) || a.statusAt - b.statusAt, (l) => l.status !== 'waiting');
  if (over()) mapLive((l) => ({ ...l, intent: clampText(l.intent, SHORT_TEXT_MAX) }));
  if (over()) mapLive((l) => ({ ...l, intent: null }));
  if (over()) {
    mapLive((l) => ({
      ...l,
      title: clampText(l.title, SHORT_TEXT_MAX) ?? '',
      projectName: clampText(l.projectName, SHORT_TEXT_MAX) ?? '',
      waiting: l.waiting ? { ...l.waiting, text: clampText(l.waiting.text, SHORT_TEXT_MAX) ?? '' } : null,
    }));
  }
  trim('live', (a, b) => a.statusAt - b.statusAt);
  return out;
}
