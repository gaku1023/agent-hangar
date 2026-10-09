import { describe, expect, it } from 'vitest';
import { fileId, kindOfRel, memoryId, parseItemId, settingsId, slugOfPath } from './ids.ts';

describe('項目の id', () => {
  it('ファイルの種類を相対パスから決める', () => {
    expect(kindOfRel('CLAUDE.md')).toBe('claude-md');
    expect(kindOfRel('keybindings.json')).toBe('keybindings');
    expect(kindOfRel('skills/a/SKILL.md')).toBe('skills');
    expect(kindOfRel('commands/x.md')).toBe('commands');
    expect(kindOfRel('agents/sub/y.md')).toBe('agents');
    expect(kindOfRel('memory/notes.md')).toBe('memory');
    // 運ばない場所
    expect(kindOfRel('settings.json')).toBeNull();
    expect(kindOfRel('statusline.sh')).toBeNull();
    expect(kindOfRel('projects/x/memory/a.md')).toBeNull();
    expect(kindOfRel('skills')).toBeNull();
    expect(kindOfRel('claude.md')).toBeNull();
  });

  it('id を組み、同じ形で解ける', () => {
    expect(fileId('skills/a/SKILL.md')).toBe('file:skills/a/SKILL.md');
    expect(settingsId('permissions.allow')).toBe('settings:permissions.allow');
    expect(memoryId('proj-1', 'MEMORY.md')).toBe('memory:proj-1/MEMORY.md');
    expect(parseItemId('file:skills/a/SKILL.md')).toEqual({ kind: 'skills', ref: { type: 'file', rel: 'skills/a/SKILL.md' } });
    expect(parseItemId('file:CLAUDE.md')).toEqual({ kind: 'claude-md', ref: { type: 'file', rel: 'CLAUDE.md' } });
    expect(parseItemId('settings:model')).toEqual({ kind: 'settings', ref: { type: 'settings', key: 'model' } });
    expect(parseItemId('memory:proj-1/a/b.md')).toEqual({ kind: 'memory', ref: { type: 'memory', projectId: 'proj-1', rel: 'a/b.md' } });
    // 日本語や空白の名前も通る。
    expect(parseItemId('file:skills/日本語 の/SKILL.md')?.kind).toBe('skills');
  });

  it('他の PC から届いた id は、形が悪ければ受け取らない', () => {
    for (const id of [
      '', 'file:', 'file:../x', 'file:/etc/passwd', 'file:skills/../../x', 'file:skills//a', 'file:settings.json', 'file:hooks/x.sh',
      'file:skills/a/.git/config', 'file:skills/node_modules/x/y.js', 'file:skills/a/x.md.conflict-mac-1', 'file:skills/a/x.hangar-tmp-1-ab', 'file:skills/.DS_Store',
      'file:skills/a\u0000b', 'settings:hooks', 'settings:env', 'settings:', 'settings:permissions', 'settings:__proto__',
      'memory:', 'memory:p', 'memory:p/', 'memory:../x/a.md', 'memory:p/../a.md', 'memory:p q/a.md', 'other:x',
    ]) expect([id, parseItemId(id)]).toEqual([id, null]);
  });

  it('メモリの slug は英数字以外を - にする', () => {
    expect(slugOfPath('/Users/me/work/my.app')).toBe('-Users-me-work-my-app');
    expect(slugOfPath('C:\\Users\\me\\x')).toBe('C--Users-me-x');
  });
});
