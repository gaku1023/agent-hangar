import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PSMUX_MIN_VERSION, PSMUX_UPGRADE_COMMAND, psmuxTooOld, type StatuslineStatusDto } from '@agent-hangar/shared';
import { defaultClaudeDir, ensureHome, findInDirs, knownDirs, loadSettings, MUX_NAMES, readOrCreateDevice, readOrCreateToken, saveSettings, splitPathEnv, statuslineStatus } from '@agent-hangar/server/src/cliEntry.ts';

export type SetupReport = {
  home: string;
  deviceId: string;
  /** outdated は tmux の行だけのもので、Windows の psmux が下限より古いときだけ持つ（issue #245）。 */
  tools: { name: string; found: boolean; path: string | null; outdated?: { version: string; min: string } }[];
  workspaceRoot: string;
  workspaceExists: boolean;
  statusline: StatuslineStatusDto;
};

/**
 * PATH と既知の置き場からコマンドの場所を返す。見つからなければ null を返す。
 * which を起こさない。Windows には which が無く、PATHEXT の拡張子（.exe など）を補って探す必要がある（サーバの config/tools.ts の which と同じ探し方）。
 */
export function whichCmd(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  // Windows の環境変数は大文字小文字を区別しないが、試験が渡す素のオブジェクトは区別する。
  const pathEnv = env.PATH ?? env.Path;
  return findInDirs(cmd, [...splitPathEnv(pathEnv, platform), ...knownDirs(env, platform)], env, platform);
}

/** tmux の役を担う道具を探す。Windows では psmux を先に見る。 */
export function whichMuxCmd(which: (cmd: string) => string | null = whichCmd, platform: NodeJS.Platform = process.platform): string | null {
  for (const name of MUX_NAMES(platform)) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/**
 * psmux の版を `-V` で読む（1 行目は `tmux 3.3.8` の形）。読めなければ null を返す。
 * 子プロセスは 3 秒で切る（サーバの config/readiness.ts の ToolVersions と同じ上限）。
 */
export function readMuxVersion(file: string): string | null {
  try {
    const out = execFileSync(file, ['-V'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.match(/\d+(?:\.\d+)+[a-z]?/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** 先頭の ~ をホームに直す。Windows では ~\ も直す。 */
function expandTilde(p: string, platform: NodeJS.Platform): string {
  const m = platform === 'win32' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/;
  return m.test(p) ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * データディレクトリ、トークン、端末 ID を用意し、ツールとワークスペースと statusline の状態を報告する。
 * 書き込みは home 配下に限る。
 * statusline への追記はここでは行わず、承諾を得たうえで runStatuslineInstall が行う。
 * プロジェクトの登録はサーバ起動時に行う。
 */
export function runSetup(opts: { home: string; workspaceRoot?: string; claudeDir?: string; which?: (cmd: string) => string | null; platform?: NodeJS.Platform; readMuxVersion?: (file: string) => string | null }): SetupReport {
  const which = opts.which ?? whichCmd;
  const platform = opts.platform ?? process.platform;
  ensureHome(opts.home);
  readOrCreateToken(opts.home);
  const device = readOrCreateDevice(opts.home);
  const settings = loadSettings(opts.home);
  if (opts.workspaceRoot) settings.workspaceRoot = path.resolve(expandTilde(opts.workspaceRoot, platform));
  saveSettings(opts.home, settings);
  // code（VS Code）は 0.5.0 でエディタの選択に替えたので見ない。git は無くても動くが、ブランチと未コミットの件数に使う。
  const tools = ['tmux', 'claude', 'git'].map((name) => {
    const p = name === 'tmux' ? whichMuxCmd(which, platform) : which(name);
    // psmux の下限は Windows だけに当てる（macOS の tmux の版は読まない）。読めない版は知らせない。
    if (name === 'tmux' && p !== null && platform === 'win32') {
      const version = (opts.readMuxVersion ?? readMuxVersion)(p);
      if (version !== null && psmuxTooOld(version)) return { name, found: true, path: p, outdated: { version, min: PSMUX_MIN_VERSION } };
    }
    return { name, found: p !== null, path: p };
  });
  return {
    home: opts.home,
    deviceId: device.id,
    tools,
    workspaceRoot: settings.workspaceRoot,
    workspaceExists: settings.workspaceRoot !== '' && fs.existsSync(settings.workspaceRoot),
    statusline: statuslineStatus(opts.claudeDir ?? settings.claudeDir ?? defaultClaudeDir()),
  };
}

export function formatSetupReport(r: SetupReport): string {
  const lines = [`データディレクトリ: ${r.home}`, `端末 ID: ${r.deviceId}`];
  for (const t of r.tools) {
    lines.push(`${t.name}: ${t.found ? t.path : '見つかりません'}`);
    if (t.outdated) {
      lines.push(`  注意: psmux ${t.outdated.version} は古い版です。${t.outdated.min} 未満では、端末をホイールで上へスクロールできません。`);
      lines.push('  hangar のセッションを全部閉じてから（実行中のセッションは止まります）、外の PowerShell で次を打ってください:');
      lines.push(`  ${PSMUX_UPGRADE_COMMAND}`);
    }
  }
  // 作成場所は任意（2026-10-13）。空なら決めていないと言い、プロジェクトはアプリのホームで選べることを添える。
  if (r.workspaceRoot === '') lines.push('新しいフォルダの作成場所: 未設定（任意。hangar setup --workspace <dir> で決められます）');
  else lines.push(`新しいフォルダの作成場所: ${r.workspaceRoot}${r.workspaceExists ? '' : '（存在しません。hangar setup --workspace <dir> で変えられます）'}`);
  lines.push(r.statusline.installed ? 'statusline: 追記済み' : r.statusline.scriptPath ? 'statusline: 未追記（hangar statusline install で追記できます）' : 'statusline: スクリプトが見つかりません');
  lines.push(r.workspaceRoot === '' ? 'プロジェクトは、アプリのホームで、Claude Code と会話したフォルダから選べます。' : 'プロジェクトの自動登録は hangar start の起動時に行います。');
  return lines.join('\n');
}
