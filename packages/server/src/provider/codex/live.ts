import type { LiveSessionDto, LiveStatus } from '@agent-hangar/shared';
import type { AgentAsk, AskSource, LiveSource } from '../../agent/types.ts';
import { isAlive } from '../../platform/proc.ts';
import { codexAsks, codexPendingOf, codexQuestionAsked, type CodexAskFeed, type CodexPending } from './asks.ts';
import { CodexRpcError, type CodexRpc, type CodexThreadStatus } from './appServer.ts';

/**
 * Codex の状態の面（docs/design.md「Codex の状態と許可」）。
 *
 * hangar の会話 1 つに app-server が 1 本あり（B3a が起こす）、その app-server への接続（CodexRpc）の通知から、実行中の一覧の写しを持つ。
 * 状態は app-server からだけ取る。rollout の task_started だけでは実行中とみなさない（素の TUI を kill すると、task_complete が書かれずに残る）。
 * hangar の外の会話は状態を持たない（track されないので、行が無い）。
 *
 * - `thread/status/changed` は購読しなくても全接続へ届く。idle と notLoaded と systemError は休み、active は作業中、
 *   `activeFlags` の waitingOnApproval は許可の待ち、waitingOnUserInput は質問の待ちである。
 * - `turn/started`・`turn/completed` と、承認の要求（サーバからの要求）、`serverRequest/resolved` は、スレッドを購読した接続にだけ届く。
 *   thread/start した接続は購読済み。TUI が作ったスレッドは、最初の active で `thread/resume {excludeTurns:true}` を送って購読する。
 *   入力の前は "no rollout found" で断られるので、短い間隔で再試行する。最初のターンの冒頭は取りこぼす。
 * - hangar の接続は承認の要求に答えない。答えは TUI で行う。要求が TUI で解かれたら（`serverRequest/resolved`、待ちの旗が消える、ターンの終わり、休み）、写しからも消す。
 * - 接続が閉じた（TUI を閉じて app-server を止めた、app-server が落ちた）ら、行ごと外す。「実行中」は残さない。app-server の pid が消えたときも同じ。
 */

/** 写しに使う接続の口。CodexRpc の一部。 */
export type CodexRpcLike = Pick<CodexRpc, 'request' | 'on' | 'onAny' | 'onServerRequest' | 'onClose' | 'isClosed'>;

/** 写しに載せる会話。providerSessionId は thread の ID（thread_id と session_id は同じ）。pid は app-server の pid。 */
export type CodexLiveTarget = {
  providerSessionId: string;
  cwd: string;
  pid: number;
  rpc: CodexRpcLike;
  /** hangar の接続がこのスレッドを購読済みか（thread/start、thread/resume した接続なら true）。偽なら、最初の active で購読する。 */
  subscribed?: boolean;
};

/** subscribe の再試行の間（ミリ秒）。最後の値で止まり、回数は maxSubscribeAttempts まで。 */
export const CODEX_SUBSCRIBE_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1500];

