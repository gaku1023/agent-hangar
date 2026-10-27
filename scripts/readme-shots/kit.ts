// 場面の書き方の型。場面のファイル（scenes/<名前>.ts）はここの型だけを読めばよい。
import type { Locator, Page } from 'playwright';
import type { Env } from './env.ts';

export type Project = { dir: string; name: string };

/** 過去の会話。turns は [ユーザーの発言, [[ツール名, 入力, 結果]...], 返答] の並び。 */
export type PastSession = {
  project: string;
  title: string;
  minutesAgo: number;
  state?: 'active' | 'paused' | 'done' | 'archived' | null;
  note?: string;
  turns: [string, [string, Record<string, unknown>, string][], string][];
};

/** 生きた会話の台本の 1 行。形は fake-claude.mjs が読む。gate は撮影側の合図を待つ行。 */
export type LiveStep = {
  gate?: string;
  /** 端末に打たれた 1 行（Enter まで）を待って、発言として記録する。 */
  typed?: boolean;
  ms?: number;
  user?: string;
  say?: string;
  intent?: string;
  tool?: string;
  arg?: string;
  input?: Record<string, unknown>;
  out?: string[];
  lineMs?: number;
  summary?: string;
  diff?: [string, number, string][];
  final?: boolean;
  /** 許可の問いを出し、1 か Enter（許可）・2（そのまま許可）・3（断る）が打たれるまで waiting で止まる。hangar へは PermissionRequest の hook と同じ本文を送る。 */
  ask?: { tool: string; input: string; description?: string; question?: string; always?: string };
  /** hangar の MCP の道具を呼ぶ。args の '@todo:<文言>' は、その文言の TODO の id になる。 */
  mcp?: { tool: string; args?: Record<string, unknown> };
};
export type LiveScript = { project: string; name: string; steps: LiveStep[] };

/** API の応答の差し替え。match は pathname（/api/usage など）。json は値か、要求を受ける関数。 */
export type ApiMock = {
  match: string | RegExp | ((pathname: string, method: string) => boolean);
  json: unknown | ((req: { url: string; method: string; body: string | null }) => unknown);
  status?: number;
};

/** setup(seed) で受け取る、見本のデータの差し込み口。 */
export type Seed = {
  /** 見本のプロジェクトを足す（dir はワークスペース直下のフォルダ名）。 */
  project(p: Project): void;
  /** 過去の会話を足す。title は全場面で重ならない名前にする。 */
  past(s: PastSession): void;
  /** 生きた会話を足す。key は shoot で ctx.live[key]。name は偽の claude が台本を選ぶ鍵なので、全場面で重ならない名前にする。 */
  live(key: string, script: LiveScript): void;
  /** この場面のページで API の応答を差し替える。 */
  mock(m: ApiMock): void;
};

export type OpenOpts = {
  /** この場面のページだけ API の応答を差し替える。 */
  mocks?: ApiMock[];
  /** ページが開く前に走らせる JS（localStorage の用意など）。 */
  init?: string;
  /** ホームが出たあと、撮り始める前の用意。 */
  prepare?: (page: Page) => Promise<void>;
  /** 画面の大きさ（CSS px）。既定は 1280×800。PC とスマホを横に並べる場面など、広い面が要るときに指定する。 */
  viewport?: { width: number; height: number };
  /** 最初に開く URL。指定すると hangar のホームを待たない（自分で並べた撮影用のページを開くとき）。 */
  url?: string;
  /** hangar の画面を iframe に入れられるようにする（X-Frame-Options と CSP の frame-ancestors を外す）。 */
  frameable?: boolean;
};

export type Recorder = {
  /** 撮り終えて docs/images/<name>.webp に書く。最後のコマで holdMs 止める（既定 1500）。 */
  save(name: string, opts?: { holdMs?: number }): Promise<string>;
};

export type ShootCtx = {
  e: Env;
  /** seed.live() の key から、生きた会話の id。 */
  live: Record<string, string>;
  /** プロジェクトの dir から id。 */
  projectIds: Record<string, string>;
  /** 過去の会話の title から id。 */
  pastIds: Record<string, string>;
  openPage(opts?: OpenOpts): Promise<{ page: Page; close(): Promise<void> }>;
  /** コマを集め始める。 */
  record(page: Page): Promise<Recorder>;
  /** 静止画（DPR 2 の PNG）を docs/images/<name>.png に撮る。 */
  screenshot(page: Page, name: string): Promise<string>;
  /** サイドバー（x が 230 より左）にある、その文字を含む項目。 */
  sidebarItem(page: Page, text: string): Promise<Locator>;
  sleep(ms: number): Promise<void>;
  until(what: string, fn: () => boolean, ms?: number): Promise<void>;
  /** 偽の claude の gate 行を開ける。 */
  gate(name: string): void;
  /** 会話の記録のどこかにこの文字が出たら true になる関数。 */
  transcriptHas(text: string): () => boolean;
};

export type Scene = {
  /** --only で選ぶ名前。ファイル名と同じにする。 */
  name: string;
  kind: 'motion' | 'still';
  /**
   * この場面の画面に関係するファイル（リポジトリからの相対パスか glob。ディレクトリは下を全部含む。試験のファイルは数えない）。
   * 変わると `--stale` がこの場面を古いと言う。styles、primitives、ヘッダー、サイドバーなど全場面に効くものは stale.ts の COMMON_WATCH にあるので書かない。
   */
  watch: string[];
  /** 見本のデータを足す。場面ごとに環境を作り直し、共通の見本にこの分だけを足す。 */
  setup?(seed: Seed): void;
  shoot(ctx: ShootCtx): Promise<void>;
};
