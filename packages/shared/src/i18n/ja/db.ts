import type { dbKeys } from '../keys/db.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const dbJa: AreaDictionary<typeof dbKeys> = {
  'db.backup.failed': 'DB のバックアップを {file} に作成できなかったため、マイグレーションを適用せずに停止しました（{cause}）。ディレクトリへの書き込み権限と空き容量を確認してください',
  'db.backup.symlink': 'backups/db がシンボリックリンクのため、バックアップを作成しません',
  'db.open.tooOld': 'DB（{file}）はバージョン {found} です。このアプリが開けるのはバージョン {baseline} 以降です。このバージョンからは更新できないため、DB を変更せず、マイグレーションも適用せずに停止しました。DB を別の名前に退避してから、このアプリを再起動してください。インデックスは Claude Code のトランスクリプトから再構築します（名前とステータスは引き継げません）',
};
