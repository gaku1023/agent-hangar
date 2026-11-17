import type { PeerChatAsk } from '@agent-hangar/shared';
import type { HookChoice } from '../../sessions/hookDecisions.ts';

/**
 * 札に打つ答え（選んだ行のラベルと自由な文）を、PermissionRequest の hook の答えに読み替える。
 * hook で言えない答えは null で、画面のキーで打つ（answer.ts）。
 *
 * - 許可：Yes は allow、No（「No, and tell Claude…」も）は deny。
 *   「いつも許可」とモードを替える行は、持続やモードの変更が hook の allow で落ちるおそれがあるので画面で打つ。
 * - 質問：選んだラベルか自由な文。複数選択は ", " でつなぐ（Claude Code 2.1.326 で確かめた）。
 *   問いが複数ある札のタブ（step）は、答えを 1 回でまとめて返す形になるので、画面で打つ。
 */
export function hookChoiceOf(ask: PeerChatAsk, labels: string[], text: string | undefined): HookChoice | null {
  if (ask.kind === 'permission') {
    if (labels.length !== 1 || text) return null;
    const l = labels[0]!.trim();
    if (/^yes$/i.test(l)) return { kind: 'permission', behavior: 'allow' };
    if (/^no\b/i.test(l)) return { kind: 'permission', behavior: 'deny' };
    return null;
  }
  if (ask.step) return null;
  const parts = [...labels, ...(text ? [text] : [])];
  if (parts.length === 0) return null;
  return { kind: 'question', value: parts.join(', ') };
}
