import type { Translate } from '@agent-hangar/shared';

/** 「N ターン」。1 ターンは英語で単数形（1 turn）にする。 */
export const turnsText = (n: number, t: Translate): string => t(n === 1 ? 'session.stats.turnsOne' : 'session.stats.turns', { n });
