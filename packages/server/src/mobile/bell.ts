import WebSocket from 'ws';
import type { BellTarget } from '../sync/client.ts';
import type { Timers } from '../sync/engine.ts';

/** 生きているかを確かめる ping の間隔。Durable Object は setWebSocketAutoResponse で起きずに pong を返す。 */
export const BELL_PING_MS = 30_000;
/** pong（またはほかの文面）がこれだけ来なければ、つながりが死んだとみなして張り直す。 */
export const BELL_PONG_TIMEOUT_MS = 75_000;
/** 張り直しの待ちの最初の長さ。切れるたびに倍にする。 */
export const BELL_RETRY_MIN_MS = 1_000;
/** 張り直しの待ちの頭打ち。 */
export const BELL_RETRY_MAX_MS = 60_000;
/** 受ける 1 通の上限。問い合わせは封をした本文で 4 KiB までなので、余裕を持たせても小さく抑える。 */
const BELL_MAX_PAYLOAD = 64 * 1024;
/** つなぐときの手合わせの締め切り。 */
const BELL_HANDSHAKE_MS = 30_000;
/** 問い合わせの ID の長さの上限。形の違うものは答えない。 */
const MAX_ASK_ID = 128;
/** 断られたら張り直さず、つなぎ先が変わるまで止める応答（トークンが通らない、PC でない）。 */
const STOP_STATUSES: ReadonlySet<number> = new Set([401, 403]);
/** 呼び鈴を持たない Worker の応答（束縛が無い 503、口が無い 404、WebSocket として受けない 426）。すぐ連打せず、待ちを上限にする。 */
const SLOW_STATUSES: ReadonlySet<number> = new Set([404, 426, 503]);
/** Durable Object が、同じ PC の新しいつながりに替えたときの閉じる符号（packages/cloud/src/bellWire.ts の REPLACED_CLOSE_CODE）。 */
const REPLACED_CLOSE_CODE = 4000;

/** 手合わせで断られた応答の番号。ws は 'Unexpected server response: <番号>' の error を出す。 */
function refusedStatus(e: unknown): number | null {
  const m = e instanceof Error ? /^Unexpected server response: (\d+)$/.exec(e.message) : null;
  return m ? Number(m[1]) : null;
}

export type BellState = 'idle' | 'connecting' | 'open' | 'waiting';

export type MobileBellDeps = {
  /**
   * 今つなぐべき先。つながないときは null。
   * Worker の版が MOBILE_BELL_MIN_WORKER_COMPAT に届き、外していないスマホが 1 台以上あるときだけ返す（boot/mobile.ts）。
   */
  target: () => BellTarget | null;
  /** `{t:'launch'}` を受けた。起動の依頼が置かれたので、今の pull の道で受け取る（engine.pullNow）。 */
  onLaunch: () => void;
  /** `{t:'ask', id, sealed}` を受けた。封じた答えを返す。開けないものは null で、答えない。 */
  onAsk: (id: string, sealed: string) => Promise<string | null>;
  timers?: Timers;
  /** WebSocket を作る口。既定は ws。 */
  connect?: (t: BellTarget) => WebSocket;
};

const defaultConnect = (t: BellTarget): WebSocket => new WebSocket(t.url, { headers: t.headers, maxPayload: BELL_MAX_PAYLOAD, handshakeTimeout: BELL_HANDSHAKE_MS, perMessageDeflate: false });

/** つなぎ先の同一性。見出しにはトークンが入るので、この文字列はログに出さない。 */
const keyOf = (t: BellTarget): string => JSON.stringify([t.url, Object.entries(t.headers).sort(([a], [b]) => a.localeCompare(b))]);

/** ログには種類だけを出す。手合わせで断られたときは応答の番号だけを添える（ws の文には URL もトークンも入らない）。 */
function describe(e: unknown): string {
  const status = refusedStatus(e);
  if (status !== null) return `HTTP ${status}`;
  return e instanceof Error ? e.constructor.name : typeof e;
}

/**
 * Worker の呼び鈴（GET /m/bell の WebSocket、Durable Object の HangarBell）に張りっぱなしにする PC の側。
 *
 * つなぐかどうかは check のたびに target を読んで決める。
 * target が null になれば閉じて張り直さない。target が変われば（cloud.json の差し替え、トークンの読み直し）古いのを閉じて新しい先へつなぐ。
 * つながっている間は BELL_PING_MS ごとに文字列の ping を送り、BELL_PONG_TIMEOUT_MS のあいだ何も来なければ切って張り直す。
 * 切れたら BELL_RETRY_MIN_MS から倍々で BELL_RETRY_MAX_MS まで待って張り直す。文面が 1 通でも届いたら待ちを最初の長さに戻す。
 * 呼び鈴を持たない Worker の応答（404、426、503）と、同じ PC の新しいつながりに替えられた閉じ方（4000）では、すぐ連打せず待ちを BELL_RETRY_MAX_MS にする。
 * 401 と 403 で断られたら張り直さず、つなぎ先（宛先かトークン）が変わるまで止める。
 * 呼び鈴が無い Worker や、つながらない PC でも、起動の依頼は今までどおり 30 秒の pull で届く。呼び鈴は速くするだけである。
 * どの道も投げない。
 */
export class MobileBell {
  private readonly timers: Timers;
  private readonly connect: (t: BellTarget) => WebSocket;
  private sock: WebSocket | null = null;
  /** 今の、または最後に試したつなぎ先。 */
  private key: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = BELL_RETRY_MIN_MS;
  private ping: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** 401 か 403 で断られたつなぎ先。これと違う先になるまでつながない。 */
  private refusedKey: string | null = null;

