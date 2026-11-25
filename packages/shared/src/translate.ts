/**
 * AI の英語の返答と思考を、表示する側でローカルの翻訳（PLaMo 翻訳）にかけて日本語で見せる。
 * エージェントには何も送らないので、会話の文脈は増えない。
 */

/** 設定 translateEnglish。この PC だけの設定で、項目が無ければ切として読む。 */
export const translateEnglishOf = (s: { translateEnglish?: boolean }): boolean => s.translateEnglish === true;

/**
 * 1 回に訳す文の長さの上限（文字数）。PLaMo 3 Translate は入力と出力を合わせて 32,768 トークンまでで学習しているので、
 * 出力の分を空けて、英語で 1 トークンおよそ 4 文字とみて余裕を取る。超える文は訳さず原文のまま見せる。
 */
export const TRANSLATE_MAX_CHARS = 40_000;

/** 地の文の英字がこれより少なければ訳さない（コマンド名だけ、OK だけの返答）。 */
const MIN_LETTERS = 24;
/** 地の文のうち、かなと漢字の文字がこの割合を超えれば日本語の文とみなす。 */
const MAX_CJK_RATIO = 0.1;

const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const URL = /https?:\/\/\S+/g;
const LATIN = /[A-Za-z]/g;
const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/g;

/** 訳す対象の英語の文か。コードの塊、インラインのコード、URL を除いた地の文で、英字が十分にあり、かなと漢字がほとんど無いものを英語とみなす。 */
export function isEnglishText(text: string): boolean {
  if (text.length > TRANSLATE_MAX_CHARS) return false;
  const prose = text.replace(CODE_FENCE, ' ').replace(INLINE_CODE, ' ').replace(URL, ' ');
  const letters = prose.match(LATIN)?.length ?? 0;
  if (letters < MIN_LETTERS) return false;
  const cjk = prose.match(CJK)?.length ?? 0;
  return cjk / (letters + cjk) <= MAX_CJK_RATIO;
}

/** POST /api/translate の答え。off は設定が切、unavailable は plamo-translate が無い（Windows も）。 */
export type TranslateResultDto =
  | { status: 'ok'; text: string }
  | { status: 'off' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };
