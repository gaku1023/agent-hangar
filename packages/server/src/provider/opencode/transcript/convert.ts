import type { TranscriptEvent } from '@agent-hangar/shared';
import type { IndexRecord } from '../../../agent/types.ts';
import { pickFilePath, toolSummary, type RecordFacts } from '../../claude-code/transcript/normalize.ts';

/**
 * opencode（2.x）の本文のメッセージを、hangar の共通の形（TranscriptEvent と RecordFacts）に直す（docs/design.md「opencode のトランスクリプト」）。
 * 変換はここ 1 本にする。serve の `/api/session/{id}/message` の写し（source.ts）も、ほかの PC の export を閲覧する写し（段 E3）も、ここを通す。
 *
 * メッセージの形（2.1.4 で確かめた。test/fixtures/opencode/2.1.4/messages.json）：
 * - user：`{ id, type: 'user', time: { created }, text }`
 * - assistant：1 回のモデルの呼び出し（手順）が 1 つ。`content` に reasoning・text・tool が並び、`model`、`tokens`、`cost`、`finish` を持つ。
 *   終わると `time.completed` が付く。interrupt で止まった手順は `error`（type が aborted）を持ち、終わった道具は `state.status` が error になる。
 * - model-switched：会話のモデルの切り替え。`model`（`{ id, providerID }`）と `previous` を持つ。TUI の /models の後の最初の送信で入る。
 * - idle：ターンの終わりの印。`outcome` は succeeded、interrupted など。
 * - system：hangar の外から差し込まれた知らせ（Code Mode の目録の変化など）。`metadata.notice` が種類である。
 *
 * 道具の名前と引数は、hangar の画面と索引が読む共通の形（Claude Code の名前）に直す。
 * 編集したファイルの数（EDIT_TOOLS）、手の表示、問いの「いま」は、その名前と引数の形で読んでいるためである。
 * 直すのは 2.1.4 で形を確かめた道具だけで、ほかは名前と引数をそのまま持つ。
 * Code Mode の `execute` は、中で呼んだ MCP の道具（`metadata.toolCalls`）を、Claude と同じ `mcp__<サーバ>__<道具>` の呼び出しに展開する。
 */

type Rec = Record<string, unknown>;
/** seq を除いたイベント（種類ごとに除く）。 */
type Unseq<T> = T extends unknown ? Omit<T, 'seq'> : never;
type EvIn = Unseq<TranscriptEvent>;
type Call = Extract<TranscriptEvent, { kind: 'tool_call' }>;
type Result = Extract<TranscriptEvent, { kind: 'tool_result' }>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** メッセージの ID。並びの見比べに使う。無ければ null。 */
export function messageIdOf(m: unknown): string | null {
  return isRec(m) && typeof m.id === 'string' && m.id !== '' ? m.id : null;
}

/**
 * 古い順に並べたメッセージのうち、頭から何件が確定しているか（未作成の扱い）。
 * まだ終わっていない返答（`time.completed` の無い assistant）は、まだ無いものとして扱い、そこから後ろは数えない。
 * 写しは続きを足していくだけにするので、変わりうるものを先に写さないためである。
 * ただし、後ろにターンの終わり（idle）があれば、その返答はもう変わらないので確定とする（completed の付かないまま止まった返答で、写しが止まらないように）。
 */
export function settledCount(oldestFirst: readonly unknown[]): number {
  let lastIdle = -1;
  oldestFirst.forEach((m, i) => { if (isRec(m) && m.type === 'idle') lastIdle = i; });
  for (let i = 0; i < oldestFirst.length; i++) {
    const m = oldestFirst[i];
    if (!isRec(m) || m.type !== 'assistant') continue;
    const time = isRec(m.time) ? m.time : {};
    if (typeof time.completed === 'number' || i < lastIdle) continue;
    return i;
  }
  return oldestFirst.length;
}

/** 古い順に並べたメッセージを、束の記録にする。seq は束の中で 0 から通しで振る。 */
export function convertMessages(oldestFirst: readonly unknown[]): IndexRecord[] {
  const out: IndexRecord[] = [];
  let seq = 0;
  for (const m of oldestFirst) {
    const r = convertMessage(m, seq);
    seq += r.events.length;
    out.push(r);
  }
  return out;
}

