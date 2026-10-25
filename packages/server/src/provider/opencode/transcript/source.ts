import type { IndexBatch, IndexRecord, TranscriptSink, TranscriptSource } from '../../../agent/types.ts';
import { readStoredPage } from '../../../transcript/stored.ts';
import { foldActivity, type Activity } from '../../claude-code/transcript/activity.ts';
import { OpencodeClient } from '../client.ts';
import type { OpencodeEventListener } from '../live.ts';
import { convertMessages, messageIdOf, settledCount } from './convert.ts';

/**
 * opencode のトランスクリプトの面（docs/design.md「opencode のトランスクリプト」）。
 *
 * 本文は serve の API（`GET /api/session/{id}/message`）から読み、共通の形（convert.ts）に直して、索引の口（sink.batch）へ渡す。
 * DB に書くのは索引の書き手（indexer/write.ts）で、本文は agent_events に入り、読む側は transcript/stored.ts である。opencode の SQLite は読まない。
 *
 * 読む契機は、状態の面（live.ts）が読んでいる serve の出来事の流れのうち、本文が伸びたことを表すものである（TRIGGERS）。
 * 流れを別に開かないのは、serve 1 本に流れを 1 本だけにし、つなぎ直しと取り直しを状態の面の 1 か所に置くためである。
 * つないだとき（つなぎ直しも）の `server.connected` でも読むので、切れていた間に伸びた分も拾う。
 *
 * 読み方は、新しい方からページを送り、前に写した最後のメッセージに着いたら止める。その手前（より新しいもの）が続きである。
 * まだ終わっていない返答は、まだ無いものとして写さない（convert.ts の settledCount）。写しは続きを足すだけにするためである。
 * 前に写した最後のメッセージが見つからなければ（巻き戻しで消えた、など）、全部を読み直して作り直しの束にする。
 * どこまで写したかはメモリだけに持つ。載せ直したとき（hangar の再起動、再開）は分からないので、全部を作り直しの束として読み直す。
 */

/**
 * 本文が伸びたことを表す出来事。手順の終わり、文の終わり、使用量、作業の終わり、発言が届いたとき、モデルの切り替え、つないだとき。
 * モデルの切り替えは、TUI で /models を選んだ後の最初の送信で届き、本文に model-switched の印が 1 つ入る（返答より先）。
 */
const TRIGGERS = new Set([
  'server.connected',
  'session.step.ended', 'session.step.failed',
  'session.text.ended',
  'session.usage.updated',
  'session.inbox.delivered',
  'session.model.selected',
  'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
]);

/** 読む会話。serve は会話の serve（url とパスワード）。 */
export type OpencodeTranscriptTarget = { providerSessionId: string; cwd: string; serve: { url: string; password: string } };

export type OpencodeTranscriptOptions = {
  /** serve の出来事の口（live.ts の OpencodeLive.onEvent）。渡さなければ、載せたときと sync でだけ読む。 */
  events?: (cb: OpencodeEventListener) => () => void;
  /** 1 ページのメッセージの数。既定は 100。 */
  pageSize?: number;
  /** 出来事から読み直すまでの間。続けて届く出来事（手順の終わり、使用量、文の終わり）を 1 回にまとめる。既定は 150 ミリ秒。 */
  debounceMs?: number;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
};

type Follow = {
  t: OpencodeTranscriptTarget;
  client: OpencodeClient;
  /** 前に写した最後のメッセージの ID。まだ写していなければ null。 */
  last: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  /** 読んでいる途中に、もう一度読むよう頼まれた。 */
  again: boolean;
};

