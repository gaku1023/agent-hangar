import type { ReactNode } from 'react';
import type { ConfigGroupProps, ConfigRowProps } from '../presenters/configSync.ts';
import { Icon } from './primitives/Icon.tsx';

/**
 * 設定の同期の画面で共通の部品（群、行、札）。
 * 群は種類ごと、または操作ごとの折りたたみで、見出しに件数を添える（a1、b1）。
 * 畳んだ群は、見出しに先頭の名前を添える。中身を開かなくても何が入っているかが読める。
 */

/** 行の右の小さな札。実行の印（フック、コマンド実行、スクリプト）は注意の色にする。 */
export function MarkTags(props: { marks: string[] }) {
  return <>{props.marks.map((m) => <span key={m} className="cfg-act" data-a="hook">{m}</span>)}</>;
}

export function ConfigRow(props: { row: ConfigRowProps; action?: ReactNode }) {
  const r = props.row;
  return (
    <div className="cfg-it" data-dim={r.dim ? 'true' : undefined}>
      <span className="cfg-k mono" title={r.label}>{r.label}</span>
      {r.value !== null ? <span className="cfg-v mono" title={r.value}>{r.value}</span> : <span />}
      <span className="cfg-r">
        <MarkTags marks={r.marks} />
        {r.tag && <span className="cfg-act" data-a={r.tag.tone === 'warn' ? 'conflict' : 'drop'}>{r.tag.text}</span>}
        {r.side !== '' && <span className="cfg-side">{r.side}</span>}
        {props.action}
      </span>
    </div>
  );
}

/** 折りたたみの群。open は最初に開いているか（開閉はそのあと利用者が決める）。 */
export function ConfigGroup(props: { group: ConfigGroupProps; renderAction?: (row: ConfigRowProps) => ReactNode }) {
  const g = props.group;
  return (
    <details className="cfg-grp" open={g.open} data-group={g.id}>
      <summary className="cfg-grp-h">
        <span className="cfg-chev"><Icon name="chevron" /></span>
        <span className="cfg-grp-t">{g.title}</span>
        <span className="cfg-n">{g.count}</span>
        {g.peek && <span className="cfg-peek">{g.peek}</span>}
      </summary>
      {g.note && <div className="cfg-note">{g.note}</div>}
      {g.rows.map((r) => <ConfigRow key={r.id} row={r} action={props.renderAction?.(r)} />)}
    </details>
  );
}
