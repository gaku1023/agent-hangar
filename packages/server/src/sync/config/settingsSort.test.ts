import { describe, expect, it } from 'vitest';
import { canonicalJson, isAbsolutePathRule, isCarriedSettingsKey, sortSettings } from './settingsSort.ts';

const byKey = (r: ReturnType<typeof sortSettings>): Record<string, unknown> => Object.fromEntries(r.items.map((i) => [i.key, i.value]));

describe('settings.json の鍵の仕分け', () => {
  it('好みの鍵は運ぶ', () => {
    const r = sortSettings({ model: 'opus', effortLevel: 'high', language: 'Japanese', outputStyle: 'Explanatory', theme: 'dark', editorMode: 'vim', cleanupPeriodDays: 365, attribution: { commit: 'x' }, autoCompactEnabled: true, autoCompactWindow: 100, autoMemoryEnabled: false });
    expect(Object.keys(byKey(r)).sort()).toEqual(['attribution', 'autoCompactEnabled', 'autoCompactWindow', 'autoMemoryEnabled', 'cleanupPeriodDays', 'editorMode', 'effortLevel', 'language', 'model', 'outputStyle', 'theme']);
    expect(r.dropped).toEqual([]);
    expect(byKey(r).attribution).toEqual({ commit: 'x' });
  });

  it('実行、認証、パス、機械の事情の鍵は運ばず、理由を付けて記録する', () => {
    const r = sortSettings({
      env: { A: '1' }, apiKeyHelper: 'x', hooks: {}, statusLine: { type: 'command', command: 'x' }, fileSuggestion: {},
      awsAuthRefresh: 'x', awsCredentialExport: 'x', forceLoginMethod: 'claudeai', forceLoginOrgUUID: 'x',
      sandbox: {}, autoMemoryDirectory: '/x', plansDirectory: '/y', enabledPlugins: {}, extraKnownMarketplaces: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      model: 'opus',
    });
    expect(r.items.map((i) => i.key)).toEqual(['model']);
    const reason = Object.fromEntries(r.dropped.map((d) => [d.key, d.reason]));
    expect(reason).toEqual({
      env: 'execution', apiKeyHelper: 'execution', hooks: 'execution', statusLine: 'execution', fileSuggestion: 'execution',
      awsAuthRefresh: 'auth', awsCredentialExport: 'auth', forceLoginMethod: 'auth', forceLoginOrgUUID: 'auth',
      sandbox: 'machine', enabledPlugins: 'machine', extraKnownMarketplaces: 'machine', enabledMcpjsonServers: 'machine', disabledMcpjsonServers: 'machine',
      autoMemoryDirectory: 'path', plansDirectory: 'path',
    });
  });

  it('知らない鍵は運ばず、unknown として記録する', () => {
    const r = sortSettings({ futureThing: 1, model: 'x' });
    expect(r.items.map((i) => i.key)).toEqual(['model']);
    expect(r.dropped).toEqual([{ key: 'futureThing', reason: 'unknown' }]);
  });

  it('権限は鍵ごとに運び、additionalDirectories は運ばない', () => {
    const r = sortSettings({ permissions: { allow: ['Bash(npm test)', 'Read(~/notes/**)'], ask: ['Bash(git push:*)'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits', additionalDirectories: ['/Users/me/other'], odd: 1 } });
    expect(byKey(r)).toEqual({
      'permissions.allow': ['Bash(npm test)', 'Read(~/notes/**)'],
      'permissions.ask': ['Bash(git push:*)'],
      'permissions.deny': ['Read(./.env)'],
      'permissions.defaultMode': 'acceptEdits',
    });
    expect(r.dropped).toEqual(expect.arrayContaining([{ key: 'permissions.additionalDirectories', reason: 'path' }, { key: 'permissions.odd', reason: 'unknown' }]));
  });

  it('絶対パスの規則だけを落とし、落とした規則を一覧にする', () => {
    const r = sortSettings({ permissions: { allow: ['Read(//Users/me/project/**)', 'Bash(ls)', 'Edit(//C/work/**)', 'Read(C:\\Users\\me\\x)', 'Read(/src/**)'], deny: ['Read(//etc/**)'] } });
    expect(byKey(r)['permissions.allow']).toEqual(['Bash(ls)', 'Read(/src/**)']);
    // 全部が絶対パスの鍵は運ばない（空の配列で相手の規則を消さない）。
    expect(byKey(r)['permissions.deny']).toBeUndefined();
    expect(r.droppedRules).toEqual([
      { list: 'allow', rule: 'Read(//Users/me/project/**)' },
      { list: 'allow', rule: 'Edit(//C/work/**)' },
      { list: 'allow', rule: 'Read(C:\\Users\\me\\x)' },
      { list: 'deny', rule: 'Read(//etc/**)' },
    ]);
  });

  it('「それでも送る」と許した規則は残す', () => {
    const r = sortSettings({ permissions: { allow: ['Read(//Users/me/x/**)', 'Bash(ls)'] } }, { allowedRules: new Set(['Read(//Users/me/x/**)']) });
    expect(byKey(r)['permissions.allow']).toEqual(['Read(//Users/me/x/**)', 'Bash(ls)']);
    expect(r.droppedRules).toEqual([]);
  });

  it('壊れた形は運ばずに記録し、投げない', () => {
    expect(sortSettings(null).items).toEqual([]);
    expect(sortSettings([1]).items).toEqual([]);
    const r = sortSettings({ permissions: { allow: 'nope', defaultMode: 3 }, model: 5 });
    // 値の型が想定外の鍵は運ばない。
    expect(r.items).toEqual([]);
    expect(r.dropped.map((d) => d.key).sort()).toEqual(['model', 'permissions.allow', 'permissions.defaultMode']);
  });
});

describe('絶対パスの規則の判定', () => {
  it.each([
    ['Read(//Users/me/x)', true],
    ['Edit(// /x)', true],
    ['Read(C:\\x)', true],
    ['Read(C:/x)', true],
    ['Read(\\\\server\\share)', true],
    ['Read(~/x)', false],
    ['Read(/src/**)', false],
    ['Read(./x)', false],
    ['Bash(npm test)', false],
    ['WebFetch(domain:example.com)', false],
    ['Read', false],
    ['Bash(cat //etc/hosts)', false],
  ])('%s は %s', (rule, expected) => { expect(isAbsolutePathRule(rule)).toBe(expected); });
});

describe('運ぶ鍵の判定と、正準の JSON', () => {
  it('受け取る側が同じ物差しで鍵を絞る', () => {
    expect(isCarriedSettingsKey('model')).toBe(true);
    expect(isCarriedSettingsKey('permissions.allow')).toBe(true);
    expect(isCarriedSettingsKey('autoCompactWhatever')).toBe(true);
    expect(isCarriedSettingsKey('hooks')).toBe(false);
    expect(isCarriedSettingsKey('env')).toBe(false);
    expect(isCarriedSettingsKey('permissions.additionalDirectories')).toBe(false);
    expect(isCarriedSettingsKey('permissions')).toBe(false);
    expect(isCarriedSettingsKey('')).toBe(false);
    expect(isCarriedSettingsKey('__proto__')).toBe(false);
  });
  it('鍵の並びが違っても同じ文字列になる', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}],"d":1},"b":1}');
  });
});
