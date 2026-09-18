import type { LiveSessionDto, ServerEvent, SummarizerTestDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { buildSummaryInput, CANNED_INPUT } from './input.ts';
import type { Summarizer, SummaryInput, SummaryOutput } from './types.ts';

const STALE_TURNS = 5;

/** 要約が土台のままか、最後の更新から 5 ターン以上進んでいれば作り直す。セッションが無ければ偽。 */
export function isSummaryStale(db: Db, sessionId: string): boolean {
  const s = db.prepare('select 1 from sessions where id = ? and deleted_at is null').get(sessionId);
  if (!s) return false;
  const sum = db.prepare('select source, based_on_turns from session_summaries where session_id = ? and deleted_at is null').get(sessionId) as { source: string; based_on_turns: number } | undefined;
  if (!sum || sum.source === 'baseline') return true;
  const turns = (db.prepare('select turns from session_stats where session_id = ?').get(sessionId) as { turns: number } | undefined)?.turns ?? 0;
  return turns - sum.based_on_turns >= STALE_TURNS;
}

export type SummaryJobDeps = {
  db: Db;
  deviceId: string;
  summarizers: () => Summarizer[];
  live: () => LiveSessionDto[];
  hub: { broadcast(ev: ServerEvent): void };
  now?: () => number;
};

const UNAVAILABLE = '使えません（接続できないか、上限に達しています）';

type Attempt = { id: Summarizer['id']; message: string };
type Picked = { id: Summarizer['id']; ms: number; out: SummaryOutput };

/**
 * 事後要約の背景ジョブ。
 * 1 つずつ直列に走り、UI には「要約を作成中」を出す。
 * 過去の全件を埋めることはせず、契機（run の終了、セッションを開く、手動）で 1 件ずつ受け付ける。
 */
export class SummaryJob {
  private queue: string[] = [];
  private running: string | null = null;
  private waiters: (() => void)[] = [];

  constructor(private readonly deps: SummaryJobDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** 実行中の 1 件と待ち行列。bootstrap の summaryPending に載せる。 */
  pending(): string[] {
    return [...(this.running ? [this.running] : []), ...this.queue];
  }

  private isLive(sessionId: string): boolean {
    const s = this.deps.db.prepare('select provider_session_id p from sessions where id = ?').get(sessionId) as { p: string } | undefined;
    return !!s && this.deps.live().some((l) => l.sessionId === s.p);
  }

  /** 受け付けたら true。force でなければ stale とレジストリの不在を確かめる。 */
  enqueue(sessionId: string, force = false): boolean {
    if (this.running === sessionId || this.queue.includes(sessionId)) return false;
    const hasBody = this.deps.db.prepare('select 1 from event_index where session_id = ? and parent_agent is null limit 1').get(sessionId);
    if (!hasBody) return false;
    if (!force && (!isSummaryStale(this.deps.db, sessionId) || this.isLive(sessionId))) return false;
    this.queue.push(sessionId);
    this.deps.hub.broadcast({ type: 'summary.pending', sessionId });
    void this.drain();
    return true;
  }

  /** 待ち行列が空になるまで待つ。テストと終了処理で使う。 */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => { this.waiters.push(r); });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    while (this.queue.length > 0) {
      const id = this.queue.shift() as string;
      this.running = id;
      try {
        await this.summarizeOne(id);
      } catch (e) {
        this.deps.hub.broadcast({ type: 'summary.failed', sessionId: id, message: e instanceof Error ? e.message : String(e) });
      } finally {
        this.running = null;
      }
    }
    for (const w of this.waiters.splice(0)) w();
  }

  /** 使える要約器を順に試し、最初に成功したものを採る。 */
  private async trySummarizers(input: SummaryInput): Promise<Picked | { tried: Attempt[] }> {
    const tried: Attempt[] = [];
    for (const s of this.deps.summarizers()) {
      if (!(await s.available())) { tried.push({ id: s.id, message: UNAVAILABLE }); continue; }
      const t = this.now();
      try {
        const out = await s.summarize(input);
        return { id: s.id, ms: this.now() - t, out };
      } catch (e) {
        tried.push({ id: s.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { tried };
  }

  private async summarizeOne(sessionId: string): Promise<void> {
    const input = buildSummaryInput(this.deps.db, sessionId, this.isLive(sessionId));
    if (!input) throw new Error('本文がありません');
    const r = await this.trySummarizers(input);
    if ('tried' in r) throw new Error(r.tried.at(-1)?.message ?? '要約器がありません');
    upsertShared(this.deps.db, 'session_summaries', {
      session_id: sessionId,
      title: r.out.title,
      one_liner: r.out.oneLiner,
      body: r.out.body,
      state: r.out.state,
      next_steps: JSON.stringify(r.out.nextSteps),
      source: 'post_hoc',
      source_model: r.id,
      based_on_turns: input.turns,
    }, this.deps.deviceId, 'session_id');
    const s = getSession(this.deps.db, this.deps.live(), sessionId);
    if (s) this.deps.hub.broadcast({ type: 'session.upsert', session: s });
    this.deps.hub.broadcast({ type: 'summary.updated', sessionId });
  }

  /** Settings の「要約器を試す」。決め打ちの入力を投げ、DB には書かない。 */
  async test(input: SummaryInput = CANNED_INPUT): Promise<SummarizerTestDto> {
    const r = await this.trySummarizers(input);
    if ('tried' in r) return { ok: false, tried: r.tried };
    return {
      ok: true,
      id: r.id,
      ms: r.ms,
      summary: { title: r.out.title, oneLiner: r.out.oneLiner, body: r.out.body, state: r.out.state, nextSteps: r.out.nextSteps, source: 'post_hoc', sourceModel: r.id, basedOnTurns: input.turns },
    };
  }
}
