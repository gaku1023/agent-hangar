import { fireEvent, screen, within } from '@testing-library/react';

/** 選択肢の組の名前から、それを開く札（data-chip）。「モデル」は選んだエージェントで札が替わる。 */
const CHIPS: Record<string, string[]> = {
  プロジェクト: ['project'],
  PC: ['pc'],
  エージェント: ['agent'],
  アカウント: ['account'],
  権限モード: ['perm'],
  effort: ['effort'],
  モデル: ['model', 'ocModel', 'cxModel'],
  モード: ['ocMode'],
  自動承認: ['ocAuto'],
  権限: ['cxPerm'],
  推論の強さ: ['cxEffort'],
};

/** 札の列にある札。無ければ null。 */
export function chipOf(name: string): HTMLElement | null {
  for (const k of CHIPS[name] ?? []) {
    const el = document.querySelector<HTMLElement>(`[data-chip="${k}"]`);
    if (el) return el;
  }
  return null;
}

/** 選択肢の組。シートが開いていなければ、札を押して開く（選ぶとシートは閉じる）。 */
export function group(name: string): HTMLElement {
  const open = screen.queryByRole('radiogroup', { name });
  if (open) return open;
  const chip = chipOf(name);
  if (!chip) throw new Error(`札が無い: ${name}`);
  fireEvent.click(chip);
  return screen.getByRole('radiogroup', { name });
}

/** 札を押して、シートの中から選ぶ。 */
export const pick = (groupName: string, option: RegExp | string): void => {
  fireEvent.click(within(group(groupName)).getByRole('radio', { name: option }));
};
