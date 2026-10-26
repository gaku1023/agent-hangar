import { type AgentKind, limitKindText, resetAtText, stepKind, type LiveAsideDto, type LiveDigestDto, type LiveStatus, type PermissionAskDto, type SessionActivityDto, type SessionLimitDto, type StepCell, type StopReason, type TranscriptEvent, type Translate, type WaitKind } from '@agent-hangar/shared';
import { baseName } from '../lib/paths.ts';
import { contextTokensLabel, costLabel, durationLabel, percentLabel } from './format.ts';
import type { ArtifactCardProps } from './project.ts';

export type LaneProps = { agentId: string; title: string; tone: 'running' | 'done' | 'error'; elapsed: string; line: string; quoted: boolean; selectable: boolean };

export type LiveInput = {
  digest: LiveDigestDto | null;
  /** 主線のイベント（seq の昇順）。 */
  events: TranscriptEvent[];
  /** 今のターンの頭の seq。 */
  turnFrom: number;
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
  /** 結果の表。呼び出し側が持っていれば渡し、無ければ presentNowCard が 1 回だけ作る。 */
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

/* ---- 現在の札（セッション画面の右の欄の上、目次の上） ---- */

/** 札に並べるツール呼び出し 1 つ。name は道具の名前（固有名詞なのでそのまま）、arg は引数の短い形。 */
export type CardStep = { key: string; name: string; arg: string; mark: 'done' | 'now' | 'fail' | 'wait' };
/** サブエージェント 1 本。stateLabel は状態の語（実行中、完了、失敗）。 */
export type CardLane = LaneProps & { stateLabel: string };
/**
 * 意図。said は Claude がこのターンに書いたもので、label は「Claude の意図 · 時刻」の小見出し。
 * request は意図を送らない設定（liveHints が切）のときの、このターンの利用者の発言の冒頭で、label は「依頼 · 時刻」（試作 2 節の推す案 A）。
 * none の text が空なら、何も出さない。
 */
export type CardIntent = { kind: 'said'; text: string; label: string; title: string; stale: boolean } | { kind: 'request'; text: string; label: string } | { kind: 'none'; text: string };
/**
 * 止まっている理由の欄（試作 stop-reason-proto の N1）。問いと同じ場所に置く。
 * permission は許可待ちで、command は命令の全文（折り返す）、why は Claude の説明、hint は答え方。中身が届いていなければ command と why は null で、hint がその旨を言う。
 * limit は使用制限で、at はリセットの時刻と残り、meter は枠の時間のうち過ぎた割合（0 から 100、枠の長さが分からなければ null）、hint は自動で続くか。
 * reset はリセット済みで、続きを指示するよう言う。
 */
export type NowStop =
  | { kind: 'permission'; head: string; command: string | null; why: string | null; hint: string }
  | { kind: 'limit'; head: string; at: string; meter: number | null; hint: string }
  | { kind: 'reset'; head: string; body: string };
/**
 * opencode の会話の使用量（試作の C1）。札の下に、コンテキストの使用率の細い帯と、トークン・コスト・モデルの小札を置く。
 * percent は帯の幅（0 から 100 に収めたもの）で、上限が分からなければ null で帯を出さない。percentLabel は帯の右の数。
 * chips は小札の語（「13.6k トークン」「$0.00」「lmstudio/qwen3.8-27b」）で、届いていない値の札は持たない。
 * Claude の会話は、使用量をヘッダ（5 時間・週）と見出しの (i) に出すので、ここは null である。
 */
export type NowUsage = { percent: number | null; percentLabel: string; chips: string[] };
export type NowCardProps = {
  /** 札の左の縁と灯の色。limit は使用制限の青みの灰である。 */
  tone: 'busy' | 'aside' | 'wait' | 'idle' | 'limit';
  /** 状態の語。画面はこれだけを知らせの領域（role="status"）にする。札の全体は追記のたびに読み上げない。 */
  state: string;
  /** 状態の語の隣に添える経過や進み具合。無ければ空。 */
  sub: string;
  /** 入力待ちの問い（question が真）か、裏だけ動いているときやサブエージェントが動いているときの 1 行。無ければ null。 */
  detail: string | null;
  /** detail が Claude の問いか。真なら「Claude の問い」の見出しを付けて目立たせる。 */
  question: boolean;
  /** 問いの見出し（「Claude からの質問」、opencode なら「opencode からの質問」）。 */
  questionLabel: string;
  /** 止まっている理由の欄。理由が無ければ null。 */
  stop: NowStop | null;
  intent: CardIntent;
  /** 札に縦に並べる直近のツール呼び出し（3 つまで）。全部は stepsAll（直近 30 回まで）で、「ほか N」の札のポップオーバーが使う。 */
  steps: CardStep[];
  stepsTotal: number;
  stepsAll: CardStep[];
  lanes: { count: number; tone: 'running' | 'done' | 'error'; items: CardLane[] };
  artifacts: { count: number; items: ArtifactCardProps[] };
  /** opencode の使用量。Claude の会話は null。 */
  usage: NowUsage | null;
};

export type CardInput = LiveInput & {
  /** 入力待ちになってからの経過の文（「4 分」）。 */
  waited: string;
  artifacts: ArtifactCardProps[];
  /** 止まっている理由（shared の stopReasonOf）と、その中身。無ければ省ける。 */
  reason?: StopReason | null;
  permission?: PermissionAskDto | null;
  limit?: SessionLimitDto | null;
  /** 入力待ちが何を待っているか（登録の waitingFor）。無ければ省ける。 */
  waitingFor?: WaitKind | null;
  /** 設定の「ターンの意図と操作の短い説明を送る」。切なら、意図の代わりに依頼の冒頭を出す。省けば入り。Claude にだけ効く。 */
  liveHints?: boolean;
  /** 会話のエージェント。見出しの語（意図、質問、許可）と、使用量の欄の有無が変わる。省けば Claude。 */
  agent?: AgentKind;
  /** opencode の使用量の素（SessionStatsDto の contextPercent、contextTokens、costUsd、model）。Claude では使わない。 */
  usage?: { contextPercent: number | null; contextTokens: number | null; costUsd: number | null; model: string | null } | null;
  /** 会話の最初の依頼（SessionDto.firstPrompt）。opencode で本文がまだ届かない最初のターンに、意図の代わりに出す。 */
  firstPrompt?: string | null;
  /** 今のターンが会話の最初のターンか。opencode で意図が無いときの見出し（「初期プロンプト」か「プロンプト · 時刻」）を分ける。 */
  firstTurn?: boolean;
};

/** 使用制限の枠の長さ。残りの棒は、この長さのうち過ぎた割合で描く。 */
const LIMIT_WINDOW_MS = { five_hour: 5 * 3_600_000, weekly: 7 * 86_400_000 } as const;

const STRIP_STEPS = 3;
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

/**
 * 今のターンの行か。ターンの頭（turnFrom）から後の行のほか、頭より前に並んでいても時刻が頭の時刻より後の行を含める。
 * API がすぐ返すと、Claude Code は呼び出しの行を、時刻の早い初めの発言の行より先に本文へ書くことがある（使用制限の行の foldLimit と同じ並びの入れ替わり）。
 * 頭の行が読めていないか時刻が無ければ、seq だけで切る。
 */
function turnFilter(i: LiveInput): (e: TranscriptEvent) => boolean {
  const headTs = i.events.find((e) => e.seq === i.turnFrom)?.ts;
  if (typeof headTs !== 'number') return (e) => e.seq >= i.turnFrom;
  return (e) => e.seq >= i.turnFrom || (typeof e.ts === 'number' && e.ts >= headTs);
}

/** 今のターンの、メイン会話の手（サブエージェントの起こしと hangar 自身の MCP を除く）。 */
function turnCalls(i: LiveInput, opts: { agents: boolean } = { agents: false }): Call[] {
  const inTurn = turnFilter(i);
  return i.events.filter((e): e is Call => isCall(e) && inTurn(e) && (opts.agents || !AGENT_TOOLS.has(e.name)) && !OWN_MCP.test(e.name));
}

function stripSteps(i: LiveInput, results: ResultMap): { steps: CardStep[]; all: CardStep[]; total: number } {
  if (i.viewingAgent) return { steps: [], all: [], total: 0 };
  const calls = turnCalls(i);
  const rows = calls.map((c, n): CardStep => {
    const r = results.get(c.toolId);
    const last = n === calls.length - 1;
    const mark: CardStep['mark'] = r?.isError ? 'fail' : !r && last && i.live === 'waiting' ? 'wait' : !r && last && i.live === 'busy' ? 'now' : 'done';
    return { key: String(c.seq), name: c.name, arg: argOf(c), mark };
  });
  return { steps: rows.slice(-STRIP_STEPS), all: rows.slice(-STRIP_STEPS_ALL), total: rows.length };
}

/** 今のターンの経過。ターンの頭からの最初の時刻を起点にする。時刻の付いた行が無ければ null。 */
function turnElapsed(i: LiveInput, t: Translate): string | null {
  const first = i.events.find((e) => e.seq >= i.turnFrom && typeof e.ts === 'number');
  return first?.ts === undefined ? null : durationLabel(t, Math.max(0, i.now - first.ts));
}

/** 止まっている理由があれば、状態の行と理由の欄を組む。無ければ null（ふだんの状態の行にする）。 */
function stopState(i: CardInput, t: Translate): Pick<NowCardProps, 'tone' | 'state' | 'sub' | 'detail' | 'question' | 'stop'> | null {
  if (i.reason === 'permission') {
    const p = i.permission ?? null;
    // opencode の許可は道具の名前（shell など）を「許可を待っています · shell」の見出しにする（HANDOFF の 4 節）。
    const oc = i.agent === 'opencode';
    const head = p ? t(oc ? 'stop.card.permissionWaitingTool' : 'stop.card.permissionHeadTool', { tool: p.tool }) : t(oc ? 'stop.card.permissionWaiting' : 'stop.card.permissionHead');
    const stop: NowStop = p
      ? { kind: 'permission', head, command: p.input || null, why: p.description, hint: t('stop.card.permissionHint') }
      : { kind: 'permission', head, command: null, why: null, hint: t('stop.card.permissionUnknown') };
    return { tone: 'wait', state: t('stop.state.permission'), sub: t('session.strip.waited', { time: i.waited }), detail: null, question: false, stop };
  }
  if (i.reason === 'limit' && i.limit) {
    const l = i.limit;
    const time = resetAtText(t, l.resetsAt, i.now);
    const leftMs = Math.max(0, l.resetsAt - i.now);
    const left = t('stop.limit.left', { time: durationLabel(t, leftMs) });
    const window = l.kind === 'other' ? null : LIMIT_WINDOW_MS[l.kind];
    const meter = window === null ? null : Math.round(Math.min(1, Math.max(0, 1 - leftMs / window)) * 100);
    const head = l.kind === 'other' ? t('stop.state.limit') : t('stop.card.limitHead', { kind: limitKindText(t, l.kind) });
    const at = leftMs > 0 ? t('stop.card.limitAt', { time, left }) : t('stop.limit.at', { time });
    return { tone: 'limit', state: t('stop.state.limit'), sub: leftMs > 0 ? left : '', detail: null, question: false, stop: { kind: 'limit', head, at, meter, hint: t(l.auto ? 'stop.card.limitAuto' : 'stop.card.limitNoAuto') } };
  }
  if (i.reason === 'reset') return { tone: 'wait', state: t('stop.state.reset'), sub: '', detail: null, question: false, stop: { kind: 'reset', head: t('stop.card.resetHead'), body: t('stop.card.resetBody') } };
  return null;
}

function stripState(i: CardInput, t: Translate, results: ResultMap): Pick<NowCardProps, 'tone' | 'state' | 'sub' | 'detail' | 'question' | 'stop'> {
  const stopped = stopState(i, t);
  if (stopped) return stopped;
  return { ...plainState(i, t, results), stop: null };
}

/**
 * 許可でない待ち（waitingFor が other。許可した直後に Claude Code が出すダイアログなど）で、最後の呼び出しにもう答えが出ているか。
 * そのときの活動は済んだ呼び出し（前の許可の命令）なので、問いとして出さない。
 */
function staleWait(i: CardInput, results: ResultMap): boolean {
  if (i.waitingFor !== 'other' || i.viewingAgent) return false;
  const last = turnCalls(i).at(-1);
  return last !== undefined && results.has(last.toolId);
}

function plainState(i: CardInput, t: Translate, results: ResultMap): Pick<NowCardProps, 'tone' | 'state' | 'sub' | 'detail' | 'question'> {
  if (i.live === 'waiting') {
    const detail = staleWait(i, results) ? null : i.activity?.question || i.activity?.summary || null;
    return { tone: 'wait', state: t('session.strip.state.waiting'), sub: t('session.strip.waited', { time: i.waited }), detail, question: detail !== null };
  }
  // 本体は入力を受け付けていて、裏だけが動いている。作業中の色にしない。
  // 裏のサブエージェントは札のチップ（担当の数）が見せるので言い直さない。チップの無い裏のシェルだけを 1 行添える。
  if (i.aside) {
    const shellOnly = i.aside.agents === 0 && i.aside.shell;
    return { tone: 'aside', state: t('session.strip.state.aside'), sub: '', detail: shellOnly ? t('session.strip.shellRunning') : null, question: false };
  }
  // サブエージェントが動いている間も作業中として扱い、件数はチップに任せて、ふつうの作業中と同じく手の数を添える。
  const running = (i.digest?.agents ?? []).filter((a) => a.state === 'running').length;
  if (i.live === 'busy' || running > 0) {
    // サブエージェントの transcript を開いている間は、呼び出しの数も経過もメイン会話のものではないので出さない。
    // 「ツール呼び出し n 回」はメイン会話の呼び出しの数。Agent の起こしは数え、hangar 自身の MCP は数えない。経過は今のターンの頭から。
    const n = turnCalls(i, { agents: true }).length;
    const time = turnElapsed(i, t);
    const sub = i.viewingAgent ? '' : time === null ? t('session.strip.progressNoTime', { n }) : t('session.strip.progress', { n, time });
    return { tone: 'busy', state: t('session.strip.state.working'), sub, detail: null, question: false };
  }
  return { tone: 'idle', state: t('session.strip.state.idle'), sub: t('session.strip.idleFor', { time: i.idleFor }), detail: null, question: false };
}

/** 依頼の冒頭の長さ。札では 3 行で切るので、それより長い分は持たない。 */
const REQUEST_MAX = 300;
const tagText = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1]!.trim() : null;
};

