import type { systemKeys } from '../keys/system.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const systemEn: AreaDictionary<typeof systemKeys> = {
  'system.index.rebuildFailed': 'Failed to rebuild the index: {reason}',
  'system.opencode.disabled': 'opencode is not enabled.',
  'system.opencode.optionsFailed': 'Could not get the list from opencode: {reason}',
  'system.opencode.providersFailed': 'Could not reach opencode: {reason}',
  'system.opencode.providers.unknownProvider': 'opencode does not know this provider.',
  'system.opencode.providers.emptyKey': 'Enter an API key.',
  'system.opencode.providers.badName': 'Enter a name.',
  'system.opencode.providers.badUrl': 'The URL must start with http:// or https://.',
  'system.opencode.providers.badModel': 'Enter a model ID.',
  'system.opencode.providers.modelsUnreachable': 'Could not get the model list from /v1/models. Check the URL and API key.',
  'system.opencode.providers.noModels': 'The server returned no models.',
  'system.opencode.providers.loginUnsupported': 'hangar cannot sign in to this provider. Sign in from opencode.',
  'system.opencode.providers.configUnreadable': 'Could not read opencode.json, so it was not changed.',
};
