import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { popBadge } from './primitives/splitMotion.ts';

/**
 * 今の描画で、番号の札が新しく出たセッションの id。Sidebar が前の描画と比べて作る。
 * 札は新しく出たものだけ弾み、最初の描画（起動直後に木を読み込んだとき）や、並びが替わっただけでは弾まない。
 */
export const FreshBadges = createContext<ReadonlySet<string>>(new Set());

/** 前の描画で札のあった id を覚え、今の描画で新しく札が付いた id を返す。最初の描画では空。 */
export function useFreshBadges(badged: readonly string[]): ReadonlySet<string> {
  const prev = useRef<ReadonlySet<string> | null>(null);
  const now = new Set(badged);
  const fresh = new Set<string>();
  if (prev.current) for (const id of now) if (!prev.current.has(id)) fresh.add(id);
  useLayoutEffect(() => { prev.current = now; });
  return fresh;
}

/** サイドバーの行の右端の、ペインの番号の札。新しく出たときだけ弾む。 */
export function PaneBadge(props: { id: string; n: number; title: string }) {
  const fresh = useContext(FreshBadges).has(props.id);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { if (fresh && ref.current) popBadge(ref.current); }, [fresh]);
  return <span ref={ref} className="side-pane-badge num" data-pane-badge={props.n} title={props.title}>{props.n}</span>;
}
