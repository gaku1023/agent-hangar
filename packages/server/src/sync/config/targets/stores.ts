import os from 'node:os';
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
