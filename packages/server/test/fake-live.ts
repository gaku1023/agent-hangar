import type { LiveSessionDto } from '@agent-hangar/shared';
import type { ClaudeLiveSource } from '../src/provider/claude-code/driver.ts';

/**
 * 試験で渡す Claude の状態の面。写しは read が返すものをそのまま使い、見張りも読み直しもしない。
 * read を省くと、登録を読む口が無い構成として、isRunning は pid の生存だけで決めさせる（常に真）。
 */
export function liveSourceOf(read?: () => LiveSessionDto[]): ClaudeLiveSource {
  return {
    start: () => {},
    stop: () => {},
    current: () => read?.() ?? [],
    onChange: () => () => {},
    kick: () => {},
    isRunning: (providerSessionId, pid) => !read || read().some((l) => l.sessionId === providerSessionId && l.pid === pid),
    renoteDrifts: () => {},
  };
}
