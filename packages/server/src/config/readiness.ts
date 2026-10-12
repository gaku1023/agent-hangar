import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorNameOf, type EditorDetectState, type EditorId, type NodeCheckDto, type ReadinessDto, type ToolCheckDto } from '@agent-hangar/shared';
import { findGit as defaultFindGit } from '../git/find.ts';
import type { Db } from '../db/open.ts';
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
import { hasWorkspaceRoot, resolvedProjectCount, workspaceProjectCount } from '../projects/registry.ts';
import type { Settings } from './paths.ts';
import { statuslineStatus } from '../provider/claude-code/config/statusline.ts';
import { isCommandName, isExecutableFile, needsShell } from '../platform/exec.ts';
import { findOnPath } from './tools.ts';
import { createNodeCheck, isFullPath, nodeBuildIssue, type NodeCheck } from './node.ts';

// 準備の確かめ。
// 設定画面の欄の下の検証と、ホームの帯の始める前の確認が、同じこの読み取りを使う。
// ここは読むだけで、~/.claude も ~/.claude.json も書き換えない。

/** 先頭の ~ だけをホームに直す。途中の ~ は名前の一部として残す。 */
export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (p === '~') return homeDir;
  return p.startsWith('~/') || p.startsWith('~\\') ? path.join(homeDir, p.slice(2)) : p;
}

export { isCommandName };

/**
 * パスがツールとして動かせるか。子プロセスは起こさず、ファイルの有無と実行権だけを見る。
 * 名前だけ（tmux など）は、起動のときと同じく PATH から探す。
 * ./x や bin/x のような相対パスは、サーバの作業ディレクトリで解釈するとどこを指すかが分からないので、見つからないとする。
 */
export function checkToolPath(p: string | null, homeDir: string = os.homedir(), pathEnv: string | undefined = process.env.PATH): Omit<ToolCheckDto, 'version'> {
  if (p === null || p.trim() === '') return { path: null, ok: false, problem: 'unset' };
  const raw = p.trim();
  if (isCommandName(raw)) {
    const found = findOnPath(raw, pathEnv);
    return found ? { path: found, ok: true, problem: null } : { path: raw, ok: false, problem: 'missing' };
  }
  const full = expandHome(raw, homeDir);
  if (!path.isAbsolute(full)) return { path: raw, ok: false, problem: 'missing' };
  const st = fs.statSync(full, { throwIfNoEntry: false });
  if (!st) return { path: full, ok: false, problem: 'missing' };
  if (!st.isFile()) return { path: full, ok: false, problem: 'notFile' };
  if (!isExecutableFile(full)) return { path: full, ok: false, problem: 'notExecutable' };
  return { path: full, ok: true, problem: null };
}

/**
 * 「再確認」で tmux の役の道具（Windows は psmux）を探し直す。見つかったパスを返し、変えないときは null を返す。
 * 探すのは、設定が空のときと、設定したファイルが無くなったときだけである。
 * 設定は最初の起動で一度だけ埋めるので、あとから psmux や tmux を入れた人は、押さない限り空のままになる。
 * 動いている設定と、利用者が指したが実行できないファイルは変えない（設定の欄で直す）。
 * 探し方（findMux）は PATH と既知の置き場を見る which にする。winget が入れた直後の道具は、動いているサーバの PATH に無いからである。
 */
export function recheckMuxPath(tmuxPath: string | null, findMux: () => string | null, homeDir: string = os.homedir(), pathEnv: string | undefined = process.env.PATH): string | null {
  const c = checkToolPath(tmuxPath, homeDir, pathEnv);
  if (c.ok || (c.problem !== 'unset' && c.problem !== 'missing')) return null;
  const found = findMux();
  return found !== null && found !== tmuxPath ? found : null;
}

/**
 * 道具のパスが使えない理由を、文の鍵と引数で返す。使えれば null。
 * 設定の保存（PATCH /api/settings）と、起動の前の確かめ（RunManager の precheck）が同じ判定を使う。
 * 名前だけ（tmux など）は PATH に無いこと、パスは無い、ファイルでない、実行できないのどれかを言う。
 * 文の「{label}」は呼び手が欄の見出しで埋める。
 */
export type ToolPathIssue =
  | { key: 'settings.path.notOnPath'; name: string }
  | { key: 'settings.path.missing' | 'settings.path.notFile' | 'settings.path.notExecutable'; path: string };
