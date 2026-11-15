import type { OrchestratorOrigin, VoiceEvent, VoiceMode, VoiceModelState, VoicePhase, VoiceSetting, VoiceStateDto } from '@agent-hangar/shared';
import { activePersona, speechText } from '@agent-hangar/shared';
import { addressee, initialAddrState, isWindowOpen, type AddrInput, type AddrState } from './addressee.ts';
import { dropReason } from './filters.ts';
import type { VoiceHelper } from './helper.ts';
import { buildHints, hintContext } from './hints.ts';

/** 窓と、呼ばれた後の待ちの期限を見るため、これだけの間隔で tick を入れる。 */
const TICK_MS = 1000;
/** 離したあと、補助の flushed を待つ上限。 */
const FLUSH_WAIT_MS = 3000;
/** 送ったあと、字幕を残す長さ。 */
const CAPTION_MS = 2000;
/** 統括の返答が届いてから、読み上げの依頼（POST /api/voice/speak）を待つ長さ。来なければ読まない返答として扱う。 */
const REPLY_SPEAK_WAIT_MS = 1500;
/** 読み上げを頼まれた返答が、読み上げの終わりを知らせないまま残る上限。 */
const REPLY_SPEAK_MAX_MS = 60_000;
/** 語彙のヒントを作り直して比べる間隔。 */
const HINTS_EVERY_MS = 10_000;

export type VoiceServiceDeps = {
  helper: Pick<VoiceHelper, 'start' | 'send' | 'stop' | 'status' | 'on'>;
  /** 補助の実行ファイルがあるか（resolveVoiceBin が null でないか）。無ければ available は偽のまま。 */
  hasHelper: boolean;
  settings: () => { voice: VoiceSetting; orchestratorSessionId: string | null };
  /** 統括へ 1 本の文を送る（sendToOrchestrator）。 */
  send: (text: string, origin: OrchestratorOrigin) => Promise<unknown>;
  broadcast: (ev: { type: 'voice.state'; state: VoiceStateDto }) => void;
  hintSource: () => { sessionTitles: string[]; projectNames: string[] };
  /** その会話の、assistant の行のいちばん大きい seq。無ければ null。 */
  latestAssistantSeq: (sessionId: string) => number | null;
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
  /** 統括の返答が届いて、まだ replied を入れていないもの。読み上げの依頼が付けば、その終わりで入れる。 */
  private pendingReply: { at: number; speakId: string | null } | null = null;
  private baseline: { sessionId: string; seq: number | null } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastPublished = '';
  private readonly now: () => number;
  private readonly timers: NonNullable<VoiceServiceDeps['timers']>;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => { clearInterval(t); } };
  }

  /** 補助の出来事を聞き始め、時計を回す。補助はここでは起こさない。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.helper.on('event', (e: VoiceEvent) => { this.onEvent(e); });
    this.timer = this.timers.setInterval(() => { this.onTick(); }, TICK_MS);
    this.timer.unref?.();
    this.takeBaseline();
    if (this.cfg().mode === 'always') this.ensureHelper();
    this.publish();
  }

  async stop(): Promise<void> {
    if (this.timer) { this.timers.clearInterval(this.timer); this.timer = null; }
    this.started = false;
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
      phase: this.phase,
      caption: this.caption,
      speakingId: this.speakingId,
      meeting: this.addr.meeting,
    };
  }

  hold(on: boolean): boolean {
    if (!this.ensureHelper()) return false;
    if (on) { this.flushAt = null; this.feed({ kind: 'holdStart', at: this.now() }); return true; }
    if (!this.addr.held) return true;
    // 離したら、いまの区間を閉じさせ、flushed が来てから 1 本にまとめて渡す（段 2 の申し送り）。
    this.flushAt = this.now();
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
    // 返答が届いた直後の依頼なら、窓はその読み上げが終わった時刻から数える。
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

  /** transcript.appended を見て、統括の会話に assistant の行が増えていれば、返答が届いたとする。 */
  onTranscriptAppended(sessionId: string): void {
    const orch = this.deps.settings().orchestratorSessionId;
    if (!orch || sessionId !== orch) return;
    const cur = this.deps.latestAssistantSeq(orch);
    if (this.baseline?.sessionId !== orch) { this.baseline = { sessionId: orch, seq: cur }; return; }
    if (cur === null || (this.baseline.seq !== null && cur <= this.baseline.seq)) return;
    this.baseline.seq = cur;
    // 最初の 1 通だけを覚える。続きの返答で窓の起点を後ろへずらさない。
    this.pendingReply ??= { at: this.now(), speakId: null };
  }

  /** 語彙のヒントを作り直し、変わっていれば補助へ送る。 */
  refreshHints(force = false): void {
    const p = activePersona(this.cfg());
    const next = buildHints({ ...this.deps.hintSource(), callName: p.name });
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

  private takeBaseline(): void {
    const orch = this.deps.settings().orchestratorSessionId;
    if (orch) this.baseline = { sessionId: orch, seq: this.deps.latestAssistantSeq(orch) };
  }

  private onEvent(e: VoiceEvent): void {
    const at = this.now();
    switch (e.ev) {
      case 'ready':
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
        this.finishHold(at);
        return;
      case 'speaking':
        if (e.state === 'start') this.speakingId = e.id;
        else {
          if (this.speakingId === e.id) this.speakingId = null;
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
    if (this.flushAt === null) return;
    this.flushAt = null;
    this.feed({ kind: 'holdEnd', at });
  }

  private fireReplied(at: number): void {
    const r = this.pendingReply;
    this.pendingReply = null;
    this.feed({ kind: 'replied', at: r ? Math.max(r.at, at) : at });
  }

  private onTick(): void {
    const at = this.now();
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
    if (out.send) {
      this.caption = out.send.text;
      this.captionUntil = this.now() + CAPTION_MS;
      this.takeBaseline();
      void this.deps.send(out.send.text, out.send.origin).catch(() => undefined);
    } else if (this.addr.held && input.kind === 'segment') {
      this.caption = this.addr.heldTexts.join(' ');
      this.captionUntil = null;
    }
    this.syncListen();
    this.publish();
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
