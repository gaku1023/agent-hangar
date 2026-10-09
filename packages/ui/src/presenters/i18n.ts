import { languageOf, translator, type Language, type Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';

/**
 * いまの言語。設定（この PC の `SettingsDto.language`）から読む。
 * 設定が届く前と、項目を知らない古いサーバにつないだときは、既定の日本語になる。
 */
export const storeLanguage = (store: Store): Language => languageOf(store.settings?.language);

/**
 * Presenter が辞書を引くための関数。
 * Presenter は `(state, store, now)` の純関数なので、言語を引数に足さず、store から受け取る。
 * 同じ言語には同じ関数が返る。
 */
export const translatorOf = (store: Store): Translate => translator(storeLanguage(store));