export function toolPathIssue(raw: string, homeDir: string = os.homedir(), pathEnv: string | undefined = process.env.PATH): ToolPathIssue | null {
  const t = checkToolPath(raw, homeDir, pathEnv);
  if (t.ok) return null;
  if (t.problem === 'notFile' || t.problem === 'notExecutable') return { key: t.problem === 'notFile' ? 'settings.path.notFile' : 'settings.path.notExecutable', path: String(t.path) };
  return isCommandName(raw.trim()) ? { key: 'settings.path.notOnPath', name: raw.trim() } : { key: 'settings.path.missing', path: String(t.path ?? raw) };
}

/** 出力の中の最初の版らしい語。`tmux 3.4`、`2.3.1 (Claude Code)`、`v22.9.0`、`tmux next-3.5a` を読む。 */
function versionOf(out: string): string | null {
  return out.match(/v?\d+(?:\.\d+)+[a-z]?/)?.[0] ?? null;
}

/**
 * ツールの版を読む。
 * 子プロセスを起こすので、必ず時間を区切る。
 * 版は同じファイルなら変わらないので、パスと更新時刻と大きさを鍵に覚えておき、起こし直さない。
 * 出力はパイプで読む。claude はパイプへ書き切る前に終わることがあるが、版の出力（`2.1.293 (Claude Code)`）は 1 行で、パイプの容量（8KB〜16KB）に収まる。
 */
export class ToolVersions {
  private readonly cache = new Map<string, string | null>();
  constructor(private readonly timeoutMs: number = 3000) {}

