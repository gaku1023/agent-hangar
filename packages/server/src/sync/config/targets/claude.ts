import { collectLocal } from '../collect.ts';
import { parseClaudeItemId } from '../ids.ts';
import { CLAUDE_KEYS2_KEYS, CLAUDE_PLUGIN_KEYS } from '../settingsSort.ts';
import { planClaude, planClaudeOps, writeClaude } from '../apply.ts';
import type { ConfigItemKind } from '@agent-hangar/shared';
import { CLAUDE_STORE } from './stores.ts';
import { anyKindOn, type ConfigTarget } from './types.ts';

/** Claude Code（`~/.claude`）。今までの処理をそのまま持つ最初の対象。 */

/** この対象が運ぶ種類。settings は claude-keys2 にもまたがる。 */
const CLAUDE_KINDS: readonly ConfigItemKind[] = ['claude-md', 'settings', 'keybindings', 'skills', 'commands', 'agents', 'memory'];

export const CLAUDE_TARGET_NAME = 'claude';

// apply.ts は ids.ts を読み、ids.ts はこの対象の登録を読む。循環を避けるため、apply の関数は呼ぶときに引く。
export const claudeTarget: ConfigTarget = {
  name: CLAUDE_TARGET_NAME,
  // settings: のうち新しい鍵は claude-keys2、plugins の鍵は claude-plugins のもの（古い版が運ばない鍵は別の対象にする）。
  owns: (id) => id.startsWith('file:') || (id.startsWith('settings:') && !CLAUDE_KEYS2_KEYS.has(id.slice('settings:'.length)) && !CLAUDE_PLUGIN_KEYS.has(id.slice('settings:'.length))) || id.startsWith('memory:'),
  parseId: (id) => parseClaudeItemId(id),
  kinds: CLAUDE_KINDS,
  // 設定の同期そのものの入切は、サービスが送受信の前で見る。ここでは種類の状態だけを見る。
  enabled: (ctx) => anyKindOn(ctx, CLAUDE_KINDS),
  collect: (ctx) => collectLocal({ db: ctx.db, deviceId: ctx.deviceId, claudeDir: ctx.claudeDir, allowedUnsent: ctx.allowedUnsent, maxItems: ctx.maxItems }),
  planWrite: (o) => planClaude(o),
  write: (o) => writeClaude(o),
  planOps: (o, read) => planClaudeOps(o, read),
  store: CLAUDE_STORE,
  // 今の Claude の項目は、PC に依るものを collect の仕分け（settingsSort）の段で落としている。
  isMachineBound: () => false,
};
