import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearVcsCache, detectVcs, detectVcsCached } from './vcs.ts';

let tmp: string;
let home: string;
let box: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-vcs-')));
  home = path.join(tmp, 'home');
  box = path.join(home, '.claude');
  fs.mkdirSync(box, { recursive: true });
  clearVcsCache();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (...p: string[]) => fs.mkdirSync(path.join(...p), { recursive: true });
const touch = (p: string, text = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

describe('detectVcs', () => {
  it('印が無ければ空', () => {
    expect(detectVcs(box, home)).toEqual([]);
  });
  it('入れ物そのものの .git', () => {
    mk(box, '.git');
    expect(detectVcs(box, home)).toEqual(['git']);
  });
  it('親の .git（ホームまで）', () => {
    mk(home, '.git');
    expect(detectVcs(box, home)).toEqual(['git']);
  });
  it('worktree の .git ファイルも印', () => {
    touch(path.join(box, '.git'), 'gitdir: /x');
    expect(detectVcs(box, home)).toEqual(['git']);
  });
  it('ホームより上の .git は辿らない', () => {
    mk(tmp, '.git');
    expect(detectVcs(box, home)).toEqual([]);
  });
  it('ホームの外の入れ物は、その入れ物だけ見る', () => {
    const out = path.join(tmp, 'elsewhere', 'cfg');
    mk(out);
    mk(tmp, 'elsewhere', '.git');
    expect(detectVcs(out, home)).toEqual([]);
    mk(out, '.git');
    expect(detectVcs(out, home)).toEqual(['git']);
  });
  it('chezmoi：ソースに dot_claude がある', () => {
    mk(home, '.local', 'share', 'chezmoi', 'private_dot_claude');
    expect(detectVcs(box, home)).toEqual(['chezmoi']);
  });
  it('chezmoi：入れ物の写しが無ければ印にしない', () => {
    mk(home, '.local', 'share', 'chezmoi', 'dot_zshrc');
    expect(detectVcs(box, home)).toEqual([]);
  });
  it('chezmoi：深い入れ物（.config/opencode）', () => {
    const deep = path.join(home, '.config', 'opencode');
    mk(deep);
    mk(home, '.local', 'share', 'chezmoi', 'dot_config', 'opencode');
    expect(detectVcs(deep, home)).toEqual(['chezmoi']);
  });
  it('yadm：repo.git の索引に入れ物の名前がある', () => {
    touch(path.join(home, '.local', 'share', 'yadm', 'repo.git', 'index'), 'DIRC\0.claude/settings.json\0');
    expect(detectVcs(box, home)).toEqual(['yadm']);
  });
  it('yadm：索引に入れ物が無ければ印にしない', () => {
    touch(path.join(home, '.local', 'share', 'yadm', 'repo.git', 'index'), 'DIRC\0.zshrc\0');
    expect(detectVcs(box, home)).toEqual([]);
  });
  it('stow：入れ物が相対リンクで <stow>/<pkg>/.claude を指す', () => {
    fs.rmSync(box, { recursive: true });
    mk(home, 'dotfiles', 'claude', '.claude');
    fs.symlinkSync(path.join('dotfiles', 'claude', '.claude'), box);
    expect(detectVcs(box, home)).toEqual(['stow']);
  });
  it('stow：中のファイルだけが相対リンク', () => {
    mk(home, 'dotfiles', 'claude', '.claude');
    touch(path.join(home, 'dotfiles', 'claude', '.claude', 'CLAUDE.md'), 'x');
    fs.symlinkSync(path.join('..', 'dotfiles', 'claude', '.claude', 'CLAUDE.md'), path.join(box, 'CLAUDE.md'));
    expect(detectVcs(box, home)).toEqual(['stow']);
  });
  it('stow：絶対パスのリンクは印にしない', () => {
    fs.rmSync(box, { recursive: true });
    mk(home, 'dotfiles', 'claude', '.claude');
    fs.symlinkSync(path.join(home, 'dotfiles', 'claude', '.claude'), box);
    expect(detectVcs(box, home)).toEqual([]);
  });
  it('複数の道具が重なれば全部返す', () => {
    mk(box, '.git');
    mk(home, '.local', 'share', 'chezmoi', 'dot_claude');
    expect(detectVcs(box, home)).toEqual(['git', 'chezmoi']);
  });
  it('入れ物が無くても投げない', () => {
    expect(detectVcs(path.join(home, 'nope'), home)).toEqual([]);
  });
});

describe('detectVcsCached', () => {
  it('TTL の間は覚えていて、過ぎたら読み直す', () => {
    expect(detectVcsCached(box, home, 1000)).toEqual([]);
    mk(box, '.git');
    expect(detectVcsCached(box, home, 2000)).toEqual([]);
    expect(detectVcsCached(box, home, 1000 + 61_000)).toEqual(['git']);
  });
});
