import { describe, expect, it } from 'vitest';
import { buildHints, hintContext } from './hints.ts';

describe('buildHints', () => {
  it('固定の語と一覧を含み、呼びかけ語の名前と読みは含めない', () => {
    const h = buildHints({ sessionTitles: ['認証の直し', 'ハンガー'], projectNames: ['agent-hangar'], callName: 'ハンガー' });
    expect(h).toContain('認証の直し');
    expect(h).toContain('agent-hangar');
    expect(h).toContain('Claude Code');
    expect(h).not.toContain('ハンガー');
    expect(h).not.toContain('はんがー');
  });
  it('呼びかけ語の読みも除く（名前と読みが違う人格）', () => {
    const h = buildHints({ sessionTitles: ['ミナ', 'みな', 'Mina'], projectNames: [], callName: 'Mina', callReading: 'みな' });
    expect(h).not.toContain('ミナ');
    expect(h).not.toContain('みな');
    expect(h).not.toContain('Mina');
  });
  it('重複を除き 60 語まで', () => {
    const titles = Array.from({ length: 100 }, (_, i) => `題${i}`).concat(['題1', '題1']);
    const h = buildHints({ sessionTitles: titles, projectNames: [], callName: 'ハンガー' });
    expect(h.length).toBe(60);
    expect(new Set(h).size).toBe(60);
  });
  it('hintContext はカンマ区切り', () => {
    expect(hintContext(['a', 'b'])).toBe('a, b');
  });
});
