import type { artifactKeys } from '../keys/artifact.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const artifactJa: AreaDictionary<typeof artifactKeys> = {
  'artifact.error.addFailed': 'アーティファクトを追加できませんでした',
  'artifact.error.notFound': 'アーティファクトが見つかりません',
  'artifact.url.invalid': 'URL の形式が正しくありません',
  'artifact.url.notArtifact': 'claude.ai のアーティファクトの URL を入力してください',
};
