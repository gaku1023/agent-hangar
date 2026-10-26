import type { ConfigApplyOrderEntryIn, ConfigSyncPart, FolderRegisterItem, UiAction, LaunchParams, NonDefaultAgentKind, ProjectPlace, ProjectRailSection, ResolveAction, PhoneLaunchDto, ResumeHerePlanDto, ResumeStray, RetentionFrom, Route, SearchFilter, SearchParamsDto, ServerEvent, SessionStatus, SettingsDto, SetupTarget, TakeoverDto, TodoDto, ProjectSameFolderDto } from '@agent-hangar/shared';
import type { TableAction } from '../runtime/actionTable.ts';
import type { CloudMemberCommand } from '../runtime/cloudMember.ts';
import type { UpdateCommand } from '../runtime/updater.ts';
import type { ConfigDetailPart } from '../store/store.ts';

/**
 * 検索の問い合わせ。期間を日数のまま持つ。
 * Mediator は時刻を知らないので、since に直すのは送る瞬間の Runtime である（toSearchParams）。
 */
export type SearchQuery = Omit<SearchParamsDto, 'since'> & { days?: number };

export type RuntimeEvent =
  // ws.close は時刻を運ぶ。Mediator は純粋な遷移なので、いつ切れたかを自分では測れない。
  | { type: 'ws.open' } | { type: 'ws.close'; at: number } | { type: 'hash.changed'; route: Route; moved?: number }
  | { type: 'api.failed'; message: string; holdMs?: number } | { type: 'search.done'; params: SearchParamsDto }
  | { type: 'launch.done'; sessionId: string; runId: string } | { type: 'launch.failed'; message: string }
  // 準備が問い（ask）で止まった、または利用者がやめた（cancel）。どちらも失敗ではない。message はサーバの文で、閉じた後に問いで止まったときだけ知らせる。
  | { type: 'launch.halted'; why: 'ask' | 'cancel'; message: string }
  // 起動した後にコンテキストが足りなかった札の「再ロードして再開」の結果。
  | { type: 'contextShort.done'; sessionId: string } | { type: 'contextShort.failed'; sessionId: string; message: string }
  | { type: 'promote.done'; projectId: string; moved: boolean; reason: string | null }
  | { type: 'promote.failed'; message: string }
  // 作ってから起動する送信の途中で、プロジェクトができた。params は作ったプロジェクトの id を入れた起動の詳細である。
  | { type: 'project.created'; projectId: string; params: LaunchParams }
  // プロジェクト画面の作成のダイアログの結果。
  | { type: 'project.create.done'; projectId: string; startSession: boolean } | { type: 'project.create.failed'; message: string }
  // アカウントを足すダイアログの結果（登録が通ったか）。ログインは続けて裏で始まる。
  | { type: 'account.add.done' } | { type: 'account.add.failed'; message: string }
  // 候補からまとめて登録した結果（初日のプロジェクト）。registered は登録できた数、linked はそのうちほかの PC のプロジェクトに結び付けた数、failed は登録できなかったものの理由である。
  | { type: 'project.candidates.done'; registered: number; linked: number; failed: string[] } | { type: 'project.candidates.failed'; message: string }
  // 時刻つきの Paused のうち、今日その時刻を過ぎたものの鍵（mediator/returnDue.ts の dueReturnKeys）。
  | { type: 'return.due'; keys: string[] }
  // 同期で、この PC に場所を持ったことが無いプロジェクトが降りてきた（Runtime が project.upsert から見分ける）。ids は降りたプロジェクト。起動の読み込みで入るものは届けない。
  | { type: 'projects.arrived'; ids: string[] }
  // 窓が前面に戻ったら、寝ていた間の変更をすぐ取りに行く。
  | { type: 'window.focus' }
  // 目次から左のターミナルを跳ばした結果。
  | { type: 'turnJump.done'; sessionId: string; seq: number; status: TurnJumpStatus }
  // サーバが 409 で断ったときに、ランタイムがこの形に直して返す。
  | { type: 'api.conflict'; kind: 'resumeHere'; sessionId: string; localSize: number; remoteSize: number }
  // 「この PC で再開」の確認に出すもの（GET /api/sessions/:id/resume-here）が届いた。
  | { type: 'resumeHere.plan'; plan: ResumeHerePlanDto }
  // 「場所を再指定」で選んだフォルダが、この PC で別のプロジェクトの場所だった。まとめる確認を出す。
  | { type: 'api.conflict'; kind: 'sameFolder'; conflict: ProjectSameFolderDto }
  // 再開を、終わった扱いの run の claude（pid）が動き続けていることで断られた。message は断った理由、queued はまとめて再開の 1 本だったこと。
  | { type: 'api.conflict'; kind: 'strayProcess'; sessionId: string; pid: number; message: string; queued: boolean }
  // 同じフォルダのプロジェクトを、from から into へまとめ終えた。from の画面を開いていれば into へ移る。
  | { type: 'project.merged'; fromId: string; intoId: string }
  // 保持期間を書き込んだ結果。409 は下見の後にファイルが変わったことを表す。
  | { type: 'retention.written'; days: number } | { type: 'retention.conflict'; days: number } | { type: 'retention.failed'; message: string }
  | { type: 'retention.previewFailed'; days: number; message: string }
  // 欄ごとの保存の結果。失敗はトーストにせず、その欄の下に理由を出す。
  | { type: 'settings.saved'; field: string } | { type: 'settings.failed'; field: string; message: string }
  // クリップボードに写せた。写せなかったときはランタイムがトーストで知らせ、これは届かない。
  | { type: 'clipboard.copied'; text: string }
  // 設定の同期の適用（指示書を書き、殻のネイティブの確認を待った）の結果。close が真ならダイアログを閉じる。
  | { type: 'configSync.done'; close: boolean }
  // psmux（tmux）の再確認の答え。found は、答えの準備の確かめで tmux の行が動かせるか。答えは Runtime が先に Store へ入れてある。
  | { type: 'mux.checked'; found: boolean }
  // 連携の書き込みを殻に頼んだ返事が来た（書いた、取り消した、失敗した、のどれでも）。
  | { type: 'setup.done'; target: SetupTarget }
  // まとめて再開（中断の群）の 1 本が起きた、または断られた。
  | { type: 'resumeQueue.done'; sessionId: string } | { type: 'resumeQueue.failed'; sessionId: string; message: string };

