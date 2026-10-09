import { CLOUD_FREE_LIMITS, nextUtcMidnight, r2Included, type CloudUsageBody, type CloudUsageDto } from '@agent-hangar/shared';
import type { CloudClient } from './client.ts';
import type { Timers } from './engine.ts';

/** 使用量を取りに行く間隔。1 台あたり 1 日 288 回で、Workers の枠の 0.3% にあたる。 */
export const USAGE_POLL_MS = 5 * 60_000;

const INVALID = 'トークンが無効です';
const UNIT: Record<string, string> = { 'GB-months': 'GB-月', Count: '回' };
const ROW_LABEL: [prefix: string, label: string][] = [
  ['R2 Data Storage', 'R2 の保存'],
  ['R2 Storage Class A Operations', 'R2 の書く操作'],
  ['R2 Storage Class B Operations', 'R2 の読む操作'],
];
const rowLabel = (name: string): string => ROW_LABEL.find(([p]) => name.startsWith(p))?.[1] ?? name;

function planLabel(p: NonNullable<Extract<CloudUsageBody, { configured: true }>['plan']>): string {
  if (p.workersPaid) return 'Workers Paid';
  const r2 = p.items.some((i) => i.id === 'r2_paid') ? ' · R2 従量' : '';
  return `Workers 無料${r2}`;
}

/**
 * 数の分からない形。トークンが無い端末、古い Worker、一時停止や上限で問い合わせていないとき、一度も取れないまま失敗したときに使う。
 * hangar は量を数えないので（段 1、D4）、今日の数は null にする。
 */
function unknown(o: { now: number; stale: boolean; notice: string | null }): CloudUsageDto {
  return {
    source: 'unknown', fetchedAt: null, stale: o.stale, notice: o.notice,
    limits: { d1RowsPerDay: CLOUD_FREE_LIMITS.d1RowsPerDay, workersRequestsPerDay: CLOUD_FREE_LIMITS.workersRequestsPerDay },
    today: { d1RowsWritten: null, workersRequests: null, resetAt: nextUtcMidnight(o.now) },
    plan: null, month: null,
  };
}

export function toUsageDto(body: CloudUsageBody | null, o: { now: number; stale: boolean; lastGood: CloudUsageDto | null }): CloudUsageDto {
  if (body === null || !body.configured) return o.stale && o.lastGood ? { ...o.lastGood, stale: true } : unknown({ ...o, notice: null });
  const invalid = body.errors.find((e) => e.message.startsWith(INVALID));
  if (invalid && !body.today && !body.plan && !body.month) return unknown({ ...o, notice: invalid.message });
  // 今日の数が無いまま Cloudflare の数として出さない。前に取れた今日の数も無ければ「数は不明」の姿にする。
  if (!body.today && !o.lastGood?.today) return unknown({ ...o, stale: true, notice: invalid?.message ?? null });
  const base = unknown({ ...o, notice: null });
  return {
    ...base,
    source: 'cloudflare',
    fetchedAt: body.fetchedAt,
    today: body.today ? { d1RowsWritten: body.today.d1RowsWritten, workersRequests: body.today.workersRequests, resetAt: base.today.resetAt } : (o.lastGood?.today ?? base.today),
    plan: body.plan ? { label: planLabel(body.plan), workersPaid: body.plan.workersPaid } : (o.lastGood?.plan ?? null),
    month: body.month
      ? {
          periodStart: body.month.periodStart, periodEnd: body.plan?.periodEnd ?? o.lastGood?.month?.periodEnd ?? null, throughDay: body.month.throughDay, billedUsd: body.month.billedUsd,
          rows: body.month.services.map((s) => ({ label: rowLabel(s.name), consumed: s.consumed, unit: UNIT[s.unit] ?? s.unit, included: r2Included(s.name) })),
        }
      : (o.lastGood?.month ?? null),
    stale: o.stale || body.errors.length > 0,
  };
}

// 呼ぶたびに大域の setInterval を引く。読み込み時に取り込むと、試験の偽の時計が効かない。
const REAL_TIMERS: Pick<Timers, 'setInterval' | 'clearInterval'> = {
  setInterval: ((fn: () => void, ms: number) => setInterval(fn, ms)) as typeof setInterval,
  clearInterval: ((t: ReturnType<typeof setInterval>) => clearInterval(t)) as typeof clearInterval,
};

/**
 * 使用量を取りに行き、画面へ配る。設計は仕様の「2. 端末のサーバ」。
 * 一時停止の間は外と話さない（決定 4）ので、最後の値を返すだけにする。
 */
export class CloudUsagePoller {
  private last: CloudUsageDto | null = null;
  private lastGood: CloudUsageDto | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<CloudUsageDto | null> | null = null;
  /** stop の後に届いた結果は捨てる。閉じた DB を読まず、閉じたハブへも配らない。 */
  private stopped = false;
  private readonly now: () => number;
  private readonly timers: Pick<Timers, 'setInterval' | 'clearInterval'>;

  constructor(private readonly o: { client: CloudClient | null; isPaused: () => boolean; broadcast: (u: CloudUsageDto) => void; now?: () => number; timers?: Pick<Timers, 'setInterval' | 'clearInterval'> }) {
    this.now = o.now ?? (() => Date.now());
    this.timers = o.timers ?? REAL_TIMERS;
  }

  current(): CloudUsageDto | null { return this.last; }

  start(): void {
    if (!this.o.client || this.timer) return;
    this.stopped = false;
    void this.refresh();
    this.timer = this.timers.setInterval(() => { void this.refresh(); }, USAGE_POLL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { this.timers.clearInterval(this.timer); this.timer = null; }
  }

  /** 決して reject しない。呼び手の多くは結果を捨てる（void）ので、落ちればプロセスごと落ちる。一時停止と上限で退いている間は外と話さない（isPaused）。 */
  refresh(): Promise<CloudUsageDto | null> {
    if (!this.o.client || this.stopped) return Promise.resolve(this.o.client ? this.last : null);
    try {
      if (this.o.isPaused()) return Promise.resolve(this.last ?? this.publish(toUsageDto(null, { now: this.now(), stale: false, lastGood: null })));
    } catch {
      return Promise.resolve(this.last);
    }
    this.inflight ??= this.load().catch(() => this.last).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<CloudUsageDto | null> {
    const now = this.now();
    let body: CloudUsageBody;
    try {
      body = await this.o.client!.usage();
    } catch {
      if (this.stopped) return this.last;
      // 同期は止めない。トーストも出さない。設定画面の出どころの文だけで知らせる。
      return this.publish(toUsageDto(null, { now, stale: true, lastGood: this.lastGood }));
    }
    if (this.stopped) return this.last;
    const dto = toUsageDto(body, { now, stale: false, lastGood: this.lastGood });
    if (dto.source === 'cloudflare' && !dto.stale) this.lastGood = dto;
    return this.publish(dto);
  }

  private publish(dto: CloudUsageDto): CloudUsageDto {
    this.last = dto;
    this.o.broadcast(dto);
    return dto;
  }
}
