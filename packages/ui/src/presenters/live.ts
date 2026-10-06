import { stepKind, stepLine, type LiveDigestDto, type LiveStatus, type SessionActivityDto, type StepCell, type TranscriptEvent } from '@agent-hangar/shared';
import { durationLabel } from './format.ts';

export type LampProps = { tone: 'busy' | 'wait' | 'idle'; head: string; sub: string };
export type IntentProps = { kind: 'said'; text: string; meta: string; stale: boolean } | { kind: 'none'; text: string };
/** key はその行の最初の手の seq（畳んだ読みの行は最初の手のまま）。行が出入りするとき、同じ行を同じものとして追うために使う。 */
export type StepRowProps = { key: string; text: string; mono: boolean; when: string; mark: 'done' | 'now' | 'fail' };
export type LaneProps = { agentId: string; title: string; tone: 'running' | 'done' | 'error'; elapsed: string; line: string; quoted: boolean; selectable: boolean };
export type LivePaneProps = { lamp: LampProps; intent: IntentProps; steps: StepRowProps[]; lanes: LaneProps[]; doneFolded: number };

export type LiveInput = {
  digest: LiveDigestDto | null;
  /** 主線のイベント（seq の昇順）。 */
  events: TranscriptEvent[];
  /** 今のターンの頭の seq。 */
  turnFrom: number;
  /** 今のターンの番号。読み込んだ窓からも統計からも決められないときは null で、灯は手の数だけを出す。 */
  turnNo: number | null;
  live: LiveStatus | null;
  activity: SessionActivityDto | null;
  now: number;
  /** サブエージェントの transcript を開いているか。開いていれば events は主線ではない。 */
  viewingAgent: boolean;
  clock: (ts: number) => string;
  /** 休みのときに出す、最後の手からの経過。 */
  idleFor: string;
  /** 結果の表。呼び出し側が持っていれば渡し、無ければ presentLivePane が 1 回だけ作る。 */
  results?: ResultMap;
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
export type ResultMap = Map<string, Result>;
export const resultsOf = (events: TranscriptEvent[]): ResultMap => new Map(events.filter((e): e is Result => e.kind === 'tool_result').map((r) => [r.toolId, r]));

/**
 * 複数のターンの手の種類の並びを、イベントを 1 度だけ走査して作る。失敗は種類より優先し、ターンごとに最新の 40 手に切る。
 * turns は from の昇順でなくてもよい（呼び出しごとに二分探索する）。
 */
export function bandsOf(events: TranscriptEvent[], turns: { from: number; to: number }[], results: ResultMap = resultsOf(events)): StepCell[][] {
  const cells = events.filter(isCall).map((c) => ({ seq: c.seq, cell: (results.get(c.toolId)?.isError ? 'fail' : stepKind(c)) as StepCell }));
  const sorted = cells.every((c, n) => n === 0 || cells[n - 1]!.seq <= c.seq) ? cells : [...cells].sort((x, y) => x.seq - y.seq);
  return turns.map(({ from, to }) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.seq < from) lo = mid + 1; else hi = mid;
    }
    let end = lo;
    while (end < sorted.length && sorted[end]!.seq < to) end++;
    return sorted.slice(Math.max(lo, end - BAND_CELLS), end).map((c) => c.cell);
  });
}

/** ターンの手の種類の並び。単発用で、数ターンを続けて求めるときは bandsOf を使う。 */
export function bandOf(events: TranscriptEvent[], from: number, to: number): StepCell[] {
  return bandsOf(events, [{ from, to }])[0]!;
}

function mainSteps(i: LiveInput, results: ResultMap): StepRowProps[] {
  if (i.viewingAgent) return [];
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
    rows.push({ ...line, key: String(c.seq), when: c.ts === undefined ? '' : i.clock(c.ts), mark, reads: stepKind(c) === 'read' && mark === 'done' ? 1 : 0 });
  });
  return rows.slice(-MAX_STEPS).map(({ reads, ...row }) => (reads > 1 ? { ...row, text: `${row.text} ほか ${reads - 1} 件` } : row));
}

