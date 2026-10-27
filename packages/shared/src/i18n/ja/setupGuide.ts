import type { setupGuideKeys } from '../keys/setupGuide.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const setupGuideJa: AreaDictionary<typeof setupGuideKeys> = {
  'setupGuide.prompt.line': '{path}（v{version} sha256:{sha}）を読んで、私の環境を診断して。書き換えは私が承認してから',
  'setupGuide.error.missing': 'セットアップのすゝめがアプリに同梱されていません',
};
