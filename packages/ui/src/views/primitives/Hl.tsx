import { createContext, useContext, type ReactNode } from 'react';
import { markTerms, type MarkOptions } from '../../presenters/highlight.ts';

/** 本文に付ける印。query が空なら印を付けない。 */
export type Marking = { query: string } & MarkOptions;

const MarkContext = createContext<Marking | null>(null);

/** この下で描く文字に、検索語の印を付ける。 */
export function MarkProvider(props: { value: Marking | null; children: ReactNode }) {
  return <MarkContext.Provider value={props.value}>{props.children}</MarkContext.Provider>;
}

/**
 * 本文の文字の葉。印の文脈があれば一致に <mark> を付ける。
 * 本文の中の検索は、同じ葉ごとにデータで一致を数える（presenters/find.ts）。印の数とずれないよう、描く文字はここを通す。
 */
export function Hl(props: { text: string }) {
  const m = useContext(MarkContext);
  if (!m || m.query === '' || props.text === '') return <>{props.text}</>;
  const segs = markTerms(props.text, m.query, m);
  return <>{segs.map((s, i) => (s.hit ? <mark key={i} className="hit">{s.text}</mark> : s.text))}</>;
}
