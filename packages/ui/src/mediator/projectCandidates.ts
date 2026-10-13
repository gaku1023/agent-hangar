import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import { overlayReplaceable } from './overlay.ts';
import type { Input, State, Step } from './types.ts';

/**
 * projectCandidates 領域：まとめて登録のダイアログ（初日のプロジェクト。2026-10-13）。
 * 見方は 2 つで、Claude Code と会話したフォルダ（talked）と、フォルダの中から（folder。0.6.2）である。
 * 開くと候補を取り（答えは Store の folderCandidates。フォルダの中からの開いた時点の親にも使う）、送ると作成場所を決めてから、選んだフォルダをまとめて登録する。
 * フォルダの中からの親の直下は、ダイアログが頼むたびに取る（答えは Store の workspaceChildren）。
 * 入口は、ホームの始める前の確認の「プロジェクト」の行、設定のツールの節、新しいプロジェクトのダイアログの「フォルダの中からまとめて選ぶ…」である。
 * 登録できたら閉じて件数を知らせ、準備の確かめを取り直す（帯の行が消える）。登録そのものが失敗したら、開いたまま理由を出す。
 */
export function projectCandidatesStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type !== 'project.candidates.done' && e.type !== 'project.candidates.failed') return null;
    const open = state.overlay.kind === 'projectCandidates';
    const t = translatorOf(store);
    if (e.type === 'project.candidates.failed') {
      if (state.overlay.kind !== 'projectCandidates') return { state, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
      return { state: { ...state, overlay: { ...state.overlay, submitting: false, error: e.message } }, effects: [] };
    }
    const done = e.linked > 0 ? t('newProject.candidates.doneLinked', { n: e.registered, m: e.linked }) : t('newProject.candidates.done', { n: e.registered });
    const toasts = [
      ...(e.registered > 0 ? [{ kind: 'toast' as const, level: 'info' as const, message: done }] : []),
      ...(e.failed.length > 0 ? [{ kind: 'toast' as const, level: 'error' as const, message: t('newProject.candidates.failed', { n: e.failed.length, reason: [...new Set(e.failed)].join(t('common.list.separator')) }) }] : []),
    ];
    return { state: open ? { ...state, overlay: { kind: 'none' } } : state, effects: [...toasts, { kind: 'api.readiness' }] };
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'project.candidates.open': {
      // 確認や入力のあるダイアログが出ていれば、差し替えない（overlay.ts の overlayReplaceable）。
      // 新しいプロジェクトのダイアログの「フォルダの中からまとめて選ぶ…」は、利用者がそのダイアログから移ると選んだので入れ替える。
      const fromNewProject = state.overlay.kind === 'newProject' && i.source === 'folder';
      if (!overlayReplaceable(state.overlay) && !fromNewProject) return { state, effects: [] };
      const next = { ...state, overlay: { kind: 'projectCandidates' as const, source: i.source ?? 'talked', submitting: false, error: null } };
      return { state: fromNewProject ? { ...next, projectCreate: { kind: 'idle' } } : next, effects: [{ kind: 'api.folderCandidates' }] };
    }
    case 'project.candidates.submit':
      if (state.overlay.kind !== 'projectCandidates' || state.overlay.submitting) return { state, effects: [] };
      return { state: { ...state, overlay: { ...state.overlay, submitting: true, error: null } }, effects: [{ kind: 'api.registerFolders', items: i.items, workspaceRoot: i.workspaceRoot }] };
    case 'project.folders.load':
      if (state.overlay.kind !== 'projectCandidates') return { state, effects: [] };
      return { state, effects: [{ kind: 'api.workspaceChildren', parent: i.parent }] };
    default: return null;
  }
}
