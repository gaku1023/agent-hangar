import type { pagerKeys } from '../keys/pager.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const pagerJa: AreaDictionary<typeof pagerKeys> = {
  'pager.nav.label': '{label}のページ',
  'pager.range.total': '/ {total} 件',
  'pager.nav.prev': '前のページ',
  'pager.nav.next': '次のページ',
  'pager.nav.page': '{n} ページ目',
  'pager.jump.label': 'ページ',
  'pager.jump.input': 'ページの番号',
  'pager.size.label': '1 ページの件数',
  'pager.size.option': '{n} 件ずつ',
};
