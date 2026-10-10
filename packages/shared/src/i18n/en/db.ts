import type { dbKeys } from '../keys/db.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const dbEn: AreaDictionary<typeof dbKeys> = {
  'db.backup.failed': 'Could not save a database backup to {file}, so startup stopped without applying migrations ({cause}). Check that the folder is writable and has free space',
  'db.backup.symlink': 'backups/db is a symbolic link, so no backup was made',
  'db.open.tooOld': 'The database ({file}) is at version {found}, but this app can only open version {baseline} or later. There is no longer an upgrade path from older versions, so the database was left untouched and no migrations were applied. Launch an earlier Hangar that can upgrade it to version {baseline} once, then start this app again',
};
