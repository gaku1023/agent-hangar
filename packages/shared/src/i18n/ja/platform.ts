import type { platformKeys } from '../keys/platform.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const platformJa: AreaDictionary<typeof platformKeys> = {
  'platform.capture.stdoutTooLarge': '標準出力が上限（{max} バイト）を越えました',
  'platform.capture.timeout': '{ms} ミリ秒で応答がありませんでした',
};
