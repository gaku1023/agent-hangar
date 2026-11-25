import { PEER_CHAT_CARD_CALLS_MAX, utteranceHead, PEER_CHAT_CARD_MAX_BYTES, type LiveAgentDto, type LiveDigestDto, type PeerChatCard, type PeerChatCardEvent, type TranscriptEvent } from '@agent-hangar/shared';
import type { HostSession } from './hostTypes.ts';

/**
 * 現在の札（NowCard）の材料を組む（元の PC 側）。
 * 組み立て（文言、並び、状態の色）は見る側の presenter（presentNowCard）に任せ、ここは材料を小さく刈るだけにする。
 * 札には自前の上限（PEER_CHAT_CARD_MAX_BYTES）があり、本文の項目の枠を食わない。
 */

export type CardSource = {
  session: HostSession;
  digest: LiveDigestDto;
  /** 今のターンの主線の行（呼び出しと答え、頭の発言を含む。seq の昇順）。 */
  events: TranscriptEvent[];
  /** events より前に落とした今のターンの手の数。 */
  dropped: number;
  artifacts: number;
  hints: boolean;
};

const AGENTS_MAX = 20;
const INTENT_MAX_CHARS = 1000;
const REQUEST_MAX_CHARS = 300;
const ARG_MAX_CHARS = 200;
const TONE_ORDER = { error: 0, running: 1, done: 2 } as const;
/** 引数の短い形（presenters/live.ts の argOf）が読む欄。 */
const ARG_KEYS = ['file_path', 'notebook_path', 'description', 'command', 'pattern', 'url', 'path'] as const;

const clip = (s: string, max: number): string => { const a = [...s]; return a.length <= max ? s : a.slice(0, max).join(''); };
const jsonSize = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** tool_call の入力を、引数の短い形が読む欄だけに縮める。Bash の命令は 1 行目だけ。 */
function compactInput(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out;
  const i = input as Record<string, unknown>;
  for (const k of ARG_KEYS) {
    const v = i[k];
    if (typeof v !== 'string' || v.trim() === '') continue;
    out[k] = clip(k === 'command' ? v.trim().split('\n')[0]! : v, ARG_MAX_CHARS);
  }
  return out;
}

function eventsOf(events: TranscriptEvent[], turnFrom: number, calls: number): PeerChatCardEvent[] {
  const out: PeerChatCardEvent[] = [];
  const head = events.find((e) => e.kind === 'user' && e.seq >= turnFrom);
  if (head && head.kind === 'user') out.push({ kind: 'user', seq: head.seq, ...(head.ts !== undefined ? { ts: head.ts } : {}), text: clip(utteranceHead(head.text).trim(), REQUEST_MAX_CHARS) });
  const keep = events.filter((e) => e.kind === 'tool_call').slice(-calls);
  const ids = new Set(keep.map((e) => (e.kind === 'tool_call' ? e.toolId : '')));
  for (const e of events) {
    if (e.kind === 'tool_call' && ids.has(e.toolId)) out.push({ kind: 'tool_call', seq: e.seq, ...(e.ts !== undefined ? { ts: e.ts } : {}), toolId: e.toolId, name: e.name, input: compactInput(e.input) });
    else if (e.kind === 'tool_result' && ids.has(e.toolId)) out.push({ kind: 'tool_result', seq: e.seq, ...(e.ts !== undefined ? { ts: e.ts } : {}), toolId: e.toolId, isError: e.isError });
  }
  return out;
}

function agentsOf(agents: LiveAgentDto[], max: number, text: number): LiveAgentDto[] {
  return [...agents].sort((a, b) => TONE_ORDER[a.state] - TONE_ORDER[b.state]).slice(0, max).map((a) => ({
    agentId: a.agentId, title: clip(a.title, 80), state: a.state, startedAt: a.startedAt, lastAt: a.lastAt,
    last: a.last ? { text: clip(a.last.text, text), mono: a.last.mono, kind: a.last.kind, isError: a.last.isError } : null,
    report: a.report === null ? null : clip(a.report, text * 2), endNote: a.endNote === null ? null : clip(a.endNote, 80), linked: a.linked,
  }));
}

/**
 * 材料を組む。大きすぎれば、サブエージェントの文、本数、手の数の順に縮め、縮めきれなければ null（札を付けない）。
 * 登録が動いていなければ（live が null）作らない。
 */
export function buildPeerChatCard(src: CardSource): PeerChatCard | null {
  const s = src.session;
  if (s.live === null) return null;
  const d = src.digest;
  const turnFrom = d.turnStartSeq ?? 0;
  const aside = s.live === 'busy' && s.aside ? (s.liveAside ?? { shell: false, agents: 0 }) : null;
  const make = (agents: number, text: number, calls: number): PeerChatCard => ({
    aside,
    digest: { sessionId: d.sessionId, turnStartSeq: d.turnStartSeq, intent: d.intent ? { ...d.intent, text: clip(d.intent.text, INTENT_MAX_CHARS) } : null, agents: agentsOf(d.agents, agents, text) },
    turnFrom,
    events: d.turnStartSeq === null ? [] : eventsOf(src.events, turnFrom, calls),
    ...(src.dropped > 0 || src.events.filter((e) => e.kind === 'tool_call').length > calls ? { droppedCalls: src.dropped + Math.max(0, src.events.filter((e) => e.kind === 'tool_call').length - calls) } : {}),
    waitingFor: s.waitingFor, permission: s.permission, limit: s.limit ?? null, activity: s.activity,
    artifacts: src.artifacts, hints: src.hints,
  });
  for (const [agents, text, calls] of [[AGENTS_MAX, 160, PEER_CHAT_CARD_CALLS_MAX], [AGENTS_MAX, 60, PEER_CHAT_CARD_CALLS_MAX], [8, 60, 10], [3, 30, 3]] as const) {
    const c = make(agents, text, calls);
    if (jsonSize(c) <= PEER_CHAT_CARD_MAX_BYTES) return c;
  }
  return null;
}
