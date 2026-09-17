import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings } from '@agent-hangar/server';

export type SetupReport = {
  home: string;
  deviceId: string;
  tools: { name: string; found: boolean; path: string | null }[];
  workspaceRoot: string;
  workspaceExists: boolean;
};

/**
 * PATH 上のコマンドの場所を返す。
 * 見つからなければ null を返す。
 */
export function whichCmd(cmd: string): string | null {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * データディレクトリ、トークン、端末 ID を用意し、ツールとワークスペースの状態を報告する。
 * 書き込みは home 配下に限る。
 * プロジェクトの登録はサーバ起動時に行う。
 */
export function runSetup(opts: { home: string; workspaceRoot?: string; which?: (cmd: string) => string | null }): SetupReport {
  const which = opts.which ?? whichCmd;
  ensureHome(opts.home);
  readOrCreateToken(opts.home);
  const device = readOrCreateDevice(opts.home);
  const settings = loadSettings(opts.home);
  if (opts.workspaceRoot) settings.workspaceRoot = path.resolve(opts.workspaceRoot.replace(/^~(?=$|\/)/, os.homedir()));
  saveSettings(opts.home, settings);
  const tools = ['tmux', 'claude', 'code'].map((name) => {
    const p = which(name);
    return { name, found: p !== null, path: p };
  });
  return {
    home: opts.home,
    deviceId: device.id,
    tools,
    workspaceRoot: settings.workspaceRoot,
    workspaceExists: fs.existsSync(settings.workspaceRoot),
  };
}

export function formatSetupReport(r: SetupReport): string {
  const lines = [`データディレクトリ: ${r.home}`, `端末 ID: ${r.deviceId}`];
  for (const t of r.tools) lines.push(`${t.name}: ${t.found ? t.path : '見つかりません'}`);
  lines.push(`ワークスペース: ${r.workspaceRoot}${r.workspaceExists ? '' : '（存在しません。hangar setup --workspace <dir> で変えられます）'}`);
  lines.push('プロジェクトの自動登録は hangar start の起動時に行います。');
  return lines.join('\n');
}
