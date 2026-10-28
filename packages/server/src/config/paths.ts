import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCodexInjection, type CodexInjection, DEFAULT_AUTO_DONE_IDLE_DAYS, DEFAULT_EDITOR, DEFAULT_SUMMARY_CLAUDE_MODEL, defaultTerminalApp, editorSettingOf, isAutoDoneIdleDays, isIdleUnload, isLanguage, isLocalContext, isModelName, isOpencodeInjection, isSummaryEngine, newId, providerPrepsOf, terminalAppFor, type AutoDoneIdleDays, type ConfigApproval, type EditorSetting, type Language, type OpencodeInjection, type ProviderPrep, type SummaryEngine, type TerminalApp } from '@agent-hangar/shared';
import { isLoose } from '../platform/secure.ts';
import { decideLanguage, osDisplayLanguage } from '../i18n/osLanguage.ts';

export type DeviceInfo = { id: string; name: string; platform: string };
export type Settings = {
  /**
   * 新しいフォルダの作成場所（任意）。役割は、新しいプロジェクトのフォルダを作る場所と、直下の自動の登録だけである。
   * 空は「決めていない」で、作るたびに場所を選ぶ。新しい利用者は空から始まる（loadSettings）。
   */
  workspaceRoot: string;
  /**
   * 利用者がフォルダの信頼に同意した作業フォルダ（hangar workspace set --trust、POST /api/workspace/trust）。
   * いまの workspaceRoot と同じときだけ効き（projects/folderTrust.ts の trustedWorkspaceOf）、作業フォルダを変えると空に戻す（PATCH /api/settings）。
   */
  trustedWorkspaceRoot?: string | null;
  claudeDir: string;
  tmuxPath: string | null;
  terminalApp: TerminalApp;
  /**
   * 「<名前> で開く」に使うエディタ（0.5.0）。
   * 0.4.0 までの settings.json は codePath（VS Code の code の場所）だけを持つので、読むときに `{ id: 'vscode', path: codePath }` へ読み替える（loadSettings）。
   */
  editor: EditorSetting;
  /**
   * ツールのパスを一度探したかどうか。二度目からは、利用者が空にした null をそのまま尊重する。
   * この項目が無い古い settings.json は、まだ探していないものとして扱う。
   */
  toolsResolved?: boolean;
  /**
   * 事後の要約を作るもの（0.6.0）。off は作らない、claude は claude -p、openai は OpenAI 互換の URL（lmStudioUrl）である。
   * 鍵の無い設定（0.5.0 まで）は off として読む。0.5.0 までの既定（LM Studio、無ければ Claude）は、使っていない人にも常に警告を出していたためである。
   * URL とモデルと切り替えの鍵（lmStudio*、summaryFallback）は残すので、openai を選び直せば前の宛先で動く。
   * `loadSettings` が必ず埋めるが、試験や古い呼び手が組んだ設定には無いことがあるので、読む側は無ければ off として読む（下の 2 つも同じく既定で読む）。
   */
  summaryEngine?: SummaryEngine;
  /** 要約に claude -p を使うときのモデル（--model）。既定は haiku。 */
  summaryClaudeModel?: string;
  /** OpenAI 互換の要約器の入口。末尾の / は付けない。鍵の名前は LM Studio だけだった頃のまま残す（保存済みの設定を読み替えずに済む）。 */
  lmStudioUrl: string;
  /** 使うモデルの id。null なら /v1/models の先頭のモデルに任せる。 */
  lmStudioModel: string | null;
  /** OpenAI 互換の要約器へ Authorization: Bearer で渡す API キー。要らないサーバでは null。settings.json（0600）にだけ置き、画面へは有無だけを返す。 */
  summaryApiKey?: string | null;
  /** OpenAI 互換の要約器が使えないときに Claude のヘッドレスへ落とすかどうか。既定は切（使用枠を黙って使わない）。 */
  summaryFallback: boolean;
  /** Claude のヘッドレスを 1 時間に何件まで呼ぶか。 */
  summaryHourlyCap: number;
  /**
   * ループバックの外の要約器を許すかどうか。
   * 要約器には会話の本文が送られるので、既定では手元だけに閉じる。
   */
  allowExternalSummarizer: boolean;
  /**
   * 他の PC から届いた skills、commands、agents の承認の仕方（作り直した設定の同期。sync/config/）。
   * each は項目ごとに毎回承認し、auto は自動で適用する。項目が無いうちは each として読む。
   * 実行される指示なので、既定では自動にしない。
   */
  configApproval?: ConfigApproval;
  /**
   * 設定の同期（sync/config/）を動かすか。既定は切。
   * 設定の画面の「この PC で有効にする」がこのスイッチを入れる（PATCH /api/settings）。
   */
  configBundleSync?: boolean;
  /**
   * 設定の同期の、対象ごとの入切（対象名→真偽）。無い対象は切。新しい対象（claude-keys2 など）はここが入でないと集めない。
   * 入れる画面は U1 で作る。それまでは settings.json を直接書く。
   */
  configTargets?: Record<string, boolean>;
  /**
   * hangar が起動する claude に足す指示（launch/injection.ts）のうち、区切りで Done か Paused を聞く段を足すか。既定は入り。
   * 切ると問いの段を足さず、状態は事後の要約の提案と自動の Done だけで付く。
   * `loadSettings` が埋めるが、試験や古い呼び手が組んだ設定には無いことがあるので、読む側は false のときだけ切りとして読む。
   */
  askStatusAtEnd?: boolean;
  /** 同じく、ターンの意図（set_turn_intent）と短い手の説明（Bash と Agent の description）を求める段を足すか。既定は入り。 */
  liveHints?: boolean;
  /**
   * 新しいセッションのモデルの札の初めの値（0.6.0）。プロジェクトに前回の値があれば、画面はそちらを先に使う。
   * null は Claude Code の既定（--model を渡さない）である。
   */
  defaultModel?: string | null;
  /**
   * hangar が自分で行うことのうち、止まった会話を自動で Done にするか（sessions/autoDone.ts）。既定は入り。
   * 切ると、Done にすることも、そのための事後要約（外で起こした長い会話の要約）を入れることもしない。
   * 読み方は askStatusAtEnd と同じで、false のときだけ切りとして読む。
   */
  autoDone?: boolean;
  /**
   * 自動の Done のうち、止まってから何日動きが無ければ Done にするか（sessions/autoDone.ts の idle）。0 はしない。既定は 7。
   * autoDone を切っている間は、この日数に関係なく Done にしない。
   */
  autoDoneIdleDays?: AutoDoneIdleDays;
  /**
   * 同じく、Done か Archived にした会話の Claude を、休みが 10 秒続いたら止めるか（sessions/park.ts）。既定は入り。
   * 切ると止めず、一覧でも実行中として見せる（db/queries.ts の setParkingSwitch）。
   */
  autoPark?: boolean;
  /**
   * hangar が起動する claude に `--remote-control <名前>` を足し、スマホの Claude アプリや claude.ai/code から開けるようにするか。既定は入り。
   * 足すのは claude.ai のログインのアカウントだけで、API キーなどでは入りでも足さない（launch/remoteControl.ts）。次に起こす claude から効く。
   * 読み方は askStatusAtEnd と同じで、false のときだけ切りとして読む。
   */
  remoteControl?: boolean;
  /**
   * 同梱サーバを起こすときに使う Node の場所。
   * null と空文字は「指定なし」で、起動側が既定の探索に戻る。
   */
  nodePath?: string | null;
  /**
   * run を起こすときに使う claude の場所。
   * 項目が無いうちは `resolveToolPaths` が探して埋め、null は利用者が外したものとして尊重する。
   * tmux のペインは hangar の PATH を継ぐので、.app から起こしたときは
   * `claude` という名前では引けない。だから絶対パスを持っておく。
   */
  claudePath?: string | null;
  /** codex の場所（ベータ）。項目が無いか null、空文字のときは、PATH と既知の置き場から探す（config/tools.ts の findCodex）。 */
  codexPath?: string | null;
  /** opencode の場所（ベータ）。読み方は codexPath と同じ（findOpencode）。 */
  opencodePath?: string | null;
  /**
   * 画面とサーバの文の言語。この PC だけの設定で、端末の間では同期しない。
   * `loadSettings` が必ず埋める。settings.json が無ければ OS の表示言語、あって項目が無ければ日本語にする（i18n/osLanguage.ts の decideLanguage）。
   */
  language?: Language;
  /**
   * opencode を有効にするか（ベータ）。既定は切で、項目が無いうちは切として読む（configBundleSync と同じく、既定の設定には足さない）。
   * 切のままなら、opencode の入口（新しいセッションの選択肢、外の端末の横取り、スマホ）はどこにも出さない。
   */
  opencodeEnabled?: boolean;
  /** Codex を有効にするか（ベータ）。opencodeEnabled と同じ読み方で、項目が無いうちは切。切のままなら Codex の入口はどこにも出さない。 */
  codexEnabled?: boolean;
  /** hangar が起動する codex のシステムプロンプトへの追記。項目が無いうちは最小限（minimal）として読む。 */
  codexInjection?: CodexInjection;
  /** 外のターミナルの codex コマンドを hangar 経由で起動するか（macOS と Linux だけ）。項目が無いうちは切として読む。codexEnabled も入りのときだけ効く。 */
  codexIntercept?: boolean;
  /** hangar が起動する opencode のシステムプロンプトへの追記。項目が無いうちは最小限（minimal）として読む。 */
  opencodeInjection?: OpencodeInjection;
  /** 外のターミナルの opencode コマンドを hangar 経由で起動するか（シェルの包み、macOS と Linux だけ）。項目が無いうちは切として読む。opencodeEnabled も入りのときだけ効く。 */
  opencodeIntercept?: boolean;
  /** hangar が起動する opencode に許可のひな形を重ねるか（provider/opencode/permissionPreset.ts）。項目が無いうちは入りとして読む。 */
  opencodePermissionPreset?: boolean;
  /** Claude Code の指示（CLAUDE.md）と MCP の登録を Codex・opencode の起動に渡すか（share/）。項目が無いうちは、指示が入、MCP が切として読む。 */
  codexShareInstructions?: boolean;
  codexShareMcp?: boolean;
  opencodeShareInstructions?: boolean;
  opencodeShareMcp?: boolean;
  /** 起動前に LM Studio のモデルを載せる長さ（起動前の準備）。項目が無いうちは既定の 64K として読む。 */
  opencodeLocalContext?: number;
  /** 使っていないローカルのモデルを外すまでの分（IDLE_UNLOAD_CHOICES、0 は外さない）。 */
  opencodeIdleUnload?: number;
  /** opencode の接続先ごとの準備のコマンド（起動前の準備）。この PC だけの設定で、同期しない。項目が無いうちは準備なしとして読む。読む側は providerPrepsOf を通す（null の項目は捨てる）。 */
  opencodeProviderPrep?: Record<string, ProviderPrep | null>;
};

