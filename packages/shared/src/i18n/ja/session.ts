import type { sessionKeys } from '../keys/session.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const sessionJa: AreaDictionary<typeof sessionKeys> = {
  'session.kill.confirm': '「{name}」を停止しますか',
  'session.error.notFound': 'セッションが見つかりません',
  'session.transcript.notOnThisComputer': 'このセッションの本文はこの PC にありません',
  'session.file.mustBeAbsolute': 'file は絶対パスの文字列で送ってください',
  'session.file.notChanged': 'このセッションが変更したファイルではありません',
  'session.status.noSuggestion': 'このセッションには確かめる提案がありません',
  'session.status.invalid': '状態は paused、done、archived か、Active に戻す null です',
  'session.status.reasonMustBeString': '理由は文字列です',
  'session.status.returnOnMustBeString': '戻る日は YYYY-MM-DD の形の文字列です',
  'session.status.returnTimeMustBeString': '戻る時刻は HH:MM の形の文字列です',
  'session.status.noteEmpty': '根拠の一文が空です',
  'session.status.noteTooLong': '理由は {max} 字までです',
  'session.status.returnOnInvalid': '戻る日は YYYY-MM-DD の形の、暦にある日付です',
  'session.status.returnOnRequired': 'Paused には戻る日が要ります',
  'session.status.returnTimeInvalid': '戻る時刻は HH:MM の形で、00:00〜23:59 です（{value}）',
};
