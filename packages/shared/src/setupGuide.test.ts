import { describe, expect, it } from 'vitest';
import { translator } from './i18n/t.ts';
import { displayHomePath, setupGuidePrompt } from './setupGuide.ts';

describe('セットアップのすゝめの一言', () => {
  const info = { path: '~/.agent-hangar/setup-guide.md', version: '0.7.0', sha: '3f9a1c2e' };

  it('日本語は、写した md の場所、版、ハッシュを入れ、書き換えは承認してからと言う', () => {
    expect(setupGuidePrompt(translator('ja'), info)).toBe('~/.agent-hangar/setup-guide.md（v0.7.0 sha256:3f9a1c2e）を読んで、私の環境を診断して。書き換えは私が承認してから');
  });

  it('英語も同じ趣旨で、同じ場所、版、ハッシュを入れる', () => {
    const s = setupGuidePrompt(translator('en'), info);
    expect(s).toContain('~/.agent-hangar/setup-guide.md');
    expect(s).toContain('v0.7.0 sha256:3f9a1c2e');
    expect(s).toMatch(/approve/);
  });
});

describe('表示用のパス', () => {
  it('macOS と Linux は、ホームの下を ~ で縮める', () => {
    expect(displayHomePath('/Users/me/.agent-hangar/setup-guide.md', '/Users/me', 'darwin')).toBe('~/.agent-hangar/setup-guide.md');
    expect(displayHomePath('/home/me/.agent-hangar/setup-guide.md', '/home/me/', 'linux')).toBe('~/.agent-hangar/setup-guide.md');
  });

  it('Windows は %USERPROFILE% で縮め、区切りは \\ のまま。大文字と小文字は区別しない', () => {
    expect(displayHomePath('C:\\Users\\me\\.agent-hangar\\setup-guide.md', 'C:\\Users\\me', 'win32')).toBe('%USERPROFILE%\\.agent-hangar\\setup-guide.md');
    expect(displayHomePath('c:\\users\\ME\\.agent-hangar\\setup-guide.md', 'C:\\Users\\me', 'win32')).toBe('%USERPROFILE%\\.agent-hangar\\setup-guide.md');
  });

  it('ホームの外と、名前の頭だけが同じフォルダは縮めない', () => {
    expect(displayHomePath('/opt/hangar/setup-guide.md', '/Users/me', 'darwin')).toBe('/opt/hangar/setup-guide.md');
    expect(displayHomePath('/Users/meg/.agent-hangar/setup-guide.md', '/Users/me', 'darwin')).toBe('/Users/meg/.agent-hangar/setup-guide.md');
    expect(displayHomePath('C:\\Users\\meg\\x.md', 'C:\\Users\\me', 'win32')).toBe('C:\\Users\\meg\\x.md');
  });
});
