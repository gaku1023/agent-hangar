import type { MessageSpec } from '../messageSpec.ts';

export const commonKeys = {
  'common.button.cancel': [],
  'common.field.send': ['field'],
  'common.field.sendString': ['field'],
  'common.field.required': ['field'],
  'common.field.mustBeString': ['field'],
  'common.field.needed': ['field'],
  'common.field.mustBeBoolean': ['field'],
  'common.file.sourceMissing': [],
  'common.list.or': [],
  'common.list.separator': [],
  'common.chip.nameValue': ['name', 'value'],
  'common.popover.details': [],
  'common.label.uncategorized': [],
} as const satisfies MessageSpec;
