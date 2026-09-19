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
  /** 事後要約に使う LM Studio の入口。末尾の / は付けない。 */
  lmStudioUrl: string;
  /** 使うモデルの id。null なら LM Studio が読み込んでいる先頭のモデルに任せる。 */
  lmStudioModel: string | null;
  /** LM Studio が使えないときに Claude のヘッドレスへ落とすかどうか。 */
  summaryFallback: boolean;
  /** Claude のヘッドレスを 1 時間に何件まで呼ぶか。 */
  summaryHourlyCap: number;
  /**
   * ループバックの外の要約器を許すかどうか。
   * 要約器には会話の本文が送られるので、既定では手元だけに閉じる。
   */
  allowExternalSummarizer: boolean;
  /**
   * ~/.claude の設定（CLAUDE.md、settings.json、commands、agents、skills）を端末の間で同期するかどうか。
   * 既定は false である。他端末の設定が手元の ~/.claude を書き換えるので、利用者が明示的に入れたときだけ動かす。
   */
  syncClaudeConfig: boolean;
  /**
   * 同梱サーバを起こすときに使う Node の場所。
   * null と空文字は「指定なし」で、起動側が既定の探索に戻る。
   */
  nodePath?: string | null;
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
  return { workspaceRoot: path.join(os.homedir(), 'workspace'), claudeDir: defaultClaudeDir(), tmuxPath: null, terminalApp: 'terminal', codePath: null, toolsResolved: false, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null };
}

export function loadSettings(home: string): Settings {
  const file = path.join(home, 'settings.json');
  if (!fs.existsSync(file)) return defaultSettings();
  const s = { ...defaultSettings(), ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>) };
  // 許しの無い外部の宛先は、読み込みのときに既定へ戻す。
  // 手で書き換えた settings.json や、この制限より前に保存された設定から、会話の本文が外へ出ていかないようにする。
  if (!s.allowExternalSummarizer && !isLoopbackSummarizerUrl(s.lmStudioUrl)) s.lmStudioUrl = defaultSettings().lmStudioUrl;
  return s;
}

export function saveSettings(home: string, s: Settings): void {
  // token や device.json と同じ 0600 にする。mode は新しく作るときにしか効かないので、既にある分は chmod で直す。
  const file = path.join(home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
