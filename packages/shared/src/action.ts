import type { ConfigApplyOrderEntryIn, FolderRegisterItem, InstructionFileKind, ProjectPlace, ProjectStatus, ResolveAction, ResumeStray, RetentionFrom, SettingsDto } from './api.ts';
import type { LiveFilter } from './liveFilter.ts';
import type { Route } from './route.ts';
import type { SessionStatus } from './sessionState.ts';
import type { SetupTarget } from './setup.ts';
import type { KnownEditorId } from './editor.ts';

export type ProjectId = string;
export type SessionId = string;
export type RunId = string;
export type TabId = string;
export type TodoId = string;
export type ArtifactId = string;
/** プロジェクト画面の右パネルの節。並びは画面の上からの順である。 */
export const PROJECT_RAIL_SECTIONS = ['todo', 'instructions', 'artifacts', 'git'] as const;
export type ProjectRailSection = (typeof PROJECT_RAIL_SECTIONS)[number];

/**
 * 一覧と検索の絞り込み。
 * 期間は相対の日数（今日を含めて何日分か）で持ち、時刻には問い合わせる瞬間に直す。
 * 絶対の時刻で持つと、時間が経つにつれて選んだ帯と中身が食い違う。
 * status はセッションの状態のタブ（★）。active は状態が無いもの（動いているかは問わない）、proposed は Claude の提案が残っているもの。
 * 無ければ「すべて」で、条件を入れたときだけ Archived を除く（presenters/sessions.ts と、サーバの検索の hideArchived）。
 */
/** 止まっている理由の絞り込み（is:permission、is:limited）。limited は使用制限とリセット済みの両方である（shared の matchesStopFilter）。 */
export type StopFilter = 'permission' | 'limited';
export type SearchFilter = { projectId?: string; days?: number; until?: number; live?: LiveFilter; stop?: StopFilter; file?: string; status?: SessionStatus | 'active' | 'proposed' };
/** 状態のタブの値（「すべて」以外）。 */
export type StatusFilter = NonNullable<SearchFilter['status']>;
/**
 * 起動の指定。cwd は作業の場所で、プロジェクトの場所の下のフォルダから始めるときに渡す（0.6.1）。
 * 省けばプロジェクトの場所で起こす。プロジェクトの場所の外は断る。セッションは projectId のプロジェクトに入る。scratch では使わない。
 * agent は起こすエージェントで、省けば Claude Code である。opencode（ベータ）は設定で有効にしたときだけ起こせる。
 * mode と autoApprove は opencode だけが読む。mode は opencode のエージェント（build、plan など）、autoApprove は `--auto` で、Claude Code では捨てる。
 * account、effort、permissionMode、worktree、addDirs は Claude Code だけのもので、opencode に付けると断る。
 */
export type LaunchParams = { projectId?: string; scratch?: boolean; name?: string; prompt?: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[]; account?: string; cwd?: string; agent?: 'claude-code' | 'opencode'; mode?: string; autoApprove?: boolean };
/** 設定の同期（作り直した実装）のダイアログ。send は送るものの一覧、review は適用内容の確認、approve は届いたスキルなどの承諾、conflicts は競合。 */
export type ConfigSyncPart = 'send' | 'review' | 'approve' | 'conflicts';
export type PaletteCommand = { id: string; label: string };
export type Settings = SettingsDto;

