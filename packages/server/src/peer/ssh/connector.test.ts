import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerDeviceStatus } from '@agent-hangar/shared';
import { fingerprintOfPublicKey } from '../../config/deviceStatus.ts';
import { SshPeerConnector, type SshChild, type SshConnectorDeps, type SshPeerNotice, type SshProbe } from './connector.ts';

const KEY_A = Buffer.from('\0\0\0\x0bssh-ed25519\0\0\0 ' + 'a'.repeat(32)).toString('base64');
const KEY_B = Buffer.from('\0\0\0\x0bssh-ed25519\0\0\0 ' + 'b'.repeat(32)).toString('base64');
const FP_A = fingerprintOfPublicKey(`ssh-ed25519 ${KEY_A}`)!;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

class FakeChild extends EventEmitter implements SshChild {
  static next = 1000;
  pid = FakeChild.next++;
  stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; queueMicrotask(() => this.emit('exit', null, 'SIGTERM')); return true; }
  die(code: number, stderr = ''): void { this.stderr.write(stderr); setImmediate(() => this.emit('exit', code, null)); }
}

const peer = (over: Partial<PeerDeviceStatus['status'] & object> = {}, name = 'mac'): PeerDeviceStatus => ({
  device_id: 'dev-mac', name, platform: 'darwin', last_seen_at: 1, outdated: false,
  status: { accounts: [], agents: [], lan_ips: ['192.168.0.20'], ssh_host_key: FP_A, hangar_version: '0.18.0', ...over },
});

