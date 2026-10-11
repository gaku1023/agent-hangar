import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instructionFilePath, readInstructions, type InstructionsEnv } from './instructions.ts';

// 指示とメモリのファイル（projects/instructions.ts）の試験。
// 根の下に home（利用者のホーム）、config（Claude Code の設定フォルダ）、ws/repo（プロジェクト）を置く。

let root: string;
let env: InstructionsEnv;
let repo: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-instr-')));
  env = { configDir: path.join(root, 'home', '.claude'), homeDir: path.join(root, 'home') };
  repo = path.join(root, 'ws', 'repo');
  fs.mkdirSync(env.configDir, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
const memoryOf = (p: string) => path.join(env.configDir, 'projects', slug(p), 'memory', 'MEMORY.md');
const kinds = (p = repo) => readInstructions(p, env).map((f) => f.kind);
const agentsRead = (p = repo) => readInstructions(p, env).find((f) => f.kind === 'agents')?.read;

describe('readInstructions', () => {
  it('あるファイルだけを、決まった順に返す', () => {
    put(path.join(repo, 'CLAUDE.local.md'), '# 自分だけ');
    put(path.join(repo, 'CLAUDE.md'), '# 見本\n本文');
    put(memoryOf(repo), '- [試験](t.md)');
    put(path.join(repo, '.claude', 'CLAUDE.md'), '# 別の置き場');
    expect(kinds()).toEqual(['project', 'projectDotClaude', 'local', 'memory']);
  });

  it('何も無ければ空', () => {
    expect(readInstructions(repo, env)).toEqual([]);
  });

  it('名前、大きさ、更新時刻、本文を返す', () => {
    put(path.join(repo, 'CLAUDE.md'), '# 見本\n本文');
    const t = new Date(2026, 9, 9, 12, 0, 0);
    fs.utimesSync(path.join(repo, 'CLAUDE.md'), t, t);
    const [f] = readInstructions(repo, env);
    expect(f).toEqual({ kind: 'project', name: 'CLAUDE.md', size: Buffer.byteLength('# 見本\n本文'), updatedAt: t.getTime(), read: true, markdown: '# 見本\n本文', truncated: false });
    put(path.join(repo, '.claude', 'CLAUDE.md'), 'x');
    expect(readInstructions(repo, env).map((x) => x.name)).toEqual(['CLAUDE.md', '.claude/CLAUDE.md']);
  });

  it('大きすぎる本文は先頭だけにして truncated を立てる', () => {
    put(path.join(repo, 'CLAUDE.md'), 'あ'.repeat(100));
    const f = readInstructions(repo, { ...env, maxBytes: 30 })[0]!;
    expect(f.truncated).toBe(true);
    expect(f.size).toBe(300);
    // 文字の途中で切らない（UTF-8 の 3 バイトの区切りに丸める）。
    expect(f.markdown).toBe('あ'.repeat(10));
  });

  describe('AGENTS.md を読むか', () => {
    beforeEach(() => put(path.join(repo, 'AGENTS.md'), '# agents'));

    it('CLAUDE.md の類が無ければ読む', () => {
      expect(agentsRead()).toBe(true);
    });

    it.each([['CLAUDE.md'], ['.claude/CLAUDE.md'], ['CLAUDE.local.md']])('%s があれば読まない', (name) => {
      put(path.join(repo, name), 'x');
      expect(agentsRead()).toBe(false);
    });

    it('上のフォルダの CLAUDE.md も数える', () => {
      put(path.join(root, 'ws', 'CLAUDE.md'), 'x');
      expect(agentsRead()).toBe(false);
    });

    it('利用者の ~/.claude/CLAUDE.md は数えない', () => {
      const home = path.join(root, 'ws');
      put(path.join(home, '.claude', 'CLAUDE.md'), 'x');
      expect(readInstructions(repo, { configDir: path.join(home, '.claude'), homeDir: home }).find((f) => f.kind === 'agents')?.read).toBe(true);
    });

    it.each([
      ['cc-plugin-agents-md@builtin', 'claude-md-and-agents-md', true],
      ['agents-md@builtin', 'claude-md-and-agents-md', true],
      ['cc-plugin-agents-md@builtin', 'claude-md', false],
      ['cc-plugin-agents-md@builtin', 'managed-only', false],
    ])('設定 %s の %s に従う', (id, value, read) => {
      put(path.join(repo, 'CLAUDE.md'), 'x');
      put(path.join(env.configDir, 'settings.json'), JSON.stringify({ pluginConfigs: { [id]: { options: { instructionFiles: value } } } }));
      expect(agentsRead()).toBe(read);
    });

    it('CLAUDE.md の類は読むものとする', () => {
      put(path.join(repo, 'CLAUDE.md'), 'x');
      expect(readInstructions(repo, env).find((f) => f.kind === 'project')?.read).toBe(true);
    });
  });

  describe('自動メモリ', () => {
    it('git のリポジトリの根から場所を決める（サブフォルダのプロジェクトでも根のもの）', () => {
      put(memoryOf(repo), '- 根');
      const sub = path.join(repo, 'packages', 'app');
      fs.mkdirSync(sub, { recursive: true });
      expect(readInstructions(sub, env).find((f) => f.kind === 'memory')?.markdown).toBe('- 根');
    });

    it('worktree は元のリポジトリと同じ場所を使う', () => {
      put(memoryOf(repo), '- 共有');
      const wt = path.join(root, 'ws', 'repo-wt');
      const gitdir = path.join(repo, '.git', 'worktrees', 'wt');
      put(path.join(gitdir, 'commondir'), '../..\n');
      put(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
      expect(readInstructions(wt, env).find((f) => f.kind === 'memory')?.markdown).toBe('- 共有');
    });

    it('git の外ではプロジェクトのフォルダを使う', () => {
      const plain = path.join(root, 'plain');
      put(memoryOf(plain), '- 外');
      expect(readInstructions(plain, env).find((f) => f.kind === 'memory')?.markdown).toBe('- 外');
    });

    it('autoMemoryDirectory はローカル、プロジェクト、利用者の設定の順に効く', () => {
      put(path.join(env.homeDir, 'mem-user', 'MEMORY.md'), 'user');
      put(path.join(root, 'mem-project', 'MEMORY.md'), 'project');
      put(path.join(root, 'mem-local', 'MEMORY.md'), 'local');
      const memory = () => readInstructions(repo, env).find((f) => f.kind === 'memory')?.markdown;
      put(path.join(env.configDir, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/mem-user' }));
      expect(memory()).toBe('user');
      put(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: path.join(root, 'mem-project') }));
      expect(memory()).toBe('project');
      put(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: path.join(root, 'mem-local') }));
      expect(memory()).toBe('local');
    });

    it('相対の autoMemoryDirectory と壊れた設定は無視する', () => {
      put(memoryOf(repo), 'default');
      put(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: 'rel/dir' }));
      put(path.join(env.configDir, 'settings.json'), '{ 壊れている');
      expect(readInstructions(repo, env).find((f) => f.kind === 'memory')?.markdown).toBe('default');
    });
  });
});

describe('instructionFilePath', () => {
  it('あるファイルのパスを返し、無ければ null', () => {
    put(path.join(repo, 'CLAUDE.md'), 'x');
    put(memoryOf(repo), 'm');
    expect(instructionFilePath(repo, 'project', env)).toBe(path.join(repo, 'CLAUDE.md'));
    expect(instructionFilePath(repo, 'memory', env)).toBe(memoryOf(repo));
    expect(instructionFilePath(repo, 'local', env)).toBeNull();
  });
});
