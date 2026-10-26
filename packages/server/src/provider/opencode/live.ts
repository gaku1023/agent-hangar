import type { LiveSessionDto, LiveStatus } from '@agent-hangar/shared';
import type { AgentAsk, LiveSource } from '../../agent/types.ts';
import { isAlive } from '../../platform/proc.ts';
import { formToolIdOf, permissionAskOf, questionAskedOf, type AskFeed } from './asks.ts';
import { OpencodeClient, formOf, permissionRequestOf, type OpencodeForm, type OpencodePermissionRequest } from './client.ts';

/**
 * opencode の状態の面（docs/design.md「opencode の状態」）。
 *
 * hangar の会話 1 つに serve が 1 本あり（serve/manager.ts）、その serve の出来事の流れ（`GET /api/event`、SSE）を読んで、実行中の一覧の写しを持つ。
 * 流れだけに頼ると、切れている間の取りこぼしが直らない。そこで、つないだとき（つなぎ直しも）と kick のときは、
 * `GET /api/session/active`・`GET /api/permission/request`・`GET /api/form` で全体を取り直す。
 * 取り直しの答えが来るまでに届いた出来事は、答えの上にもう一度当てる（出来事は当て直しても同じ結果になる形だけを使う）。
 *
 * 行は、serve を起こして会話を作った（track）ときから、止めた（untrack）か serve の pid が消えたときまで載る。
 * Claude の登録と同じく、休み（idle）の会話も載る。opencode の `/api/session/active` は動いている間の会話しか持たないので、そこから休みと作業中を分ける。
 * 許可と form が出ている間は入力待ち（waiting）で、許可なら waitingFor は permission（tool は `shell` など）、form なら question にする。
 * 行の pid は serve の pid で、isRunning もそれで答える（RunManager の stillRunning）。
 */

/** 写しに載せる会話。serve は会話の serve（url、パスワード、pid）。 */
export type OpencodeLiveTarget = { providerSessionId: string; cwd: string; serve: { url: string; password: string; pid: number } };

/** つなぎ直すまでの間。切れるたびに次の値へ進み、最後の値で止まる。つながったら最初に戻す。 */
export const OPENCODE_RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 5000];

export type OpencodeLiveOptions = {
  /** 足し付けの鎖（agent/liveHub.ts の LiveHub.enrich）。組み直すたびに通す。 */
  enrich?: (live: LiveSessionDto[]) => LiveSessionDto[];
  /** serve の pid が生きているか。既定は OS に聞く。 */
  pidAlive?: (pid: number) => boolean;
  reconnectDelaysMs?: readonly number[];
  /** 取り直しの要求 1 つの上限。 */
  requestTimeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

type Ev = { type: string; data: Record<string, unknown> };

/** serve の出来事の受け手。providerSessionId は流れを読んでいる会話、type は出来事の種類（`session.step.ended` など）である。 */
export type OpencodeEventListener = (providerSessionId: string, type: string) => void;

/**
 * 失敗の文が「モデルの長さが足りない」ことを言っているか（docs/design.md「起動前の準備」）。
 * LM Studio が JIT で短く載せたモデルに、opencode の最初の一手（システムプロンプトと道具の定義）が収まらなかったときの文を見る。
 */
export function isContextShortError(message: string): boolean {
  return /greater than the context length|when context the overflows|context length of only|exceeds the (available )?context( size| length| window)|maximum context length/i.test(message);
}

/**
 * 失敗の文が「この PC のサーバーに無いモデルだった」ことを言っているか。あれば、文から取れたモデルの名前（取れなければ null）を返す。
 * LM Studio が、無いモデルの最初の発言に 400 で返す文（`provider.invalid-request: Invalid model identifier "…"`）を見る。名前は provider を含まない。
 */
export function modelMissingOf(message: string): { model: string | null } | null {
  if (!/provider\.invalid-request/i.test(message) || !/Invalid model identifier/i.test(message)) return null;
  return { model: /Invalid model identifier "([^"]+)"/i.exec(message)?.[1] ?? null };
}

