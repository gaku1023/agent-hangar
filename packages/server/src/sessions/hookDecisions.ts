import { randomUUID } from 'node:crypto';
import type { LiveSessionDto } from '@agent-hangar/shared';

/**
 * PermissionRequest の hook（台本 launch/hookScript.ts）が、答えを待っている間の待ち合わせの表。
 *
 * 札が出ると、claude は PermissionRequest の hook を同期で走らせる。
 * 台本は入力を /hook に送って待ちの id をもらい、/decision を繰り返し呼んで答えを待つ。
 * 札に答える手（peer/chat/answer.ts）は、画面にキーを打つ代わりに、ここへ答えを決める（decide）。
 * 台本は答えを標準出力に書き、claude は札を出さずに（出ていた札を閉じて）その答えを使う。
 * 手元の画面や別の PC が先に答えたとき、claude は hook のプロセスを止めない（Claude Code 2.1.326 で確かめた）。
 * そのため、PostToolUse（AskUserQuestion）、登録が待ちを抜けたこと、会話が一覧から消えたことで、待ちを閉じて台本を抜けさせる。
 *
 * 手元だけの一時の事実なので、DB にも同期にも載せない。サーバを起こし直したら忘れる（台本は gone を受けて抜け、札は画面に残る）。
 */

/** 決められた答えの形。hook で言えるものだけを持つ。 */
export type HookChoice = { kind: 'permission'; behavior: 'allow' | 'deny' } | { kind: 'question'; value: string };

/** 札の照合に使う、画面の札の側の見え方（PeerChatAsk の一部）。 */
export type HookAsk = { kind: 'permission' | 'question'; tool?: string; input?: string };

export type HookDecisionInput = {
  providerSessionId: string;
  tool: string;
  /** 許可の中身として見せる 1 つ（readPermissionHook の input）。 */
  input: string;
  /** hook の入力の tool_input そのもの。質問の答えを組むのに使う。 */
  toolInput: unknown;
  suggestions: unknown[];
};

export type WaitResult = { t: 'answer'; output: Record<string, unknown> } | { t: 'gone' } | { t: 'pending' };

/** 画面を読む前に hook が届いた待ちを、一覧に現れなくても残す長さ（permissionAsks.ts と同じ考え方）。 */
const UNSEEN_TTL_MS = 30_000;
/** 待ちの寿命の上限。claude 側の hook の timeout（3600 秒）より少し長い。 */
const MAX_AGE_MS = 3_700_000;
const DELIVERED_KEEP = 64;
/** 断りの message。claude がモデルに見せる。 */
const DENY_MESSAGE = 'The user declined this request from Hangar.';

type Entry = {
  id: string;
  sessionId: string;
  d: HookDecisionInput;
  at: number;
  /** 登録が許可の待ちに入ったのを見たか。 */
  seen: boolean;
  output: Record<string, unknown> | null;
  closed: boolean;
  wake: (() => void) | null;
};

const strip = (s: string): string => s.replace(/\s+/g, '');
const outOf = (decision: Record<string, unknown>): Record<string, unknown> => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });

/** 質問の 1 問目の文。問いが 1 問でなければ null（複数の問いは画面で打つ）。 */
function singleQuestion(toolInput: unknown): string | null {
  const qs = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length !== 1) return null;
  const q = (qs[0] as { question?: unknown } | null)?.question;
  return typeof q === 'string' && q !== '' ? q : null;
}

export class HookDecisions {
  private entries = new Map<string, Entry>();
  private delivered = new Set<string>();
  private readonly now: () => number;
  private readonly onOpen: () => void;

  /** onOpen は待ちを開けたときに呼ぶ。登録の読み直しを繰り上げさせる（PermissionAsks の onPut と同じ）。 */
  constructor(o: { now?: () => number; onOpen?: () => void } = {}) {
    this.now = o.now ?? Date.now;
    this.onOpen = o.onOpen ?? (() => {});
  }

  /** hook の入力を待ちとして開き、台本へ渡す id を返す。sessionId は hangar のセッションの id。 */
  open(sessionId: string, d: HookDecisionInput): string {
    const id = randomUUID();
    this.entries.set(id, { id, sessionId, d, at: this.now(), seen: false, output: null, closed: false, wake: null });
    this.onOpen();
    return id;
  }

  private live(id: string, sessionId: string): Entry | null {
    const e = this.entries.get(id);
    return e && e.sessionId === sessionId && !e.closed ? e : null;
  }

