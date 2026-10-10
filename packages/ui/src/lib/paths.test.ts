import { describe, expect, it } from 'vitest';
import { baseName, dirName, homePath, isUnder, isWindowsPath, joinPath, pathSep, relPath, splitLast, withTrailingSep } from './paths.ts';

describe('isWindowsPath', () => {
  it('ドライブ、UNC、~\\、\\ を含む相対は Windows の形', () => {
    for (const p of ['C:\\a\\b', 'C:\\', 'c:', 'D:/a/b', '\\\\server\\share\\x', '~\\work', 'src\\a.ts']) expect(isWindowsPath(p), p).toBe(true);
  });
  it('/ で始まるもの、~/ で始まるもの、区切りの無い名前は Windows の形ではない', () => {
    for (const p of ['/Users/a/b', '/', '~/work', '~', 'a.ts', 'src/a.ts', '/Users/a/b\\c']) expect(isWindowsPath(p), p).toBe(false);
  });
});

describe('pathSep', () => {
  it('パスの形から区切りを決める', () => {
    expect(pathSep('/Users/a')).toBe('/');
    expect(pathSep('C:\\Users\\a')).toBe('\\');
    expect(pathSep('C:/Users/a')).toBe('/');
    expect(pathSep('C:')).toBe('\\');
    expect(pathSep('\\\\server\\share')).toBe('\\');
    expect(pathSep('C:\\a/b')).toBe('\\');
  });
  it('形から決まらないときは、渡された既定に従う', () => {
    expect(pathSep('~', '\\')).toBe('\\');
    expect(pathSep('workspace', '/')).toBe('/');
  });
});

describe('splitLast', () => {
  it('最後の区切りの手前（区切りを含む）と、その後ろに分ける', () => {
    expect(splitLast('/w/app/src/a.ts')).toEqual({ dir: '/w/app/src/', base: 'a.ts' });
    expect(splitLast('src/a.ts')).toEqual({ dir: 'src/', base: 'a.ts' });
    expect(splitLast('a.ts')).toEqual({ dir: '', base: 'a.ts' });
    expect(splitLast('C:\\w\\app\\a.ts')).toEqual({ dir: 'C:\\w\\app\\', base: 'a.ts' });
    expect(splitLast('src\\a.ts')).toEqual({ dir: 'src\\', base: 'a.ts' });
    expect(splitLast('C:\\w/app\\b/c.ts')).toEqual({ dir: 'C:\\w/app\\b/', base: 'c.ts' });
    expect(splitLast('/Users/a/')).toEqual({ dir: '/Users/a/', base: '' });
  });
  it('macOS のパスの中の \\ は区切りとして扱わない（名前に使える文字なので）', () => {
    expect(splitLast('/Users/a/b\\c')).toEqual({ dir: '/Users/a/', base: 'b\\c' });
  });
});

describe('baseName', () => {
  it('最後の名前を返し、末尾の区切りは無視する', () => {
    expect(baseName('/Users/a/proj')).toBe('proj');
    expect(baseName('/Users/a/proj/')).toBe('proj');
    expect(baseName('C:\\Users\\a\\proj')).toBe('proj');
    expect(baseName('C:\\Users\\a\\proj\\')).toBe('proj');
    expect(baseName('\\\\server\\share\\x')).toBe('x');
    expect(baseName('C:\\Users/a\\mixed/last')).toBe('last');
    expect(baseName('C:\\Users\\太郎\\作業フォルダ')).toBe('作業フォルダ');
    expect(baseName('/Users/太郎/作業フォルダ')).toBe('作業フォルダ');
    expect(baseName('a.ts')).toBe('a.ts');
  });
  it('根だけのパスは、そのまま返す', () => {
    expect(baseName('/')).toBe('/');
    expect(baseName('C:\\')).toBe('C:\\');
    expect(baseName('C:')).toBe('C:');
  });
});

