import { describe, expect, it } from 'vitest';
import type { SettingsDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { storeLanguage, translatorOf } from './i18n.ts';

const settings = (over: Partial<SettingsDto> = {}): SettingsDto => ({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: '', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null, ...over });
const withSettings = (s: SettingsDto | null): Store => ({ ...initialStore(), settings: s });

describe('Presenter から辞書を引く', () => {
  it('設定が届く前と、言語の項目が無い設定は、日本語で引く', () => {
    expect(storeLanguage(withSettings(null))).toBe('ja');
    expect(storeLanguage(withSettings(settings()))).toBe('ja');
    expect(translatorOf(withSettings(null))('sessions.list.count', { n: 3 })).toBe('3 件のセッション');
  });
  it('設定の言語で引く', () => {
    const store = withSettings(settings({ language: 'en' }));
    expect(storeLanguage(store)).toBe('en');
    const t = translatorOf(store);
    expect(t('common.button.cancel')).toBe('Cancel');
    expect(t('sessions.list.count', { n: 3 })).toBe('3 sessions');
  });
  it('設定が変われば、次に引く文も変わる', () => {
    // Presenter は描くたびに store から引き直すので、言語を持ち回す状態は要らない。
    const before = withSettings(settings({ language: 'ja' }));
    const after: Store = { ...before, settings: settings({ language: 'en' }) };
    expect(translatorOf(before)('common.button.cancel')).toBe('キャンセル');
    expect(translatorOf(after)('common.button.cancel')).toBe('Cancel');
  });
  it('知らない言語が届いたら、日本語で引く', () => {
    expect(storeLanguage(withSettings(settings({ language: 'fr' as 'ja' })))).toBe('ja');
  });
});
