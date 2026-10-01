import { isTurnPrompt, stepKind, stepLine, type LiveAgentDto, type LiveDigestDto, type TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { readEvents } from '../transcript/read.ts';
import { latestIntent } from './intents.ts';

type Call = Extract<TranscriptEvent, { kind: 'tool_call' }>;
type Result = Extract<TranscriptEvent, { kind: 'tool_result' }>;
type Stat = { agent: string; first: number | null; last: number | null };

const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** サブエージェントが呼び出し元へ報告を返す道具。 */
const HANDBACK = 'SubagentHandback';
/** 1 ターンで読む主線のイベントの上限。何千手も続く指揮役のターンでも、ここで打ち切る。 */
const MAIN_CAP = 10_000;
/** サブエージェントの末尾から読む数。最後の手と最後の報告が入れば足りる。 */
const AGENT_TAIL = 60;

const isCall = (e: TranscriptEvent): e is Call => e.kind === 'tool_call';
const isResult = (e: TranscriptEvent): e is Result => e.kind === 'tool_result';
const tag = (text: string, name: string): string | null => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null;
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** 本文の最初の空でない行。見出しや強調の記号は落とす。 */
function firstLine(text: string, max = 120): string | null {
  const line = text.split('\n').map((l) => l.replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').trim()).find((l) => l !== '');
  return line ? [...line].slice(0, max).join('') : null;
}

/** 今のターンの頭。中断の知らせを除いた、主線の最後の利用者の指示。 */
export function turnStart(db: Db, sessionId: string): { seq: number; ts: number | null } | null {
  const rows = db.prepare("select seq, ts from event_index where session_id = ? and parent_agent is null and kind = 'user' order by seq desc limit 20").all(sessionId) as { seq: number; ts: number | null }[];
  for (const r of rows) {
    const ev = readEvents(db, sessionId, { fromSeq: r.seq, limit: 1 }).events.find((e) => e.seq === r.seq);
    if (ev && ev.kind === 'user' && isTurnPrompt(ev.text)) return r;
  }
  return null;
}

/**
 * 今のターンの頭から主線を読む。cap を超える長いターンは、新しい側の cap 件だけを読む。
 * 起こした本と終わりの知らせは新しい側にあるので、古い側を捨てる。
 */
function mainSince(db: Db, sessionId: string, fromSeq: number, cap: number): TranscriptEvent[] {
  const count = (db.prepare('select count(*) c from event_index where session_id = ? and parent_agent is null and seq >= ?').get(sessionId, fromSeq) as { c: number }).c;
  if (count > cap) {
    const r = db.prepare('select seq from event_index where session_id = ? and parent_agent is null and seq >= ? order by seq limit 1 offset ?').get(sessionId, fromSeq, count - cap) as { seq: number } | undefined;
    if (r) fromSeq = r.seq;
  }
  const out: TranscriptEvent[] = [];
  let seq: number | null = fromSeq;
  while (seq !== null) {
    const p = readEvents(db, sessionId, { fromSeq: seq, limit: 2000 });
    out.push(...p.events);
    seq = p.nextSeq;
  }
  return out;
}

/** 知らせの本文。文字列のほか、text ブロックの配列でも来る。 */
function promptText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.filter(isRec).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

/** <task-notification> の本文。user の文字列として来れば system に、作業中の queued_command の添付として来れば meta になる。 */
function notificationText(e: TranscriptEvent): string | null {
  let text: string | null = null;
  if (e.kind === 'system') text = e.text;
  else if (e.kind === 'meta' && isRec(e.value) && isRec(e.value.attachment) && e.value.attachment.commandMode === 'task-notification') text = promptText(e.value.attachment.prompt);
  return text !== null && text.trimStart().startsWith('<task-notification>') ? text : null;
}

/** 本が止まっただけで、まだ報告していないときの知らせ。status は completed で来るが、終わりではない。 */
const INTERIM = /has not reported yet|may be interim/;

type Note = { status: string; ts: number | null; interim: boolean };

/** バックグラウンドの本が止まったことを知らせる <task-notification> の、本ごとの最後の status と時刻。 */
function notifications(main: TranscriptEvent[]): Map<string, Note> {
  const m = new Map<string, Note>();
  for (const e of main) {
    const text = notificationText(e);
    if (text === null) continue;
    const id = tag(text, 'task-id');
    const st = tag(text, 'status');
    if (id && st) m.set(id, { status: st, ts: e.ts ?? null, interim: INTERIM.test(text) });
  }
  return m;
}

function stats(db: Db, sessionId: string): Stat[] {
  return db.prepare('select parent_agent agent, min(ts) first, max(ts) last from event_index where session_id = ? and parent_agent is not null group by parent_agent order by min(ts), min(seq)').all(sessionId) as Stat[];
}

type Tail = Pick<LiveAgentDto, 'last'> & { said: string | null; handedBack: boolean };

/**
 * サブエージェントの末尾から、最後の手と最後の報告を取る。
 * 本当の報告は、最後の SubagentHandback 呼び出しの input.message にある（そのあとに発言は続かない）。
 * 途中の発言より新しければそちらを報告にし、handedBack を真にする。この道具の無い環境は、最後の発言を報告にする。
 */
function tail(db: Db, sessionId: string, agentId: string): Tail {
  let events: TranscriptEvent[];
  try {
    events = readEvents(db, sessionId, { agentId, latest: true, limit: AGENT_TAIL }).events;
  } catch (e) {
    // この本の transcript だけが無い（消えた、移した）。ほかのレーンは出す。
    if (isEnoent(e)) return { last: null, said: null, handedBack: false };
    throw e;
  }
  const results = new Map(events.filter(isResult).map((r) => [r.toolId, r]));
  const call = [...events].reverse().find(isCall) ?? null;
  const last = call ? { ...stepLine(call), kind: stepKind(call), isError: results.get(call.toolId)?.isError === true } : null;
  const said = [...events].reverse().find((e) => e.kind === 'assistant' && e.text.trim() !== '');
  const back = [...events].reverse().find((e): e is Call => isCall(e) && e.name === HANDBACK && isRec(e.input) && str(e.input.message) !== undefined);
  const spoken = said && said.kind === 'assistant' ? said : null;
  if (back && (!spoken || back.seq > spoken.seq)) return { last, said: str((back.input as Record<string, unknown>).message) ?? null, handedBack: true };
  return { last, said: spoken?.text ?? null, handedBack: false };
}

/** 前のターンから動き続けている本の題名。起こした呼び出しが今のターンに無いので、その本が受け取った指示の書き出しにする。 */
function promptTitle(db: Db, sessionId: string, agentId: string): string {
  let first: TranscriptEvent | undefined;
  try {
    first = readEvents(db, sessionId, { agentId, fromSeq: 0, limit: 5 }).events.find((e) => e.kind === 'user');
  } catch (e) {
    if (!isEnoent(e)) throw e;
  }
  return (first && first.kind === 'user' ? firstLine(first.text, 40) : null) ?? agentId;
}

/**
 * レーンの 1 行の報告。報告を返していればその本文、なければ最後の発言の 1 行目。
 * transcript の無い失敗のレーンは、Agent の結果（Agent type not found など）の 1 行目を出す。
 */
function reportOf(state: LiveAgentDto['state'], t: Tail, result: Result | null): string | null {
  if (state === 'error') return t.said !== null ? firstLine(t.said) : result ? firstLine(result.text) : null;
  return state === 'running' || t.said === null ? null : firstLine(t.said);
}

type Seed = { agentId: string; title: string; call: Call | null; result: Result | null; linked: boolean };

function agentsOf(db: Db, sessionId: string, main: TranscriptEvent[], since: number): LiveAgentDto[] {
  const results = new Map(main.filter(isResult).map((r) => [r.toolId, r]));
  const done = notifications(main);
  const st = stats(db, sessionId);
  const statOf = new Map(st.map((s) => [s.agent, s]));
  const seeds: Seed[] = [];
  const unlinked: Seed[] = [];
  for (const c of main.filter(isCall)) {
    if (!AGENT_TOOLS.has(c.name)) continue;
    const r = results.get(c.toolId) ?? null;
    const title = (c.input && typeof c.input === 'object' ? str((c.input as Record<string, unknown>).description) : undefined) ?? c.summary;
    const id = r?.agentLaunch?.agentId;
    if (id) seeds.push({ agentId: id, title, call: c, result: r, linked: true });
    else if (r?.isError) seeds.push({ agentId: `tool:${c.toolId}`, title, call: c, result: r, linked: false });
    else { const s: Seed = { agentId: `tool:${c.toolId}`, title, call: c, result: r, linked: false }; seeds.push(s); unlinked.push(s); }
  }
  // agentId を持たない古い記録は、今のターンに始まったまだ結んでいない本と順番で突き合わせる。
  const taken = new Set(seeds.filter((s) => s.linked).map((s) => s.agentId));
  const fresh = st.filter((s) => !taken.has(s.agent) && (s.first ?? 0) >= since);
  unlinked.forEach((s, i) => { const f = fresh[i]; if (f) { s.agentId = f.agent; s.linked = true; taken.add(f.agent); } });
  // 前のターンに起こし、今のターンにも手を動かしている本。
  for (const s of st) {
    if (taken.has(s.agent) || (s.last ?? 0) < since) continue;
    seeds.push({ agentId: s.agent, title: promptTitle(db, sessionId, s.agent), call: null, result: null, linked: true });
    taken.add(s.agent);
  }
  return seeds.map((s): LiveAgentDto => {
    const stat = s.linked ? statOf.get(s.agentId) : undefined;
    const t: Tail = stat ? tail(db, sessionId, s.agentId) : { last: null, said: null, handedBack: false };
    const note = done.get(s.agentId);
    // 知らせのあとに本が手を動かしていたら、起き直している（仮の知らせのあとに動き出すのが普通）。
    const resumed = note?.ts != null && stat?.last != null && stat.last > note.ts;
    // 赤は Agent の結果が isError のときだけ。報告を返したか、仮でない知らせが来て起き直していなければ done。
    // 知らせの status は止まったことを示すだけで、completed 以外は endNote に残す。仮の知らせだけでは終わりにしない。
    const state: LiveAgentDto['state'] = s.result?.isError ? 'error'
      : t.handedBack ? 'done'
      : note !== undefined && !note.interim && !resumed ? 'done'
      : s.result && !s.result.agentLaunch?.async && s.call ? 'done'
      : 'running';
    const born = s.call?.ts ?? null;
    return {
      agentId: s.agentId, title: s.title, state,
      startedAt: stat?.first ?? born, lastAt: stat?.last ?? born,
      // linked は agentLaunch か順番の突き合わせか前のターンからの本のときだけ真である。
      // 起こした直後でまだ transcript の無い本も、押せば空の transcript が開くだけなので真のままにする。
      endNote: state === 'done' && note !== undefined && !note.interim && note.status !== 'completed' ? note.status : null,
      last: t.last, report: reportOf(state, t, s.result), linked: s.linked,
    };
  });
}

/** 右ペインのライブの要約。今のターンの頭から読む。 */
export function buildLiveDigest(db: Db, sessionId: string, opts: { mainCap?: number } = {}): LiveDigestDto {
  const start = turnStart(db, sessionId);
  const main = start ? mainSince(db, sessionId, start.seq, opts.mainCap ?? MAIN_CAP) : [];
  const since = start?.ts ?? 0;
  const agents = start ? agentsOf(db, sessionId, main, since) : [];
  const it = latestIntent(db, sessionId);
  const stepsSince = (at: number) => (db.prepare("select count(*) c from event_index where session_id = ? and kind = 'tool_call' and ts > ?").get(sessionId, at) as { c: number }).c;
  const intent = it ? { text: it.text, at: it.at, stepsSince: stepsSince(it.at), inThisTurn: start?.ts == null || it.at >= start.ts } : null;
  return { sessionId, turnStartSeq: start?.seq ?? null, intent, agents };
}

/**
 * 要約を覚えておく。UI は追記のたびに取り直すので、索引と意図が変わっていなければ読み直さない。
 * 経過時間は UI が今の時刻で数えるので、覚えた要約が古くなることは無い。
 */
export class LiveDigester {
  private readonly cache = new Map<string, { key: string; digest: LiveDigestDto }>();
  constructor(private readonly db: Db) {}
  digest(sessionId: string): LiveDigestDto {
    const key = this.keyOf(sessionId);
    const hit = this.cache.get(sessionId);
    if (hit && hit.key === key) return hit.digest;
    const digest = buildLiveDigest(this.db, sessionId);
    this.cache.set(sessionId, { key, digest });
    return digest;
  }
  private keyOf(sessionId: string): string {
    const r = this.db.prepare('select max(seq) m, count(*) c, max(ts) t from event_index where session_id = ?').get(sessionId) as { m: number | null; c: number; t: number | null };
    return `${r.m}:${r.c}:${r.t}:${latestIntent(this.db, sessionId)?.at ?? ''}`;
  }
}
