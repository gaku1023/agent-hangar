import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { FindState } from '../presenters/find.ts';

/**
 * 本文の中の検索（⌘F）の状態の置き場。
 * その場の操作で、Mediator のほかの領域も Presenter も使わないので、State ではなく View の側に持つ。
 * 鍵はセッションの id である。
 * 本文の部品は画面を離れると外れるので、部品の中ではなく Root が作る置き場に持ち、戻ってきたときに同じ欄と語を出す。
 * 保存はしない。
 */
export type FindStore = {
  get(sessionId: string): FindState | null;
  /** 欄を開く。開いたままでも呼べて、欄へフォーカスを戻す合図（n）を進める。 */
  open(sessionId: string): void;
  /** 語を変える。from は語を打ったときに見ていた行の seq で、数え始めをそこへ戻す。閉じていれば何もしない。 */
  query(sessionId: string, query: string, caseSensitive: boolean, from: number | null): void;
  /** 前へ次へ。閉じていれば何もしない。 */
  step(sessionId: string, delta: number): void;
  close(sessionId: string): void;
  subscribe(listener: () => void): () => void;
};

export function createFindStore(): FindStore {
  const finds = new Map<string, FindState>();
  const listeners = new Set<() => void>();
  const put = (id: string, next: FindState | null) => {
    if (next) finds.set(id, next); else finds.delete(id);
    for (const l of [...listeners]) l();
  };
  return {
    get: (id) => finds.get(id) ?? null,
    open: (id) => {
      const cur = finds.get(id);
      put(id, { query: cur?.query ?? '', caseSensitive: cur?.caseSensitive ?? false, from: cur?.from ?? null, step: cur?.step ?? 0, n: (cur?.n ?? 0) + 1 });
    },
    query: (id, query, caseSensitive, from) => {
      const cur = finds.get(id);
      if (cur) put(id, { ...cur, query, caseSensitive, from, step: 0 });
    },
    step: (id, delta) => {
      const cur = finds.get(id);
      if (cur) put(id, { ...cur, step: cur.step + delta });
    },
    close: (id) => { if (finds.has(id)) put(id, null); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const FindContext = createContext<FindStore | null>(null);

/** 木の頂点に置く。⌘F を受ける Root と、欄を描く本文とが同じ置き場を使う。 */
export function FindRoot(props: { store: FindStore; children: ReactNode }) {
  return <FindContext.Provider value={props.store}>{props.children}</FindContext.Provider>;
}

export type FindHandle = {
  state: FindState | null;
  open(): void;
  query(query: string, caseSensitive: boolean, from: number | null): void;
  step(delta: number): void;
  close(): void;
};

/**
 * そのセッションの検索の状態と、それを変える手。
 * FindRoot の外（部品だけを描く試験など）では、その部品の中だけの置き場を使う。
 */
export function useFind(sessionId: string): FindHandle {
  const shared = useContext(FindContext);
  const [own] = useState(createFindStore);
  const store = shared ?? own;
  const state = useSyncExternalStore(store.subscribe, () => store.get(sessionId));
  return useMemo(() => ({
    state,
    open: () => store.open(sessionId),
    query: (query, caseSensitive, from) => store.query(sessionId, query, caseSensitive, from),
    step: (delta) => store.step(sessionId, delta),
    close: () => store.close(sessionId),
  }), [state, store, sessionId]);
}
