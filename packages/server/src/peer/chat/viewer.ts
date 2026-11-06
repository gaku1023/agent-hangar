import { randomUUID } from 'node:crypto';
import {
  isPeerChatViewerId,
  MOBILE_IMAGE_MAX_BYTES,
  openPeerChatReply,
  PEER_CHAT_IMAGES_MAX,
  PEER_CHAT_TAIL_WAIT_MS,
  PEER_CHAT_TEXT_MAX_BYTES,
  peerChatExpiresAt,
  sealPeerChat,
  sealPeerChatBlob,
  type PeerAskIn,
  type PeerBlobRef,
  type PeerChatApi,
  type PeerChatClientMsg,
  type PeerChatGone,
  type PeerChatItem,
  type PeerChatLink,
  type PeerChatOp,
  type PeerChatOpIn,
  type PeerChatOpResult,
  type PeerChatQueued,
  type PeerChatReason,
  type PeerChatReply,
  type PeerChatState,
  type PeerChatStatus,
  type PeerChatTargetDto,
  type PeerChatUpdate,
  type PeerChatViewDto,
  type PeerKeyring,
  type ServerEvent,
} from '@agent-hangar/shared';
import { versionAtLeast } from '../version.ts';

/**
 * 見る側の PC の、ほかの PC の会話の見張り（長いポーリングの回し手）と、画面からの操作の取り次ぎ。
 *
 * 画面がほかの PC の Claude Code の会話を開くと、会話ごとに見張りが 1 つ動く。
 * 見張りは、元の PC へ tail を頼み続ける（POST /peer/ask、封は PC どうしの鍵）。
 * 元の PC は新しい項目が出るまで答えを待たせる（最大 PEER_CHAT_TAIL_WAIT_MS）ので、返ったらすぐ次を頼む。
 * 届いた差分は peerChat.update として画面の WebSocket に流す。
 *
 * 見ている人（viewer）は 2 通りに数える。
 * WebSocket で見始めた人（peerChat.watch）は、peerChat.unwatch か切断で外れる。
 * GET だけで見ている人は、PEER_CHAT_LEASE_MS のあいだに GET が無ければ外れる（切断を知らせられない取りこぼしへの備え）。
 * 見ている人が 1 人もいなくなったら、待っている問い合わせを中止し、それ以後は頼まない。
 * 画面を閉じたのに元の PC の呼び鈴と Durable Object を起こし続けないための決まりである。
 *
 * 呼び鈴の問い合わせは Worker が数える（1 分 120 回）。
 * 間を詰めすぎない（PEER_CHAT_MIN_GAP_MS）。
 * つながっていない相手へは 15 秒、30 秒と空ける。
 * 回数超えは 30 秒空ける。
 *
 * 項目は uuid で畳む。
 * 同じ uuid は捨てる。
 * 許可と質問の札は、トランスクリプトが伸びるたびに uuid が変わるので、askId で畳む。
 * 札の答えが変わったときだけ、最初の uuid で流し直す（画面は同じ uuid を重ね書きする）。
 * 元の PC が truncated を返したら、貯めた項目を捨て、画面にも replace で差し替えさせる。
 */

/**
 * 問い合わせの最短の間。
 * 作業中の会話は毎回すぐ変わりが返るので、この間が 1 分の問い合わせの数を決める（2 秒なら 1 つの見張りで 1 分に 30 回、3 つで 90 回）。
 * Worker の 1 分 120 回に、操作の分の余裕を見る。
 * 元の PC は同じ頼み主の頼みの覚えを数えるので（host.ts の SEEN_PER_SENDER、読むだけの頼みは 30 秒だけ覚える）、この回数でも上限に届かない。
 * 画面への反映は、この間が最大の遅れで、5 秒以内に収まる。
 */
export const PEER_CHAT_MIN_GAP_MS = 2_000;
/**
 * つながっていない相手への頼み直しの間。
 * 2 回目以降は最後の値。
 * 1 分に 4 回までで、Worker の数える回数に響かない。
 */
export const PEER_CHAT_OFFLINE_RETRY_MS = [15_000, 30_000] as const;
/** 届かなかった、待ちの上限だった、返事が読めなかったときの頼み直しの間。 */
export const PEER_CHAT_ERROR_RETRY_MS = [1_000, 5_000, 15_000, 30_000] as const;
/** 回数超え（429）のあとの間。 */
export const PEER_CHAT_RATE_RETRY_MS = 30_000;
/** GET だけで見ている人を外すまでの間。 */
export const PEER_CHAT_LEASE_MS = 60_000;
/** GET が、最初の問い合わせの結果を待つ上限。 */
export const PEER_CHAT_FIRST_WAIT_MS = 10_000;
/**
 * 見張りが貯める項目の数の上限。
 * 超えたら古いものを捨て、replace にする。
 */
