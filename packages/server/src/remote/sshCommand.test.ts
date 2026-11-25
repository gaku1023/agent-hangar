import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifySshFailure, closeArgv, hasSessionArgv, cdArgv, hostAlias, isIpv4, keyscanArgs, knownHostsText, matchingHostKey, parsePrepareMark,
  parseKeyscan, prepareArgv, shellArgv, sshBinaries, sshOptionPath, type SshTarget,
} from './sshCommand.ts';

const PUB = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString('base64');
const fp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(PUB, 'base64')).digest('base64').replace(/=+$/, '');

const target = (over: Partial<SshTarget> = {}): SshTarget => ({
  deviceId: 'dev1', host: '192.168.3.40', user: 'u', port: 22,
  knownHosts: '/h/known_hosts', emptyKnownHosts: '/h/empty', platform: 'darwin', ...over,
});
const lastOf = (a: string[]): string => a[a.length - 1] ?? '';
const flat = (a: string[]): string => a.join(' ');

describe('helpers from the old implementation', () => {
  it('finds OpenSSH binaries', () => {
    expect(sshBinaries('darwin', {}, (f) => f === '/usr/bin/ssh')).toEqual({ ssh: '/usr/bin/ssh', keyscan: 'ssh-keyscan' });
    expect(sshBinaries('win32', { SystemRoot: 'C:\\Windows' }, () => true).ssh).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
    expect(sshBinaries('win32', {}, () => false)).toEqual({ ssh: 'ssh.exe', keyscan: 'ssh-keyscan.exe' });
  });
  it('quotes option paths', () => {
    expect(sshOptionPath('/a b/c', 'darwin')).toBe('"/a b/c"');
    expect(sshOptionPath('/a%b', 'darwin')).toBe('/a%%b');
    expect(sshOptionPath('/a%b', 'darwin', false)).toBe('/a%b');
    expect(sshOptionPath('C:\\Users\\x y\\k', 'win32')).toBe('"C:/Users/x y/k"');
    expect(() => sshOptionPath('a"b', 'darwin')).toThrow();
  });
  it('alias, ipv4, keyscan', () => {
    expect(hostAlias('d1')).toBe('hangar-peer-d1');
    expect(isIpv4('192.168.3.40')).toBe(true);
    expect(isIpv4('300.1.1.1')).toBe(false);
    expect(isIpv4('1.2.3.4; rm')).toBe(false);
    expect(keyscanArgs({ ip: '10.0.0.1', port: 22 })).toEqual(['-T', '5', '-t', 'ed25519', '-p', '22', '10.0.0.1']);
    expect(() => keyscanArgs({ ip: 'x', port: 22 })).toThrow();
  });
  it('parses keyscan and matches the fingerprint', () => {
    const out = `# 10.0.0.1:22 SSH-2.0-OpenSSH_9.6\n10.0.0.1 ssh-ed25519 ${PUB}\n`;
    expect(parseKeyscan(out)).toEqual([PUB]);
    expect(matchingHostKey([PUB], fp)).toBe(PUB);
    expect(matchingHostKey([PUB], 'SHA256:other')).toBeNull();
    expect(knownHostsText('d1', PUB)).toBe(`hangar-peer-d1 ssh-ed25519 ${PUB}\n`);
    expect(() => knownHostsText('d1', 'a b')).toThrow();
  });
});

