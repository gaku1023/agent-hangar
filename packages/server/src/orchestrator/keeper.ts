import { pushOrchestratorHistory, type AgentKind, type LiveStatus, type OrchestratorSetting, type OrchestratorSwitchReason, type RunDto } from '@agent-hangar/shared';

/**
 * 統括の見張りの状態。画面の統括の柱が読む。
 * stopped は見張りが自動では起こさない状態で、failures は失敗が続いたため、user は利用者が止めた（か、休みの印で止まった）ため。
 * switching は新しい会話へ切り替えている間だけ真で付き、contextTokens は統括の会話の文脈の量が分かるときだけ付く。
 */
export type KeeperStatus = { status: 'off' } | { status: 'running' } | { status: 'stopped'; reason: 'failures' | 'user' };
export type KeeperState = KeeperStatus & { switching?: true; contextTokens?: number };

/** 利用者や見張りが新しい会話へ切り替える理由（gone は見張りが自分で書くので、ここでは受けない）。 */
export type FreshReason = Exclude<OrchestratorSwitchReason, 'gone'>;

/** 切り替えの待ちの上限（docs/design.md「統括」の切り替えの手順）。 */
export const SWITCH_QUIET_MS = 30_000;
export const SWITCH_MEMO_MS = 90_000;
/** 新しい統括が入力を受けられるようになるまで待つ上限。越えたら引き継ぎを諦める。 */
export const SWITCH_READY_MS = 120_000;
const SWITCH_POLL_MS = 1_000;

/** 見張りが RunManager に頼む口。 */
export type KeeperRuns = {
  on(l: { runEnded?(run: RunDto): void }): () => void;
  aliveRun(sessionId: string): RunDto | null;
  /** 画面の停止と同じ止め方（RunManager.kill）。 */
  kill(runId: string): unknown;
  /** account は設定のアカウント。渡せば、前に使ったアカウントより優先する。 */
  /** stray: 'stop' は、止めたばかりの claude が残っていれば止めてから再開する（manager.resumeWith と同じ）。 */
  resumeWith(sessionId: string, o?: { account?: string; stray?: 'stop' }): Promise<unknown>;
  /** agent は設定のアプリ。Claude Code は同期で、Codex は下ごしらえを待つ Promise で返る。 */
  startOrchestrator(o?: { account?: string; agent?: AgentKind }): { sessionId: string } | Promise<{ sessionId: string }>;
  /** その run を起こしたときの役の文の版（runs.launch_params の roleHash）。記録が無ければ null。渡さなければ版を見ない。 */
  roleHash?(runId: string): string | null;
};

export type KeeperDeps = {
  settings: () => OrchestratorSetting;
  /** 今の役の文の版（文のハッシュ）。動いている統括の版と違えば、手すきのときに同じ会話を再開し直す。渡さなければ版を見ない。 */
  role?: () => string;
  /** 見張りが書く設定の項目（sessionId と、利用者が止めたときの enabled）。保存と配信は呼び手が持つ。 */
  save: (patch: Partial<OrchestratorSetting>) => void;
  runs: KeeperRuns;
  /** その会話を再開できるか（行が消えていない、本文がある）。偽なら新しく起こす。 */
  resumable: (sessionId: string) => boolean;
  /** その会話を動かしているアプリ（sessions.provider）。分からなければ null で、アプリは変わっていないとみなす。 */
  providerOf?: (sessionId: string) => AgentKind | null;
  /** 統括の会話のいまの様子（実行中の一覧の status）。動いていなければ null。 */
  liveStatus: (sessionId: string) => LiveStatus | null;
  /** 実行中の一覧が変わるたびに呼ぶ。外すには返り値を呼ぶ。 */
  onLiveChange: (cb: () => void) => () => void;
  now?: () => number;
  /** 統括が切り替えの段取りに入れるか（idle で、入力欄が空で、出来事と許可の預かりが空）。 */
  quiet?: (sessionId: string) => Promise<boolean>;
  /** `[hangar]` の文を統括の会話へ渡す。入力欄が空でないなどで渡せなければ偽。 */
  send?: (sessionId: string, text: string) => Promise<boolean>;
  /** 新しい統括の最初の入力にする引き継ぎを組む（orchestrator/handoff.ts）。 */
  handoff?: (o: { previousId: string; memo: string | null }) => string;
  /** 古い統括へ申し送りを頼む文。 */
  memoRequest?: () => string;
  /** その会話を始めた時刻。分からなければ null。 */
  startedAt?: (sessionId: string) => number | null;
  /** 統括の会話の文脈の量。分からなければ null。 */
  contextTokens?: (sessionId: string) => number | null;
  /** 切り替えの待ちの上限（試験で差し替える）。 */
  waits?: { quietMs?: number; memoMs?: number; readyMs?: number; pollMs?: number };
  sleep?: (ms: number) => Promise<void>;
};

