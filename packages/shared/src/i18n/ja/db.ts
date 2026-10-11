import type { dbKeys } from '../keys/db.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const dbJa: AreaDictionary<typeof dbKeys> = {
  'db.backup.failed': 'DB のバックアップを {file} に作成できなかったので、マイグレーションを適用せずに停止しました（{cause}）。フォルダに書き込めるか、空き容量があるかを確認してください',
  'db.backup.symlink': 'backups/db がシンボリックリンクなので、バックアップを作成しません',
  'db.open.tooOld': 'DB（{file}）はバージョン {found} で、このアプリが開けるのはバージョン {baseline} 以降です。古いバージョンから更新する手段は無いので、DB の中身は変更せず、マイグレーションも適用せずに停止しました。DB を別の名前に退避してから、このアプリをもう一度起動してください。索引は Claude Code のトランスクリプトから再構築します（ノートとステータスは引き継げません）',
};
