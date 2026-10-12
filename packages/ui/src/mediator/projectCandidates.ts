import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import { overlayReplaceable } from './overlay.ts';
import type { Input, State, Step } from './types.ts';

/**
 * projectCandidates 領域：Claude Code と会話したフォルダの候補のダイアログ（初日のプロジェクト。2026-10-13）。
 * 開くと候補を取り（答えは Store の folderCandidates）、送ると作成場所を決めてから、選んだフォルダをまとめて登録する。
 * 入口は、ホームの始める前の確認の「プロジェクト」の行と、設定のツールの節である。
 * 登録できたら閉じて件数を知らせ、準備の確かめを取り直す（帯の行が消える）。登録そのものが失敗したら、開いたまま理由を出す。
 */
export function projectCandidatesStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type !== 'project.candidates.done' && e.type !== 'project.candidates.failed') return null;
    const open = state.overlay.kind === 'projectCandidates';
    const t = translatorOf(store);
    if (e.type === 'project.candidates.failed') {
      if (!open) return { state, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
      return { state: { ...state, overlay: { kind: 'projectCandidates', submitting: false, error: e.message } }, effects: [] };
    }
    const toasts = [
      ...(e.registered > 0 ? [{ kind: 'toast' as const, level: 'info' as const, message: t('newProject.candidates.done', { n: e.registered }) }] : []),
      ...(e.failed.length > 0 ? [{ kind: 'toast' as const, level: 'error' as const, message: t('newProject.candidates.failed', { n: e.failed.length, reason: [...new Set(e.failed)].join(t('common.list.separator')) }) }] : []),
    ];
    return { state: open ? { ...state, overlay: { kind: 'none' } } : state, effects: [...toasts, { kind: 'api.readiness' }] };
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'project.candidates.open':
      // 確認や入力のあるダイアログが出ていれば、差し替えない（overlay.ts の overlayReplaceable）。
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'projectCandidates', submitting: false, error: null } }, effects: [{ kind: 'api.folderCandidates' }] };
    case 'project.candidates.submit':
      if (state.overlay.kind !== 'projectCandidates' || state.overlay.submitting) return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'projectCandidates', submitting: true, error: null } }, effects: [{ kind: 'api.registerFolders', paths: i.paths, workspaceRoot: i.workspaceRoot }] };
    default: return null;
  }
}
