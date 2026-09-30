const pad = (n: number) => String(n).padStart(2, '0');

export function absoluteTime(ts: number | null): string {
  if (ts === null) return '不明';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(ts: number | null, now: number): string {
  if (ts === null) return '不明';
  const diff = now - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '1 分未満前';
  if (min < 60) return `${min} 分前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 時間前`;
  const days = Math.floor(hours / 24);
  if (days < 2) return '昨日';
  if (days < 30) return `${days} 日前`;
  return absoluteTime(ts).slice(0, 10);
}

export function durationLabel(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '1 分未満';
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 時間`;
  return `${Math.floor(h / 24)} 日`;
}

export function shortModel(model: string | null): string {
  // <synthetic> は Claude が形だけの返事（問いを閉じたときの「No response requested.」など）に付ける印で、モデルではない。
  if (!model || model === '<synthetic>') return '';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1]} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * 要約の見立て。
 * Claude が要約を書いた時点で、その仕事がどこまで進んだかを表す。
 * セッションのプロセスが生きているかどうかとは別物なので、実行中や終了とは重ならない語にする。
 */
export const STATE_LABEL = { in_progress: 'やりかけ', done: '済んだ', blocked: '詰まっている', abandoned: 'やめた' } as const;
export const SOURCE_LABEL = { baseline: '自動', in_session: 'セッション', post_hoc: '事後' } as const;
/** 要約器の id を短い名前にする。表に無い id はそのまま出す。 */
export const SUMMARIZER_LABEL: Record<string, string> = { lmstudio: 'LM Studio', 'claude-headless': 'claude' };
export const STATUS_LABEL = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' } as const;

/** 使用率の表示。値が無いときは「未取得」にする。 */
export function percentLabel(n: number | null): string {
  return n === null ? '未取得' : `${Math.round(n)}%`;
}

/** 推定コスト。値が無いときは空文字にして、行の桁を崩さない。 */
export function costLabel(n: number | null): string {
  return n === null ? '' : `$${n.toFixed(2)}`;
}
