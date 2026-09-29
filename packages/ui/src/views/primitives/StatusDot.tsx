import { useEffect, useRef } from 'react';
import type { LiveStatus } from '@agent-hangar/shared';
import { motionEase, motionMs } from './motion.ts';

const LABEL: Record<LiveStatus, string> = { busy: '作業中', idle: '待機', waiting: '入力待ち' };

/** 状態の点。状態が変わる瞬間に 1 度だけ小さく膨らむ。最初の描画では膨らまない。 */
export function StatusDot(props: { status: LiveStatus | null; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(props.status);
  useEffect(() => {
    if (prev.current === props.status) return;
    prev.current = props.status;
    const el = ref.current;
    // jsdom のように Web Animations を持たない環境では、色の遷移だけにする。
    if (el && typeof el.animate === 'function') el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
  }, [props.status]);
  return <span ref={ref} className="dot" data-status={props.status ?? 'ended'} title={props.title ?? (props.status ? LABEL[props.status] : '終了')} aria-label={props.status ? LABEL[props.status] : '終了'} />;
}
