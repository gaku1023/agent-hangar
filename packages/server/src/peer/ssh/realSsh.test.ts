import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sshBinaries, tunnelArgs } from './command.ts';

/**
 * 実機の OpenSSH が、組んだ引数をそのまま読めるか（ssh -G は設定を読んで出すだけで、つながない）。
 * Windows の OpenSSH for Windows と macOS の ssh で、パスの空白、%、\ の扱いを確かめる。
 * CI には入れない。手元で HANGAR_REAL_SSH=1 を付けて回す。
 */
const run = process.env.HANGAR_REAL_SSH === '1';

describe.skipIf(!run)('実機の ssh -G', () => {
  it('厳格な照合、専用の known_hosts、別名、転送が、そのとおりに読まれる', () => {
    const win = process.platform === 'win32';
    const dir = win ? 'C:\\Users\\A B\\x%y\\.agent-hangar\\peer-ssh' : '/Users/a b/x%y/.agent-hangar/peer-ssh';
    // ssh -G は無い鍵を読み捨てるので、空白と % を含む置き場に鍵のふりのファイルを置く。
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar ssh%k-'));
    const key = path.join(keyDir, 'id_ed25519');
    fs.writeFileSync(key, '');
    const sep = win ? '\\' : '/';
    const args = tunnelArgs({ deviceId: 'dev-1', ip: '192.168.0.20', entry: { user: 'alice', keyPath: key, sshPort: 2222, hangarPort: 4177 }, localPort: 50123, knownHosts: `${dir}${sep}known_hosts-dev-1`, emptyKnownHosts: `${dir}${sep}empty_known_hosts`, platform: process.platform });
    let out: string;
    try {
      out = execFileSync(sshBinaries(process.platform, process.env).ssh, ['-G', ...args], { encoding: 'utf8' });
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
    const rows = out.split(/\r?\n/).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)] as const; });
    const lines = new Map(rows);
    const ids = rows.filter(([k]) => k === 'identityfile').map(([, v]) => v);
    const slash = (p: string) => (win ? p.replace(/\\/g, '/') : p);
    expect(lines.get('user')).toBe('alice');
    expect(lines.get('hostname')).toBe('192.168.0.20');
    expect(lines.get('port')).toBe('2222');
    expect(lines.get('stricthostkeychecking')).toBe('true');
    expect(lines.get('batchmode')).toBe('yes');
    expect(lines.get('hostkeyalgorithms')).toBe('ssh-ed25519');
    expect(lines.get('hostkeyalias')).toBe('hangar-peer-dev-1');
    expect(lines.get('userknownhostsfile')).toBe(slash(`${dir}${sep}known_hosts-dev-1`));
    expect(lines.get('globalknownhostsfile')).toBe(slash(`${dir}${sep}empty_known_hosts`));
    expect(lines.get('serveraliveinterval')).toBe('15');
    expect(lines.get('exitonforwardfailure')).toBe('yes');
    expect(lines.get('localforward')).toBe('[127.0.0.1]:50123 [127.0.0.1]:4177');
    // IdentityFile は鍵を読むときに % を展開するので、-G は展開の前の %% のまま出す。
    expect(ids.map((v) => slash(v).replace(/%%/g, '%'))).toEqual([slash(key)]);
  });
});