/**
 * Mediator が裁定する UiAction。
 * API を 1 回呼ぶだけの UiAction は Runtime が表で引いて実行する（runtime/actionTable.ts）ので、ここには入らない。
 * 表にある kind を領域の switch に書くと、型が合わなくなる（二重に扱わない）。
 */
/** Runtime が自分で受ける UiAction。git.watch は取り直しの周期を持つので、表にも Mediator にも置かない（runtime/gitWatch.ts）。 */
export type RuntimeAction = Extract<UiAction, { type: 'git.watch' }>;
export type MediatedAction = Exclude<UiAction, TableAction | RuntimeAction>;

export type Input =
  | { kind: 'action'; action: MediatedAction }
  | { kind: 'server'; event: ServerEvent }
  | { kind: 'runtime'; event: RuntimeEvent }
  // Store が変わった。中身は運ばない。Mediator は渡された Store を読み、そこから決まる状態（入力待ちの知らせ、サイドバーの「動いている」の並び）を合わせる。
  // Store を変えるのは Runtime なので、変わったことだけは Runtime が知らせる。
  | { kind: 'store' };

export type Effect =
  | { kind: 'navigate'; route: Route }
  | { kind: 'history.go'; delta: number }
  | { kind: 'api.bootstrap' }
  // fromSeq の 0 は「開いた（最新側）」、-1 は「過去へ遡る」、-2 は「追記の取り込み（後ろを読み足す）」。
  // aroundSeq は検索の結果から開いたときの跳び先で、開いたときに最新の側ではなくその周りを読む。
  | { kind: 'api.loadEvents'; sessionId: string; fromSeq: number; aroundSeq?: number }
  // append が真なら、届いた行を持っている結果の後ろに足す（「さらに読み込む」）。偽か無ければ置き換える。
  | { kind: 'api.search'; params: SearchQuery; append?: boolean }
  | { kind: 'api.resolveProject'; projectId: string; action: ResolveAction }
  | { kind: 'api.updateSettings'; patch: Partial<SettingsDto>; field?: string }
  | { kind: 'api.readiness' }
  // psmux（tmux）を探し直させる（POST /api/readiness/mux）。答えは準備の確かめとして Store に入り、mux.checked で知らせる。
  | { kind: 'api.recheckMux' }
  | { kind: 'shell.openLog' } | { kind: 'shell.restart' } | { kind: 'clipboard.copy'; text: string; done?: string }
  | { kind: 'api.rebuildIndex' }
  | { kind: 'api.launch'; params: LaunchParams } | { kind: 'api.resume'; sessionId: string; stray?: ResumeStray; prepKey?: string } | { kind: 'api.fork'; sessionId: string }
  // 起動した後にコンテキストが足りなかった会話のローカルのモデルを整え直す。進みは prepKey の鍵の launch.prep で届き、結果は contextShort.done か contextShort.failed で返る。
  | { kind: 'api.fixContextShort'; sessionId: string; prepKey: string }
  | { kind: 'api.attach'; sessionId: string } | { kind: 'api.adopt'; sessionId: string }
  // まとめて再開（中断の群）の 1 本。起きても画面は移さず、結果は resumeQueue.done か resumeQueue.failed で返る。
  | { kind: 'api.resumeQueued'; sessionId: string; stray?: ResumeStray }
  // 中断の群の「再開しない」と、その取り消し。返った群を Store に入れる。
  | { kind: 'api.dismissInterrupted'; runIds: string[]; dismissed: boolean }
  | { kind: 'api.killRun'; runId: string } | { kind: 'api.openTab'; sessionId: string } | { kind: 'api.closeTab'; tabId: string }
  | { kind: 'api.jumpToPrompt'; sessionId: string; runId: string; seq: number; heads: string[]; index: number; from: 'top' | 'bottom' }
  | { kind: 'api.leaveTranscript'; runId: string }
  | { kind: 'terminal.connect'; sessionId: string; tabId: string | null } | { kind: 'terminal.disconnect'; tabId: string }
  | { kind: 'terminal.disconnectSession'; sessionId: string }
  | { kind: 'ws.connect' } | { kind: 'ws.reconnectAfter'; ms: number }
  | { kind: 'focus'; target: FocusTarget }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  // 入力待ちになったセッションを通知で知らせる。
  // 受け取る設定か、窓が背面かはランタイムが見る。
  | { kind: 'notify.waiting'; sessionId: string }
  // 戻る時刻を過ぎた Paused を通知で知らせる。出すかどうかは notify.waiting と同じくランタイムが見る。
  | { kind: 'notify.return'; sessionId: string }
  // 通知の許可を求める。
  // 利用者の操作の中で出すので、ブラウザの許可ダイアログも出せる。
  | { kind: 'notify.request' }
  // 通知を受け取らないにする。Runtime がその場で切り替えて覚える。
  | { kind: 'notify.off' }
  // アプリの自動更新の操作。Runtime が殻の updater に頼み、結果を Store の update に置く（runtime/updater.ts）。
  | { kind: 'update'; command: UpdateCommand }
  // クラウド同期への参加と、PC の解除と、この PC の参加の解除。Runtime が殻の命令に頼み、結果を Store の cloudMember に置く（runtime/cloudMember.ts）。
  | { kind: 'cloudMember'; command: CloudMemberCommand }
  // Dock（ブラウザならアプリ）のバッジに入力待ちの数を出す。
  // 0 で消す。
  | { kind: 'badge'; count: number }
  | { kind: 'storage.save'; key: string; value: unknown }
  | { kind: 'api.addTodo'; projectId: string; text: string }
  // TODO の操作。どれも API を 1 回呼ぶだけで、画面の正は後から届く todos.update である。
  | { kind: 'api.todo'; call: TodoCall }
  // セッションの状態。本文には渡されたものだけを載せる。
  | { kind: 'api.setSessionState'; id: string; body: { status: SessionStatus | null; note?: string; returnOn?: string; returnTime?: string } }
  | { kind: 'api.confirmSessionState'; id: string; body: { returnOn?: string; returnTime?: string } }
  | { kind: 'api.rejectSessionState'; id: string }
  | { kind: 'api.loadMemo'; projectId: string }
  | { kind: 'api.loadInstructions'; projectId: string }
  | { kind: 'api.promote'; sessionId: string; name: string; gitInit: boolean; moveFiles: boolean; parent?: string }
  | { kind: 'api.createProject'; place: ProjectPlace; startSession: boolean }
  | { kind: 'api.createProjectThenLaunch'; place: ProjectPlace; params: LaunchParams }
  | { kind: 'api.workspaceDirs' }
  // Claude Code と会話したフォルダの候補を取る。答えは Store の folderCandidates に入る。
  | { kind: 'api.folderCandidates' }
  // 「フォルダの中から」の親フォルダの直下を取る。答えは Store の workspaceChildren に入り、後から頼んだ親の答えだけを採る。
  | { kind: 'api.workspaceChildren'; parent: string }
  // 候補からまとめて登録する。workspaceRoot があれば、先に新しいフォルダの作成場所として保存する。
  | { kind: 'api.registerFolders'; items: FolderRegisterItem[]; workspaceRoot: string | null }
  // Finder でフォルダを選ぶ。defaultPath を省けば、ワークスペースのルートから開く（プロジェクトの作成）。
  | { kind: 'desktop.pickFolder'; defaultPath?: string | null }
  // 連携の書き込みを殻に頼む（setup_integration）。殻が承諾の窓を出す。ブラウザでは殻が無いので、すぐ setup.done を返す。
  | { kind: 'desktop.setup'; target: SetupTarget }
  | { kind: 'api.loadSettingsExtras' }
  | { kind: 'api.syncFocus' }
  | { kind: 'api.resumeHere'; sessionId: string; overwrite: boolean }
  | { kind: 'api.resumeHerePlan'; sessionId: string }
  // ほかの PC で動く会話の引き継ぎ。start は停止の頼み（force は応答のない相手を頼まずに引き継ぐ）、extend は打ち切りの延長、cancel は取り下げ。
  // 応答の TakeoverDto は Runtime が takeover.update のサーバの知らせと同じ道で流すので、段の変化は mediator に 1 本の入力で届く。
  | { kind: 'api.takeoverStart'; sessionId: string; force: boolean }
  | { kind: 'api.takeoverExtend'; sessionId: string }
  | { kind: 'api.takeoverCancel'; sessionId: string }
  // 設定の同期（作り直した実装）。Load は中身を取る。Apply は指示書を書き（entries が null なら、いまある指示書を使い）、殻のネイティブの確認へ進む。Restore は控えの世代へ戻す。
  | { kind: 'api.configSyncLoad'; parts: ConfigDetailPart[] }
  | { kind: 'api.configSyncApply'; entries: ConfigApplyOrderEntryIn[] | null }
  | { kind: 'api.configSyncRestore'; name: string }
  | { kind: 'api.retentionPreview'; days: number } | { kind: 'api.writeRetention'; days: number }
  // Claude Code のアカウント。
  | { kind: 'api.accounts.switchSession'; sessionId: string; accountId: string }
  | { kind: 'api.accounts.add'; name: string; dir: string | null }
  | { kind: 'api.accounts.remove'; accountId: string };

