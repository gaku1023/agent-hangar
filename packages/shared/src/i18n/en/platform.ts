import type { platformKeys } from '../keys/platform.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const platformEn: AreaDictionary<typeof platformKeys> = {
  'platform.capture.stdoutTooLarge': 'Standard output exceeded the limit ({max} bytes)',
  'platform.capture.timeout': 'No response within {ms} ms',
};