type Conn = {
  t: OpencodeLiveTarget;
  client: OpencodeClient;
  /** `/api/session/active` に載っている（作業中）。 */
  running: boolean;
  perms: Map<string, OpencodePermissionRequest>;
  forms: Map<string, OpencodeForm>;
  status: LiveStatus;
  statusAt: number;
  /** 開いている流れを切る口。流れが無ければ null。 */
  ac: AbortController | null;
  retry: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 取り直しの途中なら、その間に届いた出来事。取り直していなければ null。 */
  syncing: Ev[] | null;
  /** 取り直しの途中にもう一度頼まれた。 */
  again: boolean;
  /** subscribe へ流した許可の ID と、form の ID から道具の呼び出しの ID。 */
  saidPerms: Set<string>;
  saidForms: Map<string, string>;
};

export class OpencodeLive implements LiveSource, AskFeed {
  private readonly conns = new Map<string, Conn>();
  private readonly listeners = new Set<(live: LiveSessionDto[]) => void>();
  private readonly askListeners = new Set<(a: AgentAsk) => void>();
  private readonly eventListeners = new Set<OpencodeEventListener>();
  private readonly contextShortListeners = new Set<(providerSessionId: string, message: string) => void>();
  private readonly modelMissingListeners = new Set<(providerSessionId: string, model: string | null) => void>();
  private cur: LiveSessionDto[] = [];
  private key = '[]';
  private started = false;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private kickDue = 0;
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly delays: readonly number[];

  constructor(private readonly o: OpencodeLiveOptions = {}) {
    this.now = o.now ?? Date.now;
    this.pidAlive = o.pidAlive ?? isAlive;
    this.delays = o.reconnectDelaysMs?.length ? o.reconnectDelaysMs : OPENCODE_RECONNECT_DELAYS_MS;
  }

  /** 会話を写しに載せる。動いていれば、その serve の流れを読み始める。同じ会話を載せ直したら、前の serve の流れは閉じる。 */
  track(t: OpencodeLiveTarget): void {
    if (this.conns.has(t.providerSessionId)) this.drop(t.providerSessionId);
    const c: Conn = {
      t, client: new OpencodeClient(t.serve, { timeoutMs: this.o.requestTimeoutMs ?? 5000 }),
      running: false, perms: new Map(), forms: new Map(), status: 'idle', statusAt: this.now(),
      ac: null, retry: 0, timer: null, syncing: null, again: false, saidPerms: new Set(), saidForms: new Map(),
    };
    this.conns.set(t.providerSessionId, c);
    this.rebuild();
    if (this.started) this.connect(c);
  }

