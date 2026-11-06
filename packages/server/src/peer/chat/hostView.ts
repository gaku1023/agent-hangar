import { PEER_CHAT_REPLY_SEALED_MAX, type PeerChatAsk, type PeerChatDevice, type PeerChatGone, type PeerChatItem, type PeerChatQueued, type PeerChatState, type PeerChatStatus } from '@agent-hangar/shared';
import { parseDialog } from './answer.ts';
import type { HostPane, HostSession } from './hostTypes.ts';
import { currentPendingAsk, transcriptTail, type PeerPendingAsk, type TailDeps } from './tail.ts';

/**
 * 見る側へ返す会話の状態を作り、長いポーリング（tail）を待たせる。
 *
 * 状態は、トランスクリプトの項目（tail.ts）、登録の状態、預かり、そして元の PC が覚えている 3 つの記録でできる。
 * - 答えた記録：どの PC がどの選択肢で答えたか。
 *   札の項目に answered を足して返す（両方の PC に「Mac で許可」が出る）。
 * - 渡した記録：預かりから渡した文の送り主。
 *   本文に出た利用者の行に from を付ける。
 * - 消えた記録：渡せずに消えた預かり（queue-expired、session-unknown）。
 *   送り主の state.gone に載せる。
 * 記録はどれもメモリだけで、数分で忘れる。
 *
 * 長いポーリングは、頼み主ごと、会話ごとに、最後に返した状態の印（sig）を覚える。
 * 新しい項目があるか、印が前と違えば、すぐ返す。
 * 無ければ、知らせ（poke）か確かめ直しの間隔ごとに調べ、waitMs まで待つ。
 * 答えた記録、渡した記録の本文への反映、消えた記録は項目を増やさないので、cursor を動かさず、それだけで待ちを空振りさせない。
 */

/**
 * 長いポーリングが、知らせが無くても確かめ直す間隔。
 * 確かめは stat だけで、変わっていなければ解析しない（tail.ts の覚え）。
 */
export const RECHECK_MS = 1000;
/** 答えた記録と渡した記録を覚える長さ（答えの askId の記録 ANSWERED_TTL_MS と同じ）。 */
export const RECORD_KEEP_MS = 10 * 60_000;
/**
 * 消えた記録を載せ続ける長さ。
 * 見る側の画面が一度は受け取れる長さ。
 */
export const GONE_KEEP_MS = 5 * 60_000;
const RECORD_MAX = 64;
const SIG_MAX = 256;
/**
 * 答えの JSON の大きさの上限。
 * 封（PEER_CHAT_REPLY_SEALED_MAX）に、base64 と封筒の増え分を足しても収まる値。
 */
export const STATE_JSON_MAX = Math.floor((PEER_CHAT_REPLY_SEALED_MAX * 3) / 4) - 2048;
/**
 * 預かりの本文を状態に載せるときの上限（バイト）。
 * 全文は元の PC が持つ。
 */
const QUEUED_TEXT_MAX_BYTES = 2048;
const QUEUED_TEXT_MIN_BYTES = 128;

export type ViewDeps = {
  now(): number;
  sleep(ms: number): Promise<void>;
  recheckMs: number;
  session(sessionId: string): HostSession | null;
  run(sessionId: string): { tmuxName: string } | null;
  pane(tmuxName: string): HostPane | null;
  tail: Omit<TailDeps, 'pendingAsk'>;
  queued(sessionId: string): PeerChatQueued[];
};

const jsonSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

