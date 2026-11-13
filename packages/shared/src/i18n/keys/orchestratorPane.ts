import type { MessageSpec } from '../messageSpec.ts';

export const orchestratorPaneKeys = {
  'orchestratorPane.pillar.region': [],
  'orchestratorPane.pillar.open': [],
  'orchestratorPane.pillar.close': [],
  'orchestratorPane.log.label': [],
  'orchestratorPane.approvals.label': [],
  'orchestratorPane.composer.label': [],
  'orchestratorPane.composer.placeholder': [],
  'orchestratorPane.composer.send': [],
  'orchestratorPane.error.notRunning': [],
  'orchestratorPane.error.sendFailed': ['reason'],
} as const satisfies MessageSpec;
