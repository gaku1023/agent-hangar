import type { PeerChatDevice, PeerChatQueued, PeerChatReadEvent, PeerChatUpdate } from './peerChat.ts';
import type { ScheduleDto } from './schedule.ts';
import type { TakeoverDto, DeleteApprovalDto, AccountsDto, ArtifactDto, CloudUsageDto, ConfigSyncDto, DeviceDto, IndexProgressDto, InterruptedDto, JoinApproverState, JoinRequestView, LiveSessionDto, PhoneLaunchDto, ProjectDto, RetentionDto, RunDto, SessionDto, SettingsDto, SyncStatusBody, TabDto, TodoDto } from './api.ts';

export type ServerEvent =
  | { type: 'ready'; version: string }
  | { type: 'project.upsert'; project: ProjectDto }
  | { type: 'project.unresolved'; projectId: string }
  | { type: 'session.upsert'; session: SessionDto }
  // セッションが一覧から消えた（削除した、本文の無いまま片付けた）。画面は Store から外す。
  | { type: 'session.removed'; id: string }
  | { type: 'live.update'; live: LiveSessionDto[] }
  // 会話の件数の集計。会話の行が変わったあと、間引いて 1 秒に 1 回まで配る（events/publisher.ts）。画面は件数を足し引きせず、これで置き換える。
  | { type: 'sessionCounts.update'; counts: import('./sessionList.ts').SessionCountsDto }
  | { type: 'transcript.appended'; sessionId: string; count: number }
  /** 机の音声のいまの状態（補助の有無、聞き取りの段、字幕、読み上げ中）。サーバの声のサービスが変わるたびに配る。 */
  | { type: 'voice.state'; state: import('./voice.ts').VoiceStateDto }
  | { type: 'index.progress'; progress: IndexProgressDto }
  | { type: 'run.started'; run: RunDto; tabs: TabDto[] }
  | { type: 'run.upsert'; run: RunDto }
  | { type: 'run.ended'; run: RunDto }
  | { type: 'tab.upsert'; tab: TabDto }
  | { type: 'accounts.update'; accounts: AccountsDto }
  | { type: 'todos.update'; projectId: string; todos: TodoDto[] }
  | { type: 'artifact.upsert'; artifact: ArtifactDto }
  | { type: 'summary.pending'; sessionId: string }
  | { type: 'summary.updated'; sessionId: string }
  | { type: 'summary.failed'; sessionId: string; message: string }
  /**
   * 同期の状態。付録（諦めた本文と取り残しの件数）も一緒に運ぶ。
   * SyncEngine はどちらの値も持たないので、配る側が添えてから流す。
   * 付録が欠けると、画面の件数が一度受け取った値のまま固まる。
   */
  | { type: 'sync.status'; status: SyncStatusBody }
  /** 設定の「使用量と費用」。端末のサーバが 5 分ごとに取り直して配る。 */
  | { type: 'sync.usage'; usage: CloudUsageDto }
  | { type: 'devices.update'; devices: DeviceDto[] }
  | { type: 'deleteApprovals.update'; approvals: DeleteApprovalDto[] }
  | { type: 'schedules.update'; schedules: ScheduleDto[] }
  /**
   * ほかの PC の会話の更新（見る側の PC が長いポーリングで取った差分。peer/chat/viewer.ts）。
   * 見ている会話だけに流れる。
   */
  | ({ type: 'peerChat.update' } & PeerChatUpdate)
  | ({ type: 'peerChat.read' } & PeerChatReadEvent)
  /** 設定の同期（作り直した実装）の状態。届いた変更、競合、送らなかった項目、適用の指示書が動いたときに配る。 */
  | { type: 'config.update'; configSync: ConfigSyncDto }
  | { type: 'retention.changed'; retention: RetentionDto }
  /** 中断の群が変わった（tmux のサーバが消えた、再開しないと決めた、元に戻した）。群が無くなれば null。 */
  | { type: 'interrupted.update'; interrupted: InterruptedDto | null }
  /** 「この PC で再開」の引き継ぎの段が変わった。取り下げたあとは stage が cancelled のものを 1 度だけ配る。 */
  | { type: 'takeover.update'; takeover: TakeoverDto }
  /**
   * git の状態が変わった（git.ts）。実行中のセッションが書いたあと、サーバが読み直して値が変わったときだけ配る。
   * 部分なので、受け取る側は前の値に重ねる。
   */
  | { type: 'git.upsert'; git: import('./git.ts').GitDto }
  /**
   * 設定が保存された。変えた欄の名前（keys）と、保存後の設定を運ぶ。
   * API やほかの窓から直されても、開いている画面が準備の確かめ（道具のパスと作業フォルダ）を読み直せるようにする。
   */
  | { type: 'settings.changed'; settings: SettingsDto; keys: (keyof SettingsDto)[] }
  /** 統括の見張りの状態が変わった（動いている、止まった理由、切り替え中）。柱のメニューと上端の棒が読む。 */
  | { type: 'orchestrator.state'; state: import('./orchestratorState.ts').OrchestratorStateDto }
  /** 参加コードを発行した PC の承認の状態が変わった（設定のクラウド同期の節が切り替わる）。 */
  | { type: 'join.update'; join: JoinApproverState }
  /** 参加リクエストを受信した。1 つのリクエストにつき 1 回だけ配る（右下の通知）。 */
  | { type: 'join.request'; request: JoinRequestView; expiresAt: number }
  /** スマホからの依頼でこの PC が会話を起こした。1 つの依頼につき 1 回だけ配る（右下の通知、試作 F1）。 */
  | { type: 'phone.launch'; launch: PhoneLaunchDto }
  | { type: 'remoteTab.upsert'; tab: import('./remoteShell.ts').RemoteTabDto }
  | { type: 'remoteTab.closed'; id: string }
  | { type: 'remoteHost.changed'; deviceId: string; host: string | null }
  /**
   * ほかの PC から来た文の預かり（peer/chat/queue.ts）が変わった。sessionId の預かりの全体（古い順）を運ぶ。空なら帯を畳む。
   * 預かった、渡し始めた、渡した、取り消された、10 分で捨てた、会話が消えた、のどれでも配る。
   */
  | { type: 'peerChat.queue'; sessionId: string; queued: PeerChatQueued[] }
  /** ほかの PC から来た文を、この PC の入力欄へ渡した。1 件につき 1 回だけ配る（「{device} から送信しました」の札）。from は送り主、at は渡した時刻。 */
  | { type: 'peerChat.delivered'; sessionId: string; from: PeerChatDevice; at: number }
  /**
   * opencode（ベータ）の serve を、確かめた範囲の外の版で起こした。起こすたびに配る（docs/design.md「opencode の検出（ベータ）」）。
   * verdict は unverified（範囲の外）、legacy（1.x）、unknown（版が読めない）。画面は検出の答え（GET /api/opencode/status）として受け、右下の札を一度だけ出す。
   */
  | { type: 'opencode.version'; version: string | null; verdict: 'unverified' | 'legacy' | 'unknown' }
  /** opencode の会話が、ローカルのモデルの長さが足りずに断られた（起動後の検出）。右下の札に「整えて再開」を出す。 */
  | { type: 'opencode.contextShort'; sessionId: string }
  /** opencode の会話が、この PC のサーバーに無いモデルで断られた（起動後の検出）。右下の札に「別のモデルでやり直す」を出す。model は文から取れたモデルの名前（provider を含まない）で、取れなければ null。 */
  | { type: 'opencode.modelMissing'; sessionId: string; model: string | null }
  /** 起動前の準備の進み（launchPrep.ts）。段が動くたびに、鍵ごとの全体を配る。 */
  | { type: 'launch.prep'; prep: import('./launchPrep.ts').LaunchPrepDto }
  /**
   * 閉じている間に届いたできごとが、利用者の選びを待つ山に積まれた（#563）。
   * n は今回積んだ件数。
   * 画面は山の中身を GET /api/events/held で読み直し、右下の札を出す。
   * 起動の間に画面がつながっていなくても、つながったあとの読み込みで同じ札が出る。
   */
  | { type: 'events.held'; n: number }
  /**
   * できごとで Paused の会話を起こした（#563）。
   * 画面は、その行が Active に入るときに 1 度だけ光らせる。
   * at は起こした時刻。
   */
  | { type: 'session.woken'; id: string; at: number }
  /**
   * エージェントが open_in_hangar で、利用者に会話を見てほしいと求めた。
   * 画面は切り替えず、右下の知らせに「開く」を出す（自動で消える）。
   * sessionId は開く先、deviceId はその会話の PC、fromSessionId は求めた会話（共通の URL から呼ばれたときは null）。
   */
  | { type: 'session.openPrompt'; sessionId: string; deviceId: string; fromSessionId: string | null }
  /** holdMs は info の出している長さ（ミリ秒）。省くと既定の長さ。読み切るのに時間がかかる知らせだけが付ける。 */
  | { type: 'toast'; level: 'info' | 'error'; message: string; holdMs?: number };
