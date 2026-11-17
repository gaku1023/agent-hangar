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
  'orchestratorPane.width.label': [],
  'orchestratorPane.error.notRunning': [],
  'orchestratorPane.error.off': [],
  'orchestratorPane.error.switching': [],
  'orchestratorPane.error.voiceUnavailable': [],
  'orchestratorPane.error.sendFailed': ['reason'],
  'orchestratorPane.error.engineOpen': ['reason'],
  'orchestratorPane.preview.sample': ['name'],
} as const satisfies MessageSpec;