export type Screen = { name: 'booting' } | Route;
/** results はセッションの一覧の画面の結果の一覧である。 */
export type FocusTarget = 'newSessionName' | 'terminal' | 'palette' | 'promoteName' | 'todoInput' | 'results';
/**
 * 押し切る前に一言聞く必要があるもの。
 * 他端末の本文で手元を上書きする場面、外のターミナルの claude を引き取る場面、作業中かシェルタブのあるランを止める場面、
 * 見つからないプロジェクトを一覧から削除する場面、終わった扱いの claude が動き続けている会話を再開する場面である。
 */
export type ConfirmRequest =
  // ほかの PC で進めた会話をこの PC で再開する前の確認（前の PC とこの PC、同期されないもの）。毎回出す。
  | { kind: 'resumeHere'; sessionId: string; plan: ResumeHerePlanDto }
  // 同じ 1 枚が、停止を頼んでから引き継ぐ進み具合に変わる。takeover は最新の段で、頼みの応答が届くまでは null（asking と同じに見せる）。
  | { kind: 'takeover'; sessionId: string; plan: ResumeHerePlanDto; takeover: TakeoverDto | null }
  | { kind: 'overwriteTranscript'; sessionId: string; localSize: number; remoteSize: number }
  | { kind: 'adoptSession'; sessionId: string }
  // hangar では終わった扱いの run の claude（pid）が動き続けているときの再開（issue #258）。queued はまとめて再開の 1 本で、選んだら順番待ちに入れ直す。
  | { kind: 'strayProcess'; sessionId: string; pid: number; queued?: true }
  | { kind: 'killRun'; runId: string; working: boolean; aside?: boolean; shellTabs: number }
  // fromDialog は、未解決のプロジェクトのダイアログから来たこと。やめるとそのダイアログへ戻る。
  | { kind: 'unlinkProject'; projectId: string; fromDialog?: true }
  // 別のアカウントで再開する場面と、アカウントを一覧から外す場面。
  | { kind: 'switchAccount'; sessionId: string; accountId: string; working: boolean }
  | { kind: 'removeAccount'; accountId: string }
  // セッションを消す（本文をゴミ箱へ移し、同期しているほかの PC からも消す）前の確認（試作の 3A）。
  | { kind: 'deleteSession'; sessionId: string }
  // 同じフォルダのプロジェクトをまとめる（サーバの 409 の ProjectSameFolderDto から組む）。
  // projectId はまとめる方で、承諾するとそのプロジェクトへ path と merge: true を送り直す。into は残す方、roots と件数はまとめた後の姿である。
  | { kind: 'mergeProject'; projectId: string; path: string; into: { projectId: string; name: string }; roots: { deviceName: string | null; path: string; here: boolean }[]; sessions: number; fromSessions: number };
