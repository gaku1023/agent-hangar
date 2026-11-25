import type { AgentAnswerValue, AgentAskPort, AgentAskReply, AgentPendingAsk } from '../../agent/pendingAsk.ts';
import type { CodexPending } from './asks.ts';
import type { CodexRpcLike } from './live.ts';

/**
 * Codex の札に、app-server の API で答える（peer chat、docs/design.md「別の PC の会話と話す」）。
 * 要求（サーバからの JSON-RPC）の応答を hangar の接続で書き、`serverRequest/resolved` が来るのを待って確かめる。
 * 応答の形は app-server の schema（compat の見本。CommandExecutionRequestApprovalResponse など）による。
 */

/** 応答を書いてから、resolved を待つ長さ。 */
export const CODEX_RESOLVE_WAIT_MS = 3000;

/** 札の入り口。CodexLive がこの口を持つ（askHandle）。 */
export type CodexAskSource = {
  askHandle(providerSessionId: string): { pending: CodexPending[]; rpc: CodexRpcLike } | null;
};

/** 待っている要求を、共通の札の形にする。api の requestKey は hangar の接続での要求の id（stableId には入れない）。 */
export function codexAgentAsk(p: CodexPending): AgentPendingAsk {
  const api = { requestKey: p.key, method: p.raw.method };
  if (p.kind === 'permission') {
    return { provider: 'codex', stableId: p.stableId, api, kind: 'permission', tool: p.ask.tool, input: p.ask.input, description: p.ask.description, choices: p.choices, questions: [] };
  }
  return { provider: 'codex', stableId: p.stableId, api, kind: 'question', ...(p.question !== null ? { description: p.question } : {}), choices: [], questions: p.questions };
}

const DECISION_OF_SCOPE = { once: 'accept', session: 'acceptForSession', deny: 'decline', 'deny-stop': 'cancel' } as const;

const asStrings = (v: AgentAnswerValue): string[] => (Array.isArray(v) ? v.map(String) : [String(v)]);

/**
 * 答えから、要求への応答の中身（result）を作る。作れないとき（選べない決定、欄のある問い合わせ、問いの食い違い）は null。
 * - 命令・ファイルの変更：`{decision}`。
 * - 権限の追加：求められた permissions をそのまま許すか（scope は once なら turn、session なら session）、断るなら `{permissions: {}}`。
 * - requestUserInput：`{answers: {<問いの id>: {answers: [文字列]}}}`。選択肢の key（番号）は label に戻す。それ以外の文字列は自由記述としてそのまま送る。
 * - MCP の問い合わせ：`{action}`。
 */
export function codexAnswerPayload(p: CodexPending, reply: AgentAskReply): unknown | null {
  if (p.kind === 'permission') {
    if (reply.kind !== 'permission' || reply.choice === undefined) return null;
    const choice = p.choices.find((c) => c.scope === reply.choice);
    if (!choice) return null;
    if (p.raw.method === 'item/permissions/requestApproval') {
      if (reply.choice === 'deny' || reply.choice === 'deny-stop') return { permissions: {}, scope: 'turn' };
      const asked = p.raw.params.permissions;
      return { permissions: typeof asked === 'object' && asked !== null ? asked : {}, scope: reply.choice === 'session' ? 'session' : 'turn' };
    }
    return { decision: DECISION_OF_SCOPE[reply.choice] };
  }
  if (reply.kind !== 'question') return null;
  if (p.raw.method === 'mcpServer/elicitation/request') {
    const q = p.questions[0];
    if (!q || q.kind === 'external') return null;
    const v = reply.answers[q.id];
    const action = v === undefined ? undefined : asStrings(v)[0];
    return action !== undefined && q.options.some((o) => o.key === action) ? { action } : null;
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of p.questions) {
    const v = reply.answers[q.id];
    if (v === undefined) continue;
    answers[q.id] = { answers: asStrings(v).map((s) => q.options.find((o) => o.key === s)?.label ?? s) };
  }
  return { answers };
}

function resolvedFor(key: string): (method: string, params: unknown) => boolean {
  return (method, params) => method === 'serverRequest/resolved' && typeof params === 'object' && params !== null && String((params as { requestId?: unknown }).requestId) === key;
}

/**
 * Codex の札を読み、答える口（AgentAskPort）。
 * answer は、応答を書いてから serverRequest/resolved を CODEX_RESOLVE_WAIT_MS まで待つ。
 * 来たら 'ok'。来ないまま要求が残っていれば 'unreachable'（画面の道へ）。来ないうえに要求が消えていれば 'gone'（先に別の接続で解かれた）。
 * 書く前に要求がもう無ければ 'gone'。接続が無い、閉じている、API で答えられない札は 'unreachable'。
 */
export function createCodexAskPort(source: CodexAskSource, o: { resolveWaitMs?: number } = {}): AgentAskPort {
  const waitMs = o.resolveWaitMs ?? CODEX_RESOLVE_WAIT_MS;
  return {
    current(sessionId) {
      const first = source.askHandle(sessionId)?.pending[0];
      return first ? codexAgentAsk(first) : null;
    },
    async answer(sessionId, ask, reply) {
      const h = source.askHandle(sessionId);
      if (!h || h.rpc.isClosed || ask.api === null) return 'unreachable';
      const key = ask.api.requestKey;
      const p = h.pending.find((q) => q.key === key);
      if (!p) return 'gone';
      const result = codexAnswerPayload(p, reply);
      if (result === null) return 'unreachable';
      const isResolved = resolvedFor(key);
      let off: () => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resolved = new Promise<boolean>((res) => {
        timer = setTimeout(() => res(false), waitMs);
        off = h.rpc.onAny((n) => { if (isResolved(n.method, n.params)) res(true); });
      });
      try {
        h.rpc.respond(p.raw.id, result);
      } catch {
        off();
        clearTimeout(timer);
        return 'unreachable';
      }
      const got = await resolved;
      off();
      clearTimeout(timer);
      if (got) return 'ok';
      return source.askHandle(sessionId)?.pending.some((q) => q.key === key) ? 'unreachable' : 'gone';
    },
  };
}
