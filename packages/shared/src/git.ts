/**
 * git の表示（0.5.0）。読むだけで、hangar は git に書かない。
 * 値は端末ローカルで、クラウドへは同期しない（他の PC のセッションには本文の gitBranch だけを出す）。
 */

/**
 * 作業ツリー（同じフォルダ）1 つの git の状態。根（`git rev-parse --show-toplevel`）で引く。
 * branch は今のブランチで、HEAD が切り離されていれば null（head にコミットの短い名前）。
 * worktree は git worktree で足した作業ツリーのときの名前（根のフォルダ名）で、元の作業ツリーなら null。mainRoot はその元の根である。
 * dirty は未コミットの件数（`git status` の行の数）。capped は 1,000 件で数えるのをやめたこと。
 * slow は git が時間内に答えなかったことで、そのとき dirty は null である。
 * ahead と behind は上流との差で、上流が無ければ null。at は読んだ時刻。
 */
export type GitTreeDto = {
  root: string; branch: string | null; head: string | null; worktree: string | null; mainRoot: string | null;
  dirty: number | null; capped: boolean; slow: boolean; ahead: number | null; behind: number | null; at: number;
};

/**
 * セッション 1 件の git の手がかり。
 * state の ok はこの PC の作業ツリー（root）がある、nogit は git のリポジトリではない、remote は他の PC で動いている（またはこの PC に場所が無い）、
 * gone は作業していた worktree が消えた（ブランチは残っていることがある）。
 * unsafe は、フォルダの持ち主が今のユーザーと違うので git が読むのを断った（dubious ownership）。root は git が名指した場所で、safe.directory に足すものである。
 * branch はトランスクリプトの最後の gitBranch で、セッションがどのブランチで作業したかを言う。読めなければ作業ツリーの今のブランチを使う。
 * worktree はトランスクリプトの worktree-state の名前で、セッションが worktree に入っていたときだけ持つ。
 */
export type GitSessionState = 'ok' | 'nogit' | 'unsafe' | 'remote' | 'gone';
export type GitSessionDto = { state: GitSessionState; root: string | null; branch: string | null; worktree: string | null };

/** 一覧と (i) の git（POST /api/git/sessions と、配る git.upsert）。どちらも部分で、受け取る側は重ねる。 */
export type GitDto = { sessions: Record<string, GitSessionDto>; trees: Record<string, GitTreeDto> };

/**
 * 差分の一覧の 1 行。path は絶対パス、rel は作業ツリーの根からの相対パス。
 * status の M は変更、A は追加（index に入れたもの）、U は未追跡の新しいファイル、D は削除、R は名前の変更、C はコミット済み（作業ツリーとの差が無い）である。
 * added と deleted は行の数で、バイナリ（binary）と数えられないときは null。
 */
export type GitFileStatus = 'M' | 'A' | 'U' | 'D' | 'R' | 'C';
export type GitFileDto = { path: string; rel: string; status: GitFileStatus; added: number | null; deleted: number | null; binary: boolean };

/**
 * セッションの「変更したファイル」の差分の一覧（GET /api/sessions/:id/changes）。
 * files はそのセッションが編集系のツール（Edit、Write、MultiEdit、NotebookEdit）で変えたファイルで、git の状態を添える。
 * others は作業ツリーで変わったほかのファイルで、Bash などで書いたもの、ほかのセッション、手での編集を見分けられないので、このセッションとは限らない。
 * othersCapped は others を 1,000 件で切ったこと。state は GitSessionDto と同じで、slow は git が答えなかったこと（files は git の状態を持たない）。
 */
export type SessionChangesDto = { state: GitSessionState | 'slow'; root: string | null; tree: GitTreeDto | null; files: GitFileDto[]; others: GitFileDto[]; othersCapped: boolean };

/**
 * 1 つのファイルの作業ツリーとの差（GET /api/sessions/:id/diff?file=）。
 * text は `git diff HEAD` の統合形式の本文で、未追跡のファイルは全部足した形にする。truncated は 256 KB で切ったこと。
 * binary はバイナリで本文を出さないこと。
 */
export type GitDiffDto = { file: string; rel: string; status: GitFileStatus; text: string; truncated: boolean; binary: boolean };

/**
 * そのファイルへのセッションの編集（GET /api/sessions/:id/edits?file=）。
 * トランスクリプトの Edit、MultiEdit、Write の呼び出しを、結果と一緒に古い順に並べる。今のファイルとは違うことがある。
 */
export type SessionEditDto = { seq: number; ts: number | null; agentId: string | null; call: { toolId: string; name: string; input: unknown; summary: string }; result: { text: string; isError: boolean } | null };
export type SessionEditsDto = { file: string; edits: SessionEditDto[]; truncated: boolean };

/**
 * プロジェクトのブランチと worktree（GET /api/projects/:id/git）。
 * root はプロジェクトの場所の作業ツリーで、git でなければ null。worktrees は `git worktree list` の元以外の作業ツリーで、tree はその状態（読めなければ null）。
 * blocked は root を読めなかった訳で、git のリポジトリでないだけのときは持たない。
 * noPath はこの PC にプロジェクトのパスが無い（他の PC から同期したもの）、missing はパスのフォルダがこの PC に無い、
 * unsafe はフォルダの持ち主が違うので git が断った（path は git が名指した場所）。
 */
export type ProjectWorktreeDto = { path: string; name: string; branch: string | null; tree: GitTreeDto | null };
export type ProjectGitBlocked = { kind: 'noPath' } | { kind: 'missing' } | { kind: 'unsafe'; path: string };
export type ProjectGitDto = { root: GitTreeDto | null; worktrees: ProjectWorktreeDto[]; blocked?: ProjectGitBlocked };

/** 未コミットの件数の上限。これを超えたら数えるのをやめて「1,000+」と言う。 */
export const GIT_DIRTY_CAP = 1000;

/**
 * 持ち主の違うリポジトリを git に許させるコマンド。hangar は git の設定を書かないので、案内にだけ使う。
 * 空白や引用符を含む場所は単引用符で囲む。中の単引用符は、Windows（PowerShell）は 2 つ重ね、ほかは sh の形で閉じて開き直す。
 */
export function safeDirectoryCommand(dir: string, platform: string): string {
  const quote = platform === 'win32' ? dir.replace(/'/g, "''") : dir.replace(/'/g, "'\\''");
  const arg = /^[\w@%+=:,./\\-]+$/.test(dir) ? dir : `'${quote}'`;
  return `git config --global --add safe.directory ${arg}`;
}

/** git の入れ方のコマンド。macOS はコマンドライン・デベロッパツール、Windows は Git for Windows。Linux は配布ごとに違うので出さない。 */
export function gitInstallCommand(platform: string): string | null {
  if (platform === 'darwin') return 'xcode-select --install';
  if (platform === 'win32') return 'winget install --id Git.Git -e';
  return null;
}