/**
 * このターンの利用者の発言の冒頭。ターンの頭（turnFrom）から後の、最初の利用者の発言かスラッシュコマンドを読む。
 * スラッシュコマンドは「/review 12」の形に、画像だけの発言は「（画像）」にする。読み込めていなければ null。
 */
function turnRequest(i: LiveInput, t: Translate): { text: string; ts: number | undefined } | null {
  for (const e of i.events) {
    if (e.seq < i.turnFrom) continue;
    if (e.kind === 'user') {
      const text = e.text.trim();
      if (text) return { text: [...text].slice(0, REQUEST_MAX).join(''), ts: e.ts };
      if (e.attachments?.length) return { text: t('session.strip.requestImage'), ts: e.ts };
      continue;
    }
    if (e.kind === 'system') {
      const name = tagText(e.text, 'command-name');
      if (name === null) continue;
      const args = tagText(e.text, 'command-args') ?? '';
      return { text: args ? `${name} ${args}` : name, ts: e.ts };
    }
  }
  return null;
}

/**
 * opencode の意図。このターンの意図があれば「opencode の意図 · 時刻」で出し、無ければ依頼を出す（決定 6。モデルが MCP を呼ばなくても困らない作り）。
 * 依頼は、最初のターンなら「初期プロンプト」、2 ターン目からは「プロンプト · 時刻」の見出しにする。
 * 最初のターンで本文がまだ届いていなければ、会話の最初の依頼（firstPrompt）を出す。
 */
