import type { Input, Overlay, State, Step } from './types.ts';

/**
 * 黙って別のものに差し替えてよいオーバーレイか。
 * 何も出ていないとき、パレット、読むだけのダイアログ（キーの一覧、昇格の完了）である。
 * 確認、未解決のプロジェクト、入力のあるダイアログ（新しいセッション、昇格、保持期間、設定の取り込み）は、決めるか閉じるまで差し替えない。
 * 確認の最初のフォーカスは「やめる」なので、修飾の無い / や ? も Root に届く。
 * 差し替えると、確認の後ろに控えた未解決のダイアログもキューに戻らず消えるからである。
 * Root のキーだけでなく、どの経路から来た開く操作もここで止める。
 */
export function overlayReplaceable(o: Overlay): boolean {
  return o.kind === 'none' || o.kind === 'palette' || o.kind === 'shortcuts' || o.kind === 'promoted';
}

export function popQueue(state: State): State {
  const [next, ...rest] = state.unresolvedQueue;
  return next ? { ...state, overlay: { kind: 'resolveProject', projectId: next }, unresolvedQueue: rest } : { ...state, overlay: { kind: 'none' }, unresolvedQueue: [] };
}

/**
 * 未解決のプロジェクトを 1 つ出す。既に何か出ていればキューに積む。
 * byUser は利用者が自分で開きにきたときで、あとでを選んだ覚えを忘れて必ず出す。
 */
function openResolve(before: State, id: string, byUser = false): Step {
  if (!byUser && before.resolveDeferred.includes(id)) return { state: before, effects: [] };
  const state = byUser && before.resolveDeferred.includes(id) ? { ...before, resolveDeferred: before.resolveDeferred.filter((x) => x !== id) } : before;
  if (state.overlay.kind === 'resolveProject' && state.overlay.projectId === id) return { state, effects: [] };
  if (state.unresolvedQueue.includes(id)) return { state, effects: [] };
  if (state.overlay.kind === 'none') return { state: { ...state, overlay: { kind: 'resolveProject', projectId: id } }, effects: [] };
  return { state: { ...state, unresolvedQueue: [...state.unresolvedQueue, id] }, effects: [] };
}

/**
 * あとでを選んで閉じる。
 * そのプロジェクトは同じ起動の間もう聞かない。
 * 覚えるのは Mediator の状態だけなので、サーバを立て直せばまた聞く。
 */
function deferResolve(state: State): State {
  const next = popQueue(state);
  if (state.overlay.kind !== 'resolveProject') return next;
  const id = state.overlay.projectId;
  return next.resolveDeferred.includes(id) ? next : { ...next, resolveDeferred: [...next.resolveDeferred, id] };
}

/**
 * 何も出ていないのに未解決のキューが残っていたら、先頭を出す。
 * 一覧から削除の確認は、やめたときの戻り先としてプロジェクトをキューに積む。
 * その確認をパレットや新規セッションのダイアログで覆うと、覆ったものを閉じる経路（palette.close、新規の overlay.close、起動の完了など）はキューを見ない。
 * 閉じる経路ごとに popQueue を足すと漏れるので、どの領域が応答した後でもここで拾う。
 */
export function settleQueue(state: State): State {
  return state.overlay.kind === 'none' && state.unresolvedQueue.length > 0 ? popQueue(state) : state;
}

/** overlay 領域：ダイアログとパレット。未解決プロジェクトは一つずつ出す。 */
export function overlayStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'project.unresolved') return openResolve(state, input.event.projectId);
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'project.resolve.open': return openResolve(state, i.id, true);
    case 'project.resolve': {
      if (i.action.kind === 'unlink' && !i.confirmed) {
        // 一覧から削除は、セッションを未分類に戻してプロジェクトを消し、同期で他の端末にも広がる。先に確認を出す。
        // やめたら未解決のダイアログに戻れるよう、そのプロジェクトをキューの先頭に置いておく（overlay.close が popQueue で拾う）。
        const unresolvedQueue = [i.id, ...state.unresolvedQueue.filter((x) => x !== i.id)];
        return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'unlinkProject', projectId: i.id } }, unresolvedQueue }, effects: [] };
      }
      // 確認から承諾したときは、戻り先として積んだ分を外してから次へ進む。外さないと同じプロジェクトをまた聞く。
      const next = { ...state, unresolvedQueue: state.unresolvedQueue.filter((x) => x !== i.id) };
      return { state: popQueue(next), effects: [{ kind: 'api.resolveProject', projectId: i.id, action: i.action }] };
    }
    case 'overlay.close': return { state: deferResolve(state), effects: [] };
    case 'palette.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'palette' } }, effects: [] } : { state, effects: [] };
    case 'shortcuts.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'shortcuts' } }, effects: [] } : { state, effects: [] };
    case 'palette.close': return { state: { ...state, overlay: { kind: 'none' } }, effects: [] };
    // Paused の入力（B1）。確認や入力のあるダイアログの上には重ねない。閉じるのは overlay.close（Esc）でもよい。
    case 'session.pause.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'pause', sessionId: i.id, from: i.from } }, effects: [] } : { state, effects: [] };
    case 'session.pause.close': return { state: state.overlay.kind === 'pause' ? { ...state, overlay: { kind: 'none' } } : state, effects: [] };
    default: return null;
  }
}
