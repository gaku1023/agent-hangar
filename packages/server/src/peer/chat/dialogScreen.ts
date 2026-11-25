/**
 * Codex と opencode の札を画面から読む二つの読み手（codexDialog.ts、opencodeDialog.ts）の共通の部品。
 * 画面は capture-pane -p -e の文字列（SGR 付き）。色は読み手が必要なときだけ見る。
 */

import type { AgentAnswerValue, AgentAskChoice, AgentAskQuestion } from '../../agent/pendingAsk.ts';

/**
 * 画面に打つキー。名前のあるキーは 'enter' | 'escape' | 'right' | 'left' | 'down' | 'up' | 'tab'。
 * それ以外は、1 文字をそのまま打つ（'y'、'a'、'1' など）。
 * 既存の PaneKey（tmux/pane.ts）は 'ctrl+o' | 'enter' | 'escape' | 'down' だけなので、配線のときに広げるか、1 文字は sendText で打つ。
 */
export type ScreenKey = string;

const SGR = /\x1b\[[0-9;:]*m/g;

export function stripSgr(s: string): string {
  return s.replace(SGR, '');
}

/** SGR を落とし、行末の空白を除いた行。 */
export function plainLines(screen: string): string[] {
  return stripSgr(screen)
    .split('\n')
    .map((l) => l.replace(/[\s\r]+$/, ''));
}

/** 空白を全部除く。折り返しで空白が増減しても同じ文を同じと見るため。 */
export const squash = (s: string): string => s.replace(/\s+/g, '');

/** `bash -lc '…'` のような包みを外す。外れなければそのまま。 */
export function unwrapShell(cmd: string): string {
  const m = /^\s*(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+(?:-[a-z]*c)\s+(['"])([\s\S]*)\1\s*$/.exec(cmd);
  return m ? m[2]! : cmd;
}

/** 命令の文を照合のために整える（包みを外し、空白を除く）。 */
export const commandKey = (cmd: string): string => squash(unwrapShell(cmd));

/** 空でない最後の n 行の、plain の中での添字の下限（それより前は札の外とみなす）。 */
export function lastNonBlankIndexes(lines: string[], n: number): number[] {
  const out: number[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) if (lines[i]!.trim() !== '') out.push(i);
  return out;
}

/** 選択肢の label を照合のために整える。 */
export const labelKey = (s: string): string => squash(s).toLowerCase();

/**
 * 選択肢 1 つを選ぶだけの質問か。複数選択、自由記述、伏せた値、選択肢の無い問いは、画面の道で答えない。
 */
export function isSingleChoiceQuestion(q: AgentAskQuestion): boolean {
  return q.kind === 'choice' && !q.multi && !q.secret && !q.hidden && q.options.length > 0;
}

/** 答え（問いの id から値）から、選ばれた選択肢を 1 つ取り出す。1 つに決まらなければ null。 */
export function chosenOption(q: AgentAskQuestion, answer: AgentAnswerValue | undefined): AgentAskChoice | null {
  if (typeof answer !== 'string') return null;
  return q.options.find((o) => o.key === answer) ?? q.options.find((o) => o.label === answer) ?? null;
}
