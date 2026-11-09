import { describe, expect, it } from 'vitest';
import { mcpEn } from './i18n/en/mcp.ts';
import { mcpJa } from './i18n/ja/mcp.ts';
import { CLAUDE_PERMISSION_MODE_VALUES, isPeerLaunchPermission, peerLaunchPermissionChoices, PERMISSION_MODE_VALUES } from './launchChoices.ts';

describe('別の PC への起動で受ける権限の値', () => {
  it('Claude Code は新規ダイアログの値に加えて default を受け、ダイアログの値は変わらない', () => {
    expect(CLAUDE_PERMISSION_MODE_VALUES).toContain('default');
    for (const v of PERMISSION_MODE_VALUES) expect(CLAUDE_PERMISSION_MODE_VALUES).toContain(v);
    expect(PERMISSION_MODE_VALUES).not.toContain('default');
  });

  it('エージェントごとに権限の値を検査する', () => {
    expect(isPeerLaunchPermission({ agent: 'claude-code', permissionMode: 'default' })).toBe(true);
    expect(isPeerLaunchPermission({ agent: 'claude-code', permissionMode: '' })).toBe(true);
    expect(isPeerLaunchPermission({ agent: 'claude-code', permissionMode: 'rm -rf' })).toBe(false);
    expect(isPeerLaunchPermission({ agent: 'codex', permissionMode: 'full-access' })).toBe(true);
    expect(isPeerLaunchPermission({ agent: 'codex', permissionMode: '', mode: 'read-only' })).toBe(true);
    expect(isPeerLaunchPermission({ agent: 'codex', permissionMode: 'default' })).toBe(false);
    expect(isPeerLaunchPermission({ agent: 'opencode', permissionMode: '' })).toBe(true);
    expect(isPeerLaunchPermission({ agent: 'opencode', permissionMode: 'default' })).toBe(false);
  });

  it('受けられる値の一覧は、検査を通る値だけで、空を含まない', () => {
    for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
      for (const v of peerLaunchPermissionChoices(agent)) {
        expect(v).not.toBe('');
        expect(isPeerLaunchPermission({ agent, permissionMode: v })).toBe(true);
      }
    }
    expect(peerLaunchPermissionChoices('claude-code')).toContain('default');
    expect(peerLaunchPermissionChoices('opencode')).toEqual([]);
  });

  it('MCP の引数の説明が挙げる claude-code の権限モードは、すべて受けられる', () => {
    const doc = (text: string, re: RegExp, split: RegExp): string[] => {
      const m = re.exec(text);
      expect(m, text).not.toBeNull();
      return m![1]!.split(split).map((s) => s.trim()).filter(Boolean);
    };
    const ja = doc(mcpJa['mcp.createSession.permissionModeParam'], /claude-code では (.+?) などの/, /、/);
    const en = doc(mcpEn['mcp.createSession.permissionModeParam'], /such as (.+?);/, /,\s*(?:or\s+)?/);
    expect(ja.length).toBeGreaterThan(1);
    expect(new Set(en)).toEqual(new Set(ja));
    for (const v of [...ja, ...en]) expect(isPeerLaunchPermission({ agent: 'claude-code', permissionMode: v }), v).toBe(true);
  });
});
