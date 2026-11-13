import { collectLocal } from '../collect.ts';
import { parseClaudeItemId } from '../ids.ts';
import { planClaude, planClaudeOps, writeClaude } from '../apply.ts';
import { CLAUDE_STORE } from './stores.ts';
import { CLAUDE_KEYS2_KEYS } from '../settingsSort.ts';
import { anyKindOn, type ConfigTarget } from './types.ts';

/**
 * Claude の新しい settings.json の鍵（0.12、設計書 5 章）。
 * 古い版の PC はこれらの鍵を運ばない。古い版の束を受けたとき、これらの鍵が「相手の束に無い」＝消去に見えないよう、
 * claude とは別の対象にする。claude より前に登録し、claude.owns からは外す（先に当たった対象が持ち主）。
 * id は今までどおり `settings:<鍵>`。書き方も claude と同じ（~/.claude/settings.json の鍵を差し替える）。
 * 有効かは種類 settings の状態（configKinds）で決まる。
 */
export const CLAUDE_KEYS2_NAME = 'claude-keys2';
export { CLAUDE_KEYS2_KEYS };

const keyOf = (id: string): string | null => (id.startsWith('settings:') ? id.slice('settings:'.length) : null);

export const claudeKeys2Target: ConfigTarget = {
  name: CLAUDE_KEYS2_NAME,
  owns: (id) => { const k = keyOf(id); return k !== null && CLAUDE_KEYS2_KEYS.has(k); },
  parseId: (id) => parseClaudeItemId(id),
  kinds: ['settings'],
  enabled: (ctx) => anyKindOn(ctx, ['settings']),
  collect: (ctx) => collectLocal({ db: ctx.db, deviceId: ctx.deviceId, claudeDir: ctx.claudeDir, allowedUnsent: ctx.allowedUnsent, scope: 'keys2' }),
  // 書き方は claude と同じ関数で、claude の項目もまとめて書く。適用は writesWith で 1 回だけ呼ぶ。
  writesWith: 'claude',
  planWrite: (o) => planClaude(o),
  write: (o) => writeClaude(o),
  planOps: (o, read) => planClaudeOps(o, read),
  store: CLAUDE_STORE,
  isMachineBound: () => false,
};
