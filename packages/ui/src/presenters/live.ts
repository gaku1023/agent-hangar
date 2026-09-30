import { stepKind, stepLine, type LiveDigestDto, type LiveStatus, type SessionActivityDto, type StepCell, type TranscriptEvent } from '@agent-hangar/shared';
import { durationLabel } from './format.ts';

export type LampProps = { tone: 'busy' | 'wait' | 'idle'; head: string; sub: string };
export type IntentProps = { kind: 'said'; text: string; meta: string; stale: boolean } | { kind: 'none'; text: string };
export type StepRowProps = { text: string; mono: boolean; when: string; mark: 'done' | 'now' | 'fail' };
export type LaneProps = { agentId: string; title: string; tone: 'running' | 'done' | 'error'; elapsed: string; line: string; quoted: boolean; selectable: boolean };
export type LivePaneProps = { lamp: LampProps; intent: IntentProps; steps: StepRowProps[]; lanes: LaneProps[]; doneFolded: number };

export type LiveInput = {
  digest: LiveDigestDto | null;
  /** 主線のイベント（seq の昇順）。 */
  events: TranscriptEvent[];
  /** 今のターンの頭の seq。 */
  turnFrom: number;
  turnNo: number;
  live: LiveStatus | null;
  activity: SessionActivityDto | null;
  now: number;
  /** サブエージェントの transcript を開いているか。開いていれば events は主線ではない。 */
  viewingAgent: boolean;
  clock: (ts: number) => string;
  /** 休みのときに出す、最後の手からの経過。 */
  idleFor: string;
};

/** 意図の帯を薄くする手数。仕様書の試作の値で、使ってみて見直す。 */
export const STALE_STEPS = 30;
const MAX_STEPS = 4;
const MAX_LANES = 6;
const BAND_CELLS = 40;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** hangar 自身の MCP は、右ペインを書くための手なので手の一覧に出さない。 */
const OWN_MCP = /^mcp__hangar__/;

type Call = Extract<TranscriptEvent, { kind: 'tool_call' }>;
type Result = Extract<TranscriptEvent, { kind: 'tool_result' }>;
const isCall = (e: TranscriptEvent): e is Call => e.kind === 'tool_call';
const resultsOf = (events: TranscriptEvent[]) => new Map(events.filter((e): e is Result => e.kind === 'tool_result').map((r) => [r.toolId, r]));

/** ターンの手の種類の並び。失敗は種類より優先し、最新の 40 手に切る。 */
export function bandOf(events: TranscriptEvent[], from: number, to: number): StepCell[] {
  const results = resultsOf(events);
  const cells = events.filter((e): e is Call => isCall(e) && e.seq >= from && e.seq < to).map((c): StepCell => (results.get(c.toolId)?.isError ? 'fail' : stepKind(c)));
  return cells.slice(-BAND_CELLS);
}

function mainSteps(i: LiveInput): StepRowProps[] {
  if (i.viewingAgent) return [];
  const results = resultsOf(i.events);
  const calls = i.events.filter((e): e is Call => isCall(e) && e.seq >= i.turnFrom && !AGENT_TOOLS.has(e.name) && !OWN_MCP.test(e.name));
  const rows: (StepRowProps & { reads: number })[] = [];
  calls.forEach((c, n) => {
    const r = results.get(c.toolId);
    const mark: StepRowProps['mark'] = r?.isError ? 'fail' : !r && n === calls.length - 1 && i.live === 'busy' ? 'now' : 'done';
    const line = stepLine(c);
    const prev = rows[rows.length - 1];
    // 続けて読んだ手は 1 行に畳む。失敗と「いま」の手は畳まない。
    if (stepKind(c) === 'read' && mark === 'done' && prev && prev.reads > 0 && prev.mark === 'done') {
      prev.reads++;
      return;
    }
    rows.push({ ...line, when: c.ts === undefined ? '' : i.clock(c.ts), mark, reads: stepKind(c) === 'read' && mark === 'done' ? 1 : 0 });
  });
  return rows.slice(-MAX_STEPS).map(({ reads, ...row }) => (reads > 1 ? { ...row, text: `${row.text} ほか ${reads - 1} 件` } : row));
}

function lampOf(i: LiveInput, steps: number): LampProps {
  const agents = i.digest?.agents ?? [];
  const running = agents.filter((a) => a.state === 'running').length;
  const failed = agents.filter((a) => a.state === 'error').length;
  const done = agents.filter((a) => a.state === 'done').length;
  if (i.live === 'waiting' && i.activity?.question) return { tone: 'wait', head: 'あなたの答え待ち', sub: [...i.activity.question].slice(0, 40).join('') };
  if (i.live === 'waiting') return { tone: 'wait', head: '入力待ち', sub: i.activity?.summary ?? '' };
  if (running > 0) {
    const mainBusy = !i.viewingAgent && i.events.some((e) => isCall(e) && e.seq >= i.turnFrom && !AGENT_TOOLS.has(e.name) && !resultsOf(i.events).has(e.toolId));
    return { tone: 'busy', head: `${running} 本動いている`, sub: [mainBusy ? '指揮役も手を動かしている' : '', failed ? `失敗 ${failed}` : '', done ? `済 ${done}` : ''].filter(Boolean).join('、') };
  }
  if (i.live === 'busy') return { tone: 'busy', head: '作業中', sub: `ターン ${i.turnNo}・${steps} 手目` };
  return { tone: 'idle', head: '休み', sub: i.idleFor };
}

function intentOf(i: LiveInput): IntentProps {
  const it = i.digest?.intent;
  if (!it) return { kind: 'none', text: '意図は書かれていない' };
  if (!it.inThisTurn) return { kind: 'none', text: 'このターンの意図はまだ書かれていない' };
  return { kind: 'said', text: it.text, meta: `Claude いわく・${i.clock(it.at)}・その後 ${it.stepsSince} 手`, stale: it.stepsSince > STALE_STEPS };
}

const TONE_ORDER = { error: 0, running: 1, done: 2 } as const;

function lanesOf(i: LiveInput): { lanes: LaneProps[]; doneFolded: number } {
  const agents = [...(i.digest?.agents ?? [])].sort((a, b) => TONE_ORDER[a.state] - TONE_ORDER[b.state]);
  const all = agents.map((a): LaneProps => {
    const end = a.state === 'running' ? i.now : a.lastAt ?? i.now;
    const elapsed = a.startedAt === null ? '' : durationLabel(Math.max(0, end - a.startedAt));
    const quoted = a.state !== 'running' && a.report !== null;
    // 済みで報告が無いときは、終わりの知らせの status（failed、killed など）があれば添える。赤にはしない。
    const doneLine = a.endNote !== null ? `終わった（${a.endNote}）` : '終わった';
    const line = quoted ? a.report! : a.last?.text ?? (a.state === 'error' ? '失敗した' : a.state === 'done' ? doneLine : '始めたところ');
    return { agentId: a.agentId, title: a.title, tone: a.state, elapsed, line, quoted, selectable: a.linked };
  });
  const lanes = all.slice(0, MAX_LANES);
  return { lanes, doneFolded: all.slice(MAX_LANES).filter((l) => l.tone === 'done').length };
}

export function presentLivePane(i: LiveInput): LivePaneProps {
  const steps = i.viewingAgent ? 0 : i.events.filter((e) => isCall(e) && e.seq >= i.turnFrom).length;
  return { lamp: lampOf(i, steps), intent: intentOf(i), steps: mainSteps(i), ...lanesOf(i) };
}
