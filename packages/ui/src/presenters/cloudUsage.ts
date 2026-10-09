import type { CloudUsageDto, SyncStatusBody } from '@agent-hangar/shared';
import { relativeTime } from './format.ts';

export type CloudUsageTone = 'ok' | 'warn' | 'stop';
export type CloudUsageTile = { key: 'bill' | 'd1' | 'plan'; label: string; value: string; sub: string; tone: CloudUsageTone | 'muted' };
export type CloudUsageBar = { label: string; when: '今日' | '今月'; pct: number | null; value: string; tone: CloudUsageTone };
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
const compact = (v: number): string => (v >= 10_000 ? `${n(v / 10_000)} 万` : n(v));

function amount(consumed: number, unit: string, included: number | null): string {
  const c = unit === 'GB-月' ? (Math.round(consumed * 100) / 100).toString() : n(consumed);
  if (included === null) return `${c} ${unit}`;
  return unit === '回' ? `${c} / ${compact(included)}` : `${c} / ${n(included)} ${unit}`;
}

export function presentCloudUsage(u: CloudUsageDto | null, sync: SyncStatusBody | null, now: number, tz?: string): CloudUsageProps | null {
  if (!u) return null;
  const unknown = u.source === 'unknown';
  // 上限で退いているか。Task 7 で sync.limitedUntil に替える。
  const limited = sync?.state === 'paused' && sync.pausedReason === 'quota';
  const limit = u.limits.d1RowsPerDay;
  const d1 = unknown ? null : u.today.d1RowsWritten;
  const d1Pct = d1 === null ? null : pct(d1, limit);
  const tone: CloudUsageTone = limited ? 'stop' : d1 !== null && d1 >= limit * WARN_RATIO ? 'warn' : 'ok';
  const reset = hm(u.today.resetAt, tz);
  const paid = u.plan?.workersPaid ?? false;
  // 一時停止と上限の間はサーバが Cloudflare に問い合わせないので、トークンの有無は分からない。
  // 数が分からなくても「トークンが要ります」とは言わず、止めているからだと言う。トークンの失効の知らせ（notice）はそのまま出す。
  const pausedNoFetch = unknown && sync?.state === 'paused' && !u.notice;
  const missing = pausedNoFetch ? '同期の停止中' : 'トークンが要ります';

  const tiles: CloudUsageTile[] = [
    u.month ? { key: 'bill', label: '今月の請求', value: `$${u.month.billedUsd.toFixed(2)}`, sub: u.month.throughDay ? `${dayMd(u.month.throughDay)} 分まで` : '', tone: 'ok' } : { key: 'bill', label: '今月の請求', value: '—', sub: missing, tone: 'muted' },
    d1 === null || d1Pct === null
      ? { key: 'd1', label: 'D1 の書き込み（今日）', value: '—', sub: missing, tone: limited ? 'stop' : 'muted' }
      : { key: 'd1', label: 'D1 の書き込み（今日）', value: `${Math.round(d1Pct)}%`, sub: `${n(d1)} 行`, tone },
    u.plan ? { key: 'plan', label: 'プラン', value: u.plan.label.split(' · ')[0]!, sub: u.plan.label.split(' · ')[1] ?? '', tone: 'ok' } : { key: 'plan', label: 'プラン', value: '—', sub: missing, tone: 'muted' },
  ];
  // 数が分からないときは今日の棒を描かない（試作の Q1）。
  const req = u.today.workersRequests;
  const today: CloudUsageBar[] = paid || d1 === null ? [] : [
    { label: 'D1 の書き込み', when: '今日', pct: d1Pct, value: `${n(d1)} / ${n(limit)} 行`, tone },
    { label: 'Workers の要求', when: '今日', pct: req === null ? null : pct(req, u.limits.workersRequestsPerDay), value: req === null ? '—' : `${n(req)} / ${n(u.limits.workersRequestsPerDay)} 回`, tone: 'ok' },
  ];
  const month: CloudUsageBar[] = (u.month?.rows ?? []).map((r) => ({ label: r.label, when: '今月', pct: r.included === null ? null : pct(r.consumed, r.included), value: amount(r.consumed, r.unit, r.included), tone: 'ok' }));

  // 期の初めは請求の行がまだ無く、始まりの日が空になる。そのときは期の添え書きを出さない。
  const monthLegend = u.month && md(u.month.periodStart) ? [`今月は ${md(u.month.periodStart)}〜${u.month.periodEnd ? md(u.month.periodEnd) : ''}`] : [];
  // 止まっている間は帯が戻る時刻を言うので出さない。数が分からないときは戻る時刻を出どころの行に添える。
  const legend: string[] = paid ? monthLegend
    : limited || d1 === null ? []
    : tone === 'warn' ? [`あと ${n(Math.max(0, limit - d1))} 行で無料枠の上限です · ${reset} に戻る`]
    : [`今日の枠は ${reset} に戻る`, ...monthLegend];

  const source = unknown ? `数は不明（hangar は数えません）${limited ? '' : ` · 今日の枠は ${reset} に戻る`}`
    : u.stale ? `Cloudflare の数 · ${u.fetchedAt ? hm(u.fetchedAt, tz) : ''} · 取得に失敗`
    : `Cloudflare の数 · ${relativeTime(u.fetchedAt, now)}`;

  let strip: CloudUsageProps['strip'] = null;
  if (limited) {
    strip = { tone: 'stop', text: `Cloudflare の無料枠の上限に達したので、同期を止めています。${reset} に枠が戻ると、自動で再開します。` };
  } else if (pausedNoFetch) {
    strip = { tone: 'info', text: '同期を止めている間は Cloudflare に問い合わせません。再開すると Cloudflare の数と今月の費用が出ます。' };
  } else if (unknown) {
    strip = { tone: 'info', text: u.notice ?? 'Cloudflare の数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。' };
  }

  return { tiles: paid ? tiles.filter((t) => t.key !== 'd1') : tiles, bars: [...today, ...month], splitAfter: today.length, legend, source, strip, command: unknown && !pausedNoFetch && !limited ? TOKEN_COMMAND : null };
}