export const PEER_CHAT_ITEMS_KEEP = 1000;
/** 1 つの接続（GET だけの見ている人は 1 つにまとめて数える）が同時に見られる会話の数。 */
export const PEER_CHAT_VIEWERS_PER_SOCKET = 8;
/** 同時に見張れる会話の数の上限。超える会話の見張りは断る（too-many）。 */
export const PEER_CHAT_WATCHES_MAX = 8;
/** 見張りを止めた同じ会話を、また見始めるまでに空ける最短の間。閉じて開き直すたびに、Durable Object の待ちが重ならないようにする。 */
export const PEER_CHAT_REWATCH_GAP_MS = 2_000;
/** 渡せずに消えた預かりの印を覚えておく長さ（元の PC が繰り返し返す長さと同じ 5 分）。 */
export const PEER_CHAT_GONE_KEEP_MS = 5 * 60_000;
/** この回数続けて届かなければ、画面には offline と知らせる。 */
const ERRORS_BEFORE_OFFLINE = 3;
/**
 * 操作の問い合わせが答えを待つ長さ。
 * 再開して送るは相手が会話を起こすので長い。
 */
const OP_WAIT_MS = 10_000;
const RESUME_WAIT_MS = 20_000;

/** 見る相手の PC（peer/chat/viewTarget.ts が DB から引く）。 */
export type ViewTarget = { deviceId: string; deviceName: string; hangarVersion: string | null; outdated: boolean };
export type ViewResolve = { ok: true; target: ViewTarget } | { ok: false; reason: 'session-unknown' | 'not-claude' | 'not-remote' | 'device-unknown' };

/**
 * 時計と待ち。
 * 試験が差し替える。
 */
export type ViewerClock = {
  now(): number;
  /**
   * ms 待つ。
   * signal が中止されたら待たずに解く。
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * ms 後に fn を呼ぶ。
   * 戻りは取り消し。
   */
  after(ms: number, fn: () => void): () => void;
};

export const realClock: ViewerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(done, ms);
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done(): void { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  }),
  after: (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
};

/**
 * 画面が添えた画像の読み出し。
 * 名前か絶対パスから、置き場（drops）の中のファイルだけを読む。
 * 読めなければ null。
 */
export type ViewImage = { bytes: Uint8Array; mime: PeerBlobRef['mime'] };

export type PeerChatViewerDeps = {
  /** この PC の ID（頼みの from）。 */
  selfId: string;
  resolve(sessionId: string): ViewResolve;
  /**
   * 頼みの口と封の鍵。
   * 同期に参加していなければ（または口が無ければ）null。
   */
  link(): { api: PeerChatApi; ring: () => Promise<PeerKeyring> } | null;
  /** Worker の版が足りるか（SyncParts.canCarryPeerChat）。 */
  workerOk(): boolean;
  /**
   * 相手の hangar_version がこれ以上のときだけ頼む（0.19 の D16 と同じ決め方）。
   * 渡さなければ版では断らない。
   */
  version?: string;
  /**
   * 手元に降ろした写しの、最後の項目の uuid。
   * 無ければ null。
   */
  localCursor(sessionId: string): string | null;
  readImage(ref: string): ViewImage | null;
  publish(ev: Extract<ServerEvent, { type: 'peerChat.update' }>): void;
  clock?: ViewerClock;
  newId?: () => string;
};

/** 1 回の問い合わせの結果。 */
type Outcome =
  | { kind: 'reply'; reply: PeerChatReply }
  | { kind: 'offline' }
  | { kind: 'rate' }
  | { kind: 'duplicate' }
  | { kind: 'too-large' }
  | { kind: 'timeout' }
  | { kind: 'error' }
  | { kind: 'aborted' }
  | { kind: 'gate'; reason: PeerChatReason };

type Viewer = { id: string; socket: number | null; cancelLease: (() => void) | null };
/** 見ている人の鍵。接続（GET だけなら h）と画面の ID の組で、別の接続が同じ ID で入っても、ほかの接続の見ている人を乗っ取れない。 */
const viewerKey = (socket: number | null, id: string): string => (socket === null ? `h:${id}` : `s${socket}:${id}`);

