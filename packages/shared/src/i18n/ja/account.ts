import type { accountKeys } from '../keys/account.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const accountJa: AreaDictionary<typeof accountKeys> = {
  'account.error.notFound': 'アカウントが見つかりません',
  'account.error.primaryNotRemovable': '最初のアカウントは消せません',
  'account.request.nameAndDir': 'name（文字列）と、任意で dir（絶対パス）を送ってください',
  'account.login.alreadyRunning': 'このアカウントのログインは、もう始まっています。ブラウザで承認してください',
  'account.switch.sameAccount': 'このセッションはもうそのアカウントで動いています',
  'account.switch.noTranscript': 'このセッションにはまだ本文がありません。そのアカウントで新しいセッションを始めてください',
  'account.switch.background': 'バックグラウンドのセッションは、アカウントを切り替えられません。止めてから、そのアカウントで再開してください',
  'account.switch.previousStillRunning': '前の Claude がまだ終わっていません。少し待ってから、もう一度切り替えてください',
  'account.name.required': 'アカウントの名前を入れてください',
  'account.name.tooLong': 'アカウントの名前は {max} 字までです',
  'account.name.duplicate': '同じ名前のアカウントがあります: {name}',
  'account.dir.mustBeAbsolute': '置き場は絶対パスで指定してください',
  'account.dir.alreadyRegistered': 'この置き場はもう登録されています: {dir}',
  'account.color.invalid': '色は #rrggbb（小文字）で指定してください',
  'account.links.conflict': '置き場の {names} が共有のリンクではありません。中身を確かめて、要らなければ消してください',
};
