import type { ServerEvent } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { createAddressBook } from './addresses.ts';
import type { RemoteShellLinkOptions } from './link.ts';
import { RemoteShellService, validSshHost, type LinkLike } from './service.ts';
import { getRemoteHost, getRemoteTab } from './store.ts';

const ME = 'pc-a';
const PEER = 'pc-b';

class FakeLink implements LinkLike {
  calls: string[] = [];
  constructor(readonly opts: RemoteShellLinkOptions) {}
  async start(): Promise<void> { this.calls.push('start'); }
  async retry(): Promise<void> { this.calls.push('retry'); }
  write(d: string): void { this.calls.push(`write:${d}`); }
  resize(c: number, r: number): void { this.calls.push(`resize:${c}x${r}`); }
  detach(): void { this.calls.push('detach'); }
  async close(): Promise<void> { this.calls.push('close'); }
  async closeUnattached(): Promise<void> { this.calls.push('closeUnattached'); }
}

let db: Db;
let events: ServerEvent[];
let links: FakeLink[];
let svc: RemoteShellService;
let n: number;

const putPeer = (status: string | null = JSON.stringify({ accounts: [], agents: [], lan_ips: ['10.0.0.2'], ssh_host_key: null, hangar_version: '1' })) => {
  upsertShared(db, 'devices', { id: PEER, name: 'Win', platform: 'win32', last_seen_at: 1, status }, PEER);
};
const putRun = (device: string) => {
  upsertShared(db, 'runs', { id: `r-${device}`, session_id: 's1', device_id: device, kind: 'start', tmux_name: 'hangar-x', pid: null, launch_params: '{}', started_at: 5, ended_at: null, end_reason: null, heartbeat_at: 5 }, device);
};
const io = () => {
  const got = { status: [] as unknown[], data: [] as string[], ended: 0 };
  return { got, io: { onStatus: (m: unknown) => { got.status.push(m); }, onData: (d: string) => { got.data.push(d); }, onEnded: () => { got.ended += 1; } } };
};

beforeEach(() => {
  db = openDb(':memory:');
  events = [];
  links = [];
  n = 0;
  upsertShared(db, 'devices', { id: ME, name: 'Mac', platform: 'darwin', last_seen_at: 1 }, ME);
  putPeer();
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: "C:\\work\\it's", home_device: PEER, project_id: null }, PEER);
  svc = new RemoteShellService({
    db, selfId: ME, broadcast: (ev) => { events.push(ev); },
    linkDeps: { db, spawn: () => { throw new Error('no'); }, addressBook: createAddressBook() },
    now: () => 1000, newId: () => `t${++n}`,
    makeLink: (o) => { const l = new FakeLink(o); links.push(l); return l; },
  });
});

describe('open', () => {
  it('会話の持ち主が別の PC なら行を作り、upsert を配って DTO を返す', () => {
    putRun(PEER);
    const dto = svc.open('s1');
    expect(dto).toEqual({ id: 't1', sessionId: 's1', deviceId: PEER, title: 'Win', createdAt: 1000 });
    expect(getRemoteTab(db, 't1')).toMatchObject({ remoteName: 'hangar-ssh-t1', closedAt: null });
    expect(events).toEqual([{ type: 'remoteTab.upsert', tab: dto }]);
    expect(svc.tabs()).toEqual([dto]);
  });
  it('持ち主が手元か、引けなければ null', () => {
    expect(svc.open('s1')).toBeNull();
    putRun(ME);
    expect(svc.open('s1')).toBeNull();
    expect(events).toEqual([]);
  });
  it('相手の status が無くても（sshd が無くても）開ける', () => {
    upsertShared(db, 'devices', { id: PEER, name: 'Win', platform: 'win32', last_seen_at: 1, status: null }, PEER); putRun(PEER);
    expect(svc.open('s1')).not.toBeNull();
  });
});