const sigOf = (v: unknown): string => JSON.stringify(v);
const statusOf = (e: unknown): number | null => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
};

/**
 * 1 つの会話の見張り。
 * 貯めた項目と、最後に知った状態を持つ。
 */
class Watch {
  readonly viewers = new Map<string, Viewer>();
  readonly abort = new AbortController();
  /**
   * 貯めた項目。
   * uuid で重ね書きし、入った順を保つ。
   */
  readonly items = new Map<string, PeerChatItem>();
  /** 札の askId から、最初に載せた uuid と、答えの有無の印。 */
  readonly asks = new Map<string, { uuid: string; sig: string }>();
  cursor: string | null;
  readonly startedAfter: string | null;
  status: PeerChatStatus | null = null;
  queued: PeerChatQueued[] = [];
  link: PeerChatLink = 'online';
  replace = false;
  /** 元の PC の起動ごとの印（state.hostId）。替われば再起動である。 */
  private hostId: string | null = null;
  /** この PC が預けて、まだ預かりにあると知っている（または send の答えで知った）文の queueId。再起動で消えた文を見つけるために持つ。 */
  private readonly mine = new Set<string>();
  private readonly goneSeen = new Map<string, { reason: PeerChatGone['reason']; at: number }>();
  private freshGone: PeerChatGone[] = [];
  /**
   * 一度でも update を流した、または結果が出たか。
   * GET が最初の結果を待つのに使う。
   */
  firstDone = false;
  refused: PeerChatReason | null = null;
  private resolveFirst: () => void = () => {};
  readonly first = new Promise<void>((r) => { this.resolveFirst = r; });

  constructor(readonly sessionId: string, public target: ViewTarget, after: string | null, private readonly selfId: string) {
    this.cursor = after;
    this.startedAfter = after;
  }

  /** send の答えで知った、自分の預かりの queueId。 */
  noteSent(queueId: string): void {
    this.mine.add(queueId);
  }

  settleFirst(): void {
    this.firstDone = true;
    this.resolveFirst();
  }

  /**
   * 元の PC の状態を取り込む。
   * 変わったかと、流す項目を返す。
   */
  merge(s: PeerChatState, now: number): { emit: PeerChatItem[]; replaced: boolean; changed: boolean } {
    let changed = false;
    let replaced = false;
    const emit: PeerChatItem[] = [];
    if (s.truncated) {
      this.items.clear();
      this.asks.clear();
      this.replace = true;
      replaced = true;
      changed = true;
    }
    for (const it of s.items) {
      if (it.ask) {
        const sig = sigOf(it.ask.answered ?? null);
        const known = this.asks.get(it.ask.askId);
        if (known && !replaced) {
          if (known.sig === sig) continue;
          const next = { ...it, uuid: known.uuid };
          this.items.set(known.uuid, next);
          this.asks.set(it.ask.askId, { uuid: known.uuid, sig });
          emit.push(next);
          changed = true;
          continue;
        }
        this.asks.set(it.ask.askId, { uuid: it.uuid, sig });
        this.items.set(it.uuid, it);
        emit.push(it);
        changed = true;
        continue;
      }
      if (this.items.has(it.uuid) && !replaced) continue;
      this.items.set(it.uuid, it);
      emit.push(it);
      changed = true;
    }
    // 溢れたら、古いものを捨てる。
    // 画面の写しの続きとは言えなくなるので replace にする。
    if (this.items.size > PEER_CHAT_ITEMS_KEEP) {
      let drop = this.items.size - PEER_CHAT_ITEMS_KEEP;
      for (const k of [...this.items.keys()]) {
        if (drop-- <= 0) break;
        const dropped = this.items.get(k);
        this.items.delete(k);
        // 札の覚えも一緒に捨てる（残すと、あとで同じ札が来たときに、無い項目の重ね書きになる）。
        if (dropped?.ask && this.asks.get(dropped.ask.askId)?.uuid === k) this.asks.delete(dropped.ask.askId);
      }
      this.replace = true;
      replaced = true;
      changed = true;
    }
    if (s.status !== this.status) { this.status = s.status; changed = true; }
    if (sigOf(s.queued) !== sigOf(this.queued)) { this.queued = s.queued; changed = true; }
    // 渡せずに消えた預かり。元の PC は同じ印を数分のあいだ繰り返すので、queueId で覚えて 1 度だけ流す。
    for (const [id, g] of this.goneSeen) if (now - g.at > PEER_CHAT_GONE_KEEP_MS) this.goneSeen.delete(id);
    // 元の PC が再起動した（hostId が替わった）。預かりはメモリだけなので、自分が預けた文で新しい預かりに無いものは消えている。
    // 再起動の前に渡った文は、そのときの取り込みで mine から落ちているので、ここでは戻さない。
    const goneIn: PeerChatGone[] = [...(s.gone ?? [])];
    const stillQueued = new Set(s.queued.map((q) => q.queueId));
    if (s.hostId !== undefined) {
      if (this.hostId !== null && s.hostId !== this.hostId) {
        for (const id of this.mine) if (!stillQueued.has(id) && !goneIn.some((g) => g.queueId === id)) goneIn.push({ queueId: id, reason: 'queue-expired' });
      }
      this.hostId = s.hostId;
    }
    // いま預かりにある自分の文だけを覚え直す（消えたものは、渡した、取り消した、捨てられた、のどれかで、もう戻す文ではない）。
    this.mine.clear();
    for (const q of s.queued) if (q.from.deviceId === this.selfId) this.mine.add(q.queueId);
    for (const g of goneIn) {
      if (this.goneSeen.has(g.queueId)) continue;
      this.goneSeen.set(g.queueId, { reason: g.reason, at: now });
      this.freshGone.push({ queueId: g.queueId, reason: g.reason });
      changed = true;
    }
    if (s.cursor !== null) this.cursor = s.cursor;
    return { emit, replaced, changed };
  }

