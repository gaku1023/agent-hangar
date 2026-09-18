import type { LaunchInput } from '../provider/types.ts';

export function mcpConfigJson(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { hangar: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
}

/**
 * claude の引数列を組み立てる。
 * --mcp-config と --add-dir は可変長オプションで直後の位置引数を飲み込むので先頭に置き、
 * 初期プロンプトは必ず末尾に置く。
 */
export function buildClaudeArgs(input: LaunchInput): string[] {
  const a: string[] = ['--mcp-config', mcpConfigJson(input.mcpUrl, input.token)];
  for (const d of input.addDirs ?? []) if (d) a.push('--add-dir', d);
  const m = input.mode;
  if (m.kind === 'start') a.push('--session-id', m.sessionUuid);
  else if (m.kind === 'resume') a.push('-r', m.sessionUuid);
  else a.push('-r', m.sessionUuid, '--fork-session', '--session-id', m.newSessionUuid);
  if (input.name) a.push('-n', input.name);
  a.push('--append-system-prompt', input.systemPrompt);
  if (input.model) a.push('--model', input.model);
  if (input.effort) a.push('--effort', input.effort);
  if (input.permissionMode) a.push('--permission-mode', input.permissionMode);
  if (input.worktree) a.push('-w', input.worktree);
  if (input.prompt) a.push(input.prompt);
  return a;
}
