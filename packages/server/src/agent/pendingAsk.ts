import { createHash } from 'node:crypto';
import { PEER_CHAT_ASK_HEADER_MAX_BYTES, type PeerChatAsk, type PeerChatAskStep } from '@agent-hangar/shared';

/**
 * Codex と opencode の札（許可と質問）の、共通の形と純粋な関数。
 * provider ごとの読み書き（要求の解析、API への応答）は、この層の外にある。
 * ここは、AgentPendingAsk と、元の PC が貯めた答えから、いま見せる 1 枚の PeerChatAsk を作る。
 * 答えの検査（checkAnswer）も、見る側と元の PC の両方が同じ規則で通す。
 */

export type AgentAskChoice = {
  /** 意味のキー。許可は 'once' | 'session' | 'deny' | 'cancel'、質問は選択肢の value か番号。 */
  key: string;
  label: string;
  description?: string;
  /** 許可の種類（統括の policy は 'once' だけ押せる）。 */
  scope?: 'once' | 'session' | 'deny' | 'deny-stop';
};

export type AgentAskWhen = { key: string; op: 'eq' | 'neq'; value: unknown };

export type AgentAskQuestion = {
  /** Codex は question.id、opencode は field.key。 */
  id: string;
  header?: string;
  text: string;
  kind: 'choice' | 'text' | 'number' | 'integer' | 'boolean' | 'external';
  options: AgentAskChoice[];
  multi: boolean;
  allowText: boolean;
  secret?: true;
  required: boolean;
  default?: unknown;
  when?: AgentAskWhen[];
  hidden?: true;
  min?: number;
  max?: number;
  minItems?: number;
  maxItems?: number;
};

export type AgentPendingAsk = {
  provider: 'codex' | 'opencode';
  /** 札の安定した名前（Codex は approvalId か itemId、opencode は permission id か form id）。askId の種。接続の id は入れない。 */
  stableId: string;
  /** API で答えるのに要るもの。無ければ API では答えられない（画面の道へ）。 */
  api: { requestKey: string; method: string } | null;
  kind: 'permission' | 'question';
  tool?: string;
  input?: string;
  description?: string | null;
  /** 許可の選択肢。 */
  choices: AgentAskChoice[];
  /** 質問（質問の札は 1 つ以上）。 */
  questions: AgentAskQuestion[];
};

export type AgentAskReply =
  | { kind: 'permission'; choice: AgentAskChoice['scope']; message?: string }
  | { kind: 'question'; answers: Record<string, AgentAnswerValue> };

export type AgentAskPort = {
  current(sessionId: string): AgentPendingAsk | null;
  /** 'ok'＝確定、'gone'＝もう解かれていた、'unreachable'＝API で届かない（画面の道へ落とす）。 */
  answer(sessionId: string, ask: AgentPendingAsk, reply: AgentAskReply): Promise<'ok' | 'gone' | 'unreachable'>;
};

/** 貯める 1 問の答え。単一選択と自由記述は string、複数選択は string[]、数は number、boolean は boolean。 */
export type AgentAnswerValue = string[] | string | number | boolean;
/** 貯めた答え（問いの id から答え）。 */
export type AgentStoredAnswers = Record<string, AgentAnswerValue>;

/** boolean の問いの選択肢（文言は仮。後で Gemini に当てる）。 */
export const AGENT_BOOLEAN_CHOICES: AgentAskChoice[] = [
  { key: 'true', label: 'はい' },
  { key: 'false', label: 'いいえ' },
];

// ---- askId ----

/**
 * 札の askId。sha256(JSON [kind, provider, stableId, step.index, step.submit]) の先頭 24 桁（16 進）。
 * Claude の peerAskId と同じ作り（sha256 の JSON、先頭 24 桁、step は index と submit）にそろえる。
 * 接続ごとに変わる JSON-RPC の id や requestKey は種にしない。
 * 問いが 1 つか許可の札は step が無く、index は 0、submit は false になる。
 */
