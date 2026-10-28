import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENCODE_INJECTION, isOpencodeInjection, OPENCODE_INJECTIONS, OPENCODE_VERIFIED_RANGE, opencodeEnabledOf, opencodeInjectionOf, opencodeShareOf } from './opencodeCompat.ts';

describe('opencode の確かめた範囲', () => {
  it('確かめた範囲は 2.2.x', () => {
    expect(OPENCODE_VERIFIED_RANGE).toBe('2.2.x');
  });
});

describe('opencode の設定の読み方', () => {
  it('有効にするスイッチは、true のときだけ入りとして読む（古いサーバは項目を返さない）', () => {
    expect(opencodeEnabledOf({})).toBe(false);
    expect(opencodeEnabledOf({ opencodeEnabled: undefined })).toBe(false);
    expect(opencodeEnabledOf({ opencodeEnabled: false })).toBe(false);
    expect(opencodeEnabledOf({ opencodeEnabled: true })).toBe(true);
  });
  it('システムプロンプトへの追記は 3 つで、既定は最小限。無い項目と知らない値は既定に寄せる', () => {
    expect(OPENCODE_INJECTIONS).toEqual(['minimal', 'claude', 'none']);
    expect(DEFAULT_OPENCODE_INJECTION).toBe('minimal');
    expect(opencodeInjectionOf({})).toBe('minimal');
    expect(opencodeInjectionOf({ opencodeInjection: 'claude' })).toBe('claude');
    expect(opencodeInjectionOf({ opencodeInjection: 'none' })).toBe('none');
    expect(opencodeInjectionOf({ opencodeInjection: 'full' as never })).toBe('minimal');
  });
  it('isOpencodeInjection は 3 つの値だけを通す', () => {
    for (const v of OPENCODE_INJECTIONS) expect(isOpencodeInjection(v)).toBe(true);
    for (const v of ['', 'Minimal', 'full', null, undefined, 1, true]) expect(isOpencodeInjection(v)).toBe(false);
  });
});

describe('opencodeShareOf', () => {
  it('指示は入、MCP は切が既定で、真偽値でない値も既定に寄せる', () => {
    expect(opencodeShareOf({})).toEqual({ instructions: true, mcp: false });
    expect(opencodeShareOf({ opencodeShareInstructions: false, opencodeShareMcp: true })).toEqual({ instructions: false, mcp: true });
    expect(opencodeShareOf({ opencodeShareInstructions: 'no' as never, opencodeShareMcp: 1 as never })).toEqual({ instructions: true, mcp: false });
  });
});
