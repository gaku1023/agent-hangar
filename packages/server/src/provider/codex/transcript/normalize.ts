import type { Attachment, TranscriptEvent } from '@agent-hangar/shared';
import type { RecordFacts } from '../../../agent/types.ts';
import { toolSummary } from '../../claude-code/transcript/normalize.ts';

// Codex の rollout（jsonl）の形を知っているのはこのファイルだけである。
// 1 行で決まる純関数にしてある。読み直し（page.ts）が、索引のバイト位置の 1 行だけをもう一度ここに通すためである。
// 発話の正は response_item で、event_msg は発話を作らない。トークンの正は paginated では token_usage_record、legacy では token_count である。

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** rollout の保存の形。session_meta の history_mode で決まる（無ければ legacy）。 */
export type CodexMode = 'legacy' | 'paginated';
export type CodexCtx = { mode: CodexMode };

/** session_meta の行から、その rollout の保存の形を読む。 */
export function modeOfSessionMeta(raw: unknown): CodexMode {
  const p = isRec(raw) && isRec(raw.payload) ? raw.payload : null;
  return p?.history_mode === 'paginated' ? 'paginated' : 'legacy';
}

/** 中身を読まず、イベントも作らずに捨てる行の種類（巨大で、会話の本文は別の行にある）。 */
export const DROPPED_LINE_TYPES: ReadonlySet<string> = new Set(['world_state']);
/** response_item のうち、同じ理由で捨てる種類。 */
export const DROPPED_ITEM_TYPES: ReadonlySet<string> = new Set(['additional_tools']);

/** 発話の写しや区切りの印で、会話の本文を作らない event_msg。ts だけ事実に残る。 */
const SILENT_EVENTS: ReadonlySet<string> = new Set([
  'item_completed', 'user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'agent_reasoning_section_break',
  'thread_settings_applied', 'task_started', 'exec_command_begin', 'exec_command_end', 'exec_command_output_delta', 'mcp_tool_call_begin', 'mcp_tool_call_end',
  'patch_apply_begin', 'patch_apply_end', 'context_compacted', 'thread_name_updated',
]);

/**
 * Codex が user として書くが、利用者の発言ではない本文の書き出し（環境の文脈、指示、中断の印など）。
 * Claude の LOCAL_COMMAND_TAGS と同じ作りで、user の本文がこれらで始まるものを system として扱う。
 */
export const CODEX_INJECTED_PREFIXES: readonly string[] = [
  '<environment_context>', '<user_instructions>', '<turn_aborted>', '<permissions', '<collaboration_mode>', '<skills_instructions>',
  '<apps_instructions>', '<plugins_instructions>', '<user_shell_command>', '<subagent_notification>', '<model_switch>', '# AGENTS.md instructions',
];

const RESULT_MAX = 8 * 1024;
const COMPACTED_MAX = 2000;
const INJECTED_MAX = 200;
const UNKNOWN_MAX = 1024;

function parseTs(raw: Rec): number | undefined {
  const t = raw.timestamp;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') { const n = Date.parse(t); return Number.isNaN(n) ? undefined : n; }
  return undefined;
}

/** content（input_text、output_text の配列）の本文と、画像。 */
function contentParts(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const b of content) {
    if (!isRec(b)) continue;
    if ((b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'input_image' || b.type === 'image') images++;
  }
  return { text: texts.join('\n'), images };
}

/** function_call_output などの output（文字列か input_text の配列）を本文にする。 */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentParts(output).text;
  if (isRec(output)) return str(output.content) ?? str(output.output) ?? '';
  return '';
}

/** この user の発言は注入された文脈か。書き出しのタグで見分け、paginated のメタデータが「利用者の入力ではない」と言うものも含める。 */
function isInjectedUser(payload: Rec, text: string): boolean {
  const head = text.trimStart();
  if (CODEX_INJECTED_PREFIXES.some((p) => head.startsWith(p))) return true;
  const meta = payload.internal_chat_message_metadata_passthrough;
  const kinds = isRec(meta) ? meta.content_item_kinds : undefined;
  return Array.isArray(kinds) && kinds.length > 0 && !kinds.some((k) => typeof k === 'string' && k.startsWith('user.'));
}

