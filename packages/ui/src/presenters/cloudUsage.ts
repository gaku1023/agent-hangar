import type { CloudUsageDto, SyncStatusBody, Translate } from '@agent-hangar/shared';
import { relativeTime } from './format.ts';

export type CloudUsageTone = 'ok' | 'warn' | 'stop';
export type CloudUsageTile = { key: 'bill' | 'd1' | 'plan'; label: string; value: string; sub: string; tone: CloudUsageTone | 'muted' };
export type CloudUsageBar = { label: string; /** 棒が見る期間。表示は `cloudUsage.when.<when>` から引く。 */ when: 'day' | 'month'; pct: number | null; value: string; tone: CloudUsageTone };
/** 設定の「使用量と費用」。試作 usage-merged.html の左上が正本。 */
export type CloudUsageProps = { tiles: CloudUsageTile[]; bars: CloudUsageBar[]; splitAfter: number; legend: string[]; source: string; strip: { tone: 'stop' | 'info'; text: string } | null; command: string | null };

/** 注意の色にする割合。D1 の 1 日の行の上限に対して見る（段 1 で、止める線は Cloudflare の上限そのものになった）。 */
const WARN_RATIO = 0.8;
const TOKEN_COMMAND = 'npm run hangar -- setup cloud --usage-token';

