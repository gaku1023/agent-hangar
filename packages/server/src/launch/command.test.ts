import { describe, expect, it } from 'vitest';
import { runCommand, shellTabCommand } from './command.ts';

describe('runCommand', () => {
  it('macOS と Linux は env で HANGAR_RUN_ID を渡し、bash で包みを起こす', () => {
    const r = runCommand({ runId: 'r1', wrapper: '/h/bin/hangar-run.sh', log: '/h/logs/run-r1.log', command: ['/x/claude', '-p', 'やること'], platform: 'darwin' });
    expect(r.command).toEqual(['env', 'HANGAR_RUN_ID=r1', 'bash', '/h/bin/hangar-run.sh', '/h/logs/run-r1.log', '/x/claude', '-p', 'やること']);
    expect(r.env).toEqual({});
  });
  // Windows には env コマンドも bash も無い。包みは Node のスクリプトで、サーバを動かしている Node で起こす。
  it('Windows は Node で包みを起こし、HANGAR_RUN_ID はセッションの環境で渡す', () => {
    const r = runCommand({ runId: 'r1', wrapper: 'C:\\h\\bin\\hangar-run.mjs', log: 'C:\\h\\logs\\run-r1.log', command: ['C:\\Program Files\\x\\claude.exe', '-p', 'やること'], platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe' });
    expect(r.command).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'C:\\h\\bin\\hangar-run.mjs', 'C:\\h\\logs\\run-r1.log', 'C:\\Program Files\\x\\claude.exe', '-p', 'やること']);
    expect(r.env).toEqual({ HANGAR_RUN_ID: 'r1' });
  });
});

describe('shellTabCommand', () => {
  it('macOS と Linux は利用者のログインシェル。無ければ zsh', () => {
    expect(shellTabCommand({ env: { SHELL: '/bin/bash' }, platform: 'darwin' })).toEqual(['/bin/bash', '-l']);
    expect(shellTabCommand({ env: {}, platform: 'darwin' })).toEqual(['/bin/zsh', '-l']);
    expect(shellTabCommand({ shell: '/x/fish', env: { SHELL: '/bin/bash' }, platform: 'linux' })).toEqual(['/x/fish', '-l']);
  });
  it('Windows は PowerShell。-l は付けない', () => {
    expect(shellTabCommand({ env: { SHELL: '/usr/bin/bash' }, platform: 'win32' })).toEqual(['powershell.exe', '-NoLogo']);
    expect(shellTabCommand({ shell: 'pwsh.exe', env: {}, platform: 'win32' })).toEqual(['pwsh.exe', '-NoLogo']);
  });
});
