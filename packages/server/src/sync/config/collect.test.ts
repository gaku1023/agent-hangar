import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { collectLocal, execMarksOf, isBlocked } from './collect.ts';
import { slugOfPath } from './ids.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
let tmp: string;
let claudeDir: string;
let db: Db;
const write = (rel: string, text: string | Buffer): void => {
  const abs = path.join(claudeDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const collect = (allowed: Map<string, string> = new Map(), maxItems?: number) => collectLocal({ db, deviceId: 'dev-a', claudeDir, allowedUnsent: allowed, maxItems });
const ids = (c: ReturnType<typeof collect>) => c.items.map((i) => i.id);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-collect-'));
  claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir);
  db = openDb(':memory:');
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('手元の項目を集める', () => {
  it('何も無ければ空', () => {
    const c = collect();
    expect(c.items).toEqual([]);
    expect(c.dropped).toEqual([]);
    expect(c.unsent).toEqual([]);
  });

  it('運ぶ種類のファイルと settings の鍵を、id の順に集める', () => {
    write('CLAUDE.md', '# 規則');
    write('keybindings.json', '{"a":1}');
    write('settings.json', JSON.stringify({ model: 'opus', hooks: { x: 1 }, permissions: { allow: ['Bash(ls)'] } }));
    write('skills/a/SKILL.md', '---\nname: a\n---\nbody');
    write('commands/c.md', 'do it');
    write('agents/x.md', 'agent');
    write('memory/n.md', 'note');
    write('statusline.sh', '#!/bin/sh'); // 運ばない
    write('projects/-Users-x/sessions.jsonl', '{}'); // 運ばない
    const c = collect();
    expect(ids(c)).toEqual(['file:CLAUDE.md', 'file:agents/x.md', 'file:commands/c.md', 'file:keybindings.json', 'file:memory/n.md', 'file:skills/a/SKILL.md', 'settings:model', 'settings:permissions.allow']);
    const claudeMd = c.items.find((i) => i.id === 'file:CLAUDE.md')!;
    expect(claudeMd).toMatchObject({ kind: 'claude-md', sha256: sha('# 規則'), size: Buffer.byteLength('# 規則'), marks: [], label: 'CLAUDE.md' });
    const model = c.items.find((i) => i.id === 'settings:model')!;
    expect(model.content.toString()).toBe('"opus"');
    expect(model.label).toBe('model');
    expect(c.dropped).toEqual([{ key: 'hooks', reason: 'execution' }]);
  });

  it('シンボリックリンク、大きすぎるファイル、除外の名前は拾わない', () => {
    write('skills/real/SKILL.md', 'x');
    fs.mkdirSync(path.join(tmp, 'outside'));
    fs.writeFileSync(path.join(tmp, 'outside', 'secret.md'), 'outside');
    fs.symlinkSync(path.join(tmp, 'outside', 'secret.md'), path.join(claudeDir, 'skills', 'real', 'link.md'));
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(claudeDir, 'commands'));
    write('skills/real/big.md', Buffer.alloc((1 << 20) + 1, 97));
    write('skills/real/node_modules/m/x.md', 'x');
    write('skills/real/.git/config', 'x');
    write('skills/real/x.md.conflict-mac-1', 'x');
    write('skills/real/.DS_Store', 'x');
    expect(ids(collect())).toEqual(['file:skills/real/SKILL.md']);
  });

  it('settings.json が壊れていても投げず、鍵の項目は無い', () => {
    write('settings.json', '{ not json');
    write('CLAUDE.md', 'x');
    expect(ids(collect())).toEqual(['file:CLAUDE.md']);
  });

  describe('実行の印', () => {
    it('フロントマターの hooks、本文のコマンド実行、本文でないファイルに印を付ける', () => {
      expect(execMarksOf('skills/a/SKILL.md', Buffer.from('---\nname: a\nhooks:\n  PreToolUse: []\n---\nbody'))).toEqual(['hooks']);
      expect(execMarksOf('commands/c.md', Buffer.from('run !`git status` now'))).toEqual(['shell']);
      expect(execMarksOf('commands/c.md', Buffer.from('```!\nls\n```'))).toEqual(['shell']);
      expect(execMarksOf('skills/a/run.sh', Buffer.from('#!/bin/sh'))).toEqual(['script']);
      expect(execMarksOf('skills/a/tool.py', Buffer.from('print(1)'))).toEqual(['script']);
      expect(execMarksOf('skills/a/Makefile', Buffer.from('all:'))).toEqual(['script']);
      expect(execMarksOf('skills/a/ref.md', Buffer.from('---\nname: a\n---\nplain'))).toEqual([]);
      expect(execMarksOf('skills/a/data.json', Buffer.from('{}'))).toEqual([]);
      expect(execMarksOf('skills/a/img.png', Buffer.from([1, 2, 3]))).toEqual([]);
      // 本文の途中の hooks: は、フロントマターではないので印にしない。
      expect(execMarksOf('commands/c.md', Buffer.from('text\nhooks: not frontmatter'))).toEqual([]);
      expect(execMarksOf('commands/c.md', Buffer.from('---\nname: c\nnote: |\n  hooks: inside value\n---\nbody'))).toEqual([]);
      expect(execMarksOf('commands/c.md', Buffer.from('---\nhooks:\n  a: 1\n---\n!`ls`'))).toEqual(['hooks', 'shell']);
    });
    it('skills、commands、agents 以外には付けない', () => {
      expect(execMarksOf('memory/n.md', Buffer.from('!`ls`'))).toEqual([]);
      expect(execMarksOf('CLAUDE.md', Buffer.from('---\nhooks: x\n---'))).toEqual([]);
    });
    it('集めた項目に印が載る', () => {
      write('skills/a/run.sh', 'echo');
      write('commands/c.md', '!`ls`');
      const c = collect();
      expect(Object.fromEntries(c.items.map((i) => [i.id, i.marks]))).toEqual({ 'file:commands/c.md': ['shell'], 'file:skills/a/run.sh': ['script'] });
    });
  });

  describe('プロジェクトのメモリ', () => {
    const addProject = (id: string, root: string): void => {
      upsertShared(db, 'projects', { id, name: id, status: 'active', is_scratch: 0 }, 'dev-a');
      upsertShared(db, 'project_roots', { id: `r-${id}`, project_id: id, device_id: 'dev-a', path: root, resolved: 1 }, 'dev-a');
    };
    it('この PC のパスの slug に当たるプロジェクトの memory を、プロジェクトの id で運ぶ', () => {
      addProject('proj1', '/Users/me/work/app');
      write(`projects/${slugOfPath('/Users/me/work/app')}/memory/MEMORY.md`, '# m');
      write(`projects/${slugOfPath('/Users/me/work/app')}/memory/sub/a.md`, 'a');
      write('projects/-Users-other-thing/memory/MEMORY.md', 'unknown project');
      const c = collect();
      expect(ids(c)).toEqual(['memory:proj1/MEMORY.md', 'memory:proj1/sub/a.md']);
      expect(c.items[0]).toMatchObject({ kind: 'memory', label: 'MEMORY.md' });
    });
    it('他の PC のルートと、消したプロジェクトは使わない', () => {
      upsertShared(db, 'projects', { id: 'p2', name: 'p2', status: 'active', is_scratch: 0 }, 'dev-a');
      upsertShared(db, 'project_roots', { id: 'r-p2', project_id: 'p2', device_id: 'dev-b', path: '/Users/me/work/b', resolved: 1 }, 'dev-a');
      write(`projects/${slugOfPath('/Users/me/work/b')}/memory/MEMORY.md`, 'x');
      expect(ids(collect())).toEqual([]);
    });
  });

  describe('秘密らしい文字列', () => {
    const SECRET = 'key = sk-ant-api03-AbCdEfGhIjKlMnOpQrSt0123456789';
    it('見つけた項目は送らず、送らなかった項目として記録する。本文の断片は載せない', () => {
      write('CLAUDE.md', SECRET);
      write('commands/ok.md', 'fine');
      const c = collect();
      expect(c.items.map((i) => [i.id, i.withheld])).toEqual([['file:CLAUDE.md', 'secret'], ['file:commands/ok.md', null]]);
      expect(c.unsent).toEqual([{ id: 'secret:file:CLAUDE.md', kind: 'secret', itemId: 'file:CLAUDE.md', label: 'CLAUDE.md', reason: 'secret:sk-ant-', contentSha256: sha(SECRET), allowed: false }]);
      expect(JSON.stringify(c.unsent)).not.toContain('AbCdEf');
    });
    it('「それでも送る」を押した項目は、中身が同じあいだだけ送る', () => {
      write('CLAUDE.md', SECRET);
      const allowed = new Map([['secret:file:CLAUDE.md', sha(SECRET)]]);
      const c = collect(allowed);
      expect(c.items[0]!.withheld).toBeNull();
      expect(c.unsent[0]).toMatchObject({ id: 'secret:file:CLAUDE.md', allowed: true });
      // 中身が変わったら、許しは効かない。
      write('CLAUDE.md', `${SECRET} changed`);
      const again = collect(allowed);
      expect(again.items[0]!.withheld).toBe('secret');
      expect(again.unsent[0]!.allowed).toBe(false);
    });
    it('settings の値も走査する', () => {
      write('settings.json', JSON.stringify({ attribution: { commit: 'ghp_0123456789abcdefghijABCDEFGHIJ012345' }, model: 'x' }));
      const c = collect();
      expect(c.items.map((i) => [i.id, i.withheld])).toEqual([['settings:attribution', 'secret'], ['settings:model', null]]);
    });
    it('バイナリは走査しない', () => {
      write('skills/a/img.png', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SECRET)]));
      expect(collect().items[0]!.withheld).toBeNull();
    });
  });

  describe('絶対パスの権限の規則', () => {
    it('落とした規則を、送らなかった項目として記録する', () => {
      write('settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Read(//Users/me/x/**)'] } }));
      const c = collect();
      const allow = c.items.find((i) => i.id === 'settings:permissions.allow')!;
      expect(JSON.parse(allow.content.toString())).toEqual(['Bash(ls)']);
      expect(c.unsent).toEqual([{ id: `rule:allow:${sha('Read(//Users/me/x/**)').slice(0, 16)}`, kind: 'permission-rule', itemId: 'settings:permissions.allow', label: 'Read(//Users/me/x/**)', reason: 'absolute-path', contentSha256: sha('Read(//Users/me/x/**)'), allowed: false }]);
    });
    it('「それでも送る」を押した規則は残して送る', () => {
      write('settings.json', JSON.stringify({ permissions: { allow: ['Read(//Users/me/x/**)'] } }));
      const rule = 'Read(//Users/me/x/**)';
      const id = `rule:allow:${sha(rule).slice(0, 16)}`;
      const c = collect(new Map([[id, sha(rule)]]));
      expect(JSON.parse(c.items[0]!.content.toString())).toEqual([rule]);
      expect(c.unsent).toMatchObject([{ id, allowed: true }]);
    });
  });
});

