import { describe, expect, it } from 'vitest';
import { analyzeCommand, fromPortable, HOME_MARK, isCarriedHookFile, toPortable } from './hookCommands.ts';

const MAC = '/Users/a';
const WIN = 'C:\\Users\\a';

describe('command の読み替え', () => {
  it('~、$HOME、${HOME}、%USERPROFILE%、ホームの絶対パスは、どれも ~/.claude の下として読む', () => {
    for (const c of [
      '~/.claude/hooks/x.sh', '$HOME/.claude/hooks/x.sh', '${HOME}/.claude/hooks/x.sh', '"$HOME/.claude/hooks/x.sh"', `${MAC}/.claude/hooks/x.sh`, `bash ${MAC}/.claude/hooks/x.sh --flag`,
    ]) expect([c, analyzeCommand(c, MAC, 'darwin')]).toEqual([c, { files: ['hooks/x.sh'], outside: false, wrapper: false }]);
  });

  it('Windows の実物の形（.ps1、.cmd の絶対パス）も ~/.claude の下として読める', () => {
    const ps1 = 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\a\\.claude\\statusline.ps1"';
    const cmd = 'C:\\Users\\a\\.claude\\hooks\\notify.cmd';
    const env = 'cmd /c "%USERPROFILE%\\.claude\\hooks\\notify.cmd" 2>NUL';
    expect(analyzeCommand(ps1, WIN, 'win32')).toEqual({ files: ['statusline.ps1'], outside: false, wrapper: false });
    expect(analyzeCommand(cmd, WIN, 'win32')).toEqual({ files: ['hooks/notify.cmd'], outside: false, wrapper: false });
    expect(analyzeCommand(env, WIN, 'win32')).toEqual({ files: ['hooks/notify.cmd'], outside: false, wrapper: false });
    // 大文字小文字と区切りの違いは、Windows では同じ場所
    expect(analyzeCommand('c:/users/A/.claude/x.ps1', WIN, 'win32').files).toEqual(['x.ps1']);
  });

  it('~/.claude の外を指す語があれば outside', () => {
    for (const c of ['/usr/local/bin/tool', '~/bin/tool.sh', `${MAC}/bin/tool.sh`, '~/.claude/../bin/x', '$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh', '"$CLAUDE_PROJECT_DIR"/x.sh', '~bob/x', 'C:\\tools\\x.exe', '\\\\srv\\share\\x.ps1', 'node ~/.claude/a.js /etc/hosts']) {
      expect([c, analyzeCommand(c, MAC, 'darwin').outside]).toEqual([c, true]);
    }
  });

  it('出力の捨て場、フラグ、PATH 上の名前は外を指さない', () => {
    expect(analyzeCommand('~/.claude/x.sh >/dev/null 2>&1', MAC, 'darwin')).toEqual({ files: ['x.sh'], outside: false, wrapper: false });
    expect(analyzeCommand('cmd /c ~/.claude/x.cmd', MAC, 'darwin').outside).toBe(false);
    expect(analyzeCommand('node -e "console.log(1)"', MAC, 'darwin')).toEqual({ files: [], outside: false, wrapper: false });
    expect(analyzeCommand('jq .x', MAC, 'darwin').outside).toBe(false);
  });

  it('出力先と .log は運ぶファイルに入れない', () => {
    expect(analyzeCommand('~/.claude/x.sh >> ~/.claude/hooks.out', MAC, 'darwin').files).toEqual(['x.sh']);
    expect(isCarriedHookFile('hooks/run.log')).toBe(false);
  });

  it('hangar の包みを指すものを見分ける', () => {
    for (const c of ['bash ~/.agent-hangar/bin/hangar-run.sh x', `node ${MAC}/.agent-hangar/bin/hangar-run.mjs statusline -- ~/.claude/s.sh`, 'hangar statusline run']) {
      expect([c, analyzeCommand(c, MAC, 'darwin').wrapper]).toEqual([c, true]);
    }
    expect(analyzeCommand('~/.claude/s.sh', MAC, 'darwin').wrapper).toBe(false);
  });

  it('ホームの絶対パスは目印に置き換わり、受け手のホームへ戻る。~ の形は触らない', () => {
    expect(toPortable(`bash ${MAC}/.claude/x.sh ~/.claude/y.sh`, MAC, 'darwin')).toBe(`bash ${HOME_MARK}/.claude/x.sh ~/.claude/y.sh`);
    expect(toPortable('/Users/ab/.claude/x.sh', MAC, 'darwin')).toBe('/Users/ab/.claude/x.sh');
    const w = toPortable('powershell -File "C:\\Users\\a\\.claude\\s.ps1"', WIN, 'win32');
    expect(w).toBe(`powershell -File "${HOME_MARK}\\.claude\\s.ps1"`);
    expect(fromPortable(w, 'C:\\Users\\b')).toBe('powershell -File "C:\\Users\\b\\.claude\\s.ps1"');
    expect(analyzeCommand(w, 'C:\\Users\\b', 'win32').files).toEqual(['s.ps1']);
  });

  it('運ぶファイルは、ほかの項目の置き場や設定そのものを含まない', () => {
    for (const rel of ['settings.json', 'settings.local.json', '.credentials.json', 'skills/a/x.sh', 'commands/x.md', 'projects/p/x', 'CLAUDE.md', '../x', '/etc/x', 'a//b', 'hooks\\x']) expect([rel, isCarriedHookFile(rel)]).toEqual([rel, false]);
    for (const rel of ['statusline-command.sh', 'hooks/x.sh', 'scripts/n.ps1']) expect(isCarriedHookFile(rel)).toBe(true);
  });
});
