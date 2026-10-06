import type { ProjectStatus, ResolveAction, RetentionFrom, SettingsDto } from './api.ts';
import type { LiveFilter } from './liveFilter.ts';
import type { Route } from './route.ts';
import type { SessionStatus } from './sessionState.ts';

export type ProjectId = string;
export type SessionId = string;
export type RunId = string;
export type TabId = string;
export type TodoId = string;
export type ArtifactId = string;

/**
 * 一覧と検索の絞り込み。
 * 期間は相対の日数（今日を含めて何日分か）で持ち、時刻には問い合わせる瞬間に直す。
 * 絶対の時刻で持つと、時間が経つにつれて選んだ帯と中身が食い違う。
 * status はセッションの状態のタブ（★）。active は状態が無いもの（動いているかは問わない）、proposed は Claude の提案が残っているもの。
 * 無ければ「すべて」で、条件を入れたときだけ Archived を除く（presenters/sessions.ts と、サーバの検索の hideArchived）。
 */
export type SearchFilter = { projectId?: string; days?: number; until?: number; live?: LiveFilter; file?: string; status?: SessionStatus | 'active' | 'proposed' };
/** 状態のタブの値（「すべて」以外）。 */
export type StatusFilter = NonNullable<SearchFilter['status']>;
export type LaunchParams = { projectId?: string; scratch?: boolean; name?: string; prompt?: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[]; account?: string };
export type PaletteCommand = { id: string; label: string };
export type Settings = SettingsDto;

