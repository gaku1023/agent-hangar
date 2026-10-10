import type { MessageSpec } from '../messageSpec.ts';

export const artifactKeys = {
  'artifact.error.addFailed': [],
  'artifact.error.notFound': [],
  'artifact.url.invalid': [],
  'artifact.url.notArtifact': [],
} as const satisfies MessageSpec;