export type Overlay =
  | { kind: 'none' } | { kind: 'resolveProject'; projectId: string } | { kind: 'palette' }
  | { kind: 'shortcuts' }
  // worktree は、worktree の札をオンにして開くこと（同じファイルの編集の警告から開いたとき）。名前はダイアログが付ける。
  // dir は、はじめに選んでおくフォルダ（作成のダイアログから、登録済みのプロジェクトの下のフォルダで始めるとき。0.6.1）。
  | { kind: 'newSession'; projectId: string | null; scratch: boolean; worktree?: boolean; dir?: string }
  | { kind: 'promote'; sessionId: string }
  | { kind: 'newProject' }
  // 設定の「アカウントを足す…」。入力はダイアログが持ち、送信の進みは accountAdd が持つ。
  | { kind: 'addAccount' }
  // まとめて登録のダイアログ（初日のプロジェクト）。source は開いた時点の見方（talked は Claude Code と会話したフォルダ、folder はフォルダの中から）。
  // submitting は登録の返事を待っているあいだ、error は登録の失敗の理由。
  | { kind: 'projectCandidates'; source: 'talked' | 'folder'; submitting: boolean; error: string | null }
  | { kind: 'promoted'; projectId: string; moved: boolean; reason: string | null }
  | { kind: 'confirm'; confirm: ConfirmRequest }
  // 設定の同期（作り直した実装）。part が顔を決める。working は、適用の返事（指示書を書き、ネイティブの確認を経る）を待っているあいだ。
  | { kind: 'configSync'; part: ConfigSyncPart; working: boolean }
  | { kind: 'retention'; days: number; from: RetentionFrom; reloaded: boolean; writing: boolean; previewError: string | null }
  // Paused の入力（B1）。from は開いた入口（「⋯」か提案の「日を変える」）。
  | { kind: 'pause'; sessionId: string; from: 'menu' | 'candidate' }
  // セッションを別のプロジェクトへ移す先を選ぶダイアログ（試作の 2A）。選んでいる先と検索の語は、ダイアログが持つ。
  | { kind: 'moveSession'; sessionId: string }
  // 差分のダイアログ（git の表示）。file は選んだファイルで、null なら画面が最初の未コミットを選ぶ。source は差分の出どころで、null なら画面が決める（git でなければこのセッションの編集）。
  | { kind: 'diff'; sessionId: string; file: string | null; source: 'git' | 'session' | null }
  // psmux（tmux）が無いときに、セッションを始める操作を止めて出す案内（段 6 の B2）。
  // pending は止めた操作で、見つかったあとの「開始」でそのまま進める。
  // back は止めたときに開いていた新しいセッションのダイアログか、引き継ぎの確認の 1 枚で、閉じたらそこへ戻る。
  | { kind: 'muxGuide'; pending: MuxPending; back: Extract<Overlay, { kind: 'newSession' }> | Extract<Overlay, { kind: 'confirm' }> | null };
