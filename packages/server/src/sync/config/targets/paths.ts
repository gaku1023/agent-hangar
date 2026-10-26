import os from 'node:os';
import path from 'node:path';
import { defaultCodexHome } from '../../../provider/codex/transcript/discover.ts';

/** 対象ごとの入れ物のパス。TargetContext のうち、Claude 以外の入れ物の分。 */
export type TargetPaths = {
  /** `$CODEX_HOME`、既定 `~/.codex`。 */
  codexHome: string;
  /** opencode の設定の置き場。`$XDG_CONFIG_HOME/opencode`、既定 `~/.config/opencode`。 */
  opencodeDir: string;
  /** 共通の skills の置き場、`~/.agents/skills`。 */
  agentsSkillsDir: string;
  /** Claude の `~/.claude.json`。 */
  claudeJsonPath: string;
};

/** この PC の入れ物のパス。試験は一時のディレクトリに向けて上書きする。 */
export function defaultTargetPaths(env: NodeJS.ProcessEnv = process.env, userHome: string = os.homedir()): TargetPaths {
  const xdg = env.XDG_CONFIG_HOME;
  return {
    codexHome: defaultCodexHome(env),
    opencodeDir: path.join(xdg !== undefined && xdg !== '' ? xdg : path.join(userHome, '.config'), 'opencode'),
    agentsSkillsDir: path.join(userHome, '.agents', 'skills'),
    claudeJsonPath: path.join(userHome, '.claude.json'),
  };
}
