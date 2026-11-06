/**
 * ほかの PC の Claude Code の会話を、チャットの形で見て続けるための共有の型と封（互換の版 11）。
 *
 * 経路はすべて呼び鈴の問い合わせである。
 * 見る側の PC が POST /peer/ask で頼みを置き、Worker が元の PC へ渡し、答えを待って返す。
 * 中身（頼みも答えも）は PC どうしの鍵（e2e/peer.ts の鍵束）で封じ、Worker は読まない。
 * 封の形は e2e/peer.ts と同じ `<世代>.<base64url>` で、AAD の頭の印だけが違う（peer-chat、peer-chat-reply）。
 * AAD は from（頼んだ PC）、to（頼まれた PC）、ask_id（頼みの askId）を入れる。
 * 答えの向きは頼みと同じ値の route で封じ、向きは印で決める（e2e/peer.ts と同じ）。
 *
 * askId の名前が 2 か所に出る。
 * 外側の PeerChatRequest.askId は、この問い合わせ自体の ID（輸送の ID。AAD と期限の扱いに使う）である。
 * op が answer のときの op.askId は、答える相手の PeerChatAsk（会話の中の許可や質問の札）の ID である。
 * 前者は route.requestId と同じ値でなければ、封じない、開けない。
 *
 * 大きさの上限は PEER_CHAT_* の定数で決める。
 * Worker の本文の上限（96 KiB）と、答えの上限（MOBILE_REPLY_MAX_BYTES）に収める。
 */

import { openPeerPayload, PeerUnknownEpochError, sealPeerPayload, type PeerKeyring, type PeerRoute } from './e2e/peer.ts';
import { E2eOpenError } from './e2e/seal.ts';
import { openBytes, sealBytes } from './mobileCrypto.ts';
import { MOBILE_IMAGES_PER_LAUNCH, MOBILE_REPLY_MAX_BYTES, type MobileImageRef } from './mobile.ts';

/**
 * ほかの PC からの送信（send、answer、interrupt、resume-send）を受けるか（設定 peerChatAcceptFromPeers）。
 * この PC だけの設定で、設定の同期には載せない。項目が無いときは受ける（既定は入り）。
 */
export const peerChatAcceptOf = (s: { peerChatAcceptFromPeers?: boolean }): boolean => s.peerChatAcceptFromPeers !== false;

// ---- 型 ----

export type PeerChatDevice = { deviceId: string; deviceName: string };

export const PEER_CHAT_ITEM_KINDS = ['user', 'assistant', 'tool', 'permission', 'question', 'system'] as const;
export type PeerChatItemKind = (typeof PEER_CHAT_ITEM_KINDS)[number];

/**
 * 許可や質問の札。
 * options は番号の選択肢（key は画面に打つキー）。
 * answered は、どの PC がどの選択肢で答えたか。
 */
export type PeerChatAsk = {
  askId: string;
  kind: 'permission' | 'question';
  tool?: string;
  input?: string;
  options: { key: string; label: string }[];
  multi: boolean;
  allowText: boolean;
  answered?: { by: PeerChatDevice; label: string; at: number };
};

/**
 * 会話の 1 項目。
 * uuid はトランスクリプトの行の uuid で、tail の after に使う。
 * from は、ほかの PC から送った文のときの送り手。
 */
export type PeerChatItem = {
  uuid: string;
  at: number;
  kind: PeerChatItemKind;
  text: string;
  from?: PeerChatDevice;
  tool?: { name: string; summary: string; ok: boolean };
  ask?: PeerChatAsk;
};

/** 預かり（元の PC が、ターンが止まって入力欄が空くまで持っている、ほかの PC からの文）。 */
export type PeerChatQueued = { queueId: string; from: PeerChatDevice; text: string; images: number; at: number; state: 'waiting' | 'delivering' };

export const PEER_CHAT_STATUSES = ['busy', 'idle', 'waiting', 'stopped'] as const;
export type PeerChatStatus = (typeof PEER_CHAT_STATUSES)[number];

/**
 * 送った文が渡されないまま消えた知らせ（送り主の PC に返す）。
 * queue-expired は止まってから 10 分渡せなかったとき、session-unknown は会話が消えたとき。
 * 受け取った側は、自分の預かりの queueId を探し、文を入力欄に戻す。
 */
