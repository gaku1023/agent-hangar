import { PEER_CHAT_REPLY_SEALED_MAX, peerAskBase, peerAskInsertIndex, type PeerChatAsk, type PeerChatAskStep, type PeerChatDevice, type PeerChatGone, type PeerChatItem, type PeerChatQueued, type PeerChatState, type PeerChatStatus } from '@agent-hangar/shared';
import { createHash } from 'node:crypto';
import { buildPeerChatCard } from './hostCard.ts';
import { dialogMatches, isCommandTitle, parseDialog, strip, type Dialog, type DialogStep } from './answer.ts';
import type { HostPane, HostSession } from './hostTypes.ts';
import type { LiveDigestDto, PeerChatCard, TranscriptEvent } from '@agent-hangar/shared';
import { currentPendingAsk, onlyRepliesBetween, peerAskId, transcriptPosition, transcriptTail, transcriptTurnCount, type PeerPendingAsk, type TailDeps } from './tail.ts';

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
/** answerable が false の札の画面を取り直す最短の間隔。 */
export const UNANSWERABLE_RECHECK_MS = 2000;

const askBase = peerAskBase;
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
  /** 現在の札の材料の口（hostTypes.ts の PeerChatHostDeps と同じ）。digest が無ければ札を付けない。 */
  digest?(sessionId: string): LiveDigestDto;
  turnEvents?(sessionId: string, fromSeq: number | null): { events: TranscriptEvent[]; dropped: number };
  artifactCount?(sessionId: string): number;
  liveHints?(): boolean;
  tail: Omit<TailDeps, 'pendingAsk'>;
  queued(sessionId: string): PeerChatQueued[];
  /** この PC（手元で札に答えた記録の by に使う）。 */
  self(): PeerChatDevice;
  /** この hangar の起動ごとの印（state.hostId）。 */
  hostId: string;
  /**
   * PermissionRequest の hook の入力から作った札（hookCard.ts）。
   * 画面から札が読めないか、答えられない札のとき、代わりに使う。hook の待ちが無ければ null。
   */
  hookAsk?(sessionId: string): PeerPendingAsk | null;
  /** この PC で会話が動いているアカウントの名前（state.account）。分からなければ null。 */
  accountName?(sessionId: string): string | null;
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
 * 許可の tool と input は、登録に中身（hook の届いた許可）があればそれ。
 * 無ければ、2 本の罫線に挟まれた文字を input にして、道具は付けない。
 * ファイルの道具の札（Edit、Write、NotebookEdit、Read）は、画面から tool と input を組まない。
 * 画面の見出しは命令の本文でも書けるので、hook の届いた許可がないとき、この札は答えられない（answer.ts が断る）。
 * 質問の input は問いの文（answer.ts が画面の問いと突き合わせる）。
 */
export function pendingAskFrom(session: HostSession, screen: string): PeerPendingAsk | null {
  const d = parseDialog(screen);
  if (!d) return null;
  const rows = d.options.filter((o) => !CHAT_ROW.test(o.first));
  const options = rows.filter((o) => !OTHER_ROW.test(o.first)).map((o) => ({ key: String(o.n), label: o.first }));
  const allowText = rows.some((o) => OTHER_ROW.test(o.first));
  if (d.kind === 'question') {
    const first = session.activity?.question || null;
    if (d.step) {
      // 問いが複数ある札は、1 問ずつ札にする。登録の問い（hook と本文）はいつも 1 問目なので、画面の今のタブの問いを使う。
      const q = d.question || first || '';
      const asked: PeerPendingAsk = { kind: 'question', tool: 'AskUserQuestion', input: q, question: q, options, multi: d.multi, allowText, step: tabOf(d.step, q, first) };
      return markUnanswerable(asked, d, session.cwd);
    }
    const q = first || d.question;
    const asked: PeerPendingAsk = { kind: 'question', tool: 'AskUserQuestion', input: q, question: q, options, multi: d.multi, allowText };
    return markUnanswerable(asked, d, session.cwd);
  }
  const p = session.permission;
  // ファイルの道具の札は、罫線の間が差分なので、画面からは組まない。
  // 画面から input を組むのは、命令の札（Bash command）だけにする。
  const fromScreen = !d.file && d.title !== null && isCommandTitle(d.title) ? d.ruled?.trim() : undefined;
  const input = p?.input || fromScreen || undefined;
  const out: PeerPendingAsk = { kind: 'permission', description: p?.description ?? null, options, multi: false, allowText: false };
  if (p?.tool) out.tool = p.tool;
  if (input) out.input = input;
  return markUnanswerable(out, d, session.cwd);
}

