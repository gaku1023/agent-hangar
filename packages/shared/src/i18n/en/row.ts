import type { rowKeys } from '../keys/row.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const rowEn: AreaDictionary<typeof rowKeys> = {
  'row.mark.pr': 'PR #{n}',
  'row.mark.prPlain': 'PR',
  'row.mark.note': 'Has a note',
};
