import type { MessageSpec } from '../messageSpec.ts';

export const overlapKeys = {
  'overlap.band.chip': ['n'],
  'overlap.pop.title': [],
  'overlap.card.summary': ['files'],
  'overlap.sidebar.title': ['names'],
  'overlap.table.file': [],
  'overlap.table.mine': [],
  'overlap.table.theirs': [],
  'overlap.table.alternating': [],
  'overlap.pop.note': [],
  'overlap.worktree.action': [],
  'overlap.pop.dismiss': [],
  'overlap.card.details': [],
} as const satisfies MessageSpec;
