import { randomUUID } from 'node:crypto';
import { isLaunchPrepKey, type LaunchPrepAction, type LaunchPrepAsk, type LaunchPrepDto, type LaunchPrepStepDto, type LaunchPrepStepKind } from '@agent-hangar/shared';

/**
 * 起動前の準備の進み（docs/design.md「起動前の準備」）。
 * 起動 1 回に 1 つの LaunchPrep を作り、段（LM Studio のモデルを載せる、接続先の準備のコマンドを走らせる）が動くたびに、鍵ごとの全体を launch.prep で配る。
 * 段の無い準備（Claude、ローカルのモデルを使わない会話）は何も配らない。
 * 利用者に聞くことができたら ask で止める（LaunchPrepAsked を投げる）。起動の口はそれを 409 にし、画面は答えを添えて送り直す。
 * 利用者がやめたら（cancel）signal を切る。段は throwIfCancelled か signal で止まる。
 */

/** 理由として見せる長さの上限。コマンドの出力の最後の行に秘密が出ても、長く見せないためである。 */
const REASON_MAX = 300;
const clip = (s: string): string => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s);

/** 準備で利用者に聞くことができた。起動の口が 409 にする。 */
export class LaunchPrepAsked extends Error {
  constructor(readonly ask: LaunchPrepAsk) {
    super(`launch preparation needs an answer (${ask.kind})`);
    this.name = 'LaunchPrepAsked';
  }
}

/** 利用者が準備をやめた。 */
export class LaunchPrepCancelled extends Error {
  constructor() {
    super('launch preparation was cancelled');
    this.name = 'LaunchPrepCancelled';
  }
}

export type LaunchPrepsDeps = {
  broadcast(ev: { type: 'launch.prep'; prep: LaunchPrepDto }): void;
  now?: () => number;
};

/** 段 1 つ。進みを書き換え、終わり方（done、skip、fail）を 1 つ選ぶ。 */
export type LaunchPrepStep = {
  update(patch: Partial<Pick<LaunchPrepStepDto, 'action' | 'fromContext' | 'toContext'>>): void;
  done(): void;
  skip(): void;
  fail(reason: string): void;
};

export class LaunchPrep {
  private readonly abort = new AbortController();
  private readonly dto: LaunchPrepDto;

  constructor(readonly key: string, private readonly deps: Required<LaunchPrepsDeps>, private readonly onEnd: () => void, sessionId?: string) {
    this.dto = { key, phase: 'running', startedAt: deps.now(), endedAt: null, steps: [], ask: null, reason: null, ...(sessionId ? { sessionId } : {}) };
  }

  get signal(): AbortSignal { return this.abort.signal; }
  get phase(): LaunchPrepDto['phase'] { return this.dto.phase; }

  /** 段を始める。 */
  step(kind: LaunchPrepStepKind, target: string, action: LaunchPrepAction): LaunchPrepStep {
    const s: LaunchPrepStepDto = { id: String(this.dto.steps.length + 1), kind, target, action, state: 'running', fromContext: null, toContext: null, startedAt: this.deps.now(), endedAt: null, reason: null };
    this.dto.steps.push(s);
    this.emit();
    const end = (state: LaunchPrepStepDto['state'], reason: string | null = null) => {
      if (s.state !== 'running') return;
      Object.assign(s, { state, endedAt: this.deps.now(), reason: reason === null ? null : clip(reason) });
      this.emit();
    };
    return {
      update: (patch) => { Object.assign(s, patch); this.emit(); },
      done: () => end('done'),
      skip: () => end('skipped'),
      fail: (reason) => end('failed', reason),
    };
  }

  /** やめていたら LaunchPrepCancelled を投げる。 */
  throwIfCancelled(): void {
    if (this.abort.signal.aborted) throw new LaunchPrepCancelled();
  }

  /** 利用者に聞く。進みを asking で配り、LaunchPrepAsked を投げる。 */
  ask(a: LaunchPrepAsk): never {
    this.end('asking', { ask: a });
    throw new LaunchPrepAsked(a);
  }

  /** 準備を済ませた。段が 1 つも無ければ何も配らない。 */
  finish(): void {
    this.end('ready');
  }

  fail(reason: string): void {
    this.end('failed', { reason: clip(reason) });
  }

  /** 利用者がやめた。 */
  cancel(): void {
    if (this.dto.phase !== 'running') return;
    this.abort.abort();
    this.end('cancelled');
  }

  private end(phase: LaunchPrepDto['phase'], extra: Partial<LaunchPrepDto> = {}): void {
    if (this.dto.phase !== 'running') return;
    Object.assign(this.dto, { phase, endedAt: this.deps.now(), ...extra });
    // 段の無い ready は配らない。問い、失敗、やめたことは、段が無くても配る（画面が待っている）。
    if (phase !== 'ready' || this.dto.steps.length) this.emit();
    this.onEnd();
  }

  private emit(): void {
    this.deps.broadcast({ type: 'launch.prep', prep: structuredClone(this.dto) });
  }
}

/** 走っている準備を鍵で持つ。終わったものは持たない。 */
export class LaunchPreps {
  private readonly running = new Map<string, LaunchPrep>();
  private readonly deps: Required<LaunchPrepsDeps>;

  constructor(deps: LaunchPrepsDeps) {
    this.deps = { now: Date.now, ...deps };
  }

  /** 準備を始める。鍵が無いか形が違えば、hangar が鍵を作る（進みは配るが、受け取る画面は無い）。sessionId は準備している会話で、進みに載せる。 */
  begin(key: string | undefined, sessionId?: string): LaunchPrep {
    const k = isLaunchPrepKey(key) && !this.running.has(key) ? key : randomUUID().replaceAll('-', '');
    const p = new LaunchPrep(k, this.deps, () => { if (this.running.get(k) === p) this.running.delete(k); }, sessionId);
    this.running.set(k, p);
    return p;
  }

  /** 走っている準備をやめる。無ければ false。 */
  cancel(key: string): boolean {
    const p = this.running.get(key);
    if (!p) return false;
    p.cancel();
    return true;
  }

  /** その鍵の準備が走っているか。 */
  has(key: string): boolean {
    return this.running.has(key);
  }
}
