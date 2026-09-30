import type { UsageBarProps } from '../presenters/retentionDialog.ts';

/** いまの使用量と、選んだ期間の終わりの見込み。見込みは斜線で塗り、いまの量の後ろに重ねる。 */
export function UsageBar(props: UsageBarProps) {
  return (
    <div className="usage-bar">
      <div className="usage-meter" aria-hidden="true">
        <i className="usage-proj" style={{ width: `${props.projPct}%` }} />
        <i className="usage-now" style={{ width: `${props.nowPct}%` }} />
      </div>
      <div className="usage-legend">
        <span>{props.nowLabel}</span>
        {props.projLabel && <span className={props.warn ? 'usage-warn' : undefined}>{props.projLabel}</span>}
        <span>{props.freeLabel}</span>
      </div>
    </div>
  );
}
