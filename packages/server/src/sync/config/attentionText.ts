import type { Translate } from '@agent-hangar/shared';
import type { ConfigAttention } from './service.ts';

/**
 * 設定の同期の知らせ（ConfigAttention）の本文。新しく出た分だけを 1 行ずつ書き、改行でつなぐ。
 * 文言は仮で、Gemini に当てて直す（計画の T7）。
 */
export function configAttentionText(tr: Translate, e: ConfigAttention): string {
  const lines: string[] = [];
  if (e.asks > 0) lines.push(tr('sync.configNotice.ask', { count: e.asks }));
  if (e.conflicts > 0) lines.push(tr('sync.configNotice.conflict', { count: e.conflicts }));
  if (e.autoFailed) lines.push(tr('sync.configNotice.autoFailed'));
  return lines.join('\n');
}
