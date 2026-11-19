import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDeviceStatus, type DeviceStatus } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { applyRemoteChange } from '../sync/apply.ts';
import { touchDevice } from './devicePresence.ts';
import { collectDeviceStatus, opencodeStatusFeed, fingerprintOfPublicKey, hostKeyFingerprint, hostKeyPaths, lanIpv4s, readPeerStatuses, refreshDeviceStatus, type StatusSources } from './deviceStatus.ts';

const sources = (over: Partial<StatusSources> = {}): StatusSources => ({
  accounts: () => [{ agent: 'claude-code', name: 'Main', logged_in: true }, { agent: 'codex', name: 'Work', logged_in: false }],
  agents: () => ['claude-code', 'codex'],
  lanIps: () => ['192.168.0.5'],
  hostKey: () => 'SHA256:abc',
  version: '1.2.3',
  ...over,
});

describe('様子を組む', () => {
  it('読み取りを集めて、並びを決めた形にする', () => {
    const s = collectDeviceStatus(sources({ lanIps: () => ['192.168.0.9', '10.0.0.2'] }));
    expect(s).toEqual({
      accounts: [{ agent: 'claude-code', name: 'Main', logged_in: true }, { agent: 'codex', name: 'Work', logged_in: false }],
      agents: ['claude-code', 'codex'], lan_ips: ['10.0.0.2', '192.168.0.9'], ssh_host_key: 'SHA256:abc', hangar_version: '1.2.3',
    });
  });

  it('opencode を起こせる PC は、opencode の一覧を載せる。ローカルのサーバーに無いモデルは載せない（#698）', () => {
    const dto = {
      version: '2.1.4', verified: true, modes: [{ id: 'build', description: null }],
      models: [
        { id: 'lmstudio/qwen', label: 'Qwen', group: 'LM Studio', provider: 'lmstudio', tools: true, context: 1000, cost: null, missing: true },
        { id: 'opencode/deepseek-free', label: 'DeepSeek', group: 'Zen', provider: 'opencode', tools: true, context: 2000, cost: { input: 0, output: 0 }, missing: false },
      ],
      providers: [{ id: 'opencode', name: 'Zen', where: 'remote' as const }], defaultModel: 'lmstudio/qwen', pricesAt: 5, fetchedAt: 9, stale: true,
    };
    const s = collectDeviceStatus(sources({ agents: () => ['claude-code', 'opencode'], opencode: () => dto }));
    expect(s.opencode).toEqual({
      modes: [{ id: 'build', description: null }],
      models: [{ id: 'opencode/deepseek-free', label: 'DeepSeek', group: 'Zen', provider: 'opencode', tools: true, context: 2000, cost: { input: 0, output: 0 } }],
      providers: [{ id: 'opencode', name: 'Zen', where: 'remote' }], defaultModel: 'lmstudio/qwen',
    });
    // 読み戻しても同じ形になる（同期の行の比べで、毎回書き直さない）。
    expect(parseDeviceStatus(JSON.stringify(s))).toEqual(s);
    // opencode を起こせない PC、一覧をまだ取れていない PC は載せない。
    expect(collectDeviceStatus(sources({ opencode: () => dto })).opencode).toBeUndefined();
    expect(collectDeviceStatus(sources({ agents: () => ['opencode'], opencode: () => null })).opencode).toBeUndefined();
  });

  it('統括の系譜の id を載せる。系譜が無ければ鍵ごと載せない（ほかの PC がサイドバーから外すため）', () => {
    const s = collectDeviceStatus(sources({ orchestratorIds: () => ['now', 'old', 'now'] }));
    expect(s.orchestrator_ids).toEqual(['now', 'old']);
    expect(parseDeviceStatus(JSON.stringify(s))).toEqual(s);
    expect('orchestrator_ids' in collectDeviceStatus(sources({ orchestratorIds: () => [] }))).toBe(false);
    expect('orchestrator_ids' in collectDeviceStatus(sources())).toBe(false);
  });

  it('opencode の一覧は手元のものを返し、無いか古ければ裏で取り直して、取れたら知らせる（#698）', async () => {
    let now = 1_000_000;
    let held: { fetchedAt: number } | null = null;
    const gets: number[] = [];
    let fetched = 0;
    const options = {
      last: () => held as never,
      get: async () => { gets.push(now); await Promise.resolve(); held = { fetchedAt: now }; return held as never; },
    };
    let usable = true;
    const feed = opencodeStatusFeed({ options, usable: () => usable, now: () => now, maxAgeMs: 1000, onFetched: () => { fetched++; } });
    expect(feed()).toBeNull();
    // 取りに行っている間に呼ばれても、二重には取らない。
    expect(feed()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(gets).toEqual([1_000_000]);
    expect(fetched).toBe(1);
    expect(feed()).toEqual({ fetchedAt: 1_000_000 });
    now += 500;
    feed();
    expect(gets).toHaveLength(1);
    now += 600;
    feed();
    await new Promise((r) => setTimeout(r, 0));
    expect(gets).toHaveLength(2);
    // opencode を起こせないときは取りに行かず、載せない。
    usable = false;
    now += 5000;
    expect(feed()).toBeNull();
    await Promise.resolve();
    expect(gets).toHaveLength(2);
  });

  it('LAN の IP はプライベートの IPv4 だけで、ループバックと仮想の口は外す', () => {
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal });
    const out = lanIpv4s({
      Ethernet: [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      lo: [v4('127.0.0.1', true)],
      'vEthernet (WSL)': [v4('172.20.0.1')],
      docker0: [v4('172.17.0.1')],
      utun3: [v4('10.8.0.2')],
      en0: [v4('10.0.0.7'), v4('8.8.8.8'), v4('169.254.1.1')],
    });
    expect(out).toEqual(['10.0.0.7', '192.168.1.20']);
  });
});

