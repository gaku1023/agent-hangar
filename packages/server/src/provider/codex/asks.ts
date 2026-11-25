import type { PermissionAskDto } from '@agent-hangar/shared';
import type { AgentAsk, AskSource } from '../../agent/types.ts';
import type { QuestionHook } from '../claude-code/hooks/question.ts';
import type { AgentAskChoice, AgentAskQuestion } from '../../agent/pendingAsk.ts';
import type { CodexServerRequest } from './appServer.ts';

/**
 * Codex の許可と質問の面（docs/design.md「Codex の状態と許可」）。
 * 承認と質問は、app-server が購読した接続へ送ってくるサーバからの要求（`item/commandExecution/requestApproval` など）である。
 * hangar の接続は答えない（答えは TUI で行う）。ここは要求の中身を、画面の札と agent/waiting.ts の語彙の形に直すだけにする。
 * 許可の道具の名前は Claude に合わせる（命令は `Bash`、ファイルの変更は `Edit`、権限の追加は `Permissions`）。質問は AskUserQuestion の hook と同じ形で流す。
 */

/** 要求の生の中身。id は hangar の接続での JSON-RPC の id（答えを書くときに要る。接続し直すと変わるので札の名前には使わない）。 */
export type CodexRawRequest = { id: string | number; method: string; params: Record<string, unknown> };

type CodexPendingBase = {
  /** JSON-RPC の要求の ID を文字列にしたもの。serverRequest/resolved の requestId と合わせる。 */
  key: string;
  threadId: string;
  /** 接続に依らない札の名前（approvalId か itemId）。 */
  stableId: string;
  raw: CodexRawRequest;
};

/** 待っている要求 1 つ。 */
export type CodexPending =
  | (CodexPendingBase & { kind: 'permission'; ask: PermissionAskDto; choices: AgentAskChoice[] })
  | (CodexPendingBase & { kind: 'question'; toolId: string; question: string | null; questions: AgentAskQuestion[] });

/** 許可の選択肢の文言（仮。後で Gemini に当てる）。 */
export const CODEX_CHOICE_TEXT = {
  once: { label: '1 回だけ許可', description: 'この実行だけを許可します。' },
  session: { label: 'この会話中のみ許可', description: 'この会話が終わるまで、同じ種類の操作を許可します。' },
  deny: { label: '許可せず続行', description: '実行せずに、作業を続けさせます。' },
  cancel: { label: '許可せず中断', description: '実行せずに、作業を止めます。' },
} as const;
/** 承認の要求のあと、ほかの接続が答えるまでの質問の見出し。MCP の問い合わせの選択肢の文言（仮）。 */
export const CODEX_ELICITATION_TEXT = {
  accept: { label: '承認する' },
  decline: { label: '断る' },
  cancel: { label: 'キャンセル' },
} as const;

const CHOICE_BY_DECISION: Record<string, 'once' | 'session' | 'deny' | 'cancel'> = { accept: 'once', acceptForSession: 'session', decline: 'deny', cancel: 'cancel' };
const SCOPE_OF_CHOICE = { once: 'once', session: 'session', deny: 'deny', cancel: 'deny-stop' } as const;
const permissionChoice = (k: keyof typeof SCOPE_OF_CHOICE): AgentAskChoice => ({ key: k, label: CODEX_CHOICE_TEXT[k].label, description: CODEX_CHOICE_TEXT[k].description, scope: SCOPE_OF_CHOICE[k] });

/**
 * 命令とファイルの変更の許可の選択肢。要求に選べる決定の一覧（availableDecisions。0.171 の schema には無いが、あれば従う）があればそれに沿い、
 * 無ければ once・session・deny・cancel の 4 つ。acceptWithExecpolicyAmendment と applyNetworkPolicyAmendment は出さない（一覧に文字列でないものは捨てる）。
 */
export function codexDecisionChoices(params: Record<string, unknown>): AgentAskChoice[] {
  const list = Array.isArray(params.availableDecisions) ? params.availableDecisions : null;
  if (list) {
    const picked: ('once' | 'session' | 'deny' | 'cancel')[] = [];
    for (const d of list) {
      const c = typeof d === 'string' ? CHOICE_BY_DECISION[d] : undefined;
      if (c && !picked.includes(c)) picked.push(c);
    }
    if (picked.length > 0) return picked.map(permissionChoice);
  }
  return (['once', 'session', 'deny', 'cancel'] as const).map(permissionChoice);
}

/** 権限の追加の選択肢。決定は 3 つだけ（中断は無い）。 */
const PERMISSIONS_CHOICES = (): AgentAskChoice[] => (['once', 'session', 'deny'] as const).map(permissionChoice);

