import { percentLabel } from '../../presenters/format.ts';
import { RollingNumber } from './RollingNumber.tsx';

/**
 * Claude の利用上限の枠（5 時間と週）の使用率の棒。
 * 幅 48px、高さ 6px で、80% 以上は警告色にする。
 * short は棒の前に常に出す見出し（5 時間、週）で、label は読み上げの名前である。
 * resets は枠が戻る時刻の文で、あればホバーの title に添える。
 */
export function UsageGauge(props: { label: string; short?: string; percent: number | null; resets?: string | null }) {
  const pct = props.percent === null ? 0 : Math.max(0, Math.min(100, props.percent));
  const title = `${props.label} ${percentLabel(props.percent)}${props.resets ? `、${props.resets} に戻ります` : ''}`;
  return (
    <span className="gauge" title={title}>
      {props.short && <span className="gauge-key" aria-hidden="true">{props.short}</span>}
      <span className="gauge-bar" role="meter" aria-label={props.label} aria-valuenow={props.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <span className="gauge-fill" data-high={pct >= 80 ? 'true' : undefined} style={{ width: `${pct}%` }} />
      </span>
      <span className="gauge-num mono"><RollingNumber value={props.percent === null ? null : Math.round(props.percent)} suffix="%" /></span>
    </span>
  );
}
