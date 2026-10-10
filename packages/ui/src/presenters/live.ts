import { stepKind, type LiveAsideDto, type LiveDigestDto, type LiveStatus, type SessionActivityDto, type StepCell, type TranscriptEvent, type Translate } from '@agent-hangar/shared';
import { baseName } from '../lib/paths.ts';
import { durationLabel } from './format.ts';
import type { ArtifactCardProps } from './project.ts';
import { turnsText } from './stats.ts';

export type LaneProps = { agentId: string; title: string; tone: 'running' | 'done' | 'error'; elapsed: string; line: string; quoted: boolean; selectable: boolean };

export type LiveInput = {
  digest: LiveDigestDto | null;
  /** 主線のイベント（seq の昇順）。 */
  events: TranscriptEvent[];
  /** 今のターンの頭の seq。 */
  turnFrom: number;
  /** 今のターンの番号。読み込んだ窓からも統計からも決められないときは null で、灯は手の数だけを出す。 */
  turnNo: number | null;
  live: LiveStatus | null;
  /** 裏だけ動いていることの印（shared の asideOf を通したもの）。無ければ省ける。 */
  aside?: LiveAsideDto | null;
  activity: SessionActivityDto | null;
  now: number;
  /** サブエージェントの transcript を開いているか。開いていれば events は主線ではない。 */
  viewingAgent: boolean;
  clock: (ts: number) => string;
  /** 休みのときに出す、最後の手からの経過。 */
  idleFor: string;
  /** 結果の表。呼び出し側が持っていれば渡し、無ければ presentNowStrip が 1 回だけ作る。 */
  results?: ResultMap;
};

/** 意図の帯を薄くする手数。仕様書の試作の値で、使ってみて見直す。 */
export const STALE_STEPS = 30;
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

const TONE_ORDER = { error: 0, running: 1, done: 2 } as const;

/* ---- 現在の帯（セッション画面 C の、ターミナルの真上の 2 行） ---- */

/** 帯に並べるツール呼び出し 1 つ。name は道具の名前（固有名詞なのでそのまま）、arg は引数の短い形。 */
export type StripStep = { key: string; name: string; arg: string; mark: 'done' | 'now' | 'fail' | 'wait' };
/** サブエージェント 1 本。stateLabel は状態の語（実行中、完了、失敗）。 */
export type StripLane = LaneProps & { stateLabel: string };
export type StripIntent = { kind: 'said'; text: string; time: string; title: string; stale: boolean } | { kind: 'none'; text: string };
export type NowStripProps = {
  /** 帯の左の縁と灯の色。 */
  tone: 'busy' | 'aside' | 'wait' | 'idle';
  /** 状態の語。画面はこれだけを知らせの領域（role="status"）にする。帯の全体は追記のたびに読み上げない。 */
  state: string;
  /** 状態の語の隣に添える経過や進み具合。無ければ空。 */
  sub: string;
  /** 1 行目の問い（入力待ちの問い）か、裏だけ動いているときの 1 行。無ければ null。 */
  detail: string | null;
  /** 1 行目の右端のいまの値。noUsage があれば、コンテキスト使用量とコストの代わりにそれ 1 つだけを出す。 */
  values: {
    noUsage: string | null;
    context: { label: string; percent: number | null; missing: string | null };
    cost: { label: string; value: string | null; missing: string | null };
    turns: string;
    tokens: string;
  };
  note: { text: string; filled: boolean };
  intent: StripIntent;
  /** 帯に並べる直近のツール呼び出し（4 つまで）。全部は stepsAll（直近 30 回まで）で、帯の数の札のポップオーバーが使う。 */
  steps: StripStep[];
  stepsTotal: number;
  stepsAll: StripStep[];
  lanes: { count: number; tone: 'running' | 'done' | 'error'; items: StripLane[] };
  artifacts: { count: number; items: ArtifactCardProps[] };
};