export type CodexLiveOptions = {
  /** 足し付けの鎖（agent/liveHub.ts の LiveHub.enrich）。組み直すたびに通す。 */
  enrich?: (live: LiveSessionDto[]) => LiveSessionDto[];
  /** app-server の pid が生きているか。既定は OS に聞く。 */
  pidAlive?: (pid: number) => boolean;
  subscribeDelaysMs?: readonly number[];
  maxSubscribeAttempts?: number;
  /** pid の見張りの間。 */
  pidCheckMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

type Conn = {
  t: CodexLiveTarget;
  /** thread/status の type と旗。 */
  type: string;
  flags: string[];
  /** `turn/started` から `turn/completed` まで（購読していれば）。 */
  turnActive: boolean;
  status: LiveStatus;
  statusAt: number;
  /** 待っている要求。key は要求の ID。 */
  pending: Map<string, CodexPending>;
  subscribed: boolean;
  subscribing: boolean;
  /** status を受けた回数。読み直しの答えより新しい通知を、古い答えで潰さないために使う。 */
  statusSeq: number;
  offs: (() => void)[];
  timers: Set<ReturnType<typeof setTimeout>>;
};

const APPROVAL = 'waitingOnApproval';
const USER_INPUT = 'waitingOnUserInput';

export class CodexLive implements LiveSource, CodexAskFeed {
  private readonly conns = new Map<string, Conn>();
  private readonly listeners = new Set<(live: LiveSessionDto[]) => void>();
  private readonly askListeners = new Set<(a: AgentAsk) => void>();
  private cur: LiveSessionDto[] = [];
  private key = '[]';
  private started = false;
  private pidTimer: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private kickDue = 0;
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;

  constructor(private readonly o: CodexLiveOptions = {}) {
    this.now = o.now ?? Date.now;
    this.pidAlive = o.pidAlive ?? isAlive;
  }

  /** 会話を写しに載せ、その接続の通知を読み始める。同じ会話を載せ直したら、前の接続の読みは外す。接続がもう閉じていれば載せない。 */
  track(t: CodexLiveTarget): void {
    if (this.conns.has(t.providerSessionId)) this.drop(t.providerSessionId);
    if (t.rpc.isClosed) return;
    const c: Conn = {
      t, type: 'idle', flags: [], turnActive: false, status: 'idle', statusAt: this.now(), pending: new Map(),
      subscribed: t.subscribed === true, subscribing: false, statusSeq: 0, offs: [], timers: new Set(),
    };
    this.conns.set(t.providerSessionId, c);
    this.attach(c);
    this.rebuild();
    void this.resync(c);
  }

  /** 会話を写しから外す。答えを待っていた問いは、答えたと流す（もう答えられない）。 */
  untrack(providerSessionId: string): void {
    if (this.drop(providerSessionId)) this.rebuild();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pidTimer = setInterval(() => {
      for (const c of [...this.conns.values()]) if (!this.pidAlive(c.t.pid)) this.lost(c, 'app-server pid is gone');
    }, this.o.pidCheckMs ?? 3000);
    this.pidTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.pidTimer) clearInterval(this.pidTimer);
    this.pidTimer = null;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
  }

  current(): LiveSessionDto[] {
    return this.cur;
  }

  onChange(cb: (live: LiveSessionDto[]) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  onAsk(cb: (a: AgentAsk) => void): () => void {
    this.askListeners.add(cb);
    return () => { this.askListeners.delete(cb); };
  }

  /** delayMs 後に、全部の会話の状態を `thread/read` で読み直す。先に予約したほうが早ければ、そちらに任せる。 */
  kick(delayMs: number): void {
    if (!this.started) return;
    const due = this.now() + delayMs;
    if (this.kickTimer) {
      if (this.kickDue <= due) return;
      clearTimeout(this.kickTimer);
    }
    this.kickDue = due;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      for (const c of this.conns.values()) void this.resync(c);
    }, delayMs);
    this.kickTimer.unref?.();
  }

  isRunning(providerSessionId: string, pid: number): boolean {
    const c = this.conns.get(providerSessionId);
    return !!c && c.t.pid === pid && !c.t.rpc.isClosed && this.pidAlive(pid);
  }

  // ---- 通知 ----

  private attach(c: Conn): void {
    const rpc = c.t.rpc;
    const id = c.t.providerSessionId;
    c.offs.push(
      rpc.on('thread/status/changed', (p) => { if (p.threadId === id) this.onStatus(c, p.status); }),
      rpc.on('turn/started', (p) => {
        if (p.threadId !== id) return;
        c.turnActive = true;
        this.update(c);
      }),
      rpc.on('turn/completed', (p) => {
        if (p.threadId !== id) return;
        c.turnActive = false;
        this.dropPending(c, () => true);
        this.update(c);
      }),
      rpc.onAny((n) => {
        if (n.method !== 'serverRequest/resolved') return;
        const p = typeof n.params === 'object' && n.params !== null ? n.params as { threadId?: unknown; requestId?: unknown } : {};
        if (p.threadId !== undefined && p.threadId !== id) return;
        if (p.requestId === undefined) return;
        const gone = c.pending.get(String(p.requestId));
        if (!this.dropPending(c, (q) => q.key === String(p.requestId))) return;
        // 後続の status を待たずに旗も下ろす（同じ種類の要求がほかに残っていなければ）。
        const flag = gone?.kind === 'permission' ? APPROVAL : USER_INPUT;
        if (![...c.pending.values()].some((q) => q.kind === gone?.kind)) c.flags = c.flags.filter((f) => f !== flag);
        this.update(c);
      }),
      rpc.onServerRequest((r) => {
        const q = codexPendingOf(r);
        if (!q || q.threadId !== id) return;
        c.pending.set(q.key, q);
        this.update(c);
      }),
    );
    rpc.onClose(() => this.lost(c, 'app-server connection closed'));
  }

  private onStatus(c: Conn, s: CodexThreadStatus): void {
    c.statusSeq++;
    this.applyStatus(c, s);
    this.update(c);
  }

  /**
   * status を当てる。待ちの旗が消えたら、その種類の要求を写しから消す（TUI で解かれた。serverRequest/resolved を取りこぼしても直る）。
   * 旗が消えるのを見て消すので、要求のほうが先に届いて旗が後から付く順でも、新しい要求を消さない。
   */
  private applyStatus(c: Conn, s: CodexThreadStatus): void {
    const prev = c.flags;
    const active = s.type === 'active';
    c.type = s.type;
    c.flags = active ? (s.activeFlags ?? []).filter((f): f is string => typeof f === 'string') : [];
    if (!active) {
      c.turnActive = false;
      this.dropPending(c, () => true);
    } else {
      if (prev.includes(APPROVAL) && !c.flags.includes(APPROVAL)) this.dropPending(c, (q) => q.kind === 'permission');
      if (prev.includes(USER_INPUT) && !c.flags.includes(USER_INPUT)) this.dropPending(c, (q) => q.kind === 'question');
      void this.ensureSubscribed(c);
    }
  }

  /** 条件に合う要求を消す。問いは、答えたと流す。消したら true。 */
  private dropPending(c: Conn, match: (q: CodexPending) => boolean): boolean {
    let any = false;
    for (const [k, q] of [...c.pending]) {
      if (!match(q)) continue;
      c.pending.delete(k);
      any = true;
      if (q.kind === 'question') this.emitAsk({ kind: 'question', providerSessionId: c.t.providerSessionId, hook: { kind: 'answered', providerSessionId: c.t.providerSessionId, toolId: q.toolId } });
    }
    return any;
  }

  // ---- 購読と読み直し ----

  /** 最初の active のあとにスレッドを購読する。"no rollout found" は、入力の前なので短い間隔で再試行する。 */
  private async ensureSubscribed(c: Conn): Promise<void> {
    if (c.subscribed || c.subscribing) return;
    c.subscribing = true;
    const delays = this.o.subscribeDelaysMs?.length ? this.o.subscribeDelaysMs : CODEX_SUBSCRIBE_DELAYS_MS;
    const max = this.o.maxSubscribeAttempts ?? 20;
    try {
      for (let i = 0; i < max; i++) {
        if (!this.alive(c)) return;
        try {
          await c.t.rpc.request('thread/resume', { threadId: c.t.providerSessionId, excludeTurns: true });
          c.subscribed = true;
          return;
        } catch (e) {
          if (!(e instanceof CodexRpcError) || !/no rollout/i.test(e.message)) {
            this.o.log?.(`[codex] subscribe failed for ${c.t.providerSessionId}: ${e instanceof Error ? e.message : String(e)}`);
            return;
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { c.timers.delete(timer); resolve(); }, delays[Math.min(i, delays.length - 1)]!);
          timer.unref?.();
          c.timers.add(timer);
        });
      }
      this.o.log?.(`[codex] subscribe gave up for ${c.t.providerSessionId}`);
    } finally {
      c.subscribing = false;
    }
  }

  /** `thread/read` で今の status を取り、読んでいる間に新しい通知が無かったときだけ当てる。読めなければ通知のままにする。 */
  private async resync(c: Conn): Promise<void> {
    const seq = c.statusSeq;
    try {
      const r = await c.t.rpc.request<{ thread?: { status?: CodexThreadStatus } }>('thread/read', { threadId: c.t.providerSessionId, includeTurns: false });
      const s = r.thread?.status;
      if (!s || !this.alive(c) || c.statusSeq !== seq) return;
      this.applyStatus(c, s);
      this.update(c);
    } catch {
      // 読めなければ、通知で持っている状態のまま。
    }
  }

  private alive(c: Conn): boolean {
    return this.conns.get(c.t.providerSessionId) === c && !c.t.rpc.isClosed;
  }

  // ---- 外す ----

  /** 接続が閉じた、または pid が消えた。行を外す（「実行中」を残さない）。 */
  private lost(c: Conn, why: string): void {
    if (this.conns.get(c.t.providerSessionId) !== c) return;
    this.o.log?.(`[codex] ${why} for ${c.t.providerSessionId} (pid ${c.t.pid})`);
    this.untrack(c.t.providerSessionId);
  }

  private drop(providerSessionId: string): boolean {
    const c = this.conns.get(providerSessionId);
    if (!c) return false;
    this.conns.delete(providerSessionId);
    for (const off of c.offs) off();
    c.offs = [];
    for (const t of c.timers) clearTimeout(t);
    c.timers.clear();
    this.dropPending(c, () => true);
    return true;
  }

  // ---- 状態 ----

  /** 状態が変わったかもしれない。動きを決め直し、許可と問いを流し、行を組み直す。 */
  private update(c: Conn): void {
    if (this.conns.get(c.t.providerSessionId) !== c) return;
    const waiting = c.pending.size > 0 || c.flags.includes(APPROVAL) || c.flags.includes(USER_INPUT);
    const status: LiveStatus = waiting ? 'waiting' : c.type === 'active' || c.turnActive ? 'busy' : 'idle';
    if (status !== c.status) { c.status = status; c.statusAt = this.now(); }
    this.announce(c);
    this.rebuild();
  }

  /** 新しく出た要求を流す。許可は 1 件ずつ、問いは asked として。 */
  private announce(c: Conn): void {
    const id = c.t.providerSessionId;
    for (const q of c.pending.values()) {
      if (saidOf(c).has(q.key)) continue;
      saidOf(c).add(q.key);
      if (q.kind === 'permission') this.emitAsk({ kind: 'permission', providerSessionId: id, ask: q.ask });
      else this.emitAsk({ kind: 'question', providerSessionId: id, hook: codexQuestionAsked(id, q) });
    }
    for (const k of [...saidOf(c)]) if (!c.pending.has(k)) saidOf(c).delete(k);
  }

  private emitAsk(a: AgentAsk): void {
    for (const cb of this.askListeners) cb(a);
  }

  /** 行を組み直し、足し付けを通して、変わったときだけ差し替えて知らせる。 */
  private rebuild(): void {
    const rows = [...this.conns.values()].map((c) => rowOf(c)).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const live = this.o.enrich ? this.o.enrich(rows) : rows;
    const key = JSON.stringify(live);
    if (key === this.key) return;
    this.key = key;
    this.cur = live;
    for (const cb of this.listeners) cb(live);
  }
}

