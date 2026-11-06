import { LAUNCH_TTL_MS } from './mobile.ts';

/**
 * PC から PC への起動の頼みの、Worker との線の形（互換の版 10）。
 * 封（sealed）の中身と AAD は e2e/peer.ts にあり、Worker は封を開かない。
 * 頼みの置き場（`POST /launches`）、受け取り（pull の peerLaunches と `POST /launches/:id/claim`）、答え（`/answer`）、
 * 結果の行（`POST /launches/:id/results`）、呼ぶ側の取得（`GET /launches/mine` と `GET /launches/:id/results`）がある。
 */

/** 頼みの有効期間。受け取られないまま過ぎたら expired。スマホの起動の依頼と同じ長さである。 */
export const PEER_LAUNCH_TTL_MS = LAUNCH_TTL_MS;
/** 頼みを置ける回数。1 台の PC から 10 分に 30 件まで。 */
export const PEER_LAUNCH_RATE = { max: 30, windowMs: 10 * 60_000 } as const;
/** 1 件の頼みに積める結果の行の数。超えたら Worker は 429 で断る。 */
export const PEER_RESULTS_MAX = 200;
/** 封の文字数の上限。頼みは 8,000 字の指示、結果は 8,000 字の最後の返答を含み、gzip が効かない最悪でも base64url で 32 KB ほどである。 */
export const PEER_LAUNCH_SEALED_MAX = 48_000;
export const PEER_RESULT_SEALED_MAX = 48_000;
/** 答えの封の文字数の上限。 */
export const PEER_ANSWER_SEALED_MAX = 8_000;
/** 1 回の結果の取得で返す行の数。続きがあれば more を立てる。 */
export const PEER_RESULTS_PAGE = 20;
/** `GET /launches/mine` の 1 回の上限。 */
export const PEER_OUTBOX_LIMIT = 50;

/** 頼みの状態。pending は未受領、claimed は宛先が受け取り中、started と failed は答えが付いた後、expired は受け取られないまま期限を過ぎた。 */
export type PeerLaunchState = 'pending' | 'claimed' | 'started' | 'failed' | 'expired';

/** `POST /launches` の本文。from は省けるが、付けるなら端末トークンの送り手と同じでなければ 403 になる。 */
export type PeerLaunchPut = { id: string; to: string; sealed: string; from?: string };

/** 呼ぶ側から見た頼みの状態。resultSeq は書かれた結果の行の最大の seq（無ければ 0）。 */
export type PeerLaunchStatus = { id: string; to: string; status: PeerLaunchState; sealedAnswer: string | null; resultSeq: number; updatedAt: number };

/** `GET /launches/mine`。since 以降に動いた自分の頼みを返す。now は次に渡す since の元で、端末は数秒の重なりを取って読み直す（読み直しは冪等）。 */
export type PeerOutboxResponse = { now: number; launches: PeerLaunchStatus[] };

/** pull（`GET /changes`）に添える、この PC 宛ての受け取り前の頼み。 */
export type PeerLaunchIncoming = { id: string; from: string; createdAt: number; sealed: string };

/** `POST /launches/:id/results` の本文。seq は 1 から。同じ seq の再送は冪等で、duplicate が真になる。 */
export type PeerResultPut = { seq: number; sealed: string };
export type PeerResultAck = { ok: true; duplicate: boolean };
export type PeerResultOut = { seq: number; sealed: string; createdAt: number };
export type PeerResultsResponse = { results: PeerResultOut[]; more: boolean };

/** 呼び鈴で PC に届く知らせ。launch は頼みが来た、answer は答えが来た、result は結果が来た、chat は会話の問い合わせ（peerChat.ts）が来た。id は頼みの ID。 */
export const PEER_BELL_KINDS = ['launch', 'answer', 'result', 'chat'] as const;
export type PeerBellKind = (typeof PEER_BELL_KINDS)[number];
export type PeerBellMessage = { t: 'peer'; kind: PeerBellKind; id: string };

/** 端末が使う、頼みの口の束。Worker の版が足りないときは呼ぶ前に弾く（呼び手が lastWorkerCompat で見る）。 */
export interface PeerLaunchApi {
  /** 頼みを置く。同じ ID の再送は行を増やさず今の状態を返す。 */
  put(body: PeerLaunchPut): Promise<PeerLaunchStatus>;
  /** 自分が置いた頼みの状態の取得。 */
  outbox(since: number): Promise<PeerOutboxResponse>;
  /** 宛先の PC が頼みを受け取る。受け取れたときだけ true（409 は false）。 */
  claim(id: string): Promise<boolean>;
  /** 受け取った頼みに答える。sealedAnswer は封じた PeerLaunchAnswer。 */
  answer(id: string, ok: boolean, sealedAnswer: string): Promise<void>;
  /** 宛先の PC が結果の行を書く。 */
  postResult(id: string, body: PeerResultPut): Promise<PeerResultAck>;
  /** 呼ぶ側が結果の行を読む。after より大きい seq を昇順で返す。 */
  results(id: string, after: number): Promise<PeerResultsResponse>;
}
