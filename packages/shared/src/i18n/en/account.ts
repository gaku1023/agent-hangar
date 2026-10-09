import type { accountKeys } from '../keys/account.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const accountEn: AreaDictionary<typeof accountKeys> = {
  'account.error.notFound': 'Account not found',
  'account.error.primaryNotRemovable': 'The primary account cannot be removed',
  'account.request.nameAndDir': 'Send name (a string) and, optionally, dir (an absolute path)',
  'account.login.alreadyRunning': 'Login for this account has already started. Approve it in your browser',
  'account.switch.sameAccount': 'This session is already running on that account',
  'account.switch.noTranscript': 'This session has no transcript yet. Start a new session on that account',
  'account.switch.background': 'A background session cannot switch accounts. Stop it, then resume it on that account',
  'account.switch.previousStillRunning': 'The previous Claude has not ended yet. Wait a moment, then switch again',
  'account.name.required': 'Enter an account name',
  'account.name.tooLong': 'Account name must be {max} characters or fewer',
  'account.name.duplicate': 'An account with the same name already exists: {name}',
  'account.dir.mustBeAbsolute': 'Config directory must be an absolute path',
  'account.dir.alreadyRegistered': 'This config directory is already registered: {dir}',
  'account.color.invalid': 'Color must be in #rrggbb format (lowercase)',
  'account.links.conflict': 'These items in the config directory are not shared links: {names}. Check their contents and delete them if they are not needed',
};
