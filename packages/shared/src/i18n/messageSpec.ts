/** 領域ごとの鍵の表の形。鍵は `領域.部品.意味`、値はその文が受け取る引数の名前の並びである。 */
export type MessageSpec = Record<`${string}.${string}.${string}`, readonly string[]>;

/** 1 つの領域の辞書。その領域の `keys/<領域>.ts` の鍵をちょうど持つ。 */
export type AreaDictionary<Spec extends MessageSpec> = Record<keyof Spec, string>;
