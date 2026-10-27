import os from 'node:os';
import path from 'node:path';
import type { WritePaths } from '../apply.ts';
import { defaultTargetPaths } from './paths.ts';
import type { TargetStore } from './types.ts';

/**
 * 対象ごとの書き戻しの入れ物と、控えの世代の置き場（`<hangar の置き場>/backups/<backups>/<時刻>/`）。
 * 同じ入れ物に書く対象は、同じものを持つ（claude、claude-keys2、claude-hooks、claude-plugins は CLAUDE_STORE）。
 * 入れ物を省いたときは、この PC の既定の場所（殻と CLI は必ず渡す。試験は一時のディレクトリを渡す）。
 * ほかの対象のファイルを読まない葉の部品にしてある（対象の登録の循環に入れないため）。
 */
const defaults = (o: WritePaths) => defaultTargetPaths(process.env, o.userHome ?? os.homedir());

export const CLAUDE_STORE: TargetStore = { name: 'claude', backups: 'claude-config', root: (o) => o.claudeDir };
export const CODEX_STORE: TargetStore = { name: 'codex', backups: 'codex-config', root: (o) => o.codexHome ?? defaults(o).codexHome };
export const OPENCODE_STORE: TargetStore = { name: 'opencode', backups: 'opencode-config', root: (o) => o.opencodeDir ?? defaults(o).opencodeDir };
export const AGENTS_SKILLS_STORE: TargetStore = { name: 'agents-skills', backups: 'agents-skills-config', root: (o) => o.agentsSkillsDir ?? defaults(o).agentsSkillsDir };
// MCP の対象は、好みの鍵の対象と同じファイルに書くが、控えの世代は別の置き場に取る（古い版の世代の数え方を変えないため）。
export const CLAUDE_MCP_STORE: TargetStore = { name: 'claude-mcp', backups: 'claude-mcp-config', root: (o) => path.dirname(o.claudeJsonPath ?? defaults(o).claudeJsonPath) };
export const CODEX_MCP_STORE: TargetStore = { name: 'codex-mcp', backups: 'codex-mcp-config', root: (o) => o.codexHome ?? defaults(o).codexHome };
export const OPENCODE_MCP_STORE: TargetStore = { name: 'opencode-mcp', backups: 'opencode-mcp-config', root: (o) => o.opencodeDir ?? defaults(o).opencodeDir };
