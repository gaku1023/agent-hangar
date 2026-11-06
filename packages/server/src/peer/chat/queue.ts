import type { PeerBlobRef, PeerChatDevice, PeerChatQueued } from '@agent-hangar/shared';

/**
 * ほかの PC から来た文の預かり（U4、U11）。
 *
 * 作業中の会話に送られた文は、ターンが止まり、この PC の入力欄が空になるまで預かる。
 * 入力欄に打ちかけがあれば渡さない（人が打っている最中に、ほかの PC の文が混ざらないように）。
 * ターンが止まってから 10 分たっても渡せなければ、預かりを捨てて送り主に知らせる（queue-expired）。
 * 預かりはメモリだけに持ち、再起動では残さない。
 *
 * 外のものは全部、口から入れる。
 * turnState は会話のターンの状態、inputEmpty は入力欄が空か、deliver は入力欄へ送ってよいか確かめたうえで送る処理である。
 *
 * 渡すか捨てるかの確認は、預かりのある間だけ回る時計（pollMs ごと）と、notifyTurnChanged（ターンの状態が変わった知らせ）で行う。
 * 時計は預かりが空になれば止まる。
 *
 * 10 分の数え方。
 * 数えるのは、ターンが止まっている（idle か stopped）間だけで、作業中（busy）と札が出ている間（waiting）は数えない。
 * 途中でターンがまた始まれば、数え直す。
 * 預かった時刻ではなく、止まった時刻から数える。作業が 30 分続いたあとに止まっても、そこから 10 分待つ。
 * 止まっている会話へ、打ちかけのまま来た文は、預かった時刻から数える（止まって何時間もたつ会話で、すぐ捨てないため）。
 *
 * 1 度に 1 件だけ渡す。
 * 渡した直後は、ターンの状態の更新が遅れて、まだ idle に見えることがある。
 * そこで、渡したあとは、ターンが動き出す（idle でなくなる）のを一度見るか、settleMs がたつまで、次を渡さない。
 */

/** 止まってから渡せないままの預かりを捨てるまでの長さ（U11）。 */
export const PEER_QUEUE_EXPIRE_MS = 10 * 60_000;
/** 預かりがある間の確認の間隔。 */
export const PEER_QUEUE_POLL_MS = 1500;
/** 1 つの会話に預かれる件数の上限。超えた add は null を返す（T5b は rate で断る）。 */
export const PEER_QUEUE_MAX_PER_RUN = 20;
/** 渡したあと、ターンが動き出すのを待つ長さ。動き出さない指示（スラッシュコマンドなど）のあとに、次を渡せなくならないための上限。 */
export const PEER_QUEUE_SETTLE_MS = 20_000;

/** 会話のターンの状態。PeerChatState.status と同じ語。 */
export type TurnState = 'busy' | 'idle' | 'waiting' | 'stopped';

export type PeerQueueDeps = {
  now(): number;
  /** runId の会話のいまの状態。idle のときだけ渡す。waiting は許可か質問の札が出ている。stopped は Claude が動いていない。 */
  turnState(runId: string): TurnState;
  /** この PC の入力欄が空か。読めなかったら投げるか false を返す（渡さない側に倒れる）。 */
  inputEmpty(runId: string): Promise<boolean>;
  /**
   * 入力欄へ送る。送れたら true。偽や投げたときは預かりに戻し、次の確認で試す。
   * 呼ばれる直前に、キューは inputEmpty を読み直し、打ちかけがあれば呼ばない。
   * それでも、読んでから貼り付けるまでの間に人が打ち始める余地は残る。
   * だから実装は、貼り付ける直前にもう一度、入力欄が空であることを確かめ、空でなければ送らずに false を返す。
   */
  deliver(runId: string, text: string, images: PeerBlobRef[], queueId: string): Promise<boolean>;
  /** 預かりの ID を作る。 */
  newId(): string;
  pollMs?: number;
  expireMs?: number;
  settleMs?: number;
};

/**
 * 預かりの変化。T5b が送り主への返事に、T8 が画面の帯と「{device} から送信しました」の札に使う。
 * item は、そのときの写し（text を含む）。
 * - queued：預かった。
 * - delivering：入力欄へ送り始めた。
 * - delivered：送れて、預かりから消えた。from は送り主。
 * - expired：渡せないまま捨てた。reason は常に queue-expired。送り主へ返し、文は送り主の入力欄に戻す。
 * - cancelled：送り主が取り消した。
 * - dropped：会話が消えたなどで、dropRun が消した。T5b は送り主へ session-unknown を返し、文は送り主の入力欄に戻す。
 */
