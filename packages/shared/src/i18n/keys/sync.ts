import type { MessageSpec } from '../messageSpec.ts';

export const syncKeys = {
  'sync.error.notConfigured': [],
  'sync.note.sessionReplaced': ['backupFile', 'deviceName'],
  'sync.note.conflict': ['file'],
  'sync.once.compatBlocked': [],
  'sync.once.done': [],
  'sync.once.leftBoth': ['pending', 'transcripts'],
  'sync.once.leftChanges': ['pending'],
  'sync.once.leftTranscripts': ['transcripts'],
  'sync.pull.failed': ['kind', 'reason'],
  'sync.resume.noTranscript': [],
} as const satisfies MessageSpec;
