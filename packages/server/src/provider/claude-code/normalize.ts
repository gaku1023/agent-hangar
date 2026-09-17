import type { Attachment, TranscriptEvent } from '@agent-hangar/shared';

// Claude Code の jsonl の形を知っているのはこのファイルだけである。
// ここで TranscriptEvent に正規化し、UI や索引には元の形を渡さない。

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export type RecordFacts = {
  cwd?: string; ts?: number; model?: string; effort?: string;
  usage?: { input: number; output: number };
  aiTitle?: string; customTitle?: string; agentName?: string; prUrl?: string;
  isUserTurn: boolean;
};

function parseTs(raw: Rec): number | undefined {
  const t = raw.timestamp;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') { const n = Date.parse(t); return Number.isNaN(n) ? undefined : n; }
  return undefined;
}

/** tool_result などの content（文字列か text ブロックの配列）を本文にする。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isRec).map((b) => (b.type === 'text' ? str(b.text) ?? '' : '')).filter(Boolean).join('\n');
}

/**
 * スラッシュコマンドやローカルコマンドの記録は、Claude Code が user として書くが利用者の発言ではない。
 * 本文がこれらのタグで始まるものを見分け、system として扱う。
 */
const LOCAL_COMMAND_TAGS = ['<command-name>', '<command-message>', '<command-args>', '<local-command-caveat>', '<local-command-stdout>', '<system-reminder>'];

export function isLocalCommandText(text: string): boolean {
  const head = text.trimStart();
  return LOCAL_COMMAND_TAGS.some((tag) => head.startsWith(tag));
}

export function pickFilePath(input: unknown): string | undefined {
  if (!isRec(input)) return undefined;
  return str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
}

export function toolSummary(name: string, input: unknown): string {
  const fp = pickFilePath(input);
  if (fp) return `${name} ${fp}`;
  if (!isRec(input)) return name;
  const command = str(input.command);
  if (command) return `${name} ${(command.split('\n')[0] ?? '').slice(0, 120)}`;
  const tail = str(input.pattern) ?? str(input.query) ?? str(input.skill) ?? str(input.url) ?? str(input.description);
  return tail ? `${name} ${tail.slice(0, 120)}` : name;
}

export function normalizeRecord(raw: unknown, seqStart: number, _agentId: string | null): TranscriptEvent[] {
  if (!isRec(raw)) return [];
  const type = str(raw.type) ?? 'unknown';
  const ts = parseTs(raw);
  const msg = isRec(raw.message) ? raw.message : null;
  let seq = seqStart;

  if (type === 'user' && msg) {
    const content = msg.content;
    if (raw.isMeta === true || isLocalCommandText(contentText(content))) return [{ kind: 'system', seq, ts, text: contentText(content) }];
    if (typeof content === 'string') return [{ kind: 'user', seq, ts, text: content }];
    if (!Array.isArray(content)) return [];
    const texts: string[] = [];
    const attachments: Attachment[] = [];
    const results: Omit<Extract<TranscriptEvent, { kind: 'tool_result' }>, 'seq'>[] = [];
    for (const b of content.filter(isRec)) {
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'image') attachments.push({ kind: 'image' });
      else if (b.type === 'document') attachments.push({ kind: 'file', name: str(b.title) ?? str(b.name) });
      else if (b.type === 'tool_result') results.push({ kind: 'tool_result', ts, toolId: str(b.tool_use_id) ?? '', text: contentText(b.content), isError: b.is_error === true });
    }
    // user を先に置き、tool_result はその後ろに並べて seq を振る。
    const out: TranscriptEvent[] = [];
    if (texts.length > 0 || attachments.length > 0) {
      const ev: Extract<TranscriptEvent, { kind: 'user' }> = { kind: 'user', seq: seq++, ts, text: texts.join('\n') };
      if (attachments.length > 0) ev.attachments = attachments;
      out.push(ev);
    }
    for (const r of results) out.push({ ...r, seq: seq++ });
    return out;
  }

  if (type === 'assistant' && msg && Array.isArray(msg.content)) {
    const model = str(msg.model);
    const out: TranscriptEvent[] = [];
    for (const b of msg.content.filter(isRec)) {
      if (b.type === 'text') { const ev: Extract<TranscriptEvent, { kind: 'assistant' }> = { kind: 'assistant', seq: seq++, ts, text: str(b.text) ?? '' }; if (model) ev.model = model; out.push(ev); }
      else if (b.type === 'thinking') out.push({ kind: 'thinking', seq: seq++, ts, text: str(b.thinking) ?? '' });
      else if (b.type === 'tool_use') {
        const name = str(b.name) ?? 'tool';
        const ev: Extract<TranscriptEvent, { kind: 'tool_call' }> = { kind: 'tool_call', seq: seq++, ts, toolId: str(b.id) ?? '', name, input: b.input, summary: toolSummary(name, b.input) };
        const fp = pickFilePath(b.input); if (fp) ev.filePath = fp;
        out.push(ev);
      }
    }
    return out;
  }

  if (type === 'system') return [{ kind: 'system', seq, ts, text: str(raw.subtype) ?? 'system' }];

  // 知らない type は捨てずに meta として残す。
  const { type: _t, sessionId: _s, ...rest } = raw;
  return [{ kind: 'meta', seq, ts, name: type, value: rest }];
}

export function recordFacts(raw: unknown): RecordFacts {
  const facts: RecordFacts = { isUserTurn: false };
  if (!isRec(raw)) return facts;
  const cwd = str(raw.cwd); if (cwd) facts.cwd = cwd;
  const ts = parseTs(raw); if (ts !== undefined) facts.ts = ts;
  const msg = isRec(raw.message) ? raw.message : null;
  switch (raw.type) {
    case 'assistant': {
      const model = str(msg?.model); if (model) facts.model = model;
      const effort = str(raw.effort); if (effort) facts.effort = effort;
      const u = isRec(msg?.usage) ? msg.usage : null;
      if (u) facts.usage = { input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), output: num(u.output_tokens) };
      break;
    }
    case 'user': {
      if (raw.isMeta === true || !msg) break;
      const c = msg.content;
      const hasText = typeof c === 'string' || (Array.isArray(c) && c.some((b) => isRec(b) && b.type === 'text'));
      facts.isUserTurn = hasText && !isLocalCommandText(contentText(c));
      break;
    }
    case 'ai-title': { const v = str(raw.aiTitle); if (v) facts.aiTitle = v; break; }
    case 'custom-title': { const v = str(raw.customTitle); if (v) facts.customTitle = v; break; }
    case 'agent-name': { const v = str(raw.agentName); if (v) facts.agentName = v; break; }
    case 'pr-link': { const v = str(raw.prUrl); if (v) facts.prUrl = v; break; }
  }
  return facts;
}

export type IndexText = { seq: number; role: 'user' | 'assistant' | 'tool'; text: string };

export function indexTexts(events: TranscriptEvent[]): IndexText[] {
  const out: IndexText[] = [];
  for (const e of events) {
    if (e.kind === 'user' && e.text) out.push({ seq: e.seq, role: 'user', text: e.text });
    else if (e.kind === 'assistant' && e.text) out.push({ seq: e.seq, role: 'assistant', text: e.text });
    else if (e.kind === 'tool_call') {
      const command = isRec(e.input) ? str(e.input.command) : undefined;
      out.push({ seq: e.seq, role: 'tool', text: command ? `${e.summary}\n${command}` : e.summary });
    }
  }
  return out;
}
