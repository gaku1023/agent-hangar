import { describe, expect, it } from 'vitest';
import { findGit, gitInstallCommand } from './find.ts';

const host = (o: { platform: NodeJS.Platform; onPath?: string | null; files?: string[]; env?: NodeJS.ProcessEnv }) => ({
  platform: o.platform,
  env: o.env ?? {},
  which: (n: string) => (n === 'git' ? o.onPath ?? null : null),
  isExec: (p: string) => (o.files ?? []).includes(p),
});

describe('findGit', () => {
  it('PATH にあればそれを使う', () => {
    expect(findGit(host({ platform: 'darwin', onPath: '/opt/homebrew/bin/git' }))).toBe('/opt/homebrew/bin/git');
    expect(findGit(host({ platform: 'linux', onPath: '/usr/bin/git' }))).toBe('/usr/bin/git');
  });
  // macOS の /usr/bin/git は入れ物で、コマンドライン・デベロッパツールが無いと、起こしただけで入れる窓が出る。
  it('macOS の /usr/bin/git は、開発ツールが入っているときだけ使う', () => {
    expect(findGit(host({ platform: 'darwin', onPath: '/usr/bin/git' }))).toBeNull();
    expect(findGit(host({ platform: 'darwin', onPath: '/usr/bin/git', files: ['/Library/Developer/CommandLineTools/usr/bin/git'] }))).toBe('/usr/bin/git');
    expect(findGit(host({ platform: 'darwin', onPath: '/usr/bin/git', files: ['/Applications/Xcode.app/Contents/Developer/usr/bin/git'] }))).toBe('/usr/bin/git');
  });
  // Git for Windows は PATH に足すのが既定だが、足さずに入れた人と、入れた直後のサーバのために、決まった場所も見る。
  it('Windows は PATH に無ければ Git for Windows の場所を見る', () => {
    const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    expect(findGit(host({ platform: 'win32', env, files: ['C:\\Program Files\\Git\\cmd\\git.exe'] }))).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(findGit(host({ platform: 'win32', env, files: ['C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'] }))).toBe('C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe');
    expect(findGit(host({ platform: 'win32', env }))).toBeNull();
  });
  it('入れ方は OS で変わる', () => {
    expect(gitInstallCommand('darwin')).toBe('xcode-select --install');
    expect(gitInstallCommand('win32')).toBe('winget install --id Git.Git -e');
    expect(gitInstallCommand('linux')).toBeNull();
  });
});