function lampOf(i: LiveInput, steps: number, results: ResultMap): LampProps {
  const agents = i.digest?.agents ?? [];
  const running = agents.filter((a) => a.state === 'running').length;
  const failed = agents.filter((a) => a.state === 'error').length;
  const done = agents.filter((a) => a.state === 'done').length;
  if (i.live === 'waiting' && i.activity?.question) return { tone: 'wait', head: 'あなたの答え待ち', sub: [...i.activity.question].slice(0, 40).join('') };
  if (i.live === 'waiting') return { tone: 'wait', head: '入力待ち', sub: i.activity?.summary ?? '' };
  if (running > 0) {
    const mainBusy = !i.viewingAgent && i.events.some((e) => isCall(e) && e.seq >= i.turnFrom && !AGENT_TOOLS.has(e.name) && !OWN_MCP.test(e.name) && !results.has(e.toolId));
    return { tone: 'busy', head: `${running} 本動いている`, sub: [mainBusy ? '指揮役も手を動かしている' : '', failed ? `失敗 ${failed}` : '', done ? `済 ${done}` : ''].filter(Boolean).join('、') };
  }
  // サブエージェントの transcript を開いている間は、ターンも手の数も指揮役のものではないので出さない。
  if (i.live === 'busy') return { tone: 'busy', head: '作業中', sub: i.viewingAgent ? '' : i.turnNo === null ? `${steps} 手目` : `ターン ${i.turnNo}・${steps} 手目` };
  return { tone: 'idle', head: '休み', sub: i.idleFor };
}

function intentOf(i: LiveInput): IntentProps {
  const it = i.digest?.intent;
  if (!it) return { kind: 'none', text: '意図は書かれていない' };
  if (!it.inThisTurn) return { kind: 'none', text: 'このターンの意図はまだ書かれていない' };
  return { kind: 'said', text: it.text, meta: `Claude いわく・${i.clock(it.at)}・その後 ${it.stepsSince} 手`, stale: it.stepsSince > STALE_STEPS };
}

const TONE_ORDER = { error: 0, running: 1, done: 2 } as const;

/**
 * 終わりの知らせの status の言い方。英語の内部値は画面に出さない（用語表の決まり 2）。
 * 知らない値は、何が起きたかを失わないようにそのまま添える。
 */
const END_NOTE: Record<string, string> = { failed: '失敗', killed: '止められた' };

function lanesOf(i: LiveInput): { lanes: LaneProps[]; doneFolded: number } {
  const agents = [...(i.digest?.agents ?? [])].sort((a, b) => TONE_ORDER[a.state] - TONE_ORDER[b.state]);
  const all = agents.map((a): LaneProps => {
    const end = a.state === 'running' ? i.now : a.lastAt ?? i.now;
    const elapsed = a.startedAt === null ? '' : durationLabel(Math.max(0, end - a.startedAt));
    const quoted = a.state !== 'running' && a.report !== null;
    // 済みは報告（引用）、無ければ終わりの知らせの status（failed、killed など）を添えた「終わった」で、最後の手は使わない。赤にはしない。
    // 失敗は報告、最後の手、「失敗した」の順。動いている本は最後の手か「始めたところ」。
    const line = a.state === 'done'
      ? a.report ?? (a.endNote !== null ? `終わった（${END_NOTE[a.endNote] ?? a.endNote}）` : '終わった')
      : a.state === 'error' ? a.report ?? a.last?.text ?? '失敗した'
      : a.last?.text ?? '始めたところ';
    return { agentId: a.agentId, title: a.title, tone: a.state, elapsed, line, quoted, selectable: a.linked };
  });
  const lanes = all.slice(0, MAX_LANES);
  return { lanes, doneFolded: all.slice(MAX_LANES).filter((l) => l.tone === 'done').length };
}

export function presentLivePane(i: LiveInput): LivePaneProps {
  const results = i.results ?? resultsOf(i.events);
  // 「m 手目」は指揮役の手の数。Agent の起こしは数え、hangar 自身の MCP は数えない。
  const steps = i.viewingAgent ? 0 : i.events.filter((e) => isCall(e) && e.seq >= i.turnFrom && !OWN_MCP.test(e.name)).length;
  return { lamp: lampOf(i, steps, results), intent: intentOf(i), steps: mainSteps(i, results), ...lanesOf(i) };
}
