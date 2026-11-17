import type { LiveStatus, OrchestratorOrigin, VoiceEvent, VoiceMode, VoiceModelState, VoicePhase, VoiceSetting, VoiceStateDto } from '@agent-hangar/shared';
import { activePersona, speechText } from '@agent-hangar/shared';
import { addressee, initialAddrState, isStrongOrigin, isWindowOpen, type AddrInput, type AddrState } from './addressee.ts';
import { dropReason } from './filters.ts';
import type { VoiceHelper } from './helper.ts';
import { buildHints, hintContext } from './hints.ts';

/** 窓と、呼ばれた後の待ちの期限を見るため、これだけの間隔で tick を入れる。 */
const TICK_MS = 1000;
/** 離したあと、補助の flushed を待つ上限。 */
const FLUSH_WAIT_MS = 3000;
/** 送ったあと、字幕を残す長さ。 */
const CAPTION_MS = 2000;
/** 統括のターンが終わってから、読み上げの依頼（POST /api/voice/speak）を待つ長さ。来なければ読まない返答として扱う。 */
const REPLY_SPEAK_WAIT_MS = 1500;
/** 読み上げを頼まれた返答が、読み上げの終わりを知らせないまま残る上限。 */
const REPLY_SPEAK_MAX_MS = 60_000;
/** 語彙のヒントを作り直して比べる間隔。 */
const HINTS_EVERY_MS = 10_000;

export type VoiceServiceDeps = {
  helper: Pick<VoiceHelper, 'start' | 'send' | 'stop' | 'status' | 'on' | 'off'>;
  /** 補助の実行ファイルがあるか（resolveVoiceBin が null でないか）。無ければ available は偽のまま。 */
  hasHelper: boolean;
  settings: () => { voice: VoiceSetting; orchestratorSessionId: string | null };
  /** 統括へ 1 本の文を送る（sendToOrchestrator）。ok が偽なら届いていない。 */
  send: (text: string, origin: OrchestratorOrigin) => Promise<{ ok: boolean }>;
  broadcast: (ev: { type: 'voice.state'; state: VoiceStateDto }) => void;
  hintSource: () => { sessionTitles: string[]; projectNames: string[] };
  /** 統括の会話のいまの様子（実行中の一覧の status）。動いていなければ null。 */
  orchestratorStatus: () => LiveStatus | null;
  now?: () => number;
  timers?: { setInterval: (f: () => void, ms: number) => NodeJS.Timeout; clearInterval: (t: NodeJS.Timeout) => void };
};

/**
 * 机の音声のサービス（docs/design.md「机の音声」）。補助（hangar-voice）の出来事を、捨てる決まりと誰宛ての状態機械に通し、
 * 送ってよい文だけを統括へ送る。画面へは状態（voice.state）を配り、読み上げは画面の頼みで補助へ渡す。
 * 補助を起こすのは、常に聞くのとき、または押す・切り替え・読み上げ・準備が来たときだけである。
 */
