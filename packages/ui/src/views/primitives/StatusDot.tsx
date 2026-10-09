import { useEffect, useRef } from 'react';
import { type LiveStatus } from '@agent-hangar/shared';
import { ASIDE_WORD } from '../../lib/aside.ts';
import { motionEase, motionMs } from './motion.ts';

const LABEL: Record<LiveStatus, string> = { busy: '作業中', idle: '休み', waiting: '入力待ち' };

/**
 * 状態の点。状態が変わる瞬間に 1 度だけ小さく膨らむ。最初の描画では膨らまない。
 * aside は、本体は入力を受け付けていて裏の作業だけが動いていること。作業中のときだけ data-aside を足し、薄いオレンジで静かに灯す（base.css）。
 */
export function StatusDot(props: { status: LiveStatus | null; aside?: boolean; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const aside = props.aside === true && props.status === 'busy';
  const key = aside ? 'aside' : props.status;
  const prev = useRef(key);
  useEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    const el = ref.current;
    // jsdom のように Web Animations を持たない環境では、色の遷移だけにする。
    if (el && typeof el.animate === 'function') el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
  }, [key]);
  const label = aside ? ASIDE_WORD : props.status ? LABEL[props.status] : '終了';
  return <span ref={ref} className="dot" data-status={props.status ?? 'ended'} data-aside={aside ? 'true' : undefined} title={props.title ?? label} aria-label={label} />;
}