/** 要約器の宛先に既定で許すホスト。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 要約器の URL が手元を指しているか。読めない文字列は手元とみなさない。 */
export function isLoopbackSummarizerUrl(v: string): boolean {
  try { return LOOPBACK_HOSTS.has(new URL(v).hostname); } catch { return false; }
}

export function hangarHome(): string {
  return process.env.HANGAR_HOME ?? path.join(os.homedir(), '.agent-hangar');
}

export function defaultClaudeDir(): string {
  return process.env.HANGAR_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
}

export function dbPath(home: string): string {
  return path.join(home, 'hangar.db');
}

export function ensureHome(home: string): void {
  // 中の hangar.db と desktop.log は 0644 なので、置き場所が緩いと同じ機械の別の利用者に全セッションの記録が読める。
  // mode は新しく作るときにしか効かないので、既にある置き場所は chmod で直す。
  // デスクトップの .app が先に 0755 で作った手元や、古い版が残した手元も、起動のたびにここで直る。
  // 利用者が 0700 より厳しくした権限は緩めない。
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (isLoose(home)) fs.chmodSync(home, 0o700);
}

export function readOrCreateToken(home: string): string {
  const file = path.join(home, 'token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function readOrCreateDevice(home: string): DeviceInfo {
  const file = path.join(home, 'device.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as DeviceInfo;
  const info: DeviceInfo = { id: newId(), name: os.hostname(), platform: process.platform };
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  return info;
}

function defaultSettings(platform: NodeJS.Platform = process.platform): Settings {
  return { workspaceRoot: path.join(os.homedir(), 'workspace'), claudeDir: defaultClaudeDir(), tmuxPath: null, terminalApp: defaultTerminalApp(platform), editor: { ...DEFAULT_EDITOR }, toolsResolved: false, summaryEngine: 'off', summaryClaudeModel: DEFAULT_SUMMARY_CLAUDE_MODEL, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryApiKey: null, summaryFallback: false, summaryHourlyCap: 20, allowExternalSummarizer: false, askStatusAtEnd: true, liveHints: true, autoDone: true, autoDoneIdleDays: DEFAULT_AUTO_DONE_IDLE_DAYS, autoPark: true, remoteControl: true, defaultModel: null, nodePath: null };
}

/**
 * platform と osLanguage は試験のための差し込み口である。
 * platform は外部ターミナルの既定と読み替えに、osLanguage は settings.json が無いとき（初めての起動）の言語に使う。
 * 言語はここで必ず埋める。初めての起動で決めた言語は、起動が通ってから書き戻す（boot/home.ts の persistSettings）。
 */
export function loadSettings(home: string, platform: NodeJS.Platform = process.platform, osLanguage: () => Language | undefined = osDisplayLanguage): Settings {
  const file = path.join(home, 'settings.json');
  // 新しい利用者の作成場所は空（決めていない）にする。初日はホームの帯から、Claude Code と会話したフォルダを選んでもらう（2026-10-13）。
  // 項目の無い古い settings.json は、今までどおり ~/workspace として読む（既存の利用者の振る舞いを変えない）。
  // ただし言語だけのファイル（殻が先に書いたもの）は新しい利用者として読む（isNewcomerFile）。
  if (!fs.existsSync(file)) return { ...defaultSettings(platform), workspaceRoot: '', language: decideLanguage(undefined, osLanguage).language };
  const text = fs.readFileSync(file, 'utf8');
  const s = { ...defaultSettings(platform), ...(JSON.parse(text) as Partial<Settings>) };
  // 殻（bootfail.rs の ensure_language）は、初めての起動でサーバより先に言語だけのファイルを書く。
  // 言語のほかに何も持たないファイルは利用者の選んだ値を含まないので、無いときと同じく新しい利用者として作成場所を空にする。
  if (isNewcomerFile(text)) s.workspaceRoot = '';
  // 別の OS で保存した外部ターミナル（macOS の iTerm2 を Windows で読んだときなど）は、この OS の既定に読み替える。
  s.terminalApp = terminalAppFor(s.terminalApp, platform);
  // 0.4.0 までの codePath は、エディタの設定（VS Code、その場所）に読み替える。読み替えたら古い鍵は持たない（保存し直すと消える）。
  const raw = JSON.parse(text) as Record<string, unknown>;
  s.editor = editorSettingOf(raw.editor, typeof raw.codePath === 'string' ? raw.codePath : null);
  delete (s as Record<string, unknown>).codePath;
  // 旧実装の設定の同期のスイッチ（syncClaudeConfig）は、設定の同期を作り直したときに消した。
  // 入れていた人の settings.json にはまだ残っているので、未知の鍵として読み捨てる（保存し直すと消える）。
  delete (s as Record<string, unknown>).syncClaudeConfig;
  // 許しの無い外部の宛先は、読み込みのときに既定へ戻す。
  // 手で書き換えた settings.json や、この制限より前に保存された設定から、会話の本文が外へ出ていかないようにする。
  if (!s.allowExternalSummarizer && !isLoopbackSummarizerUrl(s.lmStudioUrl)) s.lmStudioUrl = defaultSettings().lmStudioUrl;
  // 足す段のスイッチは真偽値だけを受ける。手で書き換えた値は既定（入り）に寄せる。
  if (typeof s.askStatusAtEnd !== 'boolean') s.askStatusAtEnd = true;
  if (typeof s.liveHints !== 'boolean') s.liveHints = true;
  // 要約エンジンとモデルの名前も、手で書き換えた値を既定に寄せる。モデルの名前は claude の引数へそのまま渡るので、形を確かめる。
  if (!isSummaryEngine(s.summaryEngine)) s.summaryEngine = 'off';
  if (!isModelName(s.summaryClaudeModel)) s.summaryClaudeModel = DEFAULT_SUMMARY_CLAUDE_MODEL;
  if (typeof s.summaryApiKey !== 'string' || s.summaryApiKey.trim() === '') s.summaryApiKey = null;
  if (!isModelName(s.defaultModel)) s.defaultModel = null;
  // hangar が自分で行うことのスイッチも同じ。
  if (typeof s.autoDone !== 'boolean') s.autoDone = true;
  if (!isAutoDoneIdleDays(s.autoDoneIdleDays)) s.autoDoneIdleDays = DEFAULT_AUTO_DONE_IDLE_DAYS;
  if (typeof s.autoPark !== 'boolean') s.autoPark = true;
  if (typeof s.remoteControl !== 'boolean') s.remoteControl = true;
  // opencode の項目は既定の設定に無いので、手で書き換えた値は捨てて、無い項目（既定）として読ませる。
  if (s.codexEnabled !== undefined && typeof s.codexEnabled !== 'boolean') delete s.codexEnabled;
  if (s.codexInjection !== undefined && !isCodexInjection(s.codexInjection)) delete s.codexInjection;
  if (s.codexIntercept !== undefined && typeof s.codexIntercept !== 'boolean') delete s.codexIntercept;
  if (s.opencodeEnabled !== undefined && typeof s.opencodeEnabled !== 'boolean') delete s.opencodeEnabled;
  if (s.opencodeInjection !== undefined && !isOpencodeInjection(s.opencodeInjection)) delete s.opencodeInjection;
  if (s.opencodeIntercept !== undefined && typeof s.opencodeIntercept !== 'boolean') delete s.opencodeIntercept;
  if (s.opencodePermissionPreset !== undefined && typeof s.opencodePermissionPreset !== 'boolean') delete s.opencodePermissionPreset;
  for (const k of ['codexShareInstructions', 'codexShareMcp', 'opencodeShareInstructions', 'opencodeShareMcp'] as const) if (s[k] !== undefined && typeof s[k] !== 'boolean') delete s[k];
  if (s.opencodeLocalContext !== undefined && !isLocalContext(s.opencodeLocalContext)) delete s.opencodeLocalContext;
  if (s.opencodeIdleUnload !== undefined && !isIdleUnload(s.opencodeIdleUnload)) delete s.opencodeIdleUnload;
  if (s.opencodeProviderPrep !== undefined) s.opencodeProviderPrep = providerPrepsOf(s.opencodeProviderPrep);
  // 項目が無い設定と知らない言語は、OS に合わせる前の日本語にする。手で書き換えた値を、画面とサーバの辞書引きへそのまま流さない。
  if (!isLanguage(s.language)) s.language = decideLanguage(text, osLanguage).language;
  return s;
}

/** 言語のほかに鍵を持たない settings.json か。殻が初めての起動で書いたもので、サーバはまだ一度も書き戻していない。 */
function isNewcomerFile(text: string): boolean {
  const raw = JSON.parse(text) as unknown;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).every((k) => k === 'language');
}

export function saveSettings(home: string, s: Settings): void {
  // token や device.json と同じ 0600 にする。mode は新しく作るときにしか効かないので、既にある分は chmod で直す。
  const file = path.join(home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
