import { describe, expect, it } from 'vitest';
import { translator } from './t.ts';

// ホームの始める前の確認の翻訳の行（2026-11-25 の試作の H1）の文言は、ja と en の両方に要る。
const KEYS = [
  'home.ready.name.translate', 'home.ready.translate.text', 'home.ready.translate.enable', 'home.ready.translate.install',
  'home.ready.translate.decline', 'home.ready.translate.request',
] as const;

describe('翻訳の行の文言', () => {
  for (const lang of ['ja', 'en'] as const) {
    it(`${lang} の辞書に全部ある`, () => {
      const t = translator(lang);
      for (const k of KEYS) expect(t(k).trim(), k).not.toBe('');
    });
  }
  it('ja と en で別の文になっている', () => {
    const ja = translator('ja');
    const en = translator('en');
    for (const k of KEYS) expect(ja(k), k).not.toBe(en(k));
  });
});