const said = new WeakMap<Conn, Set<string>>();
function saidOf(c: Conn): Set<string> {
  let s = said.get(c);
  if (!s) said.set(c, (s = new Set()));
  return s;
}

/** 写しの 1 行。名前は hangar の会話の名前を使うので持たない。待ちは許可を先に見せる。要求の中身が無い待ち（購読の前）は、旗だけで種類を出す。 */
function rowOf(c: Conn): LiveSessionDto {
  const l: LiveSessionDto = { sessionId: c.t.providerSessionId, status: c.status, name: null, nameSource: null, cwd: c.t.cwd, pid: c.t.pid, statusAt: c.statusAt, agent: 'codex' };
  if (c.status !== 'waiting') return l;
  const pend = [...c.pending.values()];
  const perm = pend.find((q): q is Extract<CodexPending, { kind: 'permission' }> => q.kind === 'permission');
  if (perm) {
    l.waitingFor = 'permission';
    l.permission = perm.ask;
  } else if (pend.length) {
    l.waitingFor = 'question';
  } else if (c.flags.includes(APPROVAL)) {
    l.waitingFor = 'permission';
  } else {
    l.waitingFor = 'question';
  }
  return l;
}

/** B3a が driver に差す面。live と asks は同じ CodexLive を指す（track と untrack は live に対して行う）。 */
export type CodexLiveSurface = { live: CodexLive; asks: AskSource };

export function createCodexLive(o: CodexLiveOptions = {}): CodexLiveSurface {
  const live = new CodexLive(o);
  return { live, asks: codexAsks(live) };
}
