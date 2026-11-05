import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { PeerApprovalRow } from '../presenters/peerApprovals.ts';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { fadeIn } from './primitives/motionKit.ts';
import { useMotionList } from './primitives/useMotionList.ts';

const RESULT_ICON: Record<Exclude<PeerApprovalRow['state'], 'pending'>, IconName> = { approved: 'check', denied: 'close', timeout: 'reminder', failed: 'close' };

/**
 * 別の PC へ起動を頼む MCP の呼び出しの承認（D8）。削除の承認の帯（DeleteApprovalStrip）と同じ、本文の真上の帯である。
 * 1 行目は 会話 → PC 名の札 プロジェクト、2 行目は頼みの先頭。待ち時間は下端の線が縮む。
 * 答えると、ボタンが結果（承認しました、断りました、時間切れ）に入れ替わり、サーバが少し置いてから行を外すと畳む。
 * 入力の焦点は奪わない。動きは行の出入り（growIn と collapseOut）と結果の入れ替わり（fadeIn）だけである。
 */
export function PeerApprovalStrip({ rows }: { rows: PeerApprovalRow[] }) {
  const { list, ref } = useMotionList(rows, (r) => r.id, { enter: 'grow', enterFromEmpty: true, exitWhenEmpty: true });
  if (list.length === 0) return null;
  return (
    <div className="del-approvals peer-approvals">
      {list.map((e) => <Row key={e.key} row={e.item} boxRef={ref(e.key)} leaving={e.leaving} />)}
    </div>
  );
}

function Row({ row, boxRef, leaving }: { row: PeerApprovalRow; boxRef: (el: HTMLElement | null) => void; leaving: boolean }) {
  const t = useT();
  const emit = useEmit();
  const [sent, setSent] = useState(false);
  // 線の長さは、描いた時点の残りで決める。描き直しで速さが変わらないよう、最初の 1 回だけ測る。
  const [remain] = useState(() => Math.max(0, row.expiresAt - Date.now()));
  const note = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { if (row.result !== null && note.current) fadeIn(note.current); }, [row.result]);
  const answer = (a: 'approve' | 'reject') => { setSent(true); emit({ type: 'peerApproval.answer', id: row.id, answer: a }); };
  return (
    <div ref={boxRef} className="del-approval peer-approval" data-state={row.state} data-leaving={leaving || undefined}>
      <div className="del-approval-text">
        <div className="peer-approval-route">
          {row.from !== null && <><span className="peer-approval-who">{row.from}</span><Icon name="route" /></>}
          <span className="peer-approval-pc"><Icon name="otherPc" />{row.device}</span>
          <span className="peer-approval-project">{row.project}</span>
        </div>
        {row.ask !== '' && <div className="del-approval-f">{row.ask}</div>}
      </div>
      {row.result !== null
        ? <span ref={note} className="peer-approval-note" role="status"><Icon name={RESULT_ICON[row.state as Exclude<PeerApprovalRow['state'], 'pending'>]} />{row.result}</span>
        : (
          <>
            <button type="button" className="btn btn-sm" disabled={sent} onClick={() => answer('reject')}>{t('confirm.peerApproval.reject')}</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={sent} onClick={() => answer('approve')}>{t('confirm.peerApproval.approve')}</button>
          </>
        )}
      {row.state === 'pending' && <i className="peer-approval-bar" aria-hidden="true" style={{ '--drain': `${remain}ms` } as CSSProperties} />}
    </div>
  );
}
