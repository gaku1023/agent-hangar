import type { DeviceStatus, RemoteShellStatusMsg } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import type { PtyProcess } from '../pty/relay.ts';
import { createAddressBook } from './addresses.ts';
import type { HostKeyInput } from './hostKeys.ts';
import { RemoteShellLink, RETRY_DELAYS_MS, type LinkExec, type RemoteShellLinkOptions } from './link.ts';
import { getRemoteTab, insertRemoteTab, listPendingKills } from './store.ts';

type ExecCall = { file: string; args: string[] };
type ExecReply = { code: number; stdout?: string; stderr?: string };

/** 偽の pty。exit(code) で終わらせる。 */
class FakePty implements PtyProcess {
  pid = 1;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = false;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  constructor(readonly file: string, readonly args: string[]) {}
  onData(cb: (d: string) => void): void { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb; }
  write(d: string): void { this.written.push(d); }
  resize(c: number, r: number): void { this.sizes.push([c, r]); }
  kill(): void { this.killed = true; }
  emit(d: string): void { this.dataCb?.(d); }
  exit(code: number): void { this.exitCb?.({ exitCode: code }); }
}

/** 偽の時計。tick で一番早いものを 1 つ動かす。 */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    timers,
    now: () => now,
    set: (fn: () => void, ms: number): unknown => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clear: (h: unknown): void => { timers.delete(h as number); },
    tick(): number {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error('no timer');
      timers.delete(next[0]);
      const waited = next[1].at - now;
      now = next[1].at;
      next[1].fn();
      return waited;
    },
  };
}

const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  accounts: [], agents: [], lan_ips: ['192.168.3.40'], ssh_host_key: 'SHA256:x', hangar_version: '1',
  ssh: { user: 'u12', host_pubkey: 'AAAA', mux: { kind: 'tmux', path: '/opt/homebrew/bin/tmux' }, shell: 'posix' },
  ...over,
});

const PREP_CREATED_MATCH = 'hangar-prep created match\n';

