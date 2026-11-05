import type { PeerApprovalState, Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';

/**
 * 別の PC への起動の承認 1 行（D8）。
 * from は頼んだ会話の題名（分からなければ null）、device は頼まれた PC の名前、project はプロジェクトの名前（クイックセッションは「クイック」）。
 * ask は頼みの先頭を 「」 で包んだ文。expiresAt は待ちの期限（ミリ秒）で、帯の下端の線が縮み切る時刻になる。
 * state が pending でなければ、結果の文（result）を答えるボタンの代わりに出す。
 */
export type PeerApprovalRow = { id: string; from: string | null; device: string; project: string; ask: string; expiresAt: number; state: PeerApprovalState; result: string | null };

const RESULT_KEY = {
  approved: 'confirm.peerApproval.approved',
  denied: 'confirm.peerApproval.denied',
  timeout: 'confirm.peerApproval.timeout',
  failed: 'confirm.peerApproval.failed',
} as const;

/** 古い順に並べる。文は全部ここで組み、View は文を持たない。 */
export function presentPeerApprovals(store: Pick<Store, 'peerApprovals'>, t: Translate): PeerApprovalRow[] {
  return store.peerApprovals.map((a) => ({
    id: a.id,
    from: a.from,
    device: a.device,
    project: a.project ?? t('confirm.peerApproval.quick'),
    ask: a.ask === '' ? '' : t('confirm.peerApproval.ask', { text: a.ask }),
    expiresAt: a.expiresAt,
    state: a.state,
    result: a.state === 'pending' ? null : t(RESULT_KEY[a.state]),
  }));
}