export function agentAskId(provider: AgentPendingAsk['provider'], kind: AgentPendingAsk['kind'], stableId: string, step: PeerChatAskStep | undefined): string {
  const parts: unknown[] = [kind, provider, stableId, step?.index ?? 0, step?.submit === true];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

// ---- when ----

/**
 * 値の比べ方。型を合わせてから比べる。
 * 数と文字列と真偽は、型が違えば等しくない（'1' と 1、'true' と true は別）。
 * 配列は順序を問わず、要素ごとに同じ規則で比べる（複数選択の答えのため）。
 * 貯めた答えに無いキーは、eq は偽、neq は真になる（値が無い、は何とも等しくない）。
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const rest = [...b];
    for (const x of a) {
      const i = rest.findIndex((y) => sameValue(x, y));
      if (i < 0) return false;
      rest.splice(i, 1);
    }
    return true;
  }
  return typeof a === typeof b && a === b;
}

/** when の条件は全部（AND）で成り立つか。when が無ければ真。 */
export function evalWhen(when: AgentAskWhen[] | undefined, answers: AgentStoredAnswers): boolean {
  if (!when) return true;
  return when.every((c) => {
    const eq = c.key in answers && sameValue(answers[c.key], c.value);
    return c.op === 'eq' ? eq : !eq;
  });
}

// ---- 手順 ----

/**
 * 貯めた答えのもとで、見せる問いの並び。
 * hidden の問いは常に飛ばす。when が偽の問いも飛ばす。
 * ただし when が参照する問いにまだ答えが無い間は、見せる前提で並べる（答えが入ると並びが縮むことがある）。
 */
export function stepPlan(ask: AgentPendingAsk, answers: AgentStoredAnswers): AgentAskQuestion[] {
  const known: AgentStoredAnswers = { ...answers };
  const plan: AgentAskQuestion[] = [];
  for (const question of ask.questions) {
    if (question.hidden) {
      if (question.default !== undefined) known[question.id] = question.default as AgentAnswerValue;
      continue;
    }
    const undecided = (question.when ?? []).some((c) => !(c.key in known));
    if (undecided || evalWhen(question.when, known)) plan.push(question);
  }
  return plan;
}

/**
 * 最後に API へ送る答え。貯めた答えに、hidden と when が偽の問いの default を入れる。
 * 飛ばした問いに貯めた答えがあれば捨てる。default の無い飛ばした問いは入れない。
 */
export function settleAnswers(ask: AgentPendingAsk, answers: AgentStoredAnswers): AgentStoredAnswers {
  const out: AgentStoredAnswers = { ...answers };
  for (const question of ask.questions) {
    const skipped = question.hidden === true || !evalWhen(question.when, out);
    if (!skipped) continue;
    delete out[question.id];
    if (question.default !== undefined) out[question.id] = question.default as AgentAnswerValue;
  }
  return out;
}

/** いま見せる問いと、そのタブ。全部答え済みなら最後の問い。許可の札や問いが無い札は null。 */
export function currentQuestion(ask: AgentPendingAsk, answers: AgentStoredAnswers): { question: AgentAskQuestion; step: PeerChatAskStep | undefined } | null {
  if (ask.kind !== 'question') return null;
  const plan = stepPlan(ask, answers);
  if (plan.length === 0) return null;
  let i = plan.findIndex((x) => !(x.id in answers));
  if (i < 0) i = plan.length - 1;
  const total = plan.length;
  const step: PeerChatAskStep | undefined = total <= 1 ? undefined : i === total - 1 ? { index: i + 1, total, submit: true } : { index: i + 1, total };
  return { question: plan[i]!, step };
}

// ---- 見せる札 ----

function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > max) out = out.slice(0, -1);
  return out;
}

const toOption = (c: AgentAskChoice): { key: string; label: string; description?: string } =>
  c.description ? { key: c.key, label: c.label, description: c.description } : { key: c.key, label: c.label };

/**
 * いま見せる 1 枚の札（PeerChatAsk）。許可は choices をそのまま、質問は 1 問ずつ。
 * 問いの文は PeerChatAsk に欄が無いので、currentQuestion(...).question.text を項目の text に使う。
 * external の問い、問いが 1 つも見えない質問は answerable: false。
 * 選択肢の数と label の長さの上限は、受け取る側（tail の normalizeOptions）が掛ける。
 */