describe('ホスト鍵の指紋', () => {
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pub = `ssh-ed25519 ${blob.toString('base64')} root@host\n`;

  it('公開鍵から ssh-keygen -lf と同じ SHA256 の形を作る（末尾の = は付けない）', () => {
    const expected = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
    expect(fingerprintOfPublicKey(pub)).toBe(expected);
    expect(expected).not.toMatch(/=/);
  });

  it('形の違う内容は null', () => {
    expect(fingerprintOfPublicKey('')).toBeNull();
    expect(fingerprintOfPublicKey('not a key')).toBeNull();
    expect(fingerprintOfPublicKey('ssh-rsa AAAA')).toBeNull();
  });

  it('置き場は Windows が ProgramData、そのほかが /etc/ssh', () => {
    expect(hostKeyPaths('win32', { ProgramData: 'C:\\ProgramData' })[0]).toMatch(/ssh_host_ed25519_key\.pub$/);
    expect(hostKeyPaths('win32', { ProgramData: 'C:\\ProgramData' })[0]).toContain('ProgramData');
    expect(hostKeyPaths('darwin', {})).toEqual(['/etc/ssh/ssh_host_ed25519_key.pub']);
    expect(hostKeyPaths('linux', {})).toEqual(['/etc/ssh/ssh_host_ed25519_key.pub']);
  });

  it('ファイルが読めなければ null', () => {
    expect(hostKeyFingerprint('linux', {}, () => { throw new Error('ENOENT'); })).toBeNull();
    expect(hostKeyFingerprint('linux', {}, () => pub)).toMatch(/^SHA256:/);
  });
});

