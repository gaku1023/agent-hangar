import type { AgentKind, LiveStatus, PeerChatCommand, PeerChatFile, PermissionAskDto, PeerKeyring, ServerEvent, SessionActivityDto, WaitKind } from '@agent-hangar/shared';
import type { HookDecisions } from '../../sessions/hookDecisions.ts';
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
  /** 本体は入力を受け付けていて、裏の作業（シェル、サブエージェント）だけが動いている（登録の aside）。預かりは止まっているときと同じに渡す。 */
  aside: boolean;
  waitingFor: WaitKind | null;
  permission: PermissionAskDto | null;
  activity: SessionActivityDto | null;
  /** files の探す根。 */
  cwd: string;
  /**
   * この PC の手元が、いまの会話の持ち主でないことの印。
   * どれかが真なら、この PC の写しは古いか、ここで動かしてはならない。
   * send、answer、interrupt、cancel、tail、files は session-unknown、resume-send と switch-account は resume-failed で断る。
   * lock：ほかの PC で動いている。
   * newerElsewhere：ほかの PC に、この PC より新しい続きがある。
   * remoteOnly：この PC に本文が無い。
   * takenOver：ほかの PC に引き継がれた。
   */
  lock: boolean;
  newerElsewhere: boolean;
  remoteOnly: boolean;
  takenOver: boolean;
};

/**
 * run の画面。
 * 色付きの取り込み（入力欄が空かの判定）も持つ。
 */
export type HostPane = AnswerPane & { captureStyled(): Promise<string | null> };

/** 頼みの送り主の種類。pc はほかの PC（呼び鈴の chat の枠）、phone はスマホ（呼び鈴の phone-chat の枠、mobile/chatHost.ts）。 */
export type PeerChatSenderKind = 'pc' | 'phone';

/**
 * 開けた頼みの送り主。
 * id は Worker が端末トークンで知る ID で、頼みの中身では名乗れない。
 * name を省けば deps.deviceName で引く。
 */
export type PeerChatSender = { id: string; kind: PeerChatSenderKind; name?: string };

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
   * 送り主の種類ごとの入り切り。
   * pc は設定 peerChatAcceptFromPeers（peerChatAcceptOf）、phone は設定 phoneChatAccept（phoneChatAcceptOf）を読む。
   * 偽なら、その種類の送り主の送る系の頼み（send、answer、interrupt、resume-send、rush、switch-account）を断り、預かっていた文は渡さずに捨てる。
   * cancel は断らない（預けた文を取り戻すだけ）。
   * 読む系（tail、files）は通す。
   */
  acceptFrom(kind: PeerChatSenderKind): boolean;
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
   * 会話を、この PC の同じ名前のアカウントで再開し直す（switch-account。動いていれば止めてから。RunManager.switchAccount と同じ道）。
   * 名前のアカウントが無いかログインしていなければ account-unavailable、付け替えに失敗すれば resume-failed。
   * この PC の既定のアカウントは変えない（頼んだのはほかの PC の人である）。
   * 無い組み立てでは resume-failed で断る。
   */
  switchAccount?(sessionId: string, accountName: string): Promise<'ok' | 'account-unavailable' | 'resume-failed'>;
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
   * `/` の候補（新しいセッションの欄と同じ一覧、listPromptCommands）。root は会話の場所で、無ければ自分のとプラグインと組み込みだけ。
   * 数とバイト数の上限での切り詰めは host が行う。
   */
  commands(root: string | null): PeerChatCommand[];
  /**
   * 画面への知らせ。
   * 省けば配らない。
   */
  emit?(ev: PeerChatHostEvent): void;
  /**
   * PermissionRequest の hook の待ちの表（sessions/hookDecisions.ts）。
   * あれば、札への答えは、待ちがあり hook で言えるとき（hookAnswer.ts）に、画面にキーを打たずにここへ決める。
   */
  hookDecisions?: Pick<HookDecisions, 'decide' | 'isDelivered' | 'withdraw' | 'peek'>;
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
