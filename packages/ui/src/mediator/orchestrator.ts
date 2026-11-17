import { unreadOf, type Store } from '../store/store.ts';
import type { Input, State, Step } from './types.ts';

/** 開いた柱の幅（px）の保存の鍵、既定（今までの柱の幅で、これより狭くはしない）、上限、窓の幅に対する割合の上限（端末を狭くし過ぎない）。 */
export const ORCH_WIDTH_KEY = 'orchestrator.width';
export const ORCH_WIDTH_DEFAULT = 340;
export const ORCH_WIDTH_MAX = 640;
export const ORCH_WIDTH_VIEWPORT = 0.4;

/** 保存された幅を読み戻す。数でなければ既定、範囲の外は端に寄せる。 */
export function cleanOrchWidth(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ORCH_WIDTH_DEFAULT;
  return Math.max(ORCH_WIDTH_DEFAULT, Math.min(ORCH_WIDTH_MAX, Math.round(v)));
}

/** 柱の幅の CSS。窓が狭いときは窓の幅の 40% で頭打ちにし、ただし既定より狭くはしない（サイドバーの sidebarWidthCss と同じ作り）。 */
export const orchWidthCss = (width: number): string => `clamp(${ORCH_WIDTH_DEFAULT}px, ${ORCH_WIDTH_VIEWPORT * 100}vw, ${width}px)`;

/**
 * 統括の柱を開いている間は、統括の会話の未読を既読にする（サイドバーの「統括」の行の丸を消す）。
 * 柱を開いた瞬間（fromStore が偽）は未読があれば頼み、開いて見ている間に増えた分（ストアの変化）は、窓が前にあるときだけ送る印（ifFront）を付けて頼む。
 * 同じ未読（会話の id と未読の最後の時刻）へは 1 度だけ頼む。入力待ち（waiting）は未読ではないので触らない（答えるまで残る）。
 */
export function orchestratorSeenStep(state: State, store: Store, fromStore: boolean): Step {
  const id = store.settings?.orchestrator?.sessionId;
  const u = id ? unreadOf(store, id) : null;
  if (!state.orchestratorOpen || !id || !u || u.count <= 0) return { state, effects: [] };
  const key = `${id}|${u.at}`;
  if (state.orchSeenAsked === key) return { state, effects: [] };
  return { state: { ...state, orchSeenAsked: key }, effects: [{ kind: 'api.markSeen', sessionId: id, ...(fromStore ? { ifFront: true as const } : {}) }] };
}

/**
 * 統括の柱の操作（docs/design.md「統括」）。
 * 会話と記録は Runtime が読む事実なので Store が持つ（store/orchestrator.ts）。ここは画面の操作を効果にするだけで、State は変えない。
 */
export function orchestratorStep(state: State, input: Input, store?: Store): Step | null {
  if (input.kind !== 'action') return null;
  const a = input.action;
  switch (a.type) {
    case 'orchestrator.open': return { state, effects: [{ kind: 'orchestrator', command: { op: 'load' } }] };
    case 'orchestrator.pillar': {
      // 柱の開閉が変わったら、その場だけ開いていた右の欄（tocPeek）を戻す。開いた直後は畳んだ形から、閉じた後は保存した開閉から始める。
      const peeking = state.panes.tocPeek.length > 0 || Object.values(state.sessionView).some((v) => v.tocPeek);
      if (state.orchestratorOpen === a.open && !peeking) return { state, effects: [] };
      const sessionView = Object.fromEntries(Object.entries(state.sessionView).map(([id, v]) => [id, v.tocPeek ? { ...v, tocPeek: false } : v]));
      const next: State = { ...state, orchestratorOpen: a.open, sessionView, panes: { ...state.panes, tocPeek: [] } };
      // 開いたら、統括の会話の未読を既読にする。
      return store ? orchestratorSeenStep(next, store, false) : { state: next, effects: [] };
    }
    case 'orchestrator.width': {
      const width = cleanOrchWidth(a.width);
      if (width === state.orchestratorWidth) return { state, effects: [] };
      return { state: { ...state, orchestratorWidth: width }, effects: [{ kind: 'storage.save', key: ORCH_WIDTH_KEY, value: width }] };
    }
    case 'orchestrator.send': return { state, effects: [{ kind: 'orchestrator', command: { op: 'send', text: a.text, ...(a.origin !== undefined ? { origin: a.origin } : {}) } }] };
    default: return null;
  }
}