describe('dirName', () => {
  it('親のパスを、末尾の区切りなしで返す', () => {
    expect(dirName('/Users/a/proj')).toBe('/Users/a');
    expect(dirName('/Users/a/proj/')).toBe('/Users/a');
    expect(dirName('C:\\Users\\a\\proj')).toBe('C:\\Users\\a');
    expect(dirName('\\\\server\\share\\x')).toBe('\\\\server\\share');
    expect(dirName('src\\a.ts')).toBe('src');
    expect(dirName('C:\\Users\\太郎\\作業')).toBe('C:\\Users\\太郎');
  });
  it('親が根なら根を、区切りが無ければ空を返す', () => {
    expect(dirName('/a')).toBe('/');
    expect(dirName('C:\\a')).toBe('C:\\');
    expect(dirName('a.ts')).toBe('');
  });
});

describe('joinPath', () => {
  it('元のパスの区切りでつなぐ', () => {
    expect(joinPath('/Users/a/workspace', 'app')).toBe('/Users/a/workspace/app');
    expect(joinPath('~/workspace', 'app')).toBe('~/workspace/app');
    expect(joinPath('C:\\Users\\a\\workspace', 'app')).toBe('C:\\Users\\a\\workspace\\app');
    expect(joinPath('C:/Users/a/workspace', 'app')).toBe('C:/Users/a/workspace/app');
    expect(joinPath('\\\\server\\share', 'app')).toBe('\\\\server\\share\\app');
    expect(joinPath('C:\\Users\\太郎\\workspace', '新しい')).toBe('C:\\Users\\太郎\\workspace\\新しい');
  });
  it('末尾の区切りを重ねない。根はそのままつなぐ', () => {
    expect(joinPath('/Users/a/workspace/', 'app')).toBe('/Users/a/workspace/app');
    expect(joinPath('C:\\work\\', 'app')).toBe('C:\\work\\app');
    expect(joinPath('/', 'app')).toBe('/app');
    expect(joinPath('C:\\', 'app')).toBe('C:\\app');
  });
  it('区切りの無い親は、渡された既定の区切りでつなぐ', () => {
    expect(joinPath('~', 'app', '\\')).toBe('~\\app');
    expect(joinPath('~', 'app', '/')).toBe('~/app');
  });
  it('名前が空なら、親に区切りを 1 つ足した形にする（打ちかけの表示）', () => {
    expect(joinPath('/Users/a/workspace', '')).toBe('/Users/a/workspace/');
    expect(joinPath('C:\\work', '')).toBe('C:\\work\\');
  });
});

describe('withTrailingSep', () => {
  it('末尾に、元のパスの区切りを 1 つ付ける', () => {
    expect(withTrailingSep('/Users/a/backups')).toBe('/Users/a/backups/');
    expect(withTrailingSep('/Users/a/backups/')).toBe('/Users/a/backups/');
    expect(withTrailingSep('C:\\Users\\a\\backups')).toBe('C:\\Users\\a\\backups\\');
    expect(withTrailingSep('C:\\Users\\a\\backups\\')).toBe('C:\\Users\\a\\backups\\');
  });
});

