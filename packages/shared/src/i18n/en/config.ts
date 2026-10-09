import type { configKeys } from '../keys/config.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const configEn: AreaDictionary<typeof configKeys> = {
  'config.lock.busy': 'Claude Code seems to be writing its settings right now. Close it and try again.',
  'config.file.symlinkTooDeep': 'The symbolic links for {file} are nested too deep.',
  'config.file.brokenJson': 'Could not read {file}. It is not valid JSON.',
  'config.file.notObject': 'The contents of {file} are not an object.',
  'config.file.unreadableFormat': 'The format of the settings file could not be read, so it was not changed',
};
