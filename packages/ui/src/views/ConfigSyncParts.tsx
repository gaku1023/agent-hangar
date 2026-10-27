import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { ConfigGroupProps, ConfigRowProps } from '../presenters/configSync.ts';
import { Icon } from './primitives/Icon.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 開き閉じの箱。開くときは growIn で高さを伸ばし、閉じるときは collapseOut で畳んでから外す（アプリの決まった動き）。
 * 最初の描画は動かさない（設定の画面を開いた時点で開いているものは、そのまま出す）。
 */
export function Reveal(props: { open: boolean; children: ReactNode; className?: string }) {
  const box = usePresence<HTMLDivElement>(props.open, (el) => (motionOn(el) ? collapseOut(el) : null));
  const live = useRef(false);
  const was = useRef(props.open);
  useLayoutEffect(() => {
    if (props.open && !was.current && live.current && box.ref.current) growIn(box.ref.current);
    was.current = props.open;
    live.current = true;
  }, [props.open, box.ref]);
  if (!box.mounted) return null;
  return <div ref={box.ref} className={props.className} data-leaving={box.leaving ? 'true' : undefined}>{props.children}</div>;
}

/**
 * 設定の同期の画面で共通の部品（群、行、札）。
 * 群は種類ごと、または操作ごとの折りたたみで、見出しに件数を添える（a1、b1）。
 * 畳んだ群は、見出しに先頭の名前を添える。中身を開かなくても何が入っているかが読める。
 */

/** 行の右の小さな札。実行の印（フック、コマンド実行、スクリプト）は注意の色にする。 */
export function MarkTags(props: { marks: string[] }) {
  return <>{props.marks.map((m) => <span key={m} className="cfg-act" data-a="hook">{m}</span>)}</>;
}

export function ConfigRow(props: { row: ConfigRowProps; action?: ReactNode; below?: ReactNode }) {
  const r = props.row;
  const line = (
    <div className="cfg-it" data-dim={r.dim ? 'true' : undefined}>
      <span className="cfg-k mono" title={r.label}>{r.label}</span>
      {r.value !== null ? <span className="cfg-v mono" title={r.value}>{r.value}</span> : <span />}
      <span className="cfg-r">
        <MarkTags marks={r.marks} />
        {r.targetLabel && <span className="cfg-act" data-a="kind">{r.targetLabel}</span>}
        {r.tag && <span className="cfg-act" data-a={r.tag.tone === 'warn' ? 'conflict' : 'drop'}>{r.tag.text}</span>}
        {r.side !== '' && <span className="cfg-side">{r.side}</span>}
        {props.action}
      </span>
    </div>
  );
  if (!r.note && props.below === undefined) return line;
  return (
    <div className="cfg-ir">
      {line}
      {r.note && <div className="cfg-why">{r.note}</div>}
      {props.below}
    </div>
  );
}

/** 折りたたみの群。open は最初に開いているか（開閉はそのあと利用者が決める）。note（その操作で何が起きるか）は見出しの title に置く。 */
export function ConfigGroup(props: { group: ConfigGroupProps; renderAction?: (row: ConfigRowProps) => ReactNode; renderBelow?: (row: ConfigRowProps) => ReactNode; tone?: 'warn' }) {
  const g = props.group;
  return (
    <details className="cfg-grp" open={g.open} data-group={g.id} data-tone={props.tone}>
      <summary className="cfg-grp-h" title={g.note ?? undefined}>
        <span className="cfg-chev"><Icon name="chevron" /></span>
        <span className="cfg-grp-t">{g.title}</span>
        <span className="cfg-n">{g.count}</span>
        {g.peek && <span className="cfg-peek">{g.peek}</span>}
      </summary>
      {g.rows.map((r) => <ConfigRow key={r.id} row={r} action={props.renderAction?.(r)} below={props.renderBelow?.(r)} />)}
    </details>
  );
}
