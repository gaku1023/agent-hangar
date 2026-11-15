import path from 'node:path';
import { t, type Language } from '@agent-hangar/shared';
import type { InjectionEntry } from '../agent/types.ts';

/** 統括の会話の名前。サイドバーと一覧に出る。 */
export const ORCHESTRATOR_NAME = 'Orchestrator';

/** 統括の cwd。hangar の置き場の下の専用のディレクトリで、どのプロジェクトにも属さない（docs/design.md「統括」）。 */
export function orchestratorCwd(home: string): string {
  return path.join(home, 'orchestrator');
}

/**
 * 統括自身が手を動かせなくする、run の settings の permissions。
 * 統括はほかの会話の文（インジェクションされうる）を読むので、読んだ文に動かされても、自分ではファイルにも shell にも触れないようにする。
 * allow は hangar の MCP の道具の全部で、許可の札を出さずに呼べる（出ると統括が自分の札で止まり、誰も答えられない）。
 */
export const ORCHESTRATOR_PERMISSIONS: { allow: readonly string[]; deny: readonly string[] } = {
  allow: ['mcp__hangar'],
  deny: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch'],
};

/** 役の文（システムプロンプトへの追記）。プロジェクトの段は足さず、これだけを渡す。 */
export function orchestratorInstructions(language: Language, persona?: { name: string; tone: string } | null): InjectionEntry[] {
  const base = t(language, 'launch.injection.orchestrator');
  // 人格は名前と口調だけを足す。口調が空なら何も足さない。権限と安全の文は人格で変えない（base の後ろに足すだけ）。
  const tone = persona?.tone.trim() ?? '';
  const extra = persona && tone !== '' ? t(language, 'launch.injection.orchestratorPersona', { name: persona.name, tone }) : '';
  return [{ key: 'orchestrator', text: base + extra }];
}
