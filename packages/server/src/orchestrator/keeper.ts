import type { OrchestratorSetting, RunDto } from '@agent-hangar/shared';

/**
 * 統括の見張りの状態。画面の統括の柱が読む。
 * stopped は見張りが自動では起こさない状態で、failures は失敗が続いたため、user は利用者が止めた（か、休みの印で止まった）ため。
 */
export type KeeperState = { status: 'off' } | { status: 'running' } | { status: 'stopped'; reason: 'failures' | 'user' };

/** 見張りが RunManager に頼む口。 */
export type KeeperRuns = {
  on(l: { runEnded?(run: RunDto): void }): () => void;
  aliveRun(sessionId: string): RunDto | null;
  /** 画面の停止と同じ止め方（RunManager.kill）。 */
  kill(runId: string): unknown;
  resumeWith(sessionId: string): Promise<unknown>;
  startOrchestrator(): { sessionId: string };
};

export type KeeperDeps = {
  settings: () => OrchestratorSetting;
  /** 見張りが書く設定の項目（sessionId と、利用者が止めたときの enabled）。保存と配信は呼び手が持つ。 */
  save: (patch: Partial<OrchestratorSetting>) => void;
  runs: KeeperRuns;
  /** その会話を再開できるか（行が消えていない、本文がある）。偽なら新しく起こす。 */
  resumable: (sessionId: string) => boolean;
  now?: () => number;
};

/** 失敗を数える窓と、止まる回数。 */
export const KEEPER_WINDOW_MS = 10 * 60_000;
export const KEEPER_MAX_FAILURES = 3;

/**
 * 統括の会話を生かし続ける（docs/design.md「統括」）。
 * enabled の PC で、起動時と run が消えたときに、設定の sessionId の会話を再開する。sessionId が無い、または会話が消えているときは、新しく起こして設定に書く。
 * 10 分に 3 回失敗したら止まり、自動では再試行しない（設定を入れ直すと、また始める）。
 * 利用者が止めたとき（killed）は起こし直さず、enabled を false にする。設定で切にしたときは、動いている run を止める（sessionId は残し、入れ直せば再開する）。
 */
export class OrchestratorKeeper {
  private off: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failures: number[] = [];
  private halted = false;
  private wasEnabled = false;
  private current: KeeperState = { status: 'off' };
  private readonly listeners = new Set<(s: KeeperState) => void>();

  constructor(private readonly deps: KeeperDeps) {}

  /** run の終わりを見張り始め、有効なら起こす。 */
  start(): void {
    this.off ??= this.deps.runs.on({ runEnded: (run) => { this.onRunEnded(run); } });
    this.apply();
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  state(): KeeperState { return this.current; }

  /** 状態が変わるたびに呼ぶ。外すには返り値を呼ぶ。 */
  onState(cb: (s: KeeperState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** 設定が変わった（入り切り、モデル、effort）。切になれば止まる状態を忘れ、入れ直したときだけ失敗の数を捨てて始める。 */
  apply(): void {
    if (!this.deps.settings().enabled) {
      this.wasEnabled = false;
      this.halted = false;
      this.failures = [];
      this.set({ status: 'off' });
      this.stopAlive();
      return;
    }
    if (!this.wasEnabled) {
      this.wasEnabled = true;
      this.halted = false;
      this.failures = [];
    }
    this.schedule();
  }

  /** 切にしたとき、動いている統括の run を止める。設定はもう切なので、終わりの知らせでは起こし直さず、sessionId も残る。 */
  private stopAlive(): void {
    const id = this.deps.settings().sessionId;
    const run = id === null ? null : this.deps.runs.aliveRun(id);
    if (!run) return;
    try { this.deps.runs.kill(run.id); } catch (e) { console.error('[orchestrator] could not stop', e instanceof Error ? e.message : e); }
  }

  private set(s: KeeperState): void {
    const same = this.current.status === s.status && (this.current.status !== 'stopped' || (s.status === 'stopped' && s.reason === this.current.reason));
    if (same) return;
    this.current = s;
    for (const cb of this.listeners) cb(s);
  }

  private schedule(): void {
    this.chain = this.chain.then(() => this.ensure()).catch((e: unknown) => { console.error('[orchestrator] keeper failed', e instanceof Error ? e.message : e); });
  }

  private onRunEnded(run: RunDto): void {
    const s = this.deps.settings();
    if (!s.enabled || s.sessionId === null || run.sessionId !== s.sessionId) return;
    if (run.endReason === 'killed') {
      // 利用者が止めた。起こし直さず、入り切りも切にする。
      this.deps.save({ enabled: false });
      this.wasEnabled = false;
      this.set({ status: 'off' });
      return;
    }
    if (run.endReason === 'taken_over' || run.endReason === 'parked') {
      this.halted = true;
      this.set({ status: 'stopped', reason: 'user' });
      return;
    }
    if (this.fail()) return;
    this.schedule();
  }

  /** 失敗を 1 回数える。止まる回数に届いたら止めて真を返す。 */
  private fail(): boolean {
    const now = (this.deps.now ?? Date.now)();
    this.failures = [...this.failures.filter((t) => now - t < KEEPER_WINDOW_MS), now];
    if (this.failures.length < KEEPER_MAX_FAILURES) return false;
    this.halted = true;
    this.set({ status: 'stopped', reason: 'failures' });
    return true;
  }

  private async ensure(): Promise<void> {
    for (;;) {
      const s = this.deps.settings();
      if (!s.enabled || this.halted) return;
      if (s.sessionId !== null && this.deps.runs.aliveRun(s.sessionId)) {
        this.set({ status: 'running' });
        return;
      }
      try {
        if (s.sessionId !== null && this.deps.resumable(s.sessionId)) {
          await this.deps.runs.resumeWith(s.sessionId);
        } else {
          const r = this.deps.runs.startOrchestrator();
          this.deps.save({ sessionId: r.sessionId });
        }
        this.set({ status: 'running' });
        return;
      } catch (e) {
        console.error('[orchestrator] could not start', e instanceof Error ? e.message : e);
        if (this.fail()) return;
      }
    }
  }
}
