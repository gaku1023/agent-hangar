import type { retentionDialogKeys } from '../keys/retentionDialog.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const retentionDialogEn: AreaDictionary<typeof retentionDialogKeys> = {
  'retentionDialog.period.days': '{n} days',
  'retentionDialog.period.oneDay': '1 day',
  'retentionDialog.period.years': '{n} years',
  'retentionDialog.period.oneYear': '1 year',
  'retentionDialog.title.shrink': 'Shorten the transcript retention period to {period}',
  'retentionDialog.title.set': 'Set the transcript retention period to {period}',
  'retentionDialog.lead.replace': 'The following line in the Claude Code settings file will be rewritten.',
  'retentionDialog.lead.add': 'The following line will be added to the Claude Code settings file.',
  'retentionDialog.notice.reloaded': 'The settings file changed elsewhere and was reloaded.',
  'retentionDialog.diff.loading': 'Loading the diff',
  'retentionDialog.notice.shrink': 'The next time you start Claude Code, session transcripts will be deleted: {n}.',
  'retentionDialog.info.backup': 'Backup',
  'retentionDialog.info.otherPcs': 'Other computers',
  'retentionDialog.info.otherPcsNote': 'Arrives with settings sync the next time it is applied',
  'retentionDialog.info.deleted': 'Deleted transcripts',
  'retentionDialog.info.deletedNote': 'They cannot be recovered. Transcripts from now on are kept',
  'retentionDialog.footer.other': 'Other periods…',
  'retentionDialog.footer.write': 'Write',
  'retentionDialog.bar.now': 'Now {size}',
  'retentionDialog.bar.projected': 'About {size} after {period}',
  'retentionDialog.bar.free': '{size} free',
  'retentionDialog.bar.freeUnknown': 'Free space unknown',
};
