import type { AutoApprovalDto, TranscriptEvent } from '@agent-hangar/shared';

/**
 * 統括の柱が読む状態（docs/design.md「統括」）。
 * events は統括の会話の末尾の頁（最新から）で、本文が伸びるたびに読み直して置き換える。
 * approvals は自動許可の記録（新しい順）で、本文が伸びたときと、柱を開いたときに読み直す。
 * sending は、柱の入力欄の文を送り終えるまで真。
 */
export type OrchestratorSlice = { events: TranscriptEvent[]; approvals: AutoApprovalDto[]; loaded: boolean; sending: boolean };

export const emptyOrchestrator = (): OrchestratorSlice => ({ events: [], approvals: [], loaded: false, sending: false });
