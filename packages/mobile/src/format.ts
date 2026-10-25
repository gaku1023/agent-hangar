const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 待った時間（例「7時間4分」）。札の右上に詰めて出す。 */
export function waitedFor(ms: number): string {
  const t = Math.max(0, ms);
  if (t < MIN) return '1分未満';
  const d = Math.floor(t / DAY);
  const h = Math.floor((t % DAY) / HOUR);
  const m = Math.floor((t % HOUR) / MIN);
  if (d > 0) return `${d}日${h}時間`;
  if (h > 0) return `${h}時間${m}分`;
  return `${m}分`;
}

/** 動いている長さ（例「40 分」「2 時間 5 分」）。細い行の右に出す。 */
export function elapsed(ms: number): string {
  const t = Math.max(0, ms);
  if (t < MIN) return '1 分未満';
  const d = Math.floor(t / DAY);
  const h = Math.floor((t % DAY) / HOUR);
  const m = Math.floor((t % HOUR) / MIN);
  if (d > 0) return `${d} 日 ${h} 時間`;
  if (h > 0) return m > 0 ? `${h} 時間 ${m} 分` : `${h} 時間`;
  return `${m} 分`;
}

/** 最後に見た時刻からの長さ（例「1 分前」）。 */
export function ago(ms: number): string {
  const t = Math.max(0, ms);
  if (t < MIN) return 'たった今';
  if (t < HOUR) return `${Math.floor(t / MIN)} 分前`;
  if (t < DAY) return `${Math.floor(t / HOUR)} 時間前`;
  return `${Math.floor(t / DAY)} 日前`;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 見出しの右の日付（例「10月17日（土）」）。 */
export function dayLabel(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
}

/** YYYY-MM-DD を「10月15日」にする。形が違えばそのまま返す。 */
export function monthDay(ymd: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : ymd;
}

/** 時刻（例「09:30」）。 */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 1 桁の小数にし、末尾の .0 を落とす。 */
const oneDecimal = (n: number): string => n.toFixed(1).replace(/\.0$/, '');

/** トークン数の略記（例「950」「13.6k」「148k」「1.3M」）。10 万未満は小数 1 桁、100 万未満は整数の k。 */
export function tokensShort(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 99_950) return `${oneDecimal(n / 1_000)}k`;
  if (n < 999_500) return `${Math.round(n / 1_000)}k`;
  return `${oneDecimal(n / 1_000_000)}M`;
}

/** 実行中の行の使用量（例「13.6k · $0.00」）。コストが分からなければトークンだけ。 */
export function usageLabel(u: { tokens: number; cost: number | null }): string {
  const t = tokensShort(u.tokens);
  return u.cost === null ? t : `${t} · $${u.cost.toFixed(2)}`;
}
