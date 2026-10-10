import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listPromptCommands } from './commands.ts';

let claudeDir: string;
let project: string;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (root: string, dir: string, fm: string) => write(path.join(root, 'skills', dir, 'SKILL.md'), `---\n${fm}\n---\n本文\n`);
const names = (o = { claudeDir, projectPath: project as string | null }) => listPromptCommands(o).map((c) => `${c.source}:${c.name}`);

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cmd-'));
  claudeDir = path.join(tmp, 'claude');
  project = path.join(tmp, 'proj');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});

describe('listPromptCommands', () => {
  it('自分のスキルとコマンドを、説明の 1 行目と引数の形つきで返す', () => {
    skill(claudeDir, 'goal', 'name: goal\ndescription: 長く走る。二文目。');
    write(path.join(claudeDir, 'commands', 'toggle.md'), '---\ndescription: 切り替える\nargument-hint: "[on|off]"\n---\n');
    const list = listPromptCommands({ claudeDir, projectPath: null });
    expect(list.find((c) => c.name === 'goal')).toEqual({ name: 'goal', description: '長く走る。二文目。', argumentHint: null, source: 'user', uses: 0 });
    expect(list.find((c) => c.name === 'toggle')).toEqual({ name: 'toggle', description: '切り替える', argumentHint: '[on|off]', source: 'user', uses: 0 });
  });
  it('フォルダに入ったコマンドは、区切りをコロンにした名前になる', () => {
    write(path.join(claudeDir, 'commands', 'git', 'sync.md'), '---\ndescription: そろえる\n---\n');
    expect(names()).toContain('user:git:sync');
  });
  it('プロジェクトのものは project として出て、同じ名前の自分のものより先に立つ', () => {
    skill(claudeDir, 'deploy', 'name: deploy\ndescription: 自分の');
    skill(path.join(project, '.claude'), 'deploy', 'name: deploy\ndescription: プロジェクトの');
    const hit = listPromptCommands({ claudeDir, projectPath: project }).filter((c) => c.name === 'deploy');
    expect(hit).toEqual([{ name: 'deploy', description: 'プロジェクトの', argumentHint: null, source: 'project', uses: 0 }]);
  });
  it('projectPath が null なら、プロジェクトのものは読まない', () => {
    skill(path.join(project, '.claude'), 'deploy', 'name: deploy\ndescription: x');
    expect(names({ claudeDir, projectPath: null })).not.toContain('project:deploy');
  });
  it('user-invocable: false のスキルは出さない', () => {
    skill(claudeDir, 'hidden', 'name: hidden\ndescription: x\nuser-invocable: false');
    expect(names()).not.toContain('user:hidden');
  });
  it('frontmatter の無いスキルはフォルダの名前で出し、SKILL.md の無いフォルダは飛ばす', () => {
    write(path.join(claudeDir, 'skills', 'plain', 'SKILL.md'), '# 見出しだけ\n');
    fs.mkdirSync(path.join(claudeDir, 'skills', 'empty'), { recursive: true });
    expect(names()).toContain('user:plain');
    expect(names()).not.toContain('user:empty');
  });
  it('有効なプラグインのスキルを プラグイン:名前 で出し、無効なものは出さない', () => {
    const on = path.join(claudeDir, 'plugins', 'cache', 'm', 'sp', '1.0.0');
    const off = path.join(claudeDir, 'plugins', 'cache', 'm', 'off', '1.0.0');
    skill(on, 'brainstorming', 'name: brainstorming\ndescription: 詰める');
    skill(off, 'x', 'name: x\ndescription: y');
    write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'sp@m': [{ scope: 'user', installPath: on }], 'off@m': [{ scope: 'user', installPath: off }] } }));
    write(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'sp@m': true, 'off@m': false } }));
    expect(names()).toContain('plugin:sp:brainstorming');
    expect(names()).not.toContain('plugin:off:x');
  });
  it('組み込みは決めた 6 つだけを出す', () => {
    expect(names().filter((n) => n.startsWith('builtin:')).sort()).toEqual(['builtin:code-review', 'builtin:init', 'builtin:loop', 'builtin:review', 'builtin:schedule', 'builtin:security-review']);
  });
  it('回数は history.jsonl の最初の一言から取る', () => {
    skill(claudeDir, 'goal', 'name: goal\ndescription: x');
    fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), [JSON.stringify({ display: '/goal a', sessionId: 's1' }), JSON.stringify({ display: '/goal b', sessionId: 's2' })].join('\n'));
    expect(listPromptCommands({ claudeDir, projectPath: null }).find((c) => c.name === 'goal')?.uses).toBe(2);
  });
  it('壊れた installed_plugins.json や settings.json があっても、ほかは出る', () => {
    skill(claudeDir, 'goal', 'name: goal\ndescription: x');
    write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), '{こわれた');
    write(path.join(claudeDir, 'settings.json'), '{こわれた');
    expect(names()).toContain('user:goal');
  });
});