export type ActionResult = { ok: true } | { ok: false; error: 'off' | 'switching' };

/** 統括を起こすときの指定。これが変わったら、起こし直して当てる。 */
type Spec = { agent: AgentKind; account: string | null; model: string; effort: string };
const specOf = (s: OrchestratorSetting): Spec => ({ agent: s.agent, account: s.account, model: s.model, effort: s.effort });
const sameSpec = (a: Spec, b: Spec): boolean => a.agent === b.agent && a.account === b.account && a.model === b.model && a.effort === b.effort;

/** 引き継いだ run の指定は分からない。どの設定とも一致しない印にして、変更を当てる。 */
const UNKNOWN_SPEC: Spec = { agent: 'claude-code', account: null, model: '\0', effort: '\0' };

/** 失敗を数える窓と、止まる回数。 */
export const KEEPER_WINDOW_MS = 10 * 60_000;
export const KEEPER_MAX_FAILURES = 3;
/** 指定の変更で止めた claude が一覧から消えるのを待つ長さ。過ぎたら再開を試みる。 */
export const RESPEC_GONE_MS = 15_000;

/**
 * 統括の会話を生かし続ける（docs/design.md「統括」）。
 * enabled の PC で、起動時と run が消えたときに、設定の sessionId の会話を再開する。sessionId が無い、または会話が消えているときは、新しく起こして設定に書く。
 * 10 分に 3 回失敗したら止まり、自動では再試行しない（設定を入れ直すと、また始める）。
 * 指定（アカウント、モデル、effort）が変わったときは、統括が動いていれば、入力待ち（idle）になったときに止めて同じ会話を再開する（作業中は待つ）。この止め方は利用者の停止でも失敗でもない。
 * 役の文が変わったとき（アプリの入れ替え、口調の変更）も、手すきになったときに止めて同じ会話を再開する。
 * 利用者が止めたとき（killed）は起こし直さず、enabled を false にする。設定で切にしたときは、動いている run を止める（sessionId は残し、入れ直せば再開する）。
 */
export class OrchestratorKeeper {
  private off: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failures: number[] = [];
  private halted = false;
  private wasEnabled = false;
  /** 今の run を起こしたときの指定。見張りが起こしたのでなければ（前の hangar から引き継いだ run など）null で、変わったとは見ない。 */
  private launched: Spec | null = null;
  /** 指定が変わったので、見張り自身が止めた run の id。その終わりは利用者の停止でも失敗でもない。 */
  private readonly respecs = new Set<string>();
  /** 指定が変わって止めた直後の再開か。止めた claude が終わりきる前に再開すると「hangar の外部で実行中」で断られるので、残りを止めてから再開する。 */
  private restarting = false;
  private offLive: (() => void) | null = null;
  private current: KeeperState = { status: 'off' };
  private readonly listeners = new Set<(s: KeeperState) => void>();
  /** 見張りが止めた run（切り替えと、利用者の stop）。その終わりは、利用者の停止でも失敗でもない。 */
  private readonly ownKills = new Set<string>();
  /** 切り替えの最中の印。memoFrom はメモを受ける古い統括の id で、頼んでいなければ null。 */
  private switching: { memoFrom: string | null; memo: string | null } | null = null;
  /** 役の文の版のために再開し直した会話と版（`会話の id\0版`）。起こし直した後も版が合わない（記録できない）ときに繰り返さない。 */
  private readonly roleTried = new Set<string>();
  /** 役の文の版のための手すきの確かめの最中。 */
  private roleChecking = false;

