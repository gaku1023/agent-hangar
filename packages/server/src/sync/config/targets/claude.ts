import { collectLocal } from '../collect.ts';
import { parseClaudeItemId } from '../ids.ts';
import { CLAUDE_KEYS2_KEYS } from '../settingsSort.ts';
import { planApply, runApply } from '../apply.ts';
import type { ConfigItemKind } from '@agent-hangar/shared';
import type { ConfigTarget } from './types.ts';

/** Claude Code（`~/.claude`）。今までの処理をそのまま持つ最初の対象。 */

/** 読んで実行される指示の種類。他の PC から届いたとき、設定が `each` なら承諾が要る。 */
const EXEC_KINDS = new Set<ConfigItemKind>(['skills', 'commands', 'agents']);

export const CLAUDE_TARGET_NAME = 'claude';

// apply.ts は ids.ts を読み、ids.ts はこの対象の登録を読む。循環を避けるため、apply の関数は呼ぶときに引く。
export const claudeTarget: ConfigTarget = {
  name: CLAUDE_TARGET_NAME,
  // settings: のうち新しい鍵は claude-keys2 のもの（古い版が運ばない鍵は別の対象にする）。
  owns: (id) => id.startsWith('file:') || (id.startsWith('settings:') && !CLAUDE_KEYS2_KEYS.has(id.slice('settings:'.length))) || id.startsWith('memory:'),
  parseId: (id) => parseClaudeItemId(id),
  // 設定の同期そのものの入切は、サービスが送受信の前で見る。対象ごとの入切は、後の対象から持つ。
  enabled: () => true,
  collect: (ctx) => collectLocal({ db: ctx.db, deviceId: ctx.deviceId, claudeDir: ctx.claudeDir, allowedUnsent: ctx.allowedUnsent, maxItems: ctx.maxItems }),
  planWrite: (o) => planApply(o),
  write: (o) => runApply(o),
  needsApproval: (item, approval) => item.op !== 'delete' && EXEC_KINDS.has(item.kind) && approval === 'each',
  // 今の Claude の項目は、PC に依るものを collect の仕分け（settingsSort）の段で落としている。
  isMachineBound: () => false,
};
