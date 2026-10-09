import type { pagerKeys } from '../keys/pager.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const pagerEn: AreaDictionary<typeof pagerKeys> = {
  'pager.nav.label': '{label} pages',
  'pager.range.total': 'of {total}',
  'pager.nav.prev': 'Previous page',
  'pager.nav.next': 'Next page',
  'pager.nav.page': 'Page {n}',
  'pager.jump.label': 'Page',
  'pager.jump.input': 'Page number',
  'pager.size.label': 'Items per page',
  'pager.size.option': '{n} per page',
};
