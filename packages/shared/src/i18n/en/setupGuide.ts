import type { setupGuideKeys } from '../keys/setupGuide.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const setupGuideEn: AreaDictionary<typeof setupGuideKeys> = {
  'setupGuide.prompt.line': 'Read {path} (v{version} sha256:{sha}) and diagnose my environment. Change nothing until I approve.',
  'setupGuide.error.missing': 'The setup guide is not bundled with this app',
  'setupGuide.launch.button': 'Diagnose with Agent…',
  'setupGuide.launch.title': 'Opens a new session prefilled with the diagnosis request.',
  'setupGuide.quote.line': '{name} ({state}): {text}',
};
