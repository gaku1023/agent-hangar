import type { Store } from '../store/store.ts';
import { screenStep } from './screen.ts';
import type { Input, State, Step } from './types.ts';

/**
 * arrived 領域：他の PC から届いたプロジェクトの知らせ（設計書 2.11.5）。
 * 同期で、この PC に場所を持ったことが無いプロジェクトが降りてきたら、Runtime が projects.arrived で届ける。
 * ここは降りた id を覚え、右下の札（presenters/toasts.ts）を 1 枚だけ出させる。ダイアログは開かない。
 * 起動の読み込みで入るものは、Runtime が届けない。
 * 「プロジェクトで見る」はプロジェクトの画面へ移って札を下げ、「あとで決める」は札だけを下げる。
 * 入力のあるダイアログが開いていて画面を移せないときは、札を残す（押しても何も起きないのに札が消えるのを避ける）。
 */
export function arrivedStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'projects.arrived') {
    const next = [...state.arrivedProjects];
    for (const id of input.event.ids) if (!next.includes(id)) next.push(id);
    return next.length === state.arrivedProjects.length ? { state, effects: [] } : { state: { ...state, arrivedProjects: next }, effects: [] };
  }
  if (input.kind !== 'intent') return null;
  switch (input.intent.type) {
    case 'projects.arrived.dismiss': return { state: { ...state, arrivedProjects: [] }, effects: [] };
    case 'projects.arrived.view': {
      if (state.screen.name === 'projects') return { state: { ...state, arrivedProjects: [] }, effects: [] };
      const moved = screenStep(state, store, { kind: 'intent', intent: { type: 'nav.go', to: { name: 'projects' } } });
      // 移れなかった（開いているダイアログが許さない）なら、何も変えない。
      if (!moved || moved.effects.length === 0) return { state, effects: [] };
      return { state: { ...moved.state, arrivedProjects: [] }, effects: moved.effects };
    }
    default: return null;
  }
}
