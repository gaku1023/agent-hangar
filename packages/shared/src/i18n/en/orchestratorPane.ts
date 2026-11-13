import type { orchestratorPaneKeys } from '../keys/orchestratorPane.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const orchestratorPaneEn: AreaDictionary<typeof orchestratorPaneKeys> = {
  'orchestratorPane.pillar.region': 'Orchestrator',
  'orchestratorPane.pillar.open': 'Open orchestrator',
  'orchestratorPane.pillar.close': 'Close orchestrator',
  'orchestratorPane.log.label': 'Conversation with the orchestrator',
  'orchestratorPane.approvals.label': 'Approved automatically',
  'orchestratorPane.composer.label': 'Message to the orchestrator',
  'orchestratorPane.composer.placeholder': 'Talk to the orchestrator',
  'orchestratorPane.composer.send': 'Send',
  'orchestratorPane.error.notRunning': 'The orchestrator is not running',
  'orchestratorPane.error.sendFailed': 'Could not send to the orchestrator: {reason}',
};
