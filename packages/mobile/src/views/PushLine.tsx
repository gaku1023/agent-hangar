import { PUSH_QUIET_DEFAULT } from '@agent-hangar/shared/src/mobile.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readPushStatus, turnOffPush, turnOnPush, type PushStatus } from '../push.ts';
import type { Pairing } from '../store.ts';

const hm = (min: number): string => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
/** 夜に鳴らさない時間帯。今回は変える欄を作らず、既定を文で見せるだけにする。 */
const QUIET = `${hm(PUSH_QUIET_DEFAULT.start)}〜${hm(PUSH_QUIET_DEFAULT.end)}`;

/**
 * 受信箱の見出しの下の 1 行。通知の状態と、「通知を受け取る」「通知を止める」。
 * 開いたときと、見えたときに状態を読み直す（tzOffset が変わっていれば readPushStatus が送り直す）。
 */
export function PushLine({ pairing }: { pairing: Pairing }): ReactNode {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      if (busyRef.current) return;
      void readPushStatus(pairing).then(
        (s) => {
          if (alive && !busyRef.current) setStatus(s);
        },
        () => undefined,
      );
    };
    read();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pairing]);

  if (!status) return null;

  // 押したときの操作の中で turnOnPush を呼ぶ（iOS は操作の外で許可を求めると断る）。
  const run = (go: (p: Pairing) => Promise<PushStatus>): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    go(pairing)
      .then(setStatus, () => setFailed(true))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  if (status.kind === 'unsupported') {
    return (
      <div className="push">
        <div className="push-line">
          <span className="push-state">このブラウザでは通知を使えません</span>
        </div>
        {status.ios && <p className="push-hint">iPhone と iPad では、ホーム画面に追加した hangar で「通知を受け取る」を押すと使えます。</p>}
      </div>
    );
  }

  const isOn = status.kind === 'on';
  return (
    <div className="push">
      <div className="push-line">
        <span className="push-state">{isOn ? `通知：オン（${QUIET} は鳴らしません）` : '通知：オフ'}</span>
        <button type="button" className="push-btn" disabled={busy} onClick={() => run(isOn ? turnOffPush : turnOnPush)}>
          {isOn ? '通知を止める' : '通知を受け取る'}
        </button>
      </div>
      {status.kind === 'denied' && !failed && <p className="push-hint">通知が許可されていません。設定で hangar の通知を許可してから、もう一度押してください。</p>}
      {failed && (
        <p className="push-hint warn" role="status">
          通知を設定できませんでした。通信を確認して、もう一度押してください。
        </p>
      )}
    </div>
  );
}
