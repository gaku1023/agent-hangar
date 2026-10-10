import type { promptKeys } from '../keys/prompt.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const promptJa: AreaDictionary<typeof promptKeys> = {
  'prompt.attachment.empty': '中身がありません',
  'prompt.builtin.init': 'CLAUDE.md を作ってコードベースを説明させる',
  'prompt.builtin.review': 'プルリクエストを審査する',
  'prompt.builtin.reviewHint': '[PR 番号]',
  'prompt.builtin.codeReview': 'いまの差分の誤りを探す',
  'prompt.builtin.securityReview': 'ブランチの変更の安全性を審査する',
  'prompt.builtin.loop': '指示を一定の間隔で繰り返す',
  'prompt.builtin.loopHint': '[間隔] <指示>',
  'prompt.builtin.schedule': '決まった時刻に動くクラウドのエージェントを作る',
};