type Harness = ReturnType<typeof harness>;
function harness(o: { status?: DeviceStatus | null; override?: string | null; probe?: Record<string, boolean>; replies?: (c: ExecCall) => ExecReply | undefined; hostKeys?: (i: HostKeyInput) => { ok: true; knownHosts: string; emptyKnownHosts: string } | { ok: false; reason: 'no-sshd' | 'host-key' }; hasClient?: boolean; db?: Db; tabId?: string } = {}) {
  const clock = fakeClock();
  const calls: ExecCall[] = [];
  const ptys: FakePty[] = [];
  const msgs: RemoteShellStatusMsg[] = [];
  const data: string[] = [];
  const hostKeyCalls: HostKeyInput[] = [];
  const probed: string[] = [];
  let ended = 0;
  const book = createAddressBook();
  const db = o.db ?? openDb(':memory:');
  const exec: LinkExec = async (file, args) => {
    const c = { file, args };
    calls.push(c);
    const r = o.replies?.(c);
    if (r) return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    const cmd = args[args.length - 1] ?? '';
    if (cmd.includes('hangar-prep')) return { code: 0, stdout: PREP_CREATED_MATCH, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const opts: RemoteShellLinkOptions = {
    tabId: o.tabId ?? 'tab1',
    deviceId: 'dev1',
    peerPlatform: 'darwin',
    status: o.status === undefined ? status() : o.status,
    override: o.override ?? null,
    cwd: '/Users/u/my repo',
    cols: 80,
    rows: 24,
    onStatus: (m) => msgs.push(m),
    onData: (d) => data.push(d),
    onEnded: () => { ended += 1; },
  };
  const link = new RemoteShellLink(opts, {
    db,
    exec,
    spawn: (file, args) => { const p = new FakePty(file, args); ptys.push(p); return p; },
    timers: { now: clock.now, set: clock.set, clear: clock.clear },
    probe: async (h) => { probed.push(h); return o.probe?.[h] ?? true; },
    hostKeys: async (i) => { hostKeyCalls.push(i); return o.hostKeys ? o.hostKeys(i) : { ok: true, knownHosts: '/k/known_hosts', emptyKnownHosts: '/k/known_hosts.empty' }; },
    hasClient: () => o.hasClient ?? true,
    addressBook: book,
    platform: 'darwin',
    sshDir: '/k',
    env: {},
  });
  return { link, clock, calls, ptys, msgs, data, hostKeyCalls, probed, book, db, ended: () => ended };
}

const prepCalls = (h: Harness) => h.calls.filter((c) => c.args[c.args.length - 1]?.includes('hangar-prep'));
const sendKeysCalls = (h: Harness) => h.calls.filter((c) => c.args[c.args.length - 1]?.includes('send-keys'));
const killCalls = (h: Harness) => h.calls.filter((c) => c.args[c.args.length - 1]?.includes('kill-session'));
const hostOf = (c: { args: string[] }) => c.args[c.args.length - 2];

describe('RemoteShellLink: つなぐ', () => {
  it('connecting から ready。準備の ssh は tty なし、本番は -tt で pty に起こす', async () => {
    const h = harness();
    await h.link.start();
    expect(h.msgs.map((m) => m.phase)).toEqual(['connecting', 'ready']);
    expect(h.msgs[1]).toMatchObject({ t: 'remote', phase: 'ready', address: '192.168.3.40' });
    expect(prepCalls(h)).toHaveLength(1);
    expect(prepCalls(h)[0]!.args[0]).toBe('-T');
    expect(h.ptys).toHaveLength(1);
    expect(h.ptys[0]!.args[0]).toBe('-tt');
    expect(h.ptys[0]!.args.join(' ')).toContain('new-session -A -s hangar-ssh-tab1');
    expect(h.ptys[0]!.args).toContain('u12');
    expect(hostOf(h.ptys[0]!)).toBe('192.168.3.40');
    expect(h.book.get('dev1')).toBe('192.168.3.40');
    expect(h.hostKeyCalls[0]).toMatchObject({ deviceId: 'dev1', address: '192.168.3.40', port: 22, override: null, sshHostKey: 'SHA256:x', hostPubkey: 'AAAA', dir: '/k', platform: 'darwin' });
  });

  it('出力を流し、write と resize を pty に渡す', async () => {
    const h = harness();
    await h.link.start();
    h.ptys[0]!.emit('hello');
    h.link.write('ls\r');
    h.link.resize(100, 30);
    expect(h.data).toEqual(['hello']);
    expect(h.ptys[0]!.written).toEqual(['ls\r']);
    expect(h.ptys[0]!.sizes).toEqual([[100, 30]]);
  });

  it('作ったばかりで場所が違えば cd を 1 回打つ', async () => {
    const h = harness({ replies: (c) => (c.args[c.args.length - 1]!.includes('hangar-prep') ? { code: 0, stdout: 'hangar-prep created mismatch\n' } : undefined) });
    await h.link.start();
    expect(sendKeysCalls(h)).toHaveLength(1);
    expect(h.msgs.at(-1)?.phase).toBe('ready');
  });

  it('前からあったセッションでは場所が違っても cd を打たない', async () => {
    const h = harness({ replies: (c) => (c.args[c.args.length - 1]!.includes('hangar-prep') ? { code: 0, stdout: 'hangar-prep existed mismatch\n' } : undefined) });
    await h.link.start();
    expect(sendKeysCalls(h)).toHaveLength(0);
  });

  it('上書きの Host はそれだけを使い、-l を付けず、住所の帳面にも書かない', async () => {
    const h = harness({ override: 'mywin' });
    await h.link.start();
    expect(h.probed).toEqual([]);
    expect(hostOf(h.ptys[0]!)).toBe('mywin');
    expect(h.ptys[0]!.args).not.toContain('-l');
    expect(h.hostKeyCalls[0]?.override).toBe('mywin');
    expect(h.book.get('dev1')).toBeUndefined();
  });

  it('前回の住所を先に試す', async () => {
    const h = harness({ status: status({ lan_ips: ['192.168.3.40'], tailnet_ips: ['100.1.1.1'] }) });
    h.book.set('dev1', '100.1.1.1');
    await h.link.start();
    expect(h.probed[0]).toBe('100.1.1.1');
  });

  it('相手の status が無ければ outdated、手元に ssh が無ければ no-client', async () => {
    const a = harness({ status: null });
    await a.link.start();
    expect(a.msgs.map((m) => [m.phase, m.reason])).toEqual([['connecting', undefined], ['failed', 'outdated']]);
    const b = harness({ hasClient: false });
    await b.link.start();
    expect(b.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'no-client' });
    expect(a.calls.length + b.calls.length + a.ptys.length + b.ptys.length).toBe(0);
  });

  it('ssh の欄が無い古めの相手は、platform からシェルを決め -l を付けずに試す', async () => {
    const h = harness({ status: status({ ssh: undefined }) });
    await h.link.start();
    expect(h.msgs.at(-1)?.phase).toBe('ready');
    expect(h.ptys[0]!.args).not.toContain('-l');
    expect(h.hostKeyCalls[0]?.hostPubkey).toBeNull();
  });

  it('どの住所も応えなければ unreachable', async () => {
    const h = harness({ probe: { '192.168.3.40': false } });
    await h.link.start();
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'unreachable' });
  });

  it('unreachable の住所は飛ばして次へ', async () => {
    const h = harness({
      status: status({ lan_ips: ['192.168.3.40'], tailnet_ips: ['100.1.1.1'] }),
      replies: (c) => (hostOf(c) === '192.168.3.40' ? { code: 255, stderr: 'ssh: connect to host 192.168.3.40 port 22: Operation timed out' } : undefined),
    });
    await h.link.start();
    expect(prepCalls(h).map(hostOf).sort()).toEqual(['100.1.1.1', '192.168.3.40']);
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'ready', address: '100.1.1.1' });
    expect(h.book.get('dev1')).toBe('100.1.1.1');
  });

  it('auth は次の住所を試さず即 failed', async () => {
    const h = harness({
      status: status({ lan_ips: ['192.168.3.40', '10.0.0.5'] }),
      replies: (c) => (c.args[c.args.length - 1]!.includes('hangar-prep') ? { code: 255, stderr: 'u12@1.2.3.4: Permission denied (publickey).' } : undefined),
    });
    await h.link.start();
    expect(prepCalls(h)).toHaveLength(1);
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'auth', detail: 'u12@1.2.3.4: Permission denied (publickey).' });
    expect(h.ptys).toHaveLength(0);
  });

  it('host-key は次の住所を試さず即 failed（ssh の拒みでも、鍵の照合でも）', async () => {
    const a = harness({
      status: status({ lan_ips: ['192.168.3.40', '10.0.0.5'] }),
      replies: (c) => (c.args[c.args.length - 1]!.includes('hangar-prep') ? { code: 255, stderr: 'Host key verification failed.' } : undefined),
    });
    await a.link.start();
    expect(prepCalls(a)).toHaveLength(1);
    expect(a.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'host-key' });
    const b = harness({ status: status({ lan_ips: ['192.168.3.40', '10.0.0.5'] }), hostKeys: () => ({ ok: false, reason: 'host-key' }) });
    await b.link.start();
    expect(b.hostKeyCalls).toHaveLength(1);
    expect(b.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'host-key' });
  });

  it('cwd が引けない字を含めば bad-cwd', async () => {
    const h = harness();
    (h.link as unknown as { opts: { cwd: string } }).opts.cwd = 'a\nb';
    await h.link.start();
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'bad-cwd' });
  });
});

