import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type ReactNode } from 'react';

/** 高密度の一覧。jsdom では要素の高さが 0 なので、テスト時は全件を素直に描く。 */
export function VirtualList<T>(props: { items: T[]; rowHeight: number; height: number | string; render: (item: T, index: number) => ReactNode; keyOf: (item: T) => string; head?: ReactNode }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: props.items.length, getScrollElement: () => parentRef.current, estimateSize: () => props.rowHeight, overscan: 12 });
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
      </div>
    </div>
  );
}
