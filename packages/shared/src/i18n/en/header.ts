import type { headerKeys } from '../keys/header.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const headerEn: AreaDictionary<typeof headerKeys> = {
  'header.sync.off': 'Sync off',
  'header.sync.idle': 'Synced',
  'header.sync.synced': 'Synced {time}',
  'header.sync.preparing': 'Preparing sync',
  'header.sync.sending': 'Sending',
  'header.sync.receiving': 'Receiving',
  'header.sync.paused': 'Sync paused',
  'header.sync.once': 'Syncing once…',
  'header.sync.error': 'Sync error',
  'header.sync.failed': 'Sync failed',
  'header.sync.errorDetail': 'Sync error: {message}',
  'header.sync.pausedError': 'Sync paused · Sync error: {message}',
  'header.sync.pausedErrorShort': 'Sync paused · Sync error',
  'header.sync.limited': 'Paused at free tier limit · resets at {time}',
  'header.sync.pending': 'Unsent changes {n}',
  'header.sync.sweepPending': 'Unsent transcripts {n}',
  'header.sync.skipped': 'Failed transcripts {n}',
  'header.sync.title': '{text} (opens sync settings)',
  'header.sync.separator': ', ',
};
