import type { retentionKeys } from '../keys/retention.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const retentionJa: AreaDictionary<typeof retentionKeys> = {
  'retention.days.invalid': '保持期間は 1 以上 36500 以下の整数で指定してください',
  'retention.preview.fingerprintMissing': 'プレビューのフィンガープリントがありません',
  'retention.unwritable.unreadable': '設定ファイルを読み取れないため、変更できません',
  'retention.unwritable.managed': '組織の設定で管理されています',
  'retention.unwritable.noDir': '設定の保存先のディレクトリが見つからないため、変更できません',
  'retention.unwritable.generic': '保持期間を変更できません',
  'retention.error.conflict': '設定ファイルが外部で変更されたため、再読み込みしました',
  'retention.backup.noFreeName': 'バックアップに使えるファイル名がありません',
};