function setup(o: { peers?: PeerDeviceStatus[]; scans?: Record<string, string>; probe?: SshProbe; onSpawn?: (c: FakeChild, args: string[]) => void; registered?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-conn-'));
  dirs.push(home);
  const notices: SshPeerNotice[] = [];
  const spawned: { child: FakeChild; args: string[]; file: string }[] = [];
  const scanned: string[] = [];
  let t = 0;
  let port = 50000;
  const deps: SshConnectorDeps = {
    home, platform: 'darwin',
    binaries: { ssh: '/usr/bin/ssh', keyscan: '/usr/bin/ssh-keyscan' },
    store: { get: (id) => (o.registered === false || id !== 'dev-mac' ? null : { user: 'alice', keyPath: '/Users/alice/.ssh/id_ed25519', sshPort: 22, hangarPort: 4177 }) },
    peers: () => o.peers ?? [peer()],
    run: async (_file, args) => {
      const ip = args.at(-1)!;
      scanned.push(ip);
      return { code: 0, stdout: o.scans?.[ip] ?? `${ip} ssh-ed25519 ${KEY_A}\n`, stderr: '' };
    },
    spawn: (file, args) => {
      const child = new FakeChild();
      spawned.push({ child, args, file });
      o.onSpawn?.(child, args);
      return child;
    },
    freePort: async () => port++,
    probe: o.probe ?? (async () => 'ok'),
    notify: (n) => { notices.push(n); },
    sleep: async () => { t += 250; await new Promise((r) => setImmediate(r)); },
    now: () => t,
    readyTimeoutMs: 2_000,
  };
  return { c: new SshPeerConnector(deps), notices, spawned, scanned, home };
}

describe('SSH のトンネルを張る', () => {
  it('同期の指紋と合えば、専用の known_hosts を書いて張り、相手の hangar に届く', async () => {
    const s = setup();
    const r = await s.c.connect('dev-mac');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tunnel.baseUrl).toBe('http://127.0.0.1:50000');
    expect(s.spawned[0]!.file).toBe('/usr/bin/ssh');
    const known = fs.readFileSync(path.join(s.home, 'peer-ssh', 'known_hosts-dev-mac'), 'utf8');
    expect(known).toBe(`hangar-peer-dev-mac ssh-ed25519 ${KEY_A}\n`);
    expect(s.spawned[0]!.args).toContain(`UserKnownHostsFile=${path.join(s.home, 'peer-ssh', 'known_hosts-dev-mac')}`);
    expect(fs.readFileSync(path.join(s.home, 'peer-ssh', 'empty_known_hosts'), 'utf8')).toBe('');
    expect(s.c.hostKeyState('dev-mac')).toBe('ok');
  });

  it('相手の鍵が同期の指紋と違えば ssh を起こさず、mismatch で知らせる', async () => {
    const s = setup({ scans: { '192.168.0.20': `192.168.0.20 ssh-ed25519 ${KEY_B}\n` } });
    expect(await s.c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-host-key-mismatch' });
    expect(s.spawned).toHaveLength(0);
    expect(s.notices).toEqual([{ kind: 'host-key-mismatch', deviceId: 'dev-mac', name: 'mac' }]);
    expect(s.c.hostKeyState('dev-mac')).toBe('mismatch');
  });

  it('鍵を取った後に ssh の照合で落ちても mismatch で知らせる', async () => {
    const s = setup({ onSpawn: (c) => { c.die(255, 'Host key verification failed.\r\n'); }, probe: async () => 'down' });
    expect(await s.c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-host-key-mismatch' });
    expect(s.notices.map((n) => n.kind)).toEqual(['host-key-mismatch']);
  });

  it('IP が変わっても同期の今の lan_ips を順に試してつながる。古い IP の別の機械は無視する', async () => {
    const s = setup({
      peers: [peer({ lan_ips: ['10.0.0.9', '192.168.0.31'] })],
      scans: { '10.0.0.9': `10.0.0.9 ssh-ed25519 ${KEY_B}\n`, '192.168.0.31': `192.168.0.31 ssh-ed25519 ${KEY_A}\n` },
    });
    const r = await s.c.connect('dev-mac');
    expect(r.ok && r.tunnel.ip).toBe('192.168.0.31');
    expect(s.scanned).toEqual(['10.0.0.9', '192.168.0.31']);
    expect(s.spawned[0]!.args.at(-1)).toBe('192.168.0.31');
    expect(s.notices).toEqual([]);
  });

  it('どの IP も応えなければ ssh-unreachable', async () => {
    const s = setup({ scans: { '192.168.0.20': '' } });
    expect(await s.c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-unreachable', detail: 'network' });
    expect(s.notices).toEqual([]);
  });

  it('認証に落ちたら ssh-unreachable（auth）', async () => {
    const s = setup({ onSpawn: (c) => { c.die(255, 'alice@192.168.0.20: Permission denied (publickey).\r\n'); }, probe: async () => 'down' });
    expect(await s.c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-unreachable', detail: 'auth' });
  });

  it('応えないまま上限を過ぎたら、自分の ssh を止めて ssh-unreachable', async () => {
    const s = setup({ probe: async () => 'down' });
    expect(await s.c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-unreachable', detail: 'timeout' });
    expect(s.spawned[0]!.child.killed).toBe(true);
  });

  it('相手が token を断るか別の PC なら止める', async () => {
    const s = setup({ probe: async () => 'refused' });
    expect(await s.c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-unreachable', detail: 'token' });
    expect(s.spawned[0]!.child.killed).toBe(true);
  });

  it('口の取り合いで落ちたら別の口で 1 度だけ張り直す', async () => {
    let n = 0;
    const s = setup({ onSpawn: (c) => { if (n++ === 0) c.die(255, 'Could not request local forwarding.\r\n'); }, probe: async (url) => (url.endsWith(':50001') ? 'ok' : 'down') });
    const r = await s.c.connect('dev-mac');
    expect(r.ok && r.tunnel.localPort).toBe(50001);
    expect(s.spawned).toHaveLength(2);
  });

  it('登録が無い、同期にホスト鍵が無い PC にはつながない', async () => {
    expect(await setup({ registered: false }).c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-not-registered' });
    const s = setup({ peers: [peer({ ssh_host_key: null })] });
    expect(await s.c.connect('dev-mac')).toEqual({ ok: false, reason: 'ssh-no-host-key' });
    expect(s.scanned).toEqual([]);
  });

  it('切れたら知らせ、自分で閉じたときは知らせない。closeAll は自分の ssh だけを止める', async () => {
    const s = setup();
    const r = await s.c.connect('dev-mac');
    if (!r.ok) throw new Error('not connected');
    const closed: string[] = [];
    r.tunnel.onClose((d) => { closed.push(d); });
    s.spawned[0]!.child.die(255, 'Timeout, server 192.168.0.20 not responding.\r\n');
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(closed).toEqual(['network']);
    expect(s.notices).toEqual([{ kind: 'tunnel-closed', deviceId: 'dev-mac', name: 'mac', detail: 'network' }]);
    expect(s.c.tunnels()).toEqual([]);

    const r2 = await s.c.connect('dev-mac');
    if (!r2.ok) throw new Error('not connected');
    s.c.closeAll();
    await new Promise((res) => setImmediate(res));
    expect(s.spawned[1]!.child.killed).toBe(true);
    expect(s.notices).toHaveLength(1);
  });
});
