import type { configKeys } from '../keys/config.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const configJa: AreaDictionary<typeof configKeys> = {
  'config.lock.busy': 'Claude Code が設定を書き込み中の可能性があります。Claude Code を閉じてから、もう一度試してください。',
  'config.file.symlinkTooDeep': '{file} のシンボリックリンクが深すぎます。',
  'config.file.brokenJson': '{file} を読み込めませんでした。JSON の形式が正しくありません。',
  'config.file.notObject': '{file} の内容がオブジェクトではありません。',
  'config.file.unreadableFormat': '設定ファイルの形式を読み取れないため、変更しませんでした',
};
