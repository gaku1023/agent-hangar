import { describe, expect, it } from 'vitest';
import { TOOL_CLASSES, toolsNeedingApproval } from './toolClasses.ts';
import { TOOL_NAMES } from './tools.ts';

describe('MCP の道具の分類', () => {
  it('全部の道具に分類と理由がある。新しい道具を足して分類を忘れると、ここで落ちる', () => {
    expect(Object.keys(TOOL_CLASSES).sort()).toEqual([...TOOL_NAMES].sort());
    for (const [name, c] of Object.entries(TOOL_CLASSES)) expect(c.why.trim().length, name).toBeGreaterThan(0);
  });
  it('取り消せない操作は delete_session だけで、利用者の承認を挟む', () => {
    expect(Object.entries(TOOL_CLASSES).filter(([, c]) => c.kind === 'irreversible').map(([n]) => n)).toEqual(['delete_session']);
    expect(toolsNeedingApproval()).toEqual(['delete_session']);
  });
  it('承認に答える道具は外に出さない。出すと、エージェントが自分で承認できてしまう', () => {
    expect(TOOL_NAMES.filter((n) => /approv|allow/i.test(n))).toEqual([]);
  });
});