describe('shellArgv', () => {
  const win = { shell: 'powershell' as const, mux: { kind: 'psmux', path: 'C:\\Users\\u\\psmux.exe' }, tabId: 't1', cwd: 'C:\\work\\it\'s a dir' };
  it('has common options, -tt, and no -F or IdentityFile', () => {
    const a = shellArgv(target(), win);
    const s = flat(a);
    expect(a[0]).toBe('-tt');
    for (const o of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'HostKeyAlias=hangar-peer-dev1', 'CheckHostIP=no', 'UpdateHostKeys=no', 'ConnectTimeout=8', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ControlMaster=no', 'UserKnownHostsFile=/h/known_hosts', 'GlobalKnownHostsFile=/h/empty']) expect(a).toContain(o);
    expect(s).not.toMatch(/-F |IdentityFile|kill-server/);
    expect(a).toContain('-l');
    expect(a[a.indexOf('-l') + 1]).toBe('u');
    expect(a[a.length - 2]).toBe('192.168.3.40');
  });
  it('omits -l with an override host', () => {
    const a = shellArgv(target({ host: 'mybox', user: null }), win);
    expect(a).not.toContain('-l');
    expect(a[a.length - 2]).toBe('mybox');
  });
  it('powershell command doubles single quotes and uses no double quotes', () => {
    const c = lastOf(shellArgv(target(), win));
    expect(c).toBe(`& 'C:\\Users\\u\\psmux.exe' -L hangar new-session -A -s hangar-ssh-t1 -c 'C:\\work\\it''s a dir'`);
    expect(c).not.toContain('"');
  });
  it('cmd wraps in powershell -NoProfile -Command', () => {
    const c = lastOf(shellArgv(target(), { ...win, shell: 'cmd' }));
    expect(c.startsWith('powershell -NoProfile -Command "& \'C:\\Users\\u\\psmux.exe\'')).toBe(true);
    expect(c.endsWith('"')).toBe(true);
    expect(() => shellArgv(target(), { ...win, shell: 'cmd', cwd: 'C:\\a%b' })).toThrow(/bad-cwd/);
  });
  it('posix wraps in single quotes with the mux path', () => {
    const c = lastOf(shellArgv(target(), { shell: 'posix', mux: { kind: 'tmux', path: '/opt/homebrew/bin/tmux' }, tabId: 't1', cwd: "/a/it's" }));
    expect(c).toBe(`'/opt/homebrew/bin/tmux' -L hangar new-session -A -s hangar-ssh-t1 -c '/a/it'\\''s'`);
  });
  it('posix without mux path goes through the login shell', () => {
    const c = lastOf(shellArgv(target(), { shell: 'posix', mux: null, tabId: 't1', cwd: '/a b' }));
    expect(c.startsWith('exec "$SHELL" -l -c \'')).toBe(true);
    expect(c).toContain('tmux');
    expect(c).toContain('hangar-ssh-t1');
  });
  it('rejects control characters in cwd', () => {
    for (const cwd of ['/a\nb', '/a\0b', '/a\x07b', '/a\rb']) expect(() => shellArgv(target(), { ...win, cwd })).toThrow(/bad-cwd/);
  });
});

describe('prepare, cd, close', () => {
  const posix = { shell: 'posix' as const, mux: { kind: 'tmux', path: '/usr/bin/tmux' }, tabId: 't1', cwd: '/w/x y' };
  const ps = { shell: 'powershell' as const, mux: { kind: 'psmux', path: 'C:\\p\\psmux.exe' }, tabId: 't1', cwd: "C:\\w\\o'k" };
  it('prepare is tty-less and uses exact targets', () => {
    for (const p of [posix, ps]) {
      const a = prepareArgv(target(), p);
      expect(a[0]).toBe('-T');
      const c = lastOf(a);
      expect(c).toContain('has-session');
      expect(c).toContain('new-session -d');
      expect(c).toContain('#{pane_current_path}');
      expect(c).toContain('hangar-prep');
      expect(c).not.toContain('kill-server');
    }
    expect(lastOf(prepareArgv(target(), ps))).not.toContain('"');
    expect(lastOf(prepareArgv(target(), ps))).toContain("'C:\\w\\o''k'");
  });
  it('reads the mark', () => {
    expect(parsePrepareMark('hangar-prep created match\n')).toEqual({ created: true, cwdMatches: true });
    expect(parsePrepareMark('motd\r\nhangar-prep existed mismatch\r\n')).toEqual({ created: false, cwdMatches: false });
    expect(parsePrepareMark('nothing')).toBeNull();
  });
  it('cd argv per shell', () => {
    const p = lastOf(cdArgv(target(), posix));
    expect(p).toContain('send-keys');
    expect(p).toMatch(/'?=hangar-ssh-t1/);
    expect(p).toContain(`cd -- '\\''/w/x y'\\''; clear`);
    const w = lastOf(cdArgv(target(), ps));
    expect(w).toContain(`Set-Location -LiteralPath ''C:\\w\\o''''k''; Clear-Host`);
  });
  it('close argv kills one session and never the server', () => {
    for (const p of [posix, ps]) {
      const a = closeArgv(target(), p);
      expect(a[0]).toBe('-T');
      expect(lastOf(a)).toMatch(/kill-session -t '?=hangar-ssh-t1/);
      expect(flat(a)).not.toContain('kill-server');
    }
  });
    it('checks one session by exact name without tty and never touches the server', () => {
      for (const p of [posix, ps]) {
        const a = hasSessionArgv(target(), p);
        expect(a[0]).toBe('-T');
        expect(lastOf(a)).toMatch(/has-session -t '?=hangar-ssh-t1/);
        expect(flat(a)).not.toContain('kill-server');
      }
      expect(lastOf(hasSessionArgv(target(), posix))).toContain("'=hangar-ssh-t1'");
    });
});

describe('classifySshFailure', () => {
  const c = (code: number, stderr: string) => classifySshFailure(code, stderr).reason;
  it('maps OpenSSH 9.x mac and Windows samples', () => {
    expect(c(255, 'ssh: connect to host 192.168.3.40 port 22: Connection refused\r\n')).toBe('no-sshd');
    expect(c(255, 'ssh: connect to host 192.168.3.40 port 22: Operation timed out\n')).toBe('unreachable');
    expect(c(255, 'ssh: connect to host 192.168.3.40 port 22: Connection timed out\r\n')).toBe('unreachable');
    expect(c(255, 'ssh: connect to host 10.0.0.9 port 22: No route to host')).toBe('unreachable');
    expect(c(255, 'ssh: Could not resolve hostname mybox: nodename nor servname provided, or not known')).toBe('unreachable');
    expect(c(255, 'u@192.168.3.40: Permission denied (publickey,password,keyboard-interactive).')).toBe('auth');
    expect(c(255, 'Host key verification failed.\r\n')).toBe('host-key');
    expect(c(255, '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@')).toBe('host-key');
    expect(c(255, 'Connection to 192.168.3.40 closed by remote host.')).toBe('dropped');
    expect(c(255, 'client_loop: send disconnect: Broken pipe')).toBe('dropped');
    expect(c(127, 'zsh:1: command not found: tmux')).toBe('no-mux');
    expect(c(1, "'psmux' is not recognized as an internal or external command,\r\noperable program or batch file.")).toBe('no-mux');
    expect(c(1, "& : The term 'C:\\p\\psmux.exe' is not recognized as the name of a cmdlet, function, script file, or operable program.")).toBe('no-mux');
    expect(c(1, 'bash: /usr/bin/tmux: No such file or directory')).toBe('no-mux');
  });
  it('keeps the last stderr line as detail', () => {
    expect(classifySshFailure(255, 'a\r\nssh: connect to host x port 22: Connection refused\r\n\r\n').detail).toBe('ssh: connect to host x port 22: Connection refused');
  });
  it('falls back sensibly', () => {
    expect(c(255, '')).toBe('unreachable');
    expect(c(1, 'boom')).toBe('dropped');
  });
});
