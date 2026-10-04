import { describe, expect, it } from 'vitest';
import { shortenPaths } from './format.ts';
import { cardPathLabel } from './projects.ts';

describe('cardPathLabel', () => {
  it('ワークスペース直下で、フォルダ名がプロジェクト名と同じなら出さない', () => {
    expect(cardPathLabel('/Users/a/workspace/agent-hangar', 'agent-hangar', '/Users/a/workspace')).toBeNull();
    expect(cardPathLabel('/Users/a/workspace/agent-hangar', 'agent-hangar', '/Users/a/workspace/')).toBeNull();
  });
  it('フォルダ名が NFD で届いても、名前と同じとみなす', () => {
    const nfd = '無検閲モデル'.normalize('NFD');
    expect(cardPathLabel(`/Users/a/workspace/${nfd}`, '無検閲モデル', '/Users/a/workspace')).toBeNull();
  });
  it('ワークスペースの下で名前と違うときは、ワークスペースからの相対で出す', () => {
    expect(cardPathLabel('/Users/a/workspace/tools/hangar', 'hangar', '/Users/a/workspace')).toBe('tools/hangar');
    expect(cardPathLabel('/Users/a/workspace/hangar-old', 'hangar', '/Users/a/workspace')).toBe('hangar-old');
  });
  it('ワークスペースの外は、そのまま出す', () => {
    expect(cardPathLabel('/opt/tools/hangar', 'hangar', '/Users/a/workspace')).toBe('/opt/tools/hangar');
    // ワークスペースと頭が同じでも、別のフォルダは外である。
    expect(cardPathLabel('/Users/a/workspace2/hangar', 'hangar', '/Users/a/workspace')).toBe('/Users/a/workspace2/hangar');
  });
  it('ワークスペースがまだ分からなければ、そのまま出す', () => {
    expect(cardPathLabel('/Users/a/workspace/hangar', 'hangar', '')).toBe('/Users/a/workspace/hangar');
  });
  it('この PC にパスが無ければそう書く', () => {
    expect(cardPathLabel(null, 'hangar', '/Users/a/workspace')).toBe('この PC にパスがありません');
  });
});

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