export type Intent =
  | { type: 'nav.go'; to: Route }
  // 履歴を 1 つ戻る / 進む。ブラウザの戻ると同じもので、2 本指のスワイプもここへ来る。
  | { type: 'nav.back' } | { type: 'nav.forward' }
  | { type: 'shortcuts.open' }
  | { type: 'palette.open' } | { type: 'palette.close' } | { type: 'palette.run'; command: PaletteCommand }
  // filter は Sessions の欄で Enter したときに、欄を読んだ条件をまるごと渡す（欄が正）。無ければ今の絞り込みを保つ（パレットの全文検索）。
  | { type: 'search.query'; text: string; filter?: SearchFilter } | { type: 'search.filter'; patch: Partial<SearchFilter> }
  // 平らな一覧（タブ・条件・検索の結果）のページを移る。page は 1 から数える。
  | { type: 'search.page'; page: number }
  // Home の最近とプロジェクト画面の一覧のページを移る。key は 'home' か 'project:<id>'。
  | { type: 'list.page'; key: string; page: number }
  // 1 ページの件数を変える（25・50・100・200）。どの一覧も同じ件数を使う。セッション一覧は見ていた先頭の行を含むページに留まる。
  | { type: 'list.pageSize'; size: number }
  // 「条件をクリア」。語と絞り込みをまとめて外す。
  | { type: 'search.clear' }
  | { type: 'project.open'; id: ProjectId } | { type: 'project.setStatus'; id: ProjectId; status: ProjectStatus }
  // プロジェクト画面の節を広げる・畳む（P3）。Done の「ほか N 件」と、末尾の Archived の行。
  | { type: 'project.section.toggle'; projectId: ProjectId; section: 'done' | 'archived' }
  | { type: 'project.new.open' } | { type: 'project.new.submit'; name: string; gitInit: boolean; startSession: boolean }
  | { type: 'project.resolve.open'; id: ProjectId }
  // 一覧から削除（unlink）は同期で他の端末へも広がるので、confirmed が無ければ先に確認を出す。
  | { type: 'project.resolve'; id: ProjectId; action: ResolveAction; confirmed?: boolean }
  | { type: 'project.openEditor'; id: ProjectId } | { type: 'project.openTerminalApp'; id: ProjectId }
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'todo.confirm'; id: TodoId } | { type: 'todo.reject'; id: TodoId }
  | { type: 'memo.save'; projectId: ProjectId; markdown: string }
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.add'; projectId: ProjectId; url: string } | { type: 'artifact.openEditor'; id: ArtifactId }
  // seq と q は検索の結果から開くときの跳び先（抜粋の seq と検索語）。
  | { type: 'session.open'; id: SessionId; focus?: 'terminal'; seq?: number; q?: string } | { type: 'session.setMemo'; id: SessionId; text: string }
  // セッションの状態（Paused・Done・Archived）。status の null は Active に戻す。画面の正は後から届く session.upsert である。
  | { type: 'session.state.set'; id: SessionId; status: SessionStatus | null; note?: string; returnOn?: string; returnTime?: string }
  // 提案の確定と却下。確定で日を変えたときだけ returnOn を添える。returnTime はその日の時刻（HH:MM）で、returnOn と一緒のときだけ効く。
  | { type: 'session.state.confirm'; id: SessionId; returnOn?: string; returnTime?: string } | { type: 'session.state.reject'; id: SessionId }
  // Paused の入力（B1）。from は開いた入口で、提案の「日を変える」から開いたときは根拠を下書きに入れる。
  | { type: 'session.pause.open'; id: SessionId; from: 'menu' | 'candidate' } | { type: 'session.pause.close' }
  // 入力待ちのセッションを順に開き、端末にフォーカスする。どれへ移るかはストアを見たランタイムが決める。
  | { type: 'session.nextWaiting' }
  | { type: 'session.new.open'; projectId?: ProjectId; scratch?: boolean } | { type: 'session.new.submit'; params: LaunchParams }
  // 新しいセッションのダイアログの書きかけ（名前と初期プロンプト）。ダイアログを閉じるときと「消す」で送る。両方空なら下書きを消す。
  | { type: 'session.new.draft'; name: string; prompt: string }
  | { type: 'session.resume'; id: SessionId } | { type: 'session.fork'; id: SessionId }
  // 停止は作業中か、そのランにシェルタブがあるときだけ先に確認を出す。どちらなのかは View が添え、確認を出すかは Mediator が決める。
  | { type: 'session.kill'; runId: RunId; working: boolean; shellTabs: number; confirmed?: boolean }
  // attach はバックグラウンドのサービスが持つセッションに hangar からつなぐ。adopt は外のターミナルの claude を引き取る。confirmed が無ければ先に確認を出す。
  | { type: 'session.attach'; id: SessionId } | { type: 'session.adopt'; id: SessionId; confirmed?: boolean }
  | { type: 'session.openTerminalApp'; runId: RunId; tabId?: TabId } | { type: 'session.openEditor'; sessionId: SessionId }
  /**
   * そのセッションが変えたファイルを VS Code で開く（終わった画面の右欄）。
   * path は本文に出てきた綴りのまま。
   */
  | { type: 'session.openFile'; sessionId: SessionId; path: string }
  | { type: 'session.promote.open'; id: SessionId } | { type: 'session.promote.submit'; id: SessionId; name: string; gitInit: boolean; moveFiles: boolean }
  | { type: 'session.takeover'; id: SessionId; force: boolean }
  | { type: 'session.resumeHere'; id: SessionId; overwrite?: boolean }
  | { type: 'session.takeover.cancel'; id: SessionId }
  | { type: 'sync.config.preview' } | { type: 'sync.config.apply' }
  | { type: 'sync.joinToken.show' }
  | { type: 'summary.toggle'; sessionId: SessionId } | { type: 'summary.regenerate'; sessionId: SessionId }
  | { type: 'tab.open'; sessionId: SessionId; kind: 'agent' | 'shell' } | { type: 'tab.close'; tabId: TabId } | { type: 'tab.select'; tabId: TabId }
  | { type: 'split.toggle' } | { type: 'split.resize'; ratio: number } | { type: 'transcript.toggle' }
  | { type: 'sidebar.toggle' }
  // サイドバーの「動いている」の行を、利用者が掴んで並べ替えたとき。ids は並べ替えた後の、動いているセッション全部の並び。
  | { type: 'sidebar.order'; ids: SessionId[] }
  // 実行中の右ペインで、「いま」の段が取る高さの上限（ペインの高さに対する割合）。境目を離したときに 1 度だけ出す。
  | { type: 'livePane.split'; ratio: number }
  | { type: 'summarizer.test' }
  | { type: 'transcript.showThinking'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.showRaw'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.follow'; sessionId: SessionId; follow: boolean }
  | { type: 'transcript.loadMore'; sessionId: SessionId }
  // 検索の結果から、真ん中の頁だけを読んで開いたとき、その後ろ（新しい側）を読み足す。
  | { type: 'transcript.loadNewer'; sessionId: SessionId }
  // 本文の中の検索（⌘F）。from は語を打ったときに見ていた行の seq で、そこから後ろの最初の一致から数える。
  | { type: 'transcript.find'; sessionId: SessionId; open: boolean }
  | { type: 'transcript.findQuery'; sessionId: SessionId; query: string; caseSensitive: boolean; from: number | null }
  | { type: 'transcript.findStep'; sessionId: SessionId; delta: number }
  | { type: 'transcript.selectAgent'; sessionId: SessionId; agentId: string | null }
  // ターンの目次。開いたターンの中身を見せ、run が生きていれば左の Claude のタブもその指示へ跳ばす。
  // 跳ぶ先の数え方は目次の並びで決まるので、View が書き出しの切り出しを添えて送る。
  | { type: 'turn.open'; sessionId: SessionId; seq: number; runId: RunId | null; jump: { heads: string[]; index: number; from: 'top' | 'bottom' } | null }
  | { type: 'turn.latest'; sessionId: SessionId; runId: RunId | null }
  | { type: 'index.rebuild' }
  | { type: 'overlay.close' }
  | { type: 'toast.dismiss'; id: string }
  // 窓が背面にあるとき、入力待ちを OS やブラウザの通知で知らせるか。
  // 受け取るにするときは許可を求める。
  | { type: 'notify.set'; on: boolean }
  // 戻る時刻を過ぎた知らせの札を閉じる。
  | { type: 'return.toast.dismiss'; id: SessionId }
  | { type: 'sync.now' } | { type: 'sync.pause'; paused: boolean }
  | { type: 'conn.retry' }
  | { type: 'retention.dismiss' }
  | { type: 'retention.edit'; days: number; from: RetentionFrom }
  | { type: 'retention.write' }
  | { type: 'retention.settings' }
  // field は欄ごとの保存で、結果（✓ 保存しました、または欄の下の理由）をその欄に返すための名前である。
  | { type: 'settings.update'; patch: Partial<Settings>; field?: string }
  // 準備の確かめ（設定画面の検証と、空のホームの確認リスト）を取り直す。
  | { type: 'readiness.check' }
  // Claude Code のアカウント。load は一覧を取り直す。choose は新しいセッションの既定（いまのアカウント）を変える。
  // switchSession はそのセッションを別のアカウントで再開する。working は作業中かで、確認の文に使う。confirmed が無ければ先に確認を出す。
  // add は名前だけで置き場を作り、続けてログインを始める。remove は一覧から外すだけで、置き場の中身は消さない。confirmed が無ければ先に確認を出す。
  | { type: 'accounts.load' }
  | { type: 'account.choose'; accountId: string }
  | { type: 'account.switchSession'; sessionId: SessionId; accountId: string; working: boolean; confirmed?: boolean }
  | { type: 'account.add'; name: string }
  | { type: 'account.update'; accountId: string; name?: string; color?: string }
  | { type: 'account.remove'; accountId: string; confirmed?: boolean }
  | { type: 'account.login'; accountId: string } | { type: 'account.login.cancel'; accountId: string }
  | { type: 'account.refresh'; accountId: string }
  // デスクトップの殻に頼む操作。殻の無いブラウザでは、画面が場所のコピーと文の案内に落とす。
  | { type: 'shell.openLog' } | { type: 'shell.restart' }
  | { type: 'clipboard.copy'; text: string };