function clipText(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  return `${Buffer.from(s).subarray(0, max - 3).toString('utf8').replace(/�+$/, '')}…`;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 札の Other の行（自由入力）と、会話に切り替える行。
 * 選択肢としては見せない。
 */
const OTHER_ROW = /^(?:type something|other)\b/i;
const CHAT_ROW = /^chat about this\b/i;

/**
 * 画面の札と、登録の許可の中身から、いま出ている札（PeerPendingAsk）を組む。
 * 画面に札が無ければ null。
 * 選択肢の label は画面の行そのままにする（answer.ts が label で行を当てる）。
 * key は画面の番号。
 * 許可の input は、登録に中身（hook の届いた許可）があればそれ、無ければ 2 本の罫線に挟まれた文字。
 * 質問の input は問いの文（answer.ts が画面の問いと突き合わせる）。
 */
export function pendingAskFrom(session: HostSession, screen: string): PeerPendingAsk | null {
  const d = parseDialog(screen);
  if (!d) return null;
  const rows = d.options.filter((o) => !CHAT_ROW.test(o.first));
  const options = rows.filter((o) => !OTHER_ROW.test(o.first)).map((o) => ({ key: String(o.n), label: o.first }));
  const allowText = rows.some((o) => OTHER_ROW.test(o.first));
  if (d.kind === 'question') {
    const q = session.activity?.question || d.question;
    return { kind: 'question', tool: 'AskUserQuestion', input: q, question: q, options, multi: d.multi, allowText };
  }
  const p = session.permission;
  const input = p?.input || d.ruled?.trim() || undefined;
  const out: PeerPendingAsk = { kind: 'permission', description: p?.description ?? null, options, multi: false, allowText: false };
  if (p?.tool) out.tool = p.tool;
  if (input) out.input = input;
  return out;
}

type AnswerRec = { askId: string; sessionId: string; item: PeerChatItem; at: number };
type GoneRec = { sessionId: string; deviceId: string; gone: PeerChatGone; at: number };
type DeliveryRec = { sessionId: string; from: PeerChatDevice; text: string; at: number };
type Waiter = { sessionId: string; wake: () => void };

export class ChatView {
  private answers: AnswerRec[] = [];
  private gone: GoneRec[] = [];
  private deliveries: DeliveryRec[] = [];
  private readonly fromByUuid = new Map<string, PeerChatDevice>();
  private readonly lastSig = new Map<string, string>();
  private readonly waiters = new Set<Waiter>();
  private disposed = false;
  readonly tailDeps: TailDeps;

  constructor(private readonly d: ViewDeps) {
    this.tailDeps = { ...d.tail, pendingAsk: (sessionId) => this.pendingAsk(sessionId) };
  }

  /**
   * 画面に出ている許可か質問。
   * 札が出ていない（登録が入力待ちでない）か、画面から読めなければ null。
   */
  pendingAsk(sessionId: string): PeerPendingAsk | null {
    const session = this.d.session(sessionId);
    if (!session || session.live !== 'waiting') return null;
    const run = this.d.run(sessionId);
    const pane = run ? this.d.pane(run.tmuxName) : null;
    if (!pane) return null;
    let screen: string;
    try { screen = pane.capture(); } catch { return null; }
    return pendingAskFrom(session, screen);
  }

  /**
   * いま出ている札（askId を含む）。
   * T4 の答える処理と askId を突き合わせる。
   */
  currentAsk(sessionId: string): PeerChatAsk | null {
    return currentPendingAsk(sessionId, this.tailDeps);
  }

  /**
   * いま出ている札の項目（tail が最後に出すもの）。
   * 答える前に取っておき、答えた後の記録に使う（答えれば札は閉じる）。
   */
  askItem(sessionId: string, askId: string): PeerChatItem | null {
    const last = transcriptTail(sessionId, null, 1, this.tailDeps).items.at(-1);
    return last?.ask?.askId === askId ? last : null;
  }

  status(sessionId: string): PeerChatStatus {
    const s = this.d.session(sessionId);
    if (!s || s.live === null || !this.d.run(sessionId)) return 'stopped';
    return s.live;
  }

  // ---- 記録 ----

  /**
   * 答えた記録。
   * 答える前に取った札の項目（askItem）に answered を付けた写しを覚える。
   */
  recordAnswer(sessionId: string, asked: PeerChatItem, by: PeerChatDevice, label: string): void {
    if (!asked.ask) return;
    const askId = asked.ask.askId;
    const item: PeerChatItem = { ...asked, ask: { ...asked.ask, answered: { by, label, at: this.d.now() } } };
    this.answers.push({ askId, sessionId, item, at: this.d.now() });
    if (this.answers.length > RECORD_MAX) this.answers.shift();
    this.poke(sessionId);
  }

  answeredAsk(askId: string): boolean {
    this.sweep();
    return this.answers.some((a) => a.askId === askId);
  }

  recordDelivered(sessionId: string, from: PeerChatDevice, text: string): void {
    this.deliveries.push({ sessionId, from, text: norm(text), at: this.d.now() });
    if (this.deliveries.length > RECORD_MAX) this.deliveries.shift();
  }

  recordGone(sessionId: string, deviceId: string, gone: PeerChatGone): void {
    this.gone.push({ sessionId, deviceId, gone, at: this.d.now() });
    if (this.gone.length > RECORD_MAX) this.gone.shift();
    this.poke(sessionId);
  }

  private sweep(): void {
    const t = this.d.now();
    this.answers = this.answers.filter((a) => t - a.at < RECORD_KEEP_MS);
    this.deliveries = this.deliveries.filter((x) => t - x.at < RECORD_KEEP_MS);
    this.gone = this.gone.filter((g) => t - g.at < GONE_KEEP_MS);
  }

  // ---- 状態 ----

  /**
   * 利用者の行に、預かりから渡した文の送り主を付ける。
   * 本文の頭が渡した文と合い、渡した後に書かれた最初の行に付く。
   */
  private annotate(items: PeerChatItem[], sessionId: string): PeerChatItem[] {
    return items.map((it) => {
      if (it.kind !== 'user') return it;
      let from = this.fromByUuid.get(it.uuid);
      if (!from) {
        const i = this.deliveries.findIndex((x) => x.sessionId === sessionId && x.text !== '' && norm(it.text).startsWith(x.text) && (it.at === 0 || it.at >= x.at - 10_000));
        if (i >= 0) {
          from = this.deliveries[i]!.from;
          this.deliveries.splice(i, 1);
          this.fromByUuid.set(it.uuid, from);
          if (this.fromByUuid.size > SIG_MAX) this.fromByUuid.delete(this.fromByUuid.keys().next().value!);
        }
      }
      return from ? { ...it, from } : it;
    });
  }

  /**
   * 状態を組む。
   * hasNew は、返す transcript の項目（札を含む）があるか。
   * sig は、項目以外の変化を見る印。
   */
  build(sessionId: string, deviceId: string, after: string | null): { state: PeerChatState; hasNew: boolean; sig: string } {
    this.sweep();
    const t = transcriptTail(sessionId, after, undefined, this.tailDeps);
    const extras = this.answers.filter((a) => a.sessionId === sessionId && !t.items.some((i) => i.uuid === a.item.uuid)).map((a) => a.item);
    const items = [...this.annotate(t.items, sessionId), ...extras];
    const gone = this.gone.filter((g) => g.sessionId === sessionId && g.deviceId === deviceId).map((g) => g.gone);
    const status = this.status(sessionId);
    const queued = this.d.queued(sessionId).map((q) => ({ ...q, text: clipText(q.text, QUEUED_TEXT_MAX_BYTES) }));
    const sig = JSON.stringify([status, queued.map((q) => [q.queueId, q.state]), this.answers.filter((a) => a.sessionId === sessionId).map((a) => a.askId), gone.map((g) => g.queueId)]);
    const state: PeerChatState = { sessionId, status, items, queued, cursor: t.cursor, truncated: t.truncated };
    if (gone.length > 0) state.gone = gone;
    return { state: fit(state), hasNew: t.items.length > 0, sig };
  }

  /**
   * 長いポーリング。
   * 新しい項目があるか、状態の印が前に返したものと違えば、すぐ返す。
   * 無ければ waitMs まで待ち、知らせ（poke）か確かめ直しの間隔ごとに調べ直す。
   * 時間切れは、変わらない状態のまま返す。
   */
  async tail(sessionId: string, deviceId: string, after: string | null, waitMs: number): Promise<PeerChatState> {
    const key = `${deviceId}|${sessionId}`;
    const deadline = this.d.now() + waitMs;
    for (;;) {
      const r = this.build(sessionId, deviceId, after);
      if (r.hasNew || this.lastSig.get(key) !== r.sig) {
        this.lastSig.delete(key);
        this.lastSig.set(key, r.sig);
        while (this.lastSig.size > SIG_MAX) this.lastSig.delete(this.lastSig.keys().next().value!);
        return r.state;
      }
      const left = deadline - this.d.now();
      if (left <= 0 || this.disposed) return r.state;
      await this.waitFor(sessionId, Math.min(this.d.recheckMs, left));
    }
  }

  /**
   * 待っている tail を起こす。
   * 会話の状態、預かり、答えが変わったときに呼ぶ。
   * sessionId を省けば全部。
   */
  poke(sessionId?: string): void {
    for (const w of [...this.waiters]) if (sessionId === undefined || w.sessionId === sessionId) w.wake();
  }

  dispose(): void {
    this.disposed = true;
    this.poke();
  }

  private waitFor(sessionId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const w: Waiter = { sessionId, wake: () => { this.waiters.delete(w); resolve(); } };
      this.waiters.add(w);
      void this.d.sleep(ms).then(w.wake, w.wake);
    });
  }
}

/**
 * 状態の JSON を STATE_JSON_MAX に収める。
 * 古い項目から落とし（最新の 1 つは残す）、それでも大きければ預かりの本文を縮め、最後に答えた記録の項目を落とす。
 * 項目を落としたときは truncated にする（cursor は変えない。
 * 見る側は次の tail で足りない分を取り戻せる）。
 */
function fit(state: PeerChatState): PeerChatState {
  if (jsonSize(state) <= STATE_JSON_MAX) return state;
  const s: PeerChatState = { ...state, items: [...state.items], queued: state.queued.map((q) => ({ ...q })) };
  while (s.items.length > 1 && jsonSize(s) > STATE_JSON_MAX) { s.items.shift(); s.truncated = true; }
  for (const max of [512, QUEUED_TEXT_MIN_BYTES, 0]) {
    if (jsonSize(s) <= STATE_JSON_MAX) break;
    for (const q of s.queued) q.text = clipText(q.text, Math.max(max, 3));
  }
  while (s.items.length > 0 && jsonSize(s) > STATE_JSON_MAX) { s.items.shift(); s.truncated = true; }
  return s;
}
