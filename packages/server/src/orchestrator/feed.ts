import type { LiveSessionDto, LiveStatus, Translate, WaitKind } from '@agent-hangar/shared';

/**
 * 統括へ出来事を送り込む（docs/design.md「統括」の出来事の届け方）。
 *
 * 実行中の一覧の変化から出来事を作り、まとめ、統括の会話が idle で入力欄が空のときだけ、`[hangar]` で始まる 1 通にして入力欄へ渡す。
 * 長く待つ道具は使わない。何も起きなければ統括は動かず、使用量は出ない。
 *
 * 出来事の種類。
 * - ask.permission と ask.question：許可か質問の待ちに入った。急ぎで、0.3 秒でまとめて渡す。
 * - turn.done：busy から idle になった。統括が関わった会話（統括が起こした、または統括が送った）だけ。
 * - session.ended：run が消えた。同じく統括が関わった会話だけ。
 * 統括自身の会話の変化は出来事にしない。最初の観測は覚えるだけで、出来事にしない。
 *
 * 渡し方は、ほかの PC の文の預かり（peer/chat/queue.ts）と同じ規則にそろえる。
 * 統括が idle で入力欄が空のときだけ渡し、渡す直前にも入力欄を読み直す（deliver の側）。利用者が打ちかけなら渡さない。
 * 渡したあとは、統括のターンが動き出すのを一度見るか settleMs がたつまで、次を渡さない。
 * 預かりの間に増えた出来事は 1 通にまとめ、渡す前に、解けた待ち（もう待っていない会話）を捨てる。
 * 預かりが maxItems を超えたら、古い turn.done と session.ended から捨てる。許可と質問は捨てない。
 *
 * 許可待ちの通知の猶予。
 * 統括が有効で idle のときに許可待ちになった会話は、graceMs のあいだ OS とスマホの通知を預かる（held）。
 * 決めるのは待ちに入ったのを見た瞬間で、その後に統括が出来事を受けて busy になっても、猶予は続く。
 * 猶予の間に待ちが消えれば通知は出ない。消えなければ、猶予が明けたときに onGraceEnd で知らせ、通知の側が 1 回出す。
 * 統括が無効、止まっている、busy のときは猶予を付けない（今までどおりすぐ出す）。
 *
 * 太り。統括の文脈が compactTokens を超え、idle が compactIdleMs 続き、預かりが空のとき、`/compact` を 1 回だけ送る。
 * 文脈が閾値を下回れば、次にまた超えたときに送れるようにする。
 */

export type FeedEventKind = 'ask.permission' | 'ask.question' | 'turn.done' | 'session.ended';
export type FeedLine = { kind: FeedEventKind; sessionId: string; title: string; tool: string | null };

/** 急ぎ（許可と質問）のまとめの間。 */
export const FEED_URGENT_MS = 300;
/** 普通（終わり）のまとめの間。 */
export const FEED_NORMAL_MS = 2_000;
/** 預かりの上限。超えたら古い終わりの出来事から捨てる。 */
export const FEED_MAX_ITEMS = 20;
/** 渡せないまま預かっている間の確かめの間隔。 */
export const FEED_POLL_MS = 1_500;
/** 渡したあと、統括のターンが動き出すのを待つ上限。 */
export const FEED_SETTLE_MS = 20_000;
/** 許可待ちの OS とスマホの通知を預かる長さ。 */
export const NOTICE_GRACE_MS = 15_000;
/** 統括の文脈がこれを超えたら、idle の間に /compact を送る。 */
export const COMPACT_TOKENS = 150_000;
/** /compact を送るまでに続いてほしい idle の長さ。 */
export const COMPACT_IDLE_MS = 2 * 60_000;

