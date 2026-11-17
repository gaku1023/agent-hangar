/**
 * 統括の見張りの状態（server の orchestrator/keeper.ts の KeeperState と同じ形）。
 * GET /api/orchestrator/state の答えで、変わるたびに WebSocket の orchestrator.state でも配る。
 * stopped の reason は、failures が起動の失敗が続いたため、user が利用者が止めたため。
 * switching は新しい会話へ切り替えている間だけ真で付き、contextTokens は統括の会話の文脈の量が分かるときだけ付く。
 */
export type OrchestratorStateDto =
  ({ status: 'off' } | { status: 'running' } | { status: 'stopped'; reason: 'failures' | 'user' })
  & { switching?: true; contextTokens?: number };

/** 自動の切り替え（設計の「太ったとき」）の閾値。柱の文脈の量の棒は、これを超えると作業中の色になる。 */
export const ORCHESTRATOR_CONTEXT_LIMIT = 150_000;
