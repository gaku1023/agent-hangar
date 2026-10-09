import type { Input, Overlay, State, Step } from './types.ts';

/**
 * 黙って別のものに差し替えてよいオーバーレイか。
 * 何も出ていないとき、パレット、読むだけのダイアログ（キーの一覧、昇格の完了）である。
 * 確認、未解決のプロジェクト、入力のあるダイアログ（新しいセッション、昇格、保持期間、設定の同期）は、決めるか閉じるまで差し替えない。
 * 確認の最初のフォーカスは「やめる」なので、修飾の無い / や ? も Root に届く。
 * 差し替えると、一覧から削除の確認から戻る先の未解決のダイアログが消えるからである。
 * Root のキーだけでなく、どの経路から来た開く操作もここで止める。
 */
export function overlayReplaceable(o: Overlay): boolean {
  return o.kind === 'none' || o.kind === 'palette' || o.kind === 'shortcuts' || o.kind === 'promoted';
}

/**
 * 未解決のプロジェクトのダイアログを開く。利用者が押したときだけ呼ぶ（設計書 2.11.5）。
 * 開いているダイアログが差し替えてよいものでなければ、何もしない。同じプロジェクトのものが開いていても何もしない。
 * 起動時と同期の直後には、サーバの project.unresolved の知らせでも開かない（ホームの帯の錠剤と、プロジェクトの一覧の札が、その入口になった）。
 */
function openResolve(state: State, id: string): Step {
  if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
  return { state: { ...state, overlay: { kind: 'resolveProject', projectId: id } }, effects: [] };
}

/**
 * 閉じる手（Esc、背景、×、あとで）で閉じる。
 * 一覧から削除の確認を閉じたときは、そこへ来たダイアログに戻る。帯の行から直に確認を出したときは、ダイアログを開いていないので戻らない。
 */
function closeOverlay(state: State): State {
  const o = state.overlay;
  if (o.kind === 'confirm' && o.confirm.kind === 'unlinkProject' && o.confirm.fromDialog === true) return { ...state, overlay: { kind: 'resolveProject', projectId: o.confirm.projectId } };
  return { ...state, overlay: { kind: 'none' } };
}

/** overlay 領域：ダイアログとパレット。未解決のプロジェクトのダイアログは、押したときだけ開く。 */
export function overlayStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'project.resolve.open': return openResolve(state, i.id);
    case 'project.resolve': {
      if (i.action.kind === 'unlink' && !i.confirmed) {
        // 一覧から削除は、セッションを未分類に戻してプロジェクトを消し、同期で他の端末にも広がる。先に確認を出す。
        // ダイアログから来たときだけ、やめたらそこへ戻れるよう、確認に印（fromDialog）を付ける。
        const fromDialog = state.overlay.kind === 'resolveProject' && state.overlay.projectId === i.id;
        return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'unlinkProject', projectId: i.id, ...(fromDialog ? { fromDialog: true } : {}) } } }, effects: [] };
      }
      // 確認から承諾したときも、ダイアログから決めたときも、閉じてから送る。帯の行から直に決めたときは、開いているものに触らない。
      const closes = state.overlay.kind === 'resolveProject' || (state.overlay.kind === 'confirm' && state.overlay.confirm.kind === 'unlinkProject');
      return { state: closes ? { ...state, overlay: { kind: 'none' } } : state, effects: [{ kind: 'api.resolveProject', projectId: i.id, action: i.action }] };
    }
    case 'overlay.close': return { state: closeOverlay(state), effects: [] };
    case 'palette.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'palette' } }, effects: [] } : { state, effects: [] };
    case 'shortcuts.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'shortcuts' } }, effects: [] } : { state, effects: [] };
    case 'palette.close': return { state: { ...state, overlay: { kind: 'none' } }, effects: [] };
    // Paused の入力（B1）。確認や入力のあるダイアログの上には重ねない。閉じるのは overlay.close（Esc）でもよい。
    case 'session.pause.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'pause', sessionId: i.id, from: i.from } }, effects: [] } : { state, effects: [] };
    case 'session.pause.close': return { state: state.overlay.kind === 'pause' ? { ...state, overlay: { kind: 'none' } } : state, effects: [] };
    default: return null;
  }
}