export function toPeerChatAsk(ask: AgentPendingAsk, answers: AgentStoredAnswers): PeerChatAsk {
  if (ask.kind === 'permission') {
    const out: PeerChatAsk = {
      askId: agentAskId(ask.provider, 'permission', ask.stableId, undefined),
      kind: 'permission',
      options: ask.choices.map(toOption),
      multi: false,
      allowText: false,
    };
    if (ask.tool !== undefined) out.tool = ask.tool;
    if (ask.input !== undefined) out.input = ask.input;
    if (ask.description) out.title = clipBytes(ask.description, PEER_CHAT_ASK_HEADER_MAX_BYTES);
    return out;
  }
  const cur = currentQuestion(ask, answers);
  if (!cur) {
    return { askId: agentAskId(ask.provider, 'question', ask.stableId, undefined), kind: 'question', options: [], multi: false, allowText: false, answerable: false };
  }
  const { question, step } = cur;
  const out: PeerChatAsk = {
    askId: agentAskId(ask.provider, 'question', ask.stableId, step),
    kind: 'question',
    options: (question.kind === 'boolean' ? AGENT_BOOLEAN_CHOICES : question.options).map(toOption),
    multi: question.multi,
    allowText: question.allowText,
  };
  if (ask.tool !== undefined) out.tool = ask.tool;
  // Claude の質問の札と同じく、今の問いの文は input に載せる（手元の帯とホームの行はここから読む）。
  if (question.text) out.input = question.text;
  if (step) out.step = step;
  if (question.header) out.header = clipBytes(question.header, PEER_CHAT_ASK_HEADER_MAX_BYTES);
  if (question.secret) out.secret = true;
  if (question.kind === 'number' || question.kind === 'integer') {
    out.textKind = question.kind;
    if (question.min !== undefined) out.min = question.min;
    if (question.max !== undefined) out.max = question.max;
  }
  if (question.kind === 'external') out.answerable = false;
  return out;
}

// ---- 答えの検査 ----

export type AnswerCheck = { ok: true; value: AgentAnswerValue | undefined } | { ok: false; reason: 'ask-mismatch' };
const bad: AnswerCheck = { ok: false, reason: 'ask-mismatch' };
const NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * 1 問の答え（選んだキーと自由記述）を検査して、貯める値に直す。
 * 合わなければ ask-mismatch。
 * 選択肢にないキー、単一選択で 2 つ以上、複数選択の重なりと minItems・maxItems、数の欄の形・integer・min・max、required を見る。
 * 自由記述は allowText の問い（と数・文字の問い）だけが受ける。
 * required でない問いは、空の答えが通り、値は undefined になる（貯めずに default に任せる）。
 */
export function checkAnswer(question: AgentAskQuestion, keys: string[], text?: string): AnswerCheck {
  const t = text?.trim() ?? '';
  const empty = keys.length === 0 && t === '';
  if (question.kind === 'external') return bad;
  if (empty) return question.required ? bad : { ok: true, value: undefined };
  switch (question.kind) {
    case 'boolean': {
      if (keys.length !== 1) return bad;
      if (keys[0] === 'true') return { ok: true, value: true };
      if (keys[0] === 'false') return { ok: true, value: false };
      return bad;
    }
    case 'number':
    case 'integer': {
      if (keys.length > 0 || !NUMBER_RE.test(t)) return bad;
      const n = Number(t);
      if (!Number.isFinite(n)) return bad;
      if (question.kind === 'integer' && !Number.isInteger(n)) return bad;
      if (question.min !== undefined && n < question.min) return bad;
      if (question.max !== undefined && n > question.max) return bad;
      return { ok: true, value: n };
    }
    case 'text':
      return keys.length === 0 ? { ok: true, value: text ?? '' } : bad;
    case 'choice': {
      const valid = new Set(question.options.map((o) => o.key));
      if (question.multi) {
        if (t !== '' || new Set(keys).size !== keys.length || !keys.every((k) => valid.has(k))) return bad;
        if (keys.length < (question.minItems ?? (question.required ? 1 : 0))) return bad;
        if (question.maxItems !== undefined && keys.length > question.maxItems) return bad;
        return { ok: true, value: keys };
      }
      if (keys.length === 1 && t === '') return valid.has(keys[0]!) ? { ok: true, value: keys[0]! } : bad;
      if (keys.length === 0 && question.allowText) return { ok: true, value: text! };
      return bad;
    }
  }
}
