import type { ProjectStatus } from '@agent-hangar/shared';
import type { LaunchPrefs, NewSessionDraft, State } from '../mediator/types.ts';
import { hasMultipleAccounts, type Store } from '../store/store.ts';
import { SCRATCH_PREFS } from '../mediator/launch.ts';
import { presentAccounts, type AccountView } from './accounts.ts';
import { relativeTime } from './format.ts';

export type NewSessionProject = { id: string; name: string; path: string | null; status: ProjectStatus; lastActivity: string };
export type NewSessionProps = {
  projects: NewSessionProject[]; recentIds: string[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean;
  /** 前に閉じたときの書きかけ。開いたときの名前と初期プロンプトにする。 */
  draft: NewSessionDraft | null;
  /** 詳細のプロジェクトごとの前回値。鍵はプロジェクトの id で、スクラッチは ':scratch' である。 */
  prefs: Record<string, LaunchPrefs>;
  /** どのアカウントで起こすかの札。アカウントが 1 件以下なら null で、段ごと出さず、起動の params にも account を入れない。 */
  accounts: NewSessionAccounts | null;
};
export type NewSessionAccounts = { list: AccountView[]; currentId: string };

/** 札で選べるか。未ログインとログインの途中は選べない。まだ読めていない（unknown）は選べる。 */
export const isPickableAccount = (a: AccountView): boolean => a.auth !== 'out' && a.auth !== 'running';

/**
 * 札のはじめの選択。いまのアカウントが選べればそれ、選べなければ選べる最初の 1 件。
 * 1 件も選べなければ、いまのアカウントのまま（起動はサーバが断る）。
 */
export function defaultAccountChoice(accounts: NewSessionAccounts): string {
  const current = accounts.list.find((a) => a.id === accounts.currentId);
  if (current && isPickableAccount(current)) return current.id;
  return accounts.list.find(isPickableAccount)?.id ?? accounts.currentId;
}

/**
 * 利用者が選んだ id（まだ選んでいなければ null）から、いま札で選んでいる id を決める。
 * 選んだ id が一覧から消えた、または選べなくなったときは、はじめの選択に戻す。
 */
export function accountChoice(accounts: NewSessionAccounts, picked: string | null): string {
  const chosen = picked === null ? undefined : accounts.list.find((a) => a.id === picked);
  return chosen && isPickableAccount(chosen) ? chosen.id : defaultAccountChoice(accounts);
}

/**
 * ダイアログのプロジェクトの一覧で、スクラッチの行に当てる値。
 * 前回値（prefs）の鍵と同じ綴りなので、選んだ値でそのまま前回値を引ける。プロジェクトの id とは重ならない。
 */
export const SCRATCH_CHOICE = SCRATCH_PREFS;

/** 一覧の「最近」に置く件数。 */
export const RECENT_COUNT = 5;

/** 新規セッションのダイアログを開くときに、最初から選んでおくもの。session.new.open にそのまま載せる。 */
export type NewSessionTarget = { projectId?: string; scratch?: boolean };

/**
 * ⌘N とヘッダーの新規ボタンで開くダイアログの、最初の選択。
 * プロジェクトの画面ならそのプロジェクト、セッションの画面ならそのセッションのプロジェクトを選ぶ。
 * スクラッチの擬似プロジェクトは選べないので、その画面の「新規」と同じくスクラッチで開く。
 * ほかの画面とプロジェクトの無いセッションでは何も選ばない。
 */
export function newSessionTarget(state: State, store: Store): NewSessionTarget {
  const s = state.screen;
  const projectId = s.name === 'project' ? s.id : s.name === 'session' ? store.sessions[s.id]?.projectId ?? null : null;
  if (!projectId) return {};
  return store.projects[projectId]?.isScratch ? { scratch: true } : { projectId };
}

/** 起動ダイアログ。overlay が newSession のときだけ props を作る。 */
export function presentNewSession(state: State, store: Store, now: number): NewSessionProps | null {
  if (state.overlay.kind !== 'newSession') return null;
  // スクラッチの擬似プロジェクトは選ばせない。
  const live = Object.values(store.projects).filter((p) => !p.isScratch && p.resolved && p.status !== 'archived');
  const projects = [...live].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name, path: p.path, status: p.status, lastActivity: p.lastActivityAt === null ? '' : relativeTime(p.lastActivityAt, now) }));
  // 最近は最後に使った時刻の新しい順。使ったことのないプロジェクトは入れない。
  const recentIds = live.filter((p) => p.lastActivityAt !== null).sort((a, b) => b.lastActivityAt! - a.lastActivityAt!).slice(0, RECENT_COUNT).map((p) => p.id);
  return { projects, recentIds, projectId: state.overlay.projectId, submitting: state.launch.kind === 'submitting', error: state.launch.kind === 'failed' ? state.launch.message : null, scratch: state.overlay.scratch, draft: state.newSessionDraft, prefs: state.launchPrefs, accounts: newSessionAccounts(store, now) };
}

/** アカウントが 2 件以上のときだけ札の中身を作る。1 件以下の画面は今までと変えない。 */
function newSessionAccounts(store: Store, now: number): NewSessionAccounts | null {
  if (!hasMultipleAccounts(store)) return null;
  const list = presentAccounts(store, now);
  return { list, currentId: list.find((a) => a.current)?.id ?? '' };
}
