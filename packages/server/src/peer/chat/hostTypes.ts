import type { AgentKind, LiveStatus, PeerChatFile, PermissionAskDto, PeerKeyring, ServerEvent, SessionActivityDto, WaitKind } from '@agent-hangar/shared';
import type { AnswerPane } from './answer.ts';
import type { TailDeps } from './tail.ts';

/** ほかの PC に見せる会話の素性（元の PC の登録と索引から、呼び出し側が組む）。 */
export type HostSession = {
  provider: AgentKind;
  /**
   * 登録の状態。
   * 動いていなければ null。
   */
  live: LiveStatus | null;
  waitingFor: WaitKind | null;
  permission: PermissionAskDto | null;
  activity: SessionActivityDto | null;
  /** files の探す根。 */
  cwd: string;
};

/**
 * run の画面。
 * 色付きの取り込み（入力欄が空かの判定）も持つ。
 */
export type HostPane = AnswerPane & { captureStyled(): Promise<string | null> };

/** サーバから画面へ配る知らせ（T8 が受ける）。 */
export type PeerChatHostEvent = Extract<ServerEvent, { type: 'peerChat.queue' | 'peerChat.delivered' }>;

/**
 * PeerChatHost の外の世界。
 * DB、画面、run、時計、呼び鈴は全部ここから入れる（試験は偽物を渡す）。
 * 会話の鍵は sessionId で、預かりも答えの順番も sessionId ごとに持つ（再開で run が替わっても続く）。
 */
export type PeerChatHostDeps = {
  /** この PC の端末 ID（封の宛先）。 */
  deviceId: string;
  now(): number;
  /**
   * 長いポーリングの待ち。
   * 既定は setTimeout。
   */
  sleep?(ms: number): Promise<void>;
  /**
   * PC どうしの鍵の束。
   * 無ければ（同期していない）null で、頼みを開けない。
   */
  ring(): Promise<PeerKeyring | null>;
  /**
   * 設定 peerChatAcceptFromPeers（peerChatAcceptOf）。
   * 偽なら送る系の頼み（send、answer、interrupt、resume-send、cancel）を断る。
   * 読む系（tail、files）は通す。
   */
  acceptFromPeers(): boolean;
  /**
   * 端末の名前。
   * 「Mac で許可」の札に使う。
   * 知らない ID は ID の先頭を返してよい。
   */
  deviceName(deviceId: string): string;
  /**
   * 会話の素性。
   * この PC に無ければ null。
   */
  session(sessionId: string): HostSession | null;
  /**
   * この PC で動いている run（tmux の名前）。
   * 無ければ null。
   */
  run(sessionId: string): { tmuxName: string } | null;
  pane(tmuxName: string): HostPane | null;
  /**
   * 本文（jsonl）の手がかりと解析の覚え。
   * 許可と質問の札は host が画面から組んで渡す。
   */
  readTranscript: TailDeps['readTranscript'];
  cache?: TailDeps['cache'];
  /**
   * 入力欄へ貼って確定する。
   * 道は RunManager.sendInput と同じで、掃除と、wait_for_session のための印は呼び出し側がする。
   */
  sendInput(sessionId: string, tmuxName: string, text: string): Promise<void>;
  /**
   * 止まった会話を、画面の再開と同じ道（RunManager.resumeWith）で起こす。
   * 投げれば resume-failed。
   */
  resume(sessionId: string): Promise<unknown>;
  /**
   * 頼み主が置いた画像の封（GET /peer/blobs/:askId/:n?from=）。
   * 取れなければ投げる。
   */
  fetchBlob(askId: string, from: string, n: number): Promise<Uint8Array>;
  /** 画像を置く場所（PC の指示欄の添付と同じ drops）。 */
  dropsDir: string;
  /** `@` の候補（スマホの files と同じ本体、mobile/asks.ts の listFilesIn）。 */
  files(root: string, query: string): Promise<PeerChatFile[]>;
  /**
   * 画面への知らせ。
   * 省けば配らない。
   */
  emit?(ev: PeerChatHostEvent): void;
  newId?(): string;
  /** 預かりの時計（試験で縮める）。 */
  queue?: { pollMs?: number; expireMs?: number; settleMs?: number };
  /**
   * resume-send で、再開した画面が使えるのを待つ長さ。
   * 既定は RESUME_READY_MS。
   */
  resumeWaitMs?: number;
  /**
   * 長いポーリングが、知らせが無くても確かめ直す間隔。
   * 既定は RECHECK_MS。
   */
  recheckMs?: number;
};
