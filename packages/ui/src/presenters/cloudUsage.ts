import type { CloudUsageDto, SyncStatusBody } from '@agent-hangar/shared';
import { relativeTime } from './format.ts';

export type CloudUsageTone = 'ok' | 'warn' | 'stop';
export type CloudUsageTile = { key: 'bill' | 'd1' | 'plan'; label: string; value: string; sub: string; tone: CloudUsageTone | 'muted' };
export type CloudUsageBar = { label: string; when: '今日' | '今月'; pct: number | null; tickPct: number | null; value: string; tone: CloudUsageTone };
/** 設定の「使用量と費用」。試作 usage-merged.html の左上が正本。 */
export type CloudUsageProps = { tiles: CloudUsageTile[]; bars: CloudUsageBar[]; splitAfter: number; legend: string[]; source: string; strip: { tone: 'stop' | 'info'; text: string } | null; command: string | null };

/** 止める線の何割で注意の色にするか（仕様の決めずに置いた値）。 */
const WARN_OF_STOP = 0.75;
const TOKEN_COMMAND = 'npm run hangar -- setup cloud --usage-token';

const n = (v: number): string => v.toLocaleString('en-US');
const pct = (used: number, limit: number): number => Math.round((used / limit) * 10_000) / 100;
const hm = (ms: number, tz?: string): string => new Intl.DateTimeFormat('ja-JP', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(ms);
const dayMd = (day: string): string => { const [, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}`; };
/** 請求の期の日付。期は UTC の日で区切られるので、端末の時差で書かずに UTC の日のまま書く。読めない値（期の初めの空文字など）は何も書かない。 */
const md = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? dayMd(iso.slice(0, 10)) : '');
const compact = (v: number): string => (v >= 10_000 ? `${n(v / 10_000)} 万` : n(v));
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function amount(consumed: number, unit: string, included: number | null): string {
  const c = unit === 'GB-月' ? (Math.round(consumed * 100) / 100).toString() : n(consumed);
  if (included === null) return `${c} ${unit}`;
  return unit === '回' ? `${c} / ${compact(included)}` : `${c} / ${n(included)} ${unit}`;
}

export function presentCloudUsage(u: CloudUsageDto | null, sync: SyncStatusBody | null, now: number, tz?: string): CloudUsageProps | null {
  if (!u) return null;
  const est = u.source === 'estimate';
  const stopLine = u.limits.d1RowsPerDay * u.limits.stopRatio;
  const d1 = u.today.d1RowsWritten;
  const quotaPaused = sync?.state === 'paused' && sync.pausedReason === 'quota';
  const tone: CloudUsageTone = quotaPaused ? 'stop' : d1 >= stopLine * WARN_OF_STOP ? 'warn' : 'ok';
  const reset = hm(u.today.resetAt, tz);
  const d1Pct = pct(d1, u.limits.d1RowsPerDay);
  const approx = est ? '約 ' : '';
  const paid = u.plan?.workersPaid ?? false;

  const tiles: CloudUsageTile[] = [
    u.month ? { key: 'bill', label: '今月の請求', value: `$${u.month.billedUsd.toFixed(2)}`, sub: u.month.throughDay ? `${dayMd(u.month.throughDay)} 分まで` : '', tone: 'ok' } : { key: 'bill', label: '今月の請求', value: '—', sub: 'トークンが要ります', tone: 'muted' },
    { key: 'd1', label: 'D1 の書き込み（今日）', value: `${approx}${Math.round(d1Pct)}%`, sub: est ? '見積もり' : `${n(d1)} 行`, tone },
    u.plan ? { key: 'plan', label: 'プラン', value: u.plan.label.split(' · ')[0]!, sub: u.plan.label.split(' · ')[1] ?? '', tone: 'ok' } : { key: 'plan', label: 'プラン', value: '—', sub: 'トークンが要ります', tone: 'muted' },
  ];
  const today: CloudUsageBar[] = paid ? [] : [
    { label: 'D1 の書き込み', when: '今日', pct: d1Pct, tickPct: u.limits.stopRatio * 100, value: `${approx}${n(d1)} / ${n(u.limits.d1RowsPerDay)} 行`, tone },
    {
      label: 'Workers の要求', when: '今日', pct: u.today.workersRequests === null ? null : pct(u.today.workersRequests, u.limits.workersRequestsPerDay), tickPct: u.limits.stopRatio * 100,
      value: u.today.workersRequests === null ? '—' : est ? `この PC ${n(u.today.workersRequests)} 回` : `${n(u.today.workersRequests)} / ${n(u.limits.workersRequestsPerDay)} 回`, tone: 'ok',
    },
  ];
  const month: CloudUsageBar[] = (u.month?.rows ?? []).map((r) => ({ label: r.label, when: '今月', pct: r.included === null ? null : pct(r.consumed, r.included), tickPct: null, value: amount(r.consumed, r.unit, r.included), tone: 'ok' }));

  // 凡例は試作 usage-merged.html の状態ごとの形に従う。
  // 停止中は帯が戻る時刻を言うので出さない。見積もりは戻る時刻を出典の行に添える。止まりそうなときは残りの行数だけにする。
  // 期の初めは請求の行がまだ無く、始まりの日が空になる。そのときは期の添え書きを出さない。
  const monthLegend = u.month && md(u.month.periodStart) ? [`今月は ${md(u.month.periodStart)}〜${u.month.periodEnd ? md(u.month.periodEnd) : ''}`] : [];
  const legend: string[] = paid ? monthLegend
    : quotaPaused ? []
    : tone === 'warn' ? [`あと${est ? '約' : ''} ${n(Math.ceil(stopLine - d1))} 行で同期を止めます · ${reset} に戻る`]
    : est ? []
    : [`今日の枠は ${reset} に戻る · 目盛りの ${Math.round(u.limits.stopRatio * 100)}% で同期を止める`, ...monthLegend];

  // 止まりそうなときは凡例が戻る時刻を言うので、出どころの行には重ねない。
  const source = est ? `hangar の見積もり（実際より 1〜4 割多め）${quotaPaused || tone === 'warn' ? '' : `· ${reset} に戻る`}`
    : u.stale ? `Cloudflare の数 · ${u.fetchedAt ? hm(u.fetchedAt, tz) : ''} · 取得に失敗`
    : `Cloudflare の数 · ${relativeTime(u.fetchedAt, now)}`;

  let strip: CloudUsageProps['strip'] = null;
  if (quotaPaused) {
    const back = sync?.quotaPausedDay && sync.quotaPausedDay < utcDay(now);
    const gap = !est && d1 < stopLine ? `（Cloudflare の数では ${Math.round(d1Pct)}%）` : '';
    strip = back
      ? { tone: 'stop', text: '無料枠の 80% に届いたので同期を止めました。枠は戻っています。「同期を再開」で再開できます。' }
      : { tone: 'stop', text: `無料枠の 80% に届いたので同期を止めました${gap}。${reset} に枠が戻ります。戻ったあと「同期を再開」で再開できます。` };
  } else if (est) {
    strip = { tone: 'info', text: u.notice ?? 'Cloudflare の正確な数、R2、今月の費用は、読み取り専用のトークンを入れると出ます。' };
  }

  return { tiles: paid ? tiles.filter((t) => t.key !== 'd1') : tiles, bars: [...today, ...month], splitAfter: today.length, legend, source, strip, command: est ? TOKEN_COMMAND : null };
}
