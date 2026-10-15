import type { httpKeys } from '../keys/http.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const httpJa: AreaDictionary<typeof httpKeys> = {
  'http.auth.expired': '認証の有効期限が切れました。ページを再読み込みしてください',
  'http.request.badContentType': 'リクエストの形式が正しくありません',
  'http.request.tooLarge': 'リクエストボディが大きすぎます（上限は {limit} です）',
  'http.request.notJson': 'リクエストボディが JSON ではありません',
  'http.request.badShape': 'リクエストボディの構造が正しくありません',
  'http.entry.title': '認証されていません',
  'http.entry.openFromUrl': '{command} が出力したトークン付きの URL から開いてください。',
  'http.entry.printUrl': 'URL は、ターミナルで {command} を実行するといつでも表示できます。',
  'http.entry.cookieStays': '一度その URL から開くと、このブラウザに認証情報が保存されます。次回からはブックマークから直接開けます。',
};