export type StripInput = LiveInput & {
  /** 入力待ちになってからの経過の文（「4 分」）。 */
  waited: string;
  contextPercent: number | null;
  /** 推定コストの文（「$0.86」）。届いていなければ空。 */
  cost: string;
  turns: number;
  tokens: string;
  artifacts: ArtifactCardProps[];
  note: string | null;
};

const STRIP_STEPS = 4;
const STRIP_STEPS_ALL = 30;
const STRIP_LANES = 20;
const SHORT = 80;
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** 引数の短い形。ファイルは名前だけ、検索は語、Bash は Claude が書いた説明か、コマンドの 1 行目。 */
function argOf(c: Call): string {
  const i = (typeof c.input === 'object' && c.input !== null && !Array.isArray(c.input) ? c.input : {}) as Record<string, unknown>;
  const file = textOf(i.file_path) ?? textOf(i.notebook_path);
  if (file) return baseName(file);
  if (c.name === 'Bash') return (textOf(i.description) ?? (textOf(i.command) ?? '').split('\n')[0] ?? '').slice(0, SHORT);
  return (textOf(i.pattern) ?? textOf(i.url) ?? textOf(i.path) ?? '').slice(0, SHORT);
}

function stripSteps(i: LiveInput, results: ResultMap): { steps: StripStep[]; all: StripStep[]; total: number } {
  if (i.viewingAgent) return { steps: [], all: [], total: 0 };
  const calls = i.events.filter((e): e is Call => isCall(e) && e.seq >= i.turnFrom && !AGENT_TOOLS.has(e.name) && !OWN_MCP.test(e.name));
  const rows = calls.map((c, n): StripStep => {
    const r = results.get(c.toolId);
    const last = n === calls.length - 1;
    const mark: StripStep['mark'] = r?.isError ? 'fail' : !r && last && i.live === 'waiting' ? 'wait' : !r && last && i.live === 'busy' ? 'now' : 'done';
    return { key: String(c.seq), name: c.name, arg: argOf(c), mark };
  });
  return { steps: rows.slice(-STRIP_STEPS), all: rows.slice(-STRIP_STEPS_ALL), total: rows.length };
}

function stripState(i: LiveInput & { waited: string }, t: Translate, results: ResultMap): Pick<NowStripProps, 'tone' | 'state' | 'sub' | 'detail'> {
  const sep = t('common.list.separator');
  if (i.live === 'waiting') {
    return { tone: 'wait', state: t('session.strip.state.waiting'), sub: t('session.strip.waited', { time: i.waited }), detail: i.activity?.question || i.activity?.summary || null };
  }
  // 本体は入力を受け付けていて、裏だけが動いている。作業中の色にせず、メイン会話が空いていることを言う。
  if (i.aside) {
    const what = i.aside.agents > 0 ? [t('session.strip.subagentsRunning', { n: i.aside.agents })] : i.aside.shell ? [t('session.strip.shellRunning')] : [];
    return { tone: 'aside', state: t('session.strip.state.aside'), sub: '', detail: [...what, t('session.strip.mainFree')].join(sep) };
  }
  const running = (i.digest?.agents ?? []).filter((a) => a.state === 'running').length;
  if (running > 0) {
    const mainBusy = !i.viewingAgent && i.events.some((e) => isCall(e) && e.seq >= i.turnFrom && !AGENT_TOOLS.has(e.name) && !OWN_MCP.test(e.name) && !results.has(e.toolId));
    return { tone: 'busy', state: t('session.strip.state.working'), sub: t('session.strip.subagentsRunning', { n: running }), detail: mainBusy ? t('session.strip.mainWorking') : null };
  }
  if (i.live === 'busy') {
    // サブエージェントの transcript を開いている間は、ターンも回数もメイン会話のものではないので出さない。
    // 「n 回目」はメイン会話の呼び出しの数。Agent の起こしは数え、hangar 自身の MCP は数えない。
    const n = i.events.filter((e) => isCall(e) && e.seq >= i.turnFrom && !OWN_MCP.test(e.name)).length;
    const sub = i.viewingAgent ? '' : i.turnNo === null ? t('session.strip.progressNoTurn', { n }) : t('session.strip.progress', { turn: i.turnNo, n });
    return { tone: 'busy', state: t('session.strip.state.working'), sub, detail: null };
  }
  return { tone: 'idle', state: t('session.strip.state.idle'), sub: t('session.strip.idleFor', { time: i.idleFor }), detail: null };
}

