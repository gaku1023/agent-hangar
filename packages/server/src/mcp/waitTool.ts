import type { LiveSessionDto, MobileWaiting, SessionWaitState } from '@agent-hangar/shared';
import { waitingOf } from '../agent/waiting.ts';
import type { Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import { msg } from '../i18n/message.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import { readEvents } from '../transcript/read.ts';
import { ToolError, type ToolContext, type ToolDeps } from './tools.ts';

/**
 * wait_for_session の既定の上限（秒）。
 * 省いた呼び手を、プロンプトキャッシュが切れる 5 分より前に返す。動いたままなら timeout で返り、呼び手はもう一度呼べる。
 */
export const DEFAULT_WAIT_SECONDS = 240;

/** 上限の上限（秒）。越えた指定は断らずに丸める。待ちが残り続けないように、1 回の呼び出しを 1 時間で必ず返す。 */
export const MAX_WAIT_SECONDS = 3600;

/** 待っている間に進みを流す間隔。呼び手が切るまでの 300 秒より十分短くとる。 */
export const WAIT_PROGRESS_MS = 30_000;

/** 様子を見る間隔。1 件の読み直しは軽く、人が待つ長さに比べて十分短い。 */
const POLL_MS = 1000;

/**
 * 送ってからターンの始まりが見えるまでの猶予。
 * 送った直後の idle は前のターンのものなので、終わりと読まない。ただ、斜線コマンドのようにターンにならない入力もあるので、待ち続けずに turn_started: false で返す。
 */
export const TURN_START_GRACE_MS = 30_000;

/** run があるのに live に載らないまま待つ長さ。ふつうの起動はこの内に載る。越えたら、起動の前の問いで止まっているものとして入力待ちで返す。 */
export const STARTUP_GRACE_MS = 60_000;

/** ターンが終わってから返答が本文に載るまでの猶予。本文の索引は状態より少し遅れる。 */
const RESULT_SETTLE_MS = 5000;

/** 本文から最後の返答を探す末尾の長さ。 */
const RESULT_TAIL = 50;

/** 登録の前の問いを読むときの画面の末尾の行数。 */
const SCREEN_TAIL_LINES = 12;

/** last_message の上限（文字数）。結果は呼び手の文脈に載るので、長すぎる返答は末尾を切る。 */
const LAST_MESSAGE_MAX = 20_000;

/** ターンの始まりの印。at は送った時刻、prepKey は起動前の準備の鍵、expectsReply は返答が来るはずか（プロンプトなしの起動は false）。 */
export type TurnMark = { at: number; prepKey?: string; expectsReply?: boolean };

/**
 * 会話ごとの最後の印。DB には置かない。サーバを起こし直せば印は消え、idle をそのまま終わりと読む（送ってから起こし直すまでの間の取りこぼしより、再起動の後で印を読み違えないほうを取る）。
 * サーバの中に 1 つで足りるので DB の口ごとに持つ。
 */
const marks = new WeakMap<Db, Map<string, TurnMark>>();

/** 入力を送った、または起動したことを残す。send_to_session と create_session が呼ぶ。 */
export function noteTurnStart(db: Db, sessionId: string, mark: TurnMark): void {
  let m = marks.get(db);
  if (!m) marks.set(db, (m = new Map()));
  m.set(sessionId, { expectsReply: true, ...mark });
}

export type WaitClock = { now(): number; sleep(ms: number): Promise<void> };
const REAL_CLOCK: WaitClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export type WaitResult = {
  session_id: string;
  state: SessionWaitState;
  /** failed の理由。not_running はプロセスが居ない、limit は使用制限で止まった。 */
  reason?: 'not_running' | 'limit';
  /** live の状態。動いていなければ null。 */
  status: LiveSessionDto['status'] | null;
  /** 入力待ちの中身。state が waiting のときだけ付く。 */
  waiting?: MobileWaiting;
  /** 最後の assistant の返答。本文が無ければ null。 */
  last_message: string | null;
  /** 送った入力でターンが始まったと確かめられたか。印が無い呼び出しでは付かない。 */
  turn_started?: boolean;
  waited_seconds: number;
  url: string;
};

const clip = (s: string): string => {
  const cs = [...s];
  return cs.length > LAST_MESSAGE_MAX ? `${cs.slice(0, LAST_MESSAGE_MAX - 1).join('')}…` : s;
};

/** 最後の返答とその時刻。本文が読めなければ null。 */
function lastReply(db: Db, id: string): { text: string; ts: number | null } | null {
  try {
    const events = readEvents(db, id, { latest: true, limit: RESULT_TAIL }).events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === 'assistant' && e.text.trim()) return { text: e.text, ts: e.ts ?? null };
    }
  } catch {
    /* 本文が無い会話でも、待った結果は返す */
  }
  return null;
}

/** 画面の末尾。登録の前の問いは本文にも live にも出ないので、何を聞かれているかは画面でしか分からない。 */
function screenTail(deps: ToolDeps, tmuxName: string): string {
  const raw = deps.runs.readScreen?.(tmuxName) ?? '';
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(-SCREEN_TAIL_LINES).join('\n');
}

