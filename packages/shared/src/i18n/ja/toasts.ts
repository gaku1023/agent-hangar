import type { toastsKeys } from '../keys/toasts.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const toastsJa: AreaDictionary<typeof toastsKeys> = {
  'toasts.more.view': 'ほか {n} 件をホームで見る',
  'toasts.waiting.label': '{name} が入力待ちです',
  'toasts.waiting.labelQuestion': '{name} が入力待ちです：{question}',
  'toasts.blocked.title': 'ダイアログを閉じてから操作してください',
  'toasts.waiting.head': '入力待ち',
  'toasts.info.head': 'お知らせ',
  'toasts.error.head': 'エラー',
  'toasts.error.more': '詳細',
  'toasts.opencodeVersion.head': '未検証のバージョン',
  'toasts.opencodeVersion.who': 'opencode {version}',
  'toasts.opencodeVersion.title': 'opencode {version} は未検証のバージョンです',
  'toasts.opencodeVersion.body': '検証済み：{range}。API の変更により、状態や権限確認が正しく表示されない可能性があります。',
  'toasts.opencodeVersion.settings': '設定を開く',
  'toasts.opencodeVersion.continue': 'このまま続行',
  'toasts.codexVersion.head': '未検証のバージョン',
  'toasts.codexVersion.who': 'codex {version}',
  'toasts.codexVersion.title': 'codex {version} は未検証のバージョンです',
  'toasts.codexVersion.body': '検証済み：{range}。app-server の変更により、状態や権限確認が正しく表示されない可能性があります。',
  'toasts.codexVersion.settings': '設定を開く',
  'toasts.codexVersion.continue': 'このまま続行',
};