describe('RemoteShellLink: つなぎ直し', () => {
  it('ready の後に切れたら 1,2,4,8,16 秒で 5 回やり直し、だめなら failed(dropped)', async () => {
    let down = false;
    const h = harness({ replies: (c) => (down && c.args[c.args.length - 1]!.includes('hangar-prep') ? { code: 255, stderr: 'ssh: connect to host 192.168.3.40 port 22: Operation timed out' } : undefined) });
    await h.link.start();
    down = true;
    h.ptys[0]!.emit('Connection to 192.168.3.40 closed by remote host.\r\n');
    h.ptys[0]!.exit(255);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const m = h.msgs.at(-1)!;
      expect(m).toMatchObject({ phase: 'retrying', attempt: i + 1 });
      expect(m.retryAt).toBe(h.clock.now() + RETRY_DELAYS_MS[i]!);
      waits.push(h.clock.tick());
      await h.link.whenIdle();
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'dropped' });
    expect(h.clock.timers.size).toBe(0);
  });

  it('やり直しで戻れば ready になり、回数は振り出しに戻る', async () => {
    const h = harness();
    await h.link.start();
    h.ptys[0]!.exit(255);
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'retrying', attempt: 1 });
    h.clock.tick();
    await h.link.whenIdle();
    expect(h.msgs.at(-1)?.phase).toBe('ready');
    expect(h.ptys).toHaveLength(2);
    h.ptys[1]!.exit(255);
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'retrying', attempt: 1 });
  });

  it('やり直しの途中で auth になれば、残りを待たず failed', async () => {
    let deny = false;
    const h = harness({ replies: (c) => (deny && c.args[c.args.length - 1]!.includes('hangar-prep') ? { code: 255, stderr: 'Permission denied (publickey).' } : undefined) });
    await h.link.start();
    deny = true;
    h.ptys[0]!.exit(255);
    h.clock.tick();
    await h.link.whenIdle();
    expect(h.msgs.at(-1)).toMatchObject({ phase: 'failed', reason: 'auth' });
    expect(h.clock.timers.size).toBe(0);
  });

  it('シェルが 0 で終わったら、やり直さず onEnded', async () => {
    const h = harness();
    await h.link.start();
    h.ptys[0]!.exit(0);
    expect(h.ended()).toBe(1);
    expect(h.clock.timers.size).toBe(0);
    expect(h.msgs.at(-1)?.phase).toBe('ready');
  });

  it('retry() で failed から最初からやり直す', async () => {
    let fail = true;
    const h = harness({ replies: (c) => (fail && c.args[c.args.length - 1]!.includes('hangar-prep') ? { code: 255, stderr: 'Permission denied (publickey).' } : undefined) });
    await h.link.start();
    expect(h.msgs.at(-1)?.phase).toBe('failed');
    fail = false;
    await h.link.retry();
    expect(h.msgs.slice(-2).map((m) => m.phase)).toEqual(['connecting', 'ready']);
    expect(h.ptys).toHaveLength(1);
  });
});

