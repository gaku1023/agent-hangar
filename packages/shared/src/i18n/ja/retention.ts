import type { retentionKeys } from '../keys/retention.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const retentionJa: AreaDictionary<typeof retentionKeys> = {
  'retention.days.invalid': '保持期間は 1 以上 36500 以下の整数で指定してください',
  'retention.preview.fingerprintMissing': '下見の指紋がありません',
  'retention.unwritable.unreadable': '設定ファイルを読み取れないので書き換えません',
  'retention.unwritable.managed': '組織の設定で決まっています',
  'retention.unwritable.noDir': '設定の置き場が見つからないので書き換えません',
  'retention.unwritable.generic': '保持期間を書き換えられません',
  'retention.error.conflict': '設定ファイルがほかで変わったので、読み直しました',
  'retention.backup.noFreeName': '控えを置く名前が空いていません',
};