  /** 台本の待ち。決まっていれば返し、決まらなければ ms まで待って pending を返す。 */
  async wait(sessionId: string, id: string, ms: number): Promise<WaitResult> {
    const e = this.live(id, sessionId);
    if (!e) return { t: 'gone' };
    if (e.output === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { e.wake = null; resolve(); }, ms);
        e.wake = () => { clearTimeout(timer); e.wake = null; resolve(); };
      });
    }
    if (e.closed) return { t: 'gone' };
    if (e.output === null) return { t: 'pending' };
    const output = e.output;
    this.markDelivered(e);
    return { t: 'answer', output };
  }

  private markDelivered(e: Entry): void {
    this.delivered.add(e.id);
    while (this.delivered.size > DELIVERED_KEEP) this.delivered.delete(this.delivered.values().next().value!);
    this.drop(e);
  }

  private drop(e: Entry): void {
    e.closed = true;
    this.entries.delete(e.id);
    e.wake?.();
  }

  /**
   * 画面の札（ask）に合う待ちへ、答えを決める。合う待ちが無い、まだ決めていない待ちが無い、hook で言えない札は null。
   * 札の照合は、道具の名前と主な引数（質問は問いの文）である。
   */
  decide(sessionId: string, ask: HookAsk, choice: HookChoice): { id: string } | null {
    const list = [...this.entries.values()].filter((e) => e.sessionId === sessionId && !e.closed && e.output === null).reverse();
    for (const e of list) {
      const output = this.outputFor(e, ask, choice);
      if (!output) continue;
      e.output = output;
      e.wake?.();
      return { id: e.id };
    }
    return null;
  }

  private outputFor(e: Entry, ask: HookAsk, choice: HookChoice): Record<string, unknown> | null {
    if (ask.tool !== undefined && ask.tool !== e.d.tool) return null;
    if (choice.kind === 'permission') {
      if (ask.kind !== 'permission' || e.d.tool === 'AskUserQuestion' || (ask.input ?? '') !== e.d.input) return null;
      return outOf(choice.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: DENY_MESSAGE, interrupt: true });
    }
    if (ask.kind !== 'question' || e.d.tool !== 'AskUserQuestion') return null;
    const q = singleQuestion(e.d.toolInput);
    if (q === null || strip(ask.input ?? '') !== strip(q)) return null;
    const questions = (e.d.toolInput as { questions: unknown }).questions;
    return outOf({ behavior: 'allow', updatedInput: { questions, answers: { [q]: choice.value } } });
  }

  /** そのセッションの、開いていて、まだ答えが決まっていない最新の待ちの入力（札の代わりを作る）。無ければ null。 */
  peek(sessionId: string): HookDecisionInput | null {
    let found: HookDecisionInput | null = null;
    for (const e of this.entries.values()) if (e.sessionId === sessionId && !e.closed && e.output === null) found = e.d;
    return found;
  }

  /** そのセッションの、開いている待ちの数。 */
  pending(sessionId: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.sessionId === sessionId && !e.closed) n++;
    return n;
  }

  /** 決めた答えが、台本に渡ったか（渡した後は待ちが消えるので、覚えている）。 */
  isDelivered(id: string): boolean {
    return this.delivered.has(id);
  }

  /** 台本に渡る前の答えを取り下げる（台本が来ない。画面で打つ道に戻る）。 */
  withdraw(id: string): void {
    const e = this.entries.get(id);
    if (e && !e.closed) e.output = null;
  }

  /** 画面で先に答えられた（PostToolUse、取り消し）。そのセッションの、その道具の待ちを閉じる。 */
  closeTool(sessionId: string, tool: string): void {
    for (const e of [...this.entries.values()]) if (e.sessionId === sessionId && e.d.tool === tool) this.drop(e);
  }

  /** run が終わった。そのセッションの待ち全部を閉じる。 */
  closeSession(sessionId: string): void {
    for (const e of [...this.entries.values()]) if (e.sessionId === sessionId) this.drop(e);
  }

  /**
   * 実行中の一覧の読み直しのたびに呼ぶ。登録が許可の待ちを抜けた待ち、一覧から消えた会話の待ちを閉じる。
   * hook と登録の waiting のどちらが先に届くかは決まらないので、待ちを見るまでは閉じない（見ないまま UNSEEN_TTL_MS で閉じる）。
   */
  apply(live: LiveSessionDto[], now: number): void {
    for (const e of [...this.entries.values()]) {
      if (now - e.at > MAX_AGE_MS) { this.drop(e); continue; }
      const l = live.find((x) => x.sessionId === e.d.providerSessionId);
      if (!l) { if (now - e.at > UNSEEN_TTL_MS) this.drop(e); continue; }
      if (l.status === 'waiting' && forThisWait(e.d.tool, l)) { e.seen = true; continue; }
      if (e.seen || now - e.at > UNSEEN_TTL_MS) this.drop(e);
    }
  }
}

function forThisWait(tool: string, l: LiveSessionDto): boolean {
  if (l.waitingFor === undefined || l.waitingFor === 'permission') return true;
  return l.waitingFor === 'question' && tool === 'AskUserQuestion';
}
