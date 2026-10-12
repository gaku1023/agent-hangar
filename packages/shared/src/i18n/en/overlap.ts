import type { overlapKeys } from '../keys/overlap.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const overlapEn: AreaDictionary<typeof overlapKeys> = {
  'overlap.band.chip': 'Same file {n}',
  'overlap.pop.title': 'Editing the same files',
  'overlap.card.summary': 'is also editing {files} (last 10 min)',
  'overlap.sidebar.title': 'Editing the same files as {names}',
  'overlap.table.file': 'File',
  'overlap.table.mine': 'This session',
  'overlap.table.theirs': 'Other session',
  'overlap.table.alternating': 'Alternating',
  'overlap.pop.note': 'Only Edit and Write calls are counted. Changes made with Bash aren’t included.',
  'overlap.worktree.hint': 'To run sessions side by side, use a worktree so they don’t overwrite each other’s changes.',
  'overlap.worktree.action': 'New session in a worktree',
  'overlap.pop.dismiss': 'Don’t show for these files',
  'overlap.pop.open': 'Open',
  'overlap.card.details': 'Details',
};