describe('homePath', () => {
  it('macOS と Linux のホームの下を ~ で始まる形に縮める（これまでと同じ）', () => {
    expect(homePath('/Users/taro/.claude-univ')).toBe('~/.claude-univ');
    expect(homePath('/home/taro/.claude')).toBe('~/.claude');
    expect(homePath('/Users/taro')).toBe('~');
    expect(homePath('/Users/taro/')).toBe('~');
    expect(homePath('/srv/Users/taro/x')).toBe('/srv/Users/taro/x');
  });
  it('Windows のホーム（C:\\Users\\<名前>）の下を、元の区切りのまま ~ で始まる形に縮める', () => {
    expect(homePath('C:\\Users\\taro\\.claude')).toBe('~\\.claude');
    expect(homePath('C:\\Users\\taro\\work\\a b')).toBe('~\\work\\a b');
    expect(homePath('c:\\users\\taro\\.claude')).toBe('~\\.claude');
    expect(homePath('D:\\Users\\太郎\\作業')).toBe('~\\作業');
    expect(homePath('C:/Users/taro/.claude')).toBe('~/.claude');
    expect(homePath('C:\\Users\\taro')).toBe('~');
    expect(homePath('C:\\Users\\taro\\')).toBe('~');
  });
  it('Windows でもホームの下でなければそのまま返す', () => {
    expect(homePath('C:\\Users')).toBe('C:\\Users');
    expect(homePath('C:\\work\\Users\\taro\\x')).toBe('C:\\work\\Users\\taro\\x');
    expect(homePath('\\\\server\\Users\\taro\\x')).toBe('\\\\server\\Users\\taro\\x');
  });
});

describe('relPath', () => {
  it('作業ディレクトリの下は相対にする（macOS、これまでと同じ）', () => {
    expect(relPath('/w/app/src/a.ts', '/w/app')).toBe('src/a.ts');
    expect(relPath('/w/app/src/a.ts', '/w/app/')).toBe('src/a.ts');
    expect(relPath('/w/app2/a.ts', '/w/app')).toBe('/w/app2/a.ts');
    expect(relPath('/w/app', '/w/app')).toBe('/w/app');
    expect(relPath('/w/app/a.ts', '')).toBe('/w/app/a.ts');
  });
  it('Windows の形では、区切りの違いとドライブの大文字小文字を同じとみなし、元の書き方のまま切る', () => {
    expect(relPath('C:\\w\\app\\src\\a.ts', 'C:\\w\\app')).toBe('src\\a.ts');
    expect(relPath('C:\\w\\app\\src\\a.ts', 'C:\\w\\app\\')).toBe('src\\a.ts');
    expect(relPath('C:/w/app/src/a.ts', 'C:\\w\\app')).toBe('src/a.ts');
    expect(relPath('c:\\w\\app\\a.ts', 'C:\\w\\app')).toBe('a.ts');
    expect(relPath('C:\\W\\App\\a.ts', 'C:\\w\\app')).toBe('a.ts');
    expect(relPath('C:\\w\\app2\\a.ts', 'C:\\w\\app')).toBe('C:\\w\\app2\\a.ts');
    expect(relPath('\\\\server\\share\\app\\作業.md', '\\\\server\\share\\app')).toBe('作業.md');
    expect(relPath('C:\\a.ts', 'C:\\')).toBe('a.ts');
  });
});

describe('isUnder', () => {
  it('根の下（直下でも深くても）なら true、根そのものと外は false', () => {
    expect(isUnder('/Users/a/workspace/app', '/Users/a/workspace')).toBe(true);
    expect(isUnder('/Users/a/workspace/app', '/Users/a/workspace/')).toBe(true);
    expect(isUnder('/Users/a/workspace', '/Users/a/workspace')).toBe(false);
    expect(isUnder('/Users/a/workspace2/app', '/Users/a/workspace')).toBe(false);
  });
  it('Windows の形では、区切りの違いと大文字小文字を同じとみなす', () => {
    expect(isUnder('C:\\Users\\a\\workspace\\app', 'C:\\Users\\a\\workspace')).toBe(true);
    expect(isUnder('c:\\users\\a\\Workspace\\app', 'C:\\Users\\a\\workspace')).toBe(true);
    expect(isUnder('C:/Users/a/workspace/app', 'C:\\Users\\a\\workspace\\')).toBe(true);
    expect(isUnder('C:\\Users\\a\\workspace2\\app', 'C:\\Users\\a\\workspace')).toBe(false);
    expect(isUnder('D:\\Users\\a\\workspace\\app', 'C:\\Users\\a\\workspace')).toBe(false);
  });
});