/** requestUserInput の問い 1 つ。選択肢の key は番号（1 から）。isOther は自由記述を許す。選択肢が無ければ自由記述。 */
function userInputQuestion(q: Record<string, unknown>, index: number): AgentAskQuestion {
  const options = Array.isArray(q.options) ? q.options.map(rec).filter((o) => str(o.label) !== null) : [];
  const out: AgentAskQuestion = {
    id: str(q.id) ?? String(index + 1),
    text: str(q.question) ?? str(q.header) ?? '',
    kind: options.length > 0 ? 'choice' : 'text',
    options: options.map((o, i): AgentAskChoice => {
      const c: AgentAskChoice = { key: String(i + 1), label: str(o.label)! };
      const d = str(o.description);
      if (d !== null) c.description = d;
      return c;
    }),
    multi: false,
    allowText: options.length === 0 || q.isOther === true,
    required: true,
  };
  const header = str(q.header);
  if (header !== null) out.header = header;
  if (q.isSecret === true) out.secret = true;
  return out;
}

/** MCP の問い合わせ。欄のあるもの（form の requestedSchema に properties がある、openai の form、url）は答えない。無いものは承認・断る・キャンセルの 3 択。 */
function elicitationQuestion(p: Record<string, unknown>): AgentAskQuestion {
  const text = str(p.message) ?? str(p.serverName) ?? '';
  const schema = rec(p.requestedSchema);
  const hasFields = p.mode !== 'form' || Object.keys(rec(schema.properties)).length > 0;
  return {
    id: 'action',
    text,
    kind: hasFields ? 'external' : 'choice',
    options: hasFields ? [] : (['accept', 'decline', 'cancel'] as const).map((k): AgentAskChoice => ({ key: k, label: CODEX_ELICITATION_TEXT[k].label })),
    multi: false,
    allowText: false,
    required: true,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 権限の追加の中身を、行ごとの文にする（network、書く場所、読む場所）。分からなければ cwd。 */
export function permissionsText(params: Record<string, unknown>): string {
  const p = rec(params.permissions);
  const lines: string[] = [];
  if (rec(p.network).enabled === true) lines.push('network');
  const fs = rec(p.fileSystem);
  const write = strs(fs.write);
  const read = strs(fs.read);
  if (write.length) lines.push(`write ${write.join(', ')}`);
  if (read.length) lines.push(`read ${read.join(', ')}`);
  return lines.length ? lines.join('\n') : (str(params.cwd) ?? '');
}

/** サーバからの要求を、待ちの 1 件にする。承認と質問でない要求、threadId の無い値は null。入口の値は形を信じない。 */
export function codexPendingOf(r: CodexServerRequest): CodexPending | null {
  const p = rec(r.params);
  const threadId = str(p.threadId);
  if (threadId === null) return null;
  const key = String(r.id);
  const base = { key, threadId, raw: { id: r.id, method: r.method, params: p } };
  switch (r.method) {
    case 'item/commandExecution/requestApproval':
      return { ...base, stableId: str(p.approvalId) ?? str(p.itemId) ?? key, kind: 'permission', ask: { tool: 'Bash', input: str(p.command) ?? '', description: str(p.reason) }, choices: codexDecisionChoices(p) };
    case 'item/fileChange/requestApproval':
      return { ...base, stableId: str(p.itemId) ?? key, kind: 'permission', ask: { tool: 'Edit', input: str(p.grantRoot) ?? '', description: str(p.reason) }, choices: codexDecisionChoices(p) };
    case 'item/permissions/requestApproval':
      return { ...base, stableId: str(p.itemId) ?? key, kind: 'permission', ask: { tool: 'Permissions', input: permissionsText(p), description: str(p.reason) }, choices: PERMISSIONS_CHOICES() };
    case 'item/tool/requestUserInput': {
      const qs = Array.isArray(p.questions) ? p.questions.map(rec) : [];
      const q = qs[0] ?? {};
      return { ...base, stableId: str(p.itemId) ?? key, kind: 'question', toolId: str(p.itemId) ?? key, question: str(q.question) ?? str(q.header), questions: qs.map(userInputQuestion) };
    }
    case 'mcpServer/elicitation/request':
      return { ...base, stableId: `elicitation:${str(p.turnId) ?? ''}:${str(p.serverName) ?? ''}:${str(p.message) ?? ''}`, kind: 'question', toolId: `elicitation-${key}`, question: str(p.message) ?? str(p.serverName), questions: [elicitationQuestion(p)] };
    default:
      return null;
  }
}

/** 質問が出たことを、Claude の AskUserQuestion の hook と同じ形にする（sessions/questionHook.ts がそのまま書ける）。 */
export function codexQuestionAsked(providerSessionId: string, q: Extract<CodexPending, { kind: 'question' }>): QuestionHook {
  return { kind: 'asked', providerSessionId, toolId: q.toolId, summary: q.question ?? '', question: q.question };
}

/** 許可と質問を流してくる口。状態の面（live.ts の CodexLive）が持つ。 */
export type CodexAskFeed = { onAsk(cb: (a: AgentAsk) => void): () => void };

/** Codex の許可と質問の面。hook は読まない（parseHook を持たない）。 */
export function codexAsks(feed: CodexAskFeed): AskSource {
  return { subscribe: (cb) => feed.onAsk(cb) };
}
