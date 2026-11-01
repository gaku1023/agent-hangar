import { useEffect, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { DeleteApprovalRow } from '../presenters/deleteApprovals.ts';
import { useT } from './primitives/language.tsx';
import { useMotionList } from './primitives/useMotionList.ts';

/** 承認の応答が来なかったときに、移動中の表示を戻すまでの長さ。失敗の知らせは別に出る（actionTable の call）。 */
const BUSY_GIVE_UP_MS = 30_000;

/**
 * MCP の削除の依頼（#547）。どの画面でも本文の真上に並ぶ帯で、依頼が無ければ何も描かない。
 * 入力の焦点は奪わない。答えるまで消えない。動きは行の出入り（growIn と collapseOut）だけである。
 * 移動中かは View の中に持つ。結果は deleteApprovals.update で届き、消せたら行が畳んで出て、消せなければ failure が付く。
 */
export function DeleteApprovalStrip({ rows }: { rows: DeleteApprovalRow[] }) {
  const { list, ref } = useMotionList(rows, (r) => r.id, { enter: 'grow', enterFromEmpty: true, exitWhenEmpty: true });
  if (list.length === 0) return null;
  return (
    <div className="del-approvals">
      {list.map((e) => <Row key={e.key} row={e.item} boxRef={ref(e.key)} leaving={e.leaving} />)}
    </div>
  );
}

function Row({ row, boxRef, leaving }: { row: DeleteApprovalRow; boxRef: (el: HTMLElement | null) => void; leaving: boolean }) {
  const t = useT();
  const emit = useEmit();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (row.failure !== null) setBusy(false); }, [row.failure]);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setBusy(false), BUSY_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  const answer = (a: 'approve' | 'reject' | 'dismiss') => emit({ type: 'deleteApproval.answer', id: row.id, answer: a });
  return (
    <div ref={boxRef} className="del-approval" data-leaving={leaving || undefined} data-failed={row.failure !== null || undefined}>
      <div className="del-approval-text">
        <div className="del-approval-q">{row.question}</div>
        <div className="del-approval-f">{row.facts}</div>
        {row.from !== null && <div className="del-approval-f">{row.from}</div>}
      </div>
      {busy
        ? <span className="del-approval-note" role="status"><span className="del-approval-spin" aria-hidden="true" />{t('confirm.deleteApproval.deleting')}</span>
        : row.failure !== null
          ? (
            <>
              <span className="del-approval-note" role="status">{row.failure}</span>
              <button type="button" className="btn btn-sm" onClick={() => answer('dismiss')}>{t('confirm.deleteApproval.close')}</button>
            </>
          )
          : (
            <>
              <button type="button" className="btn btn-sm" onClick={() => answer('reject')}>{t('confirm.deleteApproval.keep')}</button>
              <button type="button" className="btn btn-sm btn-danger btn-danger-fill" onClick={() => { setBusy(true); answer('approve'); }}>{t('confirm.deleteSession.action')}</button>
            </>
          )}
    </div>
  );
}
