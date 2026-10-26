import { codexEnabledOf, opencodeEnabledOf, type OpencodeOptionsDto, type ProjectStatus, type Translate } from '@agent-hangar/shared';
import type { LaunchPrefs, NewSessionDraft, State } from '../mediator/types.ts';
import { hasMultipleAccounts, type CodexOptionsState, type OpencodeOptionsState, type Store } from '../store/store.ts';
import type { FolderInspectState } from '../store/folderInspect.ts';
import { SCRATCH_PREFS } from '../mediator/launch.ts';
import { approveText, isPickableAccount, loggedOutText, presentAccounts, type AccountView } from './accounts.ts';
import { relativeTime } from './format.ts';
import { translatorOf } from './i18n.ts';
import { presentLaunchPrep, type LaunchPrepView } from './launchPrep.ts';

export type NewSessionProject = { id: string; name: string; path: string | null; status: ProjectStatus; lastActivity: string };
export type NewSessionProps = {
  projects: NewSessionProject[]; recentIds: string[]; projectId: string | null; submitting: boolean; error: string | null; scratch: boolean;
  /** 前に閉じたときの書きかけ。開いたときの名前と初期プロンプトにする。 */
  draft: NewSessionDraft | null;
  /** 詳細のプロジェクトごとの前回値。鍵はプロジェクトの id で、クイックセッションは ':scratch' である。 */
  prefs: Record<string, LaunchPrefs>;
  /** ワークスペース直下の未登録のフォルダ。store のプロジェクトのパスは除いてある（作った直後に残らないように）。 */
  dirs: { name: string; path: string }[];
  /**
   * store のプロジェクトのフォルダ名（小文字）。アーカイブも含む。
   * 同じ名前のフォルダは作れない（409）ので、「『語』を新しいフォルダとして作る」をこの名前には出さない。
   * APFS は大文字小文字を区別しないので、小文字でそろえて比べる。
   */
  takenNames: string[];
  /** 新しいフォルダの作り先の表示に使う。設定が読めていなければ null。 */
  workspaceRoot: string | null;
  /** 殻の中か。Finder の操作は殻の中だけで出す。 */
  desktop: boolean;
  /** Finder で選んだフォルダ。n は選んだ回数で、開いた時点より新しいものだけをダイアログが使う。 */
  picked: { path: string; n: number } | null;
  /** 作ってから起動する送信で、作れた後に起動だけ失敗したときのプロジェクト。ダイアログはこれを選び直す。 */
  createdProjectId: string | null;
  /** どのアカウントで起こすかの札。アカウントが 1 件以下なら null で、段ごと出さず、起動の params にも account を入れない。 */
  accounts: NewSessionAccounts | null;
  /** 前回値にモデルが無いときのモデルの札の初めの値（設定の既定のモデル）。null と省略は Claude Code の既定。 */
  defaultModel?: string | null;
  /** worktree の札をオンにして開くか（同じファイルの編集の警告の「worktree で新しいセッション」から開いたとき）。名前はダイアログが付ける。 */
  worktree?: boolean;
  /** はじめに選んでおくフォルダ（作成のダイアログから、登録済みのプロジェクトの下のフォルダで始めるとき）。無ければ null。 */
  dir?: string | null;
  /**
   * 選んだフォルダの事前の問い合わせ（0.6.1）。登録済みのプロジェクトの下か、ほかの PC から届いた同じプロジェクトがあるか。
   * ダイアログは path が選んだフォルダと同じときだけ使う。無ければ null で、今までどおり登録して始める。
   */
  inspect?: FolderInspectState | null;
  /**
   * opencode（ベータ）。設定で有効にしたときだけ渡し、ダイアログは札の先頭に「エージェント」を出す。null と省略は無効で、ダイアログは今のまま。
   * options は opencode を選んだときに読むモードとモデル（最後に頼んだ場所の 1 件）。ダイアログは dir が自分の場所と同じときだけ使う。
   */
  opencode?: NewSessionOpencode | null;
  /**
   * Codex（ベータ）。設定で有効にしたときだけ渡し、ダイアログはエージェントの一覧に Codex を足す。null と省略は無効で、一覧に出さない。
   * options は Codex を選んだときに読むモデルと推論の段階（場所に依らない）。
   */
  codex?: NewSessionCodex | null;
  /**
   * 送った起動の準備の進み（起動前の準備、docs/design.md）。段の無い準備と、まだ何も届かないうちは null で、今までどおりの見た目になる。
   * 進みの箱、問いの札、失敗の札はこれから出す。
   */
  prep?: LaunchPrepView | null;
};
export type NewSessionOpencode = { options: OpencodeOptionsState | null };
export type NewSessionCodex = { options: CodexOptionsState | null };
export type NewSessionAccounts = { list: AccountView[]; currentId: string };

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

/** アカウントの札の一覧の 1 行。選べない行（未ログイン、初めてのログインの途中）は disabled で、理由を tag に持つ。 */
export type NewSessionAccountOption = { value: string; label: string; color: string; disabled: boolean; tag?: string };

