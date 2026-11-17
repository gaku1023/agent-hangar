import type { orchestratorPaneKeys } from '../keys/orchestratorPane.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const orchestratorPaneJa: AreaDictionary<typeof orchestratorPaneKeys> = {
  'orchestratorPane.pillar.region': '統括',
  'orchestratorPane.pillar.open': '統括を開く',
  'orchestratorPane.pillar.close': '統括を閉じる',
  'orchestratorPane.log.label': '統括との会話',
  'orchestratorPane.approvals.label': '自動で許可したもの',
  'orchestratorPane.composer.label': '統括へのメッセージ',
  'orchestratorPane.composer.placeholder': '統括に話しかける',
  'orchestratorPane.composer.send': '送る',
  'orchestratorPane.width.label': '統括の幅',
  'orchestratorPane.error.notRunning': '統括は実行中ではありません',
  'orchestratorPane.error.voiceUnavailable': 'この PC では声を使えません',
  'orchestratorPane.error.sendFailed': '統括へ送れませんでした: {reason}',
  'orchestratorPane.error.engineOpen': '声のエンジンを開けませんでした: {reason}',
  'orchestratorPane.preview.sample': '{name} です。この声で読み上げます。',
};