function opencodeIntent(i: CardInput, t: Translate): CardIntent {
  const it = i.digest?.intent;
  if (it?.inThisTurn) {
    const time = i.clock(it.at);
    return { kind: 'said', text: it.text, label: t('session.strip.opencode.intentLabel', { time }), title: t('session.strip.opencode.intentMeta', { time, n: it.stepsSince }), stale: it.stepsSince > STALE_STEPS };
  }
  const first = i.firstTurn === true;
  const r = turnRequest(i, t);
  if (r) return { kind: 'request', text: r.text, label: first || r.ts === undefined ? t('session.strip.initialPrompt') : t('session.strip.requestLabel', { time: i.clock(r.ts) }) };
  const prompt = i.firstPrompt?.trim();
  if (first && prompt) return { kind: 'request', text: [...prompt].slice(0, REQUEST_MAX).join(''), label: t('session.strip.initialPrompt') };
  return { kind: 'none', text: '' };
}

/** opencode の使用量の欄。届いた値だけを札にし、何も無ければ null（欄ごと出さない）。 */
function stripUsage(i: CardInput, t: Translate): NowUsage | null {
  const u = i.usage;
  if (i.agent !== 'opencode' || !u) return null;
  const chips: string[] = [];
  if (u.contextTokens !== null) chips.push(t('session.strip.usage.tokens', { n: contextTokensLabel(u.contextTokens) }));
  if (u.costUsd !== null) chips.push(costLabel(u.costUsd));
  if (u.model) chips.push(u.model);
  const percent = u.contextPercent === null ? null : Math.min(100, Math.max(0, u.contextPercent));
  if (percent === null && chips.length === 0) return null;
  return { percent, percentLabel: percentLabel(t, u.contextPercent), chips };
}