export type UiAction =
  | { type: 'nav.go'; to: Route }
  // 履歴を 1 つ戻る / 進む。ブラウザの戻ると同じもので、2 本指のスワイプもここへ来る。
  | { type: 'nav.back' } | { type: 'nav.forward' }
  | { type: 'shortcuts.open' }
  | { type: 'palette.open' } | { type: 'palette.close' } | { type: 'palette.run'; command: PaletteCommand }
  // filter は Home の欄で Enter したときに、欄を読んだ条件をまるごと渡す（欄が正）。無ければ今の絞り込みを保つ（パレットの全文検索）。
  | { type: 'search.query'; text: string; filter?: SearchFilter } | { type: 'search.filter'; patch: Partial<SearchFilter> }
  // 手元で組む平らな一覧（タブ・条件。語も触ったファイルも無いとき）のページを移る。page は 1 から数える。検索の結果は search.more で読み足す。
  | { type: 'search.page'; page: number }
  // 検索の結果の末尾の「さらに N 件を読み込む」。いま持っている行の続きを読み足す（置き換えない）。
  | { type: 'search.more' }
  // 1 ページの件数を変える（25・50・100・200）。どの一覧も同じ件数を使う。セッション一覧は見ていた先頭の行を含むページに留まる。
  | { type: 'list.pageSize'; size: number }
  // 「条件をクリア」。語と絞り込みをまとめて外す。
  | { type: 'search.clear' }
  | { type: 'project.open'; id: ProjectId } | { type: 'project.setStatus'; id: ProjectId; status: ProjectStatus }
  // プロジェクトの名前を変える。見出しの (i) のポップオーバーから出す。
  | { type: 'project.rename'; id: ProjectId; name: string }
  | { type: 'project.new.open' } | { type: 'project.new.submit'; place: ProjectPlace; startSession: boolean }
  // まとめて登録のダイアログ（初日のプロジェクト。2026-10-13）。source は開いた時点の見方で、省けば Claude Code と会話したフォルダ、folder はフォルダの中から（0.6.1）。
  // submit は選んだフォルダをまとめて登録し、workspaceRoot があれば先に新しいフォルダの作成場所にする。items は行ごとの結び付け先（linkTo）と入れ子の明示（allowNested）を持つ。
  | { type: 'project.candidates.open'; source?: 'talked' | 'folder' } | { type: 'project.candidates.submit'; items: FolderRegisterItem[]; workspaceRoot: string | null }
  // 「フォルダの中から」の親フォルダの直下を読む（GET /api/workspace/children）。parent は打たれたままのパスで、~ はサーバが直す。
  | { type: 'project.folders.load'; parent: string }
  // 起動と作成のダイアログの「ほかの場所を選ぶ…」と、作成場所が空のときの「作成場所」の「選ぶ…」。殻の中だけで出す。
  | { type: 'folder.pick' }
  // 選んだ 1 つのフォルダの事前の問い合わせ（0.6.1）。登録済みのプロジェクトの下か、ほかの PC から届いた同じプロジェクトがあるかを読む。
  // 答えは Store の folderInspect に入り、新しいセッションと作成のダイアログが読む。name は作成のダイアログで名前を直したときだけ添える（弱い一致をその名前で見る）。
  | { type: 'folder.inspect'; path: string; name?: string }
  // 新しいセッションで opencode（ベータ）を選んだときの、モードとモデルの一覧（GET /api/opencode/options）。dir はその場所（opencode.json の重なりが場所で変わる）で、null はホーム。
  // 答えは Store の opencodeOptions に入る。最後に頼んだ 1 件だけを持つ。refresh は手元の一覧を使わずに取り直す（モデルの小窓の LM Studio の「再読み込み」）。
  | { type: 'opencode.options'; dir: string | null; refresh?: boolean }
  // 設定の「連携 › opencode › プロバイダー」（ベータ）。どれも答えは Store の opencodeProviders に入る。
  // key は API キーで接続する（変更も同じ）。API キーは opencode の integration に渡すだけで、Store にも残さない。
  // custom は OpenAI 互換のサーバー（opencode.json に書く）、model はモデル ID の追加、login はログインを始め、poll で進みを聞き、code でコードを送り、cancel で取り消す。
  | { type: 'opencode.providers.load' } | { type: 'opencode.providers.key'; id: string; key: string } | { type: 'opencode.providers.disconnect'; id: string }
  | { type: 'opencode.providers.model'; id: string; model: string } | { type: 'opencode.providers.custom'; name: string; url: string; apiKey?: string }
  | { type: 'opencode.providers.login'; id: string; method: string } | { type: 'opencode.providers.login.poll' } | { type: 'opencode.providers.login.code'; code: string } | { type: 'opencode.providers.login.cancel' }
  // 新しいセッションのモデルの小窓の「プロバイダーを管理…」。ダイアログを閉じて設定へ移り、設定に「‹ 新しいセッションに戻る」を出す。back はダイアログを同じ開き方で開き直す。
  | { type: 'opencode.providers.manage' } | { type: 'opencode.providers.back' }
  // 作成のダイアログで、選んだフォルダが登録済みのプロジェクトの下だったとき、そのプロジェクトを開く（startSession が偽）か、そのフォルダで始める（真）。
  | { type: 'project.new.enclosing'; projectId: ProjectId; dir: string; startSession: boolean }
  | { type: 'project.resolve.open'; id: ProjectId }
  // 一覧から削除（unlink）は同期で他の端末へも広がるので、confirmed が無ければ先に確認を出す。
  | { type: 'project.resolve'; id: ProjectId; action: ResolveAction; confirmed?: boolean }
  // once は「今回は <名前> で開く」のエディタ（エディタが見つからないときの面から）。設定は変えない。
  | { type: 'project.openEditor'; id: ProjectId; once?: KnownEditorId } | { type: 'project.openTerminalApp'; id: ProjectId }
  // プロジェクト画面の右パネルの節を開く・折りたたむ。プロジェクトごとに端末の localStorage に覚える。
  | { type: 'project.railFold'; id: ProjectId; section: ProjectRailSection; open: boolean }
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'todo.confirm'; id: TodoId } | { type: 'todo.reject'; id: TodoId }
  // 文言を直す。空にして確定したときは View が todo.remove を出す。
  | { type: 'todo.edit'; id: TodoId; text: string }
  // 並べ替え。ids はそのプロジェクトの未完（提案を除く）の新しい並びの全部である。
  | { type: 'todo.move'; projectId: ProjectId; ids: TodoId[] }
  // Claude の提案を受け入れて一覧の末尾へ入れる／見送る（消す）。
  | { type: 'todo.accept'; id: TodoId } | { type: 'todo.dismiss'; id: TodoId }
  // 直前の操作を戻す。todoId があれば、その TODO を消した操作を戻す（消した場所の帯の「元に戻す」）。
  | { type: 'todo.undo'; projectId: ProjectId; todoId?: TodoId }
  | { type: 'memo.save'; projectId: ProjectId; markdown: string }
  // 指示とメモリ。load は読み直し（ダイアログを開いたとき）、openEditor はそのファイルをエディタで開く。
  | { type: 'instructions.load'; projectId: ProjectId } | { type: 'instructions.openEditor'; projectId: ProjectId; kind: InstructionFileKind; once?: KnownEditorId }
  // セットアップのすゝめ。写した md をエディタで開く（設定の連携の札の「手引きの中身を見る」）。
  | { type: 'setupGuide.openEditor'; once?: KnownEditorId }
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.add'; projectId: ProjectId; url: string } | { type: 'artifact.openEditor'; id: ArtifactId; once?: KnownEditorId }
  // seq と q は検索の結果から開くときの跳び先（抜粋の seq と検索語）。
  | { type: 'session.open'; id: SessionId; focus?: 'terminal'; seq?: number; q?: string }
  // セッションの状態（Paused・Done・Archived）。status の null は Active に戻す。画面の正は後から届く session.upsert である。
  | { type: 'session.state.set'; id: SessionId; status: SessionStatus | null; note?: string; returnOn?: string; returnTime?: string }
  // セッションを別のプロジェクトへ移す。動くのは hangar 上の所属だけで、本文と再開するフォルダは元のまま。画面の正は後から届く session.upsert である。
  | { type: 'session.move'; id: SessionId; projectId: ProjectId }
  // セッションを消す。本文を OS のゴミ箱へ移し、同期しているほかの PC からも消す。実行中は断られる。画面の正は後から届く session.removed である。
  | { type: 'session.delete'; id: SessionId }
  // 移す先を選ぶダイアログと、削除の確認を開く（セッションのメニューの「プロジェクトを変更…」と「削除…」）。決めたら session.move と session.delete を送る。
  | { type: 'session.move.open'; id: SessionId } | { type: 'session.delete.open'; id: SessionId }
  // 提案の確定と却下。確定で日を変えたときだけ returnOn を添える。returnTime はその日の時刻（HH:MM）で、returnOn と一緒のときだけ効く。
  | { type: 'session.state.confirm'; id: SessionId; returnOn?: string; returnTime?: string } | { type: 'session.state.reject'; id: SessionId }
  // 確認待ちの群の見出しの「すべて確定」「すべて却下」（2026-10-13 の決定、知らせの 9d）。いまある提案を、セッションの提案と TODO の完了の提案に分けて渡す。
  | { type: 'pending.resolve'; accept: boolean; sessionIds: SessionId[]; todoIds: TodoId[] }
  // Paused の入力（B1）。from は開いた入口で、提案の「日を変える」から開いたときは根拠を下書きに入れる。
  | { type: 'session.pause.open'; id: SessionId; from: 'menu' | 'candidate' } | { type: 'session.pause.close' }
  // 入力待ちのセッションを順に開き、端末にフォーカスする。どれへ移るかはストアを見たランタイムが決める。
  | { type: 'session.nextWaiting' }
  // dir は、はじめに選んでおくフォルダ（作成のダイアログから、登録済みのプロジェクトの下のフォルダで始めるとき）。
  | { type: 'session.new.open'; projectId?: ProjectId; scratch?: boolean; dir?: string } | { type: 'session.new.submit'; params: LaunchParams; place?: ProjectPlace }
  // place は、新しいフォルダと未登録のフォルダで始めるときだけ付ける。プロジェクトを作ってから起動する。
  // 新しいセッションのダイアログの書きかけ（名前と初期プロンプト）。ダイアログを閉じるときと「消す」で送る。両方空なら下書きを消す。
  | { type: 'session.new.draft'; name: string; prompt: string; attachments?: { path: string; name: string; size: number | null }[] }
  // ダイアログを閉じた後に送り終えた添付を、いまの下書きへ足す。名前と本文には触れない（開き直したダイアログの書きかけを上書きしないため）。下書きが無ければ、名前と本文が空のものを作る。
  | { type: 'session.new.draft.attach'; attachments: { path: string; name: string; size: number | null }[] }
  // stray は、終わった扱いの run の claude が動き続けていたときの確認で選んだもの（stop は止めてから、ignore は止めずに再開する）。
  | { type: 'session.resume'; id: SessionId; stray?: ResumeStray } | { type: 'session.fork'; id: SessionId }
  // 停止は作業中か、そのランにシェルタブがあるときだけ先に確認を出す。どちらなのかは View が添え、確認を出すかは Mediator が決める。
  | { type: 'session.kill'; runId: RunId; working: boolean; aside?: boolean; shellTabs: number; confirmed?: boolean }
  // attach はバックグラウンドのサービスが持つセッションに hangar からつなぐ。adopt は外のターミナルの claude を引き取る。confirmed が無ければ先に確認を出す。
  | { type: 'session.attach'; id: SessionId } | { type: 'session.adopt'; id: SessionId; confirmed?: boolean }
  | { type: 'session.openTerminalApp'; runId: RunId; tabId?: TabId } | { type: 'session.openEditor'; sessionId: SessionId; once?: KnownEditorId }
  /**
   * そのセッションが変えたファイルを VS Code で開く（終わった画面の右欄）。
   * path は本文に出てきた綴りのまま。
   */
  // line は差分から開くときの行。
  | { type: 'session.openFile'; sessionId: SessionId; path: string; line?: number; once?: KnownEditorId }
  // git の表示（0.5.0）。watch は、見えている行のセッションの git を取ってほしいという知らせで、key は出した場所（一覧、セッション画面）。空の並びで取り下げる。
  // load は差分の一覧、1 つのファイルの差、そのファイルへの編集、プロジェクトのブランチと worktree を読む。
  | { type: 'git.watch'; key: string; sessionIds: SessionId[] }
  | { type: 'git.changes.load'; sessionId: SessionId } | { type: 'git.diff.load'; sessionId: SessionId; file: string } | { type: 'git.edits.load'; sessionId: SessionId; file: string }
  | { type: 'project.git.load'; projectId: ProjectId }
  // 差分のダイアログ。open は file を渡すとそのファイルを選んで開く。source は「作業ツリーとの差（git）」か「このセッションの編集」。
  | { type: 'diff.open'; sessionId: SessionId; file?: string } | { type: 'diff.select'; file: string } | { type: 'diff.source'; source: 'git' | 'session' }
  | { type: 'session.promote.open'; id: SessionId } | { type: 'session.promote.submit'; id: SessionId; name: string; gitInit: boolean; moveFiles: boolean; /** 作る場所。作成場所（設定）が空のときだけ渡す。 */ parent?: string }
  | { type: 'session.resumeHere'; id: SessionId; overwrite?: boolean }
  // 「この PC で再開」を押した。確認に出すもの（前の PC とこの PC）を取りに行き、確認の 1 枚を出す。承諾で session.resumeHere を送る。
  | { type: 'session.resumeHere.open'; id: SessionId }
  // ほかの PC で動いている会話を、相手に停止を頼んでから引き継ぐ。force は応答のない相手を頼まずに引き継ぐとき。
  | { type: 'session.takeover.start'; id: SessionId; force: boolean }
  // 待っている間の「取り消す」（頼みを取り下げる）と、返事がないときの「もう少し待つ」（打ち切りを延ばす）。
  | { type: 'session.takeover.extend'; id: SessionId } | { type: 'session.takeover.cancel'; id: SessionId }
  /**
   * 中断の群（ホームの帯の「前回実行中」）。resume は渡したセッションを順番待ちに足し、同時に 2 本まで再開する（画面は移さない）。
   * cancel は順番待ちのものだけを外す（再開しかけたものは止めない）。dismiss は「再開しない」（dismissed が偽なら元に戻す）。
   */
  // stray は、まとめて再開の 1 本で残った claude の確認を出したときの選び方。渡した ids の再開に添える。
  | { type: 'interrupted.resume'; ids: SessionId[]; stray?: ResumeStray } | { type: 'interrupted.cancel' }
  | { type: 'interrupted.dismiss'; runIds: RunId[]; dismissed: boolean; name?: string }
  /**
   * 同じファイルの編集の警告。dismiss は相手（with）とパスの組で「このファイルでは表示しない」にする。
   * worktree は、そのセッションのプロジェクトで、worktree の札に名前を入れた新しいセッションのダイアログを開く。
   */
  | { type: 'overlap.dismiss'; sessionId: SessionId; with: SessionId; paths: string[] } | { type: 'overlap.worktree'; sessionId: SessionId }
  /**
   * 参加コードでの参加（新しい PC の側、試作 B2）と、PC の解除と、この PC の参加の解除。参加と解除は殻の中でだけ働く（ブラウザでは画面がコマンドを案内する）。
   * join.check は接続先の URL を殻へ渡してホストと参加済みの PC の台数を確認する。join.request は半角にそろえた参加コードで参加リクエストを送り、承認を待つ。
   * 参加コードは Runtime から殻へ渡すだけで、Store にも画面にも保持しない。join.reenter は参加コードの段へ戻り、join.cancel は段を閉じる。
   * device.revoke は他の PC を解除する。leave はこの PC の参加を解除する（revoke はクラウドでもこの PC を解除するか）。
   */
  | { type: 'cloud.join.check'; url: string } | { type: 'cloud.join.request'; code: string } | { type: 'cloud.join.reenter' } | { type: 'cloud.join.cancel' }
  /**
   * 参加済みの PC で「PC を追加」（試作 A1）。add.open は参加コードを発行する（期限切れの後の再発行も同じ）。
   * add.approve と add.reject は受信した参加リクエストを承認か拒否する。add.close は欄を閉じ、生きている参加コードも閉じる。
   */
  | { type: 'cloud.add.open' } | { type: 'cloud.add.approve' } | { type: 'cloud.add.reject' } | { type: 'cloud.add.close' }
  | { type: 'cloud.device.revoke'; id: string } | { type: 'cloud.revoke.dismiss' }
  | { type: 'cloud.leave'; revoke: boolean } | { type: 'cloud.leave.dismiss' }
  /**
   * スマホを接続する QR（設定のクラウド同期の節の「スマホ」）。phone.pair は新しい券を取って QR を出す（期限切れの後の「新しい QR を出す」も同じ）。
   * QR を出している間だけ、サーバーの軽い口を 3 秒ごとに読んで、PC が keybox を置き終えたのを知らせる。phone.close は QR を閉じて見回りも止める。
   * QR の中身はブラウザでも作れる（サーバの経路だけを使う）。
   * phone.revoke はスマホの行の「解除」（1 クリック）で、行を隠して右下に「元に戻す」を 5 秒出し、その後に解除を送る。phone.undo はその 5 秒の間の「元に戻す」。
   */
  | { type: 'cloud.phone.pair' } | { type: 'cloud.phone.close' }
  | { type: 'cloud.phone.revoke'; id: string } | { type: 'cloud.phone.undo' }
  /**
   * 「リカバリーキーを再発行」（試作 D2）。recovery.ask は確認を開き、recovery.reissue は新しいリカバリーキーを作って表示する（まだ何も差し替えない）。
   * recovery.saved は末尾 4 文字の入力の段へ進み、recovery.reveal は伏せた暗号鍵をもう一度 120 秒表示する。
   * recovery.confirm は末尾 4 文字で確認して名簿と keybox を差し替え、recovery.retry は Worker の失敗の後に同じ下書きで送り直す。
   * recovery.close は欄を閉じ、リカバリーキーの文字列を捨てる。
   */
  | { type: 'cloud.recovery.ask' } | { type: 'cloud.recovery.reissue' } | { type: 'cloud.recovery.saved' } | { type: 'cloud.recovery.reveal' }
  | { type: 'cloud.recovery.confirm'; tail: string } | { type: 'cloud.recovery.retry' } | { type: 'cloud.recovery.close' }
  // 設定の同期。送る一覧を承諾するとスイッチが入り（send.confirm）、適用は選んだ項目を指示書にしてから殻のネイティブの確認へ渡す。
  | { type: 'configSync.open'; part: ConfigSyncPart }
  | { type: 'configSync.send.confirm' }
  | { type: 'configSync.apply'; entries: ConfigApplyOrderEntryIn[] }
  // すでにある指示書で、もう一度適用の確認へ進む。指示書の取り消し。
  | { type: 'configSync.order.apply' } | { type: 'configSync.order.cancel' }
  // 送らなかった項目を、それでも送る。
  | { type: 'configSync.unsent.send'; id: string }
  // 控えの世代へ戻す。name は yyyyMMdd-HHmmss。
  | { type: 'configSync.restore'; name: string }
  | { type: 'summary.regenerate'; sessionId: SessionId }
  | { type: 'tab.open'; sessionId: SessionId; kind: 'agent' | 'shell' } | { type: 'tab.close'; tabId: TabId } | { type: 'tab.select'; tabId: TabId }
  | { type: 'split.toggle' } | { type: 'split.resize'; ratio: number } | { type: 'transcript.toggle' }
  | { type: 'sidebar.toggle' }
  // サイドバーの「動いている」の行を、利用者が掴んで並べ替えたとき。ids は並べ替えた後の、動いているセッション全部の並び。
  | { type: 'sidebar.order'; ids: SessionId[] }
  // サイドバーの「実行中」のグループを開く・畳む。key はプロジェクトの id で、未分類は空の文字列。
  | { type: 'sidebar.fold'; key: string; open: boolean }
  | { type: 'summarizer.test' }
  | { type: 'transcript.showThinking'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.showRaw'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.follow'; sessionId: SessionId; follow: boolean }
  | { type: 'transcript.loadMore'; sessionId: SessionId }
  // 検索の結果から、真ん中の頁だけを読んで開いたとき、その後ろ（新しい側）を読み足す。
  | { type: 'transcript.loadNewer'; sessionId: SessionId }
  // 本文の中の検索（⌘F）。from は語を打ったときに見ていた行の seq で、そこから後ろの最初の一致から数える。
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
  // 他の PC から届いたプロジェクトの札。見るはプロジェクトの画面へ移り、あとで決めるは札だけを下げる。どちらも札を下げる。
  | { type: 'projects.arrived.view' } | { type: 'projects.arrived.dismiss' }
  // スマホから起動した会話の右下の通知（試作 F1）。どれも通知を下げる。open はその会話を開き、stop はその run を止める（確認の要否は session.kill と同じ）。
  | { type: 'phoneLaunch.open'; sessionId: string } | { type: 'phoneLaunch.dismiss'; sessionId: string }
  | { type: 'phoneLaunch.stop'; sessionId: string; stop: { runId: string; working: boolean; aside: boolean; shellTabs: number } }
  // アプリの自動更新（段 5-4）。check は手動の確認、download は取得してインストールの準備、install は再起動して入れる。
  // dismiss は右下の札を閉じ、その版の札を 2 度出さない。notify は新しい版を知らせるか（切ると自動の確認もしない）。
  | { type: 'update.check' } | { type: 'update.download' } | { type: 'update.install' } | { type: 'update.dismiss' }
  | { type: 'update.notify'; on: boolean }
  /** 更新後の札（リリースノート）を閉じる。notesRead は閉じて設定の「更新」の節へ移り、札で見せた版を開いておく。 */
  | { type: 'update.notesClose' } | { type: 'update.notesRead' }
  // 未検証の opencode の版の右下の札（C7、試作の N1）。どちらもその版を知らせ終えたことにし（同じ版では二度出さない）、settings は設定の opencode の面へ移る。
  | { type: 'opencode.version.continue'; version: string } | { type: 'opencode.version.settings'; version: string }
  | { type: 'sync.now' } | { type: 'sync.pause'; paused: boolean }
  | { type: 'conn.retry' }
  // ベルの一覧の行を既読にする。keys は行の鍵（種類、対象、事実の版）で、「すべて既読にする」はいまある鍵を全部送る。
  | { type: 'notices.read'; keys: string[] }
  | { type: 'retention.edit'; days: number; from: RetentionFrom }
  | { type: 'retention.write' }
  | { type: 'retention.settings' }
  // field は欄ごとの保存で、結果（✓ 保存しました、または欄の下の理由）をその欄に返すための名前である。
  | { type: 'settings.update'; patch: Partial<Settings>; field?: string }
  // エディタの欄。load は候補の一覧を読み直す（一般の節を開いたときと「再確認」）。test は見本のファイルを 3 行目で開く。
  | { type: 'editors.load' } | { type: 'editor.test' }
  // 準備の確かめ（設定画面の検証と、ホームの帯の始める前の確認）を取り直す。
  | { type: 'readiness.check' }
  // psmux（Windows）と tmux の再確認。サーバが探し直し、見つかれば設定の tmuxPath を埋める。
  // proceed は、始める前の案内で止めていた操作（新しいセッション、再開）を、見つかったあとに進める。
  | { type: 'mux.recheck' } | { type: 'mux.guide.proceed' }
  // 連携の書き込み（MCP、シェル連携、ステータスライン）を殻に頼む。殻が承諾の窓で見せ、承諾されたときだけ CLI が書く。ブラウザでは何もしない。
  | { type: 'setup.run'; target: SetupTarget }
  // Claude Code のアカウント。load は一覧を取り直す。choose は新しいセッションの既定（いまのアカウント）を変える。
  // switchSession はそのセッションを別のアカウントで再開する。working は作業中かで、確認の文に使う。confirmed が無ければ先に確認を出す。
  // add は名前だけで置き場を作り、続けてログインを始める。remove は一覧から外すだけで、置き場の中身は消さない。confirmed が無ければ先に確認を出す。
  | { type: 'accounts.load' }
  | { type: 'account.choose'; accountId: string }
  | { type: 'account.switchSession'; sessionId: SessionId; accountId: string; working: boolean; confirmed?: boolean }
  // 設定の「アカウントを足す…」のダイアログ。add は名前と場所（打ったまま。空ならサーバが名前から決める）で登録してログインを始める。
  // pick は「選ぶ…」で、開く場所を添える。preview は打つたびに足す前の確かめを読む（Store の accountPreview に入る）。
  | { type: 'account.add.open' }
  | { type: 'account.add'; name: string; dir: string }
  | { type: 'account.add.pick'; defaultPath: string | null }
  | { type: 'account.add.preview'; name: string; dir: string }
  | { type: 'account.update'; accountId: string; name?: string; color?: string }
  | { type: 'account.remove'; accountId: string; confirmed?: boolean }
  | { type: 'account.login'; accountId: string } | { type: 'account.login.cancel'; accountId: string }
  | { type: 'account.refresh'; accountId: string }
  // デスクトップの殻に頼む操作。殻の無いブラウザでは、画面が場所のコピーと文の案内に落とす。
  | { type: 'shell.openLog' } | { type: 'shell.restart' }
  // done は写せたときにトーストで出す知らせ。書けなかったときは出さない。
  | { type: 'clipboard.copy'; text: string; done?: string }
  // セッションの宛先（別の Claude に渡す 1 行、presenters/session.ts の sessionAddressLine）をコピーする。
  | { type: 'session.copyAddress'; id: string }
  | { type: 'session.copyId'; id: string };