  constructor(private readonly deps: KeeperDeps) {}

  /** run の終わりを見張り始め、有効なら起こす。 */
  start(): void {
    this.off ??= this.deps.runs.on({ runEnded: (run) => { this.onRunEnded(run); } });
    this.offLive ??= this.deps.onLiveChange(() => { this.respec(); });
    this.apply(false);
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.offLive?.();
    this.offLive = null;
  }

  state(): KeeperState {
    const id = this.deps.settings().sessionId;
    let tokens: number | null = null;
    try { tokens = id !== null && this.deps.contextTokens ? this.deps.contextTokens(id) : null; } catch { tokens = null; }
    return { ...this.current, ...(this.switching ? { switching: true as const } : {}), ...(tokens !== null ? { contextTokens: tokens } : {}) };
  }

  /**
   * 統括を新しい会話に切り替える（docs/design.md「統括」の切り替えの手順 1〜5）。
   * 返り値の done は、新しい会話の id（起こせなければ null）で解ける。引き継ぎを渡し終えるまで switching が付く。
   * 止まっている（stopped）ときも始め直せる。切のときと、切り替え中は断る。
   */
  fresh(reason: FreshReason): { ok: true; done: Promise<string | null> } | { ok: false; error: 'off' | 'switching' } {
    if (!this.deps.settings().enabled) return { ok: false, error: 'off' };
    if (this.switching) return { ok: false, error: 'switching' };
    this.switching = { memoFrom: null, memo: null };
    this.emit();
    const done = this.chain.then(() => this.runSwitch(reason)).catch((e: unknown) => {
      console.error('[orchestrator] could not switch', e instanceof Error ? e.message : e);
      return null;
    }).finally(() => {
      this.switching = null;
      this.emit();
      this.schedule();
    });
    this.chain = done.then(() => undefined);
    return { ok: true, done };
  }

  /** 古い統括が write_handoff で書いた申し送り。切り替えの最中で、頼んだ古い統括からのときだけ受ける。 */
  receiveHandoff(sessionId: string, text: string): boolean {
    if (!this.switching || this.switching.memoFrom === null || this.switching.memoFrom !== sessionId || this.switching.memo !== null) return false;
    this.switching.memo = text;
    return true;
  }

  /** 利用者が止める（画面の停止と同じ止め方）。enabled は切らず、見張りは stopped: user にして起こし直さない。 */
  stopByUser(): ActionResult {
    if (!this.deps.settings().enabled) return { ok: false, error: 'off' };
    if (this.switching) return { ok: false, error: 'switching' };
    this.halted = true;
    this.set({ status: 'stopped', reason: 'user' });
    const id = this.deps.settings().sessionId;
    const run = id === null ? null : this.deps.runs.aliveRun(id);
    if (run) {
      this.ownKills.add(run.id);
      try { this.deps.runs.kill(run.id); } catch (e) {
        this.ownKills.delete(run.id);
        console.error('[orchestrator] could not stop', e instanceof Error ? e.message : e);
      }
    }
    return { ok: true };
  }

  /** 止まった状態（利用者の停止、失敗が続いた）を捨てて、統括を起こす。 */
  wake(): ActionResult {
    if (!this.deps.settings().enabled) return { ok: false, error: 'off' };
    if (this.switching) return { ok: false, error: 'switching' };
    this.halted = false;
    this.failures = [];
    this.schedule();
    return { ok: true };
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
  }

