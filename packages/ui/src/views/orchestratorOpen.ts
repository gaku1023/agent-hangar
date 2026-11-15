import { useSyncExternalStore } from 'react';

/**
 * 統括の柱の開閉（localStorage に残す。既定は畳む）。
 * 柱（OrchestratorPillar）とサイドバーの「統括」の行（Sidebar）が同じ値を読み書きするので、画面で 1 つだけ持つ。
 */
const OPEN_KEY = 'hangar.orchestrator.open';
const read = (): boolean => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const write = (open: boolean): void => { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* 保存できなくても動く */ } };

let value: boolean | null = null;
const listeners = new Set<() => void>();
const get = (): boolean => (value ??= read());
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** 開閉を変える。persist が偽なら覚えない（最初の描画で既定の開閉を渡す呼び出し用）。 */
export function setOrchestratorOpen(open: boolean, persist = true): void {
  if (get() === open) return;
  value = open;
  if (persist) write(open);
  for (const l of [...listeners]) l();
}

/** 開いているか。 */
export const useOrchestratorOpen = (): boolean => useSyncExternalStore(subscribe, get, get);
/** 試験用。覚えた値を捨てて、保存された値から読み直す。 */
export const resetOrchestratorOpen = (): void => { value = null; for (const l of [...listeners]) l(); };