export type OrchestratorFeedDeps = {
  now?: () => number;
  /** 統括の設定（orchestratorOf で読んだもの）。 */
  orchestrator(): { enabled: boolean; sessionId: string | null };
  /** この PC の実行中の一覧。 */
  live(): LiveSessionDto[];
  /** 実行中の一覧の 1 行を、会話の id と題名へ。引けなければ null。 */
  resolve(l: LiveSessionDto): { id: string; title: string } | null;
  /** その会話に統括が関わっているか（統括が起こした、または統括が直近に送った）。 */
  involved(orchestratorId: string, sessionId: string): boolean;
  /** その会話の終わりを統括へ伝えた（送った印を使い切る）。 */
  reported?(orchestratorId: string, sessionId: string): void;
  /** 統括の入力欄が空か。読めなければ投げるか false（渡さない側）。 */
  inputEmpty(orchestratorId: string): Promise<boolean>;
  /** 統括の入力欄へ送る。貼る直前に入力欄が空であることを確かめ、空でなければ送らずに false を返す。 */
  deliver(orchestratorId: string, text: string): Promise<boolean>;
  /** 出来事の文を組む（i18n の mcp.orchestrator.feedHead と feedLine）。 */
  format(lines: FeedLine[]): string;
  /** 出来事の文を渡した直後（送り込みの印を付ける。orchestrator/turnMark.ts）。 */
  onFed?(orchestratorId: string): void;
  /** 統括の今の文脈の量。分からなければ null。 */
  contextTokens(orchestratorId: string): number | null;
  /** 猶予が明けたのに、その会話がまだ許可を待っている。通知の側が出す。 */
  onGraceEnd?(sessionId: string): void;
  urgentMs?: number;
  normalMs?: number;
  maxItems?: number;
  pollMs?: number;
  settleMs?: number;
  graceMs?: number;
  compactTokens?: number;
  compactIdleMs?: number;
};

type Seen = { status: LiveStatus; waitingFor: WaitKind | null; tool: string | null; title: string };
type Item = { key: string; kind: FeedEventKind; sessionId: string; title: string; tool: string | null; at: number };