const n = (v: number): string => v.toLocaleString('en-US');
const pct = (used: number, limit: number): number => Math.round((used / limit) * 10_000) / 100;
const hm = (ms: number, tz?: string): string => new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(ms);
const dayMd = (day: string): string => { const [, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}`; };
/** 請求の期の日付。期は UTC の日で区切られるので、端末の時差で書かずに UTC の日のまま書く。読めない値（期の初めの空文字など）は何も書かない。 */
const md = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? dayMd(iso.slice(0, 10)) : '');
/** 大きい数の言い方。万を使う言語では「万」にまとめ、使わない言語では全部書く（辞書が決める）。 */
const compact = (t: Translate, v: number): string => (v >= 10_000 ? t('cloudUsage.amount.large', { man: n(v / 10_000), full: n(v) }) : n(v));

/** サーバが返す単位（Cloudflare の語）。知らない単位は、そのまま見せる。 */
const GB_MONTHS = 'GB-months';
const COUNT = 'Count';

function unitLabel(t: Translate, unit: string): string {
  if (unit === GB_MONTHS) return t('cloudUsage.unit.gbMonths');
  if (unit === COUNT) return t('cloudUsage.unit.count');
  return unit;
}

function amount(t: Translate, consumed: number, unit: string, included: number | null): string {
  const c = unit.startsWith('GB') ? (Math.round(consumed * 100) / 100).toString() : n(consumed);
  if (included === null) return `${c} ${unitLabel(t, unit)}`;
  return unit === COUNT ? `${c} / ${compact(t, included)}` : `${c} / ${n(included)} ${unitLabel(t, unit)}`;
}

/** サーバが返す行の名前（Cloudflare の語の頭）。知らない名前は、そのまま見せる。 */
const ROW_LABELS: readonly (readonly [prefix: string, key: 'cloudUsage.row.r2Storage' | 'cloudUsage.row.r2WriteOps' | 'cloudUsage.row.r2ReadOps'])[] = [
  ['R2 Data Storage', 'cloudUsage.row.r2Storage'],
  ['R2 Storage Class A Operations', 'cloudUsage.row.r2WriteOps'],
  ['R2 Storage Class B Operations', 'cloudUsage.row.r2ReadOps'],
];
const rowLabel = (t: Translate, name: string): string => {
  const hit = ROW_LABELS.find(([prefix]) => name.startsWith(prefix));
  return hit ? t(hit[1]) : name;
};

export function presentCloudUsage(t: Translate, u: CloudUsageDto | null, sync: SyncStatusBody | null, now: number, tz?: string): CloudUsageProps | null {
  if (!u) return null;
  const unknown = u.source === 'unknown';
  // 上限で退いているか。
  const limitedUntil = sync?.state === 'paused' ? sync.limitedUntil : null;
  const limited = limitedUntil !== null;
  const limit = u.limits.d1RowsPerDay;
  const d1 = unknown ? null : u.today.d1RowsWritten;
  const d1Pct = d1 === null ? null : pct(d1, limit);
  const tone: CloudUsageTone = limited ? 'stop' : d1 !== null && d1 >= limit * WARN_RATIO ? 'warn' : 'ok';
  const reset = hm(u.today.resetAt, tz);
  const paid = u.plan?.workersPaid ?? false;
  // 一時停止と上限の間はサーバが Cloudflare に問い合わせないので、トークンの有無は分からない。
  // 数が分からなくても「トークンが要ります」とは言わず、止めているからだと言う。トークンの失効の知らせ（notice）はそのまま出す。
  const pausedNoFetch = unknown && sync?.state === 'paused' && !u.notice;
  const missing = pausedNoFetch ? t('cloudUsage.missing.paused') : t('cloudUsage.missing.token');

  const tiles: CloudUsageTile[] = [
    u.month ? { key: 'bill', label: t('cloudUsage.tile.bill'), value: `$${u.month.billedUsd.toFixed(2)}`, sub: u.month.throughDay ? t('cloudUsage.tile.billThrough', { date: dayMd(u.month.throughDay) }) : '', tone: 'ok' } : { key: 'bill', label: t('cloudUsage.tile.bill'), value: '—', sub: missing, tone: 'muted' },
    d1 === null || d1Pct === null
      ? { key: 'd1', label: t('cloudUsage.tile.d1Today'), value: '—', sub: missing, tone: limited ? 'stop' : 'muted' }
      : { key: 'd1', label: t('cloudUsage.tile.d1Today'), value: `${Math.round(d1Pct)}%`, sub: t('cloudUsage.tile.rows', { n: n(d1) }), tone },
    u.plan ? { key: 'plan', label: t('cloudUsage.tile.plan'), value: t(u.plan.workersPaid ? 'cloudUsage.plan.workersPaid' : 'cloudUsage.plan.workersFree'), sub: u.plan.r2Paid ? t('cloudUsage.plan.r2Paid') : '', tone: 'ok' } : { key: 'plan', label: t('cloudUsage.tile.plan'), value: '—', sub: missing, tone: 'muted' },
  ];
  // 数が分からないときは今日の棒を描かない（試作の Q1）。
  const req = u.today.workersRequests;
  const today: CloudUsageBar[] = paid || d1 === null ? [] : [
    { label: t('cloudUsage.bar.d1'), when: 'day', pct: d1Pct, value: t('cloudUsage.bar.rowsOf', { used: n(d1), limit: n(limit) }), tone },
    { label: t('cloudUsage.bar.workers'), when: 'day', pct: req === null ? null : pct(req, u.limits.workersRequestsPerDay), value: req === null ? '—' : t('cloudUsage.bar.requestsOf', { used: n(req), limit: n(u.limits.workersRequestsPerDay) }), tone: 'ok' },
  ];
  const month: CloudUsageBar[] = (u.month?.rows ?? []).map((r) => ({ label: rowLabel(t, r.label), when: 'month', pct: r.included === null ? null : pct(r.consumed, r.included), value: amount(t, r.consumed, r.unit, r.included), tone: 'ok' }));

  // 期の初めは請求の行がまだ無く、始まりの日が空になる。そのときは期の添え書きを出さない。
  const monthLegend = u.month && md(u.month.periodStart) ? [t('cloudUsage.legend.month', { from: md(u.month.periodStart), to: u.month.periodEnd ? md(u.month.periodEnd) : '' })] : [];
  // 止まっている間は帯が戻る時刻を言うので出さない。数が分からないときは戻る時刻を出どころの行に添える。
  const legend: string[] = paid ? monthLegend
    : limited || d1 === null ? []
    : tone === 'warn' ? [t('cloudUsage.legend.nearLimit', { n: n(Math.max(0, limit - d1)), reset })]
    : [t('cloudUsage.legend.resetToday', { reset }), ...monthLegend];

  const source = unknown ? `${t('cloudUsage.source.unknown')}${limited ? '' : ` · ${t('cloudUsage.legend.resetToday', { reset })}`}`
    : u.stale ? t('cloudUsage.source.stale', { time: u.fetchedAt ? hm(u.fetchedAt, tz) : '' })
    : t('cloudUsage.source.fresh', { when: relativeTime(t, u.fetchedAt, now) });

  let strip: CloudUsageProps['strip'] = null;
  if (limitedUntil !== null) {
    // 戻る時刻は同期の戻る時刻から出す。UTC の 0 時の直後に断られたときは 0 時でないので、ヘッダーとそろえる。
    strip = { tone: 'stop', text: t('cloudUsage.strip.limited', { time: hm(limitedUntil, tz) }) };
  } else if (pausedNoFetch) {
    strip = { tone: 'info', text: t('cloudUsage.strip.pausedNoFetch') };
  } else if (unknown) {
    strip = { tone: 'info', text: u.notice ?? t('cloudUsage.strip.needToken') };
  }

  return { tiles: paid ? tiles.filter((tile) => tile.key !== 'd1') : tiles, bars: [...today, ...month], splitAfter: today.length, legend, source, strip, command: unknown && !pausedNoFetch && !limited ? TOKEN_COMMAND : null };
}