export class OpencodeTranscript implements TranscriptSource {
  readonly readPage = readStoredPage;
  private sink: TranscriptSink | null = null;
  private off: (() => void) | null = null;
  private readonly follows = new Map<string, Follow>();
  private readonly pageSize: number;
  private readonly debounceMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: OpencodeTranscriptOptions = {}) {
    this.pageSize = o.pageSize ?? 100;
    this.debounceMs = o.debounceMs ?? 150;
    this.log = o.log ?? ((line) => { console.warn(line); });
  }

  /** 索引が始まったときに呼ばれる。始まる前に載せた会話は、ここで読む。 */
  start(sink: TranscriptSink): void {
    if (this.sink) return;
    this.sink = sink;
    this.off = this.o.events?.((id, type) => this.onEvent(id, type)) ?? null;
    for (const f of this.follows.values()) this.request(f, 0);
  }

  stop(): void {
    this.sink = null;
    this.off?.();
    this.off = null;
    for (const f of this.follows.values()) this.clearTimer(f);
  }

  /** 会話を載せ、すぐに全部を読む。同じ会話を載せ直したら、どこまで写したかを忘れて全部を読み直す。 */
  track(t: OpencodeTranscriptTarget): void {
    this.untrack(t.providerSessionId);
    const f: Follow = { t, client: new OpencodeClient(t.serve, { timeoutMs: this.o.requestTimeoutMs ?? 10_000 }), last: null, timer: null, running: null, again: false };
    this.follows.set(t.providerSessionId, f);
    if (this.sink) this.request(f, 0);
  }

  untrack(providerSessionId: string): void {
    const f = this.follows.get(providerSessionId);
    if (!f) return;
    this.clearTimer(f);
    this.follows.delete(providerSessionId);
  }

  /** いま読む。読んでいる途中なら、その後にもう一度読み、終わるまで待つ。載せていない会話と、索引が始まる前は何もしない。 */
  sync(providerSessionId: string): Promise<void> {
    const f = this.follows.get(providerSessionId);
    if (!f || !this.sink) return Promise.resolve();
    this.clearTimer(f);
    return this.run(f);
  }

  private onEvent(providerSessionId: string, type: string): void {
    if (!TRIGGERS.has(type)) return;
    const f = this.follows.get(providerSessionId);
    if (f && this.sink) this.request(f, this.debounceMs);
  }

  /** delayMs 後に読む。もう予約してあれば、それに任せる。 */
  private request(f: Follow, delayMs: number): void {
    if (f.timer) return;
    f.timer = setTimeout(() => { f.timer = null; void this.run(f); }, delayMs);
    f.timer.unref?.();
  }

  private clearTimer(f: Follow): void {
    if (f.timer) clearTimeout(f.timer);
    f.timer = null;
  }

  private live(f: Follow): boolean {
    return this.sink !== null && this.follows.get(f.t.providerSessionId) === f;
  }

  private run(f: Follow): Promise<void> {
    if (f.running) { f.again = true; return f.running; }
    const p = (async () => {
      try {
        do {
          f.again = false;
          try {
            await this.once(f);
          } catch (e) {
            this.log(`[opencode] could not read the transcript of ${f.t.providerSessionId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } while (f.again && this.live(f));
      } finally {
        f.running = null;
      }
    })();
    f.running = p;
    return p;
  }

  /** 新しい方からページを送って続きを集め、確定した分を束にして渡す。 */
  private async once(f: Follow): Promise<void> {
    const id = f.t.providerSessionId;
    const newestFirst: unknown[] = [];
    let found = false;
    let cursor: string | null = null;
    for (;;) {
      const page = await f.client.messages(id, { limit: this.pageSize, cursor });
      if (!this.live(f)) return;
      for (const m of page.data) {
        if (f.last !== null && messageIdOf(m) === f.last) { found = true; break; }
        newestFirst.push(m);
      }
      if (found || page.next === null || page.data.length === 0) break;
      cursor = page.next;
    }
    // 前に写した最後のメッセージが見つからなければ、集めたのは全部なので、作り直しとして渡す。
    const reset = !found;
    const oldestFirst = newestFirst.reverse();
    const take = oldestFirst.slice(0, settledCount(oldestFirst));
    const sink = this.sink;
    if (!sink) return;
    if (take.length === 0) {
      // 写したものが全部消えていたら、空の作り直しで索引を空にする。まだ何も写していなければ渡すものは無い。
      if (reset && f.last !== null) {
        sink.batch(batchOf(f, true, []));
        f.last = null;
      }
      return;
    }
    sink.batch(batchOf(f, reset, convertMessages(take)));
    f.last = messageIdOf(take[take.length - 1]);
  }
}

/** 主線の束。「いま」は最後の道具の呼び出しで、問いは答え（結果）が来たら消える（Claude と同じ畳み方）。使用制限は本文に無いので前の値のままにする。 */
function batchOf(f: Follow, reset: boolean, records: IndexRecord[]): IndexBatch {
  return {
    agent: 'opencode',
    providerSessionId: f.t.providerSessionId,
    agentId: null,
    cwd: f.t.cwd,
    reset,
    records,
    fold: {
      activity(prev: Activity | null) {
        let cur = prev;
        let asked = false;
        for (const r of records) {
          const was = cur;
          cur = foldActivity(cur, r.events);
          if (cur?.question && cur.question !== was?.question) asked = true;
        }
        return { next: cur, asked };
      },
      limit: (prev) => prev,
    },
  };
}