/** 札から開く一覧の行。色の点は札の中のアカウントの色で、選べるかどうかは isPickableAccount が決める。 */
export function accountOptions(t: Translate, accounts: NewSessionAccounts): NewSessionAccountOption[] {
  return accounts.list.map((a) => {
    const reason = a.auth === 'out' ? loggedOutText(t) : a.auth === 'running' && !a.loggedIn ? approveText(t) : undefined;
    return { value: a.id, label: a.name, color: a.color, disabled: !isPickableAccount(a), ...(reason ? { tag: reason } : {}) };
  });
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/**
 * ダイアログのプロジェクトの一覧で、クイックセッションの行に当てる値。
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
 * クイックセッションの擬似プロジェクトは選べないので、その画面の「新規」と同じくクイックセッションで開く。
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
  const t = translatorOf(store);
  // クイックセッションの擬似プロジェクトは選ばせない。
  const resolved = Object.values(store.projects).filter((p) => !p.isScratch && p.resolved);
  const live = resolved.filter((p) => p.status !== 'archived');
  // アーカイブは後ろに置き、ダイアログが検索したときだけ出す。
  const byName = (list: typeof resolved) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const projects = [...byName(live), ...byName(resolved.filter((p) => p.status === 'archived'))].map((p) => ({ id: p.id, name: p.name, path: p.path, status: p.status, lastActivity: p.lastActivityAt === null ? '' : relativeTime(t, p.lastActivityAt, now) }));
  // 最近は最後に使った時刻の新しい順。使ったことのないプロジェクトは入れない。
  const recentIds = live.filter((p) => p.lastActivityAt !== null).sort((a, b) => b.lastActivityAt! - a.lastActivityAt!).slice(0, RECENT_COUNT).map((p) => p.id);
  const taken = new Set(Object.values(store.projects).map((p) => p.path).filter((p): p is string => !!p));
  const dirs = (store.workspaceDirs ?? []).filter((d) => !taken.has(d.path));
  // クイックセッションはワークスペースの外に置くので、その名前で作っても重ならない。
  const takenNames = [...new Set(Object.values(store.projects).filter((p) => !p.isScratch && p.path).map((p) => baseName(p.path!).toLowerCase()))];
  const createdProjectId = state.launch.kind === 'failed' || state.launch.kind === 'submitting' || state.launch.kind === 'halted' ? state.launch.createdProjectId ?? null : null;
  const mark = state.launchPrep;
  const prepDto = mark ? store.launchPreps[mark.key] : undefined;
  return {
    projects, recentIds, projectId: state.overlay.projectId, submitting: state.launch.kind === 'submitting', error: state.launch.kind === 'failed' ? state.launch.message : null, scratch: state.overlay.scratch, draft: state.newSessionDraft, prefs: state.launchPrefs,
    dirs, takenNames, workspaceRoot: store.settings?.workspaceRoot ?? null, desktop: store.desktop, picked: store.pickedFolder, createdProjectId, accounts: newSessionAccounts(store, now), defaultModel: store.settings?.defaultModel ?? null,
    ...(state.overlay.worktree ? { worktree: true } : {}),
    dir: state.overlay.dir ?? null, inspect: store.folderInspect,
    opencode: opencodeEnabledOf(store.settings ?? {}) ? { options: store.opencodeOptions } : null,
    codex: codexEnabledOf(store.settings ?? {}) ? { options: store.codexOptions } : null,
    prep: mark && prepDto ? presentLaunchPrep(prepDto, t, mark.model) : null,
  };
}

/**
 * opencode のモデルの札の値。remembered は前回の値（利用者がいま選んだ値も同じ扱い）で、空はデフォルト。
 * 一覧が届いていて、そこから前回のモデルが消えていたら（無料枠の終わりなど）、デフォルトに戻し、reset を真にする。
 * reset はダイアログが「戻した」ことを小さく知らせるための印である（知らせの見せ方は試作で選ぶ途中で、まだ出さない）。
 * 一覧がまだ無いときは、消えたかどうか分からないので前回のままにする。
 */
export function opencodeModelChoice(remembered: string, options: OpencodeOptionsDto | null): { model: string; reset: boolean } {
  if (!remembered || !options) return { model: remembered, reset: false };
  return options.models.some((m) => m.id === remembered) ? { model: remembered, reset: false } : { model: '', reset: true };
}

/** エージェントの一覧の opencode の行に添える「opencode 2.1.4 · 検証済み」。版が分からなければ null。 */
export function opencodeAgentNote(t: Translate, options: OpencodeOptionsDto | null): string | null {
  if (!options?.version) return null;
  return t(options.verified ? 'launch.agent.opencodeVerified' : 'launch.agent.opencodeUnverified', { version: options.version });
}

/** アカウントが 2 件以上のときだけ札の中身を作る。1 件以下の画面は今までと変えない。 */
function newSessionAccounts(store: Store, now: number): NewSessionAccounts | null {
  if (!hasMultipleAccounts(store)) return null;
  const list = presentAccounts(store, now);
  return { list, currentId: list.find((a) => a.current)?.id ?? '' };
}
