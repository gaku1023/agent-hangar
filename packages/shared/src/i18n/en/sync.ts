import type { syncKeys } from '../keys/sync.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const syncEn: AreaDictionary<typeof syncKeys> = {
  'sync.error.notConfigured': 'Cloud sync is not set up',
  'sync.note.sessionReplaced': 'The session note was replaced with the newer content from {deviceName}. Your local content is kept in {backupFile}',
  'sync.note.conflict': 'The note had a conflict. Your local content is kept in {file}',
  'sync.once.done': 'Synced once. Sync is still paused',
  'sync.once.leftBoth': 'Synced once, but {pending} unsent changes and {transcripts} unsent transcripts remain. Sync is still paused',
  'sync.once.leftChanges': 'Synced once, but {pending} unsent changes remain. Sync is still paused',
  'sync.once.leftTranscripts': 'Synced once, but {transcripts} unsent transcripts remain. Sync is still paused',
  'sync.resume.noTranscript': "This session's transcript was not found",
};
