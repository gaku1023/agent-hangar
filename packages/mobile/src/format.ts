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

/** 時刻（例「09:30」）。 */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