  /** cond が真になるか、ms が過ぎるまで待つ。真になれば真を返す。 */
  private async waitFor(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
    const until = this.now() + ms;
    const poll = this.deps.waits?.pollMs ?? SWITCH_POLL_MS;
    for (;;) {
      let ok = false;
      try { ok = await cond(); } catch { ok = false; }
      if (ok) return true;
      if (this.now() >= until) return false;
      await this.sleep(Math.min(poll, Math.max(1, until - this.now())));
    }
  }

  private async runSwitch(reason: FreshReason): Promise<string | null> {
    const w = this.deps.waits ?? {};
    const old = this.deps.settings().sessionId;
    const oldRun = old === null ? null : this.deps.runs.aliveRun(old);
    let memo: string | null = null;
    if (old !== null && oldRun) {
      // 1. 古い統括が手すきになるのを待つ。上限を越えたら待たずに進む。
      if (this.deps.quiet) { const quiet = this.deps.quiet; await this.waitFor(() => quiet(old), w.quietMs ?? SWITCH_QUIET_MS); }
      // 2. 申し送りを頼む。入力欄に入れられなければ、待たずにメモ無しで進む。
      const sw = this.switching;
      if (this.deps.send && this.deps.memoRequest && sw) {
        sw.memoFrom = old;
        let asked = false;
        try { asked = await this.deps.send(old, this.deps.memoRequest()); } catch { asked = false; }
        if (asked) await this.waitFor(() => sw.memo !== null, w.memoMs ?? SWITCH_MEMO_MS);
        memo = sw.memo;
        sw.memoFrom = null;
      }
      // 3. 古い run を止める。その終わりは利用者の停止とみなさない。
      const still = this.deps.runs.aliveRun(old);
      if (still) {
        this.ownKills.add(still.id);
        try { this.deps.runs.kill(still.id); } catch (e) {
          this.ownKills.delete(still.id);
          console.error('[orchestrator] could not stop the old conversation', e instanceof Error ? e.message : e);
        }
      }
    }
    // 3. 新しい会話を起こす。止まっていた状態は捨てる。
    const s = this.deps.settings();
    const r = await this.deps.runs.startOrchestrator(this.launchOf(s));
    this.halted = false;
    this.failures = [];
    this.launched = specOf(s);
    // 5. 系譜を更新する。
    this.deps.save({ sessionId: r.sessionId, ...(old !== null && old !== r.sessionId ? { history: this.pushed(old, reason) } : {}) });
    this.set({ status: 'running' });
    // 4. 引き継ぎを新しい統括の最初の入力にする。
    if (old !== null && this.deps.send && this.deps.handoff) {
      const text = this.deps.handoff({ previousId: old, memo });
      const quiet = this.deps.quiet;
      const ready = quiet ? await this.waitFor(() => quiet(r.sessionId), w.readyMs ?? SWITCH_READY_MS) : true;
      let sent = false;
      if (ready) { try { sent = await this.deps.send(r.sessionId, text); } catch { sent = false; } }
      if (!sent) console.error('[orchestrator] could not hand off to the new conversation');
    }
    return r.sessionId;
  }

  /** 統括を起こすときの指定（アカウントとアプリ）。 */
  private launchOf(s: OrchestratorSetting): { account?: string; agent: AgentKind } {
    return { ...(s.account === null ? {} : { account: s.account }), agent: s.agent };
  }

  /** 設定のアプリが、その会話を動かしているアプリと違うか。同じ会話では起こし直せず、新しい会話が要る。 */
  private agentChanged(s: OrchestratorSetting, sessionId: string): boolean {
    let p: AgentKind | null = null;
    try { p = this.deps.providerOf?.(sessionId) ?? null; } catch { p = null; }
    return p !== null && p !== s.agent;
  }