  async get(file: string, args: string[]): Promise<string | null> {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) return null;
    const key = `${file}\0${st.mtimeMs}\0${st.size}\0${args.join(' ')}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    // .cmd と .bat は cmd.exe を通さないと起こせない。引数は hangar が決めた固定の語（-V、--version）だけなので、引用の心配は無い。
    const viaShell = needsShell(file);
    const v = await new Promise<string | null>((resolve) => {
      execFile(viaShell ? `"${file}"` : file, args, { timeout: this.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, shell: viaShell, windowsHide: true }, (err, stdout, stderr) => {
        // 時間切れと起動の失敗は「読めない」にする。版が読めなくても、動かせるかの判定は変えない。
        if (err && (err.killed || stdout === '')) return resolve(versionOf(String(stderr)) ?? null);
        resolve(versionOf(String(stdout)) ?? versionOf(String(stderr)));
      });
    });
    // 時間切れは覚えない。次に開いたときに、もう一度試せるようにする。
    if (v !== null) this.cache.set(key, v);
    return v;
  }
}

/**
 * Claude Code の user スコープの設定に、hangar の MCP サーバが載っているか。
 * 読むだけで書かない。無いファイルと壊れたファイルは「載っていない」とする。
 */
export function readMcpRegistration(file: string): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    const s = j?.mcpServers?.hangar;
    return typeof s === 'object' && s !== null;
  } catch {
    return false;
  }
}

/**
 * 外のターミナルのコマンド（`hangar shell install` など）から、hangar の呼び方だけを取り出す。
 * MCP と statusline のコマンドも、この呼び方にそろえる。
 */
export function hangarCommandPrefix(shellCommand: string): string {
  return shellCommand.replace(/ shell install$/, '');
}

export type ReadinessOptions = {
  settings: () => Settings;
  /** 索引の読み取り元。statusline の設定はこの下の settings.json から読む。 */
  claudeDir: string;
  /** user スコープの設定ファイル（~/.claude.json）。 */
  claudeJson: string;
  /** ~ を直すときのホーム。テストは一時ディレクトリを渡す。 */
  homeDir?: string;
  db: Db;
  deviceId: string;
  /** 外のターミナルを入れるコマンド。ほかのコマンドの呼び方もここから決める。 */
  shellCommand: () => string;
  /** Node の設定が空のときに見せる Node。既定はサーバを動かしている Node である。 */
  serverNode?: { path: string; version: string };
  /** Node の設定の確かめ（同梱のサーバと同じメジャー版とアーキか）。既定は同梱の manifest.json を読むもの。 */
  nodeCheck?: NodeCheck;
  /** 版を読む子プロセスの時間の上限。 */
  timeoutMs?: number;
  /** 記録した Claude Code との互換のずれの件数。渡さなければ 0 とする。 */
  compatDriftCount?: () => number;
  /**
   * 互換の要約に載せる手元の claude の版。サーバは GET /api/compat と同じ引き方（環境変数、設定、PATH）で読む口を渡す。
   * 渡さなければ、道具の行で読んだ設定の claude の版を使う。
   */
  compatLocalVersion?: () => Promise<string | null>;
  /** git を探す（git/find.ts）。既定は PATH と既知の置き場（Windows は Git for Windows の場所）を見る。 */
  findGit?: () => string | null;
  /** 選んだエディタで開けるか（external/api.ts の editors の current）。渡さなければエディタの行を持たない。 */
  editor?: () => Promise<{ id: EditorId; state: EditorDetectState; path: string | null }>;
  /**
   * Claude Code と会話したフォルダの候補の数（projects/candidates.ts）。プロジェクトが 1 件も無いときだけ呼ぶ。
   * 渡さなければ 0 とする。
   */
  candidateCount?: () => number;
};

/** 準備の確かめを返す関数を作る。版の覚えは、この関数が生きている間だけ持つ。 */
export function createReadiness(o: ReadinessOptions): () => Promise<ReadinessDto> {
  const versions = new ToolVersions(o.timeoutMs ?? 3000);
  const homeDir = o.homeDir ?? os.homedir();
  const serverNode = o.serverNode ?? { path: process.execPath, version: process.version };
  const tool = async (p: string | null, args: string[]): Promise<ToolCheckDto> => {
    const c = checkToolPath(p, homeDir);
    return { ...c, version: c.ok && c.path ? await versions.get(c.path, args) : null };
  };
  const nodeCheck = o.nodeCheck ?? createNodeCheck();
  /**
   * 設定した Node を、殻（node.rs）と同じ条件で見る。
   * 殻は nodePath を名前として PATH から引かず、manifest.json と同じメジャー版とアーキの Node だけを使う。
   * それ以外に ✓ を付けると、画面では使えるように見えて、次の起動で殻はほかの Node を探す。
   * 殻と CLI は ~ を展開しない。展開前の値が絶対パスでなければ、展開すれば実在しても ✗ にする。
   */
  const nodeTool = async (raw: string): Promise<NodeCheckDto> => {
    const p = raw.trim();
    if (isCommandName(p) || !isFullPath(p)) return { path: p, ok: false, problem: 'notAbsolute', version: null, auto: false };
    const c = await tool(p, ['--version']);
    if (!c.ok || c.path === null) return { ...c, auto: false };
    const bad = await nodeBuildIssue(c.path, nodeCheck);
    if (bad?.kind === 'notNode') return { ...c, ok: false, problem: 'notNode', auto: false };
    if (bad?.kind === 'mismatch') return { ...c, ok: false, problem: 'wrongNode', auto: false, found: bad.found, need: bad.need };
    return { ...c, auto: false };
  };
  return async () => {
    const s = o.settings();
    const nodeSet = s.nodePath !== null && s.nodePath !== undefined && s.nodePath.trim() !== '';
    const gitFile = (o.findGit ?? (() => defaultFindGit()))();
    const [tmux, claude, git, node, compatLocal, editor] = await Promise.all([
      tool(s.tmuxPath, ['-V']),
      tool(s.claudePath ?? null, ['--version']),
      tool(gitFile, ['--version']),
      nodeSet ? nodeTool(s.nodePath ?? '') : Promise.resolve<NodeCheckDto>({ path: serverNode.path, ok: true, problem: null, version: serverNode.version, auto: true }),
      o.compatLocalVersion ? o.compatLocalVersion() : Promise.resolve(undefined),
      o.editor ? o.editor().catch(() => null) : Promise.resolve(null),
    ]);
    // 作成場所は任意で、空は「決めていない」である。空のまま stat すると作業ディレクトリを見てしまうので、見ない。
    const set = hasWorkspaceRoot(s.workspaceRoot);
    const root = set ? expandHome(s.workspaceRoot, homeDir) : '';
    const exists = set && (fs.statSync(root, { throwIfNoEntry: false })?.isDirectory() ?? false);
    const resolved = resolvedProjectCount(o.db, o.deviceId);
    const shell = o.shellCommand();
    const prefix = hangarCommandPrefix(shell);
    return {
      tools: { tmux, claude, node, git },
      ...(editor ? { editor: { ...editor, name: editorNameOf(editor.id) } } : {}),
      workspace: { path: s.workspaceRoot, exists, projectCount: exists ? workspaceProjectCount(o.db, o.deviceId, root) : 0 },
      projects: { resolved, candidates: resolved === 0 ? o.candidateCount?.() ?? 0 : 0 },
      mcp: { registered: readMcpRegistration(o.claudeJson), file: o.claudeJson },
      statusline: statuslineStatus(o.claudeDir, homeDir),
      commands: { mcp: `${prefix} mcp install`, statusline: `${prefix} statusline install`, shell, join: `${prefix} join <token>` },
      // 口が無ければ、上で読んだ claude の版と同じものを使う（同じ claude を 2 度起こさない）。
      // 件数は版を読んだ後に数える。版が変わったときは、読んだ時点で記録が空になっている。
      compat: { verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: compatLocal === undefined ? claude.version : compatLocal, driftCount: o.compatDriftCount?.() ?? 0 },
    };
  };
}
