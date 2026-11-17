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
  'orchestratorPane.width.label': 'Orchestrator width',
  'orchestratorPane.menu.label': 'Orchestrator menu',
  'orchestratorPane.menu.fresh': 'Start new conversation',
  'orchestratorPane.menu.stop': 'Stop',
  'orchestratorPane.menu.wake': 'Resume',
  'orchestratorPane.status.switching': 'Switching…',
  'orchestratorPane.status.stoppedFailures': 'Stopped after errors (3 in 10 min)',
  'orchestratorPane.context.label': 'Context: {tokens} tokens',
  'orchestratorPane.error.notRunning': 'The orchestrator is not running',
  'orchestratorPane.error.off': 'The orchestrator is off',
  'orchestratorPane.error.switching': 'Switching to a new conversation',
  'orchestratorPane.error.voiceUnavailable': 'Voice is not available on this PC',
  'orchestratorPane.error.engineOpen': 'Could not open the voice engine: {reason}',
  'orchestratorPane.preview.sample': 'This is {name}. I will read aloud in this voice.',
  'orchestratorPane.error.sendFailed': 'Could not send to the orchestrator: {reason}',
};
