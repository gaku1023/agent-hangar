import { en } from './en.ts';
import { ja } from './ja.ts';
import type { Dictionary, MessageArgs, MessageKey } from './keys.ts';
import { languageOf, LANGUAGES, type Language } from './language.ts';

const DICTIONARIES: Record<Language, Dictionary> = { ja, en };
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** 文の中の `{名前}` の名前を、重ねずに名前の順で返す。 */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();
}

/**
 * 辞書から文を引き、`{名前}` を渡された値で置き換える。UI とサーバが同じこの関数で引く。
 * 鍵と引数は型で決まる。型をすり抜けて届いたものは落とさずに、辞書に無い鍵は鍵のまま、渡されなかった引数は `{名前}` のまま返す。
 * 置き換えは 1 回だけ走るので、値の中の `{名前}` は置き換わらない。
 */
export function t<K extends MessageKey>(language: Language, key: K, ...args: MessageArgs<K>): string {
  const dict = DICTIONARIES[languageOf(language)];
  if (!Object.hasOwn(dict, key)) return key;
  const params = args[0] as Record<string, string | number> | undefined;
  return dict[key].replace(PLACEHOLDER, (whole, name: string) => (params && Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** 言語を束ねた `t()`。Presenter と View はこの形で受け取る。 */
export type Translate = <K extends MessageKey>(key: K, ...args: MessageArgs<K>) => string;

const TRANSLATORS = Object.fromEntries(LANGUAGES.map((language) => [language, ((key, ...args) => t(language, key, ...args)) as Translate])) as Record<Language, Translate>;

/** その言語で引く関数。同じ言語には同じ関数を返すので、React の context の値にそのまま置ける。 */
export const translator = (language: Language): Translate => TRANSLATORS[languageOf(language)];
