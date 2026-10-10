import type { httpKeys } from '../keys/http.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const httpJa: AreaDictionary<typeof httpKeys> = {
  'http.auth.expired': '認証が切れました。ページを再読み込みしてください',
  'http.request.badContentType': '要求の形式が正しくありません',
  'http.request.tooLarge': '本文が大きすぎます（上限は {limit} です）',
  'http.request.notJson': '本文が JSON ではありません',
  'http.request.badShape': '本文の形が違います',
  'http.entry.title': '認証できていません',
  'http.entry.openFromUrl': '{command} が印字した鍵付きの URL から開いてください。',
  'http.entry.printUrl': 'その URL は、ターミナルで {command} を実行すれば何度でも出せます。',
  'http.entry.cookieStays': '一度そこから開けば、このブラウザには鍵が残ります。次からはブックマークでそのまま開けます。',
};
