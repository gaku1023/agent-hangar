import { describe, expect, it } from 'vitest';
import { translatorOf } from '../i18n/message.ts';
import { buildHandoff, HANDOFF_MEMO_MAX, HANDOFF_USER_WORDS } from './handoff.ts';

const tr = translatorOf(() => 'ja');

describe('buildHandoff', () => {
  it('前の会話の id、動いている会話、預かりの問い、方針、利用者の言葉、メモを順に並べる', () => {
    const text = buildHandoff(tr, {
      previousId: 'orch-1',
      active: [{ id: 's1', title: 'ビルドを直す' }],
      asks: [{ kind: 'ask.permission', id: 's2', title: '移行' }],
      policy: '読むのと検索は許してよい',
      userWords: ['あれどうなった？', 'PR をマージして'],
      memo: 's1 の CI を見ている',
    });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^\[hangar\] .*orch-1/);
    expect(text).toContain('- s1 「ビルドを直す」');
    expect(text).toContain('- ask.permission s2 「移行」');
    expect(text).toContain('許可の方針: 読むのと検索は許してよい');
    expect(text.indexOf('あれどうなった？')).toBeLessThan(text.indexOf('PR をマージして'));
    expect(text).toContain('s1 の CI を見ている');
    expect(text.indexOf('ビルドを直す')).toBeLessThan(text.indexOf('移行'));
    expect(text.indexOf('移行')).toBeLessThan(text.indexOf('許可の方針'));
    expect(text.indexOf('許可の方針')).toBeLessThan(text.indexOf('PR をマージして'));
    expect(text.indexOf('PR をマージして')).toBeLessThan(text.indexOf('s1 の CI'));
  });

  it('空の節は出さず、メモが無ければ無いと書く', () => {
    const text = buildHandoff(tr, { previousId: 'orch-1', active: [], asks: [], policy: null, userWords: [], memo: null });
    expect(text).not.toContain('実行中の会話');
    expect(text).not.toContain('答えを待っている');
    expect(text).not.toContain('許可の方針');
    expect(text).not.toContain('ユーザーの最近の言葉');
    expect(text).toContain('申し送りは無い');
  });

  it('利用者の言葉は末尾の 3 つにし、1 行に詰める。メモは上限で切る', () => {
    const text = buildHandoff(tr, { previousId: 'p', active: [], asks: [], policy: null, userWords: ['一', '二', '三', '四\n改行'], memo: 'x'.repeat(HANDOFF_MEMO_MAX + 50) });
    expect(HANDOFF_USER_WORDS).toBe(3);
    expect(text).not.toContain('- 一');
    expect(text).toContain('- 四 改行');
    expect(text).toContain('x'.repeat(HANDOFF_MEMO_MAX));
    expect(text).not.toContain('x'.repeat(HANDOFF_MEMO_MAX + 1));
  });

  it('題名の改行は 1 行に詰める', () => {
    const text = buildHandoff(tr, { previousId: 'p', active: [{ id: 's1', title: 'a\nb' }], asks: [], policy: null, userWords: [], memo: null });
    expect(text).toContain('- s1 「a b」');
  });
});
