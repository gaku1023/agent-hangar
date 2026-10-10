import type { commonKeys } from '../keys/common.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const commonEn: AreaDictionary<typeof commonKeys> = {
  'common.button.cancel': 'Cancel',
  'common.field.send': 'Send {field}',
  'common.field.sendString': 'Send {field} as a string',
  'common.field.required': '{field} is required',
  'common.field.mustBeString': '{field} must be a string',
  'common.field.needed': '{field} is needed',
  'common.field.mustBeBoolean': '{field} must be true or false',
  'common.file.sourceMissing': 'The original file was not found',
  'common.list.or': ' or ',
  'common.list.separator': ', ',
  'common.chip.nameValue': '{name}: {value}',
  'common.popover.details': 'Details',
  'common.label.uncategorized': 'Uncategorized',
};
