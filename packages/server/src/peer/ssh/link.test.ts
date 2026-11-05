import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SshTunnel, type SshChild, type SshConnectResult, type SshPeerNotice } from './connector.ts';
import { PeerSshConnectError, PeerSshLink, SSH_GIVE_UP_MS, SSH_RETRY_FIRST_MS, SSH_RETRY_MAX_MS } from './link.ts';

class FakeChild extends EventEmitter implements SshChild {
  pid = 1;
  stderr = new PassThrough();
  kill(): boolean { return true; }
}

function setup() {
  let t = 1_000;
  let port = 50_000;
  const script: ('ok' | 'unreachable' | 'mismatch')[] = [];
  const tunnels: SshTunnel[] = [];
  const notices: SshPeerNotice[] = [];
  const urls: string[] = [];
  let connects = 0;
  const link = new PeerSshLink({
    connector: {
      connect: async (id): Promise<SshConnectResult> => {
        connects++;
        const next = script.shift() ?? 'ok';
        if (next === 'unreachable') return { ok: false, reason: 'ssh-unreachable', detail: 'network' };
        if (next === 'mismatch') return { ok: false, reason: 'ssh-host-key-mismatch' };
        const tun = new SshTunnel(id, '10.0.0.2', port++, new FakeChild());
        tunnels.push(tun);
        return { ok: true, tunnel: tun };
      },
    },
    selfId: 'pc-a',
    tokens: () => null,
    nameOf: () => 'Mac',
    notify: (n) => { notices.push(n); },
    now: () => t,
    fetch: (async (url: string) => { urls.push(url); return new Response('{"now":1,"launches":[]}'); }) as unknown as typeof fetch,
  });
  return { link, script, tunnels, notices, urls, advance: (ms: number) => { t += ms; }, connects: () => connects };
}

describe('PeerSshLink', () => {
  it('張ったトンネルは使い回し、切れたら次の取得で張り直す。張り直すと入口が変わるので、呼ぶたびに引く', async () => {
    const s = setup();
    // tokens が無いので口は 401 の例外になるが、入口の URL は fetch の前に決まらないため、ensure で確かめる。
    const t1 = await s.link.ensure('dev');
    expect(await s.link.ensure('dev')).toBe(t1);
    expect(s.connects()).toBe(1);
    t1.exited('network');
    expect(s.link.connected('dev')).toBe(false);
    const t2 = await s.link.ensure('dev');
    expect(t2).not.toBe(t1);
    expect(t2.baseUrl).not.toBe(t1.baseUrl);
    expect(s.connects()).toBe(2);
  });

  it('同時に呼んでも張るのは 1 回', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.link.ensure('dev'), s.link.ensure('dev')]);
    expect(a).toBe(b);
    expect(s.connects()).toBe(1);
  });

  it('張れなければ間隔をあけ、間隔の途中は張らずに断る。間隔は 2 倍ずつで上限がある', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) s.script.push('unreachable');
    await expect(s.link.ensure('dev')).rejects.toMatchObject({ reason: 'ssh-unreachable' });
    expect(s.connects()).toBe(1);
    // 間隔の途中は、つなぎに行かない。
    await expect(s.link.ensure('dev')).rejects.toBeInstanceOf(PeerSshConnectError);
    expect(s.connects()).toBe(1);
    s.advance(SSH_RETRY_FIRST_MS);
    await expect(s.link.ensure('dev')).rejects.toBeInstanceOf(PeerSshConnectError);
    expect(s.connects()).toBe(2);
    // 次は 2 倍。
    s.advance(SSH_RETRY_FIRST_MS);
    await expect(s.link.ensure('dev')).rejects.toBeInstanceOf(PeerSshConnectError);
    expect(s.connects()).toBe(2);
    s.advance(SSH_RETRY_FIRST_MS);
    await expect(s.link.ensure('dev')).rejects.toBeInstanceOf(PeerSshConnectError);
    expect(s.connects()).toBe(3);
    // 上限を超えて空かない。
    for (let i = 0; i < 6; i++) { s.advance(SSH_RETRY_MAX_MS); await s.link.ensure('dev').catch(() => {}); }
    s.advance(SSH_RETRY_MAX_MS);
    const before = s.connects();
    await s.link.ensure('dev').catch(() => {});
    expect(s.connects()).toBe(before + 1);
  });

  it('つながらない状態が長く続けば、利用者に 1 度だけ知らせて止める。新しい頼み（force）だけが試す', async () => {
    const s = setup();
    for (let i = 0; i < 30; i++) s.script.push('unreachable');
    await s.link.ensure('dev').catch(() => {});
    for (let i = 0; i < 40 && !s.link.stopped('dev'); i++) {
      s.advance(SSH_RETRY_MAX_MS);
      await s.link.ensure('dev').catch(() => {});
    }
    expect(s.link.stopped('dev')).toBe(true);
    expect(s.notices).toEqual([{ kind: 'gave-up', deviceId: 'dev', name: 'Mac' }]);
    const n = s.connects();
    s.advance(SSH_GIVE_UP_MS);
    await expect(s.link.ensure('dev')).rejects.toBeInstanceOf(PeerSshConnectError);
    expect(s.connects()).toBe(n);
    // 新しい頼みは、止めていても張り直しを試す。つながれば再開する。
    s.script.length = 0;
    const t = await s.link.ensure('dev', true);
    expect(t.closed).toBe(false);
    expect(s.link.stopped('dev')).toBe(false);
    expect(s.notices).toHaveLength(1);
  });

  it('ホスト鍵の食い違いは、自動では張り直さない。断りの理由はそのまま渡る', async () => {
    const s = setup();
    s.script.push('mismatch');
    await expect(s.link.ensure('dev', true)).rejects.toMatchObject({ reason: 'ssh-host-key-mismatch' });
    expect(s.link.stopped('dev')).toBe(true);
    s.advance(SSH_RETRY_MAX_MS * 2);
    await expect(s.link.ensure('dev')).rejects.toMatchObject({ reason: 'ssh-host-key-mismatch' });
    expect(s.connects()).toBe(1);
  });

  it('口の put は新しい頼みなので force で張り、claim・answer・postResult は SSH の経路に無い', async () => {
    const s = setup();
    s.script.push('unreachable');
    await expect(s.link.api('dev').put({ id: 'x', to: 'dev', sealed: '1.x' })).rejects.toMatchObject({ reason: 'ssh-unreachable' });
    // 間隔の途中でも、新しい頼みは試す。
    await expect(s.link.api('dev').put({ id: 'y', to: 'dev', sealed: '1.x' })).rejects.toMatchObject({ name: 'PeerSshHttpError' });
    expect(s.connects()).toBe(2);
    await expect(s.link.api('dev').claim('x')).rejects.toMatchObject({ name: 'PeerSshUnsupportedError' });
  });
});