function stripIntent(i: CardInput, t: Translate): CardIntent {
  if (i.agent === 'opencode') return opencodeIntent(i, t);
  const it = i.digest?.intent;
  // 意図を送らない設定では、Claude は意図を書かない。「まだ意図が届いていません」は出さず、利用者の依頼の冒頭を出す（1f）。
  // 切る前に起こした run がこのターンの意図を書いていれば、そちらを先に出す。
  if (i.liveHints === false && !it?.inThisTurn) {
    const r = turnRequest(i, t);
    if (!r) return { kind: 'none', text: '' };
    return { kind: 'request', text: r.text, label: r.ts === undefined ? t('session.strip.request') : t('session.strip.requestLabel', { time: i.clock(r.ts) }) };
  }
  if (!it) return { kind: 'none', text: t('session.strip.intentNone') };
  if (!it.inThisTurn) return { kind: 'none', text: t('session.strip.intentOldTurn') };
  const time = i.clock(it.at);
  return { kind: 'said', text: it.text, label: t('session.strip.intentLabel', { time }), title: t('session.strip.intentMeta', { time, n: it.stepsSince }), stale: it.stepsSince > STALE_STEPS };
}

const STRIP_STATE_KEY = { running: 'session.lane.running', done: 'session.lane.done', error: 'session.lane.error' } as const;

