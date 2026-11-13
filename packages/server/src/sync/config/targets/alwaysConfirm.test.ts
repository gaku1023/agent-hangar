import type { ConfigInboxOp, ConfigItemKind, ConfigKindMode } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { codexTomlId } from '../ids.ts';
import { itemNeedsConfirm } from './index.ts';

/**
 * 権限の鍵は、種類の状態が自動でも、いつも確認に回す（2026-11-13 の利用者の決定）。
 * 対象は、前に対象ごとの needsApproval が項目単位で承認に掛けていたもの。
 */
const OPS: ConfigInboxOp[] = ['create', 'overwrite', 'delete', 'conflict'];
const need = (id: string, kind: ConfigItemKind, mode: ConfigKindMode, op: ConfigInboxOp = 'overwrite'): boolean => itemNeedsConfirm({ id, kind, op }, mode);
const jid = (...segs: string[]): string => `opencode:json:${segs.join('.')}`;

describe('権限の鍵はいつも確認', () => {
  it('Claude の permissions.* は、自動でも、消去も含めて確認', () => {
    for (const k of ['allow', 'ask', 'deny', 'defaultMode']) {
      for (const op of OPS) expect([k, op, need(`settings:permissions.${k}`, 'settings', 'auto', op)]).toEqual([k, op, true]);
    }
    expect(need('settings:model', 'settings', 'auto')).toBe(false);
    expect(need('settings:model', 'settings', 'confirm')).toBe(true);
  });

  it('claude-keys2 の autoMode・skipAutoPermissionPrompt・deniedMcpServers は、自動でも確認', () => {
    for (const k of ['autoMode', 'skipAutoPermissionPrompt', 'deniedMcpServers']) {
      for (const op of OPS) expect(need(`settings:${k}`, 'settings', 'auto', op), `${k} ${op}`).toBe(true);
    }
    expect(need('settings:tui', 'settings', 'auto')).toBe(false);
    expect(need('settings:voice', 'settings', 'auto')).toBe(false);
  });

  it('Codex の rules、skills、hooks.json、設定の profile、権限の鍵は、自動でも、消去も含めて確認', () => {
    for (const r of ['rules/a.rules', 'skills/s/SKILL.md', 'hooks.json', 'w.config.toml']) {
      for (const op of OPS) expect(need(`codex:file:${r}`, 'codex-file', 'auto', op), `${r} ${op}`).toBe(true);
    }
    expect(need('codex:file:AGENTS.md', 'codex-file', 'auto')).toBe(false);
    expect(need('codex:file:AGENTS.override.md', 'codex-file', 'auto')).toBe(false);
    for (const p of [['approval_policy'], ['sandbox_mode'], ['hooks', 'PreToolUse'], ['plugins', 'p', 'enabled'], ['sandbox_workspace_write', 'network_access']]) {
      for (const op of OPS) expect(need(codexTomlId(p), 'codex-config', 'auto', op), `${p.join('.')} ${op}`).toBe(true);
    }
    expect(need(codexTomlId(['model']), 'codex-config', 'auto')).toBe(false);
    expect(need(codexTomlId(['tui', 'theme']), 'codex-config', 'auto')).toBe(false);
  });

  it('opencode の permission と agent(s).*.permission は、自動でも、消去も含めて確認。ほかの鍵は要らない', () => {
    for (const id of [jid('permission'), jid('agent', 'a', 'permission'), jid('agents', 'a', 'permission')]) {
      for (const op of OPS) expect(need(id, 'opencode-config', 'auto', op), `${id} ${op}`).toBe(true);
    }
    expect(need(jid('model'), 'opencode-config', 'auto')).toBe(false);
    expect(need(jid('agent', 'a', 'prompt'), 'opencode-config', 'auto')).toBe(false);
    expect(need('opencode:cli:theme', 'opencode-cli', 'auto')).toBe(false);
    expect(need('opencode:file:agents/a.md', 'opencode-file', 'auto')).toBe(false);
  });

  it('ほかの種類は状態のとおり。確認なら要り、自動なら要らない', () => {
    expect(need('file:skills/a/SKILL.md', 'skills', 'auto', 'create')).toBe(false);
    expect(need('file:skills/a/SKILL.md', 'skills', 'confirm', 'delete')).toBe(true);
    expect(need('claude-hooks:hooks', 'claude-hooks', 'auto')).toBe(false);
    expect(need('claude-hooks:hooks', 'claude-hooks', 'confirm')).toBe(true);
    expect(need('claude-mcp:x', 'claude-mcp', 'confirm', 'delete')).toBe(true);
    expect(need('agents-skills:a', 'agents-skills', 'auto')).toBe(false);
  });
});
