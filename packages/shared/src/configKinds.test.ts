import { describe, expect, it } from 'vitest';
import { CONFIG_KIND_KEYS, configKindModeOf, configKindsOf, isConfigKindsPatch, type ConfigKindKey } from './configKinds.ts';

describe('設定の同期の種類ごとの状態（configKinds）', () => {
  it('鍵は 20 の種類と会話の本文の 21 個', () => {
    expect(CONFIG_KIND_KEYS).toHaveLength(21);
    expect(new Set(CONFIG_KIND_KEYS).size).toBe(21);
    expect(CONFIG_KIND_KEYS).toContain('transcript');
  });

  it('既定は、自動で走るコードが確認、ほかは自動、会話の本文は自動', () => {
    const confirm: ConfigKindKey[] = ['claude-hooks', 'claude-statusline', 'plugins', 'claude-mcp', 'codex-mcp', 'opencode-mcp'];
    for (const k of CONFIG_KIND_KEYS) expect(configKindModeOf({}, k)).toBe(confirm.includes(k) ? 'confirm' : 'auto');
    expect(configKindModeOf(undefined, 'skills')).toBe('auto');
  });

  it('書かれた値を読み、形の悪い値と会話の本文の確認は既定に寄せる', () => {
    expect(configKindModeOf({ configKinds: { skills: 'off' } }, 'skills')).toBe('off');
    expect(configKindModeOf({ configKinds: { 'claude-hooks': 'auto' } }, 'claude-hooks')).toBe('auto');
    expect(configKindModeOf({ configKinds: { skills: 'nope' as never } }, 'skills')).toBe('auto');
    expect(configKindModeOf({ configKinds: { transcript: 'confirm' } }, 'transcript')).toBe('auto');
    expect(configKindModeOf({ configKinds: { transcript: 'off' } }, 'transcript')).toBe('off');
  });

  it('configKindsOf は 21 鍵を全部埋める', () => {
    const all = configKindsOf({ configKinds: { skills: 'off' } });
    expect(Object.keys(all).sort()).toEqual([...CONFIG_KIND_KEYS].sort());
    expect(all.skills).toBe('off');
    expect(all['claude-hooks']).toBe('confirm');
  });

  it('isConfigKindsPatch は知っている鍵と取れる値だけを通す', () => {
    expect(isConfigKindsPatch({ skills: 'off', 'claude-hooks': 'auto', transcript: 'off' })).toBe(true);
    expect(isConfigKindsPatch({})).toBe(true);
    expect(isConfigKindsPatch({ transcript: 'confirm' })).toBe(false);
    expect(isConfigKindsPatch({ nope: 'off' })).toBe(false);
    expect(isConfigKindsPatch({ skills: true })).toBe(false);
    expect(isConfigKindsPatch(null)).toBe(false);
    expect(isConfigKindsPatch([])).toBe(false);
  });
});

