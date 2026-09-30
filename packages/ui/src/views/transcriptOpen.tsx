import { createContext, useContext, useState } from 'react';

/**
 * 本文の行の中で開いたものの控え（ツールの中身、畳んだ長い本文）。
 * 本文は仮想スクロールなので、窓の外へ出た行は DOM から外れる。部品の中に持つと、戻ったときに畳み直されてしまう。
 * Transcript がこれを持ち、行の部品は seq と部位の名前で引く。
 * revealed は本文の中の検索がその行の一致へ跳んだことを表し、その行の畳んだものを全部開いて見せる。
 */
export type OpenStore = { get(seq: number, part: string): boolean | undefined; set(seq: number, part: string, open: boolean): void; revealed(seq: number): boolean };

export const OpenContext = createContext<OpenStore | null>(null);

/** 行の中の 1 つの開閉。Transcript の外（ターンの目次）では、部品の中で持つ。 */
export function useOpen(seq: number, part: string, initial = false): [boolean, (open: boolean) => void] {
  const store = useContext(OpenContext);
  const [local, setLocal] = useState(initial);
  if (!store) return [local, setLocal];
  const v = store.get(seq, part);
  return [v ?? (store.revealed(seq) || initial), (open) => store.set(seq, part, open)];
}

/** 一致の数を、畳んだツールの行に出すための表（seq から一致の数）。検索していなければ null。 */
export const HitsContext = createContext<Map<number, number> | null>(null);
export const useHits = (seq: number): number => useContext(HitsContext)?.get(seq) ?? 0;
