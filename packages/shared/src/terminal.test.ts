import { describe, expect, it } from 'vitest';
import { defaultTerminalApp, terminalAppFor, terminalAppsFor } from './terminal.ts';

describe('外部ターミナルの選択肢', () => {
  it('macOS は Terminal.app と iTerm2、Windows は Windows Terminal と既定のターミナル', () => {
    expect(terminalAppsFor('darwin')).toEqual(['terminal', 'iterm']);
    expect(terminalAppsFor('win32')).toEqual(['windowsTerminal', 'windowsDefault']);
  });
  it('Windows でも macOS でもない OS は、いままでどおり macOS の選択肢にする', () => {
    expect(terminalAppsFor('linux')).toEqual(['terminal', 'iterm']);
  });
  it('既定は選択肢の先頭', () => {
    expect(defaultTerminalApp('darwin')).toBe('terminal');
    expect(defaultTerminalApp('win32')).toBe('windowsTerminal');
  });
  it('その OS の値はそのまま、別の OS の値と知らない値は、その OS の既定に読み替える', () => {
    expect(terminalAppFor('iterm', 'darwin')).toBe('iterm');
    expect(terminalAppFor('windowsDefault', 'win32')).toBe('windowsDefault');
    // macOS で保存した設定を Windows で読んだとき、またはその逆。
    expect(terminalAppFor('iterm', 'win32')).toBe('windowsTerminal');
    expect(terminalAppFor('windowsDefault', 'darwin')).toBe('terminal');
    expect(terminalAppFor('kitty', 'darwin')).toBe('terminal');
    expect(terminalAppFor(undefined, 'win32')).toBe('windowsTerminal');
  });
});
