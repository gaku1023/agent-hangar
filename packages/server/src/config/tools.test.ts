import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Settings } from './paths.ts';
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
  const base: Settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false };
  it('null の項目だけを埋める', () => {
    const r = resolveToolPaths({ ...base, codePath: '/keep/code' }, (c) => (c === 'tmux' ? '/opt/homebrew/bin/tmux' : '/found/' + c));
    expect(r.tmuxPath).toBe('/opt/homebrew/bin/tmux');
    expect(r.codePath).toBe('/keep/code');
  });
  it('見つからなければ null のまま', () => {
    expect(resolveToolPaths(base, () => null)).toEqual({ ...base, toolsResolved: true });
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
