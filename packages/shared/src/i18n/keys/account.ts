import type { MessageSpec } from '../messageSpec.ts';

export const accountKeys = {
  'account.error.notFound': [],
  'account.error.primaryNotRemovable': [],
  'account.request.nameAndDir': [],
  'account.login.alreadyRunning': [],
  'account.switch.sameAccount': [],
  'account.switch.noTranscript': [],
  'account.switch.background': [],
  'account.switch.previousStillRunning': [],
  'account.name.required': [],
  'account.name.tooLong': ['max'],
  'account.name.duplicate': ['name'],
  'account.dir.mustBeAbsolute': [],
  'account.dir.alreadyRegistered': ['dir'],
  'account.color.invalid': [],
  'account.links.conflict': ['names'],
} as const satisfies MessageSpec;
