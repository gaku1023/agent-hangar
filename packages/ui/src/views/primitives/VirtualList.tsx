import { useVirtualizer } from '@tanstack/react-virtual';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { growIn, markHit, risenKeys } from './motionKit.ts';

/** 高密度の一覧。jsdom では要素の高さが 0 なので、テスト時は全件を素直に描く。
 * 行の高さは定数か、項目ごとに決める関数で渡す。
 * foot は最後の行の下に置き、行と一緒にスクロールする。
 * 項目の鍵（keyOf）を仮想リストにも渡す。@tanstack/virtual は件数と鍵が変わらなければ、estimateSize が変わっても高さを測り直さない。
 * 節の見出しを挟んだ一覧で、件数が同じまま並びが変わると、古い高さのまま行と見出しが重なるからである。
 * scope を渡すと、並びの替わりを知らせる（⑤ の c）。並びはいきなり替え、上がった行と新しい鍵の行の中身にだけ markHit（淡い黄の薄れ）を付ける。
 * scope は一覧の切替の範囲（タブ、条件、ページ）で、替わった描画は知らせない。最初の描画、空から埋まった描画、鍵が全部替わった描画も知らせない。
 * grows が真を返す新しい鍵の行は、markHit の代わりに growIn で伸びて入る（スマホから起動した会話の行、試作 F1）。上がっただけの行は markHit のまま。 */
export function VirtualList<T>(props: { items: T[]; rowHeight: number | ((item: T, index: number) => number); height?: number | string; render: (item: T, index: number) => ReactNode; keyOf: (item: T) => string; head?: ReactNode; foot?: ReactNode; scope?: string; grows?: (item: T) => boolean }) {
  const { items, rowHeight, keyOf } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: props.items.length, getScrollElement: () => parentRef.current, estimateSize: (i) => typeof rowHeight === 'function' ? rowHeight(items[i]!, i) : rowHeight, getItemKey: (i) => keyOf(items[i]!), overscan: 12 });
  const virtual = v.getVirtualItems();
  const plain = typeof window === 'undefined' || virtual.length === 0;
  const boxes = useRef(new Map<string, HTMLElement>());
  const boxRef = (key: string) => (el: HTMLDivElement | null) => { if (el) boxes.current.set(key, el); else boxes.current.delete(key); };
  const prevKeys = useRef<string[] | null>(null);
  const lastScope = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const keys = items.map(keyOf);
    const before = prevKeys.current;
    prevKeys.current = keys;
    const switched = before === null || lastScope.current !== props.scope;
    lastScope.current = props.scope;
    if (props.scope === undefined || switched || before.length === 0) return;
    const had = new Set(before);
    if (!keys.some((k) => had.has(k))) return;
    const risen = risenKeys(before, keys);
    keys.forEach((k, i) => {
      if (had.has(k) && !risen.has(k)) return;
      const inner = boxes.current.get(k)?.firstElementChild;
      if (!(inner instanceof HTMLElement)) return;
      if (!had.has(k) && props.grows?.(items[i]!)) growIn(inner);
      else markHit(inner);
    });
  });
  return (
    <div className="list">
      {props.head}
      <div ref={parentRef} className="list-scroll" style={{ height: props.height }} role="rowgroup">
        {plain ? props.items.map((it, i) => <div key={props.keyOf(it)} ref={boxRef(props.keyOf(it))}>{props.render(it, i)}</div>) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {virtual.map((row) => {
              const key = props.keyOf(props.items[row.index]!);
              return (
                <div key={key} ref={boxRef(key)} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}>
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
