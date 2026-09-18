import { percentLabel } from '../../presenters/format.ts';
import { RollingNumber } from './RollingNumber.tsx';

/** 5 時間と 7 日の使用率の棒。幅 48px、高さ 6px で、80% 以上は警告色にする。 */
export function UsageGauge(props: { label: string; percent: number | null }) {
  const pct = props.percent === null ? 0 : Math.max(0, Math.min(100, props.percent));
  return (
    <span className="gauge" title={`${props.label} ${percentLabel(props.percent)}`}>
      <span className="gauge-bar" role="meter" aria-label={props.label} aria-valuenow={props.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <span className="gauge-fill" data-high={pct >= 80 ? 'true' : undefined} style={{ width: `${pct}%` }} />
      </span>
      <span className="gauge-num mono"><RollingNumber value={props.percent === null ? null : Math.round(props.percent)} suffix="%" /></span>
    </span>
  );
}
