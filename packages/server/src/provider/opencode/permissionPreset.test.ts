import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { permissionPresetFor, permissionPresetRules, userConfigDefinesPermissions, userDefinesPermissions, type OpencodePermissionRule } from './permissionPreset.ts';

/**
 * opencode 2.1.4 の照らし方（packages/core の util/wildcard.ts と permission.ts の evaluate）を写したもの。
 * 型の `*` は何にでも当たり、末尾の ` *` は無しにも当たる。規則は後に書いたものが勝ち、当たらなければ ask。
 * 1 回の shell の呼び出しは、つないだコマンドごとの照らす文（resources）に割られ、1 つでも ask なら全体が ask になる。
 */
function match(input: string, pattern: string): boolean {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input);
}
/** 既定の agent（build）の規則に、ひな形を重ねて照らす。 */
const DEFAULT_AGENT: OpencodePermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
];
function evaluate(action: string, resources: string[], rules: OpencodePermissionRule[]): 'allow' | 'ask' | 'deny' {
  const all = [...DEFAULT_AGENT, ...rules];
  const effects = resources.map((r) => [...all].reverse().find((x) => match(action, x.action) && match(r, x.resource))?.effect ?? 'ask');
  return effects.includes('deny') ? 'deny' : effects.includes('ask') ? 'ask' : 'allow';
}

describe('permissionPresetRules', () => {
  const rules = permissionPresetRules();
  // resources は、実物の opencode 2.1.4 が出した照らす文（模擬の LLM に打たせて permission.asked で読んだもの）。
  it.each([
    [['git status']],
    [['git diff HEAD']],
    [['git log --oneline -5']],
    [['ls -la']],
    [['cat README.md']],
    [['pwd']],
  ])('読むだけのよくあるコマンドは聞かずに通す：%j', (resources) => {
    expect(evaluate('shell', resources, rules)).toBe('allow');
  });

  it.each([
    [['rm -rf x']],
    [['npm install']],
    [['git status', 'touch pwned']], // git status && touch pwned
    [['cat a.txt', 'sh']], // cat a.txt | sh
    [['cat $(touch pwned)', 'touch pwned']],
    [['cat a.txt > b.txt']],
    [['echo hi >> b.txt']],
    [['git log --output=c.txt']],
    [['FOO=1 git status']],
    [["bash -c 'git status'"]],
    [['git push']],
    [['git branch -D main']],
  ])('それ以外の shell は聞く：%j', (resources) => {
    expect(evaluate('shell', resources, rules)).toBe('ask');
  });

  it('ほかの道具は opencode の既定のまま（.env を読むときの ask を上書きしない）', () => {
    expect(rules.every((r) => r.action === 'shell')).toBe(true);
    expect(evaluate('read', ['.env'], rules)).toBe('ask');
    expect(evaluate('edit', ['src/a.ts'], rules)).toBe('allow');
  });
});

describe('userDefinesPermissions', () => {
  let root: string;
  let home: string;
  let cwd: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-perm-')));
    home = path.join(root, 'home');
    cwd = path.join(root, 'work', 'repo', 'pkg');
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

  it('どこにも書いていなければ偽', () => {
    write(path.join(home, '.config', 'opencode', 'opencode.json'), '{ "model": "a/b" }');
    expect(userDefinesPermissions(home, cwd, {})).toBe(false);
  });

  it.each(['permission', 'permissions', 'tools'])('利用者の設定の上の段に %s があれば真', (key) => {
    write(path.join(home, '.config', 'opencode', 'opencode.json'), `{ "${key}": {} }`);
    expect(userDefinesPermissions(home, cwd, {})).toBe(true);
  });

  it('XDG_CONFIG_HOME の下の .jsonc もコメントごと読む', () => {
    const xdg = path.join(root, 'xdg');
    write(path.join(xdg, 'opencode', 'opencode.jsonc'), '// mine\n{ "permission": "ask", }');
    expect(userDefinesPermissions(home, cwd, { XDG_CONFIG_HOME: xdg })).toBe(true);
  });

  it('会話のフォルダから上の階の opencode.json と .opencode/opencode.json も見る', () => {
    write(path.join(root, 'work', 'repo', 'opencode.json'), '{ "permission": { "bash": "ask" } }');
    expect(userDefinesPermissions(home, cwd, {})).toBe(true);
    fs.rmSync(path.join(root, 'work', 'repo', 'opencode.json'));
    write(path.join(root, 'work', '.opencode', 'opencode.jsonc'), '{ "permissions": [] }');
    expect(userDefinesPermissions(home, cwd, {})).toBe(true);
  });

  it('agent ごとの許可だけなら偽（opencode はそれを後に足すので、重ねても利用者の規則が勝つ）', () => {
    write(path.join(home, '.config', 'opencode', 'opencode.json'), '{ "agent": { "build": { "permission": { "bash": "allow" } } } }');
    expect(userDefinesPermissions(home, cwd, {})).toBe(false);
  });

  it('設定の画面向けの形は、利用者の設定だけを見る（会話のフォルダの設定は見ない）', () => {
    write(path.join(root, 'work', 'repo', 'opencode.json'), '{ "permission": "ask" }');
    expect(userConfigDefinesPermissions(home, {})).toBe(false);
    write(path.join(home, '.config', 'opencode', 'opencode.json'), '{ "permission": "ask" }');
    expect(userConfigDefinesPermissions(home, {})).toBe(true);
  });

  it('読めない設定は無いものとして読む', () => {
    write(path.join(home, '.config', 'opencode', 'opencode.json'), '{ broken');
    expect(userDefinesPermissions(home, cwd, {})).toBe(false);
  });
});

describe('permissionPresetFor', () => {
  let home: string;
  beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-perm-for-'))); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('設定が入で、利用者が許可を決めていなければ、ひな形を返す', () => {
    expect(permissionPresetFor({ enabled: true, home, cwd: home, env: {} })).toEqual(permissionPresetRules());
  });
  it('設定が切なら null', () => {
    expect(permissionPresetFor({ enabled: false, home, cwd: home, env: {} })).toBeNull();
  });
  it('利用者が許可を決めていれば null（利用者の規則を優先する）', () => {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), '{ "permission": "allow" }');
    expect(permissionPresetFor({ enabled: true, home, cwd: home, env: {} })).toBeNull();
  });
});
