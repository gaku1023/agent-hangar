import { describe, expect, it } from 'vitest';
import { TOOL_CLASSES, toolsNeedingApproval } from './toolClasses.ts';
import { ORCHESTRATOR_TOOL_NAMES } from './orchestratorTools.ts';
import { TOOL_NAMES } from './tools.ts';

describe('MCP の道具の分類', () => {
  it('全部の道具に分類と理由がある。新しい道具を足して分類を忘れると、ここで落ちる', () => {
    expect(Object.keys(TOOL_CLASSES).sort()).toEqual([...TOOL_NAMES, ...ORCHESTRATOR_TOOL_NAMES].sort());
    for (const [name, c] of Object.entries(TOOL_CLASSES)) expect(c.why.trim().length, name).toBeGreaterThan(0);
  });
  it('取り消せない操作は delete_session だけで、利用者の承認を挟む', () => {
    expect(Object.entries(TOOL_CLASSES).filter(([, c]) => c.kind === 'irreversible').map(([n]) => n)).toEqual(['delete_session']);
    expect(toolsNeedingApproval()).toEqual(['delete_session']);
  });
  it('下書きを置く道具は write で、承認に答える道具は無い（承認は画面だけが受ける）', () => {
    expect(TOOL_CLASSES.claim_pr.kind).toBe('write');
    expect(TOOL_CLASSES.draft_event_binding.kind).toBe('write');
    expect(toolsNeedingApproval()).not.toContain('draft_event_binding');
  });
  it('承認に答える道具は外に出さない。出すと、エージェントが自分で承認できてしまう', () => {
    expect(TOOL_NAMES.filter((n) => /approv|allow/i.test(n))).toEqual([]);
  });
  it('許可の札に答える道具は統括だけのもので、どの会話にも出す道具には入れない', () => {
    expect([...ORCHESTRATOR_TOOL_NAMES].sort()).toEqual(['answer_ask', 'list_auto_approvals', 'list_pending_asks', 'set_permission_policy']);
    for (const n of ORCHESTRATOR_TOOL_NAMES) expect(TOOL_NAMES as readonly string[]).not.toContain(n);
    expect(TOOL_CLASSES.answer_ask.kind).toBe('drive');
    expect(TOOL_CLASSES.set_permission_policy.kind).toBe('write');
    expect(TOOL_CLASSES.list_pending_asks.kind).toBe('read');
    expect(TOOL_CLASSES.list_auto_approvals.kind).toBe('read');
  });
});