describe('connector', () => {
  it('開いたタブだけにつなぐ。status、platform、上書き、cwd を link に渡す', () => {
    putRun(PEER);
    svc.setHost(PEER, 'win-box');
    const tab = svc.open('s1')!;
    expect(svc.connector('nope')).toBeNull();
    const { io: i } = io();
    const h = svc.connector(tab.id)!.open(i);
    void h.start();
    const l = links[0]!;
    expect(l.opts).toMatchObject({ tabId: 't1', deviceId: PEER, peerPlatform: 'win32', override: 'win-box', cwd: "C:\\work\\it's" });
    expect(l.opts.status?.lan_ips).toEqual(['10.0.0.2']);
    expect(l.calls).toEqual(['start']);
  });
  it('閉じたタブにはつながない', async () => {
    putRun(PEER);
    const tab = svc.open('s1')!;
    await svc.close(tab.id);
    expect(svc.connector(tab.id)).toBeNull();
  });
  it('相手のシェルが終わったら（onEnded）、画面に伝えてからタブを閉じる', async () => {
    putRun(PEER);
    const tab = svc.open('s1')!;
    const { io: i, got } = io();
    svc.connector(tab.id)!.open(i);
    links[0]!.opts.onEnded!();
    await svc.idle();
    expect(got.ended).toBe(1);
    expect(getRemoteTab(db, tab.id)?.closedAt).toBe(1000);
    expect(events.at(-1)).toEqual({ type: 'remoteTab.closed', id: tab.id });
  });
});

describe('close', () => {
  it('つないでいる link があれば 1 本を close し、残りは detach。行を閉じて closed を配る', async () => {
    putRun(PEER);
    const tab = svc.open('s1')!;
    svc.connector(tab.id)!.open(io().io);
    svc.connector(tab.id)!.open(io().io);
    await svc.close(tab.id);
    expect(links.map((l) => l.calls.at(-1))).toEqual(['close', 'detach']);
    expect(getRemoteTab(db, tab.id)?.closedAt).toBe(1000);
    expect(events.at(-1)).toEqual({ type: 'remoteTab.closed', id: tab.id });
  });
  it('つないでいなければ、一時の link で closeUnattached を打つ', async () => {
    putRun(PEER);
    const tab = svc.open('s1')!;
    await svc.close(tab.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.calls).toEqual(['closeUnattached']);
  });
  it('知らないタブは null', () => {
    expect(svc.close('nope')).toBeNull();
  });
  it('detach した handle は close の相手から外れる', async () => {
    putRun(PEER);
    const tab = svc.open('s1')!;
    svc.connector(tab.id)!.open(io().io).detach();
    await svc.close(tab.id);
    expect(links.map((l) => l.calls)).toEqual([['detach'], ['closeUnattached']]);
  });
  it('開いて閉じても、同期の送り出し（changes）に行が増えない', async () => {
    putRun(PEER);
    const before = (db.prepare('select count(*) c from changes').get() as { c: number }).c;
    const tab = svc.open('s1')!;
    svc.setHost(PEER, 'h');
    await svc.close(tab.id);
    expect((db.prepare('select count(*) c from changes').get() as { c: number }).c).toBe(before);
  });
});

describe('setHost', () => {
  it('置いて remoteHost.changed を配る。null で外す', () => {
    svc.setHost(PEER, 'win-box');
    expect(getRemoteHost(db, PEER)).toBe('win-box');
    expect(svc.hosts()).toEqual({ [PEER]: 'win-box' });
    svc.setHost(PEER, null);
    expect(getRemoteHost(db, PEER)).toBeNull();
    expect(events).toEqual([{ type: 'remoteHost.changed', deviceId: PEER, host: 'win-box' }, { type: 'remoteHost.changed', deviceId: PEER, host: null }]);
  });
});

describe('validSshHost', () => {
  it.each(['win-box', 'user@host', 'host.example.com', '100.73.143.11', 'a'.repeat(253)])('通す: %s', (h) => { expect(validSshHost(h)).toBe(true); });
  it.each(['', '-oProxyCommand=x', 'a b', "a'b", 'a"b', 'a\nb', 'a\u0000b', 'a\tb', 'a'.repeat(254), 1, undefined, {}])('断る: %s', (h) => { expect(validSshHost(h)).toBe(false); });
});
