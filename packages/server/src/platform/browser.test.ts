import { describe, expect, it } from 'vitest';
import { openTargetCommand } from './browser.ts';

describe('openTargetCommand', () => {
  const url = 'https://claude.ai/code/artifact/x?a=1&b=2';

  it('macOS は open に渡す', () => {
    expect(openTargetCommand(url, 'darwin')).toEqual({ file: 'open', args: [url] });
  });

  it('Windows はシェルを通さず、既定のアプリへ渡す', () => {
    // cmd.exe の start を通すと & で文が切れる。rundll32 は引数をそのまま既定のアプリへ渡す。
    expect(openTargetCommand(url, 'win32')).toEqual({ file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] });
  });

  it('Linux は xdg-open に渡す', () => {
    expect(openTargetCommand(url, 'linux')).toEqual({ file: 'xdg-open', args: [url] });
  });

  it('ファイルのパスも同じ形で渡す', () => {
    expect(openTargetCommand('C:\\Users\\a\\.agent-hangar\\open.html', 'win32').args).toEqual(['url.dll,FileProtocolHandler', 'C:\\Users\\a\\.agent-hangar\\open.html']);
  });
});