export type PeerChatGone = { queueId: string; reason: 'queue-expired' | 'session-unknown' };

export type PeerChatState = {
  sessionId: string;
  status: PeerChatStatus;
  items: PeerChatItem[];
  queued: PeerChatQueued[];
  cursor: string | null;
  truncated: boolean;
  /** その頼み主の預かりのうち、渡せずに消えたもの（元の PC が数分のあいだ載せる。無ければ付かない）。 */
  gone?: PeerChatGone[];
};

/**
 * 頼みに付ける画像 1 枚の控え。
 * スマホの起動の画像（MobileImageRef）と同じ形で、本体は /peer/blobs/:askId/:n に封をして置く。
 */
export type PeerBlobRef = MobileImageRef;

export type PeerChatOp =
  | { t: 'tail'; after: string | null; waitMs: number }
  | { t: 'send'; text: string; images: PeerBlobRef[] }
  | { t: 'answer'; askId: string; keys: string[]; text?: string }
  | { t: 'interrupt' }
  | { t: 'resume-send'; text: string; images: PeerBlobRef[] }
  | { t: 'cancel'; queueId: string }
  | { t: 'files'; query: string };

/**
 * 頼み（封の中身）。
 * expiresAt は作った時刻 + PEER_CHAT_TTL_MS で、元の PC は過ぎた頼みを捨てる。
 */
export type PeerChatRequest = { v: 1; askId: string; expiresAt: number; sessionId: string; op: PeerChatOp };

export const PEER_CHAT_REFUSALS = ['offline', 'refused-by-setting', 'not-claude', 'session-unknown', 'expired', 'already-answered', 'ask-mismatch', 'resume-failed', 'queue-expired', 'too-large', 'rate'] as const;
export type PeerChatRefusal = (typeof PEER_CHAT_REFUSALS)[number];

/**
 * files の答えの 1 件。
 * スマホの files の答え（MobileReply）と同じ形。
 */
export type PeerChatFile = { path: string; changed: boolean };

export type PeerChatReply = { ok: true; state?: PeerChatState; queueId?: string; files?: PeerChatFile[] } | { ok: false; reason: PeerChatRefusal };

// ---- 上限 ----

/**
 * 頼みの有効な時間。
 * 作った時刻からこれだけ経った頼みは、元の PC が捨てる（眠っていた PC が起きて、古い文を打たないため）。
 */
export const PEER_CHAT_TTL_MS = 60_000;
/**
 * 2 台の PC の時計のずれとして許す幅。
 * 頼んだ側の時計が進んでいても、expiresAt が now + PEER_CHAT_TTL_MS + この値までなら有効として扱う。
 */
export const PEER_CHAT_CLOCK_SKEW_MS = 5_000;
/**
 * tail が答えを待たせる時間の上限。
 * Worker は waitMs + 5 秒まで待つ。
 */
export const PEER_CHAT_WAIT_MAX_MS = 20_000;
/** send、resume-send、answer の text の上限（UTF-8 のバイト数）。 */
export const PEER_CHAT_TEXT_MAX_BYTES = 32 * 1024;
/**
 * 1 回に付けられる画像の数。
 * スマホの起動と同じ。
 */
export const PEER_CHAT_IMAGES_MAX = MOBILE_IMAGES_PER_LAUNCH;
/** 1 回の answer に載せるキーの数と、キー 1 つの長さ。 */
export const PEER_CHAT_KEYS_MAX = 32;
export const PEER_CHAT_KEY_MAX_CHARS = 64;
/** files の問い合わせの長さ（文字数）。 */
export const PEER_CHAT_QUERY_MAX_CHARS = 512;
/** ID の欄（askId、sessionId、uuid、queueId）の長さ（文字数）。 */
export const PEER_CHAT_ID_MAX_CHARS = 256;
/**
 * 頼みの封の文字数の上限。
 * Worker の本文の上限（96 KiB）から、{ to, sealed, epoch, waitMs } の枠の分を引いて余裕を残した値である。
 * 本文は PEER_CHAT_TEXT_MAX_BYTES（32 KiB）までなので、gzip の効かない最悪の並びでも base64url で 44 KB ほどに収まる。
 * 封じる側は、この長さでも念のため断る（ほかの欄が増えたときの安全網）。
 */
