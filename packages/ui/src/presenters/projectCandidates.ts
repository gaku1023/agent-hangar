import type { FolderCandidateDto, LinkCandidateDto, WorkspaceChildDto } from '@agent-hangar/shared';
import { dirName, homePath, isRootPath } from '../lib/paths.ts';
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
 * 「フォルダの中から」の 1 行（0.6.1、試作 proto-register の推す案）。
 * count は会話の数（0 は「—」）、countLabel はその読み上げ、when は最後の活動（無ければ空）、sessions は会話の数そのもの（作成場所の自動の登録を見る）。
 * registered はこのフォルダを場所にしているプロジェクトがあること（外せない灰のチェック）、worktree はほかのリポジトリの worktree であること。
 * inside は、登録済みのプロジェクトの中のフォルダであること（分けるには allowNested を明示して送る）。
 * note は名前の下の 1 行で、押すと何が起きるかを言う（登録済み、worktree、別のプロジェクトの中、git のフォルダを含む）。親そのものを包むプロジェクトの中の行は、帯で 1 回だけ言うので添えない。
 * link は、ほかの PC から届いたプロジェクトに結び付く候補と、その理由と行き先の 1 行である。
 * children は、git でなく中に git のフォルダを持つときの 1 段下の行である。
 */
export type FolderRow = {
  path: string; name: string; git: boolean;
  count: string; countLabel: string; when: string; sessions: number;
  registered: boolean; worktree: boolean; inside: boolean;
  note: string | null;
  link: { projectId: string; note: string } | null;
  children: FolderRow[] | null;
};

/**
 * 「フォルダの中から」の見方（0.6.1）。
 * status は親の直下の読み込みの進み（idle はまだ頼んでいない）、failure は読めなかった理由である。
 * parent は読めた親（サーバが ~ を直した形と、~ に縮めた形）、band は親そのものを包むプロジェクトの名前（黄の帯）。
 * initialParent は開いた時点に入れる親（~ に縮めた形）で、作成場所があればそれ、無ければ会話の多い親である。null は決まらなかったこと、undefined は設定か候補を待っていること。
 * rootable は、作成場所が空で、読めた親を作成場所にできること（帯のあるとき、ホームフォルダ、根は除く）。
 * home は Finder の結果を ~ に縮めるため、desktop と picked は「選ぶ…」のためにある。
 */
export type FolderBrowseProps = {
  status: 'idle' | 'loading' | 'failed' | 'ready';
  failure: string | null;
  parent: { path: string; label: string } | null;
  band: string | null;
  rows: FolderRow[];
  initialParent: string | null | undefined;
  rootable: boolean;
  home: string | null;
  desktop: boolean;
  picked: { path: string; n: number } | null;
};

/**
 * まとめて登録のダイアログ（初日のプロジェクト。2026-10-13）。
 * source は開いた時点の見方（talked は Claude Code と会話したフォルダ、folder はフォルダの中から。0.6.1）で、browse はフォルダの中からの中身である。
 * 以下は Claude Code と会話したフォルダの見方の中身である。
 * frequent は会話が FREQUENT_MIN 件以上のもの（初めからチェック）、others はそのほか（畳む）である。
 * suggestedRoot は作成場所の候補（過半が同じ親にあるときだけ。label は ~ に縮めたもの）。
 * status は候補の読み込みの進みで、submitting と error は登録の送信の進みである。
 */
export type ProjectCandidatesProps = {
  source: 'talked' | 'folder';
  browse: FolderBrowseProps;
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
    source: state.overlay.source,
    browse: presentFolderBrowse(store, now),
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

/** 開いた時点の親。作成場所があればそれ、無ければ会話の多い親（候補の suggestedRoot と同じ求め方）。設定か候補を待つ間は undefined。 */
function initialParentOf(store: Store): string | null | undefined {
  const ws = store.settings?.workspaceRoot;
  if (ws === undefined) return undefined;
  if (ws !== '') return homePath(ws, store.home);
  const c = store.folderCandidates;
  if (c === null || c.status === 'loading') return undefined;
  return c.status === 'ready' && c.data.suggestedRoot ? homePath(c.data.suggestedRoot, store.home) : null;
}

/** 結び付く候補の 1 行。理由（同じリポジトリ、同じ名前）と、行き先（場所を持つ PC、この PC で見つからなくなったもの）を言う。 */
function linkNote(t: ReturnType<typeof translatorOf>, l: LinkCandidateDto): string {
  const who = l.deviceName !== null ? t('newProject.browse.who.device', { device: l.deviceName, name: l.name })
    : l.previousPath !== null ? t('newProject.browse.who.lost', { name: l.name })
      : t('newProject.browse.who.other', { name: l.name });
  return t(l.match === 'remote' ? 'newProject.browse.linkRemote' : 'newProject.browse.linkName', { who });
}

/** 「フォルダの中から」の見方。親の直下を Store の workspaceChildren から組む。 */
function presentFolderBrowse(store: Store, now: number): FolderBrowseProps {
  const t = translatorOf(store);
  const w = store.workspaceChildren;
  const data = w?.status === 'ready' ? w.data : null;
  const band = data?.enclosing ?? null;
  const row = (x: WorkspaceChildDto, siblings: WorkspaceChildDto[]): FolderRow => {
    // worktree の元のリポジトリは、同じ remote を持つ兄弟の行から名前を引く（無ければ名前を言わない）。
    const main = x.worktree && x.remote ? siblings.find((s) => !s.worktree && s.git && s.remote?.toLowerCase() === x.remote!.toLowerCase()) : undefined;
    const inside = x.registered === null && x.enclosing !== null;
    const quietInside = inside && band !== null && x.enclosing!.projectId === band.projectId;
    const children = x.children ? x.children.map((c) => row(c, x.children!)) : null;
    const note = x.registered ? t('newProject.browse.registered', { name: x.registered.name })
      : x.worktree ? (main ? t('newProject.browse.worktreeOf', { name: main.name }) : t('newProject.browse.worktree'))
        : inside && !quietInside ? t('newProject.browse.inside', { name: x.enclosing!.name })
          : children ? t('newProject.browse.group', { n: x.children!.filter((c) => c.git).length })
            : null;
    // 別のプロジェクトの中の行は、結び付けより入れ子を先に言う（結び付けの候補は出さない）。
    const link = x.link && !x.registered && !x.worktree && !inside ? { projectId: x.link.projectId, note: linkNote(t, x.link) } : null;
    return {
      path: x.path, name: x.name, git: x.git,
      count: x.sessionCount > 0 ? String(x.sessionCount) : '—', countLabel: t('newProject.candidates.count', { n: x.sessionCount }),
      when: x.lastActivityAt === null ? '' : relativeTime(t, x.lastActivityAt, now), sessions: x.sessionCount,
      registered: x.registered !== null, worktree: x.worktree, inside, note, link, children,
    };
  };
  const parent = data ? { path: data.parent, label: homePath(data.parent, store.home) } : null;
  const home = store.home?.replace(/[\\/]+$/, '') ?? null;
  const rootable = data !== null && store.settings?.workspaceRoot === '' && band === null && data.parent !== home && !isRootPath(data.parent);
  return {
    status: w === null ? 'idle' : w.status,
    failure: w?.status === 'failed' ? w.message : null,
    parent,
    band: band?.name ?? null,
    rows: data ? data.children.map((c) => row(c, data.children)) : [],
    initialParent: initialParentOf(store),
    rootable,
    home: store.home,
    desktop: store.desktop,
    picked: store.pickedFolder,
  };
}
