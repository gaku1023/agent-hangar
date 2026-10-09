import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_LANGUAGE, translator, type Language, type Translate } from '@agent-hangar/shared';

/**
 * いまの言語。Root が設定（`SettingsDto.language`）から 1 か所で決めて流す。
 * 頂点の無いところでは既定の日本語になるので、View だけを描く試験はそのまま日本語の文で走る。
 */
export const LanguageContext = createContext<Language>(DEFAULT_LANGUAGE);

export function LanguageRoot(props: { language: Language; children: ReactNode }) {
  return <LanguageContext.Provider value={props.language}>{props.children}</LanguageContext.Provider>;
}

export function useLanguage(): Language {
  return useContext(LanguageContext);
}

/**
 * View が自分の持つ決まった文（ボタンの名前など）を辞書から引くための関数。
 * データから作る文は Presenter が `translatorOf(store)` で引いて props に入れる。
 */
export function useT(): Translate {
  return translator(useContext(LanguageContext));
}
