import type { MessageSpec } from '../messageSpec.ts';

export const pagerKeys = {
  'pager.nav.label': ['label'],
  'pager.range.total': ['total'],
  'pager.nav.prev': [],
  'pager.nav.next': [],
  'pager.nav.page': ['n'],
  'pager.jump.label': [],
  'pager.jump.input': [],
  'pager.size.label': [],
  'pager.size.option': ['n'],
} as const satisfies MessageSpec;