export const PEER_CHAT_SEALED_MAX = 80_000;
/**
 * 答えの封の文字数の上限。
 * Worker が返せる答えの上限（MOBILE_REPLY_MAX_BYTES）と同じ。
 */
export const PEER_CHAT_REPLY_SEALED_MAX = MOBILE_REPLY_MAX_BYTES;

/** 頼みを作る時刻から expiresAt を決める。 */
export const peerChatExpiresAt = (now: number): number => now + PEER_CHAT_TTL_MS;

// ---- AAD ----

const ids = (r: PeerRoute): [string, string, string] => [r.from, r.to, r.requestId];

/**
 * 頼みの AAD。
 * route.requestId は頼みの askId と同じ値を渡す。
 */
export const aadPeerChat = (epoch: number, r: PeerRoute): string => JSON.stringify(['peer-chat', epoch, ...ids(r)]);
/**
 * 答えの AAD。
 * 向きは頼みと同じ route を渡す。
 */
export const aadPeerChatReply = (epoch: number, r: PeerRoute): string => JSON.stringify(['peer-chat-reply', epoch, ...ids(r)]);

// ---- 形の検査 ----

const isStr = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= PEER_CHAT_ID_MAX_CHARS;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
const REFUSALS: ReadonlySet<string> = new Set(PEER_CHAT_REFUSALS);
const KINDS: ReadonlySet<string> = new Set(PEER_CHAT_ITEM_KINDS);
const STATUSES: ReadonlySet<string> = new Set(PEER_CHAT_STATUSES);
const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

function readImages(v: unknown): PeerBlobRef[] | null {
  if (!Array.isArray(v) || v.length > PEER_CHAT_IMAGES_MAX) return null;
  const out: PeerBlobRef[] = [];
  for (const r of v) {
    if (!isObj(r) || !isNat(r.n) || r.n >= PEER_CHAT_IMAGES_MAX || !isStr(r.mime) || !MIMES.has(r.mime) || !isNat(r.bytes)) return null;
    out.push({ n: r.n, mime: r.mime as PeerBlobRef['mime'], bytes: r.bytes });
  }
  return out;
}

function readOp(v: unknown): PeerChatOp | null {
  if (!isObj(v) || !isStr(v.t)) return null;
  switch (v.t) {
    case 'tail':
      if (!(v.after === null || isId(v.after)) || !isNat(v.waitMs) || v.waitMs > PEER_CHAT_WAIT_MAX_MS) return null;
      return { t: 'tail', after: v.after as string | null, waitMs: v.waitMs };
    case 'send':
    case 'resume-send': {
      const images = readImages(v.images);
      if (!isStr(v.text) || !images) return null;
      return { t: v.t, text: v.text, images };
    }
    case 'answer': {
      if (!isId(v.askId) || !Array.isArray(v.keys) || v.keys.length > PEER_CHAT_KEYS_MAX || !optStr(v.text)) return null;
      if (!v.keys.every((k) => isStr(k) && k.length > 0 && k.length <= PEER_CHAT_KEY_MAX_CHARS)) return null;
      const out: PeerChatOp = { t: 'answer', askId: v.askId, keys: [...(v.keys as string[])] };
      if (v.text !== undefined) out.text = v.text as string;
      return out;
    }
    case 'interrupt':
      return { t: 'interrupt' };
    case 'cancel':
      return isId(v.queueId) ? { t: 'cancel', queueId: v.queueId } : null;
    case 'files':
      return isStr(v.query) && v.query.length <= PEER_CHAT_QUERY_MAX_CHARS ? { t: 'files', query: v.query } : null;
    default:
      return null;
  }
}

/**
 * 頼みの形を検べ、知らない欄を捨てた写しを返す。
 * 形が違えば null。
 * 期限と大きさは見ない（checkPeerChatRequest）。
 */
export function parsePeerChatRequest(v: unknown): PeerChatRequest | null {
  if (!isObj(v) || v.v !== 1 || !isId(v.askId) || !isTime(v.expiresAt) || !isId(v.sessionId)) return null;
  const op = readOp(v.op);
  return op ? { v: 1, askId: v.askId, expiresAt: v.expiresAt, sessionId: v.sessionId, op } : null;
}

/** 頼みの op に入る text（send、resume-send、answer）。 */
function textOf(op: PeerChatOp): string {
  return op.t === 'send' || op.t === 'resume-send' ? op.text : op.t === 'answer' ? (op.text ?? '') : '';
}

