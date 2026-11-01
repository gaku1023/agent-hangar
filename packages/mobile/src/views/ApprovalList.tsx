import type { MobileApprovalAnswer } from '@agent-hangar/shared/src/mobile.ts';
import { useState, type ReactNode } from 'react';
import { askPc, AskError, type AskReply } from '../ask.ts';
import type { ApprovalRow } from '../inbox.ts';
import { usePresence } from '../presence.ts';
import { currentKey, type Keyring, type Pairing } from '../store.ts';
import { Fold } from './Fold.tsx';

type Ask = (row: ApprovalRow, answer: MobileApprovalAnswer) => Promise<AskReply>;

type Props = {
  rows: ApprovalRow[];
  pairing: Pairing;
  keys: Keyring;
  /** 答えた後に受信箱を読み直す。 */
  onAnswered: () => void;
  /** 問い合わせの口。試験が差し替える。 */
  ask?: Ask;
};

const FAILURE_TEXT = { running: '実行中のため消せませんでした', trash: 'ゴミ箱へ移せませんでした' } as const;
const OFFLINE_TEXT = 'PC につながっていません';

/**
 * MCP の削除の依頼（#547）。受信箱の一番上に、入力待ちとは分けて置く。依頼が無ければ何も描かない。
 * 答えは宛先の PC への問い合わせで返す。PC が見えないときは押せない。
 * 答えた行は読み直しを待たずに畳む。読み直しの結果がまだ古くても、答えた行を出し直さない。
 */
export function ApprovalList({ rows, pairing, keys, onAnswered, ask }: Props): ReactNode {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const shown = rows.filter((r) => !answered.has(r.id));
  const list = usePresence(shown, (r) => r.id);
  const send: Ask = ask ?? (async (r, answer) => {
    const key = currentKey(keys);
    if (!key) throw new AskError('unpaired');
    return askPc(pairing, key, r.deviceId, { kind: 'delete-approval', id: r.id, answer });
  });
  if (list.length === 0) return null;
  return (
    <section className="approvals">
      {list.map((p) => (
        <Fold key={p.key} phase={p.phase}>
          <ApprovalCard row={p.item} send={send} onGone={() => { setAnswered((s) => new Set(s).add(p.item.id)); onAnswered(); }} onChanged={onAnswered} />
        </Fold>
      ))}
    </section>
  );
}

function ApprovalCard({ row, send, onGone, onChanged }: { row: ApprovalRow; send: Ask; onGone: () => void; onChanged: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const shownFailure = failure ?? (row.failure ? FAILURE_TEXT[row.failure] : null);
  const noPc = !row.alive || offline;

  const answer = async (a: MobileApprovalAnswer): Promise<void> => {
    if (a === 'approve') setBusy(true);
    setOffline(false);
    try {
      const r = await send(row, a);
      if ('approval' in r && r.approval === 'failed') { setFailure(FAILURE_TEXT.running); onChanged(); return; }
      if (!('approval' in r) || r.approval === 'accepted') { onChanged(); return; }
      onGone();
    } catch (e) {
      if (e instanceof AskError && (e.reason === 'pc-offline' || e.reason === 'pc-timeout' || e.reason === 'not-found')) setOffline(true);
      else setFailure(FAILURE_TEXT.trash);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card approval">
      <p className="approval-q">「{row.title}」を削除しますか？</p>
      <p className="approval-f">{row.project ? `${row.project}・` : ''}{row.turns} ターン</p>
      {row.from !== null && <p className="approval-f">{row.from} より</p>}
      {busy && <p className="approval-note"><span className="approval-spin" aria-hidden="true" />ゴミ箱へ移動中…</p>}
      {!busy && shownFailure !== null && <p className="approval-note fail" role="status">{shownFailure}</p>}
      {!busy && shownFailure === null && noPc && <p className="approval-note" role="status">{OFFLINE_TEXT}</p>}
      {!busy && shownFailure !== null && (
        <div className="approval-acts">
          <button type="button" className="approval-btn" disabled={noPc} onClick={() => void answer('dismiss')}>閉じる</button>
        </div>
      )}
      {!busy && shownFailure === null && (
        <div className="approval-acts">
          <button type="button" className="approval-btn" disabled={noPc} onClick={() => void answer('reject')}>残す</button>
          <button type="button" className="approval-btn danger" disabled={noPc} onClick={() => void answer('approve')}>ゴミ箱へ移動</button>
        </div>
      )}
    </div>
  );
}
