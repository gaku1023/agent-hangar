import type { State } from '../mediator/types.ts';
import { aliveRunOf, type Store } from '../store/store.ts';

export type PromoteProps = { sessionId: string; sessionName: string; runAlive: boolean; submitting: boolean; error: string | null };
export type PromotedProps = { projectId: string; projectName: string; moved: boolean; reason: string | null };

/** 昇格ダイアログ。run が生きているときはファイルを移動できないので、View が注意書きを出せるように渡す。 */
export function presentPromote(state: State, store: Store): PromoteProps | null {
  if (state.overlay.kind !== 'promote') return null;
  const id = state.overlay.sessionId;
  return {
    sessionId: id,
    sessionName: store.sessions[id]?.name ?? id,
    runAlive: aliveRunOf(store, id) !== null,
    submitting: state.promote.kind === 'submitting',
    error: state.promote.kind === 'failed' ? state.promote.message : null,
  };
}

/** 昇格の完了ダイアログ。移動しなかったときはその理由を出す。 */
export function presentPromoted(state: State, store: Store): PromotedProps | null {
  if (state.overlay.kind !== 'promoted') return null;
  const o = state.overlay;
  return { projectId: o.projectId, projectName: store.projects[o.projectId]?.name ?? o.projectId, moved: o.moved, reason: o.reason };
}