/**
 * 開いた頼みの期限と大きさを検べる（元の PC が呼ぶ）。
 * 期限切れは expired、本文が上限を超えれば too-large（PeerChatRefusal の文字列）で断る。
 * 期限が遠い未来の頼み（now + PEER_CHAT_TTL_MS + PEER_CHAT_CLOCK_SKEW_MS より先）も expired で断る。
 * 期限を遠くへ書いた頼みが、いつまでも有効になるのを防ぐためである。
 * now は元の PC の時計。
 * 形の検査は parsePeerChatRequest（openPeerChat が済ませている）。
 */
export function checkPeerChatRequest(req: PeerChatRequest, now: number): { ok: true } | { ok: false; reason: 'expired' | 'too-large' } {
  if (now > req.expiresAt || req.expiresAt > now + PEER_CHAT_TTL_MS + PEER_CHAT_CLOCK_SKEW_MS) return { ok: false, reason: 'expired' };
  if (byteLength(textOf(req.op)) > PEER_CHAT_TEXT_MAX_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true };
}

const isDevice = (v: unknown): v is PeerChatDevice => isObj(v) && isStr(v.deviceId) && isStr(v.deviceName);

function readAsk(v: unknown): PeerChatAsk | null {
  if (!isObj(v) || !isStr(v.askId) || (v.kind !== 'permission' && v.kind !== 'question') || !optStr(v.tool) || !optStr(v.input)) return null;
  if (!Array.isArray(v.options) || !v.options.every((o) => isObj(o) && isStr(o.key) && isStr(o.label))) return null;
  if (typeof v.multi !== 'boolean' || typeof v.allowText !== 'boolean') return null;
  const a = v.answered;
  if (a !== undefined && !(isObj(a) && isDevice(a.by) && isStr(a.label) && isTime(a.at))) return null;
  const out: PeerChatAsk = { askId: v.askId, kind: v.kind, options: (v.options as { key: string; label: string }[]).map((o) => ({ key: o.key, label: o.label })), multi: v.multi, allowText: v.allowText };
  if (v.tool !== undefined) out.tool = v.tool as string;
  if (v.input !== undefined) out.input = v.input as string;
  if (a !== undefined) {
    const x = a as { by: PeerChatDevice; label: string; at: number };
    out.answered = { by: { deviceId: x.by.deviceId, deviceName: x.by.deviceName }, label: x.label, at: x.at };
  }
  return out;
}

function readItem(v: unknown): PeerChatItem | null {
  if (!isObj(v) || !isStr(v.uuid) || !isTime(v.at) || !isStr(v.kind) || !KINDS.has(v.kind) || !isStr(v.text)) return null;
  const out: PeerChatItem = { uuid: v.uuid, at: v.at, kind: v.kind as PeerChatItemKind, text: v.text };
  if (v.from !== undefined) {
    if (!isDevice(v.from)) return null;
    out.from = { deviceId: v.from.deviceId, deviceName: v.from.deviceName };
  }
  if (v.tool !== undefined) {
    const t = v.tool;
    if (!isObj(t) || !isStr(t.name) || !isStr(t.summary) || typeof t.ok !== 'boolean') return null;
    out.tool = { name: t.name, summary: t.summary, ok: t.ok };
  }
  if (v.ask !== undefined) {
    const a = readAsk(v.ask);
    if (!a) return null;
    out.ask = a;
  }
  return out;
}

function readQueued(v: unknown): PeerChatQueued | null {
  if (!isObj(v) || !isStr(v.queueId) || !isDevice(v.from) || !isStr(v.text) || !isNat(v.images) || !isTime(v.at)) return null;
  if (v.state !== 'waiting' && v.state !== 'delivering') return null;
  return { queueId: v.queueId, from: { deviceId: v.from.deviceId, deviceName: v.from.deviceName }, text: v.text, images: v.images, at: v.at, state: v.state };
}

