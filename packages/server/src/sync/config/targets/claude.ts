import { collectLocal } from '../collect.ts';
import { parseClaudeItemId } from '../ids.ts';
import { CLAUDE_KEYS2_KEYS, CLAUDE_PLUGIN_KEYS, isPermissionKey } from '../settingsSort.ts';
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
  // settings: のうち新しい鍵は claude-keys2、plugins の鍵は claude-plugins のもの（古い版が運ばない鍵は別の対象にする）。
  owns: (id) => id.startsWith('file:') || (id.startsWith('settings:') && !CLAUDE_KEYS2_KEYS.has(id.slice('settings:'.length)) && !CLAUDE_PLUGIN_KEYS.has(id.slice('settings:'.length))) || id.startsWith('memory:'),
  parseId: (id) => parseClaudeItemId(id),
  // 設定の同期そのものの入切は、サービスが送受信の前で見る。対象ごとの入切は、後の対象から持つ。
  enabled: () => true,
  collect: (ctx) => collectLocal({ db: ctx.db, deviceId: ctx.deviceId, claudeDir: ctx.claudeDir, allowedUnsent: ctx.allowedUnsent, maxItems: ctx.maxItems }),
  planWrite: (o) => planApply(o),
  write: (o) => runApply(o),
  // 実行する指示（skills など）は消去を除く。権限の鍵は、消去も承諾に掛ける（deny を外すと許可が広がる。SPEC 4 章）。
  needsApproval: (item, approval) => approval === 'each' && ((item.op !== 'delete' && EXEC_KINDS.has(item.kind)) || isPermissionKey(item.id.startsWith('settings:') ? item.id.slice('settings:'.length) : '')),
  // 今の Claude の項目は、PC に依るものを collect の仕分け（settingsSort）の段で落としている。
  isMachineBound: () => false,
};
