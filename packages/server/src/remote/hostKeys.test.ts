import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHostKeys, type HostKeyExec } from './hostKeys.ts';

const mkKey = (n: number): string => Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString('base64');
const PUB = mkKey(7);
const OTHER = mkKey(9);
const fp = (b: string): string => 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b, 'base64')).digest('base64').replace(/=+$/, '');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

type Call = { file: string; args: string[] };
const mkExec = (scan: string, calls: Call[] = [], g = 'hostname 10.1.1.1\nport 2222\n'): HostKeyExec => async (file, args) => {
  calls.push({ file, args });
  if (args[0] === '-G') return { code: 0, stdout: g, stderr: '' };
  return { code: 0, stdout: scan, stderr: '' };
};
const base = (over = {}) => ({ deviceId: 'd1', address: '192.168.3.40', port: 22, override: null as string | null, sshHostKey: fp(PUB) as string | null, hostPubkey: null as string | null, dir, platform: 'darwin' as NodeJS.Platform, ...over });
const kh = (): string => fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8');

describe('ensureHostKeys', () => {
  it('writes the status public key without running anything, 0600, plus an empty global file', async () => {
    const calls: Call[] = [];
    const r = await ensureHostKeys(base({ hostPubkey: PUB }), { exec: mkExec('', calls) });
    expect(r).toEqual({ ok: true, knownHosts: path.join(dir, 'known_hosts'), emptyKnownHosts: path.join(dir, 'known_hosts.empty') });
    expect(kh()).toBe(`hangar-peer-d1 ssh-ed25519 ${PUB}\n`);
    expect(fs.statSync(path.join(dir, 'known_hosts')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, 'known_hosts.empty'), 'utf8')).toBe('');
    expect(calls).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(['known_hosts', 'known_hosts.empty']);
  });
  it('accepts a "ssh-ed25519 <key>" public key and keeps other devices lines, replacing its own', async () => {
    fs.writeFileSync(path.join(dir, 'known_hosts'), `hangar-peer-d2 ssh-ed25519 ${OTHER}\nhangar-peer-d1 ssh-ed25519 ${OTHER}\n`);
    await ensureHostKeys(base({ hostPubkey: `ssh-ed25519 ${PUB}` }), { exec: mkExec('') });
    expect(kh()).toBe(`hangar-peer-d2 ssh-ed25519 ${OTHER}\nhangar-peer-d1 ssh-ed25519 ${PUB}\n`);
  });
  it('keyscans when no public key and writes only on fingerprint match', async () => {
    const calls: Call[] = [];
    const r = await ensureHostKeys(base(), { exec: mkExec(`# c\n192.168.3.40 ssh-ed25519 ${PUB}\n`, calls) });
    expect(r.ok).toBe(true);
    expect(kh()).toBe(`hangar-peer-d1 ssh-ed25519 ${PUB}\n`);
    expect(calls[0]?.args).toEqual(['-T', '5', '-t', 'ed25519', '-p', '22', '192.168.3.40']);
  });
  it('fails with host-key and writes nothing when the fingerprint differs', async () => {
    const r = await ensureHostKeys(base(), { exec: mkExec(`h ssh-ed25519 ${OTHER}\n`) });
    expect(r).toEqual({ ok: false, reason: 'host-key' });
    expect(fs.existsSync(path.join(dir, 'known_hosts'))).toBe(false);
  });
  it('fails with no-sshd when there is no fingerprint or no key', async () => {
    expect(await ensureHostKeys(base({ sshHostKey: null }), { exec: mkExec(`h ssh-ed25519 ${PUB}\n`) })).toEqual({ ok: false, reason: 'no-sshd' });
    expect(await ensureHostKeys(base(), { exec: mkExec('') })).toEqual({ ok: false, reason: 'no-sshd' });
  });
  it('resolves an override Host with ssh -G, then keyscans that hostname and port', async () => {
    const calls: Call[] = [];
    const r = await ensureHostKeys(base({ override: 'mywin' }), { exec: mkExec(`x ssh-ed25519 ${PUB}\n`, calls) });
    expect(r.ok).toBe(true);
    expect(calls[0]?.args).toEqual(['-G', '--', 'mywin']);
    expect(calls[1]?.args).toEqual(['-T', '5', '-t', 'ed25519', '-p', '2222', '10.1.1.1']);
  });
  it('rejects a bad hostname from ssh -G', async () => {
    const r = await ensureHostKeys(base({ override: 'mywin' }), { exec: mkExec('', [], 'hostname -oProxyCommand=x\nport 22\n') });
    expect(r).toEqual({ ok: false, reason: 'no-sshd' });
  });
});
