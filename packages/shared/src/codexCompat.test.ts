import { describe, expect, it } from 'vitest';
import { CODEX_INJECTIONS, CODEX_VERIFIED_RANGE, codexEnabledOf, codexInjectionOf, codexInterceptOf, DEFAULT_CODEX_INJECTION, isCodexInjection } from './codexCompat.ts';

describe('Codex の確かめた範囲と設定の読み方', () => {
  it('確かめた範囲は 0.165.x', () => {
    expect(CODEX_VERIFIED_RANGE).toBe('0.165.x');
  });
  it('有効と横取りのスイッチは、true のときだけ入りとして読む（古いサーバは項目を返さない）', () => {
    for (const f of [codexEnabledOf, codexInterceptOf] as const) {
      expect(f({})).toBe(false);
      expect(f({ codexEnabled: false, codexIntercept: false })).toBe(false);
    }
    expect(codexEnabledOf({ codexEnabled: true })).toBe(true);
    expect(codexInterceptOf({ codexIntercept: true })).toBe(true);
  });
  it('システムプロンプトへの追記は 3 つで、既定は最小限。無い項目と知らない値は既定に寄せる', () => {
    expect(CODEX_INJECTIONS).toEqual(['minimal', 'claude', 'none']);
    expect(DEFAULT_CODEX_INJECTION).toBe('minimal');
    expect(codexInjectionOf({})).toBe('minimal');
    expect(codexInjectionOf({ codexInjection: 'none' })).toBe('none');
    expect(codexInjectionOf({ codexInjection: 'full' as never })).toBe('minimal');
    for (const v of ['', 'Minimal', null, 1]) expect(isCodexInjection(v)).toBe(false);
  });
});