/**
 * 画面の今のタブを、見せる step（1 始まり）にする。
 * 確認のタブは index を total にして submit を付ける。
 * 画面の問いが登録の 1 問目の文と同じなら 1（答えた問いへ戻ったときも合う）。
 * ほかは頭の行の最初の ☐ で、それも無ければ最後の問いと見なす。
 */
function tabOf(step: DialogStep, question: string, first: string | null): PeerChatAskStep {
  if (step.submit) return { index: step.total, total: step.total, submit: true };
  if (first !== null && strip(first) === strip(question)) return { index: 1, total: step.total };
  return { index: step.index ?? step.total, total: step.total };
}

/**
 * この PC が答えられない札には answerable: false を付ける。
 * 判定は答えるとき（answer.ts の answerAsk）が使う dialogMatches そのものである。
 * 規則を二重に持たないので、見る側の釦と、答えたときの ask-mismatch が食い違わない。
 * 答えられる札には欄を付けない（印を知らない古い見る側と同じ形のまま）。
 */
function markUnanswerable(pending: PeerPendingAsk, d: Dialog, cwd: string): PeerPendingAsk {
  const probe: PeerChatAsk = { askId: '', kind: pending.kind, options: pending.options, multi: pending.multi, allowText: pending.allowText };
  if (pending.tool !== undefined) probe.tool = pending.tool;
  if (pending.input !== undefined) probe.input = pending.input;
  if (pending.step !== undefined) probe.step = pending.step;
  return dialogMatches(probe, d, cwd || null) ? pending : { ...pending, answerable: false };
}

/**
 * 画面から作った質問の札の選択肢に、hook の札の選択肢の説明（description）を重ねる。
 * 画面の行には説明が出ないので、label が一致するものだけに付ける。
 * 札と画面の照合と askId は label だけを使うので、説明を足しても変わらない。
 */
