import type { FolderCandidateDto } from '@agent-hangar/shared';
import { dirName, homePath } from '../lib/paths.ts';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { relativeTime } from './format.ts';
import { translatorOf } from './i18n.ts';

/** よく使うフォルダとして開いてチェックしておく、会話の数の下限（試作の 4 節 3b の案 B）。 */
export const FREQUENT_MIN = 3;

/**
 * 候補の 1 行。path は登録に送るパス、label はホームを ~ に縮めたパス、parent は親フォルダ（作成場所の直下かを見る）。
 * count は会話の数で、countLabel はその読み上げの文、when は最後の活動、worktrees はまとめた worktree の添え書き（無ければ null）。
 */
export type CandidateRow = { path: string; label: string; parent: string; count: number; countLabel: string; when: string; worktrees: string | null };

/**
 * Claude Code と会話したフォルダの候補のダイアログ（初日のプロジェクト。2026-10-13）。
 * frequent は会話が FREQUENT_MIN 件以上のもの（初めからチェック）、others はそのほか（畳む）である。
 * suggestedRoot は作成場所の候補（過半が同じ親にあるときだけ。label は ~ に縮めたもの）。
 * status は候補の読み込みの進みで、submitting と error は登録の送信の進みである。
 */
export type ProjectCandidatesProps = {
  status: 'loading' | 'failed' | 'ready';
  frequent: CandidateRow[];
  others: CandidateRow[];
  frequentMin: number;
  /** 「そのほか」の会話の数の上限（「会話 1〜N 件」の N）。 */
  othersMax: number;
  suggestedRoot: { path: string; label: string } | null;
  submitting: boolean;
  error: string | null;
};

/** 候補のダイアログ。overlay が projectCandidates のときだけ props を作る。 */
export function presentProjectCandidates(state: State, store: Store, now: number): ProjectCandidatesProps | null {
  if (state.overlay.kind !== 'projectCandidates') return null;
  const t = translatorOf(store);
  const c = store.folderCandidates;
  const status = c === null || c.status === 'loading' ? 'loading' : c.status === 'failed' ? 'failed' : 'ready';
  const list: FolderCandidateDto[] = c?.status === 'ready' ? c.data.candidates : [];
  const row = (x: FolderCandidateDto): CandidateRow => ({
    path: x.path, label: homePath(x.path, store.home), parent: dirName(x.path), count: x.sessionCount,
    countLabel: t('newProject.candidates.count', { n: x.sessionCount }), when: relativeTime(t, x.lastActivityAt, now),
    worktrees: x.worktreeCount > 0 ? t('newProject.candidates.worktrees', { n: x.worktreeCount }) : null,
  });
  const root = c?.status === 'ready' ? c.data.suggestedRoot : null;
  return {
    status,
    frequent: list.filter((x) => x.sessionCount >= FREQUENT_MIN).map(row),
    others: list.filter((x) => x.sessionCount < FREQUENT_MIN).map(row),
    frequentMin: FREQUENT_MIN,
    othersMax: FREQUENT_MIN - 1,
    suggestedRoot: root ? { path: root, label: homePath(root, store.home) } : null,
    submitting: state.overlay.submitting,
    error: state.overlay.error,
  };
}
