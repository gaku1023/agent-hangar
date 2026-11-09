import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';

/*
 * スマホの節の「Remote Control の設定はどこにあるか」の一文（cloudMember.phone.rcPointer）。
 * 設定の行は「Claude Code」の節にある（SettingsScreen.tsx の claudeDefaults）。
 * 節の名前と行の名前を、設定の辞書の値とそろえて見張る（issue #615）。
 */
describe('Remote Control の設定の場所を指す文', () => {
  it.each([['ja', ja], ['en', en]] as const)('%s は Claude Code の節と行の名前を、設定の辞書の値で書く', (_, dict) => {
    const s = dict['cloudMember.phone.rcPointer'];
    expect(s).toContain(dict['settings.section.agentClaude']);
    expect(s).toContain(dict['settings.label.remoteControl']);
    expect(s).not.toContain(dict['settings.section.sessions']);
  });
});
