/** 画面とサーバの文の言語。並びの先頭が既定である。 */
export const LANGUAGES = ['ja', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'ja';

export const isLanguage = (v: unknown): v is Language => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
/** 知らない値と、まだ値の無い古い設定は、既定の言語として読む。 */
export const languageOf = (v: unknown): Language => (isLanguage(v) ? v : DEFAULT_LANGUAGE);