function stripIntent(i: LiveInput, t: Translate): StripIntent {
  const it = i.digest?.intent;
  if (!it) return { kind: 'none', text: t('session.strip.intentNone') };
  if (!it.inThisTurn) return { kind: 'none', text: t('session.strip.intentOldTurn') };
  const time = i.clock(it.at);
  return { kind: 'said', text: t('session.strip.intentQuote', { text: it.text }), time, title: t('session.strip.intentMeta', { time, n: it.stepsSince }), stale: it.stepsSince > STALE_STEPS };
}

const STRIP_STATE_KEY = { running: 'session.lane.running', done: 'session.lane.done', error: 'session.lane.error' } as const;

function stripLanes(i: LiveInput, t: Translate): NowStripProps['lanes'] {
  const agents = [...(i.digest?.agents ?? [])].sort((a, b) => TONE_ORDER[a.state] - TONE_ORDER[b.state]);
  const items = agents.slice(0, STRIP_LANES).map((a): StripLane => {
    const end = a.state === 'running' ? i.now : a.lastAt ?? i.now;
    const elapsed = a.startedAt === null ? '' : durationLabel(t, Math.max(0, end - a.startedAt));
    const quoted = a.state !== 'running' && a.report !== null;
    const endNote = a.endNote === null ? null : a.endNote === 'failed' ? t('session.lane.end.failed') : a.endNote === 'killed' ? t('session.lane.end.killed') : a.endNote;
    // 済みは報告（引用）、無ければ終わりの知らせの訳を添えた「完了」。失敗は報告、最後の手、「失敗」の順。動いている本は最後の手か「開始直後」。
    const line = a.state === 'done' ? a.report ?? (endNote !== null ? t('session.lane.doneWith', { note: endNote }) : t('session.lane.done'))
      : a.state === 'error' ? a.report ?? a.last?.text ?? t('session.lane.error')
      : a.last?.text ?? t('session.lane.started');
    return { agentId: a.agentId, title: a.title, tone: a.state, elapsed, line, quoted, selectable: a.linked, stateLabel: t(STRIP_STATE_KEY[a.state]) };
  });
  const tone = agents.some((a) => a.state === 'error') ? 'error' : agents.some((a) => a.state === 'running') ? 'running' : 'done';
  return { count: agents.length, tone, items };
}

/**
 * 現在の帯（設計書 2.3 の C）。ターミナルの真上の 2 行に置く値を組む。
 * 1 行目は状態の語と問い、右端にいまの値とノートの札。2 行目は意図、ツール呼び出しの並び、サブエージェントとアーティファクトの数の札である。
 * 右パネルの「いま」の段が持っていた中身がここへ移った。
 */
export function presentNowStrip(i: StripInput, t: Translate): NowStripProps {
  const results = i.results ?? resultsOf(i.events);
  const steps = stripSteps(i, results);
  const noContext = i.contextPercent === null;
  const noCost = i.cost === '';
  return {
    ...stripState(i, t, results),
    values: {
      noUsage: noContext && noCost ? t('session.stats.noUsage') : null,
      context: { label: t('session.stats.context'), percent: i.contextPercent, missing: noContext ? t('session.stats.contextNotAvailable') : null },
      cost: { label: t('session.stats.cost'), value: noCost ? null : i.cost, missing: noCost ? t('session.stats.costNotAvailable') : null },
      turns: turnsText(i.turns, t),
      tokens: t('session.stats.tokens', { n: i.tokens }),
    },
    note: { text: i.note ?? '', filled: (i.note ?? '').trim() !== '' },
    intent: stripIntent(i, t),
    steps: steps.steps, stepsTotal: steps.total, stepsAll: steps.all,
    lanes: stripLanes(i, t),
    artifacts: { count: i.artifacts.length, items: i.artifacts },
  };
}
