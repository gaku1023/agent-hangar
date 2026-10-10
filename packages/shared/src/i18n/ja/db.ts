import type { dbKeys } from '../keys/db.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const dbJa: AreaDictionary<typeof dbKeys> = {
  'db.backup.failed': 'DB のバックアップを {file} に作成できなかったので、マイグレーションを適用せずに停止しました（{cause}）。フォルダに書き込めるか、空き容量があるかを確認してください',
  'db.backup.symlink': 'backups/db がシンボリックリンクなので、バックアップを作成しません',
  'db.open.tooOld': 'DB（{file}）はバージョン {found} で、このアプリが開けるのはバージョン {baseline} 以降です。古いバージョンから更新する手段はもう無いので、DB の中身は変更せず、マイグレーションも適用せずに停止しました。バージョン {baseline} まで更新できる以前のバージョンの Hangar を一度起動して DB を更新してから、このアプリをもう一度起動してください',
};
