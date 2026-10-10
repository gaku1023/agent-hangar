import type { configSyncKeys } from '../keys/configSync.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const configSyncEn: AreaDictionary<typeof configSyncKeys> = {
  'configSync.error.unknownItem': '"{id}" is not among the incoming changes',
  'configSync.error.held': '"{id}" cannot be applied on this PC (there is no matching project, or a file of the same name here cannot be synced)',
  'configSync.error.badTake': '"{id}" is not a conflict, so keeping your own side is not an option',
  'configSync.error.duplicate': '"{id}" appears more than once',
  'configSync.error.emptyOrder': 'No items were selected to apply',
  'configSync.error.unsentNotFound': 'The unsent item "{id}" was not found',
  'configSync.error.badBody': 'The request body is malformed',
};