export type PeerQueueEvent =
  | { type: 'queued'; runId: string; item: PeerChatQueued }
  | { type: 'delivering'; runId: string; item: PeerChatQueued }
  | { type: 'delivered'; runId: string; item: PeerChatQueued; from: PeerChatDevice }
  | { type: 'expired'; runId: string; item: PeerChatQueued; reason: 'queue-expired' }
  | { type: 'cancelled'; runId: string; item: PeerChatQueued }
  | { type: 'dropped'; runId: string; item: PeerChatQueued };

export type PeerQueueCancel = { ok: true; text: string } | { ok: false; reason: 'not-found' | 'not-sender' | 'delivering' };

type Item = { queueId: string; from: PeerChatDevice; text: string; images: PeerBlobRef[]; at: number; state: 'waiting' | 'delivering' };
type RunState = {
  items: Item[];
  /** 止まって（idle か stopped）から続けて確かめた最初の時刻。ターンが動けば null。 */
  idleSince: number | null;
  /** 渡した直後の見張り。ターンが動くのを見るまでは次を渡さない。 */
  settle: { at: number; sawNonIdle: boolean } | null;
  /** 確認の最中。重ならないようにする。 */
  ticking: boolean;
};

const snap = (i: Item): PeerChatQueued => ({ queueId: i.queueId, from: i.from, text: i.text, images: i.images.length, at: i.at, state: i.state });

export class PeerQueue {
  private readonly runs = new Map<string, RunState>();
  private readonly listeners = new Set<(e: PeerQueueEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly deps: PeerQueueDeps) {}