function withDescriptions(ask: PeerPendingAsk, hook: PeerPendingAsk): PeerPendingAsk {
  if (ask.kind !== 'question' || hook.kind !== 'question') return ask;
  const byLabel = new Map<string, string>();
  for (const o of hook.options) if (o.description) byLabel.set(o.label, o.description);
  if (byLabel.size === 0) return ask;
  return { ...ask, options: ask.options.map((o) => { const d = byLabel.get(o.label); return d ? { ...o, description: d } : o; }) };
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
  /** 会話ごとに、最後に出ていた札の項目。札が消えたとき、ほかの PC の答えが無ければ、この PC の手元で答えたと記録する。 */
  private readonly lastAsk = new Map<string, PeerChatItem>();
  /** askId が言い換わった札の、言い換え前から言い換え後への対応。言い換え前の askId で来た答えを、今の札へ読み替えるのに使う。 */
  private readonly rekeys = new Map<string, string>();
  private readonly lastSig = new Map<string, string>();
  private readonly waiters = new Set<Waiter>();
  private disposed = false;
  /** 長いポーリングが使う（画面の取り込みを、登録の状態が変わるか poke が来るまで使い回す）。 */
  readonly tailDeps: TailDeps;
  /** 答えるときが使う（いつも画面を取り込み直す）。 */
  private readonly freshDeps: TailDeps;
  /** 札が出ている間の、画面の取り込みの覚え。登録の状態が同じで、poke が消していなければ、取り込み直さない。 */
  private readonly captured = new Map<string, { at: number; sig: string; ask: PeerPendingAsk | null }>();

  constructor(private readonly d: ViewDeps) {
    this.tailDeps = { ...d.tail, pendingAsk: (sessionId) => this.pendingAsk(sessionId, false) };
    this.freshDeps = { ...d.tail, pendingAsk: (sessionId) => this.pendingAsk(sessionId, true) };
  }

  /**
   * 画面に出ている許可か質問。
   * 札が出ていない（登録が入力待ちでない）か、画面から読めなければ null。
   * fresh でなければ、登録の状態（waitingFor、許可の中身、問い）が変わらず poke も来ないかぎり、前の取り込みを使い続ける。
   */
  pendingAsk(sessionId: string, fresh: boolean): PeerPendingAsk | null {
    const session = this.d.session(sessionId);
    if (!session || session.live !== 'waiting') {
      this.captured.delete(sessionId);
      return null;
    }
    const fromHook = this.d.hookAsk?.(sessionId) ?? null;
    const sig = JSON.stringify([session.waitingFor, session.permission, session.activity?.question ?? null, fromHook]);
    const t = this.d.now();
    const hit = this.captured.get(sessionId);
    // 取り込みの覚えは、登録の状態が変わるか、poke（実行中の一覧の変化、預かりの変化、答え）が消すまで使い続ける。
    // 答えられないと印を付けた結果は、描き途中の画面（hook が先に届いた）の読み違いかもしれない。
    // 覚えを使い続けず、同じ札について UNANSWERABLE_RECHECK_MS に 1 回だけ取り直す（見る人数ぶん capture が増えないように）。
    // 問いが複数ある札も、同じ間隔で取り直す。手元でタブを進めても、登録の状態は変わらないからである。
    const stale = (hit?.ask?.answerable === false || hit?.ask?.step !== undefined) && t - hit.at >= UNANSWERABLE_RECHECK_MS;
    if (!fresh && hit && hit.sig === sig && !stale) return hit.ask;
    const run = this.d.run(sessionId);
    const pane = run ? this.d.pane(run.tmuxName) : null;
    let ask: PeerPendingAsk | null = null;
    if (pane) {
      try { ask = pendingAskFrom(session, pane.capture()); } catch { ask = null; }
    }
    // 画面から読めない札（ファイルの道具の札など）は、hook の入力から作った札で代える。答えは hook で返すので、画面の照合は要らない。
    if ((ask === null || ask.answerable === false) && fromHook) ask = fromHook;
    else if (ask && fromHook) ask = withDescriptions(ask, fromHook);
    this.captured.set(sessionId, { at: t, sig, ask });
    if (this.captured.size > 64) this.captured.delete(this.captured.keys().next().value!);
    return ask;
  }

  /**
   * いま出ている札（askId を含む）。
   * T4 の答える処理と askId を突き合わせる。
   */
  currentAsk(sessionId: string): PeerChatAsk | null {
    return currentPendingAsk(sessionId, this.freshDeps);
  }

  /**
   * いま出ている札の項目（tail が最後に出すもの）。
   * 答える前に取っておき、答えた後の記録に使う（答えれば札は閉じる）。
   */
  askItem(sessionId: string, askId: string): PeerChatItem | null {
    const last = transcriptTail(sessionId, null, 1, this.freshDeps).items.at(-1);
    return last?.ask?.askId === askId ? last : null;
  }

  /**
   * 現在の札（NowCard）の材料。
   * 動いている会話で、digest の口があるときだけ。無ければ undefined（見る側は右の欄を出さない）。
   * 組み立ては見る側の presenter に任せ、ここは材料を刈って渡すだけである（hostCard.ts）。
   */
  card(sessionId: string): PeerChatCard | undefined {
    const session = this.d.session(sessionId);
    if (!this.d.digest || !session || this.status(sessionId) === 'stopped') return undefined;
    let card: PeerChatCard | null = null;
    try {
      const digest = this.d.digest(sessionId);
      const t = this.d.turnEvents?.(sessionId, digest.turnStartSeq) ?? { events: [], dropped: 0 };
      card = buildPeerChatCard({ session, digest, events: t.events, dropped: t.dropped, artifacts: this.d.artifactCount?.(sessionId) ?? 0, hints: this.d.liveHints?.() ?? true });
    } catch { card = null; }
    return card ?? undefined;
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
    // 同じ札の記録は 1 つにする。答える最中に、札が消えたことを見て先にこの PC の手元の記録が入ったときは、選んだ行の分かる、後の記録で置き換える。
    this.answers = this.answers.filter((a) => !(a.askId === askId && a.sessionId === sessionId));
    this.answers.push({ askId, sessionId, item, at: this.d.now() });
    if (this.answers.length > RECORD_MAX) this.answers.shift();
    this.poke(sessionId);
  }

  /**
   * 札の出入りを見る（build と答えの前に呼ぶ）。
   * 出ている札を覚え、その札が消えたのに、ほかの PC の答えの記録が無ければ、この PC の手元で答えた記録を足す。
   * 札が閉じたことを見る側に伝え、遅れて来たほかの PC の答えを already-answered で断るためである。
   * label は空にする（手元で選んだ行は分からない）。画面は「{device} で答えました」と読ませる。
   * 札が消えただけで答えたとは言えない場合は、記録せず覚えも保つ。
   * 画面の読み取りが一度失敗しただけ（登録はまだ入力待ち）のときは、次の確かめまで待つ。
   * 会話が動いていないときは、答えたのではなく止まったので、記録せずに忘れる。
   */
  observe(sessionId: string): void {
    const cur = transcriptTail(sessionId, null, 1, this.tailDeps).items.at(-1);
    const now = cur?.ask ? cur : null;
    const prev = this.lastAsk.get(sessionId);
    if (now) {
      if (prev && prev.ask!.askId !== now.ask!.askId) {
        // 同じ札の askId が言い換わっただけ（hook が先に届き、tool_use が後から載った）なら、答えたとは記録せず、置き換える。
        if (this.rekeyed(sessionId, prev, now)) this.rememberRekey(prev.ask!.askId, now.ask!.askId);
        else this.settleAsk(sessionId, prev);
      }
      this.lastAsk.delete(sessionId);
      this.lastAsk.set(sessionId, now);
      if (this.lastAsk.size > RECORD_MAX) this.lastAsk.delete(this.lastAsk.keys().next().value!);
      return;
    }
    if (!prev) return;
    if (this.status(sessionId) === 'stopped') { this.lastAsk.delete(sessionId); return; }
    if (this.d.session(sessionId)?.live === 'waiting') return;
    this.settleAsk(sessionId, prev);
    this.lastAsk.delete(sessionId);
  }

  /**
   * prev が、今出ている札の、拠り所が決まる前の姿か。
   * 拠り所なしの askId で計算し直した値が prev の askId と一致し、種類も同じなら、同じ札である。
   * 位置（uuid の @ask: より前）も同じでなければならない。
   * 同じ命令の 2 回目の札は、内容が同じで askId だけ違うので、位置まで見ないと言い換えと取り違える（1 枚目は手元で答えられている）。
   * ただし、札を呼ぶ前の一言（返答の文）が tool_use より先に載ると、位置が後ろへずれる。
   * ずれた先までの間が返答の文だけなら、間に道具も発言も無いので 2 回目の札ではありえず、言い換えと見なす。
   * 言い換えと見ずに settle すると、古い札を見ている PC の答えが、誰も答えていないのに already-answered で断られる。
   * 内容が違う札や、拠り所が付いていた札の入れ替わりは、別の札として扱う。
   */
  private rekeyed(sessionId: string, prev: PeerChatItem, now: PeerChatItem): boolean {
    if (prev.kind !== now.kind || prev.ask!.kind !== now.ask!.kind) return false;
    const from = askBase(prev.uuid);
    const to = askBase(now.uuid);
    if (from !== to && !onlyRepliesBetween(sessionId, from, to, this.tailDeps)) return false;
    const pending = this.pendingAsk(sessionId, false);
    return pending !== null && peerAskId(pending, '') === prev.ask!.askId;
  }

  private rememberRekey(from: string, to: string): void {
    this.rekeys.delete(from);
    this.rekeys.set(from, to);
    if (this.rekeys.size > RECORD_MAX) this.rekeys.delete(this.rekeys.keys().next().value!);
  }

  /**
   * 見る側が持つ askId を、今の札の askId に読み替える。
   * 言い換えを見たことのある askId で、その言い換え先が今の札のときだけ読み替える。それ以外は、そのまま返す。
   * 読み替えても、画面の照合（answer.ts の dialogMatches）は答える側で必ず通る。
   */
  resolveAskId(askId: string, currentAskId: string): string {
    return this.rekeys.get(askId) === currentAskId ? currentAskId : askId;
  }

  /** to へ言い換えた前の askId（いちばん新しい覚え）。無ければ null。 */
  private rekeyedFrom(to: string): string | null {
    let from: string | null = null;
    for (const [k, v] of this.rekeys) if (v === to) from = k;
    return from;
  }

  private settleAsk(sessionId: string, prev: PeerChatItem): void {
    if (!prev.ask || this.answers.some((a) => a.sessionId === sessionId && a.askId === prev.ask!.askId)) return;
    this.recordAnswer(sessionId, prev, this.d.self(), '');
  }

  /** askId は札の文面から作るので、会話をまたいで同じになりうる。答えた記録は会話ごとに見る。 */
  answeredAsk(sessionId: string, askId: string): boolean {
    this.sweep();
    return this.answers.some((a) => a.sessionId === sessionId && a.askId === askId);
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
      if (it.ask && !it.ask.answered) {
        // 言い換えた札には前の askId を添える。位置がずれた言い換えを、見る側が同じ札と分かるようにする。
        const from = this.rekeyedFrom(it.ask.askId);
        return from === null ? it : { ...it, ask: { ...it.ask, replaces: from } };
      }
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
    this.observe(sessionId);
    const t = transcriptTail(sessionId, after, undefined, this.tailDeps);
    const extras = this.answers.filter((a) => a.sessionId === sessionId && !t.items.some((i) => i.uuid === a.item.uuid)).map((a) => a.item);
    const items = this.annotate(t.items, sessionId);
    // 答えの記録の札は、札が呼んだ位置（直前の項目の直後）に入れる。末尾に足すと、あとの返答より下に並ぶ。
    // 直前の項目が今回の返す項目に無いとき。
    // 直前の項目が返す範囲に無いとき。
    // 項目を落としたこと（truncated）で落ちた範囲（after の後ろで、返す先頭より前）にあるなら、札も出さない（見る側は差し替える）。
    // after の続きで、直前の項目が after の位置なら先頭、それ以外（transcript に最初から無い、見る側がすでに持つ位置）は末尾に足す。
    const afterPos = t.truncated && after !== null ? transcriptPosition(sessionId, askBase(after), this.tailDeps) : -1;
    for (const x of extras) {
      const base = askBase(x.uuid);
      if (base === '' || items.some((i) => i.uuid === base)) { items.splice(peerAskInsertIndex(items, x), 0, x); continue; }
      if (t.truncated && transcriptPosition(sessionId, base, this.tailDeps) > afterPos) continue;
      items.splice(peerAskInsertIndex(items, x, after !== null && base === askBase(after)), 0, x);
    }
    const gone = this.gone.filter((g) => g.sessionId === sessionId && g.deviceId === deviceId).map((g) => g.gone);
    const status = this.status(sessionId);
    const queued = this.d.queued(sessionId).map((q) => ({ ...q, text: clipText(q.text, QUEUED_TEXT_MAX_BYTES) }));
    const card = this.card(sessionId);
    // 札の材料が変わったら（サブエージェントの出入り、裏だけへの移り、新しい手）、本文が変わらなくても待ちを返す。
    const cardSig = card ? createHash('sha1').update(JSON.stringify(card)).digest('base64') : null;
    const sig = JSON.stringify([status, queued.map((q) => [q.queueId, q.state]), this.answers.filter((a) => a.sessionId === sessionId).map((a) => a.askId), gone.map((g) => g.queueId), this.pendingAsk(sessionId, false)?.answerable === false, cardSig]);
    const state: PeerChatState = { sessionId, status, items, queued, cursor: t.cursor, truncated: t.truncated, hostId: this.d.hostId, turnCount: transcriptTurnCount(sessionId, this.tailDeps) };
    if (gone.length > 0) state.gone = gone;
    if (card) state.card = card;
    const account = this.d.accountName?.(sessionId) ?? null;
    if (account !== null) state.account = account;
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
    if (sessionId === undefined) this.captured.clear();
    else this.captured.delete(sessionId);
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
