import type { Translate } from '@agent-hangar/shared';

/** 「N ターン」。英語の単数形（1 turn）は、辞書の文の複数形の書き方に任せる。 */
export const turnsText = (n: number, t: Translate): string => t('session.stats.turns', { n });
