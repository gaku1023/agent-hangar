import { DEFAULT_LANGUAGE, languageOf, type Language } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';

/**
 * いまの言語を返す関数。
 * 経路、MCP の道具、起動の管理は、これを依存として受け取り、文を出すたびに呼ぶ。
 * 起動のあとで設定を変えても、次の文から新しい言語になる。
 */
export type GetLanguage = () => Language;

/** 言語を渡されなかった呼び手が使う既定。日本語を返す。 */
export const defaultLanguage: GetLanguage = () => DEFAULT_LANGUAGE;

/**
 * 設定から言語を読む関数を作る。サーバが言語の設定を読むのは、ここだけである。
 * 項目が無い古い設定と、知らない値は、既定の日本語として読む。
 */
export const languageReader = (settings: () => Pick<Settings, 'language'>): GetLanguage => () => languageOf(settings().language);
