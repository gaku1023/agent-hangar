import { useSyncExternalStore } from 'react';
import type { State } from '../mediator/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { Store } from '../store/store.ts';

/** Runtime の state と store を React に購読させる。 */
export function useRuntime(rt: Runtime): { state: State; store: Store } {
  const state = useSyncExternalStore(rt.subscribe, rt.getState, rt.getState);
  const store = useSyncExternalStore(rt.subscribe, rt.getStore, rt.getStore);
  return { state, store };
}
