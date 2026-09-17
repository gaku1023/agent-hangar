import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { Intent } from '@agent-hangar/shared';

export type Handled = { handled: boolean };
export type IntentHandler = (intent: Intent) => Handled;
export type Emit = (intent: Intent) => void;

export const IntentContext = createContext<Emit>(() => {});

/** View が Intent を発行するための関数。木を上へ伝播し、途中で処理されなければ Root に届く。 */
export function useEmit(): Emit {
  return useContext(IntentContext);
}

/** 中間層が一部の Intent を横取りする境界。処理しなければ親へ渡す（Chain of Responsibility）。 */
export function IntentBoundary(props: { handle: IntentHandler; children: ReactNode }) {
  const parent = useContext(IntentContext);
  const { handle } = props;
  const dispatch = useCallback<Emit>((intent) => { if (!handle(intent).handled) parent(intent); }, [parent, handle]);
  return <IntentContext.Provider value={dispatch}>{props.children}</IntentContext.Provider>;
}

/** 木の頂点。届いた Intent をすべて Mediator へ渡す。 */
export function IntentRoot(props: { onIntent: Emit; children: ReactNode }) {
  return <IntentContext.Provider value={props.onIntent}>{props.children}</IntentContext.Provider>;
}
