import type { Store } from '../store/store.ts';
import type { ContextShort, Input, State, Step } from './types.ts';

/**
 * contextShort 領域：起動した後に、ローカルのモデルのコンテキストが足りずに opencode が断られた右下の札（docs/design.md「起動前の準備」）。
 * サーバの opencode.contextShort（会話の id）を受けて 1 枚出し、同じ会話の札は 1 枚にまとめる（古いものが先）。
 * 「再ロードして再開」は、画面が作った鍵を添えて整え直しを頼み（api.fixContextShort）、進みは札の中に 1 行で出す（鍵の launch.prep）。
 * 済んだら札を「済んだ」の知らせに替え、失敗したら札をもとに戻して理由をエラーのトーストで出す。「閉じる」はその会話の札だけを下げる。
 */
export function contextShortStep(state: State, _store: Store, input: Input): Step | null {
  const set = (contextShorts: ContextShort[]): Step => ({ state: { ...state, contextShorts }, effects: [] });
  const patch = (sessionId: string, p: Partial<ContextShort>): ContextShort[] => state.contextShorts.map((c) => (c.sessionId === sessionId ? { ...c, ...p } : c));
  if (input.kind === 'server' && input.event.type === 'opencode.contextShort') {
    const id = input.event.sessionId;
    const have = state.contextShorts.find((c) => c.sessionId === id);
    // 整え直しの最中に届いても、進みを消さない。済んだあとにまた足りなくなったら、もう一度出す。
    if (have && !have.done) return { state, effects: [] };
    return set(have ? patch(id, { fix: null, done: false }) : [...state.contextShorts, { sessionId: id, fix: null, done: false }]);
  }
  if (input.kind === 'runtime') {
    const ev = input.event;
    if (ev.type === 'contextShort.done') return set(patch(ev.sessionId, { fix: null, done: true }));
    if (ev.type === 'contextShort.failed') return { state: { ...state, contextShorts: patch(ev.sessionId, { fix: null }) }, effects: [{ kind: 'toast', level: 'error', message: ev.message }] };
    return null;
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'launchPrep.short.fix': {
      const c = state.contextShorts.find((x) => x.sessionId === i.sessionId);
      if (!c || c.fix) return { state, effects: [] };
      return { state: { ...state, contextShorts: patch(i.sessionId, { fix: { key: i.prepKey }, done: false }) }, effects: [{ kind: 'api.fixContextShort', sessionId: i.sessionId, prepKey: i.prepKey }] };
    }
    case 'launchPrep.short.dismiss': return set(state.contextShorts.filter((c) => c.sessionId !== i.sessionId));
    default: return null;
  }
}
