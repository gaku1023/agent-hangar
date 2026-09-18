import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, type TerminalApp } from '@agent-hangar/shared';

export type DeviceInfo = { id: string; name: string; platform: string };
export type Settings = {
  workspaceRoot: string;
  claudeDir: string;
  tmuxPath: string | null;
  terminalApp: TerminalApp;
  codePath: string | null;
  /**
   * ツールのパスを一度探したかどうか。二度目からは、利用者が空にした null をそのまま尊重する。
   * この項目が無い古い settings.json は、まだ探していないものとして扱う。
   */
  toolsResolved?: boolean;
};

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
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
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

function defaultSettings(): Settings {
  return { workspaceRoot: path.join(os.homedir(), 'workspace'), claudeDir: defaultClaudeDir(), tmuxPath: null, terminalApp: 'terminal', codePath: null, toolsResolved: false };
}

export function loadSettings(home: string): Settings {
  const file = path.join(home, 'settings.json');
  if (!fs.existsSync(file)) return defaultSettings();
  return { ...defaultSettings(), ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>) };
}

export function saveSettings(home: string, s: Settings): void {
  // token や device.json と同じ 0600 にする。mode は新しく作るときにしか効かないので、既にある分は chmod で直す。
  const file = path.join(home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
