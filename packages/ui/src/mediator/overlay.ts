import type { ProjectSameFolderDto } from '@agent-hangar/shared';
import type { Input, Overlay, State, Step } from './types.ts';

/**
 * 黙って別のものに差し替えてよいオーバーレイか。
 * 何も出ていないとき、パレット、読むだけのダイアログ（キーの一覧、昇格の完了、差分）である。
 * 確認、未解決のプロジェクト、入力のあるダイアログ（新しいセッション、昇格、保持期間、設定の同期）は、決めるか閉じるまで差し替えない。
 * 確認の最初のフォーカスは「やめる」なので、修飾の無い / や ? も Root に届く。
 * 差し替えると、一覧から削除の確認から戻る先の未解決のダイアログが消えるからである。
 * Root のキーだけでなく、どの経路から来た開く操作もここで止める。
 */
export function overlayReplaceable(o: Overlay): boolean {
  return o.kind === 'none' || o.kind === 'palette' || o.kind === 'shortcuts' || o.kind === 'promoted' || o.kind === 'diff';
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

/**
 * 同じフォルダのプロジェクトをまとめる確認（サーバの 409）を開く。
 * 「場所を再指定」のダイアログは送るときに閉じているので、ふつうは差し替えてよい状態で届く。
 * 決めるまで閉じないダイアログが開いていれば差し替えず、null を返す（transition の残りが理由をトーストで出す）。
 */
function openMerge(state: State, c: ProjectSameFolderDto): Step | null {
  if (!overlayReplaceable(state.overlay)) return null;
  const confirm = { kind: 'mergeProject' as const, projectId: c.from.projectId, path: c.conflict.path, into: { projectId: c.conflict.projectId, name: c.conflict.name }, roots: c.merged.roots, sessions: c.merged.sessions, fromSessions: c.merged.fromSessions };
  return { state: { ...state, overlay: { kind: 'confirm', confirm } }, effects: [] };
}

/** いまのオーバーレイが、そのセッションについてのものか（Paused の入力、移す先、削除の確認）。 */
function overlayOfSession(o: Overlay, id: string): boolean {
  if (o.kind === 'pause' || o.kind === 'moveSession') return o.sessionId === id;
  return o.kind === 'confirm' && o.confirm.kind === 'deleteSession' && o.confirm.sessionId === id;
}

/**
 * セッションが消えた（この PC で消した、ほかの PC で消した印が届いた）。
 * その画面を開いていたらホームへ戻る。そのセッションについてのダイアログが開いていれば閉じる。
 * どちらでもなければ応答しない（ほかの領域に任せる）。
 */
function sessionRemoved(state: State, id: string): Step | null {
  const onScreen = state.screen.name === 'session' && state.screen.id === id;
  const closes = overlayOfSession(state.overlay, id);
  if (!onScreen && !closes) return null;
  return { state: closes ? { ...state, overlay: { kind: 'none' } } : state, effects: onScreen ? [{ kind: 'navigate', route: { name: 'home' } }] : [] };
}

/** overlay 領域：ダイアログとパレット。未解決のプロジェクトのダイアログは、押したときだけ開く。 */
export function overlayStep(state: State, input: Input): Step | null {
  if (input.kind === 'server' && input.event.type === 'session.removed') return sessionRemoved(state, input.event.id);
  if (input.kind === 'runtime' && input.event.type === 'api.conflict' && input.event.kind === 'sameFolder') return openMerge(state, input.event.conflict);
  // まとめた方は一覧から消えるので、その画面を開いていたら、残した方の画面へ移る。
  if (input.kind === 'runtime' && input.event.type === 'project.merged') {
    const e = input.event;
    return { state, effects: state.screen.name === 'project' && state.screen.id === e.fromId ? [{ kind: 'navigate', route: { name: 'project', id: e.intoId } }] : [] };
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
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
      // まとめる確認から承諾したときも同じく閉じる。
      const closes = state.overlay.kind === 'resolveProject' || (state.overlay.kind === 'confirm' && (state.overlay.confirm.kind === 'unlinkProject' || state.overlay.confirm.kind === 'mergeProject'));
      return { state: closes ? { ...state, overlay: { kind: 'none' } } : state, effects: [{ kind: 'api.resolveProject', projectId: i.id, action: i.action }] };
    }
    case 'overlay.close': {
      // 引き継ぎの 1 枚（takeover）は、黙って閉じるとサーバに待ちが残り、相手の claude が後から停止される。
      // ボタンのフォーカスが外れたあとの Esc は Root からこの形で届くので、取り消し（session.takeover.cancel）と同じに読む。
      const o = state.overlay;
      if (o.kind === 'confirm' && o.confirm.kind === 'takeover') return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'api.takeoverCancel', sessionId: o.confirm.sessionId }] };
      return { state: closeOverlay(state), effects: [] };
    }
    case 'palette.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'palette' } }, effects: [] } : { state, effects: [] };
    case 'shortcuts.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'shortcuts' } }, effects: [] } : { state, effects: [] };
    case 'palette.close': return { state: { ...state, overlay: { kind: 'none' } }, effects: [] };
    // Paused の入力（B1）。確認や入力のあるダイアログの上には重ねない。閉じるのは overlay.close（Esc）でもよい。
    case 'session.pause.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'pause', sessionId: i.id, from: i.from } }, effects: [] } : { state, effects: [] };
    // 差分のダイアログ。読むだけなので、パレットなどの上には重ねてよいが、決めるまで閉じないダイアログの上には重ねない。
    case 'diff.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'diff', sessionId: i.sessionId, file: i.file ?? null, source: null } }, effects: [] } : { state, effects: [] };
    case 'diff.select': return { state: state.overlay.kind === 'diff' ? { ...state, overlay: { ...state.overlay, file: i.file } } : state, effects: [] };
    case 'diff.source': return { state: state.overlay.kind === 'diff' ? { ...state, overlay: { ...state.overlay, source: i.source } } : state, effects: [] };
    // セッションのメニューの「プロジェクトを変更…」と「削除…」。確認や入力のあるダイアログの上には重ねない。
    case 'session.move.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'moveSession', sessionId: i.id } }, effects: [] } : { state, effects: [] };
    case 'session.delete.open': return overlayReplaceable(state.overlay) ? { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'deleteSession', sessionId: i.id } } }, effects: [] } : { state, effects: [] };
    case 'session.pause.close': return { state: state.overlay.kind === 'pause' ? { ...state, overlay: { kind: 'none' } } : state, effects: [] };
    default: return null;
  }
}
