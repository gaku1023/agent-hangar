import { useEffect, useRef } from 'react';
import { type LiveStatus } from '@agent-hangar/shared';
import { asideWord } from '../../lib/aside.ts';
import { useT } from './language.tsx';
import { motionEase, motionMs } from './motion.ts';

const LABEL_KEY = { busy: 'row.dot.busy', idle: 'row.dot.idle', waiting: 'row.dot.waiting' } as const satisfies Record<LiveStatus, string>;

/**
 * 状態の点。状態が変わる瞬間に 1 度だけ小さく膨らむ。最初の描画では膨らまない。
 * aside は、本体は入力を受け付けていて裏の作業だけが動いていること。作業中のときだけ data-aside を足し、薄いオレンジで静かに灯す（base.css）。
 */
export function StatusDot(props: { status: LiveStatus | null; aside?: boolean; title?: string }) {
  const t = useT();
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
  const label = aside ? asideWord(t) : props.status ? t(LABEL_KEY[props.status]) : t('row.dot.ended');
  return <span ref={ref} className="dot" data-status={props.status ?? 'ended'} data-aside={aside ? 'true' : undefined} title={props.title ?? label} aria-label={label} />;
}