describe('様子の書き込み', () => {
  let db: Db;
  const device = { id: 'dev-1', name: 'mini', platform: 'darwin' };
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });
  const stored = () => (db.prepare('select status from devices where id = ?').get(device.id) as { status: string | null } | undefined)?.status ?? null;
  const changes = () => (db.prepare("select count(*) c from changes where table_name = 'devices'").get() as { c: number }).c;

  it('初めは書き、そのあと変わらなければ書かない', () => {
    expect(refreshDeviceStatus({ db, device, collect: () => collectDeviceStatus(sources()) })).toBe(true);
    const n = changes();
    expect(parseDeviceStatus(stored())?.hangar_version).toBe('1.2.3');
    expect(refreshDeviceStatus({ db, device, collect: () => collectDeviceStatus(sources()) })).toBe(false);
    expect(changes()).toBe(n);
  });

  it('中身が変わったときだけ書き直す', () => {
    refreshDeviceStatus({ db, device, collect: () => collectDeviceStatus(sources()) });
    const n = changes();
    const wrote = refreshDeviceStatus({ db, device, collect: () => collectDeviceStatus(sources({ accounts: () => [{ agent: 'claude-code', name: 'Main', logged_in: false }] })) });
    expect(wrote).toBe(true);
    // 未送信の古い変更は畳まれるので、行は増えないが、最後の変更は新しい様子を持つ。
    expect(changes()).toBeGreaterThanOrEqual(n);
    const last = db.prepare("select payload from changes where table_name = 'devices' order by rowid desc limit 1").get() as { payload: string };
    expect(parseDeviceStatus((JSON.parse(last.payload) as { status: string }).status)?.accounts[0]?.logged_in).toBe(false);
    expect(parseDeviceStatus(stored())?.accounts).toEqual([{ agent: 'claude-code', name: 'Main', logged_in: false }]);
  });

  it('生存の刻み（touchDevice）は様子を消さない', () => {
    refreshDeviceStatus({ db, device, collect: () => collectDeviceStatus(sources()) });
    touchDevice({ db, device, shellHook: () => ({ state: 'off' }), now: () => 5000 });
    expect(parseDeviceStatus(stored())).not.toBeNull();
  });

  it('集めるのに失敗したら何も書かず、例外も出さない', () => {
    expect(refreshDeviceStatus({ db, device, collect: () => { throw new Error('boom'); } })).toBe(false);
    expect(stored()).toBeNull();
  });
});

describe('別の PC の様子を読む', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });
  const status: DeviceStatus = { accounts: [{ agent: 'claude-code', name: 'Main', logged_in: true }], agents: ['claude-code'], lan_ips: ['192.168.0.6'], ssh_host_key: null, hangar_version: '9.9.9' };

  it('自分を除き、様子の欄がある PC は status を、無い PC は outdated を返す', () => {
    upsertShared(db, 'devices', { id: 'self', name: 'me', platform: 'win32', last_seen_at: 1 }, 'self');
    upsertShared(db, 'devices', { id: 'new', name: 'newer', platform: 'darwin', last_seen_at: 2, status: JSON.stringify(status) }, 'new');
    upsertShared(db, 'devices', { id: 'old', name: 'older', platform: 'linux', last_seen_at: 3 }, 'old');
    const rows = readPeerStatuses(db, 'self');
    expect(rows.map((r) => r.device_id).sort()).toEqual(['new', 'old']);
    expect(rows.find((r) => r.device_id === 'new')).toMatchObject({ name: 'newer', platform: 'darwin', last_seen_at: 2, status, outdated: false });
    expect(rows.find((r) => r.device_id === 'old')).toMatchObject({ status: null, outdated: true });
  });

  it('壊れた様子の欄は、様子の欄が無いのと同じに扱う', () => {
    upsertShared(db, 'devices', { id: 'bad', name: 'x', platform: 'linux', last_seen_at: 1, status: '{nope' }, 'bad');
    expect(readPeerStatuses(db, 'self')[0]).toMatchObject({ status: null, outdated: true });
  });

  it('消された PC は出さない', () => {
    upsertShared(db, 'devices', { id: 'gone', name: 'x', platform: 'linux', last_seen_at: 1, deleted_at: 9 }, 'gone');
    expect(readPeerStatuses(db, 'self')).toEqual([]);
  });

  it('同期で届いた行の status を取り込み、列を知らない古い版の形（欄なし）の行も壊さない', () => {
    const base = { tableName: 'devices', rowId: 'p', deviceId: 'p', updatedAt: 10, seq: 1 };
    const row = { id: 'p', name: 'peer', platform: 'darwin', last_seen_at: 10, updated_at: 10, deleted_at: null, origin_device: 'p' };
    applyRemoteChange(db, { ...base, op: 'upsert', payload: { ...row, status: JSON.stringify(status), extra_future_column: 'x' } } as never, { ownDeviceId: 'self', skipOwn: true });
    expect(readPeerStatuses(db, 'self')[0]).toMatchObject({ outdated: false, status });
    applyRemoteChange(db, { ...base, rowId: 'q', deviceId: 'q', op: 'upsert', payload: { ...row, id: 'q', origin_device: 'q' } } as never, { ownDeviceId: 'self', skipOwn: true });
    expect(readPeerStatuses(db, 'self').find((r) => r.device_id === 'q')).toMatchObject({ outdated: true });
  });
});