/** 未知の行を meta に残すときの浅い写し。1KB に収める。 */
function shallow(payload: unknown): unknown {
  if (!isRec(payload)) return payload === undefined ? {} : { value: String(payload).slice(0, 200) };
  const out: Rec = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length}]`;
    else out[k] = '{…}';
  }
  const s = JSON.stringify(out);
  return s.length <= UNKNOWN_MAX ? out : { truncated: s.slice(0, UNKNOWN_MAX - 20) };
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw); } catch { return raw; }
}

const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 120);

/** apply_patch の本文から、最初に触るファイル。 */
function patchFilePath(patch: string): string | undefined {
  const m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch);
  return m ? m[1]!.trim() : undefined;
}

/** code mode の exec（JS）が tools.exec_command を 1 回だけ呼ぶなら、その cmd。 */
function singleExecCommand(js: string): string | null {
  if ((js.match(/tools\.exec_command\b/g) ?? []).length !== 1) return null;
  const m = /tools\.exec_command\(\s*\{[^}]*?\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/s.exec(js);
  if (!m) return null;
  const lit = m[1]!;
  if (lit.startsWith('"')) { try { return JSON.parse(lit) as string; } catch { return null; } }
  return lit.slice(1, -1).replace(/\\(.)/g, '$1');
}

type ToolCall = Extract<TranscriptEvent, { kind: 'tool_call' }>;

/** Codex の道具を hangar の語彙（EDIT_TOOLS と toolSummary が読む名前）にそろえる。 */
function toolCallOf(seq: number, ts: number | undefined, toolId: string, name: string, namespace: string | undefined, input: unknown): ToolCall {
  if (namespace && namespace.startsWith('mcp__')) {
    const full = namespace.endsWith('__') ? `${namespace}${name}` : `${namespace}__${name}`;
    return { kind: 'tool_call', seq, ts, toolId, name: full, input, summary: toolSummary(full, input) };
  }
  const args = isRec(input) ? input : {};
  switch (name) {
    case 'shell': case 'shell_command': case 'exec_command': case 'container.exec': {
      const c = args.cmd ?? args.command;
      const command = Array.isArray(c) ? c.map(String).join(' ') : typeof c === 'string' ? c : typeof input === 'string' ? input : '';
      const bash: Rec = { command };
      const wd = str(args.workdir); if (wd) bash.workdir = wd;
      return { kind: 'tool_call', seq, ts, toolId, name: 'Bash', input: bash, summary: toolSummary('Bash', bash) };
    }
    case 'apply_patch': {
      const patch = typeof input === 'string' ? input : str(args.input) ?? str(args.patch) ?? '';
      const filePath = patchFilePath(patch);
      const ev: ToolCall = { kind: 'tool_call', seq, ts, toolId, name: 'Edit', input: patch, summary: filePath ? `Edit ${filePath}` : 'Edit' };
      if (filePath) ev.filePath = filePath;
      return ev;
    }
    case 'exec': {
      const js = typeof input === 'string' ? input : '';
      const cmd = singleExecCommand(js);
      if (cmd !== null) { const bash = { command: cmd }; return { kind: 'tool_call', seq, ts, toolId, name: 'Bash', input: bash, summary: toolSummary('Bash', bash) }; }
      const head = firstLine(js);
      return { kind: 'tool_call', seq, ts, toolId, name: 'exec', input, summary: head ? `exec ${head}` : 'exec' };
    }
    case 'update_plan': return { kind: 'tool_call', seq, ts, toolId, name: 'TodoWrite', input, summary: 'TodoWrite' };
    case 'view_image': {
      const p = str(args.path) ?? str(args.file_path);
      const v: Rec = p ? { file_path: p } : {};
      const ev: ToolCall = { kind: 'tool_call', seq, ts, toolId, name: 'Read', input: v, summary: toolSummary('Read', v) };
      if (p) ev.filePath = p;
      return ev;
    }
    default: return { kind: 'tool_call', seq, ts, toolId, name, input, summary: toolSummary(name, input) };
  }
}

function toolResultOf(seq: number, ts: number | undefined, p: Rec): TranscriptEvent {
  const text = outputText(p.output).slice(0, RESULT_MAX);
  const head = text.trimStart().toLowerCase();
  return { kind: 'tool_result', seq, ts, toolId: str(p.call_id) ?? '', text, isError: head.startsWith('tool call error') || head.startsWith('error:') };
}

function itemEvents(p: Rec, seq: number, ts: number | undefined): TranscriptEvent[] {
  switch (p.type) {
    case 'message': {
      const { text, images } = contentParts(p.content);
      if (p.role === 'assistant') return text === '' ? [] : [{ kind: 'assistant', seq, ts, text }];
      if (p.role !== 'user') return [];
      if (isInjectedUser(p, text)) return [{ kind: 'system', seq, ts, text: text.slice(0, INJECTED_MAX), subtype: 'injected_context' }];
      if (text === '' && images === 0) return [];
      const ev: Extract<TranscriptEvent, { kind: 'user' }> = { kind: 'user', seq, ts, text };
      if (images > 0) ev.attachments = Array.from({ length: images }, (): Attachment => ({ kind: 'image' }));
      return [ev];
    }
    case 'reasoning': {
      const parts = [...(Array.isArray(p.summary) ? p.summary : []), ...(Array.isArray(p.content) ? p.content : [])];
      const text = parts.filter(isRec).map((b) => str(b.text) ?? '').filter(Boolean).join('\n');
      return text === '' ? [] : [{ kind: 'thinking', seq, ts, text }];
    }
    case 'function_call':
      return [toolCallOf(seq, ts, str(p.call_id) ?? '', str(p.name) ?? 'tool', str(p.namespace), parseArgs(p.arguments))];
    case 'custom_tool_call':
      return [toolCallOf(seq, ts, str(p.call_id) ?? '', str(p.name) ?? 'tool', str(p.namespace), typeof p.input === 'string' ? p.input : p.input ?? '')];
    case 'function_call_output': case 'custom_tool_call_output':
      return [toolResultOf(seq, ts, p)];
    case 'local_shell_call': {
      const a = isRec(p.action) ? p.action : {};
      return [toolCallOf(seq, ts, str(p.call_id) ?? str(p.id) ?? '', 'shell', undefined, { command: a.command ?? '' })];
    }
    case 'web_search_call': {
      const a = isRec(p.action) ? p.action : {};
      const input = { query: str(a.query) ?? '' };
      return [{ kind: 'tool_call', seq, ts, toolId: str(p.id) ?? `web_search_${seq}`, name: 'WebSearch', input, summary: toolSummary('WebSearch', input) }];
    }
    default:
      if (typeof p.type === 'string' && DROPPED_ITEM_TYPES.has(p.type)) return [];
      return [{ kind: 'meta', seq, ts, name: `response_item:${str(p.type) ?? ''}`, value: shallow(p) }];
  }
}

function eventMsgEvents(p: Rec, seq: number, ts: number | undefined): TranscriptEvent[] {
  const t = str(p.type) ?? '';
  switch (t) {
    case 'task_complete': {
      const ms = num(p.duration_ms);
      return [{ kind: 'system', seq, ts, text: ms === undefined ? 'turn_duration' : (ms / 1000).toFixed(1), subtype: 'turn_duration' }];
    }
    case 'turn_aborted': return [{ kind: 'system', seq, ts, text: str(p.reason) ?? 'turn_aborted', subtype: 'turn_aborted' }];
    case 'token_count': {
      const rl = p.rate_limits;
      if (!isRec(rl) || !isRec(rl.primary)) return [];
      const info = isRec(p.info) ? p.info : {};
      return [{ kind: 'meta', seq, ts, name: 'rate_limits', value: { rate_limits: rl, model_context_window: num(info.model_context_window) ?? null } }];
    }
    default:
      if (SILENT_EVENTS.has(t)) return [];
      return [{ kind: 'meta', seq, ts, name: `event_msg:${t}`, value: shallow(p) }];
  }
}

/**
 * rollout の 1 行を、正規化イベントにする。seqStart はその行から出る最初のイベントの seq である。
 * 行の前後は見ない。同じ発話や同じトークンを写した行（event_msg の写しなど）は、行の種類だけで常にイベントを作らない。
 * 3 つ目の引数は agentId（Claude のサブエージェント用）で、Codex は使わない。
 */
export function normalizeCodexRecord(raw: unknown, seqStart: number, _agentId?: string | null): TranscriptEvent[] {
  if (!isRec(raw)) return [];
  const type = str(raw.type);
  if (type === undefined) return [];
  const ts = parseTs(raw);
  const p = isRec(raw.payload) ? raw.payload : {};
  switch (type) {
    case 'response_item': return itemEvents(p, seqStart, ts);
    case 'event_msg': return eventMsgEvents(p, seqStart, ts);
    case 'token_usage_record': return [];
    case 'session_meta': {
      const value: Rec = {};
      for (const k of ['id', 'cwd', 'originator', 'cli_version', 'source', 'model_provider', 'history_mode']) if (p[k] !== undefined) value[k] = p[k];
      return [{ kind: 'meta', seq: seqStart, ts, name: 'session_meta', value }];
    }
    case 'turn_context': {
      const value: Rec = {};
      for (const k of ['turn_id', 'model', 'effort', 'cwd', 'approval_policy']) if (p[k] !== undefined) value[k] = p[k];
      if (isRec(p.sandbox_policy) && p.sandbox_policy.type !== undefined) value.sandbox = p.sandbox_policy.type;
      return [{ kind: 'meta', seq: seqStart, ts, name: 'turn_context', value }];
    }
    case 'compacted': {
      const text = (str(p.message) ?? '').slice(0, COMPACTED_MAX);
      return [{ kind: 'system', seq: seqStart, ts, text: text || 'compacted', subtype: 'compacted' }];
    }
    default:
      if (DROPPED_LINE_TYPES.has(type)) return [];
      return [{ kind: 'meta', seq: seqStart, ts, name: `${type}:${str(p.type) ?? ''}`, value: shallow(p) }];
  }
}

/** 1 回の API 呼び出しの使用量。input は cached を含む量なので、cached を引いたものを入力とする。reasoning は output の内数なので足さない。 */
function usageOf(u: unknown): { usage: { input: number; output: number }; context: number } | undefined {
  if (!isRec(u)) return undefined;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return { usage: { input: Math.max(0, input - (num(u.cached_input_tokens) ?? 0)), output }, context: input };
}

/**
 * 1 行から読める事実。ctx.mode は rollout の保存の形で、トークンの出どころを切る。
 * paginated は token_usage_record だけ、legacy は token_count だけから足す（同じ呼び出しが両方に出るので、二重に数えない）。
 */
export function codexRecordFacts(raw: unknown, ctx: CodexCtx): RecordFacts {
  const facts: RecordFacts = { isUserTurn: false };
  if (!isRec(raw)) return facts;
  const ts = parseTs(raw); if (ts !== undefined) facts.ts = ts;
  const p = isRec(raw.payload) ? raw.payload : {};
  switch (raw.type) {
    case 'session_meta': { const cwd = str(p.cwd); if (cwd) facts.cwd = cwd; break; }
    case 'turn_context': {
      const cwd = str(p.cwd); if (cwd) facts.cwd = cwd;
      const model = str(p.model); if (model) { facts.model = model; facts.modelSelected = true; }
      const effort = str(p.effort); if (effort) facts.effort = effort;
      break;
    }
    case 'response_item': {
      if (p.type === 'message' && p.role === 'user') {
        const { text, images } = contentParts(p.content);
        facts.isUserTurn = !isInjectedUser(p, text) && !(text === '' && images === 0);
      }
      break;
    }
    case 'event_msg': {
      if (p.type === 'task_started') { const w = num(p.model_context_window); if (w !== undefined) facts.contextSize = w; }
      else if (p.type === 'thread_settings_applied') { const s = isRec(p.thread_settings) ? str(p.thread_settings.cwd) : undefined; if (s) facts.cwd = s; }
      else if (p.type === 'token_count' && ctx.mode === 'legacy') {
        const u = usageOf(isRec(p.info) ? p.info.last_token_usage : undefined);
        if (u) { facts.usage = u.usage; facts.contextTokens = u.context; }
      }
      break;
    }
    case 'token_usage_record': {
      if (ctx.mode === 'paginated') {
        const u = usageOf(p.usage);
        if (u) { facts.usage = u.usage; facts.contextTokens = u.context; }
      }
      break;
    }
  }
  return facts;
}
