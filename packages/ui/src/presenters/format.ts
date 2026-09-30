import type { IndexProgressDto, SyncStateKind } from '@agent-hangar/shared';

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
/** Claude の起こし方。内部の語（run、start）を画面に出さない。 */
export const RUN_KIND_LABEL = { start: '起動', resume: '再開', fork: 'フォーク' } as const;
export const SOURCE_LABEL = { baseline: '自動', in_session: 'セッション', post_hoc: '事後' } as const;
/** 要約器の id を短い名前にする。表に無い id はそのまま出す。 */
export const SUMMARIZER_LABEL: Record<string, string> = { lmstudio: 'LM Studio', 'claude-headless': 'claude' };
export const STATUS_LABEL = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' } as const;

/**
 * 同期の状態の語。
 * ヘッダーの一行と設定の「状態」の両方がここから引く。
 * ヘッダーは idle のときに語の代わりに最後の同期の時刻を出し、error のときは理由を後ろに添える。
 */
export const SYNC_STATE_LABEL: Record<SyncStateKind, string> = { off: '同期していません', idle: '同期済み', pushing: '送信中', pulling: '受信中', paused: '一時停止中', error: '同期エラー' };

/**
 * 索引の進みの文。
 * ヘッダーと設定の索引の節の両方がこれを使う。
 * 終わっている（idle）ときは言うことが無いので null を返す。
 */
export function indexProgressLabel(idx: IndexProgressDto): string | null {
  if (idx.phase === 'idle') return null;
  if (idx.phase === 'scanning') return '索引を準備中';
  return `${idx.phase === 'rebuilding' ? '索引の作り直し' : '索引'} ${idx.done} / ${idx.total} 件`;
}

/** 使用率の表示。値が無いときは「未取得」にする。 */
export function percentLabel(n: number | null): string {
  return n === null ? '未取得' : `${Math.round(n)}%`;
}

/** 推定コスト。値が無いときは空文字にして、行の桁を崩さない。 */
export function costLabel(n: number | null): string {
  return n === null ? '' : `$${n.toFixed(2)}`;
}
