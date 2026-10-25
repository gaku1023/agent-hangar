import type { systemKeys } from '../keys/system.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const systemJa: AreaDictionary<typeof systemKeys> = {
  'system.index.rebuildFailed': 'インデックスの再構築に失敗しました: {reason}',
  'system.opencode.disabled': 'opencode が有効になっていません。',
  'system.opencode.optionsFailed': 'opencode から一覧を取得できませんでした: {reason}',
  'system.opencode.providersFailed': 'opencode に問い合わせできませんでした: {reason}',
  'system.opencode.providers.unknownProvider': 'opencode にこのプロバイダーがありません。',
  'system.opencode.providers.emptyKey': 'API キーを入力してください。',
  'system.opencode.providers.badName': '名前を入力してください。',
  'system.opencode.providers.badUrl': 'URL は http:// か https:// で始めてください。',
  'system.opencode.providers.badModel': 'モデル ID を入力してください。',
  'system.opencode.providers.modelsUnreachable': '/v1/models からモデル一覧を取得できませんでした。URL と API キーを確認してください。',
  'system.opencode.providers.noModels': 'サーバーがモデルを返しませんでした。',
  'system.opencode.providers.loginUnsupported': 'このプロバイダーには hangar からログインできません。opencode でログインしてください。',
  'system.opencode.providers.configUnreadable': 'opencode.json を読み取れないため、変更しませんでした。',
};
