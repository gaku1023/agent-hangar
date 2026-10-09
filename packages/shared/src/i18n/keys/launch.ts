import type { MessageSpec } from '../messageSpec.ts';

export const launchKeys = {
  'launch.injection.none': [],
  'launch.injection.body': ['memo', 'projectName', 'projectPath', 'todos'],
  'launch.mcpConfig.badId': [],
} as const satisfies MessageSpec;
