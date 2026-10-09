import type { MessageSpec } from '../messageSpec.ts';

export const sessionKeys = {
  'session.kill.confirm': ['name'],
  'session.error.notFound': [],
  'session.transcript.notOnThisComputer': [],
  'session.file.mustBeAbsolute': [],
  'session.file.notChanged': [],
  'session.status.noSuggestion': [],
  'session.status.invalid': [],
  'session.status.reasonMustBeString': [],
  'session.status.returnOnMustBeString': [],
  'session.status.returnTimeMustBeString': [],
  'session.status.noteEmpty': [],
  'session.status.noteTooLong': ['max'],
  'session.status.returnOnInvalid': [],
  'session.status.returnOnRequired': [],
  'session.status.returnTimeInvalid': ['value'],
} as const satisfies MessageSpec;