export class VoiceService {
  private addr: AddrState = initialAddrState();
  private phase: VoicePhase = 'off';
  private caption: string | null = null;
  private captionUntil: number | null = null;
  private speakingId: string | null = null;
  private models: { state: VoiceModelState; progress: number } = { state: 'missing', progress: 0 };
  private started = false;
  private helperStarted = false;
  private listening = false;
  private hints: string[] = [];
  private hintsAt = 0;
  private flushAt: number | null = null;
  /**
   * 補助へ出した flush の数と、受けた flushed の数。補助は命令を順に処理するので、flushed は flush の順に返る。
   * flushTarget は待っている（最後に出した）flush の番号で、その番の flushed が来たときだけ離した扱いにする。
   */
  private flushesSent = 0;
  private flushesSeen = 0;
  private flushTarget: number | null = null;
  /** 強い声のターンが終わって、まだ replied を入れていないもの。読み上げの依頼が付けば、その終わりで入れる。 */
  private pendingReply: { at: number; speakId: string | null } | null = null;
  /**
   * 強い声を送った後の、統括のターンの終わりの待ち。
   * endsLeft は数えるターンの終わりの残り（送った時点でターンが走っていれば、その終わりの分を足して 2）、
   * active はいま見ているターンが走っているか、confirmed は送れたと分かったか。
   */
  private turn: { endsLeft: number; active: boolean; confirmed: boolean } | null = null;
  /** 頼まれて、まだ終わりの知らせが来ていない読み上げ。 */
  private lastSpeak: string | null = null;
  /** 送った数。送れなかった知らせが、後から送った文の待ちを消さないために数える。 */
  private sends = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastPublished = '';
  private readonly now: () => number;
  private readonly onHelperEvent = (e: VoiceEvent) => { this.onEvent(e); };
  private readonly timers: NonNullable<VoiceServiceDeps['timers']>;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => { clearInterval(t); } };
  }

  /** 補助の出来事を聞き始め、時計を回す。補助はここでは起こさない。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.helper.on('event', this.onHelperEvent);
    this.timer = this.timers.setInterval(() => { this.onTick(); }, TICK_MS);
    this.timer.unref?.();
    if (this.cfg().mode === 'always') this.ensureHelper();
    this.publish();
  }

  async stop(): Promise<void> {
    if (this.timer) { this.timers.clearInterval(this.timer); this.timer = null; }
    this.started = false;
    this.deps.helper.off('event', this.onHelperEvent);
    await this.deps.helper.stop();
  }

  /** 設定の voice が変わった。常に聞くなら補助を起こし、聞く状態と語彙のヒントを合わせる。 */
  onSettingsChanged(): void {
    if (this.cfg().mode === 'always') this.ensureHelper();
    this.feed({ kind: 'tick', at: this.now() });
    this.refreshHints(true);
  }

  state(): VoiceStateDto {
    return {
      available: this.available(),
      models: { ...this.models },
      mode: this.cfg().mode,
      toggled: this.addr.toggled,
      phase: this.phase,
      caption: this.caption,
      speakingId: this.speakingId,
      meeting: this.addr.meeting,
      callable: activePersona(this.cfg()).reading !== '',
    };
  }

  hold(on: boolean): boolean {
    if (!this.ensureHelper()) return false;
    if (on) {
      // flushed を待つ間に押し直したら、前の押している間の文をその場で 1 回送ってから始める（消さない）。
      if (this.flushTarget !== null) this.finishHold(this.now());
      this.feed({ kind: 'holdStart', at: this.now() });
      return true;
    }
    if (!this.addr.held || this.flushTarget !== null) return true;
    // 離したら、いまの区間を閉じさせ、flushed が来てから 1 本にまとめて渡す（段 2 の申し送り）。
    this.flushAt = this.now();
    this.flushTarget = ++this.flushesSent;
    this.deps.helper.send({ cmd: 'flush' });
    return true;
  }

  toggle(on: boolean): boolean {
    if (!this.ensureHelper()) return false;
    this.feed({ kind: on ? 'toggleOn' : 'toggleOff', at: this.now() });
    return true;
  }

  speak(id: string, text: string): boolean {
    if (!this.ensureHelper()) return false;
    const spoken = speechText(text);
    if (spoken === '') return true;
    const p = activePersona(this.cfg());
    this.deps.helper.send({ cmd: 'speak', id, text: spoken, voice: p.voice, speed: p.speed });
    this.lastSpeak = id;
    // ターンが終わった直後の依頼なら、窓はその読み上げが終わった時刻から数える。
    if (this.pendingReply && this.pendingReply.speakId === null) this.pendingReply.speakId = id;
    return true;
  }

  stopSpeaking(): boolean {
    if (!this.ensureHelper()) return false;
    this.deps.helper.send({ cmd: 'stopSpeaking' });
    return true;
  }

  prepare(): boolean {
    if (!this.ensureHelper()) return false;
    this.deps.helper.send({ cmd: 'prepare' });
    return true;
  }

  /** 実行中の一覧が変わった。統括のターンの終わりを見る。 */
  onLiveChange(): void {
    this.observeTurn();
    this.publish();
  }

  /** 語彙のヒントを作り直し、変わっていれば補助へ送る。 */
  refreshHints(force = false): void {
    const p = activePersona(this.cfg());
    const next = buildHints({ ...this.deps.hintSource(), callName: p.name, callReading: p.reading });
    this.hintsAt = this.now();
    if (!force && next.join('\n') === this.hints.join('\n')) return;
    this.hints = next;
    if (this.helperStarted) this.deps.helper.send({ cmd: 'hints', context: hintContext(next) });
  }

  private cfg(): VoiceSetting { return this.deps.settings().voice; }

  private available(): boolean {
    if (!this.deps.hasHelper) return false;
    return !(this.helperStarted && this.deps.helper.status === 'unavailable');
  }

  private ensureHelper(): boolean {
    if (!this.deps.hasHelper) return false;
    if (!this.helperStarted) {
      this.helperStarted = true;
      this.deps.helper.start();
      this.refreshHints(true);
      this.syncListen();
    }
    return this.deps.helper.status !== 'unavailable';
  }

  /** 補助の出来事の受け手。ここで投げると、補助の行を読む readline の中で捕まらない例外になり、サーバごと落ちる。 */
  private onEvent(e: VoiceEvent): void {
    try {
      this.handleEvent(e);
    } catch (err) {
      console.error('[voice] could not handle a helper event', err instanceof Error ? err.message : err);
    }
  }

  private handleEvent(e: VoiceEvent): void {
    const at = this.now();
    switch (e.ev) {
      case 'ready':
        // 起こし直した補助は、前の補助に出した flush に答えない。
        this.flushesSeen = this.flushesSent;
        this.listening = false;
        this.refreshHints(true);
        this.syncListen();
        break;
      case 'models':
        this.models = { state: e.state, progress: e.progress };
        break;
      case 'micUsers':
        this.feed({ kind: 'meeting', on: e.bundles.length > 0, at });
        return;
      case 'segment':
        this.onSegment(e.text, e.dbfs, at);
        return;
      case 'flushed':
        this.flushesSeen++;
        if (this.flushTarget !== null && this.flushesSeen >= this.flushTarget) this.finishHold(at);
        return;
      case 'speaking':
        if (e.state === 'start') this.speakingId = e.id;
        else {
          if (this.speakingId === e.id) this.speakingId = null;
          if (this.lastSpeak === e.id) this.lastSpeak = null;
          // 読み上げが終わった時刻が、窓の起点になる。
          if (this.pendingReply?.speakId === e.id) this.fireReplied(at);
        }
        break;
      case 'vad':
      case 'error':
        break;
    }
    this.publish();
  }

  private onSegment(text: string, dbfs: number, at: number): void {
    const reason = dropReason({ text, dbfs }, { hints: this.hints, inWindow: isWindowOpen(this.addr, at) });
    if (reason !== null) return;
    this.feed({ kind: 'segment', text, at });
  }

  private finishHold(at: number): void {
    if (this.flushTarget === null) return;
    this.flushAt = null;
    this.flushTarget = null;
    this.feed({ kind: 'holdEnd', at });
  }

  private fireReplied(at: number): void {
    const r = this.pendingReply;
    this.pendingReply = null;
    this.feed({ kind: 'replied', at: r ? Math.max(r.at, at) : at });
  }

  /**
   * 強い声のターンが終わったかを、統括の様子（busy・waiting と idle の行き来）で見る。
   * 送った時点で走っていたターンの途中の文や、その終わりでは開かない（そのターンは送った文への返答ではない）。
   * 送れたと分かる前の終わりは、送った文のターンではないので数えない。統括が止まったら待ちを捨てる。迷う場合は窓を開かない側に倒す。
   */
  private observeTurn(): void {
    const t = this.turn;
    if (!t) return;
    const st = this.deps.orchestratorStatus();
    if (st === null) { this.turn = null; return; }
    if (st !== 'idle') { t.active = true; return; }
    if (!t.active) return;
    t.active = false;
    if (t.endsLeft > 1) { t.endsLeft--; return; }
    if (!t.confirmed) return;
    this.turn = null;
    this.onTurnEnded(this.now());
  }

  /** 強い声のターンが終わった。読み上げ中か、頼まれたばかりの読み上げがあれば、その終わりから窓を数える。 */
  private onTurnEnded(at: number): void {
    this.pendingReply = { at, speakId: this.speakingId ?? this.lastSpeak };
  }

  private onTick(): void {
    const at = this.now();
    this.observeTurn();
    if (this.flushAt !== null && at - this.flushAt >= FLUSH_WAIT_MS) this.finishHold(at);
    const r = this.pendingReply;
    if (r) {
      if (r.speakId === null && at - r.at >= REPLY_SPEAK_WAIT_MS) {
        // 読み上げが頼まれなかった返答は、届いた時刻から数える。
        this.pendingReply = null;
        this.feed({ kind: 'replied', at: r.at });
      } else if (r.speakId !== null && at - r.at >= REPLY_SPEAK_MAX_MS) this.fireReplied(r.at);
    }
    if (this.captionUntil !== null && at >= this.captionUntil) { this.caption = null; this.captionUntil = null; }
    if (at - this.hintsAt >= HINTS_EVERY_MS) this.refreshHints();
    this.feed({ kind: 'tick', at });
  }

  private feed(input: AddrInput): void {
    const cfg = this.cfg();
    const [next, out] = addressee(this.addr, input, { mode: cfg.mode, callReading: activePersona(cfg).reading, speaking: this.speakingId !== null });
    this.addr = next;
    this.phase = out.phase;
    if (out.stopSpeaking) this.deps.helper.send({ cmd: 'stopSpeaking' });
    if (out.send) this.dispatch(out.send.text, out.send.origin);
    else if (this.addr.held && input.kind === 'segment') {
      this.caption = this.addr.heldTexts.join(' ');
      this.captionUntil = null;
    }
    this.syncListen();
    this.publish();
  }

  /**
   * 統括へ送り、送れたときだけ送った扱い（字幕、強い声のターンの終わりの待ち）にする。
   * ターンの始まりを取りこぼさないよう、待ちは送る前に作っておき、送れなければ捨てる。
   */
  private dispatch(text: string, origin: OrchestratorOrigin): void {
    this.pendingReply = null;
    const st = this.deps.orchestratorStatus();
    const running = st === 'busy' || st === 'waiting';
    const t = isStrongOrigin(origin) ? { endsLeft: running ? 2 : 1, active: running, confirmed: false } : null;
    this.turn = t;
    const seq = ++this.sends;
    const failed = () => {
      if (t && this.turn === t) this.turn = null;
      // 後から別の文を送っていれば、その文の待ちは消さない。
      if (seq === this.sends) this.feed({ kind: 'sendFailed', at: this.now() });
    };
    void this.deps.send(text, origin).then((r) => {
      if (!r?.ok) { failed(); return; }
      if (t && this.turn === t) t.confirmed = true;
      this.caption = text;
      this.captionUntil = this.now() + CAPTION_MS;
      this.publish();
    }, failed);
  }

  private syncListen(): void {
    if (!this.helperStarted) return;
    const on = this.cfg().mode === 'always' || this.addr.held || this.addr.toggled;
    if (on === this.listening) return;
    this.listening = on;
    this.deps.helper.send({ cmd: 'listen', on });
  }

  private publish(): void {
    const s = this.state();
    const key = JSON.stringify(s);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.deps.broadcast({ type: 'voice.state', state: s });
  }
}

export type { VoiceMode };