  /** 数分以内に分かった、渡せずに消えた預かりの全部。 */
  recentGone(now: number): PeerChatGone[] {
    return [...this.goneSeen].filter(([, g]) => now - g.at <= PEER_CHAT_GONE_KEEP_MS).map(([queueId, g]) => ({ queueId, reason: g.reason }));
  }

  reset(target: ViewTarget): void {
    this.target = target;
    this.items.clear();
    this.asks.clear();
    this.cursor = null;
    this.status = null;
    this.queued = [];
    this.hostId = null;
    this.mine.clear();
    this.replace = true;
  }

  /** 流す update。今回新しく分かった gone だけを載せ、載せたら空にする。 */
  update(items: PeerChatItem[], replace: boolean, reason?: PeerChatReason): PeerChatUpdate {
    const gone = this.freshGone;
    this.freshGone = [];
    return { sessionId: this.sessionId, link: this.link, replace, status: this.status, items, queued: this.queued, cursor: this.cursor, ...(gone.length ? { gone } : {}), ...(reason ? { reason } : {}) };
  }

  snapshot(now: number): PeerChatUpdate {
    const gone = this.recentGone(now);
    this.freshGone = [];
    return { sessionId: this.sessionId, link: this.link, replace: this.replace, status: this.status, items: [...this.items.values()], queued: this.queued, cursor: this.cursor, ...(gone.length ? { gone } : {}) };
  }
}

export class PeerChatViewer {
  private readonly watches = new Map<string, Watch>();
  /** 会話ごとの、見張りを最後に止めた時刻。 */
  private readonly endedAt = new Map<string, number>();
  private readonly clock: ViewerClock;
  private readonly newId: () => string;

  constructor(private readonly deps: PeerChatViewerDeps) {
    this.clock = deps.clock ?? realClock;
    this.newId = deps.newId ?? randomUUID;
  }

  private pending = 0;

  /** 返事を待っている問い合わせの数（試験が、非同期の暗号が片付くのを待つのに使う）。 */
  get inflight(): number { return this.pending; }

  /** その会話を見張っているか（試験と、画面の状態の確かめ用）。 */
  watching(sessionId: string): boolean { return this.watches.has(sessionId); }

  // ---- 入口の確かめ ----

  private gate(sessionId: string): { ok: true; target: ViewTarget; device: PeerChatTargetDto } | { ok: false; reason: PeerChatReason; device?: PeerChatTargetDto } {
    const r = this.deps.resolve(sessionId);
    if (!r.ok) return { ok: false, reason: r.reason };
    const t = r.target;
    const device = { deviceId: t.deviceId, deviceName: t.deviceName };
    if (t.outdated || (this.deps.version !== undefined && !versionAtLeast(t.hangarVersion, this.deps.version))) return { ok: false, reason: 'device-outdated', device };
    if (this.deps.link() === null) return { ok: false, reason: 'no-link', device };
    if (!this.deps.workerOk()) return { ok: false, reason: 'worker-outdated', device };
    return { ok: true, target: t, device };
  }