  constructor(private readonly deps: MobileBellDeps) {
    this.timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this.connect = deps.connect ?? defaultConnect;
  }

  state(): BellState {
    if (this.sock) return this.sock.readyState === WebSocket.OPEN ? 'open' : 'connecting';
    return this.retry ? 'waiting' : 'idle';
  }

  /** 今のつなぎ先を読み、つなぐ、閉じる、張り直すを決める。きっかけや見回りのたびに呼んでよい。 */
  check(): void {
    if (this.stopped) return;
    let t: BellTarget | null;
    try {
      t = this.deps.target();
    } catch (e) {
      console.error('[mobile] could not read the bell target', describe(e));
      t = null;
    }
    if (!t) {
      this.drop();
      this.cancelRetry();
      this.key = null;
      this.backoff = BELL_RETRY_MIN_MS;
      return;
    }
    const key = keyOf(t);
    // 同じ先へつないでいる、または張り直しを待っているなら、待ちを守る。
    if (key === this.key && (this.sock || this.retry)) return;
    // 断られた先には、変わるまでつながない。
    if (key === this.refusedKey) return;
    this.refusedKey = null;
    this.drop();
    this.cancelRetry();
    if (key !== this.key) this.backoff = BELL_RETRY_MIN_MS;
    this.open(t, key);
  }

  /** 閉じて、以後はつながない。 */
  stop(): void {
    this.stopped = true;
    this.drop();
    this.cancelRetry();
  }

  private open(t: BellTarget, key: string): void {
    this.key = key;
    let s: WebSocket;
    try {
      s = this.connect(t);
    } catch (e) {
      console.error('[mobile] could not open the bell', describe(e));
      this.scheduleRetry();
      return;
    }
    this.sock = s;
    /** 手合わせで断られた応答の番号。error は close より先に届く。 */
    let refused: number | null = null;
    s.on('error', (e) => {
      if (this.sock !== s) return;
      refused = refusedStatus(e);
      console.error('[mobile] the bell failed', describe(e));
    });
    s.on('open', () => {
      if (this.sock !== s) return;
      this.armWatchdog(s);
      this.ping = this.timers.setInterval(() => {
        if (this.sock === s && s.readyState === WebSocket.OPEN) s.send('ping');
      }, BELL_PING_MS);
      this.ping.unref?.();
    });
    s.on('message', (data, isBinary) => {
      if (this.sock !== s) return;
      // 何か届けば生きている。待ちの長さも最初に戻す。
      this.armWatchdog(s);
      this.backoff = BELL_RETRY_MIN_MS;
      if (isBinary) return;
      this.onText(s, Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8'));
    });
    s.on('close', (code) => {
      if (this.sock !== s) return;
      this.sock = null;
      this.clearLive();
      if (refused !== null && STOP_STATUSES.has(refused)) {
        this.refusedKey = key;
        return;
      }
      if ((refused !== null && SLOW_STATUSES.has(refused)) || code === REPLACED_CLOSE_CODE) this.backoff = BELL_RETRY_MAX_MS;
      this.scheduleRetry();
    });
  }

  private onText(s: WebSocket, text: string): void {
    if (text === 'pong') return;
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m !== 'object' || m === null) return;
    const msg = m as { t?: unknown; id?: unknown; sealed?: unknown };
    if (msg.t === 'launch') {
      try { this.deps.onLaunch(); } catch (e) { console.error('[mobile] could not take the launch bell', describe(e)); }
      return;
    }
    if (msg.t === 'ask' && typeof msg.id === 'string' && msg.id.length > 0 && msg.id.length <= MAX_ASK_ID && typeof msg.sealed === 'string') {
      const id = msg.id;
      let answer: Promise<string | null>;
      try { answer = this.deps.onAsk(id, msg.sealed); } catch (e) { answer = Promise.reject(e); }
      void answer.then((sealed) => {
        // 答えを作る間に切れた、または張り直したなら送らない。Worker は 5 秒で待つのをやめる。
        if (sealed === null || this.sock !== s || s.readyState !== WebSocket.OPEN) return;
        s.send(JSON.stringify({ t: 'reply', id, sealed }));
      }).catch((e: unknown) => console.error('[mobile] could not answer the ask', describe(e)));
    }
  }

  private armWatchdog(s: WebSocket): void {
    if (this.watchdog) this.timers.clearTimeout(this.watchdog);
    this.watchdog = this.timers.setTimeout(() => {
      this.watchdog = null;
      if (this.sock !== s) return;
      console.error('[mobile] the bell went quiet; reconnecting');
      // terminate は close を後から出し、そこで張り直しを予約する。
      s.terminate();
    }, BELL_PONG_TIMEOUT_MS);
    this.watchdog.unref?.();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const ms = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BELL_RETRY_MAX_MS);
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      this.check();
    }, ms);
    this.retry.unref?.();
  }

  private cancelRetry(): void {
    if (this.retry) this.timers.clearTimeout(this.retry);
    this.retry = null;
  }

  private clearLive(): void {
    if (this.ping) this.timers.clearInterval(this.ping);
    if (this.watchdog) this.timers.clearTimeout(this.watchdog);
    this.ping = this.watchdog = null;
  }

  /** 今のつながりを外す。外した後に届く出来事は無視する（this.sock と比べる）。 */
  private drop(): void {
    const s = this.sock;
    this.sock = null;
    this.clearLive();
    if (!s) return;
    try {
      if (s.readyState === WebSocket.OPEN) s.close(1000);
      else s.terminate();
    } catch { /* 閉じるのに失敗しても、もう使わない */ }
  }
}
