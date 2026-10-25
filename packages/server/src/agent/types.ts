import type { EventsPageDto, LiveSessionDto, PermissionAskDto, TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { QuestionHook } from '../provider/claude-code/hooks/question.ts';
import type { RecordFacts } from '../provider/claude-code/transcript/normalize.ts';

// hangar とエージェント（Claude Code、opencode）の境界の型。
// 境界は 5 つの面（起動、状態、トランスクリプト、許可と質問、システムプロンプトへの追記）を持つ。
// いま driver が実装しているのは起動と状態の面で、残りの面は型を置いただけである（docs/design.md の「Claude Code に固有の部分」）。
// 実装した面から、任意の印を外していく。

/** エージェントの種類。値は sessions.provider の列に入る値と同じにする（D8）。 */
export type AgentKind = 'claude-code' | 'opencode';

export interface AgentDriver {
  readonly kind: AgentKind;
  /** エージェントに有るものと無いもの。画面の札の出し分けと、RunManager の入口で断るのに使う。 */
  readonly caps: AgentCaps;
  readonly launch: AgentLauncher;
  /** 状態の面。一覧を読む側は、各 driver の写しを束ねた agent/liveHub.ts の LiveHub を通して読む。 */
  readonly live: LiveSource;
  /** トランスクリプトの面。まだ境界を通していない。 */
  readonly transcript?: TranscriptSource;
  /** 許可と質問の面。まだ境界を通していない。 */
  readonly asks?: AskSource;
  /** システムプロンプトへの追記の面。まだ境界を通していない。 */
  readonly instructions?: InstructionChannel;
}

export type AgentCaps = {
  accounts: boolean;
  effort: boolean;
  permissionMode: boolean;
  remoteControl: boolean;
  fork: boolean;
  attachExternal: boolean;
};

// ---- 起動 ----

/** 起こすものの指定。どのエージェントにも通じる形で渡し、引数や設定への書き方は driver が決める。 */
export type LaunchSpec = {
  cwd: string;
  name?: string;
  prompt?: string;
  model?: string;
  /** 権限のモード。Claude は --permission-mode、opencode は build か plan。 */
  mode?: string;
  autoApprove?: boolean;
  effort?: string;
  worktree?: string;
  addDirs?: string[];
  /** システムプロンプトに足す段。driver が順につなぐ。 */
  instructions: InjectionEntry[];
  /** hangar の MCP の URL と、この run だけの秘密。ファイルに書くか設定の headers にするかは driver が決める。 */
  mcp: { url: string; secret: string };
  hangarSessionId: string;
  /** hangar が起こすものに渡す環境（アカウントの置き場と、利用者がターミナルで付けた変数）。外す変数を決めるのに driver が読む。 */
  env: Record<string, string>;
  /** Remote Control の名前。Claude だけが読み、ほかのエージェントは捨てる。null と未指定は付けない。 */
  remoteControl?: string | null;
};

export type SessionMode =
  | { kind: 'start'; id: string }
  | { kind: 'resume'; id: string }
  | { kind: 'fork'; id: string; newId: string };

export type LaunchPlan = {
  /** tmux の中で起こすもの。 */
  argv: string[];
  /** hangar の環境に driver が足す変数。 */
  env: Record<string, string>;
  /** 起こすものへ持ち込まない変数の名前（tmux サーバの環境に残っていても外す）。 */
  unset: readonly string[];
  watchRemoteUrl?: boolean;
};

export interface AgentLauncher {
  /** ID を先に決められる driver だけが持つ。Claude は UUID を作る。 */
  newSessionId?(): string;
  /** 起こす前の下ごしらえ。ID を後で知る driver は、ここで providerSessionId を返す。Claude は持たない。 */
  materialize?(mode: SessionMode, spec: LaunchSpec): Promise<void | { providerSessionId: string }>;
  plan(bin: string, mode: SessionMode, spec: LaunchSpec): LaunchPlan;
  /** run が終わるとき、または止めたいときに呼ぶ。止めにいったら true を返す。 */
  release(target: { providerSessionId: string; cwd: string }, cause: 'killed' | 'parked' | 'tui-gone'): boolean | Promise<boolean>;
}

// ---- 状態 ----

/**
 * エージェントの実行中の一覧の写し。push 型（SSE）も pull 型（ファイルの読み直し）も、手元の写しと、変わったときの知らせにそろえる。
 * 写しは読み直しのたびに LiveHub.enrich を通してから、変わったかを見る（liveHub.ts）。
 */
export interface LiveSource {
  start(): void;
  stop(): void;
  /** いつでも手元の最新の写しを返す。 */
  current(): LiveSessionDto[];
  onChange(cb: (live: LiveSessionDto[]) => void): () => void;
  /** 次の読み直しを delayMs 後へ繰り上げる。 */
  kick(delayMs: number): void;
  /** そのセッションが、その pid で動いているか。RunManager が、一覧から消えた run を閉じてよいかを決めるのに使う。 */
  isRunning(providerSessionId: string, pid: number): boolean;
}

// ---- トランスクリプト（型だけ） ----

export type IndexBatch = {
  providerSessionId: string;
  agentId: string | null;
  cwd?: string;
  records: {
    events: TranscriptEvent[];
    facts: RecordFacts;
    locator: { kind: 'file'; path: string; offset: number; length: number } | { kind: 'stored' };
  }[];
};

export type ReadOpts = { fromSeq?: number; limit?: number; agentId?: string | null; latest?: boolean; beforeSeq?: number };

export interface TranscriptSource {
  /** 索引に入れる側。 */
  start(sink: (b: IndexBatch) => void): void;
  stop(): void;
  /** 読む側。 */
  readPage(db: Db, sessionId: string, opts: ReadOpts): EventsPageDto;
}

// ---- 許可と質問（型だけ） ----

export type AgentAsk =
  | { kind: 'question'; providerSessionId: string; hook: QuestionHook }
  | { kind: 'permission'; providerSessionId: string; ask: PermissionAskDto };

export interface AskSource {
  /** hook の HTTP の本文を読む。 */
  parseHook?(body: unknown): AgentAsk[];
  /** 許可と質問を流してくる。 */
  subscribe?(cb: (a: AgentAsk) => void): () => void;
}

// ---- システムプロンプトへの追記 ----

export type InjectionEntry = { key: 'body' | 'handover' | 'multiDevice' | 'status' | 'live'; text: string };

export interface InstructionChannel {
  /** 起動の引数でだけ渡せるか、途中でも差し替えられるか。 */
  readonly when: 'launch' | 'live';
  update?(providerSessionId: string, entries: InjectionEntry[]): Promise<void>;
}
