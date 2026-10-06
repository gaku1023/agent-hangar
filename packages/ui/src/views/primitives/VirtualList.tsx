import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type ReactNode } from 'react';

/** 高密度の一覧。jsdom では要素の高さが 0 なので、テスト時は全件を素直に描く。
 * 行の高さは定数か、項目ごとに決める関数で渡す。
 * foot は最後の行の下に置き、行と一緒にスクロールする。
 * 項目の鍵（keyOf）を仮想リストにも渡す。@tanstack/virtual は件数と鍵が変わらなければ、estimateSize が変わっても高さを測り直さない。
 * 節の見出しを挟んだ一覧で、件数が同じまま並びが変わると、古い高さのまま行と見出しが重なるからである。 */
export function VirtualList<T>(props: { items: T[]; rowHeight: number | ((item: T, index: number) => number); height?: number | string; render: (item: T, index: number) => ReactNode; keyOf: (item: T) => string; head?: ReactNode; foot?: ReactNode }) {
  const { items, rowHeight, keyOf } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: props.items.length, getScrollElement: () => parentRef.current, estimateSize: (i) => typeof rowHeight === 'function' ? rowHeight(items[i]!, i) : rowHeight, getItemKey: (i) => keyOf(items[i]!), overscan: 12 });
  const virtual = v.getVirtualItems();
  const plain = typeof window === 'undefined' || virtual.length === 0;
  return (
    <div className="list">
      {props.head}
      <div ref={parentRef} className="list-scroll" style={{ height: props.height }} role="rowgroup">
        {plain ? props.items.map((it, i) => <div key={props.keyOf(it)}>{props.render(it, i)}</div>) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {virtual.map((row) => (
              <div key={props.keyOf(props.items[row.index]!)} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}>
                {props.render(props.items[row.index]!, row.index)}
              </div>
            ))}
          </div>
        )}
        {props.foot}
      </div>
    </div>
  );
}