/**
 * 指定した会話のターンの終わりか入力待ちまで待つ。
 * finished と waiting はそのときの様子を返す。timeout は動いたままで、もう一度呼べば続きを待てる。failed は待っても終わらない状態である。
 * 読み手はこの関数を定期実行（#549）からもそのまま呼べる。呼び手が MCP である必要はない。
 */
export async function waitForSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>, clock: WaitClock = REAL_CLOCK): Promise<WaitResult> {
  const id = typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id : null;
  if (!id) throw new ToolError(msg('mcp.args.sessionIdRequired'));
  const read = () => getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId });
  if (!read()) throw new ToolError(msg('mcp.error.sessionNotFound', { id }));
  // 自分のターンは、自分がこの呼び出しから戻るまで終わらない。
  if (ctx.sessionId === id) throw new ToolError(msg('mcp.wait.self'));
  const run = aliveRunForSession(deps.db, id, deps.deviceId);
  // ほかの PC の様子はこの PC の live に載らないので、待っても終わりが見えない。
  if (run && run.deviceId !== deps.deviceId) {
    const d = deps.db.prepare('select name from devices where id = ?').get(run.deviceId) as { name: string | null } | undefined;
    throw new ToolError(msg('mcp.screen.otherDevice', { device: d?.name ?? run.deviceId }));
  }
  const asked = typeof args.timeout_seconds === 'number' && Number.isFinite(args.timeout_seconds) ? args.timeout_seconds : DEFAULT_WAIT_SECONDS;
  const seconds = Math.min(Math.max(asked, 0), MAX_WAIT_SECONDS);
  const begun = clock.now();
  const deadline = begun + seconds * 1000;
  let seenBusy = false;
  let idleSince: number | null = null;
  let goneSince: number | null = null;

  const done = (state: SessionWaitState, o: { reason?: WaitResult['reason']; live?: LiveSessionDto | null; started?: boolean; mark?: TurnMark; waiting?: MobileWaiting } = {}): WaitResult => {
    const s = read();
    const reply = lastReply(deps.db, id);
    // 送った後の返答がまだ無ければ、前のターンの返答を今回の結果に見せない。
    const stale = o.mark !== undefined && o.mark.expectsReply !== false && (reply?.ts ?? 0) < o.mark.at;
    const waiting = o.waiting ?? (state === 'waiting' && o.live ? waitingOf(deps.db, id, o.live) : null);
    return {
      session_id: id, state, ...(o.reason ? { reason: o.reason } : {}), status: s?.live ?? null,
      ...(waiting ? { waiting } : {}), last_message: reply && !stale ? clip(reply.text) : null,
      ...(o.mark ? { turn_started: o.started ?? seenBusy } : {}),
      waited_seconds: Math.round((clock.now() - begun) / 1000),
      url: `http://127.0.0.1:${deps.port}/#/session/${id}`,
    };
  };

  for (;;) {
    const now = clock.now();
    const s = read();
    if (!s) throw new ToolError(msg('mcp.error.sessionNotFound', { id }));
    const mark = marks.get(deps.db)?.get(id);
    const live = deps.live().find((l) => l.sessionId === s.providerSessionId) ?? null;
    const inGrace = mark !== undefined && !seenBusy && now - mark.at < TURN_START_GRACE_MS;

    if (s.live === 'busy') {
      seenBusy = true;
      idleSince = null;
      goneSince = null;
    } else if (s.live === null) {
      idleSince = null;
      goneSince ??= now;
      const preparing = mark?.prepKey !== undefined && (deps.runs.prepRunning?.(mark.prepKey) ?? false);
      // run があって live に載っていないのは、起動の途中か、終わりの途中か、登録の前の問い（フォルダの信頼など）である。
      const alive = aliveRunForSession(deps.db, id, deps.deviceId);
      if (!preparing && !inGrace) {
        if (!alive || seenBusy) return done('failed', { reason: 'not_running', mark });
        if (now - goneSince >= STARTUP_GRACE_MS) return done('waiting', { mark, started: false, waiting: { kind: 'other', text: screenTail(deps, alive.tmuxName) } });
      }
    } else {
      goneSince = null;
      // 送った時刻より古い状態は、送る前のターンのものである。古い Claude は時刻を書かないので、そのときは猶予の中だけ待つ。
      const fresh = seenBusy || mark === undefined || (live?.statusAt !== undefined && live.statusAt > mark.at);
      if (fresh && s.live === 'waiting') return done('waiting', { live, mark, started: true });
      if (fresh || !inGrace) {
        if (s.live === 'waiting') return done('waiting', { live, mark, started: false });
        if (s.limit) return done('failed', { reason: 'limit', mark });
        idleSince ??= now;
        const reply = mark ? lastReply(deps.db, id) : null;
        const replied = mark === undefined || mark.expectsReply === false || (reply?.ts !== null && reply?.ts !== undefined && reply.ts >= mark.at);
        // 始まりが見えてからなら、残りは本文の遅れだけである。見えていなければ、起動直後の idle かもしれないので猶予まで待つ。
        const settling = seenBusy ? now - idleSince < RESULT_SETTLE_MS : inGrace;
        if (replied || !settling) return done('finished', { mark, started: seenBusy || replied });
      }
    }
    if (now >= deadline) return done('timeout', { live, mark });
    await clock.sleep(Math.min(POLL_MS, deadline - now));
  }
}
