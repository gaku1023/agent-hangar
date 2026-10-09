import type { ReactNode } from 'react';

/**
 * 設定の 1 行。名前と説明を左、操作を右端に置く（試作の set-row）。
 * below は行の下いっぱいに広がる中身（使用量の棒、断りの文）である。
 */
export function SetRow(props: { id?: string; title: string; desc?: ReactNode; control: ReactNode; below?: ReactNode }) {
  return (
    <div className="set-row" id={props.id}>
      <div className="set-row-l">
        <div className="set-row-t">{props.title}</div>
        {props.desc && <div className="set-row-d">{props.desc}</div>}
      </div>
      <div className="set-row-r">{props.control}</div>
      {props.below && <div className="set-row-below">{props.below}</div>}
    </div>
  );
}