  // ---- 見張り ----

  /**
   * GET /api/sessions/:id/peer-chat。
   * 見張りを始める（動いていれば加わる）。
   * 最初の結果が出るまで待って、いまの状態を返す。
   * after は手元の写しの続きから取る位置で、省くと手元の写しの最後の uuid、null なら頭から。
   * 動いている見張りには効かない。
   */
  async open(sessionId: string, o: { viewer: string; after?: string | null }): Promise<PeerChatViewDto> {
    const got = this.acquire(sessionId, o.viewer, null, o.after);
    if (!got.ok) return { ok: false, reason: got.reason, ...(got.device ? { device: got.device } : {}) };
    const w = got.watch;
    await Promise.race([w.first, new Promise<void>((resolve) => { const c = this.clock.after(PEER_CHAT_FIRST_WAIT_MS, resolve); void w.first.then(c); })]);
    const device = { deviceId: w.target.deviceId, deviceName: w.target.deviceName };
    if (w.refused) return { ok: false, reason: w.refused, device };
    return { ok: true, device, startedAfter: w.startedAfter, update: w.snapshot(this.clock.now()) };
  }

  /**
   * WebSocket の peerChat.watch。
   * 見張りを始める。
   * 断られたら、reason つきの update を流す。
   */
  watchFromSocket(socket: number, msg: Extract<PeerChatClientMsg, { type: 'peerChat.watch' }>): void {
    const got = this.acquire(msg.sessionId, msg.viewer, socket, msg.after);
    if (got.ok) return;
    this.deps.publish({ type: 'peerChat.update', sessionId: msg.sessionId, link: 'offline', replace: false, status: null, items: [], queued: [], cursor: null, reason: got.reason });
  }