/** メッセージ 1 つを、記録 1 つにする。seq は seqStart から振る。本文は hangar の DB に持つ（locator は stored）。 */
export function convertMessage(m: unknown, seqStart: number): IndexRecord {
  const facts: RecordFacts = { isUserTurn: false };
  const rec: IndexRecord = { events: [], facts, locator: { kind: 'stored' } };
  if (!isRec(m)) return rec;
  const time = isRec(m.time) ? m.time : {};
  const ts = typeof time.created === 'number' ? time.created : undefined;
  if (ts !== undefined) facts.ts = ts;
  let seq = seqStart;
  const push = (e: EvIn): void => {
    rec.events.push({ ...e, seq: seq++, ...(e.ts !== undefined ? { ts: e.ts } : ts !== undefined ? { ts } : {}) } as TranscriptEvent);
  };

  switch (m.type) {
    case 'user': {
      const text = str(m.text) ?? '';
      push({ kind: 'user', text });
      if (text.trim() !== '') { facts.isUserTurn = true; rec.typedPrompt = true; }
      return rec;
    }
    case 'assistant': {
      const model = modelOf(m.model);
      if (model) facts.model = model;
      for (const b of Array.isArray(m.content) ? m.content.filter(isRec) : []) {
        if (b.type === 'reasoning') push({ kind: 'thinking', text: str(b.text) ?? '' });
        else if (b.type === 'text') push({ kind: 'assistant', text: str(b.text) ?? '', ...(model ? { model } : {}) });
        else if (b.type === 'tool') for (const e of toolEvents(b)) push(e);
      }
      const err = isRec(m.error) ? str(m.error.message) ?? str(m.error.type) : undefined;
      if (err) push({ kind: 'system', subtype: 'error', text: err });
      const t = isRec(m.tokens) ? m.tokens : null;
      if (t) {
        const cache = isRec(t.cache) ? t.cache : {};
        const input = num(t.input) + num(cache.read) + num(cache.write);
        facts.usage = { input, output: num(t.output) + num(t.reasoning) };
        facts.contextTokens = input;
      }
      if (typeof m.cost === 'number' && Number.isFinite(m.cost)) facts.costUsd = m.cost;
      return rec;
    }
    case 'model-switched': {
      // TUI の /models の切り替えは、選んだ後の最初の送信で会話に当たる（2.1.4）。返答を待たずに札を切り替えるため、今の値のモデルとして持つ。
      const model = modelOf(m.model);
      if (model) { facts.model = model; facts.modelSelected = true; }
      const { id: _id, type, time: _time, ...rest } = m;
      push({ kind: 'meta', name: str(type) ?? 'model-switched', value: rest });
      return rec;
    }
    case 'idle':
      // 読む中身の無い印（Claude の turn_duration と同じく、text を subtype と同じにして画面では畳む）。
      push({ kind: 'system', subtype: 'idle', text: 'idle' });
      rec.endsTurn = true;
      return rec;
    case 'system': {
      const meta = isRec(m.metadata) ? m.metadata : {};
      const subtype = str(meta.notice) ?? 'system';
      push({ kind: 'system', subtype, text: str(m.text) || str(m.description) || subtype });
      return rec;
    }
    default: {
      // 知らない種類は捨てずに meta として残す。
      const { id: _id, type, time: _time, ...rest } = m;
      push({ kind: 'meta', name: str(type) ?? 'unknown', value: rest });
      return rec;
    }
  }
}

/** モデルの名前。`provider/model` の形にする（起動のダイアログで選ぶ形と同じ）。 */
export function modelOf(v: unknown): string | undefined {
  if (!isRec(v)) return undefined;
  const id = str(v.id) ?? str(v.modelID);
  const provider = str(v.providerID);
  return id ? (provider ? `${provider}/${id}` : id) : undefined;
}

type Ev = Unseq<Call | Result>;