describe('RemoteShellLink: 閉じる', () => {
  const withTab = (id: string, deviceId = 'dev1') => {
    const db = openDb(':memory:');
    insertRemoteTab(db, { id, sessionId: 's1', deviceId, remoteName: `hangar-ssh-${id}`, title: 'shell', createdAt: 1 });
    return db;
  };

  it('ssh の子を止め、別の ssh で kill-session を 1 回打つ。kill-server は打たない', async () => {
    const db = withTab('tab1');
    const h = harness({ db });
    await h.link.start();
    await h.link.close();
    expect(h.ptys[0]!.killed).toBe(true);
    expect(killCalls(h)).toHaveLength(1);
    expect(killCalls(h)[0]!.args.join(' ')).toContain("'=hangar-ssh-tab1'");
    expect(h.calls.some((c) => c.args.join(' ').includes('kill-server'))).toBe(false);
    expect(getRemoteTab(db, 'tab1')?.killPending).toBe(false);
  });

  it('閉じた後は出力も切れも拾わず、やり直さない', async () => {
    const h = harness({ db: withTab('tab1') });
    await h.link.start();
    const n = h.msgs.length;
    await h.link.close();
    h.ptys[0]!.emit('late');
    h.ptys[0]!.exit(255);
    expect(h.data).toEqual([]);
    expect(h.msgs.length).toBe(n);
    expect(h.clock.timers.size).toBe(0);
  });

  it('届かなければ kill_pending を立て、次にその PC につながったとき消して下ろす', async () => {
    const db = withTab('tab1');
    insertRemoteTab(db, { id: 'tab2', sessionId: 's1', deviceId: 'dev1', remoteName: 'hangar-ssh-tab2', title: 'shell', createdAt: 2 });
    let down = false;
    const a = harness({ db, replies: (c) => (down ? { code: 255, stderr: 'ssh: connect to host 192.168.3.40 port 22: Operation timed out' } : undefined) });
    await a.link.start();
    down = true;
    await a.link.close();
    expect(getRemoteTab(db, 'tab1')?.killPending).toBe(true);

    const b = harness({ db, tabId: 'tab2' });
    await b.link.start();
    await b.link.whenIdle();
    expect(killCalls(b).map((c) => c.args.join(' ')).some((s) => s.includes('hangar-ssh-tab1'))).toBe(true);
    expect(listPendingKills(db, 'dev1')).toEqual([]);
  });

  it('つながる前に閉じたら、宛先が無いので kill_pending を立てる', async () => {
    const db = withTab('tab1');
    const h = harness({ db, status: null });
    await h.link.start();
    await h.link.close();
    expect(getRemoteTab(db, 'tab1')?.killPending).toBe(true);
  });

  it('相手で消すセッションがもう無い（ssh 自体は届いた）なら、kill_pending は立てない', async () => {
    const db = withTab('tab1');
    const h = harness({ db, replies: (c) => (c.args[c.args.length - 1]!.includes('kill-session') ? { code: 1, stderr: "can't find session: =hangar-ssh-tab1" } : undefined) });
    await h.link.start();
    await h.link.close();
    expect(getRemoteTab(db, 'tab1')?.killPending).toBe(false);
  });
});

