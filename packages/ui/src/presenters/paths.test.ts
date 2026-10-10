import { describe, expect, it } from 'vitest';
import { shortenPaths } from './format.ts';

describe('shortenPaths', () => {
  it('長い絶対パスは末尾の 2 階層だけにする', () => {
    expect(shortenPaths('/Users/a/workspace/app/packages/ui/src/styles/rows.css')).toBe('…/styles/rows.css');
    expect(shortenPaths('~/.claude/projects/-Users-a-workspace-app/memory/MEMORY.md')).toBe('…/memory/MEMORY.md');
  });
  it('コマンドの中のパスも縮め、コマンドそのものは残す', () => {
    expect(shortenPaths('cd /Users/a/workspace/app/packages/ui && npx vitest run')).toBe('cd …/packages/ui && npx vitest run');
    expect(shortenPaths('S=/private/tmp/claude-501/-Users-a-workspace-app/abc/scratchpad')).toBe('S=…/abc/scratchpad');
    expect(shortenPaths('grep -n "className" /Users/a/workspace/app/views/primitives/Icon.tsx')).toBe('grep -n "className" …/primitives/Icon.tsx');
  });
  it('浅いパスと、パスでないものは触らない', () => {
    expect(shortenPaths('packages/ui/src/keys.ts')).toBe('packages/ui/src/keys.ts');
    expect(shortenPaths('/usr/local/bin')).toBe('/usr/local/bin');
    expect(shortenPaths('npm run build')).toBe('npm run build');
    expect(shortenPaths('https://example.com/a/b/c/d/e')).toBe('https://example.com/a/b/c/d/e');
  });
});
