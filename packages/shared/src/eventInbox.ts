/**
 * 受け箱（#563）の DTO と上限である。
 * 受け箱は、外から来る webhook を Worker が封じて預かる箱で、PC が引き取る。
 * 中身（見出しと本文）は受け箱の公開鍵で封じ、Worker は読まない（e2e/inbox.ts）。
 */

/**
 * 1 通の本文の上限（バイト）。
 * これを超える要求は Worker が 413 で断る。
 */
export const EVENT_BODY_MAX_BYTES = 64 * 1024;
/**
 * 受け箱 1 つに預かる荷物の上限。
 * 越えた分は捨てて、数だけ dropped に残す。
 */
export const EVENT_INBOX_PENDING_MAX = 100;
/**
 * 引き取られない荷物を預かる期間。
 * Worker の掃除が、これより古い荷物を消す。
 */
export const EVENT_INBOX_KEEP_MS = 7 * 24 * 60 * 60_000;
/**
 * 受け箱 1 つが 1 分に受ける要求の上限。
 * 越えたら 429。
 */
export const EVENT_INBOX_RATE_PER_MIN = 30;
/**
 * `GET /inboxes/pending` が 1 回に返す荷物の数。
 * 封は大きいので、引き取って ack してから続きを読む。
 */
export const EVENT_INBOX_PULL_PAGE = 20;
/** `POST /inboxes/ack` の ids の上限。 */
export const EVENT_INBOX_ACK_MAX = 100;
/**
 * 受け箱の ID の形。
 * Worker は 16 バイトの乱数を base64url にして作るので、先頭が `-` や `_` のこともある。
 * 点を許さないので、`.` や `..` の道の断片にはならない。
 */
export const EVENT_INBOX_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * `POST /inboxes` の本文。
 * publicKey は受け箱の X25519 公開鍵（raw の 32 バイトの base64url）。
 */
export type EventInboxCreate = { publicKey: string };
/**
 * `POST /inboxes` の返り値。
 * URL は `<Worker>/hooks/<inboxId>` になる。
 */
export type EventInboxCreated = { inboxId: string };

/**
 * 預かっている荷物。
 * sealed は受け箱の公開鍵で封じた InboxParcel（e2e/inbox.ts）。
 */
export type EventInboxItem = { id: string; inboxId: string; sealed: string; receivedAt: number };
/**
 * `GET /inboxes/pending` の返り値。
 * dropped は、上限で捨てた荷物の数が 1 以上の受け箱だけを並べる。
 */
export type EventInboxPending = {
  items: EventInboxItem[];
  dropped: { inboxId: string; count: number }[];
};
/** `POST /inboxes/ack` の本文。 */
export type EventInboxAck = { ids: string[] };
