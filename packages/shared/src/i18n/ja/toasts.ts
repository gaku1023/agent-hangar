import type { toastsKeys } from '../keys/toasts.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const toastsJa: AreaDictionary<typeof toastsKeys> = {
  'toasts.more.view': 'ほか {n} 件をホームで見る',
  'toasts.waiting.label': '{name} が入力待ちです',
  'toasts.waiting.labelQuestion': '{name} が入力待ちです：{question}',
  'toasts.blocked.title': 'ダイアログを閉じると開けます',
  'toasts.waiting.head': '入力待ち',
  'toasts.info.head': 'お知らせ',
  'toasts.error.head': 'エラー',
  'toasts.error.more': '詳しく',
};
