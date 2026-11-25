import { settleAnswers, type AgentAnswerValue, type AgentAskChoice, type AgentAskPort, type AgentAskQuestion, type AgentAskReply, type AgentPendingAsk } from '../../agent/pendingAsk.ts';
import type { OpencodeClient, OpencodeForm, OpencodeFormField, OpencodePermissionDecision, OpencodePermissionRequest } from './client.ts';

/**
 * opencode の札の面（agent/pendingAsk.ts の AgentAskPort の実装）。
 * 許可と form は live.ts の写し（perms、forms）から拾い、答えは serve の API（OpencodeClient の replyPermission、replyForm）へ 1 回で送る。
 * opencode に「止める」は無いので、許可の選択肢は 3 つ（once、session、deny）である。
 */

/**
 * 許可の選択肢。文言は仮（後で Gemini に当てる）。
 * session は opencode の `always` に当たる。always が会話の間だけか、project の保存された規則（/api/permission/saved）に残るかは未確認なので、文言は言い切らない。
 */
export const OPENCODE_PERMISSION_CHOICES: AgentAskChoice[] = [
  { key: 'once', label: '今回だけ許可', description: 'この操作を 1 回だけ許可します。', scope: 'once' },
  { key: 'session', label: '以後も許可', description: '同じ種類の操作を、今後は確認せずに許可します。', scope: 'session' },
  { key: 'deny', label: '許可しない', description: 'この操作を許可せず、断ります。', scope: 'deny' },
];

const DECISION: Record<'once' | 'session' | 'deny', OpencodePermissionDecision> = { once: 'once', session: 'always', deny: 'reject' };

/** 答えを送る口（OpencodeClient の一部）。 */
export type OpencodeAskClient = Pick<OpencodeClient, 'replyPermission' | 'replyForm'>;

/** 写しの持っている待ち。live.ts の OpencodeLive.pendingOf がこの形で返す。 */
export type OpencodeAskSource = {
  pending(sessionId: string): { client: OpencodeAskClient; perms: OpencodePermissionRequest[]; forms: OpencodeForm[] } | null;
};

const permissionOf = (p: OpencodePermissionRequest): AgentPendingAsk => ({
  provider: 'opencode',
  stableId: p.id,
  api: { requestKey: p.id, method: 'POST /api/session/{sid}/permission/{id}/reply' },
  kind: 'permission',
  tool: p.action,
  input: p.resources.join('\n'),
  description: p.message ?? null,
  choices: OPENCODE_PERMISSION_CHOICES,
  questions: [],
});

/**
 * form の 1 欄を問いにする。type の無い欄（2.1.4）は string。知らない type は external にして、答えない。
 * required が無いときは、question の道具の form なら必須、それ以外は任意にする（question の道具は答えが無いと進めない）。
 */
function questionOf(f: OpencodeFormField, isQuestionTool: boolean): AgentAskQuestion {
  const type = f.type ?? 'string';
  const text = f.description ?? f.title ?? f.key;
  const q: AgentAskQuestion = {
    id: f.key,
    text,
    kind: 'text',
    options: [],
    multi: false,
    allowText: false,
    required: f.required ?? isQuestionTool,
  };
  if (f.title && f.description) q.header = f.title;
  if (f.default !== undefined) q.default = f.default;
  if (f.when?.length) q.when = f.when.map((w) => ({ key: w.key, op: w.op, value: w.value }));
  if (f.hidden) q.hidden = true;
  const options = (f.options ?? []).map((o): AgentAskChoice => ({ key: o.value, label: o.label, ...(o.description ? { description: o.description } : {}) }));
  switch (type) {
    case 'string':
      if (options.length > 0) {
        q.kind = 'choice';
        q.options = options;
        q.allowText = f.custom === true;
      } else {
        q.allowText = true;
      }
      break;
    case 'number':
    case 'integer':
      q.kind = type;
      q.allowText = true;
      if (f.min !== undefined) q.min = f.min;
      if (f.max !== undefined) q.max = f.max;
      break;
    case 'boolean':
      q.kind = 'boolean';
      break;
    case 'multiselect':
      q.kind = 'choice';
      q.multi = true;
      q.options = options;
      if (f.minItems !== undefined) q.minItems = f.minItems;
      if (f.maxItems !== undefined) q.maxItems = f.maxItems;
      break;
    default:
      q.kind = 'external';
      q.required = false;
  }
  return q;
}

const formAsk = (f: OpencodeForm): AgentPendingAsk => ({
  provider: 'opencode',
  stableId: f.id,
  api: { requestKey: f.id, method: 'POST /api/session/{sid}/form/{id}/reply' },
  kind: 'question',
  description: f.title || null,
  choices: [],
  questions: f.fields.map((x) => questionOf(x, f.metadata?.kind === 'question')),
});

/** 貯めた答え 1 つを、form の欄の型の値に直す。直せなければ undefined。 */
function valueOf(f: OpencodeFormField, v: AgentAnswerValue): string | number | boolean | string[] | undefined {
  switch (f.type ?? 'string') {
    case 'string':
      return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
    case 'number':
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
    case 'multiselect':
      return Array.isArray(v) ? v : typeof v === 'string' ? [v] : undefined;
    default:
      return undefined;
  }
}

export function createOpencodeAskPort(src: OpencodeAskSource): AgentAskPort {
  return {
    current(sessionId) {
      const p = src.pending(sessionId);
      if (!p) return null;
      const perm = p.perms[0];
      if (perm) return permissionOf(perm);
      const form = p.forms[0];
      return form ? formAsk(form) : null;
    },

    async answer(sessionId, ask, reply: AgentAskReply) {
      const p = src.pending(sessionId);
      if (!p) return 'gone';
      if (ask.kind === 'permission' && reply.kind === 'permission') {
        const req = p.perms.find((x) => x.id === ask.stableId);
        if (!req) return 'gone';
        const scope = reply.choice === 'once' || reply.choice === 'session' ? reply.choice : 'deny';
        return p.client.replyPermission(req.sessionID, req.id, DECISION[scope], reply.message);
      }
      if (ask.kind === 'question' && reply.kind === 'question') {
        const form = p.forms.find((x) => x.id === ask.stableId);
        if (!form) return 'gone';
        // external の欄がある form は、hangar では答えられない（TUI で開く）。
        if (form.fields.some((x) => x.type !== undefined && !['string', 'number', 'integer', 'boolean', 'multiselect'].includes(x.type))) return 'unreachable';
        const settled = settleAnswers(ask, reply.answers);
        const answer: Record<string, string | number | boolean | string[]> = {};
        for (const f of form.fields) {
          const raw = settled[f.key];
          if (raw === undefined) continue;
          const v = valueOf(f, raw);
          if (v === undefined) return 'unreachable';
          answer[f.key] = v;
        }
        return p.client.replyForm(form.sessionID, form.id, answer);
      }
      return 'gone';
    },
  };
}
