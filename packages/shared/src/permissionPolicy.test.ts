import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_TOOLS, isAutoToolName, permissionAutoToolsOf, permissionPolicyOf } from './permissionPolicy.ts';

describe('permissionPolicyOf', () => {
  it('方針が無いときは、ファイルの読み取りと検索の 4 つだけを許す', () => {
    expect(permissionPolicyOf(undefined)).toBeNull();
    expect(permissionAutoToolsOf(null)).toEqual(['Read', 'Glob', 'Grep', 'LS']);
    expect(permissionAutoToolsOf(undefined)).toEqual([...DEFAULT_AUTO_TOOLS]);
  });
  it('形の合う方針はそのまま読み、重なりは 1 つにする', () => {
    const p = permissionPolicyOf({ text: '読むのと git status は許して', autoTools: ['Read', 'Bash', 'Read'], updatedAt: 5 });
    expect(p).toEqual({ text: '読むのと git status は許して', autoTools: ['Read', 'Bash'], updatedAt: 5 });
    expect(permissionAutoToolsOf(p)).toEqual(['Read', 'Bash']);
  });
  it('空の道具の並びは「何も許さない」として読む（既定には戻さない）', () => {
    expect(permissionAutoToolsOf(permissionPolicyOf({ text: '全部聞いて', autoTools: [], updatedAt: 1 }))).toEqual([]);
  });
  it('形の違う値は既定として読む', () => {
    expect(permissionPolicyOf({ text: '', autoTools: ['Read'] })).toBeNull();
    expect(permissionPolicyOf({ text: 'x', autoTools: 'Read' })).toBeNull();
    expect(permissionPolicyOf({ text: 'x', autoTools: ['Bash(rm -rf:*)'] })).toBeNull();
    expect(permissionPolicyOf([])).toBeNull();
  });
});

describe('isAutoToolName', () => {
  it('道具の名前と MCP の道具だけを受け、括弧や * は受けない', () => {
    for (const ok of ['Read', 'Bash', 'NotebookEdit', 'mcp__hangar__list_sessions', 'mcp__github']) expect(isAutoToolName(ok), ok).toBe(true);
    for (const bad of ['', '*', 'Bash(git:*)', 'Read ', 'mcp__', '../x', 5]) expect(isAutoToolName(bad), String(bad)).toBe(false);
  });
});