function readState(v: unknown): PeerChatState | null {
  if (!isObj(v) || !isStr(v.sessionId) || !isStr(v.status) || !STATUSES.has(v.status)) return null;
  if (!Array.isArray(v.items) || !Array.isArray(v.queued) || !(v.cursor === null || isStr(v.cursor)) || typeof v.truncated !== 'boolean') return null;
  const items = v.items.map(readItem);
  const queued = v.queued.map(readQueued);
  if (items.some((i) => !i) || queued.some((q) => !q)) return null;
  const out: PeerChatState = { sessionId: v.sessionId, status: v.status as PeerChatStatus, items: items as PeerChatItem[], queued: queued as PeerChatQueued[], cursor: v.cursor, truncated: v.truncated };
  if (v.gone !== undefined) {
    if (!Array.isArray(v.gone) || !v.gone.every((g) => isObj(g) && isStr(g.queueId) && (g.reason === 'queue-expired' || g.reason === 'session-unknown'))) return null;
    out.gone = (v.gone as PeerChatGone[]).map((g) => ({ queueId: g.queueId, reason: g.reason }));
  }
  return out;
}

/**
 * 答えの形を検べ、知らない欄を捨てた写しを返す。
 * 形が違う、知らない断りの理由は null。
 */
export function parsePeerChatReply(v: unknown): PeerChatReply | null {
  if (!isObj(v)) return null;
  if (v.ok === false) return isStr(v.reason) && REFUSALS.has(v.reason) ? { ok: false, reason: v.reason as PeerChatRefusal } : null;
  if (v.ok !== true) return null;
  const out: { ok: true; state?: PeerChatState; queueId?: string; files?: PeerChatFile[] } = { ok: true };
  if (v.state !== undefined) {
    const s = readState(v.state);
    if (!s) return null;
    out.state = s;
  }
  if (v.queueId !== undefined) {
    if (!isStr(v.queueId)) return null;
    out.queueId = v.queueId;
  }
  if (v.files !== undefined) {
    if (!Array.isArray(v.files) || !v.files.every((f) => isObj(f) && isStr(f.path) && typeof f.changed === 'boolean')) return null;
    out.files = (v.files as PeerChatFile[]).map((f) => ({ path: f.path, changed: f.changed }));
  }
  return out;
}

// ---- 封 ----

function checkRoute(r: PeerRoute): void {
  if (!r || !isStr(r.requestId) || !isStr(r.from) || !isStr(r.to) || !r.requestId || !r.from || !r.to) throw new TypeError('頼みの宛先の形が違います');
}

/**
 * 会話の頼みを今の世代の鍵で封じる（見る側の PC が呼ぶ）。
 * route.requestId は req.askId と同じ値にする。
 * 形が違う、封が PEER_CHAT_SEALED_MAX を超えるときは TypeError を投げる。
 */
export async function sealPeerChat(ring: PeerKeyring, route: PeerRoute, req: PeerChatRequest): Promise<string> {
  checkRoute(route);
  const v = parsePeerChatRequest(req);
  if (!v) throw new TypeError('頼みの形が違います');
  if (v.askId !== route.requestId) throw new TypeError('頼みの askId が宛先の requestId と違います');
  if (byteLength(textOf(v.op)) > PEER_CHAT_TEXT_MAX_BYTES) throw new TypeError('頼みの本文が大きすぎます');
  const sealed = await sealPeerPayload(ring, (e) => aadPeerChat(e, route), v);
  if (sealed.length > PEER_CHAT_SEALED_MAX) throw new TypeError('頼みの封が大きすぎます');
  return sealed;
}

/**
 * 会話の頼みを開く（元の PC が呼ぶ）。
 * 鍵、AAD、中身の形、askId と requestId の食い違いのどれでも E2eOpenError を投げる。
 * 世代の鍵が無いときは PeerUnknownEpochError（E2eOpenError の仲間）。
 * 期限と大きさは開けた後に checkPeerChatRequest で検べる。
 */
export async function openPeerChat(ring: PeerKeyring, route: PeerRoute, sealed: string): Promise<PeerChatRequest> {
  const v = parsePeerChatRequest(await openPeerPayload(ring, (e) => aadPeerChat(e, route), sealed));
  if (!v || v.askId !== route.requestId) throw new E2eOpenError();
  return v;
}

/**
 * 会話の答えを封じる（元の PC が呼ぶ）。
 * route は頼みと同じ値を渡す。
 * 形が違う、封が PEER_CHAT_REPLY_SEALED_MAX を超えるときは TypeError。
 */
