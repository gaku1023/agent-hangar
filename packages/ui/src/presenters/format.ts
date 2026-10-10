import type { IndexProgressDto, SummaryState, Translate } from '@agent-hangar/shared';

const pad = (n: number) => String(n).padStart(2, '0');

export function absoluteTime(t: Translate, ts: number | null): string {
  if (ts === null) return t('common.time.unknown');
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(t: Translate, ts: number | null, now: number): string {
  if (ts === null) return t('common.time.unknown');
  const diff = now - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('common.ago.underMin');
  if (min < 60) return t('common.ago.min', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('common.ago.hour', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 2) return t('common.ago.yesterday');
  if (days < 30) return t('common.ago.day', { n: days });
  return absoluteTime(t, ts).slice(0, 10);
}

/**
 * 使用率の枠が戻る時刻。
 * 今日のうちなら時刻だけ、別の日なら月と日を添える。
 * 届いていなければ null にする。
 */
export function resetsLabel(ts: number | null, now: number): string | null {
  if (ts === null) return null;
  const d = new Date(ts);
  const n = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function durationLabel(t: Translate, ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('common.duration.underMin');
  if (min < 60) return t('common.duration.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('common.duration.hour', { n: h });
  return t('common.duration.day', { n: Math.floor(h / 24) });
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
const STATE_KEY = { in_progress: 'common.summaryState.inProgress', done: 'common.summaryState.done', blocked: 'common.summaryState.blocked', abandoned: 'common.summaryState.abandoned' } as const;
export const stateLabel = (t: Translate, state: SummaryState): string => t(STATE_KEY[state]);
/** 要約器の id を短い名前にする。表に無い id はそのまま出す。 */
export const SUMMARIZER_LABEL: Record<string, string> = { lmstudio: 'LM Studio', 'claude-headless': 'claude' };
export const STATUS_LABEL = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' } as const;

/**
 * 索引の進みの文。
 * ヘッダーと設定の索引の節の両方がこれを使う。
 * 終わっている（idle）ときは言うことが無いので null を返す。
 */
export function indexProgressLabel(t: Translate, idx: IndexProgressDto): string | null {
  if (idx.phase === 'idle') return null;
  if (idx.phase === 'scanning') return t('common.index.preparing');
  return t(idx.phase === 'rebuilding' ? 'common.index.rebuilding' : 'common.index.indexing', { done: idx.done, total: idx.total });
}

/**
 * 文の中の長い絶対パスを、末尾の 2 階層だけにする（`/Users/a/work/app/src/rows.css` → `…/src/rows.css`）。
 * 1 行しか無い場所（ホームの実行中の札の帯）で使う。頭から出すと、どの行も同じ頭で始まり、違いのある末尾が省略で消えるからである。
 * 4 階層より浅いパスは、そのままでも短いので触らない。
 */
export function shortenPaths(text: string): string {
  return text.replace(/(^|[\s='"(:])(~?(?:\/[^\s\/'"=;:&|()]+){4,})/g, (_m, lead: string, p: string) => `${lead}…/${p.split('/').slice(-2).join('/')}`);
}

/** 使用率の表示。値が無いときは「未取得」にする。 */
export function percentLabel(t: Translate, n: number | null): string {
  return n === null ? t('common.percent.unknown') : `${Math.round(n)}%`;
}

/** 推定コスト。値が無いときは空文字にして、行の桁を崩さない。 */
export function costLabel(n: number | null): string {
  return n === null ? '' : `$${n.toFixed(2)}`;
}
