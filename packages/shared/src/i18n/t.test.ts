import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';
import { MESSAGES, type MessageKey } from './keys.ts';
import { DEFAULT_LANGUAGE, isLanguage, LANGUAGES, languageOf } from './language.ts';
import { placeholdersOf, t, translator } from './t.ts';

const keys = Object.keys(MESSAGES) as MessageKey[];
const dictionaries = { ja, en };

describe('言語', () => {
  it('日本語と英語の 2 つで、既定は日本語', () => {
    expect([...LANGUAGES]).toEqual(['ja', 'en']);
    expect(DEFAULT_LANGUAGE).toBe('ja');
  });
  it('知らない値は言語と認めず、既定へ寄せる', () => {
    expect(isLanguage('ja')).toBe(true);
    expect(isLanguage('en')).toBe(true);
    for (const v of ['fr', 'JA', '', null, undefined, 1, {}]) {
      expect([v, isLanguage(v)]).toEqual([v, false]);
      expect([v, languageOf(v)]).toEqual([v, 'ja']);
    }
    expect(languageOf('en')).toBe('en');
  });
});

describe('辞書', () => {
  it('日本語と英語は、鍵の一覧と同じ鍵をちょうど持つ', () => {
    for (const lang of LANGUAGES) expect([lang, Object.keys(dictionaries[lang]).sort()]).toEqual([lang, [...keys].sort()]);
  });
  it('鍵は 画面.部品.意味 の形である', () => {
    for (const key of keys) expect(key).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){2,}$/);
  });
  it('どの言語の文も、鍵の一覧に書いた引数をちょうど使う', () => {
    // 文にあるのに一覧に無い名前は、呼び手が渡せないので {n} のまま画面に出る。
    // 一覧にあるのに文に無い名前は、渡した値が黙って捨てられる。
    for (const lang of LANGUAGES) {
      for (const key of keys) expect([lang, key, placeholdersOf(dictionaries[lang][key])]).toEqual([lang, key, [...MESSAGES[key]].sort()]);
    }
  });
  it('英語の辞書に、かなと漢字が残っていない', () => {
    // 訳し忘れは、日本語のまま英語の画面と Claude への指示に出る。
    for (const key of keys) expect([key, /[\u3040-\u30ff\u4e00-\u9fff]/.test(en[key])]).toEqual([key, false]);
  });
  it('英語の文は、用語集で別の語に決めた言い方を使わない', () => {
    // 左の語は、用語集の「今の画面の語」に当たる英語の言い方。右は、代わりに使う語（用語集の英語の列）。
    // 鍵の名前や引数の名前は文の中に出ないので、文だけを見る。
    const retired: [RegExp, string][] = [
      [/\bscratch\b/i, 'quick session'],
      [/\bmemo\b/i, 'note'],
      [/\bworkspace\b/i, 'projects folder'],
      [/\bsummari[sz]er\b/i, 'summary engine'],
      [/\bstatusline\b/i, 'status line'],
      [/\badopt/i, 'move to Hangar'],
      [/\bbaton\b|\bconductor\b/i, 'main conversation'],
      [/\bquota\b/i, 'limit'],
    ];
    for (const key of keys) {
      const sentence = en[key].replace(/\{[A-Za-z0-9]+\}/g, '');
      for (const [bad, use] of retired) expect([key, bad.test(sentence), use]).toEqual([key, false, use]);
    }
    // 設定の項目名は、用語集の英語の列と同じ。サーバの文が項目を指すときに、画面と同じ名前になる。
    expect(en['settings.label.summaryHourlyCap']).toBe('Hourly limit for Claude summaries');
    expect(en['settings.label.workspaceRoot']).toBe('Projects folder');
    expect(en['settings.label.claudeDir']).toBe('Source directory');
    expect(en['settings.label.allowExternalSummarizer']).toBe('Allow external summary engines');
    expect(en['settings.label.summaryFallback']).toBe('Fall back to Claude when LM Studio is unavailable');
  });
  it('日本語と英語で、行の数が同じである', () => {
    // 何行かにわたる文（Claude に渡す指示、要約器への指示）は、1 行が 1 つの求めに当たる。行が減っていれば、求めを落としている。
    for (const key of keys) expect([key, en[key].split('\n').length]).toEqual([key, ja[key].split('\n').length]);
  });
  it('文は空でない', () => {
    for (const lang of LANGUAGES) for (const key of keys) expect([lang, key, dictionaries[lang][key].trim() !== '']).toEqual([lang, key, true]);
  });
});

describe('t', () => {
  /** 型を外した呼び方。JSON から来た鍵など、型の届かない呼び手を写す。 */
  const loose = t as (language: 'ja' | 'en', key: string, params?: Record<string, string | number>) => string;
  it('言語ごとの文を引く', () => {
    expect(t('ja', 'common.button.cancel')).toBe(ja['common.button.cancel']);
    expect(t('en', 'common.button.cancel')).toBe(en['common.button.cancel']);
    expect(t('ja', 'common.button.cancel')).not.toBe(t('en', 'common.button.cancel'));
  });
  it('{名前} を渡した値で置き換える', () => {
    expect(t('ja', 'sessions.list.count', { n: 3 })).toBe('3 件のセッション');
    expect(t('en', 'sessions.list.count', { n: 3 })).toBe('3 sessions');
    expect(t('ja', 'session.kill.confirm', { name: 'alpha' })).toContain('alpha');
  });
  it('値に {名前} の形が入っていても、もう一度は置き換えない', () => {
    expect(t('en', 'session.kill.confirm', { name: '{name}{n}' })).toBe('Stop "{name}{n}"?');
  });
  it('引数の数と名前は型で止まる', () => {
    // @ts-expect-error 引数の要る鍵に、引数を渡していない
    t('ja', 'sessions.list.count');
    // @ts-expect-error 引数の名前が違う
    t('ja', 'sessions.list.count', { count: 3 });
    // @ts-expect-error 引数の無い鍵に、引数を渡している
    t('ja', 'common.button.cancel', { n: 3 });
    // @ts-expect-error 辞書に無い鍵
    t('ja', 'no.such.key');
  });
  it('型をすり抜けて届いた、辞書に無い鍵は、鍵をそのまま返す', () => {
    // 空の文字列を出すより、何が抜けたかが画面から読める。
    expect(loose('ja', 'no.such.key')).toBe('no.such.key');
    // Object.prototype の名前を文として引かない。
    expect(loose('ja', 'toString')).toBe('toString');
  });
  it('型をすり抜けて引数が足りないときは、その {名前} を残す', () => {
    expect(loose('en', 'sessions.list.count')).toBe('{n} sessions');
    expect(loose('en', 'sessions.list.count', {})).toBe('{n} sessions');
  });
  it('知らない言語が届いたら、既定の言語で引く', () => {
    expect(t('fr' as 'ja', 'common.button.cancel')).toBe(ja['common.button.cancel']);
  });
});

describe('translator', () => {
  it('言語を束ねた関数を返す', () => {
    const tj = translator('ja');
    const te = translator('en');
    expect(tj('sessions.list.count', { n: 2 })).toBe('2 件のセッション');
    expect(te('sessions.list.count', { n: 2 })).toBe('2 sessions');
    expect(te('common.button.cancel')).toBe('Cancel');
  });
  it('同じ言語には同じ関数を返す', () => {
    // React の context の値や依存の配列に置いても、描くたびに変わらない。
    expect(translator('en')).toBe(translator('en'));
    expect(translator('ja')).not.toBe(translator('en'));
  });
});
