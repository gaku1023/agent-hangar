import type { CloudUsageDto, CompatDto, ConfigPreviewDto, DeviceDto, IndexProgressDto, LaunchResultDto, LiveSessionDto, ReadinessDto, ResumeHereConflictDto, RetentionDto, RetentionPreviewDto, SettingsDto, ShellHookDto, SummarizerTestDto, SyncSkippedDto, TerminalApp, UsageDto } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { Db } from '../db/open.ts';
import type { GetLanguage } from '../i18n/language.ts';
import type { Message } from '../i18n/message.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import type { LiveDigester } from '../live/digest.ts';
import type { MemoStore } from '../projects/memo.ts';
import type { RunManager } from '../runs/manager.ts';
import type { SyncEngine } from '../sync/engine.ts';
import type { AccountsDeps } from './accounts.ts';

/**
 * HTTP の層が外から受け取る依存の一覧。
 * 経路のファイル（routes/*.ts）は、ここから自分が使う項目だけを Pick した狭い型を受け取る。
 * createApp（app.ts）は全部を受け取り、各ファイルへそのまま渡す。
 */

/** RunManager のうち HTTP から触る部分だけ。テストは偽物を渡せる。 */
export type RunsApi = Pick<RunManager, 'start' | 'startFromTerminal' | 'resume' | 'fork' | 'attach' | 'adopt' | 'kill' | 'openTab' | 'closeTab' | 'listAlive' | 'getRun' | 'getTab' | 'attachTarget' | 'jumpToPrompt' | 'leaveTranscript'>;
/** ターミナルとエディタへの受け渡し。設定を読むのは呼び手の役目にして、ここでは結果だけを扱う。 */
export type ExternalApi = {
  openTerminal(o: { tmuxName: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openDirTerminal(o: { dir: string }): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openEditor(o: { target: string }): Promise<void>;
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
/** SyncEngine のうち HTTP から触る部分だけ。 */
export type SyncApi = Pick<SyncEngine, 'status' | 'syncNow' | 'setPaused' | 'onFocus' | 'pullBeforeLaunch'>;
/**
 * Claude Code 設定の同期のうち HTTP から触る部分だけ。
 * ClaudeConfigSync に pull() は無いので、呼び手が applyPull(pendingRemote()) の形に包んで渡す。
 */
export type ConfigSyncApi = { preview(): ConfigPreviewDto; pull(): Promise<{ applied: number; conflicts: number }> };
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
   * 渡さなければ、経路のファイルが作る。
   */
  digester?: Pick<LiveDigester, 'digest'>;
  /** 表の変化に対応しない知らせ（トースト）を渡す先。行のイベントは渡さない。行を書けば、配る層（events/publisher.ts）が配る。 */
  hub: { broadcast(ev: NoticeEvent): void };
  runs: RunsApi;
  external: ExternalApi;
  usage: { current(): UsageDto; ingest(raw: unknown): { usage: UsageDto; usageChanged: boolean; providerSessionId: string | null; accountId: string } | null };
  memos: MemoStore;
  summary: SummaryApi;
  promote: (o: { sessionId: string; name: string; gitInit: boolean; moveFiles: boolean }) => { projectId: string; moved: boolean; reason: string | null; /** reason と同じ理由の、言語を決めていない文。あれば経路がこちらを応答の言語で出す。 */ reasonMessage?: Message | null };
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
  /** 他端末の本文を手元に写してから再開する。写しより手元が小さいときだけ 409 の本体を返す。 */
  resumeHere: (sessionId: string, overwrite: boolean) => LaunchResultDto | ResumeHereConflictDto;
  /** 同期を設定していない端末では null。そのとき設定の経路は 404 を返す。 */
  configSync: ConfigSyncApi | null;
  /** 参加トークン。setup を走らせていない端末では null。全セッションの読み書き権を持つので、ログには出さない。 */
  joinToken: () => string | null;
  devices: () => DeviceDto[];
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
  readiness: () => Promise<ReadinessDto>;
  /**
   * Claude Code との互換（確かめた版、手元の版、記録したずれの一覧）。準備の確かめでずれがあるとき、画面が続けて読む。
   */
  compat: () => Promise<CompatDto>;
  /** UI の dist。null なら UI を配らない（試験と、dist を持たない組み立て）。 */
  uiDist: string | null;
};
