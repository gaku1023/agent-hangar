import { describe, expect, it } from 'vitest';
import { fingerprintOfPublicKey } from '../../config/deviceStatus.ts';
import { classifySshExit, hostAlias, keyscanArgs, knownHostsText, matchingHostKey, parseKeyscan, sshBinaries, sshOptionPath, tunnelArgs } from './command.ts';

const KEY_A = Buffer.from('\0\0\0\x0bssh-ed25519\0\0\0 ' + 'a'.repeat(32)).toString('base64');
const KEY_B = Buffer.from('\0\0\0\x0bssh-ed25519\0\0\0 ' + 'b'.repeat(32)).toString('base64');
const FP_A = fingerprintOfPublicKey(`ssh-ed25519 ${KEY_A}`)!;

const entry = { user: 'alice', keyPath: '/Users/alice/.ssh/id_ed25519', sshPort: 22, hangarPort: 4177 };

/** -o の値を名前で引く。 */
const optsOf = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  args.forEach((a, i) => { if (a === '-o') { const [k, ...v] = args[i + 1]!.split('='); out[k!] = v.join('='); } });
  return out;
};

describe('ssh の引数', () => {
  it('厳格な照合、専用の known_hosts、ed25519、BatchMode、鍵を渡し、シェルのコマンドは打たない', () => {
    const args = tunnelArgs({ deviceId: 'dev-1', ip: '192.168.0.20', entry, localPort: 50123, knownHosts: '/h/peer-ssh/known_hosts-dev-1', emptyKnownHosts: '/h/peer-ssh/empty_known_hosts', platform: 'darwin' });
    const o = optsOf(args);
    expect(o).toMatchObject({
      StrictHostKeyChecking: 'yes',
      UserKnownHostsFile: '/h/peer-ssh/known_hosts-dev-1',
      GlobalKnownHostsFile: '/h/peer-ssh/empty_known_hosts',
      HostKeyAlgorithms: 'ssh-ed25519',
      HostKeyAlias: 'hangar-peer-dev-1',
      BatchMode: 'yes',
      CheckHostIP: 'no',
      ExitOnForwardFailure: 'yes',
      ServerAliveInterval: '15',
      ControlPath: 'none',
      ForwardAgent: 'no',
    });
    expect(args.slice(0, 4)).toEqual(['-N', '-T', '-F', 'none']);
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe(entry.keyPath);
    expect(args[args.indexOf('-l') + 1]).toBe('alice');
    expect(args[args.indexOf('-L') + 1]).toBe('127.0.0.1:50123:127.0.0.1:4177');
    // 宛先は最後の 1 つで、その後にコマンドを付けない。
    expect(args.at(-1)).toBe('192.168.0.20');
  });

  it('IPv4 でない宛先は引数にしない', () => {
    for (const ip of ['-oProxyCommand=x', 'host.example', '192.168.0.256', '1.2.3']) {
      expect(() => tunnelArgs({ deviceId: 'd', ip, entry, localPort: 1, knownHosts: '/a', emptyKnownHosts: '/b', platform: 'linux' })).toThrow();
      expect(() => keyscanArgs({ ip, port: 22 })).toThrow();
    }
    expect(keyscanArgs({ ip: '10.0.0.5', port: 2222 })).toEqual(['-T', '5', '-t', 'ed25519', '-p', '2222', '10.0.0.5']);
  });

  it('Windows のパスは / にし、空白を含めば引用符で包み、% を逃がす', () => {
    expect(sshOptionPath('C:\\Users\\A B\\.agent-hangar\\peer-ssh\\known_hosts-d', 'win32')).toBe('"C:/Users/A B/.agent-hangar/peer-ssh/known_hosts-d"');
    expect(sshOptionPath('/Users/x%d/known', 'darwin')).toBe('/Users/x%%d/known');
    expect(() => sshOptionPath('/a"b', 'linux')).toThrow();
  });

  it('ssh と ssh-keyscan の場所は OS ごとの決まった場所を先に見る', () => {
    expect(sshBinaries('win32', { SystemRoot: 'C:\\Windows' }, () => true)).toEqual({ ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', keyscan: 'C:\\Windows\\System32\\OpenSSH\\ssh-keyscan.exe' });
    expect(sshBinaries('darwin', {}, () => true)).toEqual({ ssh: '/usr/bin/ssh', keyscan: '/usr/bin/ssh-keyscan' });
    expect(sshBinaries('linux', {}, () => false)).toEqual({ ssh: 'ssh', keyscan: 'ssh-keyscan' });
  });
});

describe('ホスト鍵', () => {
  it('ssh-keyscan の出力から ed25519 の鍵だけを取る', () => {
    const out = `# 192.168.0.20:22 SSH-2.0-OpenSSH_9.6\r\n192.168.0.20 ssh-ed25519 ${KEY_A}\r\n192.168.0.20 ssh-rsa AAAAB3Nza\r\n`;
    expect(parseKeyscan(out)).toEqual([KEY_A]);
    expect(parseKeyscan('')).toEqual([]);
  });

  it('同期の指紋と同じ鍵だけを選ぶ', () => {
    expect(matchingHostKey([KEY_B, KEY_A], FP_A)).toBe(KEY_A);
    expect(matchingHostKey([KEY_B], FP_A)).toBeNull();
  });

  it('known_hosts は PC ごとの別名で 1 行だけ書く（IP を書かない）', () => {
    expect(knownHostsText('dev-1', KEY_A)).toBe(`${hostAlias('dev-1')} ssh-ed25519 ${KEY_A}\n`);
    expect(() => knownHostsText('dev-1', 'x y')).toThrow();
  });
});

describe('ssh の終わり方の読み方', () => {
  it('ホスト鍵の照合に落ちたら mismatch', () => {
    const changed = '@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n...\r\nHost key verification failed.\r\n';
    expect(classifySshExit(255, changed)).toEqual({ reason: 'ssh-host-key-mismatch', detail: 'host-key' });
    expect(classifySshExit(255, 'No ED25519 host key is known for hangar-peer-d and you have requested strict checking.\r\nHost key verification failed.\r\n').reason).toBe('ssh-host-key-mismatch');
  });

  it('ほかは届かないとし、手掛かりを添える', () => {
    expect(classifySshExit(255, 'alice@192.168.0.20: Permission denied (publickey).')).toEqual({ reason: 'ssh-unreachable', detail: 'auth' });
    expect(classifySshExit(255, 'ssh: connect to host 192.168.0.20 port 22: Connection timed out')).toEqual({ reason: 'ssh-unreachable', detail: 'network' });
    expect(classifySshExit(255, 'bind [127.0.0.1]:50123: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 50123\r\nCould not request local forwarding.')).toEqual({ reason: 'ssh-unreachable', detail: 'forward' });
    expect(classifySshExit(null, '')).toEqual({ reason: 'ssh-unreachable', detail: 'network' });
  });
});
