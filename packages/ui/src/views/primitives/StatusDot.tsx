import { useEffect, useRef } from 'react';
import { type LiveStatus, type StopReason } from '@agent-hangar/shared';
import { asideWord } from '../../lib/aside.ts';
import { useT } from './language.tsx';
import { motionEase, motionMs } from './motion.ts';

const LABEL_KEY = { busy: 'row.dot.busy', idle: 'row.dot.idle', waiting: 'row.dot.waiting' } as const satisfies Record<LiveStatus, string>;
const REASON_KEY = { permission: 'stop.state.permission', limit: 'stop.state.limit', reset: 'stop.state.reset' } as const satisfies Record<StopReason, string>;

/** 許可待ちの盾（試作 stop-reason-proto の S2）。塗った盾に白いチェックを抜く。 */
function Shield() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.2 13.4 3.3v4.1c0 3.4-2.3 5.9-5.4 7.3C4.9 13.3 2.6 10.8 2.6 7.4V3.3z" fill="currentColor" />
      <path d="M5.6 8.1 7.3 9.7 10.6 6.3" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 使用制限の砂時計。 */
function Hourglass() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.8 1.6h8.4M3.8 14.4h8.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 1.8c0 3.2 3 4.3 3 6.2s-3 3-3 6.2h6c0-3.2-3-4.3-3-6.2s3-3 3-6.2z" fill="currentColor" opacity=".9" />
    </svg>
  );
}

/** 止まっている理由の形だけ（読み上げない飾り）。現在の札の状態の行が、点の代わりに使う。 */
export function ReasonGlyph(props: { reason: 'permission' | 'limit' }) {
  return <span className="reason-glyph" data-reason={props.reason} aria-hidden="true">{props.reason === 'permission' ? <Shield /> : <Hourglass />}</span>;
}

/**
 * 状態の点。状態が変わる瞬間に 1 度だけ小さく膨らむ。最初の描画では膨らまない。
 * aside は、本体は入力を受け付けていて裏の作業だけが動いていること。作業中のときだけ data-aside を足し、薄いオレンジで静かに灯す（base.css）。
 * reason は止まっている理由（shared の stopReasonOf）。許可待ちは盾、使用制限は砂時計に替え、リセット済みは入力待ちの点のまま語だけ替える。
 * 印は点と同じ 8px の箱から中央に描くので、行の高さと並びは変わらない（試作の S2）。
 */
export function StatusDot(props: { status: LiveStatus | null; aside?: boolean; reason?: StopReason | null; title?: string }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const reason = props.reason ?? null;
  const aside = reason === null && props.aside === true && props.status === 'busy';
  const key = reason ?? (aside ? 'aside' : props.status);
  const prev = useRef(key);
  useEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    const el = ref.current;
    // jsdom のように Web Animations を持たない環境では、色の遷移だけにする。
    if (el && typeof el.animate === 'function') el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
  }, [key]);
  const label = reason ? t(REASON_KEY[reason]) : aside ? asideWord(t) : props.status ? t(LABEL_KEY[props.status]) : t('row.dot.ended');
  return (
    <span ref={ref} className="dot" data-status={props.status ?? 'ended'} data-aside={aside ? 'true' : undefined} data-reason={reason ?? undefined} title={props.title ?? label} aria-label={label}>
      {reason === 'permission' ? <Shield /> : reason === 'limit' ? <Hourglass /> : null}
    </span>
  );
}
