import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Settings } from './paths.ts';
import { writeFakeTool } from '../../test/fake-bin.ts';
import { isWindows, posixIt } from '../../test/platform.ts';
import { resolveToolPaths, which, whichMux } from './tools.ts';

describe('which', () => {
  it('PATH の順に探し、実行できるものを返す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-which-'));
    const tool = writeFakeTool(dir, 'mytool', { sh: '', cmd: '' });
    // 実行できないもの。macOS と Linux は実行権が無いファイル、Windows は PATHEXT に無い拡張子のファイルである。
    const noexec = isWindows ? 'noexec.txt' : 'noexec';
    fs.writeFileSync(path.join(dir, noexec), '', { mode: 0o644 });
    expect(which('mytool', { PATH: dir })).toBe(tool);
    expect(which(noexec, { PATH: dir })).toBeNull();
    expect(which('definitely-not-a-command-xyz', { PATH: dir })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // /bin/sh は Unix にしか無い。Windows の既知の置き場は次の試験が見る。
  posixIt('PATH に無くても既知の場所を見る', () => {
    expect(['/bin/sh', '/usr/bin/sh']).toContain(which('sh', { PATH: '' }));   // macOS は /bin/sh、Ubuntu は /usr/bin/sh
  });
  it('PATH に無くても手元の ~/.local/bin と ~/.claude/local を見る', () => {
    // claude のネイティブ版は ~/.local/bin に入る。GUI 起動の PATH には入らないので、
    // 既知の場所として自分で見に行かなければ、アプリからは claude を見つけられない。
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'local'), { recursive: true });
    const mytool = writeFakeTool(path.join(home, '.local', 'bin'), 'mytool', { sh: '', cmd: '' });
    const oldtool = writeFakeTool(path.join(home, '.claude', 'local'), 'oldtool', { sh: '', cmd: '' });
    const env = { PATH: '', HOME: home, USERPROFILE: home };
    expect(which('mytool', env)).toBe(mytool);
    // ~/.claude/local は古い npm 版の置き場で、Windows の既知の置き場には入れていない。
    if (!isWindows) expect(which('oldtool', env)).toBe(oldtool);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('whichMux', () => {
  it('その OS の名前を順に探し、最初に見つかったものを返す', () => {
    const asked: string[] = [];
    const found = whichMux((c) => { asked.push(c); return c === 'tmux' ? '/x/tmux' : null; });
    expect(found).toBe('/x/tmux');
    expect(asked).toEqual(isWindows ? ['psmux', 'tmux'] : ['tmux']);
    expect(whichMux(() => null)).toBeNull();
  });
});

describe('resolveToolPaths', () => {
  const base: Settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false };
  it('null の項目だけを埋める', () => {
    const r = resolveToolPaths({ ...base, codePath: '/keep/code' }, (c) => (c === 'tmux' || c === 'psmux' ? '/opt/homebrew/bin/tmux' : '/found/' + c));
    expect(r.tmuxPath).toBe('/opt/homebrew/bin/tmux');
    expect(r.codePath).toBe('/keep/code');
  });
  it('見つからなければ null のまま', () => {
    expect(resolveToolPaths(base, () => null)).toEqual({ ...base, claudePath: null, toolsResolved: true });
  });
  it('claudePath は toolsResolved が立っていても、項目が無いうちは埋める', () => {
    // 既に使っている settings.json には toolsResolved: true が入っている。
    // toolsResolved で一括して止めると、後から足した claudePath が永久に埋まらない。
    const r = resolveToolPaths({ ...base, toolsResolved: true }, (c) => '/found/' + c);
    expect(r.claudePath).toBe('/found/claude');
    // 利用者が Settings で空にした null は、そのまま尊重する。
    const cleared = { ...r, claudePath: null };
    expect(resolveToolPaths(cleared, () => '/found/claude').claudePath).toBeNull();
  });
  it('一度探した後は、利用者が外した null をそのままにする', () => {
    // Settings で tmuxPath を空にしたのに、起動のたびに which の結果が入ると
    // 「tmux を使わない」設定が固定できない。
    const once = resolveToolPaths(base, () => '/found/tool');
    expect(once.toolsResolved).toBe(true);
    const cleared = { ...once, tmuxPath: null };
    expect(resolveToolPaths(cleared, () => '/found/tool')).toEqual(cleared);
  });
});
