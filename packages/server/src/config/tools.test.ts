import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveToolPaths, which } from './tools.ts';

describe('which', () => {
  it('PATH の順に探し、実行できるものを返す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-which-'));
    fs.writeFileSync(path.join(dir, 'mytool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'noexec'), '', { mode: 0o644 });
    expect(which('mytool', { PATH: dir })).toBe(path.join(dir, 'mytool'));
    expect(which('noexec', { PATH: dir })).toBeNull();
    expect(which('definitely-not-a-command-xyz', { PATH: dir })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('PATH に無くても既知の場所を見る', () => {
    expect(['/bin/sh', '/usr/bin/sh']).toContain(which('sh', { PATH: '' }));   // macOS は /bin/sh、Ubuntu は /usr/bin/sh
  });
});

describe('resolveToolPaths', () => {
  it('null の項目だけを埋める', () => {
    const s = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: '/keep/code' };
    const r = resolveToolPaths(s, (c) => (c === 'tmux' ? '/opt/homebrew/bin/tmux' : '/found/' + c));
    expect(r.tmuxPath).toBe('/opt/homebrew/bin/tmux');
    expect(r.codePath).toBe('/keep/code');
  });
  it('見つからなければ null のまま', () => {
    const s = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: null };
    expect(resolveToolPaths(s, () => null)).toEqual(s);
  });
});
