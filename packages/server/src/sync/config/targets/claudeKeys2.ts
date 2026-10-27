import { collectLocal } from '../collect.ts';
import { parseClaudeItemId } from '../ids.ts';
import { planApply, runApply } from '../apply.ts';
import { CLAUDE_KEYS2_APPROVAL, CLAUDE_KEYS2_KEYS } from '../settingsSort.ts';
import type { ConfigTarget } from './types.ts';

/**
 * Claude の新しい settings.json の鍵（0.12、設計書 5 章）。
 * 古い版の PC はこれらの鍵を運ばない。古い版の束を受けたとき、これらの鍵が「相手の束に無い」＝消去に見えないよう、
 * claude とは別の対象にする。claude より前に登録し、claude.owns からは外す（先に当たった対象が持ち主）。
 * id は今までどおり `settings:<鍵>`。書き方も claude と同じ（~/.claude/settings.json の鍵を差し替える）。
 * 入切は設定の `configTargets`（対象名→真偽）で、既定は切。入れる画面は U1 で作る。
 */
export const CLAUDE_KEYS2_NAME = 'claude-keys2';
export { CLAUDE_KEYS2_KEYS };

const keyOf = (id: string): string | null => (id.startsWith('settings:') ? id.slice('settings:'.length) : null);

export const claudeKeys2Target: ConfigTarget = {
  name: CLAUDE_KEYS2_NAME,
  owns: (id) => { const k = keyOf(id); return k !== null && CLAUDE_KEYS2_KEYS.has(k); },
  parseId: (id) => parseClaudeItemId(id),
  enabled: (ctx) => ctx.switches?.[CLAUDE_KEYS2_NAME] === true,
  collect: (ctx) => collectLocal({ db: ctx.db, deviceId: ctx.deviceId, claudeDir: ctx.claudeDir, allowedUnsent: ctx.allowedUnsent, scope: 'keys2' }),
  planWrite: (o) => planApply(o),
  write: (o) => runApply(o),
  // 承諾の仕方の設定（each か auto）に従う。権限を広げうる鍵は、消去（deniedMcpServers を外すなど）も承諾に掛ける。
  needsApproval: (item, approval) => approval === 'each' && (() => { const k = keyOf(item.id); return k !== null && CLAUDE_KEYS2_APPROVAL.has(k); })(),
  isMachineBound: () => false,
};