function stripLanes(i: LiveInput, t: Translate): NowCardProps['lanes'] {
  const agents = [...(i.digest?.agents ?? [])].sort((a, b) => TONE_ORDER[a.state] - TONE_ORDER[b.state]);
  const items = agents.slice(0, STRIP_LANES).map((a): CardLane => {
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
 * 現在の札。セッション画面の右の欄の上（目次の上）に置く値を組む（2026-10-11 の試作の A2・B2）。
 * 状態の行、入力待ちの問い、意図の全文、直近 3 つのツール呼び出し、サブエージェントとアーティファクトの数の札である。
 * コンテキスト使用量、コスト、ターンとトークンは見出しの (i)（presentDetails）に出す。
 * opencode の会話だけは、札の下に使用量の欄（usage）を置く（試作の C1。opencode には 5 時間・週の枠が無いため）。
 */
export function presentNowCard(i: CardInput, t: Translate): NowCardProps {
  const results = i.results ?? resultsOf(i.events);
  const steps = stripSteps(i, results);
  return {
    ...stripState(i, t, results),
    questionLabel: t(i.agent === 'opencode' ? 'session.strip.opencode.questionLabel' : 'session.strip.questionLabel'),
    intent: stripIntent(i, t),
    steps: steps.steps, stepsTotal: steps.total, stepsAll: steps.all,
    lanes: stripLanes(i, t),
    artifacts: { count: i.artifacts.length, items: i.artifacts },
    usage: stripUsage(i, t),
  };
}
