import type { MessageSpec } from '../messageSpec.ts';

export const systemKeys = {
  'system.index.rebuildFailed': ['reason'],
  'system.opencode.disabled': [],
  'system.opencode.optionsFailed': ['reason'],
  'system.opencode.providersFailed': ['reason'],
  'system.opencode.providers.unknownProvider': [],
  'system.opencode.providers.emptyKey': [],
  'system.opencode.providers.badName': [],
  'system.opencode.providers.badUrl': [],
  'system.opencode.providers.badModel': [],
  'system.opencode.providers.modelsUnreachable': [],
  'system.opencode.providers.noModels': [],
  'system.opencode.providers.loginUnsupported': [],
  'system.opencode.providers.configUnreadable': [],
} as const satisfies MessageSpec;
