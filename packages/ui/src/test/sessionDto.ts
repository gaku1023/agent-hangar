import type { SessionDto } from '@agent-hangar/shared';

/**
 * 画面の試験で使う会話（SessionDto）の見本。
 * 欄を足すときは、ここの既定に足せばよい。試験ごとの違いだけ over で渡す。
 */
export function sessionDto(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: null, cwd: '/x', firstPrompt: null, aiTitle: null,
    startedAt: null, lastActivityAt: null, lastTurnAt: null, hasTranscript: false, live: null, summary: null,
    stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null },
    fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false,
    woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false,
    takenOver: null, fromPhone: null, pinnedAt: null, mutedAt: null, unread: null, spawnedBy: null, spawnPeer: null,
    ...over,
  };
}
