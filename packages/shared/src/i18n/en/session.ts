import type { sessionKeys } from '../keys/session.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const sessionEn: AreaDictionary<typeof sessionKeys> = {
  'session.kill.confirm': 'Stop "{name}"?',
  'session.error.notFound': 'Session not found',
  'session.transcript.notOnThisComputer': "This session's transcript is not on this computer",
  'session.file.mustBeAbsolute': 'Send file as an absolute path string',
  'session.file.notChanged': 'This session did not change that file',
  'session.status.noSuggestion': 'This session has no suggestion to review',
  'session.status.invalid': 'Status must be paused, done, archived, or null to mark as Active',
  'session.status.reasonMustBeString': 'Reason must be a string',
  'session.status.returnOnMustBeString': 'Reminder date must be a string in YYYY-MM-DD format',
  'session.status.returnTimeMustBeString': 'Reminder time must be a string in HH:MM format',
  'session.status.noteEmpty': 'The one-sentence reason is empty',
  'session.status.noteTooLong': 'Reason must be {max} characters or fewer',
  'session.status.returnOnInvalid': 'Reminder date must be a real calendar date in YYYY-MM-DD format',
  'session.status.returnOnRequired': 'Paused needs a reminder date',
  'session.status.returnTimeInvalid': 'Reminder time must be in HH:MM format, from 00:00 to 23:59 ({value})',
};
