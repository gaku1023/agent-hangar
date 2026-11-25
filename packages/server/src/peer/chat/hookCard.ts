import type { HookDecisionInput } from '../../sessions/hookDecisions.ts';
import type { PeerPendingAsk } from './tail.ts';

/**
 * PermissionRequest の hook の入力から、札（PeerPendingAsk）を作る。
 * 画面から札が読めないとき（ファイルの道具の札、読めない形の札）の代わりに使う（hostView.ts）。
 * 答えは hook で返すので、画面の行は要らない。
 *
 * - 許可：道具と主な引数と、Yes と No の 2 行。「いつも許可」とモードを替える行は、hook で言えないので出さない。
 * - 質問：問いが 1 問のときだけ。選択肢のラベルと説明（description）と、自由な文（Type something の行）を持つ。問いが複数ある質問は、画面の札（タブ）に任せる。
 * 札にできない入力（主な引数が読めない道具、形の違う質問）は null にする。どの札とも照合できないからである。
 */
export function pendingAskFromHook(d: HookDecisionInput, description: string | null): PeerPendingAsk | null {
  if (d.tool === 'AskUserQuestion') {
    const qs = (d.toolInput as { questions?: unknown } | null)?.questions;
    if (!Array.isArray(qs) || qs.length !== 1) return null;
    const q = qs[0] as { question?: unknown; multiSelect?: unknown; options?: unknown };
    if (typeof q.question !== 'string' || q.question === '' || !Array.isArray(q.options)) return null;
    const labels = q.options.map((o) => (o as { label?: unknown } | null)?.label);
    if (labels.length === 0 || labels.some((l) => typeof l !== 'string' || l === '')) return null;
    const options = (labels as string[]).map((label, i) => {
      const desc = (q.options as { description?: unknown }[])[i]?.description;
      return typeof desc === 'string' && desc !== '' ? { key: String(i + 1), label, description: desc } : { key: String(i + 1), label };
    });
    return { kind: 'question', tool: 'AskUserQuestion', input: q.question, question: q.question, options, multi: q.multiSelect === true, allowText: true };
  }
  if (d.input === '') return null;
  return { kind: 'permission', tool: d.tool, input: d.input, description, options: [{ key: 'allow', label: 'Yes' }, { key: 'deny', label: 'No' }], multi: false, allowText: false };
}