/** psmux（tmux）が無いときに止める、セッションを始める操作。 */
export type MuxPending = Extract<UiAction, { type: 'session.new.submit' | 'session.resume' | 'session.fork' | 'session.resumeHere' | 'session.adopt' | 'session.attach' | 'interrupted.resume' | 'session.takeover.start' }>;
/** psmux（tmux）の再確認の進み。missing は、再確認しても見つからなかったこと。 */
export type MuxCheck = 'idle' | 'checking' | 'missing';
/**
 * 新しいセッションのダイアログの書きかけ。プロジェクトごとではなく 1 つだけ持つ。
 * 添付は、置き場（~/.agent-hangar/drops/）のパスで覚える。
 * mediator から views の型を import しないよう、形をここに書く（promptComposerModel.ts の Attachment と同じ形）。
 */
export type NewSessionDraft = { name: string; prompt: string; attachments: { path: string; name: string; size: number | null }[] };
/** 新しいセッションの詳細の前回値。起動したときの値のうち、既定でないものだけを持つ。 */
/**
 * 新しいセッションの、プロジェクトごとの前回値。model、effort、permissionMode、addDirs は Claude Code の札の値である。
 * agent は前回 Claude Code 以外で起こしたときだけその種類を持ち、無ければ Claude Code である。opencodeModel は opencode のモデル（`provider/model`）で、無ければデフォルト。
 */