/** 道具の呼び出し 1 つを、呼び出しと結果のイベントにする。結果は呼び出しのすぐ後に置く。終わっていない道具は呼び出しだけにする。 */
function toolEvents(b: Rec): Ev[] {
  const toolId = str(b.id) ?? '';
  const raw = str(b.name) ?? 'tool';
  const state = isRec(b.state) ? b.state : {};
  const input = state.input;
  const time = isRec(b.time) ? b.time : {};
  const done = typeof time.completed === 'number' ? time.completed : undefined;
  const status = str(state.status);
  const errorText = isRec(state.error) ? str(state.error.message) ?? str(state.error.type) ?? '' : '';
  const outText = textOf(state.content);
  const result = (id: string, text: string, isError: boolean): Omit<Result, 'seq'> => ({ kind: 'tool_result', toolId: id, text, isError, ...(done !== undefined ? { ts: done } : {}) });
  const ended = status === 'completed' || status === 'error';

  // Code Mode の execute は、中で呼んだ MCP の道具に展開する。中の呼び出しには個別の結果が無いので、execute の結果は最後の呼び出しに付ける。
  const inner = raw === 'execute' && isRec(state.metadata) && Array.isArray(state.metadata.toolCalls) ? state.metadata.toolCalls.filter(isRec) : [];
  if (inner.length > 0) {
    return inner.flatMap((c, i): Ev[] => {
      const id = `${toolId}#${i}`;
      const name = mcpName(str(c.tool) ?? 'tool');
      const call: Omit<Call, 'seq'> = { kind: 'tool_call', toolId: id, name, input: c.input, summary: toolSummary(name, c.input) };
      if (!ended) return [call];
      const last = i === inner.length - 1;
      const failed = str(c.status) !== 'completed' || (last && status === 'error');
      return [call, result(id, last ? (status === 'error' ? errorText : outText) : '', failed)];
    });
  }

  const { name, input: mapped } = commonTool(raw, input);
  const call: Omit<Call, 'seq'> = { kind: 'tool_call', toolId, name, input: mapped, summary: toolSummary(name, mapped) };
  const fp = pickFilePath(mapped);
  if (fp) call.filePath = fp;
  if (!ended) return [call];
  return [call, result(toolId, status === 'error' ? errorText : outText, status === 'error')];
}

/** Code Mode の道具の名前（`サーバ.道具`）を、Claude と同じ MCP の名前（`mcp__サーバ__道具`）にする。 */
function mcpName(tool: string): string {
  const k = tool.indexOf('.');
  return k > 0 ? `mcp__${tool.slice(0, k)}__${tool.slice(k + 1)}` : `mcp__${tool}`;
}

/** 道具の結果の content（text の並び）を本文にする。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isRec).map((c) => (c.type === 'text' ? str(c.text) ?? '' : '')).filter(Boolean).join('\n');
}

/** 引数の鍵を付け替える。付け替えた鍵の元の名前は残さず、ほかの鍵はそのまま持つ。 */
function rename(input: unknown, keys: Record<string, string>): unknown {
  if (!isRec(input)) return input;
  const out: Rec = {};
  for (const [k, v] of Object.entries(input)) out[keys[k] ?? k] = v;
  return out;
}

/**
 * 2.1.4 で形を確かめた道具を、共通の名前と引数の形にする。
 * shell には description が無いので、summary は命令から作る（toolSummary が命令の 1 行目を使う）。
 */
function commonTool(name: string, input: unknown): { name: string; input: unknown } {
  switch (name) {
    case 'shell': return { name: 'Bash', input };
    case 'read': return { name: 'Read', input: rename(input, { path: 'file_path' }) };
    case 'write': return { name: 'Write', input: rename(input, { path: 'file_path' }) };
    case 'edit': return { name: 'Edit', input: rename(input, { path: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' }) };
    case 'grep': return { name: 'Grep', input };
    case 'question': return { name: 'AskUserQuestion', input: questionInput(input) };
    default: return { name, input };
  }
}

/** question の問いの並び。複数選べるかの鍵（multiple）だけを Claude の形（multiSelect）にする。 */
function questionInput(input: unknown): unknown {
  if (!isRec(input) || !Array.isArray(input.questions)) return input;
  return { ...input, questions: input.questions.map((q) => rename(q, { multiple: 'multiSelect' })) };
}
