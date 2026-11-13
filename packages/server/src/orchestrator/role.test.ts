import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@agent-hangar/shared';
import { FORBIDDEN_JA } from '../../../shared/src/i18n/forbiddenJa.ts';
import { ORCHESTRATOR_PERMISSIONS, orchestratorCwd, orchestratorInstructions } from './role.ts';

describe('役の文', () => {
  it('どの言語にもあり、[hangar] と [voice] の扱いを書く', () => {
    for (const lang of LANGUAGES) {
      const [e, ...rest] = orchestratorInstructions(lang);
      expect(rest).toEqual([]);
      expect(e!.key).toBe('orchestrator');
      expect(e!.text).toContain('`[hangar]`');
      expect(e!.text).toContain('`[voice]`');
      expect(e!.text).toContain('answer_ask');
      expect(e!.text.endsWith('\n')).toBe(true);
    }
  });
  it('日本語と英語は別の文で、日本語はやめた語を含まない', () => {
    const [ja, en] = [orchestratorInstructions('ja')[0]!.text, orchestratorInstructions('en')[0]!.text];
    expect(ja).not.toBe(en);
    expect(/[ぁ-ん]/.test(ja)).toBe(true);
    expect(/[ぁ-ん]/.test(en)).toBe(false);
    for (const f of FORBIDDEN_JA) expect(f.pattern.test(ja), String(f.pattern)).toBe(false);
  });
});

describe('統括の置き場と禁止', () => {
  it('cwd は hangar の置き場の下の orchestrator', () => {
    expect(orchestratorCwd('/h')).toMatch(/[\\/]h[\\/]orchestrator$/);
  });
  it('手を動かす道具を禁じ、hangar の道具だけを許す', () => {
    expect(ORCHESTRATOR_PERMISSIONS.deny).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']));
    expect(ORCHESTRATOR_PERMISSIONS.allow).toEqual(['mcp__hangar']);
  });
});
