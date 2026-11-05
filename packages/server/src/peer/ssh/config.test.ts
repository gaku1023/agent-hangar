import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PeerSshStore, parsePeerSshEntry } from './config.ts';

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ssh-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('SSH のつなぎ先の入力', () => {
  it('ポートを省くと 22 と 4177 になる', () => {
    expect(parsePeerSshEntry({ user: 'alice', keyPath: '/home/alice/.ssh/id_ed25519' }, 'darwin')).toEqual({ ok: true, entry: { user: 'alice', keyPath: '/home/alice/.ssh/id_ed25519', sshPort: 22, hangarPort: 4177 } });
  });

  it('Windows の鍵のパスはドライブから始まる絶対パスだけを通す', () => {
    expect(parsePeerSshEntry({ user: 'bob', keyPath: 'C:\\Users\\bob\\.ssh\\id_ed25519' }, 'win32').ok).toBe(true);
    expect(parsePeerSshEntry({ user: 'bob', keyPath: '.ssh\\id_ed25519' }, 'win32')).toEqual({ ok: false, error: 'keyPath' });
    expect(parsePeerSshEntry({ user: 'bob', keyPath: '\\\\server\\share\\key' }, 'win32')).toEqual({ ok: false, error: 'keyPath' });
  });

  it('ssh の引数を崩す値を断る', () => {
    for (const user of ['-oProxyCommand=x', 'a b', 'a"b', 'a\nb', '', 'x'.repeat(65)]) expect(parsePeerSshEntry({ user, keyPath: '/k' }, 'linux')).toEqual({ ok: false, error: 'user' });
    for (const keyPath of ['relative/key', '/a"b', '/a\nb', '']) expect(parsePeerSshEntry({ user: 'a', keyPath }, 'linux')).toEqual({ ok: false, error: 'keyPath' });
    expect(parsePeerSshEntry({ user: 'a', keyPath: '/k', sshPort: 0 }, 'linux')).toEqual({ ok: false, error: 'sshPort' });
    expect(parsePeerSshEntry({ user: 'a', keyPath: '/k', hangarPort: 70000 }, 'linux')).toEqual({ ok: false, error: 'hangarPort' });
    expect(parsePeerSshEntry({ user: 'DOMAIN\\carol', keyPath: '/k' }, 'linux').ok).toBe(true);
  });
});

describe('peer-ssh.json', () => {
  it('device_id ごとに書いて読み、消せる。ファイルは 0600', () => {
    const home = tmp();
    const s = new PeerSshStore(home, 'linux');
    expect(s.list()).toEqual({});
    s.set('dev-1', { user: 'a', keyPath: '/k', sshPort: 22, hangarPort: 4177 });
    s.set('dev-2', { user: 'b', keyPath: '/k2', sshPort: 2222, hangarPort: 4178 });
    expect(new PeerSshStore(home, 'linux').get('dev-2')).toEqual({ user: 'b', keyPath: '/k2', sshPort: 2222, hangarPort: 4178 });
    expect(s.remove('dev-1')).toBe(true);
    expect(s.remove('dev-1')).toBe(false);
    expect(Object.keys(s.list())).toEqual(['dev-2']);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(home, 'peer-ssh.json')).mode & 0o777).toBe(0o600);
  });

  it('壊れたファイルや形の違う行は読み捨てる', () => {
    const home = tmp();
    fs.writeFileSync(path.join(home, 'peer-ssh.json'), '{ broken');
    expect(new PeerSshStore(home, 'linux').list()).toEqual({});
    fs.writeFileSync(path.join(home, 'peer-ssh.json'), JSON.stringify({ v: 1, peers: { 'ok-1': { user: 'a', keyPath: '/k' }, '../x': { user: 'a', keyPath: '/k' }, bad: { user: '-x', keyPath: '/k' } } }));
    expect(new PeerSshStore(home, 'linux').list()).toEqual({ 'ok-1': { user: 'a', keyPath: '/k', sshPort: 22, hangarPort: 4177 } });
  });
});