/** 題名は 1 行にし、長ければ切る（会話の題名は他人の文を含みうるので、文の形を崩させない）。 */
const TITLE_MAX = 80;
const oneLine = (s: string): string => {
  const t = s.replace(/[\r\n\t]+/g, ' ').replace(/[「」"]/g, '').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
};

/**
 * 出来事の文（docs/design.md「統括」の文の形）。1 行目が見出し、以降が 1 件 1 行。
 * 載せるのは種類、会話の id、題名、許可の道具の名前だけで、命令の全文は載せない（統括は list_pending_asks で引く）。
 */
export function feedText(tr: Translate, lines: FeedLine[]): string {
  const body = lines.map((l) => tr('mcp.orchestrator.feedLine', { kind: l.kind, id: l.sessionId, title: oneLine(l.title), tool: l.tool ? oneLine(l.tool) : '' }).trimEnd());
  return [tr('mcp.orchestrator.feedHead', { n: lines.length }), ...body].join('\n');
}

const isAsk = (k: FeedEventKind): boolean => k === 'ask.permission' || k === 'ask.question';
const askKind = (w: WaitKind | null): FeedEventKind | null => (w === 'permission' ? 'ask.permission' : w === 'question' ? 'ask.question' : null);

export class OrchestratorFeed {
  private prev: Map<string, Seen> | null = null;
  private prevSelf: string | null = null;
  private seen = new Map<string, Seen>();
  private selfStatus: LiveStatus | 'stopped' = 'stopped';
  private items: Item[] = [];
  private dueAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private delivering = false;
  private settle: { at: number; sawNonIdle: boolean } | null = null;
  private grace = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
  private idleSince: number | null = null;
  private compactTimer: ReturnType<typeof setTimeout> | null = null;
  private compacted = false;
  private stopped = false;

  constructor(private readonly deps: OrchestratorFeedDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** 実行中の一覧が変わった。出来事を拾い、渡せるか確かめる。 */
  onLiveChange(): void {
    if (this.stopped) return;
    this.observe();
    this.kick();
    this.checkCompact();
  }

  /**
   * その会話の許可待ちの通知を、いま預かっているか。
   * 呼ぶたびに実行中の一覧を見直すので、通知の見張りと出来事の見張りのどちらが先に変化を見ても、同じ答えになる。
   */
  held(sessionId: string): boolean {
    if (this.stopped) return false;
    this.observe();
    const g = this.grace.get(sessionId);
    return g !== undefined && this.now() < g.until;
  }

  /** いま預かっている出来事の写し（試験と確かめのため）。 */
  pending(): FeedLine[] {
    return this.items.map(({ kind, sessionId, title, tool }) => ({ kind, sessionId, title, tool }));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    if (this.compactTimer) clearTimeout(this.compactTimer);
    for (const g of this.grace.values()) clearTimeout(g.timer);
    this.grace.clear();
    this.items = [];
    this.timer = this.poll = this.compactTimer = null;
  }

  private self(): string | null {
    const o = this.deps.orchestrator();
    return o.enabled ? o.sessionId : null;
  }

  /** 今の一覧を読み、前と比べて出来事と猶予を作る。 */
  private observe(): void {
    const o = this.deps.orchestrator();
    const self = this.self();
    const now = this.now();
    const seen = new Map<string, Seen>();
    let selfStatus: LiveStatus | 'stopped' = 'stopped';
    for (const l of this.deps.live()) {
      let r: { id: string; title: string } | null = null;
      try { r = this.deps.resolve(l); } catch { r = null; }
      if (!r) continue;
      // 統括自身の会話は、有効でなくても出来事にしない。
      if (r.id === o.sessionId) { selfStatus = l.status; continue; }
      seen.set(r.id, { status: l.status, waitingFor: l.status === 'waiting' ? l.waitingFor ?? null : null, tool: l.permission?.tool ?? null, title: r.title });
    }
    this.seen = seen;
    this.selfStatus = selfStatus;
    if (selfStatus !== 'idle') this.idleSince = null;
    else this.idleSince ??= now;
    if (this.settle && selfStatus !== 'idle') this.settle.sawNonIdle = true;

    // 待ちが消えた会話の猶予を外す。
    for (const [id, g] of this.grace) {
      const s = seen.get(id);
      if (!s || s.waitingFor !== 'permission') { clearTimeout(g.timer); this.grace.delete(id); }
    }

    const prev = this.prev;
    const prevSelf = this.prevSelf;
    this.prev = seen;
    this.prevSelf = self;
    // 最初の観測と、統括が替わった（有効になった、別の会話になった）直後は、覚えるだけにする。
    if (self === null) { this.items = []; return; }
    if (prev === null || prevSelf !== self) return;

    for (const [id, cur] of seen) {
      const p = prev.get(id);
      const kind = askKind(cur.waitingFor);
      if (kind && !(p && p.waitingFor === cur.waitingFor)) {
        this.add({ key: `ask:${id}`, kind, sessionId: id, title: cur.title, tool: kind === 'ask.permission' ? cur.tool : null, at: now });
        if (kind === 'ask.permission' && selfStatus === 'idle') this.startGrace(id, now);
      }
      if (p?.status === 'busy' && cur.status === 'idle' && this.involved(self, id)) {
        this.add({ key: `done:${id}`, kind: 'turn.done', sessionId: id, title: cur.title, tool: null, at: now });
      }
    }
    for (const [id, p] of prev) {
      if (seen.has(id) || !this.involved(self, id)) continue;
      this.add({ key: `ended:${id}`, kind: 'session.ended', sessionId: id, title: p.title, tool: null, at: now });
    }
  }

  private involved(self: string, id: string): boolean {
    try { return this.deps.involved(self, id); } catch { return false; }
  }

  private startGrace(id: string, now: number): void {
    if (this.grace.has(id)) return;
    const ms = this.deps.graceMs ?? NOTICE_GRACE_MS;
    const timer = setTimeout(() => {
      if (this.stopped) return;
      // 猶予が明けた。まだ待っていれば、通知の側に出させる。
      this.observe();
      const still = this.grace.has(id);
      this.grace.delete(id);
      if (still) {
        try { this.deps.onGraceEnd?.(id); } catch (e) { console.error('[orchestrator] grace end failed', e instanceof Error ? e.message : e); }
      }
    }, ms);
    timer.unref?.();
    this.grace.set(id, { until: now + ms, timer });
  }

  private add(item: Item): void {
    const i = this.items.findIndex((x) => x.key === item.key);
    if (i >= 0) this.items[i] = { ...this.items[i]!, title: item.title, tool: item.tool ?? this.items[i]!.tool };
    else this.items.push(item);
    const max = this.deps.maxItems ?? FEED_MAX_ITEMS;
    while (this.items.length > max) {
      const drop = this.items.findIndex((x) => !isAsk(x.kind));
      if (drop < 0) break;
      this.items.splice(drop, 1);
    }
    this.schedule(isAsk(item.kind) ? this.deps.urgentMs ?? FEED_URGENT_MS : this.deps.normalMs ?? FEED_NORMAL_MS);
  }

  private schedule(delay: number): void {
    const at = this.now() + delay;
    if (this.dueAt !== null && this.dueAt <= at) return;
    this.dueAt = at;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.kick(); }, delay);
    this.timer.unref?.();
  }

  /** 期日が来ていれば渡しに行く。渡せないまま預かりがあれば、短い周期で確かめ続ける。 */
  private kick(): void {
    if (this.stopped) return;
    if (this.items.length === 0) { this.dueAt = null; this.stopPoll(); return; }
    if (this.dueAt !== null && this.now() < this.dueAt) return;
    if (!this.poll) {
      this.poll = setInterval(() => { this.observe(); this.kick(); }, this.deps.pollMs ?? FEED_POLL_MS);
      this.poll.unref?.();
    }
    void this.tryDeliver().catch((e: unknown) => { console.error('[orchestrator] feed failed', e instanceof Error ? e.message : e); });
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** 渡す前に、解けた待ちを捨てる。 */
  private prune(): void {
    this.items = this.items.filter((x) => {
      if (!isAsk(x.kind)) return true;
      const s = this.seen.get(x.sessionId);
      return s !== undefined && askKind(s.waitingFor) === x.kind;
    });
  }

  private async tryDeliver(): Promise<void> {
    if (this.delivering) return;
    const self = this.self();
    if (self === null) { this.items = []; return; }
    if (this.settle && (this.settle.sawNonIdle || this.now() - this.settle.at >= (this.deps.settleMs ?? FEED_SETTLE_MS))) this.settle = null;
    if (this.selfStatus !== 'idle' || this.settle) return;
    this.delivering = true;
    try {
      let empty = false;
      try { empty = (await this.deps.inputEmpty(self)) === true; } catch { empty = false; }
      if (!empty || this.stopped) return;
      // 読んでいる間に変わったかもしれない。一覧を読み直し、解けた待ちを捨ててから組む。
      this.observe();
      this.prune();
      if (this.items.length === 0 || this.selfStatus !== 'idle' || this.self() !== self) return;
      const batch = this.items.slice();
      // 許可の道具は、hook が後から届けることがあるので、渡す時点の一覧から取り直す。
      const lines: FeedLine[] = batch.map((x) => ({ kind: x.kind, sessionId: x.sessionId, title: x.title, tool: x.kind === 'ask.permission' ? this.seen.get(x.sessionId)?.tool ?? x.tool : null }));
      let ok = false;
      try { ok = (await this.deps.deliver(self, this.deps.format(lines))) === true; } catch { ok = false; }
      if (!ok || this.stopped) return;
      this.items = this.items.filter((x) => !batch.includes(x));
      this.settle = { at: this.now(), sawNonIdle: false };
      try { this.deps.onFed?.(self); } catch (e) { console.error('[orchestrator] could not mark the fed turn', e instanceof Error ? e.message : e); }
      for (const x of batch) if (!isAsk(x.kind)) { try { this.deps.reported?.(self, x.sessionId); } catch { /* 印の片付けの失敗で渡しを止めない */ } }
    } finally {
      this.delivering = false;
      if (this.items.length === 0) { this.dueAt = null; this.stopPoll(); }
    }
  }

  /** 文脈が太っていて、idle が続き、預かりが空なら /compact を 1 回送る。続きの判定は時計で見る。 */
  private checkCompact(): void {
    if (this.stopped) return;
    const self = this.self();
    if (self === null) return;
    // 文脈の量は idle の間だけ読む（一覧の変化のたびに読まない）。
    if (this.selfStatus !== 'idle') return;
    const limit = this.deps.compactTokens ?? COMPACT_TOKENS;
    let tokens: number | null = null;
    try { tokens = this.deps.contextTokens(self); } catch { tokens = null; }
    if (tokens === null) return;
    if (tokens <= limit) { this.compacted = false; return; }
    if (this.compacted || this.selfStatus !== 'idle' || this.idleSince === null) return;
    const wait = (this.deps.compactIdleMs ?? COMPACT_IDLE_MS) - (this.now() - this.idleSince);
    if (wait > 0) {
      if (this.compactTimer) clearTimeout(this.compactTimer);
      this.compactTimer = setTimeout(() => { this.compactTimer = null; this.observe(); this.checkCompact(); }, wait);
      this.compactTimer.unref?.();
      return;
    }
    if (this.items.length > 0 || this.delivering) return;
    this.compacted = true;
    this.delivering = true;
    void (async () => {
      try {
        let empty = false;
        try { empty = (await this.deps.inputEmpty(self)) === true; } catch { empty = false; }
        const ok = empty && (await this.deps.deliver(self, '/compact').catch(() => false)) === true;
        // 送れなかったら、次の idle でやり直す。
        if (!ok) this.compacted = false;
      } finally {
        this.delivering = false;
      }
    })();
  }
}