  /** 変化の知らせを受ける。戻り値で外す。受ける側が投げても、預かりは壊れない。 */
  subscribe(fn: (e: PeerQueueEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * 文を預かる。ID を返す。すぐに渡せるか確かめる。
   * 預かれなかったら null を返す。dispose のあと、または、その会話の預かりが PEER_QUEUE_MAX_PER_RUN 件に達しているとき。
   */
  add(runId: string, from: PeerChatDevice, text: string, images: PeerBlobRef[]): string | null {
    if (this.disposed) return null;
    let rs = this.runs.get(runId);
    if (rs && rs.items.length >= PEER_QUEUE_MAX_PER_RUN) return null;
    const item: Item = { queueId: this.deps.newId(), from, text, images, at: this.now(), state: 'waiting' };
    if (!rs) this.runs.set(runId, (rs = { items: [], idleSince: null, settle: null, ticking: false }));
    rs.items.push(item);
    this.emit({ type: 'queued', runId, item: snap(item) });
    this.startTimer();
    this.kick(runId);
    return item.queueId;
  }

  /**
   * 会話が消えたなどで、その会話の預かりを全部消す。消した件数を返す。
   * 1 件ごとに dropped を出す（送り主へ早く返すため）。渡している最中の 1 件には触らない。
   */
  dropRun(runId: string): number {
    const rs = this.runs.get(runId);
    if (!rs) return 0;
    const gone = rs.items.filter((i) => i.state === 'waiting');
    rs.items = rs.items.filter((i) => i.state !== 'waiting');
    for (const item of gone) this.emit({ type: 'dropped', runId, item: snap(item) });
    this.cleanup(runId, rs);
    return gone.length;
  }

  /** runId の預かり（古い順）。PeerChatState.queued に使う。 */
  list(runId: string): PeerChatQueued[] {
    return (this.runs.get(runId)?.items ?? []).map(snap);
  }

  /**
   * 送り主が取り消す。送った PC（deviceId が同じ）だけができる。文を返すので、送り主の入力欄に戻す。
   * 渡している最中（delivering）は取り消せない。渡し終えた預かりは無いので not-found になる。
   */
  cancel(queueId: string, byDeviceId: string): PeerQueueCancel {
    for (const [runId, rs] of this.runs) {
      const i = rs.items.findIndex((x) => x.queueId === queueId);
      if (i < 0) continue;
      const item = rs.items[i]!;
      if (item.from.deviceId !== byDeviceId) return { ok: false, reason: 'not-sender' };
      if (item.state === 'delivering') return { ok: false, reason: 'delivering' };
      rs.items.splice(i, 1);
      this.emit({ type: 'cancelled', runId, item: snap(item) });
      this.cleanup(runId, rs);
      return { ok: true, text: item.text };
    }
    return { ok: false, reason: 'not-found' };
  }

  /** ターンの状態が変わった知らせ（Stop の hook など）。次の確認を待たずに渡せるか確かめる。 */
  notifyTurnChanged(runId: string): void {
    if (this.runs.has(runId)) this.kick(runId);
  }

  /** 時計を止めて、預かりを捨てる。知らせは出さない（終了のときに呼ぶ）。 */
  dispose(): void {
    this.disposed = true;
    this.runs.clear();
    this.stopTimer();
    this.listeners.clear();
  }

  private emit(e: PeerQueueEvent): void {
    for (const fn of [...this.listeners]) {
      try { fn(e); } catch { /* 受ける側の失敗で預かりを止めない */ }
    }
  }

  private startTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => { for (const runId of [...this.runs.keys()]) this.kick(runId); }, this.deps.pollMs ?? PEER_QUEUE_POLL_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 預かりも見張りも無くなった会話を忘れ、会話が 1 つも無ければ時計を止める。 */
  private cleanup(runId: string, rs: RunState): void {
    if (rs.items.length === 0 && !rs.settle && this.runs.get(runId) === rs) this.runs.delete(runId);
    if (this.runs.size === 0) this.stopTimer();
  }

  /** 外の口の失敗は、確認の時計の外へ出さない（呼び手は await しないので、未処理の拒否になってサーバを落としうる）。 */
  private kick(runId: string): void {
    this.tick(runId).catch(() => {});
  }

  /** deps.now が投げたら、システムの時計で代える（渡した直後に投げて、delivering のまま残さないため）。 */
  private now(): number {
    try { return this.deps.now(); } catch { return Date.now(); }
  }

  /** turnState が投げたら stopped とみなす（渡さず、10 分で捨てる側に倒す）。 */
  private turnOf(runId: string): TurnState {
    try { return this.deps.turnState(runId); } catch { return 'stopped'; }
  }

  /** 入力欄が空か。読めなかったら空でないとみなす。 */
  private async emptyOf(runId: string): Promise<boolean> {
    try { return (await this.deps.inputEmpty(runId)) === true; } catch { return false; }
  }

  /** 1 つの会話について、渡せるなら 1 件渡し、10 分たったものを捨てる。 */
  private async tick(runId: string): Promise<void> {
    const rs = this.runs.get(runId);
    if (!rs || rs.ticking || this.disposed) return;
    rs.ticking = true;
    try {
      const { deps } = this;
      const turn = this.turnOf(runId);
      const t0 = this.now();
      if (turn === 'idle' || turn === 'stopped') rs.idleSince ??= t0;
      else rs.idleSince = null;
      if (turn !== 'idle' && rs.settle) rs.settle.sawNonIdle = true;
      if (rs.settle && (rs.settle.sawNonIdle || t0 - rs.settle.at >= (deps.settleMs ?? PEER_QUEUE_SETTLE_MS))) rs.settle = null;

      const head = rs.items[0];
      if (turn === 'idle' && head && head.state === 'waiting' && !rs.settle) {
        const empty = await this.emptyOf(runId);
        // 読んでいる間に、取り消しや dispose があるかもしれない
        if (this.disposed || this.runs.get(runId) !== rs || rs.items[0] !== head) return;
        if (empty) await this.deliverHead(runId, rs, head);
      }
      if (this.disposed || this.runs.get(runId) !== rs) return;
      this.expire(runId, rs);
    } finally {
      rs.ticking = false;
      if (!this.disposed) this.cleanup(runId, rs);
    }
  }

  /**
   * 先頭の 1 件を渡す。
   * 渡す直前に、入力欄を読み直し、ターンの状態も見直す。最初に読んでから時間がたつと、人が打ち始めているかもしれない。
   * 空でなくなっていたら、渡さずに預かりに残す。
   */
  private async deliverHead(runId: string, rs: RunState, item: Item): Promise<void> {
    const stillEmpty = await this.emptyOf(runId);
    if (this.disposed || this.runs.get(runId) !== rs || rs.items[0] !== item || item.state !== 'waiting') return;
    if (!stillEmpty || this.turnOf(runId) !== 'idle') return;
    item.state = 'delivering';
    this.emit({ type: 'delivering', runId, item: snap(item) });
    let ok = false;
    try { ok = (await this.deps.deliver(runId, item.text, item.images, item.queueId)) === true; } catch { ok = false; }
    if (this.disposed) return;
    if (!ok) {
      item.state = 'waiting';
      return;
    }
    const i = rs.items.indexOf(item);
    if (i >= 0) rs.items.splice(i, 1);
    rs.settle = { at: this.now(), sawNonIdle: false };
    this.emit({ type: 'delivered', runId, item: snap(item), from: item.from });
  }

  /** 止まってから expireMs たっても渡せない預かりを捨てる。数え始めは、止まった時刻と預かった時刻の遅いほう。 */
  private expire(runId: string, rs: RunState): void {
    if (rs.idleSince === null) return;
    const now = this.now();
    const limit = this.deps.expireMs ?? PEER_QUEUE_EXPIRE_MS;
    for (const item of [...rs.items]) {
      if (item.state !== 'waiting' || now - Math.max(rs.idleSince, item.at) < limit) continue;
      rs.items.splice(rs.items.indexOf(item), 1);
      this.emit({ type: 'expired', runId, item: snap(item), reason: 'queue-expired' });
    }
  }
}
