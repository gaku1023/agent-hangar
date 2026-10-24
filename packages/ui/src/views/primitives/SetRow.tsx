import type { ReactNode } from 'react';
import { InfoTip } from './InfoTip.tsx';

/**
 * 設定の 1 行。名前と説明を左、操作を右端に置く（試作の set-row）。
 * below は行の下いっぱいに広がる中身（使用量の棒、断りの文）である。
 * info は見出しの横の ⓘ に隠す説明で、押すと札で浮かぶ。
 * desc は常に出す必要がある文（取り消せない結果、秘密とコスト、許可、数値）だけに使う。
 */
export function SetRow(props: { id?: string; title: string; desc?: ReactNode; info?: ReactNode; control: ReactNode; below?: ReactNode }) {
  return (
    <div className="set-row" id={props.id}>
      <div className="set-row-l">
        <div className="set-row-t">{props.title}{props.info != null && props.info !== false && <InfoTip label={props.title}>{props.info}</InfoTip>}</div>
        {props.desc && <div className="set-row-d">{props.desc}</div>}
      </div>
      <div className="set-row-r">{props.control}</div>
      {props.below && <div className="set-row-below">{props.below}</div>}
    </div>
  );
}