  /** 会話を写しから外し、流れを閉じる。答えを待っていた問いは、答えたと流す（もう答えられない）。 */
  untrack(providerSessionId: string): void {
    if (this.drop(providerSessionId)) this.rebuild();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const c of this.conns.values()) this.connect(c);
  }

  stop(): void {
    this.started = false;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
    for (const c of this.conns.values()) this.close(c);
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

  /**
   * serve の出来事を 1 件ずつ受ける口。トランスクリプトの面（transcript/source.ts）が、本文を読み直す契機に使う。
   * providerSessionId は流れを読んでいる serve の会話（hangar の会話）で、出来事の data.sessionID（サブエージェントの会話のことがある）とは限らない。
   * つないだとき（つなぎ直しも）は、流れの頭の `server.connected` が届く。
   */
  onEvent(cb: OpencodeEventListener): () => void {
    this.eventListeners.add(cb);
    return () => { this.eventListeners.delete(cb); };
  }

  /**
   * モデルの長さが足りずに断られた失敗（`session.execution.failed` の error.message）を受ける口。
   * providerSessionId は流れを読んでいる serve の会話である（サブエージェントの会話の失敗も、親の会話として知らせる）。
   */
  onContextShort(cb: (providerSessionId: string, message: string) => void): () => void {
    this.contextShortListeners.add(cb);
    return () => { this.contextShortListeners.delete(cb); };
  }

  /** 無いモデルで断られた失敗を受ける口。model は文から取れたモデルの名前（provider を含まない）で、取れなければ null。providerSessionId は onContextShort と同じ。 */
  onModelMissing(cb: (providerSessionId: string, model: string | null) => void): () => void {
    this.modelMissingListeners.add(cb);
    return () => { this.modelMissingListeners.delete(cb); };
  }

  /** delayMs 後に、流れを読んでいる serve の全部を取り直す。先に予約した取り直しのほうが早ければ、そちらに任せる。 */
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
      for (const c of this.conns.values()) if (c.ac) this.resync(c);
    }, delayMs);
    this.kickTimer.unref?.();
  }

  isRunning(providerSessionId: string, pid: number): boolean {
    const c = this.conns.get(providerSessionId);
    return !!c && c.t.serve.pid === pid && this.pidAlive(pid);
  }

  // ---- 流れ ----

  private connect(c: Conn): void {
    if (!this.started || this.conns.get(c.t.providerSessionId) !== c || c.ac) return;
    const ac = new AbortController();
    c.ac = ac;
    void c.client.events(ac.signal)
      .then(async (body) => {
        c.retry = 0;
        // 流れの頭には状態が来ない（`server.connected` だけ）。つないだら全体を取り直す。
        this.resync(c);
        await this.read(c, body);
      })
      .catch(() => undefined)
      .finally(() => {
        if (c.ac !== ac) return;
        c.ac = null;
        this.lost(c);
      });
  }

  /** 流れを 1 件ずつ読む。`data:` の行をつないだものを JSON として読み、読めないものは捨てる。 */
  private async read(c: Conn, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let k: number;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let ev: unknown;
        try { ev = JSON.parse(data); } catch { continue; }
        if (typeof ev !== 'object' || ev === null || typeof (ev as { type?: unknown }).type !== 'string') continue;
        const d = (ev as { data?: unknown }).data;
        this.handle(c, { type: (ev as { type: string }).type, data: typeof d === 'object' && d !== null ? d as Record<string, unknown> : {} });
      }
    }
  }

  /** 流れが切れた。serve が消えていれば行を外し、生きていれば間をあけてつなぎ直す。 */
  private lost(c: Conn): void {
    if (!this.started || this.conns.get(c.t.providerSessionId) !== c) return;
    if (!this.pidAlive(c.t.serve.pid)) {
      this.o.log?.(`[opencode] serve for ${c.t.providerSessionId} is gone (pid ${c.t.serve.pid})`);
      this.untrack(c.t.providerSessionId);
      return;
    }
    const delay = this.delays[Math.min(c.retry, this.delays.length - 1)]!;
    c.retry++;
    c.timer = setTimeout(() => { c.timer = null; this.connect(c); }, delay);
    c.timer.unref?.();
  }

  private close(c: Conn): void {
    const ac = c.ac;
    c.ac = null;
    ac?.abort();
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
  }

  /** 会話を外す。外したら true。行の組み直しは呼び手が行う。 */
  private drop(providerSessionId: string): boolean {
    const c = this.conns.get(providerSessionId);
    if (!c) return false;
    this.conns.delete(providerSessionId);
    this.close(c);
    c.perms.clear();
    c.forms.clear();
    this.announce(c);
    return true;
  }

  // ---- 状態 ----

  private handle(c: Conn, ev: Ev): void {
    if (this.conns.get(c.t.providerSessionId) !== c) return;
    c.syncing?.push(ev);
    if (this.apply(c, ev)) this.update(c);
    for (const cb of this.eventListeners) {
      try { cb(c.t.providerSessionId, ev.type); } catch (e) { this.o.log?.(`[opencode] event listener failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (ev.type === 'session.execution.failed') {
      const err = ev.data.error;
      const message = typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
      if (isContextShortError(message)) for (const cb of this.contextShortListeners) cb(c.t.providerSessionId, message);
      const missing = modelMissingOf(message);
      if (missing) for (const cb of this.modelMissingListeners) cb(c.t.providerSessionId, missing.model);
    }
  }

  /**
   * 出来事を 1 つ当てる。当て直しても同じ結果になる形（作業中の入り切り、待ちの足し引き）だけを使う。状態に触れたら true。
   * 作業中の入り切りは、その会話の `session.execution.*` だけで見る（サブエージェントの会話は親の作業中に含まれる）。
   * 許可と form は、serve の上の会話のどれのものでも、この会話の待ちに数える（serve は hangar の会話 1 つに 1 本で、サブエージェントの待ちも利用者が答える）。
   * 作業が終わったら（成功、失敗、interrupt）、残った待ちを捨てる。interrupt では許可の答えの知らせが来ないため。
   */
  private apply(c: Conn, ev: Ev): boolean {
    const d = ev.data;
    const mine = d.sessionID === c.t.providerSessionId;
    if (ev.type === 'session.execution.started') {
      if (!mine) return false;
      c.running = true;
      return true;
    }
    if (ev.type.startsWith('session.execution.')) {
      if (!mine) return false;
      c.running = false;
      c.perms.clear();
      c.forms.clear();
      return true;
    }
    if (ev.type === 'permission.asked') {
      const p = permissionRequestOf(d);
      if (!p) return false;
      c.perms.set(p.id, p);
      return true;
    }
    if (ev.type.startsWith('permission.')) {
      const id = typeof d.requestID === 'string' ? d.requestID : typeof d.id === 'string' ? d.id : null;
      return id !== null && c.perms.delete(id);
    }
    if (ev.type === 'form.created') {
      const f = formOf(d.form);
      if (!f) return false;
      c.forms.set(f.id, f);
      return true;
    }
    if (ev.type.startsWith('form.')) {
      const form = typeof d.form === 'object' && d.form !== null ? d.form as { id?: unknown } : null;
      const id = typeof d.id === 'string' ? d.id : typeof d.formID === 'string' ? d.formID : typeof form?.id === 'string' ? form.id : null;
      return id !== null && c.forms.delete(id);
    }
    return false;
  }

  /** 全体を取り直す。答えの上に、待つ間に届いた出来事を当て直す。取り直せなければ、出来事で持っている状態のまま組み直す。 */
  private resync(c: Conn): void {
    if (c.syncing) { c.again = true; return; }
    const buffered: Ev[] = [];
    c.syncing = buffered;
    void Promise.all([c.client.active(), c.client.permissionRequests(c.t.cwd), c.client.forms(c.t.cwd)])
      .then(([active, perms, forms]) => {
        c.running = active.has(c.t.providerSessionId);
        c.perms = new Map(perms.map((p) => [p.id, p]));
        c.forms = new Map(forms.map((f) => [f.id, f]));
        for (const ev of buffered) this.apply(c, ev);
      })
      .catch(() => undefined)
      .finally(() => {
        c.syncing = null;
        if (this.conns.get(c.t.providerSessionId) !== c) return;
        this.update(c);
        if (c.again) { c.again = false; this.resync(c); }
      });
  }

  /** 状態が変わったかもしれない。動きを決め直し、許可と問いを流し、行を組み直す。 */
  private update(c: Conn): void {
    const status: LiveStatus = c.perms.size || c.forms.size ? 'waiting' : c.running ? 'busy' : 'idle';
    if (status !== c.status) { c.status = status; c.statusAt = this.now(); }
    this.announce(c);
    this.rebuild();
  }

  /** 新しく出た許可と form を流し、消えた form は答えたと流す（sessions/questionHook.ts が問いを外す）。 */
  private announce(c: Conn): void {
    const id = c.t.providerSessionId;
    for (const [pid, p] of c.perms) if (!c.saidPerms.has(pid)) this.emitAsk({ kind: 'permission', providerSessionId: id, ask: permissionAskOf(p) });
    c.saidPerms = new Set(c.perms.keys());
    for (const [fid, f] of c.forms) {
      if (c.saidForms.has(fid)) continue;
      c.saidForms.set(fid, formToolIdOf(f));
      this.emitAsk({ kind: 'question', providerSessionId: id, hook: questionAskedOf(id, f) });
    }
    for (const [fid, toolId] of [...c.saidForms]) {
      if (c.forms.has(fid)) continue;
      c.saidForms.delete(fid);
      this.emitAsk({ kind: 'question', providerSessionId: id, hook: { kind: 'answered', providerSessionId: id, toolId } });
    }
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

/** 写しの 1 行。名前は hangar の会話の名前を使うので持たない。待ちは許可を先に見せる。 */
function rowOf(c: Conn): LiveSessionDto {
  const l: LiveSessionDto = { sessionId: c.t.providerSessionId, status: c.status, name: null, nameSource: null, cwd: c.t.cwd, pid: c.t.serve.pid, statusAt: c.statusAt, agent: 'opencode' };
  const perm = c.perms.values().next().value;
  if (perm) {
    l.waitingFor = 'permission';
    l.permission = permissionAskOf(perm);
  } else if (c.forms.size) {
    l.waitingFor = 'question';
  }
  return l;
}
