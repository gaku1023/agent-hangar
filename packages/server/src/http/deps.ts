import type { NodeCheck } from '../config/node.ts';
import type { CloudDevicesDto, CloudUsageDto, CompatDto, DeviceDto, DeviceOut, EditorsDto, EditorTestDto, KnownEditorId, IndexProgressDto, LaunchResultDto, LiveSessionDto, OpencodeOptionsDto, OpencodeStatusDto, ReadinessDto, ResumeHereConflictDto, ResumeHereReplaceDto, RetentionDto, RetentionPreviewDto, SettingsDto, ShellHookDto, SummarizerTestDto, SyncSkippedDto, TerminalApp, UsageDto } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { Db } from '../db/open.ts';
import type { GetLanguage } from '../i18n/language.ts';
import type { Message } from '../i18n/message.ts';
import type { AsksOf } from '../mcp/app.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import type { LiveDigester } from '../live/digest.ts';
import type { CandidateEnv } from '../projects/candidates.ts';
import type { MemoStore } from '../projects/memo.ts';
import type { PermissionAsks } from '../sessions/permissionAsks.ts';
import type { OsNoticeFeed } from '../sessions/stopNotices.ts';
import type { SessionTrash } from '../sessions/trash.ts';
import type { RunManager } from '../runs/manager.ts';
import type { MobileLink } from '../mobile/pairer.ts';
import type { ConfigSyncService } from '../sync/config/service.ts';
import type { SyncEngine } from '../sync/engine.ts';
import type { JoinApprover } from '../sync/joinApprover.ts';
import type { RecoveryKeyReissuer } from '../sync/recoveryReissue.ts';
import type { TakeoverService } from '../sync/takeover.ts';
import type { AccountsDeps } from './accounts.ts';
import type { GitService } from '../git/service.ts';
import type { OpencodeProvidersService } from '../provider/opencode/integration.ts';

/**
 * HTTP の層が外から受け取る依存の一覧。
 * 経路のファイル（routes/*.ts）は、ここから自分が使う項目だけを Pick した狭い型を受け取る。
 * createApp（app.ts）は全部を受け取り、各ファイルへそのまま渡す。
 */

