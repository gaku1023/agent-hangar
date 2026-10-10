import type { configKeys } from '../keys/config.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const configJa: AreaDictionary<typeof configKeys> = {
  'config.lock.busy': 'Claude Code が設定を書いている最中のようです。閉じてからもう一度試してください。',
  'config.file.symlinkTooDeep': '{file} のシンボリックリンクが深すぎます。',
  'config.file.brokenJson': '{file} を読めませんでした。JSON として壊れています。',
  'config.file.notObject': '{file} の中身がオブジェクトではありません。',
  'config.file.unreadableFormat': '設定ファイルの書式を読み取れなかったので書き換えませんでした',
};