  /** 系譜に old を足した値。 */
  private pushed(old: string, reason: OrchestratorSwitchReason): OrchestratorSetting['history'] {
    let startedAt: number | null = null;
    try { startedAt = this.deps.startedAt?.(old) ?? null; } catch { startedAt = null; }
    return pushOrchestratorHistory(this.deps.settings().history, { sessionId: old, startedAt, endedAt: this.now(), reason });
  }

  private emit(): void {
    const st = this.state();
    for (const cb of this.listeners) cb(st);
  }

  /** 状態が変わるたびに呼ぶ。外すには返り値を呼ぶ。 */
  onState(cb: (s: KeeperState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * 設定が変わった（入り切り、モデル、effort、アカウント）。切になれば止まる状態を忘れ、入れ直したときだけ失敗の数を捨てて始める。
   * 前の hangar から引き継いだ run（launched が null）は、設定の変更で呼ばれたときだけ「指定が変わった」とみなして起こし直す（起動時は触らない）。
   */
  apply(changed = true): void {
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
    const id = this.deps.settings().sessionId;
    if (changed && this.launched === null && id !== null && this.deps.runs.aliveRun(id)) this.launched = UNKNOWN_SPEC;
    this.schedule();
    this.respec();
  }

  /**
   * 指定が変わっていて統括が動いていれば、入力待ち（idle）のときに止める。作業中なら何もせず、実行中の一覧が変わるたびに見直す。
   * 止めるのは run の終わりの知らせで起こし直すため、ここでは再開しない。
   */
  private respec(): void {
    const s = this.deps.settings();
    if (this.switching || !s.enabled || this.halted || s.sessionId === null) return;
    if (this.launched === null || sameSpec(this.launched, specOf(s))) { this.rerole(s.sessionId); return; }
    const run = this.deps.runs.aliveRun(s.sessionId);
    if (!run || this.respecs.has(run.id) || this.deps.liveStatus(s.sessionId) !== 'idle') return;
    // アプリが変わったときは、同じ会話を起こし直せない。新しい会話に切り替える（前の会話は系譜に残る）。
    if (this.agentChanged(s, s.sessionId)) { void this.fresh('agent'); return; }
    this.respecs.add(run.id);
    try { this.deps.runs.kill(run.id); } catch (e) {
      this.respecs.delete(run.id);
      console.error('[orchestrator] could not restart with the new launch settings', e instanceof Error ? e.message : e);
    }
  }

  /**
   * 動いている統括の役の文の版が今の版と違えば、手すき（idle で、預かりが空で、入力欄が空）のときに止めて、同じ会話を再開し直す（docs/design.md「統括」の役の文）。
   * アプリの入れ替えで役の文が変わっても、tmux の統括は古い役の文のまま動き続けるため。会話は切り替えず、id も変わらない。
   * 止めた後の再開は、指定の変更と同じ道（respecs → onRunEnded → ensure の resumeWith）を通る。
   */
  private rerole(id: string): void {
    const want = this.deps.role?.();
    const read = this.deps.runs.roleHash;
    if (want === undefined || !read || this.roleChecking) return;
    const run = this.deps.runs.aliveRun(id);
    if (!run || this.respecs.has(run.id)) return;
    let have: string | null;
    try { have = read.call(this.deps.runs, run.id); } catch { return; }
    const key = `${id}\0${want}`;
    if (have === want || this.roleTried.has(key) || this.deps.liveStatus(id) !== 'idle') return;
    this.roleChecking = true;
    void (async () => {
      try {
        let quiet = true;
        if (this.deps.quiet) { try { quiet = await this.deps.quiet(id); } catch { quiet = false; } }
        const s = this.deps.settings();
        const cur = this.deps.runs.aliveRun(id);
        if (!quiet || this.switching || !s.enabled || this.halted || s.sessionId !== id || cur?.id !== run.id || this.deps.liveStatus(id) !== 'idle') return;
        this.roleTried.add(key);
        this.respecs.add(run.id);
        try { this.deps.runs.kill(run.id); } catch (e) {
          this.respecs.delete(run.id);
          console.error('[orchestrator] could not restart with the new role', e instanceof Error ? e.message : e);
        }
      } finally {
        this.roleChecking = false;
      }
    })();
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
    this.emit();
  }

  private schedule(): void {
    this.chain = this.chain.then(() => this.ensure()).catch((e: unknown) => { console.error('[orchestrator] keeper failed', e instanceof Error ? e.message : e); });
  }

  private onRunEnded(run: RunDto): void {
    // 見張りが自分で止めた run（切り替え、利用者の stop）。起こし直しは呼んだ側が決める。
    if (this.ownKills.delete(run.id)) return;
    const s = this.deps.settings();
    if (this.respecs.delete(run.id)) {
      // 指定が変わったための止め方。入り切りも失敗の数もそのままで、新しい指定で同じ会話を起こし直す。
      if (s.enabled && !this.halted) { this.restarting = true; this.schedule(); }
      return;
    }
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

  /**
   * 止めた claude が実行中の一覧から消えるのを待つ（RESPEC_GONE_MS まで）。
   * 一覧に残っている間の再開は、止めた run が killed で終わっているため「hangar の外部で実行中」で断られる（runs/accounts.ts の付け替えと同じ待ち方）。
   */
  private waitGone(sessionId: string): Promise<void> {
    if (this.deps.liveStatus(sessionId) === null) return Promise.resolve();
    return new Promise((resolve) => {
      let off: () => void = () => {};
      const done = () => { clearTimeout(timer); off(); resolve(); };
      const timer = setTimeout(done, RESPEC_GONE_MS);
      off = this.deps.onLiveChange(() => { if (this.deps.liveStatus(sessionId) === null) done(); });
    });
  }

  /** 失敗を 1 回数える。止まる回数に届いたら止めて真を返す。 */
  private fail(): boolean {
    const now = this.now();
    this.failures = [...this.failures.filter((t) => now - t < KEEPER_WINDOW_MS), now];
    if (this.failures.length < KEEPER_MAX_FAILURES) return false;
    this.halted = true;
    this.set({ status: 'stopped', reason: 'failures' });
    return true;
  }

  private async ensure(): Promise<void> {
    for (;;) {
      const s = this.deps.settings();
      if (this.switching || !s.enabled || this.halted) return;
      if (s.sessionId !== null && this.deps.runs.aliveRun(s.sessionId)) {
        this.set({ status: 'running' });
        this.respec();
        return;
      }
      try {
        const o = s.account === null ? {} : { account: s.account };
        const sid = s.sessionId;
        const resumable = sid !== null && this.deps.resumable(sid);
        // 会話が別のアプリのものなら再開せず、新しい会話を起こす（前の id は系譜に agent で残す）。
        const other = sid !== null && resumable && this.agentChanged(s, sid);
        if (sid !== null && resumable && !other) {
          if (this.restarting) await this.waitGone(sid);
          await this.deps.runs.resumeWith(sid, this.restarting ? { ...o, stray: 'stop' } : o);
        } else {
          const r = await this.deps.runs.startOrchestrator(this.launchOf(s));
          // 会話が消えて（または別のアプリになって）起こし直した。前の id は系譜に gone（agent）で残す。
          this.deps.save({ sessionId: r.sessionId, ...(s.sessionId !== null && s.sessionId !== r.sessionId ? { history: this.pushed(s.sessionId, other ? 'agent' : 'gone') } : {}) });
        }
        this.launched = specOf(s);
        this.restarting = false;
        this.set({ status: 'running' });
        return;
      } catch (e) {
        console.error('[orchestrator] could not start', e instanceof Error ? e.message : e);
        if (this.fail()) return;
      }
    }
  }
}