export async function sealPeerChatReply(ring: PeerKeyring, route: PeerRoute, reply: PeerChatReply): Promise<string> {
  checkRoute(route);
  const v = parsePeerChatReply(reply);
  if (!v) throw new TypeError('答えの形が違います');
  const sealed = await sealPeerPayload(ring, (e) => aadPeerChatReply(e, route), v);
  if (sealed.length > PEER_CHAT_REPLY_SEALED_MAX) throw new TypeError('答えの封が大きすぎます');
  return sealed;
}

/** 会話の答えを開く（見る側の PC が呼ぶ）。 */
export async function openPeerChatReply(ring: PeerKeyring, route: PeerRoute, sealed: string): Promise<PeerChatReply> {
  const v = parsePeerChatReply(await openPeerPayload(ring, (e) => aadPeerChatReply(e, route), sealed));
  if (!v) throw new E2eOpenError();
  return v;
}

/**
 * 呼び鈴の枠（Worker の Durable Object と PC の間）。中身の sealed は封のまま運び、Worker は開かない。
 * 頼まれた PC に届く枠。
 * id は頼みの askId（封の AAD の ask_id と同じ値）、from は頼んだ PC の端末 ID、epoch は封の世代である。
 * PC は from と id から route（{ requestId: id, from, to: 自分 }）を組んで開く。
 */
export type PeerChatBellAsk = { t: 'chat'; id: string; from: string; epoch: number; sealed: string };
/**
 * 頼まれた PC が返す枠。
 * id と from は届いた枠のものをそのまま返す。
 * Durable Object は、この 2 つが待ちの鍵と合い、送ってきた WebSocket が宛先の PC のものであるときだけ答えにする。
 */
export type PeerChatBellReply = { t: 'chat-reply'; id: string; from: string; sealed: string };
/** POST /peer/ask の本文。askId は頼む側が振り、封の AAD の ask_id と同じ値にする。 */
export type PeerAskIn = { askId: string; to: string; sealed: string; epoch: number; waitMs: number };
/** POST /peer/ask の断り。offline はすぐ、duplicate は同じ askId が待っているとき、rate は 1 分 120 回を超えたときである。 */
export type PeerAskRefusal = { error: string; reason: 'offline' | 'duplicate' | 'rate' };

// ---- 画像の封（PC どうし） ----

/**
 * 画像 1 枚の AAD。
 * 頼みと同じ route（requestId は頼みの askId）と、画像の番号で縛る。
 * 頼みの AAD とは頭の印が違うので、頼みの封を画像として開くことはできない。
 */
export const aadPeerChatBlob = (epoch: number, r: PeerRoute, n: number): string => JSON.stringify(['peer-chat-blob', epoch, ...ids(r), n]);

/**
 * 画像のバイト列を今の世代の鍵で封じる（見る側の PC が呼び、PUT /peer/blobs/:askId/:n に置く）。
 * 戻りは 4 バイトの世代（大きい桁から）に、封じたバイト列（IV、暗号文、タグ）を続けたもの。
 * 画像の封は文字列でなく生のバイト列なので、世代は頭に 4 バイトで持つ。
 */
export async function sealPeerChatBlob(ring: PeerKeyring, route: PeerRoute, n: number, bytes: Uint8Array): Promise<Uint8Array> {
  checkRoute(route);
  if (!isNat(n) || n >= PEER_CHAT_IMAGES_MAX) throw new TypeError('画像の番号の形が違います');
  const keys = ring.current();
  const body = await sealBytes(keys.peer, aadPeerChatBlob(keys.epoch, route, n), bytes);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, keys.epoch, false);
  out.set(body, 4);
  return out;
}

/**
 * 画像の封を開く（元の PC が呼ぶ）。
 * 封が名乗る世代の鍵で開く。鍵、AAD、中身のどれが違っても E2eOpenError、世代の鍵が無ければ PeerUnknownEpochError を投げる。
 */
export async function openPeerChatBlob(ring: PeerKeyring, route: PeerRoute, n: number, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 4) throw new E2eOpenError();
  const epoch = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint32(0, false);
  const keys = ring.at(epoch);
  if (!keys) throw new PeerUnknownEpochError(epoch);
  try {
    return await openBytes(keys.peer, aadPeerChatBlob(epoch, route, n), sealed.subarray(4));
  } catch {
    throw new E2eOpenError();
  }
}