export type LaunchPrefs = Pick<LaunchParams, 'model' | 'effort' | 'permissionMode' | 'worktree' | 'addDirs'> & { agent?: NonDefaultAgentKind; opencodeModel?: string; codexModel?: string; codexEffort?: string };
/**
 * createdProjectId は、作ってから起動する送信でプロジェクトができた後の印である。起動だけが失敗しても、押し直しで二重に作らない。
 * halted は、準備が問いで止まったか、利用者がやめたこと。失敗ではないので文を持たず、画面は準備の進み（launchPrep）を読んで問いを出す。
 */
export type LaunchState = { kind: 'idle' } | { kind: 'submitting'; createdProjectId?: string } | { kind: 'failed'; message: string; createdProjectId?: string } | { kind: 'halted'; createdProjectId?: string };
/**
 * 起動前の準備の見張り（起動の要求に添えた prepKey）。model は起動のモデル（provider/model）で、問いの答えの provider を取る。
 * name は利用者が付けた名前で、閉じた後に済んだときの知らせに使う（会話の名前が Store に届く前のため）。
 */
export type LaunchPrepMark = { key: string; model: string | null; name: string | null; /** 再開の準備（進みは右下の札に出す）。 */ resume?: true };
/** 起動した後にコンテキストが足りなかった会話の札。fix は整え直しの最中の鍵、done は済んだこと。 */
export type ContextShort = { sessionId: string; fix: { key: string } | null; done: boolean };
/** 目次から左のターミナルを跳ばした結果。pending の間は注記を出さない。 */
export type TurnJumpStatus = 'pending' | 'found' | 'notFound' | 'mode' | 'failed';
/** 検索の結果から開いたときの跳び先（J1）。n は開いた回数で、同じ所をもう一度開いても跳び直す合図にする。 */
export type JumpState = { seq: number; query: string; n: number };
export type SessionViewState = {
  agentId: string | null; showThinking: boolean; showRaw: boolean; follow: boolean; selectedTab: string | null; transcriptOpen: boolean; split: boolean; splitTab: string | null;
  /** ターンの少ない終わった会話で、その画面だけ右の欄を開いたか（保存しない。presenters の tocFolds）。 */
  tocPeek: boolean;
  /** 目次で開いているターン（区切りの行の seq）。その場の操作なので保存しない。 */
  openTurn: number | null;
  /**
   * 開いたターンへ左のターミナルを跳ばした結果。
   * これも保存しない。
   * runId は跳ばした Claude の run で、ターンを閉じたときと画面を離れたときに transcript から抜けさせる先である。
   */
  turnJump: { seq: number; status: TurnJumpStatus; runId: string } | null;
  /** 検索の結果から開いたときの跳び先。無ければ null。 */
  jump: JumpState | null;
};
/** holdMs は info の出している長さ（ミリ秒）。省くと既定の長さ（INFO_TOAST_MS）。action はトーストの中のボタン（「元に戻す」）で、押すとその UiAction を出してトーストを閉じる。 */
export type Toast = { id: string; level: 'info' | 'error'; message: string; holdMs?: number; action?: { label: string; send: UiAction } };
/**
 * まとめて再開（中断の群）の進み。queued は順番待ち、active は再開を頼んで返事を待っているもの、failed は断られた理由（セッションの id から）。
 * 同時に頼むのは RESUME_CONCURRENCY 本までである。
 */
/** stray は、残った claude の確認で選んだもの（セッションごと）。そのセッションの再開に添え、済むか断られたら外す。無ければ項目ごと持たない。 */
export type ResumeQueue = { queued: string[]; active: string[]; failed: Record<string, string>; stray?: Record<string, ResumeStray> };
/**
 * 欄ごとの保存の知らせ。
 * saved の n は同じ欄を保存するたびに進み、画面は変わるたびに「✓ 保存しました」を出し直す。
 * error は欄の下に出す理由で、同じ欄をもう一度保存し始めたら消える。
 */
export type SaveMark = { kind: 'saved'; n: number } | { kind: 'error'; message: string };
/** TODO の API の呼び出し。restore は取り消しで、写しの行をそのまま書き戻す。 */
export type TodoCall =
  | { op: 'setDone'; id: string; done: boolean } | { op: 'edit'; id: string; text: string } | { op: 'remove'; id: string }
  | { op: 'confirm'; id: string } | { op: 'reject'; id: string } | { op: 'accept'; id: string }
  | { op: 'reorder'; projectId: string; ids: string[] } | { op: 'restore'; rows: TodoDto[] };
export type TodoUndoEntry = { projectId: string; rows: TodoDto[]; removed: string | null };

