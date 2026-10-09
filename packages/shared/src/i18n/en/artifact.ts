import type { artifactKeys } from '../keys/artifact.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const artifactEn: AreaDictionary<typeof artifactKeys> = {
  'artifact.error.addFailed': 'Could not add the artifact',
  'artifact.error.notFound': 'Artifact not found',
  'artifact.url.invalid': 'The URL format is not valid',
  'artifact.url.notArtifact': 'Enter the URL of a claude.ai artifact',
};
