import type { Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';

/** MCP の削除の依頼 1 行（#547）。failure は承認した後に消せなかった理由の文で、あれば答えるボタンの代わりに閉じるを出す。from は依頼元が分からなければ null。 */
export type DeleteApprovalRow = { id: string; question: string; facts: string; from: string | null; failure: string | null };

/** 依頼を古い順に並べる。文は全部ここで組み、View は文を持たない。 */
export function presentDeleteApprovals(store: Pick<Store, 'deleteApprovals'>, t: Translate): DeleteApprovalRow[] {
  return store.deleteApprovals.map((a) => ({
    id: a.id,
    question: t('confirm.deleteSession.title', { name: a.title }),
    facts: a.project === null ? t('confirm.deleteApproval.turns', { n: a.turns }) : t('confirm.deleteSession.facts', { project: a.project, n: a.turns }),
    from: a.from === null ? null : t('confirm.deleteApproval.from', { from: a.from }),
    failure: a.failure === null ? null : t(a.failure === 'running' ? 'confirm.deleteApproval.failedRunning' : 'confirm.deleteApproval.failedTrash'),
  }));
}
