import { PROJECT_RAIL_SECTIONS, type ProjectRailSection } from '@agent-hangar/shared';
import type { Input, State, Step } from './types.ts';

/** プロジェクト画面の右パネルで折りたたんだ節を残す localStorage の鍵。値はプロジェクトの id から、折りたたんだ節の並びへの表である。 */
export const PROJECT_RAIL_KEY = 'projectRail.folded';

/** 節の並びを画面の上からの順にそろえ、知らない名前と重なりを落とす。 */
const ordered = (xs: readonly unknown[]): ProjectRailSection[] => PROJECT_RAIL_SECTIONS.filter((s) => xs.includes(s));

/**
 * localStorage から読んだ値を整える。表でなければ空にし、節の並びでない値と、折りたたんだ節の無いプロジェクトは落とす。
 * 全部開いたプロジェクトは鍵ごと消すので、表は折りたたんだ節のあるプロジェクトの分だけで育つ。
 */
export function readProjectRailFolded(v: unknown): Record<string, ProjectRailSection[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, ProjectRailSection[]> = {};
  for (const [id, xs] of Object.entries(v)) {
    if (!Array.isArray(xs)) continue;
    const folded = ordered(xs);
    if (folded.length > 0) out[id] = folded;
  }
  return out;
}

/** 右パネルの節を開く・折りたたむ。プロジェクトごとに覚えて保存し、開き直しても同じ形で出す。形が変わらなければ何もしない。 */
export function projectRailStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action' || input.action.type !== 'project.railFold') return null;
  const { id, section, open } = input.action;
  const cur = state.projectRailFolded[id] ?? [];
  if (cur.includes(section) !== open) return { state, effects: [] };
  const next = ordered(open ? cur.filter((s) => s !== section) : [...cur, section]);
  const { [id]: _drop, ...rest } = state.projectRailFolded;
  const folded = next.length > 0 ? { ...rest, [id]: next } : rest;
  return { state: { ...state, projectRailFolded: folded }, effects: [{ kind: 'storage.save', key: PROJECT_RAIL_KEY, value: folded }] };
}
