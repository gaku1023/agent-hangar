import { compareClaudeVersions } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { claudeFixtures, fixtureSubagents, newestClaudeFixture } from './claudeFixtures.ts';

// 見本を読む道具（claudeFixtures.ts）の試験。見本が 1 つも無い今も、増えた後も通る書き方にする。
// 見本の中身の試験は claudeFixtures.test.ts が受け持つ。

describe('claudeFixtures', () => {
  it('返す版はどれも x.y.z の形で、古い順に並ぶ。手書きの見本（置き場の直下）は拾わない', () => {
    const list = claudeFixtures();
    for (const f of list) expect(f.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (let i = 1; i < list.length; i++) expect(compareClaudeVersions(list[i - 1]!.version, list[i]!.version)).toBeLessThan(0);
    expect(list.map((f) => f.version)).not.toContain('projects');
    expect(list.map((f) => f.version)).not.toContain('sessions');
  });
  it('newestClaudeFixture は一覧の最後で、見本が無ければ null', () => {
    const list = claudeFixtures();
    expect(newestClaudeFixture()).toEqual(list.at(-1) ?? null);
  });
  it('fixtureSubagents は subagents/ の下の .jsonl だけを、名前順に返す', () => {
    for (const f of claudeFixtures()) {
      const names = fixtureSubagents(f);
      for (const n of names) expect(n).toMatch(/^subagents\/.+\.jsonl$/);
      expect(names).toEqual([...names].sort());
    }
  });
});
