import type { retentionDialogKeys } from '../keys/retentionDialog.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const retentionDialogJa: AreaDictionary<typeof retentionDialogKeys> = {
  'retentionDialog.period.days': '{n} 日',
  'retentionDialog.period.oneDay': '1 日',
  'retentionDialog.period.years': '{n} 年',
  'retentionDialog.period.oneYear': '1 年',
  'retentionDialog.title.shrink': 'トランスクリプトの保持期間を {period}に縮めます',
  'retentionDialog.title.set': 'トランスクリプトの保持期間を {period}にします',
  'retentionDialog.lead.replace': 'Claude Code の設定ファイルの、次の 1 行を書き換えます。',
  'retentionDialog.lead.add': 'Claude Code の設定ファイルに、次の 1 行を追加します。',
  'retentionDialog.notice.reloaded': '設定ファイルが外部で変更されたため、再読み込みしました。',
  'retentionDialog.diff.loading': '差分を読み込んでいます',
  'retentionDialog.notice.shrink': '次に Claude Code を使い始めたとき、セッションのトランスクリプト {n} 件が削除されます。',
  'retentionDialog.info.backup': 'バックアップ',
  'retentionDialog.info.otherPcs': '他の PC',
  'retentionDialog.info.otherPcsNote': '設定の同期で、次の適用時に届きます',
  'retentionDialog.info.deleted': '削除済みのトランスクリプト',
  'retentionDialog.info.deletedNote': '復元できません。これから先のトランスクリプトが残ります',
  'retentionDialog.footer.other': 'ほかの期間…',
  'retentionDialog.footer.write': '書き込み',
  'retentionDialog.bar.now': 'いま {size}',
  'retentionDialog.bar.projected': '{period}たつと約 {size}',
  'retentionDialog.bar.free': '空き {size}',
  'retentionDialog.bar.freeUnknown': '空きは分かりません',
};
