import type { PeerChatAsk } from '@agent-hangar/shared';
import {
  AGENT_BOOLEAN_CHOICES,
  checkAnswer,
  currentQuestion,
  settleAnswers,
  stepPlan,
  toPeerChatAsk,
  type AgentAnswerValue,
  type AgentAskChoice,
  type AgentAskPort,
  type AgentAskReply,
  type AgentPendingAsk,
  type AgentStoredAnswers,
} from '../../agent/pendingAsk.ts';
import type { AnswerResult } from './answer.ts';
import type { PeerPendingAsk } from './tail.ts';

/**
 * Codex と opencode の札の、host 側の面（docs/design.md「別の PC の会話と話す」）。
 * 札の読み書きは provider ごとの口（AgentAskPort）に任せ、ここは次の 3 つをする。
 * - 口の今の要求（AgentPendingAsk）と、貯めた答えから、見せる札（PeerPendingAsk の prebuilt）を作る。
 * - 問いが複数ある質問を 1 問ずつ受けて貯め、最後の問いで口へ 1 回だけ送る。
 * - 口が 'unreachable' のとき、画面の道（screenAnswer）へ落とす。
 *
 * 貯めた答えはメモリだけで、会話ごとに 1 つ。口の要求が無くなるか別の札（stableId が違う）に替わったら捨てる。
 * 同じ会話の答えは、呼び手（host.ts）が 1 つずつ流す。
 */

export type AgentProvider = 'codex' | 'opencode';

/**
 * 画面の道で答える口（peer/chat/codexDialog.ts と opencodeDialog.ts が提供し、boot が差す）。
 * ask と reply は API の道と同じもの。sessionId は hangar の会話の ID（画面は run から引く）。
 * 画面の札が ask と照合できない、打ってはならない答えのときは 'mismatch'（何も打たない）。
 * 画面の道で答えるのは、許可と、選択肢を 1 つ選ぶだけの質問 1 つに限る（それ以外は呼ばない）。
 */
export type AgentScreenAnswer = (provider: AgentProvider, sessionId: string, ask: AgentPendingAsk, reply: AgentAskReply) => Promise<'ok' | 'mismatch'>;

export type AgentAskDeps = {
  /** hangar の会話の ID で引ける札の口（provider の会話の ID への引き換えは呼び手が済ませる）。無い provider は札を出さない。 */
  ports: Partial<Record<AgentProvider, AgentAskPort>>;
  screenAnswer?: AgentScreenAnswer;
};

type Stored = { stableId: string; answers: AgentStoredAnswers; /** 空の答えで飛ばした問い。 */ skipped: Set<string> };

const mismatch: AnswerResult = { ok: false, reason: 'ask-mismatch' };
const settled: AnswerResult = { ok: false, reason: 'already-answered' };

/** 画面の道で答えられる札か。許可と、選択肢を 1 つ選ぶだけの質問 1 つ。 */
export function screenAnswerable(ask: AgentPendingAsk): boolean {
  if (ask.kind === 'permission') return true;
  const only = ask.questions.length === 1 ? ask.questions[0]! : null;
  return only !== null && only.kind === 'choice' && !only.multi && !only.secret && only.options.length > 0;
}

/** 貯めた答えと、飛ばした問い（default があればそれ、無ければ空の文字）を合わせた、手順を進める見立て。 */
function progressOf(ask: AgentPendingAsk, st: Stored): AgentStoredAnswers {
  const out: AgentStoredAnswers = { ...st.answers };
  for (const id of st.skipped) {
    const dflt = ask.questions.find((x) => x.id === id)?.default;
    out[id] = dflt === undefined ? '' : (dflt as AgentAnswerValue);
  }
  return out;
}

export class AgentAsks {
  private readonly stored = new Map<string, Stored>();

  constructor(private readonly deps: AgentAskDeps) {}

  handles(provider: string): provider is AgentProvider {
    return (provider === 'codex' || provider === 'opencode') && this.deps.ports[provider] !== undefined;
  }

  /** 口の今の要求と貯めた答え。要求が無いか別の札に替わっていれば、貯めた答えを捨てる。 */
  current(sessionId: string, provider: AgentProvider): { ask: AgentPendingAsk; st: Stored } | null {
    const ask = this.deps.ports[provider]?.current(sessionId) ?? null;
    const st = this.stored.get(sessionId);
    if (!ask) { this.stored.delete(sessionId); return null; }
    if (st && st.stableId === ask.stableId) return { ask, st };
    const fresh: Stored = { stableId: ask.stableId, answers: {}, skipped: new Set() };
    this.stored.set(sessionId, fresh);
    if (this.stored.size > 64) this.stored.delete(this.stored.keys().next().value!);
    return { ask, st: fresh };
  }

