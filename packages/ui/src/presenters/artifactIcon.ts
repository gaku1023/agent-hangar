/**
 * アーティファクトの札の頭に描く絵の名前。Artifact ツールの icon（英単語 1 語）をここに当てる。
 * 絵そのもの（lucide）は views/primitives/Icon.tsx の ARTIFACT_GLYPHS が持つ。
 * 語は Claude が自由に選ぶので、会話の記録で見かけた語と、ツールの説明の例（chart、calendar、recipe、code、map）を拾う。
 */
export const ARTIFACT_ICONS = [
  'document', 'chart', 'checklist', 'clipboard', 'notebook', 'book', 'mail', 'inbox', 'calendar', 'diagram', 'map',
  'image', 'game', 'phone', 'settings', 'wrench', 'terminal', 'code', 'shield', 'search', 'server', 'compare', 'math', 'flask', 'recipe',
] as const;
export type ArtifactIconName = (typeof ARTIFACT_ICONS)[number];

/** 名前と同じでない語の言い換え。 */
const ALIASES: Record<string, ArtifactIconName> = {
  doc: 'document', docs: 'document', file: 'document', report: 'document', page: 'document', article: 'document',
  dashboard: 'chart', graph: 'chart', stats: 'chart', analytics: 'chart', metrics: 'chart',
  list: 'checklist', todo: 'checklist', tasks: 'checklist',
  notes: 'notebook', note: 'notebook',
  schedule: 'calendar', timeline: 'calendar',
  flow: 'diagram', flowchart: 'diagram', architecture: 'diagram',
  photo: 'image', picture: 'image', design: 'image',
  mobile: 'phone',
  config: 'settings', gear: 'settings',
  tool: 'wrench', tools: 'wrench',
  shell: 'terminal', cli: 'terminal',
  security: 'shield',
  database: 'server',
  experiment: 'flask', science: 'flask',
};

const NAMES = new Set<string>(ARTIFACT_ICONS);

/** 語を絵の名前にする。知らない語、昔の絵文字、無しは文書にする。 */
export function artifactIconOf(word: string | null): ArtifactIconName {
  const w = word?.trim().toLowerCase() ?? '';
  if (NAMES.has(w)) return w as ArtifactIconName;
  return ALIASES[w] ?? 'document';
}
