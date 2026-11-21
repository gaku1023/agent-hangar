/**
 * URL のハッシュを画面の正とするための受け口。
 *
 * 履歴の段に「アプリの中で何段目か」の印を押す。
 * これが要るのは、アプリの最初の頁より前へ戻らせないためである。
 * デスクトップではその手前がサーバの起動を待つ頁で、そこへ戻ると二度と遷移せず詰む。
 */

export type HistoryLike = { readonly state: unknown; replaceState(state: unknown, title: string, url?: string): void; go(delta: number): void };
export type LocationLike = { hash: string };
export type HashLocation = {
  getHash(): string;
  setHash(h: string): void;
  onHashChange(cb: () => void): () => void;
  /** 履歴を積まずに、いまの段のハッシュを置き換える。ハッシュの変化の知らせは出ないので、呼ぶ側が自分で追う。 */
  replaceHash?(h: string): void;
  go(delta: number): void;
  /** アプリの中で何段目か。印の無い段（アプリの外から来た段）は 0。 */
  depth(): number;
  /** いまの段より先に、進める段があるか（サイドバーの進むのボタン）。 */
  canForward(): boolean;
};

type Stamp = { hangarDepth?: number };

export function createHashLocation(history: HistoryLike, location: LocationLike, onHashChange: (cb: () => void) => () => void): HashLocation {
  const depth = () => {
    const d = (history.state as Stamp | null)?.hangarDepth;
    return typeof d === 'number' && d > 0 ? d : 0;
  };
  // 進める段の上端。積むと今の段が上端になり（その先は履歴から消える）、戻る・進むでは動かない。
  // 履歴はその上端を教えてくれないので、ここで覚える。読み込み直すと覚えた上端は消え、今の段から数え直す。
  let top = depth();
  return {
    depth,
    canForward: () => depth() < top,
    getHash: () => location.hash,
    // ハッシュを入れると段が 1 つ積まれ、その段の印は空になる。積んだ直後に深さを押し直す。
    setHash: (h) => {
      const next = depth() + 1;
      location.hash = h;
      history.replaceState({ hangarDepth: next }, '');
      top = next;
    },
    replaceHash: (h) => history.replaceState({ hangarDepth: depth() }, '', h),
    onHashChange,
    go: (delta) => history.go(delta),
  };
}
