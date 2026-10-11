import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { riseIn } from './motionKit.ts';

/** 高密度の一覧。jsdom では要素の高さが 0 なので、テスト時は全件を素直に描く。
 * 行の高さは定数か、項目ごとに決める関数で渡す。
 * foot は最後の行の下に置き、行と一緒にスクロールする。
 * 項目の鍵（keyOf）を仮想リストにも渡す。@tanstack/virtual は件数と鍵が変わらなければ、estimateSize が変わっても高さを測り直さない。
 * 節の見出しを挟んだ一覧で、件数が同じまま並びが変わると、古い高さのまま行と見出しが重なるからである。
 * glide を渡すと、並びが替わった行を前の位置から滑らせる（行の箱は位置を transform に持つので、器の data-glide で transform に transition を付けるだけでよい。base.css）。
 * 新しい鍵の行は、中身を浮かべて入れる（riseIn。箱の transform は位置なので、箱ではなく中身を動かす）。
 * glide は一覧の切替の範囲（タブ、条件、ページ）で、替わった描画は滑らせも浮かべもせず、いきなり替える。
 * data-glide は描画で外す（行の位置と同じ DOM の書き換えで外す。layout effect で外すと、先に走るほかの部品の測りが style を確定させ、滑り出してしまう）。2 コマ置いてから戻す。
 * 最初の描画、空から埋まった描画、鍵が全部替わった描画も浮かべない。 */
export function VirtualList<T>(props: { items: T[]; rowHeight: number | ((item: T, index: number) => number); height?: number | string; render: (item: T, index: number) => ReactNode; keyOf: (item: T) => string; head?: ReactNode; foot?: ReactNode; glide?: string }) {
  const { items, rowHeight, keyOf } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: props.items.length, getScrollElement: () => parentRef.current, estimateSize: (i) => typeof rowHeight === 'function' ? rowHeight(items[i]!, i) : rowHeight, getItemKey: (i) => keyOf(items[i]!), overscan: 12 });
  const virtual = v.getVirtualItems();
  const plain = typeof window === 'undefined' || virtual.length === 0;
  const boxes = useRef(new Map<string, HTMLElement>());
  const boxRef = (key: string) => (el: HTMLDivElement | null) => { if (el) boxes.current.set(key, el); else boxes.current.delete(key); };
  // 滑らせてよい範囲。glide が替わったら、2 コマ置いてから追いつく。
  const [settled, setSettled] = useState(props.glide);
  const glideOn = props.glide !== undefined && settled === props.glide;
  useEffect(() => {
    if (settled === props.glide) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setSettled(props.glide)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [props.glide, settled]);
  const prevKeys = useRef<string[] | null>(null);
  const lastGlide = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const keys = items.map(keyOf);
    const before = prevKeys.current;
    prevKeys.current = keys;
    const switched = before === null || lastGlide.current !== props.glide;
    lastGlide.current = props.glide;
    if (props.glide === undefined || switched || before.length === 0) return;
    const had = new Set(before);
    if (!keys.some((k) => had.has(k))) return;
    for (const k of keys) {
      if (had.has(k)) continue;
      const inner = boxes.current.get(k)?.firstElementChild;
      if (inner instanceof HTMLElement) riseIn(inner);
    }
  });
  return (
    <div className="list">
      {props.head}
      <div ref={parentRef} className="list-scroll" style={{ height: props.height }} role="rowgroup" data-glide={glideOn ? '' : undefined}>
        {plain ? props.items.map((it, i) => <div key={props.keyOf(it)} ref={boxRef(props.keyOf(it))} className="vrow">{props.render(it, i)}</div>) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {virtual.map((row) => {
              const key = props.keyOf(props.items[row.index]!);
              return (
                <div key={key} ref={boxRef(key)} className="vrow" style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}>
                  {props.render(props.items[row.index]!, row.index)}
                </div>
              );
            })}
          </div>
        )}
        {props.foot}
      </div>
    </div>
  );
}
