import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PEER_FLASH_MS, type PeerOriginProps } from '../presenters/peerOrigin.ts';
import { Icon } from './primitives/Icon.tsx';
import { fadeOut, motionOn, riseIn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

type Flash = NonNullable<PeerOriginProps['flash']>;

/**
 * 渡した知らせの札を、PEER_FLASH_MS だけ出す。
 * 開いた時点で残っている札は出さない（開き直した画面で、ずっと前の札を見せないため）。
 * 続けて渡したら、鍵（key）が替わるので、数え直して出し直す。
 * 時計はこの hook が持つ。presenter は時刻を読まない。
 */
export function usePeerFlash(flash: Flash | null): Flash | null {
  const [shown, setShown] = useState<Flash | null>(null);
  const seen = useRef<number | null>(flash?.key ?? null);
  const key = flash?.key ?? null;
  useEffect(() => {
    if (flash === null) { setShown(null); return; }
    if (key === seen.current) return;
    seen.current = key;
    setShown(flash);
    const timer = setTimeout(() => setShown(null), PEER_FLASH_MS);
    return () => clearTimeout(timer);
    // 札の中身ではなく鍵が替わったときだけ動く。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shown;
}

/**
 * 端末の右上に出す「{device} から送信しました」の札（試作 5B）。
 * 下から 6px とぼかしで入り、消えるときは薄れる。
 * 出す・出さないは呼び手が usePeerFlash で決める。
 */
export function PeerBadge(props: { flash: Flash | null }) {
  const last = useRef(props.flash);
  if (props.flash) last.current = props.flash;
  const badge = usePresence<HTMLDivElement>(props.flash !== null, (el) => (motionOn(el) ? fadeOut(el) : null));
  const key = props.flash?.key ?? null;
  useLayoutEffect(() => {
    if (key !== null && badge.ref.current) riseIn(badge.ref.current);
    // 入る動きは、出し始めと出し直し（鍵が替わる）のときだけ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!badge.mounted || !last.current) return null;
  return (
    <div ref={badge.ref} className="term-peer-badge" data-testid="peer-badge" role={badge.leaving ? undefined : 'status'} aria-hidden={badge.leaving ? 'true' : undefined}>
      <Icon name="otherPc" />
      <span>{last.current.text}</span>
    </div>
  );
}

/**
 * サイドバーの行の小さな印。
 * 預かりがある間と、渡した直後の札と同じ間だけ出す。説明は title と読み上げに持つ。
 */
export function PeerMark(props: { origin: PeerOriginProps | null | undefined }) {
  const flash = usePeerFlash(props.origin?.flash ?? null);
  const text = props.origin?.band ?? flash?.text ?? null;
  const ref = useRef<HTMLSpanElement>(null);
  const on = text !== null;
  useLayoutEffect(() => {
    if (on && ref.current) riseIn(ref.current);
  }, [on]);
  if (text === null) return null;
  return (
    <span ref={ref} className="side-live-peer" title={text}>
      <Icon name="reminder" />
      <span className="sr-only">{text}</span>
    </span>
  );
}
