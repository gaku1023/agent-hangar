import { describe, expect, it } from 'vitest';
import { launchPrefsOf, readLaunchPrefs } from './launch.ts';

describe('Codex の前回値', () => {
  it('Codex で起こしたら、エージェントとモデルと推論を残す。権限は残さない。Claude の札と opencode のモデルは前のまま', () => {
    const before = { model: 'opus', effort: 'high', permissionMode: 'plan', opencodeModel: 'p/m' };
    expect(launchPrefsOf({ agent: 'codex', model: 'gpt-x', effort: 'low', permissionMode: 'full-access' }, null, before))
      .toEqual({ model: 'opus', effort: 'high', permissionMode: 'plan', opencodeModel: 'p/m', agent: 'codex', codexModel: 'gpt-x', codexEffort: 'low' });
  });
  it('モデルを選んでいなければ codexModel は残さない（前のモデルも消す）', () => {
    expect(launchPrefsOf({ agent: 'codex', effort: 'medium' }, null, { agent: 'codex', codexModel: 'old', codexEffort: 'high' })).toEqual({ agent: 'codex', codexEffort: 'medium' });
  });
  it('Claude Code と opencode で起こしても、Codex のモデルと推論は前のまま残す', () => {
    const before = { codexModel: 'gpt-x', codexEffort: 'low' };
    expect(launchPrefsOf({ model: 'opus' }, null, before)).toEqual({ model: 'opus', codexModel: 'gpt-x', codexEffort: 'low' });
    expect(launchPrefsOf({ agent: 'opencode', model: 'a/b' }, null, before)).toEqual({ agent: 'opencode', opencodeModel: 'a/b', codexModel: 'gpt-x', codexEffort: 'low' });
  });
  it('保存値を読むとき、codex の項目は文字列だけ受ける', () => {
    expect(readLaunchPrefs({ p1: { agent: 'codex', codexModel: 'gpt-x', codexEffort: 'low' }, p2: { codexModel: 3, codexEffort: '' } }))
      .toEqual({ p1: { agent: 'codex', codexModel: 'gpt-x', codexEffort: 'low' } });
  });
});
