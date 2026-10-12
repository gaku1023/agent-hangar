import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { UiAction } from '@agent-hangar/shared';

export type Handled = { handled: boolean };
export type ActionHandler = (action: UiAction) => Handled;
export type Emit = (action: UiAction) => void;

export const ActionContext = createContext<Emit>(() => {});

/** View が UiAction を発行するための関数。木を上へ伝播し、途中で処理されなければ Root に届く。 */
export function useEmit(): Emit {
  return useContext(ActionContext);
}

/** 中間層が一部の UiAction を横取りする境界。処理しなければ親へ渡す（Chain of Responsibility）。 */
export function ActionBoundary(props: { handle: ActionHandler; children: ReactNode }) {
  const parent = useContext(ActionContext);
  const { handle } = props;
  const dispatch = useCallback<Emit>((action) => { if (!handle(action).handled) parent(action); }, [parent, handle]);
  return <ActionContext.Provider value={dispatch}>{props.children}</ActionContext.Provider>;
}

const noop: Emit = () => {};
/**
 * 画面が出すだけの裏の読み込み（git の表示の取得：見えている行の git.watch、開いた画面の差分の一覧とプロジェクトの git）。
 * 利用者の操作ではないので、操作の道（useEmit と ActionBoundary）とは分け、Root だけが Runtime へつなぐ。無ければ何もしない。
 */
const BackgroundContext = createContext<Emit>(noop);
export function useBackgroundEmit(): Emit {
  return useContext(BackgroundContext);
}

/** 木の頂点。届いた UiAction をすべて Mediator へ渡す。background は裏の読み込みの行き先（useBackgroundEmit）。 */
export function ActionRoot(props: { onAction: Emit; background?: Emit; children: ReactNode }) {
  return (
    <BackgroundContext.Provider value={props.background ?? noop}>
      <ActionContext.Provider value={props.onAction}>{props.children}</ActionContext.Provider>
    </BackgroundContext.Provider>
  );
}
