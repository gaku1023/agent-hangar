import type { MobilePeerApprovalAnswer } from '@agent-hangar/shared/src/mobile.ts';
import { useState, type ReactNode } from 'react';
import { askPc, AskError, type AskReply } from '../ask.ts';
import type { PeerApprovalRow } from '../inbox.ts';
import { usePresence } from '../presence.ts';
import { currentKey, type Keyring, type Pairing } from '../store.ts';
import { Fold } from './Fold.tsx';

type Ask = (row: PeerApprovalRow, answer: MobilePeerApprovalAnswer) => Promise<AskReply>;

type Props = {
  rows: PeerApprovalRow[];
  /** PC の時計に合わせた今（ミリ秒）。期限を過ぎた行は出さない。 */
  now: number;
  pairing: Pairing;
  keys: Keyring;
  /** 答えた後に受信箱を読み直す。 */
  onAnswered: () => void;
  /** 問い合わせの口。試験が差し替える。 */
  ask?: Ask;
};

const OFFLINE_TEXT = 'PC につながっていません';
const FAILED_TEXT = '送れませんでした';
const QUICK_TEXT = 'クイック';

/**
 * 別の PC への起動の承認待ち（D8）。削除の承認（ApprovalList）と同じ、受信箱の上の札である。
 * 頼んだ会話、起こす PC、プロジェクト、頼みの先頭を出し、承認か断るで答える。答えは頼んだ側の PC への問い合わせで返す。
 * 期限を過ぎた行は出さない。PC が見えないときは押せない。答えた行は読み直しを待たずに畳む。
 */
export function PeerApprovalList({ rows, now, pairing, keys, onAnswered, ask }: Props): ReactNode {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const shown = rows.filter((r) => !answered.has(r.id) && r.expiresAt > now);
  const list = usePresence(shown, (r) => r.id);
  const send: Ask = ask ?? (async (r, answer) => {
    const key = currentKey(keys);
    if (!key) throw new AskError('unpaired');
    return askPc(pairing, key, r.deviceId, { kind: 'peer-approval', id: r.id, answer });
  });
  if (list.length === 0) return null;
  return (
    <section className="approvals">
      {list.map((p) => (
        <Fold key={p.key} phase={p.phase}>
          <Card row={p.item} send={send} onGone={() => { setAnswered((s) => new Set(s).add(p.item.id)); onAnswered(); }} onChanged={onAnswered} />
        </Fold>
      ))}
    </section>
  );
}

function Card({ row, send, onGone, onChanged }: { row: PeerApprovalRow; send: Ask; onGone: () => void; onChanged: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const noPc = !row.alive || offline;

  const answer = async (a: MobilePeerApprovalAnswer): Promise<void> => {
    setBusy(true);
    setOffline(false);
    setFailed(false);
    try {
      const r = await send(row, a);
      if ('approval' in r && r.approval === 'failed') { setFailed(true); onChanged(); return; }
      if (!('approval' in r) || r.approval === 'accepted') { onChanged(); return; }
      onGone();
    } catch (e) {
      if (e instanceof AskError && (e.reason === 'pc-offline' || e.reason === 'pc-timeout' || e.reason === 'not-found')) setOffline(true);
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card approval">
      <p className="approval-q">{row.from !== null ? `${row.from} → ` : ''}{row.device} {row.project ?? QUICK_TEXT}</p>
      {row.ask !== '' && <p className="approval-f">「{row.ask}」</p>}
      {failed && <p className="approval-note fail" role="status">{FAILED_TEXT}</p>}
      {!failed && noPc && <p className="approval-note" role="status">{OFFLINE_TEXT}</p>}
      <div className="approval-acts">
        <button type="button" className="approval-btn" disabled={noPc || busy} onClick={() => void answer('reject')}>断る</button>
        <button type="button" className="approval-btn go" disabled={noPc || busy} onClick={() => void answer('approve')}>承認</button>
      </div>
    </div>
  );
}