/** RunManager のうち HTTP から触る部分だけ。テストは偽物を渡せる。 */
export type RunsApi = Pick<RunManager, 'start' | 'startFromTerminal' | 'startOpencodeFromTerminal' | 'resume' | 'resumeWith' | 'fork' | 'attach' | 'adopt' | 'kill' | 'openTab' | 'closeTab' | 'listAlive' | 'getRun' | 'getTab' | 'attachTarget' | 'jumpToPrompt' | 'leaveTranscript' | 'assertCanStart'>;
/** git の表示（git/service.ts）のうち HTTP から触る部分だけ。 */
export type GitApi = Pick<GitService, 'sessions' | 'changes' | 'diff' | 'edits' | 'project'>;
/** ターミナルとエディタへの受け渡し。設定を読むのは呼び手の役目にして、ここでは結果だけを扱う。 */
export type ExternalApi = {
  /** title は Windows のタブや窓の題名（セッション名）。省くと tmux の名前になる。 */
  openTerminal(o: { tmuxName: string; title?: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openDirTerminal(o: { dir: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  /**
   * 設定のエディタで開く。line はファイルの行（変更したファイルと差分から）。once は「今回は <名前> で開く」で、設定を変えずにそのエディタで開く。
   * sessionId は、ターミナルの中のエディタをそのセッションのシェルタブで開くのに使う。
   */
  openEditor(o: { target: string; line?: number | null; once?: KnownEditorId; sessionId?: string }): Promise<void>;
  /** この PC で見つけたエディタと、選んでいるエディタの状態。 */
  editors(): Promise<EditorsDto>;
  /** 見本のファイルを書いて 3 行目を開く（設定の「テスト」）。 */
  testEditor(): Promise<EditorTestDto>;
  /** 既定のブラウザで URL を開く。アーティファクトの「開く」で使う。 */
  openUrl(url: string): Promise<void>;
};
/**
 * 要約の受け付け方。
 * force は条件をすべて飛ばす（手動の作り直し）。
 * ignoreLive はレジストリの生存判定だけを飛ばす。土台かどうかと 5 ターンの判定は残る。
 */
export type SummaryEnqueueOpts = { force?: boolean; ignoreLive?: boolean };
/** SummaryJob のうち HTTP から触る部分だけ。 */
export type SummaryApi = { enqueue(sessionId: string, opts?: SummaryEnqueueOpts): boolean; pending(): string[]; test(): Promise<SummarizerTestDto>; listModels(): Promise<string[]> };
/** JoinApprover のうち HTTP から触る部分だけ。 */
export type JoinApproverApi = Pick<JoinApprover, 'state' | 'issue' | 'approve' | 'reject' | 'cancel'>;
/** リカバリーキーの再発行のうち HTTP から触る部分だけ。 */
export type RecoveryKeyApi = Pick<RecoveryKeyReissuer, 'reissue' | 'confirm'>;
/** SyncEngine のうち HTTP から触る部分だけ。 */
export type SyncApi = Pick<SyncEngine, 'status' | 'syncNow' | 'setPaused' | 'onFocus' | 'pullBeforeLaunch'>;
/**
 * 設定の同期（sync/config/）のうち HTTP から触る部分だけ。
 * 読む操作と、hangar の置き場の適用の指示書を書く操作だけで、~/.claude に書く操作（適用、競合の採り直し、世代へ戻す）は持たない。
 * それは指示書を読む殻の命令と hangar config apply の役目である（D9）。
 */
export type ConfigBundleApi = Pick<ConfigSyncService, 'dto' | 'outgoing' | 'inbox' | 'conflicts' | 'unsent' | 'sendUnsent' | 'backups' | 'putApplyOrder' | 'applyOrder' | 'deleteApplyOrder'>;
/**
 * いまの言語を返す関数。経路のファイルは、これを受け取って文を引く。
 * createApp が AppDeps の language を、どの経路にも渡す。
 */
export type LanguageDeps = { language: GetLanguage };
export type AppDeps = {
  /** 応答の文の言語。組み立てる側が、設定を読む関数を 1 つ作り、起動の管理や要約と同じものを渡す。 */
  language: GetLanguage;
  db: Db; deviceId: string; deviceName: string; token: string; home: string; port: number; version: string;
  settings: () => Settings; updateSettings: (patch: Partial<SettingsDto>) => Settings;
  live: () => LiveSessionDto[];
  indexer: { progress(): IndexProgressDto; rebuild(): Promise<void> };
  /**
   * 起動の手続き（最初の索引づけと、セッションの紐づけ）が済んだか。
   * 待ち受けは先に始まるので、/health が返っても済んでいるとは限らない。
   * .app はこれが真になるまで起動画面に残る。
   */
  ready: () => boolean;
  /**
   * 右ペインの要約器。裏の印（live/aside.ts）が 500 ミリ秒ごとに同じ要約を引くので、サーバは 1 つを両方に渡して覚えを共有する。
   * 渡さなければ、ここで作る。
   */
  digester?: Pick<LiveDigester, 'digest'>;
  /** hook から届いた許可の確認の預け先（sessions/permissionAsks.ts）。登録の読み直しが許可待ちの札の中身として足す。無ければ預けない。 */
  permissionAsks?: Pick<PermissionAsks, 'put'>;
  /** hook の受け口（/mcp/s/<id>/hook）が本文を読む口。sessions.provider の値から driver の許可と質問の面を返す。無ければ hook の本文は読まない。 */
  asksOf?: AsksOf;
  /** デスクトップ通知の並び（sessions/stopNotices.ts）。殻が `GET /api/notify/feed` で読む。無ければ経路を持たない。 */
  osNotices?: Pick<OsNoticeFeed, 'wait'>;
  /** 表の変化に対応しない知らせ（トースト）を渡す先。行のイベントは渡さない。行を書けば、配る層（events/publisher.ts）が配る。 */
  hub: { broadcast(ev: NoticeEvent): void };
  runs: RunsApi;
  external: ExternalApi;
  /** git の表示。渡さなければ、ここで作る（試験は実物の git を使う）。組み立てる側は、本文の伸びで読み直す同じものを渡す。 */
  git?: GitApi;
  usage: { current(): UsageDto; ingest(raw: unknown): { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null; accountId: string } | null };
  memos: MemoStore;
  summary: SummaryApi;
  /** セッションの削除（sessions/trash.ts）。本文を OS のゴミ箱へ移し、削除の印を書く。 */
  trash: Pick<SessionTrash, 'deleteSession'>;
  promote: (o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean; parent?: string }) => { projectId: string; moved: boolean; reason: string | null; /** reason と同じ理由の、言語を決めていない文。あれば経路がこちらを応答の言語で出す。 */ reasonMessage?: Message | null };
  /**
   * Claude Code と会話したフォルダの候補を探すときの、ホームと一時フォルダの差し替え（projects/candidates.ts）。
   * 試験だけが渡す。省けば、利用者のホームと OS の一時フォルダを使う。
   * homeDir は、POST /api/workspace/trust がホームとその上を断るときのホームにも使う。
   */
  candidateEnv?: Partial<Pick<CandidateEnv, 'homeDir' | 'tmpDirs'>>;
  /**
   * 作業フォルダのフォルダの信頼を、登録したアカウントの全部の .claude.json に書く（projects/folderTrust.ts の trustWorkspaceFolders）。
   * dryRun なら書かずに、書くものを返す。渡さなければ POST /api/workspace/trust は断る。
   */
  trustWorkspace?: (root: string, dryRun: boolean) => import('@agent-hangar/shared').WorkspaceTrustDto;
  /**
   * 同梱のセットアップのすゝめの md があるフォルダ（setupGuide/guide.ts）。
   * 試験だけが渡す（null は同梱物が無い形）。省けば、配布物の隣とリポジトリの docs から探す。
   */
  setupGuideDir?: string | null;
  /** 新しいフォルダの git init。試験では差し替えて git を呼ばない。省けば git init を実行する（boot/http.ts は渡さない）。 */
  gitInit?: (dir: string) => void;
  sync: SyncApi;
  /** 設定の「使用量と費用」。同期を設定していない端末では current() が null を返す。 */
  cloudUsage: { current(): CloudUsageDto | null; refresh(): Promise<CloudUsageDto | null> };
  /** アカウントの一覧と切り替え。組み立てる側（boot/runs.ts）が 1 か所で作り、起動後の認証の読み直しにも同じものを使う。 */
  accounts: AccountsDeps;
  /** 降ろすのを諦めた項目。RemotePuller.skippedEntries() をそのまま載せる。 */
  syncSkipped: () => SyncSkippedDto[];
  /**
   * 取り残しの掃除（sweep）が、あと何件残しているか。
   * 数えられるのは TranscriptUploader だけなので、同期を設定していない端末では null を返す。
   * null は「数えられない」で、0 件（追いついた）と区別する。
   */
  syncSweep: () => number | null;
  /** 一時停止のまま頼まれた 1 巡の最中か。 */
  syncOncePass: () => boolean;
  /** 「この PC で再開」の頼む側（sync/takeover.ts）。ほかの PC で動く会話を止めてもらい、最後の本文が降りるのを待つ。 */
  takeover: Pick<TakeoverService, 'start' | 'extend' | 'cancel' | 'get' | 'forcedWithoutRow'>;
  /** 他端末の本文を手元に写してから再開する。写しより手元が小さいときだけ 409 の本体を返す。 */
  resumeHere: (sessionId: string, overwrite: boolean) => LaunchResultDto | ResumeHereConflictDto;
  /**
   * 「この PC で再開」の確認に出す、手元のトランスクリプトを置き換えるか（sync/copy.ts の compareForResume）。
   * 渡さなければ置き換えないものとして null を返す（試験の世界）。
   */
  resumeHereReplace?: (sessionId: string) => ResumeHereReplaceDto | null;
  /** 設定の同期。同期を設定していない端末では null で、/config-sync/* は 404 を返す。既定は切。 */
  configBundle: ConfigBundleApi | null;
  /**
   * 参加コードを発行した PC の承認（sync/joinApprover.ts）。同期を設定していない端末では null で、/sync/join-codes/* は 404 を返す。
   * 参加コードの平文はこの中のメモリにだけあり、応答には載るが、ログには出さない。
   */
  joinApprover: () => JoinApproverApi | null;
  /**
   * リカバリーキーの再発行（sync/recoveryReissue.ts）。同期を設定していない端末では null で、/sync/recovery-key/* は 404 を返す。
   * 新しい鍵ペアはこの中のメモリにだけあり、再発行の応答には載るが、ログには出さない。
   */
  recoveryKey: () => RecoveryKeyApi | null;
  devices: () => DeviceDto[];
  /**
   * 設定のクラウド同期の節の PC の一覧。Worker の devices を取りに行く（sync/devices.ts）。
   * 参加と参加の解除は、殻の命令と CLI だけが行い、HTTP の経路は持たない。
   */
  cloudDevices: () => Promise<CloudDevicesDto>;
  /**
   * 他の端末の解除（sync/rotate.ts の revokeMember）。PC なら世代を回す。同期を設定していない端末では null で、経路は 404 を返す。
   * 世代鍵と回しの途中の記録は動いているサーバーにあるので、殻の命令（CLI の hangar cloud revoke）もこの経路を呼ぶ。
   * 渡さなければ null として読む（試験の世界）。
   */
  cloudRevoke?: () => ((id: string) => Promise<DeviceOut>) | null;
  /**
   * スマホを接続する QR を作るための、今の client と Worker の URL とスマホの接続の PC 側（boot/sync.ts の mobileLink）。同期を設定していなければ null。
   * QR に鍵は入れない。券を pairer に渡し、接続してきたスマホの公開鍵にスマホ用の鍵を封じて置く。渡さなければ null として読む（試験の世界）。
   */
  mobileLink?: () => MobileLink | null;
  /**
   * 外のターミナルで起動した claude を hangar で開けるようにする包み方の、この PC の状態。
   * 読むだけで、~/.zshrc を書き換える経路は持たない。書き換えるのは hangar shell install（CLI）だけである。
   */
  shellHook: () => ShellHookDto;
  /** Claude Code の保持期間。書き込みは cleanupPeriodDays の 1 か所だけで、原則「読み取り専用」の 4 つめの例外である。 */
  retention: { current(): RetentionDto; preview(days: number): RetentionPreviewDto; write(days: number, baseSha256: string): RetentionDto };
  /**
   * 準備の確かめ（ツールのパスと版、ワークスペース、MCP の登録、statusline の追記）。
   * 設定画面の検証と、空のホームの確認リストが同じものを読む。読むだけで、何も書き換えない。
   */
  /**
   * 設定の「Node のパス」を保存する前の確かめ（同梱のサーバと同じメジャー版とアーキか）。
   * 渡さなければ、同梱の manifest.json を読む既定のもの（config/node.ts の createNodeCheck）を使う。
   */
  nodeCheck?: NodeCheck;
  readiness: () => Promise<ReadinessDto>;
  /**
   * tmux の役の道具（Windows は psmux）を PATH と既知の置き場から探す。「再確認」（POST /api/readiness/mux）が使う。
   * 試験は子プロセスもファイルも見ない偽物を渡す。
   */
  findMux: () => string | null;
  /**
   * Claude Code との互換（確かめた版、手元の版、記録したずれの一覧）。準備の確かめでずれがあるとき、画面が続けて読む。
   */
  compat: () => Promise<CompatDto>;
  /**
   * opencode の検出（ベータ）。PATH と既知の置き場から探し、版を空の環境の `--version` で読み、確かめた範囲と突き合わせる。
   * 試験は子プロセスを起こさない偽物を渡す。
   */
  opencodeStatus: () => Promise<OpencodeStatusDto>;
  /**
   * 新しいセッションで opencode を選んだときのモードとモデル（provider/opencode/options.ts）。dir はその場所で、null はホーム。
   * 起きている serve に聞き、無ければ 1 本起こして聞く。取れなければ投げる（手元に前の一覧があれば stale で返す）。
   * refresh は、手元の一覧が新しくても取り直すこと（モデルの小窓の LM Studio の「再読み込み」）。
   */
  opencodeOptions: (dir: string | null, o?: { refresh?: boolean }) => Promise<OpencodeOptionsDto>;
  /**
   * 設定の「連携 › opencode › プロバイダー」（provider/opencode/integration.ts）。
   * API キーは opencode の integration に渡すだけで、応答にもログにも載せない。試験は opencode を起こさない偽物を渡す。
   */
  opencodeProviders: Pick<OpencodeProvidersService, 'list' | 'connectKey' | 'disconnect' | 'addModel' | 'addCustom' | 'login' | 'loginStatus' | 'loginComplete' | 'loginCancel'>;
  /**
   * 同じファイルの編集の見張り（sessions/overlap.ts）に、すぐ読み直させる。「このファイルでは表示しない」の後に呼ぶ。
   * 渡さなければ、次の周期（数秒）で消える。
   */
  overlapRefresh?: () => void;
  /** UI の dist。null なら UI を配らない（試験と、dist を持たない組み立て）。 */
  uiDist: string | null;
};