  /**
   * WebSocket の peerChat.unwatch、または画面が閉じたとき。
   * 見ている人が 1 人もいなくなれば止める。
   */
  unwatch(sessionId: string, viewer: string, socket: number | null = null): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    this.dropViewer(w, viewerKey(socket, viewer));
  }

  /**
   * WebSocket の切断。
   * その接続で見始めた人を全員外す。
   */
  dropSocket(socket: number): void {
    for (const w of [...this.watches.values()]) {
      for (const [key, v] of [...w.viewers]) if (v.socket === socket) this.dropViewer(w, key);
    }
  }

  /** 全部止める（サーバの終了）。 */
  stop(): void {
    for (const w of [...this.watches.values()]) this.finish(w);
  }

  private acquire(sessionId: string, viewer: string, socket: number | null, after: string | null | undefined): { ok: true; watch: Watch } | { ok: false; reason: PeerChatReason; device?: PeerChatTargetDto } {
    if (!isPeerChatViewerId(viewer)) return { ok: false, reason: 'session-unknown' };
    const g = this.gate(sessionId);
    if (!g.ok) return g;
    let w = this.watches.get(sessionId);
    // 上限は、見張りを作る前に見る（断った見張りを、見ている人のいないまま残さない）。
    const key = viewerKey(socket, viewer);
    if (!w?.viewers.has(key) && this.viewersOf(socket) >= PEER_CHAT_VIEWERS_PER_SOCKET) return { ok: false, reason: 'too-many', device: g.device };
    if (!w && this.watches.size >= PEER_CHAT_WATCHES_MAX) return { ok: false, reason: 'too-many', device: g.device };
    if (!w) {
      const from = after === undefined ? this.deps.localCursor(sessionId) : after;
      w = new Watch(sessionId, g.target, from, this.deps.selfId);
      this.watches.set(sessionId, w);
      void this.run(w);
    }
    this.addViewer(w, viewer, socket);
    return { ok: true, watch: w };
  }

  /** その接続（null は GET だけの見ている人）が、いま見ている会話の数。 */
  private viewersOf(socket: number | null): number {
    let n = 0;
    for (const w of this.watches.values()) for (const v of w.viewers.values()) if (v.socket === socket) n++;
    return n;
  }

  private addViewer(w: Watch, id: string, socket: number | null): void {
    if (socket === null) {
      // WebSocket で見ている人の GET は、期限を付けない（その接続の見ている人に任せる）。
      for (const v of w.viewers.values()) if (v.id === id && v.socket !== null) return;
    } else {
      // WebSocket で見始めたら、同じ ID の GET の期限は不要になる。ほかの接続の見ている人には触れない。
      const http = w.viewers.get(viewerKey(null, id));
      http?.cancelLease?.();
      w.viewers.delete(viewerKey(null, id));
    }
    const key = viewerKey(socket, id);
    w.viewers.get(key)?.cancelLease?.();
    const v: Viewer = { id, socket, cancelLease: null };
    if (socket === null) v.cancelLease = this.clock.after(PEER_CHAT_LEASE_MS, () => this.dropViewer(w, key));
    w.viewers.set(key, v);
  }

  private dropViewer(w: Watch, key: string): void {
    const v = w.viewers.get(key);
    if (!v) return;
    v.cancelLease?.();
    w.viewers.delete(key);
    if (w.viewers.size === 0) this.finish(w);
  }

  private finish(w: Watch): void {
    for (const v of w.viewers.values()) v.cancelLease?.();
    w.viewers.clear();
    w.abort.abort();
    if (this.watches.get(w.sessionId) === w) this.watches.delete(w.sessionId);
    // 開き直しの間隔を空けるために、止めた時刻を覚える（古いものは捨てる）。
    const now = this.clock.now();
    for (const [id, at] of this.endedAt) if (now - at > 60_000) this.endedAt.delete(id);
    this.endedAt.set(w.sessionId, now);
    w.settleFirst();
  }

  private publish(w: Watch, items: PeerChatItem[], replace: boolean, reason?: PeerChatReason): void {
    this.deps.publish({ type: 'peerChat.update', ...w.update(items, replace, reason) });
  }

  private refuse(w: Watch, reason: PeerChatReason): void {
    w.refused = reason;
    w.link = 'offline';
    this.publish(w, [], false, reason);
    this.finish(w);
  }

  /**
   * 見張りの本体。
   * 見ている人がいなくなる（abort）か、断られるまで回る。
   */
  private async run(w: Watch): Promise<void> {
    const { signal } = w.abort;
    let errors = 0;
    let offlineStep = 0;
    let lastAt = Number.NEGATIVE_INFINITY;
    const wait = (ms: number) => this.clock.sleep(ms, signal);
    // 同じ会話を止めてすぐ開き直したときは、前の待ちが片付くまで空ける。
    const ended = this.endedAt.get(w.sessionId);
    if (ended !== undefined) {
      const rest = ended + PEER_CHAT_REWATCH_GAP_MS - this.clock.now();
      if (rest > 0) await wait(rest);
    }
    while (!signal.aborted) {
      // 相手と入口を毎周確かめる。
      // 会話が別の PC へ移ったら、写しを捨てて取り直す。
      const g = this.gate(w.sessionId);
      if (!g.ok) { this.refuse(w, g.reason); return; }
      if (g.target.deviceId !== w.target.deviceId) w.reset(g.target);
      else w.target = g.target;
      const gap = lastAt + PEER_CHAT_MIN_GAP_MS - this.clock.now();
      if (gap > 0) await wait(gap);
      if (signal.aborted) break;
      lastAt = this.clock.now();
      const waitMs = w.firstDone ? PEER_CHAT_TAIL_WAIT_MS : 0;
      const out = await this.call(w.sessionId, w.target, { t: 'tail', after: w.cursor, waitMs }, { waitMs, signal });
      if (signal.aborted) break;
      let delay = 0;
      switch (out.kind) {
        case 'reply': {
          const r = out.reply;
          if (!r.ok) {
            if (r.reason === 'session-unknown' || r.reason === 'not-claude' || r.reason === 'refused-by-setting') { this.refuse(w, r.reason); return; }
            if (r.reason === 'rate') { delay = PEER_CHAT_RATE_RETRY_MS; break; }
            if (r.reason === 'offline' || r.reason === 'host-error' || r.reason === 'expired') {
              // 元の PC が offline と答えたときも、Worker の 409 と同じ間を空ける。
              // host-error（元の PC の中の想定外の失敗）も同じ間で頼み直すが、画面が「PC がつながらない」と取り違えないよう、つながりは host-error のまま流す。
              // expired は、作ったばかりの tail が期限切れと断られたので、2 台の時計のずれである。届いているので offline とは数えず、clock として流す。
              this.setLink(w, r.reason === 'host-error' ? 'host-error' : r.reason === 'expired' ? 'clock' : 'offline');
              delay = PEER_CHAT_OFFLINE_RETRY_MS[Math.min(offlineStep, PEER_CHAT_OFFLINE_RETRY_MS.length - 1)]!;
              offlineStep++;
              break;
            }
            errors++;
            delay = this.errorDelay(errors);
            this.noteErrors(w, errors);
            break;
          }
          errors = 0;
          offlineStep = 0;
          const wasOffline = w.link !== 'online';
          w.link = 'online';
          const m = r.state ? w.merge(r.state, this.clock.now()) : { emit: [], replaced: false, changed: false };
          if (m.changed || wasOffline || !w.firstDone) this.publish(w, m.replaced ? [...w.items.values()] : m.emit, m.replaced);
          break;
        }
        case 'offline':
          this.setLink(w, 'offline');
          delay = PEER_CHAT_OFFLINE_RETRY_MS[Math.min(offlineStep, PEER_CHAT_OFFLINE_RETRY_MS.length - 1)]!;
          offlineStep++;
          break;
        case 'rate':
          delay = PEER_CHAT_RATE_RETRY_MS;
          break;
        case 'duplicate':
          delay = PEER_CHAT_ERROR_RETRY_MS[0];
          break;
        case 'gate':
          this.refuse(w, out.reason);
          return;
        case 'aborted':
          break;
        default: // timeout、too-large、error
          errors++;
          delay = this.errorDelay(errors);
          this.noteErrors(w, errors);
      }
      w.settleFirst();
      if (delay > 0) await wait(delay);
    }
  }

  private errorDelay(errors: number): number {
    return PEER_CHAT_ERROR_RETRY_MS[Math.min(errors - 1, PEER_CHAT_ERROR_RETRY_MS.length - 1)]!;
  }

  /** 届かない周が続いたら、画面には offline と知らせる。 */
  private noteErrors(w: Watch, errors: number): void {
    if (errors >= ERRORS_BEFORE_OFFLINE && w.link === 'online') this.setLink(w, 'offline');
  }

  /** つながりの状態を変え、変わったときだけ update を流す（offline と host-error の行き来も変わりである）。 */
  private setLink(w: Watch, link: PeerChatLink): void {
    if (w.link === link) return;
    w.link = link;
    this.publish(w, [], false);
  }

  // ---- 問い合わせ 1 回 ----

  private async call(sessionId: string, target: ViewTarget, op: PeerChatOp, o: { waitMs: number; signal?: AbortSignal; blobs?: { bytes: Uint8Array; mime: PeerBlobRef['mime'] }[] }): Promise<Outcome> {
    const link = this.deps.link();
    if (!link) return { kind: 'gate', reason: 'no-link' };
    const signal = o.signal;
    const aborted = signal ? new Promise<Outcome>((resolve) => { if (signal.aborted) resolve({ kind: 'aborted' }); else signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true }); }) : null;
    const work = this.callInner(link, sessionId, target, op, o);
    this.pending++;
    try {
      return await (aborted ? Promise.race([work, aborted]) : work);
    } finally {
      this.pending--;
    }
  }

  private async callInner(link: { api: PeerChatApi; ring: () => Promise<PeerKeyring> }, sessionId: string, target: ViewTarget, op: PeerChatOp, o: { waitMs: number; signal?: AbortSignal; blobs?: { bytes: Uint8Array; mime: PeerBlobRef['mime'] }[] }): Promise<Outcome> {
    let ring: PeerKeyring;
    try { ring = await link.ring(); } catch { return { kind: 'error' }; }
    // 頼みの封と画像の封は同じ世代の鍵で封じる（途中で世代が変わっても食い違わない）。
    const keys = ring.current();
    const fixed: PeerKeyring = { current: () => keys, at: (n) => ring.at(n) };
    const askId = this.newId();
    const route = { requestId: askId, from: this.deps.selfId, to: target.deviceId };
    let sealed: string;
    try {
      let sent = op;
      if (o.blobs && (op.t === 'send' || op.t === 'resume-send')) {
        const refs: PeerBlobRef[] = [];
        for (const [n, b] of o.blobs.entries()) {
          try {
            await link.api.putBlob(askId, n, target.deviceId, await sealPeerChatBlob(fixed, route, n, b.bytes));
          } catch (e) {
            const s = statusOf(e);
            return s === 429 ? { kind: 'rate' } : s === 413 ? { kind: 'too-large' } : { kind: 'error' };
          }
          refs.push({ n, mime: b.mime, bytes: b.bytes.byteLength });
        }
        sent = { ...op, images: refs };
      }
      sealed = await sealPeerChat(fixed, route, { v: 1, askId, expiresAt: peerChatExpiresAt(this.clock.now()), sessionId, op: sent });
    } catch {
      return { kind: 'error' };
    }
    const body: PeerAskIn = { askId, to: target.deviceId, sealed, epoch: keys.epoch, waitMs: o.waitMs };
    let res;
    try {
      res = await link.api.ask(body, o.signal);
    } catch {
      return { kind: 'error' };
    }
    if (!res.ok) {
      if (res.status === 409) return res.reason === 'duplicate' ? { kind: 'duplicate' } : { kind: 'offline' };
      if (res.status === 429) return { kind: 'rate' };
      if (res.status === 413 || res.status === 502) return { kind: 'too-large' };
      if (res.status === 504) return { kind: 'timeout' };
      return { kind: 'error' };
    }
    try {
      return { kind: 'reply', reply: await openPeerChatReply(fixed, route, res.sealed) };
    } catch {
      return { kind: 'error' };
    }
  }

  // ---- 操作 ----

  /**
   * POST /api/sessions/:id/peer-chat/ops。
   * tail 以外の op を元の PC へ運ぶ。
   * 失敗は reason で返す（画面が入力欄に文を戻す）。
   */
  async op(sessionId: string, op: PeerChatOpIn): Promise<PeerChatOpResult> {
    const g = this.gate(sessionId);
    if (!g.ok) return { ok: false, reason: g.reason };
    let wire: PeerChatOp;
    let blobs: ViewImage[] | undefined;
    let waitMs = OP_WAIT_MS;
    if (op.t === 'send' || op.t === 'resume-send') {
      if (Buffer.byteLength(op.text) > PEER_CHAT_TEXT_MAX_BYTES) return { ok: false, reason: 'too-large' };
      const refs = op.images ?? [];
      if (refs.length > PEER_CHAT_IMAGES_MAX) return { ok: false, reason: 'too-large' };
      blobs = [];
      for (const ref of refs) {
        const img = this.deps.readImage(ref);
        if (!img) return { ok: false, reason: 'image-missing' };
        if (img.bytes.byteLength === 0 || img.bytes.byteLength > MOBILE_IMAGE_MAX_BYTES) return { ok: false, reason: 'too-large' };
        blobs.push(img);
      }
      if (op.t === 'resume-send') waitMs = RESUME_WAIT_MS;
      // 元の PC が、画像の取り込みと再開を含む全体をこの長さに収める（過ぎたら expired で、何も預からない）。
      wire = { t: op.t, text: op.text, images: [], waitMs };
    } else if (op.t === 'answer') {
      if (op.text !== undefined && Buffer.byteLength(op.text) > PEER_CHAT_TEXT_MAX_BYTES) return { ok: false, reason: 'too-large' };
      wire = { t: 'answer', askId: op.askId, keys: op.keys, ...(op.text !== undefined ? { text: op.text } : {}) };
    } else if (op.t === 'cancel') wire = { t: 'cancel', queueId: op.queueId };
    else if (op.t === 'files') wire = { t: 'files', query: op.query };
    else wire = { t: 'interrupt' };
    const out = await this.call(sessionId, g.target, wire, { waitMs, ...(blobs ? { blobs } : {}) });
    switch (out.kind) {
      case 'reply': {
        const r = out.reply;
        if (r.ok && r.queueId) this.watches.get(sessionId)?.noteSent(r.queueId);
        if (r.ok && r.state) this.absorb(sessionId, r.state);
        return r;
      }
      case 'offline': return { ok: false, reason: 'offline' };
      case 'rate': return { ok: false, reason: 'rate' };
      case 'too-large': return { ok: false, reason: 'too-large' };
      case 'timeout': return { ok: false, reason: 'expired' };
      case 'gate': return { ok: false, reason: out.reason };
      default: return { ok: false, reason: 'unreachable' };
    }
  }

  /** 操作の答えに付いた状態を、動いている見張りの貯めに取り込み、変わっていれば流す。 */
  private absorb(sessionId: string, s: PeerChatState): void {
    const w = this.watches.get(sessionId);
    if (!w || w.refused) return;
    const m = w.merge(s, this.clock.now());
    if (m.changed) this.publish(w, m.replaced ? [...w.items.values()] : m.emit, m.replaced);
  }
}