describe('RemoteShellLink: 外す（WS が閉じた）と、つながずに閉じる', () => {
  const withTab = (id: string) => {
    const db = openDb(':memory:');
    insertRemoteTab(db, { id, sessionId: 's1', deviceId: 'dev1', remoteName: `hangar-ssh-${id}`, title: 'shell', createdAt: 1 });
    return db;
  };

  it('detach は ssh の子だけを止め、kill-session を打たず、kill_pending も立てない。後の出力と切れも拾わない', async () => {
    const db = withTab('tab1');
    const h = harness({ db });
    await h.link.start();
    const n = h.msgs.length;
    h.link.detach();
    h.ptys[0]!.emit('late');
    h.ptys[0]!.exit(255);
    expect(h.ptys[0]!.killed).toBe(true);
    expect(killCalls(h)).toHaveLength(0);
    expect(getRemoteTab(db, 'tab1')?.killPending).toBe(false);
    expect(h.data).toEqual([]);
    expect(h.msgs.length).toBe(n);
    expect(h.clock.timers.size).toBe(0);
  });

  it('closeUnattached は本番の ssh を起こさず、住所と鍵だけ用意して kill-session を 1 回打つ', async () => {
    const db = withTab('tab1');
    const h = harness({ db });
    await h.link.closeUnattached();
    expect(h.ptys).toHaveLength(0);
    expect(prepCalls(h)).toHaveLength(0);
    expect(killCalls(h)).toHaveLength(1);
    expect(hostOf(killCalls(h)[0]!)).toBe('192.168.3.40');
    expect(getRemoteTab(db, 'tab1')?.killPending).toBe(false);
    expect(h.msgs).toEqual([]);
  });

  it('closeUnattached で住所が引けなければ kill_pending を立てる', async () => {
    const db = withTab('tab1');
    const h = harness({ db, probe: { '192.168.3.40': false } });
    await h.link.closeUnattached();
    expect(killCalls(h)).toHaveLength(0);
    expect(getRemoteTab(db, 'tab1')?.killPending).toBe(true);
  });
});

