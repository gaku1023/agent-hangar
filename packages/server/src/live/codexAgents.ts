import { stepKind, stepLine, type LiveAgentDto, type TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readEvents } from '../transcript/read.ts';

// Codex の会話の NowCard に出す、サブエージェントの行。
// 子の rollout は親の会話のサブエージェントとして索引されている（event_index の parent_agent に子の id。provider/codex/transcript/subagent.ts）ので、
// 行の元はその索引と、主線の <subagent_notification>（親の user の発言として届く終わりの知らせ）である。
// Claude のように起こした呼び出しの結果から id を結ばないのは、Codex の子は Code Mode の JS の中（tools.multi_agent_v1__spawn_agent）で起こされ、呼び出しが 1 つの exec に埋もれるため。

const NOTIFICATION = '<subagent_notification>';
/** 子の末尾から読む数。最後の手と最後の発言が入れば足りる。 */
const AGENT_TAIL = 60;

type Note = { status: string; ts: number | null; body: string | null };
type Stat = { agent: string; first: number | null; last: number | null };

const isCall = (e: TranscriptEvent): e is Extract<TranscriptEvent, { kind: 'tool_call' }> => e.kind === 'tool_call';
const isResult = (e: TranscriptEvent): e is Extract<TranscriptEvent, { kind: 'tool_result' }> => e.kind === 'tool_result';
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

function firstLine(text: string, max = 120): string | null {
  const line = text.split('\n').map((l) => l.replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').trim()).find((l) => l !== '');
  return line ? [...line].slice(0, max).join('') : null;
}

/** JSON の文字列リテラルの中身（閉じの引用符の前まで）を戻す。途中で切れていても読めるところまで読む。 */
function unescape(raw: string): string {
  try { return JSON.parse(`"${raw}"`) as string; } catch { /* 途中で切れている */ }
  return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\$/, '');
}

/**
 * 知らせの本文から、子の id と status と本文を読む。
 * status は codex の AgentStatus（pending_init、running、interrupted、shutdown、not_found は文字列、completed と errored は { "completed": 本文 } の形）である。
 * 索引の system は 200 字で切れているので、JSON として読めなければ、正規表現で読めるところまで読む。
 */
export function parseSubagentNotification(text: string): { agent: string; status: string; body: string | null } | null {
  const inner = text.replace(/^\s*<subagent_notification>\s*/, '').replace(/\s*<\/subagent_notification>\s*$/, '');
  try {
    const j: unknown = JSON.parse(inner);
    if (typeof j === 'object' && j !== null) {
      const o = j as { agent_path?: unknown; status?: unknown };
      if (typeof o.agent_path === 'string') {
        if (typeof o.status === 'string') return { agent: o.agent_path, status: o.status, body: null };
        if (typeof o.status === 'object' && o.status !== null) {
          const [k, v] = Object.entries(o.status)[0] ?? [];
          if (k) return { agent: o.agent_path, status: k, body: typeof v === 'string' ? v : null };
        }
      }
    }
  } catch { /* 切れている */ }
  const agent = /"agent_path"\s*:\s*"([^"]+)"/.exec(inner)?.[1];
  const status = /"status"\s*:\s*(?:\{\s*"(\w+)"|"(\w+)")/.exec(inner);
  const name = status?.[1] ?? status?.[2];
  if (!agent || !name) return null;
  const body = status?.[1] ? /"status"\s*:\s*\{\s*"\w+"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(inner)?.[1] : undefined;
  return { agent, status: name, body: body === undefined ? null : unescape(body) };
}

function notifications(main: TranscriptEvent[]): Map<string, Note> {
  const m = new Map<string, Note>();
  for (const e of main) {
    if (e.kind !== 'system' || !e.text.trimStart().startsWith(NOTIFICATION)) continue;
    const n = parseSubagentNotification(e.text);
    if (n) m.set(n.agent, { status: n.status, ts: e.ts ?? null, body: n.body });
  }
  return m;
}

function stats(db: Db, sessionId: string): Stat[] {
  return db.prepare('select parent_agent agent, min(ts) first, max(ts) last from event_index where session_id = ? and parent_agent is not null group by parent_agent order by min(ts), min(seq)').all(sessionId) as Stat[];
}

type Tail = Pick<LiveAgentDto, 'last'> & { said: string | null; title: string | null };

/** 子の最初の指示（題）と、末尾の最後の手と最後の発言。 */
function read(db: Db, sessionId: string, agentId: string): Tail {
  const out: Tail = { last: null, said: null, title: null };
  try {
    const head = readEvents(db, sessionId, { agentId, fromSeq: 0, limit: 8 }).events.find((e) => e.kind === 'user');
    if (head && head.kind === 'user') out.title = firstLine(head.text, 40);
    const events = readEvents(db, sessionId, { agentId, latest: true, limit: AGENT_TAIL }).events;
    const results = new Map(events.filter(isResult).map((r) => [r.toolId, r]));
    const call = [...events].reverse().find(isCall);
    if (call) out.last = { ...stepLine(call), kind: stepKind(call), isError: results.get(call.toolId)?.isError === true };
    const said = [...events].reverse().find((e) => e.kind === 'assistant' && e.text.trim() !== '');
    if (said && said.kind === 'assistant') out.said = said.text;
  } catch (e) {
    // この子の本文だけが無い（消えた、移した）。ほかの行は出す。
    if (!isEnoent(e)) throw e;
  }
  return out;
}

/**
 * Codex の会話の、今のターンのサブエージェントの行。
 * 今のターンに動いた子（rollout の最初か最後の時刻が since 以降）と、今のターンに終わりの知らせが届いた子を出す。そのターンに終わった子も done で残す。
 * state は知らせで決める。completed は done、errored は error、interrupted など分からない終わりは done にして endNote に status を残し、知らせが無ければ running。
 */
export function codexAgentsOf(db: Db, sessionId: string, main: TranscriptEvent[], since: number): LiveAgentDto[] {
  const notes = notifications(main);
  return stats(db, sessionId)
    .filter((s) => notes.has(s.agent) || (s.first ?? 0) >= since || (s.last ?? 0) >= since)
    .map((s): LiveAgentDto => {
      const t = read(db, sessionId, s.agent);
      const note = notes.get(s.agent);
      const status = note?.status;
      const state: LiveAgentDto['state'] = status === undefined || status === 'running' || status === 'pending_init' ? 'running' : status === 'errored' ? 'error' : 'done';
      const body = note?.body ?? t.said;
      return {
        agentId: s.agent, title: t.title ?? s.agent, state,
        startedAt: s.first, lastAt: s.last,
        endNote: state === 'done' && status !== 'completed' ? status ?? null : null,
        last: t.last, report: state === 'running' || body === null ? null : firstLine(body), linked: true,
      };
    });
}