  /** tail が見せる札。無ければ null。 */
  pending(sessionId: string, provider: AgentProvider): PeerPendingAsk | null {
    const cur = this.current(sessionId, provider);
    if (!cur) return null;
    const { ask, st } = cur;
    const progress = progressOf(ask, st);
    const prebuilt = toPeerChatAsk(ask, progress);
    const q = ask.kind === 'question' ? currentQuestion(ask, progress)?.question : undefined;
    const out: PeerPendingAsk = {
      kind: ask.kind,
      options: prebuilt.options,
      multi: prebuilt.multi,
      allowText: prebuilt.allowText,
      prebuilt,
      text: ask.kind === 'question' ? q?.text ?? '' : ask.description || ask.input || ask.tool || '',
    };
    if (ask.tool !== undefined) out.tool = ask.tool;
    // 口の API で答えられない札は、画面の道で答えられるときだけ答えられる札にする。
    if (prebuilt.answerable === false || (ask.api === null && !(this.deps.screenAnswer && screenAnswerable(ask)))) out.answerable = false;
    return out;
  }

  /**
   * 札 current（今 tail が見せているもの）への答え。
   * キーは current.options のキー。口の元のキーへは、並びの番号で引き直す（見せるとき、長さと重なりを直したため）。
   */
  async answer(sessionId: string, provider: AgentProvider, current: PeerChatAsk, keys: string[], text: string | undefined): Promise<AnswerResult> {
    const port = this.deps.ports[provider];
    const cur = this.current(sessionId, provider);
    if (!port || !cur) return settled;
    const { ask, st } = cur;
    const progress = progressOf(ask, st);
    const shown = toPeerChatAsk(ask, progress);
    if (shown.askId !== current.askId || shown.answerable === false) return mismatch;

    const origKeys: string[] = [];
    const raw: AgentAskChoice[] = ask.kind === 'permission' ? ask.choices : (() => {
      const q = currentQuestion(ask, progress)?.question;
      return q ? (q.kind === 'boolean' ? AGENT_BOOLEAN_CHOICES : q.options) : [];
    })();
    for (const k of keys) {
      const i = current.options.findIndex((o) => o.key === k);
      const orig = i < 0 ? undefined : raw[i];
      if (!orig) return mismatch;
      origKeys.push(orig.key);
    }

    if (ask.kind === 'permission') {
      if (keys.length !== 1 || (text !== undefined && text !== '')) return mismatch;
      const choice = ask.choices[current.options.findIndex((o) => o.key === keys[0])];
      if (!choice?.scope) return mismatch;
      const r = await this.send(sessionId, provider, port, ask, { kind: 'permission', choice: choice.scope });
      return r === 'ok' ? { ok: true, label: choice.label } : r;
    }

    const cq = currentQuestion(ask, progress);
    if (!cq) return mismatch;
    const { question } = cq;
    const checked = checkAnswer(question, origKeys, text);
    if (!checked.ok) return mismatch;
    const label = question.secret ? '' : labelOf(question, origKeys, text);

    // 貯めるのは、送るのに成功してからか、まだ続きがあるときだけ。失敗したら元のまま。
    const next: Stored = { stableId: st.stableId, answers: { ...st.answers }, skipped: new Set(st.skipped) };
    if (checked.value === undefined) next.skipped.add(question.id);
    else { next.answers[question.id] = checked.value; next.skipped.delete(question.id); }
    const after = progressOf(ask, next);
    const done = stepPlan(ask, after).every((x) => x.id in after);
    if (!done) {
      this.stored.set(sessionId, next);
      return { ok: true, label };
    }
    const answers = settleAnswers(ask, after);
    for (const id of next.skipped) if (ask.questions.find((x) => x.id === id)?.default === undefined) delete answers[id];
    const reply: AgentAskReply = { kind: 'question', answers };
    const hasText = text !== undefined && text.trim() !== '';
    const r = await this.send(sessionId, provider, port, ask, reply, !hasText);
    if (r === 'ok') this.stored.set(sessionId, next);
    return r === 'ok' ? { ok: true, label } : r;
  }

  /**
   * 口へ答えを 1 回送る。
   * 'unreachable'（または api が無い札）は画面の道へ。移る直前に要求をもう一度見て、消えていれば already-answered にする（API の resolved が遅れて来たとき、二重に答えない）。
   */
  private async send(sessionId: string, provider: AgentProvider, port: AgentAskPort, ask: AgentPendingAsk, reply: AgentAskReply, screenOk = true): Promise<'ok' | AnswerResult> {
    let r: 'ok' | 'gone' | 'unreachable' = 'unreachable';
    if (ask.api !== null) r = await port.answer(sessionId, ask, reply);
    if (r === 'ok') return 'ok';
    if (r === 'gone') { this.stored.delete(sessionId); return settled; }
    const again = port.current(sessionId);
    if (!again || again.stableId !== ask.stableId) { this.stored.delete(sessionId); return settled; }
    if (!this.deps.screenAnswer || !screenOk || !screenAnswerable(ask)) return mismatch;
    return (await this.deps.screenAnswer(provider, sessionId, ask, reply)) === 'ok' ? 'ok' : mismatch;
  }
}

/** 答えた記録に残す文。選んだ選択肢の label（複数なら「, 」でつなぐ）。自由記述はその文。 */
function labelOf(question: AgentPendingAsk['questions'][number], keys: string[], text: string | undefined): string {
  const opts: AgentAskChoice[] = question.kind === 'boolean' ? AGENT_BOOLEAN_CHOICES : question.options;
  if (keys.length > 0) return keys.map((k) => opts.find((o) => o.key === k)?.label ?? k).join(', ');
  return text?.trim() ?? '';
}
