import { projectPageKey } from './paging.ts';
import type { Input, State, Step } from './types.ts';

/**
 * プロジェクト画面の節を広げる・畳む（P3）。末尾の Archived の行だけで、Done は畳まずにページ送りで見せる。
 * プロジェクトごとに覚え、画面を移っても戻れば広げたままにする。
 * 再起動すれば畳んだ形に戻る。Home の確かめるの「ほか N 件」と同じく見え方だけのもので、残す値ではないためである。
 */
export function sectionsStep(state: State, input: Input): Step | null {
  if (input.kind !== 'intent' || input.intent.type !== 'project.section.toggle') return null;
  const { projectId, section } = input.intent;
  const open = state.sectionsOpen[projectId] ?? [];
  const next = open.includes(section) ? open.filter((s) => s !== section) : [...open, section];
  const sectionsOpen = { ...state.sectionsOpen };
  if (next.length > 0) sectionsOpen[projectId] = next;
  else delete sectionsOpen[projectId];
  // 広げた行の並びが変わるので、ページ送りは 1 ページ目からにする。
  const { [projectPageKey(projectId)]: _drop, ...listPages } = state.listPages;
  return { state: { ...state, sectionsOpen, listPages }, effects: [] };
}
