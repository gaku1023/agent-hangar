import type { TerminalApp } from './api.ts';

const MAC_TERMINAL_APPS: readonly TerminalApp[] = ['terminal', 'iterm'];
const WINDOWS_TERMINAL_APPS: readonly TerminalApp[] = ['windowsTerminal', 'windowsDefault'];

/**
 * その OS で選べる外部ターミナル。先頭が既定である。
 * platform は Node の process.platform の値で、Windows（win32）のほかは、いままでどおり macOS の選択肢にする。
 */
export function terminalAppsFor(platform: string): readonly TerminalApp[] {
  return platform === 'win32' ? WINDOWS_TERMINAL_APPS : MAC_TERMINAL_APPS;
}

/** その OS の既定の外部ターミナル。 */
export function defaultTerminalApp(platform: string): TerminalApp {
  return terminalAppsFor(platform)[0]!;
}

/**
 * 保存された値を、その OS で使える値に読み替える。
 * macOS で保存した設定を Windows で読んだとき（またはその逆）や、知らない値は、その OS の既定にする。
 */
export function terminalAppFor(value: unknown, platform: string): TerminalApp {
  const apps = terminalAppsFor(platform);
  return apps.includes(value as TerminalApp) ? (value as TerminalApp) : apps[0]!;
}
