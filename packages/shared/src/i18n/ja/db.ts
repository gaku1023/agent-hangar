import type { dbKeys } from '../keys/db.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const dbJa: AreaDictionary<typeof dbKeys> = {
  'db.backup.failed': 'DB の控えを {file} に取れなかったので、マイグレーションを当てずに止めました（{cause}）。置き場に書けるか、空きがあるかを確かめてください',
  'db.backup.symlink': 'backups/db がシンボリックリンクなので控えを置きません',
  'db.open.tooOld': 'DB（{file}）は版 {found} で、このアプリが開けるのは版 {baseline} 以降です。古い版から上げる道はもう無いので、DB の中身は変えず、マイグレーションも当てずに止めました。版 {baseline} まで上げられる以前の版の Hangar で一度起動して DB を上げてから、このアプリをもう一度起動してください',
};
