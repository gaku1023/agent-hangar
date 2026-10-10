import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatuslineStatusDto } from '@agent-hangar/shared';
import { defaultClaudeDir, ensureHome, findInDirs, knownDirs, loadSettings, MUX_NAMES, readOrCreateDevice, readOrCreateToken, saveSettings, splitPathEnv, statuslineStatus } from '@agent-hangar/server/src/cliEntry.ts';

export type SetupReport = {
  home: string;
  deviceId: string;
  tools: { name: string; found: boolean; path: string | null }[];
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
export function runSetup(opts: { home: string; workspaceRoot?: string; claudeDir?: string; which?: (cmd: string) => string | null; platform?: NodeJS.Platform }): SetupReport {
  const which = opts.which ?? whichCmd;
  const platform = opts.platform ?? process.platform;
  ensureHome(opts.home);
  readOrCreateToken(opts.home);
  const device = readOrCreateDevice(opts.home);
  const settings = loadSettings(opts.home);
  if (opts.workspaceRoot) settings.workspaceRoot = path.resolve(expandTilde(opts.workspaceRoot, platform));
  saveSettings(opts.home, settings);
  const tools = ['tmux', 'claude', 'code'].map((name) => {
    const p = name === 'tmux' ? whichMuxCmd(which, platform) : which(name);
    return { name, found: p !== null, path: p };
  });
  return {
    home: opts.home,
    deviceId: device.id,
    tools,
    workspaceRoot: settings.workspaceRoot,
    workspaceExists: fs.existsSync(settings.workspaceRoot),
    statusline: statuslineStatus(opts.claudeDir ?? settings.claudeDir ?? defaultClaudeDir()),
  };
}

export function formatSetupReport(r: SetupReport): string {
  const lines = [`データディレクトリ: ${r.home}`, `端末 ID: ${r.deviceId}`];
  for (const t of r.tools) lines.push(`${t.name}: ${t.found ? t.path : '見つかりません'}`);
  lines.push(`ワークスペース: ${r.workspaceRoot}${r.workspaceExists ? '' : '（存在しません。hangar setup --workspace <dir> で変えられます）'}`);
  lines.push(r.statusline.installed ? 'statusline: 追記済み' : r.statusline.scriptPath ? 'statusline: 未追記（hangar statusline install で追記できます）' : 'statusline: スクリプトが見つかりません');
  lines.push('プロジェクトの自動登録は hangar start の起動時に行います。');
  return lines.join('\n');
}
