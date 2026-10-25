import type { EventsPageDto, LiveSessionDto, PermissionAskDto, TranscriptEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { QuestionHook } from '../provider/claude-code/hooks/question.ts';
import type { RecordFacts } from '../provider/claude-code/transcript/normalize.ts';

// hangar とエージェント（Claude Code、opencode）の境界の型。
// 境界は 5 つの面（起動、状態、トランスクリプト、許可と質問、システムプロンプトへの追記）を持つ（docs/design.md の「Claude Code に固有の部分」）。
// 面の中で、エージェントによって持つものと持たないものがある口は、任意にしてある（AgentLauncher.newSessionId、AskSource.parseHook など）。

/** エージェントの種類。値は sessions.provider の列に入る値と同じにする（D8）。 */
export type AgentKind = 'claude-code' | 'opencode';

export interface AgentDriver {
  readonly kind: AgentKind;
  /** エージェントに有るものと無いもの。画面の札の出し分けと、RunManager の入口で断るのに使う。 */
  readonly caps: AgentCaps;
  readonly launch: AgentLauncher;
  /** 状態の面。一覧を読む側は、各 driver の写しを束ねた agent/liveHub.ts の LiveHub を通して読む。 */
  readonly live: LiveSource;
  /** トランスクリプトの面。索引に入れる側（発見と見張り）と、読む側（readPage）を持つ。 */
  readonly transcript: TranscriptSource;
  /** 許可と質問の面。Claude は hook の本文を読み、opencode は流してくる。 */
  readonly asks: AskSource;
  /** システムプロンプトへの追記の面。段（InjectionEntry）は hangar の側（launch/injection.ts）が組み、渡し方は driver が決める。 */
  readonly instructions: InstructionChannel;
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

// ---- トランスクリプト ----

/** A5 で、索引に入れる側が渡す束。いまは型だけである。 */
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

/**
 * 本文のファイル 1 つ。providerSessionId の主線か、agentId のサブエージェントの本文である。
 * deviceId は、ほかの PC から降ろした写しならその PC の id で、手元の本文なら null である。
 */
export type TranscriptFile = { path: string; sessionId: string; agentId: string | null; deviceId: string | null };

/** 本文の無い会話の覚え（Claude は history.jsonl）。会話の ID ごとに 1 件である。 */
export type PromptHistoryEntry = { cwd: string; firstTs: number; lastTs: number; firstDisplay: string; count: number };
export type PromptHistory = {
  index: Map<string, PromptHistoryEntry>;
  /** 読んだ中身が変わるたびに増える。呼び手は前に見た値と比べて、変わったときだけ後の処理を回す。 */
  version: number;
};

/**
 * 索引に入れる側が、見張りの知らせを渡す先。hangar の索引（indexer/service.ts）が受ける。
 * いまは仮の形で、本文を読んで正規化するのは索引の側（indexer/indexFile.ts）に残っている。
 * A5 で、driver が IndexBatch を作って渡す形に置き換える。
 */
export type TranscriptSink = {
  /** この本文が変わった。索引の側が集めて、少し待ってから索引化する。 */
  named(file: TranscriptFile): void;
  /** どの本文が変わったか分からない、または見張りが外れた。索引の側が全件の見比べを早めに回す。 */
  rescan(): void;
  /** 本文の無い会話の覚えが変わったかもしれない。 */
  historyChanged(): void;
  /** 見張りを付けられなかった、または見張りが壊れた。 */
  error(path: string, message: string): void;
};

/** 選んだ本文と、索引から外す本文。stats は選ぶのに取った stat で、索引の側が索引化に使い回す（同じファイルを二度 stat しない）。 */
export type TranscriptPick = { index: TranscriptFile[]; drop: TranscriptFile[]; stats: Map<string, { size: number; mtimeMs: number } | null> };

/**
 * 本文をファイルに持つエージェント（Claude）の発見の口。hangar の索引が、全件の見比べと見張りの知らせに合わせて引く。
 * A4 の仮の形で、A5 で IndexBatch の形に寄せるときに見直す。
 */
export interface TranscriptFiles {
  /**
   * 全件を列挙し、同じ位置（主線かサブエージェント）の写しから索引化する 1 つを選ぶ。
   * seen は列挙した全部のパスで、索引の側は、ここに無く手元からも消えた本文を索引から外す。
   * 置き場そのものが見えないとき（外れたなど）は seen を null にし、全部を消させない。
   */
  scan(o: { isYielded?: (providerSessionId: string) => boolean }): TranscriptPick & { seen: Set<string> | null };
  /** 見張りが名指しした本文を、前の scan で見た同じ位置の写しと合わせて選び直す。stat は file の stat。写しが消えていたら lost を真にする。 */
  pick(file: TranscriptFile, stat: { size: number; mtimeMs: number }, o: { isYielded?: (providerSessionId: string) => boolean }): TranscriptPick & { lost: boolean };
  /** 実行中の会話の手元の本文（主線と、いまあるサブエージェント）。 */
  liveFiles(providerSessionId: string, cwd: string): TranscriptFile[];
  /** 本文の無い会話の覚えを読む。変わっていなければ前と同じものを返す。 */
  history(): PromptHistory;
  /** 付いていない見張りを付ける。start の前と stop の後は何もしない。 */
  rewatch(): void;
  /** 見張るべき置き場に、どれも見張りが付いているか。欠けていれば索引の側が全件の見比べを短めの周期で回す。 */
  healthy(): boolean;
  /** 失敗を知らせるときに添える場所。scan は全件の見比べ、history は本文の無い会話の覚えである。 */
  readonly where: { scan: string; history: string };
}

export interface TranscriptSource {
  /** 索引に入れる側。見張りを付け、知らせを sink に渡す。 */
  start(sink: TranscriptSink): void;
  stop(): void;
  /** 読む側。 */
  readPage(db: Db, sessionId: string, opts: ReadOpts): EventsPageDto;
}

/** 本文をファイルに持つエージェントのトランスクリプトの面。いまの索引（indexer/service.ts）は、この形を受ける。 */
export type FileTranscriptSource = TranscriptSource & TranscriptFiles;

// ---- 許可と質問 ----

export type AgentAsk =
  | { kind: 'question'; providerSessionId: string; hook: QuestionHook }
  | { kind: 'permission'; providerSessionId: string; ask: PermissionAskDto };

/**
 * 許可と質問を受け取る口。どちらの口を持つかはエージェントによる。
 * 書くのは hangar の側（sessions/questionHook.ts、sessions/permissionAsks.ts）で、ここは読むだけにする。
 */
export interface AskSource {
  /** hook の HTTP の本文を読む（Claude）。hangar の受け口（mcp/app.ts）が、セッションの provider の driver のものを呼ぶ。読めないものは空にする。 */
  parseHook?(body: unknown): AgentAsk[];
  /** 許可と質問を流してくる（opencode の SSE）。 */
  subscribe?(cb: (a: AgentAsk) => void): () => void;
}

// ---- システムプロンプトへの追記 ----

/**
 * システムプロンプトに足す段の 1 つ。text は末尾の改行まで含み、区切りを足さずにつなげば 1 つの指示になる。
 * 段の組み立ては launch/injection.ts の renderInjectionEntries で、どのエージェントにも同じ形で渡す。
 */
export type InjectionEntry = { key: 'body' | 'handover' | 'multiDevice' | 'status' | 'live'; text: string };

export interface InstructionChannel {
  /** 起動の引数でだけ渡せるか（Claude）、途中でも差し替えられるか。 */
  readonly when: 'launch' | 'live';
  update?(providerSessionId: string, entries: InjectionEntry[]): Promise<void>;
}
