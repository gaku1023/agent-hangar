import type { Language, SyncStateKind, Translate } from '@agent-hangar/shared';

/**
 * 同期の状態の語。ヘッダーの同期の一行と、設定の同期の群の「状態」が、同じ表から引く。
 * 語は用語集の「同期」の表のとおりである。
 */
export function syncStateWord(t: Translate, kind: SyncStateKind): string {
  switch (kind) {
    case 'off': return t('header.sync.off');
    case 'idle': return t('header.sync.idle');
    case 'pushing': return t('header.sync.sending');
    case 'pulling': return t('header.sync.receiving');
    case 'paused': return t('header.sync.paused');
    case 'error': return t('header.sync.error');
  }
}

/**
 * 上限で退いている間の、枠が戻る時刻。端末の時差で言う。
 * 日本語は 9:00、English は 09:00 の形にする。
 */
export function limitedWord(t: Translate, language: Language, until: number, tz?: string): string {
  const time = new Intl.DateTimeFormat(language === 'ja' ? 'ja-JP' : 'en-GB', { hour: language === 'ja' ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(until);
  return t('header.sync.limited', { time });
}
