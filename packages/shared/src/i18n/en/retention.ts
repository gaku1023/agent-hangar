import type { retentionKeys } from '../keys/retention.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const retentionEn: AreaDictionary<typeof retentionKeys> = {
  'retention.days.invalid': 'Retention period must be an integer from 1 to 36500',
  'retention.preview.fingerprintMissing': 'The preview fingerprint is missing',
  'retention.unwritable.unreadable': 'The settings file cannot be read, so it will not be changed',
  'retention.unwritable.managed': "It is set by your organization's settings",
  'retention.unwritable.noDir': 'The settings directory was not found, so it will not be changed',
  'retention.unwritable.generic': 'The retention period cannot be changed',
  'retention.error.conflict': 'The settings file was changed elsewhere, so it was reloaded',
  'retention.backup.noFreeName': 'No free name is left for the backup',
};