export type State = {
  screen: Screen; overlay: Overlay; connection: 'connecting' | 'connected' | 'disconnected'; reconnectAttempt: number;
  /** 切れた最初の瞬間。画面がそこで止まっていることを言うために持つ。つながっている間は null。 */
  staleSince: number | null;
  /** 次に自動で試す時刻。待っているのか固まっているのかを見せるために持つ。 */
  nextRetryAt: number | null;
  sessionView: Record<string, SessionViewState>;
  /**
   * 一覧の語と絞り込み、平らな一覧のいまのページ（1 から）。ページは条件を変えるか画面に入り直すと 1 に戻る。
   * ホームと 1 つのプロジェクトの画面が同じものを使う。プロジェクトの画面では、そのプロジェクトに絞る（絞り込みには projectId を入れない。mediator/screen.ts の listProjectId）。
   * 別の画面から入ると、持ち込まずに空から始める。
   */
  search: { text: string; filter: SearchFilter; page: number };
  /** 一覧の 1 ページの件数（PAGE_SIZES のどれか）。どの一覧も同じ件数を使う。端末ごとに localStorage に残し、起動時に読み戻す。 */
  pageSize: number;
  /** 起動の進み。ダイアログからの起動も、再開もフォークも同じ状態を共有する。 */
  launch: LaunchState;
  /** 送った起動の準備の鍵（opencode のときだけ）。ダイアログが進みと問いを、閉じた後の知らせが成否の出し方を、これで決める。 */
  launchPrep: LaunchPrepMark | null;
  /** 起動した後にコンテキストが足りなかった会話の右下の札（opencode.contextShort）。同じ会話は 1 枚で、古いものが先。 */
  contextShorts: ContextShort[];
  /**
   * 新しいセッションのモデルの小窓の「プロバイダーを管理…」で設定へ移ったときの、ダイアログの開き方。
   * 設定の opencode の面に「‹ 新しいセッションに戻る」を出し、押すと同じ開き方で開き直す。設定の外へ移ったら忘れる。持っていなければ null か無し。
   */
  opencodeReturn?: { projectId: string | null; scratch: boolean; dir?: string } | null;
  /**
   * すでに知らせた入力待ちのセッション（hangar の id）。
   * 入力待ちが解けたら忘れる。
   */
  waitingSeen: string[];
  /**
   * 問いの文が取れないまま知らせた入力待ちのセッション（waitingSeen の一部）。
   * 問いの文は入力待ちより少し遅れて届くことがあるので、届いたら同じセッションの通知をもう一度出す（OS は同じ識別子の通知を書き換える）。
   * 書き換えたものと、入力待ちが解けたものは外す。
   */
  waitingBare: string[];
  /**
   * いまの入力待ちの 1 回ごとの鍵（「セッションの id|最後の動きの時刻」、waitingSeen と同じ並び）。
   * 変わるたびに、まだ引き当てていない waitingCarried と合わせて localStorage に残す（mediator/live.ts の WAITING_NOTIFIED_KEY）。
   */
  waitingKeys: string[];
  /**
   * 開き直す前に残した入力待ちの鍵のうち、まだ引き当てていないもの。起動のときに localStorage から読み戻す。
   * この頁で初めて入力待ちと見たセッションの鍵がここにあれば、開き直す前に知らせ終えているので、通知の効果を出さない。
   * 引き当てたセッションの鍵は、当たっても外れても外す。この頁で解けてまた入力待ちになったときは、鍵が同じでも知らせる。
   */
  waitingCarried: string[];
  /**
   * 右下に積む入力待ちのカードのセッション。
   * 古いものが先。
   * 入力待ちが解けるか、そのセッションを開くまで残す。
   */
  waitingToasts: string[];
  /**
   * 同期で他の PC から降りてきたプロジェクトで、まだ札を下げていないもの（降りた順）。
   * 右下に「他の PC のプロジェクト N 件が届きました」の札を 1 枚だけ出す（設計書 2.11.5）。N は、いまも他の PC から届いたままのものを数える。
   * 「プロジェクトで見る」か「あとで決める」で空にする。帯の件数には入らない。
   */
  arrivedProjects: string[];
  /**
   * スマホからの依頼でこの PC が起こした会話の右下の通知（試作 F1、サーバーの phone.launch）。受信した順で、同じ会話は 1 枚にまとめる。
   * 「開く」「停止」と、通常の通知の時間切れで下げる。Bypass permissions の通知は時間では下げない。
   */
  phoneLaunches: PhoneLaunchDto[];
  /** 戻る時刻を過ぎたと OS の通知で知らせ終えた鍵（id|日 時刻）。同じ時点を 2 度知らせないために覚え、localStorage にも残す。 */
  returnSeen: string[];
  /**
   * 昇格ダイアログの進み。
   * 起動と同じ形の状態を使う。
   */
  promote: LaunchState;
  /** プロジェクト画面の作成のダイアログの送信。 */
  projectCreate: LaunchState;
  /** アカウントを足すダイアログの送信。 */
  accountAdd: LaunchState;
  toasts: Toast[]; nextToastId: number;
  /** サイドバーを図とアイコンだけの帯に縮めているか。開閉のたびに保存し、起動時に読み戻す。 */
  sidebarCollapsed: boolean;
  /** 開いたサイドバーの幅（px）。境目を掴んで変え、端末ごとに保存して起動時に読み戻す。 */
  sidebarWidth: number;
  /**
   * サイドバーの「動いている」の行を、利用者が並べた順（セッションの id）。端末ごとに localStorage に残し、起動時に読み戻す。
   * ここに無いセッション（新しく動き始めたもの）は、並べた行の上に入る（presenters/shell.ts）。
   */
  sidebarOrder: string[];
  /** サイドバーの「実行中」で畳んだグループ（プロジェクトの id。未分類は空の文字列）。 */
  sidebarFolded: string[];
  /**
   * プロジェクト画面の右パネルで折りたたんだ節（プロジェクトの id から節の並びへ）。無いプロジェクトは 3 つとも開く。
   * 端末ごとに localStorage に残し、起動時に読み戻す（mediator/projectRail.ts）。
   */
  projectRailFolded: Record<string, ProjectRailSection[]>;
  /**
   * ベルの一覧で既読にした行の鍵（種類、対象、事実の版）。新しいものが後ろ。端末ごとに localStorage に残し、起動時に読み戻す。
   * 一覧の行は事実から Presenter が組み、ここは既読の鍵だけを持つ（mediator/notices.ts）。
   */
  noticesRead: string[];
  /** 空きが足りずに本文の取得を止めた札を、いまの止まりで出し終えたか（mediator/diskShort.ts）。解けたら false に戻す。 */
  diskShortToasted: boolean;
  /**
   * 未検証の opencode の版の札（C7）を閉じた版。同じ版では二度出さない。端末ごとに localStorage に残し、起動時に読み戻す（mediator/opencodeVersion.ts）。
   */
  opencodeVersionSeen: string | null;
  /** 未検証の Codex の版の札を閉じた版（mediator/codexVersion.ts）。扱いは opencodeVersionSeen と同じ。 */
  codexVersionSeen: string | null;
  /** 新しいセッションのダイアログの書きかけ。閉じても残し、次に開いたときに戻す。端末ごとに localStorage に残す。 */
  newSessionDraft: NewSessionDraft | null;
  /**
   * 新しいセッションのダイアログから起動を送り、まだ終わっていないか。
   * 送った後にダイアログを閉じても起動は続くので、終わったときに下書きを消す手がかりにする。
   */
  newSessionSent: boolean;
  /**
   * 新しいセッションの詳細の、プロジェクトごとの前回値。鍵はプロジェクトの id で、クイックセッションは ':scratch' である。
   * 次にそのプロジェクトでダイアログを開いたときの初期値にする。端末ごとに localStorage に残す。
   */
  launchPrefs: Record<string, LaunchPrefs>;
  /** 欄ごとの保存の知らせ。欄の名前（設定の項目名）で引く。 */
  settingsSave: Record<string, SaveMark>;
  /**
   * 最後にクリップボードへ写せた文。
   * n は写せるたびに進み、コピーのボタンは押した後に進んだのを見てから「コピーしました」を出す。
   * 写せなかったときは進まない。
   */
  copied: { text: string; n: number } | null;
  /** psmux（tmux）の再確認の進み。帯、案内のダイアログ、設定のツールの行が同じものを読む。 */
  muxCheck: MuxCheck;
  /** 連携の書き込みで、殻の返事を待っている対象。待っていなければ null。 */
  setupRunning: SetupTarget | null;
  /**
   * TODO の取り消しの積み（古いものが先、mediator/todos.ts）。操作の前の行の写しを持つ。
   * removed は、その操作で消した TODO の ID（消した場所の帯の「元に戻す」が引く）。端末には残さない。
   */
  todoUndo: TodoUndoEntry[];
  /** まとめて再開（中断の群）の進み（mediator/interrupted.ts）。端末には残さない。 */
  resumeQueue: ResumeQueue;
};
export type Step = { state: State; effects: Effect[] };