describe('手元にあるが運ばないもの（相手の同名の項目に上書きさせない）', () => {
  const outside = (): string => { const f = path.join(tmp, 'outside.md'); fs.writeFileSync(f, 'outside'); return f; };

  it('何も塞がっていなければ、塞がりは無い', () => {
    write('CLAUDE.md', 'x');
    const c = collect();
    expect(isBlocked(c.blocked, 'file:CLAUDE.md')).toBe(false);
    expect(isBlocked(c.blocked, 'file:commands/none.md')).toBe(false);
    expect(isBlocked(c.blocked, 'settings:model')).toBe(false);
  });

  it('リンクのファイルと、リンクのディレクトリの下は、運ばず「手元にある」と記録する', () => {
    write('skills/real/SKILL.md', 'x');
    fs.symlinkSync(outside(), path.join(claudeDir, 'skills', 'real', 'link.md'));
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(claudeDir, 'commands'));
    fs.symlinkSync(outside(), path.join(claudeDir, 'CLAUDE.md'));
    const c = collect();
    expect(ids(c)).toEqual(['file:skills/real/SKILL.md']);
    for (const id of ['file:skills/real/link.md', 'file:commands/anything.md', 'file:commands/deep/x.md', 'file:CLAUDE.md']) expect([id, isBlocked(c.blocked, id)]).toEqual([id, true]);
    expect(isBlocked(c.blocked, 'file:skills/real/SKILL.md')).toBe(false);
    expect(isBlocked(c.blocked, 'file:skills/real/other.md')).toBe(false);
    // 名前の前方一致で巻き込まない。
    expect(isBlocked(c.blocked, 'file:commands-extra/x.md')).toBe(false);
  });

  it('大きすぎるファイルと、読めないファイルも塞がりに入れる', () => {
    write('skills/a/big.md', Buffer.alloc((1 << 20) + 1, 97));
    write('skills/a/locked.md', 'x');
    fs.chmodSync(path.join(claudeDir, 'skills', 'a', 'locked.md'), 0o000);
    try {
      const c = collect();
      expect(isBlocked(c.blocked, 'file:skills/a/big.md')).toBe(true);
      // root では読めてしまうので、読めなかったときだけ塞がりを見る。
      if (!ids(c).includes('file:skills/a/locked.md')) expect(isBlocked(c.blocked, 'file:skills/a/locked.md')).toBe(true);
    } finally { fs.chmodSync(path.join(claudeDir, 'skills', 'a', 'locked.md'), 0o600); }
  });

  it('件数の上限を超えたファイルも塞がりに入れる', () => {
    for (const n of ['a', 'b', 'c', 'd']) write(`commands/${n}.md`, n);
    const c = collect(new Map(), 2);
    expect(ids(c)).toEqual(['file:commands/a.md', 'file:commands/b.md']);
    expect(isBlocked(c.blocked, 'file:commands/c.md')).toBe(true);
    expect(isBlocked(c.blocked, 'file:commands/d.md')).toBe(true);
    expect(isBlocked(c.blocked, 'file:commands/a.md')).toBe(false);
  });

  it('settings.json が読めない（リンク、大きすぎる、壊れている）ときは、settings の項目を全部塞ぐ。無いだけなら塞がない', () => {
    expect(isBlocked(collect().blocked, 'settings:model')).toBe(false);
    write('settings.json', '{ broken');
    expect(isBlocked(collect().blocked, 'settings:model')).toBe(true);
    expect(isBlocked(collect().blocked, 'settings:permissions.allow')).toBe(true);
    fs.rmSync(path.join(claudeDir, 'settings.json'));
    fs.symlinkSync(outside(), path.join(claudeDir, 'settings.json'));
    expect(isBlocked(collect().blocked, 'settings:model')).toBe(true);
    fs.rmSync(path.join(claudeDir, 'settings.json'));
    write('settings.json', '[1]');
    expect(isBlocked(collect().blocked, 'settings:model')).toBe(true);
    fs.rmSync(path.join(claudeDir, 'settings.json'));
    write('settings.json', '{"model":"x"}');
    expect(isBlocked(collect().blocked, 'settings:model')).toBe(false);
  });

  it('プロジェクトのメモリの置き場がリンクなら、そのプロジェクトのメモリを全部塞ぐ', () => {
    upsertShared(db, 'projects', { id: 'proj1', name: 'app', status: 'active', is_scratch: 0 }, 'dev-a');
    upsertShared(db, 'project_roots', { id: 'r1', project_id: 'proj1', device_id: 'dev-a', path: '/Users/me/app', resolved: 1 }, 'dev-a');
    const dir = path.join(claudeDir, 'projects', slugOfPath('/Users/me/app'));
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'mem'));
    fs.symlinkSync(path.join(tmp, 'mem'), path.join(dir, 'memory'));
    const c = collect();
    expect(isBlocked(c.blocked, 'memory:proj1/MEMORY.md')).toBe(true);
    expect(isBlocked(c.blocked, 'memory:proj2/MEMORY.md')).toBe(false);
  });
});
